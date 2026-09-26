/* THE CONFIGURATION A DISPATCHED AGENT IS ACTUALLY LAUNCHED AGAINST.
 *
 * WHAT WAS MEASURED BEFORE THIS SUITE EXISTED, on this machine, 2026-08-12, on
 * a real installation that had completed setup:
 *
 *   <userData>\workspace\                      existed, EMPTY
 *   <profile>\Documents\AI Workspace\.mcp.json existed, and read
 *                                              {"mcpServers": {}}
 *
 * Two separate defects, one on top of the other, and between them the product's
 * entire point:
 *
 *   1. THE DOCUMENT WAS IN THE WRONG DIRECTORY. `<userData>\workspace` is the
 *      dispatch root -- shell/main.cjs declares it to the capability layer as
 *      `main`, and the mission bridge launches every Claude lane with
 *      `--mcp-config <root>\.mcp.json --strict-mcp-config`. The only writer in
 *      the product put the document in the folder the PERSON chose instead.
 *
 *   2. THE DOCUMENT NAMED NOTHING. The generator resolves each server as
 *      `<record.installRoot>\src\mcp-server.js` and omits any it cannot find.
 *      The app records `installRoot` as the directory it was installed into,
 *      but in a packaged build the engine lives under `resources\capability` --
 *      so all three servers were skipped and the file that configures the
 *      assistant configured nothing.
 *
 * A MISSING FILE IS NOT "AN AGENT WITH NO TOOLS". Measured against the installed
 * Claude Code 2.1.186 rather than assumed:
 *     --mcp-config <missing> --strict-mcp-config
 *       -> Error: Invalid MCP configuration: MCP config file not found (exit 1)
 *     --mcp-config <file containing {"mcpServers":{}}> --strict-mcp-config
 *       -> starts, and refuses only because the prompt was empty
 * So defect 1 stopped the lane from starting at all, and defect 2 would have
 * left it running with none of this product's tools.
 *
 * WHY THIS SUITE USES THE REAL GENERATOR. tools/test/setup-profile.test.mjs
 * drives the same shell functions against an injected machine-record double
 * whose writeMcpConfig ignores the record it is given -- which is exactly why no
 * source test could see defect 2. Every assertion below runs the engine's own
 * src/lib/setup/machine-record.js out of the staged payload, so what is asserted
 * is what a customer's install would produce. The one test that does use a
 * double is the wiring test, which is about WHICH DIRECTORIES are written and
 * deliberately says nothing about their contents.
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

const scratch = mkdtempSync(path.join(tmpdir(), 'mc-dispatch-config-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

function sandbox(name) {
  const directory = path.join(scratch, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

/* A record shaped the way a PACKAGED install records one: `installRoot` is the
   directory the application was installed into, and the engine is not at the top
   of it. The layout is staged for real rather than described, because "the
   script is not there" is the whole defect and a mocked existsSync would hide
   it. */
function packagedInstallRecord(name, tier = 'unrestricted') {
  const installRoot = sandbox(`${name}-install`)
  mkdirSync(path.join(installRoot, 'resources'), { recursive: true })
  return machineRecord.buildMachineRecord({
    tier,
    installRoot,
    servicesRoot: sandbox(`${name}-services`),
    nodePath: process.execPath,
    workspaceRoots: [sandbox(`${name}-chosen`)],
  })
}

function documentAt(directory) {
  return JSON.parse(readFileSync(path.join(directory, '.mcp.json'), 'utf8'))
}

/* --------------------------------------------------------------------------
   DEFECT 2, PINNED AS A MEASUREMENT FIRST. If this ever goes green, the reason
   the shell substitutes the engine root has evaporated and the substitution can
   go -- but nothing else in this file would have told anybody.
   -------------------------------------------------------------------------- */
test('the recorded install directory alone generates a document with no servers at all', () => {
  const record = packagedInstallRecord('bare')
  const { document, skipped } = machineRecord.generateMcpConfig(record)
  assert.deepEqual(document.mcpServers, {}, 'a packaged installRoot must be the empty case this repair exists for')
  assert.ok(skipped.length > 0, 'every server should have been reported as skipped rather than silently absent')
})

test('the dispatch root gets a document that names real servers', () => {
  const record = packagedInstallRecord('dispatch')
  const dispatchRoot = sandbox('dispatch-root')
  const result = SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record, repoRoot: REPO })

  assert.equal(result.ok, true, `writing the dispatch configuration failed: ${result.code}`)
  assert.ok(existsSync(path.join(dispatchRoot, '.mcp.json')),
    'the mission bridge launches every Claude lane against this exact file')

  const document = documentAt(dispatchRoot)
  const servers = Object.keys(document.mcpServers)
  assert.ok(servers.includes('toolsenabled'),
    `the dispatch root's assistant configuration named ${servers.length === 0 ? 'nothing' : servers.join(', ')}`)

  /* The acceptance property the generator states for itself, asserted at the
     one place a customer's agent will act on it. A document naming a program
     that is not there produces a client that looks broken. */
  for (const named of machineRecord.pathsNamedByMcpConfig(document)) {
    assert.ok(existsSync(named), `${named} is named by the generated configuration but is not on this computer`)
  }
})

test('the file is one --strict-mcp-config will accept, not merely present', () => {
  /* Measured behaviour, restated as a shape assertion: a missing file and a
     malformed file both make the CLI exit 1 before it runs. `mcpServers` must be
     a plain object of plain objects, which is what the flag parses. */
  const dispatchRoot = sandbox('strict-root')
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record: packagedInstallRecord('strict'), repoRoot: REPO })
  const document = documentAt(dispatchRoot)
  assert.equal(typeof document, 'object')
  assert.ok(document && !Array.isArray(document.mcpServers) && typeof document.mcpServers === 'object')
  for (const [name, entry] of Object.entries(document.mcpServers)) {
    assert.equal(typeof entry.command, 'string', `${name} has no command`)
    assert.ok(Array.isArray(entry.args), `${name} has no argument list`)
  }
})

test('both copies describe the same permission level', () => {
  /* The chosen folder is the person's own client; the dispatch root is this
     product's lane launcher. Two documents generated from one record must not be
     able to disagree about what the assistant may do. */
  const record = packagedInstallRecord('agree', 'standard')
  const dispatchRoot = sandbox('agree-dispatch')
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record, repoRoot: REPO })
  const chosen = record.workspaceRoots[0]
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot: chosen, record, repoRoot: REPO })
  assert.deepEqual(documentAt(dispatchRoot), documentAt(chosen))
})

test('a level that grants less generates less, through this path too', () => {
  const dispatchRoot = sandbox('guided-dispatch')
  SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record: packagedInstallRecord('guided', 'guided'), repoRoot: REPO })
  const servers = Object.keys(documentAt(dispatchRoot).mcpServers)
  assert.deepEqual(servers, ['toolsenabled-readonly'],
    'the narrow level must not reach the dispatch root as the wide one')
})

/* --------------------------------------------------------------------------
   BEFORE ANYBODY HAS ANSWERED THE PERMISSION QUESTION.
   -------------------------------------------------------------------------- */
test('an install with no record still gets a document, and it is the narrowest one', () => {
  const dispatchRoot = sandbox('no-record-dispatch')
  const result = SETUP_RECORD.ensureDispatchAssistantConfig({ dispatchRoot, record: null, repoRoot: REPO })
  assert.equal(result.ok, true, `an unconfigured install must still be able to start a lane: ${result.code}`)

  const servers = Object.keys(documentAt(dispatchRoot).mcpServers)
  assert.deepEqual(servers, ['toolsenabled-readonly'],
    'a level nobody has chosen must produce the fail-closed surface and nothing wider')
})

test('a dispatch root that was not stated writes nothing anywhere', () => {
  for (const absent of [undefined, null, '', 42]) {
    const options = { dispatchRoot: absent, record: null, repoRoot: REPO }
    Object.defineProperty(options, 'modules', {
      get() { assert.fail('an absent dispatch root must be rejected before loading the engine payload') },
    })
    const result = SETUP_RECORD.ensureDispatchAssistantConfig(options)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SETUP_DISPATCH_ROOT_ABSENT')
  }
})

test('a copy with no engine payload says so instead of writing an empty document', () => {
  /* A viewer-only build has no setup modules at all. It must not leave a
     `.mcp.json` behind that describes an engine it does not carry. */
  const dispatchRoot = sandbox('no-payload-dispatch')
  const result = SETUP_RECORD.ensureDispatchAssistantConfig({
    dispatchRoot,
    record: null,
    modules: { ok: false, code: 'SETUP_PAYLOAD_ABSENT', reason: 'no payload' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_PAYLOAD_ABSENT')
  assert.equal(existsSync(path.join(dispatchRoot, '.mcp.json')), false)
})

/* --------------------------------------------------------------------------
   THE WIRING. Which directories does answering the permission question write?
   This one uses a double on purpose: it is a question about call sites.
   The folder in both cases is one the person CHOSE (`workspaceChosen` on the
   existing record): a first root nobody was shown is never written, which
   tools/test/assistant-config-chosen-only.test.mjs pins.
   -------------------------------------------------------------------------- */
test('answering the permission level configures the dispatch root as well as the folder', () => {
  const chosen = sandbox('wiring-chosen')
  const dispatchRoot = sandbox('wiring-dispatch')
  const configured = []
  const record = packagedInstallRecord('wiring')
  const modules = {
    ok: true,
    root: PAYLOAD,
    machineRecord: {
      TIERS: ['guided', 'standard', 'unrestricted'],
      resolveServicesRoot: () => record.servicesRoot,
      readMachineRecord: () => ({ ...record, workspaceRoots: [chosen], workspaceChosen: true }),
      buildMachineRecord: input => ({ ...record, ...input, workspaceRoots: [chosen], machine: record.machine }),
      writeMachineRecord: () => 'written',
      writeMcpConfig: (given, { targetDirectory }) => {
        configured.push(targetDirectory)
        /* The substitution is asserted here rather than trusted: the generator
           must be told where the ENGINE is, not where the app was installed. */
        assert.equal(given.installRoot, PAYLOAD, 'the generator was handed the install directory again')
        writeFileSync(path.join(targetDirectory, '.mcp.json'), '{"mcpServers":{}}\n')
        return { document: { mcpServers: {} } }
      },
    },
    workspace: { defaultWorkspacePath: () => chosen },
  }

  const result = SETUP_RECORD.recordTier('standard', { modules, dispatchRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(configured.slice().sort(), [chosen, dispatchRoot].sort(),
    'a level change has to reach both copies; the capability layer is not restarted afterwards')
  assert.equal(result.dispatchAssistantConfig.ok, true)
})

test('a shell that states no dispatch root keeps the old single-copy behaviour', () => {
  /* recordTier is called from one place today, but it is exported and injected
     in the suites. An absent dispatchRoot must not become an empty-string write
     into the current directory. */
  const chosen = sandbox('optional-chosen')
  const configured = []
  const record = packagedInstallRecord('optional')
  const modules = {
    ok: true,
    root: PAYLOAD,
    machineRecord: {
      TIERS: ['guided', 'standard', 'unrestricted'],
      resolveServicesRoot: () => record.servicesRoot,
      readMachineRecord: () => ({ ...record, workspaceRoots: [chosen], workspaceChosen: true }),
      buildMachineRecord: input => ({ ...record, ...input, workspaceRoots: [chosen], machine: record.machine }),
      writeMachineRecord: () => 'written',
      writeMcpConfig: (given, { targetDirectory }) => {
        configured.push(targetDirectory)
        writeFileSync(path.join(targetDirectory, '.mcp.json'), '{"mcpServers":{}}\n')
        return { document: { mcpServers: {} } }
      },
    },
    workspace: { defaultWorkspacePath: () => chosen },
  }
  const result = SETUP_RECORD.recordTier('standard', { modules })
  assert.deepEqual(configured, [chosen])
  assert.equal(Object.hasOwn(result, 'dispatchAssistantConfig'), false)
})
