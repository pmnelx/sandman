import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GnomeSettings} from './lib/gnomeSettings.js';
import {Indicator} from './lib/indicator.js';
import {KeepAwake} from './lib/keepAwake.js';
import {SleepService} from './lib/sleepService.js';

export default class SandmanExtension extends Extension {
    enable() {
        this._handlers = [];
        this._settings = this.getSettings();
        this._gnome = new GnomeSettings();
        this._sleep = new SleepService({settings: this._settings, gnome: this._gnome});
        this._sleep.enable();
        this._keepAwake = new KeepAwake(this._settings);

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
        this._refreshWarnings();

        this._bindKeepAwake();
        this._keepAwake.restore();

        this._updateVisibility();
        this._connect(Main.sessionMode, 'updated', () => this._updateVisibility());
    }

    disable() {
        for (const [emitter, id] of this._handlers ?? [])
            emitter.disconnect(id);
        this._handlers = [];

        this._indicator?.destroy();
        this._indicator = null;
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

    _bindKeepAwake() {
        this._setSwitch(this._keepAwake.active);
        this._indicator.setKeepAwakeBadge(this._keepAwake.active);

        this._connect(this._indicator.keepAwakeSwitch, 'toggled', (_item, state) => {
            if (this._syncingSwitch)
                return;
            this._keepAwake.setActive(state)
                .then(() => this._indicator?.setError(null))
                .catch(e => {
                    this._indicator?.setError(e.message);
                    this._setSwitch(this._keepAwake?.active ?? false);
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
