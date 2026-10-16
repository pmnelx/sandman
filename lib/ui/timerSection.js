import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {customSeconds, customSeed, formatDuration, isPreset} from '../model.js';
import {ChoiceSection} from './choiceSection.js';

const CUSTOM = 'custom';

// A ChoiceSection of timeout presets plus a "Custom…" item that opens an
// inline hours/minutes row. Apply, or Return in either entry, emits
// "value-selected" with {value} in seconds.
export const TimerSection = GObject.registerClass({
    GTypeName: 'SandmanTimerSection',
}, class TimerSection extends ChoiceSection {
    _init({title, presets, labelFor = formatDuration, seed}) {
        if (typeof seed !== 'number')
            throw new TypeError('TimerSection needs a numeric seed');

        const items = presets.map(v => ({value: v, label: labelFor(v)}));
        items.push({value: CUSTOM, label: 'Custom…'});
        super._init({title, items});

        this._presets = presets;
        this._labelFor = labelFor;
        this._seed = seed;
        this._customEnabled = true;
        this._focusId = 0;

        // Activating Custom… must keep the menu open and must not emit, so
        // replace the item's activate (which would close the top menu).
        this._customItem = this._findEntry(CUSTOM).item;
        this._customItem.activate = () => this._openCustom(this._value);

        this._customRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._hoursEntry = new St.Entry({
            style_class: 'sandman-custom-entry',
            hint_text: 'Hours',
            x_expand: true,
        });
        this._minutesEntry = new St.Entry({
            style_class: 'sandman-custom-entry',
            hint_text: 'Minutes',
            x_expand: true,
        });
        const apply = new St.Button({label: 'Apply', style_class: 'button'});
        apply.connectObject('clicked', () => this._apply(), this);
        for (const entry of [this._hoursEntry, this._minutesEntry]) {
            entry.clutter_text.activatable = true;
            entry.clutter_text.connectObject('activate', () => this._apply(), this);
        }
        box.add_child(this._hoursEntry);
        box.add_child(this._minutesEntry);
        box.add_child(apply);
        this._customRow.add_child(box);
        this._customRow.visible = false;
        this.menu.addMenuItem(this._customRow);

        this.connect('destroy', () => this._onDestroy());
    }

    _seedEntries(seconds) {
        const {hours, minutes} = customSeed(seconds, this._seed);
        this._hoursEntry.text = String(hours);
        this._minutesEntry.text = String(minutes);
    }

    _openCustom(seconds) {
        if (!this._customEnabled)
            return;
        this._seedEntries(seconds);
        this._customRow.visible = true;

        if (this._focusId)
            GLib.source_remove(this._focusId);
        this._focusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._focusId = 0;
            global.stage.set_key_focus(this._hoursEntry);
            return GLib.SOURCE_REMOVE;
        });
    }

    _apply() {
        const seconds = customSeconds(
            parseInt(this._hoursEntry.text, 10),
            parseInt(this._minutesEntry.text, 10));
        if (seconds > 0)
            this.emit('value-selected', {value: seconds});
    }

    setValue(value) {
        if (isPreset(value, this._presets)) {
            super.setValue(value);
            this._customRow.visible = false;
            return;
        }

        this._value = value;
        this._markItem(this._customItem);
        this._setTitleSuffix(this._labelFor(value));
        if (this._customEnabled) {
            this._seedEntries(value);
            this._customRow.visible = true;
        }
    }

    setCustomEnabled(enabled) {
        this._customEnabled = enabled;
        this._customItem.setSensitive(enabled);
        if (!enabled)
            this._customRow.visible = false;
    }

    _onDestroy() {
        if (this._focusId) {
            GLib.source_remove(this._focusId);
            this._focusId = 0;
        }
    }
});
