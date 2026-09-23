import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { createEditorSessionSources } = require('../../shell/editor-session-source.cjs')

const sessionId = '11111111-2222-3333-4444-555555555555'
function fixture(run, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-source-'))
  const cwd = path.join(home, 'work'), root = path.join(home, '.codex', 'sessions')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, `rollout-2026-09-08-${sessionId}.jsonl`)
  const observation = { sourceRef: 'opaque-observation', provider: 'codex', sessionId,
    kind: 'interactive', model: 'gpt-5.6-sol', effort: 'max' }
  const lines = [
    { type: 'session_meta', payload: { id: sessionId, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<script>user text</script>' }] } },
    { type: 'response_item', payload: { type: 'function_call', arguments: 'tool arguments stay out' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A real saved fixture reply.' }] } },
  ]
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  const api = createEditorSessionSources({ home, isIncluded: () => true, ...options })
  const owner = { window: 1 }, other = { window: 2 }
  api.capture(file, observation)
  const receipt = api.issue(observation, owner)
  try { return run({ api, home, cwd, root, file, observation, owner, other, receipt, lines }) }
  finally { fs.rmSync(home, { recursive: true, force: true }) }
}

test('watch reads bounded user and assistant messages and never grants live control', () => fixture(({ api, receipt, owner, home }) => {
  const read = api.preview(receipt, owner)
  assert.equal(read.ok, true)
  assert.equal(read.liveControl, false)
  assert.equal(read.partial, false)
  assert.deepEqual(read.messages.map(row => row.role), ['user', 'assistant'])
  assert.match(read.messages[0].text, /<script>/)
  assert.doesNotMatch(JSON.stringify(read), /tool arguments stay out/)
  assert.equal(JSON.stringify(read).includes(home), false)
}))

test('a receipt is bound to its owning window and expires', () => {
  let now = 100
  fixture(({ api, receipt, owner, other }) => {
    assert.throws(() => api.preview(receipt, other), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
    assert.throws(() => api.preview('../forged/path', owner), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
    now = 200
    assert.throws(() => api.preview(receipt, owner), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
  }, { now: () => now, receiptLifetimeMs: 50 })
})

test('removing editor consent revokes old watch and fork receipts', () => {
  let included = true
  fixture(({ api, receipt, owner, cwd }) => {
    const fork = api.prepareFork(receipt, owner)
    included = false
    assert.throws(() => api.preview(receipt, owner), { code: 'EDITOR_IMPORT_REMOVED' })
    assert.throws(() => api.redeemFork(fork.forkReceipt, owner, cwd), { code: 'EDITOR_IMPORT_REMOVED' })
  }, { isIncluded: () => included })
})

test('fork takes the source identity once and requires the original working folder', () => fixture(({ api, receipt, owner, cwd, home, file }) => {
  const fork = api.prepareFork(receipt, owner)
  assert.equal(fork.effort, 'max')
  assert.equal(JSON.stringify(fork).includes(home), false)
  assert.throws(() => api.redeemFork(fork.forkReceipt, owner, home), { code: 'EDITOR_FORK_WORKSPACE_MISMATCH' })
  const launch = api.redeemFork(fork.forkReceipt, owner, cwd)
  assert.equal(launch.threadId, sessionId)
  assert.equal(launch.sourcePath, file)
  assert.equal(launch.cwd, cwd)
  assert.doesNotThrow(() => launch.assertCurrent())
  assert.throws(() => api.redeemFork(fork.forkReceipt, owner, cwd), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
}))

test('a replaced record cannot reuse an issued receipt', () => fixture(({ api, receipt, owner, file }) => {
  fs.renameSync(file, `${file}.old`)
  fs.writeFileSync(file, '{}\n')
  assert.throws(() => api.preview(receipt, owner), { code: 'EDITOR_SOURCE_CHANGED' })
}))

test('a working-folder change after redemption refuses the eventual provider start', () => fixture(({ api, receipt, owner, file, cwd, home }) => {
  const fork = api.prepareFork(receipt, owner)
  const launch = api.redeemFork(fork.forkReceipt, owner, cwd)
  fs.appendFileSync(file, JSON.stringify({ type: 'turn_context', payload: { cwd: home } }) + '\n')
  assert.throws(() => launch.assertCurrent(), { code: 'EDITOR_FORK_WORKSPACE_MISMATCH' })
}))

test('linked and outside-provider files never receive a usable source receipt', () => fixture(({ api, owner, file, home, root, observation }) => {
  const linked = path.join(root, 'linked.jsonl')
  fs.linkSync(file, linked)
  const linkObservation = { ...observation, sourceRef: 'link' }
  api.capture(linked, linkObservation)
  assert.equal(api.issue(linkObservation, owner), null)
  fs.unlinkSync(linked)
  const outside = path.join(home, 'other.jsonl')
  fs.writeFileSync(outside, fs.readFileSync(file))
  const outsideObservation = { ...observation, sourceRef: 'outside' }
  api.capture(outside, outsideObservation)
  assert.equal(api.issue(outsideObservation, owner), null)
}))

test('large histories report partial coverage and bound returned text', () => fixture(({ api, receipt, owner, file, lines }) => {
  const middle = Array.from({ length: 1500 }, () => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', ignored: 'x'.repeat(600) } }))
  const last = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(30000) }] } }
  fs.writeFileSync(file, [...lines.map(row => JSON.stringify(row)), ...middle, JSON.stringify(last)].join('\n') + '\n')
  const read = api.preview(receipt, owner)
  assert.equal(read.partial, true)
  assert.ok(read.messages.every(row => row.text.length <= 16000))
  assert.ok(read.messages.reduce((sum, row) => sum + row.text.length, 0) <= 128000)
}))

test('takeover always requires actual editor handoff; it never silently resumes', () => fixture(({ api }) => {
  const result = api.adopt()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EDITOR_HANDOFF_UNAVAILABLE')
  assert.match(result.reason, /exclusive control/)
}))

function claudeFixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-claude-copy-'))
  const cwd = path.join(home, 'work'), providerHome = path.join(home, 'registered-claude')
  const root = path.join(providerHome, 'projects'), directory = path.join(root, 'work-slug')
  const targetHome = path.join(home, 'generated-confined-home')
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(targetHome)
  const file = path.join(directory, `${sessionId}.jsonl`)
  const bytes = JSON.stringify({ type: 'assistant', sessionId, cwd, message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'own fixture' }] } }) + '\n'
  fs.writeFileSync(file, bytes)
  fs.writeFileSync(path.join(providerHome, '.credentials.json'), 'DO NOT IMPORT CREDENTIALS')
  const observation = { sourceRef: 'registered-source', provider: 'claude', sessionId, kind: 'interactive' }
  const owner = {}
  const api = createEditorSessionSources({ home, isIncluded: () => true, accountForSource(provider, sourceHome) {
    assert.equal(provider, 'claude'); assert.equal(sourceHome, providerHome); return 'registered-account'
  } })
  api.capture(file, observation, providerHome)
  const receipt = api.issue(observation, owner)
  const fork = api.prepareFork(receipt, owner), launch = api.redeemFork(fork.forkReceipt, owner, cwd)
  try { return run({ api, receipt, owner, launch, home, cwd, providerHome, file, bytes, targetHome }) }
  finally { fs.rmSync(home, { recursive: true, force: true }) }
}

test('Claude copies only the selected source into a separate generated home and cleans its import', () => claudeFixture(({ launch, file, bytes, targetHome }) => {
  launch.assertCurrent()
  assert.equal(launch.account, 'registered-account')
  const cleanup = launch.stageSource(targetHome)
  const target = path.join(targetHome, 'projects', 'work-slug', `${sessionId}.jsonl`)
  assert.equal(fs.readFileSync(target, 'utf8'), bytes)
  assert.equal(fs.existsSync(path.join(targetHome, '.credentials.json')), false)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
  cleanup(); assert.equal(fs.existsSync(target), false)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
}))

test('Claude source import refuses partial writes, oversized records and existing target files', () => {
  claudeFixture(({ launch, file, bytes, targetHome }) => {
    fs.writeFileSync(file, bytes.trimEnd())
    assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_SOURCE_BUSY' })
  })
  claudeFixture(({ launch, file, targetHome }) => {
    fs.truncateSync(file, 32 * 1024 * 1024 + 1)
    assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_FORK_TOO_LARGE' })
  })
  claudeFixture(({ launch, targetHome }) => {
    const dir = path.join(targetHome, 'projects', 'work-slug'); fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `${sessionId}.jsonl`); fs.writeFileSync(target, 'existing unrelated bytes')
    assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_FORK_IMPORT_REFUSED' })
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing unrelated bytes')
  })
})

test('Claude source import never writes into its source provider home', () => claudeFixture(({ launch, providerHome, bytes, file }) => {
  assert.throws(() => launch.stageSource(providerHome), { code: 'EDITOR_FORK_IMPORT_REFUSED' })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
}))

test('Codex imports only its selected rollout into a separate home with a native lookup path', () => fixture(({ api, receipt, owner, cwd, home, file }) => {
  const providerHome = path.dirname(path.dirname(file))
  fs.writeFileSync(path.join(providerHome, 'auth.json'), 'DO NOT IMPORT SIGNER')
  const original = fs.readFileSync(file)
  const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
  const launch = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd)
  const cleanup = launch.stageSource(targetHome)
  assert.match(path.relative(targetHome, cleanup.sourcePath).split(path.sep).join('/'),
    /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-11111111-2222-3333-4444-555555555555\.jsonl$/)
  assert.deepEqual(fs.readFileSync(cleanup.sourcePath), original)
  assert.equal(fs.existsSync(path.join(targetHome, 'auth.json')), false)
  assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_RECEIPT_UNAVAILABLE' })
  cleanup(); assert.equal(fs.existsSync(cleanup.sourcePath), false)
  assert.deepEqual(fs.readFileSync(file), original)
}))

test('Codex source imports refuse incomplete, oversized, mixed-identity and overlapping sources', () => {
  for (const scenario of ['partial', 'oversized', 'identity', 'overlap']) fixture(({ api, receipt, owner, cwd, home, file }) => {
    const launch = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd)
    const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
    if (scenario === 'partial') fs.appendFileSync(file, '{"unfinished":')
    if (scenario === 'oversized') fs.truncateSync(file, 32 * 1024 * 1024 + 1)
    if (scenario === 'identity') fs.appendFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd } }) + '\n')
    assert.throws(() => launch.stageSource(scenario === 'overlap' ? path.dirname(path.dirname(file)) : targetHome),
      { code: { partial: 'EDITOR_SOURCE_BUSY', oversized: 'EDITOR_FORK_TOO_LARGE', identity: 'EDITOR_SOURCE_CHANGED', overlap: 'EDITOR_FORK_IMPORT_REFUSED' }[scenario] })
    assert.deepEqual(fs.readdirSync(targetHome), [])
  })
})

test('Codex source cleanup cannot remove a subsequently replaced import', () => fixture(({ api, receipt, owner, cwd, home }) => {
  const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
  const launch = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd)
  const cleanup = launch.stageSource(targetHome)
  fs.renameSync(cleanup.sourcePath, `${cleanup.sourcePath}.old`)
  fs.writeFileSync(cleanup.sourcePath, 'later unrelated record')
  cleanup()
  assert.equal(fs.readFileSync(cleanup.sourcePath, 'utf8'), 'later unrelated record')
}))

test('Codex copies native current context after compaction without copying paginated database lineage', () => fixture(({ api, receipt, owner, cwd, home, file, lines }) => {
  const meta = { ...lines[0], payload: { ...lines[0].payload, history_mode: 'paginated' } }
  const context = { type: 'turn_context', payload: { cwd, model: 'gpt-6-astra' } }
  const compacted = { type: 'compacted', payload: {
    replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Complete current-context canary.' }] }],
    guardian_history: [{ type: 'message', role: 'user', content: [] }],
    retained_context: { user_messages: ['Retained native context.'] },
  } }
  fs.writeFileSync(file, [meta, lines[1], context, compacted, lines[3]].map(JSON.stringify).join('\n') + '\n')
  const original = fs.readFileSync(file)
  const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
  const prepared = api.prepareFork(receipt, owner)
  assert.equal(prepared.sourceSessionId, sessionId)
  assert.equal(prepared.historyScope, 'current-model-context')
  const cleanup = api.redeemFork(prepared.forkReceipt, owner, cwd).stageSource(targetHome)
  const copied = fs.readFileSync(cleanup.sourcePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(copied, [{ ...meta, payload: { ...meta.payload, history_mode: 'legacy' } }, context, compacted, lines[3]])
  assert.equal(cleanup.historyScope, 'current-model-context')
  assert.deepEqual(fs.readFileSync(file), original)
  assert.deepEqual(fs.readdirSync(targetHome), ['sessions'])
  cleanup()
}))

test('a large Codex source retains all records after native compaction under the same copy limit', () => fixture(({ api, receipt, owner, cwd, home, file, lines }) => {
  const meta = { ...lines[0], payload: { ...lines[0].payload, history_mode: 'paginated' } }
  fs.writeFileSync(file, JSON.stringify(meta) + '\n')
  const verbose = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) } }) + '\n'
  for (let i = 0; i < 33; i++) fs.appendFileSync(file, verbose)
  const compacted = { type: 'compacted', payload: { replacement_history: [lines[1].payload], retained_context: { incomplete: false } } }
  fs.appendFileSync(file, [compacted, lines[3]].map(JSON.stringify).join('\n') + '\n')
  const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
  const cleanup = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd).stageSource(targetHome)
  const copied = fs.readFileSync(cleanup.sourcePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(copied.length, 3)
  assert.deepEqual(copied.slice(1), [compacted, lines[3]])
  assert.ok(fs.statSync(cleanup.sourcePath).size < 32 * 1024 * 1024)
  assert.ok(fs.statSync(file).size > 32 * 1024 * 1024)
  cleanup()
}))

test('discarded Codex history still must have valid records and the selected identity', () => {
  for (const bad of ['not json', JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } })]) {
    fixture(({ api, receipt, owner, cwd, home, file, lines }) => {
      const launch = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd)
      fs.writeFileSync(file, JSON.stringify(lines[0]) + '\n' + bad + '\n' + JSON.stringify({ type: 'compacted', payload: { replacement_history: [lines[1].payload] } }) + '\n')
      const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
      assert.throws(() => launch.stageSource(targetHome), /unfinished record|another conversation identity/)
      assert.deepEqual(fs.readdirSync(targetHome), [])
    })
  }
})

test('paginated history without a native replacement checkpoint cannot become a partial standalone copy', () => fixture(({ api, receipt, owner, cwd, home, file, lines }) => {
  const meta = { ...lines[0], payload: { ...lines[0].payload, history_mode: 'paginated' } }
  fs.writeFileSync(file, [meta, ...lines.slice(1)].map(JSON.stringify).join('\n') + '\n')
  const targetHome = path.join(home, 'confined-codex'); fs.mkdirSync(targetHome)
  const launch = api.redeemFork(api.prepareFork(receipt, owner).forkReceipt, owner, cwd)
  assert.throws(() => launch.stageSource(targetHome), { code: 'EDITOR_FORK_UNSUPPORTED' })
  assert.deepEqual(fs.readdirSync(targetHome), [])
}))
