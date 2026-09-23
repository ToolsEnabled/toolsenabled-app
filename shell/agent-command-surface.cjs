/* THE ONE PLACE EVERY AGENT AND ORGANISATION COMMAND IS DECIDED.
 *
 * WHY THIS FILE EXISTS. docs/relay-agent-facade-DESIGN.md (§2.1) commits the
 * product to serving the agent and org surface to a signed-in browser over a
 * sealed relay, which means the same commands will be reached from TWO
 * callers: the Electron IPC handlers in shell/main.cjs (the window at the
 * keyboard) and, later, a loopback facade the relay child forwards to. If the
 * two callers each held their own copy of "what may a start do, what does a
 * send refuse, in what order are the checks made", they would drift apart the
 * first time one of them was edited, and the web would quietly disagree with
 * the desk about what a person is allowed to do to their own computer. So the
 * bodies of all thirty handlers live HERE, once, and every caller dispatches
 * through run(). The IPC handlers in main.cjs are thin wrappers: they make the
 * Electron frame check (that is a fact about Electron, not about a command)
 * and hand the rest to this module.
 *
 * WHO IS ASKING: THE PRINCIPAL. The handlers used to answer the question "does
 * this session belong to the caller" with `session.owner === event.sender` --
 * the WebContents that started it. That was right and it stays right, but a
 * relay caller has no WebContents, so the question is now asked of a
 * principal:
 *
 *   { kind: 'window' | 'relay',   // the window's wrappers build 'window';
 *                                 // the agent facade builds 'relay'
 *     owner: <opaque identity>,   // the window passes event.sender, unchanged
 *     mayWrite: boolean,          // false refuses every state-changing command
 *     label: string }             // for refusal sentences
 *
 * For the window caller nothing observable changes: `owner` IS event.sender,
 * `mayWrite` is true, and every refusal code, string and ordering is the one
 * main.cjs raised before the extraction. The ownership test becomes
 * `session.owner !== principal.owner` and refuses with the same
 * MC_AGENT_UNKNOWN_SESSION it always did.
 *
 * THE READ-ONLY GATE. `mayWrite: false` refuses every command marked `write`
 * in COMMANDS with MC_AGENT_PRINCIPAL_READ_ONLY, before the payload is even
 * parsed, and reads keep answering so a surface can say what the state is and
 * WHY a command was refused. No window caller sets it false; it is the seam
 * the owner-ruled "this computer may be driven from the web" switch will use,
 * and that switch defaults OFF.
 *
 * THE DIALOG GATE. Three commands open a native dialog on this computer -- the
 * attachment picker, the mention picker and profile creation -- and the
 * attachment dialog is the ENTIRE security design of the image allowlist: the
 * only way a path enters a session's allowlist is a person choosing it in that
 * dialog. A caller that is not at the keyboard cannot be shown a dialog, so
 * those commands refuse any principal whose kind is not 'window' with
 * MC_AGENT_DIALOG_REQUIRES_WINDOW, rather than opening a dialog nobody is
 * present to see. The dialog itself is injected through `deps` -- this module
 * never requires electron -- which is what makes it testable here and
 * refusable there.
 *
 * NOTHING IN THIS FILE IS A CONSTANT THAT MAIN.CJS ALSO HOLDS. Every value the
 * bodies used to close over (the session map, the host, the recorders, the
 * parsers, the stores, the bounds) is passed in through `deps` and checked for
 * presence at construction: a dependency that is absent fails the construction
 * closed, never a later command open. */
'use strict'

const { validateMetricsQuery } = require('./metrics-record-query.cjs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const providerImageSupport = require('./provider-image-support.cjs')
const { createLedgerCustody } = require('./ledger-custody.cjs')

/* The refusal a read-only principal receives for every write. One code, so a
   caller can branch on it; the sentence names the caller so a person reading a
   log knows WHICH caller was held back. */
const READ_ONLY_REFUSAL = 'MC_AGENT_PRINCIPAL_READ_ONLY'
/* The refusal a principal that is not at the keyboard receives for a command
   whose whole meaning is a native dialog. */
const DIALOG_REFUSAL = 'MC_AGENT_DIALOG_REQUIRES_WINDOW'
/* A principal that is not the documented shape is not a caller this surface
   can reason about, so it is refused before any command is considered. */
const PRINCIPAL_REFUSAL = 'MC_AGENT_PRINCIPAL_INVALID'
/* A pasted image's only source of trust is the person's own local clipboard
   gesture, read directly off THIS window's paste event -- not a fact a relay
   caller on another device can supply, however it labels its bytes. Not the
   dialog refusal above: this command opens no dialog, and reusing that code's
   sentence ("opens a dialog on this computer") would say something false
   about a command that does not. */
const PASTE_WINDOW_REFUSAL = 'MC_AGENT_PASTE_REQUIRES_WINDOW'
/* parseAgentPasteAttachment / savePasteAttachment / MAX_PASTE_IMAGE_BYTES are
   optional deps (see assertDeps): a build that omits any of them refuses this
   one command by name rather than throwing a raw TypeError on a call to
   undefined, or reading an absent MAX_PASTE_IMAGE_BYTES as no size cap. */
const PASTE_UNAVAILABLE_REFUSAL = 'MC_AGENT_PASTE_UNAVAILABLE'
const UNKNOWN_COMMAND_REFUSAL = 'MC_AGENT_UNKNOWN_COMMAND'
const ENDED_SESSION_REFUSAL = 'MC_AGENT_SESSION_ENDED'
/* The two verbs that rewrite one of the person's own standing rules
   (agent:request-edit / agent:request-remove) are PERSON-ONLY: the caller must
   be the window at the keyboard or the signed-in relay -- the two principal
   kinds this surface knows, which ARE the person's two seats. Any other kind
   is refused before the payload is read, with PRINCIPAL_REFUSAL (it is not a
   principal this surface can reason about FOR THESE VERBS) and its own
   sentence. Owner, 2026-08-22: "its a hand edit tool. for the user to go in
   on the toolsenabled ledger and hand edit or delete them." */
const PERSON_KINDS = Object.freeze(['window', 'relay'])
const PAYLOAD_LEDGER_RESET_MODULE = 'src/lib/ledger-category-reset.js'
const ROLE_CAPABILITY_FIELDS = Object.freeze([
  'orgRoot',
  'singleSeat',
  'mayClaimWork',
  'mayWakeReports',
  'requiresMutationContext',
  'mayUseMissionBridge',
  'mayReportMissionBridge',
  'mayMutateMissionBridge',
])

/* Capabilities may be authored only through role CRUD. Agent starts carry a
 * role id plus revisions and main resolves this stored object later. Keep this
 * parser exact so a partial posture cannot gain meaning from a default and an
 * extra field cannot become an unreviewed future capability. */
function optionalRoleCapabilities(value, agentIpcError) {
  if (value === undefined) return undefined
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === ROLE_CAPABILITY_FIELDS.length
    && ROLE_CAPABILITY_FIELDS.every((field) => Object.hasOwn(value, field) && typeof value[field] === 'boolean')
  if (!valid) {
    agentIpcError(
      'MC_AGENT_ROLE_CAPABILITIES_INVALID',
      `Role capabilities must contain exactly eight booleans: ${ROLE_CAPABILITY_FIELDS.join(', ')}. Nothing was changed.`,
    )
  }
  return Object.freeze(Object.fromEntries(ROLE_CAPABILITY_FIELDS.map((field) => [field, value[field]])))
}

function roleFunctionFields(request) {
  if (!request || typeof request !== 'object') return {}
  return {
    ...(Object.hasOwn(request, 'functions') ? { functions: request.functions } : {}),
    ...(Object.hasOwn(request, 'requiresDirectUserAuthorization')
      ? { requiresDirectUserAuthorization: request.requiresDirectUserAuthorization } : {}),
  }
}

/* THE INVENTORY. `write` marks a command that changes state on this computer
   (a process, a record, a store, a session's allowlist); `dialog` marks one
   whose body opens a native dialog. tools/test/agent-command-surface.test.mjs
   derives the thirty channel names from shell/main.cjs and fails if this table
   and those handlers disagree in either direction. */
const COMMANDS = Object.freeze({
  'agent:availability': Object.freeze({ write: false, dialog: false }),
  'agent:confinement': Object.freeze({ write: false, dialog: false }),
  'agent:tools': Object.freeze({ write: false, dialog: false }),
  'agent:local-messages': Object.freeze({ write: false, dialog: false }),
  'agent:startable-tiers': Object.freeze({ write: false, dialog: false }),
  /* WHICH ACCOUNT EACH RUNNING SESSION IS ON. A read of a record the host
     already holds; it starts no session, no probe and no child process, and it
     is emphatically not a handover -- see the body. */
  'agent:session-accounts': Object.freeze({ write: false, dialog: false }),
  'agent:desktop-sessions': Object.freeze({ write: false, dialog: false }),
  'agent:desktop-tree': Object.freeze({ write: false, dialog: false }),
  'agent:desktop-transcript': Object.freeze({ write: false, dialog: false }),
  'agent:desktop-send': Object.freeze({ write: true, dialog: false }),
  'agent:desktop-stop': Object.freeze({ write: true, dialog: false }),
  'agent:desktop-stop-status': Object.freeze({ write: false, dialog: false }),
  'agent:history': Object.freeze({ write: false, dialog: false }),
  'agent:usage': Object.freeze({ write: false, dialog: false }),
  'agent:start': Object.freeze({ write: true, dialog: false }),
  'agent:switch': Object.freeze({ write: true, dialog: false }),
  'agent:continuations': Object.freeze({ write: true, dialog: false }),
  'agent:send': Object.freeze({ write: true, dialog: false }),
  /* Automatic recovery's own command: the same send path with the origin
     forced inside the surface (T658: the wrapper used to call a method the
     command table did not know, so the channel audit could not see it). */
  'agent:send-automatic': Object.freeze({ write: true, dialog: false }),
  'agent:work-status': Object.freeze({ write: false, dialog: false }),
  /* WHETHER THE SESSION THIS WINDOW SAVED IS STILL WORKING. A read: it starts
     nothing, resumes nothing and returns no path or text. */
  'agent:session-activity': Object.freeze({ write: false, dialog: false }),
  /* Re-register one running Page 2 circle at the address in the saved tree.
     This changes the local routing directory, starts nothing and opens no
     dialog. */
  'agent:tree-links': Object.freeze({ write: false, dialog: false }),
  'agent:tree-link': Object.freeze({ write: true, dialog: false }),
  'agent:tree-address': Object.freeze({ write: true, dialog: false }),
  'agent:tree-adopt': Object.freeze({ write: true, dialog: false }),
  'agent:request': Object.freeze({ write: true, dialog: false }),
  /* The person's hand on ONE standing rule: rewrite its words, or take it out
     of its ledger file. Writes (a ledger file changes), no dialog, and
     person-only on top of the write gate -- see PERSON_ONLY_REFUSAL. */
  'agent:request-edit': Object.freeze({ write: true, dialog: false }),
  'agent:request-remove': Object.freeze({ write: true, dialog: false }),
  /* The person's approve-or-decline of one record (a proposal an agent
     filed, or an open request they no longer want). Writes, no dialog, and
     person-only like the two rewrite verbs above. */
  'agent:request-decide': Object.freeze({ write: true, dialog: false }),
  /* THE PERSON'S RESOLUTION OF ONE STANDING REQUEST (R_LEDGER kinds
     follow-on, 2026-09-07, Controller 3 L4e). Writes, no dialog, person-only,
     the same shape as decide just above. */
  'agent:request-resolve': Object.freeze({ write: true, dialog: false }),
  /* THE LEDGER PAGE'S WRITE VERBS FOR TASK AND ASK RECORDS (ledger kinds,
     2026-09-07). Same shape as the three rewrite verbs just above: writes,
     no dialog, person-only. */
  'agent:task-complete': Object.freeze({ write: true, dialog: false }),
  'agent:task-remove': Object.freeze({ write: true, dialog: false }),
  'agent:ask-answer': Object.freeze({ write: true, dialog: false }),
  'agent:ask-decline': Object.freeze({ write: true, dialog: false }),
  /* The owner removes one ask outright, rather than answering or declining
     it (Worker 2's ledger-page commit 7c6b70e0 draws this as a fifth
     button). Same shape as the four verbs just above. */
  'agent:ask-remove': Object.freeze({ write: true, dialog: false }),
  'agent:requests': Object.freeze({ write: false, dialog: false }),
  /* The whole canonical ledger, every tier, for the Ledger page. A READ that
     creates nothing -- see shell/canonical-ledger-read.cjs. */
  'agent:ledger': Object.freeze({ write: false, dialog: false }),
  'agent:ledger-reset-preview': Object.freeze({ write: true, dialog: false }),
  'agent:ledger-reset-confirm': Object.freeze({ write: true, dialog: false }),
  'agent:ledger-custody-preview': Object.freeze({ write: true, dialog: false }),
  'agent:ledger-custody-confirm': Object.freeze({ write: true, dialog: false }),
  'agent:profiles': Object.freeze({ write: false, dialog: false }),
  'agent:profile-create': Object.freeze({ write: true, dialog: true }),
  'agent:profile-remove': Object.freeze({ write: true, dialog: false }),
  /* ISSUES an allowlist grant into the session: a write, and a dialog. */
  'agent:pick-attachment': Object.freeze({ write: true, dialog: true }),
  /* THE SECOND, AND ONLY OTHER, FEEDER OF THAT SAME ALLOWLIST -- for this
     command alone (Controller's ruling, verbatim: "the attachment allowlist
     gains a second feeder FOR THAT COMMAND ONLY"). A write, and NOT a
     `dialog` -- it opens no native dialog, so marking it one would make the
     dialog gate's own refusal sentence false. It is window-gated by its own
     body instead (windowOnly(), below), for the same reason pick-attachment
     is dialog-gated: the trust here is a real gesture at THIS keyboard, which
     a relay caller cannot supply no matter what it claims its bytes are. */
  'agent:paste-attachment': Object.freeze({ write: true, dialog: false }),
  /* Returns words for the renderer to insert; changes nothing, but it is a
     dialog, so it is gated on being at the keyboard. */
  'agent:pick-mention': Object.freeze({ write: false, dialog: true }),
  /* THE STANDING GOAL. A write, because setting one makes an agent start
     turns on its own; the read half travels on the same command so a person
     asking "what is the goal" and a person setting one cannot disagree about
     which session they mean. No dialog: it is typed in the composer. */
  'agent:goal': Object.freeze({ write: true, dialog: false }),
  'agent:interrupt': Object.freeze({ write: true, dialog: false }),
  'agent:reserve-send-now': Object.freeze({ write: true, dialog: false }),
  'agent:release-send-now': Object.freeze({ write: true, dialog: false }),
  'agent:approval-answer': Object.freeze({ write: true, dialog: false }),
  'agent:rewind': Object.freeze({ write: true, dialog: false }),
  'agent:effort': Object.freeze({ write: true, dialog: false }),
  'agent:models': Object.freeze({ write: false, dialog: false }),
  'agent:owner-context': Object.freeze({ write: false, dialog: false }),
  'agent:image-queue': Object.freeze({ write: true, dialog: false }),
  'agent:modes': Object.freeze({ write: false, dialog: false }),
  'agent:mode': Object.freeze({ write: true, dialog: false }),
  'agent:close': Object.freeze({ write: true, dialog: false }),
  'org:read': Object.freeze({ write: false, dialog: false }),
  'org:reparent': Object.freeze({ write: true, dialog: false }),
  'org:assign-role': Object.freeze({ write: true, dialog: false }),
  'org:ensure-seat': Object.freeze({ write: true, dialog: false }),
  'org:release-seat': Object.freeze({ write: true, dialog: false }),
  'org:create-role': Object.freeze({ write: true, dialog: false }),
  'org:edit-role': Object.freeze({ write: true, dialog: false }),
  'org:reset-role': Object.freeze({ write: true, dialog: false }),
  'org:reset': Object.freeze({ write: true, dialog: false }),
  'org:export': Object.freeze({ write: false, dialog: false }),
})

/* Every dependency a body closes over, by name and by kind. Enumerated from
   the handler bodies, not guessed; a missing one refuses construction. */
const REQUIRED_DEPS = Object.freeze({
  agentSessions: 'object',
  currentAgentHost: 'function',
  getAgentHost: 'function',
  agentIpcError: 'function',
  agentPayload: 'function',
  boundedAgentString: 'function',
  parseAgentStart: 'function',
  parseAgentSend: 'function',
  parseAgentSessionCommand: 'function',
  rendererSafeAgentError: 'function',
  spawnRecordAvailability: 'function',
  spawnRecordHistory: 'function',
  usageRecordHistory: 'function',
  engineAvailability: 'function',
  ensureWorkspaceRoot: 'function',
  chosenWorkspaceCwd: 'function',
  readAgentConfinement: 'function',
  listAgentTools: 'function',
  resolveCapabilityRoot: 'function',
  requireModule: 'function',
  readStandingRequests: 'function',
  readCanonicalLedger: 'function',
  sessionProfiles: 'object',
  recordSpawnIntent: 'function',
  recordSpawnOutcome: 'function',
  recordSessionEnd: 'function',
  bindAgentOwner: 'function',
  agentOrgRecord: 'object',
  dialog: 'object',
  MAX_SESSION_ID_LENGTH: 'number',
  AGENT_EFFORT_VALUES: 'object',
  WORKSPACE_ROOT: 'string',
})

function assertDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createAgentCommandSurface needs an explicit deps object')
  }
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    const value = deps[name]
    if (value === null || value === undefined || typeof value !== kind) {
      throw new Error('createAgentCommandSurface: missing or wrong-kind dependency: ' + name)
    }
  }
  if (!(deps.agentSessions instanceof Map)) {
    throw new Error('createAgentCommandSurface: agentSessions must be a Map')
  }
  if (typeof deps.dialog.showOpenDialog !== 'function') {
    throw new Error('createAgentCommandSurface: dialog must offer showOpenDialog')
  }
  if (!Array.isArray(deps.AGENT_EFFORT_VALUES)) {
    throw new Error('createAgentCommandSurface: AGENT_EFFORT_VALUES must be an array')
  }
  /* OPTIONAL for non-Electron callers, but never the wrong kind. main.cjs
     always supplies the facade's ring-buffer sink; a standalone caller that
     omits it gets an explicit counted drop instead of an event-loop failure.
     A wrong-kind value is a wiring mistake and refuses construction. */
  /* readAccountUsageCache is optional for the same reason and degrades the same
     way: without it the session-accounts report says the allowance check has
     not been read, which is exactly what it says on a computer where nobody has
     pressed Check allowances. An absent reader must never read as "everything
     is fine". */
  for (const name of ['detectLocal', 'emitRelayEvent', 'log', 'statFile', 'readAccountUsageCache', 'parseAgentPasteAttachment', 'savePasteAttachment', 'readWorkspaceState']) {
    if (deps[name] !== undefined && typeof deps[name] !== 'function') {
      throw new Error('createAgentCommandSurface: ' + name + ' must be a function when provided')
    }
  }
  /* parseAgentPasteAttachment, savePasteAttachment and MAX_PASTE_IMAGE_BYTES
     are OPTIONAL together: a build that does not wire paste-image support
     supplies none of them, and agent:paste-attachment refuses by name
     (MC_AGENT_PASTE_UNAVAILABLE) instead of crashing on a missing function or
     silently reading no size cap. Present but the wrong kind is still a
     wiring mistake and still refuses construction. */
  if (deps.MAX_PASTE_IMAGE_BYTES !== undefined && typeof deps.MAX_PASTE_IMAGE_BYTES !== 'number') {
    throw new Error('createAgentCommandSurface: MAX_PASTE_IMAGE_BYTES must be a number when provided')
  }
}

function validPrincipal(principal) {
  return Boolean(principal)
    && typeof principal === 'object'
    && typeof principal.kind === 'string' && principal.kind.length > 0
    && principal.owner !== null && principal.owner !== undefined
    && typeof principal.mayWrite === 'boolean'
    && typeof principal.label === 'string' && principal.label.length > 0
}

function createAgentCommandSurface(deps) {
  const recoveryStartDefaults = new Map()
  const pendingStartIds = new Set()
  const standaloneStarts = new Map()
  const standaloneSwitches = new Map()
  const { createStandaloneSwitchCoordinator } = require('./standalone-switch-coordinator.cjs')
  const standaloneCoordinator = createStandaloneSwitchCoordinator({
    claimSource(request, principal) {
      const owned = ownedAgentSession(principal, request.sourceSessionId)
      const retained = recoveryStartDefaults.get(request.sourceSessionId)
      if (!retained || retained.owner !== principal.owner || retained.kind !== principal.kind
        || typeof deps.standaloneSwitchHistory?.prepare !== 'function') {
        agentIpcError('AGENT_SWITCH_UNAVAILABLE', 'The original start and durable conversation are required to switch.')
      }
      const lease = currentAgentHost().claimStandaloneReplacement({ sessionId: request.sourceSessionId, ...request.target })
      owned.standaloneSwitchPending = true
      return {
        ...lease, defaults: { ...retained.defaults }, principal, original: owned,
        release() { lease.release(); owned.standaloneSwitchPending = false },
        cancel() { lease.cancel() },
        assertCurrent() {
          if (ownedAgentSession(principal, request.sourceSessionId) !== owned) {
            agentIpcError('AGENT_SWITCH_STALE', 'The source session ownership changed.')
          }
          lease.assertCurrent()
        },
      }
    },
    async startCandidate({ source, target, signal }) {
      const sessionId = require('node:crypto').randomUUID()
      const stop = () => source.cancel()
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      standaloneStarts.set(sessionId, { owner: source.principal.owner, lease: source })
      try {
        source.assertCurrent()
        const { cwd: retainedCwd, ...defaults } = source.defaults
        const result = await run('agent:start', {
          ...defaults, sessionId, tier: target.tier,
          ...(target.effort !== undefined ? { effort: target.effort } : {}),
        }, source.principal)
        if (result?.ok === false || result?.ended) agentIpcError('AGENT_SWITCH_CANDIDATE_UNCONFIRMED', 'The replacement did not become ready.')
        return { ...result, sessionId, principal: source.principal }
      } catch (error) {
        if (agentSessions.has(sessionId)) {
          try { await run('agent:close', { sessionId }, source.principal) }
          catch { error.cleanupRequired = true }
        }
        throw error
      } finally {
        standaloneStarts.delete(sessionId)
        signal.removeEventListener('abort', stop)
      }
    },
    closeCandidate: candidate => run('agent:close', { sessionId: candidate.sessionId }, candidate.principal),
    prepareHistory: ({ source, candidate, signal }) => deps.standaloneSwitchHistory.prepare({
      sourceSessionId: source.sourceSessionId, sessionId: candidate.sessionId, signal, assertCurrent: source.assertCurrent,
    }),
    rollbackHistory: history => deps.standaloneSwitchHistory.rollback(history),
    async commitReplacement({ source, candidate, history, assertCurrent }) {
      try { assertCurrent() } catch (error) {
        return { applied: false, sourceDisposition: 'retained', code: error.code }
      }
      const successor = ownedAgentSession(source.principal, candidate.sessionId)
      const issued = source.original.attachments instanceof Set ? new Set(source.original.attachments) : new Set()
      const result = await source.commit(candidate.sessionId, history)
      if (ownedAgentSession(source.principal, candidate.sessionId) !== successor) agentIpcError('AGENT_SWITCH_CLEANUP_REQUIRED', 'Successor custody changed during source retirement.')
      successor.attachments = issued
      source.original.ended = true
      source.original.state = 'ended'
      recordSessionEnd(source.original, source.sourceSessionId, 'switched')
      agentSessions.delete(source.sourceSessionId)
      try { await deps.standaloneSwitchHistory.commit(history) }
      catch (error) { error.sourceDisposition = 'retired'; throw error }
      return { ...result, attachmentsTransferred: true, attachmentCount: issued.size }
    },
  })

  const boundedWorkOwners = new Map()
  // Only the acknowledged first assignment can fill a standalone's missing
  // saved-node identity. The session record and its principal stay intact.
  const adoptedTreeNodes = new WeakMap()
  assertDeps(deps)
  const {
    agentSessions,
    currentAgentHost,
    getAgentHost,
    agentIpcError,
    agentPayload,
    boundedAgentString,
    parseAgentStart,
    parseAgentSend,
    parseAgentSessionCommand,
    rendererSafeAgentError,
    spawnRecordAvailability,
    spawnRecordHistory,
    usageRecordHistory,
    engineAvailability,
    ensureWorkspaceRoot,
    chosenWorkspaceCwd,
    readAgentConfinement,
    listAgentTools,
    resolveCapabilityRoot,
    requireModule,
    readStandingRequests,
    readCanonicalLedger,
    sessionProfiles,
    recordSpawnIntent,
    recordSpawnOutcome,
    recordAcceptedTranscriptSend = () => {},
    recordTranscriptBinding = () => {},
    recordSessionEnd,
    bindAgentOwner,
    agentOrgRecord,
    dialog,
    MAX_SESSION_ID_LENGTH,
    AGENT_EFFORT_VALUES,
    WORKSPACE_ROOT,
    emitRelayEvent,
    log,
    statFile,
    readAccountUsageCache,
    parseAgentPasteAttachment,
    savePasteAttachment,
    MAX_PASTE_IMAGE_BYTES,
  } = deps

  /* WHAT A TRANSCRIPT ROW IS ALLOWED TO SAY ABOUT A PICTURE: its file name and
     how big it is. Not its path -- that is the person's machine's business and
     a transcript is read elsewhere -- and not its bytes. A size that cannot be
     read is left out rather than guessed at, because a wrong number in a record
     is worse than a missing one. */
  async function attachmentSummaries(images) {
    const rows = []
    for (const image of Array.isArray(images) ? images : []) {
      if (!image || typeof image.path !== 'string' || !image.path) continue
      const name = path.basename(image.path)
      let bytes
      try {
        const stat = await statFile(image.path)
        if (stat && Number.isInteger(stat.size) && stat.size >= 0) bytes = stat.size
      } catch { /* a picture whose size cannot be read is still named */ }
      rows.push(bytes === undefined ? { name } : { name, bytes })
    }
    return rows
  }

  /* A PICTURE THIS DOOR WOULD ACCEPT AND THE SEND WOULD THROW AWAY.
   *
   * Both attachment doors used to hand back a path for any picture the app's
   * own 8 MiB write bound allowed. The Claude delivery path reads the file into
   * the turn and refuses anything over the engine's MAX_IMAGE_BYTES, so a
   * 3-to-8 MB screenshot became a chip in the composer, then a send that lost
   * the picture AND the person's words, and a sentence about the agent's
   * availability. See shell/provider-image-support.cjs for the measurement.
   *
   * ANSWERED, NOT THROWN. shell/main.cjs rendererSafeAgentError keeps a thrown
   * error's CODE and discards its message, so a thrown refusal could not name
   * this picture or these two sizes. Returning { ok: false, sentence } is the
   * shape both composer doors already read, so the person gets the one plain
   * sentence before anything is committed.
   *
   * null means "nothing to say": the provider is unknown (a paste held against
   * a conversation that is not running), this payload exports no ceiling, or
   * the picture fits. A provider that cannot take a picture AT ALL is also null
   * here -- sendTurn's own pictureNotSent sentence tells that person the true
   * reason, and a size would be a second, wrong one. */
  function pictureTooLargeToDeliver(session, name, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return null
    /* The model row the person chose is all this surface holds; the host owns
       the table that says which provider runs it. A host that does not offer
       the question (an older one, or a test double) answers undefined and the
       whole check stands down rather than guessing. */
    let provider = null
    try { provider = currentAgentHost().providerForTier?.(session && session.tier) ?? null }
    catch { return null }
    if (!provider) return null
    const engineLimit = providerImageSupport.deliverableImageBytes({
      requireModule, engineRoot: resolveCapabilityRoot(), join: path.join,
    })
    const limit = providerImageSupport.deliveryByteLimitFor(provider, engineLimit)
    if (limit === null || bytes <= limit) return null
    return {
      ok: false,
      code: 'MC_AGENT_IMAGE_TOO_LARGE_TO_DELIVER',
      sentence: providerImageSupport.pictureTooLargeSentence(name, bytes, limit),
    }
  }

  /* HOW FULL THIS MACHINE IS -- COUNTED IN LIVE SESSIONS, NOT MAP ENTRIES.
   *
   * A session that ends is DELIBERATELY left in agentSessions. main.cjs states
   * why above its onSessionExit hook: the entry has to outlive the child so a
   * Stop the person presses afterwards still resolves against something. That
   * is right, and this function does not change it.
   *
   * What was wrong is that capacity was read as `agentSessions.size` -- the raw
   * map, corpses included. So every child that died on its own burned a slot
   * for the life of the app process. Nothing deletes on exit: the only four
   * delete/clear sites are start-rollback, an explicit agent:close, the owner
   * WebContents being destroyed, and before-quit. A crash, an OOM kill, a
   * provider disconnect or a codex.exe killed from Task Manager all leak, and
   * the ceiling ratchets 8 -> 7 -> 6 with no way back short of quitting.
   *
   * IT IS WORSE THAN A COUNTER BEING WRONG, because of what the leak disables.
   * The renderer is never told a child died (the adapters' fail-closed path
   * emits no event), so a dead agent still draws as alive and nobody presses
   * the Stop that would reclaim it. And the automatic dead-session recovery
   * keys on MC_AGENT_UNKNOWN_SESSION, which is raised only when the map has NO
   * entry -- so the retained entry is exactly what stops the recovery firing.
   * The person is left with a refusal telling them to "wait for one to finish"
   * when nothing is running and waiting can never clear it.
   *
   * `ended` is the flag recordSessionEnd sets, and it is set for every terminal
   * path including a child that exited on its own. Reading it here is the whole
   * repair: entries stay for Stop, they just stop occupying the ceiling. */
  function openSessionCount() {
    let open = 0
    for (const session of agentSessions.values()) {
      if (session && session.ended !== true && session.state !== 'ended') open += 1
    }
    return open
  }

  /* A session belongs to the principal that started it, and to nobody else.
     This used to compare against event.sender; the comparison is the same,
     the left-hand side is now whatever identity the principal carries -- for
     the window, still event.sender. The refusal is unchanged in code and in
     sentence. */
  function ownedAgentSession(principal, sessionId) {
    const session = agentSessions.get(sessionId)
    if (!session || session.owner !== principal.owner) {
      agentIpcError('MC_AGENT_UNKNOWN_SESSION', 'Unknown sessionId: ' + sessionId)
    }
    /* Ownership is checked first so an unrelated principal cannot use this
       distinct refusal as an oracle for another person's ended session. */
    if (session.ended === true || session.state === 'ended') {
      agentIpcError(ENDED_SESSION_REFUSAL, 'Session has ended: ' + sessionId)
    }
    return session
  }

  /* A PASTE MADE BEFORE THE CONVERSATION IS RUNNING IN THIS RUN OF THE APP.
   *
   * MEASURED, 2026-09-07: the tree rail offers paste whenever the bridge
   * exposes it -- never gated on the session being live -- and it sends
   * `node.sessionId`, which for a saved conversation is an id minted in a
   * PREVIOUS run. This map does not hold it, so ownedAgentSession refused
   * before savePasteAttachment was ever called, and the renderer showed the
   * person the one sentence it has for an unrecognised code: "That pasted
   * image could not be attached." No file was ever written -- the app's
   * paste-attachments directory had never received one.
   *
   * So the file is saved and held against the CONVERSATION the window names,
   * and the binding to a session is deferred to send time, where
   * ownedAgentSession is checked exactly as before.
   *
   * WHAT THIS IS NOT. It is not a second, looser attachment door. Only the
   * window at the keyboard reaches this command at all (windowOnly, below the
   * same check it always had), a hold is remembered with the owner that made
   * it and only that owner may spend it, and spending it MOVES the path into
   * the session's own allowlist -- the same `session.attachments` set a picked
   * attachment lands in -- so a path is authorised once and by one rule. A
   * path nobody issued is refused by name as it always was. */
  const heldConversationAttachments = new Map()

  function holdAttachmentForConversation(holdKey, owner, filePath) {
    const existing = heldConversationAttachments.get(holdKey)
    if (existing && existing.owner === owner) { existing.paths.add(filePath); return }
    /* A hold belongs to one owner. A different owner naming the same
       conversation replaces it rather than joining it, so two owners can never
       share one hold. */
    heldConversationAttachments.set(holdKey, { owner, paths: new Set([filePath]) })
  }

  function heldAttachmentsFor(holdKey, owner) {
    const held = heldConversationAttachments.get(holdKey)
    return held && held.owner === owner ? held.paths : null
  }

  /* The live, owned, unfinished session for this id, or null -- never a
     refusal. Used only where a null has somewhere honest to go (the hold
     above). Ownership is still what decides: a session belonging to someone
     else answers null exactly like an absent one, so this cannot be used to
     ask whether another person's session exists. */
  function liveOwnedSessionOrNull(principal, sessionId) {
    const session = agentSessions.get(sessionId)
    if (!session || session.owner !== principal.owner) return null
    if (session.ended === true || session.state === 'ended') return null
    return session
  }

  /* The person's two seats, and nobody else: the window at the keyboard or
     the relay that is the signed-in person (its write consent is run()'s
     read-only gate, checked before any body). A principal of any other kind
     is refused the rewrite verbs by name, before its payload is read. */
  const ledgerCustody = createLedgerCustody({ resolveCapabilityRoot, requireModule })

  function personOnly(principal, command) {
    if (PERSON_KINDS.includes(principal.kind)) return
    agentIpcError(
      PRINCIPAL_REFUSAL,
      command + ' rewrites one of the person\'s own standing rules, and only the person may -- at this keyboard or signed in over the relay; '
        + principal.label + ' was refused.',
    )
  }

  async function resetLedger(operation, value, principal) {
    try {
      personOnly(principal, `agent:ledger-reset-${operation}`)
      const payload = agentPayload(value, operation === 'preview' ? ['kind'] : ['kind', 'revision', 'token'])
      if (!['R', 'T', 'A', 'P'].includes(payload.kind)) agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'Choose Tasks, Rules, Asks, or Purchases.')
      if (operation === 'confirm' && (!Number.isSafeInteger(payload.revision) || payload.revision < 0
          || typeof payload.token !== 'string' || !/^[a-f0-9]{64}$/.test(payload.token))) {
        agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'Review the current reset warning before confirming.')
      }
      const engineRoot = resolveCapabilityRoot()
      if (!engineRoot) return { ok: false, code: 'AGENT_LEDGER_RESET_UNAVAILABLE', reason: 'Ledger reset is unavailable. Update ToolsEnabled and try again.' }
      let service
      try { service = requireModule(path.join(engineRoot, PAYLOAD_LEDGER_RESET_MODULE)) } catch { /* unavailable payload */ }
      if (typeof service?.[operation] !== 'function') return { ok: false, code: 'AGENT_LEDGER_RESET_UNAVAILABLE', reason: 'Ledger reset is unavailable. Update ToolsEnabled and try again.' }
      return await service[operation]({ ...payload, actor: 'owner' })
    } catch (error) {
      const resetReasons = {
        R_LEDGER_RESET_STALE: 'The Ledger changed. Close this warning and review the current count.',
        OWNER_PROMPT_RESET_STALE: 'The purchase queue changed. Close this warning and review the current count.',
        R_LEDGER_RESET_EMPTY: 'There are no records left in this category to reset.',
      }
      if (Object.hasOwn(resetReasons, error?.code)) return { ok: false, code: error.code, reason: resetReasons[error.code] }
      throw rendererSafeAgentError(error)
    }
  }

  /* THE ONE GATE agent:paste-attachment NEEDS THAT NO TABLE FLAG ALREADY
     GIVES IT. Unlike personOnly() above (either of the person's two seats,
     window or relay), this command's whole safety case is a gesture at THIS
     window specifically -- see PASTE_WINDOW_REFUSAL. Checked first, before
     the payload is even parsed, the same posture personOnly() already holds
     for the two rewrite verbs. */
  function windowOnly(principal, command) {
    if (principal.kind === 'window') return
    agentIpcError(
      PASTE_WINDOW_REFUSAL,
      command + ' attaches bytes read from this window\'s own paste event, and ' + principal.label + ' is not this window, so it was refused.',
    )
  }

  function remoteDesktop(principal) {
    if (principal.kind !== 'relay') agentIpcError(PRINCIPAL_REFUSAL, 'Desktop conversations are opened here by the paired browser only.')
    if (!deps.desktopSessions) agentIpcError('MC_AGENT_CONNECTION_CLOSED', 'The computer connection is unavailable.')
    return deps.desktopSessions
  }
  const START_OUTCOME_ADMISSIONS = new Set(['not-admitted', 'unknown', 'admitted'])
  const START_OUTCOME_CLEANUP = new Set(['not-required', 'confirmed', 'pending'])
  const START_OUTCOME_CUSTODY = new Set(['none', 'session', 'cleanup-pending'])

  function startOutcomeForReader(value, sessionId) {
    const released = Boolean(value && typeof value === 'object' && (
      (value.admission === 'not-admitted' && value.cleanup === 'not-required' && value.custody === 'none') ||
      (value.admission === 'unknown' && value.cleanup === 'confirmed' && value.custody === 'none')
    ))
    const retained = Boolean(value && typeof value === 'object' && (
      (value.custody === 'session' && value.admission === 'admitted' && value.cleanup === 'not-required') ||
      (value.custody === 'cleanup-pending' && value.cleanup === 'pending')
    ))
    if (!value || typeof value !== 'object' || value.requestSessionId !== sessionId
        || !START_OUTCOME_ADMISSIONS.has(value.admission)
        || !START_OUTCOME_CLEANUP.has(value.cleanup)
        || !START_OUTCOME_CUSTODY.has(value.custody)
        || (!released && !retained)) return null
    return Object.freeze({
      requestSessionId: value.requestSessionId,
      admission: value.admission,
      cleanup: value.cleanup,
      custody: value.custody,
    })
  }

  // Recovery advice after an authority refusal, never a new admission rule.
  // Unchosen state proves neither a missing directory nor the failure's cause.
  // Keep the native cause in the audit; expose a curated code only when a fresh
  // authoritative read confirms this fact. Callers without the optional reader
  // retain the original refusal; main.cjs always supplies it.
  function startFailureForReader(error) {
    if (error?.code !== 'OWNER_HOST_PERMISSION_UNAVAILABLE' || !deps.readWorkspaceState) return error
    let workspace
    try { workspace = deps.readWorkspaceState() } catch { return error }
    if (workspace?.ok !== true || workspace.available !== true
        || workspace.configured !== true || workspace.chosen !== false) return error
    const code = 'AGENT_START_WORKSPACE_UNCONFIRMED'
    return Object.assign(new Error(code), { code })
  }

  const handlers = Object.freeze({
    'agent:desktop-sessions': async (_value, principal) => remoteDesktop(principal).list(principal),
    'agent:desktop-tree': async (_value, principal) => remoteDesktop(principal).tree(principal),
    'agent:desktop-transcript': async (value, principal) => remoteDesktop(principal).transcript(value, principal),
    'agent:desktop-send': async (value, principal) => remoteDesktop(principal).send(value, principal),
    'agent:desktop-stop': async (value, principal) => remoteDesktop(principal).stop(value, principal),
    'agent:desktop-stop-status': async (value, principal) => remoteDesktop(principal).stopStatus(value, principal),
    /* Availability is a READ, and deliberately the only agent command that
       starts nothing. EVERY condition a start needs, from the same values the
       start uses, IN THE ORDER THE START REFUSES IN: the recorder first,
       because recordSpawnIntent() runs before getAgentHost().startSession().
       `defaultCwd` is passed rather than defaulted so the probe validates the
       directory the session will actually run in, prepared by the same
       ensureWorkspaceRoot() getAgentHost() calls. */
    'agent:availability': async (value) => {
      agentPayload(value === undefined || value === null ? {} : value, [])
      const record = spawnRecordAvailability()
      if (record.ok !== true) return record
      const reading = engineAvailability({ defaultCwd: ensureWorkspaceRoot() })
      const codexCode = reading?.ok === true ? reading.codexCode : reading?.code
      if (!['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT'].includes(codexCode)
          || typeof deps.detectLocal !== 'function') return reading
      let localRuntime = null
      try { localRuntime = await deps.detectLocal() } catch { /* the original diagnosis remains valid */ }
      if (localRuntime?.ok !== true || localRuntime.ready !== true) localRuntime = null
      // Recheck both recording and common engine/account inputs after the
      // asynchronous read; a stale positive must not reopen a failed boundary.
      const currentRecord = spawnRecordAvailability()
      if (currentRecord.ok !== true) return currentRecord
      return engineAvailability({ defaultCwd: ensureWorkspaceRoot(), ...(localRuntime ? { localRuntime } : {}) })
    },

    /* What a session started here would be allowed to do. A tier name, a
       sandbox word and two counts; no path. */
    'agent:confinement': async () => {
      return readAgentConfinement({ capabilityRoot: resolveCapabilityRoot() })
    },

    /* The tool surface BY NAME. Registry identifiers only, never a path. */
    'agent:tools': async () => {
      return listAgentTools({ capabilityRoot: resolveCapabilityRoot() })
    },

    /* The messages this computer has already written down. A read of the
       owner journal; degrades to {ok:false, reason} rather than throwing,
       because "this build cannot read messages yet" and "the messages could
       not be read" are different things to be told. */
    'agent:local-messages': async (value) => {
      try {
        const engineRoot = resolveCapabilityRoot()
        if (!engineRoot) return { ok: false, reason: 'the live message reader is not available in this build' }
        const journal = requireModule(path.join(engineRoot, 'src', 'lib', 'providers', 'agent-comms-local.js'))
        /* Bounded here rather than trusted from the caller: a caller that can
           ask for everything is a caller that can be made to. */
        const limit = Number.isSafeInteger(value?.limit) ? Math.min(Math.max(value.limit, 1), 200) : 100
        if (value?.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)) {
          return { ok: false, reason: 'The message history position is invalid. Refresh messages to read the current history.' }
        }
        return await journal.ownerJournal({ limit, ...(value?.cursor === undefined ? {} : { cursor: value.cursor }) })
      } catch {
        return { ok: false, reason: 'the live message reader is not available in this build' }
      }
    },

    /* Which tiers this installation can actually start: the same
       resolveStartTier() the press runs, so the menu and the press agree. If
       the host cannot be built the call rejects with the app-owned authority
       refusal; a named session never falls back to an unbound provider path. */
    'agent:startable-tiers': async () => {
      const host = await getAgentHost()
      return host.startableTiers()
    },

    /* WHICH ACCOUNT EACH RUNNING AGENT IS ON, AND WHICH OF THEM ARE ON A SPENT
     * ONE. Read-only, twice over.
     *
     * THE DEFECT IT CLOSES. Nothing on this computer told a person which of
     * their sign-ins an agent was spending. The host chose an account for every
     * session it started and, since 2026-09-03, remembers it -- sessionAccounts()
     * -- and nothing consumed the answer. So a fleet of six agents on one
     * account that had reached the person's own limit looked exactly like a
     * fleet spread evenly across six, and the accounts menu could not say
     * otherwise.
     *
     * IT REPORTS AND IT MOVES NOTHING, and on this CLI it could not move
     * anything even if it wanted to: a Claude session's account is fixed for
     * the life of its process (measured 2026-09-03, capability/src/lib/
     * multi-account/handover.js states the two probes). The engine's
     * handoverReport() is a pure function of the rows and a usage answer -- no
     * clock, no file, no child process -- and this hands it both.
     *
     * IT STARTS NO PROGRAM. The allowance figures come from the LAST check the
     * person ran, read off the cache mc-accounts:list already hands the menu,
     * never from a fresh probe: a read that spawned one program per account
     * every time a page painted would be a background poll nobody started. When
     * there has been no check the report says so, session by session, rather
     * than answering an encouraging empty plan.
     *
     * NO PATH CROSSES. The host's rows carry `pinnedHome`, the confined
     * directory that session's credential is linked into, and it is dropped
     * here -- the same rule mc-providers:presence states for itself. What
     * crosses is a session id, a declared agent id the renderer already has in
     * its own URL, an account name and a program name.
     *
     * A HOST THAT WAS NEVER BUILT IS "NOTHING IS RUNNING", not a failure: the
     * host is built by the first start, so no host means no session, which is
     * the whole of the answer. It is deliberately not built here -- a read of
     * what is running must not be the thing that constructs the machinery for
     * running it. */
    'agent:session-accounts': async (_value, principal) => {
      const host = currentAgentHost()
      const rows = host && typeof host.sessionAccounts === 'function' ? host.sessionAccounts() : []
      const sessions = [...rows].map((row) => ({
        sessionId: row.sessionId,
        agentId: row.agentId ?? null,
        account: row.account,
        provider: row.provider ?? null,
      }))

      let report = null
      let reportReason = null
      try {
        const engineRoot = resolveCapabilityRoot()
        const loaded = engineRoot
          ? requireModule(path.join(engineRoot, 'src', 'lib', 'multi-account', 'handover.js'))
          : null
        if (loaded && typeof loaded.handoverReport === 'function') {
          /* AWAITED, because the cache read is a file read behind a queue.
             MEASURED 2026-09-03: shell/main.cjs hands in
             `readAccountUsageCache`, which is `accountUsageCacheOrder(async
             () => ...)` and therefore answers a PROMISE. Unawaited, the engine
             reader was handed that promise; `usage.ok` on it is undefined, so
             every call fell into the reader's "nothing was ever read" branch
             and named every running agent as unmeasured -- on a computer whose
             person had just run the check. "Nobody looked" reported where
             "looked, and here is where this agent would go" was the truth,
             which is the exact merge this report exists to prevent. `await`
             also passes a plain value straight through, so a caller that hands
             in a synchronous reader is unaffected. */
          const usage = typeof readAccountUsageCache === 'function' ? await readAccountUsageCache() : null
          report = loaded.handoverReport({ usage, sessions })
        } else {
          reportReason = 'this build cannot work out which accounts have run out'
        }
      } catch {
        reportReason = 'this build cannot work out which accounts have run out'
      }
      /* "The report could not be built" and "no agent needs to move" are
         different answers, so the reason travels rather than a null nobody can
         tell apart from a quiet fleet. The session list is still correct and
         still answered: which account each agent is on does not depend on the
         allowance check having run. */
      const recoveries = principal.mayWrite === true ? (host?.pendingAccountRecoveries?.() || []).filter(packet => {
        const original = recoveryStartDefaults.get(packet.sessionId)
        return original?.owner === principal.owner && original.kind === principal.kind
      }) : []
      return { ok: true, sessions, report, reportReason, recoveries }
    },

    /* What has actually run on this computer. Starts nothing. */
    'agent:history': async (value) => {
      const payload = agentPayload(value === undefined || value === null ? {} : value, ['limit', 'metrics'])
      if (payload.metrics !== undefined && !validateMetricsQuery(payload.metrics)) agentIpcError('METRICS_QUERY_INVALID', 'Choose a valid metrics period.')
      return spawnRecordHistory(payload.limit, payload.metrics)
    },

    /* What the turns on this computer cost. Starts nothing. */
    'agent:usage': async (value) => {
      const payload = agentPayload(value === undefined || value === null ? {} : value, ['limit', 'metrics'])
      if (payload.metrics !== undefined && !validateMetricsQuery(payload.metrics)) agentIpcError('METRICS_QUERY_INVALID', 'Choose a valid metrics period.')
      return usageRecordHistory(payload.limit, payload.metrics)
    },

    'agent:continuations': async (value, principal) => {
      try {
      if (principal.kind !== 'window') agentIpcError(PRINCIPAL_REFUSAL, 'Persistent recovery belongs to this application window.')
      const request = agentPayload(value, ['action', 'key', 'revision', 'requestKeys', 'treeIdentity', 'sessionId'])
      const host = await getAgentHost()
      if (request.action === 'read') return { ok: true, enabled: host.continuationEnabled?.() === true, records: host.pendingContinuations?.() || [] }
      if (request.action === 'direction') {
        const keys = request.requestKeys
        if (!keys || typeof keys.threadId !== 'string' || !keys.threadId || keys.threadId.includes('\0') || keys.threadId.length > 128
          || !Array.isArray(keys.treeAnchors) || keys.treeAnchors.length > 16
          || keys.treeAnchors.some(key => typeof key !== 'string' || !key || key.includes('\0') || key.length > 128)) agentIpcError('CONTINUATION_INVALID', 'Choose the current tree node.')
        if (request.sessionId != null) boundedAgentString(request.sessionId, 'sessionId', 128)
        return { ok: true, enabled: host.continuationEnabled?.() === true,
          ...host.continuationDirection({ sessionId: request.sessionId, requestKeys: keys }) }
      }
      const key = boundedAgentString(request.key, 'continuation key', 64)
      if (request.action === 'stop') return { ok: true, record: host.stopContinuation?.(key) }
      if (request.action === 'discard') {
        const session = ownedAgentSession(principal, request.sessionId)
        const result = await host.discardContinuation(key, request.sessionId, request.revision)
        recordSessionEnd(session, request.sessionId, 'closed')
        if (agentSessions.get(request.sessionId) === session) agentSessions.delete(request.sessionId)
        return result
      }
      if (request.action === 'attached') {
        ownedAgentSession(principal, request.sessionId)
        return await host.confirmContinuationAttachment(key, request.sessionId, request.revision)
      }
      if (request.action !== 'resume' || !Number.isSafeInteger(request.revision)) agentIpcError('CONTINUATION_INVALID', 'Choose a current saved continuation.')
      let startedRecord = null
      return await host.recoverContinuation({ key, revision: request.revision }, async descriptor => {
        if (!request.requestKeys || request.requestKeys.threadId !== descriptor.requestKeys?.threadId
          || request.requestKeys.treeAnchors?.[0] !== descriptor.requestKeys.treeAnchors?.[0]) {
          agentIpcError('CONTINUATION_INVALID', 'The saved continuation does not belong to this tree node.')
        }
        const next = Object.fromEntries(Object.entries(descriptor).filter(([field, value]) => value != null && !['agentId', 'cwd'].includes(field)))
        next.requestKeys = request.requestKeys
        next.treeIdentity = request.treeIdentity
        if (next.roleBinding) {
          const current = agentOrgRecord.read()
          const role = current?.roles?.find(row => row.id === next.roleBinding.id)
          if (current?.ok !== true || !role) agentIpcError('MC_AGENT_ROLE_UNAVAILABLE', 'The saved role is unavailable.')
          next.roleBinding = { ...next.roleBinding, expectedOrgRevision: current.org.revision, expectedRoleRevision: role.revision }
        }
        const result = await run('agent:start', next, principal)
        startedRecord = { sessionId: next.sessionId, session: agentSessions.get(next.sessionId) }
        return result
      }, sessionId => {
        if (startedRecord?.sessionId !== sessionId || !startedRecord.session) return
        recordSessionEnd(startedRecord.session, sessionId, 'closed')
        if (agentSessions.get(sessionId) === startedRecord.session) agentSessions.delete(sessionId)
      })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:start': async (value, principal) => {
      let request = parseAgentStart(value)
      const standaloneStart = standaloneStarts.get(request.sessionId)
      if (standaloneStart) {
        if (standaloneStart.owner !== principal.owner) agentIpcError('MC_AGENT_UNKNOWN_SESSION', 'Unknown replacement session.')
        standaloneStart.lease.assertCurrent()
        Object.defineProperty(request, 'standaloneReplacement', { value: standaloneStart.lease.startDescriptor })
      }
      if (request.continueFromAccount && principal.kind !== 'window') {
        agentIpcError('AGENT_MANUAL_ACCOUNT_CONTINUATION_WINDOW_ONLY', 'Continuing on another account requires the person at this application window.')
      }
      if (request.accountRetry && principal.kind !== 'window') {
        agentIpcError('AGENT_MANUAL_ACCOUNT_CONTINUATION_WINDOW_ONLY', 'Keep trying accounts belongs to the person at this application window.')
      }
      if (request.accountRecovery) {
        const previous = recoveryStartDefaults.get(request.replacesSessionId)
        if (!previous || previous.owner !== principal.owner || previous.kind !== principal.kind) {
          agentIpcError('AGENT_ACCOUNT_RECOVERY_UNAVAILABLE', 'The original agent start is unavailable to this caller.')
        }
        // Re-parse and re-resolve the role/profile through the ordinary gates.
        // The replacement supplies the current node address and ancestry.
        const inherited = { ...previous.defaults }
        if (!request.roleBinding && inherited.roleBinding) {
          const snapshot = agentOrgRecord.read()
          const original = inherited.roleBinding
          const role = snapshot?.roles?.find(entry => entry.id === original.id)
          const agent = original.agentId ? snapshot?.org?.agents?.find(entry => entry.id === original.agentId) : null
          if (snapshot?.ok !== true || !role || !Number.isSafeInteger(snapshot.org?.revision)
            || (original.agentId && (!agent || agent.enabled !== true || agent.role !== original.id))) {
            agentIpcError('AGENT_ACCOUNT_RECOVERY_UNAVAILABLE', 'The original role assignment changed or is unavailable. Review this agent before restarting it.')
          }
          inherited.roleBinding = { ...original, expectedOrgRevision: snapshot.org.revision, expectedRoleRevision: role.revision }
        }
        request = parseAgentStart({ ...inherited, ...request })
      }
      // Private host admission, created after parsing; it cannot be supplied
      // by a renderer/relay payload or serialized into the signed audit.
      const startAdmission = deps.startAdmission?.(principal, request) || null
      if (startAdmission) Object.defineProperty(request, 'startAdmission', { value: startAdmission })
      delete request.treeCommandRequestId
      startAdmission?.assertCurrent()
      const retainedDefaults = Object.fromEntries(['tier', 'effort', 'cwd', 'profileId', 'roleBinding']
        .filter(key => request[key] !== undefined).map(key => [key, request[key]]))
      if (request.roleBinding) {
        /* THE RENDERER CHOOSES A ROW; THE STORES SUPPLY ITS WORDS. A nested
           packet containing arbitrary directions never crosses parseAgentStart
           in main.cjs, and this second boundary re-reads both revisions before
           any spawn record or child process exists. `request.role` is therefore
           an authoritative main-process value, not renderer instruction text. */
        const resolved = typeof agentOrgRecord.resolveRoleBinding === 'function'
          ? agentOrgRecord.resolveRoleBinding(request.roleBinding)
          : null
        if (!resolved || resolved.ok !== true || !resolved.role) {
          const code = typeof resolved?.code === 'string' && resolved.code.startsWith('MC_AGENT_ROLE_')
            ? resolved.code
            : 'MC_AGENT_ROLE_UNAVAILABLE'
          agentIpcError(
            code,
            resolved?.reason || 'The selected role could not be read from this computer. Read the Role library again, then retry the start.',
          )
        }
        if (resolved.agent) {
          request.agentId = resolved.agent.id
          request.agentAuthority = resolved.authority
        }
        request.role = resolved.role
        if (resolved.roleSelection === '') request.roleSelection = ''
        delete request.roleBinding
      }
      if (request.profileId) {
        /* Resolved HERE, not in the caller and not in the host: the store only
           holds folders the person picked through the OS dialog, and a stale
           or unknown profile refuses the start loudly instead of spawning an
           agent somewhere nobody chose. profileId is authoritative when
           present. */
        try {
          request.cwd = sessionProfiles.resolveCwd(request.profileId)
        } catch (error) {
          agentIpcError(
            'MC_AGENT_' + (typeof error?.code === 'string' ? error.code : 'PROFILE_UNKNOWN'),
            'That session profile could not be used: pick the folder again in its settings.',
          )
        }
        delete request.profileId
      }
      if (standaloneStart) {
        standaloneStart.lease.assertCurrent()
        request.cwd = standaloneStart.lease.source.cwd
      }
      const recoveredCwd = deps.recoveryStartCwd?.(request, principal)
      if (recoveredCwd !== undefined) request.cwd = recoveredCwd
      /* A START THAT NAMES NO FOLDER RUNS IN THE ONE THE PERSON CHOSE IN SETUP.
         Resolved BEFORE recordSpawnIntent below, so the signed record and the
         app-local record both carry the real folder instead of cwd:null, and
         so the confinement the host binds at spawn anchors on the chosen
         folder. A profile pick above still wins. */
      if (request.cwd === undefined) {
        const chosen = chosenWorkspaceCwd()
        if (chosen) request.cwd = chosen
      }
      if (agentSessions.has(request.sessionId) || pendingStartIds.has(request.sessionId)) {
        agentIpcError('MC_AGENT_SESSION_EXISTS', 'Session already exists: ' + request.sessionId)
      }
      if (request.editorForkReceipt !== undefined) {
        if (principal.kind !== 'window' || typeof deps.redeemEditorFork !== 'function') {
          agentIpcError('EDITOR_FORK_WINDOW_ONLY', 'An editor copy needs a source selected in this application window.')
        }
        const editorFork = deps.redeemEditorFork(request.editorForkReceipt, request, principal)
        delete request.editorForkReceipt
        // Private source paths/functions never ride audit packets or replies.
        Object.defineProperty(request, 'editorFork', { value: editorFork })
      }
      if (request.delegationToken !== undefined) {
        if (typeof deps.redeemTreeDelegation !== 'function') {
          agentIpcError('TREE_DELEGATION_REFUSED', 'This build cannot verify the parent of this agent.')
        }
        const permit = deps.redeemTreeDelegation(request.delegationToken, request, principal)
        if (permit?.researchAccess) {
          Object.defineProperty(request, 'researchPermit', { value: permit })
          request.cwd = permit.researchAccess.root
        } else request.delegationPermit = permit
        delete request.delegationToken
      }
      if (request.researchSetup !== undefined) {
        if (principal.kind !== 'window') agentIpcError('RESEARCH_SETUP_WINDOW_ONLY', 'Research clean-room setup requires its owning application window.')
        if (request.researchSetup !== true || request.research?.mode !== 'clean-room'
            || request.researchPermit || typeof deps.prepareResearchSetup !== 'function') {
          agentIpcError('RESEARCH_DELEGATION_REFUSED', 'This application cannot prepare a new research clean room.')
        }
      }
      if (request.research !== undefined && !request.researchPermit && request.researchSetup !== true) {
        agentIpcError('RESEARCH_DELEGATION_REFUSED', 'Research access requires a verified one-use child start permit.')
      }
      if (request.boundedWork !== undefined) {
        if (principal.kind !== 'window' || typeof deps.beginBoundedTreeStart !== 'function') agentIpcError('MC_TREE_BOUNDED_WORK_REFUSED', 'Bounded work requires this tree\'s owning local window.')
        request.boundedWorkPermit = deps.beginBoundedTreeStart(request, principal)
      }
      const inheritedWork = deps.inheritBoundedTreeStart?.(request, principal)
      if (inheritedWork) request.boundedWorkPermit = inheritedWork
      let treeStartAttempt = null
      try { treeStartAttempt = deps.beginTreeStart?.(request, principal) || null }
      catch (error) { request.delegationPermit?.cancel(); request.boundedWorkPermit?.cancel(); throw rendererSafeAgentError(error) }
      /* THERE IS NO CEILING ON HOW MANY AGENTS MAY BE RUNNING AT ONCE.
       *
       * There used to be: eight, refused by name. The owner's ruling,
       * 2026-09-03: "THERE WAS NEVER SUPPOSED TO BE A SESSION LIMIT SOME AGENT
       * STARTED THAT AND I HAVE BEEN FIGHTING THAT RULE FOR AGES." It was never
       * a product decision; it arrived in a lane and then outlived every
       * argument for it.
       *
       * It is gone rather than raised, because a number nobody chose is the
       * same defect at a different value: a person building a tree of twelve
       * workers would meet it again at whatever the new figure was. This
       * product's rule is that the person decides and the software says what
       * it knows -- so the count is still reported (sessionLoad below, the
       * remote-status body, the page's own reading) and nothing is refused for
       * it. What actually bounds a fleet is the machine it runs on, and that
       * announces itself honestly: starts get slower.
       *
       * Every other gate on a start is untouched. This removed a ceiling, not
       * a permission check. */

      /* Before anything is spawned. If this throws, no process was created and
         nothing needs unwinding -- which is why it comes first. */
      /* AWAITED. recordSpawnIntent's canonical half now runs on the ledger's
         own thread (shell/canonical-audit.cjs), because on this one it was a
         synchronous powershell.exe per anchored admission -- the measured
         fifteen-second window freeze. The ORDER is untouched and is what the
         suites pin: the record is established before startSession is reached,
         and a refused record still throws before anything is spawned. */
      let record
      // The audit is asynchronous, before agentSessions owns an entry. Reserve
      // the id across that await so a second caller cannot overwrite ownership
      // and then delete the live child's only outer handle when its start fails.
      let researchSetupPermit = null
      let researchSetupHost = null
      let researchSetupStarted = false
      pendingStartIds.add(request.sessionId)
      try {
        if (request.researchSetup === true) {
          startAdmission?.assertCurrent()
          researchSetupPermit = deps.prepareResearchSetup(request, principal)
          if (!researchSetupPermit?.researchAccess
              || !['assertStart', 'verifyStarted', 'finish'].every(key => typeof researchSetupPermit[key] === 'function')) {
            agentIpcError('RESEARCH_DELEGATION_REFUSED', 'The research setup authority returned no usable start permit.')
          }
          delete request.researchSetup
          Object.defineProperty(request, 'researchPermit', { value: researchSetupPermit })
          request.cwd = researchSetupPermit.researchAccess.root
          researchSetupPermit.assertStart()
        }
        record = await recordSpawnIntent(request)
      } catch (error) {
        pendingStartIds.delete(request.sessionId)
        // This gate precedes the host-start catch below. Electron drops custom
        // Error properties, so preserve its code through the same safe message
        // channel without forwarding private vault/audit diagnostics. No session
        // exists yet and a refusal must never proceed to host creation.
        request.delegationPermit?.cancel()
        request.boundedWorkPermit?.cancel()
        treeStartAttempt?.done()
        if (researchSetupPermit) {
          try { researchSetupPermit.finish({ failed: true }) }
          catch { agentIpcError('AGENT_SESSION_CLEANUP_FAILED', 'The refused research setup could not clean its private room.') }
        }
        throw rendererSafeAgentError(error)
      }

      /* `turnsCompleted` starts at ZERO, not undefined, because zero is the
         true count for a session that is stopped before it ever answered. The
         owner is the principal's identity -- for the window, event.sender,
         exactly as before. `ownerKind` remembers WHAT KIND of principal that
         identity is, because the event fan-out must route by it: a window
         owner is a WebContents that can be sent to and destroyed, a relay
         owner is a stable token that is neither. */
      /* The renderer cannot set this field: it is present only after the
       * authoritative role binding above resolved an exact organisation agent.
       * Keep it with the session so an eventual end record names the same actor
       * as its signed intent and outcome. */
      const session = {
        owner: principal.owner,
        ownerKind: principal.kind,
        attachments: new Set(),
        // Captured after profile/setup resolution; never consult a later pick
        // when identifying a file changed by this session.
        cwd: request.cwd || null,
        // Retain the selected ID for native file review; no renderer path is a grant.
        profileId: typeof retainedDefaults.profileId === 'string' ? retainedDefaults.profileId : null,
        metricsPrincipal: record?.principal || null,
        usageAuditRequired: record.disposition !== 'not-required',
        agentId: typeof request.agentId === 'string' && request.agentId.length > 0 ? request.agentId : null,
        // Trusted output of resolveRoleBinding above, never a renderer claim.
        // The resource host needs this immutable binding to recognise another
        // already-running controller even when it has a different seat id.
        agentAuthority: request.agentAuthority ? Object.freeze({ ...request.agentAuthority }) : null,
        state: 'starting',
        turnsCompleted: 0,
        lastTurnStatus: null,
        ended: false,
        ...(request.boundedWorkPermit ? { boundedWork: request.boundedWorkPermit.details } : {}),
      }
      if (request.delegationPermit || request.researchPermit) {
        // Private attempt identity, never serialized into audit/renderer state.
        Object.defineProperty(session, 'treeDelegationStart', { value: request.researchPermit || request.delegationPermit })
      }
      if (request.researchPermit) session.researchRestriction = request.researchPermit.researchAccess
      if (principal.kind === 'window' && deps.currentRelayOwner) {
        Object.defineProperties(session, {
          pairingOwner: { value: deps.currentRelayOwner() },
          desktopName: { value: request.treeIdentity?.selfName || null },
        })
      }
      const startedTreeNodeId = request.requestKeys?.threadId || null
      Object.defineProperties(session, {
        treeNodeId: { get: () => startedTreeNodeId || adoptedTreeNodes.get(session) || null },
        treeLifecycleTarget: { value: treeStartAttempt?.lifecycleTarget || null },
      })
      agentSessions.set(request.sessionId, session)
      deps.sessionCreated?.(request, session, principal)
      pendingStartIds.delete(request.sessionId)
      if (!request.boundedWorkPermit && !request.researchPermit) recoveryStartDefaults.set(request.sessionId, { owner: principal.owner, kind: principal.kind, defaults: retainedDefaults })
      if (recoveryStartDefaults.size > 512) recoveryStartDefaults.delete(recoveryStartDefaults.keys().next().value)
      boundedWorkOwners.delete(request.sessionId)
      if (request.boundedWorkPermit) boundedWorkOwners.set(request.sessionId, { session, record })
      /* The destroyed hook is a fact about a WINDOW's owner: when its
         WebContents dies the app is on its way out and the sessions end with
         it. A relay principal's owner has no 'destroyed' event, and the
         design (§5.1) requires the opposite lifetime -- a dropped tab or a
         lease expiry must NOT kill remote sessions -- so for a relay
         principal the bind is deliberately a no-op and the session simply
         stays owned by the relay principal's stable owner token. */
      let hostInvocationAttempted = false
      try {
        startAdmission?.assertCurrent()
        if (principal.kind !== 'relay') bindAgentOwner(principal.owner)
        const host = await getAgentHost()
        startAdmission?.assertCurrent()
        request.delegationPermit?.assertStart('standard')
        request.researchPermit?.assertStart()
        if (request.agentAuthority) {
          // Audit and host readiness can yield to a sibling seat declaration.
          // Re-read only an identity this invocation already validated, keeping
          // its exact seat, provider, role and role revision. The renderer's
          // original revision check remains above, before audit. No await may
          // separate this refresh from the host's fresh admission below.
          const selected = request.agentAuthority
          const current = agentOrgRecord.read()
          const refreshed = current?.ok === true && Number.isSafeInteger(current.org?.revision)
            ? agentOrgRecord.resolveRoleBinding({ agentId: selected.agentId, id: selected.roleId,
              ...(request.roleSelection === '' ? { selection: '' } : {}),
              expectedOrgRevision: current.org.revision, expectedRoleRevision: selected.expectedRoleRevision }) : null
          if (refreshed?.ok !== true || refreshed.roleSelection !== request.roleSelection
            || !isDeepStrictEqual(refreshed.role, request.role) || refreshed.agent?.id !== selected.agentId
            || !['agentId', 'provider', 'roleId', 'expectedRoleRevision'].every(key => refreshed.authority?.[key] === selected[key])) {
            agentIpcError('MC_AGENT_ROLE_STALE', 'The selected agent assignment or role changed while this start was being prepared. Review it before retrying.')
          }
          request.agentAuthority = refreshed.authority
          session.agentAuthority = Object.freeze({ ...refreshed.authority })
        }
        deps.beforeHostStart?.(request, principal)
        hostInvocationAttempted = true
        if (researchSetupPermit) researchSetupHost = host
        const result = await host.startSession(request)
        if (researchSetupPermit) {
          researchSetupStarted = true
          if (result?.ok === false || result?.ended === true) {
            agentIpcError('RESEARCH_DELEGATION_REFUSED', 'The research clean-room session did not become available.')
          }
          researchSetupPermit.verifyStarted()
        }
        if (result?.ok !== false && !result?.ended && !request.boundedWorkPermit && !request.researchPermit && principal.kind === 'window') {
          host.rememberContinuation?.(request.sessionId, retainedDefaults)
        }
        if (result?.ok !== false && request.requestKeys?.threadId) {
          try { await recordTranscriptBinding({ sessionId: request.sessionId, nodeId: request.requestKeys.threadId,
            treeId: request.requestKeys.treeAnchors?.[0] || null }) }
          catch { /* Persistence reports separately; an accepted start must not be retried. */ }
        }
        /* A transport may replay an already-observed child exit before this
           await resumes. Preserve that terminal state instead of reviving the
           outer command-surface entry. */
        session.state = session.exitedBeforeStarted === true ? 'ended' : 'ready'
        if (session.state === 'ready') {
          // Retention is not permission to claim a successful start twice. If
          // no authoritative tree record exists yet, later tree-address/close
          // may retain it; unknown stopped nodes refuse delegated replacement.
          try { deps.rememberTreeAdmission?.(request.sessionId) } catch { /* Lifecycle remains unavailable for this admission. */ }
        }
        /* `request.tier`, NOT `result.tier`: the request's is the MODEL ROW a
           person chose, the result's is the CONFINEMENT level. See the usage
           record for why the two were once confused. */
        session.tier = typeof request.tier === 'string' ? request.tier : null
        session.account = typeof result.account === 'string' ? result.account : null
        /* A RESUME DOES NOT START A CONVERSATION AT TURN ZERO.
           `turnsCompleted` above is seeded 0 for the reason its own comment
           gives -- true for a session that never answered. A resumed session
           already has answers: `result.resumed.turnCount` is the engine's own
           count of the thread it just restored (see agent-host.cjs's own
           `resumed` block, `turnCount: Number.isFinite(startedValue.turnCount)
           ? startedValue.turnCount : 0`). Left at 0 here, this session's own
           end record would report `turns` as only what happened AFTER the
           resume -- the prior conversation silently dropped from the one field
           that is supposed to say how long a run went. Seeded before
           `recordSpawnOutcome`/`session.started` below, so even a resume whose
           child had already exited before this await resumed (the
           `exitedBeforeStarted` branch a few lines down, which ends the
           session immediately) reports the true count rather than 0. */
        if (result.resumed && Number.isSafeInteger(result.resumed.turnCount) && result.resumed.turnCount > 0) {
          session.turnsCompleted = result.resumed.turnCount
        }
        recordSpawnOutcome(request, record, 'started', null)
        /* The start this session's ending will resolve; set only after
           `started` is written, because a refused start has no run to end. If
           the child was already reported gone, that ending is written here. */
        session.started = record.disposition === 'not-required' ? (record.audit || record) : { sequence: record.sequence }
        if (session.exitedBeforeStarted === true) {
          recordSessionEnd(session, request.sessionId, session.observedEndReason || 'exited')
          if (agentSessions.get(request.sessionId) === session) agentSessions.delete(request.sessionId)
        }
        researchSetupPermit?.finish({ failed: false })
        return {
          ...result,
          ...(session.researchRestriction ? { researchRestriction: session.researchRestriction } : {}),
          ...(session.exitedBeforeStarted === true
            ? { ended: true, endCode: ENDED_SESSION_REFUSAL }
            : {}),
          record: record.disposition === 'not-required' ? (record.audit || record) : { sequence: record.sequence, eventHash: record.eventHash },
          audit: record.disposition === 'not-required' ? (record.audit || record) : { sequence: record.sequence, eventHash: record.eventHash },
        }
      } catch (error) {
        let researchCleanupConfirmed = false
        if (researchSetupPermit) {
          const failedStart = startOutcomeForReader(error?.startOutcome, request.sessionId)
          let cleaned = !hostInvocationAttempted || failedStart?.custody === 'none'
          if (researchSetupStarted) {
            try {
              const closed = await researchSetupHost.closeSession({ sessionId: request.sessionId })
              cleaned = closed?.closed === true && closed.sessionId === request.sessionId
              researchCleanupConfirmed = cleaned
            } catch { cleaned = false }
          }
          try { researchSetupPermit.finish({ failed: cleaned }) }
          catch { cleaned = false }
          researchCleanupConfirmed &&= cleaned
          if (!cleaned) error = Object.assign(new Error('The research session or its private room could not be cleaned after startup failed.'),
            { code: 'AGENT_SESSION_CLEANUP_FAILED' })
        }
        const outcome = startOutcomeForReader(error?.startOutcome, request.sessionId)
        const ownsSession = agentSessions.get(request.sessionId) === session
        const hostOutcomeUnknown = hostInvocationAttempted && !outcome && !researchCleanupConfirmed
        if (ownsSession && (outcome?.custody === 'cleanup-pending'
          || outcome?.custody === 'session'
          || error?.code === 'AGENT_SESSION_CLEANUP_FAILED'
          || hostOutcomeUnknown)) {
          /* Once host.startSession was invoked, an opaque, mismatched or
             contradictory reply proves neither non-admission nor cleanup.
             Keep the exact owner record for a later authoritative close. */
          session.state = 'close-failed'
        } else if (outcome?.custody === 'none' || researchCleanupConfirmed || !hostInvocationAttempted) {
          /* A pre-host refusal, a host-owned no-custody outcome or a confirmed
             research close releases only the record this invocation owns. */
          if (ownsSession) agentSessions.delete(request.sessionId)
        }
        request.delegationPermit?.cancel()
        /* Recorded BEFORE the throw, because the throw leaves this process and
           the reason is only in scope here. */
        recordSpawnOutcome(request, record, 'refused', typeof error?.code === 'string' ? error.code : null,
          typeof error?.message === 'string' ? error.message : null)
        const failure = startFailureForReader(error)
        const safe = rendererSafeAgentError(failure)
        const exhaustedBy = safe?.exhaustedBy === 'provider' || safe?.exhaustedBy === 'configured'
          ? safe.exhaustedBy
          : undefined
        if (outcome) {
          return {
            ok: false,
            sessionId: request.sessionId,
            code: typeof failure?.code === 'string' ? failure.code : 'AGENT_START_FAILED',
            reason: safe.message,
            startOutcome: outcome,
            ...(outcome.custody === 'cleanup-pending' ? { cleanupPending: true } : {}),
            ...(exhaustedBy ? { exhaustedBy } : {}),
            ...(error?.accountRetry ? { accountRetry: error.accountRetry } : {}),
          }
        }
        if (request.accountRetry && error?.code !== 'AGENT_SESSION_CLEANUP_FAILED'
            && !hostInvocationAttempted) {
          return { ok: false, code: typeof failure?.code === 'string' ? failure.code : 'AGENT_START_FAILED', reason: safe.message,
            ...(exhaustedBy ? { exhaustedBy } : {}),
            ...(error?.accountRetry ? { accountRetry: error.accountRetry } : {}) }
        }
        throw safe
      } finally {
        treeStartAttempt?.done()
      }
    },

    'agent:send-automatic': async (value, principal) => handlers['agent:send'](value, principal, true, 'automatic'),
    'agent:send': async (value, principal, tracked = false, forcedOrigin = 'person') => {
      let deliveryDisposition = 'not-sent'
      try {
        const request = parseAgentSend(value)
        const session = ownedAgentSession(principal, request.sessionId)
        /* THE SECURITY LINE FOR IMAGES: the caller can never name an arbitrary
           disk path for the engine to read into model context. Only paths a
           person picked in this session's own native dialog ride -- anything
           else refuses by name, whether typed, guessed or replayed from
           another session. The allowlist is fed by exactly one command,
           agent:pick-attachment, which requires the same ownership this check
           does, so under a principal the fence reads: only paths issued by
           THIS principal's own picker for THIS session. */
        if (request.images && request.images.length) {
          const issued = session.attachments instanceof Set ? session.attachments : new Set()
          // Prestart images must be adopted through a private draft grant.
          // A window/hold key alone cannot authorize forwarding an old path.
          const holdKey = typeof request.holdKey === 'string' && request.holdKey ? request.holdKey : null
          const held = holdKey ? heldAttachmentsFor(holdKey, principal.owner) : null
          for (const image of request.images) {
            if (issued.has(image.path)) continue
            if (held?.has(image.path)) {
              agentIpcError('IMAGE_CUSTODY_REPICK_REQUIRED', 'This held image has no verified draft grant. Keep the message and pick its images again.')
            }
            agentIpcError('MC_AGENT_ATTACHMENT_UNKNOWN', 'An attached file was not picked in this session, so nothing was sent')
          }
        }
        /* ORIGIN: A PERSON TYPED THIS. Every caller of this command is a
           person at a keyboard -- the window principal, or the relay
           principal that IS the signed-in person on another device. The
           host spools a person's words (with agent filing on) and never an
           agent's; the tree pump tags its own turns 'agent' from inside the
           host, so this is the only place 'person' is ever said. */
        const turnRequest = {
          sessionId: request.sessionId,
          text: request.text,
          ...(request.images ? { images: request.images } : {}),
          ...(request.model ? { options: { model: request.model } } : {}),
          origin: forcedOrigin,
        }
        deliveryDisposition = 'unknown'
        const delivery = tracked ? await currentAgentHost().sendTurnTracked(turnRequest) : null
        if (tracked && !delivery.ok) return delivery
        const result = tracked ? delivery.result : await currentAgentHost().sendTurn(turnRequest)
        deliveryDisposition = 'accepted'
        if (result?.ok !== false) {
          /* A PICTURE THAT RODE THIS TURN LEAVES A TRACE, AND SO DOES ONE THAT
             DID NOT. Before T18 this record carried sessionId, text, turnId and
             nothing else, so a turn that carried a picture and a turn that did
             not were the same row -- and a refused picture was not a row at all,
             it was a rejected IPC call painted in the window and gone. Name and
             byte count only: the path is the person's machine's business and
             the name is what they recognise on their own screen. */
          const attachments = await attachmentSummaries(request.images)
          try {
            await recordAcceptedTranscriptSend({
              sessionId: request.sessionId, text: request.text, turnId: result?.turnId || null,
              ...(forcedOrigin !== 'person' ? { origin: forcedOrigin } : {}),
              ...(result?.transcriptPrompt ? { transcriptPrompt: result.transcriptPrompt } : {}),
              ...(attachments.length && !result?.pictureNotSent ? { attachments } : {}),
              ...(result?.pictureNotSent ? { pictureNotSent: { ...result.pictureNotSent, attachments } } : {}),
            })
          }
          catch { /* The transcript service reports persistence failures. The accepted provider turn must not be retried. */ }
        }
        /* A MODEL SWITCH MOVES THIS SESSION'S RECORDED TIER WITH IT.
         *
         * `session.tier`, set once at start two screens up, is the ONLY thing
         * that labels every row this app signs into agent-turn-usage-
         * records.jsonl for the life of this session (shell/main.cjs
         * noteAgentTurnUsage -> usageLabel('tier', session.tier)). "Switch
         * model" sends a per-turn override that the host actually applies and
         * that STAYS applied (src/fleet-tree-copy.js MODEL_PANEL.next: "until
         * you change it back") -- so without this line, every turn after a
         * switch was signed into that ledger under the tier the session merely
         * started on, permanently, in a chain nothing downstream can correct.
         *
         * `result.tier` is present only when sendTurn() actually resolved a
         * requested override against the real tier table (shell/agent-
         * host.cjs, tierForModel()) -- never guessed here from request.model,
         * which is an unvalidated model string until the host says otherwise. */
        if (typeof result.tier === 'string') {
          session.tier = result.tier
          const retained = recoveryStartDefaults.get(request.sessionId)
          if (retained) retained.defaults.tier = result.tier
        }
        return tracked ? { ok: true, result, deliveryDisposition } : result
      } catch (error) {
        if (tracked) return { ok: false, code: error?.code || 'AGENT_SEND_FAILED', deliveryDisposition }
        throw rendererSafeAgentError(error)
      }
    },

    'agent:tree-links': async () => {
      try { return currentAgentHost().treeLinks() }
      catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:tree-link': async (value, principal) => {
      // Only the person at this native window creates cross-tree authority.
      // An agent cannot grant itself a new peer through its command channel.
      if (principal.kind !== 'window') agentIpcError(PRINCIPAL_REFUSAL, 'Only the user at this native window can create or remove direct tree links.')
      try {
        const payload = agentPayload(value, ['from', 'to', 'connected'])
        if (typeof payload.connected !== 'boolean') agentIpcError('TREE_LINK_INVALID', 'Say whether this link is connected.')
        return currentAgentHost().setTreeLink({
          from: boundedAgentString(payload.from, 'from', 128),
          to: boundedAgentString(payload.to, 'to', 128),
          connected: payload.connected,
        })
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:work-status': async (value, principal) => {
      const payload = agentPayload(value, ['sessionId'])
      const sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
      const retained = boundedWorkOwners.get(sessionId)
      if (!retained || retained.session.owner !== principal.owner || retained.session.ownerKind !== principal.kind) {
        return { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' }
      }
      const status = currentAgentHost()?.boundedWorkStatus?.(sessionId)
      if (!status) return { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' }
      return { ok: true, ...status,
        record: retained.record.disposition === 'not-required' ? (retained.record.audit || retained.record) : { sequence: retained.record.sequence, eventHash: retained.record.eventHash },
        audit: retained.record.disposition === 'not-required' ? (retained.record.audit || retained.record) : { sequence: retained.record.sequence, eventHash: retained.record.eventHash },
        endRecord: retained.session.endRecord || null }
    },

    /* THE ONE THING A RELOADED PAGE CANNOT KNOW ABOUT ITS OWN HOST.
       Page 2's session map is module-local and dies with the renderer, while
       the agent it was routing to keeps working. Reconnecting needs the host's
       own answer to "is this session mine, is it busy, and how did its last
       turn end": ownership and liveness come from ownedAgentSession, exactly
       as send and close take them; busy/closing from the host's existing
       sessionActivity; and lastTurnStatus is the provider's own verbatim word,
       already maintained on this session by noteAgentTurnCompleted, so no
       reader has to infer an outcome from saved text. Nothing here starts,
       resumes or interrupts a turn. */
    'agent:session-activity': async (value, principal) => {
      if (principal.kind !== 'window') agentIpcError(PRINCIPAL_REFUSAL, 'Session activity belongs to this application window.')
      try {
        const payload = agentPayload(value, ['sessionId'])
        const sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
        const session = ownedAgentSession(principal, sessionId)
        const activity = currentAgentHost()?.sessionActivity?.(sessionId)
        if (!activity) return { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' }
        /* lastTurnStatus is recorded from provider output, so it crosses as a
           bare word or not at all -- the same bound spawn-record applies to
           the copy it keeps. Anything else is reported as no recorded outcome
           rather than passed through. */
        const word = typeof session.lastTurnStatus === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(session.lastTurnStatus)
          ? session.lastTurnStatus : null
        return { ok: true, busy: activity.busy === true, closing: activity.closing === true,
          lastTurnStatus: word,
          ...(typeof session.lastTurnId === 'string' && session.lastTurnId.length > 0 && session.lastTurnId.length <= 512
            && !/[\u0000-\u001f\u007f]/.test(session.lastTurnId) ? { lastTurnId: session.lastTurnId } : {}),
          turnsCompleted: Number.isSafeInteger(session.turnsCompleted) ? session.turnsCompleted : 0 }
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:tree-adopt': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'selfName', 'managerName', 'treeKey', 'requestKeys'])
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          selfName: boundedAgentString(payload.selfName, 'selfName', 120),
          managerName: payload.managerName === null || payload.managerName === undefined
            ? null : boundedAgentString(payload.managerName, 'managerName', 120),
          treeKey: boundedAgentString(payload.treeKey, 'treeKey', 128),
          requestKeys: payload.requestKeys,
        }
        const session = ownedAgentSession(principal, request.sessionId)
        const result = await currentAgentHost().adoptTreeAddress(request)
        if (result?.ok === true) {
          adoptedTreeNodes.set(session, request.requestKeys.threadId)
          try { deps.rememberTreeAdmission?.(request.sessionId) } catch { /* Admission can be retried without restarting. */ }
          try { await recordTranscriptBinding({ sessionId: request.sessionId, nodeId: request.requestKeys.threadId, treeId: request.treeKey }) }
          catch { /* An accepted assignment remains accepted if its transcript save is delayed. */ }
        }
        return result
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:tree-address': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'selfName', 'managerName', 'treeKey', 'requestKeys'])
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          selfName: boundedAgentString(payload.selfName, 'selfName', 120),
          managerName: payload.managerName === null || payload.managerName === undefined
            ? null
            : boundedAgentString(payload.managerName, 'managerName', 120),
          treeKey: boundedAgentString(payload.treeKey, 'treeKey', 128),
          ...(payload.requestKeys === undefined ? {} : { requestKeys: payload.requestKeys }),
        }
        ownedAgentSession(principal, request.sessionId)
        const result = await currentAgentHost().updateTreeAddress(request)
        if (result?.ok !== false) {
          try { deps.rememberTreeAdmission?.(request.sessionId) } catch { /* No verified lifecycle admission retained. */ }
        }
        if (result?.ok !== false && request.requestKeys?.threadId) {
          try { await recordTranscriptBinding({ sessionId: request.sessionId, nodeId: request.requestKeys.threadId, treeId: request.treeKey }) }
          catch { /* The transcript service reports a failed binding without misreporting the address update. */ }
        }
        return result
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* File one standing request, or -- ledger kinds, 2026-09-07 -- one task or
       one ask, filed through this exact same seam. No session is required --
       a rule, task or ask can be filed before any agent runs -- so this goes
       through getAgentHost() like a start does. Bounds: the words cap matches
       the ledger module's own MAX_WORDS_BYTES (16KB); scope and key are
       bounded identifiers. `label` is the optional human name of the tree,
       session or circle the key addresses, snapshotted onto the record at
       filing so the Ledger page can say "Manager 2" instead of a node id;
       bounded at the store's own 120. `kind` is OPTIONAL and, when present,
       must be 'T' or 'A' -- a plain /Request sends no kind at all, and the
       object handed to the host is byte-for-byte what it was before kind
       existed on this channel; the store still mints an R id until the
       engine lane's own kind dispatch lands. */
    'agent:request': async (value) => {
      try {
        const payload = agentPayload(value, ['scope', 'key', 'words', 'label', 'kind', 'via', 'difficulty'])
        const scope = boundedAgentString(payload.scope, 'scope', 16)
        const words = boundedAgentString(payload.words, 'words', 16 * 1024)
        const key = payload.key === undefined || payload.key === null
          ? null
          : boundedAgentString(payload.key, 'key', 128)
        const label = payload.label === undefined || payload.label === null
          ? null
          : boundedAgentString(payload.label, 'label', 120)
        const kind = payload.kind === undefined || payload.kind === null ? null : payload.kind
        if (kind !== null && kind !== 'T' && kind !== 'A') agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'kind must be T or A')
        const difficulty = payload.difficulty
        if (difficulty !== undefined && (kind !== 'T' || !['easy', 'medium', 'hard'].includes(difficulty))) {
          agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'difficulty must be easy, medium or hard for a task')
        }
        /* Which door the words came through: 'chat' for a typed /Request,
           nothing for the Ledger page's own box. Only the chat door can be
           closed by the person's "Who adds standing rules" choice, so this is
           the one word the host reads; anything else is treated as the page. */
        const via = payload.via === 'chat' ? 'chat' : null
        const host = await getAgentHost()
        return await host.fileStandingRequest({ scope, key, words, label, ...(kind ? { kind } : {}), ...(via ? { via } : {}), ...(difficulty !== undefined ? { difficulty } : {}) })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE PERSON'S HAND ON ONE STANDING RULE (O7 improvements, owner
       2026-08-22): rewrite its words, or remove it from its ledger file (the
       engine keeps a copy beside the file). Two verbs, the same shape as
       filing: bounded id, optional bounded key (the id the renderer already
       holds for that scope; null for the global ledger), and for an edit the
       words, capped at the ledger module's own MAX_WORDS_BYTES. The host
       resolves the scope from the id and calls the engine's PERSON-ONLY
       editRequest / removeRequest -- reachable from no MCP tool and no agent
       gate, only from here. So the caller must be the person: the window at
       the keyboard, or the relay that IS the signed-in person on another
       device (its mayWrite is the web-drive switch, checked by run() before
       this body is reached). Any other principal kind is refused by name
       before the payload is parsed. The words never enter a log line here. */
    'agent:request-edit': async (value, principal) => {
      try {
        personOnly(principal, 'agent:request-edit')
        const payload = agentPayload(value, ['id', 'key', 'words'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const words = boundedAgentString(payload.words, 'words', 16 * 1024)
        const key = payload.key === undefined || payload.key === null
          ? null
          : boundedAgentString(payload.key, 'key', 128)
        const host = await getAgentHost()
        return await host.editStandingRequest({ id, key, words })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:request-remove': async (value, principal) => {
      try {
        personOnly(principal, 'agent:request-remove')
        const payload = agentPayload(value, ['id', 'key'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const key = payload.key === undefined || payload.key === null
          ? null
          : boundedAgentString(payload.key, 'key', 128)
        const host = await getAgentHost()
        return await host.removeStandingRequest({ id, key })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE PERSON'S DECISION ON ONE RECORD: approve a proposal an agent filed
       (it becomes open and counts from the next start) or decline it, or
       decline an open request. The same fence as edit and remove -- person
       only, through the built host, the store refusing any other actor -- and
       the same bounds: a bounded id, one of two decision words, an optional
       reason the store caps at its own 2048. */
    'agent:request-decide': async (value, principal) => {
      try {
        personOnly(principal, 'agent:request-decide')
        const payload = agentPayload(value, ['id', 'decision', 'reason'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const decision = boundedAgentString(payload.decision, 'decision', 16)
        if (decision !== 'approve' && decision !== 'decline') {
          agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'decision must be approve or decline')
        }
        const reason = payload.reason === undefined || payload.reason === null || payload.reason === ''
          ? null
          : boundedAgentString(payload.reason, 'reason', 2048)
        const host = await getAgentHost()
        return await host.decideStandingRequest({ id, decision, reason })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE PERSON'S RESOLUTION OF ONE STANDING REQUEST (R_LEDGER kinds
       follow-on, 2026-09-07, Controller 3 L4e). Same fence as decide just
       above -- person only, before the payload is even parsed -- and the
       same bounds: a bounded id, a bounded status word, an optional reason
       the store caps at its own 2048. The host resolves the id's kind
       letter and the status vocabulary; this seam only bounds the strings. */
    'agent:request-resolve': async (value, principal) => {
      try {
        personOnly(principal, 'agent:request-resolve')
        const payload = agentPayload(value, ['id', 'status', 'reason'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const status = boundedAgentString(payload.status, 'status', 32)
        const reason = payload.reason === undefined || payload.reason === null || payload.reason === ''
          ? null
          : boundedAgentString(payload.reason, 'reason', 2048)
        const host = await getAgentHost()
        return await host.resolveStandingRequest({ id, status, reason })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE LEDGER PAGE'S WRITE VERBS FOR TASK AND ASK RECORDS (ledger kinds,
       2026-09-07, Controller 3 ruling 05:20Z). Same fence as the three
       rewrite verbs just above -- person-only, before the payload is even
       parsed -- and the same bounds: a bounded id, and for answerAsk the
       owner's words, capped the same as a filing (the store's own
       MAX_WORDS_BYTES). Ask decline also carries the optional reason, bounded
       like request-decide. The host resolves the id's kind letter and refuses
       a mismatch before the store is ever called. */
    'agent:task-complete': async (value, principal) => {
      try {
        personOnly(principal, 'agent:task-complete')
        const payload = agentPayload(value, ['id'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const host = await getAgentHost()
        return await host.completeTask({ id })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:task-remove': async (value, principal) => {
      try {
        personOnly(principal, 'agent:task-remove')
        const payload = agentPayload(value, ['id'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const host = await getAgentHost()
        return await host.removeTask({ id })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:ask-answer': async (value, principal) => {
      try {
        personOnly(principal, 'agent:ask-answer')
        const payload = agentPayload(value, ['id', 'words'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const words = boundedAgentString(payload.words, 'words', 16 * 1024)
        const host = await getAgentHost()
        return await host.answerAsk({ id, words })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:ask-decline': async (value, principal) => {
      try {
        personOnly(principal, 'agent:ask-decline')
        const payload = agentPayload(value, ['id', 'reason'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const reason = payload.reason === undefined || payload.reason === null || payload.reason === ''
          ? null
          : boundedAgentString(payload.reason, 'reason', 2048)
        const host = await getAgentHost()
        return await host.declineAsk({ id, reason })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:ask-remove': async (value, principal) => {
      try {
        personOnly(principal, 'agent:ask-remove')
        const payload = agentPayload(value, ['id'])
        const id = boundedAgentString(payload.id, 'id', 64)
        const host = await getAgentHost()
        return await host.removeAsk({ id })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* Read back the standing requests one scope carries. A READ AND NOTHING
       MORE; a file parse, so it does not go through getAgentHost(). */
    'agent:requests': async (value) => {
      try {
        const payload = agentPayload(value === undefined || value === null ? {} : value, ['scope', 'key'])
        const scope = boundedAgentString(payload.scope, 'scope', 16)
        const key = payload.key === undefined || payload.key === null
          ? null
          : boundedAgentString(payload.key, 'key', 128)
        return readStandingRequests({ scope, key })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE WHOLE LEDGER, for the Ledger page: every tier, every status, the
       history chain checked. A READ AND NOTHING MORE -- the reader never
       creates the file -- so it answers a read-only caller too, and it does
       not go through getAgentHost(). `scope` filters to one tier ('all' when
       absent), `key` to one id in that tier, `removed` includes tombstones;
       the facade hands `removed` over as the string 'true'. The reader's own
       refusals are {ok:false, code, reason, records:[]} and pass through. */
    'agent:ledger-reset-preview': (value, principal) => resetLedger('preview', value, principal),
    'agent:ledger-reset-confirm': (value, principal) => resetLedger('confirm', value, principal),
    'agent:ledger-custody-preview': (value, principal) => ledgerCustody.run('preview', value, principal),
    'agent:ledger-custody-confirm': (value, principal) => ledgerCustody.run('confirm', value, principal),

    'agent:ledger': async (value) => {
      try {
        const payload = agentPayload(value, ['scope', 'key', 'removed'])
        const scope = payload.scope === undefined || payload.scope === null
          ? 'all'
          : boundedAgentString(payload.scope, 'scope', 16)
        const key = payload.key === undefined || payload.key === null
          ? null
          : boundedAgentString(payload.key, 'key', 128)
        const removedRaw = payload.removed
        if (removedRaw !== undefined && removedRaw !== null && typeof removedRaw !== 'boolean' && removedRaw !== 'true' && removedRaw !== 'false') {
          agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'removed must be true or false')
        }
        const removed = removedRaw === true || removedRaw === 'true'
        return readCanonicalLedger({ scope, key, removed })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* Session profiles. list/remove are plain store calls; create runs the OS
       folder dialog, so the only way a folder enters the store is the person
       choosing it in a native picker -- that dialog is the consent boundary
       the whole design rests on. */
    'agent:profiles': async () => {
      return { ok: true, profiles: sessionProfiles.list() }
    },

    'agent:profile-create': async (value) => {
      try {
        const payload = agentPayload(value, ['name'])
        const name = boundedAgentString(payload.name, 'name', 64)
        const picked = await dialog.showOpenDialog({
          title: 'Choose the folder agents in this profile work in',
          properties: ['openDirectory'],
        })
        if (picked.canceled || !picked.filePaths.length) return { ok: true, profile: null }
        const profile = sessionProfiles.create({ name, cwd: picked.filePaths[0] })
        return { ok: true, profile }
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:profile-remove': async (value) => {
      try {
        const payload = agentPayload(value, ['profileId'])
        const removed = sessionProfiles.remove(boundedAgentString(payload.profileId, 'profileId', 128))
        return { ok: true, removed }
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE ATTACHMENT PICKER -- the only way a file path enters a session's
       image allowlist. A native dialog the person drives; the chosen path is
       issued to exactly this session and refused everywhere else. */
    'agent:pick-attachment': async (value, principal) => {
      try {
        const request = parseAgentSessionCommand(value)
        const session = ownedAgentSession(principal, request.sessionId)
        if (session.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'Wait for the provider switch before attaching another image.')
        const picked = await dialog.showOpenDialog({
          title: 'Attach an image to this message',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        })
        if (picked.canceled || !picked.filePaths.length) return { ok: true, path: null }
        const chosen = picked.filePaths[0]
        let size
        if (statFile) {
          try {
            const stat = await statFile(chosen)
            if (stat && typeof stat.isFile === 'function' && stat.isFile()
                && Number.isFinite(stat.size) && Number.isInteger(stat.size) && stat.size >= 0) size = stat.size
          } catch { /* a picked file remains attachable when metadata cannot be read */ }
        }
        /* MEASURED BEFORE IT IS ISSUED, not after. A path in the allowlist is a
           promise this session can send that file; a picture the delivery path
           will refuse for its size is not one, and saying so here costs the
           person a sentence instead of a whole turn. A file whose size could
           not be read is still attachable, exactly as before -- an unknown
           size is not a large one. */
        if (ownedAgentSession(principal, request.sessionId) !== session || session.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'The session changed while the image was being selected.')
        const tooLarge = pictureTooLargeToDeliver(session, path.basename(chosen), size)
        if (tooLarge) return tooLarge
        if (!(session.attachments instanceof Set)) session.attachments = new Set()
        session.attachments.add(chosen)
        return { ok: true, path: chosen, ...(size === undefined ? {} : { size }) }
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE PASTED-IMAGE FEEDER -- the ONLY other way a file path enters a
       session's image allowlist, and only for this command (see the COMMANDS
       entry above). Bytes ride in `value.data`, base64, already read by the
       renderer off its own paste event; nothing here ever reads the OS
       clipboard, and nothing caller-supplied ever becomes a path or filename
       component -- see savePasteAttachment (main.cjs), which builds the
       whole destination itself. */
    'agent:paste-attachment': async (value, principal) => {
      try {
        windowOnly(principal, 'agent:paste-attachment')
        if (typeof parseAgentPasteAttachment !== 'function' || typeof savePasteAttachment !== 'function' || typeof MAX_PASTE_IMAGE_BYTES !== 'number') {
          agentIpcError(PASTE_UNAVAILABLE_REFUSAL, 'Pasting an image is not available on this build.')
        }
        const request = parseAgentPasteAttachment(value)
        /* Named a conversation? Then a session that is not running yet is not
           a refusal, it is a hold (see heldConversationAttachments). Named
           none? Then this is the old contract exactly, refusal and all: a
           caller that cannot say which conversation its picture belongs to
           gets no new door. */
        const holdKey = typeof request.holdKey === 'string' && request.holdKey ? request.holdKey : null
        const session = holdKey
          ? liveOwnedSessionOrNull(principal, request.sessionId)
          : ownedAgentSession(principal, request.sessionId)
        if (session?.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'Wait for the provider switch before attaching another image.')
        const bytes = Buffer.from(request.data, 'base64')
        /* THE REAL CAP, ON THE DECODED BYTES -- the base64 string-length bound
           in parseAgentPasteAttachment is only a coarse pre-check; padding and
           encoder slack mean the decoded length is the honest number. */
        if (bytes.length === 0 || bytes.length > MAX_PASTE_IMAGE_BYTES) {
          agentIpcError(
            'MC_AGENT_PASTE_IMAGE_TOO_LARGE',
            'A pasted image may be at most ' + MAX_PASTE_IMAGE_BYTES + ' bytes',
          )
        }
        /* BEFORE THE WRITE, so a picture that cannot be delivered does not
           become a file on the person's disk with a chip in their composer.
           The pasted bytes are already measured here, which is why this door
           can name the size the picker's door has to stat for. */
        const tooLarge = pictureTooLargeToDeliver(session, 'you pasted', bytes.length)
        if (tooLarge) return tooLarge
        const saved = await savePasteAttachment(request.mime, bytes)
        if (session) {
          if (ownedAgentSession(principal, request.sessionId) !== session || session.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'The session changed while the image was being saved.')
          if (!(session.attachments instanceof Set)) session.attachments = new Set()
          session.attachments.add(saved.path)
          return { ok: true, path: saved.path, size: saved.size }
        }
        /* No session yet. The file is real and on disk; it waits with the
           conversation until a session comes up, and `held` lets the surface
           above say so honestly rather than implying it is already attached to
           a running agent. */
        holdAttachmentForConversation(holdKey, principal.owner, saved.path)
        return { ok: true, path: saved.path, size: saved.size, held: true }
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE MENTION PICKER -- returns a path for the caller to insert as TEXT.
       No allowlist: it becomes words in the message, and the agent's own
       confined tools do (or refuse) the reading. */
    'agent:pick-mention': async (value, principal) => {
      try {
        const request = parseAgentSessionCommand(value)
        ownedAgentSession(principal, request.sessionId)
        const picked = await dialog.showOpenDialog({
          title: 'Mention a file in this message',
          defaultPath: WORKSPACE_ROOT,
          properties: ['openFile'],
        })
        if (picked.canceled || !picked.filePaths.length) return { ok: true, path: null }
        return { ok: true, path: picked.filePaths[0] }
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* THE STANDING GOAL: read it, set it, clear it.
       One command with an `operation`, under the same session ownership every
       other session verb requires -- a goal starts real turns that spend real
       money, so it is exactly as fenced as agent:send is. An unknown
       operation refuses by name rather than defaulting to any of the three:
       defaulting a goal write to a read would look like it worked. */
    'agent:goal': async (value, principal) => {
      try {
        /* `objective` IS AN ALLOWED FIELD, and leaving it out of this list is
           the defect a hand test caught after every unit test was green.
           agentPayload() refuses any key it is not told about, so a renderer
           sending { sessionId, operation: 'set', objective } was refused with
           MC_AGENT_INVALID_PAYLOAD before the host was ever called -- and the
           renderer, which cannot tell that apart from a lost response, told the
           person "could not confirm the goal was set". The whole feature was
           unreachable from the UI while `get` and `clear`, which send no third
           field, worked perfectly. The tests missed it because they call
           host.setGoal() directly. See the set/get/clear case in
           tools/test/agent-command-surface.test.mjs, which now drives this
           command with the payload the renderer actually sends. */
        const payload = agentPayload(value, ['sessionId', 'operation', 'objective'])
        const sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
        const operation = boundedAgentString(payload.operation, 'operation', 16)
        ownedAgentSession(principal, sessionId)
        const host = currentAgentHost()
        if (operation === 'get') return host.readGoal({ sessionId })
        if (operation === 'clear') return host.clearGoal({ sessionId })
        if (operation === 'set') {
          return await host.setGoal({ sessionId, objective: payload.objective })
        }
        agentIpcError('AGENT_GOAL_OPERATION_UNKNOWN', 'A goal can be read, set or cleared, and nothing was changed.')
        return null
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:interrupt': async (value, principal) => {
      try {
        const request = parseAgentSessionCommand(value)
        ownedAgentSession(principal, request.sessionId)
        return await currentAgentHost().interrupt(request)
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* SEND NOW reserves the person-waiting boundary BEFORE the interrupt, and
       releases it (T785). Same trust as agent:interrupt -- a window principal
       that owns the session -- so no agent principal can forge a reservation.
       reserve returns the exact stamp; release is a compare-and-clear on it,
       so it can never wipe a later waiter's reservation nor another session. */
    'agent:reserve-send-now': async (value, principal) => {
      try {
        const request = parseAgentSessionCommand(value)
        ownedAgentSession(principal, request.sessionId)
        return await currentAgentHost().reserveSendNow(request)
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:release-send-now': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'token'])
        const sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
        const token = Number(payload.token)
        ownedAgentSession(principal, sessionId)
        return await currentAgentHost().releaseSendNow({ sessionId, token })
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* An answer belongs to this principal's active session. Native option
       ids may be opaque strings up to the ACP bound; the adapter validates
       membership in this exact pending request before sending anything. */
    'agent:approval-answer': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'approvalId', 'decision'])
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          approvalId: boundedAgentString(payload.approvalId, 'approvalId', 1024),
          decision: boundedAgentString(payload.decision, 'decision', 512),
        }
        ownedAgentSession(principal, request.sessionId)
        return await currentAgentHost().answerApproval(request)
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* REWIND -- fork the session's thread at one of the person's own turns. */
    'agent:rewind': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'turnId'])
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          turnId: boundedAgentString(payload.turnId, 'turnId', 512),
        }
        ownedAgentSession(principal, request.sessionId)
        return await currentAgentHost().rewindSession(request)
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    /* How hard a running agent thinks: the engine's own knob, changed on a
       live thread rather than by restarting it. The closed set is
       load-bearing because the provider accepts an unknown effort silently. */
    'agent:effort': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'effort'])
        const effort = boundedAgentString(payload.effort, 'effort', 8)
        if (!AGENT_EFFORT_VALUES.includes(effort)) {
          agentIpcError('MC_AGENT_EFFORT_UNKNOWN', `effort must be one of: ${AGENT_EFFORT_VALUES.join(', ')}`)
        }
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          effort,
        }
        ownedAgentSession(principal, request.sessionId)
        const result = await currentAgentHost().setSessionEffort(request)
        // Recovery inherits the last accepted setting, including changes made
        // after launch. A refused engine update leaves that setting intact.
        const retained = recoveryStartDefaults.get(request.sessionId)
        if (result?.ok !== false && result?.effort === effort && retained) retained.defaults.effort = effort
        return result
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:switch': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['operation', 'sessionId', 'operationId', 'tier', 'effort', 'account'])
        const sourceSessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
        const operationId = boundedAgentString(payload.operationId, 'operationId', 128)
        const operation = boundedAgentString(payload.operation, 'operation', 16)
        const key = sourceSessionId + ':' + operationId
        let retained = standaloneSwitches.get(key)
        if (retained && retained.owner !== principal.owner) agentIpcError('MC_AGENT_UNKNOWN_SESSION', 'Unknown sessionId: ' + sourceSessionId)
        if (operation === 'prepare') {
          ownedAgentSession(principal, sourceSessionId)
          const tier = boundedAgentString(payload.tier, 'tier', 128)
          const account = agentPayload(payload.account || { mode: 'keep' }, ['mode', 'name'])
          const target = { tier, effort: payload.effort, account }
          const fingerprint = JSON.stringify(target)
          if (retained && retained.fingerprint !== fingerprint) agentIpcError('AGENT_SWITCH_CONFLICT', 'This switch operation already has a different target.')
          if (!retained) {
            if (standaloneSwitches.size >= 256) {
              for (const [id, row] of standaloneSwitches) {
                if (['applied', 'failed', 'cancelled'].includes(row.handle.status().phase)) { standaloneSwitches.delete(id); break }
              }
              if (standaloneSwitches.size >= 256) agentIpcError('AGENT_SWITCH_BUSY', 'Outstanding switch outcomes must be resolved first.')
            }
            const handle = standaloneCoordinator.prepare({ sourceSessionId, target }, principal)
            retained = { owner: principal.owner, fingerprint, handle }
            standaloneSwitches.set(key, retained)
          }
          const prepared = await retained.handle.prepared
          return { operationId, ...prepared, ...retained.handle.status(), sessionId: prepared.sessionId, applied: false }
        }
        if (!retained) agentIpcError('AGENT_SWITCH_UNKNOWN', 'This switch operation is no longer available.')
        if (operation === 'status') return { operationId, ...retained.handle.status() }
        if (operation === 'commit') return { operationId, ...await retained.handle.commit() }
        if (operation === 'cancel') return { operationId, ...await retained.handle.cancel() }
        agentIpcError('AGENT_SWITCH_INVALID', 'A switch can be prepared, committed, cancelled or read.')
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:owner-context': async (_value, principal) => {
      windowOnly(principal, 'agent:owner-context')
      if (typeof deps.imageOwnerContext !== 'function') agentIpcError('IMAGE_QUEUE_UNAVAILABLE', 'Image owner context is unavailable.')
      return deps.imageOwnerContext(principal)
    },
    'agent:image-queue': async (value, principal) => {
      windowOnly(principal, 'agent:image-queue')
      try {
        if (typeof deps.imageQueue !== 'function') agentIpcError('IMAGE_QUEUE_UNAVAILABLE', 'Image queue storage is unavailable.')
        return await deps.imageQueue(value, principal)
      } catch (error) {
        // Electron transports Error.message, not arbitrary Error properties.
        // Keep refusal codes in a plain receipt and never imply no commit.
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'IMAGE_QUEUE_UNCONFIRMED'
        return { ok: false, code, committed: null, reconcile: true,
          operationId: typeof value?.operationId === 'string' && value.operationId.length <= 64 ? value.operationId : null }
      }
    },

    'agent:modes': async (value, principal) => {
      try {
        const request = parseAgentSessionCommand(value)
        const owned = ownedAgentSession(principal, request.sessionId)
        const result = await currentAgentHost().readSessionModes(request)
        if (ownedAgentSession(principal, request.sessionId) !== owned) {
          agentIpcError('AGENT_SESSION_NOT_READY', 'The session changed while reading its mode catalog.')
        }
        return result
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    'agent:mode': async (value, principal) => {
      try {
        const payload = agentPayload(value, ['sessionId', 'modeId'])
        const request = {
          sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
          modeId: boundedAgentString(payload.modeId, 'modeId', 512),
        }
        const owned = ownedAgentSession(principal, request.sessionId)
        const result = await currentAgentHost().setSessionMode(request)
        if (ownedAgentSession(principal, request.sessionId) !== owned) {
          agentIpcError('AGENT_MODE_SELECTION_UNCONFIRMED', 'The session changed before its mode selection was confirmed.')
        }
        return result
      } catch (error) { throw rendererSafeAgentError(error) }
    },

    /* What this engine actually offers: the provider's model catalog. */
    'agent:models': async (value, principal) => {
      try {
        const payload = agentPayload(value || {}, ['sessionId'])
        const request = {}
        if (Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
          request.sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
          ownedAgentSession(principal, request.sessionId)
        }
        return await currentAgentHost().listEngineModels(request)
      } catch (error) {
        throw rendererSafeAgentError(error)
      }
    },

    'agent:close': async (value, principal) => {
      let recoveryClose = false
      try {
        const payload = agentPayload(value, ['sessionId', 'accountRecovery', 'delegationToken'])
        const request = parseAgentSessionCommand({ sessionId: payload.sessionId })
        if (payload.accountRecovery !== undefined) {
          const recovery = agentPayload(payload.accountRecovery, ['recoveryId'])
          request.accountRecovery = { recoveryId: boundedAgentString(recovery.recoveryId, 'recoveryId', 120) }
          recoveryClose = true
        }
        if (payload.delegationToken !== undefined) {
          const token = boundedAgentString(payload.delegationToken, 'delegationToken', 128)
          if (typeof deps.assertTreeLifecycleClose !== 'function') agentIpcError('TREE_DELEGATION_REFUSED', 'This replacement cannot be verified.')
          deps.assertTreeLifecycleClose(token, request.sessionId, principal)
        }
        const session = ownedAgentSession(principal, request.sessionId)
        try { deps.rememberTreeAdmission?.(request.sessionId) } catch { /* Do not block an owner stop; later delegation refuses. */ }
        if (payload.delegationToken !== undefined) deps.assertTreeLifecycleClose(payload.delegationToken, request.sessionId, principal)
        const result = await currentAgentHost().closeSession(request)
        /* THE PERSON STOPPED IT -- the first genuine ending. Recorded once the
           close has actually resolved (a close that rejects throws past this
           line and leaves the session, and its record, exactly as they were),
           and before the session leaves the map. */
        recordSessionEnd(session, request.sessionId, 'closed')
        if (agentSessions.get(request.sessionId) === session) {
          agentSessions.delete(request.sessionId)
        }
        return result
      } catch (error) {
        // Another turn or replacement can consume the ticket while the renderer
        // saves its checkpoint. This expected refusal must not become an IPC error.
        if (recoveryClose && ['AGENT_ACCOUNT_RECOVERY_UNAVAILABLE', 'MC_AGENT_UNKNOWN_SESSION', 'AGENT_SESSION_UNKNOWN'].includes(error?.code)) {
          return { ok: false, closed: false, code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE',
            reason: 'This recovery has changed. This request did not close the current session.' }
        }
        throw rendererSafeAgentError(error)
      }
    },

    /* ---------- the declared organisation ----------
       The tier is NOT consulted here, deliberately: naming a manager or
       writing a role description is a statement of intent that grants no
       authority (`grantsAuthority: false` on the record the engine returns).
       The record answers its own refusals as {ok:false, ...}; the IPC wrapper
       in main.cjs keeps withFleetProfileSender's never-throws envelope. */
    'org:read': async () => agentOrgRecord.read(),

    'org:reparent': async (request) => agentOrgRecord.reparent({
      agentId: String(request?.agentId ?? ''),
      parentId: request?.parentId === null || request?.parentId === undefined ? null : String(request.parentId),
      expectedRevision: request?.expectedRevision,
    }),

    'org:assign-role': async (request) => agentOrgRecord.assignRole({
      agentId: String(request?.agentId ?? ''),
      role: String(request?.role ?? ''),
      expectedRevision: request?.expectedRevision,
    }),

    /* Declare the seat a tree node needs in order to carry an identity. The id
       is the node's own id, so it is bounded here exactly as a declared agent
       id is everywhere else; the store refuses everything else by name. */
    'org:ensure-seat': async (request) => {
      const id = String(request?.id ?? '')
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
        agentIpcError('MC_AGENT_SEAT_ID_INVALID', 'A seat id must be a lowercase declared agent id.')
      }
      const role = String(request?.role ?? '')
      if (!role) agentIpcError('MC_AGENT_SEAT_ROLE_INVALID', 'A seat needs the role the node runs.')
      const provider = request?.provider === undefined || request?.provider === null ? undefined : String(request.provider)
      if (provider !== undefined && !['codex', 'claude', 'gemini', 'grok', 'local', 'none'].includes(provider)) {
        agentIpcError('MC_AGENT_SEAT_PROVIDER_INVALID', 'A seat provider must be codex, claude, gemini, grok, local or none.')
      }
      const nodeId = request?.nodeId === undefined || request?.nodeId === null ? undefined : String(request.nodeId)
      if (nodeId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(nodeId)) {
        agentIpcError('MC_AGENT_SEAT_NODE_ID_INVALID', 'A seat nodeId must be a lowercase declared agent id.')
      }
      const hasSelection = Object.hasOwn(request || {}, 'roleSelection')
      if (hasSelection && (role !== 'worker' || !nodeId || (request.roleSelection !== '' && request.roleSelection !== role))) {
        agentIpcError('MC_AGENT_SEAT_ROLE_INVALID', 'A role selection must match this declared tree seat or be empty for its Worker identity.')
      }
      return agentOrgRecord.ensureSeat({
        id,
        role,
        ...(hasSelection ? { roleSelection: request.roleSelection } : {}),
        ...(provider === undefined ? {} : { provider }),
        ...(typeof request?.displayName === 'string' && request.displayName ? { displayName: String(request.displayName).slice(0, 64) } : {}),
        ...(request?.managerId === undefined ? {} : { managerId: request.managerId === null ? null : String(request.managerId) }),
        ...(request?.adoptProvider === true ? { adoptProvider: true } : {}),
        ...(nodeId === undefined ? {} : { nodeId }),
        expectedRevision: request?.expectedRevision,
      })
    },

    /* Release the seat a tree node held. The id is bounded exactly as
       ensure-seat's is; the store's own rules (idempotent absence, refused
       root) are unchanged and unrepeated here. */
    'org:release-seat': async (request) => {
      const id = String(request?.id ?? '')
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
        agentIpcError('MC_AGENT_SEAT_ID_INVALID', 'A seat id must be a lowercase declared agent id.')
      }
      return agentOrgRecord.releaseSeat({
        id,
        expectedRevision: request?.expectedRevision,
      })
    },

    'org:create-role': async (request) => {
      const capabilities = optionalRoleCapabilities(request?.capabilities, agentIpcError)
      return agentOrgRecord.createRole({
        id: String(request?.id ?? ''),
        baseDefaultRole: request?.baseDefaultRole ? String(request.baseDefaultRole) : null,
        rules: request?.rules,
        ...(capabilities ? { capabilities } : {}),
        ...roleFunctionFields(request),
      })
    },

    'org:edit-role': async (request) => {
      const capabilities = optionalRoleCapabilities(request?.capabilities, agentIpcError)
      return agentOrgRecord.editRole({
        id: String(request?.id ?? ''),
        rules: request?.rules,
        ...(capabilities ? { capabilities } : {}),
        ...roleFunctionFields(request),
      })
    },

    'org:reset-role': async (request) => agentOrgRecord.resetRole({ id: String(request?.id ?? '') }),

    'org:reset': async () => agentOrgRecord.resetOrg(),

    'org:export': async () => agentOrgRecord.exportOrg(),
  })

  for (const command of Object.keys(COMMANDS)) {
    if (typeof handlers[command] !== 'function') {
      throw new Error('createAgentCommandSurface: inventory names a command with no body: ' + command)
    }
  }

  /* THE ORDER OF THE GATES, and why it is this order. The command must be one
     this surface knows; the principal must be one it can reason about; a
     read-only principal is refused every write BEFORE its payload is parsed
     (nothing it sends to a write is worth reading); a principal not at the
     keyboard is refused every dialog. Only then does the body run, with the
     checks it always made, in the order it always made them. */
  async function run(command, payload, principal) {
    const spec = COMMANDS[command]
    if (!spec) {
      agentIpcError(UNKNOWN_COMMAND_REFUSAL, 'No such agent command: ' + String(command))
    }
    if (!validPrincipal(principal)) {
      agentIpcError(PRINCIPAL_REFUSAL, 'The caller of ' + command + ' did not identify itself in the documented shape, so nothing was done.')
    }
    if (spec.write && principal.mayWrite !== true) {
      agentIpcError(
        READ_ONLY_REFUSAL,
        principal.label + ' may read this computer\'s agents but not change them, so ' + command + ' was refused.',
      )
    }
    if (spec.dialog && principal.kind !== 'window') {
      agentIpcError(
        DIALOG_REFUSAL,
        command + ' opens a dialog on this computer, and ' + principal.label + ' is not at its keyboard, so it was refused.',
      )
    }
    return handlers[command](payload, principal)
  }

  /* ---------- the event fan-out seam ----------
     The fan-out itself stays in main.cjs (host.onEvent is wired where the
     host is built), but the ROUTING DECISION lives here, where the principal
     kinds are defined. A relay-owned session's packet goes to the injected
     emitRelayEvent -- the facade's ring buffer -- because its owner is a
     token, not a WebContents. main.cjs always injects the facade sink. A
     standalone caller that does not provide one gets a counted, logged drop,
     NEVER a throw, because an event fan-out that can take down the host loop
     is worse than a lost packet. Returns true when the packet belonged to a
     relay-owned session (handled or dropped here), false when it is the
     caller's to forward to the window exactly as it always has. */
  let relayEventsDropped = 0
  function forwardSessionEvent(packet) {
    const session = agentSessions.get(packet && packet.sessionId)
    if (session?.ownerKind === 'window') {
      deps.desktopSessions?.forward(packet)
      return false // The additional relay copy never consumes window delivery.
    }
    if (!session || session.ownerKind !== 'relay') return false
    if (typeof emitRelayEvent !== 'function') {
      relayEventsDropped += 1
      if (log && (relayEventsDropped === 1 || relayEventsDropped % 500 === 0)) {
        try { log('this command-surface caller did not provide a relay event sink; dropped so far: ' + relayEventsDropped) } catch { /* the log must never break the fan-out */ }
      }
      return true
    }
    try {
      void Promise.resolve(emitRelayEvent(packet)).catch(() => {
        relayEventsDropped += 1
        if (log) {
          try { log('the relay event sink rejected and the packet was dropped (' + relayEventsDropped + ' dropped so far)') } catch { /* see above */ }
        }
      })
    } catch {
      relayEventsDropped += 1
      if (log) {
        try { log('the relay event sink threw and the packet was dropped (' + relayEventsDropped + ' dropped so far)') } catch { /* see above */ }
      }
    }
    return true
  }

  return Object.freeze({
    run,
    /* Automatic recovery has a distinct trusted entry point. It reuses the
       same principal, ownership, attachment and tracked-delivery checks, but
       never accepts a renderer-supplied origin and never falls back to the
       person-send path when the bridge is missing. */
    sendAutomatic: async (request, principal) => {
      if (!validPrincipal(principal)) {
        agentIpcError(PRINCIPAL_REFUSAL, 'The automatic send caller did not identify itself in the documented shape, so nothing was done.')
      }
      if (COMMANDS['agent:send'].write && principal.mayWrite !== true) {
        agentIpcError(READ_ONLY_REFUSAL, principal.label + ' may read this computer\'s agents but not change them, so automatic recovery was refused.')
      }
      return handlers['agent:send'](request, principal, true, 'automatic')
    },
    sendImageEnvelope: (request, principal) => handlers['agent:send'](request, principal, true),
    imageAttachmentAuthority(request, principal) {
      windowOnly(principal, 'image retention')
      const session = liveOwnedSessionOrNull(principal, request.sessionId)
      if (!session) agentIpcError('IMAGE_CUSTODY_REPICK_REQUIRED', 'The original image session is no longer available. Keep this message and pick the images again for the current session.')
      const issued = new Set(session.attachments instanceof Set ? session.attachments : [])
      if (!issued.size) agentIpcError('IMAGE_CUSTODY_REPICK_REQUIRED', 'No current-session image capability is available. Keep this message and pick the images again.')
      if (session?.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'The source conversation is being replaced.')
      return { session, issued }
    },
    imageCandidateAuthority(request, principal) {
      windowOnly(principal, 'image reissue')
      const session = ownedAgentSession(principal, request.sessionId)
      if (session.standaloneSwitchPending) agentIpcError('AGENT_TURN_ACTIVE', 'The source conversation is being replaced.')
      if (!(session.attachments instanceof Set)) session.attachments = new Set()
      return { session, issued: session.attachments }
    },
    commands: Object.freeze(Object.keys(COMMANDS)),
    isWrite: (command) => Boolean(COMMANDS[command] && COMMANDS[command].write),
    needsDialog: (command) => Boolean(COMMANDS[command] && COMMANDS[command].dialog),
    forwardSessionEvent,
    closeRemoteWatches: () => deps.desktopSessions?.close(),
    /* How full this machine is, for the facade's remote-status: the count a
       browser may honestly be shown ("N of 8 sessions") without a start. */
    /* `max` is null because there is no maximum. A number here that nothing
       enforces would be a figure on somebody's screen that means nothing. */
    sessionLoad: () => ({ open: openSessionCount(), max: null }),
    relayEventDropCount: () => relayEventsDropped,
  })
}

module.exports = {
  createAgentCommandSurface,
  COMMANDS,
  REQUIRED_DEPS,
  READ_ONLY_REFUSAL,
  DIALOG_REFUSAL,
  PASTE_WINDOW_REFUSAL,
  PRINCIPAL_REFUSAL,
  UNKNOWN_COMMAND_REFUSAL,
  ENDED_SESSION_REFUSAL,
}
