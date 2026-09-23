import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, mountView, settle } from './lib/tree-command-real-mount.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const oldProfile = { id: 'old-folder', name: 'Existing folder', cwd: 'C:\\Users\\ToolsEnabled-Dev\\Desktop\\Existing Folder' }
const newProfile = { id: 'new-folder', name: 'QA added folder', cwd: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp\\QA Session With Spaces' }

function deferred() {
 let resolve
 const promise = new Promise(yes => { resolve = yes })
 return { promise, resolve }
}

async function fixture(t, { initialProfiles = [oldProfile], readProfiles } = {}) {
 const world = await installWorld(fleetFetch())
 let profiles = [...initialProfiles], reads = 0
 world.bridge.profiles = async () => {
  const answer = { ok: true, profiles: [...profiles] }
  return readProfiles ? readProfiles(++reads, answer) : answer
 }
 world.bridge.profileCreate = async () => { profiles.push(newProfile); return { ok: true, profile: newProfile } }
 world.bridge.profileRemove = async ({profileId}) => { profiles = profiles.filter(row => row.id !== profileId); return { ok: true, removed: true } }
 let view
 t.after(() => { view?.destroy(); world.restore() })
 view = await mountView(world)
 const node = selector => { const found = view.el.querySelector(selector); assert.ok(found, `Missing mounted control: ${selector}`); return found }
 const openComposer = async () => {
  node('.tree-chat-add').click()
  node('.tree-new-tree').click()
  await settle(3)
  return node('[data-compose-field="profile"]')
 }
 return { world, view, node, openComposer }
}

test('a folder created through the mounted profile panel is offered to a new tree without navigating away', async t => {
 const f = await fixture(t)
 f.node('[data-profile-name]').value = newProfile.name
 f.node('[data-profile-add]').click()
 await settle(10)
 assert.match(f.node('[data-profile-list]').textContent, /QA added folder/)
 const folders = await f.openComposer()
 assert.deepEqual(folders.children.map(option => option.value), ['', oldProfile.id, newProfile.id])
})

test('removing a folder through the mounted profile panel removes it from the same-visit new-tree menu', async t => {
 const f = await fixture(t)
 f.node('[data-profile-remove]').click()
 await settle(10)
 const folders = await f.openComposer()
 assert.deepEqual(folders.children.map(option => option.value), [''])
})

test('a completed folder picker refresh preserves a compose draft opened while the picker awaited', async t => {
 const f = await fixture(t)
 const pending = deferred()
 const create = f.world.bridge.profileCreate
 f.world.bridge.profileCreate = async request => { await pending.promise; return create(request) }
 f.node('[data-profile-name]').value = newProfile.name
 f.node('[data-profile-add]').click()
 const folders = await f.openComposer()
 folders.value = oldProfile.id
 const message = f.node('[data-compose-field="message"]')
 const role = f.node('[data-compose-field="role"]')
 const tier = f.node('[data-compose-field="tier"]')
 const effort = f.node('[data-compose-field="effort"]')
 message.value = 'Keep this unsent brief and its selection.'
 message.selectionStart = 5; message.selectionEnd = 9
 role.value = 'builder'; tier.value = 'terra'; effort.value = 'high'
 message.focus()
 pending.resolve()
 await settle(10)
 assert.equal(f.node('[data-compose-field="message"]'), message, 'a store refresh must not reopen the form')
 assert.equal(message.value, 'Keep this unsent brief and its selection.')
 assert.deepEqual([message.selectionStart, message.selectionEnd], [5, 9])
 assert.equal(globalThis.document.activeElement, message)
 assert.deepEqual([role.value, tier.value, effort.value, folders.value], ['builder', 'terra', 'high', oldProfile.id])
 assert.deepEqual(folders.children.map(option => option.value), ['', oldProfile.id, newProfile.id])
})

test('removing the selected folder refreshes an open draft to the explicit default and retains its text', async t => {
 const f = await fixture(t)
 const pending = deferred(), remove = f.world.bridge.profileRemove
 f.world.bridge.profileRemove = async request => { await pending.promise; return remove(request) }
 f.node('[data-profile-remove]').click()
 const folders = await f.openComposer()
 folders.value = oldProfile.id
 const message = f.node('[data-compose-field="message"]')
 message.value = 'A draft whose named folder was removed.'
 pending.resolve()
 await settle(10)
 assert.equal(f.node('[data-compose-field="message"]'), message)
 assert.equal(message.value, 'A draft whose named folder was removed.')
 assert.deepEqual(folders.children.map(option => option.value), [''])
 assert.equal(folders.value, '')
})

test('a late initial profile read cannot overwrite the folder list observed after a successful create', async t => {
 const initial = deferred()
 const f = await fixture(t, { readProfiles: (number, answer) => number === 1 ? initial.promise : answer })
 f.node('[data-profile-name]').value = newProfile.name
 f.node('[data-profile-add]').click()
 await settle(10)
 const folders = await f.openComposer()
 assert.ok(folders.children.some(option => option.value === newProfile.id))
 initial.resolve({ ok: true, profiles: [oldProfile] })
 await settle(10)
 assert.equal(f.node('[data-compose-field="profile"]'), folders)
 assert.deepEqual(folders.children.map(option => option.value), ['', oldProfile.id, newProfile.id])
 assert.match(f.node('[data-profile-list]').textContent, /QA added folder/)
})

test('an older mutation refresh cannot restore a folder removed by a newer mutation', async t => {
 const firstRefresh = deferred()
 let held = false
 const f = await fixture(t, { initialProfiles: [oldProfile, newProfile], readProfiles: (_number, answer) => {
  if (answer.profiles.length === 1 && !held) { held = true; return firstRefresh.promise }
  return answer
 } })
 f.node('[data-profile-remove="old-folder"]').click()
 await settle(3)
 assert.equal(held, true)
 f.node('[data-profile-remove="new-folder"]').click()
 await settle(10)
 const folders = await f.openComposer()
 assert.deepEqual(folders.children.map(option => option.value), [''])
 firstRefresh.resolve({ ok: true, profiles: [newProfile] })
 await settle(10)
 assert.deepEqual(folders.children.map(option => option.value), [''])
 assert.doesNotMatch(f.node('[data-profile-list]').textContent, /QA added folder/)
})
