#!/usr/bin/env node

/* DOES A SESSION CHANGE THE DIRECTORY THE PROGRAM IS INSTALLED IN?
 *
 * THE DEFECT THIS GATE EXISTS FOR, measured on the real per-user install at
 * %LOCALAPPDATA%\Programs\toolsenabled on 2026-08-11. The packaged app had been
 * installed at 04:47 and run once. By 05:14 its own installation directory
 * contained, written by the running product:
 *
 *     resources/capability/state/mission-bridge-token.json      a live bearer
 *     resources/capability/state/mission-bridge-bootstrap-proof.json
 *     resources/capability/state/mission-bridge-runtime.json
 *     resources/capability/state/owner-public-prompts.json
 *     resources/capability/state/audit.sqlite3{,-wal,-shm}      the signed ledger
 *     resources/capability/logs/actions.{jsonl,log}
 *     resources/capability/vault/secrets.json{,.access.log}     the credentials
 *
 * Each line is a different failure. An UPDATE REPLACES THE INSTALL DIRECTORY,
 * so the customer's vault and audit ledger were living inside the blast radius
 * of the next version. A PER-MACHINE INSTALL puts that directory under Program
 * Files, where the writes fail or demand an elevation this product has no
 * business asking for. And a PROGRAM DIRECTORY IS WORLD-READABLE by default,
 * which is the wrong ACL for a bearer token however carefully each individual
 * file is locked afterwards.
 *
 * WHY THIS IS A HASH OF A DIRECTORY AND NOT AN ASSERTION ABOUT CODE.
 * A test that greps for the right path helper, or that checks the layer CALLS
 * statePath(), cannot see the write that goes around it -- a sqlite sidecar, a
 * lock file, a PowerShell helper resolving its own location, a temp file from a
 * library nobody edited. Source text cannot observe reachability and cannot
 * observe a program it does not contain. The only question that admits no
 * evasion is the customer's: after using this thing, is the directory it was
 * installed to byte-for-byte what the installer put there? So that is the
 * question asked, by sha256 over every file, before and after.
 *
 * IT RUNS THE PAYLOAD IN PLACE. tools/smoke-packaged.mjs deliberately COPIES
 * resources/capability to a temporary directory before starting it, with a
 * comment naming this very defect as the reason ("a smoke run that left those
 * files in release/win-unpacked would make a later check-payload-boundary fail
 * over junk this gate created"). That copy is what kept the defect invisible to
 * the gate that ran nearest it. This one does the opposite on purpose: it
 * starts the shipped payload from exactly where a customer's copy sits.
 *
 * THREE PHASES, because the product is reachable three ways:
 *   A  The MCP entrypoint, started straight out of the install directory by
 *      something that is not our shell. The sterile profile states the one
 *      root the payload honours (TOOLSENABLED_STATE_ROOT, inside the scratch
 *      profile's roaming application data) -- see sterileEnvironment() for why
 *      saying nothing is answered with the builder's real per-user root -- and
 *      the payload still has to recognise itself as installed from the
 *      PAYLOAD.json marker at its own root and keep every write under that root.
 *   B  The GUI, which is how a customer starts it. The Electron shell states
 *      the state root explicitly, and a relocated profile (--user-data-dir)
 *      proves the layer follows the profile rather than a fixed folder.
 *   C  Phase A again, in the SAME profile. Moving the state out of the install
 *      directory is only half the fix; it has to still be there next time. This
 *      phase reads the audit row phase A wrote, through the product's own tool.
 *   D  THE UPGRADE. A customer who already ran a defective build has real data
 *      in the old place -- a vault they filled in, a signed ledger -- and the
 *      next update DELETES that directory. Fixing where new state goes while
 *      silently abandoning the old is not a fix, it is the same data loss with
 *      better paperwork. This phase plants legacy state in a payload copy,
 *      starts it, and requires the data to arrive in the new home.
 *
 *      WHAT PHASE D DOES NOT PROVE, SAID HERE BECAUSE THE PHASE IS NAMED AFTER
 *      IT. It proves the rescue WORKS when the old directory is still there. On
 *      a real NSIS upgrade it is not: node_modules/app-builder-lib/templates/
 *      nsis/include/installUtil.nsh:224 has the new installer run the OLD
 *      uninstaller first, and templates/nsis/uninstaller.nsh:187 is
 *      `RMDir /r $INSTDIR`. The install directory is therefore gone before the
 *      new build's first line executes, so adoptLegacyPayloadState() finds
 *      nothing to adopt and answers 'nothing-to-adopt'. Rescuing that data has
 *      to happen from the INSTALLER (a customInit hook in build/installer.nsh,
 *      which runs before UNINSTALL_PREVIOUS), not from the application. The one
 *      thing the same templates DO guarantee is that userData survives: the
 *      uninstaller is invoked with /KEEP_APP_DATA --updated, and this build
 *      does not set deleteAppDataOnUninstall.
 *   E  THE HALF OF THE PRODUCT THAT IS NOT JAVASCRIPT. A-D all exercise Node,
 *      and Node was already right. The PowerShell helpers are separate programs
 *      that resolve their own directories from $PSScriptRoot, and three of them
 *      were still doing it while every phase above was green. This phase makes
 *      one of them run.
 *   F  THE TOOLS THAT WRITE. Every phase above calls system.status, audit.tail
 *      and browser.status, and all three are 'local-read'. That is not a
 *      preference, it is what the payload permitted: src/mcp-server.js
 *      resolvePermissionSession() finds no machine record in a scratch profile
 *      and resolves the FAIL-CLOSED level, whose Confined 'read-only' profile
 *      refuses every write-effect tool (src/lib/permission-tier-policy.js,
 *      PERMISSION_CONFINED_EFFECT_REFUSED). So the half of the tool surface that
 *      CREATES DIRECTORIES AND FILES had never run under this gate at all, and a
 *      write-effect tool resolving its output against the program directory was
 *      invisible to every phase -- the hash can only see what the session
 *      executed. This phase records a real installation level first, then calls
 *      write-effect tools, so the hash finally has something to look at.
 *
 * Usage: node tools/check-install-dir-immutable.mjs [unpacked-app-directory]
 * Requires the existing artifact seal recorded after packaging and before any
 * runtime check. It never records or replaces that baseline itself.
 */

import { execFile as execFileCallback, spawn as nodeSpawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DEV_TEMP, plainPath } from './lib/adapters/artifact-files.mjs'
import { captureInstallBaseline, compareInstallBaseline, hashInstallTree as hashTree, treeDifferences } from './lib/install-immutability-baseline.mjs'

const execFile = promisify(execFileCallback)
const require_ = createRequire(import.meta.url)
const {
  canonicalizeCreatedQaProfile,
  createOutsideWriteFence,
  prepareSterileProfile,
  sterileLaunchEnvironment,
  sterileProfileDirectories,
} = require_(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'sterile-launch.cjs'))
const { trustedProfileShortAliasRoot } = require_(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell', 'install-profile-guard.cjs'),
)

const APP_EXE = 'ToolsEnabled.exe'
const CAPABILITY_DIRECTORY = path.join('resources', 'capability')
const PAYLOAD_RECORD = 'PAYLOAD.json'
const MCP_ENTRYPOINT_BASENAME = 'mcp-server.js'
const ROUND_TRIP_TOOL = 'system.status'
const AUDIT_TAIL_TOOL = 'audit.tail'
/* THE CHEAPEST TOOL THAT MAKES A HELPER PROGRAM RESOLVE A RUNTIME DIRECTORY AND
 * THEN SAY WHERE IT LANDED. Every other phase exercises JavaScript only, which
 * is how three PowerShell helpers stayed defective under a green hash.
 *
 * screen.capture was the obvious choice and was the wrong one HERE: its effect
 * is 'local-write', and a payload started with no setup record runs at the
 * read-only tier, which refuses every write-effect tool. It failed identically
 * on a fixed and a defective payload -- a gate that is red either way. This one
 * is 'local-read', so the tier permits it; it needs no interactive desktop and
 * no browser installed; and it RETURNS the resolved profile directory, so the
 * assertion is on the helper's own answer rather than on a side effect.
 *
 * That measurement was about the TIER, not about the tool, and the fix was to
 * change the tier rather than to give up on write-effect tools: phase F records
 * an installation level before it launches, and does call screen.capture. This
 * phase keeps its read-only probe unchanged, because a phase that proves the
 * derive/publish/read chain WITHOUT needing a recorded level is worth having on
 * its own -- it is the one that still runs if the record path itself breaks. */
const HELPER_PROBE_TOOL = 'browser.status'
const STATE_ROOT_LEAF = path.join('ToolsEnabled', 'capability')
/* The installation's service directory, sibling of the state root and derived
   by the payload from the same product identity: resolveServicesRoot() in
   src/lib/durable-memory-file.js joins the (account-fenced) LOCALAPPDATA onto
   basename(dirname(TOOLSENABLED_STATE_ROOT)), which under STATE_ROOT_LEAF is
   'ToolsEnabled'. Phase F writes this run's machine record there. */
const SERVICES_ROOT_LEAF = 'ToolsEnabled'
const MACHINE_RECORD_MODULE = path.join('src', 'lib', 'setup', 'machine-record.js')
/* WHY THE WIDEST LEVEL AND NOT THE MIDDLE ONE. This phase is not asking which
   tools a level carries -- permission-tier-policy.js has its own tests for that
   -- it is asking where the tools that run WRITE. Unrestricted is what the
   owner's own install records, it resolves to the Full tier, and it is the
   level under which the largest number of write paths execute. A leak into the
   program directory is the same defect at any level, so testing the widest one
   maximises what a single session reaches. */
const RECORDED_LEVEL = 'unrestricted'
const MEMORY_WRITE_TOOL = 'memory.set'
const MEMORY_READ_TOOL = 'memory.get'
const CAPTURE_TOOL = 'screen.capture'
const PROBE_NAMESPACE = 'install-dir-write-probe'
const PROBE_KEY = 'phase-f'
const REQUEST_TIMEOUT_MS = 120_000
const GUI_TIMEOUT_MS = 90_000

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/* ------------------------------------------------- phase 0: what did not run
 *
 * THE HASH IS THE REAL ASSERTION, AND IT HAS ONE BLIND SPOT: it can only see
 * what the session executed. A tool nobody called in these four phases -- a
 * screen capture writing to captures/, a browser profile under profiles/, an
 * agent lane writing a console log -- could still be resolving its path against
 * the program directory, and the run would come back clean.
 *
 * So this phase reads the shipped payload's source for the one shape that
 * causes it: a mutable top-level directory joined onto a root that is not the
 * state root. It is explicitly the WEAKER of the two checks -- source text
 * cannot see reachability, and dead code greps identically to live code -- and
 * it exists only to cover what a single session does not reach. Neither check
 * substitutes for the other, which is why both run.
 *
 * MEASURED WORTH: this found eight leaks the four behavioural phases missed --
 * extension packaging into logs/, the agent launch/mailbox/presence records,
 * the multi-account state file, the lane console logs, the state database read
 * path, and the owner request ledger in two tools. Every one of them would have
 * shipped behind a green hash.
 *
 * WHAT IT STILL CANNOT SEE, said plainly rather than left for someone to
 * discover: a root computed inside a function and passed along as a parameter.
 * src/lib/providers/model.js has exactly that shape. Rules that chase it start
 * flagging genuinely caller-supplied roots -- the supervised project's
 * directory, another worktree's -- which are not this defect and whose false
 * positives would get the whole check disabled. The hash is what covers that
 * case, for anything a session executes. */
const RUNTIME_STATE_DIRECTORIES = ['state', 'logs', 'vault', 'captures', 'profiles', 'reports']

/* WHAT THE SWEEP LOOKS FOR IS "DERIVED FROM WHERE THE CODE LIVES", NOT "any
 * identifier". The first version of this flagged every `path.join(x, 'state')`
 * and reported two false positives that taught the real rule:
 * fleet-supervisor's defaultStateFile(repoRoot) is handed the SUPERVISED
 * PROJECT's root, and model.js's commonWorktreeRoot() is deliberately another
 * worktree's directory. Neither is this defect: a caller-supplied root is the
 * caller's question. The defect is a path resolved from the MODULE'S OWN
 * LOCATION, because that is the one thing that becomes the install directory
 * when the code is packaged.
 *
 * So each file is read for the identifiers it assigns from a __dirname
 * expression -- whatever they are named, since ROOT, REPO_ROOT, MODULE_ROOT and
 * DEFAULT_ROOT all appear in this codebase and the next one will be named
 * something else -- and only joins onto those (or onto __dirname directly) are
 * reported. */
const MODULE_ROOT_ASSIGNMENT = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*path\.(?:resolve|join)\(\s*__dirname/g
/* A module root can also arrive by import: src/lib/providers/extension.js does
   `const { ROOT, ... } = require('../runtime')` and then joins 'logs' onto it.
   That is the same defect wearing a different hat, and the first version of this
   sweep could not see it -- measured, against the pre-fix payload, where it
   found 18 of the 19 sites and missed exactly that one. */
const IMPORTED_ROOT_NAMES = /^(?:ROOT|REPO_ROOT|MODULE_ROOT|PROGRAM_ROOT|DEFAULT_ROOT|REPOSITORY_ROOT)$/
const DESTRUCTURED_REQUIRE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g
const DIRNAME_STATE_JOIN = new RegExp(
  String.raw`path\.(?:join|resolve)\(\s*__dirname\s*(?:,\s*'\.\.'\s*)*,\s*'(?:${RUNTIME_STATE_DIRECTORIES.join('|')})'`,
  'g',
)

/* The resolver itself compares a candidate against the unredirected path, so it
   necessarily contains the shape it forbids. It is the one place allowed to. */
const STATE_ROOT_RESOLVER = new Set(['src/lib/runtime-state-root.js', 'src/lib/runtime.js'])

function moduleRootIdentifiers(text) {
  const names = new Set()
  for (const match of text.matchAll(MODULE_ROOT_ASSIGNMENT)) names.add(match[1])
  for (const match of text.matchAll(DESTRUCTURED_REQUIRE)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':').pop().trim()
      if (IMPORTED_ROOT_NAMES.test(name)) names.add(name)
    }
  }
  return names
}

async function sweepPayloadSource(capabilityRoot) {
  const findings = []
  async function walk(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const relative = path.relative(capabilityRoot, full).split(path.sep).join('/')
      if (STATE_ROOT_RESOLVER.has(relative)) continue
      let text
      try { text = await readFile(full, 'utf8') } catch { continue }

      const report = (index, matched) => {
        findings.push(`${relative}:${text.slice(0, index).split('\n').length}  ${matched.replace(/\s+/g, ' ')}`)
      }
      for (const match of text.matchAll(DIRNAME_STATE_JOIN)) report(match.index, match[0])
      const roots = moduleRootIdentifiers(text)
      if (roots.size === 0) continue
      const joinOntoModuleRoot = new RegExp(
        String.raw`path\.(?:join|resolve)\(\s*(?:${[...roots].join('|')})\s*,\s*'(?:${RUNTIME_STATE_DIRECTORIES.join('|')})'`,
        'g',
      )
      for (const match of text.matchAll(joinOntoModuleRoot)) report(match.index, match[0])
    }
  }
  await walk(capabilityRoot)
  return findings.sort()
}

/* THE SAME QUESTION, ASKED OF THE PROGRAMS THAT ARE NOT JAVASCRIPT.
 *
 * The sweep above reads `.js` and nothing else. The comment at the top of this
 * file names "a PowerShell helper resolving its own location" as a shape only
 * the hash could catch -- and it was right that the hash was the only thing
 * looking, because the static check was not. The behavioural phases only see a
 * helper the session actually spawns, and none of them spawn one.
 *
 * MEASURED, on this payload, with every phase above green: three shipped
 * helpers resolved a runtime directory from $PSScriptRoot --
 * tools/desktop.ps1 (captures/), tools/browser.ps1 (profiles/) and
 * tools/owner-prompt-queue.ps1 (state/). The first was reproduced end to end:
 * it created captures/ inside the program directory and THEN rejected the
 * per-user path Node had passed it, so a screen capture both wrote where it
 * must not and failed.
 *
 * WHY THE RULE IS "CONSULTS THE VARIABLE" AND NOT "NEVER JOINS ONTO ITSELF".
 * tools/secrets.ps1 does both -- it reads TOOLSENABLED_STATE_ROOT and keeps a
 * <repo> fallback, because a source checkout still has to work. The fallback is
 * correct and unavoidable, so its presence proves nothing in either direction.
 * What separates secrets.ps1 from the three above is that it ASKS. So that is
 * what is checked, and src/lib/runtime.js publishes the answer into the
 * environment of every helper spawn precisely so that asking is possible.
 *
 * This is the WEAKER of the two checks and does not replace the hash: it proves
 * the variable is consulted, not that it is consulted correctly. Correctness is
 * the hash's job, which is why phase E now spawns a real capture. */
const HELPER_PROGRAM_EXTENSIONS = new Set(['.ps1', '.cmd', '.bat', '.py'])
const STATE_ROOT_ENV = 'TOOLSENABLED_STATE_ROOT'
/* Where a helper program can learn its own location, per language. */
const SCRIPT_LOCATION_ANCHOR = /\$PSScriptRoot|\$MyInvocation|%~dp0|__file__/i
/* A quoted runtime-state directory, alone or as the head of a longer path --
   browser.ps1 spells it 'profiles\chrome'. */
const QUOTED_STATE_DIRECTORY = new RegExp(
  String.raw`(['"])(?:${RUNTIME_STATE_DIRECTORIES.join('|')})(?:[\\/][^'"]*)?\1`,
  'gi',
)

async function sweepHelperPrograms(capabilityRoot) {
  const findings = []
  async function walk(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      if (!HELPER_PROGRAM_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      let text
      try { text = await readFile(full, 'utf8') } catch { continue }
      /* A helper that never asks where it is cannot resolve anything against
         the install directory, whatever else it names. */
      if (!SCRIPT_LOCATION_ANCHOR.test(text)) continue
      if (text.includes(STATE_ROOT_ENV)) continue
      const relative = path.relative(capabilityRoot, full).split(path.sep).join('/')
      for (const match of text.matchAll(QUOTED_STATE_DIRECTORY)) {
        findings.push(`${relative}:${text.slice(0, match.index).split('\n').length}  ${match[0]}`)
      }
    }
  }
  await walk(capabilityRoot)
  return findings.sort()
}

/* ------------------------------------------------------------ MCP client */

function jsonRpcClient(child, timeoutMs) {
  const pending = new Map()
  let nextId = 1
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const settle = pending.get(message.id)
      if (settle) { pending.delete(message.id); settle(message) }
    }
  })
  return {
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    request(method, params) {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`the capability layer did not answer ${method} within ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
  }
}

function firstTextContent(result) {
  const block = result?.content?.find((entry) => entry?.type === 'text')
  return typeof block?.text === 'string' ? block.text : null
}

/* A profile that has never seen this project: no checkout to fall back on and
   no existing state anywhere. TOOLSENABLED_STATE_ROOT IS STATED, pointing into
   this profile's own roaming application data, because since engine 81b14e15 a
   packaged payload given no root anchors its state to the Windows account that
   owns the installation -- resolved from the process token, never from APPDATA
   or USERPROFILE -- and the engine's runtime-state-root unit test pins that
   derivation. A QA launch that says nothing is therefore answered with the
   builder's REAL per-user root (measured on the 1.0.40 r10 cut: phases A, D
   and E all wrote there and failed against the scratch roots they assert on),
   and the only root the payload honours instead is one stated explicitly
   inside the owner profile, which every scratch profile here is. So each phase
   states the root it asserts on; the hash over the install directory remains
   the proof that nothing was written beside the program. */
function sterileEnvironment(profile) {
  const base = process.env
  return {
    SystemRoot: base.SystemRoot,
    windir: base.windir,
    ComSpec: base.ComSpec,
    PATHEXT: base.PATHEXT,
    NUMBER_OF_PROCESSORS: base.NUMBER_OF_PROCESSORS,
    PROCESSOR_ARCHITECTURE: base.PROCESSOR_ARCHITECTURE,
    Path: [
      path.join(base.SystemRoot || 'C:\\Windows', 'System32'),
      base.SystemRoot || 'C:\\Windows',
      path.join(base.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';'),
    LOCALAPPDATA: profile.localAppData,
    APPDATA: profile.appData,
    USERPROFILE: profile.userProfile,
    CODEX_HOME: profile.codexHome,
    TEMP: profile.temp,
    TMP: profile.temp,
    TOOLSENABLED_STATE_ROOT: path.join(profile.appData, STATE_ROOT_LEAF),
    /* T385 second finding: a helper's `Import-Module` makes PowerShell write a
       ModuleAnalysisCache, and on a COLD cache it landed under
       resources/capability/Microsoft/Windows/PowerShell — so this immutability
       check indicted a byte its OWN phase produced (step 24 RED once, clean on a
       warm re-run). Pinning the cache file to the scratch temp keeps PowerShell's
       own bookkeeping out of the payload, so a cold cache no longer self-indicts
       while a genuine foreign write into the install directory still fails. */
    PSModuleAnalysisCachePath: path.join(profile.temp, 'ps-module-analysis-cache.dat'),
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/* THE INSTALLATION LEVEL, WRITTEN THE ONLY WAY THE PRODUCT WRITES ONE.
 *
 * A machine record is not a JSON file this harness may fabricate. Since the
 * 2026-08-11 measurement recorded in src/lib/setup/machine-record.js -- where
 * rewriting the single token `"tier": "guided"` to `"tier": "unrestricted"`
 * took the resolved surface from 102 tools to 262 -- every record carries an
 * HMAC over its whole body, keyed by a file the installation owns, and
 * readMachineRecord() answers an unsealed or mismatched one with
 * SETUP_MACHINE_RECORD_TAMPERED. A hand-built record would therefore not widen
 * this phase's tier; it would make the payload refuse to start honestly, and
 * the phase would fail for a reason that has nothing to do with install
 * directories.
 *
 * So the record is built and sealed by THE PAYLOAD'S OWN MODULE, loaded out of
 * the build under test. Two things follow, both wanted: the harness cannot
 * drift from the record format the shipped code reads, and if the seal
 * mechanism itself breaks, this phase notices.
 *
 * writeMachineRecord() is deliberately NOT the entry point used. It runs
 * generateMcpConfig() first as setup's no-write preflight, which reaches the
 * server catalogue and the tool registry -- setup's concerns, not this gate's,
 * and a failure there would be reported here as an install-directory finding.
 * writeJsonAtomic(sealMachineRecord(...)) is the same two writes that call
 * makes, with the same seal, and nothing else.
 *
 * THE SERVICES ROOT IS PASSED EXPLICITLY at every step, so nothing consults
 * this harness's own environment: the record, its key, and the payload's later
 * read all land in the scratch profile the caller names. */
function recordInstallationLevel(capabilityRoot, profile, { installRoot, nodePath }) {
  const machineRecord = require_(path.join(capabilityRoot, MACHINE_RECORD_MODULE))
  const servicesRoot = path.join(profile.localAppData, SERVICES_ROOT_LEAF)
  const record = machineRecord.buildMachineRecord({
    tier: RECORDED_LEVEL,
    installRoot,
    servicesRoot,
    nodePath,
    /* The scratch profile is the only folder this run is entitled to, and a
       record must name at least one. Nothing in this phase depends on its
       contents; the Full tier does not narrow arguments by workspace. */
    workspaceRoots: [profile.userProfile],
  })
  machineRecord.writeJsonAtomic(
    machineRecord.machineRecordPath(servicesRoot),
    machineRecord.sealMachineRecord(record, { servicesRoot }),
  )
  return servicesRoot
}

async function terminateTree(child) {
  if (!child?.pid) return
  try {
    await execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)])
}

/* --------------------------------------------------------------- phase A/C */

async function runPayloadInPlace(executable, capabilityRoot, profile, { label, probeHelper = false, probeWrites = false }) {
  let record
  try { record = JSON.parse(await readFile(path.join(capabilityRoot, PAYLOAD_RECORD), 'utf8')) } catch (error) {
    throw new Error(`${label}: ${PAYLOAD_RECORD} is unreadable at ${capabilityRoot} (${error.message}).`)
  }
  const entrypoint = (Array.isArray(record?.entrypoints) ? record.entrypoints : [])
    .find((entry) => path.basename(entry) === MCP_ENTRYPOINT_BASENAME)
  if (!entrypoint) throw new Error(`${label}: the payload declares no ${MCP_ENTRYPOINT_BASENAME} entrypoint.`)

  let stderr = ''
  const child = nodeSpawn(executable, [path.join(capabilityRoot, entrypoint)], {
    cwd: profile.temp,
    env: sterileEnvironment(profile),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })

  try {
    const client = jsonRpcClient(child, REQUEST_TIMEOUT_MS)
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'check-install-dir-immutable', version: '1' },
    })
    if (!initialized.result) {
      throw new Error(`${label}: the payload refused the MCP handshake: ${JSON.stringify(initialized.error)}\n${stderr.trim()}`)
    }
    client.notify('notifications/initialized')

    const called = await client.request('tools/call', { name: ROUND_TRIP_TOOL, arguments: {} })
    if (!called.result || called.result.isError) {
      throw new Error(
        `${label}: ${ROUND_TRIP_TOOL} did not complete: ` +
        `${firstTextContent(called.result) || JSON.stringify(called.error)}\n${stderr.trim()}`,
      )
    }

    const tailed = await client.request('tools/call', { name: AUDIT_TAIL_TOOL, arguments: { limit: 50 } })
    if (!tailed.result || tailed.result.isError) {
      throw new Error(
        `${label}: the audit ledger could not be read: ` +
        `${firstTextContent(tailed.result) || JSON.stringify(tailed.error)}\n${stderr.trim()}`,
      )
    }
    let rows
    try {
      const parsed = JSON.parse(firstTextContent(tailed.result) ?? 'null')
      rows = Array.isArray(parsed) ? parsed : parsed?.entries
    } catch (error) {
      throw new Error(`${label}: the audit ledger returned unparseable content (${error.message}).`)
    }
    if (!Array.isArray(rows)) throw new Error(`${label}: the audit ledger returned no entry list.`)

    /* Requested only by phase E; see there for what it proves. */
    let probed = null
    if (probeHelper) {
      const asked = await client.request('tools/call', { name: HELPER_PROBE_TOOL, arguments: {} })
      if (!asked.result) throw new Error(`${label}: ${HELPER_PROBE_TOOL} returned no result: ${JSON.stringify(asked.error)}`)
      probed = { isError: Boolean(asked.result.isError), text: firstTextContent(asked.result) }
    }

    /* Requested only by phase F; see there for what it proves. The outcome of
       each call is carried back rather than judged here -- this function knows
       how to talk to the payload and nothing about install directories. */
    let writes = null
    if (probeWrites) {
      const marker = `install-dir-write-probe ${Date.now()}`
      writes = { marker }
      for (const [name, tool, args] of [
        ['stored', MEMORY_WRITE_TOOL, { namespace: PROBE_NAMESPACE, key: PROBE_KEY, value: marker }],
        ['read', MEMORY_READ_TOOL, { namespace: PROBE_NAMESPACE, key: PROBE_KEY }],
        ['captured', CAPTURE_TOOL, {}],
      ]) {
        const asked = await client.request('tools/call', { name: tool, arguments: args })
        if (!asked.result) throw new Error(`${label}: ${tool} returned no result: ${JSON.stringify(asked.error)}`)
        writes[name] = { tool, isError: Boolean(asked.result.isError), text: firstTextContent(asked.result) }
      }
    }
    return { rows, stderr, probed, writes }
  } finally {
    await terminateTree(child)
  }
}

/* ----------------------------------------------------------------- phase B */

async function runGuiSession(executable, userDataDirectory, stateRoot, profile) {
  /* THE ONE SHARED LAUNCH ENVIRONMENT, not a hand-rolled one. Two things ride
     on it. ELECTRON_RUN_AS_NODE is deleted: under an agent harness it is
     exported as 1, and an Electron binary that inherits it starts as plain
     Node, reads stdin, hits EOF and exits 0 with no window -- a silent
     non-start that reads exactly like a product crash. And every HOME is
     pointed into this run's scratch profile: measured 2026-08-22 at 16:40:55,
     this very phase -- a fresh --user-data-dir but the builder's LOCALAPPDATA
     -- read the builder's machine record and rewrote the builder's workspace
     `.mcp.json` to point at the build under test, the run after the packaged
     smoke had been isolated. The cut wrapper's PATH can also retain a path
     inside another Windows profile, which the product account fence correctly
     refuses. This GUI proof therefore receives only Windows system search
     locations. tools/test/electron-run-as-node-harness-guard.test.mjs fails any
     harness in this repo that spawns the app any other way. */
  const child = nodeSpawn(executable, [`--user-data-dir=${userDataDirectory}`], {
    env: {
      ...sterileLaunchEnvironment(profile, process.env, { systemPathOnly: true }),
      MC_SMOKE_HEADLESS: '1',
      /* T385: keep PowerShell's ModuleAnalysisCache (written when a helper the
         GUI spawns imports a module) out of the payload; see sterileEnvironment. */
      PSModuleAnalysisCachePath: path.join(profile.temp, 'ps-module-analysis-cache.dat'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  let stdout = ''
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })

  /* Wait for the capability layer to have STARTED, observed the only way that
     is not a guess: the bridge writes its runtime discovery record as soon as
     it is listening. Under the defect this file appeared in the install
     directory; the point of waiting for it HERE is that its arrival at the new
     address is the same event. */
  const runtimeRecord = path.join(stateRoot, 'state', 'mission-bridge-runtime.json')
  const deadline = Date.now() + GUI_TIMEOUT_MS
  let seen = false
  while (Date.now() < deadline) {
    if (existsSync(runtimeRecord)) { seen = true; break }
    if (child.exitCode !== null) break
    await delay(250)
  }
  /* Give the layer a moment past "listening" to do the writes that follow it,
     so the hash comparison covers more than the first millisecond of the boot. */
  if (seen) await delay(3_000)
  await terminateTree(child)
  return { seen, runtimeRecord, stdout, stderr }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const unpacked = plainPath(path.resolve(process.argv[2] || path.join('release', 'win-unpacked')), { missingLeaf: true })
  const executable = path.join(unpacked, APP_EXE)
  const capabilityRoot = path.join(unpacked, CAPABILITY_DIRECTORY)
  for (const required of [executable, path.join(capabilityRoot, PAYLOAD_RECORD)]) {
    if (!existsSync(required)) throw new Error(`Not an unpacked ToolsEnabled build: ${required} is missing.`)
  }

  // Packaging records the seal before smoke or this checker runs. Refuse an
  // already contaminated or unsealed artifact before profiles or runtime work;
  // taking a fresh starting hash would silently adopt earlier contamination.
  const baseline = await captureInstallBaseline(unpacked)
  console.log(`install directory: ${unpacked}`)
  console.log(`verified the existing artifact seal and captured ${baseline.entries.size} file/directory entries before the session`)

  /* NOTHING OUTSIDE THE SCRATCH TREE MAY CHANGE. Armed before the first launch
     and checked in the finally below: the builder's machine record and every
     workspace `.mcp.json` it names are snapshotted, and a difference fails the
     check however clean the install directory came back. This is the fence
     that would have caught the 16:40:55 rewrite this file's phase B produced. */
  const fence = createOutsideWriteFence({ appDirectory: unpacked, label: 'the install-directory check' })
  await fence.arm()

  const scratchParent = process.platform === 'win32' ? plainPath(DEV_TEMP, { kind: 'directory' }) : tmpdir()
  const scratchEntry = await mkdtemp(path.join(scratchParent, 'toolsenabled-installdir-'))
  const accountHome = homedir()
  const scratch = canonicalizeCreatedQaProfile(scratchEntry, {
    accountHome,
    trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome),
  })
  const profile = prepareSterileProfile(sterileProfileDirectories(scratch))
  const guiUserData = path.join(scratch, 'gui-userdata')
  /* Phase B's homes, separate from phase A's so the GUI's own first-run state
     cannot be mistaken for something the payload wrote in place. */
  const guiProfile = prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'gui')))
  await mkdir(guiUserData, { recursive: true })

  const payloadStateRoot = path.join(profile.appData, STATE_ROOT_LEAF)
  const guiStateRoot = path.join(guiUserData, 'capability')

  const failures = []
  try {
    // ---- phase 0: the writers this session will not execute.
    const sweep = await sweepPayloadSource(capabilityRoot)
    if (sweep.length) {
      failures.push(
        `phase 0: ${sweep.length} place(s) in the shipped payload still join a runtime-state directory onto a ` +
        'root that is not the state root. The behavioural phases below cannot see these unless the session ' +
        'happens to execute them, which is exactly how they get shipped. Route each through statePath() or ' +
        `programOrStatePath() in src/lib/runtime-state-root.js:\n  ${sweep.join('\n  ')}`,
      )
    } else {
      console.log('phase 0: no payload source joins a runtime-state directory onto the program root')
    }

    const helperSweep = await sweepHelperPrograms(capabilityRoot)
    if (helperSweep.length) {
      failures.push(
        `phase 0: ${helperSweep.length} place(s) in a shipped HELPER PROGRAM name a runtime-state directory, in a ` +
        `file that resolves its own location and never reads ${STATE_ROOT_ENV}. A helper that derives a writable ` +
        'directory from $PSScriptRoot writes into the INSTALL directory, and disagrees with the per-user path the ' +
        'JavaScript half passes it -- which is a capture that both writes where it must not and then fails. Follow ' +
        `tools/secrets.ps1: read ${STATE_ROOT_ENV} first, keep the <repo> fallback for a source checkout:\n  ` +
        helperSweep.join('\n  '),
      )
    } else {
      console.log('phase 0: every shipped helper program that resolves its own location consults the state root')
    }

    // ---- phase A: the payload, in place, told only its state root.
    const first = await runPayloadInPlace(executable, capabilityRoot, profile, { label: 'phase A (payload in place)' })
    const landed = first.rows.find((row) => row?.target === ROUND_TRIP_TOOL && String(row?.action || '').startsWith('mcp.tool.'))
    if (!landed) failures.push(`phase A: ${ROUND_TRIP_TOOL} succeeded but landed no audit row, so this phase proved nothing about where state goes.`)
    console.log(`phase A: ${ROUND_TRIP_TOOL} round-tripped and the ledger holds ${first.rows.length} row(s)`)

    if (!existsSync(path.join(payloadStateRoot, 'state', 'audit.sqlite3'))) {
      failures.push(
        `phase A: no audit ledger at ${path.join(payloadStateRoot, 'state', 'audit.sqlite3')}. ` +
        'The payload either wrote it somewhere else or did not write it at all; either way the per-user state root is not being used.',
      )
    } else {
      console.log(`phase A: state landed under ${payloadStateRoot}`)
    }

    // ---- phase B: the GUI, with a relocated profile.
    const gui = await runGuiSession(executable, guiUserData, guiStateRoot, guiProfile)
    if (!gui.seen) {
      failures.push(
        `phase B: the capability layer never wrote ${gui.runtimeRecord} within ${GUI_TIMEOUT_MS}ms. ` +
        `Either it did not start, or it wrote its runtime record somewhere else.\n${gui.stderr.trim().slice(-2000)}`,
      )
    } else {
      console.log(`phase B: the GUI's capability layer wrote its runtime record under ${guiStateRoot}`)
    }

    // ---- phase D: an upgrade from a build that had the defect.
    const legacyProfile = prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'legacy')))
    /* A payload copy stands in for the old install: it carries PAYLOAD.json, so
       the running code cannot tell it from one, and copying 5 MB rather than the
       whole 1 GB application keeps this phase affordable enough to actually run
       in the pipeline. */
    const legacyInstall = path.join(scratch, 'legacy-install', 'capability')
    await cp(capabilityRoot, legacyInstall, { recursive: true })
    /* MARKER FILES, NOT REAL ONES, AND THAT IS THE POINT. Planting a fake
       vault/secrets.json tests what the vault does with a corrupt file, not
       whether the directory was carried across -- the product opened it,
       could not read it, and wrote a real one over the top, so the assertion
       failed for a reason that had nothing to do with migration. A file the
       product never touches isolates the one question this phase asks: did
       each runtime directory move, byte for byte. */
    const planted = [
      { file: path.join(legacyInstall, 'vault', 'legacy-marker.json'), body: '{"legacy-vault-marker":"phase-d"}\n' },
      { file: path.join(legacyInstall, 'reports', 'legacy-marker.json'), body: '{"legacy-reports-marker":"phase-d"}\n' },
      { file: path.join(legacyInstall, 'state', 'legacy-marker.json'), body: '{"legacy-state-marker":"phase-d"}\n' },
      { file: path.join(legacyInstall, 'logs', 'legacy-marker.log'), body: 'legacy-logs-marker phase-d\n' },
    ]
    for (const entry of planted) {
      await mkdir(path.dirname(entry.file), { recursive: true })
      await writeFile(entry.file, entry.body, 'utf8')
    }
    const legacyBefore = await hashTree(legacyInstall)
    await runPayloadInPlace(executable, legacyInstall, legacyProfile, { label: 'phase D (upgrade)' })

    const adoptedRoot = path.join(legacyProfile.appData, STATE_ROOT_LEAF)
    const stranded = []
    for (const entry of planted) {
      const relative = path.relative(legacyInstall, entry.file)
      const carried = path.join(adoptedRoot, relative)
      if (!existsSync(carried)) { stranded.push(relative.split(path.sep).join('/')); continue }
      if (await readFile(carried, 'utf8') !== entry.body) stranded.push(`${relative.split(path.sep).join('/')} (contents differ)`)
    }
    if (stranded.length) {
      failures.push(
        `phase D: an upgrade stranded the previous install's data. Not carried into ${adoptedRoot}:\n  ${stranded.join('\n  ')}\n` +
        'The next update deletes the old directory, so this is the only chance to move it and these files would simply be gone.',
      )
    } else {
      console.log(`phase D: an existing install's vault, ledger and state were carried into ${adoptedRoot}`)
    }
    const legacyDifferences = treeDifferences(legacyBefore, await hashTree(legacyInstall))
    if (legacyDifferences.added.length || legacyDifferences.removed.length || legacyDifferences.changed.length) {
      failures.push(
        'phase D: adopting the previous install\'s data MODIFIED the old install directory. The migration must read ' +
        'and copy only -- deleting the legacy copy is itself a write to a program directory, and one of these files ' +
        `is audit history.\nADDED: ${legacyDifferences.added.join(', ') || 'none'}\n` +
        `CHANGED: ${legacyDifferences.changed.join(', ') || 'none'}\nREMOVED: ${legacyDifferences.removed.join(', ') || 'none'}`,
      )
    }

    // ---- phase C: the state is still there next time.
    const second = await runPayloadInPlace(executable, capabilityRoot, profile, { label: 'phase C (relaunch)' })
    const survived = second.rows.filter((row) => row?.target === ROUND_TRIP_TOOL && String(row?.action || '').startsWith('mcp.tool.'))
    if (survived.length < 2) {
      failures.push(
        `phase C: after a relaunch the ledger holds ${survived.length} ${ROUND_TRIP_TOOL} row(s), expected at least 2 ` +
        '(one from phase A, one from this phase). Moving state out of the install directory is only half the fix; ' +
        'a state root the product cannot find again next time is the same data loss by another route.',
      )
    } else {
      console.log(`phase C: ${survived.length} ${ROUND_TRIP_TOOL} row(s) in the ledger — phase A's row survived the relaunch`)
    }

    /* ---- phase E: a HELPER PROGRAM, in the case that tells it nothing.
     *
     * Phases A-D exercise JavaScript, and the JavaScript was already right. The
     * product's other half is a set of PowerShell helpers, which are separate
     * PROGRAMS: they resolve their own directories from $PSScriptRoot, which
     * packaged is the install directory, and no amount of JavaScript being
     * correct changes what they do. Measured on this payload with every phase
     * above green, tools/desktop.ps1 created captures/ inside the program
     * directory and then refused the per-user path Node had passed it -- so
     * screen capture wrote where it must not AND failed, invisibly to this gate.
     *
     * IT RUNS IN ITS OWN STERILE PROFILE, whose stated TOOLSENABLED_STATE_ROOT
     * is the root asserted below (see sterileEnvironment() for why the root is
     * stated rather than left for the payload to derive). What this phase proves
     * is the publish/read half of the chain: the payload resolves that root,
     * src/lib/runtime.js publishes it into the environment of every helper
     * spawn, and the helper reads it back and answers with a directory under
     * it. A helper resolving from $PSScriptRoot answers with the install
     * directory whatever the payload was told, which is the defect.
     *
     * AN UNAVAILABLE DESKTOP IS A PASS, AND IS NOT A HOLE. A locked, headless or
     * service session has no interactive desktop and the helper says so. What is
     * asserted here is that the two programs AGREE on a directory, and a
     * disagreement cannot present as "unavailable": the helper validates the
     * path before it touches the screen, so disagreement is an error. */
    /* ITS OWN PROFILE, FOR A REASON WORTH WRITING DOWN. Run in phase A's
       profile, this phase failed on "the audit ledger could not be opened" --
       phase C's process had only just been killed and still held the sqlite
       file, so a check about PowerShell was reporting a transient sqlite lock.
       A red gate that names the wrong thing is worse than no gate: it teaches
       people to re-run until it passes. A fresh profile has its own ledger and
       cannot contend with anything, and phase E loses nothing by it -- what it
       proves is the derive/publish/read chain, which is per-profile anyway. */
    const helperProfile = prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'helper')))
    const helperStateRoot = path.join(helperProfile.appData, STATE_ROOT_LEAF)
    const helperRun = await runPayloadInPlace(executable, capabilityRoot, helperProfile, { label: 'phase E (helper program)', probeHelper: true })
    const probed = helperRun.probed
    let reported = null
    if (!probed || probed.isError) {
      failures.push(
        `phase E: ${HELPER_PROBE_TOOL} did not complete, so nothing was learned about where a helper program ` +
        `resolves its directories.\n${probed ? probed.text : 'no result'}`,
      )
    } else {
      try { reported = JSON.parse(probed.text ?? 'null')?.profile ?? null } catch { /* reported just below */ }
      if (typeof reported !== 'string' || !reported) {
        failures.push(`phase E: ${HELPER_PROBE_TOOL} named no profile directory, so this phase proved nothing.`)
      } else if (!path.relative(unpacked, path.resolve(reported)).startsWith('..')) {
        /* THE DEFECT, STATED AS THE CUSTOMER MEETS IT. The helper resolved a
           directory it intends to use INSIDE the program's own installation. */
        failures.push(
          `phase E: a helper program resolved its profile directory to ${reported}, which is INSIDE the install ` +
          `directory ${unpacked}. It is deriving that path from its own location instead of reading ` +
          `${STATE_ROOT_ENV}, so it will write where the next update deletes and a per-machine install forbids. ` +
          'Follow the ladder in tools/secrets.ps1.',
        )
      } else if (path.relative(helperStateRoot, path.resolve(reported)).startsWith('..')) {
        failures.push(
          `phase E: a helper program resolved its profile directory to ${reported}, which is outside this run's ` +
          `per-user state root ${helperStateRoot}. The JavaScript half and the helper disagree about where the ` +
          'product keeps its data.',
        )
      } else {
        console.log(`phase E: a PowerShell helper independently resolved its directory under ${helperStateRoot}`)
      }
    }

    /* ---- phase F: the tools that WRITE.
     *
     * WHAT WAS MISSING, AND WHY IT WAS MISSING. Phases A-E call system.status,
     * audit.tail and browser.status. Every one of them is 'local-read'. That is
     * not an oversight in the choice of tools, it is the tier: a payload started
     * in a scratch profile finds no machine record, src/mcp-server.js
     * resolvePermissionSession() resolves the fail-closed level on purpose, and
     * its Confined 'read-only' profile refuses every write-effect tool with
     * PERMISSION_CONFINED_EFFECT_REFUSED. So the gate whose entire thesis is
     * "the program must not write into its own directory" had never executed a
     * single tool whose job is to write, and its own comment at HELPER_PROBE_TOOL
     * recorded the refusal as a reason to stop trying.
     *
     * The hash sees only what the session runs. A write-effect tool resolving
     * its output against the program root was therefore invisible here in
     * exactly the way phase 0's comment describes -- "a tool nobody called in
     * these four phases -- a screen capture writing to captures/ ... could still
     * be resolving its path against the program directory, and the run would
     * come back clean". Phase 0's source sweep was the stopgap. It is still the
     * weaker check, and this is the one that executes.
     *
     * SO THE LEVEL IS RECORDED FIRST, sealed by the payload's own module (see
     * recordInstallationLevel). Then three tools run:
     *   memory.set   'local-write', no desktop, no network, no credential. The
     *                cheapest tool that makes the product durably write.
     *   memory.get   proves the write LANDED and is readable, so a refusal that
     *                silently produced nothing cannot pass as a success.
     *   screen.capture  the tool that reproduced the original defect. Its Node
     *                half resolves captures/ and CREATES it before the helper
     *                runs, so a defective root leaves a directory inside the
     *                install -- which the hash now sees, because directories are
     *                hashed as entries.
     *
     * THE ASSERTIONS HERE ARE THE SMALL HALF. The real verdict on this phase is
     * the hash in the finally block below, which now covers write paths for the
     * first time. What is checked inline is only that the tools ACTUALLY RAN: a
     * phase whose every call was refused would leave the install directory
     * pristine and prove nothing, which is the failure mode that made the
     * read-only tier look acceptable in the first place. */
    const writeProfile = prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'writes')))
    const writeStateRoot = path.join(writeProfile.appData, STATE_ROOT_LEAF)
    const writeServicesRoot = recordInstallationLevel(capabilityRoot, writeProfile, {
      installRoot: unpacked,
      nodePath: executable,
    })
    const writeRun = await runPayloadInPlace(executable, capabilityRoot, writeProfile, {
      label: 'phase F (write-effect tools)',
      probeWrites: true,
    })
    const writes = writeRun.writes
    if (!writes) {
      failures.push('phase F: the payload returned no write-probe results, so no write-effect tool was exercised.')
    } else if (writes.stored.isError) {
      /* The one refusal that has to name its own likely cause, because it is
         indistinguishable at this level from the defect and from a broken
         harness. If the record did not take, everything below is vacuous. */
      failures.push(
        `phase F: ${MEMORY_WRITE_TOOL} was refused, so no write-effect tool ran and this phase proved nothing. ` +
        `Either the sealed '${RECORDED_LEVEL}' record written to ${writeServicesRoot} was not the one the payload ` +
        'read (check that resolveServicesRoot() still derives that directory from TOOLSENABLED_STATE_ROOT and ' +
        `LOCALAPPDATA), or the product genuinely refuses this tool.\n${writes.stored.text}`,
      )
    } else {
      let recovered = null
      try { recovered = JSON.parse(writes.read.text ?? 'null')?.value ?? null } catch { /* reported just below */ }
      if (writes.read.isError || recovered !== writes.marker) {
        failures.push(
          `phase F: ${MEMORY_WRITE_TOOL} reported success but ${MEMORY_READ_TOOL} did not return what it wrote, so ` +
          'the write did not durably land anywhere this product can find again.\n' +
          `${writes.read.text}`,
        )
      } else {
        console.log(`phase F: a write-effect tool wrote and read back durable state under ${writeServicesRoot}`)
      }

      /* screen.capture, judged the way phase E judges its helper: on the path
         the product itself reports, never by probing or following it. */
      let capture = null
      if (writes.captured.isError) {
        failures.push(
          `phase F: ${CAPTURE_TOOL} did not complete. It is a write-effect tool at the recorded level, so a refusal ` +
          `here means the largest write path in the product went unexercised.\n${writes.captured.text}`,
        )
      } else {
        try { capture = JSON.parse(writes.captured.text ?? 'null') } catch { /* reported just below */ }
        const written = typeof capture?.path === 'string' ? capture.path : null
        if (capture?.status === 'unavailable') {
          /* NOT A HOLE, for the reason phase E gives: the helper validates the
             destination against its own resolution BEFORE it touches the
             screen, so a disagreement presents as an error and never as this.
             A locked or headless grading box lands here, and the Node half has
             already created captures/ wherever it thinks captures/ goes -- which
             is the write the hash below is watching for. */
          console.log(`phase F: no interactive desktop, so ${CAPTURE_TOOL} reported 'unavailable' after resolving its output directory`)
        } else if (!written) {
          failures.push(`phase F: ${CAPTURE_TOOL} named no output path and did not report an unavailable desktop, so this probe proved nothing.`)
        } else if (!path.relative(unpacked, path.resolve(written)).startsWith('..')) {
          failures.push(
            `phase F: a write-effect tool wrote ${written}, which is INSIDE the install directory ${unpacked}. ` +
            'The next update deletes this directory and a per-machine install forbids writing to it, so this ' +
            'output is both lost and impossible on a normal deployment.',
          )
        } else if (path.relative(writeStateRoot, path.resolve(written)).startsWith('..')) {
          failures.push(
            `phase F: a write-effect tool wrote ${written}, which is outside this run's per-user state root ` +
            `${writeStateRoot}. It is neither in the install directory nor where the product keeps its data.`,
          )
        } else {
          console.log(`phase F: ${CAPTURE_TOOL} wrote under ${writeStateRoot}`)
        }
      }
    }
  } finally {
    /* The fence verdict goes FIRST: a reconfigured machine outranks a clean
       install directory, and it is the finding a reader must not scroll past. */
    try { await fence.check() } catch (fenceError) { failures.unshift(fenceError.message) }
    try {
      const { after, added, removed, changed } = await compareInstallBaseline(baseline)
      if (added.length || removed.length || changed.length) {
        const detail = [
          added.length ? `ADDED (${added.length}):\n  ${added.join('\n  ')}` : null,
          changed.length ? `CHANGED (${changed.length}):\n  ${changed.join('\n  ')}` : null,
          removed.length ? `REMOVED (${removed.length}):\n  ${removed.join('\n  ')}` : null,
        ].filter(Boolean).join('\n')
        failures.unshift(
          'THE INSTALL DIRECTORY CHANGED DURING A SESSION. A customer\'s next update deletes this directory, ' +
          'and a per-machine install makes it unwritable, so anything the product puts here is both lost and ' +
          `unable to be written in the first place on a normal deployment.\n${detail}`,
        )
      } else {
        console.log(`the install directory still matches the sealed files and pre-session directories (${after.size} entr(y|ies) re-hashed)`)
      }
    } catch (error) {
      failures.unshift(`The sealed install-directory baseline could not be verified after the session: ${error.message}`)
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {})

    if (failures.length) {
      console.error(`\ninstall-directory state check FAILED (${failures.length}):\n`)
      for (const failure of failures) console.error(`- ${failure}\n`)
      process.exitCode = 1
      return
    }
    console.log('\ninstall-directory state check: clean.')
  }
}

main().catch((error) => {
  console.error(`install-directory state check could not run: ${error.message}`)
  process.exitCode = 1
})
