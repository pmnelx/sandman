import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'org.gnome.SessionManager';
const OBJECT_PATH = '/org/gnome/SessionManager';
const INTERFACE = 'org.gnome.SessionManager';

const APP_ID = 'sandman@pmnelx.github.io';
const REASON = 'Keep awake';
const FLAGS = 12; // suspend (4) + idle (8)
const ERROR = 'Could not change keep awake';

function callSessionManager(method, parameters, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, method,
            parameters, replyType, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function uninhibitNow(cookie) {
    callSessionManager('Uninhibit', new GLib.Variant('(u)', [cookie]), null)
        .catch(e => console.warn(`Sandman: Uninhibit failed: ${e.message}`));
}

// Holds a session idle+suspend inhibitor while keep awake is on and persists
// the choice in the "keep-awake" key. Emits "changed" when the state changes.
export class KeepAwake extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._cookie = null;
        this._destroyed = false;
        // Serialises D-Bus round trips so quick toggles cannot double inhibit.
        this._queue = Promise.resolve();
    }

    get active() {
        return this._cookie !== null;
    }

    async setActive(on) {
        const run = this._queue.then(() => this._apply(on));
        this._queue = run.catch(() => {});
        return run;
    }

    async _apply(on) {
        if (this._destroyed || on === this.active)
            return;

        if (on) {
            let cookie;
            try {
                const reply = await callSessionManager('Inhibit',
                    new GLib.Variant('(susu)', [APP_ID, 0, REASON, FLAGS]),
                    new GLib.VariantType('(u)'));
                [cookie] = reply.deepUnpack();
            } catch (e) {
                if (this._destroyed)
                    return;
                console.warn(`Sandman: Inhibit failed: ${e.message}`);
                throw new Error(ERROR);
            }
            if (this._destroyed) {
                uninhibitNow(cookie);
                return;
            }
            this._cookie = cookie;
        } else {
            try {
                await callSessionManager('Uninhibit',
                    new GLib.Variant('(u)', [this._cookie]), null);
            } catch (e) {
                if (this._destroyed)
                    return;
                console.warn(`Sandman: Uninhibit failed: ${e.message}`);
                throw new Error(ERROR);
            }
            if (this._destroyed)
                return;
            this._cookie = null;
        }

        this._settings.set_boolean('keep-awake', on);
        this.emit('changed');
    }

    restore() {
        if (!this._settings.get_boolean('keep-awake'))
            return;
        this.setActive(true).catch(e =>
            console.warn(`Sandman: could not restore keep awake: ${e.message}`));
    }

    destroy() {
        this._destroyed = true;
        if (this._cookie !== null) {
            uninhibitNow(this._cookie);
            this._cookie = null;
        }
        this._settings = null;
    }
}
