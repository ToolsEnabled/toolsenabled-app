import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { createTranscriptSettings } from '../../src/transcript-settings.js'
import { createActionPermissionSettings, defaultActionProfiles, ACTION_PERMISSIONS_KEY } from '../../src/action-permission-settings.js'
import { createRoleColorSettings } from '../../src/role-color-settings.js'
import { ROLE_COLORS_KEY } from '../../src/role-colors.js'
import { createHandControlSettings } from '../../src/hand-control-settings.js'

function host() {
  const handlers = new Map()
  const panel = { outerHTML: '' }
  return { handlers, panel, root: {
    addEventListener(type, fn) { handlers.set(type, fn) }, removeEventListener() {},
    querySelector() { return panel },
  } }
}

test('transcript folder, quota, and exit preference wait for Save', async () => {
  const draft = createSettingsDraft(), writes = [], fixture = host()
  const saved = { archiveDirectory: 'archive', archiveMaxBytes: 256 * 1024 * 1024, deleteNodesOnExit: false }
  const controller = createTranscriptSettings({ draft, bridge: {
    getSettings: async () => ({ ok: true, transcript: saved }),
    configure: async value => { writes.push(value); return { ok: true, transcript: value } },
    chooseArchiveDirectory: async () => ({ ok: true, directory: 'chosen-archive' }),
  } })
  controller.bind(fixture.root)
  controller.afterRender()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(controller.markup(), /Active conversation history is uncapped/)
  await fixture.handlers.get('click')({ target: { closest: () => true } })
  fixture.handlers.get('change')({ target: {
    closest: () => true, matches: selector => selector === '[data-transcript-delete]', checked: true,
  } })
  assert.deepEqual(writes, [])
  await draft.save()
  assert.deepEqual(writes, [{ ...saved, archiveDirectory: 'chosen-archive', deleteNodesOnExit: true }])
  assert.match(controller.markup(), /value="chosen-archive"/, 'returning to the category must show the saved folder')
  assert.match(controller.markup(), /data-transcript-delete checked/)
  controller.destroy()
})

test('a refused transcript save keeps the sentence the app sent back', async () => {
  // T1489: the main process answers { ok: false, error: { code, message } }; the
  // draft read only reason/message and showed 'A setting could not be saved.'
  const draft = createSettingsDraft(), fixture = host()
  const saved = { archiveDirectory: '/archive', archiveMaxBytes: 256 * 1024 * 1024, deleteNodesOnExit: false }
  const controller = createTranscriptSettings({ draft, bridge: {
    getSettings: async () => ({ ok: true, transcript: saved }),
    configure: async () => ({ ok: false, error: { code: 'MC_TRANSCRIPT_SETTINGS_INVALID', message: 'Choose a local archive folder.' } }),
    chooseArchiveDirectory: async () => ({ ok: true, directory: '/elsewhere' }),
  } })
  controller.bind(fixture.root)
  controller.afterRender()
  await new Promise(resolve => setImmediate(resolve))
  await fixture.handlers.get('click')({ target: { closest: () => true } })
  assert.equal(draft.dirty, true)
  await assert.rejects(draft.save(), error => {
    assert.equal(error.message, 'Choose a local archive folder.')
    return true
  })
  assert.equal(draft.dirty, true, 'the refused change stays pending')
  controller.destroy()
})

test('fresh permission settings leave agentResume unset while displaying the direct fallback', () => {
  assert.equal(defaultActionProfiles().profiles[0].actions.agentResume, undefined)
  const controller = createActionPermissionSettings({ draft: createSettingsDraft(), storage: { getItem: () => null } })
  assert.match(controller.markup(), /value="direct" selected/)
  controller.destroy()
})

test('permission profile exposes automatic resume only after Save', async () => {
  const stored = new Map(), draft = createSettingsDraft(), fixture = host()
  const controller = createActionPermissionSettings({ draft, storage: {
    getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value),
  } })
  controller.bind(fixture.root)
  fixture.handlers.get('change')({ target: {
    closest: () => true, matches: selector => selector === '[data-permission-mode]',
    dataset: { permissionMode: 'agentResume' }, value: 'automatic',
  } })
  assert.equal(stored.size, 0)
  assert.match(controller.markup(), /value="automatic" selected/)
  await draft.save()
  assert.equal(JSON.parse(stored.get(ACTION_PERMISSIONS_KEY)).profiles[0].actions.agentResume, 'automatic')
  assert.match(controller.markup(), /value="automatic" selected/, 'saving must not redraw the previous profile value')
  controller.destroy()
})

test('saved permission restrictions survive another edit and discard in the same Settings visit', async () => {
  const stored = new Map(), draft = createSettingsDraft(), fixture = host()
  const controller = createActionPermissionSettings({ draft, storage: {
    getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value),
  } })
  controller.bind(fixture.root)
  const change = (selector, fields) => fixture.handlers.get('change')({ target: {
    closest: () => true, matches: candidate => candidate === selector, ...fields,
  } })
  change('[data-permission-mode]', { dataset: { permissionMode: 'agentResume' }, value: 'disabled' })
  change('[data-permission-functions]', { value: 'agent.status' })
  await draft.save()

  change('[data-permission-name]', { value: 'Read only' })
  await draft.save()
  const saved = JSON.parse(stored.get(ACTION_PERMISSIONS_KEY)).profiles[0]
  assert.equal(saved.name, 'Read only')
  assert.equal(saved.actions.agentResume, 'disabled', 'renaming must not restore broader saved authority')
  assert.deepEqual(saved.functions, ['agent.status'], 'renaming must retain the saved function restriction')
  assert.match(controller.markup(), /value="disabled" selected/, 'a completed save must remain the displayed baseline')

  change('[data-permission-name]', { value: 'Discard this name' })
  draft.discard()
  assert.match(controller.markup(), /value="Read only"/)
  assert.match(controller.markup(), /value="disabled" selected/)
  controller.destroy()
})

test('permission profiles are searchable by their displayed title', () => {
  const controller = createActionPermissionSettings({ draft: createSettingsDraft(), storage: { getItem: () => null } })
  assert.equal(controller.matches('agent permission profiles'), true)
  assert.equal(controller.matches('Agent permission profiles'), true)
  assert.equal(controller.matches('unrelated missing setting'), false)
})

test('discard after a failed permission save returns to the last successfully saved profile', async () => {
  const stored = new Map(), draft = createSettingsDraft(), fixture = host()
  let failWrite = false
  const controller = createActionPermissionSettings({ draft, storage: {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => { if (failWrite) throw new Error('Storage unavailable'); stored.set(key, value) },
  } })
  controller.bind(fixture.root)
  const rename = value => fixture.handlers.get('input')({ target: {
    closest: () => true, matches: selector => selector === '[data-permission-name]', value,
  } })
  rename('Saved profile')
  await draft.save()
  failWrite = true
  rename('Unwritten profile')
  await assert.rejects(draft.save(), /Storage unavailable/)
  assert.equal(draft.dirty, true)
  assert.match(controller.markup(), /value="Unwritten profile"/)
  draft.discard()
  assert.match(controller.markup(), /value="Saved profile"/)
  assert.equal(JSON.parse(stored.get(ACTION_PERMISSIONS_KEY)).profiles[0].name, 'Saved profile')
  controller.destroy()
})

test('invalid function restrictions remain unsaved with an actionable failure', async () => {
  const draft = createSettingsDraft(), fixture = host(), writes = []
  const controller = createActionPermissionSettings({ draft, storage: { getItem: () => null, setItem: (...args) => writes.push(args) } })
  controller.bind(fixture.root)
  fixture.handlers.get('change')({ target: {
    closest: () => true, matches: selector => selector === '[data-permission-functions]', value: 'not-a-function',
  } })
  await assert.rejects(draft.save(), /exact dotted function names/)
  assert.deepEqual(writes, [])
  assert.equal(draft.dirty, true)
  controller.destroy()
})

test('typing a role color joins the shared draft without requiring the old per-color Save', async () => {
  const draft = createSettingsDraft(), fixture = host(), stored = new Map()
  const controller = createRoleColorSettings({ stageWrite: (...args) => draft.stage(...args), documentRef: null, windowRef: null,
    storage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) } })
  controller.bind(fixture.root)
  const input = { value: '#abcdef', closest: () => ({ dataset: { roleColorId: 'controller' } }) }
  fixture.handlers.get('input')({ target: { closest: () => input } })
  assert.equal(draft.dirty, true)
  assert.equal(stored.size, 0)
  await draft.save()
  assert.equal(JSON.parse(stored.get(ROLE_COLORS_KEY)).colors.controller, '#abcdef')
  controller.destroy()
})

test('mixed picker and typed role colors read back the last successful Save', async () => {
  const draft = createSettingsDraft(), fixture = host(), stored = new Map()
  const controller = createRoleColorSettings({ stageWrite: (...args) => draft.stage(...args), documentRef: null, windowRef: null,
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } })
  controller.bind(fixture.root)
  const row = { dataset: { roleColorId: 'controller' }, querySelector: () => null }
  const picker = { value: '#123456', closest: () => row }
  fixture.handlers.get('change')({ target: { closest: () => picker } })
  await draft.save()
  const hex = { value: '#abcdef', closest: () => row }
  fixture.handlers.get('input')({ target: { closest: () => hex } })
  await draft.save()
  assert.equal(JSON.parse(stored.get(ROLE_COLORS_KEY)).colors.controller, '#abcdef')
  assert.match(controller.markup(), /data-role-color-id="controller"[\s\S]*?data-role-color-picker value="#abcdef"/)
  assert.doesNotMatch(controller.markup(), /value="#123456"/)
  controller.destroy()
})

test('failed hand-control enables and durable disables remain pending for retry', async () => {
  for (const requested of [true, false]) {
    const draft = createSettingsDraft(), handlers = new Map(), writes = []
    let refuse = true, enabled = !requested
    const control = {
      getState: () => ({ enabled, message: 'Camera unavailable.' }),
      subscribe: () => () => {},
      async setEnabled(next) {
        writes.push(next)
        if (refuse) return { ok: false, reason: next ? 'Camera unavailable.' : 'Choice could not be saved.' }
        enabled = next
        return { ok: true }
      },
    }
    const controller = createHandControlSettings({ draft, stageWrite: (...args) => draft.stage(...args), getControl: () => control })
    controller.bind({ addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {}, querySelectorAll: () => [] })
    handlers.get('change')({ target: { matches: () => true, checked: requested } })
    assert.deepEqual(writes, [])
    await assert.rejects(draft.save(), requested ? /Camera unavailable/ : /could not be saved/)
    assert.equal(draft.dirty, true)
    refuse = false
    await draft.save()
    assert.equal(draft.dirty, false)
    assert.equal(enabled, requested)
    controller.destroy()
  }
})

test('an older hand-control runtime that silently refuses is not reported saved', async () => {
  const draft = createSettingsDraft(), handlers = new Map()
  const controller = createHandControlSettings({ draft, stageWrite: (...args) => draft.stage(...args), getControl: () => ({
    getState: () => ({ enabled: false, message: 'Camera access was denied.' }), subscribe: () => () => {}, setEnabled: async () => {},
  }) })
  controller.bind({ addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {}, querySelectorAll: () => [] })
  handlers.get('change')({ target: { matches: () => true, checked: true } })
  await assert.rejects(draft.save(), /Camera access was denied/)
  assert.equal(draft.dirty, true)
  controller.destroy()
})

test('a browser copy with no transcript store says where the settings are made', async () => {
  // T1517: 'Transcript settings could not be loaded. ... Close and reopen Settings'
  // in a browser, where reopening can never help.
  const controller = createTranscriptSettings({ draft: createSettingsDraft(), bridge: {} })
  controller.afterRender()
  await new Promise(resolve => setImmediate(resolve))
  const html = controller.markup()
  assert.match(html, /made in the ToolsEnabled desktop app/)
  assert.doesNotMatch(html, /could not be loaded|Close and reopen Settings|Reading transcript settings/)
  controller.destroy()
})
