import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { checkLinuxInstalledAdmission: check, admissionBytes, POLICY_SHA256 } = require('../../shell/linux-installed-admission.cjs')
const executable = '/opt/ToolsEnabled/toolsenabled'
const record = '/var/lib/toolsenabled-installer/admission.state'
const sourcePolicy = '/opt/ToolsEnabled/resources/apparmor-profile'
const installedPolicy = '/etc/apparmor.d/toolsenabled-customer'
const hashReceipt = '/var/lib/toolsenabled-installer/profile.sha256'
const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const clone = '/proc/sys/kernel/unprivileged_userns_clone'
const label = '/proc/321/attr/current'
const policy = fs.readFileSync(path.join(root, 'build/linux/toolsenabled-customer.apparmor'))
const error = code => Object.assign(new Error(code), { code })

function fixture(state = 'profile-prepared') {
  const files = new Map([
    [executable, Buffer.from('synthetic ELF marker')], [sourcePolicy, policy], [installedPolicy, policy],
    [hashReceipt, Buffer.from(`${POLICY_SHA256}\n`)], [record, admissionBytes(state)],
    [restriction, Buffer.from('1\n')], [clone, Buffer.from('1\n')],
    [label, Buffer.from('toolsenabled-customer (unconfined)\n')],
  ])
  const faults = new Map(), metadata = new Map(), reads = [], dataOpens = [], descriptors = new Map()
  let next = 10
  const info = (file, directory = false) => ({
    uid: 0, gid: 0, nlink: 1, dev: 1, ino: file, mtimeMs: 1, ctimeMs: 1,
    mode: directory ? 0o40755 : file === executable ? 0o100755 : 0o100644,
    size: directory ? 0 : files.get(file)?.length || 0,
    isDirectory: () => directory, isFile: () => !directory,
    ...metadata.get(file),
  })
  const fsOps = {
    lstatSync(file) {
      reads.push(file)
      if (faults.has(file)) throw error(faults.get(file))
      return info(file, !files.has(file))
    },
    statfsSync(file) {
      reads.push(file)
      if (faults.has(file)) throw error(faults.get(file))
      return { type: 0x9fa0, ...metadata.get('procfs') }
    },
    openSync(file, flags) {
      reads.push(file)
      const held = /^\/proc\/321\/fd\/(\d+)$/.exec(file)
      if (held) {
        assert.equal(flags, fs.constants.O_RDONLY)
        const original = descriptors.get(Number(held[1]))
        assert.ok(original, 'data opens must name an owned held descriptor')
        dataOpens.push(original)
        if (metadata.get(original)?.dataOpenError) throw error(metadata.get(original).dataOpenError)
        const fd = next++; descriptors.set(fd, original); return fd
      }
      assert.equal(flags & 0x200000, 0x200000, 'original path must use metadata-only O_PATH')
      assert.equal(flags & (fs.constants.O_NOFOLLOW || 0), fs.constants.O_NOFOLLOW || 0)
      if (faults.has(file)) throw error(faults.get(file))
      if (!files.has(file)) throw error('ENOENT')
      if (metadata.get(file)?.symlink) throw error('ELOOP')
      const fd = next++; descriptors.set(fd, file); return fd
    },
    fstatSync(fd) { return info(descriptors.get(fd)) },
    readSync(fd, target, offset, length, position) {
      const value = files.get(descriptors.get(fd))
      return value.copy(target, offset, position, position + length)
    },
    closeSync(fd) { assert.ok(descriptors.delete(fd)) },
  }
  const run = options => check({ platform: 'linux', isPackaged: true, execPath: executable, pid: 321, fsOps, ...options })
  return { files, faults, metadata, reads, dataOpens, run, fsOps, descriptors,
    state(value) { files.set(record, admissionBytes(value)) } }
}

test('positive: exact modern prepared policy and attached process admit without changing sandbox settings', () => {
  assert.equal(createHash('sha256').update(policy).digest('hex'), POLICY_SHA256)
  const f = fixture()
  assert.deepEqual(f.run(), { ok: true, applicable: true, state: 'profile-prepared', policyRequired: true })
  assert.equal(f.descriptors.size, 0)
})

test('positive: deferred and no-policy-required states admit a proven unrestricted kernel without clearing state', () => {
  for (const state of ['deferred-legacy-policy', 'no-policy-required', 'profile-prepared']) {
    const f = fixture(state); f.files.set(restriction, Buffer.from('0\n'))
    const before = Buffer.from(f.files.get(record))
    assert.equal(f.run().ok, true)
    assert.deepEqual(f.files.get(record), before)
    f.files.delete(restriction); f.files.delete(clone)
    assert.equal(f.run().ok, true, 'absent optional controls inside established procfs')
  }
})

test('positive: Windows, development and copied QA layouts do not read or borrow installed admission', () => {
  for (const options of [{ platform: 'win32' }, { isPackaged: false }, { execPath: '/owned/qa/toolsenabled' }]) {
    const f = fixture()
    assert.deepEqual(f.run(options), { ok: true, applicable: false })
    assert.equal(f.reads.length, 0)
  }
})

test('deferred admission is refused on a later restricted kernel and unknown is never unrestricted', () => {
  const f = fixture('deferred-legacy-policy'); f.files.set(restriction, Buffer.from('0\n'))
  assert.equal(f.run().ok, true)
  f.files.set(restriction, Buffer.from('1\n'))
  assert.equal(f.run().code, 'LINUX_INSTALLED_POLICY_PENDING')
  for (const control of [restriction, clone]) {
    for (const bytes of ['unknown\n', '0\n1\n', ' 0\n', '0\0', '9'.repeat(20)]) {
      const g = fixture('deferred-legacy-policy'); g.files.set(control, Buffer.from(bytes))
      assert.equal(g.run().code, 'LINUX_INSTALLED_KERNEL_UNKNOWN', bytes)
    }
    const g = fixture(); g.faults.set(control, 'EACCES')
    assert.equal(g.run().code, 'LINUX_INSTALLED_KERNEL_UNKNOWN')
    const reopened = fixture(); reopened.metadata.set(control, { dataOpenError: 'ENOENT' })
    assert.equal(reopened.run().code, 'LINUX_INSTALLED_KERNEL_UNKNOWN', 'descriptor reopen failure is not an absent control')
  }
  f.files.set(restriction, Buffer.from('0\n')); f.files.set(clone, Buffer.from('0\n'))
  assert.equal(f.run().code, 'LINUX_INSTALLED_USERNS_DISABLED')
  f.files.delete(restriction); f.metadata.set('procfs', { type: 0x1234 })
  assert.equal(f.run().code, 'LINUX_INSTALLED_KERNEL_UNKNOWN')
  f.metadata.delete('procfs'); f.faults.set('/proc/sys/kernel', 'ENOENT')
  assert.equal(f.run().code, 'LINUX_INSTALLED_KERNEL_UNKNOWN')
})

test('missing, noncanonical and configuring records refuse even before unrestricted kernel admission', () => {
  const changes = [
    f => f.files.delete(record),
    f => f.state('configuring'),
    f => f.files.set(record, Buffer.concat([admissionBytes('profile-prepared'), Buffer.from('state=profile-prepared\n')])),
    f => f.files.set(record, Buffer.from(admissionBytes('profile-prepared').toString().replace('reason=none', 'unknown=none'))),
    f => f.files.set(record, Buffer.from(admissionBytes('profile-prepared').toString().replace(POLICY_SHA256, 'f'.repeat(64)))),
    f => f.files.set(record, Buffer.concat([admissionBytes('profile-prepared'), Buffer.from('\0')])),
    f => f.files.set(record, Buffer.from('x'.repeat(513))),
    f => f.metadata.set(record, { mode: 0o100600 }),
    f => f.metadata.set(record, { mode: 0o100444 }),
  ]
  for (const mutate of changes) {
    const f = fixture(); f.files.set(restriction, Buffer.from('0\n')); mutate(f)
    assert.equal(f.run().ok, false)
    assert.equal(f.reads.includes(restriction), false)
    assert.equal(f.descriptors.size, 0)
  }
})

test('protected identity rejects foreign, linked, writable or changed policy and receipt inputs', () => {
  for (const file of [record, sourcePolicy, installedPolicy, hashReceipt, executable]) {
    for (const meta of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o100666 }, { nlink: 2 }, { isFile: () => false }]) {
      const f = fixture(); f.metadata.set(file, meta)
      assert.equal(f.run().ok, false, `${file}: ${Object.keys(meta)}`)
    }
  }
  for (const file of [record, sourcePolicy, installedPolicy, hashReceipt]) {
    const f = fixture(); f.metadata.set(file, { symlink: true })
    assert.equal(f.run().ok, false)
  }
  for (const directory of ['/var', '/var/lib', '/var/lib/toolsenabled-installer', '/opt', '/etc/apparmor.d']) {
    const f = fixture(); f.metadata.set(directory, { mode: 0o40777 })
    assert.equal(f.run().ok, false, directory)
  }
  for (const file of [sourcePolicy, installedPolicy, hashReceipt]) {
    const f = fixture(); f.files.set(file, Buffer.from('administrator change'))
    assert.equal(f.run().ok, false)
  }
  for (const value of ['unconfined\n', 'toolsenabled-customer (enforce)\n', 'toolsenabled-customer-other (unconfined)\n', 'toolsenabled-customer//&other (unconfined)\n']) {
    const f = fixture(); f.files.set(label, Buffer.from(value))
    assert.equal(f.run().code, 'LINUX_INSTALLED_POLICY_UNATTACHED')
  }
})

test('nonregular installed and proc inputs are refused without any data open of that object', () => {
  for (const file of [record, sourcePolicy, installedPolicy, hashReceipt, restriction, clone, label]) {
    for (const kind of ['FIFO', 'device']) {
      const f = fixture(); f.metadata.set(file, { isFile: () => false, mode: kind === 'FIFO' ? 0o10644 : 0o20644 })
      assert.equal(f.run().ok, false, `${file}: ${kind}`)
      assert.equal(f.dataOpens.includes(file), false, 'rejected type was opened for data')
      assert.equal(f.descriptors.size, 0)
    }
  }
})

// Evaluate the actual main entry prefix, including its actual admission branch.
// All effects are injected tripwires: no Electron binary or window is started.
const main = fs.readFileSync(path.join(root, 'shell/main.cjs'), 'utf8')
const prefix = main.slice(0, main.indexOf("const { platformKeystore } = require('./os-keystore.cjs')")
  + "const { platformKeystore } = require('./os-keystore.cjs')".length)
function entry(f, options = {}) {
  const effects = [], messages = []
  const exit = new Error('synthetic immediate exit'), downstream = new Error('downstream reached')
  const platform = options.platform || 'linux', isPackaged = options.isPackaged ?? true
  const execPath = options.execPath || executable
  const app = { isPackaged, getPath() { effects.push('userData'); throw downstream },
    requestSingleInstanceLock() { effects.push('single-instance'); throw downstream } }
  const context = {
    process: { platform, execPath, pid: 321, argv: [execPath, ...(options.argv || [])],
      env: { MC_SMOKE_HEADLESS: '1' }, umask: () => 0o022,
      stderr: { write(value) { messages.push(value) } }, exit(code) { assert.equal(code, 1); throw exit } },
    Buffer,
    require(name) {
      if (name === 'node:path') return path
      if (name === './electron-node-handoff.cjs') return { electronNodeHandoff: () => options.handoff || null }
      if (name === 'electron') return { app, dialog: { showErrorBox() { effects.push('dialog'); throw downstream } } }
      if (name === './startup-refusal.cjs') return require('../../shell/startup-refusal.cjs')
      if (name === './linux-installed-admission.cjs') return { checkLinuxInstalledAdmission: supplied =>
        check({ ...supplied, platform, execPath, pid: 321, fsOps: f.fsOps }) }
      if (name === './os-keystore.cjs') { effects.push('keystore-module'); throw downstream }
      effects.push(name); throw downstream
    },
  }
  let terminal
  try { vm.runInNewContext(prefix, context, { timeout: 1000 }); terminal = 'fell-through' }
  catch (e) { if (e === exit) terminal = 'refused'; else if (e === downstream) terminal = 'downstream'; else throw e }
  return { terminal, effects, messages }
}

test('positive: actual entry admits modern direct/desktop launches and keeps Windows/developer/QA contracts', () => {
  for (const options of [{}, { argv: ['toolsenabled://fixture'] }, { platform: 'win32' }, { isPackaged: false }, { execPath: '/owned/qa/toolsenabled' }]) {
    const f = fixture(); const result = entry(f, options)
    assert.equal(result.terminal, 'downstream')
    assert.deepEqual(result.effects, ['keystore-module'])
    if (options.platform || options.isPackaged === false || options.execPath) assert.equal(f.reads.length, 0)
  }
})

test('actual direct, desktop, single-instance and Node-handoff entries refuse before any application effects', () => {
  for (const options of [{}, { argv: ['toolsenabled://fixture'] }, { argv: ['--tree-node-command=fixture'] },
    { argv: ['/opt/ToolsEnabled/resources/engine/src/mcp-server.js'], handoff: { script: 'synthetic pending handoff' } }]) {
    const f = fixture('deferred-legacy-policy'); const result = entry(f, options)
    assert.equal(result.terminal, 'refused')
    assert.deepEqual(result.effects, [])
    assert.match(result.messages.join(''), /LINUX_INSTALLED_POLICY_PENDING/)
  }
  assert.ok(main.indexOf('const linuxInstalledAdmission') < main.indexOf("app.getPath('userData')"))
  assert.ok(main.indexOf('const linuxInstalledAdmission') < main.indexOf('app.requestSingleInstanceLock('))
})
