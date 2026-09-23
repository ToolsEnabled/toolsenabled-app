#!/usr/bin/env node
// THE ONE COMMAND THAT MEASURES THIS REPOSITORY FOR RELEASE.
//
// WHY IT EXISTS, measured 2026-09-07 at app 4ba0ceac. `npm run verify:release`
// is an honest gate, but it inherits whatever environment invoked it, and on a
// machine that runs this product that environment points at the LIVE
// installation: TOOLSENABLED_STATE_ROOT, MC_CANONICAL_ROOT and TEMP are all
// set user-wide. A release measurement taken that way writes the running
// installation's own state while reading it, and a measurement taken in a bare
// worktree -- no dependencies, no packed capability/ -- skips the product
// tests and reports a green suite. Both readings look identical to a green
// one in a report. tools/check-test-inputs.mjs already refuses the second case
// with exit 3; this command is where that refusal becomes unavoidable, because
// there is no way to run the release gate here WITHOUT passing through it.
//
// EVERY REFUSAL BELOW NAMES ITSELF AND WHAT WOULD FIX IT. A silent skip is the
// defect this repository keeps re-finding; a strict runner that quietly
// measured less than it claimed would be the same defect wearing the gate's
// own badge.
//
// It takes no path from this machine. Everything is derived from the script's
// own location or named on the command line, so the same command reproduces at
// another checkout of another commit -- which is the point: the counts it
// prints get quoted in briefs that outlive the shell that produced them, so
// the header states what decided them.
//
//   node tools/test-strict.mjs --canonical-root <engine checkout>
//                              [--deps-store <shared node_modules>]
//                              [--scratch <empty directory>]
//                              [--nightly]
//
// Exit 0 the release gate passed - 1 it refused the tree it measured - 2 no
// measurement was taken at all (a refusal below, or a broken run).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareStrictScratch } from "./lib/strict-scratch.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXIT_PASS = 0;
const EXIT_GATE_REFUSED = 1;
const EXIT_NO_MEASUREMENT = 2;

// A refusal is a named thing so it can be searched for, quoted in a report and
// told apart from a test failure by something other than tone of voice.
function refuse(name, lines) {
  process.stderr.write(`\nREFUSED ${name}\n\n${lines.join("\n")}\n\nNOTHING WAS MEASURED.\n`);
  return EXIT_NO_MEASUREMENT;
}

function parseArguments(argv) {
  const options = { canonicalRoot: null, depsStore: null, scratch: null, nightly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a directory after it`);
      index += 1;
      return path.resolve(next);
    };
    if (flag === "--canonical-root") options.canonicalRoot = value();
    else if (flag === "--deps-store") options.depsStore = value();
    else if (flag === "--scratch") options.scratch = value();
    else if (flag === "--nightly") options.nightly = true;
    else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
  }
  return options;
}

function entryCount(directory) {
  try {
    return readdirSync(directory).length;
  } catch {
    return null;
  }
}

// Node resolves `node_modules` by walking up, so "does this repository have
// dependencies" is not a question about one directory. Answer it the way Node
// does, and report WHICH directory answered -- a run resolving through a
// parent measures a different dependency set than one resolving locally, and
// nothing else in the output would say so.
function resolveDependencies(root) {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules");
    let stats = null;
    try {
      stats = lstatSync(candidate);
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      continue;
    }
    return {
      path: candidate,
      kind: stats.isSymbolicLink() ? "junction/symlink" : "real directory",
      atRepositoryRoot: candidate === path.join(root, "node_modules"),
      entries: entryCount(candidate),
    };
  }
}

function gitHead(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "(not a git checkout)";
  return result.stdout.trim();
}

// The runner owns scratch/state/temp, but it must not narrow their ancestors.
// Linux custody and durable admission reject a mutable ancestor even when all
// three owned directories are 0700. Diagnose that prerequisite before packing
// or starting the release gate; the native checks remain the final authority.
function linuxScratchAncestorProblem(directory) {
  if (process.platform !== "linux") return null;
  const uid = process.getuid();
  let current = path.parse(directory).root;
  for (const part of ["", ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      // Missing ancestors are created owner-private by prepareStrictScratch.
      if (error.code === "ENOENT") return null;
      return `${current} cannot be inspected (${error.code ?? "stat failed"}).`;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return `${current} is not a regular directory without symbolic links.`;
    }
    const mode = info.mode & 0o7777;
    const stickyRoot = info.uid === 0 && Boolean(mode & 0o1000);
    if (![0, uid].includes(info.uid) || ((mode & 0o022) && !stickyRoot)) {
      return `${current} has uid ${info.uid} and mode 0${mode.toString(8)}; Linux custody rejects this ancestor.`;
    }
  }
  return null;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    return refuse("BAD_ARGUMENTS", [error.message]);
  }

  // 1. THE CANONICAL ROOT IS STATED, NEVER INHERITED.
  //
  // This variable is set user-wide on machines that run this product, and it
  // points at the LIVE generation. Inheriting it silently pairs the app under
  // measurement with whatever engine happens to be promoted, so the same
  // command measures different things on different days without saying so.
  if (!options.canonicalRoot) {
    return refuse("NO_CANONICAL_ROOT", [
      "--canonical-root was not given, so this run would inherit MC_CANONICAL_ROOT from the",
      `environment (currently ${process.env.MC_CANONICAL_ROOT ?? "unset"}).`,
      "",
      "Pass a checkout of the engine commit this app is being measured against. The engine HEAD",
      "is printed in the header below so the pair is recoverable from the log alone.",
    ]);
  }
  if (!existsSync(path.join(options.canonicalRoot, "package.json"))) {
    return refuse("CANONICAL_ROOT_IS_NOT_A_CHECKOUT", [
      `--canonical-root ${options.canonicalRoot} has no package.json, so it is not an engine checkout.`,
      "Create a detached worktree at the engine commit you mean and point this at it.",
    ]);
  }

  const scratchParent = options.scratch ? path.dirname(options.scratch) : os.tmpdir();
  const ancestorProblem = linuxScratchAncestorProblem(scratchParent);
  if (ancestorProblem) {
    return refuse("SCRATCH_ANCESTOR_UNSAFE", [
      ancestorProblem,
      "",
      "The native vault, private account storage, and durable admission require ancestors owned by",
      "this account or root, without group/other write access (root-owned sticky temporary roots are",
      "accepted). Making only scratch/state/temp private cannot satisfy that prerequisite.",
      "",
      "Pass --scratch beneath an owned, non-writable ancestor chain, or set TMPDIR to such a",
      "directory before omitting --scratch. No ancestor permissions were changed.",
    ]);
  }

  // 2. DEPENDENCIES: PREPARED, THEN COUNTED, THEN STATED.
  //
  // `npm ci` is refused here while the application runs (see the preinstall
  // script), and the shared store is read-only to most callers, so preparation
  // means a junction into a store that already exists. Test-Path is not the
  // question -- several suites put scratch under <repo>/node_modules, so a
  // node_modules that EXISTS but holds one scratch directory is the failure
  // mode, not the success one.
  let dependencies = resolveDependencies(REPO_ROOT);
  const dependenciesLookUseful = dependencies && dependencies.entries !== null && dependencies.entries > 1;
  if (!dependenciesLookUseful && options.depsStore) {
    if (!existsSync(options.depsStore)) {
      return refuse("DEPS_STORE_ABSENT", [`--deps-store ${options.depsStore} does not exist.`]);
    }
    const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(REPO_ROOT, "node_modules"), options.depsStore], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (link.status !== 0) {
      return refuse("DEPS_JUNCTION_FAILED", [
        `could not junction ${path.join(REPO_ROOT, "node_modules")} to ${options.depsStore}:`,
        (link.stderr || link.stdout || "").trim(),
      ]);
    }
    dependencies = resolveDependencies(REPO_ROOT);
  }
  if (!dependencies || dependencies.entries === null || dependencies.entries <= 1) {
    return refuse("NO_DEPENDENCIES", [
      dependencies
        ? `the only node_modules reachable from this repository is ${dependencies.path}, which holds ` +
          `${dependencies.entries ?? "no readable"} entr(ies) -- that is scratch, not a dependency tree.`
        : "no node_modules is reachable from this repository by Node's walk-up.",
      "",
      "Pass --deps-store <shared node_modules> and this command will junction it in, or make the",
      "walk-up reach one yourself. Measuring without it does not fail honestly: suites that resolve",
      "before the first one creates its scratch directory pass, and everything after it fails with",
      "MODULE_NOT_FOUND, so the same commit scores differently depending on file order.",
    ]);
  }

  // 3. THE PAYLOAD IS STAGED, OR THIS COMMAND DOES NOT RUN.
  //
  // A capability/ that is absent makes ~28 suite files skip their product
  // tests. `npm test` begins with tools/check-test-inputs.mjs, which exits 3
  // saying "Nothing about the product has been measured" -- keep that, and
  // surface it here rather than letting a bare worktree reach the gate at all.
  // THE PACKER NEEDS TO BE TOLD WHERE THE SOURCE TREE IS. It reads
  // `--source`, then TOOLSENABLED_SOURCE, then
  // private/capability-source.owner.json -- and it does NOT read
  // MC_CANONICAL_ROOT. MEASURED 2026-09-07 by Controller 3's gate runner at
  // 2c382481, from a fresh worktree with capability/ absent: this command
  // refused correctly but could never have staged anything, because it invoked
  // the packer with no source at all and got "the capability-layer source tree
  // is not configured. None of the three was set." The first version of this
  // command never exercised the path, because the worktree it was written in
  // already carried a packed capability/ -- a staging step that has only ever
  // run where staging was unnecessary is not a staging step.
  //
  // --canonical-root already names an engine checkout, which is what the
  // capability layer is packed FROM, so it is handed over as the source by
  // both routes the packer accepts. Nothing is guessed and nothing is
  // inherited: if the caller did not name a root, this command refused long
  // before here.
  //
  // THE SOURCE IS NOT ENOUGH: the packer also refuses a source it cannot bind
  // to an exact commit -- "the capability source has no exact commit binding.
  // Set --source-ref, TOOLSENABLED_SOURCE_REF, or ... \"ref\"". MEASURED
  // 2026-09-07 by Controller 3, whose retry set TOOLSENABLED_SOURCE and still
  // exited 2 in 1s. That refusal is right: a payload packed from an unnamed
  // commit cannot be reproduced, which is the same reason this command prints
  // the engine HEAD at all. So the HEAD is resolved ONCE, here, and used both
  // to bind the packer and to fill the header -- one value, so the payload's
  // provenance and the header's claim cannot disagree.
  // AN UNRESOLVABLE HEAD IS REFUSED HERE, BY NAME, rather than left for the
  // packer to notice. Without a commit the payload cannot be bound to anything
  // reproducible and the header's "engine HEAD" line would be a placeholder
  // presented as a fact -- which is worse than stopping.
  const engineHead = gitHead(options.canonicalRoot);
  if (!/^[0-9a-f]{40}$/.test(engineHead)) {
    return refuse("CANONICAL_ROOT_HEAD_UNRESOLVED", [
      `--canonical-root ${options.canonicalRoot} has no resolvable commit (git rev-parse HEAD said`,
      `${JSON.stringify(engineHead)}).`,
      "",
      "The packed payload is bound to that commit and this command prints it as the pair's other",
      "half, so a run without one cannot be reproduced or even described. Point --canonical-root at",
      "a git checkout with a commit.",
    ]);
  }

  // THE SUITE READS THE SOURCE RECORD TOO, not only the packer.
  //
  // MEASURED 2026-09-07 in a fresh worktree, after staging finally succeeded:
  // tools/check-test-inputs.mjs still exited 3 with "1 input(s) the test suite
  // reads are absent -- MISSING private/capability-source.owner.json ... suite
  // files naming it: 13 ... 2 tests went red with this absent". So passing
  // --source to the packer is not enough; the file itself is an input.
  //
  // --canonical-root IS "the absolute path to the capability-layer source
  // checkout", which is exactly what that file records. Writing it here is not
  // inventing configuration -- it is materialising the value the caller named,
  // in a gitignored location, so the packer, the suite and this command's
  // header all read ONE source. Three consumers agreeing by construction is
  // the same rule the engine HEAD follows above.
  //
  // If a record already exists naming a DIFFERENT tree, that is not ours to
  // overwrite: the suite would measure one tree while the header claimed
  // another. Refuse and let a person decide.
  const sourceRecordPath = path.join(REPO_ROOT, "private", "capability-source.owner.json");
  const sameTree = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (existsSync(sourceRecordPath)) {
    let recorded = null;
    try {
      recorded = JSON.parse(readFileSync(sourceRecordPath, "utf8"));
    } catch (error) {
      return refuse("SOURCE_RECORD_UNREADABLE", [
        `${sourceRecordPath} could not be parsed: ${error.message}`,
        "The suite reads this file. Fix or delete it and run this again.",
      ]);
    }
    if (recorded?.path && !sameTree(recorded.path, options.canonicalRoot)) {
      return refuse("SOURCE_RECORD_DISAGREES", [
        `${sourceRecordPath} names a different capability source than --canonical-root:`,
        `  recorded        ${recorded.path}`,
        `  --canonical-root ${options.canonicalRoot}`,
        "",
        "The suite would read one tree while this command's header claimed the other, and the counts",
        "would describe neither. Point them at the same checkout, or delete the record and let this",
        "command write it, and run again.",
      ]);
    }
  } else {
    mkdirSync(path.dirname(sourceRecordPath), { recursive: true });
    const record = { path: options.canonicalRoot };
    if (/^[0-9a-f]{40}$/.test(engineHead)) record.ref = engineHead;
    writeFileSync(sourceRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Wrote ${sourceRecordPath} naming --canonical-root, because the suite reads it and ` +
        "`private/` is gitignored so a fresh worktree never carries it.\n",
    );
  }

  const capabilityRoot = path.join(REPO_ROOT, "capability");
  let capabilityEntries = entryCount(capabilityRoot);
  if (capabilityEntries === null || capabilityEntries === 0) {
    process.stdout.write(
      `No packed capability/ found; staging it from ${options.canonicalRoot} at ${engineHead} ` +
        "with tools/pack-capability-layer.mjs ...\n",
    );
    const packerArguments = [
      path.join(REPO_ROOT, "tools", "pack-capability-layer.mjs"),
      "--source",
      options.canonicalRoot,
    ];
    const packerEnvironment = { ...process.env, TOOLSENABLED_SOURCE: options.canonicalRoot };
    // Only when it is a real commit. A canonical root that is not a git
    // checkout gets no invented ref: the packer's own refusal names what is
    // missing, and that is a better answer than a fabricated binding.
    if (/^[0-9a-f]{40}$/.test(engineHead)) {
      packerArguments.push("--source-ref", engineHead);
      packerEnvironment.TOOLSENABLED_SOURCE_REF = engineHead;
    }
    const packed = spawnSync(process.execPath, packerArguments, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      windowsHide: true,
      env: packerEnvironment,
    });
    process.stdout.write(`${packed.stdout ?? ""}${packed.stderr ?? ""}`);
    capabilityEntries = entryCount(capabilityRoot);
    if (packed.status !== 0 || !capabilityEntries) {
      // "It made nothing" and "it made something it refuses to vouch for" are
      // different answers and must not be reported as one. The first version
      // of this said "absent or empty" in both cases, which was simply untrue
      // of the second: MEASURED 2026-09-07, the packer staged 387 files and
      // 8.52 MB and THEN exited 1.
      return refuse("NO_CAPABILITY_PAYLOAD", [
        capabilityEntries
          ? `tools/pack-capability-layer.mjs staged ${capabilityEntries} entr(ies) into ${capabilityRoot} and`
          : `${capabilityRoot} is absent or empty and tools/pack-capability-layer.mjs`,
        `then exited ${packed.status ?? "with no status"}. Its own output is above and says what it wants.`,
        "",
        "Without a payload it will certify, the product suites skip and the run reports a green",
        "release verification that measured almost nothing.",
      ]);
    }
  }

  // A PAYLOAD THE PACKER REFUSED TO VOUCH FOR IS NOT A PAYLOAD.
  //
  // The packer runs an owner-data guard over what it stages and, when that
  // guard cannot run, marks the result UNSHIPPABLE-OWNER-DATA.txt and exits
  // non-zero -- "Nothing was scanned, so there is no offender list and no
  // conclusion to draw." It leaves the staged files in place.
  //
  // MEASURED 2026-09-07 in a fresh worktree: that leaves `capability/` holding
  // 10 entries, so a SECOND run of this command found a non-empty directory,
  // skipped staging entirely, and would have measured a payload nobody had
  // certified. An existence check is not a certification check, and this is the
  // same shape of mistake as the skip that reads as a pass. Refuse on the
  // marker, however the directory got here.
  if (existsSync(path.join(capabilityRoot, "UNSHIPPABLE-OWNER-DATA.txt"))) {
    return refuse("CAPABILITY_UNSHIPPABLE", [
      `${capabilityRoot} carries UNSHIPPABLE-OWNER-DATA.txt, so the packer staged it but would not`,
      "vouch for it. Measuring against it would report a number about a payload that failed its own",
      "owner-data guard.",
      "",
      "The usual cause is that the guard has no identity to search for, because",
      "private/owner-data-patterns.owner.json is absent -- and `private/` is gitignored, so a FRESH",
      "worktree never has it. Copy config/owner-data-patterns.example.json to that path and fill in",
      "the values, delete the staged capability/, and run this again.",
    ]);
  }

  // 4. THE STATE ROOTS ARE OURS, NOT THIS MACHINE'S.
  //
  // The suite starts real sessions and writes real ledger rows. These are set
  // here rather than merely required, so that there is no way to reach the gate
  // through this command with the live installation's roots still in place.
  const scratch = options.scratch
    ? options.scratch
    : mkdtempSync(path.join(os.tmpdir(), "app-test-strict-"));
  // 0o700, BECAUSE THE PRODUCT REFUSES ANYTHING WIDER AND THIS COMMAND IS THE
  // ONLY WAY TO REACH THE GATE. The measurement behind that, and why the
  // decision lives in a module this file's own refusals cannot be driven
  // through, is in tools/lib/strict-scratch.mjs's header.
  const prepared = prepareStrictScratch(scratch);
  if (!prepared.ok) {
    return refuse("SCRATCH_NOT_EMPTY", [
      `--scratch ${scratch} already holds ${prepared.entries} entries, so it is not a directory this`,
      "measurement can own. It has to be private (0o700) for the product's own account-storage checks",
      "to accept the state root inside it, and narrowing a directory that belongs to something else is",
      "not this command's business.",
      "",
      "Pass an empty directory, or omit --scratch and let this command make one.",
    ]);
  }
  const scratchState = prepared.state;
  const scratchTemp = prepared.temp;

  const environment = {
    ...process.env,
    TOOLSENABLED_TEST_STRICT: "1",
    TOOLSENABLED_STATE_ROOT: scratchState,
    MC_TEST_STATE_ROOT: scratchState,
    // The vault path is the other inherited pointer. An agent shell on a
    // machine that runs this product carries TOOLSENABLED_VAULT_PATH into the
    // running installation's profile, and the engine resolves it before the
    // state root; name the scratch vault, in the layout the product uses.
    TOOLSENABLED_VAULT_PATH: path.join(scratchState, "vault", "secrets.json"),
    TEMP: scratchTemp,
    TMP: scratchTemp,
    // TEMP/TMP are what Windows reads; Node resolves os.tmpdir() from TMPDIR
    // on POSIX, so a Linux child would otherwise still write outside scratch.
    TMPDIR: scratchTemp,
    MC_CANONICAL_ROOT: options.canonicalRoot,
  };
  if (options.nightly) environment.TOOLSENABLED_NIGHTLY = "1";
  else delete environment.TOOLSENABLED_NIGHTLY;

  // 5. THE HEADER. Everything a reader needs to reproduce the counts, in the
  // same output as the counts, because a count quoted without them is a number
  // about an unknown tree.
  const header = [
    "=== app strict release measurement ===",
    `command             node tools/test-strict.mjs --canonical-root <engine checkout>${options.nightly ? " --nightly" : ""}`,
    `repository          ${REPO_ROOT}`,
    `app HEAD            ${gitHead(REPO_ROOT)}`,
    `canonical root      ${options.canonicalRoot}`,
    `engine HEAD         ${engineHead}`,
    `node                ${process.version} at ${process.execPath}`,
    `NODE_OPTIONS        ${process.env.NODE_OPTIONS ?? "(unset)"}`,
    `dependencies        ${dependencies.path} (${dependencies.kind}, ` +
      `${dependencies.atRepositoryRoot ? "repository root" : "resolved by walk-up"}, ${dependencies.entries} entries)`,
    `capability/         ${capabilityRoot} (${capabilityEntries} entries)`,
    `state roots         ${scratchState}`,
    `vault path          ${path.join(scratchState, "vault", "secrets.json")}`,
    `TEMP/TMP/TMPDIR     ${scratchTemp}`,
    `nightly suites      ${options.nightly ? "TOOLSENABLED_NIGHTLY=1 (they execute)" : "not enabled (they are unexecuted coverage, named)"}`,
    `started             ${new Date().toISOString()}`,
    "=======================================",
    "",
  ].join("\n");
  process.stdout.write(header);
  writeFileSync(path.join(scratch, "strict-header.txt"), header, "utf8");

  // 6. The release gate itself. Not reimplemented here: this runs the same
  // `verify:release` a person runs, so there is no second, quietly different
  // definition of "the tests passed".
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "verify:release"], {
    cwd: REPO_ROOT,
    env: environment,
    shell: process.platform === "win32",
    windowsHide: true,
  });

  let captured = "";
  const tee = (chunk) => {
    captured += chunk;
    process.stdout.write(chunk);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", tee);
  child.stderr.on("data", tee);

  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      // The gate prints its own counts; repeat them in one labelled block so a
      // reader quoting this run does not have to find them in 40,000 lines.
      const counts = captured.match(/^Ran (\d+) tests: (\d+) pass, (\d+) fail, (\d+) skipped/m);
      const unexecuted = captured.match(/^UNEXECUTED \(skipped\) tests: (\d+)\./m);
      const named = captured.match(/^SKIPPED BY NAME -- (\d+) test\(s\)/m);
      process.stdout.write(
        [
          "",
          "=== app strict release counts ===",
          counts
            ? `tests ${counts[1]}  pass ${counts[2]}  fail ${counts[3]}  skipped ${counts[4]}`
            : "tests (NOT REPORTED -- the gate did not reach its count line, so nothing was measured)",
          `UNEXECUTED (skipped)  ${unexecuted ? unexecuted[1] : "(not reported)"}`,
          `unexecuted and named  ${named ? named[1] : "0"}`,
          `verify:release exit   ${code ?? `signal ${signal}`}`,
          `finished              ${new Date().toISOString()}`,
          `full output           ${path.join(scratch, "strict-output.log")}`,
          "=================================",
          "",
        ].join("\n"),
      );
      writeFileSync(path.join(scratch, "strict-output.log"), captured, "utf8");
      if (code === 0) resolve(EXIT_PASS);
      else if (Number.isInteger(code)) resolve(counts ? EXIT_GATE_REFUSED : EXIT_NO_MEASUREMENT);
      else resolve(EXIT_NO_MEASUREMENT);
    });
  });
}

process.exitCode = await main();
