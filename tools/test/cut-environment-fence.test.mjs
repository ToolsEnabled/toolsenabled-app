// A CUT MUST NOT BE ABLE TO REACH THE OWNER'S LIVE INSTALLATION.
//
// MEASURED 2026-09-17: the shell of every agent circle on this box arrives
// carrying TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH already pointing
// into the owner's live profile (...\ToolsEnabled-Live\capability\...). The cut
// overwrote exactly those two and inherited the other 29 capability path
// overrides untouched. tools/test-ratchet.mjs records what that costs: on
// 2026-09-10 a measurement engine started from an agent shell wrote four real
// entries into the LIVE ledger.
//
// The authority for "which variables" is shell/capability-path-environment.cjs,
// whose own regression test keeps it in step with capability/src. A hand list
// here would go stale the first time a persistence seam is added.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

import {
  assertCutEnvironmentIsolated,
  buildDistChainEnvironment,
  scrubInheritedCapabilityPaths,
} from '../release-packager/cut-release-candidate.mjs'
import { OWNED_NAMES, assertScratchFence, isInside, requiredNames } from '../lib/scratch-fence.mjs'

// Two different sets, and conflating them is how a test asserts the wrong
// thing: CAPABILITY_NAMES is what the scrub covers (the capability authority),
// NAMES is everything the fence judges (all four categories).
const { groups, names: NAMES } = requiredNames()
const CAPABILITY_NAMES = groups.find((group) => group.category === 'capability overrides').names

const LIVE = path.join('C:', 'Users', 'Someone', 'Desktop', 'joshs profile', 'ToolsEnabled-Live', 'capability')
const SCRATCH_STATE = path.join('C:', 'sc', 'state')
const SCRATCH_TEMP = path.join('C:', 'sc', 't')

/* The shell a cut is actually launched from: every fenced name pointed into the
 * live installation EXCEPT the account identity ones, which legitimately name
 * the account home and never the installation. Pointing those at the
 * installation too would be a fixture no real shell produces, and the fence
 * rightly refuses it -- that case belongs in scratch-fence.test.mjs, where it
 * is asserted directly. */
const ACCOUNT_HOME = path.join('C:', 'Users', 'Someone')
const liveEnvironment = () => Object.fromEntries(NAMES.map((name) =>
  [name, ['USERPROFILE', 'HOME'].includes(name) ? ACCOUNT_HOME : path.join(LIVE, `${name.toLowerCase()}.dat`)]))

test('every capability path override the shell knows about is scrubbed, not just the two the cut sets', () => {
  const env = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, path.join(LIVE, `${name.toLowerCase()}.dat`)]))
  const removed = scrubInheritedCapabilityPaths(env)
  // Anchored to a literal floor and to named members, not to the length of the
  // list the scrub was built from -- that compared the derivation with itself.
  assert.ok(removed.length >= 20, `the scrub must cover at least 20 overrides; got ${removed.length}`)
  for (const name of ['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_STATE_PATH']) {
    assert.ok(removed.includes(name), `the scrub must remove ${name}`)
  }
  assert.equal(removed.length, CAPABILITY_NAMES.length, 'and it covers the whole authority')
  for (const name of CAPABILITY_NAMES) assert.equal(env[name], undefined, `${name} must not survive into a cut`)
})

test('the dist-chain environment re-points the cut-owned paths into scratch and drops the rest', () => {
  const env = buildDistChainEnvironment(liveEnvironment(), { workspaceSegments: ['fixture-workspace'],
    scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP, platform: 'win32',
  })
  assert.equal(env.TOOLSENABLED_STATE_ROOT, SCRATCH_STATE)
  assert.equal(env.MC_TEST_STATE_ROOT, SCRATCH_STATE)
  assert.equal(env.TOOLSENABLED_VAULT_PATH, path.join(SCRATCH_STATE, 'vault', 'secrets.json'))
  // Everything the cut does not manage must be ABSENT rather than inherited.
  // A name the cut MANAGES is set into the scratch; a name it does not manage
  // must be absent rather than inherited. TOOLSENABLED_STATE_PATH joined the
  // managed set because it is the process-wide store where approval grants are
  // minted -- a run that left it inherited minted into the owner's live store
  // with the fence otherwise green.
  const managed = new Set(['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_STATE_PATH'])
  for (const name of CAPABILITY_NAMES) {
    if (managed.has(name)) {
      assert.ok(typeof env[name] === 'string' && isInside(SCRATCH_STATE, path.resolve(env[name])),
        `${name} must be re-pointed inside the cut scratch, not merely scrubbed`)
    } else {
      assert.equal(env[name], undefined, `${name} was inherited from the owner's installation`)
    }
  }
  assert.equal(assertCutEnvironmentIsolated(env, { scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP }), env,
    'the environment the cut actually builds satisfies its own fence')
})

test('a leaked vault path is refused by name, with its value, before the ratchet', () => {
  const env = buildDistChainEnvironment(liveEnvironment(), { workspaceSegments: ['fixture-workspace'],
    scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP, platform: 'win32',
  })
  // MUTATION: the one variable the 2026-09-10 incident turned on leaks back in.
  const leaked = { ...env, TOOLSENABLED_VAULT_PATH: path.join(LIVE, 'vault', 'secrets.json') }
  assert.throws(
    () => assertCutEnvironmentIsolated(leaked, { scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP }),
    (error) => {
      assert.match(error.message, /TOOLSENABLED_VAULT_PATH/, 'names the variable')
      assert.match(error.message, /ToolsEnabled-Live/, 'quotes the value it objected to')
      assert.match(error.message, /live installation/, 'says which boundary was crossed')
      return true
    },
  )
})

test('a path outside the scratch is refused even when it is not the live installation', () => {
  const stray = { TOOLSENABLED_AUDIT_DB: path.join('C:', 'elsewhere', 'audit.sqlite3') }
  assert.throws(
    () => assertCutEnvironmentIsolated(stray, { scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP }),
    /TOOLSENABLED_AUDIT_DB resolves outside this cut's scratch/,
    'state the cut does not own is refused wherever it lives',
  )
  assert.doesNotThrow(
    () => assertCutEnvironmentIsolated({ TOOLSENABLED_AUDIT_DB: path.join(SCRATCH_STATE, 'audit.sqlite3') },
      { scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP }),
    'a path inside the scratch is what the cut owns',
  )
})

test('both Windows profile directories are redirected into the scratch', () => {
  const env = buildDistChainEnvironment(
    { ...liveEnvironment(), APPDATA: path.join('C:', 'Users', 'Someone', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('C:', 'Users', 'Someone', 'AppData', 'Local') },
    { workspaceSegments: ['fixture-workspace'], scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP, platform: 'win32' },
  )
  // app.getPath('userData') is APPDATA on Windows, so the screen-control audit
  // sink writes through the ROAMING profile. LOCALAPPDATA alone is not enough.
  assert.equal(env.APPDATA, path.join(SCRATCH_STATE, 'Roaming'))
  assert.equal(env.LOCALAPPDATA, path.join(SCRATCH_STATE, 'LocalAppData'))
  // And the fence must actually be asked about them: Worker 89 drove this
  // function with both at the live profiles and it accepted, because neither is
  // in the derived capability-override list and neither sits under the
  // installation directory, so the live-path rule could not see them either.
  for (const [name, live] of [['APPDATA', path.join('C:', 'Users', 'Someone', 'AppData', 'Roaming')],
    ['LOCALAPPDATA', path.join('C:', 'Users', 'Someone', 'AppData', 'Local')]]) {
    assert.throws(
      () => assertCutEnvironmentIsolated({ ...env, [name]: live }, { scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP }),
      (error) => {
        assert.match(error.message, new RegExp(`${name} resolves outside this cut's scratch`), `${name} must be judged`)
        assert.ok(error.message.includes(live), `${name} must name the offending value`)
        return true
      },
    )
  }
  // And the environment the cut builds must satisfy the shared fence it calls.
  assert.doesNotThrow(() => assertScratchFence(env, { scratchRoots: [SCRATCH_STATE, SCRATCH_TEMP] }),
    'the cut cannot refuse its own environment')
})

test('POSIX leaves the Windows profile variables alone', () => {
  const env = buildDistChainEnvironment({ APPDATA: '/should/not/matter' }, { workspaceSegments: ['fixture-workspace'],
    scratchState: '/s', scratchTemp: '/t', platform: 'linux',
  })
  assert.equal(env.APPDATA, '/should/not/matter', 'there is no roaming profile to redirect on Linux')
})

test('the node loader variables are cleared for the cut children', () => {
  // NODE_PATH decides module resolution: pointed into the installation it makes
  // the dist chain load the INSTALLATION'S modules while every path-writing
  // check stays green. NODE_OPTIONS can do the same through --require preloads.
  const liveLoader = {
    NODE_PATH: path.join(LIVE, 'node_modules'),
    NODE_OPTIONS: '--require ' + path.join(LIVE, 'preload.js'),
  }
  const env = buildDistChainEnvironment({ ...liveEnvironment(), ...liveLoader }, { workspaceSegments: ['fixture-workspace'],
    scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP, platform: 'win32',
  })
  assert.equal(env.NODE_PATH, '', 'NODE_PATH must not survive into the dist chain')
  assert.equal(env.NODE_OPTIONS, '', 'NODE_OPTIONS must not survive into the dist chain')
  assert.doesNotThrow(() => assertScratchFence(env, { scratchRoots: [SCRATCH_STATE, SCRATCH_TEMP] }))

  // MUTATION-SHAPED: a live loader variable that survived must be refused, so
  // clearing is not the only thing standing between the cut and the
  // installation's modules.
  assert.throws(
    () => assertScratchFence({ ...env, NODE_PATH: liveLoader.NODE_PATH }, { scratchRoots: [SCRATCH_STATE, SCRATCH_TEMP] }),
    (error) => {
      assert.match(error.message, /NODE_PATH/)
      assert.ok(error.message.includes(liveLoader.NODE_PATH), 'names the offending value')
      return true
    },
  )
})

test('the owned set and what the cut re-points cannot disagree', () => {
  // Worker 87's fence picked its required names out of the authorities BY
  // PATTERN -- a second hand-picked list wearing derivation's clothes -- and it
  // could disagree with the re-pointing about what the run even owned. This
  // asserts the two are the same set, in both directions, so neither can drift.
  const env = buildDistChainEnvironment({}, { workspaceSegments: ['fixture-workspace'],
    scratchState: SCRATCH_STATE, scratchTemp: SCRATCH_TEMP, platform: 'win32',
  })
  const repointed = Object.keys(env).filter((name) =>
    NAMES.includes(name) && typeof env[name] === 'string' && env[name] !== ''
    && isInside(SCRATCH_STATE, path.resolve(env[name])))

  /* LITERAL, not taken from the fence. Both sides coming from the product is
   * what let another lane drop TOOLSENABLED_VAULT_PATH from its re-pointed set
   * with its QA still green: the test proved the two halves agreed. */
  const OWNED_BY_RULE = ['APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR', 'LOCALAPPDATA',
    'MC_TEST_STATE_ROOT', 'TOOLSENABLED_STATE_PATH', 'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH']
  assert.deepEqual([...OWNED_NAMES].sort(), OWNED_BY_RULE, 'the fence owns what the rule says it owns')
  assert.deepEqual(repointed.slice().sort(), OWNED_BY_RULE, 'and the cut re-points exactly that')
  const owned = new Set(OWNED_BY_RULE)
  for (const name of repointed) {
    assert.ok(owned.has(name), `${name} is re-pointed into the scratch but is not in the owned set`)
  }
  for (const name of OWNED_NAMES) {
    assert.ok(repointed.includes(name), `${name} is owned but the cut does not re-point it into the scratch`)
  }
})
