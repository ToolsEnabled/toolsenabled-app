'use strict'

const { validateMetricsQuery: validateLocalMetricsQuery } = require('./metrics-record-query.cjs')
// Whole-computer history is a local desktop choice. Relay reads retain the
// authenticated selected-account boundary even when a caller requests more.
const validateMetricsQuery = query => validateLocalMetricsQuery(query) && query.scope !== 'computer'
const COMMANDS = Object.freeze(['agent:history', 'agent:usage'])
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const refuse = code => Object.freeze({ ok: false, code })
const safeRefusal = value => refuse(typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(value.code)
  ? value.code : 'REMOTE_METRICS_UNAVAILABLE')

// These are reads of the session-selected product account, not of the whole
// computer's history. The desktop's authenticated session must own the relay
// device before either journal is read. No account selector comes from the web.
function createRemoteMetrics({ getStore, client, deviceStatus, connectionTicket,
  connectionContinues, currentPrincipal, read } = {}) {
  for (const fn of [getStore, deviceStatus, connectionTicket, connectionContinues, currentPrincipal, read]) {
    if (typeof fn !== 'function') throw new Error('Remote Metrics needs explicit native dependencies')
  }
  if (typeof client?.authorizeDeviceSettings !== 'function' || typeof client?.verifiedAccount !== 'function') {
    throw new Error('Remote Metrics needs hosted device ownership verification')
  }
  function admission(principal) {
    let current
    try { current = currentPrincipal() } catch { return refuse('MC_AGENT_CONNECTION_CLOSED') }
    if (principal?.kind !== 'relay' || !principal.owner || current?.kind !== 'relay' || current.owner !== principal.owner) {
      return refuse('MC_AGENT_PRINCIPAL_INVALID')
    }
    // Drive OFF permits this read, as it does the ordinary account-settings read.
    return null
  }
  async function run(command, payload, principal) {
    let denied = admission(principal)
    if (denied) return denied
    if (!COMMANDS.includes(command) || !plain(payload)
      || Object.keys(payload).some(key => !['limit', 'metrics'].includes(key))
      || !plain(payload.metrics) || !validateMetricsQuery(payload.metrics)
      || (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 200))) {
      return refuse('METRICS_QUERY_INVALID')
    }
    const request = Object.freeze({ limit: payload.limit ?? 200, metrics: Object.freeze({ ...payload.metrics }) })
    const ticket = connectionTicket()
    if (!connectionContinues(ticket)) return refuse('MC_AGENT_CONNECTION_CLOSED')
    const store = getStore()
    const before = store.current()
    if (before?.signedIn !== true || before.account?.signInMethod !== 'hosted'
      || !/^account:[0-9a-f]{32}$/.test(before.principal || '') || !before.session?.id) {
      return refuse('REMOTE_ACCOUNT_HOSTED_SIGNIN_REQUIRED')
    }
    const connected = () => connectionContinues(ticket) ? admission(principal) : refuse('MC_AGENT_CONNECTION_CLOSED')
    const device = await deviceStatus()
    if ((denied = connected())) return denied
    if (device?.ok !== true || device.connected !== true) return refuse('REMOTE_ACCOUNT_DEVICE_UNAVAILABLE')
    const authority = await client.authorizeDeviceSettings({ deviceId: device.deviceId, pairId: device.pairId })
    if ((denied = connected())) return denied
    if (authority?.ok !== true) return safeRefusal(authority)
    const sameAccount = () => {
      const hosted = client.verifiedAccount(), current = store.current()
      return typeof hosted?.id === 'string' && hosted.id.length > 0
        && hosted.id === authority.accountId && current?.signedIn === true
        && current.account?.signInMethod === 'hosted' && current.principal === before.principal
        && current.session?.id === before.session.id
    }
    if (!sameAccount()) return refuse('REMOTE_ACCOUNT_CHANGED')
    const result = await read(command, request, principal)
    if ((denied = connected())) return denied
    if (!sameAccount()) return refuse('REMOTE_ACCOUNT_CHANGED')
    if (result?.ok !== true) return safeRefusal(result)
    if (result.metrics?.principal !== before.principal) return refuse('METRICS_ACCOUNT_CHANGED')
    if (result.metrics?.v !== 1 || (result.metrics.scope ?? 'account') !== 'account' || result.metrics.fromMs !== request.metrics.fromMs
      || result.metrics.toMs !== request.metrics.toMs || !Array.isArray(result.entries)) {
      return refuse('REMOTE_METRICS_UNAVAILABLE')
    }
    return result
  }
  return Object.freeze({ run, validateQuery: validateMetricsQuery })
}

module.exports = { createRemoteMetrics, validateMetricsQuery }
