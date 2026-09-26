import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { standaloneStartFrom, standaloneStartChoices } from '../../src/tree-standalone-agent.js'

// Exercise the production wrapper callback. Only its downstream session
// consumer is replaced to inspect the exact mount contract; this is not a
// start-order or backend authority proof.
const source = readFileSync(new URL('../../src/tree-standalone-agent.js', import.meta.url), 'utf8')
const declaration = parseAst(source).body.find(node => node.declaration?.id?.name === 'mountStandaloneAgent').declaration
const factory = new Function('document', 'mountAgentSessionSurface', 'standaloneStartFrom',
  'standaloneStartChoices', 'SOLO_TIERS', 'return (' + source.slice(declaration.start, declaration.end) + ')')

function fixture(t, options = {}) {
  const dom = installDomStandIn()
  const seat = { id: 'existing-seat' }
  const draft = { text: '  submitted words  ', attachments: [{ path: 'first-image' }, { path: 'second-image' }] }
  let mounted, current = true
  const ownerContext = { version: 1, ownerId: 'product-owner', currentEpoch: 'captured-epoch', kind: 'local' }
  const controller = {
    setTitle() {},
    snapshot: () => ({ sessionId: null, phase: 'draft' }),
    exportDraft: () => structuredClone(draft),
    beginPlacement: () => ({ ok: true }),
    cancelPlacement() {},
  }
  const mount = factory(dom.document, (_surface, value) => {
    mounted = value
    value.onController(controller)
    return () => value.onController(null)
  }, standaloneStartFrom, standaloneStartChoices, standaloneStartChoices().tiers)
  const host = dom.document.createElement('div')
  dom.document.body.appendChild(host)
  const adapter = mount(host, { id: seat.id, seat, computerId: 'declared-computer', live: true, ...options })
  t.after(() => { adapter.dispose(); dom.restore() })
  return {
    adapter, seat, draft, ownerContext,
    capture: () => mounted.getImageDraftRegistrationContext({ ownerContext, isCurrent: () => current }),
    invalidateOwner: () => { current = false },
    context: mounted.getImageDraftRegistrationContext,
  }
}

for (const computerId of ['declared-computer', 'this-computer', 'a-different-declared-id']) {
  test('registration preserves supplied computer identity exactly: ' + computerId, t => {
    const f = fixture(t, { computerId })
    const result = f.capture()
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'standalone')
    assert.equal(result.computerId, computerId)
    assert.equal(result.nodeId, f.seat.id)
    assert.equal(result.isCurrent(), true)
    assert.equal(Object.hasOwn(result, 'sessionId'), false, 'renderer cannot manufacture the host session grant')
    assert.deepEqual(f.adapter.exportDraft(), f.draft)
  })
}

for (const options of [{ computerId: null }, { computerId: '' }, { seat: null }, { seat: { id: 'other-seat' } }, { live: false }]) {
  test('unavailable registration identity refuses: ' + JSON.stringify(options), t => {
    const f = fixture(t, options)
    const result = f.capture()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'IMAGE_DRAFT_REGISTRATION_CONTEXT_UNAVAILABLE')
    assert.deepEqual(f.adapter.exportDraft(), f.draft)
  })
}

test('placement hold is named and cancelled placement cannot revive a prior capture', t => {
  const f = fixture(t)
  const before = f.capture()
  assert.equal(f.adapter.beginPlacement().ok, true)
  assert.deepEqual(f.capture(), { ok: false, code: 'AGENT_SESSION_NOT_READY', held: true })
  assert.equal(before.isCurrent(), false)
  f.adapter.cancelPlacement()
  assert.equal(before.isCurrent(), false, 'begin/cancel ABA must not restore a captured registration')
  assert.equal(f.capture().isCurrent(), true, 'new capture can proceed after the transient hold')
  assert.deepEqual(f.adapter.exportDraft(), f.draft)
})

test('acknowledged placement invalidates standalone provenance without clearing draft', t => {
  const f = fixture(t)
  const before = f.capture()
  f.adapter.beginPlacement()
  f.adapter.commitPlacement({ nodeId: 'real-adopted-node', getStartOptions() {}, onSessionChange() {} })
  assert.equal(before.isCurrent(), false)
  assert.equal(f.capture().code, 'IMAGE_DRAFT_CONTEXT_CHANGED')
  assert.deepEqual(f.adapter.exportDraft(), f.draft)
})

for (const [reason, change] of [
  ['owner invalidation', f => f.invalidateOwner()],
  ['owner mutation', f => { f.ownerContext.currentEpoch = 'new-epoch' }],
  ['seat mutation', f => { f.seat.id = 'replacement-seat' }],
  ['disposal', f => f.adapter.dispose()],
]) {
  test(reason + ' invalidates captured registration provenance', t => {
    const f = fixture(t)
    const before = f.capture()
    assert.equal(before.isCurrent(), true)
    change(f)
    assert.equal(before.isCurrent(), false)
    assert.deepEqual(f.adapter.exportDraft(), f.draft)
  })
}

test('missing or throwing owner predicate is a named refusal and retains the draft', t => {
  const f = fixture(t)
  assert.equal(f.context({ ownerContext: f.ownerContext }).code, 'IMAGE_OWNER_UNAVAILABLE')
  assert.equal(f.context({ ownerContext: f.ownerContext, isCurrent() { throw new Error('stale') } }).code, 'IMAGE_OWNER_CHANGED')
  assert.deepEqual(f.adapter.exportDraft(), f.draft)
})
