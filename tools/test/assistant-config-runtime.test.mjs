/* WHICH PROGRAM THE GENERATED CONFIGURATION ACTUALLY STARTS.
 *
 * THE DEFECT, AS THE PERSON SAW IT: "every time I launch an agent a cmd window
 * and another ToolsEnabled instance pops up that looks outdated."
 *
 * THE DEFECT, AS IT IS: the generated `.mcp.json` -- and the confined
 * `config.toml` beside it -- name `record.nodePath` as the program that runs
 * each MCP server. On every packaged install that value is THE APPLICATION'S OWN
 * ELECTRON BINARY (resolveNodePath answers `process.execPath`, and the process
 * that runs setup is the app), and it was written ONCE, by whichever
 * installation happened to run setup. Two consequences, one visible and one not:
 *
 *   1. AN ELECTRON BINARY HANDED A .js ARGUMENT WITHOUT ELECTRON_RUN_AS_NODE
 *      IGNORES THE ARGUMENT AND BOOTS THE WHOLE APPLICATION. Measured on a
 *      staged packaged build, same command, same cwd, same environment:
 *        without the variable -> `initialize` never answered, 0 tools
 *                                advertised, 5 new top-level windows owned by
 *                                that child (Chrome_WidgetWin_0, and a #32770
 *                                dialog)
 *        with the variable    -> `initialize` answered, the allowlist
 *                                advertised exactly, 0 new windows
 *      So the second window is not cosmetic damage beside a working session. It
 *      IS the session's tool surface, failing to start. Every agent this
 *      application launched ran with NONE of the product's own MCP tools.
 *
 *   2. THE RECORDED PATH PINS AN INSTALLATION, NOT A BUILD. generateMcpConfig
 *      only ever checked that the path still exists -- never that it is the copy
 *      now running. That is why the extra window LOOKED OUTDATED: it was the
 *      older installed build, started faithfully from a months-old record.
 *
 * WHAT THIS SUITE PINS. The two facts above, at the seam that decides them, with
 * the REAL engine generator out of the payload -- never a double. A double that
 * ignores the record it is handed is exactly what let the sibling defect in
 * tools/test/dispatch-assistant-config.test.mjs ship.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: assert that a server, once started, answers.
 * That is a property of a running process, not of a document, and it is measured
 * where it can be measured -- tools/agent-start-flow-qa.mjs starts every server
 * this document configures and requires the session to advertise at least one
 * toolsenabled.* tool. "Configured" and "connected" are two claims, and this file
 * is only the first one.
 *
 * REPORT-C1-assistant-config-runtime (2026-08-28). Mutation watch: a green
 * 7/7 run was challenged by deleting ELECTRON_RUN_AS_NODE from the staged
 * generateMcpConfig output. This file then failed in both the all-tier
 * startability assertion (guided named ToolsEnabled.exe without Node mode)
 * and the guided environment assertion (undefined !== '1'). Restoring the
 * exercised module restored its SHA-256 exactly and returned this file to 7/7.
 * This note keeps the harvested-test evidence beside the assertions it audits.
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

const machineRecord = require_(path.join(PAYLOAD, 'src', 'lib', 'setup', 'machine-record.js'))
const SETUP_RECORD = require_(path.join(REPO, 'shell', 'setup-record.cjs'))

const scratch = mkdtempSync(path.join(tmpdir(), 'mc-assistant-runtime-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

function sandbox(name) {
  const directory = path.join(scratch, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

/* A RUNTIME THAT IS REAL, NAMED LIKE THIS PRODUCT'S BINARY, AND IS NOT THE ONE
   RUNNING. It has to exist because generateMcpConfig refuses a runtime that is
   not on the computer -- which is precisely the check that was mistaken for
   "the recorded runtime is still right". */
function staleRuntime(name) {
  const directory = sandbox(`${name}-older-install`)
  const runtime = path.join(directory, 'ToolsEnabled.exe')
  writeFileSync(runtime, 'an earlier installation of this product; only its NAME and existence matter here')
  return runtime
}

/* A record shaped the way a packaged install records one, with a runtime left
   behind by an EARLIER installation -- the state a person who has ever updated
   this application is actually in. */
function staleRecord(name, tier = 'unrestricted') {
  const installRoot = sandbox(`${name}-install`)
  mkdirSync(path.join(installRoot, 'resources'), { recursive: true })
  return machineRecord.buildMachineRecord({
    tier,
    installRoot,
    servicesRoot: sandbox(`${name}-services`),
    nodePath: staleRuntime(name),
    workspaceRoots: [sandbox(`${name}-chosen`)],
  })
}

function documentAt(directory) {
  return JSON.parse(readFileSync(path.join(directory, '.mcp.json'), 'utf8'))
}

/* THE ACCEPTANCE PROPERTY, STATED ONCE AND ASSERTED EVERYWHERE. A document is
   only startable if every entry either names a plain Node -- which executes a
   script argument -- or tells the runtime it names to behave as one. */
function everyServerCanActuallyStart(document) {
  const broken = []
  for (const [name, entry] of Object.entries(document.mcpServers || {})) {
    const leaf = path.basename(String(entry.command)).toLowerCase().replace(/\.exe$/, '')
    if (leaf === 'node') continue
    if (entry.env && entry.env.ELECTRON_RUN_AS_NODE === '1') continue
    broken.push(`${name} -> ${entry.command}`)
  }
  return broken
}

/* -------------------------------------------------------------------------- */

test('the document names the runtime that is RUNNING, not the one that ran setup', () => {
  const record = staleRecord('dispatch')
  const dispatchRoot = sandbox('dispatch-root')
  const result = SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record, repoRoot: REPO })
  assert.equal(result.ok, true, `writing the dispatch configuration failed: ${result.code}`)

  const document = documentAt(dispatchRoot)
  const commands = new Set(Object.values(document.mcpServers).map(entry => entry.command))
  assert.ok(commands.size > 0, 'a document with no servers cannot pin anything')
  assert.deepEqual([...commands], [process.execPath],
    'every server must be started by the copy of this product that is running')
  assert.equal(commands.has(record.nodePath), false,
    'the older installation is still being named, which is the window the person keeps seeing')
})

test('the record on disk is left saying what it always said', () => {
  /* The substitution is for GENERATION only. workspace.checkWorkspaceCandidate()
     reads `installRoot` and means the whole install directory by it, and the
     record is the person's own answer about their computer -- rewriting either
     from a launch would be this shell editing a record it was not asked to. */
  const record = staleRecord('untouched')
  const before = JSON.stringify(record)
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot: sandbox('untouched-root'), record, repoRoot: REPO })
  assert.equal(JSON.stringify(record), before, 'the record handed in was mutated')

  const projected = SETUP_RECORD.assistantConfigRecord(record, { root: PAYLOAD })
  assert.equal(projected.nodePath, process.execPath)
  assert.equal(projected.installRoot, PAYLOAD)
  assert.equal(record.nodePath.endsWith('ToolsEnabled.exe'), true)
})

/* THE PACKAGED CASE, ASKED OF THE PAYLOAD'S OWN GENERATOR.
 *
 * The two tests below cannot go through the shell, and that is not a shortcut.
 * assistantConfigRecord substitutes `process.execPath`, and the process running
 * this suite IS node -- so a shell-written document always names node here and
 * the property under test would be satisfied vacuously on every machine that
 * runs it. The situation being pinned is a PACKAGED app generating a document,
 * where that same substitution yields the application's own binary. So the
 * generator in the shipped payload is asked directly, with the runtime a
 * packaged install would hand it. */
function packagedGeneration(name, tier) {
  return machineRecord.generateMcpConfig({
    ...staleRecord(name, tier),
    installRoot: PAYLOAD,
    nodePath: staleRuntime(`${name}-running`),
  }).document
}

test('no generated document can name a runtime that would start the application instead of a server', () => {
  /* THE MEASUREMENT THIS ENCODES: `<app>.exe <engine>\src\mcp-server.js` with no
     ELECTRON_RUN_AS_NODE answered no `initialize`, advertised 0 tools, and
     created 5 top-level windows. Asserted for every level, because the levels
     take different branches through the generator's env handling and it was the
     branch with no allowlist (unrestricted) that carried no env object at all. */
  for (const tier of machineRecord.TIERS) {
    const document = packagedGeneration(`startable-${tier}`, tier)
    assert.ok(Object.keys(document.mcpServers).length > 0, `${tier} configured no servers at all`)
    assert.deepEqual(everyServerCanActuallyStart(document), [],
      `${tier} configured a server that would start the application instead`)
  }
  // And the shell's own output satisfies the same property, whatever runtime it
  // is generated by. Vacuous under node, load-bearing under the packaged app.
  const dispatchRoot = sandbox('startable-shell')
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record: staleRecord('startable-shell'), repoRoot: REPO })
  assert.deepEqual(everyServerCanActuallyStart(documentAt(dispatchRoot)), [])
})

test('the level still narrows the tools, so the repair did not replace the allowlist', () => {
  /* The regression this pins is the obvious way to write the fix: assigning
     `entry.env = { ELECTRON_RUN_AS_NODE: '1' }` after the allowlist branch would
     silently delete the allowlist, and an absent allowlist is read by the server
     as NO LIMIT -- the full tool surface under a level whose own words are that
     it cannot reach the rest of the computer. */
  const entry = packagedGeneration('narrowed', 'guided').mcpServers['toolsenabled-readonly']
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1')
  assert.ok(entry.env.TOOLSENABLED_TOOL_ALLOWLIST.length > 0, 'the allowlist was replaced rather than merged')
  assert.equal(entry.env.TOOLSENABLED_TOOL_ALLOWLIST.includes('host.exec'), false)
  // The existing readonly-server heap ceiling must survive the same merge as
  // Node mode and the allowlist; keep the environment vocabulary exact.
  assert.equal(entry.env.NODE_OPTIONS, '--max-old-space-size=256')
  assert.equal(entry.env.TOOLSENABLED_AGENT_TOOL_MODE, 'ToolsEnabled only')
  assert.deepEqual(Object.keys(entry.env).sort(), ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TOOLSENABLED_AGENT_TOOL_MODE', 'TOOLSENABLED_TOOL_ALLOWLIST'])
})

test("the person's own folder is refreshed on launch, and nothing is provisioned that was not there", () => {
  /* Their copy is the one their agent client reads, and until now NOTHING ever
     revisited it: setup writes it once, then the application is updated or moved
     and the file goes on naming the old build forever. It is refreshed only
     where a document already exists, so the deliberate rule that an unanswered
     folder question provisions nothing survives. */
  /* A folder the PERSON chose: the record carries `workspaceChosen`, stamped by
     recordWorkspaces. Without it the refresh refuses and leaves the file alone --
     tools/test/assistant-config-chosen-only.test.mjs pins that half. */
  const record = { ...staleRecord('refresh'), workspaceChosen: true }
  const chosen = record.workspaceRoots[0]

  const untouched = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO })
  assert.equal(untouched.ok, false)
  assert.equal(untouched.code, 'SETUP_ASSISTANT_CONFIG_ABSENT')
  assert.equal(existsSync(path.join(chosen, '.mcp.json')), false, 'a folder with no document must be left alone')

  /* Now the state a person who completed setup on an EARLIER build is in: a
     document exists, and it names an executable that is not this one. */
  writeFileSync(path.join(chosen, '.mcp.json'), JSON.stringify({
    mcpServers: { toolsenabled: { command: record.nodePath, args: ['whatever.js'] } },
  }, null, 2))
  const refreshed = SETUP_RECORD.refreshChosenAssistantConfig({ record, repoRoot: REPO })
  assert.equal(refreshed.ok, true, `refresh failed: ${refreshed.code}`)

  const document = documentAt(chosen)
  assert.deepEqual([...new Set(Object.values(document.mcpServers).map(entry => entry.command))], [process.execPath])
  assert.deepEqual(everyServerCanActuallyStart(document), [])
})

test('a shell with no record does not invent a folder to write into', () => {
  /* The fail-closed record the DISPATCH root uses names the default folder, and
     writing there would provision a directory nobody has said yes to. The
     dispatch root can be written unasked because this product owns it; the
     person's folder cannot. */
  const answer = SETUP_RECORD.refreshChosenAssistantConfig({ record: null, repoRoot: REPO })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SETUP_ASSISTANT_CONFIG_NOT_RECORDED')
})

test('the shell re-enters as Node after fencing when argv names one of its own programs', () => {
  /* THE REPAIR FOR THE DOCUMENTS ALREADY ON DISK. Regeneration fixes the files
     this application writes; it cannot fix a `.mcp.json` sitting in a folder it
     has never been told about, which is what a person's agent client will read
     tomorrow morning. So shell/main.cjs re-enters as Node when argv names a
     script inside this build's own resources.
     THE SHAPE OF THE TEST IS THE POINT: the guard must key on "a .js under
     process.resourcesPath", never on "there is an extra argument". Re-entering
     as Node on any unrecognised argv would turn a mistyped shortcut into a
     silent headless exit with no window -- the same failure in the other
     direction, which has cost this project two diagnoses already. Asserted
     through its pure parser, which runs before `require('electron')`. The
     handoff deliberately runs only after the
     installed-profile, userData, and account-environment fences; the behaviour
     itself is driven end to end by tools/agent-start-flow-qa.mjs against a
     staged build. */
  const source = readFileSync(path.join(REPO, 'shell', 'main.cjs'), 'utf8')
  const { electronNodeHandoff } = require_(path.join(REPO, 'shell', 'electron-node-handoff.cjs'))
  const resourcesPath = path.join(REPO, 'capability')
  const ownProgram = path.join(resourcesPath, 'src', 'mcp-server.js')
  const detected = electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', ownProgram, '--stdio'],
  })
  const unsafe = electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', '--inspect=127.0.0.1:0', ownProgram],
  })
  const accountFence = source.indexOf('const accountEnvironmentCheck = fencedAccountEnvironment({')
  const handoffAt = source.indexOf('if (ELECTRON_NODE_HANDOFF?.ok === true)')
  const handoff = source.slice(handoffAt, source.indexOf("const http = require('http')", handoffAt))
  const environmentHelper = readFileSync(path.join(REPO, 'shell', 'install-profile-guard.cjs'), 'utf8')
  assert.equal(detected.ok, true, 'a shipped script in first position was not recognized')
  assert.deepEqual([...detected.forwarded], [ownProgram, '--stdio'])
  assert.equal(unsafe.ok, false, 'a runtime option before the shipped script was accepted')
  assert.equal('forwarded' in unsafe, false, 'unsafe argv can still reach the Node-mode child')
  assert.ok(accountFence >= 0 && handoffAt > accountFence,
    'the Node handoff must not bypass the account-environment fence')
  assert.ok(handoff.includes('electronNodeHandoffEnvironment(process.env)'),
    'the handoff must use the bounded Node environment rather than merely refusing')
  assert.ok(environmentHelper.includes("ELECTRON_RUN_AS_NODE: '1'"),
    'the bounded Node environment must still perform the Node-mode re-entry')
  assert.ok(handoff.includes('windowsHide: true'),
    'the re-entered local helper must not be able to flash a console')
})
