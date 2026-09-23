import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runOwnedJob, measureRegisteredToolchain } from '../transport/owned-job.mjs';
import { blocked, plainPath, contains, readBounded, readJson, measureFile, measureTree, assertSameTree,
  parseArchiveListing, relativeName, digestRecord } from './artifact-files.mjs';
import { cleanSourceSnapshot, sourceHead, sourceRepositoryRoot, verifyGitToolIdentity, nativeSourceHead, nativeCleanSourceSnapshot } from './artifact-source.mjs';
import { measureLinuxGitToolchain } from '../transport/linux-git-toolchain.mjs';
import { measurePackagedLayout, assertNoObviousPackagedSecrets } from './artifact-layout.mjs';
import { measureLicenseDependencyInputs } from './artifact-dependencies.mjs';
import { measureStandaloneIntegrity } from './artifact-standalone-policy.mjs';
import { verifyLinuxDebianStage } from './artifact-deb.mjs';
import { nativeRuntimeTarget } from './artifact-native-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = fileURLToPath(import.meta.url);
const BUNDLE = path.dirname(HERE);
const ARTIFACT_CONTRACT = Object.freeze({
  id: 'artifact-integrity', adapterId: 'artifact-integrity:v1', scope: 'exact-packaged-artifact',
  supportedProfiles: Object.freeze(['build']),
});
const ARTIFACT_COMPONENTS = Object.freeze([
  'adapters/artifact-subject.mjs', 'adapters/artifact-files.mjs', 'adapters/artifact-source.mjs', 'adapters/artifact-source-inputs.mjs',
  'adapters/artifact-archive.mjs', 'adapters/artifact-deb.mjs',
  'adapters/artifact-layout.mjs', 'adapters/artifact-native-runtime.mjs', 'adapters/artifact-capability.mjs', 'adapters/artifact-dependencies.mjs',
  'adapters/artifact-standalone-policy.mjs', 'adapters/artifact-privacy.mjs', 'transport/owned-job.mjs',
  'transport/registered-toolchain.mjs', 'transport/linux-toolchain.mjs', 'transport/linux-owned-job.mjs', 'transport/linux-git-toolchain.mjs', 'transport/linux-elf-inputs.mjs', 'transport/linux-xz-toolchain.mjs',
].sort());
const HARNESS_COMPONENTS = Object.freeze([...ARTIFACT_COMPONENTS, 'release-readiness.mjs'].sort());
const EXECUTING_LAYOUTS = new Set(['release-readiness', 'tools/lib', 'software/testkit', 'local']);
// Bind the loaded module generation as well as the bytes later seen in Git.
// A clean commit made after imports cannot silently replace executing code.
const LOADED_COMPONENTS = Object.fromEntries(HARNESS_COMPONENTS.map(name => [name, measureFile(path.join(BUNDLE, name))]));
// Independently measured on this workspace, 7-Zip 24.08 x64. A caller cannot
// replace the decoder or turn its own tool hash into an approval. Capture the
// fixed current-owner cache selection at module load, just like the registered
// Node selection. A partial or changed cache refuses instead of falling back
// after an identity failure. Relocation never approves different decoder bytes.
const OWNER_EXTRACTOR_ROOT = path.join(os.userInfo().homedir, 'AppData', 'Local',
  'ToolsEnabledQualification', 'tools', '7zip-24.08-x64');
const OWNER_EXTRACTOR_SELECTED = ['7z.exe', '7z.dll'].some(name => fs.existsSync(path.join(OWNER_EXTRACTOR_ROOT, name)));
const EXTRACTOR_ROOT = OWNER_EXTRACTOR_SELECTED ? OWNER_EXTRACTOR_ROOT : 'C:\\Program Files\\7-Zip';
export const APPROVED_EXTRACTOR = Object.freeze({
  executable: path.join(EXTRACTOR_ROOT, '7z.exe'), sha256: '707f415d7d581edd9bce99a0429ad4629d3be0316c329e8b9ebd576f7ab50b71',
  library: path.join(EXTRACTOR_ROOT, '7z.dll'), librarySha256: 'e79ddfb6319dbf9bac6382035d23597dad979db5e71a605d81a61ee817c1e812',
});
// Explicit reviewed source bytes, with both ordinary Git LF and CRLF checkout
// forms registered. Do not derive approval from the candidate's current hash.
// Owner-data 6412f58e adds repeated-separator leak detection; owner-data 1fd56f8f
// excuses identity-profile matches only when they lie wholly inside one exact,
// case-sensitive shipped help sentence (built-in rules are never excused);
// license 2b36a900 checks every resolved production package instance instead
// of a hoisted copy; renderer-payload 2f883204 adds a third classification,
// `withheld`, enforced exactly like `operator` -- read with the same validator,
// refused if the group is absent, refused if a path is classified both ways --
// so a product asset this release does not ship is kept out of public/, dist/
// and app.asar, and gets a refusal that names why rather than calling it
// somebody's private document.
// All four scripts import only Node built-ins. Source/config/license closure,
// installed dependency notices and the private identity profile are measured
// separately before/after their actual execution.
// Owner-data 02e365fb includes the reviewed T334 machine-derived workspace
// spellings and self-check, private pattern labels, and whole-word matching
// for derived names. Built-in and authored identity rules remain unchanged.
const CHECKS = Object.freeze([
  ['tools/check-no-owner-data.mjs', ['184a45b88e0aaac3217ac8fd1801c68f56276f50491d7b5eb9e7582af84b3f3a', '37929c11733f0be5cc5ce450931aa3e84a324a8d9a6554b9a7c666868a22340c']],
  ['tools/check-license-notices.mjs', ['77daeefbeee9ff4993a399fdd85272e40c8dab343a1796ee3c71330da67e7d21', 'd359d2d875e16882153633d238c4646a3728910f4606343b407924581fa70089']],
  ['tools/check-renderer-payload.mjs', ['13b06fb1c689afd6882c556675ac4ec9a630f190ee81ced57400602b9286a93c', 'dd230da688f9956713a16c5de40e2ffc3d25be715d47013430f2794330b15565']],
  ['tools/check-payload-boundary.mjs', ['0144b7ef8630fa305733d22ac49626d10c7487d38c8fa171d6750bbc054c4613', 'a7a3ca092a7521ff90214c4e245d195d3e85b803b6dcbf9b520e4497f4342945']],
]);
const matches = (left, right) => left?.bytes === right?.bytes && left?.sha256?.toLowerCase() === right?.sha256?.toLowerCase();
function checkAbort(signal) { if (signal?.aborted) { const error = new Error('artifact qualification cancelled'); error.name = 'AbortError'; throw error; } }
function privateEvidenceForArtifact(artifactPath, evidenceRoot) {
  if (contains(path.dirname(artifactPath), evidenceRoot) || contains(evidenceRoot, artifactPath)) blocked('private execution evidence must be separate from the installer/candidate tree');
}

export function assertMeasurementContext(product, context) {
  const keys = ['evidenceRoot', 'harnessRoot', 'sourceRoots', 'stageRoot'];
  if (!context || keys.some(key => !Object.hasOwn(context, key)) || Object.keys(context).some(key => ![...keys, 'runnerConfigPath'].includes(key))) blocked('explicit source/stage/harness/private-evidence context is required');
  const sourceKeys = product === 'toolsenabled' ? ['app', 'engine'] : ['website'];
  if (!['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(product) || !context.sourceRoots ||
      Object.keys(context.sourceRoots).sort().join(',') !== sourceKeys.join(',')) blocked('source roots do not match the fixed product layout');
  const sourceRoots = Object.fromEntries(sourceKeys.map(key => [key, plainPath(context.sourceRoots[key], { kind: 'directory' })]));
  const resolved = { sourceRoots, stageRoot: plainPath(context.stageRoot, { kind: 'directory' }),
    harnessRoot: plainPath(context.harnessRoot, { kind: 'directory' }), evidenceRoot: plainPath(context.evidenceRoot, { kind: 'directory' }) };
  if ([resolved.stageRoot, resolved.harnessRoot, ...Object.values(sourceRoots)].some(root => contains(root, resolved.evidenceRoot))) blocked('evidence must be outside source, harness and packaged stage trees');
  const executingLayout = artifactExecutingLayout();
  if (contains(executingLayout.root, resolved.evidenceRoot)) blocked('evidence must be outside the executing verifier harness');
  producerBundleLayout(product, resolved.harnessRoot, executingLayout);
  if (context.runnerConfigPath !== undefined) resolved.runnerConfigPath = plainPath(context.runnerConfigPath, { kind: 'file' });
  return resolved;
}

export function verifyExtractorIdentity() {
  if (arguments.length) blocked('archive decoder identity accepts no caller path or policy');
  const executable = measureFile(APPROVED_EXTRACTOR.executable, { systemFile: !OWNER_EXTRACTOR_SELECTED });
  const library = measureFile(APPROVED_EXTRACTOR.library, { systemFile: !OWNER_EXTRACTOR_SELECTED });
  if (executable.sha256 !== APPROVED_EXTRACTOR.sha256 || library.sha256 !== APPROVED_EXTRACTOR.librarySha256) blocked('fixed approved archive decoder bytes changed');
  // 7-Zip can load additional decoder DLLs from these directories. An approved
  // main executable/library pair does not approve any independently added codec.
  for (const name of ['Codecs', 'Formats']) {
    let present = false;
    try { fs.lstatSync(path.join(EXTRACTOR_ROOT, name)); present = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (present) blocked('additional archive decoder codecs/formats are not registered');
  }
  return { executable, library };
}

export function verifyArtifactCheckerInputs(sourceRoot) {
  if (arguments.length !== 1) blocked('artifact checker inputs accept only the explicit source root');
  sourceRoot = plainPath(sourceRoot, { kind: 'directory' });
  return Object.fromEntries(CHECKS.map(([relative, approved]) => {
    const measured = measureFile(path.join(sourceRoot, relative));
    if (!approved.includes(measured.sha256)) blocked(`reviewed artifact checker changed: ${relative}`);
    return [relative, measured];
  }));
}

export function verifyArtifactToolchainBinding(expected) {
  if (arguments.length !== 1) blocked('artifact toolchain requires its measured subject binding');
  const actual = measureRegisteredToolchain();
  if (!expected || digestRecord(actual) !== digestRecord(expected)) blocked('registered artifact checker toolchain differs from the measured subject');
  return actual;
}

function requireCompleted(result) {
  if (!result || result.complete !== true || result.exitCode !== 0 || result.cleanupConfirmed !== true || result.hadRemainingChildren === true ||
      result.timedOut || result.outputLimitExceeded || result.notRun) {
    const error = new Error('bounded artifact command did not complete cleanly');
    error.code = 'ARTIFACT_COMMAND_FAILED';
    error.terminationConfirmed = result?.cleanupConfirmed === true;
    error.cleanupUnconfirmed = result?.cleanupConfirmed !== true;
    error.execution = result;
    throw error;
  }
  return result;
}

function rawOutput(result) {
  const bytes = readBounded(result.stdout.path);
  if (!matches(measureFile(result.stdout.path), result.stdout)) blocked('archive command output changed');
  return bytes.toString('utf8');
}

function removeOwnedExtraction(directory, parent) {
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('.artifact-extract-')) blocked('not an owned extraction directory');
  plainPath(directory, { kind: 'directory' });
  function remove(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = plainPath(path.join(current, entry.name));
      if (entry.isDirectory()) remove(file);
      else if (entry.isFile()) fs.unlinkSync(file);
      else blocked('uncertain extraction entry retained for inspection');
    }
    fs.rmdirSync(current);
  }
  remove(directory);
}

export function standaloneArchiveSelection(listing, stage) {
  const selected = [];
  for (const [name, identity] of Object.entries(stage.files)) {
    const found = listing.entries.filter(entry => !entry.directory && [name, `$INSTDIR/${name}`].includes(entry.name));
    if (found.length !== 1 || found[0].bytes !== identity.bytes) blocked('NSIS cannot account for every exact staged file and size');
    selected.push({ archiveName: found[0].name, stageName: name });
  }
  const chosen = new Set(selected.map(entry => entry.archiveName));
  for (const entry of listing.entries) if (!entry.directory && !chosen.has(entry.name) &&
      !entry.name.startsWith('$PLUGINSDIR/') && !['Uninstall.exe', '$INSTDIR/Uninstall.exe'].includes(entry.name)) blocked('NSIS includes an unaccounted installed payload file');
  return selected;
}

// No installer is executed. NSIS is decoded explicitly; the embedded 7z payload
// is selected by its NSIS file table, not by scanning for a convenient magic.
export async function verifyInstallerStage({ product, artifactPath, stageRoot, evidenceRoot, signal, appRoot, target }) {
  checkAbort(signal);
  const selected = nativeRuntimeTarget(target);
  if (selected.platform === 'linux') {
    if (product !== 'toolsenabled') blocked('Linux Debian decoding is only registered for ToolsEnabled');
    return verifyLinuxDebianStage({ artifactPath, stageRoot, evidenceRoot, signal, appRoot });
  }
  if (!['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(product)) blocked('unknown installer product layout');
  artifactPath = plainPath(artifactPath, { kind: 'file' });
  stageRoot = plainPath(stageRoot, { kind: 'directory' });
  evidenceRoot = plainPath(evidenceRoot, { kind: 'directory' });
  privateEvidenceForArtifact(artifactPath, evidenceRoot);
  if (contains(stageRoot, evidenceRoot) || contains(evidenceRoot, stageRoot)) blocked('extraction evidence and stage must be separate trees');
  const tool = verifyExtractorIdentity();
  const artifactBefore = measureFile(artifactPath, { allowEmpty: false });
  const stageBefore = measureTree(stageRoot);
  const scratch = fs.mkdtempSync(path.join(plainPath(evidenceRoot, { kind: 'directory' }), '.artifact-extract-'));
  let cleanupSafe = true;
  const runs = [];
  async function seven(args) {
    checkAbort(signal);
    verifyExtractorIdentity();
    let result;
    // A transport exception does not establish that its owned children exited.
    // Retain the private scratch until a returned result confirms cleanup.
    cleanupSafe = false;
    result = await runOwnedJob({ command: APPROVED_EXTRACTOR.executable, args, cwd: scratch, evidenceRoot, signal,
      timeoutMs: 180000, maxOutputBytes: 16 * 1024 * 1024 });
    cleanupSafe = result.cleanupConfirmed === true;
    runs.push(result);
    if (result.cleanupConfirmed !== true) cleanupSafe = false;
    requireCompleted(result); checkAbort(signal); return result;
  }
  try {
    const listing = parseArchiveListing(rawOutput(await seven(['l', '-slt', '-tNsis', '--', artifactPath])), { type: 'Nsis', requireSizes: false });
    const extracted = path.join(scratch, 'payload');
    fs.mkdirSync(extracted);
    if (product === 'toolsenabled') {
      const payload = listing.entries.filter(entry => entry.name === '$PLUGINSDIR/app-64.7z');
      if (payload.length !== 1 || !Number.isSafeInteger(payload[0].bytes) || payload[0].bytes <= 0) blocked('NSIS does not contain one exact x64 application archive');
      const container = path.join(scratch, 'container');
      fs.mkdirSync(container);
      await seven(['e', '-y', '-tNsis', `-o${container}`, '--', artifactPath, '$PLUGINSDIR\\app-64.7z']);
      const archive = path.join(container, 'app-64.7z');
      if (measureFile(archive).bytes !== payload[0].bytes || Object.keys(measureTree(container).files).length !== 1) blocked('NSIS selected-archive extraction was incomplete or ambiguous');
      const inner = parseArchiveListing(rawOutput(await seven(['l', '-slt', '-t7z', '--', archive])), { type: '7z' });
      const expectedNames = Object.keys(stageBefore.files).sort();
      const archiveNames = inner.entries.filter(entry => !entry.directory).map(entry => entry.name).sort();
      if (JSON.stringify(expectedNames) !== JSON.stringify(archiveNames) || inner.entries.some(entry => !entry.directory && entry.bytes !== stageBefore.files[entry.name]?.bytes)) blocked('embedded archive file selection/size differs from stage');
      await seven(['x', '-y', '-t7z', `-o${extracted}`, '--', archive]);
    } else {
      const selection = standaloneArchiveSelection(listing, stageBefore);
      const raw = path.join(scratch, 'nsis-files');
      fs.mkdirSync(raw);
      const includes = path.join(scratch, 'selected-files.txt');
      fs.writeFileSync(includes, selection.map(entry => entry.archiveName.replaceAll('/', '\\')).join('\n') + '\n', { flag: 'wx' });
      await seven(['x', '-y', '-tNsis', '-scsUTF-8', `-i@${includes}`, `-o${raw}`, '--', artifactPath]);
      const extractedRaw = measureTree(raw);
      if (Object.keys(extractedRaw.files).length !== selection.length) blocked('NSIS extracted extra/missing selected files');
      for (const entry of selection) {
        const from = plainPath(path.join(raw, entry.archiveName), { kind: 'file' });
        const to = path.join(extracted, relativeName(entry.stageName));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      }
    }
    const extractedTree = measureTree(extracted);
    assertSameTree(stageBefore, extractedTree);
    assertSameTree(stageBefore, measureTree(stageRoot));
    if (!matches(artifactBefore, measureFile(artifactPath))) blocked('installer changed during decoding');
    verifyExtractorIdentity();
    return { artifact: artifactBefore, stage: stageBefore, decoder: tool, runs };
  } catch (error) {
    if (error.terminationConfirmed === false) cleanupSafe = false;
    if (!cleanupSafe) { error.terminationConfirmed = false; error.cleanupUnconfirmed = true; error.extractionDirectory = scratch; }
    throw error;
  } finally {
    if (cleanupSafe) removeOwnedExtraction(scratch, evidenceRoot);
    // Unknown descendants retain their exact private extraction directory.
  }
}

function artifactExecutingLayout() {
  const root = sourceRepositoryRoot(MODULE);
  const layout = relativeName(path.relative(root, BUNDLE));
  if (!EXECUTING_LAYOUTS.has(layout)) blocked('executing artifact bundle has an unreviewed repository layout');
  return { root, layout };
}

function producerBundleLayout(product, harnessRoot, executing) {
  if (!['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(product)) blocked('unknown artifact harness product');
  if (path.relative(harnessRoot, executing.root) === '' && executing.layout === 'release-readiness') return 'release-readiness';
  return product === 'toolsenabled' ? 'tools/lib' : 'software/testkit';
}

// There is no caller-provided executing root, resolver, hash allowlist or trust
// override. Both sides are real clean Git snapshots. The subject continues to
// bind ONLY the original producer harness; verifier provenance stays separate.
export function measureArtifactHarnesses(product, harnessRoot) {
  harnessRoot = plainPath(harnessRoot, { kind: 'directory' });
  const executing = artifactExecutingLayout();
  const producerLayout = producerBundleLayout(product, harnessRoot, executing);
  const verifier = cleanSourceSnapshot(executing.root, sourceHead(executing.root));
  const harness = path.relative(harnessRoot, executing.root) === '' ? verifier : cleanSourceSnapshot(harnessRoot, sourceHead(harnessRoot));
  return bindArtifactHarnesses(harnessRoot, executing, producerLayout, verifier, harness);
}

function bindArtifactHarnesses(harnessRoot, executing, producerLayout, verifier, harness) {
  const producerBundle = plainPath(path.join(harnessRoot, producerLayout), { kind: 'directory' });
  const components = {};
  for (const name of HARNESS_COMPONENTS) {
    const executingName = `${executing.layout}/${name}`, producerName = `${producerLayout}/${name}`;
    const actual = measureFile(path.join(BUNDLE, name));
    const original = measureFile(path.join(producerBundle, name));
    if (!matches(actual, LOADED_COMPONENTS[name])) blocked('executing artifact dependency changed after module load');
    if (!verifier.files[executingName] || !matches(actual, verifier.files[executingName])) blocked('executing artifact dependency is not in its clean verifier commit');
    if (!harness.files[producerName] || !matches(original, harness.files[producerName])) blocked('artifact dependency is not in the original clean producer commit');
    if (!matches(original, actual)) blocked(`producer/verifier artifact dependency bytes differ: ${name}`);
    components[name] = actual;
  }
  return { harness, verifier, producerLayout, verifierLayout: executing.layout,
    implementationSha256: digestRecord(Object.fromEntries(ARTIFACT_COMPONENTS.map(name => [name, components[name]]))),
    core: components['release-readiness.mjs'] };
}

async function sourceInputs(product, context, sourceRefs, target, signal) {
  const expectedKeys = product === 'toolsenabled' ? ['app', 'engine'] : ['website'];
  if (!sourceRefs || Object.keys(sourceRefs).sort().join(',') !== expectedKeys.join(',')) blocked('candidate source-ref selection is incomplete');
  if (target.platform === 'win32') {
    const binding = measureArtifactHarnesses(product, context.harnessRoot);
    const sources = Object.fromEntries(expectedKeys.map(key => [key,
      path.relative(context.sourceRoots[key], context.harnessRoot) === '' && sourceRefs[key] === binding.harness.ref
        ? binding.harness : cleanSourceSnapshot(context.sourceRoots[key], sourceRefs[key]) ]));
    return { sources, ...binding, nativeExecution: [] };
  }
  if (product !== 'toolsenabled') blocked('Linux source qualification supports only the maintained desktop product');
  const nativeExecution = [], options = { target, evidenceRoot: context.evidenceRoot, signal };
  const snapshot = async (root, ref) => {
    if (!ref) {
      const head = await nativeSourceHead(root, options);
      nativeExecution.push(head.nativeExecution); ref = head.ref;
    }
    const { nativeExecution: execution, ...measured } = await nativeCleanSourceSnapshot(root, ref, options);
    nativeExecution.push(execution); return measured;
  };
  const executing = artifactExecutingLayout(), producerLayout = producerBundleLayout(product, context.harnessRoot, executing);
  const verifier = await snapshot(executing.root);
  const harness = path.relative(context.harnessRoot, executing.root) === '' ? verifier : await snapshot(context.harnessRoot);
  const binding = bindArtifactHarnesses(context.harnessRoot, executing, producerLayout, verifier, harness), sources = {};
  for (const key of expectedKeys) sources[key] = path.relative(context.sourceRoots[key], context.harnessRoot) === '' && sourceRefs[key] === harness.ref
    ? harness : await snapshot(context.sourceRoots[key], sourceRefs[key]);
  return { sources, ...binding, nativeExecution };
}

const sourceIdentity = ({ nativeExecution, ...identity }) => identity;

function artifactFileGeneration(file) {
  const stat = fs.lstatSync(plainPath(file, { kind: 'file' }), { bigint: true });
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
}

function assertArtifactUnchanged(file, expected, generation) {
  if (artifactFileGeneration(file) !== generation || !matches(measureFile(file, { allowEmpty: false }), expected) ||
      artifactFileGeneration(file) !== generation) blocked('installer artifact changed during qualification');
}

async function measuredSubject(input, { signal, expectedSubject } = {}) {
  checkAbort(signal);
  const { product, artifactPath, sourceRefs } = input;
  const selected = nativeRuntimeTarget(input.target), target = { platform: selected.platform, arch: selected.arch };
  if (target.platform !== process.platform || target.arch !== process.arch) blocked('artifact qualification requires its actual native target');
  const context = assertMeasurementContext(product, input.context);
  privateEvidenceForArtifact(plainPath(artifactPath, { kind: 'file' }), context.evidenceRoot);
  const artifactGeneration = artifactFileGeneration(artifactPath);
  const artifact = measureFile(artifactPath, { allowEmpty: false });
  if (input.artifact && !matches(input.artifact, artifact)) blocked('caller artifact identity differs from measured installer bytes');
  const before = await sourceInputs(product, context, sourceRefs, target, signal);
  if (expectedSubject && (expectedSubject.harness?.clean !== true || expectedSubject.harness.ref !== before.harness.ref ||
      expectedSubject.harness.sha256 !== before.harness.sha256 || expectedSubject.sourceSha256 !== digestRecord(before.sources))) blocked('original producer harness or source identity changed');
  const toolchain = measureRegisteredToolchain();
  if (expectedSubject) verifyArtifactToolchainBinding(expectedSubject.toolchain);
  checkAbort(signal);
  const layout = measurePackagedLayout({ product, stageRoot: context.stageRoot, sourceRoots: context.sourceRoots, sourceRefs, target });
  const extracted = await verifyInstallerStage({ product, artifactPath, stageRoot: context.stageRoot, evidenceRoot: context.evidenceRoot,
    appRoot: context.sourceRoots.app, target, signal });
  if (!matches(extracted.artifact, artifact)) blocked('decoded installer differs from the original artifact identity');
  assertSameTree(layout.stage, extracted.stage);
  const after = await sourceInputs(product, context, sourceRefs, target, signal);
  if (digestRecord(sourceIdentity(before)) !== digestRecord(sourceIdentity(after))) blocked('source or harness changed during exact-artifact measurement');
  verifyArtifactToolchainBinding(toolchain);
  assertArtifactUnchanged(artifactPath, artifact, artifactGeneration);
  const subject = { product, artifact, sourceRefs: { ...sourceRefs }, sourceSha256: digestRecord(before.sources), stageSha256: extracted.stage.sha256,
    runtimeSha256: layout.runtimeSha256, shellSha256: layout.shellSha256, harness: { clean: true, ref: before.harness.ref, sha256: before.harness.sha256 },
    target, context, decoder: extracted.decoder, toolchain, sourceTool: target.platform === 'linux' ? measureLinuxGitToolchain() : verifyGitToolIdentity(),
    ...(context.runnerConfigPath ? { runnerConfiguration: measureFile(context.runnerConfigPath) } : {}) };
  return { subject, layout, extraction: extracted, sourceExecutions: [...before.nativeExecution, ...after.nativeExecution], artifactGeneration };
}

export async function measureArtifactSubject(input) { return (await measuredSubject(input)).subject; }

async function integrityChecks(input, measured, { signal } = {}) {
  checkAbort(signal);
  if (input.product !== 'toolsenabled') {
    const standalone = await measureStandaloneIntegrity({ product: input.product, sourceRoot: input.context.sourceRoots.website,
      stageRoot: input.context.stageRoot, expectedStage: measured.layout.stage, signal });
    assertArtifactUnchanged(input.artifactPath, measured.subject.artifact, measured.artifactGeneration);
    return { results: [], dependencyIdentity: { sha256: digestRecord(standalone), bytes: measured.layout.stage.bytes },
      privacyProfile: standalone.privacy.profile, standalone };
  }
  assertNoObviousPackagedSecrets(input.context.stageRoot);
  const app = input.context.sourceRoots.app;
  // Guard the existing license scanner's dependency lookup before launching it:
  // a missing dependency must not search upward outside the explicit source.
  const dependencyIdentity = measureLicenseDependencyInputs(app);
  const profile = measureFile(path.join(app, 'private', 'owner-data-patterns.owner.json'));
  const checkers = verifyArtifactCheckerInputs(app);
  const toolchain = verifyArtifactToolchainBinding(measured.subject.toolchain);
  const results = [];
  for (const [relative] of CHECKS) {
    checkAbort(signal);
    verifyArtifactToolchainBinding(toolchain);
    const commandFile = path.join(app, relative);
    if (!matches(measureFile(commandFile), checkers[relative])) blocked(`reviewed artifact checker changed: ${relative}`);
    const args = [commandFile, relative.endsWith('check-payload-boundary.mjs') ? path.join(input.context.stageRoot, 'resources', 'capability') : input.context.stageRoot];
    if (relative.endsWith('check-payload-boundary.mjs')) args.splice(1, 0, '--ship');
    results.push(requireCompleted(await runOwnedJob({ command: toolchain.tools.node.path, args, cwd: app, evidenceRoot: input.context.evidenceRoot, signal,
      timeoutMs: 180000, maxOutputBytes: 8 * 1024 * 1024 })));
  }
  verifyArtifactToolchainBinding(toolchain);
  if (digestRecord(verifyArtifactCheckerInputs(app)) !== digestRecord(checkers) || measureLicenseDependencyInputs(app).sha256 !== dependencyIdentity.sha256 || !matches(measureFile(path.join(app, 'private', 'owner-data-patterns.owner.json')), profile)) blocked('privacy/license tool or inputs changed during checking');
  const sourceAfterChecks = await sourceInputs(input.product, input.context, input.sourceRefs, measured.subject.target, signal);
  if (digestRecord(sourceAfterChecks.sources) !== measured.subject.sourceSha256 ||
      sourceAfterChecks.harness.ref !== measured.subject.harness.ref || sourceAfterChecks.harness.sha256 !== measured.subject.harness.sha256) blocked('source or harness changed during artifact checking');
  assertSameTree(measured.layout.stage, measureTree(input.context.stageRoot));
  assertArtifactUnchanged(input.artifactPath, measured.subject.artifact, measured.artifactGeneration);
  return { results, dependencyIdentity: { sha256: dependencyIdentity.sha256, bytes: dependencyIdentity.bytes }, privacyProfile: profile,
    sourceExecutions: sourceAfterChecks.nativeExecution };
}

export async function executeArtifactIntegrity({ required, profile, subject, subjectSha256, run, artifactPath, context }) {
  if (required?.id !== ARTIFACT_CONTRACT.id || required.scope !== ARTIFACT_CONTRACT.scope ||
      !ARTIFACT_CONTRACT.supportedProfiles.includes(profile) || !run?.id) blocked('artifact adapter received the wrong required scope/profile');
  const implementationSha256 = artifactImplementationIdentity();
  if (required.adapter?.id !== ARTIFACT_CONTRACT.adapterId || required.adapter.sha256 !== implementationSha256) blocked('artifact adapter received the wrong artifact adapter identity');
  const startedAt = new Date().toISOString();
  const input = { product: subject.product, artifactPath,
    artifact: subject.artifact, sourceRefs: subject.sourceRefs, target: subject.target, context: context || subject.context };
  const measured = await measuredSubject(input, { expectedSubject: subject });
  if (digestRecord(measured.subject) !== digestRecord(subject) || digestRecord(subject) !== subjectSha256) blocked('artifact adapter subject changed');
  const checks = await integrityChecks(input, measured);
  const assertions = [
    { id: 'source-and-payload-bound', status: 'passed', evidenceSha256: digestRecord(measured.layout.sourceAndPayload) },
    { id: 'runtime-and-dependency-closure', status: 'passed', evidenceSha256: digestRecord(measured.layout.runtimeAndClosure) },
    { id: 'privacy-and-license-checks', status: 'passed', evidenceSha256: digestRecord({ dependencyIdentity: checks.dependencyIdentity, privacyProfile: checks.privacyProfile }) },
  ];
  const record = { schema: 'toolsenabled.artifact-integrity-execution', schemaVersion: 1, input, subjectSha256, assertions,
    sourceExecutions: [...measured.sourceExecutions, ...(checks.sourceExecutions || [])],
    ...(measured.extraction.accounting ? { installerAccounting: measured.extraction.accounting } : {}),
    extraction: measured.extraction.runs, checks: checks.results, startedAt, finishedAt: new Date().toISOString() };
  const reportPath = path.join(input.context.evidenceRoot, `artifact-integrity-${randomUUID()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const report = { ...measureFile(reportPath), path: reportPath };
  return { id: ARTIFACT_CONTRACT.id, profile, scope: ARTIFACT_CONTRACT.scope, adapterId: ARTIFACT_CONTRACT.adapterId, adapterSha256: implementationSha256,
    subjectSha256, runId: run.id, startedAt, finishedAt: record.finishedAt,
    execution: { command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], adapterFunction: 'executeArtifactIntegrity',
      commands: [...measured.extraction.runs, ...checks.results].map(result => result.command), complete: true, exitCode: 0, signal: null, cleanupConfirmed: true,
      synthetic: false, sourceOverlay: false, hostRuntime: false },
    environment: { platform: process.platform, arch: process.arch, profile, osBuild: os.release(), isolated: true, isolation: 'private-extraction-only' },
    report, assertions, counts: { tests: assertions.length, passed: assertions.length, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 } };
}

// Deliberately async: a new process must re-decode the real installer and rerun
// the real fixed checks. Stored success flags, prior extracted bytes, and a
// process-local permission/cache token are not evidence. Core integration must
// await this function before registering the adapter as available.
export async function verifyArtifactIntegrityEvidence(observation, subject, { signal } = {}) {
  try {
    checkAbort(signal);
    if (observation?.id !== ARTIFACT_CONTRACT.id || observation.scope !== ARTIFACT_CONTRACT.scope ||
        !ARTIFACT_CONTRACT.supportedProfiles.includes(observation.profile) || observation.environment?.profile !== observation.profile ||
        observation.adapterId !== ARTIFACT_CONTRACT.adapterId || observation.adapterSha256 !== artifactImplementationIdentity() ||
        observation.subjectSha256 !== digestRecord(subject)) return false;
    const file = plainPath(observation?.report?.path, { kind: 'file' });
    if (!contains(subject.context.evidenceRoot, file) || !matches(measureFile(file), observation.report)) return false;
    const record = readJson(file);
    if (record.schema !== 'toolsenabled.artifact-integrity-execution' || record.schemaVersion !== 1 ||
        record.subjectSha256 !== observation.subjectSha256 || record.subjectSha256 !== digestRecord(subject) || JSON.stringify(record.assertions) !== JSON.stringify(observation.assertions)) return false;
    const measured = await measuredSubject(record.input, { signal, expectedSubject: subject });
    if (digestRecord(measured.subject) !== digestRecord(subject)) return false;
    const checks = await integrityChecks(record.input, measured, { signal });
    const expected = [digestRecord(measured.layout.sourceAndPayload), digestRecord(measured.layout.runtimeAndClosure),
      digestRecord({ dependencyIdentity: checks.dependencyIdentity, privacyProfile: checks.privacyProfile })];
    return expected.every((sha256, index) => observation.assertions[index]?.evidenceSha256 === sha256);
  } catch (error) { return artifactVerificationFailure(error); }
}

// A failed verification is not automatically an observed clean shutdown. Keep
// the original error/quarantine paths for the core's abort-settlement audit.
export function artifactVerificationFailure(error) {
  if (error?.cleanupUnconfirmed === true || error?.terminationConfirmed === false) {
    error.cleanupUnconfirmed = true;
    throw error;
  }
  return false;
}

export function artifactImplementationIdentity() {
  return digestRecord(Object.fromEntries(ARTIFACT_COMPONENTS.map(name => [name, measureFile(path.join(BUNDLE, name))])));
}

// No automatic registry mutation here. Exact-installed/lifecycle assertions
// belong to separate adapters and are not earned by static archive decoding.
