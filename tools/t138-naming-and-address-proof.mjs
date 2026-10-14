#!/usr/bin/env node

/* CAN A MANAGER ADDRESS THE WORKERS IT JUST SPAWNED -- ASKED OF THE SHIPPED
 * TOOL SERVER, OVER REAL STDIO JSON-RPC, FAILING FIRST.
 *
 * THE MEASUREMENT THIS ANSWERS (T138, 2026-09-16 03:47Z-05:05Z): four circles
 * started through agent.spawn with surface "tree" were all called "Manager" and
 * sixteen were all called "Worker"; agent_comms.local_roster listed rows that
 * were identical apart from a heartbeat; agent_comms.send_local answered
 * TREE_RECIPIENT_AMBIGUOUS for the name and TREE_RECIPIENT_UNKNOWN for the tree
 * nodeId. No manager could address its own workers and the Controller could not
 * address its managers.
 *
 * WHAT THIS RUN IS, EXACTLY, so nobody reads more into it than it proves. It
 * drives the REAL CHAIN a tree spawn drives, in order, out of the real code on
 * both sides of the seam:
 *
 *   src/fleet-trees.js createFleetTreeStore().addNode()   the circle is drawn
 *   src/views/computers.js circleName()                   the name it answers to
 *   capability/.../tree-node-directory.js registerNode()  what the host registers
 *   capability/src/mcp-server.js agent_comms.local_roster the roster a model reads
 *   capability/src/mcp-server.js agent_comms.send_local   the message it then sends
 *
 * The middle three are the SHIPPED PAYLOAD -- the bytes a customer gets -- and
 * the last two go over real JSON-RPC to the same server a customer's Claude or
 * Codex session talks to. The registration arguments are the ones
 * shell/agent-host.cjs attemptTreeRegistration() passes: { sessionId, nodeName,
 * managerName, treeKey, nodeKey }, where nodeName and managerName come from
 * nodeTreeIdentity(), which composes them from the name function above.
 *
 * WHAT IT IS NOT: a model CHOOSING to call the tool, and not the screen. The
 * name a person SEES is checked separately on a driven candidate; this run
 * answers the question that has to be answered first, which is whether the call
 * a manager would make can succeed at all.
 *
 * FAILING FIRST, IN THE SAME RUN, ON THE SAME SERVER. Step 1 registers the
 * circles under the names the DEFECTIVE name function produced -- reproduced
 * here as the two lines that were removed, not described -- and shows the
 * refusals verbatim. Step 2 registers the same circles under the names the
 * shipped function produces now. A fix proved without the failure beside it is
 * a fix nobody can check.
 *
 *   node tools/t138-naming-and-address-proof.mjs
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAYLOAD = path.join(REPO, 'capability')
const require_ = createRequire(import.meta.url)

/* computers.js is a browser view and owns its stylesheets; Node has no CSS
   module format. The same empty-stylesheet stand-in the view's suites use. */
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)

const { circleName } = await import('../src/views/computers.js')
const { createFleetTreeStore } = await import('../src/fleet-trees.js')

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

const LABELS = new Map([['controller', 'Controller'], ['manager', 'Manager'], ['worker', 'Worker']])
const labelFor = role => LABELS.get(role) || 'Agent'

/* THE DEFECT, AS CODE RATHER THAN AS PROSE. These are the two lines
   src/views/computers.js treeNodeName() used to answer with, before
   nodeDisplayName() was ever reached. Kept here so step 1 reproduces the
   measured state instead of asserting that it happened. */
function nameBeforeTheFix(node, peers, roleLabel) {
  if (typeof node?.name === 'string' && node.name.trim()) return node.name.trim()
  if (typeof node?.nameBase === 'string' && node.nameBase.trim()) return node.nameBase.trim()
  return circleName(node, peers, roleLabel)
}

/* TWO TREES IN ONE STORE, each a Controller with two Managers under it -- the
   shape the lanes were spawned in, on the one store a computer really has.
   Both trees matter: per-tree ordinals BOTH start at one, so two trees are the
   state the cross-tree half of the naming rule exists for, and the message
   directory is per-computer and sees both at once.

   addNode() is what the tree-command broker calls for an API spawn. roleLabel
   is wired because the store records nameBase only when it answers, and a
   recorded nameBase is the condition the defect needed. */
function drawTrees() {
  let record = null
  let counter = 0
  const storage = { read: () => record, write: (_key, value) => { record = JSON.parse(JSON.stringify(value)); return true } }
  const store = createFleetTreeStore({
    computerId: 't138-proof',
    storage,
    roleLabel: labelFor,
    makeId: kind => `${kind}-${++counter}-${String(counter).padStart(8, '0')}`,
  })
  const tree = () => {
    const controller = store.addNode({ role: 'controller' }).node
    const managers = [0, 1].map(() => store.addNode({ parentId: controller.id, role: 'manager' }).node)
    return { controller, managers }
  }
  return { store, first: tree(), second: tree() }
}

function startServer(stateRoot, localAppData) {
  const child = spawn(process.execPath, [path.join(PAYLOAD, 'src', 'mcp-server.js')], {
    cwd: PAYLOAD,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TOOLSENABLED_STATE_ROOT: stateRoot,
      LOCALAPPDATA: localAppData,
      TOOLSENABLED_AGENT_ACTOR: 'claude',
    },
  })
  let stdout = ''
  const waiting = new Map()
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
    let index = stdout.indexOf('\n')
    while (index >= 0) {
      const line = stdout.slice(0, index).trim()
      stdout = stdout.slice(index + 1)
      index = stdout.indexOf('\n')
      if (!line) continue
      let message = null
      try { message = JSON.parse(line) } catch { continue }
      const resolve = waiting.get(message.id)
      if (resolve) { waiting.delete(message.id); resolve(message) }
    }
  })
  let nextId = 1
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} did not answer in 30s`)) }, 30_000)
  })
  return { child, call, stop: () => child.kill() }
}

function structured(answer) {
  const result = answer && answer.result
  if (result && result.structuredContent) return result.structuredContent
  const text = result && Array.isArray(result.content) && result.content[0] && result.content[0].text
  try { return JSON.parse(text) } catch { return { text } }
}

const tool = (server, name, args) => server.call('tools/call', { name, arguments: args }).then(structured)

/* A refusal reaches a caller as a value on the tool answer, or -- when the tool
   layer wraps it -- under `error`. Read both rather than assume one. */
const codeOf = answer => answer?.code || answer?.error?.code || null
const reasonOf = answer => answer?.reason || answer?.message || answer?.error?.reason || answer?.error?.message || ''

async function main() {
  const stateRoot = mkdtempSync(path.join(tmpdir(), 't138-proof-'))
  console.log(`\nstate root for this run: ${stateRoot}`)
  console.log(`payload under test:      ${PAYLOAD}\n`)
  let server = null
  try {
    process.env.TOOLSENABLED_STATE_ROOT = stateRoot
    /* ASK THE PAYLOAD WHERE IT WILL LOOK, rather than telling it where we put
       the record. resolveServicesRoot() does NOT read TOOLSENABLED_SERVICES_ROOT
       -- it derives the services root from TOOLSENABLED_STATE_ROOT and
       LOCALAPPDATA, and a record written anywhere else is simply not found. A
       record that is not found is not an error: the server falls back to the
       fail-closed level in silence, by design, and then advertises no messenger
       at all. Guessing the path here is how tools/agent-to-agent-mcp-proof.mjs
       came to report "the payload does not advertise both messengers" about a
       payload that advertises both -- see REPORT-T138-NAMING-20260916.md. */
    const localAppData = path.join(stateRoot, 'local')
    const childEnv = { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot, LOCALAPPDATA: localAppData }
    const servicesRoot = require_(path.join(PAYLOAD, 'src/lib/durable-memory-file.js')).resolveServicesRoot({ env: childEnv })
    const workspace = path.join(stateRoot, 'home', 'ToolsEnabled')
    mkdirSync(servicesRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    console.log(`services root the payload resolves: ${servicesRoot}\n`)
    const machineRecord = require_(path.join(PAYLOAD, 'src/lib/setup/machine-record.js'))
    machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
      tier: 'standard',
      servicesRoot,
      installRoot: PAYLOAD,
      nodePath: process.execPath,
      workspaceRoots: [workspace],
    }), { servicesRoot })
    note('info', 'this computer is recorded at the "standard" permission level, as a normal install is')

    const { createTreeNodeDirectory } = require_(path.join(PAYLOAD, 'src/lib/agent-comms/tree-node-directory.js'))
    const directory = createTreeNodeDirectory()

    /* ------------------------------------------------------------------ [1] */
    console.log('\n[1] THE FAILURE: the first tree, named the way the lanes were named on 2026-09-16')
    const drawn = drawTrees()
    const peers = drawn.store.snapshot().nodes
    const before = drawn.first
    const beforeNames = {
      controller: nameBeforeTheFix(before.controller, peers, labelFor),
      managers: before.managers.map(node => nameBeforeTheFix(node, peers, labelFor)),
    }
    note(beforeNames.managers[0] === beforeNames.managers[1] ? 'ok' : 'FAIL',
      `the removed lines name both spawns the same: ${JSON.stringify(beforeNames.managers)} (this reproducing the measurement IS the expected result here)`)
    directory.registerNode({ sessionId: 'before-controller', nodeName: beforeNames.controller, treeKey: 'before-tree', nodeKey: before.controller.id })
    before.managers.forEach((node, index) => directory.registerNode({
      sessionId: `before-manager-${index}`, nodeName: beforeNames.managers[index],
      managerName: beforeNames.controller, treeKey: 'before-tree', nodeKey: node.id,
    }))

    server = startServer(stateRoot, localAppData)
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't138-proof', version: '1' } })
    const listed = await server.call('tools/list', {})
    const tools = ((listed.result && listed.result.tools) || []).map(entry => entry.name)
    const missing = ["agent_comms.local_roster", "agent_comms.send_local"].filter(name => !tools.includes(name))
    note(missing.length === 0 ? "ok" : "FAIL",
      `the server advertises ${tools.length} tools, including both local messengers`)

    const beforeRoster = await tool(server, 'agent_comms.local_roster', { from: beforeNames.controller })
    note('info', `the Controller's roster before the fix: ${JSON.stringify(beforeRoster.reachable)}`)
    const beforeSend = await tool(server, 'agent_comms.send_local', {
      from: beforeNames.controller, to: beforeNames.managers[0], body: 'Take the naming lane.',
    })
    note(codeOf(beforeSend) === 'TREE_RECIPIENT_AMBIGUOUS' ? 'ok' : 'FAIL',
      `addressing a manager by name refuses, exactly as measured: ${JSON.stringify(beforeSend)}`)
    const beforeById = await tool(server, 'agent_comms.send_local', {
      from: beforeNames.controller, to: before.managers[0].id, body: 'Take the naming lane.',
    })
    note(codeOf(beforeById) === 'TREE_RECIPIENT_UNKNOWN' ? 'ok' : 'FAIL',
      `addressing it by the saved-circle id refuses too: ${JSON.stringify(beforeById)}`)

    /* ------------------------------------------------------------------ [2] */
    console.log('\n[2] THE FIX: the second tree, named by the shipped function')
    const after = drawn.second
    const controllerName = circleName(after.controller, peers, labelFor)
    const managerNames = after.managers.map(node => circleName(node, peers, labelFor))
    note(managerNames[0] !== managerNames[1] ? 'ok' : 'FAIL',
      `two managers spawned under one controller take two names: ${JSON.stringify(managerNames)}`)
    note(new Set([controllerName, ...managerNames]).size === 3 ? 'ok' : 'FAIL',
      `every circle on this tree answers to its own name: ${JSON.stringify([controllerName, ...managerNames])}`)

    const registered = [
      directory.registerNode({ sessionId: 'after-controller', nodeName: controllerName, treeKey: 'after-tree', nodeKey: after.controller.id }),
      ...after.managers.map((node, index) => directory.registerNode({
        sessionId: `after-manager-${index}`, nodeName: managerNames[index],
        managerName: controllerName, treeKey: 'after-tree', nodeKey: node.id,
      })),
    ]

    /* ------------------------------------------------------------------ [3] */
    console.log('\n[3] THE ROSTER the Controller reads, over the real tool server')
    const roster = await tool(server, 'agent_comms.local_roster', { from: controllerName })
    note(roster.ok === true ? 'ok' : 'FAIL', `the roster answers: ok=${roster.ok} ${roster.code || ''}`)
    const rows = roster.reachable || []
    note(rows.length === 2 ? 'ok' : 'FAIL', `it lists both managers: ${JSON.stringify(rows.map(row => row.nodeName))}`)
    note(rows.every(row => typeof row.agentId === 'string' && row.agentId.startsWith('tree-')) ? 'ok' : 'FAIL',
      `every row carries an agentId: ${JSON.stringify(rows.map(row => ({ nodeName: row.nodeName, agentId: row.agentId })))}`)
    note(new Set(rows.map(row => row.agentId)).size === rows.length ? 'ok' : 'FAIL',
      'the agentIds on the roster are distinct, so two rows are never one circle')

    /* ------------------------------------------------------------------ [4] */
    console.log('\n[4] THE SEND, addressed by an agentId read straight off that roster')
    const deliveries = []
    for (const row of rows) {
      const answer = await tool(server, 'agent_comms.send_local', {
        from: controllerName, to: row.agentId, body: `Take the lane for ${row.nodeName}.`,
      })
      deliveries.push({ row, answer })
      note(answer.accepted === true ? 'ok' : 'FAIL',
        `to ${row.nodeName} (${row.agentId}): accepted=${answer.accepted} delivered=${answer.delivered} ${answer.code || ''} ${answer.reason || ''}`)
    }

    /* AND IT LANDED ON THE RIGHT CIRCLE. An accepted send that arrived in the
       wrong inbox is indistinguishable from a correct one afterwards, which is
       the whole reason the directory refuses to guess. */
    const local = require_(path.join(PAYLOAD, 'src/lib/providers/agent-comms-local.js'))
    for (const { row } of deliveries) {
      const { page } = await local.inbox({ agentId: row.agentId, cursor: 0 })
      const bodies = (page.records || []).map(record => record.message.body)
      /* The fabric prefixes a delivery with the sender's name, so the check is
         that this inbox holds exactly one message and that it is the one
         addressed to THIS circle -- not that the body is byte-identical to what
         was sent. Each body names a different manager, so a delivery that went
         to the wrong circle fails here. */
      note(bodies.length === 1 && bodies[0].endsWith(`Take the lane for ${row.nodeName}.`) ? 'ok' : 'FAIL',
        `${row.nodeName}'s inbox holds its own message and nothing else: ${JSON.stringify(bodies)}`)
    }

    /* ------------------------------------------------------------------ [5] */
    console.log('\n[5] A MANAGER ANSWERING ITS CONTROLLER, by the address its own roster gave it')
    const managerRow = rows[0]
    const managerRoster = await tool(server, 'agent_comms.local_roster', { from: managerRow.nodeName })
    const up = (managerRoster.reachable || []).find(row => row.relation === 'manager')
    note(up && typeof up.agentId === 'string' ? 'ok' : 'FAIL',
      `the manager's own roster names its Controller by address: ${JSON.stringify(up)}`)
    if (up) {
      const answered = await tool(server, 'agent_comms.send_local', { from: managerRow.nodeName, to: up.agentId, body: 'Lane taken.' })
      note(answered.accepted === true ? 'ok' : 'FAIL', `the reply up the tree: ${JSON.stringify(answered)}`)
    }

    /* ------------------------------------------------------------------ [6] */
    console.log('\n[6] THE REFUSALS STILL REFUSE, and now say something a caller can act on')
    const stranger = await tool(server, 'agent_comms.send_local', { from: controllerName, to: 'Somebody Else', body: 'hello' })
    note(codeOf(stranger) === 'TREE_RECIPIENT_UNKNOWN' ? 'ok' : 'FAIL', `an unknown circle: ${codeOf(stranger)}`)
    note(rows.every(row => String(reasonOf(stranger)).includes(row.agentId)) ? 'ok' : 'FAIL',
      `and the refusal hands over the addresses that would work: ${reasonOf(stranger)}`)
    const ambiguousStill = await tool(server, 'agent_comms.send_local', {
      from: beforeNames.controller, to: beforeNames.managers[0], body: 'still ambiguous',
    })
    note(codeOf(ambiguousStill) === 'TREE_RECIPIENT_AMBIGUOUS' ? 'ok' : 'FAIL',
      `two live circles under one name are still refused rather than guessed at: ${codeOf(ambiguousStill)}`)
    note(String(reasonOf(ambiguousStill)).includes('tree-') ? 'ok' : 'FAIL',
      `and that refusal names an address per candidate: ${reasonOf(ambiguousStill)}`)

    writeFileSync(path.join(REPO, 'T138-PROOF-RESULT.json'), `${JSON.stringify({
      payload: PAYLOAD,
      before: beforeNames,
      after: { controller: controllerName, managers: managerNames },
      roster: rows.map(row => ({ nodeName: row.nodeName, agentId: row.agentId, relation: row.relation })),
      registered: registered.map(entry => entry.agentId),
      findings,
    }, null, 2)}\n`)
  } finally {
    if (server) server.stop()
    try { rmSync(stateRoot, { recursive: true, force: true }) } catch { /* scratch */ }
  }

  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} -- ${findings.filter(f => f.level === 'ok').length} ok, ${failed.length} failed`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
