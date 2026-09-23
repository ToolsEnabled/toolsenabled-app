#!/usr/bin/env node

// THE OWNER-DATA GUARD ONLY EVER READ BUILD OUTPUTS, SO IT ONLY EVER FAILED A CUT.
//
// tools/check-no-owner-data.mjs is run twice by `npm run dist` -- once over
// release/win-unpacked and once over release/ -- and both are AFTER electron-builder
// has packed app.asar. That is the correct last line of defence and it stays. What it
// is not is a landing gate: an assembly can carry a shipped source file with the
// owner's account names in a code comment, pass `npm test`, pass review, land, and be
// discovered only when a cutter is 18 steps into a build.
//
// MEASURED 2026-09-18, and this file exists because of it: shell/spawn-record.cjs
// landed on cut2/app-assembly-20260917 with a comment documenting a real measurement
// by quoting the owner's actual account-registry names. `npm test` was green. The
// integrated cut from that tip stopped at step 18 with two hits inside
// resources/app.asar, and the whole artifact half had to be re-run from scratch after
// the redaction. Under R1228 the cut process is the culprit when the finalized cut
// finds something: the landing had no scan over the files app.asar is built FROM.
//
// So this runs the real guard -- same private identity profile, same machine-derived
// spellings, same built-in rules, same excuse policy -- over the shipped SOURCE, and
// it runs inside `npm test`. It is a thin wrapper by design: reimplementing the
// patterns here would give the product two owner-data definitions that drift, and the
// one that fails a cut would not be the one a developer sees.
//
// WHAT "SHIPPED SOURCE" MEANS HERE is taken from package.json `build.files`
// ("dist/**", "shell/**", "config/google-signin.json"), resolved one step back to what
// a person actually edits:
//
//   shell/   ships verbatim inside app.asar -- a comment here reaches a user's disk
//            byte-for-byte. This is where the 2026-09-18 finding was.
//   src/     and
//   public/  are the inputs Vite compiles into dist/**. A bundler may drop a comment,
//            or may not; string literals survive intact. Scanning the source is the
//            only place a person can act on the hit, and the only place the hit is
//            still readable.
//   config/  contains config/google-signin.json, the third asar input. The whole
//            directory is scanned rather than that one file because the guard's roots
//            are directories; the rest of config/ is committed product configuration
//            in which no owner value belongs either. Measured clean at 3b9c32ac.
//
// dist/ itself is deliberately NOT scanned: it is a build output, absent from a clean
// checkout, and already covered by the two release-time runs.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join("tools", "check-no-owner-data.mjs");

const SHIPPED_SOURCE_ROOTS = [
  { root: "shell", reason: "ships verbatim inside app.asar (build.files: shell/**)" },
  { root: "src", reason: "compiled into dist/**, which ships inside app.asar" },
  { root: "public", reason: "copied into dist/**, which ships inside app.asar" },
  { root: "config", reason: "carries config/google-signin.json, an app.asar input" },
];

// AN EMPTY ALLOWLIST IS A MEASUREMENT, NOT AN OVERSIGHT.
//
// Measured at 3b9c32ac over 634 files / 33,578,855 bytes: "Total matches: 0." No
// shipped source file carries a fence literal, so nothing needs excusing. The four
// hits the guard did resolve were published attribution ("Joshua Pinckard" in a
// licence header), which the guard itself already excuses and which is not owner data
// in the sense this gate refuses.
//
// If a shipped source file ever legitimately needs a literal the guard refuses, add it
// here BY EXACT REPOSITORY-RELATIVE PATH with the reason. Never a directory, never a
// prefix, never a pattern -- a widened entry is how a gate stops being one. Built-in
// rules are not allowlistable at all (see below), matching the guard's own policy that
// a product fact may never be excused by attribution.
const ALLOWLIST = new Map(/* "shell/example.cjs" => "why this exact file may carry it" */);

function refuse(message) {
  console.error(`Shipped-source owner-data gate REFUSED: ${message}`);
  process.exit(2);
}

function resolveRoots() {
  const resolved = [];
  for (const { root, reason } of SHIPPED_SOURCE_ROOTS) {
    const absolute = path.join(REPO_ROOT, root);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // NAMED, NOT SKIPPED. A renamed or moved directory must stop the gate, because
        // silently scanning three of four roots is exactly the "passes because of what
        // it was not given" failure the guard's own header records.
        refuse(
          `the shipped source directory "${root}" does not exist (${reason}). ` +
            "If it moved, update SHIPPED_SOURCE_ROOTS in this file to match package.json build.files; " +
            "do not drop it.",
        );
      }
      refuse(`the shipped source directory "${root}" could not be read: ${error.message}`);
    }
    if (stats.isSymbolicLink()) refuse(`the shipped source directory "${root}" is a symlink; refusing to follow it.`);
    if (!stats.isDirectory()) refuse(`the shipped source path "${root}" is not a directory.`);
    resolved.push(root);
  }
  return resolved;
}

function parseHits(output) {
  // The guard prints one line per offending file: "<path> | pattern=<id> | matches=<n>".
  // Offsets and excerpts are indented continuation lines and are left to the guard's own
  // output, which this wrapper has already echoed.
  const hits = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?) \| pattern=([^|]+?) \| matches=(\d+)$/.exec(line);
    if (!match) continue;
    const [, filePath, patternId, count] = match;
    hits.push({
      file: path.relative(REPO_ROOT, path.resolve(filePath)).split(path.sep).join("/"),
      pattern: patternId.trim(),
      matches: Number(count),
    });
  }
  return hits;
}

function main() {
  const roots = resolveRoots();
  const result = spawnSync(process.execPath, [GUARD, ...roots], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) refuse(`the owner-data guard could not be started: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(result.stdout ?? "");
  if (result.stderr) process.stderr.write(result.stderr);

  // A SUMMARY THAT DID NOT PRINT IS NOT A ZERO. The guard's own header records that its
  // most dangerous failure mode is a green produced by scanning the wrong thing. If the
  // line the release packager parses is absent, this gate refuses rather than inheriting
  // an exit code it cannot explain.
  const summary = /Scanned (\d+) files \((\d+) bytes\)\. Total matches: (\d+)\./.exec(output);
  if (!summary) {
    refuse(
      `the owner-data guard exited ${result.status} without printing its "Scanned N files ... Total matches: N." ` +
        "summary, so nothing was measured.",
    );
  }
  const [, filesScanned, bytesScanned, totalMatches] = summary;

  if (result.status === 2) refuse(`the owner-data guard errored over ${JSON.stringify(roots)}.`);
  if (result.status !== 0 && result.status !== 1) {
    refuse(`the owner-data guard exited with the unexpected status ${result.status}.`);
  }

  const hits = parseHits(output);
  if (Number(totalMatches) > 0 && hits.length === 0) {
    refuse(
      `the owner-data guard reported ${totalMatches} match(es) but named no file, so this gate cannot report ` +
        "which shipped source file is at fault.",
    );
  }

  const refused = [];
  const excused = [];
  for (const hit of hits) {
    const allowed = ALLOWLIST.get(hit.file);
    // Built-in rules are product facts -- a home-directory path, a provider key shape,
    // the builder's checkout path. The guard never excuses them and neither does this.
    if (allowed && !hit.pattern.startsWith("builtin#")) excused.push({ ...hit, allowed });
    else refused.push(hit);
  }

  for (const { file, pattern, allowed } of excused) {
    console.log(`Allowlisted shipped source file: ${file} (pattern=${pattern}) -- ${allowed}`);
  }

  if (refused.length > 0) {
    // THE HEADLINE COUNTS FILES, AND THE GUARD'S ROWS ARE NOT FILES.
    //
    // The guard prints one row per file AND PATTERN, so a single dirty file that
    // trips three rules produces three rows. Reporting `refused.length` as the
    // file count said "3 shipped source file(s)" for one dirty file -- measured
    // 2026-09-18 by Manager 13 against a planted probe -- and sends the next
    // person hunting two files that do not exist. A gate the landing relies on
    // must not overstate its own blast radius. Distinct paths are the file
    // number; the per-pattern rows stay underneath, now grouped by file so the
    // shape of the headline and the shape of the list agree.
    const byFile = new Map();
    for (const hit of refused) {
      if (!byFile.has(hit.file)) byFile.set(hit.file, []);
      byFile.get(hit.file).push(hit);
    }
    const totalHits = refused.reduce((sum, hit) => sum + hit.matches, 0);
    const patterns = new Set(refused.map(hit => hit.pattern));
    // Spelled out rather than an -s suffix: "3 matchs" and "1 file carry" would
    // be the first thing a reader notices about the sentence, ahead of the count
    // it is there to correct.
    const files = byFile.size === 1 ? "1 shipped source file carries" : `${byFile.size} shipped source files carry`;
    const matched = totalHits === 1 ? "1 match" : `${totalHits} matches`;
    const ruled = patterns.size === 1 ? "1 pattern" : `${patterns.size} patterns`;

    console.error("");
    console.error(
      `Shipped-source owner-data gate REFUSED: ${files} owner data and would be packed into ` +
        `app.asar (${matched} across ${ruled}):`,
    );
    for (const [file, fileHits] of byFile) {
      console.error(`  ${file}`);
      for (const { pattern, matches } of fileHits) {
        console.error(`    pattern=${pattern}, ${matches === 1 ? "1 match" : `${matches} matches`}`);
      }
    }
    console.error(
      "Remove the value from the file (a comment can keep its point without quoting a real account name). " +
        "Do not add it to the allowlist unless the literal genuinely must ship, and then by exact path with a reason.",
    );
    process.exit(1);
  }

  // Distinct paths here too, for the same reason as the refusal headline.
  const allowlistedFiles = new Set(excused.map(hit => hit.file)).size;
  console.log(
    `Shipped-source owner-data gate: clean. ${filesScanned} file(s) (${bytesScanned} bytes) across ` +
      `${JSON.stringify(roots)} carry no owner data; ${allowlistedFiles} allowlisted.`,
  );
}

main();
