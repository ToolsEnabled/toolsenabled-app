import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertNativeDependencyRuntime,
  assertPrivateDependencyTree,
  nativeDependencyInstallCommand,
  provisionNodeModules,
  releaseNodeModulesJunction,
} from '../release-packager/lib/node-modules-reuse.mjs'
import { measureLicenseDependencyInputs } from '../lib/adapters/artifact-dependencies.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const helperUrl = new URL('../release-packager/lib/node-modules-reuse.mjs', import.meta.url).href
const quiet = { log: () => {} }
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function scratch(t) {
  const parent = ownedFixtureTempRoot()
  const directory = await mkdtemp(path.join(parent, 'cut-dependencies-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent))
    assert.ok(path.basename(directory).startsWith('cut-dependencies-'))
    assert.equal((await lstat(directory)).isSymbolicLink(), false)
    const detach = async current => {
      for (const name of await readdir(current)) {
        const entry = path.join(current, name), stat = await lstat(entry)
        if (stat.isSymbolicLink()) await removeLink(entry)
        else if (stat.isDirectory()) await detach(entry)
      }
    }
    // Remove link entries without following any target before recursive cleanup.
    await detach(directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return directory
}

async function removeLink(entry) {
  try { await unlink(entry) }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR'].includes(error.code) || !(await lstat(entry)).isSymbolicLink()) throw error
    await rmdir(entry)
  }
}

function fixtureEnvironment(cwd, extra = {}) {
  const env = { ...process.env,
    npm_config_cache: path.join(cwd, '..', '.npm-fixture-cache'),
    npm_config_userconfig: path.join(cwd, '..', '.npm-fixture-userconfig'),
    npm_config_globalconfig: path.join(cwd, '..', '.npm-fixture-globalconfig'),
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    ...extra,
  }
  const oldPath = Object.keys(env).find(key => /^path$/i.test(key))
  const search = oldPath ? env[oldPath] : ''
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key]
  env.PATH = [path.dirname(process.execPath), search].filter(Boolean).join(path.delimiter)
  return env
}

function npm(args, cwd) {
  const env = fixtureEnvironment(cwd)
  for (const key of Object.keys(env)) {
    if (/^npm_config_(prefix|local_prefix|global|location)$/i.test(key)) delete env[key]
  }
  // npm 10.9.3 install treats where === globalTop as a global self-install,
  // even with --global=false. On Windows --prefix . makes those paths equal.
  // The fixture already owns cwd; leave global prefix discovery independent.
  const result = spawnSync(npmCommand, ['--global=false', ...args, '--offline', '--no-audit', '--no-fund'], {
    env,
    cwd, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
  })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
  return result
}

test('CUT chooses native npm and keeps the complete graph, scripts and platform shims enabled', () => {
  for (const platform of ['linux', 'win32']) {
    const invocation = nativeDependencyInstallCommand(platform, 'x64')
    assert.equal(invocation.command, platform === 'win32' ? 'npm.cmd' : 'npm')
    assert.equal(invocation.shell, platform === 'win32', 'only Windows .cmd needs a shell')
    assert.ok(invocation.args.includes('ci'))
    for (const type of ['prod', 'dev', 'optional', 'peer']) assert.ok(invocation.args.includes(`--include=${type}`))
    assert.ok(invocation.args.includes('--ignore-scripts=false'))
    assert.ok(invocation.args.includes('--bin-links=true'))
    assert.ok(invocation.args.includes(`--os=${platform}`))
    assert.ok(invocation.args.includes('--cpu=x64'))
  }
})

test('private dependency audit accepts native internal links and refuses external junctions and hardlinks', async (t) => {
  const root = await scratch(t)
  const tree = path.join(root, 'node_modules')
  const outside = path.join(root, 'live-dependency')
  await mkdir(path.join(tree, 'pkg'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(tree, 'pkg', 'binary'), 'private')
  await writeFile(path.join(outside, 'binary'), 'live')
  // esbuild creates these two hardlinks during a real npm postinstall. Both
  // names belong to this candidate, so neither can reach an active checkout.
  await link(path.join(tree, 'pkg', 'binary'), path.join(tree, 'private-binary'))
  assert.doesNotThrow(() => assertPrivateDependencyTree(tree))
  const internalLink = path.join(tree, 'pkg-link')
  await symlink(path.join(tree, 'pkg'), internalLink, 'junction')
  assert.doesNotThrow(() => assertPrivateDependencyTree(tree))
  await removeLink(internalLink)

  const externalLink = path.join(tree, 'nested-link')
  await symlink(outside, externalLink, 'junction')
  assert.throws(() => assertPrivateDependencyTree(tree), /link escapes its private node_modules/)
  await removeLink(externalLink)
  await link(path.join(outside, 'binary'), path.join(tree, 'shared-binary'))
  assert.throws(() => assertPrivateDependencyTree(tree), /hardlink outside its private node_modules/)
  assert.equal(await readFile(path.join(outside, 'binary'), 'utf8'), 'live')
})

test('native .bin shims remain private, including relative POSIX links', async (t) => {
  const root = await scratch(t)
  const tree = path.join(root, 'node_modules')
  await mkdir(path.join(tree, '.bin'), { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(path.join(tree, '.bin', 'vite.cmd'), '@echo fixture\r\n')
    assert.doesNotThrow(() => assertPrivateDependencyTree(tree))
    await mkdir(path.join(root, 'outside-shims'))
    await symlink(path.join(root, 'outside-shims'), path.join(tree, '.bin', 'linked-shims'), 'junction')
    assert.throws(() => assertPrivateDependencyTree(tree), /link escapes/)
    return
  }
  await mkdir(path.join(tree, 'vite', 'bin'), { recursive: true })
  await writeFile(path.join(tree, 'vite', 'bin', 'vite.js'), '#!/usr/bin/env node\n')
  const shim = path.join(tree, '.bin', 'vite')
  await symlink('../vite/bin/vite.js', shim)
  assert.doesNotThrow(() => assertPrivateDependencyTree(tree))
  assert.equal(await readlink(shim), '../vite/bin/vite.js')
  await unlink(shim)
  await writeFile(path.join(root, 'live-shim'), 'live')
  await symlink('../../live-shim', shim)
  assert.throws(() => assertPrivateDependencyTree(tree), /link escapes/)
})

test('native runtime validation requires the platform shims and executable, not an empty dist folder', async (t) => {
  const root = await scratch(t)
  const tree = path.join(root, 'node_modules')
  await mkdir(path.join(tree, '.bin'), { recursive: true })
  await mkdir(path.join(tree, 'electron', 'dist'), { recursive: true })
  for (const platform of ['win32', 'linux']) {
    const suffix = platform === 'win32' ? '.cmd' : ''
    for (const name of ['vite', 'electron-builder']) {
      const shim = path.join(tree, '.bin', `${name}${suffix}`)
      await writeFile(shim, 'native shim\n')
      await chmod(shim, 0o755)
    }
    await writeFile(path.join(tree, 'electron', 'path.txt'), platform === 'win32' ? 'electron.exe' : 'electron')
    assert.throws(() => assertNativeDependencyRuntime(tree, platform), /native Electron runtime/)
    const binary = path.join(tree, 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron')
    await writeFile(binary, 'runtime fixture\n')
    await chmod(binary, 0o755)
    assert.doesNotThrow(() => assertNativeDependencyRuntime(tree, platform))
    await unlink(path.join(tree, '.bin', `vite${suffix}`))
    assert.throws(() => assertNativeDependencyRuntime(tree, platform), /required native .bin shim/)
  }
})

test('legacy dangling junctions detach without touching a source directory', async (t) => {
  const root = await scratch(t)
  const cut = path.join(root, 'cut')
  await mkdir(cut)
  await symlink(path.join(root, 'missing-source'), path.join(cut, 'node_modules'), 'junction')
  assert.equal(releaseNodeModulesJunction(cut, quiet), true)
  await assert.rejects(lstat(path.join(cut, 'node_modules')), { code: 'ENOENT' })
  assert.equal(releaseNodeModulesJunction(cut, quiet), false)
})

test('provisioning refuses the source checkout, including a directory alias', async (t) => {
  const root = await scratch(t)
  const source = path.join(root, 'source')
  const alias = path.join(root, 'alias')
  await mkdir(path.join(source, 'node_modules'), { recursive: true })
  await writeFile(path.join(source, 'node_modules', 'sentinel'), 'live')
  await symlink(source, alias, 'junction')
  try {
    await assert.rejects(provisionNodeModules(source, source, quiet), /DEV\/LIVE source checkout/)
    await assert.rejects(provisionNodeModules(source, alias, quiet), /linked\/reparse-point/)
    assert.equal(await readFile(path.join(source, 'node_modules', 'sentinel'), 'utf8'), 'live')
  } finally {
    await removeLink(alias)
  }
})

test('private dependency paths reject chained escapes and account-external inputs before traversal', async t => {
  const root = await scratch(t), tree = path.join(root, 'node_modules')
  await mkdir(tree)
  const outside = process.platform === 'win32' ? path.join(path.parse(userInfo().homedir).root, 'unprobed-cut-dependencies') : path.join(root, 'unprobed-outside')
  await symlink(outside, path.join(tree, 'second'), 'junction')
  await symlink(path.join(tree, 'second'), path.join(tree, 'first'), 'junction')
  assert.throws(() => assertPrivateDependencyTree(tree), process.platform === 'win32' ? /current OS account/ : /link escapes/)
  if (process.platform === 'win32') {
    assert.throws(() => assertPrivateDependencyTree(outside), /current OS account/)
    await assert.rejects(provisionNodeModules(outside, root, quiet), /current OS account/)
    assert.throws(() => releaseNodeModulesJunction(outside, quiet), /current OS account/)
  }
})

test('the preinstall bypass is refused before a legacy source junction can be detached', async t => {
  const root = await scratch(t), source = path.join(root, 'source'), cut = path.join(root, 'cut')
  await mkdir(path.join(source, 'node_modules'), { recursive: true })
  await mkdir(cut)
  await writeFile(path.join(source, 'node_modules', 'sentinel'), 'untouched')
  await symlink(path.join(source, 'node_modules'), path.join(cut, 'node_modules'), 'junction')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { provisionNodeModules } from ${JSON.stringify(helperUrl)}; await provisionNodeModules(${JSON.stringify(source)}, ${JSON.stringify(cut)});`], {
    encoding: 'utf8', windowsHide: true, env: fixtureEnvironment(cut, { TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING: '1' }),
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /preinstall bypass/)
  assert.equal((await lstat(path.join(cut, 'node_modules'))).isSymbolicLink(), true)
  assert.equal(await readFile(path.join(source, 'node_modules', 'sentinel'), 'utf8'), 'untouched')
})

test('real preinstall refusal protects an existing private CUT tree before npm ci removes it', async t => {
  const root = await scratch(t), source = path.join(root, 'source'), cut = path.join(root, 'cut')
  await mkdir(source)
  await mkdir(path.join(cut, 'node_modules'), { recursive: true })
  await writeFile(path.join(cut, 'node_modules', 'protected-sentinel'), 'still here')
  const pkg = { name: 'preflight-fixture', version: '1.0.0', scripts: { preinstall: 'node guard.cjs' } }
  await writeFile(path.join(cut, 'package.json'), JSON.stringify(pkg))
  await writeFile(path.join(cut, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': pkg } }))
  await writeFile(path.join(cut, 'guard.cjs'), "const fs = require('node:fs'); fs.writeFileSync('guard-observed', fs.readFileSync('node_modules/protected-sentinel')); process.exit(17)\n")
  const execution = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { provisionNodeModules } from ${JSON.stringify(helperUrl)}; await provisionNodeModules(${JSON.stringify(source)}, ${JSON.stringify(cut)});`], {
    cwd: cut, encoding: 'utf8', windowsHide: true, env: fixtureEnvironment(cut),
  })
  assert.notEqual(execution.status, 0)
  assert.match(execution.stderr, /preinstall refused before dependency reification/)
  assert.equal(await readFile(path.join(cut, 'guard-observed'), 'utf8'), 'still here')
  assert.equal(await readFile(path.join(cut, 'node_modules', 'protected-sentinel'), 'utf8'), 'still here')
})

// Offline package fixtures exercise real npm extraction, native shim creation
// and lifecycle processes. They are not a packaged Electron/runtime proof; the
// release's existing native artifact gates still provide that proof.
test('real native npm stages an independent tree while preserving lifecycle scripts and optional/dev dependencies', async (t) => {
  const root = await scratch(t)
  const packages = path.join(root, 'packages')
  const source = path.join(root, 'source')
  const cut = path.join(root, 'cut')
  await mkdir(packages)
  await mkdir(source)
  await mkdir(cut)
  const names = ['electron', 'vite', 'electron-builder', 'fixture-runtime', 'fixture-optional']
  const electronInstall = `
const fs = require('node:fs');
const path = require('node:path');
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.platform;
const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
fs.mkdirSync(path.dirname(path.join(__dirname, 'dist', executable)), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', executable), 'runtime fixture\\n', { mode: 0o755 });
fs.writeFileSync(path.join(__dirname, 'path.txt'), executable);
fs.writeFileSync(path.join(__dirname, 'lifecycle.json'), JSON.stringify({ platform, override: process.env.ELECTRON_OVERRIDE_DIST_PATH || null }));
`
  for (const name of names) {
    const directory = path.join(packages, name)
    await mkdir(directory)
    const pkg = { name, version: '1.0.0', main: 'index.cjs' }
    if (name === 'electron') {
      pkg.scripts = { postinstall: 'node install.js' }
      await writeFile(path.join(directory, 'install.js'), electronInstall)
    }
    if (['vite', 'electron-builder'].includes(name)) pkg.bin = { [name]: 'cli.cjs' }
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(pkg))
    await writeFile(path.join(directory, 'LICENSE'), 'Owned offline fixture license\n')
    await writeFile(path.join(directory, 'index.cjs'), 'original dependency\n')
    await writeFile(path.join(directory, 'cli.cjs'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(name)})\n`)
    npm(['pack', '--ignore-scripts', '--pack-destination', '..'], directory)
  }
  const tarball = (name) => `file:../packages/${name}-1.0.0.tgz`
  const pkg = {
    name: 'cut-dependency-fixture', version: '1.0.0', private: true,
    dependencies: { 'fixture-runtime': tarball('fixture-runtime') },
    devDependencies: Object.fromEntries(['electron', 'vite', 'electron-builder'].map((name) => [name, tarball(name)])),
    optionalDependencies: { 'fixture-optional': tarball('fixture-optional') },
    scripts: {
      ...Object.fromEntries(['preinstall', 'install', 'postinstall'].map((phase) => [phase, `node lifecycle.cjs ${phase}`])),
      'probe:shim': 'vite',
    },
  }
  await writeFile(path.join(source, 'package.json'), JSON.stringify(pkg))
  const lifecycle = `
const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(process.argv[2] + '.txt', process.cwd());
if (process.argv[2] === 'postinstall' && process.env.CUT_FIXTURE_MUTATION) {
  const mode = process.env.CUT_FIXTURE_MUTATION;
  const modules = path.join(process.cwd(), 'node_modules');
  const runtime = path.join(modules, 'fixture-runtime');
  if (mode === 'internal-directory' || mode === 'outbound-directory') {
    const target = path.join(mode === 'internal-directory' ? modules : path.dirname(process.cwd()), 'moved-' + path.basename(process.cwd()));
    fs.renameSync(runtime, target);
    fs.symlinkSync(target, runtime, 'junction');
  } else {
    const license = path.join(runtime, 'LICENSE');
    const target = path.join(mode === 'internal-hardlink' ? modules : path.dirname(process.cwd()), 'notice-' + path.basename(process.cwd()));
    fs.linkSync(license, target);
  }
}
`
  await writeFile(path.join(source, 'lifecycle.cjs'), lifecycle)
  npm(['install', '--package-lock-only', '--ignore-scripts'], source)
  assert.deepEqual(JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')), pkg,
    'Fixture lock preparation changed the dependency manifest before CUT staging')
  npm(['ci'], source)
  for (const name of ['package.json', 'package-lock.json', 'lifecycle.cjs']) await cp(path.join(source, name), path.join(cut, name))
  const sourceModules = path.join(source, 'node_modules')
  const cutModules = path.join(cut, 'node_modules')
  const sourceFile = path.join(sourceModules, 'fixture-runtime', 'index.cjs')
  const cutFile = path.join(cutModules, 'fixture-runtime', 'index.cjs')
  await writeFile(path.join(sourceModules, 'live-sentinel'), 'active DEV/LIVE')
  // Exercise cleanup before npm even when the old source and cut locks match.
  await symlink(sourceModules, cutModules, 'junction')
  const program = `import { provisionNodeModules } from ${JSON.stringify(helperUrl)}; console.log(JSON.stringify(await provisionNodeModules(${JSON.stringify(source)}, ${JSON.stringify(cut)})));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: cut,
    encoding: 'utf8',
    windowsHide: true,
    env: fixtureEnvironment(cut, {
      NODE_ENV: 'production', npm_config_omit: 'dev', npm_config_optional: 'false',
      npm_config_ignore_scripts: 'true', npm_config_bin_links: 'false',
      npm_config_prefix: source, npm_config_global: 'true', npm_config_location: 'global', npm_config_dry_run: 'true',
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_platform: process.platform === 'win32' ? 'linux' : 'win32',
      ELECTRON_INSTALL_PLATFORM: process.platform === 'win32' ? 'linux' : 'win32',
      ELECTRON_OVERRIDE_DIST_PATH: sourceModules,
    }),
  })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}\nFixture package:\n${await readFile(path.join(cut, 'package.json'), 'utf8')}\nFixture lock:\n${await readFile(path.join(cut, 'package-lock.json'), 'utf8')}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), { method: 'npm-ci', source: null })
  assert.equal((await lstat(cutModules)).isSymbolicLink(), false)
  assertPrivateDependencyTree(cutModules)
  assertNativeDependencyRuntime(cutModules)
  const closure = measureLicenseDependencyInputs(cut)
  assert.deepEqual(Object.keys(closure.packages), ['node_modules/fixture-runtime'])
  assert.ok(closure.inputs['node_modules/fixture-runtime/LICENSE'])
  assert.deepEqual(closure, measureLicenseDependencyInputs(source))
  for (const name of names) assert.ok((await lstat(path.join(cutModules, name))).isDirectory(), `${name} was omitted`)
  for (const phase of ['preinstall', 'install', 'postinstall']) {
    assert.equal(await readFile(path.join(cut, `${phase}.txt`), 'utf8'), cut)
    assert.equal(await readFile(path.join(source, `${phase}.txt`), 'utf8'), source)
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(cutModules, 'electron', 'lifecycle.json'), 'utf8')), {
    platform: process.platform, override: null,
  })
  assert.equal(await readFile(path.join(sourceModules, 'live-sentinel'), 'utf8'), 'active DEV/LIVE')
  await assert.rejects(lstat(path.join(cutModules, 'live-sentinel')), { code: 'ENOENT' })
  if (process.platform !== 'win32') {
    assert.equal(await readlink(path.join(cutModules, '.bin', 'vite')), '../vite/cli.cjs')
  }
  const invokeShim = npm(['run', 'probe:shim'], cut)
  assert.equal(invokeShim.stdout.trim().split(/\r?\n/).at(-1), 'vite')
  await writeFile(cutFile, 'CUT changed this dependency')
  assert.equal(await readFile(sourceFile, 'utf8'), 'original dependency\n', 'CUT wrote through to source')
  await writeFile(sourceFile, 'DEV changed this dependency after CUT staging')
  assert.equal(await readFile(cutFile, 'utf8'), 'CUT changed this dependency', 'source wrote through to CUT')

  // Actual npm lifecycle mutations demonstrate the boundary between private
  // dependencies and stricter artifact metadata inputs. Neither check is waived.
  for (const mode of ['internal-directory', 'internal-hardlink', 'outbound-directory', 'outbound-hardlink']) {
    const malicious = path.join(root, 'cut-' + mode)
    await mkdir(malicious)
    for (const name of ['package.json', 'package-lock.json', 'lifecycle.cjs']) await cp(path.join(source, name), path.join(malicious, name))
    const execution = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { provisionNodeModules } from ${JSON.stringify(helperUrl)}; await provisionNodeModules(${JSON.stringify(source)}, ${JSON.stringify(malicious)});`], {
      cwd: malicious, encoding: 'utf8', windowsHide: true, env: fixtureEnvironment(malicious, { CUT_FIXTURE_MUTATION: mode }),
    })
    if (mode.startsWith('internal-')) {
      assert.equal(execution.status, 0, execution.stderr)
      assert.doesNotThrow(() => assertPrivateDependencyTree(path.join(malicious, 'node_modules')))
    } else {
      assert.notEqual(execution.status, 0)
      assert.match(execution.stderr, mode === 'outbound-directory' ? /link escapes/ : /hardlink outside/)
    }
    assert.throws(() => measureLicenseDependencyInputs(malicious), mode.endsWith('directory') ? /linked\/reparse-point input refused/ : /ordinary permitted-link file/)
  }

  // A lifecycle failure must still stop provisioning; no fallback may mask it.
  const failed = path.join(root, 'failed-cut')
  await mkdir(failed)
  for (const name of ['package.json', 'package-lock.json']) await cp(path.join(source, name), path.join(failed, name))
  await writeFile(path.join(failed, 'lifecycle.cjs'), 'process.exit(17)\n')
  const failure = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { provisionNodeModules } from ${JSON.stringify(helperUrl)}; await provisionNodeModules(${JSON.stringify(source)}, ${JSON.stringify(failed)});`], {
    cwd: failed, encoding: 'utf8', windowsHide: true,
    env: fixtureEnvironment(failed),
  })
  assert.notEqual(failure.status, 0)
  assert.match(failure.stderr, /npm ci failed/)
  assert.equal(await readFile(sourceFile, 'utf8'), 'DEV changed this dependency after CUT staging')
})
