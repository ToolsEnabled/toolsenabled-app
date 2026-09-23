#!/usr/bin/env node
'use strict';
/*
 * Default research-source quarantine. The configured-corpus behavior is
 * covered with temporary roots and databases in test_python_hosts.py; this
 * test pins the checked-in state so a clone never probes an inherited account.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const pythonArgs = process.platform === 'win32'
  ? ['-3', path.join(ROOT, 'engine', 'research.py')]
  : [path.join(ROOT, 'engine', 'research.py')];

const checks = [];
function check(description, condition) {
  checks.push({ description, ok: !!condition });
}

check('checked-in research configuration requires explicit activation',
  config.configured === false);
check('checked-in research configuration has no corpus roots',
  Array.isArray(config.roots) && config.roots.length === 0);
check('checked-in research configuration has no databases',
  Array.isArray(config.databases) && config.databases.length === 0);

const child = spawn(python, pythonArgs, {
  cwd: ROOT,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

for (const request of [
  { id: 'ping', cmd: 'ping' },
  { id: 'index', cmd: 'index', force: false },
  { id: 'db', cmd: 'db', db: 'anything', sql: 'SELECT 1' },
  { id: 'sources', cmd: 'sources' },
]) {
  child.stdin.write(JSON.stringify(request) + '\n');
}
child.stdin.end();

const timer = setTimeout(() => {
  child.kill();
  console.error('research host did not exit after stdin closed');
  process.exit(1);
}, 10_000);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error(error && error.stack || error);
  process.exit(1);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  const replies = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  check('research host starts without loading any configured path',
    code === 0 && byId.get('ping') && byId.get('ping').ok === true);
  for (const id of ['index', 'db', 'sources']) {
    const reply = byId.get(id);
    check(`${id} refuses while sources are unconfigured`,
      reply && reply.ok === false && /not configured/i.test(reply.error || ''));
  }

  let failed = 0;
  for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.description}`);
    if (!result.ok) failed++;
  }
  if (failed && stderr) console.error(stderr);
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
});
