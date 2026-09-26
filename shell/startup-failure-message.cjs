function safeString(value) {
  try {
    return String(value)
  } catch {
    return 'Unknown startup error'
  }
}

function safeProperty(value, key) {
  try {
    return value && typeof value === 'object' ? value[key] : undefined
  } catch {
    return undefined
  }
}

function underlyingCauseMessage(err) {
  const cause = safeProperty(err, 'cause')
  const message = safeProperty(cause, 'message')
  return message === undefined || message === null || message === ''
    ? ''
    : `\n\nUnderlying error: ${safeString(message)}`
}

function portRange(min, max) {
  return min === max ? safeString(min) : `${safeString(min)}-${safeString(max)}`
}

function startupFailureDetail(err, { min, max } = {}) {
  try {
    const causeDetail = underlyingCauseMessage(err)
    if (safeProperty(err, 'code') !== 'SHELL_PORT_RANGE_EXHAUSTED') {
      return `${safeString(err)}${causeDetail}`
    }

    const range = portRange(min, max)
    const recorded = safeProperty(err, 'failures')
    const failures = Array.isArray(recorded) ? recorded : []
    const attemptedPorts = safeProperty(err, 'ports')
    const hasEveryFailure = Array.isArray(attemptedPorts)
      && attemptedPorts.length > 0
      && failures.length === attemptedPorts.length
    const allInUse = hasEveryFailure && failures.every(
      (failure) => safeProperty(failure, 'code') === 'EADDRINUSE',
    )

    if (allInUse) {
      return `All shell ports ${range} are in use — other ToolsEnabled shells (or stray servers) are holding them. Close them and relaunch.${causeDetail}`
    }

    const refused = failures.find(
      (failure) => safeProperty(failure, 'code') !== 'EADDRINUSE',
    )
    const cause = safeProperty(err, 'cause')
    const causeCode = safeProperty(cause, 'code')
    const refusedCode = safeProperty(refused, 'code') || (
      causeCode && causeCode !== 'EADDRINUSE' ? causeCode : undefined
    )

    if (refusedCode) {
      const fallbackPort = Array.isArray(attemptedPorts) && attemptedPorts.length > 0
        ? attemptedPorts[attemptedPorts.length - 1]
        : max
      const refusedPort = safeProperty(refused, 'port') ?? safeProperty(cause, 'port') ?? fallbackPort
      return `The operating system refused shell port ${safeString(refusedPort)} (${safeString(refusedCode)}), so shell ports ${range} could not be used. Check Windows TCP port exclusions with: netsh interface ipv4 show excludedportrange protocol=tcp${causeDetail}`
    }

    return `No shell port in ${range} could be opened. Individual port failure details were not recorded.${causeDetail}`
  } catch {
    return 'ToolsEnabled could not start because of an unknown startup error.'
  }
}

module.exports = { startupFailureDetail }
