#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

function runCli(port, args, editor = 'lead') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'ppt.js'), ...args], {
      cwd: __dirname,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        SUITE_HOST: '127.0.0.1',
        SUITE_PORT: String(port),
        SUITE_EDITOR: editor,
        NO_COLOR: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      requests.push({ method: req.method, url: req.url, body });
      let result = { ok: true };
      if (req.url === '/api/tasks') {
        result = {
          ok: true,
          task: {
            id: 'task-new',
            text: body.text,
            by: body.by,
            assignee: body.assignee,
            wakeWorker: body.wakeWorker,
          },
          dispatch: body.wakeWorker
            ? { ok: false, reason: 'no viewer present', queued: true }
            : null,
        };
      } else if (req.url === '/api/tasks/update') {
        const wakeWorker = Object.prototype.hasOwnProperty.call(body, 'wakeWorker')
          ? body.wakeWorker
          : !!body.assignee;
        result = {
          ok: true,
          task: {
            id: body.id,
            text: body.text || 'existing',
            assignee: Object.prototype.hasOwnProperty.call(body, 'assignee') ? body.assignee : 'worker-2',
            wakeWorker,
          },
          dispatch: wakeWorker === true
            ? { ok: false, reason: 'no viewer present', queued: true }
            : null,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const assigned = await runCli(port, [
      'task', 'Ship the assigned fix', '--for', 'worker-1',
    ], 'codex-root');
    check('ppt task sends explicit wake intent for a non-lead assignment',
      assigned.code === 0 && requests.some((request) =>
        request.url === '/api/tasks' && request.body.text === 'Ship the assigned fix' &&
        request.body.by === 'codex-root' && request.body.assignee === 'worker-1' &&
        request.body.wakeWorker === true));
    check('ppt task surfaces a queued non-lead wake instead of claiming delivery',
      /could not wake worker-1: no viewer present.*task is still queued/i.test(assigned.stdout));

    const passive = await runCli(port, ['task', 'Passive cleanup'], 'codex-root');
    check('ppt task marks an unassigned create as explicitly passive',
      passive.code === 0 && requests.some((request) =>
        request.url === '/api/tasks' && request.body.text === 'Passive cleanup' &&
        request.body.by === 'codex-root' && request.body.assignee === '' &&
        request.body.wakeWorker === false));

    const held = await runCli(port, [
      'task-hold', 'task-1', '--text', 'Redistributed instruction', '--for', 'worker-9',
    ]);
    check('task-hold exits successfully with clear ASCII hold output',
      held.code === 0
        && /\[ok\] held task-1 for worker-9; durable, automatic wake disabled/i.test(held.stdout)
        && !/â|�/.test(held.stdout + held.stderr));
    check('task-hold sends an explicit durable false wake intent',
      requests.some((request) => request.url === '/api/tasks/update'
        && request.body.id === 'task-1'
        && request.body.by === 'lead'
        && request.body.text === 'Redistributed instruction'
        && request.body.assignee === 'worker-9'
        && request.body.wakeWorker === false));

    const wake = await runCli(port, ['task-wake', 'task-1', '--for', 'worker-10']);
    check('task-wake clearly reports a gated but durable queued wake',
      wake.code === 0
        && /\[ok\] updated task-1 for worker-10/i.test(wake.stdout)
        && /\[warning\] not delivered: no viewer present.*task remains queued/i.test(wake.stdout)
        && !/â|�/.test(wake.stdout + wake.stderr));

    const assignedByDefault = await runCli(port, [
      'task-update', 'task-passive', '--for', 'worker-11',
    ], 'codex-root');
    check('task-update assignment wakes by default without overriding task-hold semantics',
      assignedByDefault.code === 0 &&
      /updated task-passive for worker-11/i.test(assignedByDefault.stdout) &&
      /not delivered: no viewer present.*task remains queued/i.test(assignedByDefault.stdout) &&
      requests.some((request) => request.url === '/api/tasks/update' &&
        request.body.id === 'task-passive' && request.body.by === 'codex-root' &&
        request.body.assignee === 'worker-11' &&
        !Object.prototype.hasOwnProperty.call(request.body, 'wakeWorker')));

    const beforeInvalid = requests.filter((request) => request.url === '/api/tasks/update').length;
    const invalid = await runCli(port, ['task-update', 'task-1']);
    check('task-update without a requested field is rejected before the API mutation',
      invalid.code === 1
        && /needs --text, --for, --unassign, or --wake/i.test(invalid.stderr)
        && requests.filter((request) => request.url === '/api/tasks/update').length === beforeInvalid);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exit(1);
});
