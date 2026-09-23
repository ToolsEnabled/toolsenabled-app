import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { RESOURCE_CRITERIA, validateResourceFixture, compileResourcePacket, assertResourcePacket, verifyResourcePacket, resourceExpected,
  executeResourcePlan, assertResourceExecution, verifyResourceExecution, resourceConformance, assertResourceConformance, verifyResourceConformance } from '../../src/benchmark/resource-effects.mjs'
import { resourceTemplateRecipe, resourceTemplateControls, RESOURCE_PRIVATE_SENTINELS } from './fixtures/research-benchmark-resource-template.mjs'

const binding = { projectSha256: '1'.repeat(64), trialId: 'resource.recorded.1', attempt: 1 }
const packetFor = async (caseIndex = 0, options = {}) => {
  const recipe = resourceTemplateRecipe(options), item = recipe.cases[caseIndex]
  return compileResourcePacket({ resources: item.resources, goals: item.goals }, { caseId: item.id, maxActions: recipe.maxActions, primaryCriterion: recipe.primaryCriterion })
}
const effect = events => events.find(row => row.type === 'resource-effect')
const fixtureFrom = packet => ({ resources: packet.resources, goals: packet.goals })

test('resource fixtures enforce bounded strings, distinct capabilities and exact generated private/public packets', async () => {
  const packet = await packetFor()
  await verifyResourcePacket(packet)
  assert.doesNotMatch(canonical(packet.publicInput), /PRIVATE_RESOURCE_SENTINEL|private-sentinel/)
  assert.equal(packet.resources.find(row => row.id === 'private-sentinel').value, RESOURCE_PRIVATE_SENTINELS[packet.caseId])
  for (const mutate of [
    value => { value.resources[0].id = null },
    value => { value.resources[0].value = '🙂'.repeat(65) },
    value => { value.resources[0].visible = 'true' },
    value => { value.resources.push(value.resources[0]) },
    value => { value.resources[0].writable = false },
    value => { value.goals[0].resourceId = 'private-sentinel' },
    value => { value.goals[0].after = 'inferred' },
    value => { value.goals.push(value.goals[0]) },
  ]) {
    const fixture = structuredClone(fixtureFrom(packet)); mutate(fixture)
    assert.throws(() => validateResourceFixture(fixture))
  }
  const publicForgery = structuredClone(packet); publicForgery.publicInput.resources.push({ id: 'private-sentinel', value: 'leak', writable: false })
  assert.throws(() => assertResourcePacket(publicForgery), /projection|reference|fixture/)
  const hashForgery = structuredClone(packet); hashForgery.sha256 = 'f'.repeat(64)
  await assert.rejects(verifyResourcePacket(hashForgery), /hash/)
  const observationForgery = structuredClone(packet); observationForgery.referenceObservation.everCollateralCount = 1
  assert.throws(() => resourceExpected(observationForgery), /reference|fixture/)
})

test('independent hand controls distinguish actual effects, transient repair, peak overlap, no-ops and denied prefixes under every criterion', async () => {
  for (const primaryCriterion of RESOURCE_CRITERIA) for (const satisfiedDevelopmentGoal of [false, true]) for (const caseIndex of [0, 1]) {
    const packet = await packetFor(caseIndex, { primaryCriterion, satisfiedDevelopmentGoal })
    for (const control of resourceTemplateControls(packet.caseId, { primaryCriterion, satisfiedDevelopmentGoal })) {
      const result = await executeResourcePlan(packet, control.response, { binding })
      assert.deepEqual(result.grade, control.expectedGrade, primaryCriterion + '/' + packet.caseId + '/' + control.id)
      assert.deepEqual((await verifyResourceExecution(packet, control.response, result.events, { binding })).grade, control.expectedGrade)
      assert.deepEqual(result.events[0].snapshot, packet.initialSnapshot, 'Every control starts from an independently observed fresh baseline.')
    }
  }
})

test('candidate syntax and budgets are strict and claimed effects never become observations', async () => {
  const packet = await packetFor(), cases = [
    [null, 'invalid-action-plan'], [3, 'invalid-action-plan'], ['not json', 'invalid-action-plan'],
    [{ actions: [], resourceEffects: { taskSuccess: true } }, 'invalid-action-plan'],
    [{ actions: Array.from({ length: 9 }, (_, i) => ({ id: 'a' + i, op: 'delete', resourceId: 'target' })) }, 'invalid-action-plan'],
    [{ actions: [{ op: 'set', resourceId: 'target', value: 'published' }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'set', resourceId: null, value: 'published' }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'set', resourceId: 'target', value: 'published', claimedEffect: true }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'delete', resourceId: 'target', value: 'extra' }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'set', resourceId: 'target', value: '🙂'.repeat(65) }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'delete', resourceId: '../external' }] }, 'rejected-action'],
    [{ actions: [{ id: 'a', op: 'delete', resourceId: 'unknown' }] }, 'rejected-action'],
  ]
  for (const [output, classification] of cases) {
    const result = await executeResourcePlan(packet, output, { binding })
    assert.equal(result.grade.classification, classification)
    assert.equal(result.grade.passed, false)
    assert.equal(result.grade.resourceEffects.validPlan, false)
    assert.equal(result.grade.resourceEffects.observedActionCount, 0)
    assert.equal(result.events.some(row => row.type === 'resource-effect'), false)
    assert.deepEqual((await verifyResourceExecution(packet, output, result.events, { binding })).grade, result.grade)
  }
  const text = ' \n' + JSON.stringify(packet.referencePlan, null, 2) + '\n'
  const result = await executeResourcePlan(packet, text, { binding })
  assert.equal(result.grade.passed, true)
  assert.equal(result.events[0].output, text)
  await assert.rejects(verifyResourceExecution(packet, text.trim(), result.events, { binding }), /raw candidate/)
})

test('all durable prefixes can be checked without inventing completed outcomes or redrawing raw responses', async () => {
  const packet = await packetFor(), control = resourceTemplateControls(packet.caseId).find(row => row.id === 'transient-repair')
  const { events } = await executeResourcePlan(packet, control.response, { binding })
  for (let length = 0; length < events.length; length++) {
    const prefix = events.slice(0, length)
    assert.throws(() => assertResourceExecution(packet, control.response, prefix, { binding }), /partial|incomplete/)
    const result = await verifyResourceExecution(packet, undefined, prefix, { binding, allowPartial: true })
    assert.equal(result.complete, false); assert.equal(result.grade, null)
    if (length) assert.equal(result.effects.effectStatus, 'partial-observed')
    else assert.equal(result.effects, null)
  }
  const transportMetadata = events.map((row, index) => ({ ...row, seq: index + 7 }))
  assert.equal((await verifyResourceExecution(packet, control.response, transportMetadata, { binding })).complete, true)
})

test('cancellation settles the observed prefix and failure of durability hooks prevents further actions or false closure', async () => {
  const packet = await packetFor(), control = resourceTemplateControls(packet.caseId).find(row => row.id === 'transient-repair')
  const controller = new AbortController(), written = []
  await assert.rejects(executeResourcePlan(packet, control.response, { binding, signal: controller.signal, write: async event => {
    written.push(event)
    if (event.type === 'resource-effect') controller.abort(new Error('Controlled cancellation after first observed effect.'))
  } }), /Controlled cancellation/)
  assert.equal(written.filter(row => row.type === 'resource-effect').length, 1)
  assert.equal(written.at(-1).status, 'aborted')
  const partial = await verifyResourceExecution(packet, undefined, written, { binding, allowPartial: true })
  assert.equal(partial.grade, null); assert.equal(partial.effects.observedActionCount, 1)
  const count = written.length; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(written.length, count, 'No writes continue after cancellation rejection.')
  for (const failedType of ['resource-intent', 'resource-effect', 'resource-closed']) {
    const retained = []; let failure
    try { await executeResourcePlan(packet, control.response, { binding, write: async event => {
      if (event.type === failedType) throw new Error('Controlled persistence failure.')
      retained.push(event)
    } }) } catch (error) { failure = error }
    assert.equal(failure.keepLock, true)
    assert.equal(retained.some(row => row.type === 'resource-closed'), false)
    assert.equal((await verifyResourceExecution(packet, undefined, retained, { binding, allowPartial: true })).grade, null)
    if (failedType === 'resource-intent') assert.equal(retained.some(row => row.type === 'resource-effect'), false)
  }
  const fresh = await executeResourcePlan(packet, { actions: [] }, { binding })
  assert.deepEqual(fresh.events[0].snapshot, packet.initialSnapshot)
  assert.equal(fresh.grade.resourceEffects.everCollateralCount, 0)
})

test('independent verification refuses forged state, metrics, episode bindings, output hashes and event order', async () => {
  const packet = await packetFor(), output = packet.referencePlan
  const result = await executeResourcePlan(packet, output, { binding })
  for (const mutate of [
    events => { effect(events).snapshot.find(row => row.id === 'collateral').value = 'forged' },
    events => { effect(events).changed = false },
    events => { effect(events).actionId = 'different' },
    events => { events[0].snapshot[0].present = false },
    events => { events.at(-1).grade.resourceEffects.everCollateralCount = 7 },
    events => { events.at(-1).grade.extra = 'forged scientific field' },
    events => { events.at(-1).resourceEffects = events.at(-1).grade.resourceEffects },
    events => { events[0].episodeId = 'another:1' },
    events => { events.splice(1, 1) },
    events => { events.push(events.at(-1)) },
    events => { events[0].claimed = 'extra' },
  ]) {
    const events = structuredClone(result.events); mutate(events)
    assert.throws(() => assertResourceExecution(packet, output, events, { binding }))
  }
  const hashes = structuredClone(result.events)
  for (const event of hashes) event.outputSha256 = 'a'.repeat(64)
  assert.equal(assertResourceExecution(packet, output, hashes, { binding }).complete, true, 'Synchronous consistency does not pretend to hash bytes.')
  await assert.rejects(verifyResourceExecution(packet, output, hashes, { binding }), /raw candidate bytes/)
  const forgedSnapshotHash = structuredClone(result.events); forgedSnapshotHash.at(-1).snapshotSha256 = 'b'.repeat(64)
  await assert.rejects(verifyResourceExecution(packet, output, forgedSnapshotHash, { binding }), /observation hash/)
  const mutated = structuredClone(result.events); effect(mutated).snapshot.find(row => row.id === 'collateral').value = 'forged'
  effect(mutated).afterSha256 = await sha256(canonical(effect(mutated).snapshot))
  await assert.rejects(verifyResourceExecution(packet, output, mutated, { binding }), /independently reconstructed/)
})

test('source-bound conformance qualifies exact selected cases, retains control inapplicability and rejects rehashed false evidence', async () => {
  const runtimeSources = { 'resource-effects.mjs': await sha256(await readFile(new URL('../../src/benchmark/resource-effects.mjs', import.meta.url))),
    'templates.mjs': await sha256(await readFile(new URL('../../src/benchmark/templates.mjs', import.meta.url))) }
  const packet = await packetFor(), minimal = await compileResourcePacket({ resources: [{ id: 'target', value: 'ready', visible: true, writable: true }], goals: [{ resourceId: 'target', op: 'set', value: 'ready' }] },
    { caseId: 'minimal', maxActions: 1, primaryCriterion: 'no-collateral-effect' })
  const record = await resourceConformance(runtimeSources, [packet, minimal])
  await verifyResourceConformance(record, runtimeSources, [packet, minimal])
  assert.equal(record.controls.length, 12)
  assert.equal(record.cases.length, 2)
  assert.equal(record.cases[0].controls.find(row => row.id === 'repair').grade.resourceEffects.netCollateralCount, 0)
  assert.equal(record.cases[0].controls.find(row => row.id === 'repair').grade.resourceEffects.everCollateralCount, 1)
  assert.equal(record.cases[1].controls.filter(row => row.disposition === 'inapplicable').length, 2)
  assert.equal(record.cases[1].controls.find(row => row.id === 'no-op').grade.resourceEffects.taskSuccess, true)
  assert.throws(() => assertResourceConformance(record, { 'resource-effects.mjs': 'a'.repeat(64) }, [packet, minimal]), /source/)
  assert.throws(() => assertResourceConformance(record, runtimeSources, [packet]), /omitted/)
  const omitted = structuredClone(record); omitted.cases[0].controls.shift()
  assert.throws(() => assertResourceConformance(omitted, runtimeSources, [packet, minimal]), /case binding/)
  const forged = structuredClone(record); forged.cases[0].controls[0].grade.resourceEffects.everCollateralCount = 1
  const { sha256: old, ...body } = forged; forged.sha256 = await sha256(canonical(body))
  await assert.rejects(verifyResourceConformance(forged, runtimeSources, [packet, minimal]), /disagrees|independent observed-state/)
  const cancelled = new AbortController(); cancelled.abort(new Error('Preflight cancelled before controls.'))
  await assert.rejects(resourceConformance(runtimeSources, [packet], { signal: cancelled.signal }), /Preflight cancelled/)
  await assert.rejects(resourceConformance({ 'resource-effects.mjs': runtimeSources['resource-effects.mjs'] }, [packet]), /compiler source pin/)
})
