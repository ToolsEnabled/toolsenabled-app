/* THE EXAMPLE TURN, PLAYED ONCE AS IT WOULD ARRIVE LIVE.
 *
 * The plain-browser example chat (src/chat-sample-parts.js) draws a finished
 * turn, so the live parts of a turn -- a thought streaming, a tool running
 * with its output coming in and its clock counting -- could not be looked at
 * without a real agent. This plays that same turn once, paced, when the
 * example chat opens: the thought streams, each call runs and settles, the
 * test's output tails in, a second thought, the change, then the reply. It
 * ends in the same finished turn the example always showed. No control starts
 * it again; opening the example again plays it again.
 *
 * SAME DATA, SAME DOORS. The example's own parts are recorded through the
 * doors showChatSampleParts already calls, then replayed through the chat's
 * public doors (addAction, addDiff, openStream) with live states, so what the
 * preview shows is what a live turn paints. The two thoughts are this file's
 * own example words, sent as thinking rows the way every engine sends them.
 *
 * WHERE IT MAY RUN is decided by the caller, buildChat, with the example's
 * existing gate: a labelled demonstration, no saved history, plain browser
 * only. The example's first line already says nothing in it ran. */

const THOUGHTS = [
  'The drift starts on page two, so the carried subtotal is the first suspect. The paginator keeps a running total and prints it at the top of the next page. If that printed line is also counted as a row, every later page sums it again. Read the paginator first, then run the export test to see which pages disagree before changing anything.',
  'Page 9 carries the subtotal twice: the carried line is summed with the rows. Keep the carried amount as a display line only, sum each page from its own rows, and run the same test again.',
]

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function record(showParts) {
  const parts = { note: null, owner: null, actions: [], diff: null, reply: null }
  const recorder = {
    addNote: (text) => { parts.note = text },
    addOwnerMessage: (text) => { parts.owner = text },
    addThinking: () => {},
    addAction: (row) => { if (row && typeof row === 'object') parts.actions.push(row) },
    addDiff: (diff) => { parts.diff = diff },
    openStream: () => ({ push() {}, flush() {}, close: (text) => { parts.reply = typeof text === 'string' ? text : '' } }),
  }
  showParts(recorder)
  return parts
}

/* The example's parts are recorded partly on a later frame; wait for them. */
async function recorded(parts, key, limitMs = 2000) {
  for (let waited = 0; parts[key] === null && waited < limitMs; waited += 50) await wait(50)
  return parts[key]
}

async function streamThought(root, id, text) {
  const words = text.split(' ')
  const at = Date.now()
  const row = { id, kind: 'thinking', tool: 'Thinking', detail: '', at }
  for (let count = 2; count < words.length; count += 2) {
    root.addAction({ ...row, state: 'running', stateKey: 'working', body: words.slice(0, count).join(' ') })
    await wait(70)
  }
  root.addAction({ ...row, state: 'finished', stateKey: 'done', body: text })
}

async function runCall(root, final, { outputEvery = 0, holdMs = 400 } = {}) {
  const body = String(final.body || '')
  const split = body.indexOf('\n\n')
  const command = split >= 0 ? body.slice(0, split) : body
  const lines = split >= 0 ? body.slice(split + 2).split('\n') : []
  const startedAt = Date.now()
  const rest = { ...final }
  delete rest.durationMs
  const running = { ...rest, at: startedAt, startedAt, state: 'running', stateKey: 'working', body: command }
  root.addAction(running)
  if (outputEvery > 0) {
    for (let count = 1; count <= lines.length; count += 1) {
      await wait(outputEvery)
      root.addAction({ ...running, body: `${command}\n\n${lines.slice(0, count).join('\n')}` })
    }
  }
  await wait(holdMs)
  const endedAt = Date.now()
  root.addAction({ ...rest, at: startedAt, startedAt, endedAt, durationMs: endedAt - startedAt })
}

async function play(root, parts) {
  const now = () => ({ at: Date.now() })
  if (parts.note) root.addNote?.(parts.note, now())
  if (parts.owner) root.addOwnerMessage?.(parts.owner, now())
  await wait(600)
  await streamThought(root, 'sample-live:thought-1', THOUGHTS[0])
  const [read, test, edit, check] = parts.actions
  if (read) await runCall(root, read, { holdMs: 450 })
  if (test) await runCall(root, test, { outputEvery: 80, holdMs: 250 })
  await streamThought(root, 'sample-live:thought-2', THOUGHTS[1])
  if (edit) await runCall(root, edit, { holdMs: 400 })
  if (check) await runCall(root, check, { outputEvery: 1100, holdMs: 300 })
  const diff = await recorded(parts, 'diff')
  if (diff) root.addDiff?.({ ...diff, at: Date.now() })
  const reply = await recorded(parts, 'reply')
  if (!reply || typeof root.openStream !== 'function') return
  const stream = root.openStream(now())
  for (let end = 24; end < reply.length; end += 24) {
    stream.push(reply.slice(0, end))
    await wait(30)
  }
  stream.close(reply)
}

export function playChatLiveSample(root, showParts) {
  if (!root || typeof root.addAction !== 'function' || typeof showParts !== 'function') return
  let parts
  try { parts = record(showParts) } catch { return }
  void play(root, parts).catch(() => { /* a closed example chat simply stops */ })
}
