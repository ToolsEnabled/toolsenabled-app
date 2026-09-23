#!/usr/bin/env node

/* DOES THE REAL, PACKAGED APPLICATION CARRY A RENAMED INSTALL'S DATA ACROSS?
 *
 * tools/test/userdata-adoption.test.mjs proves the module. It cannot prove the
 * module is REACHED: shell/main.cjs resolves userData at module scope in several
 * places, and an adoption wired in below any of them would be dead code that
 * still passes every unit test. Source text cannot see that difference. This
 * launches release/win-unpacked/ToolsEnabled.exe and reads what ends up on disk.
 *
 * IT NEVER TOUCHES THE REAL %APPDATA%. The legacy install it adopts from is
 * seeded in a temp directory, and the app is pointed at a sibling of it with
 * --user-data-dir. That works because shell/userdata-adoption.cjs looks for a
 * prior installation beside wherever userData actually is, rather than in a
 * fixed OS folder -- so this exercise uses invented data, not a person's.
 *
 * USAGE: node tools/userdata-adoption-packaged-proof.mjs [win-unpacked-dir]
 */

import { spawn, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const execFile = promisify(execFileCb)

const APP_EXE = 'ToolsEnabled.exe'
const READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 250
const PROBE_THEME = 'black'
const PROBE_NOTE = '# work that predates the rename\n'
const CACHE_MARKER = 'legacy-only-marker.bin'
const LEGACY_LEDGER_MARKER = 'legacy-session-that-must-not-travel'

const unpackedDirectory = path.resolve(process.argv[2] || 'release/win-unpacked')
const executable = path.join(unpackedDirectory, APP_EXE)

function fail(message) {
  console.error(`[userdata-adoption-proof] FAIL: ${message}`)
  process.exitCode = 1
}

/* Windows kills only the named process; Electron's renderer and GPU children
   outlive it and keep the port. */
async function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already gone */ }
}

function seedLegacyInstall(directory) {
  fs.mkdirSync(path.join(directory, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1,
    values: { 'mc.theme': PROBE_THEME },
    drainedOrigins: [],
  }))
  fs.writeFileSync(path.join(directory, 'shell-state.json'), JSON.stringify({ bounds: { width: 1440, height: 900 } }))
  fs.writeFileSync(path.join(directory, 'workspace', 'notes.md'), PROBE_NOTE)
  /* Chromium noise a real install would also have, to prove it is NOT copied.
     The assertion is on a marker filename Chromium never writes, because the
     running application creates a Cache/ of its own within a second of starting
     and asserting on the DIRECTORY made the proof a race -- it passed or failed
     on how long the record took to appear. */
  fs.mkdirSync(path.join(directory, 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'Cache', 'data_0'), 'x'.repeat(4096))
  fs.writeFileSync(path.join(directory, 'Cache', CACHE_MARKER), 'only the previous install has this\n')
}

async function waitForAdoptionRecord(recordPath, child, deadline, settled, getLaunchError) {
  /* KEPT SO THE TIMEOUT CAN NAME WHAT IT KEPT SEEING. A build that leaves a
     planted verdict untouched times out here, and "no record within 60000ms" is
     a false description of that -- there IS a record, it is the person's
     stranding, and the app declined to revisit it. */
  let lastSeen = null
  while (Date.now() < deadline) {
    const launchError = getLaunchError()
    if (launchError) {
      throw new Error(`the application could not be launched: ${launchError.message}`)
    }
    if (fs.existsSync(recordPath)) {
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
        lastSeen = record
        if (record.status === 'complete' && settled(record)) return record
      } catch { /* still being written */ }
    }
    if (child.exitCode !== null && !fs.existsSync(recordPath)) {
      throw new Error(`the application exited (code ${child.exitCode}) before writing an adoption record`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  if (lastSeen) {
    throw new Error(
      `within ${READY_TIMEOUT_MS}ms the application never replaced the verdict already at ${recordPath}, ` +
      `which still reads {status:${lastSeen.status}, adopted:${lastSeen.adopted}, reason:${lastSeen.reason}} ` +
      'and carries no evidence. This build honours an unevidenced negative verdict, so the previous install ' +
      'beside this one is unreachable by any future version.',
    )
  }
  throw new Error(`no completed adoption record at ${recordPath} within ${READY_TIMEOUT_MS}ms`)
}

/* Launch the packaged application against a prepared pair of directories and
   hand back the adoption record it wrote. `settled` exists because one scenario
   PLANTS a completed record: without it the poll would read the planted one and
   report the app's own decision as having already happened. */
async function runAgainst({ current, settled }) {
  /* An agent harness or host terminal may export ELECTRON_RUN_AS_NODE=1, which
     turns the Electron binary into plain Node: no window, exit 0, and a
     signature indistinguishable from a crash. See
     tools/test/electron-run-as-node-harness-guard.test.mjs. */
  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home inside this scenario's scratch root -- the adoption under test is
     between the two userData directories named below and never involves the
     real %APPDATA% -- and ELECTRON_RUN_AS_NODE deleted. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(path.dirname(current), 'homes'))))
  environment.MC_SMOKE_HEADLESS = '1'

  let output = ''
  const child = spawn(executable, [
    `--user-data-dir=${current}`,
    '--disable-gpu',
    '--disable-gpu-sandbox',
  ], {
    cwd: unpackedDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  /* spawn() reports failures such as an unreadable or invalid executable on
     the child rather than by throwing. Without an error listener that normal
     proof failure becomes an uncaught EventEmitter exception. Keep it for the
     poller so launch failure is reported through the check's ordinary FAIL
     path and cleanup still runs. */
  let launchError = null
  child.once('error', (error) => { launchError = error })
  child.stdout?.on('data', (chunk) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk) => { output += chunk.toString() })

  try {
    const record = await waitForAdoptionRecord(
      path.join(current, '.userdata-adoption.json'),
      child,
      Date.now() + READY_TIMEOUT_MS,
      settled,
      () => launchError,
    )
    return { record, output }
  } finally {
    await killTree(child)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/* SCENARIO 1: the rename, met by an install that has never run this build. */
async function provePlainRename(root) {
  const legacy = path.join(root, 'Mission Control')
  const current = path.join(root, 'ToolsEnabled')
  seedLegacyInstall(legacy)

  const { record } = await runAgainst({ current, settled: () => true })

  if (record.adopted !== true) {
    fail(`the packaged app did not adopt the previous install (reason ${record.reason}). A real customer would see an empty product.`)
    return false
  }
  const prefsPath = path.join(current, 'renderer-prefs.json')
  if (!fs.existsSync(prefsPath)) {
    fail('renderer-prefs.json was not carried across; every setting the person chose is gone')
    return false
  }
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
  if (prefs.values?.['mc.theme'] !== PROBE_THEME) {
    fail(`theme did not survive: expected ${PROBE_THEME}, found ${prefs.values?.['mc.theme']}`)
    return false
  }
  const notePath = path.join(current, 'workspace', 'notes.md')
  if (!fs.existsSync(notePath) || fs.readFileSync(notePath, 'utf8') !== PROBE_NOTE) {
    fail("the person's workspace did not come across")
    return false
  }
  if (fs.existsSync(path.join(current, 'Cache', CACHE_MARKER)) || record.entries.includes('Cache')) {
    fail("Chromium's cache was copied between installations; only the product's own state should move")
    return false
  }
  console.log('[userdata-adoption-proof] PASS the rename: the packaged app adopted the renamed install')
  console.log(`[userdata-adoption-proof]   adopted from: ${path.basename(record.from)}`)
  console.log(`[userdata-adoption-proof]   entries: ${record.entries.join(', ')}`)
  return true
}

/* SCENARIO 2: THE PERSON AN EARLIER BUILD ALREADY STRANDED.
 *
 * MEASURED on the build machine, 2026-08-11:
 *   %APPDATA%\ToolsEnabled\.userdata-adoption.json
 *     { status: complete, adopted: false, reason: NO_PRIOR_INSTALL }
 * with %APPDATA%\Mission Control holding shell-state.json, agent-spawn-key.enc
 * and agent-spawn-records.jsonl. The module answers ADOPTED when it is run
 * against those very directories, so the verdict on disk contradicts the code
 * that wrote it -- and a verdict is honoured, so no later version could correct
 * it. That is one install already dead, and every customer who upgrades into
 * the same false negative is another.
 *
 * The target is also seeded with settings of its own, because that is what the
 * stranded person actually has: months of using the new install. Their current
 * settings must survive untouched -- the rescue is only ever what the new
 * install does not already have. */
async function proveStrandedByAnEvidencelessVerdict(root) {
  const legacy = path.join(root, 'Mission Control')
  const current = path.join(root, 'ToolsEnabled')
  seedLegacyInstall(legacy)
  fs.mkdirSync(current, { recursive: true })
  fs.writeFileSync(path.join(current, '.userdata-adoption.json'), JSON.stringify({
    version: 1, status: 'complete', adopted: false, reason: 'NO_PRIOR_INSTALL', at: '2026-08-11T12:11:04.287Z',
  }))
  fs.writeFileSync(path.join(current, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1, values: { 'mc.theme': 'white' }, drainedOrigins: [],
  }))

  /* The planted record is already `complete`; only a record carrying evidence,
     or an adoption, is this launch's own answer. */
  const { record } = await runAgainst({
    current,
    settled: (written) => written.adopted === true || Array.isArray(written.searched),
  })

  if (record.adopted !== true) {
    fail(
      `a stranded install stayed stranded (reason ${record.reason}). The previous install is sitting beside this one ` +
      'with the person\'s work in it, and honouring an unevidenced negative verdict means no version can ever reach it.',
    )
    return false
  }
  const notePath = path.join(current, 'workspace', 'notes.md')
  if (!fs.existsSync(notePath) || fs.readFileSync(notePath, 'utf8') !== PROBE_NOTE) {
    fail("the stranded person's workspace still did not come across")
    return false
  }
  const prefs = JSON.parse(fs.readFileSync(path.join(current, 'renderer-prefs.json'), 'utf8'))
  if (prefs.values?.['mc.theme'] !== 'white') {
    fail(`the rescue overwrote settings the person is using now: mc.theme is ${prefs.values?.['mc.theme']}, expected white`)
    return false
  }
  console.log('[userdata-adoption-proof] PASS the stranded install: an unevidenced "nothing to adopt" was reopened')
  console.log(`[userdata-adoption-proof]   entries: ${record.entries.join(', ')}`)
  console.log('[userdata-adoption-proof]   settings already in the new install were left alone')
  return true
}

/* SCENARIO 3: THE SIGNING KEY THE NEW INSTALL CANNOT OPEN.
 *
 * THE ONLY PLACE THIS CAN BE PROVED. The unit suite proves the module refuses an
 * unopenable key; it cannot prove that the REAL keystore is the thing being
 * asked. If shell/main.cjs stopped passing canDecrypt, every unit test would
 * stay green and the module would answer NOT_CHECKABLE -- a refusal that looks
 * identical from the outside and is reached for the wrong reason.
 *
 * So the assertion is on the VERDICT, not merely on the refusal: only a real
 * safeStorage that was handed real bytes and threw can produce REFUSED. That one
 * word is the wiring.
 *
 * WHY THIS MATTERS: adopting this file across the rename disabled Start
 * permanently for every upgrading customer, at every tier, with the product's
 * only explanation being that a key could not be opened. Measured on the build
 * machine: %APPDATA%\Mission Control\agent-spawn-key.enc and the ToolsEnabled one
 * both begin "v10" (Chromium OSCrypt) and neither opens under the other's
 * profile key. The blob seeded below fails to authenticate for the same reason. */
async function proveUnopenableSigningKeyIsNotAdopted(root) {
  const legacy = path.join(root, 'Mission Control')
  const current = path.join(root, 'ToolsEnabled')
  seedLegacyInstall(legacy)

  /* A well-formed Chromium OSCrypt header over bytes no keystore on this machine
     can authenticate -- the same 150-byte shape as the real file. */
  const sealedKey = Buffer.concat([Buffer.from('v10', 'utf8'), crypto.randomBytes(147)])
  fs.writeFileSync(path.join(legacy, 'agent-spawn-key.enc'), sealedKey)
  const legacyLedger = `{"sequence":1,"action":"agent_session_start","sessionId":"${LEGACY_LEDGER_MARKER}"}\n`
  fs.writeFileSync(path.join(legacy, 'agent-spawn-records.jsonl'), legacyLedger)

  const { record } = await runAgainst({ current, settled: () => true })

  if (record.adopted !== true) {
    fail(`the packaged app refused the whole carry-over (reason ${record.reason}) instead of only the key it cannot open`)
    return false
  }
  const note = (record.notes || []).find((entry) => entry.code === 'SEALED_KEY_NOT_ADOPTED')
  if (!note) {
    fail(
      'the packaged app adopted the signing key with no note about it. This is the shipped defect: '
      + 'shell/spawn-record.cjs will find a key it cannot decrypt, raise SPAWN_RECORD_KEY_UNREADABLE, and '
      + 'refuse to regenerate -- Start is then disabled on every launch with no way back.',
    )
    return false
  }
  if (note.verdict !== 'REFUSED') {
    fail(
      `the key was skipped with verdict ${note.verdict}, not REFUSED. Only a real keystore that was handed the `
      + 'real bytes and threw can answer REFUSED, so this build is NOT asking the keystore -- '
      + 'shell/main.cjs is no longer passing canDecrypt, and the refusal here is an accident.',
    )
    return false
  }
  const adoptedKey = path.join(current, 'agent-spawn-key.enc')
  if (fs.existsSync(adoptedKey) && fs.readFileSync(adoptedKey).equals(sealedKey)) {
    fail('the unopenable key is sitting in the new install; Start is permanently disabled for this customer')
    return false
  }
  const adoptedLedger = path.join(current, 'agent-spawn-records.jsonl')
  if (fs.existsSync(adoptedLedger) && fs.readFileSync(adoptedLedger, 'utf8').includes(LEGACY_LEDGER_MARKER)) {
    fail('records signed by a key nothing can load were carried across; the product will report its own history as broken')
    return false
  }
  /* Nothing was destroyed to achieve it. */
  if (!fs.existsSync(path.join(legacy, 'agent-spawn-key.enc'))
    || !fs.readFileSync(path.join(legacy, 'agent-spawn-records.jsonl'), 'utf8').includes(LEGACY_LEDGER_MARKER)) {
    fail('the previous install\'s signed history was removed rather than left where the note says it is')
    return false
  }
  /* The rest of the person's data still travelled. */
  const prefs = JSON.parse(fs.readFileSync(path.join(current, 'renderer-prefs.json'), 'utf8'))
  if (prefs.values?.['mc.theme'] !== PROBE_THEME) {
    fail('the carry-over was abandoned along with the key')
    return false
  }
  console.log('[userdata-adoption-proof] PASS the unopenable key: refused by the REAL keystore, everything else adopted')
  console.log(`[userdata-adoption-proof]   verdict: ${note.verdict}; left behind: ${note.entries.join(', ')}`)
  console.log(`[userdata-adoption-proof]   still readable at: ${path.basename(note.from)}`)
  return true
}

async function main() {
  if (!fs.existsSync(executable)) {
    fail(`no packaged executable at ${executable} -- build it first (electron-builder --win --dir)`)
    return
  }

  for (const scenario of [
    provePlainRename,
    proveStrandedByAnEvidencelessVerdict,
    proveUnopenableSigningKeyIsNotAdopted,
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-adoption-proof-'))
    try {
      const passed = await scenario(root)
      if (!passed) return
    } catch (error) {
      fail(`${scenario.name}: ${error.message}`)
      return
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* temp dir */ }
    }
  }
}

await main()
