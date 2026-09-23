#!/usr/bin/env node
'use strict';
/*
 * Deterministically exercises two overlapping PDF requests across an edit.
 * Disposable fake renderer/exporter processes stand in for Python/PowerPoint,
 * so this pins revision capture, exact-revision coalescing, serialization, and
 * final pdfRev without launching Office or touching the live deck.
 */
const fs = require('fs');
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
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (_) {}
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function api(base, route, options) {
  const response = await fetch(base + route, options);
  return { status: response.status, body: await response.json() };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(2500)]);
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

async function main() {
  const root = path.join(os.tmpdir(), 'suite-pdf-race-' + crypto.randomBytes(5).toString('hex'));
  const suiteDir = path.join(root, 'suite');
  const data = path.join(suiteDir, 'data');
  const logPath = path.join(data, 'fake-pdf.log');
  let child = null;
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    const sourcePptx = path.join(HERE, '..', 'presentation.pptx');
    if (fs.existsSync(sourcePptx)) fs.copyFileSync(sourcePptx, path.join(root, 'presentation.pptx'));
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
    const isolatedModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    if (isolatedModel.mode === 'overlay') isolatedModel.base = path.join(data, 'base.pptx');
    fs.writeFileSync(modelPath, JSON.stringify(isolatedModel, null, 2));

    fs.writeFileSync(path.join(suiteDir, 'fake-render.js'), `
'use strict';
const fs = require('fs');
const output = process.argv[2];
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const rev = JSON.parse(input).rev;
  fs.writeFileSync(output, Buffer.concat([Buffer.from('PK'), Buffer.from(String(rev))]));
});
`);
    fs.writeFileSync(path.join(suiteDir, 'fake-powershell.js'), `
'use strict';
const fs = require('fs');
const path = require('path');
function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const source = value('-Path');
const output = value('-OutPath');
const log = path.join(__dirname, 'data', 'fake-pdf.log');
const mode = path.join(__dirname, 'data', 'fake-pdf-mode');
if (fs.existsSync(mode) && fs.readFileSync(mode, 'utf8').trim() === 'hang') {
  fs.appendFileSync(log, 'hang ' + process.pid + '\\n');
  setInterval(() => {}, 1000);
  return;
}
fs.appendFileSync(log, 'start ' + path.basename(source) + '\\n');
setTimeout(() => {
  fs.writeFileSync(output, '%PDF-1.4\\nsource=' + path.basename(source));
  fs.appendFileSync(log, 'finish ' + path.basename(source) + '\\n');
}, 75);
`);

    // Modify only the disposable server so the test can inject deterministic
    // child processes and avoid COM/background renders.
    const serverPath = path.join(suiteDir, 'server.js');
    let source = fs.readFileSync(serverPath, 'utf8');
    source = source.replace(
      "const IS_WIN = process.platform === 'win32';",
      'const IS_WIN = true; // pdf race sandbox'
    );
    source = source.replace(
      "    if (IS_WIN) startComHost().catch((e) => console.error('COM host warm-start failed (will retry lazily on first thumbs job):', e.message));",
      '    // pdf race sandbox: never start COM'
    );
    source = source.replace(
      "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');",
      '    // pdf race sandbox: no thumbnail export'
    );
    source = source.replace(
      'function scheduleRender() {',
      'function scheduleRender() { return; // pdf race sandbox'
    );
    source = source.replace(
      "      PY, [RENDER_PY, '-', snapshotPptx],",
      "      process.execPath, [path.join(HERE, 'fake-render.js'), snapshotPptx],"
    );
    source = source.replace(
      "      'powershell',\n      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PDF_PS1,",
      "      process.execPath,\n      [path.join(HERE, 'fake-powershell.js'),"
    );
    source = source.replace(
      "      undefined, 60000\n    );\n    if (!exported.ok)",
      "      undefined, 500\n    );\n    if (!exported.ok)"
    );
    for (const required of ['fake-render.js', 'fake-powershell.js', 'pdf race sandbox']) {
      if (!source.includes(required)) throw new Error(`server injection failed: ${required}`);
    }
    fs.writeFileSync(serverPath, source);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: suiteDir,
      env: Object.assign({}, process.env, { SUITE_PORT: String(port) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
      try { return (await api(base, '/api/health')).status === 200; } catch (_) { return false; }
    }, 10000, 'server health');

    const before = (await api(base, '/api/state')).body.model;
    const firstExport = api(base, '/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const duplicateFirstExport = api(base, '/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    await waitFor(() => fs.existsSync(logPath) && /start/.test(fs.readFileSync(logPath, 'utf8')),
      5000, 'first PDF job');

    const edit = await api(base, '/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editor: 'pdf-race-test',
        op: { type: 'set-presentation-title', text: before.title + ' race test' }
      })
    });
    const secondExport = api(base, '/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const [first, duplicateFirst, second] = await Promise.all([
      firstExport, duplicateFirstExport, secondExport
    ]);
    const finalState = (await api(base, '/api/state')).body;
    const pdfText = fs.readFileSync(path.join(data, 'presentation.pdf'), 'utf8');
    const logLines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);

    check('the edit between exports committed one newer revision',
      edit.status === 200 && edit.body.rev === before.rev + 1);
    check('the first request remains labeled with its captured revision',
      first.status === 200 && first.body.rev === before.rev);
    check('requests for the same captured revision share one result',
      duplicateFirst.status === 200 && duplicateFirst.body.rev === before.rev);
    check('the newer request receives its own export result',
      second.status === 200 && second.body.rev === before.rev + 1);
    check('two different revisions do not share one in-flight promise',
      logLines.filter((line) => line.startsWith('start ')).length === 2);
    check('PowerPoint jobs remain serialized',
      logLines[0].startsWith('start ') && logLines[1].startsWith('finish ') &&
      logLines[2].startsWith('start ') && logLines[3].startsWith('finish '));
    check('the final PDF bytes come from the newest captured revision',
      pdfText.includes(`-${before.rev + 1}-`));
    check('the durable PDF revision matches the final bytes',
      finalState.pdfRev === before.rev + 1);

    const canonicalBeforeTimeout = fs.readFileSync(path.join(data, 'presentation.pdf'));
    fs.writeFileSync(path.join(data, 'fake-pdf-mode'), 'hang');
    const timedExport = await api(base, '/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const canonicalAfterTimeout = fs.readFileSync(path.join(data, 'presentation.pdf'));
    const stateAfterTimeout = (await api(base, '/api/state')).body;
    const hangLine = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
      .find((line) => line.startsWith('hang '));
    const hungPid = hangLine ? Number(hangLine.split(' ')[1]) : null;
    let hungChildAlive = false;
    if (hungPid) {
      try { process.kill(hungPid, 0); hungChildAlive = true; } catch (_) {}
    }
    check('a timed-out exporter returns failure after targeted termination',
      timedExport.status === 500 && /timed out/i.test(timedExport.body.error || '') && !hungChildAlive);
    check('a late or timed-out exporter cannot overwrite the canonical PDF',
      canonicalAfterTimeout.equals(canonicalBeforeTimeout));
    check('a failed export cannot advance durable pdfRev',
      stateAfterTimeout.pdfRev === before.rev + 1);
  } finally {
    await stop(child);
    await removeTree(root);
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
