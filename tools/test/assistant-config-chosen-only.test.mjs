/* WHERE THE PERSON'S ASSISTANT CONFIGURATION MAY BE WRITTEN, AND WHERE IT MAY NOT.
 *
 * THE DEFECT, MEASURED 2026-08-22 (twice): launching ANY build of the application
 * with a fresh --user-data-dir -- the packaged smoke run, a Playwright harness --
 * rewrote the builder's workspace `.mcp.json` so that its three servers pointed at
 * whatever build directory that instance ran from. Every later agent session in
 * that workspace then started its tool servers from the build output and held
 * the executable open, and `npm run dist` refused to replace it.
 *
 * HOW. The machine record is not in the Electron profile: it lives in
 * %LOCALAPPDATA%\ToolsEnabled\machine.json, so a "fresh" profile that inherits
 * the builder's environment reads the builder's record. That record named the
 * builder's workspace as its first root, and shell/setup-record.cjs
 * refreshChosenAssistantConfig -- run from shell/main.cjs on every launch --
 * rewrote the `.mcp.json` there from the running build. The smoke run is now
 * isolated on its side (tools/test/smoke-packaged-fence.test.mjs); this suite is
 * the rule on the product's side.
 *
 * THE RULE. writeAssistantConfig writes into the record's OWN first root only
 * when the record says a person chose that folder (`workspaceChosen`, stamped
 * by recordWorkspaces). The record must always NAME a first root, because
 * buildMachineRecord requires one, and before the folder question is answered
 * that root is a default setup invented -- naming it is not configuring it. A
 * STATED target (the dispatch root, which this product owns) is not gated. The
 * flag survives a level change. And the launch-time refresh refuses an unchosen
 * folder and leaves whatever is in it byte for byte.
 *
 * The REAL engine modules out of the payload generate every document here, as
 * tools/test/dispatch-assistant-config.test.mjs explains a double cannot -- on
 * a checkout that carries the payload. A source-only checkout substitutes
 * loudly-flagged stand-ins and SKIPS every assertion only the real generator
 * could honestly answer; see SOURCE_ONLY_RUN below.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAYLOAD = path.join(REPO, 'capability')

const packedMachineRecord = path.join(PAYLOAD, 'src', 'lib', 'setup', 'machine-record.js')
const packedWorkspace = path.join(PAYLOAD, 'src', 'lib', 'setup', 'workspace.js')

/* The payload is a derived, gitignored build product. Most runs exercise its
   real modules; a source-only checkout must still be able to enforce the shell
   guard rather than failing at module import before a single assertion runs.

   BUT A STAND-IN IS NOT THE PRODUCT. The stub writeMcpConfig below encodes the
   very rule parts of this suite check -- which servers each tier gets -- so on
   a payload-less checkout those assertions would only watch the fixture agree
   with itself. So the substitution is never silent: SOURCE_ONLY_RUN records
   that a stand-in answered, the fact is printed where the runner's log shows
   it, and every assertion only the real generator could honestly answer is
   loudly skipped (engineOnly below) instead of vacuously passed. A green
   source-only run reads as "the shell guard held against a stand-in", never
   as "the real product logic was verified". */
const sourceOnlyMachineRecord = {
  TIERS: ['guided', 'standard', 'unrestricted'],
  resolveNodePath: ({ execPath }) => execPath,
  defaultMachineId: () => 'test-machine',
  defaultMachineLabel: () => 'Test machine',
  buildMachineRecord: (given) => ({
    tier: given.tier,
    installRoot: given.installRoot,
    servicesRoot: given.servicesRoot,
    nodePath: given.nodePath,
    workspaceRoots: given.workspaceRoots.map(root => path.resolve(root)),
    machine: { id: given.machineId || given.machine?.id || 'test-machine', label: given.machineLabel || given.machine?.label || 'Test machine' },
    createdAtMs: given.createdAtMs || 1,
  }),
  writeMcpConfig: (record, { targetDirectory }) => {
    const names = record.tier === 'guided' ? ['toolsenabled-readonly'] : ['toolsenabled-readonly', 'toolsenabled']
    const document = { mcpServers: Object.fromEntries(names.map(name => [name, { command: record.nodePath, args: [] }])) }
    writeFileSync(path.join(targetDirectory, '.mcp.json'), `${JSON.stringify(document, null, 2)}\n`)
    return { document }
  },
}
const sourceOnlyWorkspace = {
  defaultWorkspacePath: ({ documentsDir } = {}) => documentsDir || path.join(tmpdir(), 'AI Workspace'),
  checkWorkspaceCandidate: candidate => ({ ok: true, resolved: path.resolve(candidate) }),
  provisionWorkspace: candidate => {
    const created = !existsSync(candidate)
    mkdirSync(candidate, { recursive: true })
    return { workspace: candidate, created, undoAvailable: false }
  },
}
/* THE FLAG: true when any stand-in is answering instead of the packed payload. */
const SOURCE_ONLY_RUN = !existsSync(packedMachineRecord) || !existsSync(packedWorkspace)
const machineRecord = existsSync(packedMachineRecord) ? require_(packedMachineRecord) : sourceOnlyMachineRecord
const workspace = existsSync(packedWorkspace) ? require_(packedWorkspace) : sourceOnlyWorkspace
const SETUP_RECORD = require_(path.join(REPO, 'shell', 'setup-record.cjs'))

/* SURFACED IN BOTH DIRECTIONS, so the two kinds of green can never be read as
   each other in a log. */
if (SOURCE_ONLY_RUN) {
  console.error('[assistant-config-chosen-only] SOURCE-ONLY RUN: the capability/ payload is '
    + 'absent, so test-authored stand-ins are answering for the engine generator. The shell '
    + 'guard in shell/setup-record.cjs is still verified; every assertion only the real '
    + 'generator could honestly answer is SKIPPED below, each one named. This run does NOT '
    + 'verify the real product logic in the payload\'s src/lib/setup/.')
} else {
  console.error('[assistant-config-chosen-only] modules under test: real capability/ payload')
}

/* An assertion only the REAL engine generator can honestly answer. On a
   source-only run the stand-in wrote the document from this file's own rule,
   so checking its content would be the fixture agreeing with itself: skipped
   loudly, never passed silently. */
function engineOnly(what, check) {
  if (SOURCE_ONLY_RUN) {
    console.error(`[assistant-config-chosen-only] SKIPPED (stand-in answered, not the engine): ${what}`)
    return
  }
  check()
}

const scratch = mkdtempSync(path.join(tmpdir(), 'mc-chosen-only-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

function sandbox(name) {
  const directory = path.join(scratch, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

/* The real modules, with only the three seams that would otherwise touch this
   computer replaced: where the record lives, what it says, and where it is
   written. The generator and the `.mcp.json` writer are the real ones. */
function realModules({ record = null, defaultWorkspace }) {
  const written = []
  return {
    written,
    modules: {
      ok: true,
      root: PAYLOAD,
      machineRecord: {
        ...machineRecord,
        resolveServicesRoot: () => sandbox('services'),
        readMachineRecord: () => record,
        writeMachineRecord: (given) => { written.push(given); return 'written' },
      },
      workspace: { ...workspace, defaultWorkspacePath: () => defaultWorkspace },
    },
  }
}

/* A record shaped the way a packaged install records one, whose first root is
   a real temporary folder. `chosen` adds the one field that means a person was
   shown the folder question and answered it. */
function installRecord(name, { tier = 'standard', chosen = false } = {}) {
  const installRoot = sandbox(`${name}-install`)
  mkdirSync(path.join(installRoot, 'resources'), { recursive: true })
  const record = machineRecord.buildMachineRecord({
    tier,
    installRoot,
    servicesRoot: sandbox(`${name}-services`),
    nodePath: process.execPath,
    workspaceRoots: [sandbox(`${name}-folder`)],
  })
  return chosen ? { ...record, workspaceChosen: true } : record
}

function documentAt(directory) {
  return JSON.parse(readFileSync(path.join(directory, '.mcp.json'), 'utf8'))
}

/* -------------------------------------------------------------------------- */

test('answering the permission level alone configures nothing in a folder nobody was shown', () => {
  /* The first-run state: no record yet. recordTier has to name a first root to
     write a valid record, and it names the suggested default. Until now it then
     created that folder and wrote an assistant configuration into it -- in the
     person's Documents, before they had been asked anything about folders. */
  const home = path.join(scratch, 'first-run-home')
  const suggested = path.join(home, 'Documents', 'AI Workspace')
  const { modules, written } = realModules({ record: null, defaultWorkspace: suggested })

  const result = SETUP_RECORD.recordTier('standard', { modules, repoRoot: REPO, documentsDir: null })
  assert.equal(result.ok, true, `the level was not recorded: ${result.code}`)
  assert.equal(result.tier, 'standard')
  assert.equal(written.length, 1, 'the level itself must still be recorded')
  assert.deepEqual(written[0].workspaceRoots, [path.resolve(suggested)], 'the record still has to NAME a first root')
  assert.equal(written[0].workspaceChosen, undefined, 'nobody chose anything yet')

  assert.equal(result.assistantConfig.ok, false)
  assert.equal(result.assistantConfig.code, 'SETUP_ASSISTANT_CONFIG_NOT_CHOSEN')
  assert.equal(existsSync(suggested), false, 'the suggested folder was created for a person who never saw it')
  assert.equal(existsSync(home), false, 'nothing at all was provisioned under the home')
})

test('a folder the person chose gets the document, and a level change keeps the choice', () => {
  const existing = installRecord('chosen', { tier: 'unrestricted', chosen: true })
  const folder = existing.workspaceRoots[0]
  const { modules, written } = realModules({ record: existing, defaultWorkspace: path.join(scratch, 'never-this') })

  const result = SETUP_RECORD.recordTier('guided', { modules, repoRoot: REPO })
  assert.equal(result.ok, true)
  assert.equal(result.assistantConfig.ok, true, `the chosen folder was not configured: ${result.assistantConfig.code}`)
  assert.ok(existsSync(path.join(folder, '.mcp.json')))
  engineOnly('the guided tier gets the readonly server only', () => {
    assert.deepEqual(result.assistantConfig.servers, ['toolsenabled-readonly'], 'the narrower level must reach the chosen folder')
    assert.deepEqual(Object.keys(documentAt(folder).mcpServers), ['toolsenabled-readonly'])
  })

  /* buildMachineRecord drops fields outside the engine's schema. Re-recording
     the level must not silently forget that the person chose their folder, or
     the next write into it would be refused by the rule above. */
  assert.equal(written.length, 1)
  assert.equal(written[0].tier, 'guided')
  assert.deepEqual(written[0].workspaceRoots, [folder])
  assert.equal(written[0].workspaceChosen, true, 'a level change forgot that the person chose their folder')
  assert.equal(existsSync(path.join(scratch, 'never-this')), false)
})

test('writeAssistantConfig: an unstated target needs the choice; a stated target is the caller\'s own', () => {
  const unchosen = installRecord('direct')
  const folder = unchosen.workspaceRoots[0]
  const { modules } = realModules({ defaultWorkspace: folder })

  const refused = SETUP_RECORD.writeAssistantConfig(unchosen, modules)
  assert.deepEqual(refused, { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NOT_CHOSEN' })
  assert.equal(existsSync(path.join(folder, '.mcp.json')), false, 'an unchosen folder was configured')

  /* Not even the directory: the old code created the folder before it found
     out whether it could write the document. */
  const ghost = path.join(scratch, 'direct-ghost')
  SETUP_RECORD.writeAssistantConfig({ ...unchosen, workspaceRoots: [ghost] }, modules)
  assert.equal(existsSync(ghost), false, 'an unchosen folder was provisioned')

  const chosen = { ...unchosen, workspaceChosen: true }
  const written = SETUP_RECORD.writeAssistantConfig(chosen, modules)
  assert.equal(written.ok, true, `a chosen folder was refused: ${written.code}`)
  assert.equal(written.code, 'SETUP_ASSISTANT_CONFIG_WRITTEN')
  assert.ok(existsSync(path.join(folder, '.mcp.json')))
  engineOnly('a standard-tier document names the writing server', () => {
    assert.ok(Object.keys(documentAt(folder).mcpServers).includes('toolsenabled'))
  })

  /* The dispatch root is this product's own directory and is written unasked,
     fail-closed, because a lane cannot start without it. */
  const dispatchRoot = sandbox('direct-dispatch')
  const stated = SETUP_RECORD.writeAssistantConfig(unchosen, modules, { targetDirectory: dispatchRoot })
  assert.equal(stated.ok, true, `the dispatch root was refused: ${stated.code}`)
  assert.ok(existsSync(path.join(dispatchRoot, '.mcp.json')))

  /* A stated target that is not a usable path is refused and never falls back
     to the person's folder, chosen or not. */
  const fallback = path.join(scratch, 'direct-fallback')
  for (const bad of ['', 42, {}, []]) {
    const answer = SETUP_RECORD.writeAssistantConfig({ ...chosen, workspaceRoots: [fallback] }, modules, { targetDirectory: bad })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_NO_WORKSPACE')
  }
  assert.equal(existsSync(fallback), false, 'a bad stated target fell back to the person\'s folder')
})

test('the dispatch root is still configured for an install that has chosen nothing', () => {
  const home = path.join(scratch, 'dispatch-only-home')
  const dispatchRoot = sandbox('dispatch-only')
  const { modules } = realModules({ record: null, defaultWorkspace: path.join(home, 'Documents', 'AI Workspace') })

  const result = SETUP_RECORD.recordTier('standard', { modules, repoRoot: REPO, dispatchRoot, documentsDir: null })
  assert.equal(result.ok, true)
  assert.equal(result.dispatchAssistantConfig.ok, true, `the lane launcher lost its document: ${result.dispatchAssistantConfig.code}`)
  assert.ok(existsSync(path.join(dispatchRoot, '.mcp.json')))
  assert.equal(result.assistantConfig.code, 'SETUP_ASSISTANT_CONFIG_NOT_CHOSEN')
  assert.equal(existsSync(home), false)

  /* And before anybody has answered anything: the fail-closed document still
     names the default folder -- it has to, to be a valid record -- and still
     provisions nothing. */
  const noRecordRoot = sandbox('dispatch-no-record')
  const ensured = SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot: noRecordRoot, record: null, modules, repoRoot: REPO })
  assert.equal(ensured.ok, true, `an unconfigured install could not start a lane: ${ensured.code}`)
  assert.ok(existsSync(path.join(noRecordRoot, '.mcp.json')))
  engineOnly('the fail-closed document names the most restrictive server set', () => {
    assert.deepEqual(Object.keys(documentAt(noRecordRoot).mcpServers), ['toolsenabled-readonly'])
  })
  assert.equal(existsSync(home), false)
})

test('the launch-time refresh leaves an unchosen folder byte for byte as it found it', () => {
  /* THE MEASURED SHAPE. A record whose first root already holds a `.mcp.json`
     -- here one the person wrote for their own client, naming their own server
     -- and no `workspaceChosen`. The refresh used to take "a document exists"
     as its whole licence to rewrite it from the running build. */
  const unchosen = installRecord('refresh-unchosen')
  const folder = unchosen.workspaceRoots[0]
  const theirs = `${JSON.stringify({ mcpServers: { 'their-own-server': { command: 'node', args: ['theirs.js'] } } }, null, 2)}\n`
  writeFileSync(path.join(folder, '.mcp.json'), theirs)

  const { modules } = realModules({ defaultWorkspace: folder })
  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record: unchosen, repoRoot: REPO, modules })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_NOT_CHOSEN')
  assert.equal(readFileSync(path.join(folder, '.mcp.json'), 'utf8'), theirs, 'a file in a folder nobody chose was rewritten')

  /* The same record with the choice on it: refreshed, and it names the runtime
     that is running -- the repair the refresh exists for. */
  const refreshed = SETUP_RECORD.refreshChosenAssistantConfig({ record: { ...unchosen, workspaceChosen: true }, repoRoot: REPO, modules })
  assert.equal(refreshed.ok, true, `a chosen folder was not refreshed: ${refreshed.code}`)
  assert.notEqual(readFileSync(path.join(folder, '.mcp.json'), 'utf8'), theirs, 'the chosen folder was not actually rewritten')
  engineOnly('the refreshed document names the running runtime', () => {
    const document = documentAt(folder)
    const commands = new Set(refreshed.servers.map(name => document.mcpServers[name].command))
    assert.deepEqual([...commands], [process.execPath])
    /* The person's own server was merged around, not thrown away. */
    assert.deepEqual(document.mcpServers['their-own-server'], { command: 'node', args: ['theirs.js'] })
  })
})

test('an unchosen folder with no document still answers ABSENT, so the launch path has nothing new to log', () => {
  /* shell/main.cjs prints the refresh outcome unless it is ABSENT or
     NOT_RECORDED. The existence check stays in front of the choice check so the
     common unanswered install -- no folder chosen, nothing provisioned -- keeps
     its quiet answer; only an unchosen folder that actually holds a document
     reports the new code. */
  const unchosen = installRecord('refresh-absent')
  const { modules } = realModules({ defaultWorkspace: unchosen.workspaceRoots[0] })
  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record: unchosen, repoRoot: REPO, modules })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_ABSENT')
  assert.equal(existsSync(path.join(unchosen.workspaceRoots[0], '.mcp.json')), false)
})

test('choosing the folder is what earns the document, through the real modules too', () => {
  /* tools/test/setup-profile.test.mjs pins recordWorkspaces against a double;
     this is the same wiring against the engine's own generator, so the chosen
     folder's document is shown to be a real one and not an empty object. */
  const existing = installRecord('walkthrough')
  const chosen = path.join(scratch, 'walkthrough-chosen')
  const { modules, written } = realModules({ record: existing, defaultWorkspace: existing.workspaceRoots[0] })

  const result = SETUP_RECORD.recordWorkspaces([chosen], { modules, repoRoot: REPO })
  assert.equal(result.ok, true, `the folder was refused: ${result.code} ${result.reason || ''}`)
  assert.equal(written[0].workspaceChosen, true)
  assert.equal(result.assistantConfig.ok, true, `the chosen folder was not configured: ${result.assistantConfig.code}`)
  assert.ok(existsSync(path.join(chosen, '.mcp.json')))
  engineOnly("the chosen folder's document is a real generated one, not an empty object", () => {
    assert.ok(Object.keys(documentAt(chosen).mcpServers).length > 0, 'the chosen folder got a document naming no servers')
  })
  assert.equal(existsSync(path.join(existing.workspaceRoots[0], '.mcp.json')), false, 'the folder nobody chose was configured on the way')
})

/* ---------- the person's own .mcp.json is merged into, never replaced ----------
 *
 * THE DEFECT (owner, 2026-09-22: "right now do we aggressively try to write over
 * a users paths or such?"). The chosen folder is the person's, and a .mcp.json
 * already in it is usually the person's own file: their agent client keeps its
 * project servers there. Setup and every launch-time refresh wrote the generated
 * document over it wholesale, kept no copy and said nothing, and a failed write
 * removed the file. ToolsEnabled now owns only its own entries in that file. */

const THEIR_SERVER = Object.freeze({ command: 'node', args: ['theirs.js'], env: { THEIR_TOKEN_NAME: 'kept' } })

function theirDocument(extra = {}) {
  return `${JSON.stringify({ mcpServers: { 'their-own-server': THEIR_SERVER, ...extra }, theirSetting: { keep: true } }, null, 2)}\n`
}

test("a .mcp.json the person already had in the chosen folder keeps every entry of theirs, and a copy is kept", () => {
  const record = installRecord('merge-keeps', { chosen: true })
  const folder = record.workspaceRoots[0]
  const theirs = theirDocument()
  writeFileSync(path.join(folder, '.mcp.json'), theirs)
  const { modules } = realModules({ record, defaultWorkspace: path.join(scratch, 'never-this') })

  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules })
  assert.equal(answer.ok, true, `the chosen folder was not configured: ${answer.code}`)
  const document = documentAt(folder)
  assert.deepEqual(document.mcpServers['their-own-server'], THEIR_SERVER, "the person's own server was replaced or changed")
  assert.deepEqual(document.theirSetting, { keep: true }, "the person's own top-level setting was dropped")
  for (const name of answer.servers) assert.ok(document.mcpServers[name], `ToolsEnabled's entry ${name} is missing`)
  assert.equal(readFileSync(path.join(folder, '.mcp.json.toolsenabled-backup'), 'utf8'), theirs,
    'no copy of the file as the person had it was kept')
  assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_MERGED')
  assert.equal(answer.merged.kept, 1)
  assert.deepEqual(answer.merged.replaced, [])
  assert.equal(answer.merged.backup, '.mcp.json.toolsenabled-backup')
  assert.match(answer.merged.reason, /kept your own entry \(their-own-server\)/)
  assert.match(answer.merged.reason, /saved beside it as \.mcp\.json\.toolsenabled-backup/)
  assert.equal(answer.merged.reason.includes(scratch), false, 'the sentence for the screen carries a path')
})

test('a later refresh changes only ToolsEnabled entries and leaves no second copy', () => {
  const record = installRecord('merge-refresh', { chosen: true })
  const folder = record.workspaceRoots[0]
  writeFileSync(path.join(folder, '.mcp.json'), theirDocument())
  const { modules } = realModules({ record, defaultWorkspace: path.join(scratch, 'never-this') })
  assert.equal(SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules }).ok, true)

  const again = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules })
  assert.equal(again.ok, true, `the second refresh failed: ${again.code}`)
  assert.deepEqual(documentAt(folder).mcpServers['their-own-server'], THEIR_SERVER)
  assert.equal(existsSync(path.join(folder, '.mcp.json.toolsenabled-backup-2')), false, 'every launch left another copy behind')
})

test("a person's entry under a name ToolsEnabled needs is replaced only with a copy kept, and is named", () => {
  const record = installRecord('merge-name', { chosen: true })
  const folder = record.workspaceRoots[0]
  const theirs = theirDocument({ playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } })
  writeFileSync(path.join(folder, '.mcp.json'), theirs)
  const { modules } = realModules({ record, defaultWorkspace: path.join(scratch, 'never-this') })

  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules })
  assert.equal(answer.ok, true, `the chosen folder was not configured: ${answer.code}`)
  assert.deepEqual(answer.merged.replaced, ['playwright'])
  assert.match(answer.merged.reason, /named playwright used a name ToolsEnabled needs/)
  assert.equal(readFileSync(path.join(folder, '.mcp.json.toolsenabled-backup'), 'utf8'), theirs)
  assert.deepEqual(documentAt(folder).mcpServers['their-own-server'], THEIR_SERVER)
})

test('a .mcp.json that is not a settings file is left byte for byte, and the answer says so', () => {
  const record = installRecord('merge-unreadable', { chosen: true })
  const folder = record.workspaceRoots[0]
  const theirs = '// my notes, not JSON\n{ "mcpServers": '
  writeFileSync(path.join(folder, '.mcp.json'), theirs)
  const { modules } = realModules({ record, defaultWorkspace: path.join(scratch, 'never-this') })

  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_PERSON_FILE_UNREADABLE')
  assert.match(answer.reason, /left exactly as it was/)
  assert.equal(readFileSync(path.join(folder, '.mcp.json'), 'utf8'), theirs, 'a file ToolsEnabled could not read was rewritten')
})

test("a failed write never deletes the person's file, and takes back only ToolsEnabled entries", () => {
  const record = installRecord('merge-failure', { chosen: true })
  const folder = record.workspaceRoots[0]
  const ours = { command: process.execPath, args: ['/x/src/mcp-server.js'], env: { TOOLSENABLED_TOOL_ALLOWLIST: 'wide' } }
  writeFileSync(path.join(folder, '.mcp.json'), theirDocument({ toolsenabled: ours }))
  const { modules } = realModules({ record, defaultWorkspace: path.join(scratch, 'never-this') })
  const failing = { ...modules, machineRecord: { ...modules.machineRecord,
    generateMcpConfig: () => { throw Object.assign(new Error('generator refused'), { code: 'SETUP_TEST_GENERATOR_REFUSED' }) },
    writeMcpConfig: () => { throw Object.assign(new Error('generator refused'), { code: 'SETUP_TEST_GENERATOR_REFUSED' }) } } }

  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO, modules: failing })
  assert.equal(answer.ok, false)
  assert.equal(existsSync(path.join(folder, '.mcp.json')), true, "a failed write deleted the person's file")
  const document = documentAt(folder)
  assert.deepEqual(document.mcpServers['their-own-server'], THEIR_SERVER, "the person's own server did not survive a failed write")
  assert.equal(document.mcpServers.toolsenabled, undefined, 'the wider ToolsEnabled entry outlived a failed narrowing')
  assert.ok(existsSync(path.join(folder, '.mcp.json.toolsenabled-backup')), 'the file as the person had it was not kept')
})
