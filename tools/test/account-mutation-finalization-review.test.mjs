// T578 independent preparation; not executed while the coordinated test lane is paused.
// Baseline main SHA256: 4e527e51295b9a364f02ff8c4022e7e9187ad7dec7e61421b46d14dfb5eae49d.
// Source inspection: finalization is sequential finish -> mirror -> pending.delete.
// A thrown finish can prevent mirror/delete; a thrown mirror can prevent delete.
// These are injected dependency-fault controls, not measured production failures.
// Current inspected main SHA256: 6c8b8ee69007f378abd87be5accb0037017a92e38c69f8eb12e099f12609688a.
// Current nested finally structurally attempts finish, then mirror, then pending deletion,
// including injected finish/mirror throws. This is source review, not a measured GREEN.
// Owner-context source SHA256: 714cf8c4619d3afef3cf8fef213469213f2144c7f0b6081dbaa5ec68618a4a97.
// The old mirror-adjacent-to-finally assertion rejects legitimate epoch finalization.
// Its replacement should assert the actual obligations without requiring source spelling.
// No original retention store tests or production files were changed by this reviewer.
// Scope: nine prepared cases; no Electron UI, real account/store mutation, or Linux execution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'

const require = createRequire(import.meta.url)
const mainPath = fileURLToPath(new URL('../../shell/main.cjs', import.meta.url))
const ownerPath = fileURLToPath(new URL('../../shell/image-owner-context.cjs', import.meta.url))
const { createImageOwnerContext } = require(ownerPath)
const source = readFileSync(mainPath, 'utf8')
const ast = parseAst(source)
const names = ['withAccountMutation', 'withFleetProfileSender', 'fleetFailure', 'accountResetRefusal']
const functions = names.map(name => {
  const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name)
  assert.ok(node, 'actual main function available: ' + name)
  return source.slice(node.start, node.end)
}).join('\n')
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const paths = [mainPath, ownerPath, fileURLToPath(import.meta.url)]
const before = Object.fromEntries(paths.map(file => [file, digest(file)]))
console.log('DEPENDENCIES_BEFORE ' + JSON.stringify(before))
test.after(() => {
  const after = Object.fromEntries(paths.map(file => [file, digest(file)]))
  console.log('DEPENDENCIES_AFTER ' + JSON.stringify(after))
  assert.deepEqual(after, before, 'source and test bytes stay stable around the tests')
})

function harness({ reset = false, sender = true, finishThrows = false, mirrorThrows = false } = {}) {
  const events = []
  const pending = new Set()
  const context = createImageOwnerContext({
    scope: 'isolated-finalization-review',
    readState: () => ({ principal: 'isolated-review-principal', signedIn: false }),
    publish: value => events.push(value.invalidated ? 'invalidated' : 'epoch'),
  })
  const oldContext = context.read()
  events.length = 0
  const invoke = new Function(
    'withDependencies', `
      const { trustedFleetProfileSender, accountResetStarted, getImageOwnerContext,
        mirrorUninstallRetention, accountMutations } = withDependencies;
      ${functions}
      return withAccountMutation;
    `)({
    trustedFleetProfileSender: () => sender,
    accountResetStarted: reset,
    getImageOwnerContext: () => ({
      beginMutation() {
        const finish = context.beginMutation()
        return () => {
          events.push('finish')
          if (finishThrows) throw new Error('injected finish failure')
          finish()
        }
      },
    }),
    mirrorUninstallRetention() {
      events.push('mirror')
      if (mirrorThrows) throw new Error('injected mirror failure')
      return { ok: true }
    },
    accountMutations: pending,
  })
  const action = work => () => {
    events.push('action')
    assert.throws(() => context.authenticate(oldContext), { code: 'IMAGE_OWNER_CHANGED' },
      'the previous owner context must already be invalid before action runs')
    return work()
  }
  return { events, pending, context, oldContext, run: work => invoke({}, action(work)) }
}

function finalized(f) {
  assert.equal(f.pending.size, 0, 'settled mutation is removed from pending Set')
  assert.deepEqual(f.events, ['invalidated', 'action', 'finish', 'epoch', 'mirror'])
  const current = f.context.read()
  assert.notEqual(current.currentEpoch, f.oldContext.currentEpoch)
  assert.throws(() => f.context.authenticate(f.oldContext), { code: 'IMAGE_OWNER_CHANGED' })
  assert.equal(f.context.authenticate(current).authenticated, true)
}

test('pending async action invalidates owner before action and finalizes only after settlement', async () => {
  const f = harness()
  let release
  const pendingAction = new Promise(resolve => { release = resolve })
  const operation = f.run(() => pendingAction)
  assert.equal(f.pending.size, 1)
  assert.deepEqual(f.events, ['invalidated', 'action'])
  assert.throws(() => f.context.read(), { code: 'IMAGE_OWNER_CHANGED' })
  const answer = { ok: true, marker: 'async result' }
  release(answer)
  assert.equal(await operation, answer)
  finalized(f)
})

test('async rejection still finishes epoch then mirrors and clears pending', async () => {
  const f = harness()
  let rejectAction
  const pendingAction = new Promise((resolve, reject) => { rejectAction = reject })
  const operation = f.run(() => pendingAction)
  assert.equal(f.pending.size, 1)
  rejectAction(new Error('isolated action rejection'))
  const result = await operation
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_FLEET_PROFILE_ACTION_FAILED')
  finalized(f)
})

test('sync throw still finishes epoch then mirrors without leaving a pending entry', async () => {
  const f = harness()
  const result = await f.run(() => { throw new Error('isolated sync throw') })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_FLEET_PROFILE_ACTION_FAILED')
  finalized(f)
})

test('synchronous result is preserved and finalization completes', async () => {
  const f = harness()
  const answer = { ok: true, marker: 'sync result' }
  assert.equal(await f.run(() => answer), answer)
  finalized(f)
})

test('reset refusal runs no action and does not begin an owner mutation', async () => {
  const f = harness({ reset: true })
  const result = await f.run(() => assert.fail('reset refusal must not act'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ACCOUNT_RESET_STARTED')
  assert.deepEqual(f.events, ['mirror'])
  assert.equal(f.pending.size, 0)
  assert.equal(f.context.read(), f.oldContext)
})

test('sender refusal runs no action and does not begin an owner mutation', async () => {
  const f = harness({ sender: false })
  const result = await f.run(() => assert.fail('sender refusal must not act'))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_FLEET_PROFILE_SENDER_REFUSED')
  assert.deepEqual(f.events, ['mirror'])
  assert.equal(f.pending.size, 0)
  assert.equal(f.context.read(), f.oldContext)
})

for (const options of [
  { finishThrows: true, mirrorThrows: false },
  { finishThrows: false, mirrorThrows: true },
  { finishThrows: true, mirrorThrows: true },
]) {
  test('cleanup obligations remain independent under injected faults ' + JSON.stringify(options), async () => {
    const f = harness(options)
    // Allow either explicit error propagation or named handling; assert cleanup behavior.
    await f.run(() => ({ ok: true })).then(() => undefined, () => undefined)
    assert.ok(f.events.includes('finish'), 'owner finalization must be attempted')
    assert.ok(f.events.includes('mirror'), 'retention mirror must be attempted even if owner finalization throws')
    assert.ok(f.events.indexOf('finish') < f.events.indexOf('mirror'), 'owner finalization precedes retention mirror')
    assert.equal(f.pending.size, 0, 'cleanup failure must not strand a settled mutation in the pending Set')
    if (!options.finishThrows) {
      assert.equal(f.context.authenticate(f.context.read()).authenticated, true)
      assert.throws(() => f.context.authenticate(f.oldContext), { code: 'IMAGE_OWNER_CHANGED' })
    }
  })
}
