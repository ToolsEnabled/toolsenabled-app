'use strict'

// Native observations for a bounded state/command cohort. The only bridge
// operations here are reads. Changes still use the ordinary visible controls.
// Loading this module neither opens an app nor runs a scenario.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const identityFields = ['id', 'treeId', 'parentId', 'sessionId', 'profileId', 'role', 'tier', 'effort', 'status', 'message']
const identity = node => Object.fromEntries(identityFields.map(key => [key, node[key] ?? null]))
function selected(snapshot, nodeId) {
  assert.ok(snapshot?.computerId && Array.isArray(snapshot.nodes), 'Read the actual saved computer and nodes')
  const matches = snapshot.nodes.filter(node => node.id === nodeId)
  assert.equal(matches.length, 1, 'Exactly one saved node must match the selected identity')
  assert.ok(matches[0].treeId, 'The selected node must retain its saved tree')
  return matches[0]
}
function ledgerBytes(context) {
  const file = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
}
async function saved(context, nodeId) {
  const matches = await context.page.evaluate(id => {
    const records = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const value = JSON.parse(localStorage.getItem(key))
      if (value?.nodes?.some(node => node.id === id)) records.push(value)
    }
    return records
  }, nodeId)
  assert.equal(matches.length, 1, 'The selected node must belong to one actual saved computer')
  selected(matches[0], nodeId)
  return matches[0]
}
function assertReadOnlyIdentity({ before, after, nodeId, ledgerBefore, ledgerAfter }) {
  const node = selected(before, nodeId)
  selected(after, nodeId)
  assert.equal(after.computerId, before.computerId)
  assert.deepEqual(after.nodes.map(identity), before.nodes.map(identity), 'The read must retain every saved node, session, state and brief')
  assert.ok(Buffer.isBuffer(ledgerBefore) && Buffer.isBuffer(ledgerAfter) && ledgerBefore.equals(ledgerAfter),
    'The owned signed session ledger must remain byte-identical around the read')
  return { computerId: before.computerId, treeId: node.treeId, nodeId, sessionId: node.sessionId ?? null,
    status: node.status, ledgerSha256: sha256(ledgerBefore), nodeIdentitiesSha256: sha256(JSON.stringify(before.nodes.map(identity))) }
}
async function readOnly(context, label, nodeId, read, check) {
  return context.step(label, async () => {
    const before = await saved(context, nodeId)
    const ledgerBefore = ledgerBytes(context)
    const value = await read()
    const ledgerAfter = ledgerBytes(context)
    const after = await saved(context, nodeId)
    const bound = assertReadOnlyIdentity({ before, after, nodeId, ledgerBefore, ledgerAfter })
    return { ...bound, ...await check(value, { before, after, ledgerBefore, ledgerAfter }) }
  })
}

// Only settled saved states are interpreted here. Busy/unknown records need
// the app's non-persisted ownership map and cannot earn credit by inference.
function assertOverviewEvidence({ before, after, nodeId, expectedState, display, ledgerBefore, ledgerAfter }) {
  const node = selected(before, nodeId)
  const stateByStatus = { draft: 'draft', finished: 'finished', interrupted: 'review', failed: 'review', 'turn-failed': 'review' }
  assert.ok(['draft', 'finished', 'review'].includes(expectedState))
  assert.equal(stateByStatus[node.status], expectedState, 'The selected saved node must actually have the requested settled state')
  if (expectedState === 'draft') assert.equal(node.sessionId ?? null, null)
  else assert.ok(node.sessionId, 'A completed/interrupted turn must retain its real session')
  const nodes = before.nodes.filter(item => item.treeId === node.treeId)
  const counts = {}
  for (const item of nodes) {
    const state = stateByStatus[item.status]
    assert.ok(state, 'An unobserved busy/unknown node cannot be classified from saved status alone')
    counts[state] = (counts[state] || 0) + 1
  }
  assert.equal(display?.mode, 'live')
  assert.equal(display.projection, 'available')
  assert.equal(display.treeId, node.treeId, 'Read the selected tree, not a matching count elsewhere')
  assert.equal(display.agents, nodes.length)
  assert.deepEqual([...display.stateKeys].sort(), Object.keys(counts).sort(), 'Duplicate or omitted rendered state badges cannot be collapsed')
  assert.deepEqual(display.states, counts, 'Every state count in this exact tree must match its settled saved nodes')
  return { ...assertReadOnlyIdentity({ before, after, nodeId, ledgerBefore, ledgerAfter }), expectedState, counts }
}
async function observeOverview(context, nodeId, expectedState) {
  return context.step(`state-overview-${expectedState}`, async () => {
    const before = await saved(context, nodeId)
    const node = selected(before, nodeId)
    const ledgerBefore = ledgerBytes(context)
    await context.page.keyboard.press('Escape')
    const back = context.page.getByRole('button', { name: 'Back to the fleet overview', exact: true })
    if (await back.isVisible()) await back.click()
    const overview = context.page.locator('.fleet-overview[data-live-mode="live"][data-projection-state="available"]')
    await overview.waitFor()
    const row = overview.locator(`[data-fleet-open-tree="${node.treeId}"]`)
    await row.waitFor()
    const display = await row.evaluate(element => ({
      mode: element.closest('.fleet-overview').dataset.liveMode,
      projection: element.closest('.fleet-overview').dataset.projectionState,
      treeId: element.dataset.fleetOpenTree,
      agents: Number(element.querySelector('.fleet-overview-tree-size')?.textContent.trim().split(/\s+/)[0]),
      stateKeys: [...element.querySelectorAll('[data-state]')].map(state => state.dataset.state),
      states: Object.fromEntries([...element.querySelectorAll('[data-state]')].map(state => [state.dataset.state, Number(state.textContent.trim().split(/\s+/)[0])])),
    }))
    const proof = assertOverviewEvidence({ before, after: await saved(context, nodeId), nodeId, expectedState, display,
      ledgerBefore, ledgerAfter: ledgerBytes(context) })
    await row.click()
    await context.page.locator(`.static-tree-node[data-agent-id="${nodeId}"]`).waitFor()
    return proof
  })
}

function assertStartingEvidence({ before, starting, after, nodeId, records, startingAt }) {
  const first = selected(before, nodeId)
  const middle = selected(starting, nodeId)
  const last = selected(after, nodeId)
  assert.equal(first.status, 'draft')
  assert.equal(first.sessionId ?? null, null)
  assert.equal(middle.status, 'starting', 'The transient state must have been observed during this actual Start')
  assert.equal(last.status, 'finished')
  assert.ok(last.sessionId)
  assert.ok(Number.isFinite(startingAt) && startingAt >= 0, 'Retain the actual renderer observation time')
  for (const snapshot of [starting, after]) {
    assert.equal(snapshot.computerId, before.computerId)
    assert.deepEqual(snapshot.nodes.map(node => node.id), before.nodes.map(node => node.id))
    assert.deepEqual(snapshot.nodes.filter(node => node.id !== nodeId).map(identity),
      before.nodes.filter(node => node.id !== nodeId).map(identity), 'Starting the selected node must retain every sibling identity, state and brief')
    for (const field of ['id', 'parentId', 'treeId', 'profileId', 'role', 'tier', 'effort', 'message']) {
      assert.equal(selected(snapshot, nodeId)[field] ?? null, first[field] ?? null, `Start must retain ${field}`)
    }
  }
  if (middle.sessionId) assert.equal(middle.sessionId, last.sessionId)
  const starts = records.filter(row => row.action === 'agent_session_start')
  assert.equal(starts.length, 1, 'The initial root Start may not create an unrelated or duplicate session')
  assert.equal(starts[0].sessionId, last.sessionId)
  assert.equal(starts[0].details?.agentId, nodeId)
  assert.equal(records.filter(row => row.action === 'agent_session_outcome' && row.sessionId === last.sessionId
    && row.outcome?.resolves === starts[0].sequence && row.outcome.result === 'started').length, 1)
  return { computerId: before.computerId, treeId: first.treeId, nodeId, sessionId: last.sessionId,
    before: first.status, observed: middle.status, after: last.status,
    startingAt, startSequence: starts[0].sequence }
}
async function beginObservedStart(context, nodeId, action) {
  const before = await saved(context, nodeId)
  assert.equal(selected(before, nodeId).status, 'draft')
  // Arm a read-only poll before the visible action. No synthetic event, delay
  // of the host, or changed renderer storage can manufacture the observation.
  const pending = context.page.waitForFunction(id => {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const value = JSON.parse(localStorage.getItem(key))
      if (value?.nodes?.some(node => node.id === id && node.status === 'starting')) {
        return { snapshot: value, at: performance.now() }
      }
    }
    return null
  }, nodeId, { polling: 10, timeout: 30000 }).then(async handle => {
    try { return await handle.jsonValue() } finally { await handle.dispose() }
  }, error => ({ error: error.message }))
  await context.step('state-root-visible-start-action', action)
  const observation = await pending
  if (!observation.snapshot) context.unavailable(`The actual saved starting state was not observed: ${observation.error}`)
  return { before, starting: observation.snapshot, startingAt: observation.at }
}
async function finishObservedStart(context, nodeId, observation) {
  return context.step('state-root-draft-starting-finished', async () => {
    const after = await saved(context, nodeId)
    const snapshot = await nativeHistory(context, nodeId)
    return { ...assertStartingEvidence({ ...observation, after, nodeId, records: snapshot.records }), ledgerSha256: snapshot.ledgerSha256 }
  })
}

function assertConfinementEvidence(value, level, displayed) {
  const sandbox = { guided: 'read-only', standard: 'workspace-write', unrestricted: 'danger-full-access' }[level]
  assert.ok(sandbox, 'The selected setup must be a reviewed permission level')
  assert.equal(value?.ok, true)
  assert.equal(value.tier, level)
  assert.equal(value.sandbox, sandbox)
  assert.equal(value.approvalPolicy, 'never')
  assert.equal(value.isolated, true)
  assert.equal(value.recorded, true, 'The actual chosen setup must have a recorded level')
  assert.equal(value.failedClosed, false, 'An unreadable setup fallback cannot prove the selected level')
  assert.ok(Number.isSafeInteger(value.toolsTotal) && value.toolsTotal > 0)
  assert.ok(value.toolsAllowed === null || Number.isSafeInteger(value.toolsAllowed) && value.toolsAllowed >= 0 && value.toolsAllowed <= value.toolsTotal)
  assert.ok(displayed.startsWith(`${level} ·`), 'The actual Details consumer must display this same selected level')
  return { command: 'agent:confinement', selectedLevel: level, displayed, sandbox, toolsTotal: value.toolsTotal, toolsAllowed: value.toolsAllowed }
}
function assertToolsEvidence(value, confinement) {
  assert.equal(value?.ok, true)
  assert.equal(value.tier, confinement.tier)
  assert.ok(Array.isArray(value.tools) && value.tools.length > 0)
  assert.equal(value.total, value.tools.length)
  assert.equal(value.total, confinement.toolsTotal, 'The registry list and separate confinement count must agree')
  const names = value.tools.map(tool => {
    assert.match(tool.name, /^[a-zA-Z][a-zA-Z0-9_.:-]*$/)
    assert.equal(typeof tool.allowed, 'boolean')
    assert.equal(typeof tool.gated, 'boolean')
    return tool.name
  })
  assert.equal(new Set(names).size, names.length, 'Duplicate tools cannot conceal an omitted tool')
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)))
  assert.equal(value.tools.filter(tool => tool.allowed).length, confinement.toolsAllowed ?? confinement.toolsTotal)
  return { command: 'agent:tools', tier: value.tier, toolsTotal: value.total,
    toolsAllowed: value.tools.filter(tool => tool.allowed).length, toolsSha256: sha256(JSON.stringify(value.tools)) }
}
async function observePermissionReads(context, nodeId, displayed) {
  let confinement
  await readOnly(context, 'state-command-confinement', nodeId, async () => {
    confinement = await context.page.evaluate(() => window.mcAgent.confinement())
    return confinement
  }, value => assertConfinementEvidence(value, context.options.level, displayed))
  await readOnly(context, 'state-command-tools', nodeId,
    () => context.page.evaluate(() => window.mcAgent.tools()), value => assertToolsEvidence(value, confinement))
}

function assertProfilesEvidence({ value, fileBefore, fileAfter, expected, present }) {
  assert.ok(Buffer.isBuffer(fileBefore) && Buffer.isBuffer(fileAfter) && fileBefore.equals(fileAfter), 'Reading profiles must retain the exact saved profile bytes')
  const record = JSON.parse(fileBefore)
  assert.equal(record.v, 1)
  assert.ok(Array.isArray(record.profiles))
  const profiles = record.profiles.map(({ id, name, cwd }) => ({ id, name, cwd }))
  for (const profile of profiles) for (const key of ['id', 'name', 'cwd']) assert.ok(typeof profile[key] === 'string' && profile[key])
  assert.equal(new Set(profiles.map(profile => profile.id)).size, profiles.length)
  assert.equal(value?.ok, true)
  assert.deepEqual(value.profiles, profiles, 'Every returned profile must match the actual owned file projection')
  const matches = profiles.filter(profile => profile.id === expected.id)
  assert.equal(matches.length, present ? 1 : 0)
  if (present) assert.deepEqual(matches[0], expected, 'The native folder selection must retain its exact ID, name and selected path')
  return { command: 'agent:profiles', profileId: expected.id, present, profileCount: profiles.length, profileFileSha256: sha256(fileBefore) }
}
async function observeProfiles(context, present) {
  const file = path.join(context.paths.userData, 'session-profiles.json')
  const expected = { id: context.state.controlsProfileId, name: context.state.controlsProfileName, cwd: context.paths.namedWorkspace }
  await readOnly(context, `state-command-profiles-${present ? 'created' : 'removed'}`, context.state.rootId, async () => {
    const fileBefore = fs.readFileSync(file)
    const value = await context.page.evaluate(() => window.mcAgent.profiles())
    return { value, fileBefore, fileAfter: fs.readFileSync(file), expected, present }
  }, assertProfilesEvidence)
}
async function nativeHistory(context, nodeId) {
  let snapshot
  await readOnly(context, 'state-command-history', nodeId,
    () => context.page.evaluate(() => window.mcAgent.history({ limit: 200 })), (history, capture) => {
      // Lazy loading avoids a cycle: the ordinary native scenarios also import
      // this helper. This is the existing exact byte/projection verifier.
      const { assertVerifiedSessionSnapshot } = require('./page2-native-functions-scenarios.cjs')
      snapshot = assertVerifiedSessionSnapshot({ history, ...capture })
      const node = selected(capture.before, nodeId)
      const starts = snapshot.records.filter(row => row.action === 'agent_session_start' && row.sessionId === node.sessionId)
      assert.equal(starts.length, 1)
      assert.equal(starts[0].details?.agentId, nodeId)
      assert.equal(snapshot.records.filter(row => row.action === 'agent_session_outcome' && row.sessionId === node.sessionId
        && row.outcome?.resolves === starts[0].sequence && row.outcome.result === 'started').length, 1)
      return { command: 'agent:history', verified: true, total: snapshot.verifiedHistoryTotal,
        startSequence: starts[0].sequence, ledgerSha256: snapshot.ledgerSha256 }
    })
  return snapshot
}

function assertBoundedPanelEvidence({ phase, parent, before, after, display, rows = [], statuses = [], ledgerBefore, ledgerAfter }) {
  assert.ok(['idle', 'completed'].includes(phase))
  const current = selected(before, parent.id)
  assert.equal(current.sessionId, parent.sessionId)
  assert.ok(parent.sessionId)
  const proof = assertReadOnlyIdentity({ before, after, nodeId: parent.id, ledgerBefore, ledgerAfter })
  assert.equal(display.kind, 'launch')
  assert.equal(display.stopEnabled, false)
  assert.equal(display.startEnabled, true)
  if (phase === 'idle') {
    assert.equal(display.message, 'Write a brief for the child work.')
    assert.deepEqual(display.rows, [])
    assert.deepEqual(rows, [])
    assert.deepEqual(statuses, [])
  } else {
    assert.equal(display.message, 'The host confirmed all started work closed. No further run is scheduled.')
    assert.ok(rows.length > 0)
    assert.equal(statuses.length, rows.length)
    assert.deepEqual(display.rows, rows.map(row => ({ nodeId: row.nodeId, sessionId: row.sessionId, phase: 'closed' })))
    for (const [index, row] of rows.entries()) {
      const status = statuses[index]
      assert.equal(status?.ok, true)
      assert.equal(status.state, 'closed')
      assert.equal(status.sessionId, row.sessionId)
      assert.equal(status.nodeId, row.nodeId)
      assert.equal(status.parentNodeId, parent.id)
      assert.equal(status.parentSessionId, parent.sessionId)
      assert.equal(selected(before, row.nodeId).sessionId, row.sessionId)
      assert.ok(Number.isSafeInteger(status.endRecord?.sequence) && /^[a-f0-9]{64}$/.test(status.endRecord?.eventHash || ''))
    }
  }
  return { ...proof, phase, displayed: display.message, rows: display.rows }
}
async function observeBoundedPanel(context, box, parent, phase, rows = []) {
  await context.step(`state-bounded-${phase}`, async () => {
    const before = await saved(context, parent.id)
    const ledgerBefore = ledgerBytes(context)
    const statuses = []
    for (const row of rows) statuses.push(await context.page.evaluate(sessionId => window.mcAgent.workStatus({ sessionId }), row.sessionId))
    const display = await box.evaluate(element => ({
      kind: element.dataset.nativeWork,
      message: element.querySelector('[data-launch="out"]').textContent.trim(),
      stopEnabled: !element.querySelector('[data-launch="stop"]').disabled,
      startEnabled: !element.querySelector('[data-launch="dispatch"]').disabled,
      rows: [...element.querySelectorAll('[data-work-session]')].map(row => ({ nodeId: row.dataset.workNode, sessionId: row.dataset.workSession, phase: row.dataset.phase })),
    }))
    return assertBoundedPanelEvidence({ phase, parent, before, after: await saved(context, parent.id), display, rows, statuses,
      ledgerBefore, ledgerAfter: ledgerBytes(context) })
  })
}

module.exports = { assertReadOnlyIdentity, assertOverviewEvidence, assertStartingEvidence, assertConfinementEvidence,
  assertToolsEvidence, assertProfilesEvidence, assertBoundedPanelEvidence, observeOverview, beginObservedStart,
  finishObservedStart, observePermissionReads, observeProfiles, observeBoundedPanel }
