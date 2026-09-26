/* TWO CALLERS, ONE ANSWER, AND THE ONE THAT ARRIVES SECOND USED TO GUESS.
 *
 * Every page load asks whether this browser can reach the person's machine, and
 * asks it twice: the app's first bridge request, and the data-source resolver
 * choosing relay-versus-mock. The ask is one network handshake to a computer
 * somewhere else, so it takes seconds.
 *
 * The second caller used to read a boolean that meant "somebody has asked",
 * take it for "and the answer was no", and settle the page on the example
 * fleet -- while the machine was mid-handshake and about to say yes. Measured
 * live on 2026-08-22 against a machine that answered two seconds after load:
 * the relay logged the session, the machine logged the web session opening, the
 * console carried no error, and the browser still drew the example.
 *
 * A fresh import per case because the module holds this state for the life of
 * the page, which is exactly what the defect depended on. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

let seq = 0
async function freshBridge() {
  seq += 1
  return import(new URL(`../../src/mission-bridge.js?case=${seq}`, import.meta.url).href)
}

/* A host whose answer takes real time, like the machine it is asking. */
function slowHost({ delayMs = 25, answers = true } = {}) {
  const calls = { count: 0 }
  const shell = {
    getBridgeTransport: async () => {
      calls.count += 1
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return answers ? (() => ({ ok: true })) : null
    },
  }
  return { calls, shell }
}

/* AWAITED, not merely called. The first version of this put the window back in
   a synchronous `finally`, which ran the moment the async body returned its
   promise -- so every case that awaited anything ran the rest of itself with no
   window at all, and one of them failed for a reason that had nothing to do
   with the code under test. */
async function withWindow(shell, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previous = globalThis.window
  globalThis.window = { mcShell: shell }
  try { return await body() } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('a second asker waits for the answer instead of guessing there is none', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const { calls, shell } = slowHost()
  await withWindow(shell, async () => {
    /* Started together, exactly as a page load starts them. */
    const [first, second] = await Promise.all([
      bridgeTransportAvailable(),
      bridgeTransportAvailable(),
    ])
    assert.equal(first, true, 'the first asker must see the machine')
    assert.equal(second, true, 'the second asker must see the SAME machine, not conclude there is none')
  })
  assert.equal(calls.count, 1, 'one handshake, not two')
})

test('a host with no machine still answers no, to everyone', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const { shell } = slowHost({ answers: false })
  await withWindow(shell, async () => {
    const [first, second] = await Promise.all([
      bridgeTransportAvailable(),
      bridgeTransportAvailable(),
    ])
    assert.equal(first, false)
    assert.equal(second, false)
  })
})

test('a host that throws is survived by every asker', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const shell = { getBridgeTransport: async () => { throw new Error('no machine') } }
  await withWindow(shell, async () => {
    const answers = await Promise.all([
      bridgeTransportAvailable(),
      bridgeTransportAvailable(),
      bridgeTransportAvailable(),
    ])
    assert.deepEqual(answers, [false, false, false])
  })
})

test('an unavailable host offer is retried by the next ordinary read', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const { calls, shell } = slowHost({ answers: false })
  await withWindow(shell, async () => {
    await bridgeTransportAvailable()
    await bridgeTransportAvailable()
    assert.equal(calls.count, 2, 'absence of an offer is not a permanent statement that this computer has no transport')
  })
})

test('reask asks again once the first answer has landed', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const { calls, shell } = slowHost({ answers: false })
  await withWindow(shell, async () => {
    await bridgeTransportAvailable()
    await bridgeTransportAvailable({ reask: true })
    assert.equal(calls.count, 2, 'a sign-in must be able to ask a host that previously had nothing')
  })
})

test('reask during an ask in flight does not start a second handshake', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  const { calls, shell } = slowHost({ delayMs: 40 })
  await withWindow(shell, async () => {
    const [plain, reasked] = await Promise.all([
      bridgeTransportAvailable(),
      bridgeTransportAvailable({ reask: true }),
    ])
    assert.equal(plain, true)
    assert.equal(reasked, true)
  })
  assert.equal(calls.count, 1, 'two handshakes racing to install one transport is a worse answer than waiting')
})

test('no host at all is still an immediate no', async () => {
  const { bridgeTransportAvailable } = await freshBridge()
  await withWindow({}, async () => {
    assert.equal(await bridgeTransportAvailable(), false)
  })
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('a delayed host offer cannot replace an explicitly selected machine', async () => {
  const bridge = await freshBridge()
  const offer = deferred()
  await withWindow({ getBridgeTransport: () => offer.promise }, async () => {
    const pending = bridge.bridgeTransportAvailable()
    bridge.setBridgeTransport(async () => ({ ok: true, machine: 'selected' }))
    offer.resolve(async () => ({ ok: true, machine: 'obsolete' }))
    await pending
    assert.equal((await bridge.bridgeStatus()).machine, 'selected')
  })
})

test('removing a connection invalidates its pending host offer', async () => {
  const bridge = await freshBridge()
  const offer = deferred()
  await withWindow({ getBridgeTransport: () => offer.promise }, async () => {
    const pending = bridge.bridgeTransportAvailable()
    bridge.setBridgeTransport(null)
    offer.resolve(async () => ({ ok: true }))
    assert.equal(await pending, false)
    assert.equal(bridge.bridgeTransportInstalled(), false)
  })
})

test('a new session can discover its machine before the old handshake finishes', async () => {
  const bridge = await freshBridge()
  const oldOffer = deferred()
  const newOffer = deferred()
  let asks = 0
  await withWindow({ getBridgeTransport: () => (++asks === 1 ? oldOffer : newOffer).promise }, async () => {
    const oldPending = bridge.bridgeTransportAvailable()
    bridge.setBridgeTransport(null)
    const newPending = bridge.bridgeTransportAvailable()
    try {
      assert.equal(asks, 2, 'the new session must not wait on the invalidated handshake')
      // Finishing the old lookup must not clear the new in-flight lookup.
      oldOffer.resolve(async () => ({ ok: true, machine: 'old' }))
      await oldPending
      assert.equal(bridge.bridgeTransportInstalled(), false)
      const concurrent = bridge.bridgeTransportAvailable({ reask: true })
      assert.equal(asks, 2)
      newOffer.resolve(async () => ({ ok: true, machine: 'new' }))
      assert.deepEqual(await Promise.all([newPending, concurrent]), [true, true])
      assert.equal((await bridge.bridgeStatus()).machine, 'new')
    } finally {
      oldOffer.resolve(null)
      newOffer.resolve(null)
      await Promise.all([oldPending, newPending])
    }
  })
})

test('reachability discovers the host transport before deciding the machine is unavailable', async () => {
  const bridge = await freshBridge()
  const calls = []
  await withWindow({ getBridgeTransport: async () => async pathname => {
    calls.push(pathname)
    return { ok: true }
  } }, async () => {
    assert.deepEqual(await bridge.bridgeReachable(), { ok: true })
    assert.deepEqual(calls, ['/v1/runtime'])
  })
})

test('a write waiting for discovery is not sent to a different selected machine', async () => {
  const bridge = await freshBridge()
  const offer = deferred()
  const calls = []
  await withWindow({ getBridgeTransport: () => offer.promise }, async () => {
    const pending = bridge.postBridgeAction('dispatch', { task: 'fixture only' })
    bridge.setBridgeTransport(async pathname => {
      calls.push(pathname)
      return { ok: true, receipt: {} }
    })
    offer.resolve(null)
    const result = await pending
    assert.equal(result.code, 'BRIDGE_CONNECTION_CHANGED')
    assert.deepEqual(calls, [], 'the original write is not redirected to the new machine')
  })
})

test('a late reply cannot supply or erase the newly selected machine\'s cached capabilities', async () => {
  const bridge = await freshBridge()
  const reply = deferred()
  const started = deferred()
  let newReads = 0
  await withWindow({}, async () => {
    bridge.setBridgeTransport(async () => { started.resolve(); return reply.promise })
    const pending = bridge.localTiersStatus()
    await started.promise
    bridge.setBridgeTransport(async () => {
      newReads += 1
      return { ok: true, receipt: { available: false, reason: 'no_gpu_peer_configured', machine: 'new' } }
    })
    assert.equal((await bridge.localTiersStatus()).receipt.machine, 'new')
    reply.resolve({ ok: false, code: 'MODEL_NO_GPU_PEER_CONFIGURED', reason: 'old machine' })
    assert.equal((await pending).code, 'BRIDGE_CONNECTION_CHANGED')
    assert.equal((await bridge.localTiersStatus()).receipt.machine, 'new')
    assert.equal(newReads, 1, 'the obsolete answer does not overwrite or erase the new cache')
  })
})
