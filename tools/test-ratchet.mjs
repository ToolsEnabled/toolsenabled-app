#!/usr/bin/env node

// Verification over the discovered test suite. `npm run verify` compares a
// development measurement with the reviewed failure baseline. Release uses
// `npm run verify:release` / --strict and accepts no failures or baseline. Its
// named required controls must execute; other platform/optional skips remain
// separate from passes and do not mean the entire product has been exercised.
//
// So this ratchets against a committed baseline of failures BY NAME:
//   - a failure NOT in the baseline is a regression         -> block
//   - a baselined failure that now passes is an improvement -> block, and
//     say "lower the baseline", because a ratchet that silently absorbs
//     improvement stops ratcheting inside a month
//   - anything else                                          -> pass
//
// By NAME and not by count, deliberately: a count alone lets a newly broken
// test hide behind a newly fixed one.
//
// It also refuses to report success when it did not actually measure
// anything. `node --test` EXITS 0 WHEN ITS GLOB MATCHES NO FILES (verified:
// `node --test tools/test/*.nosuchpattern.mjs` -> exit 0), so the discovering
// runner can silently become a no-op. tools/check-suites-discovered.mjs is
// the guard for that and it runs as the first half of `npm test`, which is
// why this spawns `npm test` rather than `npm run test:data` -- going
// straight to the runner would skip the guard. The zero-tests check below is
// a second, independent line of defence at the measurement layer, not a
// reimplementation of that guard. Every "measured nothing" path exits 2,
// never 0.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NIGHTLY_ENVIRONMENT_VARIABLE, validateSuiteResult } from "./lib/test-suite-result.mjs";
import { checkNodeVersion } from "./check-node-version.mjs";
export { validateSuiteResult } from "./lib/test-suite-result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BASELINE_PATH = path.join(HERE, "test-baseline.json");

// THE TREE MUST NOT MOVE UNDER THE MEASUREMENT.
//
// Measured 2026-08-11 (R1526), and it is why this exists: a `--update` run in
// a detached worktree reported 17 failures five minutes after the identical
// command reported 0, and wrote all 17 into the baseline as accepted known
// failures. Nothing had changed in the code. Another process on the machine
// had moved `capability/` out of the tree while the suite was running, so
// seventeen tests died on ENOENT reading a payload that had been there when
// the run started.
//
// That is the worst thing this gate can do. A regression it misses is a bug
// that ships; a baseline it RAISES on environmental noise is a permanent,
// signed-off licence for real failures to hide behind, and it looks exactly
// like a deliberate human decision afterwards.
//
// tools/check-test-inputs.mjs already refuses an incomplete checkout at the
// START of `npm test` -- but a check at the start cannot see a directory
// removed at second sixty. So the inputs are fingerprinted before and after,
// and a reading taken across a change is refused outright rather than ruled
// on. Same doctrine this file already applies to its own disagreeing counts:
// refuse to rule on a reading it cannot trust.
//
// dist/ is on this list even though it is OPTIONAL to the suite, and that is
// the point: its absence is handled by an honest skip, so moving it mid-run
// silently changes the skip count rather than the failure count. Measured in
// the same session -- two sequential runs of an unchanged tree reported 3
// skips and then 2, because something moved dist/ between them. A reading
// whose skip count is not reproducible is not reproducible.
const MEASUREMENT_INPUTS = [
  path.join(REPO_ROOT, "capability"),
  path.join(REPO_ROOT, "dist"),
  path.join(REPO_ROOT, "private", "capability-source.owner.json"),
  path.join(REPO_ROOT, "private", "owner-data-patterns.owner.json"),
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "shell"),
  path.join(REPO_ROOT, "tools"),
  path.join(REPO_ROOT, "config"),
  path.join(REPO_ROOT, "public"),
  path.join(REPO_ROOT, "docs"),
  path.join(REPO_ROOT, "index.html"),
  path.join(REPO_ROOT, "package.json"),
  path.join(REPO_ROOT, "package-lock.json"),
  path.join(REPO_ROOT, "vite.config.js"),
  path.join(REPO_ROOT, "vite.config.mjs"),
];

function inputDigest(target) {
  const hash = createHash("sha256");
  function visit(candidate, relative) {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) throw new Error(`cannot fingerprint linked test input: ${candidate}`);
    if (stats.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory"]));
      const entries = readdirSync(candidate).sort();
      for (const entry of entries) {
        // Dependency trees and Git internals are not test/source snapshots.
        // The selected package manifest and lockfile ARE hashed above. Avoid
        // following even a linked node_modules directory while measuring.
        if (entry === "node_modules" || entry === ".git") continue;
        visit(path.join(candidate, entry), `${relative}/${entry}`);
      }
    } else if (stats.isFile()) {
      const bytes = readFileSync(candidate);
      hash.update(JSON.stringify([relative, "file", bytes.length]));
      hash.update(bytes);
    } else {
      throw new Error(`unsupported test input: ${candidate}`);
    }
  }
  visit(target, "");
  return hash.digest("hex");
}

function fingerprintInputs() {
  const fingerprint = {};
  for (const target of MEASUREMENT_INPUTS) {
    const key = path.relative(REPO_ROOT, target).split(path.sep).join("/");
    try {
      lstatSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fingerprint[key] = "absent";
      continue;
    }
    fingerprint[key] = inputDigest(target);
  }
  return fingerprint;
}

function describeFingerprintDrift(before, after) {
  return Object.keys(before)
    .filter((key) => before[key] !== after[key])
    .map((key) => `  ${key}: ${before[key]} -> ${after[key]}`);
}

// Single source of truth for what the suite IS lives in package.json's
// `test` script. This spawns that entry point rather than restating the
// glob, so the runner and the gate can never drift apart -- and so the
// discovery guard wired into `test` runs here too.
const SUITE_COMMAND = "npm test";

// WHERE THE DEPENDENCIES CAME FROM, IN THE SAME OUTPUT AS THE COUNTS.
//
// This repository's parallel-work layout gives each worktree a `node_modules`
// junction into one shared store, and several suites put their scratch under
// `<repo>/node_modules/.toolsenabled-*`. In a worktree that has NO
// node_modules and is relying on Node's walk-up instead, the first suite to
// create that scratch directory creates a real, otherwise-empty node_modules
// at the repository root -- which ENDS the walk-up for every module resolved
// after it. MEASURED 2026-09-07 at 4ba0ceac: the run's own environment doctor
// then reported "node_modules exists but is EMPTY", "missing 12 DECLARED
// dependencies" and "289 package(s) the lockfile pins are absent", and an
// unrelated suite died on "Cannot find package 'rollup'". None of it was a
// code defect, and the failures appear only in the suites that happen to sort
// after the one that made the directory -- so the same commit measures
// differently depending on file order.
//
// A resolution that can change halfway through a run has to be stated with
// the counts, not assumed, or the counts do not reproduce anywhere else.
function describeResolvedDependencies() {
  let directory = REPO_ROOT;
  for (;;) {
    const candidate = path.join(directory, "node_modules");
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return "NO node_modules found by walk-up from the repository root";
      directory = parent;
      continue;
    }
    const link = stats.isSymbolicLink() ? "junction/symlink" : "real directory";
    let entries;
    try {
      entries = readdirSync(candidate).length;
    } catch (error) {
      return `${candidate} (${link}) could not be read: ${error.code ?? error.message}`;
    }
    const where = candidate === path.join(REPO_ROOT, "node_modules") ? "repository root" : "walk-up";
    return `${candidate} (${link}, ${where}, ${entries} entries)`;
  }
}

const EXIT_PASS = 0;
const EXIT_RATCHET = 1;
const EXIT_BROKEN_MEASUREMENT = 2;

async function runSuite() {
  // Write diagnostics as they arrive. A killed ratchet or interrupted machine
  // must leave the last observed output, not lose an hour of data held in RAM.
  const evidenceRoot = process.env.TOOLSENABLED_TEST_EVIDENCE_ROOT || os.tmpdir();
  if (!path.isAbsolute(evidenceRoot)) throw new Error("TOOLSENABLED_TEST_EVIDENCE_ROOT must be absolute");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(evidenceRoot, "toolsenabled-test-output-"));
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ schemaVersion: 1, phase: "running",
    cwd: REPO_ROOT, command: SUITE_COMMAND, startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  const stdoutFd = openSync(path.join(directory, "stdout.log"), "wx", 0o600);
  const stderrFd = openSync(path.join(directory, "stderr.log"), "wx", 0o600);
  const append = (fd, bytes) => {
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  };
  console.log(`Raw suite output retained at ${directory}`);
  return new Promise((resolve, reject) => {
    // Piped (not a TTY) so `node --test` emits TAP, which is what we parse.
    const child = spawn(SUITE_COMMAND, {
      cwd: REPO_ROOT,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => {
      append(stdoutFd, chunk);
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      append(stderrFd, chunk);
      stderrChunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      const stdoutBytes = Buffer.concat(stdoutChunks);
      const stderrBytes = Buffer.concat(stderrChunks);
      resolve({ code, signal, directory, stdoutBytes, stderrBytes,
        stdout: stdoutBytes.toString("utf8"), stderr: stderrBytes.toString("utf8") });
    });
  });
}

async function retainSuiteOutput(result) {
  // A refused tree or malformed TAP cannot justify throwing away its failure
  // details. Keep exact private bytes before either check decides the verdict.
  // Cut scratch is deleted on both success and failure. Preserve the complete
  // diagnostics in the packet's private evidence directory when one is named.
  const { directory } = result;
  const describe = (bytes) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const record = { schemaVersion: 1, phase: "completed", cwd: REPO_ROOT, command: SUITE_COMMAND,
    exitCode: result.code, signal: result.signal, capturedAt: new Date().toISOString(),
    stdout: describe(result.stdoutBytes), stderr: describe(result.stderrBytes) };
  const complete = path.join(directory, "run-completed.tmp");
  await writeFile(complete, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(complete, path.join(directory, "run.json"));
}

async function readBaseline() {
  const raw = await readFile(BASELINE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.knownFailures)) {
    throw new Error(`${BASELINE_PATH} has no knownFailures array`);
  }
  return parsed;
}

async function writeBaseline(baseline, failures, notesByName) {
  const next = {
    ...baseline,
    knownFailures: failures
      .slice()
      .sort()
      .map((name) => ({ name, note: notesByName.get(name) ?? "" })),
    updated: new Date().toISOString(),
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function report(label, names, notesByName) {
  console.log(`\n${label}`);
  for (const name of names) {
    console.log(`  - ${name}`);
    const note = notesByName.get(name);
    if (note) console.log(`      note: ${note}`);
  }
}

async function main() {
  for (const argument of process.argv.slice(2)) {
    if (!["--update", "--strict"].includes(argument)) throw new Error(`unknown argument: ${argument}`);
  }
  const update = process.argv.includes("--update");
  const strict = process.argv.includes("--strict");
  if (strict && update) throw new Error("--strict cannot update or accept a failure baseline");

  // The node that runs the suites is the node that produced the counts, so a
  // PATH that hands out a different node than the one package.json pins is a
  // broken measurement, not a red product: T309 (2026-09-18) traced two false
  // reds to exactly that. Refuse by name before anything is measured, and the
  // baseline stays untouched. The same check heads the test scripts themselves
  // (tools/check-node-version.mjs), so a bare `npm test` refuses too; this
  // copy is what stops the ratchet from recording that refusal as a failure.
  try {
    checkNodeVersion();
  } catch (error) {
    console.error(`
${error.message}
Nothing has been measured and the baseline has NOT been touched.`);
    return EXIT_BROKEN_MEASUREMENT;
  }

  const baseline = strict ? { knownFailures: [] } : await readBaseline();
  const notesByName = new Map(
    baseline.knownFailures.map((entry) => [entry.name, entry.note ?? ""]),
  );

  // A RELEASE MEASUREMENT MUST SAY WHERE IT WROTE.
  //
  // Every shell on a machine that runs this product inherits
  // TOOLSENABLED_STATE_ROOT pointing at the LIVE state, and the suite starts
  // real sessions and writes real ledger rows. An unpinned strict run is
  // therefore not just an untrustworthy reading -- it edits the running
  // installation's own records to take it. Refuse rather than do that, and
  // name the variable and the fix, the way every other gate here does.
  if (strict && !process.env.TOOLSENABLED_STATE_ROOT) {
    console.error(
      "\nTOOLSENABLED_STATE_ROOT is not set, so a strict run would write this machine's LIVE state\n" +
        "while measuring it. Point it (and MC_TEST_STATE_ROOT, TEMP and TMP) at a scratch directory\n" +
        "used by nothing else, then run this again. Nothing has been measured and the baseline has\n" +
        "NOT been touched.",
    );
    return EXIT_BROKEN_MEASUREMENT;
  }
  // AND A SET VARIABLE IS NOT A SCRATCH VARIABLE. The shell of every agent
  // circle on such a machine, and every host.exec child, arrives with
  // TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH already pointing INTO
  // the running installation's private profile, so the check above passed
  // for exactly the run it was written to refuse (measured 2026-09-10: a
  // measurement engine started from an agent shell wrote four real audit
  // entries into the LIVE ledger). What tells a scratch root from an
  // inherited one is the pair the repo's own launchers always write
  // together -- tools/test-strict.mjs and the release packager set
  // MC_TEST_STATE_ROOT to the same directory -- and a vault path that lives
  // inside it. Refuse anything else, and name the fix.
  if (strict) {
    const stateRoot = path.resolve(process.env.TOOLSENABLED_STATE_ROOT);
    const testStateRoot = process.env.MC_TEST_STATE_ROOT ? path.resolve(process.env.MC_TEST_STATE_ROOT) : "";
    const vaultPath = process.env.TOOLSENABLED_VAULT_PATH ? path.resolve(process.env.TOOLSENABLED_VAULT_PATH) : "";
    const inside = (file, root) => {
      const relative = path.relative(root, file);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    const problem = !testStateRoot
      ? "MC_TEST_STATE_ROOT is not set"
      : testStateRoot !== stateRoot
        ? "MC_TEST_STATE_ROOT and TOOLSENABLED_STATE_ROOT name different directories"
        : vaultPath && !inside(vaultPath, stateRoot)
          ? "TOOLSENABLED_VAULT_PATH points outside TOOLSENABLED_STATE_ROOT"
          : "";
    if (problem) {
      console.error(
        `\n${problem}, so TOOLSENABLED_STATE_ROOT looks inherited from a running installation rather than\n` +
          "chosen for this measurement, and a strict run would write that installation's own state and\n" +
          "vault while measuring it. Set TOOLSENABLED_STATE_ROOT and MC_TEST_STATE_ROOT to one scratch\n" +
          "directory used by nothing else, keep TOOLSENABLED_VAULT_PATH unset or inside it (with TEMP,\n" +
          "TMP and TMPDIR also in scratch), then run this again. Nothing has been measured and the\n" +
          "baseline has NOT been touched.",
      );
      return EXIT_BROKEN_MEASUREMENT;
    }
  }

  // The counts below get quoted in reports and briefs, where they outlive the
  // shell that produced them. Print what decided them in the same output.
  console.log(`Dependency resolution: ${describeResolvedDependencies()}.`);
  console.log(
    "Measurement environment: " +
      `node ${process.version} at ${process.execPath}; ` +
      `TOOLSENABLED_STATE_ROOT=${process.env.TOOLSENABLED_STATE_ROOT ?? "(unset)"}; ` +
      `MC_TEST_STATE_ROOT=${process.env.MC_TEST_STATE_ROOT ?? "(unset)"}; ` +
      `TOOLSENABLED_VAULT_PATH=${process.env.TOOLSENABLED_VAULT_PATH ? "(set, inside the state root)" : "(unset)"}; ` +
      `MC_CANONICAL_ROOT=${process.env.MC_CANONICAL_ROOT ?? "(unset)"}; ` +
      `TOOLSENABLED_TEST_STRICT=${process.env.TOOLSENABLED_TEST_STRICT ?? "(unset)"}; ` +
      `${NIGHTLY_ENVIRONMENT_VARIABLE}=${process.env[NIGHTLY_ENVIRONMENT_VARIABLE] ?? "(unset)"}.`,
  );

  console.log(`Test ratchet: running \`${SUITE_COMMAND}\` ...`);
  const inputsBefore = fingerprintInputs();
  const suite = await runSuite();
  await retainSuiteOutput(suite);
  const { code, signal, stdout, stderr } = suite;
  const inputsAfter = fingerprintInputs();

  // --- measurement integrity, before any verdict -------------------------

  // The tree first, because everything below is a reading OF the tree. A run
  // whose inputs moved underneath it is not a weaker measurement, it is not a
  // measurement -- and `--update` would carve the resulting noise into the
  // baseline permanently. See MEASUREMENT_INPUTS above for the run this cost.
  const drift = describeFingerprintDrift(inputsBefore, inputsAfter);
  if (drift.length > 0) {
    throw new Error(
      "the tree changed while the suite was running, so this reading is not a " +
        "measurement of the code:\n" +
        `${drift.join("\n")}\n` +
        "Nothing has been ruled on and the baseline has NOT been touched. " +
        "Find out what else is writing to this checkout -- another test run, a " +
        "build, or another session -- and re-measure in a tree only you are using.",
    );
  }

  let measurement;
  try {
    measurement = validateSuiteResult({ code, signal, stdout, stage: strict ? "release" : "development" });
  } catch (error) {
    const detail = (stderr.trim() || stdout.trim()).slice(-2000);
    if (detail) console.error(`\n--- runner output (tail) ---\n${detail}`);
    throw new Error(`${error.message} (child exit ${code}, signal ${signal || "none"}). The baseline has NOT been touched.`);
  }
  const { failures, counts } = measurement;

  console.log(
    `Ran ${counts.tests} tests: ${counts.pass} pass, ${counts.fail} fail, ` +
      `${counts.skipped} skipped (${failures.length} failing top-level test(s), suite exit ${code}).`,
  );

  // UNEXECUTED, always, at every stage. `# skipped` is a count of tests that
  // did not run; printing it beside `# pass` without naming them lets a reader
  // add the two together, which is the mistake this block exists to prevent.
  console.log(`UNEXECUTED (skipped) tests: ${measurement.skips.unexecuted.length}.`);

  if (strict) {
    if (counts.fail > 0) {
      report("STRICT VERIFICATION FAILED -- all test failures block release:", failures, notesByName);
      return EXIT_RATCHET;
    }

    // A skip nobody named is a hole. See RELEASE_SKIP_REGISTER in
    // tools/lib/test-suite-result.mjs for why this is by name and not by count.
    if (measurement.skips.unnamed.length > 0) {
      console.log(
        `\nSTRICT VERIFICATION FAILED -- ${measurement.skips.unnamed.length} test(s) did not execute and are ` +
          "not named in RELEASE_SKIP_REGISTER:",
      );
      for (const name of measurement.skips.unnamed) console.log(`  - ${name}`);
      console.log(
        "\nThese were SKIPPED, not passed, so this run did not measure them. The usual cause is a\n" +
          "derived input that is present but incomplete -- a capability/ directory that exists, so\n" +
          "tools/check-test-inputs.mjs admits it, but is missing the files the payload guards read.\n" +
          "Restage it with `npm run pack:capability` and run again. If a skip is genuinely intended,\n" +
          "add it to RELEASE_SKIP_REGISTER with its class and its reason so it is counted every time.",
      );
      return EXIT_RATCHET;
    }

    if (measurement.skips.retired.length > 0) {
      console.log(
        `\nSTRICT VERIFICATION FAILED -- ${measurement.skips.retired.length} RELEASE_SKIP_REGISTER entr(ies) ` +
          "name a test that now EXECUTES:",
      );
      for (const entry of measurement.skips.retired) console.log(`  - ${entry.id}: ${entry.name}`);
      console.log(
        "\nGood news, but the register must come down or it stops meaning anything. Delete those\n" +
          "entries and commit the shorter register so someone sees the debt close.",
      );
      return EXIT_RATCHET;
    }

    const byClass = new Map();
    for (const entry of measurement.skips.named) {
      byClass.set(entry.class, (byClass.get(entry.class) ?? 0) + 1);
    }
    if (measurement.skips.named.length > 0) {
      console.log(
        `\nSKIPPED BY NAME -- ${measurement.skips.named.length} test(s) did not execute, each named in ` +
          `RELEASE_SKIP_REGISTER (${[...byClass].map(([kind, count]) => `${kind}=${count}`).join(", ")}):`,
      );
      for (const entry of measurement.skips.named) {
        console.log(`  - [${entry.class}] ${entry.name}`);
        console.log(`      ${entry.id}: ${entry.reason}`);
      }
      console.log(
        `\nRun the nightly ones with ${NIGHTLY_ENVIRONMENT_VARIABLE}=1. They are unexecuted coverage in ` +
          "this run and are reported as such, never as passes.",
      );
    }

    console.log(
      `\nStrict verification OK: ${counts.pass} passed, no failures; no failure baseline was accepted; ` +
        `${measurement.requiredControls.length} required control(s) passed; ` +
        `${measurement.skips.named.length} test(s) unexecuted and named, 0 unexecuted and unnamed.`,
    );
    return EXIT_PASS;
  }

  // --- the ratchet -------------------------------------------------------

  const expected = new Set(baseline.knownFailures.map((entry) => entry.name));
  const actual = new Set(failures);
  const regressions = [...actual].filter((name) => !expected.has(name)).sort();
  const improvements = [...expected].filter((name) => !actual.has(name)).sort();

  // --update lowers a reviewed failure set. It must never bless a regression,
  // including a new failure replacing a fixed one at the same total count.
  if (update && regressions.length === 0) {
    await writeBaseline(baseline, failures, notesByName);
    console.log(
      `\nBaseline UPDATED: ${failures.length} known failure(s) written to ` +
        `${path.relative(REPO_ROOT, BASELINE_PATH)}.`,
    );
    console.log("Commit that file so the change is visible in review.");
    return EXIT_PASS;
  }

  if (regressions.length === 0 && improvements.length === 0) {
    console.log(
      `\nRatchet OK: all ${failures.length} failure(s) are known, and none ` +
        "were fixed without the baseline coming down.",
    );
    return EXIT_PASS;
  }

  if (regressions.length > 0) {
    report(
      `REGRESSION -- ${regressions.length} failure(s) NOT in the baseline:`,
      regressions,
      notesByName,
    );
    console.log(
      "\nThese are new, and they block the ship path. Fix them and measure again. " +
        "--update only removes resolved failures; it cannot add or replace failures. " +
        "The reviewed baseline has NOT been touched.",
    );
  }

  if (improvements.length > 0) {
    report(
      `FIXED -- ${improvements.length} baselined failure(s) now pass:`,
      improvements,
      notesByName,
    );
    console.log(
      "\nGood news, but the baseline must come down or the ratchet stops " +
        "ratcheting. Run `node tools/test-ratchet.mjs --update` and commit " +
        "the lower baseline.",
    );
    console.log(
      "If any of those carry an environment note, it may have flipped " +
        "because the environment changed rather than because anyone fixed " +
        "it. Read the note before lowering.",
    );
  }

  return EXIT_RATCHET;
}

// Node resolves an entry module through its real path. Compare that same file
// identity so an alias cannot turn the CLI into an import-only, exit-zero run.
let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch { /* an unresolved argv path is not this module */ }
}

if (isMainModule) main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`\nTest ratchet could not measure the suite: ${error.message}`);
    process.exitCode = EXIT_BROKEN_MEASUREMENT;
  });
