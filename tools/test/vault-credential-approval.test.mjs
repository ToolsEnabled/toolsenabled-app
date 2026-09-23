/* CARRYING ONE OWNER DECISION TO THE TOOL THAT DELETES, DRIVEN.
 *
 * WHAT IS AT STAKE IN BOTH DIRECTIONS, which is why this file exists rather
 * than an assertion that the code "threads a token":
 *
 *   TOO LITTLE  the owner approves a removal at #/approvals and then meets
 *               APPROVAL_REQUIRED from a tool that wants an approval of its
 *               own. Two prompts for one decision -- a control that does not
 *               work, and the defect this path was built to remove.
 *   TOO MUCH    a grant that outlives its one use, or satisfies a removal of a
 *               credential the owner never saw. That is worse than the second
 *               prompt it replaces, because the owner's authority is then
 *               spendable on something he did not decide.
 *
 * So the counts matter more than the outcomes here, and every test below counts
 * mints and dispatches rather than only looking at what came back.
 *
 * THE BINDING AND THE SINGLE USE ARE NOT ASSERTED HERE -- THEY ARE MEASURED
 * AGAINST THE PRODUCT. The last test drives the payload's own approvals module
 * and a real state store in a throwaway file: mint for one vault key, offer it
 * for another, replay it. Those three answers come from
 * `consumeApprovalGrant`'s transaction, not from anything in this repository,
 * and that is the point -- this module's job is to go THROUGH that layer, so
 * proving the layer's promise is proving the design. It SKIPS BY NAME when no
 * payload is available, because "could not look" is not "it holds".
 *
 * No credential value appears anywhere in this file. The vault KEYS below are
 * synthetic names; no value is ever created, passed or stored on this path --
 * the removal carries a key and a bounded reason and nothing else.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { TOOL, createOwnerApprovedRemover } = require_(path.join(ROOT, 'shell', 'vault-credential-approval.cjs'))

const SESSION = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' })
const APPROVAL_REQUIRED = () => Object.assign(
  new Error(`Tool '${TOOL}' requires a one-time approval token from system.ask.`),
  { code: 'APPROVAL_REQUIRED' })

/* A dispatch that behaves like the real one: it refuses without a token while
   `gated` is true, and it records every call so a test can count them. */
function harness({ gated = true, alwaysGated = false, dispatchError = null } = {}) {
  const dispatches = []
  const mints = []
  const audits = []
  const remover = createOwnerApprovedRemover({
    permissionSession: SESSION,
    executeTool: async (name, args, context) => {
      dispatches.push({ name, args, context })
      if (dispatchError) throw dispatchError
      const carriesToken = args.approvalToken !== undefined
      if (gated && (!carriesToken || alwaysGated)) throw APPROVAL_REQUIRED()
      return { ok: true, key: args.vaultKey, status: 'cleared' }
    },
    createGrant: async grant => { mints.push(grant); return { approvalId: `approval-${mints.length}` } },
    inputHash: (action, args) => `hash:${action}:${JSON.stringify(args)}`,
    tokenHash: token => `tokenhash:${token}`,
    randomToken: () => randomBytes(32).toString('base64url'),
    onGrant: entry => audits.push(entry),
  })
  return { remover, dispatches, mints, audits }
}

test('a tool that is not gated is removed with no grant created at all', async () => {
  const { remover, dispatches, mints, audits } = harness({ gated: false })
  const answer = await remover({ vaultKey: 'w87_alpha', reason: 'no_longer_needed', ownerPromptId: 'prompt-1' })
  assert.equal(answer.status, 'cleared')
  /* THE COUNT IS THE ASSERTION. Minting a grant for a tool nobody asked one
     for is how a removal that worked becomes APPROVAL_NOT_REQUIRED. */
  assert.equal(mints.length, 0, 'a grant was created for a tool that never asked for one')
  assert.equal(audits.length, 0, 'an approval was recorded for a grant that was never needed')
  assert.equal(dispatches.length, 1, 'an ungated removal took more than one dispatch')
  assert.equal(dispatches[0].args.approvalToken, undefined, 'the first dispatch carried a token')
})

test('a gated tool gets exactly one grant, bound to the exact removal', async () => {
  const { remover, dispatches, mints, audits } = harness()
  const answer = await remover({ vaultKey: 'w87_alpha', reason: 'provider_revoked', ownerPromptId: 'prompt-7' })
  assert.equal(answer.status, 'cleared', 'the removal did not complete after the owner had approved it')

  assert.equal(mints.length, 1, 'a gated removal minted a different number of grants than one')
  assert.equal(dispatches.length, 2, 'a gated removal took a different number of dispatches than two')
  /* THE FIRST DISPATCH IS THE GATE QUESTION, and it must carry no token: that
     is what keeps an ungated installation from ever minting one. */
  assert.equal(dispatches[0].args.approvalToken, undefined, 'the gate question carried a token')
  assert.ok(dispatches[1].args.approvalToken, 'the retry carried no token, so the gate would refuse again')

  /* BOUND TO THIS REMOVAL, AND NOTHING ELSE. The hash is computed over the
     exact arguments the dispatch will hash after it strips the token, so a
     grant for one key cannot answer for another. */
  assert.equal(mints[0].action, TOOL)
  assert.equal(mints[0].inputHash, `hash:${TOOL}:${JSON.stringify({ vaultKey: 'w87_alpha', reason: 'provider_revoked' })}`,
    'the grant is bound to arguments other than the removal it authorises')
  assert.equal(mints[0].tokenHash, `tokenhash:${dispatches[1].args.approvalToken}`,
    'the grant was minted for a token other than the one the dispatch carried')
  assert.ok(mints[0].expiresAtMs > Date.now(), 'the grant was minted already expired')

  /* THE STORE NEVER SEES THE TOKEN, only its hash -- the same rule
     system.ask's own minting follows. */
  assert.equal(mints[0].token, undefined, 'the raw token was handed to the store')
  assert.ok(!Object.values(mints[0]).includes(dispatches[1].args.approvalToken),
    'the raw token appears somewhere in what was handed to the store')

  /* WHY IT EXISTS IS RECORDED, AND THE TOKEN IS NOT PART OF WHY. */
  assert.equal(audits.length, 1, 'the grant was not recorded exactly once')
  assert.equal(audits[0].ownerPromptId, 'prompt-7', 'the record does not name the owner decision that authorised the grant')
  assert.equal(audits[0].vaultKey, 'w87_alpha')
  assert.ok(!JSON.stringify(audits[0]).includes(dispatches[1].args.approvalToken),
    'the audit record carries the approval token')
})

test('a gate that refuses twice is reported, never answered with a second grant', async () => {
  /* A LOOP HERE WOULD SPEND THE OWNER'S AUTHORITY REPEATEDLY against a target
     that keeps moving. One retry, then the refusal is his answer. */
  const { remover, dispatches, mints } = harness({ alwaysGated: true })
  await assert.rejects(
    () => remover({ vaultKey: 'w87_alpha', reason: 'no_longer_needed', ownerPromptId: 'prompt-2' }),
    error => error.code === 'APPROVAL_REQUIRED')
  assert.equal(mints.length, 1, 'a persistent gate was answered with more than one grant')
  assert.equal(dispatches.length, 2, 'a persistent gate was retried more than once')
})

test('a failure that is not about approval mints nothing and is not retried', async () => {
  for (const code of ['SECRET_MANAGER_NOT_INSTALLED', 'PERMISSION_SESSION_REQUIRED', 'SECRET_REMOVAL_DEDICATED_PATH']) {
    const { remover, dispatches, mints } = harness({ dispatchError: Object.assign(new Error('no'), { code }) })
    await assert.rejects(
      () => remover({ vaultKey: 'w87_alpha', reason: 'no_longer_needed', ownerPromptId: 'prompt-3' }),
      error => error.code === code)
    assert.equal(mints.length, 0, `${code} caused a grant to be created`)
    assert.equal(dispatches.length, 1, `${code} was retried`)
  }
})

test('a removal that names no owner approval mints nothing and removes nothing', async () => {
  /* THE ATTRIBUTION IS A PRECONDITION, not a label. A grant nobody can trace
     to a decision is a grant that did not come from one. */
  const { remover, dispatches, mints } = harness()
  for (const ownerPromptId of [undefined, null, '', 0]) {
    await assert.rejects(
      () => remover({ vaultKey: 'w87_alpha', reason: 'no_longer_needed', ownerPromptId }),
      error => error.code === 'OWNER_APPROVAL_UNATTRIBUTED')
  }
  assert.equal(mints.length, 0, 'an unattributed removal minted a grant')
  assert.equal(dispatches.length, 0, 'an unattributed removal reached the dispatch')
})

test('a remover cannot be built without a stated dispatch ceiling', () => {
  /* The rule the dispatch itself states -- absence must refuse, never default.
     This lane already shipped that defect once. */
  assert.throws(() => createOwnerApprovedRemover({
    executeTool: async () => ({}), createGrant: async () => ({}),
    inputHash: () => 'h', tokenHash: () => 't',
  }), /permissionSession must be stated/)
})

test('the removal carries a key and a reason, and never a value', async () => {
  const { remover, dispatches } = harness()
  await remover({ vaultKey: 'w87_alpha', reason: 'legacy_cleanup', ownerPromptId: 'prompt-4' })
  for (const dispatch of dispatches) {
    assert.deepEqual(
      Object.keys(dispatch.args).filter(key => key !== 'approvalToken').sort(),
      ['reason', 'vaultKey'],
      'the removal dispatch carries a field beyond the record name and the reason')
  }
})

/* ------------------------------------------------------------------------
 * THE TWO PROMISES THAT MAKE A CARRIED TOKEN SAFER THAN A SECOND PROMPT,
 * MEASURED AGAINST THE PRODUCT'S OWN STORE.
 */
test('the product refuses a carried grant for another record, and refuses a replay', t => {
  const payload = process.env.MC_TEST_CAPABILITY_PAYLOAD
  if (!payload) {
    t.skip('MC_TEST_CAPABILITY_PAYLOAD is not set, so the real approvals module and state store could not be driven. '
      + 'The binding and single-use promises above are therefore NOT measured in this run -- that is "could not look", '
      + 'not "they hold". Name a payload to run this.')
    return
  }
  let store = null
  let file = null
  let directory = null
  try {
    const approvals = require_(path.join(payload, 'src', 'lib', 'approvals.js'))
    const stateStore = require_(path.join(payload, 'src', 'lib', 'state-store.js'))
    directory = mkdtempSync(path.join(ownedFixtureTempRoot(), 'w87-grant-'))
    file = path.join(directory, 'state.sqlite3')
    store = stateStore.createStateStore({ file })

    const mine = { vaultKey: 'w87_alpha', reason: 'no_longer_needed' }
    const other = { vaultKey: 'w87_beta', reason: 'no_longer_needed' }
    const token = randomBytes(32).toString('base64url')
    store.createApprovalGrant({
      action: TOOL,
      inputHash: approvals.actionInputHash(TOOL, mine),
      tokenHash: approvals.tokenHash(token),
      expiresAtMs: Date.now() + 60_000,
    })

    /* 1  BOUND TO THE RECORD THE OWNER SAW. */
    assert.throws(() => store.consumeApprovalGrant({
      action: TOOL, inputHash: approvals.actionInputHash(TOOL, other), tokenHash: approvals.tokenHash(token),
    }), error => error.code === 'APPROVAL_BINDING_MISMATCH',
    'a grant minted for one credential was accepted for another')

    /* A different ACTION is refused on the same grounds, so a removal approval
       cannot be spent on some other tool. */
    assert.throws(() => store.consumeApprovalGrant({
      action: 'system.credential_request', inputHash: approvals.actionInputHash(TOOL, mine), tokenHash: approvals.tokenHash(token),
    }), error => error.code === 'APPROVAL_BINDING_MISMATCH' || error.code === 'APPROVAL_NOT_FOUND',
    'a removal approval was accepted for a different tool')

    /* 2  ONE USE. Consumed once... */
    const consumed = store.consumeApprovalGrant({
      action: TOOL, inputHash: approvals.actionInputHash(TOOL, mine), tokenHash: approvals.tokenHash(token),
    })
    assert.equal(consumed.status, 'consumed', 'the grant was not consumed by the removal it authorised')

    /* ...and never again. Executed, not reasoned about. */
    assert.throws(() => store.consumeApprovalGrant({
      action: TOOL, inputHash: approvals.actionInputHash(TOOL, mine), tokenHash: approvals.tokenHash(token),
    }), error => error.code === 'APPROVAL_ALREADY_USED',
    'a consumed grant was accepted a second time')
  } finally {
    try { store?.close?.() } catch { /* the directory removal below is the cleanup that matters */ }
    if (directory) { try { rmSync(directory, { recursive: true, force: true }) } catch { /* a locked sqlite handle on Windows */ } }
  }
})
