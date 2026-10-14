/* T286/T88 ITEM 2: A SOLO AGENT GETS THE SAME TOOLS AS A TREE AGENT.
 *
 * The owner, 2026-09-17: "your agent cant even pick a model or effort level or
 * use any tools. I TOLD YOU THIS", and on 09-15 "its the same agent system".
 *
 * THE SUSPICION THIS CLOSES, and it was mine. A standalone session is
 * anonymous by construction: mountStandaloneAgent is deliberately absent from
 * the tree store and the declared-agent registry, so it has no agentId, and
 * shell/agent-host.cjs only accepts an unbound session on the branch that
 * requires `agentId === null`. It looked very much as though tools were being
 * withheld from identity-less sessions, which would have been a host change in
 * files two other lanes are editing for the cut.
 *
 * It is not. The gate is the Agent API setting and nothing else:
 *
 *   let document = { mcpServers: {} };
 *   if (record && agentApiMode !== 'Disabled') { document = generator(...).document }
 *
 * `agentId` is PASSED to the generator, never consulted by the gate, and
 * readMachineRecord() takes a services root and no session at all, so the
 * record a solo session plans against is the same machine record a tree agent
 * plans against. These cases pin that, so a future change that quietly keys
 * tools off identity has to redden something instead of only disappointing
 * somebody.
 *
 * BOTH CONTROLS RUN. A first version of this measurement passed no machine
 * record and returned an empty server set for EVERY case including the tree
 * agent -- an instrument that cannot tell the cases apart proves nothing, and
 * reporting it would have sent a second worker after a defect that does not
 * exist. The Disabled row below is the negative control and the tree row is
 * the positive one; if either stops discriminating, these cases are measuring
 * nothing and say so.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { confinementPlanFor } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))

/* Scratch under the running account's own profile temp, never under
   node_modules: on a worktree that directory is a junction into another
   checkout. Same rule as agent-host-local-tier.test.mjs, same reason. */
function scratchRoot() {
  const home = os.homedir()
  const profileTemp = process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'Temp') : os.tmpdir()
  const root = existsSync(profileTemp) ? profileTemp : os.tmpdir()
  return mkdtempSync(path.join(root, 'toolsenabled-solo-tools-'))
}

const SCRATCH = scratchRoot()
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

function machineUnderTest() {
  const source = canonicalRootForTests({ requireConfigured: true })
  const machineRecord = require_(path.join(source, 'src/lib/setup/machine-record.js'))
  const record = machineRecord.buildMachineRecord({
    tier: 'unrestricted', installRoot: source, servicesRoot: SCRATCH,
    nodePath: process.execPath, workspaceRoots: [SCRATCH],
  })
  return { machineRecord, record }
}

const serverNames = document => Object.keys(document.mcpServers || {}).sort()

test('a solo agent is offered the same tool servers as a tree agent, and only the Agent API setting withholds them', () => {
  const { machineRecord, record } = machineUnderTest()
  const document = identity => machineRecord.generateMcpConfig(record, { agentActor: 'codex', ...identity }).document

  /* POSITIVE CONTROL. A declared tree agent with its issued credential -- the
     case that has always had tools. If this is ever empty the instrument is
     broken and nothing below means anything. */
  const treeAgent = serverNames(document({ agentApiMode: 'Enabled', agentId: 'agent-1', sessionCredential: 'A'.repeat(43) }))
  assert.ok(treeAgent.length > 0, 'the positive control produced no servers, so this measurement is not discriminating')

  /* THE CASE. A standalone session: no declared agent, no issued credential. */
  const solo = serverNames(document({ agentApiMode: 'Enabled', agentId: null, sessionCredential: null }))
  assert.deepEqual(solo, treeAgent, 'a solo agent must be offered exactly the tree agent\'s tool servers')

  /* The stricter mode is a mode, not a withdrawal. */
  assert.deepEqual(serverNames(document({ agentApiMode: 'Only', agentId: null, sessionCredential: null })), treeAgent)

  /* NEGATIVE CONTROL. The one thing that does withhold them is the setting the
     person controls, which is what "tools under the Agent API setting" means. */
  assert.deepEqual(serverNames(document({ agentApiMode: 'Disabled', agentId: null, sessionCredential: null })), [],
    'Disabled must withhold every server, or the negative control is not discriminating')
})

test('the shell plans a solo session without inventing an identity for it', () => {
  const source = canonicalRootForTests({ requireConfigured: true })
  const actualPlanner = require_(path.join(source, 'src/lib/agent-session-confinement.js'))
  const seen = []
  /* A RECORDING SHIM, NOT A PROXY. The engine module is frozen, so wrapping
     it in a Proxy throws on its read-only properties -- measured. This names
     the one function the codex path calls and delegates to the real one, so
     what is asserted below is the shell's actual argument, not a mock's. */
  const recording = {
    confinedSessionPlan(options) { seen.push(options); return actualPlanner.confinedSessionPlan(options) },
  }

  /* This is what mountStandaloneAgent's unplaced getStartOptions now produces,
     carried through the shell's own planner adapter. The point is the pair:
     the session still identifies itself, and agentId does NOT arrive as a
     fabricated value -- a solo seat that quietly invented one would be a
     different agent wearing a name nobody assigned. */
  confinementPlanFor(recording, { provider: 'codex', agentId: null, sessionId: 'chat-solo', sessionCredential: null })
  const planned = seen.at(-1)
  assert.ok(planned, 'the shell planned nothing, so this case measured nothing')
  assert.equal(Object.prototype.hasOwnProperty.call(planned, 'agentId'), false,
    'a solo session must be planned with no agentId at all, not with an invented one')
  assert.equal(planned.sessionId, 'chat-solo', 'the session still identifies itself')

  /* And a tree agent's identity still rides, so this is a difference between
     the two seats rather than a capability the shell has stopped passing. */
  seen.length = 0
  confinementPlanFor(recording, { provider: 'codex', agentId: 'agent-1', sessionId: 'chat-tree', sessionCredential: null })
  assert.equal(seen.at(-1).agentId, 'agent-1')
})
