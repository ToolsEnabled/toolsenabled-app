/* Provider catalogs are session capabilities, not a window-wide entitlement
 * list. An unsupported provider keeps the existing explicit launch menu. */
import { terminalSessionRefusal } from './saved-session-refusals.js'

export function createEngineModelCatalog() {
  const entries = new Map()
  function record(sessionId, answer) {
    if (!sessionId) return
    if (answer?.catalogSupported === false && typeof answer.provider === 'string') {
      entries.set(sessionId, { state: 'unsupported', provider: answer.provider, models: [] })
    } else if (answer?.catalogSupported === true && typeof answer.provider === 'string' && Array.isArray(answer.models)) {
      entries.set(sessionId, { state: 'ready', provider: answer.provider, models: answer.models })
    } else entries.delete(sessionId)
  }
  async function read(sessionId, bridge) {
    if (!sessionId || typeof bridge?.models !== 'function' || entries.has(sessionId)) return
    const pending = { state: 'pending' }
    entries.set(sessionId, pending)
    let answer
    try { answer = await bridge.models({ sessionId }) }
    catch (error) {
      if (entries.get(sessionId) !== pending) return
      /* A session the host does not hold, or that has ended, will not answer
         differently next time, so the refusal is kept and the menus stop
         asking: every refused read is a logged handler error in the host
         (see src/saved-session-refusals.js). Anything else -- a transport
         failure, a host not ready yet -- is dropped and retried on the next
         read, exactly as before. */
      if (terminalSessionRefusal(error)) entries.set(sessionId, { state: 'refused' })
      else entries.delete(sessionId)
      return
    }
    if (entries.get(sessionId) !== pending) return
    if (answer?.ok === false && terminalSessionRefusal(answer)) entries.set(sessionId, { state: 'refused' })
    else record(sessionId, answer)
  }
  function efforts(sessionId, provider, modelId) {
    const entry = entries.get(sessionId)
    if (!modelId || entry?.state !== 'ready' || entry.provider !== provider) return []
    const model = entry.models.find(row => row?.id === modelId)
    return Array.isArray(model?.efforts) ? model.efforts : []
  }
  return Object.freeze({ read, record, efforts })
}
