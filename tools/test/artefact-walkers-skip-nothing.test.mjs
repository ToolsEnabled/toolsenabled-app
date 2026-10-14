#!/usr/bin/env node
/* THE TWO ARTEFACT GATES MUST NOT SKIP `node_modules` OR `.git`, AT ANY DEPTH.
 *
 * check-payload-boundary.mjs and check-no-owner-data.mjs both walk a BUILT ARTEFACT:
 * the dist chain points them at capability/, release/, release/win-unpacked and
 * release/linux-unpacked. Both used to skip those two directory names, copied from the
 * source-tree scanners where the skip is correct and cheap.
 *
 * Over an artefact it is backwards. A `.git` directory in a shipped tree is itself a
 * defect, and a vendored `node_modules` is shipped content -- pack-capability-layer's
 * own error text for an external dependency tells the developer to vendor it into the
 * payload. So the skip made shipped files invisible to every rule in both gates, and
 * both printed an affirmative green over content they had never read:
 *
 *   payload boundary   "Files seen: 2" for a five-file payload, unclassified=0,
 *                      "Payload boundary: clean." and exit 0
 *   owner data         "Scanned 2 files (15 bytes). Total matches: 0." and exit 0,
 *                      with the <profile-root>/ and builder-checkout rules -- which its own
 *                      output calls never excused -- both reading zero
 *
 * check-artifact-private.mjs already carried twenty-two lines diagnosing exactly this,
 * found by its own nested `.git/config` fixture. It was fixed there and nowhere else.
 * The two siblings had no such fixture, which is why they kept the defect; this file is
 * that fixture, for both of them.
 *
 * Each case carries a CONTROL with identical bytes at an ordinary path, because a red
 * proves nothing unless the same content at a plain path is also red for the same rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const BOUNDARY = path.join(APP, 'tools', 'check-payload-boundary.mjs');
const OWNER = path.join(APP, 'tools', 'check-no-owner-data.mjs');

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'artefact-walker-'));
process.on('exit', () => { try { fs.rmSync(harness, { recursive: true, force: true }); } catch { /* best effort */ } });

// A harness root, because both gates resolve their manifest and profile from their own
// parent directory rather than from the tree they are pointed at.
fs.mkdirSync(path.join(harness, 'tools'), { recursive: true });
fs.mkdirSync(path.join(harness, 'config'), { recursive: true });
fs.mkdirSync(path.join(harness, 'private'), { recursive: true });
fs.copyFileSync(BOUNDARY, path.join(harness, 'tools', 'check-payload-boundary.mjs'));
fs.copyFileSync(OWNER, path.join(harness, 'tools', 'check-no-owner-data.mjs'));
fs.copyFileSync(path.join(APP, 'config', 'payload-boundary.json'), path.join(harness, 'config', 'payload-boundary.json'));
fs.writeFileSync(path.join(harness, 'private', 'owner-data-patterns.owner.json'),
  JSON.stringify({ patterns: [{ value: 'zzsynthowner', note: 'synthetic builder account for this fixture' }] }), 'utf8');

const OWNER_TEXT = '// built by Zed Synthetic  (\x43:\\Users\\zzsynthowner\\ToolsEnabled)\n';
const PAID_TEXT = '// commercial entitlement logic\n';

function payload(name, files) {
  const root = path.join(harness, name);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
}
function runBoundary(root) {
  const r = spawnSync(process.execPath, [path.join(harness, 'tools', 'check-payload-boundary.mjs'), root],
    { encoding: 'utf8', cwd: harness });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function runOwner(root) {
  const r = spawnSync(process.execPath, [path.join(harness, 'tools', 'check-no-owner-data.mjs'), root],
    { encoding: 'utf8', cwd: harness, env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: 'zzsynthowner' } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// `src/lib/entitlement.js` is `paid` in the real manifest and `src/lib/continuation-prune.js`
// is `open`, so the fixture needs no manifest of its own.
const BASE = { 'PAYLOAD.json': '{}\n', 'src/lib/continuation-prune.js': '// ordinary\n' };

// ---- payload boundary -------------------------------------------------------------
for (const [label, buried] of [
  ['directly under node_modules', 'node_modules/x/src/lib/entitlement.js'],
  ['nested deep under node_modules', 'docker/agent-sandbox/node_modules/left-pad/src/lib/entitlement.js'],
  ['under a .git directory', '.git/hooks/src/lib/entitlement.js'],
]) {
  const root = payload(`pb-${label.replace(/\W+/g, '-')}`, { ...BASE, [buried]: PAID_TEXT });
  const result = runBoundary(root);
  check(result.code !== 0, `payload boundary must refuse a paid module ${label}`);
  check(/VIOLATION/.test(result.out), `and it must say so (${label})`);
  check(new RegExp('Files seen: 3').test(result.out),
    `and it must count all three files, not two (${label})`);
}
// CONTROL: the same bytes at an ordinary path are refused for the same reason.
const pbControl = runBoundary(payload('pb-control', { ...BASE, 'src/lib/entitlement.js': PAID_TEXT }));
check(pbControl.code !== 0 && /VIOLATION/.test(pbControl.out),
  'control: a paid module at an ordinary path is refused, so the rule itself works');

// ---- owner data -------------------------------------------------------------------
for (const [label, buried] of [
  ['directly under node_modules', 'node_modules/left-pad/index.js'],
  ['nested deep under node_modules', 'docker/agent-sandbox/node_modules/left-pad/index.js'],
  ['under a .git directory', '.git/config'],
]) {
  const root = payload(`od-${label.replace(/\W+/g, '-')}`, { ...BASE, [buried]: OWNER_TEXT });
  const result = runOwner(root);
  check(result.code !== 0, `owner data must refuse a builder path ${label}`);
  check(/Total matches: [1-9]/.test(result.out), `and it must report the matches (${label})`);
  check(/Scanned 3 files/.test(result.out), `and it must count all three files, not two (${label})`);
}
const odControl = runOwner(payload('od-control', { ...BASE, 'src/lib/leak.js': OWNER_TEXT }));
check(odControl.code !== 0 && /Total matches: [1-9]/.test(odControl.out),
  'control: the same builder path at an ordinary path is refused, so the rules themselves work');

console.log(`artefact walkers skip nothing: ${checks} checks passed`);
