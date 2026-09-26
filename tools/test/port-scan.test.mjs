import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  SHELL_HOST,
  listenOnFirstFreePort,
  preferredPortFirst,
} = require('../../shell/port-scan.cjs')

class PlannedServer extends EventEmitter {
  constructor(outcomes) {
    super()
    this.outcomes = [...outcomes]
    this.attempts = []
    this.listening = false
  }

  listen(port, host) {
    this.attempts.push({ port, host })
    const outcome = this.outcomes.shift()
    queueMicrotask(() => {
      if (outcome instanceof Error) this.emit('error', outcome)
      else {
        this.listening = true
        this.emit('listening')
      }
    })
  }

  close(callback) {
    this.listening = false
    queueMicrotask(() => callback())
  }
}

function listenError(code, message = `listen failed with ${code}`) {
  return Object.assign(new Error(message), { code })
}

test('preferredPortFirst accepts only an in-range integer and preserves the remaining scan order', () => {
  const ports = [4601, 4602, 4603, 4604]

  assert.deepEqual([...preferredPortFirst(ports, 4603)], [4603, 4601, 4602, 4604])
  assert.deepEqual(preferredPortFirst(ports, 9999), ports)
  assert.deepEqual(preferredPortFirst(ports, '4603'), ports)
})

test('listenOnFirstFreePort retries an unavailable port and returns the port it actually binds', async () => {
  const server = new PlannedServer([listenError('EADDRINUSE'), 'listening'])

  const port = await listenOnFirstFreePort(server, [4601, 4602], SHELL_HOST)

  assert.equal(port, 4602)
  assert.deepEqual(server.attempts, [
    { port: 4601, host: SHELL_HOST },
    { port: 4602, host: SHELL_HOST },
  ])
})

test('listenOnFirstFreePort preserves an indeterminate listen failure instead of claiming availability', async () => {
  const failure = listenError('EIO', 'network state could not be read')
  const server = new PlannedServer([failure, 'listening'])

  await assert.rejects(
    listenOnFirstFreePort(server, [4601, 4602], SHELL_HOST),
    (error) => error === failure,
  )
  assert.deepEqual(server.attempts, [{ port: 4601, host: SHELL_HOST }])
})

test('range exhaustion is a reasoned refusal containing every failed attempt', async () => {
  const server = new PlannedServer([
    listenError('EADDRINUSE', 'occupied'),
    listenError('EACCES', 'not permitted'),
  ])

  await assert.rejects(
    listenOnFirstFreePort(server, [4601, 4602], SHELL_HOST),
    (error) => {
      assert.equal(error.code, 'SHELL_PORT_RANGE_EXHAUSTED')
      assert.equal(error.host, SHELL_HOST)
      assert.deepEqual(error.ports, [4601, 4602])
      assert.deepEqual(error.failures, [
        { port: 4601, code: 'EADDRINUSE', message: 'occupied' },
        { port: 4602, code: 'EACCES', message: 'not permitted' },
      ])
      assert.equal(error.cause?.code, 'EACCES')
      return true
    },
  )
})

test('binding away from loopback is refused with the allowed host in the reason', async () => {
  const server = new PlannedServer(['listening'])

  await assert.rejects(
    listenOnFirstFreePort(server, [4601], '0.0.0.0'),
    (error) => error instanceof TypeError && error.message.includes(SHELL_HOST),
  )
  assert.deepEqual(server.attempts, [])
})
