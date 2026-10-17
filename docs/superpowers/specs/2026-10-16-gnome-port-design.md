# Sandman for GNOME: port design

Date: 2026-10-16. Approved by Paul before implementation.

## 1. Context and intent

Paul forked lgse/sandman, an Omarchy bar plugin (Quickshell QML + Hyprland
+ Python helper), to pmnelx/sandman. He wants the same single panel on
Ubuntu GNOME: lid-close action, sleep, hibernate after sleep, keep awake,
all reachable from the top bar. GNOME scatters these across Settings,
Tweaks, logind.conf and third-party extensions and has no UI at all for
hibernate-after-sleep or (on Ubuntu) lid actions.

Decided with Paul: GNOME Shell extension in GJS; replace the Omarchy code
in place on `main`; declare shell-version 48, 49, 50, 51; separate
battery and plugged-in sleep timers.

## 2. Goals, non-goals, anti-goals

Goals
- One top-bar Zzz indicator opening a popup with every control: keep
  awake, lid close, screen off, lock, sleep on battery, sleep plugged in,
  hibernate-after-sleep delay.
- Presets plus Custom hours/minutes and Off everywhere, as upstream.
- Use GNOME's own settings wherever GNOME enforces them, so Settings and
  Sandman agree, and adopt existing values on first run (nothing changes
  just by enabling the extension).
- Installable by hand today; shaped for extensions.gnome.org later.

Non-goals
- A separate "screen saver" stage (on GNOME blank and screensaver are one).
- Separate AC/battery values for anything other than sleep.
- X11, GNOME older than 48, a GTK preferences window (this version).

Anti-goals
- Silent weakening: malformed input must never turn lock Off, and
  enabling Sandman must never remove an auto-suspend the user had.
- Fighting GNOME: no patched shell files, no replaced systemd units, no
  double-handling of one idle event by GNOME and Sandman.
- Running anything from the user-writable extension directory as root.

## 3. Verified facts that shape the design

Machine: laptop, Ubuntu 26.04.1, GNOME Shell 50.1, Wayland, systemd 259,
UPower 1.91.1. GNOME 51 shipped 2026-09-16. Facts checked against GNOME
source at tags 48.0 to 51.1 and local man pages:

- F1. Ubuntu's `lid-close-*-action` gsettings keys are schema-only;
  gsd-power never reads them. Sandman handles the lid itself, as upstream
  did: hold a logind `handle-lid-switch` block inhibitor (polkit allows it
  for active sessions) and watch logind's `LidClosed` property.
- F2. With an external monitor attached, gsd-power holds its own
  `handle-lid-switch` inhibitor and Mutter switches the built-in panel
  off. Docked laptops never suspend on lid close regardless of logind.conf.
- F3. No GNOME component in 48 to 51 calls logind `Sleep()`, so
  `SleepOperation=` cannot make GNOME's idle suspend hibernate afterwards.
  Hibernate-after-sleep needs Sandman's own idle timer calling
  `SuspendThenHibernate`, as upstream did.
- F4. Extensions are disabled on the lock screen unless metadata declares
  `session-modes: ["user", "unlock-dialog"]`. Sandman's timers and lid
  handling must keep running while locked.
- F5. GNOME's lock delay counts from screen-off ("Time from screen blank
  to screen lock"). With screen off Never, GNOME never idles, so lock
  never fires.
- F6. A session idle inhibitor (flag 8) pauses GNOME's blank, lock and
  suspend; logind ignores it on lid close (`LidSwitchIgnoreInhibited=yes`).
- F7. extensions.gnome.org: privileged helpers only via pkexec and never
  user-writable. Same shape as upstream's `/usr/local/libexec` helper.
- F8. Paul's laptop cannot hibernate today: Secure Boot lockdown
  (`integrity`), `/sys/power/disk` = `[disabled]`, 8 GB swap vs ~30 GB
  RAM, logind reports `na`. The control will show unavailable with why.
- F9. UPower 1.91.1 exposes `LidIsPresent` and `OnBattery` on
  `/org/freedesktop/UPower`.
- F10. GNOME 51 breaks: St `vertical` removed (use `orientation`),
  `makeProxyWrapper` returns a class (use `new`), `disable()` must stay
  synchronous.
- F11. Ubuntu default gsd values: battery suspend after 1200 s, AC
  `nothing` (3600 s stored).

## 4. Design

### 4.1 Indicator and popup

Extension UUID `sandman@pmnelx.github.io`. A `PanelMenu.Button` with a
bundled symbolic Zzz icon. Popup, top to bottom:

1. Keep awake (switch). Holds `org.gnome.SessionManager.Inhibit` with
   flags idle+suspend (12). Persisted. Indicator shows a small badge when on.
2. Lid close (submenu, only when `LidIsPresent`): System default / Do
   nothing / Display off / Sleep / Hibernate. Hibernate enabled only when
   logind `CanHibernate` is `yes`.
3. Screen off (submenu): Off, 1, 2, 5, 10, 15, 30 min, Custom. Writes
   `org.gnome.desktop.session idle-delay`.
4. Lock after screen off (submenu): Immediately, 30 s, 1, 2, 5, 15, 30,
   60 min, Off, Custom. Writes `org.gnome.desktop.screensaver
   lock-enabled` + `lock-delay`. GNOME semantics (F5). Warning row when
   screen off is Off.
5. Sleep on battery (submenu): Off, 15, 30, 60, 120 min, Custom.
6. Sleep plugged in (submenu): same presets.
   Both owned by Sandman's idle timer (4.3), counted from idle start.
   Warning when a sleep value is set but screen off is Off? No: GNOME
   idle is independent of our timer. Keep upstream's "Sleep is set before
   the screen turns off" warning instead.
7. Hibernate after sleep (submenu): Off, 30 min, 1, 2, 4, 8 h, Custom.
   Positive values enabled only when `CanSuspendThenHibernate` is `yes`;
   Off always. When unavailable, a non-reactive row shows the diagnosis.
   Warning when hibernate > 0 and both sleep values are Off. Note row:
   "Changing this delay requires administrator authorization."
8. Error row showing the last error, cleared on next success.

Timer submenus: presets as radio items (`Ornament.DOT`/`NO_DOT`) plus
"Custom…". Custom reveals an inline row with two `St.Entry` fields
(hours 0-24, minutes 0-59) and Apply, seeded as upstream (current value,
or 5 / 15 / 60 min when Off). Presets apply immediately; a value matching
no preset opens as Custom. Submenu titles show the current value.

### 4.2 Settings and persistence

Schema `org.gnome.shell.extensions.sandman`:
`sleep-battery-timeout` (i), `sleep-ac-timeout` (i), `hibernate-delay`
(i), `lid-action` (s), `keep-awake` (b), `saved-sleep-battery-type` (s),
`saved-sleep-ac-type` (s), `adopted` (b).

First enable (`adopted` false): copy gsd's `sleep-inactive-{battery,ac}-
timeout` into the two sleep keys where the matching `-type` is `suspend`,
else 0. Then set `adopted`. Nothing changes behaviourally on first run.

GNOME-owned keys read, written and watched for external changes:
`idle-delay`, `lock-enabled`, `lock-delay`, and the four gsd sleep keys.

Validation from upstream `Model.js`: `requestedSeconds` rejects bad input
(never coerces to Off), `normalizedSeconds` clamps persisted values,
7-day maximum (keeps idle-watch milliseconds under 2^31). Omarchy's
"7-day means Off" trick is dropped.

### 4.3 Sleep and hibernate-after-sleep

Sandman owns automatic sleep (F3). While enabled it sets both gsd
`sleep-inactive-*-type` keys to `nothing`, remembering the previous values,
and restores them in `disable()`. If the user later sets Automatic Suspend
in Settings, Sandman adopts that timeout into the matching sleep key and
sets the type back to `nothing`.
Re-enable adoption: `disable()` records the gsd type and timeout it left
(`restored-sleep-*-type`/`-timeout`, timeout also in
`saved-sleep-*-timeout`), and the next `enable()` adopts the gsd timeout
where that pair has changed and the type is now `suspend`, so an Automatic
Suspend set while Sandman was off survives.

Active timeout = battery or AC value by UPower `OnBattery`; re-arm when it
changes. Timer: `global.backend.get_core_idle_monitor().add_idle_watch(ms,
cb)`. On fire:
- Skip if the logind session is not active (fast user switch guard).
- If `org.gnome.SessionManager.IsInhibited(12)` is true, wait: subscribe
  to `InhibitorRemoved`, and when no longer inhibited compare
  `get_idletime()` with the timeout, suspending at once if exceeded,
  otherwise re-arming. (gsd behaviour; a finished video still sleeps.)
- Else call logind `SuspendThenHibernate(false)` when hibernate > 0 and
  no removable GPU (`/sys/class/drm/card*/device/removable`), else
  `Suspend(false)`. logind block inhibitors still apply.
Runs in `unlock-dialog` mode too (F4), indicator hidden there.

Hibernate delay: `pkexec /usr/local/libexec/sandman-configure-hibernate
configure-hibernate <seconds>` writes
`/etc/systemd/sleep.conf.d/90-sandman.conf` or deletes it for 0. Persist
`hibernate-delay` only on exit 0. Helper reused verbatim; add a polkit
`.policy` (action `io.github.pmnelx.sandman.configure-hibernate`) so the
auth dialog names Sandman.

Diagnostics when unavailable, ported to GJS with parsing in a pure module:
`/sys/power/state` lacks `disk`; `/sys/power/disk` is `[disabled]`; kernel
lockdown `integrity` or `confidentiality` (Paul's blocker); no non-zram
swap; swap smaller than RAM; no resume device and no EFI.

### 4.4 Lid close

Ported from upstream `LidService.qml` using D-Bus:
- Presence: UPower `LidIsPresent`. State: logind `LidClosed` change
  signals. First observed state recorded, not acted on.
- System default: no inhibitor; logind.conf governs (F2 when docked).
- Managed actions hold logind `Inhibit("handle-lid-switch", "Sandman",
  reason, "block")` via `call_with_unix_fd_list`; released on System
  default and in `disable()`.
- Do nothing: inhibitor only.
- Display off: with an external monitor, nothing extra (Mutter handles
  it, F2). Otherwise Mutter power-save OFF on close, ON on open. Builder
  verifies Mutter's behaviour with our inhibitor held first.
- Sleep: `SuspendThenHibernate` when hibernate > 0 and no eGPU, else
  `Suspend`. Hibernate: `Hibernate`. Lid actions run regardless of keep awake.
- Changing the action while closed applies it immediately.

### 4.5 Repository after the port

Removed: all `.qml`, `bridge/`, `manifest.json`, `sandman.py`,
`preview*.png`, `test/test_helper.py`. Kept: `LICENSE` (upstream line
kept, Paul's added), `sandman-configure-hibernate`,
`test/test_configure_hibernate.py`.

```
extension.js                 Extension class wiring services + indicator
metadata.json                uuid, shell-version 48-51, session-modes, settings-schema
schemas/org.gnome.shell.extensions.sandman.gschema.xml
lib/model.js                 ESM port of Model.js
lib/diagnostics.js           pure parsers (swap, meminfo, lockdown, power files)
lib/gnomeSettings.js         GNOME key access + external-change watching + adoption
lib/sleepService.js          idle watch, inhibitor wait, power source, suspend calls
lib/lidService.js            UPower/logind lid, inhibitor, actions
lib/keepAwake.js             SessionManager inhibit
lib/indicator.js             PanelMenu.Button + popup
lib/ui/timerSection.js       preset radio submenu + custom row
lib/ui/choiceSection.js      lid submenu
icons/sandman-symbolic.svg
polkit/io.github.pmnelx.sandman.policy
sandman-configure-hibernate
install.sh                   user install; optional sudo helper + policy step
package.json                 "type": "module"; scripts: test, pack
test/model.test.js, test/diagnostics.test.js, test/test_configure_hibernate.py
README.md                    rewritten for GNOME
```

## 5. Calls I made (vetoable)

- GNOME-style lock semantics (delay after screen off).
- Sandman always owns automatic sleep; GNOME Automatic Suspend forced Off
  while enabled, restored on disable, values adopted on first run.
- Inhibited sleep waits for inhibitor release, then sleeps if already
  past the timeout.
- Sandman-managed lid actions always run, even while keep awake is on.
- One screen-off control replaces upstream's screensaver + displays-off.
- Custom entry inline in the popup; no prefs window.
- UUID `sandman@pmnelx.github.io`; polkit action id as above.
- Diagnostics in GJS, not Python.
- Tag the last Omarchy commit `omarchy-final` before deleting its files.

## 6. Left to the builder

- Custom-row focus handling (Clipboard Indicator pattern).
- Icon artwork.
- Debounce on `LidClosed` (upstream used 25 ms).
- External-monitor detection (Mutter DisplayConfig `HasExternalMonitor`
  or monitor count).
- install.sh ergonomics; whether `gnome-extensions pack` output is kept
  in the repo (no).

## 7. Things Paul should know

- Hibernate stays unavailable on this laptop until Secure Boot lockdown
  and swap size are addressed (F8). The control will say why.
- Docked with an external monitor, GNOME itself blocks lid-close suspend
  (F2).
- Reloading extension code on Wayland needs log out/in or the nested
  devkit session.

## 8. Build sequence (detailed task plan follows via writing-plans)

1. Spec commit + `omarchy-final` tag. Branch `gnome-port`.
2. Repo reshape: delete Omarchy files, `package.json` type module, move
   `Model.js` to `lib/model.js` as ESM, rewrite `test/model.test.js` with
   `import`, add `customParts`/`customSeconds`/`isPreset` tests. Tests green.
3. `lib/diagnostics.js` + tests (string in, issues out), including the
   `[disabled]` and `integrity` cases from Paul's machine.
4. Schema, metadata, `extension.js` skeleton, icon, `install.sh`. Enable in
   devkit nested shell; empty indicator appears.
5. `lib/gnomeSettings.js`: screen off + lock, adoption, external-change
   watching. Timer submenu component. Verify with `gsettings get`.
6. `lib/keepAwake.js` + switch. Verify with `gnome-session-inhibit --list`.
7. `lib/sleepService.js`: two sleep submenus, gsd type takeover/restore,
   idle watch, inhibitor wait, power source switch. Verify 1-minute sleep.
8. Hibernate: pkexec call, polkit policy, availability gating, diagnosis
   row. Verify unavailable path on this machine; verify helper via tests.
9. `lib/lidService.js` + lid submenu. Verify inhibitor in
   `systemd-inhibit --list`, Do nothing and Sleep with the lid.
10. `session-modes` unlock-dialog behaviour; `disable()` cleanup audit.
11. README, LICENSE line, screenshots, version 0.1.0. PR to `main`.

## Verification

- `npm test` green (model, diagnostics, helper).
- `./install.sh`; after re-login the indicator appears; journal
  (`journalctl -f -o cat /usr/bin/gnome-shell`) shows no errors.
- First enable changes no GNOME behaviour: `gsettings get` for the four
  gsd sleep keys shows types `nothing` and Sandman's keys hold the
  previous timeouts.
- Each preset and one Custom value per control, checked with
  `gsettings get` / `dconf read`.
- Sleep: 1-minute custom on the current power source suspends; not with
  keep awake on; not with a video playing, but does after it ends.
- Unplug/plug switches which timeout is armed.
- Lid: Do nothing keeps the machine on; Sleep suspends; System default
  shows no Sandman entry in `systemd-inhibit --list`.
- Lock screen: sleep timer still fires while locked (F4).
- Hibernate: unavailable here with the lockdown reason; Off still writable.
- `gnome-extensions disable sandman@pmnelx.github.io` restores gsd types
  and releases all inhibitors.
