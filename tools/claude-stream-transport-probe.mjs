#!/usr/bin/env node

/* CAN THE OFFICIAL claude CLI HOLD A MULTI-TURN SESSION ON ONE PROCESS?
 *
 * THE QUESTION THIS SETTLES, AND WHY IT WAS WORTH SPENDING MONEY ON. Claude
 * cannot be started from a tree in this product. The reason is NOT the gate at
 * resolveStartTier() in shell/agent-host.cjs -- that gate is honest, and
 * deleting it produces a crash rather than an agent. The reason is that the
 * packaged payload contains no Claude engine at all: capability/src/lib/
 * agent-engine/ holds codex-adapter.js, codex-process.js and engine-contract.js,
 * and nothing else.
 *
 * So somebody has to write one. Before they do, ONE fact decides whether that is
 * a normal build or a bad one, and nobody in this project had measured it:
 *
 *   The LANE path (mission-bridge actions.js) spawns the official binary with
 *   `-p --input-format text`. That is ONE-SHOT: it answers once and exits. A
 *   tree session needs what codex-process.js provides -- a long-lived child
 *   taking turn after turn, streaming events back, interruptible.
 *
 * If `--input-format stream-json` is genuinely multi-turn on one process, a
 * Claude engine is a transport plus an event map, which is a week's honest work.
 * If it exits after the first turn, every turn means a fresh spawn plus
 * `--resume`, re-reading the conversation each time -- slower, more expensive,
 * and a different design. Guessing wrong costs whoever builds it the whole
 * build.
 *
 * MEASURED 2026-08-17 against claude 2.1.186, and the answer is the good one:
 *
 *   turn 1  "Remember the number 41. Reply with only the word ready."  -> "ready"
 *   turn 2  (same process, same stdin) "What number...?"               -> "41"
 *   one session_id across both, child exited 0
 *   event kinds: system, rate_limit_event, assistant, result
 *
 * It remembered across turns on ONE process. A tree-startable Claude engine is a
 * transport plus an event map.
 *
 * THE EVENT MAP THAT FALLS OUT OF THIS, against the seven types in
 * src/lib/agent-engine/engine-contract.js:
 *
 *   assistant (content[].type === 'text')      -> assistant_text
 *   the same, with --include-partial-messages  -> assistant_text_delta
 *   assistant (content[].type === 'tool_use')  -> tool_call
 *   user (content[].type === 'tool_result')    -> tool_result
 *   result                                     -> turn_completed, and `usage`
 *                                                 carries the real figures, so
 *                                                 nothing has to be synthesised
 *   --permission-prompt-tool                   -> approval_request
 *
 * WHY THIS IS A TOOL AND NOT A TEST. It spends real money on a real account and
 * needs a real sign-in, so it must never be in a default target -- the same rule
 * NATIVE-CLAUDE-TRANSPORT-CONTRACT.md sets for live turns. It is here so the
 * next lane can re-run the measurement instead of trusting this comment.
 *
 *   node tools/claude-stream-transport-probe.mjs
 *
 * IT USES THE PERSON'S OWN SIGN-IN AND THAT IS THE COMPLIANT PATH. The recorded
 * council reading of TE-L-0006 is that launching the OFFICIAL CLI is first-party
 * use. What is fenced is @agentclientprotocol/claude-agent-acp -- a third-party
 * wrapper riding the subscription's config directory -- which is what the
 * engine's claude-process.js drives, and why that module is not a candidate for
 * this. Nothing here reads, stores or forwards a credential; it starts the
 * program and the program uses whatever account is signed in.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

/* THE NATIVE BINARY, NOT THE .cmd SHIM, and this is not a preference. Node 22
   refuses to spawn a .cmd without a shell and throws EINVAL -- which is exactly
   the case resolveInvocation() in the engine's process modules exists to handle.
   A first version of this probe hit that and it looked like the CLI was broken;
   it was the harness. */
function claudeExecutable() {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    process.env.CLAUDE_BIN,
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

const executable = claudeExecutable()
if (!executable) {
  console.error('claude is not installed where this probe knows to look. Run: npm install -g @anthropic-ai/claude-code')
  process.exit(2)
}

const events = []
let buffered = ''
let turnsSeen = 0
let sessionId = null
let stderr = ''

const child = spawn(executable, [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--model', 'sonnet',
  /* The most restrictive mode that still answers. This probe is about the
     TRANSPORT, and a probe about a transport must not be able to touch the
     machine it runs on. */
  '--permission-mode', 'plan',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })

function send(text) {
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (!line) continue
    let packet
    try { packet = JSON.parse(line) } catch { events.push({ type: '<unparseable>' }); continue }
    events.push(packet)
    if (packet.session_id && !sessionId) sessionId = packet.session_id
    if (packet.type !== 'result') continue
    turnsSeen += 1
    console.log(`\n--- turn ${turnsSeen}: subtype=${packet.subtype} is_error=${packet.is_error} result=${JSON.stringify(packet.result).slice(0, 120)}`)
    if (turnsSeen === 1) {
      /* THE DECISIVE MOMENT: a second user message down the SAME stdin. If the
         child is gone or ignores it, this is a one-shot transport. */
      console.log('>>> second turn, same process, same stdin...')
      send('What number did I just ask you to remember? Answer with only the number.')
    } else {
      child.stdin.end()
    }
  }
})

child.on('exit', code => {
  const kinds = {}
  for (const event of events) kinds[event.type] = (kinds[event.type] || 0) + 1
  const said = events
    .filter(event => event.type === 'assistant')
    .flatMap(event => (event.message?.content || []).filter(part => part.type === 'text').map(part => part.text.trim()))

  console.log(`\n=== exited ${code} ===`)
  console.log(`one session_id across the run: ${sessionId}`)
  console.log(`turns completed on ONE process:  ${turnsSeen}`)
  console.log(`event kinds:                     ${JSON.stringify(kinds)}`)
  console.log(`assistant said:                  ${JSON.stringify(said)}`)
  if (stderr) console.log(`stderr tail: ${stderr.slice(-400)}`)

  /* The memory across turns is the real assertion, not the turn count. Two
     `result` packets could also mean two independent one-shot conversations
     that happened to share a pipe; only the second answer recalling the first
     turn's number proves it is ONE conversation. */
  const remembered = said.some(text => text.includes('41'))
  const multiTurn = turnsSeen >= 2 && remembered
  console.log(`\nVERDICT: ${multiTurn
    ? 'MULTI-TURN ON ONE PROCESS, with memory across turns. A tree engine is a transport plus an event map.'
    : 'NOT PROVEN multi-turn. A tree engine would need a spawn per turn with --resume.'}`)
  process.exitCode = multiTurn ? 0 : 1
})

console.log('>>> first turn...')
send('Remember the number 41. Reply with only the word ready.')
