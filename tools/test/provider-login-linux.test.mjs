import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import path from 'node:path'
import { platformSkipReason } from '../lib/test-suite-result.mjs'

const require = createRequire(import.meta.url)
const { createProviderLoginService, linuxTerminalInvocation } = require('../../shell/provider-login.cjs')
const { resolveSearchPath, machineSearchPath } = require('../../shell/machine-search-path.cjs')
const { providerCliPresence } = require('../../shell/provider-cli-presence.cjs')
const { createCloudAccountSetup } = require('../../shell/cloud-account-setup.cjs')
const { acknowledgeGnomeTerminal } = require('../../shell/gnome-terminal-acknowledgement.cjs')
const owner = '/fixture/OS owner'

// Execute the real CommonJS modules with each host's actual Node path
// implementation. The selected machine remains Linux. No filesystem, OS
// account or child process is consulted by this fabricated-machine fixture.
function onHostPaths(hostPaths) {
  const cache = new Map()
  const forbidden = () => { throw new Error('Fabricated Linux must not inspect or launch the host') }
  const guarded = new Proxy({}, { get: () => forbidden })
  const dependencies = {
    'node:path': hostPaths,
    'node:fs': new Proxy({ constants: require('node:fs').constants }, { get: (value, key) => value[key] || forbidden }),
    'node:os': guarded,
    'node:child_process': guarded,
  }
  const modules = new Set(['provider-login.cjs', 'provider-cli-presence.cjs', 'machine-search-path.cjs'])
  const load = name => {
    assert(modules.has(name), 'Only the reviewed provider modules are loaded')
    if (cache.has(name)) return cache.get(name).exports
    const module = { exports: {} }
    cache.set(name, module)
    vm.runInNewContext(readFileSync(new URL('../../shell/' + name, import.meta.url), 'utf8'), {
      module, exports: module.exports, setTimeout, clearTimeout,
      process: { platform: hostPaths === path.win32 ? 'win32' : 'linux', env: {} },
      require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : load(id.replace(/^\.\//, '')),
    }, { filename: name })
    return module.exports
  }
  return { ...load('provider-login.cjs'), ...load('provider-cli-presence.cjs') }
}

for (const [host, paths] of [['POSIX', path.posix], ['Windows', path.win32]]) {
  test(`selected Linux CLI lookup uses POSIX paths on a ${host} host`, async () => {
    const { createProviderLoginService: create } = onHostPaths(paths)
    for (const provider of ['codex', 'claude', 'gemini']) {
      const calls = [], inspected = []
      const held = new Set([owner + '/.local/bin/' + provider, '/usr/bin/gnome-terminal', '/usr/bin/env', '/bin/bash'])
      const service = create({ platform: 'linux', env: { PATH: '/usr/bin:/bin' }, loginHome: () => owner,
        statSync: target => { inspected.push(target); if (held.has(target)) return { isFile: () => true }; throw Object.assign(new Error('fixture absence'), { code: 'ENOENT' }) },
        lstatSync: () => assert.fail('No Windows alias lookup'), accessSync: () => {},
        spawnHidden: () => assert.fail('No hidden sign-in'), openTerminal: (...args) => { calls.push(args) },
        providerSpawnRefused: () => false,
      })
      assert.equal((await service.start(provider)).ok, true)
      assert.equal(calls.length, 1)
      assert(calls[0][1].includes(owner + '/.local/bin/' + provider))
      assert(inspected.every(target => target.startsWith('/') && !target.includes('\\')))
    }
  })

  test(`selected Linux denied CLI remains unknown on a ${host} host`, async () => {
    const { createProviderLoginService: create } = onHostPaths(paths)
    const service = create({ platform: 'linux', env: { PATH: '/usr/bin:/bin' }, loginHome: () => owner,
      statSync: target => { if (target === owner + '/.local/bin/codex') return { isFile: () => true }; throw Object.assign(new Error('fixture absence'), { code: 'ENOENT' }) },
      accessSync: () => { throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' }) },
      lstatSync: () => assert.fail('No Windows alias lookup'),
      spawnHidden: () => assert.fail('No hidden sign-in'), openTerminal: () => assert.fail('No window for an uncertain CLI'),
      providerSpawnRefused: () => false,
    })
    assert.equal((await service.start('codex')).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
    assert.throws(() => service.installed('codex'), /INSTALL_CHECK_FAILED/)
  })

  test(`selected Linux credential markers stay with the OS owner on a ${host} host`, () => {
    const { providerCliPresence: presence } = onHostPaths(paths)
    const inspected = []
    const answer = presence({ platform: 'linux', homedir: () => owner,
      env: { HOME: '/wrong', CODEX_HOME: '/wrong/codex', CLAUDE_CONFIG_DIR: '/wrong/claude' },
      searchPath: { directories: [], complete: true },
      existsSync: target => { inspected.push(target); return false },
    })
    assert.deepEqual(inspected, [owner + '/.codex/auth.json', owner + '/.claude/.credentials.json', owner + '/.gemini/oauth_creds.json', owner + '/.grok/auth.json'])
    assert.equal(answer.providers[0].signedIn, 'no')
    assert(answer.providers.slice(1).every(provider => provider.signedIn === 'unknown'))
  })
}

function fixture({ open, files, env = {}, denied = [] } = {}) {
  const held = new Set(files || [
    owner + '/.local/bin/codex', owner + '/.local/bin/claude',
    '/usr/bin/gnome-terminal', '/usr/bin/env', '/bin/bash',
  ])
  const calls = []
  const service = createProviderLoginService({
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin', HOME: '/fixture/live-private-home',
      CODEX_HOME: '/fixture/wrong-codex', CLAUDE_CONFIG_DIR: '/fixture/wrong-claude',
      ...env },
    loginHome: () => owner,
    statSync: target => {
      if (held.has(target)) return { isFile: () => true }
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
    },
    lstatSync() { throw new Error('Linux must not inspect Windows aliases') },
    accessSync: target => {
      if (denied.includes(target)) throw Object.assign(new Error('not executable'), { code: 'EACCES' })
    },
    spawnHidden() { throw new Error('Sign-in must not run hidden') },
    openTerminal: (...args) => { calls.push(args); return open?.(...args) },
    providerSpawnRefused: () => false,
  })
  return { service, calls }
}

test('Linux discovery adds only the chosen OS account bins and never relative PATH entries', () => {
  const resolved = resolveSearchPath({
    platform: 'linux', env: { PATH: '/usr/bin:relative:/Case:/case:/usr/bin', HOME: '/wrong' },
    loginHome: owner, readRegistryKey() { throw new Error('No registry on Linux') },
  })
  assert.deepEqual([...resolved.directories], [
    '/usr/bin', '/Case', '/case', owner + '/.local/bin', owner + '/bin',
  ])
  assert.equal(resolved.complete, false)
  assert.deepEqual([...machineSearchPath({ platform: 'linux', env: { PATH: '/fixture/bin' } }).directories],
    ['/fixture/bin'], 'fabricated machines must not discover the real OS home')
})

for (const provider of ['codex', 'claude']) {
  test(provider + ' default login resolves the real executable and matches tree OS-home custody', async () => {
    const { service, calls } = fixture({ open: () => Promise.resolve() })
    const result = await service.start(provider)
    assert.equal(result.ok, true)
    assert.equal(result.terminal, 'linux-gnome-terminal')
    assert.equal(calls.length, 1)
    const [command, args, options] = calls[0]
    assert.equal(command, '/usr/bin/gnome-terminal')
    assert.equal(options.env.HOME, owner)
    assert.equal(options.env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], owner + '/.' + provider)
    assert.ok(args.includes(owner + '/.local/bin/' + provider))
    assert.equal(args.includes('/fixture/live-private-home'), false)
    assert.equal(args.includes('/fixture/wrong-' + provider), false)
    const tail = args.slice(args.indexOf('--') + 1)
    assert.deepEqual(tail.slice(0, 2), ['/usr/bin/env', '-i'])
    if (provider === 'codex') assert.deepEqual(args.slice(-4), [
      owner + '/.local/bin/codex', '-c', 'cli_auth_credentials_store="file"', 'login',
    ])
    else assert.deepEqual(args.slice(-3), [owner + '/.local/bin/claude', 'auth', 'login'])
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'terminal', 'title'])
  })
}

test('named home is literal data; reused terminal server cannot choose another account', async () => {
  const home = '/fixture/named home/quote" dollar$ semi; amp& tick' + String.fromCharCode(96)
  const { service, calls } = fixture({ env: {
    DISPLAY: ':42', XDG_RUNTIME_DIR: '/run/user/1234', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
    XDG_DATA_DIRS: '/fixture/browser-export/share:/usr/share', XDG_CONFIG_DIRS: '/fixture/desktop-config:/etc/xdg',
    ANTHROPIC_API_KEY: 'fixture-secret', OPENAI_API_KEY: 'fixture-secret',
    BROWSER: '/fixture/hostile', BASH_ENV: '/fixture/hostile', ENV: '/fixture/hostile',
    NODE_OPTIONS: '--require=/fixture/hostile', NODE_PATH: '/fixture/hostile',
    LD_PRELOAD: '/fixture/hostile', ELECTRON_RUN_AS_NODE: '1',
  } })
  assert.equal((await service.start('claude', { home, label: 'School & personal' })).ok, true)
  const [, args, { env }] = calls[0]
  assert.equal(env.HOME, owner)
  assert.equal(env.CLAUDE_CONFIG_DIR, home)
  assert.equal(env.DISPLAY, ':42')
  assert.equal(env.XDG_DATA_DIRS, '/fixture/browser-export/share:/usr/share')
  assert.equal(env.XDG_CONFIG_DIRS, '/fixture/desktop-config:/etc/xdg')
  assert.ok(args.includes('XDG_DATA_DIRS=' + env.XDG_DATA_DIRS))
  assert.ok(args.includes('XDG_CONFIG_DIRS=' + env.XDG_CONFIG_DIRS))
  assert.ok(args.includes('CLAUDE_CONFIG_DIR=' + home))
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BROWSER', 'BASH_ENV', 'ENV',
    'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'ELECTRON_RUN_AS_NODE', 'CODEX_HOME']) {
    assert.equal(Object.hasOwn(env, key), false, key)
    assert.equal(args.some(word => word.startsWith(key + '=')), false, key)
  }
})

test('missing or non-executable CLI, missing terminal, and relative account home do not open a window', async () => {
  for (const options of [
    { files: [] },
    { denied: [owner + '/.local/bin/codex'] },
    { files: [owner + '/.local/bin/codex'] },
  ]) {
    const { service, calls } = fixture(options)
    assert.equal((await service.start('codex')).ok, false)
    assert.equal(calls.length, 0)
  }
  const { service, calls } = fixture()
  assert.equal((await service.start('codex', { home: 'relative' })).code, 'PROVIDER_LOGIN_HOME_UNAVAILABLE')
  assert.equal(calls.length, 0)
})

test('asynchronous terminal rejection reaches the caller without an opened claim', async () => {
  const { service } = fixture({ open: async () => { throw new Error('/private/path') } })
  const result = await service.start('claude')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROVIDER_LOGIN_SPAWN_FAILED')
  assert.equal(JSON.stringify(result).includes('/private/path'), false)
})

test('an incomplete or denied Linux CLI search is unknown, never an instruction to reinstall', async () => {
  for (const options of [
    { denied: [owner + '/.local/bin/codex'] },
    { files: [], env: { PATH: 'relative' } },
  ]) {
    const { service, calls } = fixture(options)
    assert.equal((await service.start('codex')).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
    assert.throws(() => service.installed('codex'), /INSTALL_CHECK_FAILED/)
    assert.equal(calls.length, 0)
  }
})

test('Gemini default selects its HOME root, not a nested .gemini directory', async () => {
  const { service, calls } = fixture({ files: [
    owner + '/.local/bin/gemini', '/usr/bin/gnome-terminal', '/usr/bin/env', '/bin/bash',
  ] })
  assert.equal((await service.start('gemini')).ok, true)
  assert.equal(calls[0][2].env.GEMINI_CLI_HOME, owner)
  assert.deepEqual(calls[0][1].slice(-3), [owner + '/.local/bin/gemini', '--prompt-interactive', '/quit'])
})

test('cloud-account composition awaits the same login acknowledgement and preserves recorded truth on failure', async () => {
  for (const accepted of [true, false]) {
    let recorded = 0
    const { service } = fixture({ open: () => accepted ? Promise.resolve() : Promise.reject(new Error('fixture')) })
    const setup = createCloudAccountSetup({
      providerLogin: service,
      addAccount: () => { recorded++; return { name: 'School', home: '/fixture/school' } },
    })
    const result = await setup.add({ name: 'School' })
    assert.equal(recorded, 1)
    assert.equal(result.ok, true)
    assert.equal(result.signInOpened, accepted)
  }
})

test('default Linux presence checks the same OS home as tree, not ambient account selectors', () => {
  const inspected = []
  providerCliPresence({
    platform: 'linux', env: { HOME: '/wrong', CODEX_HOME: '/wrong/codex', CLAUDE_CONFIG_DIR: '/wrong/claude' },
    homedir: () => owner, searchPath: { directories: [], complete: true },
    existsSync: target => { inspected.push(target); return false },
  })
  assert.ok(inspected.includes(owner + '/.codex/auth.json'))
  assert.ok(inspected.includes(owner + '/.claude/.credentials.json'))
  assert.equal(inspected.some(target => target.startsWith('/wrong')), false)
})

test('real POSIX env/bash preserve hostile-looking arguments and remove inherited selectors', {
  skip: platformSkipReason('linux'),
}, () => {
  const value = 'space quote" dollar$ semicolon; ampersand& newline\nliteral'
  const code = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,key:process.env.OPENAI_API_KEY||null,hook:process.env.BASH_ENV||null}));process.exit(23)'
  const invocation = linuxTerminalInvocation({ program: '/usr/bin/gnome-terminal', kind: 'linux-gnome-terminal' },
    ['/usr/bin/env', ...(process.versions.electron ? ['ELECTRON_RUN_AS_NODE=1'] : []),
      process.execPath, '-e', code, value], {
      title: 'ToolsEnabled sign-in fixture', line: 'inert fixture',
      env: { HOME: '/fixture/owner', PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: value },
    })
  const words = invocation.args.slice(invocation.args.indexOf('--') + 1)
  const result = spawnSync(words[0], words.slice(1), {
    env: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'fixture-only', BASH_ENV: '/fixture/not-run' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 23)
  const output = result.stdout.slice(result.stdout.indexOf('{"args":'), result.stdout.indexOf('\nSign-in command'))
  assert.deepEqual(JSON.parse(output), { args: [value], home: '/fixture/owner', config: value, key: null, hook: null })
})

const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

test('Linux sign-in closes on success with an open terminal input and keeps a failure readable until Enter', {
  skip: platformSkipReason('linux'),
}, async () => {
  for (const status of [0, 23]) {
    const invocation = linuxTerminalInvocation({ program: '/usr/bin/gnome-terminal', kind: 'linux-gnome-terminal' },
      ['/bin/bash', '--noprofile', '--norc', '-c', 'exit "$1"', 'fixture', String(status)], {
        title: 'ToolsEnabled sign-in fixture', line: 'inert fixture',
        env: { HOME: '/fixture/owner', PATH: '/usr/bin:/bin' },
      })
    const words = invocation.args.slice(invocation.args.indexOf('--') + 1)
    const child = spawn(words[0], words.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let closed = false
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
    })
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.stdout.on('data', chunk => {
          output += chunk
          if (status === 0 || output.includes('Press Enter to close.')) resolve()
        })
        child.once('close', () => { if (status !== 0) reject(new Error('Failure window closed before Enter')) })
      })
      if (status !== 0) {
        assert.equal(closed, false)
        child.stdin.write('\n')
      }
      assert.deepEqual(await completion, { code: status, signal: null })
      assert.equal(output.includes('Press Enter to close.'), status !== 0)
    } finally {
      clearTimeout(deadline)
      child.stdin.destroy()
      if (!closed) { child.kill('SIGKILL'); await completion }
    }
  }
})

test('real main opener waits for GNOME acceptance and handles exec/DBus rejection', async () => {
  const opener = main.slice(main.indexOf('function openTerminalWindow('), main.indexOf('/* THE LOCAL-MODEL READER'))
  for (const event of ['accepted', 'rejected', 'error']) {
    const child = new EventEmitter()
    child.unref = () => {}
    child.stderr = new PassThrough()
    const context = {
      spawnChildProcess: (_command, _args, options) => {
        assert.deepEqual(Array.from(options.stdio), ['ignore', 'ignore', 'pipe'])
        return child
      },
      acknowledgeGnomeTerminal, TERMINAL_WINDOW_IS_THE_POINT: false,
      PROVIDER_ISOLATION_REQUESTED: false,
      setTimeout, clearTimeout, consoleWindowArgs() { throw new Error('No cmd.exe on Linux') },
    }
    vm.createContext(context)
    vm.runInContext(opener, context)
    const result = context.openTerminalWindow('/usr/bin/gnome-terminal', [], {
      env: {}, kind: 'linux-gnome-terminal',
    })
    let settled = false
    result.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    if (event === 'error') child.emit('error', new Error('fixture'))
    else child.emit('close', event === 'accepted' ? 0 : 1, null)
    if (event === 'accepted') await result
    else await assert.rejects(result, /TERMINAL_UNCONFIRMED/)
  }
})

test('GNOME exit cannot settle before the final client diagnostic is drained', async () => {
  const child = new EventEmitter()
  child.stderr = new PassThrough()
  const pending = acknowledgeGnomeTerminal(child)
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false)
  child.stderr.write('# Error creating term')
  child.stderr.end('inal: fixture failure\n')
  child.emit('close', 0, null)
  await assert.rejects(pending, /TERMINAL_UNCONFIRMED/)
})

test('both actual main IPC handlers retain asynchronous login results and arm named watch only after acceptance', async () => {
  const handlers = new Map()
  let watched = 0
  let accept
  const pending = new Promise(resolve => { accept = resolve })
  const context = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    assertTrustedAgentSender() {}, agentPayload: value => value,
    boundedAgentString: value => value, rendererSafeAgentError: error => error,
    accountAnswer: fn => fn(), accountRegistry: { homeOf: () => ({ provider: 'codex', name: 'School', directory: '/fixture/school' }) },
    providerLoginService: { start: () => pending },
    armSignInWatch: () => { watched++; return true },
  }
  vm.createContext(context)
  for (const name of ['mc-accounts:sign-in', 'mc-provider-login:start']) {
    const start = main.indexOf("ipcMain.handle('" + name + "'")
    const end = main.indexOf('\n})', start) + 3
    vm.runInContext(main.slice(start, end), context)
  }
  const named = handlers.get('mc-accounts:sign-in')({ sender: {} }, { provider: 'codex', name: 'School' })
  const ordinary = handlers.get('mc-provider-login:start')({}, { provider: 'codex' })
  assert.equal(watched, 0)
  accept({ ok: true, terminal: 'linux-gnome-terminal', title: 'School' })
  assert.equal((await named).ok, true)
  assert.equal((await ordinary).ok, true)
  assert.equal(watched, 1)
  context.providerLoginService.start = async () => ({ ok: false, code: 'PROVIDER_LOGIN_SPAWN_FAILED' })
  assert.equal((await handlers.get('mc-accounts:sign-in')({ sender: {} }, { provider: 'codex', name: 'School' })).ok, false)
  assert.equal((await handlers.get('mc-provider-login:start')({}, { provider: 'codex' })).ok, false)
  assert.equal(watched, 1)
})

test('main account resolver cannot silently substitute default on a selection failure', async () => {
  const start = main.indexOf('async function resolveSessionAccount(')
  const end = main.indexOf('\n}\n', start) + 2
  for (const platform of ['linux', 'win32']) {
    const context = {
      process: { platform }, ACCOUNT_HOME_DIR: '/fixture/owner',
      ACCOUNT_REGISTRY_FILE: '/fixture/accounts.json', PROVIDER_ISOLATION_REQUESTED: false,
      loadRotation: () => ({ resolveAccountForSession: async () => { throw new Error('/fixture/private-error') } }),
      selectionPolicyFromRegistry: () => null, resolveServicesRootForAccounts: () => '/fixture/services',
    }
    vm.createContext(context)
    vm.runInContext(main.slice(start, end), context)
    const promise = context.resolveSessionAccount({ provider: 'codex' })
    await assert.rejects(promise, error =>
      error.code === 'AGENT_ACCOUNT_UNAVAILABLE' && !error.message.includes('/fixture/private-error'))
    context.loadRotation = () => null
    const unavailable = context.resolveSessionAccount({ provider: 'codex' })
    await assert.rejects(unavailable, { code: 'AGENT_ACCOUNT_UNAVAILABLE' })
  }
})


test('Antigravity sign-in uses the selected configuration HOME with standard XDG and the native agy client', async () => {
  const {service,calls}=fixture({files:[owner+'/.local/bin/agy','/usr/bin/gnome-terminal','/usr/bin/env','/bin/bash']})
  const home='/fixture/agy-config'
  const answer=await service.start('gemini',{client:'antigravity',home,label:'current OS sign-in'})
  assert.equal(answer.ok,true)
  assert.match(answer.title,/agy/)
  assert.equal(calls.length,1)
  const args=calls[0][1]
  assert(args.includes('HOME='+home))
  assert(args.includes('USERPROFILE='+home))
  assert(args.includes('XDG_CONFIG_HOME='+home+'/.config'))
  assert(args.includes('XDG_DATA_HOME='+home+'/.local/share'))
  assert.equal(args.at(-1),owner+'/.local/bin/agy')
  assert(!args.includes(owner+'/.local/bin/gemini'))
})
