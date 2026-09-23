/* THE AGENT API ROW: THE DRIVE, AND THE REASON THE ROW IS NOT ON THE PAGE YET.
 *
 * `agent.agent_api` -- whether an assistant works through this program's tools
 * or its own built-in ones -- exists as a register row and a real enforcement,
 * and it has no control. This file is the third piece, written and driven, held
 * one step short of being listed.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL, BY NAME. The row is NOT in shell/product-settings.cjs
 * WRITABLE_IDS, and this file is why that is a decision rather than an
 * omission. It was added, driven, and taken back out, because listing it today
 * breaks two standing gates in this repository:
 *
 *   tools/test/settings-rows-do-something.test.mjs -- "every product-settings
 *     row names a reader" -- ends by requiring every id in PRODUCT_SETTING_IDS
 *     to be found in the STAGED payload's config/settings-registry.json:
 *     `assert.ok(entry, `${id} is not in the staged registry`)`. Measured with
 *     the row listed: `these product-settings rows name no reader:
 *     agent.agent_api`.
 *
 *   tools/test/research-setting-titles.test.mjs -- "the research section draws
 *     the plain name, never the identifier". A row the staged registry does not
 *     declare comes back `present: false` with no label, and
 *     src/research-settings.js `titleOf()` falls to its last resort and puts the
 *     IDENTIFIER on the glass. Measured with the row listed: `"agent.agent_api"
 *     is a sentence, not an identifier`.
 *
 * Those two gates are stricter than the historical sentences in WRITABLE_IDS
 * that speak of a row reporting itself absent "until this build's payload is
 * repacked". Whatever was true when those were written, the bar in the code
 * TODAY is that a listed row must be in the staged payload. The code is the
 * fact, so the row waits.
 *
 * WHAT IT IS WAITING FOR, exactly: this checkout's capability/ is packed from
 * the source pinned in private/capability-source.owner.json, and the enforcer
 * is not in that lineage yet. Nothing here may repoint that pin. When a payload
 * carrying src/lib/agent-api-policy.js is staged, the last test below stops
 * being inert and DEMANDS the row be listed.
 *
 * ---------------------------------------------------------------------------
 * THE DRIVE ITSELF IS NOT WAITING, because a control admitted on a drive nobody
 * ran is the defect WRITABLE_IDS' own rule exists to prevent. It runs against
 * any payload that carries the enforcer, named by MC_TEST_AGENT_API_PAYLOAD --
 * a variable, never a path, because a test that named a machine would be green
 * on one desk and red on every other.
 *
 * It asserts the chain the control sits at the head of:
 *
 *     the control  ->  the settings file  ->  the enforcer  ->  the argv
 *
 * and it asserts on the ARGV, which is what a spawned assistant actually
 * receives, never on an intermediate this file could compute itself. There is
 * no host half to test and that is deliberate: unlike `agent.tool_summary` and
 * `agent.capability_recall`, nothing in this shell composes any part of this
 * row. src/lib/agent-api-policy.js opens the settings file itself
 * (agentApiEnabled) and the payload's two argv builders call it, so the shell's
 * whole contribution is the write.
 *
 * The branch taken is PRINTED. "Could not look" and "not there" are different
 * answers, and a green run that skipped the drive must say so out loud.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { agentApiSettingMarkup, bindAgentApiSetting } from '../../src/agent-api-setting.js'
import { createDocument } from './lib/dom-stand-in.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const ID = 'agent.agent_api'
const STAGED = path.join(ROOT, 'capability')
const PAYLOAD = process.env.MC_TEST_AGENT_API_PAYLOAD || STAGED
const strictExecution = process.env.TOOLSENABLED_TEST_STRICT === '1'
const requiredDrive = strictExecution || Boolean(process.env.MC_TEST_AGENT_API_PAYLOAD)

/* Every write in this file lands in a fresh temporary file, never in the
   settings of whatever machine runs the suite. The payload's own resolver
   honours this variable, so nothing here rebuilds a path it would then have to
   keep in step with src/lib/settings.js. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'agent-api-setting-drive-'))
function overrideEnvironment(values, env = process.env) {
  const previous = Object.keys(values).map(key => ({ key, present: Object.hasOwn(env, key), value: env[key] }))
  for (const [key, value] of Object.entries(values)) env[key] = value
  return () => {
    for (const { key, present, value } of previous) {
      if (present) env[key] = value
      else delete env[key]
    }
  }
}
const VALUES_PATH = path.join(SCRATCH, 'settings.json')
const restoreSuiteEnvironment = overrideEnvironment({
  TOOLSENABLED_SETTINGS_PATH: VALUES_PATH,
  TOOLSENABLED_STATE_ROOT: SCRATCH,
})
after(restoreSuiteEnvironment)

let shell, section
try {
  shell = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))
  section = await import('../../src/research-settings.js')
} catch (error) {
  restoreSuiteEnvironment()
  throw error
}

const ENFORCER = path.join(PAYLOAD, 'src', 'lib', 'agent-api-policy.js')
const ADAPTER = path.join(PAYLOAD, 'src', 'lib', 'agent-engine', 'claude-cli-adapter.js')
const DRIVE_REGISTRY = path.join(PAYLOAD, 'config', 'settings-registry.json')
const driveable = [ENFORCER, ADAPTER, DRIVE_REGISTRY].every(file => existsSync(file))

function registryOf(root, read = readFileSync) {
  const file = path.join(root, 'config', 'settings-registry.json')
  let raw
  try { raw = read(file, 'utf8') }
  catch (cause) {
    if (cause?.code === 'ENOENT') return null
    throw Object.assign(new Error(`The staged registry could not be read: ${file}`, { cause }), {
      code: 'AGENT_API_DRIVE_REGISTRY_UNREADABLE',
    })
  }
  try {
    const registry = JSON.parse(raw)
    if (!Array.isArray(registry?.entries)) throw new Error('Registry entries must be an array.')
    return registry
  } catch (cause) {
    throw Object.assign(new Error(`The staged registry is invalid: ${file}`, { cause }), {
      code: 'AGENT_API_DRIVE_REGISTRY_INVALID',
    })
  }
}

function loadDriveModules({ load = require_, enforcer = ENFORCER, adapter = ADAPTER } = {}) {
  try { return { policy: load(enforcer), adapter: load(adapter) } }
  catch (cause) {
    throw Object.assign(new Error('The Agent API drive could not load its required payload modules; the drive failed before execution.', { cause }), {
      code: 'AGENT_API_DRIVE_LOAD_REFUSED',
    })
  }
}

function noDriveable(t, {
  payload = PAYLOAD,
  requiredModules = [ENFORCER, ADAPTER, DRIVE_REGISTRY],
  moduleExists = existsSync,
  relativePath = path.relative,
  required = false,
} = {}) {
  const missingNames = requiredModules
    .filter(modulePath => !moduleExists(modulePath))
    .map(modulePath => relativePath(payload, modulePath))
    .sort()
  const reason = `this payload lacks the required input path(s): ${missingNames.join(', ')}; the control -> file -> enforcer -> argv drive did not run; point MC_TEST_AGENT_API_PAYLOAD at a payload containing all requirements`
  if (required) {
    throw Object.assign(new Error(`The selected Agent API payload is required: ${reason}`), {
      code: 'AGENT_API_DRIVE_REQUIRED_PAYLOAD_UNAVAILABLE',
    })
  }
  return t.skip(reason)
}

console.log(`[agent-api drive] payload ${PAYLOAD}`)
console.log(`[agent-api drive] ${driveable ? 'REQUIRED FILES PRESENT -- loading the control -> file -> enforcer -> argv drive' : 'REQUIRED FILE MISSING -- the drive did NOT run here; point MC_TEST_AGENT_API_PAYLOAD at a complete payload'}`)

/* THE HOLD IS OVER, AND THIS IS WHAT SURVIVES IT.
   Until 2026-08-25 this asserted two things: that the row was withheld, AND
   that the reason for withholding it was still true -- a hold written to state
   its own expiry, so the day the staged payload declared the row the second
   half would fail and say so rather than sit here quietly being wrong. It did
   exactly that, and the payload gained the adapter that emits the flag, so the
   row is now offered and the ratchet below governs.

   What is left is the half that was never about the hold. */
test('the page draws exactly the rows the shell writes', () => {
  assert.deepEqual([...section.PRODUCT_SETTING_IDS], [...shell.WRITABLE_IDS],
    'the page draws exactly the rows the shell writes, so which rows a person is offered'
    + ' stays ONE decision and not two -- a row in only one of these lists is either a'
    + ' control the writer refuses, or a value written by nothing on screen')
})

/* AND NOTHING MAY BE OFFERED THAT THE STAGED REGISTRY DOES NOT DECLARE.
   The hold enforced this for one id. It is true of every id, and stating it for
   the whole list is what stops the NEXT row being admitted before its payload
   carries it -- which is the mistake this file was written to catch, generalised
   rather than retired with the id that taught it. */
test('every row the shell writes is declared by the staged payload', t => {
  const staged = registryOf(STAGED)
  if (!staged) {
    assert.equal(strictExecution, false, 'Strict release verification requires the staged settings registry; absence is not an optional skip.')
    /* No payload staged in this checkout is a different answer from a payload
       that lacks a row, and it is evidence for neither. */
    return t.skip('No staged settings registry exists here; this checkout cannot prove staged row coverage.')
  }
  const declared = new Set(staged.entries.map(entry => entry.id))
  assert.deepEqual(shell.WRITABLE_IDS.filter(id => !declared.has(id)), [],
    'a row the staged registry does not declare must not be offered:'
    + ' settings-rows-do-something and research-setting-titles both fail on it')
})

/* THE RATCHET. Inert while the payload lacks the enforcer; the day a payload
   carrying it is staged, this is the test that says the control is now owed. */
test('a staged payload that carries the enforcer obliges the control to exist', () => {
  const stagedEnforcer = path.join(STAGED, 'src', 'lib', 'agent-api-policy.js')
  if (!existsSync(stagedEnforcer)) {
    assert.equal(shell.WRITABLE_IDS.includes(ID), false,
      'no enforcer is staged, so there is nothing for a control to move')
    return
  }
  assert.equal(shell.WRITABLE_IDS.includes(ID), true,
    'this copy enforces agent.agent_api and offers no way to change it -- a registry row and an enforcement with no control is the lie the owner named')
  assert.ok(section.PRODUCT_SETTING_IDS.includes(ID), 'and the page draws it')
})

if (!driveable) {
  /* Not "the enforcer does not exist" -- it exists, in an engine tree; it is
     not in THIS payload. The distinction is the finding. */
  test('the drive did not run against this payload, and says which of the two that is', t => noDriveable(t, { required: requiredDrive }))
} else {
  let modules
  try { modules = loadDriveModules() }
  catch (error) {
    restoreSuiteEnvironment()
    throw error
  }
  const { policy, adapter } = modules

  const argv = () => adapter.claudeArgs({ threadId: 'drive-thread', threadOptions: {} })

  test('the row preserves the Only default and offers each tool selection with a named enforcer', () => {
    const registry = registryOf(PAYLOAD)
    assert.ok(registry, 'the payload under drive carries a settings registry')
    const entry = registry.entries.find(row => row.id === ID)
    assert.ok(entry, `${ID} is declared by the payload that carries its enforcer`)
    assert.equal(entry.control, 'seg')
    assert.equal(entry.default, 'Only')
    for (const choice of ['Only', 'Optimized', 'Enabled', 'Disabled']) assert.ok(entry.options.includes(choice), choice)
    assert.ok(typeof entry.enforcedBy === 'string' && entry.enforcedBy.includes('agent-api-policy'),
      'the register names the module that reads the row')
    assert.ok(typeof registry.titles?.[ID] === 'string' && registry.titles[ID].trim().length > 0,
      'the register carries a plain name, so no page has to draw the identifier')
  })

  test('turning it OFF removes the built-in keep list from the argv a session is spawned with', () => {
    const result = driveWrite(false)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.value, 'Enabled', 'the old off value migrates to both tool sets')
    assert.equal(result.provenance.source, 'user', 'the control stamps the person, never a default')

    const stored = JSON.parse(readFileSync(VALUES_PATH, 'utf8'))
    assert.equal(stored.values[ID], 'Enabled', 'the switch reached the file the enforcer opens')

    assert.deepEqual(policy.agentApiArgs({ valuesPath: VALUES_PATH }), [],
      'the enforcer, reading the file the control just wrote, emits no flag')
    assert.equal(argv().includes('--tools'), false,
      'and the spawned argv is the one this product produced before the setting existed')
  })

  test('turning it ON puts the keep list back, and the flag names built-in tools only', () => {
    const result = driveWrite(true)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.value, 'Only')

    const args = policy.agentApiArgs({ valuesPath: VALUES_PATH })
    assert.equal(args[0], '--tools')
    assert.equal(args[1], '', 'Only removes native tools, including the former file-tool exceptions')
    assert.equal(args[1].includes('mcp__'), false,
      'the flag narrows the BUILT-IN axis only; it must never name a ToolsEnabled tool')

    const spawned = argv()
    assert.equal(spawned.includes('--tools'), true)
    assert.equal(spawned[spawned.indexOf('--tools') + 1], args[1],
      'the argv carries exactly the keep list the enforcer decided, not a second opinion')
  })

  test('a value the register refuses is rolled back, and the last chosen value still governs the argv', () => {
    const before = readFileSync(VALUES_PATH, 'utf8')
    const refused = driveWrite('yes')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'SETTING_VALUE_REFUSED')
    assert.equal(readFileSync(VALUES_PATH, 'utf8'), before,
      'the settings file is byte-identical to what it was before the refused write')
    assert.equal(argv().includes('--tools'), true, 'the refusal changed nothing the enforcer reads')
  })


  test('Optimized uses the actual drawer and settings writer while preserving discovery and saved provenance', async () => {
    const settingsOptions = { root: PAYLOAD, fresh: true }
    for (const [id, value] of [['agent.agent_api', 'Only'], ['agent.tool_summary', false], ['agent.capability_recall', true]]) {
      const result = shell.setProductSetting({ id, value }, settingsOptions)
      assert.equal(result.ok, true, result.reason)
    }
    const writes = []
    const document = createDocument()
    const body = document.createElement('div')
    document.body.appendChild(body)
    const tick = () => new Promise(resolve => setImmediate(resolve))
    const open = () => {
      body.innerHTML = agentApiSettingMarkup()
      bindAgentApiSetting(body, {
        read: () => shell.readProductSettings(settingsOptions),
        set(id, value) {
          writes.push({ id, value })
          return shell.setProductSetting({ id, value }, settingsOptions)
        },
      })
    }
    const savedBeforeOpen = readFileSync(VALUES_PATH, 'utf8')
    open(); await tick()
    assert.equal(readFileSync(VALUES_PATH, 'utf8'), savedBeforeOpen, 'opening the drawer never changes default or explicit choices')
    const optimized = body.querySelector('[data-agent-api-mode="Optimized"]')
    assert.ok(optimized, 'the actual drawer offers the new choice')
    assert.equal(optimized.disabled, false, 'an offered global choice is independent of per-provider support')
    optimized.click(); await tick()
    assert.deepEqual(writes, [{ id: ID, value: 'Optimized' }])
    assert.equal(optimized.getAttribute('aria-pressed'), 'true')
    assert.equal(policy.agentApiMode({ valuesPath: VALUES_PATH }), 'Optimized')
    const stored = JSON.parse(readFileSync(VALUES_PATH, 'utf8'))
    assert.equal(stored.values[ID], 'Optimized')
    assert.equal(stored.values['agent.tool_mode'], 'ToolsEnabled and selected native tools')
    assert.equal(stored.provenance[ID].source, 'user')
    assert.equal(stored.provenance['agent.tool_mode'].source, 'user')
    assert.equal(stored.values['agent.tool_summary'], false)
    assert.equal(stored.values['agent.capability_recall'], true)
    const answer = shell.readProductSettings(settingsOptions)
    const row = answer.rows.find(item => item.id === ID)
    assert.equal(row.value, 'Optimized')
    assert.equal(row.default, 'Only')
    assert.deepEqual(row.optimizedSupport, policy.optimizedApiSupport())
    open(); await tick()
    assert.equal(body.querySelector('[data-agent-api-mode="Optimized"]').getAttribute('aria-pressed'), 'true')
    assert.equal(body.querySelector('[data-agent-api-discovery="agent.tool_summary"]').checked, false)
    assert.equal(body.querySelector('[data-agent-api-discovery="agent.capability_recall"]').checked, true)
    assert.equal(writes.length, 1, 'reopening only reads')
    // rc-0922 decision: the payload's real support rows say plainly that Optimized is Claude-only.
    assert.equal(body.querySelector('[data-agent-api-optimized-support]').textContent,
      'Optimized works with Claude only. '
      + 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits. '
      + 'Codex, Gemini, Grok and local sessions do not start while Optimized is selected.')
    assert.match(body.querySelector('[data-agent-api-status]').textContent, /Works with Claude only; other providers do not start\.$/)
  })


  // Each compatibility case owns a separate retained scratch document. These
  // reads exercise the supplied engine; they never seed installation settings.
  async function withStoredChoices(values, check) {
    const directory = mkdtempSync(path.join(SCRATCH, 'compatibility-'))
    const valuesPath = path.join(directory, 'settings.json')
    const provenance = Object.fromEntries(Object.keys(values).map((id, index) => [
      id, { source: 'user', atMs: 1000 + index, directive: null },
    ]))
    const document = { revision: 1, values, provenance }
    const before = JSON.stringify(document, null, 2) + '\n'
    writeFileSync(valuesPath, before)
    const restoreCaseEnvironment = overrideEnvironment({ TOOLSENABLED_SETTINGS_PATH: valuesPath })
    try {
      await check({ valuesPath, before, provenance, settingsOptions: { root: PAYLOAD, fresh: true } })
    } finally {
      restoreCaseEnvironment()
    }
  }

  const compatibilityChoices = [
    ['Only', 'ToolsEnabled only'],
    ['Optimized', 'ToolsEnabled and selected native tools'],
    ['Enabled', 'ToolsEnabled and native tools'],
    ['Disabled', 'Native tools only'],
  ]

  test('alias-only saved choices migrate on real readback without rewriting bytes or provenance', async () => {
    for (const [mode, alias] of compatibilityChoices) {
      await withStoredChoices({
        'agent.tool_mode': alias, 'agent.tool_summary': false, 'agent.capability_recall': true,
      }, ({ valuesPath, before, provenance, settingsOptions }) => {
        const readback = shell.readProductSettings(settingsOptions)
        assert.equal(readback.ok, true)
        assert.equal(readback.available, true)
        const row = readback.rows.find(item => item.id === ID)
        assert.equal(row.value, mode)
        assert.equal(row.default, 'Only')
        assert.deepEqual(row.provenance, { ...provenance['agent.tool_mode'], migratedFrom: 'agent.tool_mode' })
        assert.ok(!readback.rejected.some(item => item.id === ID || item.id === '*'))
        assert.equal(policy.agentApiMode({ valuesPath }), mode)
        assert.equal(readback.rows.find(item => item.id === 'agent.tool_summary').value, false)
        assert.equal(readback.rows.find(item => item.id === 'agent.capability_recall').value, true)
        assert.equal(readFileSync(valuesPath, 'utf8'), before, 'readback migration never rewrites the explicit document')
      })
    }
  })

  test('a real batch alias write confirms the canonical mode and persists both compatibility values', async () => {
    for (const [mode, alias] of compatibilityChoices) {
      await withStoredChoices({
        [ID]: 'Only', 'agent.tool_mode': 'ToolsEnabled only',
        'agent.tool_summary': true, 'agent.capability_recall': true,
      }, ({ valuesPath, settingsOptions }) => {
        const answer = shell.setProductSettingsMany([
          { id: 'agent.tool_mode', value: alias },
          { id: 'agent.tool_summary', value: false },
        ], settingsOptions)
        assert.equal(answer.ok, true, answer.reason)
        const receipt = answer.results.find(item => item.id === ID)
        assert.equal(receipt?.ok, true)
        assert.equal(receipt.value, mode)
        assert.equal(receipt.provenance.source, 'user')
        const stored = JSON.parse(readFileSync(valuesPath, 'utf8'))
        assert.equal(stored.values[ID], mode)
        assert.equal(stored.values['agent.tool_mode'], alias)
        assert.deepEqual(stored.provenance[ID], stored.provenance['agent.tool_mode'])
        assert.equal(stored.values['agent.tool_summary'], false)
        assert.equal(stored.values['agent.capability_recall'], true)
        const row = shell.readProductSettings(settingsOptions).rows.find(item => item.id === ID)
        assert.equal(row.value, mode)
        assert.equal(row.default, 'Only')
        assert.deepEqual(row.provenance, receipt.provenance)
        assert.equal(policy.agentApiMode({ valuesPath }), mode)
      })
    }
  })

  /* The engine's established reconciliation stays authoritative (rc-0922): legacy false means
     "not Only", so an explicit Optimized alias refines it exactly as a Disabled alias already did;
     legacy true means Only, so it conflicts with the Optimized alias and the drawer refuses edits. */
  test('legacy false with the Optimized alias reads as Optimized without rewriting bytes or provenance', async () => {
    await withStoredChoices({
      [ID]: false, 'agent.tool_mode': 'ToolsEnabled and selected native tools',
      'agent.tool_summary': false, 'agent.capability_recall': true,
    }, ({ valuesPath, before, provenance, settingsOptions }) => {
      const readback = shell.readProductSettings(settingsOptions)
      const row = readback.rows.find(item => item.id === ID)
      assert.equal(row.value, 'Optimized')
      assert.deepEqual(row.provenance, { ...provenance['agent.tool_mode'], migratedFrom: 'agent.tool_mode' })
      assert.ok(!readback.rejected.some(item => item.id === ID || item.id === '*'))
      assert.equal(policy.agentApiMode({ valuesPath }), 'Optimized')
      assert.equal(readFileSync(valuesPath, 'utf8'), before, 'readback migration never rewrites the explicit document')
    })
  })

  test('a conflicting legacy boolean and Optimized alias stay unchanged and the actual drawer refuses edits', async () => {
    for (const legacy of [true]) {
      await withStoredChoices({
        [ID]: legacy, 'agent.tool_mode': 'ToolsEnabled and selected native tools',
        'agent.tool_summary': false, 'agent.capability_recall': true,
      }, async ({ valuesPath, before, provenance, settingsOptions }) => {
        const readback = shell.readProductSettings(settingsOptions)
        const row = readback.rows.find(item => item.id === ID)
        assert.equal(row.value, legacy ? 'Only' : 'Enabled')
        assert.deepEqual(row.provenance, provenance[ID])
        assert.ok(readback.rejected.some(item => item.id === ID && /conflict/i.test(item.reason)))
        assert.throws(() => policy.agentApiMode({ valuesPath }), error => error.code === 'AGENT_API_MODE_UNAVAILABLE')
        const document = createDocument()
        const body = document.createElement('div')
        document.body.appendChild(body)
        body.innerHTML = agentApiSettingMarkup()
        let writes = 0
        bindAgentApiSetting(body, {
          read: () => shell.readProductSettings(settingsOptions),
          set: (id, value) => { writes++; return shell.setProductSetting({ id, value }, settingsOptions) },
        })
        await new Promise(resolve => setImmediate(resolve))
        const buttons = [...body.querySelectorAll('[data-agent-api-mode]')]
        assert.ok(buttons.length > 0)
        assert.ok(buttons.every(button => button.disabled && button.getAttribute('aria-pressed') === 'false'))
        for (const button of buttons) button.click()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(writes, 0, 'a rejected read must never offer a fallback write')
        assert.match(body.querySelector('[data-agent-api-status]').textContent, /cannot read or change the saved Agent API choice/)
        assert.equal(body.querySelector('[data-agent-api-discovery="agent.tool_summary"]').checked, false)
        assert.equal(body.querySelector('[data-agent-api-discovery="agent.capability_recall"]').checked, true)
        assert.equal(readFileSync(valuesPath, 'utf8'), before, 'both original explicit values and provenance are retained')
      })
    }
  })

  /* The writer, run with the row admitted. shell/product-settings.cjs freezes
     WRITABLE_IDS, so the admission is applied by loading a second copy of the
     module with the list extended -- the same code, the same payload modules,
     the same validator, differing only in the one line this lane is holding
     back. Nothing on disk is changed to run it. */
  function driveWrite(value) {
    const source = readFileSync(path.join(ROOT, 'shell', 'product-settings.cjs'), 'utf8')
    const patched = source.replace("  'research.pipeline',", `  '${ID}',\n  'research.pipeline',`)
    assert.notEqual(patched, source, 'the admission list could not be extended for the drive')
    const Module = require_('node:module')
    const copy = new Module(path.join(ROOT, 'shell', 'product-settings.drive.cjs'), null)
    copy.filename = path.join(ROOT, 'shell', 'product-settings.drive.cjs')
    copy.paths = Module._nodeModulePaths(path.join(ROOT, 'shell'))
    copy._compile(patched, copy.filename)
    return copy.exports.setProductSetting({ id: ID, value }, { root: PAYLOAD, fresh: true })
  }
}

test('the no-driveable callback derives and returns its loud skip', () => {
  const fixturePayload = 'fixture-payload-root'
  const fixtureEnforcer = 'fixture-enforcer-path'
  const fixtureAdapter = 'fixture-adapter-path'
  const requiredModules = [fixtureEnforcer, fixtureAdapter]
  const relativeNames = new Map([
    [fixtureEnforcer, 'missing/z-agent-policy.fixture.js'],
    [fixtureAdapter, 'missing/a-claude-adapter.fixture.js'],
  ])
  const existenceChecks = []
  const relativeChecks = []
  const skipReasons = []
  const skipResult = Symbol('skip result')

  const result = noDriveable({
    skip(reason) {
      skipReasons.push(reason)
      return skipResult
    },
  }, {
    payload: fixturePayload,
    requiredModules,
    moduleExists(modulePath) {
      existenceChecks.push(modulePath)
      return false
    },
    relativePath(root, modulePath) {
      relativeChecks.push([root, modulePath])
      return relativeNames.get(modulePath)
    },
  })

  assert.deepEqual(existenceChecks, [fixtureEnforcer, fixtureAdapter],
    'both independently supplied requirements are checked')
  assert.deepEqual(relativeChecks, [
    [fixturePayload, fixtureEnforcer],
    [fixturePayload, fixtureAdapter],
  ], 'each displayed name is derived from the independently supplied payload and module path')
  const expectedReason = 'this payload lacks the required input path(s): missing/a-claude-adapter.fixture.js, missing/z-agent-policy.fixture.js; the control -> file -> enforcer -> argv drive did not run; point MC_TEST_AGENT_API_PAYLOAD at a payload containing all requirements'
  assert.deepEqual(skipReasons, [expectedReason],
    'the callback must skip exactly once with the independently expected derived reason')
  assert.equal(result, skipResult,
    'the callback must return the skip result; calling skip and falling through is not the contract')
})


test('the harness restores every present and absent caller environment combination', () => {
  for (const saved of [
    {},
    { TOOLSENABLED_SETTINGS_PATH: 'caller-settings' },
    { TOOLSENABLED_STATE_ROOT: 'caller-state' },
    { TOOLSENABLED_SETTINGS_PATH: 'caller-settings', TOOLSENABLED_STATE_ROOT: 'caller-state' },
  ]) {
    const before = { ...saved, unrelated: 'retained' }
    const env = { ...before }
    const restore = overrideEnvironment({
      TOOLSENABLED_SETTINGS_PATH: 'suite-settings',
      TOOLSENABLED_STATE_ROOT: 'suite-state',
    }, env)
    assert.equal(env.TOOLSENABLED_SETTINGS_PATH, 'suite-settings')
    assert.equal(env.TOOLSENABLED_STATE_ROOT, 'suite-state')
    restore()
    assert.deepEqual(env, before)
  }
})

test('a missing registry is distinct from unreadable or malformed registry data', () => {
  const root = 'fixture-registry-root'
  const missing = Object.assign(new Error('fixture absent'), { code: 'ENOENT' })
  assert.equal(registryOf(root, () => { throw missing }), null)
  const denied = Object.assign(new Error('fixture refused'), { code: 'EACCES' })
  assert.throws(() => registryOf(root, () => { throw denied }),
    error => error.code === 'AGENT_API_DRIVE_REGISTRY_UNREADABLE' && error.cause === denied)
  for (const raw of ['{', '{}', 'null']) {
    assert.throws(() => registryOf(root, () => raw),
      error => error.code === 'AGENT_API_DRIVE_REGISTRY_INVALID')
  }
  assert.deepEqual(registryOf(root, () => '{"entries":[]}'), { entries: [] })
})

test('unloadable payload dependencies fail explicitly and never become a missing-file skip', () => {
  const policy = { kind: 'policy' }, adapter = { kind: 'adapter' }
  const paths = { enforcer: 'fixture-enforcer', adapter: 'fixture-adapter' }
  assert.deepEqual(loadDriveModules({ ...paths, load: file => file === paths.enforcer ? policy : adapter }),
    { policy, adapter })
  for (const failedPath of Object.values(paths)) {
    const cause = Object.assign(new Error('fixture transitive dependency refused'), { code: 'MODULE_NOT_FOUND' })
    assert.throws(() => loadDriveModules({ ...paths, load: file => {
      if (file === failedPath) throw cause
      return policy
    } }), error => error.code === 'AGENT_API_DRIVE_LOAD_REFUSED' && error.cause === cause)
  }
})

test('a required missing payload fails without taking the optional no-drive skip', () => {
  let skips = 0
  assert.throws(() => noDriveable({ skip() { skips++ } }, {
    payload: 'required-fixture-payload',
    requiredModules: ['missing-required-enforcer'],
    moduleExists: () => false,
    relativePath: () => 'src/missing-required-enforcer.js',
    required: true,
  }), error => error.code === 'AGENT_API_DRIVE_REQUIRED_PAYLOAD_UNAVAILABLE')
  assert.equal(skips, 0)
})

test('a selected payload missing only its registry gets the required-input refusal', () => {
  let skips = 0
  assert.throws(() => noDriveable({ skip() { skips++ } }, {
    required: true,
    moduleExists: file => file !== DRIVE_REGISTRY,
    relativePath: (root, file) => path.relative(root, file),
  }), error => error.code === 'AGENT_API_DRIVE_REQUIRED_PAYLOAD_UNAVAILABLE'
    && error.message.includes(path.join('config', 'settings-registry.json')))
  assert.equal(skips, 0)
})
