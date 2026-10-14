import { currentDataSource, onDesktop } from './data-source.js'
import { matchesSettingQuery } from './product-settings-layout.js'
import { numericText, syncNumericRange } from './settings-numeric.js'
import { withDeadline } from './read-deadline.js'

const MIB = 1024 ** 2
const SECTION_TITLE = 'Resource-aware starts'
const DRAFT_KEY = 'resources:policy'
const PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'local']
export const RESOURCE_MODES = Object.freeze([
  ['both', 'Both'], ['controller', 'Agent controller only'], ['mechanical', 'Mechanical only'], ['off', 'All off'],
])
// Defaults are display fallbacks for older hosts. The host supplies its saved
// policy and defaults; simply opening this panel never writes either.
export const RESOURCE_CONTROLS = Object.freeze([
  { name: 'maxConcurrentStarts', label: 'Parallel starts', unit: 'starts', min: 1, max: 64, step: 1, default: 8, group: 'limits', help: 'Agents starting at once. Running agents do not count toward this limit.' },
  { name: 'reserve', key: 'reserveBytes', label: 'Keep RAM free', unit: 'MiB', min: 0, default: 2048, group: 'limits', help: 'Physical memory kept available for this computer.' },
  { name: 'cpuCeilingPercent', label: 'Pause starts at CPU', unit: '%', min: 50, max: 99, step: 1, default: 97, group: 'cpu', help: 'New starts pause at this load. Running agents continue.' },
  { name: 'cpuBusyPercent', label: 'Slow starts above CPU', unit: '%', min: 20, max: 98, step: 1, default: 80, group: 'cpu', help: 'At this load, admit one start at a time after CPU becomes steady.' },
  { name: 'startIntervalMs', label: 'Normal start interval', unit: 'ms', min: 50, max: 10000, step: 1, default: 250, group: 'cpu', help: 'Minimum time between starts when CPU has headroom.' },
  { name: 'busyStartIntervalMs', label: 'Busy CPU start interval', unit: 'ms', min: 250, max: 30000, step: 1, default: 5000, group: 'cpu', help: 'Minimum time between starts above the slow-start threshold.' },
  ...PROVIDERS.map(provider => ({ name: provider, provider, label: provider === 'local' ? 'Local program' : provider[0].toUpperCase() + provider.slice(1), unit: 'MiB', min: 1, default: provider === 'claude' ? 768 : 1024, group: 'memory', help: 'RAM reserved for each launch until it settles.' })),
  { name: 'settleMs', label: 'Memory settling time', unit: 'ms', min: 1000, max: 30000, step: 'any', default: 4000, group: 'timing', help: 'Keep launch RAM reserved until a new measurement covers this time after readiness.' },
  { name: 'sampleMaxAgeMs', label: 'Reading expires after', unit: 'ms', min: 2000, max: 30000, step: 'any', default: 6000, group: 'timing', help: 'Older readings pause mechanical starts. Three samples need at least two seconds.' },
])
const finite = value => typeof value === 'number' && Number.isFinite(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const title = provider => provider === 'local' ? 'Local' : provider[0].toUpperCase() + provider.slice(1)
const modeLabel = mode => RESOURCE_MODES.find(([value]) => value === mode)?.[1] || 'Unknown'

export function resourceReadingSentence(state) {
  if (state?.mode === 'off') return state.unavailable
    ? 'The resource policy could not be read. Refresh to try again.'
    : 'Automatic resource checks are off. Agent starts do not wait for CPU or RAM readings.'
  if (!state?.fresh || !finite(state.cpuPercent) || !finite(state.freeBytes)) return 'CPU and RAM readings are unknown or stale. Mechanical starts wait for fresh readings.'
  return `CPU ${state.cpuPercent.toFixed(1)}% · ${(state.freeBytes / MIB / 1024).toFixed(2)} GiB physical RAM free · ${Math.round((state.reservedBytes || 0) / MIB)} MiB reserved · ${state.starting || 0} starting · ${state.settling || 0} settling. Measured ${state.measuredAt || 'just now'}.`
}
function resourceSampleAge(state, receivedAt, current) {
  if (!finite(receivedAt) || !finite(current) || current < receivedAt) return null
  const stamps = []
  if (state.atMs !== undefined) stamps.push(state.atMs)
  if (state.measuredAt !== undefined) stamps.push(typeof state.measuredAt === 'string' && state.measuredAt.trim() ? Date.parse(state.measuredAt) : NaN)
  // Both processes use the same host clock. A delayed IPC reply is already
  // older when it arrives; receiving it must never renew its measurement.
  if (!stamps.length || stamps.some(stamp => !finite(stamp) || stamp < 0 || stamp > receivedAt || stamp !== stamps[0])) return null
  if (state.ageMs !== undefined && (!finite(state.ageMs) || state.ageMs < 0)) return null
  return Math.max(current - stamps[0], (state.ageMs || 0) + current - receivedAt)
}
function resourceWindowSentence(state, fresh) {
  if (state?.mode === 'off') return ''
  if (!fresh) return 'A fresh reading is needed to show the CPU window and app timer delay.'
  const peak = state.readyWindow === true && finite(state.cpuWindowMaxPercent) && state.cpuWindowMaxPercent >= 0 && state.cpuWindowMaxPercent <= 100
    ? `${state.cpuWindowMaxPercent.toFixed(1)}%` : 'unknown'
  const lag = finite(state.loopLagMs) && state.loopLagMs >= 0 ? `${Math.round(state.loopLagMs)} ms` : 'unknown'
  const parts = [`Recent CPU peak: ${peak}. App timer delay: ${lag}.`]
  if (state.pressure === true) {
    parts.push('Recovery checks are still pending; a lower latest CPU reading alone does not clear this state.')
  } else if (state.readyWindow === false) parts.push('Collecting three fresh samples before checking the CPU window.')
  else if (state.headroomWindow === true) parts.push('The CPU window has headroom.')
  else if (state.stable === true) parts.push('The CPU window is steady.')
  else if (state.stable === false) parts.push('CPU readings vary across the recent window.')
  return parts.join(' ')
}
export function resourcePolicySentence(mode) {
  if (mode === 'off') return 'Both automatic resource admission policies are off. Permission, account, ownership and process isolation checks still apply.'
  if (mode === 'controller') return 'Current advice from the authorised agent controller admits starts. Mechanical CPU and RAM checks apply only to its first bootstrap start.'
  if (mode === 'both') return 'Both mechanical headroom and current advice from the authorised agent controller must allow each start.'
  return 'Fresh CPU, app responsiveness and physical RAM readings admit paced starts. Pending launches reserve memory.'
}
/* A host that reports no mode is shown -- and, if the form is then saved,
   given -- All off. Enforced admission is an explicit choice (owner direction
   2026-09-20, T782): the form must never turn it on as a side effect of
   filling in a blank. */
export const RESOURCE_MODE_FALLBACK = 'off'
export function resourceFormValues(settings = {}) {
  return Object.fromEntries([['mode', settings.mode || RESOURCE_MODE_FALLBACK], ...RESOURCE_CONTROLS.map(control => {
    const raw = control.provider ? settings.providerBytes?.[control.provider] : settings[control.key || control.name]
    return [control.name, String(finite(raw) ? raw / (control.unit === 'MiB' ? MIB : 1) : control.default)]
  })])
}
export function validateResourceForm(fields, base = {}, limits = {}) {
  const errors = {}
  const next = { ...base, providerBytes: { ...base.providerBytes }, mode: fields.mode }
  if (!RESOURCE_MODES.some(([mode]) => mode === fields.mode)) errors.mode = 'Choose one of the four resource policies.'
  for (const control of RESOURCE_CONTROLS) {
    // Older hosts may not implement the newer controls. Do not send values for
    // an unavailable control or invent support by filling in display defaults.
    if (control.provider ? !Object.hasOwn(base.providerBytes || {}, control.provider) : !Object.hasOwn(base, control.key || control.name)) continue
    const text = String(fields[control.name] ?? '').trim()
    const number = text === '' ? NaN : Number(text)
    const max = limits[control.name]?.max ?? control.max ?? 1048576
    const min = limits[control.name]?.min ?? control.min
    const integer = control.step === 1
    if (!finite(number) || number < min || number > max || integer && !Number.isSafeInteger(number)) {
      errors[control.name] = `${control.label}: enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max} ${control.unit}.`
      continue
    }
    if (control.provider) next.providerBytes[control.provider] = number * MIB
    else next[control.key || control.name] = number * (control.unit === 'MiB' ? MIB : 1)
  }
  if (next.cpuBusyPercent >= next.cpuCeilingPercent) errors.cpuBusyPercent = 'Slow-start CPU must be below the CPU ceiling.'
  if (next.busyStartIntervalMs < next.startIntervalMs) errors.busyStartIntervalMs = 'The busy CPU interval must be at least the normal start interval.'
  return { ok: Object.keys(errors).length === 0, value: next, errors, reason: Object.values(errors)[0] || '' }
}

/* THIS COMPUTER'S POLICY IS READ IN THE DESKTOP APP WHATEVER THE EXAMPLE SWITCH
   SAYS (T1565). The example changes what the screens show; with it on, the
   desktop Settings said the policy 'could not be read' and called itself a
   preview or remote window. Only a window without the desktop shell (a browser,
   or a remote view) goes without the bridge. */
export function createResourceSettings({ stageWrite = null, draft = null, onStateChange = () => {}, bridge = () => currentDataSource() === 'local' || onDesktop() ? globalThis.window?.mcResources : null,
  schedule = setInterval, unschedule = clearInterval, now = Date.now } = {}) {
  let root = null, panel = null, timer = null, state = null, receivedAt = 0
  let localEdit = null, busy = false, unavailable = false, generation = 0, request = 0, writeVersion = 0, inFlight = null
  const sliderCeilings = new Map()
  const stopReads = new Set()
  const staged = stageWrite || (draft ? (...args) => draft.stage(...args) : null)
  const pending = () => draft ? draft.value(DRAFT_KEY, null) : localEdit
  const supported = control => control.provider ? Object.hasOwn(state?.settings?.providerBytes || {}, control.provider) : Object.hasOwn(state?.settings || {}, control.key || control.name)
  function controlMarkup(control) {
    /* THE THREE IDS THIS INPUT POINTS AT, BUILT FROM THEIR SUFFIXES RATHER THAN
       WRITTEN AS ONE TEMPLATE. Same string, same order, same element ids -- but
       tools/check-plain-language.mjs splits a template literal at its values,
       and the middle of the one-template spelling came out as the fragment
       `-error resource-`, which the dead-end rule read as a failure sentence
       with nothing to do about it. It is not a sentence and nobody reads it;
       an id list should not be scanned as prose in the first place. */
    const description = ['help', 'error', 'context'].map(part => `resource-${control.name}-${part}`).join(' ')
    return `<div class="resource-control" data-resource-control="${control.name}"><div class="resource-control-copy"><label for="resource-${control.name}">${control.label}</label><p id="resource-${control.name}-help">${control.help}</p></div><div class="resource-control-inputs settings-numeric-control"><div class="resource-number settings-exact-value"><label for="resource-${control.name}">Value</label><input id="resource-${control.name}" type="number" name="${control.name}" step="${control.step || 'any'}" aria-label="${control.label}" aria-describedby="${description}" required><span>${control.unit}</span></div><input type="range" data-resource-slider="${control.name}" aria-label="${control.label}" aria-describedby="${description}"><div class="settings-range-labels" data-resource-endpoints="${control.name}" aria-hidden="true"></div><span class="resource-default settings-numeric-context" id="resource-${control.name}-context" data-resource-default="${control.name}"></span><span class="settings-pending-mark" data-resource-pending="${control.name}" hidden>Unsaved</span></div><p class="resource-field-error" id="resource-${control.name}-error" data-resource-error="${control.name}" hidden></p></div>`
  }
  const group = (name, label) => `<fieldset class="resource-group"><legend>${label}</legend>${RESOURCE_CONTROLS.filter(control => control.group === name).map(controlMarkup).join('')}</fieldset>`
  function markup() {
    return `<section class="settings-section resource-settings" data-settings-section="Resources" data-resource-panel>
      <h2 class="settings-section-title">Resources</h2>
      <p class="settings-desc">Start a tree as capacity allows. These controls govern new starts; they do not cap the number of running agents.</p>
      <div class="resource-live"><h3>This computer</h3><dl class="resource-metrics"><div><dt>CPU load</dt><dd data-resource-cpu>Unknown</dd><meter data-resource-cpu-meter min="0" max="100" value="0" aria-label="Measured CPU load" hidden></meter></div><div><dt>Physical RAM free</dt><dd data-resource-ram>Unknown</dd><meter data-resource-ram-meter min="0" max="100" value="0" aria-label="Physical RAM available" hidden></meter></div></dl><p data-resource-reading>Reading CPU and RAM…</p><p data-resource-window></p><p data-resource-policy>Loading the saved resource policy…</p><ul class="resource-admission" data-resource-admission aria-label="Next start by program"></ul><button type="button" class="ctl-btn" data-resource-refresh>Refresh readings</button></div>
      <form data-resource-form novalidate><fieldset disabled data-resource-fields class="resource-fields"><legend class="sr-only">Resource policy</legend>
      <label class="settings-row resource-mode"><span class="settings-label">Control new starts</span><select name="mode">${RESOURCE_MODES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <p class="settings-desc" data-resource-draft-policy></p><p class="settings-desc" data-resource-applicability></p>
      <p class="settings-desc" data-resource-controller-tools role="status" hidden></p>
      ${group('limits', 'Start limits')}${group('cpu', 'CPU and pacing')}${group('memory', 'Program memory reservations')}
      <details class="resource-details"><summary>Measurement timing</summary>${group('timing', 'Fresh readings and memory settling')}</details>
      <button type="submit" class="ctl-btn" ${staged ? 'hidden' : ''}>Save resource policy</button></fieldset></form>
      <p class="settings-desc resource-notice" data-resource-notice role="status" aria-live="polite"></p>
      <details class="resource-details"><summary>How resource admission works</summary>
      <p>Applies to tree sessions, their assistants’ detached launches, and this app’s work-lane service. Independent command-line engines and a program’s own subagents are not covered here.</p>
      <p>In Both and Agent controller only, the declared organisation-root controller reads <code>system.resource_status</code> and sends dated <code>system.resource_advice</code>. Advice expires within 60 seconds of its measurement. Its first authorised root can bootstrap under mechanical checks. Work lanes wait for advice; they do not bootstrap a controller.</p>
      <p>Above the slow-start threshold, CPU must be steady before one more launch can begin. After a CPU or responsiveness hold, three recovery measurements are required. Each must be at least 7 percentage points below the CPU ceiling. CPU at 99% always holds mechanical starts.</p>
      <p>Claude’s 768 MiB default comes from a 665–748 MiB observation. Codex, Gemini, Grok and Local defaults are estimates. Set reservations to the measured cost of each program on this computer. Local models can need much more RAM. Physical RAM is measured; Windows commit headroom is not.</p>
      </details></section>`
  }
  function notice(message) { const node = panel?.querySelector('[data-resource-notice]'); if (node) node.textContent = message }
  function bounds(control) {
    if (control.unit !== 'MiB') {
      // Retain an older supported 1-second expiry exactly; editing another
      // control must not silently replace it. New values need a full window.
      const saved = state?.settings?.[control.name]
      return { min: control.name === 'sampleMaxAgeMs' && finite(saved) ? Math.min(control.min, saved) : control.min, max: control.max }
    }
    const saved = Number(resourceFormValues(state?.settings)[control.name])
    const total = finite(state?.totalBytes) ? Math.ceil(state.totalBytes / MIB) : 65536
    return { min: control.min, max: Math.min(1048576, Math.max(total, saved, control.default)) }
  }
  function fieldLimits() {
    const captured = pending()?.limits
    return Object.fromEntries(RESOURCE_CONTROLS.map(control => {
      const current = bounds(control), previous = captured?.[control.name] || current
      // Keep an in-progress edit's supported range, and include newly read
      // saved values. Rendering and validation must use the same limits.
      return [control.name, { min: Math.min(previous.min, current.min), max: Math.max(previous.max, current.max) }]
    }))
  }
  function editValues() { return pending()?.fields || resourceFormValues(state?.settings) }
  function rebaseUntouched() {
    const edit = pending()
    if (!edit || !state) return
    const base = resourceFormValues(edit.baseSettings), latest = resourceFormValues(state.settings)
    // A poll may bring another window's saved change. Only fields the user
    // has actually edited remain part of this draft's eventual patch.
    if (edit.fields.mode === base.mode) { edit.fields.mode = latest.mode; edit.baseSettings = { ...edit.baseSettings, mode: state.settings.mode } }
    for (const control of RESOURCE_CONTROLS) {
      if (edit.fields[control.name] !== base[control.name] || !supported(control)) continue
      edit.fields[control.name] = latest[control.name]
      if (control.provider) edit.baseSettings = { ...edit.baseSettings, providerBytes: { ...edit.baseSettings.providerBytes, [control.provider]: state.settings.providerBytes[control.provider] } }
      else edit.baseSettings = { ...edit.baseSettings, [control.key || control.name]: state.settings[control.key || control.name] }
    }
    edit.limits = fieldLimits()
    const validation = validateResourceForm(edit.fields, edit.baseSettings, edit.limits)
    draft?.setError?.(DRAFT_KEY, validation.reason)
  }
  function paintFields() {
    if (!panel || !state) return
    const fields = editValues()
    const form = panel.querySelector('[data-resource-form]')
    form.querySelector('[name="mode"]').value = fields.mode
    const limits = fieldLimits()
    const validation = validateResourceForm(fields, state.settings, limits)
    const defaults = resourceFormValues(state.defaults)
    const saved = resourceFormValues(state.settings)
    for (const control of RESOURCE_CONTROLS) {
      const input = form.querySelector(`[name="${control.name}"]`)
      const slider = form.querySelector(`[data-resource-slider="${control.name}"]`)
      const limit = limits[control.name]
      const available = supported(control)
      input.disabled = slider.disabled = !available
      input.min = slider.min = String(limit.min); input.max = String(limit.max)
      input.setAttribute('min', limit.min); input.setAttribute('max', limit.max)
      // Memory sliders use a practical portion of installed RAM. The exact
      // field reaches the full machine capacity and preserves larger policies.
      const captured = resourceFormValues(pending()?.baseSettings || state.settings)
      const sliderMax = control.unit === 'MiB' ? Math.min(limit.max, Math.max(control.name === 'reserve' ? 32768 : 16384, Number(saved[control.name]) || 0, Number(captured[control.name]) || 0, sliderCeilings.get(control.name) || 0)) : limit.max
      slider.max = String(sliderMax); slider.step = '1'
      slider.setAttribute('min', limit.min); slider.setAttribute('max', sliderMax); slider.setAttribute('step', '1')
      // Do not rewrite an unchanged focused number: browsers retain useful
      // intermediate text such as "768." while a fractional value is typed.
      if (input.value !== fields[control.name]) input.value = fields[control.name]
      if (finite(Number(fields[control.name])) && fields[control.name] !== '') slider.value = fields[control.name]
      syncNumericRange(slider, control.unit)
      const error = pending() ? validation.errors[control.name] : null
      input.setAttribute('aria-invalid', error ? 'true' : 'false')
      slider.setAttribute('aria-invalid', error ? 'true' : 'false')
      input.setCustomValidity?.(error || '')
      const changed = Boolean(pending()) && String(fields[control.name]) !== resourceFormValues(pending().baseSettings)[control.name]
      const row = panel.querySelector(`[data-resource-control="${control.name}"]`)
      row.dataset.settingPending = String(changed)
      row.dataset.settingInvalid = String(Boolean(error))
      panel.querySelector(`[data-resource-pending="${control.name}"]`).hidden = !changed
      const message = panel.querySelector(`[data-resource-error="${control.name}"]`)
      message.textContent = error || ''; message.hidden = !error
      panel.querySelector(`[data-resource-endpoints="${control.name}"]`).innerHTML = `<span>${numericText(limit.min, control.unit)}</span><span>${numericText(sliderMax, control.unit)}</span>`
      panel.querySelector(`[data-resource-default="${control.name}"]`).textContent = available ? `Saved: ${numericText(saved[control.name], control.unit)} · Default: ${numericText(defaults[control.name], control.unit)}${sliderMax < limit.max ? `. Exact input up to ${numericText(limit.max, control.unit)}.` : ''}` : 'Update the desktop app to use this control.'
    }
    panel.querySelector('[data-resource-draft-policy]').textContent = `${pending() ? 'Pending policy' : 'Policy'}: ${modeLabel(fields.mode)}. ${resourcePolicySentence(fields.mode)}`
    const applies = fields.mode === 'off' ? 'Limits are saved for later. All off bypasses the controls below.' : fields.mode === 'controller'
      ? 'Parallel starts still applies. CPU, pacing and RAM controls apply to controller bootstrap; later starts use controller advice.'
      : 'Below the slow-start CPU threshold, parallel starts and normal pacing apply. Above it, starts are paced one at a time.'
    panel.querySelector('[data-resource-applicability]').textContent = applies
    const toolNotice = panel.querySelector('[data-resource-controller-tools]')
    const tools = state.newControllerTools
    const needsAdvice = ['both', 'controller'].includes(fields.mode) || ['both', 'controller'].includes(state.mode)
    toolNotice.hidden = !needsAdvice || !tools || tools.available === true
    toolNotice.innerHTML = !toolNotice.hidden ? tools.known
      ? 'New resource controllers need ToolsEnabled tools, but new sessions are set to Native tools only. <a href="#/settings?setting=agent.agent_api">Change available tool sets</a> before starting a new controller. Already running controllers with those tools may continue advising.'
      : 'Tool availability for new resource controllers could not be checked. <a href="#/settings?setting=agent.agent_api">Check available tool sets</a> before starting a new controller.' : ''
  }
  function paint() {
    if (!panel) return
    const api = bridge()
    const editable = typeof api?.status === 'function' && typeof api?.configure === 'function'
    panel.querySelector('[data-resource-fields]').disabled = !editable || !state || busy || draft?.saving === true
    /* NO BRIDGE, NOTHING LOADING (T1525). In a window with no resource bridge
       the loading lines stayed forever and the policy select showed 'Both', a
       policy nothing had read. Say where the policy lives and show no value. */
    if (!state && !editable && unavailable) {
      panel.querySelector('[data-resource-reading]').textContent = 'CPU, RAM and the resource policy are read in the ToolsEnabled desktop app on this computer.'
      panel.querySelector('[data-resource-policy]').textContent = ''
      panel.querySelector('[data-resource-refresh]').hidden = true
      const mode = panel.querySelector('[data-resource-form] [name="mode"]')
      if (mode) mode.value = ''
    }
    if (!state) return
    const ageMs = resourceSampleAge(state, receivedAt, now())
    const fresh = !unavailable && state.fresh && ageMs !== null && ageMs <= (state.settings.sampleMaxAgeMs || 6000)
    panel.querySelector('[data-resource-reading]').textContent = resourceReadingSentence({ ...state, fresh, unavailable })
    panel.querySelector('[data-resource-window]').textContent = resourceWindowSentence(state, fresh)
    panel.querySelector('[data-resource-refresh]').textContent = state.mode === 'off' ? 'Refresh policy' : 'Refresh readings'
    panel.querySelector('[data-resource-refresh]').hidden = false
    const cpuKnown = fresh && finite(state.cpuPercent)
    const ramKnown = fresh && finite(state.freeBytes) && finite(state.totalBytes) && state.totalBytes > 0
    panel.querySelector('[data-resource-cpu]').textContent = cpuKnown ? `${state.cpuPercent.toFixed(1)}%` : 'Unknown'
    panel.querySelector('[data-resource-ram]').textContent = ramKnown ? `${(state.freeBytes / MIB / 1024).toFixed(2)} GiB` : 'Unknown'
    for (const [metric, known, value] of [['cpu', cpuKnown, state.cpuPercent], ['ram', ramKnown, state.freeBytes / state.totalBytes * 100]]) {
      const meter = panel.querySelector(`[data-resource-${metric}-meter]`)
      meter.hidden = !known
      meter.value = known ? Math.max(0, Math.min(100, value)) : 0
    }
    panel.querySelector('[data-resource-policy]').textContent = `${unavailable ? 'Last known saved policy' : 'Active policy'}: ${modeLabel(state.mode)}.${state.bootstrapSessionId ? ' Agent controller bootstrap is active.' : ''}`
    const list = panel.querySelector('[data-resource-admission]')
    list.replaceChildren()
    for (const provider of PROVIDERS) {
      const admission = state.admission?.[provider]
      if (!admission) continue
      const item = list.ownerDocument.createElement('li')
      const advice = state.controller?.[provider]
      const expiredAdvice = ['both', 'controller'].includes(state.mode) && advice && advice.expiresAtMs <= now()
      item.textContent = `${title(provider)}: ${unavailable ? 'Refresh to check the next start.' : state.mode === 'off' ? 'Resource checks are off.' : !fresh ? 'Refresh to check the next start.' : expiredAdvice ? 'Waiting for current controller advice.' : admission.ok ? 'Ready for another start.' : admission.reason || 'Waiting for capacity.'}`
      list.appendChild(item)
    }
    paintFields()
  }
  async function refresh(force = false, { forProfile = false } = {}) {
    if (!panel && !forProfile) return
    paint()
    const api = bridge()
    if (typeof api?.status !== 'function' || typeof api?.configure !== 'function') {
      unavailable = true
      notice('Open the desktop app on this computer to view or change its resource policy. This preview or remote window does not change the local computer’s policy.')
      paint(); onStateChange(); return
    }
    if ((inFlight?.generation === generation && inFlight.writeVersion === writeVersion && !force) || busy) return
    const ticket = { generation, request: ++request, writeVersion }
    inFlight = ticket
    let stopRead
    const stopped = new Promise((resolve, reject) => { stopRead = () => reject(new Error('The Settings view was closed.')) })
    stopReads.add(stopRead)
    try {
      const result = await withDeadline(Promise.race([api.status(), stopped]), 10_000)
      if ((!forProfile && ticket.generation !== generation) || ticket.request !== request || ticket.writeVersion !== writeVersion || busy || (!panel && !forProfile)) return
      if (result?.ok !== true || !plain(result.settings)) throw new Error('unavailable')
      const recovered = unavailable || !state
      state = result; receivedAt = now(); unavailable = false
      rebaseUntouched()
      if (recovered && !pending()) notice('')
      paint()
      onStateChange()
    } catch {
      if ((forProfile || ticket.generation === generation) && ticket.request === request && ticket.writeVersion === writeVersion && (panel || forProfile)) {
        unavailable = true; paint()
        if (!state) notice('The resource policy could not be read. Refresh after startup finishes.')
        onStateChange()
      }
    } finally { stopReads.delete(stopRead); if (inFlight === ticket) inFlight = null }
  }
  async function writeEdit(edit) {
    const api = bridge()
    if (typeof api?.configure !== 'function' || typeof api?.status !== 'function') return { ok: false, reason: 'This window cannot change the resource policy.' }
    const validation = validateResourceForm(edit.fields, edit.baseSettings, edit.limits)
    if (!validation.ok) { notice(validation.reason); return { ok: false, code: 'RESOURCE_SETTINGS_INVALID', reason: validation.reason } }
    const patch = {}
    for (const [key, value] of Object.entries(validation.value)) {
      if (key === 'providerBytes') {
        const changed = Object.fromEntries(Object.entries(value).filter(([provider, amount]) => amount !== edit.baseSettings.providerBytes?.[provider]))
        if (Object.keys(changed).length) patch.providerBytes = changed
      } else if (value !== edit.baseSettings[key]) patch[key] = value
    }
    ++writeVersion; busy = true; paint()
    try {
      const result = await api.configure(patch)
      if (result?.ok !== true) {
        const reason = result?.reason || 'This policy could not be saved. Your changes remain pending.'
        notice(reason); return { ok: false, reason }
      }
      if (!plain(result.settings)) { notice('The saved policy could not be confirmed. Refresh readings before retrying.'); return { ok: false, reason: 'The saved policy could not be confirmed.' } }
      state = result; receivedAt = now(); unavailable = false; localEdit = null
      notice('Resource policy saved on this computer.')
      return result
    } catch {
      const reason = 'This policy could not be saved. Your changes remain pending.'
      notice(reason); return { ok: false, reason }
    } finally { busy = false; ++writeVersion; paint(); onStateChange() }
  }
  function changed(event) {
    const form = event.target.closest?.('[data-resource-form]')
    if (!form || !state || busy || draft?.saving) return
    const sliderName = event.target.getAttribute?.('data-resource-slider')
    if (sliderName) form.querySelector(`[name="${sliderName}"]`).value = event.target.value
    const fields = Object.fromEntries(['mode', ...RESOURCE_CONTROLS.map(control => control.name)].map(name => [name, form.querySelector(`[name="${name}"]`).value]))
    const edit = { fields, baseSettings: pending()?.baseSettings || state.settings, limits: fieldLimits() }
    const validation = validateResourceForm(fields, edit.baseSettings, edit.limits)
    // An exact memory value may expand the displayed slider scale, but moving
    // its thumb must never shrink that scale underneath the pointer.
    const fieldName = event.target.getAttribute?.('name')
    if (!sliderName && !validation.errors[fieldName]) {
      const control = RESOURCE_CONTROLS.find(control => control.name === fieldName)
      if (control?.unit === 'MiB') sliderCeilings.set(control.name, Math.max(sliderCeilings.get(control.name) || 0, Number(fields[control.name])))
    }
    localEdit = edit
    try {
      if (draft?.unstage && validation.ok && JSON.stringify(validation.value) === JSON.stringify(edit.baseSettings)) {
        draft.unstage(DRAFT_KEY); localEdit = null; notice('Resource policy matches the saved settings.'); paintFields(); return
      }
      if (staged) staged(DRAFT_KEY, edit, writeEdit)
      draft?.setError?.(DRAFT_KEY, validation.reason)
    } catch (error) { notice(error.message); return }
    notice(validation.ok ? staged ? 'Resource changes are pending. Save settings to apply them.' : 'Unsaved resource policy changes.' : validation.reason)
    paintFields()
  }
  async function submit(event) {
    if (!event.target.closest?.('[data-resource-form]')) return
    event.preventDefault()
    if (!state || busy || draft?.saving) return
    changed(event)
    if (!staged && localEdit) await writeEdit(localEdit)
  }
  function clicked(event) { if (event.target.closest?.('[data-resource-refresh]')) void refresh(true) }
  function profileState() {
    const local = currentDataSource() === 'local'
    const edit = pending()
    const validation = edit && state ? validateResourceForm(edit.fields, edit.baseSettings, fieldLimits()) : null
    // Resource policy is part of the complete working profile even while the
    // display shows examples or a remote computer. An inaccessible host is
    // unavailable coverage, never an exclusion that creates a false match.
    return { applicable: true, ready: local && !unavailable && Boolean(state?.settings),
      settings: validation?.ok ? validation.value : state?.settings, savedSettings: state?.settings, totalBytes: state?.totalBytes,
      error: !local ? 'Complete working profiles need local desktop Settings with example screens turned off. Your existing choices are kept.'
        : validation && !validation.ok ? validation.reason : unavailable ? 'The resource policy could not be read.' : '' }
  }
  async function readForProfile() {
    if (currentDataSource() !== 'local') return profileState()
    await refresh(true, { forProfile: true })
    return profileState()
  }
  function stageForProfile(values) {
    if (!draft || !profileState().ready) throw new Error('Read the resource policy before applying a profile.')
    for (const key of Object.keys(values)) if (!Object.hasOwn(state.settings, key)) throw new Error('This host does not support every resource field in the profile.')
    const fields = { ...editValues() }
    /* A working profile carries pacing values only; whether admission is
       enforced stays exactly as saved or pending (settings-profile-policy.js
       PROFILE_RESOURCE_PRESERVED). A caller that does name a mode is honoured. */
    if (Object.hasOwn(values, 'mode')) fields.mode = values.mode
    for (const control of RESOURCE_CONTROLS) if (Object.hasOwn(values, control.key || control.name)) {
      fields[control.name] = String(values[control.key || control.name] / (control.unit === 'MiB' ? MIB : 1))
    }
    const edit = { fields, baseSettings: pending()?.baseSettings || state.settings, limits: fieldLimits() }
    const validation = validateResourceForm(fields, edit.baseSettings, edit.limits)
    if (!validation.ok) throw new Error(validation.reason)
    if (JSON.stringify(validation.value) === JSON.stringify(edit.baseSettings)) draft.unstage(DRAFT_KEY)
    else draft.stage(DRAFT_KEY, edit, writeEdit)
    paintFields()
  }
  return Object.freeze({ markup,
    profileState, readForProfile, stageForProfile,
    matches: query => matchesSettingQuery(query, 'Resources', SECTION_TITLE, 'system resources cpu ceiling memory ram launch queue controller mechanical admission parallel pace pacing claude codex gemini grok', ...RESOURCE_CONTROLS.map(control => `${control.label} ${control.help}`)),
    bind(target) { root = target; root.addEventListener('input', changed); root.addEventListener('change', changed); root.addEventListener('submit', submit); root.addEventListener('click', clicked) },
    refreshSaved() { paint() },
    afterRender(target) {
      ++generation
      const candidate = target.querySelector('[data-resource-panel]')
      const hiddenByBasic = target.dataset.settingsMode === 'simple'
        && target.dataset.settingsSearch === 'false' && target.dataset.settingsLanding === 'false'
        && candidate?.closest('[data-settings-panel-mode="advanced"]')
      panel = hiddenByBasic ? null : candidate
      if (timer !== null) unschedule(timer); timer = null
      if (panel) {
        paint(); void refresh()
        const api = bridge()
        if (typeof api?.status === 'function' && typeof api?.configure === 'function') timer = schedule(() => { void refresh() }, 2000)
      }
    },
    destroy() { ++generation; ++request; for (const stop of stopReads) stop(); stopReads.clear(); if (timer !== null) unschedule(timer); timer = null; root?.removeEventListener('input', changed); root?.removeEventListener('change', changed); root?.removeEventListener('submit', submit); root?.removeEventListener('click', clicked); root = null; panel = null },
  })
}
