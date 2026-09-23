#!/usr/bin/env node

// Discovery guard for the test entry point.
//
// `node --test <glob>` exits 0 when the glob matches nothing. Measured on
// node v22.19.0 in this repo:
//
//   node --test --test-concurrency=1 tools/test/*.nosuchpattern.mjs  -> exit 0
//   node --test --test-concurrency=1 tools/nosuchdir/*.test.mjs      -> exit 0
//
// So if tools/test/ is renamed, moved, or the glob in package.json drifts,
// `npm test` goes GREEN while running zero tests. A gate that passes because
// it found nothing is worse than no gate: it reports success.
//
// This is the same rule tools/check-no-owner-data.mjs already applies to
// itself -- "nothing to check: scanned 0 files" is an error there, not a pass.
// The test runner simply never got that rule. This applies it.
//
// It deliberately does NOT hardcode an expected suite count. A hand-maintained
// number is the very defect this repo was bitten by: a hand-written list of 11
// test files stood in for a glob over 26, and self-selected coverage cannot
// fail. Instead this derives both sets and compares them:
//
//   A. what the runner's own glob (read from package.json, not duplicated
//      here) actually matches, and
//   B. every *.test.mjs file that exists in the tree.
//
// Any file in B that is not in A is a suite that exists and never runs.

import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SCRIPT = "test:data";
const SUITE_SUFFIX = ".test.mjs";
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  "artifacts",
]);

// Pull the glob(s) out of the runner command itself so this guard cannot drift
// away from what actually runs. Duplicating the pattern here would recreate
// the two-sources-of-truth problem in miniature.
function extractGlobs(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  return tokens.filter(
    (token) => !token.startsWith("-") && token.endsWith(SUITE_SUFFIX) && token.includes("*"),
  );
}

// Supports the `directory/<pattern>` shape used by this repo's runner. A glob
// shape we cannot interpret is an error, never a silent skip -- silently
// ignoring it would put us right back at "the guard passed and checked nothing".
async function matchGlob(glob) {
  const directory = path.posix.dirname(glob);
  const pattern = path.posix.basename(glob);

  if (directory.includes("*")) {
    throw new Error(
      `unsupported glob ${JSON.stringify(glob)}: this guard understands ` +
        "a wildcard in the filename only, not in the directory path",
    );
  }

  const absoluteDirectory = path.resolve(REPO_ROOT, directory);
  const relativeDirectory = path.relative(REPO_ROOT, absoluteDirectory);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    throw new Error(`runner glob is outside this repository: ${JSON.stringify(glob)}`);
  }
  let entries;
  try {
    let current = REPO_ROOT;
    for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`linked suite directory is not a local test input: ${current}`);
    }
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `the runner glob ${JSON.stringify(glob)} points at ${absoluteDirectory}, ` +
        `which cannot be read (${error.code ?? error.message}). ` +
        "node --test would exit 0 here while running nothing.",
    );
  }

  const expression = new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join(".*")}$`,
  );

  return entries
    .filter((entry) => entry.isFile() && expression.test(entry.name))
    .map((entry) => path.resolve(absoluteDirectory, entry.name));
}

async function findEverySuite(directory, found = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot discover suites in ${relative(directory)}: ${error.code || error.message}`);
  }

  // A nested checkout owns its own test entry point. Read no Git metadata and
  // do not recurse into it; ordinary directories still participate in this
  // repository's coverage check, regardless of their names.
  if (directory !== REPO_ROOT && entries.some((entry) => entry.name === ".git")) return found;

  for (const entry of entries) {
    const absolute = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await findEverySuite(absolute, found);
    } else if (entry.name.endsWith(SUITE_SUFFIX)) {
      // A linked suite must be reported, without following its target. It is
      // deliberately absent from matchGlob's regular-file selection, so the
      // guard refuses it before a runner could cross a checkout/profile fence.
      if (entry.isFile() || entry.isSymbolicLink()) found.push(absolute);
    }
  }

  return found;
}

function relative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

async function main() {
  const manifestPath = path.resolve(REPO_ROOT, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const command = manifest.scripts?.[RUNNER_SCRIPT];

  if (!command) {
    throw new Error(
      `package.json has no ${JSON.stringify(RUNNER_SCRIPT)} script, so there is ` +
        "no runner for this guard to verify",
    );
  }

  const globs = extractGlobs(command);
  if (globs.length === 0) {
    throw new Error(
      `no suite glob found in ${JSON.stringify(RUNNER_SCRIPT)}: ${JSON.stringify(command)}`,
    );
  }

  const matched = new Set();
  for (const glob of globs) {
    for (const file of await matchGlob(glob)) matched.add(file);
  }

  if (matched.size === 0) {
    throw new Error(
      `the runner glob(s) ${globs.map((g) => JSON.stringify(g)).join(", ")} match ZERO suites. ` +
        "node --test would exit 0 and report success while running no tests.",
    );
  }

  const everySuite = await findEverySuite(REPO_ROOT);
  const unreached = everySuite.filter((file) => !matched.has(file)).sort();

  console.log(
    `Suite discovery: ${matched.size} suite(s) reached by ${JSON.stringify(command)}; ` +
      `${everySuite.length} *${SUITE_SUFFIX} file(s) exist in the tree.`,
  );

  if (unreached.length > 0) {
    console.error(
      `\n${unreached.length} suite(s) exist but are NEVER RUN by ${JSON.stringify(RUNNER_SCRIPT)}:`,
    );
    for (const file of unreached) console.error(`  ${relative(file)}`);
    console.error(
      "\nEither widen the glob in package.json or move these under a path it reaches. " +
        "A suite that exists and never runs is indistinguishable from one that passes.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("Every suite in the tree is reached by the runner.");
}

main().catch((error) => {
  console.error(`Suite discovery guard error: ${error.message}`);
  process.exitCode = 2;
});
