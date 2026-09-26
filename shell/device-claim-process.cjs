'use strict'

const path = require('node:path')

// Load from the installed payload, using the same native family supervisors
// as the engine. A root exit alone cannot release a vault operation: its
// PowerShell or Python helpers may still be writing.
function createClaimProcessSpawner({ resolvePayloadRoot, stateRoot, platform = process.platform }) {
  return (command, args, options) => {
    const root = resolvePayloadRoot()
    const { safeLaunchEnvironment } = require(path.join(root, 'src/lib/providers/subscription-launch-env.js'))
    const launch = { ...options, cwd: stateRoot, terminateDescendantsOnRootExit: true }
    const dependencies = { safeLaunchEnvironment,
      recordDirectory: path.join(stateRoot, 'state/windows-jobs'),
      assemblyCacheDirectory: path.join(stateRoot, 'state/windows-job-wrapper-cache') }
    let child
    if (platform === 'win32') {
      child = require(path.join(root, 'src/lib/windows-job-control.js')).spawnInJob(command, args, launch, dependencies)
    } else if (platform === 'linux') {
      child = require(path.join(root, 'src/lib/linux-process-control.js')).spawnLinuxOwned(command, args, launch, dependencies)
    } else {
      throw new Error('The connection process supervisor is unavailable.')
    }
    child.claimCompletion = Promise.all([child.jobOutcome, child.jobClosed]).then(([outcome, closed]) => {
      const empty = outcome?.activeProcesses === 0 && ['exit', 'terminated', 'not-started'].includes(outcome.type)
      const linux = platform === 'linux'
      const verified = empty && !closed?.failure && !child.containmentFailure && (linux
        ? outcome.backend === 'linux-subreaper-pidfd-v2'
          && child.ownershipIdentity?.backend === outcome.backend
          && Number.isSafeInteger(outcome.observedChildren)
          && outcome.observedChildren === outcome.reapedChildren
          && (outcome.type === 'not-started' ? outcome.observedChildren === 0 : outcome.observedChildren > 0)
        : !!child.jobIdentity && Number.isInteger(closed?.code) && Number.isInteger(outcome.exitCode)
          && (closed.code >>> 0) === (outcome.exitCode >>> 0) && closed?.signal === null)
      return { clean: verified, successful: verified && outcome.type === 'exit'
        && !outcome.reasonCode && outcome.exitCode === 0 && (!linux || outcome.exitSignal === null) }
    }, () => ({ clean: false, successful: false }))
    return child
  }
}

module.exports = { createClaimProcessSpawner }
