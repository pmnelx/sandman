import Gio from 'gi://Gio';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const SCHEMA = 'org.gnome.desktop.interface';
const KEY = 'color-scheme';

export const SCHEMES = ['light', 'dark'];

// Sandman's names for the values of GNOME's color-scheme enum.
const TO_GNOME = {
    light: 'default',
    dark: 'prefer-dark',
};

const LABELS = {
    light: 'Light',
    dark: 'Dark',
};

export function schemeLabel(value) {
    return LABELS[value];
}

// Reads and writes GNOME's color-scheme setting. Emits "changed" when it
// changes from outside.
export class Appearance extends EventEmitter {
    constructor() {
        super();

        this._settings = new Gio.Settings({schema_id: SCHEMA});
        // Set while our own write's "changed" has not arrived yet. GSettings
        // may deliver that signal after set_string() returns, so a flag reset
        // at the end of setScheme() would not cover it.
        this._pendingWrite = false;
        this._changedId = this._settings.connect(`changed::${KEY}`, () => {
            if (this._pendingWrite) {
                this._pendingWrite = false;
                return;
            }
            this.emit('changed');
        });
    }

    get scheme() {
        // Like GNOME Settings: only prefer-dark is dark.
        return this._settings.get_string(KEY) === TO_GNOME.dark ? 'dark' : 'light';
    }

    // Writes only when the value differs, so every pending write is matched
    // by a "changed" signal and never swallows a later external change.
    setScheme(value) {
        if (!SCHEMES.includes(value))
            throw new Error('Ignored an invalid appearance');
        const target = TO_GNOME[value];
        if (this._settings.get_string(KEY) === target)
            return;
        this._pendingWrite = true;
        if (!this._settings.set_string(KEY, target)) {
            this._pendingWrite = false;
            throw new Error('Could not change the appearance');
        }
    }

    destroy() {
        if (this._settings && this._changedId)
            this._settings.disconnect(this._changedId);
        this._changedId = 0;
        this._pendingWrite = false;
        this._settings = null;
    }
}
