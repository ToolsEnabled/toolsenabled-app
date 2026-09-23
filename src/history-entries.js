/* KEEPING BACK AND FORWARD TRUE WHEN A PAGE REFUSES TO BE LEFT (T1412).
 *
 * The router hears about a move only after the address has changed: a rail
 * press has already pushed a new entry, a Back press has already popped to the
 * previous one. When the page being left refuses (Settings with unsaved
 * changes: 'Leave Settings and discard unsaved changes?' -> Cancel), the router
 * used to write the old address over whichever entry it was on. For a push that
 * left Settings in history twice, so the next Back did nothing at all; for a
 * pop it overwrote the PREVIOUS page's entry with Settings, so the page the
 * person came from vanished from history for good.
 *
 * So every entry the app settles on carries its position in history.state, and
 * a refusal walks back to the entry it never left: history.back() when the move
 * made a new, unstamped entry, history.go(delta) when it moved to a stamped
 * one. The hashchange that walk causes is recognised and ignored, so the page
 * is not asked again and nothing is re-rendered.
 */

const KEY = 'mcEntry'

export function createHistoryEntries({ history = globalThis.history, location = globalThis.location } = {}) {
  let index = null
  let undoing = null
  const stateOf = () => {
    try { return history?.state && typeof history.state === 'object' ? history.state : null } catch { return null }
  }
  const entryOf = () => {
    const value = stateOf()?.[KEY]
    return Number.isInteger(value) ? value : null
  }
  /* The address is passed back unchanged (undefined when there is none, which
     the browser reads as 'keep the URL'); passing '' would drop the hash. */
  const here = () => location?.hash || undefined
  return {
    /* The move was accepted: remember which entry this is, numbering a new one
       one past the entry it was made from. */
    settle() {
      const known = entryOf()
      if (known !== null) { index = known; return index }
      index = index === null ? 0 : index + 1
      try { history.replaceState({ ...(stateOf() || {}), [KEY]: index }, '', here()) } catch {}
      return index
    },
    /* The page refused the move. `stayHash` is the address of the entry the
       app is still showing. Returns how history was put back. */
    refuse(stayHash) {
      const arrived = entryOf()
      const canWalk = typeof history?.back === 'function' && typeof history?.go === 'function'
      if (canWalk && index !== null && arrived === null) {
        undoing = stayHash
        history.back()
        return 'back'
      }
      if (canWalk && index !== null && arrived !== index) {
        undoing = stayHash
        history.go(index - arrived)
        return 'go'
      }
      try { history.replaceState(stateOf(), '', stayHash) } catch {}
      return 'replace'
    },
    /* True exactly once, for the hashchange the walk back itself caused. */
    isUndoEcho(hash) {
      if (undoing === null) return false
      const echo = hash === undoing
      undoing = null
      return echo
    },
  }
}
