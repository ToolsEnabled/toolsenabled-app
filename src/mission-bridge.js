/* WHAT A REFUSAL ON THIS MODULE'S TWO CONTROLS SAYS. The identifier is kept as
   a machine field on the state object and never put in front of a person — see
   ./refusal-copy.js for why, and for the family floor that stops a code the
   engine adds next month reaching a customer bare. */
import { refusalCodeOf, refusalSentence } from './refusal-copy.js'
import { controlState as sharedControlState } from './components.js'
/* AND WHERE THE ANSWER GOES WHEN THE SCREEN IS ALREADY GONE. The archive
   control moves requests between two DURABLE ledgers; that is a real write, and
   `if (destroyed) return` above the line that reads the receipt threw its answer
   away whenever the person walked off the page mid-call. Filed here before the
   destroyed check and restated on the next mount — the pattern
   ./approval-outcomes.js set on #/approvals and ./agent-loops.js follows. */
import {
  WRITE_OUTCOME_KEYS,
  clearUndeliveredWrite,
  recordUndeliveredWrite,
  restatedMessage,
  undeliveredWrite,
} from './write-outcomes.js'
/* AND THE ONE READ ON THIS MODULE WHOSE ANSWER IS A FIXED FACT ABOUT THE
   INSTALLATION RATHER THAN A READING THAT MOVES. Its header carries the
   measurement and the reason only the two structural codes are remembered. */
import { createSettledAnswerMemo } from './local-tiers-memo.js'
import { assessBridgeApiCompatibility } from './generated/bridge-api-contract.js'

const ACTION_ROUTES = Object.freeze({
  dispatch: '/v1/actions/dispatch',
  'report-read': '/v1/actions/report-read',
  /* Read-only: what became of a launch this app already handed over. Behind no
     write flag of its own — it is the second half of the dispatch the person
     already made, and gating it separately would leave anyone with dispatch on
     and this off staring at "starting on it now" for ever, which is the exact
     defect it exists to end. */
  'launch-status': '/v1/actions/launch-status',
  queue: '/v1/actions/queue',
  'thread-reply': '/v1/actions/thread-reply',
  decision: '/v1/actions/decision',
  terminate: '/v1/actions/terminate',
  'ledger-archive': '/v1/actions/ledger-archive',
  'owner-prompt-presented': '/v1/actions/owner-prompt-presented',
  'owner-prompt-decision': '/v1/actions/owner-prompt-decision',
  // Codex Cloud. The launch is the only write; the other three read.
  'cloud-accounts': '/v1/actions/cloud-accounts',
  'cloud-tasks': '/v1/actions/cloud-tasks',
  'cloud-task-status': '/v1/actions/cloud-task-status',
  'cloud-launch': '/v1/actions/cloud-launch',
  // The cloud mirror a dispatch is checked against. list reads one local
  // file; register reaches the provider and the mirror remote.
  'cloud-mirror-list': '/v1/actions/cloud-mirror-list',
  'cloud-mirror-register': '/v1/actions/cloud-mirror-register',
  'cloud-mirror-disable': '/v1/actions/cloud-mirror-disable',
  'cloud-mirror-publish': '/v1/actions/cloud-mirror-publish',
  /* The research bench family — same registered tools the MCP surface serves,
     reachable from the workbench without a session. */
  'task-submit': '/v1/actions/task-submit',
  'task-claim': '/v1/actions/task-claim',
  'task-get': '/v1/actions/task-get',
  'task-list': '/v1/actions/task-list',
  'role-complete': '/v1/actions/role-complete',
  /* The research project family: durable projects, experiments, runs, results,
     findings and session assignment. Four reads, six writes; the server keeps
     the read/write distinction at the provider behind each action. */
  'research-snapshot': '/v1/actions/research-snapshot',
  'research-runs': '/v1/actions/research-runs',
  'research-results': '/v1/actions/research-results',
  'research-findings': '/v1/actions/research-findings',
  'research-project-save': '/v1/actions/research-project-save',
  'research-experiment-save': '/v1/actions/research-experiment-save',
  'research-run-submit': '/v1/actions/research-run-submit',
  'research-session-assign': '/v1/actions/research-session-assign',
  'research-finding-save': '/v1/actions/research-finding-save',
  'research-lifecycle': '/v1/actions/research-lifecycle',
})

let bootstrapPromise = null
// Measured against the live bridge 2026-08-06, not guessed: every audited
// action pays for durable audit-chain writes, and the old 5s budget was below
// the floor for all of them — report-read 5.38s, thread-reply 7.79s, status
// 12.34s, dispatch longer still because it spawns a process. A budget under
// the measured cost does not make anything faster; it just turns completed
// work into a false "timed out". The real fix is server-side audit latency;
// see the shadow report to the coordinator.
const REQUEST_TIMEOUT_MS = 30_000
export const WELL_KNOWN_BRIDGE_PORTS = Object.freeze(
  Array.from({ length: 10 }, (_value, index) => 4610 + index),
)
const WELL_KNOWN_BRIDGES = Object.freeze(
  WELL_KNOWN_BRIDGE_PORTS.map(port => `http://127.0.0.1:${port}`),
)
const BRIDGE_PROOF_RE = /^[A-Za-z0-9_-]{43}$/

// `/v1/status` is deliberately expensive on the bridge side: it parses every
// root's BUILD-QUEUE.md and writes TWO durable audit receipts per root
// (intentAudit, then outcomeAudit -- capability/src/lib/mission-bridge/
// actions.js status()), so it gets its own budget while ordinary actions keep
// the tight one. Availability is probed separately via the cheap
// unauthenticated /v1/runtime — see bridgeReachable().
//
// THE OLD 30,000 MS BUDGET WAS THE SAME MISTAKE THIS FILE'S ACTION_TIMEOUT_MS
// COMMENT ALREADY NAMES FOR `dispatch`: a client budget under the real cost of
// a durable-audit-writing call reports a false "timed out" for work the bridge
// was about to finish. It was set from a single ~12s sample; the live action
// ledger no longer agrees. MEASURED 2026-09-03: system.status (what /v1/status
// calls) succeeded in as long as 31,121 ms -- one sample already past the old
// 30,000 ms ceiling, at 19:36:52Z, the exact "misreported as failed" case the
// dispatch comment describes, just not yet written down for this action. Each
// of the two durable writes status() makes is ordinary audit-chain traffic,
// and that traffic is not free here: the SAME ledger's host.exec "Durable
// audit intent could not be recorded" failures (a saturated audit writer, not
// this endpoint) span 4,619-53,012 ms across 50 records, so two of them in
// series on a busy machine is not a remote edge case.
//
// So `/v1/status` moves into the SAME budget tier as the file's other
// durable-audit-writing actions below (dispatch, terminate, ledger-archive,
// cloud-accounts: all 120,000 ms), rather than staying alone in the tight
// tier its own header comment already says it does not belong in.
export const STATUS_TIMEOUT_MS = 120_000

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  return AbortSignal.timeout(ms)
}

function unavailable(error) {
  const timedOut = error?.name === 'TimeoutError'
  return { ok: false, reason: timedOut ? 'action bridge timed out' : (error?.message || 'action bridge unreachable'), code: timedOut ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNREACHABLE' }
}

export function normalizedBaseUrl(candidate) {
  let url
  try { url = new URL(candidate) } catch { return { ok: false, reason: 'action bridge address is malformed' } }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, reason: 'action bridge address must be a bare loopback HTTP origin' }
  }
  return { ok: true, baseUrl: url.origin }
}

function validRuntimeDiscovery(discoveryOrigin, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.getPrototypeOf(body) !== Object.prototype
      || Reflect.ownKeys(body).some(key => !['ok', 'baseUrl', 'port', 'startedAt', 'pid'].includes(key))
      || ['ok', 'baseUrl', 'port', 'startedAt', 'pid'].some(key => !Object.hasOwn(body, key))
      || body.ok !== true) return null
  const configured = normalizedBaseUrl(body.baseUrl)
  const startedAtMs = typeof body.startedAt === 'string' ? Date.parse(body.startedAt) : NaN
  if (!configured.ok || configured.baseUrl !== discoveryOrigin
      || !Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65535
      || new URL(configured.baseUrl).port !== String(body.port)
      || !Number.isSafeInteger(body.pid) || body.pid < 1
      || !Number.isFinite(startedAtMs) || new Date(startedAtMs).toISOString() !== body.startedAt) return null
  return configured
}

// The shell is the only party that knows which local listener is legitimately
// this app's own bridge. Ask it. A shell that cannot answer (a plain browser,
// or a build with no such bridge) leaves the developer scan in place, where a
// human has already opted in by other means.
async function shellBridgeEndpoint() {
  const ask = window.mcShell?.getBridgeEndpoint
  if (typeof ask !== 'function') return { ok: false, source: 'none' }
  try {
    const endpoint = await ask()
    return endpoint && typeof endpoint === 'object' ? endpoint : { ok: false, source: 'none' }
  } catch {
    return { ok: false, source: 'none' }
  }
}

// Pin to the exact origin the shell says it started, and confirm the process
// answering there is the one it started before trusting it. NO fallback to the
// range scan on failure: falling back is precisely how the renderer would hand
// this boot's proof to a squatter that raced onto a lower discovery port. The
// shell's own layer holds its port exclusively, so a squatter cannot occupy it;
// the pid check additionally fails closed if the shell's layer died and some
// other process grabbed the port in between. Either way we refuse rather than
// discover.
async function pinnedOwnLayer(endpoint) {
  const normalized = normalizedBaseUrl(endpoint.baseUrl)
  if (!normalized.ok) {
    return { ok: false, reason: 'the ToolsEnabled shell reported a malformed own-layer origin', code: 'BRIDGE_OWN_LAYER_INVALID' }
  }
  try {
    const response = await fetch(`${normalized.baseUrl}/v1/runtime`, {
      method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
      redirect: 'error',
      signal: timeoutSignal(),
    })
    const body = await response.json().catch(() => null)
    const configured = response.ok ? validRuntimeDiscovery(normalized.baseUrl, body) : null
    if (configured && (!Number.isSafeInteger(endpoint.pid) || body.pid === endpoint.pid)) {
      return configured
    }
  } catch {
    // fall through to the fail-closed result; never scan
  }
  return {
    ok: false,
    reason: 'the ToolsEnabled shell started a capability layer this renderer could not confirm; refusing to hand its bootstrap proof to any other local listener',
    code: 'BRIDGE_OWN_LAYER_UNCONFIRMED',
  }
}

async function scanWellKnownBridges() {
  for (const discoveryOrigin of WELL_KNOWN_BRIDGES) {
    try {
      const response = await fetch(`${discoveryOrigin}/v1/runtime`, {
        method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
        redirect: 'error',
        signal: timeoutSignal(),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) continue
      const configured = validRuntimeDiscovery(discoveryOrigin, body)
      if (configured) return configured
    } catch {
      // A refused, malformed, or timed-out candidate is not discovery. Continue
      // through the bounded declared range without trusting its response.
    }
  }
  return {
    ok: false,
    reason: 'action bridge unavailable on the declared 127.0.0.1:4610-4619 range',
    code: 'BRIDGE_DISCOVERY_UNAVAILABLE',
  }
}

/* MAY THIS PAGE REACH THE COMPUTER IT IS RUNNING ON?
 *
 * Structural, from the page's own origin, and nothing else. The desktop shell
 * serves dist/ from http://127.0.0.1:<port> (shell/port-scan.cjs), and a dev
 * `vite preview` is loopback too -- so a loopback origin means the machine in
 * front of the person is the machine hosting this page, and scanning it is
 * reaching the HOST, which is fine. A page served from any public origin is the
 * website: the computer in front of the person is a visitor's own machine --
 * possibly a friend's -- and this application must never reach into it. That is
 * the owner's rule stated as architecture: "when a user is on the web we can't
 * be trying to hook into their computer, even when logged in."
 *
 * Until now that rule was held by a CONVENTION: the site's host-bridge.js
 * answered getBridgeEndpoint with source:'supervised' and a deliberately
 * invalid baseUrl, so pinnedOwnLayer() refused before fetching. Remove that
 * file, or fail to load it, and the scan below ran against a visitor's
 * loopback -- and `?bridge=http://127.0.0.1:4610` pasted into the site's URL
 * was honoured outright. A rule that depends on a helper file loading is off
 * exactly when something is wrong, so it is enforced here, where the fetch is.
 */
export function pageMayReachLoopback() {
  try {
    const host = String(globalThis.window?.location?.hostname || '')
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

export async function configuredBaseUrl() {
  // The structural gate, ahead of EVERY path that could touch loopback --
  // including the supervised pin: pinnedOwnLayer only ever accepts loopback
  // URLs, and on a public origin a loopback URL is a visitor's own machine no
  // matter which host answered it. A signed-in page reaches a machine through
  // the host-supplied transport (setBridgeTransport), which request() consults
  // before ever calling this function, so nothing legitimate is lost here.
  if (!pageMayReachLoopback()) {
    return {
      ok: false,
      reason: 'This page is on a public origin, so it will not look for a bridge on the computer in front of you. A signed-in page reaches your own machine through its relay transport.',
      code: 'BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN',
    }
  }

  const endpoint = await shellBridgeEndpoint()

  // Supervised (customer) path: the shell started the layer and knows its exact
  // origin. Pin to it, never scan, never honor ?bridge=. This is the path a
  // double-clicked install takes, and the one a local squatter targets.
  if (endpoint.ok && endpoint.source === 'supervised') {
    return pinnedOwnLayer(endpoint)
  }

  // Developer path (MC_BRIDGE_PROOF_FILE) or non-shell context: the bridge was
  // started outside this app by a human who opted in, so the ?bridge= override
  // and the bounded range scan remain available to them.
  const params = new URLSearchParams(window.location.search)
  if (params.has('bridge')) return normalizedBaseUrl(params.get('bridge'))
  return scanWellKnownBridges()
}

async function bootstrap() {
  const configured = await configuredBaseUrl()
  if (!configured.ok) return configured
  const getBridgeProof = window.mcShell?.getBridgeProof
  if (typeof getBridgeProof !== 'function') {
    return {
      ok: false,
      reason: 'action bridge bootstrap proof is unavailable outside the ToolsEnabled desktop shell',
      code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE',
    }
  }

  let proofResult
  try {
    proofResult = await getBridgeProof()
  } catch {
    return {
      ok: false,
      reason: 'the ToolsEnabled desktop shell could not provide the action bridge bootstrap proof',
      code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE',
    }
  }
  if (proofResult?.ok !== true || typeof proofResult.proof !== 'string'
      || !BRIDGE_PROOF_RE.test(proofResult.proof)) {
    return {
      ok: false,
      reason: typeof proofResult?.reason === 'string'
        ? proofResult.reason
        : 'the ToolsEnabled desktop shell has no valid action bridge bootstrap proof',
      code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE',
    }
  }

  try {
    const bootstrapUrl = new URL('/v1/bootstrap', configured.baseUrl)
    bootstrapUrl.searchParams.set('proof', proofResult.proof)
    const response = await fetch(bootstrapUrl, {
      method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
      redirect: 'error',
      signal: timeoutSignal(),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok !== true || typeof body.token !== 'string') {
      return { ok: false, reason: body?.error?.message || `action bridge refused bootstrap (${response.status})`, code: body?.error?.code || 'BRIDGE_BOOTSTRAP_REFUSED' }
    }
    return { ok: true, baseUrl: configured.baseUrl, token: body.token }
  } catch (error) {
    return unavailable(error)
  }
}

async function session() {
  if (!bootstrapPromise) bootstrapPromise = bootstrap()
  const pending = bootstrapPromise
  const result = await pending
  if (!result.ok && bootstrapPromise === pending) bootstrapPromise = null
  return result
}

/* THE ONE SEAM THE BROWSER BUILD NEEDS.
 *
 * Every exported call in this module funnels through request(). On a desktop
 * machine that means a loopback fetch to this machine's own action bridge, and
 * normalizedBaseUrl() above refuses anything that is not bare loopback -- which
 * stays exactly as strict as it has always been.
 *
 * In a browser, the bridge is not reachable at all: it is on the person's
 * MACHINE, behind their router, and it must stay that way. So the browser does
 * not get a remote bridge address -- there is no such thing and this module
 * will not accept one. It supplies a TRANSPORT instead, which carries the same
 * request to that machine over the sealed relay tunnel, where the machine
 * performs it against its own loopback bridge exactly as it would locally.
 *
 * That distinction is the whole point. Widening the origin rule would have
 * made the bridge reachable from somewhere that is not this machine. Swapping
 * the transport does not: the bridge is still only ever spoken to over
 * loopback, by a process on its own machine.
 *
 * A transport is: (pathname, { method, body, timeoutMs }) -> the same
 * { ok: true, ... } / { ok: false, reason, code } shape request() returns.
 */
let transport = null
let transportRevision = 0

/* THE MEMO FOR localTiersStatus(), AND THE KEY THAT SAYS WHICH MACHINE
 * ANSWERED. Declared here, beside the transport it keys on, so that the seam
 * below can clear it without depending on where in this file it was written.
 *
 * `transport` is null when this page is talking to its own computer's loopback
 * layer and a function when a host has handed over a tunnel to a DIFFERENT
 * computer. Those two are not required to agree about whether a peer machine is
 * configured, so the transport in force is part of the key rather than
 * something the memo assumes. */
const localTiersMemo = createSettledAnswerMemo()
const answeringMachineKey = () => (transport === null ? 'local' : transport)

export function setBridgeTransport(next) {
  if (next !== null && typeof next !== 'function') throw new TypeError('a bridge transport must be a function or null')
  transportRevision += 1
  // A lookup from the previous selection may finish later. Invalidate its
  // answer and let a new session start its own lookup immediately.
  hostTransportInFlight = null
  transport = next
  /* An explicit INSTALL is the final word -- a later lazy host lookup must not
   * replace a transport somebody chose. An explicit REMOVAL is not: it means
   * "go back to asking", so that signing out and signing in again can install
   * one through the host seam. Marking a removal as answered would leave a
   * person who signed back in permanently on the local path, which in a
   * browser is no path at all. */
  hostTransportAsked = next !== null
  bootstrapPromise = null
  /* THE MACHINE ON THE OTHER END HAS CHANGED, so anything remembered ABOUT that
     machine is now about somebody else's computer. The memo below keys on the
     transport as well, so this is belt and braces rather than the only guard --
     but installing and removing the same function object would otherwise
     produce the same key for two different sessions. */
  localTiersMemo.forget()
  return transport
}

export function bridgeTransportInstalled() {
  return transport !== null
}

/* IS THERE A MACHINE ON THE OTHER END? Asked by the data-source resolver to
 * read current reachability on a public origin. A failed or absent offer is
 * retryable; it does not select example data or permanently memoize absence.
 * Re-asking is
 * only meaningful while no transport is installed -- an installed one is an
 * explicit choice and stays the final word, exactly as setBridgeTransport
 * documents. */
export async function bridgeTransportAvailable({ reask = false } = {}) {
  if (transport) return true
  if (reask && !hostTransportInFlight) hostTransportAsked = false
  await hostTransport()
  return transport !== null
}

/* A HOST MAY SUPPLY THE TRANSPORT, the same way it already supplies the
 * bridge endpoint. `window.mcShell.getBridgeTransport()` is asked on demand,
 * and a successful answer is installed. The website uses this to hand
 * over a relay tunnel to the person's own machine when they are signed in and
 * have one connected; the desktop shell does not implement it and gets the
 * local path, unchanged.
 *
 * Asked LAZILY rather than at import: on the website the transport cannot
 * exist until a session and a machine pair do, and a check at import would
 * settle the answer as "none" before either was true. */
let hostTransportAsked = false
/* THE ASK IN FLIGHT, so that everyone who arrives during it waits for the same
 * answer instead of reading the flag and concluding there is none.
 *
 * THIS IS THE BUG THAT MADE THE WEB JOURNEY LOOK BROKEN, and it is worth
 * writing down because nothing about it looks like a bug. Two callers reach
 * here on every page load: the app's first bridge request, and the data-source
 * resolver deciding relay-versus-mock. The first sets the flag and waits out a
 * handshake to the person's machine. The second arrives a moment later, sees
 * `hostTransportAsked` already true, returns immediately -- and its caller then
 * reads `transport`, which is still null BECAUSE THE ANSWER HAS NOT ARRIVED
 * YET, and settles the whole page on 'mock'.
 *
 * So a machine that answered in two seconds was reported as absent, the browser
 * drew the labelled example, and every diagnostic agreed with it: the relay
 * logged a session, the machine logged the web session opening, the console
 * carried no error, and the page was still wrong. Measured on the live site on
 * 2026-08-22 with a machine whose leg opened the web session two seconds after
 * the page loaded.
 *
 * The flag alone can only say "somebody has asked". What a second caller needs
 * is "somebody has asked, AND here is that answer when it lands". */
let hostTransportInFlight = null

async function hostTransport() {
  if (transport) return
  /* Awaited BEFORE the flag is consulted, and by re-askers too: a `reask` that
     cleared the flag while an ask was still running would start a second one
     against the same machine, and two handshakes racing to install a transport
     is a worse answer than waiting for the first. */
  if (hostTransportInFlight) return hostTransportInFlight
  if (hostTransportAsked) return
  hostTransportAsked = true
  const ask = globalThis.window?.mcShell?.getBridgeTransport
  if (typeof ask !== 'function') { hostTransportAsked = false; return }
  const revision = transportRevision
  const pending = (async () => {
    try {
      const offered = await ask()
      if (revision === transportRevision && typeof offered === 'function') transport = offered
    } catch { /* unavailable now; the next ordinary read may ask again */ }
  })()
  hostTransportInFlight = pending
  try {
    await pending
  } finally {
    if (hostTransportInFlight === pending) {
      hostTransportInFlight = null
      // Only a usable transport is a settled answer. Null and failures may
      // mean a transient handshake refusal or a host still becoming ready.
      if (revision === transportRevision && !transport) hostTransportAsked = false
    }
  }
}

function connectionChanged(sent) {
  return {
    ok: false,
    code: 'BRIDGE_CONNECTION_CHANGED',
    reason: sent
      ? 'The connection changed before the reply arrived. The request may have run; check its status before trying again.'
      : 'The connection changed before this request was sent. Check the selected machine before trying again.',
  }
}

async function request(pathname, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const revision = transportRevision
  await hostTransport()
  if (revision !== transportRevision) return connectionChanged(false)
  if (transport) {
    try {
      const value = await transport(pathname, { method, body, timeoutMs })
      if (revision !== transportRevision) return connectionChanged(true)
      if (!value || typeof value !== 'object') return { ok: false, reason: 'the remote machine returned nothing usable', code: 'BRIDGE_REQUEST_REFUSED' }
      return value
    } catch (error) {
      if (revision !== transportRevision) return connectionChanged(true)
      return unavailable(error)
    }
  }
  const active = await session()
  if (revision !== transportRevision) return connectionChanged(false)
  if (!active.ok) return active
  try {
    const signal = timeoutSignal(timeoutMs)
    const response = await fetch(`${active.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${active.token}`,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      cache: 'no-store',
      redirect: 'error',
      signal,
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    })
    let value
    try { value = await response.json() }
    catch {
      // A body deadline often rejects json() with AbortError; the signal
      // retains the actual TimeoutError. Neither it nor malformed JSON is
      // evidence that the bridge refused an action it may already have run.
      if (signal.aborted) throw signal.reason
      return {
        ok: false,
        reason: 'The reply could not be read. The request may have run; check its status before trying again.',
        code: 'BRIDGE_RESPONSE_UNREADABLE',
      }
    }
    if (revision !== transportRevision) return connectionChanged(true)
    if (!response.ok || value?.ok !== true) {
      if (response.status === 401) bootstrapPromise = null
      return { ok: false, reason: value?.error?.message || `action bridge refused request (${response.status})`, code: value?.error?.code || 'BRIDGE_REQUEST_REFUSED' }
    }
    return value
  } catch (error) {
    if (revision !== transportRevision) return connectionChanged(true)
    bootstrapPromise = null
    return unavailable(error)
  }
}

export function bridgeStatus() {
  return request('/v1/status', { timeoutMs: STATUS_TIMEOUT_MS })
}

// Read the authenticated action-surface contract through the SAME transport as
// real requests. A remote compatibility check must never fall back to scanning
// the visitor's localhost. This is a read, not permission to invoke an action.
export async function bridgeApiContract({ requiredActions = [] } = {}) {
  const result = await request('/v1/contract')
  if (!result.ok) return result
  const compatible = assessBridgeApiCompatibility(result.contract, { requiredActions })
  if (!compatible.ok) {
    return {
      ...compatible,
      reason: compatible.code === 'BRIDGE_API_MAJOR_UNSUPPORTED'
        ? 'This engine uses an API version this desktop does not support.'
        : compatible.code === 'BRIDGE_API_ACTION_UNAVAILABLE'
          ? 'This engine does not register all the actions required by this client.'
          : 'This engine did not provide a valid action API contract.',
    }
  }
  return { ...compatible, contract: result.contract }
}

/**
 * What the two fixed local advisory tiers can do on this machine right now,
 * with machine-readable reasons. A read like bridgeStatus(): starts no
 * inference, mutates nothing.
 *
 * ASKED ONCE PER RECHECK WINDOW WHILE THE ANSWER IS THE STRUCTURAL REFUSAL.
 * ./local-tiers-memo.js holds the measurement and the rule; the short of it is
 * that "this installation has no peer machine" is configuration, the research
 * page asks twice on every visit, and twenty-one of twenty-one calls in the
 * owner's audit ledger were that same refusal. A real reading, a timeout, a
 * transport failure and any other code are all asked again immediately.
 */
export function localTiersStatus() {
  const revision = transportRevision
  const key = answeringMachineKey()
  const remembered = localTiersMemo.read(key)
  if (remembered) return Promise.resolve(remembered)
  return request('/v1/research/local-tiers-status', { timeoutMs: STATUS_TIMEOUT_MS })
    .then(answer => {
      /* Filed against the transport in force WHEN THE ANSWER LANDED, not when
         it was asked: hostTransport() can install one lazily during the very
         first request, and filing a remote machine's refusal under 'local'
         would answer for a computer that never spoke. */
      if (revision === transportRevision) localTiersMemo.remember(answer, answeringMachineKey())
      return answer
    })
}

/** Forget the remembered tiers answer. Exported for suites; the transport seam
    calls it whenever the machine on the other end changes. */
export function forgetLocalTiersStatus() {
  localTiersMemo.forget()
}

/**
 * Read-only, public owner prompts. Secret-entry prompts are deliberately not
 * part of this renderer contract; those remain in the isolated native host.
 */
export function ownerPromptSnapshot() {
  return request('/v1/owner-prompts')
}

/** Mark a prompt presented only after the renderer has measured all evidence. */
export function markOwnerPromptPresented(promptId, evidence) {
  return postBridgeAction('owner-prompt-presented', { promptId, evidence })
}

/** Send an explicit public decision. Missing purchase lines remain omitted. */
export function decideOwnerPrompt(body) {
  return postBridgeAction('owner-prompt-decision', body)
}

/**
 * Cheap availability probe. Uses the unauthenticated, side-effect-free
 * /v1/runtime discovery endpoint (measured ~3ms) rather than /v1/status, so the
 * write surfaces can enable as soon as the bridge is genuinely reachable
 * instead of blocking on a snapshot call that parses queues and writes audit
 * receipts. Returns the same {ok,reason,code} shape as every other call here.
 */
export async function bridgeReachable() {
  if (!transport) await hostTransport()
  // With a transport installed there is no local bridge to probe: reachability
  // is the tunnel's, and asking the machine is the only honest way to know.
  if (transport) {
    const probed = await request('/v1/runtime', { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS })
    return probed?.ok === true ? { ok: true } : { ok: false, reason: probed?.reason || 'that machine is not reachable', code: probed?.code || 'BRIDGE_UNREACHABLE' }
  }
  const active = await session()
  if (!active.ok) return active
  return { ok: true, baseUrl: active.baseUrl }
}

// Per-action budgets. These are not arbitrary: `dispatch` spawns a real agent
// process (launch record, task lease, child spawn) and was measured taking
// longer than the 5s action budget, which made the UI report BRIDGE_TIMEOUT for
// a dispatch that had ALREADY SUCCEEDED server-side — a lane appeared in the
// registry, ran, and exited 0 while the operator was told it was refused.
// Misreporting a completed spawn as a failure invites a retry, and dispatch
// carries no idempotency key, so the retry would spawn a second agent.
// The cloud budgets are measured, not guessed. Each cloud call spawns the codex
// CLI once per account it has to ask about, and `cloud-accounts` asks EVERY
// configured account for its real allowance -- three accounts on the machine
// this was built on, ~4-6s each. `cloud-launch` additionally waits on a human:
// the approval prompt it raises has its own 60s policy timeout, and a budget
// shorter than that would report a timeout to the person while they were still
// reading the dialog, then invite a retry that could create a SECOND real cloud
// task. This is the same failure the dispatch budget note below records, with a
// worse blast radius, because a cloud task cannot be cancelled.
const ACTION_TIMEOUT_MS = Object.freeze({
  dispatch: 120_000, queue: 30_000, terminate: 120_000, 'ledger-archive': 120_000,
  'cloud-accounts': 120_000, 'cloud-tasks': 90_000, 'cloud-task-status': 90_000, 'cloud-launch': 240_000,
  /* Registering a mirror makes THREE network calls in series before it can
     answer: the provider environment read, an ls-remote against the mirror,
     and a dry-run push to establish write access. Each carries its own 120s
     ceiling engine-side. A budget shorter than their sum would report a
     timeout while the last one was still running and invite a retry -- and a
     retry of a registration that actually SUCCEEDED then refuses as already
     registered, which reads as a failure of the thing that just worked. */
  'cloud-mirror-list': 30_000, 'cloud-mirror-disable': 30_000, 'cloud-mirror-register': 380_000, 'cloud-mirror-publish': 600_000,
  /* Task actions pay a durable write each; role-complete runs local inference
     and is slow rather than stuck — the judge gets minutes, not seconds. */
  'task-submit': 30_000, 'task-claim': 30_000, 'task-get': 30_000, 'task-list': 30_000,
  'role-complete': 300_000,
  /* The research lifecycle spawns or exactly stops a worker process under a
     cross-process lock; every other research action is a bounded durable
     read/write on the default budget. */
  'research-lifecycle': 60_000,
})

export function postBridgeAction(action, body) {
  const pathname = ACTION_ROUTES[action]
  if (!pathname) return Promise.resolve({ ok: false, reason: 'unknown bridge action', code: 'BRIDGE_ACTION_UNKNOWN' })
  return request(pathname, { method: 'POST', body, timeoutMs: ACTION_TIMEOUT_MS[action] ?? REQUEST_TIMEOUT_MS })
}

// Audit evidence is separate from whether the requested operation succeeded.
// Only use this on the authenticated native/Engine response, alongside the
// operation's identity, currentness and completion checks.
const BASIC_FIELDS = Object.freeze({
  ok: true, disposition: 'not-required', required: false, recorded: false,
  durable: false, anchored: false, signed: false,
  sequence: null, eventId: null, eventHash: null,
})
const HASH = /^[a-f0-9]{64}$/

export function auditReceiptDisposition(value, action, target) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof action !== 'string' || !action || typeof target !== 'string' || !target) return null
    if (value.disposition === 'not-required') {
      const keys = [...Object.keys(BASIC_FIELDS), 'action', 'target']
      return Reflect.ownKeys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key))
        && Object.entries(BASIC_FIELDS).every(([key, expected]) => value[key] === expected)
        && value.action === action && value.target === target ? 'not-required' : null
    }
    // Older audited producers return only sequence/hash. A contradictory
    // policy claim cannot borrow those fields to become valid audit evidence.
    if (['ok', 'required', 'recorded', 'durable', 'anchored', 'signed'].some(key => Object.hasOwn(value, key) && value[key] !== true)
      || (Object.hasOwn(value, 'disposition') && value.disposition !== 'recorded')
      || (Object.hasOwn(value, 'action') && value.action !== action)
      || (Object.hasOwn(value, 'target') && value.target !== target)) return null
    return Number.isSafeInteger(value.sequence) && value.sequence > 0
      && typeof value.eventHash === 'string' && HASH.test(value.eventHash) ? 'recorded' : null
  } catch { return null }
}

// One admitted operation retains one audit policy through settlement.
export function validAuditReceiptPair(intent, outcome, action, intentTarget, outcomeTarget = intentTarget) {
  const before = auditReceiptDisposition(intent, `${action}.intent`, intentTarget)
  const after = auditReceiptDisposition(outcome, action, outcomeTarget)
  return Boolean(before && before === after
    && (before === 'not-required' || outcome.sequence > intent.sequence))
}

// Flat launch/termination receipts retain legacy fields only for real audit.
// A present audit slot owns the answer; invalid Basic evidence never falls
// back to a plausible sequence/hash carried beside it.
export function validOperationAuditReceipt(receipt, action, target) {
  try {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
    const hasAudit = Object.hasOwn(receipt, 'audit')
    const hasSequence = Object.hasOwn(receipt, 'auditSequence')
    const hasHash = Object.hasOwn(receipt, 'auditEventHash')
    const proof = hasAudit ? receipt.audit : { sequence: receipt.auditSequence, eventHash: receipt.auditEventHash }
    const disposition = auditReceiptDisposition(proof, action, target)
    if (disposition === 'not-required') return !hasSequence && !hasHash
    if (disposition !== 'recorded') return false
    return !hasAudit || (!hasSequence && !hasHash)
      || (hasSequence && hasHash && receipt.auditSequence === proof.sequence && receipt.auditEventHash === proof.eventHash)
  } catch { return false }
}

/* The canonical ledger's id grammar (engine src/lib/request-id.js, family R):
   a root R1..R9999 and dotted refinements of any depth (R5.1, R5.1.2). */
const ARCHIVE_REQUEST_ID_RE = /^R(?:0\d|[1-9]\d{0,3})(?:\.[1-9]\d*)*$/

/* THE RECEIPT SHAPE IS THE ENGINE'S, READ OFF THE ENGINE. Before this was
   rewritten the verifier below demanded candidates as {id, reasonCode,
   reason:string} and a movedIds/movedCount pair -- a shape
   capability/src/lib/mission-bridge/actions.js never produces.
   normalizedLedgerArchiveResult there (the one source of every receipt)
   freezes candidates as {targetKind:'request', requestId, reason:{code,
   detail, supersedingRequestIds}} beside `restorables`, `appliedTarget` and
   `changedCount`, and the action spreads exactly that into the receipt. So
   every real preview failed verification here and "Preview cleanup" refused
   with BRIDGE_LEDGER_ARCHIVE_PREVIEW_INVALID before any confirm -- the row's
   only control never once worked, and the refusal it printed blamed a receipt
   that was in fact well-formed. Each check below mirrors the engine's own
   normaliser line for line, so the two cannot drift apart without one of them
   being edited in plain sight. */
function validArchiveTarget(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).every(key => ['targetKind', 'requestId', 'ruleKey'].includes(key))
    && ['targetKind', 'requestId'].every(key => Object.hasOwn(value, key))
    && ['request', 'rule'].includes(value.targetKind)
    && ARCHIVE_REQUEST_ID_RE.test(String(value.requestId || ''))
    && (value.targetKind === 'request'
      ? !Object.hasOwn(value, 'ruleKey')
      : typeof value.ruleKey === 'string' && value.ruleKey.length > 0 && value.ruleKey.length <= 200)
}

function sameArchiveTarget(left, right) {
  if (!validArchiveTarget(left) || !validArchiveTarget(right)) return false
  return left.targetKind === right.targetKind && left.requestId === right.requestId
    && (left.targetKind === 'request' || left.ruleKey === right.ruleKey)
}

function validArchiveCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).some(key => !['targetKind', 'requestId', 'reason'].includes(key))
      || !['targetKind', 'requestId', 'reason'].every(key => Object.hasOwn(value, key))
      || value.targetKind !== 'request'
      || !ARCHIVE_REQUEST_ID_RE.test(String(value.requestId || ''))) return false
  const reason = value.reason
  if (!reason || typeof reason !== 'object' || Array.isArray(reason)
      || Reflect.ownKeys(reason).some(key => !['code', 'detail', 'supersedingRequestIds'].includes(key))
      || !['code', 'detail', 'supersedingRequestIds'].every(key => Object.hasOwn(reason, key))
      || !['completed', 'fully-superseded'].includes(reason.code)
      || typeof reason.detail !== 'string' || reason.detail.length === 0 || reason.detail.length > 300
      || /[\r\n]/.test(reason.detail)) return false
  const superseding = reason.supersedingRequestIds
  return Array.isArray(superseding)
    && new Set(superseding).size === superseding.length
    && superseding.every(id => ARCHIVE_REQUEST_ID_RE.test(String(id || '')))
    && ((reason.code === 'fully-superseded') === (superseding.length > 0))
}

/**
 * Validate the bounded canonical archive receipt before the UI reports a move.
 *
 * A dry run carries no applied target and changed nothing; a confirmation
 * carries exactly the one target it was sent, changed exactly one thing, and
 * has the intent receipt a real write is always preceded by.
 */
export function verifiedLedgerArchiveReceipt(result, dryRun, target = null) {
  const receipt = result?.receipt
  if (result?.ok !== true
      || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.action !== 'ledger-archive'
      || receipt.dryRun !== dryRun
      || !canonicalIso(receipt.at)
      || !/^[a-f0-9]{64}$/.test(String(receipt.planSha256 || ''))
      || !Array.isArray(receipt.candidates) || !receipt.candidates.every(validArchiveCandidate)
      || new Set(receipt.candidates.map(candidate => candidate.requestId)).size !== receipt.candidates.length
      || !Array.isArray(receipt.restorables) || !receipt.restorables.every(validArchiveTarget)
      || new Set(receipt.restorables.map(item => JSON.stringify(item))).size !== receipt.restorables.length
      || !Array.isArray(receipt.inconsistencies)
      || !receipt.inconsistencies.every(issue => issue && typeof issue === 'object' && !Array.isArray(issue)
        && Reflect.ownKeys(issue).length === 3
        && ['id', 'code', 'reason'].every(key => Object.hasOwn(issue, key))
        && ARCHIVE_REQUEST_ID_RE.test(String(issue.id || ''))
        && issue.code === 'DONE_WITH_UNMET_GATE'
        && typeof issue.reason === 'string' && issue.reason.length > 0 && issue.reason.length <= 300)
      || !Number.isSafeInteger(receipt.activeCount) || receipt.activeCount < 0
      || !Number.isSafeInteger(receipt.archiveCount) || receipt.archiveCount < 0
      || !Number.isSafeInteger(receipt.changedCount) || receipt.changedCount < 0
      || !Object.hasOwn(receipt, 'appliedTarget')
      || !auditReceiptDisposition(receipt.audit, `owner.request.ledger.archive${dryRun ? '.preview' : ''}`, 'OWNER-REQUEST-LEDGER')) return false
  if (dryRun) return receipt.appliedTarget === null && receipt.changedCount === 0
  return receipt.changedCount === 1
    && sameArchiveTarget(receipt.appliedTarget, target)
    && validAuditReceiptPair(receipt.intentAudit, receipt.audit, 'owner.request.ledger.archive', 'OWNER-REQUEST-LEDGER')
}

/* `code` is the MACHINE channel and is the reason the identifier can leave the
   sentence without leaving the product: a support conversation, a driver and
   `markRefusalCode()` all still name the exact refusal. It is absent rather than
   empty on the paths that did not refuse — `code: ''` reads as "there is a code
   and it is blank", which is the absence-as-value mistake this codebase keeps
   making and which a probe asserting on presence would pass on. */
export function bridgeControlState(phase, enabled, label, note, message, code = null) {
  sharedControlState({ enabled, why: message })
  return Object.freeze(code ? { phase, enabled, label, note, message, code } : { phase, enabled, label, note, message })
}

function archivePreviewMessage(receipt) {
  const candidates = receipt.candidates.map(candidate => `${candidate.requestId} - ${candidate.reason.detail}`).join('; ')
  const issues = receipt.inconsistencies.map(issue => `${issue.id} - ${issue.reason}`).join('; ')
  return [
    candidates ? `Preview: ${candidates}.` : 'Preview: no requests currently qualify.',
    issues ? ` Retained inconsistencies: ${issues}.` : '',
  ].join('')
}

/**
 * Two-step owner control: the first click performs a real dry-run and renders
 * every candidate; only the second click submits {dryRun:false}. Any uncertain
 * response returns to preview instead of silently retrying a move.
 */
export function createLedgerArchiveController({
  postAction = postBridgeAction,
  onState = () => {},
} = {}) {
  let destroyed = false
  let preview = null
  /* A MOVE THIS CONTROL ALREADY MADE AND NEVER GOT TO REPORT. Read at
     construction, not at render, so the first state this controller ever
     publishes already carries it — a surface that painted the ordinary idle
     sentence first and corrected itself afterwards would show "nothing has
     happened" about a move that did. */
  const missedArchive = undeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE)
  let state = missedArchive
    ? bridgeControlState(
      'idle',
      true,
      'Preview cleanup',
      'Result you did not see',
      restatedMessage(missedArchive),
    )
    : bridgeControlState(
      'idle',
      true,
      'Preview cleanup',
      'Owner-gated',
      'Preview completed or fully superseded R requests. Nothing moves on the first click.',
    )
  const publish = next => {
    state = next
    if (!destroyed) onState(state)
  }
  publish(state)

  /* EVERY SETTLED BRANCH OF A REAL MOVE GOES THROUGH HERE, and the order of the
     two lines below is the whole repair: the outcome is filed BEFORE this asks
     whether its own screen survived. Both branches matter — "archived" and "not
     confirmed" vanished together before, and vanishing reads as the reassuring
     one. The dry run does not come through here: a preview moved nothing, so
     there is nothing to carry. */
  const settleMove = (next, tone) => {
    publish(next)
    if (destroyed) recordUndeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE, { tone, message: next.message })
    else clearUndeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE)
    return state
  }

  const runPreview = async () => {
    preview = null
    publish(bridgeControlState(
      'pending-preview', false, 'Previewing', 'Dry run',
      'Computing the exact archive set. Nothing has moved.',
    ))
    let result
    /* `operation` IS REQUIRED AND WAS NEVER SENT. capability/src/lib/mission-bridge/actions.js
       opens ledgerArchive with exact(input, [...], ['operation','dryRun']) and
       refuses anything missing it as BRIDGE_INPUT_INVALID -- whose shared
       sentence is "Correct what you typed above and try again", printed under a
       row that has no input on it at all. So the row's only control refused
       every press it ever received, blamed the person for a typing mistake they
       could not have made, and then relabelled itself to invite the same dead
       press again. Archive is the only operation this control offers; restore
       has no surface here and is not implied by naming this one. */
    try { result = await postAction('ledger-archive', { operation: 'archive', dryRun: true }) }
    catch (error) {
      result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'preview failed' }
    }
    if (destroyed) return state
    if (!verifiedLedgerArchiveReceipt(result, true)) {
      /* A reply this control could not verify carries no code of its own, so the
         code is RESOLVED before the sentence is composed rather than after: an
         unresolved code falls to the generic remedy ("try once more"), which is
         the wrong advice about a two-step owner-gated move. */
      const code = refusalCodeOf(result) || 'BRIDGE_LEDGER_ARCHIVE_PREVIEW_INVALID'
      /* THE REMEDY IS WRITTEN HERE BECAUSE THIS ROW HAS NO INPUT. The shared
         table's sentence for a malformed request is "Correct what you typed
         above and try again", which is sound advice everywhere except under a
         control that is a single button with no field anywhere near it. A
         person told to correct their typing on a row with nothing to type in
         concludes the product is broken, and they are not wrong. */
      publish(bridgeControlState(
        'idle', true, 'Preview again', 'No move confirmed',
        `Nothing moved. ${refusalSentence({ code, reason: result?.reason }, {
          fallback: 'The preview receipt was incomplete.',
          remedy: 'Nothing on this row was typed and nothing was changed. Press Preview again; if it keeps refusing, the ledger this reads is not answering and there is nothing here for you to correct.',
        })}`,
        code,
      ))
      return state
    }
    preview = result.receipt
    const message = archivePreviewMessage(preview)
    if (preview.candidates.length === 0) {
      publish(bridgeControlState('idle', true, 'Preview again', 'Nothing eligible', `${message} Nothing moved.`))
      return state
    }
    publish(bridgeControlState(
      'confirm', true,
      `Archive ${preview.candidates.length} request${preview.candidates.length === 1 ? '' : 's'}`,
      'Select again to confirm',
      `${message} Select again to move exactly this preview.`,
    ))
    return state
  }

  /* ONE TARGET PER CONFIRMATION, BECAUSE THAT IS THE ONLY CONFIRMATION THE
     ENGINE ACCEPTS. actions.js refuses {dryRun:false} with no target as
     BRIDGE_LEDGER_ARCHIVE_CONFIRMATION_REQUIRED (409), and its admitted
     preview is keyed to the target too: each confirm must follow its own
     dry-run for that exact target. So the confirm press walks the submitted
     preview's candidates one at a time -- dry-run with target, check the
     candidate list still equals what the person read, confirm with target,
     verify -- and reports which were archived and which were left where they
     were, with the engine's own reason for each.

     The list is compared, NOT planSha256: the plan hash covers the overlay
     (every archive appends to it) and the `restorables` list grows by one
     with each success, so after the first archive the hash can never match
     the preview that was read. The candidates are what the person looked at
     and agreed to; that is the thing held constant. */
  const execute = async () => {
    const submittedPreview = preview
    preview = null
    const candidates = Array.isArray(submittedPreview?.candidates) ? submittedPreview.candidates : []
    if (candidates.length === 0) {
      /* Refused locally: nothing to send, so nothing is sent. */
      publish(bridgeControlState('idle', true, 'Preview cleanup', 'Nothing eligible',
        'Nothing moved: the preview had no requests to archive. Press Preview cleanup to read the current list.'))
      return state
    }
    const archived = []
    const refused = []
    const post = async (body, failReason) => {
      try { return await postAction('ledger-archive', body) }
      catch (error) { return { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || failReason } }
    }
    for (const [index, candidate] of candidates.entries()) {
      const target = { targetKind: 'request', requestId: candidate.requestId }
      publish(bridgeControlState(
        'pending-move', false, 'Archiving', 'Pending',
        `Archiving ${candidate.requestId} (${index + 1} of ${candidates.length}). ${archived.length ? `Archived so far: ${archived.join(', ')}. ` : ''}No further move has been confirmed.`,
      ))
      /* (a) the per-target dry run the engine's confirm is keyed to */
      const rehearsal = await post({ operation: 'archive', dryRun: true, target }, 'preview failed')
      if (!verifiedLedgerArchiveReceipt(rehearsal, true)
          || JSON.stringify(rehearsal.receipt.candidates) !== JSON.stringify(candidates)) {
        const code = refusalCodeOf(rehearsal) || 'BRIDGE_LEDGER_ARCHIVE_PREVIEW_CHANGED'
        refused.push({ id: candidate.requestId, code, sentence: refusalSentence(
          { code, reason: rehearsal?.reason },
          { fallback: 'the list of requests that qualify changed after you read it' },
        ) })
        continue
      }
      /* (b) the confirmation, always with its target */
      const result = await post({ operation: 'archive', dryRun: false, target }, 'archive request failed')
      if (!verifiedLedgerArchiveReceipt(result, false, target)) {
        const code = refusalCodeOf(result) || 'BRIDGE_LEDGER_ARCHIVE_RECEIPT_INVALID'
        refused.push({ id: candidate.requestId, code, sentence: refusalSentence(
          { code, reason: result?.reason },
          { fallback: 'the archive result did not match the request that was confirmed' },
        ) })
        continue
      }
      archived.push(candidate.requestId)
    }
    /* THERE IS NO `if (destroyed) return` ABOVE, and its absence is the fix.
       This is the real move: by the time this line runs, requests have either
       changed the durable overlay or they have not, and which of the two it
       was is the only thing the person needs. settleMove files the outcome
       before asking whether its own screen survived. */
    const left = refused.map(entry => `${entry.id} was not archived: ${entry.sentence}`).join(' ')
    if (archived.length === 0) {
      return settleMove(bridgeControlState(
        'idle', true, 'Preview current state', 'No move confirmed',
        `Nothing was archived. ${left} Preview again before any retry, and read that preview before confirming it.`,
        refused[0]?.code || 'BRIDGE_LEDGER_ARCHIVE_RECEIPT_INVALID',
      ), 'refused')
    }
    /* WHAT "ARCHIVED" MEANS, SAID PLAINLY. capability/tools/ledger-archive.js
       retires a request to COOLING, not out of the list: it stays in every
       projected register until COLD_EXPOSURE_QUORUM (3) separate sessions
       have seen it without objection, and this page's list is a generated
       projection that changes only when it is next generated. A sentence
       that said "moved out of the list" would be contradicted by the very
       next load. */
    return settleMove(bridgeControlState(
      'success', true, 'Preview cleanup', refused.length ? 'Archived, with exceptions' : 'Archived',
      `Archived ${archived.join(', ')}. ${left ? `${left} ` : ''}Each is recorded as finished and cooling. It stays on every list for now, including this one, until three separate sessions have seen it without objection. This page's list changes only when its data is next generated.`,
    ), 'confirmed')
  }

  return Object.freeze({
    click() {
      if (destroyed || state.phase.startsWith('pending')) return Promise.resolve(state)
      if (state.phase === 'confirm' && preview) return execute()
      return runPreview()
    },
    destroy() { destroyed = true },
    getState() { return state },
  })
}

const TERMINAL_AGENT_STATUSES = new Set(['finished', 'failed'])
const SAME_INTENT_RETRY_CODES = new Set([
  'BRIDGE_BOOTSTRAP_REFUSED',
  'BRIDGE_DISCOVERY_UNAVAILABLE',
  'BRIDGE_REQUEST_FAILED',
  'BRIDGE_REQUEST_REFUSED',
  'BRIDGE_TERMINATE_AUDIT_UNAVAILABLE',
  'BRIDGE_TERMINATE_IN_PROGRESS',
  'BRIDGE_TIMEOUT',
  'BRIDGE_UNREACHABLE',
])

function exactNonEmptyId(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

/**
 * Decide whether the selected declared agent has a real, exact process target.
 * This deliberately consumes only the projection's controlTarget; it never
 * manufactures one from a declared enabled flag, a route id, or an observed
 * session.
 */
export function terminateTargetAvailability({ live, selectedAgentId, controlTarget }) {
  if (!live) {
    return Object.freeze({
      enabled: false,
      reason: 'Terminate unavailable in simulated mode; no live bridge request will be sent.',
    })
  }
  if (!controlTarget || typeof controlTarget !== 'object' || Array.isArray(controlTarget)) {
    return Object.freeze({
      enabled: false,
      reason: 'Terminate unavailable: no observed control target is mapped to this declared agent.',
    })
  }
  if (!exactNonEmptyId(controlTarget.agentId) || !exactNonEmptyId(controlTarget.runId)) {
    return Object.freeze({
      enabled: false,
      reason: 'Terminate unavailable: the observed control target has no exact agent and run ids.',
    })
  }
  if (controlTarget.agentId !== selectedAgentId) {
    return Object.freeze({
      enabled: false,
      reason: 'Terminate unavailable: the observed control target does not match this declared agent.',
    })
  }
  if (controlTarget.status !== 'running') {
    return Object.freeze({
      enabled: false,
      reason: `Terminate unavailable: observed control target status is ${String(controlTarget.status || 'unknown')}, not running.`,
    })
  }
  if (!Number.isSafeInteger(controlTarget.pid) || controlTarget.pid <= 0) {
    return Object.freeze({
      enabled: false,
      reason: 'Terminate unavailable: the observed control target has no positive integer PID.',
    })
  }
  return Object.freeze({
    enabled: true,
    reason: `Terminate available for observed run ${controlTarget.runId} (PID ${controlTarget.pid}). Select once to review.`,
  })
}

/** Validate the full durable bridge receipt before the UI may claim success. */
export function verifiedTerminateReceipt(result, requestBody) {
  const receipt = result?.receipt
  return result?.ok === true
    && receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && receipt.action === 'terminate'
    && receipt.idempotencyKey === requestBody?.idempotencyKey
    && receipt.agentId === requestBody?.agentId
    && receipt.runId === requestBody?.expectedRunId
    && receipt.pid === requestBody?.expectedPid
    && receipt.verifiedGone === true
    && TERMINAL_AGENT_STATUSES.has(receipt.terminalStatus)
    && Number.isSafeInteger(receipt.exitCode)
    && canonicalIso(receipt.verifiedGoneAt)
    && Number.isSafeInteger(receipt.terminalAt) && receipt.terminalAt > 0
    && validOperationAuditReceipt(receipt, 'mission.bridge.terminate.completed', requestBody.idempotencyKey)
}

function freshTerminateIdempotencyKey() {
  const key = globalThis.crypto?.randomUUID?.()
  if (!exactNonEmptyId(key)) throw new Error('secure idempotency key generation is unavailable')
  return key
}

/* `code` is the machine channel — see bridgeControlState above for why it is
   absent rather than blank on the paths that did not refuse. A refusal that
   loses its code is a real defect: it is what a support conversation and
   tools/test/terminate-ui.test.mjs name the exact refusal by. */
/**
 * DOM-independent two-step controller used by the agent view and its focused
 * deterministic probe. An uncertain response retries the exact same request
 * body and idempotency key; a typed target refusal disables the stale control.
 */
export function createTerminateController({
  live,
  selectedAgentId,
  controlTarget,
  postAction = postBridgeAction,
  createIdempotencyKey = freshTerminateIdempotencyKey,
  onState = () => {},
} = {}) {
  const availability = terminateTargetAvailability({ live, selectedAgentId, controlTarget })
  let destroyed = false
  let requestBody = null
  let state = bridgeControlState(
    availability.enabled ? 'idle' : 'unavailable',
    availability.enabled,
    'Terminate',
    availability.enabled ? 'Available' : 'Unavailable',
    availability.reason,
  )

  const publish = (next) => {
    state = next
    if (!destroyed) onState(state)
  }
  publish(state)

  const submit = async () => {
    const submittedBody = requestBody
    publish(bridgeControlState(
      'pending',
      false,
      'Terminating',
      'Pending',
      'Terminate request pending. No stop has been confirmed.',
    ))

    let result
    try {
      result = await postAction('terminate', submittedBody)
    } catch (error) {
      result = {
        ok: false,
        code: 'BRIDGE_REQUEST_FAILED',
        reason: error?.message || 'terminate request failed',
      }
    }
    if (destroyed || requestBody !== submittedBody) return state

    if (verifiedTerminateReceipt(result, submittedBody)) {
      const receipt = result.receipt
      publish(bridgeControlState(
        'success',
        false,
        'Terminated',
        'Verified',
        `Termination verified: run ${receipt.runId} is ${receipt.terminalStatus} with exit ${receipt.exitCode}, and PID ${receipt.pid} is gone.`,
      ))
      return state
    }

    const responseWasShapedSuccess = result?.ok === true
    const code = responseWasShapedSuccess
      ? 'BRIDGE_TERMINATE_RECEIPT_INVALID'
      : (typeof result?.code === 'string' ? result.code : 'BRIDGE_REQUEST_FAILED')
    const reason = responseWasShapedSuccess
      ? 'The terminate response was incomplete or did not match the requested agent, run, and PID.'
      : (result?.reason || 'The terminate request failed without a verified receipt.')
    const retrySameIntent = responseWasShapedSuccess || SAME_INTENT_RETRY_CODES.has(code)
    /* The engine's own sentence survives verbatim as the diagnosis; the remedy
       is this control's, because only this control knows whether the retry it is
       about to offer reuses the same request. "No stop has been confirmed" leads
       both, and it is the half a person acts on: a stop that half-worked and a
       stop that did nothing look the same from here. */
    publish(bridgeControlState(
      retrySameIntent ? 'retry' : 'refused',
      retrySameIntent,
      retrySameIntent ? 'Retry terminate' : 'Terminate',
      retrySameIntent ? 'Same intent' : 'Unavailable',
      refusalSentence({ code, reason }, {
        remedy: retrySameIntent
          ? 'No stop has been confirmed. Retry sends exactly the same request rather than a second one, so pressing it cannot stop anything twice.'
          : 'No stop has been confirmed. Refresh this page and look at whether it is still running before pressing stop again.',
      }),
      code,
    ))
    return state
  }

  return Object.freeze({
    click() {
      if (destroyed || !state.enabled || state.phase === 'pending' || state.phase === 'success') {
        return Promise.resolve(state)
      }
      if (state.phase === 'idle') {
        publish(bridgeControlState(
          'confirm',
          true,
          'Confirm terminate?',
          'Select again',
          `Terminate agent ${controlTarget.agentId}, run ${controlTarget.runId}, PID ${controlTarget.pid}? Select again to confirm.`,
        ))
        return Promise.resolve(state)
      }
      if (state.phase === 'confirm') {
        let idempotencyKey
        try { idempotencyKey = createIdempotencyKey() }
        catch (error) {
          /* Written as a LITERAL identifier rather than interpolated, which is
             why the `${...code...}` scan in tools/test/refusal-copy.test.mjs
             never saw it. It is the same defect: an identifier in front of a
             person. The code stays, on the state, where a driver can read it. */
          publish(bridgeControlState(
            'idle',
            true,
            'Terminate',
            'Available',
            refusalSentence(
              { code: 'BRIDGE_IDEMPOTENCY_UNAVAILABLE', reason: error?.message },
              {
                fallback: 'A fresh one-time request key could not be created.',
                remedy: 'No request was sent and nothing has been stopped. Close ToolsEnabled and open it again before pressing stop a second time.',
              },
            ),
            'BRIDGE_IDEMPOTENCY_UNAVAILABLE',
          ))
          return Promise.resolve(state)
        }
        requestBody = Object.freeze({
          idempotencyKey,
          agentId: controlTarget.agentId,
          expectedRunId: controlTarget.runId,
          expectedPid: controlTarget.pid,
        })
      }
      return submit()
    },
    destroy() { destroyed = true },
    getState() { return state },
  })
}

/**
 * The research page-open read: projects with their experiments, session
 * assignments, the settings-gate decisions and worker lifecycle in one call.
 * Same {ok,reason,code} refusal shape as every action here.
 */
export function researchSnapshot() {
  return postBridgeAction('research-snapshot', {})
}

export function resetBridgeSession() {
  // The transport is deliberately NOT cleared here: a session reset means "get
  // a fresh bearer for the local bridge", and in a browser there is no bearer
  // to refresh. Clearing it would silently drop the tunnel and send every
  // subsequent call at a loopback address that does not exist in a browser.
  bootstrapPromise = null
}
