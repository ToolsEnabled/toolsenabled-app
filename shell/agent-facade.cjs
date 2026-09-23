/* THE AGENT FACADE -- the loopback HTTP door the relay child knocks on.
 *
 * docs/relay-agent-facade-DESIGN.md (§2) commits the shell to serving the
 * agent and organisation surface to ONE non-browser caller: the relay child,
 * which forwards a signed-in browser's commands off the sealed tunnel. This
 * module is that door and nothing more. Every command is decided by the
 * shared surface (shell/agent-command-surface.cjs) -- the same bodies, the
 * same bounds, the same refusals the window gets -- under a RELAY principal
 * whose mayWrite comes from the caller per request: the owner's web-drive
 * switch, set in the connect section of Settings on this machine and read
 * from shell/renderer-prefs.cjs per command. Its default is OFF, so until it
 * is turned on every write through this door is refused
 * MC_AGENT_PRINCIPAL_READ_ONLY. That is correct and expected, not a defect,
 * and there is no route through this door that can move the switch.
 *
 * SERVER RULES (design §2.3), each one load-bearing:
 *
 *   - Binds 127.0.0.1 only, port 0. No runtime file, no discovery route, no
 *     port range: the shell hands the exact origin and a per-listen() 32-byte
 *     bearer to the one legitimate caller at spawn time. A squatter cannot
 *     race onto a port nobody looks for.
 *   - Any request carrying an Origin header is refused 403
 *     AGENT_FACADE_NO_BROWSERS, BEFORE auth. No browser is ever a legitimate
 *     caller, so unlike the mission bridge there is no CORS surface at all.
 *   - Every route requires `authorization: Bearer <token>`, compared with
 *     crypto.timingSafeEqual on equal-length buffers; a length mismatch is a
 *     plain refusal, not a timing oracle. 401 AGENT_FACADE_UNAUTHORIZED.
 *   - JSON only. Request bodies are bounded at 64 KB; an oversize body is
 *     answered 413 AGENT_FACADE_BODY_TOO_LARGE and the socket is DESTROYED
 *     rather than drained -- the facade does not read bytes it has already
 *     refused. Unknown route 404 AGENT_FACADE_UNKNOWN_ROUTE (after auth, so
 *     an unauthenticated caller cannot probe the table); wrong verb 405.
 *   - THE CODE IS THE MESSAGE. Errors cross as status +
 *     {ok:false,error:{code}} -- the same renderer-safe discipline as
 *     rendererSafeAgentError in main.cjs: no path, no stack, no internal
 *     prose. A surface throw whose code (or whose message, which
 *     rendererSafeAgentError makes the code) is a bounded identifier becomes
 *     that identifier; anything else becomes AGENT_FACADE_INTERNAL and the
 *     real error goes to `log`, never to the wire.
 *   - Handlers that RETURN {ok:false,...} (the org record's refusals,
 *     availability, the degraded message reader) pass through as HTTP 200
 *     with the body verbatim -- exactly the IPC semantics (design §3
 *     preamble): resolve what the handler returned, refuse what it threw.
 *   - Responses are bounded at 96 KB serialized (design §6.4) -- well under
 *     the tunnel's 128 KB frame cap, so an honest `truncated:true` reaches
 *     the browser instead of a TUNNEL_RESPONSE_TOO_LARGE mystery.
 *
 * WHAT IS DELIBERATELY NOT ROUTED. The three dialog commands --
 * agent:pick-attachment, agent:pick-mention, agent:profile-create -- have no
 * route: a request to their would-be paths is a 404 exactly like any unknown
 * route, and behind that first lock the surface's own
 * MC_AGENT_DIALOG_REQUIRES_WINDOW is the second. The dialogs are consent
 * boundaries a person crosses AT the machine; remotely there is nobody in
 * front of the screen. `send` is routed but the facade's documented request
 * shape never offers `images` -- the image fence in the surface refuses any
 * path the session's own picker did not issue, and no remote picker exists.
 * Construction fails closed if the surface's command inventory and this
 * route table ever disagree (a command with no facade decision is a build
 * error, not a silent omission -- design §10's parity gate, live).
 *
 * THE EVENT RING (design §6.1). The facade object exposes emit(packet);
 * main.cjs routes relay-owned sessions' event packets here, verbatim
 * ({sessionId, event}), each stamped with a monotonically increasing seq.
 * The ring holds at most RING_SIZE = 2048 packets AND MAX_RING_BYTES bytes.
 * The count is the design's own figure, chosen against the streaming case: a
 * busy turn emits small token deltas continuously, and at the binding's
 * long-poll cadence the buffer must hold at least one full poll window plus
 * reconnect headroom. The byte ceiling is equally load-bearing: each legal
 * packet may be almost the 96 KB response limit, so a count-only ring could
 * retain about 192 MB while claiming to be a few MB. GET
 * /v1/agent/events?after=&sessionId=&waitMs=
 * answers {ok, seq, events:[{seq,packet}], dropped}; `dropped` is TRUE when
 * the caller's `after` has fallen off the ring (or names a seq this boot
 * never issued) -- honesty over silence: the binding resynchronizes instead
 * of splicing a gap it cannot see. waitMs long-polls, capped at 25 s.
 *
 * NEVER any electron import here -- node builtins only. The facade must be
 * constructible and testable outside the shell, and everything it may touch
 * arrives injected: the surface, the principal, the log. */
'use strict'

const http = require('node:http')
const crypto = require('node:crypto')

/* Request bodies: 64 KB, well under the tunnel's 128 KB frame cap. */
const MAX_BODY_BYTES = 64 * 1024
/* Serialized responses: 96 KB (design §6.4) -- the tunnel's cap is a hard
   refusal, not a truncation, so the facade clips honestly below it. */
const MAX_RESPONSE_BYTES = 96 * 1024
/* Large read-only snapshots travel in bounded UTF-8 byte chunks without
   dropping permissions, tree hierarchy or context, or increasing the relay
   frame limit. Org continuations recheck the full hash. Active desktop trees
   use the bounded native read lease below so a transfer can finish while the
   saved tree changes. */
const SNAPSHOT_CHUNK_BYTES = 64 * 1024
const MAX_ORG_SNAPSHOT_BYTES = 4 * 1024 * 1024
/* Native renderer preferences permit a 64 MiB UTF-8 record. The desktop tree
   export adds bounded session metadata; allow that complete record plus 1 MiB
   of envelope headroom without treating the 32 MiB character cap as bytes. */
const MAX_DESKTOP_TREE_SNAPSHOT_BYTES = 65 * 1024 * 1024
/* Up to 1040 pages each recheck the native claim. Windows vault status may
   require a process read per page; reserve a fixed 30-minute transfer window
   rather than a five-minute window a large valid tree cannot finish within.
   Reads never extend this bound, and every page still checks revocation. */
const DESKTOP_TREE_SNAPSHOT_TTL_MS = 30 * 60 * 1000
/* The event ring. See the header for why 2048. */
const RING_SIZE = 2048
/* Keep the ordinary 2,048 small deltas, but never let a run of individually
   legal near-response-sized events turn the main process into an unbounded
   buffer. 4 KiB per count slot gives 8 MiB of reconnect history; eviction is
   already represented honestly by dropped:true. */
const MAX_RING_BYTES = RING_SIZE * 4096
/* Long-poll ceiling. The design (§6.1) sketched 20 s; the build contract for
   this module says 25 s, still safely under the web client's 60 s request
   default, and the ceiling is what matters -- the binding chooses its own
   cadence below it. */
const MAX_WAIT_MS = 25_000
const TOKEN_BYTES = 32

/* An error code as this product writes them: a bounded identifier from a
   closed vocabulary. Anything that does not match is internal prose and
   stays on this machine. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,127}$/

/* Commands reserved for the local window. The dialog and paste commands
   require a person's gesture at this window; bounded-work receipts require
   the exact local window that started the work. They are absent
   from the route table below, and construction checks the lists agree.

   THE CATEGORY WIDENED, RATHER THAN THE NEW COMMAND BENDING TO FIT IT. Until
   agent:paste-attachment there were exactly three members and all three were
   native dialogs, so this comment said "a native dialog at this keyboard" --
   a true description of the membership, but narrower than the REASON for it.
   A pasted image opens no dialog: its bytes are read by the renderer off its
   own paste event, and the surface refuses it unless the caller is this
   window (windowOnly, the MC_AGENT_PASTE_REQUIRES_WINDOW refusal). That is
   the same trust the three dialogs rest on, arriving by a different gesture.

   Routing it instead, to keep the membership at three, was the available
   alternative and it is the wrong one: the facade would publish a relay
   endpoint that windowOnly() refuses by construction on every call -- a door
   that exists and can never open. A command no remote caller can legitimately
   reach belongs off the route table, which is what this list is for. The
   parity gate is unchanged and still binds this command: routed or
   REMOTE_OMITTED, never both, never neither, each exactly once. */
const REMOTE_OMITTED = Object.freeze([
  // Native provider controls, automatic recovery and image custody have no
  // relay request contract. Keep these explicit until one is qualified.
  'agent:switch',
  'agent:send-automatic',
  'agent:owner-context',
  'agent:image-queue',
  'agent:modes',
  'agent:mode',
  'agent:pick-attachment',
  'agent:pick-mention',
  'agent:profile-create',
  'agent:paste-attachment',
  // Direct-link editing and its saved selection list belong to the native tree workspace.
  'agent:tree-links',
  'agent:tree-link',
  // Saved continuation recovery and Stop are owned by the exact native window.
  'agent:continuations',
  // Bounded tree starts require the local owning window. Their retained
  // receipts remain bound to that exact window and principal kind, including
  // after cleanup, so no relay caller can own a work-status receipt.
  'agent:work-status',
  /* Reconnecting a reloaded page to the host process it already owns. The
     answer is about THIS window's own live session map, and a relay caller
     has no such map to repair, so it is omitted rather than routed. */
  'agent:session-activity',
  // Whole-category resets require confirmation in the owning native window.
  'agent:ledger-reset-preview',
  'agent:ledger-reset-confirm',
  // Explicit Ledger adoption is available only in the native person window.
  'agent:ledger-custody-preview',
  'agent:ledger-custody-confirm',
])

/* THE ROUTE TABLE (design §3 and §4). Route -> verb + surface command.
   `query` names the only query parameters a GET route accepts and how each
   is read ('int' | 'string'); anything else in the query string refuses
   AGENT_FACADE_BAD_QUERY -- the same refuse-unknown-keys doctrine
   agentPayload applies to bodies. `dropPathFields` marks the org reads whose
   IPC answer carries `overlayFile`, an absolute machine path that must never
   reach a browser on someone else's computer (design §0.4, §4.1): the facade
   drops it. `facade` marks the two routes this module answers itself. */
const ROUTES = Object.freeze({
  '/v1/agent/account-setting': Object.freeze({ method: 'GET', facade: 'account-settings', setting: 'get', query: Object.freeze({ key: 'string', expectedAccountId: 'string' }) }),
  '/v1/agent/account-setting-put': Object.freeze({ method: 'POST', facade: 'account-settings', setting: 'put' }),
  '/v1/agent/voice/targets': Object.freeze({ method: 'POST', facade: 'voice', voice: 'targets' }),
  '/v1/agent/voice/start': Object.freeze({ method: 'POST', facade: 'voice', voice: 'start' }),
  '/v1/agent/voice/poll': Object.freeze({ method: 'POST', facade: 'voice', voice: 'poll' }),
  '/v1/agent/voice/offer': Object.freeze({ method: 'POST', facade: 'voice', voice: 'offer' }),
  '/v1/agent/voice/reply': Object.freeze({ method: 'POST', facade: 'voice', voice: 'reply' }),
  '/v1/agent/voice/interrupt': Object.freeze({ method: 'POST', facade: 'voice', voice: 'interrupt' }),
  '/v1/agent/voice/stop': Object.freeze({ method: 'POST', facade: 'voice', voice: 'stop' }),
  '/v1/agent/availability': Object.freeze({ method: 'GET', command: 'agent:availability' }),
  '/v1/agent/confinement': Object.freeze({ method: 'GET', command: 'agent:confinement' }),
  '/v1/agent/tools': Object.freeze({ method: 'GET', command: 'agent:tools' }),
  '/v1/agent/startable-tiers': Object.freeze({ method: 'GET', command: 'agent:startable-tiers' }),
  /* WHICH ACCOUNT EACH RUNNING AGENT IS ON. Served, and the reason it is not
     an omission: the relay principal IS the signed-in person watching their own
     computer, and "which of my sign-ins is paying for this" is the question the
     answer exists for. It is a read that starts nothing and moves nothing.
     WHAT IT CARRIES IS ALREADY ALLOWED ACROSS. An account NAME crosses this
     boundary today on row 8, `start`, which answers `account` and is served;
     the session ids and declared agent ids are the same ones `/v1/agent/events`
     and `/v1/org` carry. The confined home directory beside each row does NOT
     cross -- the surface drops it before the answer leaves the main process, so
     `dropPathFields` has nothing to do here. */
  '/v1/agent/session-accounts': Object.freeze({ method: 'GET', command: 'agent:session-accounts' }),
  '/v1/agent/desktop-sessions': Object.freeze({ method: 'GET', command: 'agent:desktop-sessions' }),
  '/v1/agent/desktop-tree': Object.freeze({ method: 'GET', command: 'agent:desktop-tree',
    snapshot: Object.freeze({ field: 'desktopTreeSnapshot', maxBytes: MAX_DESKTOP_TREE_SNAPSHOT_BYTES,
      changedCode: 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_CHANGED' }),
    query: Object.freeze({ page: 'int', snapshot: 'string' }) }),
  '/v1/agent/desktop-transcript': Object.freeze({ method: 'GET', command: 'agent:desktop-transcript', strictQuery: true, query: Object.freeze({ sessionId: 'string', before: 'string', limit: 'int' }) }),
  '/v1/agent/desktop-send': Object.freeze({ method: 'POST', command: 'agent:desktop-send' }),
  '/v1/agent/desktop-stop': Object.freeze({ method: 'POST', command: 'agent:desktop-stop', maxBodyBytes: 4096 }),
  '/v1/agent/desktop-stop-status': Object.freeze({ method: 'GET', command: 'agent:desktop-stop-status', strictQuery: true, query: Object.freeze({ requestId: 'string' }) }),
  '/v1/agent/local-messages': Object.freeze({ method: 'GET', command: 'agent:local-messages', query: Object.freeze({ limit: 'int', cursor: 'int' }) }),
  '/v1/agent/history': Object.freeze({ method: 'GET', command: 'agent:history', metrics: true, query: Object.freeze({ limit: 'int', metrics: 'metrics' }) }),
  '/v1/agent/usage': Object.freeze({ method: 'GET', command: 'agent:usage', metrics: true, query: Object.freeze({ limit: 'int', metrics: 'metrics' }) }),
  '/v1/agent/start': Object.freeze({ method: 'POST', command: 'agent:start' }),
  '/v1/agent/send': Object.freeze({ method: 'POST', command: 'agent:send' }),
  '/v1/agent/tree-address': Object.freeze({ method: 'POST', command: 'agent:tree-address' }),
  '/v1/agent/tree-adopt': Object.freeze({ method: 'POST', command: 'agent:tree-adopt' }),
  '/v1/agent/request': Object.freeze({ method: 'POST', command: 'agent:request' }),
  /* The person's edit and delete of one standing rule. Served, under the same
     rule as filing: the relay principal IS the signed-in person, and its
     mayWrite is the owner's web-drive switch, so with the switch off both
     refuse MC_AGENT_PRINCIPAL_READ_ONLY like every other write. */
  '/v1/agent/request-edit': Object.freeze({ method: 'POST', command: 'agent:request-edit' }),
  '/v1/agent/request-remove': Object.freeze({ method: 'POST', command: 'agent:request-remove' }),
  /* The person's approve-or-decline of one record, under the same rule. */
  '/v1/agent/request-decide': Object.freeze({ method: 'POST', command: 'agent:request-decide' }),
  /* The person's resolve of one standing rule -- done, or not possible as
     asked, with a reason. ROUTED, for the same reason as the three rows above
     and decided by the surface's own gate rather than by resemblance:
     agent:request-resolve is guarded by personOnly() in
     shell/agent-command-surface.cjs, whose comment names "the person's two
     seats ... the window at the keyboard or the relay that is the signed-in
     person". A command a relay principal CAN legitimately reach is a command
     that belongs on this table; REMOTE_OMITTED is for the gestures at this
     window, which is windowOnly()'s test, not personOnly()'s. Its write is
     gated by the owner's web-drive switch like every other write here, so
     with the switch off it refuses MC_AGENT_PRINCIPAL_READ_ONLY.

     THIS ROW IS WHY THE UNION WAS RED. The command arrived with 4f9fc94c
     (the L4e resolve bridge verb) inside the ledger-kinds compose, which
     added it to the command surface and to main.cjs but gave this table no
     decision. The parity check at createAgentFacade then threw "no facade
     decision for agent:request-resolve" for EVERY caller, so the whole
     agent-facade suite and every suite that builds a facade failed -- 100 of
     the 109 reds measured at e38b21b7 -- while neither constituent was red
     on its own. */
  '/v1/agent/request-resolve': Object.freeze({ method: 'POST', command: 'agent:request-resolve' }),
  /* THE LEDGER PAGE'S OTHER FIVE WRITE VERBS, on the same rule and for the same
     reason, and they arrived by the same route: 1a9985c6 (L4b) added the four
     task/ask verbs and 38313805 (L4c) added the fifth, all inside the
     ledger-kinds compose, and none of them was given a decision here.

     Each is `write: true, dialog: false` in shell/agent-command-surface.cjs and
     each is guarded there by personOnly() -- the window at the keyboard or the
     relay that is the signed-in person -- so a relay principal can legitimately
     reach every one, which is the test this table applies. They are also the
     write half of something already served: /v1/agent/ledger hands a relay
     client the whole ledger, so before these rows a signed-in person could read
     their own task and ask records over the relay and could not act on one. The
     owner's web-drive switch still gates them, like every other write here. */
  '/v1/agent/task-complete': Object.freeze({ method: 'POST', command: 'agent:task-complete' }),
  '/v1/agent/task-remove': Object.freeze({ method: 'POST', command: 'agent:task-remove' }),
  '/v1/agent/ask-answer': Object.freeze({ method: 'POST', command: 'agent:ask-answer' }),
  '/v1/agent/ask-decline': Object.freeze({ method: 'POST', command: 'agent:ask-decline' }),
  '/v1/agent/ask-remove': Object.freeze({ method: 'POST', command: 'agent:ask-remove' }),
  '/v1/agent/requests': Object.freeze({ method: 'GET', command: 'agent:requests', query: Object.freeze({ scope: 'string', key: 'string' }) }),
  /* The whole ledger for the Ledger page. `removed` arrives as the string
     'true' on a query string; the surface reads it as the boolean. */
  '/v1/agent/ledger': Object.freeze({ method: 'GET', command: 'agent:ledger', query: Object.freeze({ scope: 'string', key: 'string', removed: 'string' }) }),
  '/v1/agent/profiles': Object.freeze({ method: 'GET', command: 'agent:profiles' }),
  '/v1/agent/profile-remove': Object.freeze({ method: 'POST', command: 'agent:profile-remove' }),
  '/v1/agent/goal': Object.freeze({ method: 'POST', command: 'agent:goal' }),
  '/v1/agent/interrupt': Object.freeze({ method: 'POST', command: 'agent:interrupt' }),
  // Remote Send now uses the same per-request write and session-owner gates as send/interrupt.
  '/v1/agent/reserve-send-now': Object.freeze({ method: 'POST', command: 'agent:reserve-send-now' }),
  '/v1/agent/release-send-now': Object.freeze({ method: 'POST', command: 'agent:release-send-now' }),
  '/v1/agent/approval-answer': Object.freeze({ method: 'POST', command: 'agent:approval-answer' }),
  '/v1/agent/rewind': Object.freeze({ method: 'POST', command: 'agent:rewind' }),
  '/v1/agent/effort': Object.freeze({ method: 'POST', command: 'agent:effort' }),
  '/v1/agent/models': Object.freeze({ method: 'GET', command: 'agent:models', query: Object.freeze({ sessionId: 'string' }) }),
  '/v1/agent/close': Object.freeze({ method: 'POST', command: 'agent:close' }),
  '/v1/org': Object.freeze({ method: 'GET', command: 'org:read', dropPathFields: true,
    snapshot: Object.freeze({ field: 'orgSnapshot', maxBytes: MAX_ORG_SNAPSHOT_BYTES,
      changedCode: 'AGENT_FACADE_ORG_SNAPSHOT_CHANGED' }),
    query: Object.freeze({ page: 'int', snapshot: 'string' }) }),
  '/v1/org/reparent': Object.freeze({ method: 'POST', command: 'org:reparent' }),
  '/v1/org/assign-role': Object.freeze({ method: 'POST', command: 'org:assign-role' }),
  '/v1/org/ensure-seat': Object.freeze({ method: 'POST', command: 'org:ensure-seat' }),
  '/v1/org/release-seat': Object.freeze({ method: 'POST', command: 'org:release-seat' }),
  '/v1/org/create-role': Object.freeze({ method: 'POST', command: 'org:create-role' }),
  '/v1/org/edit-role': Object.freeze({ method: 'POST', command: 'org:edit-role' }),
  '/v1/org/reset-role': Object.freeze({ method: 'POST', command: 'org:reset-role' }),
  '/v1/org/reset': Object.freeze({ method: 'POST', command: 'org:reset' }),
  '/v1/org/export': Object.freeze({ method: 'GET', command: 'org:export', dropPathFields: true }),
  '/v1/agent/remote-status': Object.freeze({ method: 'GET', facade: 'remote-status' }),
  '/v1/agent/events': Object.freeze({ method: 'GET', facade: 'events' }),
})

/* How a bounded code maps to an HTTP status. The status is advisory -- the
   browser binding re-throws the CODE on any non-2xx -- but an honest one
   helps every intermediate log. Codes not named here: MC_AGENT_* is a
   refused request (400), anything else is this machine failing to do it
   (500). */
const CODE_STATUS = Object.freeze({
  MC_AGENT_PRINCIPAL_READ_ONLY: 403,
  MC_AGENT_DIALOG_REQUIRES_WINDOW: 403,
  MC_AGENT_PRINCIPAL_INVALID: 403,
  MC_AGENT_SENDER_REFUSED: 403,
  MC_AGENT_UNKNOWN_COMMAND: 404,
  MC_AGENT_UNKNOWN_SESSION: 404,
  MC_AGENT_SESSION_EXISTS: 409,
  MC_AGENT_SESSION_LIMIT: 409,
  AGENT_TURN_ACTIVE: 409,
})

function boundedCode(value) {
  return typeof value === 'string' && CODE_SHAPE.test(value) ? value : null
}

function statusForCode(code) {
  if (code === 'AGENT_FACADE_BAD_QUERY') return 400
  if (code === 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_CHANGED' || code === 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_BUSY') return 409
  if (code === 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_UNAVAILABLE') return 503
  if (Object.prototype.hasOwnProperty.call(CODE_STATUS, code)) return CODE_STATUS[code]
  return code.startsWith('MC_AGENT_') ? 400 : 500
}

function createAgentFacade({ surface, principalForRelay, voice = null, accountSettings = null, metrics = null,
  desktopTreeReadLease = null, desktopTreeSnapshotNow = () => performance.now(), log } = {}) {
  /* Fails closed at construction, like the surface it fronts: a facade that
     cannot decide every request correctly must not exist at all. */
  if (!surface || typeof surface.run !== 'function' || !Array.isArray(surface.commands)) {
    throw new Error('createAgentFacade needs the shared agent command surface')
  }
  if (typeof surface.sessionLoad !== 'function') {
    throw new Error('createAgentFacade: the surface must answer sessionLoad() for remote-status')
  }
  if (typeof principalForRelay !== 'function') {
    throw new Error('createAgentFacade needs principalForRelay()')
  }
  if ((desktopTreeReadLease !== null && typeof desktopTreeReadLease !== 'function') || typeof desktopTreeSnapshotNow !== 'function') {
    throw new Error('createAgentFacade needs a native desktop-tree read lease and monotonic snapshot clock')
  }
  if (accountSettings !== null && typeof accountSettings.run !== 'function') {
    throw new Error('createAgentFacade needs a bounded account-settings controller')
  }
  if (metrics !== null && (typeof metrics.run !== 'function' || typeof metrics.validateQuery !== 'function')) {
    throw new Error('createAgentFacade needs a bounded remote Metrics controller')
  }
  if (typeof log !== 'function') {
    throw new Error('createAgentFacade needs log(): an unbounded error must go somewhere that is not the wire')
  }

  /* THE PARITY GATE, live (design §10): every routed command must be one the
     surface holds, and every surface command must be routed or deliberately
     omitted. A command added to one side without a facade decision refuses
     construction instead of silently drifting. */
  const routedCommands = new Set()
  for (const [route, spec] of Object.entries(ROUTES)) {
    if (!spec.command) continue
    if (!surface.commands.includes(spec.command)) {
      throw new Error('createAgentFacade: route ' + route + ' names a command the surface does not hold: ' + spec.command)
    }
    if (routedCommands.has(spec.command)) {
      throw new Error('createAgentFacade: two routes serve ' + spec.command)
    }
    routedCommands.add(spec.command)
  }
  for (const command of surface.commands) {
    const routed = routedCommands.has(command)
    const omitted = REMOTE_OMITTED.includes(command)
    if (routed === omitted) {
      throw new Error('createAgentFacade: no facade decision for ' + command + ' (must be routed or REMOTE_OMITTED, never both, never neither)')
    }
  }

  // Only desktop trees retain one point-in-time page source. Re-reading a
  // running tree on every page cannot finish while replies are being saved.
  // The native lease checks its original device/pair/connection on every page;
  // a cached body never substitutes for current authority. Only one capture
  // may allocate at a time, and the old buffer is dropped before a new capture.
  let desktopTreeSnapshot = null
  let desktopTreeCapture = null
  let desktopTreeExpiry = null
  function clearDesktopTreeSnapshot() {
    desktopTreeSnapshot = null
    clearTimeout(desktopTreeExpiry)
    desktopTreeExpiry = null
  }
  const snapshotFail = code => { throw Object.assign(new Error(code), { code }) }
  const snapshotChanged = () => snapshotFail('AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_CHANGED')
  function snapshotAuthority(admission) {
    const principal = principalForRelay()
    if (!token || admission.token !== token || principal?.kind !== 'relay' || principal.owner !== admission.owner
        || principal.mayWrite !== admission.mayWrite) snapshotChanged()
    return principal
  }
  function desktopTreePageBody(snapshot, page) {
    const pages = Math.ceil(snapshot.buffer.length / SNAPSHOT_CHUNK_BYTES)
    if (page >= pages) snapshotFail('AGENT_FACADE_BAD_QUERY')
    const start = page * SNAPSHOT_CHUNK_BYTES
    return { ok: true, desktopTreeSnapshot: { version: 1, sha256: snapshot.sha256,
      bytes: snapshot.buffer.length, page, pages,
      data: snapshot.buffer.subarray(start, start + SNAPSHOT_CHUNK_BYTES).toString('base64') } }
  }
  async function dispatchDesktopTreePage(route, payload, res) {
    if (payload.page === 0) {
      if (desktopTreeCapture) snapshotFail('AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_BUSY')
      if (!desktopTreeReadLease) snapshotFail('AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_UNAVAILABLE')
      clearDesktopTreeSnapshot()
      const id = Symbol('desktop tree capture')
      desktopTreeCapture = id
      const principal = principalForRelay()
      const admission = { token, owner: principal?.owner, mayWrite: principal?.mayWrite }
      const stillCapturing = () => {
        if (desktopTreeCapture !== id) snapshotChanged()
        return snapshotAuthority(admission)
      }
      try {
        const check = await desktopTreeReadLease(principal)
        if (typeof check !== 'function') snapshotFail('AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_UNAVAILABLE')
        stillCapturing()
        const result = await surface.run(route.command, {}, principalForRelay())
        await check(stillCapturing())
        stillCapturing()
        if (result?.ok !== true) {
          const bounded = serializeBounded(route, result, {})
          if (bounded.tooLarge) snapshotFail('AGENT_FACADE_RESPONSE_TOO_LARGE')
          return answer(res, 200, JSON.parse(bounded.text))
        }
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > MAX_DESKTOP_TREE_SNAPSHOT_BYTES) snapshotFail('AGENT_FACADE_RESPONSE_TOO_LARGE')
        const buffer = Buffer.from(text)
        desktopTreeSnapshot = { ...admission, id, check, buffer,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          expiresAt: desktopTreeSnapshotNow() + DESKTOP_TREE_SNAPSHOT_TTL_MS }
        desktopTreeExpiry = setTimeout(() => {
          if (desktopTreeSnapshot?.id === id) clearDesktopTreeSnapshot()
        }, DESKTOP_TREE_SNAPSHOT_TTL_MS)
        desktopTreeExpiry.unref()
        return answer(res, 200, desktopTreePageBody(desktopTreeSnapshot, 0))
      } finally {
        if (desktopTreeCapture === id) desktopTreeCapture = null
      }
    }
    // Keep only the small lease and identity across its async check, never a
    // local reference to a retired 65 MiB buffer while another capture starts.
    // An old tab's cursor must not retire a newer tab's valid snapshot.
    if (!desktopTreeSnapshot || desktopTreeSnapshot.sha256 !== payload.snapshot) snapshotChanged()
    const id = desktopTreeSnapshot.id
    const check = desktopTreeSnapshot.check
    try {
      if (desktopTreeSnapshotNow() >= desktopTreeSnapshot.expiresAt) snapshotChanged()
      const principal = snapshotAuthority(desktopTreeSnapshot)
      await check(principal)
      if (desktopTreeSnapshot?.id !== id || desktopTreeSnapshotNow() >= desktopTreeSnapshot.expiresAt) snapshotChanged()
      snapshotAuthority(desktopTreeSnapshot)
      return answer(res, 200, desktopTreePageBody(desktopTreeSnapshot, payload.page))
    } catch (error) {
      if (desktopTreeSnapshot?.id === id) clearDesktopTreeSnapshot()
      throw error
    }
  }

  /* ---------- the event ring ---------- */

  let eventSeq = 0
  /* The highest seq that has been pushed out of the ring; a cursor at or
     below it has lost events, and the answer says so. */
  let evictedThrough = 0
  const ring = []
  let ringBytes = 0
  const waiters = new Set()

  function emit(packet) {
    eventSeq += 1
    /* Snapshot at admission. Holding the caller's object until a later poll
       lets a mutation change history after emit(), and JSON.stringify at read
       time lets one circular/hostile packet make every poll return 500 forever.
       A single event may also be larger than the tunnel's entire frame (turn
       text is allowed to be 200 KB). Such an event cannot truthfully ride this
       transport. Keep its sequence as an explicit gap, without retaining its
       unbounded bytes, so the reader receives dropped:true and can resync. */
    let wire = null
    let bytes = 0
    try {
      const serialized = JSON.stringify({ seq: eventSeq, packet })
      if (typeof serialized === 'string') {
        bytes = Buffer.byteLength(serialized)
        if (bytes <= MAX_RESPONSE_BYTES - 256) wire = JSON.parse(serialized)
      }
    } catch { /* represented below as an explicit gap */ }
    if (wire) {
      ring.push({ seq: eventSeq, wire, bytes, unavailable: false })
      ringBytes += bytes
    } else {
      ring.push({ seq: eventSeq, wire: null, bytes: 0, unavailable: true })
      try { log('a relay event could not fit the bounded JSON event stream; its sequence was retained as a dropped resync point') } catch { /* logging cannot break fan-out */ }
    }
    while (ring.length > RING_SIZE || ringBytes > MAX_RING_BYTES) {
      const removed = ring.shift()
      evictedThrough = removed.seq
      ringBytes -= removed.bytes
    }
    for (const waiter of [...waiters]) {
      if (waiter.sessionId && !(packet && packet.sessionId === waiter.sessionId)) continue
      waiter.finish()
    }
  }

  function collectEvents(after, sessionId) {
    /* dropped is about the GLOBAL stream: a cursor below what the ring still
       holds, or beyond anything this boot has issued (a cursor from another
       life). Either way the caller's next honest move is a resync, not a
       splice. */
    let dropped = after > eventSeq || after < evictedThrough
    const events = []
    let bytes = 0
    let truncated = false
    let next = after
    for (const item of ring) {
      if (item.seq <= after) continue
      if (item.unavailable) {
        dropped = true
        truncated = true
        next = item.seq
        continue
      }
      if (sessionId && (!item.wire.packet || item.wire.packet.sessionId !== sessionId)) continue
      if (bytes + item.bytes > MAX_RESPONSE_BYTES - 256) {
        truncated = true
        break
      }
      events.push(item.wire)
      bytes += item.bytes
      next = item.seq
    }
    const body = { ok: true, seq: eventSeq, events, dropped }
    if (truncated) {
      body.truncated = true
      body.next = next
    }
    return body
  }

  /* ---------- the server ---------- */

  let origin = null
  let token = null

  function answer(res, status, body, thenDestroy) {
    const text = JSON.stringify(body)
    if (res.headersSent || res.writableEnded) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    })
    if (thenDestroy) {
      const socket = res.socket
      res.end(text, () => { try { socket.destroy() } catch { /* already gone */ } })
    } else {
      res.end(text)
    }
  }

  function refuse(res, status, code, thenDestroy) {
    answer(res, status, { ok: false, error: { code } }, thenDestroy)
  }

  function authorized(req) {
    if (typeof token !== 'string') return false
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const presented = Buffer.from(header.slice('Bearer '.length), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    /* A length mismatch is a plain refusal -- comparing unequal-length
       buffers is where naive implementations leak timing. */
    if (presented.length !== expected.length) return false
    return crypto.timingSafeEqual(presented, expected)
  }

  /* Read a POST body: JSON, bounded. Answers the request itself on refusal
     and resolves null; resolves the parsed object on success. */
  function readJsonBody(req, res, maxBodyBytes = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        refuse(res, 413, 'AGENT_FACADE_BODY_TOO_LARGE', true)
        resolve(null)
        return
      }
      const chunks = []
      let received = 0
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      req.on('data', (chunk) => {
        if (settled) return
        received += chunk.length
        if (received > maxBodyBytes) {
          refuse(res, 413, 'AGENT_FACADE_BODY_TOO_LARGE', true)
          done(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('error', () => done(null))
      req.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length === 0) {
          done({})
          return
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          refuse(res, 400, 'AGENT_FACADE_BAD_JSON')
          done(null)
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          refuse(res, 400, 'AGENT_FACADE_BAD_JSON')
          done(null)
          return
        }
        done(parsed)
      })
    })
  }

  /* Build a GET route's payload from its declared query parameters; anything
     undeclared refuses. Returns null after answering on refusal. */
  function queryPayload(route, url, res) {
    const payload = {}
    for (const [key, value] of url.searchParams) {
      const kind = route.query && Object.hasOwn(route.query, key) ? route.query[key] : undefined
      if (!kind || ((route.metrics || route.strictQuery || route.snapshot) && Object.hasOwn(payload, key))) {
        refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        return null
      }
      if (kind === 'metrics') {
        if (!metrics) {
          refuse(res, 503, 'REMOTE_METRICS_UNAVAILABLE')
          return null
        }
        let parsed
        try { if (value.length <= 1024) parsed = JSON.parse(value) } catch { /* Refuse below. */ }
        if (metrics.validateQuery(parsed) !== true) {
          refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
          return null
        }
        payload[key] = parsed
      } else if (kind === 'int') {
        if (!/^\d{1,9}$/.test(value)) {
          refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
          return null
        }
        payload[key] = Number(value)
      } else {
        if (value.length === 0 || value.length > 1024) {
          refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
          return null
        }
        payload[key] = value
      }
    }
    if (route.snapshot && Object.keys(payload).length > 0) {
      const page = payload.page
      if (!Number.isSafeInteger(page) || page < 0 || page >= route.snapshot.maxBytes / SNAPSHOT_CHUNK_BYTES
        || (page === 0 ? Object.hasOwn(payload, 'snapshot') : !/^[a-f0-9]{64}$/.test(payload.snapshot || ''))) {
        refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        return null
      }
    }
    return payload
  }

  /* Bound a success body at MAX_RESPONSE_BYTES. List answers (`entries`
     arrays: history, usage) are clipped from the FRONT -- the ledgers answer
     oldest-first, so the newest survive -- and marked truncated:true. A body
     with no list to clip that still exceeds the bound is refused
     AGENT_FACADE_RESPONSE_TOO_LARGE: an honest refusal here beats a
     TUNNEL_RESPONSE_TOO_LARGE mystery two hops later (design §6.4). */
  function serializeBounded(route, body, payload) {
    let out = body
    if (route.dropPathFields && out && typeof out === 'object' && !Array.isArray(out)) {
      out = { ...out }
      delete out.overlayFile
      if (out.roleMemorySelection && typeof out.roleMemorySelection === 'object') {
        out.roleMemorySelection = { ...out.roleMemorySelection }
        delete out.roleMemorySelection.file
      }
    }
    let text = JSON.stringify(out)
    if (text === undefined) text = 'null'
    if (route.snapshot && Object.hasOwn(payload, 'page') && out?.ok === true) {
      const bytes = Buffer.byteLength(text)
      if (bytes > route.snapshot.maxBytes) return { tooLarge: true }
      const sha256 = crypto.createHash('sha256').update(text).digest('hex')
      if (payload.page > 0 && payload.snapshot !== sha256) return { changed: true }
      const pages = Math.ceil(bytes / SNAPSHOT_CHUNK_BYTES)
      if (payload.page >= pages) return { badPage: true }
      const start = payload.page * SNAPSHOT_CHUNK_BYTES
      const data = Buffer.from(text).subarray(start, start + SNAPSHOT_CHUNK_BYTES).toString('base64')
      text = JSON.stringify({ ok: true, [route.snapshot.field]: { version: 1, sha256, bytes, page: payload.page, pages, data } })
    }
    if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return { text }
    // Metrics is a fixed snapshot with a descending start/turn cursor. Retain
    // complete start/outcome groups and move the cursor to the oldest start
    // actually sent. Generic list clipping would silently skip part of a page.
    if (route.metrics && out?.metrics?.v === 1 && Array.isArray(out.entries)) {
      const primary = route.command === 'agent:history' ? 'agent_session_start' : 'agent_turn_usage'
      const kept = out.entries.filter(entry => entry?.action === primary)
        .sort((a, b) => b.sequence - a.sequence)
      if (kept.some(entry => !Number.isSafeInteger(entry.sequence) || entry.sequence <= 0)
        || out.entries.some(entry => entry?.action !== primary
          && !(primary === 'agent_session_start' && entry?.action === 'agent_session_outcome'))) return { tooLarge: true }
      while (kept.length > 1) {
        kept.pop()
        const sequences = new Set(kept.map(entry => entry.sequence))
        const entries = out.entries.filter(entry => entry.action === primary
          ? sequences.has(entry.sequence) : sequences.has(entry.outcome?.resolves))
        text = JSON.stringify({ ...out, entries, truncated: true,
          metrics: { ...out.metrics, nextBefore: kept.at(-1).sequence } })
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return { text }
      }
      return { tooLarge: true }
    }
    // A journal page is a forward cursor stream. Keep its oldest records and
    // return the last sequence actually sent, so a small tunnel frame cannot
    // skip messages or make an oversized conversation unreadable forever.
    if (route.command === 'agent:local-messages' && Array.isArray(out?.messages)
      && out.history && out.messages.every(message => Number.isSafeInteger(message?.sequence) && message.sequence > 0)) {
      const messages = out.messages.slice()
      while (messages.length > 1) {
        messages.pop()
        const clipped = { ...out, messages, truncated: true,
          history: { ...out.history, nextCursor: messages.at(-1).sequence } }
        text = JSON.stringify(clipped)
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return { text }
      }
    }
    /* `entries` is the rail's list; `records` is the ledger page's. Either
       is clipped from the front (the oldest rows go first) and the reply says
       so with `truncated`, rather than refusing a ledger of a few long rules. */
    const listKey = out && typeof out === 'object'
      ? (Array.isArray(out.entries) ? 'entries' : (Array.isArray(out.records) ? 'records' : null))
      : null
    if (listKey) {
      const list = out[listKey].slice()
      const clipped = { ...out, truncated: true }
      while (list.length > 0) {
        list.shift()
        clipped[listKey] = list
        text = JSON.stringify(clipped)
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return { text }
      }
    }
    return { tooLarge: true }
  }

  async function dispatchCommand(route, payload, res) {
    let result
    try {
      if (route.command === 'agent:desktop-tree' && Object.hasOwn(payload, 'page')) {
        return await dispatchDesktopTreePage(route, payload, res)
      }
      if (route.facade === 'voice') {
        if (!voice) return refuse(res, 503, 'VOICE_RUNTIME_UNAVAILABLE')
        result = await voice.run(route.voice, payload)
      } else if (route.facade === 'account-settings') {
        if (!accountSettings) return refuse(res, 503, 'REMOTE_ACCOUNT_SETTINGS_UNAVAILABLE')
        result = await accountSettings.run(route.setting, payload, principalForRelay())
      } else if (route.metrics && payload.metrics !== undefined) {
        if (!metrics) return refuse(res, 503, 'REMOTE_METRICS_UNAVAILABLE')
        result = await metrics.run(route.command, payload, principalForRelay())
      } else result = await surface.run(route.command, route.snapshot ? {} : payload, principalForRelay())
    } catch (error) {
      /* The code is the message. rendererSafeAgentError makes the message
         the code for everything the bodies throw; the surface's own gate
         refusals carry a bounded `code` beside a prose message. Either way
         only the identifier crosses; everything else goes to the log. */
      const code = boundedCode(error && error.code) || boundedCode(error && error.message)
      if (!code) {
        try { log(error) } catch { /* the log must never take the facade down */ }
        refuse(res, 500, 'AGENT_FACADE_INTERNAL')
        return
      }
      refuse(res, statusForCode(code), code)
      return
    }
    const bounded = serializeBounded(route, result, payload)
    if (bounded.changed) return refuse(res, 409, route.snapshot.changedCode)
    if (bounded.badPage) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
    if (bounded.tooLarge) {
      try { log('a ' + route.command + ' answer exceeded the response bound and had no entries list to clip') } catch { /* see above */ }
      refuse(res, 500, 'AGENT_FACADE_RESPONSE_TOO_LARGE')
      return
    }
    if (res.headersSent || res.writableEnded) return
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(bounded.text),
    })
    res.end(bounded.text)
  }

  /* THE STATE OF THE REMOTE SURFACE, INCLUDING WHETHER IT MAY CHANGE ANYTHING.
   *
   * `mayWrite` is the owner's web-drive switch, read the only way it is ever
   * read -- relayPrincipal() in main.cjs, which calls webDriveMayWrite() on
   * shell/renderer-prefs.cjs. It is REPORTED here, never decided here, so the
   * switch keeps one reader.
   *
   * WHY THE RELAY CHILD NEEDS TO BE TOLD. The child gates the OTHER half of the
   * door -- everything that is not /v1/agent/* or /v1/org*, which reaches this
   * machine's mission bridge carrying the owner's own bearer. It has no way to
   * read renderer-prefs.json itself, and no business learning that file's
   * shape; the shell is not otherwise in that leg's request path. Handing it a
   * value at spawn instead would have been stale the moment the switch moved,
   * because flipping it does not respawn the child. So it asks, per write, and
   * this route answers. See engine src/lib/online-fra-composite-bridge.js.
   *
   * It rides on remote-status rather than a route of its own because that is
   * what this route already is: the facade speaking for itself about the state
   * of the remote surface. A second endpoint for one boolean would be a second
   * way to ask one question.
   *
   * A principal that cannot be built has no read authority either. Reporting
   * it as an ordinary OFF switch would authorize mission reads through the
   * composite bridge after the native connection had been revoked. */
  function readAdmission(res, previous) {
    let principal
    try { principal = principalForRelay() } catch { /* fixed refusal below */ }
    if (!token || !principal || typeof principal !== 'object' || principal.kind !== 'relay'
      || principal.owner === null || principal.owner === undefined
      || (previous && (previous.owner !== principal.owner || previous.token !== token))) {
      refuse(res, 503, 'AGENT_FACADE_CONNECTION_CLOSED')
      return null
    }
    return { owner: principal.owner, token, mayWrite: principal.mayWrite === true }
  }

  function handleRemoteStatus(res) {
    const admission = readAdmission(res)
    if (!admission) return
    const load = surface.sessionLoad()
    answer(res, 200, {
      ok: true,
      facade: 'ready',
      sessionsOpen: load.open,
      maxSessions: load.max,
      mayWrite: admission.mayWrite,
    })
  }

  function handleEvents(url, res) {
    const admission = readAdmission(res)
    if (!admission) return
    let after = 0
    let waitMs = 0
    let sessionId = null
    for (const [key, value] of url.searchParams) {
      if (key === 'after') {
        if (!/^\d{1,15}$/.test(value)) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        after = Number(value)
      } else if (key === 'waitMs') {
        if (!/^\d{1,9}$/.test(value)) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        waitMs = Math.min(Number(value), MAX_WAIT_MS)
      } else if (key === 'sessionId') {
        if (value.length === 0 || value.length > 1024) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        sessionId = value
      } else {
        return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
      }
    }
    const immediate = collectEvents(after, sessionId)
    /* Answer NOW when there is something to say -- events, or the honest
       `dropped` that demands a resync -- or when the caller declined to
       wait. An empty answer still carries the current seq, so silence is
       distinguishable from disconnection. */
    if (immediate.events.length > 0 || immediate.dropped || waitMs === 0) {
      return answer(res, 200, immediate)
    }
    const waiter = {
      sessionId,
      timer: null,
      finish() {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        try {
          // A pending read belongs to the owner and listen token that admitted
          // it. Re-enrollment or a new token cannot release its old event body.
          if (!readAdmission(res, admission)) return
          answer(res, 200, collectEvents(after, sessionId))
        } catch { /* the client left; nothing to tell it */ }
      },
    }
    waiter.timer = setTimeout(waiter.finish, waitMs)
    waiters.add(waiter)
    res.on('close', () => {
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
    })
  }

  async function handleRequest(req, res) {
    try {
      /* Origin FIRST, before auth: a browser is refused as a browser, never
         told whether its stolen token was right. */
      if ('origin' in req.headers) {
        refuse(res, 403, 'AGENT_FACADE_NO_BROWSERS')
        return
      }
      if (!authorized(req)) {
        refuse(res, 401, 'AGENT_FACADE_UNAUTHORIZED')
        return
      }
      let url
      try {
        url = new URL(req.url, 'http://facade.invalid')
      } catch {
        refuse(res, 404, 'AGENT_FACADE_UNKNOWN_ROUTE')
        return
      }
      const route = ROUTES[url.pathname]
      if (!route) {
        refuse(res, 404, 'AGENT_FACADE_UNKNOWN_ROUTE')
        return
      }
      if (req.method !== route.method) {
        res.setHeader('allow', route.method)
        refuse(res, 405, 'AGENT_FACADE_METHOD_NOT_ALLOWED')
        return
      }
      if (route.facade === 'remote-status') {
        if (url.search) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        handleRemoteStatus(res)
        return
      }
      if (route.facade === 'events') {
        handleEvents(url, res)
        return
      }
      let payload
      if (route.method === 'GET') {
        payload = queryPayload(route, url, res)
        if (payload === null) return
      } else {
        if (url.search) return refuse(res, 400, 'AGENT_FACADE_BAD_QUERY')
        payload = await readJsonBody(req, res, route.maxBodyBytes)
        if (payload === null) return
      }
      await dispatchCommand(route, payload, res)
    } catch (error) {
      /* The last fence: whatever happened, only a code crosses -- and a
         socket the client already tore down must not turn this fence into
         an unhandled rejection of its own. */
      try { log(error) } catch { /* nothing left to tell */ }
      try {
        if (!res.headersSent) {
          refuse(res, 500, 'AGENT_FACADE_INTERNAL')
        } else {
          res.destroy()
        }
      } catch { /* already gone */ }
    }
  }

  const server = http.createServer((req, res) => { void handleRequest(req, res) })

  function listen() {
    // Replacing the bearer retires its byte snapshot immediately. A source
    // capture still awaiting native work keeps its allocation sentinel until
    // finally; token checks discard it before serialization or publication.
    clearDesktopTreeSnapshot()
    return new Promise((resolve, reject) => {
      if (server.listening) {
        /* A re-listen is the relay child being respawned: the origin holds,
           the bearer is re-minted so a dead child's copy stops working. */
        token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
        resolve({ origin, token })
        return
      }
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        origin = 'http://127.0.0.1:' + server.address().port
        token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
        resolve({ origin, token })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
  }

  function close() {
    clearDesktopTreeSnapshot()
    surface.closeRemoteWatches?.()
    // A dead relay must release its microphone contact; agent sessions retain
    // their existing independent lifetime across relay-child respawns.
    if (voice) void voice.disconnect().catch(error => { try { log(error) } catch {} })
    // Withdraw the bearer before settling readers. Preserve the sequence gap,
    // but never retain a closed connection's history for a later account.
    //
    // Union of two lanes, 2026-09-06. The microphone release and the bearer
    // withdrawal are independent duties and both are kept. The ORDER is the r9
    // one deliberately: token = null happens before any waiter is settled, so a
    // reader that is answered on the way out cannot be replayed against a
    // bearer that is still live. voice.disconnect() is fire-and-forget and
    // touches neither the token nor the ring, so running it first costs that
    // ordering nothing. Exactly one waiter loop, below -- the earlier copy on
    // the LIVE side would have settled readers before the withdrawal.
    token = null
    evictedThrough = eventSeq
    ring.length = 0
    ringBytes = 0
    /* Pending long-polls are answered, not abandoned: the tunnel gets an
       empty read instead of a hang it must time out. */
    for (const waiter of [...waiters]) waiter.finish()
    const done = new Promise((resolve) => {
      if (!server.listening) {
        origin = null
        resolve()
        return
      }
      server.close(() => {
        origin = null
        resolve()
      })
      server.closeIdleConnections()
      /* Give the just-answered polls this tick to flush, then cut whatever
         still holds a socket so close() cannot hang on a lingering caller. */
      setImmediate(() => { try { server.closeAllConnections() } catch { /* already down */ } })
    })
    return done
  }

  function address() {
    return server.listening ? { origin } : null
  }

  return Object.freeze({ listen, close, address, emit })
}

module.exports = {
  createAgentFacade,
  ROUTES,
  REMOTE_OMITTED,
  MAX_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  RING_SIZE,
  MAX_RING_BYTES,
  MAX_WAIT_MS,
}
