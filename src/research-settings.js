// Product settings are read and validated by the installed engine.
// This controller arranges them, holds drafts, and reports the actual save result.
import { controlState } from './components.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
import {
  RESEARCH_SECTION, LOCAL_MODELS_SECTION, PRODUCT_SECTIONS, PRODUCT_SECTION_NOTES,
  productSettingPresentation, sectionOfRow, matchesSettingQuery, compareProductSettings,
} from './product-settings-layout.js'
import { settingsModePanel } from './settings-mode.js'
import { numericText, syncNumericRange } from './settings-numeric.js'
import { ENTERPRISE_SECTION, ENTERPRISE_CONTROLS, ENTERPRISE_SETTING_IDS, enterpriseIntroMarkup, enterpriseRelatedMarkup } from './enterprise-settings.js'
export { RESEARCH_SECTION, LOCAL_MODELS_SECTION, sectionOfRow } from './product-settings-layout.js'

export const PRODUCT_SETTING_IDS = Object.freeze([
  "research.pipeline",
  "research.runner_agent",
  "research.runner_process",
  "research.runner_http",
  "agent.tool_summary",
  "agent.capability_recall",
  "agent.agent_api",
  "agent.product_source_writes",
  "agent.tool_approvals",
  "agent.close_asks",
  "agent.persistent_continuation",
  "agent.blocked_question",
  "agent.subagent_route",
  "agent.task_difficulty_enabled",
  "agent.task_only_delegation",
  "agent.comms_enabled",
  "agent.message_delivery",
  "agent.message_queue_seconds",
  "rules.require_read_each_turn",
  "rules.filing_from",
  "rules.ask_when_unsure",
  "rules.agent_filed_needs_approval",
  "app.outside_control",
  "tools.throughput",
  "tools.audit_batch_window_ms",
  "tools.audit_batch_size",
  "tools.credential_check_interval_seconds",
  "tools.policy_enforcement",
  "purchases.require_owner_approval",
  "fleet.concurrent_shared_writes",
  "capability.elevation_duration",
  "capability.elevation_survives_restart",
  "agent.message_screening",
  "audit.enabled",
  "ledger.verify_history",
  "diagnostics.retention",
  "audit.activity",
  "audit.retention",
  "fleet.tree_width",
  "fleet.tree_depth",
  "fleet.max_declared_agents",
  "model.provider",
  "model.endpoint",
  "model.name",
  "model.local_agent_name",
  "model.tool_name",
  "model.local_gpu_policy",
  "model.local_context_tokens",
  "model.local_thinking",
  "model.local_keep_alive_minutes"
])

export const RESEARCH_SETTING_COUNT = PRODUCT_SETTING_IDS.length

export const RESEARCH_MASTER_ID = 'research.pipeline'

const MASTER_ID = RESEARCH_MASTER_ID

export const RESEARCH_FENCED_IDS = Object.freeze(
  PRODUCT_SETTING_IDS.filter(id => id.startsWith('research.') && id !== RESEARCH_MASTER_ID),
)

const underResearchGate = id => String(id).startsWith('research.')

const PROVENANCE_RULED_IDS = Object.freeze(['rules.filing_from', 'rules.ask_when_unsure', 'rules.agent_filed_needs_approval', 'app.outside_control', 'agent.product_source_writes'])
export const OUTSIDE_CONTROL_ID = 'app.outside_control'
const refusesUnchosenValue = id => underResearchGate(id) || PROVENANCE_RULED_IDS.includes(String(id))

export const NESTED_UNDER = Object.freeze({
  'rules.ask_when_unsure': 'rules.filing_from',
  'rules.agent_filed_needs_approval': 'rules.filing_from',
  'tools.audit_batch_window_ms': 'tools.throughput',
  'tools.audit_batch_size': 'tools.throughput',
})
/* THE VALUE OF A CHOICE-SHAPED PARENT THAT OPENS ITS NESTED ROWS. A toggle
   parent opens on true; a seg parent opens on the one option that means the
   feature is on ("Who adds standing rules" only concerns agents in its third
   choice, so the two agent sub-settings are held under the other two). */
export const PARENT_OPEN_VALUE = Object.freeze({
  'tools.throughput': 'fast',
  'rules.filing_from': 'Agents too',
})
export const HELD_BY_PARENT = 'Turn on the switch above first.'
export const PARENT_HOLD_REASON = Object.freeze({
  'tools.throughput': 'Choose Fast tool-call processing to use activity batching. Strict saves each record separately.',
  'rules.filing_from': 'Choose Agents too above first. With the other two choices no agent files, suggests or asks about a rule.',
})

export const DRAWABLE_CONTROLS = new Set(['toggle', 'seg', 'select', 'pick', 'text', 'number', 'range', 'duration', 'readback'])
const MODEL_CHOOSER_IDS = new Set(['model.name', 'model.local_agent_name', 'model.tool_name'])

export const NOTHING_DISCOVERED_YET = 'Nothing has been discovered to choose from yet.'

export const COULD_NOT_CHECK_ENDPOINT = 'This copy could not check what that address is serving. That does not mean nothing is there; try again in a moment.'
export const ENDPOINT_DID_NOT_ANSWER = 'Nothing answered at the address above, so there is nothing to choose from yet.'
export const ENDPOINT_NOT_CONFIGURED = 'No AI service address is configured. Add its address above when you want to use these model settings.'
export const ENDPOINT_NOT_PROBED = 'This address was not checked by local discovery. Enter the model name supplied by your AI service.'

export const UNUSABLE_ENDPOINT = 'Enter a full AI service address beginning with http:// or https://.'

export function productValueError(row, value) {
  if (['number', 'range', 'duration'].includes(row.control)) {
    if (!Number.isSafeInteger(value)) return 'Enter a whole number.'
    if (Number.isFinite(row.min) && value < row.min) return `Enter ${row.min} or more.`
    if (Number.isFinite(row.max) && value > row.max) return `Enter ${row.max} or less.`
  }
  if (row.control === 'toggle' && typeof value !== 'boolean') return 'Choose on or off.'
  if (['seg', 'select'].includes(row.control) && !row.options?.includes(value)) return 'Choose one of the available options.'
  return ''
}

function choicesOf(row) {
  return row && Array.isArray(row.choices)
    ? row.choices.filter(choice => typeof choice === 'string' && choice.length > 0)
    : []
}

export function endpointAddress(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const host = endpointHost(url.hostname)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port, protocol: url.protocol }
}

function endpointHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' ? '127.0.0.1' : host
}

export function localModelsAnswer(read, endpointValue) {
  // An omitted endpoint row cannot invalidate choices supplied by the settings
  // reader. The shipped empty value is an intentional, unconfigured default.
  if (endpointValue === undefined) return { state: 'unchecked', choices: [] }
  if (typeof endpointValue === 'string' && !endpointValue.trim()) return { state: 'not-configured', choices: [] }
  const wanted = endpointAddress(endpointValue)
  if (!wanted) return { state: 'unusable', choices: [] }
  if (!read || read.ok !== true || !Array.isArray(read.runtimes)) return { state: 'unchecked', choices: [] }
  const match = read.runtimes.find(runtime => runtime
    && endpointHost(runtime.host) === wanted.host
    && (runtime.protocol || 'http:') === wanted.protocol
    && Number(runtime.port) === wanted.port)
  if (!match) return { state: 'not-probed', choices: [] }
  if (match.listening === false) return { state: 'no-answer', choices: [] }
  if (match.listening !== true) return { state: 'unchecked', choices: [] }
  const choices = Array.isArray(match.models)
    ? match.models.filter(model => typeof model === 'string' && model.length > 0)
    : []
  return { state: choices.length === 0 ? 'empty' : 'serving', choices }
}

const parentIdOf = id => NESTED_UNDER[String(id)] || null

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const viaRelay = () => currentDataSource() === 'relay'
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: viaRelay() })
const machine = () => viaRelay() ? 'the computer you are driving' : 'this computer'
const Machine = () => viaRelay() ? 'The computer you are driving' : 'This computer'
const machinePossessive = () => viaRelay() ? 'the driven computer’s' : 'this computer’s'

function titleOf(row) {
  return productSettingPresentation(row.id).title || row.label || row.id
}

function provenanceLine(row) {

  if (row.control === 'seg' || row.control === 'select') {
    const chosenSource = row.provenance && typeof row.provenance.source === 'string' ? row.provenance.source : 'default'
    if (chosenSource === 'user') return `You chose "${row.value}".`
    if (chosenSource === 'installer') return `This was set to "${row.value}" when the program was set up.`
    return `"${row.value}" is how this one ships. Nobody has changed it on ${machine()}, and leaving it alone is fine.`
  }
  if (row.value !== true) return ''
  const source = row.provenance && typeof row.provenance.source === 'string' ? row.provenance.source : 'default'
  if (source === 'user') return 'You turned this on.'
  if (source === 'installer') return 'This was turned on when the program was set up.'

  if (!refusesUnchosenValue(row.id)) return `On is how this one ships. Nobody has changed it on ${machine()}, and leaving it alone is fine.`
  return 'This reads as on, but nobody chose it, so the work is still held back. Turn it off and on again to choose it.'
}

export function createResearchSettings({
  shell = typeof window === 'undefined' ? null : window.mcSettings,
  onRender = () => {},

  readLocalRuntimes = typeof window === 'undefined' || !window.mcProviders
    ? null
    : (typeof window.mcProviders.detectLocal === 'function' ? window.mcProviders.detectLocal.bind(window.mcProviders) : null),
} = {}) {
  const writeUnavailable = () => viaRelay()
    ? 'The installed copy on the computer you are driving cannot change these switches. Update ToolsEnabled on that computer, then try again from here.'
    : 'This installed copy cannot change these switches. Update the app, then try again.'
  let hostRoot = null

  let state = null

  let localModels = null
  let loadStarted = false
  let loadGeneration = 0
  let modelGeneration = 0
  let destroyed = false
  let busy = null
  const said = new Map()
  const typed = new Map()
  const rendering = new Map()

  function rowFor(id) {
    return state?.rows?.find(row => row.id === id) || null
  }

  function heldByMaster(row) {
    if (!RESEARCH_FENCED_IDS.includes(row.id)) return false
    const master = rowFor(MASTER_ID)
    return Boolean(master && master.present && master.value !== true)
  }

  function heldByParent(row) {
    const parentId = parentIdOf(row.id)
    if (!parentId) return false
    const parent = rowFor(parentId)
    return !(parent && parent.present && parent.value === (Object.hasOwn(PARENT_OPEN_VALUE, parentId) ? PARENT_OPEN_VALUE[parentId] : true))
  }

  const parentHoldReason = row => PARENT_HOLD_REASON[parentIdOf(row.id)] || HELD_BY_PARENT

  function outsideControlLine(row) {
    const now = state && state.outsideControl && typeof state.outsideControl === 'object' ? state.outsideControl : null
    if (now && now.applied === true) {
      return `On since this start: a program on ${machine()} can drive this app through ${now.address || '127.0.0.1'}:${now.port}.`
    }
    if (now && now.why === 'command-line') {
      return `On for this run because the app was started with a port on its command line${now.port ? ` (${now.port})` : ''}, whatever this switch says.`
    }
    if (row.value !== true) return ''
    const chosen = provenanceLine(row)
    return chosen ? `${chosen} It applies from the next time the app starts.` : 'It applies from the next time the app starts.'
  }

  function statusFor(row) {
    if (row.applicable === false) return 'This control applies to the Windows credential vault. This computer checks its own vault directly.'
    if (row.control === 'readback') return row.readOnlyReason || 'This information is read-only.'
    const spoken = said.get(row.id)

    if (row.present && heldByParent(row)) return parentHoldReason(row)
    const held = row.present && heldByMaster(row)
      ? 'Held back: the first switch in this section is off, so nothing runs for a research project yet.'
      : ''
    if (spoken) return held ? `${spoken} ${held}` : spoken
    if (row.pending) return 'Unsaved change.'
    if (!row.present) return row.reason || ''
    if (typeof shell?.set !== 'function') return writeUnavailable()
    if (held) return held
    if (row.present && row.control && !DRAWABLE_CONTROLS.has(row.control)) {
      return `This copy cannot draw a ${String(row.control)} control yet, so this one can only be changed on the computer itself.`
    }

    if (row.present && row.control === 'pick' && choicesOf(row).length === 0) {

      if (MODEL_CHOOSER_IDS.has(row.id) && localModels) {
        if (localModels.state === 'unchecked') return COULD_NOT_CHECK_ENDPOINT
        if (localModels.state === 'unusable') return UNUSABLE_ENDPOINT
        if (localModels.state === 'no-answer') return ENDPOINT_DID_NOT_ANSWER
        if (localModels.state === 'not-configured') return ENDPOINT_NOT_CONFIGURED
        if (localModels.state === 'not-probed') return ENDPOINT_NOT_PROBED
      }
      return NOTHING_DISCOVERED_YET
    }
    if (row.enforcement && row.enforcement.declared === false) {
      return 'Nothing in this copy of the program reads this yet, so moving it changes nothing.'
    }
    if (row.id === OUTSIDE_CONTROL_ID) return outsideControlLine(row)
    if (row.id === 'agent.agent_api' && row.value === 'Only') return 'Applies to new assistant sessions. Native tools are restricted; Codex runs inside a read-only sandbox.'
    if (row.id === 'agent.agent_api' && row.value === 'Disabled') return 'Applies to new assistant sessions. Controller roles that require ToolsEnabled tools cannot start in this mode.'
    if (refusesUnchosenValue(row.id) && row.value === true && !['user', 'installer'].includes(row.provenance?.source)) return provenanceLine(row)
    if (row.applies === 'next-session') return 'Applies to new assistant sessions.'
    if (row.applies === 'restart') return 'Applies when ToolsEnabled next starts.'
    return ''
  }

  function toggleMarkup(row) {
    if (!row.present) return ''
    const labelId = `research-setting-label-${esc(row.id)}`

    const parentHeld = heldByParent(row)
    const masterHeld = heldByMaster(row)
    const state = controlState({
      enabled: busy !== row.id && !parentHeld && !masterHeld && typeof shell?.set === 'function',
      why: busy === row.id
        ? 'This switch is being saved.'
        : (parentHeld ? parentHoldReason(row) : (masterHeld ? statusFor(row) : writeUnavailable())),
    })
    return `<label class="toggle settings-toggle">
      <input type="checkbox" data-research-setting="${esc(row.id)}" aria-labelledby="${labelId}" ${row.value === true ? 'checked' : ''}${state.disabled ? ` title="${esc(state.why)}" disabled` : ''}/><i></i>
    </label>`
  }

  function segMarkup(row) {
    if (!row.present || !Array.isArray(row.options) || row.options.length === 0) return ''
    const labelId = `research-setting-label-${esc(row.id)}`
    const state = controlState({
      enabled: busy !== row.id && !heldByParent(row) && !heldByMaster(row) && typeof shell?.set === 'function',
      why: busy === row.id
        ? 'This choice is being saved.'
        : (heldByParent(row) ? parentHoldReason(row) : (heldByMaster(row) ? statusFor(row) : writeUnavailable())),
    })
    const buttons = row.options.map(option => {
      const chosen = option === row.value
      return `<button type="button" class="${chosen ? 'on' : ''}" data-research-choice="${esc(row.id)}" data-research-value="${esc(option)}" aria-pressed="${chosen ? 'true' : 'false'}"${state.disabled ? ` title="${esc(state.why)}" disabled` : ''}>${esc(option)}</button>`
    }).join('')
    return `<div class="seg settings-seg" role="group" aria-labelledby="${labelId}">${buttons}</div>`
  }

  function pickMarkup(row) {
    const choices = choicesOf(row)
    const inherited = ['model.local_agent_name', 'model.tool_name'].includes(row.id)
    if (row.present && MODEL_CHOOSER_IDS.has(row.id) && choices.length === 0) {
      return textMarkup(row).replace('data-research-text=', `${inherited ? 'placeholder="Use shared default" ' : 'placeholder="Model name" '}data-research-text=`)
    }
    if (!row.present || (choices.length === 0 && !inherited)) return ''
    const labelId = `research-setting-label-${esc(row.id)}`
    const state = controlState({
      enabled: busy !== row.id && !heldByParent(row) && !heldByMaster(row) && typeof shell?.set === 'function',
      why: busy === row.id
        ? 'This choice is being saved.'
        : (heldByParent(row) ? parentHoldReason(row) : (heldByMaster(row) ? statusFor(row) : writeUnavailable())),
    })
    const buttons = (inherited ? ['', ...choices] : choices).map(choice => {
      const chosen = choice === row.value
      return `<button type="button" class="${chosen ? 'on' : ''}" data-research-choice="${esc(row.id)}" data-research-value="${esc(choice)}" aria-pressed="${chosen ? 'true' : 'false'}"${state.disabled ? ` title="${esc(state.why)}" disabled` : ''}>${esc(choice || 'Use shared default')}</button>`
    }).join('')
    return `<div class="seg settings-seg settings-pick" role="group" aria-labelledby="${labelId}">${buttons}</div>`
  }

  function textMarkup(row) {
    if (!row.present) return ''
    const labelId = `research-setting-label-${esc(row.id)}`
    const state = controlState({
      enabled: busy !== row.id && !heldByParent(row) && !heldByMaster(row) && typeof shell?.set === 'function',
      why: busy === row.id
        ? 'This is being saved.'
        : (heldByParent(row) ? parentHoldReason(row) : (heldByMaster(row) ? statusFor(row) : writeUnavailable())),
    })
    return `<input type="text" class="settings-text" spellcheck="false" autocomplete="off" data-research-text="${esc(row.id)}" aria-labelledby="${labelId}" value="${esc(typed.get(row.id) ?? row.value ?? '')}"${state.disabled ? ` title="${esc(state.why)}" disabled` : ''}/>`
  }

  function numberMarkup(row) {
    const bounds = ['min', 'max'].filter(key => Number.isFinite(row[key])).map(key => ` ${key}="${row[key]}"`).join('')
    const value = typed.get(row.id) ?? row.value
    const error = typed.has(row.id) ? (String(value).trim() ? productValueError(row, Number(value)) : 'Enter a whole number.') : ''
    const describedBy = `research-setting-status-${esc(row.id)} research-number-context-${esc(row.id)}`
    const exact = textMarkup(row).replace('type="text"', `type="number" step="1"${bounds} id="research-number-${esc(row.id)}" aria-invalid="${Boolean(error)}" aria-describedby="${describedBy}"`).replace('data-research-text=', 'data-research-number=')
    const hasRange = Number.isFinite(row.min) && Number.isFinite(row.max) && row.max > row.min && row.max - row.min <= 1000000
    return `<div class="settings-numeric-control">
      <div class="settings-exact-value"><label for="research-number-${esc(row.id)}">Value</label>${exact}<span>${esc(row.unit || '')}</span></div>
      ${hasRange ? `<input type="range" min="${row.min}" max="${row.max}" step="${row.step || 1}" value="${esc(error ? row.value : value)}" data-research-range="${esc(row.id)}" aria-labelledby="research-setting-label-${esc(row.id)}" aria-describedby="${describedBy}" aria-invalid="${Boolean(error)}" aria-valuetext="${esc(numericText(error ? row.value : value, row.unit))}"${busy || heldByParent(row) || heldByMaster(row) || typeof shell?.set !== 'function' ? ' disabled' : ''}>
      <div class="settings-range-labels" aria-hidden="true"><span>${esc(row.minLabel ?? numericText(row.min, row.unit))}</span><span>${esc(row.maxLabel ?? numericText(row.max, row.unit))}</span></div>` : ''}
      <div class="settings-numeric-context" id="research-number-context-${esc(row.id)}">${esc(numericContext(row))}</div>
      <div class="settings-state" id="research-setting-status-${esc(row.id)}" role="status" data-research-setting-status="${esc(row.id)}">${esc(error || statusFor(row))}</div>
    </div>`
  }

  function numericContext(row) {
    const saved = Object.hasOwn(row, 'savedValue') ? row.savedValue : row.value
    return `Saved: ${numericText(saved, row.unit)}${row.default == null ? '' : ` · Default: ${numericText(row.default, row.unit)}`}`
  }

  function paintNumeric(row, error = '') {
    for (const article of hostRoot?.querySelectorAll(`[data-research-setting-row="${row.id}"]`) || []) {
      article.dataset.settingPending = String(Boolean(row.pending))
      article.dataset.settingInvalid = String(Boolean(error))
      const mark = article.querySelector('[data-product-pending]')
      if (mark) mark.hidden = !row.pending
      const warning = article.querySelector('[data-setting-change-warning]')
      if (warning) warning.hidden = !row.pending
      const status = article.querySelector('[data-research-setting-status]')
      if (status) status.textContent = error || statusFor(row)
      const number = article.querySelector('[data-research-number]')
      const range = article.querySelector('[data-research-range]')
      for (const input of [number, range].filter(Boolean)) input.setAttribute('aria-invalid', String(Boolean(error)))
      number?.setCustomValidity?.(error)
      if (range) syncNumericRange(range, row.unit)
    }
  }

  function controlMarkup(row) {
    if (!row.present) return ''
    if (row.applicable === false) return '<span class="settings-platform-note">Windows</span>'
    if (row.enforcement?.declared === false) return '<span class="settings-platform-note">Not in this build</span>'
    if (row.control === 'seg' || row.control === 'select') return segMarkup(row)
    if (row.control === 'pick') return pickMarkup(row)
    if (row.control === 'text') return textMarkup(row)
    if (row.control === 'readback') return `<output>${esc(row.value ?? 'No current measurement is available.')}</output>`
    if (['number', 'range', 'duration'].includes(row.control)) return numberMarkup(row)
    if (row.control === 'toggle') return toggleMarkup(row)
    return ''
  }
  function listMarkup(kind, items) {
    if (!Array.isArray(items) || items.length === 0) return ''
    return `<div class="guided-group">
      <span class="guided-label">${esc(kind)}</span>
      <ul class="guided-list">${items.map(item => `<li>${esc(readerSentence(item))}</li>`).join('')}</ul>
    </div>`
  }

  function disclosureMarkup(row) {
    const declared = row.present && ((row.capabilities || []).length > 0 || (row.risks || []).length > 0)
    if (!declared) {
      return `<details class="guided-note is-undeclared" data-guided-for="${esc(row.id)}" data-guided-declared="false">
        <summary class="guided-summary">Details</summary>
        <div class="guided-body">
          <p class="settings-desc">${Machine()} has no register statement about this switch. This page will not invent one.</p>
        </div>
      </details>`
    }
    return `<details class="guided-note" data-guided-for="${esc(row.id)}" data-guided-declared="true">
      <summary class="guided-summary">Details</summary>
      <div class="guided-body">
        ${row.consequence ? `<p class="settings-desc">${esc(readerSentence(row.consequence))}</p>` : ''}
        ${listMarkup('What it lets happen', row.capabilities)}
        ${listMarkup('What it risks', row.risks)}
      </div>
    </details>`
  }

  function rowMarkup(row, enterprise = false) {
    const status = statusFor(row)
    const presentation = productSettingPresentation(row.id)
    const depth = Number.isInteger(row.depth) ? row.depth : 1
    const parentId = parentIdOf(row.id)
    const mode = presentation.mode || 'advanced'
    const numeric = ['number', 'range', 'duration'].includes(row.control) && row.present && row.applicable !== false && row.enforcement?.declared !== false
    const html = `<article class="settings-row${parentId ? ' is-nested' : ''}" data-setting-id="${esc(row.id)}" data-research-setting-row="${esc(row.id)}" data-setting-depth="${depth}" data-settings-min-mode="${mode}"${row.pending ? ' data-setting-pending="true"' : ''}${parentId ? ` data-nested-under="${esc(parentId)}"` : ''}${row.present && heldByParent(row) ? ' data-held-by-parent="true"' : ''}>
      <div class="settings-copy">
        <div class="settings-name" id="research-setting-label-${esc(row.id)}">${esc(titleOf(row))}${numeric ? '' : `<span class="settings-pending-mark" data-product-pending${row.pending ? '' : ' hidden'}>Unsaved</span>`}</div>
        <div class="settings-desc">${esc(readerSentence(presentation.summary || row.consequence || row.reason || ''))}</div>
        ${row.warningText ? `<p class="settings-desc" data-setting-change-warning role="status"${row.pending ? '' : ' hidden'}>${esc(row.warningText)}</p>` : ''}
        ${enterprise ? `<p class="settings-enterprise-scope">${esc(ENTERPRISE_CONTROLS[row.id]?.scope || '')}</p>` : ''}
        ${numeric ? '' : `<div class="settings-state" id="research-setting-status-${esc(row.id)}" role="status" data-research-setting-status="${esc(row.id)}">${esc(readerSentence(status || ''))}</div>`}
      </div>
      <div class="settings-control">${controlMarkup(row)}</div>
      <div class="settings-disclosure">${disclosureMarkup(row)}</div>
    </article>`
    return mode === 'expert' ? settingsModePanel(html, titleOf(row), 'expert') : html
  }

  function rowMatches(row, query) {
    const presentation = productSettingPresentation(row.id)
    return matchesSettingQuery(query, row.id, titleOf(row), row.label, presentation.summary,
      presentation.group, sectionOfRow(row.id), row.consequence, row.capabilities, row.risks)
  }

  function selectedRows(section, query = '') {
    if (section === ENTERPRISE_SECTION) return ENTERPRISE_SETTING_IDS.map(id => state?.rows?.find(row => row.id === id)
      || { id, present: false, reason: 'This desktop version did not supply this control. Update the app to use it.' }).filter(row => rowMatches(row, query))
    return (state?.rows || []).filter(row => (!section || sectionOfRow(row.id) === section) && rowMatches(row, query)).sort(compareProductSettings)
  }

  function bodyMarkup(section, query = '', embedded = false) {
    if (!shell) return `<p class="settings-section-note host-absent-body" data-research-settings-absent>${viaRelay()
      ? 'Connect to the computer running ToolsEnabled to view and change these settings.'
      : 'Open the ToolsEnabled desktop app to view and change these settings.'}</p>`
    if (state === null) return `<p class="settings-section-note host-absent-body">Reading settings on ${machine()}…</p>`
    if (state.available !== true) return `<p class="settings-section-note host-absent-body" data-research-settings-absent>${esc(readerSentence(state.reason || 'The settings could not be read. Try again.'))}</p><button type="button" class="ctl-btn" data-product-retry>Try again</button>`
    const rows = selectedRows(section, query)
    if (!rows.length) return ''
    const groups = new Map()
    for (const row of rows) {
      const group = (section === ENTERPRISE_SECTION ? ENTERPRISE_CONTROLS[row.id]?.group : productSettingPresentation(row.id).group) || 'Options'
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(row)
    }
    const content = [...groups].map(([label, items]) => {
      const simple = items.some(row => productSettingPresentation(row.id).mode === 'simple')
      const expert = items.every(row => productSettingPresentation(row.id).mode === 'expert')
      return `<div class="settings-subsection"${simple || expert ? '' : ' data-settings-min-mode="advanced"'}>
        <h3 class="settings-subsection-title">${esc(label)}</h3>${rowsMarkup(items, section === ENTERPRISE_SECTION)}
      </div>`
    }).join('')
    return `${embedded || query ? '' : `<p class="settings-category-description">${esc(PRODUCT_SECTION_NOTES[section] || '')}</p>`}${content}
      ${rows.some(row => (productSettingPresentation(row.id).mode || 'advanced') === 'advanced') ? '<p class="settings-simple-more">More controls are available in Advanced. <button type="button" class="ctl-btn" data-settings-show-mode="advanced">Show Advanced settings</button></p>' : ''}`
  }

  function rowsMarkup(rows, enterprise = false) {
    return rows.map(row => {
      const parentId = parentIdOf(row.id)
      if (!parentId) return rowMarkup(row, enterprise)
      return `<div class="settings-tier is-open" data-product-nest="${esc(parentId)}" data-nest-depth="${Number.isInteger(row.depth) ? row.depth : 2}" data-settings-min-mode="${productSettingPresentation(row.id).mode || 'advanced'}"><div class="settings-tier-inner">${rowMarkup(row, enterprise)}</div></div>`
    }).join('')
  }

  function markup({ searchResult = false, section = RESEARCH_SECTION, query = '', embedded = false } = {}) {
    rendering.set(section, { searchResult, section, query, embedded })
    const local = section === LOCAL_MODELS_SECTION
    const empty = embedded && state && !selectedRows(section, query).length
    return `<section class="settings-section settings-product-section" data-product-section="${esc(section)}" data-settings-section="${esc(section)}"${local ? ' data-local-models-settings' : ' data-research-settings'}${empty ? ' hidden' : ''}>
      ${searchResult ? `<div class="settings-prefix">${esc(section)}</div>` : ''}
      ${embedded ? '' : `<h2 class="settings-section-title">${esc(section)}</h2>`}
      ${section === ENTERPRISE_SECTION ? enterpriseIntroMarkup() : ''}
      <div class="settings-section-rows">${empty ? '' : bodyMarkup(section, query, embedded)}</div>
      ${section === ENTERPRISE_SECTION ? enterpriseRelatedMarkup() : ''}
    </section>`
  }

  function refresh({ loaded = false } = {}) {
    if (!hostRoot || destroyed) return
    const active = globalThis.document?.activeElement
    const focusedRow = active?.closest?.('[data-setting-id]')?.dataset.settingId
    const focusedAttribute = ['data-research-number', 'data-research-text', 'data-research-range', 'data-research-setting', 'data-research-choice'].find(name => active?.hasAttribute?.(name))
    const focusedValue = active?.dataset?.researchValue
    const selection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null
    for (const current of hostRoot.querySelectorAll?.('[data-product-section]') || []) {
      const section = current.dataset.productSection
      current.outerHTML = markup(rendering.get(section) || { section })
    }
    for (const range of hostRoot.querySelectorAll?.('[data-research-range]') || []) {
      syncNumericRange(range, rowFor(range.dataset.researchRange)?.unit)
    }
    if (focusedRow && focusedAttribute) {
      const selector = `[${focusedAttribute}="${focusedRow}"]`
      const controls = [...hostRoot.querySelectorAll(selector)]
      const target = focusedValue === undefined ? controls[0] : controls.find(node => node.dataset.researchValue === focusedValue)
      target?.focus?.({ preventScroll: true })
      if (selection && target?.type === 'text') target.setSelectionRange(...selection)
    }
    onRender({ loaded })
  }

  async function load({ force = false } = {}) {
    if (!shell || destroyed) return
    if (loadStarted && !force) return
    loadStarted = true
    const generation = ++loadGeneration
    let answer = null
    try { answer = await shell.read() } catch (error) { answer = null }
    if (generation !== loadGeneration || destroyed) return
    state = answer?.ok && Array.isArray(answer.rows) ? answer
      : { ok: true, available: false, reason: `Settings on ${machine()} could not be read. Try again.`, rows: [] }
    refresh({ loaded: true })
    if (answer && answer.ok && Array.isArray(answer.rows)) {
      const discovery = ++modelGeneration
      const endpoint = rowFor('model.endpoint')?.value
      let read = null
      if (typeof readLocalRuntimes === 'function') {
        try { read = await readLocalRuntimes() } catch { read = null }
      }
      if (discovery !== modelGeneration || destroyed || endpoint !== rowFor('model.endpoint')?.value) return
      localModels = localModelsAnswer(read, endpoint)

      for (const nameRow of state.rows.filter(row => row && MODEL_CHOOSER_IDS.has(row.id))) {
        if (localModels.state !== 'unchecked') nameRow.choices = localModels.choices
      }
    }
    refresh({ loaded: true })
  }

  async function setValue(id, next, { live = false } = {}) {
    if (!shell || busy || destroyed) return
    const row = rowFor(id)
    if (!row || !row.present) return
    if (row.applicable === false || row.enforcement?.declared === false || row.control === 'readback') return
    const error = productValueError(row, next)
    shell.setValidationError?.(id, error)
    if (error) { said.set(id, error); if (live) paintNumeric(row, error); else refresh(); return }
    if (typeof shell.set !== 'function') {
      said.set(id, writeUnavailable())
      refresh()
      return
    }

    if (heldByParent(row) || heldByMaster(row)) { refresh(); return }
    // Draft input must not replace a dragged/focused control or consume the
    // following Save click. Standalone hosts still write only on change.
    const inline = live && shell.stagesWrites === true
    if (inline && Object.is(row.value, next)) { said.delete(id); paintNumeric(row); return }
    ++loadGeneration
    if (id === 'model.endpoint' || id === 'model.provider') ++modelGeneration
    busy = id
    said.set(id, typeof next === 'boolean' ? (next ? 'Turning it on.' : 'Turning it off.') : `Setting it to "${next}".`)
    if (!inline && shell.stagesWrites !== true) refresh()
    let result = null
    try { result = await shell.set(id, next) } catch (error) { result = null }
    busy = null
    if (!result || result.ok !== true) {
      said.set(id, readerSentence(result?.reason) || `${Machine()} did not accept the change, so nothing was changed. Try again in a moment.`)
      await load({ force: true })
      return
    }
    if (result.draft) {
      row.value = next
      row.pending = result.pending !== false
      typed.delete(id)
      if (row.pending) said.set(id, id === 'purchases.require_owner_approval' && next === false
        ? 'Unsaved change. Saving asks you to confirm this separately.' : 'Unsaved change.')
      else said.delete(id)
      if (inline) paintNumeric(row)
      else refresh()
      if (id === 'model.endpoint' || id === 'model.provider') await load({ force: true })
      return
    }

    const recorded = result.recorded && result.recorded.ok === true
    said.set(id, typeof next === 'boolean'
      ? (next
        ? (recorded ? `Turned on, and written to ${machinePossessive()} signed record.` : 'Turned on. It could not be written to the signed record.')
        : (recorded ? `Turned off, and written to ${machinePossessive()} signed record.` : 'Turned off. It could not be written to the signed record.'))
      : (recorded ? `Set to "${next}", and written to ${machinePossessive()} signed record.` : `Set to "${next}". It could not be written to the signed record.`))
    await load({ force: true })
  }

  function handleChange(event) {
    const range = event.target.closest('[data-research-range]')
    if (range && hostRoot?.contains(range)) {
      void setValue(range.dataset.researchRange, Number(range.value), { live: true })
      return
    }
    const number = event.target.closest('[data-research-number]')
    if (number && hostRoot?.contains(number)) {
      const value = Number(number.value)
      if (number.value.trim()) void setValue(number.dataset.researchNumber, value, { live: true })
      else {
        said.set(number.dataset.researchNumber, 'Enter a whole number.')
        shell.setValidationError?.(number.dataset.researchNumber, 'Enter a whole number.')
      }
      return
    }

    const field = event.target.closest('[data-research-text]')
    if (field && hostRoot?.contains(field)) {

      void setValue(field.dataset.researchText, String(field.value ?? ''))
      return
    }
    const box = event.target.closest('[data-research-setting]')
    if (!box || !hostRoot?.contains(box)) return
    void setValue(box.dataset.researchSetting, box.checked === true)
  }

  function handleClick(event) {
    if (event.target.closest('[data-product-retry]')) { void load({ force: true }); return }
    const button = event.target.closest('[data-research-choice]')
    if (!button || !hostRoot?.contains(button) || button.disabled) return
    const row = rowFor(button.dataset.researchChoice)
    if (row && row.value === button.dataset.researchValue) return
    void setValue(button.dataset.researchChoice, button.dataset.researchValue)
  }

  function matches(query, section = null) {
    if (state?.rows?.length) return selectedRows(section, query).length > 0
    return PRODUCT_SETTING_IDS.some(id => (!section || sectionOfRow(id) === section) && rowMatches({ id }, query))
  }

  function handleInput(event) {
    const input = event.target.closest('[data-research-text], [data-research-number], [data-research-range]')
    if (!input || !hostRoot?.contains(input)) return
    const id = input.dataset.researchText || input.dataset.researchNumber || input.dataset.researchRange
    typed.set(id, input.value)
    const row = rowFor(id)
    if (!row) return
    if (input.hasAttribute('data-research-number') || input.hasAttribute('data-research-range')) {
      const error = input.value.trim() ? productValueError(row, Number(input.value)) : 'Enter a whole number.'
      if (error) said.set(id, error)
      else said.delete(id)
      shell.setValidationError?.(id, error)
      const article = input.closest('[data-setting-id]')
      const peer = article?.querySelector(input.hasAttribute('data-research-range') ? '[data-research-number]' : '[data-research-range]')
      if (peer && !error) peer.value = input.value
      paintNumeric(row, error)
      if (!error && shell.stagesWrites === true) void setValue(id, Number(input.value), { live: true })
    }
  }

  function bind(root) {
    hostRoot = root
    root.addEventListener('input', handleInput)
    root.addEventListener('change', handleChange)
    root.addEventListener('click', handleClick)
  }

  function afterRender(root = hostRoot) {
    hostRoot = root
    void load()
  }

  function refreshSaved() {
    said.clear()
    typed.clear()
    return load({ force: true })
  }

  function destroy() {
    destroyed = true
    ++loadGeneration
    if (hostRoot) {
      hostRoot.removeEventListener('input', handleInput)
      hostRoot.removeEventListener('change', handleChange)
      hostRoot.removeEventListener('click', handleClick)
    }
    hostRoot = null
  }

  return Object.freeze({ markup, matches, bind, afterRender, refreshSaved, destroy, load, setValue })
}
