'use strict'

// Replays the remaining manually measured controls in the real app. DOM reads
// assert outcomes; mutations use visible controls and the native picker.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { observePermissionReads, observeProfiles } = require('./page2-native-state-evidence.cjs')
const { rootCard, input, rail, details, openControls, palette, send, exactAgentReply, openNewTree } = require('./page2-native-scenarios.cjs')

const node = (context, id) => context.page.locator(`.static-tree-node[data-agent-id="${id}"]`)
async function computers(context) {
  if (new URL(context.page.url()).hash !== '#/computers') {
    await context.page.locator('nav[aria-label="Primary navigation"] a[href="#/computers"]').click()
    await context.page.waitForURL(url => url.hash === '#/computers')
  }
  await context.page.locator('.tree-chats-toggle').waitFor()
}
async function overview(context) {
  await computers(context)
  await context.page.keyboard.press('Escape')
  const back = context.page.getByRole('button', { name: 'Back to the fleet overview', exact: true })
  if (await back.isVisible()) await back.click()
  await context.page.getByRole('region', { name: 'Agent folders', exact: true }).waitFor()
  // Opening the right rail does not leave a drilled branch. Restore the full
  // graph so the new tree and the retained nodes can be compared together.
  const all = context.page.locator('.stats-page.is-active [data-fleet-show-all]')
  await all.click()
  assert.equal(await all.getAttribute('aria-pressed'), 'true', 'Folder controls must display every tree before creating a separate root')
}
async function chooseConversation(context, id) {
  await computers(context)
  const toggle = context.page.locator('.tree-chats-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await context.select(context.page.locator('.tree-chat-picker'), id, { resetsAfterSelection: true })
  await context.page.locator(`.tree-conversation[data-agent-id="${id}"]`).waitFor()
}
async function nodes(context) {
  return context.page.locator('.static-tree-node').evaluateAll(elements => elements.map(element => ({ id: element.dataset.agentId, parentId: element.dataset.parentId || null })))
}
function ledgerBytes(context) {
  const file = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

const scenarios = [
  { id: 'conversation-search', title: 'Search filters existing messages and Escape restores them without changing the draft', controls: ['H24'], requires: ['shared-reply'], async run(context) {
    await chooseConversation(context, context.state.rootId)
    const card = rootCard(context)
    const before = await input(card).inputValue()
    const draft = 'UNSENT_NATIVE_SEARCH_DRAFT'
    await context.type(input(card), draft)
    await card.getByRole('button', { name: 'Search this conversation', exact: true }).click()
    const search = card.getByRole('searchbox', { name: 'Search messages', exact: true })
    await context.type(search, 'PAGE2_SHARED_REPLY')
    const visible = await card.locator('.chat-log .msg:visible').allTextContents()
    assert.ok(visible.length > 0, 'The previously verified provider reply must match search')
    assert.ok(visible.every(text => text.includes('PAGE2_SHARED_REPLY')), 'Search must hide unrelated transcript rows')
    await search.press('Escape')
    assert.equal(await card.isVisible(), true, 'Closing search must retain the conversation card')
    assert.equal(await search.isVisible(), false)
    assert.equal(await card.getByRole('button', { name: 'Search this conversation', exact: true }).getAttribute('aria-expanded'), 'false')
    assert.equal(await input(card).inputValue(), draft)
    assert.ok((await card.locator('.chat-log .msg:visible').count()) > visible.length)
    await context.type(input(card), before)
    await context.capture('native-conversation-search')
  } },
  { id: 'conversation-shelf-controls', title: 'Open both chats, hide/show them, expand one and restore both with independent drafts', controls: ['G24', 'G25', 'G26'], requires: ['child-start'], async run(context) {
    await chooseConversation(context, context.state.rootId)
    await chooseConversation(context, context.state.childId)
    const shelf = context.page.getByRole('region', { name: 'Open conversations', exact: true })
    const card = rootCard(context)
    const original = await input(card).inputValue()
    await context.type(input(card), 'UNSENT_NATIVE_SHELF_DRAFT')
    await shelf.getByRole('button', { name: 'Hide chats', exact: true }).click()
    assert.equal(await shelf.locator('.tree-conversation-track').isVisible(), false)
    await shelf.getByRole('button', { name: 'Show chats', exact: true }).click()
    assert.equal(await shelf.locator('.tree-conversation-track').isVisible(), true)
    await card.getByRole('button', { name: 'Expand to fill the tree', exact: true }).click()
    assert.equal(await card.getByRole('button', { name: 'Expand to fill the tree', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await context.page.locator(`.tree-conversation[data-agent-id="${context.state.childId}"]`).isVisible(), false)
    await card.getByRole('button', { name: 'Expand to fill the tree', exact: true }).click()
    assert.equal(await context.page.locator(`.tree-conversation[data-agent-id="${context.state.childId}"]`).isVisible(), true)
    assert.equal(await input(card).inputValue(), 'UNSENT_NATIVE_SHELF_DRAFT')
    await context.type(input(card), original)
    await context.capture('native-shelf-controls')
  } },
  { id: 'board-zoom-controls', title: 'Zoom out, zoom in and fit the current tree without changing its nodes', controls: ['G10', 'G11', 'G12'], requires: ['child-set'], async run(context) {
    await computers(context)
    const before = await nodes(context)
    const reset = context.page.getByRole('button', { name: 'Reset zoom to overview', exact: true })
    await reset.click()
    const fitted = await reset.innerText()
    await context.page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await context.page.waitForFunction(before => document.querySelector('.graph-fit')?.innerText !== before, fitted)
    const zoomed = await reset.innerText()
    await context.page.getByRole('button', { name: 'Zoom out', exact: true }).click()
    await context.page.waitForFunction(before => document.querySelector('.graph-fit')?.innerText !== before, zoomed)
    await reset.click()
    assert.match(await reset.innerText(), /Fit|Overview/i)
    assert.deepEqual(await nodes(context), before)
    await context.capture('native-board-zoom')
  } },
  { id: 'saved-history-bounds', title: 'Browse saved messages in a bounded region and close the archive without live controls intercepting input', controls: ['R16', 'R17'], requires: ['shared-reply'], async run(context) {
    await computers(context)
    await openControls(context, context.state.rootId)
    const chat = rail(context)
    const toggle = chat.getByRole('button', { name: 'Browse saved conversation', exact: true })
    await toggle.click()
    const saved = chat.getByRole('region', { name: 'Saved conversation', exact: true })
    await saved.locator('.node-transcript-history-entries .chat-msg-text').first().waitFor()
    assert.ok((await saved.innerText()).includes('PAGE2_SHARED_REPLY'))
    const geometry = await chat.evaluate(element => {
      const rect = selector => { const r = element.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } }
      return { live: rect('[data-rail-chat-host] > .chat'), archive: rect('.node-transcript-history'), body: { top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom } }
    })
    assert.ok(geometry.archive.top >= geometry.live.bottom - 2, 'Saved history must not overlap the live chat')
    assert.ok(geometry.archive.bottom <= geometry.body.bottom + 2, 'Saved history must remain inside the rail body')
    await context.capture('native-saved-history-bounds')
    await toggle.click()
    await saved.waitFor({ state: 'hidden' })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  } },
  { id: 'named-profile-create-refresh', title: 'Cancel a named-folder picker, then create a profile immediately available to a newly staged root', controls: ['B17', 'B18', 'C08'], requires: ['setup', 'root-set'], async run(context) {
    await overview(context)
    const folders = context.page.getByRole('region', { name: 'Agent folders', exact: true })
    const profileName = `Native QA ${path.basename(context.paths.qaRoot)}`
    const before = await folders.locator('[data-profile-remove]').count()
    await context.type(folders.locator('[data-profile-name]'), profileName)
    await folders.locator('[data-profile-add]').click()
    await context.picker({ operation: 'cancel', title: 'Choose the folder agents in this profile work in' })
    assert.equal(await folders.locator('[data-profile-remove]').count(), before)
    await folders.locator('[data-profile-out]').filter({ hasText: /cancel|No folder/i }).waitFor()
    context.paths.namedWorkspace = path.join(context.paths.qaRoot, 'named-workspace')
    fs.mkdirSync(context.paths.namedWorkspace, { recursive: false })
    await folders.locator('[data-profile-add]').click()
    await context.picker({ operation: 'select-path', title: 'Choose the folder agents in this profile work in', selectedPath: context.paths.namedWorkspace })
    const row = folders.locator('li').filter({ hasText: profileName })
    await row.waitFor()
    context.state.controlsProfileId = await row.locator('[data-profile-remove]').getAttribute('data-profile-remove')
    context.state.controlsProfileName = profileName
    await observeProfiles(context, true)
    await openNewTree(context)
    const profile = context.page.locator('[data-compose-field="profile"]')
    await profile.locator('option').filter({ hasText: profileName }).waitFor({ state: 'attached' })
    await context.select(profile, context.state.controlsProfileId)
    await context.select(context.page.locator('[data-compose-field="role"]'), 'observer')
    await context.select(context.page.locator('[data-compose-field="tier"]'), 'astra')
    await context.select(context.page.locator('[data-compose-field="effort"]'), 'max')
    await context.type(context.page.locator('[data-compose-field="message"]'), 'Owned native QA staged Observer for folder inheritance, reparent and removal. Do not start this agent.')
    const known = await nodes(context)
    const starts = ledgerBytes(context)
    await context.page.locator('[data-compose-action="set"]').click()
    await context.page.waitForFunction(count => document.querySelectorAll('.static-tree-node').length === count + 1, known.length)
    const added = (await nodes(context)).filter(item => !known.some(old => old.id === item.id))
    assert.equal(added.length, 1)
    assert.equal(added[0].parentId, null)
    context.state.controlsObserverId = added[0].id
    const started = text => text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.action === 'agent_session_start').length
    assert.equal(started(ledgerBytes(context)), started(starts), 'Setting the Observer must not start any provider session')
    await openControls(context, added[0].id, 'details')
    await context.page.waitForFunction(profileId => document.querySelector('[data-rail-body="details"] [data-tree-profile]')?.value === profileId, context.state.controlsProfileId)
    await context.capture('native-named-profile-fresh-composer')
  } },
  { id: 'staged-cross-tree-reparent', title: 'Move only the staged root under the existing Manager and inherit its distinct setup folder', controls: ['G19', 'R08', 'R09'], requires: ['named-profile-create-refresh', 'root-set'], async run(context) {
    await computers(context)
    const id = context.state.controlsObserverId
    await openControls(context, id, 'details')
    const before = await nodes(context)
    const rootsBefore = before.filter(item => !item.parentId).length
    await context.select(details(context).locator('[data-tree-move-select]'), context.state.rootId)
    await details(context).locator('[data-tree-move-save]').click()
    await context.page.waitForFunction(({ id, parent }) => document.querySelector(`.static-tree-node[data-agent-id="${id}"]`)?.dataset.parentId === parent, { id, parent: context.state.rootId })
    const after = await nodes(context)
    assert.equal(after.length, before.length)
    assert.equal(after.filter(item => !item.parentId).length, rootsBefore - 1)
    await openControls(context, id, 'details')
    const folder = details(context).locator('[data-tree-folder]')
    assert.equal(await folder.locator('[data-tree-profile]').inputValue(), '')
    assert.ok((await folder.locator('[data-tree-default-profile]').textContent()).includes(context.paths.workspace))
    assert.ok(!(await folder.innerText()).includes(context.paths.namedWorkspace))
    await context.capture('native-cross-tree-reparent')
  } },
  { id: 'staged-remove-confirmation', title: 'Cancel removal, then remove only the staged Observer while retaining signed run records', controls: ['P31', 'P34'], requires: ['staged-cross-tree-reparent'], async run(context) {
    await computers(context)
    const id = context.state.controlsObserverId
    await openControls(context, id)
    const before = await nodes(context)
    await palette(context, rail(context), 'Remove this agent')
    await rail(context).getByRole('option', { name: /^Remove This removes Observer/ }).waitFor()
    await rail(context).getByRole('option', { name: '‹ Back', exact: true }).click()
    await context.step('staged-removal-back-keeps-actions', async () => {
      const filter = rail(context).locator('.chat-actions-filter')
      await filter.waitFor()
      assert.equal(await filter.evaluate(element => element === document.activeElement), true,
        'Back must retain the actual Actions popup with focus in its top filter')
      assert.equal(await rail(context).locator('[data-chat-actions]').getAttribute('aria-expanded'), 'true')
      assert.deepEqual(await nodes(context), before, 'Back must retain the exact staged Observer and every other node')
      return { selectedNodeId: id, popupOpen: true, focus: 'actions-filter', nodesRetained: before.map(item => item.id) }
    })
    await context.page.keyboard.press('Escape')
    await rail(context).locator('.chat-actions-pop').waitFor({ state: 'detached' })
    assert.equal(await rail(context).isVisible(), true, 'One Escape must leave the staged Observer rail open')
    assert.equal(await rail(context).locator('[data-chat-actions]').getAttribute('aria-expanded'), 'false')
    const records = ledgerBytes(context)
    await palette(context, rail(context), 'Remove this agent')
    await rail(context).getByRole('option', { name: /^Remove This removes Observer/ }).click()
    await node(context, id).waitFor({ state: 'detached' })
    assert.deepEqual((await nodes(context)).map(item => item.id).sort(), before.filter(item => item.id !== id).map(item => item.id).sort())
    assert.ok(ledgerBytes(context).startsWith(records), 'Removing a node must retain its earlier signed run records')
    await context.capture('native-staged-observer-removed')
  } },
  { id: 'named-profile-remove-refresh', title: 'Remove the unused named profile and immediately remove it from fresh composer choices', controls: ['B19'], requires: ['staged-remove-confirmation'], async run(context) {
    await overview(context)
    await context.page.locator(`[data-profile-remove="${context.state.controlsProfileId}"]`).click()
    await context.page.locator(`[data-profile-remove="${context.state.controlsProfileId}"]`).waitFor({ state: 'detached' })
    await observeProfiles(context, false)
    await openNewTree(context)
    const profile = context.page.locator('[data-compose-field="profile"]')
    assert.equal(await profile.locator(`option[value="${context.state.controlsProfileId}"]`).count(), 0)
    await context.page.keyboard.press('Escape')
    assert.equal(await node(context, context.state.rootId).count(), 1)
    await context.capture('native-profile-removed-from-composer')
  } },
  { id: 'permission-level-display', title: 'Details reports the selected permission level instead of an unresolved fallback', controls: ['D03'], requires: ['root-set'], async run(context) {
    await computers(context)
    await openControls(context, context.state.rootId, 'details')
    const toggle = details(context).locator('[data-start-work-toggle]')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    const sandbox = details(context).locator('[data-launch="sandbox"]')
    await sandbox.filter({ hasText: new RegExp(`^${context.options.level} ·`) }).waitFor()
    const visible = await sandbox.innerText()
    assert.doesNotMatch(visible, /not resolved|unknown|reading/i)
    // This is the product's permission display. A provider command refusal or
    // actual sandbox enforcement earns separate evidence in workspace-read.
    await context.step('record-permission-display', async () => ({ selectedLevel: context.options.level, displayed: visible, scope: 'Visible recorded-level contract only; no enforcement claim' }))
    await observePermissionReads(context, context.state.rootId, visible)
    await context.capture('native-permission-display')
  } },
  { id: 'idle-stop-first-message-resume', title: 'Stop an idle live session, retain its draft, then show the first reply that resumes it', controls: ['P29', 'P22'], requires: ['cold-conversation'], async run(context) {
    await chooseConversation(context, context.state.rootId)
    const card = rootCard(context)
    await card.getByRole('button', { name: 'Stop this reply', exact: true }).waitFor({ state: 'hidden', timeout: 15000 })
    assert.equal(await card.getByRole('button', { name: 'Stop this reply', exact: true }).count(), 0)
    await context.type(input(card), 'UNSENT_IDLE_STOP_DRAFT')
    await palette(context, card, 'Stop this agent')
    await card.getByText('Stopped. The session is closed.', { exact: true }).waitFor()
    assert.equal(await input(card).inputValue(), 'UNSENT_IDLE_STOP_DRAFT')
    await send(context, card, 'Reply exactly PAGE2_FIRST_RESUMED_REPLY. Do not use tools or start agents.')
    await exactAgentReply(context, context.state.rootId, 'PAGE2_FIRST_RESUMED_REPLY')
    assert.equal(await card.locator('.msg.them .chat-msg-text').filter({ hasText: /^PAGE2_FIRST_RESUMED_REPLY$/ }).count(), 1)
    assert.match(await card.innerText(), /your agent · live session/)
    context.provider.latestReply = 'PAGE2_FIRST_RESUMED_REPLY'
    await context.capture('native-idle-stop-first-resume-reply')
  } },
]

module.exports = { scenarios }
