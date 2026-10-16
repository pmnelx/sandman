export const lockPresets = [0, 300, 600, 900, 1800, 3600]
export const sleepPresets = [0, 900, 1800, 3600, 7200]
export const hibernatePresets = [0, 1800, 3600, 7200, 14400, 28800]
export const lidActions = ["system", "nothing", "display", "sleep", "hibernate"]

export const maxTimeoutSeconds = 7 * 24 * 60 * 60

// Validate a caller-supplied timeout, including one arriving over IPC.
// Returns whole seconds in [0, maxTimeoutSeconds], or -1 when the value is
// unusable. Callers must treat -1 as "reject" and never as 0: coercing a bad
// value to 0 would read as "Off" and stand auto-lock down.
//
// Out-of-range values are rejected rather than clamped, matching the CLI. A
// clamp would turn an absurd setLock into a seven-day timeout, which is the
// same silent weakening this is meant to prevent.
export function requestedSeconds(value) {
  var number = Number(value)
  if (!isFinite(number)) return -1
  number = Math.round(number)
  if (number < 0 || number > maxTimeoutSeconds) return -1
  return number
}

// Normalize a value already on disk. Unlike requestedSeconds there is no caller
// to report back to, so an oversized value is clamped rather than rejected -
// the bound is what keeps sleepDelaySeconds * 1000 inside a 32-bit int.
export function normalizedSeconds(value, fallback, allowOff) {
  var number = Number(value)
  if (!isFinite(number)) return fallback
  number = Math.round(number)
  if (allowOff && number === 0) return 0
  if (number <= 0) return fallback
  return Math.min(number, maxTimeoutSeconds)
}

export function normalizedLidAction(value) {
  var action = String(value || "system")
  return lidActions.indexOf(action) >= 0 ? action : "system"
}

export function lidActionLabel(action) {
  switch (normalizedLidAction(action)) {
  case "nothing": return "Do nothing"
  case "display": return "Display off"
  case "sleep": return "Sleep"
  case "hibernate": return "Hibernate"
  default: return "System default"
  }
}

export function formatDuration(seconds) {
  var value = Number(seconds)
  if (!isFinite(value) || value <= 0) return "Off"
  if (value < 60) return Math.round(value) + " sec"

  var minutes = value / 60
  if (minutes < 60) {
    var minuteLabel = minutes === Math.round(minutes)
      ? String(Math.round(minutes)) : minutes.toFixed(1).replace(/\.0$/, "")
    return minuteLabel + " min"
  }

  var hours = minutes / 60
  return (hours === Math.round(hours) ? String(Math.round(hours)) : hours.toFixed(1)) + (hours === 1 ? " hour" : " hours")
}

export function isPreset(value, presets) {
  var seconds = Number(value)
  for (var i = 0; i < presets.length; i++) {
    if (seconds === Number(presets[i])) return true
  }
  return false
}

export function customParts(seconds) {
  var totalMinutes = Math.max(1, Math.round(Number(seconds) / 60))
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60
  }
}

export function customSeconds(hours, minutes) {
  var safeHours = Math.max(0, Math.min(24, Math.round(Number(hours) || 0)))
  var safeMinutes = Math.max(0, Math.min(59, Math.round(Number(minutes) || 0)))
  return (safeHours * 60 + safeMinutes) * 60
}
