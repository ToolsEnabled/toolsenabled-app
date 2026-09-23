#!/usr/bin/env node
/* SIGN IN WITH GOOGLE, AGAINST GOOGLE, IN THE PACKAGED PRODUCT.
 *
 * WHAT THIS IS AND WHY IT IS SEPARATE FROM THE OTHER ONE.
 * tools/google-signin-packaged-qa.mjs runs the packaged window against a LOCAL
 * identity provider, and says so on every line, because a run that cannot be
 * told apart from a real one is worse than no run. This file is the other half:
 * the same packaged window, the same button, but Google's own authorization
 * server, Google's own token endpoint and Google's own JWKS. Nothing here is
 * simulated except the hand that clicks in the browser.
 *
 * WHAT IT PROVES THAT THE LOCAL-PROVIDER RUN CANNOT. That Google ACCEPTS this
 * product's registration: the client id, the ephemeral loopback redirect, the
 * S256 challenge, the identity-only scopes, and the exchange. Those are facts
 * about Google's servers and no local provider can stand in for them.
 *
 * WHAT IT NEEDS, AND WHY NOTHING SECRET IS IN THIS FILE.
 *   TOOLSENABLED_GOOGLE_CLIENT_ID       the Desktop-app client id (public)
 *   TOOLSENABLED_GOOGLE_CLIENT_SECRET   its client secret
 *   LIVE_GOOGLE_EMAIL                   the account to sign in as
 *   CDP_ENDPOINT                        a ToolsEnabled-owned Chrome already
 *                                       signed in to that account
 * They are read from the environment at run time and written only into a
 * throwaway profile that this file deletes. No value is ever printed.
 *
 * THE CLIENT SECRET IS NOT A CONTRADICTION. Google refuses a Desktop-app code
 * exchange that omits it -- `invalid_request: client_secret is missing.` -- and
 * documents that for installed apps the value "is obviously not treated as a
 * secret". PKCE is what proves possession; see shell/google-signin.cjs.
 *
 * A REAL GOOGLE ACCOUNT IS INVOLVED, which is the point, and it is why this is
 * not part of the default suite: it needs a signed-in browser and a person's
 * real identity, and it leaves a genuine grant on that account.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE } from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const CLIENT_ID = (process.env.TOOLSENABLED_GOOGLE_CLIENT_ID || '').trim()
const CLIENT_SECRET = (process.env.TOOLSENABLED_GOOGLE_CLIENT_SECRET || '').trim()
const EMAIL = (process.env.LIVE_GOOGLE_EMAIL || '').trim()
const CDP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:42217'

const results = []
let failures = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}
const note = text => results.push(`  ·   ${text}`)

/* ------------------------------- the browser ------------------------------- */

async function browserTab(url) {
  const created = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!created.ok) throw new Error(`the owned browser would not open a tab: HTTP ${created.status}`)
  const target = await created.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data)
    const handler = pending.get(packet.id)
    if (handler) { pending.delete(packet.id); handler(packet) }
  })
  const send = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise(resolve => pending.set(id, resolve))
  }
  const evaluate = async expression => {
    const packet = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (packet?.result?.exceptionDetails) return null
    return packet?.result?.result?.value
  }
  return {
    id: target.id,
    evaluate,
    send,
    /* Google's chooser rows are <div role="link"> inside an inert <li>. Calling
       .click() on the wrong one does nothing, silently, forever. Mouse events at
       the element's own centre are what a person's hand does. */
    async clickAt(selector) {
      const spot = await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        if (!n) return null
        n.scrollIntoView({ block: 'center' })
        const b = n.getBoundingClientRect()
        return (b.width < 1 || b.height < 1) ? null : { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      })()`)
      if (!spot) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      }
      return true
    },
    async close() {
      try { socket.close() } catch { /* gone */ }
      try { await fetch(`${CDP}/json/close/${target.id}`) } catch { /* gone */ }
    },
  }
}

/* Completes Google's own screens as the named account. Returns why it stopped. */
async function completeGoogleSignIn(url, log) {
  const tab = await browserTab(url)
  try {
    const deadline = Date.now() + 150000
    let lastUrl = ''
    let clickedAt = 0
    while (Date.now() < deadline) {
      await delay(1500)
      const here = String(await tab.evaluate('location.href') || '')
      const body = String(await tab.evaluate('document.body ? document.body.innerText.slice(0, 2500) : ""') || '')
      if (here.split('?')[0] !== lastUrl) { lastUrl = here.split('?')[0]; log(`browser → ${lastUrl}`) }
      if (here.startsWith('http://127.0.0.1:')) return { done: 'callback', page: body }
      if (/Access blocked|verification process|Error 403|access_denied/i.test(body)) return { done: 'blocked', page: body }
      if (/Enter your password|Forgot password\?/i.test(body)) return { done: 'password-required', page: body }
      if (Date.now() - clickedAt < 3500) continue
      if (await tab.clickAt(`div[role="link"][data-identifier="${EMAIL}"]`)) { clickedAt = Date.now(); continue }
      const labelled = await tab.evaluate(`(() => {
        const hit = [...document.querySelectorAll('button, div[role="button"]')]
          .find(n => ['Continue', 'Allow'].includes((n.innerText || '').trim()))
        if (!hit) return null
        hit.setAttribute('data-live-harness-target', '1')
        return (hit.innerText || '').trim()
      })()`)
      if (labelled && await tab.clickAt('[data-live-harness-target="1"]')) { clickedAt = Date.now() }
    }
    return { done: 'timed-out', page: '' }
  } finally {
    await tab.close()
  }
}

/* ------------------------------ the packaged app ------------------------------ */

/* WAS A SEVENTH COPY OF THE SAME RULE, AND OFF WINDOWS EVERY COPY WAS WRONG.
   This function read `.exe` out of the app root; a Linux candidate has none, so
   it refused before measuring anything. tools/lib/packaged-platform.mjs owns
   the one answer -- the same Windows launcher-by-shape logic, plus an ELF
   branch that opens the file with O_NOFOLLOW and checks the magic. */

async function stage(scratch) {
  // A selected release must be measured as shipped. In particular, do not add
  // the client-secret forwarding shim and then credit a broken candidate.
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    const selected = await stageRelease(scratch)
    return { executable: selected.executable, app: selected.appRoot,
      shim: 'not-applied-exact-release', stageMode: selected.stageMode,
      sourceRelease: selected.sourceRelease }
  }
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  const shim = applyMainShim(path.join(unpacked, 'shell', 'main.cjs'))
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  return { executable: appExecutable(app), app, shim, stageMode: 'source-overlay', sourceRelease: RELEASE }
}

/* A ONE-LINE SHIM WITH AN EXPIRY DATE, applied to the STAGED copy and never to
 * the tree.
 *
 * shell/main.cjs has to hand the configured client secret to createGoogleSignIn
 * or Google refuses the exchange. That single line was written while main.cjs
 * was fenced for another lane, so it is returned as an edit rather than applied,
 * and this stands in so the live run can prove the edit is the right one. The
 * moment the real line lands, this finds it already there and does nothing --
 * so this function deletes itself in practice, and the check below fails loudly
 * if the file ever drifts out from under it. */
function applyMainShim(mainFile) {
  const source = readFileSync(mainFile, 'utf8')
  if (/clientSecret:\s*config\.clientSecret/.test(source)) return 'already-present'
  const anchor = '      clientId: config.clientId,\n'
  if (!source.includes(anchor)) throw new Error('shell/main.cjs no longer matches the shim anchor; apply the clientSecret line for real and delete applyMainShim().')
  writeFileSync(mainFile, source.replace(anchor, `${anchor}      clientSecret: config.clientSecret,\n`))
  return 'staged-shim-applied'
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

function environmentFor(profile) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  delete environment.TOOLSENABLED_VAULT_PATH
  delete environment.TOOLSENABLED_STATE_ROOT
  /* MUST BE ABSENT. The point of this run is the per-installation configuration
     file a customer's copy actually reads; an environment id would override it
     and prove the wrong path. */
  delete environment.TOOLSENABLED_GOOGLE_CLIENT_ID
  delete environment.TOOLSENABLED_GOOGLE_CLIENT_SECRET
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.APPDATA = path.join(profile, 'roaming')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.APPDATA, { recursive: true })
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  return environment
}

const userDataFor = profile => path.join(profile, 'userdata')

async function openWindow(executable, profile) {
  const port = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataFor(profile)}`], {
    env: environmentFor(profile), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let socket = null
  let nextId = 1
  const pending = new Map()
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before the debugger answered`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        socket.addEventListener('message', event => {
          const packet = JSON.parse(event.data)
          const handler = pending.get(packet.id)
          if (handler) { pending.delete(packet.id); handler(packet) }
        })
        break
      }
    } catch { /* not listening yet */ }
    await delay(500)
  }
  if (!socket) throw new Error('no debuggable page appeared within 90s')
  const send = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise(resolve => pending.set(id, resolve))
  }
  const evaluate = async expression => {
    const packet = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return packet?.result?.result?.value
  }
  await delay(2200)
  return {
    child,
    evaluate,
    async click(selector) {
      const spot = await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        if (!n) return { state: 'absent' }
        const b = n.getBoundingClientRect()
        const s = getComputedStyle(n)
        if (s.display === 'none' || s.visibility === 'hidden') return { state: 'hidden' }
        if (b.width < 1 || b.height < 1) return { state: 'zero-size' }
        return { state: 'visible', x: b.x + b.width / 2, y: b.y + b.height / 2, disabled: n.disabled === true }
      })()`)
      if (spot?.state !== 'visible') return spot?.state || 'absent'
      if (spot.disabled) return 'disabled'
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      }
      await delay(400)
      return 'clicked'
    },
    async close() {
      try { socket.close() } catch { /* gone */ }
      try {
        if (child.exitCode === null) {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          await delay(1200)
        }
      } catch { /* nothing to reap */ }
    },
  }
}

const screenText = window => window.evaluate(
  '(() => { const n = document.querySelector("[data-account-section]") || document.querySelector("[data-setup-section]");'
  + ' return n ? n.innerText : "(no screen)" })()',
)

/* A sterile profile opens on the permission question, and the router refuses
   every other route until a level is recorded. Pressing Continue is what a
   person does, and it is what makes #/account reachable. */
async function openAccountScreen(window) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await window.evaluate('location.hash') === '#/setup') break
    await delay(400)
  }
  await window.evaluate('(() => { const n = document.querySelector("[data-setup-continue]"); if (n) n.click(); return !!n })()')
  await delay(1500)
  await window.evaluate('location.hash = "#/account"')
  await delay(1400)
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const text = await screenText(window)
    if (/Who is using this copy|Signed in as/i.test(text)) return text
    await delay(400)
  }
  return screenText(window)
}

/* --------------------------------- the run --------------------------------- */

async function main() {
  if (!CLIENT_ID) throw new Error('TOOLSENABLED_GOOGLE_CLIENT_ID is not set; this run needs a real Desktop-app client id.')
  if (!EMAIL) throw new Error('LIVE_GOOGLE_EMAIL is not set; this run needs the account to sign in as.')

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'google-live-qa-'))
  const profile = path.join(scratch, 'profile')
  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  let window = null
  const started = Date.now()
  const log = text => note(`${String(Date.now() - started).padStart(6)}ms  ${text}`)

  try {
    const { executable, shim, sourceRelease, stageMode } = await stage(scratch)
    note(`packaged build staged from ${sourceRelease}; staging: ${stageMode}`)
    note(shim === 'not-applied-exact-release'
      ? 'the selected candidate is unchanged; no client-secret shim was applied or inferred'
      : shim === 'already-present'
      ? 'shell/main.cjs already passes the client secret — no shim was needed'
      : 'shell/main.cjs was shimmed IN THE STAGED COPY ONLY (one line; the tree is untouched)')

    /* THE PER-INSTALLATION FILE, the one a customer's copy reads. It carries the
       secret Google requires; it lives in a throwaway profile that this file
       deletes, and its contents are never printed. */
    writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify({
      clientId: CLIENT_ID,
      ...(CLIENT_SECRET ? { clientSecret: CLIENT_SECRET } : {}),
    }, null, 2))

    window = await openWindow(executable, profile)
    const opening = await openAccountScreen(window)
    check('the account screen is reachable in the packaged build', /Who is using this copy|Signed in as/i.test(opening))

    const availability = await window.evaluate('window.mcAccount ? window.mcAccount.googleAvailability() : null')
    check('the packaged product says Google sign-in is available', availability?.ok === true && availability?.available === true,
      availability?.code || '')
    check('the client id came from the per-installation file', availability?.source === 'installation', `source=${availability?.source}`)
    /* THE WHOLE POINT. A run against the local provider carries this; a real one
       must not, or the two runs are indistinguishable. */
    check('NO test-provider banner — this is Google, not a local stand-in', !availability?.testProvider,
      availability?.testProvider ? JSON.stringify(availability.testProvider) : 'none')
    check('the sign-in screen does not announce a test service', !/test service|not Google/i.test(opening))

    const pressed = await window.click('[data-google-signin-start]')
    check('the shipped "Sign in with Google" button was pressed', pressed === 'clicked', pressed)

    /* The address the product actually sent a browser to — read from the
       product, not constructed here, so what Google sees is the product's. */
    let address = null
    for (let attempt = 0; attempt < 40 && !address; attempt += 1) {
      const reply = await window.evaluate('window.mcAccount.googleUrl()')
      if (reply?.ok === true) address = reply.url
      else await delay(400)
    }
    check('the product published the authorization address it opened', Boolean(address))
    if (!address) throw new Error('the product never started a sign-in attempt')

    const sent = new URL(address)
    check('the product sent the browser to GOOGLE', sent.origin === 'https://accounts.google.com', sent.origin)
    check('the redirect is an ephemeral loopback port', /^http:\/\/127\.0\.0\.1:\d+\//.test(sent.searchParams.get('redirect_uri') || ''))
    check('the challenge is S256', sent.searchParams.get('code_challenge_method') === 'S256')
    check('the scopes are identity only', sent.searchParams.get('scope') === 'openid email profile')
    check('no client secret reached the browser', !/client_secret/i.test(address) && (!CLIENT_SECRET || !address.includes(CLIENT_SECRET)))

    log('completing Google\'s own screens in the owned browser')
    const browser = await completeGoogleSignIn(address, log)
    check('Google redirected back to the product\'s loopback listener', browser.done === 'callback', browser.done)
    if (browser.done === 'callback') {
      check('the completion page shows no authorization code', !/[?&]code=/.test(browser.page))
    }

    let signedIn = '(never settled)'
    for (let attempt = 0; attempt < 60; attempt += 1) {
      signedIn = await screenText(window)
      if (/Signed in as/i.test(signedIn)) break
      await delay(500)
    }
    check('the packaged product says it signed the person in', /Signed in as/i.test(signedIn),
      signedIn.replace(/\s+/g, ' ').slice(0, 160))
    check('the screen shows the email GOOGLE verified', signedIn.includes(EMAIL),
      signedIn.replace(/\s+/g, ' ').slice(0, 160))

    const current = await window.evaluate('window.mcAccount.current()')
    check('the account record carries the Google-verified email', current?.account?.email === EMAIL || JSON.stringify(current || {}).includes(EMAIL),
      JSON.stringify(current?.account || current || null).slice(0, 200))

    /* NOTHING GOOGLE ISSUED IS ON DISK. The product mints its own session; a
       refresh token was never asked for and no token may be written down. */
    await window.close()
    window = null
    await delay(1500)
    const onDisk = []
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (!/Cache|GPUCache|Code Cache|blob_storage/i.test(entry.name)) walk(full); continue }
        if (!/\.(json|txt|log|dat)$/i.test(entry.name)) continue
        try { onDisk.push({ full, text: readFileSync(full, 'utf8') }) } catch { /* unreadable */ }
      }
    }
    walk(userData)
    const leaked = onDisk.filter(f => !f.full.endsWith('google-signin.json')
      && (/"(id_token|access_token|refresh_token)"/.test(f.text) || (CLIENT_SECRET && f.text.includes(CLIENT_SECRET))))
    check('no Google token and no client secret was written to the profile', leaked.length === 0,
      leaked.map(f => path.basename(f.full)).join(', '))

    /* THE SESSION SURVIVES A RESTART, which is what "signed in" has to mean. */
    window = await openWindow(executable, profile)
    const after = await openAccountScreen(window)
    check('the session persists across a restart of the packaged product', /Signed in as/i.test(after) && after.includes(EMAIL),
      after.replace(/\s+/g, ' ').slice(0, 160))
  } finally {
    if (window) await window.close()
    /* THE PROFILE CARRIED A CLIENT SECRET. It does not outlive the run. */
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* locked */ }
  }
}

main().then(
  () => {
    console.log(results.join('\n'))
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — live Google, packaged build`)
    process.exitCode = failures === 0 ? 0 : 1
  },
  error => {
    console.log(results.join('\n'))
    console.error(`\nTHE LIVE RUN DID NOT COMPLETE: ${error.message}`)
    process.exitCode = 2
  },
)
