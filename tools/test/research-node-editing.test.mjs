import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultNode, replaceNodeBundle } from '../../src/research-node-editing.mjs'
import { operationalCatalog, operationalStarter, operationalStrategy } from '../../src/benchmark/trading-catalog.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'

const clone = value => structuredClone(value)
const draftCompile = (spec, root) => compileTask(spec, { ...spec.tasks[0], root }, { requireReview: false, requireTaskReview: false, validateExpected: false })
const owned = value => {
  const seen = new Set(), pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (!next || typeof next !== 'object' || seen.has(next)) continue
    seen.add(next); pending.push(...Object.values(next))
  }
  return seen
}
function assertPrivate(result, ...inputs) {
  const originals = new Set(inputs.flatMap(value => [...owned(value)]))
  for (const object of owned(result)) assert.equal(originals.has(object), false)
}

test('real recursive operational operator edit preserves 17 occurrences and independent four-role values', async () => {
  const spec = await operationalStarter(), root = spec.tasks[0].root
  root.slots.child1.slots.buy_process.params = { quantity: 2 }
  root.slots.child2.slots.child1.slots.buy_process.params = { quantity: 3 }
  const before = clone(spec), edited = replaceNodeBundle(spec.catalog, root, 'op-sequence-2')
  const expected = { ...clone(root), use: 'op-sequence-2', params: {} }
  assert.deepEqual(edited, expected)
  const compiled = await draftCompile(spec, edited)
  assert.equal(compiled.compiled.composition.nodes.length, 17)
  assert.equal(compiled.compiled.composition.nodes.find(node => node.path === 'root/child1/buy_process').parameters.quantity, 2)
  assert.equal(compiled.compiled.composition.nodes.find(node => node.path === 'root/child2/child1/buy_process').parameters.quantity, 3)
  assert.equal(edited.slots.child2.use, 'op-sequence-2')
  assert.deepEqual(spec, before); assertPrivate(edited, spec)
})

test('adding a third child retains both branches and leaves the new branch explicitly unfilled until supplied', async () => {
  const spec = await operationalStarter(), root = spec.tasks[0].root
  const edited = replaceNodeBundle(spec.catalog, root, 'op-all-3')
  assert.deepEqual(edited.slots, { ...clone(root.slots), child3: { use: '' } })
  await assert.rejects(draftCompile(spec, edited), /unknown|missing|bundle|choose|reference/i)
  edited.slots.child3 = operationalStrategy()
  const compiled = await draftCompile(spec, edited)
  assert.equal(compiled.compiled.composition.nodes.length, 22)
  assert.deepEqual(compiled.compiled.composition.nodes[0].ports.map(port => port.name), ['child1', 'child2', 'child3'])
})

test('retained branches follow the selected bundle explicit child order without exchanging occurrence values', async () => {
  const spec = await operationalStarter(), source = spec.catalog.find(bundle => bundle.id === 'op-sequence-2')
  spec.catalog.push({ ...clone(source), id: 'reverse-sequence', slotOrder: ['child2', 'child1'] })
  const edited = replaceNodeBundle(spec.catalog, spec.tasks[0].root, 'reverse-sequence')
  assert.deepEqual(edited.slots, spec.tasks[0].root.slots)
  const compiled = await draftCompile(spec, edited)
  assert.deepEqual(compiled.compiled.composition.nodes[0].ports.map(port => port.name), ['child2', 'child1'])
  assert.equal(compiled.compiled.composition.nodes.length, 17)
})

test('dropping, retyping or replacing children with an atom refuses atomically', () => {
  const catalog = operationalCatalog(), root = { use: 'op-all-3', slots: { child1: operationalStrategy(), child2: operationalStrategy(), child3: { use: '' } } }
  const source = catalog.find(bundle => bundle.id === 'op-all-3')
  catalog.push({ ...clone(source), id: 'retyped', slots: { ...source.slots, child1: 'buy_reason' } }, { id: 'leaf', kind: 'atom', role: 'node', parameters: {} })
  for (const target of ['op-all-2', 'retyped', 'leaf']) {
    const before = canonical({ catalog, root })
    assert.throws(() => replaceNodeBundle(catalog, root, target), /remove or change the role/)
    assert.equal(canonical({ catalog, root }), before)
  }
})

test('explicit whole-branch replacement alone reproduces the former default 11-node operational tree', async () => {
  const spec = await operationalStarter(), root = spec.tasks[0].root
  root.slots.child1.slots.buy_process.params = { quantity: 2 }
  const edited = replaceNodeBundle(spec.catalog, root, 'op-sequence-2', { mode: 'replace' })
  assert.equal(edited.slots.child2.use, 'op-strategy')
  for (const child of Object.values(edited.slots)) {
    assert.deepEqual(Object.keys(child.slots).sort(), ['buy_process', 'buy_reason', 'sell_process', 'sell_reason'])
    assert.deepEqual(child.slots.buy_process, { use: 'op-shares', params: { quantity: 4, cashCapCents: 40000 } })
  }
  assert.equal((await draftCompile(spec, edited)).compiled.composition.nodes.length, 11)
  assertPrivate(edited, spec)
  const atomCatalog = [...spec.catalog, { id: 'leaf', kind: 'atom', role: 'node', parameters: { flag: false } }]
  assert.deepEqual(replaceNodeBundle(atomCatalog, root, 'leaf', { mode: 'replace' }), { use: 'leaf', params: { flag: false } })
  assert.equal(root.slots.child1.slots.buy_process.params.quantity, 2)
})

test('same-bundle preserve is an exact private no-op; changed-node defaults leave all descendant scalars exact', () => {
  const catalog = operationalCatalog(), shared = operationalStrategy()
  shared.params = { asset: 'SPY', zero: 0, flag: false, empty: '', numericText: '7' }
  const root = { use: 'op-all-2', params: { userOnly: 'retained on no-op' }, slots: { child1: shared, child2: shared }, note: { authorText: 'preserve selected-node metadata' } }
  const noOp = replaceNodeBundle(catalog, root, 'op-all-2')
  assert.deepEqual(noOp, root); assertPrivate(noOp, root, catalog)
  assert.notEqual(noOp.slots.child1, noOp.slots.child2)
  const edited = replaceNodeBundle(catalog, root, 'op-state-all-2')
  assert.deepEqual(edited.params, { gateAsset: 'SPY', threshold: 11000 })
  assert.deepEqual(edited.slots, root.slots); assert.deepEqual(edited.note, root.note)
  edited.slots.child1.params.flag = true
  assert.equal(edited.slots.child2.params.flag, false); assert.equal(shared.params.flag, false)
  assertPrivate(edited, root, catalog)
})

test('unknown source without children can be repaired, but unknown or undeclared source child roles cannot be inferred', () => {
  const catalog = operationalCatalog()
  assert.deepEqual(replaceNodeBundle(catalog, { use: 'missing' }, 'op-all-2'), { use: 'op-all-2', params: {}, slots: { child1: { use: '' }, child2: { use: '' } } })
  assert.throws(() => replaceNodeBundle(catalog, { use: 'missing', slots: { child1: operationalStrategy() } }, 'op-all-2'), /current bundle is unknown/)
  assert.throws(() => replaceNodeBundle(catalog, { use: 'op-all-2', slots: { surprise: operationalStrategy() } }, 'op-all-3'), /no declared source role/)
  assert.throws(() => replaceNodeBundle(catalog, { use: 'op-all-2', slots: { surprise: operationalStrategy() } }, 'op-all-2'), /no declared source role/)
})

test('malformed retained shapes and nonfinite values refuse without mutation while explicit empty choices stay editable', () => {
  const catalog = operationalCatalog()
  const cases = [null, [], { use: 'op-all-2', slots: [] }, { use: 'op-all-2', slots: { child1: null } },
    { use: 'op-all-2', slots: { child1: { params: {} } } }, { use: 'op-all-2', slots: { child1: { use: 'op-strategy', params: [] } } },
    { use: 'op-all-2', slots: { child1: { use: 'op-strategy', params: { invalid: Infinity } } } }]
  for (const node of cases) {
    const before = clone(node)
    assert.throws(() => replaceNodeBundle(catalog, node, 'op-all-3'))
    assert.deepEqual(node, before)
  }
  const node = { use: 'op-all-2', slots: { child1: { use: '' } } }
  assert.deepEqual(replaceNodeBundle(catalog, node, 'op-all-3').slots, { child1: { use: '' }, child2: { use: '' }, child3: { use: '' } })
})

test('target identity, declared roles and options fail closed in both modes; wildcard incoming role remains supported', () => {
  const catalog = operationalCatalog(), node = { use: 'op-above', params: { threshold: 0 } }
  for (const mode of ['preserve', 'replace']) {
    assert.throws(() => replaceNodeBundle(catalog, node, 'op-below', { mode }), /incompatible/)
    assert.throws(() => replaceNodeBundle(catalog, node, 'absent', { mode }), /existing replacement/)
    assert.throws(() => replaceNodeBundle(catalog, node, '', { mode }), /existing replacement/)
    assert.throws(() => replaceNodeBundle([...catalog, { id: 'invalid id', kind: 'atom', role: 'node' }], node, 'invalid id', { mode }), /valid identifier/)
    assert.throws(() => replaceNodeBundle(catalog, node, 'op-below', { mode, role: 0 }), /valid incoming/)
    assert.throws(() => replaceNodeBundle(catalog, node, 'op-below', { mode, role: '' }), /valid incoming/)
    assert.throws(() => replaceNodeBundle([...catalog, clone(catalog.find(bundle => bundle.id === 'op-below'))], node, 'op-below', { mode, role: 'buy_reason' }), /unique identifier/)
    for (const invalidRole of [0, '', null, []]) assert.throws(() => replaceNodeBundle([...catalog, { id: 'malformed', kind: 'atom', role: invalidRole }], node, 'malformed', { mode, role: '*' }), /incompatible/)
  }
  for (const options of [null, [], { mode: 'discard' }, { approve: true }]) assert.throws(() => replaceNodeBundle(catalog, node, 'op-below', options))
  assert.deepEqual(replaceNodeBundle(catalog, node, 'op-below', { role: 'buy_reason' }), { use: 'op-below', params: { threshold: 11000 } })
  assert.deepEqual(replaceNodeBundle(catalog, node, 'op-below', { role: '*' }), { use: 'op-below', params: { threshold: 11000 } })
})

test('default construction preserves atom-first catalog selection and stops unknown or recursive unresolved choices', () => {
  const catalog = operationalCatalog()
  assert.deepEqual(createDefaultNode(catalog, 'absent'), { use: '' })
  const firstAtom = { id: 'first-node', kind: 'atom', role: 'node', parameters: { zero: 0, flag: false, text: '' } }
  const selected = createDefaultNode([firstAtom, ...catalog], 'op-all-2')
  assert.deepEqual(selected.slots, { child1: { use: 'first-node', params: firstAtom.parameters }, child2: { use: 'first-node', params: firstAtom.parameters } })
  assertPrivate(selected, catalog, firstAtom)
  assert.notEqual(selected.slots.child1.params, selected.slots.child2.params)
  const strategy = clone(catalog.find(bundle => bundle.id === 'op-strategy'))
  strategy.slots.again = 'node'
  const cyclicCatalog = [strategy], unresolved = createDefaultNode(cyclicCatalog, 'op-strategy')
  assert.deepEqual(unresolved.slots, { buy_reason: { use: '' }, buy_process: { use: '' }, sell_reason: { use: '' }, sell_process: { use: '' }, again: { use: '' } })
  assert.deepEqual(createDefaultNode(catalog, 'op-shares'), { use: 'op-shares', params: { quantity: 4, cashCapCents: 40000 } })
})
