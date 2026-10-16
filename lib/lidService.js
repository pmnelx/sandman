import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {normalizedLidAction, sleepMethod} from './model.js';
import {call, hasRemovableGpu, inhibitLidSwitch, powerAction} from './power.js';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';

const LOGIN_NAME = 'org.freedesktop.login1';
const LOGIN_PATH = '/org/freedesktop/login1';
const LOGIN_MANAGER = 'org.freedesktop.login1.Manager';

const DISPLAY_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

const POWER_SAVE_ON = 0;
const POWER_SAVE_OFF = 3;

const DEBOUNCE_MS = 25;
const INHIBIT_REASON = 'Handle the configured lid-close action';

const INVALID_ERROR = 'Ignored an invalid lid action';
const MONITOR_ERROR = 'Could not monitor laptop lid events';
const HIBERNATE_ERROR = 'Hibernate is not available on this computer';
const SLEEP_ERROR = 'Sleep was blocked by the system or an application';
const SUSPEND_HIBERNATE_ERROR = 'Suspend then hibernate was blocked or unavailable';

function newProxy(busType, name, path, iface, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(busType, Gio.DBusProxyFlags.NONE, null,
            name, path, iface, cancellable, (_source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Lid-close actions, ported from upstream LidService.qml. A managed action
// (anything but "system") holds a logind handle-lid-switch block inhibitor
// so logind leaves the lid to Sandman, which then watches logind's LidClosed
// and acts on close. The first observed state is recorded, not acted on.
// Emits "changed" when lidPresent or the action changes and "error" with a
// message when an action fails.
export class LidService extends EventEmitter {
    constructor({settings, keepAwake, hibernate}) {
        super();
        this._settings = settings;
        this._keepAwake = keepAwake;
        this._hibernate = hibernate;
        this._handlers = [];
        this._enabled = false;
        this._cancellable = null;
        this._login = null;
        this._display = null;
        this._debounceId = 0;
        this._stateKnown = false;
        this._closed = false;
        this._displayOff = false;
        this._inhibitor = null;
        this._inhibiting = false;
        this._powerPending = false;
        this._action = null;
        this.lidPresent = false;
    }

    async enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const current = () => this._enabled && !cancellable.is_cancelled();

        this._action = this.getAction();
        this._connect(this._settings, 'changed::lid-action', () => this._onActionChanged());

        // A missing UPower or property reads as "no lid".
        let upower = null;
        try {
            upower = await newProxy(Gio.BusType.SYSTEM, UPOWER_NAME, UPOWER_PATH,
                UPOWER_NAME, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Sandman: could not read the lid presence: ${e.message}`);
        }
        if (!current())
            return;
        this.lidPresent = upower?.get_cached_property('LidIsPresent')?.unpack() === true;
        this.emit('changed');
        if (!this.lidPresent)
            return;

        newProxy(Gio.BusType.SESSION, DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME, cancellable)
            .then(proxy => {
                if (current())
                    this._display = proxy;
            })
            .catch(e => {
                if (!isCancelled(e))
                    console.warn(`Sandman: could not reach Mutter display config: ${e.message}`);
            });

        let login;
        try {
            login = await newProxy(Gio.BusType.SYSTEM, LOGIN_NAME, LOGIN_PATH,
                LOGIN_MANAGER, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Sandman: could not watch the lid: ${e.message}`);
            if (current())
                this.emit('error', MONITOR_ERROR);
            return;
        }
        if (!current())
            return;
        this._login = login;
        this._connect(login, 'g-properties-changed', (_proxy, changed) => {
            if (changed.lookup_value('LidClosed', null))
                this._scheduleState();
        });
        const closed = login.get_cached_property('LidClosed');
        if (closed)
            this._applyState(closed.unpack());
        this._syncInhibitor();
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = 0;
        for (const [emitter, id] of this._handlers)
            emitter.disconnect(id);
        this._handlers = [];
        this._releaseInhibitor();
        if (this._displayOff) {
            this._displayOff = false;
            this._setPowerSave(POWER_SAVE_ON);
        }
        this._login = null;
        this._display = null;
    }

    getAction() {
        return normalizedLidAction(this._settings.get_string('lid-action'));
    }

    async setAction(action) {
        const value = normalizedLidAction(action);
        if (value !== action)
            throw new Error(INVALID_ERROR);
        // The changed:: handler re-applies the action and emits "changed".
        this._settings.set_string('lid-action', value);
    }

    _connect(emitter, signal, callback) {
        this._handlers.push([emitter, emitter.connect(signal, callback)]);
    }

    // Upstream debounced LidClosed by 25 ms; a restart keeps only the last
    // value of a quick bounce.
    _scheduleState() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            const value = this._login?.get_cached_property('LidClosed');
            if (value)
                this._applyState(value.unpack());
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyState(closed) {
        if (!this._stateKnown) {
            this._closed = closed;
            this._stateKnown = true;
            return;
        }
        if (closed === this._closed)
            return;
        this._closed = closed;
        if (closed)
            this._handleClosed();
        else if (this._displayOff)
            this._displayOn();
    }

    // Rewriting the same value must not re-run the action (a second suspend
    // while closed), so only a real change counts.
    _onActionChanged() {
        const action = this.getAction();
        if (action === this._action)
            return;
        this._action = action;
        if (this._displayOff && action !== 'display')
            this._displayOn();
        this._syncInhibitor();
        if (this._stateKnown && this._closed)
            this._handleClosed();
        this.emit('changed');
    }

    _handleClosed() {
        switch (this.getAction()) {
        case 'display':
            this._displayOffOnClose();
            break;
        case 'sleep':
            this._sleep();
            break;
        case 'hibernate':
            this._hibernateNow();
            break;
        }
    }

    // With an external monitor gsd-power holds its own lid inhibitor and
    // Mutter turns the built-in panel off itself. Without one Mutter keeps
    // the sole panel on, so Sandman sets power save. Not yet checked with
    // the lid physically closed: if Mutter blanks the sole panel anyway,
    // this write is redundant but harmless.
    _displayOffOnClose() {
        if (this._displayOff)
            return;
        // Only a known "no external monitor" blanks the panel: a missing or
        // failed DisplayConfig proxy must not turn docked screens off.
        if (this._display?.get_cached_property('HasExternalMonitor')?.unpack() !== false)
            return;
        this._displayOff = true;
        this._setPowerSave(POWER_SAVE_OFF);
    }

    _displayOn() {
        this._displayOff = false;
        this._setPowerSave(POWER_SAVE_ON);
    }

    _setPowerSave(mode) {
        call(Gio.DBus.session, DISPLAY_NAME, DISPLAY_PATH, PROPERTIES, 'Set',
            new GLib.Variant('(ssv)', [DISPLAY_NAME, 'PowerSaveMode', new GLib.Variant('i', mode)]),
            null)
            .catch(e => console.warn(`Sandman: could not set display power save ${mode}: ${e.message}`));
    }

    _sleep() {
        if (this._keepAwake.active)
            return;
        const method = sleepMethod(this._hibernate.getDelay(), hasRemovableGpu());
        this._runPower(method,
            method === 'SuspendThenHibernate' ? SUSPEND_HIBERNATE_ERROR : SLEEP_ERROR);
    }

    _hibernateNow() {
        if (this._keepAwake.active)
            return;
        if (!this._hibernate.canHibernate) {
            this.emit('error', HIBERNATE_ERROR);
            return;
        }
        this._runPower('Hibernate', HIBERNATE_ERROR);
    }

    _runPower(method, message) {
        if (this._powerPending)
            return;
        this._powerPending = true;
        powerAction(method)
            .catch(e => {
                console.warn(`Sandman: lid ${method} failed: ${e.message}`);
                if (this._enabled)
                    this.emit('error', message);
            })
            .finally(() => {
                this._powerPending = false;
            });
    }

    // Holds the inhibitor iff the action is managed, a lid exists and the
    // logind proxy watches LidClosed, so logind is never blocked while
    // Sandman cannot see the lid. An inhibitor that arrives after the wish
    // changed (or after disable) is released at once.
    _syncInhibitor() {
        const wanted = this._enabled && this._login !== null && this.lidPresent &&
            this.getAction() !== 'system';
        if (!wanted) {
            this._releaseInhibitor();
            return;
        }
        if (this._inhibitor || this._inhibiting)
            return;
        this._inhibiting = true;
        inhibitLidSwitch(INHIBIT_REASON)
            .then(handle => {
                this._inhibiting = false;
                this._inhibitor = handle;
                this._syncInhibitor();
            })
            .catch(e => {
                this._inhibiting = false;
                console.warn(`Sandman: lid switch inhibit failed: ${e.message}`);
                if (this._enabled)
                    this.emit('error', MONITOR_ERROR);
            });
    }

    _releaseInhibitor() {
        const inhibitor = this._inhibitor;
        this._inhibitor = null;
        try {
            inhibitor?.close();
        } catch (e) {
            console.warn(`Sandman: could not release the lid switch inhibitor: ${e.message}`);
        }
    }
}
