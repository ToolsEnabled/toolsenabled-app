import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { parseAst } from 'rollup/parseAst'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { createAgentHost, START_REFUSAL_CODES } from '../../shell/agent-host.cjs'
import { unavailableReason } from '../../src/agent-availability-copy.js'
const require = createRequire(import.meta.url)
const { fencedAccountEnvironment, nativeClaudeHomeStartAnswer, NATIVE_CLAUDE_HOME_UNUSABLE_CODE } = require('../../shell/install-profile-guard.cjs')
const hasClaudeHome = environment => Object.keys(environment).some(name => name.toUpperCase() === 'CLAUDE_CONFIG_DIR')
const engineRoot = canonicalRootForTests({ warn: () => {} })
const planner = require(path.join(engineRoot, 'src/lib/agent-session-confinement.js'))
const machineRecord = require(path.join(engineRoot, 'src/lib/setup/machine-record.js'))
const claude = require(path.join(engineRoot, 'src/lib/agent-engine/claude-cli-process.js'))
const enginePath = path.join(engineRoot, 'src/lib/agent-engine/codex-process.js')

const missingPaths = { lstatSync() { throw Object.assign(new Error('Synthetic missing path'), { code: 'ENOENT' }) } }
for (const spelling of ['CLAUDE_CONFIG_DIR', 'Claude_Config_Dir']) {
  test('Windows startup retains native Claude home and sets aside another account’s / ' + spelling, () => {
    const profile = String.raw`${"\x58:\\Users\\SyntheticOwner"}`, home = path.win32.join(profile, 'claude-config')
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, [spelling]: home }, filesystem: missingPaths })
    assert.equal(result.ok, true)
    assert.equal(result.environment[spelling], home)
    let probes = 0
    const refused = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, [spelling]: String.raw`${"\x58:\\Users\\SyntheticOther\\claude"}` },
      filesystem: { lstatSync(target) {
        if (target.includes('SyntheticOther')) probes++
        throw Object.assign(new Error('Synthetic missing path'), { code: 'ENOENT' })
      } } })
    /* 1.0.50 review, accounts B: another account's folder is never used, but
       it no longer stops ToolsEnabled from opening. It is set aside. */
    assert.equal(refused.ok, true)
    assert.deepEqual(refused.claudeConfigDirSetAside, { variable: 'CLAUDE_CONFIG_DIR', reason: 'other-account' })
    assert.equal(hasClaudeHome(refused.environment), false, 'another account’s folder is not passed on')
    assert.equal(probes, 0)
  })
}
test('Windows startup sets aside a Claude home escaping through a link or naming a network path, and still opens', () => {
  const profile = String.raw`${"\x58:\\Users\\SyntheticOwner"}`, linked = path.win32.join(profile, 'linked')
  for (const home of [linked, String.raw`\\server\share\claude`]) {
    let foreignProbes = 0
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: home }, filesystem: {
        lstatSync(target) {
          if (target === linked) return { isSymbolicLink: () => true }
          if (target.includes('SyntheticOther')) foreignProbes++
          return { isSymbolicLink: () => false }
        }, readlinkSync() { return String.raw`${"\x58:\\Users\\SyntheticOther\\claude"}` },
      } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.claudeConfigDirSetAside, { variable: 'CLAUDE_CONFIG_DIR', reason: home === linked ? 'other-account' : 'unsupported-path' })
    assert.equal(hasClaudeHome(result.environment), false)
    assert.equal(foreignProbes, 0)
  }
})

/* 1.0.50 REVIEW, ACCOUNTS B. c9 held CLAUDE_CONFIG_DIR to the inside-the-profile
   rule, so a Windows person who keeps Claude Code's configuration on another
   drive or outside <profile-root>/<name> got a startup refusal and could not open
   ToolsEnabled at all (1.0.48 opened normally). It is now checked like PATH and
   TEMP: only another account's folder is refused, and even that is set aside
   rather than ending the launch. */
test('Windows startup keeps a Claude home outside the profile that is not another account’s', () => {
  const profile = String.raw`${"\x43:\\Users\\Owner"}`
  // A drive root (E:\ or E:/) is a full path too (platform review S4). A
  // quoted one is kept and handed on without its quotes (review of fixes 3.7).
  for (const [home, handedOn] of [[String.raw`${"\x44:\\Claude"}`], [String.raw`${"\x43:\\ClaudeConfig"}`], [String.raw`${"\x45:\\Tools\\claude-config"}`],
    ['\x45:\\'], ['\x45:/'], ['"\x45:\\"', '\x45:\\']]) {
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: home }, filesystem: missingPaths })
    assert.equal(result.ok, true, `${home}: ${result.message || ''}`)
    assert.equal(result.environment.CLAUDE_CONFIG_DIR, handedOn ?? home)
    assert.equal(result.claudeConfigDirSetAside, undefined)
  }
  // A folder in the profile that is a junction to another drive is kept too.
  const linked = path.win32.join(profile, '.claude')
  const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
    environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: linked }, filesystem: {
      lstatSync(target) { return { isSymbolicLink: () => target === linked } },
      readlinkSync() { return String.raw`${"\x44:\\Claude"}` },
    } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.environment.CLAUDE_CONFIG_DIR, linked)
  assert.equal(result.claudeConfigDirSetAside, undefined)
})
/* 1.0.50 REVIEW OF FIXES, 3.7. The guard decided "full path" on the spelling
   without surrounding double quotes but handed the quoted spelling on, and no
   reader of CLAUDE_CONFIG_DIR strips quotes: the engine's confinement planner
   and the Claude launcher both decide "full path" with path.isAbsolute, which
   on Windows is path.win32.isAbsolute, and both refused. The kept value is now
   handed on unquoted, under the inherited name spelling. */
test('Windows startup hands a kept quoted Claude home on without its quotes, so every reader sees a full path', () => {
  const profile = String.raw`${"\x43:\\Users\\Owner"}`
  for (const [spelling, home, handedOn] of [
    ['CLAUDE_CONFIG_DIR', '"\x45:\\"', '\x45:\\'],
    ['Claude_Config_Dir', '"\x45:\\"', '\x45:\\'],
    ['CLAUDE_CONFIG_DIR', String.raw`${"\"\x44:\\Claude Config\""}`, String.raw`${"\x44:\\Claude Config"}`],
    ['CLAUDE_CONFIG_DIR', ` "${profile}\\claude" `, `${profile}\\claude`],
  ]) {
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, [spelling]: home }, filesystem: missingPaths })
    assert.equal(result.ok, true, `${home}: ${result.message || ''}`)
    assert.equal(result.claudeConfigDirSetAside, undefined)
    assert.deepEqual(Object.keys(result.environment).filter(name => name.toUpperCase() === 'CLAUDE_CONFIG_DIR'), [spelling])
    assert.equal(result.environment[spelling], handedOn)
    assert.equal(path.win32.isAbsolute(result.environment[spelling]), true, 'the readers’ own full-path test')
  }
  // An unquoted value is still handed on exactly as inherited.
  const plain = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
    environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: '\x45:\\Claude ' }, filesystem: missingPaths })
  assert.equal(plain.ok, true)
  assert.equal(plain.environment.CLAUDE_CONFIG_DIR, '\x45:\\Claude ')
  // A quoted value that is not a full path is still set aside, not handed on.
  const relative = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
    environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: '"claude-config"' }, filesystem: missingPaths })
  assert.deepEqual(relative.claudeConfigDirSetAside, { variable: 'CLAUDE_CONFIG_DIR', reason: 'not-absolute' })
  assert.equal(hasClaudeHome(relative.environment), false)
})
test('Windows startup sets aside a relative Claude home instead of refusing to open', () => {
  const profile = String.raw`${"\x43:\\Users\\Owner"}`
  for (const home of ['claude-config', String.raw`C:claude-config`, 'E:', '"E:"']) {
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, CLAUDE_CONFIG_DIR: home }, filesystem: missingPaths })
    assert.equal(result.ok, true, home)
    assert.deepEqual(result.claudeConfigDirSetAside, { variable: 'CLAUDE_CONFIG_DIR', reason: 'not-absolute' })
    assert.equal(hasClaudeHome(result.environment), false)
  }
})
test('Windows startup still refuses the profile paths it fences, without naming a usable Claude home', () => {
  const profile = String.raw`${"\x43:\\Users\\Owner"}`
  for (const home of [String.raw`${"\x44:\\Claude"}`, String.raw`${"\x43:\\Users\\Other\\claude"}`]) {
    const result = fencedAccountEnvironment({ platform: 'win32', fencedProfile: profile,
      environment: { USERPROFILE: profile, APPDATA: String.raw`${"\x44:\\Roaming"}`, CLAUDE_CONFIG_DIR: home }, filesystem: missingPaths })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ACCOUNT_ENVIRONMENT_OUTSIDE_PROFILE_FENCE')
    assert.deepEqual([...result.variables], ['APPDATA'])
  }
})
test('a default Claude start is refused by name when startup set its folder aside; named accounts are not', () => {
  const setAside = { variable: 'CLAUDE_CONFIG_DIR', reason: 'other-account' }
  for (const selection of [{ rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' },
    { rotated: false, account: null, code: 'ACCOUNTS_NONE_FOR_PROVIDER' }, null]) {
    const answer = nativeClaudeHomeStartAnswer(setAside, selection)
    assert.equal(answer.blocked, true)
    assert.equal(answer.account, null)
    assert.equal(answer.code, NATIVE_CLAUDE_HOME_UNUSABLE_CODE)
    assert.match(answer.reason, /CLAUDE_CONFIG_DIR .* is in another Windows account, so ToolsEnabled did not use it\./)
  }
  assert.equal(nativeClaudeHomeStartAnswer(null, { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }), null)
  assert.equal(nativeClaudeHomeStartAnswer(setAside, { rotated: true, account: { name: 'named', provider: 'claude' } }), null)
  const blocked = { rotated: false, account: null, blocked: true, code: 'ACCOUNT_EXHAUSTED', reason: 'spent' }
  assert.equal(nativeClaudeHomeStartAnswer(setAside, blocked), null, 'the resolver’s own refusal is kept')
  // The code is a start refusal with plain copy, not an identifier on the glass.
  assert.ok(START_REFUSAL_CODES.includes(NATIVE_CLAUDE_HOME_UNUSABLE_CODE))
  const copy = unavailableReason(NATIVE_CLAUDE_HOME_UNUSABLE_CODE, { platform: 'win32' })
  assert.match(copy, /Claude Code’s own folder setting/)
  assert.doesNotMatch(copy, /[A-Z]+_[A-Z_]+/)
})

async function fixture(t, { named = false, cold = false } = {}) {
  const savedEnvironment = { ...process.env }
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-claude-home-')))
  const home = path.join(directory, 'native-home'), namedHome = path.join(directory, 'named-home')
  fs.mkdirSync(home); fs.mkdirSync(namedHome)
  // Every process-level auth selector for this test is synthetic. No real
  // Claude executable or credential file is opened: only the protocol boundary
  // is replaced, after the real startup guard and confinement planner run.
  process.env.CLAUDE_CONFIG_DIR = home
  const guarded = fencedAccountEnvironment({ environment: process.env, fencedProfile: os.userInfo().homedir })
  assert.equal(guarded.ok, true)
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, guarded.environment)
  const record = machineRecord.buildMachineRecord({ tier: 'standard', installRoot: engineRoot,
    servicesRoot: directory, nodePath: process.execPath, workspaceRoots: [directory] })
  machineRecord.writeMachineRecord(record, { servicesRoot: directory })
  const launches = [], selections = [], hosts = []
  const launch = async (kind, request) => {
    const childEnv = claude.configDirEnvironment({ ...request.env }, request.plan?.configDir || request.configDir)
    const child = spawnSync(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({ homeMatches: process.env.CLAUDE_CONFIG_DIR === process.env.SYNTHETIC_EXPECTED_HOME }))'],
      { env: { ...childEnv, SYNTHETIC_EXPECTED_HOME: named ? namedHome : home }, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0)
    launches.push({ kind, request, homeMatches: JSON.parse(child.stdout).homeMatches })
    const threadId = request.threadId || '11111111-1111-4111-8111-111111111111'
    const adapter = { sendTurn: async () => {
      await request.onEvent?.({ type: 'turn_completed', status: 'success', threadId, turnId: 'synthetic-turn' })
      return { turnId: 'synthetic-turn' }
    }, interrupt: async () => {}, answerApproval() {} }
    return { adapter, threadId, resumed: { turns: [], turnCount: 0 }, close() {} }
  }
  t.mock.method(claude, 'startClaudeSession', request => launch('start', request))
  t.mock.method(claude, 'resumeClaudeSession', request => launch('resume', request))
  const makeHost = () => {
    const host = createAgentHost({ enginePath, defaultCwd: directory, freeMemory: () => 64 * 1024 ** 3,
      resumeOriginDirectory: path.join(directory, 'origins'),
      accountResolver: async request => { selections.push(request); return named
        ? { rotated: true, account: { provider: 'claude', name: request.preferred || 'synthetic-named', resolvedHome: namedHome } }
        : { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' } },
      confinementPlanner: options => planner.claudeToolsSessionPlan({ ...options, servicesRoot: directory }),
      sessionAuthority: { toolModeVersion: 1,
        bind: async () => ({ bound: true, mode: 'owner-host', credential: randomBytes(32).toString('base64url') }),
        revoke: async () => ({ revoked: true }) },
    })
    hosts.push(host); return host
  }
  let host = makeHost()
  const { document, restore } = installDomStandIn()
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const root = document.createElement('div'); document.body.appendChild(root)
  const listeners = new Set()
  const bindEvents = () => host.onEvent(packet => { for (const receive of listeners) receive(packet) })
  bindEvents()
  let controller
  const bridge = { availability: async () => ({ ok: true }), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    start: request => host.startSession(request), send: request => host.sendTurn(request),
    interrupt: request => host.interrupt(request), close: request => host.closeSession(request) }
  const release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true,
    onController: value => { controller = value }, getStartOptions: () => ({ tier: 'claude-sonnet-5' }) })
  t.after(async () => {
    release(); for (const value of hosts) await value.closeAll()
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage
    restore()
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, savedEnvironment)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { home, namedHome, launches, selections, controller,
    reopen: async () => { await host.closeAll(); host = makeHost(); bindEvents() },
    changeDefault: () => { const later = path.join(directory, 'later-home'); fs.mkdirSync(later); process.env.CLAUDE_CONFIG_DIR = later },
    cold }
}

for (const cold of [false, true]) {
  test('mounted default-Claude fresh Start and ' + (cold ? 'cold' : 'warm') + ' Stop/Send resume keep the native home', async t => {
    const f = await fixture(t, { cold })
    assert.equal((await f.controller.send('Remember SYNTHETICWORD.')).ok, true)
    assert.equal(f.launches.length, 1)
    assert.equal(f.launches[0].homeMatches, true, 'native child must receive the app launch CLAUDE_CONFIG_DIR')
    assert.deepEqual(fs.readdirSync(f.home), [], 'planning must leave the native sign-in home untouched')
    assert.equal((await f.controller.terminate()).ok, true)
    if (cold) await f.reopen()
    assert.equal((await f.controller.send('Recall SYNTHETICWORD.')).ok, true)
    assert.deepEqual(f.launches.map(value => value.kind), ['start', 'resume'])
    assert.equal(f.launches[1].homeMatches, true)
    assert.equal(f.launches[1].request.threadId, '11111111-1111-4111-8111-111111111111')
    assert.equal(f.selections.length, 1, 'default resume must not ask for a newly selected account')
  })
  test('mounted default-Claude ' + (cold ? 'cold' : 'warm') + ' resume refuses a changed native home before dispatch', async t => {
    const f = await fixture(t, { cold })
    assert.equal((await f.controller.send('Remember SYNTHETICWORD.')).ok, true)
    assert.equal((await f.controller.terminate()).ok, true)
    if (cold) await f.reopen()
    f.changeDefault()
    const result = await f.controller.send('Recall SYNTHETICWORD.')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AGENT_RESUME_HOME_UNAVAILABLE')
    assert.equal(f.launches.length, 1, 'changed-home refusal must precede native dispatch')
  })
}
test('mounted explicit Claude account takes precedence over the app default on fresh Start and cold resume', async t => {
  const f = await fixture(t, { named: true, cold: true })
  assert.equal((await f.controller.send('Remember SYNTHETICWORD.')).ok, true)
  assert.equal(f.launches[0].homeMatches, true)
  assert.equal((await f.controller.terminate()).ok, true)
  await f.reopen(); f.changeDefault()
  assert.equal((await f.controller.send('Recall SYNTHETICWORD.')).ok, true)
  assert.equal(f.launches[1].homeMatches, true)
  assert.equal(f.selections[1].preferred, 'synthetic-named')
  assert.equal(f.selections[1].persistSelection, false)
})
for (const [platform, spelling] of [['linux', 'CLAUDE_CONFIG_DIR'], ['win32', 'CLAUDE_CONFIG_DIR'], ['win32', 'Claude_Config_Dir']]) {
  test(platform + ': real main legacy default-Claude resolver retains the native home and refuses changes / ' + spelling, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'default-claude-legacy-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const nodeId = 'standalone-11111111-1111-4111-8111-111111111111', sessionId = 'legacy-session', threadId = 'legacy-thread'
    const transcript = { computerId: 'synthetic-computer', nodeId }
    const metadata = { ...transcript, threadId, provider: 'claude', account: null, home: directory }
    const environment = { [spelling]: directory }
    const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8'), ast = parseAst(main)
    const build = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'buildAgentHost')
    const declaration = build.body.body.find(node => node.type === 'VariableDeclaration'
      && node.declarations.some(value => value.id.name === 'legacyResumeOriginResolver'))
    const resolve = new Function('require', 'readSavedStandaloneTabs', 'readStandaloneTranscript', 'accountRegistry', 'process', 'path', 'ACCOUNT_HOME_DIR',
      main.slice(declaration.start, declaration.end) + '\nreturn legacyResumeOriginResolver')(
      createRequire(new URL('../../shell/main.cjs', import.meta.url)), () => JSON.stringify({ v: 1, tabs: [{ id: nodeId, sessionId }] }), async () => ({ ok: true, metadata }),
      { homeOf() { throw new Error('Default resume must never select a named account') } }, { env: environment, platform }, path, directory)
    const request = { sessionId, threadId, provider: 'claude', account: null, agentId: null, transcript }
    const origin = await resolve(request)
    assert.equal(origin.home, directory)
    environment[spelling] = path.join(directory, 'changed')
    assert.throws(() => origin.assertCurrent(), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
    await assert.rejects(resolve(request), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
    // With no native selector, the provider default is the owning profile's
    // .claude directory. Lowercase names on Linux are unrelated variables.
    delete environment[spelling]
    if (platform === 'linux') environment.Claude_Config_Dir = directory
    metadata.home = path.join(directory, '.claude')
    assert.equal((await resolve(request)).home, metadata.home)
  })
}
