import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LINUX_MEASUREMENT_ROOT = '/mnt/qualification-input/measurement';
export const LINUX_MEASUREMENT_PATHS = Object.freeze({
  runtime: `${LINUX_MEASUREMENT_ROOT}/node-v22.19.0`,
  producer: `${LINUX_MEASUREMENT_ROOT}/tools/lib/guest/linux-installed-measurement.mjs`,
  reader: `${LINUX_MEASUREMENT_ROOT}/tools/lib/guest/linux-installed-state.mjs`,
  dependency: `${LINUX_MEASUREMENT_ROOT}/tools/lib/adapters/artifact-files.mjs`,
});
export const LINUX_MEASUREMENT_NODE = Object.freeze({ version: 'v22.19.0', bytes: 121674800,
  sha256: '596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9' });
export const LINUX_MEASUREMENT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const linuxMeasurementDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function refuseLinuxMeasurement(message) {
  const error = new Error(`Linux installed measurement refused: ${message}`);
  error.code = 'LINUX_INSTALLED_MEASUREMENT_REFUSED';
  throw error;
}

export function validateLinuxMeasurementRequest(request) {
  const refuse = refuseLinuxMeasurement;
  if (!keys(request, ['schema', 'schemaVersion', 'measurementNonce', 'requestContext', 'expectedInputs', 'requireVerifiedLifecycleEpoch']) ||
      request.schema !== 'toolsenabled.linux-installed-measurement-request' || request.schemaVersion !== 1 ||
      !UUID.test(request.measurementNonce || '') || request.requireVerifiedLifecycleEpoch !== false) refuse('measurement-only request required; verified lifecycle epoch unavailable');
  const context = request.requestContext;
  if (!keys(context, ['subjectSha256', 'expectedSubject', 'run', 'phaseId']) || !HASH.test(context.subjectSha256 || '') ||
      !keys(context.run, ['id', 'startedAt']) || !UUID.test(context.run.id || '') ||
      typeof context.run.startedAt !== 'string' || !Number.isFinite(Date.parse(context.run.startedAt)) ||
      typeof context.phaseId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(context.phaseId)) refuse('exact request run/phase context required; epoch labels are not authority');
  const subject = context.expectedSubject;
  if (!keys(subject, ['product', 'version', 'target', 'artifact', 'stageSha256', 'runtimeSha256', 'sourceSha256', 'sourceRefs']) ||
      subject.product !== 'toolsenabled' || typeof subject.version !== 'string' || !/^[0-9][^\s\0]{0,63}$/.test(subject.version) ||
      !keys(subject.target, ['platform', 'arch']) || subject.target.platform !== 'linux' || subject.target.arch !== 'x64' ||
      !keys(subject.artifact, ['sha256', 'bytes']) || !HASH.test(subject.artifact.sha256 || '') ||
      !Number.isSafeInteger(subject.artifact.bytes) || subject.artifact.bytes <= 0 ||
      ![subject.stageSha256, subject.runtimeSha256, subject.sourceSha256].every(value => HASH.test(value || '')) ||
      !keys(subject.sourceRefs, ['app', 'engine']) || !Object.values(subject.sourceRefs).every(value => REF.test(value || ''))) refuse('exact expected artifact/version/source pair required');
  if (!keys(request.expectedInputs, Object.keys(LINUX_MEASUREMENT_PATHS))) refuse('complete fixed measurement input pins required');
  for (const [name, value] of Object.entries(request.expectedInputs)) {
    if (!keys(value, ['sha256', 'bytes']) || !HASH.test(value.sha256 || '') || !Number.isSafeInteger(value.bytes) ||
        value.bytes <= 0 || value.bytes > (name === 'runtime' ? 256 * 1024 * 1024 : 1024 * 1024)) refuse('invalid measurement input pin');
  }
  if (request.expectedInputs.runtime.sha256 !== LINUX_MEASUREMENT_NODE.sha256 ||
      request.expectedInputs.runtime.bytes !== LINUX_MEASUREMENT_NODE.bytes) refuse('pinned measurement runtime required');
  if (Buffer.byteLength(JSON.stringify(request)) > 8192) refuse('typed request exceeds argv bound');
  return request;
}

// This bootstrap cannot import the reader or its dependency until their exact
// bytes have been checked. All paths are fixed; no request selects a root/tool.
function measuredInput(file, expected) {
  if (fs.realpathSync(file) !== file) refuseLinuxMeasurement('linked measurement input');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expected.bytes)) refuseLinuxMeasurement('measurement input type/size differs');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, expected.bytes + 1 - bytes), null);
      if (!count) break;
      bytes += count; hash.update(buffer.subarray(0, count));
      if (bytes > expected.bytes) refuseLinuxMeasurement('measurement input grew');
    }
    const after = fs.fstatSync(fd, { bigint: true }), atPath = fs.lstatSync(file, { bigint: true });
    const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (fields.some(key => before[key] !== after[key] || before[key] !== atPath[key])) refuseLinuxMeasurement('measurement input changed during read');
    const sha256 = hash.digest('hex');
    if (bytes !== expected.bytes || sha256 !== expected.sha256) refuseLinuxMeasurement('measurement input bytes differ');
    return { path: file, bytes, sha256, identity: Object.fromEntries(fields.map(key => [key, String(before[key])])) };
  } finally { fs.closeSync(fd); }
}
function inputClosure(expectedInputs) {
  return Object.fromEntries(Object.entries(LINUX_MEASUREMENT_PATHS).map(([name, file]) => [name, measuredInput(file, expectedInputs[name])]));
}

/** Filesystem observation only. Request context is never reset/restore proof. */
export async function produceLinuxInstalledMeasurement(input) {
  const request = validateLinuxMeasurementRequest(input);
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== LINUX_MEASUREMENT_NODE.version ||
      process.execPath !== LINUX_MEASUREMENT_PATHS.runtime || fileURLToPath(import.meta.url) !== LINUX_MEASUREMENT_PATHS.producer ||
      !Number.isSafeInteger(process.getuid()) || process.getuid() <= 0) refuseLinuxMeasurement('fixed ordinary-user Linux reader process required');
  const startedAt = new Date().toISOString();
  const before = inputClosure(request.expectedInputs);
  const { readLinuxInstalledState } = await import(LINUX_MEASUREMENT_PATHS.reader);
  const installedState = readLinuxInstalledState({ root: '/' });
  const after = inputClosure(request.expectedInputs);
  if (linuxMeasurementDigest(before) !== linuxMeasurementDigest(after)) refuseLinuxMeasurement('measurement closure changed around execution');
  const result = {
    schema: 'toolsenabled.linux-installed-measurement', schemaVersion: 1,
    proofScope: 'filesystem-measurement-only', attested: false, qualified: false,
    measurementNonce: request.measurementNonce, requestDigest: linuxMeasurementDigest(request),
    requestContext: request.requestContext,
    observed: { root: '/', uid: process.getuid(), processId: process.pid, runtimeVersion: process.version,
      startedAt, finishedAt: new Date().toISOString(), inputs: after, installedState },
    lifecycleEpoch: { available: false, reason: 'No driver-owned reset/restoration epoch proof is supplied by this measurement.' },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > LINUX_MEASUREMENT_OUTPUT_LIMIT - 1) refuseLinuxMeasurement('installed measurement exceeds RPC output bound');
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 8192) refuseLinuxMeasurement('one bounded typed request argument required');
    const result = await produceLinuxInstalledMeasurement(JSON.parse(process.argv[2]));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write((error.code || error.name) + ': ' + String(error.message).slice(0, 2048) + '\n');
    process.exitCode = 1;
  }
}
