#!/usr/bin/env node

/* R73/OW31 ASTRA NATIVE ACCEPTANCE DRIVER.
 *
 * This driver has two deliberately separate verdicts:
 *
 *   fixture: deterministic app persistence plus the paired engine's real
 *            process/JSON-RPC transport. It proves the selected fields and
 *            preserves exact request/response assertions without a provider
 *            account or a live model call.
 *   native:  the Controller-owned native/provider circle. Linux must report
 *            this as missing evidence, never as a fixture success.
 *
 * The driver refuses to run against an unpaired checkout. The app base and
 * engine base are ancestry pins because this driver itself is committed after
 * the reviewed candidate. A staged capability copy must pass the same exact
 * source/record/byte verifier as the release; a source link must resolve to the
 * paired engine worktree. Set ASTRA_NATIVE_ACCEPTANCE_ENGINE_ROOT when the
 * acceptance engine differs from the shared explicit source declaration.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAUNCH_TIERS, launchTier } from '../src/orchestration-controls.js'
import { draftStartEffort, createFleetTreeStore } from '../src/fleet-trees.js'
import { createTranscriptStore } from '../src/session-transcript-store.js'
import { savedSessionEffort, saveStoppedSessionEffort } from '../src/manual-account-continuation.js'
import { canonicalRootForTests } from './canonical-root.mjs'

export const ASTRA_NATIVE_ACCEPTANCE_REFS = Object.freeze({
  appBase: '07091006f633d8e452ea9b6a27d0281c88f6249b',
  engineBase: 'f3d8bb3d81fb6a1868a13b2c4f1dbb1dafd0544c',
})

const SELF = fileURLToPath(import.meta.url)
const APP_ROOT = path.resolve(path.dirname(SELF), '..')
const ENGINE_ENV = 'ASTRA_NATIVE_ACCEPTANCE_ENGINE_ROOT'
const ASTRA_MODEL = 'gpt-6-astra'
const ASTRA_DEFAULT_EFFORT = 'medium'
const ASTRA_SELECTED_EFFORTS = Object.freeze(['high', 'max'])
const CONTROL_MODEL = 'gpt-5.6-luna'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function isAncestor(cwd, base, head) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function exactPairGuard({ appRoot = APP_ROOT, engineRoot = process.env[ENGINE_ENV] } = {}) {
  const resolvedAppRoot = realpathSync(appRoot)
  const resolvedEngineRoot = realpathSync(engineRoot || canonicalRootForTests())
  const appHead = git(resolvedAppRoot, ['rev-parse', 'HEAD'])
  const engineHead = git(resolvedEngineRoot, ['rev-parse', 'HEAD'])
  assert.equal(isAncestor(resolvedAppRoot, ASTRA_NATIVE_ACCEPTANCE_REFS.appBase, appHead), true,
    `app HEAD ${appHead} is not descended from reviewed candidate ${ASTRA_NATIVE_ACCEPTANCE_REFS.appBase}`)
  assert.equal(isAncestor(resolvedEngineRoot, ASTRA_NATIVE_ACCEPTANCE_REFS.engineBase, engineHead), true,
    `engine HEAD ${engineHead} is not descended from reviewed candidate ${ASTRA_NATIVE_ACCEPTANCE_REFS.engineBase}`)

  const capabilityPath = path.join(resolvedAppRoot, 'capability')
  const capabilityRoot = realpathSync(capabilityPath)
  let capabilityBinding = 'paired-source-link'
  if (capabilityRoot !== resolvedEngineRoot) {
    assert.ok(existsSync(path.join(capabilityRoot, 'PAYLOAD.json')), 'a staged acceptance payload must carry its deterministic record')
    execFileSync(process.execPath, [path.join(resolvedAppRoot, 'tools', 'check-payload-current.mjs'), capabilityRoot], {
      cwd: resolvedAppRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      env: { ...process.env, TOOLSENABLED_SOURCE: resolvedEngineRoot, TOOLSENABLED_SOURCE_REF: engineHead },
    })
    capabilityBinding = 'exact-staged-payload'
  }
  return Object.freeze({
    appRoot: resolvedAppRoot,
    appHead,
    appBase: ASTRA_NATIVE_ACCEPTANCE_REFS.appBase,
    engineRoot: resolvedEngineRoot,
    engineHead,
    engineBase: ASTRA_NATIVE_ACCEPTANCE_REFS.engineBase,
    capabilityRoot,
    capabilityBinding,
  })
}

function storageSeam() {
  const cells = new Map()
  return {
    read(key) { return cells.has(key) ? structuredClone(cells.get(key)) : null },
    write(key, value) { cells.set(key, structuredClone(value)); return true },
  }
}

function fixturePersistence() {
  const astra = launchTier('astra')
  assert.ok(astra, 'the app tier table does not offer Astra')
  assert.equal(astra.provider, 'codex', 'Astra is no longer a Codex provider tier')
  assert.equal(astra.model, ASTRA_MODEL, 'the app tier table changed Astra model identity')
  assert.equal(astra.effort, ASTRA_DEFAULT_EFFORT, 'the app tier table changed the owner-requested Astra default')
  assert.ok(LAUNCH_TIERS.includes(astra), 'Astra tier is not held in the declared launch tier inventory')
  const cases = []
  let serial = 0
  for (const effort of [ASTRA_DEFAULT_EFFORT, ...ASTRA_SELECTED_EFFORTS]) {
    const computerId = `astra-native-acceptance-${effort}`
    const storage = storageSeam()
    const makeId = kind => `${kind}-${++serial}`
    const first = createFleetTreeStore({ computerId, storage, makeId })
    const added = first.addNode({ role: 'worker', message: `Astra ${effort} persistence`, tier: 'astra', effort }).node
    assert.ok(added, `could not create Astra ${effort} fixture node`)
    const reopenedTree = createFleetTreeStore({ computerId, storage }).getNode(added.id)
    assert.equal(reopenedTree?.tier, 'astra')
    assert.equal(reopenedTree?.effort, effort,
      `tree save/reopen lost explicit Astra ${effort}`)
    assert.equal(draftStartEffort(reopenedTree, { tierDefault: ASTRA_DEFAULT_EFFORT }), effort,
      `tree Start replaced persisted Astra ${effort} with its tier default`)

    const transcript = createTranscriptStore({ computerId, storage })
    assert.equal(transcript.save(added.id, {
      threadId: `thread-${effort}`,
      provider: 'codex',
      effort,
      lines: [{ who: 'agent', text: `saved ${effort}` }],
    }), true, `could not seed transcript for Astra ${effort}`)
    assert.equal(saveStoppedSessionEffort({ nodeId: added.id, effort, transcriptStore: transcript, treeStore: first }), true,
      `stopped-session save refused Astra ${effort}`)
    const reopenedTranscript = createTranscriptStore({ computerId, storage }).get(added.id)
    assert.equal(reopenedTranscript?.effort, effort,
      `transcript save/reopen lost explicit Astra ${effort}`)
    assert.equal(savedSessionEffort({
      sessionEffort: null,
      savedEffort: reopenedTranscript?.effort,
      nodeEffort: reopenedTree?.effort,
      tierEffort: ASTRA_DEFAULT_EFFORT,
    }), effort, `resume precedence replaced persisted Astra ${effort}`)
    cases.push(Object.freeze({ effort, tree: effort, transcript: effort, resume: effort }))
  }

  /* Discriminating stopped-session control: the transcript already contains
     MEDIUM, then the stopped-session path changes that existing record to
     HIGH/MAX before a fresh store instance reopens it. Seeding the requested
     value up front would not exercise the production update branch. */
  for (const changedEffort of ASTRA_SELECTED_EFFORTS) {
    const computerId = `astra-native-acceptance-change-${changedEffort}`
    const storage = storageSeam()
    let changeSerial = 0
    const treeStore = createFleetTreeStore({ computerId, storage,
      makeId: kind => `${kind}-change-${changedEffort}-${++changeSerial}` })
    const added = treeStore.addNode({ role: 'worker', message: `Astra MEDIUM to ${changedEffort} persistence`, tier: 'astra', effort: ASTRA_DEFAULT_EFFORT }).node
    assert.ok(added, `could not create Astra changed-effort ${changedEffort} fixture node`)
    const transcriptStore = createTranscriptStore({ computerId, storage })
    assert.equal(transcriptStore.save(added.id, {
      threadId: `thread-change-${changedEffort}`,
      provider: 'codex',
      effort: ASTRA_DEFAULT_EFFORT,
      lines: [{ who: 'agent', text: `saved ${ASTRA_DEFAULT_EFFORT} before change` }],
    }), true, `could not seed stopped MEDIUM transcript before ${changedEffort} change`)
    assert.equal(saveStoppedSessionEffort({ nodeId: added.id, effort: changedEffort, transcriptStore, treeStore }), true,
      `stopped-session update refused MEDIUM to ${changedEffort}`)
    const reopenedTree = createFleetTreeStore({ computerId, storage }).getNode(added.id)
    const reopenedTranscript = createTranscriptStore({ computerId, storage }).get(added.id)
    assert.equal(reopenedTree?.effort, ASTRA_DEFAULT_EFFORT,
      `tree launch preference unexpectedly changed while updating stopped ${changedEffort} transcript`)
    assert.equal(reopenedTranscript?.effort, changedEffort,
      `reopen lost stopped-session change MEDIUM to ${changedEffort}`)
    assert.equal(savedSessionEffort({
      sessionEffort: null,
      savedEffort: reopenedTranscript?.effort,
      nodeEffort: reopenedTree?.effort,
      tierEffort: ASTRA_DEFAULT_EFFORT,
    }), changedEffort, `resume precedence lost stopped-session change MEDIUM to ${changedEffort}`)
    cases.push(Object.freeze({
      kind: 'changed-stopped-transcript',
      from: ASTRA_DEFAULT_EFFORT,
      to: changedEffort,
      tree: reopenedTree?.effort,
      transcript: reopenedTranscript?.effort,
      resume: changedEffort,
    }))
  }

  /* Missing-transcript fallback control: with no saved transcript at all,
     saveStoppedSessionEffort must retain the explicit choice on the tree, and
     the read-side precedence must use that choice rather than MEDIUM. */
  const missingStorage = storageSeam()
  let missingSerial = 0
  const missingTreeStore = createFleetTreeStore({ computerId: 'astra-native-acceptance-missing-transcript', storage: missingStorage,
    makeId: kind => `${kind}-missing-${++missingSerial}` })
  const missingNode = missingTreeStore.addNode({ role: 'worker', message: 'missing transcript fallback', tier: 'astra', effort: ASTRA_DEFAULT_EFFORT }).node
  const missingTranscriptStore = createTranscriptStore({ computerId: 'astra-native-acceptance-missing-transcript', storage: missingStorage })
  assert.equal(missingTranscriptStore.get(missingNode.id), null, 'missing-transcript control was not actually missing')
  assert.equal(saveStoppedSessionEffort({ nodeId: missingNode.id, effort: 'high', transcriptStore: missingTranscriptStore, treeStore: missingTreeStore }), true,
    'missing-transcript fallback refused explicit HIGH')
  const reopenedMissingTree = createFleetTreeStore({ computerId: 'astra-native-acceptance-missing-transcript', storage: missingStorage }).getNode(missingNode.id)
  const reopenedMissingTranscript = createTranscriptStore({ computerId: 'astra-native-acceptance-missing-transcript', storage: missingStorage }).get(missingNode.id)
  assert.equal(reopenedMissingTranscript, null, 'missing-transcript fallback unexpectedly fabricated a transcript')
  assert.equal(reopenedMissingTree?.effort, 'high', 'missing-transcript fallback lost explicit HIGH on the tree')
  assert.equal(savedSessionEffort({
    sessionEffort: null,
    savedEffort: null,
    nodeEffort: reopenedMissingTree?.effort,
    tierEffort: ASTRA_DEFAULT_EFFORT,
  }), 'high', 'missing-transcript resume fallback replaced HIGH with MEDIUM')
  cases.push(Object.freeze({
    kind: 'missing-transcript-fallback',
    from: ASTRA_DEFAULT_EFFORT,
    to: 'high',
    tree: reopenedMissingTree?.effort,
    transcript: null,
    resume: 'high',
  }))

  /* The default control is a genuinely absent node effort. The tier resolver,
     not a copied persisted value, must supply MEDIUM for a new Astra circle. */
  const defaultStorage = storageSeam()
  let defaultSerial = 0
  const defaultStore = createFleetTreeStore({ computerId: 'astra-native-acceptance-default-control', storage: defaultStorage,
    makeId: kind => `${kind}-default-${++defaultSerial}` })
  const defaultNode = defaultStore.addNode({ role: 'worker', message: 'default control', tier: 'astra' }).node
  const defaultReopened = createFleetTreeStore({ computerId: 'astra-native-acceptance-default-control', storage: defaultStorage }).getNode(defaultNode.id)
  assert.equal(defaultReopened.effort, '', 'new Astra node unexpectedly persisted a selected effort')
  assert.equal(draftStartEffort(defaultReopened, { tierDefault: ASTRA_DEFAULT_EFFORT }), ASTRA_DEFAULT_EFFORT,
    'new Astra circle did not resolve the owner-requested MEDIUM default')
  cases.push(Object.freeze({ effort: 'absent', tree: '', resolved: ASTRA_DEFAULT_EFFORT }))
  return Object.freeze({ status: 'passed', cases })
}

function writeCodexFixture(directory) {
  const script = path.join(directory, 'astra-native-acceptance-codex.cjs')
  writeFileSync(script, String.raw`#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const logPath = process.env.ASTRA_NATIVE_ACCEPTANCE_REQUEST_LOG;
const argEffort = args.find(value => /^model_reasoning_effort=/.test(value));
const argvEffort = argEffort ? argEffort.slice('model_reasoning_effort='.length) : 'medium';
function respond(request, result) { process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'); }
if (args.includes('--version')) { process.stdout.write('codex-cli 0.153.2\n'); return; }
if (!args.includes('app-server')) { process.stderr.write('missing app-server\n'); process.exitCode = 64; return; }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  // JSON-RPC notifications (including initialized) have no response ID.
  // Responding with an id-less error would be an invalid server message.
  if (!Object.hasOwn(request, 'id')) return;
  if (request.method === 'initialize') {
    respond(request, { userAgent: 'astra-native-acceptance-fixture', codexHome: '/tmp/astra-native-acceptance', platformFamily: 'linux', platformOs: 'linux' });
    return;
  }
  if (request.method === 'thread/start') {
    if (logPath) fs.appendFileSync(logPath, JSON.stringify(request) + '\n', 'utf8');
    const model = request.params && request.params.model ? request.params.model : 'gpt-6-astra';
    const effort = request.params && request.params.effort ? request.params.effort : argvEffort;
    respond(request, { thread: { id: 'astra-native-acceptance-' + effort }, model, reasoningEffort: effort });
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found in fixture' } }) + '\n');
});
`, 'utf8')
  if (process.platform === 'win32') {
    // Windows does not execute a Node shebang. Use the same explicit
    // node/script batch launcher as the paired engine's process fixtures;
    // production containment and cleanup still own the resulting process.
    const command = path.join(directory, 'astra-native-acceptance-codex.cmd')
    const quoted = value => value.replace(/%/g, '%%').replace(/"/g, '""')
    writeFileSync(command, `@echo off\r\n"${quoted(process.execPath)}" "${quoted(script)}" %*\r\n`, 'utf8')
    return command
  }
  chmodSync(script, 0o700)
  return script
}

async function fixtureStructuredLaunch(engineRoot) {
  const require_ = createRequire(import.meta.url)
  const { startCodexSession } = require_(path.join(engineRoot, 'src/lib/agent-engine/codex-process.js'))
  const directory = mkdtempSync(path.join(tmpdir(), 'astra-native-acceptance-'))
  const logPath = path.join(directory, 'requests.jsonl')
  writeFileSync(logPath, '', 'utf8')
  const command = writeCodexFixture(directory)
  const cases = []
  let cleanupConfirmed = true
  let primaryError = null
  try {
    for (const item of [
      { name: 'astra-default', model: ASTRA_MODEL, effort: ASTRA_DEFAULT_EFFORT },
      ...ASTRA_SELECTED_EFFORTS.map(effort => ({ name: `astra-${effort}`, model: ASTRA_MODEL, effort })),
      { name: 'luna-control', model: CONTROL_MODEL, effort: ASTRA_DEFAULT_EFFORT },
    ]) {
      const before = readFileSync(logPath, 'utf8')
      const session = await startCodexSession({
        cwd: directory,
        command,
        args: ['app-server', '-c', `model_reasoning_effort=${item.effort}`],
        env: { ...process.env, ASTRA_NATIVE_ACCEPTANCE_REQUEST_LOG: logPath },
        threadOptions: { model: item.model, approvalPolicy: 'never', sandbox: 'read-only' },
        startupTimeoutMs: 10_000,
      })
      try {
        const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
        assert.equal(lines.length, before.split(/\r?\n/).filter(Boolean).length + 1,
          `${item.name} did not issue exactly one structured thread/start request`)
        const request = JSON.parse(lines.at(-1))
        assert.equal(request.method, 'thread/start')
        assert.equal(request.params.model, item.model, `${item.name} changed provider model before launch`)
        assert.equal(Object.hasOwn(request.params, 'effort'), false,
          `${item.name} put Codex effort in thread options instead of its app-server argv`)
        assert.deepEqual(JSON.parse(JSON.stringify(request)), {
          jsonrpc: '2.0', id: request.id, method: 'thread/start',
          params: { cwd: directory, model: item.model, approvalPolicy: 'never', sandbox: 'read-only' },
        }, `${item.name} structured launch request drifted`)
        assert.equal(session.threadId, `astra-native-acceptance-${item.effort}`)

        /* startCodexSession keeps the transport/adapter handle. A second
           startThread call reads the fixture's structured response through
           the paired adapter parser, giving this driver an actual model and
           reasoningEffort field rather than inferring them from the request. */
        const structured = await session.adapter.startThread({ model: item.model, approvalPolicy: 'never', sandbox: 'read-only' })
        assert.equal(structured.model, item.model, `${item.name} lost the structured provider model field`)
        assert.equal(structured.reasoningEffort, item.effort, `${item.name} lost the structured provider effort field`)
        cases.push(Object.freeze({ name: item.name, requestedModel: item.model, argvEffort: item.effort,
          structuredModel: structured.model, structuredEffort: structured.reasoningEffort }))
      } finally {
        session.close()
        // close() requests termination; Windows still owns the working
        // directory until the native job and its wrapper confirm closure.
        // Do not delete fixture inputs while a child may still hold them.
        try { await session.adapter.transport.closeForStartupFailure(5000) }
        catch (error) { cleanupConfirmed = false; throw error }
      }
    }
  } catch (error) {
    primaryError = error
    if (typeof error.retryCleanup === 'function') cleanupConfirmed = false
    throw error
  } finally {
    if (cleanupConfirmed) {
      // The confirmed process exit can precede Windows releasing the last
      // pipe/directory handle. Let close events drain during bounded retries;
      // synchronous rmdir retries would block those same events.
      try { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
      catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], `${primaryError.message}; fixture directory cleanup also failed: ${error.message}`)
        throw error
      }
    }
    else console.error(`Astra fixture cleanup is unconfirmed; retained its working directory: ${directory}`)
  }
  return Object.freeze({ status: 'passed', cases })
}

export function nativeEvidence() {
  return Object.freeze({
    status: 'missing',
    kind: 'native-provider-evidence-not-run',
    platform: process.platform,
    reason: 'Controller-owned native/provider circle was not run by this Linux fixture driver; no paid-provider, live-circle, or Windows claim is made.',
    nextOwner: 'Manager 2 routes the concrete native run through Controller.',
  })
}

export async function runAstraNativeAcceptance(options = {}) {
  const pair = exactPairGuard(options)
  const fixture = Object.freeze({ persistence: fixturePersistence(), structuredLaunch: await fixtureStructuredLaunch(pair.capabilityRoot) })
  return Object.freeze({
    refs: pair,
    fixture,
    native: nativeEvidence(),
  })
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  runAstraNativeAcceptance({
    appRoot: APP_ROOT,
    engineRoot: process.env[ENGINE_ENV],
  }).then(result => {
    console.log(JSON.stringify(result, null, 2))
  }).catch(error => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
