/* DOES THE ORGANISATION BRIDGE WORK IN THE REAL WINDOW?
 *
 * tools/org-persistence-proof.mjs proves the shipped PAYLOAD persists an org
 * edit, by running the packaged binary as node. That is most of the answer and
 * it is not all of it: it never loads shell/main.cjs, never registers an
 * ipcMain handler, never runs the preload, and so cannot tell you whether the
 * page can reach any of it. A payload that works and a window that cannot call
 * it is precisely the shape of defect this lane was sent to remove -- a control
 * that looks real and does nothing.
 *
 * So this launches the ACTUAL packaged application -- real main process, real
 * preload, real contextBridge, real ipcMain sender check -- attaches to its
 * window over the DevTools protocol, and calls window.mcOrg from inside the
 * page, which is the same object the agent page calls.
 *
 * It runs against a sterile LOCALAPPDATA for the same reason the other proof
 * does: that directory is where the engine keeps an installation's state, and
 * inheriting this machine's copy would mean testing against a fleet and a
 * permission level a customer will not have.
 *
 * Usage:
 *   node tools/org-window-proof.mjs [release/win-unpacked]
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const APP_EXE = 'ToolsEnabled.exe'
const DEBUG_PORT = 9333

let failures = 0
function assert(condition, label, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else { failures += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'toolsenabled-window-proof-'))
  const profile = {
    root,
    localAppData: path.join(root, 'LocalAppData'),
    appData: path.join(root, 'AppData'),
    userProfile: path.join(root, 'UserProfile'),
    userData: path.join(root, 'UserData'),
    temp: path.join(root, 'Temp'),
  }
  for (const directory of Object.values(profile)) {
    if (directory !== root) await mkdir(directory, { recursive: true })
  }
  return profile
}

/* Both are isolated, and they are different things. --user-data-dir moves
 * Electron's own profile; LOCALAPPDATA moves the directory the ENGINE reads.
 * Isolating only the first is how a harness ends up reading this machine's
 * permission level while believing it has a fresh install. */
function windowEnvironment(profile, base = process.env) {
  return {
    SystemRoot: base.SystemRoot,
    windir: base.windir,
    ComSpec: base.ComSpec,
    PATHEXT: base.PATHEXT,
    NUMBER_OF_PROCESSORS: base.NUMBER_OF_PROCESSORS,
    PROCESSOR_ARCHITECTURE: base.PROCESSOR_ARCHITECTURE,
    Path: [path.join(base.SystemRoot || 'C:\\Windows', 'System32'), base.SystemRoot || 'C:\\Windows'].join(';'),
    LOCALAPPDATA: profile.localAppData,
    APPDATA: profile.appData,
    USERPROFILE: profile.userProfile,
    TEMP: profile.temp,
    TMP: profile.temp,
  }
}

async function findPageTarget(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* the window has not opened its debugger yet */ }
    await sleep(500)
  }
  throw new Error(`no debuggable page appeared on port ${port} within ${timeoutMs}ms`)
}

/* A minimal DevTools client. Node 22 ships a global WebSocket, so this needs no
 * dependency -- which matters, because the payload ships zero npm packages and a
 * proof that needed one would not be runnable from a clean checkout. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => reject(new Error(`devtools socket error: ${event?.message || 'unknown'}`)))
  })
  socket.addEventListener('message', (event) => {
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    const waiter = packet.id !== undefined ? pending.get(packet.id) : null
    if (!waiter) return
    pending.delete(packet.id)
    if (packet.error) waiter.reject(new Error(JSON.stringify(packet.error)))
    else waiter.resolve(packet.result)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`))
        }, 30000)
      })
    },
    close() { try { socket.close() } catch { /* already gone */ } },
  }
}

/* Evaluated INSIDE the page, so what is exercised is the same contextBridge
 * object the agent page uses -- not a copy of it constructed here. */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description || '')}`)
  }
  return result.result.value
}

async function main() {
  const directory = process.argv[2] || 'release/win-unpacked'
  const exe = path.resolve(directory, APP_EXE)
  if (!existsSync(exe)) {
    console.error(`No packaged application at ${exe}. Run: npm run dist`)
    process.exit(2)
  }
  const profile = await makeProfile()
  console.log(`Driving the REAL packaged window at ${exe}`)
  console.log(`Isolated LOCALAPPDATA: ${profile.localAppData}`)

  const child = spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile.userData}`,
  ], { env: windowEnvironment(profile), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let childOutput = ''
  child.stdout.on('data', (chunk) => { childOutput += chunk })
  child.stderr.on('data', (chunk) => { childOutput += chunk })

  let client
  try {
    const target = await findPageTarget(DEBUG_PORT)
    client = connect(target.webSocketDebuggerUrl)
    await client.ready
    await client.send('Runtime.enable')

    // The window has to have finished loading before window.mcOrg exists.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const present = await evaluate(client, 'return typeof window.mcOrg')
      if (present === 'object') break
      await sleep(500)
    }

    assert(await evaluate(client, 'return typeof window.mcOrg') === 'object',
      'window.mcOrg is exposed to the page by the packaged preload')

    const methods = await evaluate(client, 'return Object.keys(window.mcOrg).sort()')
    assert(JSON.stringify(methods) === JSON.stringify(
      ['assignRole', 'createRole', 'editRole', 'exportOrg', 'read', 'reparent', 'reset', 'resetRole']),
    'every organisation channel is bridged', JSON.stringify(methods))

    const read = await evaluate(client, 'return await window.mcOrg.read()')
    assert(read && read.ok === true, 'mc-org:read round-trips through real IPC to the shipped payload',
      JSON.stringify(read).slice(0, 300))
    assert(read?.org?.source === 'baseline', 'a fresh profile reads the shipped baseline', read?.org?.source)
    assert(Array.isArray(read?.roles) && read.roles.length === 9,
      'the nine shipped roles reach the page', `got ${read?.roles?.length}`)

    /* The honesty requirement, checked at the surface rather than in the engine:
       the page is given what each role ENFORCES, not only what it says. A role
       menu that showed only descriptions would be offering a promise the product
       might not keep. */
    const readOnly = (read.roles || []).filter((role) => role.enforced && role.enforced.mayClaimWork === false)
      .map((role) => role.id).sort()
    assert(JSON.stringify(readOnly) === JSON.stringify(
      ['coordinator-assistant', 'observer', 'planner', 'reviewer', 'shadow-manager']),
    'the page is told which roles are mechanically stopped from claiming work', JSON.stringify(readOnly))
    assert((read.roles || []).every((role) => typeof role.summary === 'string' && typeof role.mustNot === 'string'),
      'every role reaches the page with both its summary and its mustNot')

    // A real mutation, through the real handler, from inside the real page.
    const created = await evaluate(client, `return await window.mcOrg.createRole({
      id: 'window-proof-role',
      baseDefaultRole: 'observer',
      rules: {
        owns: 'Proving the window can define a role.',
        mustNot: 'Be mistaken for a shipped role.',
        handoff: 'Receives nothing; exists to be observed.'
      }
    })`)
    assert(created && created.ok === true, 'a custom role can be CREATED from the page', JSON.stringify(created).slice(0, 300))
    const mine = (created.roles || []).find((role) => role.id === 'window-proof-role')
    assert(Boolean(mine), 'the new role comes back in the role list')
    assert(mine && mine.custom === true && mine.baseDefaultRole === 'observer', 'it is reported as custom, with its base')
    assert(mine && mine.enforced.mayClaimWork === false,
      'a role based on observer is reported to the page as unable to reserve work')

    const reserved = await evaluate(client, `return await window.mcOrg.createRole({
      id: 'owner', baseDefaultRole: 'builder',
      rules: { owns: 'a', mustNot: 'b', handoff: 'c' }
    })`)
    assert(reserved && reserved.ok === false && reserved.code === 'CUSTOM_ROLE_RESERVED_ID',
      'the page is refused a reserved role id, with a code it can branch on', JSON.stringify(reserved).slice(0, 200))

    const badReparent = await evaluate(client, `return await window.mcOrg.reparent({ agentId: 'controller', parentId: 'controller' })`)
    assert(badReparent && badReparent.ok === false,
      'an illegal reparent is refused rather than silently accepted', JSON.stringify(badReparent).slice(0, 200))
    assert(typeof badReparent.reason === 'string' && badReparent.reason.length > 0,
      'a refusal carries a sentence the page can show a person', badReparent.reason)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  the proof could not complete -- ${error.message}`)
    if (childOutput.trim()) console.log(`  child output:\n${childOutput.slice(0, 2000)}`)
  } finally {
    if (client) client.close()
    child.kill('SIGKILL')
    await sleep(500)
    await rm(profile.root, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n${failures === 0 ? 'WINDOW BRIDGE PROVEN' : `${failures} ASSERTION(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(2) })
