import assert from 'node:assert/strict'
import test from 'node:test'

import { createResearchSettings, productValueError } from '../../src/research-settings.js'

const row = (id, value, extra = {}) => ({
  id,
  label: id === 'research.pipeline' ? 'Run research' : 'Run processes',
  present: true,
  control: 'toggle',
  value,
  provenance: { source: 'user' },
  capabilities: ['Runs the work you request.'],
  risks: ['The work can use computer resources.'],
  consequence: 'Allows requested work.',
  ...extra,
})

const answer = (masterValue = true) => ({
  ok: true,
  available: true,
  rows: [
    row('research.pipeline', masterValue),
    row('research.runner_process', true),
  ],
})

function inputFor(html, id) {
  const match = html.match(new RegExp(`<input[^>]*data-research-setting="${id.replace('.', '\\.')}"[^>]*>`))
  assert.ok(match, `${id} has its own checkbox in the module output`)
  return match[0]
}

test('a caller without an installed-application bridge gets uncertainty, not settings', () => {
  const html = createResearchSettings().markup()

  assert.match(
    html,
    /data-research-settings-absent[^>]*>[^<]*Open the ToolsEnabled desktop app/,
    'the module names the failed connection rather than claiming a definite settings state',
  )
  assert.doesNotMatch(html, /data-research-setting="/, 'an unread state supplies no actionable switches')
})

test('a rejected read remains an unanswered read rather than becoming a definite absence', async () => {
  const section = createResearchSettings({
    shell: { read: async () => { throw new Error('bridge closed') }, set: async () => ({ ok: true }) },
  })

  await section.load()
  const html = section.markup()
  assert.match(
    html,
    /data-research-settings-absent[^>]*>[^<]*could not be read/,
    'the module reports its own inconclusive read result',
  )
  assert.doesNotMatch(
    html,
    /does not carry the part that runs research work/,
    'a transport failure is not collapsed into a definite feature-absent answer',
  )
})

test('the research master controls both readings of a runner control and explains the disabled one', async () => {
  let current = answer(false)
  const section = createResearchSettings({
    shell: { read: async () => current, set: async () => ({ ok: true }) },
  })

  await section.load()
  const held = inputFor(section.markup(), 'research.runner_process')
  assert.match(held, /\sdisabled(?:\s|\/>)/, 'a runner fenced by the off master is disabled')
  assert.match(
    held,
    /title="Held back: the first switch in this section is off[^\"]*"/,
    'the disabled runner control carries the reason it cannot succeed',
  )

  current = answer(true)
  await section.load({ force: true })
  const released = inputFor(section.markup(), 'research.runner_process')
  assert.doesNotMatch(released, /\sdisabled(?:\s|\/>)/, 'the same runner is enabled when the master is on')
})

test('a readable switch without a writer is disabled with the write failure reason', async () => {
  const section = createResearchSettings({ shell: { read: async () => answer(true) } })

  await section.load()
  const control = inputFor(section.markup(), 'research.pipeline')
  assert.match(control, /\sdisabled(?:\s|\/>)/, 'a control that cannot be written is disabled')
  assert.match(
    control,
    /title="This installed copy cannot change these switches\.[^\"]*"/,
    'the unusable control carries the module\'s specific remedy',
  )
})

/* ------------------------------ outside control ------------------------------ */

test('the outside control row says what the port is doing now, not just what the switch says', async () => {
  const outside = (extra, shellState) => {
    const rows = [row('research.pipeline', true), row('app.outside_control', extra.value, { label: 'Letting a program outside this app press its buttons', ...extra })]
    return { ok: true, available: true, rows, outsideControl: shellState }
  }
  const statusOf = html => {
    const match = html.match(/data-research-setting-status="app\.outside_control">([^<]*)</)
    return match ? match[1] : ''
  }
  let current = outside({ value: false }, { available: true, enabled: false, applied: false, why: 'off', port: null })
  const section = createResearchSettings({ shell: { read: async () => current, set: async () => ({ ok: true }) } })
  await section.load()
  assert.equal(statusOf(section.markup({ section: 'System' })), '', 'off and shut says nothing')
  assert.doesNotMatch(inputFor(section.markup({ section: 'System' }), 'app.outside_control'), /\sdisabled(?:\s|\/>)/, 'the person may turn it on')

  current = outside({ value: true }, { available: true, enabled: true, applied: false, why: 'off', port: null })
  await section.load({ force: true })
  assert.equal(statusOf(section.markup({ section: 'System' })), 'You turned this on. It applies from the next time the app starts.')

  current = outside({ value: true }, { available: true, enabled: true, applied: true, why: 'setting', port: 9223, address: '127.0.0.1' })
  await section.load({ force: true })
  assert.equal(statusOf(section.markup({ section: 'System' })), 'On since this start: a program on this computer can drive this app through 127.0.0.1:9223.')

  current = outside({ value: false }, { available: true, enabled: false, applied: false, why: 'command-line', port: 9333 })
  await section.load({ force: true })
  assert.equal(statusOf(section.markup({ section: 'System' })), 'On for this run because the app was started with a port on its command line (9333), whatever this switch says.')
})
test('org size is editable while unmeasured concurrency is rendered as read-only information', async () => {
  const section = createResearchSettings({ shell: { read: async () => ({ ok: true, available: true, rows: [
    row('fleet.max_declared_agents', 64, { control: 'number', label: 'Organisation size' }),
    row('fleet.concurrency_limits', 'Current numeric limits are not measured.', { control: 'readback', label: 'Running capacity', readOnlyReason: 'This information is read-only.' }),
  ] }), set: async () => ({ ok: true }) } })
  await section.load()
  const html = section.markup({ section: 'Agents & delegation' })
  assert.match(html, /data-research-number="fleet.max_declared_agents"/)
  assert.match(html, /<output>Current numeric limits are not measured\.<\/output>/)
  assert.doesNotMatch(html, /data-research-(?:number|setting|text|choice)="fleet.concurrency_limits"/)
})

test('a bounded numeric control rejects invalid input before its writer runs', async () => {
  const numeric = row('tools.audit_batch_size', 512, { control: 'number', min: 1, max: 4096 })
  const writes = [], errors = []
  const section = createResearchSettings({ shell: {
    read: async () => ({ ok: true, available: true, rows: [row('tools.throughput', 'fast', { control: 'select', options: ['fast', 'strict'] }), numeric] }),
    set: async (id, value) => { writes.push(value); return { ok: true, value, draft: true } },
    setValidationError: (id, error) => errors.push(error),
  } })
  await section.load()
  for (const invalid of [NaN, Infinity, 1.5, '', -1, 0, 4097]) await section.setValue(numeric.id, invalid)
  assert.deepEqual(writes, [])
  assert.ok(errors.every(Boolean))
  await section.setValue(numeric.id, 4096)
  assert.deepEqual(writes, [4096])
  assert.equal(errors.at(-1), '')
  const html = section.markup({ section: 'Tool use' })
  assert.match(html, /data-research-range="tools.audit_batch_size"/)
  assert.match(html, /data-research-number="tools.audit_batch_size"/)
  assert.match(html, /value="4096"/)
  assert.equal(productValueError({ control: 'toggle' }, 'true'), 'Choose on or off.')
})

test('activity batching controls wait for Fast processing', async () => {
  const writes = []
  const section = createResearchSettings({ shell: {
    read: async () => ({ ok: true, available: true, rows: [
      row('tools.throughput', 'strict', { control: 'select', options: ['fast', 'strict'] }),
      row('tools.audit_batch_size', 512, { control: 'number', min: 1, max: 4096 }),
    ] }),
    set: async (id, value) => { writes.push(id); return { ok: true, value, draft: true } },
  } })
  await section.load()
  await section.setValue('tools.audit_batch_size', 1024)
  assert.deepEqual(writes, [])
  assert.match(section.markup({ section: 'Tool use' }), /Strict saves each record separately/)
  await section.setValue('tools.throughput', 'fast')
  await section.setValue('tools.audit_batch_size', 1024)
  assert.deepEqual(writes, ['tools.throughput', 'tools.audit_batch_size'])
})

test('editing an unrelated tool setting does not lose model discovery already in progress', async () => {
  let releaseDiscovery
  const section = createResearchSettings({ shell: {
    read: async () => ({ ok: true, available: true, rows: [
      row('agent.tool_summary', true),
      row('model.endpoint', 'http://127.0.0.1:11434', { control: 'text' }),
      row('model.name', 'saved-model', { control: 'pick' }),
    ] }),
    set: async (id, value) => ({ ok: true, value, draft: true }),
  }, readLocalRuntimes: () => new Promise(resolve => { releaseDiscovery = resolve }) })
  const reading = section.load()
  await Promise.resolve()
  await section.setValue('agent.tool_summary', false)
  releaseDiscovery({ ok: true, runtimes: [{ host: '127.0.0.1', port: 11434, listening: true, models: ['discovered-model'] }] })
  await reading
  assert.match(section.markup({ section: 'Local models' }), /data-research-value="discovered-model"/)
  assert.doesNotMatch(inputFor(section.markup({ section: 'Tool use' }), 'agent.tool_summary'), /checked/)
})

test('switches cannot write through a disabled research master or unavailable platform', async () => {
  const writes = []
  const state = answer(false)
  state.rows.push(row('tools.windows_only', false, { applicable: false }))
  const section = createResearchSettings({ shell: { read: async () => state,
    set: async (id, value) => { writes.push(id); return { ok: true, value } } } })
  await section.load()
  await section.setValue('research.runner_process', false)
  await section.setValue('tools.windows_only', true)
  assert.deepEqual(writes, [])
})

test('a late settings read cannot overwrite a newer result', async () => {
  let first, reads = 0
  const section = createResearchSettings({ shell: {
    read: () => ++reads === 1 ? new Promise(resolve => { first = resolve }) : Promise.resolve(answer(true)),
    set: async () => ({ ok: true }),
  } })
  const earlier = section.load()
  await section.load({ force: true })
  first(answer(false))
  await earlier
  assert.match(inputFor(section.markup(), 'research.pipeline'), /checked/)
})

test('search returns only the relevant category and accepts words in either order', async () => {
  const section = createResearchSettings({ shell: {
    read: async () => ({ ...answer(), rows: [...answer().rows,
      row('agent.agent_api', 'Disabled', { control: 'seg', options: ['Only', 'Enabled', 'Disabled'] }),
      row('purchases.require_owner_approval', true),
    ] }), set: async () => ({ ok: true }),
  } })
  await section.load()
  assert.equal(section.matches('tools native', 'Tool use'), true)
  assert.equal(section.matches('tools native', 'Research'), false)
  const html = section.markup({ section: 'Rules & approvals', query: 'purchase approval', searchResult: true })
  assert.match(html, /purchases.require_owner_approval/)
  assert.doesNotMatch(html, /data-setting-id="research.pipeline"/)
})
