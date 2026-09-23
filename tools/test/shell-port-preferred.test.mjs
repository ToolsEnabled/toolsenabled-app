/* The shell now asks for the port it used last before scanning, so that a
   person's origin stops changing under them. The durable settings file is what
   makes a moved port survivable; this is what makes it rare. */
import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SHELL_HOST,
  SHELL_PORTS,
  listenOnFirstFreePort,
  preferredPortFirst,
} = require('../../shell/port-scan.cjs')

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, SHELL_HOST, () => resolve(server))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

/* Bind on port 0 to learn a port the operating system says is free, then
   release it. Asserting against a hardcoded port fails on a developer machine
   that happens to be running the product -- which is exactly the condition
   this whole change is about. */
async function borrowFreePorts(count) {
  const servers = []
  for (let index = 0; index < count; index += 1) servers.push(await listen(0))
  const ports = servers.map((server) => server.address().port)
  await Promise.all(servers.map(close))
  return ports
}

test('with nothing remembered the scan order is unchanged', () => {
  assert.deepEqual(preferredPortFirst(SHELL_PORTS, undefined), SHELL_PORTS)
  assert.deepEqual(preferredPortFirst(SHELL_PORTS, null), SHELL_PORTS)
  assert.deepEqual(preferredPortFirst(SHELL_PORTS, '4605'), SHELL_PORTS)
})

test('a remembered port is tried first and the rest keep their order', () => {
  const order = preferredPortFirst([4601, 4602, 4603, 4604], 4603)

  assert.deepEqual([...order], [4603, 4601, 4602, 4604])
})

test('a remembered port appears exactly once', () => {
  const order = preferredPortFirst([4601, 4602, 4603], 4602)

  assert.equal(order.filter((port) => port === 4602).length, 1)
  assert.equal(order.length, 3)
})

/* A stale record must not be able to move the shell outside the range the
   startup failure message promises it tried. */
test('a remembered port outside the declared range is ignored', () => {
  assert.deepEqual(preferredPortFirst(SHELL_PORTS, 9999), SHELL_PORTS)
  assert.deepEqual(preferredPortFirst(SHELL_PORTS, 80), SHELL_PORTS)
})

test('the remembered port is actually bound when it is free', async () => {
  const [a, b] = await borrowFreePorts(2)
  const server = net.createServer()

  const bound = await listenOnFirstFreePort(server, preferredPortFirst([a, b], b), SHELL_HOST)

  assert.equal(bound, b, 'the shell should have taken the port it remembered, not the first in the list')
  await close(server)
})

test('an occupied remembered port falls through to the scan instead of failing', async () => {
  const [a, b] = await borrowFreePorts(2)
  const squatter = await listen(b)
  const server = net.createServer()

  const bound = await listenOnFirstFreePort(server, preferredPortFirst([a, b], b), SHELL_HOST)

  // This is the case the product must survive rather than refuse: the origin
  // moves, and the settings are expected to survive it anyway.
  assert.equal(bound, a)
  await close(server)
  await close(squatter)
})
