#!/usr/bin/env node

// A LANDING MUST RUN THE SUITES OF THE FILES IT TOUCHES.
//
// MEASURED 2026-09-18, and this file exists because of it: Controller's typing
// commit landed on cut2/app-assembly-20260917 with tools/test/chat-composer.test.mjs
// red, and nobody owned the red. The commit edited src/components.js. The pin it
// broke lives in chat-composer.test.mjs, a file the commit did not touch -- so
// nothing in the landing said that suite was owed. It was found afterwards, by a
// manager running suites by hand, and it cost an argument about whether it was a
// regression at all. (It was not: the rule moved from syncComposer to
// syncSendButton and the suite slices 700 characters from syncComposer. Stale
// pin, unchanged behaviour. Still had to be found.)
//
// The rule that catches it is not "run every suite" -- that is the full run, it
// is expensive, and a landing that cannot afford it skips it entirely. It is the
// narrower one: a suite that READS a file the commit CHANGED is owed by that
// commit. chat-composer.test.mjs reads src/components.js, the commit changed
// src/components.js, so the suite was owed and its red was the landing's to
// answer.
//
// WHAT COUNTS AS "READS". A suite's own source names the files it inspects --
// readFileSync('src/components.js'), new URL('../../src/views/computers.js',
// import.meta.url), resolve(ROOT, 'shell/agent-host.cjs'). Those literals are
// the dependency edge, and they are the edge that matters here: a source-shape
// pin has no import to follow, which is exactly why this class of red goes
// unowned. Scanning for the literals finds the edge an import graph misses.
//
// TWO MODES, both refusing by name rather than skipping:
//   --run             execute the owed suites now and refuse on any red
//   --ran <file>      verify against a list of suites the landing already ran
// Neither mode can be satisfied by silence: an owed suite that is absent from
// the run list is named and refused, and so is a base that cannot be resolved.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_DIR = path.join(REPO_ROOT, "tools", "test");
const SUITE_SUFFIX = ".test.mjs";

/* The directories a suite can meaningfully pin. A literal naming something
   outside these is a fixture path or a scratch directory, not a product file,
   and treating it as a dependency edge would make every suite owe every
   landing. */
const PRODUCT_ROOTS = ["src", "shell", "public", "config", "tools"];
/* Any quoted string that looks like a path to a file: either relative (./x,
   ../../src/x) or spelled from a product root (src/x). Both forms appear, and
   BOTH ARE NEEDED -- measured while building this gate: a first version matched
   only the product-root form, which finds the source-shape pins
   (readFileSync('src/components.js')) but misses the most obvious edge there
   is, a suite that simply imports the module it tests
   (import { recordDistSource } from '../check-dist-current.mjs'). Run against
   its own branch it reported "no suite reads any changed file" for a change to
   tools/check-dist-current.mjs, while tools/test/check-dist-current.test.mjs
   sat right there importing it. A gate that misses the ordinary case to catch
   the exotic one is worse than no gate, because it looks like coverage. */
const PATH_LITERAL = new RegExp(
  String.raw`['"\`]((?:\.{1,2}\/|(?:${PRODUCT_ROOTS.join("|")})\/)[A-Za-z0-9._\-\/]*\.[A-Za-z0-9]+)['"\`]`,
  "g",
);

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function refuse(message) {
  console.error(`Touched-file suite gate REFUSED: ${message}`);
  process.exit(2);
}

/* AN IMPLICIT BASE MUST SAY SO. The same defect check-no-owner-data records in
   its own header: a gate that silently picks what to compare against can pass
   because of what it was not given. The chosen base is printed before anything
   is compared, and a base that cannot be resolved is a refusal, never an empty
   touched-file set -- "nothing was touched" and "I could not tell what was
   touched" must never look alike. */
function resolveBase(argv) {
  const flagged = argv.indexOf("--base");
  if (flagged !== -1) {
    const ref = argv[flagged + 1];
    if (!ref) refuse("--base was given with no ref after it.");
    try {
      return { base: git(["rev-parse", "--verify", `${ref}^{commit}`]), how: `named on the command line (--base ${ref})` };
    } catch {
      refuse(`the base ref "${ref}" does not resolve to a commit in this repository.`);
    }
  }
  for (const candidate of ["cut2/app-assembly-20260917", "origin/main", "main"]) {
    try {
      const merge = git(["merge-base", "HEAD", candidate]);
      if (merge !== git(["rev-parse", "HEAD"])) {
        return { base: merge, how: `merge-base with ${candidate} (chosen by default; no --base was given)` };
      }
    } catch { /* candidate not present in this clone; try the next */ }
  }
  try {
    return { base: git(["rev-parse", "--verify", "HEAD~1"]), how: "HEAD~1 (no assembly branch was reachable; this is the WEAKEST base and covers one commit only)" };
  } catch {
    refuse("no base could be resolved: HEAD has no parent and no assembly branch is reachable. Pass --base explicitly.");
  }
}

function touchedFiles(base) {
  const listing = git(["diff", "--name-only", `${base}..HEAD`]);
  return listing ? listing.split("\n").map(line => line.trim()).filter(Boolean) : [];
}

function everySuite() {
  if (!existsSync(SUITE_DIR)) refuse(`the suite directory does not exist: ${path.relative(REPO_ROOT, SUITE_DIR)}`);
  return readdirSync(SUITE_DIR).filter(name => name.endsWith(SUITE_SUFFIX))
    .map(name => `tools/test/${name}`);
}

/* The literals a suite names, normalised to repository-relative POSIX paths.
   A relative specifier is resolved against the suite's own directory, which is
   what both `import '../x.mjs'` and `new URL('../../src/x.js', import.meta.url)`
   mean; a product-root spelling is already repository-relative and is kept.
   Anything that resolves outside the repository is dropped rather than
   guessed at. */
function filesReadBy(suite) {
  const source = readFileSync(path.join(REPO_ROOT, suite), "utf8");
  const suiteDirectory = path.dirname(path.join(REPO_ROOT, suite));
  const named = new Set();
  for (const [, literal] of source.matchAll(PATH_LITERAL)) {
    const absolute = literal.startsWith(".")
      ? path.resolve(suiteDirectory, literal)
      : path.join(REPO_ROOT, literal);
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
    if (relative && !relative.startsWith("..")) named.add(relative);
  }
  return named;
}

/* One suite, one verdict. A suite that exits 0 without printing a summary ran
   nothing, and is red for the same reason check-no-owner-data refuses a missing
   summary: an exit code with no measurement behind it is not a pass. */
function runSuite(suite, cwd) {
  const result = spawnSync(process.execPath, ["--test", suite], {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) refuse(`the owed suite ${suite} could not be started: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failing = /^# fail (\d+)$/m.exec(output);
  const passing = /^# pass (\d+)$/m.exec(output);
  /* WHICH tests failed, not how many. Counts cannot tell "the same red as
     before" from "that red plus a new one", and the comparison below turns on
     exactly that difference. TAP names them on `not ok N - <name>` lines. */
  const failures = new Set(
    [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(([, name]) => name.trim()),
  );
  if (!failing) return { passed: false, failures, why: `exit ${result.status}, no test summary printed` };
  if (result.status !== 0) return { passed: false, failures, why: `exit ${result.status}, ${failing[1]} failing` };
  return { passed: true, failures, passing: passing ? passing[1] : "?" };
}

/* THE BASE IS RECONSTRUCTED IN PLACE, AND A THROWAWAY CHECKOUT IS NOT GOOD
 * ENOUGH. MEASURED 2026-09-18 while building this gate.
 *
 * The first version of this step made a detached worktree at the base, linked
 * node_modules/capability/private into it, and ran the failing suite there. On
 * a deliberately planted break it answered "pre-existing at <base>, not caused
 * by this landing" -- and that was wrong. tools/test/check-dist-current.test.mjs
 * passes 14/14 in a real checkout and fails 7 in a fresh throwaway worktree,
 * because it performs real git operations against the checkout it runs in. The
 * suite was red at the base for reasons that had nothing to do with the base,
 * so a break this landing really did cause was absolved and waved through.
 *
 * That error runs in the DANGEROUS direction -- it is the very miss this gate
 * exists to stop, reintroduced by the mechanism meant to soften it. A gate that
 * can be wrong must be wrong towards refusing.
 *
 * So the environment is held fixed and only the landing's own diff is varied:
 * the touched files are checked out at the base INTO THIS WORKTREE, the suite is
 * re-run in the same place it just ran, and the files are restored in a finally.
 * Same node_modules, same capability layer, same checkout; the only difference
 * between the two runs is the diff being judged.
 *
 * A file the landing ADDED has no base version, and reconstructing the base
 * would mean deleting it. That is refused rather than done silently: deleting a
 * lander's new file in order to score their landing is not a trade this should
 * make on its own. */
function withBaseContent(base, touched, run) {
  // stderr is swallowed on purpose: "does this path exist at the base" is a
  // QUESTION here, and git answers a no with a fatal: line that is not an error
  // anyone needs to read.
  const existsAtBase = file => {
    const probe = spawnSync("git", ["cat-file", "-e", `${base}:${file}`], {
      cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
    });
    return probe.status === 0;
  };
  const present = touched.filter(existsAtBase);
  const added = touched.filter(file => !present.includes(file));
  if (added.length) {
    refuse(
      `this landing adds ${added.length === 1 ? "a file that has" : "files that have"} no version at ` +
        `${base.slice(0, 8)} (${added.join(", ")}), so the base cannot be reconstructed in place without deleting ` +
        `${added.length === 1 ? "it" : "them"}. Judge the failing suite by hand, or land the addition on its own.`,
    );
  }
  git(["checkout", base, "--", ...present]);
  try {
    return run();
  } finally {
    // Back to exactly what the lander had.
    git(["checkout", "HEAD", "--", ...present]);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { base, how } = resolveBase(argv);
  const touched = touchedFiles(base);
  console.log(`Touched-file suite gate: comparing HEAD against ${base.slice(0, 8)} — ${how}.`);
  console.log(`${touched.length} file(s) changed.`);
  if (touched.length === 0) {
    console.log("Touched-file suite gate: clean. Nothing changed, so no suite is owed.");
    return;
  }

  const touchedSet = new Set(touched);
  const owed = new Map();
  for (const suite of everySuite()) {
    // A changed suite owes itself; there is no sense in landing an edited pin
    // without running it.
    const reasons = touchedSet.has(suite) ? ["it was itself changed"] : [];
    for (const file of filesReadBy(suite)) if (touchedSet.has(file)) reasons.push(`it reads ${file}`);
    if (reasons.length) owed.set(suite, reasons);
  }

  if (owed.size === 0) {
    console.log("Touched-file suite gate: clean. No suite reads any changed file.");
    return;
  }
  console.log(`${owed.size} suite(s) owed by this landing:`);
  for (const [suite, reasons] of owed) console.log(`  ${suite} — ${reasons.join("; ")}`);

  if (argv.includes("--run")) {
    /* Running them here is the stronger form: a receipt can go stale, an
       execution cannot. Each suite's own exit code is the verdict, and a red is
       named with the suite that produced it rather than collapsed into "tests
       failed". spawnSync, because a non-zero exit is an ANSWER here and
       execFileSync would throw it as an exception. */
    const red = [];
    for (const suite of owed.keys()) {
      const verdict = runSuite(suite, REPO_ROOT);
      if (verdict.passed) console.log(`  ok  ${suite} — ${verdict.passing} passing`);
      else {
        red.push({ suite, failures: verdict.failures });
        console.error(`  RED ${suite} — ${verdict.why}`);
      }
    }
    if (red.length === 0) {
      console.log(`Touched-file suite gate: clean. All ${owed.size} owed suite(s) ran and passed.`);
      return;
    }

    /* JUDGE NEW BREAKAGE, REPORT OLD BREAKAGE.
     *
     * Refusing a lander for debt they did not create is how a gate gets
     * disabled -- the same reasoning that keeps this out of `npm test`. But a
     * pre-existing red must not go invisible either; that invisibility is what
     * created this gate. So a red at the tip is re-run AT THE BASE, and only a
     * suite that passed there and fails here is this landing's to answer.
     *
     * Affordable because this step runs only the FAILURES -- normally zero or
     * one -- never the whole owed set again.
     *
     * COMPARED BY FAILING TEST NAME, NOT BY PASS/FAIL, and that is not
     * fastidiousness. MEASURED 2026-09-18: reconstructing the base makes this
     * worktree dirty for the length of the comparison, and a suite that does
     * real git operations against its own checkout fails during it for that
     * reason alone. tools/test/check-dist-current.test.mjs failed 7 at the base
     * and 8 at the tip with a break planted -- "both red" would have absolved a
     * break this landing really did cause, which is the dangerous direction.
     * The 8th failing NAME was not in the base's 7, and that difference is the
     * signal. A red at both ends with no new name is inherited; a red carrying
     * a name the base did not have is this landing's, however red the base
     * already was. */
    console.log("");
    console.log(`Re-running ${red.length === 1 ? "the 1 failure" : `the ${red.length} failures`} at the base to tell new breakage from old…`);
    const caused = [];
    const inherited = [];
    withBaseContent(base, touched, () => {
      for (const { suite, failures } of red) {
        const atBase = runSuite(suite, REPO_ROOT);
        const fresh = [...failures].filter(name => !atBase.failures.has(name));
        if (fresh.length) caused.push({ suite, fresh });
        else inherited.push({ suite, why: atBase.passed ? "passes at base but the tip red named nothing new" : atBase.why });
      }
    });

    for (const { suite, why } of inherited) {
      console.log(`  pre-existing at ${base.slice(0, 8)}, not caused by this landing, still unowned: ${suite} (${why})`);
    }
    if (caused.length === 0) {
      console.log("");
      console.log(
        `Touched-file suite gate: clean of NEW breakage. ${inherited.length} owed suite(s) were already failing at ` +
          `${base.slice(0, 8)} and are reported above rather than charged to this landing.`,
      );
      return;
    }
    console.error("");
    console.error(
      `Touched-file suite gate REFUSED: ${caused.length === 1 ? "1 suite fails" : `${caused.length} suites fail`} here ` +
        `with ${caused.length === 1 ? "a test" : "tests"} that ${caused.length === 1 ? "was" : "were"} not failing at ` +
        `${base.slice(0, 8)}. This landing broke ${caused.length === 1 ? "it" : "them"}:`,
    );
    for (const { suite, fresh } of caused) {
      console.error(`  ${suite} — ${owed.get(suite).join("; ")}`);
      for (const name of fresh) console.error(`    newly failing: ${name}`);
    }
    process.exit(1);
  }

  const flagged = argv.indexOf("--ran");
  if (flagged === -1) {
    refuse(
      "neither --run nor --ran <file> was given, so this gate cannot tell whether the owed suites above were run. " +
        "Pass --run to execute them now, or --ran with the list the landing's own test run produced.",
    );
  }
  const listFile = argv[flagged + 1];
  if (!listFile) refuse("--ran was given with no file after it.");
  if (!existsSync(listFile)) refuse(`the run list does not exist: ${listFile}`);
  const ran = new Set(
    readFileSync(listFile, "utf8").split(/\r?\n/)
      .map(line => line.trim().replace(/\\/g, "/"))
      .filter(Boolean)
      .map(line => (line.startsWith("tools/test/") ? line : `tools/test/${path.basename(line)}`)),
  );
  const missing = [...owed.keys()].filter(suite => !ran.has(suite));
  if (missing.length) {
    console.error("");
    console.error(
      `Touched-file suite gate REFUSED: ${missing.length === 1
        ? "1 suite is owed by the files this landing changed and was not run:"
        : `${missing.length} suites are owed by the files this landing changed and were not run:`}`,
    );
    for (const suite of missing) console.error(`  ${suite} — ${owed.get(suite).join("; ")}`);
    console.error("Run them and land their result, or say in the commit why the landing does not owe them.");
    process.exit(1);
  }
  console.log(`Touched-file suite gate: clean. All ${owed.size} owed suite(s) appear in ${listFile}.`);
}

main();
