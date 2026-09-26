import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const policy = require('../../capability/src/lib/provider-session-isolation.js')
const { createProviderLoginService } = require('../../shell/provider-login.cjs')
const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')
const { providerCliPresence } = require('../../shell/provider-cli-presence.cjs')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const engineFile = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(engineFile)
const planner = require('./fixtures/confined-engine/src/lib/agent-session-confinement.js')
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

function scratch(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'provider-private-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const profile = path.join(root, 'profile')
  mkdirSync(profile, { mode: 0o700 })
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || 'C:/Windows',
    TOOLSENABLED_PROVIDER_ISOLATION_ROOT: profile,
    TOOLSENABLED_STATE_ROOT: path.join(profile, 'userData', 'ToolsEnabled', 'capability'),
    HOME: path.join(root, 'owner'), NODE_OPTIONS: '--require owner-hook',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'owner-secure-store'),
    OPENAI_API_KEY: 'synthetic-owner-key', ANTHROPIC_API_KEY: 'synthetic-owner-key',
    npm_config_prefix: path.join(root, 'owner-npm'), npm_config_global: 'true',
  }
  const context = policy.isolationContext(env)
  const pinned = policy.providerSessionEnvironment(env, { create: true })
  const store = createAccountRegistryStore({
    file: path.join(context.stateRoot, 'config', 'accounts.json'),
    stateFile: path.join(context.servicesRoot, 'multi-account-state.json'),
    servicesRoot: context.servicesRoot, env, providerIsolation: policy,
    homedir: () => assert.fail('The private store must not resolve the owner home'),
  })
  return { root, env, context, pinned, store }
}

function privateProgram(fixture, provider) {
  const prefix = fixture.pinned.npm_config_prefix
  const file = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', ...({
      codex: ['@openai', 'codex', 'bin', 'codex.js'],
      claude: ['@anthropic-ai', 'claude-code', 'cli.js'],
      gemini: ['@google', 'gemini-cli', 'bundle', 'gemini.js'],
    })[provider])
    : path.join(prefix, 'bin', provider)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");fs.writeFileSync(path.join(process.env.USERPROFILE,"provider-env.json"),JSON.stringify(process.env));fs.writeFileSync(path.join(process.env.USERPROFILE,"provider-argv.json"),JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 })
  return file
}

function login(fixture, { platform = process.platform, npm = true, xterm = true } = {}) {
  const spawns = [], terminals = [], inspections = []
  const service = createProviderLoginService({
    env: fixture.env, providerIsolation: policy, platform,
    // statSync below models every entry in this fictional search explicitly.
    readSearchPath: ({ env, platform }) => ({
      directories: env.PATH.split(platform === 'win32' ? ';' : ':').filter(Boolean), complete: true,
    }),
    spawnHidden(command, args, options) {
      spawns.push({ command, args, options })
      const child = new EventEmitter()
      child.kill = () => child.emit('exit', null)
      return child
    },
    openTerminal: (command, args, options) => terminals.push({ command, args, options }),
    providerSpawnRefused: () => false,
    loginHome: () => assert.fail('No default login home in a private session'),
    statSync(target) {
      inspections.push(target)
      if (/cmd\.exe$/.test(target) || ['/usr/bin/gnome-terminal', '/usr/bin/env', '/bin/bash'].includes(target)
        || (xterm && target === '/usr/bin/xterm')
        || (npm && /(?:^|[\\/])npm(?:\.CMD)?$/i.test(target))) return { isFile: () => true }
      throw Object.assign(new Error('fixture absence'), { code: 'ENOENT' })
    },
    lstatSync: () => assert.fail('A private login must not discover a shared terminal server'),
    accessSync() {},
    localNodeRuntime: { RUNTIMES: { ollama: { installCommand: 'winget install Ollama.Ollama' } } },
  })
  return { service, spawns, terminals, inspections }
}

test('private account homes never adopt, inspect, or modify another session’s credentials', async t => {
  const first = scratch(t), second = scratch(t)
  const a = first.store.addManaged({ provider: 'codex', name: 'First' })
  const b = second.store.addManaged({ provider: 'codex', name: 'Second' })
  assert.deepEqual(readdirSync(a.directory), [])
  writeFileSync(path.join(b.directory, 'auth.json'), 'synthetic second account')
  assert.throws(() => first.store.add({ provider: 'codex', name: 'Foreign', directory: b.directory }), { code: 'AGENT_PROVIDER_ISOLATION_PATH' })
  assert.throws(() => first.store.signInCommand({ provider: 'codex', directory: a.directory }), { code: 'ACCOUNT_ISOLATED_SIGN_IN_WINDOW_REQUIRED' })
  const alias = path.join(first.context.root, 'linked-account')
  symlinkSync(b.directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => first.store.add({ provider: 'codex', name: 'Linked', directory: alias }), { code: 'AGENT_PROVIDER_ISOLATION_PATH' })
  assert.equal(first.store.homeOf({ provider: 'codex', name: 'First' }).directory, a.directory)
  assert.equal((await first.store.listAsync()).accounts.length, 1)
  assert.equal(readFileSync(path.join(b.directory, 'auth.json'), 'utf8'), 'synthetic second account')
  // A registry edited after construction is checked before even a metadata probe.
  const file = path.join(first.context.stateRoot, 'config', 'accounts.json')
  writeFileSync(file, JSON.stringify({ accounts: [{ provider: 'codex', name: 'Foreign', profileDir: b.directory }] }))
  assert.throws(() => first.store.list(), { code: 'AGENT_PROVIDER_ISOLATION_PATH' })
  await assert.rejects(first.store.listAsync(), { code: 'AGENT_PROVIDER_ISOLATION_PATH' })
  rmSync(file)
  linkSync(path.join(b.directory, 'auth.json'), file)
  assert.throws(() => first.store.list(), { code: 'AGENT_PROVIDER_ISOLATION_PATH' })
  assert.equal(readFileSync(path.join(b.directory, 'auth.json'), 'utf8'), 'synthetic second account')
})

test('private login requires named homes and its private executable before any terminal lookup', t => {
  const fixture = scratch(t)
  const { service, inspections, terminals } = login(fixture)
  assert.equal(service.start('codex').code, 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED')
  assert.equal(service.start('codex', { home: fixture.pinned.USERPROFILE }).code, 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED')
  assert.equal(inspections.length, 0)
  const account = fixture.store.addManaged({ provider: 'codex', name: 'Work' })
  assert.equal(service.start('codex', { home: account.directory, label: account.name }).code, 'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED')
  assert.equal(service.installed('codex'), false)
  assert.equal(inspections.length, 0)
  assert.equal(terminals.length, 0)
  assert.throws(() => createProviderLoginService({ env: fixture.env,
    spawnHidden() {}, openTerminal() {}, providerSpawnRefused: () => false }), { code: 'AGENT_PROVIDER_ISOLATION_UNAVAILABLE' })
})

// This drives the actual staged engine's native filesystem contract. The
// standalone opener/Windows cmd fixtures below cover argument policy without
// pretending a Windows home is a valid Linux login home (or the reverse).
for (const platform of [process.platform]) {
  test(`${platform} named login receives the complete private environment and cannot reuse owner terminal state`, async t => {
    const fixture = scratch(t)
    for (const provider of ['codex', 'claude', 'gemini']) {
      const account = fixture.store.addManaged({ provider, name: 'Work' })
      const executable = privateProgram(fixture, provider)
      const { service, terminals } = login(fixture, { platform })
      assert.equal((await service.start(provider, { home: account.directory, label: account.name })).ok, true)
      assert.equal(terminals.length, 1)
      const call = terminals[0]
      assert.equal(call.options.env[policy.HOME_ENV[provider]], account.directory)
      assert.equal(call.options.env.HOME, fixture.context.userProfile)
      assert.equal(call.options.env.USERPROFILE, fixture.context.userProfile)
      assert.equal(call.options.env.OPENAI_API_KEY, undefined)
      assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined)
      assert.equal(call.options.env.NODE_OPTIONS, undefined)
      if (provider === 'claude') assert.equal(call.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, account.directory)
      if (provider === 'gemini') assert.equal(call.options.env.GEMINI_FORCE_FILE_STORAGE, 'true')
      assert.ok(call.args.includes(executable))
      if (provider === 'codex') assert.ok(call.args.includes('cli_auth_credentials_store="file"'))
      if (platform === 'win32') {
        assert.equal(call.options.kind, 'command-prompt')
        assert.equal(call.args[0], '/d')
        // Run the actual inner cmd parser hidden with our private fixture CLI;
        // /c closes after the command instead of opening a persistent window.
        const child = spawnSync(call.command, call.args.map(word => word === '/k' ? '/c' : word), {
          env: call.options.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true,
        })
        assert.equal(child.status, 0, child.stderr)
        const received = JSON.parse(readFileSync(path.join(fixture.context.userProfile, 'provider-env.json'), 'utf8'))
        assert.equal(received[policy.HOME_ENV[provider]], account.directory)
        if (provider === 'codex') assert.deepEqual(JSON.parse(readFileSync(path.join(fixture.context.userProfile, 'provider-argv.json'), 'utf8')),
          ['-c', 'cli_auth_credentials_store="file"', 'login'])
      } else {
        assert.equal(call.options.kind, 'linux-xterm')
        const commandIndex = call.args.indexOf('-e') + 1
        assert.deepEqual(call.args.slice(commandIndex, commandIndex + 2), ['/usr/bin/env', '-i'])
        if (process.platform === 'linux') {
          const child = spawnSync(call.args[commandIndex], call.args.slice(commandIndex + 1), { env: {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
          assert.equal(child.status, 0, child.stderr)
          const received = JSON.parse(readFileSync(path.join(fixture.context.userProfile, 'provider-env.json'), 'utf8'))
          assert.equal(received[policy.HOME_ENV[provider]], account.directory)
          assert.equal(received.HOME, fixture.context.userProfile)
          assert.equal(received.OPENAI_API_KEY, undefined)
        }
      }
    }
  })
}

test('private npm installs use distinct prefixes, caches and cwd while shared installers and model daemons refuse', t => {
  const fixtures = [scratch(t), scratch(t)]
  const observed = []
  for (const fixture of fixtures) {
    const { service, spawns } = login(fixture, { platform: 'win32' })
    assert.equal(service.installStart('codex', () => {}).ok, true)
    assert.equal(service.installStart('claude', () => {}).code, 'PROVIDER_LOGIN_RUNNING', 'Two npm writers must not share one private prefix')
    assert.equal(spawns.length, 1)
    const call = spawns[0]
    observed.push(call)
    assert.equal(call.args[call.args.indexOf('--prefix') + 1], fixture.pinned.npm_config_prefix)
    assert.equal(call.options.cwd, fixture.context.userProfile)
    assert.equal(call.options.env.npm_config_cache, fixture.pinned.npm_config_cache)
    assert.equal(call.options.env.NODE_OPTIONS, undefined)
    assert.equal(call.options.env.npm_config_global, undefined)
    assert.equal(service.installRuntime('ollama', () => {}).code, 'PROVIDER_ISOLATION_DEDICATED_WORKER_REQUIRED')
    assert.equal(service.pullModel({ runtime: 'ollama', model: 'fixture' }, () => {}).code, 'PROVIDER_ISOLATION_DEDICATED_WORKER_REQUIRED')
    assert.equal(spawns.length, 1)
    service.stopAll()
    const unavailable = login(fixture, { platform: 'win32', npm: false })
    assert.equal(unavailable.service.installStart('codex', () => {}).code, 'PROVIDER_ISOLATION_DEDICATED_WORKER_REQUIRED')
    assert.equal(unavailable.spawns.length, 0)
  }
  assert.notEqual(observed[0].options.env.npm_config_prefix, observed[1].options.env.npm_config_prefix)
  assert.notEqual(observed[0].options.env.npm_config_cache, observed[1].options.env.npm_config_cache)
})

test('private Linux login refuses an absent standalone terminal even when GNOME is available', t => {
  const fixture = scratch(t)
  privateProgram(fixture, 'codex')
  const account = fixture.store.addManaged({ provider: 'codex', name: 'Work' })
  const { service, inspections, terminals } = login(fixture, { platform: 'linux', xterm: false })
  assert.equal(service.start('codex', { home: account.directory, label: account.name }).code, 'PROVIDER_ISOLATION_TERMINAL_REQUIRED')
  assert.equal(inspections.includes('/usr/bin/gnome-terminal'), false)
  assert.equal(terminals.length, 0)
})

test('the actual main opener retains private xterm in scope and waits for exec acknowledgement', async () => {
  const begin = main.indexOf('function openTerminalWindow(')
  const end = main.indexOf('/* THE LOCAL-MODEL READER', begin)
  for (const event of ['spawn', 'error', 'exit']) {
    const child = new EventEmitter()
    child.unref = () => {}
    let options
    const open = runInNewContext(`(${main.slice(begin, end)})`, {
      PROVIDER_ISOLATION_REQUESTED: true, TERMINAL_WINDOW_IS_THE_POINT: false,
      spawnChildProcess: (_command, _args, value) => { options = value; return child },
      setTimeout, clearTimeout,
    })
    const opening = open('/usr/bin/xterm', [], { kind: 'linux-xterm', env: { USERPROFILE: '/private/profile' } })
    assert.equal(options.detached, false)
    assert.equal(options.cwd, '/private/profile')
    let settled = false
    opening.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    child.emit(event, event === 'error' ? new Error('fixture') : 1)
    if (event === 'spawn') await opening
    else await assert.rejects(opening, /TERMINAL_UNCONFIRMED/)
  }
})

test('generic presence never consults the owner’s default credential home in private mode', t => {
  const fixture = scratch(t)
  privateProgram(fixture, 'codex')
  for (const providerIsolation of [null, policy]) {
    const answer = providerCliPresence({ env: fixture.env, providerIsolation,
      statSync: () => assert.fail('No shared binary scan'), existsSync: () => assert.fail('No default credential probe'),
      homedir: () => assert.fail('No owner home lookup'),
    })
    assert.ok(answer.providers.every(provider => provider.signedIn === 'unknown'))
    assert.equal(answer.providers.find(provider => provider.id === 'codex').installed, providerIsolation ? 'yes' : 'unknown')
  }
})

test('private account selection refuses missing, null, invalid, default and error answers before preparing or starting a provider', async t => {
  const fixture = scratch(t)
  const old = process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT
  process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = fixture.context.root
  t.after(() => { if (old === undefined) delete process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT; else process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = old })
  const prepared = []
  const base = { ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }
  planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION = 1
  planner.PROVIDER_SESSION_ISOLATION_VERSION = 1
  planner.preflightSessionPlan = () => ({ ...base, prepared: false, preflightVersion: 1 })
  t.after(() => { delete planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION; delete planner.PROVIDER_SESSION_ISOLATION_VERSION; delete planner.preflightSessionPlan })
  t.mock.method(planner, 'confinedSessionPlan', ({ account }) => {
    assert.ok(account, 'Preparing a default provider home is forbidden')
    prepared.push(account)
    return { ...base, env: { CODEX_HOME: account.resolvedHome } }
  })
  const create = accountResolver => {
    const host = createAgentHost({ enginePath: engineFile, defaultCwd: fixture.root,
      profileRoot: process.platform === 'win32' ? userInfo().homedir : path.parse(fixture.root).root,
      accountResolver, freeMemory: () => 64 * 1024 ** 3,
    })
    t.after(() => host.closeAll())
    return host
  }
  const unavailable = create(null)
  assert.throws(() => unavailable.startSession({ sessionId: 'missing-account-resolver' }), { code: 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED' })
  await unavailable.closeAll()
  const oldEngine = create(async () => null)
  delete planner.PROVIDER_SESSION_ISOLATION_VERSION
  assert.throws(() => oldEngine.startSession({ sessionId: 'old-private-engine' }), { code: 'AGENT_PROVIDER_ISOLATION_UNAVAILABLE' })
  planner.PROVIDER_SESSION_ISOLATION_VERSION = 1
  await oldEngine.closeAll()
  const started = engine.calls.length
  for (const answer of [null, undefined, {}, { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' },
    { rotated: true, account: { provider: 'codex' } }, { rotated: true, account: { provider: 'claude', name: 'Other' } }, new Error('selection failed')]) {
    const host = create(async () => { if (answer instanceof Error) throw answer; return answer })
    await assert.rejects(host.startSession({ sessionId: 'invalid-selection' }), error => /ACCOUNT_UNAVAILABLE|ACCOUNT_REQUIRED/.test(error.code))
    await host.closeAll()
  }
  assert.equal(prepared.length, 0)
  assert.equal(engine.calls.length, started)
  const account = { provider: 'codex', name: 'Private', resolvedHome: fixture.store.addManaged({ provider: 'codex', name: 'Private' }).directory }
  const host = create(async () => ({ rotated: true, blocked: false, account }))
  await host.startSession({ sessionId: 'private-selected' })
  assert.equal(prepared.length, 1)
  assert.equal(engine.calls.at(-1).env.CODEX_HOME, account.resolvedHome)
  await host.closeAll()
})

test('main account adapter refuses unavailable selection on every OS in ordinary and private sessions', async () => {
  const begin = main.indexOf('async function resolveSessionAccount(')
  const end = main.indexOf('\n/* The same directory the machine record', begin)
  for (const platform of ['linux', 'win32', 'darwin']) for (const isolated of [true, false]) {
    for (const loadRotation of [() => null, () => ({ resolveAccountForSession: async () => { throw new Error('private failure') } })]) {
      const resolve = runInNewContext(`(${main.slice(begin, end)})`, {
        process: { platform }, PROVIDER_ISOLATION_REQUESTED: isolated,
        ACCOUNT_HOME_DIR: 'private-profile', ACCOUNT_REGISTRY_FILE: 'private-registry',
        loadRotation, resolveServicesRootForAccounts: () => 'private-services', selectionPolicyFromRegistry: () => null,
      })
      await assert.rejects(resolve({ provider: 'codex' }), error => {
        assert.equal(error.code, 'AGENT_ACCOUNT_UNAVAILABLE', `${platform}, private=${isolated}`)
        assert.doesNotMatch(error.message, /private failure/)
        return true
      })
    }
  }
})

test('private rotation loads only from the paired capability tree and never tries an owner engine fallback', () => {
  const begin = main.indexOf('function loadRotation(')
  const end = main.indexOf('\n}\n', begin) + 2
  for (const present of [true, false]) {
    const requests = []
    const selector = { resolveAccountForSession() {} }
    const load = runInNewContext(`let rotationModule; (${main.slice(begin, end)})`, {
      PROVIDER_ISOLATION_REQUESTED: true, path,
      resolveCapabilityRoot: () => path.resolve('paired-capability'),
      engineCandidates: () => assert.fail('Private rotation must never enumerate owner engine trees'),
      require: file => {
        requests.push(file)
        if (!present) throw Object.assign(new Error('absent paired selector'), { code: 'MODULE_NOT_FOUND' })
        return selector
      },
    })
    assert.equal(load(), present ? selector : null)
    assert.equal(load(), present ? selector : null)
    assert.deepEqual(requests, [path.resolve('paired-capability', 'src', 'lib', 'multi-account', 'rotation.js')])
  }
})
