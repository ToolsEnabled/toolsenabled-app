import assert from "node:assert/strict";
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSuiteResult } from "../test-ratchet.mjs";
import { REQUIRED_APP_CONTROLS } from "../lib/test-suite-result.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RATCHET = path.join(REPO_ROOT, "tools", "test-ratchet.mjs");

test("ratchet CLI path spelling cannot bypass argument refusal", async () => {
  const scripts = [RATCHET, `${path.dirname(RATCHET).replaceAll(path.sep, "/")}/./${path.basename(RATCHET)}`];
  if (process.platform === "win32") scripts.push(RATCHET.toUpperCase().replace(/\.MJS$/, ".mjs"));
  const tempRoot = ownedFixtureTempRoot();
  let cursor = path.parse(tempRoot).root;
  for (const component of path.relative(cursor, tempRoot).split(path.sep)) {
    cursor = path.join(cursor, component);
    const entry = await lstat(cursor);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "fixture temp ancestors must be plain directories");
  }
  const scratch = await mkdtemp(path.join(tempRoot, "ratchet-cli-path-"));
  const alias = path.join(scratch, "linked-tools");
  let linked = false;
  try {
    await symlink(path.dirname(RATCHET), alias, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    scripts.push(path.join(alias, path.basename(RATCHET)));
    for (const script of scripts) {
      const result = spawnSync(process.execPath, [script, "--not-a-ratchet-option"], {
        cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024,
      });
      assert.equal(result.status, 2, result.error?.message || result.stdout + result.stderr);
      assert.match(result.stderr, /unknown argument: --not-a-ratchet-option/);
      assert.doesNotMatch(result.stdout, /Test ratchet: running|Ran \d+ tests/,
        "invalid arguments must refuse before any test suite can start");
    }
  } finally {
    assert.equal(path.dirname(scratch), tempRoot);
    assert.ok((await lstat(scratch)).isDirectory() && !(await lstat(scratch)).isSymbolicLink());
    if (linked) {
      assert.ok((await lstat(alias)).isSymbolicLink(), "remove only the fixture-owned alias itself");
      await unlink(alias);
    }
    await rmdir(scratch);
  }
});

async function makeFixture({ knownFailures = [], failures = [], source, posttest, command }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-ratchet-"));
  const tools = path.join(root, "tools");
  await mkdir(path.join(tools, "test"), { recursive: true });
  await mkdir(path.join(tools, "lib"));
  await copyFile(RATCHET, path.join(tools, "test-ratchet.mjs"));
  await copyFile(path.join(REPO_ROOT, "tools", "lib", "test-suite-result.mjs"),
    path.join(tools, "lib", "test-suite-result.mjs"));
  // The ratchet refuses to measure under any node but the one package.json
  // pins (T309), so the fixture carries that module and pins the node running
  // this very test; the pin itself is exercised by hand, not by this fixture.
  await copyFile(path.join(REPO_ROOT, "tools", "check-node-version.mjs"),
    path.join(tools, "check-node-version.mjs"));
  await writeFile(
    path.join(tools, "test-baseline.json"),
    `${JSON.stringify({
      knownFailures: knownFailures.map((name) => ({ name, note: "fixture" })),
    })}\n`,
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      private: true,
      engines: { node: process.versions.node },
      scripts: {
        test: command || "node --test --test-reporter=tap tools/test/fixture-suite.mjs",
        ...(posttest ? { posttest: "node tools/posttest.mjs" } : {}),
      },
    })}\n`,
  );
  await writeFile(
    path.join(tools, "test", "fixture-suite.mjs"),
    source ?? [
      "import test from 'node:test';",
      "test('passing assertion', () => {});",
      ...REQUIRED_APP_CONTROLS.map(({ testName }) => `test(${JSON.stringify(testName)}, () => {});`),
      ...failures.map(
        (name) => `test(${JSON.stringify(name)}, () => { throw new Error('fixture failure'); });`,
      ),
      "",
    ].join("\n"),
  );
  if (posttest) await writeFile(path.join(tools, "posttest.mjs"), posttest);
  return root;
}

function runRatchet(root, args = [], overrides = {}) {
  return new Promise((resolve, reject) => {
    // Keep each fixture's retained runner diagnostics in its own cleanup scope.
    const environment = { ...process.env, TMPDIR: root, TEMP: root, TMP: root,
      TOOLSENABLED_TEST_EVIDENCE_ROOT: path.join(root, 'evidence'),
      TOOLSENABLED_STATE_ROOT: path.join(root, "state"), MC_TEST_STATE_ROOT: path.join(root, "state"),
      // An agent shell on a machine that runs this product carries the LIVE
      // vault path; the fixture names its own, inside its own state root.
      TOOLSENABLED_VAULT_PATH: path.join(root, "state", "vault", "secrets.json"), ...overrides };
    delete environment.NODE_TEST_CONTEXT;
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete environment[key];
    const child = spawn(process.execPath, ["tools/test-ratchet.mjs", ...args], {
      cwd: root,
      env: environment,
      windowsHide: true,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

async function withFixture(options, assertion) {
  const root = await makeFixture(options);
  try {
    await assertion(root);
  } finally {
    // Windows can keep the fixture cwd open briefly while npm's intermediate
    // processes react to the interrupted child. The same removal must finish;
    // bounded retries handle those transient EBUSY/EPERM handles.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("tools/test-ratchet.mjs refuses a newly regressing failure by name", async () => {
  await withFixture(
    { knownFailures: ["known failure"], failures: ["known failure", "new failure"] },
    async (root) => {
      const result = await runRatchet(root);

      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /REGRESSION -- 1 failure\(s\) NOT in the baseline/);
      assert.match(result.stdout, /new failure/);
      assert.match(result.stdout, /These are new, and they block the ship path/);
    },
  );
});

test("a refused measurement retains complete private stdout and stderr before parsing", async () => {
  const stdout = Buffer.from("FIRST DIAGNOSTIC café雪\n" + "x".repeat(6000)
    + "\nTAP version 13\nok 2 - wrong first ordinal\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n");
  const stderr = Buffer.concat([Buffer.from("FIRST STDERR café雪\n"), Buffer.from([0, 255, 254])]);
  await withFixture({
    command: "node tools/test/fixture-suite.mjs",
    source: `process.stdout.write(Buffer.from(${JSON.stringify(stdout.toString("hex"))}, 'hex'));\n`
      + `process.stderr.write(Buffer.from(${JSON.stringify(stderr.toString("hex"))}, 'hex'));\n`,
  }, async (root) => {
    const scratch = path.join(root, 'cut-scratch');
    await mkdir(scratch);
    const result = await runRatchet(root, [], { TMPDIR: scratch, TEMP: scratch, TMP: scratch });
    await rm(scratch, { recursive: true });
    assert.equal(result.code, 2, "malformed TAP must still refuse measurement");
    assert.match(result.stderr, /TAP result ordinal/);
    const saved = /^Raw suite output retained at (.+)$/m.exec(result.stdout);
    assert.ok(saved, "a refused measurement must retain the complete runner output");
    const directory = saved[1];
    assert.equal(path.dirname(directory), path.join(root, 'evidence'), 'diagnostics must survive cut scratch cleanup');
    try {
      const savedStdout = await readFile(path.join(directory, "stdout.log"));
      // npm test contributes its own lifecycle banner before the fixture bytes.
      assert.deepEqual(savedStdout.subarray(-stdout.length), stdout);
      assert.match(savedStdout.subarray(0, -stdout.length).toString("utf8"),
        /^\s*> test\r?\n> node tools\/test\/fixture-suite\.mjs\r?\n\s*$/);
      assert.deepEqual(await readFile(path.join(directory, "stderr.log")), stderr);
      const record = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
      assert.equal(record.cwd, root);
      assert.equal(record.stdout.bytes, savedStdout.length);
      assert.equal(record.stderr.bytes, stderr.length);
      assert.equal(record.stdout.sha256, createHash("sha256").update(savedStdout).digest("hex"));
      assert.equal(record.stderr.sha256, createHash("sha256").update(stderr).digest("hex"));
      if (process.platform !== "win32") {
        assert.equal((await lstat(directory)).mode & 0o077, 0);
        for (const file of ["stdout.log", "stderr.log", "run.json"]) {
          assert.equal((await lstat(path.join(directory, file))).mode & 0o077, 0);
        }
      }
    } finally {
      assert.ok(path.basename(directory).startsWith("toolsenabled-test-output-"));
      await rm(directory, { recursive: true });
    }
  });
});

test('an interrupted ratchet retains already observed diagnostics without claiming completion', async () => {
  await withFixture({ command: 'node tools/test/fixture-suite.mjs',
    source: `import {writeFileSync} from 'node:fs';\nwriteFileSync('fixture-child.pid', String(process.pid));\n`
      + `process.stdout.write('FIRST LIVE DIAGNOSTIC\\n'); process.stderr.write('FIRST LIVE STDERR\\n');\n`
      + `setTimeout(() => {}, 10000);\n`,
  }, async root => {
    const evidence = path.join(root, 'evidence');
    const environment = { ...process.env, TOOLSENABLED_TEST_EVIDENCE_ROOT: evidence };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['tools/test-ratchet.mjs'], { cwd: root, env: environment, windowsHide: true, stdio: 'ignore' });
    const closed = new Promise(resolve => child.once('close', resolve));
    let directory;
    try {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const names = await readdir(evidence).catch(() => []);
        if (names.length) {
          directory = path.join(evidence, names[0]);
          const stdout = await readFile(path.join(directory, 'stdout.log'), 'utf8').catch(() => '');
          const stderr = await readFile(path.join(directory, 'stderr.log'), 'utf8').catch(() => '');
          if (stdout.includes('FIRST LIVE DIAGNOSTIC') && stderr.includes('FIRST LIVE STDERR')) break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(directory, 'diagnostics must be created before the suite exits');
      assert.match(await readFile(path.join(directory, 'stdout.log'), 'utf8'), /FIRST LIVE DIAGNOSTIC/);
      assert.match(await readFile(path.join(directory, 'stderr.log'), 'utf8'), /FIRST LIVE STDERR/);
      child.kill(); await closed;
      const record = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
      assert.equal(record.phase, 'running', 'an interrupted run cannot acquire completed counts or a green verdict');
      assert.equal(Object.hasOwn(record, 'exitCode'), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      const fixturePid = Number(await readFile(path.join(root, 'fixture-child.pid'), 'utf8').catch(() => ''));
      if (Number.isSafeInteger(fixturePid) && fixturePid > 0) {
        try { process.kill(fixturePid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        const deadline = Date.now() + 3000;
        while (true) {
          try { process.kill(fixturePid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
          assert.ok(Date.now() < deadline, 'The interrupted fixture child must exit before its directory is removed');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    }
  });
});

test("tools/test-ratchet.mjs refuses when a baselined count improves without review", async () => {
  await withFixture(
    { knownFailures: ["still failing", "now fixed"], failures: ["still failing"] },
    async (root) => {
      const result = await runRatchet(root);

      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /FIXED -- 1 baselined failure\(s\) now pass/);
      assert.match(result.stdout, /now fixed/);
      assert.match(result.stdout, /baseline must come down or the ratchet stops ratcheting/);
    },
  );
});

test("tools/test-ratchet.mjs accepts an unchanged healthy reading", async () => {
  await withFixture(
    { knownFailures: ["known failure"], failures: ["known failure"] },
    async (root) => {
      const result = await runRatchet(root);

      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Ratchet OK: all 1 failure\(s\) are known/);
      assert.match(result.stdout, /none were fixed without the baseline coming down/);
    },
  );
});

test("tools/test-ratchet.mjs accepts a reviewed improvement through its update entry point", async () => {
  await withFixture(
    { knownFailures: ["still failing", "now fixed"], failures: ["still failing"] },
    async (root) => {
      const result = await runRatchet(root, ["--update"]);
      const baseline = JSON.parse(
        await readFile(path.join(root, "tools", "test-baseline.json"), "utf8"),
      );

      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Baseline UPDATED: 1 known failure\(s\) written/);
      assert.deepEqual(
        baseline.knownFailures.map(({ name }) => name),
        ["still failing"],
      );
    },
  );
});

for (const failures of [["known failure", "new failure"], ["replacement failure"]]) {
  test(`ratchet update cannot absorb regressions: ${failures.join(', ')}`, async () => {
    await withFixture({ knownFailures: ["known failure"], failures }, async (root) => {
      const file = path.join(root, "tools", "test-baseline.json");
      const before = await readFile(file);
      const result = await runRatchet(root, ["--update"]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /REGRESSION/);
      assert.deepEqual(await readFile(file), before, "even a count-neutral replacement must leave the reviewed baseline intact");
    });
  });
}

test("strict verification refuses known failures and accepts a clean suite", async () => {
  await withFixture({ knownFailures: ["known failure"], failures: ["known failure"] }, async (root) => {
    const result = await runRatchet(root, ["--strict"]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /STRICT VERIFICATION FAILED/);
  });
  await withFixture({}, async (root) => {
    const result = await runRatchet(root, ["--strict"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Strict verification OK/);
    const refused = await runRatchet(root, ["--strict", "--update"]);
    assert.equal(refused.code, 2, refused.stderr);
  });
});

test("a failing npm posttest cannot turn green behind a passing TAP summary", async () => {
  await withFixture({ posttest: "process.exitCode = 7;\n" }, async (root) => {
    const result = await runRatchet(root);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /process exit 7 .*disagrees with TAP # fail 0/);
  });
});

test("describe containers and nested test parents reconcile using their real TAP counts", async () => {
  await withFixture({
    knownFailures: ["group", "parent"],
    source: "import { describe, it, test } from 'node:test';\n"
      + "describe('group', () => { it('failure', () => { throw new Error('fixture'); }); });\n"
      + "test('parent', async t => { await t.test('nested failure', () => { throw new Error('fixture'); }); });\n",
  }, async (root) => {
    const result = await runRatchet(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ran 3 tests: 0 pass, 3 fail, 0 skipped/);
    assert.match(result.stdout, /2 failing top-level test/);
  });
});

for (const [label, source, reason] of [
  ["cancelled", "test('unfinished', () => new Promise(() => {}));", /cancelled/],
  ["TODO", "test.todo('unfinished');", /TODO/],
  ["all skipped", "test.skip('unavailable');", /ZERO completed tests/],
]) {
  test(`${label} coverage cannot pass or be recorded as an accepted baseline`, async () => {
    await withFixture({ source: `import test from 'node:test';\n${source}\n` }, async (root) => {
      const before = await readFile(path.join(root, "tools", "test-baseline.json"), "utf8");
      const result = await runRatchet(root, ["--update"]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, reason);
      assert.equal(await readFile(path.join(root, "tools", "test-baseline.json"), "utf8"), before);
    });
  });
}

test("partial or duplicate TAP summaries cannot pass verification", async () => {
  const complete = [
    "TAP version 13", "ok 1 - fixture", "1..1", "# tests 1", "# suites 0", "# pass 1",
    "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0",
  ];
  for (const lines of [complete.filter((line) => line !== "# fail 0"), [...complete, "# tests 1"]]) {
    await withFixture({
      command: "node tools/test/fixture-suite.mjs",
      source: `process.stdout.write(${JSON.stringify(`${lines.join("\n")}\n`)});\n`,
    }, async (root) => {
      const result = await runRatchet(root);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /incomplete TAP summary|duplicate TAP/);
    });
  }
});

test("optional skips are reported separately from executed passing assertions", async () => {
  await withFixture({
    source: "import test from 'node:test';\ntest('executed', () => {});\ntest.skip('requires optional artifact');\n",
  }, async (root) => {
    const result = await runRatchet(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ran 2 tests: 1 pass, 0 fail, 1 skipped/);
  });
});

test("strict verification refuses a skipped required control that development reports separately", async () => {
  const name = REQUIRED_APP_CONTROLS[0].testName;
  await withFixture({
    source: "import test from 'node:test';\ntest('executed', () => {});\n"
      + `test(${JSON.stringify(name)}, t => t.skip('the mounted surface exposed no Start control'));\n`,
  }, async (root) => {
    const development = await runRatchet(root);
    assert.equal(development.code, 0, development.stderr);
    assert.match(development.stdout, /1 pass, 0 fail, 1 skipped/);
    const release = await runRatchet(root, ["--strict"]);
    assert.equal(release.code, 2, release.stderr);
    assert.match(release.stderr, /requires control agent-session-stop-during-start to pass, but it was skipped/);
  });
});

test("promotion can validate an existing measurement without rerunning the suite", () => {
  const stdout = ["TAP version 13", "ok 1 - completed", "1..1", "# tests 1", "# suites 0",
    "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"].join("\n");
  assert.equal(validateSuiteResult({ code: 0, stdout }).counts.pass, 1);
  assert.throws(() => validateSuiteResult({ code: 9, stdout }), /process exit 9/);
});

test("a zero-test Node run is refused", async () => {
  await withFixture({ command: "node --test --test-reporter=tap tools/test/*.absent.mjs" }, async (root) => {
    const result = await runRatchet(root);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /ZERO completed tests/);
  });
});

for (const relative of ["capability/nested/input.txt", "dist/nested/input.txt", "src/nested/input.txt", "config/nested/input.txt", "public/nested/input.txt",
  "private/capability-source.owner.json"]) {
  test(`same-size changes in ${relative} invalidate the measurement and cannot update the baseline`, async () => {
    await withFixture({
      source: "import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\n"
        + `test('content mutation', () => writeFileSync(${JSON.stringify(relative)}, 'changed'));\n`,
    }, async (root) => {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "initial");
      const baselinePath = path.join(root, "tools", "test-baseline.json");
      const before = await readFile(baselinePath, "utf8");
      const result = await runRatchet(root, ["--update"]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /tree changed while the suite was running/);
      assert.equal(await readFile(baselinePath, "utf8"), before);
    });
  });
}

test("strict verification refuses a state root that only looks scratch", async () => {
  await withFixture({}, async (root) => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "not-this-measurement-"));
    try {
      const cases = [
        ["MC_TEST_STATE_ROOT is not set", { MC_TEST_STATE_ROOT: undefined }],
        ["MC_TEST_STATE_ROOT and TOOLSENABLED_STATE_ROOT name different directories",
          { MC_TEST_STATE_ROOT: path.join(elsewhere, "state") }],
        ["TOOLSENABLED_VAULT_PATH points outside TOOLSENABLED_STATE_ROOT",
          { TOOLSENABLED_VAULT_PATH: path.join(elsewhere, "vault", "secrets.json") }],
      ];
      for (const [problem, overrides] of cases) {
        const result = await runRatchet(root, ["--strict"], overrides);
        assert.equal(result.code, 2, `${problem}: ${result.stdout}${result.stderr}`);
        assert.ok(result.stderr.includes(problem), result.stderr);
        assert.match(result.stderr, /Nothing has been measured and the\s+baseline has NOT been touched/);
        assert.doesNotMatch(result.stdout, /Test ratchet: running|Ran \d+ tests/,
          "an inherited state root must refuse before any test suite can start");
      }
      // The same fixture with its own scratch pair still measures.
      const clean = await runRatchet(root, ["--strict"]);
      assert.equal(clean.code, 0, clean.stdout + clean.stderr);
      assert.match(clean.stdout, /MC_TEST_STATE_ROOT=\S+; TOOLSENABLED_VAULT_PATH=\(set, inside the state root\)/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
