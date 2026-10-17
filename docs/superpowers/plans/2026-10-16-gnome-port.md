# Sandman for GNOME Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Omarchy Quattro plugin in this repo with a GNOME Shell extension that puts keep-awake, lid-close, screen-off, lock, sleep (battery and plugged in) and hibernate-after-sleep in one top-bar popup.

**Architecture:** A GJS ESM extension. Pure logic (presets, validation, formatting, warnings, hibernate diagnostics) lives in `lib/model.js` and `lib/diagnostics.js` with no GNOME imports so `node --test` covers it. Services (`sleepService`, `lidService`, `keepAwake`, `hibernateService`) talk to GNOME and logind over D-Bus and GSettings and emit changes through `EventEmitter`. `indicator.js` builds the popup from two reusable menu sections and binds them to the services. The Python root helper is reused verbatim behind pkexec.

**Tech Stack:** GJS (GNOME Shell 48 to 51, Wayland), Gio/GLib/St/Clutter via GI, GSettings, logind and gnome-session D-Bus, Python 3 helper, polkit, `node --test` (ESM), `python3 -m unittest`.

**Spec:** `docs/superpowers/specs/2026-10-16-gnome-port-design.md`

## Global Constraints

- `metadata.json`: `uuid` `sandman@pmnelx.github.io`, `shell-version` `["48","49","50","51"]`, `session-modes` `["user","unlock-dialog"]`, `settings-schema` `org.gnome.shell.extensions.sandman`.
- GNOME 51 compatibility: never use St `vertical` (use `orientation: Clutter.Orientation.VERTICAL`); construct D-Bus proxy wrappers with `new`; `disable()` is synchronous and tears down everything `enable()` created.
- Seconds everywhere; `0` means Off except lock, where `-1` means Off and `0` means Immediately. Maximum `604800` s (7 days).
- Input validation: new values go through `requestedSeconds` (reject, never coerce to Off); persisted values through `normalizedSeconds` (clamp).
- Root helper path `/usr/local/libexec/sandman-configure-hibernate`, invoked only via `pkexec`. Nothing under the extension directory runs as root.
- Enabling the extension must not change observable sleep behaviour (first-run adoption).
- Copy strings fixed by the spec are quoted in the tasks; use them verbatim.
- Commits end with the attribution lines in effect for this session.

## Review Focus

1. Custom entry with blank or non-numeric text ("", "abc") must apply nothing, never 0 or NaN. Pinned in Task 2 (`customSeconds("abc", "") === 0`) and Task 6 (Apply ignored when total is 0).
2. Ubuntu stores `sleep-inactive-ac-timeout 3600` with type `nothing`. Adoption must yield 0 for that source, not 3600. Pinned in Task 2 (`adoptedSleepTimeout`).
3. Machines with no battery or no UPower: `OnBattery` unknown must select the plugged-in timeout; `LidIsPresent` unknown must hide the lid section. Pinned in Task 2 (`pickSleepTimeout(undefined, ...)`) and Task 11.
4. Diagnostics with unreadable files (null contents) must return the generic summary, never throw. Pinned in Task 3.
5. A cancelled pkexec dialog (exit 126) must leave `hibernate-delay` unchanged and show the error row. Pinned in Task 10.

---

### Task 1: Repository reshape and ESM test harness

**Files:**
- Delete: `BarWidget.qml`, `LidService.qml`, `Panel.qml`, `Service.qml`, `bridge/`, `manifest.json`, `sandman.py`, `preview.png`, `preview-laptop.png`, `test/test_helper.py`
- Move: `Model.js` to `lib/model.js`
- Modify: `package.json`, `test/model.test.js`
- Keep: `sandman-configure-hibernate`, `test/test_configure_hibernate.py`, `LICENSE`

**Interfaces:**
- Produces: `lib/model.js` as an ES module exporting every former top-level `var` and `function`; `npm test` running `node --test` (ESM) then `python3 -m unittest discover -s test -p 'test_*.py'`.

- [ ] **Step 1: Delete the Omarchy files and move the model**

```bash
git rm -q BarWidget.qml LidService.qml Panel.qml Service.qml manifest.json sandman.py preview.png preview-laptop.png test/test_helper.py
git rm -rq bridge
mkdir -p lib && git mv Model.js lib/model.js
```

- [ ] **Step 2: Convert `lib/model.js` to ESM**

Remove the `.pragma library` line. Change each top-level `var` to `export const` and each top-level `function` to `export function`. Delete `shouldCancelCycle`, `statusSummary`, `parseConfig`, `screensaverPresets` and `displayPresets` (no GNOME equivalent). Keep everything else unchanged for now; Task 2 adds the new functions.

- [ ] **Step 3: Rewrite `test/model.test.js` as ESM**

Replace the `vm` loader with `import * as model from "../lib/model.js"` and `import test from "node:test"`, `import assert from "node:assert/strict"`. Drop the tests for `parseConfig`, `statusSummary` and `shouldCancelCycle`. Keep: lid normalisation and labels, `formatDuration`, both `requestedSeconds` tests, `normalizedSeconds` clamp.

- [ ] **Step 4: Update `package.json`**

```json
{
  "name": "sandman",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Keep awake, lid close, screen off, lock, sleep and hibernate from the GNOME top bar.",
  "scripts": {
    "test": "node --test && python3 -m unittest discover -s test -p 'test_*.py'"
  },
  "license": "MIT"
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all node tests pass, all Python tests in `test_configure_hibernate.py` pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove Omarchy plugin, keep model and helper for the GNOME port"
```

---

### Task 2: Model additions for GNOME semantics

**Files:**
- Modify: `lib/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Produces (all exported from `lib/model.js`):
  - `screenOffPresets = [0, 60, 120, 300, 600, 900, 1800]`
  - `LOCK_OFF = -1`; `lockPresets = [LOCK_OFF, 0, 30, 60, 120, 300, 900, 1800, 3600]`
  - `sleepPresets = [0, 900, 1800, 3600, 7200]`; `hibernatePresets = [0, 1800, 3600, 7200, 14400, 28800]`
  - `customSeeds = { screenOff: 300, lock: 300, sleep: 900, hibernate: 3600 }`
  - `formatLockValue(value: number): string` ("Off" for `LOCK_OFF`, "Immediately" for 0, else `formatDuration`)
  - `lockValue(enabled: boolean, delay: number): number` and `lockParts(value: number): {enabled: boolean, delay: number}`
  - `customSeed(seconds: number, fallback: number): {hours, minutes}` (`customParts` of `seconds` when > 0, else of `fallback`)
  - `adoptedSleepTimeout(type: string, timeout: number): number` (`normalizedSeconds(timeout, 0, true)` when `type === "suspend"`, else 0)
  - `pickSleepTimeout(onBattery: boolean|undefined, battery: number, ac: number): number` (battery only when `onBattery === true`)
  - `sleepMethod(hibernateDelay: number, hasRemovableGpu: boolean): "SuspendThenHibernate" | "Suspend"`
  - `warnings(state: {screenOff, lock, sleepBattery, sleepAc, hibernate}): string[]`

- [ ] **Step 1: Write the failing tests**

```js
test("lock values round-trip through enabled/delay", () => {
  assert.equal(model.lockValue(false, 300), model.LOCK_OFF);
  assert.equal(model.lockValue(true, 0), 0);
  assert.deepEqual(model.lockParts(model.LOCK_OFF), { enabled: false, delay: 0 });
  assert.deepEqual(model.lockParts(900), { enabled: true, delay: 900 });
  assert.equal(model.formatLockValue(model.LOCK_OFF), "Off");
  assert.equal(model.formatLockValue(0), "Immediately");
  assert.equal(model.formatLockValue(1800), "30 min");
});

test("custom entry helpers", () => {
  assert.deepEqual(model.customParts(90), { hours: 0, minutes: 2 });
  assert.deepEqual(model.customParts(3660), { hours: 1, minutes: 1 });
  assert.equal(model.customSeconds(1, 30), 5400);
  assert.equal(model.customSeconds(99, 99), (24 * 60 + 59) * 60);
  assert.equal(model.customSeconds("abc", ""), 0);
  assert.deepEqual(model.customSeed(0, 900), { hours: 0, minutes: 15 });
  assert.deepEqual(model.customSeed(120, 900), { hours: 0, minutes: 2 });
  assert.equal(model.isPreset(900, model.sleepPresets), true);
  assert.equal(model.isPreset(150, model.sleepPresets), false);
});

test("adoption takes gsd timeouts only when gsd would suspend", () => {
  assert.equal(model.adoptedSleepTimeout("suspend", 1200), 1200);
  assert.equal(model.adoptedSleepTimeout("nothing", 3600), 0);
  assert.equal(model.adoptedSleepTimeout("suspend", 2000000000), model.maxTimeoutSeconds);
});

test("active sleep timeout follows the power source, defaulting to plugged in", () => {
  assert.equal(model.pickSleepTimeout(true, 1200, 3600), 1200);
  assert.equal(model.pickSleepTimeout(false, 1200, 3600), 3600);
  assert.equal(model.pickSleepTimeout(undefined, 1200, 3600), 3600);
});

test("sleepMethod applies the eGPU rule", () => {
  assert.equal(model.sleepMethod(3600, false), "SuspendThenHibernate");
  assert.equal(model.sleepMethod(3600, true), "Suspend");
  assert.equal(model.sleepMethod(0, false), "Suspend");
});

test("warnings mirror the upstream panel", () => {
  assert.deepEqual(model.warnings({ screenOff: 0, lock: 300, sleepBattery: 0, sleepAc: 0, hibernate: 0 }),
    ["Lock cannot fire while screen off is Off."]);
  assert.deepEqual(model.warnings({ screenOff: 600, lock: model.LOCK_OFF, sleepBattery: 300, sleepAc: 0, hibernate: 0 }),
    ["Sleep on battery is set before the screen turns off."]);
  assert.deepEqual(model.warnings({ screenOff: 600, lock: 0, sleepBattery: 0, sleepAc: 300, hibernate: 0 }),
    ["Sleep plugged in is set before the screen turns off."]);
  assert.deepEqual(model.warnings({ screenOff: 600, lock: 0, sleepBattery: 0, sleepAc: 0, hibernate: 3600 }),
    ["Enable Sleep for automatic hibernation after inactivity."]);
  assert.deepEqual(model.warnings({ screenOff: 600, lock: 0, sleepBattery: 900, sleepAc: 1800, hibernate: 3600 }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL, the new exports are undefined.

- [ ] **Step 3: Implement the exports listed in Interfaces in `lib/model.js`**

`warnings` rules: lock warning when `lock !== LOCK_OFF && screenOff === 0`; each sleep warning when `sleep > 0 && screenOff > 0 && sleep <= screenOff`; hibernate warning when `hibernate > 0 && sleepBattery === 0 && sleepAc === 0`. Order: lock, battery, plugged in, hibernate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/model.js test/model.test.js
git commit -m "feat(model): lock values, adoption, power-source and warning helpers"
```

---

### Task 3: Hibernate diagnostics module

**Files:**
- Create: `lib/diagnostics.js`
- Test: `test/diagnostics.test.js`

**Interfaces:**
- Produces: `diagnoseHibernate(files: {powerState, powerDisk, lockdown, swaps, meminfo, resume: string|null, efiPresent: boolean}): {issues: string[], summary: string, lockdownMode: string}`. Pure; callers read the files. Summary is `issues.join(" ")`.
- Produces: `parseRemovableGpus(entries: Array<{card: string, removable: string|null}>): string[]` (cards whose trimmed `removable` is `"removable"`).

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseHibernate, parseRemovableGpus } from "../lib/diagnostics.js";

const healthy = {
  powerState: "freeze mem disk\n",
  powerDisk: "[platform] shutdown reboot suspend test_resume\n",
  lockdown: "[none] integrity confidentiality\n",
  swaps: "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile file 33554432 0 -2\n",
  meminfo: "MemTotal:       31457280 kB\nMemFree: 1 kB\n",
  resume: "259:2\n",
  efiPresent: true,
};

test("healthy inputs give the generic summary", () => {
  const result = diagnoseHibernate(healthy);
  assert.deepEqual(result.issues, [
    "The basic checks passed, but logind still reports hibernation as unavailable. Check system logs and firmware support.",
  ]);
  assert.equal(result.lockdownMode, "none");
});

test("Paul's laptop: lockdown integrity, disk disabled, small swap", () => {
  const result = diagnoseHibernate({
    ...healthy,
    powerDisk: "[disabled]\n",
    lockdown: "none [integrity] confidentiality\n",
    swaps: "Filename Type Size Used Priority\n/swapfile file 8388604 0 -2\n/dev/zram0 partition 8388604 0 100\n",
  });
  assert.deepEqual(result.issues, [
    "Hibernation is disabled by the kernel (/sys/power/disk).",
    "Disk-backed swap is smaller than RAM. Hibernation may need a larger swap area when memory use is high.",
    "Kernel lockdown integrity mode blocks hibernation; this is usually Secure Boot.",
  ]);
  assert.equal(result.summary, result.issues.join(" "));
});

test("zram-only swap and no resume device", () => {
  const result = diagnoseHibernate({
    ...healthy,
    swaps: "Filename Type Size Used Priority\n/dev/zram0 partition 8388604 0 100\n",
    resume: "0:0\n",
    efiPresent: false,
  });
  assert.deepEqual(result.issues, [
    "No disk-backed swap is active. Configure a swap file or partition large enough for hibernation; zram alone cannot store the image.",
    "No kernel resume device is configured and EFI resume discovery is unavailable.",
  ]);
});

test("unreadable files never throw", () => {
  const result = diagnoseHibernate({ powerState: null, powerDisk: null, lockdown: null, swaps: null, meminfo: null, resume: null, efiPresent: false });
  assert.equal(result.issues[0], "The kernel does not advertise hibernation support.");
  assert.equal(result.lockdownMode, "unknown");
});

test("removable GPU detection", () => {
  assert.deepEqual(parseRemovableGpus([
    { card: "card0", removable: "fixed\n" },
    { card: "card1", removable: "removable\n" },
    { card: "card2", removable: null },
  ]), ["card1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/diagnostics.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/diagnostics.js`**

Port `hibernate_diagnostics` from the `omarchy-final` tag's `sandman.py` lines 349 to 434 with these changes: inputs are strings not paths; add the `powerDisk` check (`[disabled]` present) after the `powerState` check; lockdown issue fires for `integrity` and `confidentiality` with the text in the test; swap and resume messages copied verbatim from the Python. Issue order: kernel, disk, swap, resume, lockdown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/diagnostics.js test/diagnostics.test.js
git commit -m "feat: pure hibernate diagnostics ported from sandman.py"
```

---

### Task 4: Extension skeleton, schema, icon, installer

**Files:**
- Create: `metadata.json`, `extension.js`, `schemas/org.gnome.shell.extensions.sandman.gschema.xml`, `icons/sandman-symbolic.svg`, `install.sh`, `polkit/io.github.pmnelx.sandman.policy`
- Modify: `package.json` (add `pack` script), `.gitignore` (add `schemas/gschemas.compiled`, `*.shell-extension.zip`)

**Interfaces:**
- Produces: `SandmanExtension extends Extension` with `enable()` / `disable()`; schema keys `sleep-battery-timeout` (i, default 0), `sleep-ac-timeout` (i, 0), `hibernate-delay` (i, 0), `lid-action` (s, choices system|nothing|display|sleep|hibernate, default system), `keep-awake` (b, false), `saved-sleep-battery-type` (s, ""), `saved-sleep-ac-type` (s, ""), `adopted` (b, false). Integer ranges 0 to 604800.
- Produces: `install.sh` (user install) and `install.sh --system` (also installs helper and policy with sudo).

- [ ] **Step 1: Write `metadata.json`**

```json
{
  "uuid": "sandman@pmnelx.github.io",
  "name": "Sandman",
  "description": "Keep awake, lid close, screen off, lock, sleep and hibernate from the top bar.",
  "shell-version": ["48", "49", "50", "51"],
  "session-modes": ["user", "unlock-dialog"],
  "settings-schema": "org.gnome.shell.extensions.sandman",
  "url": "https://github.com/pmnelx/sandman",
  "version-name": "0.1.0"
}
```

- [ ] **Step 2: Write the schema with the keys in Interfaces**

Path `org/gnome/shell/extensions/sandman/`. Use `<choices>` for `lid-action` and `<range min="0" max="604800"/>` for the three timeouts.

- [ ] **Step 3: Write `extension.js` skeleton**

`SandmanExtension.enable()` creates a `PanelMenu.Button` with an `St.Icon` using a `Gio.FileIcon` for `icons/sandman-symbolic.svg` (`style_class: 'system-status-icon'`), adds it with `Main.panel.addToStatusArea(this.uuid, button)`, and sets `button.visible = !Main.sessionMode.isLocked`, updating on `Main.sessionMode.connect('updated')`. `disable()` destroys the button and disconnects. Task 7 replaces the button with `Indicator`.

- [ ] **Step 4: Draw `icons/sandman-symbolic.svg`**

16x16 symbolic SVG with plain filled paths (no classes): a crescent moon with two small "z" marks. Keep under 1 KB.

- [ ] **Step 5: Write `polkit/io.github.pmnelx.sandman.policy`**

Action id `io.github.pmnelx.sandman.configure-hibernate`, description "Change the Sandman hibernate delay", message "Authentication is required to change when the computer hibernates after sleep.", defaults `auth_admin_keep` for all three, annotation `org.freedesktop.policykit.exec.path` = `/usr/local/libexec/sandman-configure-hibernate`.

- [ ] **Step 6: Write `install.sh`**

Bash, `set -euo pipefail`. Copies `extension.js metadata.json lib icons schemas` to `~/.local/share/gnome-shell/extensions/sandman@pmnelx.github.io`, runs `glib-compile-schemas` on the target `schemas/`, then prints the enable command and the system step. With `--system`: `sudo install -D -o root -g root -m 0755 sandman-configure-hibernate /usr/local/libexec/sandman-configure-hibernate` and `sudo install -D -m 0644 polkit/io.github.pmnelx.sandman.policy /usr/share/polkit-1/actions/io.github.pmnelx.sandman.policy`.

- [ ] **Step 7: Add the pack script and gitignore**

`"pack": "gnome-extensions pack --force --extra-source=lib --extra-source=icons --extra-source=LICENSE"`.

- [ ] **Step 8: Verify in a nested shell**

Run: `./install.sh && gnome-extensions enable sandman@pmnelx.github.io` then `dbus-run-session -- gnome-shell --devkit` (GNOME 49+; `--nested` on 48).
Expected: the Zzz icon appears in the nested top bar; `journalctl --user -b -o cat` shows no Sandman errors. Also run `npm run pack` and expect a zip.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: extension skeleton, settings schema, icon, installer and polkit policy"
```

---

### Task 5: GNOME settings access

**Files:**
- Create: `lib/gnomeSettings.js`

**Interfaces:**
- Produces: `class GnomeSettings extends EventEmitter` (from `resource:///org/gnome/shell/misc/signals.js`):
  - `getScreenOff(): number`, `setScreenOff(seconds: number): void` (`org.gnome.desktop.session idle-delay`)
  - `getLock(): number` (a lock value per Task 2), `setLock(value: number): void` (`lock-enabled`, `lock-delay`)
  - `getSleep(source: "battery"|"ac"): {type: string, timeout: number}`, `setSleepType(source, type: string): void`
  - emits `"changed"` with the GNOME key name whenever any of the seven watched keys change
  - `destroy(): void`
- Setters apply `requestedSeconds`; on `-1` they throw `new Error("Ignored an invalid timeout")`.

- [ ] **Step 1: Implement `lib/gnomeSettings.js`**

Three `Gio.Settings` instances by `schema_id`. `setLock(value)`: `lockParts(value)`, write `lock-enabled` then `lock-delay` (u32). Guard writes with a `_suppress` flag so self-caused `changed` signals do not re-emit.

- [ ] **Step 2: Verify in the nested shell via Looking Glass**

In `dbus-run-session -- gnome-shell --devkit`, open Looking Glass (`lg` in the run dialog) and run:
```js
const m = await import('file:///home/pmn/.local/share/gnome-shell/extensions/sandman@pmnelx.github.io/lib/gnomeSettings.js'); const g = new m.GnomeSettings(); g.setScreenOff(600); g.getLock()
```
Expected: `gsettings get org.gnome.desktop.session idle-delay` prints `uint32 600`; `getLock()` returns `-1` on this machine (lock-enabled false). Restore with `g.setScreenOff(0)`.

- [ ] **Step 3: Commit**

```bash
git add lib/gnomeSettings.js
git commit -m "feat: GnomeSettings wrapper for idle, lock and gsd sleep keys"
```

---

### Task 6: Menu section components

**Files:**
- Create: `lib/ui/choiceSection.js`, `lib/ui/timerSection.js`

**Interfaces:**
- Produces: `ChoiceSection` (GObject subclass of `PopupMenu.PopupSubMenuMenuItem`):
  - `constructor({title: string, items: Array<{value: any, label: string}>})`
  - `setValue(value: any): void` (DOT on the match, NO_DOT elsewhere; title label becomes `${title}  ${label}`), `setItemSensitive(value, sensitive: boolean)`, `setNote(text: string|null)` (non-reactive dim row under the items, hidden when null), `setWarning(text|null)` (same, `style_class: 'sandman-warning'`)
  - signal `value-selected` with one `GObject.TYPE_JSOBJECT` param carrying a wrapper object `{value}` (GJS rejects primitive numbers and strings on a JSOBJECT param, verified on gjs 1.88); consumers destructure `(_section, {value}) => ...`
- Produces: `TimerSection extends ChoiceSection`:
  - `constructor({title, presets: number[], labelFor: (n) => string, seed: number})`; items are presets mapped through `labelFor` plus a trailing `{value: "custom", label: "Custom…"}`
  - `setValue(seconds)` opens the custom row (hours/minutes `St.Entry`, Apply `St.Button`) when `!isPreset(seconds, presets)`, seeded by `customSeed(seconds, seed)`; the Custom item takes the DOT then
  - Apply emits `value-selected` with `{value: customSeconds(hours, minutes)}` only when the seconds are > 0
  - `setCustomEnabled(enabled: boolean)`

- [ ] **Step 1: Implement `lib/ui/choiceSection.js`**

`GObject.registerClass({Signals: {'value-selected': {param_types: [GObject.TYPE_JSOBJECT]}}}, class ChoiceSection extends PopupMenu.PopupSubMenuMenuItem {...})`. Items are `PopupMenu.PopupMenuItem`; on `activate` emit and leave `setValue` to the owner. Note and warning rows are `PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false})` holding an `St.Label` with `clutter_text.line_wrap = true`.

- [ ] **Step 2: Implement `lib/ui/timerSection.js`**

Custom row: `PopupBaseMenuItem({reactive: false, can_focus: false})` with `St.Entry` x2 (`hint_text` "Hours"/"Minutes", `x_expand`) and `St.Button({label: "Apply", style_class: 'button'})`. Focus: on Custom activation, `GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { global.stage.set_key_focus(hoursEntry); return GLib.SOURCE_REMOVE; })`, source removed in `destroy`. Parse with `parseInt(entry.text, 10)`; `customSeconds` handles NaN.

- [ ] **Step 3: Add `stylesheet.css`**

`.sandman-warning { color: #f66151; }` plus `.sandman-custom-entry { width: 6em; }`. Add `stylesheet.css` to `install.sh`'s copy list and the pack script.

- [ ] **Step 4: Verify in the nested shell**

Temporarily add one `TimerSection` for sleep to the skeleton button's menu in `extension.js`, open it, click presets and a Custom value, confirm `value-selected` logs via `console.log`. Confirm typing in the entries works. Remove the temporary code before committing.

- [ ] **Step 5: Commit**

```bash
git add lib/ui stylesheet.css install.sh package.json
git commit -m "feat(ui): choice and timer popup sections with inline custom entry"
```

---

### Task 7: Indicator with screen off and lock wired to GNOME

**Files:**
- Create: `lib/indicator.js`
- Modify: `extension.js`

**Interfaces:**
- Produces: `Indicator` (GObject subclass of `PanelMenu.Button`), `constructor({path: string})` where `path` is the extension directory; properties `keepAwakeSwitch` (`PopupSwitchMenuItem`, label "Keep awake"), `lidSection`, `screenOffSection`, `lockSection`, `sleepBatterySection`, `sleepAcSection`, `hibernateSection`, `errorRow`; methods `setError(text|null)`, `setKeepAwakeBadge(on: boolean)`, `refreshWarnings(state)` (calls `warnings` from model and distributes: lock warning to `lockSection`, sleep warnings to their sections, hibernate warning to `hibernateSection`).
- Section titles: "Lid close", "Screen off", "Lock after screen off", "Sleep on battery", "Sleep plugged in", "Hibernate after sleep".
- `extension.js` owns a `GnomeSettings` instance and binds screen off and lock: `value-selected` → setter inside try/catch → `setError(error.message)` on failure, `setError(null)` on success; `changed` → `setValue` from getters.

- [ ] **Step 1: Implement `lib/indicator.js`**

Build order per spec 4.1. Lid section hidden by default (`lidSection.visible = false`). `lockSection` is a `TimerSection` with `presets: lockPresets`, `labelFor: formatLockValue`, `seed: customSeeds.lock`. The error row is a non-reactive item with `style_class: 'sandman-warning'`, hidden when null.

- [ ] **Step 2: Wire screen off and lock in `extension.js`**

Replace the skeleton button with `Indicator`. Initial `setValue` from `GnomeSettings` getters. `refreshWarnings` after every change with sleep values from `this._settings` (the extension's `getSettings()`) and hibernate from the same.

- [ ] **Step 3: Verify**

Nested shell: pick Screen off 5 min, then `gsettings get org.gnome.desktop.session idle-delay` → `uint32 300`. Pick Lock "Immediately" → `lock-enabled true`, `lock-delay uint32 0`. Pick Lock Off → `lock-enabled false`. Run `gsettings set org.gnome.desktop.session idle-delay 120` externally → menu shows Screen off 2 min. Set screen off Off → lock section shows "Lock cannot fire while screen off is Off." Restore original values (`idle-delay 0`, `lock-enabled false`).

- [ ] **Step 4: Commit**

```bash
git add lib/indicator.js extension.js
git commit -m "feat: indicator popup with screen off and lock bound to GNOME settings"
```

---

### Task 8: Keep awake

**Files:**
- Create: `lib/keepAwake.js`
- Modify: `extension.js`

**Interfaces:**
- Produces: `class KeepAwake extends EventEmitter`; `constructor(settings: Gio.Settings)`; `get active(): boolean`; `async setActive(on: boolean): Promise<void>` (calls `org.gnome.SessionManager.Inhibit("sandman@pmnelx.github.io", 0, "Keep awake", 12)` / `Uninhibit(cookie)`, then writes `keep-awake`); `restore(): void` (re-inhibits when `keep-awake` is true at enable); `destroy(): void` (uninhibit without writing the key); emits `"changed"`.

- [ ] **Step 1: Implement `lib/keepAwake.js`**

Use `Gio.DBus.session.call(...)` with `GLib.Variant('(susu)', [...])`; reply type `(u)`. Errors reject with `new Error("Could not change keep awake")`.

- [ ] **Step 2: Wire in `extension.js`**

`keepAwakeSwitch.connect('toggled', ...)` → `setActive`; on `"changed"` set switch state and `setKeepAwakeBadge`. Call `restore()` in `enable()`, `destroy()` in `disable()`.

- [ ] **Step 3: Verify**

Nested shell: toggle on, then `gnome-session-inhibit --list` shows `sandman@pmnelx.github.io` with idle and suspend. Toggle off, entry gone. Toggle on, disable the extension via `gnome-extensions disable`, entry gone, `dconf read /org/gnome/shell/extensions/sandman/keep-awake` is `true`.

- [ ] **Step 4: Commit**

```bash
git add lib/keepAwake.js extension.js
git commit -m "feat: keep awake switch holding a session inhibitor"
```

---

### Task 9: Sleep service

**Files:**
- Create: `lib/power.js`, `lib/sleepService.js`
- Modify: `extension.js`

**Interfaces:**
- Produces `lib/power.js`:
  - `async canOperation(name: "CanHibernate"|"CanSuspendThenHibernate"): Promise<string>` (logind Manager, returns the string, `"na"` on D-Bus error)
  - `async powerAction(method: "Suspend"|"SuspendThenHibernate"|"Hibernate"): Promise<void>` (logind, arg `(b)` false)
  - `async isInhibited(flags: number): Promise<boolean>` (`org.gnome.SessionManager.IsInhibited`)
  - `async sessionIsActive(): Promise<boolean>` (via `LoginManager.getLoginManager().getCurrentSessionProxy()` `Active`; true if unavailable)
  - `hasRemovableGpu(): boolean` (reads `/sys/class/drm/card*/device/removable` with `Gio.File`, feeds `parseRemovableGpus`)
  - `readTextOrNull(path: string): string|null`
  - `async inhibitLidSwitch(reason: string): Promise<{close(): void}>` (`Inhibit("handle-lid-switch","Sandman",reason,"block")` via `call_with_unix_fd_list`, fd wrapped in `Gio.UnixInputStream({fd, close_fd: true})`)
- Produces `lib/sleepService.js`: `class SleepService extends EventEmitter`; `constructor({settings, gnome})`; `enable(): void` (adopt if `!adopted`, save and override gsd types, watch UPower `OnBattery`, arm); `disable(): void` (restore gsd types, unwatch, disarm; synchronous); `setTimeout(source, seconds)` (validates, writes key, re-arm); `getTimeout(source): number`; emits `"error"` with a message and `"changed"`.
- Error copy: `"Sleep was blocked by the system or an application"`, `"Suspend then hibernate was blocked or unavailable"`.

- [ ] **Step 1: Implement `lib/power.js`**

- [ ] **Step 2: Implement `lib/sleepService.js`**

Arming: `const ms = pickSleepTimeout(onBattery, battery, ac) * 1000`; if 0 disarm; else `this._watchId = monitor.add_idle_watch(ms, () => this._onIdle())` where `monitor = global.backend.get_core_idle_monitor()`. `_onIdle`: `if (!await sessionIsActive()) return rearm; if (await isInhibited(12)) { subscribe to SessionManager signal "InhibitorRemoved"; on each: if (!await isInhibited(12)) { unsubscribe; monitor.get_idletime() >= ms ? this._sleepNow() : rearm } ; return }` else `_sleepNow`. `_sleepNow`: `powerAction(sleepMethod(hibernateDelay, hasRemovableGpu()))`, catching errors into `"error"`, then rearm. Adoption: for each source, `settings.set_int(key, adoptedSleepTimeout(type, timeout))`; then `saved-*-type = type`, `setSleepType(source, "nothing")`, `adopted = true`. On gsd `changed` where a type becomes not `nothing`: adopt that source's timeout and set type back to `nothing`. `disable()`: `setSleepType(source, saved)` for each saved type that is non-empty.

- [ ] **Step 3: Wire in `extension.js`**

Bind `sleepBatterySection` / `sleepAcSection` to `setTimeout("battery"|"ac", v)`; refresh values and warnings on `"changed"`; `"error"` → `setError`.

- [ ] **Step 4: Verify (real session, log out/in after `./install.sh`)**

1. Before enabling: note `gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type` and `-ac-type`. After enabling: both `'nothing'`; `dconf read /org/gnome/shell/extensions/sandman/sleep-battery-timeout` equals the old battery timeout when the old type was `suspend`, else 0; ac likewise.
2. Set the current source's sleep to Custom 0h01m, leave the machine idle: it suspends within about a minute. Wake it.
3. Keep awake on, same wait: no suspend.
4. `gnome-session-inhibit --inhibit idle sleep 90` then idle: no suspend during the 90 s, suspend shortly after it exits.
5. `gnome-extensions disable sandman@pmnelx.github.io`: gsd types restored to the noted values.
Restore your sleep values afterwards.

- [ ] **Step 5: Commit**

```bash
git add lib/power.js lib/sleepService.js extension.js
git commit -m "feat: Sandman-owned sleep timer with adoption, inhibitor wait and power source"
```

---

### Task 10: Hibernate after sleep

**Files:**
- Create: `lib/hibernateService.js`
- Modify: `extension.js`, `README.md` (install section only, rest in Task 13)

**Interfaces:**
- Produces: `class HibernateService extends EventEmitter`; `constructor(settings)`; `async enable(): Promise<void>` (queries `canOperation` for both names; when `CanSuspendThenHibernate !== "yes"` runs `diagnoseHibernate` on files read with `readTextOrNull` and `Gio.File.new_for_path("/sys/firmware/efi").query_exists(null)`); `available: boolean`; `canHibernate: boolean`; `diagnosis: string`; `getDelay(): number`; `async setDelay(seconds): Promise<void>`; emits `"changed"`, `"error"`.
- `HELPER_PATH = "/usr/local/libexec/sandman-configure-hibernate"`.
- Copy: unavailable row `"Suspend then hibernate is not available on this computer. " + diagnosis`; note row `"Changing this delay requires administrator authorization."`; error `"Could not change the system hibernate delay"`.

- [ ] **Step 1: Implement `lib/hibernateService.js`**

`setDelay`: `requestedSeconds` check; if `seconds > 0 && !available` throw the error; `Gio.Subprocess.new(["pkexec", HELPER_PATH, "configure-hibernate", String(seconds)], Gio.SubprocessFlags.NONE)` then `wait_check_async`; only on success `settings.set_int("hibernate-delay", seconds)`.

- [ ] **Step 2: Wire in `extension.js`**

`hibernateSection.setValue(getDelay())`; `setItemSensitive(v, available || v === 0)` for each preset and `setCustomEnabled(available)`; `setNote` with the unavailable copy when `!available`, else the authorization copy when delay > 0. Lid Hibernate sensitivity uses `canHibernate` (Task 11).

- [ ] **Step 3: Verify**

Real session on this laptop: the hibernate submenu shows every positive preset insensitive and the note containing "Kernel lockdown integrity mode blocks hibernation; this is usually Secure Boot." Choose Off (the helper still runs, to remove the drop-in). A pkexec dialog appears; cancel it, and the error row reads "Could not change the system hibernate delay" with `hibernate-delay` unchanged. Run `./install.sh --system`, choose Off again, authenticate, no error, `/etc/systemd/sleep.conf.d/90-sandman.conf` absent. `python3 -m unittest discover -s test -p 'test_*.py'` still passes.

- [ ] **Step 4: Commit**

```bash
git add lib/hibernateService.js extension.js
git commit -m "feat: hibernate-after-sleep delay via pkexec helper with availability diagnosis"
```

---

### Task 11: Lid service

**Files:**
- Create: `lib/lidService.js`
- Modify: `extension.js`

**Interfaces:**
- Produces: `class LidService extends EventEmitter`; `constructor({settings, keepAwake, hibernate})`; `async enable(): Promise<void>` (UPower `LidIsPresent` via `Gio.DBusProxy` on `/org/freedesktop/UPower`; logind Manager proxy watching `LidClosed` with `g-properties-changed`; applies the stored action); `disable(): void` (release inhibitor, display on if Sandman turned it off, disconnect; synchronous); `lidPresent: boolean`; `getAction(): string`; `async setAction(action: string): Promise<void>` (`normalizedLidAction`; unknown → error `"Ignored an invalid lid action"`); emits `"changed"`, `"error"`.
- Behaviour per spec 4.4. Display off uses `org.gnome.Mutter.DisplayConfig` properties `PowerSaveMode` (set 3 = off, 0 = on) and `HasExternalMonitor`.
- Error copy: `"Could not monitor laptop lid events"`, `"Hibernate is not available on this computer"`.

- [ ] **Step 1: Verify Mutter's own behaviour first**

With the extension holding a `handle-lid-switch` inhibitor (run `systemd-inhibit --what=handle-lid-switch --mode=block sleep 300` as a stand-in), close the lid on battery with no external monitor for 10 s. Record whether the panel went dark. If it did, "Display off" needs no `PowerSaveMode` write; note the result in a code comment and skip that write.

- [ ] **Step 2: Implement `lib/lidService.js`**

State machine from upstream `LidService.qml` (tag `omarchy-final`): record the first `LidClosed` value without acting; on later `false → true` run the action; on `true → false` turn the display back on if Sandman turned it off. Debounce property changes by 25 ms with `GLib.timeout_add`. Inhibitor held iff action is not `system` and `lidPresent`. Changing the action while closed runs the new action at once. Sleep/Hibernate actions return early while `keepAwake.active`. Sleep uses `sleepMethod(hibernate.getDelay(), hasRemovableGpu())`.

- [ ] **Step 3: Wire in `extension.js`**

`lidSection.visible = lidPresent` (`lidPresent` is false when UPower or the property is missing); items from `lidActions` with `lidActionLabel`; `setItemSensitive("hibernate", hibernate.canHibernate)`.

- [ ] **Step 4: Verify**

Real session: `systemd-inhibit --list | grep Sandman` is empty on System default, present on Do nothing. Do nothing, close lid 10 s, open: machine still awake. Sleep, close lid: machine suspends. Back to System default: inhibitor gone. Unplug the external monitor (or confirm `HasExternalMonitor` false) before the sleep test, because GNOME blocks lid suspend when docked.

- [ ] **Step 5: Commit**

```bash
git add lib/lidService.js extension.js
git commit -m "feat: lid-close actions with a logind lid-switch inhibitor"
```

---

### Task 12: Lock-screen mode and teardown audit

**Files:**
- Modify: `extension.js`, any service with a leak

- [ ] **Step 1: Audit `disable()`**

Checklist, each confirmed by reading the code: idle watch removed; `InhibitorRemoved` subscription removed; UPower and logind proxies' signal handlers disconnected; lid inhibitor closed; display power restored; keep-awake uninhibited; gsd sleep types restored; all `GLib.timeout_add` sources removed; indicator destroyed; `sessionMode` handler disconnected. `disable()` contains no `await`.

- [ ] **Step 2: Verify lock-screen behaviour**

Set sleep for the current source to 0h01m, lock the screen (Super+L), wait: the machine suspends while locked. After unlocking, indicator visible; on the lock screen it was not (`visible = !Main.sessionMode.isLocked`).

- [ ] **Step 3: Verify enable/disable cycling**

`gnome-extensions disable` then `enable` three times; `journalctl --user -b -o cat | grep -i sandman` shows no errors; `systemd-inhibit --list` and `gnome-session-inhibit --list` show no stale Sandman entries after the final disable.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: complete teardown and lock-screen session mode"
```

---

### Task 13: README, license line, release prep

**Files:**
- Modify: `README.md`, `LICENSE`
- Create: `preview.png` (screenshot of the open popup)

- [ ] **Step 1: Rewrite `README.md`**

Sections: what it is (one paragraph), screenshot, Controls (the seven, one line each, including that lock delay counts from screen off and that sleep is Sandman's own timer), Install (`./install.sh`, log out/in, `gnome-extensions enable`, then `./install.sh --system` for hibernate), How sleep and hibernate work (inhibitor wait, eGPU rule, Automatic Suspend forced Off while enabled and restored on disable), Lid close (inhibitor, GNOME blocks lid suspend when docked, keep awake does not stop System default), Hibernate prerequisites (Secure Boot lockdown, swap, resume), Requirements (GNOME 48 to 51 on Wayland, systemd, UPower, polkit), Development (`npm test`, `npm run pack`, nested shell command), Credits (forked from lgse/sandman for Omarchy, tag `omarchy-final`).

- [ ] **Step 2: Add Paul's copyright line to `LICENSE`**

Below the existing line add `Copyright (c) 2026 pmnelx (GNOME port)`, replacing `pmnelx` with the full name if Paul supplies one.

- [ ] **Step 3: Screenshot**

Open the popup in the real session, `gnome-screenshot -w` or the Screenshot UI, save as `preview.png`.

- [ ] **Step 4: Final checks**

Run: `npm test && npm run pack`
Expected: green, zip produced.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "docs: README and license for the GNOME port"
git push -u origin gnome-port
gh pr create --title "GNOME Shell port" --body-file - <<'EOF'
Replaces the Omarchy Quattro plugin with a GNOME Shell extension (48-51).
Design: docs/superpowers/specs/2026-10-16-gnome-port-design.md
Plan: docs/superpowers/plans/2026-10-16-gnome-port.md
Last Omarchy commit tagged omarchy-final.
EOF
```
