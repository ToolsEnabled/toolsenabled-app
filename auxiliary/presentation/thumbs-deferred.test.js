#!/usr/bin/env node
'use strict';
/*
 * A second render can defer while the first thumbnail job owns the same slide
 * id. When the first job clears that id, the deferred job has no explicit
 * targets; the exporter interprets that as full-deck, and its SSE event must
 * say slides:null so Studio refreshes every image URL.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`thumbnail runner markers missing: ${start}`);
  return source.slice(a, b);
}

const runSource = take('function runThumbs(capturedRev) {', '\n\n// ---- on-demand PDF export');
const calls = [];
const events = [];
const silentConsole = { error: () => {} };
function comHostJob(_src, _dir, _width, slides) {
  return new Promise((resolve, reject) => calls.push({ slides, resolve, reject }));
}
const runner = new Function('comHostJob', 'legacyExportThumbs', 'cleanupOrphanedThumbs', 'broadcast', 'console', `
  const IS_WIN = true;
  let thumbsRunning = false, pdfRunning = false, thumbsAgain = false, thumbsAgainRev = null, thumbsVer = 0;
  let dirtyAll = false, dirtySlides = new Set(['s1']);
  const THUMBS_SRC = 'snapshot.pptx', THUMBS_DIR = 'thumbs';
  function slideIdToNumber(id) { return id === 's1' ? 1 : null; }
  ${runSource}
  return {
    runThumbs,
    repeatDirtyId: () => dirtySlides.add('s1'),
    state: () => ({ thumbsRunning, thumbsAgain, dirtyAll, dirtyIds: Array.from(dirtySlides), thumbsVer })
  };
`)(comHostJob, () => Promise.resolve(), () => {}, (event) => events.push(event), silentConsole);

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }
async function flush() { await Promise.resolve(); await Promise.resolve(); }

async function main() {
  runner.runThumbs(245);
  check('first thumbnail pass targets the dirty slide', calls.length === 1 && JSON.stringify(calls[0].slides) === '[1]');

  // Render 246 changes the same slide while the first export is still running.
  runner.repeatDirtyId();
  runner.runThumbs(246);
  check('newer pass is deferred while the first is active', calls.length === 1 && runner.state().thumbsAgain);

  calls[0].resolve();
  await flush();
  check('deferred pass starts after the first completes', calls.length === 2);
  check('deferred pass uses exporter full-deck convention', calls[1] && JSON.stringify(calls[1].slides) === '[]');

  calls[1].resolve();
  await flush();
  const finalEvent = events[events.length - 1];
  check('final thumbnail event identifies the latest revision', finalEvent && finalEvent.rev === 246 && finalEvent.ver === 2);
  check('final thumbnail event tells Studio to refresh every card', finalEvent && finalEvent.slides === null);

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
