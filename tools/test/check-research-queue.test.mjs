import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const checkerPath = fileURLToPath(new URL('tools/check-research-queue.mjs', root));
const authoredPath = fileURLToPath(new URL('private/research-queue.authored.json', root));
const backupPath = `${authoredPath}.check-research-queue-test-backup`;

function runChecker() {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });
}

test('check-research-queue.mjs refuses to pass when the authored input is missing', (t) => {
  renameSync(authoredPath, backupPath);
  let restored = false;
  const restore = () => {
    if (!restored) {
      renameSync(backupPath, authoredPath);
      restored = true;
    }
  };
  t.after(restore);

  const blindRun = runChecker();
  assert.notEqual(blindRun.status, 0, blindRun.stdout);
  assert.match(
    blindRun.stderr,
    /Preserved authored research queue is missing or unreadable at .*research-queue\.authored\.json/,
  );

  restore();
  const healthyRun = runChecker();
  assert.equal(healthyRun.status, 0, healthyRun.stderr);
  assert.match(healthyRun.stdout, /Shipped research queue seed valid: validated 0 items/);
  assert.match(healthyRun.stdout, /Preserved authored research queue valid: validated \d+ items/);
});
