// The native attempt owns authentication and expiry. This observer only reads
// its public browser address; stopping it cannot accept or cancel a sign-in.
export function watchBrowserSignInAddress({ bridge, onAddress,
  now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout,
  timeoutMs = 330000, intervalMs = 1000 } = {}) {
  let active = true
  let timer = null
  const deadline = now() + timeoutMs
  function stop() {
    active = false
    if (timer !== null) unschedule(timer)
    timer = null
  }
  async function read() {
    timer = null
    if (!active || now() >= deadline) { stop(); return }
    let reply
    try { reply = await bridge.googleUrl() } catch { /* a later read may recover */ }
    if (!active || now() >= deadline) { stop(); return }
    if (reply?.ok === true && typeof reply.url === 'string' && reply.url.length > 0 && reply.url.length <= 8192) {
      stop()
      onAddress(reply.url)
      return
    }
    timer = schedule(read, Math.min(intervalMs, deadline - now()))
  }
  if (typeof bridge?.googleUrl === 'function') void read()
  else stop()
  return stop
}
