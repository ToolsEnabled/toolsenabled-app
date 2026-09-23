'use strict'

/* THE OWNER'S ENCRYPTED CREDENTIAL VAULT, AS A SETTINGS SURFACE.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the main-process seam behind one Settings
 * row. It holds exactly three questions:
 *
 *   list    which records are on file, BY NAME
 *   add     ask the owner for a new one, through the form the product already
 *           has, without this file ever seeing what he types
 *   remove  take one away, and ONLY after the owner has approved that exact
 *           removal on the product's own approvals surface
 *
 * IT WRITES NO CREDENTIAL AND IT DELETES NOTHING ITSELF. `add` enqueues into
 * the queue `system.credential_request` enqueues into, and the detached owner
 * form is what touches the vault. `remove` calls the product's one generic
 * removal verb -- the `system.credential_remove` tool -- through the injected
 * `removeCredential` seam. A second writer or a second remover here would be
 * two ways to do one thing, which is the defect this project has ruled against
 * twice (see the header of shell/vault-presence.cjs).
 *
 * WHY DELETION IS THE ONE ACTION WITH A PROMPT. Active Ledger rule R1225: the
 * authority to do a task arrives with the task, "except for deletion which
 * requires a prompt". So `requestRemoval` does not delete -- it enqueues a
 * `confirmation` owner prompt, and `completeRemoval` refuses until that prompt
 * comes back APPROVED. A renderer `confirm()` would satisfy nothing here: it is
 * a dialog the page draws for itself, it leaves no durable record, and it is
 * not the surface the owner already uses to decide things
 * (#/approvals, src/ledger-prompt-queue.js over
 * capability/src/lib/mission-bridge/owner-prompts.js).
 *
 * THE APPROVAL IS BOUND TO THE NAME, AND THE BINDING IS KEPT HERE. The prompt
 * store's `settledDecision` answers "was this prompt approved" and carries no
 * subject -- id, kind, reason, time, decision, and nothing about what was being
 * confirmed. So an approval for record A would otherwise authorise deleting
 * record B, and a `purchase_batch` approval would authorise a deletion. Both
 * are the unbound-confirmation defect class the prompt store names in its own
 * `decide`. This file therefore records which name each promptId was issued
 * for, durably, and refuses any (promptId, name) pair it did not issue.
 *
 * NO VALUE CROSSES THIS BOUNDARY IN EITHER DIRECTION. `list` goes through
 * vaultRecordNames, whose answer has no value-bearing field. `add` sends a key
 * NAME and public context, never a value. `remove` sends a key NAME. Nothing
 * here logs, and there is no `console` call in this file.
 */

const fs = require('node:fs')
const path = require('node:path')

const { vaultRecordNames, NAME_ANSWER_KEYS } = require('./vault-presence.cjs')

/* The key shape tools/secrets.ps1 accepts, restated so a name this seam sends
   to a destructive verb cannot be something the vault never issued. */
const VAULT_KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/
/* owner-prompt-queue.js's own LABEL_RE. A label outside it is refused there, so
   refusing it here names the reason instead of surfacing OWNER_PROMPT_INVALID. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/
/* The bounded reasons system.credential_remove accepts. Free text is not
   accepted by that tool and is not accepted here either. */
const REMOVAL_REASONS = Object.freeze([
  'no_longer_needed', 'provider_revoked', 'account_changed', 'legacy_cleanup',
])
/* Public context the owner form shows above the field. The owner is the
   requester on this path, and these three sentences say exactly that -- they
   are not a claim about which tool wants the record, because from Settings
   nothing does yet. Bounded by owner-prompt-queue's REQUEST_CONTEXT_VALUE_RE. */
const SETTINGS_REQUEST_CONTEXT = Object.freeze({
  purpose: 'Added by the owner from the Settings vault page',
  scope: "Whatever this product's tools read this record for",
  lifetime: 'Until the owner removes it from the Settings vault page',
})
/* The requester name owner-prompt-queue.js accepts for a fixed local workflow.
   It is a CLAIM the queue stamps as `declared`, never as verified, and this is
   a local workflow rather than an agent, which is what that name means. */
const SETTINGS_REQUESTER = 'toolsenabled'

const APPROVAL_TTL_MS = 60 * 60 * 1000
const MAX_PENDING_APPROVALS = 24

function refusal(code, reason) {
  return Object.freeze({ ok: false, code, reason })
}

/* --------------------------------------------------------------------------
 * LOADING THE PAYLOAD'S OWN MODULES.
 *
 * Same pattern and same reason as shell/agent-confinement-read.cjs: these
 * modules ship in the capability payload, not in the shell, so they are
 * resolved from the capabilityRoot the caller states rather than required at
 * the top of this file. A payload that is present but unloadable answers a
 * NAMED refusal; it is never reported as "there is nothing here".
 */
function payloadModule(capabilityRoot, segments, load = require) {
  if (typeof capabilityRoot !== 'string' || !capabilityRoot) return null
  try {
    return load(path.join(capabilityRoot, ...segments))
  } catch {
    return null
  }
}

function credentialQueueFor(options) {
  return options.ownerPromptQueue
    || payloadModule(options.capabilityRoot, ['src', 'lib', 'providers', 'owner-prompt-queue.js'], options.load)
}

function credentialCatalogueFor(options) {
  return options.credentialCatalogue
    || payloadModule(options.capabilityRoot, ['src', 'lib', 'credential-metadata.js'], options.load)
}

function ownerPromptsFor(options) {
  return options.ownerPrompts
    || payloadModule(options.capabilityRoot, ['src', 'lib', 'mission-bridge', 'owner-prompts.js'], options.load)
}

/* --------------------------------------------------------------------------
 * WHICH RECORDS ARE ON FILE, BY NAME.
 *
 * THE SHAPE FENCE IS THE POINT OF THIS WRAPPER. vaultRecordNames pins the keys
 * of its own answer; this re-checks them before anything is handed to a window,
 * so a future field on that answer cannot reach a renderer without somebody
 * deciding to widen NAME_ANSWER_KEYS on purpose. A masked prefix or a character
 * count would arrive exactly that way.
 */
async function listCredentialNames(options = {}) {
  const answer = await (options.readNames || vaultRecordNames)({
    capabilityRoot: options.capabilityRoot,
    stateRoot: options.stateRoot,
    ...(options.run ? { run: options.run } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    /* The Linux reader's module loader, threaded through rather than
       re-defaulted here, so a suite can drive the Linux branch against a real
       reader shape instead of only against a missing file. */
    ...(options.loadLinuxVault ? { loadLinuxVault: options.loadLinuxVault } : {}),
  })
  if (!answer || typeof answer !== 'object') {
    return refusal('VAULT_RESPONSE_INVALID', 'This installation’s vault did not answer, so what it holds is unknown.')
  }
  const surplus = Object.keys(answer).filter(key => !NAME_ANSWER_KEYS.includes(key))
  if (surplus.length > 0) {
    /* The surplus field is NOT carried into this refusal. If a value ever
       reached this seam, naming the field that held it is safe and printing it
       is not. */
    return refusal('VAULT_NAME_ANSWER_UNEXPECTED_FIELD',
      'The vault reader answered with more than the record names, so nothing was shown. This is a fault in this installation, not in your vault.')
  }
  if (answer.readable !== true || !Array.isArray(answer.names)) {
    return refusal(answer.code || 'VAULT_READ_FAILED', answer.detail
      || 'This installation’s vault could not be read, so what it holds is unknown.')
  }
  if (answer.names.some(name => typeof name !== 'string' || !VAULT_KEY_RE.test(name))) {
    return refusal('VAULT_RESPONSE_INVALID',
      'This installation’s vault answered with something that is not a record name, so nothing was shown.')
  }
  return Object.freeze({ ok: true, code: 'VAULT_NAMES_READ', names: Object.freeze([...answer.names]), store: answer.store })
}

/* --------------------------------------------------------------------------
 * ADDING ONE, THROUGH THE FORM THE PRODUCT ALREADY HAS.
 *
 * Two payload functions, the same two `system.credential_request` uses:
 * credential-metadata's resolveCredentialRequest turns the owner's choice into
 * the key and label the product recognises, and owner-prompt-queue's enqueue
 * puts the request where the detached owner form will find it. What the owner
 * types goes from that form into the vault and never through this process.
 */
function requestCredentialAdd(request = {}, options = {}) {
  const catalogue = credentialCatalogueFor(options)
  const queue = credentialQueueFor(options)
  if (!catalogue || typeof catalogue.resolveCredentialRequest !== 'function') {
    return refusal('CREDENTIAL_CATALOGUE_UNAVAILABLE',
      'This installation cannot read its own credential catalogue, so it cannot ask you for a new credential. Nothing was changed.')
  }
  if (!queue || typeof queue.enqueue !== 'function') {
    return refusal('OWNER_PROMPT_QUEUE_UNAVAILABLE',
      'This installation cannot reach the form that collects a credential, so it cannot ask you for one. Nothing was changed.')
  }
  let resolved
  try {
    resolved = catalogue.resolveCredentialRequest({
      credential: request.credential,
      ...(request.customName === undefined ? {} : { customName: request.customName }),
      ...(request.account === undefined ? {} : { account: request.account }),
    })
  } catch (error) {
    /* The catalogue's refusals name the CHOICE, never a value -- it is given no
       value to name. They are the most useful sentence available here. */
    return refusal(typeof error?.code === 'string' ? error.code : 'CREDENTIAL_CHOICE_INVALID',
      typeof error?.message === 'string' && error.message.length <= 200
        ? error.message
        : 'That is not a credential this product can ask you for.')
  }
  if (!resolved || !VAULT_KEY_RE.test(String(resolved.key || '')) || !LABEL_RE.test(String(resolved.label || ''))) {
    return refusal('CREDENTIAL_CHOICE_INVALID', 'That credential has no usable name in this product, so nothing was asked for.')
  }
  let queued
  try {
    queued = queue.enqueue({
      kind: 'credential',
      vaultKey: resolved.key,
      label: resolved.label,
      requestContext: SETTINGS_REQUEST_CONTEXT,
      requester: SETTINGS_REQUESTER,
    })
  } catch (error) {
    return refusal(typeof error?.code === 'string' ? error.code : 'OWNER_PROMPT_QUEUE_FAILED',
      typeof error?.message === 'string' && error.message.length <= 200
        ? error.message
        : 'This installation could not queue the form that asks you for a credential. Nothing was changed.')
  }
  return Object.freeze({
    ok: true,
    code: 'CREDENTIAL_REQUEST_QUEUED',
    vaultKey: resolved.key,
    label: resolved.label,
    requestId: queued?.requestId ?? null,
    replayed: queued?.replayed === true,
  })
}

/* --------------------------------------------------------------------------
 * THE (promptId -> name) BINDING, ON DISK.
 *
 * Small, bounded and atomic. It exists because the prompt store's settled
 * decision names no subject; see this file's header. Entries expire, so an
 * approval the owner gave an hour ago cannot be replayed against a record he
 * re-created since.
 */
function approvalsFile(stateRoot) {
  if (typeof stateRoot !== 'string' || !stateRoot) return null
  return path.join(stateRoot, 'state', 'vault-removal-approvals.json')
}

function readApprovals(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.pending)) return []
    return parsed.pending.filter(entry => entry
      && typeof entry.promptId === 'string'
      && typeof entry.name === 'string'
      && Number.isSafeInteger(entry.requestedAtMs))
  } catch {
    /* An unreadable or absent record means no approval is on file, which is the
       CAUTIOUS answer on a delete path: nothing gets removed. It is never read
       the other way. */
    return []
  }
}

function writeApprovals(file, pending) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, pending }), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
}

function live(entry, nowMs) {
  return nowMs - entry.requestedAtMs < APPROVAL_TTL_MS
}

/* HAS THE OWNER ALREADY ANSWERED NO TO THIS PROMPT?
 *
 * Only a DECIDED, non-approve answer counts. Unreadable, unsettled, superseded
 * and expired all answer false -- this decides whether to REUSE a binding, and
 * getting it wrong towards "reuse" is recoverable (the completion refuses and
 * frees the binding) while getting it wrong towards "ask again" spends a second
 * owner prompt on a question already answered. Neither answer can remove
 * anything: completeCredentialRemoval re-reads the decision itself. */
function refusedAlready(prompts, promptId, options) {
  if (!prompts || typeof prompts.settledDecision !== 'function') return false
  let settled
  try {
    settled = prompts.settledDecision(promptId, options.ownerPromptDependencies || {})
  } catch {
    return false
  }
  if (!settled || settled.settledReason !== 'decided') return false
  return !(settled.decision && typeof settled.decision === 'object' && settled.decision.decision === 'approve')
}

/* --------------------------------------------------------------------------
 * ASKING THE OWNER TO APPROVE ONE REMOVAL.
 *
 * This deletes nothing. It puts a `confirmation` on the surface the owner
 * already uses and hands back the id, so the page can say where to go and the
 * completion below can name what was approved.
 */
function requestCredentialRemoval(request = {}, options = {}) {
  const name = String(request.name ?? '')
  if (!VAULT_KEY_RE.test(name)) {
    return refusal('VAULT_KEY_INVALID', 'That is not a record this product will act on.')
  }
  const file = approvalsFile(options.stateRoot)
  if (!file) {
    return refusal('VAULT_STATE_ROOT_REQUIRED',
      'This installation cannot find its own state directory, so it cannot record an approval. Nothing was changed.')
  }
  const prompts = ownerPromptsFor(options)
  if (!prompts || typeof prompts.enqueue !== 'function') {
    return refusal('OWNER_PROMPT_SURFACE_UNAVAILABLE',
      'This installation cannot reach the screen where you approve things, so it will not remove a credential. Nothing was changed.')
  }
  const clock = options.clock || Date.now

  /* A LIVE BINDING FOR THIS RECORD IS REUSED, NEVER REPLACED.
   *
   * MEASURED ON SCREEN, on a fresh state root: one Remove made one binding and
   * one approvals card; the owner approved the card; and back on the vault page
   * the only control offered was Remove again -- which minted a SECOND promptId
   * and ORPHANED the approved one. The owner's decision was spent, the
   * credential stayed, and the single affordance on the screen was the one that
   * threw away another approval. A person following the screen exactly could
   * never complete a removal.
   *
   * So the question "has this record already been asked about" is answered
   * before anything is enqueued, from the durable file rather than from any
   * page's memory. Replaying the same promptId is not a new decision and must
   * not look like one.
   *
   * REUSE THE BINDING, NOT THE GRANT. The approval this returns to is the one
   * the owner already answered; it is still spent exactly once by
   * completeCredentialRemoval, still bound to this name, and still refused on
   * replay. Nothing about single-use is relaxed by not asking twice. */
  /* AND A BINDING THE OWNER HAS ALREADY SAID NO TO IS NOT REUSED. It stays in
   * the file until a completion consumes it, so an owner who denies the card
   * and comes back WITHOUT pressing the finish button would otherwise be told
   * "your answer is still waiting" about an answer that was no, and handed back
   * a dead prompt. Pressing Remove after a refusal is a new question and gets a
   * new one. Only "approved" and "not answered yet" are live decisions. */
  const existingNow = clock()
  const existing = readApprovals(file)
    .filter(entry => entry.name === name && live(entry, existingNow))
    .find(entry => !refusedAlready(prompts, entry.promptId, options))
  if (existing) {
    return Object.freeze({
      ok: true,
      code: 'OWNER_APPROVAL_ALREADY_REQUESTED',
      name,
      promptId: existing.promptId,
      approvalHref: '#/approvals',
      reused: true,
    })
  }

  let queued
  try {
    queued = prompts.enqueue({
      kind: 'confirmation',
      title: 'Remove a stored credential',
      /* The NAME, because that is what the owner is deciding about, and nothing
         else. No value exists on this path to leak into a sentence. */
      message: `Remove the credential stored under "${name}" from this computer's encrypted vault? `
        + 'This cannot be undone; you would have to enter it again. Nothing is removed unless you approve this.',
      ttlMs: null,
    }, options.ownerPromptDependencies || {})
  } catch (error) {
    return refusal(typeof error?.code === 'string' ? error.code : 'OWNER_PROMPT_FAILED',
      typeof error?.message === 'string' && error.message.length <= 200
        ? error.message
        : 'This installation could not ask you to approve this removal. Nothing was changed.')
  }
  const promptId = String(queued?.promptId ?? '')
  if (!promptId) {
    return refusal('OWNER_PROMPT_FAILED', 'This installation could not ask you to approve this removal. Nothing was changed.')
  }
  const nowMs = clock()
  /* ONE BINDING PER RECORD. Any earlier entry for this name is dropped rather
     than left behind it: the reuse above takes the first live match, so a stale
     entry for the same record would shadow the prompt just enqueued. */
  const pending = readApprovals(file)
    .filter(entry => live(entry, nowMs) && entry.promptId !== promptId && entry.name !== name)
  pending.push({ promptId, name, requestedAtMs: nowMs })
  try {
    writeApprovals(file, pending.slice(-MAX_PENDING_APPROVALS))
  } catch {
    /* The prompt is already durable in the store, so it is named back to the
       caller rather than lost -- the same rule owner-prompt-queue.js states
       about a launch failure not replacing the caller's real answer. Without
       the binding the completion below will refuse, which is the safe end. */
    return refusal('VAULT_APPROVAL_NOT_RECORDED',
      'This installation asked you to approve the removal but could not record which credential it was about, so it will not act on your answer. Nothing was changed.')
  }
  return Object.freeze({ ok: true, code: 'OWNER_APPROVAL_REQUESTED', name, promptId, approvalHref: '#/approvals' })
}

/* --------------------------------------------------------------------------
 * WHAT IS ALREADY WAITING FOR THE OWNER, READ BACK FROM DISK.
 *
 * THE DEFECT THIS EXISTS TO FIX. The binding has always been durable --
 * <stateRoot>/state/vault-removal-approvals.json -- and the page never read it
 * back. It held the promptId in memory instead, and approving requires LEAVING
 * the page for #/approvals, which clears that memory. So the approved decision
 * became unreachable: the page could not offer to complete a removal it no
 * longer knew about, and the only control left was Remove, which minted a new
 * prompt and orphaned the approved one.
 *
 * NO PROOF CAUGHT IT, AND THE REASON IS WORTH STATING PLAINLY: every
 * end-to-end, mine and the reviewer's, drove request and complete IN ONE
 * PROCESS. The navigation never happened, so the in-memory state never
 * cleared. The seam was right and the screen was not, and an in-process proof
 * cannot tell those apart. That is what R1219 means by hand testing beside the
 * scripts.
 *
 * IT REPORTS THE DECISION, NOT JUST THE BINDING. A page that knew only "you
 * asked about this" would still have to guess whether to offer completion. The
 * three answers are kept apart the way the rest of this file keeps them apart:
 * approved, still waiting, or answered no.
 *
 * NO VALUE, AND NO TOKEN. This carries record NAMES, prompt ids and a decision
 * word. There is nothing else on this path to carry.
 */
function pendingCredentialRemovals(options = {}) {
  const file = approvalsFile(options.stateRoot)
  if (!file) {
    return refusal('VAULT_STATE_ROOT_REQUIRED',
      'This installation cannot find its own state directory, so it cannot tell you what is waiting for your approval.')
  }
  const prompts = ownerPromptsFor(options)
  if (!prompts || typeof prompts.settledDecision !== 'function') {
    return refusal('OWNER_PROMPT_SURFACE_UNAVAILABLE',
      'This installation cannot read your answers, so it cannot tell you what is waiting for your approval.')
  }
  const nowMs = (options.clock || Date.now)()
  const waiting = []
  for (const entry of readApprovals(file)) {
    if (!live(entry, nowMs)) continue
    let settled
    try {
      settled = prompts.settledDecision(entry.promptId, options.ownerPromptDependencies || {})
    } catch {
      /* Unreadable is NOT "approved" and not "denied". A removal path must never
         round an unknown answer up. */
      waiting.push({ name: entry.name, promptId: entry.promptId, decision: 'unknown' })
      continue
    }
    const approved = settled
      && settled.settledReason === 'decided'
      && settled.kind === 'confirmation'
      && settled.decision
      && typeof settled.decision === 'object'
      && settled.decision.decision === 'approve'
    const answered = Boolean(settled && settled.settledReason === 'decided')
    waiting.push({
      name: entry.name,
      promptId: entry.promptId,
      decision: approved ? 'approved' : answered ? 'refused' : 'waiting',
    })
  }
  return Object.freeze({ ok: true, code: 'VAULT_REMOVALS_PENDING_READ', pending: Object.freeze(waiting) })
}

/* --------------------------------------------------------------------------
 * THE ENFORCEMENT POINT. Nothing removes a credential except through here.
 *
 * FOUR REFUSALS BEFORE ANY REMOVER IS CALLED, and each is a different fact:
 *
 *   no binding        this seam never asked the owner about THIS name under
 *                     THIS prompt id
 *   not settled       the owner has not answered yet -- `settledDecision`
 *                     returns null, which the prompt store's own comment says
 *                     the spend path must read as DENIED, and so does this
 *   wrong kind        a purchase or a notice is not a confirmation of a
 *                     deletion, however it was decided
 *   not approved      he answered, and the answer was not "approve"
 *
 * Only after all four does the injected remover run, once, and the binding is
 * consumed either way so an approval cannot be spent twice.
 */
/* THE REMOVER IS AWAITED, AND removed:true IS NOT SAID BEFORE IT RESOLVES.
 *
 * MEASURED FAILURE THIS SHAPE EXISTS TO END. This function used to read the
 * remover's return synchronously. The remover the shell supplies is
 * `tool-registry.js#executeTool`, which is `async`, so `result` was a Promise
 * and every one of the following happened on one press:
 *
 *   - this function answered { ok: true, removed: true, code:
 *     'CREDENTIAL_REMOVED' } before the removal had been attempted;
 *   - the IPC reply failed `structuredClone` with DataCloneError, because a
 *     Promise sat in the payload, so the renderer's call REJECTED;
 *   - the renderer voids that call, so the rejection was silent;
 *   - the approval binding had already been consumed.
 *
 * And the dispatch itself then rejected with PERMISSION_SESSION_REQUIRED,
 * because `executeTool` refuses a call that states no permission ceiling. Net
 * effect: the page told the person a credential was deleted, spent the owner
 * prompt he had approved, and deleted nothing. That is worse than a removal
 * that plainly fails, because he has no reason to check.
 *
 * THREE RULES FOLLOW, AND THE SUITE DRIVES ALL THREE WITH A REJECTING REMOVER.
 *   1  await. `removed: true` is only ever said after the removal resolved.
 *   2  NOTHING BUT PLAIN SCALARS COME BACK. The tool's own lifecycle payload is
 *      deliberately NOT carried -- it is somebody else's shape, it crosses an
 *      IPC boundary that clones, and carrying it is precisely what broke. Every
 *      answer this function can produce survives structuredClone, asserted.
 *   3  A FAILED REMOVAL DOES NOT SPEND THE APPROVAL. The owner said yes and the
 *      product failed; making him approve again would blame him for that.
 *      Only an owner ANSWER (approve-and-removed, deny, wrong kind) consumes
 *      the binding.
 */
async function completeCredentialRemoval(request = {}, options = {}) {
  const name = String(request.name ?? '')
  const promptId = String(request.promptId ?? '')
  const reason = String(request.reason ?? 'no_longer_needed')
  if (!VAULT_KEY_RE.test(name)) {
    return refusal('VAULT_KEY_INVALID', 'That is not a record this product will act on.')
  }
  if (!REMOVAL_REASONS.includes(reason)) {
    return refusal('SECRET_REASON_INVALID', 'That is not a reason this product records for a removal.')
  }
  const file = approvalsFile(options.stateRoot)
  if (!file) {
    return refusal('VAULT_STATE_ROOT_REQUIRED',
      'This installation cannot find its own state directory, so it cannot check your approval. Nothing was removed.')
  }
  const prompts = ownerPromptsFor(options)
  if (!prompts || typeof prompts.settledDecision !== 'function') {
    return refusal('OWNER_PROMPT_SURFACE_UNAVAILABLE',
      'This installation cannot read your approval, so it will not remove a credential. Nothing was removed.')
  }
  const clock = options.clock || Date.now
  const nowMs = clock()
  const pending = readApprovals(file)
  const bound = pending.find(entry => entry.promptId === promptId && entry.name === name && live(entry, nowMs))
  if (!bound) {
    return refusal('OWNER_APPROVAL_NOT_REQUESTED',
      'This installation has no record of asking you to approve removing this credential, so it will not remove it. Ask again from Settings.')
  }
  let settled
  try {
    settled = prompts.settledDecision(promptId, options.ownerPromptDependencies || {})
  } catch (error) {
    return refusal(typeof error?.code === 'string' ? error.code : 'OWNER_APPROVAL_UNREADABLE',
      'This installation could not read your answer, so it will not remove a credential. Nothing was removed.')
  }
  if (!settled) {
    return Object.freeze({
      ok: false, removed: false, code: 'OWNER_APPROVAL_PENDING',
      reason: 'You have not answered yet, so nothing was removed. Open your approvals screen to decide.',
      approvalHref: '#/approvals', promptId, name,
    })
  }
  const consume = () => {
    try { writeApprovals(file, pending.filter(entry => entry.promptId !== promptId)) } catch { /* the TTL still retires it */ }
  }
  if (settled.kind !== 'confirmation') {
    consume()
    return refusal('OWNER_APPROVAL_WRONG_KIND',
      'The answer on file is not a decision about removing this credential, so nothing was removed.')
  }
  /* THE DOCUMENTED SHAPE, AND NOTHING ELSE COUNTS AS APPROVAL. The prompt store
     settles a decided confirmation as `{ settledReason: 'decided', decision: {
     decision: 'approve' | 'deny', decidedAt } }`; a superseded or expired record
     settles with `decision: null`. Anything this does not recognise is refused
     rather than read generously -- on a delete path an unreadable answer must
     never resolve to "yes". */
  const approved = settled.settledReason === 'decided'
    && settled.decision
    && typeof settled.decision === 'object'
    && settled.decision.decision === 'approve'
  if (!approved) {
    consume()
    return Object.freeze({
      ok: false, removed: false, code: 'OWNER_APPROVAL_NOT_GIVEN',
      reason: 'You did not approve this removal, so nothing was removed.', promptId, name,
    })
  }
  const remove = options.removeCredential
  if (typeof remove !== 'function') {
    return refusal('CREDENTIAL_REMOVER_UNAVAILABLE',
      'This installation has no working way to remove a credential from its vault, so it did not pretend to. Your approval is still on file.')
  }
  try {
    /* THE OWNER PROMPT ID TRAVELS WITH THE REMOVAL. The remover needs it to
       carry the owner's one decision through to a tool that asks for an
       approval of its own (shell/vault-credential-approval.cjs), and it is what
       ties the grant it mints back to the decision that authorised it. */
    await remove({ vaultKey: name, reason, ownerPromptId: promptId })
  } catch (error) {
    /* THE APPROVAL IS NOT SPENT. Rule 3 above: the owner answered yes and the
       product could not carry it out, so his answer stays on file and pressing
       again retries rather than starting over. */
    return Object.freeze({
      ok: false,
      removed: false,
      code: typeof error?.code === 'string' ? error.code : 'SECRET_REMOVAL_FAILED',
      reason: typeof error?.message === 'string' && error.message.length <= 200
        ? error.message
        : 'This installation could not remove that credential from its vault. Nothing was removed and your approval is still on file.',
      promptId,
      name,
    })
  }
  consume()
  /* Plain scalars only -- rule 2 above. The remover's own answer is discarded
     on purpose and is not logged either; it is a tool payload of unknown shape
     and this value crosses an IPC boundary that clones. */
  return Object.freeze({ ok: true, removed: true, code: 'CREDENTIAL_REMOVED', name, promptId })
}

module.exports = {
  LABEL_RE,
  pendingCredentialRemovals,
  MAX_PENDING_APPROVALS,
  REMOVAL_REASONS,
  SETTINGS_REQUESTER,
  SETTINGS_REQUEST_CONTEXT,
  VAULT_KEY_RE,
  approvalsFile,
  completeCredentialRemoval,
  listCredentialNames,
  requestCredentialAdd,
  requestCredentialRemoval,
}
