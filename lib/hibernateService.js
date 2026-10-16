import Gio from 'gi://Gio';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {diagnoseHibernate} from './diagnostics.js';
import {normalizedSeconds, requestedSeconds} from './model.js';
import {canOperation, readTextOrNull} from './power.js';

export const HELPER_PATH = '/usr/local/libexec/sandman-configure-hibernate';

const INVALID_ERROR = 'Ignored an invalid timeout';
const DELAY_ERROR = 'Could not change the system hibernate delay';

// Runs the privileged helper through pkexec. Resolves on exit 0; rejects on
// spawn failure or any other exit status, including 126 (authorization
// dialog dismissed) and 127 (not authorized or helper missing).
function runHelper(seconds) {
    return new Promise((resolve, reject) => {
        const proc = new Gio.Subprocess({
            argv: ['pkexec', HELPER_PATH, 'configure-hibernate', String(seconds)],
            flags: Gio.SubprocessFlags.NONE,
        });
        proc.init(null);
        proc.wait_check_async(null, (source, result) => {
            try {
                source.wait_check_finish(result);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Hibernate after sleep. Asks logind whether suspend-then-hibernate and
// hibernate are possible, explains why not when they are not, and changes
// the system-wide hibernate delay through the pkexec helper. The
// "hibernate-delay" key is written only after the helper succeeds. Emits
// "changed" when availability or the delay changes and "error" with a
// message when the helper fails.
export class HibernateService extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._handlers = [];
        this._enabled = false;
        this._cancellable = null;
        // Serialises helper runs so the last pick is the one that sticks.
        this._queue = Promise.resolve();
        this.available = false;
        this.canHibernate = false;
        this.diagnosis = '';
    }

    async enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._handlers.push([this._settings,
            this._settings.connect('changed::hibernate-delay', () => this.emit('changed'))]);

        const [suspendThenHibernate, hibernate] = await Promise.all([
            canOperation('CanSuspendThenHibernate'),
            canOperation('CanHibernate'),
        ]);
        if (cancellable.is_cancelled() || !this._enabled)
            return;

        this.available = suspendThenHibernate === 'yes';
        this.canHibernate = hibernate === 'yes';
        this.diagnosis = this.available ? '' : diagnoseHibernate({
            powerState: readTextOrNull('/sys/power/state'),
            powerDisk: readTextOrNull('/sys/power/disk'),
            lockdown: readTextOrNull('/sys/kernel/security/lockdown'),
            swaps: readTextOrNull('/proc/swaps'),
            meminfo: readTextOrNull('/proc/meminfo'),
            resume: readTextOrNull('/sys/power/resume'),
            efiPresent: Gio.File.new_for_path('/sys/firmware/efi').query_exists(null),
        }).summary;
        this.emit('changed');
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const [emitter, id] of this._handlers)
            emitter.disconnect(id);
        this._handlers = [];
    }

    getDelay() {
        return normalizedSeconds(this._settings.get_int('hibernate-delay'), 0, true);
    }

    async setDelay(seconds) {
        const value = requestedSeconds(seconds);
        if (value === -1)
            throw new Error(INVALID_ERROR);
        if (value > 0 && !this.available)
            throw new Error(DELAY_ERROR);

        const run = this._queue.then(() => this._applyDelay(value));
        this._queue = run.catch(() => {});
        return run;
    }

    async _applyDelay(value) {
        if (!this._enabled)
            return;
        try {
            await runHelper(value);
        } catch (e) {
            console.warn(`Sandman: the hibernate helper failed: ${e.message}`);
            if (this._enabled)
                this.emit('error', DELAY_ERROR);
            throw new Error(DELAY_ERROR);
        }
        // The helper has changed the system drop-in, so the key follows it
        // even if the extension was disabled while the dialog was open. The
        // changed:: handler emits "changed".
        this._settings.set_int('hibernate-delay', value);
    }
}
