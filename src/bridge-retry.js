const DEFAULT_ATTEMPTS = 4
const DEFAULT_DELAYS = [300, 800, 1600]

const defaultSleep = delay => new Promise(resolve => setTimeout(resolve, delay))

function thrownFailure(error) {
  const reason = error instanceof Error
    ? `${error.name}: ${error.message}`
    : `probe threw: ${String(error)}`
  return { ok: false, reason }
}

export async function retryWhileUnavailable(probe, {
  attempts = DEFAULT_ATTEMPTS,
  delays = DEFAULT_DELAYS,
  sleep = defaultSleep,
} = {}) {
  const requestedAttempts = Number(attempts)
  const boundedAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.floor(requestedAttempts) || DEFAULT_ATTEMPTS)
    : DEFAULT_ATTEMPTS
  let lastFailure = { ok: false, reason: 'bridge probe was not attempted' }

  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    try {
      const result = await probe()
      if (result?.ok === true) return result
      lastFailure = result?.ok === false
        ? result
        : { ok: false, reason: 'bridge probe returned an invalid result' }
    } catch (error) {
      lastFailure = thrownFailure(error)
    }

    if (attempt + 1 < boundedAttempts) {
      const delay = Number(delays[attempt] ?? delays.at(-1) ?? 0)
      await sleep(Number.isFinite(delay) && delay > 0 ? delay : 0)
    }
  }

  return lastFailure
}
