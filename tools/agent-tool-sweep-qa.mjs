#!/usr/bin/env node

/* DRIVE EVERY TOOL IN THE CATALOG, ONE REAL CALL EACH, WITH A VERDICT.
 *
 * THE OWNER'S ESCALATION, verbatim: "you should drive every tool and verify
 * everything will work cross machine." This driver is the local half: every
 * tool the generated configuration advertises is CALLED, over real stdio
 * JSON-RPC against the staged payload, and answers one of six verdicts:
 *
 *   WORKS       the call succeeded with a sane answer
 *   GATED-OK    the call was refused by name with a human sentence and an
 *               explicit recognized gate taxonomy -- the gate working
 *   FAILED      an internal error, a crash, or an unnamed refusal -- a defect
 *   HUNG        no answer inside the deadline -- the worst class, measured
 *               rather than waited on
 *   SAFETY-HOLD a safety rule forbids driving it here, with the rule stated
 *   HARNESS-GAP the sweep could not exercise the advertised tool -- a release
 *               blocker in the harness, never evidence that the product works
 *
 * SAFETY CLASSIFICATION DECIDED BEFORE ANY CALL, per the coordinator's rules:
 * read tools run for real; local writes run against a SCRATCH state root only
 * and round-trip where they can; outward/spend tools run to the last safe
 * step, which on a scratch root with an empty vault is their credential or
 * approval gate -- no external send, publish, charge or deploy can complete
 * because no credential can resolve; destructive tools touch only this run's
 * own scratch resources, and the ones that necessarily touch the owner's desk
 * (audible tools, visible windows, the machine task scheduler, the live
 * clipboard, the kill switch) are SAFETY-HOLD with the reason recorded.
 *
 *   node tools/agent-tool-sweep-qa.mjs [--release <win-unpacked>] [--tier unrestricted] [--out <dir>]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateInitializeResponse, validateToolsListResponse } from './lib/mcp-qa-response.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXPLICIT_RELEASE = requiredPathArgOf('release')
const RELEASE = path.resolve(EXPLICIT_RELEASE || defaultReleaseDirectory(REPO))
const STAGED = path.join(RELEASE, 'resources', 'capability')
const STAGED_SERVER = path.join(STAGED, 'src', 'mcp-server.js')
if (EXPLICIT_RELEASE && !existsSync(STAGED_SERVER)) {
  throw new Error(`the requested release is missing its staged capability server: ${STAGED_SERVER}`)
}
const PAYLOAD = existsSync(STAGED_SERVER) ? STAGED : path.join(REPO, 'capability')
const require_ = createRequire(import.meta.url)
const { canonicalizeCreatedQaProfile } = require_(path.join(REPO, 'tools', 'lib', 'sterile-launch.cjs'))
const { trustedProfileShortAliasRoot } = require_(path.join(REPO, 'shell', 'install-profile-guard.cjs'))
const { reapDescendants } = require_(path.join(REPO, 'tools', 'process-tree.cjs'))

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function requiredPathArgOf(name) {
  const option = `--${name}`
  const occurrences = process.argv
    .map((value, index) => value === option || value.startsWith(`${option}=`) ? index : -1)
    .filter(index => index >= 0)
  if (occurrences.length === 0) return null
  if (occurrences.length !== 1) throw new Error(`${option} accepts exactly one path`)
  const index = occurrences[0]
  const token = process.argv[index]
  const value = token === option ? process.argv[index + 1] : token.slice(option.length + 1)
  if (typeof value !== 'string' || value.length === 0 || (token === option && value.startsWith('--'))) {
    throw new Error(`${option} requires one path`)
  }
  return value
}
const TIER = argOf('tier', 'unrestricted')
const OUT_DIR = path.resolve(argOf('out', path.join(REPO, 'reports', 'agent-tools')))
const DEFAULT_DEADLINE_MS = 30_000
const LONG_DEADLINE_MS = 90_000
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

let SCRATCH_ENTRY = null
let SCRATCH = null
let machineRecord = null

/* ----------------------------------------------------- safety tables -- */

const NOT_DRIVEN = new Map([
  ['sound.play', 'audible on the owner\'s desk (quiet-desktop rule)'],
  ['tts.speak', 'audible on the owner\'s desk (quiet-desktop rule)'],
  ['system.notify', 'puts a toast on the owner\'s screen'],
  ['system.ask', 'waits on the owner answering, by design'],
  ['system.ask_remote', 'waits on the owner through another machine, by design'],
  ['owner_prompts.start', 'opens the persistent owner dialog on the desk'],
  ['owner_host.request_start', 'queues the owner-host handoff prompt for the owner\'s desk'],
  ['window.focus', 'acts on the owner\'s own windows'],
  ['window.close', 'acts on the owner\'s own windows'],
  ['screen.capture_window', 'targets one of the owner\'s own windows by identity'],
  ['clipboard.read', 'the owner\'s live clipboard may hold a secret'],
  ['clipboard.write', 'clobbers the owner\'s live clipboard'],
  ['browser.start', 'opens a visible browser on the desk'],
  ['duo.ucr_login', 'drives a real Duo login surface'],
  ['gcloud.account_login', 'starts a visible browser sign-in'],
  ['firebase.account_login', 'starts a visible browser sign-in'],
  ['system.kill_switch_activate', 'halts agent tooling if any reader resolves outside the scratch root'],
  ['scheduler.create', 'registers a real machine-global Windows Scheduled Task'],
  ['scheduler.remove', 'mutates the machine-global Windows task registry'],
  ['scheduler.reconcile', 'mutates the machine-global Windows task registry'],
  ['workstation.configure_agent_clients', 'rewrites another program\'s machine-wide configuration'],
  ['workstation.install_cursor', 'installs software machine-wide'],
  ['workstation.initialize_cursor_state', 'writes another program\'s state outside any workspace'],
  ['workstation.launch_cursor', 'launches a visible program on the desk'],
  ['workstation.sync_cursor_extensions', 'mutates another program\'s machine-wide state'],
  ['repo.write_file', 'writes into the staged payload tree, breaking staged-install byte fidelity'],
  ['launch.execute', 'runs the project\'s own lifecycle scripts (arbitrary code)'],
  ['deployment.execute', 'runs the project\'s deploy toolchain (arbitrary code)'],
  ['firebase.deploy', 'runs firebase.json predeploy hooks (arbitrary code)'],
  ['terraform.init', 'downloads and executes provider plugins'],
  ['terraform.plan', 'executes provider plugins'],
  ['terraform.apply', 'executes provider plugins and provisioners'],
  /* Lease-handle consumers: their producer either needs Docker (sandbox), a
     live provider poll, or a claimed run
     phase this sweep's chain has already spent. Driving them with an invented
     handle would only measure the validator. */
  ['sandbox.heartbeat', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.exec', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.artifacts', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.cleanup', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.workspace_write', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.workspace_read', 'requires a live sandbox lease handle its producer could not mint here'],
  ['sandbox.auth_profile_heartbeat', 'requires a live auth-profile lease handle'],
  ['sandbox.auth_profile_release', 'requires a live auth-profile lease handle'],
  ['task.fail', 'requires a live lease handle; the chain\'s one lease is spent on task.complete'],
])

const RECOGNIZED_GATE_TAXONOMY = new Set([
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'INPUT_REQUIRED',
  'AUTH_EXPIRED',
  'QUOTA_EXHAUSTED',
])

const LONG_DEADLINE = new Set([
  'model.complete', 'model.customer_complete', 'model.quick_edit', 'model.role_complete',
  'research.hermes_complete', 'research.strong_complete', 'sandbox.create',
  'cloud.account_list', 'cloud.task_list', 'cloud.task_launch', 'cloud.task_status', 'cloud.task_diff',
  'firebase.doctor', 'firebase.project_create', 'firebase.project_enable', 'firebase.firestore_create', 'firebase.app_create',
  'gcloud.doctor', 'gcloud.project_create', 'gcloud.services_enable', 'gcloud.service_account_create',
  'gcloud.service_account_key_to_vault', 'gcloud.account_inspect',
  'web.search', 'web.lookup', 'web.fetch', 'http.request',
  'browser.playwright_call', 'search.index', 'ocr.read',
  'code.status', 'code.goto_definition', 'code.find_references', 'code.document_symbols',
  'code.workspace_symbols', 'code.diagnostics', 'code.hover',
])

/* One call per tool. `args` may be a value or a function of the chain
 * context. Anything not here and not requiring arguments is driven with {}. */
function buildSpecs(context) {
  const iso = '2026-08-21T10:00:00Z'
  const isoEnd = '2026-08-21T11:00:00Z'
  return new Map(Object.entries({
    'ide.consent_import': { surface: 'cursor' },
    'ide.consent_remove': { surface: 'cursor' },
    'owner_forms.describe': { formId: 'credential_value' },
    'system.credential_request': () => ({
      credential: 'github_pat',
      requestContext: { purpose: 'Sweep probe of the credential flow', scope: 'Recorded on a scratch root only', lifetime: 'Until the sweep scratch root is deleted' },
      acknowledgement: context.credentialAck,
    }),
    'owner_prompts.cancel': () => ({ requestId: context.ownerRequestId || 'owner-prompt-00000000-0000-0000-0000-000000000000' }),
    'payment_method.card_register': () => ({ acknowledgement: context.cardAck }),
    'browser.playwright_call': { name: 'browser_snapshot', arguments: {} },
    'browser.stop': { generation: '1' },
    'http.request': { method: 'GET', url: 'https://example.com/' },
    'web.lookup': { query: 'toolsenabled sweep probe' },
    'web.search': { query: 'toolsenabled sweep probe', provider: 'tavily' },
    'web.fetch': { url: 'https://example.com/' },
    'web.extract': { evidenceId: 'ev-00000000' },
    'web.expand': { evidenceId: 'ev-00000000' },
    'model.complete': { prompt: 'Answer with the single word OK.' },
    'model.customer_complete': { prompt: 'Answer with the single word OK.' },
    'model.quick_edit': { instruction: 'rename x to y', source: 'const x = 1;' },
    'model.role_complete': { role: 'adversary', model: 'auto', prompt: 'Answer OK.' },
    'research.hermes_complete': { prompt: 'Answer with the single word OK.' },
    'research.strong_complete': { prompt: 'Answer with the single word OK.' },
    'overnight_advisory.lifecycle': { actor: 'codex', action: 'stop', idempotencyKey: 'sweep-oal-1' },
    'overnight_advisory.submit': { actor: 'codex', idempotencyKey: 'sweep-oas-1', title: 'Sweep probe', prompt: 'Record-only sweep probe; no work expected.', acceptanceChecklist: ['recorded on the scratch root'] },
    'overnight_advisory.status': { taskId: 'sweep-oa-probe-0000' },
    'research.run_list': { experimentId: 'rx-0000' },
    'research.run_status': { runId: 'rr-0000' },
    'research.result_list': { runId: 'rr-0000' },
    'research.finding_list': { projectId: 'rp-0000' },
    'research.session_context': { refs: [{ projectId: 'rp-0000' }] },
    'research.run_submit': { actor: 'codex', experimentId: 'rx-0000', params: {} },
    'research.finding_save': { actor: 'codex', projectId: 'rp-0000', claim: 'Sweep probe claim, recorded on a scratch root.' },
    'research.session_assign': { actor: 'codex', projectId: 'rp-0000' },
    'research.lifecycle': { actor: 'codex', action: 'stop', idempotencyKey: 'sweep-rl-1' },
    'sandbox.create': { agent: 'codex', taskKey: 'sweep-task', sandboxKey: 'sweep-sandbox' },
    'sandbox.status': { sandboxId: `sbx-${'0'.repeat(20)}` },
    'sandbox.reap': { sandboxId: `sbx-${'0'.repeat(20)}`, confirmSandboxId: `sbx-${'0'.repeat(20)}` },
    'sandbox.auth_profile_create': { account: 'sweep-probe', purpose: 'sweep' },
    'sandbox.auth_profile_status': { profileId: `auth-${'0'.repeat(20)}` },
    'sandbox.auth_profile_lease': { profileId: `auth-${'0'.repeat(20)}`, agent: 'codex', taskKey: 'sweep-task' },
    'sandbox.auth_profile_revoke': { profileId: `auth-${'0'.repeat(20)}`, confirmProfileId: `auth-${'0'.repeat(20)}` },
    'repo.read_file': { path: 'package.json' },
    'repo.list_dir': { path: '.' },
    /* Shape-valid handle and version, so validation passes and the REAL answer
       -- the FRA-context requirement -- is what gets recorded. */
    'workspace.read': { fileHandle: 'A'.repeat(43), expectedVersion: '0'.repeat(64) },
    'host.read_file': () => ({ path: context.hostFile }),
    'host.write_file': () => ({ path: context.hostFile, content: 'sweep-host-write' }),
    'host.list_dir': () => ({ path: context.workspace }),
    'host.exec': { command: 'cmd.exe /c echo sweep-ok' },
    'screen.capture_region': { x: 0, y: 0, width: 64, height: 64 },
    'screen.capture_monitor': () => ({ monitorId: context.monitorId || 1 }),
    'screen.read_capture': () => ({ path: context.capturePath || path.join(SCRATCH, 'missing.png') }),
    'ocr.read': () => ({ path: context.capturePath || path.join(SCRATCH, 'missing.png') }),
    'search.index': () => ({ root: context.workspace }),
    'search.query': () => ({ query: 'sweep', root: context.workspace }),
    'code.status': () => ({ root: context.workspace }),
    'code.goto_definition': () => ({ file: context.codeFile, line: 1 }),
    'code.find_references': () => ({ file: context.codeFile, line: 1 }),
    'code.document_symbols': () => ({ file: context.codeFile }),
    'code.workspace_symbols': () => ({ query: 'sweep', root: context.workspace }),
    'code.diagnostics': () => ({ file: context.codeFile }),
    'code.hover': () => ({ file: context.codeFile, line: 1 }),
    'memory.set': { namespace: 'agent-tools-sweep', key: 'round-trip', value: 'sweep-value-1' },
    'memory.get': { namespace: 'agent-tools-sweep', key: 'round-trip' },
    'memory.search': { query: 'agent-tools-sweep' },
    'agent_comms.send': () => ({ recipientActor: 'codex', recipientMachine: context.recipientMachine || 'machine-b', body: 'sweep probe' }),
    'agent_comms.read': { cursor: 0 },
    'agent_comms.acknowledge': { messageId: 'm-00000000', sequence: 1, evidence: 'sweep probe' },
    'agent_comms.send_local': { from: 'SweepManager', to: 'SweepChild', body: 'sweep ping' },
    'agent_comms.local_roster': { from: 'SweepManager' },
    'personal_calendar.capture': { text: 'Sweep probe reminder tomorrow at 9am' },
    'personal_calendar.create': { title: 'Sweep probe item' },
    'personal_calendar.complete': () => ({ reminderId: context.reminderId || 'rem-00000000' }),
    'github.repo_get': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo' },
    'github.issue_list': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo' },
    'github.issue_get': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', issueNumber: 1 },
    'github.issue_create': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', title: 'Sweep probe', idempotencyKey: 'sweep-gh-1' },
    'github.issue_comment_create': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', issueNumber: 1, body: 'Sweep probe', idempotencyKey: 'sweep-gh-2' },
    'github.pull_request_list': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo' },
    'github.pull_request_get': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', pullNumber: 1 },
    'github.pull_request_create': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', title: 'Sweep probe', head: 'sweep', base: 'main', idempotencyKey: 'sweep-gh-3' },
    'github.release_list': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo' },
    'github.release_create': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', tagName: 'v0.0.0-sweep', idempotencyKey: 'sweep-gh-4' },
    'github.repository_dispatch': { owner: 'sweep-probe-owner', repo: 'sweep-probe-repo', eventType: 'sweep_probe', idempotencyKey: 'sweep-gh-5' },
    'task.submit': { queue: 'sweep-queue', type: 'probe', idempotencyKey: 'sweep-task-1', payload: { title: 'Sweep probe', objective: 'Record-only probe on a scratch root.' }, expiryPolicy: 'retry', maxAttempts: 1 },
    'task.claim': { queue: 'sweep-queue' },
    'task.start': () => ({ handle: context.taskHandle || { leaseToken: 'sweep' } }),
    'task.heartbeat': () => ({ handle: context.taskHandle || { leaseToken: 'sweep' } }),
    'task.checkpoint': () => ({ handle: context.taskHandle || { leaseToken: 'sweep' }, checkpointKey: 'sweep-cp-001', expectedRevision: 0, checkpoint: { summary: 'sweep checkpoint' } }),
    'task.complete': () => ({ handle: context.taskHandle || { leaseToken: 'sweep' }, result: { summary: 'Sweep probe complete.' } }),
    'task.cancel': { taskId: 'sweep-task-cancel-0000' },
    'task.get': () => ({ taskId: context.taskId || 'sweep-task-probe-0000' }),
    'instagram.publish_image': { imageUrl: 'https://example.com/sweep.jpg' },
    'firebase.project_create': { projectId: 'sweep-probe-000000' },
    'firebase.project_enable': { projectId: 'sweep-probe-000000' },
    'firebase.firestore_create': { projectId: 'sweep-probe-000000', location: 'nam5' },
    'firebase.app_create': { projectId: 'sweep-probe-000000', platform: 'WEB', displayName: 'Sweep probe' },
    'paddle.catalog_list': { kind: 'products' },
    'paddle.transaction_get': { transactionId: 'txn_00000000000000000000000000' },
    'paddle.transaction_verify': { transactionId: 'txn_00000000000000000000000000', expectedStatus: 'completed' },
    'paddle.transaction_cancel': { transactionId: 'txn_00000000000000000000000000', expectedStatus: 'draft', idempotencyKey: 'sweep-pd-1' },
    'paddle.subscription_get': { subscriptionId: 'sub_00000000000000000000000000' },
    'paddle.subscription_cancel': { subscriptionId: 'sub_00000000000000000000000000', effectiveFrom: 'next_billing_period', expectedStatus: 'active', expectedUpdatedAt: iso, idempotencyKey: 'sweep-pd-2' },
    'paddle.webhook_verify': { payload: '{}', signatureHeader: 'ts=1;h1=00' },
    'gcloud.account_inspect': { account: 'sweep-probe@example.com' },
    'gcloud.project_create': { projectId: 'sweep-probe-000000' },
    'gcloud.services_enable': { projectId: 'sweep-probe-000000', services: ['run.googleapis.com'] },
    'gcloud.service_account_create': { projectId: 'sweep-probe-000000', serviceAccountId: 'sweep-probe-sa' },
    'gcloud.service_account_key_to_vault': { projectId: 'sweep-probe-000000', serviceAccountId: 'sweep-probe-sa' },
    'cloud.task_launch': { environment: 'sweep-env', branch: 'main', prompt: 'Sweep probe; never launch.', repository: 'sweep-probe/sweep-probe' },
    'cloud.task_status': { taskId: 'ct-00000000' },
    'cloud.task_diff': { taskId: 'ct-00000000' },
    'gmail.send': { to: 'sweep@example.invalid', subject: 'sweep probe (must gate on the missing credential)' },
    'calendar.create': { summary: 'Sweep probe', start: iso, end: isoEnd },
    'drive.find': { name: 'sweep-probe' },
    'drive.upload': () => ({ filePath: context.hostFile }),
    'drive.delete': { fileId: '0000000000' },
    'pay.record': { amountUsd: 1, provider: 'sweep-probe' },
    'purchase.request': { title: 'Sweep probe', message: 'Record-only probe; never approve.', items: [{ id: 'sweep-item-1', title: 'Probe item', description: 'Record-only probe item; never approve.', amountCents: 100, currency: 'USD', merchant: 'Example Probe Shop', url: 'https://example.com/probe' }] },
    'purchase.decision': { promptId: 'pp-00000000' },
    'stripe.cardholder_create': { name: 'Sweep Probe', billing: { line1: '1 Probe St', city: 'Probeville', state: 'CA', country: 'US', postalCode: '00000' } },
    'stripe.virtual_card_create': { cardholderId: 'ich_00000000000000000000000000', dailyLimitUsd: 1 },
    'billing.checkout_status': { sessionId: 'cs_test_00000000000000000000000000' },
    'billing.webhook_verify': { payload: '{}', signatureHeader: 't=1,v1=00', vaultKey: 'stripe_webhook_secret' },
    'launch.detect': () => ({ cwd: context.workspace }),
    'launch.plan': () => ({ cwd: context.workspace }),
    'deployment.detect': () => ({ cwd: context.workspace }),
    'extension.validate': () => ({ cwd: context.workspace }),
    'extension.package': () => ({ cwd: context.workspace, outputPath: path.join(SCRATCH, 'sweep-ext.zip') }),
    'terraform.validate': () => ({ cwd: context.workspace }),
  }))
}

/* The order that lets the chains seed themselves: producers before consumers. */
const CHAIN_FIRST = [
  'owner_forms.describe', 'system.credential_request', 'owner_prompts.status', 'owner_prompts.cancel',
  'memory.set', 'memory.get', 'memory.search',
  'personal_calendar.create', 'personal_calendar.list', 'personal_calendar.complete',
  'screen.list_monitors', 'screen.capture', 'screen.read_capture', 'ocr.read',
  'task.submit', 'task.claim', 'task.start', 'task.heartbeat', 'task.checkpoint', 'task.complete', 'task.get',
]

/* ------------------------------------------------------------ server -- */

function startServer(entry, extraEnv = {}) {
  const child = spawn(entry.command, entry.args, {
    cwd: entry.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP, TMP: process.env.TMP,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      /* A real spawn inherits these from the app; workstation.status refuses
         without a bounded APPDATA, and that refusal would be this sweep's
         artifact rather than the product's. */
      APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE,
      ...(entry.env || {}), ...extraEnv,
    },
  })
  let buffered = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 20000) stderr = stderr.slice(-10000) })
  const waiting = new Map()
  let terminal = null
  let processError = null
  let transportError = null
  let stopPromise = null
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const awaitClose = milliseconds => Promise.race([
    closed.then(() => true),
    delay(milliseconds).then(() => false),
  ])
  const destroyPipes = () => {
    try { child.stdin.destroy() } catch { /* already closed */ }
    try { child.stdout.destroy() } catch { /* already closed */ }
    try { child.stderr.destroy() } catch { /* already closed */ }
  }
  const terminalDescription = () => {
    if (!terminal && processError) return `the server process emitted an error: ${processError.message}`
    if (!terminal && transportError) return `the server stdin failed: ${transportError.message}`
    if (!terminal) return 'the server is still running'
    return `the server ${terminal.kind} (code=${terminal.code ?? 'none'}, signal=${terminal.signal ?? 'none'})`
  }
  const settleWaitingForTransport = reason => {
    for (const handler of [...waiting.values()]) handler.resolve({ __transportError: reason })
  }
  const markTerminal = (kind, { code = null, signal = null } = {}) => {
    if (!terminal) terminal = { kind, code, signal }
    settleWaitingForTransport(`${terminalDescription()}; stderr: ${stderr.slice(-800)}`)
  }
  const markProcessError = error => {
    if (!processError) processError = error
    settleWaitingForTransport(`${terminalDescription()}; stderr: ${stderr.slice(-800)}`)
  }
  const markTransportError = error => {
    if (!transportError) transportError = error
    settleWaitingForTransport(`${terminalDescription()}; stderr: ${stderr.slice(-800)}`)
  }

  child.on('error', markProcessError)
  child.once('exit', (code, signal) => markTerminal('exited', { code, signal }))
  child.stdin.on('error', markTransportError)
  child.once('close', (code, signal) => {
    markTerminal('closed', { code, signal })
    resolveClosed({ code, signal })
  })
  child.stdout.on('data', chunk => {
    buffered += String(chunk)
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index).trim()
      buffered = buffered.slice(index + 1)
      index = buffered.indexOf('\n')
      if (!line) continue
      let message = null
      try { message = JSON.parse(line) } catch { continue }
      const handler = waiting.get(message.id)
      if (handler) handler.resolve(message)
    }
  })
  let nextId = 1
  const call = (method, params, timeoutMs) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError('the JSON-RPC timeout must be positive'))
    }
    if (terminal || processError || transportError || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({
        __transportError: `cannot call ${method}: ${terminalDescription()}; stderr: ${stderr.slice(-800)}`,
      })
    }
    return new Promise(resolve => {
      const id = nextId++
      let timer = null
      const finish = value => {
        if (!waiting.delete(id)) return
        if (timer !== null) clearTimeout(timer)
        resolve(value)
      }
      const handler = { resolve: finish }
      waiting.set(id, handler)
      timer = setTimeout(() => handler.resolve({ __timeout: true }), timeoutMs)
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
          if (error) markTransportError(new Error(`${method} could not be written to the server: ${error.message}`))
        })
      } catch (error) {
        markTransportError(new Error(`${method} could not be written to the server: ${error.message}`))
      }
    })
  }
  const stop = async () => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      const rootExited = () => terminal !== null || child.exitCode !== null || child.signalCode !== null
      if (rootExited()) {
        if (!await awaitClose(250)) destroyPipes()
        if (Number.isSafeInteger(child.pid)) {
          throw new Error(`the server process ${child.pid} exited before shutdown could verify and reap its live descendant tree`)
        }
        return
      }

      let reapError = null
      const reap = () => {
        try { reapDescendants(child.pid) } catch (error) { if (!reapError) reapError = error }
      }
      const assertReaped = () => {
        if (reapError) {
          throw new Error(`the server process tree could not be safely reaped: ${reapError.message}`, { cause: reapError })
        }
      }

      /* Descendants must be captured while their parent links still exist.
         Prompt helpers can inherit this process's output pipes, so EOF first is
         too late: the broker can exit while those helpers keep the harness open. */
      reap()
      try { child.stdin.end() } catch { /* the child may have closed between checks */ }
      if (await awaitClose(1_500)) { assertReaped(); return }
      if (rootExited()) {
        destroyPipes()
        assertReaped()
        return
      }

      reap()
      try { child.kill() } catch { /* already gone */ }
      if (await awaitClose(1_500)) { assertReaped(); return }
      if (rootExited()) {
        destroyPipes()
        assertReaped()
        return
      }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      if (await awaitClose(1_500)) { assertReaped(); return }
      destroyPipes()
      if (!rootExited() && Number.isSafeInteger(child.pid)) {
        throw new Error(`the server process ${child.pid} survived graceful and forced shutdown`)
      }
      assertReaped()
    })()
    return stopPromise
  }
  return { child, call, stop, stderrText: () => stderr, pendingCount: () => waiting.size }
}

/* ----------------------------------------------------------- verdict -- */

function parseBody(answer) {
  const result = answer && answer.result
  if (!result) return null
  if (result.structuredContent) return result.structuredContent
  const text = Array.isArray(result.content) && result.content[0] && result.content[0].text
  if (typeof text === 'string') { try { return JSON.parse(text) } catch { return { text } } }
  return {}
}

export function verdictOf(answer) {
  if (answer && answer.__timeout) return { verdict: 'HUNG', detail: 'no answer inside the deadline' }
  if (answer && answer.__transportError) {
    return { verdict: 'FAILED', detail: String(answer.__transportError).slice(0, 500) }
  }
  if (answer && answer.error) {
    /* -32602 means THIS SWEEP's argument recipe missed the schema. It is a
       release-blocking harness gap, not proof that the advertised tool works. */
    if (answer.error.code === -32602) {
      return { verdict: 'HARNESS-GAP', detail: `argument recipe insufficient: ${String(answer.error.message).slice(0, 300)}` }
    }
    return { verdict: 'FAILED', detail: `rpc error ${answer.error.code}: ${String(answer.error.message).slice(0, 400)}` }
  }
  const body = parseBody(answer)
  if (body === null) return { verdict: 'FAILED', detail: 'no result at all' }
  const errorNode = body.error && typeof body.error === 'object' ? body.error : null
  const flatCode = typeof body.code === 'string' && body.code.length > 0 && body.ok !== true ? body.code : null
  if (errorNode) {
    const taxonomy = errorNode.taxonomy && errorNode.taxonomy.code
    const named = errorNode.code || null
    if (named && errorNode.message && RECOGNIZED_GATE_TAXONOMY.has(taxonomy)) {
      return {
        verdict: 'GATED-OK',
        detail: `${taxonomy}/${named}: ${String(errorNode.message).slice(0, 300)}`,
      }
    }
    return {
      verdict: 'FAILED',
      detail: `unrecognized refusal taxonomy ${taxonomy || '<missing>'}: ${errorNode.message || errorNode.safeSummary || JSON.stringify(errorNode).slice(0, 300)}`,
    }
  }
  if (flatCode) {
    const taxonomy = body.taxonomy && body.taxonomy.code
    const gate = RECOGNIZED_GATE_TAXONOMY.has(taxonomy) ? taxonomy
      : RECOGNIZED_GATE_TAXONOMY.has(flatCode) ? flatCode : null
    if (gate) return { verdict: 'GATED-OK', detail: `${gate}/${flatCode}: ${String(body.reason || body.message || '').slice(0, 300)}` }
    return { verdict: 'FAILED', detail: `unrecognized refusal taxonomy ${taxonomy || '<missing>'}/${flatCode}: ${String(body.reason || body.message || '').slice(0, 300)}` }
  }
  const isError = answer.result && answer.result.isError === true
  if (isError) {
    const text = String((body && body.text) || '').slice(0, 300)
    return { verdict: 'FAILED', detail: text ? `uncoded error: ${text}` : 'refused without a structured code' }
  }
  return { verdict: 'WORKS', detail: JSON.stringify(body).slice(0, 200) }
}

export function sweepWorkItems(rows, inventoryFindings = []) {
  return [
    ...rows.filter(row => ['FAILED', 'HUNG', 'HARNESS-GAP'].includes(row.verdict)),
    ...inventoryFindings,
  ]
}

/* -------------------------------------------------------------- main -- */

async function main() {
  let server = null
  try {
  SCRATCH_ENTRY = mkdtempSync(path.join(tmpdir(), 'tool-sweep-'))
  const accountHome = homedir()
  SCRATCH = canonicalizeCreatedQaProfile(SCRATCH_ENTRY, {
    accountHome,
    trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome),
  })
  process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state')
  process.env.LOCALAPPDATA = path.join(SCRATCH, 'local')
  mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true })
  mkdirSync(process.env.LOCALAPPDATA, { recursive: true })
  machineRecord = require_(path.join(PAYLOAD, 'src/lib/setup/machine-record.js'))

  const relativeOut = path.relative(SCRATCH, OUT_DIR)
  if (relativeOut === '' || (!relativeOut.startsWith('..') && !path.isAbsolute(relativeOut))) {
    throw new Error('the sweep output directory must be outside its disposable scratch profile')
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const outJsonl = path.join(OUT_DIR, `sweep-${TIER}.jsonl`)
  writeFileSync(outJsonl, '')

  const servicesRoot = machineRecord.resolveServicesRoot({})
  const workspace = path.join(SCRATCH, 'home', 'AI Workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path.join(workspace, 'sweep.js'), 'const sweep = 1;\nmodule.exports = { sweep };\n')
  writeFileSync(path.join(workspace, 'package.json'), '{"name":"sweep-probe","private":true,"version":"0.0.0"}\n')
  const hostFile = path.join(SCRATCH, 'host-io', 'sweep.txt')
  mkdirSync(path.dirname(hostFile), { recursive: true })
  writeFileSync(hostFile, 'sweep-host-read\n')

  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier: TIER, servicesRoot, installRoot: PAYLOAD, nodePath: process.execPath, workspaceRoots: [workspace],
  }), { servicesRoot })

  /* PRECONDITION, printed rather than assumed: the scratch vault is empty, so
     no outward tool can complete an external act. */
  const vaultDir = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'vault')
  console.log(`scratch root: ${SCRATCH}`)
  console.log(`outward-safety precondition: scratch vault ${existsSync(vaultDir) ? 'EXISTS (check!)' : 'absent (no credential can resolve)'}\n`)

  /* The generated configuration for this tier, exactly as a session gets it. */
  const confinement = require_(path.join(PAYLOAD, 'src/lib/agent-session-confinement.js'))
  const fakeCodexHome = path.join(SCRATCH, 'codex-user-home')
  mkdirSync(fakeCodexHome, { recursive: true })
  writeFileSync(path.join(fakeCodexHome, 'auth.json'), '{}\n')
  const plan = confinement.confinedSessionPlan({ userCodexHome: fakeCodexHome })
  if (plan.ok !== true) throw new Error(`confinement plan refused: ${plan.code}`)
  const toml = readFileSync(path.join(plan.codexHome, 'config.toml'), 'utf8')
  const serverName = TIER === 'guided' ? 'toolsenabled-readonly' : 'toolsenabled'
  const block = toml.split(`[mcp_servers.${serverName}]`)[1]
  if (!block) throw new Error(`no ${serverName} server in the generated configuration`)
  const entry = {
    command: /command = '([^']*)'/.exec(block)[1],
    args: [...( /args = \[(.*)\]/.exec(block)[1].matchAll(/'([^']*)'/g) )].map(m => m[1]),
    cwd: /cwd = '([^']*)'/.exec(block)[1],
    env: Object.fromEntries([...block.matchAll(/^([A-Z_]+) = '([^']*)'$/gm)].map(m => [m[1], m[2]])),
  }

  /* The two tree circles the local messenger needs, registered through the
     payload's own directory module. */
  const directory = require_(path.join(PAYLOAD, 'src/lib/agent-comms/tree-node-directory.js')).createTreeNodeDirectory()
  directory.registerNode({ sessionId: 'sweep-manager', nodeName: 'SweepManager' })
  directory.registerNode({ sessionId: 'sweep-child', nodeName: 'SweepChild', managerName: 'SweepManager' })

  server = startServer(entry)
  validateInitializeResponse(await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tool-sweep-qa', version: '1' } }, 60_000), '2025-06-18')
  const listed = await server.call('tools/list', {}, 60_000)
  const advertised = validateToolsListResponse(listed, { requireNonEmpty: false })
  console.log(`tier ${TIER}: server "${serverName}" advertises ${advertised.length} tools\n`)

  const context = { workspace, hostFile, codeFile: path.join(workspace, 'sweep.js') }
  /* The card form's acknowledgement contract, prefetched so the register call
     can prove it received the exact UI guidance -- the same handshake a real
     agent performs. Not a scored row; the scored describe row uses the
     credential form. */
  const cardContract = parseBody(await server.call('tools/call', { name: 'owner_forms.describe', arguments: { formId: 'payment_card_default' } }, 30_000))
  if (cardContract && cardContract.acknowledgement) context.cardAck = cardContract.acknowledgement
  /* recipientMachine must be a value the schema admits. */
  const sendSchema = advertised.find(t => t.name === 'agent_comms.send')
  if (sendSchema) {
    const machines = sendSchema.inputSchema && sendSchema.inputSchema.properties
      && sendSchema.inputSchema.properties.recipientMachine
      && sendSchema.inputSchema.properties.recipientMachine.enum
    if (Array.isArray(machines) && machines.length > 0) context.recipientMachine = machines[0]
  }
  const specs = buildSpecs(context)

  const rows = []
  let consecutiveHangs = 0

  async function drive(tool) {
    const name = tool.name
    if (NOT_DRIVEN.has(name)) {
      rows.push({ name, verdict: 'SAFETY-HOLD', detail: NOT_DRIVEN.get(name) })
      return
    }
    const spec = specs.get(name)
    const required = (tool.inputSchema && tool.inputSchema.required) || []
    if (!spec && required.length > 0) {
      rows.push({ name, verdict: 'HARNESS-GAP', detail: `no safe argument recipe for required [${required.join(', ')}]` })
      return
    }
    let args = {}
    try { args = typeof spec === 'function' ? spec() : (spec || {}) } catch (error) {
      rows.push({ name, verdict: 'HARNESS-GAP', detail: `argument chain unavailable: ${error.message}` })
      return
    }
    const deadline = LONG_DEADLINE.has(name) ? LONG_DEADLINE_MS : DEFAULT_DEADLINE_MS
    const startedAt = Date.now()
    const answer = await server.call('tools/call', { name, arguments: args }, deadline)
    const { verdict, detail } = verdictOf(answer)
    const row = {
      name, verdict, detail, ms: Date.now() - startedAt, args: JSON.stringify(args).slice(0, 200),
    }
    rows.push(row)
    appendFileSync(outJsonl, `${JSON.stringify({ ...row, raw: answer && (answer.__timeout || answer.__transportError) ? null : parseBody(answer) })}\n`)
    console.log(`${verdict.padEnd(10)} ${name.padEnd(52)} ${String(row.ms).padStart(6)}ms  ${detail.slice(0, 110)}`)

    /* Chain seeds. */
    const body = parseBody(answer) || {}
    if (name === 'owner_forms.describe' && body.acknowledgement) context.credentialAck = body.acknowledgement
    if (name === 'system.credential_request' && body.requestId) context.ownerRequestId = body.requestId
    if (name === 'screen.list_monitors' && Array.isArray(body.monitors) && body.monitors[0]) context.monitorId = body.monitors[0].id ?? body.monitors[0].monitorId ?? 1
    if (name === 'screen.capture' && (body.path || body.file)) context.capturePath = body.path || body.file
    if (name === 'personal_calendar.create' && (body.reminderId || (body.reminder && body.reminder.reminderId))) context.reminderId = body.reminderId || body.reminder.reminderId
    if (name === 'task.submit' && (body.taskId || (body.task && body.task.taskId))) context.taskId = body.taskId || body.task.taskId
    if (name === 'task.claim' && (body.handle || (body.lease && body.lease.handle))) context.taskHandle = body.handle || body.lease.handle

    if (verdict === 'HUNG') {
      consecutiveHangs += 1
      if (consecutiveHangs >= 2) {
        console.log('  -- two consecutive hangs: restarting the server and continuing --')
        await server.stop()
        server = null
        server = startServer(entry)
        validateInitializeResponse(await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tool-sweep-qa', version: '1' } }, 60_000), '2025-06-18')
        consecutiveHangs = 0
      }
    } else {
      consecutiveHangs = 0
    }
  }

  const byName = new Map(advertised.map(tool => [tool.name, tool]))
  for (const name of CHAIN_FIRST) {
    if (byName.has(name)) { await drive(byName.get(name)); byName.delete(name) }
  }
  for (const tool of byName.values()) await drive(tool)

  await server.stop()
  server = null

  /* The special credential-ack chain for the card form. */
  const summary = {}
  for (const row of rows) summary[row.verdict] = (summary[row.verdict] || 0) + 1
  console.log(`\n=== SWEEP ${TIER}: ${rows.length} tools ===`)
  console.log(Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join('  '))
  const advertisedNames = advertised.map(tool => tool.name)
  const advertisedNameSet = new Set(advertisedNames)
  const duplicateNames = [...new Set(advertisedNames.filter((name, index) => advertisedNames.indexOf(name) !== index))]
  const observedNameSet = new Set(rows.map(row => row.name))
  const missingNames = [...advertisedNameSet].filter(name => !observedNameSet.has(name))
  const unexpectedNames = [...observedNameSet].filter(name => !advertisedNameSet.has(name))
  const inventoryFindings = []
  if (advertised.length === 0) {
    inventoryFindings.push({ name: 'catalog inventory', verdict: 'FAILED', detail: 'tools/list advertised zero tools' })
  }
  if (duplicateNames.length > 0) {
    inventoryFindings.push({ name: 'catalog identity', verdict: 'FAILED', detail: `duplicate advertised names: [${duplicateNames.join(', ')}]` })
  }
  if (rows.length !== advertised.length || missingNames.length > 0 || unexpectedNames.length > 0) {
    inventoryFindings.push({
      name: 'catalog coverage', verdict: 'FAILED',
      detail: `advertised=${advertised.length} observed=${rows.length} missing=[${missingNames.join(', ')}] unexpected=[${unexpectedNames.join(', ')}]`,
    })
  }
  const workItems = sweepWorkItems(rows, inventoryFindings)
  const observationCount = rows.length + inventoryFindings.length
  console.log('\nFAILED, HUNG, and HARNESS-GAP (work items):')
  for (const row of workItems) {
    console.log(`  ${row.verdict} ${row.name}: ${row.detail.slice(0, 200)}`)
  }
  writeFileSync(path.join(OUT_DIR, `sweep-${TIER}.summary.json`), JSON.stringify({
    tier: TIER, serverName, advertised: advertised.length, summary, inventoryFindings, rows,
  }, null, 1))
  console.log(`\nwrote ${path.join(OUT_DIR, `sweep-${TIER}.summary.json`)}`)
  console.log(`\n${observationCount} observation(s), ${workItems.length} failing`)
  process.exitCode = workItems.length ? 1 : 0
  } finally {
    let stopError = null
    try {
      if (server) await server.stop()
    } catch (error) {
      stopError = error
    }
    if (SCRATCH_ENTRY) {
      const ownedEntry = path.resolve(SCRATCH_ENTRY)
      const tempPrefix = `${path.resolve(tmpdir())}${path.sep}`
      if (!ownedEntry.toLowerCase().startsWith(tempPrefix.toLowerCase()) ||
          !path.basename(ownedEntry).startsWith('tool-sweep-')) {
        throw new Error('refusing to remove a sweep scratch path that this run did not create')
      }
      rmSync(ownedEntry, { recursive: true, force: true, maxRetries: 5 })
    }
    if (stopError) throw stopError
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch(error => {
    console.error(`the sweep itself failed: ${error?.stack || error}`)
    process.exitCode = 2
  })
}
