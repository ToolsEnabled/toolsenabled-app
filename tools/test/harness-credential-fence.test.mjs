/* THE DRIVE HARNESS MUST NOT HAND A CHILD SOMETHING THAT CAN PAY FOR A MODEL
 * TURN.
 *
 * WHAT HAPPENED. tools/test-account-harness.mjs environmentFor() builds the
 * environment for every packaged drive in this repository. It redirects
 * LOCALAPPDATA, APPDATA, USERPROFILE and CODEX_HOME into scratch precisely so a
 * run cannot use the real machine's state -- and it began `{ ...process.env }`
 * and deleted only two Electron flags. So a drive launched from a session
 * holding ANTHROPIC_API_KEY handed that key to the packaged app and everything
 * it spawned. Measured 2026-08-20 end to end, names and lengths only:
 * environmentFor() carried ANTHROPIC_API_KEY (108 chars) and a real child
 * spawned with that environment reported seeing it, while CODEX_HOME and
 * USERPROFILE were correctly isolated. Codex's sign-in was a directory and was
 * closed; Claude's was a variable and was open.
 *
 * WHY THIS IS A SPAWNED CHILD AND NOT AN ASSERTION ABOUT AN OBJECT. The object
 * is what the harness INTENDS to pass; the child is what actually arrives. They
 * are the same today, and a future `env: { ...process.env, ...environment }` at
 * one call site would separate them while every object-level assertion stayed
 * green. The whole defect being fenced was an inheritance nobody wrote down, so
 * the fence asks the only witness that cannot be reasoned wrong.
 *
 * THE POSITIVE CONTROL IS THE POINT. An absence proves nothing unless the same
 * probe is shown to detect a presence, so every scrub test here has a twin that
 * spawns an identical child with the UNSCRUBBED environment and requires the
 * name to arrive. If that twin ever passes silently, this whole file is
 * measuring nothing.
 *
 * NO REAL CREDENTIAL IS INVOLVED, and nothing here reads a value out of the
 * ambient environment. The names are planted with obviously fake values so the
 * suite is identical on a machine that holds no keys at all -- which is most
 * machines this must keep working on, and is the difference between a test and
 * a description of one laptop.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { environmentFor, isProviderCredentialName } from '../test-account-harness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = require_(path.join(REPO_ROOT, 'shell', 'capability-path-environment.cjs'))
const profile = () => mkdtempSync(path.join(tmpdir(), 'credential-fence-'))

/* Planted, never read from the machine. The value is a marker rather than
   anything key-shaped, so a failure message cannot leak and a reader of this
   file learns nothing about anybody's account. */
const PLANTED = Object.freeze({
  ANTHROPIC_API_KEY: 'planted-not-a-key',
  OPENAI_API_KEY: 'planted-not-a-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'planted-not-a-token',
  AWS_SECRET_ACCESS_KEY: 'planted-not-a-key',
  GITHUB_TOKEN: 'planted-not-a-token',
  SOME_VENDOR_PASSWORD: 'planted-not-a-password',
})

/** Names a REAL child process reports seeing. The only witness that counts. */
function namesSeenByChild(environment, names) {
  const script = 'const want = JSON.parse(process.argv[1]);'
    + 'console.log(JSON.stringify(want.filter(n => Object.prototype.hasOwnProperty.call(process.env, n))))'
  const run = spawnSync(process.execPath, ['-e', script, JSON.stringify(names)], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  })
  assert.equal(run.error, undefined, `the probe child did not run: ${run.error && run.error.message}`)
  assert.equal(run.status, 0, `the probe child exited ${run.status}: ${String(run.stderr).slice(0, 300)}`)
  return JSON.parse(String(run.stdout).trim())
}

/** Plant the names for one call, then put the environment back exactly as found. */
function withPlanted(run) {
  const before = new Map(Object.keys(PLANTED).map(name => [name, process.env[name]]))
  try {
    for (const [name, value] of Object.entries(PLANTED)) process.env[name] = value
    return run()
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('no provider credential reaches a child the harness starts', () => {
  const seen = withPlanted(() => namesSeenByChild(environmentFor(profile()), Object.keys(PLANTED)))
  assert.deepEqual(seen, [],
    `the drive harness handed a child something that can pay for a model turn: ${seen.join(', ')}`)
})

test('the probe would have caught it — an unscrubbed child sees every one', () => {
  /* THE POSITIVE CONTROL. Without this, the test above also passes on a broken
     probe, a child that never started, or a spawn that silently dropped the
     environment -- and it would pass exactly as convincingly. This is the
     environment environmentFor() used to build. */
  const seen = withPlanted(() => namesSeenByChild({ ...process.env }, Object.keys(PLANTED)))
  assert.deepEqual(seen.sort(), Object.keys(PLANTED).sort(),
    'the probe cannot see an inherited credential, so the scrub test above proves nothing')
})

test('the harness still isolates the things it always isolated', () => {
  /* A scrub that took CODEX_HOME with it would silently point every drive at the
     real installation -- trading this defect for the one the module header says
     it exists to prevent. */
  const home = profile()
  const environment = environmentFor(home)
  assert.equal(environment.CODEX_HOME, path.join(home, 'home', '.codex'))
  assert.equal(environment.USERPROFILE, path.join(home, 'home'))
  assert.equal(environment.APPDATA, path.join(home, 'roaming'))
  assert.equal(environment.LOCALAPPDATA, path.join(home, 'local'))
  /* Redirected rather than deleted, and onto exactly the path the homedir
     fallback already resolved to, so no existing drive changes behaviour. */
  assert.equal(environment.CLAUDE_CONFIG_DIR, path.join(home, 'home', '.claude'))
})

test('a foreign-profile PATH entry cannot reach a packaged drive, while legitimate tools remain', {
  skip: process.platform !== 'win32',
}, () => {
  const pathEntries = Object.entries(process.env).filter(([name]) => /^path$/i.test(name))
  try {
    for (const [name] of pathEntries) delete process.env[name]
    const ownedTool = path.join(homedir(), 'AppData', 'Roaming', 'npm')
    const retained = [
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
      'C:\\agent-apps\\node-v22.19.0',
      ownedTool,
    ]
    process.env.Path = [...retained, 'C:\\Users\\Foreign-QA-Path\\bin'].join(';')
    const environment = environmentFor(profile())
    const filtered = Object.entries(environment).find(([name]) => /^path$/i.test(name))?.[1]
    assert.deepEqual(filtered.split(';'), retained)
    assert.equal(filtered.includes('Foreign-QA-Path'), false)
    const seen = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.Path || process.env.PATH || "")'], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    assert.equal(seen.status, 0)
    assert.deepEqual(String(seen.stdout).split(';'), retained)
  } finally {
    for (const name of Object.keys(process.env)) if (/^path$/i.test(name)) delete process.env[name]
    for (const [name, value] of pathEntries) process.env[name] = value
  }
})

test('no foreign capability filesystem override can reach a packaged drive', () => {
  const planted = Object.fromEntries(
    CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES.map((name, index) => [name, `C:\\foreign\\path-${index}`]),
  )
  const before = new Map(Object.keys(planted).map(name => [name, process.env[name]]))
  try {
    for (const [name, value] of Object.entries(planted)) process.env[name] = value
    const scrubbed = environmentFor(profile())
    for (const name of Object.keys(planted)) {
      assert.equal(Object.keys(scrubbed).some(key => key.toLowerCase() === name.toLowerCase()), false,
        `${name} could pair a scratch ledger with foreign installation state`)
    }
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('an operator’s CLAUDE_CONFIG_DIR cannot reach a drive', () => {
  /* The same door Codex's sign-in was already closed at. presence checks read a
     DIRECTORY, so this one is redirected rather than scrubbed. */
  const before = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = 'C:\\Users\\somebody\\.claude'
    const home = profile()
    const seen = namesSeenByChild(environmentFor(home), ['CLAUDE_CONFIG_DIR'])
    assert.deepEqual(seen, ['CLAUDE_CONFIG_DIR'], 'the variable should still be set, just not at the operator’s copy')
    assert.equal(environmentFor(home).CLAUDE_CONFIG_DIR, path.join(home, 'home', '.claude'))
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
})

test('the rule reads names, and knows wiring from paying', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN', 'SOME_VENDOR_PASSWORD', 'X_PRIVATE_KEY', 'SERVICE_CREDENTIALS']) {
    assert.ok(isProviderCredentialName(name), `${name} would have been handed to a child`)
  }
  /* Taken from a real session's environment. These are how a run is WIRED, and
     scrubbing them would break drives while protecting nothing. */
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDECODE',
    'PATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'MC_SMOKE_HEADLESS']) {
    assert.ok(!isProviderCredentialName(name), `${name} is wiring, not a credential, and the scrub would break a drive`)
  }
})

test('every default custom Start/dispatch launcher uses the shared credential scrub', () => {
  const launchers = [
    'agent-dispatch-packaged-qa.mjs',
    'example-page-write-fence-qa.mjs',
    'loop-packaged-qa.mjs',
    'owner-account-packaged-qa.mjs',
    'recommended-path-packaged-qa.mjs',
    'refusal-copy-qa.mjs',
    'stranger-onboarding-qa.mjs',
    'team-panel-packaged-qa.mjs',
  ]
  for (const name of launchers) {
    const source = readFileSync(path.join(REPO_ROOT, 'tools', name), 'utf8')
    assert.match(source, /environmentFor as credentialSafeEnvironment/,
      `${name} does not import the shared credential-name scrub`)
    assert.match(source, /credentialSafeEnvironment\((?:profile|sandbox)\)/,
      `${name} does not build its child environment through the shared scrub`)
    assert.doesNotMatch(source, /const environment = \{ \.\.\.process\.env \}/,
      `${name} still hands an ambient credential to the packaged app`)
    assert.doesNotMatch(source, /function environmentFor\s*\(/,
      `${name} shadows the shared credential-safe environment with a local clone`)
  }
})

test('custom launchers retain their stricter provider-free overrides after the shared scrub', () => {
  const sourceFor = name => readFileSync(path.join(REPO_ROOT, 'tools', name), 'utf8')
  const loop = sourceFor('loop-packaged-qa.mjs')
  assert.match(loop, /environment\.MC_BRIDGE_PROOF_FILE = decoyProofFile/,
    'the loop lost the hostile bridge-proof input it intentionally tests')

  for (const name of ['refusal-copy-qa.mjs', 'stranger-onboarding-qa.mjs']) {
    const source = sourceFor(name)
    assert.match(source, /environment\.PATH = systemOnlyPath\(\)/,
      `${name} can reach an installed provider CLI`)
    assert.match(source, /environment\.Path = environment\.PATH/,
      `${name} does not apply the Windows-cased PATH override`)
  }

  const stranger = sourceFor('stranger-onboarding-qa.mjs')
  assert.match(stranger, /harness-not-a-real-token/,
    'the signed-in stranger fixture no longer uses an obviously synthetic token')
  assert.match(stranger, /plantBrokenCodex/,
    'the broken-CLI scenario lost its deterministic local executable')

  const recommended = sourceFor('recommended-path-packaged-qa.mjs')
  assert.match(recommended, /if \(signedInCodexHome && process\.env\.USERPROFILE\)/,
    'the explicit manual steering path can no longer opt into its documented sign-in')
  assert.match(recommended, /\}, \{ signedInCodexHome: true \}\)/,
    'the sign-in override is no longer confined to steering')
})
