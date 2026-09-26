'use strict'
const fs = require('node:fs')
const path = require('node:path')

function stagingParent(context, fail) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !Array.isArray(context.targets)) fail()
  const project = context.packager?.projectDir, output = context.appOutDir
  if (typeof project !== 'string' || typeof output !== 'string' || !path.isAbsolute(project)
      || fs.realpathSync(project) !== project || path.resolve(output) !== output || !output.startsWith(project + path.sep)) fail()
  const parent = path.dirname(output)
  const parentIdentity = fs.lstatSync(parent, { bigint: true })
  const assertParent = () => {
    const current = fs.lstatSync(parent, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(process.getuid())
        || current.dev !== parentIdentity.dev || current.ino !== parentIdentity.ino || fs.realpathSync(parent) !== parent) fail()
  }
  let cursor = project
  for (const part of path.relative(project, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const s = fs.lstatSync(cursor)
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid()) fail()
  }
  return { project, parent, assertParent }
}

// FPM copies desktop icons separately AFTER afterPack and preserves their
// source modes. Never chmod shared dependencies: give its actual retained
// icon descriptors private build-local copies instead.
async function prepareLinuxDesktopIcons(context) {
  if (context.electronPlatformName !== 'linux') return { copied: 0 }
  const fail = () => { throw new Error('Linux desktop icon inputs could not be safely staged before FPM') }
  const { parent, assertParent } = stagingParent(context, fail)
  const helpers = new Set(context.targets.filter(t => t.name === 'deb').map(t => t.helper))
  const replacements = []
  let directory
  for (const helper of helpers) {
    if (!helper) fail()
    const icons = await helper.icons
    assertParent()
    if (!Array.isArray(icons) || !icons.length || icons.length > 64 || Object.keys(icons).length !== icons.length) fail()
    for (const icon of icons) {
      if (!icon || typeof icon.file !== 'string' || !path.isAbsolute(icon.file) || !['.png', '.svg'].includes(path.extname(icon.file))) fail()
      const source = fs.openSync(icon.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let bytes
      try {
        const info = fs.fstatSync(source)
        if (!info.isFile() || info.uid !== process.getuid() || info.size <= 0 || info.size > 8 * 1024 * 1024) fail()
        bytes = fs.readFileSync(source)
      } finally { fs.closeSync(source) }
      directory ||= fs.mkdtempSync(path.join(parent, '.linux-desktop-icons-'))
      const destination = path.join(directory, `${replacements.length}${path.extname(icon.file)}`)
      const fd = fs.openSync(destination, 'wx', 0o600)
      try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      replacements.push({ helper, icon, source: icon.file, destination })
    }
  }
  // Publish only the complete set; no partially replaced helper on refusal.
  assertParent()
  for (const r of replacements) {
    if (r.helper.maxIconPath === r.source) r.helper.maxIconPath = r.destination
    r.icon.file = r.destination
  }
  return { copied: replacements.length }
}

// FPM also adds its rendered AppArmor profile after the payload hook. With a
// group-writable builder umask that input was 0664, and a real fresh Debian
// install refused it as writable code. Stage the exact policy in a private
// directory and update FPM's retained descriptor, just as for the icons.
async function prepareLinuxAppArmorProfile(context) {
  if (context.electronPlatformName !== 'linux') return { copied: 0 }
  const fail = () => { throw new Error('Linux AppArmor input could not be safely staged before FPM') }
  const { project, parent, assertParent } = stagingParent(context, fail)
  const targets = context.targets.filter(target => target.name === 'deb')
  if (!targets.length) return { copied: 0 }
  const expected = fs.readFileSync(path.join(project, 'build/linux/toolsenabled-customer.apparmor'))
  const replacements = []
  let directory
  for (const target of targets) {
    const scripts = await target.scriptFiles
    assertParent()
    const descriptor = scripts && Object.getOwnPropertyDescriptor(scripts, 'appArmor')
    if (!descriptor || descriptor.writable !== true || typeof descriptor.value !== 'string'
        || !path.isAbsolute(descriptor.value) || fs.realpathSync(descriptor.value) !== descriptor.value) fail()
    const source = fs.openSync(descriptor.value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let bytes
    try {
      const info = fs.fstatSync(source)
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1
          || info.size <= 0 || info.size > 64 * 1024) fail()
      bytes = fs.readFileSync(source)
      if (!bytes.equals(expected)) fail()
    } finally { fs.closeSync(source) }
    directory ||= fs.mkdtempSync(path.join(parent, '.linux-deb-support-'))
    const destination = path.join(directory, `apparmor-profile-${replacements.length}`)
    const fd = fs.openSync(destination, 'wx', 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    replacements.push({ scripts, destination })
  }
  assertParent()
  for (const replacement of replacements) replacement.scripts.appArmor = replacement.destination
  return { copied: replacements.length }
}
module.exports = { prepareLinuxDesktopIcons, prepareLinuxAppArmorProfile }
