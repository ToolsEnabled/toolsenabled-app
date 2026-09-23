/* A CLAUDE SUBSCRIBER MUST NOT NEED A CODEX ACCOUNT.
 *
 * WHAT WAS MEASURED, on the packaged 1.0.20 with Claude signed in and no Codex
 * sign-in anywhere on the machine: pressing Start on a Claude tier was refused
 * with "Codex is installed on this computer, but nobody is signed in to it ...
 * run codex login". Honest about what it found, wrong about what it meant --
 * nothing on the Claude path opens ~/.codex/auth.json.
 *
 * WHY IT HAPPENED. Every level in the payload's INSTALL_TIER_AGENT_CONFINEMENT
 * is `isolated: true`, and confinedSessionPlan() answers an isolated level by
 * preparing an isolated CODEX home and linking the user's Codex credential into
 * it. linkCredential() refuses when there is nothing to link. That is right for
 * Codex and was the plan for every provider, because it predates there being a
 * second one.
 *
 * THESE ASSERTIONS RUN THE REAL MODULES, NOT STUBS. The planner is the payload's
 * own capability/src/lib/agent-session-confinement.js, the record is written by
 * the payload's own machine-record builder, and the decision under test is the
 * shell's exported confinementPlanFor(). The only thing arranged is the machine:
 * LOCALAPPDATA and CODEX_HOME point at a scratch profile, which is how a
 * computer with no Codex sign-in is reproduced without touching a real one.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the negative control is the point. A change
 * that made every start pass would satisfy the first half of this suite and
 * would be a security regression: it would start a Codex session with no
 * credential and no confined home. So the same missing file must still refuse a
 * CODEX start, with the same code and the same sentence it always had.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAYLOAD = path.join(REPO, 'capability')
const planner = require_(path.join(PAYLOAD, 'src', 'lib', 'agent-session-confinement.js'))
const machineRecord = require_(path.join(PAYLOAD, 'src', 'lib', 'setup', 'machine-record.js'))
const { confinementPlanFor } = require_(path.join(REPO, 'shell', 'agent-host.cjs'))

/* node_modules can be a shared junction. The real state-root gate correctly
   refuses LOCALAPPDATA beneath a reparse point, so a fixture there never
   reaches the provider decision these assertions exercise. Use this
   installation's verified account temp, not inherited profile variables, and
   a unique suite directory so concurrent test runs cannot remove each other. */
const profileRoot = planner.installationProfileRoot()
const fixtureTemp = planner.assertAccountProfilePath(process.platform === 'win32'
  ? path.join(profileRoot, 'AppData', 'Local', 'Temp')
  : os.tmpdir(), { field: 'provider-plan fixture temp', profileRoot, requireOwnedProfile: process.platform === 'win32' })
const TEST_SCRATCH_ROOT = mkdtempSync(path.join(fixtureTemp, 'mc-provider-plan-suite-'))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

/* WHETHER THE PAYLOAD UNDER TEST CAN BUILD A CONFINED CLAUDE HOME. The pinned
   payload is repacked by the coordinator, never hand-edited here, so this file
   must be true of BOTH the payload that predates confinedClaudeSessionPlan()
   and the one that carries it. Every Claude assertion below branches on this
   single fact rather than on a guess about the pin. */
const payloadBuildsToolSurface = typeof planner.claudeToolsSessionPlan === 'function'

/* A whole machine, in a temporary directory: a recorded permission level, a
   workspace, and provider homes that either hold a sign-in or do not.
   CLAUDE_CONFIG_DIR is pinned to scratch for the same reason CODEX_HOME is:
   a payload that builds confined Claude homes links the sign-in FROM the
   ambient claude home, and a test must never reach a real one. */
function withMachine({ tier = 'standard', codexSignedIn = false, claudeSignedIn = false }, run) {
  const scratch = mkdtempSync(path.join(TEST_SCRATCH_ROOT, 'mc-provider-plan-'))
  const localAppData = path.join(scratch, 'local')
  const servicesRoot = path.join(localAppData, 'ToolsEnabled')
  const workspace = path.join(scratch, 'workspace')
  const codexHome = path.join(scratch, 'codex-home')
  const claudeHome = path.join(scratch, 'claude-home')
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(claudeHome, { recursive: true })
  if (codexSignedIn) {
    /* Inert bytes. linkCredential() links the FILE and never reads it, so this
       proves the gate is about presence -- which is all the product ever knew. */
    writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ note: 'not a credential' }))
  }
  if (claudeSignedIn) {
    writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ note: 'not a credential' }))
  }


  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
    TOOLSENABLED_SETTINGS_PATH: process.env.TOOLSENABLED_SETTINGS_PATH,
  }
  process.env.LOCALAPPDATA = localAppData
  process.env.CODEX_HOME = codexHome
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  // An absent, test-owned settings file exercises the shipped defaults without
  // inheriting an owner's saved API mode. Individual ceiling tests select Enabled.
  process.env.TOOLSENABLED_SETTINGS_PATH = path.join(scratch, 'settings.json')
  /* THE RUNNING PRODUCT'S IDENTITY, STATED THE WAY THE SHELL STATES IT.
     resolveServicesRoot() used to fall back to a literal 'ToolsEnabled' when this
     was unset, which is exactly how a renamed test build reached the REAL
     product's machine.json and credentials. It now refuses by name instead, so a
     caller that does not say who it is gets
     SERVICE_PRODUCT_IDENTITY_UNAVAILABLE rather than somebody else's data. This
     test builds a scratch servicesRoot two lines above and simply never said so;
     shell/main.cjs sets the same variable from Electron's own userData path. */
  /* ONE LEVEL INSIDE the services root, which is the shape the shell uses:
     shell/main.cjs sets it to path.join(SHELL_USER_DATA_PATH, 'capability').
     resolveProductDirectory() takes basename(dirname(STATE_ROOT)), so pointing
     it AT servicesRoot makes the product directory resolve to the scratch
     folder's own name and the machine record is then looked for somewhere it was
     never written -- which reads as a machine with no record and fails closed to
     `guided`. That is the resolver being right and the caller being vague. */
  process.env.TOOLSENABLED_STATE_ROOT = path.join(servicesRoot, 'capability')
  try {
    const record = machineRecord.buildMachineRecord({
      tier,
      servicesRoot,
      installRoot: PAYLOAD,
      nodePath: process.execPath,
      workspaceRoots: [workspace],
    })
    machineRecord.writeMachineRecord(record, { servicesRoot })
    return run({
      scratch,
      servicesRoot,
      codexHome,
      claudeHome,
      codexAccount: Object.freeze({ name: 'fixture-codex', resolvedHome: codexHome }),
      claudeAccount: Object.freeze({ name: 'fixture-claude', resolvedHome: claudeHome }),
    })
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a machine with no Codex sign-in still refuses a Codex start, by name', () => {
  /* THE NEGATIVE CONTROL, first, because every other assertion in this file is
     only worth reading if this one holds. The missing credential is a real
     refusal for the provider that reads it, and it must stay one. */
  withMachine({ codexSignedIn: false }, ({ codexAccount }) => {
    const plan = confinementPlanFor(planner, { provider: 'codex', account: codexAccount })
    assert.equal(plan.ok, false, 'a Codex session was planned against a machine with no Codex sign-in')
    assert.equal(plan.code, 'AGENT_CONFINEMENT_SIGNED_OUT')
  })
})

test('API Enabled plans a Claude session at the level the person recorded', () => {
  /* claudeSignedIn matters only to a payload that builds confined Claude
     homes: that payload links the person's sign-in into a home this
     installation owns, and refuses honestly when there is nothing to link.
     The older payload never looks. */
  withMachine({ codexSignedIn: false, claudeSignedIn: true, tier: 'standard' }, ({ servicesRoot, claudeAccount }) => {
    const plan = confinementPlanFor(planner, { provider: 'claude', account: claudeAccount, agentApiMode: 'Enabled' })
    assert.equal(plan.ok, true, 'a Claude start is still gated on a Codex credential it never reads')
    assert.equal(plan.agentApiMode, 'Enabled')
    assert.equal(plan.tier, 'standard')
    /* THE CEILING IS CARRIED, NOT DROPPED. claudeArgs() in the payload's
       claude-cli-adapter.js maps exactly this word to --permission-mode
       (workspace-write -> acceptEdits), so the level the person chose is what
       the child is launched under. A plan that answered ok with no sandbox word
       would be this change quietly removing the confinement instead of moving
       it. */
    assert.equal(plan.threadOptions.sandbox, 'workspace-write')
    assert.equal(plan.threadOptions.approvalPolicy, 'never')
    /* No Codex home is prepared and no provider home rides through the
       environment. Standard profile variables are pinned to the installation
       account so stale launch variables cannot select another account's
       directives; configDir below selects the intended Claude account. */
    assert.equal(plan.codexHome ?? null, null)
    assert.equal(plan.env.USERPROFILE, planner.installationProfileRoot())
    assert.equal(plan.env.CODEX_HOME, undefined)
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, undefined)
    if (payloadBuildsToolSurface) {
      /* THE LEAK THIS PLAN ENDS, measured from inside the product on
         2026-08-19: a session spawned with no --mcp-config -- "no ToolsEnabled
         MCP server is connected", its own words. The plan must name the
         generated tool file for the recorded level AND the grant beside it,
         without which those servers connect and then refuse every call.

         AND WHAT IT MUST NOT DO: build a copied home or link a credential into
         one. configDir names the selected existing directory inside the
         installation-owned profile; the official client reads its sign-in and
         global instructions there without stale ambient profile variables
         selecting a different Windows account. */
      const surface = path.join(servicesRoot, 'agent-tools', 'claude', 'standard')
      assert.equal(plan.configDir, claudeAccount.resolvedHome,
        'the shipped plan must pin Claude to the selected in-profile configuration directory')
      assert.equal(plan.mcpConfig, path.join(surface, '.mcp.json'))
      assert.equal(plan.settings, path.join(surface, 'settings.json'))
      assert.ok(Array.isArray(plan.servers) && plan.servers.length > 0,
        'the plan carries no servers, so the tool note stays refused and the session has no product tools')
      /* The recorded level's CLI mode rides the same plan object, so the one
         level has one reader -- the engine passes it as --permission-mode. */
      assert.equal(plan.claudePermissionMode, 'acceptEdits')
    } else {
      /* The older payload plans from the recorded level alone: no home, no
         tool file, and the session reads the ambient claude home. That is the
         measured defect this lane fixed engine-side; the pinned payload keeps
         its own behaviour until the coordinator repacks. */
      assert.equal(plan.configDir ?? null, null)
      assert.equal(plan.mcpConfig ?? null, null)
    }
  })
})

test('a machine with no Claude sign-in still gets its tools, because none of this reads a credential', () => {
  /* THE SHIPPED PATH TOUCHES NO SIGN-IN AT ALL, and this is where that becomes
     visible: with no Claude credential anywhere, the plan still succeeds and
     still carries the level's tools. The session signs itself in exactly as it
     does in the person's own terminal, which is the proven path. A payload that
     predates the tool surface plans nothing, as it always did. */
  withMachine({ codexSignedIn: false, claudeSignedIn: false, tier: 'standard' }, ({ claudeAccount }) => {
    const plan = confinementPlanFor(planner, { provider: 'claude', account: claudeAccount })
    if (payloadBuildsToolSurface) {
      assert.equal(plan.ok, true, 'a missing Claude sign-in blocked a plan that never reads one')
      assert.equal(plan.configDir, claudeAccount.resolvedHome)
      assert.ok(typeof plan.mcpConfig === 'string' && plan.mcpConfig.length > 0)
      assert.ok(typeof plan.settings === 'string' && plan.settings.length > 0)
    } else {
      assert.equal(plan.ok, true)
      assert.equal(plan.configDir ?? null, null)
    }
  })
})

test('API Enabled carries every recorded level to the Claude plan with its own ceiling', () => {
  /* One tier is a coincidence; three is the mapping. If this ever answers one
     sandbox word for every level, the Claude path has stopped being confined by
     the person's own answer. */
  const seen = {}
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    withMachine({ codexSignedIn: false, claudeSignedIn: true, tier }, ({ claudeAccount }) => {
      const plan = confinementPlanFor(planner, { provider: 'claude', account: claudeAccount, agentApiMode: 'Enabled' })
      assert.equal(plan.ok, true, `${tier} could not plan a Claude session`)
      assert.equal(plan.agentApiMode, 'Enabled')
      seen[tier] = plan.threadOptions.sandbox
    })
  }
  assert.deepEqual(seen, {
    guided: 'read-only',
    standard: 'workspace-write',
    unrestricted: 'danger-full-access',
  })
})

test('API Enabled preserves the Codex ceiling on a signed-in machine', () => {
  /* The other half of "this widens nothing": with the credential present, the
     Codex plan is exactly what it was -- isolated, with a prepared home and the
     CODEX_HOME pin that keeps the user's own MCP servers out of the session. */
  withMachine({ codexSignedIn: true, tier: 'standard' }, ({ codexAccount }) => {
    const plan = confinementPlanFor(planner, { provider: 'codex', account: codexAccount, agentApiMode: 'Enabled' })
    assert.equal(plan.ok, true)
    assert.equal(plan.agentApiMode, 'Enabled')
    assert.equal(plan.isolated, true)
    assert.equal(typeof plan.codexHome, 'string')
    assert.equal(typeof plan.env.CODEX_HOME, 'string')
    assert.equal(plan.threadOptions.sandbox, 'workspace-write')
  })
})

test('the default API Only keeps both providers read-only at every recorded level', () => {
  for (const provider of ['codex', 'claude']) {
    for (const tier of ['guided', 'standard', 'unrestricted']) {
      withMachine({ codexSignedIn: true, claudeSignedIn: true, tier }, ({ codexAccount, claudeAccount }) => {
        const account = provider === 'codex' ? codexAccount : claudeAccount
        const plan = confinementPlanFor(planner, { provider, account })
        assert.equal(plan.ok, true, `${provider}/${tier} could not plan the default API Only session`)
        assert.equal(plan.tier, tier)
        assert.equal(plan.agentApiMode, 'Only')
        assert.equal(plan.roleFunctionsOnly, true)
        assert.equal(plan.threadOptions.sandbox, 'read-only')
        assert.equal(plan.threadOptions.approvalPolicy, 'never')
      })
    }
  }
})

test('a payload with no level reader falls back to the Codex plan rather than inventing one', () => {
  /* FAIL CLOSED ON AN OLDER PAYLOAD. resolveAgentConfinement() is the export
     this change reads the level from. A payload that predates it must keep
     today's behaviour -- Codex plan, Codex refusal -- and must never be handed a
     session at a level nobody resolved. */
  withMachine({ codexSignedIn: false }, ({ codexAccount }) => {
    const older = { confinedSessionPlan: planner.confinedSessionPlan }
    const plan = confinementPlanFor(older, { provider: 'claude', account: codexAccount })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'AGENT_CONFINEMENT_SIGNED_OUT')
  })
})

test('an absent provider is the Codex path, because the agent page start has no tier', () => {
  withMachine({ codexSignedIn: false }, ({ codexAccount }) => {
    const plan = confinementPlanFor(planner, { account: codexAccount })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'AGENT_CONFINEMENT_SIGNED_OUT')
  })
})

test('the real planner still refuses a services path through a junction', { skip: process.platform !== 'win32' }, () => {
  withMachine({}, ({ scratch, servicesRoot, claudeAccount }) => {
    const alias = path.join(scratch, 'linked-services')
    symlinkSync(servicesRoot, alias, 'junction')
    try {
      process.env.TOOLSENABLED_STATE_ROOT = path.join(alias, 'capability')
      const plan = confinementPlanFor(planner, { provider: 'claude', account: claudeAccount })
      assert.equal(plan.ok, false)
      assert.equal(plan.code, 'SERVICE_ACCOUNT_BOUNDARY_REFUSED')
    } finally {
      // Remove this run's link itself, never traverse its target for cleanup.
      unlinkSync(alias)
    }
  })
})
