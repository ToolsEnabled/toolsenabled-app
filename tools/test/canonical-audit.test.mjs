import { canonicalRootForTests } from '../canonical-root.mjs'
/* Behavioural contract for the Electron main-process canonical ledger seam.
 * Nothing here launches Electron: canonical-audit.cjs only needs Node modules,
 * and its payload loader is injected so each outcome is deterministic. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const audit = require('../../shell/canonical-audit.cjs')
const STATE_ROOT = path.resolve('test-state', 'capability')
const PAYLOAD_ROOT = path.resolve('test-payload')

test.afterEach(() => audit.resetForTests())

test('loading refuses ambiguous locations and distinguishes an absent payload', () => {
  let loads = 0
  const invalidEnv = { TOOLSENABLED_STATE_ROOT: 'keep-invalid-selection' }
  const invalid = audit.loadCanonicalAudit({
    stateRoot: 'relative/capability',
    root: PAYLOAD_ROOT,
    load() { loads += 1 },
    env: invalidEnv,
  })
  assert.deepEqual(
    { ok: invalid.ok, code: invalid.code, hasReason: typeof invalid.reason === 'string' && invalid.reason.length > 0 },
    { ok: false, code: 'AUDIT_STATE_ROOT_INVALID', hasReason: true },
    'a relative state root must be a reasoned refusal, not a guessed ledger location',
  )
  assert.equal(loads, 0, 'an invalid state root reached the payload loader')
  assert.equal(invalidEnv.TOOLSENABLED_STATE_ROOT, 'keep-invalid-selection',
    'an invalid state root changed the process ledger selection before it was refused')

  const absentEnv = { TOOLSENABLED_STATE_ROOT: 'keep-absent-selection' }
  const absent = audit.loadCanonicalAudit({ stateRoot: STATE_ROOT, root: null, load() { loads += 1 }, env: absentEnv })
  assert.deepEqual(
    { ok: absent.ok, code: absent.code, hasReason: typeof absent.reason === 'string' && absent.reason.length > 0 },
    { ok: false, code: 'AUDIT_PAYLOAD_ABSENT', hasReason: true },
    'a missing payload must remain unknown/unavailable rather than becoming a definite usable answer',
  )
  assert.equal(loads, 0, 'an absent payload reached the payload loader')
  assert.equal(absentEnv.TOOLSENABLED_STATE_ROOT, 'keep-absent-selection',
    'an absent payload changed the process ledger selection even though no writer could be loaded')
})

test('loading sets the selected state root before accepting a recognized writer', () => {
  const env = {}
  const writer = { requireRecord() {}, verify() {} }
  let requested
  const loaded = audit.loadCanonicalAudit({
    stateRoot: STATE_ROOT,
    root: PAYLOAD_ROOT,
    env,
    load(file) {
      requested = file
      assert.equal(env.TOOLSENABLED_STATE_ROOT, STATE_ROOT,
        'the writer loaded before it was pointed at the caller-selected ledger')
      return writer
    },
  })

  assert.equal(loaded.ok, true, `a recognized writer was refused: ${loaded.code ?? ''} ${loaded.reason ?? ''}`)
  assert.equal(loaded.audit, writer, 'success did not return the writer that was validated')
  assert.equal(requested, path.join(PAYLOAD_ROOT, audit.AUDIT_MODULE),
    'the loader was not asked for the declared canonical writer')

  const unrecognized = audit.loadCanonicalAudit({
    stateRoot: STATE_ROOT, root: PAYLOAD_ROOT, env: {}, load: () => ({ requireRecord() {} }),
  })
  assert.deepEqual(
    { ok: unrecognized.ok, code: unrecognized.code, hasReason: typeof unrecognized.reason === 'string' && unrecognized.reason.length > 0 },
    { ok: false, code: 'AUDIT_MODULE_UNRECOGNIZED', hasReason: true },
    'a partial writer must be refused with a reason rather than treated as ready',
  )
})

test('recording returns the durable receipt, while write failure can never report success', async () => {
  const details = { surface: 'app.ipc', outcome: 'created' }
  let call
  const recorded = await audit.recordCanonical('account.create', 'account-7', details, {
    stateRoot: STATE_ROOT,
    root: PAYLOAD_ROOT,
    fresh: true,
    env: {},
    load: () => ({
      verify() {},
      requireRecord(action, target, receivedDetails) {
        call = { action, target, details: receivedDetails }
        return { sequence: 41, eventHash: 'event-hash-41', ignored: 'not part of the shell contract' }
      },
    }),
  })
  assert.deepEqual(call, { action: 'account.create', target: 'account-7', details },
    'the caller action, identifier, or outcome details changed before reaching the writer')
  assert.deepEqual(recorded, { ok: true, sequence: 41, eventHash: 'event-hash-41' },
    'a successful append did not return its sequence and tamper-evident event hash')

  const refused = await audit.recordCanonical('controller.agent.launch', 'session-9', { outcome: 'started' }, {
    stateRoot: STATE_ROOT,
    root: PAYLOAD_ROOT,
    fresh: true,
    env: {},
    load: () => ({
      verify() {},
      requireRecord() { throw Object.assign(new Error('disk unavailable'), { code: 'AUDIT_HEAD_UNAVAILABLE' }) },
    }),
  })
  assert.deepEqual(
    { ok: refused.ok, code: refused.code, hasReason: typeof refused.reason === 'string' && refused.reason.length > 0 },
    { ok: false, code: 'AUDIT_HEAD_UNAVAILABLE', hasReason: true },
    'a failed durable append must be a reasoned refusal and preserve the writer failure code',
  )
})

test('closing reports both no-open and closed outcomes, and names a close failure', async () => {
  const unopened = await audit.closeCanonical()
  assert.deepEqual(
    { ok: unopened.ok, closed: unopened.closed, hasReason: typeof unopened.reason === 'string' && unopened.reason.length > 0 },
    { ok: true, closed: false, hasReason: true },
    'an unopened ledger must not claim that a database handle was closed',
  )

  const scratch = mkdtempSync(path.join(tmpdir(), 'canonical-audit-close-'))
  try {
    const payload = path.join(scratch, 'payload')
    mkdirSync(path.join(payload, 'src', 'lib'), { recursive: true })
    writeFileSync(path.join(payload, audit.AUDIT_MODULE), `
      exports.requireRecord = () => ({ sequence: 1, eventHash: 'hash' })
      exports.verify = () => ({ valid: true })
      exports.resetForTests = () => {}
    `)
    const capabilityPath = require.resolve('../../shell/capability-layer.cjs')
    const canonicalPath = require.resolve('../../shell/canonical-audit.cjs')
    const capability = require(capabilityPath)
    const originalResolve = capability.resolveCapabilityRoot
    capability.resolveCapabilityRoot = () => payload
    delete require.cache[canonicalPath]
    const closableAudit = require(canonicalPath)
    capability.resolveCapabilityRoot = originalResolve

    const loaded = closableAudit.canonicalAudit({ stateRoot: scratch })
    assert.equal(loaded.ok, true, `the staged canonical writer did not open: ${loaded.code ?? ''} ${loaded.reason ?? ''}`)
    assert.deepEqual(await closableAudit.closeCanonical(), { ok: true, closed: true },
      'a supported close did not report that the open handle was released')

    const reopened = closableAudit.canonicalAudit({ stateRoot: scratch })
    assert.equal(reopened.ok, true, `the canonical writer did not reopen: ${reopened.code ?? ''} ${reopened.reason ?? ''}`)
    const originalClose = reopened.audit.resetForTests
    reopened.audit.resetForTests = () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }) }
    const failed = await closableAudit.closeCanonical()
    reopened.audit.resetForTests = originalClose
    originalClose()
    assert.deepEqual(
      { ok: failed.ok, code: failed.code, hasReason: typeof failed.reason === 'string' && failed.reason.length > 0 },
      { ok: false, code: 'AUDIT_CLOSE_FAILED', hasReason: true },
      'a close error must remain a reasoned failure rather than claiming the ledger is ready for deletion',
    )
  } finally {
    audit.resetForTests()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('Basic canonical receipts preserve the Engine disposition and policy snapshot without opening a worker', async () => {
  const engineRoot = canonicalRootForTests({ requireConfigured: true })
  const operation = require(path.join(engineRoot, 'src/lib/operation-audit.js'))
  let enabled = false, writes = 0
  const options = { stateRoot: STATE_ROOT, root: PAYLOAD_ROOT, fresh: true, env: {},
    loadSettings: () => ({ values: { 'audit.enabled': enabled }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] }),
    load: () => ({ operationAudit: operation, verify() { throw Error('Basic must not verify'); }, requireRecord() { writes++; return { sequence: writes, eventHash: 'a'.repeat(64) } } }),
  }
  const captured = audit.captureAuditPolicy(options)
  enabled = true
  const intent = await audit.recordCanonical('test.intent', 'identity', {}, { ...options, auditPolicy: captured.decision })
  assert.deepEqual(intent, operation.skippedStatus('test.intent', 'identity'))
  const batch = await audit.recordCanonicalBatch([{ action: 'test', target: 'identity', details: {} }], { ...options, auditPolicy: captured.decision })
  assert.deepEqual(batch, { ok: true, results: [operation.skippedStatus('test', 'identity')] })
  assert.equal(writes, 0)
  const on = audit.captureAuditPolicy(options)
  enabled = false
  assert.deepEqual(await audit.recordCanonical('test.intent', 'second', {}, { ...options, auditPolicy: on.decision }), { ok: true, sequence: 1, eventHash: 'a'.repeat(64) })
  assert.deepEqual(await audit.recordCanonical('test', 'second', {}, { ...options, auditPolicy: on.decision }), { ok: true, sequence: 2, eventHash: 'a'.repeat(64) })
  assert.equal(writes, 2)
})


test('Basic shipping Engine operation receipts satisfy the accepted App classifier without flat audit evidence', async t => {
  const engine = canonicalRootForTests({ requireConfigured: true })
  // This suite also runs against the packed engine, which does not ship the
  // source-test helpers. Isolate state before loading its runtime modules.
  const scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'canonical-shipping-')))
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  process.env.TOOLSENABLED_STATE_ROOT = scratch
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot
    rmSync(scratch, { recursive: true, force: true })
  })
  const runtimeStateRoot = require(path.join(engine, 'src/lib/runtime-state-root.js'))
  assert.equal(runtimeStateRoot.resolveStateRoot().root, scratch)
  const { validAuditReceiptPair, validOperationAuditReceipt } = await import('../../src/mission-bridge.js')
  const { StateStore } = require(path.join(engine, 'src/lib/state-store.js'))
  const { createLaunch } = require(path.join(engine, 'src/lib/controller-launch-record.js'))
  const { createMissionActions } = require(path.join(engine, 'src/lib/mission-bridge/actions.js'))
  const { normalizeOrg } = require(path.join(engine, 'src/lib/agent-org.js'))
  const org = normalizeOrg(JSON.parse(readFileSync(path.join(engine, 'config/agent-org.json'), 'utf8')))
  const actor = org.agents.find(agent => agent.enabled === true && agent.role === 'controller')?.id
  assert.ok(actor, 'the packed declaration must contain an enabled controller')
  const stateStore = new StateStore({ file: ':memory:' })
  const off = () => ({ values: {}, provenance: {}, rejected: [] })
  const forbidden = new Proxy({}, { get() { throw Error('Basic opened audit infrastructure') } })
  try {
    const actions = createMissionActions({ roots: { fixture: process.cwd() }, actor, agentOrg: org,
      permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} }, researchActions: {}, machinesActions: {},
      loadSettings: off, audit: forbidden,
      appendQueuePhase: input => ({ phaseId: 'phase-one', previousHash: input.expectedHash, nextHash: 'b'.repeat(64), queuePath: 'BUILD-QUEUE.md' }) })
    const queued = await actions.queue({ operation: 'open', rootId: 'fixture', expectedHash: 'a'.repeat(64), title: 'Test', authority: 'T781', brief: 'No worker starts' })
    assert.equal(validAuditReceiptPair(queued.receipt.intentAudit, queued.receipt.audit, 'build.queue.open', 'fixture', 'phase-one'), true)
    assert.equal(validAuditReceiptPair(queued.receipt.intentAudit, queued.receipt.audit, 'build.queue.open', 'wrong-root', 'phase-one'), false)
    const launched = createLaunch({ requestingActor: actor, targetAgentId: actor, tier: 'cheap', model: 'luna-cheap-tier', objectiveRef: 'T781', cap: { kind: 'turns', value: 1, capMs: 60000 } },
      { stateStore, org, loadSettings: off, audit: forbidden })
    assert.equal(validOperationAuditReceipt(launched, 'controller.agent.launch', launched.launchId), true)
    assert.equal(validOperationAuditReceipt({ ...launched, auditSequence: 1, auditEventHash: 'a'.repeat(64) }, 'controller.agent.launch', launched.launchId), false)
    assert.equal(validOperationAuditReceipt(launched, 'controller.agent.launch', 'wrong-launch'), false)
  } finally { stateStore.close() }
})


test('disabled canonical audit retires only after admitted results and leaves a re-enabled replacement intact', async () => {
  const { EventEmitter } = await import('node:events');
  const operationAudit = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'));
  let enabled = true;
  const workers = [];
  class HeldWorker extends EventEmitter {
    constructor() { super(); this.messages = []; this.terminated = 0; workers.push(this); queueMicrotask(() => this.emit('message', { kind: 'ready' })); }
    unref() {}
    postMessage(message) {
      this.messages.push(message);
      if (message.kind === 'close') queueMicrotask(() => this.emit('message', { id: 0, result: { ok: true, closed: true } }));
    }
    async terminate() { this.terminated++; return 0; }
    answer(result) { const message = this.messages.find(row => row.kind !== 'close'); this.emit('message', { id: message.id, result }); }
  }
  const options = { stateRoot: STATE_ROOT, root: PAYLOAD_ROOT, WorkerClass: HeldWorker, timeoutMs: 1000, flushMs: 1,
    load: () => ({ requireRecord() { throw Error('worker required'); }, verify() {}, operationAudit }),
    loadSettings: () => ({ values: { 'audit.enabled': enabled }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] }) };
  const heldPolicy = audit.captureAuditPolicy(options).decision;
  const pending = audit.recordCanonicalBatch([{ action: 'settings.set', target: 'first', details: {} }], { ...options, auditPolicy: heldPolicy });
  assert.equal(workers.length, 1);
  enabled = false;
  const off = await audit.recordCanonical('settings.set', 'off', {}, options);
  assert.equal(off.disposition, 'not-required');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(workers[0].terminated, 0, 'off cannot use the 1ms shutdown deadline on pending required work');
  enabled = true;
  const replacement = audit.recordCanonicalBatch([{ action: 'settings.set', target: 'second', details: {} }], options);
  assert.equal(workers.length, 2);
  const signed = { ok: true, results: [{ ok: true, sequence: 11, eventHash: 'a'.repeat(64) }] };
  workers[0].answer(signed);
  assert.deepEqual(await pending, signed);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(workers[0].terminated, 1);
  assert.equal(workers[1].terminated, 0, 'old retirement cannot close the new lane');
  enabled = false;
  const refused = { ok: false, code: 'AUDIT_HEAD_UNAVAILABLE', reason: 'anchor refused' };
  workers[1].answer(refused);
  assert.deepEqual(await replacement, refused, 'turning off never relabels a required refusal');
  await audit.retireCanonicalWhenDisabled(options);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(workers[1].terminated, 1);
  const before = workers.length;
  assert.equal((await audit.recordCanonical('settings.set', 'still-off', {}, options)).recorded, false);
  assert.equal(workers.length, before, 'Basic creates no replacement worker');
});


test('idle canonical closure requires its matching acknowledgement and keeps uncertainty visible', async () => {
  const { EventEmitter } = await import('node:events');
  const { createCanonicalAuditQueue } = require('../../shell/canonical-audit-queue.cjs');
  let worker, terminated = 0, settled = false;
  class Worker extends EventEmitter {
    constructor() { super(); worker = this; this.requests = []; queueMicrotask(() => this.emit('message', { kind: 'ready' })); }
    unref() {}
    postMessage(message) { this.requests.push(message); }
    async terminate() { terminated++; }
  }
  const queue = createCanonicalAuditQueue({ WorkerClass: Worker, flushMs: 100, timeoutMs: 500 });
  const pending = queue.record('test', 'target');
  const request = worker.requests[0];
  worker.emit('message', { id: request.id, result: { ok: true, sequence: 1, eventHash: 'a'.repeat(64) } });
  assert.equal((await pending).sequence, 1);
  const retiring = queue.retireWhenIdle(); retiring.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(worker.requests.some(row => row.kind === 'close'));
  worker.emit('message', { id: request.id, result: { ok: true, closed: true } });
  await Promise.resolve();
  assert.equal(settled, false, 'late record acknowledgement is not a close acknowledgement');
  worker.emit('message', { id: 0, result: { ok: true } });
  const closed = await retiring;
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'AUDIT_CLOSE_FAILED');
  assert.equal(terminated, 1, 'only the settled, owned idle worker is stopped');
});

function retainedPolicyFixture() {
  const engine = canonicalRootForTests({ requireConfigured: true })
  const operation = require(path.join(engine, 'src/lib/operation-audit.js'))
  const root = mkdtempSync(path.join(tmpdir(), 'audit-policy-invalid-'))
  const valuesPath = path.join(root, 'settings.json')
  let writes = 0, workers = 0
  const options = { stateRoot: root, root: engine, fresh: true, env: {}, valuesPath,
    load: () => ({ operationAudit: operation, verify() { throw Error('No history read permitted'); },
      requireRecord() { writes++; return { sequence: writes, eventHash: 'a'.repeat(64) } } }),
    WorkerClass: class { constructor() { workers++; throw Error('No worker permitted'); } } }
  return { operation, options, root, valuesPath, get writes() { return writes }, get workers() { return workers },
    write: values => writeFileSync(valuesPath, JSON.stringify({ revision: 1, values,
      provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])) })) }
}

test('unreadable and rejected audit masters refuse actual loader and canonical admission before writing', async () => {
  const f = retainedPolicyFixture()
  // Truly absent/readable and explicit false remain ordinary Basic operation.
  for (const mode of ['absent', 'false', 'on']) {
    if (mode !== 'absent') f.write({ 'audit.enabled': mode === 'on' })
    const captured = audit.captureAuditPolicy(f.options)
    assert.equal(captured.ok, true)
    assert.equal(captured.decision.required, mode === 'on')
    const receipt = await audit.recordCanonical('test.intent', mode, {}, { ...f.options, auditPolicy: captured.decision })
    if (mode === 'on') assert.equal(receipt.sequence, 1)
    else assert.equal(f.operation.isNotRequired(receipt, 'test.intent', mode), true)
  }
  for (const mode of ['malformed', 'rejected-master', 'unreadable']) {
    if (mode === 'malformed') writeFileSync(f.valuesPath, '{bad-json')
    if (mode === 'rejected-master') f.write({ 'audit.enabled': 'sometimes' })
    const options = mode === 'unreadable' ? { ...f.options, valuesPath: f.root } : f.options
    const captured = audit.captureAuditPolicy(options)
    assert.equal(captured.ok, false, mode)
    assert.equal(captured.code, 'AUDIT_POLICY_INVALID', mode)
    const single = await audit.recordCanonical('test.intent', mode, {}, options)
    assert.equal(single.code, 'AUDIT_POLICY_INVALID', mode)
    const batch = await audit.recordCanonicalBatch([{ action: 'settings.set', target: mode }], options)
    assert.equal(batch.code, 'AUDIT_POLICY_INVALID', mode)
  }
  assert.equal(f.writes, 1); assert.equal(f.workers, 0)
  // A valid admitted snapshot survives later unreadability. It is not a new
  // grant: the object must already be minted by the trusted resolver.
  f.write({ 'audit.enabled': true })
  const admitted = audit.captureAuditPolicy(f.options).decision
  writeFileSync(f.valuesPath, '{later-unreadable')
  assert.equal((await audit.recordCanonical('test.outcome', 'on', {}, { ...f.options, auditPolicy: admitted })).sequence, 2)
  assert.equal(f.writes, 2)
  assert.throws(() => f.operation.capturePolicy({ ...f.options, auditPolicy: { required: false } }), /trusted runtime resolver/)
  // All fixture paths are retained. This case has no cleanup finalizer.
})

test('unknown audit configuration refuses actual single and batch settings handlers before mutation', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const handlers = new Map(), f = retainedPolicyFixture()
  let applied = 0
  const context = {
    CAPABILITY_STATE_ROOT: f.root, auditIdentitySettings: null,
    ipcMain: { handle: (channel, run) => handlers.set(channel, run) },
    withFleetProfileSender: (_event, run) => run(),
    captureAuditPolicy: () => audit.captureAuditPolicy(f.options),
    setProductSetting: ({ id, value }) => { applied++; return { ok: true, id, value, revision: applied } },
    setProductSettingsMany: () => { applied++; return { ok: true, results: [{ id: 'audit.activity', value: 'Full', revision: applied }] } },
    recordCanonical: (action, target, details, auditPolicy) => audit.recordCanonical(action, target, details, { ...f.options, auditPolicy }),
    recordCanonicalBatch: (items, options) => audit.recordCanonicalBatch(items, { ...f.options, auditPolicy: options.auditPolicy }),
    console
  }
  const first = main.indexOf("ipcMain.handle('mc-settings:set',")
  const last = main.indexOf('\n/* ---------- the declared organisation', first)
  assert.ok(first >= 0 && last > first)
  vm.runInNewContext(main.slice(first, last), context)
  const event = { sender: { id: 1 } }
  for (const mode of ['malformed', 'rejected-master', 'unreadable']) {
    if (mode === 'malformed') writeFileSync(f.valuesPath, '{bad-json')
    if (mode === 'rejected-master') f.write({ 'audit.enabled': 'sometimes' })
    if (mode === 'unreadable') f.options.valuesPath = f.root
    for (const channel of ['mc-settings:set', 'mc-settings:set-many']) {
      const reply = await handlers.get(channel)(event, { id: 'audit.activity', value: 'Full' })
      assert.equal(reply.code, 'AUDIT_POLICY_INVALID', mode + ':' + channel)
    }
  }
  assert.equal(applied, 0); assert.equal(f.writes, 0); assert.equal(f.workers, 0)
  f.options.valuesPath = f.valuesPath; f.write({ 'audit.enabled': false })
  const single = await handlers.get('mc-settings:set')(event, { id: 'audit.activity', value: 'Full' })
  assert.equal(single.ok, true)
  assert.equal(f.operation.isNotRequired(single.recorded, 'settings.set', 'audit.activity'), true)
  const batch = await handlers.get('mc-settings:set-many')(event, {})
  assert.equal(batch.ok, true)
  assert.equal(f.operation.isNotRequired(batch.results[0].recorded, 'settings.set', 'audit.activity'), true)
  assert.equal(applied, 2); assert.equal(f.writes, 0)
})


async function inertTerminationFixture(trigger) {
  const { EventEmitter } = await import('node:events');
  const workers = [];
  class Worker extends EventEmitter {
    constructor() {
      super(); this.messages = []; this.terminated = 0; workers.push(this);
      this.termination = new Promise((resolve, reject) => { this.finish = resolve; this.refuse = reject; });
    }
    unref() {}
    postMessage(message) {
      this.messages.push(message);
      this.emit('message', { kind: 'ready' });
      if (message.kind === 'close') this.emit('message', { id: 0, result: { ok: true, closed: true } });
      else if (trigger === 'post') throw Error('synthetic post failure');
    }
    terminate() { this.terminated++; return this.termination; }
  }
  return { Worker, workers, trigger() { if (trigger === 'error') workers[0].emit('error', Error('synthetic worker failure')); } };
}
const oneTurn = () => new Promise(resolve => setImmediate(resolve));
function freshCanonicalForTermination() {
  const Module = require('node:module');
  const filename = require.resolve('../../shell/canonical-audit.cjs');
  const loaded = new Module(filename); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
for (const trigger of ['timeout', 'error', 'post']) test(`audit termination custody survives ${trigger} before queue retirement and repeated close`, async () => {
  const { createCanonicalAuditQueue } = require('../../shell/canonical-audit-queue.cjs');
  const f = await inertTerminationFixture(trigger);
  const queue = createCanonicalAuditQueue({ WorkerClass: f.Worker, timeoutMs: 5, flushMs: 10 });
  const request = queue.record('fixture', 'owned'); f.trigger();
  assert.equal((await request).code, 'AUDIT_UNAVAILABLE');
  let settled = false;
  const retiring = queue.retireWhenIdle(); retiring.then(() => { settled = true; });
  const concurrent = queue.close();
  try {
    await oneTurn();
    assert.equal(f.workers[0].terminated, 1);
    assert.equal(settled, false, 'dispatched termination must settle before retirement can report closure');
    f.workers[0].refuse(Error('synthetic termination rejection'));
    const [first, second] = await Promise.all([retiring, concurrent]);
    assert.equal(first.code, 'AUDIT_CLOSE_FAILED'); assert.deepEqual(second, first);
    assert.deepEqual(await queue.close(), first, 'a failed termination must not become already-closed success');
    assert.equal(f.workers[0].terminated, 1, 'concurrent closes share the same owned termination');
    assert.equal((await queue.record('late', 'owned')).ok, false);
  } finally { for (const worker of f.workers) worker.finish(0); await queue.close(); }
});
for (const rejected of [false, true]) test(`audit termination custody reaches actual wrapper close after timeout with ${rejected ? 'rejected' : 'deferred successful'} termination`, async () => {
  const canonical = freshCanonicalForTermination();
  const f = await inertTerminationFixture('timeout');
  const operationAudit = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'));
  let enabled = true;
  const options = { stateRoot: STATE_ROOT, root: PAYLOAD_ROOT, WorkerClass: f.Worker, timeoutMs: 5, flushMs: 10,
    load: () => ({ requireRecord() { throw Error('worker required'); }, verify() {}, resetForTests() {}, operationAudit }),
    loadSettings: () => ({ values: { 'audit.enabled': enabled }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] }) };
  const request = canonical.recordCanonicalBatch([{ action: 'fixture', target: 'owned' }], options);
  enabled = false;
  const retirement = canonical.retireCanonicalWhenDisabled(options);
  assert.equal((await request).code, 'AUDIT_UNAVAILABLE');
  let closed = false, retired = false;
  retirement.then(() => { retired = true; });
  const closing = canonical.closeCanonical(); closing.then(() => { closed = true; });
  const concurrent = canonical.closeCanonical();
  try {
    await oneTurn();
    assert.equal(retired, false, 'wrapper cannot forget its retiring queue while termination is pending');
    assert.equal(closed, false); assert.equal(f.workers[0].terminated, 1);
    if (rejected) f.workers[0].refuse(Error('synthetic termination rejection')); else f.workers[0].finish(0);
    const [first, second] = await Promise.all([closing, concurrent]); await retirement;
    assert.deepEqual(second, first);
    if (rejected) {
      assert.equal(first.code, 'AUDIT_CLOSE_FAILED');
      assert.equal((await canonical.closeCanonical()).code, 'AUDIT_CLOSE_FAILED');
    } else assert.equal(first.ok, true);
    assert.equal(f.workers[0].terminated, 1);
  } finally { for (const worker of f.workers) worker.finish(0); await retirement; await canonical.closeCanonical(); }
});

test('audit termination custody shares explicit close and does not lose a replacement lane', async () => {
  const canonical = freshCanonicalForTermination();
  const f = await inertTerminationFixture('held');
  const options = { stateRoot: STATE_ROOT, root: PAYLOAD_ROOT, WorkerClass: f.Worker, timeoutMs: 1000, flushMs: 10 };
  const first = canonical.findCanonicalEvents({ action: 'one' }, options);
  f.workers[0].emit('message', { id: f.workers[0].messages[0].id, result: { ok: true, events: [] } }); await first;
  let settled = false;
  const closing = canonical.closeCanonical(); closing.then(() => { settled = true; });
  const concurrent = canonical.closeCanonical();
  try {
    await oneTurn(); assert.equal(settled, false);
    let concurrentSettled = false; concurrent.then(() => { concurrentSettled = true; }); await oneTurn();
    assert.equal(concurrentSettled, false, 'a second close must retain pending closure custody');
    const second = canonical.findCanonicalEvents({ action: 'two' }, options);
    assert.equal(f.workers.length, 2);
    f.workers[1].emit('message', { id: f.workers[1].messages[0].id, result: { ok: true, events: [] } }); await second;
    f.workers[0].finish(0);
    assert.deepEqual(await closing, await concurrent);
    assert.equal(f.workers[1].terminated, 0, 'the captured old close cannot stop its replacement');
    const last = canonical.closeCanonical(); await oneTurn(); assert.equal(f.workers[1].terminated, 1);
    f.workers[1].finish(0); assert.equal((await last).ok, true);
  } finally { for (const worker of f.workers) worker.finish(0); await canonical.closeCanonical(); }
});

test('audit termination custody includes a replaced pre-ready worker and excludes its late receipt', async () => {
  const { EventEmitter } = await import('node:events');
  const { createCanonicalAuditQueue } = require('../../shell/canonical-audit-queue.cjs');
  const workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); this.messages = []; this.terminated = 0; workers.push(this); this.done = new Promise(resolve => { this.finish = resolve; }); }
    unref() {}
    postMessage(message) {
      this.messages.push(message);
      if (message.kind === 'close') this.emit('message', { id: 0, result: { ok: true, closed: true } });
    }
    terminate() { this.terminated++; return this.done; }
  }
  const queue = createCanonicalAuditQueue({ WorkerClass: Worker, readFileSync: () => 'inert source fallback', timeoutMs: 500, flushMs: 10 });
  let recorded = false;
  const request = queue.record('fixture', 'owned'); request.then(() => { recorded = true; });
  const oldListener = workers[0].listeners('message')[0];
  workers[0].emit('error', Error('entry not ready'));
  assert.equal(workers.length, 2);
  oldListener({ id: workers[0].messages[0].id, result: { ok: true, sequence: 999 } });
  try {
    await oneTurn(); assert.equal(recorded, false, 'a captured old listener cannot settle the replacement request');
    workers[1].emit('message', { id: workers[1].messages[0].id, result: { ok: true, sequence: 1 } });
    assert.equal((await request).sequence, 1);
    let closed = false;
    const closing = queue.close(); closing.then(() => { closed = true; });
    await oneTurn(); workers[1].finish(0); await oneTurn();
    assert.equal(closed, false, 'replacement completion cannot forget the earlier termination');
    workers[0].finish(0); assert.equal((await closing).closed, true);
    assert.deepEqual(workers.map(worker => worker.terminated), [1, 1]);
  } finally { for (const worker of workers) worker.finish(0); await queue.close(); }
});

test('audit termination custody preserves a synchronous terminate failure after matched close', async () => {
  const { createCanonicalAuditQueue } = require('../../shell/canonical-audit-queue.cjs');
  const f = await inertTerminationFixture('held');
  const queue = createCanonicalAuditQueue({ WorkerClass: f.Worker, timeoutMs: 500, flushMs: 10 });
  const request = queue.record('fixture', 'owned');
  f.workers[0].emit('message', { id: f.workers[0].messages[0].id, result: { ok: true, sequence: 1 } }); await request;
  f.workers[0].terminate = () => { f.workers[0].terminated++; throw Error('synthetic synchronous termination failure'); };
  const first = await queue.close();
  assert.equal(first.code, 'AUDIT_CLOSE_FAILED'); assert.deepEqual(await queue.close(), first);
  assert.equal(f.workers[0].terminated, 1);
  f.workers[0].finish(0);
});
