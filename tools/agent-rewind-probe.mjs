// THE REWIND GATE. thread/fork with lastTurnId exists in the engine contract,
// but its live semantics — does the fork actually forget everything after the
// named turn? — are unproven on this tree. No rewind control ships until this
// probe passes against the STAGED payload's own engine. Run it by hand:
//
//   node tools/agent-rewind-probe.mjs
//
// It starts one Codex session (the default tier), runs three tiny turns, forks
// at turn 2, and asks the fork what it remembers. PASS = ONE and TWO
// remembered, THREE forgotten. Spends a few thousand luna tokens; touches no
// user data.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startCodexSession } = require_(path.join(REPO, 'capability', 'src', 'lib', 'agent-engine', 'codex-process.js'))

const transcriptByTurn = new Map()
let activeTurn = null

function onEvent(event) {
  if (event.type === 'assistant_text_delta' && activeTurn) {
    transcriptByTurn.set(activeTurn, (transcriptByTurn.get(activeTurn) || '') + event.text)
  }
}

async function runTurn(adapter, threadId, text) {
  const result = await adapter.sendTurn({ threadId, text, images: [] })
  activeTurn = result.turnId
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn ${result.turnId} did not complete in 120s`)), 120_000)
    const unsub = adapter.onEvent(event => {
      if (event.type === 'turn_completed' && event.turnId === result.turnId) {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    })
  })
  activeTurn = null
  return result.turnId
}

const started = await startCodexSession({
  cwd: process.cwd(),
  clientInfo: { name: 'rewind-probe', title: 'Rewind probe', version: '0' },
  onEvent,
})
const adapter = started.adapter ?? started
const threadId = started.threadId
console.log(`session up, thread ${threadId}`)

try {
  const turn1 = await runTurn(adapter, threadId, 'Remember the word MAPLE. Reply only: noted.')
  const turn2 = await runTurn(adapter, threadId, 'Also remember the word GRANITE. Reply only: noted.')
  const turn3 = await runTurn(adapter, threadId, 'Also remember the word VELVET. Reply only: noted.')
  console.log(`three turns done: ${turn1.slice(0, 8)} ${turn2.slice(0, 8)} ${turn3.slice(0, 8)}`)

  const forked = await adapter.forkThread(threadId, { lastTurnId: turn2, cwd: process.cwd() })
  const forkedThread = forked.threadId ?? forked
  console.log(`forked at turn 2 -> thread ${String(forkedThread).slice(0, 12)}`)

  const askTurn = await runTurn(adapter, forkedThread, 'List every word you were asked to remember, comma separated, nothing else.')
  const answer = (transcriptByTurn.get(askTurn) || '').trim()
  console.log(`fork remembers: "${answer}"`)

  const hasMaple = /maple/i.test(answer)
  const hasGranite = /granite/i.test(answer)
  const hasVelvet = /velvet/i.test(answer)
  const verdict = hasMaple && hasGranite && !hasVelvet
  console.log(JSON.stringify({ verdict: verdict ? 'PASS' : 'FAIL', hasMaple, hasGranite, hasVelvet }))
  process.exitCode = verdict ? 0 : 1
} finally {
  try { await (started.close?.() ?? adapter.close?.()) } catch {}
}
