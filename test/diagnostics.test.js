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
