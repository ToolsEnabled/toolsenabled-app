'use strict'
// Test-only child: synthetic directories/boot ID, no Docker or provider calls.
const { acquireSandboxPreparation } = require('../../../shell/sandbox-setup-lease.cjs')
try {
  const [stateRoot, runtimeRoot, bootId, action] = process.argv.slice(2)
  const lease = acquireSandboxPreparation({ stateRoot, runtimeRoot, bootId })
  if (action === 'build-crash') lease.markBuildStarted()
  if (action === 'crash' || action === 'build-crash') process.kill(process.pid, 'SIGKILL')
  else { lease.finish({ completed: action === 'complete' }); process.stdout.write('released') }
} catch (error) { process.stdout.write(error.code || 'UNEXPECTED'); process.exitCode = 2 }
