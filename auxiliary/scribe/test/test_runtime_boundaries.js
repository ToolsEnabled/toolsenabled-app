#!/usr/bin/env node
'use strict';

/**
 * Deterministic runtime-boundary integration tests.
 *
 * Every server gets its own OS-temp data/public tree and port. The only source
 * document is copied into that tree before use; live Scribe state is never
 * opened or written.
 *
 * Run: node test/test_runtime_boundaries.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const FIXTURE = requiredLiveFile('SCRIBE_TEST_DOCX');
const LEGACY_FIXTURE = requiredLiveFile('SCRIBE_TEST_LEGACY_DOCX');
const PASS = [];
const FAIL = [];
const SKIP = [];
const OWNED_SERVERS = new Map();
const packageSha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function check(name, condition, detail) {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}` +
    (detail === undefined ? '' : `  ${detail}`));
}

function skip(name, detail) {
  SKIP.push(name);
  console.log(`  skip ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listenPort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function bodyResult(text) {
  try { return JSON.parse(text || '{}'); } catch (_) { return text; }
}

function request(base, method, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    if (options.json !== undefined) payload = Buffer.from(JSON.stringify(options.json));
    else if (options.body !== undefined) payload = Buffer.from(options.body);

    const headers = { ...(options.headers || {}) };
    if (options.json !== undefined) headers['content-type'] = 'application/json';
    if (payload && options.contentLength !== false &&
        headers['content-length'] === undefined) {
      headers['content-length'] = String(payload.length);
    }

    const req = http.request(new URL(requestPath, base), {
      method,
      headers,
      agent: options.agent,
    }, (res) => {
      let text = '';
      const socket = res.socket
        ? `${res.socket.localAddress}:${res.socket.localPort}`
        : null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: bodyResult(text),
        socket,
        reusedSocket: req.reusedSocket,
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (Array.isArray(options.chunks)) {
      for (const chunk of options.chunks) req.write(chunk);
    } else if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function readHello(base, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value, req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (res) res.destroy(); } catch (_) {}
      try { if (req) req.destroy(); } catch (_) {}
      if (error) reject(error);
      else resolve(value);
    };
    let response = null;
    const req = http.get(new URL('/api/events', base), (res) => {
      response = res;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const match = /^event: hello\ndata: (.*)$/s.exec(frame);
          if (!match) continue;
          try {
            finish(null, JSON.parse(match[1]), req, res);
          } catch (error) {
            finish(error, null, req, res);
          }
          return;
        }
      });
      res.on('error', (error) => finish(error, null, req, res));
    });
    req.on('error', (error) => finish(error, null, req, response));
    const timer = setTimeout(() => {
      finish(new Error('timed out waiting for SSE hello'), null, req, response);
    }, timeoutMs);
  });
}

function openEventCollector(base, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const frames = [];
    let buffer = '';
    let settled = false;
    let response = null;
    const req = http.get(new URL('/api/events', base), (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const match = /^event: ([^\n]+)/m.exec(frame);
          if (!match) continue;
          events.push(match[1]);
          const dataMatch = /^data: (.*)$/m.exec(frame);
          frames.push({
            event: match[1],
            data: dataMatch ? bodyResult(dataMatch[1]) : null,
          });
          if (!settled && match[1] === 'hello') {
            settled = true;
            clearTimeout(timer);
            resolve({
              events,
              frames,
              close() {
                try { res.destroy(); } catch (_) {}
                try { req.destroy(); } catch (_) {}
              },
            });
          }
        }
      });
      res.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (response) response.destroy(); } catch (_) {}
      try { req.destroy(); } catch (_) {}
      reject(new Error('timed out opening event collector'));
    }, timeoutMs);
  });
}

async function waitForServer(base, predicate = () => true, tries = 100) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const owned = OWNED_SERVERS.get(base);
    if (owned && (owned.exitCode !== null || owned.signalCode !== null)) {
      throw new Error(
        `isolated server PID ${owned.pid} exited before expected health ` +
        `(code=${owned.exitCode}, signal=${owned.signalCode})`
      );
    }
    try {
      last = await request(base, 'GET', '/api/health');
      if (last.status === 200 && owned &&
          (!last.body || last.body.serverPid !== owned.pid)) {
        throw new Error(
          `port ownership mismatch: spawned PID ${owned.pid}, ` +
          `health reported ${last.body && last.body.serverPid}`
        );
      }
      if (last.status === 200 && predicate(last.body)) return last.body;
    } catch (error) {
      if (/port ownership mismatch/.test(String(error && error.message))) throw error;
    }
    await sleep(50);
  }
  throw new Error(`server did not reach expected health: ${JSON.stringify(last)}`);
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`server pid ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function startServer(root, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = await listenPort(host);
  const data = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(data, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'checkpoints'), { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    fs.writeFileSync(path.join(publicDir, 'index.html'), 'runtime fixture');
  }

  const log = [];
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_DATA: data,
      SCRIBE_PUBLIC: publicDir,
      SCRIBE_PORT: String(port),
      SCRIBE_HOST: host,
      SCRIBE_RUNTIME_TEST: '1',
      SCRIBE_RUNTIME_BODY_LIMIT: '4096',
      // The real 333-paragraph model response is larger than a tiny unit-test
      // frame, so keep the fixture realistic while still making the hostile
      // allocation inexpensive.
      SCRIBE_RUNTIME_HOST_FRAME_LIMIT: String(2 * 1024 * 1024),
      ...(options.python ? { SCRIBE_PYTHON: options.python } : {}),
      ...(options.env || {}),
    },
  });
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const server = {
    child,
    data,
    publicDir,
    base: `http://${urlHost}:${port}`,
    log,
  };
  OWNED_SERVERS.set(server.base, child);
  return server;
}

async function gracefulStop(server) {
  if (!server || server.child.exitCode !== null) return;
  try {
    await request(server.base, 'POST', '/api/__runtime/shutdown');
    await waitForExit(server.child);
  } catch (_) {
    try { server.child.kill(); } catch (_) {}
    try { await waitForExit(server.child, 2000); } catch (_) {}
  } finally {
    OWNED_SERVERS.delete(server.base);
  }
}

function createDirLink(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

async function testUnavailableRestoredDocument(suiteRoot, servers) {
  console.log('\n[restored document disappears before listen-time reopen]');
  const root = path.join(suiteRoot, 'unavailable-restored-document');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });

  const restoredDoc = path.join(documents, 'restored-then-removed.docx');
  const retiredCheckpoint = path.join(
    checkpoints,
    'c17-1700000000000.docx',
  );
  const unrelatedArchive = path.join(checkpoints, 'manual-archive.docx');
  fs.copyFileSync(FIXTURE, restoredDoc);
  fs.copyFileSync(FIXTURE, retiredCheckpoint);
  fs.copyFileSync(FIXTURE, unrelatedArchive);
  const restoredFingerprint = packageSha256(restoredDoc);
  const unrelatedArchiveBytes = fs.readFileSync(unrelatedArchive);
  const anchorHash = '0123456789ab';
  const seededState = {
    paused: false,
    docPath: fs.realpathSync(restoredDoc),
    docFingerprint: restoredFingerprint,
    rev: 17,
    checkpoints: [{
      id: 'restore-disappearance-checkpoint',
      label: 'must retire only after empty state is durable',
      file: fs.realpathSync(retiredCheckpoint),
      at: new Date(0).toISOString(),
      rev: 16,
    }],
    trail: [{
      id: 'restore-disappearance-trail',
      op: 'said',
      who: 'human',
      summary: 'must not survive without its document',
      at: new Date(0).toISOString(),
    }],
    proposals: [{
      id: 'p17',
      anchor_pid: 'RESTORE1',
      anchor_hash: anchorHash,
      mode: 'insert',
      find: null,
      intent: 'must not remain actionable without its document',
      options: [
        { id: 'A', text: 'Restored option A.', note: '' },
        { id: 'B', text: 'Restored option B.', note: '' },
      ],
      grounding: [],
      status: 'open',
      at: new Date(0).toISOString(),
    }],
    assists: [{
      id: 'a17',
      review_id: 'w17',
      anchor_pid: 'RESTORE1',
      anchor_hash: anchorHash,
      kind: 'caution',
      title: 'Restored assist',
      text: 'Must not attach to a missing document.',
      status: 'open',
      at: new Date(0).toISOString(),
    }],
    continuations: [{
      id: 'n17',
      capture_id: 'restore-disappearance-capture',
      anchor_pid: 'RESTORE1',
      anchor_hash: anchorHash,
      text: 'This continuation must not attach to a missing document.',
      model: 'sonnet',
      provider: 'claude',
      style: 'Normal',
      status: 'open',
      at: new Date(0).toISOString(),
    }],
    model: 'sonnet',
    enabledModels: ['sonnet', 'opus', 'terra', 'sol'],
  };
  const stateFile = path.join(data, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(seededState));

  const server = await startServer(root, {
    env: { SCRIBE_TEST_REMOVE_RESTORED_BEFORE_REOPEN: '1' },
  });
  servers.push(server);
  const health = await waitForServer(
    server.base,
    (value) =>
      value.ok === true &&
      value.docPath === null &&
      value.document_token === null &&
      value.rev === 0,
  );
  const [
    trail,
    proposals,
    assists,
    prediction,
    agent,
    document,
    hello,
  ] = await Promise.all([
    request(server.base, 'GET', '/api/trail'),
    request(server.base, 'GET', '/api/proposals'),
    request(server.base, 'GET', '/api/assists'),
    request(server.base, 'GET', '/api/predict'),
    request(server.base, 'GET', '/api/agent'),
    request(server.base, 'GET', '/api/doc'),
    readHello(server.base),
  ]);
  const durableState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await sleep(50);

  check('listen-time disappearance retires active document ownership',
    !fs.existsSync(restoredDoc) &&
    health.docPath === null &&
    health.document_token === null &&
    health.rev === 0 &&
    health.documentOwnership && health.documentOwnership.ok === true &&
    health.durability && health.durability.ok === true &&
    server.log.join('').includes('discarded unavailable restored document'),
    JSON.stringify({
      docPath: health.docPath,
      token: health.document_token,
      rev: health.rev,
      log: server.log.join('').slice(-160),
    }));
  check('every HTTP document-bound snapshot is empty after disappearance',
    trail.status === 200 && trail.body.trail.length === 0 &&
    proposals.status === 200 &&
    proposals.body.document_token === null &&
    proposals.body.proposals.length === 0 &&
    assists.status === 200 &&
    assists.body.document_token === null &&
    assists.body.assists.length === 0 &&
    prediction.status === 200 &&
    prediction.body.document_token === null &&
    prediction.body.active === null &&
    prediction.body.continuation === null &&
    agent.status === 200 &&
    agent.body.document_token === null &&
    agent.body.running === false &&
    document.status === 400 &&
    /no document/i.test(document.body.error || ''),
    JSON.stringify({
      trail: trail.body.trail,
      proposals: proposals.body.proposals,
      assists: assists.body.assists,
      activePrediction: prediction.body.active,
      continuation: prediction.body.continuation,
      document: document.status,
    }));
  check('the SSE recovery snapshot cannot resurrect disappeared-document state',
    hello.health &&
    hello.health.docPath === null &&
    hello.health.document_token === null &&
    hello.health.rev === 0 &&
    hello.trail.length === 0 &&
    hello.proposals.length === 0 &&
    hello.assists.length === 0 &&
    hello.continuations.length === 0 &&
    hello.assist === null &&
    hello.continuation === null,
    JSON.stringify({
      health: hello.health,
      trail: hello.trail.length,
      proposals: hello.proposals.length,
      assists: hello.assists.length,
      continuations: hello.continuations.length,
    }));
  check('empty document ownership is durably persisted before checkpoint retirement',
    durableState.docPath === null &&
    durableState.docFingerprint === null &&
    durableState.rev === 0 &&
    durableState.checkpoints.length === 0 &&
    durableState.trail.length === 0 &&
    durableState.proposals.length === 0 &&
    durableState.assists.length === 0 &&
    durableState.continuations.length === 0 &&
    !fs.existsSync(retiredCheckpoint),
    JSON.stringify({
      docPath: durableState.docPath,
      rev: durableState.rev,
      checkpoints: durableState.checkpoints.length,
      retiredCheckpoint: fs.existsSync(retiredCheckpoint),
    }));
  check('retiring restored ownership never deletes an unrelated checkpoint archive',
    fs.existsSync(unrelatedArchive) &&
    fs.readFileSync(unrelatedArchive).equals(unrelatedArchiveBytes),
    unrelatedArchive);

  await gracefulStop(server);
}

async function testManagedPathsStaticBodies(suiteRoot, servers) {
  console.log('\n[managed paths, static containment, and bounded bodies]');

  // A valid restored document must not make an arbitrary persisted checkpoint
  // path trusted. Undo deletes its consumed checkpoint, so accepting an
  // outside path here would turn a crafted state file into external deletion.
  const checkpointRoot = path.join(suiteRoot, 'restored-checkpoint');
  const checkpointData = path.join(checkpointRoot, 'data');
  const checkpointDocuments = path.join(checkpointData, 'documents');
  fs.mkdirSync(checkpointDocuments, { recursive: true });
  fs.mkdirSync(path.join(checkpointData, 'checkpoints'), { recursive: true });
  const restoredDoc = path.join(checkpointDocuments, 'restored.docx');
  const outsideCheckpoint = path.join(checkpointRoot, 'outside-checkpoint.docx');
  fs.copyFileSync(FIXTURE, restoredDoc);
  fs.copyFileSync(FIXTURE, outsideCheckpoint);
  const outsideCheckpointBytes = fs.readFileSync(outsideCheckpoint);
  fs.writeFileSync(path.join(checkpointData, 'state.json'), JSON.stringify({
    paused: false,
    docPath: restoredDoc,
    docFingerprint: packageSha256(restoredDoc),
    rev: 7,
    checkpoints: [{
      id: 'hostile-checkpoint',
      label: 'must be discarded',
      file: outsideCheckpoint,
      at: new Date(0).toISOString(),
      rev: 6,
    }],
    trail: [],
    proposals: [{
      id: 'p41',
      anchor_pid: 'legacy-anchor',
      mode: 'insert',
      find: null,
      intent: 'must not remain actionable after restart',
      options: [
        { id: 'A', text: 'Legacy option A.', note: '' },
        { id: 'B', text: 'Legacy option B.', note: '' },
      ],
      grounding: [],
      status: 'open',
      at: new Date(0).toISOString(),
    }],
    assists: [],
    continuations: [],
    model: 'sonnet',
    enabledModels: ['sonnet', 'opus', 'terra', 'sol'],
  }));
  const checkpointServer = await startServer(checkpointRoot);
  servers.push(checkpointServer);
  const checkpointHealth = await waitForServer(
    checkpointServer.base,
    (value) => value.ok === true && value.docPath === fs.realpathSync(restoredDoc),
  );
  const checkpointState = JSON.parse(
    fs.readFileSync(path.join(checkpointData, 'state.json'), 'utf8'),
  );
  check('restore retains a valid managed document while discarding an outside checkpoint',
    checkpointHealth.rev === 7 && checkpointState.checkpoints.length === 0,
    checkpointState.checkpoints.length);
  check('restore retires legacy open proposals that have no anchor hash',
    checkpointState.proposals.some((proposal) =>
      proposal.id === 'p41' &&
      proposal.status === 'stale') &&
    !(await request(checkpointServer.base, 'GET', '/api/proposals'))
      .body.proposals.some((proposal) =>
        proposal.id === 'p41'));
  const checkpointModel = await request(
    checkpointServer.base,
    'GET',
    '/api/doc',
  );
  const checkpointAnchor = checkpointModel.body.paragraphs.find((paragraph) =>
    typeof paragraph.text === 'string' && paragraph.text);
  const postRestoreProposal = await request(
    checkpointServer.base,
    'POST',
    '/api/propose',
    {
      json: {
        proposal: {
          anchor_pid: checkpointAnchor.pid,
          anchor_hash: checkpointAnchor.hash,
          mode: 'insert',
          intent: 'post-restore proposal sequence fixture',
          options: [
            { text: 'Post-restore option A.' },
            { text: 'Post-restore option B.' },
          ],
        },
      },
    },
  );
  check('restored proposal ids cannot collide with newly created cards',
    postRestoreProposal.status === 200 &&
    postRestoreProposal.body.id === 'p42',
    postRestoreProposal.body.id || postRestoreProposal.body.error);
  check('discarding a hostile restored checkpoint never touches the outside file',
    fs.existsSync(outsideCheckpoint) &&
    fs.readFileSync(outsideCheckpoint).equals(outsideCheckpointBytes));
  await gracefulStop(checkpointServer);

  const root = path.join(suiteRoot, 'normal');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const publicDir = path.join(root, 'public');
  const outsideDocs = path.join(root, 'outside-documents');
  const outsideStatic = path.join(root, 'outside-static');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(path.join(data, 'checkpoints'), { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(outsideDocs, { recursive: true });
  fs.mkdirSync(outsideStatic, { recursive: true });

  const insideDoc = path.join(documents, 'inside.docx');
  const outsideDoc = path.join(outsideDocs, 'outside.docx');
  const hardLinkedDoc = path.join(documents, 'hard-linked.docx');
  fs.copyFileSync(FIXTURE, insideDoc);
  fs.copyFileSync(FIXTURE, outsideDoc);
  let hardLink = false;
  try {
    fs.linkSync(outsideDoc, hardLinkedDoc);
    hardLink = true;
  } catch (error) {
    skip('hard-linked document fixture', error.code || error.message);
  }
  fs.mkdirSync(path.join(documents, 'directory.docx'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), 'runtime index');
  fs.writeFileSync(path.join(publicDir, 'safe.txt'), 'safe static');
  fs.writeFileSync(path.join(outsideStatic, 'secret.txt'), 'must not escape');

  // Seed hostile restored state before boot. The server must sanitize it
  // without ever asking the document host to open the outside file.
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    paused: false,
    docPath: outsideDoc,
    rev: 99,
    checkpoints: [],
    trail: [],
    proposals: [],
    assists: [],
    continuations: [],
    model: 'sonnet',
    enabledModels: ['sonnet', 'opus', 'terra', 'sol'],
  }));

  let documentLink = false;
  let staticLink = false;
  try {
    createDirLink(outsideDocs, path.join(documents, 'escape'));
    documentLink = true;
  } catch (error) {
    skip('document junction escape fixture', error.code || error.message);
  }
  try {
    createDirLink(outsideStatic, path.join(publicDir, 'escape'));
    staticLink = true;
  } catch (error) {
    skip('static junction escape fixture', error.code || error.message);
  }

  let host = '::1';
  try {
    await listenPort(host);
  } catch (error) {
    host = '127.0.0.1';
    skip('IPv6 loopback request URL', error.code || error.message);
  }

  const server = await startServer(root, { host });
  servers.push(server);
  const health = await waitForServer(server.base, (value) => value.ok === true);
  check('server constructs and serves its configured loopback URL',
    health.ok === true && health.port > 0, `${host}:${health.port}`);
  if (host === '::1') {
    check('IPv6 host survives request URL construction', health.ok === true);
  }
  check('unmanaged restored document path is discarded',
    health.docPath === null, health.docPath);
  const sanitized = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  check('discarded restored path is removed from persisted state',
    sanitized.docPath === null, sanitized.docPath);

  const outsideOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: outsideDoc },
  });
  check('/api/open rejects a regular docx outside managed documents',
    outsideOpen.status === 400, outsideOpen.body.error);
  const directoryOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: path.join(documents, 'directory.docx') },
  });
  check('/api/open rejects a directory whose name ends in .docx',
    directoryOpen.status === 400, directoryOpen.body.error);
  if (hardLink) {
    const hardLinkOpen = await request(server.base, 'POST', '/api/open', {
      json: { path: hardLinkedDoc },
    });
    check('/api/open rejects hard-linked documents that alias outside content',
      hardLinkOpen.status === 400, hardLinkOpen.body.error);
  }
  if (documentLink) {
    const escapedOpen = await request(server.base, 'POST', '/api/open', {
      json: { path: path.join(documents, 'escape', 'outside.docx') },
    });
    check('/api/open rejects a junction whose real path escapes documents',
      escapedOpen.status === 400, escapedOpen.body.error);
  }

  const insideOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: insideDoc },
  });
  check('/api/open accepts an existing regular managed docx',
    insideOpen.status === 200 && insideOpen.body.count > 0,
    insideOpen.body.error || insideOpen.body.count);
  const persisted = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  check('active document is persisted as its canonical managed path',
    persisted.docPath === fs.realpathSync(insideDoc), persisted.docPath);

  // Create while no event stream is connected, then reconnect. The hello
  // frame is the authoritative recovery snapshot for missed proposal events.
  const model = await request(server.base, 'GET', '/api/doc');
  const anchor = model.body.paragraphs.find((paragraph) => paragraph.text);
  const disconnectedProposal = await request(server.base, 'POST', '/api/propose', {
    json: {
      proposal: {
        anchor_pid: anchor.pid,
        mode: 'insert',
        intent: 'disconnected proposal fixture',
        options: [{ text: 'First recovery option.' }, { text: 'Second recovery option.' }],
      },
    },
  });
  const firstHello = await readHello(server.base);
  check('SSE hello reconciles proposals created while disconnected',
    disconnectedProposal.status === 200 &&
    firstHello.proposals.some((proposal) =>
      proposal.id === disconnectedProposal.body.id && proposal.status === 'open'),
    disconnectedProposal.body.id);
  check('SSE hello exposes complete plural assist and continuation snapshots',
    Array.isArray(firstHello.assists) && Array.isArray(firstHello.continuations) &&
    Number.isSafeInteger(firstHello.sse_seq), firstHello.sse_seq);
  await request(server.base, 'POST', '/api/dismiss', {
    json: { id: disconnectedProposal.body.id },
  });
  const secondHello = await readHello(server.base);
  check('reconnect snapshots are monotonic and remove closed proposals',
    secondHello.sse_seq > firstHello.sse_seq &&
    !secondHello.proposals.some((proposal) =>
      proposal.id === disconnectedProposal.body.id),
    `${firstHello.sse_seq}->${secondHello.sse_seq}`);

  const beforeRestart = await request(server.base, 'GET', '/api/health');
  const oldHostPid = beforeRestart.body.dochost.pid;
  const restart = await request(server.base, 'POST', '/api/__runtime/restart-host');
  const recovered = await waitForServer(
    server.base,
    (value) => value.ok === true && value.dochost &&
      value.dochost.pid !== oldHostPid && value.dochost.recovering === false,
  );
  const recoveredModel = await request(server.base, 'GET', '/api/doc');
  check('document host restart recovers the managed document and truthful health',
    restart.status === 202 && recovered.ok === true &&
    recoveredModel.status === 200 && recoveredModel.body.paragraphs.length > 0,
    `${oldHostPid}->${recovered.dochost.pid}`);

  for (const [kind, label] of [
    ['json', 'malformed JSON'],
    ['oversized', 'an oversized unterminated frame'],
    ['oversized-tail', 'a valid frame followed by an oversized tail'],
  ]) {
    const beforeCorruption = await request(server.base, 'GET', '/api/health');
    const corruptPid = beforeCorruption.body.dochost.pid;
    const corruption = await request(
      server.base,
      'POST',
      `/api/__runtime/corrupt-host?kind=${kind}`,
    );
    const afterCorruption = await waitForServer(
      server.base,
      (value) => value.ok === true && value.dochost &&
        value.dochost.pid !== corruptPid && value.dochost.recovering === false,
    );
    const modelAfterCorruption = await request(server.base, 'GET', '/api/doc');
    check(`child ${label} is bounded, restarted, and document state is recovered`,
      corruption.status === 202 && afterCorruption.ok === true &&
      modelAfterCorruption.status === 200 &&
      modelAfterCorruption.body.paragraphs.length > 0,
      `${corruptPid}->${afterCorruption.dochost.pid}`);
  }
  check('protocol corruption never escapes into a coordinator fatal handler',
    !/UNCAUGHT|UNHANDLED REJECTION/.test(server.log.join('')),
    server.log.join('').slice(-300));

  const safeStatic = await request(server.base, 'GET', '/safe.txt');
  check('ordinary static files still serve', safeStatic.status === 200 &&
    safeStatic.body === 'safe static', safeStatic.status);
  if (staticLink) {
    const escapedStatic = await request(server.base, 'GET', '/escape/secret.txt');
    check('static serving rejects a junction real-path escape',
      escapedStatic.status === 403, escapedStatic.status);
  }
  const traversal = await request(server.base, 'GET', '/../outside-static/secret.txt');
  check('static traversal never serves a sibling prefix',
    traversal.status !== 200, traversal.status);

  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const tooLarge = Buffer.alloc(5000, 0x61);
  const declaredUpload = await request(server.base, 'POST', '/api/upload', {
    body: tooLarge,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(tooLarge.length),
      'x-scribe-filename': 'large.docx',
    },
    agent: keepAlive,
  });
  check('declared oversized upload returns a stable 413',
    declaredUpload.status === 413, declaredUpload.status);
  const healthAfterUpload = await request(server.base, 'GET', '/api/health', {
    agent: keepAlive,
  });
  check('oversized upload drains and preserves its keep-alive connection',
    healthAfterUpload.status === 200 &&
    (healthAfterUpload.reusedSocket ||
      healthAfterUpload.socket === declaredUpload.socket),
    `${declaredUpload.socket} -> ${healthAfterUpload.socket}`);

  const chunkedUpload = await request(server.base, 'POST', '/api/upload', {
    chunks: [Buffer.alloc(2500), Buffer.alloc(2500)],
    contentLength: false,
    headers: {
      'content-type': 'application/octet-stream',
      'x-scribe-filename': 'chunked.docx',
    },
    agent: keepAlive,
  });
  check('chunked oversized upload returns a stable 413',
    chunkedUpload.status === 413, chunkedUpload.status);

  const declaredStt = await request(server.base, 'POST', '/api/stt', {
    body: tooLarge,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(tooLarge.length),
    },
    agent: keepAlive,
  });
  check('declared oversized STT body returns a stable 413',
    declaredStt.status === 413, declaredStt.status);
  const chunkedStt = await request(server.base, 'POST', '/api/stt', {
    chunks: [Buffer.alloc(2500), Buffer.alloc(2500)],
    contentLength: false,
    headers: { 'content-type': 'application/octet-stream' },
    agent: keepAlive,
  });
  check('chunked oversized STT body returns a stable 413',
    chunkedStt.status === 413, chunkedStt.status);
  const emptyStt = await request(server.base, 'POST', '/api/stt', {
    body: Buffer.alloc(0),
    headers: { 'content-length': '0' },
    agent: keepAlive,
  });
  const shortStt = await request(server.base, 'POST', '/api/stt', {
    body: Buffer.alloc(100),
    agent: keepAlive,
  });
  check('empty and too-short STT bodies are client errors',
    emptyStt.status === 400 && shortStt.status === 400,
    `${emptyStt.status}/${shortStt.status}`);
  keepAlive.destroy();

  const shutdown = await request(server.base, 'POST', '/api/__runtime/shutdown');
  const exited = await waitForExit(server.child);
  check('bounded normal shutdown exits successfully',
    shutdown.status === 202 && exited.code === 0, exited.code);
}

async function testLegacyCheckpointUndo(suiteRoot, servers) {
  console.log('\n[legacy unstamped checkpoint undo]');
  if (!fs.existsSync(LEGACY_FIXTURE)) {
    skip('legacy checkpoint undo fixture', `${LEGACY_FIXTURE} is unavailable`);
    return;
  }

  const root = path.join(suiteRoot, 'legacy-checkpoint-undo');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });

  const active = path.join(documents, 'active.docx');
  const checkpoint = path.join(checkpoints, 'c1-1700000000000.docx');
  fs.copyFileSync(FIXTURE, active);
  fs.copyFileSync(LEGACY_FIXTURE, checkpoint);
  const legacyBytes = fs.readFileSync(checkpoint);
  const leanBytes = fs.readFileSync(active);
  check('legacy Undo fixture is byte-distinct from the active manuscript',
    !legacyBytes.equals(leanBytes), `${legacyBytes.length}/${leanBytes.length}`);

  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    paused: false,
    docPath: active,
    docFingerprint: packageSha256(active),
    rev: 12,
    checkpoints: [{
      id: 'legacy-checkpoint',
      label: 'legacy unstamped manuscript',
      file: checkpoint,
      at: new Date(0).toISOString(),
      rev: 11,
    }],
    trail: [],
    proposals: [],
    assists: [],
    continuations: [],
    model: 'sonnet',
    enabledModels: ['sonnet', 'opus', 'terra', 'sol'],
  }));

  const server = await startServer(root);
  servers.push(server);
  const initialHealth = await waitForServer(
    server.base,
    (value) => value.ok === true &&
      value.docPath === fs.realpathSync(active),
  );
  const initialModel = await request(server.base, 'GET', '/api/doc');
  check('isolated server restores the distinct active manuscript first',
    initialHealth.rev === 12 && initialModel.status === 200 &&
    initialModel.body.count !== 0,
    `${initialHealth.rev}/${initialModel.body.count}`);

  const undo = await request(server.base, 'POST', '/api/undo');
  const normalized = await request(server.base, 'GET', '/api/doc');
  const normalizedIds = normalized.body.paragraphs.map((paragraph) => paragraph.pid);
  const uniqueIds = new Set(normalizedIds);
  check('Undo loads and normalizes the distinct legacy manuscript',
    undo.status === 200 && normalized.status === 200 &&
    normalized.body.stamped > 0 &&
    normalized.body.count !== initialModel.body.count &&
    !fs.readFileSync(active).equals(legacyBytes),
    undo.body.error ||
      `${initialModel.body.count}->${normalized.body.count}, stamped=${normalized.body.stamped}`);
  check('normalized legacy paragraphs all have stable valid identities',
    normalizedIds.length > 0 &&
    uniqueIds.size === normalizedIds.length &&
    normalizedIds.every((pid) => /^[0-9A-F]{8}$/.test(pid)),
    `${uniqueIds.size}/${normalizedIds.length}`);

  const backupPattern = /^active\.scribe-backup-.*\.docx$/i;
  const backupSnapshot = () => fs.readdirSync(documents)
    .filter((name) => backupPattern.test(name))
    .sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(documents, name)) }));
  const backupsAfterUndo = backupSnapshot();
  check('legacy normalization publishes an exact-byte durable sibling backup',
    backupsAfterUndo.some((entry) => entry.bytes.equals(legacyBytes)),
    backupsAfterUndo.map((entry) => entry.name).join(','));

  const generatedCheckpointPattern = /^(?:c\d+-\d+|redo-\d+-\d+)\.docx$/i;
  const generatedAfterUndo = fs.readdirSync(checkpoints)
    .filter((name) => generatedCheckpointPattern.test(name));
  const stateAfterUndo = JSON.parse(
    fs.readFileSync(path.join(data, 'state.json'), 'utf8'),
  );
  check('successful legacy Undo leaves no checkpoint or unreachable redo package',
    generatedAfterUndo.length === 0 &&
    stateAfterUndo.checkpoints.length === 0,
    generatedAfterUndo.join(','));

  const oldHostPid = initialHealth.dochost.pid;
  const restart = await request(
    server.base,
    'POST',
    '/api/__runtime/restart-host',
  );
  const restartedHealth = await waitForServer(
    server.base,
    (value) => value.ok === true && value.dochost &&
      value.dochost.pid !== oldHostPid &&
      value.dochost.recovering === false,
  );
  const restartedModel = await request(server.base, 'GET', '/api/doc');
  const backupsAfterRestart = backupSnapshot();
  const backupsUnchanged =
    backupsAfterRestart.length === backupsAfterUndo.length &&
    backupsAfterRestart.every((entry, index) =>
      entry.name === backupsAfterUndo[index].name &&
      entry.bytes.equals(backupsAfterUndo[index].bytes));
  check('restarting only the isolated document child retains every paragraph id',
    restart.status === 202 &&
    restartedHealth.serverPid === server.child.pid &&
    restartedModel.body.stamped === 0 &&
    JSON.stringify(restartedModel.body.paragraphs.map((paragraph) => paragraph.pid)) ===
      JSON.stringify(normalizedIds),
    `${oldHostPid}->${restartedHealth.dochost.pid}`);
  check('child restart does not manufacture another normalization backup',
    backupsUnchanged,
    `${backupsAfterUndo.length}->${backupsAfterRestart.length}`);

  await gracefulStop(server);
}

async function testStatePersistenceFailures(suiteRoot, servers) {
  console.log('\n[state persistence transactions]');
  const root = path.join(suiteRoot, 'state-persistence');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });
  const active = path.join(documents, 'active.docx');
  const alternate = path.join(documents, 'alternate.docx');
  fs.copyFileSync(FIXTURE, active);
  fs.copyFileSync(FIXTURE, alternate);

  const server = await startServer(root, {
    env: {
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_PREDICT_TEST: '1',
      SCRIBE_PREDICT_GRANT_MIN_MS: '25',
      SCRIBE_TRANSACTION_TEST: '1',
    },
  });
  servers.push(server);
  await waitForServer(server.base, (value) => value.ok === true);
  const opened = await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  check('persistence fixture opens on its isolated child',
    opened.status === 200 && opened.body.path === fs.realpathSync(active),
    opened.body.error || opened.body.path);

  const generatedSnapshot = () => Object.fromEntries(
    fs.readdirSync(checkpoints)
      .filter((name) => /^(?:c\d+-\d+|redo-\d+-\d+)\.docx$/i.test(name))
      .sort()
      .map((name) => [
        name,
        fs.readFileSync(path.join(checkpoints, name)).toString('base64'),
      ]),
  );
  const stateFile = path.join(data, 'state.json');
  const modelBefore = await request(server.base, 'GET', '/api/doc');
  const paragraphBefore = modelBefore.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  const activeBefore = fs.readFileSync(active);
  const stateBefore = fs.readFileSync(stateFile);
  const checkpointsBefore = generatedSnapshot();

  const failedEditEvents = await openEventCollector(server.base);
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedEdit = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: paragraphBefore.pid,
        text: `${paragraphBefore.text} persistence failure marker`,
        expect_hash: paragraphBefore.hash,
        why: 'typed directly',
        utterance: 'state-persist-edit-failure',
      },
    },
  });
  await sleep(25);
  failedEditEvents.close();
  const modelAfterFailedEdit = await request(server.base, 'GET', '/api/doc');
  const healthAfterFailedEdit = await request(server.base, 'GET', '/api/health');
  check('a failed Edit state commit returns unavailable, never success',
    failedEdit.status === 503 && /durably save state/i.test(failedEdit.body.error || ''),
    `${failedEdit.status}/${failedEdit.body.error}`);
  check('failed Edit persistence rolls back exact package bytes and host text',
    fs.readFileSync(active).equals(activeBefore) &&
    modelAfterFailedEdit.body.paragraphs.find((paragraph) =>
      paragraph.pid === paragraphBefore.pid).text === paragraphBefore.text);
  check('failed Edit persistence leaves state and checkpoint history byte-exact',
    fs.readFileSync(stateFile).equals(stateBefore) &&
    JSON.stringify(generatedSnapshot()) === JSON.stringify(checkpointsBefore));
  check('failed Edit persistence emits no phantom trail or edit event',
    !failedEditEvents.events.includes('trail') &&
    !failedEditEvents.events.includes('edit'),
    failedEditEvents.events.join(','));
  check('durability health fails closed after a state write refusal',
    healthAfterFailedEdit.body.ok === false &&
    healthAfterFailedEdit.body.durability &&
    healthAfterFailedEdit.body.durability.ok === false &&
    healthAfterFailedEdit.body.rev === modelBefore.body.rev,
    JSON.stringify(healthAfterFailedEdit.body.durability));

  const editRecovery = await request(
    server.base,
    'POST',
    '/api/__runtime/retry-state-persist',
  );
  check('an exact durable-state retry restores healthy mutation service',
    editRecovery.status === 200 &&
    editRecovery.body.durability &&
    editRecovery.body.durability.ok === true,
    editRecovery.body.error);

  const successfulEdit = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: paragraphBefore.pid,
        text: `${paragraphBefore.text} durable marker`,
        expect_hash: paragraphBefore.hash,
        why: 'typed directly',
        utterance: 'state-persist-success',
      },
    },
  });
  const editedModel = await request(server.base, 'GET', '/api/doc');
  const editedBytes = fs.readFileSync(active);
  const editedState = fs.readFileSync(stateFile);
  const editedCheckpoints = generatedSnapshot();
  check('the recovered server can commit a normal checkpointed Edit',
    successfulEdit.status === 200 &&
    Object.keys(editedCheckpoints).length === 1 &&
    editedModel.body.paragraphs.find((paragraph) =>
      paragraph.pid === paragraphBefore.pid).text.endsWith(' durable marker'),
    successfulEdit.body.error);

  const failedUndoEvents = await openEventCollector(server.base);
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedUndo = await request(server.base, 'POST', '/api/undo');
  await sleep(25);
  failedUndoEvents.close();
  const modelAfterFailedUndo = await request(server.base, 'GET', '/api/doc');
  check('a failed Undo state commit returns unavailable and restores current bytes',
    failedUndo.status === 503 &&
    fs.readFileSync(active).equals(editedBytes) &&
    modelAfterFailedUndo.body.paragraphs.find((paragraph) =>
      paragraph.pid === paragraphBefore.pid).text.endsWith(' durable marker'),
    `${failedUndo.status}/${failedUndo.body.error}`);
  check('failed Undo persistence retains exact state and its consumable checkpoint',
    fs.readFileSync(stateFile).equals(editedState) &&
    JSON.stringify(generatedSnapshot()) === JSON.stringify(editedCheckpoints));
  check('failed Undo persistence emits no phantom trail or document event',
    !failedUndoEvents.events.includes('trail') &&
    !failedUndoEvents.events.includes('document'),
    failedUndoEvents.events.join(','));

  await request(server.base, 'POST', '/api/__runtime/retry-state-persist');
  const predictionGrant = successfulEdit.body.prediction_grant;
  const predictionDelay = predictionGrant
    ? Math.max(0, Date.parse(predictionGrant.not_before) - Date.now() + 10)
    : 0;
  if (predictionDelay) await sleep(predictionDelay);
  const predictionJob = await request(server.base, 'POST', '/api/predict', {
    json: {
      grant: predictionGrant && predictionGrant.token,
      capture_id: 'failed-open-runtime-job',
      pid: paragraphBefore.pid,
      before: paragraphBefore.text,
      after: `${paragraphBefore.text} durable marker`,
      quietMs: 1000,
    },
  });
  const watchConsent = await request(server.base, 'POST', '/api/watch/enabled', {
    json: { enabled: true },
  });
  const watchChange = {
    changes: [{
      pid: paragraphBefore.pid,
      before: paragraphBefore.text,
      after: `${paragraphBefore.text} durable marker`,
    }],
    quietMs: 1000,
  };
  const activeWatchJob = await request(server.base, 'POST', '/api/watch/review', {
    json: watchChange,
  });
  const pendingWatchJob = await request(server.base, 'POST', '/api/watch/review', {
    json: watchChange,
  });
  const predictionBeforeFailedOpen = await request(server.base, 'GET', '/api/predict');
  const watchBeforeFailedOpen = await request(server.base, 'GET', '/api/watch');
  check('failed Open fixture has active prediction plus active and pending Watch jobs',
    predictionJob.status === 200 &&
    watchConsent.status === 200 &&
    activeWatchJob.status === 200 &&
    pendingWatchJob.status === 200 &&
    predictionBeforeFailedOpen.body.active &&
    predictionBeforeFailedOpen.body.active.id === predictionJob.body.id &&
    watchBeforeFailedOpen.body.active &&
    watchBeforeFailedOpen.body.active.id === activeWatchJob.body.id &&
    watchBeforeFailedOpen.body.pending.some((job) => job.id === pendingWatchJob.body.id),
    `${predictionJob.status}/${activeWatchJob.status}/${pendingWatchJob.status}`);

  const alternateBefore = fs.readFileSync(alternate);
  const openStateBefore = fs.readFileSync(stateFile);
  const openCheckpointsBefore = generatedSnapshot();
  const failedOpenEvents = await openEventCollector(server.base);
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: alternate },
  });
  await sleep(25);
  const modelAfterFailedOpen = await request(server.base, 'GET', '/api/doc');
  const predictionAfterFailedOpen = await request(server.base, 'GET', '/api/predict');
  const watchAfterFailedOpen = await request(server.base, 'GET', '/api/watch');
  failedOpenEvents.close();
  check('a failed Open state commit restores both target bytes and the prior host',
    failedOpen.status === 503 &&
    fs.readFileSync(alternate).equals(alternateBefore) &&
    fs.readFileSync(active).equals(editedBytes) &&
    modelAfterFailedOpen.body.path === fs.realpathSync(active) &&
    modelAfterFailedOpen.body.paragraphs.find((paragraph) =>
      paragraph.pid === paragraphBefore.pid).text.endsWith(' durable marker'),
    `${failedOpen.status}/${failedOpen.body.error}`);
  check('failed Open persistence retains prior state and every Undo package',
    fs.readFileSync(stateFile).equals(openStateBefore) &&
    JSON.stringify(generatedSnapshot()) === JSON.stringify(openCheckpointsBefore));
  check('failed Open persistence leaves every runtime job active and queued',
    predictionAfterFailedOpen.body.active &&
    predictionAfterFailedOpen.body.active.id === predictionJob.body.id &&
    watchAfterFailedOpen.body.active &&
    watchAfterFailedOpen.body.active.id === activeWatchJob.body.id &&
    watchAfterFailedOpen.body.pending.some((job) => job.id === pendingWatchJob.body.id),
    JSON.stringify({
      prediction: predictionAfterFailedOpen.body.active,
      watch: watchAfterFailedOpen.body,
    }));
  check('failed Open persistence emits no cancellation, failure, or opened ghost event',
    !failedOpenEvents.events.includes('predict') &&
    !failedOpenEvents.events.includes('watch') &&
    !failedOpenEvents.events.includes('opened'),
    failedOpenEvents.events.join(','));

  await request(server.base, 'POST', '/api/__runtime/retry-state-persist');
  const recoveredUndo = await request(server.base, 'POST', '/api/undo');
  check('the retained checkpoint remains usable after persistence recovery',
    recoveredUndo.status === 200 &&
    fs.readFileSync(active).equals(activeBefore) &&
    Object.keys(generatedSnapshot()).length === 0,
    recoveredUndo.body.error);

  const successfulOpenEvents = await openEventCollector(server.base);
  const successfulAlternateOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: alternate },
  });
  await sleep(25);
  const predictionAfterSuccessfulOpen = await request(server.base, 'GET', '/api/predict');
  const watchAfterSuccessfulOpen = await request(server.base, 'GET', '/api/watch');
  successfulOpenEvents.close();
  const predictionCancelledAfterCommit = successfulOpenEvents.frames.some((frame) =>
    frame.event === 'predict' &&
    frame.data &&
    frame.data.kind === 'cancelled' &&
    frame.data.id === predictionJob.body.id);
  const activeWatchCancelledAfterCommit = successfulOpenEvents.frames.some((frame) =>
    frame.event === 'watch' &&
    frame.data &&
    frame.data.kind === 'cancelled' &&
    frame.data.id === activeWatchJob.body.id);
  const pendingWatchFailedAfterCommit = successfulOpenEvents.frames.some((frame) =>
    frame.event === 'watch' &&
    frame.data &&
    frame.data.kind === 'failed' &&
    frame.data.id === pendingWatchJob.body.id);
  check('successful Open retires runtime jobs only after the durable commit',
    successfulAlternateOpen.status === 200 &&
    successfulOpenEvents.events.includes('opened') &&
    predictionCancelledAfterCommit &&
    activeWatchCancelledAfterCommit &&
    pendingWatchFailedAfterCommit &&
    predictionAfterSuccessfulOpen.body.active === null &&
    watchAfterSuccessfulOpen.body.active === null &&
    watchAfterSuccessfulOpen.body.pending.length === 0,
    successfulOpenEvents.events.join(','));

  const reopenedActive = await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  check('persistence fixture returns to its active document after Open ordering check',
    reopenedActive.status === 200 && reopenedActive.body.path === fs.realpathSync(active),
    reopenedActive.body.error);

  // A failed state commit has to reopen the prior host before returning. If
  // that recovery itself fails, the host may still point at the requested
  // target. Quarantine it: copied packages can otherwise make a wrong-path
  // save indistinguishable by paragraph ids or bytes.
  const quarantineModel = await request(server.base, 'GET', '/api/doc');
  const quarantineParagraph = quarantineModel.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  fs.copyFileSync(active, alternate);
  const quarantineActiveBytes = fs.readFileSync(active);
  const quarantineAlternateBytes = fs.readFileSync(alternate);
  const quarantineStateBytes = fs.readFileSync(stateFile);
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedHostRestoreOpen = await request(server.base, 'POST', '/api/open', {
    json: {
      path: alternate,
      __test_fail_previous_host_reopen: true,
    },
  });
  const quarantinedHealth = await request(server.base, 'GET', '/api/health');
  const quarantinedRead = await request(server.base, 'GET', '/api/doc');
  await request(server.base, 'POST', '/api/__runtime/retry-state-persist');
  const blockedAfterHostRestore = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: quarantineParagraph.pid,
        text: `${quarantineParagraph.text} must not reach the wrong path`,
        expect_hash: quarantineParagraph.hash,
        why: 'wrong-path host quarantine fixture',
        utterance: 'wrong-path-host-quarantine',
      },
    },
  });
  check('a failed prior-host reopen quarantines the document lane and closes the host',
    failedHostRestoreOpen.status === 503 &&
    quarantinedHealth.body.documentOwnership &&
    quarantinedHealth.body.documentOwnership.ok === false &&
    quarantinedHealth.body.documentOwnership.host_restore_failed === true &&
    quarantinedRead.status === 400 &&
    blockedAfterHostRestore.status === 409,
    `${failedHostRestoreOpen.status}/${quarantinedRead.status}/` +
      `${blockedAfterHostRestore.status}`);
  check('host quarantine preserves both copied packages and durable state exactly',
    fs.readFileSync(active).equals(quarantineActiveBytes) &&
    fs.readFileSync(alternate).equals(quarantineAlternateBytes) &&
    fs.readFileSync(stateFile).equals(quarantineStateBytes),
    failedHostRestoreOpen.body.error);
  const recoveredFromHostQuarantine = await request(
    server.base,
    'POST',
    '/api/open',
    { json: { path: active } },
  );
  check('explicit Open is required to recover a quarantined document host',
    recoveredFromHostQuarantine.status === 200 &&
    fs.readFileSync(active).equals(quarantineActiveBytes) &&
    fs.readFileSync(alternate).equals(quarantineAlternateBytes),
    recoveredFromHostQuarantine.body.error);

  const acceptanceModelBefore = await request(server.base, 'GET', '/api/doc');
  const proposal = await request(server.base, 'POST', '/api/propose', {
    json: {
      proposal: {
        anchor_pid: paragraphBefore.pid,
        mode: 'insert',
        intent: 'persistence acceptance fixture',
        options: [
          { text: 'Exactly one accepted persistence fixture paragraph.' },
          { text: 'Unused persistence fixture alternative.' },
        ],
      },
    },
  });
  const acceptanceBytesBefore = fs.readFileSync(active);
  const acceptanceStateBefore = fs.readFileSync(stateFile);
  const acceptanceCheckpointsBefore = generatedSnapshot();
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedAcceptancePromise = request(server.base, 'POST', '/api/accept', {
    json: {
      id: proposal.body.id,
      option: 'A',
      who: 'human',
      __test_delay_after_mutation_ms: 500,
    },
  });
  await sleep(100);
  const lockedAcceptanceState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const blockedConcurrentAcceptance = await request(
    server.base,
    'POST',
    '/api/accept',
    { json: { id: proposal.body.id, option: 'A', who: 'human' } },
  );
  const failedAcceptance = await failedAcceptancePromise;
  check('a proposal acceptance lock remains nonpersisted and refuses a duplicate',
    lockedAcceptanceState.proposals.some((item) =>
      item.id === proposal.body.id && item.status === 'open') &&
    !lockedAcceptanceState.proposals.some((item) =>
      item.status === 'accepting') &&
    blockedConcurrentAcceptance.status === 409 &&
    /in progress/i.test(blockedConcurrentAcceptance.body.error || ''),
    `${blockedConcurrentAcceptance.status}/` +
      `${blockedConcurrentAcceptance.body.error || ''}`);
  const modelAfterFailedAcceptance = await request(server.base, 'GET', '/api/doc');
  check('a failed acceptance commit leaves its card retryable and document untouched',
    failedAcceptance.status === 503 &&
    fs.readFileSync(active).equals(acceptanceBytesBefore) &&
    fs.readFileSync(stateFile).equals(acceptanceStateBefore) &&
    JSON.stringify(generatedSnapshot()) ===
      JSON.stringify(acceptanceCheckpointsBefore) &&
    modelAfterFailedAcceptance.body.count === acceptanceModelBefore.body.count,
    `${failedAcceptance.status}/${failedAcceptance.body.error}`);
  await request(server.base, 'POST', '/api/__runtime/retry-state-persist');
  const acceptedOnce = await request(server.base, 'POST', '/api/accept', {
    json: { id: proposal.body.id, option: 'A', who: 'human' },
  });
  const modelAfterAcceptedOnce = await request(server.base, 'GET', '/api/doc');
  check('retrying a failed acceptance commits its terminal card and text exactly once',
    acceptedOnce.status === 200 &&
    modelAfterAcceptedOnce.body.count === acceptanceModelBefore.body.count + 1 &&
    modelAfterAcceptedOnce.body.paragraphs.filter((paragraph) =>
      paragraph.text === 'Exactly one accepted persistence fixture paragraph.').length === 1,
    acceptedOnce.body.error);
  const acceptanceUndo = await request(server.base, 'POST', '/api/undo');
  check('the one-commit acceptance remains one exact Undo unit',
    acceptanceUndo.status === 200 &&
    fs.readFileSync(active).equals(acceptanceBytesBefore),
    acceptanceUndo.body.error);

  const beforeFailedPause = fs.readFileSync(active);
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedPause = await request(server.base, 'POST', '/api/pause');
  const pausedHealth = await request(server.base, 'GET', '/api/health');
  const blockedWhilePaused = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: paragraphBefore.pid,
        text: `${paragraphBefore.text} must not save`,
        expect_hash: paragraphBefore.hash,
        why: 'typed directly',
      },
    },
  });
  check('Pause remains fail-safe in memory when its durable write fails',
    failedPause.status === 503 && failedPause.body.paused === true &&
    pausedHealth.body.paused === true &&
    pausedHealth.body.durability.ok === false,
    `${failedPause.status}/${JSON.stringify(pausedHealth.body.durability)}`);
  check('the fail-safe Pause gate refuses document writes without touching bytes',
    blockedWhilePaused.status === 423 &&
    fs.readFileSync(active).equals(beforeFailedPause),
    blockedWhilePaused.status);

  const historyBeforePauseRecovery = await request(
    server.base,
    'GET',
    '/api/__runtime/state-persist-history',
  );
  await request(server.base, 'POST', '/api/__runtime/fail-next-state-persist');
  const failedPauseRecovery = await request(
    server.base,
    'POST',
    '/api/__runtime/retry-state-persist',
  );
  const healthAfterFailedPauseRecovery = await request(server.base, 'GET', '/api/health');
  const historyAfterFailedPauseRecovery = await request(
    server.base,
    'GET',
    '/api/__runtime/state-persist-history',
  );
  check('a failed Pause recovery keeps the in-memory safety gate and retry flag armed',
    failedPauseRecovery.status === 503 &&
    healthAfterFailedPauseRecovery.body.paused === true &&
    healthAfterFailedPauseRecovery.body.durability.ok === false &&
    historyAfterFailedPauseRecovery.body.writes.length ===
      historyBeforePauseRecovery.body.writes.length,
    `${failedPauseRecovery.status}/${JSON.stringify(healthAfterFailedPauseRecovery.body)}`);

  const recoveredPause = await request(
    server.base,
    'POST',
    '/api/__runtime/retry-state-persist',
  );
  const historyAfterPauseRecovery = await request(
    server.base,
    'GET',
    '/api/__runtime/state-persist-history',
  );
  const pauseRecoveryWrites = historyAfterPauseRecovery.body.writes.slice(
    historyBeforePauseRecovery.body.writes.length,
  );
  const durablePausedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('Pause recovery commits paused=true exactly once and never writes false first',
    recoveredPause.status === 200 &&
    durablePausedState.paused === true &&
    pauseRecoveryWrites.length === 1 &&
    pauseRecoveryWrites[0].paused === true &&
    pauseRecoveryWrites[0].recovery === true,
    JSON.stringify(pauseRecoveryWrites));

  const resumed = await request(server.base, 'POST', '/api/resume');
  check('Resume first recovers durable Pause state and only then reopens editing',
    resumed.status === 200 && resumed.body.paused === false,
    resumed.body.error);

  await gracefulStop(server);
}

async function testExternalConflictRetiresRuntimes(suiteRoot, servers) {
  console.log('\n[external ownership conflict retires document runtimes]');
  const root = path.join(suiteRoot, 'external-conflict-runtimes');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });
  const active = path.join(documents, 'active.docx');
  const replacement = path.join(documents, 'external-replacement.docx');
  fs.copyFileSync(FIXTURE, active);

  const server = await startServer(root, {
    env: {
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_PREDICT_TEST: '1',
      SCRIBE_PREDICT_GRANT_MIN_MS: '25',
      SCRIBE_TRANSACTION_TEST: '1',
    },
  });
  servers.push(server);
  await waitForServer(server.base, (value) => value.ok === true);
  const firstOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  const baseModel = await request(server.base, 'GET', '/api/doc');
  const candidates = baseModel.body.paragraphs.filter((paragraph) =>
    paragraph.text && paragraph.text.length > 80 && !paragraph.table);
  const anchorBefore = candidates[0];
  const externalTargetBefore = candidates.find((paragraph) =>
    paragraph.pid !== anchorBefore.pid);
  const anchorAfterText =
    `${anchorBefore.text} [ownership-conflict prediction anchor]`;
  const externalTargetAfterText =
    `${externalTargetBefore.text} [external package replacement]`;

  // Copy only after the first managed Open has persisted paragraph ids. The
  // replacement therefore preserves the exact prediction anchor identity.
  fs.copyFileSync(active, replacement);
  const replacementOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: replacement },
  });
  const replacementModel = await request(server.base, 'GET', '/api/doc');
  const replacementAnchor = replacementModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === anchorBefore.pid);
  const replacementTarget = replacementModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === externalTargetBefore.pid);
  const preparedReplacementAnchor = await request(
    server.base,
    'POST',
    '/api/edit',
    {
      json: {
        who: 'human',
        op: {
          type: 'set_text',
          pid: replacementAnchor.pid,
          text: anchorAfterText,
          expect_hash: replacementAnchor.hash,
          expect_document_token: replacementModel.body.document_token,
          why: 'external replacement fixture',
          utterance: 'external-replacement-anchor',
        },
      },
    },
  );
  const replacementAfterAnchor = await request(server.base, 'GET', '/api/doc');
  const currentReplacementTarget =
    replacementAfterAnchor.body.paragraphs.find((paragraph) =>
      paragraph.pid === replacementTarget.pid);
  const preparedReplacementTarget = await request(
    server.base,
    'POST',
    '/api/edit',
    {
      json: {
        who: 'human',
        op: {
          type: 'set_text',
          pid: currentReplacementTarget.pid,
          text: externalTargetAfterText,
          expect_hash: currentReplacementTarget.hash,
          expect_document_token:
            replacementAfterAnchor.body.document_token,
          why: 'external replacement fixture',
          utterance: 'external-replacement-different-paragraph',
        },
      },
    },
  );
  const replacementBytes = fs.readFileSync(replacement);

  const activeOpen = await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  const activeModel = await request(server.base, 'GET', '/api/doc');
  const activeToken = activeModel.body.document_token;
  const activeAnchor = activeModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === anchorBefore.pid);
  const activeExternalTarget = activeModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === externalTargetBefore.pid);
  const typedAnchor = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: activeAnchor.pid,
        text: anchorAfterText,
        expect_hash: activeAnchor.hash,
        expect_document_token: activeToken,
        why: 'typed directly',
        utterance: 'ownership-conflict-prediction-anchor',
      },
    },
  });
  const anchoredModel = await request(server.base, 'GET', '/api/doc');
  const anchoredParagraph = anchoredModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === activeAnchor.pid);
  const conflictProposal = await request(server.base, 'POST', '/api/propose', {
    json: {
      who: 'human',
      expect_document_token: activeToken,
      proposal: {
        anchor_pid: anchoredParagraph.pid,
        anchor_hash: anchoredParagraph.hash,
        mode: 'insert',
        intent: 'must remain unchanged while ownership is conflicted',
        options: [
          { text: 'Ownership conflict option A.' },
          { text: 'Ownership conflict option B.' },
        ],
      },
    },
  });

  const watchEnabled = await request(
    server.base,
    'POST',
    '/api/watch/enabled',
    { json: { enabled: true } },
  );
  const watchChange = {
    expect_document_token: activeToken,
    quietMs: 1000,
    changes: [{
      pid: activeAnchor.pid,
      before: activeAnchor.text,
      after: anchorAfterText,
    }],
  };
  const activeWatch = await request(server.base, 'POST', '/api/watch/review', {
    json: watchChange,
  });
  const pendingWatch = await request(server.base, 'POST', '/api/watch/review', {
    json: watchChange,
  });
  const predictionGrant = typedAnchor.body.prediction_grant;
  const predictionDelay = predictionGrant
    ? Math.max(0, Date.parse(predictionGrant.not_before) - Date.now() + 20)
    : 0;
  if (predictionDelay) await sleep(predictionDelay);
  const prediction = await request(server.base, 'POST', '/api/predict', {
    json: {
      expect_document_token: activeToken,
      grant: predictionGrant && predictionGrant.token,
      capture_id: 'external-conflict-prediction',
      pid: activeAnchor.pid,
      before: activeAnchor.text,
      after: anchorAfterText,
      quietMs: 1000,
    },
  });
  const predictionBeforeConflict = await request(
    server.base,
    'GET',
    '/api/predict',
  );
  const watchBeforeConflict = await request(server.base, 'GET', '/api/watch');
  const agentBeforeConflict = await request(server.base, 'GET', '/api/agent');
  check('conflict fixture has a prediction plus active and pending Watch jobs',
    firstOpen.status === 200 &&
    replacementOpen.status === 200 &&
    preparedReplacementAnchor.status === 200 &&
    preparedReplacementTarget.status === 200 &&
    activeOpen.status === 200 &&
    typedAnchor.status === 200 &&
    conflictProposal.status === 200 &&
    watchEnabled.status === 200 &&
    activeWatch.status === 200 &&
    pendingWatch.status === 200 &&
    prediction.status === 200 &&
    predictionBeforeConflict.body.active &&
    predictionBeforeConflict.body.active.id === prediction.body.id &&
    watchBeforeConflict.body.active &&
    watchBeforeConflict.body.active.id === activeWatch.body.id &&
    watchBeforeConflict.body.pending.some((job) =>
      job.id === pendingWatch.body.id),
    JSON.stringify({
      prediction: predictionBeforeConflict.body.active,
      watch: watchBeforeConflict.body,
    }));

  const stateFile = path.join(data, 'state.json');
  const checkpointSnapshot = () => Object.fromEntries(
    fs.readdirSync(checkpoints)
      .filter((name) => name.endsWith('.docx'))
      .sort()
      .map((name) => [
        name,
        fs.readFileSync(path.join(checkpoints, name)).toString('base64'),
      ]),
  );
  const durableStateBeforeConflict = fs.readFileSync(stateFile);
  const checkpointsBeforeConflict = checkpointSnapshot();
  const trailBeforeConflict = await request(server.base, 'GET', '/api/trail');
  const proposalsBeforeConflict = await request(
    server.base,
    'GET',
    '/api/proposals',
  );
  const activeBytesBeforeConflict = fs.readFileSync(active);
  const conflictEvents = await openEventCollector(server.base);
  const conflictFrameIndex = conflictEvents.frames.length;

  fs.writeFileSync(active, replacementBytes);
  const refusedConflictEdit = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: activeExternalTarget.pid,
        text: `${activeExternalTarget.text} [must not be committed]`,
        expect_hash: activeExternalTarget.hash,
        expect_document_token: activeToken,
        why: 'external ownership conflict trigger',
        utterance: 'external-conflict-trigger',
      },
    },
  });
  const conflictedHealth = await request(server.base, 'GET', '/api/health');
  const latePredictionFixture = await request(
    server.base,
    'POST',
    '/api/predict/fixture',
    {
      json: {
        text: [
          '<continuation>This deliberately late prediction result contains',
          'enough words to be valid, but it belongs to the retired ownership',
          'generation and therefore must never become a continuation card or',
          'produce a ready event after the external package conflict.</continuation>',
        ].join(' '),
      },
    },
  );
  await sleep(80);

  const predictionAfterConflict = await request(
    server.base,
    'GET',
    '/api/predict',
  );
  const watchAfterConflict = await request(server.base, 'GET', '/api/watch');
  const agentAfterConflict = await request(server.base, 'GET', '/api/agent');
  const trailAfterConflict = await request(server.base, 'GET', '/api/trail');
  const proposalsAfterConflict = await request(
    server.base,
    'GET',
    '/api/proposals',
  );
  const reconciledModel = await request(server.base, 'GET', '/api/doc');
  const conflictFrames = conflictEvents.frames.slice(conflictFrameIndex);
  const cancelledPrediction = conflictFrames.some((frame) =>
    frame.event === 'predict' &&
    frame.data &&
    frame.data.kind === 'cancelled' &&
    frame.data.id === prediction.body.id);
  const cancelledActiveWatch = conflictFrames.some((frame) =>
    frame.event === 'watch' &&
    frame.data &&
    frame.data.kind === 'cancelled' &&
    frame.data.id === activeWatch.body.id);
  const failedPendingWatch = conflictFrames.some((frame) =>
    frame.event === 'watch' &&
    frame.data &&
    frame.data.kind === 'failed' &&
    frame.data.id === pendingWatch.body.id);
  const emittedPredictionReady = conflictFrames.some((frame) =>
    frame.event === 'predict' &&
    frame.data &&
    frame.data.kind === 'ready');
  const reconciledAnchor = reconciledModel.body.paragraphs.find((paragraph) =>
    paragraph.pid === activeAnchor.pid);
  const reconciledExternalTarget =
    reconciledModel.body.paragraphs.find((paragraph) =>
      paragraph.pid === activeExternalTarget.pid);

  check('external replacement preserves the prediction anchor but triggers ownership conflict elsewhere',
    !replacementBytes.equals(activeBytesBeforeConflict) &&
    refusedConflictEdit.status === 409 &&
    conflictedHealth.body.documentOwnership &&
    conflictedHealth.body.documentOwnership.ok === false &&
    conflictedHealth.body.document_token !== activeToken &&
    reconciledModel.status === 200 &&
    reconciledAnchor && reconciledAnchor.text === anchorAfterText &&
    reconciledExternalTarget &&
    reconciledExternalTarget.text === externalTargetAfterText,
    `${refusedConflictEdit.status}/${conflictedHealth.body.error}`);
  check('ownership conflict retires prediction and every Watch job',
    cancelledPrediction &&
    cancelledActiveWatch &&
    failedPendingWatch &&
    predictionAfterConflict.body.active === null &&
    predictionAfterConflict.body.runner.running === false &&
    watchAfterConflict.body.active === null &&
    watchAfterConflict.body.pending.length === 0 &&
    watchAfterConflict.body.reviewer.running === false &&
    agentBeforeConflict.body.running === false &&
    agentAfterConflict.body.running === false,
    JSON.stringify({
      prediction: predictionAfterConflict.body,
      watch: watchAfterConflict.body,
      agent: agentAfterConflict.body.running,
      frames: conflictFrames.map((frame) => ({
        event: frame.event,
        kind: frame.data && frame.data.kind,
        id: frame.data && frame.data.id,
      })),
    }));
  check('a late prediction result cannot create a continuation or ready event',
    latePredictionFixture.status === 409 &&
    predictionAfterConflict.body.continuation === null &&
    !emittedPredictionReady &&
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).continuations.length === 0,
    `${latePredictionFixture.status}/${JSON.stringify(
      predictionAfterConflict.body.continuation,
    )}`);
  check('conflict cancellation preserves external bytes and all durable state',
    fs.readFileSync(active).equals(replacementBytes) &&
    fs.readFileSync(stateFile).equals(durableStateBeforeConflict) &&
    JSON.stringify(checkpointSnapshot()) ===
      JSON.stringify(checkpointsBeforeConflict) &&
    JSON.stringify(trailAfterConflict.body) ===
      JSON.stringify(trailBeforeConflict.body) &&
    JSON.stringify(proposalsAfterConflict.body.proposals) ===
      JSON.stringify(proposalsBeforeConflict.body.proposals),
    JSON.stringify({
      bytes: fs.readFileSync(active).equals(replacementBytes),
      state: fs.readFileSync(stateFile).equals(durableStateBeforeConflict),
      checkpoints: JSON.stringify(checkpointSnapshot()) ===
        JSON.stringify(checkpointsBeforeConflict),
    }));

  const sayStateBefore = fs.readFileSync(stateFile);
  const sayTrailBefore = await request(server.base, 'GET', '/api/trail');
  const sayProposalsBefore = await request(server.base, 'GET', '/api/proposals');
  const sayAgentBefore = await request(server.base, 'GET', '/api/agent');
  const sayFrameIndex = conflictEvents.frames.length;
  const refusedSay = await request(server.base, 'POST', '/api/say', {
    json: {
      text: 'none of those',
      expect_document_token: conflictedHealth.body.document_token,
    },
  });
  await sleep(50);
  const sayTrailAfter = await request(server.base, 'GET', '/api/trail');
  const sayProposalsAfter = await request(server.base, 'GET', '/api/proposals');
  const sayAgentAfter = await request(server.base, 'GET', '/api/agent');
  const sayFrames = conflictEvents.frames.slice(sayFrameIndex);
  check('Say with the rotated conflict token is refused before any mutation',
    refusedSay.status === 409 &&
    /outside Scribe|reopen/i.test(refusedSay.body.error || '') &&
    fs.readFileSync(stateFile).equals(sayStateBefore) &&
    JSON.stringify(sayTrailAfter.body) === JSON.stringify(sayTrailBefore.body) &&
    JSON.stringify(sayProposalsAfter.body.proposals) ===
      JSON.stringify(sayProposalsBefore.body.proposals) &&
    sayAgentBefore.body.running === false &&
    sayAgentAfter.body.running === false &&
    !sayFrames.some((frame) =>
      frame.event === 'trail' ||
      frame.event === 'proposal' ||
      frame.event === 'agent'),
    refusedSay.body.error);

  conflictEvents.close();
  await gracefulStop(server);
}

async function testOfflinePackageReplacement(suiteRoot, servers) {
  console.log('\n[offline package ownership recovery]');
  const root = path.join(suiteRoot, 'offline-package-replacement');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });
  const active = path.join(documents, 'active.docx');
  fs.copyFileSync(FIXTURE, active);
  const externalReplacement = fs.readFileSync(active);

  const first = await startServer(root, {
    env: { SCRIBE_TRANSACTION_TEST: '1' },
  });
  servers.push(first);
  await waitForServer(first.base, (value) => value.ok === true);
  await request(first.base, 'POST', '/api/open', { json: { path: active } });
  const ownedModel = await request(first.base, 'GET', '/api/doc');
  const ownedParagraph = ownedModel.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  const seeded = await request(first.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: ownedParagraph.pid,
        text: `${ownedParagraph.text} offline ownership seed`,
        expect_hash: ownedParagraph.hash,
        why: 'typed directly',
        utterance: 'offline-ownership-seed',
      },
    },
  });
  check('offline ownership fixture has a durable edit and Undo checkpoint',
    seeded.status === 200 &&
    JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'))
      .checkpoints.length === 1,
    seeded.body.error);
  await gracefulStop(first);

  fs.writeFileSync(active, externalReplacement);
  const externalBytes = fs.readFileSync(active);
  const durableState = fs.readFileSync(path.join(data, 'state.json'));
  const checkpointSnapshot = () => Object.fromEntries(
    fs.readdirSync(checkpoints)
      .filter((name) => name.endsWith('.docx'))
      .sort()
      .map((name) => [
        name,
        fs.readFileSync(path.join(checkpoints, name)).toString('base64'),
      ]),
  );
  const durableCheckpoints = checkpointSnapshot();

  const restarted = await startServer(root, {
    env: { SCRIBE_TRANSACTION_TEST: '1' },
  });
  servers.push(restarted);
  const conflictedHealth = await waitForServer(
    restarted.base,
    (value) => value.documentOwnership &&
      value.documentOwnership.ok === false &&
      value.dochost && value.dochost.ready && !value.dochost.recovering,
  );
  const reconciled = await request(restarted.base, 'GET', '/api/doc');
  const reconciledParagraph = reconciled.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  const blockedEdit = await request(restarted.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: reconciledParagraph.pid,
        text: `${reconciledParagraph.text} must not save`,
        expect_hash: reconciledParagraph.hash,
        why: 'typed directly',
        utterance: 'offline-conflict-edit',
      },
    },
  });
  const blockedUndo = await request(restarted.base, 'POST', '/api/undo');
  check('boot detects an offline replacement and exposes it read-only',
    conflictedHealth.ok === false &&
    reconciled.status === 200 &&
    blockedEdit.status === 409 &&
    blockedUndo.status === 409,
    `${blockedEdit.status}/${blockedUndo.status}`);
  check('boot conflict preserves replacement bytes, durable state, and Undo files',
    fs.readFileSync(active).equals(externalBytes) &&
    fs.readFileSync(path.join(data, 'state.json')).equals(durableState) &&
    JSON.stringify(checkpointSnapshot()) === JSON.stringify(durableCheckpoints));
  await gracefulStop(restarted);

  const restartedAgain = await startServer(root, {
    env: { SCRIBE_TRANSACTION_TEST: '1' },
  });
  servers.push(restartedAgain);
  const secondConflict = await waitForServer(
    restartedAgain.base,
    (value) => value.documentOwnership &&
      value.documentOwnership.ok === false &&
      value.dochost && value.dochost.ready && !value.dochost.recovering,
  );
  check('offline ownership conflict survives another coordinator restart',
    secondConflict.ok === false &&
    fs.readFileSync(active).equals(externalBytes) &&
    fs.readFileSync(path.join(data, 'state.json')).equals(durableState));
  const adopted = await request(restartedAgain.base, 'POST', '/api/open', {
    json: { path: active },
  });
  const healthyAfterAdoption = await request(restartedAgain.base, 'GET', '/api/health');
  check('explicit Open adopts the offline replacement and restores editing health',
    adopted.status === 200 &&
    healthyAfterAdoption.body.ok === true &&
    healthyAfterAdoption.body.documentOwnership.ok === true,
    adopted.body.error || healthyAfterAdoption.body.error);
  await gracefulStop(restartedAgain);

  const legacyRoot = path.join(suiteRoot, 'missing-fingerprint-sidecar');
  const legacyData = path.join(legacyRoot, 'data');
  const legacyDocuments = path.join(legacyData, 'documents');
  fs.mkdirSync(legacyDocuments, { recursive: true });
  fs.mkdirSync(path.join(legacyData, 'checkpoints'), { recursive: true });
  const legacyActive = path.join(legacyDocuments, 'active.docx');
  fs.copyFileSync(FIXTURE, legacyActive);
  const legacySeed = await startServer(legacyRoot);
  servers.push(legacySeed);
  await waitForServer(legacySeed.base, (value) => value.ok === true);
  await request(legacySeed.base, 'POST', '/api/open', {
    json: { path: legacyActive },
  });
  const legacyModel = await request(legacySeed.base, 'GET', '/api/doc');
  const legacyAnchor = legacyModel.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  await gracefulStop(legacySeed);

  const legacyStateFile = path.join(legacyData, 'state.json');
  const legacyState = JSON.parse(fs.readFileSync(legacyStateFile, 'utf8'));
  legacyState.docFingerprint = null;
  legacyState.checkpoints = [];
  legacyState.continuations = [{
    id: 'legacy-open-continuation',
    anchor_pid: legacyAnchor.pid,
    anchor_hash: legacyAnchor.hash,
    text: 'A legacy continuation that must not authorize package adoption.',
    style: legacyAnchor.style || 'Normal',
    status: 'open',
    at: new Date(0).toISOString(),
  }];
  fs.writeFileSync(legacyStateFile, JSON.stringify(legacyState, null, 2));
  const legacyBytes = fs.readFileSync(legacyActive);
  const legacyStateBytes = fs.readFileSync(legacyStateFile);
  const legacyRestart = await startServer(legacyRoot);
  servers.push(legacyRestart);
  const legacyConflict = await waitForServer(
    legacyRestart.base,
    (value) => value.documentOwnership &&
      value.documentOwnership.ok === false &&
      value.dochost && value.dochost.ready && !value.dochost.recovering,
  );
  const legacyContinuation = await request(
    legacyRestart.base,
    'GET',
    '/api/predict',
  );
  const legacyRead = await request(legacyRestart.base, 'GET', '/api/doc');
  const legacyBlockedEdit = await request(legacyRestart.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: legacyAnchor.pid,
        text: `${legacyAnchor.text} must not be implicitly adopted`,
        expect_hash: legacyAnchor.hash,
        why: 'typed directly',
        utterance: 'missing-fingerprint-conflict',
      },
    },
  });
  check('a legacy document with no fingerprint is quarantined even without Undo history',
    legacyConflict.ok === false &&
    legacyContinuation.body.continuation &&
    legacyContinuation.body.continuation.id === 'legacy-open-continuation' &&
    legacyRead.status === 200 &&
    legacyBlockedEdit.status === 409,
    `${legacyRead.status}/${legacyBlockedEdit.status}`);
  check('legacy fingerprint quarantine leaves package and sidecar state exact',
    fs.readFileSync(legacyActive).equals(legacyBytes) &&
    fs.readFileSync(legacyStateFile).equals(legacyStateBytes));
  const legacyAdopted = await request(legacyRestart.base, 'POST', '/api/open', {
    json: { path: legacyActive },
  });
  check('explicit Open clears the legacy fingerprint quarantine',
    legacyAdopted.status === 200 &&
    (await request(legacyRestart.base, 'GET', '/api/health')).body.ok === true,
    legacyAdopted.body.error);
  await gracefulStop(legacyRestart);
}

async function testDocumentHostTimeoutQuarantine(suiteRoot, servers) {
  console.log('\n[document host timeout quarantine]');
  const root = path.join(suiteRoot, 'document-host-timeout');
  const data = path.join(root, 'data');
  const documents = path.join(data, 'documents');
  const checkpoints = path.join(data, 'checkpoints');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(checkpoints, { recursive: true });
  const active = path.join(documents, 'active.docx');
  fs.copyFileSync(FIXTURE, active);

  const server = await startServer(root, {
    env: { SCRIBE_TRANSACTION_TEST: '1' },
  });
  servers.push(server);
  await waitForServer(server.base, (value) => value.ok === true);
  await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  const beforeModel = await request(server.base, 'GET', '/api/doc');
  const target = beforeModel.body.paragraphs.find((paragraph) =>
    paragraph.text && !paragraph.table);
  const beforeBytes = fs.readFileSync(active);
  const stateFile = path.join(data, 'state.json');
  const beforeState = fs.readFileSync(stateFile);
  const beforeCheckpoints = fs.readdirSync(checkpoints).sort();
  const beforeHealth = await request(server.base, 'GET', '/api/health');
  const oldHostPid = beforeHealth.body.dochost.pid;

  const timedOutEdit = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: `${target.text} timed host command must never arrive late`,
        expect_hash: target.hash,
        why: 'host timeout quarantine fixture',
        utterance: 'host-timeout-quarantine',
        __test_delay_in_host_save_ms: 300,
        __test_host_save_timeout_ms: 40,
      },
    },
  });
  const quarantined = await waitForServer(
    server.base,
    (value) => value.documentOwnership &&
      value.documentOwnership.ok === false &&
      value.dochost && value.dochost.pid !== oldHostPid &&
      value.dochost.ready && !value.dochost.recovering,
  );
  const quarantinedModel = await request(server.base, 'GET', '/api/doc');
  const blockedFollowup = await request(server.base, 'POST', '/api/edit', {
    json: {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: `${target.text} blocked after ambiguous timeout`,
        expect_hash: target.hash,
        why: 'typed directly',
        utterance: 'host-timeout-followup',
      },
    },
  });
  await sleep(500);
  const tempFiles = fs.readdirSync(documents).filter((name) =>
    /\.scribe-tmp-\d+\.docx$/i.test(name));
  check('a stateful document-host timeout retires that process generation',
    timedOutEdit.status === 504 &&
    quarantined.dochost.pid !== oldHostPid &&
    quarantined.documentOwnership.host_restore_failed === true &&
    quarantinedModel.status === 200 &&
    blockedFollowup.status === 409,
    `${timedOutEdit.status}/${oldHostPid}->${quarantined.dochost.pid}/` +
      `${blockedFollowup.status}`);
  check('an ambiguous timed-out save cannot commit late or alter durable history',
    fs.readFileSync(active).equals(beforeBytes) &&
    fs.readFileSync(stateFile).equals(beforeState) &&
    JSON.stringify(fs.readdirSync(checkpoints).sort()) ===
      JSON.stringify(beforeCheckpoints) &&
    tempFiles.length === 0,
    JSON.stringify({ tempFiles }));
  const recovered = await request(server.base, 'POST', '/api/open', {
    json: { path: active },
  });
  check('explicit Open recovers the quarantined timeout generation',
    recovered.status === 200 &&
    (await request(server.base, 'GET', '/api/health')).body.ok === true,
    recovered.body.error);
  await gracefulStop(server);
}

async function testChildFailures(suiteRoot, servers) {
  console.log('\n[child-process failures]');
  const missingRoot = path.join(suiteRoot, 'missing-python');
  const missingPython = path.join(missingRoot, 'definitely-not-python.exe');
  const missing = await startServer(missingRoot, { python: missingPython });
  servers.push(missing);
  const failedHealth = await waitForServer(
    missing.base,
    (value) => value.ok === false && !!value.error,
  );
  check('spawn ENOENT leaves server alive with truthful unhealthy status',
    failedHealth.ok === false && /failed|ENOENT|spawn/i.test(failedHealth.error || ''),
    failedHealth.error);
  const sttFailure = await request(missing.base, 'POST', '/api/stt/warm');
  check('lazy STT spawn ENOENT becomes a stable HTTP failure',
    sttFailure.status === 500 && /failed|ENOENT|spawn/i.test(sttFailure.body.error || ''),
    sttFailure.body.error);
  const stillAlive = await request(missing.base, 'GET', '/api/health');
  check('child error and restart races do not crash the coordinator',
    stillAlive.status === 200 && stillAlive.body.ok === false,
    stillAlive.status);
  check('spawn failures do not escape as fatal runtime errors',
    !/UNCAUGHT|UNHANDLED REJECTION/.test(missing.log.join('')),
    missing.log.join('').slice(-300));
  await request(missing.base, 'POST', '/api/__runtime/shutdown');
  const missingExit = await waitForExit(missing.child);
  check('failed child hosts still permit bounded clean shutdown',
    missingExit.code === 0, missingExit.code);

  // Node rejects the Python-only -u invocation after a successful spawn. This
  // drives exit/EPIPE/write-callback races rather than the ENOENT path.
  const exitRoot = path.join(suiteRoot, 'immediate-exit');
  const immediate = await startServer(exitRoot, { python: process.execPath });
  servers.push(immediate);
  const exitHealth = await waitForServer(
    immediate.base,
    (value) => value.ok === false && value.dochost === null && !!value.error,
  );
  check('immediate child exits converge on one bounded restart lane',
    exitHealth.ok === false && exitHealth.error, exitHealth.error);
  const refusedRead = await request(immediate.base, 'GET', '/api/doc');
  check('requests fail promptly instead of hanging on orphaned pending timers',
    refusedRead.status === 400, refusedRead.status);
  check('exit/write races do not trigger a coordinator fatal handler',
    !/UNCAUGHT|UNHANDLED REJECTION/.test(immediate.log.join('')),
    immediate.log.join('').slice(-300));
  await request(immediate.base, 'POST', '/api/__runtime/shutdown');
  const immediateExit = await waitForExit(immediate.child);
  check('exit-race fixture shuts down cleanly', immediateExit.code === 0,
    immediateExit.code);
}

async function testFatalExit(suiteRoot, servers, kind) {
  const root = path.join(suiteRoot, `fatal-${kind}`);
  const server = await startServer(root, {
    python: path.join(root, 'missing-python.exe'),
  });
  servers.push(server);
  await waitForServer(server.base);
  const scheduled = await request(
    server.base,
    'POST',
    `/api/__runtime/fatal?kind=${encodeURIComponent(kind)}`,
  );
  const exited = await waitForExit(server.child);
  check(`${kind} is logged and exits nonzero after bounded shutdown`,
    scheduled.status === 202 && exited.code === 1 &&
    new RegExp(kind === 'rejection' ? 'UNHANDLED REJECTION' : 'UNCAUGHT')
      .test(server.log.join('')),
    `${scheduled.status}/${exited.code}`);
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(`Document fixture is missing: ${FIXTURE}`);
  }
  const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-runtime-'));
  const servers = [];
  let crashed = null;
  try {
    await testUnavailableRestoredDocument(suiteRoot, servers);
    await testManagedPathsStaticBodies(suiteRoot, servers);
    await testLegacyCheckpointUndo(suiteRoot, servers);
    await testStatePersistenceFailures(suiteRoot, servers);
    await testExternalConflictRetiresRuntimes(suiteRoot, servers);
    await testOfflinePackageReplacement(suiteRoot, servers);
    await testDocumentHostTimeoutQuarantine(suiteRoot, servers);
    await testChildFailures(suiteRoot, servers);
    console.log('\n[fatal runtime errors]');
    await testFatalExit(suiteRoot, servers, 'exception');
    await testFatalExit(suiteRoot, servers, 'rejection');
  } catch (error) {
    crashed = error;
    console.error('\nTEST ERROR:', error && error.stack || error);
  } finally {
    for (const server of servers) await gracefulStop(server);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.rmSync(suiteRoot, { recursive: true, force: true });
        break;
      } catch (_) {
        await sleep(200);
      }
    }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed, ${SKIP.length} skipped`);
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  process.exitCode = crashed || FAIL.length ? 1 : 0;
}

main();
