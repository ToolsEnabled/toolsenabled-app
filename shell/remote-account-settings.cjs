'use strict'

// Account data is narrower than the machine's ordinary agent surface. A relay
// connection proves which computer is being driven; it does not prove that
// the account currently signed in at that computer owns the connection.
const KEYS = Object.freeze(['agent_tool_states', 'agent_tools_disabled', 'research_queue', 'research_experiments'])
const MAX_VALUE_CHARS = 64 * 1024
const REASONS = Object.freeze({
  MC_AGENT_PRINCIPAL_READ_ONLY: 'Turn on “Let a signed-in browser drive this computer” in the app’s Settings before changing settings from the browser.',
  MC_AGENT_CONNECTION_CLOSED: 'This computer’s connection ended. Reconnect it before continuing.',
  MC_AGENT_PRINCIPAL_INVALID: 'This browser connection could not be verified. Reconnect before continuing.',
  REMOTE_ACCOUNT_SETTING_REFUSED: 'This setting is not available from a browser.',
  REMOTE_ACCOUNT_HOSTED_SIGNIN_REQUIRED: 'Sign in to the same ToolsEnabled account in the app on this computer and in your browser.',
  REMOTE_ACCOUNT_DEVICE_UNAVAILABLE: 'This computer’s account connection could not be checked. Reconnect it and try again.',
  HOSTED_ACCOUNT_DEVICE_REFUSED: 'The account signed in on this computer does not own its browser connection. Sign in to the same ToolsEnabled account on both.',
  HOSTED_ACCOUNT_SIGNIN_REQUIRED: 'Sign in again to your ToolsEnabled account in the app on this computer.',
  REMOTE_ACCOUNT_CHANGED: 'The account on this computer changed while its settings were being checked. Check that both places use the same account, then try again.',
  ACCOUNT_CHANGED: 'The signed-in account changed before this setting could be read or written.',
  ACCOUNT_DATA_BAD_VALUE: 'That setting is not valid text or is too large to save.',
  ACCOUNT_DATA_FULL: 'This account has filled its settings space. Remove an unused setting in the app before saving another.',
  ACCOUNT_DATA_WRITE_FAILED: 'That setting could not be saved on this computer. Check that its storage is available, then try again.',
  ACCOUNT_NOT_SIGNED_IN: 'Sign in again to the same account on this computer and in your browser.',
})
const refusal = code => Object.freeze({ ok: false, code,
  reason: REASONS[code] || 'This computer could not verify or open your account settings. Try again when its account connection is available.' })
const codeOnly = result => refusal(typeof result?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(result.code)
  ? result.code : 'REMOTE_ACCOUNT_SETTINGS_UNAVAILABLE')
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function createRemoteAccountSettings({ getStore, client, deviceStatus, connectionTicket,
  connectionContinues, currentPrincipal } = {}) {
  for (const value of [getStore, deviceStatus, connectionTicket, connectionContinues, currentPrincipal]) {
    if (typeof value !== 'function') throw new Error('Remote account settings need explicit native dependencies')
  }
  if (typeof client?.authorizeDeviceSettings !== 'function' || typeof client?.verifiedAccount !== 'function') {
    throw new Error('Remote account settings need hosted device ownership verification')
  }

  function admission(principal, write) {
    let current
    try { current = currentPrincipal() } catch { return refusal('MC_AGENT_CONNECTION_CLOSED') }
    if (principal?.kind !== 'relay' || !principal.owner || current?.kind !== 'relay'
      || current.owner !== principal.owner) return refusal('MC_AGENT_PRINCIPAL_INVALID')
    if (write && (principal.mayWrite !== true || current.mayWrite !== true)) return refusal('MC_AGENT_PRINCIPAL_READ_ONLY')
    return null
  }

  async function run(operation, payload, principal) {
    if (!['get', 'put'].includes(operation)) return refusal('REMOTE_ACCOUNT_SETTINGS_BAD_OPERATION')
    const write = operation === 'put'
    // Refuse a write before inspecting its payload, just like the agent door.
    let denied = admission(principal, write)
    if (denied) return denied
    const fields = write ? ['key', 'value', 'expectedAccountId'] : ['key', 'expectedAccountId']
    if (!plain(payload) || Object.keys(payload).some(key => !fields.includes(key))
      || !Object.hasOwn(payload, 'key') || !KEYS.includes(payload.key)) return refusal('REMOTE_ACCOUNT_SETTING_REFUSED')
    if (write && (!Object.hasOwn(payload, 'value') || (payload.value !== null
      && (typeof payload.value !== 'string' || payload.value.length > MAX_VALUE_CHARS)))) {
      return refusal('ACCOUNT_DATA_BAD_VALUE')
    }
    // Take values before yielding; neither the caller nor an async dependency
    // may substitute a different setting or removal into the admitted request.
    const { key, value } = payload
    const options = Object.hasOwn(payload, 'expectedAccountId')
      ? Object.freeze({ expectedAccountId: payload.expectedAccountId }) : undefined
    const ticket = connectionTicket()
    if (!connectionContinues(ticket)) return refusal('MC_AGENT_CONNECTION_CLOSED')
    const store = getStore()
    const before = store.current()
    if (before?.signedIn !== true || before.account?.signInMethod !== 'hosted') return refusal('REMOTE_ACCOUNT_HOSTED_SIGNIN_REQUIRED')
    const stillAdmitted = () => {
      if (!connectionContinues(ticket)) return refusal('MC_AGENT_CONNECTION_CLOSED')
      return admission(principal, write)
    }
    const device = await deviceStatus()
    if ((denied = stillAdmitted())) return denied
    if (device?.ok !== true || device.connected !== true) return refusal('REMOTE_ACCOUNT_DEVICE_UNAVAILABLE')
    // The desktop session stays inside the hosted client. The server verifies
    // both device IDs against THAT session's account, never an ID from the web.
    const authority = await client.authorizeDeviceSettings({ deviceId: device.deviceId, pairId: device.pairId })
    if ((denied = stillAdmitted())) return denied
    if (authority?.ok !== true) return codeOnly(authority)
    const hosted = client.verifiedAccount()
    const current = store.current()
    if (!hosted || hosted.id !== authority.accountId || current?.signedIn !== true
      || current.account?.signInMethod !== 'hosted' || current.principal !== before.principal
      || current.session?.id !== before.session?.id) return refusal('REMOTE_ACCOUNT_CHANGED')
    // No await between this last account/connection/Drive check and the store's
    // own synchronous current-session check and atomic read/write.
    const result = write ? store.putSetting({ key, value, ...(options || {}) }) : store.getSetting(key, options)
    if (result?.ok !== true) return codeOnly(result)
    if (write) return Object.freeze({ ok: true, key, removed: value === null })
    if (result.value !== null && (typeof result.value !== 'string' || result.value.length > MAX_VALUE_CHARS)) {
      return refusal('REMOTE_ACCOUNT_SETTING_UNREADABLE')
    }
    return Object.freeze({ ok: true, key, value: result.value, accountId: result.accountId })
  }

  return Object.freeze({ run })
}

module.exports = { createRemoteAccountSettings, KEYS, MAX_VALUE_CHARS }
