"use strict"

// Actual UI actions and read-only observations in the existing native runner.
// Host transcript acceptance is not a provider-wire capture. No bridge method,
// provider reply, persisted conversation or clock is replaced by this cohort.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { navigate, openNewTree, openConversation, rootCard, input, send, exactAgentReply } = require('./page2-native-scenarios.cjs')
const SEND_NOW = 'Send this message now, even if that means stopping what the agent is writing to do it'
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const marker = () => 'NATIVE_' + crypto.randomBytes(8).toString('hex').toUpperCase()

async function nodeIdentity(context) {
  const value = await context.page.evaluate(id => {
    const matches = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const state = JSON.parse(localStorage.getItem(key))
      const node = state?.nodes?.find(row => row.id === id)
      if (node) matches.push({ computerId: state.computerId, ...node })
    }
    return matches
  }, context.state.rootId)
  assert.equal(value.length, 1, 'Observe exactly the selected native QA node')
  return value[0]
}
async function transcript(context) {
  const node = await nodeIdentity(context)
  return context.page.evaluate(async ({ computerId, id }) => {
    if (typeof window.mcTranscripts?.read !== 'function') throw new Error('The native transcript reader is unavailable')
    let before = null
    const pages = []
    for (let count = 0; count < 20; count++) {
      const result = await window.mcTranscripts.read({ computerId, nodeId: id, limit: 100, ...(before ? { before, strictBefore: true } : {}) })
      if (!result?.ok || !Array.isArray(result.entries)) throw new Error('The native transcript read was not confirmed')
      pages.unshift(result.entries)
      if (!result.before) return pages.flat()
      if (result.before === before) throw new Error('The native transcript cursor did not advance')
      before = result.before
    }
    throw new Error('The bounded native transcript observation was exceeded')
  }, node)
}
function acceptedTurns(entries) {
  const seen = new Set()
  return entries.filter(row => {
    if (!row.turnStamp || row.promptKind || !['you', 'action'].includes(row.who)
      || (row.who === 'action' && row.kind !== 'automatic')) return false
    if (seen.has(row.turnStamp)) return false
    seen.add(row.turnStamp)
    return true
  })
}
const CONTEXT_ORDER = Object.freeze(['tasks', 'history', 'tree', 'requests', 'role', 'tools', 'capabilities'])
function assertCapturedContext(entries, turn) {
  const context = entries.filter(row => row.turnStamp === turn.turnStamp && row.promptKind)
  assert.ok(context.length <= CONTEXT_ORDER.length, 'The captured turn must retain the seven-kind bound')
  assert.ok(context.every(row => row.promptSource === 'toolsenabled' && row.who === 'you'
    && typeof row.text === 'string' && row.text.length > 0), 'Captured additions must remain labeled product context')
  const kinds = context.map(row => row.promptKind)
  assert.equal(new Set(kinds).size, kinds.length, 'A context kind cannot appear twice in the same accepted turn')
  assert.deepEqual(kinds, CONTEXT_ORDER.filter(kind => kinds.includes(kind)),
    'Captured optional additions must retain actual host ordering and known kind labels')
  return context
}
function assertIntent(entries, text, task) {
  const first = acceptedTurns(entries)[0]
  assert.ok(first, 'The native host must record the first accepted turn')
  assert.equal(first.who, 'you', 'An automatic transcript seed cannot precede the initiating person message')
  assert.ok(first.text.includes(text), 'The first accepted turn must contain the original initiating message')
  const context = assertCapturedContext(entries, first)
  if (task) {
    assert.ok(context.some(row => row.promptKind === 'tasks' && row.promptSource === 'toolsenabled' && row.text.includes(task.id) && row.text.includes(task.words) && /^Current relevant T tasks/.test(row.text)),
      'The first accepted turn must retain the current relevant T record and its actual contents')
  }
  return first
}

async function beginObservation(context, label, expected) {
  return context.page.evaluateHandle(({ nodeId, label, expected, sendNow }) => {
    const record = { label, nodeId, click: null, feedback: null, visible: null, events: [], overflow: false }
    const stamp = () => ({ epochMs: Date.now(), monotonicMs: performance.now() })
    const card = () => document.querySelector(`.tree-conversation[data-agent-id="${nodeId}"]`)
    const initialNotes = card()?.querySelector('.chat-status-note')?.textContent || ''
    let trigger = null
    const observe = () => {
      if (!record.click) return
      const root = card()
      const note = root?.querySelector('.chat-status-note')?.textContent || ''
      if (!record.feedback && (trigger?.disabled || (note && note !== initialNotes))) {
        record.feedback = { ...stamp(), basis: trigger?.disabled ? 'clicked-control-disabled' : 'changed-status-note', text: note }
      }
      if (!record.visible && root) {
        const text = [...root.querySelectorAll('.msg.them .chat-msg-text')].map(row => row.textContent.trim())
          .find(text => text.length >= 3 && (expected.startsWith(text) || text.startsWith(expected)))
        if (text) record.visible = { ...stamp(), text }
      }
    }
    const clicked = event => {
      const button = event.target.closest?.('button')
      if (!event.isTrusted || !button || record.click) return
      const start = label === 'startup' && button.textContent.trim() === 'Start tree'
      const now = label !== 'startup' && card()?.contains(button) && button.getAttribute('aria-label') === sendNow
      if (!start && !now) return
      trigger = button
      record.click = stamp()
      observe()
    }
    document.addEventListener('click', clicked, true)
    const observer = new MutationObserver(observe)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    const unsubscribe = window.mcAgent.onEvent(packet => {
      if (!record.click) return
      if (record.events.length >= 2000) { record.overflow = true; return }
      const event = packet?.event || {}
      record.events.push({ ...stamp(), sessionId: packet?.sessionId, type: event.type,
        turnId: event.turnId || null, status: event.status || null, productNote: event.productNote === true,
        text: typeof event.text === 'string' ? event.text.slice(0, 300) : null })
    })
    return { record, dispose() { observer.disconnect(); unsubscribe(); document.removeEventListener('click', clicked, true) } }
  }, { nodeId: context.state.rootId, label, expected, sendNow: SEND_NOW })
}
function observationReceipt(observed, entries, targetText, name) {
  assert.ok(observed.click, 'A trusted click on the actual named control must be observed')
  assert.equal(observed.overflow, false, 'Event overflow cannot earn latency coverage')
  // The marker uniquely identifies this submission. row.at can be overwritten
  // by attachment enrichment; it cannot establish admission time or turn order.
  const target = acceptedTurns(entries).find(row => row.text.includes(targetText)) || null
  const publicEvent = target && observed.events.find(row => row.turnId === target.turnStamp
    && row.type === 'assistant_text_delta' && !row.productNote && row.text)
  return { schemaVersion: 2, name, observed, entries,
    targetCapturedTurn: target, targetCaptureUpsertEpochMs: target?.at ?? null,
    firstHostAcceptance: { observed: false, reason: 'The stable transcript entry is upserted after host acceptance; its timestamp is not an immutable admission receipt.' },
    firstTargetPublicEvent: publicEvent || null,
    firstTargetPublicEventMs: publicEvent ? publicEvent.monotonicMs - observed.click.monotonicMs : null,
    producerToCaptureCompleteness: { observed: false, reason: 'The separate original host additions are not exposed by this native observer; capture order/labels are checked without inferring omitted kinds.' },
    providerWirePayload: { observed: false, reason: 'This observer reads the shipping accepted-prompt capture, not the provider transport.' },
    feedbackMs: observed.feedback ? observed.feedback.monotonicMs - observed.click.monotonicMs : null,
    firstExpectedVisibleMs: observed.visible ? observed.visible.monotonicMs - observed.click.monotonicMs : null }
}
async function finishObservation(context, handle, name, entries, targetText) {
  let observed
  try { observed = await handle.evaluate(value => { value.dispose(); return value.record }) }
  finally { await handle.dispose() }
  const receipt = observationReceipt(observed, entries, targetText, name)
  const file = path.join(context.paths.qaRoot, name + '.json')
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  context.report.event({ kind: 'continuation-observation', name, file, sha256: sha(fs.readFileSync(file)),
    feedbackMs: receipt.feedbackMs, firstExpectedVisibleMs: receipt.firstExpectedVisibleMs,
    providerWireObserved: false, firstHostAcceptanceObserved: false,
    acceptedPromptCaptured: Boolean(receipt.targetCapturedTurn) })
  return receipt
}


async function waitAccepted(context, text) {
  const deadline = Date.now() + 30000
  let entries
  do {
    entries = await transcript(context)
    if (acceptedTurns(entries).some(row => row.text.includes(text))) return entries
    await context.page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return entries
}
async function fileNativeTask(context, words) {
  await navigate(context, 'ledger')
  await context.page.locator('[data-mode="T"]').click()
  const form = context.page.locator('[data-file-kind="T"]')
  await form.waitFor()
  await context.select(form.locator('[data-file-scope]'), 'global')
  await context.type(form.locator('[data-file-words]'), words)
  await form.locator('[data-ledger-file]').click()
  await context.page.locator('.ledger-record').filter({ hasText: words }).waitFor()
  const ledger = await context.page.evaluate(() => window.mcAgent.ledger({ scope: 'all', kind: 'T', removed: false }))
  assert.equal(ledger?.ok, true)
  const rows = ledger.records.filter(row => row.kind === 'T' && [row.words, row.verbatim].includes(words))
  assert.equal(rows.length, 1, 'Read back the exact task filed through the native Ledger form')
  assert.match(rows[0].id, /^T\d+$/)
  return { id: rows[0].id, words, status: rows[0].status }
}
async function createController(context, brief) {
  await navigate(context, 'computers')
  await openNewTree(context)
  await context.select(context.page.locator('[data-compose-field="role"]'), 'controller')
  await context.select(context.page.locator('[data-compose-field="tier"]'), 'luna')
  await context.select(context.page.locator('[data-compose-field="effort"]'), 'medium')
  await context.type(context.page.locator('[data-compose-field="message"]'), brief)
  const before = await context.page.locator('.static-tree-node').evaluateAll(rows => rows.map(row => row.dataset.agentId))
  await context.page.locator('[data-compose-action="set"]').click()
  await context.page.waitForFunction(known => [...document.querySelectorAll('.static-tree-node')].some(row => !known.includes(row.dataset.agentId)), before)
  const added = await context.page.locator('.static-tree-node').evaluateAll((rows, known) => rows.map(row => row.dataset.agentId).filter(id => !known.includes(id)), before)
  assert.equal(added.length, 1)
  context.state.rootId = added[0]
}
async function stopVisibleReply(context) {
  const stop = rootCard(context).locator('[data-chat-chip="halt"]')
  if (await stop.isVisible()) {
    await stop.click()
    await stop.waitFor({ state: 'hidden', timeout: 90000 })
  }
}
async function attachTwo(context, files = [context.paths.imageA, context.paths.imageB]) {
  const card = rootCard(context)
  for (const file of files) {
    await card.locator('[data-chat-attach]').click()
    await context.picker({ operation: 'select-path', title: 'Attach an image to this message', selectedPath: file })
    await card.getByRole('button', { name: new RegExp('Remove ' + path.basename(file)) }).waitFor()
  }
  const names = await card.getByRole('button', { name: /Remove qa-image-/ }).evaluateAll(rows => rows.map(row => row.getAttribute('aria-label') || row.title || row.textContent))
  context.report.event({ kind: 'native-ordered-images', files: files.map(file => ({ name: path.basename(file), sha256: sha(fs.readFileSync(file)) })), displayed: names })
}

function assertDurableImageCapture(evidence, expectedImages, captured) {
  const { entry, records } = evidence
  assert.ok(entry && Array.isArray(entry.imageReceipts) && entry.imageReceipts.length, 'Observe the durable envelope and its image receipts')
  assert.equal(records.length, entry.imageReceipts.length)
  const descriptors = [], summaries = []
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
  records.forEach((record, position) => {
    const ref = entry.imageReceipts[position]
    assert.equal(record.id, ref.id, 'Reopened custody must match the observed envelope receipt')
    assert.equal(record.state, 'retained')
    assert.equal(record.automaticSend, false)
    assert.equal(record.images.length, ref.imageCount)
    record.images.forEach((image, index) => {
      assert.equal(image.index, index, 'Custody image indices must retain submission order')
      assert.ok(extensions[image.mime], 'The custody format must be known')
      descriptors.push({ sha256: image.sha256, size: image.size })
      summaries.push({ name: record.id + '-' + index + '.' + extensions[image.mime], bytes: image.size })
    })
  })
  assert.deepEqual(descriptors, expectedImages, 'Reopened custody must retain the two distinct submitted byte hashes in order')
  if (captured) {
    assert.equal(entry.state, 'accepted', 'A captured image turn requires a confirmed durable acceptance state')
    assert.equal(captured.text, entry.text)
    assert.deepEqual(captured.attachments, summaries, 'Captured attachment names/count/order must match issued custody identities')
  }
  return { descriptors, summaries }
}
async function readImageEvidence(context, text) {
  const node = await nodeIdentity(context)
  return context.page.evaluate(async ({ sessionId, text }) => {
    const ownerContext = await window.mcAgent.ownerContext()
    const bound = await window.mcAgent.imageQueue({ operation: 'binding', ownerContext, sessionId })
    if (!bound?.ok || bound.result?.sessionId !== sessionId) throw new Error('The image conversation binding is unavailable')
    const conversationId = bound.result.conversationId
    const request = { ownerContext, conversationId }
    const read = await window.mcAgent.imageQueue({ ...request, operation: 'read' })
    if (!read?.ok || !Array.isArray(read.result?.entries)) throw new Error('The durable image outbox cannot be read')
    const matches = read.result.entries.filter(row => row.text === text)
    if (!matches.length) return null
    if (matches.length !== 1) throw new Error('The image submission was duplicated')
    const entry = matches[0], records = []
    for (const receipt of entry.imageReceipts) {
      const value = await window.mcAgent.imageQueue({ ...request, operation: 'reopen', receipt })
      if (!value?.ok || value.result?.conversationId !== conversationId) throw new Error('The image custody receipt cannot be reopened')
      records.push(value.result)
    }
    return { conversationId, generation: read.result.generation, entry, records }
  }, { sessionId: node.sessionId, text })
}
async function observeDurableImages(context) {
  const card = rootCard(context)
  // This is a separate ordinary image submission, after the measured text turn.
  // No image-row Send now control exists. Do not qualify image interruption or
  // recovery from these text-only scenarios.
  const expected = marker(), text = `Reply exactly ${expected}. This separate message has two images. Do not run tools or start agents.`
  const files = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
  ].map((bytes, index) => {
    const file = path.join(context.paths.qaRoot, 'qa-image-continuation-' + index + '.png')
    fs.writeFileSync(file, Buffer.from(bytes, 'base64'), { flag: 'wx', mode: 0o600 })
    return file
  })
  const fixtureImages = files.map(file => {
    const bytes = fs.readFileSync(file)
    return { sha256: sha(bytes), size: bytes.length }
  })
  assert.notEqual(fixtureImages[0].sha256, fixtureImages[1].sha256, 'Order proof requires distinguishable fixture images')
  await attachTwo(context, files)
  await send(context, card, text)
  await context.page.waitForFunction(nodeId => {
    const card = document.querySelector(`.tree-conversation[data-agent-id="${nodeId}"]`)
    return card?.querySelector('.chat-input input')?.value === ''
  }, context.state.rootId)
  const draft = 'IMAGE_UNSENT_' + marker()
  await context.type(input(card), draft)
  let evidence = await readImageEvidence(context, text)
  assert.ok(evidence, 'Composer admission must be visible in the actual durable outbox')
  assertDurableImageCapture(evidence, fixtureImages)
  context.report.event({ kind: 'continuation-image-custody', phase: 'admitted', evidence, fixtureImages,
    imageSendNow: { observed: false, reason: 'Saved image rows expose Refresh and Unqueue, not Send now.' },
    imageRecoveryObserved: false, providerWireObserved: false })
  await exactAgentReply(context, context.state.rootId, expected)
  let entries, captured
  const deadline = Date.now() + 30000
  do {
    entries = await transcript(context)
    captured = acceptedTurns(entries).find(row => row.text === text && row.attachments?.length === 2)
    evidence = await readImageEvidence(context, text)
    if (captured && evidence?.entry.state === 'accepted') break
    await context.page.waitForTimeout(100)
  } while (Date.now() < deadline)
  assert.ok(captured, 'Wait for attachment enrichment of the captured image turn')
  assert.equal(acceptedTurns(entries).filter(row => row.text === text).length, 1, 'The durable image message must be captured once')
  const identity = assertDurableImageCapture(evidence, fixtureImages, captured)
  assert.equal(await input(card).inputValue(), draft, 'Image delivery must preserve its independent unsent draft')
  context.report.event({ kind: 'continuation-image-custody', phase: 'accepted', evidence, identity,
    capturedTurn: captured.turnStamp, captureUpsertEpochMs: captured.at, firstHostAcceptanceObserved: false,
    providerWireObserved: false, imageRecoveryObserved: false })
}

async function queuedScenario(context, { afterStop = false, ended = false } = {}) {
  let card = rootCard(context)
  await openConversation(context, context.state.rootId)
  await stopVisibleReply(context)
  const expected = marker()
  const text = `Reply exactly ${expected}. Inspect task ${context.state.continuationTask.id} as context only. Do not run tools or start agents.`
  await send(context, card, 'Write 1000 numbered lines, each saying native interruption check. Do not use tools, change files or start agents.')
  const stop = card.locator('[data-chat-chip="halt"]')
  await stop.waitFor()
  if (!await stop.isVisible()) context.unavailable('The real provider finished before text Send now could be tested while busy')
  await send(context, card, text)
  let queueRow = card.locator('.chat-queue-row').filter({ hasText: text })
  await queueRow.waitFor()
  const draft = 'UNSENT_' + marker()
  await context.type(input(card), draft)
  const before = await nodeIdentity(context)
  const beforeRows = await card.locator('.chat-queue-row').allTextContents()
  const priorTurns = new Set(acceptedTurns(await transcript(context)).map(row => row.turnStamp))
  if (ended) {
    await context.close()
    await context.open()
    await navigate(context, 'computers')
    await openConversation(context, context.state.rootId)
    card = rootCard(context)
    queueRow = card.locator('.chat-queue-row').filter({ hasText: text })
    await queueRow.waitFor()
    assert.equal(await input(card).inputValue(), draft, 'Reopening the app must retain the unsent draft')
  } else if (afterStop) {
    assert.equal(await stop.isVisible(), true, 'The explicit Stop control must still represent a real active turn')
    await stop.click()
    await stop.waitFor({ state: 'hidden', timeout: 90000 })
  } else if (!await stop.isVisible()) context.unavailable('Busy Send now was not exercised: the actual provider turn already ended')
  const label = ended ? 'ended-send' : afterStop ? 'after-stop-send-now' : 'busy-send-now'
  const observation = await beginObservation(context, label, expected)
  let entries = [], receipt
  try {
    await queueRow.getByRole('button', { name: SEND_NOW, exact: true }).click()
    await exactAgentReply(context, context.state.rootId, expected)
    entries = await waitAccepted(context, text)
  } finally {
    if (!entries.length) entries = await transcript(context).catch(() => [])
    receipt = await finishObservation(context, observation, label, entries, text)
  }
  const accepted = acceptedTurns(entries).filter(row => row.text === text)
  assert.equal(accepted.length, 1, 'The exact queued message must be accepted once')
  assertCapturedContext(entries, accepted[0])
  assert.equal(accepted[0].attachments?.length || 0, 0, 'Text Send now is measured separately from durable image delivery')
  assert.equal(await input(card).inputValue(), draft, 'Send now must preserve the independent unsent draft')
  const after = await nodeIdentity(context)
  if (ended) {
    assert.notEqual(after.sessionId, before.sessionId, 'An ended host session must use an observed successor')
    const freshTurns = acceptedTurns(entries).filter(row => !priorTurns.has(row.turnStamp))
    assert.equal(freshTurns[0]?.text, text, 'Recovery must admit original queued intent before any automatic history turn')
    assert.equal(freshTurns[0]?.who, 'you')
    assertIntent(entries.filter(row => !priorTurns.has(row.turnStamp)), text, context.state.continuationTask)
  }
  assert.equal(after.id, before.id)
  assert.equal(after.treeId, before.treeId)
  assert.equal(await queueRow.count(), 0, 'The admitted queue row must be consumed once')
  context.report.event({ kind: 'continuation-custody', name: label, before, after, queuedBefore: beforeRows,
    draft, acceptedTurn: accepted[0].turnStamp, explicitStop: afterStop,
    captureUpsertEpochMs: accepted[0].at, firstHostAcceptanceObserved: false, clickEpochMs: receipt.observed.click.epochMs,
    recovery: ended ? { observed: true, source: before.sessionId, successor: after.sessionId,
      mechanism: 'Observed ordinary app-reopen recovery; native-thread resume versus transcript fallback requires provider evidence.' } : null })
  context.state.continuationLastText = text
}

const scenarios = [
  { id: 'continuation-session-ready', title: 'Start a real Controller from native controls and retain first-turn timing observations', controls: ['C04', 'C05', 'C06', 'C11', 'C12'], requires: ['setup'], async run(context) {
    if (!context.options.realProvider) context.unavailable('This cohort requires the explicitly selected real provider')
    const tag = marker()
    const task = await fileNativeTask(context, `Native acceptance task ${tag}: inspect first-turn message and context ordering. This is saved task data; do not run tools or start agents.`)
    const expected = marker()
    const brief = `Reply exactly ${expected}. Inspect task ${task.id} as context only. Do not use tools, change files or start agents.`
    await createController(context, brief)
    context.state.continuationTask = task
    context.state.continuationBrief = brief
    const observation = await beginObservation(context, 'startup', expected)
    let entries = []
    try {
      await context.page.getByRole('button', { name: 'Start tree', exact: true }).click()
      await context.page.getByText('Open conversation', { exact: true }).first().click()
      await exactAgentReply(context, context.state.rootId, expected)
      entries = await waitAccepted(context, brief)
    } finally {
      if (!entries.length) entries = await transcript(context).catch(() => [])
      await finishObservation(context, observation, 'startup-intent', entries, brief)
    }
    context.state.continuationStartupEntries = entries
  } },
  { id: 'continuation-startup-intent', title: 'First native accepted turn contains the initiating message and current task data', controls: [], requires: ['continuation-session-ready'], async run(context) {
    assertIntent(context.state.continuationStartupEntries, context.state.continuationBrief, context.state.continuationTask)
  } },
  { id: 'continuation-busy-send-now', title: 'Click real text Send now with an independent draft; separately observe durable two-image delivery', controls: ['H11'], requires: ['continuation-session-ready'], async run(context) { await queuedScenario(context); await observeDurableImages(context) } },
  { id: 'continuation-after-stop-send-now', title: 'Measure real Send now after explicit Stop separately from the busy path', controls: ['H11'], requires: ['continuation-session-ready'], run: context => queuedScenario(context, { afterStop: true }) },
  { id: 'continuation-ended-send', title: 'Reopen the closed QA app and recover queued text with transcript, task and draft custody', controls: ['H11', 'P22'], requires: ['continuation-session-ready'], run: context => queuedScenario(context, { ended: true }) },
]

module.exports = { scenarios, acceptedTurns, assertIntent, assertCapturedContext, observationReceipt, assertDurableImageCapture }
