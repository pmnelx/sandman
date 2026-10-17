import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SCHEMES, schemeLabel} from '../appearance.js';
import {attachTooltip} from './tooltip.js';

const SCHEME_ICONS = {
    system: ['preferences-desktop-appearance-symbolic', 'display-brightness-symbolic'],
    light: ['weather-clear-symbolic'],
    dark: ['weather-clear-night-symbolic'],
};

// The popup's first row: the Keep awake switch on the left and the
// System / Light / Dark appearance chips on the right. The item itself is not
// reactive, so clicks never reach the menu's "activate" and the popup stays
// open. The owner applies what the row emits and feeds it back with
// setToggleState() and setScheme().
export const TopRow = GObject.registerClass({
    GTypeName: 'SandmanTopRow',
    Signals: {
        'toggled': {param_types: [GObject.TYPE_BOOLEAN]},
        // Payload is a {value} object; consumers destructure (_row, {value}) => ...
        'scheme-selected': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class TopRow extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false});

        this._chips = [];
        this._tooltips = [];

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this.add_child(box);

        const label = new St.Label({
            text: 'Keep awake',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._switch = new PopupMenu.Switch(false);
        // The switch has its own drag gesture that toggles it; with it
        // reactive a click on the switch would toggle twice. Non-reactive, it
        // is not picked and the button below gets the click. GNOME 50 binds
        // the handle's reactive to the switch's; set it too in case an older
        // shell does not.
        this._switch.reactive = false;
        if (this._switch._handle)
            this._switch._handle.reactive = false;

        const switchBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        switchBox.add_child(label);
        switchBox.add_child(this._switch);

        this._switchButton = new St.Button({
            style_class: 'sandman-switch-button',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: switchBox,
        });
        this._switchButton.label_actor = label;
        // St.Button emits "clicked" for pointer clicks and for Return and
        // space while focused.
        this._switchButton.connectObject('clicked', () => this._onSwitchClicked(), this);
        box.add_child(this._switchButton);

        const segment = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sandman-segment',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Equal-width icon chips.
        segment.layout_manager.homogeneous = true;
        for (const value of SCHEMES) {
            const text = schemeLabel(value);
            const chip = new St.Button({
                style_class: 'button sandman-chip sandman-icon-chip',
                can_focus: true,
                track_hover: true,
                accessible_name: text,
                child: new St.Icon({
                    gicon: Gio.ThemedIcon.new_from_names(SCHEME_ICONS[value]),
                    icon_size: 16,
                }),
            });
            // Not a toggle button: only setScheme() writes "checked", so a
            // failed write leaves the current chip highlighted.
            chip.connectObject('clicked',
                () => this.emit('scheme-selected', {value}), this);
            this._tooltips.push(attachTooltip(chip, () => text));
            this._chips.push({value, chip});
            segment.add_child(chip);
        }
        box.add_child(segment);

        this.connect('destroy', () => {
            for (const tooltip of this._tooltips)
                tooltip.detach();
            this._tooltips = [];
        });
    }

    _onSwitchClicked() {
        this._switch.state = !this._switch.state;
        this.emit('toggled', this._switch.state);
    }

    get state() {
        return this._switch.state;
    }

    // Sets the switch without emitting "toggled".
    setToggleState(state) {
        this._switch.state = state;
    }

    setScheme(value) {
        for (const {value: v, chip} of this._chips)
            chip.checked = v === value;
    }
});
