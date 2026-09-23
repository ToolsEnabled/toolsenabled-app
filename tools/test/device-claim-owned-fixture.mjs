/* Protocol-test adapter only. These existing suites model a completed owner
   with their fake child's close event. Native containment is independently
   exercised by device-claim-owned-process.test.mjs; this is not its proof. */
export function ownedSpawnFixture(spawn, timers = globalThis) {
  return ({ command, args, environment, cleanupTimeoutMs = 5000 }) => {
    const child = spawn(command, args, { env: environment, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] })
    let complete
    let escalation = null
    let exited = false
    const completion = new Promise(resolve => { complete = resolve })
    const finish = value => {
      exited = true
      if (escalation !== null) timers.clearTimeout(escalation)
      complete(value)
    }
    child.once('exit', () => { exited = true })
    child.once('close', async (code, signal) => {
      const retained = child.claimCompletion ? await child.claimCompletion : null
      finish({ quiescent: retained ? retained.clean === true : true, started: true,
        exitedNormally: signal == null && Number.isInteger(code), exitCode: code })
    })
    child.once('error', () => finish({ quiescent: true, started: false,
      exitedNormally: false, exitCode: null }))
    return { child, completion,
      cancel() {
        if (!exited && escalation === null) {
          child.kill()
          escalation = timers.setTimeout(() => child.kill('SIGKILL'), cleanupTimeoutMs)
        }
        return completion
      },
    }
  }
}
