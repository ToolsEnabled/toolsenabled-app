import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { providerLaunchEnvironment } from '../lib/provider-launch-environment.cjs'
import { environmentFor } from '../test-account-harness.mjs'

const options = extra => ({ argv: [], source: {}, platform: 'linux', accountHome: '/owner', ...extra })

test('caller-selected provider homes are passed unchanged without any filesystem operation', t => {
  const touched = [], originals = new Map()
  for (const name of ['openSync', 'readFileSync', 'writeFileSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync']) {
    originals.set(name, fs[name])
    fs[name] = (...args) => { touched.push(name); throw new Error('unexpected QA filesystem operation') }
  }
  t.after(() => { for (const [name, original] of originals) fs[name] = original })
  for (const [provider, flag, key] of [
    ['claude', '--claude-config-dir', 'CLAUDE_CONFIG_DIR'],
    ['codex', '--codex-home', 'CODEX_HOME'],
    ['gemini', '--gemini-home', 'GEMINI_CLI_HOME'],
    ['codex', '--codex-profile-home', 'CODEX_HOME'],
  ]) {
    for (const argv of [[flag, '/selected/existing-home'], [flag + '=/selected/existing-home']]) {
      const base = { HOME: '/scratch/home', APPDATA: '/scratch/appdata', [key]: '/scratch/provider' }
      const actual = providerLaunchEnvironment(provider, base, options({ argv }))
      assert.equal(actual[key], '/selected/existing-home')
      assert.equal(actual.HOME, base.HOME)
      assert.equal(actual.APPDATA, base.APPDATA)
      assert.equal(base[key], '/scratch/provider')
    }
  }
  assert.deepEqual(touched, [])
})

test('ambient provider homes cannot select a live sign-in without a command-line home or API key', () => {
  for (const [provider, key] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME'], ['gemini', 'GEMINI_CLI_HOME']]) {
    assert.throws(() => providerLaunchEnvironment(provider, {}, options({ source: { [key]: '/ambient/provider' } })),
      error => error.code === 'QA_PROVIDER_LAUNCH_REFUSED' && error.reason === 'explicit_provider_home_or_api_key_required')
  }
})

test('only the selected provider API environment is restored into a scrubbed launch', () => {
  for (const [provider, keys] of [['claude', ['ANTHROPIC_API_KEY']], ['codex', ['OPENAI_API_KEY', 'CODEX_API_KEY']], ['gemini', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']]]) {
    for (const name of keys) {
      const source = { [name]: 'synthetic-environment-input', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-unsupported' }
      const actual = providerLaunchEnvironment(provider, { HOME: '/scratch', OPENAI_API_KEY: 'unselected', CLAUDE_CODE_OAUTH_TOKEN: 'unsupported-base-input', ANTHROPIC_AUTH_TOKEN: 'unsupported-base-input', openai_api_key: 'synthetic-unselected', Claude_Code_OAuth_Token: 'synthetic-unsupported', Anthropic_Auth_Token: 'synthetic-unsupported' }, options({ source }))
      assert.equal(actual[name], source[name])
      assert.equal(actual.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(actual.ANTHROPIC_AUTH_TOKEN, undefined)
      assert.equal(actual.openai_api_key, undefined)
      assert.equal(actual.Claude_Code_OAuth_Token, undefined)
      assert.equal(actual.Anthropic_Auth_Token, undefined)
      if (provider !== 'codex') assert.equal(actual.OPENAI_API_KEY, undefined)
      assert.equal(actual.HOME, '/scratch')
    }
  }
})

test('a drive can explicitly select two providers without discarding either selection', () => {
  const actual = providerLaunchEnvironment(['claude', 'codex'], {}, options({
    argv: ['--claude-config-dir', '/selected/claude', '--codex-home', '/selected/codex'],
    source: { ANTHROPIC_API_KEY: 'synthetic-claude-input', OPENAI_API_KEY: 'synthetic-codex-input' },
  }))
  assert.equal(actual.CLAUDE_CONFIG_DIR, '/selected/claude')
  assert.equal(actual.CODEX_HOME, '/selected/codex')
  assert.ok(actual.ANTHROPIC_API_KEY)
  assert.ok(actual.OPENAI_API_KEY)
})

test('home selection refuses missing, duplicate, relative, dot-segment and NUL arguments with named reasons', () => {
  for (const [argv, reason] of [
    [['--codex-home'], 'provider_home_value_required'],
    [['--codex-home', '--keep'], 'provider_home_value_required'],
    [['--codex-home='], 'provider_home_value_required'],
    [['--codex-home', '/selected', '--codex-profile-home', '/other'], 'duplicate_provider_home'],
    [['--codex-home', 'relative'], 'provider_home_must_be_absolute'],
    [['--codex-home', '/selected/../other'], 'provider_home_must_be_absolute'],
    [['--codex-home', '/selected/\0bad'], 'provider_home_must_be_absolute'],
  ]) assert.throws(() => providerLaunchEnvironment('codex', {}, options({ argv })),
    error => error.code === 'QA_PROVIDER_LAUNCH_REFUSED' && error.reason === reason)
  assert.throws(() => providerLaunchEnvironment('unknown', {}, options()), /unsupported_provider/)
})

test('Windows home selection refuses a foreign profile before any filesystem operation', () => {
  const own = String.raw`${"\x43:\\Users\\Caller"}`
  const home = String.raw`${"\x43:\\Users\\Caller\\provider"}`
  assert.equal(providerLaunchEnvironment('claude', {}, options({ platform: 'win32', accountHome: own,
    argv: ['--claude-config-dir', home] })).CLAUDE_CONFIG_DIR, home)
  for (const value of [String.raw`${"\x43:\\Users\\Other\\provider"}`, String.raw`\\host\share\provider`]) {
    assert.throws(() => providerLaunchEnvironment('claude', {}, options({ platform: 'win32', accountHome: own,
      argv: ['--claude-config-dir', value] })), /outside_owning_profile/)
  }
})

test('shared harness retains a sterile default and restores only an explicitly selected provider home', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-provider-environment-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const defaults = environmentFor(scratch)
  assert.equal(defaults.CODEX_HOME, path.join(scratch, 'home', '.codex'))
  const actual = environmentFor(scratch, { provider: 'codex', argv: ['--codex-home', '/selected/provider'], source: {} })
  assert.equal(actual.CODEX_HOME, '/selected/provider')
  assert.equal(actual.LOCALAPPDATA, defaults.LOCALAPPDATA)
  assert.equal(actual.USERPROFILE, defaults.USERPROFILE)
})
