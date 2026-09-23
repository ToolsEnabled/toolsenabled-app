/* THE QUICK SLIDERS ON THE SETTINGS LANDING PAGE.
 *
 * Owner, 2026-09-15: "i dont like the dropdown lets change that. there should
 * be a few sliders for different things to be changed quickly and they should
 * be easily accessible on the settings landing page", and then: "the sliders
 * need like 5-6 options each". The working profile slider
 * (src/settings-profile-settings.js) is the first of them; these are the
 * others.
 *
 * WHY A SLIDER CAN SET MORE THAN ONE ROW. Five or six positions have to be
 * five or six real answers. Most enum rows in the registry carry exactly
 * three values, so a five-stop slider over one of them would have to invent
 * two positions that enforce nothing -- the exact lie this product refuses
 * elsewhere. What IS real is the ladder the related rows form together: "who
 * may add a rule" runs from the Ledger page alone to agents filing rules that
 * apply without review, and each rung is a combination of values the engine
 * already enforces. So a stop names the rows it sets and the value for each,
 * the slider lists those rows under it, and nothing is written that the
 * position does not say out loud. A numeric row needs no ladder: its stops
 * are six real values inside the registry's own range.
 *
 * They stage into the same draft the rows' own controls in their categories
 * use (`product:<id>`), so the two never disagree and Save settings applies
 * both; a position already saved simply unstages.
 *
 * FOLDING IS NOT REMOVING. A row a ladder folds in keeps its own control in
 * its own category on the full Settings page, and still writes by itself;
 * tools/test/product-settings.test.mjs pins that for every folded row, so a
 * later change cannot quietly turn the fold into a split. Where a stop of a
 * fold carries a consequence a person would not expect from the slider's
 * title -- "How much it checks with you" can switch off the approval prompt
 * itself -- the stop says so in its own label and in the sentence that
 * follows the thumb as it is dragged, which is asserted in
 * tools/test/settings-quick-sliders.test.mjs.
 *
 * NO PROFILE LOGIC HERE. Moving one of these can take the saved profile off a
 * preset -- the profile slider then says so -- and nothing here writes a row
 * its stop does not name.
 *
 * PURE OVER THE ELEMENT IT IS HANDED, like the profile controller: the root
 * needs querySelector and addEventListener; the bridge needs read() and set().
 */

import { numericText, syncNumericRange } from './settings-numeric.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/* One entry per slider, in the order they are drawn. `stops` runs left to
   right, each with the exact registry values it sets; `label` is the short
   word under the tick and `describe` the line under the slider for the stop
   the thumb is on. `key` is the slider's own name in the page and the first
   row it sets is where its shortcut goes. */
export const QUICK_SLIDERS = Object.freeze([
  {
    key: 'rules.filing_from',
    title: 'Who adds standing rules',
    stops: [
      { label: 'Ledger page', values: { 'rules.filing_from': 'Ledger page only' },
        describe: 'Only you add rules, by hand on the Ledger page. A /Request typed in a chat is refused, and agents neither file rules nor ask about them.' },
      { label: 'Page + /Request', values: { 'rules.filing_from': 'Ledger page and /Request' },
        describe: 'You add rules on the Ledger page or by typing /Request in a chat. Agents neither file rules nor ask about them.' },
      { label: 'Agents ask', values: { 'rules.filing_from': 'Agents too', 'rules.ask_when_unsure': true, 'rules.agent_filed_needs_approval': true },
        describe: 'Agents may turn what you say into rules. They ask you first when unsure, and what they file waits for your approval on the Ledger page.' },
      { label: 'Agents file', values: { 'rules.filing_from': 'Agents too', 'rules.ask_when_unsure': false, 'rules.agent_filed_needs_approval': true },
        describe: 'Agents file rules from your words without asking first, and what they file still waits for your approval on the Ledger page.' },
      { label: 'Applied at once', values: { 'rules.filing_from': 'Agents too', 'rules.ask_when_unsure': false, 'rules.agent_filed_needs_approval': false },
        describe: 'Agents file rules from your words without asking, and those rules are active immediately without your approval.' },
    ],
  },
  {
    key: 'agent.blocked_question',
    title: 'How much it checks with you',
    stops: [
      { label: 'Ask, then wait', values: { 'agent.tool_approvals': true, 'agent.blocked_question': 'Stop and wait for me' },
        describe: 'You are asked before a tool does something consequential, and an agent needing an answer stops until you give it.' },
      { label: 'Ask, keep going', values: { 'agent.tool_approvals': true, 'agent.blocked_question': 'Switch to other work' },
        describe: 'You are asked before a consequential tool call. A question that blocks one job is filed in your Ledger, and the agent turns to other work.' },
      { label: 'No prompts, wait', values: { 'agent.tool_approvals': false, 'agent.blocked_question': 'Stop and wait for me' },
        describe: 'Approval prompts stop: a tool does something consequential without asking you first. An agent needing an answer still stops until you give it.' },
      { label: 'No prompts, keep going', values: { 'agent.tool_approvals': false, 'agent.blocked_question': 'Switch to other work' },
        describe: 'Approval prompts stop: a tool does something consequential without asking you first. A question that blocks one job is filed in your Ledger while the agent turns to other work.' },
      { label: 'No prompts, decides', values: { 'agent.tool_approvals': false, 'agent.blocked_question': 'Decide for itself' },
        describe: 'Approval prompts stop: a tool does something consequential without asking you first. An agent also answers its own question within your permission level. Reserved purchases still wait for you.' },
    ],
  },
  {
    key: 'fleet.max_declared_agents',
    title: 'How many agents you can declare',
    stops: [
      { label: '8', values: { 'fleet.max_declared_agents': 8 }, describe: 'Up to 8 agents in the declared organisation. Host and resource limits can still be stricter.' },
      { label: '16', values: { 'fleet.max_declared_agents': 16 }, describe: 'Up to 16 agents in the declared organisation. Host and resource limits can still be stricter.' },
      { label: '64', values: { 'fleet.max_declared_agents': 64 }, describe: 'Up to 64 agents in the declared organisation. Host and resource limits can still be stricter.' },
      { label: '128', values: { 'fleet.max_declared_agents': 128 }, describe: 'Up to 128 agents in the declared organisation. Host and resource limits can still be stricter.' },
      { label: '256', values: { 'fleet.max_declared_agents': 256 }, describe: 'Up to 256 agents in the declared organisation. Host and resource limits can still be stricter.' },
      { label: '512', values: { 'fleet.max_declared_agents': 512 }, describe: 'Up to 512 agents in the declared organisation. Host and resource limits can still be stricter.' },
    ],
  },
  {
    key: 'capability.elevation_duration',
    title: 'How long a permission grant lasts',
    stops: [
      { label: '5 min', values: { 'capability.elevation_duration': 5 }, describe: 'A temporary grant expires after 5 minutes. It grants no access by itself.' },
      { label: '15 min', values: { 'capability.elevation_duration': 15 }, describe: 'A temporary grant expires after 15 minutes. It grants no access by itself.' },
      { label: '30 min', values: { 'capability.elevation_duration': 30 }, describe: 'A temporary grant expires after 30 minutes. It grants no access by itself.' },
      { label: '1 hour', values: { 'capability.elevation_duration': 60 }, describe: 'A temporary grant expires after an hour. It grants no access by itself.' },
      { label: '4 hours', values: { 'capability.elevation_duration': 240 }, describe: 'A temporary grant expires after four hours. It grants no access by itself.' },
      { label: '10 hours', values: { 'capability.elevation_duration': 600 }, describe: 'A temporary grant expires after ten hours. It grants no access by itself.' },
    ],
  },
  {
    key: 'audit.retention',
    title: 'Activity history kept close',
    stops: [
      { label: '10,000', values: { 'audit.retention': 'Newest 10,000 events' }, describe: 'The newest 10,000 events stay fast to search. Older signed activity moves to sealed storage; nothing is deleted.' },
      { label: '50,000', values: { 'audit.retention': 'Newest 50,000 events' }, describe: 'The newest 50,000 events stay fast to search. Older signed activity moves to sealed storage; nothing is deleted.' },
      { label: '30 days', values: { 'audit.retention': 'Last 30 days' }, describe: 'The last 30 days stay fast to search. Older signed activity moves to sealed storage; nothing is deleted.' },
      { label: '90 days', values: { 'audit.retention': 'Last 90 days' }, describe: 'The last 90 days stay fast to search. Older signed activity moves to sealed storage; nothing is deleted.' },
      { label: 'Everything', values: { 'audit.retention': 'Keep everything' }, describe: 'Every event stays in the fast searchable window. Nothing moves to sealed storage.' },
    ],
  },
])

const NOT_IN_BUILD = 'Not available in this build. Update or reconnect the host.'
const NOT_HERE = 'Not applicable on this computer.'
const READING = 'Reading saved values…'
const UNREADABLE = 'The saved values could not be read. Press Read saved values to try again.'
const CANNOT_WRITE = 'This window cannot save host product policies.'
const MIXED = 'a mix of values'

// Every row any stop of this slider sets, in the order first mentioned.
const setsOf = spec => [...new Set(spec.stops.flatMap(stop => Object.keys(stop.values)))]

export function createQuickSliders({ draft, productSettings, onStaged = () => {}, onBusy = () => {}, isBlocked = () => false } = {}) {
  let root = null, rows = [], loaded = false, loading = false, error = '', generation = 0, queued = false, staging = false
  /* The stop a person is dragging towards, per slider, so the sentence under
     the slider follows the thumb before the values are staged on release. */
  const previewing = new Map()

  const specFor = key => QUICK_SLIDERS.find(spec => spec.key === key) || null
  const rowFor = id => rows.find(row => row.id === id) || null
  const valueOf = (id, saved = false) => {
    const row = rowFor(id)
    if (!row) return undefined
    return saved ? row.savedValue : draft.value(`product:${id}`, row.savedValue)
  }
  // The stop whose every named value is what the rows hold now, or -1 for a
  // combination no position describes -- which is a real state and is said so
  // rather than rounded to the nearest stop.
  const stopIndex = (spec, saved = false) =>
    spec.stops.findIndex(stop => Object.entries(stop.values).every(([id, value]) => Object.is(valueOf(id, saved), value)))
  const pending = spec => setsOf(spec).some(id => draft.has(`product:${id}`))
  /* A VALUE BETWEEN THE STOPS IS NAMED, NOT ROUNDED (T1458). A grant saved at
     61 minutes read 'Saved: a mix of values' with the thumb and sentence of
     '5 min'. A slider that sets one row names that row's value; the thumb goes
     to the nearest stop and nothing under it describes a stop not in effect. */
  function valueWords(spec, saved = false) {
    const sets = setsOf(spec)
    if (sets.length !== 1) return MIXED
    const value = valueOf(sets[0], saved)
    if (typeof value === 'number') return numericText(value, rowFor(sets[0])?.unit || '')
    return value == null || value === '' ? MIXED : String(value)
  }
  function nearestStop(spec) {
    const sets = setsOf(spec), value = sets.length === 1 ? valueOf(sets[0]) : undefined
    if (typeof value !== 'number') return 0
    let best = 0
    spec.stops.forEach((stop, index) => {
      if (Math.abs(stop.values[sets[0]] - value) < Math.abs(spec.stops[best].values[sets[0]] - value)) best = index
    })
    return best
  }

  function markup() {
    return QUICK_SLIDERS.map(spec => {
      const sets = setsOf(spec)
      return `<div class="quick-slider" data-quick-slider="${esc(spec.key)}" data-setting-shortcut="${esc(sets[0])}">
      <div class="quick-slider-head">
        <span class="quick-slider-title" id="quick-slider-title-${esc(spec.key)}">${esc(spec.title)}</span>
        <span class="quick-slider-state" data-quick-state aria-live="polite">${READING}</span>
      </div>
      <div class="quick-slider-picker">
        <label class="settings-sr-only" for="quick-slider-${esc(spec.key)}">${esc(spec.title)}</label>
        <input type="range" id="quick-slider-${esc(spec.key)}" data-quick-range="${esc(spec.key)}" min="0" max="${spec.stops.length - 1}" step="1" value="0" aria-describedby="quick-slider-help-${esc(spec.key)}" disabled>
        <div class="quick-slider-stops" style="--stops:${spec.stops.length}">${spec.stops.map((stop, index) => `<button type="button" data-quick-stop="${esc(spec.key)}" data-quick-index="${index}" aria-pressed="false" disabled>${esc(stop.label)}</button>`).join('')}</div>
        <p class="quick-slider-help" id="quick-slider-help-${esc(spec.key)}" data-quick-help></p>
        <p class="quick-slider-sets" data-quick-sets></p>
        <p class="quick-slider-message" data-quick-message role="status"></p>
      </div>
    </div>`
    }).join('')
  }

  function problemFor(spec) {
    if (typeof productSettings?.set !== 'function') return CANNOT_WRITE
    if (loading) return ''
    if (!loaded) return error || UNREADABLE
    // Every row a stop of this slider would set has to be here and enforced;
    // a slider that can move only half of its own ladder is not offered.
    for (const id of setsOf(spec)) {
      const row = rowFor(id)
      if (!row || row.present === false || row.enforcement?.declared === false) return NOT_IN_BUILD
      if (row.applicable === false) return NOT_HERE
    }
    return ''
  }

  function paintOne(spec) {
    const cell = root?.querySelector(`[data-quick-slider="${spec.key}"]`)
    if (!cell) return
    const slider = cell.querySelector('[data-quick-range]')
    const problem = problemFor(spec)
    const disabled = Boolean(problem) || loading || staging || draft.saving || isBlocked()
    const index = stopIndex(spec)
    const offStop = index < 0 && !previewing.has(spec.key)
    const shown = previewing.has(spec.key) ? previewing.get(spec.key) : (index >= 0 ? index : nearestStop(spec))
    slider.disabled = disabled
    slider.value = String(shown)
    syncNumericRange(slider)
    const stop = offStop ? null : spec.stops[shown] || null
    cell.dataset.offStop = String(offStop)
    slider.setAttribute('aria-valuetext', stop ? stop.label : `${valueWords(spec)}, not one of the stops`)
    for (const button of cell.querySelectorAll('[data-quick-stop]')) {
      button.disabled = disabled
      button.setAttribute('aria-pressed', String(Number(button.dataset.quickIndex) === index))
    }
    cell.dataset.state = problem ? 'unavailable' : loading ? 'loading' : pending(spec) ? 'pending' : 'saved'
    const savedStop = spec.stops[stopIndex(spec, true)] || null
    cell.querySelector('[data-quick-state]').textContent = loading ? READING : problem ? ''
      : pending(spec) ? `Pending: ${stop ? stop.label : valueWords(spec)}. Save settings to apply.`
        : `Saved: ${savedStop ? savedStop.label : valueWords(spec, true)}`
    cell.querySelector('[data-quick-help]').textContent = problem ? '' : stop ? stop.describe
      : setsOf(spec).length === 1 ? `The value, ${valueWords(spec)}, is not one of these stops. Choosing a stop replaces it.`
        : 'These values match none of the stops. Choosing a stop replaces them.'
    const sets = setsOf(spec)
    cell.querySelector('[data-quick-sets]').textContent = problem || sets.length < 2 ? ''
      : `Sets ${sets.map(id => rowFor(id)?.label || id).join(', ')}.`
    cell.querySelector('[data-quick-message]').textContent = problem
      || (draft.errors?.find?.(entry => sets.some(id => entry.key === `product:${id}`))?.message || '')
  }

  function paint() { if (root) for (const spec of QUICK_SLIDERS) paintOne(spec) }

  function sync() {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; paint() })
  }

  async function refresh() {
    const ticket = ++generation
    loading = true; error = ''; paint()
    let result = null
    try { result = await Promise.resolve().then(() => productSettings?.read?.()) }
    catch (cause) { result = null; error = cause?.message || UNREADABLE }
    if (ticket !== generation || !root) return
    if (result?.ok === true && result.available !== false && Array.isArray(result.rows)) {
      rows = result.rows.map(row => ({ ...row, savedValue: Object.hasOwn(row, 'savedValue') ? row.savedValue : row.value }))
      loaded = true
      error = ''
    } else if (!error) {
      error = result?.reason || UNREADABLE
    }
    loading = false
    previewing.clear()
    paint()
  }

  /* KEYBOARD FOCUS SURVIVES A STAGED STEP (T1556). Staging disables the
     sliders and stops for a moment, and a disabled control loses focus, so an
     arrow key moved a slider exactly one stop and dropped focus to the page;
     the next key did nothing. The control that had focus is named before the
     step and focused again once it is usable, unless the person has put focus
     somewhere else in the meantime. */
  function focusedControl() {
    const doc = root?.ownerDocument || globalThis.document
    const node = doc?.activeElement
    if (!node || !root?.contains?.(node)) return null
    if (node.matches?.('[data-quick-range]')) return `[data-quick-range="${node.dataset.quickRange}"]`
    if (node.matches?.('[data-quick-stop]')) return `[data-quick-stop="${node.dataset.quickStop}"][data-quick-index="${node.dataset.quickIndex}"]`
    return null
  }
  function restoreFocus(selector) {
    if (!selector || !root) return
    const doc = root.ownerDocument || globalThis.document
    const active = doc?.activeElement
    if (active && active !== doc.body && active !== doc.documentElement && !root.contains?.(active)) return
    const target = root.querySelector(selector)
    if (!target || target.disabled || target === active) return
    target.focus?.({ preventScroll: true })
  }

  async function choose(key, index) {
    const spec = specFor(key)
    if (!spec || staging || loading || draft.saving || isBlocked() || problemFor(spec)) return
    const stop = spec.stops[index]
    if (!stop) return
    previewing.delete(key)
    const held = focusedControl()
    staging = true; onBusy(true); paint()
    try {
      // Only the rows this position names, and each through the row's own
      // shared writer, so a category control and this slider stay one edit.
      for (const [id, value] of Object.entries(stop.values)) await productSettings.set(id, value)
      onStaged()
    } catch (cause) {
      const cell = root?.querySelector(`[data-quick-slider="${key}"]`)
      if (cell) cell.querySelector('[data-quick-message]').textContent = `${cause?.message || 'That change could not be staged.'} Any staged changes remain visible; review or discard them.`
    } finally {
      staging = false; onBusy(false); paint()
      restoreFocus(held)
    }
  }

  function input(event) {
    const slider = event.target?.matches?.('[data-quick-range]') ? event.target : null
    if (!slider || staging || loading) return
    previewing.set(slider.dataset.quickRange, Number(slider.value))
    const spec = specFor(slider.dataset.quickRange)
    if (spec) paintOne(spec)
  }
  function change(event) {
    const slider = event.target?.matches?.('[data-quick-range]') ? event.target : null
    if (!slider) return
    void choose(slider.dataset.quickRange, Number(slider.value))
  }
  function click(event) {
    const stop = event.target?.closest?.('[data-quick-stop]')
    if (stop) void choose(stop.dataset.quickStop, Number(stop.dataset.quickIndex))
  }

  return {
    markup, sync, refresh, choose,
    bind(target) {
      root = target
      root.addEventListener('input', input)
      root.addEventListener('change', change)
      root.addEventListener('click', click)
      void refresh()
    },
    destroy() {
      generation += 1
      root?.removeEventListener('input', input)
      root?.removeEventListener('change', change)
      root?.removeEventListener('click', click)
      root = null
    },
  }
}
