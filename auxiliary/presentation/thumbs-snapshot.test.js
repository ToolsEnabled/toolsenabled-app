#!/usr/bin/env node
'use strict';
/*
 * A paused presentation is read-only on Windows. copyFileSync preserves that
 * bit on the derived thumbnail source too, so the next refresh used to fail
 * before it reached PowerPoint. Exercise the actual extracted helper against
 * a throwaway read-only snapshot; it must clear only the snapshot and queue a
 * thumbnail pass for the supplied revision.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`thumbnail helper markers missing: ${start}`);
  return source.slice(a, b);
}

const setReadOnlySource = take('function setReadOnly(file, on) {', '\n\n// THUMBS_SRC is a disposable copy');
const refreshSource = take('async function refreshThumbsFromDeck(capturedRev, failurePrefix) {', '\n\n// -------------------------------------------------------------------- state');
const setReadOnly = new Function('fs', 'IS_WIN', 'execFile', `${setReadOnlySource}\nreturn setReadOnly;`)(
  fs, process.platform === 'win32', execFile
);

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-suite-thumbs-'));
  const deck = path.join(dir, 'presentation.pptx');
  const snapshot = path.join(dir, 'thumbs-src.pptx');
  fs.writeFileSync(deck, 'new thumbnail source');
  fs.writeFileSync(snapshot, 'old thumbnail source');
  const queued = [];
  const errors = [];
  const refresh = new Function('fs', 'PPTX_PATH', 'THUMBS_SRC', 'setReadOnly', 'runThumbs', 'console',
    `${refreshSource}\nreturn refreshThumbsFromDeck;`
  )(fs, deck, snapshot, setReadOnly, (rev) => queued.push(rev), { error: (...parts) => errors.push(parts.join(' ')) });

  try {
    await setReadOnly(snapshot, true);
    const ok = await refresh(42, 'thumbnail snapshot test failed:');
    check('refresh succeeds from a read-only thumbnail snapshot', ok);
    check('refresh replaces the stale snapshot bytes', fs.readFileSync(snapshot, 'utf8') === 'new thumbnail source');
    check('refresh queues exactly the captured revision', queued.length === 1 && queued[0] === 42);
    check('refresh logs no snapshot copy failure', errors.length === 0);
  } finally {
    await setReadOnly(snapshot, false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
