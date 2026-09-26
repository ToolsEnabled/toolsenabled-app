import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  ARG_PREFIX,
  CHROMIUM_INJECTED_SWITCHES,
  claimTreeNodeCommand,
  createTreeNodeCommandRequest,
  locateRequest,
  publishTreeNodeCommandLaunchRefusal,
  treeNodeCommandLaunchArgv,
  treeNodeCommandRequestIdFromArgv,
} = require('../../shell/tree-node-command.cjs')
const { OUTSIDE_CONTROL_SWITCHES } = require('../../shell/outside-control.cjs')

/* THE HAND-OFF, DRIVEN WITH THE ARGV ELECTRON REALLY RELAYS.
 *
 * MEASURED on a development instance: the Controller circle asked for
 * agent.restart of node-5 on tree-1; the request was spooled to
 * %APPDATA%\ToolsEnabled-<tier>\coordinator-commands\requests, a claim was
 * written about a second later, and the result came back
 *   {"ok":false,"code":"MC_TREE_COMMAND_ARGUMENT_INVALID","sessionId":null}
 * with no reason.
 *
 * MEASURED 2026-09-04 on Electron 43.3.0 (Windows), with a probe app launched
 * exactly the way Start-ToolsEnabled-Live.cmd launches the Live tier
 * (`electron.exe <appDir> --user-data-dir=<profile>`) and a helper launched
 * beside it as `electron.exe <appDir> --user-data-dir=<profile>
 * --toolsenabled-tree-command=<id>`:
 *
 *   helper's own process.argv
 *     [exe, <appDir>, --user-data-dir=<profile>, --toolsenabled-tree-command=<id>]
 *   primary's `second-instance` argv for that same helper
 *     [exe, --user-data-dir=<profile>, --toolsenabled-tree-command=<id>,
 *      --allow-file-access-from-files, <every switch the helper appended to
 *      its own command line before the lock>, <appDir>]
 *
 * Chromium's CommandLine keeps switches ahead of positional arguments and
 * serialises them that way for the single-instance notification, so the
 * primary sees the application directory LAST. The grammar compared the
 * relayed argv to the launcher's order, slot by slot, and refused at index 1.
 *
 * The identity below is the one shell/main.cjs treeNodeCommandLaunchIdentity()
 * computes for a non-packaged Live launch: the electron executable, both
 * spellings of the application (main script and app directory), the profile
 * from --user-data-dir, and the switches shell/main.cjs itself appends before
 * the lock (startOutsideControl at module scope). */
const id = 'tnc-00000000-0000-4000-8000-000000000005'
const flag = `${ARG_PREFIX}${id}`
// Synthetic Windows account home, assembled at runtime so the source carries no literal user path.
const ownerHome = ['C:', 'Users', 'owner'].join('\\')
const exe = `${ownerHome}\\src\\deps\\app-node_modules\\electron\\dist\\electron.exe`
const appDir = `${ownerHome}\\src\\live`
const mainScript = path.join(appDir, 'shell', 'main.cjs')
const profile = `${ownerHome}\\AppData\\Roaming\\ToolsEnabled-Live`
const liveIdentity = Object.freeze({
  executablePath: exe,
  developmentEntry: [mainScript, appDir],
  developmentUserDataPath: profile,
  appendedSwitches: OUTSIDE_CONTROL_SWITCHES,
})
const liveAppended = ['--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1']
const refused = error => error.code === 'MC_TREE_COMMAND_ARGUMENT_INVALID'

/* What the primary receives for a launcher argv: switches first, in launch
   order, then what Chromium and the app appended, then the positional
   arguments. This mirrors the 2026-09-04 measurement above exactly. */
function relayedByChromium(launchArgv, appended = []) {
  const [program, ...rest] = launchArgv
  const switches = rest.filter(value => value.startsWith('--'))
  const positional = rest.filter(value => !value.startsWith('--'))
  return [program, ...switches, '--allow-file-access-from-files', ...appended, ...positional]
}

test('the Live hand-off measured on 2026-09-04 is accepted at both ends', () => {
  const helperProcessArgv = [exe, appDir, `--user-data-dir=${profile}`, flag]
  assert.equal(treeNodeCommandRequestIdFromArgv(helperProcessArgv, liveIdentity), id, 'helper module scope')

  /* pure Chromium relay: the reorder alone was enough to refuse */
  const relayed = [exe, `--user-data-dir=${profile}`, flag, '--allow-file-access-from-files', appDir]
  assert.equal(treeNodeCommandRequestIdFromArgv(relayed, liveIdentity), id, 'primary second-instance, Chromium reorder')

  /* the Live tier's own appended switches ride along too (main.cjs:384) */
  const relayedLive = [exe, `--user-data-dir=${profile}`, flag, '--allow-file-access-from-files', ...liveAppended, appDir]
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedLive, liveIdentity), id, 'primary second-instance, Live tier')

  /* A real private Electron 43.3.0/Xvfb hand-off measured on 2026-09-23
     inserted this exact backend token even though the helper did not pass it. */
  const linuxExe = '/opt/toolsenabled/electron'
  const linuxApp = '/opt/toolsenabled/app'
  const linuxProfile = '/home/tester/.config/private-tree-probe'
  const linuxIdentity = { executablePath: linuxExe, developmentEntry: linuxApp, developmentUserDataPath: linuxProfile, appendedSwitches: ['--ozone-platform=x11'] }
  const linuxRelay = [linuxExe, `--user-data-dir=${linuxProfile}`, flag, '--allow-file-access-from-files', '--ozone-platform=x11', linuxApp]
  assert.equal(treeNodeCommandRequestIdFromArgv(linuxRelay, linuxIdentity), id, 'primary second-instance, measured Linux/X11 token')
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv([linuxExe, linuxApp, `--user-data-dir=${linuxProfile}`, flag, '--ozone-platform=x11'], { ...linuxIdentity, appendedSwitches: [] }),
    refused,
    'the helper launch must not accept the relayed-only Linux/X11 token',
  )
})

test('the launcher builds the argv from the same shape the validator parses, at both ends, for both launch forms', () => {
  const built = treeNodeCommandLaunchArgv({ executablePath: exe, developmentEntry: appDir, developmentUserDataPath: profile, requestId: id })
  assert.deepEqual(built, [exe, appDir, `--user-data-dir=${profile}`, flag], 'the documented development launch form')
  assert.equal(treeNodeCommandRequestIdFromArgv(built, liveIdentity), id)
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(built, liveAppended), liveIdentity), id)

  const noProfile = treeNodeCommandLaunchArgv({ executablePath: exe, developmentEntry: appDir, requestId: id })
  assert.deepEqual(noProfile, [exe, appDir, flag])
  const defaultProfileIdentity = { ...liveIdentity, developmentUserDataPath: null }
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(noProfile, liveAppended), defaultProfileIdentity), id)

  const packaged = treeNodeCommandLaunchArgv({ executablePath: exe, requestId: id })
  assert.deepEqual(packaged, [exe, flag])
  const packagedIdentity = { executablePath: exe, appendedSwitches: OUTSIDE_CONTROL_SWITCHES }
  assert.equal(treeNodeCommandRequestIdFromArgv(packaged, packagedIdentity), id)
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(packaged, liveAppended), packagedIdentity), id)
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(packaged, ['--original-process-start-time=13398000000']), packagedIdentity), id)
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(packaged, ['--ozone-platform=x11']), { ...packagedIdentity, appendedSwitches: [...OUTSIDE_CONTROL_SWITCHES, '--ozone-platform=x11'] }), id)
  assert.ok(CHROMIUM_INJECTED_SWITCHES.includes('--original-process-start-time'))

  for (const bad of [
    { executablePath: exe, developmentEntry: [mainScript, appDir], requestId: id },
    { executablePath: exe, developmentUserDataPath: profile, requestId: id },
    { executablePath: exe, developmentEntry: appDir, requestId: 'not-a-request-id' },
    { developmentEntry: appDir, requestId: id },
  ]) {
    assert.throws(() => treeNodeCommandLaunchArgv(bad), error => /^MC_TREE_COMMAND_/.test(error.code), JSON.stringify(bad))
  }
})

test('the relayed form admits exactly the launcher tokens: strays, duplicates, other profiles, and foreign switches still refuse', () => {
  const built = treeNodeCommandLaunchArgv({ executablePath: exe, developmentEntry: appDir, developmentUserDataPath: profile, requestId: id })
  for (const stray of ['C:\\work', '--message=secret', 'https://example.test', '--disable-gpu', flag, appDir, `--user-data-dir=${profile}`]) {
    assert.throws(() => treeNodeCommandRequestIdFromArgv(relayedByChromium([...built, stray], liveAppended), liveIdentity), refused, stray)
  }
  for (const platform of ['--ozone-platform', '--ozone-platform=', '--ozone-platform=wayland', '--ozone-platform=headless', '--ozone-platform=x11=extra', '--ozone-platform=x11 --disable-gpu', '--ozone-platform-hint=x11']) {
    assert.throws(() => treeNodeCommandRequestIdFromArgv(relayedByChromium(built, [...liveAppended, platform]), liveIdentity), refused, platform)
  }
  assert.throws(() => treeNodeCommandRequestIdFromArgv(relayedByChromium(built, ['--ozone-platform=x11', '--ozone-platform=x11']), liveIdentity), refused, 'duplicate injected platform token')
  assert.throws(() => treeNodeCommandRequestIdFromArgv(relayedByChromium(built, ['--ozone-platform=x11', '--ozone-platform=wayland']), liveIdentity), refused, 'conflicting platform token')
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv(relayedByChromium([exe, appDir, `--user-data-dir=${ownerHome}\\AppData\\Roaming\\Somebody-Else`, flag]), liveIdentity),
    refused, 'another profile',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv(relayedByChromium([exe, `${ownerHome}\\src\\live-engine`, flag]), liveIdentity),
    refused, 'another application',
  )
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv(relayedByChromium([exe, `--user-data-dir=${profile}`, flag]), { ...liveIdentity, developmentEntry: null }),
    refused, 'a profile switch and no entry in a packaged launch',
  )
  /* an appended switch is forgiven only when the identity names it */
  assert.throws(
    () => treeNodeCommandRequestIdFromArgv(relayedByChromium(built, liveAppended), { ...liveIdentity, appendedSwitches: [] }),
    refused, 'an appended switch the identity does not name',
  )
  /* the executable is never order-free: Chromium keeps the program first */
  assert.throws(() => treeNodeCommandRequestIdFromArgv([appDir, exe, flag], liveIdentity), refused, 'program not first')
})

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const testTempRoot = path.join(repo, '.tree-node-command-handoff-test-tmp')
test.after(() => rm(testTempRoot, { recursive: true, force: true }))
const currentSid = 'S-1-5-21-1000'
const safeAcl = () => ({ ok: true, currentSid, ownerIdentity: currentSid, writableIdentities: [currentSid, 'S-1-5-18', 'S-1-5-32-544'], refusedIdentities: [] })
const noAclMutation = () => {}

test('a refused hand-off writes its reason beside the code, so the spool alone says what happened', async (t) => {
  await mkdir(testTempRoot, { recursive: true })
  const root = await mkdtemp(path.join(testTempRoot, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userData = path.join(root, 'ToolsEnabled-Live')
  await mkdir(userData, { mode: 0o700 })
  const now = Date.parse('2026-09-04T12:00:00.000Z')
  const written = createTreeNodeCommandRequest({
    userDataRoot: userData, computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-5', now, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })

  /* the sentence the grammar produces for a stray token names the token's
     place and its switch name, never a switch value */
  let grammarError = null
  try {
    treeNodeCommandRequestIdFromArgv(relayedByChromium([exe, appDir, `--user-data-dir=${profile}`, written.launchArgument, '--message=secret'], liveAppended), liveIdentity)
  } catch (error) { grammarError = error }
  assert.equal(grammarError?.code, 'MC_TREE_COMMAND_ARGUMENT_INVALID')
  assert.match(grammarError.message, /--message/)
  assert.doesNotMatch(grammarError.message, /secret/)

  const published = publishTreeNodeCommandLaunchRefusal({
    userDataRoot: userData, requestId: written.requestId, code: grammarError.code, reason: grammarError.message, now: now + 1400, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  assert.equal(published.published, true)
  const stored = JSON.parse(await readFile(written.resultFile, 'utf8'))
  assert.equal(stored.ok, false)
  assert.equal(stored.code, 'MC_TREE_COMMAND_ARGUMENT_INVALID')
  assert.equal(stored.reason, grammarError.message)
  assert.equal(stored.sessionId, null)
  assert.equal(stored.containsSecretMaterial, false)

  /* the stored result with its reason is still a valid, immutable answer */
  const envelope = locateRequest({ userDataRoot: userData, requestId: written.requestId, now: now + 2000, aclInspector: safeAcl, aclSecurer: noAclMutation })
  assert.equal(claimTreeNodeCommand(envelope, { now: now + 2000, aclInspector: safeAcl }).state, 'completed')
  const again = publishTreeNodeCommandLaunchRefusal({
    userDataRoot: userData, requestId: written.requestId, code: 'MC_TREE_COMMAND_ARGUMENT_INVALID', reason: 'a different sentence', now: now + 3000, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  assert.equal(again.published, false)
  assert.equal(again.reason, 'already-completed')

  /* a reason is a bounded single sentence; a multi-line or oversized one is
     cut down rather than refused, because a refusal that cannot be written
     is the silence this exists to end */
  const second = createTreeNodeCommandRequest({
    userDataRoot: userData, computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-6', now, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  publishTreeNodeCommandLaunchRefusal({
    userDataRoot: userData, requestId: second.requestId, code: 'MC_TREE_COMMAND_PRIMARY_INSTANCE_REQUIRED', reason: `line one\nline two ${'x'.repeat(2000)}`, now: now + 1, aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  const storedSecond = JSON.parse(await readFile(second.resultFile, 'utf8'))
  assert.doesNotMatch(storedSecond.reason, /\n/)
  assert.ok(storedSecond.reason.length <= 512)
  assert.match(storedSecond.reason, /^line one line two/)
})

/* THE LAUNCHER A COORDINATOR RUNS. It spools the request and starts the
   helper with the argv the shell builds, so what is spawned is by construction
   what the running application admits -- at the helper's own module scope and
   after Chromium has relayed it to the primary. */
test('tools/launch-tree-node-command.mjs spawns exactly the shape the validator parses, detached and silent', async (t) => {
  const { launchTreeNodeCommand } = await import('../launch-tree-node-command.mjs')
  await mkdir(testTempRoot, { recursive: true })
  const root = await mkdtemp(path.join(testTempRoot, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userData = path.join(root, 'ToolsEnabled-Live')
  await mkdir(userData, { mode: 0o700 })

  const spawned = []
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return { pid: 4242, unref() {} } }
  const launched = await launchTreeNodeCommand({
    userDataRoot: userData, executablePath: exe, appDirectory: appDir, computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-5', spawn,
    action: 'resume-node', expectedSessionId: 'saved-session',
    aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, exe)
  assert.deepEqual(spawned[0].args, [appDir, `--user-data-dir=${path.resolve(userData)}`, launched.launchArgument])
  assert.deepEqual(spawned[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  assert.equal(launched.pid, 4242)
  assert.deepEqual(launched.argv, [exe, ...spawned[0].args])

  const identity = { executablePath: exe, developmentEntry: [mainScript, appDir], developmentUserDataPath: userData, appendedSwitches: OUTSIDE_CONTROL_SWITCHES }
  assert.equal(treeNodeCommandRequestIdFromArgv(launched.argv, identity), launched.requestId, 'helper module scope')
  assert.equal(treeNodeCommandRequestIdFromArgv(relayedByChromium(launched.argv, liveAppended), identity), launched.requestId, 'primary second-instance')
  const request = JSON.parse(await readFile(launched.requestFile, 'utf8'))
  assert.equal(request.requestId, launched.requestId)
  assert.equal(request.action, 'resume-node')
  assert.equal(request.expectedSessionId, 'saved-session')
  assert.equal(Object.hasOwn(request, 'message'), false)
  assert.equal(launched.argv.some(value => value.includes('saved-session')), false)
  const refused = spawnSync(process.execPath, [path.join(repo, 'tools', 'launch-tree-node-command.mjs'),
    '--user-data-root', userData, '--electron', exe, '--app-dir', appDir,
    '--action', 'resume-node', '--computer-id', 'this-computer', '--tree-id', 'tree-1', '--node-id', 'node-5'],
    { cwd: repo, encoding: 'utf8', timeout: 15_000 })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /expected-session-id is required/)

  /* a packaged launch: no application directory, no profile switch */
  const packaged = await launchTreeNodeCommand({
    userDataRoot: userData, executablePath: exe, computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-5', spawn,
    action: 'set-node-account', expectedSessionId: 'saved-session', choice: 'registered-backup',
    aclInspector: safeAcl, aclSecurer: noAclMutation,
  })
  assert.deepEqual(spawned[1].args, [packaged.launchArgument])
  const account = JSON.parse(await readFile(packaged.requestFile, 'utf8'))
  assert.equal(account.choice, 'registered-backup')
  assert.equal(account.expectedSessionId, 'saved-session')
  assert.equal(Object.hasOwn(account, 'parentSessionId'), false)
})

/* THE DEFECT. A ChildProcess is an EventEmitter, and Node's own rule for an
 * 'error' event with no listener is to throw it as an uncaught exception.
 * spawn() returns synchronously -- MEASURED on this machine: a helper started
 * with a bad executablePath answers with a synchronous `pid: undefined` and
 * only reports the real failure (ENOENT) later, as an 'error' event on the
 * next tick. launchTreeNodeCommand never listened for it, so a coordinator
 * that could not start its helper got exactly one of two bad outcomes
 * depending on --wait-seconds: with it, the request file this call had
 * already written sat unclaimed until the wait timed out and the process then
 * crashed anyway; without it (the CLI default), the "launched" line -- a
 * requestId, an argv, a pid -- was already on stdout by the time the crash
 * hit, so the coordinator read a launch that never happened as a success and
 * then watched the process die out from under it.
 *
 * THE RULE PINNED HERE. A helper that fails to start is reported the same way
 * every other launch failure in this file already is: a rejection the caller
 * can catch, never an unhandled exception and never a false "launched". */
test('a helper that fails to start rejects, instead of crashing the coordinator or reporting a launch that never happened', async (t) => {
  const { launchTreeNodeCommand } = await import('../launch-tree-node-command.mjs')
  await mkdir(testTempRoot, { recursive: true })
  const root = await mkdtemp(path.join(testTempRoot, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userData = path.join(root, 'ToolsEnabled-Live')
  await mkdir(userData, { mode: 0o700 })

  /* No `spawn` override: this drives the real node:child_process.spawn, the
     default, against an executable that cannot exist (a name inside a fresh
     mkdtemp directory). */
  await assert.rejects(
    () => launchTreeNodeCommand({
      userDataRoot: userData,
      executablePath: path.join(root, 'this-does-not-exist.exe'),
      computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-5',
      aclInspector: safeAcl, aclSecurer: noAclMutation,
    }),
    /ENOENT/,
    'a helper that never started must reject, not report a launch that never happened',
  )
})

/* AUDIT MODE, per an earlier commit (the commit above): that commit's own test drives
 * ONE launch alone. launchTreeNodeCommand keeps no module-level state -- each
 * call builds its own request, argv, child, and Promise -- so nothing in the
 * function AS WRITTEN can let two calls cross-talk; but that independence is
 * exactly the kind of property a later change (a shared in-flight tracker, a
 * queued single-spawn-at-a-time launcher) could break without any single-call
 * test here ever noticing. Raced here: a launch whose helper never starts
 * beside one that spawns clean, so each keeps its own outcome, its own pid,
 * and its own untouched request file in the shared spool.
 *
 * This also PINS what a failed launch leaves behind: createTreeNodeCommandRequest
 * runs, and its request file is written, BEFORE spawn() is even called, so a
 * launch that fails to start still leaves that request sitting in the spool,
 * unclaimed. Nothing here withdraws it -- it ages out through the request's
 * own bounded lifetimeMs (30 minutes by default, 24 hours at most) the same
 * way any other never-answered request does. A future change that starts
 * deleting it on a failed launch, or that stops writing it until after spawn
 * confirms, would be a deliberate design change, not a silent one -- so it is
 * asserted here rather than left to be discovered by a coordinator reading a
 * request that outlived its own launch. */
test('a second, concurrent launch keeps its own outcome and request file when another one fails to start', async (t) => {
  const { launchTreeNodeCommand } = await import('../launch-tree-node-command.mjs')
  await mkdir(testTempRoot, { recursive: true })
  const root = await mkdtemp(path.join(testTempRoot, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userData = path.join(root, 'ToolsEnabled-Live')
  await mkdir(userData, { mode: 0o700 })

  const spawned = []
  const okSpawn = (command, args, options) => { spawned.push({ command, args, options }); return { pid: 9001, unref() {} } }

  const [failure, success] = await Promise.allSettled([
    launchTreeNodeCommand({
      userDataRoot: userData,
      executablePath: path.join(root, 'this-does-not-exist-either.exe'),
      computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-5',
      aclInspector: safeAcl, aclSecurer: noAclMutation,
    }),
    launchTreeNodeCommand({
      userDataRoot: userData, executablePath: exe, appDirectory: appDir, computerId: 'this-computer', treeId: 'tree-1', nodeId: 'node-6', spawn: okSpawn,
      aclInspector: safeAcl, aclSecurer: noAclMutation,
    }),
  ])
  assert.equal(failure.status, 'rejected')
  assert.match(failure.reason.message, /ENOENT/)
  assert.equal(success.status, 'fulfilled', success.reason?.message)
  assert.equal(success.value.pid, 9001)
  assert.equal(spawned.length, 1, 'the failed launch never reached the successful one\'s own spawn call')

  /* two independent requests, not one clobbering the other */
  const requestFiles = await readdir(path.join(userData, 'coordinator-commands', 'requests'))
  assert.equal(requestFiles.length, 2, 'both launches -- the one that failed to start and the one that spawned -- write their own request')
  assert.ok(requestFiles.some(name => name.includes(success.value.requestId)))
  const orphan = requestFiles.find(name => !name.includes(success.value.requestId))
  assert.ok(orphan, 'the failed launch\'s own request is still there, unclaimed')
  const orphaned = JSON.parse(await readFile(path.join(userData, 'coordinator-commands', 'requests', orphan), 'utf8'))
  assert.equal(orphaned.nodeId, 'node-5')
})
