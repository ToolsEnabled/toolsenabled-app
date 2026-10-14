#!/usr/bin/env node

/* CAN ONE AGENT ON THIS COMPUTER ACTUALLY REACH ANOTHER ONE — ASKED OF THE
 * SHIPPED TOOL SERVER, OVER REAL STDIO JSON-RPC, FAILING FIRST.
 *
 * THE OWNER'S FINDING, verbatim: "This is just the issue with trying to have it
 * reach coordinator through agent comms it didnt work."
 *
 * WHAT THIS RUN IS, EXACTLY, so nobody reads more into it than it proves. It
 * starts capability/src/mcp-server.js -- the real tool server a customer's Codex
 * or Claude session talks to, out of the real packed payload -- and speaks the
 * real protocol to it. Everything between `tools/call` and durable delivery is
 * the product. What it is NOT is a model CHOOSING to call the tool, and it is
 * not the screen. Those belong to the driven UI proof; this one answers the
 * question that must be answered first, which is whether the call the model
 * would make can succeed at all.
 *
 * FAILING FIRST, ON THE SAME SERVER, IN THE SAME RUN. It asks agent_comms.send
 * -- the tool a child was actually handed -- for the only recipient the shipped
 * registry lets it name, and prints the refusal verbatim. Then it asks
 * agent_comms.send_local and prints the delivery. A fix proved without the
 * failure beside it is a fix nobody can check.
 *
 *   node tools/agent-to-agent-mcp-proof.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAYLOAD = path.join(REPO, 'capability')
const require_ = createRequire(import.meta.url)

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* A tool server speaking stdio JSON-RPC, started the way a CLI starts one: the
   recorded runtime, the server script, the payload as cwd, and the environment
   entry the generator writes for it -- nothing else inherited. */
function startServer(stateRoot, servicesRoot, actor) {
  const child = spawn(process.execPath, [path.join(PAYLOAD, 'src', 'mcp-server.js')], {
    cwd: PAYLOAD,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TOOLSENABLED_STATE_ROOT: stateRoot,
      /* THE RECORDED PERMISSION LEVEL LIVES BESIDE THE MACHINE RECORD, and
         without it the server falls back to the FAIL-CLOSED level. That is the
         product working, and it is worth writing down because it cost this run
         a red herring: with no record the server advertised 111 tools and
         NEITHER messenger, because Guided permits no local write at all. So a
         real machine record at the level a normal install runs is part of the
         setup, not a convenience -- and "the messenger is missing at Guided" is
         a true statement about that level, not a defect.
         The record's directory is not named to the server: resolveServicesRoot()
         derives it as LOCALAPPDATA joined with the state root's parent name, so
         LOCALAPPDATA is the one variable that places it (see main()). */
      LOCALAPPDATA: path.dirname(servicesRoot),
      /* THE PRINCIPAL. This is the variable nothing in the product set for an
         app-spawned session, which is why every call died at
         AGENT_COMMS_ACTOR_REQUIRED before it reached any addressing. It is now
         written into the generated MCP entry's env by generateMcpConfig
         (option `agentActor`), so this run supplies exactly what a real session
         is now given -- no more. */
      ...(actor ? { TOOLSENABLED_AGENT_ACTOR: actor } : {}),
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

async function main() {
  /* THE LAYOUT THE ENGINE DERIVES ITS SERVICE ROOT FROM. resolveServicesRoot()
     (capability/src/lib/durable-memory-file.js) no longer reads
     TOOLSENABLED_SERVICES_ROOT: it takes the product directory name from the
     PARENT of TOOLSENABLED_STATE_ROOT and joins it onto LOCALAPPDATA, exactly
     as the running app lays out <user data>\capability and
     %LOCALAPPDATA%\<user data name>. A state root created directly under the
     temp directory made that parent "Temp", so the server looked for
     ...\local\Temp while this file had written the machine record to
     ...\local\ToolsEnabled -- and a missing record is not an error: the server
     fell back to the fail-closed level in silence, advertised 98 tools and no
     messenger, and this run printed a confident false FAIL about the payload
     (measured 2026-09-16 at engine 85520c4b, ledger T138). The state root now
     sits under a "ToolsEnabled" user-data directory, so both sides agree. */
  const runRoot = mkdtempSync(path.join(tmpdir(), 'a2a-proof-'))
  const stateRoot = path.join(runRoot, 'ToolsEnabled', 'capability')
  mkdirSync(stateRoot, { recursive: true })
  console.log(`\nstate root for this run: ${stateRoot}\n`)
  let server = null
  try {
    /* TWO NODES ON A TREE, registered exactly as shell/agent-host.cjs registers
       them when a session is briefed -- through the payload's own directory
       module, not through a fixture this file wrote. */
    process.env.TOOLSENABLED_STATE_ROOT = stateRoot
    const servicesRoot = path.join(runRoot, 'local', 'ToolsEnabled')
    const workspace = path.join(runRoot, 'home', 'ToolsEnabled')
    mkdirSync(servicesRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })
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
    directory.registerNode({ sessionId: 'chat-manager-proof', nodeName: 'Manager' })
    directory.registerNode({ sessionId: 'chat-child-proof', nodeName: 'Default', managerName: 'Manager' })
    note('info', 'a two-node tree is registered: "Manager", and "Default" reporting to it')

    console.log('\n[1] THE FAILURE, on the tool a child was actually handed')
    server = startServer(stateRoot, servicesRoot, 'codex')
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a2a-proof', version: '1' } })

    const listed = await server.call('tools/list', {})
    const tools = (listed.result && listed.result.tools) || []
    note('info', `the server advertises ${tools.length} tools`)
    const send = tools.find(tool => tool.name === 'agent_comms.send')
    const local_ = tools.find(tool => tool.name === 'agent_comms.send_local')
    if (!send || !local_) {
      note('FAIL', `the payload does not advertise both messengers: send=${Boolean(send)} send_local=${Boolean(local_)}`)
      return
    }
    const schema = send.inputSchema || send.input_schema
    const machines = schema.properties.recipientMachine.enum
    note('info', `agent_comms.send offers exactly these recipient machines: ${JSON.stringify(machines)}`)

    const refused = structured(await server.call('tools/call', {
      name: 'agent_comms.send',
      arguments: { recipientActor: 'codex', recipientMachine: machines[0], body: 'Manager: I finished step one.' },
    }))
    /* TWO WALLS, AND WHICH ONE FIRES FIRST DEPENDS ON THE INSTALL. On a fresh
       computer with no relay credential the messenger cannot build a transport
       at all, so that is the refusal a person really gets; behind it, for a
       computer that HAS one, sits the structural wall this whole lane is about
       -- the recipient enum printed above contains exactly one machine and the
       provider answers that one value with
       AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED. Either way the shipped
       messenger cannot carry a local message, which is the point. Both are
       counted as the expected failure; a DELIVERY here would be the surprise. */
    const refusedCode = (refused && refused.code)
      || (refused && refused.error && refused.error.code)
    const cannotCarry = refusedCode === 'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED'
      || refusedCode === 'AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE'
    note(cannotCarry ? 'ok' : 'FAIL',
      `the shipped messenger refuses by name (${refusedCode}): ${JSON.stringify(refused)}`)
    if (refusedCode === 'AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE') {
      note('info', 'that code could not fire at all before this lane: getSecret() throws SECRET_NOT_CONFIGURED rather than returning a short value, so the length check that names this failure never saw one and every caller got the raw secret-store error instead. The named fail-closed code is now reachable, which is what a fail-closed code is for.')
      note('info', `and behind it, the structural wall: recipientMachine offers ${JSON.stringify(machines)} and the provider answers that one value with AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED.`)
    }

    console.log('\n[2] THE FIX, on the same server, in the same run')
    const delivered = structured(await server.call('tools/call', {
      name: 'agent_comms.send_local',
      arguments: { from: 'Default', to: 'Manager', body: 'I finished step one. Do you want step two?' },
    }))
    note(delivered && delivered.accepted === true ? 'ok' : 'FAIL',
      `the child's message to its manager: ${JSON.stringify(delivered)}`)

    const replied = structured(await server.call('tools/call', {
      name: 'agent_comms.send_local',
      arguments: { from: 'Manager', to: 'Default', body: 'Yes, go ahead with step two.' },
    }))
    note(replied && replied.accepted === true ? 'ok' : 'FAIL',
      `the manager's reply to the child: ${JSON.stringify(replied)}`)

    console.log('\n[3] WHAT EACH SESSION WOULD BE HANDED, read from the durable fabric')
    const local = require_(path.join(PAYLOAD, 'src/lib/providers/agent-comms-local.js'))
    for (const [name, sessionId] of [['Manager', 'chat-manager-proof'], ['Default', 'chat-child-proof']]) {
      const { page } = await local.inbox({ agentId: directory.agentIdForSession(sessionId), cursor: 0 })
      const bodies = (page.records || []).map(record => record.message.body)
      note(bodies.length === 1 ? 'ok' : 'FAIL', `${name}'s inbox: ${JSON.stringify(bodies)}`)
    }

    console.log('\n[4] WHAT THE COMMS PAGE WOULD SHOW, from the same owner journal it reads')
    const journal = await local.ownerJournal({ limit: 50 })
    note(journal.ok && journal.messages.length === 2 ? 'ok' : 'FAIL',
      `owner journal: ${JSON.stringify(journal.messages.map(message => ({ sender: message.sender, text: message.text })))}`)

    console.log('\n[5] THE REFUSALS A PERSON WOULD ACTUALLY HIT')
    const stranger = structured(await server.call('tools/call', {
      name: 'agent_comms.send_local',
      arguments: { from: 'Default', to: 'Somebody Else', body: 'hello' },
    }))
    note(stranger.code === 'TREE_RECIPIENT_UNKNOWN' ? 'ok' : 'FAIL', `an unknown circle: ${stranger.code} — ${stranger.reason}`)

    directory.unregisterNode({ sessionId: 'chat-manager-proof' })
    const stopped = structured(await server.call('tools/call', {
      name: 'agent_comms.send_local',
      arguments: { from: 'Default', to: 'Manager', body: 'are you there' },
    }))
    note(stopped.code === 'TREE_RECIPIENT_NOT_RUNNING' ? 'ok' : 'FAIL', `a manager that stopped: ${stopped.code} — ${stopped.reason}`)
    server.stop()
    server = null

    console.log('\n[6] THE PRINCIPAL, with the variable the product now sets removed')
    /* The negative control for step 2. Without TOOLSENABLED_AGENT_ACTOR the
       cross-machine tool cannot even name a sender; the local one resolves its
       sender from the tree address instead, which is the whole point of the
       identity mapping and is worth demonstrating rather than asserting. */
    const anonymous = startServer(stateRoot, servicesRoot, null)
    await anonymous.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a2a-proof', version: '1' } })
    directory.registerNode({ sessionId: 'chat-manager-proof', nodeName: 'Manager' })
    const withoutActor = structured(await anonymous.call('tools/call', {
      name: 'agent_comms.send_local',
      arguments: { from: 'Default', to: 'Manager', body: 'no principal, still addressed' },
    }))
    note(withoutActor && withoutActor.accepted === true ? 'ok' : 'FAIL',
      `the local channel with no TOOLSENABLED_AGENT_ACTOR at all: ${JSON.stringify(withoutActor)}`)
    anonymous.stop()
  } finally {
    if (server) server.stop()
    try { rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the run outlives the directory */ }
    /* THE VERDICT IS WRITTEN ON EVERY WAY OUT. The earliest FAIL above -- the
       payload not advertising both messengers -- returned from inside the try
       block, and this summary used to sit after it, so that one failure
       printed FAIL and exited 0: anything reading only the exit code was told
       the messengers were fine (found by the T148 review, 2026-09-16). The
       summary and the exit code now live here, where every return passes. */
    const failed = findings.filter(finding => finding.level === 'FAIL')
    console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
    for (const finding of failed) console.log(`  FAIL ${finding.text}`)
    process.exitCode = failed.length ? 1 : 0
  }
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
