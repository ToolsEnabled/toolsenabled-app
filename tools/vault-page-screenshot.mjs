#!/usr/bin/env node
/* LAUNCH A PRIVATE CANDIDATE, GO TO #/vault, AND PHOTOGRAPH WHAT A PERSON SEES.
 *
 * WHY A SCREENSHOT IS NOT REDUNDANT WITH THE SUITE. The page's unit suite runs
 * against tools/test/lib/dom-stand-in.mjs, which has no CSS cascade -- so it can
 * say what the page CONTAINS and is structurally incapable of noticing that it
 * draws unstyled, off-screen, or behind something. The defect that started this
 * work was precisely a visibility one: the owner could not SEE the vault
 * anywhere. A rendered frame is the only evidence that answers his complaint.
 *
 * PRIVATE, AND THAT MATTERS. `--user-data-dir` sends Electron's userData -- and
 * therefore this app's whole state root, its vault path and its policy file --
 * into a fresh temporary directory. The candidate cannot read or damage the
 * owner's real state, and nothing it writes outlives the run.
 *
 * MC_SMOKE_HEADLESS IS DELIBERATELY NOT SET. It suppresses the window, and a
 * suppressed window screenshots as an empty frame that looks like a rendering
 * failure. The candidate is launched with a real window and captured over CDP.
 *
 *   node tools/vault-page-screenshot.mjs [--out <file.png>] [--route '#/vault']
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}
const ROUTE = argOf('--route', '#/vault')
const OUT = path.resolve(argOf('--out', path.join(APP_ROOT, `vault-page-${ROUTE.replace(/\W+/g, '') || 'root'}.png`)))
/* Port 0 is not an option for Electron's debugger, so take one the OS is very
   unlikely to have in use and fail loudly rather than silently attaching to
   someone else's browser. */
const PORT = Number(argOf('--port', '9333'))

/* TWO MODES, BECAUSE THIS APP REFUSES TO RUN ELEVATED -- BY DESIGN.
 *
 * shell/main.cjs stops with ELEVATED_APP_RUNTIME when its process holds
 * administrator rights, so a candidate cannot be spawned as a child of an
 * elevated shell: it exits before a window exists. `--attach` therefore skips
 * the spawn and drives a candidate somebody else started non-elevated (on
 * Windows, by handing a launcher to explorer.exe, which owns the desktop's
 * medium-integrity token). `--seed-only` prepares that candidate's private
 * userData so the launcher has something to point at.
 *
 * Both modes take the SAME userData directory, which is why it is a flag rather
 * than always a fresh temporary one. */
const ATTACH = process.argv.includes('--attach')
const SEED_ONLY = process.argv.includes('--seed-only')
const userData = path.resolve(argOf('--user-data', mkdtempSync(path.join(os.tmpdir(), 'laneD-candidate-'))))
mkdirSync(userData, { recursive: true })
/* NO renderer-prefs.json IS SEEDED, and that is a correction rather than an
   omission. A first attempt wrote a guessed shape to pre-dismiss the update
   dialog; the shell rejected it as unreadable, kept it aside as
   `renderer-prefs.damaged-<timestamp>.json`, and drew a "Your saved settings
   could not be read" banner across the bottom of the frame -- so the seeding
   intended to clean the screenshot up was the only thing dirtying it. A fresh
   profile with no such file starts on defaults, quietly. */

/* SEED THE PRIVATE CANDIDATE'S OWN STORE, so the frame shows the page doing its
 * whole job rather than its empty state. Two record NAMES and one decision.
 *
 * NO CREDENTIAL VALUE IS WRITTEN OR NEEDED, and that is the point rather than a
 * shortcut: this page has no verb that returns one, so a record's presence is
 * the only thing it renders. The placeholder text below sits where a value would
 * be and is not a secret, is not derived from one, and is never displayed.
 * The state root is the same one shell/main.cjs derives -- userData/capability --
 * so these are the real files the real readers open. */
const stateRoot = path.join(userData, 'capability')
mkdirSync(path.join(stateRoot, 'vault'), { recursive: true })
mkdirSync(path.join(stateRoot, 'state'), { recursive: true })
writeFileSync(path.join(stateRoot, 'vault', 'secrets.json'), JSON.stringify({
  stripe_secret_key: 'not-a-credential-placeholder',
  github_pat: 'not-a-credential-placeholder'
}), 'utf8')
/* One nicknamed record and one role turned off, so the frame evidences both
   features at once: a real name replaced on screen, and a deny drawn as a deny. */
writeFileSync(path.join(stateRoot, 'state', 'vault-access-policy.json'), JSON.stringify({
  version: 1,
  records: {
    stripe_secret_key: { nickname: 'the card one', access: { builder: false } },
    github_pat: { nickname: null, access: { worker: false } }
  }
}), 'utf8')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function targetList() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await response.json()
  } catch { return null }
}

/** Wait for the renderer window to be debuggable. */
async function awaitPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await targetList()
    const page = Array.isArray(list)
      ? list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
      : null
    if (page) return page
    await sleep(500)
  }
  return null
}

/** A minimal CDP client over the built-in WebSocket. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 0
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', event => reject(new Error(`CDP socket failed: ${event.message || 'unknown'}`)))
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (!settle) return
    pending.delete(message.id)
    if (message.error) settle.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    else settle.resolve(message.result)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { socket.close() } catch { /* already gone */ } }
  }
}

const electron = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
console.log(`electron : ${electron}`)
console.log(`userData : ${userData}   (private; discarded is fine)`)
console.log(`route    : ${ROUTE}`)

if (SEED_ONLY) {
  console.log(`\nseeded. launch the candidate non-elevated with:`)
  console.log(`  "${electron}" . --user-data-dir=${userData} --remote-debugging-port=${PORT}`)
  console.log(`  (cwd ${APP_ROOT})`)
  process.exit(0)
}

let childLog = ''
let child = null
if (!ATTACH) {
  child = spawn(electron, [
    '.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`
  ], { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
  child.stdout.on('data', chunk => { childLog += chunk })
  child.stderr.on('data', chunk => { childLog += chunk })
} else {
  console.log(`mode     : attaching to a candidate already running on port ${PORT}`)
}

let exitCode = 1
let client = null
try {
  const page = await awaitPageTarget(90_000)
  if (!page) throw new Error(`no debuggable page appeared on port ${PORT} within 90s.\n--- candidate output ---\n${childLog}`)
  console.log(`target   : ${page.title || page.url}`)

  client = connect(page.webSocketDebuggerUrl)
  await client.ready
  await client.send('Page.enable')
  await client.send('Runtime.enable')

  /* ANSWER THE FIRST-RUN QUESTION FIRST, because a fresh profile has one and
     the router enforces it: src/main.js sends every route to `#/setup` while
     `shouldOpenSetup` holds, so a screenshot taken before this photographs the
     setup question. Answering it through `mcSetup.chooseTier` is the step a
     person actually performs on first launch -- the same IPC the setup screen's
     own button calls -- rather than a flag that skips the gate. */
  const setupState = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      if (!window.mcSetup?.bootstrap?.available) return 'setup-unavailable';
      if (window.mcSetup.bootstrap.configured) return 'already-configured';
      const answer = await window.mcSetup.chooseTier('guided', null);
      return 'chose-guided:' + JSON.stringify(answer);
    })()`,
    awaitPromise: true, returnByValue: true
  })
  console.log(`setup    : ${setupState.result.value}`)

  /* SETUP_RESOLUTION is resolved once while the module graph evaluates, so a
     page that was loaded BEFORE the answer was recorded still believes the
     question is open, and only a reload makes the router read the answer.
     A candidate that was already configured at load time needs no reload -- and
     must not be given one: the reload tears down this CDP session mid-navigation
     ("ERR_ABORTED"), which is how the first re-capture attempt lost its
     connection after the screenshot fix had already landed. */
  if (setupState.result.value !== 'already-configured') {
    await client.send('Page.reload', { ignoreCache: false })
    await sleep(6000)
  }

  /* Navigate the way a person does -- by changing the address -- rather than by
     reloading into it, so what is captured is the router doing its job. */
  await client.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(ROUTE)}`, awaitPromise: false })

  /* WAIT FOR THE READ TO SETTLE, DO NOT GUESS AT IT. The vault listing spawns
     powershell.exe, which on a loaded machine takes many seconds; a fixed pause
     photographed the page mid-read ("Reading what this computer's vault holds.")
     and a reader would have taken that frame for the finished article. Poll for
     the page's own completion signal -- the status line clearing, or a row
     appearing -- and report honestly if it never comes. */
  const settledBy = Date.now() + 60_000
  let settled = false
  while (Date.now() < settledBy) {
    const state = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        rows: document.querySelectorAll('.vault-page-row').length,
        status: document.querySelector('[data-vault-status]')?.textContent || ''
      })`,
      returnByValue: true
    })
    const { rows, status } = JSON.parse(state.result.value)
    if (rows > 0 || (status && status !== 'Reading what this computer’s vault holds.')) { settled = true; break }
    await sleep(1000)
  }
  console.log(`read     : ${settled ? 'settled' : 'STILL READING after 60s -- the frame below is mid-read'}`)
  await sleep(1000)

  /* Read back what the page believes it is showing, so the screenshot is
     accompanied by the route and heading it was taken at rather than being an
     unlabelled image. */
  const probe = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hash: location.hash,
      heading: document.querySelector('.vault-page h1')?.textContent || null,
      shown: [...document.querySelectorAll('[data-vault-shown]')].map(n => n.textContent),
      matrixCells: document.querySelectorAll('[data-vault-role]').length,
      rows: document.querySelectorAll('.vault-page-row').length,
      status: document.querySelector('[data-vault-status]')?.textContent || null,
      navHasVault: Boolean(document.querySelector('[data-route=vault]')),
      crumb: document.querySelector('#crumb, .crumb')?.textContent || null
    })`,
    returnByValue: true
  })
  console.log(`page     : ${probe.result.value}`)

  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot: ${OUT}`)
  exitCode = 0
} catch (error) {
  console.error(`FAILED: ${error.message}`)
} finally {
  client?.close()
  /* An attached candidate belongs to whoever launched it; killing it would take
     away the thing a person may still be looking at. */
  if (!ATTACH) child?.kill()
}

process.exit(exitCode)
