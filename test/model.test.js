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
