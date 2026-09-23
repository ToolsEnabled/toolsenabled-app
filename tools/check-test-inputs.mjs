#!/usr/bin/env node

// Refusal gate for the test entry point: DERIVED INPUTS THE SUITE NEEDS.
//
// THE DEFECT THIS EXISTS TO END, measured 2026-08-11 (R1526) on a detached
// worktree of the app tip with nothing else wrong with it:
//
//   fresh checkout, no derived inputs   ->  npm test: 40 failures
//   same checkout, inputs staged        ->  npm test:  1 failure
//
// Not one of those 39 was a defect in the product. They were the suite
// reading things git does not carry -- the staged capability payload and two
// builder-private JSON files -- and reporting their absence as assertion
// failures and a raw `Error: Cannot find module ...agent-session-confinement.js`.
// A person on another machine, cloning this repo to check a release
// candidate, reads that and concludes the candidate is broken. It is not.
// Their checkout is incomplete, and nothing told them so.
//
// ABSENCE IS NEVER CONSENT, AND IT IS NOT A VERDICT EITHER. This repo already
// applies that rule in one direction -- tools/check-suites-discovered.mjs
// refuses to let "the glob matched nothing" read as a pass. This is the same
// rule pointed the other way: "the inputs were missing" must not read as
// "the code is broken".
//
// SO THIS REFUSES RATHER THAN GUESSES. It runs first in `npm test`, and if a
// required input is absent it says which one, why git does not carry it, the
// exact command that produces it, what that command itself needs first, and
// how many suites are affected -- then exits 3, which is neither 0 (pass) nor
// 1 (tests failed), so no reader and no script can mistake it for a code
// failure.
//
// WHAT IS REQUIRED IS MEASURED, NOT ASSUMED. Every entry below was attributed
// by moving exactly that input aside, running the WHOLE suite, diffing the
// named reds and skips against a run with everything present, and putting the
// input back. Inputs whose absence the suite ALREADY handles honestly are
// deliberately NOT required -- they are reported at the bottom as expected
// skips, so a skip is never mistaken for a hole:
//
//   private/purchase-catalog.owner.json  absent -> 3 honest skips, each naming the file
//   dist/                                absent -> 0 failures, 1 honest skip
//   release/win-unpacked                 absent -> 2 honest skips, both naming `npm run dist`
//
// PROVENANCE OF THE THREE NUMBERS, because they were not all taken the same
// way and a reader is entitled to know which is which:
//
//   private/capability-source.owner.json   2   re-measured 2026-08-11 on a
//   private/owner-data-patterns.owner.json 8   verified-stable tree, whole
//                                              suite, named reds diffed against
//                                              a control taken the same way
//   capability/                           31   first measurement, whole suite,
//                                              NOT re-taken since
//
// The first two replace earlier figures (12 and "at least 5") that came from
// runs taken while another process on the machine was moving these same paths.
// They were wrong in both directions -- one overstated by 6x, one understated
// -- which is the whole argument for re-measuring on a quiet tree instead of
// hedging a contaminated number with the word "about".
//
// TO RE-MEASURE ANY NUMBER BELOW, BYPASS THIS FILE. Once this gate is wired
// into `npm test`, moving an input aside and running `npm test` no longer
// produces failure counts -- it produces THIS refusal, exit 3, with zero tests
// run, which is the gate working. The reproduction is therefore:
//
//   mv private/<input> /tmp/held        # or rename capability/
//   npm run test:data                   # the raw runner, no gates
//   mv /tmp/held private/<input>        # put it back, always
//
// and compare the named reds against a `npm run test:data` control taken the
// same way. Anyone who tries it through `npm test` and gets exit 3 has not
// found a discrepancy in these numbers; they have found the gate.
//
// That asymmetry is the whole design. A missing input should cost you a
// stated skip, never a red. Where it still costs a red, this gate stops the
// run instead.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_DIR = path.join(REPO_ROOT, "tools", "test");
const SUITE_SUFFIX = ".test.mjs";

const EXIT_OK = 0;
const EXIT_BROKEN_GATE = 2;
const EXIT_MISSING_INPUTS = 3;

// `token` is what a suite has to mention to be counted as touching this
// input. That count is DERIVED by scanning the suite files rather than typed
// here, for the same reason check-suites-discovered.mjs derives its two sets:
// a hand-kept number goes stale the first time someone adds a test, and goes
// stale silently.
//
// It is a TEXT SCAN and it is reported as one -- "suite files mentioning it",
// not "suites that need it". A mention is an upper bound: some of those files
// only name the input in a comment. The number that actually matters is
// `measured`, which came from removing the input and counting the reds, and
// the wording below never lets the scan impersonate that measurement.
const REQUIRED_INPUTS = [
  {
    id: "capability/",
    absolute: path.join(REPO_ROOT, "capability"),
    kind: "directory",
    token: "capability",
    measured: "31 tests went red with this absent, one of them a whole suite crashing with Cannot find module",
    whyNotInGit:
      "derived output, and gitignored (/capability/). `npm run pack:capability` cuts it fresh from the " +
      "capability-layer source, so a committed copy would freeze bytes that stop matching the code they came from.",
    command: "npm run pack:capability",
    needsFirst: "private/capability-source.owner.json (or --source / TOOLSENABLED_SOURCE)",
  },
  {
    id: "private/capability-source.owner.json",
    absolute: path.join(REPO_ROOT, "private", "capability-source.owner.json"),
    kind: "file",
    token: "capability-source.owner.json",
    measured:
      "2 tests went red with this absent -- the two that re-stage the payload from source, " +
      "because the packer cannot find the tree to cut it from (whole-suite run, 1457 tests, " +
      "1453 pass, 2 fail)",
    whyNotInGit:
      "builder-private, and gitignored (/private/). It holds an absolute path to the capability-layer source " +
      "tree on THIS machine, which names the builder and their disk layout, so it is configuration and not a constant.",
    command:
      'create it with: {"path": "<absolute path to the capability-layer source checkout>"}  ' +
      "(or set TOOLSENABLED_SOURCE, or pass --source to tools/pack-capability-layer.mjs)",
    needsFirst: null,
  },
  {
    id: "private/owner-data-patterns.owner.json",
    absolute: path.join(REPO_ROOT, "private", "owner-data-patterns.owner.json"),
    kind: "file",
    token: "owner-data-patterns.owner.json",
    measured:
      "8 tests went red with this absent -- 5 declaration-privacy cases, 1 that checks the local " +
      "owner profile belongs to the account building here, and the 2 that re-stage the payload: " +
      "the packer refuses outright (\"owner-data guard COULD NOT RUN, so this payload is " +
      "UNCHECKED\"), which --allow-owner-data deliberately does not override (whole-suite run, " +
      "1457 tests, 1447 pass, 8 fail)",
    whyNotInGit:
      "builder-private, and gitignored (/private/). It IS the list of strings that must never ship -- the " +
      "builder's name, home paths and LAN addresses -- so committing it would publish exactly what it exists to catch.",
    command:
      "copy config/owner-data-patterns.example.json to that path and replace every placeholder value " +
      "with your own -- that template is in git precisely so this does not require asking anyone",
    needsFirst:
      "nothing, but note the file must describe YOU: the identity check requires at least one pattern " +
      "to relate to the OS account running the build, so the shipped placeholders will not pass",
  },
];

// Not required. Listed so their absence reads as "expected skip", not "hole".
const OPTIONAL_INPUTS = [
  {
    id: "private/purchase-catalog.owner.json",
    absolute: path.join(REPO_ROOT, "private", "purchase-catalog.owner.json"),
    costsWhenAbsent: "3 operator-catalogue tests skip, each saying so by name",
  },
  {
    id: "dist/",
    absolute: path.join(REPO_ROOT, "dist"),
    costsWhenAbsent: "1 built-payload privacy test skips, naming `npm run build`",
  },
  {
    id: "release/win-unpacked",
    absolute: path.join(REPO_ROOT, "release", "win-unpacked"),
    costsWhenAbsent: "2 packaged-artifact tests skip, naming `npm run dist`",
  },
];

function present(entry) {
  if (!existsSync(entry.absolute)) return false;
  try {
    const stats = statSync(entry.absolute);
    if (entry.kind === "directory") {
      return stats.isDirectory() && readdirSync(entry.absolute).length > 0;
    }
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// How many suites actually reference this input. Derived by reading them.
function dependentSuiteCount(token) {
  let count = 0;
  for (const name of readdirSync(SUITE_DIR)) {
    if (!name.endsWith(SUITE_SUFFIX)) continue;
    const text = readFileSync(path.join(SUITE_DIR, name), "utf8");
    if (text.includes(token)) count += 1;
  }
  return count;
}

function suiteNames() {
  return readdirSync(SUITE_DIR).filter((name) => name.endsWith(SUITE_SUFFIX));
}

function main() {
  // A gate that checked nothing must never report success -- the same rule
  // tools/check-no-owner-data.mjs and tools/check-suites-discovered.mjs apply
  // to themselves.
  if (REQUIRED_INPUTS.length === 0) {
    console.error("check-test-inputs: the required-input list is empty, so this gate checked nothing.");
    return EXIT_BROKEN_GATE;
  }
  if (!existsSync(SUITE_DIR)) {
    console.error(
      `check-test-inputs: the suite directory ${path.relative(REPO_ROOT, SUITE_DIR)} does not exist, ` +
        "so this gate cannot tell which suites depend on what.",
    );
    return EXIT_BROKEN_GATE;
  }
  if (suiteNames().length === 0) {
    console.error(
      `check-test-inputs: the suite directory ${path.relative(REPO_ROOT, SUITE_DIR)} contains no ${SUITE_SUFFIX} files, ` +
        "so this gate checked no test consumers.",
    );
    return EXIT_BROKEN_GATE;
  }

  const missing = REQUIRED_INPUTS.filter((entry) => !present(entry));

  if (missing.length === 0) {
    console.log(
      `Test inputs: all ${REQUIRED_INPUTS.length} required derived input(s) present ` +
        `(${REQUIRED_INPUTS.map((entry) => entry.id).join(", ")}).`,
    );
    const absentOptional = OPTIONAL_INPUTS.filter((entry) => !existsSync(entry.absolute));
    for (const entry of absentOptional) {
      console.log(`  optional, absent: ${entry.id} -- ${entry.costsWhenAbsent}.`);
    }
    return EXIT_OK;
  }

  console.error(
    "\nTHIS CHECKOUT CANNOT ANSWER \"is the product broken\" YET -- and it is not " +
      "reporting that it is.\n",
  );
  console.error(
    `${missing.length} input(s) the test suite reads are absent. They are absent because git does not\n` +
      "carry them, not because anything is wrong with the code. No test has been run.\n",
  );

  for (const entry of missing) {
    const suites = dependentSuiteCount(entry.token);
    console.error(`  MISSING  ${entry.id}`);
    console.error(`    why it is not in git : ${entry.whyNotInGit}`);
    console.error(`    what produces it     : ${entry.command}`);
    if (entry.needsFirst) console.error(`    which itself needs   : ${entry.needsFirst}`);
    console.error(`    suite files naming it: ${suites} (text scan -- an upper bound, not a measurement)`);
    console.error(`    MEASURED cost        : ${entry.measured}`);
    console.error("");
  }

  console.error("The usual order on a fresh checkout is:\n");
  console.error("  npm ci");
  console.error("  npm run build             # optional: without it one privacy test skips, by name");
  console.error("  npm run pack:capability   # needs private/capability-source.owner.json first");
  console.error("  npm test\n");
  console.error(
    "If you only want the part of the suite that does not need these, run a suite file directly:\n" +
      "  node --test tools/test/<name>.test.mjs\n",
  );
  console.error(
    `Exiting ${EXIT_MISSING_INPUTS} on purpose: 0 would say the product passed, 1 would say its tests failed,\n` +
      "and neither is true. Nothing about the product has been measured.\n",
  );
  return EXIT_MISSING_INPUTS;
}

process.exitCode = main();
