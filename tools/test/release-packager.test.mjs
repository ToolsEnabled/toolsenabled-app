import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bumpSemver, computeNextVersion, writePackageVersion } from "../release-packager/lib/version-bump.mjs";
import { measureFile, sameBytes, sha256File } from "../release-packager/lib/hash.mjs";
import { findOtherCandidates } from "../release-packager/lib/scan-artifacts.mjs";
import { assertStagingFree, classifyStagedCandidate } from "../release-packager/lib/staging-collision.mjs";
import { currentBranch, isAncestor, revParse, tagCommit } from "../release-packager/lib/git.mjs";
import { downloadManifestFromFacts } from "../release-packager/lib/download-manifest.mjs";
import { validatePublishedReleaseLedger } from "../release-packager/lib/published-releases.mjs";
import { assertCandidatePeIdentity } from "../release-packager/lib/version-info.mjs";
import { attributionBlocksCommit, cuttingAttribution, cuttingIdentity, cuttingSession, renderDeclaration } from "../release-packager/generate-declaration.mjs";
import { assertGateFlagCombination, buildDistChainEnvironment, copyPrivateInputs, parseKnownFixArg, resolveExactAppSourceRef, stageWindowsReleaseNotes, parseArgs as parseWindowsArgs } from "../release-packager/cut-release-candidate.mjs";
import {
  POST_BUILD_GATES,
  describeArtifact,
  runGates,
  sameArtifact,
  selectGates,
  selectSkippableGates,
  summarizeGateRun,
} from "../release-packager/lib/gate-evidence.mjs";
import { assertGateWorktreeAvailable } from "../release-packager/lib/gate-quarantine.mjs";
import { CUT_SLOT_HELD, claimCutSlot } from "../release-packager/lib/cut-slot.mjs";

// --- version-bump.mjs -------------------------------------------------------

test("bumpSemver bumps exactly one component and zeroes the ones below it", () => {
  assert.equal(bumpSemver("1.0.1", "patch"), "1.0.2");
  assert.equal(bumpSemver("1.0.1", "minor"), "1.1.0");
  assert.equal(bumpSemver("1.0.1", "major"), "2.0.0");
});

test("bumpSemver rejects a non-semver string rather than guessing", () => {
  assert.throws(() => bumpSemver("1.0", "patch"));
  assert.throws(() => bumpSemver("v1.0.1", "patch"));
});

test("bumpSemver refuses to round oversized version components", () => {
  assert.throws(() => bumpSemver("9007199254740993.0.0", "patch"), /safe integer range/);
  assert.throws(() => bumpSemver("1.0.9007199254740991", "patch"), /unsafe patch version component/);
});

test("computeNextVersion defaults to a patch bump and never silently repeats the current version", () => {
  assert.equal(computeNextVersion({ currentVersion: "1.0.1" }), "1.0.2");
  assert.throws(
    () => computeNextVersion({ currentVersion: "1.0.1", explicitVersion: "1.0.1" }),
    /identical to the current version/,
  );
});

test("computeNextVersion allows the same version only with the explicit override", () => {
  assert.equal(
    computeNextVersion({ currentVersion: "1.0.1", explicitVersion: "1.0.1", allowSameVersion: true }),
    "1.0.1",
  );
});

test("computeNextVersion honours an explicit version over --bump", () => {
  assert.equal(computeNextVersion({ currentVersion: "1.0.1", explicitVersion: "2.5.0", bump: "patch" }), "2.5.0");
});

test("writePackageVersion changes package and lock versions together and preserves formatting", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  try {
    const pkgPath = path.join(home, "package.json");
    const lockPath = path.join(home, "package-lock.json");
    const original = '{\n  "name": "fixture",\n  "version": "1.0.1",\n  "private": true\n}\n';
    await writeFile(pkgPath, original, "utf8");
    await writeFile(lockPath, '{\n  "name": "fixture",\n  "version": "1.0.1",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "fixture",\n      "version": "1.0.1"\n    }\n  }\n}\n', "utf8");

    const result = await writePackageVersion(pkgPath, "1.0.2");
    assert.equal(result.previousVersion, "1.0.1");
    assert.equal(result.newVersion, "1.0.2");

    const { readFile } = await import("node:fs/promises");
    const rewritten = await readFile(pkgPath, "utf8");
    const rewrittenLock = await readFile(lockPath, "utf8");
    assert.match(rewritten, /"version": "1\.0\.2"/);
    assert.match(rewritten, /"name": "fixture"/);
    assert.ok(rewritten.endsWith("\n"), "trailing newline preserved");
    assert.equal(JSON.parse(rewrittenLock).version, "1.0.2");
    assert.equal(JSON.parse(rewrittenLock).packages[""].version, "1.0.2");
    assert.ok(rewrittenLock.endsWith("\n"), "lock trailing newline preserved");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- hash.mjs ----------------------------------------------------------------

test("sha256File/measureFile/sameBytes agree with each other and detect a changed byte", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  try {
    const fileA = path.join(home, "a.bin");
    const fileB = path.join(home, "b.bin");
    await writeFile(fileA, Buffer.from("identical content"));
    await writeFile(fileB, Buffer.from("identical content"));

    const measuredA = await measureFile(fileA);
    const measuredB = await measureFile(fileB);
    assert.equal(measuredA.sha256, await sha256File(fileA));
    assert.ok(sameBytes(measuredA, measuredB), "two files with identical bytes must hash identically");

    await writeFile(fileB, Buffer.from("identical content!"));
    const measuredBChanged = await measureFile(fileB);
    assert.ok(!sameBytes(measuredA, measuredBChanged), "a single changed byte must change the verdict");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- scan-artifacts.mjs -------------------------------------------------------

test("findOtherCandidates finds same-pattern installers one level deep and excludes the declared one", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  try {
    const root = path.join(home, "staging-root");
    const versionedSubdir = path.join(root, "1.0.1");
    await mkdir(versionedSubdir, { recursive: true });

    const stray = path.join(root, "ToolsEnabled Setup 1.0.0.exe");
    const nested = path.join(versionedSubdir, "ToolsEnabled Setup 1.0.1.exe");
    const irrelevant = path.join(root, "readme.txt");
    await writeFile(stray, Buffer.from("stray"));
    await writeFile(nested, Buffer.from("this-is-the-declared-one"));
    await writeFile(irrelevant, Buffer.from("not an installer"));

    const found = await findOtherCandidates([root], nested);
    const paths = found.map((f) => f.path).sort();
    assert.deepEqual(paths, [stray].sort());
    assert.ok(!paths.includes(nested), "the declared candidate itself must never appear in its own exclusion list");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findOtherCandidates tolerates a missing search root instead of throwing", async () => {
  const found = await findOtherCandidates(["C:\\this\\path\\should\\not\\exist\\anywhere"], "C:\\nope.exe");
  assert.deepEqual(found, []);
});

test("findOtherCandidates reports an artifact once when search roots overlap", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  try {
    const versionedSubdir = path.join(home, "1.0.1");
    await mkdir(versionedSubdir, { recursive: true });
    const candidate = path.join(versionedSubdir, "ToolsEnabled Setup 1.0.1.exe");
    await writeFile(candidate, Buffer.from("candidate"));

    const found = await findOtherCandidates([home, versionedSubdir], path.join(home, "excluded.exe"));
    assert.deepEqual(found.map((artifact) => artifact.path), [candidate]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- git.mjs (read-only, against this checkout) -------------------------------

test("git.mjs primitives read real state from this checkout without mutating it", () => {
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const head = revParse(repoRoot);
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(typeof currentBranch(repoRoot), "string");
  // 95a7a14 is an ancestor of every commit on installer/nsis as of this
  // tool's authoring; if that ever stops being true it means history was
  // rewritten, which is itself worth this test failing loudly over.
  assert.ok(isAncestor(repoRoot, "95a7a14176f297ac04212eee0cb1f3c652d8e27c", head));
});

// --- generate-declaration.mjs --------------------------------------------------

function baseFacts(overrides = {}) {
  return {
    test: false,
    date: "2026-08-10",
    version: "1.0.2",
    previousVersion: "1.0.1",
    repo: "C:\\fixture\\repo",
    branch: "installer/nsis",
    sourceRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    engineSourceRef: "cccccccccccccccccccccccccccccccccccccccc",
    buildRef: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    branchAdvanced: false,
    candidate: { filename: "ToolsEnabled Setup 1.0.2.exe", bytes: 123456789, sha256: "DEADBEEF".repeat(8) },
    publisher: "ToolsEnabled, Inc. in formation",
    treeState: { worktreePath: "C:\\fixture\\wt", worktreeRemoved: true, buildInfoConfirmedClean: true },
    versionInfo: {
      companyName: "ToolsEnabled, Inc.",
      productName: "ToolsEnabled",
      fileVersion: "1.0.2",
      productVersion: "1.0.2",
      legalCopyright: "Copyright \u00A9 2026 ToolsEnabled",
    },
    appId: { configured: "com.toolsenabled.desktop" },
    unsigned: { signExecutable: false },
    pipeline: { verifySummary: null, checkNoOwnerData: null, smokePackagedLine: null, distExitCode: 0, packagedQaExitCode: 0 },
    excludedWip: { sourceWorktree: "C:\\fixture\\repo", measuredAt: "2026-08-10T00:00:00.000Z", dirtyFiles: [] },
    otherCandidates: [],
    stagingDir: "C:\\fixture\\staging\\1.0.2",
    privateInputsCopied: [],
    ...overrides,
  };
}

test("renderDeclaration includes every field the acceptance matrix names, measured not assumed", () => {
  const markdown = renderDeclaration(baseFacts());
  assert.match(markdown, /ToolsEnabled Setup 1\.0\.2\.exe/);
  assert.match(markdown, /123,456,789/);
  assert.match(markdown, /DEADBEEF/);
  assert.match(markdown, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(markdown, /cccccccccccccccccccccccccccccccccccccccc/);
  assert.match(markdown, /ToolsEnabled, Inc\./);
  assert.match(markdown, /com\.toolsenabled\.desktop/);
  assert.match(markdown, /certifies the configured value only/);
});

test("download manifest is derived from the measured candidate and PE identity", () => {
  const facts = baseFacts();
  const manifest = downloadManifestFromFacts(facts);
  assert.deepEqual(manifest, {
    filename: facts.candidate.filename,
    version: facts.version,
    bytes: facts.candidate.bytes,
    sha256: facts.candidate.sha256.toLowerCase(),
    productName: facts.versionInfo.productName,
    fileVersion: facts.versionInfo.fileVersion,
    productVersion: facts.versionInfo.productVersion,
    buildRef: facts.buildRef,
    publisher: facts.publisher,
    appId: facts.appId.configured,
    immutableLocation: `${facts.stagingDir}\\${facts.candidate.filename}`,
  });
  assert.throws(
    () => downloadManifestFromFacts(baseFacts({ versionInfo: { ...facts.versionInfo, productVersion: "1.0.32" } })),
    /PE identity disagrees/,
  );
});

test("a wrong-but-readable PE is refused before it can become a candidate", () => {
  const measured = baseFacts().versionInfo;
  assert.deepEqual(
    assertCandidatePeIdentity({ version: "1.0.2", productName: "ToolsEnabled", measured }),
    { productName: "ToolsEnabled", fileVersion: "1.0.2", productVersion: "1.0.2" },
  );
  assert.throws(
    () => assertCandidatePeIdentity({
      version: "1.0.39",
      productName: "ToolsEnabled",
      measured: { ...measured, fileVersion: "1.0.32", productVersion: "1.0.32" },
    }),
    /candidate PE identity does not match release 1\.0\.39/,
  );
  assert.throws(
    () => assertCandidatePeIdentity({ version: "1.0.2", productName: "ToolsEnabled", measured: { ...measured, productName: "Another Product" } }),
    /productName/,
  );
});

test("a candidate tag is not a published release until the explicit ledger records it", () => {
  const row = {
    version: "1.0.9",
    candidateTag: "build/1.0.9",
    buildRef: "b".repeat(40),
    publishedFilename: "ToolsEnabled Setup 1.0.9.exe",
    publishedSha256: "c".repeat(64),
  };
  assert.throws(
    () => validatePublishedReleaseLedger({ schemaVersion: 1, published: [] }),
    /at least one published release/,
    "an inventory of candidate tags must not stand in for the publication ledger",
  );
  assert.deepEqual(
    validatePublishedReleaseLedger({ schemaVersion: 1, published: [row] }, {
      resolveCandidateTag: () => row.buildRef,
      packageVersionAtRef: () => row.version,
    }).map((release) => release.version),
    ["1.0.9"],
  );
  assert.throws(
    () => validatePublishedReleaseLedger({ schemaVersion: 1, published: [row] }, {
      resolveCandidateTag: () => "d".repeat(40),
      packageVersionAtRef: () => row.version,
    }),
    /not immutable ledger ref/,
  );
});

test("renderDeclaration marks a --test run unmistakably and never claims it is a real candidate", () => {
  const markdown = renderDeclaration(baseFacts({ test: true }));
  assert.match(markdown, /NOT A DECLARED CANDIDATE -- DO NOT DISTRIBUTE/);
  assert.match(markdown, /TEST ARTIFACT -- not offered as a candidate/);
});

test("same-version declaration preserves source/build identity without claiming a bump commit", () => {
  const facts = baseFacts();
  const markdown = renderDeclaration({ ...facts, sourceRef: facts.buildRef, previousVersion: facts.version });
  assert.match(markdown, /explicit same-version cut retains source\/build ref/);
  assert.match(markdown, /No version-bump commit was created/);
  assert.doesNotMatch(markdown, /Version bumped .*committed together/);
  assert.doesNotMatch(markdown, /one version-bump commit was added|not yet reachable|git branch -f|plus the version-bump commit/);
  const changed = renderDeclaration(facts);
  assert.match(changed, /Version bumped .*committed together/);
});

test("renderDeclaration names uncommitted WIP in the source worktree instead of hiding it", () => {
  const markdown = renderDeclaration(
    baseFacts({
      excludedWip: {
        sourceWorktree: "C:\\fixture\\repo",
        measuredAt: "2026-08-10T00:00:00.000Z",
        dirtyFiles: [" M index.html", "?? src/owner-popup.css"],
      },
    }),
  );
  assert.match(markdown, /Another lane's in-progress, uncommitted work/);
  assert.match(markdown, /index\.html/);
  assert.match(markdown, /owner-popup\.css/);
});

test("renderDeclaration lists other same-name installers as explicitly NOT the candidate", () => {
  const markdown = renderDeclaration(
    baseFacts({
      otherCandidates: [
        { path: "C:\\fixture\\release\\ToolsEnabled Setup 1.0.1.exe", bytes: 999, sha256: "CAFEBABE", mtime: "x" },
      ],
    }),
  );
  assert.match(markdown, /ToolsEnabled Setup 1\.0\.1\.exe/);
  assert.match(markdown, /CAFEBABE/);
  assert.match(markdown, /not this candidate; different bytes/);
});

test("renderDeclaration's unsigned caveat tracks the real signExecutable value, not a fixed sentence", () => {
  const unsignedMarkdown = renderDeclaration(baseFacts({ unsigned: { signExecutable: false } }));
  assert.match(unsignedMarkdown, /This build is unsigned/);

  const signedMarkdown = renderDeclaration(baseFacts({ unsigned: { signExecutable: true } }));
  assert.doesNotMatch(signedMarkdown, /This build is unsigned/);
  assert.match(signedMarkdown, /did not independently verify a valid Authenticode signature/);
});

test("renderDeclaration flags it as suspect if require-clean-tree.mjs's own build-info.json did not independently confirm clean", () => {
  const cleanMarkdown = renderDeclaration(baseFacts());
  assert.match(cleanMarkdown, /Confirmed: `dirty: false`, `overridden: false`/);

  const suspectMarkdown = renderDeclaration(
    baseFacts({ treeState: { worktreePath: "C:\\fixture\\wt", worktreeRemoved: true, buildInfoConfirmedClean: false } }),
  );
  assert.match(suspectMarkdown, /DID NOT CONFIRM CLEAN -- this declaration should not have been produced/);
});

test("renderDeclaration says when the branch was NOT advanced, with the exact fast-forward command", () => {
  const markdown = renderDeclaration(baseFacts({ branchAdvanced: false }));
  assert.match(markdown, /was NOT advanced/);
  assert.match(markdown, /git branch -f installer\/nsis bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
});

// --- cut-release-candidate.mjs: parseKnownFixArg --------------------------------

test("parseKnownFixArg splits on :: and requires both description and verifiedBy", () => {
  assert.deepEqual(parseKnownFixArg("Fixed the thing::source-only"), {
    description: "Fixed the thing",
    verifiedBy: "source-only",
    evidence: undefined,
  });
  assert.deepEqual(parseKnownFixArg("Fixed the thing::observed::saw it work at http://x::y"), {
    description: "Fixed the thing",
    verifiedBy: "observed",
    evidence: "saw it work at http://x::y",
  });
  assert.throws(() => parseKnownFixArg("only a description"), /description::verifiedBy/);
  assert.throws(() => parseKnownFixArg(""), /requires a value/);
});

test("resolveExactAppSourceRef carries only one immutable commit past the CLI boundary", () => {
  const commit = "a".repeat(40);
  const calls = [];
  const resolve = (repo, ref) => {
    calls.push([repo, ref]);
    return commit;
  };
  assert.equal(resolveExactAppSourceRef("C:/repo", undefined, { resolve, clean: () => true }), commit);
  assert.deepEqual(calls.pop(), ["C:/repo", "HEAD^{commit}"]);
  assert.equal(resolveExactAppSourceRef("C:/repo", commit, { resolve }), commit);
  assert.deepEqual(calls.pop(), ["C:/repo", `${commit}^{commit}`]);

  for (const moving of ["HEAD", "main", "build/1.0.40", commit.slice(0, 12), commit.toUpperCase()]) {
    assert.throws(
      () => resolveExactAppSourceRef("C:/repo", moving, { resolve }),
      /--source-ref must name one exact 40-character lowercase application commit id/,
      moving,
    );
  }
  assert.throws(
    () => resolveExactAppSourceRef("C:/repo", commit, { resolve: () => "b".repeat(40) }),
    /does not resolve to itself/,
  );
});

test("implicit source selection refuses staged, unstaged, and untracked working changes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cut-source-selection-"));
  try {
    git(["init", "-b", "fixture"], home);
    git(["config", "user.name", "Cut QA Fixture"], home);
    git(["config", "user.email", "cut-qa@example.invalid"], home);
    await writeFile(path.join(home, "feature.txt"), "committed behavior\n");
    git(["add", "feature.txt"], home);
    git(["commit", "-m", "fixture"], home);
    const ref = revParse(home, "HEAD");
    assert.equal(resolveExactAppSourceRef(home), ref);
    await writeFile(path.join(home, "feature.txt"), "working change\n");
    assert.throws(() => resolveExactAppSourceRef(home), /uncommitted work/);
    git(["add", "feature.txt"], home);
    assert.throws(() => resolveExactAppSourceRef(home), /uncommitted work/);
    git(["restore", "--staged", "feature.txt"], home);
    git(["restore", "feature.txt"], home);
    await writeFile(path.join(home, "new-feature.txt"), "untracked behavior\n");
    assert.throws(() => resolveExactAppSourceRef(home), /uncommitted work/);
    assert.equal(resolveExactAppSourceRef(home, ref), ref, "an explicit immutable source deliberately excludes working changes");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release cutter CLI fails closed for missing, flag-shaped, and duplicate single values", () => {
  const script = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url));
  const singleValueCases = [
    ['--bump', 'patch'],
    ['--version', '1.2.3'],
    ['--source-ref', 'HEAD'],
    ['--engine-source-ref', 'a'.repeat(40)],
    ['--readiness-evidence', 'readiness.json'],
    ['--readiness-output', 'private-readiness.json'],
    ['--repo', 'repo'],
    ['--staging', 'staging'],
    ['--build-dir', 'build'],
    ['--seal-control', 'control.json'],
    ['--gates-only', 'worktree'],
    ['--gate-source', 'repo'],
    ['--evidence-out', 'record.json'],
    ['--resume-from', 'worktree'],
  ];
  for (const [option, validValue] of singleValueCases) {
    for (const suffix of [[], [''], ['-h'], ['--test'], [validValue, option, validValue]]) {
      const argv = ['--help', option, ...suffix];
      const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${argv.join(' ')} silently crossed the command boundary`);
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`${option} (?:requires|accepts)`));
    }
  }
});

test("release cutter CLI keeps repeatable values but refuses empty repeatable occurrences", () => {
  const script = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url));
  for (const argv of [
    ['--help', '--other-candidate-root'],
    ['--help', '--other-candidate-root', ''],
    ['--help', '--other-candidate-root', '--test'],
    ['--help', '--known-fix'],
    ['--help', '--known-fix', ''],
    ['--help', '--known-fix', '--test'],
    ['--help', '--gates-only', 'wt', '--gate'],
    ['--help', '--gates-only', 'wt', '--gate', ''],
    ['--help', '--resume-from', 'wt', '--skip-verified'],
    ['--help', '--resume-from', 'wt', '--skip-verified', '--test'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${argv.join(' ')} silently crossed the command boundary`);
    assert.match(`${result.stdout}\n${result.stderr}`, /--(?:other-candidate-root|known-fix|gate|skip-verified) requires one/);
  }

  const valid = spawnSync(process.execPath, [script,
    '--help',
    '--other-candidate-root', 'one',
    '--other-candidate-root', 'two',
    '--known-fix', 'first::source-only',
    '--known-fix', 'second::observed::seen',
  ], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);

  // --gate repeats too, but only in --gates-only mode (a gates-only run never declares, so it refuses --known-fix).
  const validGates = spawnSync(process.execPath, [script,
    '--help',
    '--gates-only', 'wt',
    '--gate', 'install-dir',
    '--gate', 'smoke-packaged',
  ], { encoding: 'utf8' });
  assert.equal(validGates.status, 0, validGates.stderr);
});

// --- incremental gate flags: a flag that parses and is ignored is worse than one that refuses ---
test("incremental gate flags refuse combinations in which one of them would silently do nothing", () => {
  const cases = [
    [['--gates-only', 'a', '--resume-from', 'b'], /different modes/],
    [['--gate', 'install-dir'], /--gate selects gates for --gates-only/],
    [['--evidence-out', 'r.json'], /--evidence-out names the --gates-only record/],
    [['--skip-verified', 'r.json'], /--skip-verified feeds evidence to --resume-from/],
    [['--resume-from', 'wt', '--build-dir', 'other'], /--build-dir does not apply/],
    [['--resume-from', 'wt', '--seal-control', 'c.json'], /cannot replay its phases/],
    [['--gates-only', 'wt', '--advance-branch'], /never advances a branch/],
    [['--gates-only', 'wt', '--known-fix', 'x::observed'], /never advances a branch/],
  ];
  for (const [argv, expected] of cases) {
    assert.throws(() => assertGateFlagCombination(parseArgsForTest(argv)), expected, argv.join(' '));
  }
  // The valid shapes pass through untouched.
  assert.doesNotThrow(() => assertGateFlagCombination({ gatesOnly: 'wt', gates: ['install-dir'], evidenceOut: 'r.json' }));
  assert.doesNotThrow(() => assertGateFlagCombination({ resumeFrom: 'wt', skipVerified: ['r.json'], keepWorktree: true }));
});

function parseArgsForTest(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flag === '--gate' || flag === '--skip-verified' || flag === '--known-fix') {
      const plural = flag === '--gate' ? 'gates' : flag === '--skip-verified' ? 'skipVerified' : 'knownFixes';
      (args[plural] ??= []).push(argv[++i]);
    } else if (flag === '--advance-branch') args.advanceBranch = true;
    else args[key] = argv[++i];
  }
  return args;
}

// --- lib/gate-evidence.mjs ------------------------------------------------------
//
// A fixture stands in for a build worktree: a sealed unpacked tree, a seal
// file, an installer, and a gate source whose "gates" are two tiny scripts.
// The gate table is injected so these tests never start the real product;
// what they prove is the binding -- that a record can be consumed only by the
// bytes and harness that produced it -- which is the whole safety argument.
async function makeGateFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "gate-evidence-"));
  const worktree = path.join(root, "wt");
  const unpacked = path.join(worktree, "release", "win-unpacked");
  await mkdir(unpacked, { recursive: true });
  await writeFile(path.join(unpacked, "app.txt"), "packaged bytes\n");
  /* T392: a seal that records no built commit is refused by --verify, so this
     fixture states its provenance the way a real artifact does -- the marker
     dist/.dist-source.json packed under resources/app -- and the seal binds to
     it. A seal without it stands in for an artifact that could not be published
     at all, which is not the thing these gate-binding tests are about. */
  const builtSha = "d".repeat(40);
  await mkdir(path.join(unpacked, "resources", "app", "dist"), { recursive: true });
  await writeFile(path.join(unpacked, "resources", "app", "dist", ".dist-source.json"),
    `${JSON.stringify({ schemaVersion: 1, appHead: builtSha })}\n`);
  const payload = await measureFile(path.join(unpacked, "app.txt"));
  const marker = await measureFile(path.join(unpacked, "resources", "app", "dist", ".dist-source.json"));
  await writeFile(path.join(worktree, "release", ".artifact-seal-win-unpacked.json"),
    JSON.stringify({ version: 1, artifact: "win-unpacked", recordedAt: "2026-09-02T01:41:01.439Z",
      builtSha, recordedHead: builtSha, treeClean: true,
      files: {
        "app.txt": { kind: "file", sha256: payload.sha256.toLowerCase(), bytes: payload.bytes },
        "resources/app/dist/.dist-source.json": { kind: "file", sha256: marker.sha256.toLowerCase(), bytes: marker.bytes },
      } }));
  await writeFile(path.join(worktree, "release", "ToolsEnabled Setup 9.9.9.exe"), "installer bytes\n");
  await writeFile(path.join(worktree, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const source = path.join(root, "harness");
  await mkdir(path.join(source, "tools"), { recursive: true });
  await writeFile(path.join(source, "tools", "pass.mjs"), "console.log('gate ok ' + process.argv.slice(2).join(' '))\n");
  await writeFile(path.join(source, "tools", "fail.mjs"), "console.error('gate red'); process.exitCode = 3\n");
  const gates = [
    { name: "first", argv: ["tools/pass.mjs", "release/win-unpacked"], skippable: false, runsInCutTail: false },
    { name: "second", argv: ["tools/pass.mjs", "release"], skippable: true, runsInCutTail: false },
    { name: "third", argv: ["tools/pass.mjs", "--release", "release/win-unpacked"], skippable: true, runsInCutTail: true },
  ];
  const clean = { ref: "c".repeat(40), dirty: false };
  return { root, worktree, source, gates, clean, log: () => {} };
}

test("describeArtifact binds to the seal file hash and the installer bytes, and refuses a worktree with no seal", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    assert.equal(artifact.installer.filename, "ToolsEnabled Setup 9.9.9.exe");
    assert.equal(artifact.sealRecordedAt, "2026-09-02T01:41:01.439Z");
    assert.match(artifact.sealSha256, /^[0-9A-F]{64}$/);
    assert.match(artifact.installer.sha256, /^[0-9A-F]{64}$/);
    await rm(path.join(fx.worktree, "release", ".artifact-seal-win-unpacked.json"));
    await assert.rejects(() => describeArtifact(fx.worktree, "9.9.9"), /seal-artifact\.mjs --record never ran/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("runGates records every gate against the artifact and harness, stops at the first red gate, and writes after each gate", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    const evidencePath = path.join(fx.worktree, "release", ".gate-evidence-test.json");
    const gates = [fx.gates[0], { name: "red", argv: ["tools/fail.mjs", "release"], skippable: true, runsInCutTail: false }, fx.gates[1]];
    const result = await runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source, gates, artifact, gateSourceState: fx.clean, evidencePath, log: fx.log });
    assert.equal(result.ok, false);
    assert.equal(result.failed, "red");
    const record = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(record.schema, "toolsenabled.gate-evidence");
    assert.equal(record.ok, false);
    assert.deepEqual(record.gates.map((g) => [g.name, g.status, g.exitCode]), [["first", "passed", 0], ["red", "failed", 3]],
      "the gate after the red one must not have run");
    assert.equal(record.artifact.sealSha256, artifact.sealSha256);
    assert.equal(record.artifact.installer.sha256, artifact.installer.sha256);
    assert.equal(record.gateSource.ref, fx.clean.ref);
    assert.match(record.gates[0].gateScriptSha256, /^[0-9A-F]{64}$/);
    assert.match(record.gates[1].outputSha256, /^[0-9A-F]{64}$/);
    assert.equal(Object.hasOwn(record.gates[1], "outputTail"), false, "release evidence must not copy private console diagnostics");
    assert.match(result.combinedOutput, /gate ok release\/win-unpacked/);
    assert.doesNotThrow(() => assertGateWorktreeAvailable(fx.worktree), "an ordinary observed nonzero exit is safely retryable");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("selectSkippableGates accepts only an exit-0 record by unchanged script bytes from a clean harness against the same seal and installer", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    const evidencePath = path.join(fx.worktree, "release", ".gate-evidence-green.json");
    const green = await runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source, gates: fx.gates, artifact, gateSourceState: fx.clean, evidencePath, log: fx.log });
    assert.equal(green.ok, true);

    const base = { evidencePaths: [evidencePath], gateSourcePath: fx.source, gates: fx.gates, gateSourceState: fx.clean, log: fx.log };

    // 1. The happy path: skippable gates accepted, the never-skippable one rejected by rule.
    const accepted = await selectSkippableGates({ ...base, artifact });
    assert.deepEqual([...accepted.accepted.keys()].sort(), ["second", "third"]);
    assert.deepEqual(accepted.rejected.map((r) => [r.name, /never be skipped/.test(r.reason)]), [["first", true]]);
    assert.equal(accepted.accepted.get("second").gateSourceRef, fx.clean.ref);
    assert.equal(accepted.accepted.get("second").sealSha256, artifact.sealSha256);

    // 2. Different installer bytes: nothing is accepted, and the reason names the artifact.
    const otherInstaller = { ...artifact, installer: { ...artifact.installer, sha256: "0".repeat(64) } };
    const wrongBytes = await selectSkippableGates({ ...base, artifact: otherInstaller });
    assert.equal(wrongBytes.accepted.size, 0);
    assert.match(wrongBytes.rejected[0].reason, /different artifact bytes/);

    // 3. Different seal (same installer): also nothing.
    const wrongSeal = await selectSkippableGates({ ...base, artifact: { ...artifact, sealSha256: "1".repeat(64) } });
    assert.equal(wrongSeal.accepted.size, 0);

    // 4. The current harness is dirty: nothing, even though the record was clean.
    const dirtyNow = await selectSkippableGates({ ...base, artifact, gateSourceState: { ref: fx.clean.ref, dirty: true } });
    assert.equal(dirtyNow.accepted.size, 0);
    assert.match(dirtyNow.rejected[0].reason, /current gate checkout has uncommitted changes/);

    // An unchanged entry script can import a changed helper from a new commit.
    const changedHelper = await selectSkippableGates({ ...base, artifact, gateSourceState: { ref: "d".repeat(40), dirty: false } });
    assert.equal(changedHelper.accepted.size, 0);
    assert.match(changedHelper.rejected[0].reason, /harness commit changed/);

    // 5. The gate script changed since the record: every gate that shares it is rejected.
    await writeFile(path.join(fx.source, "tools", "pass.mjs"), "console.log('gate ok, but different bytes')\n");
    const changedScript = await selectSkippableGates({ ...base, artifact });
    assert.equal(changedScript.accepted.size, 0, "every fixture gate shares pass.mjs, so all of them must be rejected");
    assert.ok(changedScript.rejected.some((r) => /gate script has changed/.test(r.reason)));
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a record written from a dirty harness is never accepted, and a skipped gate is recorded as skipped, not passed", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    const dirtyPath = path.join(fx.worktree, "release", ".gate-evidence-dirty.json");
    await runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source, gates: fx.gates, artifact, gateSourceState: { ref: "d".repeat(40), dirty: true }, evidencePath: dirtyPath, log: fx.log });
    const fromDirty = await selectSkippableGates({ evidencePaths: [dirtyPath], artifact, gateSourcePath: fx.source, gates: fx.gates, gateSourceState: fx.clean, log: fx.log });
    assert.equal(fromDirty.accepted.size, 0);
    assert.match(fromDirty.rejected[0].reason, /uncommitted changes; that harness is not reproducible/);

    const cleanPath = path.join(fx.worktree, "release", ".gate-evidence-clean.json");
    await runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source, gates: fx.gates, artifact, gateSourceState: fx.clean, evidencePath: cleanPath, log: fx.log });
    const { accepted } = await selectSkippableGates({ evidencePaths: [cleanPath], artifact, gateSourcePath: fx.source, gates: fx.gates, gateSourceState: fx.clean, log: fx.log });
    const resumed = await runGates({
      worktreePath: fx.worktree, gateSourcePath: fx.source, gates: fx.gates.filter((g) => !g.runsInCutTail), skip: accepted, artifact, gateSourceState: fx.clean,
      evidencePath: path.join(fx.worktree, "release", ".gate-evidence-resumed.json"), log: fx.log,
    });
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.record.gates.map((g) => [g.name, g.status]), [["first", "passed"], ["second", "skipped-with-evidence"]]);
    assert.equal(resumed.record.gates[1].exitCode, null);
    assert.equal(resumed.record.gates[1].evidence.path, path.basename(cleanPath));
    assert.equal(JSON.stringify(resumed.record).includes(fx.root), false, "evidence stored with release output carries no absolute profile paths");

    const summary = summarizeGateRun(resumed, { mode: "resumed" });
    assert.equal(summary.mode, "resumed");
    assert.equal(summary.gates[1].evidence.file, ".gate-evidence-clean.json", "the declaration-facing summary carries basenames only");
    assert.equal(summary.sealSha256, artifact.sealSha256);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("the real gate table brackets everything with two unskippable seal verifications and covers every post-packaging dist command", async () => {
  assert.equal(POST_BUILD_GATES[0].name, "seal-verify-before");
  assert.equal(POST_BUILD_GATES.at(-1).name, "seal-verify-after");
  assert.equal(POST_BUILD_GATES[0].skippable, false);
  assert.equal(POST_BUILD_GATES.at(-1).skippable, false);
  for (const name of ["artifact-private", "smoke-packaged", "install-dir", "packaged-qa"]) {
    assert.equal(POST_BUILD_GATES.find((g) => g.name === name).skippable, false, `${name} must freshly check the resumed candidate`);
  }
  assert.equal(POST_BUILD_GATES.find((g) => g.name === "artifact-private").skippable, false,
    "the current building account is a live input to the private-artifact check");
  assert.ok(POST_BUILD_GATES.every((g) => !g.argv.includes("--record")), "a resume must never re-seal a tree whose provenance is in question");
  assert.ok(POST_BUILD_GATES.some((g) => g.name === "packaged-qa" && g.runsInCutTail), "packaged QA stays in the cut tail so the declared order matches a fresh cut");
  assert.deepEqual(selectGates(["install-dir", "smoke-packaged"]).map((g) => g.name), ["smoke-packaged", "install-dir"], "selection keeps table order, not argument order");
  assert.throws(() => selectGates(["no-such-gate"]), /unknown gate name/);
  // Every post-packaging command in package.json's dist chain after electron-builder has a named gate here.
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const distCommands = JSON.parse(await readFile(path.join(testDir, "..", "..", "package.json"), "utf8")).scripts.dist.split(/\s*&&\s*/);
  const afterBuilder = distCommands.slice(distCommands.findIndex((c) => /electron-builder/.test(c)) + 1)
    .filter((c) => !/seal-artifact\.mjs --record/.test(c))
    .map((c) => c.replace(/^node\s+/, ""));
  assert.ok(afterBuilder.length >= 8, `expected the dist chain to carry post-packaging gates, saw ${afterBuilder.length}`);
  for (const command of afterBuilder) {
    const [script, ...rest] = command.split(/\s+/);
    assert.ok(POST_BUILD_GATES.some((g) => g.argv[0] === script && rest.every((arg) => g.argv.includes(arg))),
      `dist command "${command}" has no named gate in POST_BUILD_GATES; a resumed cut would silently skip it`);
  }
});

test("gate evidence refuses edited unpacked bytes even when the old seal and installer remain unchanged", async () => {
  const fx = await makeGateFixture();
  try {
    await writeFile(path.join(fx.worktree, "release", "win-unpacked", "app.txt"), "different bytes\n");
    await assert.rejects(() => describeArtifact(fx.worktree, "9.9.9"), /artifact seal verification failed/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("one selected gate cannot record a pass after mutating the sealed input", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    await writeFile(path.join(fx.source, "tools", "mutate.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('release/win-unpacked/app.txt', 'changed by gate');\n");
    const evidencePath = path.join(fx.worktree, "release", ".gate-evidence-mutation.json");
    await assert.rejects(() => runGates({
      worktreePath: fx.worktree, gateSourcePath: fx.source,
      gates: [{ name: "mutation", argv: ["tools/mutate.mjs"], skippable: true }],
      artifact, gateSourceState: fx.clean, evidencePath, log: fx.log,
    }), /artifact seal verification failed/);
    const record = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(record.ok, null);
    assert.deepEqual(record.gates.map(gate => [gate.status, gate.exitCode]), [["pending-artifact-verification", 0]],
      "the command outcome is retained, but failed post-seal verification cannot produce a pass");
    const reuse = await selectSkippableGates({
      evidencePaths: [evidencePath], artifact, gateSourcePath: fx.source,
      gates: [{ name: "mutation", argv: ["tools/mutate.mjs"], skippable: true }],
      gateSourceState: fx.clean, log: fx.log,
    });
    assert.equal(reuse.accepted.size, 0);
    assert.match(reuse.rejected[0].reason, /incomplete/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("artifact identities require measured hashes and non-empty installers", () => {
  assert.equal(sameArtifact({}, {}), false);
  assert.equal(sameArtifact({ sealSha256: "a", installer: {} }, { sealSha256: "a", installer: {} }), false);
});

for (const scenario of [
  { name: "timeout", script: "setInterval(() => {}, 1000)\n", timeoutMs: 150, maxOutputBytes: 1024, reason: /timed out/ },
  { name: "output cap", script: "console.log('x'.repeat(4096)); setInterval(() => {}, 1000)\n", timeoutMs: 10000, maxOutputBytes: 1024, reason: /output exceeded/ },
]) {
  test(`a gate ${scenario.name} is a recorded failure and its owned process is stopped`, async () => {
    const fx = await makeGateFixture();
    try {
      const artifact = await describeArtifact(fx.worktree, "9.9.9");
      await writeFile(path.join(fx.source, "tools", "bounded.mjs"),
        "import { writeFileSync } from 'node:fs'; writeFileSync('release/win-unpacked/app.txt', 'changed by timed-out fixture');\n" + scenario.script);
      const gates = [fx.gates[1], { name: "bounded", argv: ["tools/bounded.mjs"], skippable: false, timeoutMs: scenario.timeoutMs, maxOutputBytes: scenario.maxOutputBytes }];
      const evidencePath = path.join(fx.worktree, "release", ".gate-evidence-bounded.json");
      const result = await runGates({
        worktreePath: fx.worktree, gateSourcePath: fx.source,
        gates,
        artifact, gateSourceState: fx.clean,
        evidencePath, log: fx.log,
      });
      assert.equal(result.ok, false);
      const failed = result.record.gates.at(-1);
      assert.equal(failed.status, "failed");
      assert.equal(failed.exitCode, null);
      assert.match(failed.failureReason, scenario.reason);
      assert.equal(failed.terminationConfirmed, false, 'root closure does not prove descendant cleanup');
      assert.match(failed.failureReason, /UNCONFIRMED/);
      assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), result.record,
        "uncertain failure is persisted without starting a post-seal verifier on the changed artifact");
      const reuse = await selectSkippableGates({ evidencePaths: [evidencePath], artifact,
        gateSourcePath: fx.source, gates, gateSourceState: fx.clean, log: fx.log });
      assert.equal(reuse.accepted.size, 0, "an earlier passed row cannot escape the uncertain run");
      assert.match(reuse.rejected[0].reason, /unconfirmed/);
      await assert.rejects(() => describeArtifact(fx.worktree, "9.9.9"), /incomplete or unconfirmed previous execution/);
      const alternate = path.join(fx.worktree, "release", "alternate-evidence.json");
      await assert.rejects(() => runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source,
        gates, artifact, gateSourceState: fx.clean, evidencePath: alternate, log: fx.log }),
      /incomplete or unconfirmed previous execution/);
      await assert.rejects(() => access(alternate), { code: "ENOENT" });
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
}

test("gate uncertainty retains its pre-armed refusal even when the failure evidence cannot be written", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    const evidencePath = path.join(fx.worktree, "release", "unwritable-evidence.json");
    await writeFile(path.join(fx.source, "tools", "block-evidence.mjs"),
      `import { unlinkSync, mkdirSync } from 'node:fs';
      unlinkSync(${JSON.stringify(evidencePath)}); mkdirSync(${JSON.stringify(evidencePath)});
      console.log('x'.repeat(4096)); setInterval(() => {}, 1000);\n`);
    await assert.rejects(() => runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source,
      gates: [{ name: "block-evidence", argv: ["tools/block-evidence.mjs"], skippable: false, maxOutputBytes: 1024 }],
      artifact, gateSourceState: fx.clean, evidencePath, log: fx.log }), /EISDIR|EPERM|EACCES/);
    assert.throws(() => assertGateWorktreeAvailable(fx.worktree), /incomplete or unconfirmed previous execution/);
    await assert.rejects(() => runGates({ worktreePath: fx.worktree, gateSourcePath: fx.source,
      gates: fx.gates, artifact, gateSourceState: fx.clean, evidencePath: path.join(fx.root, "alternate.json"), log: fx.log }),
    /incomplete or unconfirmed previous execution/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("release cutter quarantine refuses both CLI retry modes before verifiers even with alternate evidence", async () => {
  const fx = await makeGateFixture();
  try {
    await mkdir(path.join(fx.worktree, "release", ".gate-execution-in-flight"));
    // Deliberately invalid inputs: the durable guard must be the first refusal,
    // before package/seal reads, source Git probes, or creating a staging slot.
    await writeFile(path.join(fx.worktree, "package.json"), "invalid package data");
    const cutter = fileURLToPath(new URL("../release-packager/cut-release-candidate.mjs", import.meta.url));
    const alternate = path.join(fx.root, "alternate.json");
    const staging = path.join(fx.root, "must-not-create-staging");
    for (const args of [
      ["--gates-only", fx.worktree, "--gate-source", fx.source, "--evidence-out", alternate],
      ["--resume-from", fx.worktree, "--repo", fx.source, "--skip-verified", alternate, "--staging", staging],
    ]) {
      const result = spawnSync(process.execPath, [cutter, ...args], {
        cwd: fx.root, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024,
      });
      assert.equal(result.status, 1, result.error?.message || result.stderr);
      assert.match(result.stderr, /incomplete or unconfirmed previous execution/);
      assert.doesNotMatch(result.stderr, /artifact seal verification failed|source-ref must|Unexpected token|not a git repository/);
    }
    await assert.rejects(() => access(alternate), { code: "ENOENT" });
    await assert.rejects(() => access(staging), { code: "ENOENT" });
    const source = await readFile(cutter, "utf8");
    assert.match(source, /pipelineFacts\.verifySummary = extractPipelineFacts\(strictTests\.output\)\.verifySummary/,
      "the bounded runner's combined output must preserve the strict test summary in the declaration");
    assert.doesNotMatch(source, /strictTests\.(stdout|stderr)/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a never-skippable gate still runs when a caller supplies a skip map", async () => {
  const fx = await makeGateFixture();
  try {
    const artifact = await describeArtifact(fx.worktree, "9.9.9");
    const result = await runGates({
      worktreePath: fx.worktree, gateSourcePath: fx.source, gates: [fx.gates[0]],
      skip: new Map([["first", {}]]), artifact, gateSourceState: fx.clean,
      evidencePath: path.join(fx.worktree, "release", ".gate-evidence-unskippable.json"), log: fx.log,
    });
    assert.equal(result.record.gates[0].status, "passed");
    assert.match(result.combinedOutput, /gate ok/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("renderDeclaration says plainly when a cut was resumed, lists every gate, and names the evidence behind each skip", () => {
  const facts = resumedFacts();
  const markdown = renderDeclaration(facts);
  assert.match(markdown, /did NOT exit 0 in the original run of this cut/);
  assert.match(markdown, /## Resumed cut -- post-packaging gates re-run against the sealed artifact/);
  assert.match(markdown, /\| `install-dir` \| passed \(exit 0\) \|/);
  assert.match(markdown, /\| `smoke-packaged` \| skipped -- evidence-bound \| record `\.gate-evidence-green\.json`, exit 0 recorded 2026-09-02T02:15:18\.993Z by harness commit `e{40}`/);
  assert.match(markdown, /packaged QA suite was NOT re-run in this resumed cut/);
  assert.match(markdown, new RegExp(`seal file SHA-256 \`${"A".repeat(64)}\``));
  // A fresh cut renders none of it.
  const fresh = renderDeclaration({ ...facts, gateRun: null, pipeline: { ...facts.pipeline, resumed: false, packagedQaExitCode: 0, packagedQaEvidence: undefined } });
  assert.doesNotMatch(fresh, /Resumed cut/);
  assert.match(fresh, /single unbroken run/);
});

function resumedFacts() {
  return {
    test: false,
    date: "2026-09-02",
    version: "1.0.40",
    previousVersion: "1.0.38",
    branch: "release/x",
    sourceRef: "a".repeat(40),
    engineSourceRef: "b".repeat(40),
    buildRef: "c".repeat(40),
    branchAdvanced: false,
    branchAdvanceError: null,
    candidate: { filename: "ToolsEnabled Setup 1.0.40.exe", bytes: 1, sha256: "D".repeat(64) },
    publisher: "ToolsEnabled",
    treeState: { worktreeRemoved: false, buildInfoConfirmedClean: true },
    versionInfo: { companyName: "ToolsEnabled", productName: "ToolsEnabled", fileVersion: "1.0.40", productVersion: "1.0.40", legalCopyright: "c" },
    appId: { configured: "com.toolsenabled.desktop" },
    unsigned: { signExecutable: false },
    pipeline: { resumed: true, distExitCode: null, packagedQaExitCode: null, packagedQaEvidence: { file: ".gate-evidence-green.json", recordedAt: "2026-09-02T02:15:18.993Z", gateSourceRef: "e".repeat(40), sealSha256: "A".repeat(64) } },
    excludedWip: { measuredAt: "2026-09-02T00:00:00.000Z", dirtyFiles: [] },
    otherCandidates: [],
    stagingDir: "%USERPROFILE%\\Desktop\\ToolsEnabled-INSTALLER-CANDIDATE\\1.0.40",
    privateInputsCopied: [],
    privateInputsSkippedTracked: [],
    knownFixes: [],
    gateRun: {
      mode: "resumed",
      ok: true,
      gateSourceRef: "e".repeat(40),
      sealSha256: "A".repeat(64),
      sealRecordedAt: "2026-09-02T01:41:01.439Z",
      gates: [
        { name: "seal-verify-before", status: "passed", exitCode: 0, gateScriptSha256: "1".repeat(64) },
        { name: "smoke-packaged", status: "skipped-with-evidence", exitCode: null, gateScriptSha256: "2".repeat(64), evidence: { file: ".gate-evidence-green.json", recordedAt: "2026-09-02T02:15:18.993Z", gateSourceRef: "e".repeat(40) } },
        { name: "install-dir", status: "passed", exitCode: 0, gateScriptSha256: "3".repeat(64) },
        { name: "seal-verify-after", status: "passed", exitCode: 0, gateScriptSha256: "1".repeat(64) },
      ],
    },
  };
}

// --- cut-release-candidate.mjs: copyPrivateInputs ------------------------------
//
// Regression test for a real bug a first end-to-end test run of the packager
// actually hit: private/ contains a mix of genuinely untracked, per-builder
// files (copy them in) and files that are committed to git with their own
// reviewed content despite living under the same directory (leave them
// alone -- overwriting them with whatever is on the live machine dirties an
// otherwise-clean isolated worktree and silently discards reviewed content).

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

test("candidate tags are idempotent at one commit and refuse every attempted move", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-tag-"));
  try {
    const repo = path.join(home, "repo");
    await mkdir(repo, { recursive: true });
    git(["init", "--initial-branch=main"], repo);
    git(["config", "user.email", "fixture@example.com"], repo);
    git(["config", "user.name", "Fixture"], repo);
    await writeFile(path.join(repo, "one.txt"), "one\n");
    git(["add", "one.txt"], repo);
    git(["commit", "-m", "one"], repo);
    const first = git(["rev-parse", "HEAD"], repo).trim();

    assert.deepEqual(tagCommit(repo, "build/1.0.1", first), {
      created: true,
      tag: "build/1.0.1",
      commit: first,
    });
    assert.equal(tagCommit(repo, "build/1.0.1", first).created, false, "same-ref retry should be harmless");

    await writeFile(path.join(repo, "two.txt"), "two\n");
    git(["add", "two.txt"], repo);
    git(["commit", "-m", "two"], repo);
    const second = git(["rev-parse", "HEAD"], repo).trim();
    assert.throws(() => tagCommit(repo, "build/1.0.1", second), /refusing to move immutable candidate tag/);
    assert.equal(git(["rev-parse", "build\/1.0.1^{commit}"], repo).trim(), first);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("copyPrivateInputs copies untracked private/ files but leaves git-tracked ones as their committed content", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  try {
    const repo = path.join(home, "repo");
    const worktree = path.join(home, "worktree");
    await mkdir(path.join(repo, "private"), { recursive: true });

    git(["init", "--initial-branch=main", repo], home);
    git(["config", "user.email", "fixture@example.com"], repo);
    git(["config", "user.name", "Fixture"], repo);

    // Mirror the real repo's .gitignore: a blanket `/private/` rule that
    // does NOT retroactively untrack a file already force-added (below) --
    // this is the exact shape that made the real bug surprising.
    await writeFile(path.join(repo, ".gitignore"), "/private/\n");
    git(["add", "--", ".gitignore"], repo);

    // A file that IS committed to git, mirroring private/research-queue.authored.json.
    await writeFile(path.join(repo, "private", "tracked.json"), '{"committed":true}\n');
    git(["add", "--force", "--", "private/tracked.json"], repo);
    git(["commit", "-m", "add tracked private fixture"], repo);

    // Simulate the worktree: a second checkout of the same commit.
    git(["worktree", "add", "--detach", worktree, "HEAD"], repo);

    // Now the SOURCE repo's live private/ has drifted from what's committed
    // (as it legitimately does day to day), plus a genuinely new, untracked file.
    await writeFile(path.join(repo, "private", "tracked.json"), '{"committed":true,"localDrift":true}\n');
    await writeFile(path.join(repo, "private", "owner-data-patterns.owner.json"), '{"patterns":["fixture-owner"]}\n');

    const result = await copyPrivateInputs(repo, worktree, { log: () => {} });

    assert.deepEqual(result.copied.sort(), ["owner-data-patterns.owner.json"]);
    assert.deepEqual(result.skippedTracked.sort(), ["tracked.json"]);

    const copiedContent = await readFile(path.join(worktree, "private", "owner-data-patterns.owner.json"), "utf8");
    assert.match(copiedContent, /fixture-owner/);

    // The tracked file in the worktree must be untouched -- still its
    // committed content, not the source repo's locally-drifted version.
    const trackedInWorktree = await readFile(path.join(worktree, "private", "tracked.json"), "utf8");
    assert.doesNotMatch(trackedInWorktree, /localDrift/);
    assert.match(trackedInWorktree, /"committed":true/);

    const status = git(["status", "--porcelain"], worktree);
    assert.equal(status.trim(), "", `worktree must remain clean after copyPrivateInputs; git status reported:\n${status}`);
  } finally {
    // Windows worktree metadata can hold a brief file lock right after
    // `git worktree add`; retry the cleanup instead of failing the test on it.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- serve-candidate.mjs: --detach --------------------------------------------
//
// Regression test for a real bug found during the 1.0.2 transfer: three of
// four server instances launched through an agent session's own background-
// task mechanism (`nohup ... &` and equivalents) died when that mechanism's
// process tree was torn down, even though the launching command itself had
// already returned successfully. `--detach` re-spawns a genuinely OS-detached
// child (`detached: true` + `unref()`) and exits the launcher immediately --
// this test proves the child answers real HTTP requests correctly and that
// the token is never written into the child's redirected log file, which is
// as much of "survives the launcher exiting" as a single test process can
// exercise without spawning a second harness process to simulate the
// original failure mode (verified manually, across genuinely separate tool
// calls, when this fix was built).

const SERVE_CANDIDATE_PATH = fileURLToPath(new URL("../release-packager/serve-candidate.mjs", import.meta.url));
const VERIFY_CANDIDATE_PATH = fileURLToPath(new URL("../release-packager/verify-candidate.ps1", import.meta.url));

function extractServeOutput(stdout) {
  const tokenMatch = /^\[serve-candidate\] token \([^\r\n]+\):\s*\r?\n\s*([0-9a-f]{64})/m.exec(stdout);
  const pidMatch = /detached: PID (\d+)/.exec(stdout);
  return { token: tokenMatch?.[1], pid: pidMatch ? Number(pidMatch[1]) : null };
}

async function killIfAlive(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone -- fine, this is cleanup.
  }
}

test("serve-candidate.mjs --detach survives the launcher exiting, serves correctly, and never logs the token", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-test-"));
  const port = 47900 + Math.floor(Math.random() * 500); // avoid colliding with a real transfer or another test run
  let childPid = null;
  try {
    const dummyFile = path.join(home, "dummy-candidate.bin");
    const fileBytes = Buffer.from("regression-test-payload-for-detach-mode");
    await writeFile(dummyFile, fileBytes);
    const logFile = path.join(home, "detach.log");

    // The launcher process: runs to completion and exits, exactly like the
    // real failure mode's launching command did. If --detach only looked
    // like it worked while sharing this test's own process tree, this
    // `spawnSync` (waited on fully, no `detached` on OUR side) still proves
    // nothing survives past it unless the CHILD is genuinely independent.
    const launch = spawnSync(process.execPath, [
      SERVE_CANDIDATE_PATH, dummyFile,
      "--bind", "127.0.0.1", "--port", String(port),
      "--force-bind-any", "--once", "--detach", "--log-file", logFile,
    ], { encoding: "utf8" });

    assert.equal(launch.status, 0, launch.stderr);
    const { token, pid } = extractServeOutput(launch.stdout);
    assert.ok(token, `expected a token in launcher output:\n${launch.stdout}`);
    assert.ok(pid, `expected a detached PID in launcher output:\n${launch.stdout}`);
    childPid = pid;

    // Give the detached child a moment to finish binding (the launcher
    // returning does not guarantee the child's server.listen() callback has
    // already fired).
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Wrong token must fail -- auth is enforced in detached mode too.
    const candidateUrl = `http://127.0.0.1:${port}/candidate`;
    const denied = await fetch(candidateUrl, {
      headers: { Authorization: "Bearer wrong" }, signal: AbortSignal.timeout(2000),
    });
    assert.equal(denied.status, 401, "a wrong token must reach the server and be refused");
    await denied.arrayBuffer();

    // Correct token must succeed and return the exact bytes.
    const accepted = await fetch(candidateUrl, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000),
    });
    assert.equal(accepted.status, 200);
    const fetched = Buffer.from(await accepted.arrayBuffer());
    assert.deepEqual(fetched, fileBytes);

    // --once must have shut the detached child down after that success.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(fetch(candidateUrl, { signal: AbortSignal.timeout(2000) }));

    // The one property this whole design exists to guarantee: the token
    // must never appear in the child's redirected log file.
    const logContent = await readFile(logFile, "utf8");
    assert.doesNotMatch(logContent, new RegExp(token), "the token must never be written to the detached child's log file");
  } finally {
    await killIfAlive(childPid);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("verify-candidate.ps1 independently accepts exact bytes and refuses byte-count or hash mismatches", {
  skip: process.platform !== "win32",
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-verifier-test-"));
  try {
    const candidate = path.join(home, "ToolsEnabled candidate bytes.bin");
    await writeFile(candidate, Buffer.from("independently measured candidate\n", "utf8"));
    const measured = await measureFile(candidate);
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const invoke = (bytes, sha256, env = process.env) => spawnSync(powershell, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VERIFY_CANDIDATE_PATH,
      "-ExistingFile", candidate,
      "-ExpectedBytes", String(bytes),
      "-ExpectedSha256", sha256,
    ], { encoding: "utf8", env, windowsHide: true, timeout: 15_000 });

    const exact = invoke(measured.bytes, measured.sha256);
    assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`);
    assert.match(exact.stdout, /VERIFIED: .*byte count and SHA-256 both confirmed independently/);

    const wrongBytes = invoke(measured.bytes + 1, measured.sha256);
    assert.notEqual(wrongBytes.status, 0, "a mismatched byte count was accepted");
    assert.match(`${wrongBytes.stdout}\n${wrongBytes.stderr}`, /byte count mismatch/);

    const wrongHash = invoke(measured.bytes, "0".repeat(64));
    assert.notEqual(wrongHash.status, 0, "a mismatched SHA-256 was accepted");
    assert.match(`${wrongHash.stdout}\n${wrongHash.stderr}`, /SHA-256 mismatch/);

    const incompatibleModules = path.join(home, "empty-module-directory");
    await mkdir(incompatibleModules);
    const withoutHashCmdlet = invoke(measured.bytes, measured.sha256, { ...process.env, PSModulePath: incompatibleModules });
    assert.equal(withoutHashCmdlet.status, 0, `${withoutHashCmdlet.stdout}\n${withoutHashCmdlet.stderr}`);
    await writeFile(candidate, Buffer.alloc(measured.bytes, 65));
    const tampered = invoke(measured.bytes, measured.sha256, { ...process.env, PSModulePath: incompatibleModules });
    assert.notEqual(tampered.status, 0, "same-size tampering was accepted without a hash cmdlet");
    assert.match(`${tampered.stdout}\n${tampered.stderr}`, /SHA-256 mismatch/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- staging-collision.mjs --------------------------------------------------
//
// The other half of version-bump.mjs's rule. computeNextVersion() compares the
// new number against package.json's, and package.json does not advance unless
// --advance-branch was used -- so two cuts from two DIFFERENT tips compute the
// same "next" version, and the second one used to copy straight over the first
// one's installer AND its declaration. Measured for real on 2026-08-12 (R1531
// w1): 1.0.7 staged from e521606, the next cut from f8be6ed computed 1.0.7.

test("an empty or missing staging slot is free", () => {
  assert.equal(classifyStagedCandidate({ entries: [], version: "1.0.7", sourceRef: "aaa" }).free, true);
  assert.equal(classifyStagedCandidate({ entries: undefined, version: "1.0.7", sourceRef: "aaa" }).free, true);
});

test("files that are not candidate artifacts do not occupy the slot", () => {
  const verdict = classifyStagedCandidate({
    entries: ["README.md", "notes.txt", ".gitkeep"],
    version: "1.0.7",
    sourceRef: "aaa",
  });
  assert.equal(verdict.free, true);
  assert.deepEqual(verdict.occupants, []);
});

test("a candidate already staged from a DIFFERENT source ref refuses, and names both refs", () => {
  const verdict = classifyStagedCandidate({
    entries: ["ToolsEnabled Setup 1.0.7.exe", "DECLARATION.md", "declaration-facts.json"],
    factsRaw: JSON.stringify({ version: "1.0.7", sourceRef: "e521606b9033f9025a7986f7e5669e665d6217d3" }),
    version: "1.0.7",
    sourceRef: "f8be6ed720ab14746ea539eb366cda310074d68b",
  });
  assert.equal(verdict.free, false);
  assert.match(verdict.reason, /DIFFERENT source ref/);
  assert.match(verdict.reason, /e521606b9033f9025a7986f7e5669e665d6217d3/);
  assert.match(verdict.reason, /f8be6ed720ab14746ea539eb366cda310074d68b/);
  assert.match(verdict.reason, /--version|--staging|--replace-staged/);
});

// ABSENCE IS NEVER CONSENT: these three are the whole point of the guard.
test("an installer with NO declaration-facts.json refuses -- unreadable provenance is a stronger reason, not a weaker one", () => {
  const verdict = classifyStagedCandidate({
    entries: ["ToolsEnabled Setup 1.0.7.exe"],
    factsRaw: null,
    version: "1.0.7",
    sourceRef: "f8be6ed",
  });
  assert.equal(verdict.free, false);
  assert.match(verdict.reason, /no declaration-facts\.json/);
});

test("an orphaned installer blockmap occupies the slot rather than being silently reused", () => {
  const verdict = classifyStagedCandidate({
    entries: ["ToolsEnabled Setup 1.0.7.exe.blockmap"],
    factsRaw: null,
    version: "1.0.7",
    sourceRef: "f8be6ed",
  });
  assert.equal(verdict.free, false);
  assert.deepEqual(verdict.occupants, ["ToolsEnabled Setup 1.0.7.exe.blockmap"]);
  assert.match(verdict.reason, /unknown provenance/);
});

test("an orphaned download manifest occupies the candidate slot", () => {
  for (const manifest of ["download.json", "TEST-download.json"]) {
    const verdict = classifyStagedCandidate({
      entries: [manifest],
      factsRaw: null,
      version: "1.0.7",
      sourceRef: "f8be6ed",
    });
    assert.equal(verdict.free, false, `${manifest} was treated as an empty slot`);
    assert.deepEqual(verdict.occupants, [manifest]);
    assert.match(verdict.reason, /unknown provenance/);
  }
});

test("a BLANK sourceRef in the staged facts never reads as a match", () => {
  const verdict = classifyStagedCandidate({
    entries: ["DECLARATION.md", "declaration-facts.json"],
    factsRaw: JSON.stringify({ version: "1.0.7", sourceRef: "   " }),
    version: "1.0.7",
    sourceRef: "f8be6ed",
  });
  assert.equal(verdict.free, false);
  assert.equal(verdict.sameSource, false);
  assert.match(verdict.reason, /records no sourceRef/);
});

test("unparseable staged facts refuse rather than being treated as absent", () => {
  const verdict = classifyStagedCandidate({
    entries: ["declaration-facts.json"],
    factsRaw: "{ not json",
    version: "1.0.7",
    sourceRef: "f8be6ed",
  });
  assert.equal(verdict.free, false);
  assert.match(verdict.reason, /could not be parsed/);
});

test("even the SAME source ref refuses without the explicit override -- a rebuild is still a second binary", () => {
  const verdict = classifyStagedCandidate({
    entries: ["ToolsEnabled Setup 1.0.7.exe", "declaration-facts.json"],
    factsRaw: JSON.stringify({ sourceRef: "f8be6ed" }),
    version: "1.0.7",
    sourceRef: "f8be6ed",
  });
  assert.equal(verdict.free, false);
  assert.equal(verdict.sameSource, true);
  assert.match(verdict.reason, /THE SAME source ref/);
});

test("--replace-staged permits the overwrite and says exactly what it is discarding", () => {
  const verdict = classifyStagedCandidate({
    entries: ["ToolsEnabled Setup 1.0.7.exe", "declaration-facts.json"],
    factsRaw: JSON.stringify({ sourceRef: "e521606" }),
    version: "1.0.7",
    sourceRef: "f8be6ed",
    replaceStaged: true,
  });
  assert.equal(verdict.free, true);
  assert.equal(verdict.replaced, true);
  assert.match(verdict.reason, /overwriting the 1\.0\.7 candidate/);
  assert.match(verdict.reason, /e521606/);
});

test("assertStagingFree throws on an occupied slot on disk and passes on a fresh one", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-staging-"));
  try {
    const taken = path.join(home, "1.0.7");
    await mkdir(taken, { recursive: true });
    await writeFile(path.join(taken, "ToolsEnabled Setup 1.0.7.exe"), "not really an installer", "utf8");
    await writeFile(path.join(taken, "declaration-facts.json"), JSON.stringify({ sourceRef: "e521606" }), "utf8");

    assert.throws(
      () => assertStagingFree({ stagingDir: taken, version: "1.0.7", sourceRef: "f8be6ed", log: () => {} }),
      /staging-collision/,
    );

    const fresh = path.join(home, "1.0.8");
    const verdict = assertStagingFree({ stagingDir: fresh, version: "1.0.8", sourceRef: "f8be6ed", log: () => {} });
    assert.equal(verdict.free, true);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an indeterminate facts read is not reported as absence and is not latched", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "release-packager-staging-read-"));
  const stagingDir = path.join(home, "1.0.7");
  const factsPath = path.join(stagingDir, "declaration-facts.json");
  try {
    await mkdir(factsPath, { recursive: true });

    assert.throws(
      () => assertStagingFree({ stagingDir, version: "1.0.7", sourceRef: "f8be6ed", log: () => {} }),
      (error) => {
        assert.equal(error.code, "STAGING_INSPECTION_INDETERMINATE");
        assert.match(error.message, /EISDIR/);
        assert.match(error.message, /NOT claiming .* absent/);
        return true;
      },
    );

    // CONTROL: a transient result must not be cached. Repair the same path and
    // prove the next call pays for a fresh read and observes the staged facts.
    await rm(factsPath, { recursive: true });
    await writeFile(factsPath, JSON.stringify({ sourceRef: "f8be6ed" }), "utf8");
    assert.throws(
      () => assertStagingFree({ stagingDir, version: "1.0.7", sourceRef: "f8be6ed", log: () => {} }),
      (error) => error.code !== "STAGING_INSPECTION_INDETERMINATE" && /THE SAME source ref/.test(error.message),
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the default staging root is the customer-neutral ToolsEnabled Desktop candidate folder", async () => {
  const { DEFAULT_STAGING_ROOT } = await import("../release-packager/cut-release-candidate.mjs");
  const parts = DEFAULT_STAGING_ROOT.split(path.sep);
  const desktopAt = parts.findIndex((p) => p.toLowerCase() === "desktop");
  assert.notEqual(desktopAt, -1, "staging default should live under the user's Desktop");
  assert.equal(parts.length, desktopAt + 2, `staging default must be one stable folder below Desktop; got ${DEFAULT_STAGING_ROOT}`);
  assert.equal(parts[parts.length - 1], "ToolsEnabled-INSTALLER-CANDIDATE");
});

test("release protocol surfaces contain no retired machine, product, account-layout, or checkout directives", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(testDir, '..', '..');
  const releaseRoot = path.join(repo, 'tools', 'release-packager');
  const protocolDoc = path.join(repo, 'docs', 'coordinator', 'RELEASE-CUT-TRAPS-2026-08-15.md');
  const files = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else files.push(entryPath);
    }
  };
  await visit(releaseRoot);
  files.push(protocolDoc);

  const forbidden = [
    ['retired builder label', /machine[ -]?a/i],
    ['retired verifier label', /machine[ -]?b/i],
    ['retired product name', /mission control/i],
    ['retired account layout', /agentwork/i],
    ['retired checkout name', /toolsenabled-current/i],
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      assert.doesNotMatch(source, pattern, `${label} returned in ${path.relative(repo, file)}`);
    }
  }
});

test("the cut orders exact candidate proof, declaration preflight, immutable tag, then declaration", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.join(testDir, "..", "release-packager", "cut-release-candidate.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(testDir, "..", "..", "package.json"), "utf8"));
  const buildAt = source.indexOf("running `npm run dist`");
  const stagedAt = source.indexOf("staged copy re-hashed: byte-identical to the build");
  const qaAt = source.indexOf("running exact-candidate packaged QA");
  const identityAt = source.indexOf("readExeVersionInfo(stagedExePath)");
  const identityValidatedAt = source.indexOf("assertCandidatePeIdentity({");
  const notesAt = source.indexOf("await stageWindowsReleaseNotes({");
  const preflightAt = source.indexOf("tagDeclaredCandidate(stagingDir, facts,");
  const tagAt = source.indexOf("tagCommit(repo, `build/${version}`, buildRef)");
  const declareAt = source.indexOf("await writeDeclarationArtifacts(stagingDir, facts");
  assert.ok(
    buildAt < stagedAt && stagedAt < qaAt && qaAt < identityAt && identityAt < identityValidatedAt && identityValidatedAt < notesAt && notesAt < preflightAt && preflightAt < tagAt && tagAt < declareAt,
    `release order drifted: build=${buildAt}, staged=${stagedAt}, qa=${qaAt}, identity=${identityAt}, identityValidated=${identityValidatedAt}, preflight=${preflightAt}, tag=${tagAt}, declare=${declareAt}`,
  );
  assert.doesNotMatch(pkg.scripts["release:cut"], /check:release-notes/, "the measured packet is checked inside the cutter, before its tag");
  assert.doesNotMatch(pkg.scripts["release:cut"], /qa:packaged|check-renderer-payload\.mjs release\/win-unpacked/,
    "release:cut must not bless a shared pre-existing build before the isolated candidate exists");
  assert.match(source, /productName: packageJsonBuilt\.productName/,
    "candidate PE ProductName must be checked against electron-builder's top-level productName setting");
  assert.match(source, /\['tools\/pack-capability-layer\.mjs', '--source-ref', engineSourceRef\]/,
    'the isolated pre-build pack must receive the controller-bound engine commit');
  assert.match(source, /const buildEnv = buildDistChainEnvironment\(process\.env, \{[^}]*\bengineSourceRef,/,
    'the cut must bind the exact engine through the shared dist environment builder');
  assert.match(source, /runCapturing\('npm\.cmd', \['run', 'dist'\], \{\s+cwd: worktreePath,\s+env: buildEnv,/,
    'npm run dist must receive that bound environment');
  const engineSourceRef = 'b'.repeat(40);
  const inherited = { TOOLSENABLED_SOURCE_REF: 'a'.repeat(40) };
  const buildEnv = buildDistChainEnvironment(inherited, { workspaceSegments: ['fixture-workspace'],
    scratchState: path.join(tmpdir(), 'release-binding-fixture', 'state'),
    scratchTemp: path.join(tmpdir(), 'release-binding-fixture', 'temp'),
    engineSourceRef,
    // This fixture is the Windows release:cut (npm.cmd, PE ProductName); the POSIX TMPDIR socket budget
    // (tmpdirBudgetProblem) does not apply to it.
    platform: 'win32',
  });
  assert.equal(buildEnv.TOOLSENABLED_SOURCE_REF, engineSourceRef,
    'pack and current-payload gates must retain the controller-bound engine, not an inherited ref');
  assert.equal(inherited.TOOLSENABLED_SOURCE_REF, 'a'.repeat(40), 'binding must not mutate the caller');
  assert.match(source, /\n\s+engineSourceRef,\n\s+buildRef,/,
    'the candidate facts must publish the engine commit that supplied the staged payload');
});

// THE JUNCTION IS RELEASED, AND ONLY THE JUNCTION.
//
// Measured 2026-08-14: the release helper existed with a full docblock and NO
// call site, the cut's `git worktree remove --force` followed the node_modules
// junction into the shared source tree, and the next build died at "vite not
// found". Two contracts, both pinned: the cut calls the helper before git
// removes anything, and the helper acts ONLY on reparse points -- an ordinary
// npm-ci node_modules falls through untouched (rmdirSync on it would throw
// ENOTEMPTY and kill a finished cut).
test("the cut releases the node_modules junction before removing the worktree", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.join(testDir, "..", "release-packager", "cut-release-candidate.mjs"), "utf8");
  const releaseAt = source.indexOf("releaseNodeModulesJunction(worktreePath)");
  const removeAt = source.indexOf("worktreeRemove(repo, worktreePath)");
  assert.ok(releaseAt !== -1, "the cut no longer calls releaseNodeModulesJunction -- the shared node_modules is one cut from destruction");
  assert.ok(removeAt !== -1 && releaseAt < removeAt, "the junction must be released BEFORE git worktree remove");
});

test("releaseNodeModulesJunction detaches a junction but never touches a real directory", async () => {
  const { releaseNodeModulesJunction } = await import("../release-packager/lib/node-modules-reuse.mjs");
  const { symlinkSync, mkdirSync: mkDir, writeFileSync: writeF, existsSync: exists } = await import("node:fs");
  const scratch = await mkdtemp(path.join(tmpdir(), "junction-release-"));
  try {
    // A REAL node_modules: helper must refuse and leave it intact.
    const realTree = path.join(scratch, "real-wt");
    mkDir(path.join(realTree, "node_modules", "pkg"), { recursive: true });
    writeF(path.join(realTree, "node_modules", "pkg", "index.js"), "x");
    assert.equal(releaseNodeModulesJunction(realTree, { log: () => {} }), false);
    assert.ok(exists(path.join(realTree, "node_modules", "pkg", "index.js")), "a real node_modules was modified");

    // CONTROL: definite non-junction/absence answers remain false. These are
    // deliberately repeated to ensure the helper does not latch any result.
    for (const code of ["EINVAL", "ENOENT", "EINVAL"]) {
      assert.equal(
        releaseNodeModulesJunction(realTree, { log: () => {}, readlink: () => { throw Object.assign(new Error(code), { code }); } }),
        false,
      );
    }

    // A busy/unreadable machine did not prove absence. In particular, a
    // code-less non-Error throw must not slip through a catch-all as false.
    for (const failure of [Object.assign(new Error("busy"), { code: "EBUSY" }), "code-less failure"]) {
      assert.throws(
        () => releaseNodeModulesJunction(realTree, { log: () => {}, readlink: () => { throw failure; } }),
        (error) => error.code === "ERR_NODE_MODULES_JUNCTION_INSPECTION" && /NOT claiming the junction is absent/.test(error.message),
      );
    }

    // A JUNCTION: helper removes the link; the target stays whole.
    const shared = path.join(scratch, "shared-nm");
    mkDir(path.join(shared, "pkg"), { recursive: true });
    writeF(path.join(shared, "pkg", "index.js"), "y");
    const linkTree = path.join(scratch, "link-wt");
    mkDir(linkTree, { recursive: true });
    symlinkSync(shared, path.join(linkTree, "node_modules"), "junction");
    assert.equal(releaseNodeModulesJunction(linkTree, { log: () => {} }), true);
    assert.ok(!exists(path.join(linkTree, "node_modules")), "the junction entry should be gone");
    assert.ok(exists(path.join(shared, "pkg", "index.js")), "the SHARED target was destroyed -- the exact 2026-08-14 failure");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- cut-slot.mjs: two cuts may not share a candidate slot -------------------
//
// assertStagingFree() above answers "is a FINISHED candidate already here?".
// It cannot answer "is another cut building into this slot right now?" -- during
// a minutes-long `npm run dist` the slot holds no exe, no blockmap and no
// declaration, so an in-flight cut reads to it as free. The second run then
// cp's its installer over the first one's and the declaration set is published
// last-writer-wins: an installer whose declaration-facts.json names a different
// sha256, with NO error anywhere. These assert the exclusion, not its wording.

test("a second claim on the same candidate slot refuses by name, names the holder, and writes nothing", async () => {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "cut-slot-"));
  try {
    const firstBuild = path.join(stagingDir, "build-of-the-first-cut");
    const firstReadiness = path.join(stagingDir, "readiness-of-the-first-cut.json");
    const first = claimCutSlot({ stagingDir, buildDirectory: firstBuild, readinessOutput: firstReadiness });
    const before = (await readdir(stagingDir)).sort();

    let refusal = null;
    try {
      claimCutSlot({
        stagingDir,
        buildDirectory: path.join(stagingDir, "build-of-the-second-cut"),
        readinessOutput: path.join(stagingDir, "readiness-of-the-second-cut.json"),
      });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "the second cut was admitted into a slot another cut is holding");
    // The identity is the code, not the sentence: a better-worded refusal still passes.
    assert.equal(refusal.code, CUT_SLOT_HELD, "refuses BY NAME, not with a bare EEXIST");
    assert.ok(refusal.message.includes(path.resolve(stagingDir)), "names the shared staging path");
    assert.ok(refusal.message.includes(firstBuild), "names the HOLDER's build directory");
    assert.ok(refusal.message.includes(firstReadiness), "names the HOLDER's readiness output");
    assert.ok(!refusal.message.includes("build-of-the-second-cut"), "must describe the holder, not echo the caller");
    assert.ok(refusal.message.includes(String(process.pid)), "names the owning pid");
    assert.match(refusal.message, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "names when the holder started");
    assert.deepEqual((await readdir(stagingDir)).sort(), before, "the refused run wrote nothing into the slot");

    first.release();
    assert.deepEqual(await readdir(stagingDir), [], "release leaves no residue behind");

    // Not a one-shot brick: the slot is reusable once the holder is done.
    const second = claimCutSlot({ stagingDir, buildDirectory: "B2", readinessOutput: "E2" });
    second.release();
    assert.deepEqual(await readdir(stagingDir), []);
  } finally {
    await rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ABSENCE IS NEVER CONSENT, and neither is a dead pid.
test("a marker left by an abruptly killed cut still refuses, and says the owner is unrecorded rather than blank", async () => {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "cut-slot-dead-"));
  try {
    await mkdir(path.join(stagingDir, ".cut-in-flight"));
    let refusal = null;
    try {
      claimCutSlot({ stagingDir, buildDirectory: "B", readinessOutput: "E" });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "a retained marker must refuse; there is no pid-liveness auto-clear");
    assert.equal(refusal.code, CUT_SLOT_HELD);
    assert.equal(refusal.holder, null, "no owner record was written before the death");
    assert.ok(refusal.message.includes(path.resolve(stagingDir)), "names the marker's location so it can be cleared by hand");
    assert.ok(/unrecorded|unreadable/.test(refusal.message), "'could not read the owner' must not be reported as a blank");
  } finally {
    await rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("claiming a slot whose staging directory does not exist refuses by name, not with a bare ENOENT", () => {
  const missing = path.join(tmpdir(), `cut-slot-absent-${process.pid}-${Date.now()}`);
  assert.throws(
    () => claimCutSlot({ stagingDir: missing, buildDirectory: "B", readinessOutput: "E" }),
    (error) => error.message.includes("[cut-slot]") && error.message.includes(path.resolve(missing)),
  );
});

// A holder that supplied its own receipt (--readiness-evidence) records a null
// readinessOutput. "That field was never set" and "the holder died before it
// recorded itself" are different answers and must not print the same sentence.
test("a holder that wrote no readiness output is reported as unset, not as a cut that died", async () => {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "cut-slot-noreadiness-"));
  try {
    const first = claimCutSlot({ stagingDir, buildDirectory: path.join(stagingDir, "build-one"), readinessOutput: undefined });
    let refusal = null;
    try {
      claimCutSlot({ stagingDir, buildDirectory: "B2", readinessOutput: "E2" });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "a live holder must still refuse");
    assert.equal(refusal.code, CUT_SLOT_HELD);
    assert.equal(refusal.holder.readinessOutput, null);
    assert.ok(refusal.message.includes(String(process.pid)), "the holder is alive and is named");
    assert.ok(!/died/.test(refusal.message), "a live, fully recorded holder must not be described as dead");
    first.release();
  } finally {
    await rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- who cut it -------------------------------------------------------------

test('the declaration names the session that cut it, and never invents one', () => {
  /* These two lines were hardcoded to the session that first wrote the
     generator, so every declaration since -- including builds cut months
     later by other models -- carried that name. A document whose whole
     purpose is honest provenance was misreporting its own. Found reading the
     1.0.21 declaration this lane had just cut, which credited a session that
     had nothing to do with it. */
  const named = cuttingAttribution({
    TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
    TOOLSENABLED_CUT_SESSION: 'abc123',
    TOOLSENABLED_CUT_LANE: 'research-subsystem',
  })
  assert.match(named, /Co-Authored-By: Codex gpt-5\.6-sol <noreply@openai\.com>/)
  assert.match(named, /Lane: research-subsystem \(session abc123\)/)
  assert.deepEqual(cuttingIdentity({
    TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
  }), { name: 'Codex gpt-5.6-sol', email: 'noreply@openai.com' })
  assert.equal(cuttingSession({ TOOLSENABLED_CUT_SESSION: 'abc_123' }), 'abc_123')

  // Claude's own environment keeps its provider-specific fallback. An
  // explicit model never borrows that address: its provider is not knowable
  // from an arbitrary display string.
  assert.match(cuttingAttribution({ CLAUDE_MODEL_NAME: 'Claude Fable 5' }),
    /Co-Authored-By: Claude Fable 5 <noreply@anthropic\.com>/)
  assert.equal(/Co-Authored-By:/.test(cuttingAttribution({ TOOLSENABLED_CUT_MODEL: 'Codex' })), false)

  // Nothing set: the gap is stated, never filled with a guess.
  const anonymous = cuttingAttribution({})
  assert.match(anonymous, /unnamed session/)
  assert.match(anonymous, /session not recorded/)
  assert.equal(/Co-Authored-By:/.test(anonymous), false, 'an unknown cutter must not be credited to anyone')

  // The old hardcoded identity may never reappear from any environment.
  for (const environment of [{}, { TOOLSENABLED_CUT_MODEL: 'Claude Fable 5' }, { CLAUDE_SESSION_ID: 'zzz' }]) {
    const line = cuttingAttribution(environment)
    assert.equal(line.includes('6f84bf9b'), false, 'the first author\'s session id is back in the declaration')
    assert.equal(line.includes('Sonnet 5'), false, 'a hardcoded model name is back in the declaration')
  }
})

test('an unnamed cutter is refused before the build, not at the commit', () => {
  /* The honest-attribution change has a cost, and the 1.0.22 cut paid it in
     full: with nobody named, the version-bump commit carries no
     Co-Authored-By, this repo's commit-msg hook refuses it, and the cut dies
     AFTER staging the payload with a build worktree stranded for postmortem.
     The refusal was right; the timing was cruel. This pins the early check. */
  assert.equal(attributionBlocksCommit({}), true, 'an unnamed cutter must be caught before the build starts')
  assert.equal(attributionBlocksCommit({ TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol' }), true,
    'an explicit model with no provider-correct e-mail must be blocked')
  assert.equal(attributionBlocksCommit({
    TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
  }), true, 'a named cutter without a unique session must still be blocked')
  assert.equal(attributionBlocksCommit({
    TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
    TOOLSENABLED_CUT_SESSION: 'abc_123',
  }), false, 'a complete explicit cutter identity and valid session must not be blocked')
  assert.equal(attributionBlocksCommit({ CLAUDE_MODEL_NAME: 'Claude Fable 5' }), true,
    'the fallback model still requires its session discriminator')
  assert.equal(attributionBlocksCommit({
    CLAUDE_MODEL_NAME: 'Claude Fable 5',
    CLAUDE_SESSION_ID: 'claude_123',
  }), false, 'the complete provider fallback counts too')
  // And the thing it protects: what it lets through must satisfy the hook.
  assert.match(cuttingAttribution({
    TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
    TOOLSENABLED_CUT_SESSION: 'abcd',
  }),
    /Co-Authored-By: .+\nLane: .+ \(session abcd\)/)
  assert.equal(attributionBlocksCommit({
    TOOLSENABLED_CUT_MODEL: 'Codex\nCo-Authored-By: attacker',
    TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
    TOOLSENABLED_CUT_SESSION: 'abc_123',
  }), true, 'newline-bearing attribution must never reach the commit message')
  assert.equal(cuttingIdentity({
    TOOLSENABLED_CUT_MODEL: 'Codex',
    TOOLSENABLED_CUT_EMAIL: 'not-an-email',
  }), null, 'a malformed explicit pair must not become a Git identity')
})

test('release cutter help names the same complete explicit attribution pair as the early refusal', () => {
  const script = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Set TOOLSENABLED_CUT_MODEL and TOOLSENABLED_CUT_EMAIL together/)
  assert.match(result.stdout, /generic path never guesses a provider/)
  assert.match(result.stdout, /version-bump commit's author and committer/)
  assert.match(result.stdout, /matching Signed-off-by trailer required by the DCO gate/)
  assert.match(result.stdout, /unique\s+TOOLSENABLED_CUT_SESSION of 4-200 characters/)
})

test('release cutter refuses incomplete identity or session before filesystem or Git mutation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'release-packager-identity-'))
  try {
    git(['init', '--initial-branch=main'], home)
    git(['config', 'user.email', 'fixture@example.com'], home)
    git(['config', 'user.name', 'Fixture'], home)
    await writeFile(path.join(home, 'seed.txt'), 'seed\n')
    git(['add', 'seed.txt'], home)
    git(['commit', '-m', 'seed'], home)
    const originalHead = git(['rev-parse', 'HEAD'], home).trim()

    const script = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url))
    const baseEnvironment = { ...process.env }
    for (const key of [
      'TOOLSENABLED_CUT_MODEL',
      'TOOLSENABLED_CUT_EMAIL',
      'TOOLSENABLED_CUT_SESSION',
      'TOOLSENABLED_CUT_LANE',
      'CLAUDE_MODEL_NAME',
      'CLAUDE_SESSION_ID',
    ]) delete baseEnvironment[key]

    const cases = [
      {
        environment: { TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol', TOOLSENABLED_CUT_SESSION: 'abc_123' },
        error: /cutter identity is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'not-an-email',
          TOOLSENABLED_CUT_SESSION: 'abc_123',
        },
        error: /cutter identity is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex\nCo-Authored-By: attacker',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
          TOOLSENABLED_CUT_SESSION: 'abc_123',
        },
        error: /cutter identity is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
        },
        error: /cutter session is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
          TOOLSENABLED_CUT_SESSION: 'abc',
        },
        error: /cutter session is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
          TOOLSENABLED_CUT_SESSION: 'abc 123',
        },
        error: /cutter session is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
          TOOLSENABLED_CUT_SESSION: 'abc\n123',
        },
        error: /cutter session is missing or invalid/,
      },
      {
        environment: {
          TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
          TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
          TOOLSENABLED_CUT_SESSION: 'a'.repeat(201),
        },
        error: /cutter session is missing or invalid/,
      },
    ]
    for (const [index, invalidCase] of cases.entries()) {
      const stagingRoot = path.join(home, `staging-${index}`)
      const buildDir = path.join(home, `build-${index}`)
      const result = spawnSync(process.execPath, [
        script,
        '--repo', home,
        '--staging', stagingRoot,
        '--build-dir', buildDir,
      ], {
        encoding: 'utf8',
        env: { ...baseEnvironment, ...invalidCase.environment },
      })
      assert.equal(result.status, 1, `invalid cutter metadata unexpectedly continued:\n${result.stdout}\n${result.stderr}`)
      assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.error)
      await assert.rejects(access(stagingRoot), undefined, 'staging root must not be created')
      await assert.rejects(access(buildDir), undefined, 'build worktree must not be created')
      assert.equal(git(['rev-parse', 'HEAD'], home).trim(), originalHead)
      assert.equal(git(['status', '--porcelain'], home), '')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})


test("Windows packet notes derive their sole record from staged bytes and measured signing status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "windows-packet-notes-"));
  try {
    await mkdir(path.join(root, 'docs'));
    const version = '1.0.45';
    const source = await readFile(new URL('../../docs/RELEASE-NOTES-1.0.45.md', import.meta.url), 'utf8');
    const sourcePath = path.join(root, 'docs', `RELEASE-NOTES-${version}.md`);
    await writeFile(sourcePath, source);
    const stagedExePath = path.join(root, `ToolsEnabled Setup ${version}.exe`);
    await writeFile(stagedExePath, 'disposable measured bytes; this fixture does not assert a valid PE');
    const stagedMeasured = await measureFile(stagedExePath);
    const context = { worktreePath: root, stagingDir: root, version, releasePlatforms: ['linux', 'windows'], stagedExePath, stagedMeasured };
    let signatureReads = 0;
    const result = await stageWindowsReleaseNotes(context, { readSignature: async target => {
      assert.equal(target, stagedExePath); signatureReads++; return 'NotSigned';
    } });
    assert.equal(signatureReads, 1);
    assert.deepEqual(result.releasePlatforms, ['linux', 'windows']);
    const packet = await readFile(path.join(root, result.filename), 'utf8');
    assert.equal(await readFile(sourcePath, 'utf8'), source);
    assert.match(packet, /### Windows installer/);
    assert.doesNotMatch(packet, /### Linux package|\|[^\n]*pending[^\n]*\|/);
    assert.ok(packet.includes(`| SHA-256 | ${stagedMeasured.sha256.toLowerCase()} |`));
    assert.ok(packet.includes(`| Bytes | ${stagedMeasured.bytes} |`));
    assert.match(packet, /Unsigned \(no Authenticode signature\)/);
    await assert.rejects(stageWindowsReleaseNotes(context, { readSignature: async () => 'HashMismatch' }), /signature was not valid/);
    await assert.rejects(stageWindowsReleaseNotes({ ...context, releasePlatforms: ['windows'] }, { readSignature: async () => assert.fail('scope refuses before signature') }), /install record for linux/);
    await assert.rejects(stageWindowsReleaseNotes(context, { readSignature: async () => {
      await writeFile(stagedExePath, 'changed while checking signature'); return 'NotSigned';
    } }), /changed while preparing/);
    await assert.rejects(stageWindowsReleaseNotes(context, { readSignature: async () => assert.fail('changed artifact refuses first') }), /changed before release notes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the Windows cutter retains the complete declared release scope', () => {
  assert.deepEqual(parseWindowsArgs([]).releasePlatforms, ['windows']);
  assert.deepEqual(parseWindowsArgs(['--release-platform', 'linux', '--release-platform', 'Windows']).releasePlatforms, ['linux', 'windows']);
  assert.throws(() => parseWindowsArgs(['--release-platform', 'linux']), /must include windows/);
  assert.throws(() => parseWindowsArgs(['--release-platform', 'plan9']), /must be one of/);
});

test('Windows packet signing measurement uses its native PowerShell modules', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'windows-signature-'));
  try {
    const modules = path.join(root, 'foreign-modules');
    const foreignSecurity = path.join(modules, 'Microsoft.PowerShell.Security');
    await mkdir(foreignSecurity, { recursive: true });
    await writeFile(path.join(foreignSecurity, 'Microsoft.PowerShell.Security.psd1'), "@{ ModuleVersion = '7.0'; PowerShellVersion = '3.0'; CompatiblePSEditions = @('Core'); FunctionsToExport = @(); CmdletsToExport = @('Get-AuthenticodeSignature'); NestedModules = 'ForeignHost.Security.dll'; RequiredAssemblies = 'ForeignHost.Security.dll' }");
    await mkdir(path.join(root, 'docs'));
    await copyFile(new URL('../../docs/RELEASE-NOTES-1.0.45.md', import.meta.url), path.join(root, 'docs', 'RELEASE-NOTES-1.0.45.md'));
    const artifactDirectory = path.join(root, "artifact ' &[fixture]");
    await mkdir(artifactDirectory);
    const stagedExePath = path.join(artifactDirectory, 'ToolsEnabled Setup 1.0.45.exe');
    // This is a real PE for the signature reader, not an installer qualification.
    await copyFile(process.execPath, stagedExePath);
    const stagedMeasured = await measureFile(stagedExePath);
    const context = { worktreePath: root, stagingDir: root, version: '1.0.45', releasePlatforms: ['linux', 'windows'], stagedExePath, stagedMeasured };
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    environment.PSModulePath = modules;
    const powershell = String.raw`\\.\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const literal = "'" + stagedExePath.replace(/'/g, "''") + "'";
    const unprepared = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; (Get-AuthenticodeSignature -LiteralPath ${literal}).Status.ToString()`], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.notEqual(unprepared.status, 0, 'fixture must reproduce the foreign-host module failure');
    assert.match(`${unprepared.stdout}\n${unprepared.stderr}`, /CouldNotAutoloadMatchingModule/);
    const script = `import { stageWindowsReleaseNotes } from ${JSON.stringify(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url).href)}; const result = await stageWindowsReleaseNotes(${JSON.stringify(context)}); console.log(JSON.stringify(result));`;
    const childScript = path.join(root, 'measure-signature.mjs');
    await writeFile(childScript, script);
    const measured = spawnSync(process.execPath, [childScript], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(measured.status, 0, `${measured.stdout}\n${measured.stderr}`);
    const result = JSON.parse(measured.stdout.trim());
    const packet = await readFile(path.join(root, result.filename), 'utf8');
    assert.match(packet, /\| Signed \| (Signed \(Authenticode signature verified\)|Unsigned \(no Authenticode signature\)) \|/);
    assert.equal(sameBytes(stagedMeasured, await measureFile(stagedExePath)), true, 'signature measurement must preserve the artifact bytes');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
