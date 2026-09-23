// Sandboxed Electron preloads cannot require a sibling preload. This file is
// therefore the shell's composed boundary: it preserves the existing chrome
// behavior and adds only the fleet-profile bridge below. Turning sandboxing
// off to reuse one file would make configuration convenience a security
// regression, which is a worse version of the productionization gap.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mcTranscripts', Object.freeze({
  onError: callback => {
    const listener = (_event, error) => callback(error)
    ipcRenderer.on('mc-transcripts:error', listener)
    return () => ipcRenderer.removeListener('mc-transcripts:error', listener)
  },
  ...Object.fromEntries(
  ['bind', 'release', 'append', 'migrate', 'read', 'list', 'archive', 'commitArchive', 'cancelArchive', 'rollback', 'configure', 'getSettings', 'chooseArchiveDirectory']
    .map(operation => [operation, request => ipcRenderer.invoke('mc-transcripts:' + operation, request)]),
),
}))

/* THE PER-NODE RECOVERY STORE, exposed exactly as mcTranscripts above is. A
   handoff is up to 48,000 characters and there is one per circle; routing them
   here instead of through mc-prefs:write is what keeps them out of the single
   settings record whose 1 MiB ceiling they had reached. */
contextBridge.exposeInMainWorld('mcRecovery', Object.freeze(
  Object.fromEntries(['save', 'get', 'remove', 'list']
    .map(operation => [operation, request => ipcRenderer.invoke('mc-recovery:' + operation, request)])),
))

contextBridge.exposeInMainWorld('mcShell', {
  titlebarHeight: 36,
  getBridgeProof: () => ipcRenderer.invoke('mc-bridge-proof'),
  remoteWorkspace: Object.freeze({
    status: () => ipcRenderer.invoke('mc-remote:status'),
    inspect: selection => ipcRenderer.invoke('mc-remote:inspect', selection),
    open: request => ipcRenderer.invoke('mc-remote:open', request),
  }),
  // The shell names the exact bridge it supervises so the renderer pins to it
  // instead of scanning localhost and trusting the first responder -- which is
  // how a squatter is handed this boot's proof. See mc-bridge-endpoint in
  // main.cjs and configuredBaseUrl() in src/mission-bridge.js.
  getBridgeEndpoint: () => ipcRenderer.invoke('mc-bridge-endpoint'),
  runtimeIdentity: (...args) => ipcRenderer.invoke('mc-runtime-identity', ...args),
  /* WHETHER THIS COPY HAS A PURCHASE LIST, asked of the shell that would serve
     it rather than fetched. The probe used to request /data/purchase-catalog.json
     on every start, and a copy with no list got a 404 back: an error-level line
     in the page's own log for a state that is normal (seen the first time the
     app was driven from outside, 2026-09-02). The shell answers from the same
     file check its route makes; a renderer on a shell without this method still
     falls back to the fetch. */
  checkoutSurface: () => ipcRenderer.invoke('mc-checkout:surface'),
  /* CONNECTING THIS COMPUTER TO AN ACCOUNT.
   *
   * The four verbs behind the "Connect this computer" screen. The bridge that
   * answers them is shell/device-claim.cjs, which spawns the payload's claim
   * CLI; the ceremony itself is the account service's, and the credential it
   * returns lands in the same vault the relay shell reads, which is what makes
   * a machine reachable from a signed-in browser at all.
   *
   * NO POLL TOKEN CROSSES THIS BOUNDARY. begin() keeps it in the main process
   * and poll() takes no argument, so a page cannot name a claim that is not
   * its own -- the same reason the bridge proof above is invoked rather than
   * handed over.
   *
   * DUPLICATED FROM shell/preload.cjs ON PURPOSE, and the duplication is the
   * whole point of this file: a sandboxed preload cannot require a sibling, so
   * THIS is the composed boundary main.cjs actually loads and the other file is
   * loaded by no window. The agent bridge below carries the same note, and
   * commit 1d44d35 ("Put the agent bridge in the preload the app actually
   * loads") is what happens when only the other file is edited: a green test
   * over a feature that does not exist on a real installation. It happened
   * again with this namespace. tools/test/preload-namespace-parity.test.mjs
   * now fails when the two disagree, so the third time is caught by a test
   * rather than by a person wondering why a button does nothing. */
  deviceClaim: Object.freeze({
    status: () => ipcRenderer.invoke('mc-device-claim:status'),
    begin: (request) => ipcRenderer.invoke('mc-device-claim:begin', request),
    poll: () => ipcRenderer.invoke('mc-device-claim:poll'),
    cancel: () => ipcRenderer.invoke('mc-device-claim:cancel'),
    /* "Disconnect this computer": clears the credential this machine holds,
       nothing else. Takes no argument for the same reason poll() takes none --
       there is exactly one credential and it is this machine's. The renderer
       treats this verb as optional (src/connect-computer-settings.js), so a
       page built against a shell without it still connects. */
    disconnect: () => ipcRenderer.invoke('mc-device-claim:disconnect'),
    // Fixed actions only. Main reads its owner-provisioned trusted context;
    // this boundary cannot select accounts, keys, paths or consent values.
    adminIdentity: () => ipcRenderer.invoke('mc-device-admin:run', 'identity'),
    adminPrepare: () => ipcRenderer.invoke('mc-device-admin:run', 'prepare'),
    adminImport: () => ipcRenderer.invoke('mc-device-admin:run', 'import'),
    adminFinalize: () => ipcRenderer.invoke('mc-device-admin:run', 'finalize'),
    adminResume: () => ipcRenderer.invoke('mc-device-admin:run', 'resume'),
    adminPairRequest: () => ipcRenderer.invoke('mc-device-admin:run', 'pair-request'),
    adminCancel: () => ipcRenderer.invoke('mc-device-admin:run', 'cancel'),
  }),
})

/* The agent bridge. BLOCKER 2 (R1162 non-author review) removed an earlier
   version of this exposure, and removing it was right at the time: the engine
   behind it was resolved from a hardcoded path into a private sibling checkout
   that shipped nowhere, so the control could only ever fail, and its failure
   path rendered that internal repo name into the DOM.

   It is re-established deliberately here, and it is not the old one:
   1. The engine path is configuration (MISSION_CONTROL_ENGINE), never a
      filesystem guess -- unconfigured fails closed instead of pretending.
   2. `availability()` lets the renderer ASK before it offers a control, so a
      build with no engine shows a stated-unavailable surface rather than a
      button guaranteed to fail.
   3. Nothing here can carry a path to the DOM: availability() replies
      {ok, code}, and the resolver's path-bearing message stays in main.

   It lives in THIS file, not shell/preload.cjs, for the reason stated at the
   top: this is the preload main.cjs actually loads. shell/preload.cjs is
   reachable from no window. */
contextBridge.exposeInMainWorld('mcAccessibility', Object.freeze({
  status: () => ipcRenderer.invoke('mc-accessibility:status'),
  prepareEnable: request => ipcRenderer.invoke('mc-accessibility:prepareEnable', request),
  confirm: request => ipcRenderer.invoke('mc-accessibility:confirm', request),
  reject: () => ipcRenderer.invoke('mc-accessibility:reject'),
  disable: () => ipcRenderer.invoke('mc-accessibility:disable'),
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('Accessibility listener must be a function')
    const forward = (_event, packet) => listener(packet)
    ipcRenderer.on('mc-accessibility:event', forward)
    return () => ipcRenderer.removeListener('mc-accessibility:event', forward)
  },
}))

contextBridge.exposeInMainWorld('mcScreenControl', Object.freeze({
  status: () => ipcRenderer.invoke('mc-screen-control:status'),
  grant: request => ipcRenderer.invoke('mc-screen-control:grant', request),
  revoke: request => ipcRenderer.invoke('mc-screen-control:revoke', request),
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('Screen control listener must be a function')
    const forward = (_event, packet) => listener(packet)
    ipcRenderer.on('mc-screen-control:event', forward)
    return () => ipcRenderer.removeListener('mc-screen-control:event', forward)
  },
}))

contextBridge.exposeInMainWorld('mcVoice', Object.freeze({
  targets: () => ipcRenderer.invoke('mc-voice:targets'),
  start: request => ipcRenderer.invoke('mc-voice:start', request),
  offer: request => ipcRenderer.invoke('mc-voice:offer', request),
  reply: request => ipcRenderer.invoke('mc-voice:reply', request),
  interrupt: request => ipcRenderer.invoke('mc-voice:interrupt', request),
  stop: () => ipcRenderer.invoke('mc-voice:stop'),
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('Voice listener must be a function')
    const forward = (_event, packet) => listener(packet)
    ipcRenderer.on('mc-voice:event', forward)
    return () => ipcRenderer.removeListener('mc-voice:event', forward)
  },
}))

contextBridge.exposeInMainWorld('mcAgent', Object.freeze({
  availability: () => ipcRenderer.invoke('mc-agent:availability', {}),
  /* What a session started here would be CONFINED to. Read-only, starts
     nothing, and the reason the Start control can finally describe the session
     it is about to start instead of reciting a sentence written before the
     permission level reached a running agent. Returns {ok:false, code} rather
     than a path on every failure, exactly like availability(). */
  confinement: () => ipcRenderer.invoke('mc-agent:confinement'),
  /* The tool surface by NAME, for the research page's tool checkboxes. Same
     posture as confinement(): read-only, registry identifiers only, and
     {ok:false, code} on every failure. */
  tools: () => ipcRenderer.invoke('mc-agent:tools'),
  /* Which tiers this installation can really start, from the shell rather than
     from a list the renderer keeps. The caller must fall back to codex-only on
     any failure; see the note on the handler in shell/main.cjs. */
  startableTiers: () => ipcRenderer.invoke('mc-agent:startable-tiers'),
  /* WHICH ACCOUNT EACH RUNNING AGENT IS ON, so a card can say it. Read-only,
     starts nothing, and carries no path: a row is
     {sessionId, agentId, account, provider}, and the confined home directory
     the shell keeps beside each one is dropped before the answer leaves the
     main process. The report riding with it says which agents are on an
     account past a limit and where each WOULD go; it moves nothing, and there
     is deliberately no arrow here that could. */
  sessionAccounts: () => ipcRenderer.invoke('mc-agent:session-accounts'),
  continuations: request => ipcRenderer.invoke('mc-agent:continuations', request),
  /* The messages this computer has already written down, for the comms page.
     Read-only, starts nothing, and carries no path: a message is
     {id, sender, at, text} with `at` RFC3339 and `sender` the circle name. A
     build whose payload cannot read them answers {ok:false, reason} -- a
     sentence to show, not a rejection to catch. */
  localMessages: request => ipcRenderer.invoke('mc-agent:local-messages', request || {}),
  /* Read-only, and the reason the home screen has something true to show on a
     computer with nothing else connected. Returns bounded records of what has
     run here: sequence, time, action. No path, no hash, no signature -- see
     history() in shell/spawn-record.cjs for why each is absent. */
  history: request => ipcRenderer.invoke('mc-agent:history', request || {}),
  /* What the turns on this computer COST, from the same kind of signed record
     and under the same rules: read-only, bounded figures, no path, no hash, no
     signature. Its own channel rather than a field on history() because it is
     its own chain in its own file -- a turn is not a run, and a busy session's
     turns must not push the runs out of the window history() can read. See
     shell/usage-record.cjs. */
  usage: request => ipcRenderer.invoke('mc-agent:usage', request || {}),
  start: request => ipcRenderer.invoke('mc-agent:start', request),
  send: request => ipcRenderer.invoke('mc-agent:send', request),
  /* Automatic recovery has no renderer-selectable origin. Main pins this
     request to the automatic host path after the same sender/owner checks. */
  sendAutomatic: request => ipcRenderer.invoke('mc-agent:send-automatic', request),
  workStatus: request => ipcRenderer.invoke('mc-agent:work-status', request),
  /* Whether one saved session is still working, for a page that has just
     reloaded and must not trust its own saved ids for that. */
  sessionActivity: request => ipcRenderer.invoke('mc-agent:session-activity', request),
  /* Rebind a running tree circle after Page 2 moves it. The payload contains
     the same bounded display names and opaque top-node id already shown and
     stored by the renderer; no path crosses. */
  treeLinks: () => ipcRenderer.invoke('mc-agent:tree-links'),
  setTreeLink: request => ipcRenderer.invoke('mc-agent:tree-link', request),
  updateTreeAddress: request => ipcRenderer.invoke('mc-agent:tree-address', request),
  adoptTreeAddress: request => ipcRenderer.invoke('mc-agent:tree-adopt', request),
  /* File one standing request (the /Request family). Ids and words only, in
     both directions: the reply is {ok, id, scope, key} for the confirmation
     sentence, and no path crosses this bridge. */
  request: request => ipcRenderer.invoke('mc-agent:request', request),
  /* The person's hand on one standing request, from the rules panel: rewrite
     its words, or take it out of its ledger file (the engine keeps a copy
     beside the file). {id, key?, words} and {id, key?} in; {ok, id} out, no
     path. Person-only by design: no agent reaches these, and the main process
     refuses any caller that is not this window or the signed-in relay. */
  requestEdit: request => ipcRenderer.invoke('mc-agent:request-edit', request),
  requestRemove: request => ipcRenderer.invoke('mc-agent:request-remove', request),
  /* The person's decision on one record from the Ledger page: approve a
     proposal an agent filed, or decline it. {id, decision, reason?} in,
     {ok, id, status} out, no path. Person-only, like the two above. */
  requestDecide: request => ipcRenderer.invoke('mc-agent:request-decide', request),
  /* The person's resolution of one standing request (R_LEDGER kinds
     follow-on, 2026-09-07, Controller 3 L4e). {id, status, reason?} in,
     {ok, id, status} out, no path. Person-only, like decide just above. */
  resolveStandingRequest: request => ipcRenderer.invoke('mc-agent:request-resolve', request),
  /* The Ledger page's write verbs for task and ask records (ledger kinds,
     2026-09-07). {id} in for completeTask/removeTask/removeAsk, {id, words}
     for answerAsk, {id, reason?} for declineAsk; {ok, id, status} out, no
     path. Person-only, like the three rewrite verbs just above. */
  completeTask: request => ipcRenderer.invoke('mc-agent:task-complete', request),
  removeTask: request => ipcRenderer.invoke('mc-agent:task-remove', request),
  answerAsk: request => ipcRenderer.invoke('mc-agent:ask-answer', request),
  declineAsk: request => ipcRenderer.invoke('mc-agent:ask-decline', request),
  removeAsk: request => ipcRenderer.invoke('mc-agent:ask-remove', request),
  /* Read one scope's standing requests back. The same vocabulary and the same
     silence about paths: {scope, key} in, {ok, exists, entries:[{id, words}]}
     out. A read only; the person's edit and delete are the two methods above. */
  requests: request => ipcRenderer.invoke('mc-agent:requests', request),
  /* The whole ledger for the Ledger page: every tier, every status, the
     history checked. {scope?, key?, removed?} in; {ok, revision, updatedAt,
     exists, records:[...], chain, filter} out, or {ok:false, code, reason,
     records:[]}. A read only, and one that never creates the file. */
  ledger: request => ipcRenderer.invoke('mc-agent:ledger', request || {}),
  ledgerResetPreview: request => ipcRenderer.invoke('mc-agent:ledger-reset-preview', request),
  ledgerResetConfirm: request => ipcRenderer.invoke('mc-agent:ledger-reset-confirm', request),
  ledgerCustodyPreview: request => ipcRenderer.invoke('mc-agent:ledger-custody-preview', request || {}),
  ledgerCustodyConfirm: request => ipcRenderer.invoke('mc-agent:ledger-custody-confirm', request),
  continuationPrunePreview: request => ipcRenderer.invoke('mc-agent:continuation-prune-preview', request || {}),
  continuationPruneConfirm: request => ipcRenderer.invoke('mc-agent:continuation-prune-confirm', request || {}),
  nodeStatusRepairPreview: request => ipcRenderer.invoke('mc-agent:node-status-repair-preview', request || {}),
  nodeStatusRepairConfirm: request => ipcRenderer.invoke('mc-agent:node-status-repair-confirm', request || {}),
  nodeStatusRollbackPreview: request => ipcRenderer.invoke('mc-agent:node-status-rollback-preview', request || {}),
  nodeStatusRollbackConfirm: request => ipcRenderer.invoke('mc-agent:node-status-rollback-confirm', request || {}),

  /* Native dialogs, driven by the person. pickAttachment issues the chosen
     path to that session's image allowlist in main; pickMention returns a
     path the renderer inserts as TEXT. Both answer {ok, path|null}. */
  pickAttachment: request => ipcRenderer.invoke('mc-agent:pick-attachment', request),
  pickMention: request => ipcRenderer.invoke('mc-agent:pick-mention', request),
  /* Ctrl+V on the composer's own input. Bytes are read by the renderer off
     its own paste event and ride in `request.data` (base64) with
     `request.mime`; this process never reads the OS clipboard. Answers
     {ok, path, size} the same shape pickAttachment does. */
  pasteAttachment: request => ipcRenderer.invoke('mc-agent:paste-attachment', request),
  /* Session profiles: named working folders the person picked through the OS
     dialog. The renderer only ever handles ids; paths stay main-side. */
  profiles: () => ipcRenderer.invoke('mc-agent:profiles'),
  profileCreate: request => ipcRenderer.invoke('mc-agent:profile-create', request),
  profileRemove: request => ipcRenderer.invoke('mc-agent:profile-remove', request),
  goal: request => ipcRenderer.invoke('mc-agent:goal', request),
  interrupt: request => ipcRenderer.invoke('mc-agent:interrupt', request),
  /* SEND NOW reserves the person-waiting boundary before its interrupt and
     releases it afterward (T785). */
  reserveSendNow: request => ipcRenderer.invoke('mc-agent:reserve-send-now', request),
  releaseSendNow: request => ipcRenderer.invoke('mc-agent:release-send-now', request),
  /* Fork this session's thread at one of your own turns and continue from
     there — proven by tools/agent-rewind-probe.mjs before it shipped. */
  rewind: request => ipcRenderer.invoke('mc-agent:rewind', request),
  /* Change a running agent's thinking depth, and ask the engine what depths
     it really offers. Both are the provider's answers, not ours. */
  setEffort: request => ipcRenderer.invoke('mc-agent:effort', request),
  models: request => ipcRenderer.invoke('mc-agent:models', request || {}),
  switchSession: request => ipcRenderer.invoke('mc-agent:switch', request),
  imageQueue: request => ipcRenderer.invoke('mc-agent:image-queue', request),
  ownerContext: () => ipcRenderer.invoke('mc-agent:owner-context'),
  onOwnerContextChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('mc-agent:owner-context-changed', receive)
    return () => ipcRenderer.removeListener('mc-agent:owner-context-changed', receive)
  },
  modes: request => ipcRenderer.invoke('mc-agent:modes', request),
  setMode: request => ipcRenderer.invoke('mc-agent:mode', request),
  /* Answer a pending approval with one of the decisions the request itself
     named. Nothing fires approvals today (policy is 'never' at every tier);
     the reply path exists first, by design. */
  answerApproval: request => ipcRenderer.invoke('mc-agent:approval-answer', request),
  close: request => ipcRenderer.invoke('mc-agent:close', request),
  /* Returns its own unsubscribe. A surface that mounts per navigation must be
     able to detach exactly its own listener, or every visit to an agent page
     leaves another one attached to the channel. */
  onEvent: listener => {
    if (typeof listener !== 'function') throw new TypeError('onEvent requires a listener function')
    const forward = (_event, packet) => { listener(packet) }
    ipcRenderer.on('mc-agent:event', forward)
    return () => { ipcRenderer.removeListener('mc-agent:event', forward) }
  },
}))

/* COORDINATOR TREE COMMANDS.
 *
 * This is intentionally its own one-way request namespace rather than another
 * method on mcAgent. The renderer cannot choose a node, path, tier, model, or
 * provider thread here. Main has already validated and claimed one coordinator-
 * authored file under the app-owned userData spool; this boundary only delivers
 * that bounded request to the Computers view and lets the view return identifiers
 * or a closed refusal code. A separately claimed send may contain one bounded
 * message; it never crosses argv or the result channel.
 */
contextBridge.exposeInMainWorld('mcHandControls', Object.freeze({
  setEnabled: enabled => ipcRenderer.invoke('mc-hand-controls:enabled', enabled),
}))

contextBridge.exposeInMainWorld('mcNativeStop', Object.freeze({
  onRequest: listener => {
    if (typeof listener !== 'function') throw new TypeError('onRequest requires a listener function')
    const forward = (_event, request) => listener(request)
    ipcRenderer.on('mc-native-stop:request', forward)
    return () => ipcRenderer.removeListener('mc-native-stop:request', forward)
  },
  ready: value => ipcRenderer.invoke('mc-native-stop:ready', value === true),
  close: value => ipcRenderer.invoke('mc-native-stop:close', value),
  complete: value => ipcRenderer.invoke('mc-native-stop:complete', value),
}))

contextBridge.exposeInMainWorld('mcTreeCommand', Object.freeze({
  onRequest: listener => {
    if (typeof listener !== 'function') throw new TypeError('onRequest requires a listener function')
    const forward = (_event, request) => { listener(request) }
    ipcRenderer.on('mc-tree-command:request', forward)
    return () => { ipcRenderer.removeListener('mc-tree-command:request', forward) }
  },
  complete: result => ipcRenderer.invoke('mc-tree-command:complete', result),
  /* WHICH COMPUTER'S TREE IS ON SCREEN. Main needs this for exactly one
     thing: addressing a create-and-start command at the tree that is open,
     rather than guessing a computer and navigating the person's window to it.
     One bounded id travels, and main treats it as a hint it re-checks -- the
     view refuses a command for a tree it does not have open. */
  announce: computerId => ipcRenderer.invoke('mc-tree-command:computer', computerId),
}))

/* NOTIFICATIONS: WHETHER THIS COMPUTER CAN SHOW ONE, AND WHAT IS ON SCREEN.
 *
 * Its own name rather than two more methods on mcAgent, for the reason
 * mcProviders states below: neither of these is about an agent session.
 * `supported` is a fact about the MACHINE that is true before any session
 * exists, and `watching` is a fact about this WINDOW.
 *
 * THERE IS NO `notify()` HERE, AND THERE MUST NOT BE. A page that could raise
 * its own notification would be a page that can interrupt somebody whatever
 * their settings say, and the whole design of this feature is that the seam in
 * the main process reads the person's switch before anything is raised
 * (shell/agent-notifications.cjs). This bridge can ask and can report; it
 * cannot notify.
 *
 * `supported` IS READ SYNCHRONOUSLY, and it is the one exception to the rule
 * mcOrg states directly below -- every read is an explicit invoke unless the
 * page needs the answer before it paints. This one does: src/views/settings.js
 * builds each row's control markup in one pass and has to decide `disabled`
 * inside it, so an asynchronous answer would draw a live switch and then
 * disable it. A switch that was pressable for a moment is worse than one that
 * was never offered. It is a single boolean off a channel that starts nothing.
 *
 * `watching` IS AN EXPLICIT INVOKE, like everything on mcOrg, because nothing
 * waits on it: the page is telling the main process something, not asking. */
/* WRAPPED, WHICH THE TWO SYNCHRONOUS BOOTSTRAPS BELOW ARE NOT, AND ON PURPOSE.
   A preload that throws loses EVERY bridge in this file -- the settings store,
   the agent channels, the account -- and the window comes up as a page with no
   product behind it. Those two are load-bearing enough that failing loudly is
   right. This one is not: the worst honest outcome of not knowing whether this
   computer shows notifications is two switches drawn disabled with a reason, so
   a fault here costs the notification rows and nothing else. */
let notifyDelivery = null
try { notifyDelivery = ipcRenderer.sendSync('mc-notify:delivery') } catch { notifyDelivery = null }
contextBridge.exposeInMainWorld('mcNotify', Object.freeze({
  /* Boolean(), so a refusal record, an undefined from an older shell, or
     anything else that is not the word true reaches the page as false -- which
     draws the disabled switch. Not-established must never render as working. */
  supported: Boolean(notifyDelivery && notifyDelivery.supported === true),
  watching: request => ipcRenderer.invoke('mc-notify:watching', request),
}))

/* THE THREE ASSISTANT PROGRAMS, AS THIS COMPUTER ACTUALLY HAS THEM.
 *
 * Its own name rather than a fourth method on mcAgent, because it is not about
 * an agent session: it answers a question about the MACHINE that is true before
 * any session exists and stays true after one ends. A person reads it on the
 * Settings section This computer while deciding whether to install anything at all.
 *
 * Read-only, and there is deliberately no setter beside it. This product never
 * asks for a provider sign-in and never keeps one; the only thing it may know is
 * whether one is there. A `signIn()` on this bridge would be the first step
 * toward handling a credential, and the absence of it is the design. */
/* The person's OWN accounts for those programs live on the same bridge, for the
   same reason: they are facts about the machine rather than about a session, and
   that section reads them beside the presence line. Three thin arrows and
   nothing else -- there is still no signIn(), and its absence is still the
   design. accountAdd() records a name and a folder; the SIGNING IN happens in
   the provider's own program, from a command the person runs themselves. */
/* The sign-in arrows are the deliberate exception to "no signIn() here", and
   the exception is narrower than the name suggests: loginStart() asks the main
   process to open a fresh TERMINAL WINDOW running the PROVIDER'S OWN sign-in
   command, and installStart() asks it to run that program's official install.
   No credential, code or key can cross this bridge in either direction -- the
   install's child has no input at all, and the sign-in's window is the
   person's own and is read by nobody. What comes back is bounded prose and an
   exit number from the install, and from the sign-in only whether a window
   opened. The defect this closes: 1.0.20 told its first external user to run
   "codex login" in the window the install had just finished in, and that
   window answered "'codex' is not recognized". */
contextBridge.exposeInMainWorld('mcProviders', Object.freeze({
  presence: () => ipcRenderer.invoke('mc-providers:presence'),
  accounts: () => ipcRenderer.invoke('mc-accounts:list'),
  accountAdd: request => ipcRenderer.invoke('mc-accounts:add', request),
  accountRemove: request => ipcRenderer.invoke('mc-accounts:remove', request),
  /* A name into the list and nothing else: the folder and its sign-in stay. */
  accountRename: request => ipcRenderer.invoke('mc-accounts:rename', request),
  /* THREE MORE THIN ARROWS, AND STILL NO signIn(). accountSwitch() records
     WHICH of the already-listed accounts the next start should prefer -- a name
     into a small file, and nothing else; accountPolicy() records HOW this
     computer picks between them when nobody names one; accountUsage() asks how
     much of each account's hourly and weekly allowance is left. Nothing a
     person signs in with can cross any of the three in either direction: what
     goes out is a name and a number, and what comes back is names, statuses,
     percentages and reset times. */
  accountSwitch: request => ipcRenderer.invoke('mc-accounts:switch', request),
  accountPolicy: request => ipcRenderer.invoke('mc-accounts:policy', request),
  /* Deliberately a pull and not a subscription. It starts one short-lived
     program per Codex and per Claude account (Gemini is a file presence
     check), so it happens when a person opens the menu; a push channel here
     would be a background poll nobody started. */
  accountUsage: () => ipcRenderer.invoke('mc-accounts:usage'),
  /* TWO ARROWS FOR THE ACCOUNTS MENU'S "just a few clicks". accountAddManaged()
     takes a program and, if the person typed one, a name; the main process
     makes the folder and records the account, and answers with the name it
     took. accountSignIn() names a listed account and asks the main process to
     open that program's own sign-in in a fresh terminal window, with the
     account's folder already set as the program's home. Nothing a person
     signs in with can cross either arrow: what goes out is a name and a
     program, and what comes back is a name, a folder and whether a window
     opened. */
  accountAddManaged: request => ipcRenderer.invoke('mc-accounts:add-managed', request),
  accountSignIn: request => ipcRenderer.invoke('mc-accounts:sign-in', request),
  /* THE ONE PUSH ON THIS BRIDGE, AND WHY IT IS NOT THE POLL accountUsage()
     REFUSES TO BE. accountUsage() is deliberately a pull because answering it
     starts a program per account. This carries no work at all: the main
     process already has a watch armed on the ONE folder a person just pressed
     Sign in for, and this is how that one account's fresh answer reaches the
     row -- a name, a program and one of 'yes', 'no' or 'unknown'. Nothing is
     subscribed until somebody presses, nothing is watched that nobody pressed,
     and no byte of a sign-in file can cross: the main process never reads one.
     Returns its own unsubscribe, the shape onLoginEvent gives, because the
     menu mounts per page and each mount must detach exactly its own. */
  onAccountSignInChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('onAccountSignInChanged requires a listener function')
    const forward = (_event, packet) => { listener(packet) }
    ipcRenderer.on('mc-accounts:sign-in-changed', forward)
    return () => { ipcRenderer.removeListener('mc-accounts:sign-in-changed', forward) }
  },
  /* ADDING A CODEX CLOUD ACCOUNT, WHICH IS ONE ARROW AND NOT THREE. It takes a
     name; the main process has the engine create that account's home, record
     it, and open the sign-in window with the home already set. accountAdd()
     above is the OTHER list -- the one local agent rotation reads -- and the
     two are not interchangeable today; see the report that came with this
     change. What crosses back is a name, whether a window opened and a
     sentence: never a directory, never a registry path. */
  cloudAccountAdd: request => ipcRenderer.invoke('mc-accounts:add-cloud', request),
  loginStart: request => ipcRenderer.invoke('mc-provider-login:start', request),
  loginStop: request => ipcRenderer.invoke('mc-provider-login:stop', request),
  installStart: request => ipcRenderer.invoke('mc-provider-login:install', request),
  installSnapshot: request => ipcRenderer.invoke('mc-provider-login:snapshot', request),
  /* Which copy of each program is in use, whose it is and its version: words,
     a version string and a count, never a path (mc-provider-toolchain:status). */
  toolchainStatus: () => ipcRenderer.invoke('mc-provider-toolchain:status'),
  /* Returns its own unsubscribe, the same shape mcAgent.onEvent gives and for
     the same reason: the guide mounts per navigation, and each visit must be
     able to detach exactly its own listener. */
  onLoginEvent: listener => {
    if (typeof listener !== 'function') throw new TypeError('onLoginEvent requires a listener function')
    const forward = (_event, packet) => { listener(packet) }
    ipcRenderer.on('mc-provider-login:event', forward)
    return () => { ipcRenderer.removeListener('mc-provider-login:event', forward) }
  },
  /* A MODEL ON THIS COMPUTER'S OWN HARDWARE -- the fourth arrow on this same
     bridge (owner ruling via fleet-B: extend, do not add a parallel bridge).
     detectLocal answers a live network probe, never a PATH check like
     presence() above; installRuntime and pullModel stream through the SAME
     onLoginEvent listener already defined above, carrying the runtime id in
     the packet's `provider` field, so a caller already watching installs
     needs no second subscription to also watch these. */
  detectLocal: () => ipcRenderer.invoke('mc-providers:detect-local'),
  installRuntime: request => ipcRenderer.invoke('mc-provider-login:install-runtime', request),
  pullLocalModel: request => ipcRenderer.invoke('mc-provider-login:pull-model', request),
  stopRuntime: request => ipcRenderer.invoke('mc-provider-login:stop-runtime', request),
}))

/* Fleet data is resolved while the renderer's module graph is evaluating. An
   async-only bridge paints the sample first and leaves sim.js, vocab.js and
   the ledger frozen on it even after userData answers. The one synchronous
   operation is a bounded read; every mutation remains an explicit invoke. */
const bootstrap = ipcRenderer.sendSync('mc-fleet-profile:bootstrap')
contextBridge.exposeInMainWorld('mcFleetProfile', Object.freeze({
  bootstrap,
  migrateLegacy: profile => ipcRenderer.sendSync('mc-fleet-profile:migrate-legacy', profile),
  save: profile => ipcRenderer.invoke('mc-fleet-profile:save', profile),
  reset: () => ipcRenderer.invoke('mc-fleet-profile:reset'),
  importFile: () => ipcRenderer.invoke('mc-fleet-profile:import-file'),
  exportFile: profile => ipcRenderer.invoke('mc-fleet-profile:export-file', profile),
  chooseDirectory: () => ipcRenderer.invoke('mc-fleet-profile:choose-directory'),
  probe: profile => ipcRenderer.invoke('mc-fleet-profile:probe', profile),
}))

/* THE DECLARED ORGANISATION.
 *
 * Every one of these is an explicit invoke, including the read. There is no
 * synchronous bootstrap here on purpose: the fleet profile has one because the
 * renderer's module graph needs it before first paint, and the org does not --
 * the agent page asks for it when it mounts, and a page that has not been
 * opened should not be paying for a disk read at launch.
 *
 * Nothing here decides anything. Each call is forwarded to a main-process
 * handler that checks the sender is this application's own main frame, and the
 * rules about what a legal organisation is live in the payload. This file is a
 * list of channel names. */
/* THE FILES AN AGENT LEFT BEHIND, AND THE REPORTS IT WROTE.
 *
 * Every one of these is an explicit invoke, for the reason the org bridge
 * beside it gives and one more of its own: two of them reach the operating
 * system -- `open` starts whatever program this computer opens that file type
 * with, and `reveal` opens the file manager -- so there is no shape of this
 * bridge in which a page gets a synchronous answer or a cached one. Each call
 * goes to a main-process handler that checks the sender is this application's
 * own main frame before anything is judged.
 *
 * A PAGE CANNOT NAME A PATH THROUGH THIS BRIDGE. `folders()` returns folder ids
 * the main process minted for the folders a person already chose, and every
 * other call takes one of those ids plus a file NAME. There is no argument here
 * that a path fits in, which is a stronger property than refusing a bad one.
 *
 * This file remains a list of channel names. The fence -- "is this file inside
 * a folder the person chose" -- is the payload's own workspace boundary,
 * consulted in shell/agent-files.cjs. */
contextBridge.exposeInMainWorld('mcFiles', Object.freeze({
  folders: () => ipcRenderer.invoke('mc-files:folders'),
  list: request => ipcRenderer.invoke('mc-files:list', request),
  open: request => ipcRenderer.invoke('mc-files:open', request),
  reveal: request => ipcRenderer.invoke('mc-files:reveal', request),
  read: request => ipcRenderer.invoke('mc-files:read', request),
}))

contextBridge.exposeInMainWorld('mcOrg', Object.freeze({
  read: () => ipcRenderer.invoke('mc-org:read'),
  reparent: request => ipcRenderer.invoke('mc-org:reparent', request),
  assignRole: request => ipcRenderer.invoke('mc-org:assign-role', request),
  ensureSeat: request => ipcRenderer.invoke('mc-org:ensure-seat', request),
  releaseSeat: request => ipcRenderer.invoke('mc-org:release-seat', request),
  createRole: request => ipcRenderer.invoke('mc-org:create-role', request),
  editRole: request => ipcRenderer.invoke('mc-org:edit-role', request),
  resetRole: request => ipcRenderer.invoke('mc-org:reset-role', request),
  reset: () => ipcRenderer.invoke('mc-org:reset'),
  exportOrg: () => ipcRenderer.invoke('mc-org:export'),
}))

/* THE SETTINGS STORE, AND THE ONE-TIME RESCUE OF THE OLD BROWSER COPY.
 *
 * Read SYNCHRONOUSLY, and this one is not a preference among equals: the theme
 * is read by an inline script in index.html before first paint, so an async
 * bridge would paint the wrong theme at every launch and correct itself
 * visibly. Writes are synchronous too, which is a deliberate match for the API
 * being replaced -- localStorage.setItem is synchronous and durable when it
 * returns, and the packaged proof for this fix force-kills the process between
 * launches specifically so a store that only flushed at exit could not pass.
 *
 * THE DRAIN IS NOT PERFORMED HERE. It was, and that was a real defect with
 * measured consequences -- see the note on `drain` below. This bridge only
 * reports whether one is needed and forwards the entries the page reads. */
const prefs = ipcRenderer.sendSync('mc-prefs:bootstrap')

contextBridge.exposeInMainWorld('mcResources', Object.freeze({
  status: request => ipcRenderer.invoke('mc-resources:status', request),
  configure: value => ipcRenderer.invoke('mc-resources:configure', value),
}))

contextBridge.exposeInMainWorld('mcPrefs', Object.freeze({
  /* `available` is what public/durable-storage.js checks before replacing the
     global. A shell that could not open its settings file reports false and
     the app keeps the browser store, which is the pre-fix behaviour rather
     than an app with no working storage at all. */
  available: Boolean(prefs && prefs.ok),
  values: Object.freeze(prefs && prefs.ok ? { ...prefs.values } : {}),
  drainRequired: Boolean(prefs && prefs.ok && prefs.drainRequired),
  /* WHY THE PAGE IS SHOWING DEFAULTS, AND WHERE THE OLD FILE WENT.
     A settings file that cannot be read is preserved rather than replaced, and
     that half of the fix is invisible: the person still opens an app wearing
     none of their choices. Without these three the only conclusion available to
     them is the one this whole store exists to stop -- that the software threw
     their settings away. `preservedAt` is null here on nearly every launch,
     because the file is only set aside when a write actually happens; the live
     value travels back on the write result and public/durable-storage.js
     carries it forward. */
  damaged: prefs && prefs.ok && typeof prefs.damaged === 'string' ? prefs.damaged : null,
  preservedAt: prefs && prefs.ok && typeof prefs.preservedAt === 'string' ? prefs.preservedAt : null,
  file: prefs && prefs.ok && typeof prefs.file === 'string' ? prefs.file : null,
  /* THE DRAIN IS PERFORMED BY THE PAGE, NOT HERE, AND THAT IS THE WHOLE POINT.
     This preload first ran the migration itself, reading window.localStorage
     from its own isolated world. Measured on the packaged upgrade path: a
     legacy install with two real settings on http://127.0.0.1:4601 was read as
     ZERO entries, because a preload executes against the initial empty
     document, whose storage is not the app origin's. The record written was
     {"values":{},"drainedOrigins":["http://127.0.0.1:4601"]} -- the origin
     marked as rescued while nothing had been rescued, which STRANDED those
     settings permanently instead of losing them recoverably. A fix that
     destroys settings is the defect wearing a different hat.

     public/durable-storage.js runs as a classic script inside the real
     document, where localStorage is the app origin's, and it calls this only
     after it has successfully read that store. Nothing marks an origin
     drained on a read that did not happen. */
  drain: entries => ipcRenderer.sendSync('mc-prefs:drain', { entries }),
  /* A LIVE READ OF ONE KEY, past the launch copy in `values` above. The update
     check writes `mc.update.policy` from the main process after this page has
     booted; the settings row reads it here so it never shows the launch value
     over a newer one. See mc-prefs:read in shell/main.cjs. */
  read: key => ipcRenderer.sendSync('mc-prefs:read', { key }),
  write: (key, value, expectedValue) => ipcRenderer.sendSync('mc-prefs:write', { key, value,
    ...(expectedValue !== undefined ? { expectedValue } : {}) }),
  remove: key => ipcRenderer.sendSync('mc-prefs:remove', { key }),
  clear: () => ipcRenderer.sendSync('mc-prefs:clear'),
}))

/* The permission level. Read synchronously for the same reason the fleet
   profile is: src/main.js decides whether this launch shows the setup question
   or the fleet, and it decides that before the first paint. Setting the level
   stays an explicit invoke.

   `bootstrap` is present and `available: false` in a build with no capability
   payload, so the renderer can state that plainly instead of offering a button
   that is guaranteed to fail -- the same rule mcAgent.availability() follows.
   In a plain browser (vite dev, preview) window.mcSetup is absent entirely,
   which the renderer reads as "there is no machine here to configure". */
const setup = ipcRenderer.sendSync('mc-setup:bootstrap')
contextBridge.exposeInMainWorld('mcSetup', Object.freeze({
  bootstrap: setup,
  platform: process.platform,
  /* The consent rides with the level (owner, X4): for the widest level it says
     the risk was shown, in which words, and confirmed; the shell refuses that
     level without it. Null for every other level. */
  chooseTier: (tier, consent) => ipcRenderer.invoke('mc-setup:choose-tier', tier, consent),
  tierState: () => ipcRenderer.invoke('mc-setup:tier-state'),
  /* What the signed ledger holds about the widest level on this computer, so
     the Settings row can state a confirmation only when one is on record. */
  tierConsent: () => ipcRenderer.invoke('mc-setup:tier-consent'),
  sandboxStatus: () => ipcRenderer.invoke('mc-setup:sandbox-status'),
  sandboxPreparationSupported: process.platform === 'linux',
  prepareSandbox: () => ipcRenderer.invoke('mc-setup:sandbox-prepare'),
  /* The workspace question. Async, unlike `bootstrap`, and deliberately: the
     first-run gate has to know the permission level before the first paint, but
     nothing has to know the folder before the person has been asked about the
     level. A second synchronous read on startup would slow every launch to buy
     nothing. */
  workspaceState: () => ipcRenderer.invoke('mc-setup:workspace-state'),
  checkWorkspace: candidate => ipcRenderer.invoke('mc-setup:check-workspace', candidate),
  chooseWorkspace: () => ipcRenderer.invoke('mc-setup:choose-workspace'),
  recordWorkspaces: roots => ipcRenderer.invoke('mc-setup:record-workspaces', roots),
  editorSessionState: options => ipcRenderer.invoke('mc-setup:editor-session-state', options),
  setEditorImportPolicy: policy => ipcRenderer.invoke('mc-setup:editor-import-policy', policy),
  setEditorSurface: (surface, imported) => ipcRenderer.invoke('mc-setup:editor-surface', surface, imported),
  previewEditorSession: receipt => ipcRenderer.invoke('mc-setup:editor-session-preview', receipt),
  prepareEditorFork: receipt => ipcRenderer.invoke('mc-setup:editor-session-fork', receipt),
  adoptEditorSession: () => ipcRenderer.invoke('mc-setup:editor-session-adopt'),
}))

/* The product account.
 *
 * ASYNC ONLY, unlike `mcSetup.bootstrap` and the fleet profile, and that is a
 * decision rather than an oversight. Both of those are read synchronously
 * because the router must know them before the first paint. Signed-in state is
 * not in that class: the app opens on the fleet either way, and the sign-in
 * surface is a screen a person navigates to. Making it a fourth `sendSync`
 * would put a keystore read and a file read on every launch to buy nothing.
 *
 * NOTHING THIS BRIDGE RETURNS IS A SECRET. There is no token to hold: the
 * session lives in the main process and `current()` answers with `signedIn`, a
 * display name and an expiry. A password travels INWARD from the form and never
 * comes back out, in a reply or in an error message.
 *
 * There is deliberately no method that SETS who is signed in. The audit
 * principal is read in the main process from the store; a page that could name
 * the principal would make the record worthless. */
contextBridge.exposeInMainWorld('mcAccount', Object.freeze({
  availability: () => ipcRenderer.invoke('mc-account:availability'),
  current: () => ipcRenderer.invoke('mc-account:current'),
  create: request => ipcRenderer.invoke('mc-account:create', request),
  signIn: request => ipcRenderer.invoke('mc-account:sign-in', request),
  /* SIGN IN WITH GOOGLE. Note that NONE of these takes an argument, and that is
     the whole design: the page asks for the flow to start, the main process
     runs it against the system browser, and the identity arrives from Google
     already verified. A page that could pass an email address in here would be
     a page that could sign in as anybody. */
  googleAvailability: () => ipcRenderer.invoke('mc-account:google-availability'),
  googleSignIn: () => ipcRenderer.invoke('mc-account:google-sign-in'),
  googleLocalProfile: () => ipcRenderer.invoke('mc-account:google-local-profile'),
  /* The address the browser was sent to, so a person whose browser did not open
     can open it themselves. Carries no credential; answers nothing once the
     attempt has settled. */
  googleUrl: () => ipcRenderer.invoke('mc-account:google-url'),
  googleCancel: () => ipcRenderer.invoke('mc-account:google-cancel'),
  signOut: () => ipcRenderer.invoke('mc-account:sign-out'),
  signOutEverywhere: () => ipcRenderer.invoke('mc-account:sign-out-everywhere'),
  changePassword: request => ipcRenderer.invoke('mc-account:change-password', request),
  /* The shown name, changeable for the life of the account. It carries no
     credential in either direction and it cannot move an account: which account
     is renamed is decided in the main process from the session, exactly like
     the audit principal, so a page cannot rename somebody else. */
  changeDisplayName: request => ipcRenderer.invoke('mc-account:change-display-name', request),
  /* An account file that will not read is moved to a kept name beside it
     (T1520). It takes no argument and carries no credential. */
  setAsideDamaged: () => ipcRenderer.invoke('mc-account:set-aside-damaged'),
  /* WHAT BELONGS TO WHOEVER IS SIGNED IN. No method selects an account. An
     optional expectedAccountId is only a stale-view comparison fence; the main
     process still chooses the account from its session and refuses a mismatch. */
  data: () => ipcRenderer.invoke('mc-account:data'),
  getSetting: (key, options) => {
    const request = { key }
    if (options && Object.hasOwn(options, 'expectedAccountId')) request.expectedAccountId = options.expectedAccountId
    return ipcRenderer.invoke('mc-account:setting-get', request)
  },
  putSetting: (key, value, options) => {
    const request = { key, value }
    if (options && Object.hasOwn(options, 'expectedAccountId')) request.expectedAccountId = options.expectedAccountId
    return ipcRenderer.invoke('mc-account:setting-put', request)
  },
  /* Attachment names a vault KEY and never a value. There is no method here
     that reads a vault record, and adding one would be a different review. */
  attachPaymentMethod: request => ipcRenderer.invoke('mc-account:payment-attach', request),
  detachPaymentMethod: () => ipcRenderer.invoke('mc-account:payment-detach'),
  paymentPresence: () => ipcRenderer.invoke('mc-account:payment-presence'),
}))

/* REMOVING THIS COMPUTER'S DATA.
 *
 * TWO METHODS, AND NEITHER TAKES A PATH. Which directories are swept is decided
 * in the main process from `app.getPath('userData')` and the payload's own
 * installation root; a page that could name the directory would be a page that
 * could delete any folder on the computer, which is a remote-code-execution
 * primitive dressed as a settings control.
 *
 * `plan` is a READ. It measures and names what is there and destroys nothing, so
 * the screen can show a person what they are about to lose before they can lose
 * it. `erase` is the act. They are separate channels for that reason and must
 * stay separate: one call that measured and deleted would make the first press
 * the destructive one.
 *
 * NOTHING HERE RETURNS A SECRET. The replies are counts, directory paths, entry
 * names and outcomes. No file content is read, and the vault is named by its
 * path and never opened. */
/* THE OWNER'S ENCRYPTED CREDENTIAL VAULT, for the one Settings row that manages
 * it (src/vault-credentials-settings.js).
 *
 * `names` IS A NAME QUESTION AND THERE IS NO VALUE QUESTION HERE. This file is a
 * list of channel names, so it cannot itself keep a value out -- what keeps it
 * out is that no channel on the other side of these four has a value to give:
 * shell/vault-presence.cjs's vaultRecordNames runs the vault's 'list' verb,
 * which decrypts nothing, and its answer has no field that could carry a value,
 * a masked prefix or a length. Reading a value is deliberately NOT exposed to
 * any window; the main process reads the two Google sign-in records for itself
 * and nothing else asks.
 *
 * REMOVAL IS TWO CHANNELS BECAUSE IT IS TWO ACTS. `requestRemoval` asks the owner
 * to approve one deletion on the approvals screen; `completeRemoval` acts on his
 * answer. A page cannot collapse them: the second reads the decision out of the
 * prompt store, and nothing a renderer sends can put one there. */
/* THE NICKNAME AND ACCESS CHANNELS CARRY NO VALUE IN EITHER DIRECTION.
 * `policy` answers names, nicknames and booleans; the two setters send a record
 * name, a rule SUBJECT and a boolean. There is no verb on this object that can
 * return what a credential holds, which is the same rule the five above follow.
 * The subject is which role the owner's rule is about, and is the one thing
 * here that must come from the page. It is not the caller's identity: that is
 * taken from the IPC event in the main process, per the note above. */
contextBridge.exposeInMainWorld('mcVault', Object.freeze({
  names: () => ipcRenderer.invoke('mc-vault:names'),
  add: request => ipcRenderer.invoke('mc-vault:add', request),
  pendingRemovals: () => ipcRenderer.invoke('mc-vault:pending-removals'),
  requestRemoval: request => ipcRenderer.invoke('mc-vault:request-removal', request),
  completeRemoval: request => ipcRenderer.invoke('mc-vault:complete-removal', request),
  policy: () => ipcRenderer.invoke('mc-vault:policy'),
  setNickname: request => ipcRenderer.invoke('mc-vault:set-nickname', request),
  setAccess: request => ipcRenderer.invoke('mc-vault:set-access', request),
}))

contextBridge.exposeInMainWorld('mcLocalData', Object.freeze({
  plan: () => ipcRenderer.invoke('mc-reset:plan'),
  erase: () => ipcRenderer.invoke('mc-reset:erase'),
}))

/* THE INSTALLATION'S OWN SETTINGS -- the ones the capability layer enforces,
 * which live beside the machine record in this installation's directory and are
 * therefore outside a page's reach by design.
 *
 * This is NOT the settings page's other rows. Those are this window's own
 * preferences (theme, density, which screens read live data) and they belong in
 * the renderer's store. These four decide whether unattended work may run on
 * this computer, they are read by a different process, and until this channel
 * existed the product had no way to change them at all -- the research page
 * named a switch in Settings that Settings did not have.
 *
 * `read` is a read. `set` names one row and one value and can name nothing
 * else: shell/product-settings.cjs holds the list of rows this window may
 * write, and an id outside it is refused rather than written. */
contextBridge.exposeInMainWorld('mcSettings', Object.freeze({
  treeSlots: () => ipcRenderer.sendSync('mc-settings:tree-slots'),
  read: () => ipcRenderer.invoke('mc-settings:read'),
  set: (id, value, confirmation) => ipcRenderer.invoke('mc-settings:set', { id, value, confirmation }),
  // A Save that is also a working-profile application names the profile, so
  // the writer can leave a receipt of the rows that profile chose.
  setMany: (items, options) => ipcRenderer.invoke('mc-settings:set-many',
    typeof options?.workingProfile === 'string' ? { items, workingProfile: options.workingProfile } : items),
  confirmation: (id, value) => ipcRenderer.invoke('mc-settings:confirmation', { id, value }),
  diagnosticsInspect: request => ipcRenderer.invoke('mc-settings:diagnostics-inspect', request),
  diagnosticsKeep: request => ipcRenderer.invoke('mc-settings:diagnostics-keep', request),
  diagnosticsExport: request => ipcRenderer.invoke('mc-settings:diagnostics-export', request),
  diagnosticsArchive: request => ipcRenderer.invoke('mc-settings:diagnostics-archive', request),
  auditProbe: () => ipcRenderer.invoke('mc-settings:audit-probe'),
  auditConfirmation: request => ipcRenderer.invoke('mc-settings:audit-confirmation', request),
  auditRotate: request => ipcRenderer.invoke('mc-settings:audit-rotate', request),
  auditRevealArchive: request => ipcRenderer.invoke('mc-settings:audit-reveal-archive', request),
}))

/* COMPARING TWO FILES SIDE BY SIDE, AND EDITING BOTH.
 *
 * Three explicit invokes, for the reason mcOrg above gives: this window asks
 * for a file when a person opens the compare window, and a page nobody has
 * opened should not be paying for a disk read at launch. There is deliberately
 * no synchronous bootstrap here.
 *
 * `save` IS THE ONLY WRITE, and both save controls in the compare window --
 * the one under each pane -- go through it. shell/diff-file.cjs holds the
 * fence: the folder chosen in setup and the folder this product owns, the same
 * pair an agent session runs in, resolved through the real disk so a link
 * cannot lead out of it.
 *
 * This file is a list of channel names. Nothing here decides anything, and
 * every call is checked in the main process for coming from this application's
 * own main frame. */
contextBridge.exposeInMainWorld('mcDiff', Object.freeze({
  readChange: (filePath, context) => ipcRenderer.invoke('mc-diff:read-change', {
    path: filePath, ...(typeof context?.sessionId === 'string' ? { sessionId: context.sessionId } : {}),
  }),
  pick: side => ipcRenderer.invoke('mc-diff:pick', { side }),
  stamp: (filePath, context) => ipcRenderer.invoke('mc-diff:stamp', {
    path: filePath, ...(typeof context?.sessionId === 'string' ? { sessionId: context.sessionId } : {}),
  }),
  save: (filePath, text, context) => ipcRenderer.invoke('mc-diff:save', {
    path: filePath, text, ...(typeof context?.sessionId === 'string' ? { sessionId: context.sessionId } : {}),
  }),
}))

function rgbToHex(rgb) {
  const match = rgb.match(/^rgba?\(\s*(-?(?:\d+(?:\.\d+)?|\.\d+)%?)[, ]+\s*(-?(?:\d+(?:\.\d+)?|\.\d+)%?)[, ]+\s*(-?(?:\d+(?:\.\d+)?|\.\d+)%?)(?:\s*[,/]\s*(?:\d+(?:\.\d+)?|\.\d+)%?)?\s*\)$/i)
  if (!match) return '#fdfdfd'
  const byte = component => {
    const value = component.endsWith('%') ? Number(component.slice(0, -1)) * 2.55 : Number(component)
    return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0')
  }
  return `#${[match[1], match[2], match[3]].map(byte).join('')}`
}

let settleTimer = null
function reportTheme() {
  const send = () => {
    const style = getComputedStyle(document.body)
    ipcRenderer.send('mc-theme', {
      theme: document.documentElement.dataset.theme || 'white',
      bg: rgbToHex(style.backgroundColor),
      ink: rgbToHex(style.color),
    })
  }
  /* Two passes matter because the page surface eases between themes. A lone
     next-frame read sampled the old colour and left the caption buttons stuck
     on the previous theme until the owner focused the window again. */
  requestAnimationFrame(send)
  clearTimeout(settleTimer)
  settleTimer = setTimeout(send, 600)
}

/* Native caption buttons are OS-drawn over this strip. The strip stays
   transparent so it inherits the renderer surface instead of maintaining a
   second palette that can drift from styles.css. */
const TITLEBAR_HEIGHT = 36
function injectTitlebar() {
  document.documentElement.classList.add('in-shell')
  document.body.classList.add('in-shell')
  const style = document.createElement('style')
  style.textContent = `
    #shell-titlebar {
      position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_HEIGHT}px;
      z-index: 200; -webkit-app-region: drag;
      display: flex; align-items: center; justify-content: center;
      border-bottom: 1px solid var(--line, rgba(128,128,128,0.18));
      font-size: 11px; font-weight: 600; letter-spacing: 0.14em;
      color: var(--ink-3, #888); user-select: none;
    }
    /* Chromium inherits app-region through the renderer hit-test tree. Keep
       native and ARIA controls out of a draggable ancestor so a mouse press is
       delivered to the control instead of beginning a window drag. */
    button, input, select, textarea, a[href], [role="button"] {
      -webkit-app-region: no-drag;
    }
    html.in-shell { --shell-titlebar-height: ${TITLEBAR_HEIGHT}px; }
    html.in-shell #stage { height: calc(100vh - ${TITLEBAR_HEIGHT}px); margin-top: ${TITLEBAR_HEIGHT}px; }
    html.in-shell .topbar { top: calc(14px + ${TITLEBAR_HEIGHT}px); }
    html.in-shell .drawer { top: calc(14px + ${TITLEBAR_HEIGHT}px); }
    /* THE ONE FIXED SURFACE THIS LIST FORGOT. home.css's full-page chat
       takeover (.home-takeover) is position: fixed; inset: 0, its own top
       never touched here -- so its first child, .home-takeover-bar (the
       "Show" subject-picker + Close), painted its whole row inside this
       strip's own 0..TITLEBAR_HEIGHT band: submerged under a HIGHER z-index
       (200 against the takeover's 80) and, worse, under this strip's
       edge-to-edge drag region, which only exempts button/input/select/
       textarea/a[href]/[role=button] above -- not the label or the span
       that names the control, so a press on the word "Show" itself started
       a window drag instead of opening the picker. Same fix as #stage and
       .topbar: push the surface's own top down by the strip's height, the
       one thing this rule is already pattern for. inset:0 leaves the top
       value easy to override alone; bottom:0 is untouched, so the surface
       still shrinks to leave the room rather than spilling under the strip. */
    html.in-shell .home-takeover { top: ${TITLEBAR_HEIGHT}px; }
  `
  document.head.appendChild(style)
  const bar = document.createElement('div')
  bar.id = 'shell-titlebar'
  bar.textContent = 'TOOLSENABLED'
  document.body.prepend(bar)
}

window.addEventListener('DOMContentLoaded', () => {
  injectTitlebar()
  reportTheme()
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  // A throttled background frame heals as soon as the window returns.
  window.addEventListener('focus', reportTheme)
})
