import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { parseAst } from 'rollup/parseAst'
import { createAgentHost, START_REFUSAL_CODES } from '../../shell/agent-host.cjs'
import { UNAVAILABLE_TEXT } from '../../src/agent-availability-copy.js'
const require = createRequire(import.meta.url)
const enginePath = path.resolve(import.meta.dirname, 'fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
const claude = require('./fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')
const { control: rootControl } = require('./fixtures/dual-engine/root-lifecycle.cjs')
const source = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')
async function fixture(run, overrides = {}) {
  const scratchRoot = realpathSync(os.tmpdir())
  const workdir = mkdtempSync(path.join(scratchRoot, 'te-resource-host-wiring-'))
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, servers: [] })
  const calls = []
  const resourceGovernor = { reserve(value) { calls.push(['reserve', value]); return { ok: true, token: 'reservation', state: { mode: 'off', measuredAt: null } } },
    revalidate(token) { calls.push(['revalidate', token]); return { ok: true } },
    ready(token) { calls.push(['ready', token]) }, release(token) { calls.push(['release', token]) } }
  const sessionAuthority = { bind: () => ({ bound: false, mode: 'in-process', credential: null }),
    revoke() {}, assert(value) { assert.equal(value.agentId, null); return { valid: true, mode: 'in-process' } } }
  const host = createAgentHost({ enginePath, defaultCwd: workdir, startProviderProbe: () => 'claude',
    providerCommandResolver: () => path.join(workdir, 'never-executed-fixture-claude.exe'), freeMemory: () => 0, resourceGovernor, sessionAuthority, ...overrides })
  try { await run({ host, calls, resourceGovernor }) } finally {
    try { await host.closeAll() } finally {
      if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN; else process.env.MC_TEST_CONFINEMENT_PLAN = previous
      const relative = path.relative(scratchRoot, realpathSync(workdir))
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      rmSync(workdir, { recursive: true, force: true })
    }
  }
}

function assertUsesGovernedHost(code) {
  let handler
  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
    if (visit(node) === false) return
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(node[key], visit)
    }
  }
  walk(parseAst(code), node => {
    if (node.type === 'Property' && node.key?.value === 'agent:start'
        && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value?.type)) {
      assert.equal(handler, undefined, 'agent:start must have one command handler')
      handler = node.value
    }
  })
  assert.ok(handler, 'agent:start must have a command handler')
  let orderedStarts = 0
  walk(handler.body, node => {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return false
    if (node.type !== 'BlockStatement') return
    const declarations = node.body.flatMap(statement => statement.type === 'VariableDeclaration' && statement.kind === 'const' ? statement.declarations : [])
    for (const declaration of declarations) {
      const load = declaration.init
      if (load?.type !== 'AwaitExpression' || load.argument?.type !== 'CallExpression'
          || load.argument.callee?.type !== 'Identifier' || load.argument.callee.name !== 'getAgentHost'
          || load.argument.arguments.length !== 0 || declaration.id?.type !== 'Identifier') continue
      const hostName = declaration.id?.name
      orderedStarts += declarations.filter(candidate => {
        const start = candidate.init?.type === 'AwaitExpression' ? candidate.init.argument : null
        return candidate.start > declaration.start && start?.type === 'CallExpression'
          && start.callee?.object?.name === hostName && start.callee?.property?.name === 'startSession'
          && start.arguments.length === 1 && start.arguments[0]?.name === 'request'
      }).length
    }
  })
  assert.equal(orderedStarts, 1, 'agent:start must await its governed host before starting the request on that same host')
}

test('governed-host proof permits intermediate admission checks and rejects a bypass or reordered start', () => {
  const command = body => `const commands = { 'agent:start': async request => { try { ${body} } catch (error) { throw error } } }`
  assertUsesGovernedHost(command('const host = await getAgentHost(); request.delegationPermit?.assertStart("standard"); const result = await host.startSession(request)'))
  for (const body of [
    'const host = await createAgentHost(); const result = await host.startSession(request)',
    'const host = await getAgentHost(); const result = await other.startSession(request)',
    'const result = await host.startSession(request); const host = await getAgentHost()',
    'let host = await getAgentHost(); host = other; const result = await host.startSession(request)',
  ]) assert.throws(() => assertUsesGovernedHost(command(body)), /governed host/)
})
test('All off reaches the actual fixture engine at zero free RAM and releases its reservation on real close', async () => {
  await fixture(async ({ host, calls }) => {
    const before = claude.calls.length
    const receipt = await host.startSession({ sessionId: 'resource-off' })
    assert.equal(claude.calls.length, before + 1)
    assert.equal(receipt.resourceAdmission.mode, 'off')
    assert.equal(calls[0][0], 'reserve'); assert.equal(calls[0][1].provider, 'claude')
    assert.equal(calls[1][0], 'revalidate'); assert.equal(calls[2][0], 'ready')
    await host.closeSession({ sessionId: 'resource-off' })
    assert.equal(calls.at(-1)[0], 'release')
  })
})

test('sending to an already-ready session does not request another provider-root admission', async () => {
  await fixture(async ({ host, calls, resourceGovernor }) => {
    await host.startSession({ sessionId: 'existing-session-send' })
    const admittedCalls = calls.length
    resourceGovernor.reserve = () => {
      calls.push(['unexpected-reserve'])
      return { ok: false, code: 'AGENT_RESOURCE_WARMING', reason: 'New starts are held.' }
    }
    const sent = await host.sendTurn({ sessionId: 'existing-session-send', text: 'Fixture follow-up.', origin: 'person' })
    assert.equal(sent.turnId, 't1')
    assert.equal(calls.length, admittedCalls, 'ordinary Send reused the ready session without another resource debit')
  })
})

test('an old marker-less engine or missing private authority assertion refuses before any engine call', async () => {
  const marker = claude.ROOT_ADMISSION_CONTRACT_VERSION
  try {
    delete claude.ROOT_ADMISSION_CONTRACT_VERSION
    await fixture(async ({ host }) => {
      const before = claude.calls.length
      await assert.rejects(host.startSession({ sessionId: 'old-pair' }), { code: 'AGENT_SESSION_ROOT_GUARD_UNAVAILABLE' })
      assert.equal(claude.calls.length, before)
    })
  } finally { claude.ROOT_ADMISSION_CONTRACT_VERSION = marker }
  await fixture(async ({ host }) => {
    const before = claude.calls.length
    await assert.rejects(host.startSession({ sessionId: 'missing-authority' }), { code: 'AGENT_SESSION_ROOT_GUARD_UNAVAILABLE' })
    assert.equal(claude.calls.length, before)
  }, { sessionAuthority: { bind: () => ({ bound: false, mode: 'in-process', credential: null }), revoke() {} } })
})

test('new pressure after reservation reaches no ready session and cleanup returns the single debit', async () => {
  await fixture(async ({ host, calls, resourceGovernor }) => {
    resourceGovernor.revalidate = () => ({ ok: false, code: 'AGENT_RESOURCE_PRESSURE', reason: 'New pressure at the root boundary.' })
    await assert.rejects(host.startSession({ sessionId: 'late-pressure' }), { code: 'AGENT_RESOURCE_PRESSURE' })
    assert.equal(calls.filter(([kind]) => kind === 'reserve').length, 1)
    assert.equal(calls.filter(([kind]) => kind === 'release').length, 1)
    assert.equal(calls.some(([kind]) => kind === 'ready'), false)
  })
})

test('Stop during asynchronous root preparation prevents the fixture root and awaits its retained cleanup', async () => {
  let enter, resume
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const roots = rootControl.roots
  rootControl.prepare = () => { enter(); return gate }
  try {
    await fixture(async ({ host, calls }) => {
      const starting = host.startSession({ sessionId: 'stop-before-root' })
      const refused = assert.rejects(starting, { code: 'AGENT_SESSION_START_CANCELLED' })
      await entered
      const stopping = host.closeSession({ sessionId: 'stop-before-root' })
      resume()
      await refused; assert.equal((await stopping).closed, true)
      assert.equal(rootControl.roots, roots)
      assert.equal(calls.filter(([kind]) => kind === 'reserve').length, 1)
      assert.equal(calls.filter(([kind]) => kind === 'release').length, 1)
      assert.equal(calls.some(([kind]) => kind === 'ready'), false)
    })
  } finally { rootControl.prepare = null; resume() }
})

test('identity revoked while preparing the root is still refused in All off', async () => {
  let revoked = false
  const roots = rootControl.roots
  rootControl.prepare = () => { revoked = true }
  try {
    await fixture(async ({ host, calls }) => {
      await assert.rejects(host.startSession({ sessionId: 'revoked-before-root' }), { code: 'OWNER_HOST_SESSION_REFUSED' })
      assert.equal(rootControl.roots, roots)
      assert.equal(calls.some(([kind]) => kind === 'revalidate'), false, 'authority is mandatory before policy')
      assert.equal(calls.filter(([kind]) => kind === 'release').length, 1)
    }, { sessionAuthority: { bind: () => ({ bound: false, mode: 'in-process', credential: null }), revoke() {},
      assert() { if (revoked) throw Object.assign(new Error('revoked'), { code: 'OWNER_HOST_SESSION_REFUSED' }); return { valid: true } } } })
  } finally { rootControl.prepare = null }
})
test('resource pressure refuses before any provider engine start, with the named renderer-safe code', async () => {
  await fixture(async ({ host }) => {
    const before = claude.calls.length
    assert.throws(() => host.startSession({ sessionId: 'resource-held' }), { code: 'AGENT_RESOURCE_PRESSURE' })
    assert.equal(claude.calls.length, before)
  }, { resourceGovernor: { reserve: () => ({ ok: false, code: 'AGENT_RESOURCE_PRESSURE', reason: 'Waiting for CPU.' }) } })
})
test('a start failure after resource reservation releases the budget rather than stranding the queue', async () => {
  await fixture(async ({ host, calls }) => {
    await assert.rejects(host.startSession({ sessionId: 'resource-failed' }))
    assert.equal(calls[0][0], 'reserve'); assert.equal(calls.at(-1)[0], 'release')
    assert.equal(calls.some(([kind]) => kind === 'ready'), false)
  }, { accountResolver: async () => ({ blocked: true, code: 'AGENT_ACCOUNT_UNAVAILABLE', reason: 'Synthetic account refusal.' }) })
})
test('the actual main-process host always supplies the governor and the real loaded preload exposes only scoped operations', () => {
  const main = source('shell/main.cjs')
  assert.match(main, /resourceGovernor: requireAgentResourceHost\(\)/)
  const startParser = main.slice(main.indexOf('function parseAgentStart('), main.indexOf('\nfunction ', main.indexOf('function parseAgentStart(') + 1))
  assert.doesNotMatch(startParser, /acknowledgeLowMemory|bootstrapController/)
  assertUsesGovernedHost(source('shell/agent-command-surface.cjs'))
  assert.match(main, /installResourceHost\(\{ status: principal/)
  assert.match(main, /readToolMode: \(\) => require\(path.join\(root, 'src', 'lib', 'tool-mode.js'\)\).toolMode\(\)/)
  const resourceInstall = main.indexOf('agentResourceModule.installResourceHost(')
  assert.ok(resourceInstall < main.indexOf('agentResourceHost = agentResourceModule.createAgentResourceHost('),
    'failed monitor construction must already be marked as application scope')
  assert.match(main, /reserveLane: \(request, principal\) => requireAgentResourceHost\(\).reserveLane\(request, principal\)/)
  const childStart = main.indexOf('const started = await startCapabilityLayer({')
  const resourcePreflight = main.slice(resourceInstall, childStart)
  assert.match(resourcePreflight, /resourceAuthority = requireAgentResourceHost\(\)\s*resourceBootId = resourceAuthority.status\(\).bootId/,
    'authority construction and its readiness read must finish before any child is spawned or registered')
  assert.match(resourcePreflight, /CAPABILITY_RESOURCE_AUTHORITY_REQUIRED[\s\S]*?return capabilityLayerStatus/)
  const workService = main.slice(childStart, main.indexOf('capabilityLayerStatus = started.ok'))
  assert.match(workService, /resourceChannel: \{[\s\S]*?attachResourceAuthority\(child/)
  assert.match(workService, /bootId: resourceBootId/)
  assert.match(workService, /reserveLane: \(request, principal\) => resourceAuthority.reserveServiceLane\(request, principal\)/)
  assert.match(workService, /onUnavailable: listener => resourceAuthority.onUnavailable\(listener\)/)
  assert.doesNotMatch(workService, /acknowledged|acknowledgeLowMemory|bootstrapController/)
  assert.match(source('src/resource-settings.js'), /this app’s work-lane service/)
  assert.match(source('src/resource-settings.js'), /Work lanes wait for advice; they do not bootstrap a controller/)
  assert.match(main, /mc-resources:configure'[\s\S]*?assertTrustedAgentSender\(event\)/)
  assert.match(source('shell/fleet-profile-preload.cjs'), /exposeInMainWorld\('mcResources', Object.freeze\(\{\s*status: request => ipcRenderer.invoke\('mc-resources:status', request\),\s*configure: value => ipcRenderer.invoke\('mc-resources:configure', value\),\s*\}\)/)
  for (const code of START_REFUSAL_CODES.filter(code => code.startsWith('AGENT_RESOURCE_'))) assert.equal(typeof UNAVAILABLE_TEXT[code], 'string', code)
})
