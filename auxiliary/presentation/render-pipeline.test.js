#!/usr/bin/env node
'use strict';
/*
 * Office-free integration coverage for the normal PPTX render pipeline.
 *
 * The server and all deck/data files live in a disposable copy. A controllable
 * Node renderer emits either a deliberately corrupt package or a valid copy of
 * base.pptx tagged with its captured model revision. This exercises the real
 * coordinator's staging, validation, supersession, marker, and boot-recovery
 * paths without writing the live project or launching PowerPoint.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];

function check(description, condition) {
  checks.push({ description, ok: !!condition });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function revTag(rev) {
  return Buffer.from(`\nSUITE_RENDER_TEST_REV=${rev}\n`, 'utf8');
}

function hasRevTag(bytes, rev) {
  const tag = revTag(rev);
  return bytes.length >= tag.length && bytes.subarray(bytes.length - tag.length).equals(tag);
}

function makeWritable(file) {
  if (process.platform === 'win32') {
    spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  } else {
    try { fs.chmodSync(file, 0o644); } catch (_) {}
  }
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

async function waitFor(description, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (_) {}
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function api(base, route, options) {
  const response = await fetch(base + route, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
  return { status: response.status, body };
}

async function edit(base, text) {
  return api(base, '/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      editor: 'render-pipeline-test',
      op: { type: 'set-presentation-title', text }
    })
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(3000)]);
}

async function removeTree(root) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await sleep(150 * (attempt + 1));
    }
  }
}

function stageFiles(root) {
  return fs.readdirSync(root)
    .filter((name) => /^\.presentation-\d+-\d+-[0-9a-f]{8}\.pptx$/i.test(name));
}

function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function writeMode(modePath, mode, rev) {
  fs.writeFileSync(modePath, JSON.stringify({ mode, rev }));
}

function writeExactMarker(pptxPath, markerPath, rev) {
  const bytes = fs.readFileSync(pptxPath);
  const marker = {
    rev,
    size: bytes.length,
    sha256: sha256(bytes),
    renderedAt: new Date().toISOString()
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  return marker;
}

function patchDisposableServer(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const replacements = [
    [
      "const RENDER_PY = path.join(HERE, 'render_pptx.py');",
      "const RENDER_PY = path.join(HERE, 'fake-render.js'); // render-pipeline sandbox"
    ],
    [
      "const IS_WIN = process.platform === 'win32';",
      'const IS_WIN = false; // render-pipeline sandbox: no PowerPoint/COM'
    ],
    [
      'const RENDER_DEBOUNCE_MS = 600;',
      'const RENDER_DEBOUNCE_MS = 30; // render-pipeline sandbox'
    ],
    [
      'const RENDER_MAX_WAIT_MS = 2000;',
      'const RENDER_MAX_WAIT_MS = 100; // render-pipeline sandbox'
    ],
    [
      "    PY, [RENDER_PY, '-', stagedPptx],",
      "    process.execPath, [RENDER_PY, '-', stagedPptx],"
    ]
  ];
  for (const [needle, replacement] of replacements) {
    if (!source.includes(needle)) throw new Error(`server injection point changed: ${needle}`);
    source = source.replace(needle, replacement);
  }
  fs.writeFileSync(serverPath, source);
}

function writeFakeRenderer(suiteDir) {
  fs.writeFileSync(path.join(suiteDir, 'fake-render.js'), String.raw`
'use strict';
const fs = require('fs');
const path = require('path');

const data = path.join(__dirname, 'data');
const modePath = path.join(data, 'fake-render-mode.json');
const logPath = path.join(data, 'fake-render.log');
const output = process.argv[process.argv.length - 1];
let input = '';

function log(event) {
  fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
}

function finish(rev, mode) {
  let token = null;
  if (mode === 'corrupt') {
    fs.writeFileSync(output, Buffer.from('PK' + 'not-a-real-package'.repeat(4)));
  } else {
    token = Date.now() + '-' + process.pid + '-' + process.hrtime.bigint();
    fs.copyFileSync(path.join(data, 'base.pptx'), output);
    fs.appendFileSync(output, Buffer.from('\nSUITE_RENDER_TEST_RUN=' + token + '\n'));
    fs.appendFileSync(output, Buffer.from('\nSUITE_RENDER_TEST_REV=' + rev + '\n'));
  }
  log({ event: 'finish', rev, mode, token, output: path.basename(output) });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rev = JSON.parse(input).rev;
  let config = { mode: 'good', rev: null };
  try { config = JSON.parse(fs.readFileSync(modePath, 'utf8')); } catch (_) {}
  const mode = config.mode || 'good';
  log({ event: 'start', rev, mode, output: path.basename(output) });
  if (mode !== 'block' || config.rev !== rev) {
    finish(rev, mode);
    return;
  }
  const releasePath = path.join(data, 'fake-render-release-' + rev);
  const deadline = Date.now() + 10000;
  const timer = setInterval(() => {
    if (fs.existsSync(releasePath)) {
      clearInterval(timer);
      finish(rev, 'good');
    } else if (Date.now() >= deadline) {
      clearInterval(timer);
      log({ event: 'timeout', rev, mode });
      process.exitCode = 2;
    }
  }, 10);
});
`);
}

function prepareSandbox() {
  const root = path.join(os.tmpdir(), `suite-render-pipeline-${crypto.randomBytes(5).toString('hex')}`);
  const suiteDir = path.join(root, 'suite');
  const data = path.join(suiteDir, 'data');
  fs.cpSync(HERE, suiteDir, {
    recursive: true,
    // Browser profiles contain live lock files and are irrelevant to this
    // disposable coordinator test. Skipping them also keeps the sandbox small.
    filter(source) {
      const relative = path.relative(HERE, source);
      return !/^data[\\/](?:codex-viewer-profile|chrome-[^\\/]+)/i.test(relative);
    }
  });

  const sourcePptx = path.join(HERE, '..', 'presentation.pptx');
  if (!fs.existsSync(sourcePptx)) throw new Error('current presentation.pptx is missing');
  const pptxPath = path.join(root, 'presentation.pptx');
  fs.copyFileSync(sourcePptx, pptxPath);
  makeWritable(pptxPath);

  fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
  fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
  fs.rmSync(path.join(data, 'render-state.json'), { force: true });
  for (const file of ['model.json', 'state.json', 'board.json']) {
    makeWritable(path.join(data, file));
  }

  const statePath = path.join(data, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.paused = false;
  state.pausedBy = null;
  state.pausedAt = null;
  state.loopRunner = false;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const modelPath = path.join(data, 'model.json');
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  if (model.mode === 'overlay') model.base = path.join(data, 'base.pptx');
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));

  const markerPath = path.join(data, 'render-state.json');
  writeExactMarker(pptxPath, markerPath, model.rev);
  writeFakeRenderer(suiteDir);
  patchDisposableServer(suiteDir);

  return {
    root,
    suiteDir,
    data,
    modelPath,
    markerPath,
    pptxPath,
    modePath: path.join(data, 'fake-render-mode.json'),
    logPath: path.join(data, 'fake-render.log')
  };
}

async function startServer(sandbox) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: sandbox.suiteDir,
    env: Object.assign({}, process.env, { SUITE_PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 20000) stderr += chunk.toString().slice(0, 20000 - stderr.length);
  });
  await waitFor('sandbox server health', async () => {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${stderr}`);
    try { return (await api(base, '/api/health')).status === 200; } catch (_) { return false; }
  });
  return { child, base, stderr: () => stderr };
}

async function main() {
  const sandbox = prepareSandbox();
  let server = null;
  try {
    server = await startServer(sandbox);
    const initialState = (await api(server.base, '/api/state')).body;
    const initialRev = initialState.model.rev;
    const canonicalBeforeFailure = fs.readFileSync(sandbox.pptxPath);
    const markerBeforeFailure = fs.readFileSync(sandbox.markerPath);

    check('the disposable server starts with an exact current presentation marker',
      initialState.presentation && initialState.presentation.current === true &&
      initialState.presentation.rev === initialRev);

    // A renderer can exit successfully while writing junk. The coordinator
    // must reject it before either authoritative artifact changes.
    writeMode(sandbox.modePath, 'corrupt', initialRev + 1);
    const corruptEdit = await edit(server.base, `render corrupt ${Date.now()}`);
    const corruptRev = corruptEdit.body.rev;
    await waitFor('corrupt renderer completion', () =>
      readLog(sandbox.logPath).some((entry) =>
        entry.event === 'finish' && entry.rev === corruptRev && entry.mode === 'corrupt'));
    await waitFor('corrupt private stage cleanup', () => stageFiles(sandbox.root).length === 0);
    const healthAfterCorrupt = (await api(server.base, '/api/health')).body;

    check('the corrupt-render edit itself commits a newer model revision',
      corruptEdit.status === 200 && corruptRev === initialRev + 1);
    check('a corrupt renderer cannot replace the canonical PPTX',
      fs.readFileSync(sandbox.pptxPath).equals(canonicalBeforeFailure));
    check('a corrupt renderer cannot replace or advance the render marker',
      fs.readFileSync(sandbox.markerPath).equals(markerBeforeFailure));
    check('a failed render is exposed as stale instead of being reported current',
      healthAfterCorrupt.presentation && healthAfterCorrupt.presentation.current === false);
    check('the corrupt renderer leaves no private stage behind',
      stageFiles(sandbox.root).length === 0);

    // Block revision N, edit to N+1 while it is rendering, then also block
    // N+1. Observing the old canonical bytes after the second renderer starts
    // proves N was discarded rather than briefly published.
    const firstRaceRev = corruptRev + 1;
    writeMode(sandbox.modePath, 'block', firstRaceRev);
    const firstRaceEdit = await edit(server.base, `render obsolete ${Date.now()}`);
    await waitFor('obsolete renderer start', () =>
      readLog(sandbox.logPath).some((entry) =>
        entry.event === 'start' && entry.rev === firstRaceRev && entry.mode === 'block'));

    const currentRaceRev = firstRaceRev + 1;
    const currentRaceEdit = await edit(server.base, `render current ${Date.now()}`);
    writeMode(sandbox.modePath, 'block', currentRaceRev);
    fs.writeFileSync(path.join(sandbox.data, `fake-render-release-${firstRaceRev}`), 'release');
    await waitFor('current renderer start after obsolete stage is discarded', () =>
      readLog(sandbox.logPath).some((entry) =>
        entry.event === 'start' && entry.rev === currentRaceRev && entry.mode === 'block'));

    const canonicalWhileCurrentBlocked = fs.readFileSync(sandbox.pptxPath);
    const markerWhileCurrentBlocked = fs.readFileSync(sandbox.markerPath);
    check('the two racing edits commit consecutive revisions',
      firstRaceEdit.status === 200 && firstRaceEdit.body.rev === firstRaceRev &&
      currentRaceEdit.status === 200 && currentRaceEdit.body.rev === currentRaceRev);
    check('a superseded revision is never transiently published',
      canonicalWhileCurrentBlocked.equals(canonicalBeforeFailure) &&
      markerWhileCurrentBlocked.equals(markerBeforeFailure) &&
      !hasRevTag(canonicalWhileCurrentBlocked, firstRaceRev));

    fs.writeFileSync(path.join(sandbox.data, `fake-render-release-${currentRaceRev}`), 'release');
    await waitFor('current revision publication', async () => {
      const health = (await api(server.base, '/api/health')).body;
      return health.presentation && health.presentation.current === true &&
        health.presentation.rev === currentRaceRev;
    });
    await waitFor('successful private stage cleanup', () => stageFiles(sandbox.root).length === 0);

    const publishedBytes = fs.readFileSync(sandbox.pptxPath);
    const publishedMarker = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
    check('the latest captured revision is the one published',
      hasRevTag(publishedBytes, currentRaceRev) && !hasRevTag(publishedBytes, firstRaceRev));
    check('the durable marker has the current revision, size, and SHA-256',
      publishedMarker.rev === currentRaceRev &&
      publishedMarker.size === publishedBytes.length &&
      publishedMarker.sha256 === sha256(publishedBytes));
    check('successful and superseded renders leave no private stages behind',
      stageFiles(sandbox.root).length === 0);

    // Simulate a crash after model.json advances but before its debounced
    // render. Boot must detect the old marker, sweep an abandoned stage, and
    // produce an exact artifact for the persisted model revision.
    await stopServer(server.child);
    server = null;
    const diskModel = JSON.parse(fs.readFileSync(sandbox.modelPath, 'utf8'));
    diskModel.rev += 1;
    diskModel.title = `boot recovery ${Date.now()}`;
    diskModel.updatedAt = new Date().toISOString();
    fs.writeFileSync(sandbox.modelPath, JSON.stringify(diskModel, null, 2));
    writeMode(sandbox.modePath, 'good', diskModel.rev);
    const abandonedStage = path.join(
      sandbox.root,
      `.presentation-424242-${currentRaceRev}-deadbeef.pptx`
    );
    fs.writeFileSync(abandonedStage, 'abandoned private stage');

    server = await startServer(sandbox);
    await waitFor('boot recovery render', async () => {
      const health = (await api(server.base, '/api/health')).body;
      return health.presentation && health.presentation.current === true &&
        health.presentation.rev === diskModel.rev;
    });
    await waitFor('boot stale-stage sweep', () =>
      !fs.existsSync(abandonedStage) && stageFiles(sandbox.root).length === 0);

    const recoveredBytes = fs.readFileSync(sandbox.pptxPath);
    const recoveredMarker = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
    check('boot repairs a model/render revision mismatch without Office',
      hasRevTag(recoveredBytes, diskModel.rev) &&
      recoveredMarker.rev === diskModel.rev &&
      recoveredMarker.size === recoveredBytes.length &&
      recoveredMarker.sha256 === sha256(recoveredBytes));
    check('boot sweeps abandoned private stages before recovery completes',
      !fs.existsSync(abandonedStage) && stageFiles(sandbox.root).length === 0);

    // ---- non-mutating forced re-render (/api/render + `ppt render`) ----------
    // The CLI's `render` used to force a re-render by writing the presentation
    // title back to its own current value through /api/edit. That byte-identical
    // "edit" bumped model.rev and pushed a phantom "title → …" onto the undo
    // stack, polluting history on every render. /api/render must refresh the
    // same artifacts while changing NO model state, and must still refuse (423)
    // while paused instead of hollowly reporting success.
    const preRenderState = (await api(server.base, '/api/state')).body;
    const knownTitle = `forced-render probe ${Date.now()}`;
    const realEdit = await edit(server.base, knownTitle);
    const revWithKnownTitle = realEdit.body.rev;
    await waitFor('publication of the real edit before seeding redo', async () => {
      const health = (await api(server.base, '/api/health')).body;
      return health.presentation && health.presentation.current === true &&
        health.presentation.rev === revWithKnownTitle;
    });

    // Keep a real edit on a nonempty redo stack. A render must preserve that
    // exact entry rather than merely leaving two zero-valued counters alone.
    const undoForRedoSeed = await api(server.base, '/api/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editor: 'render-pipeline-test' })
    });
    const revWithRedoSeed = undoForRedoSeed.body.rev;
    await waitFor('publication of the redo-seeding undo', async () => {
      const health = (await api(server.base, '/api/health')).body;
      return health.presentation && health.presentation.current === true &&
        health.presentation.rev === revWithRedoSeed;
    });

    const thumbsPath = path.join(sandbox.data, 'thumbs-src.pptx');
    await waitFor('thumbnail source refresh for the redo-seeding undo', () =>
      fs.existsSync(thumbsPath) && hasRevTag(fs.readFileSync(thumbsPath), revWithRedoSeed));
    const stateBeforeForced = (await api(server.base, '/api/state')).body;
    const historyBeforeForced = (await api(server.base, '/api/history')).body;
    const modelBytesBeforeForced = fs.readFileSync(sandbox.modelPath);
    const pptxBeforeForced = fs.readFileSync(sandbox.pptxPath);
    const thumbsBeforeForced = fs.readFileSync(thumbsPath);
    const markerBeforeForced = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
    const startsBeforeForced = readLog(sandbox.logPath).filter((e) => e.event === 'start').length;
    const finishesBeforeForced = readLog(sandbox.logPath).filter((e) => e.event === 'finish').length;

    const forced = await api(server.base, '/api/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    await waitFor('forced render artifact publication', () => {
      const marker = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
      const pptx = fs.readFileSync(sandbox.pptxPath);
      return marker.rev === revWithRedoSeed &&
        marker.renderedAt !== markerBeforeForced.renderedAt &&
        marker.size === pptx.length && marker.sha256 === sha256(pptx) &&
        !pptx.equals(pptxBeforeForced);
    });
    await waitFor('forced render thumbnail source refresh', () =>
      fs.readFileSync(thumbsPath).equals(fs.readFileSync(sandbox.pptxPath)));
    const stateAfterForced = (await api(server.base, '/api/state')).body;
    const historyAfterForced = (await api(server.base, '/api/history')).body;
    const modelBytesAfterForced = fs.readFileSync(sandbox.modelPath);
    const pptxAfterForced = fs.readFileSync(sandbox.pptxPath);
    const thumbsAfterForced = fs.readFileSync(thumbsPath);
    const markerAfterForced = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
    const startsAfterForced = readLog(sandbox.logPath).filter((e) => e.event === 'start').length;
    const finishesAfterForced = readLog(sandbox.logPath).filter((e) => e.event === 'finish').length;

    check('POST /api/render is accepted while live',
      forced.status === 200 && forced.body && forced.body.ok === true);
    check('a forced render reports the current, unchanged revision',
      forced.body && forced.body.rev === revWithRedoSeed);
    check('a forced render runs and atomically refreshes the PPTX and marker',
      startsAfterForced > startsBeforeForced && finishesAfterForced > finishesBeforeForced &&
      !pptxAfterForced.equals(pptxBeforeForced) &&
      markerAfterForced.renderedAt !== markerBeforeForced.renderedAt &&
      markerAfterForced.rev === revWithRedoSeed &&
      markerAfterForced.size === pptxAfterForced.length &&
      markerAfterForced.sha256 === sha256(pptxAfterForced));
    check('a forced render refreshes the thumbnail source from the new PPTX',
      !thumbsAfterForced.equals(thumbsBeforeForced) && thumbsAfterForced.equals(pptxAfterForced));
    check('a forced render does not bump model.rev',
      stateAfterForced.model.rev === stateBeforeForced.model.rev &&
      stateAfterForced.model.rev === revWithRedoSeed);
    check('a forced render does not rewrite the presentation title',
      stateAfterForced.model.title === preRenderState.model.title &&
      stateBeforeForced.model.title === preRenderState.model.title);
    check('a forced render leaves model.json byte-identical',
      modelBytesAfterForced.equals(modelBytesBeforeForced));
    check('a forced render preserves the exact nonempty undo and redo history',
      stateBeforeForced.redoCount > 0 &&
      stateAfterForced.undoCount === stateBeforeForced.undoCount &&
      stateAfterForced.redoCount === stateBeforeForced.redoCount &&
      JSON.stringify(historyAfterForced) === JSON.stringify(historyBeforeForced));

    // Decisive regression check: redo after a forced render still reapplies the
    // real edit that was present before the render.
    const redoAfterForced = await api(server.base, '/api/redo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editor: 'render-pipeline-test' })
    });
    const stateAfterRedo = (await api(server.base, '/api/state')).body;
    check('redo after a forced render reapplies the real edit, not a render artifact',
      redoAfterForced.status === 200 && stateAfterRedo.model.title === knownTitle);
    await waitFor('publication of the redo after the forced render', async () => {
      const health = (await api(server.base, '/api/health')).body;
      return health.presentation && health.presentation.current === true &&
        health.presentation.rev === stateAfterRedo.model.rev;
    });

    // Pause is a hard stop: /api/render must refuse and run nothing.
    const paused = await api(server.base, '/api/pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'render-pipeline-test' })
    });
    const startsBeforePausedForced = readLog(sandbox.logPath).filter((e) => e.event === 'start').length;
    const finishesBeforePausedForced = readLog(sandbox.logPath).filter((e) => e.event === 'finish').length;
    const stateBeforePausedForced = (await api(server.base, '/api/state')).body;
    const historyBeforePausedForced = (await api(server.base, '/api/history')).body;
    const modelBeforePausedForced = fs.readFileSync(sandbox.modelPath);
    const pptxBeforePausedForced = fs.readFileSync(sandbox.pptxPath);
    const thumbsBeforePausedForced = fs.readFileSync(thumbsPath);
    const markerBeforePausedForced = fs.readFileSync(sandbox.markerPath);
    const pausedForced = await api(server.base, '/api/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    await sleep(200);
    const startsAfterPausedForced = readLog(sandbox.logPath).filter((e) => e.event === 'start').length;
    const finishesAfterPausedForced = readLog(sandbox.logPath).filter((e) => e.event === 'finish').length;
    const stateAfterPausedForced = (await api(server.base, '/api/state')).body;
    const historyAfterPausedForced = (await api(server.base, '/api/history')).body;
    check('a forced render is refused with 423 while paused',
      paused.status === 200 && pausedForced.status === 423 &&
      pausedForced.body && pausedForced.body.error === 'paused');
    check('a paused forced render runs no pipeline and changes no artifact',
      startsAfterPausedForced === startsBeforePausedForced &&
      finishesAfterPausedForced === finishesBeforePausedForced &&
      fs.readFileSync(sandbox.pptxPath).equals(pptxBeforePausedForced) &&
      fs.readFileSync(thumbsPath).equals(thumbsBeforePausedForced) &&
      fs.readFileSync(sandbox.markerPath).equals(markerBeforePausedForced));
    check('a paused forced render changes no model or history state',
      fs.readFileSync(sandbox.modelPath).equals(modelBeforePausedForced) &&
      stateAfterPausedForced.model.rev === stateBeforePausedForced.model.rev &&
      stateAfterPausedForced.model.title === stateBeforePausedForced.model.title &&
      stateAfterPausedForced.undoCount === stateBeforePausedForced.undoCount &&
      stateAfterPausedForced.redoCount === stateBeforePausedForced.redoCount &&
      JSON.stringify(historyAfterPausedForced) === JSON.stringify(historyBeforePausedForced));
    await api(server.base, '/api/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'render-pipeline-test' })
    });

    // End-to-end: the shipped `ppt render` CLI now uses /api/render (clean path,
    // no legacy notice) and leaves model state and history untouched.
    const cliStateBefore = (await api(server.base, '/api/state')).body;
    const cliHistoryBefore = (await api(server.base, '/api/history')).body;
    const cliModelBefore = fs.readFileSync(sandbox.modelPath);
    const cliMarkerBefore = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
    const cli = spawnSync(process.execPath, ['ppt.js', 'render'], {
      cwd: sandbox.suiteDir,
      env: Object.assign({}, process.env, {
        SUITE_PORT: String(new URL(server.base).port),
        SUITE_EDITOR: 'render-cli-test'
      }),
      encoding: 'utf8'
    });
    await waitFor('CLI forced render artifact publication', () => {
      const marker = JSON.parse(fs.readFileSync(sandbox.markerPath, 'utf8'));
      return marker.renderedAt !== cliMarkerBefore.renderedAt;
    });
    const cliStateAfter = (await api(server.base, '/api/state')).body;
    const cliHistoryAfter = (await api(server.base, '/api/history')).body;
    check('`ppt render` exits 0 via the clean /api/render path',
      cli.status === 0 && /re-render triggered/.test(cli.stdout || '') && !/legacy/.test(cli.stdout || ''));
    check('`ppt render` changes no model or history state',
      fs.readFileSync(sandbox.modelPath).equals(cliModelBefore) &&
      cliStateAfter.model.rev === cliStateBefore.model.rev &&
      cliStateAfter.model.title === cliStateBefore.model.title &&
      cliStateAfter.undoCount === cliStateBefore.undoCount &&
      cliStateAfter.redoCount === cliStateBefore.redoCount &&
      JSON.stringify(cliHistoryAfter) === JSON.stringify(cliHistoryBefore));
  } finally {
    if (server) await stopServer(server.child);
    await removeTree(sandbox.root);
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exit(1);
});
