/* ROWS A PERSON HAS HIDDEN FROM ONE LIST, KEPT ON THIS SCREEN AND NOWHERE ELSE.
 *
 * WHY THIS IS A HIDE AND NOT A DELETE. The ledger page shows three kinds of
 * thing and none of them has an honest "delete" (plan O6). An owner request (R)
 * lives in a JSON ledger with a hash-chained, append-only overlay beside it --
 * capability/tools/ledger-archive.js retires a request by APPENDING a
 * disposition, never by removing a line, and an archived request still reaches
 * only "cooling" and stays in every projected list until three separate
 * sessions have seen it. An owner question (Q) is parsed out of BUILD-QUEUE.md
 * and the app has no writer for it at all. So a × on a row that claimed to take
 * the row "out of the list agents read" would be a lie on the next load: the
 * data would come straight back.
 *
 * What the app CAN do honestly is stop drawing a row on this screen. That is
 * all this module is: a bounded set of record keys, one per list, in
 * localStorage, with the same try/catch posture the page already takes for
 * its R/Q tab choice (src/views/ledger.js writeMode). Nothing here is sent
 * anywhere, nothing here is audited, and the copy beside the control says
 * exactly that ("It is hidden on this screen only; nothing else changes").
 *
 * ONE KEY PER LIST, AND THE EXAMPLE GETS ITS OWN. The example register
 * (src/sample-ledger.js) is deliberately shaped exactly like a real one, down
 * to its ids, so an "R1" hidden while the example toggle was on must not hide a
 * real R1 the moment the toggle goes off. The caller picks the key from
 * sourceIsBadged() -- 'mc.ledger.hidden:example' versus 'mc.ledger.hidden:live'
 * -- and this module never lets two keys share a set.
 *
 * SHAPE ON DISK: {v:1, ids:[...]}, ids as record keys ('r:R12', 'q:Q7', or a
 * research queue item id). Capped at 500: a list a person has hidden five
 * hundred rows from is not being tidied, it is being used as the wrong tool,
 * and an unbounded key in localStorage is a quota failure waiting for a later
 * write to trip over. Damage (not JSON, wrong version, wrong shape) reads as an
 * empty set rather than an error -- a damaged hide list must never take the
 * whole register down with it. */

const VERSION = 1
const CAP = 500

function couldNotAccessStorage(action, cause) {
  const error = new Error(`Hidden rows could not be ${action}; this does not claim that no rows are hidden.`, { cause })
  error.code = 'HIDDEN_ROWS_COULD_NOT_TELL'
  return error
}

function storage() {
  let store
  try { store = globalThis.localStorage } catch (cause) {
    throw couldNotAccessStorage('read', cause)
  }
  if (!store) throw couldNotAccessStorage('read', new Error('localStorage is unavailable'))
  return store
}

function readIds(key) {
  let raw
  try {
    raw = storage().getItem(key)
  } catch (cause) {
    if (cause?.code === 'HIDDEN_ROWS_COULD_NOT_TELL') throw cause
    throw couldNotAccessStorage('read', cause)
  }
  if (raw === null) return []
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION || !Array.isArray(parsed.ids)) return []
    const ids = []
    for (const id of parsed.ids) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 200 && !ids.includes(id)) ids.push(id)
      if (ids.length >= CAP) break
    }
    return ids
  } catch {
    // A value that was successfully read but is damaged is not an uncertain
    // storage read. The documented repair is to ignore that hide list.
    return []
  }
}

function writeIds(key, ids) {
  try {
    const store = storage()
    if (ids.length === 0) store.removeItem(key)
    else store.setItem(key, JSON.stringify({ v: VERSION, ids }))
  } catch (cause) {
    if (cause?.code === 'HIDDEN_ROWS_COULD_NOT_TELL') throw cause
    throw couldNotAccessStorage('written', cause)
  }
}

/**
 * A hidden-row set bound to one storage key.
 *
 * Every call re-reads the key, so two views of the same list in one window
 * (the desktop app re-mounts the page on every route change) agree without a
 * shared in-memory object, and a test can swap the storage under it.
 */
export function createHiddenRows(storageKey) {
  if (typeof storageKey !== 'string' || storageKey.length === 0) throw new TypeError('createHiddenRows needs a storage key')
  const key = storageKey
  return Object.freeze({
    has(id) { return readIds(key).includes(id) },
    add(id) {
      if (typeof id !== 'string' || id.length === 0) return false
      const ids = readIds(key)
      if (ids.includes(id)) return true
      if (ids.length >= CAP) return false
      ids.push(id)
      writeIds(key, ids)
      return true
    },
    remove(id) {
      const ids = readIds(key)
      const next = ids.filter(entry => entry !== id)
      if (next.length === ids.length) return false
      writeIds(key, next)
      return true
    },
    /* FORGET HIDES FOR LEDGER RECORDS THAT ARE GONE (T1283). A hide for a row
       that was later deleted still took one of the 500 places, so a person
       reached the cap sooner than the counter said. `present` is every Ledger
       key the caller's complete read returned; only Ledger keys ('r:', 't:',
       'a:', 'p:') are ever forgotten -- a read of the Ledger proves nothing
       about questions or any other list. Answers how many were forgotten. */
    prune(present) {
      if (!present || typeof present.has !== 'function') return 0
      const ids = readIds(key)
      const next = ids.filter(id => !/^[rtap]:/.test(id) || present.has(id))
      if (next.length === ids.length) return 0
      writeIds(key, next)
      return ids.length - next.length
    },
    list() { return readIds(key) },
    count() { return readIds(key).length },
    clear() { writeIds(key, []) },
  })
}

export const HIDDEN_ROWS_CAP = CAP
