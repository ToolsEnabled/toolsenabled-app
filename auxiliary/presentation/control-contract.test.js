#!/usr/bin/env node
'use strict';
/*
 * End-to-end contracts for the two non-browser control surfaces. A fake
 * loopback coordinator injects failures and malformed values; no suite data
 * or live presentation is read or written.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

function runCli(port, command, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const args = Array.isArray(command) ? command : [command];
    const child = spawn(process.execPath, [path.join(HERE, 'ppt.js'), ...args], {
      cwd: HERE,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        SUITE_HOST: '127.0.0.1',
        SUITE_PORT: String(port),
        SUITE_EDITOR: 'control-contract-test',
        SUITE_HTTP_TIMEOUT_MS: '1000',
        NO_COLOR: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

function createRpc(child) {
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        clearTimeout(waiter.timer);
        waiter.resolve(response);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}: ${stderr}`));
      }, 5000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
}

async function main() {
  let pauseMode = 'fail';
  let resumeMode = 'fail';
  let renderMode = 'success';
  let lintMode = 'error';
  let timingMode = 'error';
  let protectionsMode = 'success';
  let protections = [];
  let protectionHistory = [];
  let protectionTs = 1;
  const slideTransitions = {
    s1: { effect: 'fade', duration: 0.35 },
    s2: { effect: 'none' },
    s3: undefined,
  };
  const seen = [];
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/health') return res.end('{"ok":true}');
      if (req.url === '/api/heartbeat') return res.end('{"ok":true}');
      if (req.url === '/api/state') {
        const slides = ['s1', 's2', 's3'].map((id) => ({
          id,
          layout: 'content',
          ...(slideTransitions[id] ? { transition: slideTransitions[id] } : {}),
          elements: id === 's1' ? [{ id: 'e1', type: 'title', text: 'Protected text' }] : [],
          decor: id === 's1' ? [{ id: 'path-guy', kind: 'pic' }] : [],
        }));
        return res.end(JSON.stringify({
          ok: true,
          model: { title: 'Transition Contract Deck', rev: 17, slides },
          locks: [],
          protections,
          protectionHistory,
          paused: false,
        }));
      }
      if (req.url === '/api/protections') {
        if (protectionsMode === 'malformed') return res.end('{"protections":{}}');
        if (protectionsMode === 'malformed-history') {
          return res.end(JSON.stringify({ protections, protectionHistory: [{ action: 'unlock' }] }));
        }
        if (protectionsMode === 'error') {
          res.statusCode = 500;
          return res.end('{"ok":false,"error":"protection list failed"}');
        }
        return res.end(JSON.stringify({ protections, protectionHistory }));
      }
      if (req.url === '/api/protections/toggle') {
        if (protectionsMode === 'error') {
          res.statusCode = 500;
          return res.end('{"ok":false,"error":"protection persistence failed"}');
        }
        const target = {
          kind: body.kind,
          slideId: body.slideId,
          ...(body.kind === 'object'
            ? { objectId: body.objectId, objectKind: body.objectKind }
            : {}),
        };
        if (protectionsMode === 'missing-audit') {
          return res.end(JSON.stringify({
            ok: true,
            changed: false,
            protected: body.protected,
            protection: target,
            protections,
          }));
        }
        const key = (item) => item.kind === 'slide'
          ? `slide:${item.slideId}`
          : `object:${item.slideId}:${item.objectKind}:${item.objectId}`;
        const existing = protections.find((item) => key(item) === key(body));
        const changed = body.protected ? !existing : !!existing;
        const ts = protectionTs++;
        let changedProtection = existing || target;
        if (body.protected && !existing) {
          changedProtection = Object.assign({}, target, { by: body.by, createdAt: ts });
          protections.push(changedProtection);
        } else if (!body.protected && existing) {
          protections = protections.filter((item) => key(item) !== key(body));
        }
        let change;
        if (changed) {
          change = Object.assign({
            action: body.protected ? 'lock' : 'unlock',
            kind: body.kind,
            slideId: body.slideId,
            by: body.by,
            ts,
          }, body.kind === 'object'
            ? { objectId: body.objectId, objectKind: body.objectKind }
            : {});
          protectionHistory.push(change);
        }
        return res.end(JSON.stringify({
          ok: true,
          changed,
          protected: body.protected,
          protection: changedProtection,
          protections,
          protectionHistory,
          ...(change ? { change } : {}),
        }));
      }
      if (req.url === '/api/lint') {
        if (lintMode === 'malformed') return res.end('{}');
        res.statusCode = 500;
        return res.end('{"ok":false,"error":"font helper failed"}');
      }
      if (req.url === '/api/timing') {
        if (timingMode === 'malformed') return res.end('{}');
        res.statusCode = 500;
        return res.end('{"ok":false,"error":"timing failed"}');
      }
      if (req.url === '/api/pause') {
        if (pauseMode === 'hang') return;
        if (pauseMode === 'empty') return res.end('{}');
        if (pauseMode === 'wrong-state') return res.end('{"paused":false}');
        if (pauseMode === 'success') return res.end('{"paused":true}');
        res.statusCode = 500;
        return res.end('{"ok":false,"error":"pause lock verification failed"}');
      }
      if (req.url === '/api/resume') {
        if (resumeMode === 'empty') return res.end('{}');
        if (resumeMode === 'wrong-state') return res.end('{"paused":true}');
        if (resumeMode === 'success') return res.end('{"paused":false}');
        res.statusCode = 200;
        return res.end('{"ok":false,"error":"resume state was not saved"}');
      }
      if (req.url === '/api/render') {
        if (renderMode === 'paused') {
          res.statusCode = 423;
          return res.end('{"ok":false,"error":"paused","pausedBy":"human"}');
        }
        if (renderMode === 'missing') {
          res.statusCode = 404;
          return res.end('{"ok":false,"error":"not found"}');
        }
        return res.end('{"ok":true,"rev":17}');
      }
      if (req.url === '/api/locks') {
        return res.end(JSON.stringify({
          ok: true,
          locked: ['s1'],
          conflicts: [{ slideId: 's2', heldBy: 'other-editor' }],
          unknown: []
        }));
      }
      if (req.url === '/api/locks/release') {
        return res.end(JSON.stringify({ ok: true, released: false, notMine: ['s1'] }));
      }
      if (req.url === '/api/edit') {
        const op = body && body.op;
        if (op && op.type === 'add-shape') {
          return res.end(JSON.stringify({
            ok: true,
            rev: 18,
            affected: { slideId: op.slideId, decorId: 'd_generated_1' },
          }));
        }
        if (op && op.type === 'delete-decor') {
          return res.end(JSON.stringify({
            ok: true,
            rev: 19,
            affected: { slideId: op.slideId, decorId: op.decorId },
          }));
        }
        if (op && op.type === 'set-media') {
          return res.end(JSON.stringify({
            ok: true,
            rev: 20,
            affected: { slideId: op.slideId, decorId: op.decorId, media: true },
          }));
        }
        if (op && op.type === 'set-corners') {
          if (op.corners !== 'sharp') {
            res.statusCode = 400;
            return res.end('{"ok":false,"error":"corners must be sharp"}');
          }
          return res.end(JSON.stringify({
            ok: true,
            rev: 20,
            affected: { slideId: op.slideId, elementId: op.targetId, corners: true },
          }));
        }
        if (op && op.type === 'set-transition') {
          if (!Object.prototype.hasOwnProperty.call(slideTransitions, op.slideId)) {
            res.statusCode = 400;
            return res.end('{"ok":false,"error":"no such slide"}');
          }
          if (op.effect !== 'fade' && op.effect !== 'none') {
            res.statusCode = 400;
            return res.end('{"ok":false,"error":"effect must be fade or none"}');
          }
          if (op.effect === 'none') {
            if (op.duration !== undefined) {
              res.statusCode = 400;
              return res.end('{"ok":false,"error":"duration is only valid for fade"}');
            }
            slideTransitions[op.slideId] = { effect: 'none' };
          } else {
            const duration = op.duration === undefined ? 0.35 : op.duration;
            if (typeof duration !== 'number' || !Number.isFinite(duration)
                || duration < 0.1 || duration > 10) {
              res.statusCode = 400;
              return res.end('{"ok":false,"error":"duration must be a finite number from 0.1 to 10 seconds"}');
            }
            slideTransitions[op.slideId] = { effect: 'fade', duration };
          }
          return res.end(JSON.stringify({
            ok: true,
            rev: 18,
            affected: { slideId: op.slideId },
          }));
        }
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'invalid edit payload' }));
      }
      res.statusCode = 404;
      res.end('{"ok":false,"error":"not found"}');
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;

  let mcp = null;
  try {
    const failedPause = await runCli(port, 'pause');
    check('ppt pause exits nonzero when the server returns HTTP 500',
      failedPause.code === 1 && /pause lock verification failed/i.test(failedPause.stderr));
    check('ppt pause never prints a false success after HTTP 500',
      !/paused\s*$/im.test(failedPause.stdout));

    const failedResume = await runCli(port, 'resume');
    check('ppt resume honors an ok:false response even with HTTP 200',
      failedResume.code === 1 && /resume state was not saved/i.test(failedResume.stderr));
    check('ppt resume never prints a false success after ok:false',
      !/resumed\s*$/im.test(failedResume.stdout));

    pauseMode = 'empty';
    const emptyPause = await runCli(port, 'pause');
    check('ppt pause rejects an empty HTTP 200 response',
      emptyPause.code === 1 && /invalid state confirmation/i.test(emptyPause.stderr));
    pauseMode = 'wrong-state';
    const wrongPause = await runCli(port, 'pause');
    check('ppt pause requires paused=true confirmation',
      wrongPause.code === 1 && /invalid state confirmation/i.test(wrongPause.stderr));

    resumeMode = 'empty';
    const emptyResume = await runCli(port, 'resume');
    check('ppt resume rejects an empty HTTP 200 response',
      emptyResume.code === 1 && /invalid state confirmation/i.test(emptyResume.stderr));
    resumeMode = 'wrong-state';
    const wrongResume = await runCli(port, 'resume');
    check('ppt resume requires paused=false confirmation',
      wrongResume.code === 1 && /invalid state confirmation/i.test(wrongResume.stderr));

    const renderSuccessStart = seen.length;
    renderMode = 'success';
    const cleanRender = await runCli(port, 'render');
    const cleanRenderRequests = seen.slice(renderSuccessStart);
    check('ppt render uses only the non-mutating render endpoint',
      cleanRender.code === 0 && /re-render triggered/i.test(cleanRender.stdout) &&
      cleanRenderRequests.some((item) => item.method === 'POST' && item.url === '/api/render') &&
      !cleanRenderRequests.some((item) => item.url === '/api/edit'));

    const renderPausedStart = seen.length;
    renderMode = 'paused';
    const pausedRender = await runCli(port, 'render');
    const pausedRenderRequests = seen.slice(renderPausedStart);
    check('ppt render preserves the pause contract without sending an edit',
      pausedRender.code === 3 && /paused/i.test(pausedRender.stderr) &&
      pausedRenderRequests.some((item) => item.method === 'POST' && item.url === '/api/render') &&
      !pausedRenderRequests.some((item) => item.url === '/api/edit'));

    const renderMissingStart = seen.length;
    renderMode = 'missing';
    const undeployedRender = await runCli(port, 'render');
    const undeployedRenderRequests = seen.slice(renderMissingStart);
    check('ppt render fails closed against an unrestarted server',
      undeployedRender.code === 1 && /server restart required/i.test(undeployedRender.stderr) &&
      undeployedRenderRequests.some((item) => item.method === 'POST' && item.url === '/api/render') &&
      !undeployedRenderRequests.some((item) => item.url === '/api/edit'));
    renderMode = 'success';

    const invalidIndex = await runCli(port, ['add-slide', '--index', '1x']);
    check('ppt rejects malformed integer flags before sending an edit',
      invalidIndex.code === 1 && /index must be an integer/i.test(invalidIndex.stderr) &&
      !seen.some((item) => item.url === '/api/edit' && item.body.op && item.body.op.index === '1x'));

    const help = await runCli(port, 'help');
    check('ppt help documents both transition forms and their click-only no-sound contract',
      help.code === 0
        && /set-transition sID fade \[--duration 0\.35\]/i.test(help.stdout)
        && /set-transition sID none/i.test(help.stdout)
        && /seconds.*click-only.*no sound/i.test(help.stdout));
    check('ppt help documents generated overlays and guarded deletion',
      help.code === 0
        && /add-shape sID "#RRGGBB".*generated rectangle decor.*suite-native or imported slide/i.test(help.stdout)
        && /delete-decor sID decorID.*generated rectangle\/image\/video.*imported\/backed decor is refused/i.test(help.stdout));
    check('ppt help documents in-place media updates and their identity guarantees',
      help.code === 0 &&
      /set-media sID decorID.*source.*autoplay.*loop.*id, box, order, and history are preserved/i.test(help.stdout));
    check('ppt help documents strict imported box/card corner conversion',
      help.code === 0 &&
      /set-corners sID targetID sharp.*eligible imported box\/card AutoShape.*90-degree corners/i.test(help.stdout));
    check('ppt help documents explicit native text geometry without weakening first-box validation',
      help.code === 0 &&
      /set-box sID targetID.*native text.*without a box needs all four values first/i.test(help.stdout));

    let cornersStart = seen.length;
    const sharpCorners = await runCli(port, ['set-corners', 's1', 'e1', 'sharp']);
    let cornersRequest = seen.slice(cornersStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-corners');
    check('ppt set-corners sends the exact canonical sharp-corner op',
      sharpCorners.code === 0 && cornersRequest &&
      JSON.stringify(cornersRequest.body.op) === JSON.stringify({
        type: 'set-corners',
        slideId: 's1',
        targetId: 'e1',
        corners: 'sharp'
      }));
    cornersStart = seen.length;
    const invalidCorners = await runCli(port, ['set-corners', 's1', 'e1', 'rounded']);
    check('ppt set-corners rejects unsupported modes before sending an edit',
      invalidCorners.code === 1 && /eligible imported box\/card AutoShapes only/i.test(invalidCorners.stderr) &&
      !seen.slice(cornersStart).some((item) =>
        item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-corners'));
    check('ppt help documents durable slide/object protection and human unlock',
      help.code === 0
        && /protect sID \[objectID\].*element\/decor\/picture\/media/i.test(help.stdout)
        && /unprotect sID \[objectID\].*human-unlock/i.test(help.stdout)
        && /protections \[--json\].*list durable content protections/i.test(help.stdout)
        && /protections --history \[--json\].*durable lock\/unlock decisions/i.test(help.stdout));

    let protectionStart = seen.length;
    const protectedSlide = await runCli(port, ['protect', 's1']);
    let protectionRequest = seen.slice(protectionStart).find((item) =>
      item.url === '/api/protections/toggle');
    check('ppt protect sends the exact canonical whole-slide toggle',
      protectedSlide.code === 0 && protectionRequest &&
      JSON.stringify(protectionRequest.body) === JSON.stringify({
        kind: 'slide',
        slideId: 's1',
        protected: true,
        by: 'control-contract-test'
      }));

    protectionStart = seen.length;
    const protectedDecor = await runCli(port, ['protect', 's1', 'path-guy']);
    protectionRequest = seen.slice(protectionStart).find((item) =>
      item.url === '/api/protections/toggle');
    check('ppt protect resolves and sends the exact canonical decor toggle',
      protectedDecor.code === 0 && protectionRequest &&
      JSON.stringify(protectionRequest.body) === JSON.stringify({
        kind: 'object',
        slideId: 's1',
        protected: true,
        by: 'control-contract-test',
        objectId: 'path-guy',
        objectKind: 'decor'
      }));

    protectionStart = seen.length;
    const unprotectedDecor = await runCli(port, ['unprotect', 's1', 'path-guy']);
    protectionRequest = seen.slice(protectionStart).find((item) =>
      item.url === '/api/protections/toggle');
    check('ppt unprotect sends protected=false for the same stable object identity',
      unprotectedDecor.code === 0 && protectionRequest &&
      protectionRequest.body.protected === false &&
      protectionRequest.body.objectId === 'path-guy' &&
      protectionRequest.body.objectKind === 'decor');

    const protectionList = await runCli(port, ['protections', '--json']);
    check('ppt protections emits canonical machine-readable JSON',
      protectionList.code === 0 && Array.isArray(JSON.parse(protectionList.stdout)) &&
      JSON.parse(protectionList.stdout).some((item) =>
        item.kind === 'slide' && item.slideId === 's1'));

    protectionHistory.push({
      action: 'unlock',
      kind: 'object',
      slideId: 's1',
      objectId: 'path-guy',
      objectKind: 'decor',
      by: 'Josh',
      ts: protectionTs++,
    });
    const protectionAudit = await runCli(port, ['protections', '--history', '--json']);
    const parsedProtectionAudit = protectionAudit.code === 0
      ? JSON.parse(protectionAudit.stdout)
      : [];
    check('ppt protection history exposes Josh unlock as a durable rejection event',
      protectionAudit.code === 0 && Array.isArray(parsedProtectionAudit) &&
      parsedProtectionAudit.some((entry) =>
        entry.action === 'unlock' && entry.kind === 'object' &&
        entry.slideId === 's1' && entry.objectId === 'path-guy' &&
        entry.objectKind === 'decor' && entry.by === 'Josh' &&
        Number.isSafeInteger(entry.ts)));

    protectionsMode = 'malformed';
    const malformedProtections = await runCli(port, ['protections', '--json']);
    protectionsMode = 'malformed-history';
    const malformedProtectionAudit = await runCli(port, ['protections', '--history', '--json']);
    protectionsMode = 'missing-audit';
    const missingAuditToggle = await runCli(port, ['protect', 's2']);
    protectionsMode = 'error';
    const failedProtectionToggle = await runCli(port, ['unprotect', 's1']);
    protectionsMode = 'success';
    check('protection CLI rejects malformed reads, missing audit acknowledgement, and persistence failures',
      malformedProtections.code === 1 && /malformed response/i.test(malformedProtections.stderr) &&
      malformedProtectionAudit.code === 1 &&
      /malformed response/i.test(malformedProtectionAudit.stderr) &&
      missingAuditToggle.code === 1 &&
      /protection update failed/i.test(missingAuditToggle.stderr) &&
      failedProtectionToggle.code === 1 &&
      /protection persistence failed/i.test(failedProtectionToggle.stderr));

    let generatedStart = seen.length;
    const addedShape = await runCli(port, [
      'add-shape', 's1', '#2A78D6',
      '--x', '0.1', '--y', '0.08', '--w', '0.8', '--h', '0.06',
    ]);
    let generatedRequest = seen.slice(generatedStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'add-shape');
    check('ppt add-shape sends the exact canonical generated-rectangle op',
      addedShape.code === 0 && generatedRequest
        && JSON.stringify(generatedRequest.body.op) === JSON.stringify({
          type: 'add-shape',
          slideId: 's1',
          shapeType: 'rect',
          fill: '#2A78D6',
          x: 0.1,
          y: 0.08,
          w: 0.8,
          h: 0.06,
        }));
    check('ppt add-shape reports the generated decor id returned by the coordinator',
      /generated rectangle d_generated_1/i.test(addedShape.stdout));

    generatedStart = seen.length;
    const deletedShape = await runCli(port, ['delete-decor', 's1', 'd_generated_1']);
    generatedRequest = seen.slice(generatedStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'delete-decor');
    check('ppt delete-decor sends the exact canonical generated-decor deletion op',
      deletedShape.code === 0 && generatedRequest
        && JSON.stringify(generatedRequest.body.op) === JSON.stringify({
          type: 'delete-decor',
          slideId: 's1',
          decorId: 'd_generated_1',
        }));

    const mediaStart = seen.length;
    const updatedMedia = await runCli(port, [
      'set-media', 's1', 'd_video_1',
      '--source', 'assets/revised.mp4', '--autoplay', 'false',
    ]);
    const mediaRequest = seen.slice(mediaStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-media');
    check('ppt set-media sends only the requested in-place media fields',
      updatedMedia.code === 0 && mediaRequest &&
      JSON.stringify(mediaRequest.body.op) === JSON.stringify({
        type: 'set-media',
        slideId: 's1',
        decorId: 'd_video_1',
        source: 'assets/revised.mp4',
        autoplay: false,
      }));
    check('ppt set-media reports the preserved decor id and applied settings',
      /updated embedded video d_video_1.*source=assets\/revised\.mp4 autoplay=off/i.test(updatedMedia.stdout));

    const generatedEditsBeforeInvalid = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op
        && (item.body.op.type === 'add-shape' || item.body.op.type === 'delete-decor')).length;
    const invalidShapeHex = await runCli(port, [
      'add-shape', 's1', '2A78D6',
      '--x', '0.1', '--y', '0.1', '--w', '0.8', '--h', '0.1',
    ]);
    const invalidShapeNumber = await runCli(port, [
      'add-shape', 's1', '#2A78D6',
      '--x', '0.1x', '--y', '0.1', '--w', '0.8', '--h', '0.1',
    ]);
    const zeroShapeWidth = await runCli(port, [
      'add-shape', 's1', '#2A78D6',
      '--x', '0.1', '--y', '0.1', '--w', '0', '--h', '0.1',
    ]);
    const missingShapeCoordinate = await runCli(port, [
      'add-shape', 's1', '#2A78D6',
      '--x', '0.1', '--y', '0.1', '--w', '0.8',
    ]);
    const missingDecorId = await runCli(port, ['delete-decor', 's1']);
    const mediaEditsBeforeInvalid = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-media').length;
    const emptyMediaPatch = await runCli(port, ['set-media', 's1', 'd_video_1']);
    const malformedMediaFlag = await runCli(port, [
      'set-media', 's1', 'd_video_1', '--loop', 'yes',
    ]);
    const mediaEditsAfterInvalid = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-media').length;
    const generatedEditsAfterInvalid = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op
        && (item.body.op.type === 'add-shape' || item.body.op.type === 'delete-decor')).length;
    check('ppt add-shape rejects malformed hex before editing',
      invalidShapeHex.code === 1 && /fill must be exact #RRGGBB hex/i.test(invalidShapeHex.stderr));
    check('ppt add-shape rejects malformed coordinates before editing',
      invalidShapeNumber.code === 1 && /x must be a number/i.test(invalidShapeNumber.stderr));
    check('ppt add-shape rejects zero width before editing',
      zeroShapeWidth.code === 1 && /w must be greater than 0 and from 0 to 1/i.test(zeroShapeWidth.stderr));
    check('ppt add-shape requires every rectangle coordinate',
      missingShapeCoordinate.code === 1 && /usage: add-shape/i.test(missingShapeCoordinate.stderr));
    check('ppt delete-decor requires both slide and decor ids',
      missingDecorId.code === 1 && /usage: delete-decor/i.test(missingDecorId.stderr));
    check('ppt set-media requires a real update field and strict boolean flags',
      emptyMediaPatch.code === 1 && /needs at least one of --source, --autoplay, or --loop/i.test(emptyMediaPatch.stderr) &&
      malformedMediaFlag.code === 1 && /loop must be true or false/i.test(malformedMediaFlag.stderr) &&
      mediaEditsAfterInvalid === mediaEditsBeforeInvalid);
    check('malformed generated-shape CLI commands never reach the edit endpoint',
      generatedEditsAfterInvalid === generatedEditsBeforeInvalid);

    const initialOutline = await runCli(port, 'show');
    check('ppt show reports an explicit fade transition and duration',
      initialOutline.code === 0 && /s1 \(content\) \[transition=fade 0\.35s\]/i.test(initialOutline.stdout));
    check('ppt show reports an explicit none transition',
      initialOutline.code === 0 && /s2 \(content\) \[transition=none\]/i.test(initialOutline.stdout));
    check('ppt show does not misreport an absent imported transition as none',
      initialOutline.code === 0 && /s3 \(content\)\s*$/im.test(initialOutline.stdout)
        && !/s3 \(content\)[^\r\n]*transition/i.test(initialOutline.stdout));

    let transitionStart = seen.length;
    const defaultFade = await runCli(port, ['set-transition', 's1', 'fade']);
    let transitionRequest = seen.slice(transitionStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('ppt set-transition fade sends the canonical default-duration op',
      defaultFade.code === 0 && transitionRequest
        && JSON.stringify(transitionRequest.body.op) === JSON.stringify({
          type: 'set-transition', slideId: 's1', effect: 'fade', duration: 0.35,
        }));
    check('ppt set-transition fade confirms the click-only no-sound contract',
      /fade 0\.35s.*click-only, no sound/i.test(defaultFade.stdout));

    transitionStart = seen.length;
    const customFade = await runCli(port, ['set-transition', 's1', 'fade', '--duration', '0.8']);
    transitionRequest = seen.slice(transitionStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('ppt set-transition forwards a strict custom duration in seconds',
      customFade.code === 0 && transitionRequest
        && JSON.stringify(transitionRequest.body.op) === JSON.stringify({
          type: 'set-transition', slideId: 's1', effect: 'fade', duration: 0.8,
        }));

    transitionStart = seen.length;
    const noTransition = await runCli(port, ['set-transition', 's2', 'none']);
    transitionRequest = seen.slice(transitionStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('ppt set-transition none sends no obsolete duration',
      noTransition.code === 0 && transitionRequest
        && JSON.stringify(transitionRequest.body.op) === JSON.stringify({
          type: 'set-transition', slideId: 's2', effect: 'none',
        }));

    const editsBeforeInvalidTransitions = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition').length;
    const invalidEffect = await runCli(port, ['set-transition', 's1', 'push']);
    const malformedDuration = await runCli(port, ['set-transition', 's1', 'fade', '--duration', '0.35s']);
    const outOfRangeDuration = await runCli(port, ['set-transition', 's1', 'fade', '--duration', '0.09']);
    const durationOnNone = await runCli(port, ['set-transition', 's1', 'none', '--duration', '0.35']);
    const editsAfterInvalidTransitions = seen.filter((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition').length;
    check('ppt rejects unsupported transition effects before editing',
      invalidEffect.code === 1 && /effect must be fade or none/i.test(invalidEffect.stderr));
    check('ppt rejects malformed transition durations before editing',
      malformedDuration.code === 1 && /duration must be a number/i.test(malformedDuration.stderr));
    check('ppt enforces the transition duration range before editing',
      outOfRangeDuration.code === 1 && /duration must be from 0\.1 to 10 seconds/i.test(outOfRangeDuration.stderr));
    check('ppt rejects duration for a none transition before editing',
      durationOnNone.code === 1 && /duration is only valid for fade/i.test(durationOnNone.stderr));
    check('invalid CLI transition commands never reach the edit endpoint',
      editsAfterInvalidTransitions === editsBeforeInvalidTransitions);

    const failedLint = await runCli(port, ['lint', '--json']);
    check('ppt lint exits nonzero on an HTTP failure even in JSON mode',
      failedLint.code === 1 && /font helper failed/i.test(failedLint.stderr));
    lintMode = 'malformed';
    const malformedLint = await runCli(port, ['lint', '--json']);
    check('ppt lint rejects a malformed HTTP 200 payload',
      malformedLint.code === 1 && /malformed response/i.test(malformedLint.stderr));

    const failedTiming = await runCli(port, ['timing', '--json']);
    check('ppt timing exits nonzero on an HTTP failure even in JSON mode',
      failedTiming.code === 1 && /timing failed/i.test(failedTiming.stderr));
    timingMode = 'malformed';
    const malformedTiming = await runCli(port, ['timing', '--json']);
    check('ppt timing rejects a malformed HTTP 200 payload',
      malformedTiming.code === 1 && /malformed response/i.test(malformedTiming.stderr));

    pauseMode = 'hang';
    const timedPause = await runCli(port, 'pause');
    check('a wedged coordinator cannot hang the CLI indefinitely',
      !timedPause.timedOut && timedPause.code === 1 && /timed out after 1000ms/i.test(timedPause.stderr));

    mcp = spawn(process.execPath, [path.join(HERE, 'mcp-ppt.js')], {
      cwd: HERE,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        SUITE_HOST: '127.0.0.1',
        SUITE_PORT: String(port),
        SUITE_EDITOR: 'worker-contract',
        SUITE_MCP_ROLE: 'worker'
      })
    });
    const rpc = createRpc(mcp);
    await rpc('initialize', { protocolVersion: '2025-06-18' });

    const listed = await rpc('tools/list');
    const transitionTool = listed.result.tools.find((tool) => tool.name === 'ppt_set_transition');
    const cornersTool = listed.result.tools.find((tool) => tool.name === 'ppt_set_corners');
    const boxTool = listed.result.tools.find((tool) => tool.name === 'ppt_set_box');
    const addShapeTool = listed.result.tools.find((tool) => tool.name === 'ppt_add_shape');
    const deleteShapeTool = listed.result.tools.find((tool) => tool.name === 'ppt_delete_shape');
    const doneTool = listed.result.tools.find((tool) => tool.name === 'ppt_task_done');
    check('worker MCP exposes ppt_set_transition',
      !!transitionTool);
    check('ppt_set_transition schema restricts effects and duration',
      transitionTool
        && JSON.stringify(transitionTool.inputSchema.properties.effect.enum) === JSON.stringify(['fade', 'none'])
        && transitionTool.inputSchema.properties.duration.type === 'number'
        && transitionTool.inputSchema.properties.duration.minimum === 0.1
        && transitionTool.inputSchema.properties.duration.maximum === 10
        && transitionTool.inputSchema.properties.duration.default === 0.35);
    check('ppt_set_transition describes seconds, click-only advancement, and no sound',
      transitionTool && /seconds/i.test(transitionTool.description)
        && /click only|click-only/i.test(transitionTool.description)
        && /never include a sound|no sound/i.test(transitionTool.description));
    check('worker MCP exposes a single-mode, strict imported AutoShape corner tool',
      cornersTool &&
      cornersTool.inputSchema.additionalProperties === false &&
      JSON.stringify(cornersTool.inputSchema.properties.corners.enum) === JSON.stringify(['sharp']) &&
      JSON.stringify(cornersTool.inputSchema.required) ===
        JSON.stringify(['slide_id', 'target_id', 'corners']) &&
      /preserving.*text.*style.*box.*z-order.*shape identity.*animation target/i.test(cornersTool.description) &&
      /refuses placeholders.*text boxes.*pictures.*media.*lines\/connectors.*groups.*circles\/icons.*generated objects/i.test(cornersTool.description));
    check('worker MCP documents bounded explicit placement for boxless native text',
      boxTool && /native text element/i.test(boxTool.description) &&
      /no current box needs x, y, w, and h together/i.test(boxTool.description) &&
      /fractions of the slide from 0 to 1/i.test(boxTool.description));
    check('worker ppt_task_done is conditional on applied and verified work',
      doneTool && /actually applied and verified with ppt_show/i.test(doneTool.description)
        && /leave the task open for retry/i.test(doneTool.description));
    check('worker MCP exposes strict generated-rectangle tools',
      addShapeTool && deleteShapeTool
        && addShapeTool.inputSchema.additionalProperties === false
        && deleteShapeTool.inputSchema.additionalProperties === false
        && JSON.stringify(addShapeTool.inputSchema.required)
          === JSON.stringify(['slide_id', 'fill', 'x', 'y', 'w', 'h'])
        && JSON.stringify(deleteShapeTool.inputSchema.required)
          === JSON.stringify(['slide_id', 'decor_id']));
    check('ppt_add_shape schema pins exact hex and unit-coordinate bounds',
      addShapeTool
        && addShapeTool.inputSchema.properties.fill.pattern === '^#[0-9A-Fa-f]{6}$'
        && addShapeTool.inputSchema.properties.x.type === 'number'
        && addShapeTool.inputSchema.properties.x.minimum === 0
        && addShapeTool.inputSchema.properties.x.maximum === 1
        && addShapeTool.inputSchema.properties.w.exclusiveMinimum === 0
        && addShapeTool.inputSchema.properties.w.maximum === 1
        && addShapeTool.inputSchema.properties.h.exclusiveMinimum === 0
        && addShapeTool.inputSchema.properties.h.maximum === 1);
    check('generated-shape tool descriptions explain native/imported layering and deletion boundaries',
      /generated.*rectangle/i.test(addShapeTool && addShapeTool.description)
        && /imported slide or a suite-native/i.test(addShapeTool && addShapeTool.description)
        && /behind native text/i.test(addShapeTool && addShapeTool.description)
        && /refuses imported or backed/i.test(deleteShapeTool && deleteShapeTool.description));

    let shapeMcpStart = seen.length;
    const mcpAddedShape = await rpc('tools/call', {
      name: 'ppt_add_shape',
      arguments: {
        slide_id: 's1',
        fill: '#F1B82D',
        x: 0.12,
        y: 0.14,
        w: 0.76,
        h: 0.08,
      },
    });
    let mcpShapeRequest = seen.slice(shapeMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'add-shape');
    check('MCP ppt_add_shape sends the exact canonical rectangle op',
      !mcpAddedShape.result.isError && mcpShapeRequest
        && JSON.stringify(mcpShapeRequest.body.op) === JSON.stringify({
          type: 'add-shape',
          slideId: 's1',
          shapeType: 'rect',
          fill: '#F1B82D',
          x: 0.12,
          y: 0.14,
          w: 0.76,
          h: 0.08,
        }));
    check('MCP ppt_add_shape reports the coordinator decor id',
      /generated rectangle d_generated_1/i.test(mcpAddedShape.result.content[0].text));

    shapeMcpStart = seen.length;
    const mcpDeletedShape = await rpc('tools/call', {
      name: 'ppt_delete_shape',
      arguments: { slide_id: 's1', decor_id: 'd_generated_1' },
    });
    mcpShapeRequest = seen.slice(shapeMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'delete-decor');
    check('MCP ppt_delete_shape sends the exact canonical delete-decor op',
      !mcpDeletedShape.result.isError && mcpShapeRequest
        && JSON.stringify(mcpShapeRequest.body.op) === JSON.stringify({
          type: 'delete-decor',
          slideId: 's1',
          decorId: 'd_generated_1',
        }));

    cornersStart = seen.length;
    const mcpSharpCorners = await rpc('tools/call', {
      name: 'ppt_set_corners',
      arguments: { slide_id: 's1', target_id: 'e1', corners: 'sharp' },
    });
    cornersRequest = seen.slice(cornersStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-corners');
    check('MCP ppt_set_corners sends the exact canonical operation',
      !mcpSharpCorners.result.isError && cornersRequest &&
      JSON.stringify(cornersRequest.body.op) === JSON.stringify({
        type: 'set-corners',
        slideId: 's1',
        targetId: 'e1',
        corners: 'sharp',
      }));
    cornersStart = seen.length;
    const mcpRoundedCorners = await rpc('tools/call', {
      name: 'ppt_set_corners',
      arguments: { slide_id: 's1', target_id: 'e1', corners: 'rounded' },
    });
    check('MCP ppt_set_corners rejects unsupported modes locally',
      mcpRoundedCorners.result.isError === true &&
      /corners must be sharp/i.test(mcpRoundedCorners.result.content[0].text) &&
      !seen.slice(cornersStart).some((item) =>
        item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-corners'));

    const malformedMcpShapeStart = seen.length;
    const malformedMcpShapeHex = await rpc('tools/call', {
      name: 'ppt_add_shape',
      arguments: { slide_id: 's1', fill: 'F1B82D', x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
    });
    const malformedMcpShapeNumber = await rpc('tools/call', {
      name: 'ppt_add_shape',
      arguments: { slide_id: 's1', fill: '#F1B82D', x: null, y: 0.1, w: 0.8, h: 0.1 },
    });
    const malformedMcpDelete = await rpc('tools/call', {
      name: 'ppt_delete_shape',
      arguments: { slide_id: 's1', decor_id: '' },
    });
    check('MCP generated-shape tools reject malformed arguments locally',
      malformedMcpShapeHex.result.isError === true
        && /exact #RRGGBB hex/i.test(malformedMcpShapeHex.result.content[0].text)
        && malformedMcpShapeNumber.result.isError === true
        && /x must be a finite number/i.test(malformedMcpShapeNumber.result.content[0].text)
        && malformedMcpDelete.result.isError === true
        && /needs slide_id.*decor_id/i.test(malformedMcpDelete.result.content[0].text));
    check('malformed MCP generated-shape calls never reach the edit endpoint',
      !seen.slice(malformedMcpShapeStart).some((item) =>
        item.url === '/api/edit' && item.body.op
          && (item.body.op.type === 'add-shape' || item.body.op.type === 'delete-decor')));

    slideTransitions.s1 = { effect: 'fade', duration: 0.35 };
    slideTransitions.s2 = { effect: 'none' };
    slideTransitions.s3 = undefined;
    const mcpOutline = await rpc('tools/call', {
      name: 'ppt_show',
      arguments: {},
    });
    const mcpOutlineText = mcpOutline.result.content[0].text;
    check('MCP ppt_show reports explicit fade and none transitions',
      /s1 \(content\) transition=fade 0\.35s/i.test(mcpOutlineText)
        && /s2 \(content\) transition=none/i.test(mcpOutlineText));
    check('MCP ppt_show leaves an absent imported transition unlabelled',
      /s3 \(content\)[ \t]*$/im.test(mcpOutlineText)
        && !/s3 \(content\)[^\r\n]*transition/i.test(mcpOutlineText));

    let transitionMcpStart = seen.length;
    const mcpFade = await rpc('tools/call', {
      name: 'ppt_set_transition',
      arguments: { slide_id: 's1', effect: 'fade', duration: 0.6 },
    });
    let mcpTransitionRequest = seen.slice(transitionMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('MCP fade sends the exact canonical server op',
      !mcpFade.result.isError && mcpTransitionRequest
        && JSON.stringify(mcpTransitionRequest.body.op) === JSON.stringify({
          type: 'set-transition', slideId: 's1', effect: 'fade', duration: 0.6,
        }));
    check('MCP fade response confirms click-only advancement and no sound',
      /click-only with no sound/i.test(mcpFade.result.content[0].text));

    transitionMcpStart = seen.length;
    const mcpDefaultFade = await rpc('tools/call', {
      name: 'ppt_set_transition',
      arguments: { slide_id: 's1', effect: 'fade' },
    });
    mcpTransitionRequest = seen.slice(transitionMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('MCP omitted fade duration becomes the documented 0.35-second op',
      !mcpDefaultFade.result.isError && mcpTransitionRequest
        && mcpTransitionRequest.body.op.duration === 0.35);

    transitionMcpStart = seen.length;
    const mcpNone = await rpc('tools/call', {
      name: 'ppt_set_transition',
      arguments: { slide_id: 's2', effect: 'none' },
    });
    mcpTransitionRequest = seen.slice(transitionMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('MCP none omits duration from the canonical server op',
      !mcpNone.result.isError && mcpTransitionRequest
        && JSON.stringify(mcpTransitionRequest.body.op) === JSON.stringify({
          type: 'set-transition', slideId: 's2', effect: 'none',
        }));

    transitionMcpStart = seen.length;
    const nullTransitionDuration = await rpc('tools/call', {
      name: 'ppt_set_transition',
      arguments: { slide_id: 's1', effect: 'fade', duration: null },
    });
    mcpTransitionRequest = seen.slice(transitionMcpStart).find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition');
    check('MCP rejects the coordinator failure for a null transition duration',
      nullTransitionDuration.result.isError === true
        && /duration must be a finite number/i.test(nullTransitionDuration.result.content[0].text));
    check('MCP preserves a null duration instead of coercing it to zero or default',
      mcpTransitionRequest && mcpTransitionRequest.body.op.duration === null);

    const noneDurationStart = seen.length;
    const mcpDurationOnNone = await rpc('tools/call', {
      name: 'ppt_set_transition',
      arguments: { slide_id: 's2', effect: 'none', duration: 0.35 },
    });
    check('MCP rejects duration on none without sending an edit',
      mcpDurationOnNone.result.isError === true
        && /duration is only valid for fade/i.test(mcpDurationOnNone.result.content[0].text)
        && !seen.slice(noneDurationStart).some((item) =>
          item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-transition'));

    const partialLock = await rpc('tools/call', {
      name: 'ppt_lock',
      arguments: { slide_ids: ['s1', 's2'] }
    });
    check('MCP lock reports partial acquisition as an error',
      partialLock.result.isError === true &&
      /lock incomplete/i.test(partialLock.result.content[0].text));

    const foreignUnlock = await rpc('tools/call', {
      name: 'ppt_unlock',
      arguments: { slide_ids: ['s1'] }
    });
    check('MCP unlock reports another editor’s lock as an error',
      foreignUnlock.result.isError === true &&
      /held by another editor/i.test(foreignUnlock.result.content[0].text));

    const stringAll = await rpc('tools/call', {
      name: 'ppt_unlock',
      arguments: { all: 'false' }
    });
    check('MCP unlock rejects string booleans',
      stringAll.result.isError === true && /must be a boolean/i.test(stringAll.result.content[0].text));

    const nullBox = await rpc('tools/call', {
      name: 'ppt_set_box',
      arguments: { slide_id: 's1', target_id: 'e1', x: null }
    });
    check('MCP rejects the server failure for a null coordinate',
      nullBox.result.isError === true);
    const boxRequest = seen.find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'set-box');
    check('MCP preserves null instead of coercing it to zero',
      !!boxRequest && boxRequest.body.op.x === null);

    const nullIndex = await rpc('tools/call', {
      name: 'ppt_add_slide',
      arguments: { layout: 'content', index: null }
    });
    check('MCP propagates an invalid add-slide index as an error',
      nullIndex.result.isError === true);
    const slideRequest = seen.find((item) =>
      item.url === '/api/edit' && item.body.op && item.body.op.type === 'add-slide');
    check('MCP preserves a null slide index instead of creating slide zero',
      !!slideRequest && slideRequest.body.op.index === null);
  } finally {
    if (mcp) {
      try { mcp.stdin.end(); } catch (_) {}
      try { mcp.kill(); } catch (_) {}
    }
    await new Promise((resolve) => api.close(resolve));
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
