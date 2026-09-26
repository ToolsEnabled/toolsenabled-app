// Linux Electron checks use a disposable display. Missing prerequisites must
// fail the required native check; non-X11 platforms keep their direct launch.
export function computeDisplayGuardDecision({ platform, hasXvfbRun, hasDisplay }) {
  if (platform !== 'linux') return 'direct'
  if (hasXvfbRun) return 'wrap'
  if (hasDisplay) return 'refuse'
  return 'unavailable'
}
