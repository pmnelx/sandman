import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {attachTooltip} from './tooltip.js';

// An always-visible section: a title with warning/note icons, then rows of
// mutually exclusive chips (chipsPerRow per row, default 4). The item itself is not reactive, so clicks never
// reach the menu's "activate" and the popup stays open. Clicking a chip emits
// "value-selected"; the owner applies the value and calls setValue().
export const ChoiceSection = GObject.registerClass({
    GTypeName: 'SandmanChoiceSection',
    Signals: {
        // Payload is a {value} object; consumers destructure (_section, {value}) => ...
        'value-selected': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class ChoiceSection extends PopupMenu.PopupBaseMenuItem {
    _init({title, items, chipsPerRow = 4}) {
        super._init({reactive: false, can_focus: false});

        this._value = undefined;
        this._entries = [];
        this._checkedChip = null;
        this._noteText = null;
        this._warningText = null;

        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(this._box);

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: title,
            style_class: 'sandman-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Widget({x_expand: true}));
        this._warningButton = this._statusButton(
            'dialog-warning-symbolic', 'sandman-status-warning');
        this._noteButton = this._statusButton(
            'dialog-information-symbolic', 'sandman-status-note');
        header.add_child(this._warningButton);
        header.add_child(this._noteButton);
        this._box.add_child(header);

        this._warningTooltip = attachTooltip(this._warningButton, () => this._warningText);
        this._noteTooltip = attachTooltip(this._noteButton, () => this._noteText);

        let row = null;
        for (const {value, label} of items) {
            if (this._entries.length % chipsPerRow === 0) {
                row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    x_expand: true,
                });
                this._box.add_child(row);
            }
            const chip = new St.Button({
                label,
                style_class: 'button sandman-chip',
                x_expand: true,
                can_focus: true,
            });
            const entry = {value, label, chip};
            // Not a toggle button: only _markChip() (via setValue()) writes
            // "checked", so a failed write leaves the current chip highlighted.
            chip.connectObject('clicked', () => this._onChipClicked(entry), this);
            row.add_child(chip);
            this._entries.push(entry);
        }

        this.connect('destroy', () => {
            this._warningTooltip.detach();
            this._noteTooltip.detach();
        });
    }

    _statusButton(iconName, styleClass) {
        return new St.Button({
            style_class: 'sandman-status-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                style_class: `sandman-status-icon ${styleClass}`,
                icon_size: 16,
            }),
        });
    }

    _onChipClicked(entry) {
        this.emit('value-selected', {value: entry.value});
    }

    _findEntry(value) {
        return this._entries.find(entry => entry.value === value) ?? null;
    }

    _markChip(chip) {
        this._checkedChip = chip;
        for (const entry of this._entries)
            entry.chip.checked = entry.chip === chip;
    }

    setValue(value) {
        this._value = value;
        this._markChip(this._findEntry(value)?.chip ?? null);
    }

    setItemSensitive(value, sensitive) {
        const chip = this._findEntry(value)?.chip;
        if (!chip)
            return;
        chip.reactive = sensitive;
        chip.can_focus = sensitive;
        if (sensitive)
            chip.remove_style_class_name('sandman-chip-insensitive');
        else
            chip.add_style_class_name('sandman-chip-insensitive');
    }

    // Stores the text through `store`, shows or hides the icon, and updates
    // its tooltip if it is showing.
    _setStatus(button, tooltip, text, store) {
        const show = text !== null && text !== undefined && text !== '';
        store(show ? text : null);
        button.accessible_name = show ? text : '';
        button.visible = show;
        tooltip.refresh();
    }

    setNote(text) {
        this._setStatus(this._noteButton, this._noteTooltip, text,
            t => (this._noteText = t));
    }

    setWarning(text) {
        this._setStatus(this._warningButton, this._warningTooltip, text,
            t => (this._warningText = t));
    }
});
