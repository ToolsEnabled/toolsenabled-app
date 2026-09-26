/* A CREDENTIAL CAN BE SWITCHED OFF FOR THIS COMPUTER'S SCHEDULER.
 *
 * WHY THIS SUITE EXISTS. 1.0.46 closed the enforcement half of this: every
 * transport that dispatches a tool now names a principal, and a scheduled run
 * names `scheduler` in code (engine/src/job-runner.js, pinned from that side by
 * engine/tests/vault-dispatch-principals.test.js). The policy file both repos
 * share -- <state root>/state/vault-access-policy.json -- will therefore refuse
 * a scheduled read of a record whose `access.scheduler` is false.
 *
 * Nothing on this page could write that false. The matrix draws its controls
 * from ROLE_COLOR_NAMES, which is the palette of roles an AGENT runs as, and
 * the scheduler is not one of them: it is the installation's own automation.
 * So the owner had an enforced rule they had no way to author -- the mirror image
 * of the defect the page's own header comment warns about, a lock with no key
 * rather than a key with no lock.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT. These cases say the control
 * exists, that pressing it writes the exact principal the dispatch site names,
 * and that a scheduler rule is not ALSO drawn as a typed-in agent rule -- two
 * controls over one decision would let the page disagree with itself. As in
 * tools/test/vault-page.test.mjs, nothing here asserts appearance: the DOM
 * stand-in has no cascade.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* The view imports its stylesheets, which Vite resolves and node does not. */
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

installDomStandIn(globalThis)

const { vaultView, matrixRoles, nonRolePrincipals, VAULT_PAGE_COPY } = await import('../../src/views/vault.js')

/* The name a scheduled vault read actually arrives under. Quoted from
   engine/src/job-runner.js:
     agentPrincipal: Object.freeze({ roleId: 'scheduler', agentId: 'scheduler-runner-v1' })
   The rule is written against the roleId because the engine's mayRead refuses
   as soon as ANY of the names a read carries is false, so ruling on the stable
   role name covers the versioned runner id too. */
const SCHEDULER = 'scheduler'

function bridgeOf({ names = ['stripe_secret_key'], records = {} } = {}) {
  const calls = []
  return {
    calls,
    names: async () => ({ ok: true, code: 'VAULT_NAMES_READ', names }),
    policy: async () => ({ readable: true, records }),
    setNickname: async request => { calls.push(['setNickname', request]); return { ok: true } },
    setAccess: async request => { calls.push(['setAccess', request]); return { ok: true } }
  }
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/* The DOM stand-in refuses a selector carrying a colon, and every `access:`
   field name has one, so these cases reach a control by its marker attribute
   and read the field names off the nodes instead of asking for them by name.
   tools/test/vault-redesign-regression.test.mjs patches the stand-in for the
   same reason; nothing here needs it to. */
const fieldsIn = node => [...node.querySelectorAll('[data-vault-field]')].map(item => item.getAttribute('data-vault-field'))

test('the scheduler is offered as its own control, and is not one of the agent roles', () => {
  const ids = nonRolePrincipals().map(principal => principal.id)
  assert.ok(ids.includes(SCHEDULER), 'the owner must be offered a control for the scheduler')
  /* It is listed apart from the roles on purpose: a scheduled run is this
     computer acting for itself, not an agent wearing a role. Drawing it among
     Builder and Reviewer would tell the owner something untrue about it. */
  assert.equal(matrixRoles().map(role => role.id).includes(SCHEDULER), false)
  for (const principal of nonRolePrincipals()) {
    assert.match(principal.id, /^[A-Za-z0-9_.:-]{1,120}$/,
      `${principal.id} must satisfy the policy's principal shape, or the rule cannot be stored`)
    assert.ok(principal.label && principal.label !== principal.id,
      `${principal.id} must be labelled in words the owner reads, not by its wire name`)
  }
})

test('the editor draws a scheduler control for every credential, before any rule exists', async () => {
  const view = vaultView({ vault: bridgeOf({ names: ['stripe_secret_key'], records: {} }) })
  await settle()

  const control = view.el.querySelector(`[data-vault-automation=${SCHEDULER}]`)
  assert.ok(control, 'a credential nobody has ruled on must still offer the scheduler control')
  /* Unruled reads as allowed, because that is what the policy actually does. */
  assert.equal(control.checked, true)
})

test('turning the scheduler off writes the principal a scheduled read arrives under', async () => {
  const bridge = bridgeOf({ names: ['stripe_secret_key'], records: {} })
  const view = vaultView({ vault: bridge })
  await settle()

  const control = view.el.querySelector(`[data-vault-automation=${SCHEDULER}]`)
  control.checked = false
  control.dispatchEvent({ type: 'change' })
  await settle()

  /* The subject must be exactly the name the dispatch site fixes in code. A
     rule spelled anything else is stored, shown as set, and matches no read --
     which is worse than no control, because it reads as a closed door. */
  assert.deepEqual(bridge.calls, [['setAccess', { name: 'stripe_secret_key', subject: SCHEDULER, allowed: false }]])
})

test('a stored scheduler refusal draws as refused and counts as a restriction', async () => {
  const view = vaultView({ vault: bridgeOf({
    names: ['stripe_secret_key'],
    records: { stripe_secret_key: { nickname: null, access: { [SCHEDULER]: false } } }
  }) })
  await settle()

  assert.equal(view.el.querySelector(`[data-vault-automation=${SCHEDULER}]`).checked, false)
  assert.equal(view.el.querySelector('[data-vault-access-summary]').textContent, '1 access restriction')
  assert.equal(view.el.querySelector('[data-vault-fact="restricted"]').textContent, '1')
})

test('a scheduler rule is not also drawn as a typed-in agent rule', async () => {
  const view = vaultView({ vault: bridgeOf({
    names: ['stripe_secret_key'],
    records: { stripe_secret_key: { nickname: null, access: { [SCHEDULER]: false, 'agent:sample': false } } }
  }) })
  await settle()

  /* Before the control existed the scheduler fell through to the "individual
     agents" list, because that list is everything the policy names that the
     matrix does not draw. One decision drawn twice can be left disagreeing with
     itself by a repaint, and the summary would have counted it twice over. */
  const agents = view.el.querySelector('[data-vault-agents]')
  assert.deepEqual(fieldsIn(agents), ['access:agent:sample'],
    'the scheduler has its own control, so it must not also be listed among the individually named agents')
  assert.equal(view.el.querySelector('[data-vault-access-summary]').textContent,
    '2 access restrictions · 1 individual agent rule')
})

test('typing the scheduler into the agent field is refused, and says where the control is', async () => {
  const bridge = bridgeOf({ names: ['stripe_secret_key'], records: {} })
  const view = vaultView({ vault: bridge })
  await settle()

  const field = view.el.querySelector('[data-vault-agent-id]')
  field.value = SCHEDULER
  field.dispatchEvent({ type: 'input' })
  view.el.querySelector('[data-vault-save-agent]').click()
  await settle()

  /* Same reason as a role: the page already has a control for this decision,
     and a second one written by hand is how the two come to disagree. */
  assert.deepEqual(bridge.calls, [], 'a second control over one decision must not be written')
  assert.equal(view.el.querySelector('[data-vault-status]').textContent, VAULT_PAGE_COPY.agentIdRefused)
})
