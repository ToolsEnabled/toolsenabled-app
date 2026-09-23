#!/usr/bin/env node
'use strict';
/**
 * One bounded subscription-backed Codex smoke test against an isolated copy.
 *
 * It sends exactly one Terra turn, requires one document read and one read-only
 * parent-corpus lookup, verifies the copied .docx is byte-identical afterward,
 * then verifies Terra -> Sol session resume without sending a second turn.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { resolveCodex } = require('../agent');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.resolve(__dirname, '_tmp_codex_live');
let PORT = null;
let BASE = null;
const SOURCE = path.join(ROOT, 'data', 'documents', 'McNair New Draft.docx');

if (!TMP.startsWith(ROOT + path.sep)) throw new Error(`unsafe temp path: ${TMP}`);
if (!resolveCodex()) {
  console.error('Codex executable not found.');
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) {
  console.error(`Sandbox source document not found: ${SOURCE}`);
  process.exit(1);
}

const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function req(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const request = http.request(`${BASE}${route}`, {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => raw += chunk);
      response.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw || '{}'); } catch (_) {}
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function subscribe(events) {
  const request = http.get(`${BASE}/api/events`, (response) => {
    let buffer = '';
    response.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^event: (\w+)\ndata: (.*)$/s.exec(frame);
        if (!match || match[1] !== 'agent') continue;
        try { events.push(JSON.parse(match[2])); } catch (_) {}
      }
    });
  });
  return request;
}

(async () => {
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  const data = path.join(TMP, 'data');
  fs.mkdirSync(path.join(data, 'documents'), { recursive: true });
  const document = path.join(data, 'documents', 'paper.docx');
  fs.copyFileSync(SOURCE, document);

  const logs = [];
  const env = {
    ...process.env,
    SCRIBE_PORT: String(PORT),
    SCRIBE_DATA: data,
    SCRIBE_MODEL: 'terra',
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const events = [];
  let stream = null;
  try {
    await waitForOwnedHealth(
      () => req('GET', '/api/health'),
      server,
      { attempts: 200, interval: 100 },
    );

    const opened = await req('POST', '/api/open', { path: document });
    check('the isolated document opens', opened.status === 200, opened.body.error);
    const model = (await req('GET', '/api/doc')).body;
    const paragraph = model.paragraphs.find((item) => item.text && item.text.length > 20);
    check('a readable paragraph is available', !!paragraph, paragraph && paragraph.pid);

    const beforeHash = sha(document);
    const beforeRev = (await req('GET', '/api/health')).body.rev;
    stream = subscribe(events);
    await sleep(200);

    console.log('\n[one Terra read-only document + corpus turn]');
    const said = await req('POST', '/api/say', {
      text: `Use doc_read to read paragraph ${paragraph.pid}, then use list_sources to confirm the configured read-only corpus roots. Do not edit or call any write tool. Reply exactly READ_OK.`,
    });
    check('the prompt is accepted', said.status === 200 && said.body.delivered === true,
      JSON.stringify(said.body));

    const ended = await waitFor(
      () => events.find((event) => event.kind === 'turn-end'),
      120000,
      'Terra turn completion',
    );
    const calls = events.filter((event) => event.kind === 'tool-call');
    const session = events.find((event) => event.kind === 'session');
    check('the running provider is Codex Terra',
      session && session.provider === 'codex' && session.model === 'terra',
      JSON.stringify(session));
    check('the real app-server stream exposes doc_read',
      calls.some((event) => event.name === 'mcp__doc__doc_read'),
      calls.map((event) => event.name).join(','));
    check('the real app-server stream exposes the parent-corpus lookup',
      calls.some((event) => event.name === 'mcp__research__list_sources'),
      calls.map((event) => event.name).join(','));
    check('no document write tool is called',
      calls.every((event) => !/^mcp__doc__doc_(replace|insert|delete|format|propose|assist)$/.test(event.name)),
      calls.map((event) => event.name).join(','));
    check('the turn completes successfully',
      ended.subtype === 'completed' && /READ_OK/i.test(ended.text || ''),
      JSON.stringify(ended));
    check('subscription mode reports no fabricated dollar cost',
      ended.costUsd === null && ended.totalCostUsd === 0);

    const after = await req('GET', '/api/health');
    check('the isolated document revision never moves',
      after.body.rev === beforeRev, `${beforeRev} -> ${after.body.rev}`);
    check('the isolated .docx remains byte-identical',
      sha(document) === beforeHash, `${beforeHash.slice(0, 12)}…`);

    console.log('\n[Terra to Sol resume, no second turn]');
    const firstSession = (await req('GET', '/api/agent')).body.sessionId;
    const switched = await req('POST', '/api/model', { model: 'sol' });
    check('the idle provider switch is accepted',
      switched.status === 200 && switched.body.provider === 'codex' && switched.body.restarted,
      JSON.stringify(switched.body));
    const resumed = await waitFor(async () => {
      const status = (await req('GET', '/api/agent')).body;
      return status.model === 'sol' && status.sessionId ? status : null;
    }, 30000, 'Sol session resume');
    check('Sol resumes the exact Codex thread after a real rollout',
      resumed.sessionId === firstSession && switched.body.resumed === firstSession,
      `${firstSession} -> ${resumed.sessionId}`);
    check('the resume sends no second model turn', resumed.turns === 0, resumed.turns);

    await req('POST', '/api/agent/stop');
  } catch (error) {
    console.error(error && error.stack || error);
    FAIL.push('probe completed');
  } finally {
    if (stream) stream.destroy();
    try { server.kill(); } catch (_) {}
    await sleep(900);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('failed: ' + FAIL.join(', '));
    console.log('\n--- sandbox server log ---\n' + logs.join('').slice(-4000));
  }
  process.exit(FAIL.length ? 1 : 0);
})();
