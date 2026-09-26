import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { contains, plainPath, readBounded } from './artifact-files.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';

const require = createRequire(import.meta.url);
const { scenarios } = require('../page2-native-role-scenarios.cjs');
const { dependencyPin } = require('../native-driver-dependencies.cjs');
const IDS = Object.freeze(scenarios.map(scenario => scenario.id));
const DRIVER = 'tools/qa/page2-role-studio-interaction.cjs';
const SCOPE = 'Actual Role Studio component and App/Engine stores; fixture navigation and IPC envelope, no full-app or provider qualification';
const REF = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_REPORT = 1024 * 1024;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function fail(message) {
  const error = new Error('Role Studio source qualification incomplete: ' + message);
  error.code = 'SOURCE_QUALIFICATION_INCOMPLETE';
  throw error;
}

export const ROLE_STUDIO_SOURCE_ACTION = Object.freeze({
  id: 'app:role-studio-component',
  command: Object.freeze(['node', DRIVER]),
  reporter: 'app:role-studio-component',
  context: 'app-role-studio-component',
  measuredInputs: Object.freeze(['package-lock.json', DRIVER, 'tools/lib/native-driver-dependencies.cjs',
    'tools/lib/sterile-launch.cjs', 'tools/lib/page2-native-role-scenarios.cjs',
    'tools/lib/page2-native-scenarios.cjs', 'tools/test/helpers/page2-role-studio-renderer.mjs',
    'shell/agent-org-record.cjs']),
  timeoutMs: 10 * 60 * 1000,
});

function binding(value) {
  if (!value || !REF.test(value.appRef || '') || !REF.test(value.engineRef || '') ||
      !['root', 'canonicalRoot', 'outputRoot'].every(key => typeof value[key] === 'string' &&
        path.isAbsolute(value[key]) && path.normalize(value[key]) === value[key] && !/[\x00-\x1f]/.test(value[key]))) {
    fail('explicit exact app/engine source refs and ordinary absolute paths are required');
  }
  if (value.root === value.canonicalRoot || contains(value.root, value.outputRoot) || contains(value.canonicalRoot, value.outputRoot)) {
    fail('evidence must be outside both source trees');
  }
  return value;
}

// The source executor supplies the same measured sourceBinding as every app
// job. No dependency-kit overrides, caller runner or caller executable exist.
export function planRoleStudioSourceJob(selection, directory, strictInputs) {
  if (selection?.id !== 'app' || selection.root !== strictInputs?.root ||
      selection.canonicalRoot !== strictInputs?.canonicalRoot) fail('selection differs from measured app/engine inputs');
  const root = plainPath(selection.root, { kind: 'directory' });
  const canonicalRoot = plainPath(selection.canonicalRoot, { kind: 'directory' });
  const parent = plainPath(directory, { kind: 'directory' });
  const outputRoot = plainPath(path.join(parent, 'role-studio-component'), { missingLeaf: true });
  const roleStudioBinding = binding({ root, canonicalRoot, outputRoot, appRef: strictInputs.appRef, engineRef: strictInputs.engineRef });
  return { command: registeredToolPaths().node,
    args: [plainPath(path.join(root, DRIVER), { kind: 'file' }), '--app', root, '--engine', canonicalRoot, '--out', outputRoot],
    cwd: root, env: { TOOLSENABLED_TEST_STRICT: '1' }, timeoutMs: ROLE_STUDIO_SOURCE_ACTION.timeoutMs,
    maxOutputBytes: MAX_REPORT, cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500,
    file: DRIVER, actionId: ROLE_STUDIO_SOURCE_ACTION.id, reporter: ROLE_STUDIO_SOURCE_ACTION.reporter, roleStudioBinding };
}

export function parseRoleStudioSourceTranscript(stdout, stderr, expected) {
  binding(expected);
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || stderr.trim() ||
      Buffer.byteLength(stdout) > MAX_REPORT) fail('missing, oversized or failed transcript');
  const marker = 'Role component evidence: ';
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const index = lines.findIndex(line => line.startsWith(marker));
  if (index !== IDS.length || !same(lines.slice(0, index), IDS.map(id => 'Component case: ' + id)) ||
      lines.filter(line => line.startsWith(marker)).length !== 1) fail('the exact declared scenario sequence was not executed');
  const directory = lines[index].slice(marker.length);
  if (path.dirname(directory) !== expected.outputRoot || !/^role-component-[a-zA-Z0-9]{6}$/.test(path.basename(directory))) {
    fail('reported evidence escaped the allocated role component directory');
  }
  let summary;
  try { summary = JSON.parse(lines.slice(index + 1).join('\n')); } catch { fail('the terminal component summary is missing or malformed'); }
  if (!summary || Object.keys(summary).some(key => !['passed', 'results'].includes(key)) ||
      summary.passed !== true || !same(summary.results, IDS.map(id => ({ id, passed: true })))) {
    fail('the complete declared scenario results did not pass');
  }
  return { directory, summary };
}

// Pure value validation is also used by the production reader below. These
// values are necessary evidence, never a stand-alone release observation:
// source-suites additionally verifies the owned job, exact pair before/after,
// native process cleanup, and the retained report's byte identity.
export function validateRoleStudioSourceEvidence(report, transcript, expected, pin) {
  binding(expected);
  if (report?.scope !== SCOPE || report.passed !== true || report.closed !== true || report.failure ||
      !Array.isArray(report.errors) || report.errors.length || !same(report.requiredCases, IDS) ||
      !same(report.results, transcript.summary.results)) fail('component evidence is incomplete, failed, or not closed');
  const dependencies = report.dependencies;
  if (!dependencies || dependencies.scope !== 'prepared-local' || dependencies.qualificationEligible !== true ||
      !pin || !HASH.test(pin.sha256 || '') || dependencies.archiveSha256 !== pin.sha256 ||
      dependencies.version !== pin.version || dependencies.platform !== pin.platform || dependencies.arch !== pin.arch ||
      !Number.isSafeInteger(dependencies.files) || dependencies.files < 1 ||
      dependencies.modulesDirectory !== path.join(expected.root, 'node_modules') ||
      dependencies.executable !== path.join(expected.root, 'node_modules', 'electron', 'dist', pin.platform === 'win32' ? 'electron.exe' : 'electron') ||
      dependencies.playwrightModule !== path.join(expected.root, 'node_modules', 'playwright')) {
    fail('dependencies lack the prepared local pinned-archive qualification proof');
  }
  const bootstrap = report.bootstrap;
  if (bootstrap?.ready !== true || bootstrap.electron !== pin.version || !Array.isArray(bootstrap.argv) ||
      !same(bootstrap.argv.slice(-4), [path.join(expected.root, DRIVER), transcript.directory, expected.root, expected.canonicalRoot])) {
    fail('the actual component process did not bind the selected app and engine');
  }
  if (!Array.isArray(report.events) || !report.events.length || !Array.isArray(report.writes) || !report.writes.length ||
      !report.guidePreparation || !Array.isArray(report.guidePreparation.states) || !report.guidePreparation.states.length ||
      !same(report.guideReload, report.guidePreparation.states.at(-1))) fail('role changes or persistent guide state were not observed');
  return { tests: IDS.length, passed: IDS.length, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 };
}

export function verifyRoleStudioSourceFiles(stdout, stderr, expectedJob) {
  const expected = expectedJob.roleStudioBinding;
  const transcript = parseRoleStudioSourceTranscript(stdout, stderr, expected);
  const directory = plainPath(transcript.directory, { kind: 'directory' });
  const filename = plainPath(path.join(directory, 'evidence.json'), { kind: 'file' });
  const bytes = readBounded(filename, MAX_REPORT);
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('retained evidence is not bounded UTF-8 JSON'); }
  const counts = validateRoleStudioSourceEvidence(report, transcript, expected, dependencyPin(expected.root));
  return { scope: 'exact-source-component', sourceRefs: { app: expected.appRef, engine: expected.engineRef },
    counts, report: { path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
