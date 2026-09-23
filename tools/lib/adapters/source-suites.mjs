import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCE_MANIFESTS, SOURCE_COMMAND_ACTIONS, SOURCE_RUNNER_REQUIREMENTS, SOURCE_LEAF_REPORTS } from './source-suite-manifests.mjs';
import { ROLE_STUDIO_SOURCE_ACTION, planRoleStudioSourceJob, parseRoleStudioSourceTranscript,
  verifyRoleStudioSourceFiles } from './role-studio-source.mjs';
import { ENGINE_PERFORMANCE_ACTIONS, planEnginePerformanceSourceJob, parseEnginePerformanceTranscript } from './engine-performance-source.mjs';
import { reconcileSourceCommands, sourceCaseExecutionRequirement, requiredNativeSourceCases } from './source-command-plan.mjs';
import { measureSourceHarnesses, sourceHarnessImplementationIdentity, measureNativeCustodyHarness } from './source-harness.mjs';
import { measureTree, readBounded } from './artifact-files.mjs';
import { cleanSourceSnapshot, nativeCleanSourceSnapshot } from './artifact-source.mjs';
import { NATIVE_CUSTODY_ACTION, NATIVE_CUSTODY_LEAVES, NATIVE_CONTEXT_PREFIX,
  nativeCustodyInputs, nativeCustodyArguments, assertNativeCustodyEvidence } from '../runners/native-custody-source.mjs';
import { fileIdentity, fencedPath, unlinkedPath, runOwnedJobBatch, registeredToolEnvironment,
  measureRegisteredToolchain } from '../transport/owned-job.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { node: NODE, python: PYTHON, powershell: PS } = registeredToolPaths();
const ASSERTIONS = ['selection-reconciled', 'required-tests-executed', 'zero-unexplained-skips'];
const OMIT_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'release', 'state', 'logs', 'data', '__pycache__', '.venv', 'venv']);
const SOURCE_EXTENSIONS = /\.(?:[cm]?js|py|ps1|html|css|json|txt|ya?ml|ts|tsx|jsx)$/i;
const json = value => JSON.stringify(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(json(value));
const portable = value => value.split(path.sep).join('/');
const counts = tests => ({ tests, passed: tests, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 });
function fail(message) { const error = new Error(`Source qualification incomplete: ${message}`); error.code = 'SOURCE_QUALIFICATION_INCOMPLETE'; throw error; }
function inside(root, file) { const relative = path.relative(root, file); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }
function at(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '')) fail('invalid source-relative path');
  const file = fencedPath(path.join(root, relative));
  if (!inside(root, file)) fail('source path escaped its root');
  return file;
}
function readJson(file) { return JSON.parse(fs.readFileSync(unlinkedPath(file), 'utf8')); }
function identity(file, options) { const { sha256, bytes } = fileIdentity(file, options); return { sha256, bytes }; }
function optionalIdentity(file) {
  try { return identity(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function implementation() { return sourceHarnessImplementationIdentity(); }
function walk(root, prefix = '', state = { count: 0 }) {
  const directory = unlinkedPath(prefix ? at(root, prefix) : root, { directory: true });
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (OMIT_DIRS.has(entry.name)) continue; // Never resolve ignored output/state/link targets.
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`linked input: ${relative}`);
    if (++state.count > 30000) fail('source inventory exceeds the bounded 30,000-entry budget');
    if (entry.isDirectory()) out.push(...walk(root, relative, state));
    else if (entry.isFile()) out.push(relative);
    else fail(`non-regular input: ${relative}`);
  }
  return out.sort();
}
function sourceRoot(id, context) {
  const roots = context?.sourceRoots;
  const key = ['app', 'engine'].includes(id) ? id : 'website';
  if (!roots || typeof roots[key] !== 'string' || !path.isAbsolute(roots[key])) fail(`missing explicit ${key} source root`);
  const checkout = unlinkedPath(roots[key], { directory: true });
  const component = ['reaper', 'loops', 'agents'].includes(id) ? 'presentation-suite' : id;
  return { checkout, root: key === 'website' ? unlinkedPath(at(checkout, `software/${component}`), { directory: true }) : checkout, key, component };
}
function candidateFiles(component, root) {
  if (component === 'app') {
    // Only deliberately inventoried imported helpers join the test-file census.
    // They remain measured inputs, never invented standalone test executions.
    const helpers = new Set(SOURCE_MANIFESTS.app.inventory
      .filter(entry => entry.reason === 'imported-fixture-helper').map(entry => entry.file));
    return walk(root, 'tools/test').filter(file => /\.test\.mjs$/.test(file) || helpers.has(file));
  }
  if (component === 'engine') return [...walk(root, 'tests').filter(file => /\.[cm]?js$/.test(file)),
    ...walk(root, 'tools').filter(file => /\.(?:test|selftest)\.[cm]?js$/.test(file))].sort();
  return walk(root).filter(file => /\.test\.(?:[cm]?js|py|ps1)$/.test(file) || /(?:^|\/)test[_-][^/]+\.(?:js|py)$/.test(file) ||
    (component === 'shared' && file === 'design-tools/test.js'));
}
function aliasesFor(root) {
  const scripts = readJson(at(root, 'package.json')).scripts || {};
  return Object.fromEntries(Object.entries(scripts).filter(([name]) => /^(?:pretest|posttest|test(?::|$)|verify(?::|$))/.test(name) && name !== 'test:release')
    .sort(([left], [right]) => left.localeCompare(right)));
}

function assertDeclaredInputPaths(root, action, contract) {
  const expected = contract.paths;
  if (!Array.isArray(expected) || !expected.length || new Set(expected).size !== expected.length ||
      ![contract.file, ...expected].every(file => action.measuredInputs.includes(file))) fail('unbound fixed declaration-path contract');
  // Read only the fixed, fenced configuration file. Bounded reads also reject
  // growth beyond the budget; candidate-declared paths never reach the FS.
  const handle = fs.openSync(unlinkedPath(at(root, contract.file)), 'r');
  let document;
  try {
    const limit = 1024 * 1024;
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > limit) fail('declaration-path input exceeds its byte budget');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const size = fs.readSync(handle, bytes, length, bytes.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length > limit) fail('declaration-path input exceeds its byte budget');
    document = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { fs.closeSync(handle); }
  const entries = document && !Array.isArray(document) && document[contract.property];
  if (!Array.isArray(entries) || entries.length !== expected.length) fail('required declaration paths are incomplete');
  const declared = entries.map(entry => entry && !Array.isArray(entry) && typeof entry === 'object' ? entry.file : null);
  if (new Set(declared).size !== expected.length || declared.some(file => !expected.includes(file))) fail('required declaration paths differ from the fixed source contract');
}

// This exact alias adds no runner work beyond its direct Node test leaves.
// Only actual nonempty discovery covered by the required selection discharges it.
export function appSurfaceRunnerCoverage(discovered, selectedFiles) {
  const matches = discovered.filter(file => /^tools\/test\/surface-tests-[^/]*\.test\.mjs$/.test(file));
  const selected = new Set(selectedFiles);
  return matches.length && matches.every(file => selected.has(file))
    ? [['node', '--test', 'tools/test/surface-tests-*.test.mjs']] : [];
}

// A fixed file census supplements default aliases; it does not claim the
// default aliases already selected the entire tree. Every supplemental file is
// named, deduplicated, and run once by this qualification selection.
export function inspectSourceSuite(id, context) {
  if (!Object.hasOwn(SOURCE_MANIFESTS, id) && !['reaper', 'loops', 'agents'].includes(id)) fail(`unknown source suite ${id}`);
  const location = sourceRoot(id, context), { root, component } = location;
  const manifest = SOURCE_MANIFESTS[component];
  const discovered = candidateFiles(component, root);
  const expected = manifest.inventory.map(entry => entry.file);
  const missing = expected.filter(file => !discovered.includes(file));
  const extra = discovered.filter(file => !expected.includes(file));
  const aliases = aliasesFor(root);
  const changedAliases = [...new Set([...Object.keys(aliases), ...Object.keys(manifest.aliases)])]
    .filter(name => aliases[name] !== manifest.aliases[name]);
  const obligations = [];
  if (missing.length) obligations.push({ id: 'missing-tests', files: missing });
  if (extra.length) obligations.push({ id: 'unreconciled-tests', files: extra });
  if (changedAliases.length) obligations.push({ id: 'changed-required-aliases', aliases: changedAliases });
  for (const [name, command] of Object.entries(aliases)) {
    if (typeof command !== 'string' || !command.trim() || /(?:^|\s)tests[\\/]run-isolated\.js\s*$/.test(command)) obligations.push({ id: 'empty-required-alias', alias: name });
  }
  if (id === 'scribe') obligations.push({ id: 'external-integration-unmapped', alias: 'test:live',
    files: ['test/test_agent_live.js', 'test/test_flow_live.js'], reason: 'Paid/provider integration needs its own fixed required contract and real evidence; never run under the source-only no-provider authority.' });
  if (id === 'presentation-suite') obligations.push({ id: 'fixture-contract-unmapped', file: 'final_deck_acceptance.test.py',
    reason: 'The intended 17-slide acceptance corpus needs a reviewed immutable fixture mapping, not the developer data directory.' });
  let files = manifest.inventory.filter(entry => !entry.reason).map(entry => entry.file);
  if (id === 'scribe') files = files.filter(file => !['test/test_agent_live.js', 'test/test_flow_live.js'].includes(file));
  if (id === 'presentation-suite') files = files.filter(file => !['reaper.test.js', 'looprunner.test.js', 'final_deck_acceptance.test.py'].includes(file));
  if (id === 'reaper') files = ['reaper.test.js'];
  if (id === 'loops') files = ['looprunner.test.js'];
  if (id === 'agents') files = ['reaper.test.js', 'looprunner.test.js'];
  const crossFiles = id === 'presentation-suite' ? ['software/assets/slide1-neon/test_neon_overlay.py'] :
    ['scribe', 'web-editor'].includes(id) ? ['software/shared/provider-connections.test.js'] : [];
  for (const file of crossFiles) try { unlinkedPath(at(location.checkout, file)); } catch { obligations.push({ id: 'missing-cross-suite', file }); }
  const commands = SOURCE_COMMAND_ACTIONS[id] || [];
  for (const action of commands) {
    const [, file] = action.command;
    try { unlinkedPath(at(root, file)); } catch { obligations.push({ id: 'missing-required-command', file }); }
    for (const required of [...(action.requiredFiles || []), ...(action.leafReports || []).map(leaf => leaf.file), ...(action.isolatedReports || []).map(leaf => leaf.file)]) if (!files.includes(required)) {
      obligations.push({ id: 'unselected-required-action-test', action: action.id, file: required });
    }
    for (const input of action.measuredInputs || []) try { unlinkedPath(at(root, input)); }
    catch { obligations.push({ id: 'missing-required-action-input', action: action.id, file: input }); }
    for (const contract of action.declaredPathInputs || []) try { assertDeclaredInputPaths(root, action, contract); }
    catch { obligations.push({ id: 'unreconciled-required-input-paths', action: action.id, file: contract.file, property: contract.property }); }
  }
  for (const requirement of SOURCE_RUNNER_REQUIREMENTS[id] || []) {
    for (const file of requirement.requiredFiles) try { unlinkedPath(at(root, file)); }
    catch { obligations.push({ id: 'missing-required-runner-test', runner: requirement.runner, file }); }
  }
  // Subcomponents do not inherit the entire presentation alias tree: their
  // fixed parent suite still reconciles it and cannot qualify without them.
  const commandPlan = reconcileSourceCommands({
    aliases: ['reaper', 'loops', 'agents', 'shell'].includes(id) ? {} : aliases,
    selectedFiles: files, coveredCommands: [...commands.flatMap(action => [action.command, ...(action.satisfies || [])]),
      ...(id === 'app' ? [['node', '--test', '--import=./tools/test/lib/isolate-native-state-root.mjs',
        '--test-reporter=tap', '--test-concurrency=1', 'tools/test/*.test.mjs'],
        ...appSurfaceRunnerCoverage(discovered, files)] : [])],
    contextCommands: commands.filter(action => ['app-strict-engine-scratch', 'app-role-studio-component', 'engine-isolated-performance'].includes(action.context)),
    readSuiteList: file => fs.readFileSync(unlinkedPath(at(root, file)), 'utf8'),
  });
  obligations.push(...commandPlan.obligations);
  if (id !== 'shell' && !files.length) obligations.push({ id: 'zero-selection' });
  return { id, ...location, manifestSha256: digest(manifest), discovered, files, crossFiles,
    ...(id === 'app' && context.sourceRoots.engine ? { canonicalRoot: unlinkedPath(context.sourceRoots.engine, { directory: true }) } : {}),
    exclusions: manifest.inventory.filter(entry => entry.reason), aliases, commands, commandPlan, obligations, complete: obligations.length === 0 };
}

// These snapshots bind actual test and helper source bytes, including same-size
// and nested edits. The core's independent subject measurer additionally binds
// clean checkout refs, complete payload and dependency closure. No state/secrets
// or installed scope is inferred from this source-only snapshot.
function snapshot(selection) {
  const { root, component, checkout } = selection;
  let files = component === 'app' ? [...walk(root, 'tools'), ...walk(root, 'src')] :
    component === 'engine' ? [...walk(root, 'tests'), ...walk(root, 'tools'), ...walk(root, 'src')] : walk(root);
  files = [...new Set([...files.filter(file => SOURCE_EXTENSIONS.test(file) && !/(?:^|\/)(?:secrets?|credentials?|tokens?)(?:\.|\/)/i.test(file)),
    'package.json', ...selection.commands.flatMap(action => action.measuredInputs || [])])].sort();
  let total = 0;
  const entries = files.map(file => { const measured = identity(at(root, file)); total += measured.bytes; if (total > 512 * 1024 * 1024) fail('source input byte budget exceeded'); return { file, ...measured }; });
  const optional = [...new Set(selection.commands.flatMap(action => action.optionalMeasuredInputs || []))].sort()
    .map(file => {
      const measured = optionalIdentity(at(root, file));
      total += measured?.bytes || 0;
      if (total > 512 * 1024 * 1024) fail('source input byte budget exceeded');
      return { file, present: measured !== null, ...(measured || {}) };
    });
  const cross = selection.crossFiles.map(file => ({ file, ...identity(at(checkout, file)) }));
  return { entries, optional, cross, sha256: digest({ entries, optional, cross }) };
}

// Bind every interpreter on the child search path, including runtimes invoked
// by a JavaScript test rather than by a top-level .py/.ps1 test file.
function registeredTools() { return measureRegisteredToolchain(); }

// Node TAP is parsed as a tree, not merely by its final # fail line. The
// verifier independently reconciles every plan, ordinal and terminal summary.
export function parseSourceTap(output) {
  const measured = inspectSourceTap(output);
  if ([...measured.cases, ...measured.containers].some(entry => entry.failed || entry.skipped)) fail('failed/skipped/TODO TAP test');
  if (measured.counts.passed < 1) fail('TAP counts/plan do not reconcile or contain incomplete coverage');
  return counts(measured.counts.passed);
}

// Read-only diagnostic parsing preserves actual pass/fail/unexecuted counts.
// It cannot qualify a source suite; parseSourceTap above still requires every
// assertion to execute and pass. A zero-execution report is evidence of a gap.
export function inspectSourceTap(output) {
  if (typeof output !== 'string' || !/^TAP version 13\r?$/m.test(output)) fail('missing TAP header');
  const groups = [{ indent: 0, count: 0, plan: null }], results = [], summaries = new Map();
  let current;
  const groupFor = (indent, isResult) => {
    let group = groups.at(-1);
    if (indent < group.indent) {
      if (!isResult || group.plan !== group.count || group.indent !== indent + 4) fail('incomplete nested TAP plan or parent');
      groups.pop(); group = groups.at(-1);
    }
    if (indent > group.indent) {
      if (group.plan !== null || indent % 4 !== 0 || indent > 128) fail('invalid TAP nesting');
      // A deeply nested leaf reports before any ancestor result. Retain each
      // intermediate group so its later plan and parent must still reconcile.
      while (indent > group.indent) { group = { indent: group.indent + 4, count: 0, plan: null }; groups.push(group); }
    }
    if (group.plan !== null) fail('duplicate TAP plan or late result');
    return group;
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Bail out!/i.test(line)) fail('TAP bailout');
    const result = /^( *)(not ok|ok) (\d+) - (.*)$/.exec(line);
    if (result) {
      const group = groupFor(result[1].length, true);
      if (Number(result[3]) !== ++group.count) fail('TAP ordinal mismatch');
      if (/ # TODO(?:\s|$)/i.test(result[4])) fail('failed/skipped/TODO TAP test');
      const skipped = / # SKIP(?:\s|$)/i.test(result[4]);
      if (skipped && result[2] !== 'ok') fail('contradictory failed and skipped TAP result');
      current = { indent: result[1].length, suite: false, failed: result[2] !== 'ok', skipped,
        name: result[4].replace(/ # SKIP(?:\s.*)?$/i, '').replace(/\\(.)/g, '$1'),
        skipReason: skipped ? result[4].split(/ # SKIP(?:\s|$)/i).slice(1).join(' ') : null };
      results.push(current); continue;
    }
    if (/^\s*(?:not ok|ok)\b/.test(line)) fail('malformed TAP result');
    const plan = /^( *)1\.\.(\d+)$/.exec(line);
    if (plan) { const group = groupFor(plan[1].length, false); group.plan = Number(plan[2]); if (group.plan !== group.count) fail('TAP plan mismatch'); continue; }
    if (/^\s*\d+\.\./.test(line)) fail('malformed TAP plan');
    if (current && line === `${' '.repeat(current.indent + 2)}type: 'suite'`) { current.suite = true; continue; }
    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary) { if (summaries.has(summary[1])) fail('duplicate TAP summary'); summaries.set(summary[1], Number(summary[2])); }
  }
  const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  if (keys.some(key => !summaries.has(key))) fail('incomplete TAP summary');
  const measured = Object.fromEntries(summaries), cases = results.filter(entry => !entry.suite), tests = cases.length;
  if (Object.values(measured).some(value => !Number.isSafeInteger(value)) ||
    groups.length !== 1 || groups[0].plan !== groups[0].count || tests < 1 || measured.tests !== tests ||
    measured.pass !== cases.filter(entry => !entry.failed && !entry.skipped).length ||
    measured.fail !== cases.filter(entry => entry.failed).length || measured.skipped !== cases.filter(entry => entry.skipped).length ||
    measured.suites !== results.length - tests || ['cancelled', 'todo'].some(key => measured[key] !== 0)) fail('TAP counts/plan do not reconcile or contain incomplete coverage');
  return { counts: { tests, passed: measured.pass, failed: measured.fail, skipped: measured.skipped, cancelled: 0, todo: 0, notRun: measured.skipped },
    cases, containers: results.filter(entry => entry.suite) };
}

export function inspectSourceExecutionCoverage(stdout, { suite, files, platform }) {
  const measured = inspectSourceTap(stdout);
  const obligations = [...measured.cases, ...measured.containers].filter(entry => entry.skipped).map(entry => ({
    ...sourceCaseExecutionRequirement({ suite, files, platform, testName: entry.name }), reportedReason: entry.skipReason,
  }));
  const nativeCases = requiredNativeSourceCases(suite, files).map(requirement => {
    const matches = measured.cases.filter(entry => entry.name === requirement.testName);
    if (matches.length !== 1) {
      obligations.push({ ...requirement, kind: matches.length ? 'ambiguous-required-native-case' : 'missing-required-native-case', status: 'unexecuted' });
      return { ...requirement, status: 'unexecuted' };
    }
    const entry = matches[0];
    if (!entry.skipped && platform !== requirement.requiredPlatform) obligations.push({ ...requirement, kind: 'companion-platform-required', status: 'unexecuted' });
    return { ...requirement, status: entry.skipped ? 'unexecuted' : entry.failed ? 'failed' :
      platform === requirement.requiredPlatform ? 'observed-pass' : 'wrong-platform-observation' };
  });
  return { scope: 'source-execution-coverage-analysis', ready: false, platform, counts: measured.counts,
    failures: [...measured.cases, ...measured.containers].filter(entry => entry.failed).map(entry => entry.name), obligations, nativeCases };
}

const SINGLE_FILE_FOOTERS = new Set([
  'first-run setup truth tests passed',
  'ok - openai-compatible end to end, named refusals, and closed-world arguments',
  'Memory provider tests passed.',
  'Evidence package tests passed (schema lifecycle, transaction guard, rollback, close, collection certainty, verification).',
]);
const ACTION_FOOTERS = Object.freeze({
  'engine:memory-assertion-file': 'Memory provider tests passed.',
  'engine:evidence-assertion-file': 'Evidence package tests passed (schema lifecycle, transaction guard, rollback, close, collection certainty, verification).',
});
const NAMED_LEAF_REPORTS = SOURCE_COMMAND_ACTIONS.engine.flatMap(action => action.leafReports || []);
const ISOLATED_LEAF_REPORTS = [...SOURCE_COMMAND_ACTIONS.engine.flatMap(action => action.isolatedReports || []), ...SOURCE_LEAF_REPORTS.engine];
const LEAF_REPORT_LINE = /^\s*(?:TAP version|not ok\b|ok(?:\s|:)|PASS\b|FAIL(?:ED)?\b)|\b(?:tests?|checks?) passed\b/i;
function parseLeafReports(stdout, leaves, stderr = '') {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim());
  if (stderr.split(/\r?\n/).some(line => LEAF_REPORT_LINE.test(line))) fail('unassigned required leaf report on stderr');
  const claimed = new Set();
  let last = -1;
  for (const leaf of leaves) for (const [markerIndex, marker] of leaf.markers.entries()) {
    const pattern = marker.pattern ? new RegExp(marker.pattern) : null;
    const matches = lines.map((line, index) => ({ index, match: pattern ? pattern.exec(line) : line === marker.exact ? [line] : null }))
      .filter(entry => entry.match);
    if (matches.length !== 1 || matches[0].index <= last) fail(`missing, duplicate or reordered required leaf report: ${leaf.file}`);
    const { index, match } = matches[0];
    if ((marker.positiveGroups || []).some(group => !Number.isSafeInteger(Number(match[group])) || Number(match[group]) < 1)) fail(`empty required leaf report: ${leaf.file}`);
    if (Object.entries(marker.exactGroups || {}).some(([group, expected]) => Number(match[group]) !== expected) ||
      (marker.previousMarkersGroup !== undefined && Number(match[marker.previousMarkersGroup]) !== markerIndex)) fail(`required leaf count does not reconcile: ${leaf.file}`);
    claimed.add(index); last = index;
  }
  if (!leaves.length || last !== lines.length - 1 || lines.some((line, index) => !claimed.has(index) &&
    LEAF_REPORT_LINE.test(line))) fail('unassigned or incomplete runner leaf report');
  return counts(leaves.length); // Observed assertion-file executions, not guessed assertion totals.
}
// Current engine run-isolated emits one completion line AFTER each child's
// complete output. These are boundaries, not an assertion count by themselves:
// process-exit still needs the fixed assertion report below; TAP is reconciled.
function splitIsolatedTranscript(stdout, expectedFiles) {
  const lines = stdout.replaceAll('\r\n', '\n').split('\n');
  const chunks = [];
  let body = [];
  for (const line of lines) {
    if (!line.startsWith('STRICT EVIDENCE:')) { body.push(line); continue; }
    const marker = /^STRICT EVIDENCE: (.+) -- (?:process-exit; assertion count not reported|reconciled-tap; ([1-9][0-9]*) passed; 0 UNEXECUTED \(within-suite skips\))$/.exec(line);
    if (!marker || marker[1] !== expectedFiles[chunks.length] || !body.some(line => line.trim())) fail('isolated transcript has an empty, extra, malformed or reordered child');
    const output = body.join('\n').trimEnd();
    if (marker[2]) {
      if (parseSourceTap(output).passed !== Number(marker[2])) fail('isolated child TAP differs from its completion count');
    } else if (/^TAP version /m.test(output)) fail('TAP child was mislabeled as uncounted process exit');
    chunks.push(output); body = [];
  }
  if (!expectedFiles.length || chunks.length !== expectedFiles.length || body.some(line => line.trim())) fail('isolated transcript did not complete every required child');
  return chunks;
}

function parseIsolatedLeaf(stdout, stderr, leaf) {
  if (/^(?:\s*(?:not ok\b|FAIL(?:ED)?\b|STRICT INCOMPLETE:|AssertionError\b|Error:))/im.test(`${stdout}\n${stderr}`)) fail('isolated assertion program reported failure');
  if (leaf.tap) return parseSourceTap(stdout);
  const footer = leaf.footer, lines = stdout.trimEnd().split(/\r?\n/);
  const matches = lines.map(line => footer?.pattern ? new RegExp(footer.pattern).exec(line) : line === footer?.exact ? [line] : null).filter(Boolean);
  const final = lines.at(-1);
  if (!footer || matches.length !== 1 || !(footer.pattern ? new RegExp(footer.pattern).test(final) : final === footer.exact)) fail(`missing, duplicated or incomplete assertion footer: ${leaf.file}`);
  if ((footer.positiveGroups || []).some(group => !Number.isSafeInteger(Number(matches[0][group])) || Number(matches[0][group]) < 1)) fail('assertion program reported an empty population');
  if (footer.countPattern && (Number(matches[0][footer.countGroup]) < 1 ||
    Number(matches[0][footer.countGroup]) !== lines.filter(line => new RegExp(footer.countPattern).test(line)).length)) fail('assertion program result lines do not reconcile with its count');
  if ((leaf.requiredLines || []).some(required => lines.filter(line => line === required).length !== 1)) fail('assertion program omitted a required completed check');
  return counts(1); // One observed assertion-file execution, never an invented assertion count.
}

// These are observed CLI reports, not source-text locks. An empty program, help
// mode, stale generator or developer failure baseline cannot provide one. Raw
// stdout/stderr and the exact invocation remain persisted and independently
// replayed; structural observations deliberately contribute zero test cases.
const NATIVE_RECEIPT_PREFIX = 'NATIVE CUSTODY RECEIPT: ';
const LINUX_CUSTODY_PHASES = Object.freeze([
  "PASS explicit vault boundary unit cases (real Linux custody integration follows)",
  "PASS fixed Linux startup hygiene proves no-store without D-Bus and refuses unknown/unsafe stores or another key",
  "PASS real vault, lock, metadata-log and backing-file FIFOs never block, consume, or rewrite fixture bytes",
  "PASS real isolated libsecret backend is available without an application vault",
  "PASS one real persistent helper serves warm requests, is reaped on close and restarts cleanly",
  "PASS audit shutdown drains queued native readers and confirms helper exit",
  "PASS production runtime persists and reopens encrypted credentials across processes",
  "PASS concurrent real disconnects remove exactly one authenticated device credential and preserve machine identity",
  "PASS native disposable pre/at/post-replace and lost-receipt faults preserve truthful mutation evidence; not power-loss proof",
  "PASS existing native vault hygiene requires trusted custody and refuses protected records without decryption",
  "PASS asynchronous desktop reads bind an explicit state root without blocking or changing process.env",
  "PASS coupled writes, definite absence, and oracle refusals use the production backend",
  "PASS auth-profile lifecycle uses real isolated Linux custody; authenticated browsing remains unavailable",
  "PASS six real concurrent processes choose exactly one creation candidate",
  "PASS monotonic writes refuse rollback, forks, and mismatched embedded sequences",
  "PASS kernel locking refuses contention and releases after the lock holder dies",
  "PASS real ciphertext tampering, record substitution, unsafe files, and foreign formats refuse",
  "PASS real Ed25519 audit survives restart and refuses a rolled-back ledger",
  "PASS vault credentials and signed audit survive a full private GNOME daemon restart",
  "PASS a missing service key is unreadable and is never silently replaced",
  "PASS locking the real keyring invalidates warm reads and signed-audit admission; no plaintext reached disk",
  "PASS a real passwordless GNOME keyring is refused as unsafe"
]);
const WINDOWS_CUSTODY_CASE = 'native Windows vault preserves DPAPI format and rechecks changed DACLs and reparse points';

// The receipt can bind custody, but cannot manufacture the leaf's assertions.
// Its exact selected transcript is reconciled separately, including every
// Linux phase or the one complete Windows TAP case. Counts remain leaf-owned.
function parseNativeCustodyReport(stdout, stderr, options) {
  const binding = options.custodyBinding;
  if (options.actionId !== NATIVE_CUSTODY_ACTION.id || options.file !== NATIVE_CUSTODY_ACTION.command[1]
      || !binding || !Object.hasOwn(NATIVE_CUSTODY_LEAVES, binding.platform)
      || binding.root !== options.cwd || binding.scratch !== path.join(binding.directory, 'nc')
      || binding.inputsSha256 !== canonicalDigest(binding.inputs)
      || json(Object.keys(binding.inputs).sort()) !== json([...NATIVE_CUSTODY_ACTION.measuredInputs].sort())
      || Object.values(binding.inputs).some(row => !row || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || !/^[a-f0-9]{64}$/.test(row.sha256))
      || stderr.trim()) fail('native custody lacks its fixed measured context');
  const selected = NATIVE_CUSTODY_LEAVES[binding.platform];
  const companionPlatform = binding.platform === 'linux' ? 'win32' : 'linux';
  const companion = NATIVE_CUSTODY_LEAVES[companionPlatform];
  const lines = stdout.replaceAll('\r\n', '\n').split('\n');
  if (lines.pop() !== '') fail('native custody transcript is unterminated');
  const contextLine = lines.pop(), receiptLine = lines.pop();
  if (!contextLine?.startsWith(NATIVE_CONTEXT_PREFIX) || !receiptLine?.startsWith(NATIVE_RECEIPT_PREFIX)
      || lines.some(line => line.includes(NATIVE_CONTEXT_PREFIX) || line.includes(NATIVE_RECEIPT_PREFIX))) fail('native custody receipts are missing, duplicated or misplaced');
  let receipt, context;
  try { receipt = JSON.parse(receiptLine.slice(NATIVE_RECEIPT_PREFIX.length)); context = JSON.parse(contextLine.slice(NATIVE_CONTEXT_PREFIX.length)); }
  catch { fail('native custody receipt is malformed'); }
  if (receiptLine !== NATIVE_RECEIPT_PREFIX + json(receipt) || contextLine !== NATIVE_CONTEXT_PREFIX + json(context))
    fail('native custody receipt encoding is ambiguous');
  const wantedReceipt = { schema: 'toolsenabled.native-custody-source-execution', platform: binding.platform,
    selected: { file: selected, sha256: binding.inputs[selected].sha256 },
    exitCode: 0, signal: null, errorCode: null, cleanupConfirmed: true, inputsUnchanged: true, passed: true,
    companion: [{ platform: companionPlatform, file: companion, sha256: binding.inputs[companion].sha256, status: 'unexecuted' }],
    authority: 'Per-host source execution only; paired exact-source native receipts and installed qualification remain required.' };
  const wantedContext = { schema: 'toolsenabled.native-custody-source-context', root: binding.root, scratch: binding.scratch,
    inputsSha256: binding.inputsSha256, inputsUnchanged: true, exitCode: 0, signal: null, errorCode: null, cleanupConfirmed: true };
  if (canonicalDigest(receipt) !== canonicalDigest(wantedReceipt) || canonicalDigest(context) !== canonicalDigest(wantedContext))
    fail('native custody receipt differs from actual selected inputs, execution or companion obligations');
  const [body] = splitIsolatedTranscript(lines.join('\n') + '\n', [selected]);
  if (binding.platform === 'linux') {
    if (json(body.split('\n')) !== json(LINUX_CUSTODY_PHASES)) fail('native Linux custody did not complete its exact required phases');
  } else {
    if (body.split('\n').filter(line => line === 'TAP version 13').length !== 1
        || /^\s*(?:#\s*)?(?:PASS\b|FAIL(?:ED)?\b|STRICT INCOMPLETE:|AssertionError\b|Error:)/m.test(body))
      fail('native Windows custody contains an unassigned assertion or failure');
    const tap = inspectSourceTap(body);
    if (parseSourceTap(body).passed !== 1 || tap.cases.length !== 1 || tap.containers.length !== 0
        || tap.cases[0].name !== WINDOWS_CUSTODY_CASE) fail('native Windows custody did not complete its exact TAP contract');
  }
  return counts(0);
}

function parseActionReport(stdout, stderr, options) {
  const { reporter, cwd, file } = options;
  if (reporter === 'engine:native-performance') return parseEnginePerformanceTranscript(stdout, stderr, options);
  if (reporter === 'engine:native-custody') return parseNativeCustodyReport(stdout, stderr, options);
  if (reporter === 'app:strict-release') return parseStrictReleaseReport(stdout, stderr, options);
  if (reporter === ROLE_STUDIO_SOURCE_ACTION.reporter) {
    parseRoleStudioSourceTranscript(stdout, stderr, options.roleStudioBinding);
    // Supplemental component evidence has its own nine measured cases; the
    // leaf census remains the source assertion count. verifyJob and replay
    // independently require its retained, exact-source evidence below.
    return counts(0);
  }
  if (reporter === 'engine:isolated-transcript') {
    const action = SOURCE_COMMAND_ACTIONS.engine.find(action => action.id === options.actionId && action.reporter === reporter);
    if (!action?.isolatedReports?.length) fail('unknown fixed isolated runner action');
    const chunks = splitIsolatedTranscript(stdout, action.isolatedReports.map(leaf => leaf.file));
    chunks.forEach((chunk, index) => parseIsolatedLeaf(chunk, stderr, action.isolatedReports[index]));
    return counts(0); // The separate source census jobs count each leaf.
  }
  if (reporter === 'engine:isolated-leaf') {
    const relative = cwd && file ? portable(path.relative(cwd, file)) : null;
    const leaf = ISOLATED_LEAF_REPORTS.find(leaf => leaf.file === relative);
    if (!leaf) fail('unknown fixed isolated leaf report');
    return parseIsolatedLeaf(stdout, stderr, leaf);
  }
  const lines = stdout.trim().split(/\r?\n/);
  const one = pattern => {
    const matches = lines.map(line => pattern.exec(line)).filter(Boolean);
    if (matches.length !== 1) fail(`missing or duplicate ${reporter} report`);
    return matches[0];
  };
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const terminal = expected => { if (lines.at(-1) !== expected) fail(`incomplete ${reporter} report`); };
  const runner = SOURCE_COMMAND_ACTIONS.engine.find(action => action.reporter === reporter && action.leafReports);
  if (runner) return parseLeafReports(stdout, runner.leafReports, stderr);
  if (reporter === 'engine:registered-leaf') {
    const relative = cwd && file ? portable(path.relative(cwd, file)) : null;
    const leaf = NAMED_LEAF_REPORTS.find(entry => entry.file === relative);
    if (!leaf) fail('unregistered individual leaf report');
    return parseLeafReports(stdout, [leaf], stderr);
  }
  if (Object.hasOwn(ACTION_FOOTERS, reporter)) {
    terminal(ACTION_FOOTERS[reporter]);
    if (lines.filter(line => line === ACTION_FOOTERS[reporter]).length !== 1) fail(`duplicate ${reporter} assertion-file report`);
    return counts(1);
  }
  if (stderr.trim()) fail(`unexpected stderr from ${reporter}`);
  if (reporter === 'engine:naming-policy') {
    const nonempty = lines.filter(line => line.trim());
    if (nonempty.length !== 4) fail('naming policy did not report its exact rule set');
    for (const rule of ['source-basename-not-kebab', 'test-dir-singular', 'interface-name-renamed']) {
      const result = one(new RegExp(`^\\s*(\\d+)\\s+${rule}$`));
      if (!Number.isSafeInteger(Number(result[1]))) fail('invalid naming policy count');
    }
    terminal('naming ratchet OK');
    return counts(0);
  }
  if (reporter === 'engine:invocation-policy') {
    if (lines[0] !== 'INVOCATION GUARD') fail('missing invocation policy header');
    const populations = [];
    for (const pattern of [/^  tools\/: (\d+) executable, (\d+) with no invocation path$/,
      /^  tests\/: (\d+) candidates, (\d+) with no invocation path$/,
      /^  src\/lib\/: (\d+) modules, (\d+) reached only by their own tests$/]) {
      const result = one(pattern);
      if (!positive(result[1]) || !Number.isSafeInteger(Number(result[2])) || Number(result[2]) > Number(result[1])) fail('invalid or empty invocation policy population');
      populations.push(result);
    }
    const tools = one(/^          (\d+) intended customer runtime; (\d+) truthfully build\/developer-only$/);
    const registry = one(/^  registry: (\d+) deliberately-manual, (\d+) baseline debt$/);
    if ([tools[1], tools[2], registry[1], registry[2]].some(value => !Number.isSafeInteger(Number(value))) ||
      Number(tools[1]) + Number(tools[2]) !== Number(populations[0][2])) fail('invocation policy classifications do not reconcile');
    if (lines.some(line => /^\s*(?:FAIL:|VERDICT: FAIL)/.test(line))) fail('invocation policy reported an unresolved failure');
    terminal('VERDICT: PASS every executable mechanism is reachable or registered.');
    if (lines.filter(line => line.startsWith('VERDICT:')).length !== 1) fail('duplicate invocation policy verdict');
    return counts(0); // Existing declared policy/debt is visible, never a test-failure waiver.
  }
  if (reporter === 'app:strict-ratchet') {
    if (lines.length !== 3 || lines[0] !== 'Test ratchet: running `npm test` ...') fail('incomplete strict ratchet invocation report');
    const result = one(/^Ran (\d+) tests: (\d+) pass, 0 fail, 0 skipped \(0 failing top-level test\(s\), suite exit 0\)\.$/);
    const complete = one(/^Strict verification OK: no failures; no failure baseline was accepted; (\d+) required control\(s\) passed\.$/);
    if (!positive(result[1]) || result[1] !== result[2] || !positive(complete[1])) fail('strict ratchet counts or required controls are incomplete');
    // The separate raw TAP jobs count tests. This observation proves the
    // declared runner/strict-control mode, without double-counting its tests.
    return counts(0);
  }
  if (reporter === 'engine:generated-mirrors') {
    const expected = ['adapters/claude/mcp.json.example', 'adapters/gemini/settings.json.example', 'tools/collect-process-visibility.ps1'].sort();
    const measured = lines.map(line => /^\s*unchanged\s+([^\r\n]+)$/.exec(line)?.[1]);
    if (json(measured.sort()) !== json(expected)) fail('generated mirror report is stale, empty or does not cover the exact output set');
    return counts(0);
  }
  if (reporter === 'engine:capability-index') {
    const current = one(/^CURRENT -- (.+) matches the (\d+)-tool registry\.$/);
    const tools = one(/^tools\s+(\d+)$/), reachable = one(/^reachability\s+(\d+)\/(\d+) tools findable by their own description$/);
    if (!cwd || path.resolve(current[1]) !== path.resolve(cwd, 'config/capability-index.json') || !positive(current[2]) ||
      current[2] !== tools[1] || tools[1] !== reachable[1] || reachable[1] !== reachable[2] ||
      !positive(one(/^artifact\s+(\d+) bytes$/)[1])) fail('capability-index report does not prove the exact, nonempty, reachable source registry');
    one(/^sha256\s+[a-f0-9]{64}$/);
    one(/^engine commit\s+[a-f0-9]{40}$/);
    return counts(0);
  }
  if (reporter === 'app:node-version') {
    const result = one(/^check-node-version: node v(\d+\.\d+\.\d+) matches the package\.json engines\.node pin \((.+)\)\.$/);
    if (lines.length !== 1 || !cwd || readJson(at(cwd, 'package.json')).engines?.node.replace(/^v/, '') !== result[1]) fail('Node version report differs from the source pin');
    return counts(0);
  }
  if (reporter === 'app:benchmark-core') {
    const population = one(/^core modules: (\d+)  vertical: (\d+)  seam: (\d+)$/);
    const coupling = one(/^core modules importing a vertical module: (\d+) \(known remaining: (\d+)\)$/);
    const completed = one(/^OK: no new core->vertical coupling\. (\d+) module\(s\) still to invert, exactly as recorded\.$/);
    if (population.slice(1).some(value => !positive(value)) || coupling[1] !== coupling[2] ||
        coupling[1] !== completed[1] || Number(coupling[1]) > Number(population[1])) fail('benchmark seam report does not reconcile');
    terminal(completed[0]);
    return counts(0);
  }
  if (reporter === 'app:profile-paths') {
    const result = one(/^check-no-profile-paths: scanned (\d+) tracked or untracked-not-ignored file\(s\), 0 absolute profile paths outside the allowlist\.$/);
    if (lines.length !== 1 || !positive(result[1])) fail('profile-path scan is empty or incomplete');
    return counts(0);
  }
  if (reporter === 'app:shipped-source-privacy') {
    const measured = one(/^Scanned (\d+) files \((\d+) bytes\)\. Total matches: 0\.$/);
    const completed = one(/^Shipped-source owner-data gate: clean\. (\d+) file\(s\) \((\d+) bytes\) across \["shell","src","public","config"\] carry no owner data; 0 allowlisted\.$/);
    if (!positive(measured[1]) || !positive(measured[2]) || measured[1] !== completed[1] || measured[2] !== completed[2]) fail('shipped-source privacy population does not reconcile');
    terminal(completed[0]);
    return counts(0);
  }
  if (reporter === 'app:payload-reconciliation') {
    const seen = one(/^Files seen: (\d+) \(informational -- this guard asserts on named paths, never on a count\)\.$/);
    const classes = one(/^Classified \(distinct paths across 1 root\(s\)\): open=(\d+) pending=(\d+) paid=0 excluded=0 unclassified=0$/);
    if (!positive(seen[1]) || Number(seen[1]) !== Number(classes[1]) + Number(classes[2])) fail('payload reconciliation population does not reconcile');
    one(/^Payload boundary: clean\. Nothing paid, excluded or unclassified is present\.$/);
    terminal('check-payload-boundary-reconciled: every file the engine will pack is classified by config/payload-boundary.json.');
    return counts(0); // Ship mode separately requires pending=0; this is the landing check.
  }
  if (reporter === 'app:test-inputs') {
    const result = one(/^Test inputs: all (\d+) required derived input\(s\) present \((.+)\)\.$/);
    if (!positive(result[1]) || result[2].split(', ').length !== Number(result[1])) fail('incomplete derived test-input report');
    return counts(0);
  }
  if (reporter === 'app:settings-rows-declared') {
    // Both counts must be real: a zero on either side means the gate measured
    // nothing, and the script's own exit 3 says so rather than passing.
    const result = one(/^DECLARED -- all (\d+) settings rows the app draws are declared by the packed engine registry \((\d+) rows\)\.$/);
    if (!positive(result[1]) || !positive(result[2])) fail('settings-row agreement report is empty');
    // The gate prints exactly this one line on agreement; anything else it can
    // say is a refusal on stderr with a nonzero exit.
    if (lines.length !== 1) fail('settings-row agreement report must contain only its verdict');
    return counts(0);
  }
  if (reporter === 'app:suite-discovery') {
    const result = one(/^Suite discovery: (\d+) suite\(s\) reached by .+; (\d+) \*\.test\.mjs file\(s\) exist in the tree\.$/);
    if (!positive(result[1]) || result[1] !== result[2]) fail('suite discovery report contains unselected tests');
    terminal('Every suite in the tree is reached by the runner.');
    return counts(0);
  }
  if (reporter === 'app:driver-discovery') {
    if (lines.length !== 2) fail('driver discovery report must contain only its summary and completion');
    const result = one(/^Driver discovery: (\d+) driver\(s\) reached by \/[^\r\n]+\/[a-z]*; (\d+) driver-shaped file\(s\) exist under tools\/; (\d+) JavaScript and (\d+) PowerShell files held out with a written reason\.$/);
    if (!positive(result[1]) || !positive(result[2])) fail('driver discovery report is empty');
    const [discovered, shaped, javascriptHeld, powershellHeld] = result.slice(1).map(Number);
    const accounted = discovered + javascriptHeld + powershellHeld;
    // The remaining shaped files may be delegated PowerShell helpers. Direct
    // discovery and explicit holdouts cannot together exceed that inventory.
    if ([javascriptHeld, powershellHeld, accounted].some(value => !Number.isSafeInteger(value) || value < 0) ||
      accounted > shaped) fail('driver discovery counts do not reconcile');
    terminal('Every driver-shaped file under tools/ is discovered, delegated to by a discovered driver, or held out in writing.');
    return counts(0);
  }
  if (reporter === 'app:browser-proofs') {
    // Receipts mode only: the census must leave nothing undeclared, every
    // required proof must appear as an attributable observed pass, and the
    // manual/platform-limited counts are reported, never counted.
    const census = one(/^Browser proofs: (\d+) driver\(s\) discovered under tools\/test\/fixtures\/; (\d+) required, (\d+) manual, (\d+) platform-limited; (\d+) unregistered, (\d+) stale\.$/);
    const [discovered, required, manual, limited, unregistered, stale] = census.slice(1).map(Number);
    if (!positive(discovered) || !positive(required) || unregistered !== 0 || stale !== 0 || required + manual + limited !== discovered) fail('browser-proof census does not reconcile or leaves a driver undeclared');
    const proofs = lines.filter(line => /^Required proof /.test(line));
    const names = proofs.map(line => /^Required proof (run-[a-z0-9][a-z0-9-]*\.mjs): observed-pass; receipt private\/browser-proof-receipts\/run-[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+\.json sha256 [a-f0-9]{64}; driver sha256 [a-f0-9]{64}; platform (?:linux|win32|darwin)\.$/.exec(line)?.[1]);
    if (proofs.length !== required || names.some(name => !name) || new Set(names).size !== required) fail('a required browser proof is not reported as an attributable observed pass');
    if (lines.length !== required + 2) fail('browser-proof report must contain only its census, one line per required proof and its completion');
    terminal(`Every required browser proof is executed and attributable; ${manual} manual and ${limited} platform-limited proof(s) are declared, discovered and unexecuted.`);
    return counts(0);
  }
  if (reporter === 'app:unbound-identifiers') {
    if (!positive(one(/^check-unbound-identifiers: (\d+) renderer modules, no unbound identifiers\.$/)[1])) fail('renderer scan is empty');
    return counts(0);
  }
  if (reporter === 'app:chat-control-coverage') {
    /* The gate prints one SUMMARY line and its two standing LIMITATION notes.
       Both counts must be real: a zero inventory means it derived nothing,
       which is the failure mode it spent its whole life in. */
    const summary = one(/^SUMMARY: inventory controls=(\d+); scanned candidate files=(\d+); evidence records=(\d+); findings=(\d+); canonical baseline accepted entries=(\d+)$/);
    const values = summary.slice(1).map(Number);
    const findings = lines.filter(line => line.startsWith('FINDING: ')).map(line => line.slice('FINDING: '.length));
    if (values.some(value => !Number.isSafeInteger(value)) || values.slice(0, 3).some(value => value < 1)) fail('chat-control coverage derived nothing');
    if (values[3] > values[0] || values[3] !== values[4] || findings.length !== values[3] ||
        new Set(findings).size !== findings.length || findings.some(value => !value.trim()) ||
        lines.some(line => /^(?:UNACCEPTED|STALE|PROPOSAL|SETUP ERROR):/.test(line))) fail('chat-control coverage findings do not reconcile with the unchanged canonical baseline');
    return counts(0);
  }
  if (reporter === 'app:composed-output') {
    const result = one(/^Composed output: (\d+) panel state\(s\), (\d+) visible string\(s\) on screen together; 0 finding\(s\) \[[^\r\n]*\]\.$/);
    if (!positive(result[1]) || !positive(result[2])) fail('composed-output observation is empty');
    terminal('Every panel tells one story in every state it can be in.');
    return counts(0);
  }
  fail(`unregistered source action reporter: ${reporter}`);
}
export function parseSourceOutput(stdout, stderr = '', options = {}) {
  const text = `${stdout}\n${stderr}`;
  if (/real-tree HIT half NOT exercised:/i.test(text)) fail('required real-corpus retrieval HIT was not exercised');
  if (/^\s*(?:SKIP(?:PED)?|TODO)\b/im.test(text) || / # (?:SKIP|TODO)(?:\s|$)/im.test(text) || /\b[1-9]\d* (?:skipped|cancelled|todo)\b/i.test(text)) fail('a required source test skipped, cancelled or deferred work');
  if (options.isolatedFiles && options.reporter !== 'engine:isolated-transcript') stdout = splitIsolatedTranscript(stdout, options.isolatedFiles).join('\n');
  if (options.reporter && options.reporter !== 'source-tests') return parseActionReport(stdout, stderr, options);
  if (/^TAP version 13\r?$/m.test(stdout)) return parseSourceTap(stdout);
  const end = `${stdout}\n${stderr}`.trim();
  let match = /(?:^|\n)\s*(\d+)\/(\d+) (?:tests? |checks? )?passed\s*$/i.exec(end);
  if (match) { if (Number(match[1]) !== Number(match[2]) || Number(match[1]) < 1) fail('legacy completed count does not reconcile'); return counts(Number(match[1])); }
  match = /(?:^|\n)[^\n]*?\b(\d+) passed(?:[,;]\s*(\d+) failed)?\s*$/i.exec(end);
  if (match && Number(match[1]) > 0 && Number(match[2] || 0) === 0) return counts(Number(match[1]));
  match = /Ran (\d+) tests? in [\d.]+s\s+OK\s*$/m.exec(end);
  if (match && Number(match[1]) > 0) return counts(Number(match[1]));
  const terminal = end.split(/\r?\n/).at(-1);
  if (SINGLE_FILE_FOOTERS.has(terminal)) return counts(1); // One observed assertion-file unit, not an invented assertion count.
  fail('no recognized nonempty completed source-test report; exit zero alone is not coverage');
}

// The wrapper can create inputs for an interactive developer. Qualification
// instead requires a prepared disposable checkout: no walk-up dependencies,
// junction creation, packing, source-record writes or inherited engine choice.
// Its payload must be the same bytes as the already measured installer stage.
export function measureStrictSourceInputs(selection, context, subject) {
  if (selection.id !== 'app' || selection.root !== context?.sourceRoots?.app ||
      selection.canonicalRoot !== context?.sourceRoots?.engine ||
      !/^[a-f0-9]{40}$/.test(subject?.sourceRefs?.app || '') ||
      !/^[a-f0-9]{40}$/.test(subject?.sourceRefs?.engine || '') ||
      canonicalDigest(subject.context) !== canonicalDigest(context)) fail('strict release needs the exact measured subject context');
  const sourceRecord = at(selection.root, 'private/capability-source.owner.json');
  const record = JSON.parse(readBounded(sourceRecord, 65536).toString('utf8'));
  if (record.path !== selection.canonicalRoot || record.ref !== subject.sourceRefs.engine) fail('strict release source record differs from the exact engine');
  const stage = measureTree(context.stageRoot);
  if (stage.sha256 !== subject.stageSha256) fail('strict release stage differs from its measured subject');
  const payload = measureTree(at(selection.root, 'capability'));
  const stagedPayload = measureTree(at(context.stageRoot, 'resources/capability'));
  if (json(payload) !== json(stagedPayload) || Object.hasOwn(payload.files, 'UNSHIPPABLE-OWNER-DATA.txt')) fail('strict release capability differs from the certified staged payload');
  const dependenciesRoot = unlinkedPath(at(selection.root, 'node_modules'), { directory: true });
  const dependencyEntries = fs.readdirSync(dependenciesRoot).length;
  if (dependencyEntries <= 1) fail('strict release dependencies are absent or scratch-only');
  const dependencies = measureTree(dependenciesRoot);
  const ownerPatterns = identity(at(selection.root, 'private/owner-data-patterns.owner.json'));
  const capabilityEntries = fs.readdirSync(at(selection.root, 'capability')).length;
  return { root: selection.root, canonicalRoot: selection.canonicalRoot,
    appRef: subject.sourceRefs.app, engineRef: subject.sourceRefs.engine, stageSha256: stage.sha256,
    payload, dependencies, sourceRecord: identity(sourceRecord), ownerPatterns,
    header: { dependencyEntries, capabilityEntries } };
}

function strictRunnerInputs() {
  // test-strict and its ratchet invoke npm from the transport's fixed PATH.
  // Bind that interpreter's complete package, not only the node executable.
  const nodeRoot = path.win32.dirname(NODE);
  const root = path.win32.join(nodeRoot, 'node_modules', 'npm');
  const files = {}, state = { entries: 0, bytes: 0 };
  function visit(directory, prefix = '') {
    const before = fs.readdirSync(unlinkedPath(directory, { directory: true, system: true })).sort();
    for (const name of before) {
      if (++state.entries > 30000) fail('npm runner input entry budget exceeded');
      const file = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else {
        const value = identity(file, { system: true });
        state.bytes += value.bytes;
        if (state.bytes > 512 * 1024 * 1024) fail('npm runner input byte budget exceeded');
        files[relative] = value;
      }
    }
    if (json(fs.readdirSync(directory).sort()) !== json(before)) fail('npm runner inputs changed during enumeration');
  }
  visit(root);
  if (!files['bin/npm-cli.js'] || !files['package.json']) fail('npm runner package is incomplete');
  return { command: identity(path.win32.join(nodeRoot, 'npm.cmd'), { system: true }),
    files, sha256: digest(files) };
}

function strictReleaseParts(stdout, stderr, { strictBinding: bound, command, args, cwd }) {
  if (stderr.trim() || !bound || command !== NODE || cwd !== bound.root ||
      json(args) !== json([at(bound.root, 'tools/test-strict.mjs'), '--canonical-root', bound.canonicalRoot, '--scratch', bound.scratch])) fail('strict release command or bound context differs');
  const output = stdout.replaceAll('\r\n', '\n');
  const lines = output.trimEnd().split('\n');
  const one = pattern => {
    const matches = lines.map(line => pattern.exec(line)).filter(Boolean);
    if (matches.length !== 1) fail('strict release report is missing or duplicates a required observation');
    return matches[0];
  };
  const started = one(/^started             (.+)$/)[1];
  const finished = one(/^finished              (.+)$/)[1];
  if (!Number.isFinite(Date.parse(started)) || !Number.isFinite(Date.parse(finished)) || Date.parse(finished) < Date.parse(started)) fail('strict release timestamps do not reconcile');
  if (!Number.isSafeInteger(bound.dependencyEntries) || bound.dependencyEntries <= 1 ||
      !Number.isSafeInteger(bound.capabilityEntries) || bound.capabilityEntries < 1) fail('strict release prepared inputs are empty');
  const dependencies = `${path.join(bound.root, 'node_modules')} (real directory, repository root, ${bound.dependencyEntries} entries)`;
  const header = [
    '=== app strict release measurement ===',
    'command             node tools/test-strict.mjs --canonical-root <engine checkout>',
    `repository          ${bound.root}`, `app HEAD            ${bound.appRef}`,
    `canonical root      ${bound.canonicalRoot}`, `engine HEAD         ${bound.engineRef}`,
    `node                v22.19.0 at ${NODE}`, 'NODE_OPTIONS        (unset)',
    `dependencies        ${dependencies}`,
    `capability/         ${path.join(bound.root, 'capability')} (${bound.capabilityEntries} entries)`,
    `state roots         ${path.join(bound.scratch, 'state')}`,
    `vault path          ${path.join(bound.scratch, 'state', 'vault', 'secrets.json')}`,
    `TEMP/TMP/TMPDIR     ${path.join(bound.scratch, 'temp')}`,
    'nightly suites      not enabled (they are unexecuted coverage, named)', `started             ${started}`,
    '=======================================', '',
  ].join('\n');
  if (!output.startsWith(header)) fail('strict release header differs from its exact source, engine or isolated input context');
  const result = one(/^Ran (\d+) tests: (\d+) pass, 0 fail, 0 skipped \(0 failing top-level test\(s\), suite exit 0\)\.$/);
  const tests = Number(result[1]);
  if (!Number.isSafeInteger(tests) || tests < 1 || result[1] !== result[2]) fail('strict release reported zero or incomplete test execution');
  one(/^UNEXECUTED \(skipped\) tests: 0\.$/);
  one(/^Test ratchet: running `npm test` \.\.\.$/);
  const completed = one(/^Strict verification OK: (\d+) passed, no failures; no failure baseline was accepted; (\d+) required control\(s\) passed; 0 test\(s\) unexecuted and named, 0 unexecuted and unnamed\.$/);
  if (Number(completed[1]) !== tests || !Number.isSafeInteger(Number(completed[2])) || Number(completed[2]) < 1) fail('strict release required control counts do not reconcile');
  if (!lines.includes(`Dependency resolution: ${dependencies}.`) || !lines.includes(
    `Measurement environment: node v22.19.0 at ${NODE}; TOOLSENABLED_STATE_ROOT=${path.join(bound.scratch, 'state')}; MC_CANONICAL_ROOT=${bound.canonicalRoot}; TOOLSENABLED_TEST_STRICT=1; TOOLSENABLED_NIGHTLY=(unset).`)) fail('strict release child did not report the bound isolated environment');
  const footer = [ '', '=== app strict release counts ===',
    `tests ${tests}  pass ${tests}  fail 0  skipped 0`, 'UNEXECUTED (skipped)  0', 'unexecuted and named  0',
    'verify:release exit   0', `finished              ${finished}`,
    `full output           ${path.join(bound.scratch, 'strict-output.log')}`, '=================================', '',
  ].join('\n');
  if (!output.endsWith(footer) || lines.filter(line => line === '=== app strict release counts ===').length !== 1 ||
      /(?:^|\n)(?:REFUSED |NOTHING WAS MEASURED|STRICT VERIFICATION FAILED|Baseline UPDATED:)/.test(output)) fail('strict release did not finish its exact successful child measurement');
  const rawDirectory = one(/^Raw suite output retained at (.+)$/)[1];
  const temp = path.join(bound.scratch, 'temp');
  // Validate the declared name before reading it. The runner creates exactly
  // one direct child beneath its bound TEMP; it cannot nominate another file.
  if (path.dirname(rawDirectory) !== temp || !/^toolsenabled-test-output-[a-zA-Z0-9]+$/.test(path.basename(rawDirectory))) fail('strict release raw suite output escaped its private scratch');
  return { tests, header, captured: output.slice(header.length, output.length - footer.length), rawDirectory };
}

function parseStrictReleaseReport(stdout, stderr, expected) {
  strictReleaseParts(stdout, stderr, expected);
  // Individual TAP jobs count the census. The wrapper proves its real guarded
  // invocation and child controls; it does not double count their tests.
  return counts(0);
}

export function verifyStrictReleaseFiles(stdout, stderr, expected) {
  const { tests, header, captured, rawDirectory } = strictReleaseParts(stdout, stderr, expected);
  const scratch = expected.strictBinding.scratch;
  const read = file => readBounded(unlinkedPath(file), 64 * 1024 * 1024);
  if (read(path.join(scratch, 'strict-header.txt')).toString('utf8').replaceAll('\r\n', '\n') !== header ||
      read(path.join(scratch, 'strict-output.log')).toString('utf8').replaceAll('\r\n', '\n') !== captured) fail('strict release retained output differs from its owned process output');
  const metadata = JSON.parse(read(path.join(rawDirectory, 'run.json')).toString('utf8'));
  const rawOut = read(path.join(rawDirectory, 'stdout.log')), rawErr = read(path.join(rawDirectory, 'stderr.log'));
  if (metadata.schemaVersion !== 1 || metadata.cwd !== expected.cwd || metadata.command !== 'npm test' ||
      metadata.exitCode !== 0 || metadata.signal !== null || json(metadata.stdout) !== json({ bytes: rawOut.length, sha256: sha(rawOut) }) ||
      json(metadata.stderr) !== json({ bytes: rawErr.length, sha256: sha(rawErr) })) fail('strict release raw child execution metadata or output changed');
  const measured = parseSourceTap(rawOut.toString('utf8'));
  if (measured.tests !== tests) fail('strict release raw TAP differs from its reported executed counts');
  return ['strict-header.txt', 'strict-output.log'].map(file => fileIdentity(path.join(scratch, file))).concat(
    ['run.json', 'stdout.log', 'stderr.log'].map(file => fileIdentity(path.join(rawDirectory, file))));
}

function commandFor(file, cwd, selection, evidenceDirectory, index) {
  const extension = path.extname(file);
  const relative = portable(path.relative(selection.root, file));
  let command = extension === '.py' ? PYTHON : extension === '.ps1' ? PS : NODE;
  let args = extension === '.ps1' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : [file];
  let summaryPath;
  /* --import gives this job's own process a fresh, isolated Windows profile
     (see tools/test/lib/isolate-native-state-root.mjs's own header): the
     strict runner spawns one process per file from the same parent env, so
     without it every job here shares whatever TOOLSENABLED_STATE_ROOT the
     parent had -- the owner's live profile on this machine -- the same
     conflict package.json's test:data script carries the fuller account of. */
  if (selection.id === 'app') args = ['--import=./tools/test/lib/isolate-native-state-root.mjs',
    '--test', '--test-reporter=tap', '--test-concurrency=1', file];
  if (selection.id === 'engine') {
    summaryPath = path.join(evidenceDirectory, `isolated-${index}.json`);
    args = [at(selection.root, 'tests/run-isolated.js'), '--config-integrity', '--timeout-ms', '600000', '--summary', summaryPath, relative];
  }
  const namedLeaf = selection.id === 'engine' && NAMED_LEAF_REPORTS.some(leaf => leaf.file === relative);
  const isolatedLeaf = selection.id === 'engine' && ISOLATED_LEAF_REPORTS.some(leaf => leaf.file === relative);
  return { command, args, cwd, env: { TOOLSENABLED_TEST_STRICT: '1' }, timeoutMs: 610000, maxOutputBytes: 8 * 1024 * 1024,
    ...(namedLeaf ? { reporter: 'engine:registered-leaf' } : isolatedLeaf ? { reporter: 'engine:isolated-leaf' } : {}),
    ...(selection.id === 'engine' ? { isolatedFiles: [relative] } : {}),
    cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500, file, summaryPath };
}
export function planSourceSuiteJobs(selection, directory, { partial = false, strictInputs, sourceRef } = {}) {
  return jobsAtBundle(selection, directory, { partial, strictInputs, sourceRef }, path.resolve(HERE, '..'));
}
// Private execution-path selection: persisted commands use their measured
// producer bundle; independent replay uses this actual consumer bundle. Public
// planning never accepts a caller-provided runner or implementation location.
function jobsAtBundle(selection, directory, { partial = false, strictInputs, sourceRef }, bundleRoot) {
  if (selection.id === 'shell') return [{ command: NODE, args: ['--test', '--test-reporter=tap', '--test-concurrency=1', path.join(bundleRoot, 'runners/shell-source.mjs')],
    cwd: selection.root, env: { QUALIFICATION_SHELL_ROOT: selection.root }, timeoutMs: 30000,
    // Bind Linux verification inputs explicitly; preserve the Windows transport defaults.
    maxOutputBytes: 8 * 1024 * 1024, cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 300,
    file: 'harness:shell-source.mjs' }];
  let sourceBinding;
  if (selection.id === 'app') {
    if (!strictInputs || selection.canonicalRoot !== strictInputs.canonicalRoot || selection.root !== strictInputs.root ||
        !/^[a-f0-9]{40}$/.test(strictInputs.appRef || '') || !/^[a-f0-9]{40}$/.test(strictInputs.engineRef || ''))
      fail('App source jobs need their exact measured app/engine inputs');
    sourceBinding = { root: strictInputs.root, canonicalRoot: strictInputs.canonicalRoot,
      appRef: strictInputs.appRef, engineRef: strictInputs.engineRef, sourceRecord: structuredClone(strictInputs.sourceRecord) };
  }
  const files = partial ? ['first-run-setup.test.js'] : selection.files;
  const jobs = files.map((file, index) => commandFor(at(selection.root, file), selection.root, selection, directory, index));
  if (!partial) for (const file of selection.crossFiles) jobs.push(commandFor(at(selection.checkout, file), selection.root, selection, directory, jobs.length));
  if (!partial) {
    jobs.unshift(...selection.commands.map(action => {
      const [runtime, file, ...args] = action.command;
      if (runtime !== 'node') fail('unregistered supplemental source runtime');
      if (action.context === 'engine-isolated-performance') {
        const registered = ENGINE_PERFORMANCE_ACTIONS.find(row => row.id === action.id);
        if (!registered || json(action) !== json(registered)) fail('unregistered native performance action');
        return planEnginePerformanceSourceJob(selection, action.id, directory, sourceRef);
      }
      if (action.context === 'engine-native-custody-scratch') {
        if (selection.id !== 'engine' || json(action) !== json(NATIVE_CUSTODY_ACTION)) fail('unregistered native custody action');
        return nativeCustodyJob(selection.root, directory, bundleRoot);
      }
      if (action.context === ROLE_STUDIO_SOURCE_ACTION.context) {
        if (json(action) !== json(ROLE_STUDIO_SOURCE_ACTION)) fail('unregistered Role Studio contextual action');
        return planRoleStudioSourceJob(selection, directory, strictInputs);
      }
      if (action.context === 'app-strict-engine-scratch') {
        if (selection.id !== 'app' || json(action.command) !== json(['node', 'tools/test-strict.mjs']) ||
            !strictInputs || selection.canonicalRoot !== strictInputs.canonicalRoot || selection.root !== strictInputs.root ||
            !/^[a-f0-9]{40}$/.test(strictInputs.appRef || '') || !/^[a-f0-9]{40}$/.test(strictInputs.engineRef || '')) fail('strict release needs its exact measured app/engine inputs');
        const scratch = path.join(directory, 'strict-scratch');
        return { command: NODE, args: [at(selection.root, file), '--canonical-root', selection.canonicalRoot, '--scratch', scratch],
          cwd: selection.root, env: { TOOLSENABLED_TEST_STRICT: '1' }, timeoutMs: action.timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024, cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500,
          file, actionId: action.id, reporter: action.reporter, strictBinding: { ...strictInputs.header, scratch,
            root: selection.root, canonicalRoot: selection.canonicalRoot, appRef: strictInputs.appRef, engineRef: strictInputs.engineRef } };
      }
      return { command: NODE, args: [at(selection.root, file), ...args], cwd: selection.root,
        env: { TOOLSENABLED_TEST_STRICT: '1' }, timeoutMs: action.timeoutMs || 610000, maxOutputBytes: 8 * 1024 * 1024,
        ...(selection.id === 'engine' && (action.isolatedRunner || action.isolatedReports?.length)
          ? { isolatedFiles: (action.leafReports || action.isolatedReports)?.map(leaf => leaf.file) || action.requiredFiles } : {}),
        cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500, file, actionId: action.id, reporter: action.reporter };
    }));
  }
  if (sourceBinding) for (const job of jobs) {
    job.env = { ...job.env, MC_CANONICAL_ROOT: sourceBinding.canonicalRoot };
    job.sourceBinding = structuredClone(sourceBinding);
    // Admission uses the same bound record on both OSes. The complete run and
    // independent report replay also verify the exact clean Git source pair.
    registeredToolEnvironment(job.env, { cwd: job.cwd, sourceBinding: job.sourceBinding });
  }
  return jobs;
}
function nativeCustodyJob(root, directory, bundleRoot) {
  if (!Object.hasOwn(NATIVE_CUSTODY_LEAVES, process.platform)) fail('native custody requires a registered native host');
  const inputs = nativeCustodyInputs(root), inputsSha256 = canonicalDigest(inputs);
  const args = nativeCustodyArguments(root, directory, inputs);
  args[0] = path.join(bundleRoot, 'runners/native-custody-source.mjs');
  return { command: NODE, args, cwd: root, env: { TOOLSENABLED_TEST_STRICT: '1' },
    timeoutMs: 610000, maxOutputBytes: 8 * 1024 * 1024, cleanupMs: 5000, cleanupGraceMs: process.platform === 'linux' ? 250 : 500,
    file: NATIVE_CUSTODY_ACTION.command[1], actionId: NATIVE_CUSTODY_ACTION.id, reporter: NATIVE_CUSTODY_ACTION.reporter,
    custodyBinding: { root, directory, scratch: path.join(directory, 'nc'), platform: process.platform, inputs, inputsSha256 } };
}

function writePrivate(file, value) {
  const parent = unlinkedPath(path.dirname(fencedPath(file)), { directory: true });
  const handle = fs.openSync(path.join(parent, path.basename(file)), 'wx', 0o600);
  try { fs.writeFileSync(handle, `${json(value)}\n`); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  return fileIdentity(file);
}
function checkEvidenceRoot(context, selection) {
  const root = unlinkedPath(context?.evidenceRoot, { directory: true });
  for (const candidate of [selection.checkout, context.stageRoot, context.harnessRoot, path.resolve(HERE, '..')].filter(Boolean)) {
    const other = unlinkedPath(candidate, { directory: true });
    if (inside(other, root) || inside(root, other)) fail('private evidence must be separate from source/stage/harness');
  }
  return root;
}
// Parse the existing Linux native owner schema, rather than translating it
// into invented Windows Job fields. This fact check alone grants no source
// qualification: its caller must bind the raw files and independently replay.
export function assertNativeCustodyLinuxProcessEvidence(actual, native, spec, expected, toolchain) {
  if (expected.actionId !== NATIVE_CUSTODY_ACTION.id || expected.custodyBinding?.platform !== 'linux')
    fail('native Linux custody action binding differs');
  return assertLinuxSourceProcessEvidence(actual, native, spec, expected, toolchain);
}

// Generic source jobs use the same retained Linux owner and raw record format.
// This checks process facts only; verifyJob still binds every raw file and
// runs the actual source summary/action/output checks below.
export function assertLinuxSourceProcessEvidence(actual, native, spec, expected, toolchain) {
  if (expected.command !== toolchain.tools.node.path || expected.cleanupGraceMs !== 250
      || actual.schema !== 'toolsenabled.owned-job-execution' || actual.schemaVersion !== 1
      || actual.complete !== true || actual.exitCode !== 0 || actual.cleanupConfirmed !== true
      || actual.signal !== null || actual.notRun !== false || actual.error !== null || actual.timedOut !== false
      || actual.outputLimitExceeded !== false || actual.hadRemainingChildren !== false
      || !Number.isSafeInteger(actual.jobIndex) || actual.jobIndex < 0) fail('native Linux custody process did not pass and close');
  const transport = { sha256: identity(path.join(HERE, '../transport/linux-owned-job.mjs')).sha256,
    sharedSha256: identity(path.join(HERE, '../transport/owned-job.mjs')).sha256,
    helperSha256: toolchain.nativeOwner.helper.sha256, toolchain };
  const owner = { executable: toolchain.tools.python, descriptor: 10,
    mechanism: 'retained-executable-with-protected-kernel-resolution',
    systemLibraries: toolchain.elf.ownerLibraries, sourceSha256: toolchain.nativeOwner.helper.sha256 };
  if (canonicalDigest(actual.transport) !== canonicalDigest(transport)
      || canonicalDigest(actual.nativeOwnerLaunch) !== canonicalDigest(owner)
      || canonicalDigest(actual.executable) !== canonicalDigest(toolchain.tools.node)
      || json(actual.command) !== json([expected.command, ...expected.args]) || actual.cwd !== expected.cwd
      || Object.hasOwn(actual, 'nativeLaunch') || Object.hasOwn(actual, 'nativeBatchResult'))
    fail('native Linux custody transport, owner or command identity differs');
  if (canonicalDigest(native) !== canonicalDigest({ quiescent: true, started: true,
    exitedNormally: true, exitCode: 0, hadRemainingChildren: false })) fail('native Linux custody lacks actual natural process closure');
  const limits = { timeoutMs: expected.timeoutMs, maxOutputBytes: expected.maxOutputBytes,
    cleanupMs: expected.cleanupMs, cleanupGraceMs: 250 };
  const environment = registeredToolEnvironment(expected.env, { cwd: expected.cwd, sourceBinding: expected.sourceBinding });
  const job = { command: expected.command, args: expected.args, cwd: expected.cwd, git: false, xz: false,
    sourceMetadata: null, compressedInput: null, executable: toolchain.tools.node, environment,
    ...(expected.sourceBinding ? { sourceBinding: expected.sourceBinding } : {}),
    ...limits, expectedProfile: '' };
  if (canonicalDigest(actual.limits) !== canonicalDigest(limits) || actual.environmentSha256 !== canonicalDigest(environment)
      || !Number.isSafeInteger(spec.batchTimeoutMs) || spec.batchTimeoutMs < expected.timeoutMs || spec.batchTimeoutMs > 90 * 60 * 1000
      || !Array.isArray(spec.jobs) || spec.jobs.length <= actual.jobIndex || spec.jobs.length > 100000
      || canonicalDigest(spec.jobs[actual.jobIndex]) !== canonicalDigest(job))
    fail('native Linux custody raw environment, limits or launch specification differs');
}


// The standalone API promises one fixed action. Batched source execution uses
// the same native decoder but does not make this one-job scope claim.
export function assertNativeCustodySingleJob(actual, spec, nativeBatch) {
  if (actual.jobIndex !== 0 || !Array.isArray(spec.jobs) || spec.jobs.length !== 1 || spec.batchTimeoutMs !== 650000
      || nativeBatch !== undefined && nativeBatch?.attempted !== 1)
    fail('scoped native custody requires exactly one original job at index zero');
}

// Shared by persisted-job verification and the planner/producer contract check.
// This validates only the summary; native process and raw-byte proof remain
// mandatory in verifyJob before this gate is reached.
export function assertIsolatedSourceSummary(summary, expected) {
  const wanted = portable(path.relative(expected.cwd, expected.file));
  if (summary.requested !== 1 || summary.files?.length !== 1 || summary.files[0].file !== wanted || summary.files[0].status !== 'pass' || summary.files[0].exitCode !== 0) fail('isolated runner did not execute the exact requested source file');
}

function verifyJob(record, expected, reportRoot, toolchain, singleCustodyJob = false) {
  const readIdentity = value => {
    if (!value || !inside(reportRoot, fencedPath(value.path))) fail('raw evidence escaped the private report directory');
    if (json(fileIdentity(value.path)) !== json(value)) fail('persisted raw evidence bytes changed');
    return value.path;
  };
  readIdentity(record.record);
  const actual = readJson(record.record.path);
  if (json(actual) !== json(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'record')))) fail('execution record disagrees with persisted raw record');
  const readSpec = () => {
    const spec = readJson(readIdentity(actual.launchSpec));
    if (singleCustodyJob) assertNativeCustodySingleJob(actual, spec);
    return spec;
  };
  if (process.platform === 'linux') {
    const decode = expected.actionId === NATIVE_CUSTODY_ACTION.id
      ? assertNativeCustodyLinuxProcessEvidence : assertLinuxSourceProcessEvidence;
    decode(actual, readJson(readIdentity(actual.nativeResult)), readSpec(), expected, toolchain);
    if (expected.actionId === NATIVE_CUSTODY_ACTION.id)
      return parseSourceOutput(fs.readFileSync(readIdentity(actual.stdout), 'utf8'), fs.readFileSync(readIdentity(actual.stderr), 'utf8'), expected);
  } else {
    if (!actual.complete || actual.exitCode !== 0 || !actual.cleanupConfirmed || actual.signal !== null || actual.notRun || actual.error || actual.timedOut || actual.outputLimitExceeded || actual.hadRemainingChildren) fail(`command did not completely pass and clean up: ${expected.file}`);
    const executable = Object.values(toolchain.tools).find(tool => tool.path === expected.command);
    if (!executable || json(actual.command) !== json([expected.command, ...expected.args]) || actual.cwd !== expected.cwd ||
      json(actual.executable) !== json(executable) || json(actual.transport.toolchain) !== json(toolchain) ||
      actual.transport.sha256 !== identity(path.join(HERE, '../transport/owned-job.mjs')).sha256) fail('command, runtime or containment identity differs');
    const native = readJson(readIdentity(actual.nativeResult));
    if (native.processCreated !== true || native.rootExited !== true || native.exitCode !== 0 || native.cleanupConfirmed !== true ||
      native.error || native.timedOut || native.outputLimitExceeded || native.hadRemainingChildren) fail('raw native process/cleanup result is incomplete');
    const nativeBatch = readJson(readIdentity(actual.nativeBatchResult));
    if (nativeBatch.finished !== true || nativeBatch.cleanupConfirmed !== true || !Number.isSafeInteger(nativeBatch.attempted) || nativeBatch.attempted <= actual.jobIndex) fail('raw native batch did not prove this command was attempted and cleaned');
    const spec = readSpec();
    if (singleCustodyJob) assertNativeCustodySingleJob(actual, spec, nativeBatch);
    const job = spec.jobs?.[actual.jobIndex];
    const environment = registeredToolEnvironment(expected.env, { cwd: expected.cwd, sourceBinding: expected.sourceBinding });
    if (!job || json([job.command, ...job.args]) !== json(actual.command) || job.cwd !== actual.cwd ||
      json(job.sourceBinding || null) !== json(expected.sourceBinding || null) ||
      digest(environment) !== actual.environmentSha256 ||
      json(job.environment) !== json(Object.keys(environment).sort().map(key => `${key}=${environment[key]}`))) fail('raw launch specification or environment differs');
  }
  let stdout = fs.readFileSync(readIdentity(actual.stdout), 'utf8'), stderr = fs.readFileSync(readIdentity(actual.stderr), 'utf8');
  if (expected.summaryPath) {
    const summary = readJson(unlinkedPath(expected.summaryPath));
    assertIsolatedSourceSummary(summary, expected);
  }
  verifySourceActionEvidence(stdout, stderr, expected);
  return parseSourceOutput(stdout, stderr, expected);
}

export function assertSourceCleanupConfirmed(records) {
  if (!Array.isArray(records) || !records.length || records.some(record => record?.cleanupConfirmed !== true)) {
    const error = new Error('Source qualification cleanup remains unconfirmed; retain source, stage and evidence and refuse further execution');
    error.code = 'SOURCE_CLEANUP_UNCONFIRMED';
    error.cleanupUnconfirmed = true;
    error.records = records;
    throw error;
  }
}

const compactSnapshot = value => ({ clean: value.clean, ref: value.ref, sha256: value.sha256 });
function sourceProvenance(subject, context, selection) {
  if (!subject || !subject.context || canonicalDigest(subject.context) !== canonicalDigest(context) ||
      subject.harness?.clean !== true || typeof subject.sourceRefs?.[selection.key] !== 'string') fail('complete source execution requires its measured subject and exact source/harness refs');
  const binding = measureSourceHarnesses(subject.product, context.harnessRoot);
  const consumerRoot = path.resolve(binding.consumerBundleRoot, ...binding.consumerLayout.split('/').map(() => '..'));
  if (inside(consumerRoot, context.evidenceRoot) || inside(context.evidenceRoot, consumerRoot)) fail('private evidence must be separate from the executing verifier checkout');
  if (canonicalDigest(compactSnapshot(binding.producer)) !== canonicalDigest(subject.harness)) fail('original producer harness identity differs from the measured subject');
  const source = path.relative(selection.checkout, context.harnessRoot) === '' && subject.sourceRefs[selection.key] === binding.producer.ref
    ? binding.producer : cleanSourceSnapshot(selection.checkout, subject.sourceRefs[selection.key]);
  const producer = { ...compactSnapshot(binding.producer), layout: binding.producerLayout, bundleRoot: binding.producerBundleRoot };
  const execution = { ...compactSnapshot(binding.consumer), layout: binding.consumerLayout, bundleRoot: binding.consumerBundleRoot };
  const engine = selection.id === 'app' ? compactSnapshot(cleanSourceSnapshot(context.sourceRoots.engine, subject.sourceRefs.engine)) : null;
  return { producer, execution, source: { key: selection.key, ...compactSnapshot(source) }, ...(engine ? { engine } : {}),
    componentSha256: binding.componentSha256, core: binding.core };
}
function reportExecutionBundle(recorded, current) {
  // Compare only to independently derived allowed roots before touching any
  // path from a report. A third checkout cannot become execution authority.
  const execution = [current.producer, current.execution].find(value => value.bundleRoot === recorded?.execution?.bundleRoot);
  if (!execution || canonicalDigest(recorded) !== canonicalDigest({ ...current, execution })) fail('source report producer/executing harness provenance differs');
  return execution.bundleRoot;
}

export function describeSourceExecutionScope(selection, subject, inputs) {
  return { schema: 'toolsenabled.source-execution-scope', schemaVersion: 1,
    scope: 'complete-source-obligations-on-one-native-host', ready: false, platform: process.platform, arch: process.arch,
    sourceRefs: structuredClone(subject?.sourceRefs || null), implementationSha256: implementation(), sourceInputsSha256: inputs.sha256,
    selectionSha256: digest({ id: selection.id, files: selection.files, crossFiles: selection.crossFiles,
      aliases: selection.aliases, commands: selection.commands }),
    requiredNativeCases: requiredNativeSourceCases(selection.id, selection.files),
    companionEvidence: 'unimplemented: another host requires exact-source native execution and independent native replay' };
}

export function assertSourceExecutionScope(scope, selection, subject, inputs) {
  if (json(scope) !== json(describeSourceExecutionScope(selection, subject, inputs))) fail('source execution platform, source binding or companion scope differs');
}

export function inspectSourceCoverageRecords(selection, jobs, records, directory) {
  // This ledger is diagnostic. Complete qualification still verifies every
  // owned job, original wrapper report, source snapshot and native replay.
  // Record it before that verdict so an honest failed/omitted case survives.
  const read = value => {
    if (!value || !inside(directory, fencedPath(value.path)) || json(fileIdentity(value.path)) !== json(value)) fail('coverage output identity differs or escaped its report');
    return readBounded(unlinkedPath(value.path), 64 * 1024 * 1024).toString('utf8');
  };
  return jobs.map((job, index) => {
    const record = records[index], base = { jobIndex: index, file: job.file, actionId: job.actionId || null,
      countScope: job.actionId ? 'supplemental-observation-not-added-to-leaf-counts' : 'source-leaf',
      exitCode: record?.exitCode ?? null, cleanupConfirmed: record?.cleanupConfirmed === true,
      stdout: record?.stdout || null, stderr: record?.stderr || null };
    try {
      let stdout = read(record.stdout), stderr = read(record.stderr);
      let files = job.file.startsWith('harness:') ? [] : [path.isAbsolute(job.file)
        ? portable(path.relative(inside(selection.root, job.file) ? selection.root : selection.checkout, job.file)) : portable(job.file)];
      let retained = null;
      if (job.strictBinding) {
        const wrapperOutput = stdout;
        const declared = [...stdout.matchAll(/^Raw suite output retained at (.+)\r?$/gm)];
        const temp = path.join(job.strictBinding.scratch, 'temp');
        const raw = declared.length === 1 ? declared[0][1].trimEnd() : null;
        if (!raw || path.dirname(raw) !== temp || !/^toolsenabled-test-output-[a-zA-Z0-9]+$/.test(path.basename(raw))) fail('strict coverage lacks one bound private raw output directory');
        const identities = ['run.json', 'stdout.log', 'stderr.log'].map(name => fileIdentity(path.join(raw, name)));
        const metadata = JSON.parse(read(identities[0]));
        stdout = read(identities[1]); stderr = read(identities[2]);
        if (metadata.schemaVersion !== 1 || metadata.cwd !== job.cwd || metadata.command !== 'npm test' ||
          ![0, 1].includes(metadata.exitCode) || metadata.signal !== null ||
          json(metadata.stdout) !== json({ bytes: identities[1].bytes, sha256: identities[1].sha256 }) ||
          json(metadata.stderr) !== json({ bytes: identities[2].bytes, sha256: identities[2].sha256 })) fail('strict coverage raw metadata differs');
        files = selection.files; retained = identities;
        const analysis = inspectSourceExecutionCoverage(stdout, { suite: selection.id, files, platform: process.platform });
        if (metadata.exitCode !== (analysis.counts.failed || analysis.failures.length ? 1 : 0)) fail('strict coverage raw process exit differs from TAP');
        const summaries = [...wrapperOutput.matchAll(/^Ran (\d+) tests: (\d+) pass, (\d+) fail, (\d+) skipped \(\d+ failing top-level test\(s\), suite exit (\d+)\)\.\r?$/gm)];
        const totals = summaries.length === 1 ? summaries[0].slice(1).map(Number) : [];
        if (json(totals) !== json([analysis.counts.tests, analysis.counts.passed, analysis.counts.failed,
          analysis.counts.skipped, metadata.exitCode])) fail('strict coverage wrapper and raw TAP counts differ');
        return { ...base, status: 'reconciled-raw-observation', retained, analysis };
      }
      if (/^TAP version 13\r?$/m.test(stdout)) return { ...base, status: 'reconciled-raw-observation',
        analysis: inspectSourceExecutionCoverage(stdout, { suite: selection.id, files, platform: process.platform }) };
      const observed = parseSourceOutput(stdout, stderr, job);
      return { ...base, status: 'reconciled-raw-observation', analysis: { scope: 'source-execution-coverage-analysis',
        ready: false, platform: process.platform, counts: observed, failures: [], obligations: [], nativeCases: [] } };
    } catch (error) {
      return { ...base, status: 'incomplete-raw-observation', error: { code: error.code || 'SOURCE_COVERAGE_UNREADABLE', message: error.message } };
    }
  });
}

export function verifySourceActionEvidence(stdout, stderr, job) {
  if (job.roleStudioBinding || job.reporter === ROLE_STUDIO_SOURCE_ACTION.reporter || job.actionId === ROLE_STUDIO_SOURCE_ACTION.id) {
    if (!job.roleStudioBinding) fail('Role Studio action is missing its measured source context');
    return verifyRoleStudioSourceFiles(stdout, stderr, job);
  }
  if (job.strictBinding) return verifyStrictReleaseFiles(stdout, stderr, job);
  return null;
}
function retainedActionEvidence(jobs, records) {
  return jobs.map((job, index) => {
    if (!job.strictBinding && !job.roleStudioBinding) return null;
    try { return verifySourceActionEvidence(fs.readFileSync(records[index].stdout.path, 'utf8'), fs.readFileSync(records[index].stderr.path, 'utf8'), job); }
    catch (error) { return { incomplete: { code: error.code || 'SOURCE_ACTION_INCOMPLETE', message: error.message } }; }
  });
}

// A bounded fixed action can be exercised while the complete source selection
// is blocked. Its report and independent native replay never become a complete
// source observation or discharge the other OS's leaf.
function custodyOptions(options) {
  if (!options || Object.keys(options).some(key => !['sourceRoot', 'sourceRef', 'evidenceRoot', 'signal'].includes(key))
      || !/^[a-f0-9]{40}$/.test(options.sourceRef || '') || !Object.hasOwn(NATIVE_CUSTODY_LEAVES, process.platform))
    fail('native custody action needs exact source inputs on a supported host');
  const sourceRoot = unlinkedPath(options.sourceRoot, { directory: true });
  if (sourceRoot !== options.sourceRoot) fail('native custody source path is not ordinary absolute');
  const evidenceRoot = assertNativeCustodyEvidence(options.evidenceRoot);
  checkEvidenceRoot({ evidenceRoot }, { checkout: sourceRoot });
  return { ...options, sourceRoot, evidenceRoot };
}
async function custodyProvenance(options, directory) {
  const { sourceRoot, sourceRef, signal } = options;
  const harness = await measureNativeCustodyHarness({ evidenceRoot: directory, signal });
  if (inside(harness.root, options.evidenceRoot) || inside(options.evidenceRoot, harness.root))
    fail('native custody evidence overlaps its executing harness');
  const measured = process.platform === 'linux'
    ? await nativeCleanSourceSnapshot(sourceRoot, sourceRef, { evidenceRoot: directory, signal, target: { platform: 'linux', arch: 'x64' } })
    : cleanSourceSnapshot(sourceRoot, sourceRef);
  const { nativeExecution = null, ...source } = measured;
  return { identity: { source, harness: { root: harness.root, source: harness.source,
    componentSha256: harness.componentSha256, core: harness.core } },
    nativeExecution: [...harness.nativeExecution, ...(nativeExecution ? [nativeExecution] : [])] };
}
function custodyReportScope() {
  return { scope: 'native-custody-source-action', ready: false, platform: process.platform, arch: process.arch,
    companion: { platform: process.platform === 'linux' ? 'win32' : 'linux', status: 'unexecuted' },
    authority: 'Selected native source action only; complete source, paired native replay and installed qualification remain required.' };
}
async function executeCustody(options, expectedProvenance) {
  options.signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(options.evidenceRoot, 'n-'));
  assertNativeCustodyEvidence(directory);
  // Fail before any process if the native Unix socket margin cannot fit.
  if (process.platform === 'linux' && Buffer.byteLength(path.join(directory, 'nc')) + 56 >= 100)
    fail('native custody evidence path is too long');
  const before = await custodyProvenance(options, directory);
  if (expectedProvenance !== undefined && canonicalDigest(before.identity) !== canonicalDigest(expectedProvenance))
    fail('native custody report provenance differs from current exact inputs');
  const tools = registeredTools(), job = nativeCustodyJob(options.sourceRoot, directory, path.resolve(HERE, '..'));
  const records = await runOwnedJobBatch({ jobs: [job], evidenceRoot: directory, signal: options.signal, batchTimeoutMs: 650000 });
  assertSourceCleanupConfirmed(records);
  const after = await custodyProvenance(options, directory);
  const report = { schema: 'toolsenabled.native-custody-action', schemaVersion: 1, ...custodyReportScope(),
    sourceRoot: options.sourceRoot, sourceRef: options.sourceRef, provenance: before.identity,
    afterProvenance: after.identity, measurementExecution: [...before.nativeExecution, ...after.nativeExecution],
    tools, job, records };
  const reportIdentity = writePrivate(path.join(directory, 'custody-report.json'), report);
  try {
    if (canonicalDigest(before.identity) !== canonicalDigest(after.identity)) fail('native custody source/harness changed during execution');
    if (json(tools) !== json(registeredTools()) || records.length !== 1) fail('native custody tools or actual selection differs');
    verifyJob(records[0], job, directory, tools, true);
  } catch (error) { error.report = reportIdentity; throw error; }
  return { reportIdentity, ...custodyReportScope(), verified: true };
}

export async function runNativeCustodySourceAction(options) {
  return executeCustody(custodyOptions(options));
}

export async function verifyNativeCustodySourceAction(reportIdentity, options) {
  options = custodyOptions(options);
  if (!reportIdentity || !inside(options.evidenceRoot, fencedPath(reportIdentity.path))
      || json(fileIdentity(reportIdentity.path)) !== json(reportIdentity)) fail('native custody report identity changed or escaped');
  const directory = assertNativeCustodyEvidence(path.dirname(reportIdentity.path));
  const report = readJson(reportIdentity.path);
  const scope = custodyReportScope();
  if (report.schema !== 'toolsenabled.native-custody-action' || report.schemaVersion !== 1
      || report.sourceRoot !== options.sourceRoot || report.sourceRef !== options.sourceRef
      || Object.entries(scope).some(([key, value]) => canonicalDigest(report[key]) !== canonicalDigest(value)))
    fail('native custody report source, host or scope differs');
  const verificationDirectory = fs.mkdtempSync(path.join(options.evidenceRoot, 'v-'));
  if (!report.provenance || typeof report.provenance !== 'object' || Array.isArray(report.provenance)
      || canonicalDigest(report.provenance) !== canonicalDigest(report.afterProvenance))
    fail('native custody report changed source provenance');
  const tools = registeredTools(), expected = nativeCustodyJob(options.sourceRoot, directory, path.resolve(HERE, '..'));
  if (json(report.tools) !== json(tools) || json(report.job) !== json(expected)
      || !Array.isArray(report.records) || report.records.length !== 1) fail('native custody recorded job differs from the fixed native action');
  assertSourceCleanupConfirmed(report.records);
  verifyJob(report.records[0], expected, directory, tools, true);
  // Re-execute the same fixed host selection in a new owned directory. Neither
  // the submitted command, receipt paths nor a verifier callback select work.
  // The replay's native before-measurement also checks the submitted source
  // and harness identity, before any test child starts. Its after-measurement
  // remains separate; no duplicate Git measurement or old snapshot is reused.
  const replay = await executeCustody(options, report.provenance);
  const verified = { schema: 'toolsenabled.native-custody-action-replay', schemaVersion: 1,
    ...scope, verified: true, original: reportIdentity, replay: replay.reportIdentity };
  const verification = writePrivate(path.join(verificationDirectory, 'custody-verification.json'), verified);
  return { ...scope, verified: true, original: reportIdentity, replay: replay.reportIdentity, verification };
}


async function runSelection({ id, context, subject, run, partial = false, signal }) {
  signal?.throwIfAborted();
  if (subject && (!subject.context || canonicalDigest(subject.context) !== canonicalDigest(context))) fail('source execution context differs from its measured subject');
  const selection = inspectSourceSuite(id, context);
  if (!partial && !selection.complete) fail(json(selection.obligations));
  const evidenceRoot = checkEvidenceRoot(context, selection);
  const provenance = partial ? null : sourceProvenance(subject, context, selection);
  // Native custody uses Unix sockets below its evidence directory. Keep the
  // fixed suite prefix short; the wrapper still refuses an overlong root.
  const directory = fs.mkdtempSync(path.join(evidenceRoot,
    selection.commands.some(action => action.context === 'engine-native-custody-scratch') ? 's-' : 'source-suite-'));
  const start = new Date().toISOString(), implementationSha256 = implementation();
  const strictInputs = !partial && id === 'app' ? measureStrictSourceInputs(selection, context, subject) : null;
  const strictTools = strictInputs ? strictRunnerInputs() : null;
  const before = snapshot(selection), jobs = planSourceSuiteJobs(selection, directory, { partial, strictInputs, sourceRef: provenance?.source.ref });
  if (strictInputs) fs.mkdirSync(path.join(directory, 'strict-scratch'), { mode: 0o700 });
  const tools = registeredTools();
  const records = await runOwnedJobBatch({ jobs, evidenceRoot: directory, signal, batchTimeoutMs: partial ? 30000 : 90 * 60 * 1000 });
  assertSourceCleanupConfirmed(records);
  const coverage = inspectSourceCoverageRecords(selection, jobs, records, directory);
  const actionEvidence = retainedActionEvidence(jobs, records);
  const after = snapshot(selection);
  if (strictTools && json(strictRunnerInputs()) !== json(strictTools)) fail('strict npm runner inputs changed during execution');
  if (strictInputs && json(measureStrictSourceInputs(selection, context, subject)) !== json(strictInputs)) fail('strict release source, payload, dependency or runner inputs changed');
  if (!partial && canonicalDigest(sourceProvenance(subject, context, selection)) !== canonicalDigest(provenance)) fail('source or harness provenance changed during execution');
  const report = { schema: 'toolsenabled.source-suite-execution', schemaVersion: 3, id, partial, ready: false,
    sourceOnly: true, startedAt: start, finishedAt: new Date().toISOString(), implementationSha256,
    context, subjectSha256: subject ? canonicalDigest(subject) : null, runId: run?.id || null,
    selection, provenance, strictInputs, strictTools, inputs: before, afterSha256: after.sha256, tools, jobs, records,
    executionScope: describeSourceExecutionScope(selection, subject, before), coverage,
    actionEvidence, toolchain: { sha256: digest(tools), bytes: Buffer.byteLength(json(tools)) } };
  const reportIdentity = writePrivate(path.join(directory, 'source-report.json'), report);
  let measured;
  try { measured = verifySourceReport(reportIdentity, { allowPartial: partial, subject }); }
  catch (error) { error.report = reportIdentity; throw error; }
  return { report, reportIdentity, measured };
}
function canonical(value) { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${json(key)}:${canonical(value[key])}`).join(',')}}` : json(value); }
function canonicalDigest(value) { return sha(canonical(value)); }

export function verifySourceReport(reportIdentity, { allowPartial = false, subject } = {}) {
  if (json(fileIdentity(reportIdentity?.path)) !== json(reportIdentity)) fail('source report identity changed');
  const report = readJson(reportIdentity.path), directory = path.dirname(reportIdentity.path);
  if (report.schema !== 'toolsenabled.source-suite-execution' || report.schemaVersion !== 3 || report.ready !== false || report.sourceOnly !== true ||
    (report.partial && !allowPartial) || report.implementationSha256 !== implementation()) fail('wrong source report scope or driver identity');
  if (subject && (report.subjectSha256 !== canonicalDigest(subject) || !subject.context ||
    canonicalDigest(report.context) !== canonicalDigest(subject.context))) fail('source report belongs to a different subject or context');
  const selection = inspectSourceSuite(report.id, report.context);
  if ((!report.partial && !selection.complete) || json(selection) !== json(report.selection)) fail('source selection or required aliases changed');
  checkEvidenceRoot(report.context, selection);
  const provenance = report.partial ? null : sourceProvenance(subject, report.context, selection);
  if (report.partial && report.provenance !== null) fail('partial source evidence cannot claim qualified harness provenance');
  const executionBundle = report.partial ? path.resolve(HERE, '..') : reportExecutionBundle(report.provenance, provenance);
  const strictInputs = !report.partial && report.id === 'app' ? measureStrictSourceInputs(selection, report.context, subject) : null;
  if (json(strictInputs ? strictRunnerInputs() : null) !== json(report.strictTools)) fail('strict npm runner inputs differ from execution');
  if (json(strictInputs) !== json(report.strictInputs)) fail('strict release inputs differ from their execution binding');
  const expectedJobs = jobsAtBundle(selection, directory, { partial: report.partial, strictInputs, sourceRef: provenance?.source.ref }, executionBundle);
  if (json(expectedJobs) !== json(report.jobs) || report.records?.length !== expectedJobs.length || !expectedJobs.length) fail('missing, extra or changed required source commands');
  const tools = registeredTools();
  if (json(tools) !== json(report.tools) || digest(tools) !== report.toolchain.sha256 || Buffer.byteLength(json(tools)) !== report.toolchain.bytes) fail('registered toolchain bytes changed');
  const current = snapshot(selection);
  if (current.sha256 !== report.inputs.sha256 || current.sha256 !== report.afterSha256 || json(current) !== json(report.inputs)) fail('source/helper input drift');
  assertSourceExecutionScope(report.executionScope, selection, subject, current);
  if (json(report.coverage) !== json(inspectSourceCoverageRecords(selection, expectedJobs, report.records, directory))) fail('source execution coverage differs from its raw records');
  const measured = expectedJobs.map((job, index) => verifyJob(report.records[index], job, directory, tools));
  const obligations = report.coverage.flatMap(row => row.analysis?.obligations || []);
  if (obligations.length) fail(`source execution scope has unmet obligations: ${json(obligations)}`);
  const actionEvidence = expectedJobs.map((job, index) => verifySourceActionEvidence(
    fs.readFileSync(report.records[index].stdout.path, 'utf8'), fs.readFileSync(report.records[index].stderr.path, 'utf8'), job));
  if (json(actionEvidence) !== json(report.actionEvidence)) fail('source action retained raw evidence identity changed');
  const tests = measured.reduce((sum, result) => sum + result.tests, 0);
  if (!tests) fail('zero observed tests');
  if (!report.partial && canonicalDigest(sourceProvenance(subject, report.context, selection)) !== canonicalDigest(provenance)) fail('source or harness provenance changed during report verification');
  return counts(tests);
}

// Diagnostic only: the sole initially reviewed safe subset exercises shared
// setup/render behavior with local dependency doubles. It has no provider,
// installer or desktop authority and cannot emit a complete-scope observation.
export async function runSafeSourceSelection({ selection, context, signal } = {}) {
  if (selection !== 'shared:first-run-setup') fail('unknown/unreviewed safe partial selection');
  const result = await runSelection({ id: 'shared', context, partial: true, signal });
  return { scope: 'partial-source-selection', ready: false, counts: result.measured, report: result.reportIdentity };
}

export function getSourceSuiteAdapter(id) {
  if (!Object.hasOwn(SOURCE_MANIFESTS, id) && !['reaper', 'loops', 'agents'].includes(id)) fail('unknown fixed source adapter');
  const adapterId = `source-suite:${id}:v1`, adapterSha256 = implementation();
  const adapter = Object.freeze({ id: adapterId, sha256: adapterSha256, proofScope: 'complete-source-suite',
    execution: 'real', supportedProfiles: Object.freeze(['build']),
    // Full selection owns a 90-minute batch plus bounded job cleanup.
    verificationTimeoutMs: 95 * 60 * 1000,
    async execute(input) {
      if (adapterSha256 !== implementation()) fail('source adapter implementation changed since registration');
      if (input.required?.id !== `source:${id}` || input.required.scope !== adapter.proofScope ||
        !adapter.supportedProfiles.includes(input.profile) ||
        input.subjectSha256 !== canonicalDigest(input.subject) || !input.run?.id) fail('wrong source contract invocation');
      const result = await runSelection({ id, context: input.context, subject: input.subject, run: input.run, signal: input.signal });
      return { id: `source:${id}`, profile: input.profile, scope: adapter.proofScope, adapterId: adapter.id, adapterSha256: adapter.sha256,
        subjectSha256: input.subjectSha256, runId: input.run.id, startedAt: result.report.startedAt, finishedAt: result.report.finishedAt,
        execution: { complete: true, exitCode: 0, signal: null, cleanupConfirmed: true, synthetic: false, sourceOverlay: false,
          hostRuntime: true, toolchainScope: 'registered-source-tools', toolchain: result.report.toolchain,
          command: result.report.records[0].command },
        environment: { platform: process.platform, arch: process.arch, profile: input.profile, osBuild: os.release(), isolated: true,
          isolation: 'owned-job-process-tree; source scope, not an installed/guest proof' },
        report: result.reportIdentity, counts: result.measured,
        assertions: ASSERTIONS.map(assertion => ({ id: assertion, status: 'passed', evidenceSha256: result.reportIdentity.sha256 })) };
    },
    async verifyExecutionEvidence(observation, subject, { signal } = {}) {
      try {
        signal?.throwIfAborted();
        if (adapterSha256 !== implementation()) return false;
        if (observation?.id !== `source:${id}` || observation.adapterId !== adapterId || observation.adapterSha256 !== adapterSha256 ||
          observation.scope !== adapter.proofScope || !adapter.supportedProfiles.includes(observation.profile) ||
          observation.subjectSha256 !== canonicalDigest(subject)) return false;
        const report = readJson(observation.report.path);
        if (report.partial || report.id !== id || report.runId !== observation.runId ||
          report.executionScope?.platform !== observation.environment?.platform || report.executionScope?.arch !== observation.environment?.arch ||
          json(report.records?.[0]?.command) !== json(observation.execution?.command) ||
          json(report.toolchain) !== json(observation.execution?.toolchain)) return false;
        const stored = verifySourceReport(observation.report, { subject });
        if (json(stored) !== json(observation.counts)) return false;
        // The caller can rewrite JSON, stdout and every hash referencing them.
        // Structural reconciliation is necessary but is NOT proof of execution.
        // Independently rerun the fixed selection from the measured subject,
        // never commands or a green flag taken from the submitted report.
        const replay = await runSelection({ id, context: subject.context, subject, run: { id: observation.runId }, signal });
        signal?.throwIfAborted();
        if (json(replay.measured) !== json(stored)) return false;
        return json(verifySourceReport(observation.report, { subject })) === json(stored);
      } catch (error) {
        // Core must wait for cleanup and preserve/quarantine unfinished scope;
        // a plain false would erase the distinction from an ordinary red test.
        if (error?.cleanupUnconfirmed === true) throw error;
        return false;
      }
    },
  });
  return adapter;
}
