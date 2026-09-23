/* electron-builder afterPack hook: qualify staged runtime permissions, harden
 * executable fuses and strip runtime log litter before packaging.
 *
 * Litter classification remains in strip-build-diagnostics.mjs. Linux mode
 * normalization is deliberately artifact-only and runs before any fuse write;
 * the caller's umask and reused staging directory must not make shipped code
 * writable by another local principal.
 *
 * Why a hook at all, rather than another step in the dist chain: every step in
 * that chain runs after electron-builder has already exited, and by then the
 * .exe exists. debug.log inside the installer is the exact defect this prevents,
 * so the removal has to happen inside the build.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/* These are executable-time boundaries, not JavaScript preferences. A direct
 * NODE_OPTIONS probe against the ordinary Electron binary executes --require
 * code before shell/main.cjs reaches its account, elevation, userData, or
 * environment refusals. Flipping the fuse in the staged executable is the only
 * application-owned point early enough to prevent that pre-main side effect.
 *
 * RunAsNode stays enabled deliberately: the shipped capability layer reuses
 * this executable as its Node runtime. OnlyLoadAppFromAsar prevents a copied or
 * damaged packaged executable from silently falling back to an adjacent app/
 * source tree. The inspector fuse blocks the normal Electron-main CLI path.
 * Electron 43's RunAsNode path still accepts Node inspector switches, so
 * shell/electron-node-handoff.cjs also requires the shipped script to be the
 * first child argument. The capability child already uses that exact grammar. */
const PACKAGED_FUSE_POLICY = Object.freeze({
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
})

function packedExecutablePath(context) {
  const productFilename = context?.packager?.appInfo?.productFilename
  if (typeof productFilename !== 'string' || productFilename.trim() === '') {
    throw new Error('[after-pack-strip-litter] electron-builder supplied no product filename for fuse hardening')
  }
  if (context.electronPlatformName === 'linux') {
    // LinuxPackager computes this from executableName or the sanitized app
    // name. productFilename is the display name, not the on-disk ELF name.
    const executableName = context.packager.executableName
    if (typeof executableName !== 'string' || !executableName.trim()
        || executableName === '.' || executableName === '..'
        || /[\\/\0]/.test(executableName)) {
      throw new Error('[after-pack-strip-litter] no safe Linux executable name supplied by electron-builder')
    }
    return path.join(context.appOutDir, executableName)
  }
  if (context.electronPlatformName !== 'win32') {
    throw new Error(`[after-pack-strip-litter] unsupported packaging platform: ${context.electronPlatformName}`)
  }
  return path.join(context.appOutDir, `${productFilename}.exe`)
}

async function hardenPackedElectron(context) {
  const executable = packedExecutablePath(context)
  await flipFuses(executable, PACKAGED_FUSE_POLICY)
  console.log(`[after-pack-strip-litter] hardened Electron fuses in ${executable}`)
  return executable
}

function normalizeLinuxArtifactPermissions(context) {
  if (context.electronPlatformName !== 'linux') return { skipped: true, changed: 0 }
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('[after-pack] Linux artifact permissions require the ordinary Linux builder account')
  }
  const refuse = () => { throw new Error('[after-pack] Linux artifact ownership, layout or permissions could not be verified') }
  const root = context.appOutDir
  const project = context.packager?.projectDir
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root
      || typeof project !== 'string' || !path.isAbsolute(project)
      || !root.startsWith(path.resolve(project) + path.sep) || fs.realpathSync(root) !== root) refuse()
  const executable = packedExecutablePath(context)
  for (const file of [executable, path.join(root, 'resources', 'app.asar'), path.join(root, 'resources', 'capability', 'PAYLOAD.json')]) {
    let cursor = root
    const parts = path.relative(root, file).split(path.sep)
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part)
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink() || stat.uid !== process.getuid()
          || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) refuse()
    }
  }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
  const rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  let changed = 0
  try {
    const rootIdentity = fs.fstatSync(rootFd, { bigint: true })
    const checkRoot = () => {
      if (fs.readlinkSync(`/proc/self/fd/${rootFd}`) !== root
          || !same(rootIdentity, fs.lstatSync(root, { bigint: true }))) refuse()
    }
    const visit = (fd, named, mutate) => {
      checkRoot()
      const before = fs.fstatSync(fd, { bigint: true })
      const mode = Number(before.mode & 0o7777n)
      // No symlinks, multiply-linked files, special files, foreign owners or
      // unexpected setuid/setgid. Never chmod a shared dependency through a
      // hardlink, and never add privilege to chrome-sandbox as a packaging fix.
      if ((!before.isDirectory() && !before.isFile()) || before.uid !== BigInt(process.getuid())
          || (before.isFile() && before.nlink !== 1n) || (mode & 0o6000)
          || !same(before, fs.lstatSync(named, { bigint: true }))) refuse()
      if (before.isDirectory()) {
        for (const entry of fs.readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) {
          if (!entry.isFile() && !entry.isDirectory()) refuse()
          const childName = `/proc/self/fd/${fd}/${entry.name}`
          const childFd = fs.openSync(childName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
            | (entry.isDirectory() ? fs.constants.O_DIRECTORY : fs.constants.O_NONBLOCK))
          try { visit(childFd, childName, mutate) } finally { fs.closeSync(childFd) }
        }
      }
      if (mutate && (mode & 0o022)) {
        // Remove only group/other write. Existing executable/read bits remain
        // unchanged; caller umask and a reused output directory cannot weaken
        // the staged application for another local principal.
        fs.fchmodSync(fd, mode & ~0o022)
        changed += 1
      }
      const after = fs.fstatSync(fd, { bigint: true })
      if (!same(before, after) || !same(after, fs.lstatSync(named, { bigint: true }))
          || (mutate && Number(after.mode & 0o7777n) !== (mode & ~0o022))) refuse()
      checkRoot()
    }
    visit(rootFd, root, false) // Validate the complete staged layout before any chmod.
    visit(rootFd, root, true)
    return { skipped: false, changed }
  } finally { fs.closeSync(rootFd) }
}

/* THE PACKED COPY IS VERIFIED IF IT IS THERE, AND ITS ABSENCE IS NOT A CRASH.
 *
 * This ran verifyVoiceBundle unconditionally on win32 and blew up with a raw
 * ENOENT -- `lstat '...\release\win-unpacked\resources\voice-runtime\bundle'` --
 * the moment an installer was built without local speech. That is the same stale
 * assumption the before-pack hook carried (owner decision OD7 / B23c: speech ships
 * as a separate opt-in pack and 1.0.42 may ship without it), and here it surfaced
 * as a stack trace from fs rather than as a sentence anyone could act on.
 *
 * Verifying the PACKED copy is the more important of the two checks and it is kept
 * exactly as it was: this is the last point at which the bytes that reach a
 * customer are inspected, and verifyVoiceBundle asserts every pinned notice and
 * the GPL corresponding source by bytes and sha256. What changes is only that
 * "there is no bundle" is now a stated outcome instead of an unhandled error.
 *
 * Exported so it can be tested on its own: afterPack also flips Electron fuses on
 * a real executable, which a unit test cannot supply. */
async function verifyPackedVoiceBundle(appOutDir, { log = console.log } = {}) {
  const source = path.join(appOutDir, 'resources', 'voice-runtime')
  const bundle = path.join(source, 'bundle')
  if (!fs.existsSync(bundle)) {
    log('[after-pack-strip-litter] no packed local speech bundle: the installer ships without it and the pack is the separate opt-in download (OD7 / B23c).')
    return null
  }
  const { verifyVoiceBundle } = await import('./prepare-voice-runtime.mjs')
  const manifest = await verifyVoiceBundle(bundle, source)
  log(`[after-pack-strip-litter] verified the packed local speech bundle: ${manifest.files.length} files, pinned notices and source present.`)
  return manifest
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    await verifyPackedVoiceBundle(context.appOutDir)
  }
  const permissions = normalizeLinuxArtifactPermissions(context)
  if (!permissions.skipped) console.log(`[after-pack] removed group/other write from ${permissions.changed} Linux artifact entries`)
  const icons = await require('./lib/linux-desktop-icons.cjs').prepareLinuxDesktopIcons(context)
  if (icons.copied) console.log(`[after-pack] staged ${icons.copied} private mode0644 desktop icons before FPM`)
  const policies = await require('./lib/linux-desktop-icons.cjs').prepareLinuxAppArmorProfile(context)
  if (policies.copied) console.log(`[after-pack] staged ${policies.copied} private mode0644 AppArmor profile before FPM`)
  await hardenPackedElectron(context)
  const { stripPackedLitter } = await import('./strip-build-diagnostics.mjs')
  const { directory, removed } = await stripPackedLitter(context.appOutDir)
  console.log(
    removed.length > 0
      ? `[after-pack-strip-litter] ${directory} -> removed ${removed.join(', ')}`
      : `[after-pack-strip-litter] ${directory} -> no runtime log litter present`,
  )
}

module.exports.PACKAGED_FUSE_POLICY = PACKAGED_FUSE_POLICY
module.exports.hardenPackedElectron = hardenPackedElectron
module.exports.packedExecutablePath = packedExecutablePath
module.exports.normalizeLinuxArtifactPermissions = normalizeLinuxArtifactPermissions
module.exports.verifyPackedVoiceBundle = verifyPackedVoiceBundle
