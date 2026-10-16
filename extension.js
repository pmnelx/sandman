import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import St from 'gi://St';
import Gio from 'gi://Gio';

export default class SandmanExtension extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        const icon = new St.Icon({
            gicon: new Gio.FileIcon({
                file: Gio.File.new_for_path(`${this.path}/icons/sandman-symbolic.svg`),
            }),
            style_class: 'system-status-icon',
        });
        this._button.add_child(icon);
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._updateVisibility();
        this._sessionId = Main.sessionMode.connect('updated', () => this._updateVisibility());
    }

    disable() {
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }
        this._button?.destroy();
        this._button = null;
    }

    _updateVisibility() {
        if (this._button)
            this._button.visible = !Main.sessionMode.isLocked;
    }
}
