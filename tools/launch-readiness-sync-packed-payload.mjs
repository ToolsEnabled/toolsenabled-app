#!/usr/bin/env node

// MAKE THE PACKED CAPABILITY PAYLOAD EXACTLY THE STAGED ONE.
//
// WHY THIS EXISTS. `npm run dist` stages the payload into `capability/` and lets
// electron-builder copy it to `release/win-unpacked/resources/capability` as an
// extraResource. The staging half is a SET operation --
// tools/pack-capability-layer.mjs empties its out directory child by child before
// writing -- so `capability/` always equals the closure. The packed half is not.
// Measured in node_modules/app-builder-lib/out/electron/ElectronFramework.js:
// the default unpack path is `extractArchive(zipPath, appOutDir)` with no
// emptyDir; emptyDir runs only on the custom-electronDist branch, and
// cleanupAfterUnpack unlinks exactly two names (`default_app.asar`, `version`).
// Nothing ever removes a file from that directory. extraResources are copied ON
// TOP of whatever is already there.
//
// So the packed payload is the UNION of every payload ever built in this tree.
// A file the owner has ruled `excluded` and that has been removed from the
// closure survives every subsequent build, forever, on this machine. That is
// how src/lib/cerberus-correction-loop.js -- excluded on 2026-08-11, require()
// edge removed, five SQLite tables dropped -- was still sitting in the shipped
// payload hours later while the staged payload was clean.
//
// WHY THIS IS A SYNC AND NOT A PRUNE. The obvious tool deletes the stale files
// and stops. That tool is dangerous, and I know because I wrote the delete by
// hand first and it broke the product: the packed
// src/lib/state-store.js of an older build still carried
// `require('./cerberus-correction-loop')`, so removing the file alone left an
// artifact that could no longer open its own state store.
// `node tools/recommended-path-packaged-qa.mjs` went from 21/21 to exit 1 with
// "timed out waiting for a running session".
//
// A payload is a require() closure. Its files are only consistent as a SET.
// Half-updating one is worse than leaving it stale, so this tool refuses to do
// anything by halves: every stale file is removed AND every staged file is
// written, in one pass, and the result is asserted byte-identical to the staged
// payload before it reports success. There is no --prune-only flag, because the
// one thing that must never be possible here is removing a dependency without
// replacing the module that depended on it.
//
// WHERE IT GOES IN THE CHAIN: BEFORE electron-builder. This paragraph used to
// say AFTER, and following it would ship a stale .exe.
//
// The reason is that ONE `electron-builder --win nsis` invocation does both
// jobs: it materialises release/win-unpacked AND packs the installer from it.
// So by the time that command returns, the .exe has already been built out of
// whatever win-unpacked contained -- the union described above, stale files
// included. A sync that runs afterwards cleans win-unpacked and therefore
// cleans every gate that inspects win-unpacked, while the artifact a customer
// actually downloads still carries the stale payload. That is worse than not
// syncing at all, because the gates then certify a directory that is no longer
// what shipped.
//
// Running BEFORE is what works, and nothing is lost by it: this tool makes
// win-unpacked's payload equal to the staged one, and electron-builder's only
// write to that directory is copying the SAME staged payload on top as an
// extraResource. It re-introduces nothing, because there is nowhere for it to
// re-introduce anything from -- extraResources are copied from `capability/`,
// which the packer rebuilds as a set. package.json's `dist` chain has it in
// this position; keep it there.
//
// EXIT CODES
//   0  the packed payload now equals the staged payload
//   1  it does not, and this tool could not make it so
//   2  refused -- something this tool needs was absent or unusable

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STAGED = path.join(REPO_ROOT, "capability");
const DEFAULT_PACKED = path.join(REPO_ROOT, "release", "win-unpacked", "resources", "capability");

class Refusal extends Error {}

function parseArguments(argv) {
  let staged = DEFAULT_STAGED;
  let packed = DEFAULT_PACKED;
  let check = false;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      check = true;
      continue;
    }
    if (value === "--staged" || value === "--packed") {
      const next = argv[index + 1];
      if (!next) throw new Refusal(`${value} needs a path.`);
      if (value === "--staged") staged = next;
      else packed = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Refusal(`unknown flag ${value}`);
    positional.push(value);
  }
  if (positional.length > 2) throw new Refusal("expected at most <staged> <packed>.");
  if (positional[0]) staged = positional[0];
  if (positional[1]) packed = positional[1];
  return { staged: path.resolve(staged), packed: path.resolve(packed), check };
}

// ABSENCE IS A REFUSAL, NEVER A CLEAN RESULT.
//
// The failure this guards against is the one this codebase keeps finding: a
// missing thing read as an empty thing read as consent. If the staged payload
// were absent or empty, "delete every packed file that is not in the staged
// set" deletes the entire shipped payload and reports a triumphant sync. So the
// staged side must exist, be a real directory (not a symlink to one), and hold
// files, before a single byte is removed.
function readPayload(root, label) {
  if (!existsSync(root)) {
    throw new Refusal(`the ${label} payload does not exist at ${root}. Refusing: an absent payload is not an empty one.`);
  }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Refusal(`refusing to follow a symlink for the ${label} payload: ${root}`);
  if (!rootStat.isDirectory()) throw new Refusal(`the ${label} payload is not a directory: ${root}`);

  const files = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      // A symlink inside a payload is a file whose real bytes are somewhere
      // else. Copying it would ship the target under the link's name and
      // hashing it would hash the wrong thing, so it is refused rather than
      // guessed at -- the same fail-closed rule tools/check-payload-boundary.mjs
      // applies when it walks these two directories.
      if (entry.isSymbolicLink()) {
        throw new Refusal(`refusing to classify a symlink in the ${label} payload: ${path.relative(root, entryPath)}`);
      }
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.set(path.relative(root, entryPath).split(path.sep).join("/"), entryPath);
    }
  };
  walk(root);

  if (files.size === 0) {
    throw new Refusal(`the ${label} payload at ${root} holds no files. Refusing rather than treating it as the truth.`);
  }
  return files;
}

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Remove the directories a pruned file left behind, but never the root, and
// never anything that still holds something. An empty directory in the payload
// is harmless; a tool that walks upward deleting is not.
function removeEmptyParents(fromFile, root) {
  let directory = path.dirname(fromFile);
  const stop = path.resolve(root);
  while (path.resolve(directory) !== stop && path.resolve(directory).startsWith(stop + path.sep)) {
    if (readdirSync(directory).length > 0) return;
    rmSync(directory, { recursive: false, force: true });
    directory = path.dirname(directory);
  }
}

// THE FIRST BUILD IN A TREE IS NOT A STALE ARTIFACT.
//
// `npm run dist` runs this step, and `release/` is gitignored, so ANY checkout
// that has never built -- a fresh clone, and every isolated worktree
// tools/release-packager/cut-release-candidate.mjs cuts to build a release
// candidate -- reaches here with no packed payload at all. readPayload() then
// refuses with exit 2 and takes the whole ship chain down with it. Measured:
// the documented one-command release path (docs/REPRODUCIBLE-BUILD.md §1)
// cannot complete, because it builds in a `git worktree add --detach` checkout
// by design.
//
// WHY THIS IS SAFE, AND WHY IT IS NARROW. The refusal above exists because an
// absent or empty STAGED payload would make "delete every packed file not in
// the staged set" delete the entire shipped payload. That reasoning is about
// the staged side, and it still stands: `staged` is read, and proven present
// and non-empty, BEFORE this returns. An absent PACKED side carries no such
// risk -- there is nothing to prune, nothing to overwrite, and nothing to get
// wrong. electron-builder then creates it by copying the staged payload, so
// the two agree by construction.
//
// ABSENT IS NOT THE SAME AS EMPTY, and only absent is excused. A packed root
// that EXISTS but holds no files is a half-built or half-deleted artifact --
// genuinely suspicious -- and still falls through to readPayload's refusal.
// `--check` also still refuses, because --check is an assertion ABOUT an
// artifact, and an artifact that does not exist cannot satisfy one; a check
// that passes over nothing is the exact "absence read as consent" defect this
// file's own header warns about.
function firstBuildNoPackedPayload(options, staged) {
  if (options.check) return false;
  if (existsSync(options.packed)) return false;
  console.log(`staged: ${options.staged}  (${staged.size} files)`);
  console.log(`packed: ${options.packed}  (does not exist)`);
  console.log(
    "\nFIRST BUILD: there is no packed payload in this tree yet, so there is nothing to prune and\n" +
      "nothing to reconcile. The staged payload above is present and non-empty; electron-builder\n" +
      "creates the packed payload by copying it, so the two agree by construction. Nothing was\n" +
      "changed, and no file was deleted.",
  );
  return true;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const staged = readPayload(options.staged, "staged");
  if (firstBuildNoPackedPayload(options, staged)) return;
  const packed = readPayload(options.packed, "packed");

  const stale = [...packed.keys()].filter((relative) => !staged.has(relative)).sort();
  const missing = [...staged.keys()].filter((relative) => !packed.has(relative)).sort();
  const differing = [...staged.keys()]
    .filter((relative) => packed.has(relative) && digest(staged.get(relative)) !== digest(packed.get(relative)))
    .sort();

  console.log(`staged: ${options.staged}  (${staged.size} files)`);
  console.log(`packed: ${options.packed}  (${packed.size} files)`);
  console.log(`stale=${stale.length} missing=${missing.length} differing=${differing.length}`);
  for (const relative of stale) console.log(`  stale (in the artifact, not in the payload): ${relative}`);
  for (const relative of missing) console.log(`  missing (in the payload, not in the artifact): ${relative}`);
  for (const relative of differing) console.log(`  differing bytes: ${relative}`);

  if (stale.length === 0 && missing.length === 0 && differing.length === 0) {
    console.log("\nThe packed payload already equals the staged payload.");
    return;
  }

  if (options.check) {
    console.error(
      "\n--check: the packed payload does NOT equal the staged payload. " +
        "Run this tool without --check, between electron-builder and the payload-boundary gate.",
    );
    process.exitCode = 1;
    return;
  }

  // ORDER IS LOAD-BEARING: write first, delete second. If this process dies
  // halfway, an artifact carrying a superset of the payload still runs, while
  // one carrying a subset does not. The failure that costs something is the
  // missing module, so the step that could leave one missing goes last.
  for (const relative of [...missing, ...differing]) {
    const to = path.join(options.packed, relative.split("/").join(path.sep));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(staged.get(relative), to);
  }
  for (const relative of stale) {
    const from = path.join(options.packed, relative.split("/").join(path.sep));
    rmSync(from, { force: true });
    removeEmptyParents(from, options.packed);
  }

  // ASSERT THE END STATE, DO NOT ASSUME IT. Re-walk and re-hash. A count of
  // operations performed is not evidence that the two directories now agree;
  // reading them back is.
  const after = readPayload(options.packed, "packed");
  const wrong = [
    ...[...after.keys()].filter((relative) => !staged.has(relative)).map((relative) => `still present: ${relative}`),
    ...[...staged.keys()]
      .filter((relative) => !after.has(relative) || digest(staged.get(relative)) !== digest(after.get(relative)))
      .map((relative) => `not written correctly: ${relative}`),
  ];
  if (wrong.length > 0) {
    console.error(`\nSYNC FAILED -- ${wrong.length} path(s) still disagree:`);
    for (const line of wrong) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nSynchronised: removed ${stale.length}, wrote ${missing.length + differing.length}. ` +
      `The packed payload is now byte-identical to the staged payload (${after.size} files).`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`Payload sync refused: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(`Payload sync error: ${error.stack || error.message}`);
    process.exitCode = 2;
  }
}
