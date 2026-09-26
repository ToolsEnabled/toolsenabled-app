import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
import { SOURCE_COMMAND_ACTIONS, SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs';
import { parseSourceOutput, verifySourceActionEvidence } from '../lib/adapters/source-suites.mjs';
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs';
const require = createRequire(import.meta.url);
const ids = require('../lib/page2-native-role-scenarios.cjs').scenarios.map(row => row.id);
const action = SOURCE_COMMAND_ACTIONS.app.find(row => row.id === 'app:role-studio-component');
const bound = { root: path.resolve('app-input'), canonicalRoot: path.resolve('engine-input'),
  outputRoot: path.join(os.tmpdir(), 'role-integration-evidence'), appRef: 'a'.repeat(40), engineRef: 'b'.repeat(40) };
const directory = path.join(bound.outputRoot, 'role-component-Abc123');
const stdout = ids.map(id => 'Component case: ' + id).join('\n') + '\nRole component evidence: ' + directory + '\n' +
  JSON.stringify({ passed: true, results: ids.map(id => ({ id, passed: true })) });

test('the actual source registry reconciles the Role Studio alias only through its context action', () => {
  assert.ok(action);
  const aliases = { 'test:role-studio-component': SOURCE_MANIFESTS.app.aliases['test:role-studio-component'] };
  const input = { aliases, selectedFiles: [], coveredCommands: SOURCE_COMMAND_ACTIONS.app.map(row => row.command) };
  assert.equal(reconcileSourceCommands(input).complete, false);
  assert.equal(reconcileSourceCommands({ ...input, contextCommands: SOURCE_COMMAND_ACTIONS.app }).complete, true);
});
test('the production source output dispatcher consumes every component case without double counting leaves', () => {
  assert.ok(action);
  const options = { ...action, roleStudioBinding: bound };
  assert.equal(parseSourceOutput(stdout, '', options).tests, 0);
  for (const invalid of ['', stdout.replace('Component case: ' + ids[0] + '\n', ''),
    stdout.replace('"passed":true', '"passed":false')]) {
    assert.throws(() => parseSourceOutput(invalid, '', options), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
});
test('retained action replay requires role context and reaches the actual evidence verifier', () => {
  assert.ok(action);
  assert.throws(() => verifySourceActionEvidence(stdout, '', action), /missing its measured source context/);
  assert.throws(() => verifySourceActionEvidence('', '', { ...action, roleStudioBinding: bound }), /scenario sequence/);
  const escaped = stdout.replace(directory, path.join(bound.root, 'role-component-Abc123'));
  assert.throws(() => verifySourceActionEvidence(escaped, '', { ...action, roleStudioBinding: bound }), /escaped/);
  assert.equal(verifySourceActionEvidence('', '', { file: 'ordinary-leaf' }), null);
});
test('the provider aggregate registers all current provider aliases exactly once and removes the empty invocation', () => {
  const aliases = SOURCE_MANIFESTS.engine.aliases;
  const providerNames = Object.keys(aliases).filter(name => name === 'test:providers' || name.startsWith('test:providers.')).sort();
  assert.equal(providerNames.length, 12);
  const plan = reconcileSourceCommands({ aliases: Object.fromEntries(['test:provider-release', ...providerNames].map(name => [name, aliases[name]])),
    selectedFiles: SOURCE_MANIFESTS.engine.inventory.filter(row => !row.reason).map(row => row.file),
    coveredCommands: SOURCE_COMMAND_ACTIONS.engine.flatMap(row => [row.command, ...(row.satisfies || [])]),
    contextCommands: SOURCE_COMMAND_ACTIONS.engine });
  assert.deepEqual(plan.obligations, []);
  const expanded = aliases['test:provider-release'].split(' && ').map(part => part.replace(/^npm run /, ''));
  assert.deepEqual(expanded, providerNames);
});
