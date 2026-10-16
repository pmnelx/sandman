import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// A submenu listing mutually exclusive choices. Activating an item emits
// "value-selected"; the owner applies the value and calls setValue().
export const ChoiceSection = GObject.registerClass({
    GTypeName: 'SandmanChoiceSection',
    Signals: {
        // Payload is a {value} object; consumers destructure (_section, {value}) => ...
        'value-selected': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class ChoiceSection extends PopupMenu.PopupSubMenuMenuItem {
    _init({title, items}) {
        super._init(title, false);

        this._title = title;
        this._value = undefined;
        this._entries = [];
        this._noteItem = null;
        this._noteLabel = null;
        this._warningItem = null;
        this._warningLabel = null;

        for (const {value, label} of items) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(PopupMenu.Ornament.NO_DOT);
            item.connectObject('activate', () => this.emit('value-selected', {value}), this);
            this.menu.addMenuItem(item);
            this._entries.push({value, label, item});
        }
    }

    _findEntry(value) {
        return this._entries.find(entry => entry.value === value) ?? null;
    }

    _setTitleSuffix(suffix) {
        this.label.text = suffix === null ? this._title : `${this._title}  ${suffix}`;
    }

    _markItem(item) {
        for (const entry of this._entries) {
            entry.item.setOrnament(entry.item === item
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
    }

    setValue(value) {
        this._value = value;
        const entry = this._findEntry(value);
        this._markItem(entry?.item ?? null);
        this._setTitleSuffix(entry ? entry.label : null);
    }

    setItemSensitive(value, sensitive) {
        this._findEntry(value)?.item.setSensitive(sensitive);
    }

    _infoRow(styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const label = new St.Label({x_expand: true});
        if (styleClass)
            label.style_class = styleClass;
        label.clutter_text.line_wrap = true;
        item.add_child(label);
        this.menu.addMenuItem(item);
        return [item, label];
    }

    setNote(text) {
        if (text === null || text === undefined) {
            if (this._noteItem)
                this._noteItem.visible = false;
            return;
        }
        if (!this._noteItem)
            [this._noteItem, this._noteLabel] = this._infoRow(null);
        this._noteLabel.text = text;
        this._noteItem.visible = true;
    }

    setWarning(text) {
        if (text === null || text === undefined) {
            if (this._warningItem)
                this._warningItem.visible = false;
            return;
        }
        if (!this._warningItem)
            [this._warningItem, this._warningLabel] = this._infoRow('sandman-warning');
        this._warningLabel.text = text;
        this._warningItem.visible = true;
    }
});
