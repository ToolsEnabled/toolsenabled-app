import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Copy the real parser and its dependency closure, never the owner's records.
// runtime-state-root is no longer a builtins-only leaf: an explicit Windows
// state root also requires account-profile-boundary. Omitting that dependency
// made fixtures pass in a plain shell but fail in the isolated promotion env.
export function copyCanonicalPresenceReaders(sourceRoot, fixtureRoot) {
  for (const name of [
    'agent-org.js', 'agent-presence.js', 'request-id.js',
    'runtime-state-root.js', 'account-profile-boundary.js', 'durable-memory-file.js',
    'fleet-supervisor/state.js',
  ]) {
    const target = join(fixtureRoot, 'src', 'lib', name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(sourceRoot, 'src', 'lib', name), target)
  }
}

export function canonicalPresenceEnvironment(fixtureRoot, inherited = process.env) {
  return {
    ...inherited,
    TOOLSENABLED_STATE_ROOT: fixtureRoot,
    // The organisation validator now reads its saved limit through Settings.
    // Keep that read inside this fixture, even if the parent names an install.
    TOOLSENABLED_SETTINGS_PATH: join(fixtureRoot, 'state', 'settings.json'),
    TOOLSENABLED_AGENT_PRESENCE_FILE: join(fixtureRoot, 'state', 'agent-presence.json'),
    TOOLSENABLED_AGENT_MAILBOX_DIR: join(fixtureRoot, 'state', 'agent-mailbox'),
    TOOLSENABLED_AGENT_LAUNCH_DIR: join(fixtureRoot, 'state', 'agent-launch'),
    TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR: join(fixtureRoot, 'state', 'agent-useful-progress'),
    TOOLSENABLED_VAULT_PATH: join(fixtureRoot, 'vault', 'secrets.json'),
  }
}

// Assert the real reader loads before optional-source handling can hide a
// broken fixture. Also prove all reader defaults remain in this fixture even
// when the parent process is an installed app or an isolated release runner.
export function assertCanonicalPresenceReader(fixtureRoot) {
  const probe = spawnSync(process.execPath, ['-e', `
    const reader = require(process.argv[1]);
    process.stdout.write(JSON.stringify({
      normalizeRegistry: typeof reader.normalizeRegistry,
      state: reader.DEFAULT_STATE_FILE,
      mailbox: reader.DEFAULT_MAILBOX_DIR,
      launch: reader.DEFAULT_LAUNCH_DIR,
      progress: reader.DEFAULT_USEFUL_PROGRESS_DIR,
    }));
  `, join(fixtureRoot, 'src', 'lib', 'agent-presence.js')], {
    env: canonicalPresenceEnvironment(fixtureRoot),
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  })
  assert.equal(probe.status, 0, `canonical presence fixture failed to load: ${probe.stderr}`)
  assert.deepEqual(JSON.parse(probe.stdout), {
    normalizeRegistry: 'function',
    state: join(fixtureRoot, 'state', 'agent-presence.json'),
    mailbox: join(fixtureRoot, 'state', 'agent-mailbox'),
    launch: join(fixtureRoot, 'state', 'agent-launch'),
    progress: join(fixtureRoot, 'state', 'agent-useful-progress'),
  })
}
