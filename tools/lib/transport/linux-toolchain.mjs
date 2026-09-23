import fs from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, measureTree, plainPath } from '../adapters/artifact-files.mjs';
import { inspectLinuxElf, linuxElfClosure, measureLinuxSystemElf } from './linux-elf-inputs.mjs';

// Native mechanics only. These are the reviewed Node 22.19.0 Linux x64
// distribution and Ubuntu 24.04 Python 3.12 bytes measured on this owner host.
// A machine update needs a reviewed policy update, never a caller hash/override.
const APPROVED = Object.freeze({
  node: '596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9',
  python: 'e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f',
  pythonLibrary: 'fddc6e74be5029c05f59d53bc8cbcc5f70cd5222a9b2b0f23113bae27678c920',
  owner: 'c08b204adcfed2b490eae92d8c15dabbdc6133ab7474f6d9f787edbd31917ef6',
  helper: '2228cce2ef06b030e39f59b92af16c8aec8cd946305d369d792c4d7c155a2b5e',
});
const PATHS = Object.freeze({ node: process.execPath, python: '/usr/bin/python3.12' });
const OWNER = fileURLToPath(new URL('../../../shell/owned-claim-process.cjs', import.meta.url));
const HELPER = fileURLToPath(new URL('../../../shell/owned-claim-process-linux.py', import.meta.url));
const MODULE = fileURLToPath(import.meta.url);
const LOADED_POLICY = Object.freeze(measureFile(MODULE));
const PYTHON_ROOT = '/usr/lib/python3.12';
// These distribution links are not import inputs for the isolated -I -S
// owner. Their spellings are still bound; their target files are never followed.
const PYTHON_LINKS = Object.freeze({
  '_sysconfigdata__linux_x86_64-linux-gnu.py': '_sysconfigdata__x86_64-linux-gnu.py',
  'sitecustomize.py': '/etc/python3.12/sitecustomize.py',
  'config-3.12-x86_64-linux-gnu/libpython3.12.so': '../../x86_64-linux-gnu/libpython3.12.so.1',
});
const fail = message => { throw new Error(`Linux qualification toolchain blocked: ${message}`); };
const identity = file => ({ path: file, ...measureFile(file, { allowEmpty: false }) });

function ordinaryNativeHost() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 || process.geteuid?.() === 0)
    fail('requires the owning non-elevated Linux x64 account');
}
function rootOwned(file, directory = false) {
  plainPath(file, { kind: directory ? 'directory' : 'file' });
  const stat = fs.lstatSync(file);
  if (stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022) fail('system tool input is writable outside root');
}
export function linuxToolPaths() {
  if (arguments.length) fail('tool paths accept no caller overrides');
  ordinaryNativeHost();
  return PATHS;
}
export function assertLinuxToolIdentity(role, measured) {
  if (arguments.length !== 2 || !Object.hasOwn(PATHS, role) || measured?.path !== PATHS[role] ||
      !Number.isSafeInteger(measured?.bytes) || measured.bytes <= 0 || measured.sha256 !== APPROVED[role])
    fail('unapproved native tool role, path or executable bytes');
}

export function measureLinuxToolchain() {
  if (arguments.length) fail('tool measurement accepts no caller inputs');
  ordinaryNativeHost();
  if (digestRecord(measureFile(MODULE)) !== digestRecord(LOADED_POLICY)) fail('loaded native tool policy changed');
  const tools = Object.fromEntries(Object.entries(PATHS).map(([role, file]) => {
    const measured = identity(file);
    assertLinuxToolIdentity(role, measured);
    if (role === 'python') rootOwned(file);
    return [role, measured];
  }));
  // -I -S uses only this standard-library tree and the fixed executable. Bind
  // bytecode as well as source/extensions; -B prevents the owner writing caches.
  for (const directory of ['/usr', '/usr/bin', '/usr/lib', PYTHON_ROOT]) rootOwned(directory, true);
  if (fs.existsSync('/usr/lib/python312.zip')) fail('unregistered Python import archive');
  for (const [name, target] of Object.entries(PYTHON_LINKS)) {
    const file = path.join(PYTHON_ROOT, name), stat = fs.lstatSync(file);
    if (!stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || fs.readlinkSync(file) !== target) fail('Python distribution link changed');
  }
  const library = measureTree(PYTHON_ROOT, { include: name => !Object.hasOwn(PYTHON_LINKS, name) });
  if (library.sha256 !== APPROVED.pythonLibrary) fail('reviewed Python standard-library bytes changed');
  const directories = new Set();
  for (const name of Object.keys(library.files)) {
    rootOwned(path.join(PYTHON_ROOT, name));
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
  }
  for (const name of directories) rootOwned(path.join(PYTHON_ROOT, name), true);
  const owner = identity(OWNER), helper = identity(HELPER);
  if (owner.sha256 !== APPROVED.owner || helper.sha256 !== APPROVED.helper) fail('reviewed shared descendant owner changed');
  const systemElf = measureLinuxSystemElf('owner');
  const elfRoots = Object.fromEntries(Object.entries(tools).map(([role, input]) => [role, inspectLinuxElf(input.path, input)]));
  // These are the only extension modules imported by the fixed -I -S owner.
  // Their bytes also belong to the reviewed entire standard-library tree.
  for (const [role, name] of Object.entries({ ctypes: '_ctypes', json: '_json' })) {
    const file = path.join(PYTHON_ROOT, 'lib-dynload', `${name}.cpython-312-x86_64-linux-gnu.so`);
    const input = { path: file, ...library.files[path.relative(PYTHON_ROOT, file).split(path.sep).join('/')] };
    elfRoots[role] = inspectLinuxElf(file, input);
  }
  const elf = { ...systemElf, roots: elfRoots,
    nodeLibraries: linuxElfClosure([elfRoots.node], systemElf.images),
    ownerLibraries: linuxElfClosure([elfRoots.python, elfRoots.ctypes, elfRoots.json], systemElf.images),
    scope: 'fixed-owner-and-checker-ELF-inputs',
    limits: ['Native addons require their own measured source/dependency closure; arbitrary dlopen is not qualified.',
      'Protected kernel resolver/cache/library inputs must remain unchanged; this is not a hostile-root containment boundary.'] };
  return { policy: LOADED_POLICY, tools, nativeOwner: { owner, helper },
    pythonLibrary: { root: PYTHON_ROOT, sha256: library.sha256, bytes: library.bytes, links: PYTHON_LINKS }, elf };
}

export function linuxToolEnvironment(extra = {}) {
  ordinaryNativeHost();
  const home = userInfo().homedir;
  const environment = { PATH: `${path.dirname(PATHS.node)}:/usr/bin`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    HOME: home, TMPDIR: '/tmp', NO_COLOR: '1', CI: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', PAGER: '' };
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) fail('invalid command environment');
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || key.includes('\0') || key.includes('=') || value.includes('\0')) fail('invalid command environment entry');
    if (Object.hasOwn(environment, key) && value === environment[key]) continue;
    if (key === 'TOOLSENABLED_TEST_STRICT' && value === '1') environment[key] = value;
    else if (key === 'QUALIFICATION_SHELL_ROOT') environment[key] = plainPath(value, { kind: 'directory' });
    else fail(`unregistered environment key or value: ${key}`);
  }
  for (const directory of environment.PATH.split(':')) plainPath(directory, { kind: 'directory' });
  return environment;
}
