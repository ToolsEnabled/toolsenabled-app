#!/usr/bin/env node

/* THE POSITIVE CONTROL FOR "A CLAUDE SESSION STARTS AND NEVER ANSWERS".
 *
 * WHY THIS FILE EXISTS. Driving the packaged product showed a Claude node stuck
 * at `running` for four minutes with a real sessionId, a real claude.exe child
 * alive under the app's own pid, a textbook-correct command line -- and no
 * reply and no error. That observation is CONSISTENT WITH several different
 * causes and proves none of them: the engine's stdin framing, the CLI itself,
 * the scratch home, the confined environment, or the app's event mapping.
 * Reporting the first guess as the cause is this project's named failure mode.
 *
 * SO THIS REMOVES EXACTLY ONE VARIABLE: THE APPLICATION. It requires the SAME
 * packed engine module the payload ships, with the SAME kind of scratch home
 * and the SAME copied sign-in, and asks it the same question directly.
 *
 *   it answers here  -> the engine and the CLI are fine, and the defect is in
 *                       the app layer above them (confinement env, event
 *                       mapping, or the turn never being sent).
 *   it hangs here    -> the defect is in the engine module or its use of the
 *                       CLI, and the app is innocent.
 *
 * Either way the answer is a fact rather than a hypothesis, which is the whole
 * point of running it.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = path.join(REPO, 'capability', 'src', 'lib', 'agent-engine', 'claude-cli-process.js')

const ANSWER = '391'
const QUESTION = 'What is 17 multiplied by 23? Reply with only the number.'
const BUDGET_MS = Number(process.env.PROBE_BUDGET_MS || 300_000)

const stamp = () => new Date().toISOString().slice(11, 23)
const log = text => console.log(`[${stamp()}] ${text}`)

async function main() {
  if (QUESTION.includes(ANSWER)) throw new Error('the answer is inside the question; refusing to measure')
  if (!existsSync(ENGINE)) throw new Error(`no packed engine at ${ENGINE}`)

  const scratch = path.join(tmpdir(), `claude-control-${crypto.randomBytes(5).toString('hex')}`)
  const home = path.join(scratch, 'home')
  const roaming = path.join(scratch, 'roaming')
  const workspace = path.join(scratch, 'workspace')
  for (const leaf of [home, roaming, workspace, path.join(home, '.claude')]) mkdirSync(leaf, { recursive: true })

  /* The same two files the driver copies, for the same reason: the child reads
     the home it is given, and this run gives it a scratch one. Never opened here. */
  const realHome = process.env.USERPROFILE || ''
  copyFileSync(path.join(realHome, '.claude', '.credentials.json'), path.join(home, '.claude', '.credentials.json'))
  const settings = path.join(realHome, '.claude.json')
  if (existsSync(settings)) copyFileSync(settings, path.join(home, '.claude.json'))

  /* And the npm layout, because resolveInvocation() prefers the native
     claude.exe under %APPDATA%/npm and a redirected APPDATA empties it. */
  let link = null
  const realNpm = path.join(process.env.APPDATA || '', 'npm')
  const scratchNpm = path.join(roaming, 'npm')
  if (existsSync(realNpm)) { symlinkSync(realNpm, scratchNpm, 'junction'); link = scratchNpm }

  const env = { ...process.env }
  env.USERPROFILE = home
  env.APPDATA = roaming
  env.LOCALAPPDATA = path.join(scratch, 'local')
  delete env.ELECTRON_RUN_AS_NODE
  /* The engine scrubs these itself; deleted here too so the control cannot
     accidentally answer on an API key instead of the subscription. */
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[name]

  const engine = require_(ENGINE)
  log(`engine exports: ${Object.keys(engine).join(', ')}`)

  const events = []
  let answered = null
  const started = Date.now()

  const session = engine.startClaudeSession({
    cwd: workspace,
    env,
    /* The `standard` level's own two values, which is what
       agent-session-confinement.js resolves that level to. The CLI's
       --permission-mode is DERIVED from them by permissionModeFor(); passing
       claudePermissionMode directly is rejected by the engine contract, and
       this probe's first run did exactly that and blamed the engine for it. */
    threadOptions: { model: 'sonnet', sandbox: 'workspace-write', approvalPolicy: 'never' },
    onEvent: event => {
      const kind = event?.type || event?.method || 'unknown'
      events.push({ at: Date.now() - started, kind })
      const text = JSON.stringify(event).slice(0, 260)
      log(`event ${kind}: ${text}`)
      if (JSON.stringify(event).includes(ANSWER)) answered = answered || (Date.now() - started)
    },
  })
  log(`startClaudeSession returned: ${session && typeof session === 'object' ? Object.keys(session).join(', ') : String(session)}`)

  const handle = session && typeof session.then === 'function' ? await session : session
  log(`session handle: ${handle && typeof handle === 'object' ? Object.keys(handle).join(', ') : String(handle)}`)

  /* THE TURN GOES THROUGH THE ADAPTER, which is what shell/agent-host.cjs does:
     session.adapter.sendTurn({threadId, text, images}). The handle carries the
     adapter and the threadId; there is no send() on the handle itself, and a
     probe that invented one would have reported "the engine has no way to ask
     it anything" about its own mistake. */
  if (handle?.adapter && typeof handle.adapter.sendTurn === 'function') {
    log(`sending the question on thread ${handle.threadId}: ${JSON.stringify(QUESTION)}`)
    handle.adapter.sendTurn({ threadId: handle.threadId, text: QUESTION, images: [] }).then(
      reply => log(`sendTurn() RESOLVED: ${JSON.stringify(reply).slice(0, 500)}`),
      error => log(`sendTurn() REJECTED: ${error?.code || ''} ${error?.message || error}`),
    )
  } else {
    log(`NO sendTurn ON THE ADAPTER -- handle keys: ${Object.keys(handle || {}).join(', ')}`)
  }

  const until = Date.now() + BUDGET_MS
  while (Date.now() < until && answered === null) await new Promise(r => setTimeout(r, 1500))

  log(`--- ${events.length} event(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  log(answered === null
    ? `NO ANSWER: "${ANSWER}" never appeared in any event within ${(BUDGET_MS / 1000)}s`
    : `ANSWERED after ${(answered / 1000).toFixed(1)}s`)

  try { handle?.close?.() } catch { /* going away anyway */ }
  if (link) { try { unlinkSync(link) } catch { try { rmdirSync(link) } catch { /* gone */ } } }
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* windows */ }
  process.exit(answered === null ? 1 : 0)
}

main().catch(error => {
  console.error(`the control itself failed: ${error?.stack || error}`)
  process.exit(2)
})
