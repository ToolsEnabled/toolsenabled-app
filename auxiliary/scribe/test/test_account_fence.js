#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
const AUXILIARY_ROOT = path.join(ROOT, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const defaultTest = String(packageJson.scripts && packageJson.scripts.test || '');
const liveOnly = [
  'test_docmodel.py',
  'test_runtime_boundaries.js',
  'test_server.js',
  'test_viewer.js',
  'test_watch.js',
  'test_predict.js',
  'test_format.js',
  'test_lane.js',
  'test_propose.js',
  'test_model.js',
  'test_voice.js',
  'test_perf.js',
  'test_agent_live.js',
  'test_flow_live.js',
];
const executableExtensions = new Set(['.js', '.cjs', '.mjs', '.py', '.json', '.ps1', '.cmd', '.bat', '.sh']);
const skippedDirectories = new Set(['node_modules', 'data', 'output', 'originals']);
const windowsUserPath = new RegExp('[A-Za-z]:[\\\\/]+Users[\\\\/]+[A-Za-z0-9._-]+', 'i');
const unixUserPath = new RegExp('(?:^|[\\s\'"`])\\/Users\\/[A-Za-z0-9._-]+', 'm');

function executableFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) found.push(...executableFiles(path.join(directory, entry.name)));
    } else if (entry.isFile() && executableExtensions.has(path.extname(entry.name).toLowerCase())) {
      found.push(path.join(directory, entry.name));
    }
  }
  return found;
}

const checks = [];
function check(description, condition, detail = '') {
  checks.push({ description, ok: !!condition, detail });
}

check('default npm test excludes every opt-in live document test',
  liveOnly.every((name) => !defaultTest.includes(name)));

const liveSourcesUseExplicitInputs = liveOnly.every((name) => {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  return name.endsWith('.py')
    ? /required_live_file\("SCRIBE_TEST_DOCX"\)/.test(source)
    : /requiredLiveFile\('SCRIBE_TEST_(?:DOCX|LEGACY_DOCX)'\)/.test(source);
});
check('every opt-in live document test requires an explicit input helper',
  liveSourcesUseExplicitInputs);

const noInputEnv = { ...process.env };
delete noInputEnv.SCRIBE_TEST_DOCX;
delete noInputEnv.SCRIBE_TEST_LEGACY_DOCX;
const liveJsRefusals = liveOnly.filter((name) => name.endsWith('.js')).map((name) => {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    cwd: ROOT,
    env: noInputEnv,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return result.status !== 0 && /is required; no live test input/i.test(result.stderr || result.stdout || '');
});
check('every opt-in JavaScript live test fails closed when no input is selected',
  liveJsRefusals.every(Boolean));

const probeSource = fs.readFileSync(path.join(__dirname, 'probe-mcp-subagent.js'), 'utf8');
const paraIdSource = fs.readFileSync(path.join(__dirname, 'probe-paraid-runsplit.py'), 'utf8');
check('manual probes also use explicit path or PATH resolution with no profile fallback',
  /resolveExecutable\('SCRIBE_CLAUDE_EXE'/.test(probeSource)
    && /required_live_file\("SCRIBE_TEST_DOCX"\)/.test(paraIdSource));

const offenders = executableFiles(AUXILIARY_ROOT).filter((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return windowsUserPath.test(source) || unixUserPath.test(source);
});
check('auxiliary executable source contains no hardcoded user-profile path',
  offenders.length === 0,
  offenders.map((file) => path.relative(AUXILIARY_ROOT, file)).join(', '));

const prior = process.env.SCRIBE_TEST_DOCX;
delete process.env.SCRIBE_TEST_DOCX;
let absentRefused = false;
try { requiredLiveFile('SCRIBE_TEST_DOCX'); } catch (error) {
  absentRefused = /is required/i.test(error && error.message || '');
}
check('live input has no fallback when its explicit environment variable is absent', absentRefused);

process.env.SCRIBE_TEST_DOCX = path.join(path.dirname(process.env.USERPROFILE || os.homedir()), 'DefinitelyOtherProfile', 'never.docx');
let foreignRefused = false;
try { requiredLiveFile('SCRIBE_TEST_DOCX'); } catch (error) {
  foreignRefused = /different user profile/i.test(error && error.message || '');
}
check('an explicit path into a sibling profile is refused before use', foreignRefused);

process.env.SCRIBE_TEST_DOCX = '\\\\localhost\\untrusted-share\\fixture.docx';
let uncRefused = false;
try { requiredLiveFile('SCRIBE_TEST_DOCX'); } catch (error) {
  uncRefused = /UNC or device namespace/i.test(error && error.message || '');
}
check('an explicit UNC input is refused before use', uncRefused);
if (prior === undefined) delete process.env.SCRIBE_TEST_DOCX;
else process.env.SCRIBE_TEST_DOCX = prior;

let failed = 0;
for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.description}${result.detail ? `: ${result.detail}` : ''}`);
  if (!result.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
