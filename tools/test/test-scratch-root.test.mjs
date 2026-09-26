/* SCRATCH MUST NOT LAND IN THE SHARED DEPENDENCY STORE.
 *
 * The rule being pinned is not "the helper returns a nice path" -- it is that
 * no suite's scratch directory resolves under `node_modules`, because in this
 * repository's layout `node_modules` is a junction into a store every worktree
 * shares. That is asserted two ways: by calling the helper with values, and by
 * reading the suite files themselves, so a file that goes back to building the
 * old path by hand is caught even though it never calls this helper.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

import { testScratchRoot } from "../lib/test-scratch-root.mjs";
import { SCRATCH_MODE, prepareStrictScratch } from "../lib/strict-scratch.mjs";
import * as strictScratch from "../lib/strict-scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE_DIRECTORY = HERE;
const { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = createRequire(import.meta.url)("../../shell/capability-path-environment.cjs");

test("a scratch root lands under the temp root the run pinned, never under node_modules", () => {
  const pinned = path.join(path.sep === "\\" ? "C:\\pinned-temp" : "/pinned-temp", "run-42");
  const resolved = testScratchRoot(".toolsenabled-example-test", { tmpdir: pinned });

  assert.equal(resolved, path.join(pinned, ".toolsenabled-example-test"));
  assert.equal(resolved.includes("node_modules"), false, "scratch resolved inside the dependency store");
  assert.ok(
    resolved.startsWith(pinned),
    "a run that pins TEMP must get its scratch inside that TEMP, or pinning bought nothing",
  );

  /* The default reads the pinned value rather than a compiled-in path, which is
     the whole mechanism: tools/test-strict.mjs sets TEMP/TMP per run. */
  assert.equal(testScratchRoot("x"), path.join(os.tmpdir(), "x"));
});

/* THE PERMISSIONS OF THE SCRATCH ARE PART OF THE MEASUREMENT, not a detail.
 * See tools/lib/strict-scratch.mjs's header for the 20 failures that were
 * nothing but the mode of three directories, and for why the decision is a
 * module rather than four lines inside tools/test-strict.mjs.
 */
test("the strict runner's scratch is owner-private, so the product's own account-storage checks accept it", () => {
  const outer = mkdtempSync(path.join(os.tmpdir(), "strict-scratch-mode-"))
  try {
    const scratch = path.join(outer, "given")
    mkdirSync(scratch, { mode: 0o777 }) // a deliberately permissive caller
    const prepared = prepareStrictScratch(scratch)
    assert.equal(prepared.ok, true)
    assert.equal(prepared.state, path.join(scratch, "state"))
    assert.equal(prepared.temp, path.join(scratch, "temp"))
    if (process.platform === "win32") return // POSIX modes are not the mechanism here
    /* 0o700 WRITTEN OUT, not SCRATCH_MODE. Reading the constant back out of the
       module under test would let a mutation that widens it pass -- measured:
       setting SCRATCH_MODE to 0o755 left this test green until the literal went
       in. The number the product's walk accepts is the requirement; the module's
       constant is only its claim to meet it, which is the next line. */
    assert.equal(SCRATCH_MODE, 0o700, "the declared scratch mode is no longer the one the walk accepts")
    for (const directory of [scratch, prepared.state, prepared.temp]) {
      assert.equal(statSync(directory).mode & 0o7777, 0o700,
        "mutation `scratch created with the caller's umask` survived: expected "
        + `${path.basename(directory)} to be 0o700, so the account-storage walk in `
        + "shell/linux-account-state.cjs accepts the state root inside it")
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

/* AND IT MAY ONLY NARROW A DIRECTORY THAT IS ITS OWN. Without this, the check
 * above would be satisfied by `--scratch ~` chmodding a home directory to 0o700. */
test("a scratch that is already in use is refused rather than narrowed", () => {
  const outer = mkdtempSync(path.join(os.tmpdir(), "strict-scratch-busy-"))
  try {
    const scratch = path.join(outer, "occupied")
    mkdirSync(scratch, { recursive: true, mode: 0o777 })
    for (const name of ["someone-elses-file", "another", "third"]) writeFileSync(path.join(scratch, name), "x")
    const before = statSync(scratch).mode & 0o7777
    const prepared = prepareStrictScratch(scratch)

    assert.equal(prepared.ok, false, "mutation `narrow any directory the caller names` survived: expected a "
      + "refusal for a scratch that already holds someone else's files")
    assert.equal(prepared.reason, "not-empty")
    assert.equal(prepared.entries, 5, "the refusal must report what it actually found")
    if (process.platform !== "win32") {
      assert.equal(statSync(scratch).mode & 0o7777, before,
        "mutation `chmod before checking` survived: expected a refused scratch to keep the permissions it had")
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

/* T308: A STRICT MEASUREMENT OWNS ITS ENVIRONMENT THE WAY A CUT DOES.
 *
 * The release cut (tools/release-packager/cut-release-candidate.mjs
 * buildDistChainEnvironment) drops every inherited capability path override,
 * names a native scratch root and empties PSModulePath on Windows. Each of
 * those was a measured false red or a write into the owner's installation on
 * the 1.0.45 cut. tools/test-strict.mjs, the other way into the same
 * verify:release gate, kept only the state root and vault half of that, so a
 * strict run from an agent shell inherited the other overrides, and on native
 * Windows tools/test/audit-repair-native.test.mjs refused its native cases for
 * the missing MC_SETTINGS_NATIVE_SCRATCH_ROOT. */
test("the strict runner's scratch includes a native scratch root, where a cut keeps its own", () => {
  const outer = mkdtempSync(path.join(os.tmpdir(), "strict-scratch-native-"))
  try {
    const scratch = path.join(outer, "given")
    mkdirSync(scratch)
    const prepared = prepareStrictScratch(scratch)
    assert.equal(prepared.ok, true)
    assert.equal(prepared.native, path.join(scratch, "temp", "native-qualification"),
      "mutation `no native scratch root` survived: the Windows native custody suites need a directory this "
      + "measurement owns, in the layout nativeQualificationRoot() gives a cut")
    assert.ok(statSync(prepared.native).isDirectory(), "the native scratch root must exist before the suites start")
    assert.deepEqual(readdirSync(scratch).sort(), ["state", "temp"],
      "the scratch root itself must still hold only its two children")
    if (process.platform !== "win32") assert.equal(statSync(prepared.native).mode & 0o7777, 0o700)
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("the strict measurement drops every inherited capability path override and names its own roots", () => {
  assert.equal(typeof strictScratch.strictMeasurementEnvironment, "function",
    "tools/lib/strict-scratch.mjs exports no strictMeasurementEnvironment, so tools/test-strict.mjs still "
    + "builds its child environment by hand and keeps what the launching shell carried")
  const live = path.join(path.sep, "owner", "AppData", "Roaming", "ToolsEnabled-Live", "capability")
  const inherited = Object.fromEntries(CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES.map(name => [name, path.join(live, name.toLowerCase())]))
  const scratch = path.join(path.sep, "scratch", "strict-1")
  const roots = {
    state: path.join(scratch, "state"),
    temp: path.join(scratch, "temp"),
    native: path.join(scratch, "temp", "native-qualification"),
    canonicalRoot: path.join(path.sep, "engine"),
  }
  const environment = strictScratch.strictMeasurementEnvironment(
    { ...inherited, PATH: "/usr/bin", KEEP_ME: "unchanged", TOOLSENABLED_NIGHTLY: "1" },
    { ...roots, platform: "linux" })

  const leaked = Object.entries(environment).filter(([, value]) => String(value).includes("ToolsEnabled-Live"))
  assert.deepEqual(leaked, [],
    "mutation `re-point only the state root and vault` survived: these inherited overrides still name the "
    + "owner's installation")
  const kept = CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES.filter(name => name in environment).sort()
  assert.deepEqual(kept, ["TOOLSENABLED_STATE_ROOT", "TOOLSENABLED_VAULT_PATH"],
    "only the two overrides this measurement names for itself may be set")
  assert.equal(environment.TOOLSENABLED_STATE_ROOT, roots.state)
  assert.equal(environment.MC_TEST_STATE_ROOT, roots.state)
  assert.equal(environment.TOOLSENABLED_VAULT_PATH, path.join(roots.state, "vault", "secrets.json"))
  for (const name of ["TEMP", "TMP", "TMPDIR"]) assert.equal(environment[name], roots.temp)
  assert.equal(environment.MC_CANONICAL_ROOT, roots.canonicalRoot)
  assert.equal(environment.TOOLSENABLED_TEST_STRICT, "1")
  assert.equal(environment.MC_SETTINGS_NATIVE_SCRATCH_ROOT, roots.native,
    "mutation `no MC_SETTINGS_NATIVE_SCRATCH_ROOT` survived: audit-repair-native refuses its native Windows cases "
    + "without it, which the 1.0.45 cut measured 14 times")
  assert.equal("TOOLSENABLED_NIGHTLY" in environment, false, "an inherited nightly switch must not turn nightly suites on")
  assert.equal(environment.PATH, "/usr/bin")
  assert.equal(environment.KEEP_ME, "unchanged", "variables that name no product state pass through untouched")

  const nightly = strictScratch.strictMeasurementEnvironment({}, { ...roots, nightly: true, platform: "linux" })
  assert.equal(nightly.TOOLSENABLED_NIGHTLY, "1")
  assert.throws(() => strictScratch.strictMeasurementEnvironment({}, { ...roots, native: "relative" }),
    /absolute native directory/)
})

test("on Windows the strict measurement empties PSModulePath, and elsewhere leaves it alone", () => {
  assert.equal(typeof strictScratch.strictMeasurementEnvironment, "function",
    "tools/lib/strict-scratch.mjs exports no strictMeasurementEnvironment")
  const roots = {
    state: path.join(path.sep, "s", "state"), temp: path.join(path.sep, "s", "temp"),
    native: path.join(path.sep, "s", "temp", "native-qualification"), canonicalRoot: path.join(path.sep, "e"),
  }
  const pwsh7 = "C:\\Program Files\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules"
  const windows = strictScratch.strictMeasurementEnvironment({ PSModulePath: pwsh7 }, { ...roots, platform: "win32" })
  assert.equal(windows.PSModulePath, "",
    "mutation `hand a PowerShell 7 PSModulePath to Windows PowerShell 5.1 children` survived: the 1.0.45 cut "
    + "measured 22 reds from exactly that, and 45/45 with it emptied")
  const linux = strictScratch.strictMeasurementEnvironment({ PSModulePath: "/opt/pwsh/Modules" }, { ...roots, platform: "linux" })
  assert.equal(linux.PSModulePath, "/opt/pwsh/Modules")
})

/* Whether tools/test-strict.mjs actually hands this environment to
   verify:release is proved against the real producer source in
   tools/test/release-source-continuation.test.mjs authenticStrictTranscript(). */

test("a scratch name that is really a path is refused, so the old shape cannot come back by accident", () => {
  assert.throws(() => testScratchRoot("node_modules/.toolsenabled-sneaky"), /takes a name, not a path/);
  assert.throws(() => testScratchRoot("node_modules\\.toolsenabled-sneaky"), /takes a name, not a path/);
  assert.throws(() => testScratchRoot(""), /needs a directory name/);
  assert.throws(() => testScratchRoot(undefined), /needs a directory name/);
});

/* Two files legitimately contain the old shape, and they are named here with
   their reason rather than skipped by a pattern -- a pattern would silently
   adopt the next file that happened to match it. */
const ALLOWED_TO_NAME_THE_OLD_SHAPE = new Map([
  [
    "bootstrap-fence-link-inside-the-profile.test.mjs",
    "the old path IS its subject: it builds a real junction and a real "
      + "<worktree>/node_modules/.toolsenabled-scratch to prove the account fence admits a link "
      + "that lands back inside the owned profile. Changing it would delete the check.",
  ],
  ["test-scratch-root.test.mjs", "this file, which has to quote the shape in order to look for it."],
]);

test("no suite file builds a scratch path under node_modules any more", () => {
  /* Reads the tree, so it fails for a file that reintroduces the old shape
     without importing anything from here. Comments are stripped first: a
     paragraph EXPLAINING the old path -- and several files carry one, on
     purpose -- is not the same as code creating it. */
  const offenders = [];
  for (const entry of readdirSync(SUITE_DIRECTORY)) {
    if (!entry.endsWith(".test.mjs")) continue;
    if (ALLOWED_TO_NAME_THE_OLD_SHAPE.has(entry)) continue;
    const source = readFileSync(path.join(SUITE_DIRECTORY, entry), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    /* `path.join(ROOT, 'node_modules', '.toolsenabled-x')` and the
       `'node_modules/.toolsenabled-x'` single-argument spelling both count. */
    if (/node_modules['"\s,)]*[^\n]{0,40}\.toolsenabled-/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(
    offenders,
    [],
    "these files put their scratch inside the shared dependency store, where an EPERM in teardown "
      + `reads as a product failure: ${offenders.join(", ")}`,
  );
});
