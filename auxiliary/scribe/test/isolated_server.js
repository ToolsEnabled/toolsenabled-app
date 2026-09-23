'use strict';

/**
 * Helpers for tests that launch a private Scribe server.
 *
 * A fixed port can already belong to a user's live session or another test.
 * Selecting an ephemeral port reduces that risk; checking the health payload's
 * Node PID proves that a test reached the child it just spawned before it sends
 * any mutating request.
 */

const net = require('net');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && address.port;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForOwnedHealth(requestHealth, child, {
  attempts = 120,
  interval = 100,
  requireDocHost = false,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `isolated Scribe server exited before readiness ` +
        `(code=${child.exitCode}, signal=${child.signalCode})`
      );
    }
    try {
      const response = await requestHealth();
      const health = response && response.body;
      if (response && response.status === 200 && health && health.ok === true) {
        if (health.serverPid !== child.pid) {
          throw new Error(
            `port ownership mismatch: spawned PID ${child.pid}, ` +
            `health reported ${health.serverPid}`
          );
        }
        if (!requireDocHost || (health.dochost && health.dochost.ready)) {
          return health;
        }
      }
    } catch (error) {
      if (/port ownership mismatch/.test(String(error && error.message))) throw error;
    }
    await sleep(interval);
  }
  throw new Error(`isolated Scribe server PID ${child.pid} did not become ready`);
}

module.exports = { availablePort, waitForOwnedHealth };
