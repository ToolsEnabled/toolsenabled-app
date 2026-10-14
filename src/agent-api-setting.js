export const AGENT_API_SETTING_ID = 'agent.agent_api'
export const AGENT_API_CHOICES = Object.freeze(['Only', 'Optimized', 'Enabled', 'Disabled'])

const descriptions = Object.freeze({
  Only: 'Use ToolsEnabled API tools. Native tools are restricted, so tasks need a working API equivalent.',
  Optimized: 'Use ToolsEnabled API tools plus Claude’s file search, skills, planning and tool search. Works with Claude only; other providers do not start.',
  Enabled: 'Offer both API and native tools. API summaries follow your audit setting; native actions are outside that audit.',
  Disabled: 'Withhold the ToolsEnabled API. Native tools remain within role and permission limits; API coordination and integrations are unavailable.',
})

// Provider ids in the engine's Optimized support rows, as a person reads them.
const PROVIDER_LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', local: 'local' })

function providerLabel(item) {
  const id = typeof item?.provider === 'string' ? item.provider.trim() : ''
  return Object.hasOwn(PROVIDER_LABELS, id) ? PROVIDER_LABELS[id] : id || 'an unnamed provider'
}

function spokenList(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function sentence(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return !trimmed ? '' : /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/* One plain summary of the engine's installation-wide support rows: which providers can use
   Optimized, what it adds there, and which providers do not start while it is selected. The
   engine planner refuses every provider whose row is not 'supported' (rc-0922: Claude only). */
export function optimizedSupportText(support) {
  if (!(support?.scope === 'installation' && support.appliesTo === 'new-sessions'
      && Array.isArray(support.providers) && support.providers.length)) {
    return 'Could not read which providers can use Optimized. Each new session checks its provider when it starts.'
  }
  const rows = support.providers.filter(item => item && typeof item === 'object')
  const supported = rows.filter(item => item.status === 'supported')
  const others = rows.filter(item => item.status !== 'supported')
  if (!supported.length) return 'No provider can use Optimized in this copy, so new sessions do not start while it is selected.'
  const names = [...new Set(supported.map(providerLabel))]
  const parts = [`Optimized works with ${spokenList(names)}${others.length ? ' only' : ''}.`]
  for (const item of supported) { const reason = sentence(item.reason); if (reason) parts.push(reason) }
  if (others.length) parts.push(`${spokenList([...new Set(others.map(providerLabel))])} sessions do not start while Optimized is selected.`)
  return parts.join(' ')
}

const discoveryControls = Object.freeze([
  { id: 'agent.tool_summary', key: 'summary', label: 'Introduce available tools',
    description: 'Give each new assistant a short guide to its available tools.', applies: 'new sessions' },
  { id: 'agent.capability_recall', key: 'recall', label: 'Suggest relevant tools',
    description: 'Include a few relevant tool suggestions with your messages when there is a confident match.', applies: 'the next message' },
])

export function agentApiSettingMarkup() {
  return `<div data-quick-agent-api>
    <div class="set-row">
      <span class="set-label">Agent API</span>
      <div class="theme-seg" role="group" aria-label="Agent API">
        ${AGENT_API_CHOICES.map(mode => `<button type="button" data-agent-api-mode="${mode}" aria-pressed="false" disabled>${mode}</button>`).join('')}
      </div>
    </div>
    <p class="drawer-page-empty" data-agent-api-status role="status">Reading the saved choice…</p>
    <p class="drawer-page-empty" data-agent-api-optimized-support role="status">Checking Optimized availability…</p>
    <p class="drawer-page-empty">Applies to new sessions across this installation. Existing sessions keep their tools until restarted.</p>
    <div role="group" aria-label="Tool discovery">
      <p class="set-label">Tool discovery</p>
      ${discoveryControls.map(control => `<label class="set-row set-toggle">
        <span class="set-label">${control.label}</span>
        <span class="toggle"><input type="checkbox" data-agent-api-discovery="${control.id}" aria-describedby="quick-api-${control.key}-status" aria-checked="mixed" disabled/><i></i></span>
      </label>
      <p class="drawer-page-empty">${control.description}</p>
      <p class="drawer-page-empty" id="quick-api-${control.key}-status" data-agent-api-discovery-status="${control.id}" role="status">Reading the saved choice…</p>`).join('')}
    </div>
  </div>`
}

export function bindAgentApiSetting(body, shell = globalThis.window?.mcSettings) {
  const root = body.querySelector('[data-quick-agent-api]')
  if (!root) return
  const buttons = [...root.querySelectorAll('[data-agent-api-mode]')]
  const status = root.querySelector('[data-agent-api-status]')
  const supportStatus = root.querySelector('[data-agent-api-optimized-support]')
  let selected = null
  let busy = true
  let available = false
  let supportedModes = []
  let optimizedSupport = null
  const current = () => root.isConnected !== false && body.querySelector('[data-quick-agent-api]') === root
  const discovery = discoveryControls.map(control => ({
    ...control, input: root.querySelector(`[data-agent-api-discovery="${control.id}"]`),
    status: root.querySelector(`[data-agent-api-discovery-status="${control.id}"]`),
    value: null, available: false, busy: true,
  })).filter(control => control.input && control.status)

  function paintDiscovery(control, message) {
    if (!current()) return
    control.input.checked = control.value === true
    control.input.indeterminate = control.value === null
    control.input.setAttribute('aria-checked', control.value === null ? 'mixed' : String(control.value))
    control.input.disabled = control.busy || !control.available
    control.status.textContent = message || `${control.value ? 'On' : 'Off'} for ${control.applies}.`
  }

  function readDiscovery(result) {
    for (const control of discovery) {
      const row = result?.rows?.find(item => item.id === control.id)
      control.available = result?.ok === true && result.available === true && row?.present === true
        && row.control === 'toggle' && typeof row.value === 'boolean' && typeof shell?.set === 'function'
        && !result.rejected?.some(item => item.id === '*' || item.id === control.id)
      control.value = control.available ? row.value : null
      control.busy = false
      paintDiscovery(control, control.available ? null : 'Could not read this saved choice. Reopen quick settings to try again.')
    }
  }

  function paint(message) {
    if (!current()) return
    for (const button of buttons) {
      const on = button.dataset.agentApiMode === selected
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
      button.disabled = busy || !available || !supportedModes.includes(button.dataset.agentApiMode)
    }
    status.textContent = message || descriptions[selected] || 'The saved choice could not be read. Reopen Settings to try again.'
    if (supportStatus) {
      supportStatus.textContent = available && !supportedModes.includes('Optimized')
        ? 'This copy does not offer Optimized. Update the app to use it.'
        : optimizedSupportText(optimizedSupport)
    }
  }

  async function read() {
    /* A BROWSER COPY HAS NO SETTINGS BRIDGE (T1536). 'Update the app' and
       'Reopen quick settings' can never help there; say where the choice is made. */
    if (!shell) {
      for (const control of discovery) {
        control.available = false; control.value = null; control.busy = false
        paintDiscovery(control, 'Made in the ToolsEnabled desktop app.')
      }
      available = false
      busy = false
      paint('The three Agent API choices are made in the ToolsEnabled desktop app on your computer.')
      return
    }
    try {
      const result = await shell?.read?.()
      if (!current()) return
      readDiscovery(result)
      const row = result?.rows?.find(item => item.id === AGENT_API_SETTING_ID)
      supportedModes = Array.isArray(row?.options)
        ? AGENT_API_CHOICES.filter(mode => row.options.includes(mode)) : []
      available = result?.ok === true && result.available === true && row?.present === true
        && row.control === 'seg' && supportedModes.includes(row.value)
        && typeof shell?.set === 'function'
        && !result.rejected?.some(item => item.id === '*' || item.id === AGENT_API_SETTING_ID)
      optimizedSupport = row?.optimizedSupport ?? null
      selected = available ? row.value : null
      busy = false
      paint(available ? null : 'This copy cannot read or change the saved Agent API choice. Update the app and try again.')
    } catch {
      if (!current()) return
      readDiscovery(null)
      available = false
      busy = false
      paint('The saved choice could not be read. Reopen Settings to try again.')
    }
  }

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-agent-api-mode]')
    if (!current() || !button || !root.contains(button) || button.disabled || busy || !available) return
    const next = button.dataset.agentApiMode
    if (!supportedModes.includes(next) || selected === next) return
    busy = true
    paint('Saving…')
    try {
      const result = await shell.set(AGENT_API_SETTING_ID, next)
      if (!current()) return
      if (result?.ok === false) {
        busy = false
        paint(`Could not save the change.${typeof result.reason === 'string' && result.reason ? ` ${result.reason}` : ' Try again.'}`)
        return
      }
      if (result?.ok !== true || result.id !== AGENT_API_SETTING_ID || result.value !== next) {
        throw new Error('Setting was not confirmed.')
      }
      selected = result.value
      busy = false
      paint()
    } catch {
      if (!current()) return
      available = false
      busy = false
      paint(`Could not confirm the saved choice. Last confirmed choice: ${selected}. Reopen quick settings to read it again.`)
    }
  })
  root.addEventListener('change', async event => {
    const input = event.target.closest('[data-agent-api-discovery]')
    const control = discovery.find(item => item.input === input)
    if (!current() || !control || !root.contains(input) || control.busy || !control.available) return
    const next = input.checked
    if (next === control.value) return
    control.busy = true
    paintDiscovery(control, 'Saving…')
    try {
      const result = await shell.set(control.id, next)
      if (!current()) return
      if (result?.ok !== true || result.value !== next || (result.id != null && result.id !== control.id)) {
        throw new Error('Setting was not confirmed.')
      }
      control.value = result.value
      control.busy = false
      paintDiscovery(control)
    } catch {
      if (!current()) return
      control.busy = false
      control.available = false
      control.value = null
      paintDiscovery(control, 'Could not confirm the saved choice. Reopen quick settings to read it again.')
    }
  })
  for (const control of discovery) paintDiscovery(control, 'Reading the saved choice…')
  void read()
}
