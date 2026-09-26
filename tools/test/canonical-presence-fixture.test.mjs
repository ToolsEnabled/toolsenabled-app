import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'
import {
  assertCanonicalPresenceReader,
  canonicalPresenceEnvironment,
  copyCanonicalPresenceReaders,
} from './fixtures/canonical-presence.mjs'

const SOURCE = canonicalRootForTests()
const missingSource = !existsSync(join(SOURCE, 'src', 'lib', 'agent-org.js'))
const skip = missingSource && 'Configure MC_CANONICAL_ROOT to exercise the real engine reader dependency closure.'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'canonical-presence-readers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('canonical presence fixtures rebind inherited runtime paths without changing the selected account environment', t => {
  const root = fixture(t)
  const unrelated = join(root, 'unrelated-parent-state')
  const inherited = {
    PATH: 'fixture-path', USERPROFILE: 'fixture-profile', TEMP: root,
    TOOLSENABLED_STATE_ROOT: unrelated,
    TOOLSENABLED_SETTINGS_PATH: unrelated,
    TOOLSENABLED_AGENT_PRESENCE_FILE: unrelated,
    TOOLSENABLED_AGENT_MAILBOX_DIR: unrelated,
    TOOLSENABLED_AGENT_LAUNCH_DIR: unrelated,
    TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR: unrelated,
    TOOLSENABLED_VAULT_PATH: unrelated,
  }
  assert.deepEqual(canonicalPresenceEnvironment(root, inherited), {
    PATH: 'fixture-path', USERPROFILE: 'fixture-profile', TEMP: root,
    TOOLSENABLED_STATE_ROOT: root,
    TOOLSENABLED_SETTINGS_PATH: join(root, 'state', 'settings.json'),
    TOOLSENABLED_AGENT_PRESENCE_FILE: join(root, 'state', 'agent-presence.json'),
    TOOLSENABLED_AGENT_MAILBOX_DIR: join(root, 'state', 'agent-mailbox'),
    TOOLSENABLED_AGENT_LAUNCH_DIR: join(root, 'state', 'agent-launch'),
    TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR: join(root, 'state', 'agent-useful-progress'),
    TOOLSENABLED_VAULT_PATH: join(root, 'vault', 'secrets.json'),
  })
  assert.equal(inherited.TOOLSENABLED_STATE_ROOT, unrelated, 'the caller environment is untouched')
  assert.equal(inherited.TOOLSENABLED_SETTINGS_PATH, unrelated, 'the caller settings path is untouched')
  assert.equal(existsSync(unrelated), false, 'no inherited runtime directory was created')
})

test('real canonical presence readers load with explicit fixture state and retain the exact account fence', { skip }, t => {
  const root = fixture(t)
  copyCanonicalPresenceReaders(SOURCE, root)
  assertCanonicalPresenceReader(root)
  assert.deepEqual(
    readFileSync(join(root, 'src', 'lib', 'account-profile-boundary.js')),
    readFileSync(join(SOURCE, 'src', 'lib', 'account-profile-boundary.js')),
  )
})

test('Windows fixture preflight fails at the missing account-boundary dependency before projections can hide it', {
  skip: skip || (process.platform !== 'win32' && 'Windows account-boundary branch only'),
}, t => {
  const root = fixture(t)
  copyCanonicalPresenceReaders(SOURCE, root)
  assertCanonicalPresenceReader(root)
  // Deliberately reproduce the old, incomplete disposable fixture, not a
  // modified production parser or a stubbed account boundary.
  unlinkSync(join(root, 'src', 'lib', 'account-profile-boundary.js'))
  assert.throws(() => assertCanonicalPresenceReader(root), /Cannot find module '\.\/account-profile-boundary'/)
})
