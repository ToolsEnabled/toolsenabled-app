import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(REPO, 'tools', 'check-license-notices.mjs');

function runGate(path) {
  const result = spawnSync(process.execPath, [path], { encoding: 'utf8' });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

test('check-license-notices refuses an empty production-dependency enumeration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'check-license-notices-empty-'));
  try {
    mkdirSync(join(fixture, 'tools'));
    copyFileSync(GATE, join(fixture, 'tools', 'check-license-notices.mjs'));
    for (const document of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md']) {
      copyFileSync(join(REPO, document), join(fixture, document));
    }
    writeFileSync(
      join(fixture, 'THIRD-PARTY-LICENSES.md'),
      '# Third-party licenses\n\nNo production dependencies.\n'
    );
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'empty-license-fixture', dependencies: {} })
    );

    const { status, output } = runGate(join(fixture, 'tools', 'check-license-notices.mjs'));

    assert.equal(status, 1, `expected refusal, got ${status}:\n${output}`);
    assert.match(
      output,
      /root package\.json declares no production dependencies; the license-notice enumeration checked nothing/
    );
    assert.match(output, /LICENSE NOTICE GATE: FAIL/);
    assert.doesNotMatch(output, /LICENSE NOTICE GATE: PASS/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('check-license-notices still passes the healthy repository', () => {
  const { status, output } = runGate(GATE);

  assert.equal(status, 0, `expected healthy repository to pass, got ${status}:\n${output}`);
  assert.match(output, /LICENSE NOTICE GATE: PASS -- scope: repository/);
  assert.doesNotMatch(output, /LICENSE NOTICE GATE: FAIL/);
});

// Execute the unchanged gate against a complete owned dependency graph. The
// synthetic license markers identify which installed copy it actually reads;
// these fixtures make no assertion about a third-party license's legal terms.
function dependencyFixture(t, { sharedVersion = '2.0.0', matchingHoist = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'license-nested-dependency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  copyFileSync(GATE, join(root, 'tools', 'check-license-notices.mjs'));
  for (const name of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md']) copyFileSync(join(REPO, name), join(root, name));
  const marker = (name, version) => `Owned license body fixture for ${name} version ${version}; this exact installed text must be retained.\n`;
  function installed(relative, name, version, dependencies = {}) {
    const directory = join(root, relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, dependencies }));
    const body = marker(name, version);
    writeFileSync(join(directory, 'LICENSE'), body);
    return { name, version, directory, body };
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'owned-license-fixture',
    dependencies: { 'first-parent': '1.0.0', 'second-parent': '1.0.0' },
    devDependencies: { 'nested-license-fixture': '9.0.0' } }));
  const first = installed('node_modules/first-parent', 'first-parent', '1.0.0', { 'nested-license-fixture': '1.0.0' });
  const second = installed('node_modules/second-parent', 'second-parent', '1.0.0', { 'nested-license-fixture': sharedVersion });
  const nestedFirst = installed('node_modules/first-parent/node_modules/nested-license-fixture', 'nested-license-fixture', '1.0.0');
  const nestedSecond = installed('node_modules/second-parent/node_modules/nested-license-fixture', 'nested-license-fixture', sharedVersion);
  const hoisted = installed('node_modules/nested-license-fixture', 'nested-license-fixture', '9.0.0');
  if (matchingHoist) writeFileSync(join(hoisted.directory, 'LICENSE'), nestedSecond.body);
  const notices = [first, second, nestedFirst, nestedSecond];
  function writeNotices(rows = notices) {
    writeFileSync(join(root, 'THIRD-PARTY-LICENSES.md'), '# Owned license fixture\n\n' + rows.map(row =>
      `### ${row.name} ${row.version} — FIXTURE\n\n\`\`\`text\n${row.body}\`\`\`\n`).join('\n'));
  }
  writeNotices();
  return { nestedFirst, nestedSecond, notices, writeNotices,
    run: () => runGate(join(root, 'tools', 'check-license-notices.mjs')) };
}

test('the license gate reads the actual nested production package rather than a hoisted development version', t => {
  const fixture = dependencyFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /LICENSE NOTICE GATE: PASS/);
});

test('every installed production version requires its own notice section', t => {
  const fixture = dependencyFixture(t, { matchingHoist: true });
  const healthy = fixture.run();
  assert.equal(healthy.status, 0, healthy.output);
  fixture.writeNotices(fixture.notices.filter(row => row !== fixture.nestedFirst));
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /production dependency "nested-license-fixture@1\.0\.0" has no section/);
});

test('a changed nested license cannot be replaced by another installed version with a valid notice', t => {
  const fixture = dependencyFixture(t, { matchingHoist: true });
  const healthy = fixture.run();
  assert.equal(healthy.status, 0, healthy.output);
  writeFileSync(join(fixture.nestedFirst.directory, 'LICENSE'), 'Changed nested production license fixture body that has never appeared in the notice.\n');
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /names "nested-license-fixture" but does not reproduce its license text/);
});

test('separate installed copies of the same production version both have their actual license checked', t => {
  const fixture = dependencyFixture(t, { sharedVersion: '1.0.0', matchingHoist: true });
  const healthy = fixture.run();
  assert.equal(healthy.status, 0, healthy.output);
  writeFileSync(join(fixture.nestedSecond.directory, 'LICENSE'), 'Changed second installed copy of one production version with an unreported license body.\n');
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /names "nested-license-fixture" but does not reproduce its license text/);
});
