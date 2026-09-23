/* Every CUT owns its installed dependencies. A matching source lockfile does
 * not make a writable junction safe: npm, Vite and Electron lifecycle scripts
 * can change that tree while DEV, LIVE or another cut is using it. Install from
 * the candidate's committed lock instead, with native binaries and the complete
 * dependency graph. The old junction cleanup API remains for earlier cuts.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { ordinaryDependencyPath, ownedDependencyPath, resolvePrivateDependencyPath } from './cut-dependency-paths.mjs'
import { nativeElectronInstallEnvironment } from '../../lib/native-driver-dependencies.cjs'
export { prepareNativeTestDependencies } from '../../lib/native-driver-dependencies.cjs'

export function nativeDependencyInstallCommand(platform = process.platform, arch = process.arch) {
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    // Explicit includes and scripts prevent a DEV shell's production/omit or
    // ignore-scripts setting from yielding an incomplete release toolchain.
    // A literal relative prefix binds npm to cwd even when inherited npm
    // configuration points at the source checkout. No paths enter a shell.
    args: [
      '--prefix', '.', '--global=false', 'ci', '--dry-run=false',
      '--include=prod', '--include=dev', '--include=optional', '--include=peer',
      '--ignore-scripts=false', '--bin-links=true', '--install-links=true',
      `--os=${platform}`, `--cpu=${arch}`,
    ],
    shell: platform === 'win32',
  }
}

/** Inspect the entire tree, including nested packages; .bin alone cannot prove
 * isolation. Relative POSIX shims are fine when both their lexical and real
 * targets stay inside this node_modules. Windows junctions may be absolute,
 * but they must also resolve inside it. Never recurse through a link.
 *
 * esbuild's real postinstall hardlinks its binary to another path in the same
 * install. Account for every name of such an inode inside CUT; an unaccounted
 * link means another tree can still mutate it and must stop the cut.
 */
export function assertPrivateDependencyTree(nodeModulesPath) {
  const root = ordinaryDependencyPath(nodeModulesPath)
  const hardlinks = new Map()
  let entries = 0
  function visit(directory) {
    ordinaryDependencyPath(directory)
    for (const name of readdirSync(directory)) {
      if (++entries > 100000) throw new Error('CUT dependency tree exceeds its bounded entry budget')
      const entry = ownedDependencyPath(path.join(directory, name))
      const stat = lstatSync(entry, { bigint: true })
      if (stat.isSymbolicLink()) {
        resolvePrivateDependencyPath(root, entry)
      } else if (stat.isDirectory()) {
        visit(entry)
      } else if (stat.isFile()) {
        if (stat.nlink > 1n) {
          const key = `${stat.dev}:${stat.ino}`
          const record = hardlinks.get(key) || { count: 0n, expected: stat.nlink, entry }
          if (record.expected !== stat.nlink) throw new Error('CUT dependency hardlink identity changed during inspection')
          record.count += 1n
          hardlinks.set(key, record)
        }
      } else {
        throw new Error(`Unsupported entry in CUT dependencies: ${entry}`)
      }
    }
  }
  visit(root)
  for (const record of hardlinks.values()) {
    if (record.count !== record.expected || lstatSync(record.entry, { bigint: true }).nlink !== record.expected) {
      throw new Error(`CUT dependency has a hardlink outside its private node_modules: ${record.entry}`)
    }
  }
}

function nativeElectronPath(platform) {
  if (platform === 'win32') return 'electron.exe'
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  return 'electron'
}

function hasNativeElectron(nodeModulesPath, platform) {
  const expected = nativeElectronPath(platform)
  try {
    const marker = resolvePrivateDependencyPath(nodeModulesPath, path.join(nodeModulesPath, 'electron', 'path.txt'))
    const executable = resolvePrivateDependencyPath(nodeModulesPath, path.join(nodeModulesPath, 'electron', 'dist', expected))
    return statSync(marker).isFile() && readFileSync(marker, 'utf8').trim() === expected && statSync(executable).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function assertNativeDependencyRuntime(nodeModulesPath, platform = process.platform) {
  nodeModulesPath = ordinaryDependencyPath(nodeModulesPath)
  const shims = ['vite', 'electron-builder'].map((name) => platform === 'win32' ? `${name}.cmd` : name)
  for (const shim of shims) {
    const requested = path.join(nodeModulesPath, '.bin', shim)
    let entry
    try { entry = resolvePrivateDependencyPath(nodeModulesPath, requested) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!entry || !statSync(entry).isFile()) {
      throw new Error(`CUT dependencies are missing required native .bin shim: ${requested}`)
    }
    if (platform !== 'win32') accessSync(entry, constants.X_OK)
  }
  if (!hasNativeElectron(nodeModulesPath, platform)) {
    throw new Error(`CUT dependencies are missing the native Electron runtime for ${platform}: ${nodeModulesPath}`)
  }
  if (platform !== 'win32') {
    accessSync(resolvePrivateDependencyPath(nodeModulesPath, path.join(nodeModulesPath, 'electron', 'dist', nativeElectronPath(platform))), constants.X_OK)
  }
}

export async function provisionNodeModules(sourceRepoRoot, worktreePath, { log = console.log } = {}) {
  // No bypass may disable the actual checkout preinstall hook. Check before
  // even detaching a legacy target, and retain npm's complete native controls.
  if (Object.entries(process.env).some(([key, value]) => /^TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING$/i.test(key) && value === '1')) {
    throw new Error('CUT refuses TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING preinstall bypass')
  }
  sourceRepoRoot = ordinaryDependencyPath(sourceRepoRoot)
  worktreePath = ordinaryDependencyPath(worktreePath)
  if (path.relative(sourceRepoRoot, worktreePath) === '') {
    throw new Error('Refusing to install CUT dependencies in the DEV/LIVE source checkout.')
  }
  // Require a real candidate package root before npm can discover any ancestor
  // project. The committed package/lock parity and npm ci gates remain intact.
  for (const name of ['package.json', 'package-lock.json']) {
    ordinaryDependencyPath(path.join(worktreePath, name), { directory: false })
  }
  const targetNodeModules = path.join(worktreePath, 'node_modules')
  releaseNodeModulesJunction(worktreePath, { log })
  // Refuse pre-existing nested external links before npm can recursively clean
  // them. The top-level legacy junction above is detached without traversing it.
  if (existsSync(targetNodeModules)) assertPrivateDependencyTree(targetNodeModules)

  const { command, args, shell } = nativeDependencyInstallCommand()
  const env = { ...process.env }
  // A packaging shell may carry cross-build overrides; a native CUT must not
  // inherit an Electron dist path pointing into another active installation.
  // npm.cmd also resolves its own npm prefix before forwarding CLI flags, so
  // command-line --prefix/--global alone cannot isolate its bootstrap process.
  for (const key of Object.keys(env)) {
    if (/^(electron_(override_dist_path|install_platform|install_arch|skip_binary_download)|npm_config_(arch|platform|cpu|os|prefix|local_prefix|global|location))$/i.test(key)) delete env[key]
  }
  env.ELECTRON_INSTALL_PLATFORM = process.platform
  env.ELECTRON_INSTALL_ARCH = process.arch
  if (existsSync(targetNodeModules)) {
    // npm ci removes/reifies dependencies before its root preinstall phase.
    // Honor the actual hook while an existing private Electron tree still
    // exists; do not let npm erase the evidence that the guard needs to inspect.
    const preflight = spawnSync(command, ['--prefix', '.', '--global=false', 'run', 'preinstall', '--ignore-scripts=false'], {
      cwd: worktreePath, env, stdio: 'inherit', shell, windowsHide: true,
    })
    if (preflight.error || preflight.status !== 0) throw new Error(`CUT preinstall refused before dependency reification (exit ${preflight.status})`)
    assertPrivateDependencyTree(targetNodeModules)
  }
  log(`[node-modules] installing private ${process.platform}/${process.arch} dependencies in ${worktreePath} from the candidate lockfile.`)
  const install = spawnSync(command, args, { cwd: worktreePath, env, stdio: 'inherit', shell, windowsHide: true })
  if (install.error || install.status !== 0) {
    throw new Error(`npm ci failed in ${worktreePath} (${install.error?.message || `exit ${install.status}, signal ${install.signal || 'none'}`})`)
  }
  assertPrivateDependencyTree(targetNodeModules)

  // Keep the existing direct postinstall recovery, checking the actual native
  // executable rather than accepting an empty or foreign-platform dist folder.
  if (!hasNativeElectron(targetNodeModules, process.platform)) {
    log('[node-modules] native Electron runtime missing after npm ci; running electron/install.js directly.')
    // The existing recovery is still preparation, before archive verification.
    // Its downloader must not use a DEV/LIVE cache or the account's temp root.
    const assets = path.join(targetNodeModules, '.native-test-assets')
    const cache = path.join(assets, 'cache'), temporary = path.join(assets, 'temporary')
    for (const directory of [assets, cache, temporary]) {
      ordinaryDependencyPath(directory, { missing: true })
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
    const installer = resolvePrivateDependencyPath(targetNodeModules, path.join(targetNodeModules, 'electron', 'install.js'))
    const electronInstall = spawnSync(process.execPath, [installer], {
      cwd: worktreePath,
      env: nativeElectronInstallEnvironment(env, { platform: process.platform, arch: process.arch, cache, temporary }),
      stdio: 'inherit',
      windowsHide: true,
    })
    if (electronInstall.error || electronInstall.status !== 0 || !hasNativeElectron(targetNodeModules, process.platform)) {
      throw new Error('Native Electron runtime still missing after npm ci and a direct electron/install.js run.')
    }
    assertPrivateDependencyTree(targetNodeModules)
  }
  assertNativeDependencyRuntime(targetNodeModules)
  log(`[node-modules] private dependencies ready: ${targetNodeModules}`)
  return { method: 'npm-ci', source: null }
}

/** Detach a junction left by an earlier CUT BEFORE `git worktree remove` runs.
 *
 * Hit for real on this script's first end-to-end test run: `git worktree
 * remove --force` failed with "Invalid argument" against a worktree whose
 * node_modules was a junction, and left the directory on disk -- still
 * containing the live junction -- even though git had already dropped it
 * from `git worktree list`. That is a real hazard beyond a failed cleanup:
 * anyone who later "just" runs a recursive delete on the orphaned directory
 * risks a Windows recursive-delete implementation that follows the junction
 * into its target and deletes the SHARED node_modules other lanes still use.
 *
 * The fix is to release the junction ourselves, deliberately and narrowly,
 * before asking git to remove anything. `rmdirSync` WITHOUT the `recursive`
 * option removes exactly the reparse-point directory entry and nothing
 * inside the target -- this is the standard, safe way to detach a Windows
 * junction from Node.js. Never call fs.rm/rmSync with `recursive: true` on
 * a path that might be a junction; some Windows/Node combinations have
 * followed the link into the target and deleted real content there. */
export function releaseNodeModulesJunction(
  worktreePath,
  { log = console.log, readlink = readlinkSync } = {},
) {
  if (!ordinaryDependencyPath(worktreePath, { missing: true })) return false
  const target = path.join(worktreePath, 'node_modules')
  /* Only a reparse point may be rmdir'd here. When the reuse fell back to a
     real `npm ci`, node_modules is an ordinary populated directory and
     rmdirSync would throw ENOTEMPTY -- crashing a cut AFTER a fully verified
     build, the exact failure class the 1.0.3 postmortem in this repo warns
     about. readlink succeeds only for symlinks and junctions, so a real
     directory falls through to git's own removal untouched. */
  try {
    readlink(target)
  } catch (error) {
    // ENOENT means the entry is absent; EINVAL is the
    // documented answer for an entry that is not a symbolic link. Both make
    // "there is no junction to release" a definite answer. Anything else
    // (including a code-less throw) means the machine could not inspect the
    // entry, not that the junction is absent. Never turn that uncertainty into
    // false: the caller must not continue into worktree removal in that case.
    if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return false
    const couldNotInspect = new Error(
      `Could not inspect ${target} to determine whether it is a node_modules junction; this is NOT claiming the junction is absent.`,
      { cause: error },
    )
    couldNotInspect.code = 'ERR_NODE_MODULES_JUNCTION_INSPECTION'
    throw couldNotInspect
  }
  // Windows junctions are directory reparse points and require rmdir; POSIX
  // directory symlinks require unlink. Both operations remove only the link.
  if (process.platform === 'win32') rmdirSync(target)
  else unlinkSync(target)
  log(`[node-modules] released junction before worktree removal: ${target} (target directory untouched)`)
  return true
}
