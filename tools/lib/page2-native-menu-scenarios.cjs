'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { rootCard, input, navigate, openConversation, openNewTree } = require('./page2-native-scenarios.cjs')

async function topology(context) {
  return context.page.evaluate(() => {
    const result = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      const saved = JSON.parse(localStorage.getItem(key))
      for (const node of saved?.nodes || []) result.push({ id: node.id, parentId: node.parentId ?? null, sessionId: node.sessionId ?? null })
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  })
}
function starts(context) {
  const file = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.action === 'agent_session_start').map(row => row.sequence)
}
async function compose(context) {
  await navigate(context, 'metrics')
  await navigate(context, 'computers')
  await openNewTree(context)
  const panel = context.page.locator('[data-agent-compose="open"]')
  await panel.waitFor()
  return panel
}
async function composeHelp(context, field, words) {
  const panel = await compose(context)
  const before = await topology(context)
  const priorStarts = starts(context)
  const control = panel.locator(`[data-compose-field="${field}"]`)
  const wrapper = control.locator('..')
  const label = wrapper.locator('label.cl')
  const hint = wrapper.locator('[data-compose-tip="hover"]')
  const hintId = await hint.getAttribute('id')
  assert.ok((await control.getAttribute('aria-describedby')).split(/\s+/).includes(hintId))
  const value = await control.inputValue()
  await label.click()
  assert.match(await wrapper.getAttribute('class'), /\btip-open\b/)
  await context.page.waitForFunction(id => Number(getComputedStyle(document.getElementById(id)).opacity) > 0.99, hintId)
  assert.equal(await hint.textContent(), words)
  assert.equal(await control.inputValue(), value, 'Opening field help must preserve the selected value or brief')
  await context.capture(`native-compose-${field}-help`)
  await label.click()
  assert.doesNotMatch(await wrapper.getAttribute('class'), /\btip-open\b/, 'The second label press must release the pinned help')
  await panel.locator('[data-compose-action="cancel"]').click()
  await panel.waitFor({ state: 'detached' })
  assert.deepEqual(await topology(context), before)
  assert.deepEqual(starts(context), priorStarts, 'Field help and cancellation must not start an agent')
  return { field, hintId, selectedValue: value, help: words, nodes: before, starts: priorStarts }
}
async function withActions(context, run, { slash = false } = {}) {
  await navigate(context, 'computers')
  await openConversation(context, context.state.rootId)
  const card = rootCard(context)
  const composer = input(card)
  const original = await composer.inputValue()
  const draft = slash ? '' : 'UNSENT_NATIVE_ACTIONS_DRAFT'
  const before = await topology(context)
  const priorStarts = starts(context)
  await context.type(composer, draft)
  if (slash) await composer.press('/')
  else await card.locator('[data-chat-actions]').click()
  const pop = card.locator('.chat-actions-pop')
  await pop.waitFor()
  try {
    assert.equal(await card.locator('[data-chat-actions]').getAttribute('aria-expanded'), 'true')
    assert.equal(await composer.inputValue(), draft)
    await run({ card, composer, pop, filter: pop.locator('.chat-actions-filter'), options: pop.getByRole('option') })
  } finally {
    if (await pop.count()) await context.page.keyboard.press('Escape')
    await context.type(composer, original)
    assert.equal(await composer.inputValue(), original, 'Inspecting Actions must restore the exact original draft')
  }
  assert.deepEqual(await topology(context), before, 'Inspecting Actions must retain all saved agent and parent identities')
  assert.deepEqual(starts(context), priorStarts, 'Inspecting Actions must not create a replacement or child session')
  return { nodeId: context.state.rootId, nodes: before, starts: priorStarts, originalDraftRestored: true }
}
async function activeOption(pop) {
  const selected = pop.getByRole('option', { selected: true })
  assert.equal(await selected.count(), 1)
  const id = await selected.getAttribute('id')
  assert.equal(await pop.locator('.chat-actions-filter').getAttribute('aria-activedescendant'), id)
  assert.equal(await pop.locator('.chat-actions-list').getAttribute('aria-activedescendant'), id)
  return id
}

const scenarios = [
  { id: 'compose-help-role', title: 'Toggle Role help on the fresh composer without changing or starting an agent', controls: ['compose.help.role'], requires: ['setup'], run: context => context.step('menu-compose-help-role-proof', () => composeHelp(context, 'role', 'Optional. Pick where it sits in your tree, or leave it and this agent just does the job you describe.')) },
  { id: 'compose-help-tier', title: 'Toggle the actual Tier advice while preserving the fresh composer selection', controls: ['compose.help.tier'], requires: ['setup'], run: context => context.step('menu-compose-help-tier-proof', () => composeHelp(context, 'tier', 'Luna is a good default. Each row says so if this copy cannot start it.')) },
  { id: 'compose-help-effort', title: 'Toggle Effort help and preserve the actual selected effort', controls: ['compose.help.effort'], requires: ['setup'], run: context => context.step('menu-compose-help-effort-proof', () => composeHelp(context, 'effort', 'Harder thinking is slower and costs more. The tier picks a sensible default; change it here for this agent.')) },
  { id: 'compose-help-brief', title: 'Toggle Brief help without saving a node or sending a message', controls: ['compose.help.brief'], requires: ['setup'], run: context => context.step('menu-compose-help-brief-proof', () => composeHelp(context, 'message', 'Write it the way you would ask a person. One clear job is enough to start.')) },
  { id: 'compose-cancel-button', title: 'Cancel a populated composer through its visible Cancel control and discard only that draft', controls: ['compose.cancel.button'], requires: ['setup'], async run(context) {
    return context.step('menu-compose-cancel-button-proof', async () => {
      const panel = await compose(context)
      const before = await topology(context)
      const priorStarts = starts(context)
      await context.type(panel.locator('[data-compose-field="message"]'), 'UNSENT_CANCELLED_NATIVE_BRIEF')
      await context.select(panel.locator('[data-compose-field="role"]'), 'worker')
      await panel.locator('[data-compose-action="cancel"]').click()
      await panel.waitFor({ state: 'detached' })
      assert.deepEqual(await topology(context), before)
      assert.deepEqual(starts(context), priorStarts)
      const reopened = await compose(context)
      assert.equal(await reopened.locator('[data-compose-field="message"]').inputValue(), '')
      await reopened.locator('[data-compose-action="cancel"]').click()
      await reopened.waitFor({ state: 'detached' })
      return { nodes: before, starts: priorStarts, reopenedBrief: '' }
    })
  } },
  { id: 'actions-open-slash', title: 'Open the selected conversation Actions with slash and close it without sending slash text', controls: ['actions.open.slash', 'actions.escape'], requires: ['root-start'], run: context => context.step('menu-actions-open-slash-proof', () => withActions(context, async ({ card, composer, pop, filter }) => {
    assert.equal(await filter.evaluate(element => element === document.activeElement), true)
    assert.equal(await composer.inputValue(), '')
    await context.page.keyboard.press('Escape')
    await pop.waitFor({ state: 'detached' })
    assert.equal(await card.locator('[data-chat-actions]').getAttribute('aria-expanded'), 'false')
    assert.equal(await card.locator('[data-chat-actions]').evaluate(element => element === document.activeElement), true)
    assert.equal(await composer.inputValue(), '')
  }, { slash: true })) },
  { id: 'actions-filter-empty', title: 'Filter to no Actions match and restore the actual original choices without changing the draft', controls: ['actions.open.button', 'actions.filter'], requires: ['root-start'], run: context => context.step('menu-actions-filter-empty-proof', () => withActions(context, async ({ composer, pop, filter, options }) => {
    const before = await options.allTextContents()
    assert.ok(before.length > 2)
    await context.type(filter, 'no-native-action-' + context.paths.checkWord)
    assert.equal(await options.count(), 0)
    assert.equal(await pop.locator('.chat-actions-list .chat-actions-hint').innerText(), 'No action matches that. Clear the filter to see them all.')
    assert.equal(await filter.getAttribute('aria-activedescendant'), null)
    await context.type(filter, '')
    assert.deepEqual(await options.allTextContents(), before)
    assert.equal(await composer.inputValue(), 'UNSENT_NATIVE_ACTIONS_DRAFT')
  })) },
  { id: 'actions-arrow-navigation', title: 'Move the active Actions option down and up with synchronized visible and accessible selection', controls: ['actions.navigate.arrows'], requires: ['root-start'], run: context => context.step('menu-actions-arrow-navigation-proof', () => withActions(context, async ({ pop, filter, options }) => {
    const ids = await options.evaluateAll(rows => rows.map(row => row.id))
    assert.ok(ids.length > 2)
    const initial = await activeOption(pop)
    const index = ids.indexOf(initial)
    assert.ok(index >= 0)
    await filter.press('ArrowDown')
    assert.equal(await activeOption(pop), ids[(index + 1) % ids.length])
    await filter.press('ArrowUp')
    assert.equal(await activeOption(pop), initial)
    assert.equal(await filter.evaluate(element => element === document.activeElement), true)
  })) },
  { id: 'actions-home-end-navigation', title: 'Move to the last and first Actions choices and keep each active row inside the list viewport', controls: ['actions.navigate.home', 'actions.navigate.end'], requires: ['root-start'], run: context => context.step('menu-actions-home-end-navigation-proof', () => withActions(context, async ({ pop, filter, options }) => {
    const ids = await options.evaluateAll(rows => rows.map(row => row.id))
    for (const [key, expected] of [['End', ids.at(-1)], ['Home', ids[0]]]) {
      await filter.press(key)
      assert.equal(await activeOption(pop), expected)
      const visible = await pop.evaluate((element, id) => {
        const list = element.querySelector('.chat-actions-list').getBoundingClientRect()
        const row = document.getElementById(id).getBoundingClientRect()
        return row.top >= list.top - 2 && row.bottom <= list.bottom + 2
      }, expected)
      assert.equal(visible, true, `${key} must scroll its active option into the actual visible list`)
    }
  })) },
  { id: 'actions-submenu-back-escape', title: 'Return from the Effort submenu with Back and close one Actions layer with Escape', controls: ['actions.submenu.back', 'actions.escape'], requires: ['root-start'], run: context => context.step('menu-actions-submenu-back-escape-proof', () => withActions(context, async ({ card, composer, pop, filter, options }) => {
    const before = await options.allTextContents()
    await options.filter({ hasText: /^How hard it thinks/ }).click()
    await pop.getByRole('option', { name: '‹ Back', exact: true }).waitFor()
    assert.equal(await filter.isVisible(), false)
    assert.equal(await pop.locator('.chat-actions-list').evaluate(element => element === document.activeElement), true)
    await pop.getByRole('option', { name: '‹ Back', exact: true }).click()
    assert.equal(await filter.isVisible(), true)
    assert.deepEqual(await options.allTextContents(), before)
    await context.page.keyboard.press('Escape')
    await pop.waitFor({ state: 'detached' })
    assert.equal(await card.isVisible(), true, 'Closing Actions must retain its conversation card')
    assert.equal(await card.locator('[data-chat-actions]').evaluate(element => element === document.activeElement), true)
    assert.equal(await composer.inputValue(), 'UNSENT_NATIVE_ACTIONS_DRAFT')
  })) },
]

module.exports = { scenarios }
