import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const {
  aclInspectionIsStrict,
  claimTreeNodeCommand,
  createTreeNodeCommandRequest,
  defaultAclInspector,
  ensureTreeNodeCommandSpool,
  locateRequest,
  publishTreeNodeCommandLaunchRefusal,
  publishTreeNodeCommandResult,
  spoolRootFor,
  treeNodeCommandAdditionalData,
  treeNodeCommandRequestIdCandidateFromArgv,
  treeNodeCommandRequestIdFromAdditionalData,
  treeNodeCommandRequestIdFromArgv,
  validateTreeNodeCommandRequest,
} = require('../../shell/tree-node-command.cjs')
const { createTreeNodeCommandBroker, queueRequestOrRefuse } = require('../../shell/tree-node-command-broker.cjs')

const currentSid = 'S-1-5-21-1000'
const safeAcl = () => ({
  ok: true,
  currentSid,
  ownerIdentity: currentSid,
  writableIdentities: [currentSid, 'S-1-5-18', 'S-1-5-32-544'],
  refusedIdentities: [],
})
const noAclMutation = () => {}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const testTempRoot = path.join(repo, '.tree-node-command-test-tmp')
test.after(() => rm(testTempRoot, { recursive: true, force: true }))

async function userDataFixture(t) {
  await mkdir(testTempRoot, { recursive: true })
  const root = await mkdtemp(path.join(testTempRoot, 'fixture-'))
  const userData = path.join(root, 'ToolsEnabled')
  await mkdir(userData, { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, userData, spool: path.join(userData, 'coordinator-commands') }
}

const commandOptions = (fixture, now, extra = {}) => ({
  userDataRoot: fixture.userData,
  computerId: 'computer-1',
  treeId: 'tree-1',
  nodeId: 'node-1',
  now,
  aclInspector: safeAcl,
  aclSecurer: noAclMutation,
  ...extra,
})

test('fresh-start schema is exact and cannot carry thread, transcript, text, tier, model, or message', () => {
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const base = {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: 'tnc-00000000-0000-4000-8000-000000000000',
    action: 'fresh-start-existing-node',
    computerId: 'computer-1',
    treeId: 'tree-1',
    nodeId: 'node-1',
    createdAt: '2026-08-30T18:00:00.000Z',
    expiresAt: '2026-08-30T18:30:00.000Z',
    containsSecretMaterial: false,
  }
  assert.equal(validateTreeNodeCommandRequest(base, { now }).nodeId, 'node-1')
  for (const forbidden of ['resumeThreadId', 'transcript', 'text', 'tier', 'model', 'path', 'message']) {
    assert.throws(
      () => validateTreeNodeCommandRequest({ ...base, [forbidden]: 'forbidden' }, { now }),
      error => error.code === 'MC_TREE_COMMAND_SCHEMA_INVALID',
      forbidden,
    )
  }
})

test('send schema requires a bounded message and exact expected session', () => {
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const base = {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: 'tnc-00000000-0000-4000-8000-000000000000',
    action: 'send-to-bound-node',
    computerId: 'computer-1',
    treeId: 'tree-1',
    nodeId: 'node-1',
    expectedSessionId: 'chat-new',
    message: 'Only the reviewed clean turn.',
    createdAt: '2026-08-30T18:00:00.000Z',
    expiresAt: '2026-08-30T18:30:00.000Z',
    containsSecretMaterial: false,
  }
  assert.equal(validateTreeNodeCommandRequest(base, { now }).message, base.message)
  assert.throws(() => validateTreeNodeCommandRequest({ ...base, expectedSessionId: null }, { now }), /expected session/i)
  assert.throws(() => validateTreeNodeCommandRequest({ ...base, message: '   ' }, { now }), /message/i)
  assert.throws(() => validateTreeNodeCommandRequest({ ...base, message: `bad\0turn` }, { now }), /message/i)
  assert.throws(() => validateTreeNodeCommandRequest({ ...base, resumeThreadId: 'old' }, { now }), /unsupported field/i)
})

test('private argv is exact and refuses every extra path, message, URL, or switch', () => {
  const id = 'tnc-00000000-0000-4000-8000-000000000000'
  const exe = 'C:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe'
  const flag = `--toolsenabled-tree-command=${id}`
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, flag], { executablePath: exe }), id)
  for (const extra of ['C:\\work', '--message=secret', 'https://example.test', '--disable-gpu']) {
    assert.throws(
      () => treeNodeCommandRequestIdFromArgv([exe, flag, extra], { executablePath: exe }),
      error => error.code === 'MC_TREE_COMMAND_ARGUMENT_INVALID',
      extra,
    )
  }
  const entry = 'C:\\source\\shell\\main.cjs'
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, entry, flag], { executablePath: exe, developmentEntry: entry }), id)

  /* Measured 2026-09-02 on Electron 43.3.0: Chromium appends
     --allow-file-access-from-files to the second instance's commandLine, and
     may append --original-process-start-time=<n>. Both must be ignored; any
     other extra argument must still refuse. */
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, flag, '--allow-file-access-from-files'], { executablePath: exe }), id)
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, flag, '--original-process-start-time=13398000000'], { executablePath: exe }), id)
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, '--allow-file-access-from-files', entry, flag], { executablePath: exe, developmentEntry: entry }), id)
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, flag, '--allow-file-access-from-files', 'C:\work'], { executablePath: exe }),
    error => error.code === 'MC_TREE_COMMAND_ARGUMENT_INVALID',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, flag, '--allow-file-access-from-files-and-more'], { executablePath: exe }),
    error => error.code === 'MC_TREE_COMMAND_ARGUMENT_INVALID',
  )
  assert.deepEqual(treeNodeCommandAdditionalData(id), { treeNodeCommandRequestId: id })
  assert.equal(treeNodeCommandRequestIdFromAdditionalData({ treeNodeCommandRequestId: id }), id)
  assert.throws(
    () => treeNodeCommandRequestIdFromAdditionalData({ treeNodeCommandRequestId: id, path: 'C:\\elsewhere' }),
    error => error.code === 'MC_TREE_COMMAND_SCHEMA_INVALID',
  )
})

/* MEASURED 2026-09-03 on the owner's Live tier: nine spooled resume commands,
   nine request files under %APPDATA%\ToolsEnabled-Live\coordinator-commands\
   requests, an empty claims\ and an empty results\ -- nothing was ever
   consumed, and the caller was told ok nine times. Every argv below is the real
   one: the live tier launches the development form `electron.exe <appDirectory>
   --user-data-dir=<profile>`, so a command helper spawned beside it names the
   app by its DIRECTORY while the grammar was told the one permitted entry was
   `__filename`, the main script inside it. */
test('the development launch form the live tier actually uses is accepted, and nothing else is', () => {
  const id = 'tnc-00000000-0000-4000-8000-000000000000'
  const flag = `--toolsenabled-tree-command=${id}`
  const exe = 'C:\\WF\\deps\\app-node_modules\\electron\\dist\\electron.exe'
  const appDirectory = 'C:\\WF\\live'
  const mainScript = 'C:\\WF\\live\\shell\\main.cjs'
  const profile = 'C:\\Users\\owner\\AppData\\Roaming\\ToolsEnabled-Live'
  const development = {
    executablePath: exe,
    developmentEntry: [mainScript, appDirectory],
    developmentUserDataPath: profile,
  }

  assert.equal(treeNodeCommandRequestIdFromArgv([exe, appDirectory, flag], development), id)
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, mainScript, flag], development), id)
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, appDirectory, `--user-data-dir=${profile}`, flag], development), id)
  /* what the primary reads out of `second-instance`, injected switch and all */
  assert.equal(
    treeNodeCommandRequestIdFromArgv([exe, appDirectory, `--user-data-dir=${profile}`, flag, '--allow-file-access-from-files'], development),
    id,
  )

  const refused = error => error.code === 'MC_TREE_COMMAND_ARGUMENT_INVALID'
  /* a profile this process did not resolve, the two-token spelling, and a
     directory that is a different application all still refuse */
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, appDirectory, '--user-data-dir=C:\\Users\\owner\\AppData\\Roaming\\Somebody-Else', flag], development),
    refused,
    'a profile this process did not resolve',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, appDirectory, '--user-data-dir', profile, flag], development),
    refused,
    'the two-token profile switch',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, 'C:\\WF\\live-engine', flag], development),
    refused,
    'a different application directory',
  )
  for (const extra of ['C:\\work', '--message=secret', 'https://example.test', '--disable-gpu', flag]) {
    assert.throws(() => treeNodeCommandRequestIdFromArgv([exe, appDirectory, flag, extra], development), refused, extra)
  }

  /* A PACKAGED LAUNCH IS OFFERED NEITHER, so its grammar is exactly what it
     was: two arguments, and a profile switch or an entry path beside the
     command switch still refuses. */
  assert.equal(treeNodeCommandRequestIdFromArgv([exe, flag], { executablePath: exe }), id)
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, `--user-data-dir=${profile}`, flag], { executablePath: exe }),
    refused,
    'a profile switch in a packaged launch',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([exe, appDirectory, flag], { executablePath: exe }),
    refused,
    'an entry path in a packaged launch',
  )
})

test('a launch the grammar refuses can still name the one request it refused', () => {
  const id = 'tnc-00000000-0000-4000-8000-000000000000'
  const flag = `--toolsenabled-tree-command=${id}`
  assert.equal(treeNodeCommandRequestIdCandidateFromArgv(['exe', 'C:\\anything', flag, '--whatever']), id)
  assert.equal(treeNodeCommandRequestIdCandidateFromArgv(['exe', flag, flag]), null)
  assert.equal(treeNodeCommandRequestIdCandidateFromArgv(['exe', '--toolsenabled-tree-command=not-a-request-id']), null)
  assert.equal(treeNodeCommandRequestIdCandidateFromArgv(['exe']), null)
  assert.equal(treeNodeCommandRequestIdCandidateFromArgv(null), null)
})

/* The helper is spawned detached with stdio ignored, so a console line or a
   stderr write is not a report -- it is a silence, and a silence is what the
   nine live commands produced. The result file is the caller's only channel. */
test('a command launch that cannot run publishes an immutable refusal, and never steals a live one', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now))
  const refuse = (requestId, at, root = fixture.userData) => publishTreeNodeCommandLaunchRefusal({
    userDataRoot: root,
    requestId,
    code: 'MC_TREE_COMMAND_ARGUMENT_INVALID',
    now: at,
    aclInspector: safeAcl,
    aclSecurer: noAclMutation,
  })

  assert.equal(refuse(written.requestId, now + 1).published, true)
  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.ok, false)
  assert.equal(stored.code, 'MC_TREE_COMMAND_ARGUMENT_INVALID')
  assert.equal(stored.nodeId, 'node-1')
  assert.equal(stored.sessionId, null)
  assert.equal(stored.containsSecretMaterial, false)

  const again = refuse(written.requestId, now + 2)
  assert.equal(again.published, false)
  assert.equal(again.reason, 'already-completed')

  /* "could not look" and "not there" are different answers, so the caller gets
     the locating failure's own code rather than a bare false. */
  const missing = refuse('tnc-11111111-1111-4111-8111-111111111111', now + 3)
  assert.equal(missing.published, false)
  assert.equal(missing.reason, 'not-located')
  assert.equal(missing.locateCode, 'MC_TREE_COMMAND_PATH_UNAVAILABLE')

  /* A request a real consumer already claimed is in flight. A refusal must
     never overwrite the answer that command is about to give. */
  const busy = await userDataFixture(t)
  const live = createTreeNodeCommandRequest(commandOptions(busy, now))
  claimTreeNodeCommand(
    locateRequest({ userDataRoot: busy.userData, requestId: live.requestId, now: now + 1, aclInspector: safeAcl, aclSecurer: noAclMutation }),
    { now: now + 2, aclInspector: safeAcl },
  )
  const held = refuse(live.requestId, now + 3, busy.userData)
  assert.equal(held.published, false)
  assert.equal(held.reason, 'already-claimed')
})

/* AUDIT, WAVE 5: A REFUSAL THAT CLAIMS THE REQUEST AND THEN FAILS TO WRITE
 * ITS OWN ANSWER MUST NOT LEAVE THAT CLAIM BEHIND.
 *
 * publishTreeNodeCommandLaunchRefusal claims the request above -- "exactly
 * the way a real consumer would, so a live request can never be overwritten"
 * -- and only THEN publishes the refusal into the result file. Those are two
 * separate writes with no transaction between them. If the SECOND one throws
 * -- a transient ACL re-verification failure is the realistic case; this
 * file's own comments on runWindowsAclPass measure a powershell.exe pass
 * costing up to a few seconds under load, on a machine this project's own
 * notes already describe as unstable -- this call leaves behind exactly what
 * claimTreeNodeCommand's own contract promises never happens: a claim with no
 * result to answer it and no way to try again.
 *
 * A later attempt at this SAME request id -- a coordinator retrying the same
 * printed launch switch (tools/write-tree-node-command.mjs prints it
 * separately from the request for exactly that retry), or simply a real
 * primary instance starting once THIS refusal's own no-primary launch found
 * none -- calls claimTreeNodeCommand and gets back `state: 'claimed'`: not
 * completed, so nothing has answered it; not `claimed-now`, so nothing may
 * try again either. shell/main.cjs's loadAndClaim turns that into
 * MC_TREE_COMMAND_ALREADY_CLAIMED, and shell/tree-node-command-broker.cjs's
 * pump() drops it silently (its own comment: "the pump's own catch swallows
 * that silently ... and moves on"). The request becomes unanswerable forever
 * -- worse than the unclaimed launch failure this whole function exists to
 * report, because now even a fully healthy, later-running instance cannot
 * touch it either. */
test('a refusal whose own publish fails after claiming the request does not leave that claim behind', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')

  /* MEASURE how many aclInspector calls a real locate-then-claim consumes for
     a fresh request, against the real functions, instead of hard-coding a
     count that could silently drift out of step with the code it drives. */
  const probe = createTreeNodeCommandRequest(commandOptions(fixture, now, { nodeId: 'probe-node' }))
  let probeCalls = 0
  const countingAcl = () => { probeCalls += 1; return safeAcl() }
  const probeEnvelope = locateRequest({
    userDataRoot: fixture.userData, requestId: probe.requestId, now: now + 1, aclInspector: countingAcl, aclSecurer: noAclMutation,
  })
  claimTreeNodeCommand(probeEnvelope, { now: now + 2, aclInspector: countingAcl })
  const locateAndClaimCalls = probeCalls

  const written = createTreeNodeCommandRequest(commandOptions(fixture, now, { nodeId: 'target-node' }))
  let calls = 0
  /* Succeeds through locate and claim, exactly as many calls as the probe
     just measured, then fails -- landing squarely in the publish step that
     runs strictly after the claim has already been written. A plain throw
     from an injected inspector is exactly what assertSafeAclAll's own catch
     turns into MC_TREE_COMMAND_ACL_UNAVAILABLE, the realistic shape of a
     powershell.exe pass that could not be run at all. */
  const failsDuringPublish = () => {
    calls += 1
    if (calls > locateAndClaimCalls) throw new Error('simulated transient ACL re-verification failure')
    return safeAcl()
  }

  assert.throws(
    () => publishTreeNodeCommandLaunchRefusal({
      userDataRoot: fixture.userData,
      requestId: written.requestId,
      code: 'MC_TREE_COMMAND_ARGUMENT_INVALID',
      reason: 'grammar refused',
      now: now + 3,
      aclInspector: failsDuringPublish,
      aclSecurer: noAclMutation,
    }),
    error => error.code === 'MC_TREE_COMMAND_ACL_UNAVAILABLE',
    'the transient failure must still surface -- refuseTreeNodeCommandLaunch\'s own catch is what logs and reports it',
  )
  assert.equal(existsSync(written.resultFile), false, 'no result was ever written for this request')

  /* THE DEFECT: does the claim this failed call itself just wrote survive it?
     A later, fully healthy attempt to answer the SAME request -- exactly what
     shell/main.cjs's loadAndClaim does for a retried coordinator launch, or a
     real primary that starts once this refusal's own launch found none --
     must still be able to claim it. */
  const retryEnvelope = locateRequest({
    userDataRoot: fixture.userData, requestId: written.requestId, now: now + 100, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  const retryClaim = claimTreeNodeCommand(retryEnvelope, { now: now + 100, aclInspector: safeAcl })
  assert.equal(retryClaim.state, 'claimed-now',
    `a later, healthy attempt to claim this request must succeed once the failed refusal's own claim is rolled back; got "${retryClaim.state}" -- the request is orphaned, unanswerable by anything, forever`)
})

/* THE WHOLE CONSUMER, DRIVEN THE WAY THE LIVE TIER DRIVES IT: a request file on
   disk, the argv a helper really carries, the real locate-and-claim, the real
   broker, and a renderer answer coming back as the immutable result. No
   Electron and no restart -- this is the path that on 2026-09-03 produced nine
   request files, an empty claims\ and an empty results\. */
test('a spooled resume launched the way the live tier launches it is claimed, delivered, and answered', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now))
  assert.equal(written.launchArgument, `--toolsenabled-tree-command=${written.requestId}`)

  const exe = 'C:\\WF\\deps\\app-node_modules\\electron\\dist\\electron.exe'
  const appDirectory = 'C:\\WF\\live'
  const requestId = treeNodeCommandRequestIdFromArgv(
    [exe, appDirectory, `--user-data-dir=${fixture.userData}`, written.launchArgument],
    {
      executablePath: exe,
      developmentEntry: [path.join(appDirectory, 'shell', 'main.cjs'), appDirectory],
      developmentUserDataPath: fixture.userData,
    },
  )
  assert.equal(requestId, written.requestId)

  let announce = null
  const firstDelivery = new Promise(resolve => { announce = resolve })
  const broker = createTreeNodeCommandBroker({
    // The real broker and spool must observe the same fixed fixture time.
    now: () => now + 2,
    loadAndClaim: id => {
      const envelope = locateRequest({
        userDataRoot: fixture.userData, requestId: id, now: now + 1, aclInspector: safeAcl, aclSecurer: noAclMutation,
      })
      assert.equal(claimTreeNodeCommand(envelope, { now: now + 2, aclInspector: safeAcl }).state, 'claimed-now')
      return envelope
    },
    publishResult: (envelope, result) => publishTreeNodeCommandResult(envelope, result, { now: now + 4, aclInspector: safeAcl }),
    sendToRenderer: request => { announce(request) },
  })
  t.after(() => broker.dispose())
  broker.setRendererReady(true)
  assert.equal(broker.queueRequest(requestId), true)

  const delivered = await firstDelivery
  assert.equal(delivered.action, 'fresh-start-existing-node')
  assert.equal(delivered.nodeId, 'node-1')
  assert.equal(delivered.computerId, 'computer-1')

  /* the renderer's answer: the circle started and the new session is bound */
  const settled = await broker.complete({
    requestId, ok: true, code: null, nodeId: 'node-1', sessionId: 'chat-new', threadId: 'thread-new',
  })
  assert.equal(settled.ok, true)
  assert.equal(settled.result, 'completed')
  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.ok, true)
  assert.equal(stored.code, null)
  assert.equal(stored.sessionId, 'chat-new')
})

/* THE SECOND CALLER. AUDIT, WAVE 4.
 *
 * tools/write-tree-node-command.mjs prints a request's launch switch
 * separately from writing it, precisely so a coordinator can hand that same
 * switch to the executable more than once (a retry after an uncertain first
 * launch, a supervised process restarting a launcher) without writing a new
 * request. Two launches of the same switch, while the primary instance is
 * already running, are two shell/main.cjs handleSecondInstance calls for the
 * exact same requestId.
 *
 * The previous wave's fix (9901ba7) made the second of those calls write an
 * immutable MC_TREE_COMMAND_REQUEST_REFUSED result whenever
 * broker.queueRequest() answered false -- which it does both when the broker
 * is disposed AND when this process already queued the id. The disposed case
 * is right. The duplicate case is not: the FIRST call already queued the
 * request, and it is going to be claimed and answered by this SAME process's
 * own pump() once the renderer is ready -- but that claim is a FILE WRITE
 * (claimTreeNodeCommand) that only happens once pump() actually dequeues the
 * id. Until then the request holds no claim file at all, so a refusal
 * written for the "duplicate" claims that disk slot FIRST and wins: pump()
 * later finds the id already completed, throws, and its own catch swallows
 * that silently (shell/tree-node-command-broker.cjs pump: "continue"). The
 * request that was actually queued first is dropped without ever reaching
 * sendToRenderer, and the immutable answer left behind says REFUSED for a
 * command that was still live.
 *
 * This drives that exact sequence against the real claim/publish functions
 * above -- not a stub -- the same way "a spooled resume launched the way the
 * live tier launches it" above it does. */
test('a duplicate second-instance wake for an already-queued request must not steal its claim out from under it', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now))

  const sent = []
  const broker = createTreeNodeCommandBroker({
    // The real broker and spool must observe the same fixed fixture time.
    now: () => now + 2,
    loadAndClaim: id => {
      const envelope = locateRequest({
        userDataRoot: fixture.userData, requestId: id, now: now + 1, aclInspector: safeAcl, aclSecurer: noAclMutation,
      })
      const claim = claimTreeNodeCommand(envelope, { now: now + 2, aclInspector: safeAcl })
      if (claim.state !== 'claimed-now') {
        const error = new Error('Tree-node command was already consumed.')
        error.code = claim.state === 'completed' ? 'MC_TREE_COMMAND_ALREADY_COMPLETED' : 'MC_TREE_COMMAND_ALREADY_CLAIMED'
        throw error
      }
      return envelope
    },
    publishResult: (envelope, result) => publishTreeNodeCommandResult(envelope, result, { now: now + 4, aclInspector: safeAcl }),
    sendToRenderer: request => { sent.push(request.requestId) },
  })
  t.after(() => broker.dispose())

  const refuseVia = refusals => (code, reason) => {
    refusals.push([code, reason])
    publishTreeNodeCommandLaunchRefusal({
      userDataRoot: fixture.userData, requestId: written.requestId, code, reason, now: now + 3, aclInspector: safeAcl, aclSecurer: noAclMutation,
    })
  }

  /* FIRST caller: the primary handoff. The renderer is not ready yet -- the
     exact window shell/main.cjs is in immediately after launch, before the
     Computers page has mounted -- so it is accepted into the queue but not
     yet claimed on disk. */
  const refusals1 = []
  assert.equal(queueRequestOrRefuse(broker, written.requestId, refuseVia(refusals1)), true)
  assert.deepEqual(refusals1, [])

  /* SECOND caller: the SAME requestId, handed off again before the first was
     ever claimed on disk -- e.g. a coordinator retrying the printed launch
     switch because it had not yet seen a result. */
  const refusals2 = []
  const queuedTwice = queueRequestOrRefuse(broker, written.requestId, refuseVia(refusals2))
  assert.equal(queuedTwice, false, 'the broker must not queue the same request id twice')
  assert.deepEqual(refusals2, [], 'a duplicate of a request this process already accepted must not write a competing refusal -- the original will answer it')

  /* NOW the Computers page mounts and the renderer becomes ready. */
  broker.setRendererReady(true)
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent, [written.requestId], 'the request accepted into the queue first must still be delivered -- a duplicate wake must not silently cancel it')

  const settled = await broker.complete({
    requestId: written.requestId, ok: true, code: null, nodeId: 'node-1', sessionId: 'chat-real', threadId: 'thread-real',
  })
  assert.equal(settled.ok, true)
  assert.equal(settled.result, 'completed')

  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.ok, true, 'the request that was actually queued first must complete successfully, not be replaced by the duplicate wake\'s refusal')
  assert.equal(stored.sessionId, 'chat-real')
  assert.notEqual(stored.code, 'MC_TREE_COMMAND_REQUEST_REFUSED')
})

test('missing or blank userData is refused instead of falling through to cwd', () => {
  for (const userDataRoot of [undefined, null, '', '   ', '.']) {
    assert.throws(
      () => ensureTreeNodeCommandSpool({ userDataRoot, aclInspector: safeAcl, aclSecurer: noAclMutation }),
      error => error.code === 'MC_TREE_COMMAND_USER_DATA_UNAVAILABLE',
    )
  }
})

test('strict ACL result accepts only current SID, SYSTEM, and Administrators', () => {
  const base = {
    ok: true,
    currentSid,
    ownerIdentity: currentSid,
    writableIdentities: [currentSid, 'S-1-5-18', 'S-1-5-32-544'],
    refusedIdentities: [],
  }
  assert.equal(aclInspectionIsStrict(base), true)
  for (const identity of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-21-FOREIGN', 'UNRESOLVED:SomeGroup']) {
    assert.equal(aclInspectionIsStrict({ ...base, writableIdentities: [...base.writableIdentities, identity] }), false, identity)
  }
  assert.equal(aclInspectionIsStrict({ ...base, ownerIdentity: 'S-1-5-21-FOREIGN' }), false)
  assert.equal(aclInspectionIsStrict({ ...base, refusedIdentities: ['S-1-5-21-FOREIGN'] }), false)
})

test('default Windows spool creation installs and verifies the exact private ACL', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await userDataFixture(t)
  const layout = ensureTreeNodeCommandSpool({ userDataRoot: fixture.userData })
  assert.equal(layout.spoolRoot, fixture.spool)
  assert.equal(aclInspectionIsStrict(defaultAclInspector(layout.spoolRoot)), true)
  for (const directory of [layout.requests, layout.claims, layout.results]) {
    assert.equal(aclInspectionIsStrict(defaultAclInspector(directory)), true)
  }
})

test('writer CLI reads a send message from stdin and never echoes it into argv metadata', async (t) => {
  const fixture = await userDataFixture(t)
  const message = 'Reviewed only through standard input.'
  const answer = spawnSync(process.execPath, [
    path.join(repo, 'tools', 'write-tree-node-command.mjs'),
    '--user-data-root', fixture.userData,
    '--action', 'send-to-bound-node',
    '--computer-id', 'computer-1',
    '--tree-id', 'tree-1',
    '--node-id', 'node-1',
    '--expected-session-id', 'chat-new',
  ], {
    cwd: repo,
    input: message,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  assert.equal(answer.status, 0, answer.stderr)
  const output = JSON.parse(answer.stdout)
  assert.equal(output.launchArgument.includes(message), false)
  assert.equal(answer.stderr.includes(message), false)
  assert.equal(JSON.parse(await readFile(output.requestFile, 'utf8')).message, message)
})

test('writer, reader, claim, and immutable result form one app-userData chain', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now, { expectedSessionId: 'chat-old' }))
  assert.equal(written.spoolRoot, spoolRootFor(fixture.userData))
  assert.equal(written.requestFile.startsWith(fixture.spool), true)
  assert.equal(written.requestFile.includes('AGENT-SUPPORT-CHANNEL'), false)

  const envelope = locateRequest({
    userDataRoot: fixture.userData,
    requestId: written.requestId,
    now: now + 1,
    aclInspector: safeAcl,
    aclSecurer: noAclMutation,
  })
  assert.equal(envelope.request.expectedSessionId, 'chat-old')
  assert.equal(claimTreeNodeCommand(envelope, { now: now + 2, aclInspector: safeAcl }).state, 'claimed-now')
  assert.equal(claimTreeNodeCommand(envelope, { now: now + 3, aclInspector: safeAcl }).state, 'claimed')

  const rendererResult = {
    requestId: written.requestId,
    ok: true,
    code: null,
    nodeId: 'node-1',
    sessionId: 'chat-new',
    threadId: 'thread-new',
  }
  const [first, identical] = await Promise.all([
    Promise.resolve().then(() => publishTreeNodeCommandResult(envelope, rendererResult, { now: now + 4, aclInspector: safeAcl })),
    Promise.resolve().then(() => publishTreeNodeCommandResult(envelope, rendererResult, { now: now + 4, aclInspector: safeAcl })),
  ])
  assert.deepEqual(identical, first)
  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.requestDigest, envelope.requestDigest)
  assert.equal(stored.computerId, 'computer-1')
  assert.equal(stored.treeId, 'tree-1')
  assert.equal(stored.containsSecretMaterial, false)
  assert.deepEqual(Object.keys(stored).sort(), [
    'action', 'code', 'completedAt', 'computerId', 'containsSecretMaterial', 'nodeId',
    'ok', 'protocol', 'requestDigest', 'requestId', 'schemaVersion', 'sessionId',
    'threadId', 'treeId',
  ].sort())
})

/* THE RACE ABOVE ONLY EVER SENT A SUCCESS, WHICH CARRIES NO `reason`. A
 * refusal's reason rides into the stored file through the same
 * normalizeRendererResult/publishTreeNodeCommandResult path a success does,
 * and storedResultMatches -- the gate a second, racing completion for the
 * same claimed request runs into -- compares `reason` as one of
 * RESULT_OPTIONAL_KEYS rather than one of the required RESULT_KEYS. Nothing
 * above exercises that comparison with a refusal at all: a second caller
 * that echoes the SAME reason must see the first caller's own answer, not a
 * conflict, and a second caller with a DIFFERENT reason for the same code
 * must still be refused, not silently overwrite -- or, just as bad, silently
 * lose -- whichever reason happened to win the race. */
test('a second caller racing a refusal must agree on the reason, or conflict; the loser never overwrites the file', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now))
  const envelope = locateRequest({
    userDataRoot: fixture.userData, requestId: written.requestId, now: now + 1, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  assert.equal(claimTreeNodeCommand(envelope, { now: now + 2, aclInspector: safeAcl }).state, 'claimed-now')

  const refusal = {
    requestId: written.requestId, ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-1', sessionId: null, threadId: null,
    reason: 'The store said no.',
  }
  const [first, echoed] = await Promise.all([
    Promise.resolve().then(() => publishTreeNodeCommandResult(envelope, refusal, { now: now + 3, aclInspector: safeAcl })),
    Promise.resolve().then(() => publishTreeNodeCommandResult(envelope, refusal, { now: now + 3, aclInspector: safeAcl })),
  ])
  assert.equal(first.reason, 'The store said no.')
  assert.deepEqual(echoed, first, 'the same reason, raced, is one winner read back twice')

  assert.throws(() => publishTreeNodeCommandResult(envelope, {
    ...refusal, reason: 'A different explanation for the same code.',
  }, { now: now + 3, aclInspector: safeAcl }), error => error.code === 'MC_TREE_COMMAND_RESULT_CONFLICT')
  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.reason, 'The store said no.', 'the losing reason never overwrites the winner already on disk')
})

test('send request contains message only in protected request; result never repeats it', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const message = 'Sanitized coordinator turn.'
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now, {
    action: 'send-to-bound-node',
    expectedSessionId: 'chat-new',
    message,
  }))
  assert.equal(written.launchArgument.includes(message), false)
  const request = JSON.parse(await readFile(written.requestFile, 'utf8'))
  assert.equal(request.message, message)
  const envelope = locateRequest({
    userDataRoot: fixture.userData,
    requestId: written.requestId,
    now: now + 1,
    aclInspector: safeAcl,
    aclSecurer: noAclMutation,
  })
  claimTreeNodeCommand(envelope, { now: now + 2, aclInspector: safeAcl })
  const stored = publishTreeNodeCommandResult(envelope, {
    requestId: written.requestId,
    ok: true,
    code: null,
    nodeId: 'node-1',
    sessionId: 'chat-new',
    threadId: 'thread-new',
  }, { now: now + 3, aclInspector: safeAcl })
  assert.equal(JSON.stringify(stored).includes(message), false)
  assert.equal(Object.hasOwn(stored, 'message'), false)
})

test('a foreign writable ACL is refused before request publication', async (t) => {
  const fixture = await userDataFixture(t)
  assert.throws(() => createTreeNodeCommandRequest(commandOptions(fixture, Date.parse('2026-08-30T18:00:00.000Z'), {
    aclInspector: () => ({
      ok: true,
      currentSid,
      ownerIdentity: currentSid,
      writableIdentities: [currentSid, 'S-1-5-21-FOREIGN'],
      refusedIdentities: [],
    }),
  })), error => error.code === 'MC_TREE_COMMAND_ACL_REFUSED')
})

test('reader refuses a reparse point below the fixed userData spool', async (t) => {
  const fixture = await userDataFixture(t)
  const outside = path.join(fixture.root, 'outside')
  await mkdir(outside)
  await mkdir(fixture.spool)
  try {
    await symlink(outside, path.join(fixture.spool, 'requests'), 'junction')
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'UNKNOWN')) {
      t.skip('creating a junction requires a privilege this test process does not have')
      return
    }
    throw error
  }
  assert.throws(() => locateRequest({
    userDataRoot: fixture.userData,
    requestId: 'tnc-00000000-0000-4000-8000-000000000000',
    now: Date.parse('2026-08-30T18:00:01.000Z'),
    aclInspector: safeAcl,
    aclSecurer: noAclMutation,
  }), error => error.code === 'MC_TREE_COMMAND_REPARSE_POINT_REFUSED')
})

test('an existing result with extra fields or changed envelope identity conflicts', async (t) => {
  const fixture = await userDataFixture(t)
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const written = createTreeNodeCommandRequest(commandOptions(fixture, now))
  const envelope = locateRequest({
    userDataRoot: fixture.userData,
    requestId: written.requestId,
    now: now + 1,
    aclInspector: safeAcl,
    aclSecurer: noAclMutation,
  })
  await writeFile(written.resultFile, `${JSON.stringify({
    protocol: 'toolsenabled.tree-node-command', schemaVersion: 1,
    requestId: written.requestId, requestDigest: envelope.requestDigest,
    action: 'fresh-start-existing-node', ok: true, code: null,
    computerId: 'different-computer', treeId: 'tree-1', nodeId: 'node-1',
    sessionId: 'chat-new', threadId: null,
    completedAt: new Date(now + 2).toISOString(), containsSecretMaterial: false,
    extra: 'not allowed',
  })}\n`)
  assert.throws(() => publishTreeNodeCommandResult(envelope, {
    requestId: written.requestId, ok: true, code: null, nodeId: 'node-1',
    sessionId: 'chat-new', threadId: null,
  }, { now: now + 2, aclInspector: safeAcl }), error => error.code === 'MC_TREE_COMMAND_RESULT_CONFLICT')
})

/* THE REAL ACL, NOT A DOUBLE. The four tests below run the shipped securer and
 * inspector against real Windows ACLs, because the thing worth protecting is
 * that folding the checks into one interpreter start did not change which
 * paths are refused, which refusal each one gets, or the order they fire in.
 * A double cannot show that: it is the batching itself that is under test. */

const icaclsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
const realSpoolOptions = fixture => ({
  userDataRoot: fixture.userData, computerId: 'computer-1', treeId: 'tree-1', nodeId: 'node-1',
})

test('a writable identity outside the account, SYSTEM and Administrators is still refused on the request file', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await userDataFixture(t)
  const written = createTreeNodeCommandRequest(realSpoolOptions(fixture))
  /* Clean first: the file inherits only the spool's protected ACL, so the
     folded verdict has to accept it. */
  assert.equal(locateRequest({ userDataRoot: fixture.userData, requestId: written.requestId }).request.nodeId, 'node-1')

  /* BUILTIN\Users (S-1-5-32-545) is none of the three allowed identities, and
     granting it Modify needs no privilege: this account owns the file. */
  const granted = spawnSync(icaclsPath, [written.requestFile, '/grant', '*S-1-5-32-545:(M)'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  assert.equal(granted.status, 0, granted.stderr)

  assert.throws(
    () => locateRequest({ userDataRoot: fixture.userData, requestId: written.requestId }),
    error => error.code === 'MC_TREE_COMMAND_ACL_REFUSED',
  )
})

test('a request id with no file on disk is unavailable, never relabelled an ACL failure', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await userDataFixture(t)
  ensureTreeNodeCommandSpool({ userDataRoot: fixture.userData })
  /* The request file's ACL is now read in the same pass that verifies the
     directories, which is BEFORE the reparse-point walk that owns this path.
     "could not look" must not overtake "not there". */
  assert.throws(
    () => locateRequest({ userDataRoot: fixture.userData, requestId: 'tnc-00000000-0000-4000-8000-0000000000ff' }),
    error => error.code === 'MC_TREE_COMMAND_PATH_UNAVAILABLE',
  )
})

test('a request file that is a link keeps its reparse refusal ahead of the folded ACL read', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await userDataFixture(t)
  const layout = ensureTreeNodeCommandSpool({ userDataRoot: fixture.userData })
  const requestId = 'tnc-00000000-0000-4000-8000-0000000000aa'
  const link = path.join(layout.requests, `${requestId}.request.json`)
  try {
    /* Dangling on purpose. MEASURED 2026-09-03: Get-Acl reads the reparse
       point itself and does NOT fail here, so this test pins the ORDER -- the
       walk's refusal still beats a verdict that is now fetched before it --
       and not the pass's tolerance for a path it cannot read. The request id
       with no file on disk, above, is what pins that. */
    await symlink(path.join(fixture.root, 'no-such-target.json'), link, 'file')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'UNKNOWN') {
      t.skip('creating a symbolic link requires a privilege this test process does not have')
      return
    }
    throw error
  }
  assert.throws(
    () => locateRequest({ userDataRoot: fixture.userData, requestId }),
    error => error.code === 'MC_TREE_COMMAND_REPARSE_POINT_REFUSED',
  )
})

/* THE BUDGET.
 *
 * MEASURED 2026-09-03: an off-process dispatch used to start six powershell.exe
 * processes and spend 3.4 s inside them, four of those starts (2.4 s) BEFORE
 * the renderer is asked to start the node -- synchronously, in the Electron
 * main process, where the owner host lives, so every session stopped for it.
 * A start costs 200-240 ms even doing nothing, and the ACL work itself is
 * unmeasurable next to it, so the count IS the cost and the count is what this
 * asserts. The dispatch runs in a child process because that is the shape
 * production has: the process that dispatches a command never wrote it, so it
 * cannot inherit a warm verdict for the spool. */
test('one off-process dispatch stays inside its interpreter budget', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await userDataFixture(t)
  const written = createTreeNodeCommandRequest(realSpoolOptions(fixture))
  const counter = path.join(fixture.root, 'count-interpreter-starts.cjs')
  await writeFile(counter, [
    "const cp = require('node:child_process')",
    'let starts = 0',
    'const real = cp.spawnSync',
    'cp.spawnSync = function counted(file, args, options) { starts += 1; return real.call(cp, file, args, options) }',
    'const [modulePath, userDataRoot, requestId] = process.argv.slice(2)',
    'const mod = require(modulePath)',
    'const envelope = mod.locateRequest({ userDataRoot, requestId })',
    'mod.claimTreeNodeCommand(envelope)',
    'const beforeRenderer = starts',
    "mod.publishTreeNodeCommandResult(envelope, { requestId, ok: true, code: null, nodeId: 'node-1', sessionId: 'session-1', threadId: null })",
    'process.stdout.write(JSON.stringify({ starts, beforeRenderer }))',
    '',
  ].join('\n'), 'utf8')

  const answer = spawnSync(process.execPath, [
    counter, path.join(repo, 'shell', 'tree-node-command.cjs'), fixture.userData, written.requestId,
  ], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(answer.status, 0, answer.stderr)
  const counted = JSON.parse(answer.stdout)

  /* Three: one pass that secures and verifies the four directories and the
     request file together, one for the claim file, one for the result file.
     The last two inspect a file that does not exist until the moment before,
     so they cannot join an earlier pass. */
  assert.ok(counted.starts <= 3, `dispatch started ${counted.starts} interpreters, budget is 3`)
  /* Two of those land before the renderer is asked, which is the part the
     owner watches the application freeze for. */
  assert.ok(counted.beforeRenderer <= 2, `dispatch started ${counted.beforeRenderer} interpreters before the renderer, budget is 2`)
})
