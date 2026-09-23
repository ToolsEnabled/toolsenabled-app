// Native-only entry to an ordinary workspace bound to one authenticated peer.
// The selected connection token is opaque; no address or credential is handled.
export function createRemoteComputerSettings({ shell = globalThis.window?.mcShell } = {}) {
  const bridge = shell?.remoteWorkspace
  const available = bridge && ['status', 'inspect', 'open'].every(name => typeof bridge[name] === 'function')
  let root = null
  let destroyed = false
  let busy = false
  let peer = null
  let ready = false
  let checked = false
  let status = 'Check which paired computer is available through your account.'
  const esc = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  function markup() {
    if (!available) return ''
    return `<section class="settings-section" data-settings-section="Connect this computer" data-remote-computer>
      <h2 class="settings-section-title">Open a paired computer</h2>
      <p class="settings-desc">Use the same agent workspace on your other computer. Both computers must be connected to your account and running ToolsEnabled.</p>
      <label class="connect-name"><span>Computer</span><select class="fleet-profile-input" data-remote-peer aria-label="Paired computer" ${busy || !peer ? 'disabled' : ''}>
        <option value="">Choose a paired computer</option>
        ${peer ? `<option value="${esc(peer.selection)}" selected>Paired computer · ${esc(peer.id.slice(0, 8))}</option>` : ''}
      </select></label>
      <p class="fleet-profile-status" data-remote-status role="status">${esc(status)}</p>
      <label class="connect-note"><input type="checkbox" data-remote-consent ${checked ? 'checked' : ''} ${busy || !ready ? 'disabled' : ''}> Send the actions I choose in that workspace to this paired computer.</label>
      <p class="settings-desc">Its Drive setting controls whether changes are allowed. Approvals and agent permissions are still enforced there. Closing the remote window leaves its running agents alone.</p>
      <div class="fleet-profile-actions">
        <button type="button" class="ctl-btn" data-remote-action="refresh" ${busy ? 'disabled' : ''}>Check connection</button>
        <button type="button" class="ctl-btn armed" data-remote-action="open" ${busy || !ready || !checked || !peer ? 'disabled' : ''}>Open remote workspace</button>
      </div>
    </section>`
  }
  function paint() {
    if (destroyed || !root) return
    const node = root.querySelector('[data-remote-computer]')
    if (node) node.outerHTML = markup()
  }
  async function refresh() {
    if (busy || destroyed) return
    busy = true; ready = false; checked = false; status = 'Checking the paired connection…'; paint()
    try {
      const result = await bridge.status()
      if (destroyed) return
      peer = result?.peer || null
      if (!peer) status = 'No paired computer is reachable yet. Check the connected computers on your account and keep ToolsEnabled open on both.'
      else {
        status = 'Asking that computer for its current status…'; paint()
        const answer = await bridge.inspect(peer.selection)
        if (destroyed) return
        ready = answer?.ok === true && answer.status === 200 && answer.value?.ok === true && answer.value?.facade === 'ready'
        status = ready ? answer.value.mayWrite === true
          ? 'Connected. Remote controls are enabled on that computer.'
          : 'Connected in view-only mode. Enable Drive on that computer to allow changes.'
          : 'The paired computer has not answered. Check that ToolsEnabled is running there, then check the connection again.'
      }
    } catch { peer = null; status = 'The connection could not be checked. Check it again after both computers are connected.' }
    finally { busy = false; paint() }
  }
  async function open() {
    if (busy || !ready || !peer || !checked || destroyed) return
    busy = true; status = 'Opening the selected computer’s workspace…'; paint()
    try {
      const answer = await bridge.open({ selection: peer.selection, consent: true })
      if (destroyed) return
      if (answer?.ok === true) status = 'The remote workspace is open in its own window.'
      else {
        ready = false; checked = false
        status = 'The connection changed or could not be opened. Check the connection again before choosing a computer.'
      }
    } catch { ready = false; checked = false; status = 'The remote window could not be opened. Check the connection again.' }
    finally { busy = false; paint() }
  }
  function click(event) {
    const action = event.target.closest?.('[data-remote-action]')?.dataset.remoteAction
    if (action === 'refresh') void refresh()
    if (action === 'open') void open()
  }
  function change(event) {
    if (event.target.matches?.('[data-remote-consent]')) { checked = event.target.checked === true; paint() }
    if (event.target.matches?.('[data-remote-peer]')) {
      checked = false
      if (event.target.value !== peer?.selection) { peer = null; ready = false }
      paint()
    }
  }
  return {
    markup,
    bind(element) { root = element; root.addEventListener('click', click); root.addEventListener('change', change) },
    destroy() { destroyed = true; root?.removeEventListener('click', click); root?.removeEventListener('change', change); root = null },
  }
}
