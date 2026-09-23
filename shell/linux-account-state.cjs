'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path').posix

function refuse() {
  const error = new Error('The application could not prepare private account storage. Choose an owned, private user-data directory without symbolic links.')
  error.code = 'MC_ACCOUNT_STATE_UNSAFE'
  throw error
}

// The selected Electron profile and its capability/vault directories belong
// to this installation. Ancestors outside that profile are validation-only.
// Walk through pinned descriptors; never chmod a checked pathname that could
// have been replaced. Existing owner access is preserved, never widened.
function prepareLinuxAccountState(userData, { platform = process.platform } = {}) {
  if (platform !== 'linux') return { prepared: false }
  const uid = process.getuid(), gid = process.getgid()
  if (uid <= 0 || uid !== process.geteuid() || gid !== process.getegid()
      || typeof userData !== 'string' || !path.isAbsolute(userData)
      || userData !== path.normalize(userData) || userData.trim() !== userData
      || /[\x00-\x1f\x7f]/.test(userData) || Buffer.byteLength(userData) > 4096
      || ['/', os.homedir(), path.dirname(os.homedir())].includes(userData)) refuse()
  const handles = [], nodes = [], changed = [], created = []
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  let parent = null
  function open(directory, privateDirectory, create) {
    const access = parent ? `/proc/self/fd/${parent.fd}/${path.basename(directory)}` : '/'
    if (parent) verify(parent)
    let named
    try { named = fs.lstatSync(access) }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error
      try { fs.mkdirSync(access, { mode: 0o700 }); created.push(directory) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      named = fs.lstatSync(access)
    }
    if (!named.isDirectory() || named.isSymbolicLink()) refuse()
    const fd = fs.openSync(access, flags)
    handles.push(fd)
    const node = { fd, access, directory, identity: named, privateDirectory }
    nodes.push(node)
    const info = verify(node)
    if (privateDirectory) {
      const mode = info.mode & 0o7777
      if (info.uid !== uid || (mode & 0o700) !== 0o700 || (mode & 0o7000)) refuse()
      if (mode !== 0o700) { fs.fchmodSync(fd, mode & 0o700); changed.push(directory) }
      if ((verify(node).mode & 0o7777) !== 0o700) refuse()
      node.privateMode = 0o700
    }
    parent = node
  }
  function verify(node) {
    const info = fs.fstatSync(node.fd), named = fs.lstatSync(node.access)
    if (!info.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
        || !same(info, node.identity) || !same(info, named)
        || fs.readlinkSync(`/proc/self/fd/${node.fd}`) !== node.directory) refuse()
    if (node.privateDirectory) {
      if (info.uid !== uid) refuse()
      if (node.privateMode !== undefined && (info.mode & 0o7777) !== node.privateMode) refuse()
    } else {
      const stickyRoot = info.uid === 0 && Boolean(info.mode & 0o1000)
      if (![0, uid].includes(info.uid) || ((info.mode & 0o022) && !stickyRoot)) refuse()
    }
    return info
  }
  try {
    open('/', false, false)
    let directory = '/'
    for (const part of userData.slice(1).split('/')) {
      directory = path.join(directory, part)
      open(directory, directory === userData, directory === userData)
    }
    open(path.join(userData, 'capability'), true, true)
    open(path.join(userData, 'capability/vault'), true, true)
    // Revalidate the entire named chain while every descriptor is retained.
    for (const node of nodes) verify(node)
    return { prepared: true, changed, created }
  } catch { refuse() }
  finally { for (const fd of handles.reverse()) fs.closeSync(fd) }
}

module.exports = { prepareLinuxAccountState }
