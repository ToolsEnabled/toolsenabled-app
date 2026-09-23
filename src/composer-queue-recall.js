/* UP-ARROW FROM THE COMPOSER REACHES THE MESSAGES STILL WAITING TO SEND.
 *
 * Owner, verbatim: "i like how in cmd you can press the up button and edit
 * your qued messages. it might be a weird feature but ca we let userrs press
 * up from the chat to get to their qued messages and edit them".
 *
 * It is not a weird feature. It is the direct remedy for four messages he
 * lost: a message written while the agent is busy goes into the session outbox
 * (src/session-outbox.js) and is previewed in the strip above the composer,
 * and until now the ONLY things a person could do to one were send it now or
 * throw it away. A typo in a queued message had exactly one cure — Unqueue and
 * retype the whole thing from memory.
 *
 * WHY THE WALK LIVES HERE AND NOT IN THE KEY HANDLER. Every rule below is a
 * decision about words a person is at risk of losing, and buildChat needs a
 * DOM to run, so a walk written inline in components.js could only ever be
 * pinned by grepping its own source. This module is called with values and
 * answers with values, so tools/test/composer-queue-recall.test.mjs drives the
 * real walk — the boundaries, the edit, the restore — instead of describing it.
 *
 * THE ONE RULE THE REST FOLLOWS FROM: THE BOX WINS, AND LEAVING NEVER
 * DISCARDS. Whatever text is in the composer when the walk moves off an entry
 * becomes that entry's words, whichever key moved it — Up, Down, Escape or
 * Enter. This feature exists because messages were lost, so there is no key
 * here that means "throw the edit away"; Escape's job is stated exactly, and
 * it is to put the DRAFT back, not to undo the edit. One rule beats two that
 * differ by which key was pressed, and the queue strip shows the result the
 * moment it happens.
 *
 * WHAT IS DELIBERATELY NOT A DOOR:
 *
 *   - An emptied box is NOT a delete. Clearing a recalled message and walking
 *     on leaves the queued message exactly as it was. Unqueue is the one way
 *     out of that store for words a person wants gone, and it says so on a
 *     button; a second, silent one reachable by holding Backspace is how this
 *     feature would start losing the messages it was built to save.
 *
 *   - Up from a composer with words in it does nothing at all. The walk starts
 *     only from an empty box, so "never lose what the person had typed" is
 *     true by construction on entry, not by a rescue afterwards. Inside the
 *     walk the draft is stashed byte for byte and comes back on Escape or on
 *     Down past the newest entry, the way a shell returns you to the line you
 *     were writing.
 *
 *   - The walk anchors on the entry's ID, never on its position. The queue
 *     drains while a person reads it — the view's turn-completed listener
 *     takes the front entry the moment a turn ends — so a position held across
 *     two keystrokes would silently retarget the edit at a different message.
 *     If the anchored entry has gone (drained, or unqueued from the strip) the
 *     walk stops and the box is left EXACTLY as it stands, because whatever is
 *     in it at that moment is the only copy of what the person just typed.
 */

import { RECALL_EDIT_NOT_KEPT } from './chat-copy.js'

const asText = value => (typeof value === 'string' ? value : '')

/* Nothing here is `handled` unless it is also acted on. The caller uses this
   as its preventDefault decision, so a key this walk declines must leave the
   browser's own behaviour — caret to the start of the line, Escape closing
   whatever else is open — completely untouched. */
const DECLINED = Object.freeze({ handled: false })

/**
 * @param {{
 *   list?: () => Array<{id: string, text: string}>,
 *   replace?: (id: string, text: string) => {ok: boolean, sentence?: string},
 * }} wiring
 *
 * `list` is the composer's own `queue.list` — the same rows the strip paints,
 * oldest first. `replace` is optional: a caller without one gets a read-only
 * walk and says so once, out loud, rather than swallowing the edit.
 *
 * Every answer is `{ handled, text?, note? }`. `handled: false` means the key
 * was not this walk's; the caller must not preventDefault and must not touch
 * the box. `text` is what the composer should now hold. `note` is a sentence
 * to show once, because an edit that could not be kept is a refusal and a
 * refusal names itself.
 */
export function createQueueRecall({ list = null, replace = null } = {}) {
  /* The entry being edited, and the person's own unsent draft. Both null
     exactly when no walk is in progress; they are set and cleared together so
     "am I walking" can never disagree with "whose words am I holding". */
  let anchorId = null
  let draft = null

  const rows = () => {
    if (typeof list !== 'function') return []
    let listed = null
    try { listed = list() } catch { listed = null }
    if (!Array.isArray(listed)) return []
    return listed.filter(row => row && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0)
  }

  const stop = () => { anchorId = null; draft = null }

  /* Write the box back onto the entry it came from. Returns a sentence when
     the edit could NOT be kept, and null when there was nothing to keep or the
     store took it. An unchanged box and an emptied box are both "nothing to
     keep" — see the header for why the second one is not a delete. */
  const commit = (entry, currentText) => {
    const next = asText(currentText)
    if (next.trim().length === 0) return null
    if (next.trim() === asText(entry.text).trim()) return null
    if (typeof replace !== 'function') return RECALL_EDIT_NOT_KEPT
    let answer = null
    try { answer = replace(entry.id, next) } catch { answer = null }
    if (answer && answer.ok === true) return null
    return (answer && typeof answer.sentence === 'string' && answer.sentence.trim()) || RECALL_EDIT_NOT_KEPT
  }

  /* One step of the walk, shared by Up and Down so the two directions cannot
     drift apart on the parts that matter: commit first, re-read the queue
     after the commit, then land. `step` is -1 for older, +1 for newer.
     `atEdge` says what to do when there is no further entry that way. */
  const move = (currentText, step, atEdge) => {
    const listed = rows()
    const index = listed.findIndex(row => row.id === anchorId)
    /* The entry went out from under the walk. Keep the box; it is the only
       copy of whatever was just typed into it. */
    if (index === -1) { stop(); return { handled: true, text: asText(currentText) } }
    const note = commit(listed[index], currentText)
    const after = rows()
    const now = after.findIndex(row => row.id === anchorId)
    if (now === -1) { stop(); return { handled: true, text: asText(currentText), ...(note ? { note } : {}) } }
    const target = after[now + step]
    if (!target) return atEdge(after[now], note)
    anchorId = target.id
    return { handled: true, text: asText(target.text), ...(note ? { note } : {}) }
  }

  return {
    /** Older. From an empty box this starts the walk at the most recent
     *  waiting message, which is the end a person means by "the last thing I
     *  said". At the oldest it stays put rather than wrapping, the way a shell
     *  history does — wrapping would put the newest message under a key that
     *  had been walking away from it. */
    up(currentText = '') {
      if (anchorId === null) {
        const listed = rows()
        if (listed.length === 0) return DECLINED
        if (asText(currentText).trim().length > 0) return DECLINED
        draft = asText(currentText)
        anchorId = listed[listed.length - 1].id
        return { handled: true, text: asText(listed[listed.length - 1].text) }
      }
      return move(currentText, -1, (landed, note) => ({ handled: true, text: asText(landed.text), ...(note ? { note } : {}) }))
    },

    /** Newer, and past the newest is the way out: the draft comes back and the
     *  walk ends, exactly as pressing Down past the last command returns a
     *  shell to the line you were writing. */
    down(currentText = '') {
      if (anchorId === null) return DECLINED
      return move(currentText, 1, (_landed, note) => {
        const restored = asText(draft)
        stop()
        return { handled: true, text: restored, ...(note ? { note } : {}) }
      })
    },

    /** Leave the walk and put the draft back. The edit still lands — see the
     *  header: Escape restores what was being typed, it does not undo what was
     *  rewritten. */
    escape(currentText = '') {
      if (anchorId === null) return DECLINED
      const listed = rows()
      const index = listed.findIndex(row => row.id === anchorId)
      const note = index === -1 ? null : commit(listed[index], currentText)
      const restored = asText(draft)
      stop()
      return { handled: true, text: restored, ...(note ? { note } : {}) }
    },

    /** Enter (and ⇧⏎) while a queued message is in the box means KEEP THIS
     *  EDIT, never "send a second copy". The message is already queued and
     *  will send by itself; delivering it again from here is the one outcome a
     *  person editing a waiting message can never want. The draft comes back
     *  and the walk ends. With the anchor gone this declines, so the ordinary
     *  send runs and the words in the box go out rather than nowhere. */
    submit(currentText = '') {
      if (anchorId === null) return DECLINED
      const listed = rows()
      const index = listed.findIndex(row => row.id === anchorId)
      if (index === -1) { stop(); return DECLINED }
      const note = commit(listed[index], currentText)
      const restored = asText(draft)
      stop()
      return { handled: true, text: restored, ...(note ? { note } : {}) }
    },

    /** Drop the walk without touching the box — for a surface being torn down.
     *  Nothing is committed, because there is no box left to read. */
    leave() { stop() },

    /** The message being edited left the queue without this walk: the queue
     *  sent it as it was at a turn boundary. The walk ends and the box keeps
     *  the edit; true once, so the composer can say what happened, because
     *  Enter then sends the edit as a second message (T1543). */
    anchorGone() {
      if (anchorId === null || rows().some(row => row.id === anchorId)) return false
      stop()
      return true
    },

    /** The entry the walk is holding, or null. Read by tests and by the
     *  composer's own "am I in a walk" checks; never a position. */
    get anchorId() { return anchorId },
  }
}
