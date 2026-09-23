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

import { testScratchRoot } from "../lib/test-scratch-root.mjs";
import { SCRATCH_MODE, prepareStrictScratch } from "../lib/strict-scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE_DIRECTORY = HERE;

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
