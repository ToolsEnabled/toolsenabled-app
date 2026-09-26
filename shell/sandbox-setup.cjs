'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')
const { childEnvironment } = require('./capability-layer.cjs')
const failure = (code, message) => ({ ok: false, code, message })

// One instance per application, including while native confirmation is open.
function createSandboxSetup({ authorize, confirm, execute, preparationSupported = process.platform === 'linux' }) {
  let busy = false
  let sealed = false
  return Object.freeze({ sealAdmission() { sealed = true }, async run(event, mode, input) {
    if (sealed) return failure('SANDBOX_SETUP_SHUTTING_DOWN', 'ToolsEnabled is closing; sandbox setup cannot start.')
    if (!authorize(event)) return failure('SANDBOX_SETUP_SENDER_REFUSED', 'Only the application owner window may prepare a sandbox.')
    if (!['doctor', 'prepare'].includes(mode) || input !== undefined) return failure('SANDBOX_SETUP_INPUT_INVALID', 'This action accepts no settings or commands.')
    if (mode === 'prepare' && !preparationSupported) return failure('SANDBOX_SETUP_COORDINATION_UNSUPPORTED', 'Automatic preparation is unavailable on this platform; readiness checks remain available.')
    if (busy) return failure('SANDBOX_SETUP_BUSY', 'Sandbox preparation or checking is already running.')
    busy = true
    try {
      if (mode === 'prepare' && await confirm(event) !== true) return failure('SANDBOX_SETUP_DECLINED', 'Nothing was prepared.')
      if (sealed) return failure('SANDBOX_SETUP_SHUTTING_DOWN', 'ToolsEnabled is closing; sandbox setup cannot start.')
      if (!authorize(event)) return failure('SANDBOX_SETUP_SENDER_REFUSED', 'The owner window is no longer available.')
      return await execute(mode)
    } catch {
      return failure('SANDBOX_SETUP_FAILED', 'Sandbox setup failed. No readiness was established; check Docker and the sandbox prerequisites.')
    } finally { busy = false }
  } })
}

// A separate fixed child keeps synchronous Docker calls off the UI thread.
// On deadline the caller gets an honest indeterminate answer; transport busy
// remains held until exit, because killing a CLI cannot prove Docker stopped.
function createSandboxSetupExecutor({ capabilityRoot, stateRoot, executable = process.execPath,
  environment = process.env, spawnChild = spawn, timeoutMs = 22 * 60 * 1000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = false
  let sealed = false
  const execute = mode => {
    if (sealed) return Promise.resolve(failure('SANDBOX_SETUP_SHUTTING_DOWN', 'Sandbox worker admission is closed.'))
    if (!['doctor', 'prepare'].includes(mode)) return Promise.resolve(failure('SANDBOX_SETUP_INPUT_INVALID', 'Unknown setup operation.'))
    if (active) return Promise.resolve(failure('SANDBOX_SETUP_BUSY', 'An earlier sandbox worker is still finishing.'))
    const flight = { onExit: [] }
    active = flight
    return new Promise(resolve => {
      let child, timer, answered = false, result = null
      const release = () => { if (active === flight) active = false; for (const listener of flight.onExit.splice(0)) listener() }
      const answer = value => { if (!answered) { answered = true; resolve(value) } }
      try {
        const env = childEnvironment(environment, { stateRoot })
        // A setup child executes only its packaged entrypoint, never inherited
        // Node preload/debug switches or an alternate program search location.
        for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|LD_|DYLD_)/.test(key)) delete env[key]
        child = spawnChild(executable, [path.join(__dirname, 'sandbox-setup-worker.cjs'), capabilityRoot, mode], {
          env, cwd: capabilityRoot, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        })
        flight.child = child
      } catch { release(); answer(failure('SANDBOX_SETUP_START_FAILED', 'The sandbox setup worker could not start.')); return }
      timer = setTimer(() => answer(failure('SANDBOX_SETUP_TIMEOUT', 'The setup deadline elapsed. Docker work may still be finishing; no cancellation or readiness is claimed.')), mode === 'doctor' ? 90000 : timeoutMs)
      child.on('message', packet => {
        if (!packet || packet.protocol !== 'toolsenabled.sandbox-setup/1' || result) return
        if (packet.ok === true && ['ready', 'not-ready'].includes(packet.status)) {
          result = { ok: true, status: packet.status, ready: packet.status === 'ready',
            built: packet.built === true, code: typeof packet.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(packet.code) ? packet.code : null }
        } else result = failure(typeof packet.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(packet.code) ? packet.code : 'SANDBOX_SETUP_FAILED', 'Sandbox preparation or verification failed. No readiness was established.')
      })
      child.once('error', () => {
        // A PID proves a process was created: an IPC/kill error is not proof
        // it exited. Keep its flight until the exit event. Failed spawn has
        // no PID and may never emit exit, so only that case releases here.
        if (!Number.isInteger(child.pid) || child.pid <= 0) release()
        clearTimer(timer)
        answer(failure('SANDBOX_SETUP_START_FAILED', 'The sandbox setup worker failed; no readiness or cancellation is claimed.'))
      })
      child.once('exit', code => {
        release(); clearTimer(timer)
        answer(code === 0 && result ? result : failure('SANDBOX_SETUP_FAILED', 'The sandbox setup worker did not complete verification.'))
      })
    })
  }
  execute.sealAdmission = () => { sealed = true }
  execute.waitForExit = () => {
    sealed = true
    const flight = active
    if (!flight) return Promise.resolve({ status: 'exited' })
    return new Promise(resolve => {
      let done = false
      const settle = status => { if (!done) { done = true; resolve({ status }) } }
      const timer = setTimer(() => settle('unknown'), 5000)
      flight.onExit.push(() => { clearTimer(timer); settle('exited') })
    })
  }
  return execute
}
module.exports = { createSandboxSetup, createSandboxSetupExecutor }
