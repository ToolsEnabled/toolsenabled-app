'use strict'

// Native extensions for the pre-cut function inventory. All mutations below
// are visible inputs; the only filesystem writes stay in this run's QA folder.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { rootCard, childCard, input, navigate, openConversation, exactAgentReply, palette, send } = require('./page2-native-scenarios.cjs')

async function computers(context) {
  if (new URL(context.page.url()).hash !== '#/computers') await navigate(context, 'computers')
}
async function freshComputers(context) {
  await navigate(context, 'metrics')
  await navigate(context, 'computers')
}
async function detail(context) {
  if (new URL(context.page.url()).hash.startsWith('#/agent/')) return
  await freshComputers(context)
  const open = context.page.locator('.graph-open-btn')
  await open.waitFor()
  assert.notEqual(await open.getAttribute('aria-disabled'), 'true', 'A fresh fleet view must expose its declared-agent detail door')
  await open.click()
  await context.page.waitForURL(url => url.hash.startsWith('#/agent/'))
  await context.page.locator('.agentv[data-live-mode="live"]').waitFor()
}
const selectedAgent = context => context.page.locator('.ar-card.is-selected')

async function savedNode(context, id) {
  const node = await context.page.evaluate(nodeId => {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const saved = JSON.parse(localStorage.getItem(key))
      const node = saved?.nodes?.find(node => node.id === nodeId)
      if (node) return node
    }
    return null
  }, id)
  assert.ok(node?.id && node.sessionId, 'The selected saved node must retain its session identity')
  return node
}
function sessionRecords(context) {
  return fs.readFileSync(path.join(context.paths.userData, 'agent-spawn-records.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
}
async function sessionSnapshot(context) {
  const file = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
  const ledgerBefore = fs.readFileSync(file)
  const history = await context.page.evaluate(() => window.mcAgent.history({ limit: 200 }))
  const ledgerAfter = fs.readFileSync(file)
  return { history, ledgerBefore, ledgerAfter }
}
function assertVerifiedSessionSnapshot({ history, ledgerBefore, ledgerAfter }) {
  assert.equal(history?.ok, true, 'The native session history must be readable')
  assert.equal(history.verified, true, 'The native recorder must verify the history used for replacement credit')
  assert.ok(Buffer.isBuffer(ledgerBefore) && Buffer.isBuffer(ledgerAfter) && ledgerBefore.equals(ledgerAfter),
    'The exact owned ledger bytes must remain unchanged around the real history verification')
  const records = ledgerBefore.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(history.total, records.length, 'The verified history must describe this exact ledger record count')
  // The maintained history API deliberately exposes no hashes, signatures or
  // details. Bind its entire returned projection to the unchanged byte snapshot;
  // this is API consistency evidence, not a new hash attestation from the host.
  const projected = records.slice(-200).reverse().map(row => ({
    sequence: row.sequence, at: row.at, action: row.action, sessionId: row.sessionId,
    principal: row.principal ?? null, outcome: row.outcome ?? null, usage: row.usage ?? null, end: row.end ?? null,
  }))
  assert.deepEqual(history.entries, projected, 'Every verified history entry must match the exact owned ledger snapshot')
  return { records, ledgerSha256: crypto.createHash('sha256').update(ledgerBefore).digest('hex'), verifiedHistoryTotal: history.total }
}
function assertReplacementEvidence({ history, ledgerBefore, ledgerAfter, before, after, parentBefore, parentAfter, priorStartSequences }) {
  const { records, ledgerSha256, verifiedHistoryTotal } = assertVerifiedSessionSnapshot({ history, ledgerBefore, ledgerAfter })
  const verifiedSequences = new Set(history.entries.map(row => row.sequence))
  for (const field of ['id', 'parentId', 'treeId', 'role', 'tier', 'effort']) {
    assert.equal(after[field], before[field], `Recovery must retain the saved child's ${field}`)
  }
  assert.ok(before.sessionId && after.sessionId && before.sessionId !== after.sessionId, 'Recovery must produce a different actual child session')
  assert.equal(parentAfter.id, parentBefore.id)
  assert.equal(parentAfter.sessionId, parentBefore.sessionId, 'Recovering the child must leave its parent session unchanged')
  const starts = records.filter(row => row.action === 'agent_session_start' && !priorStartSequences.includes(row.sequence))
  assert.ok(starts.length >= 1 && starts.length <= 2,
    'Recovery may make one saved-thread attempt and at most one fallback, never additional replacement attempts')
  assert.equal(new Set(starts.map(row => row.sessionId)).size, starts.length, 'Every recovery attempt must identify a distinct session')
  const attempts = starts.map(start => {
    assert.ok(verifiedSequences.has(start.sequence), 'Every replacement intent must occur in the verified history snapshot')
    assert.equal(start.details?.agentId, before.id, 'Recovery must not start an unrelated node')
    assert.ok(typeof start.sessionId === 'string' && start.sessionId.length > 0 && start.sessionId !== before.sessionId,
      'Every recovery attempt must identify a new nonempty session')
    assert.ok(Number.isSafeInteger(start.sequence) && start.sequence > 0 && /^[a-f0-9]{64}$/.test(start.eventHash || '')
      && typeof start.signature === 'string' && start.signature.length > 0, 'Every recovery intent must retain its signed receipt')
    const outcomes = records.filter(row => row.action === 'agent_session_outcome' && row.outcome?.resolves === start.sequence)
    assert.equal(outcomes.length, 1, 'Every recovery intent must have exactly one resolved outcome')
    const outcome = outcomes[0]
    assert.ok(verifiedSequences.has(outcome.sequence), 'Every replacement outcome must occur in the verified history snapshot')
    assert.equal(outcome.sessionId, start.sessionId, 'A recovery outcome must resolve the same attempted session')
    assert.equal(outcome.details?.agentId, before.id, 'A recovery outcome must resolve the original child node')
    assert.ok(Number.isSafeInteger(outcome.sequence) && outcome.sequence > start.sequence
      && /^[a-f0-9]{64}$/.test(outcome.eventHash || '') && typeof outcome.signature === 'string' && outcome.signature.length > 0,
    'Every recovery outcome must retain its later signed receipt')
    assert.ok(['started', 'refused'].includes(outcome.outcome.result), 'An unresolved or unknown recovery outcome cannot prove replacement')
    return { start, outcome }
  })
  const successful = attempts.filter(attempt => attempt.outcome.outcome.result === 'started')
  assert.equal(successful.length, 1, 'Both recovery sends must share exactly one successfully started child session')
  const { start, outcome } = successful[0]
  assert.equal(start.sessionId, after.sessionId)
  const refused = attempts.filter(attempt => attempt !== successful[0])
  for (const attempt of refused) {
    assert.equal(attempt.outcome.outcome.result, 'refused')
    assert.match(attempt.outcome.outcome.reason || '', /^[A-Z][A-Z0-9_]{1,127}$/,
      'A refused saved-thread attempt must retain its actual bounded reason')
    // savedAccountResumeRefused in the ordinary resume path forbids these
    // account refusals from becoming a transcript-seeded replacement.
    assert.ok(!['AGENT_RESUME_ACCOUNT_UNAVAILABLE', 'AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'].includes(attempt.outcome.outcome.reason),
      'A refused saved account must not silently fall back to a different session')
    assert.ok(attempt.start.sequence < attempt.outcome.sequence && attempt.outcome.sequence < start.sequence,
      'The saved-thread refusal must finish before the successful fallback starts')
  }
  return { nodeId: after.id, previousSessionId: before.sessionId, sessionId: after.sessionId,
    parentNodeId: parentAfter.id, parentSessionId: parentAfter.sessionId, startSequence: start.sequence, startHash: start.eventHash,
    outcomeSequence: outcome.sequence, outcomeHash: outcome.eventHash, ledgerSha256, verifiedHistoryTotal,
    refusedAttempts: refused.map(({ start, outcome }) => ({ sessionId: start.sessionId, startSequence: start.sequence,
      startHash: start.eventHash, outcomeSequence: outcome.sequence, outcomeHash: outcome.eventHash, reason: outcome.outcome.reason })) }
}

function assertRecoveryMessageOrder(messages, first, second) {
  const expected = [
    ['user', first], ['agent', 'PAGE2_CHILD_RECOVERY_FIRST'],
    ['user', second], ['agent', 'PAGE2_CHILD_RECOVERY_SECOND'],
  ]
  const positions = expected.map(([role, text]) => {
    const matches = messages.flatMap((message, index) => message.role === role && message.text.trim() === text ? [index] : [])
    assert.equal(matches.length, 1, 'Every recovery user message and reply must occur exactly once')
    return matches[0]
  })
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position),
    'The first recovery message and its reply must precede the second message and its reply')
  return { firstUser: positions[0], firstReply: positions[1], secondUser: positions[2], secondReply: positions[3] }
}

function assertInterruptedEvidence({ method, before, after, visibleStatus, actionVisible, actionReceipt, partialBefore = '', replyAfter }) {
  assert.ok(['slash', 'actions'].includes(method))
  assert.ok(before.id && before.sessionId, 'An interruption needs the selected child and its actual session identity')
  assert.equal(after.id, before.id, 'The interruption must settle the selected child')
  assert.equal(after.sessionId, before.sessionId, 'The interruption must settle the same still-open child session')
  assert.equal(after.status, 'interrupted', 'A finished, failed or still-running turn is not a confirmed user interruption')
  assert.equal(visibleStatus, 'stopped by you', 'The actual selected chat must visibly confirm the user interruption')
  if (method === 'actions') {
    assert.equal(actionVisible, true, 'The Actions interruption receipt must remain visible in its real popup')
    assert.equal(actionReceipt, 'Interrupted.', 'Actions must show its accepted interruption sentence')
  }
  assert.ok(typeof replyAfter === 'string' && replyAfter.trim(), 'The interrupted turn must retain its completed transcript entry')
  const words = value => value.replace(/\s+/g, ' ').trim()
  if (partialBefore.trim()) assert.ok(words(replyAfter).startsWith(words(partialBefore)), 'Interrupt must preserve already-visible partial reply text')
  return { method, nodeId: after.id, sessionId: after.sessionId, status: after.status, visibleStatus,
    actionReceipt: method === 'actions' ? actionReceipt : null, partialCharacters: partialBefore.length, replyCharacters: replyAfter.length }
}

async function interruptedTurn(context, method, marker) {
  await computers(context)
  await openConversation(context, context.state.childId)
  const card = childCard(context)
  const before = await savedNode(context, context.state.childId)
  const starts = sessionRecords(context).filter(row => row.action === 'agent_session_start').map(row => row.sequence)
  const repliesBefore = await card.locator('.msg.them .chat-msg-text').count()
  await send(context, card, 'For this native interruption check, write 500 numbered lines, each with its number and the words owned interruption check. Do not run tools, change files or start agents.')
  await card.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor()
  const partial = await card.locator('.msg.them[aria-busy="true"] .chat-msg-text').allTextContents()
  assert.ok(partial.length <= 1, 'The selected child must have at most one streaming reply')
  if (method === 'slash') await send(context, card, '/interrupt')
  else await palette(context, card, 'Interrupt the running turn')
  await card.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden' })
  const status = card.locator('[data-chat-header-status]')
  await status.filter({ hasText: /^stopped by you$/ }).waitFor()
  const actionOut = card.locator('.chat-actions-out')
  if (method === 'actions') await actionOut.filter({ hasText: /^Interrupted\.$/ }).waitFor()
  assert.equal(await card.locator('.msg.them .chat-msg-text').count(), repliesBefore + 1,
    'The interrupted provider turn must add exactly one completed reply to this child conversation')
  await context.step(`${method}-interrupt-confirmed`, async () => assertInterruptedEvidence({
    method, before, after: await savedNode(context, before.id), visibleStatus: await status.innerText(),
    actionVisible: method === 'actions' && await actionOut.isVisible(),
    actionReceipt: method === 'actions' ? await actionOut.innerText() : null,
    partialBefore: partial[0] || '', replyAfter: await card.locator('.msg.them .chat-msg-text').last().textContent(),
  }))
  assert.doesNotMatch(await card.locator('.chat-queue-strip').innerText(), /\/interrupt/)
  assert.equal((await savedNode(context, before.id)).sessionId, before.sessionId, 'Interrupt must keep the selected child session open')
  await context.step(`${method}-interrupt-return-to-composer`, async () => {
    const actions = card.locator('[data-chat-actions]')
    // Actions Interrupt retains its result in the popup. Slash Interrupt never
    // opens that popup; a stray Escape there would close the conversation.
    assert.equal(await actions.getAttribute('aria-expanded'), method === 'actions' ? 'true' : 'false')
    if (method === 'actions') await context.page.keyboard.press('Escape')
    await card.locator('.chat-actions-pop').waitFor({ state: 'detached' })
    assert.equal(await actions.getAttribute('aria-expanded'), 'false')
    await input(card).waitFor()
  })
  await send(context, card, `Do not use tools, change files, or start agents. Return exactly the text between the angle brackets, omitting the brackets and adding no punctuation or other words: <${marker}>`)
  await exactAgentReply(context, before.id, marker)
  assert.equal(await card.locator('.msg.them .chat-msg-text').filter({ hasText: new RegExp(`^${marker}$`) }).count(), 1)
  assert.equal((await savedNode(context, before.id)).sessionId, before.sessionId, 'The next provider reply must use the same interrupted session')
  assert.deepEqual(sessionRecords(context).filter(row => row.action === 'agent_session_start').map(row => row.sequence), starts,
    'Interrupt and its follow-up must not create a replacement session')
}

const scenarios = [
  { id: 'account-menu-open', title: 'Open the actual provider account menu without changing the selected account', controls: ['account.menu.open'], requires: ['setup'], async run(context) {
    await computers(context)
    const trigger = context.page.locator('.acct-trigger')
    context.state.functionsAccountLabel = await trigger.innerText()
    await trigger.click()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
    await context.page.locator('[data-acct="close"]').waitFor()
    assert.equal(await trigger.innerText(), context.state.functionsAccountLabel)
  } },
  { id: 'account-menu-escape', title: 'Escape closes the account menu and returns keyboard focus to its trigger', controls: ['account.menu.escape'], requires: ['account-menu-open'], async run(context) {
    await context.page.keyboard.press('Escape')
    const trigger = context.page.locator('.acct-trigger')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    assert.equal(await trigger.innerText(), context.state.functionsAccountLabel)
  } },
  { id: 'account-menu-close', title: 'The account menu Close button preserves selection and returns focus', controls: ['account.menu.close'], requires: ['account-menu-escape'], async run(context) {
    const trigger = context.page.locator('.acct-trigger')
    await trigger.click()
    await context.page.locator('[data-acct="close"]').click()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    assert.equal(await trigger.innerText(), context.state.functionsAccountLabel)
  } },
  { id: 'agent-detail-route', title: 'Open the real declared-agent detail page through its visible fleet door', controls: ['agent.detail.open'], requires: ['setup'], async run(context) {
    await detail(context)
    const routeId = decodeURIComponent(new URL(context.page.url()).hash.split('/')[3])
    assert.equal(await selectedAgent(context).count(), 1)
    assert.equal(await selectedAgent(context).getAttribute('data-agent-id'), routeId)
    assert.equal(await context.page.locator('.agent-provenance').getAttribute('data-kind'), 'declared')
    context.state.functionsDeclaredId = routeId
    await context.capture('native-declared-agent-route')
  } },
  { id: 'agent-detail-roster', title: 'Select another declared agent from the roster using Enter and restore the original agent', controls: ['agent.roster.enter'], requires: ['agent-detail-route'], async run(context) {
    await detail(context)
    const cards = context.page.locator('.ar-card:not(.is-selected)')
    assert.ok(await cards.count() > 0, 'This native roster check needs a second real declared seat')
    const next = await cards.first().getAttribute('data-agent-id')
    await cards.first().press('Enter')
    await context.page.waitForURL(url => decodeURIComponent(url.hash.split('/')[3]) === next)
    await context.page.locator(`.ar-card.is-selected[data-agent-id="${next}"]`).waitFor()
    await context.page.locator(`.ar-card[data-agent-id="${context.state.functionsDeclaredId}"]`).click()
    await context.page.waitForURL(url => decodeURIComponent(url.hash.split('/')[3]) === context.state.functionsDeclaredId)
    await context.page.locator(`.ar-card.is-selected[data-agent-id="${context.state.functionsDeclaredId}"]`).waitFor()
  } },
  { id: 'agent-detail-resize', title: 'Resize Chat and Controls with arrow keys and restore the recorded width', controls: ['agent.panels.resize-keyboard'], requires: ['agent-detail-route'], async run(context) {
    await detail(context)
    const handle = context.page.getByRole('separator', { name: 'Resize Chat and Controls', exact: true })
    const width = () => context.page.locator('.chat-panel').evaluate(element => element.getBoundingClientRect().width)
    const before = await width()
    await handle.press('ArrowRight')
    const larger = await width()
    assert.ok(larger > before, 'ArrowRight must actually widen the visible chat panel')
    await handle.press('ArrowLeft')
    assert.ok(Math.abs(await width() - before) <= 1, 'The opposite arrow must restore the original visible width')
    assert.equal(Number(await context.page.evaluate(() => localStorage.getItem('mc.agentv-panels.chat-w'))), await width())
  } },
  { id: 'agent-detail-file-read', title: 'Refresh the chosen QA folder and read its actual note in the native report dialog', controls: ['agent.files.folder', 'agent.files.refresh', 'agent.files.read', 'agent.files.close', 'agent.files.escape'], requires: ['agent-detail-route'], async run(context) {
    await detail(context)
    const panel = context.page.locator('[data-files-panel="agent"]')
    await panel.waitFor()
    const folders = await context.page.evaluate(() => window.mcFiles.folders())
    assert.equal(folders?.ok, true, 'The real host must enumerate the configured folder choices')
    const chosen = folders.folders.filter(folder => folder.kind === 'chosen')
    assert.equal(chosen.length, 1, 'The fresh QA profile must expose exactly its one chosen setup folder')
    const noteName = 'qa-functions-reader.txt'
    const noteText = `Owned native file reader check: ${context.paths.checkWord}.\n`
    fs.writeFileSync(path.join(context.paths.workspace, noteName), noteText, { flag: 'wx', mode: 0o600 })
    await panel.locator('[data-files-action="refresh"]').click()
    await context.select(panel.locator('[data-files-folder="chooser"]'), chosen[0].id)
    const read = panel.locator(`[data-files-action="read"][data-files-name="${noteName}"]`)
    await read.waitFor()
    await read.click()
    const dialog = context.page.getByRole('dialog', { name: noteName, exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.locator('[data-files-report]').textContent(), noteText)
    assert.equal(await panel.getAttribute('inert'), '')
    await dialog.locator('[data-files-action="close"]').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await panel.getAttribute('inert'), null)
    assert.equal(await read.evaluate(element => element === document.activeElement), true)
    await read.click()
    await dialog.waitFor()
    await context.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await read.evaluate(element => element === document.activeElement), true)
    await context.capture('native-declared-agent-file-read')
  } },
  { id: 'agent-detail-back', title: 'Return to Computers through the declared-agent breadcrumb', controls: ['agent.detail.back'], requires: ['agent-detail-route'], async run(context) {
    await detail(context)
    await context.page.locator('.agentv .graph-crumb button').click()
    await context.page.waitForURL(url => url.hash === '#/computers')
    await context.page.locator('.computers').waitFor()
    assert.equal(await context.page.locator('.agentv').count(), 0)
  } },
  { id: 'composer-send-button', title: 'Click Send once and receive one actual provider reply without an Enter submission', controls: ['chat.send.click'], requires: ['root-start'], async run(context) {
    await computers(context)
    await openConversation(context, context.state.rootId)
    const card = rootCard(context)
    const marker = 'PAGE2_NATIVE_SEND_BUTTON'
    const prompt = `Do not use tools, change files, or start agents. Return exactly the text between the angle brackets, omitting the brackets and adding no punctuation or other words: <${marker}>`
    await context.type(input(card), prompt)
    await card.getByRole('button', { name: 'Send', exact: true }).click()
    await exactAgentReply(context, context.state.rootId, marker)
    assert.equal(await card.locator('.msg.me .chat-msg-text').filter({ hasText: prompt }).count(), 1)
    assert.equal(await card.locator('.msg.them .chat-msg-text').filter({ hasText: new RegExp(`^${marker}$`) }).count(), 1)
    assert.equal(await input(card).inputValue(), '')
  } },
  { id: 'child-cold-history', title: 'Restore the saved child conversation, its own role directions and its editable draft after the real app restart', controls: ['history.child.restore'], requires: ['cold-conversation'], async run(context) {
    await computers(context)
    await openConversation(context, context.state.childId)
    const card = childCard(context)
    await exactAgentReply(context, context.state.childId, 'PAGE2_CHILD_READY')
    await exactAgentReply(context, context.state.childId, 'PAGE2_QUEUE_B_EDITED')
    assert.equal(await card.locator('.msg.me .chat-msg-text').filter({ hasText: /^This is the owner-created native QA child\./ }).count(), 1,
      'The cold child card must preserve its own original user brief exactly once')
    assert.match(await card.innerText(), /Role directions/)
    assert.doesNotMatch(await card.locator('.msg.them .chat-msg-text').allTextContents().then(texts => texts.join('\n')), /PAGE2_RESUMED_REPLY/,
      'Restoring the child must not mix in the parent replacement reply')
    await context.type(input(card), 'UNSENT_COLD_CHILD_DRAFT')
    assert.equal(await input(card).inputValue(), 'UNSENT_COLD_CHILD_DRAFT')
    context.state.functionsColdChild = await savedNode(context, context.state.childId)
    await context.capture('native-cold-child-history')
  } },
  { id: 'child-recovery-second-send', title: 'Two sends during a real dead-child reconnect share one replacement and each receive exactly one provider reply', controls: ['history.child.first-send', 'recovery.pending.second-send'], requires: ['child-cold-history'], async run(context) {
    await computers(context)
    await openConversation(context, context.state.childId)
    const card = childCard(context)
    const before = await savedNode(context, context.state.childId)
    assert.equal(before.sessionId, context.state.functionsColdChild.sessionId, 'The first send must address the child session retained from before the app restart')
    const parentBefore = await savedNode(context, context.state.rootId)
    const priorStartSequences = sessionRecords(context).filter(row => row.action === 'agent_session_start').map(row => row.sequence)
    const first = 'Reply exactly PAGE2_CHILD_RECOVERY_FIRST. Do not use tools, change files or start agents.'
    const second = 'Reply exactly PAGE2_CHILD_RECOVERY_SECOND. Do not use tools, change files or start agents.'
    const reconnect = card.locator('.chat-msg-text').filter({ hasText: /^That agent’s session had ended\. Bringing it back now…$/ })
    const count = await reconnect.count()
    await send(context, card, first)
    await reconnect.nth(count).waitFor()
    await context.step('child-second-send-while-replacement-pending', async () => {
      await context.type(input(card), second)
      if ((await savedNode(context, before.id)).sessionId !== before.sessionId) {
        context.unavailable('The natural replacement window closed before the second input; concurrent recovery has not been exercised')
      }
      const submittedAt = new Date().toISOString()
      await input(card).press('Enter')
      if ((await savedNode(context, before.id)).sessionId !== before.sessionId) {
        context.unavailable('The replacement connected during the second input; pending-recovery acceptance cannot be proved')
      }
      await card.locator('.chat-queue-strip').getByText(second, { exact: true }).waitFor()
      assert.doesNotMatch(await card.innerText(), /this message was not sent\. Sending again cannot reach it/,
        'The second pending-recovery send must be queued instead of receiving the dead-session refusal')
      return { nodeId: before.id, pendingSessionId: before.sessionId, submittedAt, pendingBeforeAndAfterInput: true, queued: true }
    })
    for (const marker of ['PAGE2_CHILD_RECOVERY_FIRST', 'PAGE2_CHILD_RECOVERY_SECOND']) {
      await exactAgentReply(context, before.id, marker)
      assert.equal(await card.locator('.msg.them .chat-msg-text').filter({ hasText: new RegExp(`^${marker}$`) }).count(), 1,
        'Each queued recovery message must receive exactly one completed provider reply')
    }
    for (const prompt of [first, second]) {
      assert.equal(await card.locator('.msg.me .chat-msg-text').allTextContents().then(texts => texts.filter(text => text.trim() === prompt).length), 1,
        'Recovery must not duplicate a submitted user message in the restored transcript')
    }
    await context.step('child-recovery-preserves-send-order', async () => assertRecoveryMessageOrder(
      await card.locator('.msg.me, .msg.them').evaluateAll(elements => elements.map(element => ({
        role: element.classList.contains('me') ? 'user' : 'agent',
        text: element.querySelector('.chat-msg-text')?.textContent || '',
      }))), first, second))
    assert.equal(await card.locator('.chat-queue-strip').getByRole('button', { name: 'Remove this waiting message', exact: true }).count(), 0)
    await context.step('child-recovery-exact-signed-replacement', async () => assertReplacementEvidence({
      ...await sessionSnapshot(context), before,
      after: await savedNode(context, before.id), parentBefore, parentAfter: await savedNode(context, parentBefore.id), priorStartSequences,
    }))
    await context.capture('native-child-recovery-second-send')
  } },
  { id: 'slash-interrupt-busy', title: 'Use /interrupt on the working child and receive its next provider reply in the same session', controls: ['slash.interrupt'], requires: ['child-recovery-second-send'], async run(context) {
    await interruptedTurn(context, 'slash', 'PAGE2_CHILD_AFTER_SLASH_INTERRUPT')
    await context.capture('native-slash-interrupt-busy')
  } },
  { id: 'actions-interrupt-busy', title: 'Use Actions Interrupt on the working child and receive its next provider reply in the same session', controls: ['actions.interrupt'], requires: ['child-recovery-second-send'], async run(context) {
    await interruptedTurn(context, 'actions', 'PAGE2_CHILD_AFTER_ACTIONS_INTERRUPT')
    await context.capture('native-actions-interrupt-busy')
  } },
]

module.exports = { scenarios, assertReplacementEvidence, assertVerifiedSessionSnapshot, assertRecoveryMessageOrder, assertInterruptedEvidence, detail }
