/* THE QUICK SLIDERS ON THE SETTINGS LANDING PAGE (owner, 2026-09-15: "there
 * should be a few sliders for different things to be changed quickly and they
 * should be easily accessible on the settings landing page", then "the
 * sliders need like 5-6 options each").
 *
 * Five or six positions have to be five or six real answers. Most enum rows
 * carry three registry values, so a stop may set more than one row -- the
 * ladder those rows genuinely form -- and every stop names exactly the rows it
 * sets and the registry value for each. Moving a slider stages those rows into
 * the same draft keys their category controls use (`product:<id>`), touches no
 * other row, and a slider whose ladder this host cannot fully move is drawn
 * unavailable with the sentence that says so. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
installDomStandIn()
const { createQuickSliders, QUICK_SLIDERS } = await import('../../src/settings-quick-sliders.js')
const { createSettingsDraft, draftSettingsBridge } = await import('../../src/settings-draft.js')
const { PRODUCT_SETTING_IDS } = await import('../../src/research-settings.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const setsOf = spec => [...new Set(spec.stops.flatMap(stop => Object.keys(stop.values)))]
const ALL_SET = [...new Set(QUICK_SLIDERS.flatMap(setsOf))]
const row = (id, value, extra = {}) => ({ id, present: true, applicable: true, value, label: id, enforcement: { declared: true }, ...extra })
// Every row the strip can set, at the first stop of the slider that sets it.
const savedDefaults = () => {
  const values = {}
  for (const spec of QUICK_SLIDERS) for (const [id, value] of Object.entries(spec.stops[0].values)) if (!(id in values)) values[id] = value
  return values
}
const rowsFor = (overrides = {}, extra = {}) => {
  const values = { ...savedDefaults(), ...overrides }
  return ALL_SET.map(id => row(id, values[id], extra[id]))
}

function mount(rows = rowsFor(), { setReply = (id, value) => ({ ok: true, id, value }) } = {}) {
  const shell = { read: async () => ({ ok: true, available: true, rows }), set: async (id, value) => setReply(id, value) }
  const draft = createSettingsDraft()
  const bridge = draftSettingsBridge(shell, draft)
  const staged = []
  const controller = createQuickSliders({ draft, productSettings: bridge, onStaged: () => staged.push(draft.size) })
  const root = document.createElement('div')
  root.innerHTML = controller.markup()
  document.body.appendChild(root)
  controller.bind(root)
  return { root, draft, controller, staged }
}
const cell = (root, key) => root.querySelector(`[data-quick-slider="${key}"]`)
const stateOf = (root, key) => cell(root, key).querySelector('[data-quick-state]').textContent
const helpOf = (root, key) => cell(root, key).querySelector('[data-quick-help]').textContent
const setsOfCell = (root, key) => cell(root, key).querySelector('[data-quick-sets]').textContent
const sliderOf = (root, key) => cell(root, key).querySelector('[data-quick-range]')
const stopsOf = (root, key) => [...cell(root, key).querySelectorAll('[data-quick-stop]')]

test('every slider offers five or six labelled positions over rows this page writes', () => {
  assert.ok(QUICK_SLIDERS.length >= 3, 'the strip is more than one slider')
  for (const spec of QUICK_SLIDERS) {
    assert.ok(spec.stops.length >= 5 && spec.stops.length <= 6,
      `${spec.key} offers ${spec.stops.length} positions; the owner asked for five or six`)
    const labels = spec.stops.map(stop => stop.label)
    assert.equal(new Set(labels).size, labels.length, `${spec.key} repeats a position label`)
    for (const stop of spec.stops) {
      assert.ok(stop.label && stop.describe, `${spec.key} has a position with no label or sentence`)
      assert.ok(Object.keys(stop.values).length >= 1, `${spec.key} has a position that sets nothing`)
      for (const id of Object.keys(stop.values)) {
        assert.ok(PRODUCT_SETTING_IDS.includes(id), `${spec.key} sets ${id}, which this page does not write`)
      }
    }
    // No two positions may describe the same state, or one of them is unreachable.
    const shapes = spec.stops.map(stop => JSON.stringify(Object.entries(stop.values).sort()))
    assert.equal(new Set(shapes).size, shapes.length, `${spec.key} has two positions with the same values`)
  }
})

test('the sliders read the saved values, show them, name what they set, and stay put until moved', async () => {
  const { root, draft } = mount()
  await settle()
  assert.equal(stateOf(root, 'rules.filing_from'), 'Saved: Ledger page')
  assert.equal(sliderOf(root, 'rules.filing_from').value, '0')
  assert.equal(sliderOf(root, 'rules.filing_from').disabled, false)
  assert.match(helpOf(root, 'rules.filing_from'), /Only you add rules/)
  // A slider that moves more than one row says which.
  assert.match(setsOfCell(root, 'rules.filing_from'), /Sets rules\.filing_from, rules\.ask_when_unsure, rules\.agent_filed_needs_approval\./)
  assert.equal(setsOfCell(root, 'audit.retention'), '', 'a single-row slider needs no such line')
  assert.equal(stopsOf(root, 'capability.elevation_duration').length, 6)
  assert.equal(draft.dirty, false, 'reading staged nothing')
})

test('moving a slider stages every row its stop names, and only those', async () => {
  const { root, draft, staged } = mount()
  await settle()
  const slider = sliderOf(root, 'rules.filing_from')
  slider.value = '4'
  slider.dispatch('input')
  assert.match(helpOf(root, 'rules.filing_from'), /active immediately without your approval/, 'dragging previews the stop under the thumb')
  assert.equal(draft.dirty, false, 'dragging alone stages nothing')
  slider.dispatch('change')
  await settle()
  assert.equal(draft.value('product:rules.filing_from', null), 'Agents too')
  assert.equal(draft.value('product:rules.ask_when_unsure', null), false)
  assert.equal(draft.value('product:rules.agent_filed_needs_approval', null), false)
  assert.equal(draft.has('product:agent.blocked_question'), false, 'no row outside the stop was touched')
  assert.equal(draft.has('product:audit.retention'), false)
  assert.deepEqual(staged, [3])
  assert.equal(stateOf(root, 'rules.filing_from'), 'Pending: Applied at once. Save settings to apply.')
  assert.equal(cell(root, 'rules.filing_from').dataset.state, 'pending')
})

test('a stop button is the same act, and returning to the saved position clears the draft', async () => {
  const { root, draft } = mount()
  await settle()
  stopsOf(root, 'capability.elevation_duration')[5].click()
  await settle()
  assert.equal(draft.value('product:capability.elevation_duration', null), 600)
  assert.equal(stateOf(root, 'capability.elevation_duration'), 'Pending: 10 hours. Save settings to apply.')
  stopsOf(root, 'capability.elevation_duration')[0].click()
  await settle()
  assert.equal(draft.has('product:capability.elevation_duration'), false, 'a value that matches what is saved unstages')
  assert.equal(stateOf(root, 'capability.elevation_duration'), 'Saved: 5 min')
})

test('a saved combination no position describes is reported as a mix, not rounded to a stop', async () => {
  // Agents may file rules but their own asking is off and approval is on:
  // that is the "Agents file" rung, so move one row off it deliberately.
  const { root, draft } = mount(rowsFor({ 'rules.filing_from': 'Agents too', 'rules.ask_when_unsure': true, 'rules.agent_filed_needs_approval': false }))
  await settle()
  assert.equal(stateOf(root, 'rules.filing_from'), 'Saved: a mix of values')
  assert.equal(stopsOf(root, 'rules.filing_from').every(button => button.getAttribute('aria-pressed') === 'false'), true,
    'no position claims to be the saved one')
  assert.equal(draft.dirty, false, 'and nothing is staged to tidy it up')
})

test('a saved value between the stops is named, and no stop sentence describes it', async () => {
  // T1458: 61 minutes read 'Saved: a mix of values' with the thumb and sentence of '5 min'.
  const { root, draft } = mount(rowsFor({ 'capability.elevation_duration': 61, 'fleet.max_declared_agents': 100 },
    { 'capability.elevation_duration': { unit: 'minutes' }, 'fleet.max_declared_agents': { unit: 'agents' } }))
  await settle()
  assert.equal(stateOf(root, 'capability.elevation_duration'), 'Saved: 61 minutes')
  assert.equal(stateOf(root, 'fleet.max_declared_agents'), 'Saved: 100 agents')
  assert.match(helpOf(root, 'capability.elevation_duration'), /61 minutes, is not one of these stops/)
  assert.doesNotMatch(helpOf(root, 'capability.elevation_duration'), /expires after 5 minutes/)
  assert.doesNotMatch(helpOf(root, 'fleet.max_declared_agents'), /Up to 8 agents/)
  assert.equal(sliderOf(root, 'capability.elevation_duration').getAttribute('aria-valuetext'), '61 minutes, not one of the stops')
  assert.equal(sliderOf(root, 'capability.elevation_duration').value, '3', 'the thumb sits at the nearest stop, 1 hour')
  assert.equal(cell(root, 'capability.elevation_duration').dataset.offStop, 'true')
  assert.equal(stopsOf(root, 'capability.elevation_duration').every(button => button.getAttribute('aria-pressed') === 'false'), true,
    'no stop claims to be the saved one')
  assert.equal(draft.dirty, false, 'reading an off-stop value stages nothing')
})

test('a row this host does not carry takes only its own slider out of service', async () => {
  const rows = rowsFor().map(item => item.id === 'rules.ask_when_unsure'
    ? { id: item.id, present: false, reason: 'not in this payload' } : item)
  const { root, draft } = mount(rows)
  await settle()
  const slider = sliderOf(root, 'rules.filing_from')
  assert.equal(slider.disabled, true, 'a ladder this host cannot fully move is not offered')
  assert.equal(cell(root, 'rules.filing_from').dataset.state, 'unavailable')
  assert.match(cell(root, 'rules.filing_from').querySelector('[data-quick-message]').textContent, /Not available in this build/)
  slider.value = '1'
  slider.dispatch('change')
  await settle()
  assert.equal(draft.dirty, false, 'an unavailable slider staged nothing')
  assert.equal(stateOf(root, 'audit.retention'), 'Saved: 10,000', 'the other sliders are unaffected')
})

test('every position of every slider can be staged and read back', async () => {
  // The owner's acceptance: each option applies to the setting it controls.
  for (const spec of QUICK_SLIDERS) {
    const { root, draft } = mount()
    await settle()
    for (let index = 0; index < spec.stops.length; index += 1) {
      stopsOf(root, spec.key)[index].click()
      await settle()
      const stop = spec.stops[index]
      for (const [id, value] of Object.entries(stop.values)) {
        const staged = draft.value(`product:${id}`, Symbol('unstaged'))
        assert.ok(Object.is(staged, value) || Object.is(savedDefaults()[id], value),
          `${spec.key} position ${index} (${stop.label}) did not put ${id} at ${JSON.stringify(value)}`)
      }
      const shown = stateOf(root, spec.key)
      assert.ok(shown.includes(stop.label), `${spec.key} position ${index} reads "${shown}"`)
    }
  }
})

/* A POSITION THAT STOPS THE APPROVAL PROMPTS HAS TO SAY SO.
 *
 * "How much it checks with you" folds agent.tool_approvals into its ladder, so
 * a person dragging the thumb can switch off the prompt that asks before a
 * consequential tool call without ever opening the Tool use section. The
 * consequence therefore has to be readable at the slider: in the stop's own
 * label, and in the sentence that follows the thumb while it is being dragged.
 * Asserted by meaning -- the words "no prompts" in the label and a sentence
 * saying prompts stop -- not by matching one fixed string. */
test('every position that turns off the approval prompt says so in its label and while dragging', async () => {
  const spec = QUICK_SLIDERS.find(entry => entry.stops.some(stop => 'agent.tool_approvals' in stop.values))
  assert.ok(spec, 'a slider carries the approvals row')
  const off = spec.stops.filter(stop => stop.values['agent.tool_approvals'] === false)
  const on = spec.stops.filter(stop => stop.values['agent.tool_approvals'] === true)
  assert.ok(off.length >= 1 && on.length >= 1, 'the ladder runs from asking to not asking')

  for (const stop of off) {
    assert.match(stop.label, /no prompts/i, `"${stop.label}" says in its own label that prompts stop`)
    assert.match(stop.describe, /prompts stop/i, `"${stop.label}" says prompts stop in the sentence under the slider`)
  }
  for (const stop of on) {
    assert.doesNotMatch(stop.label, /no prompts/i, `"${stop.label}" leaves the prompts on and does not claim otherwise`)
    assert.match(stop.describe, /asked/i, `"${stop.label}" says you are still asked`)
  }

  // And the sentence actually reaches the page while the thumb is moving,
  // before anything is staged -- that is where a dragging person reads it.
  const { root } = mount()
  await settle()
  const slider = sliderOf(root, spec.key)
  const index = spec.stops.indexOf(off[0])
  slider.value = String(index)
  slider.dispatch('input')
  assert.equal(helpOf(root, spec.key), off[0].describe,
    'dragging onto the position shows its consequence before the value is staged')
  assert.match(helpOf(root, spec.key), /prompts stop/i)
})

/* T1523: an unavailable quick slider dimmed its whole picker to 60%, and the
   picker holds the one sentence that says why the slider cannot move and what
   to do (2.8:1 on White, 3.2:1 on Tan). Only the control may look inactive;
   the explanation keeps full text contrast. */
test('an unavailable slider dims its control, not the sentence that explains why', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../../src/settings-profile-settings.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/data-state="unavailable"/.test(selector) || !/opacity/.test(body)) continue
    for (const part of selector.split(/,(?![^()]*\))/).map(s => s.trim())) {
      assert.doesNotMatch(part, /\.quick-slider-picker$/, 'the whole picker, and the message inside it, is dimmed again')
      assert.doesNotMatch(part, /quick-slider-message/, 'the explanation itself is dimmed')
    }
  }
  const markup = readFileSync(new URL('../../src/settings-quick-sliders.js', import.meta.url), 'utf8')
  assert.match(markup, /<div class="quick-slider-picker">[\s\S]*<p class="quick-slider-message"/, 'the message moved out of the picker; re-check what is dimmed')
})

/* T1556: staging a step disables the sliders and stops for a moment, and a
   browser takes focus away from a control that becomes disabled. So an arrow
   key moved a slider one stop and dropped focus to the page, and the next key
   did nothing; Enter on a stop did the same. The stand-in models that one
   browser rule on these controls: disabling the focused control blurs it. */
test('keyboard focus stays on the slider, or the pressed stop, while its step is staged', async () => {
  const { root, draft } = mount()
  await settle()
  const blurWhenDisabled = node => {
    let value = Boolean(node.disabled)
    Object.defineProperty(node, 'disabled', {
      configurable: true,
      get: () => value,
      set: next => { value = Boolean(next); if (value && document.activeElement === node) document.activeElement = document.body },
    })
  }
  const key = 'rules.filing_from'
  const slider = sliderOf(root, key)
  for (const node of [slider, ...stopsOf(root, key)]) blurWhenDisabled(node)
  document.activeElement = document.body
  slider.focus()
  slider.value = '1'; slider.dispatch('input'); slider.dispatch('change')
  await settle()
  assert.equal(document.activeElement, slider, 'one arrow key and focus fell to the page')
  slider.value = '2'; slider.dispatch('input'); slider.dispatch('change')
  await settle()
  assert.equal(document.activeElement, slider, 'the second arrow key had nowhere to go')
  assert.equal(draft.value('product:rules.filing_from', null), 'Agents too', 'two steps moved the slider two stops')

  /* Focus the person moved elsewhere while the step staged stays where they put it. */
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  slider.focus()
  slider.value = '3'; slider.dispatch('input'); slider.dispatch('change')
  elsewhere.focus()
  await settle()
  assert.equal(document.activeElement, elsewhere)

  /* Enter on a stop, on a fresh strip. */
  const fresh = mount()
  await settle()
  const stop = stopsOf(fresh.root, key)[1]
  blurWhenDisabled(stop)
  stop.focus()
  stop.click()
  await settle()
  assert.equal(document.activeElement, stop, 'Enter on a stop dropped focus to the page')
  assert.equal(fresh.draft.value('product:rules.filing_from', null), 'Ledger page and /Request')
})
