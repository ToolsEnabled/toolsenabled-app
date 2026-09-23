#!/usr/bin/env node

/* LAUNCH AN AGENT FROM INSIDE THE PRODUCT AND ASK IT WHAT IT CAN DO.
 *
 * THE OWNER'S DIRECTIVE, verbatim: "one thing worth doing is launching an
 * agent from inside and then asking it what it can do. remember anything that
 * it gets stuck on or tools that dont work or get stuck etc need to either be
 * built or fixed or wired correctly."
 *
 * WHAT THIS DRIVES. The product's own launcher -- shell/agent-host.cjs, the
 * module every in-app Start button goes through -- against a scratch
 * installation recorded at a chosen level, with a REAL provider session
 * underneath (the person's own codex/claude sign-in, exactly as the app runs
 * it). It sends the owner's question and, optionally, an exercise turn, and
 * records the full event stream with a deadline so a hang is measured rather
 * than waited on.
 *
 * THE SAME RUN IS THE ACCEPTANCE TEST FOR THE TOOL NOTE: pointed at a payload
 * WITHOUT src/lib/agent-tool-summary.js the session gets no introduction
 * (before); pointed at an engine tree WITH it the first turn carries the note
 * (after), and the agent's answer to "what can you do" is the delta.
 *
 * SCRATCH STATE ONLY. LOCALAPPDATA and TOOLSENABLED_STATE_ROOT are pointed at
 * a temporary directory before anything is required, so the machine record,
 * the confined agent home, and everything the session's MCP servers write land
 * in scratch. The one real thing is the provider sign-in, linked by the
 * product's own mechanism, never read here.
 *
 *   node tools/agent-inside-probe.mjs --engine <root> --tier guided \
 *        --provider codex --label before --exercise --out <dir>
 */

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require_ = createRequire(import.meta.url)

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const ENGINE_ROOT = path.resolve(argOf('engine', path.join(REPO, 'release', 'win-unpacked', 'resources', 'capability')))
const TIER = argOf('tier', 'guided')
const PROVIDER = argOf('provider', 'codex')
const LABEL = argOf('label', 'probe')
const OUT_DIR = path.resolve(argOf('out', path.join(REPO, 'reports', 'agent-tools')))
const EXERCISE = process.argv.includes('--exercise')
const TURN_DEADLINE_MS = Number(argOf('deadline', '300000'))

/* Scratch installation, claimed before any module can decide a root. The
 * selected userData name is deliberately generic: the payload must derive its
 * product directory from <userData>/capability, not from the shipping name. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'inside-probe-'))
const USER_DATA = path.join(SCRATCH, 'probe-userdata')
process.env.TOOLSENABLED_STATE_ROOT = path.join(USER_DATA, 'capability')
process.env.LOCALAPPDATA = path.join(SCRATCH, 'local')
mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true })
mkdirSync(process.env.LOCALAPPDATA, { recursive: true })

const machineRecord = require_(path.join(ENGINE_ROOT, 'src/lib/setup/machine-record.js'))
const { createAgentHost } = require_(path.join(REPO, 'shell/agent-host.cjs'))

const START_TIER_FOR_PROVIDER = { codex: 'luna', claude: 'claude-sonnet' }

const ASK = 'What can you do here? List the tools you actually have available in this session, briefly, and say where that knowledge comes from.'

const EXERCISE_TEXT = [
  'Do each of the following with your ToolsEnabled MCP tools and report each outcome exactly:',
  '1) Read the file notes.txt in your working folder and follow the instruction inside it; report the token you find.',
  '2) Call system.doctor and say in one line whether a GitHub credential is configured on this computer.',
  '3) Try to ask for a GitHub credential to be added (system.credential_request). If you cannot, quote the exact reason.',
  'Number your answers.',
].join('\n')

function stamp() { return new Date().toISOString() }

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const eventsFile = path.join(OUT_DIR, `${LABEL}-${PROVIDER}-${TIER}.events.jsonl`)
  const summaryFile = path.join(OUT_DIR, `${LABEL}-${PROVIDER}-${TIER}.summary.json`)
  writeFileSync(eventsFile, '')

  /* Ask the measured payload. A literal product name here makes a renamed or
   * portable build seed one machine record while the launched agent reads a
   * different one. */
  const servicesRoot = machineRecord.resolveServicesRoot({})
  const workspace = path.join(SCRATCH, 'home', 'AI Workspace')
  mkdirSync(workspace, { recursive: true })
  const token = `probe-${Math.random().toString(36).slice(2, 10)}`
  writeFileSync(path.join(workspace, 'notes.txt'), 'The token you need is in the file token.txt beside this one. Read it.\n')
  writeFileSync(path.join(workspace, 'token.txt'), `${token}\n`)

  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier: TIER,
    servicesRoot,
    installRoot: ENGINE_ROOT,
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  }), { servicesRoot })
  console.log(`[${stamp()}] recorded level "${TIER}"; engine ${ENGINE_ROOT}`)
  console.log(`[${stamp()}] scratch ${SCRATCH}`)
  console.log(`[${stamp()}] iteration token planted: ${token}`)

  const host = createAgentHost({ enginePath: path.join(ENGINE_ROOT, 'src/lib/agent-engine/codex-process.js'), defaultCwd: workspace })

  const counters = { events: 0, byType: {}, toolCycles: 0, textChars: 0 }
  const finished = new Map() // turnId -> resolve
  let liveText = ''
  host.onEvent(packet => {
    counters.events += 1
    const type = packet && packet.event && packet.event.type
    counters.byType[type] = (counters.byType[type] || 0) + 1
    const event = packet && packet.event
    try { appendFileSync(eventsFile, `${JSON.stringify({ at: Date.now(), event })}\n`) } catch { /* the stream outlives a bad write */ }
    if (!event) return
    /* The engine contract's own vocabulary, learned from a recorded run rather
       than assumed: tool_call / tool_result carry the cycle, assistant_text is
       the finished message, assistant_text_delta streams it. */
    if (event.type === 'tool_call' || event.type === 'tool_result') counters.toolCycles += 1
    if (event.type === 'assistant_text_delta' && typeof event.text === 'string') counters.textChars += event.text.length
    if (event.type === 'assistant_text' && typeof event.text === 'string') {
      liveText = liveText ? `${liveText}\n\n${event.text}` : event.text
    }
    if (event.type === 'turn_completed' || event.type === 'turn.completed' || event.type === 'turn_failed') {
      const id = event.turnId || (event.turn && event.turn.id) || null
      for (const [turnId, resolve] of finished) {
        if (id === null || turnId === id) { finished.delete(turnId); resolve({ done: true, status: event.status || null }) }
      }
    }
  })

  const startTier = START_TIER_FOR_PROVIDER[PROVIDER]
  const startedAt = Date.now()
  const started = await host.startSession({ sessionId: `probe-${LABEL}-${PROVIDER}`, tier: startTier })
  console.log(`[${stamp()}] session started (+${Date.now() - startedAt}ms): thread ${started.threadId}`)

  async function turn(text, name) {
    liveText = ''
    const turnStart = Date.now()
    const cyclesBefore = counters.toolCycles
    const accepted = await host.sendTurn({ sessionId: `probe-${LABEL}-${PROVIDER}`, text })
    const completion = new Promise(resolve => finished.set(accepted.turnId, resolve))
    const outcome = await Promise.race([
      completion,
      new Promise(resolve => setTimeout(() => resolve({ done: false }), TURN_DEADLINE_MS)),
    ])
    const record = {
      name,
      turnId: accepted.turnId,
      verdict: outcome.done ? 'COMPLETED' : `HUNG (no turn_completed within ${TURN_DEADLINE_MS / 1000}s)`,
      status: outcome.status || null,
      durationMs: Date.now() - turnStart,
      toolCycles: counters.toolCycles - cyclesBefore,
      answer: liveText.slice(0, 6000),
    }
    console.log(`\n[${stamp()}] turn "${name}": ${record.verdict} in ${record.durationMs}ms, ${record.toolCycles} tool cycle(s)`)
    console.log(`--- answer ---\n${record.answer}\n--------------`)
    return record
  }

  const turns = []
  try {
    turns.push(await turn(ASK, 'what-can-you-do'))
    if (EXERCISE) turns.push(await turn(EXERCISE_TEXT, 'exercise'))
  } finally {
    try { await host.closeAll() } catch { /* the child may already be gone */ }
  }

  const summary = {
    label: LABEL, provider: PROVIDER, tier: TIER, engineRoot: ENGINE_ROOT,
    plantedToken: token, scratch: SCRATCH,
    events: counters.events, eventTypes: counters.byType, turns,
  }
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2))
  console.log(`\n[${stamp()}] wrote ${summaryFile}`)
  console.log(`[${stamp()}] events: ${counters.events}; types: ${JSON.stringify(counters.byType)}`)
  const iterated = turns.some(t => t.name === 'exercise' && t.answer.includes(token))
  if (EXERCISE) console.log(`[${stamp()}] iteration token ${iterated ? 'RECOVERED — the model followed the file chain' : 'not recovered'}`)
}

main().catch(error => {
  console.error(`the probe itself failed: ${error?.stack || error}`)
  process.exitCode = 2
})
