import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    HIBERNATE_WARNING,
    LOCK_WARNING,
    SLEEP_AC_WARNING,
    SLEEP_BATTERY_WARNING,
    customSeeds,
    formatLockValue,
    hibernatePresets,
    lidActionLabel,
    lidActions,
    lockPresets,
    screenOffPresets,
    sleepPresets,
    warnings,
} from './model.js';
import {ChoiceSection} from './ui/choiceSection.js';
import {TimerSection} from './ui/timerSection.js';

// The top-bar button and its popup. It only builds and displays; the
// extension applies values and feeds them back with setValue().
export const Indicator = GObject.registerClass({
    GTypeName: 'SandmanIndicator',
}, class Indicator extends PanelMenu.Button {
    _init({path}) {
        super._init(0.0, 'Sandman', false);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'panel-status-indicators-box',
        });
        box.add_child(new St.Icon({
            gicon: new Gio.FileIcon({
                file: Gio.File.new_for_path(`${path}/icons/sandman-symbolic.svg`),
            }),
            style_class: 'system-status-icon',
        }));
        this._badge = new St.Label({
            text: '●',
            style_class: 'sandman-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._badge);
        this.add_child(box);

        this.keepAwakeSwitch = new PopupMenu.PopupSwitchMenuItem('Keep awake', false);
        this.menu.addMenuItem(this.keepAwakeSwitch);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.lidSection = new ChoiceSection({
            title: 'Lid close',
            items: lidActions.map(a => ({value: a, label: lidActionLabel(a)})),
        });
        this.lidSection.visible = false;
        this.menu.addMenuItem(this.lidSection);

        this.screenOffSection = new TimerSection({
            title: 'Screen off',
            presets: screenOffPresets,
            seed: customSeeds.screenOff,
        });
        this.menu.addMenuItem(this.screenOffSection);

        this.lockSection = new TimerSection({
            title: 'Lock after screen off',
            presets: lockPresets,
            labelFor: formatLockValue,
            seed: customSeeds.lock,
        });
        this.menu.addMenuItem(this.lockSection);

        this.sleepBatterySection = new TimerSection({
            title: 'Sleep on battery',
            presets: sleepPresets,
            seed: customSeeds.sleep,
        });
        this.menu.addMenuItem(this.sleepBatterySection);

        this.sleepAcSection = new TimerSection({
            title: 'Sleep plugged in',
            presets: sleepPresets,
            seed: customSeeds.sleep,
        });
        this.menu.addMenuItem(this.sleepAcSection);

        this.hibernateSection = new TimerSection({
            title: 'Hibernate after sleep',
            presets: hibernatePresets,
            seed: customSeeds.hibernate,
        });
        this.menu.addMenuItem(this.hibernateSection);

        this._errorSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._errorSeparator.visible = false;
        this.menu.addMenuItem(this._errorSeparator);

        this.errorRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._errorLabel = new St.Label({style_class: 'sandman-warning', x_expand: true});
        this._errorLabel.clutter_text.line_wrap = true;
        this.errorRow.add_child(this._errorLabel);
        this.errorRow.visible = false;
        this.menu.addMenuItem(this.errorRow);
    }

    setError(text) {
        const show = text !== null && text !== undefined;
        this._errorLabel.text = show ? text : '';
        this.errorRow.visible = show;
        this._errorSeparator.visible = show;
    }

    setKeepAwakeBadge(on) {
        this._badge.visible = on;
    }

    refreshWarnings(state) {
        const list = warnings(state);
        const pick = text => (list.includes(text) ? text : null);
        this.lockSection.setWarning(pick(LOCK_WARNING));
        this.sleepBatterySection.setWarning(pick(SLEEP_BATTERY_WARNING));
        this.sleepAcSection.setWarning(pick(SLEEP_AC_WARNING));
        this.hibernateSection.setWarning(pick(HIBERNATE_WARNING));
    }
});
