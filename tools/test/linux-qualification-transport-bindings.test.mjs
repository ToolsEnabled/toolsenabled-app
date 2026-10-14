import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/linux-qualification-transport-fixture.mjs';

const linux = { skip: process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0
  ? false : 'Requires the owning non-root Linux x64 account; required Linux case remains unexecuted' };

test('synthetic transport positive control preserves nonce/profile and unqualified state', linux, async () => {
  const f = await fixture();try {
    const t = await f.open();const result = await t.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' });
    assert.equal(result.result.stdout, '1000\n');assert.equal(t.identity.qualification, false);
    assert.equal(result.result.role, 'standard');
    const rpc = f.requests.filter(x => x.nonce);assert.equal(new Set(rpc.map(x => x.nonce)).size, rpc.length);
    t.close();
  } finally { await f.dispose(); }
});
test('synthetic replay control refuses a changed nonce', linux, async () => {
  const f = await fixture();try { const t = await f.open();f.changeNonce('stale');
    await assert.rejects(t.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' }), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});
test('standard request must refuse a privileged response role', linux, async () => {
  const f = await fixture();try { const t = await f.open();f.changeRole('install-authorized');
    await assert.rejects(t.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' }), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});
test('changed base image bytes must refuse before admission', linux, async () => {
  const f = await fixture({ wrongImage: true });try {
    await assert.rejects(f.open(), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});
test('QMP and RPC endpoints must belong to the declared process', linux, async () => {
  const f = await fixture({ wrongProcess: true });try {
    assert.notEqual(f.actualSocketProcess, f.config.qemuPid);
    await assert.rejects(f.open(), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});
test('a later attestation must retain the initially measured machine identity', linux, async () => {
  const f = await fixture();try { const t = await f.open();f.changeMachine('another-machine');
    await assert.rejects(t.attest(), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});

test('artifact input share must not resolve outside the dedicated machine root', linux, async () => {
  const f = await fixture({ linkedInput: true });try {
    await assert.rejects(f.open(), { code: 'LINUX_GUEST_REFUSED' });
  } finally { await f.dispose(); }
});

test('changed process start refuses the next request', linux, async () => {
  const f = await fixture();try { const t = await f.open();f.changeProcessStart('456');
    const before = f.requests.length;
    await assert.rejects(t.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' }), { code: 'LINUX_GUEST_REFUSED' });
    assert.equal(f.requests.length, before);
  } finally { await f.dispose(); }
});
test('invalid command/profile bounds refuse without RPC dispatch', linux, async () => {
  const f = await fixture();try { const t = await f.open();const before = f.requests.length;
    for (const value of [
      { argv: ['id'], profile: 'unrecognized' },
      { argv: [], profile: 'linux-x64-standard' },
      { argv: ['id'], profile: 'linux-x64-standard', timeoutSeconds: 181 },
      { argv: ['id', 'a'.repeat(8193)], profile: 'linux-x64-standard' }
    ]) assert.throws(() => t.execute(value), { code: 'LINUX_GUEST_REFUSED' });
    assert.equal(f.requests.length, before);
  } finally { await f.dispose(); }
});
