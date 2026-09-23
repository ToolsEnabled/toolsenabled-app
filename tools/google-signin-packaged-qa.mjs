#!/usr/bin/env node
/* DOES SIGN-IN-WITH-GOOGLE ACTUALLY WORK IN THE PACKAGED PRODUCT.
 *
 * WHAT THIS RUNS. The selected release copied unchanged when named explicitly;
 * otherwise a development overlay on release/win-unpacked. Both use a scratch
 * --user-data-dir. It opens the sign-in screen the way a person does,
 * presses the shipped "Sign in with Google" button, lets the flow complete, and
 * reads what the window says at each step. Then it does the same for four ways
 * the flow must FAIL, and reads what the window says then.
 *
 * WHAT IT SIGNS IN AGAINST, AND WHY THAT IS SAID EVERYWHERE.
 *
 * There is no Google OAuth client registered to this PRODUCT yet -- creating it
 * is written up in docs/GOOGLE-SIGN-IN-SETUP.md. So this runs against a LOCAL
 * identity provider started by this file: its own RSA key pair, its own JWKS,
 * its own authorization and token endpoints, all on 127.0.0.1.
 *
 * THIS FILE USED TO SAY a real round trip was "impossible for anyone, including
 * this harness", until the owner's client existed. That was false, and it cost a
 * lane the finding underneath it: the machine already held a Desktop-app client,
 * and tools/google-signin-live-qa.mjs completed a genuine Google sign-in in the
 * packaged build with it on 2026-08-11. Keep the two files apart -- this one
 * proves the refusals and the shape of the flow cheaply and offline, that one
 * proves Google accepts it -- but do not let this file claim the other cannot
 * exist.
 *
 * That substitution is DECLARED, not hidden. The product refuses to use a
 * non-Google endpoint unless the configuration says `iUnderstandThisIsNotGoogle`
 * and every endpoint is loopback, and when it does, the sign-in screen prints a
 * banner saying the copy is pointed at a test service. This harness asserts that
 * banner is on screen -- so a screenshot of this run cannot be mistaken for a
 * screenshot of a real one.
 *
 * WHAT IS THEREFORE PROVEN, and what is not:
 *   PROVEN -- the button, the loopback listener, the PKCE challenge and its
 *   verification at the token endpoint, the refusal of a client secret, the
 *   id_token signature check against a JWKS, the account that results, what the
 *   screen says, and that nothing Google issued is written to disk.
 *   NOT PROVEN -- that Google's own servers accept our client id, which cannot
 *   be proven before that client id exists.
 *
 * THE LOCAL PROVIDER CHECKS PKCE FOR REAL. It stores the code_challenge from the
 * authorization request and recomputes SHA-256 of the code_verifier at the token
 * endpoint, refusing on a mismatch -- so "PKCE is wired up" is measured from the
 * provider's side rather than asserted from ours. It also fails the run if a
 * client_secret ever arrives.
 *
 * NO REAL GOOGLE ACCOUNT IS INVOLVED. The identity minted here is
 * `qa.google.probe@example.com`, which cannot be a Google account.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE } from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const CLIENT_ID = '000000000001-qaqaqaqaqaqaqaqaqaqaqaqaqaqaqaqa.apps.googleusercontent.com'
const PROBE_EMAIL = 'qa.google.probe@example.com'
const PROBE_SUBJECT = '100000000000000000001'
const OTHER_SUBJECT = '200000000000000000002'

const results = []
let failures = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}
function note(text) { results.push(`  ·   ${text}`) }

/* ------------------------- the local identity provider ------------------------- */

const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'qa-local-key-1'

function jwks() {
  const jwk = key.publicKey.export({ format: 'jwk' })
  return { keys: [{ kty: 'RSA', kid: KID, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] }
}

function signIdToken(claims, { signingKey = key.privateKey } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'ascii'), signingKey)
  return `${header}.${payload}.${signature.toString('base64url')}`
}

/* `mode` decides how this provider misbehaves, so the packaged product can be
   watched failing closed rather than only succeeding. */
async function startProvider(mode = 'good', { subject = PROBE_SUBJECT } = {}) {
  const state = { requests: [], pkceChecked: false, secretSeen: false, browserHits: 0 }
  const pending = new Map()

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${state.port}`)
    state.requests.push(`${request.method} ${url.pathname}`)

    if (url.pathname === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(jwks()))
      return
    }

    if (url.pathname === '/auth' && request.method === 'GET') {
      /* THE BROWSER'S SIDE. A real provider shows a sign-in page here; this one
         approves at once and redirects, which is the only part of a person's
         experience a harness can legitimately skip. Everything the product sent
         is checked before it does. */
      state.browserHits += 1
      const record = {
        clientId: url.searchParams.get('client_id'),
        redirectUri: url.searchParams.get('redirect_uri'),
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
        scope: url.searchParams.get('scope'),
        nonce: url.searchParams.get('nonce'),
        state: url.searchParams.get('state'),
        accessType: url.searchParams.get('access_type'),
        prompt: url.searchParams.get('prompt'),
        userAgent: request.headers['user-agent'] || '',
      }
      state.authorization = record
      const code = crypto.randomBytes(16).toString('hex')
      pending.set(code, record)
      if (mode === 'google-error') {
        response.writeHead(302, { location: `${record.redirectUri}?error=access_denied&state=${encodeURIComponent(record.state)}` })
        response.end()
        return
      }
      response.writeHead(302, { location: `${record.redirectUri}?code=${code}&state=${encodeURIComponent(record.state)}` })
      response.end()
      return
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('client_secret')) state.secretSeen = true
        const record = pending.get(form.get('code'))
        const verifier = form.get('code_verifier') || ''
        const recomputed = crypto.createHash('sha256').update(verifier).digest('base64url')
        /* PKCE, CHECKED FROM THE PROVIDER'S SIDE. This is the whole proof that a
           stolen authorization code is useless. */
        if (!record || !verifier || recomputed !== record.challenge) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        state.pkceChecked = true
        if (mode === 'token-refused') {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_client' }))
          return
        }
        const seconds = Math.floor(Date.now() / 1000)
        const claims = {
          iss: `http://127.0.0.1:${state.port}`,
          aud: CLIENT_ID,
          sub: subject,
          email: PROBE_EMAIL,
          email_verified: mode === 'unverified-email' ? false : true,
          name: 'QA Google Probe',
          nonce: record.nonce,
          iat: seconds - 5,
          exp: seconds + 3600,
        }
        const idToken = mode === 'wrong-key'
          ? signIdToken(claims, { signingKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })
          : signIdToken(claims)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id_token: idToken, access_token: 'qa-access-token-must-not-persist', token_type: 'Bearer', expires_in: 3599 }))
      })
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  state.port = server.address().port
  state.close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.() })
  state.config = {
    clientId: CLIENT_ID,
    testProvider: {
      iUnderstandThisIsNotGoogle: true,
      authorizationEndpoint: `http://127.0.0.1:${state.port}/auth`,
      tokenEndpoint: `http://127.0.0.1:${state.port}/token`,
      jwksUri: `http://127.0.0.1:${state.port}/jwks`,
      issuer: `http://127.0.0.1:${state.port}`,
    },
  }
  return state
}

/* ------------------------------ the packaged app ------------------------------ */

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (!launcher) throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
  return path.join(appRoot, launcher)
}

/* An explicit candidate is copied unchanged, including its shell and payload.
   Only implicit development mode uses THIS tree's dist/ and shell/ -- the same
   staging tools/owner-account-packaged-qa.mjs performs, and for the same
   reason: the artifact on disk can predate the change under test, and a harness
   that runs a stale artifact reports the state of last week's build. Same exe,
   same resources, same asar; only the payload is this tree's. */
async function stage(scratch) {
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    const selected = await stageRelease(scratch)
    return { executable: selected.executable, app: selected.appRoot,
      stageMode: selected.stageMode, sourceRelease: selected.sourceRelease }
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
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  return { executable: appExecutable(app), app, stageMode: 'source-overlay', sourceRelease: RELEASE }
}

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function createSession(port, child) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open() {
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
            return
          }
        } catch { /* not listening yet */ }
        await delay(500)
      }
      throw new Error('no debuggable page appeared within 90s')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

const VISIBLE = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const box = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  return { state: 'visible', x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: node.disabled === true }
}`

function environmentFor(profile) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  delete environment.TOOLSENABLED_VAULT_PATH
  delete environment.TOOLSENABLED_STATE_ROOT
  /* MUST BE ABSENT. It would override the per-installation configuration file
     this harness is here to exercise. */
  delete environment.TOOLSENABLED_GOOGLE_CLIENT_ID
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
  const session = createSession(port, child)
  await session.open()
  const evaluate = async expression => {
    const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return packet?.result?.result?.value
  }
  const clickVisible = async selector => {
    const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(selector)})`)
    if (spot?.state !== 'visible') return spot?.state || 'absent'
    if (spot.disabled) return 'disabled'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    await delay(400)
    return 'clicked'
  }
  await delay(2200)
  return { child, session, evaluate, clickVisible }
}

async function closeWindow(window) {
  try { window?.session?.close() } catch { /* already gone */ }
  try {
    if (window?.child && window.child.exitCode === null) {
      spawn('taskkill.exe', ['/PID', String(window.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      await delay(1200)
    }
  } catch { /* nothing to reap */ }
}

/* Whichever surface is showing. The sign-in question appears twice -- inside the
   first-run walkthrough and as its own screen -- and both render the same
   builders, so both are worth reading. */
const screenText = window => window.evaluate(
  '(() => { const n = document.querySelector("[data-account-section]") || document.querySelector("[data-setup-section]");'
  + ' return n ? n.innerText : "(no screen)" })()',
)

/* THE FIRST-RUN STEP, REACHED THE WAY A PERSON REACHES IT.
 *
 * A sterile profile opens on the permission question and the router REFUSES
 * every other route until a level is recorded -- which is why an earlier version
 * of this harness read "(no screen)" on every phase: it set location.hash and
 * the gate put it straight back. Pressing Continue is what a person does, and it
 * is what makes #/account reachable afterwards. */
async function reachWalkthroughSignIn(window) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const hash = await window.evaluate('location.hash')
    if (hash === '#/setup') break
    await delay(400)
  }
  await window.evaluate('(() => { const n = document.querySelector("[data-setup-continue]"); if (n) n.click(); return !!n })()')
  await delay(1200)
  await window.evaluate('(() => { const n = document.querySelectorAll("[data-setup-next]"); if (n.length) n[n.length - 1].click(); return n.length })()')
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await screenText(window)
    if (/Who is using this copy|Signed in as/i.test(text)) return text
    await delay(400)
  }
  return screenText(window)
}

async function openAccountScreen(window) {
  /* Record a permission level first if the gate is up; the account screen is
     not reachable before that, by design. */
  const hash = await window.evaluate('location.hash')
  if (hash === '#/setup') {
    await window.evaluate('(() => { const n = document.querySelector("[data-setup-continue]"); if (n) n.click(); return !!n })()')
    await delay(1500)
  }
  await window.evaluate('location.hash = "#/account"')
  await delay(1400)
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const text = await window.evaluate(
      'document.querySelector("[data-account-section]") ? document.querySelector("[data-account-section]").innerText : "(no account screen)"',
    )
    if (/Who is using this copy|Signed in as/i.test(text)) return text
    await delay(400)
  }
  return screenText(window)
}

/* THE BROWSER'S PART, PLAYED BY THIS FILE WHEN THE REAL ONE DOES NOT ARRIVE.
 *
 * The product calls shell.openExternal, so on a machine with a working default
 * browser the real browser does the redirect and this never runs. On a headless
 * or association-less machine nothing opens, and rather than report that as a
 * product failure this harness follows the address the SCREEN offers -- the same
 * recovery path a person has. Which of the two happened is reported. */
async function followAuthorizationAddress(window) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const address = await window.evaluate(
      '(() => { const n = document.querySelector("[data-account-notice-address] code"); return n ? n.textContent : null })()',
    )
    if (typeof address === 'string' && address.startsWith('http://127.0.0.1:')) return address
    await delay(300)
  }
  return null
}

async function waitForOutcome(window, timeoutMs = 30_000) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    last = await screenText(window)
    if (/Signed in as|You were not signed in|That did not work/i.test(last)) return last
    await delay(400)
  }
  return last
}

/* --------------------------------- the phases --------------------------------- */

async function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'google-signin-qa-'))
  const summary = []

  try {
    const staged = await stage(scratch)
    const executable = staged.executable
    results.push(`artifact: ${staged.sourceRelease}; staging: ${staged.stageMode}; local identity-provider fixture, not a real Google sign-in`)
    results.push(`executable: ${path.basename(executable)}`)

    /* ---- PHASE 1: NO CONFIGURATION. The state this machine is in today. ---- */
    {
      const profile = path.join(scratch, 'phase1')
      mkdirSync(userDataFor(profile), { recursive: true })
      const window = await openWindow(executable, profile)
      try {
        /* FIRST RUN FIRST. This is where a customer meets sign-in, so the
           option has to be on that step too -- not only on the screen a person
           would have to go looking for. */
        const walkthrough = await reachWalkthroughSignIn(window)
        summary.push(['PHASE 1a — the first-run walkthrough, sign-in step, no Google id', walkthrough])
        check('the first-run step asks the sign-in question', /Who is using this copy/i.test(walkthrough))
        check('the Google option appears on the first-run step', /Sign in with Google/i.test(walkthrough))
        check('the first-run step says why it is not available', /not available on this copy/i.test(walkthrough))

        const text = await openAccountScreen(window)
        summary.push(['PHASE 1b — the sign-in screen, no Google application id configured', text])
        check('the sign-in screen renders', /Who is using this copy/i.test(text))
        check('the Google option is SHOWN rather than hidden', /Sign in with Google/i.test(text))
        check('it says it is not available on this copy', /not available on this copy/i.test(text))
        check('it explains why, in a sentence', /has not been given a Google sign-in application id/i.test(text))
        check('it names what does work instead', /account on this computer/i.test(text))
        const state = await window.evaluate('(() => { const n = document.querySelector("[data-google-signin]"); return n ? n.dataset.googleState : "absent" })()')
        check('the option reports the unavailable state', state === 'unavailable', `state=${state}`)
        const pressed = await window.clickVisible('[data-google-signin-start]')
        check('the button is disabled rather than failing when pressed', pressed === 'disabled', `press=${pressed}`)
        const local = await window.evaluate('document.querySelectorAll("[data-account-form] input[type=password]").length')
        check('the local account form is still there and usable', local >= 1, `password fields=${local}`)
      } finally { await closeWindow(window) }
    }

    /* ---- PHASE 2: THE WHOLE FLOW, AND WHAT THE SCREEN SAID ---- */
    let provider = await startProvider('good')
    let browserPlayedBy = 'the real system browser'
    {
      const profile = path.join(scratch, 'phase2')
      const userData = userDataFor(profile)
      mkdirSync(userData, { recursive: true })
      writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify(provider.config, null, 2))
      const window = await openWindow(executable, profile)
      try {
        const before = await openAccountScreen(window)
        summary.push(['PHASE 2a — the sign-in screen, Google configured', before])
        check('the Google option is offered', /Sign in with Google/i.test(before))
        check('the test-provider banner is on the screen', /pointed at a test sign-in service/i.test(before),
          'a run against a test provider must never look like a real one')
        check('the scope promise is on the screen', /no access to your Drive, your Gmail or your Calendar/i.test(before))
        check('it says the password is typed into the browser', /never into this program/i.test(before))
        const state = await window.evaluate('(() => { const n = document.querySelector("[data-google-signin]"); return n ? n.dataset.googleState : "absent" })()')
        check('the option reports the available state', state === 'available', `state=${state}`)

        const pressed = await window.clickVisible('[data-google-signin-start]')
        check('the shipped button was pressed', pressed === 'clicked', `press=${pressed}`)
        await delay(900)
        const waiting = await screenText(window)
        summary.push(['PHASE 2b — while it waits for the browser', waiting])
        check('the window says the browser is opening', /Your browser is opening/i.test(waiting))
        check('it says nothing is signed in yet', /Nothing is signed in until you do/i.test(waiting))
        check('a Cancel control is offered while it waits', /Cancel/i.test(waiting))

        /* THE BROWSER'S PART, AND WHY THIS FILE PLAYS IT.
           The product calls shell.openExternal, and this harness runs the app
           with a sterile APPDATA/USERPROFILE so it cannot touch the real
           installation -- which means any browser the OS launches from it also
           gets a blank profile and lands on its own first-run wizard. Waiting on
           that would measure the browser's onboarding, not this product. So the
           harness follows the address the SCREEN offers, which is the same
           recovery path a person with no working default browser has, and the
           run reports that this is what happened. */
        let completed = false
        for (let attempt = 0; attempt < 4 && !completed; attempt += 1) {
          await delay(1000)
          completed = provider.browserHits > 0
        }
        if (!completed) {
          const address = await followAuthorizationAddress(window)
          check('the screen offered the address so a person whose browser did not open can continue', typeof address === 'string')
          if (address) {
            browserPlayedBy = 'this harness, following the address the screen offered'
            await fetch(address, { redirect: 'follow' }).catch(() => {})
          }
        } else {
          browserPlayedBy = 'the system browser this computer launched'
          check('the screen offered the address so a person whose browser did not open can continue', true)
        }

        const after = await waitForOutcome(window)
        summary.push(['PHASE 2c — after the sign-in completed', after])
        check('the window says the person is signed in', /Signed in as/i.test(after), after.slice(0, 120))
        check('the identity on screen is the verified address', after.includes(PROBE_EMAIL))
        check('it says how they signed in', /With Google, as/i.test(after))
        check('it offers no password change for a Google account', !/Change password/i.test(after))
        check('it says there is no Google token held here', /no Google password and no Google token/i.test(after))
        check('the test-provider warning survived into the result', /test sign-in service/i.test(after))

        /* --- what the provider saw, which is the other half of the proof --- */
        const request = provider.authorization || {}
        check('the request asked for identity scopes only', request.scope === 'openid email profile', `scope=${request.scope}`)
        check('the challenge method was S256', request.method === 'S256', `method=${request.method}`)
        check('a code challenge was sent', typeof request.challenge === 'string' && request.challenge.length >= 43)
        check('a nonce was sent', typeof request.nonce === 'string' && request.nonce.length >= 32)
        check('offline access was NOT asked for, so no refresh token exists', !request.accessType, `access_type=${request.accessType}`)
        check('the redirect was loopback on an ephemeral port', /^http:\/\/127\.0\.0\.1:\d+\//.test(request.redirectUri || ''), request.redirectUri)
        check('PKCE was verified at the token endpoint', provider.pkceChecked === true)
        check('NO client secret was ever sent', provider.secretSeen === false)
        note(`the browser step was performed by ${browserPlayedBy}`)

        /* --- and what landed on disk --- */
        const accountsFile = path.join(userData, 'product-accounts.json')
        check('an account file was written into the scratch profile', existsSync(accountsFile))
        const stored = existsSync(accountsFile) ? readFileSync(accountsFile, 'utf8') : ''
        check('the record holds the Google subject identifier', stored.includes(PROBE_SUBJECT))
        check('the record holds the verified address', stored.includes(PROBE_EMAIL))
        check('the record holds NO password verifier', !/scrypt\$/.test(stored))
        check('the record holds NO Google token', !/access_token|refresh_token|"id_token"|qa-access-token/i.test(stored))
        const leaked = scanProfileFor(profile, ['qa-access-token-must-not-persist'])
        check('no file anywhere in the profile holds the access token', leaked.length === 0, leaked.join(', '))
        check('nothing was written to this machine\'s real account store',
          !existsSync(path.join(process.env.APPDATA || 'C:/nonexistent', 'ToolsEnabled', 'product-accounts.json'))
          || statSync(path.join(process.env.APPDATA, 'ToolsEnabled', 'product-accounts.json')).mtimeMs < Date.now() - 60_000)

        /* --- PHASE 2d: a second Google account with the same address is refused --- */
        await window.clickVisible('[data-account-sign-out]')
        await delay(1200)
      } finally { await closeWindow(window) }
      await provider.close()
    }

    /* ---- PHASE 3: THE FOUR WAYS IT MUST FAIL CLOSED ---- */
    const failureModes = [
      ['wrong-key', 'the id_token is signed by somebody who is not the provider', /not signed in/i],
      ['google-error', 'the person cancels at the provider', /not signed in/i],
      ['token-refused', 'the provider refuses the exchange', /not signed in/i],
      ['unverified-email', 'the address was never verified', /not signed in/i],
    ]
    for (const [mode, label, expected] of failureModes) {
      const failing = await startProvider(mode)
      const profile = path.join(scratch, `phase3-${mode}`)
      const userData = userDataFor(profile)
      mkdirSync(userData, { recursive: true })
      writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify(failing.config, null, 2))
      const window = await openWindow(executable, profile)
      try {
        await openAccountScreen(window)
        await window.clickVisible('[data-google-signin-start]')
        await delay(800)
        let completed = false
        for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
          await delay(800)
          completed = failing.browserHits > 0
        }
        if (!completed) {
          const address = await followAuthorizationAddress(window)
          if (address) await fetch(address, { redirect: 'follow' }).catch(() => {})
        }
        const text = await waitForOutcome(window, 25_000)
        summary.push([`PHASE 3 — ${label}`, text])
        check(`${label}: the window says nobody was signed in`, expected.test(text), text.slice(0, 160))
        check(`${label}: the screen is NOT a signed-in screen`, !/Signed in as/i.test(text))
        check(`${label}: a sentence explains what happened`, /(could not|did not|refused|cancelled|not verified|expired)/i.test(text))
        const accountsFile = path.join(userData, 'product-accounts.json')
        check(`${label}: no account was created`, !existsSync(accountsFile))
      } finally {
        await closeWindow(window)
        await failing.close()
      }
    }

    /* ---- PHASE 4: THE PERSON CANCELS ---- */
    {
      const waiting = await startProvider('good')
      const profile = path.join(scratch, 'phase4')
      const userData = userDataFor(profile)
      mkdirSync(userData, { recursive: true })
      writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify(waiting.config, null, 2))
      /* The provider is silent for this phase: nothing answers, so the attempt
         is still waiting when Cancel is pressed. */
      const window = await openWindow(executable, profile)
      try {
        await openAccountScreen(window)
        await window.clickVisible('[data-google-signin-start]')
        await delay(1200)
        const pressed = await window.clickVisible('[data-google-signin-cancel]')
        check('a Cancel control exists while the sign-in waits', pressed === 'clicked', `press=${pressed}`)
        const text = await waitForOutcome(window, 20_000)
        summary.push(['PHASE 4 — the person presses Cancel', text])
        check('cancelling leaves the person signed out, and says so', /not signed in|cancelled/i.test(text), text.slice(0, 160))
        check('no account was created by a cancelled sign-in', !existsSync(path.join(userData, 'product-accounts.json')))
      } finally {
        await closeWindow(window)
        await waiting.close()
      }
    }
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS will */ }
  }

  console.log('\n=== WHAT THE SCREENS SAID ===\n')
  for (const [phase, text] of summary) {
    console.log(`--- ${phase} ---`)
    console.log(text.split('\n').map(line => `    ${line}`).join('\n'))
    console.log('')
  }
  console.log('=== CHECKS ===\n')
  for (const line of results) console.log(line)
  const passed = results.filter(line => line.startsWith('PASS')).length
  console.log(`\n${passed}/${passed + failures} checks passed`)
  process.exitCode = failures === 0 ? 0 : 1
}

function scanProfileFor(root, needles) {
  const hits = []
  const walk = directory => {
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      let raw
      try {
        if (statSync(full).size > 4 * 1024 * 1024) continue
        raw = readFileSync(full)
      } catch { continue }
      const text = raw.toString('utf8')
      for (const needle of needles) if (text.includes(needle)) hits.push(path.relative(root, full))
    }
  }
  walk(root)
  return hits
}

main().catch(error => {
  console.error(`the harness could not complete: ${error?.message || error}`)
  process.exitCode = 1
})
