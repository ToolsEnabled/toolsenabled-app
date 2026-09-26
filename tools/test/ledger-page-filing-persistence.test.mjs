// The real owner filing chain in retained synthetic storage. Its store releases
// lock files normally; run only with the execution owner's approved fresh-path
// deletion scope. This suite never removes its fixture roots or stored records.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { mountLedgerFileBox } from '../../src/ledger-file-box.js'
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

function preloadBridge(surface, calls, principal = PERSON) {
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
          return await surface.run(channel.slice(3), structuredClone(payload), principal)
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


async function world(t, run) {
  assert.ok(process.env.MC_CANONICAL_ROOT, 'bind the current actual Engine store')
  const root = realpathSync(mkdtempSync(testScratchRoot('ledger-page-filing-')))
  const options = { rootPath: (...parts) => path.join(root, ...parts) }
  const host = createAgentHost({
    enginePath: path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js'),
    defaultCwd: root,
    rLedgerLoader: () => ({ fileRequest: input => rLedger.fileRequest(input, options) }),
  })
  const surface = commandSurface(host)
  const calls = []
  const bridge = preloadBridge(surface, calls)
  const doc = createDocument()
  const slot = doc.createElement('section')
  const ledger = path.join(root, 'reports/OWNER-REQUEST-LEDGER.json')
  const history = path.join(root, 'state/owner-request-record-events.jsonl')
  const record = id => JSON.parse(readFileSync(ledger, 'utf8')).requests.find(row => row.id === id)
  t.diagnostic('Retained filing fixture: ' + root)
  try { await run({ slot, host, surface, bridge, calls, options, record, ledger, history }) }
  finally { await host.closeAll() }
}
const event = { preventDefault() {} }
// This legacy-filing suite explicitly models a confirmed off-state read.
// Grading-on persistence requires the independently pinned task-policy engine.
const gradingOff = { read: async () => ({ ok: true, available: true, rows: [
  { id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: false },
] }) }

test('owner Ledger forms persist exact R and T records through the actual preload surface host and store', async t => {
  await world(t, async ({ slot, bridge, calls, record, options }) => {
    const accepted = []
    const hand = mountLedgerFileBox(slot, { bridge, settingsBridge: gradingOff, onFiled: change => accepted.push(change) })
    try {
      for (const [kind, words, canonical] of [
        ['r', '  Synthetic standing words\r\n<kept exactly>.  ', 'Synthetic standing words\n<kept exactly>.'],
        ['t', '  Synthetic one-shot task\r\n<kept exactly>.  ', 'Synthetic one-shot task\n<kept exactly>.'],
      ]) {
        hand.setKind(kind)
        if (kind === 't') await hand.refreshGrading()
        slot.querySelector('[data-file-words]').value = words
        await hand.submit(event)
        assert.equal(accepted.length, kind === 'r' ? 1 : 2)
        const saved = record(accepted.at(-1).id)
        assert.equal(saved.kind, kind.toUpperCase())
        assert.equal(calls.at(-1).payload.words, words, 'the owner UI payload stays exact')
        assert.equal(saved.verbatim, canonical, 'the existing store normalizes CRLF and outer whitespace')
        assert.equal(rLedger.readLedger('global', null, { ...options, kinds: [kind.toUpperCase()] }).entries.find(entry => entry.id === saved.id)?.words, canonical,
          'the supported readback returns the canonical stored words')
        assert.equal(saved.scope, 'global')
        assert.equal(slot.querySelector('[data-file-words]').value, '')
        assert.equal(slot.querySelector('[data-action-output]').dataset.state, 'confirmed')
      }
      assert.deepEqual(calls.map(call => call.channel), ['mc-agent:request', 'mc-agent:request'])
      assert.equal(calls[0].payload.kind, undefined)
      assert.equal(calls[1].payload.kind, 'T')
      assert.equal(store.verifyHistory(options).ok, true)
      // Re-open the canonical persisted bytes; the UI's callback is not proof.
      assert.notEqual(accepted[0].id, accepted[1].id)
      assert.equal(record(accepted[0].id).verbatim, 'Synthetic standing words\n<kept exactly>.')
      assert.equal(record(accepted[1].id).verbatim, 'Synthetic one-shot task\n<kept exactly>.')
    } finally { hand() }
  })
})

test('blank task and read-only owner bridge refuse without adding or changing retained records', async t => {
  await world(t, async ({ slot, bridge, surface, calls, ledger, history }) => {
    const first = await bridge.request({ scope: 'global', kind: 'T', words: 'Synthetic existing task.' })
    assert.match(first.id, /^T[1-9][0-9]*$/)
    const before = [readFileSync(ledger, 'utf8'), readFileSync(history, 'utf8')]
    const deniedCalls = []
    const denied = preloadBridge(surface, deniedCalls, { ...PERSON, mayWrite: false })
    const hand = mountLedgerFileBox(slot, { kind: 't', bridge: denied, settingsBridge: gradingOff })
    try {
      await hand.refreshGrading()
      slot.querySelector('[data-file-words]').value = ' \n '
      await hand.submit(event)
      assert.equal(deniedCalls.length, 0)
      slot.querySelector('[data-file-words]').value = 'Retain this denied task.'
      await hand.submit(event)
      assert.equal(deniedCalls.length, 1)
      assert.equal(deniedCalls[0].code, 'MC_AGENT_PRINCIPAL_READ_ONLY')
      assert.equal(slot.querySelector('[data-action-output]').dataset.state, 'refused')
      assert.equal(slot.querySelector('[data-file-words]').value, 'Retain this denied task.')
      assert.deepEqual([readFileSync(ledger, 'utf8'), readFileSync(history, 'utf8')], before)
      assert.equal(calls.length, 1)
    } finally { hand() }
  })
})
