import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createFleetTreeStore } from '../../src/fleet-trees.js'

const require = createRequire(import.meta.url)
const { captureComposeBaseline, assertComposeUnchanged, ownedComposeRecord } = require('../lib/page2-native-compose-evidence.cjs')
const scenario = require('../lib/page2-native-scenarios.cjs').scenarios.find(row => row.id === 'compose-validation')

function fixture(t, { staged = true, onSet, onEscape } = {}) {
  const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-compose-proof-'))
  t.after(() => fs.rmSync(qaRoot, { recursive: true, force: true }))
  const userData = path.join(qaRoot, 'user-data')
  fs.mkdirSync(userData)
  const values = new Map(), localStorage = { get length() { return values.size }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null }
  let count = 0
  const store = createFleetTreeStore({ computerId: 'owned-computer',
    storage: { read: key => values.has(key) ? JSON.parse(values.get(key)) : null, write: (key, value) => { values.set(key, JSON.stringify(value)); return true } },
    makeId: kind => `${kind}-${++count}`, now: () => '2026-09-08T00:00:00.000Z' })
  let observer = null
  if (staged) {
    const made = store.addNode({ role: 'observer', message: 'Retain this staged Observer' })
    assert.equal(made.ok, true)
    observer = made.node
    assert.equal(observer.status, 'draft')
    assert.equal(observer.sessionId, null)
    assert.equal(store.setTreeProfile(observer.treeId, 'owned-profile').ok, true)
    fs.writeFileSync(path.join(userData, 'session-profiles.json'), JSON.stringify({ v: 1, profiles: [{ id: 'owned-profile', name: 'Owned folder', cwd: qaRoot }] }))
  }
  let open = false, refused = false
  const inputEvents = [], proofSteps = []
  const context = { paths: { qaRoot, userData },
    async step(id, action) { const result = await action(); proofSteps.push({ id, result }); return result },
    page: {
      evaluate: async action => structuredClone(vm.runInNewContext(`(${action.toString()})()`, { localStorage })),
      keyboard: { async press(key) { inputEvents.push(key); assert.equal(key, 'Escape'); open = false; await onEscape?.({ store, values, userData }) } },
      locator(selector) {
        if (selector === '.static-tree-node') return { async evaluateAll(action) {
          return action(store.snapshot().nodes.map(node => ({ dataset: { agentId: node.id, parentId: node.parentId || '' } })))
        } }
        if (selector === '.tree-chat-add') return { async click() { inputEvents.push('header-add') } }
        if (selector === '.tree-new-tree') return { async click() { assert.equal(inputEvents.at(-1), 'header-add'); inputEvents.push('open'); open = true } }
        if (selector === '[data-compose-action="set"]') return { async isEnabled() { return true }, async click() { inputEvents.push('set'); refused = true; await onSet?.({ store, values, userData }) } }
        if (selector === '[data-compose-field="message"]') return {
          async isVisible() { return open }, async inputValue() { return '' }, async getAttribute(name) { assert.equal(name, 'aria-invalid'); return String(refused) }, async count() { return Number(open) },
        }
        if (selector === '[data-compose-problem="message"]') return { async innerText() { return refused ? 'Say what you want done first.' : '' } }
        throw Error('Unexpected native control: ' + selector)
      },
    },
  }
  return { context, store, values, observer, inputEvents, proofSteps }
}

for (const staged of [false, true]) test(`actual compose-validation action preserves the ${staged ? 'real-store staged Observer and assigned profile' : 'empty initial store'}`, async t => {
  const f = fixture(t, { staged }), before = await captureComposeBaseline(f.context)
  await scenario.run(f.context)
  assertComposeUnchanged(before, await captureComposeBaseline(f.context))
  assert.deepEqual(f.inputEvents, ['header-add', 'open', 'set', 'Escape'])
  assert.deepEqual(f.proofSteps.map(row => row.id), ['compose-empty-refusal-retained-baseline', 'compose-escape-retained-baseline'])
  assert.equal(f.proofSteps[1].result.visible.length, Number(staged))
  if (staged) assert.equal(f.proofSteps[1].result.visible[0].id, f.observer.id)
})

for (const phase of ['onSet', 'onEscape']) for (const [name, mutate] of [
  ['an unintended new node', ({ store }) => assert.equal(store.addNode({ role: 'worker', message: 'unintended' }).ok, true)],
  ['an altered tree profile', ({ store }) => store.setTreeProfile(store.snapshot().trees[0].id, 'different-profile')],
  ['same-count node replacement', ({ values }) => { const [key, text] = [...values][0]; const record = JSON.parse(text); record.nodes[0].id = 'different-node'; values.set(key, JSON.stringify(record)) }],
  ['a changed parent identity', ({ values }) => { const [key, text] = [...values][0]; const record = JSON.parse(text); record.nodes[0].parentId = 'different-parent'; values.set(key, JSON.stringify(record)) }],
  ['a changed saved session', ({ values }) => { const [key, text] = [...values][0]; const record = JSON.parse(text); record.nodes[0].sessionId = 'unexpected-session'; values.set(key, JSON.stringify(record)) }],
  ['a changed named profile', ({ userData }) => fs.appendFileSync(path.join(userData, 'session-profiles.json'), '\n')],
  ['a new signed run-ledger record', ({ userData }) => fs.writeFileSync(path.join(userData, 'agent-spawn-records.jsonl'), JSON.stringify({ action: 'agent_session_start', sequence: 1, sessionId: 'unexpected-session' }) + '\n')],
]) test(`compose proof rejects ${name} during ${phase === 'onSet' ? 'empty submission' : 'Escape cancellation'}`, async t => {
  const f = fixture(t, { [phase]: mutate })
  await assert.rejects(scenario.run(f.context), /must retain/)
  assert.ok(f.proofSteps.length < 2)
})

test('an empty run-record file cannot be treated as untouched absence', async t => {
  const f = fixture(t), before = await captureComposeBaseline(f.context)
  fs.writeFileSync(path.join(f.context.paths.userData, 'agent-spawn-records.jsonl'), '')
  assert.throws(() => assertComposeUnchanged(before, { ...before, records: before.records.map(record => record.name.endsWith('.jsonl') ? ownedComposeRecord(f.context.paths, record.name) : record) }), /signed start-ledger bytes/)
})

test('compose record reads reject an unrelated root before any filesystem probe', () => {
  assert.throws(() => ownedComposeRecord({ qaRoot: '/unopened-qa-root', userData: '/outside-qa-root' }, 'session-profiles.json'), /only this owned QA/)
})

test('compose record reads reject links and hard-linked records', t => {
  const f = fixture(t), root = f.context.paths.userData, target = path.join(root, 'target')
  fs.writeFileSync(target, '{}')
  const file = path.join(root, 'agent-spawn-records.jsonl')
  fs.symlinkSync(target, file)
  assert.throws(() => ownedComposeRecord(f.context.paths, 'agent-spawn-records.jsonl'), /bounded regular/)
  fs.unlinkSync(file); fs.linkSync(target, file)
  assert.throws(() => ownedComposeRecord(f.context.paths, 'agent-spawn-records.jsonl'), /bounded regular/)
})
