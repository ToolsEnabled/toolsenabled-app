#!/usr/bin/env node
'use strict';
/**
 * The grounded drafting flow, live, with a real agent.
 *
 * This is the user story the whole project exists for:
 *
 *   "I want to say something about how many tasks were determinate,
 *    but what did we actually find?"
 *
 * and what must come back is not an edit, but options with sources.
 *
 * Spends real tokens. Runs on Haiku. Run: node test/test_flow_live.js
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
const TMP = path.join(__dirname, '_tmp_flow');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
const DOC = path.join(TMP, 'data', 'documents', 'paper.docx');

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
  return http.get(`${BASE}/api/events`, (res) => {
    let b = '';
    res.on('data', (c) => {
      b += c.toString();
      let i;
      while ((i = b.indexOf('\n\n')) >= 0) {
        const frame = b.slice(0, i); b = b.slice(i + 2);
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(frame);
        if (m) { try { events.push({ type: m[1], data: JSON.parse(m[2]) }); } catch (_) {} }
      }
    });
  });
}
const ag = () => events.filter((e) => e.type === 'agent').map((e) => e.data);
const calls = () => ag().filter((e) => e.kind === 'tool-call');

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(400); }
  console.log(`    (timed out waiting for ${label}; tools used: ${[...new Set(calls().map((c) => c.name))].join(', ') || 'none'})`);
  return false;
}

async function main() {
  if (!resolveClaude()) { console.log('claude.exe not found, skipping.'); process.exit(0); }

  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.copyFileSync(SRC, DOC);

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data'),
           SCRIBE_MODEL: 'claude-haiku-4-5-20251001' },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let es = null, hardFail = false, ownedServer = false;
  try {
    await waitForOwnedHealth(
      () => req('GET', '/api/health'),
      srv,
      { attempts: 200, interval: 100 },
    );
    ownedServer = true;
    await req('POST', '/api/research', { cmd: 'index', args: {} });   // warm the corpus
    const opened = await req('POST', '/api/open', { path: DOC });
    if (opened.status !== 200) {
      throw new Error(`fixture open failed (${opened.status}): ${opened.body.error || ''}`);
    }
    es = listen();
    await sleep(300);

    const docBefore = fs.readFileSync(DOC);
    const model = (await req('GET', '/api/doc')).body;
    const anchor = model.paragraphs.find((p) => /determinacy|determinate/i.test(p.text) && p.text.length > 150)
                || model.paragraphs.find((p) => p.text.length > 300 && !p.table);

    console.log('\n[the question]');
    console.log('  "what did we actually find about how many tasks were determinate?"');
    await req('POST', '/api/say', {
      text: `Look up what we actually found about how many tasks were determinate. ` +
            `Search the corpus for it, then give me 2 or 3 ways I could word it in paragraph ` +
            `${anchor.pid}, with your sources. Do not edit anything yet.`,
    });

    console.log('\n[it goes and looks]');
    const searched = await waitFor(() => calls().some((c) => /corpus_search|db_query|read_source/.test(c.name || '')),
      240000, 'a research tool call');
    check('the agent searched the corpus instead of answering from memory', searched,
      [...new Set(calls().map((c) => c.name))].join(', '));

    const proposed = await waitFor(() => events.some((e) => e.type === 'proposal'), 240000, 'a proposal');
    check('it came back with options, not an edit', proposed);

    // When it does not propose, what it said instead is the whole diagnosis.
    if (!proposed) {
      const said = ag().filter((e) => e.kind === 'message' || e.kind === 'turn-end')
        .map((e) => e.text).filter(Boolean).join('\n---\n');
      console.log('\n  IT SAID INSTEAD:\n    ' +
        (said || '(nothing)').slice(0, 900).split('\n').join('\n    '));
      const sess = ag().find((e) => e.kind === 'session') || {};
      console.log('\n  doc tools it was offered: ' +
        (sess.tools || []).filter((t) => /doc_/.test(t)).join(', '));
    }

    const prop = events.filter((e) => e.type === 'proposal').map((e) => e.data).pop();
    if (prop) {
      check('  2 or more options', prop.options.length >= 2, prop.options.length);
      check('  the options actually differ from each other',
        new Set(prop.options.map((o) => o.text)).size === prop.options.length);
      check('  each option has real text', prop.options.every((o) => o.text && o.text.length > 15));
      check('  it is anchored to a paragraph', !!prop.anchor_pid, prop.anchor_pid);
      check('  GROUNDED: it cites at least one source', (prop.grounding || []).length > 0,
        (prop.grounding || []).length + ' sources');
      if ((prop.grounding || []).length) {
        check('    every source names a file', prop.grounding.every((g) => g.source && g.source.length > 2),
          prop.grounding.map((g) => g.source).join(' | ').slice(0, 100));
      }
      console.log('\n  what it proposed:');
      console.log(`    intent: ${prop.intent}`);
      prop.options.forEach((o) => console.log(`    [${o.id}] ${o.text.slice(0, 110)}${o.note ? `   (${o.note})` : ''}`));
      (prop.grounding || []).forEach((g) => console.log(`     src: ${g.source} :: ${(g.quote || g.claim || '').slice(0, 80)}`));
    }

    console.log('\n[proposing wrote nothing]');
    check('THE DOCUMENT IS UNTOUCHED', Buffer.compare(docBefore, fs.readFileSync(DOC)) === 0);
    check('  and no edit was broadcast', !events.some((e) => e.type === 'edit'));

    console.log('\n[choosing applies it]');
    if (prop) {
      const say = await req('POST', '/api/say', { text: 'the first one' });
      check('"the first one" resolved locally, with no model call', say.body.resolved === 'accept',
        JSON.stringify(say.body).slice(0, 100));
      await sleep(1200);
      const after = (await req('GET', '/api/doc')).body;
      const chosen = prop.options[0].text.slice(0, 40);
      check('the chosen wording is now in the document',
        after.paragraphs.some((p) => p.text.includes(chosen)), chosen);
      check('the file on disk changed', Buffer.compare(docBefore, fs.readFileSync(DOC)) !== 0);
    }

    console.log('\n[subagents, if it used them]');
    const subCalls = calls().filter((c) => c.parent);
    if (subCalls.length) {
      check('subagent tool calls were individually observable', true,
        `${subCalls.length} calls under ${new Set(subCalls.map((c) => c.parent)).size} subagent(s)`);
    } else {
      console.log('    (it answered without dispatching subagents this time, which is fine for one question)');
    }

    const st = (await req('GET', '/api/agent')).body;
    console.log(`\n  ${st.turns} turns, $${st.costUsd}`);
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
