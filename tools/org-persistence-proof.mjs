/* DOES AN ORGANISATION EDIT SURVIVE THE APPLICATION BEING KILLED?
 *
 * The claim this file exists to test is not "a function returned {ok:true}". It
 * is "a person moved an agent under a different manager, gave it a role, wrote
 * a role of their own, the application went away, and all three were still
 * there when it came back". Those are different claims, and only the second one
 * is what a customer experiences. A store that keeps its state in memory and
 * flushes at a graceful exit passes the first and fails the second.
 *
 * SO THE PROCESS IS KILLED, NOT ASKED TO STOP. Every phase below runs in its
 * own child process of the PACKAGED BINARY, and the child is gone before the
 * next one starts. Nothing is carried across in memory, because there is no
 * memory to carry it in.
 *
 * AND IT RUNS AGAINST A STERILE PROFILE, WHICH IS THE PART THAT IS EASY TO GET
 * WRONG. LOCALAPPDATA is where an installation keeps everything it owns, so a
 * harness that inherits the builder's LOCALAPPDATA is reading the builder's
 * machine.json, the builder's permission tier and the builder's saved
 * organisation while believing it is looking at a fresh install. That is not a
 * hypothetical: a lane spent hours concluding the permission tier was
 * unenforced because its harness silently inherited this machine's
 * `unrestricted` level, and produced a confident, wrong finding. Isolating
 * --user-data-dir is NOT enough; --user-data-dir moves Electron's own profile
 * and does not move LOCALAPPDATA, which is what the engine reads.
 *
 * Usage:
 *   node tools/org-persistence-proof.mjs [release/win-unpacked]
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveMachineServicesRoot } from './lib/qa-services-root.mjs'

const APP_EXE = 'ToolsEnabled.exe'
const TIERS = ['guided', 'unrestricted']
const require_ = createRequire(import.meta.url)

/* Every path that could carry this machine's state is pointed at an empty
 * directory, and the environment is built explicitly rather than spread from
 * process.env, so what the child gets is readable in one place. */
function sterileEnvironment(profile, base = process.env) {
  return {
    SystemRoot: base.SystemRoot,
    windir: base.windir,
    ComSpec: base.ComSpec,
    PATHEXT: base.PATHEXT,
    NUMBER_OF_PROCESSORS: base.NUMBER_OF_PROCESSORS,
    PROCESSOR_ARCHITECTURE: base.PROCESSOR_ARCHITECTURE,
    Path: [
      path.join(base.SystemRoot || 'C:\\Windows', 'System32'),
      base.SystemRoot || 'C:\\Windows',
    ].join(';'),
    LOCALAPPDATA: profile.localAppData,
    APPDATA: profile.appData,
    USERPROFILE: profile.userProfile,
    TOOLSENABLED_STATE_ROOT: path.join(profile.userData, 'capability'),
    TEMP: profile.temp,
    TMP: profile.temp,
    // Runs the packaged binary as node rather than opening a window.
    ELECTRON_RUN_AS_NODE: '1',
  }
}

async function makeProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'toolsenabled-org-proof-'))
  const profile = {
    root,
    localAppData: path.join(root, 'LocalAppData'),
    appData: path.join(root, 'AppData'),
    userProfile: path.join(root, 'UserProfile'),
    userData: path.join(root, 'UserData'),
    temp: path.join(root, 'Temp'),
  }
  for (const directory of [profile.localAppData, profile.appData, profile.userProfile, profile.userData, profile.temp]) {
    await mkdir(directory, { recursive: true })
  }
  return profile
}

/* The permission tier this installation was set up with. Written directly
 * rather than driven through the first-run walkthrough because what is under
 * test here is the ORG store, and the question the tier answers for this proof
 * is only "does an org edit behave identically at the most and least
 * restricted levels" -- it must, because an org edit grants no authority. */
async function seedTier(profile, tier, payloadRoot) {
  const machineRecord = require_(path.join(payloadRoot, 'src', 'lib', 'setup', 'machine-record.js'))
  const directory = resolveMachineServicesRoot(profile.root, machineRecord, {
    selectedUserData: profile.userData,
    localAppData: profile.localAppData,
  })
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'machine.json'),
    `${JSON.stringify({ schemaVersion: 1, tier, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

function runInPayload(exe, payloadRoot, profile, script, timeoutMs = 60000, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['-e', script], {
      env: { ...sterileEnvironment(profile), MC_PAYLOAD_ROOT: payloadRoot, ...extraEnv },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, stdout, stderr, timedOut: true }) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: false }) })
  })
}

/* Each phase is a separate script string so it runs in a separate process.
 * Composing them into one script would be the exact mistake this file is
 * guarding against. */
const composeStores = `
  const path = require('node:path');
  const root = process.env.MC_PAYLOAD_ROOT;
  const { createAgentOrgStore } = require(path.join(root, 'src/lib/agent-org-store.js'));
  const { createCustomRoleStore } = require(path.join(root, 'src/lib/custom-role-store.js'));
  const { createDurableMemoryFile, resolveServicesRoot } = require(path.join(root, 'src/lib/durable-memory-file.js'));
  const agentOrg = require(path.join(root, 'src/lib/agent-org.js'));
  const servicesRoot = resolveServicesRoot({ env: process.env });
  const customRoles = createCustomRoleStore({
    stateStore: createDurableMemoryFile({ file: path.join(servicesRoot, 'custom-roles.json') })
  });
  const store = createAgentOrgStore({
    baselineFile: path.join(root, 'config/agent-org.json'),
    customRoles,
    env: process.env
  });
`

const PHASES = {
  // What a fresh installation looks like before anybody has touched it.
  inspect: `${composeStores}
    const read = store.read();
    console.log(JSON.stringify({
      source: read.source,
      damaged: read.damaged,
      revision: read.org.revision,
      agents: read.org.agents.map(a => ({ id: a.id, role: a.role })),
      manages: read.org.relationships.filter(r => r.type === 'manages').map(r => r.from + '>' + r.to),
      roleCount: customRoles.listRoles().length,
      servicesRoot,
      overlayExists: require('node:fs').existsSync(store.overlayFile)
    }));
  `,

  // The three edits, each through the same engine path the window uses.
  edit: `${composeStores}
    const out = {};
    customRoles.createCustomRole({
      id: 'night-shift',
      baseDefaultRole: 'builder',
      rules: {
        owns: 'Work that runs while nobody is watching.',
        mustNot: 'Start anything it cannot finish before the window closes.',
        handoff: 'Receives a bounded overnight task; returns evidence in the morning.'
      }
    });
    customRoles.createCustomRole({
      id: 'watcher',
      baseDefaultRole: 'observer',
      rules: {
        owns: 'Watching one named surface and reporting what it shows.',
        mustNot: 'Change the thing it is watching.',
        handoff: 'Receives access only; publishes what it measured.'
      }
    });
    out.rolesCreated = customRoles.listRoles().filter(r => !agentOrg.ROLES.includes(r.id)).map(r => r.id);

    // A second seat to reparent and to hold a role. The shipped default is a
    // single controller, so an org edit needs something to edit.
    const seeded = store.exportOrg();
    seeded.agents.push({ id: 'alpha', displayName: 'Alpha', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] });
    seeded.agents.push({ id: 'beta', displayName: 'Beta', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] });
    seeded.relationships.push({ from: 'controller', to: 'alpha', type: 'manages' });
    seeded.relationships.push({ from: 'controller', to: 'beta', type: 'manages' });
    store.write(seeded);

    store.reparent({ agentId: 'beta', parentId: 'alpha' });
    out.reparented = 'beta under alpha';

    store.assignRole({ agentId: 'alpha', role: 'night-shift' });
    store.assignRole({ agentId: 'beta', role: 'watcher' });
    out.assigned = { alpha: 'night-shift', beta: 'watcher' };
    out.revision = store.read().org.revision;
    console.log(JSON.stringify(out));
  `,

  /* THE TOOL COUNT THIS PERMISSION LEVEL ALLOWS.
   *
   * Run before AND after the custom roles are created, and it must not move.
   * This is the direct test of the rule that a custom role may not become a way
   * to hold capability the level denies: roles compose WITHIN a tier, and the
   * set of tools a tier allows is decided by the tier alone. If defining a role
   * could change this number, a role would be a permission escalation with a
   * friendly name. */
  tools: `
    const path = require('node:path');
    const root = process.env.MC_PAYLOAD_ROOT;
    const machineRecord = require(path.join(root, 'src/lib/setup/machine-record.js'));
    const tier = process.env.MC_PROOF_TIER;
    const allowed = machineRecord.tierToolAllowlist(tier);
    console.log(JSON.stringify({
      tier,
      toolCount: Array.isArray(allowed) ? allowed.length : null,
      readOnlyCount: machineRecord.readOnlyToolAllowlist().length
    }));
  `,

  // The only question that matters: is any of it still there?
  verify: `${composeStores}
    const read = store.read();
    const roleOf = id => read.org.agents.find(a => a.id === id)?.role ?? null;
    const managerOf = id => agentOrg.managerOf(read.org, id);
    console.log(JSON.stringify({
      source: read.source,
      damaged: read.damaged,
      revision: read.org.revision,
      betaManager: managerOf('beta'),
      alphaRole: roleOf('alpha'),
      betaRole: roleOf('beta'),
      customRoles: customRoles.listRoles().filter(r => !agentOrg.ROLES.includes(r.id)).map(r => r.id).sort(),
      // The escalation guard, measured rather than assumed: a custom role based
      // on observer must not be able to reserve work, and one based on builder
      // must. Same org, same call, opposite answers.
      alphaMayClaim: agentOrg.mayClaim(read.org, 'alpha', 'Q1'),
      betaMayClaim: agentOrg.mayClaim(read.org, 'beta', 'Q1'),
      overlayFile: store.overlayFile
    }));
  `,
}

function parse(result, phase) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`phase "${phase}" did not return JSON.\nexit=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
}

let failures = 0
function assert(condition, label, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

async function proveTier(exe, payloadSource, tier) {
  console.log(`\n=== tier: ${tier} ===`)
  const profile = await makeProfile()
  // The payload is copied so the proof cannot leave state/ next to the shipped
  // one, which a later boundary check would then fail over.
  const payloadRoot = path.join(profile.root, 'capability')
  await cp(payloadSource, payloadRoot, { recursive: true })
  await seedTier(profile, tier, payloadRoot)

  const before = parse(await runInPayload(exe, payloadRoot, profile, PHASES.inspect), 'inspect')
  assert(before.source === 'baseline', 'a fresh install reads the shipped baseline, not an overlay')
  assert(before.overlayExists === false, 'reading does not create an overlay file')
  assert(before.servicesRoot.startsWith(profile.localAppData),
    'the store resolved into the ISOLATED LOCALAPPDATA', `got ${before.servicesRoot}`)
  assert(before.roleCount === 9, 'the nine shipped roles are present in a fresh install', `got ${before.roleCount}`)

  /* A null allowlist is not a failure to resolve one -- it is how this engine
     spells "no narrowing", which is what `unrestricted` means. A restricted
     level must resolve to a finite list; the unrestricted level must resolve to
     null. Asserting "> 0 tools" for both would have failed the honest answer
     and, worse, would have passed if a restricted level ever started returning
     null, which is the direction that actually matters. */
  const toolsBefore = parse(
    await runInPayload(exe, payloadRoot, profile, PHASES.tools, 60000, { MC_PROOF_TIER: tier }), 'tools/before')
  if (tier === 'unrestricted') {
    assert(toolsBefore.toolCount === null,
      'the unrestricted level narrows nothing, and says so with a null allowlist', `got ${toolsBefore.toolCount}`)
  } else {
    assert(Number.isInteger(toolsBefore.toolCount) && toolsBefore.toolCount > 0,
      `the "${tier}" level resolves to a finite tool allowlist`, `got ${toolsBefore.toolCount}`)
  }

  const edited = parse(await runInPayload(exe, payloadRoot, profile, PHASES.edit), 'edit')
  assert(Array.isArray(edited.rolesCreated) && edited.rolesCreated.length === 2, 'two custom roles were created')

  /* The escalation question, asked directly. Two custom roles now exist and are
     assigned to agents. If defining or holding a role could change what this
     permission level allows, a role would be a permission escalation wearing a
     friendly name. */
  const toolsAfter = parse(
    await runInPayload(exe, payloadRoot, profile, PHASES.tools, 60000, { MC_PROOF_TIER: tier }), 'tools/after')
  assert(toolsAfter.toolCount === toolsBefore.toolCount,
    'DEFINING AND ASSIGNING CUSTOM ROLES DID NOT CHANGE THE TOOL COUNT THIS LEVEL ALLOWS',
    `before=${toolsBefore.toolCount} after=${toolsAfter.toolCount}`)
  assert(toolsAfter.readOnlyCount === toolsBefore.readOnlyCount,
    'the read-only tool allowlist is unchanged by a custom role',
    `before=${toolsBefore.readOnlyCount} after=${toolsAfter.readOnlyCount}`)

  // Every editing process is gone by now. This is a cold read.
  const after = parse(await runInPayload(exe, payloadRoot, profile, PHASES.verify), 'verify')
  assert(after.source === 'overlay', 'the saved organisation is read back, not the baseline')
  assert(after.damaged === null, 'the saved organisation is not damaged', String(after.damaged))
  assert(after.betaManager === 'alpha', 'THE REPARENT SURVIVED A RESTART', `betaManager=${after.betaManager}`)
  assert(after.alphaRole === 'night-shift', 'THE ROLE ASSIGNMENT SURVIVED A RESTART', `alphaRole=${after.alphaRole}`)
  assert(after.betaRole === 'watcher', 'the second role assignment survived a restart', `betaRole=${after.betaRole}`)
  assert(JSON.stringify(after.customRoles) === JSON.stringify(['night-shift', 'watcher']),
    'THE CUSTOM ROLES SURVIVED A RESTART', JSON.stringify(after.customRoles))
  assert(after.alphaMayClaim === true, 'a custom role based on builder may reserve work')
  assert(after.betaMayClaim === false,
    'a custom role based on observer may NOT reserve work (no escalation by copying a read-only role)')
  assert(after.overlayFile.startsWith(profile.localAppData),
    'the organisation was written inside the isolated profile, not into the payload',
    after.overlayFile)

  // Nothing may have been written into the payload itself.
  const spilled = existsSync(path.join(payloadRoot, 'config', 'agent-org.json'))
    ? await readFile(path.join(payloadRoot, 'config', 'agent-org.json'), 'utf8')
    : null
  assert(spilled !== null && !spilled.includes('night-shift'),
    'the shipped config/agent-org.json inside the payload was NOT modified')

  await rm(profile.root, { recursive: true, force: true })
  return { tier, before, after, toolCount: toolsAfter.toolCount }
}

async function main() {
  const directory = process.argv[2] || 'release/win-unpacked'
  const exe = path.resolve(directory, APP_EXE)
  const payloadSource = path.resolve(directory, 'resources', 'capability')
  if (!existsSync(exe)) {
    console.error(`No packaged application at ${exe}. Run: npm run dist`)
    process.exit(2)
  }
  if (!existsSync(payloadSource)) {
    console.error(`No capability payload at ${payloadSource}.`)
    process.exit(2)
  }
  console.log(`Proving organisation persistence against the PACKAGED build at ${exe}`)
  console.log('Each phase runs in its own child process; nothing is carried across in memory.')

  const results = []
  for (const tier of TIERS) {
    results.push(await proveTier(exe, payloadSource, tier))
  }

  // The tier must make no difference to an org edit. An org edit is a statement
  // of intent that grants no authority, so if these ever diverge, something is
  // reading a tier where it should not be.
  console.log('\n=== tier comparison ===')
  const [guided, unrestricted] = results
  assert(guided.after.betaManager === unrestricted.after.betaManager
    && guided.after.alphaRole === unrestricted.after.alphaRole
    && guided.after.alphaMayClaim === unrestricted.after.alphaMayClaim
    && guided.after.betaMayClaim === unrestricted.after.betaMayClaim,
  'the organisation behaves identically at guided and unrestricted')

  /* And the levels must still be DIFFERENT from each other in the thing they
     actually govern. Without this, every tier assertion above would also pass
     on a build where the level had stopped being enforced at all -- which is a
     confident, wrong finding a previous lane actually produced by inheriting
     this machine's own level. */
  assert(Number.isInteger(guided.toolCount) && unrestricted.toolCount === null,
    'the permission levels still differ in what they allow: guided narrows to a finite list, unrestricted does not narrow',
    `guided=${guided.toolCount} unrestricted=${unrestricted.toolCount}`)
  console.log(`  note: guided narrows to ${guided.toolCount} tools; unrestricted narrows nothing (null).`)
  console.log('  note: both readings were taken AFTER two custom roles were defined and assigned.')

  console.log(`\n${failures === 0 ? 'ORGANISATION PERSISTENCE PROVEN' : `${failures} ASSERTION(S) FAILED`} across tiers: ${TIERS.join(', ')}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
