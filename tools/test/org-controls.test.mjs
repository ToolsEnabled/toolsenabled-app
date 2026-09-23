/* The organisation controls sit between the views and window.mcOrg. These
 * tests exercise the data/copy exports directly; DOM builders are deliberately
 * left to browser-level coverage rather than replacing the DOM with a second
 * implementation here. */

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ORG_ABSENT_REASON,
  claimLabel,
  failureSentence,
  isRevisionConflict,
  orgBridge,
  orgNoticeMarkup,
  orgNotices,
  readOrg,
  roleOptionLabel,
} from '../../src/org-controls.js'

const originalBridge = globalThis.mcOrg

afterEach(() => {
  if (originalBridge === undefined) delete globalThis.mcOrg
  else globalThis.mcOrg = originalBridge
})

test('the bridge is usable only when it supplies the read operation callers await', () => {
  globalThis.mcOrg = { assignRole() {} }
  assert.equal(orgBridge(), null, 'a bridge without read must not be offered to callers')

  const bridge = { read: async () => ({ ok: true }) }
  globalThis.mcOrg = bridge
  assert.equal(orgBridge(), bridge, 'a readable organisation bridge must be returned unchanged')
})

test('readOrg distinguishes absence and failures from a successful organisation read', async () => {
  delete globalThis.mcOrg
  const absent = await readOrg()
  assert.equal(absent.state, 'absent', 'a missing bridge must remain unknown, not become a definite organisation answer')
  assert.equal(absent.reason, ORG_ABSENT_REASON, 'plain-browser callers must receive the reason the editing surface can show')

  globalThis.mcOrg = { read: async () => { throw new Error('disk unavailable') } }
  const threw = await readOrg()
  assert.equal(threw.state, 'failed', 'a thrown read must remain failed, not become a ready or absent answer')
  assert.match(threw.reason, /could not be read.*disk unavailable/i, 'a thrown read must explain both the failed operation and its cause')

  globalThis.mcOrg = { read: async () => ({ ok: false, code: 'ORG_CORRUPT', reason: 'Saved organisation is damaged.' }) }
  const refused = await readOrg()
  assert.deepEqual(refused, {
    state: 'failed', code: 'ORG_CORRUPT', reason: 'Saved organisation is damaged.',
  }, 'a refused read must preserve the store diagnosis without manufacturing organisation data')

  const payload = { org: { revision: 7 }, roles: [{ id: 'controller' }], overlayFile: '/profile/org.json' }
  globalThis.mcOrg = { read: async () => ({ ok: true, ...payload }) }
  assert.deepEqual(await readOrg(), { state: 'ready', ...payload }, 'a successful read must expose the exact fields the views consume')
})

test('role labels state the enforced ability rather than trusting descriptive wording', () => {
  const worker = { id: 'worker', name: 'Worker', capabilities: { mayClaimWork: true } }
  const observer = { id: 'observer', name: 'Observer', capabilities: { mayClaimWork: false } }
  assert.equal(claimLabel(worker), 'can be given jobs', 'a mechanically eligible role must be labelled as able to receive jobs')
  assert.equal(claimLabel(observer), 'watch only', 'an ineligible role must be labelled watch-only even when its name sounds active')
  assert.match(roleOptionLabel(observer), /^Observer\b.*\bwatch only$/, 'a role option must pair its human name with its enforced consequence')
})

test('organisation notices explain recovery and drift while markup treats diagnoses as text', () => {
  const diagnosis = '<img src=x onerror=steal()> could not load'
  const org = {
    damaged: diagnosis,
    baselineDrift: { savedHash: 'secret-saved-hash', currentHash: 'secret-current-hash' },
  }
  const notices = orgNotices(org)
  assert.deepEqual(notices.map(({ kind }) => kind), ['damaged', 'drift'], 'damage and baseline drift must each remain visible to the user')
  assert.match(notices[0].text, /ships with.*change.*starts from/is, 'the damage notice must say what was recovered and what the next edit uses')
  assert.match(notices[1].text, /version.*in force.*newer default.*not being applied/is, 'the drift notice must identify which organisation remains effective')

  const markup = orgNoticeMarkup(org)
  assert.ok(markup.includes('&lt;img src=x onerror=steal()&gt;'), 'a store diagnosis must be escaped while remaining visible in notice markup')
  assert.doesNotMatch(markup, /secret-(?:saved|current)-hash/, 'notice markup must describe drift without exposing internal hashes')
})

test('refusal helpers preserve a useful reason and identify only the revision-conflict code', () => {
  const reason = 'The controller cannot report to another agent.'
  assert.match(failureSentence({ ok: false, reason }), /^The controller cannot report.*(?:try|change|choose|look|check)/is,
    'a refusal must retain the store diagnosis and add an action the user can take')
  assert.equal(isRevisionConflict({ code: 'AGENT_ORG_STORE_REVISION_CONFLICT' }), true,
    'the store revision-conflict code must select the re-read recovery path')
  assert.equal(isRevisionConflict({ code: 'AGENT_ORG_STORE_UNKNOWN_AGENT' }), false,
    'an unrelated refusal must not be presented as a revision conflict')
})
