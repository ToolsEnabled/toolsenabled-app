import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs';
import { inspectSourceSuite } from '../lib/adapters/source-suites.mjs';

// T1016: planning reads these source files without importing or running the
// image/recovery suites. Selection is a release obligation, not runtime proof.
const REQUIRED = [
  "tools/test/account-recovery-retirement.test.mjs",
  "tools/test/chat-image-delivery-status.test.mjs",
  "tools/test/image-busy-retention.test.mjs",
  "tools/test/image-conversation-status.test.mjs",
  "tools/test/image-retained-preview.test.mjs",
  "tools/test/t839-image-recovery-flight-guard.test.mjs",
  "tools/test/t839-image-recovery-handoff-refusal.test.mjs",
  "tools/test/t839-image-recovery-real-coordinator-no-image.test.mjs",
  "tools/test/t839-image-recovery-real-coordinator.test.mjs",
  "tools/test/t842-image-dispatch-guard.test.mjs",
  "tools/test/t842-native-mounted-composition.test.mjs",
  "tools/test/image-recovery-census.test.mjs"
];
const root = fileURLToPath(new URL('../../', import.meta.url));
const selection = inspectSourceSuite('app', { sourceRoots: { app: root } });

for (const file of REQUIRED) {
  test(`image/recovery census requires ${file}`, () => {
    const entries = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === file);
    assert.deepEqual(entries, [{ file, reason: null }], 'executable suites cannot be omitted or classified as helpers');
    assert.equal(selection.discovered.filter(value => value === file).length, 1, 'actual discovery must find the suite');
    assert.equal(selection.files.filter(value => value === file).length, 1, 'the real planner must select it exactly once');
    assert.equal(selection.exclusions.some(row => row.file === file), false);
    for (const id of ['missing-tests', 'unreconciled-tests']) {
      assert.equal(selection.obligations.some(row => row.id === id && row.files.includes(file)), false, id);
    }
  });
}

test('the existing strict test:data invocation includes every image/recovery census suite', () => {
  const command = 'node tools/check-node-version.mjs && node --test --import=./tools/test/lib/isolate-native-state-root.mjs --test-reporter=tap --test-concurrency=1 tools/test/*.test.mjs';
  assert.equal(selection.aliases['test:data'], command);
  assert.equal(SOURCE_MANIFESTS.app.aliases['test:data'], command);
  for (const file of REQUIRED) assert.match(file, /^tools\/test\/[^/]+\.test\.mjs$/);
  assert.equal(selection.obligations.some(row => row.alias === 'test:data'), false);
  assert.ok(selection.commands.some(row => row.id === 'app:strict-release'
    && row.context === 'app-strict-engine-scratch'));
});
