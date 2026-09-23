'use strict'

// Held native cohort. Every preference write below is a visible click or key.
// The renderer cache, the real prefs IPC and the owned durable file must agree.
// Account-scoped preferences and provider behavior are deliberately uncredited.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { navigate } = require('./page2-native-scenarios.cjs')

const FONT_STACKS = Object.freeze({
  plex: '"IBM Plex Sans Variable", "IBM Plex Sans", "Segoe UI Variable", system-ui, sans-serif',
  manrope: '"Manrope Variable", "Segoe UI Variable", system-ui, sans-serif',
  source: '"Source Sans 3 Variable", "Segoe UI Variable", system-ui, sans-serif',
  system: '"Segoe UI Variable", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  grotesk: '"Space Grotesk Variable", "Space Grotesk", "Segoe UI Variable", system-ui, sans-serif',
  mono: '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Consolas, monospace',
})
const PREFERENCES = Object.freeze([
  { id: 'theme', key: 'mc.theme', name: 'Theme', kind: 'segment', group: '#theme-seg', attr: 'theme', choices: ['white', 'tan', 'black', 'ember', 'cobalt'], default: 'white', control: 'appearance.quick.theme' },
  { id: 'ui_font', key: 'mc.font', name: 'Font', kind: 'segment', group: '#font-seg', attr: 'font', choices: Object.keys(FONT_STACKS), default: 'plex', control: 'appearance.quick.font' },
  { id: 'text_size', key: 'mc.text', name: 'Text size', kind: 'segment', group: '#text-seg', attr: 'text', choices: ['0.9', '1', '1.12'], default: '1', control: 'appearance.quick.text-size' },
  { id: 'glow', key: 'mc.set.glow', name: 'Glow intensity', kind: 'range', choices: [0, 200], default: 100, control: 'appearance.quick.glow' },
  { id: 'reduce_motion', key: 'mc.set.reduce_motion', name: 'Reduce motion', kind: 'toggle', choices: [true, false], default: false, control: 'appearance.quick.reduce-motion' },
  { id: 'reading_width', key: 'mc.home.chat-width', name: 'Home reading width', kind: 'width', choices: ['comfortable', 'wide'], default: 'comfortable', control: 'home.reading.width' },
].map(Object.freeze))
const KEYS = PREFERENCES.map(item => item.key)
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const normalizeFont = value => String(value).replace(/["']/g, '').replace(/\s+/g, ' ').trim()
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const expectedRaw = (item, value) => ['glow', 'reduce_motion'].includes(item.id) && value === item.default ? null : String(value)

function ownedPreferenceFile(paths, file, fsImpl = fs) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'The prefs bridge must name its actual absolute file')
  const expected = path.join(paths.userData, 'renderer-prefs.json')
  assert.equal(path.normalize(file), expected, 'Preferences must use this exact QA user-data file before any edit')
  const relative = path.relative(paths.qaRoot, expected)
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'The preference file must remain inside this owned QA launch')
  let current = paths.qaRoot
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part)
    const stat = fsImpl.lstatSync(current)
    assert.equal(stat.isSymbolicLink(), false, 'A preference path cannot redirect through a link or junction')
    if (current === expected) {
      assert.ok(stat.isFile(), 'The preference record must be a regular file')
      assert.equal(stat.nlink, 1, 'The preference record cannot share a hard-linked file')
      assert.ok(stat.size > 0 && stat.size <= 64 * 1024 * 1024, 'The actual preference record must fit its maintained file bound')
    } else assert.ok(stat.isDirectory(), 'Every owned preference ancestor must be a directory')
  }
  return expected
}

function readPreferenceFile(paths, file) {
  const owned = ownedPreferenceFile(paths, file)
  const fd = fs.openSync(owned, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let bytes
  try {
    const stat = fs.fstatSync(fd)
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024, 'The opened preference record must still be one bounded regular file')
    bytes = fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
  const record = JSON.parse(bytes.toString('utf8'))
  assert.equal(record.storageVersion, 1, 'The actual durable preference record must use the supported schema')
  assert.ok(plain(record.values) && Object.values(record.values).every(value => typeof value === 'string'))
  // Keep unrelated preferences in a digest, not in evidence. This includes the
  // selected setup, permission flags and fleet nodes; none may change here.
  const protectedValues = Object.fromEntries(Object.entries(record.values).filter(([key]) => !KEYS.includes(key)).sort(([a], [b]) => a.localeCompare(b)))
  return { file: owned, sha256: sha(bytes), protectedSha256: sha(JSON.stringify(protectedValues)),
    values: Object.fromEntries(KEYS.map(key => [key, record.values[key] ?? null])) }
}

function readStartIdentity(paths) {
  ownedPreferenceFile(paths, path.join(paths.userData, 'renderer-prefs.json'))
  const file = path.join(paths.userData, 'agent-spawn-records.jsonl')
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return { count: 0, sha256: sha('[]') }; throw error }
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024,
    'The owned run record must remain one bounded regular file during preference checks')
  const starts = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.action === 'agent_session_start').map(row => {
      assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > 0 && typeof row.sessionId === 'string' && row.sessionId)
      assert.match(row.eventHash, /^[a-f0-9]{64}$/, 'A recorded start must retain its exact event identity')
      return { sequence: row.sequence, sessionId: row.sessionId, eventHash: row.eventHash }
    })
  return { count: starts.length, sha256: sha(JSON.stringify(starts)) }
}

function appliedValue(receipt, item) {
  const applied = receipt.applied
  if (item.id === 'theme') return applied.theme
  if (item.id === 'ui_font') return Object.keys(FONT_STACKS).find(id => normalizeFont(FONT_STACKS[id]) === normalizeFont(applied.fontStack))
  if (item.id === 'text_size') return String(Number(applied.zoom || 1))
  if (item.id === 'glow') return Math.round(Number(applied.glow) * 100)
  if (item.id === 'reduce_motion') return applied.reduceMotion
  return applied.reading?.width ?? receipt.raw[item.key] ?? item.default
}

function assertPreferenceReceipt(receipt) {
  assert.equal(receipt.source.available, true, 'A browser-only storage fixture cannot prove a native saved preference')
  assert.equal(receipt.source.accountReady, true, 'Account preference hydration must settle before this local-only edit')
  assert.equal(receipt.source.signedIn, false, 'This cohort requires the owned QA product account to remain signed out')
  assert.deepEqual(receipt.source.notice, { damaged: null, preservedAt: null, refused: null }, 'A damaged or refused save cannot earn preference coverage')
  assert.equal(receipt.disk.file, receipt.source.file, 'The read-only bridge and durable bytes must name the same owned preference file')
  for (const field of ['sha256', 'protectedSha256']) assert.match(receipt.disk[field], /^[a-f0-9]{64}$/)
  assert.ok(Number.isSafeInteger(receipt.starts?.count) && receipt.starts.count >= 0, 'Preference evidence must retain the actual provider-start count')
  assert.match(receipt.starts.sha256, /^[a-f0-9]{64}$/)
  for (const object of [receipt.raw, receipt.host, receipt.disk.values]) assert.deepEqual(Object.keys(object).sort(), [...KEYS].sort())
  for (const item of PREFERENCES) {
    const raw = receipt.raw[item.key]
    assert.ok(raw === null || typeof raw === 'string')
    assert.deepEqual(receipt.host[item.key], { ok: true, value: raw }, 'The exact host read must agree with the renderer preference')
    assert.equal(receipt.disk.values[item.key], raw, 'The durable file must contain the same exact saved preference as the host and renderer')
    const value = appliedValue(receipt, item)
    if (item.kind === 'range') assert.ok(Number.isInteger(value) && value >= 0 && value <= 200)
    else assert.ok(item.choices.includes(value), `The applied ${item.id} must identify an offered choice`)
    assert.ok(raw === expectedRaw(item, value) || (raw === null && value === item.default),
      'A malformed or stale saved value cannot be treated as the applied preference')
  }
  assert.equal(normalizeFont(receipt.applied.bodyFont), normalizeFont(receipt.applied.fontStack), 'The selected font must reach the actual body style')
  assert.equal(Number(receipt.applied.layoutZoom || 1), Number(receipt.applied.zoom || 1), 'Text zoom and the layout zoom property must agree')
  assert.ok(Math.abs(Number(receipt.applied.glow) * 100 - appliedValue(receipt, PREFERENCES.find(item => item.id === 'glow'))) < 1e-7,
    'The actual glow style must name a whole offered percentage')
  assert.ok(typeof receipt.applied.themeBackground === 'string' && receipt.applied.themeBackground.trim())
  if (receipt.applied.reading) {
    const reading = receipt.applied.reading
    // 920px/1400px are the two values src/home-chat.css actually declares for
    // --reading-max. This asserted 900px, which no stylesheet ever set, so it
    // described a product that did not exist. Correct the assertion against the
    // stylesheet -- never edit 920px to make this line green.
    assert.equal(reading.max, reading.width === 'wide' ? '1400px' : '920px', 'The mounted Home CSS must apply the requested reading width')
    assert.equal(reading.pressed, String(reading.width === 'wide'))
    assert.equal(reading.label, reading.width === 'wide' ? 'Wide' : 'Comfortable')
    assert.ok(typeof reading.subject === 'string' && reading.subject)
    assert.equal(typeof reading.exampleShown, 'boolean')
  }
  return receipt
}

function assertPreferenceChange(before, after, item, target) {
  assertPreferenceReceipt(before); assertPreferenceReceipt(after)
  if (item.kind === 'width') assert.ok(before.applied.reading && after.applied.reading, 'A Home width action requires both actual mounted reading controls')
  assert.equal(after.source.file, before.source.file)
  assert.equal(after.disk.protectedSha256, before.disk.protectedSha256, 'Appearance controls must retain all unrelated durable preferences and agent records')
  assert.deepEqual(after.starts, before.starts, 'A preference control must not start a provider session')
  assert.equal(after.raw[item.key], expectedRaw(item, target), 'A preference action must durably store its exact requested value')
  assert.equal(appliedValue(after, item), target, 'The saved choice must also apply to the actual mounted UI')
  for (const other of PREFERENCES.filter(candidate => candidate.id !== item.id)) {
    assert.equal(after.raw[other.key], before.raw[other.key], 'Changing one preference must retain every other selected preference')
    assert.equal(appliedValue(after, other), appliedValue(before, other))
  }
  if (item.id === 'theme' && appliedValue(before, item) !== target) assert.notEqual(after.applied.themeBackground, before.applied.themeBackground,
    'A changed theme must reach the actual computed theme background')
  if (item.id !== 'theme') assert.equal(after.applied.themeBackground, before.applied.themeBackground, 'A different preference must retain the applied theme background')
  if (item.id === 'text_size' && target === '1') {
    assert.equal(after.applied.zoom, '', 'Default text size must clear the inline body zoom')
    assert.equal(after.applied.layoutZoom, '', 'Default text size must clear its inline layout override')
  }
  if (before.applied.reading && after.applied.reading) assert.equal(after.applied.reading.subject, before.applied.reading.subject,
    'Changing the reading width must retain the exact current Home subject')
}

function assertPreferenceRestored(before, after, item) {
  assertPreferenceChange(before, after, item, appliedValue(before, item))
  assert.equal(after.applied.themeBackground, before.applied.themeBackground, 'Restoration must recover the original applied theme background')
  // Theme/font/text/width write a canonical default when pressed. Their UI has
  // no "unset" action, so absent -> stored default is reported explicitly.
  return { originalRaw: before.raw[item.key], restoredRaw: after.raw[item.key],
    effectiveValue: appliedValue(after, item), canonicalDefaultWritten: before.raw[item.key] === null && after.raw[item.key] !== null }
}

async function readPreferenceState(context) {
  await context.page.waitForFunction(() => window.mcDurableStorage?.accountReady === true)
  const receipt = await context.page.evaluate(async keys => {
    const account = await window.mcAccount?.current?.()
    const notice = window.mcPrefsNotice?.read?.()
    const root = document.documentElement, computed = getComputedStyle(root)
    const surface = document.querySelector('.home [data-chat-takeover]:not([hidden])')
    const width = surface?.querySelector('[data-chat-width]')
    return {
      source: { available: window.mcPrefs?.available, accountReady: window.mcDurableStorage?.accountReady,
        signedIn: account?.signedIn, file: window.mcPrefs?.file,
        notice: notice ? { damaged: notice.damaged, preservedAt: notice.preservedAt, refused: notice.refused } : null },
      raw: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
      host: Object.fromEntries(keys.map(key => [key, window.mcPrefs?.read?.(key)])),
      applied: { theme: root.dataset.theme, fontStack: computed.getPropertyValue('--font-ui').trim(), bodyFont: getComputedStyle(document.body).fontFamily,
        zoom: document.body.style.zoom, layoutZoom: root.style.getPropertyValue('--zoom').trim(),
        glow: computed.getPropertyValue('--glow').trim(), reduceMotion: document.body.classList.contains('reduce-motion'),
        themeBackground: computed.getPropertyValue('--bg').trim(), reading: surface ? { width: surface.dataset.readingWidth,
          max: getComputedStyle(surface).getPropertyValue('--reading-max').trim(), pressed: width?.getAttribute('aria-pressed'),
          label: width?.textContent.trim(), subject: surface.querySelector('[data-chat-subject]')?.value,
          exampleShown: !surface.querySelector('[data-chat-example]')?.hidden } : null },
    }
  }, KEYS)
  if (receipt.source.signedIn === true) context.unavailable('Local preference replay does not edit a signed-in product account; account-scoped behavior remains a gap')
  receipt.disk = readPreferenceFile(context.paths, receipt.source.file)
  receipt.starts = readStartIdentity(context.paths)
  return assertPreferenceReceipt(receipt)
}

async function settingsRow(context, item) {
  await navigate(context, 'metrics')
  await navigate(context, 'settings')
  // The router retains inert outgoing views during retirement. Use the one
  // current Settings view for both input and its resulting setting row.
  const settings = context.page.locator('#stage > .view:not([inert]) > .settings-page')
  await context.type(settings.getByRole('searchbox', { name: 'Search all settings', exact: true }), item.name)
  const row = settings.locator(`[data-setting-id="${item.id}"]`)
  await row.waitFor()
  return row
}
async function assertSettingsValue(context, item, value) {
  const settings = context.page.locator('#stage > .view:not([inert]) > .settings-page')
  const row = settings.locator(`[data-setting-id="${item.id}"]`)
  await row.waitFor()
  if (item.kind === 'segment') assert.equal(await row.locator('[data-setting-value][aria-pressed="true"]').getAttribute('data-setting-value'), String(value))
  else if (item.kind === 'range') assert.equal(await row.locator('input[type="range"]').inputValue(), String(value))
  else assert.equal(await row.locator('input[type="checkbox"]').isChecked(), value)
  assert.equal(await settings.locator('[data-settings-save]').isEnabled(), false, 'An immediate Quick Settings write must not leave a full-page settings draft')
  assert.equal(await settings.locator('[data-settings-discard]').isEnabled(), false)
}
async function openQuick(context) {
  const drawer = context.page.locator('#drawer')
  if (await drawer.getAttribute('aria-hidden') === 'true') await context.page.locator('#open-settings').click()
  await context.page.locator('#drawer[aria-hidden="false"]').waitFor()
  return drawer
}
async function closeQuick(context) {
  if (await context.page.locator('#drawer').getAttribute('aria-hidden') === 'false') await context.page.locator('#close-settings').click()
  assert.equal(await context.page.locator('#drawer').getAttribute('aria-hidden'), 'true')
}
async function assertQuickValue(drawer, item, value) {
  if (item.kind === 'segment') {
    const buttons = drawer.locator(`${item.group} button[data-${item.attr}]`)
    assert.deepEqual(await buttons.evaluateAll((nodes, attr) => nodes.map(node => node.getAttribute(`data-${attr}`)), item.attr), item.choices,
      'The real drawer must offer exactly the reviewed preference choices')
    assert.equal(await drawer.locator(`${item.group} button[aria-pressed="true"]`).getAttribute(`data-${item.attr}`), String(value))
  } else if (item.kind === 'range') {
    const input = drawer.locator('#set-glow')
    assert.equal(await input.getAttribute('min'), '0'); assert.equal(await input.getAttribute('max'), '200')
    assert.equal(await input.inputValue(), String(value))
  } else assert.equal(await drawer.locator('#set-motion').isChecked(), value)
}
async function chooseQuick(context, drawer, item, value) {
  await readPreferenceState(context) // repeat the owned, settled, signed-out gate before this input
  if (item.kind === 'segment') await drawer.locator(`${item.group} button[data-${item.attr}="${value}"]`).click()
  else if (item.kind === 'range') {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 200)
    const input = drawer.locator('#set-glow'), fromEnd = value > 100
    await input.press(fromEnd ? 'End' : 'Home')
    for (let step = 0; step < (fromEnd ? 200 - value : value); step++) await input.press(fromEnd ? 'ArrowLeft' : 'ArrowRight')
  } else if (await drawer.locator('#set-motion').isChecked() !== value) await drawer.locator('label:has(#set-motion)').click()
  await assertQuickValue(drawer, item, value)
}

function assertBoundaryKey(receipt, key, value) {
  assert.deepEqual(receipt.keys, [{ key, trusted: true }], 'The real slider must receive exactly the requested trusted boundary key')
  assert.equal(receipt.focused, true, 'The native boundary key must target the actual focused slider')
  assert.equal(receipt.value, String(value), 'The actual slider must retain its offered endpoint')
}
async function pressBoundaryKey(input, value) {
  const key = value === 0 ? 'ArrowLeft' : 'ArrowRight'
  const observer = await input.evaluateHandle(element => {
    const record = { element, keys: [] }
    record.listener = event => record.keys.push({ key: event.key, trusted: event.isTrusted })
    element.addEventListener('keydown', record.listener, true)
    return record
  })
  try {
    await input.press(key)
    const receipt = await observer.evaluate(({ element, keys }) => ({ keys, value: element.value, focused: element === document.activeElement }))
    assertBoundaryKey(receipt, key, value)
    return receipt
  } finally {
    await observer.evaluate(record => record.element.removeEventListener('keydown', record.listener, true))
    await observer.dispose()
  }
}

function summarize(receipt, item) {
  return { key: item.key, value: appliedValue(receipt, item), raw: receipt.raw[item.key],
    file: receipt.disk.file, fileSha256: receipt.disk.sha256, protectedSha256: receipt.disk.protectedSha256,
    source: 'Actual renderer + read-only host IPC + owned durable bytes', starts: receipt.starts, reading: receipt.applied.reading }
}
async function withRestoration(context, item, before, action, restore) {
  assert.equal(context.state.nativePreferenceRestorationFailed, undefined, 'A prior failed preference restoration prevents further preference edits')
  let failure, cleanupFailure
  try { await action() } catch (error) { failure = error }
  try {
    await context.step(`preference-${item.id}-restore-owned-choice`, async () => {
      const after = await restore()
      return { ...summarize(after, item), restoration: assertPreferenceRestored(before, after, item) }
    })
  } catch (error) { cleanupFailure = error; context.state.nativePreferenceRestorationFailed = item.id }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], `${failure.message}; preference restoration failed: ${cleanupFailure.message}`)
  if (failure || cleanupFailure) throw failure || cleanupFailure
}

async function runQuickPreference(context, id) {
  const item = PREFERENCES.find(item => item.id === id)
  assert.ok(item && item.kind !== 'width', 'A declared Quick Settings case must name an existing Quick control')
  await readPreferenceState(context) // ownership and signed-out check before opening an editor
  await settingsRow(context, item)
  const before = await readPreferenceState(context), original = appliedValue(before, item)
  await assertSettingsValue(context, item, original)
  await withRestoration(context, item, before, async () => {
    let previous = before
    await assertQuickValue(await openQuick(context), item, original)
    for (const value of item.choices.filter(value => item.kind === 'range' || value !== original)) {
      await context.step(`preference-${item.id}-choose-${value}`, async () => {
        const drawer = await openQuick(context)
        await chooseQuick(context, drawer, item, value)
        const after = await readPreferenceState(context)
        assertPreferenceChange(previous, after, item, value)
        let boundary = null
        if (item.kind === 'range') {
          // The native keyboard must respect both offered endpoints.
          boundary = await pressBoundaryKey(drawer.locator('#set-glow'), value)
          assertPreferenceChange(after, await readPreferenceState(context), item, value)
        }
        await closeQuick(context)
        await assertSettingsValue(context, item, value)
        previous = after
        return { ...summarize(after, item), boundary }
      })
    }
    const chosen = appliedValue(previous, item)
    await settingsRow(context, item)
    await assertSettingsValue(context, item, chosen)
    await assertQuickValue(await openQuick(context), item, chosen)
    const remounted = await readPreferenceState(context)
    assertPreferenceChange(previous, remounted, item, chosen)
    await context.step(`preference-${item.id}-retained-after-remount`, async () => summarize(remounted, item))
    await context.capture(`native-preference-${item.id}-applied`)
  }, async () => {
    await chooseQuick(context, await openQuick(context), item, original)
    await closeQuick(context)
    await settingsRow(context, item)
    await assertSettingsValue(context, item, original)
    return readPreferenceState(context)
  })
}

const scenarios = [
  { id: 'quick-preference-theme', title: 'Apply, persist, remount and restore Quick Settings Theme',
    controls: ['appearance.quick.theme'], requires: ['setup'], async run(context) { await runQuickPreference(context, 'theme') } },
  { id: 'quick-preference-ui-font', title: 'Apply, persist, remount and restore Quick Settings Font',
    controls: ['appearance.quick.font'], requires: ['setup'], async run(context) { await runQuickPreference(context, 'ui_font') } },
  { id: 'quick-preference-text-size', title: 'Apply, persist, remount and restore Quick Settings Text size',
    controls: ['appearance.quick.text-size'], requires: ['setup'], async run(context) { await runQuickPreference(context, 'text_size') } },
  { id: 'quick-preference-glow', title: 'Apply, persist, remount and restore Quick Settings Glow intensity',
    controls: ['appearance.quick.glow'], requires: ['setup'], async run(context) { await runQuickPreference(context, 'glow') } },
  { id: 'quick-preference-reduce-motion', title: 'Apply, persist, remount and restore Quick Settings Reduce motion',
    controls: ['appearance.quick.reduce-motion'], requires: ['setup'], async run(context) { await runQuickPreference(context, 'reduce_motion') } },
  { id: 'home-preference-reading-width', title: 'Persist the Home reading width, retain the selected subject and restore the original width',
    controls: ['home.reading.width'], requires: ['setup'], async run(context) {
      const item = PREFERENCES.find(item => item.kind === 'width')
      await readPreferenceState(context)
      const openHome = async () => {
        await navigate(context, 'metrics')
        await context.step('navigate-home-for-reading-width', () => context.page.locator('nav[aria-label="Primary navigation"] a[data-route="home"]').click())
        await context.page.waitForURL(url => url.hash === '#/')
        await context.page.locator('.home [data-chat-expand]').click()
        await context.page.locator('.home [data-chat-takeover]:not([hidden])').waitFor()
      }
      const closeHome = async () => {
        const close = context.page.locator('.home [data-chat-collapse]')
        if (await close.isVisible()) await close.click()
      }
      await openHome()
      const before = await readPreferenceState(context), original = appliedValue(before, item)
      const chosen = original === 'wide' ? 'comfortable' : 'wide'
      await withRestoration(context, item, before, async () => {
        await readPreferenceState(context)
        await context.page.locator('.home [data-chat-width]').click()
        const after = await readPreferenceState(context)
        assertPreferenceChange(before, after, item, chosen)
        await context.step('preference-reading-width-selected', async () => summarize(after, item))
        await closeHome(); await openHome()
        const remounted = await readPreferenceState(context)
        assertPreferenceChange(after, remounted, item, chosen)
        await context.step('preference-reading-width-retained-after-remount', async () => summarize(remounted, item))
        await context.capture('native-preference-home-reading-width')
      }, async () => {
        const width = context.page.locator('.home [data-chat-width]')
        if (!(await width.isVisible())) await openHome()
        const current = await readPreferenceState(context)
        if (appliedValue(current, item) !== original) await width.click()
        await closeHome(); await openHome()
        const restored = await readPreferenceState(context)
        await closeHome()
        return restored
      })
    },
  },
]

module.exports = { scenarios, PREFERENCES, FONT_STACKS, ownedPreferenceFile, readPreferenceFile,
  readStartIdentity, appliedValue, assertPreferenceReceipt, assertPreferenceChange, assertPreferenceRestored, withRestoration, assertBoundaryKey }
