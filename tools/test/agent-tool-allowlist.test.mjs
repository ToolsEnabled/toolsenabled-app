/* The tool answers, and the allowlist they actually become.
 *
 * The owner's settings doctrine: a user setting needs a real control, real
 * persistence and real enforcement, or it is a lie. This suite pins all three
 * links for the tools settings page:
 *
 *   1. the LIST the page renders comes from the engine registry at the
 *      recorded tier (listAgentTools, exercised through its payload seam below);
 *   2. the SPAWN composes TOOLSENABLED_TOOL_ALLOWLIST from the same persisted
 *      row at the one place every agent child's environment is built;
 *   3. the two states that must refuse a start rather than widen it -- an
 *      unreadable row and one that leaves nothing available -- have codes and
 *      copy.
 *
 * The engine reads an EMPTY allowlist string as the FULL profile (its own
 * registry comment calls that inversion out), which is why an empty composition
 * must never reach the spawn as an env var.
 *
 * The three states themselves, the upgrade off the old two-state row, and the
 * ceiling are pinned in tools/test/agent-tool-states.test.mjs; this suite is
 * about the WIRE between that model and a running session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = file => readFileSync(path.join(REPO, file), 'utf8')

const { listAgentTools } = require_(path.join(REPO, 'shell', 'agent-confinement-read.cjs'))

/* The engine's own selector rule, copied as a literal on purpose: if the
   registry ever renames tools into a shape its own parser refuses, this suite
   must fail before a composed allowlist starts failing sessions. */
const ENGINE_TOOL_SELECTOR = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/

function stagePayload(scratch) {
  const capabilityRoot = path.join(scratch, 'capability')
  const lib = path.join(capabilityRoot, 'src', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(path.join(lib, 'agent-session-confinement.js'), `
    const { readFileSync } = require('node:fs')
    const path = require('node:path')
    exports.resolveAgentConfinement = ({ servicesRoot }) => ({
      tier: readFileSync(path.join(servicesRoot, 'tier'), 'utf8'),
    })
  `)
  writeFileSync(path.join(lib, 'permission-tier-policy.js'), `
    exports.installTierSession = tier => ({ tier: tier === 'unrestricted' ? 'full' : tier })
    exports.allowedToolNames = (tools, session) =>
      tools.filter(tool => session.tier !== 'guided' || tool.name !== 'tools.write').map(tool => tool.name)
  `)
  writeFileSync(path.join(lib, 'tool-registry.js'), `
    exports.registeredTools = () => [
      { name: 'tools.write', effect: 'local-write', approvalEligible: true },
      { name: 'files.read', effect: 'local-read', approvalEligible: false },
      { name: 'browser.open', effect: 'external-write', approvalEligible: true },
    ]
  `)
  return capabilityRoot
}

/* The engine's own approval decision, staged the way the engine makes it: a
   policy value, and the same requiresApproval() the dispatch calls. The reader
   under test must ASK this rather than deciding for itself which tools ask. */
function stageApprovalPolicy(capabilityRoot, actions) {
  writeFileSync(path.join(capabilityRoot, 'src', 'lib', 'policy.js'), `
    exports.loadPolicy = () => ({ approvals: { enabled: true, actions: ${JSON.stringify(actions)} } })
    exports.requiresApproval = (action, effect, policy) => policy.approvals.actions.includes(action)
  `)
}

function stageRecord(scratch, tier) {
  const servicesRoot = path.join(scratch, `svc-${tier}`)
  mkdirSync(servicesRoot, { recursive: true })
  writeFileSync(path.join(servicesRoot, 'tier'), tier)
  return servicesRoot
}

test('the tool list reflects the registry, sorted, in the shape the engine parses', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-tools-list-'))
  const capabilityRoot = stagePayload(scratch)
  const servicesRoot = stageRecord(scratch, 'unrestricted')
  const listed = listAgentTools({ capabilityRoot, servicesRoot })
  assert.equal(listed.ok, true)
  assert.equal(listed.tier, 'unrestricted')
  assert.deepEqual(listed.tools.map(tool => tool.name), ['browser.open', 'files.read', 'tools.write'],
    'the list returns every registered tool rather than a machine-specific count')
  assert.equal(listed.tools.length, listed.total)
  const names = listed.tools.map(tool => tool.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'the list is sorted for a stable checkbox page')
  for (const name of names) {
    assert.match(name, ENGINE_TOOL_SELECTOR, `${name} would be refused by the engine's own allowlist parser`)
  }
  assert.ok(listed.tools.every(tool => tool.allowed === true),
    'unrestricted narrows nothing, so every tool must read allowed')
})

test('a confined tier marks withheld tools, and never by guessing', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-tools-tier-'))
  const capabilityRoot = stagePayload(scratch)
  const servicesRoot = stageRecord(scratch, 'guided')
  const listed = listAgentTools({ capabilityRoot, servicesRoot })
  assert.equal(listed.ok, true)
  assert.equal(listed.tier, 'guided')
  const allowed = listed.tools.filter(tool => tool.allowed).length
  assert.ok(allowed > 0, 'guided still carries tools')
  assert.ok(allowed < listed.total, 'guided narrows; a full count here means the tier reading is fake')
})

test('each tool reports whether this program already asks before each use of it', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-tools-gate-'))
  const capabilityRoot = stagePayload(scratch)
  const servicesRoot = stageRecord(scratch, 'unrestricted')

  /* A payload with no approval decision at all. The reader must answer "this is
     not gated" rather than claiming a gate it could not read -- the cautious
     direction, because the page holds an ungated tool back rather than spending
     it without asking. */
  const silent = listAgentTools({ capabilityRoot, servicesRoot })
  assert.equal(silent.ok, true)
  assert.ok(silent.tools.every(tool => tool.gated === false),
    'a payload that answers nothing about approvals produced a claimed gate')

  /* A second staging rather than a policy dropped into the first: the module
     loader remembers what it has already resolved, and a test that depends on
     it forgetting is a test that passes for the wrong reason. */
  const scratch2 = mkdtempSync(path.join(tmpdir(), 'mc-tools-gate2-'))
  const withPolicy = stagePayload(scratch2)
  stageApprovalPolicy(withPolicy, ['browser.open'])
  const listed = listAgentTools({ capabilityRoot: withPolicy, servicesRoot: stageRecord(scratch2, 'unrestricted') })
  assert.equal(listed.ok, true)
  const byName = new Map(listed.tools.map(tool => [tool.name, tool]))
  assert.equal(byName.get('browser.open').gated, true,
    'a tool the engine already gates is not reported as gated, so the page cannot offer "ask me first" honestly')
  assert.equal(byName.get('files.read').gated, false,
    'a tool the engine does not gate is reported as gated, which would promise a question nobody asks')
  assert.equal(byName.get('tools.write').gated, false,
    'the approval decision is being made here rather than read from the engine’s own answer')
})

test('an unreadable payload answers a code, never a guess and never a path', () => {
  const listed = listAgentTools({ capabilityRoot: path.join(tmpdir(), 'mc-no-such-payload') })
  assert.equal(listed.ok, false)
  assert.equal(typeof listed.code, 'string')
  assert.equal(Object.keys(listed).sort().join(','), 'code,ok', 'a failure carries the code and nothing else')
})

/* ---------- the enforcement seam, pinned in source ----------
   main.cjs runs only under Electron, so its composition is pinned by shape:
   what matters is WHERE it runs (the one env chokepoint) and WHICH states
   refuse. The engine-side enforcement itself is the payload's own code. */

test('the spawn composes the allowlist at the environment chokepoint, and refusals refuse', () => {
  const shell = read('shell/main.cjs')
  assert.match(shell, /sessionEnvironmentExtras: agentToolAllowlistExtras/,
    'the composer is no longer wired into the agent host — the checkboxes changed nothing')
  /* Bounded to the function's own body rather than to a character count, which
     is what a count was standing in for and which stops being true the moment
     the function grows. */
  const start = shell.indexOf('function agentToolAllowlistExtras')
  const composer = shell.slice(start, shell.indexOf('\n}', start))
  assert.ok(composer.length > 400, 'the composer was not found; this test is checking air')
  assert.match(composer, /AGENT_TOOLS_ALL_DISABLED/,
    'a composition with nothing left in it no longer refuses — an empty allowlist string means FULL profile to the engine')
  assert.match(composer, /AGENT_TOOL_LIMITS_UNREADABLE/,
    'an unreadable row no longer refuses — a session would start wider than the person chose')
  assert.match(composer, /ACCOUNT_NOT_SIGNED_IN/,
    'signed-out must read as narrow-nothing, not as an error that blocks every start')
  assert.match(composer, /surface\.allowed\.join\(','\)/,
    'the composed surface is no longer what reaches the session; some other list is')
  const host = read('shell/agent-host.cjs')
  assert.match(host, /extras: envExtras/, 'the extras never reach sessionLaunchEnvironment')
  assert.ok(host.indexOf('...(extras || {})') < host.indexOf('...(plan.env || {})'),
    'the plan must layer OVER the extras — a settings row must not override confinement')
  const tools = read('shell/fleet-profile-preload.cjs')
  assert.match(tools, /mc-agent:tools/, 'the renderer lost its read of the tool list')
  const handler = shell.slice(shell.indexOf(`ipcMain.handle('mc-agent:tools'`))
  assert.match(handler.slice(0, 300), /assertTrustedAgentSender/, 'the tools channel skips the sender check')
})

test('the page persists the same rows the spawn reads, through one shared model', () => {
  const page = read('src/views/tools.js')
  const shell = read('shell/main.cjs')
  const model = read('shell/agent-tool-states.cjs')
  /* ONE MODEL, TWO LANGUAGES. Both halves name the same two rows, and both get
     the meaning of a row from a module rather than from their own parser --
     which is the property tools/test/agent-tool-states.test.mjs then proves is
     the SAME meaning on both sides. */
  for (const [label, source] of [['the page', page], ['the shell', shell]]) {
    assert.match(source, /TOOL_STATES_KEY/, `${label} lost the tool answers row`)
    assert.match(source, /TOOLS_DISABLED_KEY/, `${label} stopped reading the row it replaced, so an upgrade loses every saved choice`)
    assert.match(source, /parseToolStates/, `${label} parses the row itself instead of asking the shared model`)
  }
  assert.match(model, /agent_tool_states/, 'the shared model lost the row name')
  assert.match(model, /agent_tools_disabled/, 'the shared model lost the row it upgrades from')
  assert.match(page, /putSetting\(TOOL_STATES_KEY/, 'the page no longer persists anything')
  assert.match(page, /data-tools-all-on/, 'the enable-all control is gone')
  assert.match(page, /data-tools-all-ask/, 'the ask-first-for-all control is gone')
  assert.match(page, /data-tools-all-off/, 'the disable-all control is gone')
  /* THE DRAWER KEEPS A DOOR AND NOT A SECOND COPY. Two lists of three hundred
     tools would be two places for a person's answers to disagree. */
  const drawer = read('src/quick-settings.js')
  assert.match(drawer, /href="#\/tools"/, 'the drawer lost its path to the tools page')
  assert.doesNotMatch(drawer, /data-tool-name=/, 'the drawer grew a second copy of the tool list')
  /* Copy: both refusal codes own sentences that name a next move. */
  const copy = read('src/agent-availability-copy.js')
  assert.match(copy, /AGENT_TOOL_LIMITS_UNREADABLE:/, 'the unreadable-limits refusal has no sentence')
  assert.match(copy, /AGENT_TOOLS_ALL_DISABLED:/, 'the all-disabled refusal has no sentence')
})

test('the tools page is reachable by address, so its door is not the only way in', async () => {
  const router = read('src/main.js')
  const { parseRoute } = await import('../../src/route-parse.js')
  assert.deepEqual(parseRoute('#/tools'), { name: 'tools' }, 'the tools address must resolve to its page')
  assert.match(router, /import \{ parseRoute \} from '\.\/route-parse\.js'/)
  assert.match(router, /case 'tools': return toolsView\(\)/, 'the route names no view')
  assert.match(router, /tools: \{ back: 'settings', next: 'settings' \}/,
    'the page is off the ring with no exit, which strands anybody who reaches it')
})
