'use strict'

// Minimal stand-in for the real engine module, used only to prove that the
// availability probe answers ok for something that genuinely exports the
// contract -- not merely that it always fails closed. It starts no process:
// the probe resolves and loads the module, and never calls this.
async function startCodexSession() {
  throw new Error('the availability fixture never starts a session')
}

module.exports = { startCodexSession }
