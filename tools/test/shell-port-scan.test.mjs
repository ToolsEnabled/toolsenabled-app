/* Unit tests for shell/port-scan.cjs.
 *
 * WHY THESE NO LONGER BIND 4601-4609
 *
 * Each case here used to occupy the product's real port range to set up its
 * scenario. That made the suite depend on the whole machine being idle: if
 * anything else held one of those nine ports -- the app, a second build, a
 * QA harness, a teammate -- these went red for a reason unrelated to the
 * code under test. That is a defect in the tests, not an environment
 * problem. A gate that fails on a busy machine is a gate people learn to
 * skip, and it would fail in CI and on any developer's laptop with the
 * product running.
 *
 * The scan takes its candidate list as a parameter, and shell/main.cjs
 * passes the real range through that same parameter, so the production path
 * is what runs here either way. These cases now inject an ephemeral block of
 * ports that this file OWNS -- taken from the OS by binding port 0 and held
 * for the duration -- so the scenario ("this one is occupied, that one is
 * free") is established by us and cannot be disturbed by anything else on
 * the machine.
 *
 * What the range actually is stays asserted, directly, against the module's
 * exported constants; tools/test/shell-port-scan-contract.test.mjs
 * additionally pins the no-argument default and the shell's call site, so
 * injectability here cannot quietly become "the product scans whatever the
 * test says".
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import portScan from '../../shell/port-scan.cjs'

const {
  SHELL_HOST,
  SHELL_PORT_MIN,
  SHELL_PORT_MAX,
  SHELL_PORTS,
  listenOnFirstFreePort,
} = portScan

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, SHELL_HOST)
  })
}

function close(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

/* Take `size` ports from the OS and keep holding them. Binding port 0 makes
   the operating system name a port nothing else currently has, and not
   releasing it means nothing else can take it while a case runs -- so the
   scenario each case sets up is exact, not merely likely. Sorted ascending
   so "first entry in the list" and "lowest port" coincide, which is the
   shape the declared range has. */
async function borrowBlock(t, size) {
  const slots = []
  for (let index = 0; index < size; index += 1) {
    const server = net.createServer()
    await listen(server, 0)
    slots.push({ port: server.address().port, holder: server })
  }
  slots.sort((left, right) => left.port - right.port)

  t.after(async () => {
    const results = await Promise.allSettled(slots.map((slot) => close(slot.holder)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  })

  return {
    ports: Object.freeze(slots.map((slot) => slot.port)),
    /* Hand these back to the OS so the scan is able to take them. */
    free: (...indexes) => Promise.all(indexes.map((index) => close(slots[index].holder))),
    freeAll: () => Promise.all(slots.map((slot) => close(slot.holder))),
  }
}

function assertLoopbackBinding(server, expectedPort) {
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  assert.equal(address.address, SHELL_HOST)
  assert.equal(address.port, expectedPort)
}

/* The range is a declaration, so it is read from the declaration rather than
   inferred from nine successful binds -- which is both stronger and immune
   to what else the machine is doing. */
test('the declared range is the inclusive 4601-4609 set, ascending and contiguous', () => {
  assert.equal(SHELL_HOST, '127.0.0.1')
  assert.equal(SHELL_PORT_MIN, 4601)
  assert.equal(SHELL_PORT_MAX, 4609)
  assert.deepEqual(SHELL_PORTS, [4601, 4602, 4603, 4604, 4605, 4606, 4607, 4608, 4609])
  for (let index = 1; index < SHELL_PORTS.length; index += 1) {
    assert.equal(SHELL_PORTS[index], SHELL_PORTS[index - 1] + 1)
  }
})

test('binds the first entry when the whole list is free', async (t) => {
  const block = await borrowBlock(t, 4)
  await block.freeAll()
  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[0])
    assertLoopbackBinding(server, block.ports[0])
  } finally {
    await close(server)
  }
})

test('skips an occupied first entry and binds the second', async (t) => {
  const block = await borrowBlock(t, 4)
  await block.free(1, 2, 3) // the first entry stays held by this test
  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[1])
    assertLoopbackBinding(server, block.ports[1])
  } finally {
    await close(server)
  }
})

test('binds the last entry when every earlier entry is occupied', async (t) => {
  const block = await borrowBlock(t, 9)
  const last = block.ports.length - 1
  await block.free(last)
  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[last])
    assertLoopbackBinding(server, block.ports[last])
  } finally {
    await close(server)
  }
})

test('reports range exhaustion when every port in the list is occupied', async (t) => {
  /* Nothing is released: this test holds all nine for the whole case, so
     exhaustion is guaranteed rather than dependent on the machine. */
  const block = await borrowBlock(t, 9)
  const server = net.createServer()
  try {
    await assert.rejects(
      listenOnFirstFreePort(server, block.ports, SHELL_HOST),
      (error) => {
        assert.equal(error.code, 'SHELL_PORT_RANGE_EXHAUSTED')
        assert.notEqual(error.code, 'EADDRINUSE')
        assert.deepEqual([...error.ports], [...block.ports])
        /* The message has to describe the attempt a person is being asked to
           act on, so it must name the span it actually tried -- whether it
           renders that as a contiguous "first-last" or as a list. */
        assert.match(error.message, new RegExp(String(block.ports[0])))
        assert.match(error.message, new RegExp(String(block.ports[block.ports.length - 1])))
        assert.equal(error.failures.length, block.ports.length)
        return true
      },
    )
    assert.equal(server.listening, false)
    assert.equal(server.listenerCount('error'), 0)
  } finally {
    await close(server)
  }
})
