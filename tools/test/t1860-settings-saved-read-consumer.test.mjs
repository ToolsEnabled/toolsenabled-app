import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft, draftSettingsBridge, settingsSaveFailureMessage } from '../../src/settings-draft.js'

const store = new Map()
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }

const { noteTierRecorded } = await import('../../src/setup-state.js')
const { writeStoredProfile } = await import('../../src/setup-profile.js')
const { createSetupProfileSettings } = await import('../../src/setup-profile-settings.js')
const { WRITE_ACTION_FLAGS, setWriteEnabled } = await import('../../src/write-flags.js')

const settle = async () => { for (let turn = 0; turn < 80; turn += 1) await Promise.resolve() }
const captureRejection = async promise => {
  let captured = null
  await assert.rejects(promise, error => { captured = error; return true })
  assert.ok(captured instanceof Error, 'the rejected Save carries an Error')
  return captured
}

async function fixture() {
  store.clear()
  noteTierRecorded('unrestricted')
  const state = {
    approval: 'Stop and wait for me',
    importPolicy: 'ask',
    readMode: 'available',
    writeMode: 'available',
    setCalls: [],
    policy: { selectionMode: 'manual', recorded: true, reservePercent: 37, rankWindow: 'weekly', recoverOnLimit: true, byProvider: {} },
  }
  const shell = {
    stagesWrites: true,
    read: async () => state.readMode === 'available'
      ? { ok: true, available: true, rows: [{ id: 'agent.blocked_question', value: state.approval }] }
      : { ok: true, available: false, code: 'SETTINGS_UNAVAILABLE', reason: 'Saved settings are unavailable.', rows: [] },
    set: async (id, value) => {
      state.setCalls.push({ id, value })
      return state.writeMode === 'available' ? { ok: true, value } : { ok: false, reason: 'Saved settings are unavailable.' }
    },
  }
  globalThis.mcSettings = shell
  globalThis.mcProviders = {
    accounts: async () => ({ ok: true, accounts: [{ name: 'fixture', provider: 'codex' }], policy: { ok: true, policy: structuredClone(state.policy) } }),
    accountPolicy: async request => { Object.assign(state.policy, request); return { ok: true } },
  }
  globalThis.mcSetup = {
    workspaceState: async () => ({ ok: true, available: true, roots: ['/fixture'], chosen: true }),
    tierConsent: async () => ({ ok: true, recorded: false }),
    editorSessionState: async () => ({ ok: true, importPolicy: state.importPolicy, imported: [], offered: [] }),
    setEditorImportPolicy: async value => { state.importPolicy = value; return { ok: true } },
  }
  writeStoredProfile({ status: 'complete', answers: {
    autonomy: 'autonomous', screens: 'live', approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual',
  } })
  for (const flag of WRITE_ACTION_FLAGS) setWriteEnabled(flag.id, false)

  const draft = createSettingsDraft()
  const productSettings = draftSettingsBridge(shell, draft)
  const controller = createSetupProfileSettings({ draft, productSettings, stageWrite: (...args) => draft.stage(...args) })
  let click
  const section = { querySelector: () => null, set outerHTML(value) { void value } }
  const root = {
    querySelector: selector => selector === '[data-setup-profile-system]' ? section : null,
    querySelectorAll: () => [],
    contains: () => true,
    addEventListener(type, handler) { if (type === 'click') click = handler },
    removeEventListener() {},
  }
  controller.bind(root)
  controller.afterRender(root)
  await settle()
  return {
    state, draft, productSettings, controller,
    async choose(target, value) {
      click({ target: { closest: selector => selector === '[data-setup-profile-set]'
        ? { dataset: { setupProfileSet: target, setupProfileValue: value } } : null } })
      await settle()
    },
  }
}

test('Setup consumer keeps an explicit product value dirty and visible after saved settings become unavailable', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.controller.readForProfile()).ready, true, 'the populated saved read is accepted')
    f.state.readMode = 'unavailable'
    assert.equal((await f.controller.readForProfile()).ready, false, 'the unavailable saved read is refused')

    // Observe chooses the same canonical approval value as the populated read,
    // but it is a real Setup edit (the autonomy preset resets all four intents).
    await f.choose('autonomy', 'observe')
    assert.equal(f.draft.has('product:agent.blocked_question'), true, 'the explicit value remains dirty')
    assert.equal(f.draft.value('product:agent.blocked_question'), 'Stop and wait for me')
    assert.match(f.controller.markup(), /saved permission-question policy could not be read/i)
    assert.equal(f.draft.valid, false, 'the read refusal blocks Save visibly')

    const readError = await captureRejection(f.draft.save())
    assert.match(readError.message, /saved permission-question policy could not be read/i)
    const readRefusal = settingsSaveFailureMessage(readError, f.draft)
    assert.match(readRefusal, /Unsaved changes remain/)

    // Recover through the real Setup consumer: the authoritative read succeeds
    // with a different approval, while the explicit pending choice remains.
    f.state.readMode = 'available'
    f.state.approval = 'Switch to other work'
    assert.equal((await f.controller.readForProfile()).ready, true, 'the recovered authoritative read is accepted')
    assert.notEqual(f.state.approval, f.draft.value('product:agent.blocked_question'))
    await f.choose('autonomy', 'observe')
    assert.equal(f.draft.valid, true, 'the recovered read and stage clear the visible refusal')
    assert.equal(f.draft.value('product:agent.blocked_question'), 'Stop and wait for me', 'the explicit choice survives recovery')

    // The recovered draft now reaches the durable writer, which refuses. The
    // actual refusal must keep the explicit value pending for another retry.
    f.state.writeMode = 'refuse'
    const writeError = await captureRejection(f.draft.save())
    assert.match(writeError.message, /saved settings are unavailable/i)
    assert.deepEqual(f.state.setCalls.at(-1), { id: 'agent.blocked_question', value: 'Stop and wait for me' })
    assert.equal(f.draft.has('product:agent.blocked_question'), true)
    const writeRefusal = settingsSaveFailureMessage(writeError, f.draft)
    assert.match(writeRefusal, /No changes were confirmed saved in this attempt/)
    assert.match(writeRefusal, /Unsaved changes remain/)
  } finally { f.controller.destroy() }
})

test('successful read equality still treats the same value as clean', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.controller.readForProfile()).ready, true)
    const result = await f.productSettings.set('agent.blocked_question', 'Stop and wait for me')
    assert.equal(result.ok, true)
    assert.equal(f.draft.has('product:agent.blocked_question'), false)
    assert.equal(f.draft.dirty, false)
    assert.deepEqual(f.state.setCalls, [])
  } finally { f.controller.destroy() }
})
