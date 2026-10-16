import assert from "node:assert/strict";
import test from "node:test";
import * as model from "../lib/model.js";

test("lid actions are normalized and labelled", () => {
  assert.equal(model.normalizedLidAction("display"), "display");
  assert.equal(model.normalizedLidAction("invalid"), "system");
  assert.equal(model.lidActionLabel("nothing"), "Do nothing");
  assert.equal(model.lidActionLabel("system"), "System default");
});

test("formatDuration produces compact labels", () => {
  assert.equal(model.formatDuration(0), "Off");
  assert.equal(model.formatDuration(300), "5 min");
  assert.equal(model.formatDuration(3600), "1 hour");
  assert.equal(model.formatDuration(7200), "2 hours");
});

test("requestedSeconds rejects unusable values instead of coercing to Off", () => {
  assert.equal(model.requestedSeconds(-5), -1);
  assert.equal(model.requestedSeconds("nonsense"), -1);
  assert.equal(model.requestedSeconds(Infinity), -1);
  // 0 is only ever Off when the caller asks for it explicitly.
  assert.equal(model.requestedSeconds(0), 0);
  assert.equal(model.requestedSeconds(900), 900);
});

test("requestedSeconds rejects oversized values rather than clamping them", () => {
  // Clamping would turn an absurd setLock into a seven-day timeout, the same
  // silent weakening this guard exists to prevent. Reject, as the CLI does.
  assert.equal(model.requestedSeconds(2000000000), -1);
  assert.equal(model.requestedSeconds(model.maxTimeoutSeconds + 1), -1);
  assert.equal(model.requestedSeconds(model.maxTimeoutSeconds), model.maxTimeoutSeconds);
});

test("normalizedSeconds clamps persisted values below the 32-bit overflow", () => {
  // A config written before the bounds existed has no caller to reject to.
  assert.equal(model.normalizedSeconds(2000000000, 0, true), model.maxTimeoutSeconds);
  assert.ok(model.maxTimeoutSeconds * 1000 < 2147483647);
});

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
