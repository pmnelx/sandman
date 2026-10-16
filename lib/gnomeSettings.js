import Gio from 'gi://Gio';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {LOCK_OFF, lockParts, lockValue, requestedSeconds} from './model.js';

const SESSION_SCHEMA = 'org.gnome.desktop.session';
const SCREENSAVER_SCHEMA = 'org.gnome.desktop.screensaver';
const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';

const SOURCES = ['battery', 'ac'];

const timeoutKey = source => `sleep-inactive-${source}-timeout`;
const typeKey = source => `sleep-inactive-${source}-type`;

function checkSource(source) {
    if (!SOURCES.includes(source))
        throw new Error(`Unknown power source: ${source}`);
}

function checkSeconds(value) {
    const seconds = requestedSeconds(value);
    if (seconds === -1)
        throw new Error('Ignored an invalid timeout');
    return seconds;
}

// Reads and writes the GNOME keys Sandman shows in the menu. Emits "changed"
// with the GNOME key name when one of the watched keys changes from outside.
export class GnomeSettings extends EventEmitter {
    constructor() {
        super();

        this._session = new Gio.Settings({schema_id: SESSION_SCHEMA});
        this._screensaver = new Gio.Settings({schema_id: SCREENSAVER_SCHEMA});
        this._power = new Gio.Settings({schema_id: POWER_SCHEMA});

        // Keys we wrote ourselves and whose next "changed" must not re-emit.
        // GSettings may deliver that signal after the setter returns, so a
        // boolean reset at the end of the setter would not cover it.
        this._pendingWrites = new Set();
        this._handlers = [];

        this._watch(this._session, 'idle-delay');
        this._watch(this._screensaver, 'lock-enabled');
        this._watch(this._screensaver, 'lock-delay');
        for (const source of SOURCES) {
            this._watch(this._power, timeoutKey(source));
            this._watch(this._power, typeKey(source));
        }
    }

    _watch(settings, key) {
        const id = settings.connect(`changed::${key}`, () => {
            if (this._pendingWrites.delete(key))
                return;
            this.emit('changed', key);
        });
        this._handlers.push([settings, id]);
    }

    // Writes only when the value differs, so every pending entry is matched by
    // a "changed" signal and never swallows a later external change.
    _write(settings, key, current, value, setter) {
        if (current === value)
            return;
        this._pendingWrites.add(key);
        if (!setter.call(settings, key, value)) {
            this._pendingWrites.delete(key);
            throw new Error(`Could not write ${key}`);
        }
    }

    getScreenOff() {
        return this._session.get_uint('idle-delay');
    }

    setScreenOff(seconds) {
        const value = checkSeconds(seconds);
        this._write(this._session, 'idle-delay',
            this._session.get_uint('idle-delay'), value, this._session.set_uint);
    }

    getLock() {
        return lockValue(this._screensaver.get_boolean('lock-enabled'),
            this._screensaver.get_uint('lock-delay'));
    }

    // Off only clears lock-enabled and keeps lock-delay, as the Automatic
    // Screen Lock switch in GNOME Settings does.
    setLock(value) {
        const s = this._screensaver;
        if (value === LOCK_OFF) {
            this._write(s, 'lock-enabled', s.get_boolean('lock-enabled'), false, s.set_boolean);
            return;
        }
        const {enabled, delay} = lockParts(checkSeconds(value));
        this._write(s, 'lock-enabled', s.get_boolean('lock-enabled'), enabled, s.set_boolean);
        this._write(s, 'lock-delay', s.get_uint('lock-delay'), delay, s.set_uint);
    }

    getSleep(source) {
        checkSource(source);
        return {
            type: this._power.get_string(typeKey(source)),
            timeout: this._power.get_int(timeoutKey(source)),
        };
    }

    setSleepType(source, type) {
        checkSource(source);
        const key = typeKey(source);
        this._write(this._power, key, this._power.get_string(key), type, this._power.set_string);
    }

    destroy() {
        for (const [settings, id] of this._handlers)
            settings.disconnect(id);
        this._handlers = [];
        this._pendingWrites.clear();
        this._session = null;
        this._screensaver = null;
        this._power = null;
    }
}
