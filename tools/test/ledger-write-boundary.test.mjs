/* Compose the Ledger row handler, shipped preload, main's actual payload
 * parsers, shared command surface, real host, and disk-backed store. The DOM
 * and Electron transport are stand-ins; no window, agent, or provider starts.
 * MC_CANONICAL_ROOT selects an explicitly supplied engine for pair testing;
 * otherwise use the repository's confined store fixture. Every store call
 * carries this test's own rootPath, including reads and integrity checks. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { mountLedgerRowActions } from '../../src/ledger-row-actions.js'
import { createDocument } from './lib/dom-stand-in.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const ENGINE = process.env.MC_CANONICAL_ROOT || path.join(ROOT, 'tools/test/fixtures/confined-engine')
const store = require(path.join(ENGINE, 'src/lib/owner-request-store.js'))
const rLedger = require(path.join(ENGINE, 'src/lib/r-ledger.js'))
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const PERSON = Object.freeze({ kind: 'window', owner: {}, mayWrite: true, label: 'Ledger test window' })
const SCOPES = [{ scope: 'tree', key: 'qa-node-one' }, { scope: 'tree', key: 'qa-node-two' }]
const mainSource = readFileSync(path.join(ROOT, 'shell/main.cjs'), 'utf8')
const parserNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'rendererSafeAgentError']
const declarations = parseAst(mainSource).body.filter(node => node.type === 'FunctionDeclaration' && parserNames.includes(node.id.name))
assert.equal(declarations.length, parserNames.length, 'main must declare every actual parser this boundary uses')
const parsers = vm.runInNewContext(`${declarations.map(node => mainSource.slice(node.start, node.end)).join('\n')}\n({${parserNames.join(',')}})`)

function commandSurface(host) {
  const unexpected = () => assert.fail('Ledger writes reached an unrelated session or provider dependency')
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([name, type]) => [name,
    type === 'function' ? unexpected : type === 'number' ? 128 : type === 'string' ? ROOT : {},
  ]))
  Object.assign(deps, parsers, {
    agentSessions: new Map(), AGENT_EFFORT_VALUES: [], dialog: { showOpenDialog: unexpected },
    getAgentHost: async () => host, currentAgentHost: () => host,
  })
  return createAgentCommandSurface(deps)
}

function preloadBridge(surface, calls) {
  const exposed = new Map()
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
    ipcRenderer: {
      sendSync: () => ({ ok: false }), on() {}, removeListener() {}, send() {},
      async invoke(channel, payload) {
        assert.match(channel, /^mc-agent:/)
        const entry = { channel, payload: structuredClone(payload) }
        calls.push(entry)
        try {
          return await surface.run(channel.slice(3), structuredClone(payload), PERSON)
        } catch (error) {
          entry.code = error.code
          throw error
        }
      },
    },
  }
  vm.runInNewContext(readFileSync(path.join(ROOT, 'shell/fleet-profile-preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return electron },
    process: { platform: process.platform }, window: { addEventListener() {} },
  }, { filename: 'fleet-profile-preload.cjs' })
  assert.ok(exposed.get('mcAgent'), 'the shipped preload must expose the Ledger bridge')
  return exposed.get('mcAgent')
}

async function inWorld(t, run) {
  const root = realpathSync(mkdtempSync(testScratchRoot('ledger-write-boundary-')))
  const options = { rootPath: (...parts) => path.join(root, ...parts) }
  const bind = (module, names) => Object.fromEntries(names.map(name => [name, (...args) => module[name](...args, options)]))
  const host = createAgentHost({
    enginePath: path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js'),
    defaultCwd: root,
    ownerRequestStoreLoader: () => ({
      ...bind(store, ['completeTask', 'removeTask', 'answerAsk', 'declineAsk', 'removeAsk']),
      RESOLUTION_STATUSES: store.RESOLUTION_STATUSES,
    }),
    rLedgerLoader: () => ({
      ...bind(rLedger, ['fileRequest', 'findEntry', 'editRequest', 'removeRequest', 'decide', 'resolve']),
      RESOLUTION_STATUSES: rLedger.RESOLUTION_STATUSES,
    }),
  })
  const surface = commandSurface(host)
  const calls = []
  const bridge = preloadBridge(surface, calls)
  const ledgerFile = path.join(root, 'reports/OWNER-REQUEST-LEDGER.json')
  const historyFile = path.join(root, 'state/owner-request-record-events.jsonl')
  const read = () => JSON.parse(readFileSync(ledgerFile, 'utf8')).requests
  const record = id => read().find(row => row.id === id)
  const bytes = () => [readFileSync(ledgerFile, 'utf8'), readFileSync(historyFile, 'utf8')]
  const file = async (kind, scope = SCOPES[0]) => {
    const result = await bridge.request({ ...scope, words: `Owned contract fixture ${kind} ${scope.key || 'global'}.`, ...(kind === 'R' ? {} : { kind }) })
    assert.equal(result.ok, true)
    assert.match(result.id, new RegExp(`^${kind}\\d+$`))
    return result.id
  }
  let passed = false
  try {
    await run({ root, options, host, surface, bridge, calls, read, record, bytes, file })
    assert.equal(store.verifyHistory(options).ok, true, 'every accepted write must retain a valid history chain')
    passed = true
  } finally {
    await host.closeAll()
    if (passed) {
      assert.equal(realpathSync(root), root, 'cleanup target must still be the test-owned allocation')
      rmSync(root, { recursive: true, force: true })
    } else {
      t.diagnostic(`Failed fixture retained at ${root}`)
      t.diagnostic(JSON.stringify({ calls }))
    }
  }
}

function rowHand(world, id) {
  const document = createDocument()
  const register = document.createElement('div')
  const row = document.createElement('section')
  row.className = 'ledger-record'
  row.innerHTML = '<div data-row-hint hidden></div><div data-row-editor hidden></div>'
  register.appendChild(row)
  const changed = []
  const api = mountLedgerRowActions(register, {
    bridge: world.bridge, rowOf: chosen => ({ ...world.record(chosen), words: world.record(chosen).verbatim }),
    onChanged: change => changed.push(change),
  })
  const buttons = new Map()
  const press = async action => {
    let button = row.querySelector(`[data-row-action="${action}"]`) || buttons.get(action)
    if (!button) {
      button = document.createElement('button')
      button.dataset.rowAction = action
      button.dataset.id = id
      const key = world.record(id).scopeKey
      if (key) button.dataset.key = key
      row.appendChild(button)
      buttons.set(action, button)
    }
    await api.press({ target: button })
  }
  return { row, changed, press, close: () => api.destroy() }
}

const actions = [
  { name: 'Task Complete', kind: 'T', method: 'completeTask', action: 'complete', status: 'done', event: 'complete' },
  { name: 'Task Delete', kind: 'T', method: 'removeTask', action: 'delete', status: 'removed', event: 'remove' },
  { name: 'Ask Answer', kind: 'A', method: 'answerAsk', action: 'answer', status: 'answered', event: 'answer' },
  { name: 'Ask Decline with reason', kind: 'A', method: 'declineAsk', action: 'decline', status: 'declined', event: 'decline' },
  { name: 'Ask Delete', kind: 'A', method: 'removeAsk', action: 'delete', status: 'removed', event: 'remove' },
]

for (const spec of actions) {
  test(`${spec.name}: actual row payload crosses the strict boundary for two tree scopes, preserving the peer`, async t => {
    await inWorld(t, async world => {
      const ids = []
      for (const scope of SCOPES) ids.push(await world.file(spec.kind, scope))
      assert.equal(new Set(ids).size, ids.length, 'IDs must be unique across scope keys')
      for (const id of ids) {
        const peer = ids.find(value => value !== id)
        const beforePeer = world.record(peer)
        const before = world.record(id)
        const hand = rowHand(world, id)
        const initialCalls = world.calls.length
        try {
          await hand.press(spec.action)
          if (spec.action === 'answer') {
            assert.equal(world.calls.length, initialCalls, 'opening an editor must not write')
            hand.row.querySelector('[data-row-editor-words]').value = 'Use the owned QA fixture.\nKeep this answer.'
            await hand.press('save')
          } else if (spec.action === 'delete' || spec.action === 'decline') {
            assert.equal(world.calls.length, initialCalls, 'the first destructive press must only arm')
            if (spec.action === 'decline') hand.row.querySelector('[data-row-reason]').value = '  QA decision: defer this ask.  '
            await hand.press(spec.action)
          }
          assert.equal(world.calls.length, initialCalls + 1, 'one accepted action must issue exactly one write')
          const last = world.calls.at(-1)
          assert.equal(last.code, undefined, `strict boundary refused ${JSON.stringify(last)}; row says ${hand.row.querySelector('[data-row-hint]').textContent}`)
          assert.equal(hand.changed.length, 1, 'accepted write must request a reload')
          const after = world.record(id)
          assert.equal(after.status, spec.status)
          assert.equal(after.scope, before.scope)
          assert.equal(after.scopeKey, before.scopeKey)
          assert.equal(after.history.at(-1).kind, spec.event)
          assert.equal(after.history.at(-1).actor, 'owner')
          if (spec.action === 'answer') assert.equal(after.answer.words, 'Use the owned QA fixture.\nKeep this answer.')
          if (spec.action === 'decline') assert.equal(after.decisions.at(-1).reason, 'QA decision: defer this ask.')
          assert.deepEqual(world.record(peer), beforePeer, 'a write must leave the other scope record byte-for-byte equivalent')
        } finally { hand.close() }
      }
    })
  })
}

test('R edit/remove retain scoped payload compatibility; decide/resolve preserve exact status and reason', async t => {
  await inWorld(t, async world => {
    const first = await world.file('R', SCOPES[0])
    const peer = await world.file('R', SCOPES[1])
    const beforePeer = world.record(peer)
    const hand = rowHand(world, first)
    try {
      await hand.press('edit')
      hand.row.querySelector('[data-row-editor-words]').value = 'Owned R edit.'
      await hand.press('save')
      assert.equal(world.record(first).verbatim, 'Owned R edit.')
      assert.deepEqual(world.calls.at(-1).payload, { id: first, key: SCOPES[0].key, words: 'Owned R edit.' })
      await world.bridge.resolveStandingRequest({ id: first, status: 'blocked-external', reason: 'Owned R wait.' })
      assert.equal(world.record(first).status, 'blocked-external')
      await hand.press('delete')
      await hand.press('delete')
      assert.deepEqual(world.calls.at(-1).payload, { id: first, key: SCOPES[0].key })
      assert.equal(world.record(first).status, 'removed')
      assert.deepEqual(world.record(peer), beforePeer)
      await world.bridge.requestDecide({ id: peer, decision: 'decline', reason: 'Owned R decision.' })
      assert.equal(world.record(peer).decisions.at(-1).reason, 'Owned R decision.')
    } finally { hand.close() }
  })
})

for (const spec of actions) {
  test(`${spec.name}: wrong kind, unknown, terminal, malformed and unauthorized calls never change either scope`, async t => {
    await inWorld(t, async world => {
      const id = await world.file(spec.kind)
      await world.file(spec.kind, SCOPES[1])
      const otherKind = await world.file(spec.kind === 'T' ? 'A' : 'T', SCOPES[1])
      const command = { completeTask: 'task-complete', removeTask: 'task-remove', answerAsk: 'ask-answer', declineAsk: 'ask-decline', removeAsk: 'ask-remove' }[spec.method]
      const payload = { id, ...(spec.method === 'answerAsk' ? { words: 'Owned answer.' } : {}) }
      const unchangedRefusal = async (value, code, principal = PERSON) => {
        const before = world.bytes()
        await assert.rejects(world.surface.run(`agent:${command}`, value, principal), error =>
          error.code === code && (code === 'MC_AGENT_PRINCIPAL_READ_ONLY' || error.message === code))
        assert.deepEqual(world.bytes(), before, 'a refusal must leave both ledger and history bytes unchanged')
      }
      await unchangedRefusal({ ...payload, id: otherKind }, 'AGENT_LEDGER_ID_KIND_MISMATCH')
      await unchangedRefusal({ ...payload, id: `${spec.kind}999999` }, 'R_LEDGER_ENTRY_UNKNOWN')
      for (const extra of [{ actor: 'owner' }, { key: SCOPES[1].key }, { scope: 'global' }]) {
        await unchangedRefusal({ ...payload, ...extra }, 'MC_AGENT_INVALID_PAYLOAD')
      }
      await unchangedRefusal({}, 'MC_AGENT_INVALID_PAYLOAD')
      for (const kind of ['window', 'relay']) {
        await unchangedRefusal(undefined, 'MC_AGENT_PRINCIPAL_READ_ONLY', { ...PERSON, kind, mayWrite: false })
      }
      await unchangedRefusal(undefined, 'MC_AGENT_PRINCIPAL_INVALID', { ...PERSON, kind: 'agent' })
      if (spec.method === 'completeTask') store.completeTask({ id, actor: 'owner' }, world.options)
      else if (spec.method === 'answerAsk') store.declineAsk({ id, actor: 'owner' }, world.options)
      else if (spec.method === 'declineAsk') store.answerAsk({ id, answer: 'Already answered.', actor: 'owner' }, world.options)
      else store[spec.method]({ id, actor: 'owner' }, world.options)
      await unchangedRefusal(payload, spec.action === 'delete' ? 'R_LEDGER_ENTRY_UNKNOWN' : 'R_LEDGER_STATUS_INVALID')
    })
  })
}

test('Ask decline accepts an absent or bounded reason, persists it, and refuses invalid text without a write', async t => {
  await inWorld(t, async world => {
    for (const reason of [undefined, null, '', '  QA preserved reason.\r\nSecond line.  ', 'r'.repeat(2048)]) {
      const id = await world.file('A', { scope: 'global' })
      const result = await world.bridge.declineAsk({ id, ...(reason === undefined ? {} : { reason }) })
      assert.equal(result.status, 'declined')
      assert.equal(world.record(id).decisions.at(-1).reason, typeof reason === 'string' ? reason.replace(/\r\n/g, '\n').trim() || null : null)
    }
    const id = await world.file('A')
    await world.file('A', SCOPES[1])
    for (const reason of ['r'.repeat(2049), 'bad\0reason', false, 0, {}, []]) {
      const before = world.bytes()
      await assert.rejects(world.bridge.declineAsk({ id, reason }), error => error.code === 'MC_AGENT_INVALID_PAYLOAD')
      assert.deepEqual(world.bytes(), before)
    }
    const before = world.bytes()
    await assert.rejects(world.bridge.declineAsk({ id, reason: 'é'.repeat(1025) }), error => error.code === 'R_LEDGER_REASON_INVALID')
    assert.deepEqual(world.bytes(), before, 'the store UTF-8 byte cap must still refuse text below the IPC character cap')
  })
})
