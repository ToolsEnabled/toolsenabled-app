/* WHAT THE AGENT IS DOING RIGHT NOW, SHOWN WHERE IT IS HAPPENING, AND ONLY
 * WHILE IT IS.
 *
 * Product rule: show agent thinking when possible, and other context the
 * person does not otherwise get to see, in temporary boxes where possible --
 * held to two things, as polish of what exists and not as add-ons:
 *
 *   thinking  a reasoning row that is still streaming shows its most recent
 *             lines in a small bounded window: plain text, one text write per
 *             frame, no markdown pass per frame over a growing thought.
 *             When the thought ends, the reply starts to speak, or the reader
 *             presses the row, the window is released and the row is the
 *             ordinary reasoning fold with the whole thought in it.
 *   a tool    a call that is still running shows its elapsed time in the
 *             duration column and, when output reaches the row while it runs,
 *             its last lines under the head. Only the newest running call has
 *             a tail. When the result lands both go, and the row is the
 *             ordinary tool row with its measured duration.
 *
 * NOT A SECOND RENDERER. This decorates the rows buildChat already paints
 * (components.js paintAction), and only rows that arrived LIVE through
 * addAction. A restored conversation paints the same rows without any of it,
 * so a reopened chat shows the folds and never a live window.
 *
 * CALM BY CONSTRUCTION. Thinking paints on the chat's own per-frame action
 * batch. The elapsed clock is one 1 s interval per chat, running only while a
 * call is live, skipping every tick while the chat is off screen or its window
 * is hidden, and never keeping a Node process alive.
 *
 * The engines do not stream a running tool's output yet (notes/chat/
 * LIVE-EVENTS.md, "needs the tree"): the tail paints any growth of a working
 * row's body, so it appears the day that output is passed through, and in the
 * plain-browser example now. */

import { forgetChatMessageBody } from './chat-message-body.js'

/* The window shows four lines, but the element keeps the whole thought, so
   Find, copy and a screen reader reach all of it while it streams. Only a
   thought past this safety bound keeps its latest part until it settles. */
const THINKING_WINDOW_CHARS = 65_536
const OUTPUT_TAIL_CHARS = 4000
export const LIVE_TAIL_LINES = 3

/* The thought as the window holds it: markdown marks removed, paragraphs on
   consecutive lines. The settled fold renders the source as written. */
export function liveThinkingText(source) {
  let text = String(source ?? '')
  if (text.length > THINKING_WINDOW_CHARS) {
    text = text.slice(-THINKING_WINDOW_CHARS)
    const space = text.search(/\s/)
    if (space >= 0 && space < 80) text = text.slice(space + 1)
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/[ \t]*\n\s*/g, '\n')
    .trim()
}

/* The last few non-blank lines of output, trailing space and their shared
   indent removed so the glimpse starts on the row's text column. The opened
   row still holds the output exactly as printed. */
export function liveOutputTail(output, count = LIVE_TAIL_LINES) {
  const source = String(output ?? '')
  const lines = (source.length > OUTPUT_TAIL_CHARS ? source.slice(-OUTPUT_TAIL_CHARS) : source)
    .replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  for (let index = lines.length - 1; index >= 0 && kept.length < count; index -= 1) {
    const line = lines[index].replace(/\s+$/, '')
    if (line.trim()) kept.unshift(line)
  }
  const indent = Math.min(...kept.map(line => line.length - line.trimStart().length))
  return kept.map(line => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}

/* Whole seconds while it runs; the measured duration replaces it at the end.
   Nothing under a second, so a quick call never flashes a zero. */
export function liveElapsedText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * One per chat. `render(held, source)` is the chat's own way to paint a
 * thinking row's full body (setChatMessageBody), used when a window is
 * released without a new paint following it.
 */
export function createChatLiveWork({ root = null, render = () => {}, now = () => Date.now() } = {}) {
  const windows = new Set()
  const clocks = new Map()
  let tailHeld = null
  let timer = null
  let observer = null
  let onScreen = true
  let disposed = false

  const documentHidden = () => typeof document !== 'undefined' && document.hidden === true

  const tick = () => {
    if (disposed || !onScreen || documentHidden()) return
    const at = now()
    for (const [held, start] of clocks) {
      const text = liveElapsedText(at - start)
      if (held.liveElapsed && held.liveElapsed.textContent !== text) held.liveElapsed.textContent = text
    }
  }

  const watchScreen = () => {
    if (observer || !root || typeof IntersectionObserver !== 'function') return
    try {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) onScreen = entry.isIntersecting
        tick()
      })
      observer.observe(root)
    } catch { observer = null }
  }

  const startClock = () => {
    if (timer || disposed) return
    watchScreen()
    timer = setInterval(tick, 1000)
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  }

  const stopClock = () => {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  const removeElapsed = (held) => {
    clocks.delete(held)
    held.liveElapsed?.remove()
    held.liveElapsed = null
    if (clocks.size === 0) stopClock()
  }

  const removeTail = (held) => {
    held.liveTail?.remove()
    held.liveTail = null
    if (tailHeld === held) tailHeld = null
  }

  const clearCall = (held) => {
    removeElapsed(held)
    removeTail(held)
    held.liveBase = null
    if (held.wrap.getAttribute('data-chat-live') === 'call') held.wrap.removeAttribute('data-chat-live')
  }

  /* Leaves the window. With `repaint`, the full thought is painted here;
     otherwise the caller is about to paint it. */
  const release = (held, { repaint = false } = {}) => {
    if (!windows.delete(held)) return
    held.wrap.removeAttribute('data-chat-live')
    held.liveLines = null
    forgetChatMessageBody(held.body)
    if (repaint) {
      held.body.replaceChildren()
      render(held, typeof held.liveSource === 'string' ? held.liveSource : '')
    }
  }

  return {
    /** Paints a live thinking window and answers true, or answers false and
     *  leaves the full paint to the caller. */
    thinking(held, source, wanted, shown = source) {
      const live = wanted === true && !disposed && !held.wrap.__actionUserToggled && !held.liveSettled
      if (!live) {
        release(held)
        return false
      }
      let lines = held.liveLines
      if (!lines || lines.parentNode !== held.body) {
        lines = held.body.ownerDocument.createElement('span')
        lines.className = 'chat-live-lines'
        forgetChatMessageBody(held.body)
        held.body.replaceChildren(lines)
        held.liveLines = lines
      }
      if (held.wrap.getAttribute('data-chat-live') !== 'thinking') held.wrap.setAttribute('data-chat-live', 'thinking')
      held.liveSource = source
      const text = liveThinkingText(shown)
      if (lines.textContent !== text) lines.textContent = text
      windows.add(held)
      return true
    },
    /** The reader pressed the row: it is theirs now, whole. */
    releaseThinking(held) {
      if (held) release(held, { repaint: true })
    },
    /** The reply is speaking: every open window becomes its fold. */
    settleThinking() {
      for (const held of [...windows]) {
        held.liveSettled = true
        release(held, { repaint: true })
      }
    },
    /** A tool row: live decorations while it runs, none once it has settled. */
    call(held, row, body, wanted) {
      if (wanted !== true || disposed) {
        if (held.liveElapsed || held.liveTail || typeof held.liveBase === 'string') clearCall(held)
        return
      }
      const doc = held.head.ownerDocument
      const start = Number.isFinite(row.startedAt) ? row.startedAt : (Number.isFinite(row.at) ? row.at : null)
      if (start !== null && !held.duration) {
        if (!held.liveElapsed) {
          held.liveElapsed = doc.createElement('span')
          held.liveElapsed.setAttribute('data-chat-live-elapsed', '')
          held.head.appendChild(held.liveElapsed)
        }
        clocks.set(held, start)
        const text = liveElapsedText(now() - start)
        if (held.liveElapsed.textContent !== text) held.liveElapsed.textContent = text
        startClock()
      } else removeElapsed(held)
      if (typeof held.liveBase !== 'string') held.liveBase = body
      const grown = body.length > held.liveBase.length && body.startsWith(held.liveBase)
        ? body.slice(held.liveBase.length) : ''
      const tail = liveOutputTail(grown)
      if (tail) {
        if (tailHeld && tailHeld !== held) removeTail(tailHeld)
        tailHeld = held
        if (!held.liveTail) {
          held.liveTail = doc.createElement('pre')
          held.liveTail.className = 'chat-live-tail'
          held.liveTail.setAttribute('data-chat-live-tail', '')
          /* The whole output is one press away in the row's own body; this
             glimpse would only be read aloud over and over. */
          held.liveTail.setAttribute('aria-hidden', 'true')
          held.head.appendChild(held.liveTail)
        }
        if (held.liveTail.textContent !== tail) held.liveTail.textContent = tail
      }
      if (held.wrap.getAttribute('data-chat-live') !== 'call') held.wrap.setAttribute('data-chat-live', 'call')
    },
    dispose() {
      disposed = true
      stopClock()
      observer?.disconnect()
      observer = null
      clocks.clear()
      windows.clear()
      tailHeld = null
    },
  }
}
