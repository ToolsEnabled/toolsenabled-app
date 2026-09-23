// The cut must not measure, or write, the LIVE state of the machine it runs on.
//
// `npm run dist` begins with `verify:release` -> `test-ratchet.mjs --strict`. That
// ratchet refuses ONLY when TOOLSENABLED_STATE_ROOT is unset; when it is set it
// measures, and writes, whatever root it names. The cutter used to hand the dist
// child `{ ...process.env }`, so on an installed machine -- where the documented
// setup exports TOOLSENABLED_STATE_ROOT user-wide -- a release cut would run the
// whole suite against the operator's LIVE capability state.
//
// These tests assert the environment the cutter BUILDS, by calling the builder with
// values. They are deliberately exhaustive over the produced environment rather than
// checking a list of variable names: a leak through some variable nobody thought of
// is exactly the failure mode here.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";

import { createHash } from "node:crypto";
import { ownedFixtureTempRoot } from "./lib/owned-fixture-temp.mjs";

import {
  buildDistChainEnvironment,
  copyPrivateInputs,
  nativeQualificationRoot,
} from "../release-packager/cut-release-candidate.mjs";

// A machine that looks like the documented install: a user-wide LIVE state root,
// a machine temp, and a stray override that the cutter has always had to strip.
function machineEnvironment(liveRoot) {
  return {
    PATH: process.env.PATH,
    TOOLSENABLED_STATE_ROOT: liveRoot,
    MC_TEST_STATE_ROOT: path.join(liveRoot, "test"),
    MC_CANONICAL_ROOT: "/machine/engine/checkout",
    TEMP: "/machine/temp",
    TMP: "/machine/temp",
    TMPDIR: "/machine/temp",
    MC_ALLOW_DIRTY_BUILD: "1",
  };
}

function scratchFixture() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cut-env-test-"));
  const scratchState = path.join(scratch, "state");
  // The temp root must fit the POSIX socket budget (TMPDIR_BYTE_BUDGET, 20
  // bytes): a directory beside the state root under os.tmpdir() is 29+ bytes
  // and is exactly the shape the builder now refuses, so the fixture makes the
  // short root the packager itself makes.
  const scratchTemp = mkdtempSync(path.join(process.platform === "win32" ? ownedFixtureTempRoot() : "/tmp", "te-t-"));
  mkdirSync(scratchState, { recursive: true });
  return { scratch, scratchState, scratchTemp };
}

const ENGINE_REF = "b".repeat(40);

test("no dist-chain child can see the machine's LIVE state root", () => {
  const liveRoot = "/home/operator/AppData/Roaming/ToolsEnabled/capability";
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment(liveRoot), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: ENGINE_REF,
    });

    // Exhaustive: not "the variables we remembered", but every value in the
    // environment the child will actually receive.
    const leaked = Object.entries(built)
      .filter(([, value]) => typeof value === "string" && value.includes(liveRoot))
      .map(([key]) => key);
    assert.deepEqual(
      leaked,
      [],
      `these variables still carry the machine's LIVE state root into the build: ${leaked.join(", ")}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("state and temp roots are inside the cut's own scratch directory", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: ENGINE_REF,
    });
    for (const key of ["TOOLSENABLED_STATE_ROOT", "MC_TEST_STATE_ROOT"]) {
      assert.equal(built[key], scratchState, `${key} must be the scratch state root`);
    }
    // TMPDIR is included even though tools/test-strict.mjs sets only TEMP/TMP:
    // Node resolves os.tmpdir() from TMPDIR on POSIX, so omitting it would let a
    // POSIX child write outside the scratch directory.
    for (const key of ["TEMP", "TMP", "TMPDIR"]) {
      assert.equal(built[key], scratchTemp, `${key} must be the scratch temp root`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

// Ledger T146: the 1.0.45 cut of 2026-09-16 refused inside verify:release
// because tools/test/audit-repair-native.test.mjs would not run its fourteen
// native custody cases on Windows without an explicit approved
// MC_SETTINGS_NATIVE_SCRATCH_ROOT. The cutter now names one inside its own
// temp root, so the native suites measure for real instead of going red.
test("the native Windows qualification root is the cut's own, inside its temp root", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: ENGINE_REF,
    });
    const root = built.MC_SETTINGS_NATIVE_SCRATCH_ROOT;
    assert.equal(typeof root, "string");
    assert.ok(path.isAbsolute(root), "the suite refuses a relative root");
    assert.equal(path.dirname(root), scratchTemp, "it lives directly under the cut's temp root");
    assert.equal(root, nativeQualificationRoot(scratchTemp));
    assert.ok(!root.startsWith("/live/root"), "never the machine's LIVE state");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("the strict marker the repo's own scratch runner sets is present", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: ENGINE_REF,
    });
    assert.equal(built.TOOLSENABLED_TEST_STRICT, "1");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("the canonical root is bound when supplied and never inherited silently", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const bound = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      canonicalRoot: "/cut/engine/checkout",
      engineSourceRef: ENGINE_REF,
    });
    assert.equal(bound.MC_CANONICAL_ROOT, "/cut/engine/checkout");

    // With nothing to bind it to, the machine's value must not silently stand in
    // for the engine this cut is actually staging.
    const unbound = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: ENGINE_REF,
    });
    assert.notEqual(
      unbound.MC_CANONICAL_ROOT,
      "/machine/engine/checkout",
      "an unresolved canonical root must not fall through to the machine's",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("the guarantees the cutter already had are not lost", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: "c".repeat(40),
    });
    assert.equal(built.MC_ALLOW_DIRTY_BUILD, undefined, "the dirty-build override must still be stripped");
    assert.equal(built.TOOLSENABLED_SOURCE_REF, "c".repeat(40), "the engine ref must still be bound");
    assert.equal(built.PATH, process.env.PATH, "unrelated variables must still pass through");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

// The negative check: a real child, under the built environment, must resolve its
// temporary directory inside the scratch tree and must leave the LIVE root untouched.
// This does NOT run the full suite -- that needs the Windows host and many minutes --
// so it proves the containment of the environment, not the suite's own behaviour.
test("a real child under the built environment writes nothing outside the scratch directory", () => {
  const liveHome = mkdtempSync(path.join(os.tmpdir(), "cut-env-liveroot-"));
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const sentinel = path.join(liveHome, "capability-state.json");
    writeFileSync(sentinel, JSON.stringify({ live: true }));
    const before = { entries: readdirSync(liveHome).sort(), mtimeMs: statSync(sentinel).mtimeMs };

    const built = buildDistChainEnvironment(machineEnvironment(liveHome), { workspaceSegments: ['fixture-workspace'],
      scratchState,
      scratchTemp,
      engineSourceRef: "d".repeat(40),
    });

    const probe = [
      "const os=require('os'),fs=require('fs'),p=require('path');",
      "const d=fs.mkdtempSync(p.join(os.tmpdir(),'suite-'));",
      "fs.writeFileSync(p.join(d,'ledger.json'),'{}');",
      "process.stdout.write(JSON.stringify({tmpdir:os.tmpdir(),wrote:d,state:process.env.TOOLSENABLED_STATE_ROOT}));",
    ].join("");

    const child = spawnSync(process.execPath, ["-e", probe], {
      env: built,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const seen = JSON.parse(child.stdout);

    assert.equal(seen.state, scratchState, "the child saw a state root outside the scratch tree");
    assert.ok(
      path.resolve(seen.tmpdir).startsWith(path.resolve(scratchTemp)),
      `the child resolved os.tmpdir() to ${seen.tmpdir}, outside ${scratchTemp}`,
    );
    assert.ok(
      path.resolve(seen.wrote).startsWith(path.resolve(scratchTemp)),
      `the child wrote to ${seen.wrote}, outside ${scratchTemp}`,
    );

    const after = { entries: readdirSync(liveHome).sort(), mtimeMs: statSync(sentinel).mtimeMs };
    assert.deepEqual(after.entries, before.entries, "the LIVE root gained or lost entries");
    assert.equal(after.mtimeMs, before.mtimeMs, "the LIVE root's contents were rewritten");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
    rmSync(liveHome, { recursive: true, force: true });
  }
});

// Owner rules D3/A3: the private inputs must be provably the ones the operator
// staged, and must never reach the artifact. Recording their DIGESTS is what makes
// the first half auditable; recording their contents would break the second.
test("private inputs are recorded by digest, never by content", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cut-private-inputs-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    mkdirSync(path.join(repo, "private"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    for (const dir of [repo, worktree]) {
      for (const args of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"]]) {
        spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      }
      writeFileSync(path.join(dir, "README"), "x");
      spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
      spawnSync("git", ["-C", dir, "commit", "-qm", "base"], { encoding: "utf8" });
    }

    const secret = '{"patterns":["a-real-owner-alias"]}';
    writeFileSync(path.join(repo, "private", "owner-data-patterns.owner.json"), secret);

    const result = await copyPrivateInputs(repo, worktree, { log: () => {} });

    assert.ok(Array.isArray(result.digests), "copyPrivateInputs must report digests");
    const entry = result.digests.find((d) => d.file === "owner-data-patterns.owner.json");
    assert.ok(entry, "the staged private input must appear in the digest list");

    const expected = createHash("sha256").update(Buffer.from(secret)).digest("hex");
    assert.equal(entry.sha256.toLowerCase(), expected, "the digest must be of the bytes that landed");
    assert.equal(entry.bytes, Buffer.byteLength(secret));

    // The contents are the operator's identity profile. They must not be anywhere
    // in what the cutter hands to a record.
    assert.ok(
      !JSON.stringify(result).includes("a-real-owner-alias"),
      "the private input's CONTENTS reached the record; only digests may be recorded",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The Linux cutter (tools/release-packager/cut-linux-release-candidate.mjs) must
// hand its dist chain the SAME environment: it calls buildDistChainEnvironment
// through the loaded packager and adds only the packer's source path. A second
// scratch set in that file would be a second containment rule with its own
// blind spots, so these tests call the Linux builder with the same machine
// environment and apply the same exhaustive leak filter.
import * as packager from "../release-packager/cut-release-candidate.mjs";
import { linuxDistChainEnvironment } from "../release-packager/cut-linux-release-candidate.mjs";

test("the Linux cutter's dist-chain environment leaks nothing of the machine's LIVE state root", () => {
  const liveRoot = "/home/operator/.config/ToolsEnabled/capability";
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = linuxDistChainEnvironment(machineEnvironment(liveRoot), packager, { workspaceSegments: ['fixture-workspace'],
      scratchState, scratchTemp, engineRepo: "/cut/engine/checkout", engineRef: ENGINE_REF,
    });
    const leaked = Object.entries(built)
      .filter(([, value]) => typeof value === "string" && value.includes(liveRoot))
      .map(([key]) => key);
    assert.deepEqual(leaked, [], `these variables carry the machine's LIVE state root into the Linux build: ${leaked.join(", ")}`);
    for (const key of ["TOOLSENABLED_STATE_ROOT", "MC_TEST_STATE_ROOT"]) assert.equal(built[key], scratchState, key);
    for (const key of ["TEMP", "TMP", "TMPDIR"]) assert.equal(built[key], scratchTemp, key);
    assert.equal(built.TOOLSENABLED_TEST_STRICT, "1");
    assert.equal(built.MC_ALLOW_DIRTY_BUILD, undefined, "the dirty-build override must be stripped on Linux too");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("the Linux cutter binds the engine checkout as canonical root and packer source, with the exact ref", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = linuxDistChainEnvironment(machineEnvironment("/live/root"), packager, { workspaceSegments: ['fixture-workspace'],
      scratchState, scratchTemp, engineRepo: "/cut/engine/checkout", engineRef: ENGINE_REF,
    });
    assert.equal(built.MC_CANONICAL_ROOT, "/cut/engine/checkout", "the machine's engine checkout must not stand in for the one being cut");
    assert.equal(built.TOOLSENABLED_SOURCE, "/cut/engine/checkout", "the packer reads TOOLSENABLED_SOURCE for the engine path on Linux");
    assert.equal(built.TOOLSENABLED_SOURCE_REF, ENGINE_REF);
    for (const bad of [{ engineRepo: "", engineRef: ENGINE_REF }, { engineRepo: "/cut/engine", engineRef: "abc123" }, { engineRepo: "/cut/engine", engineRef: ENGINE_REF.toUpperCase() }]) {
      assert.throws(
        () => linuxDistChainEnvironment(machineEnvironment("/live/root"), packager, { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp, ...bad }),
        /binds the engine checkout and its exact 40-character ref/,
        `an unbound or malformed engine binding must be refused: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("a packager without buildDistChainEnvironment is refused; the Linux cutter never substitutes a scratch set of its own", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    for (const cutter of [{}, null, { buildDistChainEnvironment: "not a function" }]) {
      assert.throws(
        () => linuxDistChainEnvironment(machineEnvironment("/live/root"), cutter, { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp, engineRepo: "/cut/engine", engineRef: ENGINE_REF }),
        /exports no buildDistChainEnvironment/,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("a real child under the Linux cutter's environment writes nothing outside the scratch directory", () => {
  const liveHome = mkdtempSync(path.join(os.tmpdir(), "cut-env-linux-liveroot-"));
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const sentinel = path.join(liveHome, "capability-state.json");
    writeFileSync(sentinel, JSON.stringify({ live: true }));
    const before = { entries: readdirSync(liveHome).sort(), mtimeMs: statSync(sentinel).mtimeMs };
    const built = linuxDistChainEnvironment(machineEnvironment(liveHome), packager, { workspaceSegments: ['fixture-workspace'],
      scratchState, scratchTemp, engineRepo: "/cut/engine/checkout", engineRef: "e".repeat(40),
    });
    const probe = [
      "const os=require('os'),fs=require('fs'),p=require('path');",
      "const d=fs.mkdtempSync(p.join(os.tmpdir(),'suite-'));",
      "fs.writeFileSync(p.join(d,'ledger.json'),'{}');",
      "process.stdout.write(JSON.stringify({tmpdir:os.tmpdir(),wrote:d,state:process.env.TOOLSENABLED_STATE_ROOT,source:process.env.TOOLSENABLED_SOURCE}));",
    ].join("");
    const child = spawnSync(process.execPath, ["-e", probe], { env: built, encoding: "utf8", timeout: 60000 });
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const seen = JSON.parse(child.stdout);
    assert.equal(seen.state, scratchState);
    assert.equal(seen.source, "/cut/engine/checkout");
    assert.ok(path.resolve(seen.tmpdir).startsWith(path.resolve(scratchTemp)), `os.tmpdir() resolved to ${seen.tmpdir}`);
    assert.ok(path.resolve(seen.wrote).startsWith(path.resolve(scratchTemp)), `the child wrote to ${seen.wrote}`);
    const after = { entries: readdirSync(liveHome).sort(), mtimeMs: statSync(sentinel).mtimeMs };
    assert.deepEqual(after.entries, before.entries, "the LIVE root gained or lost entries");
    assert.equal(after.mtimeMs, before.mtimeMs, "the LIVE root's contents were rewritten");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
    rmSync(liveHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One copy step for both cutters. The Linux cutter hands its private inputs to
// the packager's copyPrivateInputs (explicit staging directory, landed mode),
// and its PUBLISHED declaration facts carry names and sizes only: a digest of
// a guessable file is a confirmation oracle, so digests live in the private
// gates record and nowhere else.
import { declarationPrivateInputs, writeFacts, writeGates } from "../release-packager/cut-linux-release-candidate.mjs";
import { existsSync, readFileSync } from "node:fs";

function gitFixture(root) {
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  for (const dir of [repo, worktree]) {
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"]]) spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    writeFileSync(path.join(dir, "README"), "x");
    spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "commit", "-qm", "base"], { encoding: "utf8" });
  }
  return { repo, worktree };
}

test("the packager copies private inputs from an explicit staging directory with the requested mode, by digest and never by content", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cut-private-inputs-linux-"));
  try {
    const { repo, worktree } = gitFixture(root);
    const staging = path.join(root, "staged-elsewhere");
    mkdirSync(path.join(staging, "nested"), { recursive: true });
    const secret = '{"patterns":["a-real-owner-alias"]}';
    writeFileSync(path.join(staging, "owner-data-patterns.owner.json"), secret);
    writeFileSync(path.join(staging, "nested", "capability-source.owner.json"), '{"ref":"' + "b".repeat(40) + '"}');
    const lines = [];
    const result = await copyPrivateInputs(repo, worktree, { log: (line) => lines.push(line), sourcePrivate: staging, mode: 0o600 });
    assert.deepEqual(result.digests.map((d) => d.file).sort(), ["nested/capability-source.owner.json", "owner-data-patterns.owner.json"]);
    const landed = path.join(worktree, "private", "owner-data-patterns.owner.json");
    assert.equal(readFileSync(landed, "utf8"), secret, "the bytes must land unchanged");
    // Windows chmod cannot establish a POSIX mode; the native ACL gate is
    // separate. The real copied bytes and content-free receipt are checked
    // below on both systems.
    if (process.platform !== 'win32') assert.equal(statSync(landed).mode & 0o777, 0o600, "the landed copy must carry the requested mode");
    const entry = result.digests.find((d) => d.file === "owner-data-patterns.owner.json");
    assert.equal(entry.sha256.toLowerCase(), createHash("sha256").update(Buffer.from(secret)).digest("hex"));
    assert.equal(entry.bytes, Buffer.byteLength(secret));
    assert.ok(!JSON.stringify(result).includes("a-real-owner-alias") && !lines.join("\n").includes("a-real-owner-alias"), "contents reached a record or a log line");
    assert.ok(!existsSync(path.join(repo, "private")), "nothing was read from or written to <repo>/private when a staging directory was given");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Linux declaration facts carry private-input names and sizes only; digests stay in the private gates record", async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), "cut-linux-facts-"));
  try {
    const digest = "d".repeat(64);
    const ctx = {
      records: [], rehearsal: true, continueOnRed: true, resumeFromStep: null, version: "9.9.9", currentVersion: "9.9.8",
      repo: "/nowhere/app", engineRepo: "/nowhere/engine", worktree: "/nowhere/worktree", output, sourceRef: "a".repeat(40), engineRef: "b".repeat(40),
      buildRef: "c".repeat(40), sameVersion: false, deb: null, dpkg: null, manifest: null, buildInfo: null, history: null,
      privateInputs: { directory: "/nowhere/private", files: [{ file: "owner-data-patterns.owner.json", bytes: 773, sha256: digest, extra: "must-not-survive" }], skippedTracked: [] },
      nodeModules: { mode: "copy", fellBackFrom: null, reasons: [] }, excludedWip: null, otherCandidates: [], tag: null, installedProof: false,
      attribution: { cutterAttribution: "test" }, tooling: { root: "/nowhere/tools" }, useTime: false, startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null, scratch: null, environment: null, session: null, sandbox: null, derived: {}, ok: null, driverLog: [], gatesPath: path.join(output, "gates-9.9.9.json"),
    };
    assert.deepEqual(declarationPrivateInputs(ctx.privateInputs.files), [{ file: "owner-data-patterns.owner.json", bytes: 773 }]);
    await writeFacts(ctx, {});
    const facts = readFileSync(path.join(output, "facts-scan-9.9.9", "declaration-facts-9.9.9.json"), "utf8");
    assert.ok(!facts.includes(digest), "a private-input digest reached the declaration facts");
    assert.ok(!facts.includes("must-not-survive"), "an unexpected private-input field reached the declaration facts");
    assert.ok(facts.includes('"owner-data-patterns.owner.json"') && facts.includes("773"), "the name and size must still be declared");
    await writeGates(ctx);
    const gates = JSON.parse(readFileSync(ctx.gatesPath, "utf8"));
    assert.equal(gates.privateInputs.files[0].sha256, digest, "the private gates record must keep the digest");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TMPDIR byte budget (Controller defect, 2026-09-10, measured on rehearsal-03):
// a 112-byte TMPDIR silently disabled every suite that opens a Unix socket
// under it. The builder must refuse such a root on POSIX, leave Windows alone,
// hand out a short root itself, and record the byte length in the gates block.
import { TMPDIR_BYTE_BUDGET, createShortTempRoot, describeDistChainEnvironment, tmpdirBudgetProblem } from "../release-packager/cut-release-candidate.mjs";

const REHEARSAL_03_TMPDIR = "/home/j/toolsenabled-port/evidence/controller-cut-44-20260910/linux/cutter/rehearsal-base-03/scratch-1.0.44/temp";

test("the 112-byte rehearsal-03 temp root is refused on POSIX with the measured and allowed byte counts", () => {
  assert.equal(Buffer.byteLength(REHEARSAL_03_TMPDIR), 112, "the fixture is the exact measured case");
  assert.equal(TMPDIR_BYTE_BUDGET, 20, "min(107 sun_path, 100 runner budget) - 80 reserved");
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    assert.throws(
      () => buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp: REHEARSAL_03_TMPDIR, engineSourceRef: ENGINE_REF, platform: "linux" }),
      /is 112 bytes; the dist chain's temp root may be at most 20 bytes on POSIX/,
    );
    assert.throws(
      () => linuxDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'], ...packager,
        buildDistChainEnvironment: (env, options) => buildDistChainEnvironment(env, { workspaceSegments: ['fixture-workspace'], ...options, platform: "linux" }),
      }, { scratchState, scratchTemp: REHEARSAL_03_TMPDIR, engineRepo: "/cut/engine", engineRef: ENGINE_REF }),
      /112 bytes/,
      "the Linux cutter's invocation must refuse the same root",
    );
    // Windows keeps its behaviour: no socket budget there.
    const win = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp: REHEARSAL_03_TMPDIR, engineSourceRef: ENGINE_REF, platform: "win32" });
    assert.equal(win.TMPDIR, REHEARSAL_03_TMPDIR);
    assert.equal(tmpdirBudgetProblem(REHEARSAL_03_TMPDIR, "win32"), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});

test("the packager's short temp root fits the budget, builds green, and the gates block records its byte length", { skip: process.platform === "win32" && "POSIX /tmp and Unix-socket qualification runs on POSIX; Windows refusal is verified separately" }, async () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  const short = await createShortTempRoot({ platform: "linux" });
  try {
    assert.ok(short.directory.startsWith("/tmp/te-cut-"), short.directory);
    assert.ok(short.bytes <= TMPDIR_BYTE_BUDGET, `${short.directory} is ${short.bytes} bytes`);
    assert.equal(short.budgetBytes, TMPDIR_BYTE_BUDGET);
    const built = linuxDistChainEnvironment(machineEnvironment("/live/root"), packager, { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp: short.directory, engineRepo: "/cut/engine", engineRef: ENGINE_REF });
    for (const key of ["TEMP", "TMP", "TMPDIR"]) assert.equal(built[key], short.directory, key);
    const described = describeDistChainEnvironment(built, { scratch });
    assert.equal(described.tempBytes, short.bytes);
    assert.equal(described.tempBudgetBytes, TMPDIR_BYTE_BUDGET);
    // A socket built the way the suites build one fits the runner's budget.
    const socketPath = path.join(built.TMPDIR, "toolsenabled-owner-host-unknown-vs-denied-XXXXXX", "scope.sock");
    assert.ok(Buffer.byteLength(socketPath) <= 100, `${socketPath} is ${Buffer.byteLength(socketPath)} bytes`);
    await assert.rejects(createShortTempRoot({ platform: "win32" }), /Windows keeps its existing temp root/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
    rmSync(short.directory, { recursive: true, force: true });
  }
});

test("Windows refuses the POSIX-only short-temp allocator before creating a directory", async () => {
  await assert.rejects(createShortTempRoot({ platform: "win32" }), /Windows keeps its existing temp root/);
});

test("Python bytecode from suite drivers is kept out of the source tree", () => {
  const { scratch, scratchState, scratchTemp } = scratchFixture();
  try {
    const built = buildDistChainEnvironment(machineEnvironment("/live/root"), { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp, engineSourceRef: ENGINE_REF });
    assert.equal(built.PYTHONDONTWRITEBYTECODE, "1", "python must not write __pycache__ beside the source it imports (the ratchet fingerprints ignored files)");
    assert.ok(path.resolve(built.PYTHONPYCACHEPREFIX).startsWith(path.resolve(scratchTemp)), `PYTHONPYCACHEPREFIX ${built.PYTHONPYCACHEPREFIX} is outside the scratch temp`);
    const linux = linuxDistChainEnvironment(machineEnvironment("/live/root"), packager, { workspaceSegments: ['fixture-workspace'], scratchState, scratchTemp, engineRepo: "/cut/engine", engineRef: ENGINE_REF });
    assert.equal(linux.PYTHONDONTWRITEBYTECODE, "1");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchTemp, { recursive: true, force: true });
  }
});
