import path from 'node:path';
import { createHash } from 'node:crypto';
import { plainPath } from './artifact-files.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';

export const SETTINGS_SOURCE_PAIRED_DRIVER = 'tools/qa/settings-source-paired.cjs';
export const SETTINGS_SOURCE_PAIRED_LEAVES = Object.freeze(['tests/settings-rows-inert.test.js']);
const REF = /^[a-f0-9]{40}$/;
const MAX_REPORT = 8 * 1024 * 1024;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fail(message) {
  const error = new Error('Settings audit paired source qualification incomplete: ' + message);
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

export const SETTINGS_SOURCE_PAIRED_ACTION = Object.freeze({
  id: 'app:settings-source-paired',
  command: Object.freeze(['node', SETTINGS_SOURCE_PAIRED_DRIVER]),
  reporter: 'app:settings-source-paired',
  context: 'app-settings-source-paired',
  measuredInputs: Object.freeze([SETTINGS_SOURCE_PAIRED_DRIVER, 'tools/test/lib/source-fixture-root.mjs']),
  pairedLeaves: SETTINGS_SOURCE_PAIRED_LEAVES,
  timeoutMs: 60 * 1000,
});

function requirePairFiles(bound) {
  const appFiles = ['shell/product-settings.cjs', 'shell/tree-slot-policy.mjs', 'tools/test/lib/source-fixture-root.mjs'];
  for (const file of appFiles) plainPath(path.join(bound.root, file), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, 'tests/run-isolated.js'), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, 'tests/lib/settings-source-pair.js'), { kind: 'file' });
  plainPath(path.join(bound.canonicalRoot, 'tests/lib/isolated-environment.js'), { kind: 'file' });
  for (const file of SETTINGS_SOURCE_PAIRED_LEAVES) plainPath(path.join(bound.canonicalRoot, file), { kind: 'file' });
}

// The binding is made before child selector environment is derived. The
// engine leaves are a paired obligation, not generic engine jobs.
export function planSettingsSourcePairedJob(selection, directory, strictInputs) {
  if (selection?.id !== 'app' || selection.root !== strictInputs?.root ||
      selection.canonicalRoot !== strictInputs?.canonicalRoot) {
    fail('selection differs from the measured app/engine inputs');
  }
  const bound = binding({ root: plainPath(selection.root, { kind: 'directory' }),
    canonicalRoot: plainPath(selection.canonicalRoot, { kind: 'directory' }),
    appRef: strictInputs.appRef, engineRef: strictInputs.engineRef });
  requirePairFiles(bound);
  const driver = plainPath(path.join(bound.root, SETTINGS_SOURCE_PAIRED_DRIVER), { kind: 'file' });
  return {
    command: registeredToolPaths().node,
    args: [driver, '--app', bound.root, '--engine', bound.canonicalRoot,
      '--app-ref', bound.appRef, '--engine-ref', bound.engineRef],
    cwd: bound.root,
    env: { TOOLSENABLED_TEST_STRICT: '1' },
    timeoutMs: SETTINGS_SOURCE_PAIRED_ACTION.timeoutMs,
    maxOutputBytes: MAX_REPORT,
    cleanupMs: 5000,
    cleanupGraceMs: process.platform === 'linux' ? 250 : 500,
    file: SETTINGS_SOURCE_PAIRED_DRIVER,
    actionId: SETTINGS_SOURCE_PAIRED_ACTION.id,
    reporter: SETTINGS_SOURCE_PAIRED_ACTION.reporter,
    settingsSourcePairBinding: bound,
  };
}

function strictLeaves(stdout) {
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const markers = lines.map(line => /^STRICT EVIDENCE: ([^ ]+) -- reconciled-tap; (\d+) passed; 0 UNEXECUTED \(within-suite skips\)$/.exec(line))
    .filter(Boolean);
  if (markers.length !== SETTINGS_SOURCE_PAIRED_LEAVES.length) fail('paired child did not report exactly one strict settings leaf');
  markers.forEach((marker, index) => {
    if (marker[1] !== SETTINGS_SOURCE_PAIRED_LEAVES[index] || Number(marker[2]) < 1)
      fail('paired child leaf order/count differs from the fixed suite');
  });
  return { lines, markers };
}

export function parseSettingsSourcePairedTranscript(stdout, stderr, expected) {
  const bound = binding(expected);
  if (typeof stdout !== 'string' || typeof stderr !== 'string' ||
      Buffer.byteLength(stdout) > MAX_REPORT) fail('missing, oversized or failed paired transcript');
  if (stderr.trim()) fail('paired child emitted an unknown warning or error');
  const { lines } = strictLeaves(stdout);
  const marker = 'SETTINGS SOURCE PAIRED: ';
  if (lines.at(-1)?.startsWith(marker) !== true || lines.filter(line => line.startsWith(marker)).length !== 1)
    fail('paired child terminal marker is missing or duplicated');
  let summary;
  try { summary = JSON.parse(lines.at(-1).slice(marker.length)); } catch { fail('paired child terminal marker is malformed'); }
  if (!summary || summary.schema !== 'toolsenabled.settings-source-paired.v1' ||
      summary.appRoot !== bound.root || summary.engineRoot !== bound.canonicalRoot ||
      summary.appRef !== bound.appRef || summary.engineRef !== bound.engineRef ||
      summary.childExitCode !== 0 || summary.skipped !== 0 ||
      !same(summary.files, SETTINGS_SOURCE_PAIRED_LEAVES)) {
    fail('paired child did not report the exact bound roots, refs, leaves and exit state');
  }
  const descriptor = { appRoot: bound.root, engineRoot: bound.canonicalRoot, appRef: bound.appRef, engineRef: bound.engineRef };
  const descriptorSha256 = createHash('sha256').update(JSON.stringify(descriptor) + '\n').digest('hex');
  const fixture = ordinaryAbsolute(summary.retainedFixtureRoot, 'retained fixture root');
  if (!/^te-source-fixture-[a-zA-Z0-9]{6}$/.test(path.basename(fixture)) ||
      summary.descriptor?.path !== path.join(fixture, 'settings-source-pair.json') ||
      summary.descriptor.sha256 !== descriptorSha256) fail('paired descriptor custody differs from the bound sources');
  const engineState = ordinaryAbsolute(summary.retainedEngineStateRoot, 'retained engine state root');
  // The Dev account's Windows Temp folder. The account name is a placeholder, and the
  // path is joined at run time so the source carries no literal profile path.
  const expectedBase = process.platform === 'win32'
    ? path.win32.join('C:\\', 'Users', 'BuildAccount-Dev', 'AppData', 'Local', 'Temp') : fixture;
  const equal = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!equal(path.dirname(engineState), expectedBase) || !/^te-[A-Za-z0-9]{6}$/.test(path.basename(engineState)))
    fail('retained engine state differs from the isolated runner producer');
  return { tests: SETTINGS_SOURCE_PAIRED_LEAVES.length, passed: SETTINGS_SOURCE_PAIRED_LEAVES.length,
    failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 };
}
