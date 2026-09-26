'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { profileRootFromRuntimePath } = require('../../shell/install-profile-guard.cjs')

function refuse(code, message) {
  throw Object.assign(new Error(message), { code })
}

function conventional(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value)
      || /[\0<>"|?*]/.test(value) || value.slice(2).includes(':')) {
    refuse('QA_PATH_NAMESPACE', 'Native audit paths require an ordinary absolute Windows drive path')
  }
  const components = value.slice(3).split(/[\\/]/).filter(Boolean)
  if (components.some(part => /[. ]$/.test(part) || /~\d/i.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    refuse('QA_PATH_AMBIGUOUS', 'Native audit paths cannot use aliases, dot segments, or device names')
  }
  return path.win32.normalize(value)
}

function inside(value, root) {
  const relative = path.win32.relative(root, value)
  return !relative || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
}

function inspect(stat, expectedType) {
  if (stat.isSymbolicLink()) refuse('QA_PATH_LINK', 'Native audit inputs cannot follow a symbolic link or junction')
  if (stat.isFile() && stat.nlink > 1) refuse('QA_PATH_HARDLINK', 'Native audit inputs cannot use a hard-linked file')
  if (expectedType === 'directory' ? !stat.isDirectory() : expectedType === 'file' ? !stat.isFile() : !stat.isDirectory() && !stat.isFile()) {
    refuse('QA_PATH_TYPE', 'Native audit path does not have the required regular file or directory type')
  }
}

// Call this BEFORE realpath, exists/stat/read, mkdir, createRequire or a child
// tool receives a path. Foreign profiles are lexical refusal inputs, never
// targets for lstat/readlink. Each accepted ancestor is checked before its
// child, so a junction cannot redirect a later probe. Returned spelling is
// already absolute; resolving it is unnecessary. This guard does not claim
// resistance to a concurrently hostile process swapping an ancestor.
function guardWindowsPath(value, {
  accountHome, platform = process.platform, allowMissing = false,
  expectedType, requireProfile = false, fsImpl = fs,
} = {}) {
  if (platform !== 'win32') return path.resolve(value)
  const selected = conventional(value)
  const profile = conventional(accountHome)
  const owner = profileRootFromRuntimePath(selected, profile)
  if (owner && owner.toLowerCase() !== profile.toLowerCase()) {
    refuse('QA_PATH_FOREIGN_PROFILE', 'Native audit cannot access another Windows profile')
  }
  if (requireProfile && !inside(selected, profile)) refuse('QA_PATH_OUTSIDE_PROFILE', 'Native audit output must stay inside the owning profile')
  const root = path.win32.parse(selected).root
  const parts = selected.slice(root.length).split('\\').filter(Boolean)
  let current = root
  const candidates = [root, ...parts.map(part => (current = path.win32.join(current, part)))]
  for (const [index, candidate] of candidates.entries()) {
    let stat
    try { stat = fsImpl.lstatSync(candidate) }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return selected
      throw error
    }
    inspect(stat, index < candidates.length - 1 ? 'directory' : expectedType)
  }
  return selected
}

// A dependency directory may contain its own junction even when the CLI path
// is ordinary. Validate its tree BEFORE resolving/loading modules from it.
function guardWindowsTree(value, options = {}) {
  const root = guardWindowsPath(value, { ...options, allowMissing: false, expectedType: 'directory' })
  if ((options.platform || process.platform) !== 'win32') return root
  const fsImpl = options.fsImpl || fs
  const maximumEntries = options.maximumEntries || 250000
  let inspected = 0
  function visit(directory) {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      if (++inspected > maximumEntries) refuse('QA_PATH_TREE_LIMIT', 'Native audit dependency inventory exceeded its bounded limit')
      const target = path.win32.join(directory, entry.name)
      const stat = fsImpl.lstatSync(target)
      inspect(stat)
      if (stat.isDirectory()) visit(target)
    }
  }
  visit(root)
  return root
}

module.exports = { guardWindowsPath, guardWindowsTree }
