import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { ROLE_STUDIO_SOURCE_ACTION, parseRoleStudioSourceTranscript, validateRoleStudioSourceEvidence } from '../lib/adapters/role-studio-source.mjs';
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs';
const require = createRequire(import.meta.url);
const ids = require('../lib/page2-native-role-scenarios.cjs').scenarios.map(row => row.id);
const expected = { root: path.resolve('app-fixture'), canonicalRoot: path.resolve('engine-fixture'),
  outputRoot: path.join(os.tmpdir(), 'role-source-values'), appRef: 'a'.repeat(40), engineRef: 'b'.repeat(40) };
const directory = path.join(expected.outputRoot, 'role-component-abc123');
const pin = { sha256: 'c'.repeat(64), version: '43.3.0', platform: process.platform, arch: process.arch };
function values() {
  const results = ids.map(id => ({ id, passed: true }));
  const summary = { passed: true, results };
  const transcript = { directory, summary };
  const stdout = ids.map(id => 'Component case: ' + id).join('\n') + '\nRole component evidence: ' + directory + '\n' + JSON.stringify(summary);
  const report = {
    scope: 'Actual Role Studio component and App/Engine stores; fixture navigation and IPC envelope, no full-app or provider qualification',
    passed: true, closed: true, errors: [], requiredCases: [...ids], results,
    dependencies: { scope: 'prepared-local', qualificationEligible: true, archiveSha256: pin.sha256,
      version: pin.version, platform: pin.platform, arch: pin.arch, files: 10,
      modulesDirectory: path.join(expected.root, 'node_modules'),
      executable: path.join(expected.root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
      playwrightModule: path.join(expected.root, 'node_modules/playwright') },
    bootstrap: { ready: true, electron: pin.version, argv: ['electron',
      path.join(expected.root, ROLE_STUDIO_SOURCE_ACTION.command[1]), directory, expected.root, expected.canonicalRoot] },
    events: [{ id: 'observed-role-change' }], writes: [{ method: 'createRole' }],
    guidePreparation: { states: [{ viewed: true }] }, guideReload: { viewed: true },
  };
  return { transcript, stdout, report };
}
const refused = call => assert.throws(call, { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });

test('Role Studio command requires its exact context executor even when a generic command or leaf claims coverage', () => {
  const command = [...ROLE_STUDIO_SOURCE_ACTION.command];
  const base = { aliases: { 'test:component': command.join(' ') }, selectedFiles: [command[1]], coveredCommands: [command] };
  assert.equal(reconcileSourceCommands(base).complete, false);
  assert.equal(reconcileSourceCommands({ ...base, contextCommands: [{ command, context: 'app-strict-engine-scratch' }] }).complete, false);
  assert.equal(reconcileSourceCommands({ ...base, contextCommands: [ROLE_STUDIO_SOURCE_ACTION] }).complete, true);
  assert.equal(reconcileSourceCommands({ ...base, aliases: { 'test:component': command.join(' ') + ' --modules kit' },
    contextCommands: [ROLE_STUDIO_SOURCE_ACTION] }).complete, false);
});

test('Role Studio accepts the real complete transcript shape and closed prepared-local evidence', () => {
  const value = values();
  assert.deepEqual(parseRoleStudioSourceTranscript(value.stdout, '', expected), value.transcript);
  const counts = validateRoleStudioSourceEvidence(value.report, value.transcript, expected, pin);
  assert.equal(counts.tests, ids.length);
  assert.equal(counts.passed, ids.length);
  assert.equal(counts.failed + counts.skipped + counts.cancelled + counts.notRun, 0);
});

test('Role Studio refuses missing duplicated reordered or failed scenario output and escaped evidence paths', () => {
  const { stdout } = values();
  for (const value of ['', stdout.replace('Component case: ' + ids[0] + '\n', ''),
    'Component case: ' + ids[0] + '\n' + stdout,
    stdout.replace('Component case: ' + ids[0], 'Component case: unknown'),
    stdout.replace(directory, path.join(expected.root, 'role-component-abc123')),
    stdout.replace('"passed":true', '"passed":false'), stdout + '\n{}']) {
    refused(() => parseRoleStudioSourceTranscript(value, '', expected));
  }
  refused(() => parseRoleStudioSourceTranscript(stdout, 'native refusal', expected));
});

test('Role Studio refuses incomplete or unclosed evidence and changed required result populations', () => {
  for (const mutate of [value => { value.closed = false; }, value => { value.passed = false; },
    value => { value.errors.push('renderer failed'); }, value => { value.requiredCases.pop(); },
    value => { value.results = value.results.slice(1); }, value => { value.events = []; },
    value => { value.writes = []; }, value => { value.guideReload = {}; }]) {
    const { report, transcript } = values(); mutate(report);
    refused(() => validateRoleStudioSourceEvidence(report, transcript, expected, pin));
  }
});

test('Role Studio refuses engineering kits unpinned archives and dependency roots outside the selected source', () => {
  for (const mutate of [value => { value.scope = 'engineering-kit'; }, value => { value.qualificationEligible = false; },
    value => { value.archiveSha256 = 'd'.repeat(64); }, value => { value.version = '0.0.0'; },
    value => { value.platform = 'unknown'; }, value => { value.arch = 'unknown'; },
    value => { value.files = 0; }, value => { value.modulesDirectory = expected.canonicalRoot; },
    value => { value.executable = path.join(expected.outputRoot, 'electron'); },
    value => { value.playwrightModule = expected.outputRoot; }]) {
    const { report, transcript } = values(); mutate(report.dependencies);
    refused(() => validateRoleStudioSourceEvidence(report, transcript, expected, pin));
  }
});

test('Role Studio refuses wrong app engine process or source ref binding', () => {
  for (const mutate of [value => { value.ready = false; }, value => { value.electron = '0.0.0'; },
    value => { value.argv.pop(); }, value => { value.argv[value.argv.length - 1] = expected.root; }]) {
    const { report, transcript } = values(); mutate(report.bootstrap);
    refused(() => validateRoleStudioSourceEvidence(report, transcript, expected, pin));
  }
  const { stdout } = values();
  for (const change of [{ appRef: '' }, { engineRef: 'branch-name' }, { root: expected.canonicalRoot },
    { outputRoot: path.join(expected.root, 'output') }, { canonicalRoot: 'relative' }]) {
    refused(() => parseRoleStudioSourceTranscript(stdout, '', { ...expected, ...change }));
  }
});
