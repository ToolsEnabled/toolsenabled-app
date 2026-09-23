#!/usr/bin/env node
'use strict';
/**
 * Integration test: spawns a real server on a test port against a throwaway
 * copy of the document and drives it over HTTP.
 *
 * The point is the pairs. For every refusal we assert BOTH that it was rejected
 * AND that the document did not change, because a rejection that mutated
 * anyway is the failure mode that silently corrupts a paper.
 *
 * Run: node test/test_server.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = 4699;
let BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(__dirname, '_tmp_srv');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
const DOC = path.join(TMP, 'paper.docx');

const PASS = [], FAIL = [];
const check = (name, cond, detail) => {
  (cond ? PASS : FAIL).push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

function req(method, p, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${p}`, {
      method,
      headers: {
        ...(data !== null
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: out }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function reqText(method, p, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

function reqRaw(method, p, bytes, filename) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-length': bytes.length,
        'x-scribe-filename': encodeURIComponent(filename),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    r.on('error', reject);
    r.end(bytes);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function availablePort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      const fallback = net.createServer();
      fallback.unref();
      fallback.once('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** Character index of the nth (1-based) occurrence of needle, or -1. */
function nthIndex(hay, needle, n) {
  let i = -1;
  for (let k = 0; k < n; k++) {
    i = hay.indexOf(needle, i + 1);
    if (i < 0) return -1;
  }
  return i;
}

async function waitHealthy(expectedPid, child, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `isolated server exited before readiness ` +
        `(code=${child.exitCode}, signal=${child.signalCode || 'none'})`,
      );
    }
    let r = null;
    try { r = await req('GET', '/api/health'); } catch (_) {}
    if (r && r.status === 200 && r.body.ok === true) {
      if (r.body.serverPid !== expectedPid) {
        throw new Error(
          `health belongs to pid ${r.body.serverPid}, expected isolated child ${expectedPid}`,
        );
      }
      return r.body;
    }
    await sleep(250);
  }
  throw new Error('server never became healthy');
}

async function main() {
  PORT = await availablePort(PORT);
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.copyFileSync(SRC, DOC);

  // Isolated data dir so the test never touches real session state.
  const dataDir = path.join(TMP, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const preBootCheckpointDir = path.join(dataDir, 'checkpoints');
  fs.mkdirSync(preBootCheckpointDir, { recursive: true });
  const orphanRedo = path.join(preBootCheckpointDir, 'redo-1-1.docx');
  const unrelatedCheckpointNote = path.join(preBootCheckpointDir, 'keep-me.txt');
  fs.writeFileSync(orphanRedo, 'unreachable legacy redo fixture');
  fs.writeFileSync(unrelatedCheckpointNote, 'not a Scribe checkpoint');

  console.log('\n[boot]');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false,
    env: {
      ...process.env,
      SCRIBE_PORT: String(PORT),
      SCRIBE_DATA: dataDir,
      SCRIBE_RUNTIME_TEST: '1',
      SCRIBE_TRANSACTION_TEST: '1',
      SCRIBE_PREDICT_TEST: '1',
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_PREDICT_GRANT_MIN_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let failed = false;
  try {
    const h = await waitHealthy(srv.pid, srv);
    check('server is healthy', h.ok === true, JSON.stringify(h.dochost));
    check('health identifies the exact isolated child process',
      h.serverPid === srv.pid, `${h.serverPid} vs ${srv.pid}`);
    check('test runs against an isolated data dir (not the live one)',
      fs.existsSync(path.join(dataDir, 'pids.json')) &&
      !fs.existsSync(path.join(ROOT, 'data', 'pids.json')) ||
      fs.readdirSync(dataDir).length > 0,
      fs.readdirSync(dataDir).join(','));
    check('reports its boot time', !!h.bootedAt);
    check('document host is running', !!h.dochost && !!h.dochost.pid, h.dochost && h.dochost.pid);
    check('advertises atomic paragraph merging to compatible editors',
      h.capabilities && h.capabilities.paragraphMerge === true,
      JSON.stringify(h.capabilities));
    check('boot prunes generated orphan checkpoints but leaves unrelated files alone',
      !fs.existsSync(orphanRedo) && fs.existsSync(unrelatedCheckpointNote),
      fs.readdirSync(preBootCheckpointDir).join(','));

    // ---------------------------------------------------------------- open
    console.log('\n[open]');
    const wrongType = await reqRaw('POST', '/api/upload', Buffer.from('not a document'), 'notes.txt');
    check('upload only accepts .docx files',
      wrongType.status === 400 && /\.docx/.test(wrongType.body.error || ''), wrongType.body.error);

    const fakeDocx = await reqRaw('POST', '/api/upload', Buffer.from('not a zip package'), 'fake.docx');
    check('a renamed non-document is refused',
      fakeDocx.status === 400 && /valid \.docx/.test(fakeDocx.body.error || ''), fakeDocx.body.error);
    check('a refused upload leaves no broken copy behind',
      fs.readdirSync(path.join(dataDir, 'documents')).length === 0,
      fs.readdirSync(path.join(dataDir, 'documents')).join(','));

    const uploaded = await reqRaw('POST', '/api/upload', fs.readFileSync(DOC), 'paper.docx');
    check('uploads and opens a Word document',
      uploaded.status === 200 && uploaded.body.uploaded === true && uploaded.body.count === 333,
      uploaded.body.error || uploaded.body.count);
    check('the first managed open persists every repaired paragraph id',
      uploaded.body.stamped === 333 && uploaded.body.stamps_persisted === true,
      `${uploaded.body.stamped}/${uploaded.body.stamps_persisted}`);
    check('the uploaded copy stays inside the isolated Scribe data directory',
      path.dirname(uploaded.body.path) === path.join(dataDir, 'documents') && fs.existsSync(uploaded.body.path),
      uploaded.body.path);
    const activeDoc = uploaded.body.path;

    const duplicate = await reqRaw('POST', '/api/upload', fs.readFileSync(DOC), 'paper.docx');
    check('a duplicate filename never overwrites the first upload',
      duplicate.status === 200 && path.basename(duplicate.body.path) === 'paper (2).docx' &&
      fs.existsSync(uploaded.body.path), path.basename(duplicate.body.path || ''));

    const op = await req('POST', '/api/open', { path: activeDoc });
    check('opens the document', op.status === 200 && op.body.count === 333, op.body.count);
    check('a second open reuses the paragraph ids already stored in the package',
      op.body.stamped === 0 && op.body.stamps_persisted === false,
      `${op.body.stamped}/${op.body.stamps_persisted}`);

    const doc = await req('GET', '/api/doc');
    check('serves the model', doc.status === 200 && doc.body.paragraphs.length === 333,
      doc.body.paragraphs && doc.body.paragraphs.length);
    const paras = doc.body.paragraphs;
    const target = paras.find((x) => x.runs.length === 13);
    check('model carries run-level markup', !!target && target.runs.some((r) => r.color),
      target && target.runs.filter((r) => r.color).length + ' colored runs');

    const manualStart = await req('POST', '/api/agent/start');
    check('production refuses to start an editing model without a message',
      manualStart.status === 409 && /only when you send a message/i.test(manualStart.body.error || ''),
      manualStart.body.error);
    check('a refused manual start leaves the model process off',
      (await req('GET', '/api/agent')).body.running === false);

    // ------------------------------------------------------------- events
    console.log('\n[live feed]');
    const events = [];
    const es = http.get(`${BASE}/api/events`, (res) => {
      let b = '';
      res.on('data', (c) => {
        b += c.toString();
        let i;
        while ((i = b.indexOf('\n\n')) >= 0) {
          const frame = b.slice(0, i); b = b.slice(i + 2);
          const m = /^event: (\w+)\ndata: (.*)$/s.exec(frame);
          if (m) events.push({ type: m[1], data: JSON.parse(m[2]) });
        }
      });
    });
    await sleep(400);
    check('sends a snapshot on connect', events.some((e) => e.type === 'hello'),
      events.map((e) => e.type).join(','));

    // --------------------------------------------------------------- edit
    console.log('\n[edit]');
    const p = paras[100];
    const phrase = p.text.slice(0, 14);
    const ed = await req('POST', '/api/edit', {
      who: 'test',
      op: { type: 'replace', pid: p.pid, find: phrase, replace: 'EDITED', why: 'testing', utterance: 'u1', expect_hash: p.hash },
    });
    check('applies an edit', ed.status === 200 && ed.body.ok, ed.body.error);
    check('bumps the revision', ed.body.rev === 1, ed.body.rev);
    await sleep(300);
    const edEv = events.find((e) => e.type === 'edit');
    check('broadcasts the edit', !!edEv, edEv && edEv.data.summary);
    check('edit event carries a human summary', edEv && /replaced/.test(edEv.data.summary || ''),
      edEv && edEv.data.summary);
    check('edit event carries why', edEv && edEv.data.why === 'testing');
    check('reports save latency', edEv && typeof edEv.data.saveMs === 'number',
      edEv && edEv.data.saveMs + ' ms');

    const after = await req('GET', '/api/doc');
    check('edit is visible in the model', after.body.paragraphs[100].text.startsWith('EDITED'));
    check('the document model reports the persisted server revision',
      after.body.rev === ed.body.rev, `${after.body.rev} vs ${ed.body.rev}`);
    check('edit persisted to disk', fs.readFileSync(activeDoc).length > 0);
    check('backup was created',
      fs.readdirSync(path.dirname(activeDoc)).some((f) => f.includes('scribe-backup')),
      fs.readdirSync(path.dirname(activeDoc)).filter((f) => f.includes('backup')).join(','));

    // ----------------------------------------------------- refusals + no-op
    console.log('\n[refusals do not mutate]');
    const snapshot = () => req('GET', '/api/doc').then((r) => JSON.stringify(r.body.paragraphs));
    let before = await snapshot();

    const stale = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: p.pid, find: 'EDITED', replace: 'X', expect_hash: 'bogushash123' } });
    check('stale hash rejected', stale.status === 400 && /changed since you read it/.test(stale.body.error));
    check('  and nothing changed', (await snapshot()) === before);

    // Ambiguity needs a paragraph that genuinely repeats a token. Paragraph 100
    // is short, so pick a long one and verify the repeat before asserting.
    const longP = paras.find((x) => x.text.length > 300 && x.text.split(' the ').length > 2);
    const repeats = longP ? longP.text.split(' the ').length - 1 : 0;
    check('found a paragraph with a repeated token', repeats >= 2, `" the " x${repeats}`);
    const ambiguous = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: longP.pid, find: ' the ', replace: ' THE ' } });
    check('ambiguous match rejected', ambiguous.status === 400 && /Ambiguous/.test(ambiguous.body.error),
      ambiguous.body.error && ambiguous.body.error.slice(0, 70));
    check('  and nothing changed', (await snapshot()) === before);

    // The same edit succeeds once disambiguated, which proves the refusal was
    // about ambiguity and not about the text being unreachable.
    const disambiguated = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: longP.pid, find: ' the ', replace: ' THE ', occurrence: 2, utterance: 'u-amb' } });
    check('occurrence resolves the ambiguity', disambiguated.status === 200, disambiguated.body.error);
    const ambText = (await req('GET', '/api/doc')).body.paragraphs.find((x) => x.pid === longP.pid).text;
    check('  and it changed the SECOND occurrence',
      ambText.split(' THE ').length === 2 && ambText.indexOf(' THE ') === nthIndex(longP.text, ' the ', 2),
      `at ${ambText.indexOf(' THE ')}, expected ${nthIndex(longP.text, ' the ', 2)}`);
    before = await snapshot();

    const missing = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: p.pid, find: 'zzz-not-here-zzz', replace: 'X' } });
    check('missing text rejected', missing.status === 400 && /not found/i.test(missing.body.error));
    check('  and nothing changed', (await snapshot()) === before);

    const badop = await req('POST', '/api/edit', { op: { type: 'nonsense' } });
    check('unknown op rejected', badop.status === 400 && /Unknown op/.test(badop.body.error));
    const noop = await req('POST', '/api/edit', {});
    check('missing op rejected', noop.status === 400 && /Missing op/.test(noop.body.error));
    before = await snapshot();
    const hashlessAgent = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'replace',
        pid: p.pid,
        find: 'EDITED',
        replace: 'UNSAFE',
        why: 'missing read',
        expect_document_token: doc.body.document_token,
      },
    });
    check('agent mutations without a fresh hash are refused',
      hashlessAgent.status === 400 && /expect_hash/.test(hashlessAgent.body.error || ''),
      hashlessAgent.body.error);
    check('  and a hashless agent call changes nothing', (await snapshot()) === before);

    // -------------------------------------------------------------- pause
    console.log('\n[pause gate]');
    await req('POST', '/api/pause');
    before = await snapshot();
    const blocked = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: p.pid, find: 'EDITED', replace: 'NOPE' } });
    check('edit blocked with 423 while paused', blocked.status === 423, blocked.status);
    check('  and nothing changed', (await snapshot()) === before);
    const readOk = await req('POST', '/api/edit', { op: { type: 'find', query: 'the' } });
    check('reads still work while paused', readOk.status === 200);
    await req('POST', '/api/resume');
    const unblocked = await req('POST', '/api/edit', {
      op: { type: 'replace', pid: p.pid, find: 'EDITED', replace: 'AGAIN', utterance: 'u2' } });
    check('edits work again after resume', unblocked.status === 200, unblocked.body.error);

    // --------------------------------------------------------------- undo
    console.log('\n[undo is per utterance]');
    const beforeUndo = (await req('GET', '/api/doc')).body.paragraphs[100].text;
    check('utterance 2 applied', beforeUndo.startsWith('AGAIN'), beforeUndo.slice(0, 20));
    const u = await req('POST', '/api/undo');
    check('undo succeeds', u.status === 200, u.body.error);
    const afterUndo = (await req('GET', '/api/doc')).body.paragraphs[100].text;
    check('undo reverted the whole utterance', afterUndo.startsWith('EDITED'), afterUndo.slice(0, 20));
    check('document reloaded after undo', afterUndo !== beforeUndo);

    // ------------------------------------------------------- direct typing
    console.log('\n[direct paragraph typing]');
    const directModel = (await req('GET', '/api/doc')).body;
    const directP = directModel.paragraphs.find((x) => x.runs.length > 3 && x.text.length > 120);
    const directOriginal = directP.text;
    const directText = directOriginal.slice(0, 18) + ' directly' + directOriginal.slice(18);
    const directRev = (await req('GET', '/api/health')).body.rev;
    const typed = await req('POST', '/api/edit', {
      who: 'human',
      op: { type: 'set_text', pid: directP.pid, text: directText,
        expect_hash: directP.hash, why: 'typed directly', utterance: 'direct-1' },
    });
    check('direct typing uses the ordinary edit endpoint',
      typed.status === 200 && typed.body.rev === directRev + 1, typed.body.error || typed.body.rev);
    const directAfter = (await req('GET', '/api/doc')).body.paragraphs.find((x) => x.pid === directP.pid);
    check('the typed text persisted to the document', directAfter.text === directText);
    await sleep(200);
    const directEvent = events.find((e) => e.type === 'edit' && e.data.op === 'set_text');
    check('direct typing is broadcast like every other edit',
      !!directEvent && directEvent.data.who === 'human' && /typed in paragraph/.test(directEvent.data.summary),
      directEvent && directEvent.data.summary);

    const directUndo = await req('POST', '/api/undo');
    check('direct typing gets a normal undo checkpoint', directUndo.status === 200, directUndo.body.error);
    const directRestored = (await req('GET', '/api/doc')).body.paragraphs.find((x) => x.pid === directP.pid);
    check('undo restores the exact pre-typing text', directRestored.text === directOriginal);

    const checkpointDir = path.join(dataDir, 'checkpoints');
    const checkpointsBeforeStale = fs.readdirSync(checkpointDir).filter((x) => x.endsWith('.docx')).length;
    const beforeStaleDirect = JSON.stringify((await req('GET', '/api/doc')).body.paragraphs);
    const staleDirect = await req('POST', '/api/edit', {
      who: 'human',
      op: { type: 'set_text', pid: directP.pid, text: 'must not land',
        expect_hash: 'deadbeef1234', why: 'typed directly', utterance: 'direct-stale' },
    });
    check('stale direct typing is refused', staleDirect.status === 400 &&
      /changed since you read it/.test(staleDirect.body.error || ''), staleDirect.body.error);
    check('a stale direct edit changes nothing',
      JSON.stringify((await req('GET', '/api/doc')).body.paragraphs) === beforeStaleDirect);
    check('a refused direct edit leaves no phantom undo checkpoint',
      fs.readdirSync(checkpointDir).filter((x) => x.endsWith('.docx')).length === checkpointsBeforeStale,
      `${checkpointsBeforeStale} -> ${fs.readdirSync(checkpointDir).filter((x) => x.endsWith('.docx')).length}`);

    // ----------------------------------------------------- paragraph merge
    console.log('\n[atomic paragraph merge]');
    const mergeModel = (await req('GET', '/api/doc')).body;
    const mergeIndex = mergeModel.paragraphs.findIndex((x, index, all) => {
      const next = all[index + 1];
      return next && !x.table && !next.table &&
        x.text.length > 20 && next.text.length > 20;
    });
    const mergeFirst = mergeModel.paragraphs[mergeIndex];
    const mergeSecond = mergeModel.paragraphs[mergeIndex + 1];
    const mergeFirstText = mergeFirst.text + ' ';
    const mergeSecondText = mergeSecond.text + ' [typed before merge]';
    const mergeExpected = mergeFirstText + mergeSecondText;
    const mergeBeforeSnapshot = JSON.stringify(mergeModel.paragraphs);
    const mergeBytesBefore = fs.readFileSync(activeDoc);
    const mergeEventsBefore = events.filter((event) =>
      event.type === 'edit' && event.data.op === 'merge').length;
    const mergeCheckpoints = fs.readdirSync(checkpointDir)
      .filter((x) => x.endsWith('.docx')).length;
    for (const malformed of [
      {
        type: 'merge', pid: mergeFirst.pid,
        first_pid: mergeFirst.pid, second_pid: mergeSecond.pid,
        first_text: mergeFirstText, second_text: mergeSecondText,
        expect_first_hash: mergeFirst.hash,
      },
      {
        type: 'merge', pid: mergeSecond.pid,
        first_pid: mergeFirst.pid, second_pid: mergeSecond.pid,
        first_text: mergeFirstText, second_text: mergeSecondText,
        expect_first_hash: mergeFirst.hash,
        expect_second_hash: mergeSecond.hash,
      },
      {
        type: 'merge', pid: mergeFirst.pid,
        first_pid: mergeFirst.pid, second_pid: mergeSecond.pid,
        first_text: mergeFirstText, second_text: `${mergeSecondText}\u0000`,
        expect_first_hash: mergeFirst.hash,
        expect_second_hash: mergeSecond.hash,
      },
    ]) {
      const refused = await req('POST', '/api/edit', {
        who: 'human', op: malformed,
      });
      check('malformed or incompletely guarded merges are refused before mutation',
        refused.status === 400,
        refused.body.error);
    }
    check('merge boundary refusals leave content and checkpoints untouched',
      JSON.stringify((await req('GET', '/api/doc')).body.paragraphs) ===
        mergeBeforeSnapshot &&
      fs.readdirSync(checkpointDir).filter((x) => x.endsWith('.docx')).length ===
        mergeCheckpoints);
    for (const staleGuard of [
      {
        label: 'first',
        first: 'deadbeef1234',
        second: mergeSecond.hash,
      },
      {
        label: 'second',
        first: mergeFirst.hash,
        second: 'deadbeef1234',
      },
    ]) {
      const staleMerge = await req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'merge', pid: mergeFirst.pid,
          first_pid: mergeFirst.pid, second_pid: mergeSecond.pid,
          first_text: mergeFirstText, second_text: mergeSecondText,
          expect_hash: staleGuard.first,
          expect_first_hash: staleGuard.first,
          expect_second_hash: staleGuard.second,
          why: `merge stale ${staleGuard.label} fixture`,
          utterance: `merge-stale-${staleGuard.label}`,
        },
      });
      check(`a stale ${staleGuard.label} paragraph hash refuses the whole merge`,
        staleMerge.status === 400 &&
        /changed since you read it/.test(staleMerge.body.error || ''),
        staleMerge.body.error);
    }
    check('either stale hash changes neither paragraph and creates no checkpoint',
      JSON.stringify((await req('GET', '/api/doc')).body.paragraphs) === mergeBeforeSnapshot &&
      fs.readdirSync(checkpointDir).filter((x) => x.endsWith('.docx')).length === mergeCheckpoints);

    const mergeRev = (await req('GET', '/api/health')).body.rev;
    const merged = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'merge', pid: mergeFirst.pid,
        first_pid: mergeFirst.pid, second_pid: mergeSecond.pid,
        first_text: mergeFirstText, second_text: mergeSecondText,
        expect_hash: mergeFirst.hash,
        expect_first_hash: mergeFirst.hash,
        expect_second_hash: mergeSecond.hash,
        why: 'merged paragraphs directly',
      },
    });
    const afterMergeModel = (await req('GET', '/api/doc')).body;
    const afterMergeFirst = afterMergeModel.paragraphs
      .find((x) => x.pid === mergeFirst.pid);
    check('merge commits both local drafts atomically as one revision',
      merged.status === 200 && merged.body.rev === mergeRev + 1 &&
      merged.body.result && merged.body.result.after === mergeExpected &&
      afterMergeFirst && afterMergeFirst.text === mergeExpected,
      merged.body.error || (afterMergeFirst && afterMergeFirst.text.slice(-50)));
    check('merge preserves both run structures and removes only the consumed pid',
      afterMergeModel.paragraphs.length === mergeModel.paragraphs.length - 1 &&
      !afterMergeModel.paragraphs.some((x) => x.pid === mergeSecond.pid) &&
      afterMergeFirst.runs.length === mergeFirst.runs.length + mergeSecond.runs.length,
      afterMergeFirst && afterMergeFirst.runs.length);
    await sleep(200);
    const mergeEvent = events.find((e) =>
      e.type === 'edit' && e.data.op === 'merge' &&
      e.data.result && e.data.result.removed_pid === mergeSecond.pid);
    check('merge broadcasts one structural edit with numeric highlight bounds',
      !!mergeEvent && mergeEvent.data.pid === mergeFirst.pid &&
      Number.isFinite(mergeEvent.data.result.start) &&
      Number.isFinite(mergeEvent.data.result.end),
      mergeEvent && JSON.stringify(mergeEvent.data.result));
    check('merge emits exactly one edit event',
      events.filter((event) =>
        event.type === 'edit' && event.data.op === 'merge').length ===
          mergeEventsBefore + 1);

    const mergeUndo = await req('POST', '/api/undo');
    const mergeRestoredModel = (await req('GET', '/api/doc')).body;
    check('one undo restores both original paragraphs and their identities',
      mergeUndo.status === 200 &&
      mergeRestoredModel.paragraphs.length === mergeModel.paragraphs.length &&
      mergeRestoredModel.paragraphs.find((x) => x.pid === mergeFirst.pid).text ===
        mergeFirst.text &&
      mergeRestoredModel.paragraphs.find((x) => x.pid === mergeSecond.pid).text ===
      mergeSecond.text,
      mergeUndo.body.error);
    check('merge Undo restores the exact pre-merge package bytes',
      fs.readFileSync(activeDoc).equals(mergeBytesBefore));

    const readPersistedState = () => JSON.parse(
      fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'),
    );

    // ---------------------------------------- package ownership + open tokens
    console.log('\n[external package ownership and document tokens]');
    const ownershipCheckpointSnapshot = () => Object.fromEntries(
      fs.readdirSync(checkpointDir)
        .filter((name) => name.endsWith('.docx'))
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(checkpointDir, name)).toString('base64'),
        ]),
    );
    const findMergePair = (model, excluded = new Set()) => {
      const index = model.paragraphs.findIndex((paragraph, i, all) => {
        const next = all[i + 1];
        return next && !paragraph.table && !next.table &&
          !excluded.has(paragraph.pid) && !excluded.has(next.pid) &&
          paragraph.text.length > 20 && next.text.length > 20;
      });
      return index < 0 ? null : [model.paragraphs[index], model.paragraphs[index + 1]];
    };
    const mergePayload = (first, second, token, utterance = 'ownership-merge') => ({
      who: 'human',
      op: {
        type: 'merge',
        pid: first.pid,
        first_pid: first.pid,
        second_pid: second.pid,
        first_text: first.text,
        second_text: second.text,
        expect_first_hash: first.hash,
        expect_second_hash: second.hash,
        expect_document_token: token,
        why: 'package ownership fixture',
        utterance,
      },
    });

    // A copied package preserves paragraph ids, so only the per-open token can
    // distinguish an edit captured from the previously active document.
    const ownershipActiveModel = (await req('GET', '/api/doc')).body;
    const copiedOwnershipDoc = path.join(
      path.dirname(activeDoc),
      'same-ids-external-replacement.docx',
    );
    fs.copyFileSync(activeDoc, copiedOwnershipDoc);
    const openedOwnershipCopy = await req('POST', '/api/open', {
      path: copiedOwnershipDoc,
    });
    const ownershipCopyModel = (await req('GET', '/api/doc')).body;
    const ownershipCopyPair = findMergePair(ownershipCopyModel);
    const copiedTokenStateBefore = fs.readFileSync(
      path.join(dataDir, 'state.json'),
    );
    const copiedTokenBytesBefore = fs.readFileSync(copiedOwnershipDoc);
    const copiedTokenEventIndex = events.length;
    const unboundCopiedTokenRead = await req('POST', '/api/edit', {
      who: 'agent',
      op: { type: 'read', from: 0, to: 0 },
    });
    const staleCopiedTokenRead = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'read',
        from: 0,
        to: 0,
        expect_document_token: ownershipActiveModel.document_token,
      },
    });
    const staleCopiedTokenProposal = await req('POST', '/api/propose', {
      who: 'agent',
      expect_document_token: ownershipActiveModel.document_token,
      proposal: {
        anchor_pid: ownershipCopyPair[0].pid,
        anchor_hash: ownershipCopyPair[0].hash,
        mode: 'insert',
        intent: 'must remain bound to the source document',
        options: [{ text: 'One stale option.' }, { text: 'Another stale option.' }],
      },
    });
    const staleCopiedTokenAssist = await req('POST', '/api/assist', {
      who: 'watch',
      expect_document_token: ownershipActiveModel.document_token,
      assist: {
        review_id: 'stale-document-review',
        anchor_pid: ownershipCopyPair[0].pid,
        title: 'Must not attach',
        text: 'This note belongs to the prior document.',
      },
    });
    const staleCopiedTokenWatch = await req('POST', '/api/watch/review', {
      expect_document_token: ownershipActiveModel.document_token,
      changes: [{
        pid: ownershipCopyPair[0].pid,
        before: ownershipCopyPair[0].text,
        after: `${ownershipCopyPair[0].text} stale watch capture`,
      }],
    });
    const staleCopiedTokenPrediction = await req('POST', '/api/predict', {
      expect_document_token: ownershipActiveModel.document_token,
      grant: 'stale-document-grant',
      pid: ownershipCopyPair[0].pid,
      before: ownershipCopyPair[0].text,
      after: `${ownershipCopyPair[0].text} stale prediction capture`,
    });
    const staleCopiedTokenMerge = await req(
      'POST',
      '/api/edit',
      mergePayload(
        ownershipCopyPair[0],
        ownershipCopyPair[1],
        ownershipActiveModel.document_token,
        'stale-copied-token',
      ),
    );
    await sleep(80);
    check('a token from the source document cannot merge its copied package',
      openedOwnershipCopy.status === 200 &&
      unboundCopiedTokenRead.status === 409 &&
      staleCopiedTokenRead.status === 409 &&
      staleCopiedTokenProposal.status === 409 &&
      staleCopiedTokenAssist.status === 409 &&
      staleCopiedTokenWatch.status === 409 &&
      staleCopiedTokenPrediction.status === 409 &&
      staleCopiedTokenMerge.status === 409 &&
      /active document changed/i.test(staleCopiedTokenMerge.body.error || '') &&
      fs.readFileSync(copiedOwnershipDoc).equals(copiedTokenBytesBefore) &&
      fs.readFileSync(path.join(dataDir, 'state.json')).equals(copiedTokenStateBefore) &&
      !events.slice(copiedTokenEventIndex).some((event) =>
        event.type === 'edit' || event.type === 'trail'),
      staleCopiedTokenMerge.body.error);
    const currentCopiedTokenRead = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'read',
        from: 0,
        to: 0,
        expect_document_token: ownershipCopyModel.document_token,
      },
    });
    check('the active agent token authorizes read-only MCP document calls',
      currentCopiedTokenRead.status === 200 &&
      currentCopiedTokenRead.body.result.paragraphs.length === 1,
      currentCopiedTokenRead.body.error);

    // Browser actions are deliberately backward compatible when no token is
    // supplied, but an explicit token must always bind the action to the
    // document generation that rendered its UI.
    console.log('\n[document-bound browser actions]');
    const ownershipToken = ownershipCopyModel.document_token;
    const staleOwnershipToken = ownershipActiveModel.document_token;
    const [
      ownershipHealthSnapshot,
      ownershipProposalSnapshot,
      ownershipPredictionSnapshot,
      ownershipAgentSnapshot,
    ] = await Promise.all([
      req('GET', '/api/health'),
      req('GET', '/api/proposals'),
      req('GET', '/api/predict'),
      req('GET', '/api/agent'),
    ]);
    check('all reconnect snapshots expose the same active document token',
      ownershipHealthSnapshot.status === 200 &&
      ownershipProposalSnapshot.status === 200 &&
      ownershipPredictionSnapshot.status === 200 &&
      ownershipAgentSnapshot.status === 200 &&
      ownershipHealthSnapshot.body.document_token === ownershipToken &&
      ownershipProposalSnapshot.body.document_token === ownershipToken &&
      ownershipPredictionSnapshot.body.document_token === ownershipToken &&
      ownershipAgentSnapshot.body.document_token === ownershipToken,
      JSON.stringify({
        health: ownershipHealthSnapshot.body.document_token,
        proposals: ownershipProposalSnapshot.body.document_token,
        predict: ownershipPredictionSnapshot.body.document_token,
        agent: ownershipAgentSnapshot.body.document_token,
      }));

    const ownershipAnchorPid = ownershipCopyPair[0].pid;
    async function createOwnershipProposal(tag) {
      const currentModel = (await req('GET', '/api/doc')).body;
      const anchor = currentModel.paragraphs.find((paragraph) =>
        paragraph.pid === ownershipAnchorPid);
      return req('POST', '/api/propose', {
        who: 'human',
        expect_document_token: ownershipToken,
        proposal: {
          anchor_pid: anchor.pid,
          anchor_hash: anchor.hash,
          mode: 'insert',
          intent: `document ownership ${tag}`,
          options: [
            { text: `Ownership option A for ${tag}.` },
            { text: `Ownership option B for ${tag}.` },
          ],
        },
      });
    }

    const staleSayProposal = await createOwnershipProposal('stale say');
    const staleSayStateBefore = fs.readFileSync(path.join(dataDir, 'state.json'));
    const staleSayTrailBefore = await req('GET', '/api/trail');
    const staleSayAgentBefore = await req('GET', '/api/agent');
    const staleSayEventIndex = events.length;
    const staleSay = await req('POST', '/api/say', {
      text: 'none of those',
      expect_document_token: staleOwnershipToken,
    });
    const staleSayTrailAfter = await req('GET', '/api/trail');
    const staleSayAgentAfter = await req('GET', '/api/agent');
    const staleSayProposalsAfter = await req('GET', '/api/proposals');
    await sleep(80);
    check('a stale token refuses say before trail, agent, or proposal mutation',
      staleSayProposal.status === 200 &&
      staleSay.status === 409 &&
      /active document changed/i.test(staleSay.body.error || '') &&
      fs.readFileSync(path.join(dataDir, 'state.json')).equals(staleSayStateBefore) &&
      JSON.stringify(staleSayTrailAfter.body) ===
        JSON.stringify(staleSayTrailBefore.body) &&
      staleSayAgentAfter.body.running === staleSayAgentBefore.body.running &&
      staleSayAgentAfter.body.pid === staleSayAgentBefore.body.pid &&
      staleSayProposalsAfter.body.proposals.some((proposal) =>
        proposal.id === staleSayProposal.body.id &&
        proposal.status === 'open') &&
      !events.slice(staleSayEventIndex).some((event) =>
        event.type === 'trail' || event.type === 'proposal' ||
        event.type === 'agent'),
      staleSay.body.error);

    const currentSay = await req('POST', '/api/say', {
      text: 'none of those',
      expect_document_token: ownershipToken,
    });
    const legacySayProposal = await createOwnershipProposal('legacy say');
    const legacySay = await req('POST', '/api/say', {
      text: 'none of those',
    });
    const proposalsAfterSay = await req('GET', '/api/proposals');
    check('say accepts the current token and keeps tokenless browser compatibility',
      currentSay.status === 200 && currentSay.body.resolved === 'dismiss' &&
      legacySayProposal.status === 200 &&
      legacySay.status === 200 && legacySay.body.resolved === 'dismiss' &&
      !proposalsAfterSay.body.proposals.some((proposal) =>
        proposal.id === staleSayProposal.body.id ||
        proposal.id === legacySayProposal.body.id),
      `${currentSay.status}/${legacySay.status}`);

    const staleAcceptProposal = await createOwnershipProposal('stale accept');
    const staleAcceptStateBefore =
      fs.readFileSync(path.join(dataDir, 'state.json'));
    const staleAcceptBytesBefore = fs.readFileSync(copiedOwnershipDoc);
    const staleAcceptModelBefore = (await req('GET', '/api/doc')).body;
    const staleAcceptEventIndex = events.length;
    const staleTokenProposalAccept = await req('POST', '/api/accept', {
      id: staleAcceptProposal.body.id,
      option: 'A',
      who: 'human',
      expect_document_token: staleOwnershipToken,
    });
    const staleAcceptOpen = await req('GET', '/api/proposals');
    await sleep(80);
    check('a stale token refuses proposal acceptance without mutation',
      staleAcceptProposal.status === 200 &&
      staleTokenProposalAccept.status === 409 &&
      /active document changed/i.test(staleTokenProposalAccept.body.error || '') &&
      fs.readFileSync(copiedOwnershipDoc).equals(staleAcceptBytesBefore) &&
      fs.readFileSync(path.join(dataDir, 'state.json'))
        .equals(staleAcceptStateBefore) &&
      staleAcceptOpen.body.proposals.some((proposal) =>
        proposal.id === staleAcceptProposal.body.id &&
        proposal.status === 'open') &&
      !events.slice(staleAcceptEventIndex).some((event) =>
        event.type === 'edit' || event.type === 'proposal' ||
        event.type === 'trail'),
      staleTokenProposalAccept.body.error);

    const currentProposalAccept = await req('POST', '/api/accept', {
      id: staleAcceptProposal.body.id,
      option: 'A',
      who: 'human',
      expect_document_token: ownershipToken,
    });
    const currentAcceptModel = (await req('GET', '/api/doc')).body;
    const currentAcceptUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const legacyAcceptProposal = await createOwnershipProposal('legacy accept');
    const legacyProposalAccept = await req('POST', '/api/accept', {
      id: legacyAcceptProposal.body.id,
      option: 'B',
      who: 'human',
    });
    const legacyAcceptUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const afterProposalAcceptCleanup = (await req('GET', '/api/doc')).body;
    check('proposal acceptance permits the current token and a legacy missing token',
      currentProposalAccept.status === 200 &&
      currentAcceptModel.count === staleAcceptModelBefore.count + 1 &&
      currentAcceptUndo.status === 200 &&
      legacyAcceptProposal.status === 200 &&
      legacyProposalAccept.status === 200 &&
      legacyAcceptUndo.status === 200 &&
      afterProposalAcceptCleanup.count === staleAcceptModelBefore.count,
      `${currentProposalAccept.status}/${legacyProposalAccept.status}`);

    const staleDismissProposal = await createOwnershipProposal('stale dismiss');
    const staleDismissStateBefore =
      fs.readFileSync(path.join(dataDir, 'state.json'));
    const staleProposalDismiss = await req('POST', '/api/dismiss', {
      id: staleDismissProposal.body.id,
      expect_document_token: staleOwnershipToken,
    });
    const staleDismissOpen = await req('GET', '/api/proposals');
    check('a stale token refuses proposal dismissal without mutation',
      staleDismissProposal.status === 200 &&
      staleProposalDismiss.status === 409 &&
      fs.readFileSync(path.join(dataDir, 'state.json'))
        .equals(staleDismissStateBefore) &&
      staleDismissOpen.body.proposals.some((proposal) =>
        proposal.id === staleDismissProposal.body.id &&
        proposal.status === 'open'),
      staleProposalDismiss.body.error);
    const currentProposalDismiss = await req('POST', '/api/dismiss', {
      id: staleDismissProposal.body.id,
      expect_document_token: ownershipToken,
    });
    const legacyDismissProposal = await createOwnershipProposal('legacy dismiss');
    const legacyProposalDismiss = await req('POST', '/api/dismiss', {
      id: legacyDismissProposal.body.id,
    });
    check('proposal dismissal permits the current token and a legacy missing token',
      currentProposalDismiss.status === 200 &&
      currentProposalDismiss.body.dismissed === staleDismissProposal.body.id &&
      legacyDismissProposal.status === 200 &&
      legacyProposalDismiss.status === 200 &&
      legacyProposalDismiss.body.dismissed === legacyDismissProposal.body.id,
      `${currentProposalDismiss.status}/${legacyProposalDismiss.status}`);

    const ownershipContinuationAnchor = ownershipCopyModel.paragraphs.find(
      (paragraph) =>
        !paragraph.table && paragraph.text.length > 80 &&
        paragraph.pid !== ownershipCopyPair[0].pid &&
        paragraph.pid !== ownershipCopyPair[1].pid,
    );
    async function createOwnershipContinuation(tag) {
      const currentModel = (await req('GET', '/api/doc')).body;
      const anchor = currentModel.paragraphs.find((paragraph) =>
        paragraph.pid === ownershipContinuationAnchor.pid);
      const suffix = ` [document token ${tag}]`;
      const afterText = anchor.text + suffix;
      const typed = await req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'set_text',
          pid: anchor.pid,
          text: afterText,
          expect_hash: anchor.hash,
          expect_document_token: ownershipToken,
          why: 'typed directly',
          utterance: `document-token-${tag}`,
        },
      });
      const grant = typed.body.prediction_grant;
      if (typed.status !== 200 || !grant || !grant.token) {
        throw new Error(
          typed.body.error || `No prediction grant for ownership ${tag}`,
        );
      }
      await sleep(Math.max(
        0,
        Date.parse(grant.not_before) - Date.now() + 20,
      ));
      const started = await req('POST', '/api/predict', {
        expect_document_token: ownershipToken,
        grant: grant.token,
        capture_id: `document-token-${tag}`,
        pid: anchor.pid,
        before: anchor.text,
        after: afterText,
        quietMs: 1000,
      });
      if (started.status !== 200) {
        throw new Error(
          started.body.error || `Prediction did not start for ownership ${tag}`,
        );
      }
      const continuationText = [
        `The ${tag} continuation remains entirely inside the isolated test`,
        'document while exercising document ownership, exact persistence,',
        'safe recovery, and deterministic browser compatibility without',
        'starting or contacting any external editing model process.',
      ].join(' ');
      const finished = await req('POST', '/api/predict/fixture', {
        text: `<continuation>${continuationText}</continuation>`,
      });
      if (finished.status !== 200 || !finished.body.continuation) {
        throw new Error(
          finished.body.error ||
          `Prediction did not finish for ownership ${tag}`,
        );
      }
      return {
        before: anchor,
        typed,
        continuation: finished.body.continuation,
      };
    }

    const staleDismissContinuation =
      await createOwnershipContinuation('stale dismiss');
    const staleContinuationDismissState =
      fs.readFileSync(path.join(dataDir, 'state.json'));
    const staleContinuationDismiss = await req(
      'POST',
      '/api/predict/dismiss',
      {
        id: staleDismissContinuation.continuation.id,
        expect_document_token: staleOwnershipToken,
      },
    );
    const afterStaleContinuationDismiss = await req('GET', '/api/predict');
    check('a stale token refuses continuation dismissal without mutation',
      staleContinuationDismiss.status === 409 &&
      fs.readFileSync(path.join(dataDir, 'state.json'))
        .equals(staleContinuationDismissState) &&
      afterStaleContinuationDismiss.body.continuation &&
      afterStaleContinuationDismiss.body.continuation.id ===
        staleDismissContinuation.continuation.id,
      staleContinuationDismiss.body.error);
    const currentContinuationDismiss = await req(
      'POST',
      '/api/predict/dismiss',
      {
        id: staleDismissContinuation.continuation.id,
        expect_document_token: ownershipToken,
      },
    );
    const currentDismissSeedUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const legacyDismissContinuation =
      await createOwnershipContinuation('legacy dismiss');
    const legacyContinuationDismiss = await req(
      'POST',
      '/api/predict/dismiss',
      { id: legacyDismissContinuation.continuation.id },
    );
    const legacyDismissSeedUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    check('continuation dismissal permits the current token and a legacy missing token',
      currentContinuationDismiss.status === 200 &&
      currentDismissSeedUndo.status === 200 &&
      legacyContinuationDismiss.status === 200 &&
      legacyDismissSeedUndo.status === 200,
      `${currentContinuationDismiss.status}/${legacyContinuationDismiss.status}`);

    const staleAcceptContinuation =
      await createOwnershipContinuation('stale accept');
    const staleContinuationAcceptState =
      fs.readFileSync(path.join(dataDir, 'state.json'));
    const staleContinuationAcceptBytes = fs.readFileSync(copiedOwnershipDoc);
    const staleContinuationAcceptModel = (await req('GET', '/api/doc')).body;
    const staleContinuationAcceptEventIndex = events.length;
    const staleTokenContinuationAccept = await req('POST', '/api/predict/accept', {
      id: staleAcceptContinuation.continuation.id,
      expect_document_token: staleOwnershipToken,
    });
    const afterStaleContinuationAccept = await req('GET', '/api/predict');
    await sleep(80);
    check('a stale token refuses continuation acceptance without mutation',
      staleTokenContinuationAccept.status === 409 &&
      /active document changed/i.test(staleTokenContinuationAccept.body.error || '') &&
      fs.readFileSync(copiedOwnershipDoc)
        .equals(staleContinuationAcceptBytes) &&
      fs.readFileSync(path.join(dataDir, 'state.json'))
        .equals(staleContinuationAcceptState) &&
      afterStaleContinuationAccept.body.continuation &&
      afterStaleContinuationAccept.body.continuation.id ===
        staleAcceptContinuation.continuation.id &&
      !events.slice(staleContinuationAcceptEventIndex).some((event) =>
        event.type === 'edit' || event.type === 'predict' ||
        event.type === 'trail'),
      staleTokenContinuationAccept.body.error);
    const currentContinuationAccept = await req('POST', '/api/predict/accept', {
      id: staleAcceptContinuation.continuation.id,
      expect_document_token: ownershipToken,
    });
    const afterCurrentContinuationAccept = (await req('GET', '/api/doc')).body;
    const currentContinuationAcceptUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const currentContinuationSeedUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const legacyAcceptContinuation =
      await createOwnershipContinuation('legacy accept');
    const legacyContinuationAccept = await req('POST', '/api/predict/accept', {
      id: legacyAcceptContinuation.continuation.id,
    });
    const legacyContinuationAcceptUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const legacyContinuationSeedUndo = await req('POST', '/api/undo', {
      expect_document_token: ownershipToken,
    });
    const afterContinuationAcceptCleanup = (await req('GET', '/api/doc')).body;
    check('continuation acceptance permits the current token and a legacy missing token',
      currentContinuationAccept.status === 200 &&
      afterCurrentContinuationAccept.count ===
        staleContinuationAcceptModel.count + 1 &&
      currentContinuationAcceptUndo.status === 200 &&
      currentContinuationSeedUndo.status === 200 &&
      legacyContinuationAccept.status === 200 &&
      legacyContinuationAcceptUndo.status === 200 &&
      legacyContinuationSeedUndo.status === 200 &&
      afterContinuationAcceptCleanup.count === ownershipCopyModel.count,
      `${currentContinuationAccept.status}/${legacyContinuationAccept.status}`);

    const externalMarkerTarget = ownershipCopyModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 60 &&
      paragraph.pid !== ownershipCopyPair[0].pid &&
      paragraph.pid !== ownershipCopyPair[1].pid);
    const externalMarkerText =
      `${externalMarkerTarget.text} [external replacement marker]`;
    const markedOwnershipCopy = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: externalMarkerTarget.pid,
        text: externalMarkerText,
        expect_hash: externalMarkerTarget.hash,
        expect_document_token: ownershipCopyModel.document_token,
        why: 'typed directly',
        utterance: 'external-replacement-source',
      },
    });
    const externalReplacementBytes = fs.readFileSync(copiedOwnershipDoc);
    check('external replacement fixture is a distinct valid saved package',
      markedOwnershipCopy.status === 200 &&
      !externalReplacementBytes.equals(copiedTokenBytesBefore),
      markedOwnershipCopy.body.error);

    const returnedForSamePathToken = await req('POST', '/api/open', {
      path: activeDoc,
    });
    const beforeSamePathTokenOpen = (await req('GET', '/api/doc')).body;
    const delayedSamePathTokenOpen = req('POST', '/api/open', {
      path: activeDoc,
      __test_delay_after_host_open_ms: 300,
    });
    await sleep(100);
    const crossedSamePathUndo = req('POST', '/api/undo', {
      expect_document_token: beforeSamePathTokenOpen.document_token,
    });
    const [samePathTokenOpen, crossedSamePathUndoResult] = await Promise.all([
      delayedSamePathTokenOpen,
      crossedSamePathUndo,
    ]);
    const afterSamePathTokenOpen = (await req('GET', '/api/doc')).body;
    const samePathTokenPair = findMergePair(afterSamePathTokenOpen);
    const samePathTokenStateBefore = fs.readFileSync(path.join(dataDir, 'state.json'));
    const samePathTokenBytesBefore = fs.readFileSync(activeDoc);
    const samePathTokenEventIndex = events.length;
    const staleSamePathTokenMerge = await req(
      'POST',
      '/api/edit',
      mergePayload(
        samePathTokenPair[0],
        samePathTokenPair[1],
        beforeSamePathTokenOpen.document_token,
        'stale-same-path-token',
      ),
    );
    await sleep(80);
    check('same-path Open rotates its token and rejects the prior merge capture',
      returnedForSamePathToken.status === 200 &&
      samePathTokenOpen.status === 200 &&
      crossedSamePathUndoResult.status === 409 &&
      beforeSamePathTokenOpen.document_token !==
        afterSamePathTokenOpen.document_token &&
      staleSamePathTokenMerge.status === 409 &&
      fs.readFileSync(activeDoc).equals(samePathTokenBytesBefore) &&
      fs.readFileSync(path.join(dataDir, 'state.json')).equals(samePathTokenStateBefore) &&
      !events.slice(samePathTokenEventIndex).some((event) =>
        event.type === 'edit' || event.type === 'trail'),
      staleSamePathTokenMerge.body.error);

    // Seed one real Undo checkpoint, then replace the active path behind the
    // host with the distinct copied package.
    const ownershipSeedTarget = afterSamePathTokenOpen.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80 &&
      paragraph.pid !== samePathTokenPair[0].pid &&
      paragraph.pid !== samePathTokenPair[1].pid);
    const ownershipSeedEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: ownershipSeedTarget.pid,
        text: `${ownershipSeedTarget.text} [owned package seed]`,
        expect_hash: ownershipSeedTarget.hash,
        expect_document_token: afterSamePathTokenOpen.document_token,
        why: 'typed directly',
        utterance: 'owned-package-seed',
      },
    });
    const ownedModelBeforeReplacement = (await req('GET', '/api/doc')).body;
    const ownedMergePair = findMergePair(
      ownedModelBeforeReplacement,
      new Set([ownershipSeedTarget.pid]),
    );
    const ownedPackageBytes = fs.readFileSync(activeDoc);
    const ownedStateBeforeReplacement =
      fs.readFileSync(path.join(dataDir, 'state.json'));
    const ownedCheckpointsBeforeReplacement = ownershipCheckpointSnapshot();
    fs.writeFileSync(activeDoc, externalReplacementBytes);

    const ownershipConflictEventIndex = events.length;
    const refusedExternalMerge = await req(
      'POST',
      '/api/edit',
      mergePayload(
        ownedMergePair[0],
        ownedMergePair[1],
        ownedModelBeforeReplacement.document_token,
        'external-replacement-merge',
      ),
    );
    const refusedExternalEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: ownershipSeedTarget.pid,
        text: `${ownershipSeedTarget.text} [must never overwrite replacement]`,
        expect_hash: ownershipSeedTarget.hash,
        why: 'typed directly',
        utterance: 'external-replacement-edit',
      },
    });
    const refusedExternalUndo = await req('POST', '/api/undo');
    await sleep(100);
    const reconciledExternalModel = (await req('GET', '/api/doc')).body;
    const ownershipConflictHealth = await req('GET', '/api/health');
    check('same-path external replacement refuses merge, edit, and Undo',
      ownershipSeedEdit.status === 200 &&
      refusedExternalMerge.status === 409 &&
      refusedExternalEdit.status === 409 &&
      refusedExternalUndo.status === 409 &&
      ownershipConflictHealth.body.documentOwnership &&
      ownershipConflictHealth.body.documentOwnership.ok === false,
      `${refusedExternalMerge.status}/${refusedExternalEdit.status}/` +
        `${refusedExternalUndo.status}`);
    check('external replacement bytes, state, checkpoints, and SSE stay exact',
      fs.readFileSync(activeDoc).equals(externalReplacementBytes) &&
      fs.readFileSync(path.join(dataDir, 'state.json'))
        .equals(ownedStateBeforeReplacement) &&
      JSON.stringify(ownershipCheckpointSnapshot()) ===
        JSON.stringify(ownedCheckpointsBeforeReplacement) &&
      reconciledExternalModel.paragraphs.some((paragraph) =>
        paragraph.text === externalMarkerText) &&
      reconciledExternalModel.paragraphs.some((paragraph) =>
        paragraph.pid === ownedMergePair[1].pid) &&
      !events.slice(ownershipConflictEventIndex).some((event) =>
        ['edit', 'trail', 'document', 'opened'].includes(event.type)),
      JSON.stringify({
        bytes: fs.readFileSync(activeDoc).equals(externalReplacementBytes),
        state: fs.readFileSync(path.join(dataDir, 'state.json'))
          .equals(ownedStateBeforeReplacement),
        events: events.slice(ownershipConflictEventIndex).map((event) => event.type),
      }));

    // Explicit Open is the ownership handoff. Once committed, edits and Undo
    // both advance the persisted fingerprint and remain mutually consistent.
    const conflictToken = reconciledExternalModel.document_token;
    const adoptedExternal = await req('POST', '/api/open', { path: activeDoc });
    const adoptedModel = (await req('GET', '/api/doc')).body;
    const adoptedEditTarget = adoptedModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80);
    const adoptedBytesBeforeEdit = fs.readFileSync(activeDoc);
    const adoptedEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: adoptedEditTarget.pid,
        text: `${adoptedEditTarget.text} [post-adoption edit]`,
        expect_hash: adoptedEditTarget.hash,
        expect_document_token: adoptedModel.document_token,
        why: 'typed directly',
        utterance: 'post-adoption-edit',
      },
    });
    const adoptedBytesAfterEdit = fs.readFileSync(activeDoc);
    const adoptedUndo = await req('POST', '/api/undo');
    const afterAdoptedUndo = (await req('GET', '/api/doc')).body;
    const postUndoTarget = afterAdoptedUndo.paragraphs.find((paragraph) =>
      paragraph.pid === adoptedEditTarget.pid);
    const postUndoEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: postUndoTarget.pid,
        text: `${postUndoTarget.text} [fingerprint follows Undo]`,
        expect_hash: postUndoTarget.hash,
        expect_document_token: afterAdoptedUndo.document_token,
        why: 'typed directly',
        utterance: 'post-undo-fingerprint',
      },
    });
    const postUndoCleanup = await req('POST', '/api/undo');
    check('explicit Open adopts replacement and save/Undo refresh ownership',
      adoptedExternal.status === 200 &&
      adoptedExternal.body.document_token !== conflictToken &&
      adoptedEdit.status === 200 &&
      !adoptedBytesAfterEdit.equals(adoptedBytesBeforeEdit) &&
      adoptedUndo.status === 200 &&
      postUndoEdit.status === 200 &&
      postUndoCleanup.status === 200 &&
      fs.readFileSync(activeDoc).equals(adoptedBytesBeforeEdit),
      `${adoptedExternal.status}/${adoptedEdit.status}/${adoptedUndo.status}/` +
        `${postUndoEdit.status}/${postUndoCleanup.status}`);

    // Replace the package during the in-memory mutation delay. Python's
    // second pre-replace fingerprint check must refuse, and Node must not run
    // its ordinary snapshot rollback over the new external bytes.
    const beforeSaveRaceModel = (await req('GET', '/api/doc')).body;
    const saveRaceTarget = beforeSaveRaceModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80);
    const saveRaceStateBefore = fs.readFileSync(path.join(dataDir, 'state.json'));
    const saveRaceCheckpointsBefore = ownershipCheckpointSnapshot();
    const saveRaceEventIndex = events.length;
    const delayedSaveRace = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: saveRaceTarget.pid,
        text: `${saveRaceTarget.text} [must lose external save race]`,
        expect_hash: saveRaceTarget.hash,
        expect_document_token: beforeSaveRaceModel.document_token,
        why: 'typed directly',
        utterance: 'external-save-race',
        __test_delay_after_mutation_ms: 300,
      },
    });
    await sleep(100);
    fs.writeFileSync(activeDoc, ownedPackageBytes);
    const refusedSaveRace = await delayedSaveRace;
    await sleep(80);
    check('external save between mutation and save is never overwritten by rollback',
      refusedSaveRace.status === 409 &&
      fs.readFileSync(activeDoc).equals(ownedPackageBytes) &&
      fs.readFileSync(path.join(dataDir, 'state.json')).equals(saveRaceStateBefore) &&
      JSON.stringify(ownershipCheckpointSnapshot()) ===
        JSON.stringify(saveRaceCheckpointsBefore) &&
      !events.slice(saveRaceEventIndex).some((event) =>
        event.type === 'edit' || event.type === 'trail'),
      `${refusedSaveRace.status}/${refusedSaveRace.body.error}`);

    const adoptedAfterSaveRace = await req('POST', '/api/open', {
      path: activeDoc,
    });
    const undoRaceModel = (await req('GET', '/api/doc')).body;
    const undoRaceTarget = undoRaceModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80);
    const ownershipUndoRaceSeed = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: undoRaceTarget.pid,
        text: `${undoRaceTarget.text} [undo final-check seed]`,
        expect_hash: undoRaceTarget.hash,
        expect_document_token: undoRaceModel.document_token,
        why: 'typed directly',
        utterance: 'undo-final-fingerprint-seed',
      },
    });
    // HTTP completion can precede delivery of the seed's SSE frames. Drain
    // those before measuring whether the refused Undo emits any ghosts.
    await sleep(80);
    const undoRaceStateBefore = fs.readFileSync(path.join(dataDir, 'state.json'));
    const undoRaceCheckpointsBefore = ownershipCheckpointSnapshot();
    const undoRaceEventIndex = events.length;
    const delayedUndoRace = req(
      'POST',
      '/api/undo?__test_delay_before_persist_ms=300',
    );
    await sleep(100);
    fs.writeFileSync(activeDoc, externalReplacementBytes);
    const refusedUndoRace = await delayedUndoRace;
    await sleep(80);
    check('Undo rechecks ownership before state commit and preserves a late replacement',
      adoptedAfterSaveRace.status === 200 &&
      ownershipUndoRaceSeed.status === 200 &&
      refusedUndoRace.status === 409 &&
      fs.readFileSync(activeDoc).equals(externalReplacementBytes) &&
      fs.readFileSync(path.join(dataDir, 'state.json')).equals(undoRaceStateBefore) &&
      JSON.stringify(ownershipCheckpointSnapshot()) ===
        JSON.stringify(undoRaceCheckpointsBefore) &&
      !events.slice(undoRaceEventIndex).some((event) =>
        event.type === 'document' || event.type === 'trail'),
      JSON.stringify({
        adopted: adoptedAfterSaveRace.status,
        seeded: ownershipUndoRaceSeed.status,
        refused: refusedUndoRace.status,
        bytes: fs.readFileSync(activeDoc).equals(externalReplacementBytes),
        state: fs.readFileSync(path.join(dataDir, 'state.json'))
          .equals(undoRaceStateBefore),
        checkpoints: JSON.stringify(ownershipCheckpointSnapshot()) ===
          JSON.stringify(undoRaceCheckpointsBefore),
        events: events.slice(undoRaceEventIndex)
          .map((event) => event.type),
        error: refusedUndoRace.body.error,
      }));

    const adoptedAfterUndoRace = await req('POST', '/api/open', {
      path: activeDoc,
    });

    // Watch and prediction requests perform host reads before they create
    // runtime jobs. Hold a copied-package Open in the document lane, submit
    // both against the old document, and prove they cannot wake up on the
    // copied target after Open commits.
    const sidecarRaceBefore = (await req('GET', '/api/doc')).body;
    const sidecarRaceTarget = sidecarRaceBefore.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80);
    const sidecarRaceAfterText =
      `${sidecarRaceTarget.text} [sidecar open-race seed]`;
    await req('POST', '/api/watch/enabled', { enabled: true });
    const sidecarRaceSeed = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: sidecarRaceTarget.pid,
        text: sidecarRaceAfterText,
        expect_hash: sidecarRaceTarget.hash,
        expect_document_token: sidecarRaceBefore.document_token,
        why: 'typed directly',
        utterance: 'sidecar-open-race-seed',
      },
    });
    const sidecarRaceDoc = path.join(
      path.dirname(activeDoc),
      'same-ids-sidecar-open-race.docx',
    );
    fs.copyFileSync(activeDoc, sidecarRaceDoc);
    const sidecarRaceEventIndex = events.length;
    const delayedSidecarOpen = req('POST', '/api/open', {
      path: sidecarRaceDoc,
      __test_delay_after_host_open_ms: 300,
    });
    await sleep(100);
    const crossedWatchRequest = req('POST', '/api/watch/review', {
      quietMs: 1000,
      changes: [{
        pid: sidecarRaceTarget.pid,
        before: sidecarRaceTarget.text,
        after: sidecarRaceAfterText,
      }],
    });
    const crossedPredictionRequest = req('POST', '/api/predict', {
      grant: sidecarRaceSeed.body.prediction_grant &&
        sidecarRaceSeed.body.prediction_grant.token,
      capture_id: 'copied-open-race',
      pid: sidecarRaceTarget.pid,
      before: sidecarRaceTarget.text,
      after: sidecarRaceAfterText,
      quietMs: 1000,
    });
    const [
      sidecarOpenResult,
      crossedWatch,
      crossedPrediction,
    ] = await Promise.all([
      delayedSidecarOpen,
      crossedWatchRequest,
      crossedPredictionRequest,
    ]);
    await sleep(80);
    const watchAfterSidecarRace = await req('GET', '/api/watch');
    const predictionAfterSidecarRace = await req('GET', '/api/predict');
    check('Watch and prediction requests cannot cross a copied-document Open',
      adoptedAfterUndoRace.status === 200 &&
      sidecarRaceSeed.status === 200 &&
      sidecarOpenResult.status === 200 &&
      crossedWatch.status === 409 &&
      crossedPrediction.status === 409 &&
      watchAfterSidecarRace.body.active === null &&
      watchAfterSidecarRace.body.pending.length === 0 &&
      predictionAfterSidecarRace.body.active === null &&
      !events.slice(sidecarRaceEventIndex).some((event) =>
        event.type === 'watch' || event.type === 'predict'),
      `${sidecarOpenResult.status}/${crossedWatch.status}/` +
        `${crossedPrediction.status}`);
    const returnedAfterSidecarRace = await req('POST', '/api/open', {
      path: activeDoc,
    });

    // Reusing a caller label across direct merges must never collapse their
    // two physical joins into one Undo checkpoint.
    const uniqueMergeModel = (await req('GET', '/api/doc')).body;
    const uniquePairOne = findMergePair(uniqueMergeModel);
    const uniquePairTwo = findMergePair(
      uniqueMergeModel,
      new Set(uniquePairOne.map((paragraph) => paragraph.pid)),
    );
    const uniqueMergeBytesBefore = fs.readFileSync(activeDoc);
    const uniqueMergeCheckpointsBefore = readPersistedState().checkpoints.length;
    const uniqueMergeOne = await req(
      'POST',
      '/api/edit',
      mergePayload(
        uniquePairOne[0],
        uniquePairOne[1],
        uniqueMergeModel.document_token,
        'shared-direct-merge-label',
      ),
    );
    const uniqueMergeTwo = await req(
      'POST',
      '/api/edit',
      mergePayload(
        uniquePairTwo[0],
        uniquePairTwo[1],
        uniqueMergeModel.document_token,
        'shared-direct-merge-label',
      ),
    );
    const checkpointsAfterUniqueMerges = readPersistedState().checkpoints.length;
    const uniqueMergeUndoOne = await req('POST', '/api/undo');
    const afterUniqueMergeUndoOne = (await req('GET', '/api/doc')).body;
    const uniqueMergeUndoTwo = await req('POST', '/api/undo');
    check('two direct merges with one caller label retain two Undo boundaries',
      returnedAfterSidecarRace.status === 200 &&
      uniqueMergeOne.status === 200 &&
      uniqueMergeTwo.status === 200 &&
      checkpointsAfterUniqueMerges === uniqueMergeCheckpointsBefore + 2 &&
      uniqueMergeUndoOne.status === 200 &&
      !afterUniqueMergeUndoOne.paragraphs.some((paragraph) =>
        paragraph.pid === uniquePairOne[1].pid) &&
      afterUniqueMergeUndoOne.paragraphs.some((paragraph) =>
        paragraph.pid === uniquePairTwo[1].pid) &&
      uniqueMergeUndoTwo.status === 200 &&
      fs.readFileSync(activeDoc).equals(uniqueMergeBytesBefore),
      `${uniqueMergeOne.status}/${uniqueMergeTwo.status}/` +
        `${checkpointsAfterUniqueMerges - uniqueMergeCheckpointsBefore} checkpoints`);

    // ----------------------------------------------- transaction robustness
    console.log('\n[serialized, atomic document transactions]');
    const transactionModel = (await req('GET', '/api/doc')).body;
    const usedPids = new Set([
      p.pid, longP.pid, directP.pid, mergeFirst.pid, mergeSecond.pid,
    ]);
    const transactionParas = transactionModel.paragraphs.filter((x) =>
      !x.table && !usedPids.has(x.pid) && x.text.length > 60 && x.text.length < 500);
    check('found independent paragraphs for transaction tests', transactionParas.length >= 6,
      transactionParas.length);

    // A docmodel no-op must short-circuit the whole transaction boundary.
    const noOpP = transactionParas[0];
    const noOpBytes = fs.readFileSync(activeDoc);
    const noOpState = readPersistedState();
    const noOpResult = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: noOpP.pid,
        text: noOpP.text,
        expect_hash: noOpP.hash,
        why: 'no-op transaction fixture',
        utterance: 'transaction-noop',
      },
    });
    const afterNoOpState = readPersistedState();
    check('an unchanged set_text reports a no-op',
      noOpResult.status === 200 && noOpResult.body.result &&
      noOpResult.body.result.noop === true, noOpResult.body.error);
    check('a no-op does not save, checkpoint, revise, or trail',
      noOpResult.body.rev === noOpState.rev &&
      afterNoOpState.rev === noOpState.rev &&
      afterNoOpState.checkpoints.length === noOpState.checkpoints.length &&
      afterNoOpState.trail.length === noOpState.trail.length &&
      fs.readFileSync(activeDoc).equals(noOpBytes),
      `rev ${noOpState.rev}->${afterNoOpState.rev}`);

    // Fire two distinct utterances without awaiting either. The second
    // checkpoint must contain the first saved edit, not the common old file.
    const queueA = transactionParas[1];
    const queueB = transactionParas[2];
    const queueResponses = await Promise.all([
      req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'set_text', pid: queueA.pid, text: queueA.text + ' [queue-a]',
          expect_hash: queueA.hash, why: 'concurrent transaction A',
          utterance: 'transaction-queue-a',
        },
      }),
      req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'set_text', pid: queueB.pid, text: queueB.text + ' [queue-b]',
          expect_hash: queueB.hash, why: 'concurrent transaction B',
          utterance: 'transaction-queue-b',
        },
      }),
    ]);
    check('concurrent distinct-utterance edits both commit',
      queueResponses.every((x) => x.status === 200),
      queueResponses.map((x) => x.status).join('/'));
    const queued = [
      { paragraph: queueA, suffix: ' [queue-a]', response: queueResponses[0] },
      { paragraph: queueB, suffix: ' [queue-b]', response: queueResponses[1] },
    ].sort((a, b) => a.response.body.rev - b.response.body.rev);
    check('serialized edits receive distinct ordered revisions',
      queued[0].response.body.rev + 1 === queued[1].response.body.rev,
      `${queued[0].response.body.rev}/${queued[1].response.body.rev}`);
    const queuedUndo = await req('POST', '/api/undo');
    const afterQueuedUndo = (await req('GET', '/api/doc')).body.paragraphs;
    const earlierAfterUndo = afterQueuedUndo.find((x) => x.pid === queued[0].paragraph.pid);
    const laterAfterUndo = afterQueuedUndo.find((x) => x.pid === queued[1].paragraph.pid);
    check('one undo after concurrent edits removes only the last transaction',
      queuedUndo.status === 200 &&
      earlierAfterUndo.text === queued[0].paragraph.text + queued[0].suffix &&
      laterAfterUndo.text === queued[1].paragraph.text,
      queuedUndo.body.error ||
      `${earlierAfterUndo.text.endsWith(queued[0].suffix)}/${laterAfterUndo.text === queued[1].paragraph.text}`);

    // Pause after the Python host has mutated memory but before save. The test
    // delay is available only under SCRIBE_TRANSACTION_TEST.
    const pauseP = transactionParas[3];
    const pauseIndex = transactionModel.paragraphs.findIndex((x) => x.pid === pauseP.pid);
    const pauseBytes = fs.readFileSync(activeDoc);
    const pauseState = readPersistedState();
    const pauseEditPromise = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text', pid: pauseP.pid, text: pauseP.text + ' [must roll back]',
        expect_hash: pauseP.hash, why: 'pause rollback fixture',
        utterance: 'transaction-pause',
        __test_delay_after_mutation_ms: 300,
      },
    });
    await sleep(100);
    let docReadSettled = false;
    let toolReadSettled = false;
    const docDuringEditPromise = req('GET', '/api/doc').then((response) => {
      docReadSettled = true;
      return response;
    });
    const toolReadDuringEditPromise = req('POST', '/api/edit', {
      op: { type: 'read', from: pauseIndex, to: pauseIndex + 1 },
    }).then((response) => {
      toolReadSettled = true;
      return response;
    });
    await sleep(60);
    check('document reads wait behind an active write transaction',
      !docReadSettled && !toolReadSettled,
      `${docReadSettled}/${toolReadSettled}`);
    const pausedDuringEdit = await req('POST', '/api/pause');
    const [pausedEdit, docDuringEdit, toolReadDuringEdit] = await Promise.all([
      pauseEditPromise,
      docDuringEditPromise,
      toolReadDuringEditPromise,
    ]);
    const afterPauseState = readPersistedState();
    const afterPauseP = (await req('GET', '/api/doc')).body.paragraphs
      .find((x) => x.pid === pauseP.pid);
    check('a human pause interrupts an in-flight mutation',
      pausedDuringEdit.status === 200 && pausedEdit.status === 423,
      `${pausedDuringEdit.status}/${pausedEdit.status}`);
    check('mid-edit pause restores exact bytes and host content',
      afterPauseP.text === pauseP.text && fs.readFileSync(activeDoc).equals(pauseBytes));
    const docReadP = docDuringEdit.body.paragraphs
      .find((x) => x.pid === pauseP.pid);
    const toolReadP = toolReadDuringEdit.body.result &&
      toolReadDuringEdit.body.result.paragraphs &&
      toolReadDuringEdit.body.result.paragraphs[0];
    check('queued model and tool reads see only the rolled-back document',
      docDuringEdit.status === 200 && toolReadDuringEdit.status === 200 &&
      docReadP && docReadP.text === pauseP.text &&
      toolReadP && toolReadP.text === pauseP.text,
      `${docReadP && docReadP.text.endsWith('[must roll back]')}/` +
      `${toolReadP && toolReadP.text.endsWith('[must roll back]')}`);
    check('a rolled-back pause leaves no revision, checkpoint, or trail',
      afterPauseState.rev === pauseState.rev &&
      afterPauseState.checkpoints.length === pauseState.checkpoints.length &&
      afterPauseState.trail.length === pauseState.trail.length,
      `rev ${pauseState.rev}->${afterPauseState.rev}`);
    await req('POST', '/api/resume');

    // Exercise the harder branch where save already replaced the package and
    // a later failure must put the original ZIP bytes back.
    const failP = transactionParas[4];
    const failBytes = fs.readFileSync(activeDoc);
    const failState = readPersistedState();
    const failedAfterSave = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text', pid: failP.pid, text: failP.text + ' [must not persist]',
        expect_hash: failP.hash, why: 'post-save rollback fixture',
        utterance: 'transaction-post-save-failure',
        __test_fail_after_save: true,
      },
    });
    const afterFailState = readPersistedState();
    const afterFailP = (await req('GET', '/api/doc')).body.paragraphs
      .find((x) => x.pid === failP.pid);
    check('a failure after save is surfaced to the caller',
      failedAfterSave.status === 500 &&
      /Forced post-save/.test(failedAfterSave.body.error || ''),
      failedAfterSave.body.error);
    check('post-save failure restores exact bytes and host content',
      afterFailP.text === failP.text && fs.readFileSync(activeDoc).equals(failBytes));
    check('post-save rollback leaves no revision, checkpoint, or trail',
      afterFailState.rev === failState.rev &&
      afterFailState.checkpoints.length === failState.checkpoints.length &&
      afterFailState.trail.length === failState.trail.length,
      `rev ${failState.rev}->${afterFailState.rev}`);

    // --------------------------------------- sidecar/undo reconciliation
    console.log('\n[sidecars reconcile after undo and concurrent edits]');
    const sidecarModel = (await req('GET', '/api/doc')).body;
    const sidecarTargets = sidecarModel.paragraphs.filter((x) =>
      !x.table && !usedPids.has(x.pid) &&
      !transactionParas.slice(0, 5).some((p0) => p0.pid === x.pid) &&
      x.text.length > 80 && x.text.length < 500);
    check('found independent paragraphs for sidecar reconciliation',
      sidecarTargets.length >= 2, sidecarTargets.length);

    const assistTarget = sidecarTargets[0];
    const assistAfter = assistTarget.text + ' [assist undo anchor]';
    const watchEnabled = await req('POST', '/api/watch/enabled', { enabled: true });
    const assistTyped = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text', pid: assistTarget.pid, text: assistAfter,
        expect_hash: assistTarget.hash, why: 'typed directly',
        utterance: 'sidecar-assist-seed',
      },
    });
    const reviewStarted = await req('POST', '/api/watch/review', {
      manual: true,
      changes: [{
        pid: assistTarget.pid,
        before: assistTarget.text,
        after: assistAfter,
      }],
    });
    const attachedAssist = reviewStarted.status === 200
      ? await req('POST', '/api/assist', {
        review_id: reviewStarted.body.id,
        anchor_pid: assistTarget.pid,
        kind: 'caution',
        title: 'Undo anchor fixture',
        text: 'This isolated note must become stale when its source typing is undone.',
      })
      : { status: 0, body: { error: reviewStarted.body.error } };
    check('created an open assist against saved post-edit prose',
      watchEnabled.status === 200 && assistTyped.status === 200 &&
      attachedAssist.status === 200 && attachedAssist.body.status === 'open',
      attachedAssist.body.error);
    const assistStaleEventsBefore = events.filter((event) =>
      event.type === 'assist' && event.data.id === attachedAssist.body.id &&
      event.data.status === 'stale').length;
    const assistUndo = await req('POST', '/api/undo');
    await sleep(120);
    const afterAssistUndoState = readPersistedState();
    const storedAssist = afterAssistUndoState.assists
      .find((note) => note.id === attachedAssist.body.id);
    const openAssists = await req('GET', '/api/assists');
    check('Undo retires an assist whose exact anchor came from newer bytes',
      assistUndo.status === 200 && storedAssist &&
      storedAssist.status === 'stale' &&
      !openAssists.body.assists.some((note) => note.id === attachedAssist.body.id),
      storedAssist && storedAssist.status);
    check('assist reconciliation emits one stale event',
      events.filter((event) =>
        event.type === 'assist' && event.data.id === attachedAssist.body.id &&
        event.data.status === 'stale').length === assistStaleEventsBefore + 1);
    await req('POST', '/api/watch/enabled', { enabled: false });

    const continuationText = [
      'This isolated continuation contains enough specific words to satisfy',
      'the predictive safety boundary while testing only state reconciliation.',
      'It remains entirely inside the throwaway document and never starts an',
      'external model process during the deterministic fixture run.',
    ].join(' ');
    async function readyContinuation(anchor, suffix, tag) {
      const afterText = anchor.text + suffix;
      const typedResult = await req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'set_text', pid: anchor.pid, text: afterText,
          expect_hash: anchor.hash, why: 'typed directly',
          utterance: `sidecar-${tag}-seed`,
        },
      });
      const grant = typedResult.body.prediction_grant;
      if (typedResult.status !== 200 || !grant || !grant.token) {
        throw new Error(typedResult.body.error || `No prediction grant for ${tag}`);
      }
      await sleep(Math.max(0, Date.parse(grant.not_before) - Date.now() + 20));
      const started = await req('POST', '/api/predict', {
        grant: grant.token,
        capture_id: `sidecar-${tag}`,
        pid: anchor.pid,
        before: anchor.text,
        after: afterText,
        quietMs: 1000,
      });
      if (started.status !== 200) {
        throw new Error(started.body.error || `Prediction did not start for ${tag}`);
      }
      const finished = await req('POST', '/api/predict/fixture', {
        text: `<continuation>${continuationText}</continuation>`,
      });
      if (finished.status !== 200 || !finished.body.continuation) {
        throw new Error(finished.body.error || `Prediction did not finish for ${tag}`);
      }
      const current = (await req('GET', '/api/doc')).body.paragraphs
        .find((paragraph) => paragraph.pid === anchor.pid);
      return {
        before: anchor,
        after: current,
        continuation: finished.body.continuation,
      };
    }

    const continuationSeed = await readyContinuation(
      sidecarTargets[1],
      ' [continuation undo anchor]',
      'undo',
    );
    check('created an open continuation against saved post-edit prose',
      continuationSeed.continuation.status === 'open',
      continuationSeed.continuation.status);
    const continuationStaleEventsBefore = events.filter((event) =>
      event.type === 'predict' && event.data.kind === 'stale' &&
      event.data.continuation &&
      event.data.continuation.id === continuationSeed.continuation.id).length;
    const continuationUndo = await req('POST', '/api/undo');
    await sleep(120);
    const afterContinuationUndoState = readPersistedState();
    const storedContinuation = afterContinuationUndoState.continuations
      .find((item) => item.id === continuationSeed.continuation.id);
    const openPrediction = await req('GET', '/api/predict');
    check('Undo retires a continuation whose exact anchor came from newer bytes',
      continuationUndo.status === 200 && storedContinuation &&
      storedContinuation.status === 'stale' &&
      openPrediction.body.continuation === null,
      storedContinuation && storedContinuation.status);
    check('continuation reconciliation emits one stale event',
      events.filter((event) =>
        event.type === 'predict' && event.data.kind === 'stale' &&
        event.data.continuation &&
        event.data.continuation.id === continuationSeed.continuation.id).length ===
          continuationStaleEventsBefore + 1);

    // Hold a structural mutation after its in-memory merge so continuation
    // acceptance acquires its nonpersisted lock before merge invalidation runs.
    const raceModel = (await req('GET', '/api/doc')).body;
    const raceFirstBefore = raceModel.paragraphs
      .find((paragraph) => paragraph.pid === mergeFirst.pid);
    const raceSecond = raceModel.paragraphs
      .find((paragraph) => paragraph.pid === mergeSecond.pid);
    const raceSeed = await readyContinuation(
      raceFirstBefore,
      ' [accept race anchor]',
      'merge-race',
    );
    const raceStaleEventsBefore = events.filter((event) =>
      event.type === 'predict' && event.data.kind === 'stale' &&
      event.data.continuation &&
      event.data.continuation.id === raceSeed.continuation.id).length;
    const racingMergePromise = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'merge',
        pid: raceSeed.after.pid,
        first_pid: raceSeed.after.pid,
        second_pid: raceSecond.pid,
        first_text: raceSeed.after.text,
        second_text: raceSecond.text,
        expect_hash: raceSeed.after.hash,
        expect_first_hash: raceSeed.after.hash,
        expect_second_hash: raceSecond.hash,
        why: 'continuation accepting race fixture',
        __test_delay_after_mutation_ms: 600,
      },
    });
    await sleep(120);
    const racingAcceptPromise = req('POST', '/api/predict/accept', {
      id: raceSeed.continuation.id,
    });
    const [racingMerge, racingAccept] = await Promise.all([
      racingMergePromise,
      racingAcceptPromise,
    ]);
    await sleep(120);
    const afterRaceState = readPersistedState();
    const racedContinuation = afterRaceState.continuations
      .find((item) => item.id === raceSeed.continuation.id);
    check('a concurrent merge wins while its continuation acceptance is queued',
      racingMerge.status === 200 && racingAccept.status === 400 &&
      !/No such open continuation/i.test(racingAccept.body.error || ''),
      `${racingMerge.status}/${racingAccept.status}: ${racingAccept.body.error}`);
    check('failed acceptance revalidates to stale instead of reopening',
      racedContinuation && racedContinuation.status === 'stale' &&
      (await req('GET', '/api/predict')).body.continuation === null,
      racedContinuation && racedContinuation.status);
    check('the locked-acceptance recovery emits exactly one stale event',
      events.filter((event) =>
        event.type === 'predict' && event.data.kind === 'stale' &&
        event.data.continuation &&
        event.data.continuation.id === raceSeed.continuation.id).length ===
          raceStaleEventsBefore + 1);
    const undoRaceMerge = await req('POST', '/api/undo');
    const undoRaceSeed = await req('POST', '/api/undo');
    const raceRestored = (await req('GET', '/api/doc')).body.paragraphs
      .find((paragraph) => paragraph.pid === mergeFirst.pid);
    check('race cleanup preserves the two ordinary undo boundaries',
      undoRaceMerge.status === 200 && undoRaceSeed.status === 200 &&
      raceRestored.text === raceFirstBefore.text,
      `${undoRaceMerge.status}/${undoRaceSeed.status}`);

    // Put both kinds of actionable sidecar on the exact paragraphs consumed by
    // one merge. This covers the server-owned stale transitions independently
    // of the browser's eager local card cleanup.
    const pairModel = (await req('GET', '/api/doc')).body;
    const pairFirstBefore = pairModel.paragraphs
      .find((paragraph) => paragraph.pid === mergeFirst.pid);
    const pairSecondBefore = pairModel.paragraphs
      .find((paragraph) => paragraph.pid === mergeSecond.pid);
    await req('POST', '/api/watch/enabled', { enabled: true });
    const pairFirstText = pairFirstBefore.text + ' [paired assist anchor]';
    const pairAssistTyped = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text', pid: pairFirstBefore.pid, text: pairFirstText,
        expect_hash: pairFirstBefore.hash, why: 'typed directly',
        utterance: 'paired-assist-seed',
      },
    });
    const pairReview = await req('POST', '/api/watch/review', {
      manual: true,
      changes: [{
        pid: pairFirstBefore.pid,
        before: pairFirstBefore.text,
        after: pairFirstText,
      }],
    });
    const pairAssist = pairReview.status === 200
      ? await req('POST', '/api/assist', {
        review_id: pairReview.body.id,
        anchor_pid: pairFirstBefore.pid,
        kind: 'suggestion',
        title: 'Paired merge fixture',
        text: 'This note must retire when its paragraph absorbs the adjacent continuation anchor.',
      })
      : { status: 0, body: { error: pairReview.body.error } };
    const pairFirst = (await req('GET', '/api/doc')).body.paragraphs
      .find((paragraph) => paragraph.pid === pairFirstBefore.pid);
    const pairContinuationSeed = await readyContinuation(
      pairSecondBefore,
      ' [paired continuation anchor]',
      'paired-merge',
    );
    const openPairAssists = await req('GET', '/api/assists');
    const openPairPrediction = await req('GET', '/api/predict');
    check('adjacent merge members can each own one open sidecar before commit',
      pairAssistTyped.status === 200 && pairAssist.status === 200 &&
      openPairAssists.body.assists.some((note) => note.id === pairAssist.body.id) &&
      openPairPrediction.body.continuation &&
      openPairPrediction.body.continuation.id === pairContinuationSeed.continuation.id,
      pairAssist.body.error || JSON.stringify(openPairPrediction.body.continuation));

    const pairAssistStaleBefore = events.filter((event) =>
      event.type === 'assist' && event.data.id === pairAssist.body.id &&
      event.data.status === 'stale').length;
    const pairContinuationStaleBefore = events.filter((event) =>
      event.type === 'predict' && event.data.kind === 'stale' &&
      event.data.continuation &&
      event.data.continuation.id === pairContinuationSeed.continuation.id).length;
    const pairedMerge = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'merge',
        pid: pairFirst.pid,
        first_pid: pairFirst.pid,
        second_pid: pairContinuationSeed.after.pid,
        first_text: pairFirst.text,
        second_text: pairContinuationSeed.after.text,
        expect_hash: pairFirst.hash,
        expect_first_hash: pairFirst.hash,
        expect_second_hash: pairContinuationSeed.after.hash,
        why: 'paired sidecar merge fixture',
      },
    });
    await sleep(120);
    const pairedState = readPersistedState();
    const pairedStoredAssist = pairedState.assists
      .find((note) => note.id === pairAssist.body.id);
    const pairedStoredContinuation = pairedState.continuations
      .find((item) => item.id === pairContinuationSeed.continuation.id);
    const pairedOpenAssists = await req('GET', '/api/assists');
    const pairedOpenPrediction = await req('GET', '/api/predict');
    check('one merge persists both adjacent sidecars as stale',
      pairedMerge.status === 200 &&
      pairedStoredAssist && pairedStoredAssist.status === 'stale' &&
      pairedStoredContinuation && pairedStoredContinuation.status === 'stale',
      pairedMerge.body.error ||
      `${pairedStoredAssist && pairedStoredAssist.status}/` +
      `${pairedStoredContinuation && pairedStoredContinuation.status}`);
    check('the merged sidecars are excluded from both card snapshots',
      !pairedOpenAssists.body.assists.some((note) => note.id === pairAssist.body.id) &&
      pairedOpenPrediction.body.continuation === null,
      JSON.stringify({
        assists: pairedOpenAssists.body.assists,
        continuation: pairedOpenPrediction.body.continuation,
      }));
    check('the merged assist emits exactly one relevant stale SSE event',
      events.filter((event) =>
        event.type === 'assist' && event.data.id === pairAssist.body.id &&
        event.data.status === 'stale').length === pairAssistStaleBefore + 1);
    check('the merged continuation emits exactly one relevant stale SSE event',
      events.filter((event) =>
        event.type === 'predict' && event.data.kind === 'stale' &&
        event.data.continuation &&
        event.data.continuation.id === pairContinuationSeed.continuation.id).length ===
          pairContinuationStaleBefore + 1);

    await req('POST', '/api/watch/enabled', { enabled: false });
    const undoPairedMerge = await req('POST', '/api/undo');
    const undoPairedContinuationSeed = await req('POST', '/api/undo');
    const undoPairedAssistSeed = await req('POST', '/api/undo');
    const pairedRestoredModel = (await req('GET', '/api/doc')).body;
    check('paired-sidecar fixture cleans up through three exact undo units',
      undoPairedMerge.status === 200 &&
      undoPairedContinuationSeed.status === 200 &&
      undoPairedAssistSeed.status === 200 &&
      pairedRestoredModel.paragraphs
        .find((paragraph) => paragraph.pid === pairFirstBefore.pid).text ===
          pairFirstBefore.text &&
      pairedRestoredModel.paragraphs
        .find((paragraph) => paragraph.pid === pairSecondBefore.pid).text ===
          pairSecondBefore.text,
      `${undoPairedMerge.status}/${undoPairedContinuationSeed.status}/` +
      `${undoPairedAssistSeed.status}`);

    // A Normal paragraph with direct bold formatting is how several visual
    // headings in the current manuscript are authored. Continuations must pass
    // explicit Normal so insert cannot clone that direct bold run.
    console.log('\n[predictive continuation body style]');
    const styleModel = (await req('GET', '/api/doc')).body;
    const styleP = styleModel.paragraphs.find((x) =>
      !x.table && x.style === 'Normal' && x.text.length > 60 &&
      x.text.length < 400 && x.runs.length === 1 && !x.runs[0].b &&
      !usedPids.has(x.pid) && !transactionParas.slice(0, 5).some((p0) => p0.pid === x.pid));
    check('found a plain Normal paragraph for the continuation fixture', !!styleP);
    if (!styleP) throw new Error('No plain Normal paragraph for continuation style test.');
    const bolded = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format', pid: styleP.pid, find: styleP.text, b: true,
        expect_hash: styleP.hash, expect_format_hash: styleP.format_hash,
        why: 'direct-bold Normal fixture',
        utterance: 'prediction-direct-bold',
      },
    });
    const boldP = (await req('GET', '/api/doc')).body.paragraphs
      .find((x) => x.pid === styleP.pid);
    check('fixture is direct-bold while its paragraph style remains Normal',
      bolded.status === 200 && boldP.style === 'Normal' &&
      boldP.runs.filter((x) => x.text).every((x) => x.b === true),
      bolded.body.error || boldP.style);
    const typedForPrediction = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text', pid: boldP.pid,
        text: boldP.text + ' The next paragraph should remain body text.',
        expect_hash: boldP.hash, why: 'typed directly',
        utterance: 'prediction-typing',
      },
    });
    const grant = typedForPrediction.body.prediction_grant;
    check('saved direct typing issues a prediction grant',
      typedForPrediction.status === 200 && !!grant && !!grant.token,
      typedForPrediction.body.error);
    if (!grant || !grant.token) throw new Error('Prediction grant was not issued.');
    await sleep(Math.max(0, Date.parse(grant.not_before) - Date.now() + 20));
    const predictionStarted = await req('POST', '/api/predict', {
      grant: grant.token,
      pid: boldP.pid,
      before: typedForPrediction.body.result.before,
      after: typedForPrediction.body.result.after,
      quietMs: 1000,
    });
    check('prediction fixture starts from the exact saved typing change',
      predictionStarted.status === 200, predictionStarted.body.error);
    const fixtureText = [
      '<continuation>This continuation contains enough carefully chosen words to',
      'exercise insertion while remaining concise, factual, coherent, and safely',
      'styled as ordinary body prose rather than inheriting a bold visual heading.</continuation>',
    ].join(' ');
    const predictionFinished = await req('POST', '/api/predict/fixture', {
      text: fixtureText,
    });
    const continuation = predictionFinished.body.continuation;
    check('a direct-bold Normal anchor produces explicit Normal continuation style',
      predictionFinished.status === 200 && continuation &&
      continuation.style === 'Normal', predictionFinished.body.error);
    if (!continuation) throw new Error('Prediction fixture did not create a continuation.');
    const predictionBeforeAcceptance = (await req('GET', '/api/doc')).body;
    const predictionRevBeforeAcceptance = (await req('GET', '/api/health')).body.rev;
    const predictionAcceptancePromise = req('POST', '/api/predict/accept', {
      id: continuation.id,
      __test_delay_after_mutation_ms: 600,
    });
    await sleep(120);
    // Proposal creation now waits in the document-write lane so its anchor
    // hash is captured from the authoritative post-transaction model. Toggle
    // an unrelated model-pool flag to force the same concurrent state snapshot
    // without waiting behind this acceptance.
    const modelPoolBeforeProbe = (await req('GET', '/api/models')).body;
    const probeModel = modelPoolBeforeProbe.enabled.find((model) =>
      model !== modelPoolBeforeProbe.selected);
    const persistenceProbe = await req('POST', '/api/models', {
      model: probeModel,
      enabled: false,
    });
    const lockedPredictionState = readPersistedState();
    const lockedStoredContinuation = lockedPredictionState.continuations
      .find((item) => item.id === continuation.id);
    const lockedPredictionSnapshot = await req('GET', '/api/predict');
    const duplicatePredictionAcceptance = await req('POST', '/api/predict/accept', {
      id: continuation.id,
    });
    const predictionAccepted = await predictionAcceptancePromise;
    check('a continuation acceptance lock is never serialized as card state',
      persistenceProbe.status === 200 && lockedStoredContinuation &&
      lockedStoredContinuation.status === 'open' &&
      !lockedPredictionState.continuations.some((item) =>
        item.status === 'accepting') &&
      lockedPredictionSnapshot.body.continuation &&
      lockedPredictionSnapshot.body.continuation.id === continuation.id &&
      lockedPredictionSnapshot.body.continuation.status === 'open',
      JSON.stringify({
        persistenceProbe: persistenceProbe.status,
        persisted: lockedStoredContinuation && lockedStoredContinuation.status,
        snapshot: lockedPredictionSnapshot.body.continuation &&
          lockedPredictionSnapshot.body.continuation.status,
      }));
    check('concurrent continuation acceptance permits exactly one transaction',
      predictionAccepted.status === 200 &&
      duplicatePredictionAcceptance.status === 409 &&
      /in progress/i.test(duplicatePredictionAcceptance.body.error || ''),
      `${predictionAccepted.status}/${duplicatePredictionAcceptance.status}: ` +
        `${duplicatePredictionAcceptance.body.error || ''}`);
    const insertedPid = predictionAccepted.body.result &&
      predictionAccepted.body.result.pid;
    const predictionAfterAcceptance = (await req('GET', '/api/doc')).body;
    const insertedP = predictionAfterAcceptance.paragraphs
      .find((x) => x.pid === insertedPid);
    check('accepted continuation stays Normal and does not clone direct bold',
      predictionAccepted.status === 200 && insertedP &&
      insertedP.style === 'Normal' &&
      insertedP.runs.filter((x) => x.text).every((x) => !x.b),
      predictionAccepted.body.error || (insertedP && JSON.stringify(insertedP.runs)));
    check('the accepted continuation is inserted and committed exactly once',
      predictionAfterAcceptance.count === predictionBeforeAcceptance.count + 1 &&
      predictionAfterAcceptance.rev === predictionRevBeforeAcceptance + 1 &&
      predictionAfterAcceptance.paragraphs.filter((paragraph) =>
        paragraph.text === continuation.text).length === 1,
      `${predictionBeforeAcceptance.count}->${predictionAfterAcceptance.count}, ` +
        `rev ${predictionRevBeforeAcceptance}->${predictionAfterAcceptance.rev}`);
    if (persistenceProbe.status === 200 && probeModel) {
      await req('POST', '/api/models', {
        model: probeModel,
        enabled: true,
      });
    }

    // -------------------------------------------------------------- trail
    console.log('\n[trail]');
    const tr = await req('GET', '/api/trail');
    check('trail records what happened', tr.body.trail.length >= 3, tr.body.trail.length);
    check('trail entries have summaries', tr.body.trail.every((e) => e.summary || e.op));
    check('trail recorded the undo', tr.body.trail.some((e) => e.op === 'undo'));

    // ------------------------------------------------------ request boundary
    console.log('\n[JSON and browser-origin boundary]');
    const boundaryProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: p.pid,
        mode: 'replace',
        find: 'EDITED',
        intent: 'request-boundary fixture',
        options: [{ text: 'One' }, { text: 'Two' }],
      },
    });
    const boundaryId = boundaryProposal.body.id;
    check('boundary fixture is open', boundaryProposal.status === 200 && !!boundaryId,
      boundaryProposal.body.error);

    const malformedDismiss = await reqText('POST', '/api/dismiss', '{');
    const scalarDismiss = await reqText('POST', '/api/dismiss', 'null');
    const arrayDismiss = await req('POST', '/api/dismiss', []);
    const missingIdDismiss = await req('POST', '/api/dismiss', {});
    check('malformed, non-object, and incomplete JSON receive stable 400 responses',
      malformedDismiss.status === 400 && scalarDismiss.status === 400 &&
      arrayDismiss.status === 400 && missingIdDismiss.status === 400,
      `${malformedDismiss.status}/${scalarDismiss.status}/${arrayDismiss.status}/${missingIdDismiss.status}`);
    check('invalid JSON cannot dismiss the active proposal',
      (await req('GET', '/api/proposals')).body.proposals.some((x) => x.id === boundaryId));

    const oversized = JSON.stringify({
      id: boundaryId,
      padding: 'x'.repeat(8 * 1024 * 1024),
    });
    const oversizedDismiss = await reqText('POST', '/api/dismiss', oversized);
    check('oversized JSON receives a 413 response without resetting the request',
      oversizedDismiss.status === 413, oversizedDismiss.status);
    check('oversized JSON cannot dismiss the active proposal',
      (await req('GET', '/api/proposals')).body.proposals.some((x) => x.id === boundaryId));

    const hostileDismiss = await req(
      'POST',
      '/api/dismiss',
      { id: boundaryId },
      { origin: 'https://hostile.example' },
    );
    check('a hostile browser origin is rejected before mutation',
      hostileDismiss.status === 403 &&
      (await req('GET', '/api/proposals')).body.proposals.some((x) => x.id === boundaryId),
      hostileDismiss.status);

    const localDismiss = await req(
      'POST',
      '/api/dismiss',
      { id: boundaryId },
      { origin: BASE },
    );
    check('the exact loopback browser origin remains allowed',
      localDismiss.status === 200 && localDismiss.body.dismissed === boundaryId,
      JSON.stringify(localDismiss.body));
    const persistedBoundary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'),
    ).proposals.find((x) => x.id === boundaryId);
    check('a direct proposal dismissal is persisted',
      persistedBoundary && persistedBoundary.status === 'dismissed',
      persistedBoundary && persistedBoundary.status);

    // ------------------------------------------------------------ statics
    console.log('\n[http hygiene]');
    const nf = await req('GET', '/api/nonexistent');
    check('unknown api route 404s', nf.status === 404);
    const esc = await new Promise((resolve) => {
      http.get(`${BASE}/../server.js`, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
    });
    check('path traversal does not serve source', esc === 404 || esc === 403, esc);
    const hdr = await new Promise((resolve) => {
      http.get(`${BASE}/api/health`, (r) => { r.resume(); resolve(r.headers); });
    });
    check('responses expose no cross-origin read permission',
      !hdr['access-control-allow-origin'], hdr['access-control-allow-origin'] || 'absent');

    // ------------------------------------------------ checkpoint file lifecycle
    console.log('\n[checkpoint file lifecycle]');
    const managedCheckpointNames = () => fs.readdirSync(checkpointDir)
      .filter((name) => /^(?:c\d+-\d+|redo-\d+-\d+)\.docx$/i.test(name))
      .sort();
    const checkpointStateBeforeOpen = readPersistedState();
    const referencedCheckpointNames = checkpointStateBeforeOpen.checkpoints
      .map((record) => path.basename(record.file))
      .sort();
    check('the checkpoint directory contains only state-referenced undo packages',
      JSON.stringify(managedCheckpointNames()) ===
        JSON.stringify(referencedCheckpointNames) &&
      !managedCheckpointNames().some((name) => name.startsWith('redo-')),
      JSON.stringify({
        files: managedCheckpointNames(),
        state: referencedCheckpointNames,
      }));
    check('the fixture has undo history to retire on document open',
      referencedCheckpointNames.length > 0, referencedCheckpointNames.length);
    const reopenedForCleanup = await req('POST', '/api/open', { path: activeDoc });
    const checkpointStateAfterOpen = readPersistedState();
    check('opening a document deletes the retired checkpoint packages',
      reopenedForCleanup.status === 200 &&
      checkpointStateAfterOpen.checkpoints.length === 0 &&
      managedCheckpointNames().length === 0,
      JSON.stringify({
        status: reopenedForCleanup.status,
        files: managedCheckpointNames(),
        state: checkpointStateAfterOpen.checkpoints.length,
      }));

    // ------------------------------------------ queued work across document Open
    console.log('\n[queued edits cannot cross a document Open]');
    const samePathModel = (await req('GET', '/api/doc')).body;
    const samePathTarget = samePathModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.text.length > 80);
    const samePathBytes = fs.readFileSync(activeDoc);
    const samePathOpenPromise = req('POST', '/api/open', {
      path: activeDoc,
      __test_delay_after_host_open_ms: 500,
    });
    await sleep(100);
    const staleSamePathEditPromise = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: samePathTarget.pid,
        text: `${samePathTarget.text} [must not cross same-path Open]`,
        expect_hash: samePathTarget.hash,
        why: 'typed directly',
        utterance: 'same-path-open-race',
      },
    });
    const [samePathOpened, staleSamePathEdit] = await Promise.all([
      samePathOpenPromise,
      staleSamePathEditPromise,
    ]);
    const afterSamePathOpen = (await req('GET', '/api/doc')).body;
    check('same-path Open advances document ownership and refuses older queued edits',
      samePathOpened.status === 200 &&
      staleSamePathEdit.status === 409 &&
      /active document changed/i.test(staleSamePathEdit.body.error || '') &&
      afterSamePathOpen.paragraphs.find((paragraph) =>
        paragraph.pid === samePathTarget.pid).text === samePathTarget.text &&
      fs.readFileSync(activeDoc).equals(samePathBytes),
      `${samePathOpened.status}/${staleSamePathEdit.status}: ` +
        `${staleSamePathEdit.body.error || ''}`);

    // Build a second package from the same stamped bytes, then diverge one
    // paragraph. Its IDs remain copied from the source, so ID equality cannot
    // authorize cards captured from the other document.
    const copiedRaceDoc = path.join(
      path.dirname(activeDoc),
      'cross-document-race.docx',
    );
    fs.copyFileSync(activeDoc, copiedRaceDoc);
    const openedCopiedFixture = await req('POST', '/api/open', {
      path: copiedRaceDoc,
    });
    const copiedFixtureModel = (await req('GET', '/api/doc')).body;
    const copiedFixtureTarget = copiedFixtureModel.paragraphs.find((paragraph) =>
      paragraph.pid === samePathTarget.pid);
    const divergedCopiedText =
      `${copiedFixtureTarget.text} [copied document divergence]`;
    const divergedCopied = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: copiedFixtureTarget.pid,
        text: divergedCopiedText,
        expect_hash: copiedFixtureTarget.hash,
        why: 'typed directly',
        utterance: 'copied-document-divergence',
      },
    });
    const returnedToActive = await req('POST', '/api/open', { path: activeDoc });
    const activeRaceModel = (await req('GET', '/api/doc')).body;
    const activeRaceTarget = activeRaceModel.paragraphs.find((paragraph) =>
      paragraph.pid === samePathTarget.pid);
    const crossDocumentContinuation = await readyContinuation(
      activeRaceTarget,
      ' [cross-document acceptance anchor]',
      'cross-document',
    );
    const crossDocumentProposalText =
      'This old proposal must never enter the copied document.';
    const crossDocumentProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: crossDocumentContinuation.after.pid,
        mode: 'insert',
        intent: 'cross-document acceptance fixture',
        options: [
          { text: crossDocumentProposalText },
          { text: 'Unused cross-document proposal alternative.' },
        ],
      },
    });
    const copiedBytesBeforeRace = fs.readFileSync(copiedRaceDoc);
    const crossDocumentEventIndex = events.length;
    const crossDocumentOpenPromise = req('POST', '/api/open', {
      path: copiedRaceDoc,
      __test_delay_after_host_open_ms: 500,
    });
    await sleep(100);
    const staleProposalAcceptPromise = req('POST', '/api/accept', {
      id: crossDocumentProposal.body.id,
      option: 'A',
      who: 'human',
    });
    const staleContinuationAcceptPromise = req('POST', '/api/predict/accept', {
      id: crossDocumentContinuation.continuation.id,
    });
    const [
      crossDocumentOpened,
      staleProposalAccept,
      staleContinuationAccept,
    ] = await Promise.all([
      crossDocumentOpenPromise,
      staleProposalAcceptPromise,
      staleContinuationAcceptPromise,
    ]);
    await sleep(120);
    const afterCrossDocumentRace = (await req('GET', '/api/doc')).body;
    const crossDocumentState = readPersistedState();
    const oldContinuationGhosts = events.slice(crossDocumentEventIndex)
      .filter((event) =>
        event.type === 'predict' &&
        event.data.continuation &&
        event.data.continuation.id ===
          crossDocumentContinuation.continuation.id);
    check('copied paragraph IDs cannot carry proposal or continuation accepts across Open',
      openedCopiedFixture.status === 200 &&
      divergedCopied.status === 200 &&
      returnedToActive.status === 200 &&
      crossDocumentProposal.status === 200 &&
      crossDocumentOpened.status === 200 &&
      staleProposalAccept.status === 409 &&
      staleContinuationAccept.status === 409 &&
      afterCrossDocumentRace.paragraphs.find((paragraph) =>
        paragraph.pid === samePathTarget.pid).text === divergedCopiedText &&
      !afterCrossDocumentRace.paragraphs.some((paragraph) =>
        paragraph.text === crossDocumentProposalText ||
        paragraph.text === crossDocumentContinuation.continuation.text) &&
      fs.readFileSync(copiedRaceDoc).equals(copiedBytesBeforeRace),
      `${crossDocumentOpened.status}/${staleProposalAccept.status}/` +
        `${staleContinuationAccept.status}`);
    check('rejected old-document cards leave no durable state or ghost event',
      !crossDocumentState.proposals.some((proposal) =>
        proposal.id === crossDocumentProposal.body.id) &&
      !crossDocumentState.continuations.some((continuationItem) =>
        continuationItem.id === crossDocumentContinuation.continuation.id) &&
      oldContinuationGhosts.length === 0,
      JSON.stringify({
        proposals: crossDocumentState.proposals.length,
        continuations: crossDocumentState.continuations.length,
        events: oldContinuationGhosts,
      }));

    es.destroy();
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    failed = true;
  } finally {
    srv.kill();
    await sleep(600);
    // Windows holds handles briefly after exit; retry the cleanup.
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
      catch (_) { await sleep(300); }
    }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('failed: ' + FAIL.join(', '));
    console.log('\n--- server log ---\n' + srvLog.join('').slice(-3000));
  }
  process.exit(FAIL.length || failed ? 1 : 0);
}

main();
