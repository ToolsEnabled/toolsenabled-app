import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/linux-qualification-transport-fixture.mjs';
import { runLinuxPackageTransition } from '../lib/drivers/linux-qualification-scenarios.mjs';

const linux = { skip: process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0
  ? false : 'Requires the owning non-root Linux x64 account; required Linux case remains unexecuted' };

test('linked artifact input refuses before creating anything outside the machine root', linux, async () => {
  const f = await fixture({ linkedInput: true });try {
    const bytes = Buffer.from('synthetic package bytes'), file = path.join(f.root, 'candidate.deb');fs.writeFileSync(file, bytes);
    const calls = [];
    const transport = { version: 1, identity: { qualification: false, machineRoot: f.root,
      guestInputRoot: '/synthetic-input', guestId: f.config.guestId, native: { userUid: 1000 } },
      async execute(request) {
        calls.push(request);
        assert.ok(['id', 'cat'].includes(request.argv[0]), 'no installer command is admitted');
        return { result: { exitCode: 0, stdout: request.argv[0] === 'id' ? '1000\n' : '', stderr: '' } };
      } };
    await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', profile: 'linux-x64-standard', transport,
      artifact: { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, version: '1.0.49' } }),
      { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
    assert.equal(fs.existsSync(path.join(f.outside, 'installer-artifacts')), false,
      'refusal must occur before mkdir traverses the linked input directory');
    assert.equal(calls.length, 2);
  } finally { await f.dispose(); }
});
