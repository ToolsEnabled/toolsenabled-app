import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { symlinkCapability } from "./symlink-capability.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = path.join(REPO_ROOT, "tools/check-suites-discovered.mjs");
const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "check-suites-discovered-"));
  fixtures.push(root);
  await mkdir(path.join(root, "tools/test"), { recursive: true });
  await cp(GATE, path.join(root, "tools/check-suites-discovered.mjs"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "test:data": "node --test tools/test/*.test.mjs" } }),
  );
  await writeFile(path.join(root, "tools/test/healthy.test.mjs"), "// fixture suite\n");
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ["tools/check-suites-discovered.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("requires symlink creation: tools/check-suites-discovered.mjs refuses an undeclared symlinked suite", async (t) => {
  const capability = symlinkCapability();
  if (!capability.available) {
    return t.skip(`${capability.reason}; the symlinked-suite discovery assertion was therefore NOT checked`);
  }
  const root = await fixture();
  await mkdir(path.join(root, "unreached"));
  await symlink(
    path.join("..", "tools", "test", "healthy.test.mjs"),
    path.join(root, "unreached", "linked.test.mjs"),
    "file",
  );

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /1 suite\(s\) exist but are NEVER RUN/);
  assert.match(result.stderr, /unreached\/linked\.test\.mjs/);
});

test("healthy suite discovery still passes", async () => {
  const result = run(await fixture());

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Suite discovery: 1 suite\(s\) reached by .*; 1 \*\.test\.mjs file\(s\) exist in the tree\./,
  );
  assert.match(result.stdout, /Every suite in the tree is reached by the runner\./);
});

test("an empty runner directory refuses instead of passing blind", async () => {
  const root = await fixture();
  await rm(path.join(root, "tools/test/healthy.test.mjs"));

  const result = run(root);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /match ZERO suites/);
});

test("a missing runner directory refuses instead of passing blind", async () => {
  const root = await fixture();
  await rm(path.join(root, "tools/test"), { recursive: true });

  const result = run(root);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /which cannot be read/);
});

test("independent nested checkouts do not become suites of their parent", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "another-checkout/tools/test"), { recursive: true });
  await writeFile(path.join(root, "another-checkout/.git"), "gitdir: unavailable-fixture-metadata\n");
  await writeFile(path.join(root, "another-checkout/tools/test/owned.test.mjs"), "// separate checkout\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /; 1 \*\.test\.mjs file/);
});

test("a worktree-looking directory without Git metadata still exposes an unwired suite", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "wt-ordinary"));
  await writeFile(path.join(root, "wt-ordinary/unwired.test.mjs"), "// ordinary source\n");
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /wt-ordinary\/unwired\.test\.mjs/);
});

test("a glob cannot select a test directory outside its own repository", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "package.json"),
    JSON.stringify({ scripts: { "test:data": "node --test ../outside/*.test.mjs" } }));
  const result = run(root);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /outside this repository/);
});

// M4 (ledger row, suite-count discrepancy): the real repo carries sibling
// sub-packages (auxiliary/presentation, auxiliary/scribe) that each own a
// complete test lifecycle through their own package.json, using file-naming
// conventions (.test.js, test_*.py) this guard's SUITE_SUFFIX never matches.
// Neither is Git-nested and neither is in SKIP_DIRECTORIES, so findEverySuite
// still walks into them -- confirmed by census in
// evidence/controller5-m4-20260908/census.md. This pins that a stray
// .test.mjs dropped into exactly that shape is still caught, so that shape
// can never become a silent blind spot.
test("a foreign sub-package directory with its own package.json does not shield a stray .test.mjs from discovery", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "auxiliary/presentation"), { recursive: true });
  await writeFile(path.join(root, "auxiliary/presentation/package.json"),
    JSON.stringify({ name: "presentation-suite", scripts: { test: "node agents.test.js" } }));
  await writeFile(path.join(root, "auxiliary/presentation/agents.test.js"), "// foreign convention, not .mjs\n");
  await writeFile(path.join(root, "auxiliary/presentation/stray.test.mjs"), "// dropped by mistake\n");

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /auxiliary\/presentation\/stray\.test\.mjs/);
});
