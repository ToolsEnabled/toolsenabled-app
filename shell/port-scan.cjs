const SHELL_HOST = '127.0.0.1'
const SHELL_PORT_MIN = 4601
const SHELL_PORT_MAX = 4609
const SHELL_PORTS = Object.freeze(
  Array.from(
    { length: SHELL_PORT_MAX - SHELL_PORT_MIN + 1 },
    (_, index) => SHELL_PORT_MIN + index,
  ),
)

const RETRYABLE_LISTEN_ERRORS = new Set(['EADDRINUSE', 'EACCES'])

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError)
      server.removeListener('listening', onListening)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

function closeFailedAttempt(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function describePorts(ports) {
  if (ports.length === 0) return '(none)'
  const contiguous = ports.every((port, index) => index === 0 || port === ports[index - 1] + 1)
  return contiguous && ports.length > 1
    ? `${ports[0]}-${ports[ports.length - 1]}`
    : ports.join(', ')
}

async function listenOnFirstFreePort(server, ports = SHELL_PORTS, host = SHELL_HOST) {
  if (host !== SHELL_HOST) {
    throw new TypeError(`Shell server must bind to ${SHELL_HOST}`)
  }

  const attemptedPorts = []
  const failures = []
  let lastError
  for (const port of ports) {
    attemptedPorts.push(port)
    try {
      await listenOnce(server, port, host)
      return port
    } catch (error) {
      await closeFailedAttempt(server)
      if (!error || !RETRYABLE_LISTEN_ERRORS.has(error.code)) throw error
      failures.push(Object.freeze({ port, code: error.code, message: error.message }))
      lastError = error
    }
  }

  const error = new Error(
    `No shell port is available on ${host}; attempted ${describePorts(attemptedPorts)}`,
    { cause: lastError },
  )
  error.code = 'SHELL_PORT_RANGE_EXHAUSTED'
  error.host = host
  error.ports = Object.freeze([...attemptedPorts])
  error.failures = Object.freeze([...failures])
  throw error
}

/* TRY THE PORT THIS INSTALL USED LAST, FIRST.
 *
 * The scan order alone made the application's origin an accident of whatever
 * else happened to be listening at launch, and the origin is what browser
 * storage is keyed to -- so a person's settings moved when the port did. The
 * durable settings file (shell/renderer-prefs.cjs) is what makes that
 * survivable; this is what makes it rare, by asking for the same port again
 * before taking a new one.
 *
 * A remembered port OUTSIDE the declared range is ignored rather than honoured.
 * The range is a stated contract -- shell/startup-failure-message.cjs tells a
 * person which ports were tried when none is free -- and a stale record must
 * not be able to make the shell bind somewhere that message does not cover.
 */
function preferredPortFirst(ports, preferred) {
  if (!Number.isInteger(preferred)) return ports
  if (!ports.includes(preferred)) return ports
  return Object.freeze([preferred, ...ports.filter((port) => port !== preferred)])
}

module.exports = {
  SHELL_HOST,
  SHELL_PORT_MIN,
  SHELL_PORT_MAX,
  SHELL_PORTS,
  listenOnFirstFreePort,
  preferredPortFirst,
}
