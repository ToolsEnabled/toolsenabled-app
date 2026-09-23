/* The public contract of the Setup section, exercised through the same inputs
 * as src/views/settings.js and src/views/setup.js.  This is deliberately not a
 * markup snapshot: people pay for the decisions and explanations surviving,
 * not for a particular arrangement of tags or a frozen sentence. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
}
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
}

let rejectConsentRead = false
globalThis.mcSetup = {
  bootstrap: { ok: true, available: true, configured: true, tier: 'unrestricted' },
  chooseTier: async tier => ({ ok: true, tier }),
  setEditorImportPolicy: async importPolicy => ({ ok: true, importPolicy }),
  workspaceState: async () => ({ ok: true, available: true, roots: ['/work'], chosen: true }),
  tierConsent: async () => {
    if (rejectConsentRead) throw new Error('ledger offline')
    return { ok: true, recorded: false }
  },
}
globalThis.mcSettings = { set: async () => ({ ok: true }) }
globalThis.mcProviders = { accountPolicy: async () => ({ ok: true }) }

const {
  SETUP_PROFILE_SETTING_COUNT,
  createSetupProfileSettings,
  setupRefusalDetail,
} = await import('../../src/setup-profile-settings.js')

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }

function fakeHost(initialMarkup) {
  let listener = null
  const listeners = new Map()
  const painted = [initialMarkup]
  const section = {
    querySelector: () => null,
    set outerHTML(value) { painted.push(String(value)) },
  }
  const root = {
    addEventListener: (type, fn) => { listeners.set(type, fn); if (type === 'click') listener = fn },
    removeEventListener: () => {},
    contains: () => true,
    querySelector: selector => selector === '[data-setup-profile-system]' ? section : null,
  }
  return {
    root,
    last: () => painted.at(-1),
    fieldEvent(type, selector, field) {
      const handler = listeners.get(type)
      assert.ok(handler, `the settings controller did not attach its ${type} handler`)
      handler({ target: { closest: match => match === selector ? field : null } })
    },
    pressAction(action) {
      assert.ok(listener, 'the settings controller did not attach its click handler')
      listener({
        target: {
          closest: selector => selector === '[data-setup-profile-action]'
            ? { dataset: { setupProfileAction: action } }
            : null,
        },
      })
    },
  }
}

test('the protection scale runs from Guided at the top to unrestricted at the bottom', () => {
  const controller = createSetupProfileSettings()
  const html = controller.markup()
  const scale = html.match(/<div[^>]*data-level-slider>([\s\S]*?)<\/div>/)?.[1]
  assert.ok(scale, 'the permission choices must remain visibly grouped')
  const choices = [...scale.matchAll(/data-setup-profile-value="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(choices, ['guided', 'standard', 'unrestricted'],
    'More protected must identify the read-only choice, not bypassed permissions')
  assert.ok(scale.indexOf('More protected') < scale.indexOf('data-setup-profile-value="guided"'))
  assert.ok(scale.indexOf('Nothing off limits') > scale.indexOf('data-setup-profile-value="unrestricted"'))
  assert.match(scale, /data-setup-profile-value="unrestricted" aria-pressed="true"/,
    'display order must not change the currently selected permission policy')
})

test('saved-session lookup is reachable from Settings and sends the exact selected identifiers', async () => {
  const prior = globalThis.mcSetup.editorSessionState
  const ids = ['11111111-2222-3333-4444-555555555555', '22222222-3333-4444-5555-666666666666']
  const calls = []
  globalThis.mcSetup.editorSessionState = async options => {
    calls.push(options)
    return { ok: true, importPolicy: 'none', importedSurfaces: [], surfaces: [], imported: [], discovery: 'complete' }
  }
  const controller = createSetupProfileSettings()
  const host = fakeHost(controller.markup())
  const query = host.root.querySelector
  let value = ids.join(', ')
  host.root.querySelector = selector => selector === '[data-editor-selected-ids]' ? { value } : query(selector)
  try {
    assert.match(controller.markup(), /aria-label="Saved session IDs"/)
    controller.bind(host.root)
    host.pressAction('check-editors')
    await settle()
    assert.deepEqual(calls[0], { discover: true, selectedSessionIds: ids })
    value = ''
    host.pressAction('check-editors')
    await settle()
    assert.deepEqual(calls[1], { discover: true })
  } finally {
    controller.destroy()
    if (prior === undefined) delete globalThis.mcSetup.editorSessionState
    else globalThis.mcSetup.editorSessionState = prior
  }
})

test('copy role and continuing request survive ordinary attachment menu changes', async () => {
  const priorSessions = globalThis.mcSetup.editorSessionState
  const priorOrg = globalThis.mcOrg
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const key = 'saved-source'
  globalThis.mcSetup.editorSessionState = async () => ({
    ok: true, surfaces: [], importedSurfaces: [], discovery: 'complete',
    imported: [{ provider: 'codex', surface: 'codex-cli', sessionId, sourceRef: key,
      receipt: 'offered-receipt', capabilities: { mirror: true, fork: true } }],
  })
  globalThis.mcOrg = { read: async () => ({ ok: true, roles: [{ id: 'release-manager', name: 'Release Manager' }] }) }
  const controller = createSetupProfileSettings()
  const host = fakeHost(controller.markup())
  const mode = value => host.fieldEvent('change', '[data-editor-attachment-mode]', {
    dataset: { editorAttachmentMode: key }, value,
  })
  try {
    controller.bind(host.root)
    host.pressAction('check-editors')
    await settle()
    mode('fork')
    assert.match(host.last(), /value="release-manager"/)
    host.fieldEvent('change', '[data-editor-copy-role]', {
      dataset: { editorCopyRole: key }, value: 'release-manager',
    })
    host.fieldEvent('input', '[data-editor-copy-message]', {
      dataset: { editorCopyMessage: key }, value: 'Continue release verification <carefully> & report to Controller.',
    })
    mode('mirror')
    mode('fork')
    assert.match(host.last(), /value="release-manager" selected/)
    assert.match(host.last(), /Continue release verification &lt;carefully&gt; &amp; report to Controller\./)
    assert.match(host.last(), /maxlength="12000"/)
  } finally {
    controller.destroy()
    if (priorSessions === undefined) delete globalThis.mcSetup.editorSessionState
    else globalThis.mcSetup.editorSessionState = priorSessions
    if (priorOrg === undefined) delete globalThis.mcOrg
    else globalThis.mcOrg = priorOrg
  }
})

test('refusals preserve an actionable sentence from both shapes real callers pass', () => {
  const handlerFailure = setupRefusalDetail({
    ok: false,
    error: { code: 'MC_FLEET_PROFILE_ACTION_FAILED', message: "Failed to get 'documents' path" },
  })
  assert.match(handlerFailure, /failed.+documents.+path/i,
    'the shell handler failure lost the actionable sentence in error.message')

  const checkFailure = setupRefusalDetail({
    ok: false,
    code: 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED',
    reason: 'That is the top of a whole drive. Choose a folder inside it instead.',
  })
  assert.match(checkFailure, /whole drive.+choose.+folder inside/i,
    'the workspace check failure lost its reason and remedy')
})

test('codes and silent failures become an honest explanation, not code-shaped copy', () => {
  const fromCode = setupRefusalDetail({ error: { message: 'MC_FLEET_PROFILE_ACTION_FAILED' } })
  assert.match(fromCode, /application.+did not.+say why/i,
    'a bare internal identifier was presented as though it explained the refusal')

  const customFallback = setupRefusalDetail(null, 'No explanation reached this screen.')
  assert.match(customFallback, /no explanation.+screen/i,
    'a caller-supplied explanation for a silent failure was discarded')
})

test('the settings controller exposes all paid-for rows, search, and walkthrough navigation', () => {
  let destination = null
  const controller = createSetupProfileSettings({ navigate: hash => { destination = hash } })
  const markup = controller.markup()

  assert.equal(SETUP_PROFILE_SETTING_COUNT, 8,
    'the exported count no longer accounts for the eight setup settings shown to users')
  assert.match(markup, /permission level[\s\S]+working folders[\s\S]+acting on its own[\s\S]+what the screens show/i,
    'the Setup section no longer presents its permission, folder, autonomy, and screen choices together')
  assert.match(markup, /asks for no subscription[\s\S]+(?:key|password)[\s\S]+stores none/i,
    'the Setup section no longer explains that it asks for and stores no provider credentials')
  assert.equal(controller.matches('working folder'), true,
    'Settings search no longer finds Setup by the working-folder words users search for')

  const host = fakeHost(markup)
  controller.bind(host.root)
  host.pressAction('walkthrough')
  assert.equal(destination, '#/setup', 'the “walk through setup again” action did not navigate to Setup')
  controller.destroy()
})

test('Docker search exposes an optional sandbox door using the existing walkthrough action without writes', () => {
  const destinations = []
  const staged = []
  const before = [...store.entries()]
  const controller = createSetupProfileSettings({
    navigate: hash => destinations.push(hash),
    stageWrite: (...args) => staged.push(args),
  })
  for (const query of ['Docker', 'sandbox', 'installation', 'readiness check', 'sandbox image']) {
    assert.equal(controller.matches(query), true, `${query} must find the optional setup door`)
  }
  assert.equal(controller.matches('unrelated-nonexistent-setting'), false)
  const markup = controller.markup({ searchResult: true })
  const row = markup.match(/<article[^>]*data-setup-profile-row="sandbox-setup"[\s\S]*?<\/article>/)?.[0]
  assert.ok(row, 'search results must render the discoverable sandbox setup row')
  assert.match(row, /Docker and sandbox setup \(optional\)/)
  assert.match(row, /not normal Claude or Codex agents or tree delegation/)
  assert.match(row, /review page[\s\S]*Set up Docker \(optional\)/)
  assert.match(row, /does not install Docker or grant permissions/)
  const action = row.match(/data-setup-profile-action="([^"]+)"/)?.[1]
  assert.equal(action, 'walkthrough', 'use the existing setup flow, not a second backend')
  const host = fakeHost(markup)
  controller.bind(host.root)
  host.pressAction(action)
  assert.deepEqual(destinations, ['#/setup'])
  assert.deepEqual(staged, [], 'navigation must not stage policy or permission changes')
  assert.deepEqual([...store.entries()], before, 'navigation must not write setup answers')
  controller.destroy()
})

test('a consent record that cannot be read remains unknown on the rendered row', async () => {
  rejectConsentRead = true
  const controller = createSetupProfileSettings()
  const host = fakeHost(controller.markup())
  controller.bind(host.root)
  controller.afterRender(host.root)
  await settle()

  assert.match(host.last(), /whether.+risk.+confirmed.+could not be read.+record/i,
    'a failed consent-record read collapsed uncertainty into a definite consent answer')
  controller.destroy()
  rejectConsentRead = false
})
test('recommended profile changes are staged when hosted by Settings', async () => {
  store.clear()
  const staged = new Map()
  const controller = createSetupProfileSettings({ stageWrite: (key, value, write) => { staged.set(key, { value, write }); return value } })
  const host = fakeHost(controller.markup())
  controller.bind(host.root)
  host.pressAction('recommended')
  await settle()
  assert.equal(store.has('mc.setup.profile'), false)
  assert.equal(staged.has('setup:profile'), true)
  const pending = staged.get('setup:profile')
  await pending.write(pending.value)
  assert.equal(store.has('mc.setup.profile'), true)
  controller.destroy()
})

test('the suggested working folder can be confirmed in one press, without the native picker', async () => {
  const prior = globalThis.mcSetup
  const writes = [], staged = new Map()
  let picks = 0
  globalThis.mcSetup = {
    ...prior,
    workspaceState: async () => ({ ok: true, available: true, configured: true, chosen: false, roots: ['/fixture/suggested'] }),
    chooseWorkspace: async () => { picks += 1; return { canceled: true } },
    recordWorkspaces: async roots => { writes.push(roots); return { ok: true, roots } },
  }
  const controller = createSetupProfileSettings({ stageWrite: (key, value, write) => staged.set(key, { value, write }) })
  const host = fakeHost(controller.markup())
  try {
    controller.bind(host.root)
    controller.afterRender(host.root)
    await settle()
    assert.match(host.last(), /data-setup-profile-action="confirm-folder"/, 'a person who accepts the suggested folder needs a control that is not the native picker')
    assert.match(host.last(), /Use this folder/)
    host.pressAction('confirm-folder')
    await settle()
    assert.equal(picks, 0, 'confirming the suggested folder must not open the native picker')
    assert.match(host.last(), /Save settings to apply this working folder/)
    const pending = staged.get('setup:workspace')
    assert.ok(pending, 'confirming the suggested folder stages a working-folder write')
    assert.deepEqual(pending.value, ['/fixture/suggested'], 'the confirmed folder is the one the app suggested')
    assert.equal(writes.length, 0, 'the confirmed folder waits for Save settings')
    await pending.write(pending.value)
    assert.deepEqual(writes, [['/fixture/suggested']])
  } finally {
    controller.destroy()
    globalThis.mcSetup = prior
  }
})

test('working-folder recovery keeps cancellation inert and records only the folder explicitly chosen and saved', async () => {
  const prior = globalThis.mcSetup
  const writes = [], staged = new Map()
  let picks = 0
  globalThis.mcSetup = {
    ...prior,
    workspaceState: async () => ({ ok: true, available: true, configured: true, chosen: false, roots: ['/fixture/suggested'] }),
    chooseWorkspace: async () => ++picks === 1 ? { canceled: true } : { ok: true, path: '/fixture/person-picked' },
    recordWorkspaces: async roots => { writes.push(roots); return { ok: true, roots } },
  }
  const controller = createSetupProfileSettings({ stageWrite: (key, value, write) => staged.set(key, { value, write }) })
  const host = fakeHost(controller.markup())
  try {
    controller.bind(host.root)
    controller.afterRender(host.root)
    await settle()
    assert.match(host.last(), /Working folders/)
    assert.match(host.last(), /Nobody has been asked about this yet/)
    assert.equal(picks, 0)
    assert.equal(writes.length, 0, 'reading the recovery path grants no workspace')
    host.pressAction('choose-folder')
    await settle()
    assert.equal(staged.has('setup:workspace'), false, 'Cancel keeps the suggested folder unconfirmed')
    assert.equal(writes.length, 0)
    host.pressAction('choose-folder')
    await settle()
    assert.match(host.last(), /Save settings to apply this working folder/)
    assert.equal(writes.length, 0, 'picker selection waits for Save settings')
    const pending = staged.get('setup:workspace')
    assert.deepEqual(pending.value, ['/fixture/person-picked'])
    await pending.write(pending.value)
    assert.deepEqual(writes, [['/fixture/person-picked']], 'only the explicit chosen path is recorded')
  } finally {
    controller.destroy()
    globalThis.mcSetup = prior
  }
})
