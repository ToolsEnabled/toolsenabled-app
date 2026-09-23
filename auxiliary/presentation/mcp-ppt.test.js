#!/usr/bin/env node
'use strict';
/*
 * Exercises the lead's real MCP transport against a fake loopback suite API.
 * This pins the key dispatch contract: an assigned task wakes or spawns its
 * worker, while an unassigned task is only stored.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function main() {
  const requests = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch (_) {}
      requests.push({ method: req.method, url: req.url, body: parsed });
      if (req.url === '/api/tasks/update') {
        const wakeWorker = Object.prototype.hasOwnProperty.call(parsed, 'wakeWorker')
          ? parsed.wakeWorker
          : !!parsed.assignee;
        const result = {
          ok: true,
          task: {
            id: parsed.id,
            text: parsed.text || 'Existing instruction',
            assignee: Object.prototype.hasOwnProperty.call(parsed, 'assignee') ? parsed.assignee : 'worker-2',
            wakeWorker,
          },
          dispatch: wakeWorker ? { ok: true, action: 'stubbed' } : null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      const assigned = !!parsed.assignee;
      const result = {
        ok: true,
        task: { id: assigned ? 'task-assigned' : 'task-open' },
        dispatch: assigned ? { ok: true, action: 'spawn' } : null,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;

  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-ppt.js')], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      SUITE_HOST: '127.0.0.1',
      SUITE_PORT: String(port),
      SUITE_EDITOR: 'lead',
      SUITE_MCP_ROLE: 'lead',
      // Deliberately exceed the suite ceiling so this child-side contract also
      // proves it cannot advertise identities beyond BEAST's 30+10 pools.
      SUITE_AGENT_WORKER_CAP: '99',
      SUITE_AGENT_MEDIA_WORKER_CAP: '99',
    }),
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}: ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    check('MCP initializes with the requested protocol version',
      init.result && init.result.protocolVersion === '2025-06-18');

    const listed = await rpc('tools/list');
    const taskTool = listed.result.tools.find((tool) => tool.name === 'ppt_task');
    const updateTool = listed.result.tools.find((tool) => tool.name === 'ppt_task_update');
    const doneTool = listed.result.tools.find((tool) => tool.name === 'ppt_task_done');
    check('lead sees ppt_task', !!taskTool);
    check('lead sees ppt_task_update', !!updateTool);
    check('ppt_task_update explains durable hold and restart semantics',
      updateTool && /wakeWorker=false to HOLD/i.test(updateTool.description)
        && /will not auto-run after restart/i.test(updateTool.description)
        && /assignment wakes by default/i.test(updateTool.description)
        && /worker-1 through worker-30/i.test(updateTool.description)
        && /media-1 through media-10/i.test(updateTool.description));
    check('ppt_task description promises assigned-worker dispatch',
      taskTool && /wakes that worker, or spawns it/i.test(taskTool.description));
    check('ppt_task description exposes the full configured worker range',
      taskTool && /worker-1 through worker-30/i.test(taskTool.description)
        && /media-1 through media-10/i.test(taskTool.description)
        && !/worker-31/i.test(taskTool.description)
        && !/media-11/i.test(taskTool.description));
    check('ppt_task no longer claims assigned work cannot wake a worker',
      taskTool && !/posting a task does not wake anybody/i.test(taskTool.description));
    check('lead cannot see the worker-only transition edit tool',
      !listed.result.tools.some((tool) => tool.name === 'ppt_set_transition'));
    check('lead cannot see worker-only generated shape edit tools',
      !listed.result.tools.some((tool) =>
        tool.name === 'ppt_add_shape' || tool.name === 'ppt_add_image' ||
        tool.name === 'ppt_set_animation' || tool.name === 'ppt_set_corners' ||
        tool.name === 'ppt_delete_shape'));
    check('ppt_task_done requires applied and verified work',
      doneTool && /actually applied and verified with ppt_show/i.test(doneTool.description));
    check('ppt_task_done directs blocked work to remain open for retry',
      doneTool && /post the blocker with ppt_note/i.test(doneTool.description)
        && /unlock the slides/i.test(doneTool.description)
        && /leave the task open for retry/i.test(doneTool.description));

    const assigned = await rpc('tools/call', {
      name: 'ppt_task',
      arguments: { text: 'Tighten slide s4', assignee: 'worker-30' },
    });
    const assignedText = assigned.result.content[0].text;
    check('top configured general slot is forwarded and reports a spawn',
      /assigned to worker-30 and spawned that worker/i.test(assignedText));
    check('assigned request is attributed to the lead',
      requests.some((r) => r.url === '/api/tasks'
        && r.body.by === 'lead'
        && r.body.assignee === 'worker-30'
        && r.body.wakeWorker === true));

    const mediaBoundary = await rpc('tools/call', {
      name: 'ppt_task',
      arguments: { text: 'Generate a title image', assignee: 'media-10' },
    });
    check('top configured media slot is forwarded and reports a spawn',
      /assigned to media-10 and spawned that worker/i.test(mediaBoundary.result.content[0].text)
        && requests.some((r) => r.url === '/api/tasks'
          && r.body.by === 'lead'
          && r.body.assignee === 'media-10'
          && r.body.wakeWorker === true));

    const open = await rpc('tools/call', {
      name: 'ppt_task',
      arguments: { text: 'Unassigned cleanup' },
    });
    check('unassigned task clearly says no worker was woken',
      /stored unassigned.*no worker was woken/i.test(open.result.content[0].text)
        && /worker-1 through worker-30/i.test(open.result.content[0].text)
        && /media-1 through media-10/i.test(open.result.content[0].text)
        && requests.some((r) => r.url === '/api/tasks'
          && r.body.assignee === '' && r.body.wakeWorker === false));

    const held = await rpc('tools/call', {
      name: 'ppt_task_update',
      arguments: { id: 'task-old', text: 'Redistributed instruction', assignee: 'worker-9', wakeWorker: false },
    });
    check('task update clearly reports durable hold semantics',
      /task task-old is held for worker-9/i.test(held.result.content[0].text)
        && /will not auto-run after restart/i.test(held.result.content[0].text));
    check('task hold request preserves the lead identity and explicit wake intent',
      requests.some((r) => r.url === '/api/tasks/update'
        && r.body.id === 'task-old'
        && r.body.by === 'lead'
        && r.body.text === 'Redistributed instruction'
        && r.body.assignee === 'worker-9'
        && r.body.wakeWorker === false));

    const woken = await rpc('tools/call', {
      name: 'ppt_task_update',
      arguments: { id: 'task-old', assignee: 'worker-10', wakeWorker: true },
    });
    check('task update reports an eligible worker wake',
      /updated for worker-10 and woke that worker/i.test(woken.result.content[0].text));

    const assignedByDefault = await rpc('tools/call', {
      name: 'ppt_task_update',
      arguments: { id: 'task-passive', assignee: 'worker-11' },
    });
    check('assigning an existing task wakes by default without manufacturing a wakeWorker field',
      /updated for worker-11 and woke that worker/i.test(assignedByDefault.result.content[0].text) &&
      requests.some((r) => r.url === '/api/tasks/update' && r.body.id === 'task-passive' &&
        r.body.assignee === 'worker-11' &&
        !Object.prototype.hasOwnProperty.call(r.body, 'wakeWorker')));
  } finally {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await new Promise((resolve) => api.close(resolve));
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? '✓' : '✗ FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
