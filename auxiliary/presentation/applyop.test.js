#!/usr/bin/env node
'use strict';
/*
 * applyop.test.js — regression coverage for server.js's applyOp validation
 * gaps, the single most-repeated class of fix this project has made
 * (delete-slide's zero-slide floor, set-theme's hex requirement, add-slide's
 * layout/index/after fields, set-box's NaN-over-the-wire coercion, and
 * earlier passes' set-bullets/move-slide/set-layout checks). Every one of
 * those fixes was proven correct by hand, once, in a throwaway sandbox
 * server that got deleted right after — nothing persisted to catch a future
 * regression.
 *
 * applyOp itself can't be required directly: it's an unexported closure
 * over server.js's module-scope `model`, and requiring server.js at all
 * unconditionally calls boot() -> server.listen() (plus warms a real COM
 * host), so `require('./server.js')` from a test would try to bind the
 * live port. Refactoring server.js to be safely requireable is a real,
 * separate, higher-risk undertaking (its own module-boundary work across
 * every op, not a small scoped change). Instead this spawns a REAL
 * server.js as a child process against an isolated temp copy of the suite
 * folder (never the live data/model.json) and drives it over real HTTP,
 * the exact integration-test shape already used ad hoc in every sandbox
 * verification this session, just saved so it can be re-run.
 *
 *     node applyop.test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HERE = __dirname;
const PORT = 47591; // fixed test-only port, distinct from every sandbox port used by hand this session (4681-4686) and the live 4599
const HOST = '127.0.0.1';

function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed; try { parsed = out ? JSON.parse(out) : {}; } catch (_) { parsed = { raw: out }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForHealth(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server process exited early with code ' + child.exitCode);
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('server did not become healthy within ' + timeoutMs + 'ms');
}

function editOp(op) { return api('POST', '/api/edit', { op, editor: 'applyop-test' }); }
async function state() { return (await api('GET', '/api/state')).body; }
function objectHistory(slideId, objectKind, objectId) {
  const query = [
    ['slideId', slideId],
    ['objectKind', objectKind],
    ['objectId', objectId],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return api('GET', `/api/object-history?${query}`);
}

async function main() {
  const sandbox = path.join(os.tmpdir(), 'applyop-test-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const liveViewerProfile = path.join(HERE, 'data', 'codex-viewer-profile');
  fs.cpSync(HERE, suiteDir, {
    recursive: true,
    // The live Chromium profile contains process-locked databases and is not
    // test input. Excluding it keeps this disposable source copy deterministic.
    filter: (source) => source !== liveViewerProfile && !source.startsWith(liveViewerProfile + path.sep),
  });
  // A real paused deck marks model.json and presentation.pptx read-only.
  // Windows preserves the writable bit when cpSync clones the suite, so the
  // state reset below can otherwise fail before the isolated server starts.
  // The sandbox must never inherit live filesystem locks.
  for (const rel of [
    path.join('data', 'model.json'),
    path.join('data', 'state.json'),
    path.join('data', 'board.json'),
    path.join('data', 'render-state.json'),
  ]) {
    try { fs.chmodSync(path.join(suiteDir, rel), 0o666); } catch (_) {}
  }
  const assetsDir = path.join(sandbox, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(
    path.join(assetsDir, 'test-image.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7fNwAAAABJRU5ErkJggg==', 'base64')
  );
  fs.writeFileSync(
    path.join(assetsDir, 'test-image-2.png'),
    // Same 1x1 PNG plus a trailing byte: still decodable, but a distinct
    // content hash so the history's content-addressed snapshot must change.
    Buffer.concat([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av7fNwAAAABJRU5ErkJggg==', 'base64'),
      Buffer.from([0]),
    ])
  );
  const h264Fixture = Buffer.from(
    fs.readFileSync(
      path.join(HERE, 'test-fixtures', 'h264-blue-32x32.mp4.base64'),
      'utf8'
    ).replace(/\s+/g, ''),
    'base64'
  );
  fs.writeFileSync(path.join(assetsDir, 'test-video.mp4'), h264Fixture);
  fs.writeFileSync(
    path.join(assetsDir, 'test-video-2.mp4'),
    Buffer.concat([h264Fixture, Buffer.from([0])])
  );
  fs.writeFileSync(path.join(assetsDir, 'test-video.mov'), h264Fixture);
  // Never let this throwaway server think it owns the live COM host / agent pids.
  fs.rmSync(path.join(suiteDir, 'data', 'com_host.pid.json'), { force: true });
  fs.rmSync(path.join(suiteDir, 'data', 'agents.pid.json'), { force: true });
  // ...and never let it inherit live pause or content-protection state.
  // state.json is copied whole, so a paused or release-locked live deck would
  // otherwise make every valid sandbox mutation return 423 even though this
  // test owns an isolated copy.
  try {
    const sp = path.join(suiteDir, 'data', 'state.json');
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    st.paused = false; st.pausedBy = null; st.pausedAt = null;
    st.protections = [];
    st.protectionExceptions = [];
    st.protectionHistory = [];
    fs.writeFileSync(sp, JSON.stringify(st));
  } catch (_) { /* no state.json yet: the server will create an unpaused one */ }
  const comHostPs1 = path.join(suiteDir, 'com_host.ps1');
  if (fs.existsSync(comHostPs1)) fs.renameSync(comHostPs1, comHostPs1 + '.disabled');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, { SUITE_PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const cases = [];
  function record(desc, fn) { cases.push({ desc, fn }); }

  try {
    await waitForHealth(child, 8000);

    // ---- generated rectangle overlays: imported slides may gain a tightly
    // validated solid rectangle, but imported decor itself remains immutable.
    {
      const before = await state();
      const importedSlide = before.model.slides.find((slide) => Number.isInteger(slide.src));
      const importedDecor = importedSlide && (importedSlide.decor || []).find((decor) => decor.generated !== true);
      const beforeInvalidRev = before.model.rev;
      const invalidOps = [
        { type: 'add-shape', slideId: importedSlide.id, shapeType: 'ellipse', x: 0.1, y: 0.2, w: 0.3, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: null, y: 0.2, w: 0.3, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: '0.1', y: 0.2, w: 0.3, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: 0.1, y: 0.2, w: 0, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: 0.8, y: 0.2, w: 0.3, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: 0.1, y: 0.7, w: 0.3, h: 0.4, fill: '#112233' },
        { type: 'add-shape', slideId: importedSlide.id, x: 0.1, y: 0.2, w: 0.3, h: 0.4, fill: 'blue' },
      ];
      const invalidResponses = [];
      for (const op of invalidOps) invalidResponses.push(await editOp(op));
      const afterInvalid = await state();
      record('add-shape rejects unknown types, non-numbers, zero size, overflow, and non-hex fill', () =>
        invalidResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected generated shapes do not mutate or revise the deck', () =>
        afterInvalid.model.rev === beforeInvalidRev);

      const added = await editOp({
        type: 'add-shape', slideId: importedSlide.id, shapeType: 'rect',
        x: 0.1, y: 0.2, w: 0.3, h: 0.4, fill: '#112233'
      });
      const addedState = await state();
      const decorId = added.body.affected && added.body.affected.decorId;
      const generated = addedState.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === decorId);
      record('add-shape persists the exact generated rectangle model contract', () =>
        added.status === 200 && added.body.ok === true &&
        JSON.stringify(generated) === JSON.stringify({
          id: decorId, kind: 'shape', sid: null, generated: true,
          shapeType: 'rect', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, fill: '#112233'
        }));

      const recolored = await editOp({
        type: 'set-fill', slideId: importedSlide.id, decorId, color: '#ABCDEF'
      });
      const resized = await editOp({
        type: 'set-box', slideId: importedSlide.id, decorId, x: 0.2, w: 0.25
      });
      const editedState = await state();
      const edited = editedState.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === decorId);
      record('set-fill and set-box edit generated rectangles with strict final geometry', () =>
        recolored.status === 200 && resized.status === 200 &&
        edited.fill === '#ABCDEF' &&
        JSON.stringify(edited.box) === JSON.stringify({ x: 0.2, y: 0.2, w: 0.25, h: 0.4 }));

      const beforeOverflow = JSON.stringify(edited);
      const overflow = await editOp({
        type: 'set-box', slideId: importedSlide.id, decorId, x: 0.9
      });
      const afterOverflow = (await state()).model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === decorId);
      record('set-box refuses a generated rectangle that would extend beyond the slide', () =>
        overflow.status === 400 && JSON.stringify(afterOverflow) === beforeOverflow);

      const importedDelete = importedDecor
        ? await editOp({ type: 'delete-decor', slideId: importedSlide.id, decorId: importedDecor.id })
        : { status: 400, body: { ok: false } };
      const afterImportedDelete = await state();
      record('delete-decor refuses to remove imported base-deck decor', () =>
        !!importedDecor && importedDelete.status === 400 &&
        afterImportedDelete.model.slides.find((slide) => slide.id === importedSlide.id)
          .decor.some((decor) => decor.id === importedDecor.id));

      const removed = await editOp({ type: 'delete-decor', slideId: importedSlide.id, decorId });
      const afterRemoved = await state();
      record('delete-decor removes generated decor only', () =>
        removed.status === 200 && removed.body.ok === true &&
        !afterRemoved.model.slides.find((slide) => slide.id === importedSlide.id)
          .decor.some((decor) => decor.id === decorId));
    }

    // ---- imported box/card corner conversion: stable model identity is
    // preserved, while every non-AutoShape/generated target fails closed.
    {
      const before = await state();
      const eligibleElementEntry = before.model.slides
        .flatMap((slide) => slide.elements
          .filter((element) => element.sourcePreset)
          .map((element) => ({ slide, element })))
        .find((entry) => entry.element.sourcePreset === 'roundRect');
      const eligibleDecorEntry = before.model.slides
        .flatMap((slide) => (slide.decor || [])
          .filter((decor) => decor.sourcePreset)
          .map((decor) => ({ slide, decor })))
        .find((entry) => entry.decor.sourcePreset === 'roundRect');
      const ineligibleElementEntry = before.model.slides
        .flatMap((slide) => slide.elements
          .filter((element) => element.ref && !element.sourcePreset)
          .map((element) => ({ slide, element })))
        .find(Boolean);
      const pictureEntry = before.model.slides
        .flatMap((slide) => (slide.decor || [])
          .filter((decor) => decor.kind === 'pic')
          .map((decor) => ({ slide, decor })))
        .find(Boolean);

      const rejectedBefore = (await state()).model.rev;
      const invalidOps = [
        { type: 'set-corners', slideId: 'missing', targetId: 'missing', corners: 'sharp' },
        { type: 'set-corners', slideId: eligibleElementEntry.slide.id, targetId: '', corners: 'sharp' },
        { type: 'set-corners', slideId: eligibleElementEntry.slide.id, targetId: eligibleElementEntry.element.id },
        { type: 'set-corners', slideId: eligibleElementEntry.slide.id, targetId: eligibleElementEntry.element.id, corners: 'rounded' },
        { type: 'set-corners', slideId: eligibleElementEntry.slide.id, targetId: 'missing', corners: 'sharp' },
        {
          type: 'set-corners',
          slideId: ineligibleElementEntry.slide.id,
          targetId: ineligibleElementEntry.element.id,
          corners: 'sharp'
        },
        {
          type: 'set-corners',
          slideId: pictureEntry.slide.id,
          targetId: pictureEntry.decor.id,
          corners: 'sharp'
        },
      ];
      const invalidResponses = [];
      for (const op of invalidOps) invalidResponses.push(await editOp(op));
      const rejectedAfter = (await state()).model.rev;
      record('set-corners rejects missing/unknown modes and every non-box target class', () =>
        invalidResponses.every((response) =>
          response.status === 400 && response.body.ok === false));
      record('rejected set-corners calls do not revise the deck', () =>
        (before.model.shapePresetSchema === 1) &&
        (invalidResponses.length === invalidOps.length) &&
        rejectedAfter === rejectedBefore);

      const elementBefore = JSON.parse(JSON.stringify(eligibleElementEntry.element));
      const animationsBefore = JSON.stringify(eligibleElementEntry.slide.animations || []);
      const elementSet = await editOp({
        type: 'set-corners',
        slideId: eligibleElementEntry.slide.id,
        targetId: eligibleElementEntry.element.id,
        corners: 'sharp'
      });
      const elementSetAgain = await editOp({
        type: 'set-corners',
        slideId: eligibleElementEntry.slide.id,
        targetId: eligibleElementEntry.element.id,
        corners: 'sharp'
      });
      const afterElement = await state();
      const elementSlide = afterElement.model.slides.find(
        (slide) => slide.id === eligibleElementEntry.slide.id
      );
      const elementAfter = elementSlide.elements.find(
        (element) => element.id === eligibleElementEntry.element.id
      );
      record('set-corners persists sharp intent idempotently on an imported text AutoShape', () =>
        elementSet.status === 200 && elementSetAgain.status === 200 &&
        elementAfter.id === elementBefore.id &&
        JSON.stringify(elementAfter.ref) === JSON.stringify(elementBefore.ref) &&
        JSON.stringify(elementAfter.box) === JSON.stringify(elementBefore.box) &&
        JSON.stringify(elementAfter.style) === JSON.stringify(elementBefore.style) &&
        elementAfter.text === elementBefore.text &&
        elementAfter.sourcePreset === elementBefore.sourcePreset &&
        elementAfter.corners === 'sharp' &&
        JSON.stringify(elementSlide.animations || []) === animationsBefore);

      const decorBefore = JSON.parse(JSON.stringify(eligibleDecorEntry.decor));
      const decorSet = await editOp({
        type: 'set-corners',
        slideId: eligibleDecorEntry.slide.id,
        targetId: eligibleDecorEntry.decor.id,
        corners: 'sharp'
      });
      const afterDecor = (await state()).model.slides
        .find((slide) => slide.id === eligibleDecorEntry.slide.id)
        .decor.find((decor) => decor.id === eligibleDecorEntry.decor.id);
      record('set-corners preserves imported decor identity, style, box, and source metadata', () =>
        decorSet.status === 200 &&
        afterDecor.id === decorBefore.id &&
        afterDecor.sid === decorBefore.sid &&
        afterDecor.kind === decorBefore.kind &&
        afterDecor.fill === decorBefore.fill &&
        JSON.stringify(afterDecor.box) === JSON.stringify(decorBefore.box) &&
        afterDecor.sourcePreset === decorBefore.sourcePreset &&
        afterDecor.corners === 'sharp');

      const generated = await editOp({
        type: 'add-shape',
        slideId: eligibleElementEntry.slide.id,
        shapeType: 'rect',
        x: 0.1, y: 0.1, w: 0.1, h: 0.1, fill: '#112233'
      });
      const generatedCorner = await editOp({
        type: 'set-corners',
        slideId: eligibleElementEntry.slide.id,
        targetId: generated.body.affected.decorId,
        corners: 'sharp'
      });
      record('set-corners refuses generated rectangles, which are already sharp', () =>
        generated.status === 200 && generatedCorner.status === 400 &&
        /generated objects/i.test(generatedCorner.body.error));
      await editOp({
        type: 'delete-decor',
        slideId: eligibleElementEntry.slide.id,
        decorId: generated.body.affected.decorId
      });
    }

    // ---- local image overlays + native object animations: assets stay
    // project-bound, geometry is strict, and builds target persisted ids.
    {
      const before = await state();
      const importedSlide = before.model.slides.find((slide) => Number.isInteger(slide.src));
      const importedElement = importedSlide.elements.find((element) => element.ref);
      const priorAnimations = Array.isArray(importedSlide.animations)
        ? JSON.parse(JSON.stringify(importedSlide.animations))
        : [];
      const beforeInvalidRev = before.model.rev;
      const invalidOps = [
        { type: 'add-image', slideId: importedSlide.id, source: '../outside.png', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { type: 'add-image', slideId: importedSlide.id, source: 'suite/server.js', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { type: 'add-image', slideId: importedSlide.id, source: 'assets/missing.png', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { type: 'add-image', slideId: importedSlide.id, source: 'assets/test-image.png', x: 0.9, y: 0.1, w: 0.2, h: 0.2 },
      ];
      const invalidResponses = [];
      for (const op of invalidOps) invalidResponses.push(await editOp(op));
      const afterInvalid = await state();
      record('add-image rejects paths outside assets, non-images, missing files, and overflow geometry', () =>
        invalidResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected local images do not mutate or revise the deck', () =>
        afterInvalid.model.rev === beforeInvalidRev);

      const added = await editOp({
        type: 'add-image', slideId: importedSlide.id,
        source: path.join(assetsDir, 'test-image.png'),
        x: 0.6, y: 0.1, w: 0.2, h: 0.2,
      });
      const imageId = added.body.affected && added.body.affected.decorId;
      const afterAdded = await state();
      const image = afterAdded.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === imageId);
      record('add-image persists a normalized project-relative generated picture contract', () =>
        added.status === 200 && JSON.stringify(image) === JSON.stringify({
          id: imageId, kind: 'pic', sid: null, generated: true,
          source: 'assets/test-image.png',
          box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 },
        }));

      // ---- set-image: in-place source swap that preserves identity, geometry,
      // z-order, and the same durable object-history stream (set-media's
      // contract, for pictures).
      const nonGeneratedDecor = (importedSlide.decor || []).find((decor) => decor.generated !== true);
      const beforeImageSwapRev = afterAdded.model.rev;
      const imageIndexBefore = afterAdded.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.findIndex((decor) => decor.id === imageId);
      const invalidImageSwaps = [
        { type: 'set-image', slideId: importedSlide.id, source: 'assets/test-image-2.png' },
        { type: 'set-image', slideId: importedSlide.id, decorId: 'missing-pic', source: 'assets/test-image-2.png' },
        { type: 'set-image', slideId: importedSlide.id, decorId: imageId, source: '../outside.png' },
        { type: 'set-image', slideId: importedSlide.id, decorId: imageId, source: 'assets/missing.png' },
        { type: 'set-image', slideId: importedSlide.id, decorId: imageId, source: 'suite/server.js' },
      ];
      if (nonGeneratedDecor) {
        invalidImageSwaps.push({
          type: 'set-image', slideId: importedSlide.id, decorId: nonGeneratedDecor.id,
          source: 'assets/test-image-2.png',
        });
      }
      const invalidImageSwapResponses = [];
      for (const op of invalidImageSwaps) invalidImageSwapResponses.push(await editOp(op));
      const afterInvalidImageSwaps = await state();
      const imageAfterInvalidSwaps = afterInvalidImageSwaps.model.slides
        .find((slide) => slide.id === importedSlide.id).decor.find((decor) => decor.id === imageId);
      record('set-image rejects missing targets, unsafe or non-image sources, and non-generated decor', () =>
        invalidImageSwapResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected set-image calls preserve both revision and picture state', () =>
        afterInvalidImageSwaps.model.rev === beforeImageSwapRev &&
        imageAfterInvalidSwaps.source === 'assets/test-image.png');

      const historyBeforeImageSwap = await objectHistory(importedSlide.id, 'decor', imageId);
      const imageSwapped = await editOp({
        type: 'set-image', slideId: importedSlide.id, decorId: imageId,
        source: path.join(assetsDir, 'test-image-2.png'),
      });
      const afterImageSwap = await state();
      const swappedSlide = afterImageSwap.model.slides.find((slide) => slide.id === importedSlide.id);
      const swappedImage = swappedSlide.decor.find((decor) => decor.id === imageId);
      const historyAfterImageSwap = await objectHistory(importedSlide.id, 'decor', imageId);
      record('set-image swaps a normalized source in place with exact affected-pic semantics', () =>
        imageSwapped.status === 200 &&
        JSON.stringify(imageSwapped.body.affected) === JSON.stringify({
          slideId: importedSlide.id, decorId: imageId, pic: true,
        }) &&
        swappedImage.source === 'assets/test-image-2.png' &&
        swappedSlide.decor.findIndex((decor) => decor.id === imageId) === imageIndexBefore &&
        JSON.stringify(swappedImage.box) === JSON.stringify({ x: 0.6, y: 0.1, w: 0.2, h: 0.2 }));
      record('set-image appends to the same durable object-history identity', () => {
        if (historyBeforeImageSwap.status !== 200 || historyAfterImageSwap.status !== 200) return false;
        const beforeHistory = historyBeforeImageSwap.body;
        const afterHistory = historyAfterImageSwap.body;
        const head = afterHistory.versions.find((version) => version.id === afterHistory.headId);
        const beforeHead = beforeHistory.versions.find((version) => version.id === beforeHistory.headId);
        // Version sources are content-addressed snapshot paths, not the live
        // asset path, so assert identity and that the snapshot content moved.
        return afterHistory.target.objectId === imageId && afterHistory.target.objectKind === 'decor' &&
          afterHistory.versions.length === beforeHistory.versions.length + 1 &&
          afterHistory.versions.some((version) => version.id === beforeHistory.headId) &&
          afterHistory.headId !== beforeHistory.headId &&
          head && head.state.object.id === imageId &&
          beforeHead && head.state.object.source !== beforeHead.state.object.source &&
          JSON.stringify(head.state.object.box) === JSON.stringify({ x: 0.6, y: 0.1, w: 0.2, h: 0.2 });
      });
      const imageRestoredBack = await editOp({
        type: 'set-image', slideId: importedSlide.id, decorId: imageId,
        source: 'assets/test-image.png',
      });
      record('set-image swaps back cleanly for the downstream animation and delete checks', () =>
        imageRestoredBack.status === 200);

      const animated = await editOp({
        type: 'set-animation', slideId: importedSlide.id, targetId: imageId,
        effect: 'rise-up', trigger: 'click', duration: 0.6, delay: 0,
      });
      const chained = await editOp({
        type: 'set-animation', slideId: importedSlide.id, targetId: importedElement.id,
        effect: 'fade', trigger: 'after-previous', duration: 0.4, delay: 0.2,
      });
      const animationState = await state();
      const animations = animationState.model.slides.find((slide) => slide.id === importedSlide.id).animations;
      record('set-animation persists an ordered click build and chained native build', () =>
        animated.status === 200 && chained.status === 200 &&
        JSON.stringify(animations.slice(0, priorAnimations.length)) ===
          JSON.stringify(priorAnimations) &&
        JSON.stringify(animations.slice(priorAnimations.length)) === JSON.stringify([
          { targetId: imageId, effect: 'rise-up', trigger: 'click', duration: 0.6, delay: 0 },
          { targetId: importedElement.id, effect: 'fade', trigger: 'after-previous', duration: 0.4, delay: 0.2 },
        ]));

      const invalidAnimations = [
        { type: 'set-animation', slideId: importedSlide.id, targetId: 'missing', effect: 'fade' },
        { type: 'set-animation', slideId: importedSlide.id, targetId: imageId, effect: 'spin' },
        { type: 'set-animation', slideId: importedSlide.id, targetId: imageId, effect: 'fade', duration: 0 },
        { type: 'set-animation', slideId: importedSlide.id, targetId: imageId, effect: 'none', duration: 0.5 },
      ];
      const invalidAnimationResponses = [];
      for (const op of invalidAnimations) invalidAnimationResponses.push(await editOp(op));
      record('set-animation rejects unknown targets/effects, invalid timing, and malformed removal', () =>
        invalidAnimationResponses.every((response) => response.status === 400 && response.body.ok === false));

      const removed = await editOp({
        type: 'delete-decor', slideId: importedSlide.id, decorId: imageId,
      });
      const afterRemoved = await state();
      const removedSlide = afterRemoved.model.slides.find((slide) => slide.id === importedSlide.id);
      record('deleting a generated image also removes its dangling animation', () =>
        removed.status === 200 &&
        !removedSlide.decor.some((decor) => decor.id === imageId) &&
        !removedSlide.animations.some((animation) => animation.targetId === imageId));
    }

    // ---- embedded MP4 overlays: only project assets survive normalization,
    // autoplay/loop default on, geometry remains editable, and media is not
    // admitted into the separate object-animation sequence.
    {
      const before = await state();
      const importedSlide = before.model.slides.find((slide) => Number.isInteger(slide.src));
      const beforeInvalidRev = before.model.rev;
      const invalidOps = [
        { type: 'add-video', slideId: importedSlide.id, source: '../outside.mp4', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        { type: 'add-video', slideId: importedSlide.id, source: 'suite/server.js', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        { type: 'add-video', slideId: importedSlide.id, source: 'assets/missing.mp4', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        { type: 'add-video', slideId: importedSlide.id, source: 'assets/test-video.mov', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        { type: 'add-video', slideId: importedSlide.id, source: 'assets/test-video.mp4', x: 0.8, y: 0.1, w: 0.3, h: 0.3 },
        { type: 'add-video', slideId: importedSlide.id, source: 'assets/test-video.mp4', x: 0.1, y: 0.1, w: 0.3, h: 0.3, autoplay: 'true' },
        { type: 'add-video', slideId: importedSlide.id, source: 'assets/test-video.mp4', x: 0.1, y: 0.1, w: 0.3, h: 0.3, loop: 1 },
      ];
      const invalidResponses = [];
      for (const op of invalidOps) invalidResponses.push(await editOp(op));
      const afterInvalid = await state();
      record('add-video rejects escapes, non-MP4s, missing files, overflow, and non-boolean playback flags', () =>
        invalidResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected videos do not mutate or revise the deck', () =>
        afterInvalid.model.rev === beforeInvalidRev);

      const added = await editOp({
        type: 'add-video', slideId: importedSlide.id,
        source: path.join(assetsDir, 'test-video.mp4'),
        x: 0.2, y: 0.15, w: 0.4, h: 0.35,
      });
      const mediaId = added.body.affected && added.body.affected.decorId;
      const afterAdded = await state();
      const media = afterAdded.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === mediaId);
      record('add-video persists normalized generated media with autoplay and loop defaults', () =>
        added.status === 200 && JSON.stringify(media) === JSON.stringify({
          id: mediaId, kind: 'media', sid: null, generated: true,
          source: 'assets/test-video.mp4',
          box: { x: 0.2, y: 0.15, w: 0.4, h: 0.35 },
          autoplay: true, loop: true,
        }));

      const resized = await editOp({
        type: 'set-box', slideId: importedSlide.id, decorId: mediaId,
        x: 0.25, w: 0.35,
      });
      const afterResize = await state();
      const resizedMedia = afterResize.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.find((decor) => decor.id === mediaId);
      record('set-box moves and resizes generated media', () =>
        resized.status === 200 &&
        JSON.stringify(resizedMedia.box) ===
          JSON.stringify({ x: 0.25, y: 0.15, w: 0.35, h: 0.35 }));

      const mediaIndex = afterResize.model.slides.find((slide) => slide.id === importedSlide.id)
        .decor.findIndex((decor) => decor.id === mediaId);
      const importedDecor = (importedSlide.decor || []).find((decor) => decor.generated !== true);
      const beforeMediaUpdateRev = afterResize.model.rev;
      const beforeMediaUpdate = JSON.stringify(resizedMedia);
      const invalidMediaUpdates = [
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, source: null },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, source: '../outside.mp4' },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, source: 'assets/missing.mp4' },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, source: 'assets/test-video.mov' },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, autoplay: 'false' },
        { type: 'set-media', slideId: importedSlide.id, decorId: mediaId, loop: 0 },
        { type: 'set-media', slideId: importedSlide.id, decorId: 'missing-media', autoplay: false },
      ];
      if (importedDecor) {
        invalidMediaUpdates.push({
          type: 'set-media', slideId: importedSlide.id, decorId: importedDecor.id, autoplay: false,
        });
      }
      const invalidMediaUpdateResponses = [];
      for (const op of invalidMediaUpdates) invalidMediaUpdateResponses.push(await editOp(op));
      const afterInvalidMediaUpdates = await state();
      const mediaAfterInvalidUpdates = afterInvalidMediaUpdates.model.slides
        .find((slide) => slide.id === importedSlide.id).decor.find((decor) => decor.id === mediaId);
      record('set-media rejects empty patches, unsafe or non-MP4 sources, malformed flags, and wrong targets', () =>
        !!importedDecor &&
        invalidMediaUpdateResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected set-media calls preserve both revision and media state', () =>
        afterInvalidMediaUpdates.model.rev === beforeMediaUpdateRev &&
        JSON.stringify(mediaAfterInvalidUpdates) === beforeMediaUpdate);

      const historyBeforePlayback = await objectHistory(importedSlide.id, 'decor', mediaId);
      const playbackUpdated = await editOp({
        type: 'set-media', slideId: importedSlide.id, decorId: mediaId,
        autoplay: false, loop: false,
      });
      const afterPlaybackUpdate = await state();
      const playbackSlide = afterPlaybackUpdate.model.slides.find((slide) => slide.id === importedSlide.id);
      const playbackMedia = playbackSlide.decor.find((decor) => decor.id === mediaId);
      const historyAfterPlayback = await objectHistory(importedSlide.id, 'decor', mediaId);
      record('set-media updates playback in place with exact affected-media semantics', () =>
        playbackUpdated.status === 200 &&
        JSON.stringify(playbackUpdated.body.affected) === JSON.stringify({
          slideId: importedSlide.id, decorId: mediaId, media: true,
        }) &&
        playbackMedia.autoplay === false && playbackMedia.loop === false &&
        playbackMedia.source === 'assets/test-video.mp4' &&
        playbackSlide.decor.findIndex((decor) => decor.id === mediaId) === mediaIndex &&
        JSON.stringify(playbackMedia.box) === JSON.stringify(resizedMedia.box));
      record('set-media appends to the same durable object-history identity', () => {
        if (historyBeforePlayback.status !== 200 || historyAfterPlayback.status !== 200) return false;
        const beforeHistory = historyBeforePlayback.body;
        const afterHistory = historyAfterPlayback.body;
        const head = afterHistory.versions.find((version) => version.id === afterHistory.headId);
        return afterHistory.target.objectId === mediaId && afterHistory.target.objectKind === 'decor' &&
          afterHistory.versions.length === beforeHistory.versions.length + 1 &&
          afterHistory.versions.some((version) => version.id === beforeHistory.headId) &&
          head && head.state.object.id === mediaId &&
          head.state.object.autoplay === false && head.state.object.loop === false;
      });

      const sourceUpdated = await editOp({
        type: 'set-media', slideId: importedSlide.id, decorId: mediaId,
        source: path.join(assetsDir, 'test-video-2.mp4'),
      });
      const afterSourceUpdate = await state();
      const sourceSlide = afterSourceUpdate.model.slides.find((slide) => slide.id === importedSlide.id);
      const sourceMedia = sourceSlide.decor.find((decor) => decor.id === mediaId);
      const historyAfterSource = await objectHistory(importedSlide.id, 'decor', mediaId);
      record('set-media normalizes a replacement asset without resetting playback, box, id, or order', () =>
        sourceUpdated.status === 200 &&
        sourceMedia.id === mediaId && sourceMedia.source === 'assets/test-video-2.mp4' &&
        sourceMedia.autoplay === false && sourceMedia.loop === false &&
        sourceSlide.decor.findIndex((decor) => decor.id === mediaId) === mediaIndex &&
        JSON.stringify(sourceMedia.box) === JSON.stringify(resizedMedia.box));
      record('a source replacement remains in the existing ten-version history stream', () =>
        historyAfterSource.status === 200 && historyAfterPlayback.status === 200 &&
        historyAfterSource.body.versions.length === historyAfterPlayback.body.versions.length + 1 &&
        historyAfterSource.body.versions.some((version) => version.id === historyAfterPlayback.body.headId));

      const animated = await editOp({
        type: 'set-animation', slideId: importedSlide.id,
        targetId: mediaId, effect: 'fade',
      });
      record('set-animation refuses generated media without mutating playback', () =>
        animated.status === 400 && animated.body.ok === false &&
        /media playback/i.test(animated.body.error));

      const removed = await editOp({
        type: 'delete-decor', slideId: importedSlide.id, decorId: mediaId,
      });
      const afterRemoved = await state();
      record('delete-decor removes generated media', () =>
        removed.status === 200 &&
        !afterRemoved.model.slides.find((slide) => slide.id === importedSlide.id)
          .decor.some((decor) => decor.id === mediaId));
    }

    // ---- delete-slide: cannot delete the last remaining slide
    {
      const ids = (await state()).model.slides.map((s) => s.id);
      for (let i = 1; i < ids.length; i++) await editOp({ type: 'delete-slide', slideId: ids[i] });
      const beforeCount = (await state()).model.slides.length;
      const r = await editOp({ type: 'delete-slide', slideId: ids[0] });
      const afterCount = (await state()).model.slides.length;
      record('delete-slide refuses to delete the last remaining slide', () => r.body.ok === false && beforeCount === 1 && afterCount === 1);
    }

    const addBack = await editOp({ type: 'add-slide', title: 'Slide B' });
    record('add-slide (bare, no index/after) succeeds and returns a new slideId', () => addBack.body.ok === true && typeof addBack.body.affected.slideId === 'string');
    {
      const nativeSlideId = addBack.body.affected.slideId;
      const nativeBefore = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      const nativeElementId = nativeBefore.elements[0].id;
      const nativeStateBeforeBox = await state();
      const nativeUndoBeforeBox = nativeStateBeforeBox.undoCount;
      const nativeRedoBeforeBox = nativeStateBeforeBox.redoCount;
      const incompleteNativeBox = await editOp({
        type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId,
        x: 0.2
      });
      const explicitNativeBox = { x: 0.08, y: 0.06, w: 0.84, h: 0.12 };
      const nativeTextBox = await editOp({
        type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId,
        ...explicitNativeBox
      });
      const nativeAfterBox = await state();
      const boxedNativeElement = nativeAfterBox.model.slides
        .find((slide) => slide.id === nativeSlideId).elements
        .find((element) => element.id === nativeElementId);
      const diskAfterNativeBox = JSON.parse(
        fs.readFileSync(path.join(suiteDir, 'data', 'model.json'), 'utf8')
      );
      const diskNativeElement = diskAfterNativeBox.slides
        .find((slide) => slide.id === nativeSlideId).elements
        .find((element) => element.id === nativeElementId);
      const nativeBoxHistory = await objectHistory(nativeSlideId, 'element', nativeElementId);
      record('set-box requires a complete first box and persists exact normalized geometry for native text', () =>
        incompleteNativeBox.status === 400 && incompleteNativeBox.body.ok === false &&
        nativeTextBox.status === 200 && nativeTextBox.body.ok === true &&
        JSON.stringify(boxedNativeElement.box) === JSON.stringify(explicitNativeBox) &&
        JSON.stringify(diskNativeElement.box) === JSON.stringify(explicitNativeBox) &&
        nativeAfterBox.model.rev === nativeStateBeforeBox.model.rev + 1 &&
        nativeAfterBox.undoCount === nativeUndoBeforeBox + 1 &&
        nativeAfterBox.redoCount === 0 && nativeRedoBeforeBox === 0);
      record('native text geometry participates in object history', () =>
        nativeBoxHistory.status === 200 && nativeBoxHistory.body &&
        Array.isArray(nativeBoxHistory.body.versions) && nativeBoxHistory.body.versions.length >= 2);

      let undoNativeBox = { status: 0 };
      let redoNativeBox = { status: 0 };
      let nativeAfterUndo = boxedNativeElement;
      let nativeAfterRedo = boxedNativeElement;
      if (nativeTextBox.status === 200) {
        undoNativeBox = await api('POST', '/api/undo', { editor: 'applyop-test' });
        nativeAfterUndo = (await state()).model.slides
          .find((slide) => slide.id === nativeSlideId).elements
          .find((element) => element.id === nativeElementId);
        redoNativeBox = await api('POST', '/api/redo', { editor: 'applyop-test' });
        nativeAfterRedo = (await state()).model.slides
          .find((slide) => slide.id === nativeSlideId).elements
          .find((element) => element.id === nativeElementId);
      }
      record('undo removes and redo restores the exact native text box', () =>
        undoNativeBox.status === 200 && nativeAfterUndo.box === undefined &&
        redoNativeBox.status === 200 &&
        JSON.stringify(nativeAfterRedo.box) === JSON.stringify(explicitNativeBox));

      const beforeRejectedNativeBoxes = await state();
      const wrongSlideId = beforeRejectedNativeBoxes.model.slides
        .find((slide) => slide.id !== nativeSlideId).id;
      const rejectedNativeBoxes = [
        await editOp({ type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId, x: null }),
        await editOp({ type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId, x: -0.01 }),
        await editOp({ type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId, w: 1.01 }),
        await editOp({ type: 'set-box', slideId: nativeSlideId, elementId: nativeElementId, x: 0.9 }),
        await editOp({ type: 'set-box', slideId: wrongSlideId, elementId: nativeElementId, x: 0.2 }),
      ];
      const afterRejectedNativeBoxes = await state();
      record('native text set-box rejects NaN-over-wire, range, overflow, and wrong-slide attempts', () =>
        rejectedNativeBoxes.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected native text boxes do not mutate model, revision, or undo and redo history', () =>
        JSON.stringify(afterRejectedNativeBoxes.model) === JSON.stringify(beforeRejectedNativeBoxes.model) &&
        afterRejectedNativeBoxes.undoCount === beforeRejectedNativeBoxes.undoCount &&
        afterRejectedNativeBoxes.redoCount === beforeRejectedNativeBoxes.redoCount);

      const invalidOutline = await editOp({
        type: 'set-outline', slideId: nativeSlideId, elementId: nativeElementId,
        color: 'blue'
      });
      const validOutline = await editOp({
        type: 'set-outline', slideId: nativeSlideId, elementId: nativeElementId,
        color: '#ABCDEF'
      });
      const outlinedElement = (await state()).model.slides
        .find((slide) => slide.id === nativeSlideId).elements
        .find((element) => element.id === nativeElementId);
      record('set-outline rejects non-hex colors and persists an exact card edge color', () =>
        invalidOutline.status === 400 && invalidOutline.body.ok === false &&
        validOutline.status === 200 && validOutline.body.ok === true &&
        outlinedElement.style.outline === '#ABCDEF');

      const nativeShape = await editOp({
        type: 'add-shape', slideId: nativeSlideId,
        x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: '#112233'
      });
      const shapeId = nativeShape.body.affected && nativeShape.body.affected.decorId;
      let nativeState = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      let shape = nativeState.decor.find((decor) => decor.id === shapeId);
      const addedShapeSnapshot = JSON.stringify(shape);
      record('add-shape persists generated rectangles on suite-native slides', () =>
        nativeShape.status === 200 && nativeShape.body.ok === true &&
        addedShapeSnapshot === JSON.stringify({
          id: shapeId, kind: 'shape', sid: null, generated: true,
          shapeType: 'rect', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          fill: '#112233'
        }));

      const nativeFill = await editOp({
        type: 'set-fill', slideId: nativeSlideId, decorId: shapeId,
        color: '#2A78D6'
      });
      const nativeShapeBox = await editOp({
        type: 'set-box', slideId: nativeSlideId, decorId: shapeId,
        x: 0.15, w: 0.25
      });
      nativeState = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      shape = nativeState.decor.find((decor) => decor.id === shapeId);
      record('set-fill and set-box retain their strict semantics for native generated rectangles', () =>
        nativeFill.status === 200 && nativeShapeBox.status === 200 &&
        shape.fill === '#2A78D6' &&
        JSON.stringify(shape.box) ===
          JSON.stringify({ x: 0.15, y: 0.1, w: 0.25, h: 0.2 }));

      const nativeImage = await editOp({
        type: 'add-image', slideId: nativeSlideId,
        source: path.join(assetsDir, 'test-image.png'),
        x: 0.45, y: 0.1, w: 0.2, h: 0.2,
      });
      const imageId = nativeImage.body.affected && nativeImage.body.affected.decorId;
      const nativeImageAnimation = await editOp({
        type: 'set-animation', slideId: nativeSlideId, targetId: imageId,
        effect: 'fade', trigger: 'click', duration: 0.4, delay: 0,
      });
      nativeState = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      const image = nativeState.decor.find((decor) => decor.id === imageId);
      const nativeImageAnimations = JSON.parse(JSON.stringify(nativeState.animations || []));
      record('add-image and set-animation support suite-native generated pictures', () =>
        nativeImage.status === 200 && nativeImageAnimation.status === 200 &&
        image && image.source === 'assets/test-image.png' &&
        nativeImageAnimations.some((animation) =>
          animation.targetId === imageId && animation.effect === 'fade'));

      const nativeVideo = await editOp({
        type: 'add-video', slideId: nativeSlideId,
        source: path.join(assetsDir, 'test-video.mp4'),
        x: 0.1, y: 0.4, w: 0.3, h: 0.25,
        autoplay: false, loop: true,
      });
      const videoId = nativeVideo.body.affected && nativeVideo.body.affected.decorId;
      const nativeVideoBox = await editOp({
        type: 'set-box', slideId: nativeSlideId, decorId: videoId,
        y: 0.45, h: 0.2,
      });
      const nativeVideoAnimation = await editOp({
        type: 'set-animation', slideId: nativeSlideId, targetId: videoId,
        effect: 'fade',
      });
      nativeState = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      const video = nativeState.decor.find((decor) => decor.id === videoId);
      record('add-video and set-box support suite-native embedded media', () =>
        nativeVideo.status === 200 && nativeVideoBox.status === 200 &&
        video && video.autoplay === false && video.loop === true &&
        JSON.stringify(video.box) ===
          JSON.stringify({ x: 0.1, y: 0.45, w: 0.3, h: 0.2 }));
      record('native generated media remains separate from object animations', () =>
        nativeVideoAnimation.status === 400 &&
        /media playback/i.test(nativeVideoAnimation.body.error));

      const removedImage = await editOp({
        type: 'delete-decor', slideId: nativeSlideId, decorId: imageId,
      });
      const removedVideo = await editOp({
        type: 'delete-decor', slideId: nativeSlideId, decorId: videoId,
      });
      const removedShape = await editOp({
        type: 'delete-decor', slideId: nativeSlideId, decorId: shapeId,
      });
      nativeState = (await state()).model.slides.find((slide) => slide.id === nativeSlideId);
      record('delete-decor removes every native generated decor kind and its animation', () =>
        [removedImage, removedVideo, removedShape].every((response) => response.status === 200) &&
        (!nativeState.decor || nativeState.decor.length === 0) &&
        !nativeState.animations);
    }

    // ---- set-transition: normalize the supported fade/none model shape and
    // reject malformed timing without changing the deck.
    {
      const slideId = (await state()).model.slides[0].id;
      const fadeDefault = await editOp({ type: 'set-transition', slideId, effect: 'fade' });
      const afterDefault = await state();
      const defaultTransition = afterDefault.model.slides.find((slide) => slide.id === slideId).transition;
      record('set-transition defaults fade duration to 0.35 seconds', () =>
        fadeDefault.status === 200 && fadeDefault.body.ok === true
          && JSON.stringify(defaultTransition) === JSON.stringify({ effect: 'fade', duration: 0.35 }));

      const lower = await editOp({ type: 'set-transition', slideId, effect: 'fade', duration: 0.1 });
      const afterLower = await state();
      const upper = await editOp({ type: 'set-transition', slideId, effect: 'fade', duration: 10 });
      const afterUpper = await state();
      record('set-transition accepts both inclusive fade-duration boundaries', () =>
        lower.status === 200 && upper.status === 200
          && afterLower.model.slides.find((slide) => slide.id === slideId).transition.duration === 0.1
          && afterUpper.model.slides.find((slide) => slide.id === slideId).transition.duration === 10);

      const none = await editOp({ type: 'set-transition', slideId, effect: 'none' });
      const afterNone = await state();
      const noneTransition = afterNone.model.slides.find((slide) => slide.id === slideId).transition;
      record('set-transition none removes the obsolete fade duration', () =>
        none.status === 200 && none.body.ok === true
          && JSON.stringify(noneTransition) === JSON.stringify({ effect: 'none' }));

      const beforeInvalid = await state();
      const invalidOps = [
        { type: 'set-transition', slideId },
        { type: 'set-transition', slideId, effect: 'push' },
        { type: 'set-transition', slideId, effect: 'fade', duration: null },
        { type: 'set-transition', slideId, effect: 'fade', duration: '0.35' },
        { type: 'set-transition', slideId, effect: 'fade', duration: true },
        { type: 'set-transition', slideId, effect: 'fade', duration: 0.099 },
        { type: 'set-transition', slideId, effect: 'fade', duration: 10.001 },
        { type: 'set-transition', slideId, effect: 'none', duration: 0.35 },
      ];
      const invalidResponses = [];
      for (const op of invalidOps) invalidResponses.push(await editOp(op));
      const afterInvalid = await state();
      record('set-transition rejects unsupported effects and malformed durations', () =>
        invalidResponses.every((response) => response.status === 400 && response.body.ok === false));
      record('rejected set-transition variants do not mutate or revise the deck', () =>
        JSON.stringify(afterInvalid.model) === JSON.stringify(beforeInvalid.model));
    }

    // ---- set-theme: accent must be #RRGGBB hex
    {
      const bad = await editOp({ type: 'set-theme', accent: 'not-a-color' });
      const good = await editOp({ type: 'set-theme', accent: '#112233' });
      record('set-theme rejects a non-hex accent', () => bad.body.ok === false);
      record('set-theme accepts a valid #RRGGBB accent', () => good.body.ok === true);
    }

    // ---- add-slide: layout must be a string (a non-string reaches Python's
    // `key in LAYOUT_MAP` dict-membership test and crashes the whole render)
    {
      const bad = await editOp({ type: 'add-slide', layout: ['not', 'a', 'string'], title: 'Bad Layout' });
      record('add-slide rejects a non-string layout', () => bad.body.ok === false);
    }

    // ---- set-box: x/y/w/h must be a genuine number. A garbage CLI value
    // (parseFloat -> NaN -> JSON.stringify -> null) used to coerce via
    // Number(null) === 0, a value inside the legal 0..1 range, and silently
    // "succeed" by snapping the element to 0.
    {
      const s = (await state()).model.slides[0];
      const el = s.elements[0];
      const before = JSON.stringify(el.box);
      const bad = await editOp({ type: 'set-box', slideId: s.id, elementId: el.id, x: null });
      const after = JSON.stringify((await state()).model.slides[0].elements[0].box);
      record('set-box rejects a null x (the NaN-over-the-wire case) instead of silently coercing it to 0', () => bad.body.ok === false && before === after);
    }

    // ---- add-slide: an explicitly-given index/after must resolve to
    // something real, not silently fall back to append-at-the-end
    {
      const beforeCount = (await state()).model.slides.length;
      const badIndex = await editOp({ type: 'add-slide', index: 'not-an-int', title: 'Bad Index' });
      const badAfter = await editOp({ type: 'add-slide', after: 'nonexistent-slide-id', title: 'Bad After' });
      const afterCount = (await state()).model.slides.length;
      record('add-slide rejects a non-integer index', () => badIndex.body.ok === false);
      record('add-slide rejects an --after id matching no real slide', () => badAfter.body.ok === false);
      record('neither rejected add-slide call mutated the deck', () => beforeCount === afterCount);
    }

    // ---- a legitimate index/after still work (no regression from the above)
    {
      const s1 = (await state()).model.slides[0];
      const r = await editOp({ type: 'add-slide', after: s1.id, title: 'Right After Slide 1' });
      const s = await state();
      record('add-slide with a real --after id still succeeds and lands right after it', () => r.body.ok === true && s.model.slides[1].elements.some((e) => e.text === 'Right After Slide 1'));
    }
  } finally {
    // kill() only SENDS the signal; on Windows the OS still holds the child's
    // cwd open for a beat after that, so rmSync-ing it immediately raced an
    // EBUSY (verified: reproduced on the very first run of this file).
    // Waiting for the actual 'exit' event before cleanup removes the race.
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(resolve, 3000); // don't hang the test suite if the kill itself is ever slow to land
    });
    // Even after the child has genuinely exited, a file it had open (seen in
    // practice: the boot-time thumbs pass's thumbs-src.pptx, likely still
    // held a beat longer by a spawned PowerShell/COM helper) can leave
    // Windows holding a handle open just long enough to fail a same-tick
    // rmSync with EBUSY. A short retry loop clears this reliably instead of
    // leaking a whole sandbox copy into the OS temp folder every time this
    // file runs (confirmed: without this, two prior runs of this exact test
    // left two orphaned copies behind).
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (e) {
        if (attempt === 4) console.log('(cleanup warning, sandbox left at ' + sandbox + ': ' + e.message + ')');
        else await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  let pass = 0, fail = 0;
  for (const c of cases) {
    let ok;
    try { ok = !!c.fn(); } catch (e) { ok = false; console.log(`   (threw: ${e.message})`); }
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✓' : '✗ FAIL'}  ${c.desc}`);
  }
  console.log('');
  console.log(`${pass}/${cases.length} passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
