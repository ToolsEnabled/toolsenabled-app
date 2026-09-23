import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocument } from './lib/dom-stand-in.mjs'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { createResourceSettings, resourceReadingSentence, resourcePolicySentence, RESOURCE_MODES, RESOURCE_CONTROLS, resourceFormValues, validateResourceForm } from '../../src/resource-settings.js'
const MIB = 1024 ** 2
const MEASURED_AT = Date.parse('2026-09-08T20:00:00.000Z')
const flush = () => new Promise(resolve => setImmediate(resolve))
const defaults = Object.freeze({ mode: 'mechanical', reserveBytes: 2048 * MIB, providerBytes: { claude: 768 * MIB, codex: 1024 * MIB, gemini: 1024 * MIB, grok: 1024 * MIB, local: 1024 * MIB }, maxConcurrentStarts: 8,
  sampleMaxAgeMs: 6000, settleMs: 4000, cpuCeilingPercent: 97, cpuBusyPercent: 80, startIntervalMs: 250, busyStartIntervalMs: 5000 })
const state = (settings = defaults, atMs = MEASURED_AT) => ({ ok: true, mode: settings.mode, fresh: true, measuredAt: new Date(atMs).toISOString(), atMs, ageMs: 0, cpuPercent: 85,
  freeBytes: 4 * 1024 * MIB, totalBytes: 32 * 1024 * MIB, reservedBytes: 768 * MIB, starting: 1, settling: 2, settings, defaults,
  admission: { claude: { ok: true }, codex: { ok: false, reason: 'Waiting for physical RAM.' }, gemini: { ok: true }, grok: { ok: false, reason: 'Waiting for controller advice.' }, local: { ok: false, reason: 'Waiting for physical RAM.' } } })
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(options = {}) {
  const document = createDocument(), root = document.createElement('main'), timers = new Set(), writes = []
  let saved = options.saved || state(), at = MEASURED_AT, available = options.available !== false
  const api = options.api || (typeof options.status === 'function' ? options : null) || { status: async () => saved, configure: async patch => {
    writes.push(patch); const next = { ...saved.settings, ...patch, providerBytes: { ...saved.settings.providerBytes, ...patch.providerBytes } }; saved = state(next); return saved
  } }
  const draft = options.staged ? createSettingsDraft() : null
  const controller = createResourceSettings({ bridge: () => available ? api : null, draft, onStateChange: options.onStateChange,
    schedule: fn => { timers.add(fn); return fn }, unschedule: fn => timers.delete(fn), now: () => at })
  const render = () => { root.innerHTML = controller.markup(); controller.afterRender(root) }
  root.innerHTML = controller.markup(); controller.bind(root); controller.afterRender(root)
  const input = name => root.querySelector(`[name="${name}"]`)
  const edit = (name, value, kind = 'input') => { input(name).value = String(value); input(name).dispatchEvent({ type: kind }) }
  const poll = async () => { for (const callback of timers) callback(); await flush() }
  const save = async () => { if (draft) { await draft.save(); controller.refreshSaved() } else { root.querySelector('[data-resource-form]').dispatchEvent({ type: 'submit' }); await flush() } }
  return { root, controller, timers, writes, draft, input, edit, poll, save, render, advance: ms => { at += ms }, available(value) { available = value }, saved(value) { saved = value },
    reading: () => root.querySelector('[data-resource-reading]').textContent, active: () => root.querySelector('[data-resource-policy]').textContent, notice: () => root.querySelector('[data-resource-notice]').textContent }
}

test('delayed resource status delivery cannot renew an expired sample or discard an edit', async () => {
  const wait = deferred(); let reads = 0
  const f = fixture({ staged: true, api: { status: () => ++reads === 1 ? state() : wait.promise, configure: async () => { throw new Error('No write expected') } } })
  try {
    await flush(); f.edit('reserve', 4096)
    await f.poll()
    const measuredBeforeDelivery = state()
    f.advance(7000)
    wait.resolve(measuredBeforeDelivery); await flush()
    assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown')
    assert.equal(f.root.querySelector('[data-resource-cpu-meter]').hidden, true)
    assert.match(f.reading(), /unknown or stale/)
    assert.match(f.root.querySelector('[data-resource-admission]').textContent, /Refresh to check/)
    assert.equal(f.input('reserve').value, '4096')
    assert.equal(f.draft.dirty, true)
    assert.deepEqual(f.writes, [])
  } finally { f.controller.destroy() }
})

test('resource sample freshness includes delivery time and continues to age without a new reply', async () => {
  for (const stamp of ['both', 'atMs', 'measuredAt']) {
    const wait = deferred()
    const f = fixture({ api: { status: () => wait.promise, configure: async () => ({ ok: false }) } })
    try {
      const reading = state()
      if (stamp === 'atMs') delete reading.measuredAt
      if (stamp === 'measuredAt') delete reading.atMs
      f.advance(5000); wait.resolve(reading); await flush()
      assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, '85.0%', stamp)
      f.advance(1001); f.controller.refreshSaved()
      assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown', stamp)
    } finally { f.controller.destroy() }
  }
})

test('invalid, future or conflicting resource timestamps cannot claim fresh CPU or an available next start', async () => {
  for (const override of [
    { atMs: NaN }, { atMs: '10000' }, { atMs: -1 }, { measuredAt: 'not a date' }, { measuredAt: null },
    { atMs: undefined, measuredAt: undefined }, { atMs: MEASURED_AT - 1 },
    { atMs: MEASURED_AT + 1, measuredAt: new Date(MEASURED_AT + 1).toISOString() },
    { ageMs: -1 }, { ageMs: NaN }, { ageMs: 7000 },
  ]) {
    const f = fixture({ saved: { ...state(), ...override } })
    try {
      await flush()
      assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown', JSON.stringify(override))
      assert.match(f.root.querySelector('[data-resource-admission]').textContent, /Refresh to check/)
      f.advance(2); f.controller.refreshSaved()
      assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown', 'future-at-receipt cannot become trusted as time catches up')
    } finally { f.controller.destroy() }
  }
})

test('resource readings recover on a new measured sample after clock rollback or expiry', async () => {
  const f = fixture({ staged: true })
  try {
    await flush(); f.edit('reserve', 4096)
    f.advance(-1); f.controller.refreshSaved()
    assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown')
    f.advance(7001); f.saved(state(defaults, MEASURED_AT + 7000)); await f.poll()
    assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, '85.0%')
    assert.equal(f.input('reserve').value, '4096'); assert.equal(f.draft.dirty, true)
    assert.deepEqual(f.writes, [])
  } finally { f.controller.destroy() }
})

test('resource panel shows all five provider admissions and writes only explicitly edited supported reservations', async () => {
  const f = fixture({ staged: true })
  try {
    await flush()
    const rows = f.root.querySelector('[data-resource-admission]').textContent
    for (const name of ['Claude', 'Codex', 'Gemini', 'Grok', 'Local']) assert.match(rows, new RegExp(name + ':'))
    assert.match(rows, /Gemini: Ready for another start/)
    assert.match(rows, /Grok: Waiting for controller advice/)
    assert.deepEqual(f.writes, [])
    f.edit('gemini', 1536); f.edit('grok', 2048); await f.save()
    assert.deepEqual(f.writes, [{ providerBytes: { gemini: 1536 * MIB, grok: 2048 * MIB } }])
  } finally { f.controller.destroy() }
  const legacy = { ...defaults, providerBytes: { claude: 768 * MIB, codex: 1024 * MIB, local: 1024 * MIB } }
  const older = fixture({ staged: true, saved: state(legacy) })
  try {
    await flush()
    assert.equal(older.input('gemini').disabled, true); assert.equal(older.input('grok').disabled, true)
    older.edit('reserve', 4096); await older.save()
    assert.deepEqual(older.writes, [{ reserveBytes: 4096 * MIB }])
  } finally { older.controller.destroy() }
})

test('resource panel distinguishes latest CPU, recent peak and timer lag without inventing the original hold cause', async () => {
  const f = fixture({ saved: { ...state(), cpuPercent: 40, readyWindow: true, cpuWindowMaxPercent: 96, loopLagMs: 25, pressure: true } })
  try {
    await flush()
    assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, '40.0%')
    const detail = f.root.querySelector('[data-resource-window]').textContent
    assert.match(detail, /Recent CPU peak: 96.0%/); assert.match(detail, /App timer delay: 25 ms/)
    assert.match(detail, /Recovery checks are still pending/)
    assert.match(detail, /lower latest CPU reading alone does not clear this state/)
    f.advance(7000); f.controller.refreshSaved()
    assert.match(f.root.querySelector('[data-resource-window]').textContent, /fresh reading is needed/)
    assert.doesNotMatch(f.root.querySelector('[data-resource-window]').textContent, /96.0%|25 ms/)
    assert.deepEqual(f.writes, [])
  } finally { f.controller.destroy() }
})

test('resource recovery facts do not override admission or invent a block when mechanical limits are off', async () => {
  for (const [mode] of RESOURCE_MODES) {
    const saved = state({ ...defaults, mode })
    saved.pressure = true; saved.readyWindow = true; saved.cpuWindowMaxPercent = 96; saved.loopLagMs = 25
    saved.admission = Object.fromEntries(Object.keys(saved.admission).map(provider => [provider, { ok: true }]))
    const f = fixture({ saved })
    try {
      await flush()
      const detail = f.root.querySelector('[data-resource-window]').textContent
      if (mode === 'off') assert.equal(detail, '')
      else assert.match(detail, /Recovery checks are still pending/)
      assert.doesNotMatch(detail, /blocked|paused|must wait|at or below|under 200|slower interval/i)
      const rows = f.root.querySelector('[data-resource-admission]').querySelectorAll('li')
      assert.equal(rows.length, 5)
      for (const row of rows) assert.match(row.textContent, mode === 'off' ? /Resource checks are off/ : /Ready for another start/, mode)
      assert.deepEqual(f.writes, [])
    } finally { f.controller.destroy() }
  }
})
test('resource policy is searchable by its displayed title', () => {
  const controller = createResourceSettings()
  assert.equal(controller.matches('resource-aware starts'), true)
  assert.equal(controller.matches('Resource-aware starts'), true)
  assert.equal(controller.matches('memory'), true)
  assert.equal(controller.matches('unrelated missing setting'), false)
})

test('four named modes and concise disclosure state real scope and distinguish dated physical readings from unknown status', () => {
  assert.equal(RESOURCE_MODES.length, 4)
  assert.match(resourcePolicySentence('off'), /Both automatic resource admission policies are off/)
  assert.match(resourcePolicySentence('off'), /Permission, account, ownership and process isolation checks still apply/)
  assert.match(resourcePolicySentence('controller'), /Mechanical CPU and RAM checks apply only to its first bootstrap/)
  assert.match(resourcePolicySentence('both'), /Both mechanical headroom and current advice/)
  assert.match(resourceReadingSentence(state()), /85.0%.*physical RAM.*2026-09-08/)
  for (const bad of [{ fresh: false }, { fresh: true }, { fresh: true, cpuPercent: NaN, freeBytes: 5 }]) assert.match(resourceReadingSentence(bad), /unknown or stale/)
  const markup = createResourceSettings().markup()
  assert.equal(createResourceSettings().matches('cpu ceiling'), true)
  assert.equal(createResourceSettings().matches('ram parallel'), true)
  assert.equal(createResourceSettings().matches('cpu unknownphrase'), false)
  assert.match(markup, /data-settings-section="Resources"/)
  assert.match(markup, /tree sessions, their assistants’ detached launches, and this app’s work-lane service/)
  assert.match(markup, /Independent command-line engines and a program’s own subagents are not covered/)
  assert.match(markup, /Work lanes wait for advice; they do not bootstrap/)
  assert.match(markup, /<summary>How resource admission works/)
})

test('every slider has a working exact field, units, defaults and useful machine bounds; opening writes nothing', async () => {
  const f = fixture({ staged: true }); await flush()
  assert.equal(f.root.querySelectorAll('[data-resource-slider]').length, RESOURCE_CONTROLS.length)
  for (const control of RESOURCE_CONTROLS) {
    const slider = f.root.querySelector(`[data-resource-slider="${control.name}"]`)
    assert.equal(slider.value, f.input(control.name).value, control.name)
    assert.ok(f.root.querySelector(`[data-resource-default="${control.name}"]`).textContent.includes('Default'))
    assert.equal(slider.disabled, false)
  }
  assert.equal(f.input('reserve').max, '32768'); assert.equal(f.input('local').max, '32768')
  const slider = f.root.querySelector('[data-resource-slider="maxConcurrentStarts"]'); slider.value = '16'; slider.dispatchEvent({ type: 'input' })
  assert.equal(f.input('maxConcurrentStarts').value, '16'); assert.equal(f.draft.dirty, true); assert.deepEqual(f.writes, [])
  f.edit('claude', 1536); assert.equal(f.root.querySelector('[data-resource-slider="claude"]').value, '1536')
  await f.save(); assert.deepEqual(f.writes, [{ maxConcurrentStarts: 16, providerBytes: { claude: 1536 * MIB } }])
  f.controller.destroy()
})

test('invalid blanks, infinities, bounds and fractional counts remain visible and block global Save before any writes', async () => {
  for (const control of RESOURCE_CONTROLS) {
    for (const bad of ['', 'Infinity', 'NaN', '-1', String((control.max ?? 32768) + 1), ...(control.step === 1 ? ['2.5'] : [])]) {
      const f = fixture({ staged: true }); await flush(); f.edit(control.name, bad)
      assert.equal(f.draft.dirty, true, control.name + ': ' + bad); assert.equal(f.draft.valid, false)
      assert.equal(f.input(control.name).value, bad); assert.equal(f.input(control.name).getAttribute('aria-invalid'), 'true')
      await assert.rejects(f.save(), /enter|below|interval/); assert.deepEqual(f.writes, [])
      f.edit(control.name, resourceFormValues(defaults)[control.name]); assert.equal(f.draft.dirty, false)
      f.controller.destroy()
    }
  }
})

test('CPU thresholds and pacing values validate together and recover after the companion field is fixed', async () => {
  const f = fixture({ staged: true }); await flush()
  f.edit('cpuCeilingPercent', 50); assert.equal(f.draft.valid, false); assert.match(f.notice(), /below the CPU ceiling/)
  f.edit('cpuBusyPercent', 40); assert.equal(f.draft.valid, true)
  f.edit('startIntervalMs', 6000); assert.equal(f.draft.valid, false)
  f.edit('busyStartIntervalMs', 6000); assert.equal(f.draft.valid, true)
  await f.save(); assert.deepEqual(f.writes, [{ cpuCeilingPercent: 50, cpuBusyPercent: 40, startIntervalMs: 6000, busyStartIntervalMs: 6000 }]); f.controller.destroy()
})

test('a high memory slider keeps its scale while editing and preserves saved readback until Save', async () => {
  const f = fixture({ staged: true, saved: { ...state({ ...defaults, reserveBytes: 65536 * MIB }), totalBytes: 128 * 1024 * MIB } }); await flush()
  const slider = f.root.querySelector('[data-resource-slider="reserve"]')
  assert.equal(slider.max, '65536')
  slider.value = '65535'; slider.dispatchEvent({ type: 'input' })
  assert.equal(slider.max, '65536')
  assert.match(f.root.querySelector('[data-resource-default="reserve"]').textContent, /Saved: 65536 MiB/)
  assert.equal(f.root.querySelector('[data-resource-pending="reserve"]').hidden, false)
  f.edit('reserve', '98304')
  assert.equal(slider.max, '98304')
  slider.value = '65536'; slider.dispatchEvent({ type: 'input' })
  assert.equal(slider.max, '98304')
  assert.equal(f.draft.dirty, false)
  assert.equal(f.root.querySelector('[data-resource-pending="reserve"]').hidden, true)
  assert.deepEqual(f.writes, [])
  f.controller.destroy()
})

test('resource meters do not present stale samples as current capacity or disturb drafts', async () => {
  const f = fixture({ staged: true }); await flush()
  assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, '85.0%')
  assert.equal(f.root.querySelector('[data-resource-cpu-meter]').hidden, false)
  f.edit('reserve', 4096); f.advance(7000)
  f.saved({ ...state(), fresh: false }); await f.poll()
  assert.equal(f.root.querySelector('[data-resource-cpu]').textContent, 'Unknown')
  assert.equal(f.root.querySelector('[data-resource-ram-meter]').hidden, true)
  assert.equal(f.input('reserve').value, '4096')
  assert.equal(f.draft.dirty, true)
  assert.deepEqual(f.writes, [])
  f.controller.destroy()
})

test('minimum and maximum fields retain exact numbers and RAM supports measured fractions without rounding saved bytes', () => {
  for (const controls of [
    { cpuCeilingPercent: '50', cpuBusyPercent: '20', startIntervalMs: '50', busyStartIntervalMs: '250', maxConcurrentStarts: '1', reserve: '0', claude: '1' },
    { cpuCeilingPercent: '99', cpuBusyPercent: '98', startIntervalMs: '10000', busyStartIntervalMs: '30000', maxConcurrentStarts: '64', reserve: '32768', local: '32768' },
  ]) { const parsed = validateResourceForm({ ...resourceFormValues(defaults), ...controls }, defaults); assert.equal(parsed.ok, true, parsed.reason) }
  const saved = { ...defaults, providerBytes: { ...defaults.providerBytes, claude: 768 * MIB + 512 } }
  assert.deepEqual(validateResourceForm(resourceFormValues(saved), saved).value, saved)
})

test('draft edits survive polling and revisits, while only the saved response changes the active policy', async () => {
  const f = fixture({ staged: true }); await flush(); f.edit('mode', 'off'); f.edit('reserve', 4096)
  await f.poll(); assert.equal(f.input('mode').value, 'off'); assert.equal(f.input('reserve').value, '4096'); assert.match(f.active(), /Mechanical only/)
  f.root.innerHTML = '<section>Appearance</section>'; f.controller.afterRender(f.root); assert.equal(f.timers.size, 0)
  f.render(); await flush(); assert.equal(f.input('reserve').value, '4096'); assert.equal(f.writes.length, 0)
  await f.save(); assert.match(f.active(), /All off/); assert.equal(f.draft.dirty, false)
  assert.doesNotMatch(f.root.querySelector('[data-resource-draft-policy]').textContent, /Pending/)
  f.render(); await flush(); assert.equal(f.input('reserve').value, '4096'); f.controller.destroy()
})

test('discard restores saved controls after revisit and changing back to the original value clears the draft', async () => {
  const f = fixture({ staged: true }); await flush(); f.edit('reserve', 4096); f.draft.discard(); f.render(); await flush()
  assert.equal(f.input('reserve').value, '2048'); assert.equal(f.draft.dirty, false); assert.equal(f.writes.length, 0)
  f.edit('mode', 'off'); f.edit('mode', 'mechanical'); assert.equal(f.draft.dirty, false)
  f.controller.destroy()
})

test('failed actual writes retain active policy and edits for retry, including partially successful global saves', async () => {
  let attempts = 0, earlierWrites = 0, saved = state()
  const f = fixture({ staged: true, api: { status: async () => saved, configure: async patch => { attempts++; if (attempts === 1) return { ok: false, reason: 'Disk refused; old policy remains.' }; saved = state({ ...defaults, ...patch }); return saved } } })
  await flush(); f.draft.stage('earlier:setting', true, async () => { earlierWrites++; return { ok: true } }); f.edit('mode', 'off')
  await assert.rejects(f.save(), /Disk refused/); assert.equal(earlierWrites, 1); assert.equal(attempts, 1); assert.equal(f.draft.dirty, true)
  assert.equal(f.input('mode').value, 'off'); assert.match(f.active(), /Mechanical only/); assert.match(f.notice(), /Disk refused/)
  await f.poll(); assert.equal(f.input('mode').value, 'off')
  await f.save(); assert.equal(earlierWrites, 1); assert.equal(attempts, 2); assert.match(f.active(), /All off/); f.controller.destroy()
})

test('standalone saves use the same validation and catch thrown or missing write replies without losing input', async () => {
  for (const configure of [async () => { throw new Error('Disk denied') }, async () => undefined]) {
    const f = fixture({ api: { status: async () => state(), configure } }); await flush(); f.edit('mode', 'off'); await f.save()
    assert.match(f.notice(), /could not be saved/); assert.equal(f.input('mode').value, 'off'); assert.match(f.active(), /Mechanical only/); f.controller.destroy()
  }
})

test('a late poll cannot overwrite the saved response, and saves preserve unrelated settings changed while editing', async () => {
  const wait = deferred(); let calls = 0, saved = state(), writes = []
  const f = fixture({ staged: true, api: { status: async () => ++calls === 2 ? wait.promise : saved, configure: async patch => { writes.push(patch); saved = state({ ...saved.settings, ...patch }); return saved } } })
  await flush(); f.edit('mode', 'off'); void f.poll(); await flush()
  saved = state({ ...defaults, cpuCeilingPercent: 94 }); await f.save(); wait.resolve(state()); await flush()
  assert.match(f.active(), /All off/); assert.equal(f.input('cpuCeilingPercent').value, '94'); assert.deepEqual(writes, [{ mode: 'off' }]); f.controller.destroy()
})

test('a changed saved value during a draft is preserved when another control is edited later', async () => {
  const f = fixture({ staged: true }); await flush(); f.edit('mode', 'off')
  f.saved(state({ ...defaults, cpuCeilingPercent: 94 })); await f.poll()
  assert.equal(f.input('cpuCeilingPercent').value, '94')
  assert.equal(f.root.querySelector('[data-resource-pending="cpuCeilingPercent"]').hidden, true)
  f.edit('reserve', 4096)
  await f.save(); assert.deepEqual(f.writes, [{ reserveBytes: 4096 * MIB, mode: 'off' }]); assert.equal(f.input('cpuCeilingPercent').value, '94'); f.controller.destroy()
})

test('a newly read high saved RAM value rebases the draft limits and never becomes an unintended write', async () => {
  const f = fixture({ staged: true }); await flush(); f.edit('mode', 'off')
  f.saved(state({ ...defaults, reserveBytes: 65536 * MIB })); await f.poll()
  assert.equal(f.input('reserve').value, '65536')
  assert.equal(f.input('reserve').max, '65536')
  assert.equal(f.input('reserve').getAttribute('aria-invalid'), 'false')
  assert.equal(f.root.querySelector('[data-resource-pending="reserve"]').hidden, true)
  assert.equal(f.draft.valid, true)
  await f.save(); assert.deepEqual(f.writes, [{ mode: 'off' }])
  assert.equal(f.input('reserve').value, '65536'); f.controller.destroy()
})

test('a lower host reservation cannot shrink the range underneath an edited memory slider', async () => {
  const f = fixture({ staged: true, saved: state({ ...defaults, reserveBytes: 65536 * MIB }) }); await flush()
  const slider = f.root.querySelector('[data-resource-slider="reserve"]')
  slider.value = '60000'; slider.dispatchEvent({ type: 'input' })
  f.saved(state()); await f.poll()
  assert.equal(slider.max, '65536'); assert.equal(f.input('reserve').value, '60000')
  assert.equal(f.draft.valid, true)
  await f.save(); assert.deepEqual(f.writes, [{ reserveBytes: 60000 * MIB }]); f.controller.destroy()
})

test('old mount replies are ignored and polling never stacks requests for one mounted panel', async () => {
  const first = deferred(), second = deferred(); let calls = 0
  const f = fixture({ api: { status: async () => ++calls === 1 ? first.promise : second.promise, configure: async () => ({ ok: false }) } })
  await f.poll(); await f.poll(); assert.equal(calls, 1)
  f.render(); second.resolve(state({ ...defaults, mode: 'both' })); await flush(); first.resolve(state()); await flush()
  assert.equal(calls, 2); assert.match(f.active(), /Both/); f.controller.destroy(); assert.equal(f.timers.size, 0)
})

test('failed and hung polls mark old readings stale without destroying unsaved controls, then recover on a fresh reply', async () => {
  let fail = false, hang = false; const wait = deferred()
  const f = fixture({ staged: true, api: { status: async () => { if (fail) throw new Error('Monitor offline'); return hang ? wait.promise : state() }, configure: async () => ({ ok: false }) } })
  await flush(); f.edit('reserve', 4096); fail = true; await f.poll()
  assert.match(f.reading(), /unknown or stale/); assert.match(f.active(), /Last known saved/); assert.equal(f.input('reserve').value, '4096')
  fail = false; await f.poll(); assert.match(f.reading(), /85.0%/)
  hang = true; await f.poll(); f.advance(7000); await f.poll(); assert.match(f.reading(), /unknown or stale/)
  wait.resolve(state(defaults, MEASURED_AT + 7000)); await flush(); assert.match(f.reading(), /85.0%/); assert.equal(f.input('reserve').value, '4096'); f.controller.destroy()
})

test('a preview, remote or initially unavailable host leaves controls disabled and can recover without a page restart', async () => {
  const f = fixture({ available: false }); await flush(); assert.match(f.notice(), /preview or remote window does not change/)
  assert.equal(f.root.querySelector('[data-resource-fields]').disabled, true)
  assert.equal(f.timers.size, 0, 'An unavailable preview host must not keep a polling timer alive')
  f.available(true); f.render(); await flush(); assert.equal(f.timers.size, 1); assert.equal(f.root.querySelector('[data-resource-fields]').disabled, false); f.controller.destroy()
})

test('saved RAM above physical capacity remains exact, while older hosts cannot receive unsupported controls', async () => {
  const f = fixture({ saved: state({ ...defaults, reserveBytes: 64 * 1024 * MIB }) }); await flush()
  assert.equal(f.input('reserve').value, '65536'); assert.equal(f.input('reserve').max, '65536'); assert.equal(f.writes.length, 0); f.controller.destroy()
  const legacy = { mode: 'mechanical', reserveBytes: defaults.reserveBytes, providerBytes: defaults.providerBytes }
  const old = fixture({ saved: state(legacy) }); await flush(); assert.equal(old.input('cpuCeilingPercent').disabled, true); old.edit('mode', 'off'); await old.save()
  assert.deepEqual(old.writes, [{ mode: 'off' }]); old.controller.destroy()
})

test('Refresh can replace a hung request and its late reply cannot undo recovery', async () => {
  const hung = deferred(); let calls = 0
  const f = fixture({ api: { status: async () => ++calls === 1 ? hung.promise : state({ ...defaults, mode: 'both' }), configure: async () => ({ ok: false }) } })
  f.root.querySelector('[data-resource-refresh]').click(); await flush(); assert.match(f.active(), /Both/)
  hung.resolve(state()); await flush(); assert.match(f.active(), /Both/); f.controller.destroy()
})

test('controller policy explains Native-only incompatibility for new controllers and preserves existing sessions and drafts', async () => {
  const native = { known: true, mode: 'Native tools only', available: false }
  const f = fixture({ staged: true, saved: { ...state(), newControllerTools: native } }); await flush()
  const notice = () => f.root.querySelector('[data-resource-controller-tools]')
  assert.equal(notice().hidden, true)
  for (const mode of ['both', 'controller']) {
    f.edit('mode', mode); assert.equal(notice().hidden, false)
    assert.match(notice().textContent, /New resource controllers.*Native tools only/)
    assert.match(notice().textContent, /Already running controllers.*may continue/)
    assert.equal(notice().querySelector('a').getAttribute('href'), '#/settings?setting=agent.agent_api')
    assert.equal(f.draft.valid, true); assert.equal(f.writes.length, 0)
  }
  f.saved({ ...state(), newControllerTools: { known: true, mode: 'ToolsEnabled and native tools', available: true } }); await f.poll()
  assert.equal(notice().hidden, true); assert.equal(f.input('mode').value, 'controller')
  f.saved({ ...state(), newControllerTools: { known: false, available: null, mode: null } }); await f.poll()
  assert.match(notice().textContent, /could not be checked/)
  f.controller.destroy()
})

test('a slow resource read does not multiply on timer ticks and polling resumes after failure', async () => {
  const reads = []
  const f = fixture({ status: () => { const read = Promise.withResolvers(); reads.push(read); return read.promise }, configure: async () => state() })
  try {
    for (let n = 0; n < 10; n++) for (const tick of f.timers) tick()
    assert.equal(reads.length, 1)
    reads[0].reject(new Error('temporary failure')); await flush()
    assert.match(f.root.querySelector('[data-resource-notice]').textContent, /could not be read/)
    for (const tick of f.timers) tick()
    assert.equal(reads.length, 2)
    reads[1].resolve(state()); await flush()
    assert.match(f.root.querySelector('[data-resource-reading]').textContent, /85.0%/)
  } finally { f.controller.destroy() }
})

test('an old resource read cannot undo a saved policy and no reads start during a write', async () => {
  const oldRead = Promise.withResolvers()
  const write = Promise.withResolvers()
  let reads = 0
  const f = fixture({ status: () => ++reads === 1 ? Promise.resolve(state()) : oldRead.promise, configure: () => write.promise })
  try {
    await flush()
    for (const tick of f.timers) tick()
    const form = f.root.querySelector('[data-resource-form]')
    form.querySelector('[name="mode"]').value = 'off'
    form.dispatchEvent({ type: 'submit' })
    for (const tick of f.timers) tick()
    assert.equal(reads, 2)
    write.resolve({ ...state(), mode: 'off', settings: { ...state().settings, mode: 'off' } }); await flush()
    oldRead.resolve(state()); await flush()
    assert.match(f.root.querySelector('[data-resource-policy]').textContent, /Active policy: All off/)
  } finally { f.controller.destroy() }
})

test('remounting can fetch fresh data without waiting for a retired panel read', async () => {
  const reads = []
  const f = fixture({ status: () => { const read = Promise.withResolvers(); reads.push(read); return read.promise }, configure: async () => state() })
  try {
    f.root.innerHTML = f.controller.markup(); f.controller.afterRender(f.root)
    assert.equal(reads.length, 2)
    reads[1].resolve({ ...state(), cpuPercent: 12 }); await flush()
    reads[0].resolve(state()); await flush()
    assert.match(f.root.querySelector('[data-resource-reading]').textContent, /12.0%/)
    for (const tick of f.timers) tick()
    assert.equal(reads.length, 3)
  } finally { f.controller.destroy() }
})

test('a saved policy can refresh while a superseded policy read is still pending', async () => {
  const reads = []
  const f = fixture({ status: () => { const read = Promise.withResolvers(); reads.push(read); return read.promise },
    configure: async next => state({ ...defaults, ...next }) })
  try {
    reads[0].resolve(state()); await flush()
    for (const tick of f.timers) tick()
    f.root.querySelector('[name="mode"]').value = 'off'
    f.root.querySelector('[data-resource-form]').dispatchEvent({ type: 'submit' }); await flush()
    for (const tick of f.timers) tick()
    assert.equal(reads.length, 3, 'an obsolete read must not block the saved policy from refreshing')
    reads[1].resolve(state()); await flush()
    for (const tick of f.timers) tick()
    assert.equal(reads.length, 3, 'settling the obsolete read must not release the newer flight')
    reads[2].resolve({ ...state(), mode: 'off', settings: { ...state().settings, mode: 'off' } }); await flush()
    assert.match(f.root.querySelector('[data-resource-policy]').textContent, /Active policy: All off/)
  } finally { f.controller.destroy() }
})

test('a zero-valued interval handle is released on remount, hidden category and destroy', async () => {
  const document = createDocument(), root = document.createElement('main')
  const released = []; let scheduled = 0, reads = 0
  const controller = createResourceSettings({ bridge: () => ({ status: async () => { reads++; return state() }, configure: async () => state() }),
    schedule: () => { scheduled++; return 0 }, unschedule: handle => released.push(handle) })
  root.innerHTML = controller.markup(); controller.afterRender(root)
  controller.afterRender(root)
  root.innerHTML = ''; controller.afterRender(root)
  await flush()
  assert.equal(scheduled, 2); assert.equal(reads, 2)
  assert.deepEqual(released, [0, 0], 'leaving Resources must release its timer even when the scheduler returns zero')
  root.innerHTML = controller.markup(); controller.afterRender(root); controller.destroy()
  await flush()
  assert.equal(scheduled, 3); assert.equal(reads, 3)
  assert.deepEqual(released, [0, 0, 0])
})

test('a window with no resource bridge shows no loading lines and no policy value', async () => {
  // T1525: 'Reading CPU and RAM…' and 'Loading the saved resource policy…' stayed
  // forever and the select showed 'Both', a policy nothing had read.
  const f = fixture({ available: false }); await flush()
  assert.doesNotMatch(f.reading(), /Reading CPU and RAM/)
  assert.match(f.reading(), /desktop app/)
  assert.equal(f.active(), '', 'a policy line claims to be loading or names a policy')
  assert.equal(f.input('mode').value, '', 'the policy select shows a value nothing read')
  assert.equal(f.root.querySelector('[data-resource-refresh]').hidden, true, 'a Refresh that cannot read anything is offered')
  f.controller.destroy()
})

test('in the desktop app the Resources panel reads this computer with the example screens on', async () => {
  // T1565: with 'Show the example fleet' on, the desktop Settings said the policy
  // could not be read and called itself a preview or remote window.
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage
  let reads = 0
  globalThis.window = { mcShell: { getBridgeProof() {} }, mcResources: { status: async () => { reads++; return state() }, configure: async () => state() } }
  globalThis.localStorage = { getItem: key => key === 'mc.example' ? 'on' : null }
  const { resolveDataSource, currentDataSource } = await import('../../src/data-source.js')
  let controller
  try {
    await resolveDataSource()
    assert.equal(currentDataSource(), 'mock', 'the example screens are on')
    const root = createDocument().createElement('main')
    controller = createResourceSettings({ schedule: fn => fn, unschedule: () => {}, now: () => MEASURED_AT })
    root.innerHTML = controller.markup(); controller.bind(root); controller.afterRender(root)
    await flush()
    assert.ok(reads >= 1, 'the desktop resource bridge was not read')
    assert.doesNotMatch(root.querySelector('[data-resource-notice]').textContent, /preview or remote window/)
    assert.equal(root.querySelector('[data-resource-fields]').disabled, false, 'this computer\'s policy stays editable')
  } finally {
    controller?.destroy()
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    const { resolveDataSource } = await import('../../src/data-source.js')
    await resolveDataSource()
  }
})

test('profile reads cannot overwrite a newer resource poll or turn example screens into excluded coverage', async () => {
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage
  let example = false
  globalThis.window = { mcShell: { getBridgeProof() {} } }
  globalThis.localStorage = { getItem: key => key === 'mc.example' && example ? 'on' : null }
  const { resolveDataSource } = await import('../../src/data-source.js')
  const reads = []
  let f
  try {
    await resolveDataSource()
    f = fixture({ staged: true, status: () => { const read = Promise.withResolvers(); reads.push(read); return read.promise }, configure: async () => state() })
    const oldProfileRead = f.controller.readForProfile()
    assert.equal(reads.length,2)
    f.render()
    assert.equal(reads.length,3)
    reads[2].resolve(state({ ...defaults, mode: 'off', maxConcurrentStarts: 13 })); await flush()
    reads[1].resolve(state()); await oldProfileRead
    reads[0].resolve(state()); await flush()
    assert.equal(f.controller.profileState().savedSettings.mode,'off')
    assert.equal(f.controller.profileState().savedSettings.maxConcurrentStarts,13)
    const hiddenRead = Promise.withResolvers()
    const hidden = createResourceSettings({ bridge: () => ({ status: () => hiddenRead.promise, configure() {} }) })
    const profileRead = hidden.readForProfile()
    hidden.afterRender(createDocument().createElement('main'))
    hiddenRead.resolve(state()); await profileRead
    assert.equal(hidden.profileState().ready,true,'the global profile can read resources while a different category mounts')
    hidden.destroy()
    example = true; await resolveDataSource()
    const unavailable = f.controller.profileState()
    assert.equal(unavailable.applicable,true,'example display does not shrink complete profile coverage')
    assert.equal(unavailable.ready,false)
    assert.match(unavailable.error,/example screens turned off/)
    assert.throws(() => f.controller.stageForProfile({ mode: 'mechanical' }),/Read the resource policy/)
    assert.deepEqual(f.writes,[])
  } finally {
    f?.controller.destroy()
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
  }
})

test('accepted resource polls and refusals notify the global profile even without a draft edit', async () => {
  const observed = []
  let next = state(), reject = false, f
  f = fixture({ staged: true, status: async () => {
    if (reject) throw new Error('Resource host offline')
    return next
  }, configure: async () => next, onStateChange: () => observed.push(f.controller.profileState()) })
  try {
    await flush()
    assert.equal(observed.length,1)
    assert.equal(f.draft.dirty,false)
    next = state({ ...defaults, mode: 'off', cpuBusyPercent: 70 })
    await f.poll()
    assert.equal(observed.length,2)
    assert.equal(observed.at(-1).savedSettings.mode,'off')
    assert.equal(observed.at(-1).savedSettings.cpuBusyPercent,70)
    reject = true; await f.poll()
    assert.equal(observed.length,3,'failed reads also invalidate any named profile')
    f.available(false); await f.poll()
    assert.equal(observed.length,4,'an unavailable bridge cannot leave the previous profile active')
    assert.equal(f.draft.dirty,false)
    assert.deepEqual(f.writes,[])
  } finally { f.controller.destroy() }
})

/* BASIC IS BASIC (owner direction 2026-09-20, T782). A working profile hands
   this panel pacing values only; whether admission is enforced is the person's
   own setup. Staging a profile therefore keeps the saved -- or pending -- mode
   exactly, and a host that reports no mode is shown All off rather than being
   handed Mechanical as a side effect of the form. */
test('staging a working profile keeps the admission mode as saved or pending, and only changes pacing', async () => {
  /* profileState().ready needs the local desktop data source, arranged the
     way the profile-read case above arranges it. */
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage
  globalThis.window = { mcShell: { getBridgeProof() {} } }
  globalThis.localStorage = { getItem: () => null }
  const { resolveDataSource } = await import('../../src/data-source.js')
  try {
    await resolveDataSource()
    for (const mode of ['off', 'mechanical', 'controller', 'both']) {
      const f = fixture({ staged: true, saved: state({ ...defaults, mode }) })
      try {
        await flush()
        f.controller.stageForProfile({ maxConcurrentStarts: 2, reserveBytes: 4096 * MIB, cpuCeilingPercent: 90, cpuBusyPercent: 65, startIntervalMs: 500, busyStartIntervalMs: 7500, settleMs: 6000, sampleMaxAgeMs: 6000 })
        assert.equal(f.input('mode').value, mode, `${mode}: the saved admission mode is kept`)
        assert.equal(f.input('maxConcurrentStarts').value, '2', `${mode}: the pacing value is staged`)
        assert.equal(f.draft.dirty, true)
        await f.save()
        assert.equal(f.writes.length, 1)
        assert.equal(Object.hasOwn(f.writes[0], 'mode'), false, `${mode}: the write carries no mode at all`)
        assert.equal(f.writes[0].maxConcurrentStarts, 2)
      } finally { f.controller.destroy() }
    }
    /* A mode the person has pending on the form survives the profile too. */
    const f = fixture({ staged: true, saved: state({ ...defaults, mode: 'mechanical' }) })
    try {
      await flush()
      f.edit('mode', 'off', 'change')
      f.controller.stageForProfile({ maxConcurrentStarts: 16 })
      assert.equal(f.input('mode').value, 'off', 'the pending All off is not overwritten by a profile')
      assert.equal(f.input('maxConcurrentStarts').value, '16')
      /* A caller that does name a mode is still honoured. */
      f.controller.stageForProfile({ mode: 'controller' })
      assert.equal(f.input('mode').value, 'controller')
    } finally { f.controller.destroy() }
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
  }
})

test('a host that reports no admission mode is shown All off, never handed Mechanical by the form', async () => {
  const { mode, ...withoutMode } = defaults
  assert.equal(mode, 'mechanical', 'the fixture defaults name a mode this case removes')
  assert.equal(resourceFormValues(withoutMode).mode, 'off')
  assert.equal(resourceFormValues({}).mode, 'off')
  assert.equal(validateResourceForm(resourceFormValues(withoutMode), withoutMode).value.mode, 'off')
  const f = fixture({ staged: true, saved: { ...state(withoutMode), mode: undefined } })
  try {
    await flush()
    assert.equal(f.input('mode').value, 'off')
    f.edit('reserve', 3000, 'change')
    await f.save()
    assert.equal(f.writes.length, 1)
    assert.notEqual(f.writes[0].mode, 'mechanical', 'editing another field must not switch enforced admission on')
  } finally { f.controller.destroy() }
})
