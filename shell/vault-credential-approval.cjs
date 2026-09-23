'use strict'

/* CARRYING THE OWNER'S ONE DECISION THROUGH TO THE TOOL THAT DELETES.
 *
 * THE DEFECT THIS REMOVES. `system.credential_remove` is `approvalEligible`, so
 * when the installation's policy gates it the dispatch refuses with
 * APPROVAL_REQUIRED -- "requires a one-time approval token from system.ask".
 * The Settings vault page already raises a real confirmation on the owner's own
 * approvals surface and will not remove anything until he approves it there. So
 * before this file, a person who approved the deletion at #/approvals then met
 * a SECOND approval wall for the same act. Two prompts for one decision is not
 * safety; it is a control that does not work, and the owner's ruling is that
 * R1225 wants ONE prompt.
 *
 * WHAT THIS IS NOT. It is not a bypass and not a standing grant. The tool's
 * approval path is used exactly as it is designed: a grant is created, bound to
 * one action and one exact argument set, and the dispatch CONSUMES it. Three
 * properties come from the product's own store rather than from anything
 * written here, which is the whole reason to go through it:
 *
 *   APPROVAL_BINDING_MISMATCH  a grant minted for one vault key cannot satisfy
 *                              a removal of another -- the binding is a hash of
 *                              { action, arguments }
 *   APPROVAL_ALREADY_USED      consumption is one transaction; a replay loses
 *   APPROVAL_EXPIRED           the grant has a short life of its own
 *
 * Measured against both engine payloads on this machine: a grant minted for
 * `vaultKey: w87_alpha` refused `w87_beta` with APPROVAL_BINDING_MISMATCH,
 * consumed once for its own key, and refused the replay with
 * APPROVAL_ALREADY_USED.
 *
 * WHEN THE GRANT IS MINTED, AND WHY THAT ORDER IS THE SAFETY PROPERTY.
 *
 *   1  Nothing here is reachable until shell/vault-credential-page.cjs's
 *      `completeCredentialRemoval` has passed all four of its refusals: this
 *      seam issued the prompt, for THIS name, the owner answered, and the
 *      answer was approve.
 *   2  Then this dispatches WITH NO TOKEN. If the installation does not gate
 *      the tool, that call is the whole story and NO GRANT IS EVER CREATED.
 *   3  Only an APPROVAL_REQUIRED refusal -- the tool itself saying the gate is
 *      on -- causes exactly one grant to be minted and exactly one retry.
 *
 * ASKING THE DISPATCH RATHER THAN ASKING THE POLICY IS DELIBERATE.
 * shell/agent-confinement-read.cjs answers the same question by calling
 * `requiresApproval`, and says why: "It asks the same function the dispatch
 * asks", so a page built on it "cannot describe a gate the run would not
 * apply." This goes one better and asks the run. A second copy of the policy
 * question here could disagree with the dispatch, and the direction it would
 * disagree in is minting a grant for a tool that did not want one -- which the
 * dispatch then refuses with APPROVAL_NOT_REQUIRED, turning a working removal
 * into a failure. The first attempt is a gate check: APPROVAL_REQUIRED is
 * raised before the tool's handler runs, so nothing is removed by it.
 *
 * ONE RETRY, COUNTED, NEVER A LOOP. A second APPROVAL_REQUIRED is propagated,
 * not answered with a second grant.
 *
 * THE TOKEN DOES NOT LEAVE THIS FUNCTION. It is not returned, not logged, not
 * put in an error, and not handed to the audit hook -- `onGrant` is told which
 * owner prompt authorised the grant and which key it is bound to, never the
 * token and never a credential value. There is no `console` call in this file.
 */

const TOOL = 'system.credential_remove'
/* Short on purpose. The grant exists to carry one decision across one dispatch
   that happens immediately; a long life would make it a standing permission by
   accident. Well inside the store's own ceiling. */
const GRANT_TTL_MS = 120_000
const VAULT_KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Build the remover shell/vault-credential-page.cjs calls once the owner has
 * approved one removal on the approvals surface.
 *
 * @param {object} deps
 * @param {Function} deps.executeTool the payload's tool dispatch
 * @param {Function} deps.createGrant `createApprovalGrant` from the payload's
 *   own state store. Never called before a dispatch asks for a token.
 * @param {Function} deps.inputHash `actionInputHash` from the payload's
 *   approvals module -- the SAME hash the dispatch's `consume` computes, which
 *   is what makes the binding real rather than asserted here.
 * @param {Function} deps.tokenHash `tokenHash` from that module.
 * @param {object} deps.permissionSession the stated dispatch ceiling.
 * @param {Function} [deps.randomToken] 43-character token source.
 * @param {Function} [deps.now]
 * @param {Function} [deps.onGrant] audit hook; never receives the token.
 */
function createOwnerApprovedRemover(deps = {}) {
  const {
    executeTool, createGrant, inputHash, tokenHash, permissionSession,
    randomToken = () => require('node:crypto').randomBytes(32).toString('base64url'),
    now = Date.now,
    onGrant = null,
  } = deps
  for (const [name, value] of [['executeTool', executeTool], ['createGrant', createGrant],
    ['inputHash', inputHash], ['tokenHash', tokenHash]]) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  }
  if (permissionSession === undefined) {
    /* The same rule the dispatch states: absence must refuse rather than
       default. A remover with no ceiling is the defect this lane already fixed
       once. */
    throw new TypeError('permissionSession must be stated')
  }

  return async function removeApprovedCredential({ vaultKey, reason, ownerPromptId } = {}) {
    if (typeof vaultKey !== 'string' || !VAULT_KEY_RE.test(vaultKey)) {
      throw failure('VAULT_KEY_INVALID', 'That is not a vault record this product will remove.')
    }
    if (typeof reason !== 'string' || !reason) {
      throw failure('SECRET_REASON_INVALID', 'A removal reason is required.')
    }
    /* THE OWNER PROMPT IS REQUIRED TO MINT, not merely nice to record. A grant
       minted with nothing to attribute it to is a grant nobody can trace back
       to a decision, and this whole path exists because a decision was made. */
    if (typeof ownerPromptId !== 'string' || !ownerPromptId) {
      throw failure('OWNER_APPROVAL_UNATTRIBUTED',
        'This removal names no owner approval, so no approval will be carried for it. Nothing was removed.')
    }

    /* The arguments the dispatch will hash after it strips `approvalToken`. One
       object, used for the call AND for the binding, so the two cannot drift. */
    const executionArguments = { vaultKey, reason }

    try {
      return await executeTool(TOOL, { ...executionArguments }, { permissionSession })
    } catch (error) {
      if (error?.code !== 'APPROVAL_REQUIRED') throw error

      const token = randomToken()
      const expiresAtMs = now() + GRANT_TTL_MS
      const grant = await createGrant({
        action: TOOL,
        inputHash: inputHash(TOOL, executionArguments),
        tokenHash: tokenHash(token),
        expiresAtMs,
      })
      if (onGrant) {
        /* What is worth recording is that this grant exists BECAUSE of that
           owner prompt. The token is not part of that fact. */
        onGrant({ ownerPromptId, vaultKey, approvalId: grant?.approvalId ?? null, expiresAtMs })
      }
      /* EXACTLY ONE RETRY. A second APPROVAL_REQUIRED means the grant did not
         satisfy the gate, and minting again would be guessing at a moving
         target with the owner's authority. */
      return await executeTool(TOOL, { ...executionArguments, approvalToken: token }, { permissionSession })
    }
  }
}

module.exports = { GRANT_TTL_MS, TOOL, createOwnerApprovedRemover }
