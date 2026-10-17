import Gio from 'gi://Gio';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {
    adoptedSleepTimeout,
    normalizedSeconds,
    pickSleepTimeout,
    requestedSeconds,
    sleepMethod,
} from './model.js';
import {hasRemovableGpu, isInhibited, powerAction, sessionIsActive} from './power.js';

const SOURCES = ['battery', 'ac'];
const INHIBIT_FLAGS = 12; // suspend (4) + idle (8)

const SLEEP_ERROR = 'Sleep was blocked by the system or an application';
const HIBERNATE_ERROR = 'Suspend then hibernate was blocked or unavailable';

const SESSION_NAME = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';

const timeoutKey = source => `sleep-${source}-timeout`;
const savedTypeKey = source => `saved-sleep-${source}-type`;
const savedTimeoutKey = source => `saved-sleep-${source}-timeout`;
const restoredTypeKey = source => `restored-sleep-${source}-type`;
const restoredTimeoutKey = source => `restored-sleep-${source}-timeout`;
const gnomeTypeKey = source => `sleep-inactive-${source}-type`;

function checkSource(source) {
    if (!SOURCES.includes(source))
        throw new Error(`Unknown power source: ${source}`);
}

// Owns automatic sleep: takes the GNOME sleep types over (set to "nothing"),
// keeps a core idle watch for the current power source's timeout and calls
// logind when it fires. Emits "changed" when a Sandman sleep key changes and
// "error" with a message when sleep could not start.
export class SleepService extends EventEmitter {
    constructor({settings, gnome}) {
        super();
        this._settings = settings;
        this._gnome = gnome;
        this._handlers = [];
        this._enabled = false;
        this._watchId = 0;
        this._armedMs = 0;
        this._onBattery = undefined;
        this._upower = null;
        this._cancellable = null;
        this._inhibitorSub = 0;
        this._sleeping = false;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        const settings = this._settings;
        if (!settings.get_boolean('adopted')) {
            for (const source of SOURCES) {
                const {type, timeout} = this._gnome.getSleep(source);
                settings.set_int(timeoutKey(source), adoptedSleepTimeout(type, timeout));
            }
            settings.set_boolean('adopted', true);
        }
        for (const source of SOURCES)
            this._adoptChangedWhileDisabled(source);
        for (const source of SOURCES)
            this._takeOver(source);

        this._connect(this._gnome, 'changed', (_gnome, key) => this._onGnomeChanged(key));
        for (const key of ['sleep-battery-timeout', 'sleep-ac-timeout', 'hibernate-delay']) {
            this._connect(settings, `changed::${key}`, () => {
                this._arm();
                this.emit('changed');
            });
        }
        this._watchPowerSource();
        this._arm();
        // Adoption wrote the sleep keys before the handlers above existed.
        this.emit('changed');
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        this._disarm();
        this._unsubscribeInhibitors();
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const [emitter, id] of this._handlers)
            emitter.disconnect(id);
        this._handlers = [];
        this._upower = null;
        this._onBattery = undefined;

        for (const source of SOURCES) {
            const saved = this._settings.get_string(savedTypeKey(source));
            if (!saved)
                continue;
            try {
                this._gnome.setSleepType(source, saved);
                // Remember what was left in GNOME, so a later enable can tell
                // whether the user changed it while Sandman was off.
                const {type, timeout} = this._gnome.getSleep(source);
                this._settings.set_int(savedTimeoutKey(source),
                    normalizedSeconds(timeout, 0, true));
                this._settings.set_string(restoredTypeKey(source), type);
                this._settings.set_int(restoredTimeoutKey(source), timeout);
                // Restored, so a later enable saves the user's current type
                // instead of keeping this one.
                this._settings.set_string(savedTypeKey(source), '');
            } catch (e) {
                console.warn(`Sandman: could not restore the ${source} sleep type: ${e.message}`);
            }
        }
    }

    setTimeout(source, seconds) {
        checkSource(source);
        const value = requestedSeconds(seconds);
        if (value === -1)
            throw new Error('Ignored an invalid timeout');
        // The changed:: handler re-arms and emits "changed".
        this._settings.set_int(timeoutKey(source), value);
    }

    getTimeout(source) {
        checkSource(source);
        return normalizedSeconds(this._settings.get_int(timeoutKey(source)), 0, true);
    }

    _connect(emitter, signal, callback) {
        this._handlers.push([emitter, emitter.connect(signal, callback)]);
    }

    // Adopts an Automatic Suspend the user set while Sandman was disabled. An
    // unchanged restored pair means the user did not touch it.
    _adoptChangedWhileDisabled(source) {
        const settings = this._settings;
        const {type, timeout} = this._gnome.getSleep(source);
        const restoredType = settings.get_string(restoredTypeKey(source));
        const unchanged = restoredType !== '' && restoredType === type &&
            settings.get_int(restoredTimeoutKey(source)) === timeout;
        if (!unchanged && type === 'suspend')
            settings.set_int(timeoutKey(source), adoptedSleepTimeout(type, timeout));
        settings.set_string(restoredTypeKey(source), '');
        settings.set_int(restoredTimeoutKey(source), 0);
    }

    // Remembers the GNOME sleep type for disable() and switches GNOME's own
    // idle suspend off. A type that is already "nothing" keeps the saved value,
    // so a re-enable never overwrites a real saved type with "nothing".
    _takeOver(source) {
        const {type} = this._gnome.getSleep(source);
        if (type !== 'nothing')
            this._settings.set_string(savedTypeKey(source), type);
        this._gnome.setSleepType(source, 'nothing');
    }

    // Something outside Sandman turned GNOME's idle suspend back on: adopt its
    // timeout and take the type over again.
    _onGnomeChanged(key) {
        const source = SOURCES.find(s => gnomeTypeKey(s) === key);
        if (!source)
            return;
        try {
            const {type, timeout} = this._gnome.getSleep(source);
            if (type === 'nothing')
                return;
            this._settings.set_int(timeoutKey(source), adoptedSleepTimeout(type, timeout));
            this._takeOver(source);
        } catch (e) {
            console.warn(`Sandman: could not adopt the ${source} sleep setting: ${e.message}`);
        }
    }

    _watchPowerSource() {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            UPOWER_NAME, UPOWER_PATH, UPOWER_NAME, cancellable,
            (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Sandman: could not watch the power source: ${e.message}`);
                    return;
                }
                if (cancellable.is_cancelled() || !this._enabled)
                    return;
                this._upower = proxy;
                this._connect(proxy, 'g-properties-changed', () => this._syncPowerSource());
                this._syncPowerSource();
            });
    }

    _syncPowerSource() {
        const value = this._upower?.get_cached_property('OnBattery');
        const onBattery = value ? value.unpack() : undefined;
        if (onBattery === this._onBattery)
            return;
        this._onBattery = onBattery;
        this._arm();
    }

    _monitor() {
        return global.backend.get_core_idle_monitor();
    }

    // The idle watch is persistent: after it fires, Mutter fires it again once
    // the user has been active and then idle for the timeout. Re-adding it
    // while the session is already idle past the timeout would fire it at
    // once, so an unchanged timeout keeps the existing watch. That makes the
    // "re-arm" after a fired watch a no-op and the next idle period start
    // after the next user activity (for example after resume).
    _arm() {
        if (!this._enabled)
            return;
        const seconds = pickSleepTimeout(this._onBattery,
            this.getTimeout('battery'), this.getTimeout('ac'));
        const ms = seconds * 1000;
        if (this._watchId && ms === this._armedMs)
            return;
        this._disarm();
        if (ms === 0)
            return;
        this._armedMs = ms;
        this._watchId = this._monitor().add_idle_watch(ms, () => this._onIdle());
    }

    _disarm() {
        if (this._watchId)
            this._monitor().remove_watch(this._watchId);
        this._watchId = 0;
        this._armedMs = 0;
    }

    _onIdle() {
        this._handleIdle().catch(e => this._reportFailure(e));
    }

    async _handleIdle() {
        if (this._sleeping || this._inhibitorSub)
            return;
        if (!await sessionIsActive())
            return;
        if (!this._enabled)
            return;
        if (await isInhibited(INHIBIT_FLAGS)) {
            if (this._enabled)
                this._waitForInhibitors();
            return;
        }
        if (this._enabled)
            await this._sleepNow();
    }

    _waitForInhibitors() {
        if (this._inhibitorSub)
            return;
        this._inhibitorSub = Gio.DBus.session.signal_subscribe(SESSION_NAME,
            SESSION_NAME, 'InhibitorRemoved', SESSION_PATH, null,
            Gio.DBusSignalFlags.NONE,
            () => this._checkInhibitors().catch(e => this._reportFailure(e)));
    }

    async _checkInhibitors() {
        if (await isInhibited(INHIBIT_FLAGS))
            return;
        if (!this._enabled || !this._inhibitorSub)
            return;
        this._unsubscribeInhibitors();
        // Another user's session may have become active while we waited.
        if (!await sessionIsActive())
            return;
        if (!this._enabled)
            return;
        // Below the timeout the user was active meanwhile, and the persistent
        // watch fires again on its own.
        if (this._armedMs > 0 && this._monitor().get_idletime() >= this._armedMs)
            await this._sleepNow();
    }

    _unsubscribeInhibitors() {
        if (this._inhibitorSub)
            Gio.DBus.session.signal_unsubscribe(this._inhibitorSub);
        this._inhibitorSub = 0;
    }

    async _sleepNow() {
        if (this._sleeping)
            return;
        this._sleeping = true;
        const delay = normalizedSeconds(this._settings.get_int('hibernate-delay'), 0, true);
        const method = sleepMethod(delay, hasRemovableGpu());
        try {
            await powerAction(method);
        } catch (e) {
            console.warn(`Sandman: ${method} failed: ${e.message}`);
            if (this._enabled)
                this.emit('error', method === 'SuspendThenHibernate' ? HIBERNATE_ERROR : SLEEP_ERROR);
        } finally {
            this._sleeping = false;
        }
    }

    _reportFailure(e) {
        console.warn(`Sandman: automatic sleep check failed: ${e.message}`);
        if (this._enabled)
            this.emit('error', SLEEP_ERROR);
    }
}
