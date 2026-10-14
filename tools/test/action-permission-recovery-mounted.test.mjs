import assert from 'node:assert/strict'
import test from 'node:test'
import * as permissionSettings from '../../src/action-permission-settings.js'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const {
  ACTION_PERMISSIONS_KEY,
  createActionPermissionSettings,
  defaultActionProfiles,
} = permissionSettings
const ACTION_PERMISSIONS_RECOVERY_PREFIX = 'mc.action-permissions.recovery.'

const invalidInputs = [
  ['malformed JSON', '{"v":1,"profiles":'],
  ['unsupported version', JSON.stringify({ v: 2, activeProfileId: 'default', profiles: [] })],
  ['invalid record', JSON.stringify({ v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: '', parentId: null, actions: {}, functions: null }] })],
]

function makeStorage(raw, { failRead = () => false, failWrite = () => false } = {}) {
  const values = new Map([[ACTION_PERMISSIONS_KEY, raw]])
  const events = []
  const writes = []
  const storage = {
    getItem(key) {
      events.push({ op: 'read', key })
      if (failRead(key, values)) throw new Error('saved permission profiles could not be read')
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      const text = String(value)
      events.push({ op: 'write', key, value: text })
      writes.push({ key, value: text })
      const failure = failWrite(key, text, values)
      if (failure && typeof failure === 'object' && failure.ok === false) return failure
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
      values.set(key, text)
      return { ok: true, key, value: text }
    },
    preserve(key, value) { return this.setItem(key, value) },
    save(value, { expectedValue } = {}) {
      const current = this.getItem(ACTION_PERMISSIONS_KEY)
      if (expectedValue !== undefined && current !== expectedValue) return { ok: false, error: { message: 'saved permission profiles changed' } }
      return this.setItem(ACTION_PERMISSIONS_KEY, typeof value === 'string' ? value : JSON.stringify(value))
    },
    removeItem(key) {
      events.push({ op: 'remove', key })
      values.delete(key)
    },
  }
  return { storage, values, events, writes }
}

function installOuterHtmlPolyfill() {
  const elementPrototype = Object.getPrototypeOf(document.createElement('div'))
  const previous = Object.getOwnPropertyDescriptor(elementPrototype, 'outerHTML')
  if (!previous) {
    Object.defineProperty(elementPrototype, 'outerHTML', {
      configurable: true,
      get() { return this.innerHTML },
      set(value) {
        if (!this.parentNode) return
        const holder = document.createElement('div')
        holder.innerHTML = String(value)
        const replacement = holder.firstElementChild
        if (replacement) this.replaceWith(replacement)
        else this.remove()
      },
    })
  }
  return () => { if (!previous) delete elementPrototype.outerHTML }
}

function mountPanel(t, raw, options = {}) {
  const dom = installDomStandIn()
  const restoreOuterHtml = installOuterHtmlPolyfill()
  const storageFixture = makeStorage(raw, options)
  const draft = createSettingsDraft()
  const controller = createActionPermissionSettings({
    draft,
    storage: storageFixture.storage,
    readWorkingProfileReceipt: () => options.workingProfileReceipt ?? null,
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  root.innerHTML = controller.markup()
  controller.bind(root)
  t.after(() => {
    controller.destroy()
    root.remove()
    restoreOuterHtml()
    dom.restore()
  })
  return { ...storageFixture, draft, controller, root }
}

function status(root) {
  return root.querySelector('[role="status"]')?.textContent?.trim() || ''
}

function resetButton(root) {
  return root.querySelector('[data-permission-reset]')
}

function assertRecoveryDoor(root) {
  const button = resetButton(root)
  assert.ok(button, 'an unreadable record keeps a reset control mounted')
  assert.equal(button.textContent.trim(), 'Reset permission profiles to the default')
}

function recoveryKeys(values) {
  return [...values.keys()].filter(key => key.startsWith(ACTION_PERMISSIONS_RECOVERY_PREFIX))
}

for (const [label, raw] of invalidInputs) {
  test(`mounted ${label} keeps the original bytes until reset is saved`, t => {
    const mounted = mountPanel(t, raw)
    assert.ok(status(mounted.root), 'the invalid record is explained')
    assertRecoveryDoor(mounted.root)
    assert.equal(mounted.writes.length, 0, 'reading an invalid record does not write')

    resetButton(mounted.root).click()
    assert.equal(mounted.writes.length, 0, 'reset only stages a draft')
    assert.equal(mounted.draft.has('permissions:profiles'), true)
    assert.deepEqual(mounted.draft.value('permissions:profiles', null), defaultActionProfiles())

    mounted.draft.discard()
    mounted.controller.repaint()
    assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), raw, 'discard leaves the original raw bytes')
    assertRecoveryDoor(mounted.root)
    assert.equal(recoveryKeys(mounted.values).length, 0)
  })
}

test('a valid mounted record keeps working-profile controls and does not offer reset', t => {
  const raw = JSON.stringify({
    v: 1,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Default', parentId: null, actions: {}, functions: null }],
  })
  const mounted = mountPanel(t, raw, { workingProfileReceipt: { id: 'independent', atMs: 1790075761542 } })
  assert.equal(resetButton(mounted.root), null)
  const resume = mounted.root.querySelector('[data-permission-mode="agentResume"]')
  assert.ok(resume, 'the valid profile keeps the resume control')
  assert.equal(resume.children.find(option => option.hasAttribute('selected'))?.getAttribute('value'), 'automatic')
  assert.match(mounted.root.querySelector('[data-permission-agent-resume-source]')?.textContent || '', /Automatic/)
  assert.equal(mounted.writes.length, 0)
})

test('Save archives exact malformed bytes once, verifies the backup, then writes canonical defaults', async t => {
  const raw = '{\n  "v": 1,\n  "profiles": [\n'
  const mounted = mountPanel(t, raw)
  resetButton(mounted.root).click()
  await mounted.draft.save()

  const backups = recoveryKeys(mounted.values)
  assert.equal(backups.length, 1)
  assert.equal(mounted.values.get(backups[0]), raw, 'the backup is byte-for-byte the input')
  assert.deepEqual(JSON.parse(mounted.values.get(ACTION_PERMISSIONS_KEY)), defaultActionProfiles())
  const writes = mounted.writes.map(write => write.key)
  assert.ok(writes.indexOf(backups[0]) >= 0)
  assert.ok(writes.indexOf(ACTION_PERMISSIONS_KEY) > writes.indexOf(backups[0]), 'canonical write follows preservation')
  const backupWriteIndex = mounted.events.findIndex(event => event.op === 'write' && event.key === backups[0])
  assert.ok(mounted.events.some((event, index) => index > backupWriteIndex && event.op === 'read' && event.key === backups[0]),
    'Save verifies the preserved copy by reading it back')
  assert.equal(mounted.draft.dirty, false)
  assert.equal(mounted.draft.has('permissions:profiles'), false)
})

test('archive refusal is visible and leaves the pending draft and original bytes', async t => {
  const raw = '{bad archive input'
  const mounted = mountPanel(t, raw, {
    failWrite: key => key.startsWith(ACTION_PERMISSIONS_RECOVERY_PREFIX) ? new Error('preserve refused') : null,
  })
  resetButton(mounted.root).click()
  await assert.rejects(() => mounted.draft.save(), /preserve refused|could not/i)
  mounted.controller.repaint()
  assert.match(status(mounted.root), /preserve refused/i, 'archive refusal reason remains visible in the mounted panel')
  assert.equal(mounted.draft.has('permissions:profiles'), true)
  assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), raw)
  assert.equal(recoveryKeys(mounted.values).length, 0)
})

test('canonical refusal preserves one backup across retry and leaves both bytes pending', async t => {
  const raw = '{bad canonical input'
  const mounted = mountPanel(t, raw, {
    failWrite: key => key === ACTION_PERMISSIONS_KEY ? { ok: false, error: { message: 'canonical write refused' } } : null,
  })
  resetButton(mounted.root).click()
  await assert.rejects(() => mounted.draft.save(), /canonical write refused|could not/i)
  mounted.controller.repaint()
  assert.match(status(mounted.root), /canonical write refused/i, 'canonical refusal reason remains visible')
  const backupsAfterFirst = recoveryKeys(mounted.values)
  assert.equal(backupsAfterFirst.length, 1)
  assert.equal(mounted.values.get(backupsAfterFirst[0]), raw)
  assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), raw)
  assert.equal(mounted.draft.has('permissions:profiles'), true)

  await assert.rejects(() => mounted.draft.save(), /canonical write refused|could not/i)
  mounted.controller.repaint()
  assert.match(status(mounted.root), /canonical write refused/i, 'retry refusal reason remains visible')
  const backupsAfterRetry = recoveryKeys(mounted.values)
  assert.deepEqual(backupsAfterRetry, backupsAfterFirst, 'retry reuses the preserved backup')
  assert.equal(mounted.values.get(backupsAfterRetry[0]), raw)
  assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), raw)
})

test('changed original is refused before preservation or canonical write', async t => {
  const raw = '{bad changed input'
  const mounted = mountPanel(t, raw)
  resetButton(mounted.root).click()
  const changed = '{a different saved record}'
  mounted.values.set(ACTION_PERMISSIONS_KEY, changed)
  await assert.rejects(() => mounted.draft.save(), /changed|modified|saved permission|could not/i)
  mounted.controller.repaint()
  assert.match(status(mounted.root), /changed|modified|saved permission/i, 'stale-original refusal reason remains visible')
  assert.equal(mounted.draft.has('permissions:profiles'), true)
  assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), changed)
  assert.equal(recoveryKeys(mounted.values).length, 0)
  assert.equal(mounted.writes.length, 0)
})

test('a failed read keeps the reset door but does not stage unknown bytes', t => {
  let unreadable = true
  const raw = '{temporarily unreadable'
  const mounted = mountPanel(t, raw, { failRead: key => unreadable && key === ACTION_PERMISSIONS_KEY })
  assert.ok(status(mounted.root))
  assert.match(status(mounted.root), /read|unavailable|could not/i)
  assertRecoveryDoor(mounted.root)
  resetButton(mounted.root).click()
  assert.equal(mounted.draft.has('permissions:profiles'), false, 'reset cannot stage without captured original bytes')
  assert.equal(mounted.writes.length, 0)
  assert.ok(status(mounted.root), 'the read refusal remains visible')
  assert.equal(mounted.values.get(ACTION_PERMISSIONS_KEY), raw)
  assert.equal(recoveryKeys(mounted.values).length, 0)
})
