// Local owner consent only. No model-controlled markup, persisted enable flag
// or polling of camera/screen contents. The main process owns the actual gate.
export function mountAccessibilityControls({ available = () => true } = {}) {
  const api = window.mcAccessibility
  if (!api) return { attach() {}, release() {}, destroy() {} }
  const root = document.createElement('details')
  root.className = 'accessibility-controls'
  root.dataset.accessibilityRoot = ''
  root.innerHTML = `<summary data-accessibility-summary>Accessibility · off</summary>
    <p>Experimental hands-free control. Off each time the app starts. Each action requires a separate confirmation.</p>
    <label>Agent <select data-accessibility-target aria-label="Accessibility agent"></select></label>
    <label>Control <select data-accessibility-scope aria-describedby="accessibility-scope-status"><option value="application">ToolsEnabled screens</option><option value="desktop" disabled>Windows desktop</option></select></label>
    <p id="accessibility-scope-status" data-accessibility-scope-status role="status"></p>
    <p>Nearby voices may be heard. The selected agent keeps its role permissions. No screenshots or continuous monitoring.</p>
    <p data-accessibility-desktop-notice hidden>Windows desktop control requires Unrestricted permissions and remains subject to Windows protections. The selected agent can inspect supported window controls and request non-password text from a selected window.</p>
    <button type="button" data-accessibility-enable disabled>Enable Accessibility…</button>
    <button type="button" data-accessibility-stop>Stop Accessibility</button>
    <p data-accessibility-status role="status"></p>`
  // Settings owns the entry point. A pending request still needs its exact
  // confirmation on the screen where the agent is acting.
  const consent = document.createElement('section')
  consent.className = 'accessibility-confirmation'
  consent.dataset.accessibilityRoot = ''
  consent.dataset.accessibilityPending = ''
  consent.hidden = true
  consent.setAttribute('aria-label', 'Accessibility confirmation')
  consent.innerHTML = `<h2>Confirm accessibility request</h2>
      <p data-accessibility-preview role="status"></p><p data-accessibility-code></p>
      <button type="button" data-accessibility-confirm>Confirm this exact request</button>
      <button type="button" data-accessibility-reject>Reject request</button>
      <p data-accessibility-error role="alert"></p>`
  const get = name => root.querySelector('[data-accessibility-' + name + ']') || consent.querySelector('[data-accessibility-' + name + ']')
  let state = null, destroyed = false
  function render(value) {
    if (destroyed) return
    state = value
    const active = value.enabled === true
    const supported = new Set((value.scopes || [{ id: 'application', supported: true }]).filter(scope => scope.supported === true).map(scope => scope.id))
    for (const option of get('scope').options) option.disabled = !supported.has(option.value)
    if (!active && !supported.has(get('scope').value)) get('scope').value = 'application'
    const desktop = value.scopes?.find(scope => scope.id === 'desktop')
    get('desktop-notice').hidden = desktop?.supported !== true
    get('scope-status').textContent = desktop?.supported === true ? ''
      : desktop?.reason || 'Desktop control availability could not be checked. ToolsEnabled screens can still be controlled.'
    if (active) {
      get('target').value = value.sessionId || ''
      get('scope').value = value.scope || 'application'
    }
    get('summary').textContent = 'Accessibility · ' + (active ? 'ON' : 'off')
    get('enable').disabled = !available() || active || value.busy || Boolean(value.pending) || !get('target').value || !supported.has(get('scope').value)
    get('target').disabled = active || value.busy || Boolean(value.pending)
    get('scope').disabled = active || value.busy || Boolean(value.pending)
    consent.hidden = !value.pending
    get('confirm').disabled = value.busy || !available()
    get('status').textContent = value.last?.message || 'Say “enable application accessibility” while connected to a voice contact, or choose an agent here.'
    if (value.pending) {
      get('preview').textContent = value.pending.summary
      get('code').textContent = 'Say “confirm action ' + value.pending.confirmationCode + '”, or “reject action”.'
    } else { get('preview').textContent = ''; get('code').textContent = ''; get('error').textContent = '' }
  }
  async function run(fn) {
    try {
      await fn()
      render(await api.status())
    } catch (error) {
      if (!destroyed) {
        get('status').textContent = String(error?.message || error)
        get('error').textContent = String(error?.message || error)
      }
    }
  }
  async function refresh() {
    // Status and supported scopes must remain readable if agent discovery fails.
    try { render(await api.status()) }
    catch (error) { if (!destroyed) get('status').textContent = String(error?.message || error) }
    try {
      const selected = get('target').value
      const rows = await window.mcVoice.targets()
      if (destroyed) return
      get('target').replaceChildren(new Option('Choose a running agent', ''))
      for (const row of rows) get('target').add(new Option(row.agentId || row.sessionId, row.sessionId))
      get('target').value = selected || state?.sessionId || ''
      render(await api.status())
    } catch (error) { if (!destroyed) get('status').textContent = String(error?.message || error) }
  }
  get('target').addEventListener('change', () => { if (state) render(state) })
  get('scope').addEventListener('change', () => { if (state) render(state) })
  get('enable').addEventListener('click', () => { if (available()) void run(() => api.prepareEnable({ sessionId: get('target').value, scope: get('scope').value })) })
  get('confirm').addEventListener('click', () => {
    const request = state?.pending
    if (request && available()) void run(() => api.confirm({ requestId: request.requestId, code: request.confirmationCode }))
  })
  get('reject').addEventListener('click', () => void run(() => api.reject()))
  get('stop').addEventListener('click', () => void run(() => api.disable()))
  root.addEventListener('toggle', () => { if (root.open) void refresh() })
  const detach = api.onEvent(render)
  document.body.append(consent)
  void refresh()
  return {
    refresh,
    attach(container) {
      if (destroyed) return
      if (!container) { root.remove(); return }
      container.replaceChildren(root)
      root.open = true
      void refresh()
    },
    // Route transitions retire the old Settings view after mounting the new
    // one. Only the view that still contains this panel may detach it.
    release(container) { if (container?.contains(root)) root.remove() },
    destroy() { destroyed = true; detach(); root.remove(); consent.remove() },
  }
}
