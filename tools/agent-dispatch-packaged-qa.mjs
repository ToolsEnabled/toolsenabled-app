#!/usr/bin/env node

// CAN THE THING WE SHIP START AN AGENT? ASKED BY POSTING A REAL DISPATCH.
//
// THE DEFECT THIS EXISTS TO CATCH, AND WHY NO SOURCE TEST COULD.
//
// The mission bridge resolves a dispatch by finding a DECLARED agent whose id
// and provider match the requested tier. It reads that declaration from
// `config/agent-org.json` inside the capability payload. The builder's own
// organisation declares twenty agents, so every dispatch on this machine
// resolved; the organisation the BUILD STAGES IN ITS PLACE
// (capability-defaults/config/agent-org.json) declared the controller and
// nothing else, so every dispatch on every packaged install refused with
// BRIDGE_AGENT_DECLARATION_MISSING. The product could not start an agent at all.
//
// Every unit suite in this repository passed throughout, and would have gone on
// passing: they run against the builder's tree, where the masking file lives.
// The defect is a property of the PAYLOAD -- of which config file ends up beside
// the engine -- and the only instrument that can see it is one that starts the
// payload and asks it to dispatch. That is this file.
//
// WHAT IT MEASURES, AND HOW THAT IS "PACKAGED".
//
// By default it stages a payload with the build's own staging step
// (tools/pack-capability-layer.mjs) into a temporary directory, which is
// byte-for-byte what `npm run dist` puts under `resources\capability`, including
// the substituted organisation. `--release <dir>` measures the payload inside an
// already-built application instead. Either way it then starts THAT payload's
// bridge -- the real `tools/mission-bridge.js`, the real per-boot bootstrap
// proof, the real bearer, the real HTTP route -- and POSTs to
// /v1/actions/dispatch exactly as src/mission-bridge.js does from the window.
//
// It does not open a window. A window would add twenty minutes and several
// failure modes to a question that is entirely about what the payload answers,
// and tools/agent-route-reachability.mjs already owns the can-a-person-get-there
// half.
//
// IT SPENDS NO PROVIDER BUDGET, AND THAT IS ENFORCED RATHER THAN INTENDED.
//
// A paid dispatch that resolves ends by spawning a real Codex or Claude process.
// So the bridge child is given an environment in which neither CLI nor inherited
// provider credential can be found: PATH is cut back to the Windows system
// directories, APPDATA and USERPROFILE point at empty temporary directories,
// and credential-shaped environment names are removed. The paid lanes therefore
// stop without spending provider budget.
//
// The local tier is intentionally different. It has no vendor CLI or API key,
// and may start the product's free local worker when a local runtime is already
// reachable. That is a valid positive result, not a failed fence. The harness
// records it, waits for the loopback completion to finish, and then reaps the
// bridge process tree; a PAID tier that nevertheless starts is reaped
// immediately and remains a harness failure.
//
// WHY A REFUSAL CODE IS NOT THE EVIDENCE.
//
// "It did not say BRIDGE_AGENT_DECLARATION_MISSING" is satisfied by a refusal
// from any EARLIER gate -- a policy guard, a malformed root, an unauthorised
// actor -- none of which proves the organisation declares anything. So the
// evidence is positive and comes from the audit chain the bridge writes for
// itself: a `controller.agent.launch` record naming the seat that was allocated.
// That record is written by createLaunch(), which runs after the lane has been
// resolved and after the phase-claim gate, so its existence is proof that both
// passed. The refusal code is checked as well, and only against the codes that
// mean "the lane was ready and the program was missing".
//
// ONE OBJECTIVE IS PHASE-SHAPED, AND THAT IS NOT DECORATION. `objectiveRef`
// values matching /^Q[0-9]{1,3}$/ are queue phase ids, and only those reach
// mayClaim() in the launch record -- the gate that decides whether this agent is
// allowed to take this work. Every obvious test value ("probe-lane", the fleet
// page's own "page2-<id>") is a plain label that skips that gate entirely, so a
// suite built from obvious values would leave the phase claim unmeasured on
// every install.
//
// THE INSTRUMENT PROVES ITSELF BEFORE IT REPORTS. A green run that could not
// have gone red is worth nothing, and this one is cheap to fool: any bridge that
// refuses everything for any reason satisfies "not this code". So the run ends
// by rebuilding the defect -- the same payload with a controller-only
// organisation -- and REQUIRING BRIDGE_AGENT_DECLARATION_MISSING back. If the
// defect cannot be reproduced, this file cannot claim to detect it, and the run
// fails.
//
// USAGE
//   node tools/agent-dispatch-packaged-qa.mjs                stage and measure
//   node tools/agent-dispatch-packaged-qa.mjs --release <dir> measure that build
//   node tools/agent-dispatch-packaged-qa.mjs --keep          keep the sandbox

import { execFile as execFileCallback, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  providerFreeCompletionCount,
  startProviderFreeLocalRuntime,
  waitForProviderFreeCompletion,
} from './lib/provider-free-local-runtime.mjs'
import { environmentFor as credentialSafeEnvironment } from './test-account-harness.mjs'

const execFile = promisify(execFileCallback)
const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '..')
const DEFAULTS_ORG = path.join(REPO, 'capability-defaults', 'config', 'agent-org.json')

const {
  readCapabilityProof,
  startCapabilityLayer,
  stopCapabilityLayer,
} = require_(path.join(REPO, 'shell', 'capability-layer.cjs'))

function argument(name, fallback = null) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const RELEASE = argument('--release')
const KEEP = process.argv.includes('--keep')

/* THE TIERS THE PRODUCT OFFERS, read off the engine's own table rather than
   listed here. A tier this file forgot is a tier nothing measures, and the
   table is the one place that knows which exist. */
/* The tier table, with each row's KIND, because the kinds do not behave alike and
   this file used to assume they did. A tier's kind decides how far a dispatch gets
   before the payload refuses it, and asserting one uniform depth for all of them
   made the local tier read as a defect when it was doing exactly what it should.
   See the two checks that reference `kind` below. */
function tierTable(payload) {
  const source = readFileSync(path.join(payload, 'src', 'lib', 'mission-bridge', 'actions.js'), 'utf8')
  const table = source.slice(source.indexOf('const TIERS'), source.indexOf('});', source.indexOf('const TIERS')))
  const rows = new Map()
  for (const match of table.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:\s*Object\.freeze\(\{([^}]*)\}/gm)) {
    const kind = /\bkind:\s*'([a-z]+)'/.exec(match[2])
    /* A row whose kind cannot be read is reported as such rather than defaulted:
       guessing 'codex' here would silently reinstate the assumption above. */
    rows.set(match[1], kind ? kind[1] : 'unreadable')
  }
  return rows
}

function tierNames(payload) {
  return [...tierTable(payload).keys()]
}

/* Dispatch refusals occur on two sides of createLaunch(). That boundary is the
   only honest way to predict the audit count: a provider preflight refusal has
   no launch record, while a command/spawn refusal after createLaunch() must have
   one. A successful local worker also passed createLaunch() and must be counted. */
const PRE_LAUNCH_REFUSALS_BY_KIND = Object.freeze({
  codex: Object.freeze([]),
  claude: Object.freeze([
    'BRIDGE_CLAUDE_CLI_NOT_INSTALLED',
    'BRIDGE_CLAUDE_CLI_PRESENCE_UNKNOWN',
    'BRIDGE_MCP_CONFIG_UNAVAILABLE',
  ]),
  local: Object.freeze([
    'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE',
    'BRIDGE_LOCAL_RUNNER_MISSING',
  ]),
})

const POST_LAUNCH_REFUSALS_BY_KIND = Object.freeze({
  codex: Object.freeze([
    'BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE',
    'BRIDGE_CODEX_UNAVAILABLE',
    'BRIDGE_CODEX_SPAWN_REFUSED',
    'BRIDGE_AGENT_LANE_START_FAILED',
  ]),
  claude: Object.freeze([
    'BRIDGE_CLAUDE_SPAWN_REFUSED',
    'BRIDGE_CLAUDE_UNAVAILABLE',
    'BRIDGE_AGENT_LANE_START_FAILED',
  ]),
  local: Object.freeze([]),
})

export function dispatchAttemptStage(answer, kind) {
  if (answer?.started === true) return 'after-launch-record'
  const code = typeof answer?.code === 'string' ? answer.code : ''
  if ((PRE_LAUNCH_REFUSALS_BY_KIND[kind] || []).includes(code)) return 'before-launch-record'
  if ((POST_LAUNCH_REFUSALS_BY_KIND[kind] || []).includes(code)) return 'after-launch-record'
  return 'unexpected'
}

export function dispatchOutcomeAllowed(answer, kind) {
  if (answer?.started === true) return kind === 'local'
  /* This code is correctly classified as a pre-launch outcome for audit-count
     purposes, but it is still a broken packaged configuration in this rig and
     must remain red rather than being mistaken for an absent provider. */
  if (answer?.code === 'BRIDGE_MCP_CONFIG_UNAVAILABLE') return false
  return dispatchAttemptStage(answer, kind) !== 'unexpected'
}

export function expectedLaunchAttempts(answers, kindByTier) {
  return answers.filter(answer => dispatchAttemptStage(answer, kindByTier.get(answer.tier)) === 'after-launch-record')
}

export function providerFreeObjectivesCompleted(planned, answers, kindByTier) {
  const plannedLocal = planned.filter(answer => kindByTier.get(answer.tier) === 'local')
  const answeredLocal = answers.filter(answer => kindByTier.get(answer.tier) === 'local')
  if (plannedLocal.length === 0) return false
  return dispatchCoverage(plannedLocal, answeredLocal).ok
    && answeredLocal.every(answer => answer?.started === true && answer?.providerFreeCompletion === true)
}

function dispatchPairKey({ tier, objectiveRef }) {
  return JSON.stringify([tier, objectiveRef])
}

export function dispatchCoverage(planned, answered) {
  const plannedKeys = planned.map(dispatchPairKey)
  const answeredKeys = answered.map(dispatchPairKey)
  const plannedSet = new Set(plannedKeys)
  const answeredSet = new Set(answeredKeys)
  const duplicates = answeredKeys.filter((key, index) => answeredKeys.indexOf(key) !== index)
  return Object.freeze({
    ok: plannedKeys.length === answeredKeys.length
      && plannedSet.size === plannedKeys.length
      && answeredSet.size === answeredKeys.length
      && plannedSet.size === answeredSet.size
      && [...plannedSet].every(key => answeredSet.has(key)),
    missing: [...plannedSet].filter(key => !answeredSet.has(key)),
    unexpected: [...answeredSet].filter(key => !plannedSet.has(key)),
    duplicates: [...new Set(duplicates)],
  })
}

export function shouldAbortRemainingDispatches(answer, kind) {
  return answer?.started === true && kind !== 'local'
}

/* A plain label and a queue phase id. The second one is the only shape that
   reaches the phase-claim gate; see the header. */
const OBJECTIVES = Object.freeze(['fleet-page-lane', 'Q1'])

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

/* The environment that makes a resolved dispatch harmless.
 *
 * THIS IS A STRUCTURAL ALLOWLIST, NOT A DENYLIST. The previous shape of this
 * function started from credentialSafeEnvironment(profile) -- itself a full
 * `{ ...process.env }` narrowed only by deleting names it recognised as
 * dangerous -- and deleted a further few names it recognised as PATH/home/
 * credential-shaped. Every name neither list had ever heard of rode along
 * unchanged: measured live, `npm run qa:packaged` has npm inject
 * npm_config_prefix (and every other npm_config_* key it resolves) into this
 * process's own environment before this file runs, and neither denylist
 * regex above ever matched it, so it reached the bridge child and let
 * defaultNpmRoots() resolve this account's real, already-signed-in
 * @openai/codex install instead of the empty sandbox APPDATA this function
 * was already redirecting correctly. Adding "npm_config_prefix" to the old
 * regex would only have closed that one name; NODE_PATH, NODE_OPTIONS, and
 * every other npm_config_* key remain equally unmatched, and npm invents new
 * ones as its own config surface grows. A denylist has to name every
 * dangerous key to stay closed; this object is instead built additively, so a
 * name this function has never heard of cannot ride along by construction --
 * nothing here ever iterates or copies an inherited object's keys.
 *
 * ONLY THE NAMES BELOW EVER REACH THE CHILD, each established by reading the
 * bridge's own boot path (engine src/lib/mission-bridge/server.js and its
 * requires, at the confirmed LIVE engine commit b7149aeb) rather than
 * assumed:
 *
 *   - SystemRoot/windir, read once from the real process.env. Windows itself
 *     needs them to hand out a file ACL -- the bridge refuses to start
 *     without them and cannot lock its own token file down (measured: a bare
 *     PATH produced UAC_TOKEN_UNAVAILABLE and no bridge at all). Traced to
 *     its exact call site: engine src/lib/uac-delegation.js, systemRoot()
 *     reads SystemRoot/SYSTEMROOT/windir to locate System32, and
 *     writeTokenFile() then runs `spawnSync('icacls.exe', ..., { shell:
 *     false })` -- a bare executable name Node can only resolve via the
 *     child's own PATH.
 *   - USERNAME/USERDOMAIN, read once from the real process.env. The same
 *     uac-delegation.js, function ownerPrincipal(deps): `const env = deps.env
 *     || process.env; const domain = (env.USERDOMAIN || '').trim(); const
 *     user = (env.USERNAME || '').trim();` -- this builds the
 *     `${principal}:(F)` argument icacls.exe grants access to, and
 *     loadOrCreateToken() calls it unconditionally on win32 for BOTH the
 *     bearer token and the bootstrap proof file this dispatcher itself reads
 *     every run. Without a resolvable USERNAME, ownerPrincipal() fails
 *     UAC_OWNER_PRINCIPAL_INVALID before icacls.exe is even reached -- a
 *     second, earlier boot-blocking gate than the PATH-driven one above, and
 *     the one true gap an earlier pass of this allowlist introduced relative
 *     to the old denylist (whose regex never matched "USERNAME" either, so
 *     the ambient value rode along by the same accident as everything else).
 *   - PATH, rebuilt from that same SystemRoot, so icacls.exe resolves.
 *   - APPDATA, USERPROFILE, CODEX_HOME, CLAUDE_CONFIG_DIR, computed fresh
 *     under this run's own disposable sandbox, exactly as this function
 *     redirected them before.
 *   - LOCALAPPDATA and TEMP/TMP, sandboxed alongside them for the same reason
 *     engine src/lib/mission-bridge/actions.js documents on
 *     accountConfinedDispatchEnvironment (production's dispatch-time
 *     counterpart, not touched by this fix): "retaining ambient HOME,
 *     USERPROFILE, APPDATA, LOCALAPPDATA or TEMP lets a packaged copy
 *     launched from another/elevated account read that account's directives,
 *     provider config and runtime state" -- production pins all five as one
 *     bundle, and this fence must not leave one of the five ambient while
 *     sandboxing the rest.
 *
 * Checked and deliberately NOT added, read against the actual boot path
 * rather than a suggested list: SystemDrive, ComSpec, PATHEXT,
 * NUMBER_OF_PROCESSORS, PROCESSOR_*, COMPUTERNAME. THE CAP: two independent
 * methods (`git grep` for literal `process.env.` and for any
 * `<alias>.UPPER_NAME` read via a variable bound to `process.env`/`deps.env`,
 * then reading every hit and every file in full) against exactly these seven
 * files at b7149aeb -- src/lib/uac-delegation.js, src/lib/mission-bridge/
 * server.js, src/lib/mission-bridge/actions.js, src/lib/runtime-state-root.js,
 * src/lib/account-profile-boundary.js, src/lib/settings.js,
 * src/lib/setup/machine-record.js -- the six required, directly or
 * transitively, from server.js's own startup (settings.js/machine-record.js
 * only inside the owner-UI-only `/v1/settings` route, never reached by this
 * dispatcher's own bootstrap/dispatch calls). None of SystemDrive, ComSpec,
 * NUMBER_OF_PROCESSORS, PROCESSOR_*, or COMPUTERNAME appears in any of the
 * seven. `src/lib/runtime.js` DOES read ComSpec, PATHEXT, LOCALAPPDATA, PATH,
 * APPDATA and ProgramFiles (`commandPathEnvironment()`'s cache key; a gcloud-
 * SDK candidate-path builder; `findBrowser()`'s Chrome/Edge search; a batch-
 * launch wrapper's `process.env.ComSpec || 'cmd.exe'`) -- but runtime.js is
 * not required anywhere in the seven files above, confirmed by grepping every
 * one of them (and mission-bridge.js's own entry chain) for a require of it:
 * every "runtime"-shaped require found is `require('./runtime-state-root')`,
 * never a bare `require('./runtime')`. ProgramFiles there is install-
 * discovery-shaped (the same npm_config_prefix-style defect, for the Google
 * Cloud SDK/Chrome/Edge instead of a provider CLI) and would be a deliberate
 * drop even if the file were reached; ComSpec/PATHEXT both have safe literal
 * fallbacks (`'cmd.exe'`, `.COM;.EXE;.BAT;.CMD`, the latter identical to the
 * ordinary Windows default) so omitting either changes nothing observable
 * even in that hypothetical. Adding any of these names would be unevidenced,
 * not merely extra caution. */
export function providerlessEnvironment(profile) {
  /* The shared credential/capability-path scrub still runs first, so this
     launcher keeps routing through the one place every custom launcher's
     credential fence is proven (tools/test/harness-credential-fence.test.mjs).
     Its LOCALAPPDATA is the only value taken from it below -- already
     sandboxed under `profile` by that shared scrub -- because nothing else
     here is ever copied from what it returns. */
  const scrubbed = credentialSafeEnvironment(profile)
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const windir = process.env.windir || systemRoot
  const userProfile = path.join(profile, 'no-home')
  const appData = path.join(profile, 'no-npm')
  const temp = path.join(profile, 'no-temp')
  mkdirSync(userProfile, { recursive: true })
  mkdirSync(appData, { recursive: true })
  mkdirSync(temp, { recursive: true })
  const environment = {
    SystemRoot: systemRoot,
    windir,
    USERNAME: process.env.USERNAME || '',
    USERDOMAIN: process.env.USERDOMAIN || '',
    PATH: [
      path.join(systemRoot, 'system32'),
      systemRoot,
      path.join(systemRoot, 'System32', 'Wbem'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';'),
    APPDATA: appData,
    LOCALAPPDATA: scrubbed.LOCALAPPDATA,
    USERPROFILE: userProfile,
    CODEX_HOME: path.join(userProfile, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(userProfile, '.claude'),
    TEMP: temp,
    TMP: temp,
  }
  /* Already absent by construction -- this object was never built from a
     copy of anything that could have carried it -- stated again in the exact
     idiom tools/test/electron-run-as-node-harness-guard.test.mjs recognises. */
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

function reap(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
  } catch { /* the tree is already gone */ }
}

/** Start one payload's bridge, POST the dispatches, and read the audit chain. */
async function measurePayload(payload, sandbox, label, dispatches, { localRuntime = null } = {}) {
  const stateRoot = path.join(sandbox, `${label}-state`)
  const workspace = path.join(sandbox, `${label}-workspace`)
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  const started = await startCapabilityLayer({
    root: payload,
    /* The shell passes its own window origin. Any loopback origin is accepted;
       the bearer is authorised by the per-boot proof file, not by this. */
    origin: 'http://127.0.0.1:4600',
    workspaceRoot: workspace,
    stateRoot,
    env: providerlessEnvironment(sandbox),
    execPath: process.execPath,
    timeoutMs: 90_000,
  })
  if (!started.ok) return { ok: false, code: started.code, reason: started.reason }

  const answers = []
  try {
    const proof = readCapabilityProof(started.bootstrapProofFile)
    if (!proof.ok) return { ok: false, code: proof.code, reason: proof.reason }
    const bootstrapUrl = new URL('/v1/bootstrap', started.baseUrl)
    bootstrapUrl.searchParams.set('proof', proof.proof)
    const boot = await (await fetch(bootstrapUrl, { headers: { accept: 'application/json' } })).json()
    if (boot?.ok !== true || typeof boot.token !== 'string') {
      return { ok: false, code: boot?.error?.code || 'BRIDGE_BOOTSTRAP_REFUSED', reason: 'no bearer' }
    }

    for (const { tier, objectiveRef } of dispatches) {
      const kind = tierTable(payload).get(tier)
      const completionsBefore = kind === 'local' ? providerFreeCompletionCount(localRuntime) : 0
      const response = await fetch(`${started.baseUrl}/v1/actions/dispatch`, {
        method: 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${boot.token}`, 'content-type': 'application/json' },
        /* The same body src/write-surfaces.js sends when a person presses
           Dispatch, with the smallest cap the launch record accepts. */
        body: JSON.stringify({
          rootId: 'main',
          tier,
          objectiveRef,
          brief: 'Packaged dispatch check. If this is the free local worker, exit immediately without tools. Paid-provider lanes are expected to refuse before they start.',
          cap: { kind: 'turns', value: 1, capMs: 60_000 },
        }),
      })
      const body = await response.json().catch(() => null)
      const started_ = body?.ok === true
      const providerFreeCompletion = started_ && kind === 'local'
        ? await waitForProviderFreeCompletion(localRuntime, { afterCount: completionsBefore })
        : false
      const answer = {
        tier,
        objectiveRef,
        status: response.status,
        started: started_,
        providerFreeCompletion,
        code: started_ ? null : (body?.error?.code || 'NO_CODE'),
        /* THE ONE FIELD THAT SAYS WHY, AND IT WAS BEING THROWN AWAY.
           LAUNCH_AUDIT_UNAVAILABLE is a CATCH-ALL: capability/src/lib/
           controller-launch-record.js:801-805 wraps any non-LaunchRecordError
           throw from the audit writer in that one code, and the real sentence
           survives only in details.cause (relayed by mission-bridge/errors.js).
           Reading `code` alone made "409 LAUNCH_AUDIT_UNAVAILABLE" the whole
           report, which cannot tell a product defect from this host's secret
           service being unreachable -- and a lane spent a day establishing which.
           Truncated because a cause can carry a path. */
        cause: started_ ? null : (typeof body?.error?.details?.cause === 'string'
          ? body.error.details.cause.slice(0, 300) : null),
      }
      answers.push(answer)
      /* A paid start means the provider fence failed. Kill immediately and do
         not risk a second paid start. A local start is credential-free and the
         shared bridge must remain alive so the other objective shape is also
         dispatched and correlated with its own completion POST. */
      if (shouldAbortRemainingDispatches(answer, kind)) {
        reap(started.child?.pid)
        break
      }
    }
  } finally {
    await stopCapabilityLayer(started.child)
    reap(started.child?.pid)
  }

  return { ok: true, answers, launches: launchRecords(stateRoot) }
}

/* The bridge's own audit chain, which is where the positive evidence is. Each
   `controller.agent.launch` event carries the record createLaunch() built, and
   createLaunch() runs only after the lane has been resolved from the declared
   organisation and after the phase-claim gate. */
function launchRecords(stateRoot) {
  const file = path.join(stateRoot, 'logs', 'actions.jsonl')
  const source = optionalFileContents(file)
  if (source === null) return []
  return source
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(event => event && event.action === 'controller.agent.launch')
    .map(event => event.details?.record)
    .filter(Boolean)
}

/* Where the payload under test comes from. Staging is the default because the
   question is about what SHIPS, and the staging step is the thing that decides
   it -- running it here means this driver measures the next build rather than
   the last one. */
async function resolvePayload(sandbox) {
  if (RELEASE) {
    return copyReleasePayloadForMeasurement(RELEASE, sandbox)
  }
  const payload = path.join(sandbox, 'payload')
  try {
    await execFile(process.execPath, [path.join(REPO, 'tools', 'pack-capability-layer.mjs'), '--out', payload, '--quiet'], {
      cwd: REPO, timeout: 240_000, windowsHide: true,
    })
    return { ok: true, payload, origin: 'a payload staged by the build\'s own staging step' }
  } catch (error) {
    /* A failed staging process says nothing about whether the checkout's older
       payload represents what the current build would ship. In particular,
       timeout, EMFILE, EAGAIN, EIO, EBUSY, and unclassified throws used to be
       converted into a successful measurement of that older payload. */
    const detail = error instanceof Error ? error.message : String(error)
    return couldNotDetermine(`staging the current payload failed (${detail.split('\n')[0]})`)
  }
}

/* A provider-free local runtime is installed by rewriting the four loopback
   ports in local-node-runtime.js. An explicit --release is the immutable input
   being measured, not a work directory: rewriting it would corrupt the exact
   candidate and make a second measurement fail after the first server closes.
   Validate the source first, then copy the whole payload into this run's
   sandbox so every later mutation is disposable. */
export function copyReleasePayloadForMeasurement(release, sandbox) {
  const sourcePayload = path.join(path.resolve(release), 'resources', 'capability')
  const manifest = payloadManifestStatus(sourcePayload)
  if (manifest.status === 'indeterminate') return manifest
  if (manifest.status === 'absent') {
    return { ok: false, reason: `${release} carries no capability payload under resources\\capability` }
  }
  const payload = path.join(sandbox, 'release-payload')
  try {
    cpSync(sourcePayload, payload, { recursive: true })
  } catch (error) {
    const code = error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'UNCLASSIFIED_THROW'
    return couldNotDetermine(`copying the packaged payload into the QA sandbox failed (${code})`)
  }
  return {
    ok: true,
    payload,
    sourcePayload,
    origin: `a scratch copy of the payload inside the built application named by --release (${sourcePayload})`,
  }
}

export function payloadManifestStatus(payload, read = readFileSync) {
  const manifest = path.join(payload, 'PAYLOAD.json')
  try {
    read(manifest)
    return { status: 'present' }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { status: 'absent' }
    const code = error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'UNCLASSIFIED_THROW'
    return {
      ...couldNotDetermine(`reading ${manifest} failed (${code})`),
      status: 'indeterminate',
    }
  }
}

export function optionalFileContents(file, read = readFileSync) {
  try {
    return read(file, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

function couldNotDetermine(reason) {
  return {
    ok: false,
    code: 'PACKAGED_QA_PAYLOAD_LOOKUP_INDETERMINATE',
    reason: `${reason}. This is not claiming that the packaged payload is absent.`,
  }
}

/* The defect, rebuilt. A whole copy of the measured payload with ONE file
   changed: the declared organisation, cut back to the controller alone, which is
   exactly what shipped. A copy rather than a junction tree, because a junction
   tree is a second implementation of "what a payload is" and this file already
   depends on being wrong about that in only one way. */
function controllerOnlyPayload(payload, sandbox) {
  const copy = path.join(sandbox, 'control-payload')
  cpSync(payload, copy, { recursive: true })
  const org = JSON.parse(readFileSync(path.join(payload, 'config', 'agent-org.json'), 'utf8'))
  writeFileSync(path.join(copy, 'config', 'agent-org.json'), `${JSON.stringify({
    ...org,
    agents: org.agents.filter(agent => agent.role === 'controller'),
    relationships: [],
  }, null, 2)}\n`)
  return copy
}

async function main() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'mc-dispatch-qa-'))
  let localRuntime = null
  console.log(`sandbox: ${sandbox}`)
  try {
    const resolved = await resolvePayload(sandbox)
    if (!resolved.ok) {
      console.error(`agent-dispatch-packaged-qa: no payload to measure -- ${resolved.reason}`)
      return 2
    }
    const { payload } = resolved
    localRuntime = await startProviderFreeLocalRuntime(payload)
    console.log('artifact identity: instrumented scratch payload (loopback port rewrite); exactArtifactProof=false')
    console.log(`payload: ${resolved.origin}\n         ${payload}`)

    /* ---------- 1. THE PAYLOAD CARRIES THE SHIPPED ORGANISATION ---------- */
    const orgFile = path.join(payload, 'config', 'agent-org.json')
    const shipped = optionalFileContents(orgFile) ?? ''
    const declared = shipped ? JSON.parse(shipped) : { agents: [] }
    console.log(`declared agents: ${declared.agents.map(agent => `${agent.id}(${agent.provider})`).join(', ') || 'none'}`)
    check('the payload carries the organisation the build stages, not the builder\'s own',
      shipped === readFileSync(DEFAULTS_ORG, 'utf8'),
      shipped ? `${declared.agents.length} declared` : 'no organisation in the payload')

    /* ---------- 2. A REAL DISPATCH, EVERY TIER, BOTH OBJECTIVE SHAPES ---------- */
    const tiers = tierNames(payload)
    check('the engine\'s tier table was readable, so every tier the product offers is measured',
      tiers.length >= 6, `tiers: ${tiers.join(', ') || 'none found'}`)
    const dispatches = tiers.flatMap(tier => OBJECTIVES.map(objectiveRef => ({ tier, objectiveRef })))

    const measured = await measurePayload(payload, sandbox, 'shipped', dispatches, { localRuntime })
    if (!measured.ok) {
      check('the payload\'s own capability layer started', false, `${measured.code}: ${measured.reason}`)
      return report()
    }
    check('the payload\'s own capability layer started', true,
      `${measured.answers.length} of ${dispatches.length} planned dispatch attempts completed`)

    const kinds = tierTable(payload)
    const providerFreeStarts = measured.answers.filter(answer => answer.started === true
      && answer.providerFreeCompletion === true && kinds.get(answer.tier) === 'local')
    check('every local objective started the deterministic provider-free worker and completed its own response',
      providerFreeObjectivesCompleted(dispatches, measured.answers, kinds),
      `${providerFreeStarts.length}/${dispatches.filter(answer => kinds.get(answer.tier) === 'local').length} local objective answers completed provider-free responses`)
    const coverage = dispatchCoverage(dispatches, measured.answers)
    check('every planned tier/objective pair completed exactly once', coverage.ok,
      `${measured.answers.length}/${dispatches.length} completed; missing=${coverage.missing.join(', ') || 'none'}; unexpected=${coverage.unexpected.join(', ') || 'none'}; duplicates=${coverage.duplicates.join(', ') || 'none'}`)

    for (const answer of measured.answers) {
      const where = `${answer.tier} / ${answer.objectiveRef}`
      /* THE ASSERTION THIS FILE EXISTS FOR. */
      check(`${where}: the shipped organisation declares an agent for this tier`,
        answer.code !== 'BRIDGE_AGENT_DECLARATION_MISSING', `${answer.status} ${answer.code || 'started'}`)
      check(`${where}: the launch record accepted it`,
        !String(answer.code || '').startsWith('LAUNCH_'),
        `${answer.status} ${answer.code || 'started'}${answer.cause ? ` -- cause: ${answer.cause}` : ''}`)
      const kind = kinds.get(answer.tier)
      /* The budget guarantee, asserted rather than assumed. A local worker has
         no paid provider and is the one kind allowed to start in this rig. */
      check(`${where}: no paid provider was started`, answer.started !== true || kind === 'local',
        answer.started ? `the ${kind || 'unknown'} worker started` : 'refused before a paid provider started')
      /* AND IT GOT ALL THE WAY THERE. Without this, a refusal from any earlier
         gate would satisfy the two checks above while proving nothing. */
      /* PER KIND, NOT ONE LIST FOR ALL OF THEM. A local node has no provider CLI
         to be missing; what it lacks is a model runtime, and the payload says so
         with its own code. Accepting that code for a CODEX tier would be wrong --
         it would mean the codex lane had somehow taken the local branch -- so the
         allowed set is chosen by the tier's kind rather than merged into one list. */
      const REFUSALS_BY_KIND = {
        /* AUDITED 2026-08-28, LEFT UNCHANGED -- this array's two "old-looking"
         * entries are NOT dead code; an EARLIER pass on this file wrongly
         * assumed they were (see the claude comment below, whose "codex's old
         * kinds are equally absent" sentence that finding produced was WRONG
         * and has been corrected here).
         *
         * A grep for the exact quoted strings 'BRIDGE_CODEX_UNAVAILABLE' and
         * 'BRIDGE_CODEX_SPAWN_REFUSED' finds nothing in the engine, because
         * neither is written as a string literal. Both are constructed
         * DYNAMICALLY from the lane's own kind, in engine/src/lib/mission-
         * bridge/actions.js:
         *   line 1011  laneStartupError(): `BRIDGE_${kind.toUpperCase()}_SPAWN_REFUSED`
         *              on ENOENT/EACCES/EPERM from the actual child-process spawn,
         *              AFTER resolveCommand() already found something to run --
         *              a distinct failure point from the presence checks below.
         *              Three call sites reach it (actions.js:1272,1290,1305),
         *              all wrapping the real startAgentLane()/execution.started
         *              path.
         *   line 1204/1208/1248
         *              `BRIDGE_${kind.toUpperCase()}_UNAVAILABLE` when
         *              resolveCommand() throws without the specific
         *              CODEX_NATIVE_PAIR_UNAVAILABLE code, when the resolved
         *              command has the wrong shape, or when its arguments
         *              cannot be resolved.
         *   line 1013  the same `_UNAVAILABLE` template, reached via
         *              laneStartupError()'s AGENT_LANE_COMMAND_REFUSED branch.
         * For kind='codex' these templates produce exactly
         * BRIDGE_CODEX_SPAWN_REFUSED and BRIDGE_CODEX_UNAVAILABLE -- the same
         * strings this array has held since 2026-08-16. Neither of these two
         * branches is what actually fires in THIS harness's own sandbox (every
         * codex row here hits BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE at
         * actions.js:1199, confirmed on three live runs), so this file cannot
         * honestly claim to have forced a live red through them the way the
         * claude fix below did for CLI_NOT_INSTALLED -- laneStartupError is not
         * exported by actions.js and nothing in the engine's own test suite
         * calls it either (grepped engine/tests: zero references), so proving
         * SPAWN_REFUSED/dynamic-UNAVAILABLE live would need a rig that gets
         * resolveCommand('codex') to succeed and the subsequent real spawn to
         * still fail with ENOENT/EACCES/EPERM -- not attempted here. Recorded
         * as unproven rather than implied. BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE
         * and BRIDGE_AGENT_LANE_START_FAILED remain the two entries this file
         * can and does prove live, on every run.
         *
         * config/codex.json's own refusals (BRIDGE_CODEX_PROFILE_UNAVAILABLE,
         * BRIDGE_CODEX_PROFILE_AUTH_UNREADABLE -- actions.js:445-472) are
         * deliberately NOT added here: they fire only when that config file
         * EXISTS and names a broken owner-pinned identity, which is a
         * configuration problem on a machine where codex IS present, not "codex
         * is not installed" -- the same distinction the engine itself draws
         * between BRIDGE_MCP_CONFIG_UNAVAILABLE and BRIDGE_CLAUDE_UNAVAILABLE
         * (see mission-bridge-claude-mcp-config.test.js:170-174). Folding them
         * in would let this check pass for the wrong reason. */
        codex: ['BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE', 'BRIDGE_CODEX_UNAVAILABLE', 'BRIDGE_CODEX_SPAWN_REFUSED', 'BRIDGE_AGENT_LANE_START_FAILED'],
        /* BRIDGE_CLAUDE_UNAVAILABLE does not appear as a string LITERAL
         * anywhere in the engine's mission-bridge (it survives only as a
         * comment in one engine test, explicitly naming what it USED to
         * mean). This allowlist was proven live against the shipped 1.0.20
         * install when it was written (2026-08-16, 64/64), so the kind really
         * was BRIDGE_CLAUDE_UNAVAILABLE then; the engine's own first commit in
         * its current history (2026-08-21) already carries
         * claudeCliPresent()'s split into BRIDGE_CLAUDE_CLI_NOT_INSTALLED
         * (definitely absent) and BRIDGE_CLAUDE_CLI_PRESENCE_UNKNOWN (could
         * not be checked, asked positively rather than defaulted).
         *
         * BRIDGE_CLAUDE_SPAWN_REFUSED IS BACK, 2026-08-28, after wrongly being
         * dropped when this row was first narrowed to the two presence-check
         * kinds above. It is not dead code and was never a literal string to
         * begin with: it is the identical `BRIDGE_${kind.toUpperCase()}_
         * SPAWN_REFUSED` template documented in full beside the codex row
         * above (engine/src/lib/mission-bridge/actions.js:1011, three real
         * call sites at :1272/:1290/:1305, all wrapping the actual spawn
         * attempt), just with kind='claude'. It is a real, later failure
         * point than the presence checks: claudeCliPresent() can say yes and
         * the real spawn can still ENOENT/EACCES/EPERM afterward, and without
         * this entry that would false-red every check in this row. Same
         * honesty treatment as codex: not live-forced here either (same
         * unexported, untested laneStartupError, same "would need a
         * present-but-unspawnable rig" gap) -- see the codex comment for the
         * full unproven-not-implied reasoning, which applies here unchanged.
         *
         * BRIDGE_CLAUDE_UNAVAILABLE, added in K's ratification pass 2026-08-28:
         * the generic `BRIDGE_${lane.kind.toUpperCase()}_UNAVAILABLE` fallback
         * (mission-bridge actions.js:1204, "The <kind> executable could not be
         * resolved", plus the AGENT_LANE_COMMAND_REFUSED shape at :1017) is
         * kind-generic with only a codex carve-out in front of it, so any
         * resolveCommand('claude') throw emits it. Source-proven reachable,
         * same evidence class as SPAWN_REFUSED; same unproven-not-implied
         * caveat for the red direction. */
        claude: ['BRIDGE_CLAUDE_CLI_NOT_INSTALLED', 'BRIDGE_CLAUDE_CLI_PRESENCE_UNKNOWN', 'BRIDGE_CLAUDE_SPAWN_REFUSED', 'BRIDGE_CLAUDE_UNAVAILABLE', 'BRIDGE_AGENT_LANE_START_FAILED'],
        local: ['BRIDGE_LOCAL_RUNTIME_UNAVAILABLE', 'BRIDGE_LOCAL_RUNNER_MISSING'],
      }
      const allowed = REFUSALS_BY_KIND[kind] || []
      check(`${where}: its outcome is valid for this kind of agent`,
        dispatchOutcomeAllowed(answer, kind)
          && (answer.started === true || allowed.includes(answer.code)),
        `kind=${kind || 'unknown'} ${answer.status} ${answer.code || 'started'}`)
      check(`${where}: its launch-record stage is known`,
        dispatchAttemptStage(answer, kind) !== 'unexpected',
        `kind=${kind || 'unknown'} code=${answer.code || 'started'}`)
    }

    /* ---------- 3. THE POSITIVE EVIDENCE, FROM THE AUDIT CHAIN ---------- */
    /* NOT EVERY ATTEMPT IS SUPPOSED TO REACH THE LAUNCH RECORD. Derive the
       expected count from the attempts that actually completed and the side of
       createLaunch() on which each outcome occurs. This includes a successful
       local worker, and excludes Claude/local preflight refusals. */
    const kindOf = tierTable(payload)
    const recording = expectedLaunchAttempts(measured.answers, kindOf)
    const earlyRefusing = measured.answers.filter(answer =>
      dispatchAttemptStage(answer, kindOf.get(answer.tier)) === 'before-launch-record')
    check('every completed dispatch that passed record creation has exactly one launch record',
      measured.launches.length === recording.length,
      `launch records=${measured.launches.length}, record-stage attempts=${recording.length}, preflight refusals=${earlyRefusing.length}, completed attempts=${measured.answers.length}`)
    const declaredIds = new Set(declared.agents.map(agent => agent.id))
    check('every launch record names a seat the shipped organisation declares',
      measured.launches.length > 0 && measured.launches.every(record => declaredIds.has(record.targetAgentId)),
      [...new Set(measured.launches.map(record => record.targetAgentId))].join(', ') || 'none')
    const declaredById = new Map(declared.agents.map(agent => [agent.id, agent]))
    check('the launch records line up with the completed attempts that crossed record creation',
      measured.launches.length === recording.length && recording.every((attempt, index) => {
        const record = measured.launches[index]
        return record?.objectiveRef === attempt.objectiveRef
          && declaredById.get(record?.targetAgentId)?.provider === kindOf.get(attempt.tier)
      }),
      recording.map((attempt, index) => {
        const record = measured.launches[index]
        return `${attempt.tier}/${attempt.objectiveRef}->${record?.targetAgentId || 'missing'}/${record?.objectiveRef || 'missing'}`
      }).join(', '))
    check('a phase-shaped objective passed the claim gate rather than skipping it',
      measured.launches.some(record => record.objectiveRef === 'Q1'),
      `${measured.launches.filter(record => record.objectiveRef === 'Q1').length} phase claims recorded`)

    /* ---------- 4. THE INSTRUMENT PROVES IT CAN STILL GO RED ---------- */
    const control = await measurePayload(
      controllerOnlyPayload(payload, sandbox),
      sandbox,
      'control',
      [{ tier: tiers[0], objectiveRef: 'Q1' }],
    )
    check('the defect can still be reproduced, so a green run above means something',
      control.ok && control.answers[0]?.code === 'BRIDGE_AGENT_DECLARATION_MISSING',
      control.ok ? `${control.answers[0]?.code}` : `${control.code}: ${control.reason}`)

    return report()
  } finally {
    if (localRuntime) await localRuntime.close()
    if (KEEP) console.log(`sandbox kept: ${sandbox}`)
    else { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* cleanup may never fail the run */ } }
  }
}

function report() {
  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  for (const entry of failed) console.log(`  FAILED: ${entry.name}`)
  return failed.length === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then(
    code => { process.exit(code) },
    error => { console.error(error?.stack || String(error)); process.exit(2) },
  )
}
