#!/usr/bin/env node
'use strict';
/*
 * Durable per-object history integration tests.
 *
 * This suite copies only coordinator source into an OS-temporary sandbox. It
 * never binds the live Studio port and never reads or writes suite/data or the
 * live presentation. Rendering and Windows/PowerPoint work are disabled only
 * in that throwaway copy.
 *
 * Contract exercised here:
 *   GET  /api/object-history?slideId=&objectKind=element|decor&objectId=
 *   POST /api/object-history/restore
 *   POST /api/object-history/undo-restore
 *
 * The visible `versions` array is chronological (oldest to newest), is capped
 * at ten, and its final id is `headId`. A restore truncates that visible branch
 * at the selected version. Restore checkpoints are durable and nest three
 * deep; `topCheckpointToken` is supplied back as `checkpointToken` on undo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function makePng(red, green, blue, alpha) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;   // 8-bit channels
  header[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, red, green, blue, alpha]))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function mp4Box(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length, 0);
  return Buffer.concat([size, Buffer.from(type, 'ascii'), body]);
}

function makeMp4(marker) {
  return Buffer.concat([
    mp4Box('ftyp', Buffer.concat([
      Buffer.from('isom', 'ascii'), Buffer.from([0, 0, 2, 0]),
      Buffer.from('isomiso2mp41', 'ascii')
    ])),
    mp4Box('free', Buffer.from(`object-history-${marker}`, 'utf8')),
    mp4Box('mdat', Buffer.from(marker.repeat(3), 'utf8'))
  ]);
}

const INITIAL_PNG = makePng(24, 96, 192, 255);
const UPDATED_PNG = makePng(239, 68, 68, 255);
const INITIAL_MP4 = makeMp4('initial');
const UPDATED_MP4 = makeMp4('overwritten-content');

function check(description, condition, detail) {
  checks.push({ description, ok: !!condition, detail: condition ? undefined : detail });
}

function ids(history) {
  return history && Array.isArray(history.versions)
    ? history.versions.map((version) => version && version.id)
    : [];
}

function validHistoryShape(history) {
  return !!history && Array.isArray(history.versions) && history.versions.length >= 1 &&
    history.versions.length <= 10 && history.versions.every((version) =>
      version && typeof version === 'object' && typeof version.id === 'string' && version.id) &&
    typeof history.headId === 'string' && history.headId === history.versions.at(-1).id &&
    Number.isInteger(history.undoDepth) && history.undoDepth >= 0 && history.undoDepth <= 3 &&
    Object.prototype.hasOwnProperty.call(history, 'topCheckpointToken') &&
    (history.topCheckpointToken === null ||
      (typeof history.topCheckpointToken === 'string' && history.topCheckpointToken));
}

function historyPayload(body) {
  // Mutation responses may add `{ ok: true }`, but history fields remain at
  // the top level. Keeping this helper intentionally narrow catches accidental
  // endpoint drift while ignoring harmless additional response metadata.
  return body;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function api(base, route, options) {
  const response = await fetch(base + route, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: response.status, body, text };
}

async function assetRequest(base, ref, versionId, options) {
  const query = new URLSearchParams({
    slideId: ref.slideId,
    objectKind: ref.objectKind,
    objectId: ref.objectId,
    versionId
  });
  const response = await fetch(base + '/api/object-history/asset?' + query.toString(), options);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    range: response.headers.get('content-range'),
    body: Buffer.from(await response.arrayBuffer())
  };
}

async function waitFor(description, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; }
    catch (error) {
      if (error && /^sandbox server exited:/.test(error.message || '')) throw error;
    }
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

async function waitForStartupOutcome(child, base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { exited: true, healthy: false, exitCode: child.exitCode, output: child.output };
    }
    try {
      if ((await fetch(base + '/api/health')).ok) {
        return { exited: false, healthy: true, exitCode: null, output: child.output };
      }
    } catch (_) {}
    await sleep(30);
  }
  return { exited: child.exitCode !== null, healthy: false, exitCode: child.exitCode, output: child.output };
}

function copySourceSuite(suiteDir) {
  fs.mkdirSync(suiteDir, { recursive: true });
  const required = ['server.js', 'agents.js', 'codex-agent.js', 'ppt.js'];
  for (const name of required) {
    fs.copyFileSync(path.join(HERE, name), path.join(suiteDir, name));
  }
  // Permit the coordinator implementation to be split into a small module
  // without making this integration harness depend on that implementation
  // choice.
  for (const name of ['object-history.js', 'element-history.js']) {
    const source = path.join(HERE, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(suiteDir, name));
  }
}

function testModel() {
  return {
    title: 'Object History Test Deck',
    mode: 'native',
    theme: { accent: '#2563eb' },
    rev: 0,
    updatedAt: null,
    slides: [
      {
        id: 's1', layout: 'content', notes: '',
        elements: [
          { id: 'e1', type: 'title', text: 'History target' },
          { id: 'e2', type: 'body', text: 'Protected history target' }
        ],
        decor: [
          {
            id: 'd1', kind: 'shape', sid: null, generated: true,
            shapeType: 'rect', fill: '#112233',
            box: { x: 0.1, y: 0.65, w: 0.25, h: 0.2 }
          },
          {
            id: 'pic-history', kind: 'pic', sid: null, generated: true,
            source: 'assets/history-fixture.png',
            box: { x: 0.46, y: 0.65, w: 0.2, h: 0.2 }
          },
          {
            id: 'media-history', kind: 'media', sid: null, generated: true,
            source: 'assets/history-fixture.mp4',
            box: { x: 0.72, y: 0.65, w: 0.2, h: 0.2 },
            autoplay: true, loop: true
          }
        ]
      },
      {
        id: 's2', layout: 'content', notes: '',
        elements: [
          { id: 'e3', type: 'title', text: 'Animated target' },
          { id: 'e4', type: 'body', text: 'Sibling sentinel' }
        ],
        decor: []
      },
      {
        id: 'collision', layout: 'content', notes: '',
        elements: [
          { id: 'left:decor:tail', type: 'body', text: 'Collision element' }
        ],
        decor: []
      },
      {
        id: 'collision:element:left', layout: 'content', notes: '',
        elements: [],
        decor: [
          {
            id: 'tail', kind: 'shape', sid: null, generated: true,
            shapeType: 'rect', fill: '#334455',
            box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }
          }
        ]
      }
    ]
  };
}

function writeFixtureData(suiteDir) {
  const dataDir = path.join(suiteDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const assetsDir = path.join(suiteDir, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'history-fixture.png'), INITIAL_PNG);
  fs.writeFileSync(path.join(assetsDir, 'history-fixture.mp4'), INITIAL_MP4);
  // Pause verification also locks the rendered deck as defence in depth. A
  // tiny inert placeholder is sufficient in this no-render sandbox and keeps
  // the pause endpoint's success contract realistic.
  fs.writeFileSync(path.join(suiteDir, '..', 'presentation.pptx'), 'object-history-test-placeholder');
  fs.writeFileSync(path.join(dataDir, 'model.json'), JSON.stringify(testModel(), null, 2));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    paused: false, pausedBy: null, pausedAt: null, pdfRev: null,
    log: [], loopRunner: false, usageProfile: 'normal', agentProvider: 'claude'
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'board.json'), JSON.stringify({
    notes: [], tasks: [], loops: []
  }, null, 2));
}

function patchSandboxServer(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');

  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // object-history test sandbox');

  const agentNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(agentNeedle)) throw new Error('could not inject test agent identity');
  source = source.replace(agentNeedle, agentNeedle + `
const __objectHistoryModePath = path.join(DATA, '__object-history-test-mode');
const __objectHistoryMediaReadsPath = path.join(DATA, '__object-history-media-reads.jsonl');
const __objectHistoryMediaAssetPath = path.join(ROOT, 'assets', 'history-fixture.mp4');
const __objectHistoryReadFileSync = fs.readFileSync.bind(fs);
const __objectHistoryRenameSync = fs.renameSync.bind(fs);
function __objectHistoryMode() {
  try { return fs.readFileSync(__objectHistoryModePath, 'utf8').trim(); } catch (_) { return ''; }
}
fs.readFileSync = function(file, ...args) {
  if (path.resolve(String(file)) === path.resolve(__objectHistoryMediaAssetPath)) {
    try { fs.appendFileSync(__objectHistoryMediaReadsPath, String(Date.now()) + '\\n'); } catch (_) {}
  }
  return __objectHistoryReadFileSync(file, ...args);
};
fs.renameSync = function(from, to) {
  if (__objectHistoryMode() === 'fail-history-promotion' && String(to) === ELEMENT_HISTORY_PATH) {
    const error = new Error('forced element-history promotion failure');
    error.code = 'EPERM';
    throw error;
  }
  return __objectHistoryRenameSync(from, to);
};
const __objectHistoryIsAgent = Agents.isAgent.bind(Agents);
Agents.isAgent = (name) => String(name) === 'worker-1' || __objectHistoryIsAgent(name);`);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace(
    '  await migrateModel();',
    '  // object-history test: fixture model is already canonical'
  );
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate rendering');
  source = source.replace(
    'function scheduleRender() {',
    'function scheduleRender() {\n  if (process.env.SUITE_OBJECT_HISTORY_TEST) return;'
  );
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port, capture = true) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port),
      SUITE_HOST: '127.0.0.1',
      SUITE_OBJECT_HISTORY_TEST: '1'
    }),
    stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore']
  });
  child.output = '';
  if (capture) {
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.output += chunk; });
  }
  return child;
}

function objectQuery(ref) {
  const query = new URLSearchParams({
    slideId: ref.slideId,
    objectKind: ref.objectKind,
    objectId: ref.objectId
  });
  return '/api/object-history?' + query.toString();
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameHistoryCore(a, b) {
  return !!a && !!b && a.headId === b.headId && a.undoDepth === b.undoDepth &&
    a.topCheckpointToken === b.topCheckpointToken && sameJson(ids(a), ids(b));
}

async function main() {
  const sandbox = path.join(os.tmpdir(), 'suite-object-history-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  let child = null;

  const refs = {
    e1: { slideId: 's1', objectKind: 'element', objectId: 'e1' },
    e2: { slideId: 's1', objectKind: 'element', objectId: 'e2' },
    d1: { slideId: 's1', objectKind: 'decor', objectId: 'd1' },
    pic: { slideId: 's1', objectKind: 'decor', objectId: 'pic-history' },
    media: { slideId: 's1', objectKind: 'decor', objectId: 'media-history' },
    e3: { slideId: 's2', objectKind: 'element', objectId: 'e3' },
    collisionElement: {
      slideId: 'collision', objectKind: 'element', objectId: 'left:decor:tail'
    },
    collisionDecor: {
      slideId: 'collision:element:left', objectKind: 'decor', objectId: 'tail'
    }
  };

  try {
    copySourceSuite(suiteDir);
    writeFixtureData(suiteDir);
    patchSandboxServer(suiteDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const dataDir = path.join(suiteDir, 'data');
    const modelPath = path.join(dataDir, 'model.json');
    const historyPath = path.join(dataDir, 'element-history.json');
    const pendingHistoryPath = path.join(dataDir, 'element-history.pending.json');
    const historyModePath = path.join(dataDir, '__object-history-test-mode');
    const mediaReadsPath = path.join(dataDir, '__object-history-media-reads.jsonl');
    const assetsDir = path.join(suiteDir, '..', 'assets');
    const originalPicPath = path.join(assetsDir, 'history-fixture.png');
    const originalMediaPath = path.join(assetsDir, 'history-fixture.mp4');
    const getState = async () => (await api(base, '/api/state')).body;
    const getHistoryResponse = (ref) => api(base, objectQuery(ref));
    const getHistory = async (ref) => (await getHistoryResponse(ref)).body;
    const post = (route, body, headers) => api(base, route, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {})
    });
    const edit = (op, editor = 'human-test') => post('/api/edit', { editor, op });
    const toggle = (body) => post('/api/protections/toggle',
      Object.assign({ by: 'human-test' }, body));
    const restore = (ref, versionId, expectedHeadId, by = 'human-test') =>
      post('/api/object-history/restore', Object.assign({}, ref, {
        versionId, expectedHeadId, by
      }));
    const undoRestore = (ref, history, by = 'human-test') =>
      post('/api/object-history/undo-restore', Object.assign({}, ref, {
        expectedHeadId: history.headId,
        checkpointToken: history.topCheckpointToken,
        by
      }));

    child = startServer(suiteDir, port, true);
    await waitFor('object-history sandbox health', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });

    // Every stable object begins with one durable baseline version.
    const seedResponses = {};
    for (const [name, ref] of Object.entries(refs)) seedResponses[name] = await getHistoryResponse(ref);
    check('every element/decor reference exposes one canonical seed version',
      Object.values(seedResponses).every((response) =>
        response.status === 200 && validHistoryShape(response.body) &&
        response.body.versions.length === 1 && response.body.undoDepth === 0 &&
        response.body.topCheckpointToken === null),
      Object.fromEntries(Object.entries(seedResponses).map(([name, response]) => [name, {
        status: response.status, body: response.body
      }])));

    // Generated artwork is copied into a content-addressed archive at capture
    // time. The model keeps its ordinary project asset path, while every saved
    // version becomes independent of later overwrites/deletions of that path.
    const initialPicHistory = seedResponses.pic.body;
    const initialMediaHistory = seedResponses.media.body;
    const initialPicVersion = initialPicHistory.versions[0];
    const initialMediaVersion = initialMediaHistory.versions[0];
    const initialPicSource = initialPicVersion.state.object.source;
    const initialMediaSource = initialMediaVersion.state.object.source;
    const expectedInitialPicSource =
      `assets/.element-history/${crypto.createHash('sha256').update(INITIAL_PNG).digest('hex')}.png`;
    const expectedInitialMediaSource =
      `assets/.element-history/${crypto.createHash('sha256').update(INITIAL_MP4).digest('hex')}.mp4`;
    const archivedAbsolute = (source) => path.join(suiteDir, '..', ...source.split('/'));
    const initialPicArchive = archivedAbsolute(initialPicSource);
    const initialMediaArchive = archivedAbsolute(initialMediaSource);
    check('generated PNG and MP4 snapshots use immutable content-addressed archive sources',
      initialPicSource === expectedInitialPicSource &&
      initialMediaSource === expectedInitialMediaSource &&
      fs.readFileSync(initialPicArchive).equals(INITIAL_PNG) &&
      fs.readFileSync(initialMediaArchive).equals(INITIAL_MP4) &&
      (await getState()).model.slides[0].decor.find((item) => item.id === 'pic-history').source ===
        'assets/history-fixture.png' &&
      (await getState()).model.slides[0].decor.find((item) => item.id === 'media-history').source ===
        'assets/history-fixture.mp4',
      { initialPicSource, initialMediaSource });

    const initialPicPreview = await assetRequest(
      base, refs.pic, initialPicHistory.headId
    );
    const initialMediaPreview = await assetRequest(
      base, refs.media, initialMediaHistory.headId,
      { headers: { Range: 'bytes=0-15' } }
    );
    const crossBoundPreview = await assetRequest(
      base, refs.media, initialPicHistory.headId
    );
    const unknownBoundPreview = await assetRequest(
      base, refs.pic, 'v_000000000000000000000000'
    );
    check('history preview is bound to the exact model object and active version id',
      initialPicPreview.status === 200 && initialPicPreview.type === 'image/png' &&
      initialPicPreview.body.equals(INITIAL_PNG) &&
      initialMediaPreview.status === 206 && initialMediaPreview.type === 'video/mp4' &&
      initialMediaPreview.range === `bytes 0-15/${INITIAL_MP4.length}` &&
      initialMediaPreview.body.equals(INITIAL_MP4.subarray(0, 16)) &&
      crossBoundPreview.status === 404 && unknownBoundPreview.status === 404,
      { initialPicPreview, initialMediaPreview, crossBoundPreview, unknownBoundPreview });

    fs.writeFileSync(originalPicPath, UPDATED_PNG);
    fs.writeFileSync(originalMediaPath, UPDATED_MP4);
    const picGeometryEdit = await edit({
      type: 'set-box', slideId: 's1', decorId: 'pic-history', x: 0.43
    });
    fs.writeFileSync(mediaReadsPath, '');
    const mediaGeometryEdits = [];
    for (const x of [0.7, 0.68, 0.66]) {
      mediaGeometryEdits.push(await edit({
        type: 'set-box', slideId: 's1', decorId: 'media-history', x
      }));
    }
    const mediaReadsAfterGeometry = fs.readFileSync(mediaReadsPath, 'utf8')
      .split(/\r?\n/).filter(Boolean);
    const updatedPicHistory = await getHistory(refs.pic);
    const updatedMediaHistory = await getHistory(refs.media);
    const updatedPicSource = updatedPicHistory.versions.at(-1).state.object.source;
    const updatedMediaSources = updatedMediaHistory.versions.slice(1)
      .map((version) => version.state.object.source);
    const expectedUpdatedPicSource =
      `assets/.element-history/${crypto.createHash('sha256').update(UPDATED_PNG).digest('hex')}.png`;
    const expectedUpdatedMediaSource =
      `assets/.element-history/${crypto.createHash('sha256').update(UPDATED_MP4).digest('hex')}.mp4`;
    check('media asset cache hashes once, then reuses the archive across repeated geometry edits',
      picGeometryEdit.status === 200 && mediaGeometryEdits.every((response) => response.status === 200) &&
      updatedPicSource === expectedUpdatedPicSource &&
      updatedMediaSources.length === 3 &&
      updatedMediaSources.every((source) => source === expectedUpdatedMediaSource) &&
      mediaReadsAfterGeometry.length === 1,
      {
        mediaReadCount: mediaReadsAfterGeometry.length,
        updatedPicSource,
        updatedMediaSources
      });

    fs.unlinkSync(originalPicPath);
    fs.unlinkSync(originalMediaPath);
    const oldPicAfterDelete = await assetRequest(
      base, refs.pic, initialPicHistory.headId
    );
    const newPicAfterDelete = await assetRequest(
      base, refs.pic, updatedPicHistory.headId
    );
    const oldMediaAfterDelete = await assetRequest(
      base, refs.media, initialMediaHistory.headId
    );
    const newMediaAfterDelete = await assetRequest(
      base, refs.media, updatedMediaHistory.headId
    );
    check('saved previews survive original PNG/MP4 overwrite and deletion with exact historical bytes',
      oldPicAfterDelete.status === 200 && oldPicAfterDelete.body.equals(INITIAL_PNG) &&
      newPicAfterDelete.status === 200 && newPicAfterDelete.body.equals(UPDATED_PNG) &&
      oldMediaAfterDelete.status === 200 && oldMediaAfterDelete.body.equals(INITIAL_MP4) &&
      newMediaAfterDelete.status === 200 && newMediaAfterDelete.body.equals(UPDATED_MP4),
      { oldPicAfterDelete, newPicAfterDelete, oldMediaAfterDelete, newMediaAfterDelete });

    // All post-overwrite media versions share one cached archive. Remove it,
    // then prove a restore refuses before changing either model or history.
    const unavailableMediaVersion = updatedMediaHistory.versions[1];
    fs.unlinkSync(archivedAbsolute(unavailableMediaVersion.state.object.source));
    const beforeMissingAssetModel = JSON.stringify((await getState()).model);
    const beforeMissingAssetHistory = await getHistory(refs.media);
    const missingAssetRestore = await restore(
      refs.media, unavailableMediaVersion.id, beforeMissingAssetHistory.headId
    );
    const afterMissingAssetModel = JSON.stringify((await getState()).model);
    const afterMissingAssetHistory = await getHistory(refs.media);
    check('missing archived media refuses restore without model or history mutation',
      missingAssetRestore.status === 409 &&
      afterMissingAssetModel === beforeMissingAssetModel &&
      sameJson(afterMissingAssetHistory, beforeMissingAssetHistory),
      { missingAssetRestore, beforeMissingAssetHistory, afterMissingAssetHistory });

    const restorePicAfterDelete = await restore(
      refs.pic, initialPicHistory.headId, updatedPicHistory.headId
    );
    const restoreMediaAfterDelete = await restore(
      refs.media, initialMediaHistory.headId, updatedMediaHistory.headId
    );
    const abandonedPicPreview = await assetRequest(
      base, refs.pic, updatedPicHistory.headId
    );
    const restoredAssetState = await getState();
    check('archived PNG/MP4 versions restore after source deletion and abandoned branches stop previewing',
      restorePicAfterDelete.status === 200 && restoreMediaAfterDelete.status === 200 &&
      restoredAssetState.model.slides[0].decor.find((item) => item.id === 'pic-history').source ===
        initialPicSource &&
      restoredAssetState.model.slides[0].decor.find((item) => item.id === 'media-history').source ===
        initialMediaSource && abandonedPicPreview.status === 404,
      { restorePicAfterDelete, restoreMediaAfterDelete, abandonedPicPreview });

    // These two legal refs produce the same string under the former
    // `${slideId}:${kind}:${objectId}` scheme. Each must retain its own target,
    // version list, and content under collision-free tuple encoding.
    fs.writeFileSync(mediaReadsPath, '');
    const legacyCollisionKeyA = [
      refs.collisionElement.slideId,
      refs.collisionElement.objectKind,
      refs.collisionElement.objectId
    ].join(':');
    const legacyCollisionKeyB = [
      refs.collisionDecor.slideId,
      refs.collisionDecor.objectKind,
      refs.collisionDecor.objectId
    ].join(':');
    const collisionElementEdit = await edit({
      type: 'set-text', slideId: refs.collisionElement.slideId,
      elementId: refs.collisionElement.objectId, text: 'Collision element changed'
    });
    const collisionDecorEdit = await edit({
      type: 'set-fill', slideId: refs.collisionDecor.slideId,
      decorId: refs.collisionDecor.objectId, color: '#abcdef'
    });
    const collisionElementHistory = await getHistory(refs.collisionElement);
    const collisionDecorHistory = await getHistory(refs.collisionDecor);
    const unrelatedMediaReads = fs.readFileSync(mediaReadsPath, 'utf8')
      .split(/\r?\n/).filter(Boolean);
    check('old colon-key collisions retain two independent tuple-key histories',
      legacyCollisionKeyA === legacyCollisionKeyB &&
      collisionElementEdit.status === 200 && collisionDecorEdit.status === 200 &&
      collisionElementHistory.versions.length === 2 && collisionDecorHistory.versions.length === 2 &&
      collisionElementHistory.headId !== collisionDecorHistory.headId &&
      collisionElementHistory.versions.at(-1).state.object.text === 'Collision element changed' &&
      collisionDecorHistory.versions.at(-1).state.object.fill === '#abcdef' &&
      collisionElementHistory.target.slideId === refs.collisionElement.slideId &&
      collisionDecorHistory.target.slideId === refs.collisionDecor.slideId,
      {
        legacyCollisionKeyA,
        legacyCollisionKeyB,
        collisionElementHistory,
        collisionDecorHistory
      });
    check('unrelated text/shape edits discover raw changes without re-reading or hashing media',
      collisionElementEdit.status === 200 && collisionDecorEdit.status === 200 &&
      unrelatedMediaReads.length === 0,
      { unrelatedMediaReads });

    const initialE2 = seedResponses.e2.body;
    const initialD1 = seedResponses.d1.body;
    const versionText = new Map([[seedResponses.e1.body.headId, 'History target']]);

    // Twelve distinct forward edits prove automatic capture and the visible
    // ten-item cap. Recording each returned head lets the later restore assert
    // exact content without relying on private snapshot fields in the response.
    const editFailures = [];
    for (let i = 1; i <= 12; i++) {
      const value = `e1-version-${i}`;
      const edited = await edit({ type: 'set-text', slideId: 's1', elementId: 'e1', text: value });
      const history = await getHistory(refs.e1);
      if (edited.status !== 200 || !validHistoryShape(history)) {
        editFailures.push({ i, editStatus: edited.status, history });
        continue;
      }
      versionText.set(history.headId, value);
    }
    const fullTen = await getHistory(refs.e1);
    const unrelatedE2AfterE1 = await getHistory(refs.e2);
    const unrelatedD1AfterE1 = await getHistory(refs.d1);
    check('normal edits append immutable versions and cap the visible branch at ten',
      editFailures.length === 0 && validHistoryShape(fullTen) && fullTen.versions.length === 10 &&
      new Set(ids(fullTen)).size === 10 && fullTen.undoDepth === 0 &&
      fullTen.headId === fullTen.versions.at(-1).id &&
      (await getState()).model.slides[0].elements[0].text === 'e1-version-12',
      { editFailures, fullTen });
    check('histories are separated by stable slide/kind/object identity',
      sameJson(unrelatedE2AfterE1, initialE2) && sameJson(unrelatedD1AfterE1, initialD1),
      { initialE2, unrelatedE2AfterE1, initialD1, unrelatedD1AfterE1 });

    // Restoring the fifth chronological card makes it the head and visibly
    // leaves exactly five cards. The one-click undo then recovers both the
    // previous object and the complete ten-card branch.
    const fullTenIds = ids(fullTen);
    const fifthId = fullTenIds[4];
    const fifthText = versionText.get(fifthId);
    const siblingBeforeRestore = JSON.parse(JSON.stringify((await getState()).model.slides[0]));
    const restoredFiveResponse = await restore(refs.e1, fifthId, fullTen.headId);
    const restoredFive = await getHistory(refs.e1);
    const stateAtFive = await getState();
    check('restoring the fifth of ten versions truncates the active branch to exactly five',
      restoredFiveResponse.status === 200 && validHistoryShape(historyPayload(restoredFiveResponse.body)) &&
      validHistoryShape(restoredFive) && sameJson(ids(restoredFive), fullTenIds.slice(0, 5)) &&
      restoredFive.headId === fifthId && restoredFive.undoDepth === 1 &&
      typeof restoredFive.topCheckpointToken === 'string' &&
      stateAtFive.model.slides[0].elements[0].text === fifthText &&
      sameJson(stateAtFive.model.slides[0].elements.slice(1), siblingBeforeRestore.elements.slice(1)) &&
      sameJson(stateAtFive.model.slides[0].decor, siblingBeforeRestore.decor),
      { response: restoredFiveResponse, restoredFive, fifthText });

    const undoFiveResponse = await undoRestore(refs.e1, restoredFive);
    const afterUndoFive = await getHistory(refs.e1);
    check('undo restore recovers the previous current object and complete ten-version list',
      undoFiveResponse.status === 200 && validHistoryShape(historyPayload(undoFiveResponse.body)) &&
      sameJson(ids(afterUndoFive), fullTenIds) && afterUndoFive.headId === fullTen.headId &&
      afterUndoFive.undoDepth === 0 && afterUndoFive.topCheckpointToken === null &&
      (await getState()).model.slides[0].elements[0].text === 'e1-version-12',
      { response: undoFiveResponse, afterUndoFive });

    // Three restore checkpoints nest and unwind LIFO, restoring the complete
    // active branch at each level rather than synthesizing duplicate versions.
    const nestedPrefixes = [9, 7, 4];
    const nestedStates = [];
    let nestedCurrent = afterUndoFive;
    for (const prefixLength of nestedPrefixes) {
      const targetId = fullTenIds[prefixLength - 1];
      const response = await restore(refs.e1, targetId, nestedCurrent.headId);
      nestedCurrent = await getHistory(refs.e1);
      nestedStates.push({ prefixLength, response, history: nestedCurrent });
    }
    check('three restore checkpoints may be nested without losing any branch',
      nestedStates.every((item, index) =>
        item.response.status === 200 && validHistoryShape(historyPayload(item.response.body)) &&
        validHistoryShape(item.history) && item.history.undoDepth === index + 1 &&
        sameJson(ids(item.history), fullTenIds.slice(0, item.prefixLength)) &&
        typeof item.history.topCheckpointToken === 'string'),
      nestedStates);

    const expectedUndoPrefixes = [7, 9, 10];
    const unwindStates = [];
    for (let i = 0; i < 3; i++) {
      const response = await undoRestore(refs.e1, nestedCurrent);
      nestedCurrent = await getHistory(refs.e1);
      unwindStates.push({ response, history: nestedCurrent });
    }
    check('three nested restore undos unwind LIFO to the original current version and list',
      unwindStates.every((item, index) =>
        item.response.status === 200 && validHistoryShape(historyPayload(item.response.body)) &&
        sameJson(ids(item.history), fullTenIds.slice(0, expectedUndoPrefixes[index])) &&
        item.history.undoDepth === 2 - index) &&
      nestedCurrent.headId === fullTen.headId && nestedCurrent.topCheckpointToken === null &&
      (await getState()).model.slides[0].elements[0].text === 'e1-version-12',
      unwindStates);

    // Optimistic concurrency prevents an old panel from overwriting a newer
    // edit. The rejection must not change the current object or history stack.
    const staleBaseline = await getHistory(refs.e2);
    const freshEdit = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e2', text: 'fresh concurrent edit'
    });
    const freshHistory = await getHistory(refs.e2);
    const staleRestore = await restore(
      refs.e2, staleBaseline.versions[0].id, staleBaseline.headId
    );
    const afterStale = await getHistory(refs.e2);
    check('a stale expectedHeadId is rejected with 409 and no mutation',
      freshEdit.status === 200 && staleRestore.status === 409 &&
      sameJson(afterStale, freshHistory) &&
      (await getState()).model.slides[0].elements[1].text === 'fresh concurrent edit',
      { staleRestore, freshHistory, afterStale });

    // Restore is human-only and obeys both the global pause and durable
    // protections. Each denial is checked against an unchanged history head.
    const baselineE2Id = freshHistory.versions[0].id;
    const agentRestore = await restore(refs.e2, baselineE2Id, freshHistory.headId, 'worker-1');
    const afterAgent = await getHistory(refs.e2);
    const paused = await post('/api/pause', { by: 'human-test' });
    const pausedRestore = await restore(refs.e2, baselineE2Id, afterAgent.headId);
    const afterPaused = await getHistory(refs.e2);
    const resumed = await post('/api/resume', { by: 'human-test' });
    const directLock = await toggle({
      kind: 'object', slideId: 's1', objectKind: 'element', objectId: 'e2', protected: true
    });
    const protectedRestore = await restore(refs.e2, baselineE2Id, afterPaused.headId);
    const afterProtected = await getHistory(refs.e2);
    check('agents, pause, and direct object protection each deny restore without mutation',
      agentRestore.status === 403 && paused.status === 200 && pausedRestore.status === 423 &&
      resumed.status === 200 && directLock.status === 200 && protectedRestore.status === 423 &&
      sameHistoryCore(afterAgent, freshHistory) && sameHistoryCore(afterPaused, freshHistory) &&
      sameHistoryCore(afterProtected, freshHistory),
      { agentRestore, pausedRestore, protectedRestore });
    await toggle({
      kind: 'object', slideId: 's1', objectKind: 'element', objectId: 'e2', protected: false
    });

    // Inverse-tree semantics: the whole slide remains locked, while this one
    // exact child is an editable exception and may therefore be restored.
    const slideLock = await toggle({ kind: 'slide', slideId: 's1', protected: true });
    const exactException = await toggle({
      kind: 'object', slideId: 's1', objectKind: 'element', objectId: 'e2', protected: false
    });
    const exceptionRestoreResponse = await restore(
      refs.e2, baselineE2Id, freshHistory.headId
    );
    const exceptionRestored = await getHistory(refs.e2);
    check('a slide-locked object with an exact editable exception may be restored',
      slideLock.status === 200 && exactException.status === 200 &&
      exceptionRestoreResponse.status === 200 && validHistoryShape(historyPayload(exceptionRestoreResponse.body)) &&
      exceptionRestored.headId === baselineE2Id && exceptionRestored.versions.length === 1 &&
      exceptionRestored.undoDepth === 1 &&
      (await getState()).model.slides[0].elements[1].text === 'Protected history target',
      { slideLock, exactException, exceptionRestoreResponse, exceptionRestored });

    // The active branch, selected object, and restore checkpoint all survive a
    // process restart. The checkpoint remains actionable after restart.
    const beforeRestartHistory = JSON.parse(JSON.stringify(exceptionRestored));
    const beforeRestartText = (await getState()).model.slides[0].elements[1].text;
    await stopServer(child); child = null;
    child = startServer(suiteDir, port, true);
    await waitFor('durable object-history restart', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited after restart: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });
    const afterRestartHistory = await getHistory(refs.e2);
    const afterRestartText = (await getState()).model.slides[0].elements[1].text;
    check('object history and nested restore checkpoint persist across restart',
      sameJson(afterRestartHistory, beforeRestartHistory) && afterRestartText === beforeRestartText,
      { beforeRestartHistory, afterRestartHistory, beforeRestartText, afterRestartText });

    const restartUndoResponse = await undoRestore(refs.e2, afterRestartHistory);
    const restartUndone = await getHistory(refs.e2);
    check('a restore checkpoint can be undone after restart',
      restartUndoResponse.status === 200 && validHistoryShape(historyPayload(restartUndoResponse.body)) &&
      restartUndone.headId === freshHistory.headId && restartUndone.undoDepth === 0 &&
      sameJson(ids(restartUndone), ids(freshHistory)) &&
      (await getState()).model.slides[0].elements[1].text === 'fresh concurrent edit',
      { restartUndoResponse, restartUndone });
    await toggle({ kind: 'slide', slideId: 's1', protected: false });

    // A target snapshot owns only that object and its animation. Restoring it
    // must not roll back later sibling edits or disturb element/animation order.
    const animatedBaseline = await getHistory(refs.e3);
    const siblingAnimation = await edit({
      type: 'set-animation', slideId: 's2', targetId: 'e4',
      effect: 'fade', trigger: 'click', duration: 0.6, delay: 0
    });
    const animatedTextEdit = await edit({
      type: 'set-text', slideId: 's2', elementId: 'e3', text: 'Animated target changed'
    });
    const targetAnimation = await edit({
      type: 'set-animation', slideId: 's2', targetId: 'e3',
      effect: 'wipe', trigger: 'after-previous', duration: 0.8, delay: 0.2
    });
    const animatedCurrent = await getHistory(refs.e3);
    const siblingEdit = await edit({
      type: 'set-text', slideId: 's2', elementId: 'e4', text: 'Sibling changed later'
    });
    const addSibling = await edit({
      type: 'add-element', slideId: 's2', elementType: 'body', text: 'Trailing sibling'
    });
    const beforeAnimatedRestore = JSON.parse(JSON.stringify((await getState()).model.slides[1]));
    const animatedRestoreResponse = await restore(
      refs.e3, animatedBaseline.versions[0].id, animatedCurrent.headId
    );
    const afterAnimatedRestore = JSON.parse(JSON.stringify((await getState()).model.slides[1]));
    const animatedAtBaseline = await getHistory(refs.e3);
    check('restoring an object also restores its animation while preserving siblings and order',
      siblingAnimation.status === 200 && animatedTextEdit.status === 200 &&
      targetAnimation.status === 200 && siblingEdit.status === 200 && addSibling.status === 200 &&
      animatedRestoreResponse.status === 200 &&
      afterAnimatedRestore.elements.find((item) => item.id === 'e3').text === 'Animated target' &&
      afterAnimatedRestore.elements.find((item) => item.id === 'e4').text === 'Sibling changed later' &&
      sameJson(afterAnimatedRestore.elements.map((item) => item.id),
        beforeAnimatedRestore.elements.map((item) => item.id)) &&
      !(afterAnimatedRestore.animations || []).some((item) => item.targetId === 'e3') &&
      (afterAnimatedRestore.animations || []).some((item) =>
        item.targetId === 'e4' && item.effect === 'fade'),
      { animatedRestoreResponse, beforeAnimatedRestore, afterAnimatedRestore });

    const animatedUndoResponse = await undoRestore(refs.e3, animatedAtBaseline);
    const afterAnimatedUndo = JSON.parse(JSON.stringify((await getState()).model.slides[1]));
    const e3Animation = (afterAnimatedUndo.animations || []).find((item) => item.targetId === 'e3');
    check('undo restores the target animation exactly without reverting sibling content/order',
      animatedUndoResponse.status === 200 &&
      afterAnimatedUndo.elements.find((item) => item.id === 'e3').text === 'Animated target changed' &&
      afterAnimatedUndo.elements.find((item) => item.id === 'e4').text === 'Sibling changed later' &&
      sameJson(afterAnimatedUndo.elements.map((item) => item.id),
        beforeAnimatedRestore.elements.map((item) => item.id)) &&
      e3Animation && e3Animation.effect === 'wipe' && e3Animation.trigger === 'after-previous' &&
      e3Animation.duration === 0.8 && e3Animation.delay === 0.2 &&
      (afterAnimatedUndo.animations || []).findIndex((item) => item.targetId === 'e3') ===
        beforeAnimatedRestore.animations.findIndex((item) => item.targetId === 'e3'),
      { animatedUndoResponse, beforeAnimatedRestore, afterAnimatedUndo });

    // Malformed or unresolvable references fail closed. Exercise bad GET and
    // POST shapes without pinning implementation-specific 400-vs-404 wording.
    const beforeRefusalsModel = JSON.stringify((await getState()).model);
    const beforeRefusalsHistory = JSON.stringify(await getHistory(refs.e3));
    const refusalResponses = [
      await api(base, '/api/object-history'),
      await api(base, '/api/object-history?slideId=s1&objectKind=other&objectId=e1'),
      await api(base, '/api/object-history?slideId=missing&objectKind=element&objectId=e1'),
      await api(base, '/api/object-history?slideId=s1&objectKind=decor&objectId=e1'),
      await post('/api/object-history/restore', Object.assign({}, refs.e3, {
        versionId: animatedBaseline.versions[0].id,
        expectedHeadId: (await getHistory(refs.e3)).headId
      })),
      await post('/api/object-history/restore', Object.assign({}, refs.e3, {
        versionId: 'missing-version', expectedHeadId: (await getHistory(refs.e3)).headId,
        by: 'human-test'
      })),
      await post('/api/object-history/undo-restore', Object.assign({}, refs.e3, {
        expectedHeadId: (await getHistory(refs.e3)).headId,
        checkpointToken: 'not-a-real-checkpoint', by: 'human-test'
      }))
    ];
    const textPost = await api(base, '/api/object-history/restore', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
    });
    const foreignPost = await post('/api/object-history/restore', Object.assign({}, refs.e3, {
      versionId: animatedBaseline.versions[0].id,
      expectedHeadId: (await getHistory(refs.e3)).headId,
      by: 'human-test'
    }), { Origin: 'http://evil.example' });
    check('malformed, missing-identity, stale-token, non-JSON, and foreign-origin requests fail closed',
      refusalResponses.every((response) => response.status >= 400 && response.status < 500) &&
      textPost.status === 415 && foreignPost.status === 403 &&
      JSON.stringify((await getState()).model) === beforeRefusalsModel &&
      JSON.stringify(await getHistory(refs.e3)) === beforeRefusalsHistory,
      { refusalResponses, textPost, foreignPost });

    // A restore checkpoint belongs only to its stable target. Editing a
    // sibling must leave that checkpoint actionable; a new forward edit of
    // the restored target deliberately starts a new branch and clears it.
    const beforeCheckpointIsolation = await getHistory(refs.e1);
    const checkpointTarget = beforeCheckpointIsolation.versions.at(-2).id;
    const checkpointRestoreResponse = await restore(
      refs.e1, checkpointTarget, beforeCheckpointIsolation.headId
    );
    const checkpointAfterRestore = await getHistory(refs.e1);
    const unrelatedCheckpointEdit = await edit({
      type: 'set-text', slideId: 's2', elementId: 'e4',
      text: 'Unrelated edit while restore checkpoint is live'
    });
    const checkpointAfterUnrelated = await getHistory(refs.e1);
    check('an unrelated ordinary edit preserves the target restore checkpoint',
      checkpointRestoreResponse.status === 200 && checkpointAfterRestore.undoDepth === 1 &&
      typeof checkpointAfterRestore.topCheckpointToken === 'string' &&
      unrelatedCheckpointEdit.status === 200 &&
      sameHistoryCore(checkpointAfterUnrelated, checkpointAfterRestore),
      { checkpointRestoreResponse, checkpointAfterRestore, checkpointAfterUnrelated });

    const targetBranchEdit = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e1',
      text: 'Fresh branch after object-history restore'
    });
    const checkpointAfterTargetEdit = await getHistory(refs.e1);
    check('a fresh ordinary edit of the restored target clears its restore-undo stack',
      targetBranchEdit.status === 200 && validHistoryShape(checkpointAfterTargetEdit) &&
      checkpointAfterTargetEdit.headId !== checkpointAfterRestore.headId &&
      checkpointAfterTargetEdit.undoDepth === 0 &&
      checkpointAfterTargetEdit.topCheckpointToken === null &&
      (await getState()).model.slides[0].elements[0].text ===
        'Fresh branch after object-history restore',
      { targetBranchEdit, checkpointAfterRestore, checkpointAfterTargetEdit });

    // Global undo/redo stores the exact object-history entry patch beside the
    // model snapshot. Revision metadata advances, but the stable object and
    // every visible/archive/checkpoint field for that target must round-trip.
    const ordinaryPatchBeforeHistory = await getHistory(refs.d1);
    const ordinaryPatchBeforeObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const ordinaryPatchEdit = await edit({
      type: 'set-fill', slideId: 's1', decorId: 'd1', color: '#778899'
    });
    const ordinaryPatchAfterHistory = await getHistory(refs.d1);
    const ordinaryPatchAfterObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const ordinaryPatchUndo = await post('/api/undo', { editor: 'human-test' });
    const ordinaryPatchUndoneHistory = await getHistory(refs.d1);
    const ordinaryPatchUndoneObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const ordinaryPatchRedo = await post('/api/redo', { editor: 'human-test' });
    const ordinaryPatchRedoneHistory = await getHistory(refs.d1);
    const ordinaryPatchRedoneObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    check('global undo/redo preserves the exact history patch for an ordinary object edit',
      ordinaryPatchEdit.status === 200 && ordinaryPatchUndo.status === 200 &&
      ordinaryPatchRedo.status === 200 &&
      sameJson(ordinaryPatchUndoneObject, ordinaryPatchBeforeObject) &&
      sameJson(ordinaryPatchUndoneHistory, ordinaryPatchBeforeHistory) &&
      sameJson(ordinaryPatchRedoneObject, ordinaryPatchAfterObject) &&
      sameJson(ordinaryPatchRedoneHistory, ordinaryPatchAfterHistory),
      {
        ordinaryPatchEdit,
        ordinaryPatchUndo,
        ordinaryPatchRedo,
        ordinaryPatchBeforeHistory,
        ordinaryPatchUndoneHistory,
        ordinaryPatchAfterHistory,
        ordinaryPatchRedoneHistory
      });

    const restorePatchBeforeHistory = await getHistory(refs.d1);
    const restorePatchBeforeObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const restorePatchResponse = await restore(
      refs.d1, restorePatchBeforeHistory.versions[0].id, restorePatchBeforeHistory.headId
    );
    const restorePatchAfterHistory = await getHistory(refs.d1);
    const restorePatchAfterObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const restorePatchUndo = await post('/api/undo', { editor: 'human-test' });
    const restorePatchUndoneHistory = await getHistory(refs.d1);
    const restorePatchUndoneObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    const restorePatchRedo = await post('/api/redo', { editor: 'human-test' });
    const restorePatchRedoneHistory = await getHistory(refs.d1);
    const restorePatchRedoneObject = JSON.parse(JSON.stringify(
      (await getState()).model.slides[0].decor.find((item) => item.id === 'd1')
    ));
    check('global undo/redo preserves the exact history patch for an object-history restore',
      restorePatchResponse.status === 200 && restorePatchUndo.status === 200 &&
      restorePatchRedo.status === 200 &&
      sameJson(restorePatchUndoneObject, restorePatchBeforeObject) &&
      sameJson(restorePatchUndoneHistory, restorePatchBeforeHistory) &&
      sameJson(restorePatchRedoneObject, restorePatchAfterObject) &&
      sameJson(restorePatchRedoneHistory, restorePatchAfterHistory),
      {
        restorePatchResponse,
        restorePatchUndo,
        restorePatchRedo,
        restorePatchBeforeHistory,
        restorePatchUndoneHistory,
        restorePatchAfterHistory,
        restorePatchRedoneHistory
      });

    // Simulate the precise crash window after model.json has committed but
    // before the staged history document is promoted. First force promotion
    // itself to fail: boot must refuse and retain the marker plus the previous
    // committed history. Then remove the fault and prove the same marker is
    // durably promoted before it is removed.
    await stopServer(child); child = null;
    const committedHistoryText = fs.readFileSync(historyPath, 'utf8');
    const committedHistory = JSON.parse(committedHistoryText);
    const committedModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const stagedModel = JSON.parse(JSON.stringify(committedModel));
    stagedModel.rev += 1;
    stagedModel.updatedAt = new Date().toISOString();
    const stagedObject = stagedModel.slides.find((slide) => slide.id === 's1')
      .elements.find((element) => element.id === 'e1');
    stagedObject.text = 'Model committed before history promotion';
    const stagedHistory = JSON.parse(JSON.stringify(committedHistory));
    const stagedKey = JSON.stringify(['s1', 'element', 'e1']);
    const stagedEntry = stagedHistory.entries[stagedKey];
    const stagedVersionId = `v_${crypto.randomBytes(12).toString('hex')}`;
    stagedEntry.versions[stagedVersionId] = {
      id: stagedVersionId,
      createdAt: Date.now(),
      by: 'crash-fixture',
      summary: 'Model committed before history promotion',
      state: { object: JSON.parse(JSON.stringify(stagedObject)), animations: [] }
    };
    stagedEntry.timeline.push(stagedVersionId);
    if (stagedEntry.timeline.length > 10) stagedEntry.timeline.shift();
    stagedEntry.restoreUndos = [];
    stagedHistory.modelRev = stagedModel.rev;
    const matchingPending = {
      schemaVersion: 1,
      modelRev: stagedModel.rev,
      history: stagedHistory
    };
    fs.writeFileSync(modelPath, JSON.stringify(stagedModel, null, 2));
    fs.writeFileSync(pendingHistoryPath, JSON.stringify(matchingPending, null, 2));
    fs.writeFileSync(historyModePath, 'fail-history-promotion');

    child = startServer(suiteDir, port, true);
    const failedPromotionStartup = await waitForStartupOutcome(child, base);
    const markerSurvivedFailure = fs.existsSync(pendingHistoryPath);
    const committedAfterFailedPromotion = fs.readFileSync(historyPath, 'utf8');
    check('failed pending-history promotion refuses boot and retains its recovery marker',
      failedPromotionStartup.exited && failedPromotionStartup.exitCode !== 0 &&
      markerSurvivedFailure && committedAfterFailedPromotion === committedHistoryText,
      {
        failedPromotionStartup,
        markerSurvivedFailure,
        committedFileChanged: committedAfterFailedPromotion !== committedHistoryText
      });
    await stopServer(child); child = null;

    // Recreate both sides so this recovery half remains diagnostic even if a
    // broken implementation consumed the marker during the forced-failure
    // attempt above.
    fs.writeFileSync(modelPath, JSON.stringify(stagedModel, null, 2));
    fs.writeFileSync(historyPath, committedHistoryText);
    fs.writeFileSync(pendingHistoryPath, JSON.stringify(matchingPending, null, 2));
    fs.rmSync(historyModePath, { force: true });
    child = startServer(suiteDir, port, true);
    await waitFor('successful pending-history promotion restart', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited during promotion: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });
    const promotedApiHistory = await getHistory(refs.e1);
    const promotedDiskHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const promotedModel = (await getState()).model;
    check('matching committed model revision promotes staged history before removing its marker',
      !fs.existsSync(pendingHistoryPath) && promotedDiskHistory.modelRev === stagedModel.rev &&
      promotedDiskHistory.entries[stagedKey].timeline.at(-1) === stagedVersionId &&
      promotedApiHistory.headId === stagedVersionId &&
      promotedModel.rev === stagedModel.rev &&
      promotedModel.slides[0].elements[0].text === stagedObject.text,
      {
        markerExists: fs.existsSync(pendingHistoryPath),
        promotedDiskRev: promotedDiskHistory.modelRev,
        expectedRev: stagedModel.rev,
        diskHead: promotedDiskHistory.entries[stagedKey].timeline.at(-1),
        apiHead: promotedApiHistory.headId
      });

    // Now simulate the earlier crash window: history was staged for revision
    // N+1, but model.json never reached N+1. Boot must discard that ahead
    // marker and expose a head whose snapshot still tells the truth about the
    // current model.
    await stopServer(child); child = null;
    const honestModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const honestHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const aheadHistory = JSON.parse(JSON.stringify(honestHistory));
    const aheadEntry = aheadHistory.entries[stagedKey];
    const aheadVersionId = `v_${crypto.randomBytes(12).toString('hex')}`;
    const aheadObject = JSON.parse(JSON.stringify(
      honestModel.slides.find((slide) => slide.id === 's1')
        .elements.find((element) => element.id === 'e1')
    ));
    aheadObject.text = 'This model write never landed';
    aheadEntry.versions[aheadVersionId] = {
      id: aheadVersionId,
      createdAt: Date.now(),
      by: 'crash-fixture',
      summary: 'Uncommitted ahead history',
      state: { object: aheadObject, animations: [] }
    };
    aheadEntry.timeline.push(aheadVersionId);
    if (aheadEntry.timeline.length > 10) aheadEntry.timeline.shift();
    aheadEntry.restoreUndos = [];
    aheadHistory.modelRev = honestModel.rev + 1;
    fs.writeFileSync(pendingHistoryPath, JSON.stringify({
      schemaVersion: 1,
      modelRev: honestModel.rev + 1,
      history: aheadHistory
    }, null, 2));

    child = startServer(suiteDir, port, true);
    await waitFor('ahead pending-history recovery restart', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited during ahead-marker recovery: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });
    const afterAheadHistory = await getHistory(refs.e1);
    const afterAheadModel = (await getState()).model;
    const afterAheadHead = afterAheadHistory.versions.at(-1);
    check('an ahead pending marker is removed and reconciled to the model that actually committed',
      !fs.existsSync(pendingHistoryPath) && afterAheadModel.rev === honestModel.rev &&
      afterAheadModel.slides[0].elements[0].text === stagedObject.text &&
      afterAheadHistory.headId !== aheadVersionId &&
      afterAheadHead.state.object.text === stagedObject.text &&
      JSON.parse(fs.readFileSync(historyPath, 'utf8')).modelRev === honestModel.rev,
      {
        markerExists: fs.existsSync(pendingHistoryPath),
        modelRev: afterAheadModel.rev,
        expectedRev: honestModel.rev,
        apiHead: afterAheadHistory.headId,
        aheadVersionId,
        headText: afterAheadHead && afterAheadHead.state &&
          afterAheadHead.state.object && afterAheadHead.state.object.text
      });

    // Durable history is an authority boundary. Duplicate ids in either the
    // live branch or a checkpoint, and duplicate checkpoint tokens, make
    // recovery ambiguous; boot must refuse without repairing/overwriting the
    // evidence or touching model.json.
    await stopServer(child); child = null;
    const validDurableHistoryText = fs.readFileSync(historyPath, 'utf8');
    const durableModelText = fs.readFileSync(modelPath, 'utf8');
    const durableKey = JSON.stringify(['s1', 'element', 'e1']);
    const corruptionCases = [
      {
        name: 'duplicate active timeline ids',
        mutate(doc) {
          const entry = doc.entries[durableKey];
          const head = entry.timeline.at(-1);
          entry.timeline = [head, head];
        }
      },
      {
        name: 'duplicate checkpoint timeline ids',
        mutate(doc) {
          const entry = doc.entries[durableKey];
          const head = entry.timeline.at(-1);
          entry.restoreUndos = [{
            token: `r_${crypto.randomBytes(12).toString('hex')}`,
            createdAt: Date.now(),
            timeline: [head, head]
          }];
        }
      },
      {
        name: 'duplicate checkpoint tokens',
        mutate(doc) {
          const entry = doc.entries[durableKey];
          const head = entry.timeline.at(-1);
          const token = `r_${crypto.randomBytes(12).toString('hex')}`;
          entry.restoreUndos = [
            { token, createdAt: Date.now(), timeline: [head] },
            { token, createdAt: Date.now() + 1, timeline: [head] }
          ];
        }
      }
    ];
    const corruptionResults = [];
    for (const fixture of corruptionCases) {
      const corrupt = JSON.parse(validDurableHistoryText);
      fixture.mutate(corrupt);
      const corruptText = JSON.stringify(corrupt, null, 2);
      fs.writeFileSync(historyPath, corruptText);
      fs.rmSync(pendingHistoryPath, { force: true });
      child = startServer(suiteDir, port, true);
      const outcome = await waitForStartupOutcome(child, base);
      corruptionResults.push({
        name: fixture.name,
        outcome,
        historyPreserved: fs.readFileSync(historyPath, 'utf8') === corruptText,
        modelPreserved: fs.readFileSync(modelPath, 'utf8') === durableModelText,
        pendingAbsent: !fs.existsSync(pendingHistoryPath)
      });
      await stopServer(child); child = null;
      fs.writeFileSync(historyPath, validDurableHistoryText);
    }
    check('duplicate timeline/checkpoint ids and checkpoint tokens refuse boot fail-closed',
      corruptionResults.every((result) =>
        result.outcome.exited && result.outcome.exitCode !== 0 &&
        /invalid element-history\.json/i.test(result.outcome.output || '') &&
        result.historyPreserved && result.modelPreserved && result.pendingAbsent),
      corruptionResults);

    child = startServer(suiteDir, port, true);
    await waitFor('valid history restart after corruption fixtures', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited after restoring valid history: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });
    check('restoring the untouched durable history file boots normally after refusal cases',
      validHistoryShape(await getHistory(refs.e1)) &&
      fs.readFileSync(modelPath, 'utf8') === durableModelText);
  } catch (error) {
    checks.push({
      description: 'object-history integration suite completed',
      ok: false,
      detail: error && (error.stack || error.message) || String(error)
    });
  } finally {
    await stopServer(child);
    // This path is generated beneath os.tmpdir and contains the fixed suite
    // prefix, so cleanup cannot target the repository or an arbitrary folder.
    if (path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('suite-object-history-')) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
    }
  }

  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.description}`);
    if (!item.ok && item.detail !== undefined) {
      console.log('  ' + JSON.stringify(item.detail, null, 2).replace(/\n/g, '\n  '));
    }
  }
  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main();
