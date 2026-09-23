// Explicit renderer consent for actual-module tests; never touches disk or
// the host's settings. Each test restores the original global descriptor.
export function useStartConsent(t, initial = 'enabled') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let value = initial
  const storage = {
    getItem: key => key === 'mc.write.agent-session' ? value : null,
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  return { set: next => { value = next } }
}
