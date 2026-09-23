import test from 'node:test'
import assert from 'node:assert/strict'
import { agentApiSettingMarkup, bindAgentApiSetting, optimizedSupportText } from '../../src/agent-api-setting.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(shell) {
  const status = { textContent: '' }
  const supportStatus = { textContent: '' }
  const modes = [...agentApiSettingMarkup().matchAll(/data-agent-api-mode=\"([^\"]+)\"/g)].map(match => match[1])
  const buttons = modes.map(mode => ({
    dataset: { agentApiMode: mode }, disabled: true, pressed: 'false', on: false,
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value },
    classList: { toggle() {} },
  }))
  const discovery = Object.fromEntries(['agent.tool_summary', 'agent.capability_recall'].map(id => [id, {
    input: { dataset: { agentApiDiscovery: id }, disabled: true, checked: false, indeterminate: true,
      setAttribute(name, value) { this[name] = value } },
    status: { textContent: '' },
  }]))
  const handlers = new Map()
  const root = {
    isConnected: true,
    querySelectorAll: selector => selector === '[data-agent-api-mode]' ? buttons : [],
    querySelector(selector) {
      if (selector === '[data-agent-api-status]') return status
      if (selector === '[data-agent-api-optimized-support]') return supportStatus
      for (const [id, row] of Object.entries(discovery)) {
        if (selector === `[data-agent-api-discovery="${id}"]`) return row.input
        if (selector === `[data-agent-api-discovery-status="${id}"]`) return row.status
      }
      return null
    },
    contains: element => buttons.includes(element) || Object.values(discovery).some(row => row.input === element),
    addEventListener(name, handler) { handlers.set(name, handler) },
  }
  let current = root
  bindAgentApiSetting({ querySelector: () => current }, shell)
  return { buttons, status, supportStatus, discovery,
    retire() { root.isConnected = false; current = null },
    press(mode) { const button = buttons.find(item => item.dataset.agentApiMode === mode)
      return handlers.get('click')({ target: { closest: () => button } }) },
    async choose(id, checked) {
      const row = discovery[id]
      row.input.checked = checked
      await handlers.get('change')?.({ target: { closest: () => row.input } })
    },
  }
}
function reading(value, extra = {}) {
  return { ok: true, available: true, rejected: [], rows: [{ id: 'agent.agent_api',
    present: true, control: 'seg', options: ['Only', 'Enabled', 'Disabled'], value }], ...extra }
}

test('the four choices are named, accessible, and inactive until read', () => {
  const html = agentApiSettingMarkup()
  assert.match(html, /role="group" aria-label="Agent API"/)
  assert.equal((html.match(/aria-pressed="false" disabled/g) || []).length, 4)
  assert.ok(html.indexOf('>Only<') < html.indexOf('>Optimized<'))
  assert.ok(html.indexOf('>Optimized<') < html.indexOf('>Enabled<'))
  assert.ok(html.indexOf('>Enabled<') < html.indexOf('>Disabled<'))
  assert.match(html, /data-agent-api-mode="Optimized"/)
  assert.match(html, /data-agent-api-optimized-support/)
  assert.match(html, /Applies to new sessions across this installation/)
  assert.match(html, /role="group" aria-label="Tool discovery"/)
})

test('each press persists through the settings bridge and selects the acknowledged value', async () => {
  const writes = []
  const ui = fixture({ read: async () => reading('Enabled'),
    set: async (id, value) => { writes.push({ id, value }); return { ok: true, id, value } },
  })
  assert.ok(ui.buttons.every(button => button.disabled))
  await tick()
  assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized').disabled, true)
  assert.equal(ui.supportStatus.textContent, 'This copy does not offer Optimized. Update the app to use it.')
  for (const value of ['Only', 'Disabled', 'Enabled']) {
    await ui.press(value)
    assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, value)
  }
  assert.deepEqual(writes, ['Only', 'Disabled', 'Enabled'].map(value => ({ id: 'agent.agent_api', value })))
  assert.match(ui.status.textContent, /outside that audit/)
})

test('a refused write preserves the saved choice and announces the failure', async () => {
  const ui = fixture({ read: async () => reading('Enabled'), set: async () => ({ ok: false }) })
  await tick()
  await ui.press('Disabled')
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Enabled')
  assert.match(ui.status.textContent, /Could not save/)
  assert.ok(ui.buttons.filter(button => button.dataset.agentApiMode !== 'Optimized').every(button => !button.disabled))
  assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized').disabled, true)
})

test('an unreadable, rejected, or older two-state setting never invents a selected mode', async () => {
  const old = reading(true); old.rows[0].control = 'toggle'
  for (const result of [{ ok: false }, old, reading('Only', { rejected: [{ id: 'agent.agent_api' }] })]) {
    let writes = 0
    const ui = fixture({ read: async () => result, set: async () => { writes++ } })
    await tick()
    await ui.press('Only')
    assert.ok(ui.buttons.every(button => button.disabled && button.pressed === 'false'))
    assert.equal(writes, 0)
  }
})

test('a browser copy with no settings bridge points to the desktop app and offers no retry', async () => {
  // T1536: 'Update the app and try again' and 'Reopen quick settings to try again' in a browser.
  const ui = fixture(null)
  await tick()
  assert.match(ui.status.textContent, /made in the ToolsEnabled desktop app/)
  assert.doesNotMatch(ui.status.textContent, /Update the app|try again/)
  for (const row of Object.values(ui.discovery)) {
    assert.match(row.status.textContent, /desktop app/)
    assert.doesNotMatch(row.status.textContent, /Reopen|try again/)
    assert.equal(row.input.disabled, true)
  }
  assert.ok(ui.buttons.every(button => button.disabled))
  // An installed copy whose read fails keeps its own sentences.
  const failing = fixture({ read: async () => ({ ok: false }), set: async () => {} })
  await tick()
  assert.match(failing.status.textContent, /Update the app and try again/)
})

test('a pending write prevents a second conflicting write', async () => {
  let acknowledge
  let writes = 0
  const ui = fixture({ read: async () => reading('Enabled'),
    set: (id, value) => { writes++; return new Promise(resolve => { acknowledge = () => resolve({ ok: true, id, value }) }) },
  })
  await tick()
  const pending = ui.press('Only')
  await ui.press('Disabled')
  assert.equal(writes, 1)
  assert.ok(ui.buttons.every(button => button.disabled))
  acknowledge()
  await pending
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Only')
})

function optimizedReading(summary = true, recall = true, extra = {}) {
  const base = reading('Enabled')
  return { ...base, rows: [...base.rows,
    { id: 'agent.tool_summary', present: true, control: 'toggle', value: summary },
    { id: 'agent.capability_recall', present: true, control: 'toggle', value: recall },
  ], ...extra }
}

const ALL_AGENT_API_MODES = ['Only', 'Optimized', 'Enabled', 'Disabled']
function agentApiReading(value = 'Enabled', options = ALL_AGENT_API_MODES, optimizedSupport, extra = {}) {
  const result = optimizedReading()
  const row = result.rows.find(item => item.id === 'agent.agent_api')
  row.value = value
  row.options = [...options]
  if (optimizedSupport !== undefined) row.optimizedSupport = optimizedSupport
  return { ...result, ...extra }
}


test('Optimized API reads both saved choices once without changing any setting', async () => {
  let reads = 0
  const writes = []
  const ui = fixture({ read: async () => { reads++; return optimizedReading(false, true) },
    set: async (...args) => { writes.push(args) } })
  assert.ok(Object.values(ui.discovery).every(row => row.input.disabled && row.input.indeterminate))
  await tick()
  assert.equal(reads, 1)
  assert.deepEqual(writes, [])
  assert.equal(ui.discovery['agent.tool_summary'].input.checked, false)
  assert.equal(ui.discovery['agent.capability_recall'].input.checked, true)
  assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && !row.input.indeterminate))
})

test('Optimized API saves each existing setting independently and reports when it applies', async () => {
  const writes = []
  const ui = fixture({ read: async () => optimizedReading(true, false),
    set: async (id, value) => { writes.push({ id, value }); return { ok: true, id, value } } })
  await tick()
  await ui.choose('agent.tool_summary', false)
  await ui.choose('agent.capability_recall', true)
  assert.deepEqual(writes, [{ id: 'agent.tool_summary', value: false }, { id: 'agent.capability_recall', value: true }])
  assert.match(ui.discovery['agent.tool_summary'].status.textContent, /new sessions/)
  assert.match(ui.discovery['agent.capability_recall'].status.textContent, /next message/)
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Enabled')
})

test('Optimized API keeps unreadable or rejected choices unknown without blocking a readable sibling', async () => {
  for (const defect of ['unavailable', 'rejected', 'invalid']) {
    let writes = 0
    const answer = optimizedReading(true, false)
    if (defect === 'unavailable') answer.available = false
    if (defect === 'rejected') answer.rejected = [{ id: 'agent.tool_summary' }]
    if (defect === 'invalid') answer.rows.find(row => row.id === 'agent.tool_summary').value = 'true'
    const ui = fixture({ read: async () => answer, set: async () => { writes++ } })
    await tick()
    const summary = ui.discovery['agent.tool_summary']
    assert.equal(summary.input.disabled, true, defect)
    assert.equal(summary.input.indeterminate, true, defect)
    await ui.choose('agent.tool_summary', false)
    assert.equal(writes, 0, defect)
    if (defect !== 'unavailable') assert.equal(ui.discovery['agent.capability_recall'].input.disabled, false, defect)
  }
})

test('Optimized API waits for a saved answer and marks unconfirmed writes unknown', async () => {
  let settle, writes = 0
  const ui = fixture({ read: async () => optimizedReading(),
    set: () => { writes++; return new Promise(resolve => { settle = resolve }) } })
  await tick()
  const pending = ui.choose('agent.tool_summary', false)
  assert.equal(ui.discovery['agent.tool_summary'].input.disabled, true)
  await ui.choose('agent.tool_summary', true)
  assert.equal(writes, 1)
  settle({ ok: true, id: 'agent.tool_summary', value: true })
  await pending
  assert.equal(ui.discovery['agent.tool_summary'].input.indeterminate, true)
  assert.match(ui.discovery['agent.tool_summary'].status.textContent, /Could not confirm/)
})

test('Optimized API does not paint late reads or saves into a retired drawer', async () => {
  let answer
  const cold = fixture({ read: () => new Promise(resolve => { answer = resolve }), set: async (id, value) => ({ ok: true, id, value }) })
  cold.retire()
  answer(optimizedReading())
  await tick()
  assert.ok(Object.values(cold.discovery).every(row => row.input.indeterminate))
  let settle
  const ui = fixture({ read: async () => optimizedReading(), set: (id, value) => new Promise(resolve => { settle = () => resolve({ ok: true, id, value }) }) })
  await tick()
  const pending = ui.choose('agent.capability_recall', false)
  const before = ui.discovery['agent.capability_recall'].status.textContent
  assert.equal(typeof settle, 'function', 'the control reaches the existing settings writer')
  ui.retire(); settle(); await pending
  assert.equal(ui.discovery['agent.capability_recall'].status.textContent, before)
})


test('an invalid Agent API receipt preserves the last confirmed mode and locks edits', async () => {
  const cases = [
    ['wrong id', { ok: true, id: 'agent.other', value: 'Disabled' }],
    ['missing id', { ok: true, value: 'Disabled' }],
    ['changed value', { ok: true, id: 'agent.agent_api', value: 'Only' }],
    ['missing value', { ok: true, id: 'agent.agent_api' }],
    ['unknown result', { ok: true }],
    ['null result', null],
    ['undefined result', undefined],
  ]
  for (const [label, receipt] of cases) {
    const ui = fixture({ read: async () => reading('Enabled'), set: async () => receipt })
    await tick()
    await ui.press('Disabled')
    assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Enabled', label)
    assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Disabled').pressed, 'false', label)
    assert.ok(ui.buttons.every(button => button.disabled), label)
    assert.match(ui.status.textContent, /Could not confirm the saved choice\. Last confirmed choice: Enabled\./, label)
  }
  const thrown = fixture({
    read: async () => reading('Enabled'),
    set: async () => { throw new Error('bridge unavailable') },
  })
  await tick()
  await thrown.press('Disabled')
  assert.equal(thrown.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Enabled')
  assert.ok(thrown.buttons.every(button => button.disabled))
  assert.match(thrown.status.textContent, /Could not confirm the saved choice\. Last confirmed choice: Enabled\./)
})

test('an explicit refusal preserves the last confirmed mode and leaves legacy retry enabled', async () => {
  let attempts = 0
  const writes = []
  const ui = fixture({
    read: async () => reading('Enabled'),
    set: async (id, value) => {
      writes.push({ id, value })
      attempts += 1
      return attempts === 1
        ? { ok: false, reason: 'provider refused this change' }
        : { ok: true, id, value }
    },
  })
  await tick()
  await ui.press('Disabled')
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Enabled')
  assert.ok(ui.buttons.filter(button => button.dataset.agentApiMode !== 'Optimized').every(button => !button.disabled))
  assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized').disabled, true)
  assert.match(ui.status.textContent, /Could not save the change\. provider refused this change/)
  await ui.press('Only')
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Only')
  assert.deepEqual(writes, [
    { id: 'agent.agent_api', value: 'Disabled' },
    { id: 'agent.agent_api', value: 'Only' },
  ])
})

test('installation support matrix is descriptive and never gates an advertised Optimized save', async () => {
  const support = {
    scope: 'installation',
    appliesTo: 'new-sessions',
    providers: [
      { provider: 'Provider Alpha', status: 'supported', reason: 'native bridge ready', nativeTools: ['files.read', 'shell.exec'] },
      { provider: 'Provider Beta', status: 'unsupported', reason: 'native enforcement unavailable', nativeTools: ['ignored.native'] },
      { provider: 'Provider Gamma', status: 'unknown', reason: 'not checked', nativeTools: ['ignored.native'] },
    ],
  }
  const writes = []
  const ui = fixture({
    read: async () => agentApiReading('Only', ALL_AGENT_API_MODES, support),
    set: async (id, value) => {
      writes.push({ id, value })
      return { ok: true, id, value }
    },
  })
  await tick()
  assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized').disabled, false)
  assert.equal(ui.supportStatus.textContent, 'Optimized works with Provider Alpha only. native bridge ready. '
    + 'Provider Beta and Provider Gamma sessions do not start while Optimized is selected.')
  assert.doesNotMatch(ui.supportStatus.textContent, /files\.read|shell\.exec|ignored\.native|: supported|: unsupported|: unknown/)
  assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && !row.input.indeterminate && row.input.checked))
  await ui.press('Optimized')
  assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, 'Optimized')
  assert.deepEqual(writes, [{ id: 'agent.agent_api', value: 'Optimized' }])
})

test('missing or malformed installation support metadata does not block an advertised Optimized choice', async () => {
  const cases = [
    ['missing', undefined],
    ['wrong scope', { scope: 'provider', appliesTo: 'new-sessions', providers: [{ provider: 'Provider', status: 'supported' }] }],
    ['wrong appliesTo', { scope: 'installation', appliesTo: 'existing-sessions', providers: [{ provider: 'Provider', status: 'supported' }] }],
    ['empty matrix', { scope: 'installation', appliesTo: 'new-sessions', providers: [] }],
    ['non-array matrix', { scope: 'installation', appliesTo: 'new-sessions', providers: 'unknown' }],
  ]
  for (const [label, support] of cases) {
    const writes = []
    const ui = fixture({
      read: async () => agentApiReading('Only', ALL_AGENT_API_MODES, support),
      set: async (id, value) => {
        writes.push({ id, value })
        return { ok: true, id, value }
      },
    })
    await tick()
    assert.equal(ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized').disabled, false, label)
    assert.match(ui.supportStatus.textContent, /^Could not read which providers can use Optimized\. /, label)
    assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && !row.input.indeterminate && row.input.checked), label)
    await ui.press('Optimized')
    assert.deepEqual(writes, [{ id: 'agent.agent_api', value: 'Optimized' }], label)
  }
})

test('a saved Optimized choice remains selected when the installation matrix later reports unsupported', async () => {
  const support = {
    scope: 'installation',
    appliesTo: 'new-sessions',
    providers: [{ provider: 'Provider Beta', status: 'unsupported', reason: 'native enforcement unavailable' }],
  }
  const writes = []
  const ui = fixture({
    read: async () => agentApiReading('Optimized', ALL_AGENT_API_MODES, support),
    set: async (id, value) => {
      writes.push({ id, value })
      return { ok: true, id, value }
    },
  })
  await tick()
  const optimized = ui.buttons.find(button => button.dataset.agentApiMode === 'Optimized')
  assert.equal(optimized.pressed, 'true')
  assert.equal(optimized.disabled, false)
  assert.equal(ui.supportStatus.textContent, 'No provider can use Optimized in this copy, so new sessions do not start while it is selected.')
  assert.deepEqual(writes, [])
  assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && !row.input.indeterminate && row.input.checked))
})


test('a settings conflict preserves the confirmed explicit mode and makes no fallback write', async () => {
  for (const confirmed of ['Only', 'Disabled', 'Optimized']) {
    const writes = []
    const result = agentApiReading(confirmed)
    result.rows[0].provenance = { source: 'user', reason: 'explicit choice' }
    const ui = fixture({
      read: async () => result,
      set: async (id, value) => {
        writes.push({ id, value })
        return { ok: false, id, reason: 'The canonical and compatibility choices conflict.' }
      },
    })
    await tick()
    const attempted = confirmed === 'Optimized' ? 'Only' : 'Optimized'
    await ui.press(attempted)
    assert.equal(ui.buttons.find(button => button.pressed === 'true').dataset.agentApiMode, confirmed)
    assert.match(ui.status.textContent, /canonical and compatibility choices conflict/)
    assert.deepEqual(writes, [{ id: 'agent.agent_api', value: attempted }])
    assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && row.input.checked))
  }
})

test('a conflict reported on opening never replaces stored choices with the rejected resolved value', async () => {
  const stored = { 'agent.agent_api': false, 'agent.tool_mode': 'ToolsEnabled and selected native tools' }
  const before = structuredClone(stored)
  const result = agentApiReading('Only', ALL_AGENT_API_MODES, undefined, {
    rejected: [{ id: 'agent.agent_api', reason: 'The canonical and compatibility choices conflict.' }],
  })
  let writes = 0
  const ui = fixture({
    read: async () => result,
    set: async (id, value) => { writes++; stored[id] = value; return { ok: true, id, value } },
  })
  await tick()
  await ui.press('Optimized')
  assert.equal(writes, 0)
  assert.deepEqual(stored, before)
  assert.ok(ui.buttons.every(button => button.disabled && button.pressed === 'false'))
  assert.match(ui.status.textContent, /cannot read or change the saved Agent API choice/)
  assert.ok(Object.values(ui.discovery).every(row => !row.input.disabled && row.input.checked))
})

test('the engine support rows read as one plain sentence set: Optimized works with Claude only (rc-0922)', () => {
  // The exact rows the engine's optimizedApiSupport() returns after the rc-0922 Codex decision.
  const claudeOnly = { scope: 'installation', appliesTo: 'new-sessions', providers: [
    { provider: 'claude', status: 'supported', nativeTools: ['Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch'],
      reason: 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits.' },
    ...[['codex', 'Codex'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['local', 'Local']].map(([provider, name]) => ({
      provider, status: 'unsupported', nativeTools: [],
      reason: `Optimized works with Claude only. ${name} sessions do not start while it is selected.` })),
  ] }
  assert.equal(optimizedSupportText(claudeOnly), 'Optimized works with Claude only. '
    + 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits. '
    + 'Codex, Gemini, Grok and local sessions do not start while Optimized is selected.')
  const everyone = { ...claudeOnly, providers: [claudeOnly.providers[0]] }
  assert.equal(optimizedSupportText(everyone), 'Optimized works with Claude. '
    + 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits.')
  for (const text of [optimizedSupportText(claudeOnly), optimizedSupportText(everyone)]) {
    assert.doesNotMatch(text, /codex:|claude:|supported\.|Glob|ToolSearch|undefined|null/)
  }
})
