import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digestRecord, measureFile, plainPath, readBounded, contains, JSON_LIMIT } from '../adapters/artifact-files.mjs';
import { assertLinuxInstalledState } from '../guest/linux-installed-state.mjs';

const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROFILES = ['linux-x64-standard', 'linux-x64-install-authorized'];
export const LINUX_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function block(message) {
  const error = new Error(`Linux lifecycle evidence blocked: ${message}`);
  error.code = 'LINUX_LIFECYCLE_EVIDENCE_BLOCKED'; throw error;
}
const same = (a, b) => a?.sha256 === b?.sha256 && a?.bytes === b?.bytes;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
function privatePath(root, file) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') block('Linux evidence reader required');
  root = plainPath(root, { kind: 'directory' });
  file = plainPath(file, { kind: 'file' });
  if (file === root || !contains(root, file)) block('raw report escapes private evidence root');
  for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) block('evidence directories must be private and owned');
    if (cursor === root) break;
  }
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) block('raw report must be private, owned and singly linked');
  return file;
}

/** Independently reread raw bytes and check binding/integrity only.
 * No caller report, boolean or digest grants native guest authority. A future
 * reviewed transport must authenticate observations before adapter acceptance.
 * All times bind to the harness run supplied separately from the raw report. */
export function readLinuxLifecycleEvidence(observation, subject, { run, required, implementationSha256, signal } = {}) {
  if (signal?.aborted) block('cancelled');
  if (subject?.product !== 'toolsenabled' || subject.target?.platform !== 'linux' || subject.target.arch !== 'x64' ||
      !HASH.test(subject.artifact?.sha256 || '') || !Number.isSafeInteger(subject.artifact.bytes) || subject.artifact.bytes <= 0 ||
      !HASH.test(subject.runtimeSha256 || '') || !HASH.test(subject.stageSha256 || '') || !HASH.test(subject.sourceSha256 || '') ||
      !REF.test(subject.sourceRefs?.app || '') || !REF.test(subject.sourceRefs?.engine || '') ||
      Object.keys(subject.sourceRefs).sort().join(',') !== 'app,engine') block('exact Debian artifact, runtime and source pair required');
  const subjectSha256 = digestRecord(subject), now = Date.now(), runStart = timestamp(run?.startedAt);
  if (!UUID.test(run?.id || '') || run.scope !== 'full-release-qualification' || !Number.isFinite(runStart) ||
      runStart > now || now - runStart > LINUX_EVIDENCE_MAX_AGE_MS) block('missing, future or stale harness run');
  if (!required?.id || !Array.isArray(required.assertions) || !required.assertions.length ||
      new Set(required.assertions).size !== required.assertions.length || !HASH.test(implementationSha256 || '')) block('reviewed requirement and implementation identity required');
  if (observation?.id !== required.id || observation.scope !== required.scope || observation.adapterId !== `linux:${required.id}:v1` ||
      observation.adapterSha256 !== implementationSha256 || observation.subjectSha256 !== subjectSha256 ||
      observation.runId !== run.id || !PROFILES.includes(observation.profile) || observation.observedRuntimeSha256 !== subject.runtimeSha256 ||
      !same(observation.installer, subject.artifact)) block('observation artifact/runtime/profile/run binding differs');
  const file = privatePath(subject.context?.evidenceRoot, observation.report?.path);
  const before = measureFile(file, { maximum: JSON_LIMIT });
  if (!same(before, observation.report)) block('raw report hash or length changed');
  const bytes = readBounded(file, JSON_LIMIT);
  if (bytes.length !== before.bytes || createHash('sha256').update(bytes).digest('hex') !== before.sha256) block('raw report changed during read');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { block('raw report is not JSON'); }
  const after = measureFile(privatePath(subject.context.evidenceRoot, file), { maximum: JSON_LIMIT });
  if (!same(before, after)) block('raw report changed during verification');
  const start = timestamp(record?.startedAt), finish = timestamp(record?.finishedAt);
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema !== 'toolsenabled.linux-lifecycle-execution' || record.schemaVersion !== 1 ||
      record.product !== subject.product || record.subjectSha256 !== subjectSha256 || !same(record.artifact, subject.artifact) ||
      record.runtimeSha256 !== subject.runtimeSha256 || record.stageSha256 !== subject.stageSha256 ||
      record.sourceSha256 !== subject.sourceSha256 || digestRecord(record.sourceRefs) !== digestRecord(subject.sourceRefs) ||
      record.profile !== observation.profile || record.runId !== run.id || record.implementationSha256 !== implementationSha256 ||
      record.startedAt !== observation.startedAt || record.finishedAt !== observation.finishedAt ||
      !Number.isFinite(start) || !Number.isFinite(finish) || start < runStart || finish < start || finish > now) block('raw report identity or freshness differs');
  const environment = record.environment;
  if (environment?.platform !== 'linux' || environment.arch !== 'x64' || environment.profile !== record.profile ||
      environment.isolation !== 'disposable-machine' || environment.isolated !== true ||
      !Number.isSafeInteger(environment.runtimeUid) || environment.runtimeUid <= 0 ||
      !UUID.test(environment.guestId || '') || !UUID.test(environment.epochId || '') ||
      digestRecord(environment) !== digestRecord(observation.environment)) block('native Linux environment/profile binding missing');
  if (record.complete !== true || record.cleanupConfirmed !== true || record.fixture !== false ||
      !record.cleanup || record.cleanup.guestId !== environment.guestId || record.cleanup.epochId !== environment.epochId ||
      record.cleanup.runId !== run.id || record.cleanup.ownedJobsRemaining !== 0 ||
      record.cleanup.baselineRestored !== true || !HASH.test(record.cleanup.evidenceSha256 || '')) block('owned guest cleanup evidence missing');
  const expected = [...required.assertions].sort(), assertions = record.assertions;
  if (!Array.isArray(assertions) || assertions.length !== expected.length ||
      digestRecord(assertions.map(row => row.id).sort()) !== digestRecord(expected) ||
      assertions.some(row => row.status !== 'passed' || !HASH.test(row.evidenceSha256 || '')) ||
      digestRecord(assertions) !== digestRecord(observation.assertions)) block('required assertions missing, duplicated or changed');
  const measuredAt = timestamp(record.installedState?.observedAt);
  if (!Number.isFinite(measuredAt) || measuredAt < start || measuredAt > finish) block('installed measurement is outside the current execution');
  assertLinuxInstalledState(record.installedState, subject);
  if (signal?.aborted) block('cancelled');
  return { qualified: false, attested: false, proofScope: 'raw-report-integrity-only', record, measurement: before };
}
