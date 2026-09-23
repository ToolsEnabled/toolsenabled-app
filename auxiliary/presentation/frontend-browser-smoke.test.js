#!/usr/bin/env node
'use strict';
/*
 * Loads both real frontend pages in a real browser against a read-only fixture
 * server built from the current data/model.json + board/state content. No suite
 * server is started and no project file is written.
 *
 * Browser lifecycle is deliberately exact: a unique profile and one captured
 * child PID, one CDP target per page, target closure before browser termination,
 * and cleanup limited to browser child PIDs whose command line names that exact
 * test-owned profile. It never uses a blanket chrome.exe/msedge.exe kill.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { connect, openTarget, evalJs } = require('./test-helpers/cdp');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(HERE, 'public');
const DATA = path.join(HERE, 'data');

function findBrowser() {
  const candidates = [];
  const add = (...parts) => { if (parts.every(Boolean)) candidates.push(path.join(...parts)); };
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || process.env.PROGRAMFILES;
    const pfx = process.env['ProgramFiles(x86)'] || process.env['PROGRAMFILES(X86)'];
    const local = process.env.LOCALAPPDATA;
    add(pf, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(local, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      for (const name of names) add(dir, name);
    }
  }
  return candidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch (_) { return false; }
  }) || null;
}

function json(res, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function startFixtureServer(snapshot) {
  const staticFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/studio': ['studio.html', 'text/html; charset=utf-8'],
    '/studio.html': ['studio.html', 'text/html; charset=utf-8'],
    '/studio.js': ['studio.js', 'text/javascript; charset=utf-8'],
    '/studio.css': ['studio.css', 'text/css; charset=utf-8'],
    '/animation-preview.js': ['animation-preview.js', 'text/javascript; charset=utf-8'],
    '/animation-preview.css': ['animation-preview.css', 'text/css; charset=utf-8'],
  };
  const streams = new Set();
  const protectionRequests = [];
  let protections = Array.isArray(snapshot.protections) ? snapshot.protections.slice() : [];
  let protectionExceptions = Array.isArray(snapshot.protectionExceptions)
    ? snapshot.protectionExceptions.slice() : [];
  let nextProtectionReply = 'success';
  const downloadRequests = [];
  let pptxReplies = [];
  let healthReplies = [];
  let pdfExportReplies = [];
  let pdfReplies = [];
  const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const defaultPptx = { status: 200, mime: pptxMime, body: [0x50, 0x4b, 0x03, 0x04, 0x14] };
  const defaultPdf = { status: 200, mime: 'application/pdf', body: [0x25, 0x50, 0x44, 0x46, 0x2d] };
  const takeReply = (queue, fallback) => queue.length ? queue.shift() : fallback;
  const sendReply = (res, reply) => {
    if (reply && Object.prototype.hasOwnProperty.call(reply, 'json')) {
      return json(res, reply.json, reply.status == null ? 200 : reply.status);
    }
    const body = Buffer.from((reply && reply.body) || []);
    res.writeHead(reply && reply.status != null ? reply.status : 200, {
      'Content-Type': reply && reply.mime || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return undefined;
  };
  const currentSnapshot = () => Object.assign({}, snapshot, { protections, protectionExceptions });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/health') {
      downloadRequests.push({ method: req.method, path: pathname });
      const current = takeReply(healthReplies, true);
      return json(res, {
        ok: true,
        presentation: typeof current === 'object' ? current : { current: !!current },
      });
    }
    if (req.method === 'GET' && pathname === '/api/pptx') {
      downloadRequests.push({ method: req.method, path: pathname });
      return sendReply(res, takeReply(pptxReplies, defaultPptx));
    }
    if (req.method === 'POST' && pathname === '/api/pdf/export') {
      downloadRequests.push({ method: req.method, path: pathname });
      req.resume();
      return sendReply(res, takeReply(pdfExportReplies, {
        status: 200, json: { ok: true, ver: 1 },
      }));
    }
    if (req.method === 'GET' && pathname === '/api/pdf') {
      downloadRequests.push({ method: req.method, path: pathname });
      return sendReply(res, takeReply(pdfReplies, defaultPdf));
    }
    if (req.method === 'GET' && pathname === '/api/state') return json(res, currentSnapshot());
    if (req.method === 'GET' && pathname === '/api/lint') {
      return json(res, { ok: true, count: 0, issues: [], rev: snapshot.model.rev });
    }
    if (req.method === 'GET' && pathname === '/api/timing') {
      return json(res, {
        totalSeconds: 600, totalWords: 1350, wpm: 135,
        targetSeconds: 660, capSeconds: 720, overTarget: false, overCap: false,
      });
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(Object.assign({ type: 'snapshot' }, currentSnapshot()))}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/presence') {
      req.resume();
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/animation-preview-asset') {
      const slide = (snapshot.model.slides || []).find((item) => item.id === url.searchParams.get('slideId'));
      const object = slide && (slide.decor || []).find((item) => item.id === url.searchParams.get('objectId'));
      const source = object && object.kind === 'pic' ? String(object.source || '') : '';
      const file = path.resolve(ROOT, source);
      const assetsRoot = path.resolve(ROOT, 'assets') + path.sep;
      if (!source.startsWith('assets/') || !file.startsWith(assetsRoot)) {
        return json(res, { ok: false, error: 'preview artwork not found' }, 404);
      }
      return fs.readFile(file, (err, body) => {
        if (err) return json(res, { ok: false, error: 'preview artwork not found' }, 404);
        res.writeHead(200, {
          'Content-Type': path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/media-preview-asset') {
      const slide = (snapshot.model.slides || []).find((item) => item.id === url.searchParams.get('slideId'));
      const object = slide && (slide.decor || []).find((item) => item.id === url.searchParams.get('objectId'));
      const source = object && object.kind === 'media' && object.generated === true
        ? String(object.source || '') : '';
      const normalized = source && !source.includes('\\') && !source.startsWith('/')
        && !source.includes('\0') && source.split('/').length > 1
        && source.split('/')[0].toLowerCase() === 'assets'
        && source.split('/').every((part) => part && part !== '.' && part !== '..')
        && /\.mp4$/i.test(source);
      let file = null;
      let assetsRoot = null;
      try {
        assetsRoot = fs.realpathSync(path.resolve(ROOT, 'assets'));
        file = normalized ? fs.realpathSync(path.resolve(ROOT, source)) : null;
      } catch (_) { file = null; }
      if (!file || (file !== assetsRoot && !file.startsWith(assetsRoot + path.sep))) {
        return json(res, { ok: false, error: 'preview video not found' }, 404);
      }
      const stat = fs.statSync(file);
      const rangeHeader = req.headers.range;
      let start = 0;
      let end = Math.max(0, stat.size - 1);
      let partial = false;
      if (rangeHeader !== undefined) {
        const match = typeof rangeHeader === 'string' && !rangeHeader.includes(',')
          ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
        if (!match || (!match[1] && !match[2]) || stat.size <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
            res.end();
            return;
          }
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stat.size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
              || start < 0 || start >= stat.size || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
            res.end();
            return;
          }
          end = Math.min(end, stat.size - 1);
        }
        partial = true;
      }
      const headers = {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size === 0 ? 0 : end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (req.method === 'HEAD' || stat.size === 0) {
        res.end();
        return;
      }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/protections/toggle') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'bad json' }, 400); }
        protectionRequests.push(body);
        const reply = nextProtectionReply;
        nextProtectionReply = 'success';
        if (reply === 'reject') {
          return json(res, { ok: false, error: 'fixture refused protection change' }, 500);
        }
        if (reply === 'malformed') {
          return json(res, {
            ok: true, protections: { invalid: 'not an array' }, protectionExceptions
          });
        }
        const same = (item) => item.kind === body.kind && item.slideId === body.slideId
          && (item.kind === 'slide' || (item.objectId === body.objectId
            && (!item.objectKind || !body.objectKind || item.objectKind === body.objectKind)));
        const parentSlideLocked = body.kind === 'object' && protections.some((item) =>
          item.kind === 'slide' && item.slideId === body.slideId);
        if (body.kind === 'object' && parentSlideLocked) {
          protections = protections.filter((item) => !same(item));
          protectionExceptions = protectionExceptions.filter((item) => !same(item));
          if (!body.protected) {
            protectionExceptions.push({
              kind: 'object', slideId: body.slideId,
              objectId: body.objectId, objectKind: body.objectKind,
              by: body.by, createdAt: Date.now(),
            });
          }
        } else if (body.kind === 'slide') {
          protections = protections.filter((item) => item.slideId !== body.slideId);
          protectionExceptions = protectionExceptions.filter((item) => item.slideId !== body.slideId);
          if (body.protected) protections.push({
            kind: 'slide', slideId: body.slideId, by: body.by, createdAt: Date.now(),
          });
        } else {
          protections = protections.filter((item) => !same(item));
          if (body.protected) protections.push({
            kind: body.kind,
            slideId: body.slideId,
            ...(body.kind === 'object'
              ? { objectId: body.objectId, objectKind: body.objectKind }
              : {}),
            by: body.by,
            createdAt: Date.now(),
          });
        }
        return json(res, { ok: true, protections, protectionExceptions });
      });
      return;
    }
    const thumb = /^\/thumbs\/(slide-\d+\.png)$/.exec(pathname);
    if (req.method === 'GET' && thumb) {
      const file = path.join(DATA, 'thumbs', thumb[1]);
      return fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    }
    const item = staticFiles[pathname];
    if (req.method === 'GET' && item) {
      return fs.readFile(path.join(PUBLIC, item[0]), (err, body) => {
        if (err) { res.writeHead(500); res.end(String(err)); return; }
        res.writeHead(200, {
          'Content-Type': item[1],
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    }
    res.writeHead(404);
    res.end('not found');
  });
  return {
    server,
    streams,
    protectionRequests,
    downloadRequests,
    failNextProtection: () => { nextProtectionReply = 'reject'; },
    malformNextProtection: () => { nextProtectionReply = 'malformed'; },
    configurePptx: (replies, health) => {
      pptxReplies = Array.isArray(replies) ? replies.slice() : [];
      healthReplies = Array.isArray(health) ? health.slice() : [];
      downloadRequests.length = 0;
    },
    configurePdf: (exports, downloads) => {
      pdfExportReplies = Array.isArray(exports) ? exports.slice() : [];
      pdfReplies = Array.isArray(downloads) ? downloads.slice() : [];
      downloadRequests.length = 0;
    },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: async () => {
      for (const stream of streams) stream.end();
      streams.clear();
      if (server.closeAllConnections) server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function devtoolsReady(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.setTimeout(300, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function closeBrowserThroughDevtools(port) {
  if (!port) return;
  let version;
  try {
    version = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(800, () => req.destroy(new Error('DevTools close lookup timed out')));
      req.on('error', reject);
    });
  } catch (_) {
    return;
  }
  if (!version || !version.webSocketDebuggerUrl) return;
  let browser = null;
  try {
    browser = await connect(version.webSocketDebuggerUrl);
    // Browser.close often closes the socket before its reply arrives, which is
    // still success. Bound the graceful attempt, then retain the captured-PID
    // fallback below.
    await Promise.race([
      browser.send('Browser.close').catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_) {
    // The captured process fallback remains exact to this test instance.
  } finally {
    if (browser) browser.close();
  }
}

async function waitForDevtools(port, child) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`browser exited before DevTools was ready (${child.exitCode})`);
    if (await devtoolsReady(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser DevTools did not open port ${port}`);
}

async function stopCapturedProcess(child) {
  if (!child || child.exitCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM'); // ChildProcess.kill targets this captured pid, never an image name.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2500))]);
  if (child.exitCode == null) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
}

async function stopOwnedProfileProcesses(profile) {
  if (process.platform !== 'win32' || !profile) return;
  const resolved = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('suite-browser-smoke-')) {
    throw new Error(`refusing to inspect processes for an unowned browser profile: ${resolved}`);
  }
  // Chrome's tiny launcher process can exit after handing the unique profile
  // to another browser PID. Query only browser processes that literally name
  // this random test profile, then terminate those exact PIDs. Normal Chrome
  // profiles and unrelated headless tests cannot match the random full path.
  const script = [
    '$needle = $env:SUITE_BROWSER_PROFILE',
    'Get-CimInstance Win32_Process | Where-Object {',
    "  $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.Name -match '^(chrome|msedge|chromium)\\.exe$'",
    '} | ForEach-Object { $_.ProcessId }',
  ].join('\n');
  for (let pass = 0; pass < 4; pass++) {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: Object.assign({}, process.env, { SUITE_BROWSER_PROFILE: resolved }),
      }
    );
    const pids = String(result.stdout || '')
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
    if (!pids.length) return;
    for (const pid of pids) {
      // Windows' process.kill can report success for a Chrome launcher while
      // its process tree stays alive. taskkill is still PID-scoped here, and
      // /T closes only descendants of that already profile-validated PID.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function removeOwnedProfile(profile) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('suite-browser-smoke-')) {
    throw new Error(`refusing to remove unowned browser profile: ${resolved}`);
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); return; }
    catch (err) {
      if (attempt === 31) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(err.code)) throw err;
        // Some Windows/Chrome builds retain Account Web Data or CrashpadMetrics
        // until the Node parent itself exits even though every profile-bound
        // browser PID is already terminated. Hand the same validated path to a
        // hidden, bounded cleanup helper that begins after this process exits.
        const helperSource = [
          "const fs=require('fs'),path=require('path'),os=require('os');",
          'const target=path.resolve(process.argv[1]);',
          'const root=path.resolve(os.tmpdir())+path.sep;',
          "if(!target.startsWith(root)||!path.basename(target).startsWith('suite-browser-smoke-'))process.exit(2);",
          'let tries=0;',
          'function clean(){',
          '  try{fs.rmSync(target,{recursive:true,force:true});process.exit(0);}',
          '  catch(_){if(++tries>=60)process.exit(1);setTimeout(clean,500);}',
          '}',
          'setTimeout(clean,250);',
        ].join('');
        const helper = spawn(process.execPath, ['-e', helperSource, resolved], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        helper.unref();
        console.warn(`WARN  deferred cleanup for test-owned browser profile ${path.basename(resolved)}`);
        return;
      }
      // Chrome's captured parent is already gone, but Windows can keep one
      // profile database handle alive briefly while its child processes exit.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('SKIP  frontend browser smoke (Chrome, Edge, or Chromium not found)');
    return;
  }

  const model = JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  const board = JSON.parse(fs.readFileSync(path.join(DATA, 'board.json'), 'utf8'));
  const protectionSlide = model.slides[0];
  const protectionObject = (protectionSlide.decor || []).find((item) =>
    /(^|[\\/])timeline([\\/])/.test(String(item.source || '')))
    || (protectionSlide.decor || [])
    .filter((item) => item.box && item.box.y > .62 && item.box.w > .5 && item.box.h < .04)
    .sort((a, b) => b.box.y - a.box.y)[0]
    || (protectionSlide.decor || [])[0]
    || (protectionSlide.elements || [])[0];
  if (!protectionSlide || !protectionObject) throw new Error('protection browser fixture needs one slide object');
  const protectionObjectKind = (protectionSlide.decor || []).includes(protectionObject) ? 'decor' : 'element';
  const snapshot = {
    model,
    paused: !!state.paused,
    pausedBy: state.pausedBy || null,
    thumbs: 1,
    board: Array.isArray(board.notes) ? board.notes : [],
    tasks: Array.isArray(board.tasks) ? board.tasks : [],
    loops: Array.isArray(board.loops) ? board.loops : [],
    locks: [{ slideId: protectionSlide.id, by: 'worker-1' }],
    protections: [
      { kind: 'slide', slideId: protectionSlide.id, by: 'studio', createdAt: 1784577600000 },
      {
        kind: 'object', slideId: protectionSlide.id, objectId: protectionObject.id,
        objectKind: protectionObjectKind, by: 'studio', createdAt: 1784577660000,
      },
    ],
    protectionExceptions: [],
    editors: [], agents: [],
    profile: null, spend: null, loopRunner: null,
    undoCount: 0, redoCount: 0,
    pdfRev: state.pdfRev == null ? null : state.pdfRev,
    log: Array.isArray(state.log) ? state.log.slice(-80) : [],
  };
  const fixture = startFixtureServer(snapshot);
  const targets = [];
  let child = null, profile = null, debugPort = null;
  const checks = [];
  const check = (description, condition, detail) => checks.push({
    description, ok: !!condition, detail: condition ? undefined : detail,
  });

  try {
    const fixturePort = await fixture.listen();
    debugPort = await freePort();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-browser-smoke-'));
    child = spawn(browserPath, [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-gpu',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    await waitForDevtools(debugPort, child);

    const base = `http://127.0.0.1:${fixturePort}`;
    const studioTarget = await openTarget(debugPort, `${base}/studio`, 2200);
    targets.push(studioTarget);
    const waitForStudioSave = async () => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (await evalJs(studioTarget, 'pendingProtection === null')) return true;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return false;
    };
    const waitForFrontendIdle = async (target, variable, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evalJs(target, `typeof ${variable} === 'undefined' || ${variable} === null`)) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    const waitForBrowserState = async (target, expression, accepted, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let value;
      do {
        value = await evalJs(target, expression);
        if (accepted(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return value;
    };
    const studioReadyDeadline = Date.now() + 10000;
    let studioBootstrapState = null;
    while (Date.now() < studioReadyDeadline) {
      studioBootstrapState = await evalJs(studioTarget, `(() => ({
        readyState: document.readyState,
        modelDefined: typeof model !== 'undefined',
        modelIds: typeof model === 'undefined'
          ? []
          : (model.slides || []).map((slide) => slide.id),
        cardIds: Array.from(document.querySelectorAll('.card')).map((card) => card.dataset.slide),
        scripts: Array.from(document.scripts).map((script) => script.src),
      }))()`);
      if (studioBootstrapState.cardIds.length === model.slides.length
          && studioBootstrapState.cardIds.includes(protectionSlide.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!studioBootstrapState
        || studioBootstrapState.cardIds.length !== model.slides.length
        || !studioBootstrapState.cardIds.includes(protectionSlide.id)) {
      throw new Error(`Studio bootstrap did not render the expected deck: ${
        JSON.stringify(studioBootstrapState)
      }`);
    }
    const studioResult = await evalJs(studioTarget, `(() => {
      const expectedIds = ${JSON.stringify(model.slides.map((s) => s.id))};
      const protectionSlideId = ${JSON.stringify(protectionSlide.id)};
      const protectionObjectId = ${JSON.stringify(protectionObject.id)};
      const protectionObjectKind = ${JSON.stringify(protectionObjectKind)};
      const cards = Array.from(document.querySelectorAll('.card'));
      const ids = cards.map((card) => card.dataset.slide);
      const fallbackCount = document.querySelectorAll('.fallback').length;
      const spotCount = document.querySelectorAll('.spot').length;
      const protectionCard = document.querySelector('.card[data-slide="' + CSS.escape(protectionSlideId) + '"]');
      const protectedSpot = protectionCard.querySelector(
        '.spot[data-object-id="' + CSS.escape(protectionObjectId) + '"][data-object-kind="' + protectionObjectKind + '"]'
      );
      const durableAndTemporary = protectionCard.classList.contains('protected-slide')
        && protectionCard.classList.contains('claimed')
        && !!protectionCard.querySelector('[data-protection-summary]')
        && !!protectionCard.querySelector('[data-claim]')
        && /persistently protected/.test(protectionCard.getAttribute('aria-label'));
      const protectedObjectPainted = protectedSpot.classList.contains('protected-object')
        && /locked/.test(protectedSpot.getAttribute('aria-label'));
      const protectionListComplete = document.querySelectorAll('#protectionList .protection-row').length === 2
        && document.querySelectorAll('#protectionList .protection-unlock').length === 2
        && document.getElementById('protectionsCount').textContent === '2';
      const originalOwner = protectionItems[0].by;
      protectionItems[0].by = '<img id="protection-injection-probe" src=x>';
      renderProtections();
      const protectionOwnerEscaped = !document.getElementById('protection-injection-probe')
        && document.getElementById('protectionList').textContent.includes('<img id="protection-injection-probe"');
      protectionItems[0].by = originalOwner;
      renderProtections();
      const targetSlide = model.slides.find((s) => (s.elements || []).some((e) => e.text != null));
      const targetEl = targetSlide && targetSlide.elements.find((e) => e.text != null);
      let fallbackCurrent = false, cardPreserved = false;
      if (targetSlide && targetEl) {
        const card = document.querySelector('.card[data-slide="' + CSS.escape(targetSlide.id) + '"]');
        const sentinel = 'browser fallback sentinel';
        targetEl.text = sentinel;
        delete targetEl.items;
        refreshFallback({ slideId: targetSlide.id });
        cardPreserved = card === document.querySelector('.card[data-slide="' + CSS.escape(targetSlide.id) + '"]');
        fallbackCurrent = card.querySelector('.fallback').textContent.includes(sentinel);
      }
      lastGoodThumbsRev = null;
      checkStale();
      const unknownStale = document.getElementById('staleDot').classList.contains('amber');
      lastGoodThumbsRev = model.rev - 1;
      checkStale();
      const oneBehindStale = document.getElementById('staleDot').classList.contains('amber');
      lastGoodThumbsRev = model.rev;
      checkStale();
      const exactFresh = document.getElementById('staleDot').className === 'stale-dot';
      const chat = document.getElementById('chatinput');
      chat.focus();
      chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const chatBlurred = document.activeElement !== chat;
      const pausedPointer = getComputedStyle(document.querySelector('.paused-card')).pointerEvents;
      const pausedBody = document.body.classList.contains('paused');

      // Ordinary card navigation opens the slide but cannot issue a protection
      // request. A point click in the bottom band then selects the real
      // full-slide timeline-source decor that owns the visible path.
      protectionCard.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const navigationOpenedSlide = mode === 'single' && currentId === protectionSlideId;
      const frame = protectionCard.querySelector('.frame');
      const object = model.slides.find((slide) => slide.id === protectionSlideId)
        .decor.concat(model.slides.find((slide) => slide.id === protectionSlideId).elements || [])
        .find((item) => item.id === protectionObjectId);
      const rect = frame.getBoundingClientRect();
      const timelineOverlay = /(^|[\\\\/])timeline([\\\\/])/.test(String(object.source || ''));
      const clickX = timelineOverlay ? .5 : object.box.x + object.box.w / 2;
      const clickY = timelineOverlay ? .92 : object.box.y + object.box.h / 2;
      frame.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true,
        clientX: rect.left + clickX * rect.width,
        clientY: rect.top + clickY * rect.height,
      }));
      const bottomPathSelected = selectedObject && selectedObject.slideId === protectionSlideId
        && selectedObject.objectId === protectionObjectId
        && protectedSpot.classList.contains('selected-object');
      const quickbar = document.getElementById('lockQuickbar');
      const simpleLockUi = !quickbar.hidden
        && quickbar.querySelectorAll('[data-protection-toggle][data-kind="slide"]').length === 1
        && quickbar.querySelectorAll('[data-protection-toggle][data-kind="object"]').length === 0
        && /Double-click an item/.test(quickbar.textContent);
      const cardSlideControl = protectionCard.querySelector('[data-card-lock-toggle]');
      const explicitSlideControl = cardSlideControl
        && cardSlideControl.getAttribute('aria-pressed') === 'true'
        && /Unlock slide/.test(cardSlideControl.textContent);
      const objectKeyboardReachable = protectedSpot.tabIndex === 0
        && !!protectedSpot.getAttribute('aria-label');
      const kaijuSlide = model.slides.find((slide) =>
        (slide.decor || []).some((item) => item.id === 'd563324be'));
      let kaijuSelectable = false;
      if (kaijuSlide) {
        currentId = kaijuSlide.id;
        applyMode();
        const kaijuCard = document.querySelector('.card[data-slide="' + CSS.escape(kaijuSlide.id) + '"]');
        const kaijuSpot = kaijuCard && kaijuCard.querySelector(
          '.spot[data-object-id="d563324be"][data-object-kind="decor"]'
        );
        if (kaijuSpot) {
          kaijuSpot.focus();
          kaijuSpot.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
          kaijuSelectable = selectedObject && selectedObject.slideId === kaijuSlide.id
            && selectedObject.objectId === 'd563324be'
            && selectedObject.objectKind === 'decor'
            && kaijuSpot.classList.contains('selected-object')
            && kaijuSpot.tabIndex === 0
            && /Select .*slide/i.test(kaijuSpot.getAttribute('aria-label'));
        }
        currentId = protectionSlideId;
        applyMode();
        selectObject({
          kind: 'object',
          slideId: protectionSlideId,
          objectId: protectionObjectId,
          objectKind: protectionObjectKind,
        });
      }
      return {
        ready: document.readyState, rev: Number(document.getElementById('revLabel').textContent.replace(/\\D/g, '')),
        ids, expectedIds, fallbackCount, spotCount,
        fallbackCurrent, cardPreserved, unknownStale, oneBehindStale, exactFresh,
        chatBlurred, pausedPointer, pausedBody,
        durableAndTemporary, protectedObjectPainted, protectionListComplete,
        protectionOwnerEscaped, navigationOpenedSlide, bottomPathSelected,
        objectKeyboardReachable, kaijuSelectable, simpleLockUi, explicitSlideControl,
      };
    })()`);
    check('Studio renders every current slide in model order',
      JSON.stringify(studioResult.ids) === JSON.stringify(studioResult.expectedIds)
        && studioResult.ids.length === model.slides.length);
    check('Studio builds current fallbacks and hotspots',
      studioResult.fallbackCount === model.slides.length && studioResult.spotCount > 0);
    check('Studio patches fallback content without replacing its card',
      studioResult.fallbackCurrent && studioResult.cardPreserved);
    check('Studio freshness distinguishes unknown, one-behind, and exact revisions',
      studioResult.unknownStale && studioResult.oneBehindStale && studioResult.exactFresh);
    check('Studio distinguishes persistent protection from a temporary collaborator claim',
      studioResult.durableAndTemporary && studioResult.protectedObjectPainted);
    check('Studio lists every durable protection with human unlock controls',
      studioResult.protectionListComplete && studioResult.protectionOwnerEscaped);
    check('Studio navigation only selects, including timeline artwork and kaiju media',
      studioResult.navigationOpenedSlide && studioResult.bottomPathSelected
        && studioResult.objectKeyboardReachable && studioResult.kaijuSelectable
        && fixture.protectionRequests.length === 0);
    check('Studio presents one clear slide action and teaches the double-click object gesture',
      studioResult.simpleLockUi && studioResult.explicitSlideControl);

    // Every resident Studio panel must reserve stage space. Desktop uses a
    // right dock; supported narrow viewports use the same contract as a bottom
    // sheet. Exercise the real six chrome toggles plus the real keyboard path
    // that opens selected-item history, and close each through its own control.
    const capturePanelDocking = async (width, height) => {
      await studioTarget.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return evalJs(studioTarget, `(() => {
        const protectionSlideId = ${JSON.stringify(protectionSlide.id)};
        const protectionObjectId = ${JSON.stringify(protectionObject.id)};
        const protectionObjectKind = ${JSON.stringify(protectionObjectKind)};
        const stage = document.getElementById('stage');
        const tolerance = 1.25;
        const rectOf = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height,
          };
        };
        const inViewport = (rect) => !!rect
          && rect.left >= -tolerance && rect.top >= -tolerance
          && rect.right <= innerWidth + tolerance && rect.bottom <= innerHeight + tolerance
          && rect.width > 0 && rect.height > 0;
        const disjoint = (a, b) => !!a && !!b && (
          a.right <= b.left + tolerance || b.right <= a.left + tolerance
          || a.bottom <= b.top + tolerance || b.bottom <= a.top + tolerance
        );
        const sameRect = (a, b) => !!a && !!b
          && ['left', 'top', 'right', 'bottom'].every((key) =>
            Math.abs(a[key] - b[key]) <= tolerance);

        currentId = protectionSlideId;
        if (mode !== 'single') setMode('single');
        else applyMode();
        if (openPanel) {
          const initiallyOpen = document.querySelector('.panel:not([hidden])');
          const initialClose = initiallyOpen && initiallyOpen.querySelector('[data-close]');
          if (initialClose) initialClose.click();
          else setPanel(null);
        }
        const baseline = rectOf(stage);
        const wide = innerWidth > 980;
        const results = [];

        const exercise = (name, open, toggleId) => {
          let error = '';
          let panel = null;
          let openStage = null;
          let panelRect = null;
          let panelVisible = false;
          let bodyOpen = false;
          let historyClass = null;
          let togglePressed = null;
          try {
            open();
            panel = document.querySelector('.panel[data-panel="' + CSS.escape(name) + '"]');
            openStage = rectOf(stage);
            panelRect = rectOf(panel);
            panelVisible = !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none';
            bodyOpen = document.body.classList.contains('panel-open') && openPanel === name;
            historyClass = name === 'object-history'
              ? document.body.classList.contains('object-history-open') : null;
            const toggle = toggleId && document.getElementById(toggleId);
            togglePressed = toggle ? toggle.getAttribute('aria-pressed') : null;
          } catch (caught) {
            error = caught && caught.message ? caught.message : String(caught);
          }

          const stageStyle = getComputedStyle(stage);
          const stageVisible = stageStyle.display !== 'none'
            && stageStyle.visibility !== 'hidden' && Number(stageStyle.opacity || 1) > 0;
          const shrankOnDockAxis = wide
            ? !!openStage && openStage.width < baseline.width - 100
            : !!openStage && openStage.height < baseline.height - 100;
          const usableStage = !!openStage
            && openStage.width >= (wide ? 520 : Math.min(320, innerWidth - 20))
            && openStage.height >= (wide ? 300 : 150);
          const openGeometryOk = !error && panelVisible && bodyOpen
            && (name !== 'object-history' || historyClass)
            && (!toggleId || togglePressed === 'true')
            && stageVisible && inViewport(openStage) && inViewport(panelRect)
            && disjoint(openStage, panelRect) && shrankOnDockAxis && usableStage;

          const close = panel && panel.querySelector('[data-close]');
          if (close) close.click();
          else if (openPanel) setPanel(null);
          const closedStage = rectOf(stage);
          const closeRestored = !!panel && panel.hidden
            && !document.body.classList.contains('panel-open') && openPanel === null
            && sameRect(closedStage, baseline);
          results.push({
            name, error, openGeometryOk, closeRestored, panelVisible, bodyOpen,
            historyClass, togglePressed, baseline, openStage, panelRect, closedStage,
            noOverlap: disjoint(openStage, panelRect), shrankOnDockAxis, usableStage,
          });
        };

        [
          ['board', 'togBoard'],
          ['loops', 'togLoops'],
          ['tasks', 'togTasks'],
          ['protections', 'togProtections'],
          ['lint', 'togLint'],
          ['activity', 'togActivity'],
        ].forEach(([name, toggleId]) => exercise(
          name,
          () => document.getElementById(toggleId).click(),
          toggleId
        ));
        exercise('object-history', () => {
          const card = document.querySelector(
            '.card[data-slide="' + CSS.escape(protectionSlideId) + '"]'
          );
          const spot = card && card.querySelector(
            '.spot[data-object-id="' + CSS.escape(protectionObjectId)
              + '"][data-object-kind="' + protectionObjectKind + '"]'
          );
          if (!spot) throw new Error('selected-item history test hotspot is missing');
          spot.focus();
          spot.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        });

        const residentPanels = Array.from(document.querySelectorAll('.panel'))
          .map((panel) => panel.dataset.panel).sort();
        const exercisedPanels = results.map((result) => result.name).sort();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          requested: { width: ${width}, height: ${height} },
          wide, baseline,
          viewportMatches: innerWidth === ${width} && innerHeight === ${height},
          baselineSane: inViewport(baseline)
            && baseline.width >= Math.min(520, innerWidth)
            && baseline.height >= Math.min(300, innerHeight),
          completeCoverage: JSON.stringify(residentPanels) === JSON.stringify(exercisedPanels),
          residentPanels, exercisedPanels, results,
        };
      })()`);
    };

    let desktopPanelDocking = null;
    let narrowPanelDocking = null;
    try {
      desktopPanelDocking = await capturePanelDocking(1440, 900);
      narrowPanelDocking = await capturePanelDocking(760, 900);
    } finally {
      await evalJs(studioTarget, `(() => {
        if (openPanel) setPanel(null);
        return true;
      })()`);
      await studioTarget.send('Emulation.clearDeviceMetricsOverride');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const panelDockingPassed = (result) => !!result
      && result.viewportMatches && result.baselineSane && result.completeCoverage
      && result.results.every((panel) => panel.openGeometryOk && panel.closeRestored);
    check('Every Studio panel right-docks without covering the desktop stage and closes cleanly',
      panelDockingPassed(desktopPanelDocking), desktopPanelDocking);
    check('Every Studio panel bottom-docks without covering the narrow stage and closes cleanly',
      panelDockingPassed(narrowPanelDocking), narrowPanelDocking);

    const rehearsalPaceResult = await evalJs(studioTarget, `(() => {
      const firstId = 's1';
      const secondId = 's15';
      const qaId = 'sef432705';
      const protectionSlideId = ${JSON.stringify(protectionSlide.id)};
      const reorderedSlides = [
        model.slides.find((slide) => slide.id === secondId),
        model.slides.find((slide) => slide.id === firstId),
        ...model.slides.filter((slide) => slide.id !== firstId && slide.id !== secondId),
      ];
      const reorderedPlan = rehearsalPacePlan({ slides: reorderedSlides });
      const reorderedStableIds = reorderedPlan.totalSeconds === 685
        && reorderedPlan.bufferSeconds === 35
        && reorderedPlan.slides.get(secondId).start === 0
        && reorderedPlan.slides.get(secondId).end === 45
        && reorderedPlan.slides.get(firstId).start === 45
        && reorderedPlan.slides.get(firstId).end === 75
        && reorderedPlan.slides.get('s2').start === 75
        && reorderedPlan.slides.get('s2').end === 120
        && !reorderedPlan.slides.has(qaId);
      setMode('grid');
      currentId = firstId;
      setMode('single');
      const startedAt = rehearsalPaceStartedAtMs;
      const startedTimer = rehearsalPaceTimer;
      const started = mode === 'single' && startedAt !== null
        && document.getElementById('stage').classList.contains('pace-running')
        && !document.getElementById('rehearsalPaceReadout').hidden
        && /0:35 buffer.*cap 12:00/.test(
          document.getElementById('rehearsalPaceReadout').textContent
        );

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', bubbles: true, cancelable: true,
      }));
      const advanced = currentId === secondId && rehearsalPaceStartedAtMs === startedAt;
      rehearsalPaceStartedAtMs = Date.now() - 75500;
      paintRehearsalPace();
      const secondCard = document.querySelector('.card[data-slide="' + CSS.escape(secondId) + '"]');
      const frame = secondCard.querySelector('.frame');
      const frameRect = frame.getBoundingClientRect();
      const cueStyle = getComputedStyle(frame, '::before');
      const readout = document.getElementById('rehearsalPaceReadout');
      const behind = secondCard.classList.contains('pace-behind')
        && readout.getAttribute('data-pace-state') === 'behind';
      const bufferVisible = readout.getAttribute('data-pace-buffer') === '34'
        && /0:34 buffer.*cap 12:00/.test(readout.textContent)
        && /checkpoints end at 11:25.*12:00 hard cap/.test(readout.title);
      const cueConfinedAndPassive = cueStyle.pointerEvents === 'none'
        && parseFloat(cueStyle.height) > 0
        && parseFloat(cueStyle.height) < frameRect.height * .25;
      const readoutOutsideSlide = readout.parentElement === document.getElementById('stage')
        && !secondCard.contains(readout);

      setMode('grid');
      const endedInGrid = rehearsalPaceStartedAtMs === null && rehearsalPaceTimer === null
        && readout.hidden && !document.getElementById('stage').classList.contains('pace-running');
      currentId = firstId;
      setMode('single');
      const restartedAt = rehearsalPaceStartedAtMs;
      const restarted = restartedAt !== null && restartedAt >= startedAt
        && rehearsalPaceTimer !== null && rehearsalPaceTimer !== startedTimer
        && readout.getAttribute('data-pace-state') === 'on-pace';

      rehearsalPaceStartedAtMs = Date.now() - 800000;
      currentId = qaId;
      applyMode();
      const qaCard = document.querySelector('.card[data-slide="' + CSS.escape(qaId) + '"]');
      const qaExcluded = !rehearsalPacePlan().slides.has(qaId)
        && readout.getAttribute('data-pace-state') === 'qa'
        && /Q&A untimed.*talk cap 12:00/.test(readout.textContent)
        && !qaCard.classList.contains('pace-behind');

      // Leave the existing smoke flow on its original fixture slide.
      setMode('grid');
      currentId = protectionSlideId;
      setMode('single');
      return {
        total: rehearsalPacePlan().totalSeconds,
        hardCap: rehearsalPacePlan().hardCapSeconds,
        buffer: rehearsalPacePlan().bufferSeconds,
        reorderedStableIds, started, advanced, behind, bufferVisible, cueConfinedAndPassive,
        readoutOutsideSlide, endedInGrid, restarted, qaExcluded,
      };
    })()`);
    check('Studio uses the 11:25 pace, follows stable-ID reorders, preserves the buffer, and excludes Q&A',
      rehearsalPaceResult.total === 685
        && rehearsalPaceResult.hardCap === 720 && rehearsalPaceResult.buffer === 35
        && rehearsalPaceResult.reorderedStableIds
        && rehearsalPaceResult.started && rehearsalPaceResult.advanced
        && rehearsalPaceResult.behind && rehearsalPaceResult.bufferVisible
        && rehearsalPaceResult.cueConfinedAndPassive
        && rehearsalPaceResult.readoutOutsideSlide && rehearsalPaceResult.endedInGrid
        && rehearsalPaceResult.restarted && rehearsalPaceResult.qaExcluded,
      rehearsalPaceResult);

    const doubleClickProtectionObject = async () => evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const objectId = ${JSON.stringify(protectionObject.id)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      const frame = card.querySelector('.frame');
      const slide = model.slides.find((item) => item.id === slideId);
      const object = (slide.decor || []).concat(slide.elements || [])
        .find((item) => item.id === objectId);
      const rect = frame.getBoundingClientRect();
      const timelineOverlay = /(^|[\\\\/])timeline([\\\\/])/.test(String(object.source || ''));
      const x = timelineOverlay ? .5 : object.box.x + object.box.w / 2;
      const y = timelineOverlay ? .92 : object.box.y + object.box.h / 2;
      const init = { bubbles: true, cancelable: true,
        clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height };
      lastObjectPick = null;
      doubleClickTarget = null;
      frame.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
      const firstId = selectedObject && selectedObject.objectId;
      frame.dispatchEvent(new MouseEvent('click', { ...init, detail: 2 }));
      const secondId = selectedObject && selectedObject.objectId;
      frame.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
      return firstId === objectId && secondId === objectId;
    })()`);
    const firstDoubleClickStable = await doubleClickProtectionObject();
    const unlockedSettled = await waitForStudioSave();
    const unlocked = await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const objectId = ${JSON.stringify(protectionObject.id)};
      const objectKind = ${JSON.stringify(protectionObjectKind)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      const spot = card.querySelector(
        '.spot[data-object-id="' + CSS.escape(objectId) + '"][data-object-kind="' + objectKind + '"]'
      );
      return card.classList.contains('protected-slide')
        && spot.classList.contains('unlocked-object')
        && !spot.classList.contains('protected-object')
        && protectionExceptionItems.length === 1
        && document.querySelectorAll('#protectionList .protection-row.exception').length === 1
        && /1 editable/.test(document.getElementById('lockQuickbar').textContent);
    })()`);
    const secondDoubleClickStable = await doubleClickProtectionObject();
    const lockedSettled = await waitForStudioSave();
    const protectionToggleResult = await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const objectId = ${JSON.stringify(protectionObject.id)};
      const objectKind = ${JSON.stringify(protectionObjectKind)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      const spot = card.querySelector(
        '.spot[data-object-id="' + CSS.escape(objectId) + '"][data-object-kind="' + objectKind + '"]'
      );
      const state = protectionStateForTarget({
        kind: 'object', slideId, objectId, objectKind,
      });
      return {
        relocked: card.classList.contains('protected-slide')
          && !spot.classList.contains('unlocked-object')
          && state.locked && state.source === 'slide',
        count: document.querySelectorAll('#protectionList .protection-row').length,
        exceptions: protectionExceptionItems.length,
      };
    })()`);
    check('Studio double-click unlocks/relocks one stable object beneath a locked slide',
      firstDoubleClickStable && secondDoubleClickStable &&
        unlockedSettled && unlocked && lockedSettled && protectionToggleResult.relocked
        && protectionToggleResult.count === 1
        && protectionToggleResult.exceptions === 0
        && fixture.protectionRequests.length === 2
        && fixture.protectionRequests.every((body) => body.kind === 'object'
          && body.slideId === protectionSlide.id
          && body.objectId === protectionObject.id
          && body.objectKind === protectionObjectKind
          && body.by === 'josh'));

    fixture.failNextProtection();
    await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const selector = '[data-protection-toggle][data-kind="slide"][data-slide-id="'
        + CSS.escape(slideId) + '"]';
      document.querySelector(selector).click();
      return true;
    })()`);
    const rollbackSettled = await waitForStudioSave();
    const rollbackResult = await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      return {
        stillProtected: card.classList.contains('protected-slide'),
        count: document.querySelectorAll('#protectionList .protection-row').length,
        errorShown: /not saved/.test(document.getElementById('toast').textContent)
          && document.getElementById('toast').classList.contains('err'),
      };
    })()`);
    check('Studio rolls optimistic protection UI back when the API rejects it',
      rollbackSettled && rollbackResult.stillProtected
        && rollbackResult.count === 1 && rollbackResult.errorShown
        && fixture.protectionRequests.length === 3);

    fixture.malformNextProtection();
    await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const selector = '[data-protection-toggle][data-kind="slide"][data-slide-id="'
        + CSS.escape(slideId) + '"]';
      document.querySelector(selector).click();
      return true;
    })()`);
    const malformedRollbackSettled = await waitForStudioSave();
    const malformedRollbackResult = await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      return {
        stillProtected: card.classList.contains('protected-slide'),
        count: document.querySelectorAll('#protectionList .protection-row').length,
        errorShown: /not saved/.test(document.getElementById('toast').textContent)
          && document.getElementById('toast').classList.contains('err'),
      };
    })()`);
    check('Studio rolls back malformed successful protection responses',
      malformedRollbackSettled && malformedRollbackResult.stillProtected
        && malformedRollbackResult.count === 1 && malformedRollbackResult.errorShown
        && fixture.protectionRequests.length === 4);

    await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const selector = '[data-protection-toggle][data-kind="slide"][data-slide-id="'
        + CSS.escape(slideId) + '"]';
      document.querySelector(selector).click();
      return true;
    })()`);
    const recursiveUnlockSettled = await waitForStudioSave();
    const recursiveUnlockResult = await evalJs(studioTarget, `(() => {
      const slideId = ${JSON.stringify(protectionSlide.id)};
      const card = document.querySelector('.card[data-slide="' + CSS.escape(slideId) + '"]');
      return {
        unlocked: !card.classList.contains('protected-slide'),
        noRows: !protectionItems.some((item) => item.slideId === slideId)
          && !protectionExceptionItems.some((item) => item.slideId === slideId),
        message: document.getElementById('toast').textContent,
      };
    })()`);
    check('Studio slide unlock makes the entire slide tree editable and says so',
      recursiveUnlockSettled && recursiveUnlockResult.unlocked && recursiveUnlockResult.noRows &&
        /every item is editable/i.test(recursiveUnlockResult.message) &&
        fixture.protectionRequests.length === 5 &&
        fixture.protectionRequests[4].kind === 'slide' &&
        fixture.protectionRequests[4].protected === false);

    await studioTarget.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    // Motion preview is entirely read-only and starts only for the current
    // single slide. Current s8 has no object build: its approved kaiju is a
    // model-bound click-to-play MP4 over the canonical poster thumbnail.
    const s8SlideNumber = model.slides.findIndex((slide) => slide.id === 's8') + 1;
    const expectedS8Thumbnail = `/thumbs/slide-${s8SlideNumber}.png`;
    const mediaInitial = await evalJs(studioTarget, `(() => {
      currentId = 's8';
      setMode('single');
      const card = document.querySelector('.card[data-slide="s8"]');
      const frame = card.querySelector('.frame');
      const canonical = frame.querySelector(':scope > img');
      const state = studioAnimationPreview && studioAnimationPreview.getState();
      const shell = frame.querySelector('[data-media-preview="d563324be"]');
      const video = shell && shell.querySelector('video');
      const controls = frame.querySelector('.sap-media-controls');
      return {
        state,
        canonicalSrc: canonical && canonical.getAttribute('src'),
        canonicalConnected: !!canonical && canonical.isConnected,
        shellCount: frame.querySelectorAll('.sap-media-preview').length,
        box: shell && [shell.style.left, shell.style.top, shell.style.width, shell.style.height],
        source: video && video.getAttribute('src'),
        poster: video && video.getAttribute('poster'),
        autoplay: video && video.autoplay,
        loop: video && video.loop,
        muted: video && video.muted,
        defaultMuted: video && video.defaultMuted,
        playsInline: video && video.playsInline,
        animationControls: frame.querySelectorAll('.sap-controls').length,
        caveat: controls && controls.querySelector('.sap-media-caveat').textContent,
        caveatTitle: controls && controls.querySelector('.sap-media-caveat').title,
        controlsLabel: controls && controls.getAttribute('aria-label'),
        buttonLabel: controls && controls.querySelector('button').getAttribute('aria-label'),
        live: controls && controls.querySelector('.sap-media-status').getAttribute('aria-live'),
      };
    })()`);
    const mediaLoaded = await waitForBrowserState(studioTarget, `(() => {
      const video = document.querySelector('.card[data-slide="s8"] [data-media-preview="d563324be"] video');
      return {
        readyState: video && video.readyState,
        duration: video && video.duration,
        currentTime: video && video.currentTime,
        paused: video && video.paused,
        error: video && video.error && video.error.code,
        state: studioAnimationPreview.getState(),
        status: document.querySelector('.card[data-slide="s8"] .sap-media-status').textContent,
      };
    })()`, (value) => value && value.readyState >= 1 && Number.isFinite(value.duration));
    check('Studio mounts current s8 media at exact model geometry over the untouched thumbnail',
      mediaInitial.state && mediaInitial.state.active
        && mediaInitial.state.slideId === 's8'
        && mediaInitial.state.totalSteps === 0
        && mediaInitial.state.supportedObjects === 0
        && mediaInitial.state.mediaObjects === 1
        && mediaInitial.state.unsupportedMedia === 0
        && mediaInitial.shellCount === 1
        && JSON.stringify(mediaInitial.box) === JSON.stringify(['69.75%', '55.2%', '19.5%', '23.1%'])
        && mediaInitial.canonicalConnected
        && s8SlideNumber > 0 && mediaInitial.canonicalSrc.startsWith(expectedS8Thumbnail)
        && /media-preview-asset/.test(mediaInitial.source)
        && /animation-preview-asset/.test(mediaInitial.poster)
        && mediaInitial.autoplay === false && mediaInitial.loop === false
        && mediaInitial.muted === true && mediaInitial.defaultMuted === true
        && mediaInitial.playsInline === true
        && mediaInitial.animationControls === 0,
      mediaInitial);
    check('Studio labels browser media playback and exposes an accessible status/control',
      mediaInitial.caveat === 'Browser video'
        && /PowerPoint/.test(mediaInitial.caveatTitle)
        && mediaInitial.controlsLabel === 'Embedded video preview controls'
        && /embedded video preview/i.test(mediaInitial.buttonLabel)
        && mediaInitial.live === 'polite');
    check('Current s8 click-kaiju loads paused at frame zero without replacing its poster thumbnail',
      mediaLoaded.readyState >= 1
        && mediaLoaded.duration > 5 && mediaLoaded.duration < 6
        && mediaLoaded.currentTime === 0
        && mediaLoaded.paused === true
        && !mediaLoaded.error
        && !mediaLoaded.state.mediaPlaying
        && /Video ready; click the video or press Play video/.test(mediaLoaded.status),
      mediaLoaded);

    const mediaPageDown = await evalJs(studioTarget, `(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'PageDown', bubbles: true, cancelable: true,
      });
      const uncancelled = document.body.dispatchEvent(event);
      return { uncancelled, slideId: currentId, state: studioAnimationPreview.getState() };
    })()`);
    check('Media-only slides do not steal object-build keyboard shortcuts',
      mediaPageDown.uncancelled && mediaPageDown.slideId === 's8'
        && mediaPageDown.state.totalSteps === 0);

    await evalJs(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      frame.querySelector('[data-sap-media-action="toggle"]').click();
      return true;
    })()`);
    const mediaControlStarted = await waitForBrowserState(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const video = frame.querySelector('video');
      return {
        paused: video.paused,
        button: frame.querySelector('[data-sap-media-action="toggle"]').textContent,
      };
    })()`, (value) => value && !value.paused && value.button === 'Pause video');
    await evalJs(studioTarget, `document.querySelector('.card[data-slide="s8"] [data-sap-media-action="toggle"]').click()`);
    const mediaControlPaused = await waitForBrowserState(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const video = frame.querySelector('video');
      return {
        state: studioAnimationPreview.getState(),
        paused: video.paused,
        button: frame.querySelector('[data-sap-media-action="toggle"]').textContent,
      };
    })()`, (value) => value && value.paused && value.button === 'Play video');
    check('Studio media control starts and pauses the click-to-play clip',
      !mediaControlStarted.paused && mediaControlStarted.button === 'Pause video'
        && mediaControlPaused.paused && mediaControlPaused.button === 'Play video'
        && !mediaControlPaused.state.mediaPlaying,
      { mediaControlStarted, mediaControlPaused });

    const directMediaInitial = await evalJs(studioTarget, `(() => {
      const slide = model.slides.find((item) => item.id === 's8');
      const media = slide.decor.find((item) => item.id === 'd563324be');
      window.__s8OriginalAutoplay = media.autoplay;
      media.autoplay = false;
      setMode('grid');
      currentId = 's8';
      setMode('single');
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const shell = frame.querySelector('[data-media-preview="d563324be"]');
      const video = shell.querySelector('video');
      window.__directMediaClickDetails = [];
      frame.addEventListener('click', (event) => {
        if (event.target === video) window.__directMediaClickDetails.push(event.detail);
      });
      window.__clickDirectMedia = (detail) => {
        const rect = video.getBoundingClientRect();
        video.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, detail,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      };
      return {
        autoplay: video.autoplay,
        paused: video.paused,
        currentTime: video.currentTime,
        role: video.getAttribute('role'),
        tabIndex: video.tabIndex,
        label: video.getAttribute('aria-label'),
        pressed: video.getAttribute('aria-pressed'),
        title: video.title,
        shellPointer: getComputedStyle(shell).pointerEvents,
        videoCursor: getComputedStyle(video).cursor,
        status: frame.querySelector('.sap-media-status').textContent,
        explicitControl: !!frame.querySelector('[data-sap-media-action="toggle"]'),
      };
    })()`);
    check('Non-autoplay media exposes an intuitive clickable and keyboard-accessible surface',
      directMediaInitial.autoplay === false && directMediaInitial.paused
        && directMediaInitial.currentTime === 0
        && directMediaInitial.role === 'button' && directMediaInitial.tabIndex === 0
        && /^Play embedded video preview on slide s8$/.test(directMediaInitial.label)
        && directMediaInitial.pressed === 'false'
        && directMediaInitial.title === 'Play video'
        && directMediaInitial.shellPointer === 'auto'
        && directMediaInitial.videoCursor === 'pointer'
        && /click the video or press Play video/.test(directMediaInitial.status)
        && directMediaInitial.explicitControl,
      directMediaInitial);

    await evalJs(studioTarget, `window.__clickDirectMedia(1)`);
    const directMediaStarted = await waitForBrowserState(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const video = frame.querySelector('[data-media-preview="d563324be"] video');
      return {
        paused: video.paused,
        currentTime: video.currentTime,
        label: video.getAttribute('aria-label'),
        pressed: video.getAttribute('aria-pressed'),
        button: frame.querySelector('[data-sap-media-action="toggle"]').textContent,
        clickDetails: window.__directMediaClickDetails.slice(),
        selectedSlide: selectedObject && selectedObject.slideId,
      };
    })()`, (value) => value && !value.paused && value.currentTime > 0);
    check('One direct media click starts at frame zero and still bubbles for Studio selection',
      !directMediaStarted.paused
        && directMediaStarted.currentTime > 0 && directMediaStarted.currentTime < 2
        && /^Pause embedded video preview on slide s8$/.test(directMediaStarted.label)
        && directMediaStarted.pressed === 'true'
        && directMediaStarted.button === 'Pause video'
        && JSON.stringify(directMediaStarted.clickDetails) === JSON.stringify([1])
        && directMediaStarted.selectedSlide === 's8',
      directMediaStarted);

    await evalJs(studioTarget, `window.__clickDirectMedia(1)`);
    const directMediaPaused = await waitForBrowserState(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const video = frame.querySelector('[data-media-preview="d563324be"] video');
      return {
        paused: video.paused,
        currentTime: video.currentTime,
        label: video.getAttribute('aria-label'),
        pressed: video.getAttribute('aria-pressed'),
        button: frame.querySelector('[data-sap-media-action="toggle"]').textContent,
      };
    })()`, (value) => value && value.paused);
    check('A second direct media click pauses without removing the explicit control',
      directMediaPaused.paused && directMediaPaused.currentTime > 0
        && /^Play embedded video preview on slide s8$/.test(directMediaPaused.label)
        && directMediaPaused.pressed === 'false'
        && directMediaPaused.button === 'Play video',
      directMediaPaused);

    await evalJs(studioTarget, `(() => {
      const video = document.querySelector(
        '.card[data-slide="s8"] [data-media-preview="d563324be"] video'
      );
      video.currentTime = video.duration;
      window.__clickDirectMedia(1);
      return true;
    })()`);
    const directMediaBeforeDoubleClick = await waitForBrowserState(studioTarget, `(() => {
      const video = document.querySelector(
        '.card[data-slide="s8"] [data-media-preview="d563324be"] video'
      );
      return video.currentTime;
    })()`, (value) => Number.isFinite(value) && value > 0 && value < 2);
    await evalJs(studioTarget, `window.__clickDirectMedia(2)`);
    const directMediaRestarted = await waitForBrowserState(studioTarget, `(() => {
      const video = document.querySelector(
        '.card[data-slide="s8"] [data-media-preview="d563324be"] video'
      );
      return {
        paused: video.paused,
        currentTime: video.currentTime,
        label: video.getAttribute('aria-label'),
        clickDetails: window.__directMediaClickDetails.slice(),
      };
    })()`, (value) => value && value.currentTime > directMediaBeforeDoubleClick);
    check('Click after the end restarts at zero and a double-click second click does not pause it',
      !directMediaRestarted.paused
        && directMediaBeforeDoubleClick >= 0
        && directMediaBeforeDoubleClick < 2
        && directMediaRestarted.currentTime > directMediaBeforeDoubleClick
        && /^Pause embedded video preview on slide s8$/.test(directMediaRestarted.label)
        && JSON.stringify(directMediaRestarted.clickDetails) === JSON.stringify([1, 1, 1, 2]),
      directMediaRestarted);

    await evalJs(studioTarget, `(() => {
      const slide = model.slides.find((item) => item.id === 's8');
      const media = slide.decor.find((item) => item.id === 'd563324be');
      media.autoplay = window.__s8OriginalAutoplay;
      delete window.__s8OriginalAutoplay;
      delete window.__directMediaClickDetails;
      delete window.__clickDirectMedia;
      applyMode();
      return true;
    })()`);

    const mediaGrid = await evalJs(studioTarget, `(() => {
      setMode('grid');
      return {
        previewNodes: document.querySelectorAll(
          '.sap-media-preview, .sap-media-controls, .sap-cover, .sap-reveal, .sap-controls'
        ).length,
        canonicalCount: document.querySelectorAll('.frame > img').length,
        active: studioAnimationPreview.getState().active,
      };
    })()`);
    check('Grid mode removes every media/build preview node and remains canonical',
      mediaGrid.previewNodes === 0 && mediaGrid.canonicalCount === model.slides.length
        && !mediaGrid.active);

    await studioTarget.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedMedia = await evalJs(studioTarget, `(() => {
      currentId = 's8';
      setMode('single');
      const frame = document.querySelector('.card[data-slide="s8"] .frame');
      const video = frame.querySelector('video');
      return {
        state: studioAnimationPreview.getState(),
        autoplay: video.autoplay,
        paused: video.paused,
        currentTime: video.currentTime,
        poster: video.getAttribute('poster'),
        status: frame.querySelector('.sap-media-status').textContent,
        buttonDisabled: frame.querySelector('[data-sap-media-action="toggle"]').disabled,
      };
    })()`);
    check('Reduced-motion mode suppresses autoplay but keeps the poster and opt-in control',
      reducedMedia.state.reducedMotion
        && reducedMedia.autoplay === false && reducedMedia.paused
        && reducedMedia.currentTime === 0
        && /animation-preview-asset/.test(reducedMedia.poster)
        && /reduced motion/.test(reducedMedia.status)
        && !reducedMedia.buttonDisabled);

    const pipelineInitial = await evalJs(studioTarget, `(() => {
      currentId = 's3';
      applyMode();
      const frame = document.querySelector('.card[data-slide="s3"] .frame');
      return {
        state: studioAnimationPreview.getState(),
        covers: frame.querySelectorAll('.sap-cover').length,
        progressMax: frame.querySelector('.sap-progress').max,
      };
    })()`);
    await evalJs(studioTarget, `(() => {
      document.querySelector('.card[data-slide="s3"] [data-sap-action="play"]').click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pipelinePlayed = await evalJs(studioTarget, `(() => {
      const frame = document.querySelector('.card[data-slide="s3"] .frame');
      return {
        state: studioAnimationPreview.getState(),
        hidden: Array.from(frame.querySelectorAll('.sap-cover')).every((cover) => cover.hidden),
        progress: frame.querySelector('.sap-progress').value,
        status: frame.querySelector('.sap-status').textContent,
      };
    })()`);
    check('Play respects reduced motion while completing twelve objects in five s3 speaking clicks',
      pipelineInitial.state.totalSteps === 5
        && pipelineInitial.state.supportedObjects === 12
        && pipelineInitial.covers === 12
        && pipelineInitial.progressMax === 5
        && pipelinePlayed.state.completed === 5
        && !pipelinePlayed.state.playing
        && pipelinePlayed.hidden
        && pipelinePlayed.progress === 5
        && /reduced motion/.test(pipelinePlayed.status));

    const staticFallback = await evalJs(studioTarget, `(() => {
      const slide = model.slides.find((item) => item.id === 's3');
      window.__s3Animations = slide.animations;
      slide.animations = [{
        targetId: 'missing-preview-target',
        effect: 'fade', trigger: 'click', duration: .45, delay: 0,
      }];
      currentId = 's3';
      applyMode();
      const frame = document.querySelector('.card[data-slide="s3"] .frame');
      const result = {
        state: studioAnimationPreview.getState(),
        covers: frame.querySelectorAll('.sap-cover').length,
        status: frame.querySelector('.sap-status').textContent,
        nextDisabled: frame.querySelector('[data-sap-action="next"]').disabled,
      };
      slide.animations = window.__s3Animations;
      delete window.__s3Animations;
      setMode('grid');
      result.previewNodesInGrid = document.querySelectorAll(
        '.sap-cover, .sap-reveal, .sap-controls, .sap-media-preview, .sap-media-controls'
      ).length;
      result.canonicalCount = document.querySelectorAll('.frame > img').length;
      return result;
    })()`);
    check('Missing geometry falls back to labelled static thumbnails and grid stays canonical',
      staticFallback.state.active
        && staticFallback.state.supportedObjects === 0
        && staticFallback.state.unsupportedObjects === 1
        && staticFallback.covers === 0
        && /Static thumbnail only/.test(staticFallback.status)
        && staticFallback.nextDisabled
        && staticFallback.previewNodesInGrid === 0
        && staticFallback.canonicalCount === model.slides.length
        && fixture.protectionRequests.length === 5);

    // Install a page-local download sink. It observes the real Blob/object-URL
    // path without allowing headless Chrome to write into a user download
    // directory, and lets us verify revocation after the synthetic anchor click.
    await evalJs(studioTarget, `(() => {
      window.__downloadRecords = [];
      window.__downloadBlobs = new Map();
      const nativeCreate = URL.createObjectURL.bind(URL);
      const nativeRevoke = URL.revokeObjectURL.bind(URL);
      const nativeAnchorClick = HTMLAnchorElement.prototype.click;
      window.__resetDownloadCapture = () => { window.__downloadRecords.length = 0; };
      URL.createObjectURL = (blob) => {
        const url = nativeCreate(blob);
        const record = { url, type: blob.type, size: blob.size, filename: '', clicked: false, revoked: false };
        window.__downloadRecords.push(record);
        window.__downloadBlobs.set(url, record);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        const record = window.__downloadBlobs.get(url);
        if (record) record.revoked = true;
        nativeRevoke(url);
      };
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return nativeAnchorClick.call(this);
        const record = window.__downloadBlobs.get(this.href);
        if (record) {
          record.filename = this.download;
          record.clicked = true;
        }
      };
      return true;
    })()`);

    fixture.configurePptx([
      { status: 409, json: { ok: false, error: 'presentation is not current' } },
      { status: 200, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: [0x50, 0x4b, 0x03, 0x04, 0x14] },
    ], [false, true]);
    const staleBusy = await evalJs(studioTarget, `(() => {
      window.__resetDownloadCapture();
      const desktop = document.getElementById('downloadBtn');
      desktop.click();
      return {
        desktopDisabled: desktop.disabled,
        compactDisabled: document.getElementById('compactDownloadBtn').disabled,
        busy: desktop.getAttribute('aria-busy'),
        text: desktop.textContent,
        path: location.pathname,
      };
    })()`);
    const staleSettled = await waitForFrontendIdle(studioTarget, 'pptxDownloadInFlight');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const staleDownload = await evalJs(studioTarget, `(() => ({
      records: window.__downloadRecords,
      desktopDisabled: document.getElementById('downloadBtn').disabled,
      compactDisabled: document.getElementById('compactDownloadBtn').disabled,
      path: location.pathname,
    }))()`);
    check('Studio stale PPTX waits for health, downloads binary, and restores both controls',
      staleSettled && staleBusy.desktopDisabled && staleBusy.compactDisabled
        && staleBusy.busy === 'true' && /Preparing/.test(staleBusy.text)
        && JSON.stringify(fixture.downloadRequests.map((item) => item.path))
          === JSON.stringify(['/api/pptx', '/api/health', '/api/health', '/api/pptx'])
        && staleDownload.records.length === 1
        && staleDownload.records[0].clicked
        && staleDownload.records[0].revoked
        && staleDownload.records[0].filename === 'presentation.pptx'
        && staleDownload.records[0].type
          === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        && !staleDownload.desktopDisabled && !staleDownload.compactDisabled
        && staleBusy.path === '/studio' && staleDownload.path === '/studio',
      { staleBusy, staleDownload, requests: fixture.downloadRequests });

    fixture.configurePptx([
      { status: 500, json: { ok: false, error: 'fixture permanent PPTX failure' } },
    ], []);
    await evalJs(studioTarget, `(() => {
      window.__resetDownloadCapture();
      document.getElementById('downloadBtn').click();
      return true;
    })()`);
    const permanentSettled = await waitForFrontendIdle(studioTarget, 'pptxDownloadInFlight');
    const permanentDownload = await evalJs(studioTarget, `(() => ({
      records: window.__downloadRecords,
      toast: document.getElementById('toast').textContent,
      disabled: document.getElementById('downloadBtn').disabled,
      path: location.pathname,
    }))()`);
    check('Studio permanent PPTX errors stay in-page and never become downloads',
      permanentSettled && permanentDownload.records.length === 0
        && /fixture permanent PPTX failure/.test(permanentDownload.toast)
        && !permanentDownload.disabled && permanentDownload.path === '/studio'
        && JSON.stringify(fixture.downloadRequests.map((item) => item.path))
          === JSON.stringify(['/api/pptx']),
      { permanentDownload, requests: fixture.downloadRequests });

    fixture.configurePptx([
      { status: 200, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: [0x50, 0x4b, 0x03, 0x04, 0x14] },
    ], []);
    const doubleBusy = await evalJs(studioTarget, `(() => {
      window.__resetDownloadCapture();
      const button = document.getElementById('downloadBtn');
      button.click();
      button.click();
      return button.disabled;
    })()`);
    const doubleSettled = await waitForFrontendIdle(studioTarget, 'pptxDownloadInFlight');
    const doubleDownload = await evalJs(studioTarget, 'window.__downloadRecords');
    check('Studio double-click starts exactly one PPTX request and one download',
      doubleBusy && doubleSettled && fixture.downloadRequests.length === 1
        && fixture.downloadRequests[0].path === '/api/pptx'
        && doubleDownload.length === 1 && doubleDownload[0].clicked,
      { doubleDownload, requests: fixture.downloadRequests });

    fixture.configurePptx([
      { status: 200, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: [0x50, 0x4b, 0x03, 0x04, 0x14] },
    ], []);
    const compactBusy = await evalJs(studioTarget, `(() => {
      window.__resetDownloadCapture();
      const button = document.getElementById('compactDownloadBtn');
      button.click();
      return {
        compact: button.disabled,
        desktop: document.getElementById('downloadBtn').disabled,
      };
    })()`);
    const compactSettled = await waitForFrontendIdle(studioTarget, 'pptxDownloadInFlight');
    const compactDownload = await evalJs(studioTarget, 'window.__downloadRecords');
    check('Studio compact PPTX control uses the same guarded download path',
      compactBusy.compact && compactBusy.desktop && compactSettled
        && fixture.downloadRequests.length === 1
        && compactDownload.length === 1 && compactDownload[0].clicked
        && compactDownload[0].filename === 'presentation.pptx',
      { compactBusy, compactDownload, requests: fixture.downloadRequests });

    fixture.configurePdf(
      [{ status: 200, json: { ok: true, ver: 2 } }],
      [{ status: 404, json: { error: 'fixture PDF download missing' } }],
    );
    await evalJs(studioTarget, `(() => {
      window.__resetDownloadCapture();
      document.getElementById('exportPdfBtn').click();
      return true;
    })()`);
    const pdfSettled = await waitForFrontendIdle(studioTarget, 'pdfExportInFlight');
    const pdfFailure = await evalJs(studioTarget, `(() => ({
      records: window.__downloadRecords,
      toast: document.getElementById('toast').textContent,
      disabled: document.getElementById('exportPdfBtn').disabled,
      path: location.pathname,
    }))()`);
    check('Studio PDF export success plus JSON download error remains in-page',
      pdfSettled && pdfFailure.records.length === 0
        && /fixture PDF download missing/.test(pdfFailure.toast)
        && !pdfFailure.disabled && pdfFailure.path === '/studio'
        && JSON.stringify(fixture.downloadRequests.map((item) => item.path))
          === JSON.stringify(['/api/pdf/export', '/api/pdf']),
      { pdfFailure, requests: fixture.downloadRequests });

    const emptyVisible = await evalJs(studioTarget, `(() => {
      model = Object.assign({}, model, { slides: [] });
      build();
      return !document.getElementById('deckEmpty').hidden;
    })()`);
    check('Studio empty/chat/pause interaction states are usable',
      emptyVisible && studioResult.chatBlurred && studioResult.pausedPointer === 'none'
        && studioResult.pausedBody === snapshot.paused);
    await studioTarget.closeTarget();
    targets.pop();

    const dashboardTarget = await openTarget(debugPort, `${base}/`, 2200);
    targets.push(dashboardTarget);
    const dashboardResult = await evalJs(dashboardTarget, `(() => ({
      ready: document.readyState,
      ids: Array.from(document.querySelectorAll('.slide')).map((slide) => slide.dataset.slide),
      title: document.getElementById('deckTitle').textContent,
      rev: Number(document.getElementById('revLabel').textContent.replace(/\\D/g, '')),
      pausedPointer: getComputedStyle(document.querySelector('.paused-card')).pointerEvents,
      pausedVisible: !document.getElementById('pausedOverlay').classList.contains('hidden'),
    }))()`);
    check('Dashboard renders every current slide in model order',
      JSON.stringify(dashboardResult.ids) === JSON.stringify(model.slides.map((s) => s.id)));
    check('Dashboard current title/revision match model.json',
      dashboardResult.title === model.title && dashboardResult.rev === model.rev);
    check('Dashboard paused card cannot intercept the deck',
      dashboardResult.pausedPointer === 'none' && dashboardResult.pausedVisible === snapshot.paused);

    fixture.configurePptx([
      { status: 200, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: [0x50, 0x4b, 0x03, 0x04, 0x14] },
    ], []);
    const dashboardBusy = await evalJs(dashboardTarget, `(() => {
      window.__downloadRecords = [];
      window.__downloadBlobs = new Map();
      const nativeCreate = URL.createObjectURL.bind(URL);
      const nativeRevoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = nativeCreate(blob);
        const record = { url, type: blob.type, size: blob.size, filename: '', clicked: false, revoked: false };
        window.__downloadRecords.push(record);
        window.__downloadBlobs.set(url, record);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        const record = window.__downloadBlobs.get(url);
        if (record) record.revoked = true;
        nativeRevoke(url);
      };
      HTMLAnchorElement.prototype.click = function () {
        const record = window.__downloadBlobs.get(this.href);
        if (record) { record.filename = this.download; record.clicked = true; }
      };
      const button = document.getElementById('downloadBtn');
      button.click();
      return { disabled: button.disabled, path: location.pathname };
    })()`);
    const dashboardDownloadSettled = await waitForFrontendIdle(dashboardTarget, 'pptxDownloadInFlight');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dashboardDownload = await evalJs(dashboardTarget, `(() => ({
      records: window.__downloadRecords,
      disabled: document.getElementById('downloadBtn').disabled,
      path: location.pathname,
    }))()`);
    check('Dashboard PPTX control also validates, downloads, revokes, and stays in-page',
      dashboardBusy.disabled && dashboardDownloadSettled
        && fixture.downloadRequests.length === 1
        && fixture.downloadRequests[0].path === '/api/pptx'
        && dashboardDownload.records.length === 1
        && dashboardDownload.records[0].clicked
        && dashboardDownload.records[0].revoked
        && dashboardDownload.records[0].filename === 'presentation.pptx'
        && !dashboardDownload.disabled
        && dashboardBusy.path === '/' && dashboardDownload.path === '/',
      { dashboardBusy, dashboardDownload, requests: fixture.downloadRequests });
    await dashboardTarget.closeTarget();
    targets.pop();
  } finally {
    for (const target of targets.reverse()) {
      await target.closeTarget().catch(() => {});
    }
    await closeBrowserThroughDevtools(debugPort);
    await stopCapturedProcess(child);
    await stopOwnedProfileProcesses(profile);
    await fixture.close();
    await removeOwnedProfile(profile);
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
    if (!item.ok && item.detail !== undefined) console.log(`      ${JSON.stringify(item.detail)}`);
  }
  console.log(`\n${passed}/${checks.length} passed (${path.basename(browserPath)}, captured pid ${child.pid})`);
  process.exit(passed === checks.length ? 0 : 1);
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
