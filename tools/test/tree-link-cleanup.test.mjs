/* T1420 and T1424: a direct tree link belongs to a tree's head. Removing a
 * linked head, or moving it under another tree, left its link in the engine;
 * the canvas draws only head-to-head links, so the leftover could never be
 * seen or removed from the page. The Computers view now disconnects every
 * link naming a node that was a head on this computer and no longer is.
 *
 * The move case drives the real mounted view (Details > Reports to > Save)
 * with an in-memory link directory in place of the engine's. The removal case
 * runs the view's own dropLinksOfFormerHeads over a store snapshot with the
 * head gone, because the removal door is a confirmation popup this DOM
 * stand-in does not draw; both reach the same store subscription. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { installWorld, mountView, settle, fleetFetch, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const STAMP = '2026-09-22T00:00:00.000Z'
const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

function linkDirectory(initial) {
  let links = initial.map(link => ({ ...link }))
  const calls = []
  return {
    calls,
    links: () => links.map(link => ({ ...link })),
    bridge: {
      async treeLinks() { calls.push(['read']); return { ok: true, links: links.map(link => ({ ...link })) } },
      async setTreeLink(request) {
        calls.push(['set', { ...request }])
        const [first, second] = [request.from, request.to].sort()
        links = links.filter(link => !(link.from === first && link.to === second))
        if (request.connected) links.push({ from: first, to: second })
        return { ok: true, links: links.map(link => ({ ...link })) }
      },
    },
  }
}

test('moving a linked tree head under another tree disconnects its direct link in the engine', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const node = (id, treeId, parentId = null) => ({ id, treeId, parentId, status: 'draft', role: 'worker',
    message: `Brief for ${id}`, statusNote: '', sessionId: null, createdAt: STAMP, updatedAt: STAMP })
  world.storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({ version: 1, computerId: COMPUTER_ID,
    trees: ['tree-a', 'tree-b', 'tree-c'].map(id => ({ id, name: null, createdAt: STAMP, updatedAt: STAMP, profileId: null })),
    nodes: [node('head-a', 'tree-a'), node('head-b', 'tree-b'), node('child-b', 'tree-b', 'head-b'), node('head-c', 'tree-c')] }))
  const directory = linkDirectory([{ from: 'head-a', to: 'head-c' }, { from: 'head-b', to: 'head-c' }])
  Object.assign(globalThis.window.mcAgent, directory.bridge)
  let view = null
  t.after(async () => { await view?.destroy(); view?.el?.remove?.(); world.restore() })
  view = await mountView(world)
  await settle()

  const graph = globalThis.window.__mcGraph
  graph.onOpenControls({ id: 'head-a', treeNode: JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes[0] })
  await settle()
  const select = view.el.querySelector('[data-tree-move-select]')
  assert.ok(select, 'the Reports-to control mounted for the head')
  select.value = 'child-b'
  select.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()

  const saved = JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(entry => entry.id === 'head-a')
  assert.equal(saved.parentId, 'child-b', 'fixture premise: the head moved under another tree')
  assert.deepEqual(directory.links(), [{ from: 'head-b', to: 'head-c' }],
    'the moved head is no longer a head, so its link is gone from the engine; other links stay')
  assert.deepEqual(directory.calls.filter(([kind]) => kind === 'set'), [['set', { from: 'head-a', to: 'head-c', connected: false }]])
})

test('removing a linked head disconnects every link that names it, and nothing else', async () => {
  const directory = linkDirectory([{ from: 'head-a', to: 'head-c' }, { from: 'head-b', to: 'head-c' }, { from: 'elsewhere-1', to: 'elsewhere-2' }])
  const said = []
  const scope = {
    treeHeadIds: new Set(['head-a', 'head-b', 'head-c']),
    mockSource: () => false, window: { mcAgent: directory.bridge }, graph: {}, destroyed: false,
    readDirectTreeLinks: async () => {}, orgStatusPrimary: { text: 'Removed Controller (head-b) and its branch.', state: 'ok' },
    setOrgStatus: (...args) => said.push(args),
  }
  const drop = new Function(...Object.keys(scope), `const treeHeadIdsOf = ${VIEW.match(/const treeHeadIdsOf = ([^\n]+)/)[1]}
${declaredFunctionSource(VIEW, 'dropLinksOfFormerHeads')}; return dropLinksOfFormerHeads`)(...Object.values(scope))
  drop({ nodes: [{ id: 'head-a', parentId: null }, { id: 'head-c', parentId: null }] })
  await settle()
  assert.deepEqual(directory.links(), [{ from: 'head-a', to: 'head-c' }, { from: 'elsewhere-1', to: 'elsewhere-2' }],
    'the removed head\'s link is gone; links of heads still here and of other computers stay')
  assert.deepEqual(said, [['Removed Controller (head-b) and its branch. Its direct tree link was removed too.', 'ok']])
})
