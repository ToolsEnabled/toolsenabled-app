import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainPath, relativeName, measureFile, digestRecord } from './artifact-files.mjs';
import { cleanSourceSnapshot, sourceHead, sourceRepositoryRoot, nativeSourceHead, nativeCleanSourceSnapshot } from './artifact-source.mjs';

const MODULE = fileURLToPath(import.meta.url);
const BUNDLE = path.dirname(path.dirname(MODULE));
const COMPONENTS = Object.freeze([
  'adapters/source-suites.mjs',
  'adapters/source-suite-manifests.mjs',
  'adapters/source-command-plan.mjs',
  'adapters/role-studio-source.mjs',
  'adapters/engine-performance-source.mjs',
  // Eager local require closure of the Role verifier: scenario IDs, archive
  // pins, and the Windows account fence all influence the loaded verdict.
  'page2-native-role-scenarios.cjs',
  'page2-native-scenarios.cjs',
  'page2-native-state-evidence.cjs',
  'page2-native-compose-evidence.cjs',
  'native-driver-dependencies.cjs',
  '../../shell/install-profile-guard.cjs',
  'adapters/source-harness.mjs',
  'adapters/artifact-files.mjs',
  'adapters/artifact-source.mjs',
  'transport/owned-job.mjs',
  'transport/registered-toolchain.mjs',
  'runners/shell-source.mjs',
  'runners/native-custody-source.mjs',
].sort());
const BOUND_FILES = Object.freeze([...COMPONENTS, 'release-readiness.mjs'].sort());
const PRODUCTS = new Set(['toolsenabled', 'scribe', 'web-editor', 'presentation-suite']);
const EXECUTING_LAYOUTS = new Set(['release-readiness', 'tools/lib', 'software/testkit', 'local']);
const LOADED_FILES = Object.fromEntries(BOUND_FILES.map(name => [name, measureFile(path.join(BUNDLE, name))]));
const same = (left, right) => left?.bytes === right?.bytes && left?.sha256 === right?.sha256;

function fail(message) {
  const error = new Error(`Source harness blocked: ${message}`);
  error.code = 'SOURCE_HARNESS_BLOCKED';
  throw error;
}

function executingLayout() {
  // The actual loaded file chooses the consumer; no receipt field, environment
  // variable or supplied callback can redirect this discovery.
  const root = sourceRepositoryRoot(MODULE);
  const layout = relativeName(path.relative(root, BUNDLE));
  if (!EXECUTING_LAYOUTS.has(layout)) fail('executing source bundle has an unreviewed repository layout');
  return { root, layout };
}

function currentFiles() {
  const files = {};
  for (const name of BOUND_FILES) {
    const actual = measureFile(path.join(BUNDLE, name));
    if (!same(actual, LOADED_FILES[name])) fail(`executing source dependency changed after module load: ${name}`);
    files[name] = actual;
  }
  return files;
}

// These names are fixed implementation dependencies, never receipt-supplied
// paths. Normalize the shell dependency against each measured repository layout.
function repositoryFile(layout, name) {
  return relativeName(path.posix.normalize(`${layout}/${name}`));
}

function componentHash(files) {
  // Logical bundle-relative names keep registration/report identities equal
  // across app, website and publisher locations. Core bytes are separately
  // compared, avoiding a static core -> adapter -> core embedded hash cycle.
  return digestRecord(Object.fromEntries(COMPONENTS.map(name => [name, files[name]])));
}

export function sourceHarnessImplementationIdentity() {
  if (arguments.length) fail('implementation identity takes no component or path overrides');
  return componentHash(currentFiles());
}

// Bounded native-custody execution uses the actual App bundle only. Linux Git
// measurement is already an owned native job; do not route it through the
// Windows-only synchronous source measurer or accept a caller's harness root.
export async function measureNativeCustodyHarness(options) {
  if (!options || Object.keys(options).some(key => !['evidenceRoot', 'signal'].includes(key))) fail('invalid native custody harness options');
  const root = path.resolve(BUNDLE, '../..');
  if (path.relative(root, BUNDLE) !== path.join('tools', 'lib')) fail('native custody needs the executing App bundle');
  if (process.platform === 'win32') {
    const measured = measureSourceHarnesses('toolsenabled', root);
    return { root, source: measured.consumer, componentSha256: measured.componentSha256, core: measured.core, nativeExecution: [] };
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('unregistered native custody host');
  const nativeOptions = { ...options, target: { platform: 'linux', arch: 'x64' } };
  const head = await nativeSourceHead(root, nativeOptions);
  const { nativeExecution, ...source } = await nativeCleanSourceSnapshot(root, head.ref, nativeOptions);
  const files = currentFiles();
  for (const name of BOUND_FILES) {
    if (!same(files[name], source.files[repositoryFile('tools/lib', name)])) fail('native custody harness is not its clean loaded commit');
  }
  return { root, source, componentSha256: componentHash(files), core: files['release-readiness.mjs'],
    nativeExecution: [head.nativeExecution, nativeExecution] };
}

// Filesystem/Git measurement only: this function does not run source suites,
// shell fixtures, native transport, products or providers. A matching result is
// not permission to skip independent source replay or release qualification.
export function measureSourceHarnesses(product, originalHarnessRoot) {
  if (arguments.length !== 2) fail('only product and original producer harness root are accepted');
  try { return measureBoundHarnesses(product, originalHarnessRoot); }
  catch (error) {
    // Fixed read-only Git still has a bounded subprocess lifetime. Preserve an
    // ambiguous termination for the source verifier/core settlement audit; it
    // must not be flattened into an ordinary clean red verification result.
    if (error?.terminationConfirmed === false) error.cleanupUnconfirmed = true;
    throw error;
  }
}

function measureBoundHarnesses(product, originalHarnessRoot) {
  if (!PRODUCTS.has(product)) fail('unknown source harness product');
  originalHarnessRoot = plainPath(originalHarnessRoot, { kind: 'directory' });
  const execution = executingLayout();
  const sameRepository = path.relative(originalHarnessRoot, execution.root) === '';
  const producerLayout = sameRepository && execution.layout === 'release-readiness'
    ? 'release-readiness' : product === 'toolsenabled' ? 'tools/lib' : 'software/testkit';
  const producerBundleRoot = plainPath(path.join(originalHarnessRoot, producerLayout), { kind: 'directory' });
  const consumerBundleRoot = plainPath(path.join(execution.root, execution.layout), { kind: 'directory' });
  const consumer = cleanSourceSnapshot(execution.root, sourceHead(execution.root));
  const producer = sameRepository ? consumer : cleanSourceSnapshot(originalHarnessRoot, sourceHead(originalHarnessRoot));
  const files = currentFiles();
  for (const name of BOUND_FILES) {
    const actual = files[name], original = measureFile(path.join(producerBundleRoot, name));
    if (!consumer.files[repositoryFile(execution.layout, name)] || !same(actual, consumer.files[repositoryFile(execution.layout, name)])) fail(`executing source dependency is not in its clean consumer commit: ${name}`);
    if (!producer.files[repositoryFile(producerLayout, name)] || !same(original, producer.files[repositoryFile(producerLayout, name)])) fail(`source dependency is not in the original clean producer commit: ${name}`);
    if (!same(original, actual)) fail(`producer/consumer source dependency bytes differ: ${name}`);
  }
  // Keep producer and consumer snapshots separate. Report/replay integration
  // must retain the producer's subject identity and choose the shell runner
  // from these fixed, verified bundle roots rather than from a report path.
  return { producer, consumer, producerBundleRoot, consumerBundleRoot,
    producerLayout, consumerLayout: execution.layout, componentSha256: componentHash(files),
    core: files['release-readiness.mjs'] };
}
