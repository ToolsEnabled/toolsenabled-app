'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { observeOverview, beginObservedStart, finishObservedStart } = require('./page2-native-state-evidence.cjs')
const { captureComposeBaseline, assertComposeUnchanged } = require('./page2-native-compose-evidence.cjs')

const rootCard = context => context.page.locator(`.tree-conversation[data-agent-id="${context.state.rootId}"]`)
const childCard = context => context.page.locator(`.tree-conversation[data-agent-id="${context.state.childId}"]`)
const input = card => card.locator('.chat-input input')
const rail = context => context.page.locator('[data-rail-body="chat"]')
const details = context => context.page.locator('[data-rail-body="details"]')

async function navigate(context, route) {
  await context.step(`navigate-${route}`, () => context.page.locator(`nav[aria-label="Primary navigation"] a[href="#/${route}"]`).click())
  await context.page.waitForURL(url => url.hash === `#/${route}`)
}
// A fresh ordinary profile offers Home's guide after Finish. Use its real
// preference controls before subsequent route clicks; never inject dismissal.
async function quietNewPageTips(context) {
  const guide = context.page.locator('.first-use-layer:not([hidden])')
  await guide.waitFor()
  const read = () => context.page.evaluate(() => JSON.parse(localStorage.getItem('mc.set.feature_guides.v1')))
  const before = await read()
  assert.equal(before?.version, 1)
  assert.equal(before.quiet, false, 'Fresh setup must still offer new-page tips')
  const states = []
  for (const quiet of [true, false, true]) {
    await guide.getByRole('button', { name: quiet ? 'Turn off new-page tips' : 'Turn on new-page tips', exact: true }).click()
    assert.equal(await guide.locator('#first-use-preference-feedback').innerText(), quiet
      ? 'Tips are off. Use Guide to revisit any page.' : 'New-page tips are on.', 'A session-only preference refusal cannot count as a saved choice')
    assert.equal(await guide.getByRole('button', { name: quiet ? 'Turn on new-page tips' : 'Turn off new-page tips', exact: true }).isEnabled(), true,
      'The same actual preference must remain reversible')
    const saved = await read()
    assert.deepEqual(saved, { ...before, quiet }, 'Only the saved tips preference may change')
    states.push(saved)
  }
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click()
  await guide.waitFor({ state: 'hidden' })
  return { before, states, closed: true }
}
async function openControls(context, nodeId, tab = 'chat') {
  const node = context.page.locator(`.static-tree-node[data-agent-id="${nodeId}"]`)
  await node.press('Shift+Enter')
  await context.page.locator(`[data-rail-tab="${tab}"]`).click()
}
async function send(context, card, text) {
  await context.type(input(card), text)
  await input(card).press('Enter')
}
async function commandReceipt(context, card, text, expected) {
  // Local refusals can use either the status-note surface or the agent's
  // speech surface. Require a new matching receipt for this submission.
  const notes = card.locator('.msg.note, .msg.them')
  const matches = notes.filter({ hasText: expected })
  const before = await matches.count()
  await send(context, card, text)
  await matches.nth(before).waitFor()
  assert.match(await matches.nth(before).innerText(), expected, 'The newly submitted command must earn its own final receipt')
}
async function openConversation(context, nodeId) {
  const picker = context.page.locator('.tree-chat-picker')
  if (!(await picker.isVisible())) await context.page.locator('.tree-chats-toggle').click()
  await picker.waitFor()
  await context.select(picker, nodeId, { resetsAfterSelection: true })
  await context.page.locator(`.tree-conversation[data-agent-id="${nodeId}"]`).waitFor()
}
async function exactAgentReply(context, nodeId, expected, timeout = 90000) {
  // Search only the agent's message body. The same check word is commonly in
  // the person's prompt; finding it anywhere on the page would be a false pass.
  await context.page.waitForFunction(({ nodeId, expected }) => {
    const card = document.querySelector(`.tree-conversation[data-agent-id="${nodeId}"]`)
    return card && [...card.querySelectorAll('.msg.them .chat-msg-text')].some(message => message.textContent.trim() === expected)
  }, { nodeId, expected }, { timeout })
  const card = context.page.locator(`.tree-conversation[data-agent-id="${nodeId}"]`)
  await card.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden', timeout })
  assert.ok((await card.locator('.msg.them .chat-msg-text').allTextContents()).some(text => text.trim() === expected), 'The completed provider reply must still match its expected text')
}
async function palette(context, card, label) {
  await card.locator('[data-chat-actions]').click()
  await card.getByRole('option', { name: new RegExp(`^${label}`) }).click()
}
async function closePalette(card) {
  const button = card.locator('[data-chat-actions]')
  if (await button.getAttribute('aria-expanded') === 'true') await button.click()
}
async function setNode(context, { parentId = null, role, brief }) {
  if (parentId) await context.page.locator(`[data-empty-kind="child"][data-parent-id="${parentId}"]`).click()
  else await openNewTree(context)
  await context.select(context.page.locator('[data-compose-field="role"]'), role)
  await context.select(context.page.locator('[data-compose-field="tier"]'), 'astra')
  await context.select(context.page.locator('[data-compose-field="effort"]'), context.options.effort || 'max')
  await context.type(context.page.locator('[data-compose-field="message"]'), brief)
  const before = await context.page.locator('.static-tree-node').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))
  await context.page.locator('[data-compose-action="set"]').click()
  await context.page.waitForFunction(count => document.querySelectorAll('.static-tree-node').length === count + 1, before.length)
  const node = await context.page.locator('.static-tree-node').evaluateAll((nodes, known) => nodes.filter(node => !known.includes(node.dataset.agentId)).map(node => ({ id: node.dataset.agentId, parentId: node.dataset.parentId, text: node.innerText })), before)
  assert.equal(node.length, 1)
  assert.equal(node[0].parentId || null, parentId)
  return node[0].id
}
function requireProvider(context) {
  if (!context.options.realProvider) context.unavailable('This case needs --real-provider and the owning account’s existing provider sign-in')
}

async function openNewTree(context) {
  await context.page.locator('.tree-chat-add').click()
  await context.page.locator('.tree-new-tree').click()
}

function verifyFiledScope(ledger, { id, kind, scope, scopeKey, words }) {
  assert.equal(ledger?.ok, true, 'The real host must read back the filed ledger record')
  assert.equal(ledger.chain?.ok, true, 'The real ledger history must verify before a scope is credited')
  const records = ledger.records.filter(record => record.id === id)
  assert.equal(records.length, 1, 'Each filed command must retain exactly one matching record')
  const record = records[0]
  assert.equal(record.kind, kind, 'The ledger must retain the requested Request, Task or Ask family')
  assert.equal(record.scope, scope, 'The filed record must identify its requested scope')
  assert.equal(record.scopeKey ?? null, scopeKey, 'The ledger scope key must identify the exact current session or saved node')
  assert.equal(record.words, words, 'The ledger must retain the submitted command words')
  return { id, kind, scope, scopeKey }
}

const scenarios = [
  { id: 'startup', title: 'Launch the actual sandboxed Electron app with isolated state', controls: ['B01'], run: context => context.open() },
  { id: 'setup', title: 'Choose permissions and working folder through the native setup wizard', controls: ['C08'], requires: ['startup'], async run(context) {
    const page = context.page
    await page.locator(`button[data-setup-tier="${context.options.level}"]`).click()
    await page.locator('[data-setup-continue]').click()
    await page.locator('[data-setup-choose-root]').click()
    await context.picker({ operation: 'select-path', title: 'Choose a folder for your assistant to work in', selectedPath: context.paths.workspace })
    const chosenPath = page.locator('.setup-root-path')
    await chosenPath.waitFor()
    assert.equal(path.normalize(await chosenPath.innerText()), path.normalize(context.paths.workspace), 'The native chooser must return the exact intended folder, not a descendant with the same prefix')
    await page.locator('[data-setup-next="account"]').click()
    await page.locator('[data-setup-next="autonomy"]').click()
    await page.locator('button[data-setup-value="assisted"]').click()
    await page.locator('[data-setup-next="review"]').click()
    await page.locator('[data-setup-next="finish"]').click()
    await page.waitForURL(url => url.hash !== '#/setup', { timeout: 60000 })
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.setup.profile')))
    assert.deepEqual(stored?.answers?.workspaceRoots?.map(root => path.normalize(root)), [path.normalize(context.paths.workspace)], 'Finished setup must persist exactly the folder selected for this audit')
    await context.step('setup-quiet-new-page-tips', () => quietNewPageTips(context))
    await navigate(context, 'computers')
    await page.locator('.tree-chat-add').waitFor()
    assert.equal(await page.locator('[data-empty-kind="new-tree"]').count(), 0)
    assert.equal(await page.locator('.static-tree-node').count(), 0)
    await context.capture('setup-finished')
  } },
  { id: 'compose-validation', title: 'Cancel compose and refuse an empty brief without creating a node', controls: ['C03', 'C09', 'C11'], requires: ['setup'], async run(context) {
    const before = await captureComposeBaseline(context)
    await openNewTree(context)
    const set = context.page.locator('[data-compose-action="set"]')
    await context.step('compose-empty-refusal-retained-baseline', async () => {
      assert.equal(await set.isEnabled(), true, 'Set is available for an empty draft so its existing brief validation can answer')
      await set.click()
      const message = context.page.locator('[data-compose-field="message"]')
      assert.ok(await message.isVisible())
      assert.equal(await message.inputValue(), '')
      assert.equal(await message.getAttribute('aria-invalid'), 'true')
      assert.equal(await context.page.locator('[data-compose-problem="message"]').innerText(), 'Say what you want done first.')
      return assertComposeUnchanged(before, await captureComposeBaseline(context))
    })
    await context.step('compose-escape-retained-baseline', async () => {
      await context.page.keyboard.press('Escape')
      assert.equal(await context.page.locator('[data-compose-field="message"]').count(), 0)
      return assertComposeUnchanged(before, await captureComposeBaseline(context))
    })
  } },
  { id: 'root-set', title: 'Set one Astra Manager at the selected effort without starting it', controls: ['C04', 'C05', 'C06', 'C07', 'C11'], requires: ['compose-validation'], async run(context) {
    context.provider.agentName = 'Manager'
    context.provider.originalBrief = 'This is an isolated Page 2 native audit. Reply exactly PAGE2_ROOT_READY. Do not run tools, change files, or start agents unless a later test instruction asks for it.'
    context.state.rootId = await setNode(context, { role: 'manager', brief: context.provider.originalBrief })
    assert.match(await context.page.locator('body').innerText(), /Agent set|not started yet/)
    const ledger = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
    const starts = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row => row.action === 'agent_session_start') : []
    assert.equal(starts.length, 0)
    await observeOverview(context, context.state.rootId, 'draft')
  } },
  { id: 'root-start', title: 'Start tree once despite a double press and receive a real provider reply', controls: ['B14', 'C12', 'C14', 'R12'], requires: ['root-set'], async run(context) {
    requireProvider(context)
    const startObservation = await beginObservedStart(context, context.state.rootId,
      () => context.page.getByRole('button', { name: 'Start tree', exact: true }).dblclick())
    await context.page.getByText('Open conversation', { exact: true }).first().click()
    await exactAgentReply(context, context.state.rootId, 'PAGE2_ROOT_READY')
    const records = fs.readFileSync(path.join(context.paths.userData, 'agent-spawn-records.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(records.filter(row => row.action === 'agent_session_start' && row.details?.agentId === context.state.rootId).length, 1, 'A repeated Start must not create a second session')
    context.provider.latestReply = 'PAGE2_ROOT_READY'
    await rootCard(context).getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
    await finishObservedStart(context, context.state.rootId, startObservation)
    await observeOverview(context, context.state.rootId, 'finished')
    await openConversation(context, context.state.rootId)
    await context.capture('root-provider-reply')
  } },
  ...(process.platform === 'win32' ? [{ id: 'windows-native-supplements', title: 'Use native Windows cancel, mention, image removal and clipboard controls', controls: ['H17', 'H18', 'H19', 'P08', 'P09', 'P24', 'P25'], requires: ['root-start'], async run(context) {
    const windows = require('./page2-native-windows-scenarios.cjs')
    const receipts = await windows.run(context)
    assert.deepEqual(receipts.map(row => row.id), windows.executableIds)
    assert.ok(receipts.every(row => row.status === 'passed'))
  } }] : [{ id: 'linux-native-supplements', title: 'Use native Linux cancel, mention, image removal and clipboard controls', controls: ['H17', 'H18', 'H19', 'P08', 'P09', 'P24', 'P25'], requires: ['root-start'], async run(context) {
    const card = rootCard(context)
    const draft = 'UNSENT_NATIVE_PICKER_DRAFT'
    await context.type(input(card), draft)
    await palette(context, card, 'Attach an image')
    await context.picker({ operation: 'cancel', title: 'Attach an image to this message' })
    await closePalette(card)
    assert.equal(await input(card).inputValue(), draft)
    assert.equal(await card.locator('.chat-attachment-chip').count(), 0)
    await palette(context, card, 'Mention a file')
    await context.picker({ operation: 'select-path', title: 'Mention a file in this message', selectedPath: context.paths.mentionFile })
    await context.page.waitForFunction(({ id, text }) => document.querySelector(`.tree-conversation[data-agent-id="${id}"] .chat-input input`)?.value.includes(text), { id: context.state.rootId, text: context.paths.mentionFile })
    await card.locator('.chat-actions-pop').waitFor({ state: 'detached' })
    assert.equal(await input(card).evaluate(element => element === document.activeElement), true, 'A successful Mention must return focus to its originating composer')
    assert.ok((await input(card).inputValue()).includes(draft))
    await card.getByRole('button', { name: 'Mention a file', exact: true }).click()
    const beforeCancel = await input(card).inputValue()
    await context.picker({ operation: 'cancel', title: 'Mention a file in this message' })
    assert.equal(await input(card).inputValue(), beforeCancel)
    await card.locator('[data-chat-attach]').click()
    await context.picker({ operation: 'select-path', title: 'Attach an image to this message', selectedPath: context.paths.imageA })
    await card.getByRole('button', { name: /Remove qa-image-a/ }).click()
    assert.equal(await card.locator('.chat-attachment-chip').count(), 0)
    assert.equal(await input(card).inputValue(), beforeCancel)
    for (const [label, expected] of [['Copy what you asked for', context.provider.originalBrief], ['Copy what it said', context.provider.latestReply]]) {
      await context.type(input(card), '')
      await palette(context, card, label)
      await closePalette(card)
      await input(card).press('Control+V')
      assert.equal(await input(card).inputValue(), expected)
    }
    await context.type(input(card), '')
  } }]),
  { id: 'composer-actions', title: 'Effort, Queue and Reports-to preserve the originating draft', controls: ['H23', 'P07', 'P11', 'P26', 'R02', 'R03'], requires: ['root-start'], async run(context) {
    await openConversation(context, context.state.rootId)
    const draft = 'UNSENT_PAGE2_NATIVE_DRAFT'
    await context.type(input(rootCard(context)), draft)
    await rootCard(context).locator('[data-chat-chip="effort"]').click()
    assert.equal(await input(rootCard(context)).inputValue(), draft)
    assert.ok(await rootCard(context).getByRole('option', { name: /^max/ }).isVisible())
    await context.page.keyboard.press('Escape')
    await palette(context, rootCard(context), 'Queue a message')
    assert.equal(await input(rootCard(context)).inputValue(), draft)
    await openControls(context, context.state.rootId)
    await context.type(input(rail(context)), draft + '_RAIL')
    await rail(context).locator('[data-chat-chip="effort"]').click()
    assert.equal(await input(rail(context)).inputValue(), draft + '_RAIL')
    await context.page.keyboard.press('Escape')
    await palette(context, rail(context), 'Change who it reports to')
    await context.page.locator('[data-rail-tab="chat"]').click()
    assert.equal(await input(rail(context)).inputValue(), draft + '_RAIL')
    await context.type(input(rail(context)), '')
    await context.type(input(rootCard(context)), '')
  } },
  { id: 'shared-reply', title: 'A real follow-up reaches both open chat surfaces once', controls: ['H01', 'H02', 'H03', 'G21', 'R12'], requires: ['composer-actions'], async run(context) {
    await send(context, rootCard(context), 'Reply exactly PAGE2_SHARED_REPLY. Do not use tools.')
    await exactAgentReply(context, context.state.rootId, 'PAGE2_SHARED_REPLY')
    await rail(context).locator('.msg.them .chat-msg-text').filter({ hasText: /^PAGE2_SHARED_REPLY$/ }).waitFor({ timeout: 90000 })
    assert.equal(await rootCard(context).locator('.msg.them .chat-msg-text').filter({ hasText: /^PAGE2_SHARED_REPLY$/ }).count(), 1)
    assert.equal(await rail(context).locator('.msg.them .chat-msg-text').filter({ hasText: /^PAGE2_SHARED_REPLY$/ }).count(), 1)
    context.provider.latestReply = 'PAGE2_SHARED_REPLY'
  } },
  { id: 'ledger-scopes', title: 'File Request, Task and Ask in all four scopes through the composer', controls: ['S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22'], requires: ['root-start'], async run(context) {
    await openConversation(context, context.state.rootId)
    context.state.ledgerIds = {}
    for (const [family, letter] of [['Request', 'R'], ['Task', 'T'], ['Ask', 'A']]) {
      for (const [suffix, scope] of [['', 'global'], ['Session', 'session'], ['Tree', 'tree'], ['Thread', 'thread']]) {
        await context.step(`file-${family}-${scope}`, async () => {
          const previous = (await rootCard(context).innerText()).match(new RegExp(`Filed ${letter}\\d+`, 'g')) || []
          const words = `Isolated native QA ${family.toLowerCase()} for ${scope}; this record requests no additional agent execution.`
          await send(context, rootCard(context), `/${family}${suffix} ${words}`)
          await context.page.waitForFunction(({ id, letter, count }) => {
            const text = document.querySelector(`.tree-conversation[data-agent-id="${id}"]`)?.innerText || ''
            return (text.match(new RegExp(`Filed ${letter}\\d+`, 'g')) || []).length === count + 1
          }, { id: context.state.rootId, letter, count: previous.length })
          const filed = (await rootCard(context).innerText()).match(new RegExp(`Filed (${letter}\\d+)`, 'g')).at(-1).slice(6)
          context.state.ledgerIds[family + scope] = filed
          const retained = await context.page.evaluate(async id => {
            let node = null
            for (let index = 0; index < localStorage.length; index++) {
              const key = localStorage.key(index)
              if (!key?.startsWith('mc.fleet.trees.v1:')) continue
              const value = JSON.parse(localStorage.getItem(key))
              node = value?.nodes?.find(candidate => candidate.id === id)
              if (node) break
            }
            return { node, ledger: await window.mcAgent.ledger({ scope: 'all', removed: false }) }
          }, context.state.rootId)
          assert.equal(retained.node?.id, context.state.rootId, 'Scope verification must find the exact saved root')
          if (scope === 'session') assert.ok(retained.node.sessionId, 'A session-scoped record must have an actual current session')
          return verifyFiledScope(retained.ledger, { id: filed, kind: letter, scope,
            scopeKey: scope === 'global' ? null : scope === 'session' ? retained.node.sessionId : context.state.rootId, words })
        })
      }
    }
    await openControls(context, context.state.rootId, 'details')
    for (const scope of ['global', 'session', 'tree', 'thread']) await details(context).locator(`[data-request-entry="${context.state.ledgerIds['Request' + scope]}"]`).waitFor()
    assert.match(await details(context).innerText(), /The folder you chose in setup/)
    assert.ok((await details(context).innerText()).includes(context.paths.workspace))
    await context.capture('all-ledger-scopes')
  } },
  { id: 'rule-edit-delete', title: 'Edit a filed rule and confirm its deletion in the live Details panel', controls: ['R09'], requires: ['ledger-scopes'], async run(context) {
    const id = context.state.ledgerIds.Requestthread
    await details(context).locator(`[data-request-action="edit"][data-request-id="${id}"]`).click()
    await context.type(details(context).locator('[data-request-editor]'), 'Edited native QA conversation rule; this rule stays on this conversation only.')
    await details(context).locator(`[data-request-action="save"][data-request-id="${id}"]`).click()
    await details(context).getByText('Edited native QA conversation rule; this rule stays on this conversation only.', { exact: true }).waitFor()
    const deletion = details(context).locator(`[data-request-action="delete"][data-request-id="${id}"]`)
    await deletion.click()
    assert.ok(await details(context).locator(`[data-request-entry="${id}"]`).isVisible())
    await deletion.click()
    await details(context).locator(`[data-request-entry="${id}"]`).waitFor({ state: 'detached' })
  } },
  { id: 'goal-loop-refusals', title: 'Reject invalid goal and loop commands and explain the disabled queue write', controls: ['S23', 'S24', 'S26', 'S27', 'D10'], requires: ['root-start'], async run(context) {
    await openConversation(context, context.state.rootId)
    for (const text of ['/goal', '/goal r1 invalid request capitalization']) {
      await commandReceipt(context, rootCard(context), text, /keep the R uppercase/)
    }
    await commandReceipt(context, rootCard(context), '/goal R1 Record this native QA objective only; do not execute it.', /Build-queue changes are switched off/)
    await commandReceipt(context, rootCard(context), '/loop 0', /whole number from 1 to 240/)
    await commandReceipt(context, rootCard(context), '/this-command-does-not-exist', /not a command here/)
  } },
  { id: 'child-set', title: 'Set a Worker under the exact selected Manager', controls: ['C02', 'C11', 'G05'], requires: ['root-start'], async run(context) {
    context.state.childId = await setNode(context, { parentId: context.state.rootId, role: 'worker', brief: 'This is the owner-created native QA child. Reply exactly PAGE2_CHILD_READY. Do not run tools, change files, or start agents until a later test instruction.' })
  } },
  { id: 'child-start', title: 'Start the staged child with its actual parent and inherited folder', controls: ['B14', 'C12', 'R06'], requires: ['child-set'], async run(context) {
    await context.page.getByRole('button', { name: 'Start tree', exact: true }).dblclick()
    await openConversation(context, context.state.childId)
    await exactAgentReply(context, context.state.childId, 'PAGE2_CHILD_READY')
    await openControls(context, context.state.childId, 'details')
    assert.ok((await details(context).innerText()).includes(context.paths.workspace))
    assert.equal(await context.page.locator(`.static-tree-node[data-agent-id="${context.state.childId}"]`).getAttribute('data-parent-id'), context.state.rootId)
    await context.capture('child-provider-reply')
  } },
  { id: 'workspace-read', title: 'Read an unseen check word from the configured workspace through a real tool', controls: ['H01', 'H28'], requires: ['root-start'], async run(context) {
    if (context.options.level !== 'standard') context.unavailable('Positive command-based reading requires the Standard scenario; Guided refusal is recorded separately')
    await openConversation(context, context.state.rootId)
    await send(context, rootCard(context), 'Read qa-note.txt in the selected working folder with a permitted command such as cat. Reply only with its check word. Do not modify files or start agents. If the tool refuses, state its exact refusal.')
    await context.page.waitForFunction(({ id, word }) => {
      const card = document.querySelector(`.tree-conversation[data-agent-id="${id}"]`)
      return card && [...card.querySelectorAll('.msg.them .chat-msg-text')].some(message => message.textContent.trim().split(/\s+/).at(-1) === word)
    }, { id: context.state.rootId, word: context.paths.checkWord }, { timeout: 90000 })
    await rootCard(context).getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden', timeout: 90000 })
    // CSS capitalizes the visible word; the source-backed text is "Command".
    // Read the actual completed tool row and output as well as the reply.
    const command = rootCard(context).locator('.chat-action:not(.chat-action-run)')
      .filter({ has: context.page.getByText(/^command$/i) }).filter({ hasText: 'qa-note.txt' }).last()
    await command.getByText(/^command$/i).waitFor()
    assert.equal((await command.locator('.chat-action-state').textContent()).trim(), 'finished')
    await command.locator('.chat-action-head').click()
    await command.locator('.chat-action-body').waitFor()
    assert.ok((await command.locator('.chat-action-body').textContent()).includes(context.paths.checkWord), 'The actual completed tool output must contain the unseen workspace word')
    await context.capture('real-working-folder-read')
  } },
  { id: 'mixed-attachments', title: 'Native Actions and toolbar attachments both reach the real provider', controls: ['H17', 'H19', 'P08'], requires: ['root-start'], async run(context) {
    await openConversation(context, context.state.rootId)
    await palette(context, rootCard(context), 'Attach an image')
    await context.picker({ operation: 'select-path', title: 'Attach an image to this message', selectedPath: context.paths.imageA })
    await rootCard(context).getByRole('button', { name: /Remove qa-image-a/ }).waitFor()
    await closePalette(rootCard(context))
    await rootCard(context).locator('[data-chat-attach]').click()
    await context.picker({ operation: 'select-path', title: 'Attach an image to this message', selectedPath: context.paths.imageB })
    await rootCard(context).getByRole('button', { name: /Remove qa-image-b/ }).waitFor()
    await context.capture('two-pending-native-images')
    await send(context, rootCard(context), 'Count the attached images. Reply exactly PAGE2_IMAGES_2 only if there are two actual image attachments. Otherwise report the actual count. Do not run tools.')
    await exactAgentReply(context, context.state.rootId, 'PAGE2_IMAGES_2')
    assert.equal(await rootCard(context).getByRole('button', { name: /Remove qa-image-/ }).count(), 0)
  } },
  { id: 'queue-interrupt', title: 'Recall, edit, reorder and unqueue messages; Stop holds the remaining message', controls: ['H05', 'H09', 'H10', 'H12', 'H13', 'H14', 'H15', 'H16'], requires: ['child-start'], async run(context) {
    await openControls(context, context.state.childId)
    const command = process.platform === 'linux' && context.options.level === 'standard'
    await send(context, rail(context), command
      ? 'For this native QA turn, run only node -e "setTimeout(()=>console.log(\'PAGE2_SLOW_DONE\'),45000)" in the selected folder, then reply PAGE2_SLOW_DONE. This instruction explicitly permits that bounded command. Do not change files or start agents.'
      : 'For this native QA Stop test, write 500 numbered lines, each containing its number and the words native interruption check. Do not run tools or start agents.')
    await rail(context).getByRole('button', { name: 'Stop this reply', exact: true }).waitFor()
    await send(context, rail(context), 'Reply exactly PAGE2_QUEUE_A. Do not use tools.')
    await send(context, rail(context), 'Reply exactly PAGE2_QUEUE_B. Do not use tools.')
    await input(rail(context)).press('ArrowUp')
    assert.equal(await input(rail(context)).inputValue(), 'Reply exactly PAGE2_QUEUE_B. Do not use tools.')
    await input(rail(context)).press('ArrowDown')
    assert.equal(await input(rail(context)).inputValue(), '')
    await input(rail(context)).press('ArrowUp')
    await input(rail(context)).press('Escape')
    assert.equal(await input(rail(context)).inputValue(), '')
    await input(rail(context)).press('ArrowUp')
    await context.type(input(rail(context)), 'Reply exactly PAGE2_QUEUE_B_EDITED. Do not use tools.')
    await input(rail(context)).press('Enter')
    const queue = rail(context).locator('.chat-queue-strip')
    await queue.getByRole('button', { name: 'Move this to the front — it goes the moment this turn finishes', exact: true }).nth(1).click()
    await queue.getByRole('button', { name: 'Remove this waiting message', exact: true }).nth(1).click()
    assert.match(await queue.innerText(), /PAGE2_QUEUE_B_EDITED/)
    assert.ok(!(await queue.innerText()).includes('PAGE2_QUEUE_A'))
    if (command) await rail(context).getByText(/^command$/i).first().waitFor({ timeout: 60000 })
    const interrupted = rail(context).locator('.chat-msg-text').filter({ hasText: /^Interrupted\.$/ })
    const interruptionsBefore = await interrupted.count()
    await rail(context).getByRole('button', { name: 'Stop this reply', exact: true }).click()
    await interrupted.nth(interruptionsBefore).waitFor()
    assert.match(await rail(context).innerText(), /stopped by you/)
    assert.doesNotMatch(await rail(context).innerText(), /last turn failed|turn ended without/)
    assert.match(await queue.innerText(), /PAGE2_QUEUE_B_EDITED/)
    context.state.commandInterruptedAt = command ? Date.now() : null
    await context.capture('native-interrupt-held-queue')
    await observeOverview(context, context.state.childId, 'review')
    await openControls(context, context.state.childId)
    assert.match(await rail(context).locator('.chat-queue-strip').innerText(), /PAGE2_QUEUE_B_EDITED/)
  } },
  { id: 'queue-after-late-result', title: 'Send the retained message after an interrupted command reports late', controls: ['H11'], requires: ['queue-interrupt'], async run(context) {
    if (context.state.commandInterruptedAt) {
      // The command is deliberately bounded at 45s. This case waits through
      // its late result to reproduce the parser failure seen manually; it does
      // not claim a turn interrupt terminates every provider-owned command.
      const remaining = Math.max(0, 48000 - (Date.now() - context.state.commandInterruptedAt))
      if (remaining) await context.page.waitForTimeout(remaining)
    }
    const queue = rail(context).locator('.chat-queue-strip')
    assert.match(await queue.innerText(), /PAGE2_QUEUE_B_EDITED/)
    await queue.getByRole('button', { name: 'Send this message now, even if that means stopping what the agent is writing to do it', exact: true }).click()
    await exactAgentReply(context, context.state.childId, 'PAGE2_QUEUE_B_EDITED')
    assert.equal(await queue.getByRole('button', { name: 'Remove this waiting message', exact: true }).count(), 0)
    await context.capture('native-send-after-interrupt')
  } },
  { id: 'background-queue', title: 'A queued message completes while Page 2 is absent', controls: ['H09', 'C15'], requires: ['queue-after-late-result'], async run(context) {
    await send(context, childCard(context), 'Write twenty numbered short lines explaining this is a Page 2 background queue test. Do not use tools.')
    await childCard(context).getByRole('button', { name: 'Stop this reply', exact: true }).waitFor()
    await send(context, childCard(context), 'Reply exactly PAGE2_BACKGROUND_QUEUE. Do not use tools.')
    await childCard(context).locator('.chat-queue-strip').getByText('Reply exactly PAGE2_BACKGROUND_QUEUE. Do not use tools.', { exact: true }).waitFor()
    await navigate(context, 'metrics')
    await context.page.waitForTimeout(12000)
    await navigate(context, 'computers')
    await openConversation(context, context.state.childId)
    await exactAgentReply(context, context.state.childId, 'PAGE2_BACKGROUND_QUEUE')
  } },
  { id: 'cold-conversation', title: 'Reopen the same profile and preserve separate user, tree and role text', controls: ['R16', 'P22'], requires: ['shared-reply', 'queue-after-late-result'], async run(context) {
    await context.close()
    await context.open()
    await navigate(context, 'computers')
    await openConversation(context, context.state.rootId)
    await rootCard(context).locator('.msg.me .chat-msg-text').filter({ hasText: context.provider.originalBrief }).waitFor()
    await exactAgentReply(context, context.state.rootId, 'PAGE2_SHARED_REPLY')
    assert.match(await rootCard(context).innerText(), /Role directions/)
    await context.type(input(rootCard(context)), 'UNSENT_RESUME_KEEP')
    await palette(context, rootCard(context), 'Resume with a fresh agent')
    await rootCard(context).getByText('your agent · live session', { exact: true }).waitFor({ timeout: 90000 })
    assert.equal(await input(rootCard(context)).inputValue(), 'UNSENT_RESUME_KEEP')
    await send(context, rootCard(context), 'Reply exactly PAGE2_RESUMED_REPLY. Do not use tools.')
    await exactAgentReply(context, context.state.rootId, 'PAGE2_RESUMED_REPLY')
    await context.capture('native-cold-resume')
  } },
]

module.exports = { scenarios, quietNewPageTips, rootCard, childCard, input, rail, details, navigate, openControls, openConversation, send, exactAgentReply, palette, verifyFiledScope, openNewTree }
