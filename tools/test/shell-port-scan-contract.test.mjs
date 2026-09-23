// Independent contract test for shell/port-scan.cjs (R1206 test lane).
//
// PROVENANCE, honestly stated: the cases below were originally written from
// the contract alone, without reading shell/port-scan.cjs. That is no longer
// true of the whole file -- the machine-independence repair described next
// was made with the module's source in hand, because it changes HOW the
// module is called (which port list is injected), and a repair to a calling
// convention cannot be made blind. The behavioural claims themselves are
// unchanged and still come from the contract, not from the implementation.
//
// WHY THIS SUITE NO LONGER BINDS 4601-4609
//
// It used to drive every case against the product's real port range, and
// opened with a `before()` hook that failed the entire file unless all nine
// of those ports were free. On any machine where something else held one --
// the app itself, a second build, a QA harness, a teammate testing, CI with
// two jobs on one box -- all nine tests went red at once, for a reason that
// had nothing to do with the code under test.
//
// That is a test-design defect, not bad luck. A suite that can only pass on a
// globally idle machine is fragile, not strict; it cries wolf, and a gate
// that cries wolf is one people learn to skip. Requiring an idle machine is
// also a requirement no real environment honours.
//
// The repair splits the claim in two, which makes both halves STRONGER:
//
//   P1  The declared range IS the inclusive 4601-4609 set, ascending and
//       contiguous. Asserted directly against the module's exported
//       constants -- a direct reading of the declaration, rather than
//       something inferred from nine successful binds.
//
//   P2  listenOnFirstFreePort takes the FIRST entry in the list it is given
//       that will bind, and gives up only when every entry fails. Asserted
//       against real sockets on ports this test OWNS -- an ephemeral block
//       the OS hands out and this file holds for the duration -- so no other
//       process on the machine can perturb the result.
//
// P1 and P2 together entail the original claim ("binds the lowest free port
// in 4601-4609") and, unlike the original, neither half can be broken by a
// stranger's socket. The list is a parameter of the function under test and
// shell/main.cjs passes the real range through that same parameter, so P2 is
// exercising the production path, not a test-only one.
//
// Injectability must not become "the product scans whatever the test says",
// so two cases below deliberately pin the production default: contract #9
// exercises the no-argument default against the real declared range, and
// contract #10 pins the shell's own call site to the exported constants.
//
// Everything here drives real OS sockets on 127.0.0.1 (and, for the
// foreign-host case, the real loopback address 127.0.0.2), with ONE stated
// exception: contract #7a2 hands the module a server double, because the
// error class it pins cannot be produced by a live socket inside this
// module's fixed 127.0.0.1 / valid-unprivileged-port domain. That case
// argues for itself in its own body; this sentence is here so the exception
// is visible from the top of the file instead of discovered halfway down.
//
// Contract item -> test map:
//   1) declared range is the inclusive 4601-4609 set        -> "contract #1"
//   2) whole list free -> selects the first entry            -> "contract #2"
//   3) first entry held -> next; general lowest-free claim   -> "contract #3"
//   4) all but the last held -> selects the last             -> "contract #4"
//   5) every entry held -> distinguishable typed error,
//      not raw EADDRINUSE, no server left listening          -> "contract #5"
//   6) binds only 127.0.0.1; other hosts rejected            -> "contract #6"
//   7) a listen error the module does not classify as
//      retryable propagates unchanged and stops the scan     -> "contract #7a"
//      ...the same, for an OS errno shape, counting attempts -> "contract #7a2"
//      an OS per-port exclusion is advanced past and the
//      next free candidate really binds                      -> "contract #7b"
//      ...and when it is the only candidate, the real code
//      survives and is not reworded into "port busy"         -> "contract #7c"
//      (REFORMULATED in R1526 -- the reasoning is in the long
//       note above contract item 7 below)
//   8) no Electron dependency, runs under bare Node          -> "contract #8"
//   9) the no-argument default really is the declared range  -> "contract #9"
//  10) the shell wires that declared range into the scan     -> "contract #10"

import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import portScan from '../../shell/port-scan.cjs'
import startupFailure from '../../shell/startup-failure-message.cjs'

const {
  SHELL_HOST,
  SHELL_PORT_MIN,
  SHELL_PORT_MAX,
  SHELL_PORTS,
  listenOnFirstFreePort,
} = portScan

const { startupFailureDetail } = startupFailure

// ---- generic socket helpers (no mocks; every one of these touches a real
// ---- OS socket) -------------------------------------------------------

function occupy(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

function release(server) {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

// Attempts a real client connection; resolves true only if something is
// really accepting connections at host:port.
function probeConnect(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

// Runs fn(), uniformly capturing either a synchronous throw or an async
// promise rejection -- the contract does not say which shape the module
// uses, so the test must not assume one.
async function captureRejection(fn) {
  try {
    const value = await fn()
    return { rejected: false, value }
  } catch (error) {
    return { rejected: true, error }
  }
}

// ---- ephemeral port blocks: ports this file owns outright ---------------
//
// Binding port 0 asks the OS for a port nothing else currently holds. We
// take `size` of them AND KEEP HOLDING THEM, so between the moment the block
// is chosen and the moment a case runs, no other process can take one: they
// are not merely "free right now", they are ours. A case then releases only
// the slots it wants the scan to be able to take, which is what makes the
// expected answer exact instead of hopeful.
//
// Sorted ascending so that "the first entry in the list" and "the lowest
// port in the block" are the same port -- that is the shape the real range
// has (P1 asserts it), so a case written against this block is making the
// same claim the product relies on.

async function borrowBlock(t, size) {
  const holders = []
  for (let index = 0; index < size; index += 1) {
    holders.push(await occupy(SHELL_HOST, 0))
  }
  const slots = holders
    .map((holder) => ({ port: holder.address().port, holder }))
    .sort((left, right) => left.port - right.port)

  t.after(() => Promise.all(slots.map((slot) => release(slot.holder))))

  return {
    slots,
    ports: Object.freeze(slots.map((slot) => slot.port)),
    // Hand these port numbers back to the OS so the scan can take them.
    free: (...indexes) =>
      Promise.all(indexes.map((index) => release(slots[index].holder))),
    freeAll: () => Promise.all(slots.map((slot) => release(slot.holder))),
  }
}

// ---- contract item 1 (range) --------------------------------------------

test('contract #1: the declared scan range is the inclusive 4601-4609 set', () => {
  assert.equal(SHELL_HOST, '127.0.0.1')
  assert.equal(SHELL_PORT_MIN, 4601)
  assert.equal(SHELL_PORT_MAX, 4609)
  assert.deepEqual(SHELL_PORTS, [4601, 4602, 4603, 4604, 4605, 4606, 4607, 4608, 4609])

  // The ordering and shape are load-bearing, not incidental: "lowest free
  // port" is only true of a scan that walks its list in order because that
  // list is ascending and contiguous. Assert those properties outright so
  // the second half of the claim (contract #3) has something to stand on.
  assert.equal(SHELL_PORTS.length, SHELL_PORT_MAX - SHELL_PORT_MIN + 1)
  assert.equal(SHELL_PORTS[0], SHELL_PORT_MIN)
  assert.equal(SHELL_PORTS[SHELL_PORTS.length - 1], SHELL_PORT_MAX)
  assert.equal(new Set(SHELL_PORTS).size, SHELL_PORTS.length, 'no port may appear twice')
  for (let index = 1; index < SHELL_PORTS.length; index += 1) {
    assert.equal(
      SHELL_PORTS[index],
      SHELL_PORTS[index - 1] + 1,
      'the declared range must be ascending and contiguous',
    )
  }
  assert.equal(Object.isFrozen(SHELL_PORTS), true, 'a caller must not be able to edit the declared range')
})

// ---- contract item 2 -----------------------------------------------------

test('contract #2: with the whole list free, it selects and really binds the first entry', async (t) => {
  const block = await borrowBlock(t, 4)
  await block.freeAll()

  const server = net.createServer()
  const second = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[0])
    assert.equal(server.listening, true)
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.equal(address.address, SHELL_HOST)
    assert.equal(address.port, block.ports[0])

    assert.equal(
      await probeConnect(SHELL_HOST, block.ports[0]),
      true,
      'a real client must be able to reach the port the scan says it bound',
    )

    // It must take ONE port, not several. Proving that by rescanning the
    // same list with a second server: if the first scan had quietly bound
    // more of the list, this would not come back with the second entry.
    const next = await listenOnFirstFreePort(second, block.ports, SHELL_HOST)
    assert.equal(next, block.ports[1], 'the scan must consume exactly one port from the list')
  } finally {
    await release(server)
    await release(second)
  }
})

// ---- contract item 3 (direct case + general "lowest free" claim) --------

test('contract #3: when the first entry is already held, it selects the second', async (t) => {
  const block = await borrowBlock(t, 4)
  await block.free(1, 2, 3) // slot 0 stays held by us

  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[1])
    assert.equal(server.address().port, block.ports[1])
  } finally {
    await release(server)
  }
})

test('contract #3 (general case): it selects the lowest free port, not merely the next one after the last held port', async (t) => {
  // Slots 0, 2 and 4 are held and 1 and 3 are free -- a scan that just
  // walked past the highest held entry, or resumed after the last hold,
  // would answer slot 3 (or fail). The lowest free port here is slot 1.
  const block = await borrowBlock(t, 5)
  await block.free(1, 3)

  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(
      port,
      block.ports[1],
      'the scan must return the lowest free entry, not the first one after the last held entry',
    )
  } finally {
    await release(server)
  }
})

// ---- contract item 4 -------------------------------------------------

test('contract #4: when every entry but the last is held, it selects the last', async (t) => {
  const block = await borrowBlock(t, 5)
  await block.free(block.ports.length - 1)

  const server = net.createServer()
  try {
    const port = await listenOnFirstFreePort(server, block.ports, SHELL_HOST)
    assert.equal(port, block.ports[block.ports.length - 1])
  } finally {
    await release(server)
  }
})

// ---- contract item 5 -------------------------------------------------

test('contract #5: when every port in the range is held, it fails with a distinguishable typed error and leaves no server listening', async (t) => {
  // Nothing is released: this file holds every entry in the list for the
  // whole case, so exhaustion is guaranteed rather than hoped for.
  const block = await borrowBlock(t, 9)

  const server = net.createServer()
  try {
    const outcome = await captureRejection(() => listenOnFirstFreePort(server, block.ports, SHELL_HOST))

    assert.equal(outcome.rejected, true, 'exhausting the whole range must fail, not silently succeed')
    const error = outcome.error
    assert.ok(error instanceof Error, 'the failure must be a real Error, not a plain value')

    // "distinguishable ... NOT a raw EADDRINUSE": the error must carry its
    // own identity, and that identity must not just be the underlying
    // socket error passed straight through.
    assert.notEqual(error.code, 'EADDRINUSE', 'exhaustion must not surface as a raw EADDRINUSE')
    const identity = String(error.code || error.name || '')
    assert.notEqual(identity, '', 'the error must expose a distinguishing code or name, not just a message')
    assert.notEqual(identity, 'Error', 'the error must be typed beyond the generic Error name')

    // "identifying range exhaustion": some part of the error's identity or
    // message must actually say so, in the caller's terms, not just "busy".
    const haystack = `${identity} ${error.message || ''}`.toLowerCase()
    assert.match(
      haystack,
      /exhaust|no.*(free|available)|all.*(occupied|held|busy|use)|range/,
      'the error must identify range exhaustion in some recognisable way',
    )

    // The report must account for every port it was asked to try, so a
    // person reading the startup failure sees the whole attempt.
    assert.deepEqual([...error.ports], [...block.ports], 'the error must name every port it attempted')

    assert.equal(server.listening, false, 'the server passed in must be left unbound after exhaustion')
  } finally {
    await release(server)
  }
})

// ---- contract item 6 -------------------------------------------------

test('contract #6: a request to bind a host other than 127.0.0.1 is rejected, not honoured', async (t) => {
  const foreignHost = '127.0.0.2' // real, distinct loopback address; safe, no external exposure
  const block = await borrowBlock(t, 1)
  await block.freeAll()
  const candidatePort = block.ports[0]

  const server = net.createServer()
  try {
    const outcome = await captureRejection(() => listenOnFirstFreePort(server, [candidatePort], foreignHost))

    assert.equal(outcome.rejected, true, 'a non-127.0.0.1 host request must be rejected, not silently bound')
    assert.equal(server.listening, false, 'no bind may be left standing after a rejected host request')

    // The server handed in is the only thing the module could have bound, so
    // an unbound server is proof no fallback bind happened anywhere -- a
    // stronger and completely machine-independent statement than probing a
    // port number and hoping nobody else is on it.
    assert.equal(server.address(), null, 'a rejected host request must not leave the server bound to anything')

    assert.equal(
      await probeConnect(foreignHost, candidatePort),
      false,
      'the foreign host must never actually end up with something listening on it',
    )
  } finally {
    await release(server)
  }
})

// ---- contract item 7 -------------------------------------------------
//
// REFORMULATED (R1526). What used to live here was a single case named
//
//   contract #7: a real listen error that is not "address in use" propagates unchanged
//
// which manufactured a REAL, OS-generated EACCES by binding a port from
// Windows' excluded-port table and then asserted that listenOnFirstFreePort
// must reject with error.code === 'EACCES'. It failed from the day it was
// written and was carried in tools/test-baseline.json as a known failure.
//
// It was adjudicated by a lane that wrote neither side -- ruling with full
// measurements at reports/lanes/portscan-adjudication.md in the engine
// checkout, cited by commit ab07f25 -- and the verdict was that THE TEST WAS
// WRONG AND THE CODE IS RIGHT. On Windows an EACCES from a plain listen() on
// an unprivileged loopback port is, in practice, a per-port OS exclusion
// (Hyper-V/WinNAT reserves shifting blocks; `netsh interface ipv4 show
// excludedportrange protocol=tcp` lists them), which is mechanically the same
// signal as EADDRINUSE: this one candidate is not available, take the next.
// Propagating it raw would strand a person whose 4601 happens to land in a
// reserved block while eight other candidates sit free -- the exact class of
// failure cef9da1 replaced the fixed-port bind to end. The clause had picked
// the one code on this platform for which "never retry" is backwards.
//
// So the clause is NOT deleted and NOT weakened. It is re-pointed at what it
// was actually protecting, and it now covers strictly more than before:
//
//   old "must not be swallowed into success"  -> asserted by #7a, #7a2, #7c
//   old "propagates unchanged, not remapped"  -> #7a and #7a2, against errors
//                                                that really are outside the
//                                                retryable set, plus proof the
//                                                scan did not advance past
//                                                them onto a bindable port
//   old "not reworded into 'port busy'"       -> #7c, raised from a regex over
//                                                an internal error message to
//                                                the actual sentence
//                                                shell/startup-failure-message.cjs
//                                                puts in front of a person
//   NEW  the OS code is not destroyed         -> #7c (error.cause.code AND
//                                                error.failures[])
//   NEW  the retry the ruling defends really  -> #7b (an OS-excluded port is
//        keeps the app launchable                 advanced past and the next
//                                                 free candidate really binds)
//
// #7a and #7a2 run on any host. #7b and #7c need an OS-excluded port to
// exist and skip loudly when the host has none -- the same honesty the old
// clause had, kept deliberately: green on a host with no exclusion proves
// nothing about this behaviour and must not be read as if it did.

// Finds a TCP port on this Windows host that the OS will really refuse for a
// reason other than "address in use" -- Windows periodically reserves
// blocks of ports for Hyper-V/WinNAT, and binding one of those yields a
// genuine, OS-generated EACCES (or similar) with no privilege elevation and
// no dependency on any other test's state. This is a real socket outcome,
// discovered from the live OS, not a simulated one.
function listExcludedTcpPorts() {
  let output
  try {
    output = execFileSync(
      'netsh',
      ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
      { encoding: 'utf8' },
    )
  } catch {
    return []
  }
  return excludedTcpPortCandidates(output)
}

// Hyper-V/WinNAT normally reserves ranges, not just singleton ports. Probe a
// bounded representative from each valid range, including its end; never
// change the machine's exclusions to manufacture a passing native fixture.
function excludedTcpPortCandidates(output) {
  const ports = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*(?:\*)?\s*$/)
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2])
    if (start < 1 || end > 65535 || start > end) continue
    let first = start
    while (first <= end && SHELL_PORTS.includes(first)) first++
    if (first <= end) ports.add(first)
    if (!SHELL_PORTS.includes(end)) ports.add(end)
  }
  return [...ports]
}

test('the native excluded-port probe considers real reservation ranges, not only singleton rows', () => {
  assert.deepEqual(excludedTcpPortCandidates('Start Port End Port\n 12000 12099\n 13000 13000 *\n'),
    [12000, 12099, 13000])
})

test('the native excluded-port probe ignores invalid rows, duplicate candidates and the running shell ports', () => {
  assert.deepEqual(excludedTcpPortCandidates(`0 20\n70000 70001\n40 20\n20 30 junk\n12000 12000\n12000 12000\n${SHELL_PORTS[0]} ${SHELL_PORTS[0]}\n`),
    [12000])
})

function probeRealListenError(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => resolve(error.code || null))
    server.once('listening', () => server.close(() => resolve(null)))
    server.listen(port, host)
  })
}

async function findNonEaddrinuseErrorPort(host) {
  for (const port of listExcludedTcpPorts()) {
    const code = await probeRealListenError(host, port)
    if (code && code !== 'EADDRINUSE') return { port, code }
  }
  return null
}

// A port number outside the TCP range. net.Server#listen itself refuses it
// with ERR_SOCKET_BAD_PORT, synchronously -- which is why the module wraps
// its server.listen() call in a try/catch at all. Nothing is faked: this is
// the real net.Server refusing a real call, and ERR_SOCKET_BAD_PORT is not in
// the module's retryable set.
const PORT_THE_SOCKET_LAYER_REFUSES = 70000

test('contract #7a: a non-retryable listen error propagates unchanged and stops the scan dead', async (t) => {
  // Two ports that this file first took from the OS and then handed back, so
  // "the scan could have bound one of these" is established rather than
  // hoped: if the module treated the refusal as a per-port condition and
  // advanced, this call would RESOLVE with a bound port instead of rejecting.
  const block = await borrowBlock(t, 2)
  await block.freeAll()
  const [firstBehind, secondBehind] = block.ports

  const server = net.createServer()
  try {
    const outcome = await captureRejection(() => listenOnFirstFreePort(
      server,
      [PORT_THE_SOCKET_LAYER_REFUSES, firstBehind, secondBehind],
      SHELL_HOST,
    ))

    assert.equal(
      outcome.rejected,
      true,
      'a listen failure the module does not classify as retryable must not be swallowed into success',
    )
    assert.equal(
      outcome.error.code,
      'ERR_SOCKET_BAD_PORT',
      'a non-retryable listen error must propagate with its original code unchanged, not be remapped',
    )
    assert.notEqual(
      outcome.error.code,
      'SHELL_PORT_RANGE_EXHAUSTED',
      'a non-retryable error must not be rewritten into the exhaustion signal, which means something else entirely',
    )
    // Getting the original code back rather than a bound port IS the proof
    // that the scan stopped at the first entry: the two candidates behind it
    // were bindable, so any retry would have ended in success, and a walk
    // that ran out would have ended in SHELL_PORT_RANGE_EXHAUSTED. Neither
    // happened.
    assert.equal(server.listening, false, 'a rejected scan must leave nothing listening')

    const message = String(outcome.error.message || '').toLowerCase()
    assert.doesNotMatch(
      message,
      /port.*(busy|exhaust)/,
      'an unrelated listen failure must not be reworded into a "port busy" style message',
    )
  } finally {
    await release(server)
  }
})

test('contract #7a2: an OS errno outside the retryable set is thrown on the first candidate, unwrapped', async () => {
  // METHOD, STATED PLAINLY BECAUSE IT IS THE ONE EXCEPTION IN THIS FILE: the
  // SERVER here is a double. It has to be. The module fixes the host at
  // 127.0.0.1 and takes valid unprivileged port integers, and the only live
  // non-EADDRINUSE errno that domain can produce on Windows is EACCES -- the
  // discovery method in #7b/#7c below goes looking and comes back with
  // EACCES every time, which is precisely how the old clause went wrong. So
  // the third-category code is injected. The module under test is not faked;
  // it is driven through its real retry classification, and the double emits
  // a real Error carrying a real errno through the same 'error' event a
  // net.Server uses. What this adds over #7a is the errno shape and a direct
  // count of how many candidates were attempted.
  class ServerThatRefusesWith extends EventEmitter {
    constructor(code) {
      super()
      this.refusalCode = code
      this.listening = false
      this.attempts = []
    }

    listen(port, host) {
      this.attempts.push(port)
      const error = new Error(`listen ${this.refusalCode}: ${host}:${port}`)
      error.code = this.refusalCode
      queueMicrotask(() => this.emit('error', error))
    }

    close(callback) {
      if (callback) callback()
    }
  }

  const server = new ServerThatRefusesWith('EINVAL')
  const outcome = await captureRejection(
    () => listenOnFirstFreePort(server, [...SHELL_PORTS], SHELL_HOST),
  )

  assert.equal(outcome.rejected, true, 'a non-retryable errno must not be swallowed into success')
  assert.equal(
    outcome.error.code,
    'EINVAL',
    'a non-retryable errno must propagate with its original code unchanged, not be remapped',
  )
  assert.equal(
    outcome.error.cause,
    undefined,
    'a non-retryable errno must come out unwrapped -- the caller should get the OS error itself, not a synthesized one carrying it',
  )
  assert.deepEqual(
    server.attempts,
    [SHELL_PORTS[0]],
    'a non-retryable errno must stop the scan on the first candidate, not walk the whole declared range',
  )
})

test('contract #7b: an OS-excluded port is advanced past, and the next free candidate really binds', async (t) => {
  const found = await findNonEaddrinuseErrorPort(SHELL_HOST)
  if (!found) {
    t.skip('no OS-reserved TCP port discovered on this host to force a genuine non-EADDRINUSE listen failure')
    return
  }
  if (found.code !== 'EACCES') {
    // Any third code is #7a's claim, not this one: the module is supposed to
    // propagate it, not retry it. Say so instead of quietly passing.
    t.skip(`the OS exclusion table produced ${found.code}, not EACCES; retry is only correct for EACCES (see the ruling above)`)
    return
  }

  // THE POINT OF THE RETRY, ASSERTED. A person whose first candidate falls in
  // a Hyper-V/WinNAT reserved block must still end up with a running app.
  const block = await borrowBlock(t, 1)
  await block.freeAll()
  const [freeCandidate] = block.ports

  const server = net.createServer()
  try {
    const bound = await listenOnFirstFreePort(server, [found.port, freeCandidate], SHELL_HOST)
    assert.equal(bound, freeCandidate, 'the scan must advance past an OS-excluded port to the next candidate')
    assert.equal(server.address().port, freeCandidate, 'and must really be bound to it, not merely report it')
    assert.equal(
      await probeConnect(SHELL_HOST, freeCandidate),
      true,
      'the port the scan chose must really be accepting connections',
    )
  } finally {
    await release(server)
  }
})

test('contract #7c: with every candidate OS-excluded, the real code survives and nobody is told the ports are busy', async (t) => {
  const found = await findNonEaddrinuseErrorPort(SHELL_HOST)
  if (!found) {
    t.skip('no OS-reserved TCP port discovered on this host to force a genuine non-EADDRINUSE listen failure')
    return
  }
  const { port: excludedPort, code: osCode } = found
  assert.notEqual(osCode, 'EADDRINUSE') // sanity on the probe itself

  const server = net.createServer()
  try {
    const outcome = await captureRejection(() => listenOnFirstFreePort(server, [excludedPort], SHELL_HOST))

    assert.equal(outcome.rejected, true, `a real ${osCode} listen failure must not be swallowed into success`)
    const error = outcome.error
    assert.equal(
      error.code,
      'SHELL_PORT_RANGE_EXHAUSTED',
      'every candidate having failed is exhaustion, and contract #5 requires that be one distinguishable signal',
    )
    assert.notEqual(error.code, 'EADDRINUSE')

    // THE ORIGINAL CODE MUST NOT BE DESTROYED. This is what the old clause
    // was reaching for when it asserted on error.code; the implementation
    // keeps it in two places and both are pinned here, so a change that
    // dropped either would go red.
    assert.equal(
      error.cause?.code,
      osCode,
      'the OS error must survive at error.cause; demoting it is acceptable, discarding it is not',
    )
    assert.ok(Array.isArray(error.failures), 'the exhaustion error must record what each candidate did')
    assert.equal(error.failures.length, 1)
    assert.equal(error.failures[0].port, excludedPort)
    assert.equal(
      error.failures[0].code,
      osCode,
      'the per-port record must carry the real OS code, not the exhaustion code',
    )

    // AND IT MUST REACH THE PERSON. shell/main.cjs renders a failed scan
    // through startupFailureDetail, so that sentence -- not the internal
    // message -- is where "swallowed into port busy" would actually happen.
    //
    // Asserted against the HEADLINE only, not the whole string. Measured while
    // writing this (R1526): startupFailureDetail appends the raw OS message
    // after a blank line as "Underlying error: listen EACCES: ... :8032", and
    // that tail carries the code and the port no matter what the sentence
    // above it says. Blanking the OS-refusal branch outright still left both
    // strings present, so a whole-string match here would have been a hole
    // wearing the shape of a check. The tail is a diagnostic; the headline is
    // what a person reads.
    const shown = startupFailureDetail(error, { min: SHELL_PORT_MIN, max: SHELL_PORT_MAX })
    const headline = shown.split('\n\nUnderlying error:')[0]
    assert.notEqual(headline, shown, 'the underlying-error tail was not found, so the split below is not isolating the headline')
    assert.match(headline, new RegExp(osCode), 'the sentence a person is shown must name the real OS code')
    assert.match(headline, new RegExp(String(excludedPort)), 'and the port it happened on')
    assert.doesNotMatch(
      shown.toLowerCase(),
      /in use|busy/,
      'an OS refusal must not be reworded into "the ports are in use" -- that sends the person hunting for a program that is not there',
    )

    assert.equal(server.listening, false, 'a failed scan must leave nothing listening')
  } finally {
    await release(server)
  }
})

// ---- contract item 8 -------------------------------------------------

test('contract #8: the module carries no Electron dependency and runs under bare Node', () => {
  // If port-scan.cjs required Electron and that failed, the top-of-file
  // `import portScan from '../../shell/port-scan.cjs'` would already have
  // thrown before any test in this file could run at all -- so every test
  // above having run is itself part of this evidence.
  assert.equal(typeof process.versions.electron, 'undefined', 'this whole suite must run outside any Electron runtime')

  const require = createRequire(import.meta.url)
  require('../../shell/port-scan.cjs') // idempotent; populates require.cache under this loader
  const pulledInElectron = Object.keys(require.cache).some((key) => /[\\/]electron(?:[\\/]|$)/i.test(key))
  assert.equal(pulledInElectron, false, 'loading the module must not pull an electron package into the module graph')

  assert.equal(typeof listenOnFirstFreePort, 'function')
})

// ---- contract items 9 and 10: the injected list must not be able to
// ---- quietly become the product's real behaviour ----------------------

test('contract #9: called with no port list, the scan uses the declared range and nothing else', async () => {
  // The one case that deliberately touches the real 4601-4609 range -- but
  // it cannot be broken by what else holds those ports, because BOTH
  // outcomes are accounted for and both pin the same fact:
  //
  //   range busy    -> it must give up naming exactly the declared range
  //   range usable  -> whatever it took must be a member of that range
  //
  // So a default that quietly drifted to some other range fails here on an
  // idle machine and on a busy one alike, which is the property the rest of
  // this file gives up by injecting its own list.
  const server = net.createServer()
  try {
    const outcome = await captureRejection(() => listenOnFirstFreePort(server))

    if (outcome.rejected) {
      assert.equal(
        outcome.error.code,
        'SHELL_PORT_RANGE_EXHAUSTED',
        'the default scan may only fail by exhausting the declared range',
      )
      assert.deepEqual(
        [...outcome.error.ports],
        [...SHELL_PORTS],
        'the default scan must attempt exactly the declared range',
      )
    } else {
      assert.ok(
        SHELL_PORTS.includes(outcome.value),
        `the default scan bound ${outcome.value}, which is outside the declared ${SHELL_PORT_MIN}-${SHELL_PORT_MAX} range`,
      )
      assert.equal(server.address().address, SHELL_HOST, 'the default host must be the declared loopback host')
      assert.equal(server.address().port, outcome.value)
    }
  } finally {
    await release(server)
  }
})

test('contract #10: the shell wires the declared range into the scan, so an injected list cannot become the product behaviour', async () => {
  // Every other case here injects its own port list. That is safe only while
  // the SHIPPING call site still passes the declared range -- otherwise this
  // suite would go on passing while the product scanned something else
  // entirely. This case reads the real call site and pins it.
  const source = await readFile(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

  const callSites = source.match(/listenOnFirstFreePort\(/g) || []
  assert.equal(callSites.length, 1, 'the shell must have exactly one port-scan call site to pin')

  assert.match(
    source,
    /=\s*require\(['"]\.\/port-scan\.cjs['"]\)/,
    'the shell must take its port constants from the port-scan module',
  )
  assert.match(
    source,
    /const\s+ports\s*=\s*preferredPortFirst\(\s*SHELL_PORTS\s*,/,
    'the scanned list must be derived from the exported SHELL_PORTS, not a list the shell invents',
  )
  assert.match(
    source,
    /listenOnFirstFreePort\(\s*server\s*,\s*ports\s*,\s*SHELL_HOST\s*\)/,
    'the shell must scan that derived list on the exported SHELL_HOST',
  )
})
