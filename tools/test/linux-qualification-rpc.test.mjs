import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinuxGuestReply } from '../lib/transport/linux-qualification-rpc.mjs';

const expected = { guestId: 'synthetic-guest', nonce: 'fresh-challenge', method: 'attest', agentSha256: 'a'.repeat(64) };
const proof = () => ({ schema: 'toolsenabled.private-linux-provisioning-rpc', guestId: expected.guestId,
  nonce: expected.nonce, qualification: false, result: { platform: 'Linux', kernel: 'test-kernel',
    agentSha256: expected.agentSha256, uid: 0, userUid: 1000, user: 'synthetic-user',
    machineId: 'synthetic-machine', networkDevices: ['lo'] } });

test('valid infrastructure proof keeps qualification explicitly false', () => {
  const value = proof();
  assert.equal(validateLinuxGuestReply(value, expected), value);
  assert.equal(value.qualification, false);
});
for (const [name, edit] of [
  ['wrong guest', value => { value.guestId = 'different'; }],
  ['replayed challenge', value => { value.nonce = 'old-challenge'; }],
  ['missing schema', value => { delete value.schema; }],
  ['invented qualification', value => { value.qualification = true; }],
  ['foreign platform', value => { value.result.platform = 'Windows'; }],
  ['changed agent', value => { value.result.agentSha256 = 'b'.repeat(64); }],
  ['root desktop user', value => { value.result.userUid = 0; }],
  ['unknown user uid', value => { value.result.userUid = null; }],
  ['missing machine identity', value => { value.result.machineId = ''; }],
  ['network interface', value => { value.result.networkDevices = ['lo', 'eth0']; }],
  ['missing command broker identity', value => { value.result.uid = 1000; }],
]) {
  test('refuses ' + name, () => {
    const value = proof(); edit(value);
    assert.throws(() => validateLinuxGuestReply(value, expected), { code: 'LINUX_GUEST_REFUSED' });
  });
}
test('command failures remain nonzero with their actual stderr', () => {
  const value = { ...proof(), result: { exitCode: 100, stdout: '', stderr: 'dependency missing', role: 'standard' } };
  assert.equal(validateLinuxGuestReply(value, { ...expected, method: 'exec', role: 'standard' }).result.exitCode, 100);
});
test('missing command result is refused rather than interpreted as success', () => {
  for (const result of [{}, { exitCode: null, stdout: '', stderr: '' }, { exitCode: 0, stdout: '' }]) {
    assert.throws(() => validateLinuxGuestReply({ ...proof(), result }, { ...expected, method: 'exec', role: 'standard' }), { code: 'LINUX_GUEST_REFUSED' });
  }
});

test('execution outcome binds the requested profile', () => {
  for (const role of [undefined, 'install-authorized', 'other']) {
    const value = { ...proof(), result: { exitCode: 0, stdout: '0\n', stderr: '', role } };
    assert.throws(() => validateLinuxGuestReply(value, { ...expected, method: 'exec', role: 'standard' }), { code: 'LINUX_GUEST_REFUSED' });
  }
});
