import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { registeredToolPaths, registeredToolchainPolicyIdentity } from '../lib/transport/registered-toolchain.mjs';

// Explicit synthetic file-read boundary. No native process, Git source result,
// or admission receipt is supplied by this fixture. The unchanged role policy
// comparisons and diagnostic control flow run with nominated measured bytes.
const diagnosticUrl = new URL('../lib/transport/windows-toolchain-prerequisites.mjs?synthetic-prerequisite-reads', import.meta.url).href;
const sourceUrl = new URL('../lib/adapters/artifact-source.mjs?synthetic-prerequisite-reads', import.meta.url).href;
const filesUrl = new URL('../lib/adapters/artifact-files.mjs', import.meta.url).href;
const key = 'windows-toolchain-prerequisites.synthetic-reads';
const paths = { ...registeredToolPaths(), git: 'C:\\Program Files\\Git\\cmd\\git.exe' };
const digests = {
  node: '995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362',
  python: '5341746f92483a93e44c313de830f2fba2956f0759094404a16b2fed06c9a2ed',
  powershell: '9785001b0dcf755eddb8af294a373c0b87b2498660f724e76c4d53f9c217c7a3',
  git: 'fec691d80fccc35fcc309fbc9f720536c1d795b8a562ec169f28c9923da9600f',
};
const policyPaths = [registeredToolchainPolicyIdentity().path, fileURLToPath(new URL('../lib/adapters/artifact-source.mjs', import.meta.url))];
const probe = { calls: [], processStarts: 0, changes: {}, reads: new Map(),
  read(file) {
    this.calls.push(file);
    const role = Object.keys(paths).find(role => paths[role] === file);
    const index = (this.reads.get(file) || 0) + 1;
    this.reads.set(file, index);
    const change = this.changes[role || file];
    if (change) return change(index, file);
    if (role) return { path: file, bytes: 100, sha256: digests[role] };
    assert.ok(policyPaths.includes(file), `unexpected diagnostic read: ${file}`);
    const content = fs.readFileSync(file);
    return { path: file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  } };
globalThis[Symbol.for(key)] = probe;
const ownedReplacement = `
 const probe=globalThis[Symbol.for(${JSON.stringify(key)})];
 export const fileIdentity=(file)=>probe.read(file);
 export function runOwnedJob(){probe.processStarts++;throw new Error('NO_NATIVE_PROCESS_ALLOWED');}
`;
const filesReplacement = `
 export * from ${JSON.stringify(filesUrl)};
 export function measureFile(file){const {path,...identity}=globalThis[Symbol.for(${JSON.stringify(key)})].read(file);return identity;}
`;
const commandsReplacement = `export function execFileSync(){globalThis[Symbol.for(${JSON.stringify(key)})].processStarts++;throw new Error('NO_GIT_PROCESS_ALLOWED');}`;
register(`data:text/javascript,${encodeURIComponent(`
 export function resolve(specifier,context,nextResolve){
  if(context.parentURL===${JSON.stringify(diagnosticUrl)}||context.parentURL===${JSON.stringify(sourceUrl)}){
   if(specifier==='../adapters/artifact-source.mjs')return {url:${JSON.stringify(sourceUrl)},shortCircuit:true};
   const source=specifier.endsWith('/owned-job.mjs')?${JSON.stringify(ownedReplacement)}
    :specifier.endsWith('/artifact-files.mjs')?${JSON.stringify(filesReplacement)}
    :specifier==='node:child_process'?${JSON.stringify(commandsReplacement)}:null;
   if(source)return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  }
  return nextResolve(specifier,context);
 }
`)}`, import.meta.url);
const { inspectWindowsToolchainPrerequisites } = await import(diagnosticUrl);
const { sourceGitToolPath, assertSourceGitToolIdentity, verifyGitToolIdentity } = await import(sourceUrl);

function inspect(changes = {}) {
  probe.calls = []; probe.reads.clear(); probe.processStarts = 0; probe.changes = changes;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  try { return inspectWindowsToolchainPrerequisites(); }
  finally { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); }
}
const different = (index, path) => ({ path, bytes: 100, sha256: '0'.repeat(64) });

test('a complete diagnostic has all four roles and cannot grant execution or qualification', () => {
  const report = inspect();
  assert.equal(report.status, 'prerequisites-match');
  assert.deepEqual(report.roles.map(value => value.role), ['node', 'python', 'powershell', 'git']);
  assert.ok(report.roles.every(value => value.status === 'matches-reviewed-bytes'));
  assert.equal(report.verified, false); assert.equal(report.ready, false); assert.equal(report.executionAuthorized, false);
  assert.equal(report.schema, 'toolsenabled.windows-toolchain-prerequisite-diagnostic');
  assert.equal(probe.processStarts, 0);
  for (const path of Object.values(paths)) assert.equal(probe.reads.get(path), 2);
});

test('the laptop-shaped mismatch reports Node, PowerShell and Git together', () => {
  const report = inspect({ node: different, powershell: different, git: different });
  assert.equal(report.status, 'prerequisites-blocked');
  assert.deepEqual(report.roles.filter(value => value.status === 'different-from-reviewed-bytes').map(value => value.role), ['node', 'powershell', 'git']);
  assert.equal(report.roles[1].status, 'matches-reviewed-bytes');
  assert.equal(probe.processStarts, 0);
});

test('the desktop-shaped mismatch identifies only its unapproved system Node', () => {
  const report = inspect({ node: different });
  assert.deepEqual(report.roles.filter(value => value.status !== 'matches-reviewed-bytes').map(value => value.role), ['node']);
});

for (const role of Object.keys(paths)) {
  test(`missing ${role} is retained while the other roles are measured`, () => {
    const report = inspect({ [role]: () => { const error = new Error('file is absent'); error.code = 'ENOENT'; throw error; } });
    const selected = report.roles.find(value => value.role === role);
    assert.equal(selected.status, 'unavailable'); assert.equal(selected.identity, null); assert.equal(selected.error.code, 'ENOENT');
    assert.equal(report.roles.filter(value => value.status === 'matches-reviewed-bytes').length, 3);
    assert.equal(report.status, 'prerequisites-blocked'); assert.equal(probe.processStarts, 0);
  });
  test(`changed ${role} cannot remain a matching prerequisite snapshot`, () => {
    const report = inspect({ [role]: (index, path) => ({ path, bytes: 100, sha256: index === 1 ? digests[role] : 'f'.repeat(64) }) });
    const selected = report.roles.find(value => value.role === role);
    assert.equal(selected.status, 'changed-during-inspection'); assert.equal(selected.identity.sha256, digests[role]);
    assert.equal(report.status, 'prerequisites-blocked'); assert.equal(probe.processStarts, 0);
  });
}

test('the selected path remains part of role comparison', () => {
  const report = inspect({ node: () => ({ path: 'caller.exe', bytes: 100, sha256: digests.node }) });
  assert.equal(report.roles[0].status, 'different-from-reviewed-bytes');
  assert.equal(probe.processStarts, 0);
});

for (const file of policyPaths) test(`changed loaded policy refuses diagnostic match: ${file.split('/').at(-1)}`, () => {
  const report = inspect({ [file]: () => ({ path: file, bytes: 100, sha256: '0'.repeat(64) }) });
  assert.equal(report.status, 'policy-unavailable');
  assert.equal(report.roles.length, 4); assert.match(report.policy.error.message, /policy changed/);
  assert.equal(probe.processStarts, 0);
});

test('Git comparison and its existing actual verifier use the same fixed policy', () => {
  inspect();
  assert.equal(sourceGitToolPath(), paths.git);
  assert.throws(() => sourceGitToolPath({ git: 'caller.exe' }), /no caller/);
  assert.throws(() => assertSourceGitToolIdentity({ path: paths.git, bytes: 100, sha256: '0'.repeat(64) }), /executable changed/);
  assert.throws(() => assertSourceGitToolIdentity({ path: 'caller.exe', bytes: 100, sha256: digests.git }), /executable changed/);
  assert.deepEqual(verifyGitToolIdentity(), { bytes: 100, sha256: digests.git });
  probe.changes.git = different;
  assert.throws(() => verifyGitToolIdentity(), /executable changed/);
  assert.equal(probe.processStarts, 0);
});

test('caller configuration is refused and the actual CLI reports unsupported hosts without source execution', () => {
  assert.throws(() => inspectWindowsToolchainPrerequisites({ platform: 'win32' }), /no caller/);
  const cli = fileURLToPath(new URL('../qa/check-windows-toolchain.mjs', import.meta.url));
  const extra = spawnSync(process.execPath, [cli, '--tool', 'caller.exe'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(extra.status, 2); assert.equal(extra.signal, null); assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /no arguments, tool overrides/);
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    const actual = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(actual.status, 2); assert.equal(actual.signal, null); assert.equal(actual.stderr, '');
    const report = JSON.parse(actual.stdout);
    assert.equal(report.status, 'unsupported-host'); assert.deepEqual(report.roles, []);
    assert.equal(report.verified, false); assert.equal(report.executionAuthorized, false);
  }
});
