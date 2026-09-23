#!/usr/bin/env node
'use strict';
/**
 * Authenticated but token-free Codex transport probe.
 *
 * It starts an app-server thread, stops it, then starts the other Codex model
 * with the first id as a resume hint. It deliberately never calls turn/start,
 * so Codex has no rollout to persist and a clean fallback thread is expected.
 */

const { Agent, resolveCodex } = require('../agent');

if (!resolveCodex) {
  console.error('Codex resolver is unavailable.');
  process.exit(1);
}

function open(model, resumeFrom = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const agent = new Agent({
      port: 1,
      model,
      resumeFrom,
      onEvent: (event) => {
        if (settled) return;
        if (event.kind === 'session') {
          settled = true;
          clearTimeout(timeout);
          const id = event.sessionId;
          console.log(JSON.stringify({
            model: event.model,
            provider: event.provider,
            session: !!id,
          }));
          agent.stop();
          resolve(id);
        } else if (event.kind === 'agent-error') {
          settled = true;
          clearTimeout(timeout);
          agent.stop();
          reject(new Error(event.error));
        }
      },
    });
    agent.start();
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      agent.stop();
      reject(new Error('Codex handshake timeout'));
    }, 20000);
  });
}

(async () => {
  const first = await open('terra');
  await new Promise((resolve) => setTimeout(resolve, 750));
  const resumed = await open('sol', first);
  console.log(JSON.stringify({
    cleanFallbackWithoutRollout: first !== resumed,
    modelTurns: 0,
  }));
  process.exit(first && resumed ? 0 : 1);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
