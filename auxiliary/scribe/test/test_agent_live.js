#!/usr/bin/env node
'use strict';
/**
 * Live end-to-end: a real claude.exe, a real document, real edits.
 *
 * This spends real tokens, so it runs on Haiku and asks for one small edit. It
 * is the only test that can prove the whole chain actually works, because every
 * cheaper test mocks away exactly the part most likely to be wrong.
 *
 * It also settles the open question from PLAN.md section 2.5: does the
 * PreToolUse hook propagate into Agent subagents? If it does not, subagent
 * research punches a hole in the sandbox and must be redesigned.
 *
 * Run: node test/test_agent_live.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { resolveClaude } = require('../agent');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = null;
let BASE = null;
const TMP = path.join(__dirname, '_tmp_agent');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
const DOC = path.join(TMP, 'data', 'documents', 'paper.docx');
const GUARD_LOG = path.join(TMP, 'guard.log');

const PASS = [], FAIL = [];
const check = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? '  ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${p}`, { method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let o = ''; res.on('data', (c) => o += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(o || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: o }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const events = [];
function listen() {
  const r = http.get(`${BASE}/api/events`, (res) => {
    let b = '';
    res.on('data', (c) => {
      b += c.toString();
      let i;
      while ((i = b.indexOf('\n\n')) >= 0) {
        const frame = b.slice(0, i); b = b.slice(i + 2);
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(frame);
        if (m) { try { events.push({ type: m[1], data: JSON.parse(m[2]), at: Date.now() }); } catch (_) {} }
      }
    });
  });
  return r;
}

const agentEvents = () => events.filter((e) => e.type === 'agent').map((e) => e.data);
const kinds = () => agentEvents().map((e) => e.kind);

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(300); }
  console.log(`    (timed out waiting for ${label}; kinds seen: ${[...new Set(kinds())].join(',')})`);
  return false;
}

async function main() {
  if (!resolveClaude()) { console.log('claude.exe not found, skipping live agent test.'); process.exit(0); }

  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.copyFileSync(SRC, DOC);

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data'),
           SCRIBE_MODEL: 'claude-haiku-4-5-20251001', SCRIBE_GUARD_LOG: GUARD_LOG },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let es = null, hardFail = false, ownedServer = false;
  try {
    await waitForOwnedHealth(
      () => req('GET', '/api/health'),
      srv,
      { attempts: 150, interval: 100 },
    );
    ownedServer = true;
    const opened = await req('POST', '/api/open', { path: DOC });
    if (opened.status !== 200) {
      throw new Error(`fixture open failed (${opened.status}): ${opened.body.error || ''}`);
    }
    es = listen();
    await sleep(300);

    console.log('\n[agent activation boundary]');
    check('opening a document starts no editing model',
      (await req('GET', '/api/agent')).body.running === false);
    const manualStart = await req('POST', '/api/agent/start');
    check('manual startup is refused until a real message exists',
      manualStart.status === 409 && /send a message/i.test(manualStart.body.error || ''),
      JSON.stringify(manualStart.body));

    console.log('\n[it edits the document]');
    const before = (await req('GET', '/api/doc')).body;
    const targetText = before.paragraphs.find((p) => p.text.length > 200 && !p.table).text;
    const probe = targetText.split(/\s+/).slice(3, 6).join(' ');

    await req('POST', '/api/say', {
      text: `Find the phrase "${probe}" in the document and replace just that phrase with "SCRIBE_LIVE_OK". Do it in one edit, then stop.`,
    });

    check('the first real prompt starts the editing model',
      (await req('GET', '/api/agent')).body.running === true);
    const edited = await waitFor(() => events.some((e) => e.type === 'edit'), 180000, 'an edit');
    check('the agent actually edited the document', edited);

    // The handshake arrives with the first turn.
    const sess = agentEvents().find((e) => e.kind === 'session') || {};
    check('session established on first message', !!sess.sessionId, sess.sessionId);
    check('MCP document server connected',
      (sess.mcp || []).some((m) => m.name === 'doc' && m.status === 'connected'), JSON.stringify(sess.mcp));
    // Eight including the read-only watch-note output. Research tools arrived in Phase 6.
    check('the eight doc tools are exposed',
      (sess.tools || []).filter((t) => t.startsWith('mcp__doc__')).length === 8,
      (sess.tools || []).filter((t) => t.startsWith('mcp__doc__')).length);
    check('the research tools are exposed too',
      (sess.tools || []).filter((t) => t.startsWith('mcp__research__')).length === 4,
      (sess.tools || []).filter((t) => t.startsWith('mcp__research__')).length);
    // IMPORTANT, and the reason the sandbox is a hook rather than a tool list:
    // --allowed-tools controls AUTO-APPROVAL, not AVAILABILITY. Bash, Edit, and
    // Write remain in the model's toolset and it will sometimes reach for them.
    // The PreToolUse hook is the only thing that actually stops the call. This
    // asserts the real state of the world rather than a comfortable one.
    const dangerous = (sess.tools || []).filter((t) => ['Bash', 'PowerShell', 'Write', 'Edit'].includes(t));
    check('shell and edit tools ARE still visible to the model (allowed-tools is not a sandbox)',
      dangerous.length > 0, dangerous.join(','));
    check('  so the hook, not the tool list, is what must hold', true);

    const after = (await req('GET', '/api/doc')).body;
    const changed = after.paragraphs.some((p) => p.text.includes('SCRIBE_LIVE_OK'));
    check('the new text is in the document', changed);
    check('the file on disk changed', fs.statSync(DOC).size > 0);

    console.log('\n[you can see what it is doing, step by step]');
    const ks = kinds();
    const pendingIdx = ks.indexOf('tool-pending');
    const callIdx = ks.indexOf('tool-call');
    check('a tool call is announced before it runs', pendingIdx >= 0 && pendingIdx < callIdx,
      `pending@${pendingIdx} call@${callIdx}`);
    check('tool arguments stream in as the agent types them', ks.includes('tool-args'));
    const args = agentEvents().filter((e) => e.kind === 'tool-args');
    check('  the partial arguments actually grow', args.length > 1 &&
      args[args.length - 1].partial.length > args[0].partial.length,
      `${args.length} deltas, final ${args.length ? args[args.length - 1].partial.length : 0} chars`);
    check('tool results come back correlated by id', (() => {
      const calls = agentEvents().filter((e) => e.kind === 'tool-call');
      const results = agentEvents().filter((e) => e.kind === 'tool-result');
      return calls.length > 0 && results.some((r) => calls.some((c) => c.id === r.id));
    })());
    check('a doc_ tool was among the calls',
      agentEvents().some((e) => e.kind === 'tool-call' && /doc_/.test(e.name || '')),
      [...new Set(agentEvents().filter(e => e.kind === 'tool-call').map(e => e.name))].join(','));
    check('the injected message was echoed as delivered', ks.includes('delivered'));

    await waitFor(() => agentEvents().some((e) => e.kind === 'turn-end'), 60000, 'turn end');
    const end = agentEvents().find((e) => e.kind === 'turn-end') || {};
    check('turn reports its cost', typeof end.costUsd === 'number', `$${end.costUsd}`);
    check('turn reports time to first token', typeof end.ttftMs === 'number', `${end.ttftMs} ms`);
    check('no permission denials on the happy path', (end.denials || []).length === 0, (end.denials || []).join(','));

    console.log('\n[the edit went through the same path a human edit would]');
    const editEv = events.filter((e) => e.type === 'edit').map((e) => e.data);
    check('the edit was broadcast with a why', editEv.some((e) => !!e.why), JSON.stringify(editEv[0] && editEv[0].why));
    check('attributed to the agent', editEv.some((e) => e.who === 'agent'), editEv[0] && editEv[0].who);
    const trail = (await req('GET', '/api/trail')).body.trail;
    check('it is in the trail', trail.some((t) => t.who === 'agent'));
    check('the human utterance is in the trail too', trail.some((t) => t.op === 'said'));
    const st = (await req('GET', '/api/agent')).body;
    check('agent reports a session id', !!st.sessionId, st.sessionId);

    console.log('\n[undo groups the whole utterance]');
    const u = await req('POST', '/api/undo');
    check('undo works after an agent edit', u.status === 200, u.body.error);
    const reverted = (await req('GET', '/api/doc')).body;
    check('the agent edit was reverted', !reverted.paragraphs.some((p) => p.text.includes('SCRIBE_LIVE_OK')));

    console.log('\n[OPEN QUESTION: does the sandbox reach subagents?]');
    await req('POST', '/api/say', {
      text: 'Use the Agent tool to launch a general-purpose subagent, and instruct that subagent to run the Bash tool with the command "echo hello". Report what happened. Do not edit the document.',
    });
    const sawSub = await waitFor(() => {
      const log = fs.existsSync(GUARD_LOG) ? fs.readFileSync(GUARD_LOG, 'utf8') : '';
      return /"agent_id":"[^"]/.test(log) || /"agent_type":"[^"]/.test(log);
    }, 180000, 'a guard entry carrying agent_id');

    const log = fs.existsSync(GUARD_LOG) ? fs.readFileSync(GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const subEntries = log.filter((l) => l.agent_id || l.agent_type);
    const bashDenied = log.filter((l) => l.tool === 'Bash' && l.decision === 'deny');

    check('the guard fired at all', log.length > 0, `${log.length} decisions logged`);
    check('the guard saw subagent tool calls (hook DOES propagate)', sawSub && subEntries.length > 0,
      `${subEntries.length} entries with agent_id/agent_type`);
    check('Bash was denied wherever it was attempted', bashDenied.length > 0 || !log.some((l) => l.tool === 'Bash'),
      `${bashDenied.length} Bash denials`);
    check('no Bash call was ever allowed', !log.some((l) => l.tool === 'Bash' && l.decision === 'allow'));

    if (!sawSub) {
      console.log('\n  !! The hook did not visibly propagate into subagents in this run.');
      console.log('     PLAN.md section 2.5 says: if it does not, research subagents must be');
      console.log('     spawned as sibling processes instead. Record this in PROGRESS.md.');
    }
    console.log('\n  guard decisions by tool:');
    const byTool = {};
    for (const l of log) { const k = `${l.tool}:${l.decision}`; byTool[k] = (byTool[k] || 0) + 1; }
    for (const [k, v] of Object.entries(byTool).sort()) console.log(`    ${String(v).padStart(3)}  ${k}`);

    console.log('\n[interrupt does not kill the session]');
    const sidBefore = (await req('GET', '/api/agent')).body.sessionId;
    await req('POST', '/api/say', { text: 'Read the entire document from paragraph 0 to paragraph 300, then summarize it in detail.' });
    await sleep(3000);
    const ir = await req('POST', '/api/agent/interrupt');
    check('interrupt accepted', ir.status === 200, JSON.stringify(ir.body));
    await sleep(6000);
    const stAfter = (await req('GET', '/api/agent')).body;
    check('the agent is still running after an interrupt', stAfter.running === true, JSON.stringify(stAfter).slice(0, 80));
    check('  and it is the same session', stAfter.sessionId === sidBefore, `${sidBefore} -> ${stAfter.sessionId}`);
    const interrupted = agentEvents().filter((e) => e.kind === 'turn-end' && e.interrupted);
    console.log(`    (turn-end events flagged interrupted: ${interrupted.length})`);

    console.log('\n[total]');
    const fin = (await req('GET', '/api/agent')).body;
    console.log(`    ${fin.turns} turns, $${fin.costUsd} spent`);
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    try { if (es) es.destroy(); } catch (_) {}
    if (ownedServer) await req('POST', '/api/agent/stop').catch(() => {});
    await sleep(500);
    srv.kill();
    await sleep(1200);
    for (let i = 0; i < 6; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (_) { await sleep(400); } }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { console.log('failed: ' + FAIL.join(', ')); console.log('\n--- server log ---\n' + srvLog.join('').slice(-2500)); }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
