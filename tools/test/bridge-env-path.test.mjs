import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  configuredBaseUrl,
  resetBridgeSession,
} from '../../src/mission-bridge.js'

const require = createRequire(import.meta.url)
const {
  PROOF_ENV,
  envProofRequested,
  resolveEnvBridgeProof,
  recordEnvProofRefusal,
  REFUSAL_RECORD_NAME,
} = require('../../shell/bridge-env-path.cjs')
const { readBridgeProof } = require('../../shell/bridge-proof.cjs')

const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

// Exactly 43 base64url characters, the shape shell/bridge-proof.cjs enforces.
const PROOF_TOKEN = 'bridge-env-path-fixture-bootstrap-proof-001'.padEnd(43, '0')
const PROOF_FILE = 'C:\\fixture\\proof.json'
const envWith = () => ({ [PROOF_ENV]: PROOF_FILE })
const readsProofFile = () => JSON.stringify({ token: PROOF_TOKEN })

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  resetBridgeSession()
})

/* ---- The two control arms. Neither is meaningful without the other: the fix
   is not "the env path is gone", it is "the env path is exactly as available as
   a developer, and no more". ---- */

test('CONTROL ARM 1 -- an unpackaged build still honours MC_BRIDGE_PROOF_FILE', () => {
  const resolved = resolveEnvBridgeProof({
    env: envWith(),
    isPackaged: false,
    readBridgeProof,
    readFileSync: readsProofFile,
  })

  assert.equal(resolved.ok, true, 'a developer must keep the path they use to debug an external bridge')
  assert.equal(resolved.proof, PROOF_TOKEN, 'the developer must get the exact token from the file they named')
  assert.equal(resolved.envProofRefused, false)
  assert.equal(resolved.envProofRequested, true)
})

test('CONTROL ARM 2 -- a packaged build refuses MC_BRIDGE_PROOF_FILE and names the variable', () => {
  const resolved = resolveEnvBridgeProof({
    env: envWith(),
    isPackaged: true,
    readBridgeProof,
    readFileSync: readsProofFile,
  })

  assert.equal(resolved.ok, false, 'a packaged install has no legitimate use for an externally started bridge')
  assert.equal(resolved.envProofRefused, true)
  assert.equal(resolved.envProofRequested, true)
  assert.match(resolved.reason, /MC_BRIDGE_PROOF_FILE/, 'a customer must be able to find out which variable did this')
  assert.match(resolved.reason, /tampered/i, 'the message must say what it means when the customer did not set it')
})

test('a packaged build with no MC_BRIDGE_PROOF_FILE set is not reported as tampered with', () => {
  const resolved = resolveEnvBridgeProof({
    env: {},
    isPackaged: true,
    readBridgeProof,
    readFileSync: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
  })

  assert.equal(resolved.ok, false, 'no variable means no env proof, exactly as before')
  assert.equal(resolved.envProofRequested, false)
  assert.equal(resolved.envProofRefused, false, 'the clean customer launch must not raise a tamper diagnostic')
})

test('an unstated packaging condition fails closed and refuses the env proof', () => {
  // "I could not tell whether this is packaged" must not grant the developer
  // path. The convenient default and the safe default are opposites here.
  for (const isPackaged of [undefined, null, 'false', 0]) {
    const resolved = resolveEnvBridgeProof({
      env: envWith(),
      isPackaged,
      readBridgeProof,
      readFileSync: readsProofFile,
    })
    assert.equal(resolved.ok, false, `isPackaged=${JSON.stringify(isPackaged)} must not open the developer path`)
    assert.equal(resolved.envProofRefused, true)
  }
})

test('a refusal never leaks proof material', () => {
  const resolved = resolveEnvBridgeProof({
    env: envWith(),
    isPackaged: true,
    readBridgeProof,
    readFileSync: readsProofFile,
  })

  const serialized = JSON.stringify(resolved)
  assert.equal(serialized.includes(PROOF_TOKEN), false, 'the refusal must not carry the token it declined to use')
  assert.equal(Object.hasOwn(resolved, 'proof'), false)
})

test('envProofRequested reads only the variable and never the filesystem', () => {
  assert.equal(envProofRequested({ env: envWith() }), true)
  assert.equal(envProofRequested({ env: { [PROOF_ENV]: '   ' } }), false, 'whitespace is not a configured path')
  assert.equal(envProofRequested({ env: {} }), false)
  assert.equal(envProofRequested({ env: undefined }), false)
})

/* ---- The diagnostic. A compromised launch must not look identical to a normal
   one, and a console line cannot carry that: shell build diagnostics are
   stripped from the shipped app (see the top of shell/main.cjs). ---- */

test('a refused packaged launch leaves a durable record, and a later clean launch clears it', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bridge-env-path-'))
  try {
    const file = path.join(directory, REFUSAL_RECORD_NAME)

    const written = recordEnvProofRefusal({ directory, refused: true, fs, path })
    assert.equal(written.written, true)
    assert.equal(existsSync(file), true, 'support must have something durable to read')

    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.status, 'refused')
    assert.equal(record.variable, PROOF_ENV, 'the record must name the variable')
    assert.match(record.reason, /packaged build/)
    assert.ok(Number.isFinite(Date.parse(record.at)), 'the record must say when')

    const cleared = recordEnvProofRefusal({ directory, refused: false, fs, path })
    assert.equal(cleared.cleared, true)
    assert.equal(existsSync(file), false, 'a stale claim must not outlive the launch it described')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the diagnostic never throws, so it cannot crash the boot it is diagnosing', () => {
  const exploding = {
    writeFileSync() { throw new Error('disk full') },
    rmSync() { throw new Error('locked') },
  }
  assert.deepEqual(
    recordEnvProofRefusal({ directory: 'C:\\nope', refused: true, fs: exploding, path }),
    { written: false, cleared: false, file: path.join('C:\\nope', REFUSAL_RECORD_NAME) },
  )
  assert.doesNotThrow(() => recordEnvProofRefusal({ directory: 'C:\\nope', refused: false, fs: exploding, path }))
  assert.deepEqual(
    recordEnvProofRefusal({
      directory: 'C:\\nope',
      refused: true,
      fs: exploding,
      path: { join() { throw new TypeError('invalid path') } },
    }),
    { written: false, cleared: false },
    'constructing the diagnostic path must not escape the no-throw boundary',
  )
  assert.doesNotThrow(() => recordEnvProofRefusal({}))
})

/* ---- The shipping call site. The module above can be perfect and the product
   still exposed if main.cjs reads the env proof its own way, so pin the wiring
   as text -- the house pattern for behaviour that only exists inside Electron
   (see shell-port-scan-contract #10, agent-history-channel). ---- */

test('the shell produces its env proof only through the packaged fence', () => {
  assert.equal(
    /\breadBridgeProof\s*\(/.test(MAIN),
    false,
    'main.cjs must not call readBridgeProof directly -- that is the unfenced path this fix removed',
  )

  const declarations = MAIN.match(/const\s+bridgeProof\s*=\s*resolveEnvBridgeProof\(\{/g) || []
  assert.equal(declarations.length, 1, 'there must be exactly one place an env-derived proof is produced')

  const start = MAIN.indexOf('const bridgeProof = resolveEnvBridgeProof({')
  const declaration = MAIN.slice(start, MAIN.indexOf('})', start))
  assert.match(declaration, /isPackaged:\s*app\.isPackaged/, 'the fence must read the real Electron packaging flag')
  assert.match(declaration, /readBridgeProof,/, 'the real reader must still be the one used when the fence allows it')

  const refusals = MAIN.match(/recordEnvProofRefusal\(\{/g) || []
  assert.equal(refusals.length, 1, 'a refused launch must be recorded exactly once')
})

test('the fence module loads without pulling electron into the module graph', () => {
  assert.equal(typeof process.versions.electron, 'undefined', 'this suite must run under bare node')
  require('../../shell/bridge-env-path.cjs')
  const pulledInElectron = Object.keys(require.cache).some(key => /[\\/]electron(?:[\\/]|$)/i.test(key))
  assert.equal(pulledInElectron, false, 'the decision must stay testable without Electron')
})

/* ---- What the two arms actually cost or buy, downstream, in the renderer.
   These fixtures stub fetch and bind no sockets, so a busy machine cannot
   change the answer. They pin the CONSEQUENCE of each source value; the test
   above pins that a packaged shell can no longer produce the dangerous one. ---- */

const shellReporting = endpoint => ({
  /* The hostname is load-bearing since the public-origin gate (mission-bridge's
     pageMayReachLoopback): a page that is not on loopback never reaches for a
     bridge at all, whatever the shell reports. The desktop shell serves the
     renderer from http://127.0.0.1:<port> (shell/main.cjs, shellOrigin), so
     THAT is the context these desktop-path tests describe; without it the gate
     correctly refuses BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN and the test measures
     the gate instead of the path it meant to. */
  location: { search: '', hostname: '127.0.0.1' },
  mcShell: {
    getBridgeProof: async () => ({ ok: true, proof: PROOF_TOKEN }),
    getBridgeEndpoint: async () => endpoint,
  },
})

test("source 'env' scans the well-known range and binds a squatter on the lowest port", async () => {
  // This is the exposure, demonstrated rather than asserted about: with the
  // developer path active the renderer trusts whoever answers first, and a
  // squatter that took 4610 before the real layer started is that responder.
  globalThis.window = shellReporting({ ok: true, source: 'env' })
  const fetched = []
  globalThis.fetch = async url => {
    const href = String(url)
    fetched.push(href)
    if (href === 'http://127.0.0.1:4610/v1/runtime') {
      // A squatter only has to be well-formed, and it can claim any port.
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            baseUrl: 'http://127.0.0.1:4610',
            port: 4610,
            startedAt: '2026-08-11T08:00:00.000Z',
            pid: 43210,
          }
        },
      }
    }
    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  }

  assert.deepEqual(
    await configuredBaseUrl(),
    { ok: true, baseUrl: 'http://127.0.0.1:4610' },
    "the developer path binds the first structurally-valid responder -- that is the behaviour a packaged build must never reach",
  )
  assert.deepEqual(fetched, ['http://127.0.0.1:4610/v1/runtime'])
})

test("source 'supervised' pins the shell's own layer and never scans, even with a squatter below it", async () => {
  // The same squatter on 4610, and the install's real layer on 4611. This is
  // what a packaged build now always gets, because it can no longer report
  // 'env'. The squatter is never contacted, so it never receives this boot's
  // bootstrap proof and has nothing to replay.
  globalThis.window = shellReporting({
    ok: true,
    source: 'supervised',
    baseUrl: 'http://127.0.0.1:4611',
    pid: 43210,
    envProofRefused: true,
  })
  const fetched = []
  globalThis.fetch = async url => {
    const href = String(url)
    fetched.push(href)
    if (href === 'http://127.0.0.1:4611/v1/runtime') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            baseUrl: 'http://127.0.0.1:4611',
            port: 4611,
            startedAt: '2026-08-11T08:00:00.000Z',
            pid: 43210,
          }
        },
      }
    }
    throw new Error(`must not fetch ${href}`)
  }

  assert.deepEqual(await configuredBaseUrl(), { ok: true, baseUrl: 'http://127.0.0.1:4611' })
  assert.deepEqual(fetched, ['http://127.0.0.1:4611/v1/runtime'])
  assert.equal(fetched.some(href => href.includes(':4610')), false, 'the squatter must never be contacted')
})
