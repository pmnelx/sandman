// Pure hibernate diagnostics. Callers read the kernel files and pass contents
// in (null when unreadable); nothing here touches the filesystem.

export function diagnoseHibernate(files) {
  var issues = []

  var kernelHibernate = typeof files.powerState === "string"
    && files.powerState.split(/\s+/).indexOf("disk") >= 0
  if (!kernelHibernate)
    issues.push("The kernel does not advertise hibernation support.")

  if (typeof files.powerDisk === "string" && files.powerDisk.indexOf("[disabled]") >= 0)
    issues.push("Hibernation is disabled by the kernel (/sys/power/disk).")

  var memoryKiB = 0
  if (typeof files.meminfo === "string") {
    var lines = files.meminfo.split("\n")
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("MemTotal:") === 0) {
        var value = parseInt(lines[i].split(/\s+/)[1], 10)
        if (isFinite(value)) memoryKiB = value
        break
      }
    }
  }

  var swapKiB = 0
  if (typeof files.swaps === "string") {
    var swapLines = files.swaps.split("\n").slice(1)
    for (var j = 0; j < swapLines.length; j++) {
      var fields = swapLines[j].split(/\s+/).filter(Boolean)
      if (fields.length >= 3 && fields[0].indexOf("/dev/zram") !== 0) {
        var size = parseInt(fields[2], 10)
        if (isFinite(size)) swapKiB += size
      }
    }
  }
  if (swapKiB === 0) {
    issues.push("No disk-backed swap is active. Configure a swap file or partition "
      + "large enough for hibernation; zram alone cannot store the image.")
  } else if (memoryKiB && swapKiB < memoryKiB) {
    issues.push("Disk-backed swap is smaller than RAM. Hibernation may need a larger "
      + "swap area when memory use is high.")
  }

  var resume = typeof files.resume === "string" ? files.resume.trim() : ""
  var resumeConfigured = resume !== "" && resume !== "0:0"
  if (!resumeConfigured && !files.efiPresent)
    issues.push("No kernel resume device is configured and EFI resume discovery is unavailable.")

  var lockdownMode = "unknown"
  if (typeof files.lockdown === "string") {
    var selected = /\[([^\]]+)\]/.exec(files.lockdown)
    lockdownMode = selected ? selected[1] : (files.lockdown.trim() || "unknown")
  }
  if (lockdownMode === "integrity")
    issues.push("Kernel lockdown integrity mode blocks hibernation; this is usually Secure Boot.")
  else if (lockdownMode === "confidentiality")
    issues.push("Kernel lockdown confidentiality mode can prevent hibernation.")

  if (issues.length === 0) {
    issues.push("The basic checks passed, but logind still reports hibernation as unavailable. "
      + "Check system logs and firmware support.")
  }

  return { issues: issues, summary: issues.join(" "), lockdownMode: lockdownMode }
}

export function parseRemovableGpus(entries) {
  return entries
    .filter(function (entry) {
      return typeof entry.removable === "string" && entry.removable.trim() === "removable"
    })
    .map(function (entry) { return entry.card })
}
