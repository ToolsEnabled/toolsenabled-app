import assert from 'node:assert/strict';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// SYNTHETIC NATIVE BOUNDARY ONLY. Load the unchanged production source module
// under an explicit test tag. Its real metadata reads and refusals run against
// ordinary local files; only the fixed Windows Git identity and command imports
// are replaced. The command replacement always throws before any execution and
// never returns a ref, source snapshot, qualification result or native proof.
const sourceUrl = new URL('../lib/adapters/artifact-source.mjs?synthetic-offline-native-boundary', import.meta.url).href;
const filesUrl = new URL('../lib/adapters/artifact-files.mjs', import.meta.url).href;
const fixedGit = 'C:\\Program Files\\Git\\cmd\\git.exe';
const fixedGitSha256 = 'fec691d80fccc35fcc309fbc9f720536c1d795b8a562ec169f28c9923da9600f';
const probeKey = 'artifact-source-offline.synthetic-native-boundary';
const probe = { identities: [], commands: [] };
globalThis[Symbol.for(probeKey)] = probe;
const filesReplacement = `
  export * from ${JSON.stringify(filesUrl)};
  import { measureFile as realMeasureFile } from ${JSON.stringify(filesUrl)};
  export function measureFile(file, options) {
    if (file !== ${JSON.stringify(fixedGit)}) return realMeasureFile(file, options);
    globalThis[Symbol.for(${JSON.stringify(probeKey)})].identities.push({ file, options });
    return { sha256: ${JSON.stringify(fixedGitSha256)}, bytes: 1 };
  }
`;
const commandReplacement = `
  export function execFileSync(file, args, options) {
    globalThis[Symbol.for(${JSON.stringify(probeKey)})].commands.push({ file, args, options });
    const error = new Error('SYNTHETIC_NATIVE_COMMAND_BOUNDARY: no process was started');
    error.code = 'SYNTHETIC_NATIVE_COMMAND_BOUNDARY';
    throw error;
  }
`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL === ${JSON.stringify(sourceUrl)}) {
      const source = specifier === './artifact-files.mjs' ? ${JSON.stringify(filesReplacement)}
        : specifier === 'node:child_process' ? ${JSON.stringify(commandReplacement)} : null;
      if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { sourceHead, cleanSourceSnapshot, sourceRepositoryRoot } = await import(sourceUrl);
const expectedRef = '1'.repeat(40);
const coreConfig = '[core]\nrepositoryFormatVersion = 0\nbare = false\n';

function fixture(t, { config = coreConfig, worktreeConfig, files = {}, linkedWorktree = false } = {}) {
  const tempRoot = ownedFixtureTempRoot();
  const root = fs.mkdtempSync(path.join(tempRoot, 'artifact-source-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const common = linkedWorktree ? path.join(root, 'common') : path.join(checkout, '.git');
  const metadata = linkedWorktree ? path.join(common, 'worktrees', 'fixture') : common;
  fs.mkdirSync(checkout, { recursive: true });
  for (const relative of ['objects/info', 'objects/pack', 'refs/heads']) {
    fs.mkdirSync(path.join(common, relative), { recursive: true });
  }
  if (linkedWorktree) {
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${metadata}\n`);
    fs.writeFileSync(path.join(metadata, 'commondir'), '../..\n');
  }
  fs.writeFileSync(path.join(common, 'config'), config);
  if (worktreeConfig !== undefined) fs.writeFileSync(path.join(metadata, 'config.worktree'), worktreeConfig);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(common, relative)), { recursive: true });
    fs.writeFileSync(path.join(common, relative), content);
  }
  return checkout;
}

function beginProbe() {
  probe.identities.length = 0;
  probe.commands.length = 0;
}

function implementationFile(checkout) {
  const file = path.join(checkout, 'tools', 'lib', 'implementation.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// Inert repository-discovery fixture.\n');
  return file;
}

for (const linkedWorktree of [false, true]) {
  test(`repository discovery finds the nearest ordinary ${linkedWorktree ? 'linked worktree' : 'checkout'} through the native path fence`, t => {
    const checkout = fixture(t, { linkedWorktree });
    const file = implementationFile(checkout);
    beginProbe();
    assert.equal(sourceRepositoryRoot(file), checkout);
    assert.deepEqual(probe.identities, [], 'repository discovery does not admit a Git executable');
    assert.deepEqual(probe.commands, [], 'repository discovery never starts Git');
  });
}

for (const [label, prepare, reason] of [
  ['malformed nearest pointer', (nested) => fs.writeFileSync(path.join(nested, '.git'), 'not a Git pointer\n'), /malformed Git worktree pointer/],
  ['nearest partial-clone metadata', (nested) => {
    fs.mkdirSync(path.join(nested, '.git'));
    fs.writeFileSync(path.join(nested, '.git', 'config'), '[extensions]\npartialClone = origin\n');
  }, /partial.clone/],
  ['linked nearest metadata', (nested, enclosing) => fs.symlinkSync(path.join(enclosing, '.git'), path.join(nested, '.git'), process.platform === 'win32' ? 'junction' : 'dir'), /linked\/reparse-point/],
  ['hard-linked nearest configuration', (nested, enclosing) => {
    for (const relative of ['objects/info', 'objects/pack', 'refs/heads']) fs.mkdirSync(path.join(nested, '.git', relative), { recursive: true });
    fs.linkSync(path.join(enclosing, '.git', 'config'), path.join(nested, '.git', 'config'));
  }, /ordinary permitted-link file/],
]) {
  test(`repository discovery refuses ${label} rather than using a valid enclosing repository`, t => {
    const enclosing = fixture(t), nested = path.join(enclosing, 'nested');
    const file = implementationFile(nested);
    prepare(nested, enclosing);
    beginProbe();
    assert.throws(() => sourceRepositoryRoot(file), error => error.code === 'ARTIFACT_QUALIFICATION_BLOCKED' && reason.test(error.message));
    assert.deepEqual(probe.identities, []);
    assert.deepEqual(probe.commands, []);
  });
}

test('repository discovery retains the Windows account fence before any foreign path access (synthetic platform only)', () => {
  // Execute the production function bodies with Windows path semantics and an
  // in-memory filesystem. No actual Windows profile or native process is used.
  const reads = [], home = 'C:\\FixtureOwner', file = home + '\\checkout\\module.mjs';
  const context = vm.createContext({ path: path.win32, userInfo: () => ({ homedir: home }),
    process: { platform: 'win32' }, Buffer,
    fs: { lstatSync(value) {
      reads.push(value);
      if (value.endsWith('\\.git')) throw Object.assign(new Error('absent fixture marker'), { code: 'ENOENT' });
      return { isSymbolicLink: () => false, isDirectory: () => value !== file, isFile: () => value === file };
    }, existsSync: () => false } });
  const body = url => fs.readFileSync(url, 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(body(new URL(filesUrl)) + '\n' + body(new URL('../lib/adapters/artifact-source.mjs', import.meta.url))
    + '\nglobalThis.api = { plainPath, sourceRepositoryRoot };', context);
  for (const invoke of [value => context.api.plainPath(value, { kind: 'file' }), context.api.sourceRepositoryRoot]) {
    assert.throws(() => invoke('C:\\FixtureOther\\module.mjs'), /path leaves its approved profile\/tool root/);
    assert.deepEqual(reads, [], 'a foreign lexical path must refuse before filesystem access');
  }
  assert.throws(() => context.api.sourceRepositoryRoot(file), /no fenced Git repository/);
  assert.ok(reads.includes(home + '\\.git'), 'the account-root marker remains eligible');
  assert.ok(reads.every(value => value === home || value.startsWith(home + '\\')), 'discovery cannot inspect above the Windows account');
});

const entrypoints = [
  ['sourceHead', root => sourceHead(root)],
  ['cleanSourceSnapshot', root => cleanSourceSnapshot(root, expectedRef)],
];

const refused = [
  ['partial-clone extension', { config: `${coreConfig}[extensions]\npartialClone = origin\n` }, /partial.clone/],
  ['inline extension key', { config: `${coreConfig}[extensions] partialClone = origin\n` }, /partial.clone/],
  ['mixed-case extension with BOM and CRLF', { config: '\uFEFF[ExTeNsIoNs]\r\n\tPaRtIaLcLoNe = origin\r\n' }, /partial.clone/],
  ['promisor remote', { config: `${coreConfig}[remote "origin"]\npromisor = true\n` }, /partial.clone/],
  ['inline promisor key', { config: `${coreConfig}[remote "origin"] promisor = true\n` }, /partial.clone/],
  ['implicit promisor boolean', { config: `${coreConfig}[remote "origin"]\npromisor # implicit true\n` }, /partial.clone/],
  ['deprecated remote subsection', { config: `${coreConfig}[remote.origin]\nPROMISOR = true\n` }, /partial.clone/],
  ['false promisor declaration', { config: `${coreConfig}[remote "origin"]\npromisor = false\n` }, /partial.clone/],
  ['duplicate promisor declaration', { config: `${coreConfig}[remote "origin"]\npromisor = false\npromisor = true\n` }, /partial.clone/],
  ['worktree-specific promisor config', { worktreeConfig: '[remote "origin"] promisor = true\n' }, /partial.clone/],
  ['linked-worktree common partial-clone config', { linkedWorktree: true, config: '[extensions]\npartialClone = origin\n' }, /partial.clone/],
  ['linked-worktree local promisor config', { linkedWorktree: true, worktreeConfig: '[remote "origin"]\npromisor = true\n' }, /partial.clone/],
  ['promisor pack marker without config', { files: { 'objects/pack/pack-fixture.promisor': '' } }, /partial.clone/],
  ['case-aliased promisor pack marker', { files: { 'objects/pack/pack-fixture.PROMISOR': '' } }, /partial.clone/],
  ['malformed section', { config: '[remote "origin"\npromisor = true\n' }, /malformed Git configuration/],
  ['key outside a section', { config: 'promisor = true\n' }, /malformed Git configuration/],
  ['malformed value escape', { config: '[core]\nvalue = "bad\\q"\n' }, /malformed Git configuration/],
  ['unterminated quoted value', { config: '[core]\nvalue = "unfinished\n' }, /malformed Git configuration/],
  ['configuration include', { config: '[include]\npath = never-opened\n' }, /configuration includes/],
  ['conditional configuration include', { config: '[includeIf "gitdir:never-opened"] path = never-opened\n' }, /configuration includes/],
  ['object alternates', { files: { 'objects/info/alternates': 'never-opened\n' } }, /object alternates/],
  ['HTTP object alternates', { files: { 'objects/info/http-alternates': 'never-opened\n' } }, /object alternates/],
];

for (const [entrypoint, invoke] of entrypoints) {
  for (const [label, metadata, reason] of refused) {
    test(`${entrypoint} refuses ${label} before the synthetic native command boundary`, t => {
      const root = fixture(t, metadata);
      beginProbe();
      assert.throws(() => invoke(root), error => error.code === 'ARTIFACT_QUALIFICATION_BLOCKED' && reason.test(error.message));
      assert.deepEqual(probe.identities, [{ file: fixedGit, options: { systemFile: true } }]);
      assert.equal(probe.commands.length, 0, 'refused metadata must not reach any native command');
    });
  }

  for (const [label, metadata] of [
    ['ordinary direct repository', {}],
    ['ordinary linked worktree', { linkedWorktree: true }],
    ['ordinary ref and reflog names ending in .promisor', {
      files: { 'refs/heads/topic.promisor': `${expectedRef}\n`, 'logs/refs/heads/topic.promisor': 'inert reflog fixture\n' },
    }],
    ['comments, inline values and continued quoted values', {
      config: `${coreConfig}# promisor = true\n[remote "ordinary]name"] url = inert-fixture\n[branch "main"]\nremote = origin\n[core]\ndescription = "promisor = true; # data"\ncontinued = "first\\\nsecond"\n`,
    }],
    ['registered clean and smudge filters', { config: `${coreConfig}[filter "fixture"]\nclean = never-run\nsmudge = never-run\nrequired = true\n` }],
  ]) {
    test(`${entrypoint} admits ${label} only up to the synthetic native command boundary`, t => {
      const root = fixture(t, metadata);
      beginProbe();
      assert.throws(() => invoke(root), { code: 'SYNTHETIC_NATIVE_COMMAND_BOUNDARY' });
      assert.equal(probe.identities.length, 1);
      assert.equal(probe.commands.length, 1);
      const call = probe.commands[0];
      assert.equal(call.file, fixedGit);
      assert.ok(call.args.includes(`--work-tree=${root}`));
      assert.deepEqual(call.args.slice(-3), ['rev-parse', '--verify', 'HEAD^{commit}']);
      assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(call.options.env.GIT_CONFIG_GLOBAL, 'NUL');
      assert.equal(call.options.timeout, 30000);
      assert.equal(call.options.windowsHide, true);
      if (label.includes('filters')) {
        for (const value of ['filter.fixture.clean=', 'filter.fixture.smudge=', 'filter.fixture.process=', 'filter.fixture.required=false']) assert.ok(call.args.includes(value));
      }
    });
  }
}
