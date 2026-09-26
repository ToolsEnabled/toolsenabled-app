// Source-only QA controls. No Electron, provider, credential source or remote
// connection is used; generated canaries are never authentication material.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { optionsFrom, electronLaunchArguments } from '../page2-native-audit.cjs'
import { selectScenarios } from '../lib/page2-native-report.cjs'
import { scenarios, waitForWorkspacePath, firstUseVisibleExit } from '../lib/page2-native-first-use-scenarios.cjs'
import { CASE_IDS, HOME_KEYS, validateFirstUseOptions, prepareFirstUseProfile,
  ownedPath, readOwnedJSON, scanCredentialNames, postBootstrapHomes, createFirstUseLifecycle,
  readFirstUseState, assertSavedState, retainedState } from '../lib/page2-native-first-use.cjs'
import accountGuard from '../../shell/install-profile-guard.cjs'

const { fencedAccountEnvironment } = accountGuard

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-first-use-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const request = () => ({ sterileFirstUse: true, realProvider: false, level: 'standard', cases: [CASE_IDS.at(-1)] })

test('sterile mode is opt-in and preserves ordinary authenticated parser/launch arguments', () => {
  const ordinary = optionsFrom(['--real-provider'])
  assert.equal(ordinary.realProvider, true); assert.equal(ordinary.sterileFirstUse, undefined)
  assert.deepEqual(electronLaunchArguments('/runtime', '/owned/profile', ordinary, 'linux'), ['/runtime', '--user-data-dir=/owned/profile'])
  assert.equal(validateFirstUseOptions(request(), 'linux'), true)
  if (process.platform === 'linux') assert.equal(optionsFrom(['--sterile-first-use', '--case', CASE_IDS.at(-1)]).sterileFirstUse, true)
  assert.throws(() => validateFirstUseOptions(request(), 'win32'), /Linux-only/)
  for (const change of [r => { r.realProvider = true }, r => { r.codexProfileHome = '/not-read' },
    r => { r.codexAccountIdSha256 = 'a'.repeat(64) }, r => { r.level = 'guided' }, r => { r.cases = [] },
    r => { r.cases = ['root-start'] }, r => { r.cases = [CASE_IDS[0], CASE_IDS[0]] }, r => { r.sterileFirstUse = 'true' }, r => { r.sterileFirstUse = false }]) {
    const r = request(); change(r); assert.throws(() => validateFirstUseOptions(r, 'linux'))
  }
  assert.throws(() => optionsFrom(['--sterile-first-use', '--sterile-first-use', '--case', CASE_IDS[0]]), /Duplicate/)
  assert.throws(() => optionsFrom(['--sterile-first-use', '--real-provider', '--case', CASE_IDS[0]]))
  assert.throws(() => optionsFrom(['--sterile-first-use=true']), /Unknown/)
})

test('literal first-use closure contains startup and all five exact prerequisites once', () => {
  assert.deepEqual(scenarios.map(row => row.id), ['startup', ...CASE_IDS])
  const inventory = scenarios
  assert.deepEqual(selectScenarios(inventory, [CASE_IDS.at(-1)]).map(row => row.id), ['startup', ...CASE_IDS])
  assert.deepEqual(selectScenarios(inventory, [CASE_IDS[0]]).map(row => row.id), ['startup', CASE_IDS[0]])
})

test('authenticated context cannot enter any sterile-only case callback', async () => {
  for (const row of scenarios.filter(row => row.id !== 'startup')) await assert.rejects(row.run({ options: { realProvider: true }, firstUse: null,
    unavailable(message) { throw new Error(message) } }), /explicitly selected sterile/)
})

test('native chooser closure alone cannot satisfy the exact mounted workspace postcondition', async () => {
  const expected = path.resolve('/generated-source-only/workspace')
  let rendered = null, predicate, finish, settled = false
  const waiting = waitForWorkspacePath({ paths: { workspace: expected }, page: {
    waitForFunction(callback, argument, options) {
      assert.equal(argument, expected); assert.deepEqual(options, { timeout: 12000 })
      // Execute the actual browser predicate against a controlled DOM view.
      // No browser is launched and no native chooser result is fabricated.
      const document = { querySelector(selector) { assert.equal(selector, '.setup-root-path'); return rendered } }
      predicate = () => vm.runInNewContext('(' + callback.toString() + ')(expected)', { document, expected })
      return new Promise(resolve => { finish = resolve })
    },
  } }).then(() => { settled = true })
  assert.equal(predicate(), false); await Promise.resolve(); assert.equal(settled, false)
  rendered = { innerText: expected + '-different' }
  assert.equal(predicate(), false); await Promise.resolve(); assert.equal(settled, false)
  rendered.innerText = expected
  assert.equal(predicate(), true); finish(); await waiting; assert.equal(settled, true)
})

test('generated profile strips ambient credentials and leaves a separate source canary untouched', t => {
  if (process.platform !== 'linux') {
    assert.throws(() => prepareFirstUseProfile(scratch(t)), /linux/)
    return
  }
  const root = scratch(t), qaRoot = path.join(root, 'qa'), source = path.join(root, 'source-canary')
  fs.mkdirSync(qaRoot); fs.mkdirSync(source)
  const canary = path.join(source, 'canary.txt'); fs.writeFileSync(canary, 'generated control; not a credential')
  const prepared = prepareFirstUseProfile(qaRoot, { ...process.env, HOME: source, CODEX_HOME: source,
    OPENAI_API_KEY: 'generated-test-value', ANTHROPIC_API_KEY: 'generated-test-value', NODE_OPTIONS: '--not-run',
    NODE_PATH: source, MC_STATE_ROOT: source, TOOLSENABLED_STATE_ROOT: source, TOOLSENABLED_SETTINGS_PATH: path.join(source, 'settings.json') })
  for (const key of HOME_KEYS) assert.ok(prepared.environment[key].startsWith(path.join(qaRoot, 'profile') + path.sep), key)
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'MC_STATE_ROOT', 'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_SETTINGS_PATH']) assert.equal(prepared.environment[key], undefined)
  assert.deepEqual(fs.readdirSync(prepared.environment.CODEX_HOME), [])
  assert.deepEqual(prepared.receipt.initialPreferences, { path: path.join(qaRoot, 'ToolsEnabled-Page2-QA/renderer-prefs.json'), absent: true })
  assert.equal(prepared.inspect(path.join(qaRoot, 'ToolsEnabled-Page2-QA')).starts, 0)
  assert.equal(fs.readFileSync(canary, 'utf8'), 'generated control; not a credential')
  assert.throws(() => prepareFirstUseProfile(qaRoot), /fresh profile/)
})

test('the actual main bootstrap and account guard remove the generated provider selector and retain all eight other homes', () => {
  const homes = Object.fromEntries(HOME_KEYS.map(key => [key, path.resolve('/generated-source-only', key)]))
  const launch = { ...homes, CLAUDE_CONFIG_DIR: '/generated-source-only/claude', GEMINI_DIR: '/generated-source-only/gemini',
    NODE_OPTIONS: '--generated-never-executed', NODE_PATH: '/generated-source-only/loader', PUBLIC: '/generated-source-only/public' }
  const supplied = structuredClone(launch), observedProcess = { env: supplied, exit: () => assert.fail('Unexpected bootstrap refusal') }
  const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf('const accountEnvironmentCheck = fencedAccountEnvironment({')
  const end = main.indexOf('\n/* userData is the one storage identity', start)
  assert.ok(start > 0 && end > start, 'Use the actual ordinary bootstrap environment replacement')
  let calls = 0
  // Execute only the actual fenced-environment block, with generated strings
  // and the real exported guard. This models Linux source logic; it starts no
  // Electron/provider and never assigns this test process's environment.
  vm.runInNewContext(main.slice(start, end), {
    process: observedProcess, devUserDataCheck: {}, installProfileCheck: {}, CURRENT_PROFILE_PATH: homes.HOME,
    TRUSTED_PROFILE_SHORT_ALIAS_ROOT: null, dialog: {}, reportStartupRefusal: () => assert.fail('Unexpected refusal'),
    fencedAccountEnvironment: options => { calls++; return fencedAccountEnvironment({ ...options, platform: 'linux' }) },
  })
  assert.equal(calls, 1)
  assert.deepEqual(Object.fromEntries(HOME_KEYS.map(key => [key, supplied[key] ?? null])), postBootstrapHomes(homes))
  assert.deepEqual(HOME_KEYS.filter(key => !Object.hasOwn(supplied, key)), ['CODEX_HOME'])
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'PUBLIC']) assert.equal(Object.hasOwn(supplied, key), false)
  assert.equal(launch.CODEX_HOME, homes.CODEX_HOME, 'The requested generated selector remains a separately bound launch input')
})

function lifecycleFixture() {
  // Retained handles and identities here are explicit source doubles. Actual
  // native observation uses application.process() and the /proc identity reader.
  const qaRoot = path.resolve('/generated-source-only/page2-Lifecycle'), homes = Object.fromEntries(HOME_KEYS.map(key => [key, path.join(qaRoot, 'profile', key)]))
  const receipt = { schemaVersion: 2, qaRoot, homes, postBootstrapHomes: postBootstrapHomes(homes),
    attempts: [], openings: [], rejections: [], closures: [], cleanupComplete: false, complete: false }
  const identities = new Map(), events = [], inspected = [], userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  const lifecycle = createFirstUseLifecycle({ receipt, inspect: root => { inspected.push(root); return { starts: 0, codexHomeEmpty: true } },
    identity: pid => {
      if (!identities.has(pid)) throw Object.assign(new Error('Synthetic process identity is absent'), { code: 'ENOENT' })
      return { pid, startTicks: identities.get(pid) }
    } })
  const child = (pid = 200, startTicks = '1000') => {
    identities.set(pid, startTicks)
    return { pid, exitCode: null, signalCode: null }
  }
  const runtime = child => ({ pid: child.pid, userData, homes: postBootstrapHomes(homes), absentHomeKeys: ['CODEX_HOME'],
    homedir: homes.HOME, credentialEnvironmentKeys: [] })
  const event = row => events.push(structuredClone(row))
  const exit = child => { identities.delete(child.pid); child.exitCode = 0; return lifecycle.closed(child) }
  return { lifecycle, receipt, events, identities, inspected, userData, child, runtime, event, exit }
}

test('successful lifecycle retains each actual-handle model before validation and closes serial cold lifetimes', async () => {
  const f = lifecycleFixture()
  for (let index = 0; index < 2; index++) {
    // PID reuse is valid only after the first retained identity is gone.
    const child = f.child(200, String(1000 + index))
    const opening = await f.lifecycle.observeOpening(child, async () => {
      assert.equal(f.receipt.attempts.length, index + 1)
      assert.equal(f.events.at(-1).kind, 'first-use-attempt')
      assert.equal(f.receipt.openings.length, index)
      return f.runtime(child)
    }, f.event)
    assert.equal(opening.attempt, index + 1)
    const closed = f.exit(child)
    assert.equal(closed.openingValidated, true); assert.equal(closed.oldIdentityGone, true)
  }
  const final = f.lifecycle.finish(f.userData)
  assert.equal(final.cleanupComplete, true); assert.equal(final.complete, true)
  assert.equal(final.attempts.length, 2); assert.equal(final.closures.length, 2)
  assert.deepEqual(final.rejections, [])
})

test('a readiness rejection before runtime observation retains and closes its attempted child without fabricating an opening', async () => {
  const f = lifecycleFixture(), child = f.child(), failure = new Error('Synthetic mounted readiness refusal')
  await assert.rejects(f.lifecycle.observeOpening(child, async () => { throw failure }, f.event), error => error === failure)
  assert.equal(f.receipt.attempts.length, 1); assert.equal(f.receipt.openings.length, 0)
  assert.equal(f.receipt.rejections[0].message, failure.message)
  assert.deepEqual(f.events.map(row => row.kind), ['first-use-attempt', 'first-use-rejected'])
  const closed = f.exit(child)
  assert.equal(closed.openingValidated, false); assert.equal(closed.exited, true); assert.equal(closed.oldIdentityGone, true)
  const final = f.lifecycle.finish(f.userData)
  assert.equal(final.cleanupComplete, true); assert.equal(final.complete, false)
})

test('wrong post-bootstrap homes, inherited selector, runtime PID and credentials each refuse validation but retain cleanup', async () => {
  for (const mutate of [r => { r.homes.CODEX_HOME = '/generated-source-only/unexpected-selector' },
    r => { delete r.homes.CODEX_HOME }, r => { r.absentHomeKeys = [] }, r => { r.homes.HOME = '/generated-source-only/wrong-home' },
    r => { r.homedir = '/generated-source-only/wrong-home' }, r => { r.pid++ },
    r => { r.userData += '-sibling' }, r => { r.credentialEnvironmentKeys = ['OPENAI_API_KEY'] }]) {
    const f = lifecycleFixture(), child = f.child(), runtime = f.runtime(child); mutate(runtime)
    await assert.rejects(f.lifecycle.observeOpening(child, async () => runtime, f.event))
    assert.equal(f.receipt.openings.length, 0); assert.equal(f.receipt.rejections.length, 1)
    assert.deepEqual(f.inspected, [], 'Rejected runtime data cannot select a filesystem observation root')
    f.exit(child)
    const final = f.lifecycle.finish(f.userData)
    assert.equal(final.cleanupComplete, true); assert.equal(final.complete, false)
  }
})

test('empty or still-running lifecycle cannot imply validated first use', async () => {
  const empty = lifecycleFixture().lifecycle.finish('/unused')
  assert.equal(empty.cleanupComplete, true); assert.equal(empty.complete, false)
  const f = lifecycleFixture(), child = f.child()
  await f.lifecycle.observeOpening(child, async () => f.runtime(child), f.event)
  const active = f.lifecycle.finish(f.userData)
  assert.equal(active.cleanupComplete, false); assert.equal(active.complete, false)
  f.exit(child)
})

test('closure refuses a replacement handle, live identity and absent exit state before accepting the retained child', async () => {
  const f = lifecycleFixture(), child = f.child()
  await f.lifecycle.observeOpening(child, async () => f.runtime(child), f.event)
  assert.throws(() => f.lifecycle.closed({ ...child, exitCode: 0 }), /exact Electron ChildProcess/)
  assert.throws(() => f.lifecycle.closed(child), /actual exit/)
  child.exitCode = undefined; child.signalCode = undefined
  assert.throws(() => f.lifecycle.closed(child), /actual exit/)
  child.exitCode = 0; child.signalCode = null
  assert.throws(() => f.lifecycle.closed(child), /identity must be gone/)
  assert.equal(f.receipt.closures.length, 0)
  f.exit(child)
  assert.equal(f.lifecycle.finish(f.userData).complete, true)
})

test('failed initial identity capture still retains the handle but cannot claim independently proved cleanup', async () => {
  const f = lifecycleFixture(), child = f.child(); f.identities.delete(child.pid)
  let ready = false
  await assert.rejects(f.lifecycle.observeOpening(child, async () => { ready = true; return f.runtime(child) }, f.event), /identity is absent/)
  assert.equal(ready, false); assert.equal(f.receipt.attempts[0].identityCaptured, false)
  const closed = f.exit(child)
  assert.equal(closed.exited, true); assert.equal(closed.oldIdentityGone, false)
  const final = f.lifecycle.finish(f.userData)
  assert.equal(final.cleanupComplete, false); assert.equal(final.complete, false)
})

test('owned durable JSON refuses escape, linked and hardlinked data before reading a canary', t => {
  const root = scratch(t), inside = path.join(root, 'owned'), file = path.join(inside, 'prefs.json')
  fs.mkdirSync(inside); fs.writeFileSync(file, '{"values":{"proof":"owned"}}\n')
  assert.equal(readOwnedJSON(inside, file).value.values.proof, 'owned')
  assert.throws(() => ownedPath(inside, root), /exact owned root/)
  const linked = path.join(inside, 'linked.json'); fs.linkSync(file, linked)
  assert.throws(() => readOwnedJSON(inside, linked), /private regular/)
  fs.unlinkSync(linked)
  // Junctions avoid requiring file-symlink privileges in a future Windows
  // source execution. No target directory is traversed by the assertion.
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'canary.json'), '{"unchanged":true}')
  const link = path.join(inside, 'redirect'); fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readOwnedJSON(inside, path.join(link, 'canary.json')), /linked ancestor/)
  assert.equal(fs.readFileSync(path.join(other, 'canary.json'), 'utf8'), '{"unchanged":true}')
})

test('credential-name scanner never follows an unrelated link and refuses a credential-named link', t => {
  const root = scratch(t), owned = path.join(root, 'owned'), other = path.join(root, 'opaque')
  fs.mkdirSync(owned); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'auth.json'), 'generated canary only')
  fs.symlinkSync(other, path.join(owned, 'bootstrap'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(scanCredentialNames(owned), { entries: 1, credentialNames: 0, opaqueLinks: ['bootstrap'], followedLinks: 0 })
  fs.symlinkSync(other, path.join(owned, 'auth.json'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => scanCredentialNames(owned), /credential name/)
  assert.equal(fs.readFileSync(path.join(other, 'auth.json'), 'utf8'), 'generated canary only')
})

test('durable readback uses the canonical generated product settings leaf outside userData', async t => {
  const qaRoot = scratch(t), userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  const settingsPath = path.join(qaRoot, 'profile/localappdata/ToolsEnabled-Page2-QA/settings.json')
  const raw = { 'mc.setup.profile': '{"status":"complete"}', 'mc.example': null,
    ...Object.fromEntries(['dispatch', 'decision', 'queue', 'thread-reply', 'report-read', 'agent-session', 'cloud-launch'].map(id => ['mc.write.' + id, 'disabled'])) }
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }) }
  write(path.join(userData, 'renderer-prefs.json'), { storageVersion: 1, values: raw })
  write(settingsPath, { values: { 'agent.blocked_question': 'Stop and wait for me' } })
  write(path.join(userData, 'capability/state/config/ide-session-consent.json'), { importPolicy: 'none' })
  const state = { source: { available: true, accountReady: true, signedIn: false, file: path.join(userData, 'renderer-prefs.json'),
    notice: { damaged: null, preservedAt: null, refused: null } }, raw,
    host: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, { ok: true, value }])),
    settings: { ok: true, available: true, valuesPath: settingsPath, rejected: [], approval: { present: true, value: 'Stop and wait for me' } },
    editor: { ok: true, importPolicy: 'none' }, accounts: { ok: true, damaged: false, count: 0 } }
  // This adapter supplies synthetic IPC observations only. The helper still
  // reads the actual disposable files; it supplies no native UI credit.
  const context = { paths: { qaRoot, userData }, page: { waitForFunction: async () => {}, evaluate: async () => structuredClone(state) },
    firstUse: { inspect: () => ({ starts: 0, registry: { absent: true } }) } }
  const observed = await readFirstUseState(context)
  assert.equal(observed.disk.settings.file, settingsPath)
  assert.equal(observed.disk.consent.file, path.join(userData, 'capability/state/config/ide-session-consent.json'))
  const sibling = path.join(path.dirname(settingsPath), 'same-content-sibling.json')
  fs.copyFileSync(settingsPath, sibling); state.settings.valuesPath = sibling
  await assert.rejects(readFirstUseState(context), /canonical generated product leaf/)
  assert.equal(fs.readFileSync(sibling, 'utf8'), fs.readFileSync(settingsPath, 'utf8'))
})

test('saved-state contract rejects wrong flags, policy, folder or provider start', () => {
  const state = { profile: { status: 'complete', step: 'review', answers: { autonomy: 'observe', screens: 'live', workspaceRoots: ['/generated/work'] } },
    workspace: { ok: true, available: true, configured: true, chosen: true, recorded: true, tier: 'standard', roots: ['/generated/work'] },
    raw: { 'mc.example': null, ...Object.fromEntries(['dispatch', 'decision', 'queue', 'thread-reply', 'report-read', 'agent-session', 'cloud-launch'].map(id => ['mc.write.' + id, 'disabled'])) },
    settings: { approval: { value: 'Stop and wait for me', provenance: { source: 'user' } } }, editor: { importPolicy: 'none' }, custody: { registry: { absent: true }, starts: 0 },
    disk: { settings: { sha256: 'a' }, consent: { sha256: 'b' }, protectedSha256: 'c' } }
  const expected = { autonomy: 'observe', screens: 'live', workspace: '/generated/work' }
  assert.equal(assertSavedState(state, expected), state)
  assert.deepEqual(retainedState(state).raw, state.raw)
  for (const mutate of [r => { r.raw['mc.write.agent-session'] = 'enabled' }, r => { r.editor.importPolicy = 'ask' },
    r => { r.settings.approval.value = 'Decide for itself' }, r => { r.profile.answers.workspaceRoots.push('/other') },
    r => { r.workspace.roots = ['/other'] }, r => { r.workspace.chosen = false }, r => { r.custody.starts = 1 }]) {
    const bad = structuredClone(state); mutate(bad); assert.throws(() => assertSavedState(bad, expected))
  }
})

// Controlled locator and readback models execute the actual exported action.
// No browser, computed CSS, native input or successful native receipt is claimed.
function exitFixture() {
  const qaRoot = path.resolve('/generated-exit-only/page2-fixture'), workspace = path.join(qaRoot, 'workspace')
  const profile = { status: 'complete', step: 'review', answers: { autonomy: 'assisted', screens: 'live', workspaceRoots: [workspace] }, assistantConfig: null, undoUnavailable: null }
  const saved = { profile, raw: { 'mc.setup.profile': JSON.stringify(profile), 'mc.example': null,
    ...Object.fromEntries(['dispatch', 'decision', 'queue', 'thread-reply', 'report-read', 'agent-session', 'cloud-launch'].map(id =>
      ['mc.write.' + id, ['dispatch', 'report-read', 'agent-session', 'cloud-launch'].includes(id) ? 'enabled' : 'disabled'])) },
    workspace: { ok: true, available: true, configured: true, chosen: true, recorded: true, tier: 'standard', roots: [workspace] },
    settings: { approval: { value: 'Switch to other work', provenance: { source: 'user' } } }, editor: { importPolicy: 'ask' },
    custody: { registry: { absent: true }, starts: 0 }, disk: { settings: { sha256: 'a'.repeat(64) }, consent: { sha256: 'b'.repeat(64) }, protectedSha256: 'c'.repeat(64) } }
  const attempt = { attempt: 1, pid: 123, startTicks: '1234', retainedChild: true, identityCaptured: true }
  const opening = { attempt: 1, pid: 123, startTicks: '1234', userData: path.join(qaRoot, 'ToolsEnabled-Page2-QA') }
  const model = { route: '#/setup', visible: true, enabled: true, links: 1, notices: 0, continueCount: 0, setup: 1,
    mountedHome: true, href: '#/', label: 'Home', clickError: false, retainSetup: false, afterClick: null,
    clicks: [], events: [], captures: [], readbacks: 0, after: structuredClone(saved) }
  const link = { count: async () => model.links, isVisible: async () => model.visible, isEnabled: async () => model.enabled,
    textContent: async () => model.label, getAttribute: async key => key === 'href' ? model.href : null,
    waitFor: async options => { assert.deepEqual(options, { state: 'visible', timeout: 12000 }); assert.ok(model.visible, 'controlled hidden Home') },
    click: async options => { model.clicks.push(options); assert.deepEqual(options, { timeout: 12000 });
      assert.ok(!model.clickError, 'controlled intercepted click'); model.route = '#/'; if (!model.retainSetup) model.setup = 0; model.afterClick?.() } }
  const setup = { count: async () => model.setup, isVisible: async () => model.setup === 1,
    locator: selector => ({ count: async () => selector === '[data-setup-open-app]' ? model.continueCount : model.notices }) }
  const home = { count: async () => model.mountedHome ? 1 : 0, isVisible: async () => model.mountedHome,
    waitFor: async options => { assert.deepEqual(options, { state: 'visible', timeout: 12000 }); assert.ok(model.mountedHome, 'controlled URL without Home') } }
  const context = { options: { sterileFirstUse: true }, paths: { qaRoot, workspace }, state: { qaProcessId: 123, firstUseSaved: saved },
    firstUse: { receipt: { attempts: [attempt], openings: [opening], closures: [], rejections: [] } },
    report: { event: row => model.events.push(row) }, capture: async name => { model.captures.push(name) },
    page: { url: () => 'http://generated.invalid/' + model.route,
      locator: selector => {
        if (selector === 'nav[aria-label="Primary navigation"] a[data-route="home"]') return link
        if (selector === '#stage > .view:not([inert]) > .setup-page') return setup
        assert.equal(selector, '#stage > .view:not([inert]) > .home'); return home
      },
      waitForURL: async (predicate, options) => { assert.deepEqual(options, { timeout: 12000 }); assert.equal(predicate(new URL('http://generated.invalid/' + model.route)), true) } } }
  return { context, model, run: () => firstUseVisibleExit(context, { readState: async () => { model.readbacks++; return model.after } }) }
}

test('actual initial-Finish exit action uses one normal visible Home click and preserves its saved state/lifetime', async () => {
  const f = exitFixture(), result = await f.run()
  assert.deepEqual(f.model.clicks, [{ timeout: 12000 }]); assert.equal(f.model.readbacks, 1)
  assert.deepEqual(f.model.captures, ['first-use-finish-exit-before', 'first-use-finish-exit-after'])
  assert.equal(result.before.hash, '#/setup'); assert.equal(result.after.hash, '#/'); assert.equal(result.after.homeVisible, true)
  assert.equal(result.after.activeSetupCount, 0); assert.deepEqual(result.saved, f.context.state.firstUseSaved)
  assert.deepEqual(result.opening, f.context.firstUse.receipt.openings[0]); assert.deepEqual(result.attempt, f.context.firstUse.receipt.attempts[0])
  assert.deepEqual(f.model.events, [{ kind: 'first-use-exit-gesture', opening: result.opening, attempt: result.attempt, gesture: result.gesture }])
})

for (const [label, mutate] of [
  ['hidden Home', f => { f.model.visible = false }], ['disabled Home', f => { f.model.enabled = false }],
  ['duplicate Home', f => { f.model.links = 2 }], ['wrong Home href', f => { f.model.href = '#/settings' }],
  ['wrong Home name', f => { f.model.label = 'Other' }], ['notice-only Continue', f => { f.model.continueCount = 1 }],
  ['extra undo/config notice', f => { f.model.notices = 1 }],
  ['durable config failure', f => { f.context.state.firstUseSaved.profile.assistantConfig = { ok: false } }],
  ['durable undo failure', f => { f.context.state.firstUseSaved.profile.undoUnavailable = { reason: 'controlled' } }],
  ['recovered opening', f => { f.context.firstUse.receipt.openings.push({ ...f.context.firstUse.receipt.openings[0], attempt: 2 }) }],
  ['already closed first opening', f => { f.context.firstUse.receipt.closures.push({ attempt: 1 }) }],
]) test('actual initial-Finish action refuses ' + label + ' before any input', async () => {
  const f = exitFixture(); mutate(f); await assert.rejects(f.run()); assert.deepEqual(f.model.clicks, []); assert.deepEqual(f.model.events, [])
})

for (const [label, mutate] of [
  ['intercepted click', f => { f.model.clickError = true }],
  ['URL without mounted Home', f => { f.model.mountedHome = false }],
  ['still-active Setup', f => { f.model.retainSetup = true }],
  ['closed during navigation', f => { f.model.afterClick = () => f.context.firstUse.receipt.closures.push({ attempt: 1 }) }],
  ['changed process ticks', f => { f.model.afterClick = () => { f.context.firstUse.receipt.openings[0].startTicks = 'other' } }],
  ['changed raw flag', f => { f.model.after.raw['mc.write.dispatch'] = 'disabled' }],
  ['changed editor consent', f => { f.model.after.editor.importPolicy = 'none' }],
  ['changed approval policy', f => { f.model.after.settings.approval.value = 'Decide for itself' }],
  ['changed workspace', f => { f.model.after.workspace.roots = ['/not-owned'] }],
  ['changed unrelated preference', f => { f.model.after.disk.protectedSha256 = 'd'.repeat(64) }],
  ['created registry', f => { f.model.after.custody.registry.absent = false }],
  ['provider start', f => { f.model.after.custody.starts = 1 }],
]) test('actual initial-Finish action retains refusal after ' + label + ' without retry', async () => {
  const f = exitFixture(); mutate(f); await assert.rejects(f.run()); assert.equal(f.model.clicks.length, 1)
  assert.equal(f.model.captures.includes('first-use-finish-exit-after'), false)
})
