import assert from "node:assert/strict";
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NIGHTLY_ENVIRONMENT_VARIABLE,
  RELEASE_SKIP_REGISTER,
  REQUIRED_APP_CONTROLS,
  nightlySkipReason,
  nightlySuitesEnabled,
  platformSkipReason,
  skipEntryAppliesOnPlatform,
  validateSuiteResult,
} from "../lib/test-suite-result.mjs";

const requiredName = REQUIRED_APP_CONTROLS[0].testName;

const PASSING_TAP = `TAP version 13
ok 1 - measures a real test
  ---
  duration_ms: 1
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1`;

test("the validator still requires a complete, exit-consistent TAP measurement", () => {
  assert.deepEqual(validateSuiteResult({ code: 0, stdout: PASSING_TAP }), {
    failures: [],
    counts: { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    stage: "development",
    requiredControls: [],
    skips: { unexecuted: [], named: [], unnamed: [], retired: [] },
  });
  assert.throws(() => validateSuiteResult({ code: 1, stdout: PASSING_TAP }), /process exit 1/);
  assert.throws(() => validateSuiteResult({ code: 0, stdout: "ok 1 - no summary\\n1..1" }), /incomplete TAP summary/);
});

async function measure(t, source) {
  const tempRoot = ownedFixtureTempRoot();
  const root = await mkdtemp(path.join(tempRoot, "required-control-tap-"));
  t.after(() => {
    assert.ok(root.startsWith(tempRoot + path.sep), "only this test's owned temporary child may be removed");
    return rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "fixture.test.mjs");
  await writeFile(file, "import { test, describe } from 'node:test';\n"
    + `const required = ${JSON.stringify(requiredName)};\n${source}\n`);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  if (process.platform === "win32") Object.assign(environment, { TEMP: tempRoot, TMP: tempRoot });
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
    cwd: root, env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { code: result.status, signal: result.signal, stdout: result.stdout };
}

test("release and promotion require the real named control but permit platform-inapplicable coverage", async (t) => {
  const result = await measure(t,
    "test(required, () => {});\n"
    + "test('Windows-only integration', { skip: 'inapplicable fixture platform' }, () => {});\n"
    + "test('a literal # SKIP in a test name is not a skip directive', () => {});");
  for (const stage of ["promotion", "release"]) {
    const evidence = validateSuiteResult({ ...result, stage });
    assert.equal(evidence.counts.pass, 2);
    assert.equal(evidence.counts.skipped, 1);
    assert.deepEqual(evidence.requiredControls, [
      { id: "agent-session-stop-during-start", testName: requiredName, status: "pass" },
    ]);
  }
});

for (const reason of ["the session surface could not be mounted", "the mounted surface exposed no Start control"]) {
  test(`required coverage cannot disappear at promotion/release: ${reason}`, async (t) => {
    const result = await measure(t, "test('unrelated completed check', () => {});\n"
      + `test(required, t => t.skip(${JSON.stringify(reason)}));`);
    assert.equal(result.code, 0, result.stdout);
    const development = validateSuiteResult(result);
    assert.equal(development.counts.pass, 1);
    assert.equal(development.counts.skipped, 1);
    assert.deepEqual(development.requiredControls, []);
    for (const stage of ["promotion", "release"]) {
      assert.throws(() => validateSuiteResult({ ...result, stage }), /requires control .* was skipped/);
    }
  });
}

for (const [label, source, expected] of [
  ["missing", "test('unrelated completed check', () => {});", /found 0 results/],
  ["duplicated", "test(required, () => {}); test(required, () => {});", /found 2 results/],
  ["failed", "test(required, () => { throw new Error('broken control'); });", /requires control .* failed/],
  ["only a describe container", "describe(required, () => { test('unrelated child', () => {}); });", /found 0 results/],
]) {
  test(`a ${label} required control cannot certify release`, async (t) => {
    const result = await measure(t, source);
    for (const stage of ["promotion", "release"]) {
      assert.throws(() => validateSuiteResult({ ...result, stage }), expected);
    }
  });
}

test("a required test can be organized inside a suite without changing its contract", async (t) => {
  const result = await measure(t, "describe('session controls', () => { test(required, () => {}); });");
  assert.equal(validateSuiteResult({ ...result, stage: "release" }).requiredControls.length, 1);
  assert.throws(() => validateSuiteResult({ ...result, stage: "relase" }), /unknown test verification stage/);
});

test("an actual TODO directive cannot hide behind a falsified zero-TODO summary", async (t) => {
  const result = await measure(t, "test('executed', () => {}); test(required, { todo: 'unfinished control' }, () => {});");
  const stdout = result.stdout.replace(/^# todo 1$/m, "# todo 0").replace(/^# pass 1$/m, "# pass 2");
  for (const stage of ["development", "promotion", "release"]) {
    assert.throws(() => validateSuiteResult({ ...result, stdout, stage }), /suite is incomplete.*TODO/);
  }
});

test("every nested TAP group needs its own completed plan, ordered results, and parent", async (t) => {
  const result = await measure(t, `
describe('suite', () => {
  test('parent one', async t => {
    await t.test('deep parent', async t => {
      await t.test(required, () => {});
      await t.test('second leaf', () => {});
    });
    await t.test('peer', () => {});
  });
  test('parent two', async t => { await t.test('another leaf', () => {}); });
});
`);
  const evidence = validateSuiteResult({ ...result, stage: "release" });
  assert.equal(evidence.counts.tests, 7);
  assert.equal(evidence.counts.suites, 1);
  const nestedPlan = /^( +)1\.\.(\d+)$/m.exec(result.stdout);
  const nestedResult = /^( +)ok 1 - .+$/m.exec(result.stdout);
  assert.ok(nestedPlan && nestedResult, "real Node must emit nested evidence for these checks");
  const mutations = [
    ["inflated nested plan", result.stdout.replace(nestedPlan[0], nestedPlan[1] + "1..100")],
    ["missing nested plan", result.stdout.replace(nestedPlan[0], "")],
    ["duplicate nested plan", result.stdout.replace(nestedPlan[0], nestedPlan[0] + "\n" + nestedPlan[0])],
    ["malformed nested plan", result.stdout.replace(nestedPlan[0], nestedPlan[1] + "2..2")],
    ["wrong first nested ordinal", result.stdout.replace(nestedResult[0], nestedResult[0].replace("ok 1", "ok 2"))],
    ["duplicate nested ordinal", result.stdout.replace("ok 2 - second leaf", "ok 1 - second leaf")],
    ["malformed nested result", result.stdout.replace(nestedResult[0], nestedResult[0].replace("ok 1", "ok invalid"))],
    ["wrong top-level ordinal", result.stdout.replace(/^ok 1 -/m, "ok 2 -")],
    ["malformed top-level result", result.stdout.replace(/^ok 1 -/m, "ok invalid -")],
    ["nested bailout", result.stdout.replace(nestedPlan[0], nestedPlan[1] + "Bail out! fixture\n" + nestedPlan[0])],
    ["missing parent", result.stdout.replace(/^        ok 1 - deep parent$/m, "")],
    ["orphaned group", result.stdout.replace(/^1\.\.1$/m, "    ok 1 - orphan\n    1..1\n1..1")
      .replace(/^# tests 7$/m, "# tests 8").replace(/^# pass 7$/m, "# pass 8")],
  ];
  for (const [label, stdout] of mutations) {
    assert.notEqual(stdout, result.stdout, label + " must actually mutate the real report");
    assert.throws(() => validateSuiteResult({ ...result, stdout }), /TAP.*(?:plan|ordinal|result|bail)/i, label);
  }
});

// --- unexecuted coverage is named, never absorbed --------------------------

const nightlyEntry = RELEASE_SKIP_REGISTER.find((entry) => entry.class === "nightly" && !entry.requiredPlatform);
const productGapEntry = RELEASE_SKIP_REGISTER.find((entry) => entry.class === "product-gap");

test("the release skip register is usable: every entry is complete and unique", () => {
  assert.ok(RELEASE_SKIP_REGISTER.length > 0, "an empty register would tolerate nothing and prove nothing");
  const seenIds = new Set();
  const seenNames = new Set();
  for (const entry of RELEASE_SKIP_REGISTER) {
    assert.ok(entry.id && !seenIds.has(entry.id), `duplicate or missing register id: ${entry.id}`);
    assert.ok(entry.testName && !seenNames.has(entry.testName), `duplicate or missing test name: ${entry.testName}`);
    /* Spelled out here rather than imported from the module under test: a
       check that reads its answer out of the thing it is checking cannot fail.
       Adding a class means editing this line, which is the review. */
    assert.ok(
      ["nightly", "product-gap", "platform", "artifact", "owner-data", "decided"].includes(entry.class),
      `unknown class: ${entry.class}`,
    );
    assert.ok(entry.reason && entry.reason.length > 40, `${entry.id} needs a reason a reviewer can act on`);
    assert.ok(entry.stages.includes("release"), `${entry.id} must say which stages it applies to`);
    if (entry.requiredPlatform !== undefined) {
      assert.ok(["win32", "linux", "darwin"].includes(entry.requiredPlatform), `${entry.id} needs an actual OS prerequisite`);
      assert.ok(["platform", "nightly"].includes(entry.class), `${entry.id} has an unrelated platform restriction`);
    }
    seenIds.add(entry.id);
    seenNames.add(entry.testName);
  }
  assert.ok(nightlyEntry && productGapEntry, "both classes are exercised by the checks below");
});

test("native skip dispositions never admit a missing prerequisite on the required host", async t => {
  for (const id of ["windows-release-owner-account-fence", "screen-control-interactive-input"]) {
    const entry = RELEASE_SKIP_REGISTER.find(candidate => candidate.id === id);
    assert.ok(entry, `missing reviewed disposition ${id}`);
    assert.equal(skipEntryAppliesOnPlatform(entry, entry.requiredPlatform), false);
    for (const actual of ["linux", "win32", "darwin"].filter(value => value !== entry.requiredPlatform)) {
      assert.equal(skipEntryAppliesOnPlatform(entry, actual), true);
    }
    const result = await measure(t, "test(required, () => {});\n"
      + `test(${JSON.stringify(entry.testName)}, { skip: 'prerequisite missing' }, () => {});`);
    const evidence = validateSuiteResult({ ...result, stage: "release" });
    assert.deepEqual(evidence.skips.unnamed,
      process.platform === entry.requiredPlatform ? [entry.testName] : []);
    assert.equal(evidence.counts.pass, 1, "registration cannot turn a skip into an execution");
    assert.equal(evidence.counts.skipped, 1);
  }
});

test("a fixture-only assistant guide gap is not admitted by a platform disposition", () => {
  assert.ok(!RELEASE_SKIP_REGISTER.some(entry => entry.testName === "every step of the agent guide points at a control that exists"));
});

test("a skip nobody registered is unexecuted and UNNAMED at release, and is never a pass", async (t) => {
  const result = await measure(t, "test(required, () => {});\n"
    + "test('a suite guarded by a payload that is present but incomplete', { skip: 'packed capability is not present' }, () => {});");
  const evidence = validateSuiteResult({ ...result, stage: "release" });
  assert.equal(evidence.counts.pass, 1);
  assert.equal(evidence.counts.skipped, 1);
  assert.deepEqual(evidence.skips.unnamed, ["a suite guarded by a payload that is present but incomplete"]);
  assert.deepEqual(evidence.skips.named, []);
  assert.deepEqual(evidence.skips.unexecuted, ["a suite guarded by a payload that is present but incomplete"]);
});

test("a registered skip is reported by name with its class and reason, and still is not a pass", async (t) => {
  const result = await measure(t, "test(required, () => {});\n"
    + `test(${JSON.stringify(nightlyEntry.testName)}, { skip: 'needs a real desktop' }, () => {});`);
  const evidence = validateSuiteResult({ ...result, stage: "release" });
  assert.equal(evidence.counts.pass, 1, "a named skip must not be counted as executed coverage");
  assert.deepEqual(evidence.skips.unnamed, []);
  assert.equal(evidence.skips.named.length, 1);
  assert.equal(evidence.skips.named[0].id, nightlyEntry.id);
  assert.equal(evidence.skips.named[0].class, "nightly");
  assert.equal(evidence.skips.named[0].reason, nightlyEntry.reason);
});

test("development reports what did not execute but partitions nothing, so the register is a release rule only", async (t) => {
  const result = await measure(t, "test(required, () => {});\n"
    + "test('unregistered', { skip: 'because' }, () => {});");
  const evidence = validateSuiteResult({ ...result, stage: "development" });
  assert.deepEqual(evidence.skips.unexecuted, ["unregistered"]);
  assert.deepEqual(evidence.skips.named, []);
  assert.deepEqual(evidence.skips.unnamed, []);
  assert.deepEqual(evidence.skips.retired, []);
});

test("a product-gap entry whose test now EXECUTES is reported as retired, so the register only comes down", async (t) => {
  const result = await measure(t, "test(required, () => {});\n"
    + `test(${JSON.stringify(productGapEntry.testName)}, () => {});`);
  const evidence = validateSuiteResult({ ...result, stage: "release" });
  assert.deepEqual(evidence.skips.retired.map((entry) => entry.id), [productGapEntry.id]);
});

test("a nightly entry whose test executes is NOT retired, because a nightly run is where it is meant to run", async (t) => {
  const result = await measure(t, "test(required, () => {});\n"
    + `test(${JSON.stringify(nightlyEntry.testName)}, () => {});`);
  const evidence = validateSuiteResult({ ...result, stage: "release" });
  assert.deepEqual(evidence.skips.retired, []);
});

/* THE EXEMPTION IS THE POINT, so it is checked against every class that has
   it, by calling with a real register entry of each -- not by asserting the
   contents of RETIRABLE_CLASSES, which would only restate the module to
   itself. A platform test executes on Linux, an artifact test after a build,
   an owner-data test on a machine that has the owner's data: if executing
   retired those entries, the register would empty itself on exactly the runs
   where it was working. */
for (const exemptClass of ["platform", "artifact", "owner-data", "decided"]) {
  const entry = RELEASE_SKIP_REGISTER.find((candidate) => candidate.class === exemptClass);
  test(`a ${exemptClass} entry whose test executes is NOT retired -- that run is where it belongs`, async (t) => {
    assert.ok(entry, `no ${exemptClass} entry to exercise the exemption with`);
    const result = await measure(t, "test(required, () => {});\n"
      + `test(${JSON.stringify(entry.testName)}, () => {});`);
    const evidence = validateSuiteResult({ ...result, stage: "release" });
    assert.deepEqual(evidence.skips.retired, []);
  });
}

test("a platform guard says which platform it wanted and which one it got, and never blocks the right one", () => {
  /* Called with values rather than pinned to a spelling: what matters is that
     the applicable host gets `false` (so the test RUNS) and the inapplicable
     host gets words. `{ skip: someBoolean }` renders as a bare `# SKIP`, which
     is the silent skip this exists to end. */
  assert.equal(platformSkipReason("linux", "linux"), false, "the platform it asks for must still run it");
  assert.equal(platformSkipReason("win32", "win32"), false);

  const reason = platformSkipReason("linux", "win32");
  assert.equal(typeof reason, "string");
  assert.ok(reason.includes("linux"), "a reader must be told which platform the test wanted");
  assert.ok(reason.includes("win32"), "and which one it got");
  assert.ok(reason.length > 40, "a reason a reviewer cannot act on is the same as no reason");

  /* Usable directly as the option object, which is the whole point: one
     expression decides AND explains, so the condition and the sentence cannot
     drift apart from each other. */
  assert.deepEqual({ skip: platformSkipReason("linux", "linux") }, { skip: false });
});

test("the nightly gate has one documented variable and one source for its reason", () => {
  assert.equal(NIGHTLY_ENVIRONMENT_VARIABLE, "TOOLSENABLED_NIGHTLY");
  assert.equal(nightlySuitesEnabled({ TOOLSENABLED_NIGHTLY: "1" }), true);
  assert.equal(nightlySuitesEnabled({ TOOLSENABLED_NIGHTLY: "0" }), false);
  assert.equal(nightlySuitesEnabled({ TOOLSENABLED_NIGHTLY: "true" }), false, "only the documented value enables it");
  assert.equal(nightlySuitesEnabled({}), false);

  const reason = nightlySkipReason(nightlyEntry.id);
  assert.ok(reason.includes(nightlyEntry.id), "a reader of the TAP line must be able to find the register entry");
  assert.ok(reason.includes(nightlyEntry.reason), "the skip reason and the register reason cannot drift apart");
  assert.throws(() => nightlySkipReason("no-such-entry"), /no RELEASE_SKIP_REGISTER entry/);
  assert.throws(() => nightlySkipReason(productGapEntry.id), /is not a nightly entry/);
});


test('real failure diagnostics cannot masquerade as TAP results, plans or bailouts', async t => {
  const measured = await measure(t, "test('a reported assertion failure', () => { throw new Error('ok without ordinal\\nnot ok 90 - quoted text\\n1..90\\nBail out! quoted diagnostic'); });");
  const result = validateSuiteResult(measured);
  assert.equal(result.counts.tests, 1);
  assert.equal(result.counts.fail, 1);
  assert.deepEqual(result.failures, ['a reported assertion failure']);
  const truncated = measured.stdout.replace(/^  \.\.\.$/m, '');
  assert.throws(() => validateSuiteResult({ ...measured, stdout: truncated }), /diagnostic/);
});
