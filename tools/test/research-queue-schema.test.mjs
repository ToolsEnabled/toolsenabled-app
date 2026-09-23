import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateAgainstSchema } from '../gen-projection-lib.mjs';

const root = new URL('../../', import.meta.url);
// The shipped seed and the preserved authored set are now two files with two
// opposite emptiness policies (see tools/check-research-queue.mjs). The schema
// describes shape for both; emptiness is checked per file.
const seedUrl = new URL('public/data/research-queue.json', root);
const queueUrl = new URL('private/research-queue.authored.json', root);
const schema = JSON.parse(
  readFileSync(new URL('public/data/schema/research-queue.schema.json', root), 'utf8'),
);
const shippedSeed = JSON.parse(readFileSync(seedUrl, 'utf8'));
/* PER-INSTALLATION, AND ABSENT IS A STATE, NOT A CRASH. The authored queue is
   untracked on purpose -- it is this machine's working set, and the clean-tree
   gate refuses to ship bytes git cannot reproduce. A cut worktree therefore
   has no such file, and until 2026-08-25 that crashed this WHOLE test file at
   import: every assertion, including the four that need no authored queue.
   Same resolution as tests/multi-account-failover.test.js: absent -> the one
   test that needs it skips BY NAME; present -> the real invariants hold. */
const realQueue = (() => {
  try { return JSON.parse(readFileSync(queueUrl, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
})();
const checkerPath = new URL('tools/check-research-queue.mjs', root);

function validFixture() {
  return {
    schemaVersion: 1,
    items: [{
      id: 'fixture-item',
      title: 'Fixture item',
      status: 'queued',
      provenance: 'test',
      observation: 'A test observation.',
      researchQuestion: 'What does the fixture prove?',
    }],
  };
}

function validationErrors(value) {
  return validateAgainstSchema(value, schema, schema, '$');
}

test('the real authored research queue validates against its schema',
  { skip: realQueue === null ? 'private/research-queue.authored.json is per-installation and absent on this checkout -- nothing to validate, which is a state and not a pass' : false },
  () => {
    assert.equal(realQueue.items.length > 0, true);
    assert.deepEqual(validationErrors(realQueue), []);
  });

test('the shipped seed validates and carries no authored items', () => {
  assert.deepEqual(validationErrors(shippedSeed), []);
  assert.deepEqual(shippedSeed.items, [], 'public/data/research-queue.json is copied verbatim into the bundle; it must ship empty');
});

test('a malformed item status is rejected with its index', () => {
  const fixture = validFixture();
  fixture.items[0].status = 'unknown';

  assert.match(validationErrors(fixture).join('\n'), /\$\.items\[0\]\.status/);
});

test('missing required item fields are rejected', () => {
  const fixture = validFixture();
  delete fixture.items[0].researchQuestion;

  assert.match(validationErrors(fixture).join('\n'), /\$\.items\[0\]: missing required property researchQuestion/);
});

test('over-length item fields are rejected', () => {
  const fixture = validFixture();
  fixture.items[0].id = 'x'.repeat(121);

  assert.match(validationErrors(fixture).join('\n'), /\$\.items\[0\]\.id: string is too long/);
});

test('wrong schemaVersion is rejected', () => {
  const fixture = validFixture();
  fixture.schemaVersion = 2;

  assert.match(validationErrors(fixture).join('\n'), /\$\.schemaVersion: must equal the declared constant/);
});

test('an extra top-level key is rejected', () => {
  const fixture = { ...validFixture(), unexpected: true };

  assert.match(validationErrors(fixture).join('\n'), /\$: unexpected property unexpected/);
});

test('items must be an array', () => {
  const fixture = { ...validFixture(), items: {} };

  assert.match(validationErrors(fixture).join('\n'), /\$\.items: expected array/);
});

// Emptiness moved out of the schema and into the checker when the shipped seed
// and the authored set stopped agreeing about what an empty queue means: empty
// is REQUIRED of the seed and FORBIDDEN of the authored set. The schema now
// describes shape only, so it must accept both.
test('the schema itself no longer takes a position on emptiness', () => {
  const fixture = { ...validFixture(), items: [] };

  assert.deepEqual(validationErrors(fixture), []);
});

test('the checker still rejects an emptied authored queue', (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'research-queue-empty-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const emptyPath = join(temporaryDirectory, 'emptied-queue.json');
  writeFileSync(emptyPath, `${JSON.stringify({ schemaVersion: 1, items: [] })}\n`, 'utf8');

  const result = spawnSync(process.execPath, [fileURLToPath(checkerPath), emptyPath], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains zero items; refusing to pass/);
});

test('the checker rejects a bad fixture and accepts the real queue', (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'research-queue-schema-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const fixture = validFixture();
  fixture.items[0].status = 'unknown';
  const fixturePath = join(temporaryDirectory, 'bad-queue.json');
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');

  const badResult = spawnSync(process.execPath, [fileURLToPath(checkerPath), fixturePath], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });
  assert.notEqual(badResult.status, 0);
  assert.match(badResult.stderr, /index 0, id "fixture-item"/);
  assert.match(badResult.stderr, /status: value is not in the declared enum/);

  /* The bad-fixture refusal above needs no per-installation file and just ran
     everywhere. The acceptance half reads the real authored queue, which a cut
     worktree legitimately lacks -- same absent-is-a-state rule as the schema
     test at the top of this file. */
  if (realQueue !== null) {
    const realResult = spawnSync(process.execPath, [fileURLToPath(checkerPath), fileURLToPath(queueUrl)], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
    });
    assert.equal(realResult.status, 0, realResult.stderr);
    assert.match(realResult.stdout, new RegExp(`validated ${realQueue.items.length} items`));
  }
});

// The no-argument run is the one wired into `dist`. Pin that it checks BOTH
// files: a version that quietly stopped reading the preserved authored set
// would still exit 0, and the 28 items could then rot away unnoticed.
test('the default run checks the shipped seed and the preserved authored set', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(checkerPath)], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Shipped research queue seed valid: validated 0 items/);
  /* The authored half has exactly two legitimate answers and this asserts the
     one this checkout is in: validated-N where the per-installation file
     exists, the loud ABSENT statement where it never did. A third answer --
     silence -- fails either way, which is the point. */
  if (realQueue === null) {
    assert.match(result.stdout, /Preserved authored research queue: ABSENT at /);
  } else {
    assert.match(
      result.stdout,
      new RegExp(`Preserved authored research queue valid: validated ${realQueue.items.length} items`),
    );
  }
});
