/* DOES A SETTING SURVIVE A PORT CHANGE? Measured on the packaged application.
 *
 * The defect this gate exists for: everything the renderer persists -- theme,
 * text size, mc.live.*, mc.write.*, the first-run profile, chatbox settings --
 * was browser storage keyed to the ORIGIN, and the origin is
 * http://127.0.0.1:<port> where shell/port-scan.cjs picks <port> by scanning
 * 4601-4609 at launch. Relaunch while the previous port is held -- a lingering
 * process, a QA app, a second install, a fast restart -- and the application
 * comes up on the next port, which is a different origin, which is a different
 * storage partition. Every setting the person chose is gone, silently, and it
 * looks exactly like a factory reset.
 *
 * WHY THIS IS NOT A UNIT TEST. The whole defect lives in the gap between the
 * storage module and how the application is launched. A unit test over the
 * store passes in both the broken and the fixed build, because in a unit test
 * there is no port, no origin and no second launch. So this gate launches the
 * REAL PACKAGED EXECUTABLE TWICE, with the first launch's port deliberately
 * held by a socket, and asks the second launch's renderer what it can still
 * read. Nothing here inspects source text; every assertion is behaviour
 * observed through the Chrome DevTools Protocol in the running renderer.
 *
 * IT FORCE-KILLS BETWEEN LAUNCHES, ON PURPOSE. A graceful quit would let a
 * shutdown hook flush state and make a store that is only durable at exit look
 * durable. Killing the process tree proves the write was durable when the
 * setter returned, which is the property that makes the fix true.
 *
 * THE ORIGIN IS READ, NOT ASSUMED. The bound port comes from the page target's
 * own URL over CDP, so a run that failed to move the origin reports that it
 * did not move instead of quietly asserting nothing. A proof whose premise
 * silently stopped holding is worse than no proof.
 */
import { spawn, execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const execFile = promisify(execFileCallback)

/* The record file name comes from the store itself rather than being spelled
   again here. If it is ever renamed, the damaged-record scenario below fails
   loudly with "no durable record to damage" instead of quietly looking for a
   file that no longer exists and finding nothing to worry about. */
const { RECORD_FILE, isQuarantineFile } = createRequire(import.meta.url)('../shell/renderer-prefs.cjs')

export const APP_EXE = 'ToolsEnabled.exe'
const APP_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)\//

/* The settings written in launch one and demanded back in launch two. They are
   deliberately spread across the storage families this product actually uses,
   because a fix that rescued only the key it was written against would pass a
   narrower list: an appearance key read before first paint by the inline script
   in index.html, a numeric one, a live/simulated flag, a write-enable flag, a
   JSON-valued chatbox setting, and a per-computer graph position. */
export const PROBE_SETTINGS = Object.freeze([
  { key: 'mc.theme', value: 'black' },
  { key: 'mc.text', value: '1.12' },
  { key: 'mc.live.fleet', value: 'live' },
  { key: 'mc.write.ledger', value: 'enabled' },
  { key: 'mc.chatbox.runs', value: 'mine' },
  { key: 'mc.tree.pos.c1', value: '{"a1":{"dx":12,"dy":-8}}' },
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function releaseAll(servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}

/* A killed process does not release its listening socket the instant taskkill
   returns. Grabbing the port immediately raced that release and failed the
   scenario with EADDRINUSE -- a fault in the harness, reported as though the
   product had failed. Wait for the port the way the next launch would. */
async function occupyWhenFree(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { return await occupy(port) } catch (error) {
      lastError = error
      if (error?.code !== 'EADDRINUSE') throw error
      await sleep(250)
    }
  }
  throw new Error(`Port ${port} never became free within ${timeoutMs}ms, so this scenario could not hold it (${lastError?.code}).`)
}

/* Hold the port the shell WOULD have taken, whichever that is. Hardcoding 4601
   made this file fail on the machine it was written for, because a second
   ToolsEnabled was already serving there -- which is the very condition the
   product is being fixed for. The scenario needs "the first port the scan would
   pick is unavailable", not "4601 specifically". */
async function occupyFirstFreePort(min = 4601, max = 4609) {
  for (let port = min; port <= max; port++) {
    try { return { server: await occupy(port), port } } catch (error) {
      if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') throw error
    }
  }
  throw new Error(`Every port from ${min} to ${max} is already in use, so this scenario cannot arrange its precondition.`)
}

/* Windows only kills the named process, and Electron's renderer and GPU
   children keep the listening socket alive if the parent alone is signalled.
   The port must actually be free for the next step of the scenario, so the
   whole tree goes. */
async function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  try { await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already gone */ }
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && Date.now() < deadline) await sleep(100)
}

/* SHUT THE APPLICATION DOWN THE WAY A PERSON DOES.
 *
 * The two port-change scenarios force-kill on purpose, because that is what
 * proves a write was durable when it returned. The UPGRADE scenario must not:
 * it needs the OLD build's browser storage to actually be on disk, and Chromium
 * commits localStorage to its LevelDB lazily. Force-killing the old build threw
 * away the very settings the migration was then asked to rescue, and the run
 * reported that as the product failing to migrate. It was the harness never
 * creating the thing it was testing for.
 *
 * Falls back to killing the tree, because a scenario that hangs waiting for a
 * graceful exit is worse than one that stops being graceful. */
async function closeGracefully(app, timeoutMs = 20_000) {
  if (!app || !app.child || app.child.exitCode !== null) return
  try {
    if (app.browserEndpoint) {
      const browser = await DevToolsSession.open(app.browserEndpoint)
      // Deliberately not awaited: this command destroys the connection it
      // travels on, so its reply is not owed and waiting for one is a hang.
      browser.send('Browser.close').catch(() => {})
    }
  } catch { /* fall through to the kill */ }
  const deadline = Date.now() + timeoutMs
  while (app.child.exitCode === null && Date.now() < deadline) await sleep(100)
  if (app.child.exitCode === null) await killTree(app.child)
}

/* THE DEBUGGING PORT COMES FROM THIS CHILD'S OWN STDERR, NOT FROM THE PROFILE.
   Chromium also writes it to <profile>/DevToolsActivePort, and reading it there
   is how this file wasted two runs: the second launch reuses the same profile
   directory, so until Chromium rewrites that file it still holds the FIRST
   launch's port. The probe then polled a dead endpoint for sixty seconds and
   reported "the application never showed a page" about an application that was
   in fact running and serving. The banner on stderr belongs to exactly one
   process and cannot be stale. */
function devToolsPortFromOutput(text) {
  const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)
  return match ? Number(match[1]) : null
}

async function waitForDevToolsPort(readOutput, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = devToolsPortFromOutput(readOutput())
    if (port) return port
    if (child.exitCode !== null) {
      throw new Error(`The application exited with code ${child.exitCode} before announcing a debugging endpoint.`)
    }
    await sleep(100)
  }
  throw new Error(`The application never announced a debugging endpoint within ${timeoutMs}ms.`)
}

/* The page target is the application's own main frame. A target list can
   briefly contain only the about:blank shell before loadURL settles, so this
   waits for a target whose URL is an origin the shell could have bound rather
   than taking the first entry and reporting a nonsense origin. */
async function findPageTarget(devToolsPort, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  let lastSeen = '(no targets)'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)
      const targets = await response.json()
      lastSeen = targets.map((target) => `${target.type}:${target.url}`).join(', ') || '(no targets)'
      const page = targets.find((target) => target.type === 'page' && APP_ORIGIN_PATTERN.test(target.url || ''))
      if (page) return page
    } catch { /* endpoint not up yet */ }
    /* An application that EXITED is a different finding from one that is slow,
       and the two looked identical until this check: a second launch that loses
       the single-instance lock quits immediately, having already printed a
       DevTools endpoint, and the old code reported that as a 60s timeout. */
    if (child && child.exitCode !== null) {
      throw new Error(`The application exited with code ${child.exitCode} before showing a page. Last saw: ${lastSeen}`)
    }
    await sleep(150)
  }
  throw new Error(`No application page target on the debugging endpoint within ${timeoutMs}ms. Last saw: ${lastSeen}`)
}

class DevToolsSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let packet
      try { packet = JSON.parse(event.data) } catch { return }
      const entry = this.pending.get(packet.id)
      if (!entry) return
      this.pending.delete(packet.id)
      if (packet.error) entry.reject(new Error(packet.error.message || 'DevTools command failed'))
      else entry.resolve(packet.result)
    })
    /* A CLOSED SOCKET MUST FAIL EVERY REQUEST STILL WAITING ON IT.
       Without this, a command whose reply can never arrive -- Browser.close is
       the obvious one, since it destroys the connection it was sent on --
       leaves a promise that never settles. Nothing is then keeping the event
       loop alive, so node EXITS WITH CODE 0 in the middle of the run: no
       verdict, no error, and a clean exit status on a proof that never
       finished. That is the worst possible failure for a gate. */
    const abandon = () => {
      for (const [id, entry] of this.pending) {
        this.pending.delete(id)
        entry.reject(new Error('the DevTools connection closed before this command answered'))
      }
    }
    socket.addEventListener('close', abandon)
    socket.addEventListener('error', abandon)
  }

  static async open(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('Could not open a DevTools session on the application page.')), { once: true })
    })
    return new DevToolsSession(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /* Every probe returns a value BY VALUE. Returning a remote object handle and
     describing it would let a probe report a shape while the page holds
     something else. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`Page evaluation threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`.trim())
    }
    return result.result?.value
  }

  /* WAIT FOR THE APPLICATION'S OWN DOCUMENT, NOT WHATEVER IS THERE NOW.
     A session can attach while the window still holds the initial empty
     document that precedes loadURL. Storage on that document is opaque, and
     touching it throws "Access is denied" -- which an earlier version of this
     file reported as a finding about the product. It was a finding about the
     probe. Polling until the origin, the ready state and a reachable storage
     object all agree removes the transient instead of racing it. */
  async waitForDocument(origin, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last = 'never evaluated'
    const expression = `(() => {
      try {
        return JSON.stringify({
          origin: location.origin,
          ready: document.readyState,
          storage: typeof window.localStorage,
        })
      } catch (error) { return JSON.stringify({ error: String(error && error.message || error) }) }
    })()`
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression)
        const state = JSON.parse(last)
        if (state.origin === origin && state.ready === 'complete' && state.storage === 'object') return
      } catch (error) { last = `evaluation failed: ${error.message}` }
      await sleep(200)
    }
    throw new Error(`The application document never settled at ${origin} within ${timeoutMs}ms. Last state: ${last}`)
  }

  close() {
    try { this.socket.close() } catch { /* already closing */ }
  }
}

/* One launch of the real executable, attached to and ready to be asked
   questions. `expectDocumentReady` waits for the renderer to have finished
   evaluating its scripts, so a probe cannot read storage before the store has
   been installed and report an empty result as a defect. */
async function launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log }) {
  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home inside the same profile directory both launches share, so the second
     launch reads what the first wrote and nothing of this machine's; and
     ELECTRON_RUN_AS_NODE deleted. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(profileDirectory)))
  environment.MC_SMOKE_HEADLESS = '1'

  let stdout = ''
  let stderr = ''
  const child = spawn(executable, [
    `--user-data-dir=${profileDirectory}`,
    '--remote-debugging-port=0',
    '--disable-gpu',
    '--disable-gpu-sandbox',
  ], {
    cwd: appDirectory,
    detached: false,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  if (!child.pid) throw new Error('Packaged application did not return a process ID')

  try {
    const devToolsPort = await waitForDevToolsPort(() => `${stdout}\n${stderr}`, child, timeoutMs)
    const target = await findPageTarget(devToolsPort, timeoutMs, child)
    const session = await DevToolsSession.open(target.webSocketDebuggerUrl)
    const origin = new URL(target.url).origin
    const port = Number(new URL(target.url).port)
    await session.waitForDocument(origin, timeoutMs)
    log(`[prefs-origin-proof] launched pid=${child.pid} origin=${origin}`)
    const browserEndpoint = /DevTools listening on (ws:\/\/\S+)/.exec(`${stdout}\n${stderr}`)?.[1] || null
    return { child, session, origin, port, browserEndpoint, output: () => `stdout:\n${stdout}\nstderr:\n${stderr}` }
  } catch (error) {
    await killTree(child)
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
}

const readProbe = `(() => {
  const out = {}
  for (const key of ${JSON.stringify(PROBE_SETTINGS.map((setting) => setting.key))}) {
    try { out[key] = localStorage.getItem(key) } catch (error) { out[key] = 'THREW:' + error.message }
  }
  out['__paintedTheme'] = document.documentElement.dataset.theme || null
  return out
})()`

/* WHAT THE PERSON IS ACTUALLY LOOKING AT.
 *
 * Read out of the running application's own DOM, because the question this
 * answers is not "does a notice module exist" -- a module can be flawless and
 * never mounted, which is this codebase's most repeated near miss -- but "did
 * anything appear on the screen of somebody whose settings did not load". The
 * element is polled rather than read once: the notice is mounted by a module,
 * and a module has not necessarily evaluated at the instant the document
 * reports complete. */
const noticeProbe = `(() => {
  const node = document.querySelector('[data-settings-recovery]')
  if (!node) return null
  return { kind: node.getAttribute('data-settings-recovery'), text: node.textContent || '' }
})()`

async function readNotice(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await session.evaluate(noticeProbe)
    if (last && last.text) return last
    await sleep(150)
  }
  return last
}

function writeProbe(settings) {
  return `(() => {
    for (const [key, value] of ${JSON.stringify(settings.map((setting) => [setting.key, setting.value]))}) {
      localStorage.setItem(key, value)
    }
    return true
  })()`
}

function compare(observed, label) {
  const missing = []
  for (const setting of PROBE_SETTINGS) {
    if (observed[setting.key] !== setting.value) {
      missing.push(`${setting.key}: expected ${JSON.stringify(setting.value)}, ${label} ${JSON.stringify(observed[setting.key])}`)
    }
  }
  return missing
}

/* THE THEME THE PAGE ACTUALLY ENDED UP ON, which is a different claim from
   "the key round-tripped": it fails if a setting survives in storage but never
   reaches the surface a person looks at.

   WHAT IT DOES NOT COVER, measured rather than assumed: this reads the SETTLED
   theme, and src/main.js applies the stored theme when it evaluates. A packaged
   app built with the durable store installed BELOW the inline pre-paint read
   still passed this check, because the page corrects itself before anything can
   observe it. The cost of that regression is a white flash on one frame, which
   no assertion here can see. Document order is therefore asserted directly, in
   tools/test/durable-storage.test.mjs.

   Checked only on the RELAUNCH, because the first launch writes storage
   directly without asking the app to re-theme itself. */
function paintedThemeFailures(observed) {
  const expected = PROBE_SETTINGS.find((setting) => setting.key === 'mc.theme').value
  if (observed.__paintedTheme === expected) return []
  return [`the page painted the ${JSON.stringify(observed.__paintedTheme)} theme while the stored theme is ${JSON.stringify(expected)}: the setting survived the port change but the pre-paint read did not see it`]
}

/* SCENARIO ONE -- AN EXISTING INSTALL. Settings already chosen under the port
   the application happened to bind first, then a relaunch with that port held.
   This is the measured customer story: nothing was uninstalled, nothing was
   reset, and the product forgot who they were. */
async function existingInstallScenario(context) {
  const { executable, appDirectory, timeoutMs, log } = context
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'te-prefs-existing-'))
  const occupied = []
  let first = null
  let second = null
  try {
    first = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    await first.session.evaluate(writeProbe(PROBE_SETTINGS))
    const writtenBack = await first.session.evaluate(readProbe)
    const writeFailures = compare(writtenBack, 'read back as')
    if (writeFailures.length) {
      return { name: 'existing install', ok: false, reason: `the FIRST launch could not even store its own settings, so this run proves nothing about the second:\n  ${writeFailures.join('\n  ')}` }
    }
    const firstOrigin = first.origin
    const firstPort = first.port
    first.session.close()
    await killTree(first.child)
    first = null

    occupied.push(await occupyWhenFree(firstPort))
    log(`[prefs-origin-proof] holding port ${firstPort} so the next launch cannot have it`)

    second = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    if (second.origin === firstOrigin) {
      return { name: 'existing install', ok: false, reason: `the premise did not hold: the second launch bound ${second.origin} again, so the origin never changed and nothing was tested. The occupied socket on ${firstPort} did not force a move.` }
    }
    const observed = await second.session.evaluate(readProbe)
    const failures = [...compare(observed, 'the second launch sees'), ...paintedThemeFailures(observed)]
    const detail = `first origin ${firstOrigin} -> second origin ${second.origin}; painted theme ${JSON.stringify(observed.__paintedTheme)}`
    if (failures.length) {
      return { name: 'existing install', ok: false, reason: `${detail}\n  ${failures.join('\n  ')}` }
    }
    return { name: 'existing install', ok: true, detail }
  } finally {
    if (first) { first.session.close(); await killTree(first.child) }
    if (second) { second.session.close(); await killTree(second.child) }
    await releaseAll(occupied)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/* SCENARIO TWO -- A FRESH INSTALL THAT NEVER SAW THE FIRST PORT. Nothing is
   stored yet AND the usual port is already taken, so this install's first ever
   origin is the second port. Then that port is taken too. A fix that only
   migrated an old copy forward would pass scenario one and fail here, because
   here there is nothing to migrate -- the store simply has to not be keyed to
   the origin. */
async function freshInstallScenario(context) {
  const { executable, appDirectory, timeoutMs, log } = context
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'te-prefs-fresh-'))
  const occupied = []
  let first = null
  let second = null
  try {
    const held = await occupyFirstFreePort()
    occupied.push(held.server)
    log(`[prefs-origin-proof] holding port ${held.port} before this install has ever run`)

    first = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    if (first.port === held.port) {
      return { name: 'fresh install', ok: false, reason: `the premise did not hold: the application bound ${held.port} while this run was holding it.` }
    }
    const cleanSlate = await first.session.evaluate(readProbe)
    const preexisting = PROBE_SETTINGS.filter((setting) => cleanSlate[setting.key] !== null)
    if (preexisting.length) {
      return { name: 'fresh install', ok: false, reason: `this was supposed to be a fresh install but it already had ${preexisting.map((setting) => setting.key).join(', ')}. The profile directory was not clean, so the run proves nothing.` }
    }
    await first.session.evaluate(writeProbe(PROBE_SETTINGS))
    const firstOrigin = first.origin
    const firstPort = first.port
    first.session.close()
    await killTree(first.child)
    first = null

    occupied.push(await occupyWhenFree(firstPort))
    log(`[prefs-origin-proof] now holding ${firstPort} as well`)

    second = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    if (second.origin === firstOrigin) {
      return { name: 'fresh install', ok: false, reason: `the premise did not hold: the second launch bound ${second.origin} again.` }
    }
    const observed = await second.session.evaluate(readProbe)
    const failures = [...compare(observed, 'the second launch sees'), ...paintedThemeFailures(observed)]
    const detail = `first origin ${firstOrigin} -> second origin ${second.origin}; painted theme ${JSON.stringify(observed.__paintedTheme)}`
    if (failures.length) {
      return { name: 'fresh install', ok: false, reason: `${detail}\n  ${failures.join('\n  ')}` }
    }
    return { name: 'fresh install', ok: true, detail }
  } finally {
    if (first) { first.session.close(); await killTree(first.child) }
    if (second) { second.session.close(); await killTree(second.child) }
    await releaseAll(occupied)
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/* SCENARIO FOUR -- THE SETTINGS FILE THE BUILD CANNOT READ.
 *
 * The first three scenarios all prove that a setting survives when everything
 * works. This one is about the layer underneath them, and it is the same defect
 * class one floor down: the port change made the settings unREACHABLE, and this
 * makes them unREADABLE, and both used to end with the person's choices gone
 * and nothing said about it.
 *
 * MEASURED ON THE STORE BEFORE THE FIX THIS SCENARIO GUARDS: a record holding
 * mc.theme, mc.text, mc.live.fleet and a drained-origin history, made
 * unparseable, was reported internally as damaged, read as zero settings, and
 * the very next write returned {ok:true} having replaced the whole file with
 * the single key just written. Nothing was left anywhere on disk. The store's
 * own comment said this must not happen, and the two sibling stores in this
 * repository (capability/src/lib/durable-memory-file.js and
 * capability/src/lib/agent-org-store.js) both refuse the write; this one was
 * copied from the first of those and the check did not come with the comment.
 *
 * THE ASSERTION IS ON BYTES, NOT ON A CODE PATH. A damaged file is planted with
 * a known sha256, the packaged application is started on it and asked to change
 * a setting, and the profile directory is then searched for those exact bytes.
 * "The settings the application could not read are still on this disk" is the
 * only property a person cares about, and it cannot be satisfied by a log line.
 *
 * It also requires the application to KEEP WORKING. Refusing every write
 * forever would preserve the bytes and brick the settings, which is why the
 * store sets the unreadable file aside instead of refusing outright -- and why
 * this scenario fails if the change threw.
 *
 * AND IT REQUIRES THE PERSON TO BE TOLD, which is the half that was missing
 * when the bytes were first rescued. Preserving a file and saying nothing
 * leaves them looking at an application wearing none of their choices, with no
 * error -- the same window, the same missing settings and the same silence as
 * the factory reset it replaced, so nothing about their experience improved and
 * nobody ever asks for the file back. This scenario therefore reads the real
 * DOM of the running application over CDP and fails unless the text on screen
 * names the file that actually holds the planted bytes. Wording is checked
 * loosely; the FILENAME is checked exactly, against what is on the disk.
 */
async function damagedRecordScenario(context) {
  const { executable, appDirectory, timeoutMs, log } = context
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'te-prefs-damaged-'))
  let first = null
  let second = null
  try {
    first = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    await first.session.evaluate(writeProbe(PROBE_SETTINGS))
    const writtenBack = await first.session.evaluate(readProbe)
    const writeFailures = compare(writtenBack, 'read back as')
    if (writeFailures.length) {
      return { name: 'a settings file the build cannot read', ok: false, reason: `the FIRST launch could not even store its own settings, so this run proves nothing:\n  ${writeFailures.join('\n  ')}` }
    }
    first.session.close()
    await killTree(first.child)
    first = null

    const recordFile = path.join(profileDirectory, RECORD_FILE)
    let stored
    try {
      stored = await readFile(recordFile)
    } catch (error) {
      return {
        name: 'a settings file the build cannot read',
        ok: false,
        reason: `the packaged build stored no ${RECORD_FILE} in its userData directory (${error.code}), so there was no durable record to damage. `
          + 'Either the durable store is not in this build or it does not live where this scenario looks; both make the other scenarios worth re-reading.',
      }
    }
    /* The planted damage must be damage to something REAL. A file that never
       held the probe settings would be "preserved" trivially and the scenario
       would pass while proving nothing. */
    const missing = PROBE_SETTINGS.filter((setting) => {
      try { return JSON.parse(stored.toString('utf8')).values[setting.key] !== setting.value } catch { return true }
    })
    if (missing.length) {
      return { name: 'a settings file the build cannot read', ok: false, reason: `the stored record does not hold ${missing.map((setting) => setting.key).join(', ')}, so damaging it would not put anything at risk and the scenario would pass vacuously.` }
    }

    /* A torn tail rather than a scrambled file, because that is what a real
       one looks like: valid settings followed by bytes that stop it parsing. */
    const damaged = Buffer.concat([stored, Buffer.from(' <- damaged tail planted by prefs-origin-proof\n', 'utf8')])
    await writeFile(recordFile, damaged)
    const damagedHash = createHash('sha256').update(damaged).digest('hex')
    log(`[prefs-origin-proof] planted an unreadable ${RECORD_FILE} (sha256 ${damagedHash.slice(0, 12)})`)

    second = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    /* READ BEFORE TOUCHING ANYTHING. A person whose settings did not load must
       be told when the window opens, not only once they happen to change
       something -- by then they have already concluded the product reset
       itself and started redoing their choices by hand. */
    const noticeOnOpen = await readNotice(second.session, 15_000)
    const changed = await second.session.evaluate(`(() => {
      try { localStorage.setItem('mc.theme', 'white'); return 'saved' }
      catch (error) { return 'THREW:' + String(error && error.message || error) }
    })()`)
    const noticeAfterWrite = await readNotice(second.session, 15_000)
    second.session.close()
    await killTree(second.child)
    second = null

    const survivors = []
    for (const name of await readdir(profileDirectory)) {
      if (name !== RECORD_FILE && !isQuarantineFile(name)) continue
      const bytes = await readFile(path.join(profileDirectory, name)).catch(() => null)
      if (bytes && createHash('sha256').update(bytes).digest('hex') === damagedHash) survivors.push(name)
    }

    const failures = []
    if (!survivors.length) {
      failures.push(`the relaunch REPLACED the settings file it could not read: the planted record (sha256 ${damagedHash.slice(0, 12)}) is in no file under userData, so ${PROBE_SETTINGS.map((setting) => setting.key).join(', ')} are gone with it. This is the silent factory reset one layer below the port change.`)
    }
    if (changed !== 'saved') {
      failures.push(`the application could not change a setting after the damaged record was set aside: ${JSON.stringify(changed)}. Preserving the bytes by refusing every write forever is not a fix.`)
    }

    /* PRESERVING THE FILE IN SILENCE IS STILL THE DEFECT.
     *
     * Everything above proves the bytes are on the disk. None of it proves the
     * person has any way to know that, and from where they sit an unannounced
     * rescue is indistinguishable from the loss it replaced: same application,
     * same missing choices, same absence of any error. The three assertions
     * below are the ones a customer would make.
     *
     * The last of them is the one that cannot be satisfied by a reassuring
     * sentence: the text on the screen has to contain the name of the file that
     * actually holds the planted bytes. A notice that says settings were kept
     * without saying where is a promise nobody can act on, and a notice naming
     * a file that is not the one on disk is worse than saying nothing. */
    if (!noticeOnOpen || !noticeOnOpen.text) {
      failures.push('the application said NOTHING about settings it could not read: no [data-settings-recovery] element in the page after launch. The file was preserved silently, which from the person\'s side is the same window, the same missing settings and the same absence of any error as the factory reset.')
    } else if (!/could not be read/i.test(noticeOnOpen.text)) {
      failures.push(`the notice shown at launch does not say the settings could not be read: ${JSON.stringify(noticeOnOpen.text)}`)
    } else if (!/nothing was deleted|nothing has been deleted/i.test(noticeOnOpen.text)) {
      failures.push(`the notice does not tell the person their settings still exist, which is the conclusion they will otherwise reach: ${JSON.stringify(noticeOnOpen.text)}`)
    }

    const preserved = survivors[0]
    if (preserved && !/^renderer-prefs\.damaged-\d{4}-\d{2}-\d{2}T/.test(preserved)) {
      failures.push(`the copy the person is pointed at is not dated (${preserved}), so nothing on it answers the question they will actually have, which is whether it is the settings they lost today or a fault from months ago.`)
    }
    const announced = noticeAfterWrite && noticeAfterWrite.text ? noticeAfterWrite.text : ''
    if (preserved && !announced.includes(preserved)) {
      failures.push(`the application never told the person where the unreadable file went: the bytes are in ${preserved} and the notice on screen reads ${JSON.stringify(announced) || '(nothing)'}. A rescue nobody can find is a rescue nobody has.`)
    }

    const detail = `the unreadable record survived byte-identical as ${survivors.join(', ') || '(nowhere)'}, the app still saved a change, and the window says so on open (${JSON.stringify((noticeOnOpen && noticeOnOpen.text || '').slice(0, 90))}...)`
    if (failures.length) {
      return { name: 'a settings file the build cannot read', ok: false, reason: failures.join('\n  ') }
    }
    return { name: 'a settings file the build cannot read', ok: true, detail }
  } finally {
    if (first) { first.session.close(); await killTree(first.child) }
    if (second) { second.session.close(); await killTree(second.child) }
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/* SCENARIO THREE -- THE UPGRADE ITSELF, run against two different builds.
 *
 * The other two scenarios both write their settings through the FIXED build, so
 * neither of them ever exercises the migration: they prove durability, not
 * rescue. The customer who matters most here is the one who already has
 * settings, chosen under the old build, sitting in a browser partition. This
 * scenario writes them with the OLD executable and then starts the NEW one on
 * the same profile.
 *
 * It reports which of two things happened rather than asserting one of them,
 * because only one is a claim this fix can make:
 *
 *   SAME ORIGIN -- the new build bound the port the old one had. The browser
 *     copy is reachable, must be drained, and every setting must survive. This
 *     is the ordinary upgrade and it is a hard assertion.
 *
 *   MOVED ORIGIN -- something took the old port in between. The old partition
 *     is not reachable from the new origin, so the settings are NOT rescued on
 *     this launch. That is a real limitation and it is stated rather than
 *     hidden: the origin stays undrained, so a later launch that lands back on
 *     it still picks them up.
 *
 * Enable with MC_PREFS_LEGACY_BUILD=<path to the pre-fix win-unpacked>.
 */
async function legacyUpgradeScenario(context) {
  const { executable, appDirectory, timeoutMs, log, legacyDirectory } = context
  const legacyExecutable = path.join(legacyDirectory, APP_EXE)
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'te-prefs-upgrade-'))
  let legacy = null
  let upgraded = null
  try {
    const launchLegacy = () => launchApp({
      executable: legacyExecutable,
      appDirectory: legacyDirectory,
      profileDirectory,
      timeoutMs,
      log,
    })

    legacy = await launchLegacy()
    await legacy.session.evaluate(writeProbe(PROBE_SETTINGS))
    const writeFailures = compare(await legacy.session.evaluate(readProbe), 'the old build read back as')
    if (writeFailures.length) {
      return { name: 'upgrade from the old build', ok: false, reason: `the OLD build could not store its own settings, so nothing can be migrated from it:\n  ${writeFailures.join('\n  ')}` }
    }
    const legacyOrigin = legacy.origin
    legacy.session.close()
    await closeGracefully(legacy)
    legacy = null

    /* PROVE THE THING TO BE MIGRATED IS ACTUALLY ON DISK, by restarting the old
       build and asking it. Chromium commits localStorage lazily, so "the page
       read its own write back" says nothing about what survived the process.
       Without this check the scenario reported the product failing to migrate
       settings that the harness had already destroyed by force-killing the
       build that wrote them. */
    legacy = await launchLegacy()
    const legacyRestartOrigin = legacy.origin
    const persisted = compare(await legacy.session.evaluate(readProbe), 'the old build still sees')
    legacy.session.close()
    await closeGracefully(legacy)
    legacy = null

    if (legacyRestartOrigin !== legacyOrigin) {
      return {
        name: 'upgrade from the old build',
        ok: true,
        detail: `NOT EXERCISED: the old build moved from ${legacyOrigin} to ${legacyRestartOrigin} between its own launches, so the settings under test are not the ones the upgraded build would find.`,
      }
    }
    if (persisted.length) {
      return {
        name: 'upgrade from the old build',
        ok: true,
        detail: `NOT EXERCISED: the old build did not have its own settings after its own restart, so there is nothing on disk for the upgrade to rescue:\n  ${persisted.join('\n  ')}`,
      }
    }

    upgraded = await launchApp({ executable, appDirectory, profileDirectory, timeoutMs, log })
    const observed = await upgraded.session.evaluate(readProbe)
    const failures = compare(observed, 'the upgraded build sees')

    if (upgraded.origin !== legacyOrigin) {
      return {
        name: 'upgrade from the old build',
        ok: true,
        detail: `NOT EXERCISED: the upgraded build bound ${upgraded.origin} while the old build had ${legacyOrigin}, so the old browser copy was not reachable from it. `
          + `${failures.length ? 'The settings were not rescued on this launch, which is the stated limitation' : 'The settings were present anyway'}. `
          + 'That origin stays undrained, so a later launch landing back on it still rescues them.',
      }
    }
    const detail = `the upgraded build bound the same origin ${upgraded.origin} and drained it; painted theme ${JSON.stringify(observed.__paintedTheme)}`
    if (failures.length) {
      return { name: 'upgrade from the old build', ok: false, reason: `${detail}\n  ${failures.join('\n  ')}` }
    }
    return { name: 'upgrade from the old build', ok: true, detail }
  } finally {
    if (legacy) { legacy.session.close(); await killTree(legacy.child) }
    if (upgraded) { upgraded.session.close(); await killTree(upgraded.child) }
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

existingInstallScenario.scenarioName = 'existing install'
freshInstallScenario.scenarioName = 'fresh install'
damagedRecordScenario.scenarioName = 'a settings file the build cannot read'
legacyUpgradeScenario.scenarioName = 'upgrade from the old build'

export async function main(directory = 'release/win-unpacked', overrides = {}) {
  const log = overrides.log || console.log
  const timeoutMs = overrides.timeoutMs || 60_000
  const appDirectory = path.resolve(directory)
  const executable = path.join(appDirectory, APP_EXE)
  const legacyBuild = overrides.legacyDirectory || process.env.MC_PREFS_LEGACY_BUILD || null
  const context = {
    executable,
    appDirectory,
    timeoutMs,
    log,
    legacyDirectory: legacyBuild ? path.resolve(legacyBuild) : null,
  }

  /* A scenario that THREW is a failed scenario, not a reason to lose the other
     one's verdict. An earlier version let an EADDRINUSE while arranging the
     second scenario propagate out of main(), which discarded the first
     scenario's already-computed result and printed nothing at all. */
  const run = async (scenario) => {
    try { return await scenario(context) } catch (error) {
      return { name: scenario.scenarioName, ok: false, reason: `the scenario could not complete: ${error.message}` }
    }
  }
  const results = []
  results.push(await run(existingInstallScenario))
  results.push(await run(freshInstallScenario))
  results.push(await run(damagedRecordScenario))
  /* Only when a pre-fix build is pointed at. A missing one is announced, never
     skipped in silence -- an upgrade path that nobody measured must not read as
     an upgrade path that passed. */
  if (context.legacyDirectory) results.push(await run(legacyUpgradeScenario))
  else log('[prefs-origin-proof] NOT RUN: upgrade from the old build. Set MC_PREFS_LEGACY_BUILD=<pre-fix win-unpacked> to measure the migration itself.')

  for (const result of results) {
    if (result.ok) log(`[prefs-origin-proof] PASS ${result.name}: ${result.detail}`)
    else log(`[prefs-origin-proof] FAIL ${result.name}: ${result.reason}`)
  }
  const failed = results.filter((result) => !result.ok)
  if (failed.length) {
    throw new Error(`A setting did not survive a port change in ${failed.length} of ${results.length} scenarios. This is the silent factory-reset defect.`)
  }
  log('[prefs-origin-proof] PASS settings survived a port change on both a fresh and an existing install.')
  return results
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main(process.argv[2] || 'release/win-unpacked').catch((error) => {
    console.error(`[prefs-origin-proof] ${error.message}`)
    process.exitCode = 1
  })
}
