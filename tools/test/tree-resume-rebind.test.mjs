/* A RESUMED CIRCLE IS THE SAME CIRCLE, and this suite is the only place that
 * proves it end to end through the production host.
 *
 * MEASURED 2026-09-02: a Manager resumed from the tree got a new session id and
 * no brief -- the engine restores the conversation itself, so the view sends no
 * first turn at all -- and registerTreeSession(), which reads the tree address
 * out of the FIRST TURN'S TEXT, therefore never fired. From then on the circle
 * was alive on screen and unreachable: agent_comms.send_local answered
 * TREE_SENDER_NOT_RUNNING for an agent that was running.
 *
 * Every assertion below calls the host with values and then asks the directory
 * and the engine what happened, rather than reading shell/agent-host.cjs for a
 * spelling. A rebinding that stops working must fail here.
 */

import assert from 'node:assert/strict'
import fs, { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_ROOT = path.join(ROOT, 'tools/test/fixtures/confined-engine')
const ENGINE = path.join(FIXTURE_ROOT, 'src/lib/agent-engine/codex-process.js')
const DIRECTORY = path.join(FIXTURE_ROOT, 'src/lib/agent-comms/tree-node-directory.js')
const PROVIDER = path.join(FIXTURE_ROOT, 'src/lib/providers/agent-comms-local.js')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const { ownedCodexResumeSource } = require_(path.join(ROOT, 'shell/codex-resume-source.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-tree-resume-rebind-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

test('native resume finds only the exact agent/account rollout across isolated session homes', t => {
  const root = mkdtempSync(path.join(SCRATCH, 'native-store-'))
  const id = '11111111-1111-1111-1111-111111111111'
  const home = stamp => path.join(root, '@agents', 'agent-one', '@sessions', stamp.repeat(64), 'codex', 'standard', 'account')
  const previous = home('a'), current = home('b')
  const file = path.join(previous, 'sessions', '2026', '09', '10', 'rollout-saved-' + id + '.jsonl')
  mkdirSync(path.dirname(file), { recursive: true }); mkdirSync(current, { recursive: true })
  for (const directory of [previous, current]) writeFileSync(path.join(directory, 'toolsenabled-account.json'), JSON.stringify({ name: 'Exact account' }))
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n')
  const request = { generatedHome: current, agentId: 'agent-one', account: 'Exact account', threadId: id }
  const source = ownedCodexResumeSource(request)
  assert.equal(source.sourcePath, file)
  source.assertCurrent()
  assert.equal(ownedCodexResumeSource({ ...request, agentId: 'agent-two' }), null)
  assert.throws(() => ownedCodexResumeSource({ ...request, account: 'Other account' }), { code: 'AGENT_RESUME_SOURCE_UNAVAILABLE' })
  const duplicate = path.join(current, 'sessions', path.basename(file))
  mkdirSync(path.dirname(duplicate)); cpSync(file, duplicate)
  assert.throws(() => ownedCodexResumeSource(request), /More than one/)
  rmSync(duplicate)
  renameSync(file, file + '.old'); cpSync(file + '.old', file)
  assert.throws(() => source.assertCurrent(), /replaced/)
  rmSync(file)
  mkdirSync(file)
  assert.throws(() => ownedCodexResumeSource(request), /ordinary file/)
})

for (const wideIdentity of [false, true]) test(wideIdentity
  ? 'paginated resume distinguishes native file identities that round to the same Number'
  : 'paginated native resume binds only the verified database lineage and rejects replacement', () => {
  const root = mkdtempSync(path.join(SCRATCH, 'paginated-store-'))
  const id = '22222222-2222-4222-8222-222222222222'
  const home = stamp => path.join(root, '@agents', 'agent-one', '@sessions', stamp.repeat(64), 'codex', 'standard', '@default')
  const previous = home('a'), current = home('b')
  const file = path.join(previous, 'sessions', 'rollout-saved-' + id + '.jsonl')
  mkdirSync(path.dirname(file), { recursive: true }); mkdirSync(current, { recursive: true })
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, history_mode: 'paginated' } }) + '\n')
  const databaseHome = process.platform === 'win32' && previous.length > 220
    ? path.join(path.dirname(root), 'agent-db', createHash('sha256').update(previous, 'utf8').digest('base64url')) : previous
  mkdirSync(databaseHome, { recursive: true })
  const database = path.join(databaseHome, 'thread_history_1.sqlite')
  writeFileSync(database, 'fixture database identity; native SQLite parsing is checked separately')
  const lstat = fs.lstatSync
  const identities = new Map()
  // Native file identifiers are opaque 64-bit values. Keep actual filesystem
  // replacement and ownership checks, while giving its two distinct file IDs
  // values that the Number form of Stats cannot distinguish deterministically.
  if (wideIdentity) fs.lstatSync = (target, options) => {
    const result = lstat(target, options)
    if (path.resolve(String(target)) !== database) return result
    const exact = lstat(target, { bigint: true })
    const key = `${exact.dev}:${exact.ino}`
    if (!identities.has(key)) identities.set(key, 9007199254740992n + BigInt(identities.size))
    result.ino = options?.bigint ? identities.get(key) : Number(identities.get(key))
    return result
  }
  try {
    const source = ownedCodexResumeSource({ generatedHome: current, agentId: 'agent-one', account: null, threadId: id })
    assert.equal(source.databaseHome, databaseHome); source.assertCurrent()
    const before = fs.lstatSync(database, { bigint: true }).ino
    renameSync(database, database + '.old'); cpSync(database + '.old', database)
    const after = fs.lstatSync(database, { bigint: true }).ino
    assert.notEqual(before, after, 'the fixture must replace the file identity')
    if (wideIdentity) assert.equal(Number(before), Number(after), 'the fixture must expose the Number precision loss')
    assert.throws(() => source.assertCurrent(), /database was replaced/)
  } finally { fs.lstatSync = lstat }
})

function plan(workdir) {
  return {
    ok: true,
    tier: 'standard',
    isolated: true,
    threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly', 'toolsenabled'],
  }
}

async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

/* The fixture keeps one set of rows behind every handle, exactly as the real
   module keeps one file behind every handle, so a test reads the same directory
   the host writes. */
function rows(directory) {
  return directory.createTreeNodeDirectory().listNodes()
}

function liveRowFor(directory, sessionId) {
  return rows(directory).find(node => node.sessionId === sessionId && !node.stoppedAt) || null
}

async function withHost(name, run) {
  const workdir = mkdtempSync(path.join(SCRATCH, `${name}-`))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
  })
  try {
    await run({ host, directory, provider, engine, workdir })
  } finally {
    await host.closeAll().catch(() => {})
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('a clean Page 2 restart registers its saved address without sending a brief', async () => {
  await withHost('clean-restart', async ({ host, directory, engine }) => {
    await host.startSession({
      sessionId: 'clean-worker',
      requestKeys: { treeAnchors: ['tree-current', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Manager' },
    })

    const row = liveRowFor(directory, 'clean-worker')
    assert.ok(row, 'the clean restart is live but unreachable until somebody sends it a new turn')
    assert.equal(row.nodeName, 'Worker')
    assert.equal(row.managerName, 'Manager')
    assert.equal(row.treeKey, 'tree-current')
    assert.equal(engine.adapterCalls.length, 0,
      'registering the saved address re-sent a brief or invented a first turn')
  })
})

test('a clean Page 2 replacement retires the prior session row before registering the new one', async () => {
  await withHost('clean-replacement-row', async ({ host, directory, engine }) => {
    directory.createTreeNodeDirectory().registerNode({
      sessionId: 'worker-before-restart',
      nodeName: 'Worker',
      managerName: 'Manager',
      pid: 4242,
      threadId: 'thread-before-restart',
      treeKey: 'tree-current',
    })

    await host.startSession({
      sessionId: 'worker-after-restart',
      replacesSessionId: 'worker-before-restart',
      requestKeys: { treeAnchors: ['tree-current', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Manager' },
    })

    const prior = rows(directory).find(row => row.sessionId === 'worker-before-restart')
    assert.ok(prior?.stoppedAt, 'the replaced session still claims to be a live Worker')
    const liveWorkers = rows(directory).filter(row => row.nodeName === 'Worker' && !row.stoppedAt)
    assert.deepEqual(liveWorkers.map(row => row.sessionId), ['worker-after-restart'])
    assert.equal(engine.adapterCalls.length, 0, 'retiring the old address invented a turn')
  })
})

test('a resumed circle answers to its own name without the brief being re-sent', async () => {
  await withHost('rebind', async ({ host, directory, provider, engine }) => {
    await host.startSession({ sessionId: 'worker-first' })
    await host.sendTurn({
      sessionId: 'worker-first',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    const thread = rows(directory).find(node => node.sessionId === 'worker-first')
    assert.ok(thread, 'the brief did not register the circle at all, so this suite is not measuring a resume')
    assert.equal(thread.threadId, 'thread-1', 'the first registration did not record the engine thread it runs')

    /* The circle is stopped exactly as the person stops one on the tree. */
    await host.closeSession({ sessionId: 'worker-first' })

    /* THE RESUME AS THE TREE ACTUALLY PERFORMS IT: a new session id, the saved
       thread, and NO first turn -- the engine restores the conversation, so no
       brief and no tree address line ever reaches the host. */
    const resumed = await host.startSession({ sessionId: 'worker-second', resumeThreadId: 'thread-1' })
    assert.equal(resumed.threadId, 'thread-1')

    const row = liveRowFor(directory, 'worker-second')
    assert.ok(row, 'the resumed session never reached the directory, so the circle is unreachable while it runs')
    assert.equal(row.nodeName, 'Worker', 'the resumed session took a different name than the circle it continues')
    assert.equal(row.managerName, 'Manager', 'the resumed session lost the manager edge of the circle it continues')

    /* Addressable is the behaviour, not the row: a message sent to the resumed
       session's own fabric id has to become that session's next model turn. */
    const before = engine.adapterCalls.length
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('worker-second'),
      senderAgentId: directory.agentIdForSession('manager-elsewhere'),
      body: 'Manager: report the measured result.',
    })
    const delivered = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1))
    assert.ok(delivered, 'the resumed circle never polled its inbox, so a message to it was never delivered')
    assert.match(delivered.request.text, /^Manager: report the measured result\./)
  })
})

test('a resumed circle names the thread it now runs, so the next resume finds it too', async () => {
  await withHost('rechain', async ({ host, directory, engine }) => {
    await host.startSession({ sessionId: 'manager-first' })
    await host.sendTurn({
      sessionId: 'manager-first',
      text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
      origin: 'brief',
    })
    await host.closeSession({ sessionId: 'manager-first' })

    await host.startSession({ sessionId: 'manager-second', resumeThreadId: 'thread-1' })
    const secondRow = liveRowFor(directory, 'manager-second')
    assert.ok(secondRow, 'the first resume did not rebind')
    assert.equal(secondRow.threadId, 'thread-1', 'the resumed row does not name the thread this session runs')
    await host.closeSession({ sessionId: 'manager-second' })

    await host.startSession({ sessionId: 'manager-third', resumeThreadId: 'thread-1' })
    const thirdRow = liveRowFor(directory, 'manager-third')
    assert.ok(thirdRow, 'the SECOND resume of the same circle went mute')
    assert.equal(thirdRow.nodeName, 'Manager')
    assert.equal(thirdRow.managerName, null)
    assert.ok(engine.calls.at(-1).resumed, 'this suite stopped exercising the resume path')
  })
})

test('a resume retires the registration it continues, so one circle is never two live agents', async () => {
  await withHost('takeover', async ({ host, directory }) => {
    /* WHAT A PROCESS THAT ENDED WITHOUT CLOSING ITS SESSIONS LEAVES ON DISK:
       a row that was never unregistered, still inside the live window. The
       person reopens and resumes that circle. */
    directory.createTreeNodeDirectory().registerNode({
      sessionId: 'worker-dead-process',
      nodeName: 'Worker',
      managerName: 'Manager',
      pid: 4242,
      threadId: 'thread-1',
    })

    await host.startSession({ sessionId: 'worker-resumed', resumeThreadId: 'thread-1' })

    const liveWorkers = rows(directory).filter(node => node.nodeName === 'Worker' && !node.stoppedAt)
    assert.equal(
      liveWorkers.length,
      1,
      'the resume stood beside the circle it continues, so two running agents now answer to one name',
    )
    assert.equal(liveWorkers[0].sessionId, 'worker-resumed')
    const retired = rows(directory).find(node => node.sessionId === 'worker-dead-process')
    assert.ok(retired && retired.stoppedAt, 'the registration this session took over was left running')
  })
})

test('a leftover row wearing this session\'s own id is adopted, not skipped', async () => {
  await withHost('sameid', async ({ host, directory, provider, engine }) => {
    /* A previous process registered this circle under the very session id the
       resume is about to reuse. Nothing in THIS host registered it, so it is a
       stale record to adopt rather than work already done. */
    directory.createTreeNodeDirectory().registerNode({
      sessionId: 'circle-a',
      nodeName: 'Manager',
      managerName: null,
      pid: 4242,
      threadId: 'thread-1',
    })

    await host.startSession({ sessionId: 'circle-a', resumeThreadId: 'thread-1' })

    const before = engine.adapterCalls.length
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('circle-a'),
      senderAgentId: directory.agentIdForSession('someone-below'),
      body: 'Worker: the measured result is ready for review.',
    })
    const delivered = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1))
    assert.ok(delivered, 'the resumed circle never became addressable, so its own leftover row silenced it')
    assert.match(delivered.request.text, /^Worker: the measured result is ready for review\./)
  })
})

test('the circle\'s row names the thread the engine restored, not the one that was asked for', async () => {
  /* The host already treats the engine's answer as the only honest source for
     what a resumed session holds ("WHAT THE ENGINE SAYS, not what we asked
     for"). The directory row has to follow it, because the tree saves the
     engine's thread against the node and the NEXT resume asks for that one. */
  process.env.MC_TEST_RESUMED_THREAD_ID = 'thread-restored'
  try {
    await withHost('restored', async ({ host, directory }) => {
      directory.createTreeNodeDirectory().registerNode({
        sessionId: 'manager-dead-process',
        nodeName: 'Manager',
        managerName: null,
        pid: 4242,
        threadId: 'thread-asked',
      })

      const resumed = await host.startSession({ sessionId: 'manager-resumed', resumeThreadId: 'thread-asked' })
      assert.equal(resumed.threadId, 'thread-restored', 'the fixture engine did not exercise the divergent case')

      const row = liveRowFor(directory, 'manager-resumed')
      assert.ok(row, 'the resume did not rebind at all')
      assert.equal(
        row.threadId,
        'thread-restored',
        'the row names a thread this session is not running, so the next resume of this circle finds nothing',
      )
      assert.equal(
        directory.createTreeNodeDirectory().findByThreadId('thread-restored').sessionId,
        'manager-resumed',
      )
    })
  } finally {
    delete process.env.MC_TEST_RESUMED_THREAD_ID
  }
})

test('the saved Page 2 address overrides the dead row after a move and resume', async () => {
  await withHost('saved-address', async ({ host, directory }) => {
    directory.createTreeNodeDirectory().registerNode({
      sessionId: 'worker-before-move',
      nodeName: 'Worker',
      managerName: 'Old Manager',
      pid: 4242,
      threadId: 'thread-1',
      treeKey: 'tree-old',
    })

    await host.startSession({
      sessionId: 'worker-after-move',
      resumeThreadId: 'thread-1',
      requestKeys: { treeAnchors: ['tree-new', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Renamed Worker', managerName: 'New Manager' },
    })

    const row = liveRowFor(directory, 'worker-after-move')
    assert.ok(row, 'the saved tree address did not register the resumed circle')
    assert.equal(row.nodeName, 'Renamed Worker')
    assert.equal(row.managerName, 'New Manager', 'resume copied the dead row\'s former parent')
    assert.equal(row.treeKey, 'tree-new', 'resume copied the dead row\'s former tree')
    assert.ok(rows(directory).find(node => node.sessionId === 'worker-before-move')?.stoppedAt,
      'the dead registration resumed by the new session was not retired')
  })
})

test('a live move rebinds the circle and its tree without restarting it', async () => {
  await withHost('live-move', async ({ host, directory, engine }) => {
    await host.startSession({
      sessionId: 'worker-live',
      requestKeys: { treeAnchors: ['tree-old', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' },
    })
    await host.sendTurn({ sessionId: 'worker-live', text: 'Begin the assigned work.', origin: 'person' })
    const engineStarts = engine.calls.length

    const result = host.updateTreeAddress({
      sessionId: 'worker-live',
      selfName: 'Worker',
      managerName: 'New Manager',
      treeKey: 'tree-new',
    })

    assert.deepEqual(result, {
      ok: true,
      sessionId: 'worker-live',
      selfName: 'Worker',
      managerName: 'New Manager',
      treeKey: 'tree-new',
    })
    const row = liveRowFor(directory, 'worker-live')
    assert.ok(row)
    assert.equal(row.managerName, 'New Manager')
    assert.equal(row.treeKey, 'tree-new')
    assert.equal(engine.calls.length, engineStarts, 'moving a circle restarted its agent process')
  })
})

test('a saved Page 2 identity registers a resumed thread even without a legacy row', async () => {
  await withHost('saved-without-row', async ({ host, directory }) => {
    await host.startSession({
      sessionId: 'known-circle',
      resumeThreadId: 'thread-never-registered',
      requestKeys: { treeAnchors: ['tree-only'], threadId: 'node-only' },
      treeIdentity: { selfName: 'Solo', managerName: null },
    })
    const row = liveRowFor(directory, 'known-circle')
    assert.ok(row, 'a saved circle stayed unreachable because an old directory row was absent')
    assert.equal(row.nodeName, 'Solo')
    assert.equal(row.managerName, null)
    assert.equal(row.treeKey, 'tree-only')
  })
})

test('a thread the directory has never seen registers nothing, and says nothing false', async () => {
  await withHost('unknown', async ({ host, directory }) => {
    await host.startSession({ sessionId: 'lone-session', resumeThreadId: 'thread-never-briefed' })
    assert.equal(
      liveRowFor(directory, 'lone-session'),
      null,
      'a resume of a thread that was never a circle invented a tree address for it',
    )
  })
})


test('moves carry the latest name and reporting relationship on the next existing turn, once', async () => {
  await withHost('move-model-context', async ({ host, engine }) => {
    await host.startSession({ sessionId: 'moving',
      requestKeys: { treeAnchors: ['old-root', 'moving-node'], threadId: 'moving-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' } })
    await host.sendTurn({ sessionId: 'moving', text: 'Begin.' })
    const sendsBefore = engine.adapterCalls.length
    host.updateTreeAddress({ sessionId: 'moving', selfName: 'Worker 2', managerName: 'Intermediate', treeKey: 'intermediate' })
    host.updateTreeAddress({ sessionId: 'moving', selfName: 'Worker 3', managerName: 'Current Manager', treeKey: 'new-root',
      requestKeys: { treeAnchors: ['new-root', 'moving-node'], threadId: 'moving-node' } })
    assert.equal(engine.adapterCalls.length, sendsBefore, 'moving must not send or interrupt a provider turn')
    assert.equal(engine.calls.length, 1, 'moving must retain the original process')
    engine.calls[0].onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    await host.sendTurn({ sessionId: 'moving', text: 'Continue.' })
    const sent = engine.adapterCalls.at(-1).request.text
    assert.match(sent, /Your current name is "Worker 3"/)
    assert.match(sent, /You now report to "Current Manager"/)
    assert.doesNotMatch(sent, /Intermediate|Worker 2|Old Manager/)
    engine.calls[0].onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    await host.sendTurn({ sessionId: 'moving', text: 'Continue again.' })
    assert.doesNotMatch(engine.adapterCalls.at(-1).request.text, /updated your saved tree position/)
  })
})

test('a move refuses ancestry for a different circle before changing its directory', async () => {
  await withHost('move-wrong-circle', async ({ host, directory }) => {
    await host.startSession({ sessionId: 'moving',
      requestKeys: { treeAnchors: ['old-root', 'moving-node'], threadId: 'moving-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' } })
    assert.throws(() => host.updateTreeAddress({ sessionId: 'moving', selfName: 'Other', treeKey: 'new-root',
      requestKeys: { treeAnchors: ['new-root', 'other-node'], threadId: 'other-node' } }),
      { code: 'AGENT_REQUEST_KEYS_INVALID' })
    assert.equal(liveRowFor(directory, 'moving').nodeName, 'Worker')
    assert.equal(liveRowFor(directory, 'moving').managerName, 'Old Manager')
  })
})

test('a detached agent hears that it is now the top agent', async () => {
  await withHost('move-detach-context', async ({ host, engine }) => {
    await host.startSession({ sessionId: 'detached', treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' } })
    host.updateTreeAddress({ sessionId: 'detached', selfName: 'Worker', managerName: null, treeKey: 'worker-node' })
    await host.sendTurn({ sessionId: 'detached', text: 'Continue.' })
    assert.match(engine.adapterCalls.at(-1).request.text, /You are now the top agent of this tree/)
  })
})


test('a moved branch refreshes inherited rules lazily from its current saved ancestors', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'moved-rules-'))
  const fixture = path.join(workdir, 'engine')
  cpSync(FIXTURE_ROOT, fixture, { recursive: true })
  const ledgerPath = path.join(fixture, 'src/lib/r-ledger.js')
  writeFileSync(ledgerPath, `const calls = [];
    module.exports = { calls, fileRequest() {}, ledgerPath() { return null },
      readLedger(scope, key) { calls.push({ scope, key }); return { exists: true, path: null,
        entries: scope === 'tree' ? [{ id: 'RT1', words: 'Rule for ' + key }] : [] }; } };`, 'utf8')
  const enginePath = path.join(fixture, 'src/lib/agent-engine/codex-process.js')
  const engine = require_(enginePath)
  const ledger = require_(ledgerPath)
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
  try {
    await host.startSession({ sessionId: 'rule-move',
      requestKeys: { treeAnchors: ['old-root', 'moving-node'], threadId: 'moving-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' } })
    await host.sendTurn({ sessionId: 'rule-move', text: 'Begin.' })
    assert.match(engine.adapterCalls.at(-1).request.text, /Rule for old-root/)
    const reads = ledger.calls.length
    host.updateTreeAddress({ sessionId: 'rule-move', selfName: 'Worker', managerName: 'New Manager', treeKey: 'new-root',
      requestKeys: { treeAnchors: ['new-root', 'moving-node'], threadId: 'moving-node' } })
    assert.equal(ledger.calls.length, reads, 'a drag must not read the standing-rule ledgers')
    engine.calls[0].onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    await host.sendTurn({ sessionId: 'rule-move', text: 'Continue.' })
    const sent = engine.adapterCalls.at(-1).request.text
    assert.match(sent, /Rule for new-root/)
    assert.doesNotMatch(sent, /Rule for old-root/)
    assert.match(sent, /replace the previous inherited tree rules/)
    assert.deepEqual(ledger.calls.slice(reads).filter(call => call.scope === 'tree').map(call => call.key), ['new-root', 'moving-node'])
  } finally {
    await host.closeAll()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an unaccepted turn restores the move notice for retry', async () => {
  await withHost('move-notice-retry', async ({ host, engine }) => {
    await host.startSession({ sessionId: 'retry-move', treeIdentity: { selfName: 'Worker', managerName: 'Old Manager' } })
    host.updateTreeAddress({ sessionId: 'retry-move', selfName: 'Worker 2', managerName: 'New Manager', treeKey: 'new-root' })
    engine.control.holdTurns = true
    try {
      const refused = host.sendTurn({ sessionId: 'retry-move', text: 'Continue.' })
      engine.pendingTurns.shift().reject(new Error('pre-accept refusal'))
      await assert.rejects(refused, /pre-accept refusal/)
    } finally { engine.control.holdTurns = false }
    await host.sendTurn({ sessionId: 'retry-move', text: 'Retry.' })
    assert.match(engine.adapterCalls.at(-1).request.text, /Your current name is "Worker 2"/)
    assert.match(engine.adapterCalls.at(-1).request.text, /You now report to "New Manager"/)
  })
})
