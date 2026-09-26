import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PATHS, pendingJourney, runJourney } from '../lib/surface-tests/journeys.mjs'
import { browserActions } from '../lib/surface-tests/browser-path-actions.mjs'
import { MANUAL_PATHS } from '../lib/surface-tests/manual-paths.mjs'
import { pathCatalog, pathsMarkdown } from '../lib/surface-tests/path-catalog.mjs'

const MOBILE_FRA_PATHS = [
  'mobile-account-login-logout',
  'phone-account-login-logout',
  'phone-fra-claim',
  'phone-fra-reconnect-disconnect',
]

const REQUIRED_CONTROLS = {
  'mobile-account-login-logout': ['/signin/', 'form.first()', '/v1/account', 'selector unknown'],
  'phone-account-login-logout': ['/signin/', 'form.first()', '/v1/account', 'selector unknown'],
  'phone-fra-claim': ['/signin/', 'form.first()', '/account/', 'selector is unknown', 'data-connect-status', 'data-connect-action', 'data-connect-code'],
  'phone-fra-reconnect-disconnect': ['/account/', 'selector is unknown', 'data-connect-disconnect', 'data-connect-status', 'data-connect-action'],
}

const REQUIRED_EVIDENCE = {
  'mobile-account-login-logout': /manual hosted\/mobile observation/,
  'phone-account-login-logout': /manual physical-Safari observation/,
  'phone-fra-claim': /manual physical-Safari \+ desktop observation/,
  'phone-fra-reconnect-disconnect': /manual physical-Safari \+ desktop observation/,
}

function inertLocator({ count = 0, visible = false } = {}) {
  return {
    count: async () => count,
    isVisible: async () => visible,
  }
}

test('mobile and FRA login paths stay manual, observable, and unrun', () => {
  const selected = pathCatalog(['mobile', 'phone'])
  const byId = new Map(selected.map(path => [path.id, path]))
  const rawById = new Map(MANUAL_PATHS.map(path => [path.id, path]))
  const browserIds = new Set(BROWSER_PATHS.map(path => path.id))

  assert.equal(new Set(selected.map(path => path.id)).size, selected.length)
  for (const id of MOBILE_FRA_PATHS) {
    const path = byId.get(id)
    assert.ok(path, id + ' is reachable from the mobile paths entrypoint')
    assert.ok(rawById.has(id), id + ' has a source descriptor')
    assert.equal(browserIds.has(id), false, id + ' must not be counted in BROWSER_PATHS')
    assert.equal(path.execution, 'manual acceptance; not executed by surface runner')
    assert.match(path.evidence, REQUIRED_EVIDENCE[id])
    assert.equal(path.status, 'NOT_RUN')
    assert.ok(path.prerequisites.some(value => /BLOCKED\/NOT_RUN/.test(value)))
    assert.ok(path.steps.length >= 3)
    for (const control of REQUIRED_CONTROLS[id]) {
      assert.ok(path.steps.some(step => (step.action + ' ' + step.expected).includes(control)),
        id + ' names source-backed control ' + control)
    }
    const descriptorText = [
      path.scope,
      ...path.prerequisites,
      ...path.steps.flatMap(step => [step.action, step.expected]),
    ].join(' ')
    assert.doesNotMatch(descriptorText, /person-operated|person-held credential|credential is entered only by the person/i)
    assert.doesNotMatch(descriptorText, /native account|native phone/i)
    assert.doesNotMatch(descriptorText, /data-account-/)
    for (const step of path.steps.filter(step => /Safari|hosted/i.test(step.action))) {
      assert.doesNotMatch(step.action + ' ' + step.expected, /data-connect-/,
        id + ' keeps desktop connect selectors out of hosted/Safari observations')
    }
    if (id.startsWith('phone-fra-')) {
      const closedBeforeSwitch = path.steps.filter(step =>
        /close and confirm/i.test(step.action) && /UI closed/i.test(step.expected))
      assert.ok(closedBeforeSwitch.length >= 2,
        id + ' requires close-confirm and a live endpoint before each surface switch')
    }
  }

  const automated = selected.filter(path => path.execution === 'automated browser action')
  assert.ok(automated.length > 0)
  assert.ok(automated.every(path => path.evidence === 'scripted browser/emulation observation'))
  assert.equal(automated.some(path => /FRA|authenticated|account login|sign out/i.test(path.title + ' ' + path.scope)), false)

  const text = pathsMarkdown(selected)
  assert.match(text, /Evidence: manual hosted\/mobile observation/)
  assert.match(text, /Evidence: manual physical-Safari observation/)
  assert.match(text, /Evidence: manual physical-Safari \+ desktop observation/)
  assert.match(text, /phone-fra-claim/)
  assert.match(text, /BLOCKED\/NOT_RUN/)
})

test('browser action proof cannot claim a false observation when its checker is non-throwing', async () => {
  const checks = []
  const page = {
    locator(selector) {
      if (selector === '.phone-ledger-row') return inertLocator({ count: 1 })
      return inertLocator()
    },
    getByRole() {
      return inertLocator()
    },
  }
  const actions = browserActions({
    page,
    mobile: true,
    origin: 'http://inert.invalid',
    settle: async () => {},
    press: async () => {},
    dismissGuide: async () => {},
    check: (ok, label) => checks.push({ ok, label }),
    pageErrors: [],
  })

  const falseProof = await actions['signed-out']()
  assert.equal(falseProof.verified, false)
  assert.equal(falseProof.observed, 'Signed-out gate exposes no private agent rows')
  assert.deepEqual(checks, [{ ok: false, label: 'Signed-out gate exposes no private agent rows' }])

  const descriptor = {
    id: 'false-browser-proof',
    title: 'False browser proof',
    steps: [{
      id: 'signed-out',
      action: 'Read the signed-out gate',
      expected: 'The gate is empty',
    }],
  }
  const record = pendingJourney(descriptor)
  await assert.rejects(
    runJourney(record, { 'signed-out': async () => falseProof }),
    /no explicit verified observation/,
  )
  assert.equal(record.status, 'FAIL')
  assert.equal(record.steps[0].status, 'FAIL')
})
