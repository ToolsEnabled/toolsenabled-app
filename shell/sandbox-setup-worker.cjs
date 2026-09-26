'use strict'
// Invoked only by the main-owned fixed setup executor, never renderer argv.
const path = require('node:path')
const [root, mode] = process.argv.slice(2)
let result
let lease
let completed = false
try {
  if (!path.isAbsolute(root || '') || !['doctor', 'prepare'].includes(mode)
      || !path.isAbsolute(process.env.TOOLSENABLED_STATE_ROOT || '') || process.argv.length !== 4) throw new Error('Invalid setup invocation')
  if (mode === 'prepare') {
    lease = require('./sandbox-setup-lease.cjs').acquireSandboxPreparation({ stateRoot: process.env.TOOLSENABLED_STATE_ROOT })
    const provisioner = require(path.join(root, 'src/lib/sandbox-image-provisioning.js')).createSandboxImageProvisioner({ onImageBuildStart: () => lease.markBuildStarted() })
    const prepared = provisioner.prepareSandboxImage({ allowBuild: true })
    if (prepared.status !== 'ready') throw new Error('Preparation did not establish readiness')
    completed = true
    result = { ok: true, status: 'ready', built: prepared.built === true }
  } else {
    const doctor = require(path.join(root, 'src/lib/providers/agent-sandbox.js')).doctor()
    const ready = doctor.available === true && doctor.compatible === true && doctor.imageReady === true
    result = { ok: true, status: ready ? 'ready' : 'not-ready', code: doctor.imageCode || doctor.code || null }
  }
} catch (error) { result = { ok: false, code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'SANDBOX_SETUP_FAILED' } }
try {
  if (lease?.finish({ completed }).recoveryRequired) result = { ok: false, code: 'SANDBOX_SETUP_RECOVERY_REQUIRED' }
} catch { result = { ok: false, code: 'SANDBOX_SETUP_RECOVERY_REQUIRED' } }
if (typeof process.send === 'function') process.send({ protocol: 'toolsenabled.sandbox-setup/1', ...result }, () => process.disconnect())
else process.exitCode = 1
