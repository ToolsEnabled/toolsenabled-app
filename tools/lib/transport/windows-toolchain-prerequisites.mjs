import { fileIdentity } from './owned-job.mjs';
import { registeredToolPaths, registeredToolchainPolicyIdentity, assertRegisteredToolIdentity } from './registered-toolchain.mjs';
import { measureFile } from '../adapters/artifact-files.mjs';
import { sourceGitToolPath, assertSourceGitToolIdentity } from '../adapters/artifact-source.mjs';
import { fileURLToPath } from 'node:url';

const same = (left, right) => left?.sha256 === right?.sha256 && left?.bytes === right?.bytes;
const errorRecord = error => ({ code: typeof error?.code === 'string' ? error.code : 'PREREQUISITE_UNAVAILABLE',
  message: String(error?.message || error) });
const gitPolicyPath = fileURLToPath(new URL('../adapters/artifact-source.mjs', import.meta.url));
const loadedGitPolicy = fileIdentity(gitPolicyPath, { maximum: 1024 * 1024 });

// This diagnostic starts no process, reads no Git source and acquires no native
// qualification lease. Its result cannot authorize work; execution and replay
// must perform their own ordinary measurements and admission checks.
export function inspectWindowsToolchainPrerequisites() {
  if (arguments.length) throw new Error('Windows prerequisite diagnostic accepts no caller inputs');
  const report = { schema: 'toolsenabled.windows-toolchain-prerequisite-diagnostic', schemaVersion: 1,
    scope: 'read-only-prerequisite-diagnostic', verified: false, ready: false, executionAuthorized: false,
    platform: process.platform, arch: process.arch, status: 'unsupported-host', policy: null, roles: [],
    authority: 'Diagnostic only. Matching tool bytes do not authorize execution or qualify source, artifacts or a release.' };
  if (process.platform !== 'win32' || process.arch !== 'x64') return report;

  const loaded = registeredToolchainPolicyIdentity();
  const readPolicy = () => fileIdentity(loaded.path, { maximum: 1024 * 1024 });
  const readGitPolicy = () => fileIdentity(gitPolicyPath, { maximum: 1024 * 1024 });
  let policyError = null;
  try {
    const actual = readPolicy(), gitPolicy = readGitPolicy();
    report.policy = { runtime: { sha256: actual.sha256, bytes: actual.bytes },
      sourceGit: { sha256: gitPolicy.sha256, bytes: gitPolicy.bytes } };
    if (!same(actual, loaded) || !same(gitPolicy, loadedGitPolicy)) throw new Error('loaded tool policy changed');
  } catch (error) { policyError = errorRecord(error); }

  const selected = registeredToolPaths();
  const readers = Object.entries(selected).map(([role, path]) => ({ role, path,
    read: () => fileIdentity(path, { system: true }), check: value => assertRegisteredToolIdentity(role, value) }));
  const git = sourceGitToolPath();
  readers.push({ role: 'git', path: git,
    read: () => ({ path: git, ...measureFile(git, { systemFile: true }) }), check: assertSourceGitToolIdentity });
  for (const { role, path, read, check } of readers) {
    const entry = { role, path, status: 'unavailable', identity: null, error: null };
    try {
      entry.identity = read();
      try { check(entry.identity); entry.status = 'matches-reviewed-bytes'; }
      catch (error) { entry.status = 'different-from-reviewed-bytes'; entry.error = errorRecord(error); }
    } catch (error) { entry.error = errorRecord(error); }
    report.roles.push(entry);
  }
  // A changing role must not look like a stable match simply because it was
  // read earlier than another role. Retain the first identity and refuse the
  // diagnostic snapshot on any subsequent difference or read failure.
  for (const [index, { read }] of readers.entries()) {
    const entry = report.roles[index];
    if (!entry.identity) continue;
    try {
      if (!same(read(), entry.identity)) throw new Error('tool changed during prerequisite inspection');
    } catch (error) { entry.status = 'changed-during-inspection'; entry.error = errorRecord(error); }
  }
  try {
    if (!same(readPolicy(), loaded) || !same(readGitPolicy(), loadedGitPolicy)) throw new Error('loaded tool policy changed');
  }
  catch (error) { policyError = errorRecord(error); }
  if (policyError) {
    report.policy = { ...report.policy, error: policyError };
    report.status = 'policy-unavailable';
  } else report.status = report.roles.every(role => role.status === 'matches-reviewed-bytes')
    ? 'prerequisites-match' : 'prerequisites-blocked';
  return report;
}
