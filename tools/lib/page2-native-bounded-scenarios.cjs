'use strict'

// These cases start the real installed providers through visible Page 2
// controls. evaluate() is restricted to reading the saved tree and the host's
// retained status/verified history. No start, send, close, fake event or receipt
// is injected through the bridge. Merely loading this module runs no case.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { observeBoundedPanel } = require('./page2-native-state-evidence.cjs')
const { waitForNativeResourceReady } = require('./page2-native-resource-readiness.cjs')
const { details, navigate, openControls, palette, exactAgentReply } = require('./page2-native-scenarios.cjs')

const receiptFields = ['action', 'computerId', 'treeId', 'parentNodeId', 'parentSessionId', 'nodeId', 'agentId', 'sessionId', 'capMs', 'startedAt', 'deadlineAt']
const signed = record => Number.isSafeInteger(record?.sequence) && record.sequence > 0
  && /^[a-f0-9]{64}$/.test(String(record.eventHash || ''))

// Kept separate so a replay cannot silently accept a signed intent which
// refused to start, a different parent, or an ending for a different session.
function assertNativeWorkEvidence({ row, saved, parent, status, records, history, capMs, closed = false, reason = null }) {
  assert.equal(history?.ok, true, 'The native record history must be readable')
  assert.equal(history.verified, true, 'The owning native recorder must verify the signed ledger')
  assert.equal(status?.ok, true, 'The owner must be able to read the exact retained session')
  assert.equal(status.action, 'tree.dispatch')
  assert.equal(status.sessionId, row.sessionId)
  assert.equal(status.nodeId, row.nodeId)
  assert.equal(status.agentId, row.nodeId)
  assert.equal(status.computerId, saved.computerId)
  assert.equal(status.treeId, parent.treeId)
  assert.equal(status.parentNodeId, parent.id)
  assert.equal(status.parentSessionId, parent.sessionId)
  assert.ok(Number.isSafeInteger(status.capMs) && status.capMs > 0 && status.capMs <= capMs)
  assert.ok(Number.isFinite(status.startedAt) && Number.isFinite(status.deadlineAt))
  // Inheritance can shorten the remaining duration after initial admission;
  // the host retains that earlier startedAt. Compare the actual deadline to
  // the requested bound, without inventing equality with a later remainder.
  assert.ok(status.deadlineAt > status.startedAt && status.deadlineAt - status.startedAt <= capMs)
  const child = saved.nodes.find(node => node.id === row.nodeId)
  assert.ok(child, 'The receipt must name a child in the saved tree')
  assert.equal(child.parentId, parent.id)
  assert.equal(child.treeId, parent.treeId)
  assert.equal(child.sessionId, row.sessionId)
  assert.equal(child.tier, 'astra')
  assert.equal(child.effort, 'max')
  assert.ok(signed(status.record), 'The start must retain its actual signed receipt')
  const starts = records.filter(record => record.action === 'agent_session_start' && record.sessionId === row.sessionId)
  assert.equal(starts.length, 1, 'One accepted child session must have one signed start intent')
  const start = starts[0]
  assert.equal(start.sequence, status.record.sequence)
  assert.equal(start.eventHash, status.record.eventHash)
  assert.ok(typeof start.signature === 'string' && start.signature.length > 0)
  assert.equal(start.details?.agentId, row.nodeId)
  for (const field of receiptFields) assert.equal(start.details?.boundedWork?.[field], status[field], `The signed start must bind ${field}`)
  assert.equal(records.filter(record => record.action === 'agent_session_outcome' && record.sessionId === row.sessionId
    && record.outcome?.resolves === start.sequence && record.outcome.result === 'started').length, 1,
  'A durable intent alone does not prove that the provider session started')
  if (closed) {
    assert.equal(status.state, 'closed', 'Cleanup must be confirmed by the host')
    assert.ok(signed(status.endRecord), 'A closed label alone is not a signed cleanup receipt')
    const endings = records.filter(record => record.action === 'agent_session_end' && record.sessionId === row.sessionId)
    assert.equal(endings.length, 1)
    const end = endings[0]
    assert.equal(end.sequence, status.endRecord.sequence)
    assert.equal(end.eventHash, status.endRecord.eventHash)
    assert.equal(end.end?.resolves, start.sequence)
    assert.ok(typeof end.signature === 'string' && end.signature.length > 0)
    if (reason) { assert.equal(status.reason, reason); assert.equal(end.end.reason, reason) }
    for (const field of receiptFields) assert.equal(end.details?.boundedWork?.[field], status[field], `The signed end must retain ${field}`)
  }
  return { nodeId: row.nodeId, sessionId: row.sessionId, parentNodeId: parent.id,
    parentSessionId: parent.sessionId, capMs: status.capMs, startedAt: status.startedAt,
    deadlineAt: status.deadlineAt, state: status.state, reason: status.reason,
    record: status.record, endRecord: status.endRecord }
}

async function waitUntil(read, message, timeout = 90000) {
  const until = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < until)
  throw new Error(message)
}

async function savedTree(context, nodeId = context.state.rootId) {
  const saved = await context.page.evaluate(id => {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const record = JSON.parse(localStorage.getItem(key))
      if (record?.nodes?.some(node => node.id === id)) return record
    }
    return null
  }, nodeId)
  assert.ok(saved?.computerId && Array.isArray(saved.nodes), 'The real saved tree must contain the selected node')
  return saved
}
const savedNode = async (context, id) => (await savedTree(context, id)).nodes.find(node => node.id === id)
const workStatus = (context, sessionId) => context.page.evaluate(id => window.mcAgent.workStatus({ sessionId: id }), sessionId)
function ledger(context) {
  return fs.readFileSync(path.join(context.paths.userData, 'agent-spawn-records.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
}
async function evidence(context, label, rows, parentById, { capMs, closed = false, reasons = {} }) {
  return context.step(label, async () => {
    const saved = await savedTree(context)
    const statuses = await Promise.all(rows.map(row => workStatus(context, row.sessionId)))
    const history = await context.page.evaluate(() => window.mcAgent.history({ limit: 200 }))
    const records = ledger(context)
    return rows.map((row, index) => assertNativeWorkEvidence({ row, saved, parent: parentById.get(row.nodeId),
      status: statuses[index], records, history, capMs, closed, reason: reasons[row.sessionId] || null }))
  })
}
async function conversation(context, id) {
  const picker = context.page.locator('.tree-chat-picker')
  if (!await picker.isVisible()) await context.page.locator('.tree-chats-toggle').click()
  await context.select(picker, id, { resetsAfterSelection: true })
  const card = context.page.locator(`.tree-conversation[data-agent-id="${id}"]`)
  await card.waitFor()
  return card
}
async function replyAndIdle(context, id, expected) {
  const card = await conversation(context, id)
  await exactAgentReply(context, id, expected)
  await card.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
  assert.equal(await card.locator('.msg.them .chat-msg-text').filter({ hasText: new RegExp(`^${expected}$`) }).count(), 1)
}
async function controls(context, kind, nodeId = context.state.rootId) {
  if (new URL(context.page.url()).hash !== '#/computers') await navigate(context, 'computers')
  await context.page.keyboard.press('Escape')
  await openControls(context, nodeId, 'details')
  const toggle = details(context).locator('[data-start-work-toggle]')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const box = details(context).locator(`[data-native-work="${kind}"]`)
  await box.waitFor()
  return box
}
async function configure(context, kind, brief, { runs = 3 } = {}) {
  if (!context.options.realProvider) context.unavailable('Bounded work needs --real-provider and the owning account’s provider sign-in')
  const enabled = await context.page.evaluate(() => localStorage.getItem('mc.write.dispatch') === 'enabled'
    && localStorage.getItem('mc.write.agent-session') === 'enabled')
  if (!enabled) context.unavailable('This selected setup does not enable both starting sessions and handing out work; use the visible Standard assisted setup for bounded-work replay')
  const box = await controls(context, kind)
  const parent = await savedNode(context, context.state.rootId)
  assert.ok(parent.sessionId, 'The selected Manager must still have its actual provider session')
  await context.select(box.locator(`[data-${kind}="${kind === 'team' ? 'lead' : 'tier'}"]`), 'astra')
  await context.select(box.locator('[data-work-effort]'), 'max')
  if (kind === 'team') {
    for (const member of await box.locator('[data-team-member]').all()) {
      const wanted = await member.getAttribute('data-team-member') === 'astra'
      if (await member.isChecked() !== wanted) await member.click()
    }
  }
  if (kind === 'loop') {
    await context.select(box.locator('[data-loop="runs"]'), String(runs))
    const every = box.locator('[data-loop="every"]')
    const shortest = await every.locator('option').evaluateAll(options => Math.min(...options.map(option => Number(option.value))))
    await context.select(every, String(shortest))
  }
  const cap = box.locator(`[data-${kind}="cap"]`)
  const minimum = Number(await cap.getAttribute('min'))
  assert.ok(Number.isFinite(minimum) && minimum > 0, 'Use the visible cap minimum without changing its bounds')
  await context.type(cap, String(minimum))
  await cap.press('Tab')
  assert.equal(Number(await cap.inputValue()), minimum)
  await context.type(box.locator('[data-work-brief]'), brief)
  return { box, parent, capMs: minimum * 60000 }
}
async function roster(context, box, count) {
  return waitUntil(async () => {
    const rows = await box.locator('[data-work-roster] [data-work-session]').evaluateAll(elements => elements.map(element => ({
      nodeId: element.dataset.workNode, sessionId: element.dataset.workSession, phase: element.dataset.phase,
    })))
    if (rows.length !== count || rows.some(row => !row.nodeId || !row.sessionId || row.phase === 'unconfirmed')) return null
    assert.equal(new Set(rows.map(row => row.nodeId)).size, count)
    assert.equal(new Set(rows.map(row => row.sessionId)).size, count)
    return rows
  }, `The ${count} native work receipts were not rendered; inspect the captured control refusal`, 120000)
}
async function waitClosed(context, rows, timeout = 90000) {
  return waitUntil(async () => {
    const statuses = await Promise.all(rows.map(row => workStatus(context, row.sessionId)))
    return statuses.every(status => status.ok === true && status.state === 'closed' && signed(status.endRecord)) ? statuses : null
  }, 'The host did not confirm every exact child session closed with a signed end receipt', timeout)
}
async function stopFromControls(context, kind, rows) {
  const box = await controls(context, kind)
  await box.locator(`[data-${kind}="stop"]`).click()
  await waitClosed(context, rows)
  await box.locator(`[data-${kind}="out"]`).filter({ hasText: /host confirmed all started sessions closed/ }).waitFor()
  assert.equal(await box.locator(`[data-${kind}="stop"]`).isEnabled(), false)
}
async function sameRoot(context, parent) {
  assert.equal((await savedNode(context, parent.id)).sessionId, parent.sessionId, 'The original Manager must keep its exact session')
  const card = await conversation(context, parent.id)
  assert.match(await card.innerText(), /your agent · live session/)
}
const instruction = word => `Do not use tools, change files, or start other agents. This bounded native UI check needs only a reply containing exactly the single line below. Do not add punctuation, quotation marks, formatting, or any other text.\n\n${word}`

const scenarios = [
  { id: 'bounded-launch-stop', title: 'Hand one real Astra/max child to the selected Manager once and verify full Stop', controls: ['D01', 'D02', 'D04', 'D05', 'C14'], requires: ['root-start'], async run(context) {
    const { box, parent, capMs } = await configure(context, 'launch', instruction('PAGE2_BOUNDED_LAUNCH_READY'))
    await observeBoundedPanel(context, box, parent, 'idle')
    const before = (await savedTree(context)).nodes.map(node => node.id)
    await waitForNativeResourceReady(context, 'bounded-launch-stop')
    await box.locator('[data-launch="dispatch"]').dblclick()
    const rows = await roster(context, box, 1)
    assert.deepEqual((await savedTree(context)).nodes.filter(node => !before.includes(node.id)).map(node => node.id), rows.map(row => row.nodeId))
    const parents = new Map([[rows[0].nodeId, parent]])
    await evidence(context, 'bounded-launch-signed-parent', rows, parents, { capMs })
    await replyAndIdle(context, rows[0].nodeId, 'PAGE2_BOUNDED_LAUNCH_READY')
    await stopFromControls(context, 'launch', rows)
    await evidence(context, 'bounded-launch-signed-stop', rows, parents, { capMs, closed: true })
    await sameRoot(context, parent)
    await context.capture('native-bounded-launch-stopped')
  } },
  { id: 'bounded-team-stop', title: 'Start two same-tier real agents with distinct saved lead/member identities and stop the team', controls: ['D06', 'D07', 'D08', 'D09'], requires: ['bounded-launch-stop'], async run(context) {
    const { box, parent, capMs } = await configure(context, 'team', instruction('PAGE2_BOUNDED_TEAM_READY'))
    await waitForNativeResourceReady(context, 'bounded-team-stop')
    await box.locator('[data-team="go"]').click()
    const rows = await roster(context, box, 2)
    const lead = await savedNode(context, rows[0].nodeId)
    const parents = new Map([[lead.id, parent], [rows[1].nodeId, lead]])
    const proof = await evidence(context, 'bounded-team-signed-hierarchy', rows, parents, { capMs })
    assert.ok(proof[1].deadlineAt <= proof[0].deadlineAt, 'The member may not outlive its lead’s remaining cap')
    for (const row of rows) await replyAndIdle(context, row.nodeId, 'PAGE2_BOUNDED_TEAM_READY')
    await stopFromControls(context, 'team', rows)
    await evidence(context, 'bounded-team-signed-stop', rows, parents, { capMs, closed: true })
    await sameRoot(context, parent)
    await context.capture('native-bounded-team-stopped')
  } },
  { id: 'bounded-loop-navigation-stop', title: 'Continue the one-minute loop on Metrics, recover its controls, then prevent its next scheduled run with Stop', controls: ['D10', 'D11', 'D12', 'D13', 'D14', 'B01'], requires: ['bounded-team-stop'], async run(context) {
    const brief = instruction('PAGE2_BOUNDED_LOOP_READY')
    const { box, parent, capMs } = await configure(context, 'loop', brief)
    const intervalMs = Number(await box.locator('[data-loop="every"]').inputValue()) * 60000
    await waitForNativeResourceReady(context, 'bounded-loop-navigation-stop')
    await box.locator('[data-loop="go"]').click()
    const first = (await roster(context, box, 1))[0]
    await replyAndIdle(context, first.nodeId, 'PAGE2_BOUNDED_LOOP_READY')
    await navigate(context, 'metrics')
    const second = await context.step('bounded-loop-starts-second-on-metrics', () => waitUntil(async () => {
      const matches = (await savedTree(context)).nodes.filter(node => node.parentId === parent.id && node.message === brief && node.sessionId)
      assert.ok(matches.length <= 2, 'The third scheduled run must not precede the second-run Stop')
      return matches.find(node => node.id !== first.nodeId) || null
    }, 'Leaving Page 2 prevented the second authorized loop run', intervalMs + 90000))
    assert.equal(new URL(context.page.url()).hash, '#/metrics')
    await context.capture('native-bounded-loop-second-on-metrics')
    const restored = await controls(context, 'loop')
    assert.equal(await restored.locator('[data-work-brief]').inputValue(), brief)
    assert.equal(await restored.locator('[data-work-effort]').inputValue(), 'max')
    assert.equal(await restored.locator('[data-loop="runs"]').inputValue(), '3')
    assert.equal(Number(await restored.locator('[data-loop="every"]').inputValue()) * 60000, intervalMs)
    const rows = await roster(context, restored, 2)
    assert.equal(rows[1].nodeId, second.id)
    const parents = new Map(rows.map(row => [row.nodeId, parent]))
    await waitClosed(context, [rows[0]])
    const proof = await evidence(context, 'bounded-loop-recovered-receipts', rows, parents, { capMs })
    assert.ok(proof[0].endRecord.sequence < proof[1].record.sequence, 'The first run must be confirmed closed before the second start is recorded')
    await replyAndIdle(context, rows[1].nodeId, 'PAGE2_BOUNDED_LOOP_READY')
    await stopFromControls(context, 'loop', rows)
    await evidence(context, 'bounded-loop-signed-stop', rows, parents, { capMs, closed: true })
    await context.step('bounded-loop-no-third-run-after-full-interval', async () => {
      const recordedStarts = ledger(context).filter(record => record.action === 'agent_session_start').map(record => record.sessionId)
      const deadline = Date.now() + intervalMs + 1000
      await context.page.waitForFunction(until => Date.now() >= until, deadline, { timeout: intervalMs + 15000 })
      const children = (await savedTree(context)).nodes.filter(node => node.parentId === parent.id && node.message === brief)
      assert.deepEqual(children.map(node => node.id).sort(), rows.map(row => row.nodeId).sort())
      assert.equal(ledger(context).filter(record => record.action === 'agent_session_start'
        && children.some(child => child.id === record.details?.agentId)).length, 2)
      assert.deepEqual(ledger(context).filter(record => record.action === 'agent_session_start').map(record => record.sessionId), recordedStarts,
        'Stop must prevent even a later start whose draft or graph binding failed to persist')
    })
    await sameRoot(context, parent)
    await context.capture('native-bounded-loop-recovered-stop')
  } },
  { id: 'bounded-cap-cleanup', title: 'Let the shortest visible cap close a real child and verify its retained signed ending', controls: ['D02', 'D04', 'D05'], requires: ['bounded-launch-stop'], async run(context) {
    const { box, parent, capMs } = await configure(context, 'launch', instruction('PAGE2_BOUNDED_CAP_READY'))
    await waitForNativeResourceReady(context, 'bounded-cap-cleanup')
    await box.locator('[data-launch="dispatch"]').click()
    const rows = await roster(context, box, 1)
    const parents = new Map([[rows[0].nodeId, parent]])
    await evidence(context, 'bounded-cap-signed-start', rows, parents, { capMs })
    await replyAndIdle(context, rows[0].nodeId, 'PAGE2_BOUNDED_CAP_READY')
    await context.step('bounded-cap-waits-for-host-cleanup', () => waitClosed(context, rows, capMs + 60000))
    await evidence(context, 'bounded-cap-signed-end', rows, parents, { capMs, closed: true, reasons: { [rows[0].sessionId]: 'cap-reached' } })
    const finished = await controls(context, 'launch')
    await finished.locator('[data-launch="out"]').filter({ hasText: /host confirmed all started work closed/ }).waitFor()
    assert.equal(await finished.locator('[data-launch="stop"]').isEnabled(), false)
    assert.equal(await finished.locator('[data-launch="dispatch"]').isEnabled(), true)
    await observeBoundedPanel(context, finished, parent, 'completed', rows)
    await sameRoot(context, parent)
    await context.capture('native-bounded-cap-closed')
  } },
  { id: 'bounded-parent-stop-cleanup', title: 'Stop a real bounded lead through its own Actions and verify its member closes with parent-stopped', controls: ['D06', 'D08', 'D09', 'P29'], requires: ['bounded-team-stop'], async run(context) {
    const { box, parent, capMs } = await configure(context, 'team', instruction('PAGE2_BOUNDED_PARENT_READY'))
    await waitForNativeResourceReady(context, 'bounded-parent-stop-cleanup')
    await box.locator('[data-team="go"]').click()
    const rows = await roster(context, box, 2)
    const lead = await savedNode(context, rows[0].nodeId)
    const parents = new Map([[lead.id, parent], [rows[1].nodeId, lead]])
    await evidence(context, 'bounded-parent-signed-starts', rows, parents, { capMs })
    for (const row of rows) await replyAndIdle(context, row.nodeId, 'PAGE2_BOUNDED_PARENT_READY')
    const card = await conversation(context, lead.id)
    await palette(context, card, 'Stop this agent')
    await waitClosed(context, rows)
    await evidence(context, 'bounded-parent-stop-signed-child-cleanup', rows, parents,
      { capMs, closed: true, reasons: { [rows[1].sessionId]: 'parent-stopped' } })
    await context.page.keyboard.press('Escape')
    const finished = await controls(context, 'team')
    await context.step('bounded-parent-stop-panel-settled', async () => {
      await finished.locator('[data-team="out"]').filter({ hasText: /^The host confirmed all started work closed\. No further run is scheduled\.$/ }).waitFor()
      const displayed = await finished.locator('[data-work-session]').evaluateAll(elements => elements.map(element => ({
        nodeId: element.getAttribute('data-work-node'), sessionId: element.getAttribute('data-work-session'), phase: element.getAttribute('data-phase'),
      })))
      assert.deepEqual(displayed, rows.map(row => ({ nodeId: row.nodeId, sessionId: row.sessionId, phase: 'closed' })),
        'The actual team panel must retain both exact closed sessions')
      assert.equal(await finished.locator('[data-team="stop"]').isEnabled(), false)
      return { rows: displayed, stopEnabled: false }
    })
    await sameRoot(context, parent)
    await context.capture('native-bounded-parent-and-member-stopped')
  } },
]

module.exports = { scenarios, assertNativeWorkEvidence }
