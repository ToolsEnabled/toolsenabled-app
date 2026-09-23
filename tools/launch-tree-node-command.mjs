#!/usr/bin/env node

/* Coordinator-only launcher for shell/tree-node-command.cjs.
 *
 * The writer (tools/write-tree-node-command.mjs) publishes a request and
 * prints the opaque switch; it never starts the application. This is the other
 * half: it publishes the same request and then starts the command helper with
 * the argv shell/tree-node-command.cjs BUILDS -- treeNodeCommandLaunchArgv --
 * which is the same slot table the running application PARSES. A coordinator
 * that hand-rolled the helper's command line could drift from the grammar
 * (MEASURED 2026-09-03 and 2026-09-04 on the owner's Live tier: nine unanswered
 * resumes, then a restart refused MC_TREE_COMMAND_ARGUMENT_INVALID); one that
 * runs this cannot.
 *
 * The profile switch the helper is given is the userData directory the request
 * was spooled to, because that is what decides which spool the helper reads.
 * A packaged launch names no application directory and gets no profile switch.
 * A follow-up send reads its bounded message only from stdin, so message
 * content never enters argv.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { spawn as spawnProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createTreeNodeCommandRequest, treeNodeCommandLaunchArgv } = require('../shell/tree-node-command.cjs')

export async function launchTreeNodeCommand({
  userDataRoot,
  executablePath,
  appDirectory = null,
  action = 'fresh-start-existing-node',
  computerId,
  treeId,
  nodeId,
  expectedSessionId = null,
  message = null,
  lifetimeMs = 30 * 60 * 1000,
  spawn = spawnProcess,
  aclSecurer = undefined,
  aclInspector = undefined,
} = {}) {
  const written = createTreeNodeCommandRequest({
    userDataRoot, action, computerId, treeId, nodeId, expectedSessionId, message, lifetimeMs,
    ...(aclSecurer ? { aclSecurer } : {}),
    ...(aclInspector ? { aclInspector } : {}),
  })
  const argv = treeNodeCommandLaunchArgv({
    executablePath,
    developmentEntry: appDirectory,
    developmentUserDataPath: appDirectory ? path.resolve(userDataRoot) : null,
    requestId: written.requestId,
  })
  const [command, ...args] = argv
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  /* A HELPER THAT NEVER STARTS MUST NOT TAKE THIS PROCESS DOWN WITH IT.
   *
   * A real ChildProcess is an EventEmitter, and Node's own rule for an
   * 'error' event with no listener is to throw it as an uncaught exception.
   * spawn() returns synchronously -- MEASURED on this machine: a bad
   * executablePath answers with `pid: undefined` at once and only reports the
   * real failure (ENOENT) later, as an 'error' event on a following tick. This
   * function used to return right there, having already written the request
   * file above and, with --wait-seconds omitted (the CLI's own default),
   * already having printed a "launched" line -- a requestId, an argv, a pid
   * -- to stdout before the crash landed. The one thing left holding nothing
   * was the coordinator: an orphaned, unclaimed request in its own spool and a
   * stack trace instead of the JSON refusal every other failure in this file
   * already produces.
   *
   * So this waits for Node's own verdict -- 'spawn' or 'error', exactly one of
   * which always fires for a real ChildProcess -- and turns a failed launch
   * into a rejection the caller already knows how to handle, the same way a
   * bad argv or an unwritable spool already does (see the top-level catch
   * below). A test double for `spawn` need not be an EventEmitter -- every one
   * already in this suite returns a plain { pid, unref() } object -- so this
   * is skipped unless the object actually carries `once`, exactly like the
   * `unref` check already below it. */
  if (child && typeof child.once === 'function') {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  }
  if (child && typeof child.unref === 'function') child.unref()
  return Object.freeze({ ...written, argv, pid: child && Number.isInteger(child.pid) ? child.pid : null })
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function parse(argv) {
  const allowed = new Set([
    'user-data-root', 'electron', 'app-dir', 'action', 'computer-id', 'tree-id', 'node-id',
    'expected-session-id', 'lifetime-minutes', 'wait-seconds',
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail('Unexpected positional argument.')
    const key = token.slice(2)
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(values, key)) fail('Unsupported or repeated option.')
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`Option --${key} needs one value.`)
    values[key] = value
    index += 1
  }
  for (const key of ['user-data-root', 'electron', 'action', 'computer-id', 'tree-id', 'node-id']) {
    if (!values[key]) fail(`Missing required option: --${key}`)
  }
  if (!['fresh-start-existing-node', 'send-to-bound-node'].includes(values.action)) {
    fail('--action must be fresh-start-existing-node or send-to-bound-node.')
  }
  if (values.action === 'send-to-bound-node' && !values['expected-session-id']) {
    fail('--expected-session-id is required for send-to-bound-node.')
  }
  const lifetimeMinutes = values['lifetime-minutes'] === undefined ? 30 : Number(values['lifetime-minutes'])
  if (!Number.isFinite(lifetimeMinutes) || lifetimeMinutes <= 0 || lifetimeMinutes > 1440) {
    fail('--lifetime-minutes must be greater than 0 and no more than 1440.')
  }
  const waitSeconds = values['wait-seconds'] === undefined ? 0 : Number(values['wait-seconds'])
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
    fail('--wait-seconds must be between 0 and 3600.')
  }
  return {
    userDataRoot: values['user-data-root'],
    executablePath: values.electron,
    appDirectory: values['app-dir'] || null,
    action: values.action,
    computerId: values['computer-id'],
    treeId: values['tree-id'],
    nodeId: values['node-id'],
    expectedSessionId: values['expected-session-id'] || null,
    lifetimeMs: Math.round(lifetimeMinutes * 60 * 1000),
    waitSeconds,
  }
}

async function waitForResult(resultFile, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      try { return JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* half-written; look again */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return null
}

const invokedDirectly = (() => {
  try { return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1] || '').toLowerCase() } catch { return false }
})()

if (invokedDirectly) {
  try {
    const { waitSeconds, ...request } = parse(process.argv.slice(2))
    if (request.action === 'send-to-bound-node') request.message = readFileSync(0, 'utf8')
    const launched = await launchTreeNodeCommand(request)
    const result = waitSeconds > 0 ? await waitForResult(launched.resultFile, waitSeconds) : undefined
    process.stdout.write(`${JSON.stringify(result === undefined ? launched : { ...launched, result })}\n`)
    if (result === null) process.exit(3)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || 'MC_TREE_COMMAND_LAUNCH_FAILED', reason: error?.message || null })}\n`)
    process.exit(1)
  }
}
