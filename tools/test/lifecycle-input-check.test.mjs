import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, link } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkLifecycleInputs, resolveLifecycleMetadataPointer } from '../release-packager/lib/lifecycle-input-check.mjs'
import { validateLifecycleInventory } from '../lib/drivers/lifecycle-inventory-contract.mjs'
import { executeInstallerLifecycle, INSTALLER_IDENTITIES } from '../lib/drivers/installer-lifecycle.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const CLI = fileURLToPath(new URL('../release-packager/check-lifecycle-inputs.mjs', import.meta.url))
const TEMP = ownedFixtureTempRoot()
const RETAIN_FIXTURES = process.env.TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES === '1'
if (![undefined, '0', '1'].includes(process.env.TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES)) {
  throw new Error('TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES must be 0 or 1 when supplied')
}
function releaseFixture(t, root) {
  if (RETAIN_FIXTURES) t.after(() => t.diagnostic(`Retained lifecycle fixture: ${root}`))
  else t.after(() => rm(root, { recursive: true, force: true }))
}
const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const environment = {
  ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP, TMP: TEMP }
    : { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_FILE, GIT_CONFIG_SYSTEM: NULL_FILE,
}

function git(root, args) {
  const result = spawnSync(GIT, ['-c', `core.hooksPath=${NULL_FILE}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Lifecycle fixture', '-c', 'user.email=lifecycle-fixture@localhost', '-C', root, ...args],
  { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function sampleInventory() {
  // These measured text buffers are synthetic input declarations, never
  // executables or evidence that a real supported baseline has been installed.
  const artifact = Buffer.from('synthetic lifecycle baseline input; not an installer')
  const identity = INSTALLER_IDENTITIES.toolsenabled
  return {
    schemaVersion: 1, product: 'toolsenabled',
    supportedBaselines: [{ id: 'synthetic-prior', version: 'synthetic-prior-version', contentLayout: 'current',
      subject: { artifact: { sha256: hash(artifact), bytes: artifact.length },
        runtimeSha256: hash('synthetic runtime input'), shellSha256: hash('synthetic shell input') } }],
    dataPolicy: { id: 'synthetic-data-policy', declaration: 'policy.md', uninstallModes: [...identity.uninstallModes],
      contentKinds: [...identity.contentKinds], contentRoots: [...identity.contentRoots] },
    interruptionPolicy: { points: ['fresh-install-files-written', 'upgrade-files-written', 'uninstall-files-removed'],
      recovery: 'rerun-exact-candidate-and-reopen' },
  }
}
async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(path.join(TEMP, 'lifecycle-input-test-'))
  releaseFixture(t, root)
  const repo = path.join(root, 'repository')
  await mkdir(repo)
  git(repo, ['-c', 'init.templateDir=', 'init', '--quiet', '--object-format=sha1'])
  const inventory = sampleInventory()
  mutate(inventory)
  await writeFile(path.join(repo, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`)
  await writeFile(path.join(repo, 'policy.md'), 'Synthetic lifecycle policy fixture. No real release or execution evidence.\n')
  git(repo, ['add', '--', 'inventory.json', 'policy.md'])
  git(repo, ['commit', '--quiet', '-m', 'Create synthetic lifecycle input fixture'])
  return { root, repo, inventory, file: path.join(repo, 'inventory.json'), ref: git(repo, ['rev-parse', 'HEAD']) }
}
function invoke(args, extraEnvironment = {}, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, CLI, ...args], { cwd: TEMP, env: { ...environment, ...extraEnvironment },
    encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
}
function assertPreparationOnly(report) {
  assert.equal(report.schema, 'toolsenabled.lifecycle-input-preparation')
  assert.equal(report.scope, 'preparation-only')
  assert.equal(report.status, 'inputs-checked')
  assert.match(report.authority, /Installer bytes, guest authority and runtime execution were not measured/)
  assert.ok(report.remainingPrerequisites.some(value => value.includes('pinned Windows reader')))
  assert.ok(report.remainingPrerequisites.some(value => value.includes('declaration hashes do not establish those bytes')))
  for (const key of ['ready', 'releaseReady', 'run', 'observations', 'execution', 'fixture', 'subject', 'value']) assert.equal(Object.hasOwn(report, key), false)
}

test('shared schema preserves fixed lifecycle constraints and original refusal codes', () => {
  const value = sampleInventory()
  assert.equal(validateLifecycleInventory(value, 'toolsenabled', INSTALLER_IDENTITIES), value)
  const cases = [
    [item => { item.supportedBaselines = [] }, /upgrade coverage is unmeasured/],
    [item => { item.supportedBaselines.push(structuredClone(item.supportedBaselines[0])) }, /duplicate supported baseline/],
    [item => { const other = structuredClone(item.supportedBaselines[0]); other.id = 'second'; item.supportedBaselines.push(other) }, /duplicate supported baseline artifact/],
    [item => { item.supportedBaselines[0].subject.installer = item.supportedBaselines[0].subject.artifact }, /legacy installer identity/],
    [item => { delete item.supportedBaselines[0].subject.runtimeSha256 }, /subject is missing/],
    [item => { item.supportedBaselines[0].contentLayout = 'historical' }, /migration driver is unavailable/],
    [item => { item.dataPolicy.declaration = '../outside.md' }, /data policy is unavailable/],
    [item => { item.dataPolicy.uninstallModes.pop() }, /uninstall\/data decisions/],
    [item => { item.interruptionPolicy.points.pop() }, /interruption points/],
    [item => { item.interruptionPolicy.recovery = 'ignore' }, /recovery strategy is unavailable/],
    [item => { item.executable = 'not-authority' }, /baseline inventory contract/],
  ]
  for (const [mutate, message] of cases) {
    const changed = structuredClone(value); mutate(changed)
    assert.throws(() => validateLifecycleInventory(changed, 'toolsenabled', INSTALLER_IDENTITIES), error => {
      assert.equal(error.code, 'INSTALLER_LIFECYCLE_BLOCKED')
      assert.equal(error.cleanupUnconfirmed, false)
      assert.match(error.message, message)
      return true
    })
  }
  assert.throws(() => validateLifecycleInventory(value, '__proto__', INSTALLER_IDENTITIES), /unknown product identity/)
})

test('actual clean committed inputs produce byte-bound preparation provenance and declared baseline identities', async t => {
  const item = await fixture(t)
  const report = checkLifecycleInputs({ inventoryPath: item.file })
  assertPreparationOnly(report)
  assert.equal(report.product, 'toolsenabled')
  assert.equal(report.provenance.ref, item.ref)
  assert.equal(report.provenance.repository, item.repo)
  assert.equal(report.inventory.sha256, hash(await readFile(item.file)))
  assert.equal(report.policy.declarationSha256, hash(await readFile(path.join(item.repo, 'policy.md'))))
  assert.deepEqual(report.baselineDeclarations[0].declaredSubject, item.inventory.supportedBaselines[0].subject)
  assert.equal(report.provenance.preparationTool.path, GIT)
  assert.match(report.provenance.preparationTool.sha256, /^[a-f0-9]{64}$/)
  assert.equal(git(item.repo, ['status', '--porcelain=v1']), '')
})

test('reachable CLI validates committed inputs despite poisoned ambient Git redirects', async t => {
  const item = await fixture(t)
  const result = invoke(['--inventory', item.file, '--product', 'toolsenabled'], {
    GIT_DIR: path.join(item.root, 'must-not-use'), GIT_WORK_TREE: path.join(item.root, 'wrong-tree'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: path.join(item.root, 'wrong-again'),
    GIT_CONFIG_GLOBAL: path.join(item.root, 'must-not-read'), GIT_EXEC_PATH: path.join(item.root, 'must-not-execute'),
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assertPreparationOnly(report)
  assert.equal(report.provenance.ref, item.ref)
})

test('production lifecycle rejects an emitted preparation report before guest or native entry', async t => {
  const item = await fixture(t)
  const emitted = invoke(['--inventory', item.file])
  assert.ifError(emitted.error)
  assert.equal(emitted.status, 0, emitted.stderr)
  const report = JSON.parse(emitted.stdout)
  assertPreparationOnly(report)
  const candidate = Buffer.from('synthetic candidate identity; not an installer')
  let guestAccesses = 0
  const guest = new Proxy(Object.create(null), { get() {
    guestAccesses += 1
    throw new Error('Preparation report reached guest capability access')
  } })
  await assert.rejects(executeInstallerLifecycle({
    product: 'toolsenabled', profile: 'windows-x64-standard', runId: randomUUID(),
    subject: { artifact: { sha256: hash(candidate), bytes: candidate.length },
      runtimeSha256: hash('synthetic candidate runtime'), shellSha256: hash('synthetic candidate shell') },
    inventory: report, guest,
  }), error => {
    assert.equal(error.code, 'INSTALLER_LIFECYCLE_BLOCKED')
    // An unbranded inventory falls back to the production reader. Its missing
    // path guard refuses before filesystem or native Git access can begin.
    assert.equal(error.message, 'Installer lifecycle blocked: inventory must name an absolute Dev-side file')
    assert.equal(error.cleanupUncertain, false)
    assert.equal(error.cleanupUnconfirmed, false)
    return true
  })
  assert.equal(guestAccesses, 0)
})

test('linked worktree preparation binds its own HEAD and reciprocal common metadata', async t => {
  const item = await fixture(t)
  const linked = path.join(item.root, 'linked')
  git(item.repo, ['worktree', 'add', '--quiet', '--detach', linked, item.ref])
  assert.throws(() => checkLifecycleInputs({ inventoryPath: path.join(linked, 'inventory.json') }), /requires an explicit primary repository root/)
  const report = checkLifecycleInputs({ inventoryPath: path.join(linked, 'inventory.json'), repositoryRoot: item.repo })
  assertPreparationOnly(report)
  assert.equal(report.provenance.repository, linked)
  assert.equal(report.provenance.ref, item.ref)
  assert.equal(report.provenance.primaryRepository, item.repo)
  const cli = invoke(['--inventory', path.join(linked, 'inventory.json'), '--repository-root', item.repo])
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).provenance.repository, linked)
  assert.equal(report.inventory.sha256, hash(await readFile(path.join(linked, 'inventory.json'))))
  // Changes in the other worktree must not select its bytes or index.
  await writeFile(path.join(item.repo, 'policy.md'), 'Other worktree remains uncommitted.\n')
  assert.equal(checkLifecycleInputs({ inventoryPath: path.join(linked, 'inventory.json'), repositoryRoot: item.repo }).provenance.ref, item.ref)
  await writeFile(path.join(linked, 'policy.md'), 'Selected worktree changed.\n')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: path.join(linked, 'inventory.json'), repositoryRoot: item.repo }), /source bytes differ/)
})

test('linked worktree pointers refuse wrong backlinks and foreign profiles before Git execution', async t => {
  const item = await fixture(t)
  const linked = path.join(item.root, 'linked')
  git(item.repo, ['worktree', 'add', '--quiet', '--detach', linked, item.ref])
  const metadata = git(linked, ['rev-parse', '--absolute-git-dir'])
  const backlink = path.join(metadata, 'gitdir')
  await writeFile(backlink, path.join(item.repo, '.git') + '\n')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: path.join(linked, 'inventory.json'), repositoryRoot: item.repo }), /explicit repository metadata authority/)
  await writeFile(backlink, path.join(linked, '.git') + '\n')
  await writeFile(path.join(metadata, 'commondir'), 'C:\\Users\\Forbidden-Fixture\\do-not-follow\n')
  const result = invoke(['--inventory', path.join(linked, 'inventory.json'), '--repository-root', item.repo], {}, ['--permission', '--allow-fs-read=*'])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /foreign-profile input refused before probing/)
  assert.doesNotMatch(result.stderr, /ERR_ACCESS_DENIED|allow-child-process|local Git preparation command/)
})

test('linked worktrees retain common-object and worktree-config refusal checks', async t => {
  for (const mode of ['include', 'partial', 'alternates', 'malformed']) {
    const item = await fixture(t)
    const linked = path.join(item.root, 'linked')
    git(item.repo, ['worktree', 'add', '--quiet', '--detach', linked, item.ref])
    const metadata = git(linked, ['rev-parse', '--absolute-git-dir'])
    const file = path.join(linked, 'inventory.json')
    if (mode === 'include') await writeFile(path.join(metadata, 'config.worktree'), '[include]\n path = forbidden\n')
    if (mode === 'partial') await writeFile(path.join(metadata, 'config.worktree'), '[remote "origin"]\n promisor = true\n')
    if (mode === 'alternates') await writeFile(path.join(item.repo, '.git', 'objects', 'info', 'alternates'), '/not-an-input\n')
    if (mode === 'malformed') await writeFile(path.join(metadata, 'commondir'), '../..\nextra\n')
    assert.throws(() => checkLifecycleInputs({ inventoryPath: file, repositoryRoot: item.repo }),
      { include: /configuration includes/, partial: /partial clone/, alternates: /alternates and grafts/, malformed: /malformed linked worktree/ }[mode])
  }
})


test('metadata pointer authority accepts reciprocal Linux and Windows targets and rejects lexical escapes without I/O', () => {
  for (const [platform, paths, base] of [
    ['linux', path.posix, '/synthetic-owner/source'],
    ['win32', path.win32, 'C:\\Users\\Synthetic-Owner\\source'],
  ]) {
    const file = paths.join(base, 'linked', '.git')
    const allowed = paths.join(base, 'primary', '.git', 'worktrees')
    const target = paths.join(allowed, 'linked')
    const options = { file, allowed, prefix: 'gitdir: ', child: true, platform }
    assert.equal(resolveLifecycleMetadataPointer('gitdir: ' + target + '\n', options), target)
    assert.equal(resolveLifecycleMetadataPointer('gitdir: ' + paths.relative(paths.dirname(file), target) + '\r\n', options), target)
    for (const value of [paths.join(base, 'untrusted', 'worktrees', 'linked'), paths.dirname(allowed), allowed,
      paths.join(allowed, 'nested', 'linked')]) {
      assert.throws(() => resolveLifecycleMetadataPointer('gitdir: ' + value + '\n', options),
        /explicit repository metadata authority/)
    }
    const common = paths.dirname(allowed)
    const commonFile = paths.join(target, 'commondir')
    assert.equal(resolveLifecycleMetadataPointer('../..\n', { file: commonFile, allowed: common, platform }), common)
    assert.throws(() => resolveLifecycleMetadataPointer(paths.join(base, 'other-common') + '\n',
      { file: commonFile, allowed: common, platform }), /explicit repository metadata authority/)
    assert.throws(() => resolveLifecycleMetadataPointer('gitdir: ' + target + '\nextra\n', options), /malformed/)
  }
})

test('hostile metadata targets are refused before any target probe or Git execution', async t => {
  for (const pointerName of ['marker', 'commondir', 'gitdir']) {
    const item = await fixture(t)
    const linked = path.join(item.root, 'linked')
    git(item.repo, ['worktree', 'add', '--quiet', '--detach', linked, item.ref])
    const metadata = git(linked, ['rev-parse', '--absolute-git-dir'])
    const forbidden = path.join(item.root, 'unauthorized-metadata')
    const pointerFile = pointerName === 'marker' ? path.join(linked, '.git') : path.join(metadata, pointerName)
    await writeFile(pointerFile, (pointerName === 'marker' ? 'gitdir: ' : '') + forbidden + '\n')
    // Intercept reads only, before the actual native filesystem call. The target
    // is a fresh path in this test's owned root, never another account. No
    // deletion API or assertion is replaced; a missed lexical guard becomes
    // a named probe failure instead of touching even this synthetic target.
    const guard = path.join(item.root, 'guard-metadata-read.mjs')
    await writeFile(guard, [
      "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';",
      'const forbidden = ' + JSON.stringify(forbidden) + ';',
      "for (const name of ['lstatSync','statSync','readFileSync','openSync','readdirSync']) {",
      ' const original = fs[name]; fs[name] = function(file,...args) {',
      "  if (typeof file === 'string' && file === forbidden) throw new Error('FORBIDDEN_METADATA_PROBE');",
      '  return original.call(this,file,...args); }; }',
      'syncBuiltinESMExports();',
    ].join('\n'))
    const result = invoke(['--inventory', path.join(linked, 'inventory.json'), '--repository-root', item.repo], {},
      ['--permission', '--allow-fs-read=*', '--import', guard])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /explicit repository metadata authority before probing/)
    assert.doesNotMatch(result.stderr, /FORBIDDEN_METADATA_PROBE|ERR_ACCESS_DENIED|allow-child-process|local Git preparation command/)
  }
})

test('dirty tracked bytes and untracked inputs cannot become committed preparation evidence', async t => {
  const item = await fixture(t)
  await writeFile(path.join(item.repo, 'policy.md'), 'Changed, uncommitted policy\n')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: item.file }), /source bytes differ/)
  const untracked = await fixture(t)
  await writeFile(path.join(untracked.repo, 'untracked.txt'), 'Untracked fixture\n')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: untracked.file }), /dirty or has untracked/)
})

test('missing, empty and invalid committed policy declarations refuse', async t => {
  const missing = await fixture(t, value => { value.dataPolicy.declaration = 'missing.md' })
  assert.throws(() => checkLifecycleInputs({ inventoryPath: missing.file }), /ENOENT/)
  const empty = await fixture(t)
  await writeFile(path.join(empty.repo, 'policy.md'), '')
  git(empty.repo, ['add', '--', 'policy.md']); git(empty.repo, ['commit', '--quiet', '-m', 'Empty fixture policy'])
  assert.throws(() => checkLifecycleInputs({ inventoryPath: empty.file }), /declaration is empty/)
  const wrong = await fixture(t, value => { value.dataPolicy.contentRoots = [] })
  assert.throws(() => checkLifecycleInputs({ inventoryPath: wrong.file }), /customer-data root census/)
})

test('selected hard links, parent links and linked Git metadata refuse before Git traversal', async t => {
  const item = await fixture(t)
  const alias = path.join(item.root, 'linked-repository')
  await symlink(item.repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: path.join(alias, 'inventory.json') }), /linked\/reparse-point input refused/)
  await link(path.join(item.repo, 'policy.md'), path.join(item.root, 'policy-alias.md'))
  assert.throws(() => checkLifecycleInputs({ inventoryPath: item.file }), /permitted-link file/)
  const metadata = await fixture(t)
  const moved = path.join(metadata.root, 'moved-metadata')
  await rename(path.join(metadata.repo, '.git'), moved)
  await symlink(moved, path.join(metadata.repo, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: metadata.file }), /linked\/reparse-point input refused/)
})

test('Git includes, object alternates and partial clones cannot redirect preparation outside the selected source', async t => {
  const included = await fixture(t)
  const config = path.join(included.repo, '.git', 'config')
  await writeFile(config, `${await readFile(config, 'utf8')}\n[include]\n\tpath = C:\\Users\\Forbidden-Fixture\\do-not-open\n`)
  assert.throws(() => checkLifecycleInputs({ inventoryPath: included.file }), /configuration includes/)
  const alternate = await fixture(t)
  await writeFile(path.join(alternate.repo, '.git', 'objects', 'info', 'alternates'), '/synthetic-do-not-open\n')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: alternate.file }), /alternates and grafts/)
  const partial = await fixture(t)
  const partialConfig = path.join(partial.repo, '.git', 'config')
  await writeFile(partialConfig, `${await readFile(partialConfig, 'utf8')}\n[extensions]\n\tpartialClone = fixture-must-not-fetch\n`)
  assert.throws(() => checkLifecycleInputs({ inventoryPath: partial.file }), /partial clone configuration is unsupported/)
})

test('valid Git partial-clone key spellings refuse before any Git subprocess', async t => {
  const cases = [
    ['inline remote', '[remote "origin"] promisor = true\n', 'remote.origin.promisor', 'bool', 'true'],
    ['inline extension', '[extensions] partialClone = origin\n', 'extensions.partialclone', 'path', 'origin'],
    ['deprecated mixed-case section', '[REMOTE.origin]PrOmIsOr=true\r\n', 'remote.origin.promisor', 'bool', 'true'],
    ['quoted closing bracket', '[remote "ori]gin"] promisor=true\n', 'remote.ori]gin.promisor', 'bool', 'true'],
    ['escaped subsection quote', '[remote "ori\\"gin"] promisor=true\n', 'remote.ori"gin.promisor', 'bool', 'true'],
    ['standalone boolean', '[remote "origin"]\n promisor\n', 'remote.origin.promisor', 'bool', 'true'],
    ['inline boolean', '[remote "origin"] promisor\n', 'remote.origin.promisor', 'bool', 'true'],
  ]
  for (const filename of ['config', 'config.worktree']) {
    for (const [name, setting, key, type, expected] of cases) {
      await t.test(`${filename}: ${name}`, async t => {
        const item = await fixture(t)
        const config = path.join(item.repo, '.git', filename)
        const original = filename === 'config' ? await readFile(config, 'utf8') : ''
        await writeFile(config, `${original}\n${setting}`)
        // Installed Git confirms these are real settings. This local config
        // read has no remote URL, object lookup, or network operation.
        assert.equal(git(item.repo, ['config', '--no-includes', '--file', config, `--type=${type}`, '--get', key]), expected)
        // The actual preparation CLI receives no subprocess permission. A
        // missed guard would fail at Git invocation, not with this refusal.
        const result = invoke(['--inventory', item.file], {}, ['--permission', '--allow-fs-read=*'])
        assert.ifError(result.error)
        assert.equal(result.status, 1, result.stderr)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /partial clone configuration is unsupported; preparation cannot fetch missing objects/)
        assert.doesNotMatch(result.stderr, /ERR_ACCESS_DENIED|allow-child-process|local Git preparation command/)
      })
    }
  }
})

test('ordinary promisor-named branch refs remain usable while actual pack markers refuse', async t => {
  const item = await fixture(t)
  git(item.repo, ['branch', 'topic.promisor'])
  assert.equal(git(item.repo, ['rev-parse', 'refs/heads/topic.promisor']), item.ref)
  assert.match(await readFile(path.join(item.repo, '.git', 'logs', 'refs', 'heads', 'topic.promisor'), 'utf8'), new RegExp(item.ref))
  const clean = invoke(['--inventory', item.file])
  assert.ifError(clean.error)
  assert.equal(clean.status, 0, clean.stderr)
  assertPreparationOnly(JSON.parse(clean.stdout))
  const markerId = createHash('sha1').update('synthetic promisor pack marker; no pack objects').digest('hex')
  await writeFile(path.join(item.repo, '.git', 'objects', 'pack', `pack-${markerId}.promisor`), '')
  const partial = invoke(['--inventory', item.file], {}, ['--permission', '--allow-fs-read=*'])
  assert.ifError(partial.error)
  assert.equal(partial.status, 1, partial.stderr)
  assert.equal(partial.stdout, '')
  assert.match(partial.stderr, /partial clone metadata is unsupported; preparation cannot fetch missing objects/)
  assert.doesNotMatch(partial.stderr, /ERR_ACCESS_DENIED|allow-child-process|local Git preparation command/)
})

test('hidden index state and Git replacements refuse even when normal status could look clean', async t => {
  const hidden = await fixture(t)
  git(hidden.repo, ['update-index', '--assume-unchanged', '--', 'policy.md'])
  assert.throws(() => checkLifecycleInputs({ inventoryPath: hidden.file }), /index.*hides tracked files/)
  const replaced = await fixture(t)
  git(replaced.repo, ['update-ref', `refs/replace/${replaced.ref}`, replaced.ref])
  assert.throws(() => checkLifecycleInputs({ inventoryPath: replaced.file }), /replacement refs/)
})

test('an input outside a repository terminates its ancestor search without native profile probing', async t => {
  const directory = await mkdtemp(path.join(TEMP, 'lifecycle-no-repository-'))
  releaseFixture(t, directory)
  const file = path.join(directory, 'inventory.json')
  await writeFile(file, '{}')
  assert.throws(() => checkLifecycleInputs({ inventoryPath: file }), /bounded ancestor search/)
  for (const spelling of ['C:\\Users\\Forbidden-Fixture\\inventory.json', 'C:/Users/Forbidden-Fixture/inventory.json']) {
    assert.throws(() => checkLifecycleInputs({ inventoryPath: spelling }), /foreign-profile input refused before probing/)
  }
  assert.throws(() => checkLifecycleInputs({ inventoryPath: file, guest: {} }), /authority overrides are not accepted/)
})

test('CLI distinguishes preparation rejection, argument errors and help without partial reports', async t => {
  const item = await fixture(t)
  for (const args of [[], ['--inventory'], ['--inventory', ''], ['--inventory', item.file, '--inventory', item.file], ['--guest', 'claimed'], ['--help', '--unknown']]) {
    const result = invoke(args)
    assert.ifError(result.error)
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Lifecycle input preparation failed:/)
  }
  for (const args of [['--inventory', 'relative.json'], ['--inventory', item.file, '--product', '__proto__']]) {
    const result = invoke(args)
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
  }
  const help = invoke(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /preparation-only/)
  assert.match(help.stdout, /native prerequisites remain/)
})
