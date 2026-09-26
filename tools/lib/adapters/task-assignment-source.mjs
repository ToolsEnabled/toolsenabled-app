import path from 'node:path';
import { plainPath } from './artifact-files.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';

export const TASK_ASSIGNMENT_DRIVER = 'tools/qa/task-assignment-paired.cjs';
export const TASK_ASSIGNMENT_SUITE = 'tests/suites/task-assignment.txt';
export const TASK_ASSIGNMENT_LEAVES = Object.freeze([
  'tests/task-assignment-authority.test.js',
  'tests/task-assignment-transaction.test.js',
  'tests/task-assignment-composition.test.js',
  'tests/owner-host-task-assignment-transport.test.js',
]);
const REF = /^[a-f0-9]{40}$/;
const MAX_REPORT = 8 * 1024 * 1024;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fail(message) {
  const error = new Error('Task-assignment paired source qualification incomplete: ' + message);
  error.code = 'SOURCE_QUALIFICATION_INCOMPLETE';
  throw error;
}

function ordinaryAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      /[\x00-\x1f]/.test(value)) fail(`${name} must be an ordinary absolute path`);
  return value;
}

function binding(value) {
  if (!value || !REF.test(value.appRef || '') || !REF.test(value.engineRef || ''))
    fail('the paired action needs exact app and engine source refs');
  const root = ordinaryAbsolute(value.root, 'app root');
  const canonicalRoot = ordinaryAbsolute(value.canonicalRoot, 'engine root');
  if (root === canonicalRoot) fail('app and engine roots must be distinct');
  return { ...value, root, canonicalRoot };
}

export const TASK_ASSIGNMENT_SOURCE_ACTION = Object.freeze({
  id: 'app:task-assignment-paired',
  command: Object.freeze(['node', TASK_ASSIGNMENT_DRIVER]),
  reporter: 'app:task-assignment-paired',
  context: 'app-task-assignment-paired',
  measuredInputs: Object.freeze([TASK_ASSIGNMENT_DRIVER, 'tools/qa/settings-source-paired.cjs', 'tools/test/lib/source-fixture-root.mjs']),
  pairedLeaves: TASK_ASSIGNMENT_LEAVES,
  timeoutMs: 10 * 60 * 1000,
});

function requirePairFiles(bound) {
  const appFiles = ['shell/main.cjs', 'shell/task-assignment-target-authority.cjs',
    'tools/qa/settings-source-paired.cjs', 'tools/test/lib/source-fixture-root.mjs'];
  for (const file of appFiles) plainPath(path.join(bound.root, file), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, 'tests/run-isolated.js'), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, 'tests/lib/isolated-environment.js'), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, TASK_ASSIGNMENT_SUITE), { kind: 'file' });
  for (const file of TASK_ASSIGNMENT_LEAVES) plainPath(path.join(bound.canonicalRoot, file), { kind: 'file' });
}

// The binding is made before child selector environment is derived. The
// engine leaves are a paired obligation, not generic engine jobs.
export function planTaskAssignmentSourceJob(selection, directory, strictInputs) {
  if (selection?.id !== 'app' || selection.root !== strictInputs?.root ||
      selection.canonicalRoot !== strictInputs?.canonicalRoot) {
    fail('selection differs from the measured app/engine inputs');
  }
  const bound = binding({ root: plainPath(selection.root, { kind: 'directory' }),
    canonicalRoot: plainPath(selection.canonicalRoot, { kind: 'directory' }),
    appRef: strictInputs.appRef, engineRef: strictInputs.engineRef });
  requirePairFiles(bound);
  const driver = plainPath(path.join(bound.root, TASK_ASSIGNMENT_DRIVER), { kind: 'file' });
  return {
    command: registeredToolPaths().node,
    args: [driver, '--app', bound.root, '--engine', bound.canonicalRoot,
      '--app-ref', bound.appRef, '--engine-ref', bound.engineRef],
    cwd: bound.root,
    env: { TOOLSENABLED_TEST_STRICT: '1' },
    timeoutMs: TASK_ASSIGNMENT_SOURCE_ACTION.timeoutMs,
    maxOutputBytes: MAX_REPORT,
    cleanupMs: 5000,
    cleanupGraceMs: process.platform === 'linux' ? 250 : 500,
    file: TASK_ASSIGNMENT_DRIVER,
    actionId: TASK_ASSIGNMENT_SOURCE_ACTION.id,
    reporter: TASK_ASSIGNMENT_SOURCE_ACTION.reporter,
    taskAssignmentBinding: bound,
  };
}

function strictLeaves(stdout) {
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const markers = lines.map(line => /^STRICT EVIDENCE: ([^ ]+) -- reconciled-tap; (\d+) passed; 0 UNEXECUTED \(within-suite skips\)$/.exec(line))
    .filter(Boolean);
  if (markers.length !== TASK_ASSIGNMENT_LEAVES.length) fail('paired child did not report exactly four strict leaves');
  markers.forEach((marker, index) => {
    if (marker[1] !== TASK_ASSIGNMENT_LEAVES[index] || Number(marker[2]) < 1)
      fail('paired child leaf order/count differs from the fixed suite');
  });
  return { lines, markers };
}

function isOwnerHostCloseDiagnostic(line) {
  let row;
  try { row = JSON.parse(line); } catch { return false; }
  return row && !Array.isArray(row) &&
    Object.keys(row).sort().join(',') === 'atMs,event,reason,sessionId' &&
    row.event === 'owner-host-session-retired' && row.reason === 'owner-host-closed' &&
    typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId.length <= 256 &&
    !/[\x00-\x1f]/.test(row.sessionId) && Number.isSafeInteger(row.atMs) && row.atMs > 0;
}

function validateRetainedStderr(stderr, retainedEngineStateRoot) {
  const lines = String(stderr || '').replaceAll('\r\n', '\n').split('\n').filter(Boolean);
  for (const line of lines) {
    const match = /^Isolated test state retained by request: (.+)$/.exec(line);
    const owned = match && (process.platform === 'win32'
      ? match[1].toLowerCase() === retainedEngineStateRoot.toLowerCase() : match[1] === retainedEngineStateRoot);
    if ((!match || !owned || /[\x00-\x1f]/.test(match[1])) &&
        !isOwnerHostCloseDiagnostic(line))
      fail('paired child emitted an unknown warning or error');
  }
}

export function parseTaskAssignmentSourceTranscript(stdout, stderr, expected) {
  const bound = binding(expected);
  if (typeof stdout !== 'string' || typeof stderr !== 'string' ||
      Buffer.byteLength(stdout) > MAX_REPORT) fail('missing, oversized or failed paired transcript');
  const { lines } = strictLeaves(stdout);
  const marker = 'TASK ASSIGNMENT PAIRED: ';
  if (lines.at(-1)?.startsWith(marker) !== true || lines.filter(line => line.startsWith(marker)).length !== 1)
    fail('paired child terminal marker is missing or duplicated');
  let summary;
  try { summary = JSON.parse(lines.at(-1).slice(marker.length)); } catch { fail('paired child terminal marker is malformed'); }
  if (!summary || summary.schema !== 'toolsenabled.task-assignment-paired.v1' ||
      summary.appRoot !== bound.root || summary.engineRoot !== bound.canonicalRoot ||
      summary.appRef !== bound.appRef || summary.engineRef !== bound.engineRef ||
      summary.childExitCode !== 0 || summary.skipped !== 0 ||
      !same(summary.files, TASK_ASSIGNMENT_LEAVES)) {
    fail('paired child did not report the exact bound roots, refs, leaves and exit state');
  }
  const fixture = ordinaryAbsolute(summary.retainedFixtureRoot, 'retained fixture root');
  const state = ordinaryAbsolute(summary.retainedEngineStateRoot, 'retained engine state root');
  // The Dev account's Windows Temp folder. The account name is a placeholder, and the
  // path is joined at run time so the source carries no literal profile path.
  const expectedBase = process.platform === 'win32'
    ? path.win32.join('C:\\', 'Users', 'BuildAccount-Dev', 'AppData', 'Local', 'Temp') : fixture;
  const equal = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!/^te-source-fixture-[A-Za-z0-9]{6}$/.test(path.basename(fixture)) ||
      !equal(path.dirname(state), expectedBase) || !/^te-[A-Za-z0-9]{6}$/.test(path.basename(state)))
    fail('retained engine state differs from the isolated runner producer');
  validateRetainedStderr(stderr, state);
  return { tests: TASK_ASSIGNMENT_LEAVES.length, passed: TASK_ASSIGNMENT_LEAVES.length,
    failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 };
}
