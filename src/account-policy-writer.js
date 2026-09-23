import { accountsBridge, saveSelectionMode } from './account-switcher-state.js'

// All panels talking to the same computer share write order. Navigation
// retires subscriptions, while accepted settings continue to their destination.
const writers = new WeakMap()

export function accountPolicyWriter(scope = globalThis) {
  const key = accountsBridge(scope) || scope
  if (writers.has(key)) return writers.get(key)
  const listeners = new Set()
  const queue = []
  let state = Object.freeze({ saving: false, revision: 0, failure: null, confirmation: null })
  const publish = next => {
    state = Object.freeze(next)
    for (const listener of listeners) listener(state)
  }
  async function drain() {
    let failure = null
    let confirmation = null
    while (queue.length) {
      const entry = queue.shift()
      const answer = await saveSelectionMode(entry.request, scope)
      if (!answer.ok) failure = answer.reason
      else confirmation = entry.confirmation
    }
    publish({ ...state, saving: false, failure, confirmation })
  }
  const writer = Object.freeze({
    get state() { return state },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    save(request, confirmation) {
      const alreadySaving = state.saving
      queue.push({ request: { ...request }, confirmation })
      publish({ saving: true, revision: state.revision + 1, failure: null, confirmation: null })
      if (!alreadySaving) void drain()
    },
  })
  writers.set(key, writer)
  return writer
}
