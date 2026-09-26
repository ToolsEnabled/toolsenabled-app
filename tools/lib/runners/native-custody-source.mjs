import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SOURCE_COMMAND_ACTIONS } from '../adapters/source-suite-manifests.mjs';
import { plainPath, contains, measureFile, digestRecord } from '../adapters/artifact-files.mjs';

export const NATIVE_CUSTODY_ACTION = SOURCE_COMMAND_ACTIONS.engine.find(row => row.id === 'engine:native-custody');
export const NATIVE_CUSTODY_LEAVES = Object.freeze({ linux: 'tests/linux-vault.test.js', win32: 'tests/vault-native.test.js' });
export const NATIVE_CONTEXT_PREFIX = 'NATIVE CUSTODY CONTEXT: ';
const FILE = fileURLToPath(import.meta.url);
function fail(message) { throw Object.assign(new Error(`Native custody source context refused: ${message}`), { code: 'NATIVE_CUSTODY_CONTEXT_REFUSED' }); }

export function nativeCustodyInputs(root) {
  root = plainPath(root, { kind: 'directory' });
  return Object.fromEntries(NATIVE_CUSTODY_ACTION.measuredInputs.map(file => {
    const { bytes, sha256 } = measureFile(path.join(root, file));
    return [file, { bytes, sha256 }];
  }));
}

// Validate actual ancestry, not an inherited temp spelling. Windows paths stay
// under the current OS account through plainPath; native vault DACL checks are
// performed by the unchanged Windows leaf. Never chmod an existing directory.
export function assertNativeCustodyEvidence(root) {
  if (typeof root !== 'string' || path.resolve(root) !== root) fail('ordinary absolute evidence root required');
  root = plainPath(root, { kind: 'directory' });
  if (process.platform === 'linux') {
    let cursor = path.parse(root).root;
    const parts = path.relative(cursor, root).split(path.sep).filter(Boolean);
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) cursor = path.join(cursor, parts[index]);
      const stat = fs.lstatSync(cursor);
      const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid)
        || ((stat.mode & 0o022) !== 0 && !stickyRoot)) fail('unsafe evidence ancestry');
      if (cursor === root && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) fail('evidence root must be owned mode0700');
    }
  }
  return root;
}

export function nativeCustodyArguments(root, directory, inputs = nativeCustodyInputs(root)) {
  return [FILE, '--engine-root', root, '--evidence-root', directory, '--inputs-sha256', digestRecord(inputs)];
}

async function main(args) {
  if (!Object.hasOwn(NATIVE_CUSTODY_LEAVES, process.platform) || args.length !== 6
    || args[0] !== '--engine-root' || args[2] !== '--evidence-root' || args[4] !== '--inputs-sha256'
    || !/^[a-f0-9]{64}$/.test(args[5])) fail('only the fixed native action and its bound context are accepted');
  const root = plainPath(args[1], { kind: 'directory' });
  if (root !== args[1]) fail('ordinary absolute source root required');
  const directory = assertNativeCustodyEvidence(args[3]);
  if (contains(root, directory) || contains(directory, root)) fail('evidence overlaps source');
  const before = nativeCustodyInputs(root), inputsSha256 = digestRecord(before);
  if (inputsSha256 !== args[5]) fail('source input identity differs');
  const scratch = path.join(directory, 'nc');
  // Leave margin for the native helper's socket filename. Bulk state stays in
  // this owned evidence tree; supported native D-Bus IPC may use system /tmp.
  if (process.platform === 'linux' && Buffer.byteLength(scratch) + 56 >= 100) fail('native scratch path is too long');
  fs.mkdirSync(scratch, { mode: 0o700 }); // Fresh, no reuse or overwrite.
  assertNativeCustodyEvidence(scratch);
  const requireEngine = createRequire(path.join(root, 'package.json'));
  const { runIsolatedChild } = requireEngine('./tests/lib/isolated-child.js');
  const result = await runIsolatedChild(process.execPath, [path.join(root, 'tests/key-custody/run.js')], {
    cwd: root, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, TOOLSENABLED_TEST_STRICT: '1' },
    stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  let inputsUnchanged = false;
  try { inputsUnchanged = digestRecord(nativeCustodyInputs(root)) === inputsSha256; } catch {}
  if (result.stdout && !result.stdout.endsWith('\n')) process.stdout.write('\n');
  process.stdout.write(NATIVE_CONTEXT_PREFIX + JSON.stringify({ schema: 'toolsenabled.native-custody-source-context',
    root, scratch, inputsSha256, inputsUnchanged, exitCode: result.status, signal: result.signal || null,
    errorCode: result.error?.code || null, cleanupConfirmed: result.cleanupConfirmed === true }) + '\n');
  process.exitCode = result.status === 0 && !result.signal && !result.error && result.cleanupConfirmed === true && inputsUnchanged
    ? 0 : Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === FILE) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exitCode = 2;
});
