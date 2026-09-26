// The Linux cut has two spellings of one chain: `npm run dist:linux` for an
// operator at a shell, and the recorded per-step chain the cutter runs so every
// gate leaves its own exit code and peak RSS in gates-<version>.json. Two
// spellings drift unless something holds them together. This test asks the
// cutter for its plan (behaviour: planSteps with values) and reads the script
// from package.json, then requires the same gates in the same order.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planSteps, parseArgs, withEngineBinding, measureLinuxCandidateArtifact } from "../release-packager/cut-linux-release-candidate.mjs";
import { platformSkipReason } from '../lib/test-suite-result.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;

const CUT_ARGS = ['--repo', '/repo', '--engine-repo', '/engine', '--source-ref', 'a'.repeat(40),
  '--engine-source-ref', 'b'.repeat(40), '--version', '9.9.9', '--worktree', '/worktree', '--output', '/output'];
test('release cuts use fresh lockfile dependencies and refuse mutable reuse', () => {
  assert.equal(parseArgs(CUT_ARGS).nodeModules, 'npm-ci');
  for (const mode of ['link', 'copy']) {
    assert.throws(() => parseArgs([...CUT_ARGS, '--node-modules', mode]), /rehearsal/);
    assert.equal(parseArgs([...CUT_ARGS, '--rehearsal', '--node-modules', mode]).nodeModules, mode);
  }
});

test('a Linux release cannot skip qualification through an unbound resume record', () => {
  assert.throws(() => parseArgs([...CUT_ARGS, '--resume-from-step', '30']), /rehearsal/);
  assert.equal(parseArgs([...CUT_ARGS, '--rehearsal', '--resume-from-step', '30']).resumeFromStep, 30);
});

test('Linux exposes a mandatory shared qualification step before tag and declaration', async () => {
  const steps = planSteps(synthesizedContext());
  const readiness = steps.find(step => step.name === 'release-readiness');
  assert.equal(readiness.stop, true);
  assert.equal(readiness.kind, 'driver');
  assert.equal(readiness.notApplicable, undefined);
  for (const name of ['tag-build-version', 'declaration-facts']) {
    assert.ok(readiness.index < steps.find(step => step.name === name).index);
  }
  await assert.rejects(readiness.run(synthesizedContext(), {}), { code: 'RELEASE_READINESS_BLOCKED' });
  assert.throws(() => parseArgs([...CUT_ARGS, '--rehearsal', '--readiness-evidence', '/fixture/receipt.json']), /diagnostic scope/);
});

test('real Linux cut CLI refuses missing native adapters before Git, output or installation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-linux-readiness-preflight-'));
  try {
    // No Git repository or engine checkout: the shared native preflight must
    // refuse before resolving either, and must not create cut output.
    writeFileSync(path.join(root, 'package.json'), '{}');
    const output = path.join(root, 'output'), worktree = path.join(root, 'worktree');
    const result = spawnSync(process.execPath, [path.join(REPO, 'tools/release-packager/cut-linux-release-candidate.mjs'),
      '--repo', root, '--engine-repo', path.join(root, 'absent-engine'), '--source-ref', 'a'.repeat(40),
      '--engine-source-ref', 'b'.repeat(40), '--version', '9.9.9', '--worktree', worktree, '--output', output,
      '--tooling-root', path.join(REPO, 'tools/release-packager')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Release readiness blocked: required qualification adapters are unavailable/);
    assert.doesNotMatch(result.stderr, /not a git repository|engine.*exist|DISPLAY|sudo/);
    for (const file of [output, worktree]) assert.throws(() => readFileSync(file), { code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared admission remeasures the staged installer without changing its already recorded version and byte identity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-linux-artifact-admission-'));
  try {
    const hash = await import('../release-packager/lib/hash.mjs');
    const file = 'toolsenabled_9.9.9_amd64.deb', artifactPath = path.join(root, file);
    writeFileSync(artifactPath, 'inert artifact identity fixture');
    const measured = await hash.measureFile(artifactPath);
    const ctx = { version: '9.9.9', output: root, tooling: { hash },
      deb: { file, bytes: measured.bytes, sha256: measured.sha256.toLowerCase() } };
    assert.deepEqual(await measureLinuxCandidateArtifact(ctx), {
      artifactPath, artifact: { sha256: measured.sha256, bytes: measured.bytes },
    });
    await assert.rejects(measureLinuxCandidateArtifact({ ...ctx, version: '9.9.10' }), /different version/);
    await assert.rejects(measureLinuxCandidateArtifact({ ...ctx, deb: { ...ctx.deb, bytes: measured.bytes + 1 } }), /installer bytes changed/);
    writeFileSync(artifactPath, 'changed artifact identity fixture');
    await assert.rejects(measureLinuxCandidateArtifact(ctx), /installer bytes changed/);
    assert.equal(ctx.deb.sha256, measured.sha256.toLowerCase(), 'measurement must not rewrite the earlier candidate identity');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the actual tag operation requires preceding proofs and refuses locally green records without shared native qualification', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-cut-tag-proofs-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  try {
    git('init', '--quiet'); git('config', 'user.name', 'Cut proof fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('commit', '--quiet', '--allow-empty', '-m', 'Candidate fixture');
    const realGit = await import('../release-packager/lib/git.mjs');
    const ctx = { ...synthesizedContext(), repo: root, buildRef: git('rev-parse', 'HEAD').trim(),
      installedProof: true, onboardingScript: '/fixture/onboarding.mjs', tooling: { git: realGit } };
    const steps = planSteps(ctx), tag = steps.find(step => step.name === 'tag-build-version');
    const records = steps.filter(step => step.index < tag.index).map(step => ({
      index: step.index, name: step.name, stop: step.stop, status: step.notApplicable ? 'not-applicable' : 'green', exit: step.notApplicable ? null : 0, signal: null,
    }));
    for (const change of [
      rows => rows.filter(row => row.name !== 'packaged-qa-suite'),
      rows => rows.map(row => row.name === 'installed-onboarding' ? { ...row, status: 'requiresOperator', exit: null } : row),
      rows => rows.map(row => row.name === 'installed-onboarding' ? { ...row, status: 'accepted-from-prior-run', priorStatus: 'requiresOperator', exit: null } : row),
      rows => rows.map(row => row.name === 'packaged-qa-suite' ? { ...row, status: 'green', exit: 1 } : row),
      rows => rows.map(row => row.name === 'dpkg-install' ? { ...row, status: 'not-applicable', exit: null } : row),
    ]) {
      ctx.records = change(records);
      await assert.rejects(tag.run(ctx, {}), /proof/i);
      assert.equal(git('tag', '--list').trim(), '', 'an incomplete cut must not create an immutable release tag');
    }
    ctx.records = records;
    await assert.rejects(tag.run(ctx, {}), error => {
      assert.equal(error.code, 'RELEASE_READINESS_BLOCKED');
      assert.deepEqual(error.details.map(row => row.id), ['fresh-install', 'durable-critical-journey',
        'upgrade', 'uninstall-reinstall', 'privilege-isolation-recovery', 'advertised-integrations', 'update-delivery']);
      return true;
    });
    assert.equal(git('tag', '--list').trim(), '');
    // Even a pre-existing tag is not permission to skip current admission.
    git('tag', 'build/9.9.9', ctx.buildRef);
    await assert.rejects(tag.run(ctx, {}), { code: 'RELEASE_READINESS_BLOCKED' });
    assert.equal(git('rev-parse', 'build/9.9.9').trim(), ctx.buildRef);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('each cut operation refuses engine edits or a changed commit before or during its measurement', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-cut-engine-binding-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Cut binding fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(path.join(root, 'tools'));
    const file = path.join(root, 'tools', 'mission-bridge.js');
    writeFileSync(file, '// inert source fixture\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'Fixture engine');
    const ctx = { engineRepo: root, engineRef: git('rev-parse', 'HEAD').trim() };
    assert.equal(await withEngineBinding(ctx, async () => 'measured'), 'measured');
    let ran = false;
    writeFileSync(file, '// changed before measurement\n');
    await assert.rejects(withEngineBinding(ctx, async () => { ran = true; }));
    assert.equal(ran, false, 'a dirty engine must refuse before executing any operation');
    git('restore', 'tools/mission-bridge.js');
    await assert.rejects(withEngineBinding(ctx, async () => {
      writeFileSync(file, '// changed during measurement\n');
      return 'would otherwise be green';
    }));
    git('restore', 'tools/mission-bridge.js');
    await assert.rejects(withEngineBinding(ctx, async () => {
      git('commit', '--quiet', '--allow-empty', '-m', 'Different source identity');
      return 'clean but not the measured source pair';
    }));
    const fresh = { ...ctx, engineRef: git('rev-parse', 'HEAD').trim() };
    assert.equal(await withEngineBinding(fresh, async () => 'repeated on exact pair'), 'repeated on exact pair');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// One identity per gate: the tool file for `node tools/<x>.mjs …`, the npm
// script name when it is a compound script, the builder target for
// electron-builder. Arguments are deliberately NOT compared: the cutter
// addresses release/cut-<v>/linux-unpacked while the shell script addresses
// electron-builder's default release/linux-unpacked, and that difference is
// documented in LINUX-STEP-MAPPING.md, not a drift.
function identityOfWords(words) {
  const [head, ...rest] = words;
  const isNode = /(?:^|[/\\])node(?:\.exe)?$/i.test(head);
  if (head === "npm" && rest[0] === "run") {
    const target = scripts[rest[1]] ?? "";
    const single = /^node (tools\/[\w./-]+\.mjs)(?: |$)/.exec(target);
    return single ? single[1] : `npm run ${rest[1]}`;
  }
  if (head === "electron-builder" || (isNode && rest[0]?.replaceAll("\\", "/").endsWith("electron-builder/out/cli/cli.js"))) {
    const index = words.findIndex((word) => word === "--linux");
    return index === -1 ? "electron-builder" : `electron-builder --linux ${words[index + 1]}`;
  }
  if (isNode && /^tools\/[\w./-]+\.mjs$/.test(rest[0] ?? "")) return rest[0];
  return words.join(" ");
}

function identitiesOfScript(name) {
  return String(scripts[name] ?? "")
    .split(" && ")
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => identityOfWords(command.split(/\s+/)));
}

function synthesizedContext() {
  return {
    node: process.execPath,
    version: "9.9.9",
    repo: "/nowhere/app",
    worktree: "/nowhere/worktree",
    output: "/nowhere/output",
    engineRepo: "/nowhere/engine",
    engineRef: "b".repeat(40),
    sourceRef: "a".repeat(40),
    sameVersion: false,
    nodeModules: { mode: "copy", source: "/nowhere/node_modules" },
    buildRef: null,
    onboardingScript: null,
  };
}

// T240: a strict-test refusal must leave a renderer build available for
// diagnosis, while packaging still requires every release gate.
test('T240: Linux plans the renderer before strict verification without bypassing admission or packaging gates', () => {
  const steps = planSteps(synthesizedContext());
  const one = name => {
    const matches = steps.filter(step => step.name === name);
    assert.equal(matches.length, 1, name + ' must occur exactly once');
    return matches[0];
  };
  const build = one('npm-run-build');
  const verify = one('verify-release-test-ratchet-strict');
  assert.ok(build.index < verify.index, 'a refusing ratchet must not prevent the renderer build');
  for (const name of ['git-fsck-connectivity-only', 'check-drivers-discovered',
    'verify-version-transition', 'worktree-clean-before-build', 'predist-report-build-scope']) {
    assert.ok(one(name).index < build.index, name + ' remains before the renderer build');
  }
  assert.deepEqual(build.command, ['npm', 'run', 'build']);
  assert.ok(verify.command.includes('--strict'));
  assert.equal(verify.notApplicable, undefined);
  for (const name of ['electron-builder-linux-deb', 'packaged-qa-suite',
    'release-readiness', 'dpkg-install', 'tag-build-version', 'declaration-facts']) {
    assert.ok(verify.index < one(name).index, name + ' remains behind strict verification');
  }
  assert.ok(steps.every(step => step.stop === true), 'a failed step still stops the cut');
});

for (const [name, packaging] of [['dist', 'electron-builder --win nsis'],
  ['dist:linux', 'electron-builder --linux deb --x64']]) {
  test('T240: ' + name + ' builds before strict verification and keeps packaging gated', () => {
    const commands = scripts[name].split(' && ');
    assert.equal(commands.filter(command => command === 'npm run build').length, 1);
    assert.equal(commands.filter(command => command === 'npm run verify:release').length, 1);
    const build = commands.indexOf('npm run build');
    const verify = commands.indexOf('npm run verify:release');
    assert.ok(build < verify, 'a refusing ratchet must leave the renderer available');
    assert.ok(commands.indexOf(packaging) > verify, 'packaging still follows strict verification');
    assert.equal(scripts['verify:release'], 'node tools/test-ratchet.mjs --strict');
  });
}

test("`npm run dist:linux` and the cutter's recorded dist chain name the same gates in the same order", () => {
  const steps = planSteps(synthesizedContext()).filter((step) => step.group === "dist");
  assert.ok(steps.length > 20, `the cutter's dist group is unexpectedly small: ${steps.length}`);
  const fromCutter = steps.map((step) => identityOfWords(
    (typeof step.command === "function" ? step.command(synthesizedContext()) : step.command).map(String),
  ));
  const fromScript = [...identitiesOfScript("predist:linux"), ...identitiesOfScript("dist:linux")];
  assert.deepEqual(fromScript, fromCutter,
    "package.json dist:linux and cut-linux-release-candidate.mjs planSteps() disagree; change both, and LINUX-STEP-MAPPING.md section B, together");
});

test("`npm run dist:linux` names only tools that exist in this checkout", () => {
  for (const identity of [...identitiesOfScript("predist:linux"), ...identitiesOfScript("dist:linux")]) {
    if (!identity.startsWith("tools/")) continue;
    assert.doesNotThrow(() => readFileSync(path.join(REPO, identity)), `${identity} is named by dist:linux but is not in the repository`);
  }
});

test("a fresh cut provisions dependencies before driver discovery in every dependency mode", () => {
  for (const mode of ["link", "copy", "npm-ci"]) {
    const context = synthesizedContext();
    context.nodeModules.mode = mode;
    const steps = planSteps(context);
    const dependencies = steps.filter(step => step.name.startsWith("node-modules-"));
    assert.equal(dependencies.length, 1);
    assert.equal(dependencies[0].name, `node-modules-${mode}`);
    const names = steps.map(step => step.name);
    assert.ok(names.indexOf("git-fsck-connectivity-only") < names.indexOf(dependencies[0].name));
    assert.ok(names.indexOf(dependencies[0].name) < names.indexOf("check-drivers-discovered"),
      `${mode}: discovery imports rollup and cannot run in an empty worktree`);
    assert.ok(names.includes("verify-release-test-ratchet-strict"));
    assert.ok(names.includes("packaged-qa-suite"));
  }
});

test("`release:cut:linux` runs the host-independent wrapper gates of `release:cut`, then the Linux cutter", () => {
  const linux = identitiesOfScript("release:cut:linux");
  assert.equal(linux.at(-1), "tools/release-packager/cut-linux-release-candidate.mjs");
  // boundary:ship and naming need a staged capability/ root, which exists only
  // inside the cutter's worktree after the payload is packed; the cutter runs
  // them itself right after that step (LINUX-STEP-MAPPING.md C1, C2). The two
  // that need no staged payload stay in the wrapper, as on Windows.
  const windows = identitiesOfScript("release:cut");
  for (const gate of ["tools/check-github-claims.mjs", "tools/check-drivers-discovered.mjs"]) {
    assert.ok(windows.includes(gate), `release:cut no longer runs ${gate}; revisit release:cut:linux`);
    assert.ok(linux.includes(gate), `release:cut:linux must run ${gate}`);
  }
  const cutterSteps = planSteps(synthesizedContext()).map((step) => step.name);
  for (const inCutter of ["check-boundary-ship", "check-naming"]) assert.ok(cutterSteps.includes(inCutter), `${inCutter} must run inside the Linux cutter`);
});

// ---------------------------------------------------------------------------
// Packaged UI acceptance is required for .45. Historical failed/rehearsal
// records still carry their disclosure, but cannot authorize installation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packagedQaDisclosure, writeFacts, stageReleaseNotes } from "../release-packager/cut-linux-release-candidate.mjs";

test("packaged QA must pass before installation or an immutable release tag", () => {
  const steps = planSteps(synthesizedContext());
  const nonStopping = steps.filter((step) => step.stop === false).map((step) => step.name).sort();
  assert.deepEqual(nonStopping, []);
  assert.ok(steps.find(step => step.name === "check-release-notes").index < steps.find(step => step.name === "tag-build-version").index);
  const qa = steps.find((step) => step.name === "packaged-qa-suite");
  assert.equal(qa.kind, "child", "the step still RUNS; it is not skipped or held out");
  assert.equal(qa.stop, true);
  assert.equal(qa.notApplicable, undefined);
  assert.ok(qa.index < steps.find(step => step.name === "dpkg-install").index);
  assert.ok(qa.index < steps.find(step => step.name === "tag-build-version").index);
  assert.ok(qa.command.includes("tools/packaged-qa-suite.mjs") && qa.command.includes("--release"), "the harness is invoked unedited with --release");
});

test("the packaged-QA disclosure states a refusal with its text and the stand-ins, and never claims a pass", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cut-linux-qa-"));
  try {
    const log = path.join(dir, "step-53.log");
    writeFileSync(log, "packaged-qa-suite: --release was given, but these drivers do not read it and would silently measure their default build: a, b\n");
    const records = [
      { name: "smoke-linux-sealed-unpacked", status: "green", exit: 0 },
      { name: "linux-installed-manifest-produce", status: "green", exit: 0 },
      { name: "linux-installed-manifest-verify-binding", status: "green", exit: 0 },
      { name: "packaged-qa-suite", status: "red", exit: 2, log },
      { name: "smoke-linux-sealed-installed", status: "requiresOperator", exit: null },
      { name: "installed-onboarding", status: "requiresOperator", exit: null },
    ];
    const refused = packagedQaDisclosure(records, { readLog: (file) => readFileSync(file, "utf8") });
    assert.equal(refused.ran, false);
    assert.equal(refused.exit, 2);
    assert.match(refused.refusal, /do not read it/);
    assert.match(refused.disclosure, /NOT run to a result on Linux/);
    assert.deepEqual(refused.stoodInFor.map((s) => `${s.step}:${s.status}`), [
      "smoke-linux-sealed-unpacked:green", "linux-installed-manifest-produce:green", "linux-installed-manifest-verify-binding:green",
      "smoke-linux-sealed-installed:requiresOperator", "installed-onboarding:requiresOperator",
    ]);
    const green = packagedQaDisclosure([{ name: "packaged-qa-suite", status: "green", exit: 0 }]);
    assert.equal(green.ran, true);
    assert.equal(green.deferred, null);
    const absent = packagedQaDisclosure([]);
    assert.equal(absent.ran, false);
    assert.equal(absent.status, "not-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the declaration facts carry the packaged-QA disclosure through the real writer", async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), "cut-linux-qa-facts-"));
  try {
    const log = path.join(output, "step-53-packaged-qa-suite.log");
    writeFileSync(log, "packaged-qa-suite: --release was given, but these drivers do not read it\n");
    const ctx = {
      records: [{ index: 53, name: "packaged-qa-suite", status: "red", exit: 2, signal: null, peakRssKb: 1, log }, { index: 41, name: "smoke-linux-sealed-unpacked", status: "green", exit: 0, signal: null, peakRssKb: 1 }],
      rehearsal: true, version: "9.9.9", currentVersion: "9.9.8", sourceRef: "a".repeat(40), engineRef: "b".repeat(40), buildRef: "c".repeat(40), sameVersion: false,
      deb: null, dpkg: null, manifest: null, buildInfo: null, history: null, privateInputs: { files: [], skippedTracked: [] },
      nodeModules: { mode: "copy", fellBackFrom: null, reasons: [] }, excludedWip: null, otherCandidates: [], tag: null, installedProof: false,
      attribution: { cutterAttribution: "test" }, output,
    };
    await writeFacts(ctx, {});
    const facts = JSON.parse(readFileSync(path.join(output, "facts-scan-9.9.9", "declaration-facts-9.9.9.json"), "utf8"));
    assert.equal(facts.packagedQaSuite.ran, false);
    assert.equal(facts.packagedQaSuite.exit, 2);
    assert.match(facts.packagedQaSuite.refusal, /do not read it/);
    assert.equal(facts.packagedQaSuite.stoodInFor.find((s) => s.step === "smoke-linux-sealed-unpacked").status, "green");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

import { fillLinuxInstallRecord } from '../release-packager/cut-linux-release-candidate.mjs';
test('packet release notes bind the measured package without changing other platform records', () => {
  const deb = { file: 'toolsenabled_1.0.45_amd64.deb', bytes: 1234, sha256: 'a'.repeat(64) };
  const linux = '### Linux package\n| Platform | Linux |\n| Package | pending |\n| Bytes | pending |\n| SHA-256 | pending |\n| Signed | pending |\n';
  const windows = '### Windows installer\n| Platform | Windows |\n| SHA-256 | pending |\n';
  const source = '# ToolsEnabled 1.0.45\n## Install\n' + linux + windows + '## Publisher and copyright\nUnchanged attribution.\n';
  const result = fillLinuxInstallRecord(source, deb);
  assert.ok(result.includes(`| SHA-256 | ${deb.sha256} |`));
  assert.ok(result.includes(`| Package | ${deb.file} |`));
  assert.ok(result.includes('| Bytes | 1234 |'));
  assert.ok(result.includes('| Signed | Unsigned (no embedded package signature) |'));
  assert.ok(result.includes(windows));
  assert.ok(result.endsWith('Unchanged attribution.\n'));
  assert.throws(() => fillLinuxInstallRecord(source.replace('| Bytes | pending |\n', ''), deb), /exactly one Bytes/);
  assert.throws(() => fillLinuxInstallRecord(source.replace(linux, linux + linux), deb), /exactly one Linux/);
  assert.throws(() => fillLinuxInstallRecord(source.replace('| SHA-256 | pending |', '| SHA-256 | ' + 'b'.repeat(64) + ' |'), deb), /different package digest/);
  assert.throws(() => fillLinuxInstallRecord(source, { ...deb, bytes: 0 }), /measured Linux package identity/);
});

test('packet staging verifies archive bytes and signature presence before writing the note', { skip: platformSkipReason('linux') }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cut-linux-packet-'));
  try {
    mkdirSync(path.join(root, 'docs'));
    const file = 'toolsenabled_9.9.9_amd64.deb';
    const archive = path.join(root, file);
    writeFileSync(path.join(root, 'debian-binary'), '2.0\n');
    const result = spawnSync('ar', ['rc', archive, 'debian-binary'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = '## Install\n### Linux package\n| Platform | Linux |\n| Package | pending |\n| Bytes | pending |\n| SHA-256 | pending |\n| Signed | pending |\n### Windows installer\n| Platform | Windows |\n| Package | pending |\n| Bytes | pending |\n| SHA-256 | pending |\n| Signed | pending |\n';
    const sourcePath = path.join(root, 'docs', 'RELEASE-NOTES-9.9.9.md');
    writeFileSync(sourcePath, source);
    const measured = () => { const bytes = readFileSync(archive); return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
    const context = { output: root, worktree: root, version: '9.9.9', deb: measured(), releasePlatforms: ['linux', 'windows'] };
    await stageReleaseNotes(context, {});
    assert.equal(readFileSync(sourcePath, 'utf8'), source);
    assert.ok(readFileSync(path.join(root, 'RELEASE-NOTES-9.9.9.md'), 'utf8').includes(context.deb.sha256));
    assert.doesNotMatch(readFileSync(path.join(root, 'RELEASE-NOTES-9.9.9.md'), 'utf8'), /### Windows installer|\|[^\n]*pending[^\n]*\|/);
    writeFileSync(path.join(root, '_gpgorigin'), 'fixture signature requiring verification');
    assert.equal(spawnSync('ar', ['r', archive, '_gpgorigin'], { cwd: root }).status, 0);
    await assert.rejects(stageReleaseNotes(context, {}), /Staged package changed/);
    context.deb = measured();
    await assert.rejects(stageReleaseNotes(context, {}), /signature verification is required/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
