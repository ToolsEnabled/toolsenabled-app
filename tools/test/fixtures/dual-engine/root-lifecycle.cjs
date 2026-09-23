'use strict'
const { EventEmitter } = require('node:events')

// An explicitly in-process UI fixture, not OS launch/containment evidence.
// It still executes the private guard and supplies honest fixture lifecycle
// events, so a marker alone cannot bypass the application's required checks.
const control = { prepare: null, roots: 0 }
async function rootLifecycle(rootLaunch) {
  if (!rootLaunch) return { close() {} }
  const child = new EventEmitter()
  let closed = false
  let resolveOutcome
  child.jobOutcome = new Promise(resolve => { resolveOutcome = resolve })
  function close() {
    if (closed) return
    closed = true
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    resolveOutcome({ activeProcesses: 0, fixtureOnly: true })
  }
  child.terminateJob = async () => { close() }
  rootLaunch.spawned(child)
  if (control.prepare) await control.prepare(child)
  rootLaunch.beforeRootSpawn()
  control.roots++
  return { close }
}
module.exports = { rootLifecycle, control }
