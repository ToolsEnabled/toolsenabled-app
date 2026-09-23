/* GATE EVIDENCE: run the post-packaging gates on their own, record what they
 * proved and against which bytes, and let a later cut consume that record
 * instead of paying for a full sealed cut to learn one gate's verdict.
 *
 * WHAT THIS COST BEFORE IT EXISTED. The 1.0.40 release paid for three sealed
 * cuts (r9, r10, r11-prepared) of roughly twenty minutes each. r9 built and
 * tested clean, then failed on a single source comment in the owner-data scan.
 * r10 passed every product gate, sealed the artifact, and then failed the LAST
 * QA gate on a harness defect that had nothing to do with the shipped bytes.
 * The fix for r10 was proven by hand: the repaired harness was pointed at the
 * untouched r10 artifact, exited 0, and the seal re-verified byte-identical --
 * but nothing in the cutter could accept that proof, so the choice was another
 * twenty-minute cut or a hand-written declaration. This module makes that
 * hand process a first-class, recorded, fail-closed path.
 *
 * THREE PIECES, EACH BOUND TO BYTES RATHER THAN TO INTENT:
 *
 *   1. A GATE TABLE. The post-packaging gates from `npm run dist`, in the same
 *      order, plus the exact-candidate packaged QA the cutter runs itself. Each
 *      is named, so a person can say "run only install-dir" and a record can
 *      say "install-dir exited 0". The two seal verifications bracket the list
 *      and can never be skipped: the first proves the artifact is still what
 *      was sealed before any gate touches it; the last proves no gate changed
 *      it. Everything between them is verification, not construction.
 *
 *   2. AN EVIDENCE RECORD. Every gate run writes one JSON file naming the gate,
 *      its exact argv, its exit code, the SHA-256 of the gate SCRIPT that ran,
 *      the commit and clean/dirty state of the checkout that script came from,
 *      and the identity of the artifact it ran against: the SHA-256 of the seal
 *      file (which itself hashes every file in the unpacked tree) and the byte
 *      count and SHA-256 of the installer. A record is written after every
 *      gate, not at the end, so a crash mid-run still leaves the gates that
 *      passed on disk.
 *
 *   3. A SKIP RULE. `--skip-verified <record>` lets a resumed cut skip a gate
 *      ONLY when the record says that exact gate, by that exact script (same
 *      hash), from a clean checkout, exited 0 against the same seal and the
 *      same installer bytes the resumed cut is about to declare. Any mismatch
 *      is a rejection with a stated reason, and a rejected gate simply runs.
 *      There is no flag that skips a gate without evidence.
 *
 * WHY THE SEAL HASH AND NOT JUST THE INSTALLER HASH. The gates run against
 * release/win-unpacked, not the .exe. The installer hash proves the packaged
 * bytes; the seal file hash proves the unpacked tree the gates actually read
 * is the same tree, file for file, that was sealed after packaging. Binding to
 * both means evidence from a re-packed or hand-edited tree never matches.
 *
 * WHY THE GATE SCRIPT HASH. The r10 lesson was that the HARNESS was wrong and
 * the artifact was right. Evidence must therefore say which harness bytes
 * produced the verdict, so a fixed harness invalidates old evidence (it should
 * -- the old verdict came from the broken one) and a resumed cut can declare
 * "gate X verified by harness commit Y", which is exactly what a verifier
 * needs to reproduce it.
 */
import { runOwnedProcess } from '../../lib/owned-process.mjs'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isClean, revParse } from './git.mjs'
import { measureFile, sha256File } from './hash.mjs'
import { withGateWorktree } from './gate-quarantine.mjs'

export const GATE_EVIDENCE_SCHEMA = 'toolsenabled.gate-evidence'
export const GATE_EVIDENCE_SCHEMA_VERSION = 2
export const UNPACKED = 'release/win-unpacked'
const SEAL_VERIFIER = fileURLToPath(new URL('../../seal-artifact.mjs', import.meta.url))

function gate(name, argv, { skippable = true, runsInCutTail = false, timeoutMs = 10 * 60 * 1000 } = {}) {
  return Object.freeze({ name, argv: Object.freeze([...argv]), skippable, runsInCutTail, timeoutMs })
}

/* Order mirrors the tail of package.json's `dist` chain after `electron-builder`,
 * with the seal verification moved to bracket everything (it is cheap, about a
 * second, and it is the whole integrity argument for a resume). Gates that
 * only ever run once per build are deliberately ABSENT: `seal-artifact.mjs
 * --record` must never be re-issued over a tree whose provenance is in question,
 * which is the one thing a resume cannot know by itself -- so a worktree without
 * a seal record is refused rather than re-sealed (see describeArtifact). */
export const POST_BUILD_GATES = Object.freeze([
  gate('seal-verify-before', ['tools/seal-artifact.mjs', '--verify', UNPACKED], { skippable: false }),
  gate('runtime-files', ['tools/check-electron-runtime-files.mjs', UNPACKED]),
  gate('strip-diagnostics', ['tools/strip-build-diagnostics.mjs', 'release'], { skippable: false }),
  gate('asar-manifest', ['tools/check-asar-manifest.mjs', UNPACKED], { skippable: false }),
  gate('renderer-payload', ['tools/check-renderer-payload.mjs', UNPACKED]),
  // These inspect generated source, private configuration, external engine
  // history, installed dependencies or the running host. A source commit plus
  // artifact hash does not identify those inputs, so their verdicts are fresh.
  gate('owner-data-unpacked', ['tools/check-no-owner-data.mjs', UNPACKED], { skippable: false }),
  gate('license-notices', ['tools/check-license-notices.mjs', UNPACKED], { skippable: false }),
  gate('payload-boundary', ['tools/check-payload-boundary.mjs', `${UNPACKED}/resources/capability`], { skippable: false }),
  gate('artifact-private', ['tools/check-artifact-private.mjs', UNPACKED], { skippable: false }),
  gate('smoke-packaged', ['tools/smoke-packaged.mjs', UNPACKED], { skippable: false }),
  gate('install-dir', ['tools/check-install-dir-immutable.mjs', UNPACKED], { skippable: false }),
  /* The cutter runs exact-candidate packaged QA in its own tail, after the
     staged copy is proven byte-identical. A resumed cut therefore leaves this
     one to the tail (runsInCutTail) so the declared order stays the same as a
     fresh cut; --gates-only runs it like any other gate. */
  gate('packaged-qa', ['tools/packaged-qa-suite.mjs', '--release', UNPACKED], { skippable: false, runsInCutTail: true, timeoutMs: 20 * 60 * 1000 }),
  gate('payload-boundary-after', ['tools/check-payload-boundary.mjs', `${UNPACKED}/resources/capability`], { skippable: false }),
  gate('owner-data-release', ['tools/check-no-owner-data.mjs', 'release'], { skippable: false }),
  gate('seal-verify-after', ['tools/seal-artifact.mjs', '--verify', UNPACKED], { skippable: false }),
])

export function gateByName(name, gates = POST_BUILD_GATES) {
  return gates.find((entry) => entry.name === name) ?? null
}

/** Resolve `--gate` selections against the table; unknown names refuse loudly
 * rather than silently running nothing. */
export function selectGates(names, gates = POST_BUILD_GATES) {
  if (!names || names.length === 0) return [...gates]
  const unknown = names.filter((name) => !gateByName(name, gates))
  if (unknown.length > 0) {
    throw new Error(`unknown gate name(s): ${unknown.join(', ')}. Known gates: ${gates.map((entry) => entry.name).join(', ')}`)
  }
  const wanted = new Set(names)
  return gates.filter((entry) => wanted.has(entry.name))
}

export function sealPathFor(worktreePath) {
  return path.join(worktreePath, 'release', '.artifact-seal-win-unpacked.json')
}

export function defaultEvidencePath(worktreePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return path.join(worktreePath, 'release', `.gate-evidence-${stamp}.json`)
}

/* The artifact identity every record and every skip decision is bound to.
 * Fails closed on anything missing: a worktree with no seal has no proof that
 * the unpacked tree is what packaging produced, and a resume over that tree
 * would be a resume over a guess. */
export async function describeArtifact(worktreePath, version, { lease } = {}) {
  return withGateWorktree(worktreePath, () => describeArtifactUnchecked(worktreePath, version), { lease })
}

async function describeArtifactUnchecked(worktreePath, version) {
  const unpacked = path.join(worktreePath, 'release', 'win-unpacked')
  const sealPath = sealPathFor(worktreePath)
  const installerPath = path.join(worktreePath, 'release', `ToolsEnabled Setup ${version}.exe`)
  const missing = [
    [unpacked, 'unpacked artifact directory'],
    [sealPath, 'artifact seal record (seal-artifact.mjs --record never ran, so the tree cannot be proven untouched; re-cut instead of resuming)'],
    [installerPath, 'built installer'],
  ].filter(([candidate]) => !existsSync(candidate))
  if (missing.length > 0) {
    throw new Error(`cannot describe the artifact in ${worktreePath}: missing ${missing.map(([, label]) => label).join('; ')}`)
  }
  if (!(await stat(unpacked)).isDirectory()) throw new Error(`${unpacked} is not a directory`)
  // A seal file describes what was packaged; its own hash says nothing about
  // the current unpacked bytes. Verify even for a single --gates-only check.
  // Otherwise a check on edited bytes can produce evidence for the old seal.
  const verified = await runNode(process.execPath, [SEAL_VERIFIER, '--verify', unpacked], {
    cwd: worktreePath, env: process.env, log: () => {},
  })
  if (verified.code !== 0) {
    const error = new Error(`artifact seal verification failed before gate evidence could be bound: ${verified.failureReason || verified.output.trim()}`)
    error.terminationConfirmed = verified.terminationConfirmed
    throw error
  }
  const seal = JSON.parse(await readFile(sealPath, 'utf8'))
  const installer = await measureFile(installerPath)
  return {
    version,
    unpacked: 'win-unpacked',
    sealFile: path.basename(sealPath),
    sealSha256: await sha256File(sealPath),
    sealRecordedAt: typeof seal?.recordedAt === 'string' ? seal.recordedAt : null,
    installer: { filename: path.basename(installerPath), bytes: installer.bytes, sha256: installer.sha256 },
  }
}

export function sameArtifact(left, right) {
  return Boolean(left && right)
    && typeof left.sealSha256 === 'string' && /^[0-9A-F]{64}$/.test(left.sealSha256)
    && typeof left.installer?.sha256 === 'string' && /^[0-9A-F]{64}$/.test(left.installer.sha256)
    && Number.isSafeInteger(left.installer?.bytes) && left.installer.bytes > 0
    && left.sealSha256 === right.sealSha256
    && left.installer?.sha256 === right.installer?.sha256
    && left.installer?.bytes === right.installer?.bytes
}

/** Where the gate scripts come from, as a commit plus clean/dirty. Injectable so
 * tests can run the machinery on a fixture directory that is not a git checkout. */
export function describeGateSource(gateSourcePath, { probe } = {}) {
  if (probe) return probe(gateSourcePath)
  return { ref: revParse(gateSourcePath, 'HEAD'), dirty: !isClean(gateSourcePath) }
}

function gateScriptPath(gateSourcePath, entry) {
  return path.join(gateSourcePath, ...entry.argv[0].split('/'))
}

export async function gateScriptSha256(gateSourcePath, entry) {
  const scriptPath = gateScriptPath(gateSourcePath, entry)
  if (!existsSync(scriptPath)) throw new Error(`gate ${entry.name}: script not found at ${scriptPath}`)
  return sha256File(scriptPath)
}

function runNode(execPath, args, { cwd, env, log, timeoutMs = 10 * 60 * 1000, maxOutputBytes = 8 * 1024 * 1024 }) {
  return runOwnedProcess(execPath, args, { cwd, env, log, timeoutMs, maxOutputBytes })
}

async function writeRecordAtomically(evidencePath, record) {
  await mkdir(path.dirname(evidencePath), { recursive: true })
  const temporary = `${evidencePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temporary, evidencePath)
}

/* Run gates in order against one worktree, writing the evidence record after
 * every gate. Stops at the first failure exactly as the `&&` chain in
 * `npm run dist` would, so a green record never contains a gate that ran after
 * a red one. `skip` is a Map from gate name to the accepted evidence entry (see
 * selectSkippableGates); a skipped gate is recorded as skipped, with the
 * evidence it leaned on, never as passed. */
export async function runGates(options) {
  return withGateWorktree(options.worktreePath, lease => runGatesWithLease(options, lease))
}

async function runGatesWithLease({
  worktreePath,
  gateSourcePath,
  gates = POST_BUILD_GATES,
  skip = new Map(),
  artifact,
  gateSourceState,
  evidencePath,
  env = process.env,
  environment = null,
  privateInputs = null,
  execPath = process.execPath,
  log = console.log,
}, lease) {
  const worktree = path.resolve(worktreePath)
  const gateSource = path.resolve(gateSourcePath)
  const source = gateSourceState ?? describeGateSource(gateSource)
  if (!artifact) throw new Error('runGates requires the artifact identity (describeArtifact) so every record is bound to bytes')
  const assertArtifactUnchanged = async () => {
    if (!sameArtifact(artifact, await describeArtifact(worktree, artifact.version, { lease }))) {
      throw new Error('the seal or installer changed during the gate run; no evidence may certify these bytes')
    }
  }
  await assertArtifactUnchanged()
  const recordPath = evidencePath ?? defaultEvidencePath(worktree)

  // Every script must exist before the first one runs; a missing script found
  // halfway through would leave a half-run chain with a plausible-looking record.
  const scriptHashes = new Map()
  for (const entry of gates) scriptHashes.set(entry.name, await gateScriptSha256(gateSource, entry))

  const record = {
    schema: GATE_EVIDENCE_SCHEMA,
    schemaVersion: GATE_EVIDENCE_SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    artifact,
    gateSource: { ref: source.ref, dirty: Boolean(source.dirty) },
    environment,
    privateInputs,
    gates: [],
  }
  await writeRecordAtomically(recordPath, record)

  let combinedOutput = ''
  let ok = true
  let failed = null
  for (const entry of gates) {
    const startedAt = new Date().toISOString()
    const currentSource = gateSourceState ?? describeGateSource(gateSource)
    const currentScriptHash = await gateScriptSha256(gateSource, entry)
    if (currentSource.ref !== source.ref || currentSource.dirty !== source.dirty || currentScriptHash !== scriptHashes.get(entry.name)) {
      throw new Error(`gate ${entry.name}: harness changed during the gate run; refusing stale evidence`)
    }
    const leaned = entry.skippable && skip.get(entry.name)
    if (leaned && (leaned.gateSourceRef !== source.ref || leaned.gateScriptSha256 !== currentScriptHash || !sameArtifact(leaned.artifact, artifact))) {
      throw new Error(`gate ${entry.name}: accepted evidence no longer matches the harness or artifact`)
    }
    if (leaned) {
      log(`[gate ${entry.name}] SKIPPED with bound evidence recorded ${leaned.recordedAt} by harness ${leaned.gateSourceRef}`)
      record.gates.push({
        name: entry.name,
        argv: [...entry.argv],
        gateScriptSha256: scriptHashes.get(entry.name),
        status: 'skipped-with-evidence',
        exitCode: null,
        startedAt,
        finishedAt: startedAt,
        evidence: { path: path.basename(leaned.evidencePath), recordedAt: leaned.recordedAt, gateSourceRef: leaned.gateSourceRef },
      })
      await writeRecordAtomically(recordPath, record)
      continue
    }
    log(`[gate ${entry.name}] node ${entry.argv.join(' ')}  (cwd: ${worktree})`)
    const started = Date.now()
    const outcome = await runNode(execPath, [gateScriptPath(gateSource, entry), ...entry.argv.slice(1)], {
      cwd: worktree, env, log, timeoutMs: entry.timeoutMs, maxOutputBytes: entry.maxOutputBytes,
    })
    const { code, output } = outcome
    combinedOutput += `\n${output}`
    const finishedAt = new Date().toISOString()
    const entryRecord = {
      name: entry.name,
      argv: [...entry.argv],
      gateScriptSha256: scriptHashes.get(entry.name),
      status: code === 0 ? 'pending-artifact-verification' : 'failed',
      exitCode: code,
      failureReason: outcome.failureReason ? (outcome.failureReason.startsWith('process could not start') ? 'process could not start' : outcome.failureReason) : null,
      terminationConfirmed: outcome.terminationConfirmed,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      // The evidence is scanned as release output. Diagnostics can contain
      // builder paths or matched private text; retain them in the live log.
      outputSha256: createHash('sha256').update(output).digest('hex').toUpperCase(),
    }
    record.gates.push(entryRecord)
    if (outcome.terminationConfirmed === false) lease.markUncertain()
    // Persist process failure BEFORE starting a post-gate seal verifier. The
    // pre-armed worktree guard survives even if this evidence write fails.
    await writeRecordAtomically(recordPath, record)
    if (outcome.terminationConfirmed === false) {
      record.finishedAt = new Date().toISOString()
      record.ok = false
      await writeRecordAtomically(recordPath, record)
      return { ok: false, failed: entry.name, evidencePath: recordPath, record, combinedOutput, terminationConfirmed: false }
    }
    await assertArtifactUnchanged()
    const sourceAfter = gateSourceState ?? describeGateSource(gateSource)
    if (sourceAfter.ref !== source.ref || sourceAfter.dirty !== source.dirty || await gateScriptSha256(gateSource, entry) !== currentScriptHash) {
      throw new Error(`gate ${entry.name}: harness changed while the check ran; verdict cannot be reused`)
    }
    entryRecord.status = code === 0 ? 'passed' : 'failed'
    await writeRecordAtomically(recordPath, record)
    log(`[gate ${entry.name}] exit ${code}`)
    if (code !== 0) {
      ok = false
      failed = entry.name
      break
    }
  }
  record.finishedAt = new Date().toISOString()
  record.ok = ok
  await writeRecordAtomically(recordPath, record)
  return { ok, failed, evidencePath: recordPath, record, combinedOutput }
}

export async function loadEvidence(evidencePath) {
  const resolved = path.resolve(evidencePath)
  const parsed = JSON.parse(await readFile(resolved, 'utf8'))
  if (parsed?.schema !== GATE_EVIDENCE_SCHEMA || parsed?.schemaVersion !== GATE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`${resolved} is not a ${GATE_EVIDENCE_SCHEMA} v${GATE_EVIDENCE_SCHEMA_VERSION} record`)
  }
  if (!parsed.artifact || !parsed.gateSource || !Array.isArray(parsed.gates)) {
    throw new Error(`${resolved} is missing artifact, gateSource or gates`)
  }
  return { path: resolved, record: parsed }
}

function sameArgv(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
}

/* Decide which gates a resumed cut may skip. Returns the accepted Map (name ->
 * {evidencePath, recordedAt, gateSourceRef, sealSha256}) and every rejection
 * with its reason, so the run log and the declaration can both say why a gate
 * ran even though evidence was offered. The rules are conjunctive; there is no
 * partial credit. */
export async function selectSkippableGates({
  evidencePaths = [],
  artifact,
  gateSourcePath,
  gates = POST_BUILD_GATES,
  gateSourceState,
  log = console.log,
}) {
  const accepted = new Map()
  const rejected = []
  if (evidencePaths.length === 0) return { accepted, rejected }
  if (!artifact) throw new Error('selectSkippableGates requires the current artifact identity')
  const gateSource = path.resolve(gateSourcePath)
  const source = gateSourceState ?? describeGateSource(gateSource)
  const currentScriptHashes = new Map()
  for (const entry of gates) currentScriptHashes.set(entry.name, await gateScriptSha256(gateSource, entry))

  for (const evidencePath of evidencePaths) {
    let loaded
    try { loaded = await loadEvidence(evidencePath) } catch {
      rejected.push({ name: '*', evidencePath: path.resolve(evidencePath), reason: 'evidence is missing, unreadable or from an older format; gates will run afresh' })
      continue
    }
    const { path: resolvedPath, record } = loaded
    const reject = (name, reason) => rejected.push({ name, evidencePath: resolvedPath, reason })
    if (record.ok === null || !record.finishedAt || record.gates.some(entry => entry.terminationConfirmed === false || entry.status === 'pending-artifact-verification')) {
      reject('*', 'evidence is incomplete or contains unconfirmed process cleanup; no earlier row from that run can be reused')
      continue
    }
    if (!sameArtifact(record.artifact, artifact)) {
      reject('*', 'evidence was recorded against different artifact bytes (seal or installer hash differs)')
      continue
    }
    if (record.gateSource?.dirty !== false) {
      reject('*', 'evidence was recorded from a gate checkout with uncommitted changes; that harness is not reproducible')
      continue
    }
    if (source.dirty) {
      reject('*', 'the current gate checkout has uncommitted changes; evidence cannot be matched to a reproducible harness')
      continue
    }
    if (record.gateSource.ref !== source.ref || !/^[0-9a-f]{40}$/.test(source.ref)) {
      reject('*', 'the harness commit changed; imported helpers and configuration must match as well as the entry script')
      continue
    }
    for (const entry of record.gates) {
      const table = gateByName(entry.name, gates)
      if (!table) { reject(entry.name, 'gate is not in the current gate table'); continue }
      if (!table.skippable) { reject(entry.name, 'this gate can never be skipped'); continue }
      if (entry.status !== 'passed' || entry.exitCode !== 0) { reject(entry.name, `recorded status is ${entry.status} (exit ${entry.exitCode}), not a pass`); continue }
      if (!sameArgv(entry.argv, table.argv)) { reject(entry.name, 'recorded argv differs from the current gate table'); continue }
      if (entry.gateScriptSha256 !== currentScriptHashes.get(entry.name)) {
        reject(entry.name, 'the gate script has changed since the evidence was recorded; the old verdict came from different harness bytes')
        continue
      }
      if (accepted.has(entry.name)) continue
      accepted.set(entry.name, {
        evidencePath: resolvedPath,
        recordedAt: entry.finishedAt,
        gateSourceRef: record.gateSource.ref,
        gateScriptSha256: entry.gateScriptSha256,
        artifact: record.artifact,
        sealSha256: record.artifact.sealSha256,
      })
    }
  }
  for (const [name, entry] of accepted) log(`[skip-verified] ${name}: accepted (recorded ${entry.recordedAt}, harness ${entry.gateSourceRef})`)
  for (const item of rejected) log(`[skip-verified] ${item.name}: REJECTED -- ${item.reason} (${path.basename(item.evidencePath)})`)
  return { accepted, rejected }
}

/** Declaration-facing summary: what ran, what was skipped and on what evidence.
 * Paths are reduced to basenames here; the facts go through toDeclarableFacts
 * as well, but a record path never carried information a verifier needs. */
export function summarizeGateRun(runResult, { mode }) {
  return {
    mode,
    ok: runResult?.record?.ok ?? null,
    gateSourceRef: runResult?.record?.gateSource?.ref ?? null,
    sealSha256: runResult?.record?.artifact?.sealSha256 ?? null,
    sealRecordedAt: runResult?.record?.artifact?.sealRecordedAt ?? null,
    gates: (runResult?.record?.gates ?? []).map((entry) => ({
      name: entry.name,
      status: entry.status,
      exitCode: entry.exitCode,
      gateScriptSha256: entry.gateScriptSha256,
      ...(entry.evidence
        ? { evidence: { file: path.basename(entry.evidence.path), recordedAt: entry.evidence.recordedAt, gateSourceRef: entry.evidence.gateSourceRef } }
        : {}),
    })),
  }
}
