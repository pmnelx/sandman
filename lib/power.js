import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import {parseRemovableGpus} from './diagnostics.js';

const LOGIN_NAME = 'org.freedesktop.login1';
const LOGIN_PATH = '/org/freedesktop/login1';
const LOGIN_MANAGER = 'org.freedesktop.login1.Manager';

const SESSION_NAME = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';
const SESSION_MANAGER = 'org.gnome.SessionManager';

const DRM_PATH = '/sys/class/drm';

function call(bus, name, path, iface, method, parameters, replyType) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, parameters,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function callLogin(method, parameters, replyType) {
    return call(Gio.DBus.system, LOGIN_NAME, LOGIN_PATH, LOGIN_MANAGER,
        method, parameters, replyType);
}

// Asks logind whether an operation is possible: "yes", "no", "challenge",
// "na", ... Any D-Bus failure reads as "na".
export async function canOperation(name) {
    try {
        const reply = await callLogin(name, null, '(s)');
        return reply.deepUnpack()[0];
    } catch (e) {
        console.warn(`Sandman: ${name} failed: ${e.message}`);
        return 'na';
    }
}

// Calls logind Suspend, SuspendThenHibernate or Hibernate without the
// interactive flag. Rejects when logind refuses.
export async function powerAction(method) {
    await callLogin(method, new GLib.Variant('(b)', [false]), null);
}

export async function isInhibited(flags) {
    const reply = await call(Gio.DBus.session, SESSION_NAME, SESSION_PATH,
        SESSION_MANAGER, 'IsInhibited', new GLib.Variant('(u)', [flags]), '(b)');
    return reply.deepUnpack()[0];
}

// Same test Shell's getLoginManager() uses to pick logind over its dummy,
// whose getCurrentSessionProxy() never settles. haveSystemd() itself is not
// exported from loginManager.js.
function haveSystemd() {
    return GLib.access('/run/systemd/seats', 0) >= 0;
}

// True unless logind positively reports this session as inactive, so a
// missing session proxy never blocks sleep.
export async function sessionIsActive() {
    if (!haveSystemd())
        return true;
    try {
        const session = await LoginManager.getLoginManager().getCurrentSessionProxy();
        if (!session)
            return true;
        return session.Active !== false;
    } catch (e) {
        console.warn(`Sandman: could not read the session state: ${e.message}`);
        return true;
    }
}

export function readTextOrNull(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

// Suspend then hibernate is unsafe with a removable (eGPU) card attached.
export function hasRemovableGpu() {
    const entries = [];
    let enumerator = null;
    try {
        enumerator = Gio.File.new_for_path(DRM_PATH).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const card = info.get_name();
            if (!/^card\d+$/.test(card))
                continue;
            entries.push({
                card,
                removable: readTextOrNull(`${DRM_PATH}/${card}/device/removable`),
            });
        }
    } catch (e) {
        console.warn(`Sandman: could not list GPUs: ${e.message}`);
    } finally {
        enumerator?.close(null);
    }
    return parseRemovableGpus(entries).length > 0;
}

// Takes a logind block inhibitor on the lid switch. The returned handle
// releases it; closing twice is harmless.
export async function inhibitLidSwitch(reason) {
    const fdList = await new Promise((resolve, reject) => {
        Gio.DBus.system.call_with_unix_fd_list(LOGIN_NAME, LOGIN_PATH,
            LOGIN_MANAGER, 'Inhibit',
            new GLib.Variant('(ssss)', ['handle-lid-switch', 'Sandman', reason, 'block']),
            new GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, -1, null, null,
            (connection, result) => {
                try {
                    resolve(connection.call_with_unix_fd_list_finish(result)[1]);
                } catch (e) {
                    reject(e);
                }
            });
    });
    const fd = fdList.steal_fds()[0];
    const stream = new GioUnix.InputStream({fd, close_fd: true});
    let closed = false;
    return {
        close() {
            if (closed)
                return;
            closed = true;
            stream.close(null);
        },
    };
}
