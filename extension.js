import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GnomeSettings} from './lib/gnomeSettings.js';
import {HibernateService} from './lib/hibernateService.js';
import {Indicator} from './lib/indicator.js';
import {KeepAwake} from './lib/keepAwake.js';
import {LidService} from './lib/lidService.js';
import {hibernatePresets} from './lib/model.js';
import {SleepService} from './lib/sleepService.js';

const HIBERNATE_UNAVAILABLE = 'Suspend then hibernate is not available on this computer. ';
const HIBERNATE_AUTH_NOTE = 'Changing this delay requires administrator authorization.';

export default class SandmanExtension extends Extension {
    enable() {
        this._handlers = [];
        this._syncingSwitch = false;
        this._settings = this.getSettings();
        this._gnome = new GnomeSettings();
        this._sleep = new SleepService({settings: this._settings, gnome: this._gnome});
        this._sleep.enable();
        this._hibernate = new HibernateService(this._settings);
        this._keepAwake = new KeepAwake(this._settings);
        this._lid = new LidService({
            settings: this._settings,
            keepAwake: this._keepAwake,
            hibernate: this._hibernate,
        });

        this._indicator = new Indicator({path: this.path});
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._bindTimer(this._indicator.screenOffSection,
            () => this._gnome.getScreenOff(),
            seconds => this._gnome.setScreenOff(seconds));
        this._bindTimer(this._indicator.lockSection,
            () => this._gnome.getLock(),
            value => this._gnome.setLock(value));
        this._connect(this._gnome, 'changed', () => this._syncGnome());
        this._bindTimer(this._indicator.sleepBatterySection,
            () => this._sleep.getTimeout('battery'),
            seconds => this._sleep.setTimeout('battery', seconds));
        this._bindTimer(this._indicator.sleepAcSection,
            () => this._sleep.getTimeout('ac'),
            seconds => this._sleep.setTimeout('ac', seconds));
        this._connect(this._sleep, 'changed', () => this._syncSleep());
        this._connect(this._sleep, 'error', (_sleep, message) =>
            this._indicator.setError(message));
        this._bindHibernate();
        this._refreshWarnings();

        this._bindKeepAwake();
        this._keepAwake.restore();

        this._bindLid();

        this._updateVisibility();
        this._connect(Main.sessionMode, 'updated', () => this._updateVisibility());
    }

    disable() {
        for (const [emitter, id] of this._handlers ?? [])
            emitter.disconnect(id);
        this._handlers = [];
        this._syncingSwitch = false;

        this._indicator?.destroy();
        this._indicator = null;
        this._lid?.disable();
        this._lid = null;
        this._hibernate?.disable();
        this._hibernate = null;
        this._keepAwake?.destroy();
        this._keepAwake = null;
        this._sleep?.disable();
        this._sleep = null;
        this._gnome?.destroy();
        this._gnome = null;
        this._settings = null;
    }

    _connect(emitter, signal, callback) {
        this._handlers.push([emitter, emitter.connect(signal, callback)]);
    }

    // Shows the current value, applies picks through the setter and reports
    // the outcome in the error row.
    _bindTimer(section, getter, setter) {
        section.setValue(getter());
        this._connect(section, 'value-selected', (_section, {value}) => {
            try {
                setter(value);
                this._indicator.setError(null);
            } catch (e) {
                this._indicator.setError(e.message);
            }
            section.setValue(getter());
            this._refreshWarnings();
        });
    }

    // setDelay runs the pkexec helper, so picks resolve asynchronously. The
    // service queues them; each outcome re-renders from the stored key, which
    // only changes when the helper succeeded.
    _bindHibernate() {
        const hibernate = this._hibernate;
        this._syncHibernate();
        this._connect(this._indicator.hibernateSection, 'value-selected', (_section, {value}) => {
            hibernate.setDelay(value)
                .then(() => {
                    if (this._hibernate !== hibernate)
                        return;
                    this._indicator.setError(null);
                    this._syncHibernate();
                })
                .catch(e => {
                    if (this._hibernate !== hibernate)
                        return;
                    this._indicator.setError(e.message);
                    this._syncHibernate();
                });
        });
        this._connect(this._hibernate, 'changed', () => this._syncHibernate());
        this._connect(this._hibernate, 'error', (_hibernate, message) =>
            this._indicator.setError(message));
        this._hibernate.enable().catch(e =>
            console.warn(`Sandman: could not check hibernation support: ${e.message}`));
    }

    _syncHibernate() {
        if (!this._indicator)
            return;
        const {ready, available, diagnosis} = this._hibernate;
        const delay = this._hibernate.getDelay();
        const section = this._indicator.hibernateSection;
        // Custom first: setValue opens the custom row only while enabled.
        section.setCustomEnabled(available);
        // Until logind has answered, availability is unknown: presets keep
        // their sensitivity and no note is shown.
        if (ready) {
            for (const v of hibernatePresets)
                section.setItemSensitive(v, available || v === 0);
        }
        section.setValue(delay);
        if (!ready)
            section.setNote(null);
        else if (!available)
            section.setNote(HIBERNATE_UNAVAILABLE + diagnosis);
        else
            section.setNote(delay > 0 ? HIBERNATE_AUTH_NOTE : null);
        this._refreshWarnings();
    }

    // The section stays hidden until the service finds a lid. Hibernate is
    // pickable only when logind can hibernate.
    _bindLid() {
        const lid = this._lid;
        this._syncLid();
        this._connect(this._indicator.lidSection, 'value-selected', (_section, {value}) => {
            lid.setAction(value)
                .then(() => {
                    if (this._lid !== lid)
                        return;
                    this._indicator.setError(null);
                    this._syncLid();
                })
                .catch(e => {
                    if (this._lid !== lid)
                        return;
                    this._indicator.setError(e.message);
                    this._syncLid();
                });
        });
        this._connect(this._lid, 'changed', () => this._syncLid());
        this._connect(this._hibernate, 'changed', () => this._syncLid());
        this._connect(this._lid, 'error', (_lid, message) =>
            this._indicator.setError(message));
        this._lid.enable().catch(e =>
            console.warn(`Sandman: could not watch the lid: ${e.message}`));
    }

    _syncLid() {
        if (!this._indicator)
            return;
        const section = this._indicator.lidSection;
        section.visible = this._lid.lidPresent;
        section.setValue(this._lid.getAction());
        section.setItemSensitive('hibernate', this._hibernate.canHibernate);
    }

    _bindKeepAwake() {
        this._setSwitch(this._keepAwake.active);
        this._indicator.setKeepAwakeBadge(this._keepAwake.active);

        const keepAwake = this._keepAwake;
        this._connect(this._indicator.keepAwakeSwitch, 'toggled', (_item, state) => {
            if (this._syncingSwitch)
                return;
            keepAwake.setActive(state)
                .then(() => {
                    if (this._keepAwake === keepAwake)
                        this._indicator.setError(null);
                })
                .catch(e => {
                    if (this._keepAwake !== keepAwake)
                        return;
                    this._indicator.setError(e.message);
                    this._setSwitch(keepAwake.active);
                });
        });
        this._connect(this._keepAwake, 'changed', () => {
            this._setSwitch(this._keepAwake.active);
            this._indicator.setKeepAwakeBadge(this._keepAwake.active);
        });
    }

    // setToggleState emits "toggled"; the guard keeps programmatic updates
    // from re-entering the toggled handler as if the user had clicked.
    _setSwitch(state) {
        if (!this._indicator)
            return;
        this._syncingSwitch = true;
        try {
            this._indicator.keepAwakeSwitch.setToggleState(state);
        } finally {
            this._syncingSwitch = false;
        }
    }

    _syncGnome() {
        this._indicator.screenOffSection.setValue(this._gnome.getScreenOff());
        this._indicator.lockSection.setValue(this._gnome.getLock());
        this._refreshWarnings();
    }

    _syncSleep() {
        this._indicator.sleepBatterySection.setValue(this._sleep.getTimeout('battery'));
        this._indicator.sleepAcSection.setValue(this._sleep.getTimeout('ac'));
        this._refreshWarnings();
    }

    _warningState() {
        return {
            screenOff: this._gnome.getScreenOff(),
            lock: this._gnome.getLock(),
            sleepBattery: this._settings.get_int('sleep-battery-timeout'),
            sleepAc: this._settings.get_int('sleep-ac-timeout'),
            hibernate: this._settings.get_int('hibernate-delay'),
        };
    }

    _refreshWarnings() {
        this._indicator.refreshWarnings(this._warningState());
    }

    _updateVisibility() {
        if (this._indicator)
            this._indicator.visible = !Main.sessionMode.isLocked;
    }
}
