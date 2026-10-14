'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const INSTALLED_EXECUTABLE = '/opt/ToolsEnabled/toolsenabled'
const POLICY = '/opt/ToolsEnabled/resources/apparmor-profile'
const INSTALLED_POLICY = '/etc/apparmor.d/toolsenabled-customer'
const RECORD = '/var/lib/toolsenabled-installer/admission.state'
const PROFILE_RECEIPT = '/var/lib/toolsenabled-installer/profile.sha256'
const POLICY_SHA256 = 'a492be28960b8e4257b42aee787a9ae915e20f50a3cb2eb6447b1aaaee1bdc7b'
const STATES = Object.freeze(['configuring', 'deferred-legacy-policy', 'no-policy-required', 'profile-prepared'])
// Node does not export O_PATH on every host. This is the Linux ABI value;
// production reaches it only for the installed Linux executable.
const LINUX_O_PATH = 0x200000

function admissionBytes(state) {
  if (!STATES.includes(state)) throw new Error('Unknown Linux admission state')
  const reason = state === 'deferred-legacy-policy' ? 'apparmor-3.0.8-without-abi-4.0' : 'none'
  return Buffer.from(`toolsenabled-linux-admission-v1\npolicy-sha256=${POLICY_SHA256}\nstate=${state}\nreason=${reason}\n`)
}

// These seams are arguments to a pure reader, never environment variables or
// installed caller-controlled paths. The production entry uses the defaults.
function checkLinuxInstalledAdmission({
  platform = process.platform,
  isPackaged = false,
  execPath = process.execPath,
  pid = process.pid,
  fsOps = fs,
} = {}) {
  // A developer/QA/copy cannot borrow the fixed installation's admission.
  // Those layouts keep their existing contracts and receive no installed claim.
  if (platform !== 'linux' || !isPackaged || execPath !== INSTALLED_EXECUTABLE) {
    return Object.freeze({ ok: true, applicable: false })
  }
  const deny = (code, message) => Object.freeze({ ok: false, applicable: true, code, message })
  const preparedMessage = 'ToolsEnabled is installed, but this kernel requires its AppArmor policy before launch. '
    + 'After providing ABI 4.0 and userns parser support, an administrator can run: dpkg-reconfigure toolsenabled'
  const unsafe = () => { throw new Error('Unsafe Linux installation admission input') }
  let descriptorDirectory
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) unsafe()
    descriptorDirectory = `/proc/${pid}/fd`
    if (Number(fsOps.statfsSync(descriptorDirectory).type) !== 0x9fa0
        || !fsOps.lstatSync(descriptorDirectory).isDirectory()) unsafe()
  } catch {
    return deny('LINUX_INSTALLED_KERNEL_UNKNOWN', 'ToolsEnabled cannot establish its own procfs descriptor view. '
      + 'Application launch is refused while kernel state is unavailable.')
  }
  const protectedInfo = (info, directory = false) => {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.uid !== 0 || info.gid !== 0
        || (info.mode & 0o6022) !== 0 || (!directory && info.nlink !== 1)) unsafe()
  }
  const parents = file => {
    const components = path.posix.dirname(file).split('/').filter(Boolean)
    let current = '/'
    protectedInfo(fsOps.lstatSync(current), true)
    for (const component of components) {
      current = path.posix.join(current, component)
      protectedInfo(fsOps.lstatSync(current), true)
    }
  }
  const readBounded = (file, limit, protect = false) => {
    if (protect) parents(file)
    // O_PATH does not open a FIFO/device for data. Validate this held object
    // before reopening its own procfs descriptor, never the mutable pathname.
    const metadataFd = fsOps.openSync(file, LINUX_O_PATH | fs.constants.O_NOFOLLOW)
    let fd = null
    try {
      const before = fsOps.fstatSync(metadataFd)
      if (!before.isFile() || before.size > limit) unsafe()
      if (protect) protectedInfo(before)
      if (file === RECORD && (before.mode & 0o7777) !== 0o644) unsafe()
      fd = fsOps.openSync(`${descriptorDirectory}/${metadataFd}`, fs.constants.O_RDONLY)
      const opened = fsOps.fstatSync(fd)
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
        if (before[key] !== opened[key]) unsafe()
      }
      if (!opened.isFile()) unsafe()
      if (protect) protectedInfo(opened)
      if (file === RECORD && (opened.mode & 0o7777) !== 0o644) unsafe()
      const bytes = Buffer.alloc(limit + 1)
      let used = 0
      while (used < bytes.length) {
        const count = fsOps.readSync(fd, bytes, used, bytes.length - used, used)
        if (count === 0) break
        used += count
      }
      if (used > limit) unsafe()
      const after = fsOps.fstatSync(fd)
      if (protect) protectedInfo(after)
      if (file === RECORD && (after.mode & 0o7777) !== 0o644) unsafe()
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
        if (before[key] !== after[key]) unsafe()
      }
      return bytes.subarray(0, used)
    } catch (error) {
      // Only ENOENT from the original O_PATH lookup means an absent optional
      // kernel control. A failed held-descriptor reopen is unknown, not absent.
      if (error?.code === 'ENOENT') unsafe()
      throw error
    } finally {
      try { if (fd !== null) fsOps.closeSync(fd) }
      finally { fsOps.closeSync(metadataFd) }
    }
  }
  let state
  try {
    parents(INSTALLED_EXECUTABLE)
    const executable = fsOps.lstatSync(INSTALLED_EXECUTABLE)
    protectedInfo(executable)
    if ((executable.mode & 0o111) === 0) unsafe()
    const policy = readBounded(POLICY, 16384, true)
    if (createHash('sha256').update(policy).digest('hex') !== POLICY_SHA256) unsafe()
    const bytes = readBounded(RECORD, 512, true)
    state = STATES.find(candidate => bytes.equals(admissionBytes(candidate)))
    if (!state) unsafe()
  } catch {
    return deny('LINUX_INSTALLED_ADMISSION_INVALID', 'ToolsEnabled installation admission is missing or invalid. '
      + 'An administrator must complete package configuration before this installed application can start.')
  }
  if (state === 'configuring') {
    return deny('LINUX_INSTALLED_ADMISSION_INCOMPLETE', 'ToolsEnabled package configuration did not finish. '
      + 'An administrator must complete package configuration before launch.')
  }

  let restricted
  try {
    // ENOENT means an absent optional kernel control only after establishing a
    // real procfs view. An unmounted /proc must never become an unrestricted yes.
    if (Number(fsOps.statfsSync('/proc/sys/kernel').type) !== 0x9fa0
        || !fsOps.lstatSync('/proc/sys/kernel').isDirectory()) unsafe()
    const control = file => {
      let bytes
      try { bytes = readBounded(file, 8) }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error }
      if (bytes.equals(Buffer.from('0\n')) || bytes.equals(Buffer.from('0'))) return false
      if (bytes.equals(Buffer.from('1\n')) || bytes.equals(Buffer.from('1'))) return true
      unsafe()
    }
    restricted = control('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === true
    if (control('/proc/sys/kernel/unprivileged_userns_clone') === false) {
      return deny('LINUX_INSTALLED_USERNS_DISABLED', 'This kernel disables unprivileged user namespaces. '
        + 'ToolsEnabled cannot start its sandbox in this configuration.')
    }
  } catch {
    return deny('LINUX_INSTALLED_KERNEL_UNKNOWN', 'ToolsEnabled could not establish this kernel\'s sandbox prerequisites. '
      + 'Application launch is refused while that state is unknown.')
  }
  if (!restricted) return Object.freeze({ ok: true, applicable: true, state, policyRequired: false })
  if (state !== 'profile-prepared') return deny('LINUX_INSTALLED_POLICY_PENDING', preparedMessage)

  try {
    const policy = readBounded(INSTALLED_POLICY, 16384, true)
    if (createHash('sha256').update(policy).digest('hex') !== POLICY_SHA256
        || !readBounded(PROFILE_RECEIPT, 128, true).equals(Buffer.from(`${POLICY_SHA256}\n`))) unsafe()
    const label = readBounded(`/proc/${pid}/attr/current`, 256)
    if (!label.equals(Buffer.from('toolsenabled-customer (unconfined)\n'))
        && !label.equals(Buffer.from('toolsenabled-customer (unconfined)'))) unsafe()
  } catch {
    return deny('LINUX_INSTALLED_POLICY_UNATTACHED', preparedMessage)
  }
  // Attachment is not a hash of kernel policy. Chromium's real sandbox checks
  // still run; this check never supplies a sandbox-disable flag or fallback.
  return Object.freeze({ ok: true, applicable: true, state, policyRequired: true })
}

module.exports = Object.freeze({ checkLinuxInstalledAdmission, admissionBytes, POLICY_SHA256 })
