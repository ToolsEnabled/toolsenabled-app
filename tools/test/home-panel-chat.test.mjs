// THE HOME PANEL'S OWN CHAT, driven through the real Home view (helper:
// home-additions-world.mjs, inert bridges, nothing is started or sent).
//   T1515 the heading of an agent with no run record names it, never its node id
//   T1498 Full view from an agent's panel chat opens that conversation with the typed words
//   T1528 leaving Home while Full view is open leaves no hidden conversation owner behind
//   T1570 Back to list returns to the tree the chat was opened from
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { homeFixture, until, settle, THIS_COMPUTER_ID, fleetTreesStorageKey } from './helpers/home-additions-world.mjs'
// The window event a completed removal sends (src/fleet-trees.js TREE_NODE_REMOVED_EVENT,
// pinned in node-remove); spelled here so this suite also runs where it is absent.
const TREE_NODE_REMOVED_EVENT = 'mc-tree-node-removed'

const STAMP = '2026-09-22T00:00:00.000Z'
const TREE = 'tree-1-6a83ca13-23c4-4b8d'
const NODE = 'node-2-f885ad47-771b-4509-a1b2'
// One saved agent whose session has ended: the state every agent is in after a run and a restart.
function seedEndedAgent(storage) {
  storage.setItem(fleetTreesStorageKey(THIS_COMPUTER_ID), JSON.stringify({ version: 1, computerId: THIS_COMPUTER_ID,
    trees: [{ id: TREE, name: null, createdAt: STAMP, updatedAt: STAMP, profileId: null }],
    nodes: [{ id: NODE, treeId: TREE, status: 'finished', createdAt: STAMP, updatedAt: STAMP, role: 'builder',
      message: 'Tidy the notes', statusNote: '', sessionId: 'sess-ended-0001', parentId: null }] }))
}
const picker = view => view.el.querySelector('[data-home-agent]')
const pickOptions = view => [...picker(view).querySelectorAll('option')]
const owners = () => document.body.querySelectorAll('.home-agent-runtime-owner').length
const panelInput = view => view.el.querySelector('[data-home-chat]')?.querySelector('.chat-input input') || null
function activePaneInput(view) {
  const pane = [...view.el.querySelectorAll('.home-chat-pane')].find(node => node.dataset.active === 'true')
  return pane?.querySelector('.chat-input input') || null
}
async function pickAgent(view) {
  const option = await until(() => pickOptions(view).find(node => node.dataset.kind === 'agent' && node.value === NODE), 'the saved agent is offered in the panel picker')
  picker(view).value = option.value; picker(view).dispatch('change')
  await settle(16)
  return option
}

test('an agent with no run record is headed by its name, not its internal node id', async t => {
  const f = await homeFixture(t)
  seedEndedAgent(f.world.storage)
  const view = await f.mount()
  const option = await pickAgent(view)
  const heading = view.el.querySelector('[data-panel-title]').textContent
  assert.doesNotMatch(heading, /node-/, 'the heading shows no internal id')
  assert.ok(heading.length > 0)
  assert.ok(option.textContent.startsWith(heading), `the heading names the agent the way the picker does: ${heading} / ${option.textContent}`)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('Full view from an agent chat in the panel opens that conversation with the typed words, and leaving Home leaks no owner', async t => {
  const f = await homeFixture(t)
  seedEndedAgent(f.world.storage)
  const before = owners()
  const view = await f.mount()
  await pickAgent(view)
  const input = await until(() => panelInput(view), 'the agent chat opens in the panel')
  input.value = 'words typed in the panel'; input.dispatch('input')
  view.el.querySelector('[data-chat-expand]').click()
  await settle(16)
  assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, false)
  assert.equal(view.el.querySelector('[data-chat-subject]').value, `agent:${THIS_COMPUTER_ID}:${NODE}`, 'Full view opens on the agent, not on Everything')
  const pane = await until(() => activePaneInput(view), 'the agent window mounts its chat')
  assert.equal(pane.value, 'words typed in the panel', 'the typed words ride into the Full view window')
  await f.close(view)
  await settle(16)
  assert.equal(owners(), before, 'no hidden conversation owner outlives Home')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('Back to list returns to the tree the chat was opened from', async t => {
  const f = await homeFixture(t, { source: 'mock' })
  const view = await f.mount()
  const choose = value => { picker(view).value = value; picker(view).dispatch('change') }
  const tree = pickOptions(view).find(node => node.dataset.kind === 'tree')
  assert.ok(tree, 'the example offers a tree')
  choose(tree.value); await settle(8)
  // An agent of that tree, as the picker lists it right under the tree.
  const options = pickOptions(view)
  const agent = options.slice(options.indexOf(options.find(node => node.value === tree.value)) + 1).find(node => node.dataset.kind === 'agent')
  assert.ok(agent, 'the tree has an agent to chat with')
  choose(agent.value); await settle(8)
  assert.equal(view.el.querySelector('[data-home-chat-toolbar]').hidden, false, 'the agent chat is open')
  view.el.querySelector('[data-chat-toolbar-back]').click(); await settle(8)
  assert.equal(picker(view).value, tree.value, 'the tree the person was browsing comes back')
  choose(''); await settle(8)
  choose(agent.value); await settle(8)
  view.el.querySelector('[data-chat-toolbar-back]').click(); await settle(8)
  assert.equal(picker(view).value, '', 'from All trees it returns to All trees')
})

// T1554, T1562: removing an agent from its Home panel chat or its Full view
// window left Home showing and selecting it, under "This conversation is no
// longer available". What the Computers view does on a real removal is
// replayed here: the store loses the agent, then the window hears it.
function removeSeededAgent(f) {
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID)
  const saved = JSON.parse(f.world.storage.getItem(key))
  f.world.storage.setItem(key, JSON.stringify({ ...saved, nodes: saved.nodes.filter(node => node.id !== NODE) }))
  window.dispatchEvent(new CustomEvent(TREE_NODE_REMOVED_EVENT, { detail: { computerId: THIS_COMPUTER_ID, nodeId: NODE, sentence: 'Removed Builder and its saved conversation here.' } }))
}

test('removing the agent open in the panel returns to the list, drops it from the picker and says it was removed', async t => {
  const f = await homeFixture(t)
  seedEndedAgent(f.world.storage)
  const view = await f.mount()
  await pickAgent(view)
  await until(() => view.el.querySelector('[data-home-chat]')?.querySelector('.chat-input input'), 'the agent chat opens in the panel')
  removeSeededAgent(f)
  await settle(16)
  assert.ok(!pickOptions(view).some(option => option.value === NODE), 'the removed agent is gone from the picker')
  assert.equal(view.el.querySelector('[data-home-chat-toolbar]').hidden, true, 'the panel is back on the list')
  const note = view.el.querySelector('[data-home-removal-note]')
  assert.equal(note.hidden, false)
  assert.equal(note.textContent, 'Removed Builder and its saved conversation here.')
  assert.doesNotMatch(view.el.textContent, /no longer available/, 'no error for an agent the person just removed')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('removing an agent closes its Full view window and the Open picker stops offering it', async t => {
  const f = await homeFixture(t)
  seedEndedAgent(f.world.storage)
  const view = await f.open()
  const subject = `agent:${THIS_COMPUTER_ID}:${NODE}`
  const picker = view.el.querySelector('[data-chat-subject]')
  assert.ok([...picker.querySelectorAll('option')].some(option => option.value === subject))
  picker.value = subject; picker.dispatch('change')
  await settle(16)
  assert.ok([...view.el.querySelectorAll('.home-chat-pane-title')].some(title => /Builder/.test(title.textContent)), 'the agent window is open')
  removeSeededAgent(f)
  await settle(16)
  assert.ok(![...picker.querySelectorAll('option')].some(option => option.value === subject), 'the Open picker no longer offers the removed agent')
  assert.ok(![...view.el.querySelectorAll('.home-chat-pane-title')].some(title => /Builder/.test(title.textContent)), 'its window is closed')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

// T1576: a tree name within the 80-character limit widened the picker's
// max-content track to 456px of a 543px head and squeezed the heading to one
// letter per line. The geometry is measured in a browser (see the commit);
// this pins the rule that bounds the picker's track and ends its label.
test('the panel picker takes at most half of the header, so a long tree name cannot squeeze the heading', () => {
  const css = readFileSync(new URL('../../src/home-context.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const wide = css.slice(css.indexOf('@container home-context (min-width: 700px)'))
  assert.match(wide.slice(0, 1200), /grid-template-columns: minmax\(0, 1fr\) fit-content\(50%\) auto;/, 'the picker track is bounded')
  assert.doesNotMatch(wide.slice(0, 1200), /minmax\(0, max-content\)/, 'no unbounded picker track')
  const pick = css.match(/\.home-agent-pick \{[^}]*\}/)?.[0] || ''
  assert.match(pick, /text-overflow: ellipsis/, 'a cut label ends in an ellipsis')
})
