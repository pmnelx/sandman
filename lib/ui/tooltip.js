import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Gap between the actor and its tooltip, and the minimum margin to the edge
// of the monitor work area.
const GAP = 6;

// Only one tooltip is visible at a time: {actor, label} or null.
let current = null;

function hideTooltip(actor = null) {
    if (!current || (actor !== null && current.actor !== actor))
        return;
    const {label} = current;
    current = null;
    label.destroy();
}

function showTooltip(actor, text) {
    hideTooltip();

    const label = new St.Label({style_class: 'sandman-tooltip', text});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    Main.layoutManager.uiGroup.add_child(label);
    current = {actor, label};

    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    const monitor = Main.layoutManager.findMonitorForActor(actor) ??
        Main.layoutManager.primaryMonitor;
    const area = monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null;

    let [, width] = label.get_preferred_width(-1);
    if (area)
        width = Math.min(width, area.width - 2 * GAP);
    label.set_width(width);
    const [, height] = label.get_preferred_height(width);

    let left = x + (w - width) / 2;
    let top = y + h + GAP;
    if (area) {
        left = Math.max(area.x + GAP, Math.min(left, area.x + area.width - width - GAP));
        // No room below: show it above the actor instead.
        if (top + height > area.y + area.height - GAP)
            top = Math.max(area.y + GAP, y - height - GAP);
    }
    label.set_position(Math.round(left), Math.round(top));
}

// Shows getText() below `actor` while it is hovered or has key focus. The
// tooltip goes away on hover out, focus out, unmap (which covers the menu
// closing) and destroy. Returns detach(), which removes the handlers and any
// tooltip this actor is showing.
export function attachTooltip(actor, getText) {
    // Private owner token, so detach() only drops the handlers made here.
    const owner = {};
    const show = () => {
        const text = getText();
        if (typeof text === 'string' && text !== '' && actor.mapped)
            showTooltip(actor, text);
    };
    const hide = () => hideTooltip(actor);

    actor.connectObject(
        'notify::hover', () => (actor.hover ? show() : hide()),
        'key-focus-in', show,
        'key-focus-out', hide,
        'notify::mapped', () => {
            if (!actor.mapped)
                hide();
        },
        'destroy', hide,
        owner);

    return () => {
        actor.disconnectObject(owner);
        hide();
    };
}
