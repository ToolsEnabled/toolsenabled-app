#!/usr/bin/env node
'use strict';
/*
 * Adversarial integration coverage for the coordinator's trust boundaries.
 * Every server runs from a disposable copy and receives its own copy of the
 * presentation, so this suite never writes the live model, state, board, or
 * presentation.pptx.
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}

function makeReadOnly(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['+R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o444); } catch (_) {} }
}

function canOpenWritable(file) {
  try {
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
    return true;
  } catch (_) {
    return false;
  }
}

function prepareSandbox(prefix) {
  const root = path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(5).toString('hex')}`);
  const suiteDir = path.join(root, 'suite');
  // The live viewer may be exporting thumbnails while this test starts. Its
  // short-lived staging directory can disappear between cpSync's directory
  // scan and traversal on Windows, producing an unrelated EPIPE/EBUSY before
  // the disposable server is even created. Staging output is never test input,
  // so exclude it while retaining the committed thumbnail snapshot.
  fs.cpSync(HERE, suiteDir, {
    recursive: true,
    filter: (source) => {
      const viewerProfile = path.join(HERE, 'data', 'codex-viewer-profile');
      return !path.basename(source).startsWith('.thumbs-stage-') &&
        source !== viewerProfile && !source.startsWith(viewerProfile + path.sep);
    },
  });
  const sourcePptx = path.join(HERE, '..', 'presentation.pptx');
  if (fs.existsSync(sourcePptx)) fs.copyFileSync(sourcePptx, path.join(root, 'presentation.pptx'));
  const data = path.join(suiteDir, 'data');
  fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
  fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
  const statePath = path.join(data, 'state.json');
  const modelPath = path.join(data, 'model.json');
  makeWritable(statePath);
  makeWritable(modelPath);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.paused = false;
  state.pausedBy = null;
  state.pausedAt = null;
  state.loopRunner = false;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  if (model.mode === 'overlay') model.base = path.join(data, 'base.pptx');
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));
  // Copy model-bound preview assets so both read-only Studio endpoints can be
  // exercised against the disposable server, never the live project process
  // or its files.
  const previewPicture = model.slides
    .flatMap((slide) => (slide.animations || []).map((animation) => ({
      slide,
      object: (slide.decor || []).find((item) => item.id === animation.targetId),
    })))
    .find((item) => item.object && item.object.kind === 'pic' && item.object.source);
  if (previewPicture) {
    const source = path.join(HERE, '..', previewPicture.object.source);
    const destination = path.join(root, previewPicture.object.source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const previewMedia = model.slides
    .flatMap((slide) => (slide.decor || []).map((object) => ({ slide, object })))
    .find((item) => item.object && item.object.kind === 'media'
      && item.object.generated === true && item.object.source);
  if (previewMedia) {
    const source = path.join(HERE, '..', previewMedia.object.source);
    const destination = path.join(root, previewMedia.object.source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  // Keep the integration test deterministic and Office-free. This edit is to
  // the disposable copy only.
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const platformLine = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformLine)) throw new Error('could not isolate Windows COM work');
  source = source.replace(platformLine, 'const IS_WIN = false; // backend robustness sandbox');
  const bootThumbs = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(bootThumbs)) throw new Error('could not isolate boot thumbnail work');
  source = source.replace(bootThumbs, '    // backend robustness sandbox: no boot thumbnail export');
  fs.writeFileSync(serverPath, source);
  return { root, suiteDir, data };
}

async function removeTree(root) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 7) throw error;
      await sleep(150 * (attempt + 1));
    }
  }
}

function request(port, method, route, options = {}) {
  return new Promise((resolve, reject) => {
    const raw = options.raw !== undefined
      ? Buffer.from(options.raw)
      : Buffer.from(options.body === undefined ? '' : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (method === 'POST' && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
    if (headers['Content-Length'] === undefined) headers['Content-Length'] = raw.length;
    const req = http.request(
      { host: '127.0.0.1', port, path: route, method, headers, timeout: 4000 },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let body;
          try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
          resolve({ status: res.statusCode, body, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (raw.length) req.write(raw);
    req.end();
  });
}

function binaryRequest(port, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: route,
        method: options.method || 'GET', headers: options.headers || {}, timeout: 4000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function rawHttp(port, wire) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => socket.destroy(new Error('raw HTTP request timed out')), 4000);
    socket.on('connect', () => socket.end(wire));
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => { clearTimeout(timer); resolve(text); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function incompleteBody(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/status',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 20 }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body });
        req.destroy();
      });
    });
    req.on('error', reject);
    req.write('{"id":"slow');
    // Deliberately do not finish the declared body.
  });
}

async function waitForHealth(child, port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      if ((await request(port, 'GET', '/api/health')).status === 200) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(3000)]);
}

async function startupFailure(mutator, expectedText) {
  const sandbox = prepareSandbox('suite-startup-robustness');
  let child = null;
  try {
    const observed = mutator(sandbox);
    const before = fs.readFileSync(observed, 'utf8');
    child = spawn(process.execPath, ['server.js'], {
      cwd: sandbox.suiteDir,
      env: Object.assign({}, process.env, { SUITE_PORT: String(await freePort()) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(6000).then(() => { throw new Error('invalid-data server did not exit'); })
    ]);
    return {
      failed: child.exitCode !== 0,
      named: stderr.includes(expectedText),
      preserved: fs.readFileSync(observed, 'utf8') === before
    };
  } finally {
    await stop(child);
    await removeTree(sandbox.root);
  }
}

async function startupSuccess(mutator) {
  const sandbox = prepareSandbox('suite-startup-success');
  let child = null;
  try {
    const metadata = mutator(sandbox);
    const port = await freePort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: sandbox.suiteDir,
      env: Object.assign({}, process.env, { SUITE_PORT: String(port) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await waitForHealth(child, port);
    return {
      started: true,
      metadata,
      state: (await request(port, 'GET', '/api/state')).body,
      persistedModel: JSON.parse(
        fs.readFileSync(path.join(sandbox.data, 'model.json'), 'utf8')
      )
    };
  } finally {
    await stop(child);
    await removeTree(sandbox.root);
  }
}

async function main() {
  const sandbox = prepareSandbox('suite-backend-robustness');
  const port = await freePort();
  let child = null;
  let childErr = '';
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: sandbox.suiteDir,
      env: Object.assign({}, process.env, {
        SUITE_PORT: String(port),
        SUITE_REQUEST_BODY_TIMEOUT_MS: '150'
      }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr.on('data', (chunk) => {
      if (childErr.length < 12000) childErr += chunk.toString().slice(0, 12000 - childErr.length);
    });
    await waitForHealth(child, port);

    const sandboxModel = JSON.parse(fs.readFileSync(path.join(sandbox.data, 'model.json'), 'utf8'));
    const previewPicture = sandboxModel.slides
      .flatMap((slide) => (slide.animations || []).map((animation) => ({
        slide,
        object: (slide.decor || []).find((item) => item.id === animation.targetId),
      })))
      .find((item) => item.object && item.object.kind === 'pic' && item.object.source);
    if (!previewPicture) throw new Error('preview endpoint fixture needs one animated picture');
    const previewRoute = '/api/animation-preview-asset?slideId='
      + encodeURIComponent(previewPicture.slide.id)
      + '&objectId=' + encodeURIComponent(previewPicture.object.id);
    const previewAsset = await binaryRequest(port, previewRoute);
    // The first animated picture may legitimately be PNG or JPEG (the human's
    // final s15 art is a JPG); pin the type and magic to the actual source.
    const previewExtension = path.extname(previewPicture.object.source).toLowerCase();
    const previewIsJpeg = previewExtension === '.jpg' || previewExtension === '.jpeg';
    const expectedPreviewType = previewIsJpeg ? 'image/jpeg' : 'image/png';
    const expectedPreviewMagic = previewIsJpeg
      ? Buffer.from([0xff, 0xd8, 0xff])
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    check('animation preview serves only model-bound source artwork',
      previewAsset.status === 200
        && previewAsset.headers['content-type'] === expectedPreviewType
        && previewAsset.headers['x-content-type-options'] === 'nosniff'
        && previewAsset.body.subarray(0, expectedPreviewMagic.length).equals(expectedPreviewMagic));
    const missingPreviewAsset = await request(
      port,
      'GET',
      '/api/animation-preview-asset?slideId='
        + encodeURIComponent(previewPicture.slide.id)
        + '&objectId=' + encodeURIComponent('../../presentation.pptx')
    );
    check('animation preview asset ids cannot become filesystem paths',
      missingPreviewAsset.status === 404
        && missingPreviewAsset.body.ok === false
        && /not found/.test(missingPreviewAsset.body.error));

    const previewMedia = sandboxModel.slides
      .flatMap((slide) => (slide.decor || []).map((object) => ({ slide, object })))
      .find((item) => item.slide.id === 's8' && item.object.id === 'd563324be'
        && item.object.kind === 'media' && item.object.generated === true);
    if (!previewMedia) throw new Error('preview endpoint fixture needs current s8 media d563324be');
    const mediaRoute = '/api/media-preview-asset?slideId='
      + encodeURIComponent(previewMedia.slide.id)
      + '&objectId=' + encodeURIComponent(previewMedia.object.id);
    const mediaFile = path.join(sandbox.root, previewMedia.object.source);
    const mediaStat = fs.statSync(mediaFile);
    const expectedPrefix = Buffer.alloc(32);
    const mediaFd = fs.openSync(mediaFile, 'r');
    try { fs.readSync(mediaFd, expectedPrefix, 0, expectedPrefix.length, 0); }
    finally { fs.closeSync(mediaFd); }
    const mediaHead = await binaryRequest(port, mediaRoute, { method: 'HEAD' });
    check('media preview HEAD exposes only model-bound MP4 metadata',
      mediaHead.status === 200
        && mediaHead.headers['content-type'] === 'video/mp4'
        && mediaHead.headers['accept-ranges'] === 'bytes'
        && mediaHead.headers['content-length'] === String(mediaStat.size)
        && mediaHead.headers['x-content-type-options'] === 'nosniff'
        && mediaHead.headers['cross-origin-resource-policy'] === 'same-origin'
        && mediaHead.body.length === 0);
    const mediaRange = await binaryRequest(port, mediaRoute, {
      headers: { Range: 'bytes=0-31' },
    });
    check('media preview supports exact single byte ranges for browser seeking',
      mediaRange.status === 206
        && mediaRange.headers['content-range'] === `bytes 0-31/${mediaStat.size}`
        && mediaRange.headers['content-length'] === '32'
        && mediaRange.body.equals(expectedPrefix));
    const invalidMediaRange = await binaryRequest(port, mediaRoute, {
      headers: { Range: 'bytes=999999999999-1000000000000' },
    });
    check('media preview rejects unsatisfiable ranges without leaking bytes',
      invalidMediaRange.status === 416
        && invalidMediaRange.headers['content-range'] === `bytes */${mediaStat.size}`
        && invalidMediaRange.body.length === 0);
    const missingMedia = await request(
      port,
      'GET',
      '/api/media-preview-asset?slideId=' + encodeURIComponent(previewMedia.slide.id)
        + '&objectId=' + encodeURIComponent('../../presentation.pptx')
    );
    check('media preview ids cannot become filesystem paths',
      missingMedia.status === 404
        && missingMedia.body.ok === false
        && /not found/.test(missingMedia.body.error));
    const pictureAsMedia = await request(port, 'GET', previewRoute.replace(
      '/api/animation-preview-asset', '/api/media-preview-asset'
    ));
    check('media preview refuses non-media model objects',
      pictureAsMedia.status === 404
        && pictureAsMedia.body.ok === false
        && /not found/.test(pictureAsMedia.body.error));
    const previewScript = await request(port, 'GET', '/animation-preview.js');
    const previewCss = await request(port, 'GET', '/animation-preview.css');
    check('the coordinator serves both isolated motion preview resources',
      previewScript.status === 200
        && /StudioAnimationPreview/.test(previewScript.text)
        && previewCss.status === 200
        && /\.sap-controls/.test(previewCss.text)
        && /\.sap-media-preview/.test(previewCss.text));

    const nullBody = await request(port, 'POST', '/api/status', { raw: 'null' });
    check('JSON null is rejected without hanging', nullBody.status === 400 && /object/i.test(nullBody.body.error));

    const malformed = await request(port, 'POST', '/api/status', { raw: '{"id":' });
    check('malformed JSON returns a structured 400', malformed.status === 400 && malformed.body.ok === false);

    const arrayBody = await request(port, 'POST', '/api/status', { raw: '[]' });
    check('array request bodies are rejected', arrayBody.status === 400);

    const oversized = await request(port, 'POST', '/api/status', {
      raw: '"' + 'x'.repeat(2 * 1024 * 1024 + 64) + '"'
    });
    check('oversized JSON is bounded with 413', oversized.status === 413);
    check('server remains healthy after adversarial bodies',
      (await request(port, 'GET', '/api/health')).status === 200);

    const slowBody = await incompleteBody(port);
    check('an incomplete slow request body is bounded with 408',
      slowBody.status === 408 && slowBody.body && slowBody.body.ok === false);

    const malformedHost = await rawHttp(
      port, 'GET /api/health HTTP/1.1\r\nHost: [broken\r\nConnection: close\r\n\r\n'
    );
    check('routing does not trust a malformed Host header', /^HTTP\/1\.1 200 /m.test(malformedHost));

    const wrongType = await request(port, 'POST', '/api/heartbeat', {
      body: { id: 'attacker' },
      headers: { 'Content-Type': 'text/plain' }
    });
    check('all control POST routes require JSON', wrongType.status === 415);

    const foreign = await request(port, 'POST', '/api/heartbeat', {
      body: { id: 'attacker' },
      headers: { Origin: 'https://example.invalid' }
    });
    check('all control POST routes reject foreign origins', foreign.status === 403);

    const invalidStatus = await request(port, 'POST', '/api/status', {
      body: { id: 'robustness', status: 'maybe' }
    });
    check('free/busy status accepts only its two real states', invalidStatus.status === 400);

    const runnerBefore = (await request(port, 'GET', '/api/state')).body.loopRunner.enabled;
    const invalidRunner = await request(port, 'POST', '/api/loops/runner', {
      body: { by: 'human-test', enabled: 'false' }
    });
    const runnerAfter = (await request(port, 'GET', '/api/state')).body.loopRunner.enabled;
    check('loop runner rejects string booleans without mutation',
      invalidRunner.status === 400 && runnerAfter === runnerBefore);

    const modelFile = path.join(sandbox.data, 'model.json');
    const deckFile = path.join(sandbox.root, 'presentation.pptx');
    makeReadOnly(modelFile);
    makeReadOnly(deckFile);
    const repairResume = await request(port, 'POST', '/api/resume', {
      body: { by: 'human-test' }
    });
    const writableRepaired = canOpenWritable(modelFile) && canOpenWritable(deckFile);
    makeWritable(modelFile);
    makeWritable(deckFile);
    check('an idempotent resume repairs residual read-only files',
      repairResume.status === 200 && repairResume.body.paused === false && writableRepaired);

    const taskAdd = await request(port, 'POST', '/api/tasks', {
      body: { text: 'ownership test', by: 'human-test', assignee: 'alice' }
    });
    const taskId = taskAdd.body.task.id;
    const wrongClaim = await request(port, 'POST', '/api/tasks/claim', {
      body: { id: taskId, by: 'bob' }
    });
    const rightClaim = await request(port, 'POST', '/api/tasks/claim', {
      body: { id: taskId, by: 'alice' }
    });
    const repeatClaim = await request(port, 'POST', '/api/tasks/claim', {
      body: { id: taskId, by: 'alice' }
    });
    const stolenClaim = await request(port, 'POST', '/api/tasks/claim', {
      body: { id: taskId, by: 'charlie' }
    });
    check('assigned work cannot be claimed by another editor', wrongClaim.status === 409);
    check('the assignee can claim its work', rightClaim.status === 200);
    check('same-owner claims are idempotent', repeatClaim.status === 200 && repeatClaim.body.alreadyClaimed === true);
    check('claimed work cannot be stolen', stolenClaim.status === 409);
    const missingDoneOwner = await request(port, 'POST', '/api/tasks/done', {
      body: { id: taskId }
    });
    const wrongWorkerDone = await request(port, 'POST', '/api/tasks/done', {
      body: { id: taskId, by: 'worker-2' }
    });
    check('task completion requires an owner identity', missingDoneOwner.status === 400);
    check('a worker cannot complete another assignee’s task', wrongWorkerDone.status === 409);

    const badPin = await request(port, 'POST', '/api/board/pin', {
      body: { id: 'missing', pinned: 'false' }
    });
    const badToggle = await request(port, 'POST', '/api/loops/toggle', {
      body: { id: 'missing', enabled: 'false' }
    });
    const broadUnlock = await request(port, 'POST', '/api/locks/release', {
      body: { by: 'robustness-test' }
    });
    check('board pinning rejects string booleans', badPin.status === 400);
    check('loop toggles reject string booleans', badToggle.status === 400);
    check('lock release requires an explicit scope', broadUnlock.status === 400);

    const snapshot = (await request(port, 'GET', '/api/state')).body;
    const slide = snapshot.model.slides[0];
    const element = slide.elements[0];
    const rejectedOps = [
      { type: 'set-layout', slideId: slide.id, layout: 'content' },
      { type: 'add-element', slideId: slide.id, elementType: 'body', text: 'orphan' },
      { type: 'add-slide', layout: 'made-up-layout' },
      { type: 'add-element', slideId: slide.id, elementType: 'script' },
      { type: 'set-text', slideId: slide.id, elementId: element.id, text: 7 },
      { type: 'set-bullets', slideId: slide.id, elementId: element.id, items: ['ok', 7] },
      { type: 'set-style', slideId: slide.id, elementId: element.id },
      { type: 'set-style', slideId: slide.id, elementId: element.id, bold: 'yes' },
      { type: 'set-style', slideId: slide.id, elementId: element.id, size: 0 },
      { type: 'set-theme', accent2: '#112233' },
      { type: 'set-corners', slideId: slide.id, targetId: element.id },
      { type: 'set-corners', slideId: slide.id, targetId: element.id, corners: 'rounded' },
      { type: 'set-corners', slideId: slide.id, targetId: 'missing', corners: 'sharp' },
      { type: 'set-box', slideId: slide.id, elementId: element.id, x: null },
      { type: 'set-box', slideId: slide.id, elementId: element.id, w: 0 },
      { type: 'set-transition', slideId: slide.id, effect: 'push' },
      { type: 'set-transition', slideId: slide.id, effect: 'fade', duration: null },
      { type: 'set-transition', slideId: slide.id, effect: 'fade', duration: 0.099 },
      { type: 'set-transition', slideId: slide.id, effect: 'fade', duration: 10.001 },
      { type: 'set-transition', slideId: slide.id, effect: 'none', duration: 0.35 },
      { type: 'add-shape', slideId: slide.id, shapeType: 'ellipse',
        x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: '#112233' },
      { type: 'add-shape', slideId: slide.id,
        x: 0.9, y: 0.1, w: 0.2, h: 0.2, fill: '#112233' },
      { type: 'add-shape', slideId: slide.id,
        x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: 'navy' }
    ];
    const importedDecor = (slide.decor || []).find((decor) => decor.generated !== true);
    if (importedDecor) {
      rejectedOps.push({
        type: 'delete-decor', slideId: slide.id, decorId: importedDecor.id
      });
    }
    let allRejected = true;
    for (const op of rejectedOps) {
      const response = await request(port, 'POST', '/api/edit', {
        body: { editor: 'robustness-test', op }
      });
      if (response.status !== 400 || response.body.ok !== false) allRejected = false;
    }
    const afterRejected = (await request(port, 'GET', '/api/state')).body;
    check('invalid and unrenderable edit variants are all rejected', allRejected);
    check('rejected edits leave the current-content revision unchanged',
      afterRejected.model.rev === snapshot.model.rev);

    const lintPath = path.join(sandbox.suiteDir, 'lint_fonts.py');
    const disabledLintPath = lintPath + '.disabled';
    fs.renameSync(lintPath, disabledLintPath);
    const lintFailure = await request(port, 'GET', '/api/lint');
    fs.renameSync(disabledLintPath, lintPath);
    check('a failed font helper cannot masquerade as a clean lint pass',
      lintFailure.status === 200 && lintFailure.body.ok === false &&
      lintFailure.body.issues.some((issue) => issue.type === 'font-lint-error'));
  } finally {
    await stop(child);
    await removeTree(sandbox.root);
  }

  const malformedState = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'state.json');
    makeWritable(target);
    fs.writeFileSync(target, '{"paused":');
    return target;
  }, 'malformed state.json');
  check('malformed state fails closed at startup', malformedState.failed && malformedState.named);
  check('startup failure preserves malformed state for recovery', malformedState.preserved);

  const duplicateSource = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[1].src = model.slides[0].src;
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'duplicate imported slide source');
  check('duplicate overlay sources fail closed before rendering', duplicateSource.failed && duplicateSource.named);
  check('startup validation does not rewrite the recoverable model', duplicateSource.preserved);

  const invalidTransition = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].transition = { effect: 'fade' };
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'transition.duration must be a finite number from 0.1 to 10 seconds');
  check('invalid persisted slide transitions fail closed at startup',
    invalidTransition.failed && invalidTransition.named && invalidTransition.preserved);

  const unknownTransitionField = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].transition = { effect: 'fade', duration: 0.35, sound: 'none' };
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'transition has unknown field: sound');
  check('persisted slide transitions reject unknown fields before rendering',
    unknownTransitionField.failed && unknownTransitionField.named && unknownTransitionField.preserved);

  const cornersWithoutSourcePreset = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].elements[0].corners = 'sharp';
    delete model.slides[0].elements[0].sourcePreset;
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'corners needs eligible imported sourcePreset metadata');
  check('persisted sharp-corner intent without trusted source metadata fails closed',
    cornersWithoutSourcePreset.failed && cornersWithoutSourcePreset.named &&
    cornersWithoutSourcePreset.preserved);

  const invalidSourcePreset = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].elements[0].sourcePreset = 'ellipse';
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'sourcePreset is not an eligible box/card preset');
  check('persisted non-card source geometry metadata fails closed',
    invalidSourcePreset.failed && invalidSourcePreset.named && invalidSourcePreset.preserved);

  const forgedEligiblePreset = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    const forged = model.slides
      .flatMap((slide) => slide.elements.map((element) => ({ slide, element })))
      .find((entry) => entry.element.ref && entry.element.sourcePreset === undefined);
    forged.element.sourcePreset = 'roundRect';
    forged.element.corners = 'sharp';
    model.shapePresetSchema = 1;
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'shape preset audit failed: source mismatch');
  check('trusted-looking box metadata is audited against immutable base.pptx',
    forgedEligiblePreset.failed && forgedEligiblePreset.named &&
    forgedEligiblePreset.preserved);

  const generatedSourcePreset = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].decor = model.slides[0].decor || [];
    model.slides[0].decor.push({
      id: 'generated-corner-forgery', kind: 'shape', sid: null,
      generated: true, shapeType: 'rect', sourcePreset: 'roundRect',
      corners: 'sharp',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, fill: '#112233'
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'sourcePreset is valid only for an imported AutoShape');
  check('generated objects cannot forge imported AutoShape corner eligibility',
    generatedSourcePreset.failed && generatedSourcePreset.named &&
    generatedSourcePreset.preserved);

  const unknownGeneratedShape = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].decor = model.slides[0].decor || [];
    model.slides[0].decor.push({
      id: 'generated-invalid', kind: 'shape', sid: null, generated: true,
      shapeType: 'ellipse',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, fill: '#112233'
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'unknown shapeType');
  check('persisted generated decor rejects unknown shape types at startup',
    unknownGeneratedShape.failed && unknownGeneratedShape.named && unknownGeneratedShape.preserved);

  const overflowingGeneratedShape = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides[0].decor = model.slides[0].decor || [];
    model.slides[0].decor.push({
      id: 'generated-overflow', kind: 'shape', sid: null, generated: true,
      shapeType: 'rect',
      box: { x: 0.9, y: 0.1, w: 0.2, h: 0.2 }, fill: '#112233'
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'box must fit within the slide');
  check('persisted generated decor rejects out-of-slide geometry at startup',
    overflowingGeneratedShape.failed && overflowingGeneratedShape.named &&
    overflowingGeneratedShape.preserved);

  const validGeneratedRestart = await startupSuccess((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    const id = 'generated-restart-safe';
    model.slides[0].decor = model.slides[0].decor || [];
    model.slides[0].decor.push({
      id, kind: 'shape', sid: null, generated: true, shapeType: 'rect',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, fill: '#112233'
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return { id };
  });
  const restartedMemoryDecor = validGeneratedRestart.state.model.slides[0].decor
    .find((decor) => decor.id === validGeneratedRestart.metadata.id);
  const restartedDiskDecor = validGeneratedRestart.persistedModel.slides[0].decor
    .find((decor) => decor.id === validGeneratedRestart.metadata.id);
  check('valid generated decor survives restart without SID backfill corruption',
    validGeneratedRestart.started &&
    restartedMemoryDecor && restartedMemoryDecor.sid === null &&
    restartedDiskDecor && restartedDiskDecor.sid === null);

  const validNativeGeneratedRestart = await startupSuccess((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    const slideId = 'native-generated-restart-slide';
    const decorId = 'native-generated-restart-shape';
    const elementId = 'native-boxed-restart-text';
    const elementBox = { x: 0.08, y: 0.06, w: 0.84, h: 0.12 };
    model.slides.push({
      id: slideId,
      layout: 'blank',
      notes: '',
      elements: [{
        id: elementId, type: 'body', text: 'Explicit native geometry',
        box: elementBox
      }],
      decor: [{
        id: decorId, kind: 'shape', sid: null, generated: true,
        shapeType: 'rect',
        box: { x: 0, y: 0, w: 1, h: 1 }, fill: '#003DA5'
      }],
      animations: [{
        targetId: decorId, effect: 'fade', trigger: 'click',
        duration: 0.4, delay: 0
      }]
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return { slideId, decorId, elementId, elementBox };
  });
  const restartedNativeSlide = validNativeGeneratedRestart.state.model.slides
    .find((slide) => slide.id === validNativeGeneratedRestart.metadata.slideId);
  const persistedNativeSlide = validNativeGeneratedRestart.persistedModel.slides
    .find((slide) => slide.id === validNativeGeneratedRestart.metadata.slideId);
  const restartedNativeElement = restartedNativeSlide && restartedNativeSlide.elements
    .find((element) => element.id === validNativeGeneratedRestart.metadata.elementId);
  const persistedNativeElement = persistedNativeSlide && persistedNativeSlide.elements
    .find((element) => element.id === validNativeGeneratedRestart.metadata.elementId);
  check('native explicit text geometry, generated decor, and animation survive strict startup validation',
    validNativeGeneratedRestart.started &&
    restartedNativeSlide && restartedNativeSlide.src === undefined &&
    restartedNativeElement &&
    JSON.stringify(restartedNativeElement.box) ===
      JSON.stringify(validNativeGeneratedRestart.metadata.elementBox) &&
    restartedNativeSlide.decor[0].id === validNativeGeneratedRestart.metadata.decorId &&
    restartedNativeSlide.decor[0].sid === null &&
    restartedNativeSlide.animations[0].targetId === validNativeGeneratedRestart.metadata.decorId &&
    persistedNativeSlide && persistedNativeSlide.decor[0].sid === null &&
    persistedNativeElement &&
    JSON.stringify(persistedNativeElement.box) ===
      JSON.stringify(validNativeGeneratedRestart.metadata.elementBox));

  const escapingNativeImage = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'model.json');
    makeWritable(target);
    const model = JSON.parse(fs.readFileSync(target, 'utf8'));
    model.slides.push({
      id: 'native-invalid-image-slide',
      layout: 'blank',
      notes: '',
      elements: [],
      decor: [{
        id: 'native-invalid-image', kind: 'pic', sid: null,
        generated: true, source: 'assets/../outside.png',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
      }]
    });
    fs.writeFileSync(target, JSON.stringify(model, null, 2));
    return target;
  }, 'source must be inside the project assets folder');
  check('native generated images retain fail-closed project path validation',
    escapingNativeImage.failed && escapingNativeImage.named &&
    escapingNativeImage.preserved);

  const corruptSpend = await startupFailure((sandboxCopy) => {
    const target = path.join(sandboxCopy.data, 'state.json');
    makeWritable(target);
    const state = JSON.parse(fs.readFileSync(target, 'utf8'));
    state.spend = state.spend || {};
    state.spend.byModel = { 'broken-model': 7 };
    fs.writeFileSync(target, JSON.stringify(state, null, 2));
    return target;
  }, 'spend.byModel.broken-model must be an object');
  check('invalid nested spend rollups fail closed at startup',
    corruptSpend.failed && corruptSpend.named && corruptSpend.preserved);

  let passed = 0;
  for (const item of checks) {
    if (item.ok) passed++;
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (passed !== checks.length) {
    if (childErr) console.error('\nserver stderr (bounded):\n' + childErr);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exit(1);
});
