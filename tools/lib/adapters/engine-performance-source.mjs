import path from 'node:path';
import { plainPath } from './artifact-files.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';

const definitions = [
  { id: 'engine:cold-start', file: 'tools/cold-start-check.js', timeoutMs: 190000 },
  { id: 'engine:idle-cpu', file: 'tools/idle-cpu-check.js', timeoutMs: 150000 },
];
export const ENGINE_PERFORMANCE_ACTIONS = Object.freeze(definitions.map(row => Object.freeze({
  id: row.id, command: Object.freeze(['node', row.file]), reporter: 'engine:native-performance',
  context: 'engine-isolated-performance', timeoutMs: row.timeoutMs,
  measuredInputs: Object.freeze(['tests/run-isolated.js', 'tests/lib/isolated-environment.js',
    'tests/lib/isolated-child.js', 'tools/lib/test-completion.js', row.file,
    'src/mcp-server.js', 'src/lib/providers/subscription-launch-env.js',
    ...(row.id === 'engine:idle-cpu' ? ['tools/lib/process-cpu-sample.js'] : [])]),
})));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(message) {
  const error = new Error('Engine performance qualification incomplete: ' + message);
  error.code = 'SOURCE_QUALIFICATION_INCOMPLETE';
  throw error;
}
function definition(id) {
  const value = definitions.find(row => row.id === id);
  if (!value) fail('unknown fixed performance action');
  return value;
}
function binding(value, action) {
  if (!value || value.actionId !== action.id || !/^[a-f0-9]{40}$/.test(value.sourceRef || '') ||
    !['linux', 'win32'].includes(value.platform) || value.platform !== process.platform ||
    value.arch !== process.arch ||
    !['root', 'summaryPath'].every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]) &&
      path.normalize(value[key]) === value[key] && !/[\x00-\x1f]/.test(value[key]))) {
    fail('exact source and current native platform context are required');
  }
  return value;
}

// Use the existing isolated runner and the actual gate, never a replacement MCP
// fixture. The ordinary source executor must still validate clean provenance,
// owned-job process containment/cleanup, and this exact one-file summary.
// This planner does not admit execution or authorize runner teardown deletion.
export function planEnginePerformanceSourceJob(selection, actionId, directory, sourceRef) {
  const action = definition(actionId);
  if (selection?.id !== 'engine') fail('only the selected Engine source can run these gates');
  const root = plainPath(selection.root, { kind: 'directory' });
  const evidence = plainPath(directory, { kind: 'directory' });
  const relative = path.relative(root, evidence);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    fail('performance evidence must be outside the selected Engine source');
  }
  const summaryPath = path.join(evidence, action.id.replace(':', '-') + '.json');
  plainPath(summaryPath, { missingLeaf: true });
  const performanceBinding = binding({ actionId, root, summaryPath, sourceRef,
    platform: process.platform, arch: process.arch }, action);
  return {
    command: registeredToolPaths().node,
    args: [plainPath(path.join(root, 'tests/run-isolated.js'), { kind: 'file' }),
      '--config-integrity', '--timeout-ms', String(action.timeoutMs), '--summary', summaryPath,
      action.file],
    cwd: root, env: { TOOLSENABLED_TEST_STRICT: '1' }, timeoutMs: action.timeoutMs + 10000,
    cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500, maxOutputBytes: 1024 * 1024,
    file: plainPath(path.join(root, action.file), { kind: 'file' }), actionId, reporter: 'engine:native-performance',
    summaryPath, performanceBinding,
  };
}
function transcript(stdout, stderr, job) {
  const action = definition(job?.actionId);
  const bound = binding(job.performanceBinding, action);
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || stderr.trim() ||
    Buffer.byteLength(stdout) > 1024 * 1024 || job.reporter !== 'engine:native-performance' ||
    job.command !== registeredToolPaths().node || job.cwd !== bound.root ||
    job.file !== path.join(bound.root, action.file) || job.summaryPath !== bound.summaryPath ||
    !same(job.args, [path.join(bound.root, 'tests/run-isolated.js'), '--config-integrity',
      '--timeout-ms', String(action.timeoutMs), '--summary', bound.summaryPath, action.file]) ||
    !same(job.env, { TOOLSENABLED_TEST_STRICT: '1' })) fail('command, environment or isolated transcript context differs');
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n');
  if (lines.pop() !== 'STRICT EVIDENCE: ' + action.file + ' -- process-exit; assertion count not reported') {
    fail('the exact isolated gate did not finish');
  }
  return { lines, action };
}
function coldStart(lines) {
  const script = path.join('src', 'mcp-server.js');
  if (lines.length !== 6 || lines[0] !== 'Measuring cold start: spawn ' + script + ', send initialize, time the first response.' ||
    lines[5] !== 'PASS: cold start is within the stated ceiling.') fail('cold start did not complete all client measurements');
  const attempts = lines.slice(1, 4).map((line, index) => {
    const match = /^  attempt ([1-3]): ([0-9]+\.[0-9]{2})s$/.exec(line);
    if (!match || Number(match[1]) !== index + 1) fail('cold start attempts are missing, duplicated or reordered');
    return Number(match[2]);
  });
  const measured = /^Slowest of 3: ([0-9]+\.[0-9]{2})s\.  Ceiling: 2\.5s\.$/.exec(lines[4]);
  if (!measured || attempts.some(value => !Number.isFinite(value) || value > 2.5) ||
    Number(measured[1]) !== Math.max(...attempts)) fail('cold start slowest observation or fixed ceiling does not reconcile');
}
function idleCpu(lines) {
  const script = path.join('src', 'mcp-server.js');
  if (lines.length !== 5 ||
    lines[0] !== 'Spawning ' + script + ' exactly as a real MCP client would (stdin open, unwritten)...' ||
    lines[3] !== 'Ceiling: 1% of one core, sustained while idle.' ||
    lines[4] !== 'PASS: idle CPU is within the stated ceiling.') fail('idle CPU did not report its fixed native measurement');
  const floor = "Startup was already quiet at the first look (<= 7.0s, this check's floor); sampling idle from here.";
  const settled = /^Startup settled ([0-9]+\.[0-9])s after spawn; sampling idle from here\.$/.exec(lines[1]);
  if (lines[1] !== floor && (!settled || !Number.isFinite(Number(settled[1])) || Number(settled[1]) < 7)) {
    fail('idle CPU did not observe startup settling');
  }
  const measured = /^pid ([1-9][0-9]*): ([0-9]+\.[0-9]{4})s CPU consumed over ([0-9]+\.[0-9]{2})s idle \(no requests sent\) = ([0-9]+\.[0-9]{4})% of one core\.$/.exec(lines[2]);
  if (!measured) fail('idle CPU interval is missing or malformed');
  const [pid, cpu, elapsed, percent] = measured.slice(1).map(Number);
  if (!Number.isSafeInteger(pid) || ![cpu, elapsed, percent].every(Number.isFinite) ||
    elapsed < 30 || percent > 1) fail('idle CPU interval or fixed ceiling is incomplete');
  // Reports round CPU/percent to four places and elapsed time to two. Require
  // overlapping rounding intervals; the bound gate itself rules on unrounded
  // native counters. Text precision is not misrepresented as extra precision.
  const low = Math.max(0, cpu - 0.00005) * 100 / (elapsed + 0.005);
  const high = (cpu + 0.00005) * 100 / (elapsed - 0.005);
  if (percent + 0.00005 < low || percent - 0.00005 > high) fail('idle CPU counter and percentage observations disagree');
}

export function parseEnginePerformanceTranscript(stdout, stderr, job) {
  const { lines, action } = transcript(stdout, stderr, job);
  if (action.id === 'engine:cold-start') coldStart(lines);
  else idleCpu(lines);
  // Supplemental command proof does not invent assertion counts or replace
  // native platform/installer obligations or the independently counted census.
  return { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 };
}
