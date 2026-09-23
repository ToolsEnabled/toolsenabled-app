import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { resolveQualificationMachineForTest, WORKER_CONFIG_SCHEMA } from '../lib/guest/disposable-guest.mjs';

// WHY THIS FILE EXISTS, AND WHAT THE OTHER SUITE COULD NOT SEE.
//
// The admission tests in disposable-guest-contract.test.mjs computed their
// expectation from the SAME measureRegisteredToolchain the product calls. A
// wrong oracle therefore moved product and expectation together and the suite
// stayed green in BOTH directions:
//   - oracle forced to always THROW: the approved host also answers
//     TOOLCHAIN_UNAPPROVED, and the suite is green.
//   - oracle forced to always PASS: an unapproved host is admitted past the
//     gate to the PowerShell step, and the suite is STILL green. That is the
//     boundary FAILING OPEN behind a passing test, and it is the direction
//     that matters.
// An enum-distinctness test cannot see either, because it checks constants
// rather than routing.
//
// So this file asserts the ROUTING, host-independently, with LITERAL expected
// codes. It never asks the product what the answer should be:
//   a measurement that RETURNS  -> the machine refusal
//   a measurement that THROWS   -> the toolchain refusal
//
// The expected strings are written out by hand below. They are NOT read from
// ADMISSION_REFUSALS, because an expectation taken from the code under test
// proves self-consistency and nothing else.
const MACHINE_UNRESOLVED = 'DISPOSABLE_GUEST_MACHINE_UNRESOLVED';
const TOOLCHAIN_UNAPPROVED = 'DISPOSABLE_GUEST_TOOLCHAIN_UNAPPROVED';

const TEST_TEMP = ownedFixtureTempRoot();
const scratch = t => {
  const root = mkdtempSync(path.join(TEST_TEMP, 'toolchain-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
// A worker description naming a machine that cannot exist, so machine
// resolution always fails and the only variable left is the measurement.
function workerConfig(t) {
  const root = scratch(t), machineRoot = path.join(root, 'machine');
  mkdtempSync(path.join(root, 'seed-'));
  writeFileSync(path.join(root, 'worker.json'), JSON.stringify({
    schema: WORKER_CONFIG_SCHEMA, schemaVersion: 1,
    vmId: 'deadbeef-0000-4000-8000-000000000001',
    vmName: 'ToolsEnabled-Qualification-RoutingProbe',
    baselineCheckpointId: 'deadbeef-0000-4000-8000-000000000002',
    machineRoot: scratch(t), guestProfile: path.parse(TEST_TEMP).root, networkPolicy: 'offline',
  }));
  return { file: path.join(root, 'worker.json'), machineRoot };
}
const codeOf = (runnerConfigPath, measure) => {
  try { resolveQualificationMachineForTest(runnerConfigPath, measure); return 'RESOLVED'; }
  catch (error) { return error?.code ?? `UNCODED(${error?.constructor?.name})`; }
};

test('a toolchain measurement that THROWS routes to the toolchain refusal, on any host', t => {
  const { file } = workerConfig(t);
  const thrower = () => { throw new Error('Registered qualification toolchain blocked: unapproved node path or executable bytes'); };
  assert.equal(codeOf(file, thrower), TOOLCHAIN_UNAPPROVED,
    'mutation `route an unapproved toolchain somewhere other than its own refusal` survived');
});

test('a toolchain measurement that RETURNS routes past the gate to machine resolution, on any host', t => {
  const { file } = workerConfig(t);
  let calls = 0;
  const passer = () => { calls += 1; };
  const code = codeOf(file, passer);
  assert.equal(calls, 1, 'the measurement must be consulted exactly once before the machine is contacted');
  // THE FAIL-OPEN DIRECTION. If the gate stops routing on the measurement, a
  // host whose interpreter is not the reviewed one walks through to the
  // PowerShell step. The only acceptable answer here is the MACHINE refusal --
  // never RESOLVED, and never the toolchain refusal, which would mean the
  // measurement's verdict was ignored in the other direction.
  assert.notEqual(code, 'RESOLVED',
    'mutation `admit a machine that cannot exist` survived: the gate let a fabricated machine through');
  assert.equal(code, MACHINE_UNRESOLVED,
    `mutation \`ignore a passing measurement and refuse anyway\` survived: expected ${MACHINE_UNRESOLVED}, got ${code}`);
});

test('the two directions produce DIFFERENT codes, so the routing is live and not a constant', t => {
  const { file } = workerConfig(t);
  const thrown = codeOf(file, () => { throw new Error('Registered qualification toolchain blocked: x'); });
  const returned = codeOf(file, () => {});
  assert.notEqual(thrown, returned,
    'both directions produced the same code: the measurement is not routing anything');
  assert.deepEqual([thrown, returned].sort(), [MACHINE_UNRESOLVED, TOOLCHAIN_UNAPPROVED].sort());
});

test('the seam cannot admit anything: it resolves a machine or throws, and never returns a guest', t => {
  const { file } = workerConfig(t);
  // Handing in a no-op measurement buys nothing. There is no guest on this
  // path at all, which is why the seam is safe to export while
  // createDisposableGuest deliberately takes no measurement parameter.
  assert.throws(() => resolveQualificationMachineForTest(file, () => {}), error => error.code === MACHINE_UNRESOLVED);
  assert.throws(() => resolveQualificationMachineForTest(file), /explicit toolchain measurement/,
    'the seam must refuse an implicit measurement rather than silently using the real one');
});

test('a caller cannot inject a measurement into admission, however it is passed', async t => {
  // Behaviour, not arity: createDisposableGuest's one parameter is defaulted,
  // so its .length is 0 and counting it would assert nothing useful. What
  // matters is that extra arguments cannot reach the gate. A caller who passes
  // a no-op measurement must get exactly the refusal they would have got
  // without it -- otherwise admission has the public injection point that would
  // create in production the fail-open this file only simulates.
  const { createDisposableGuest } = await import('../lib/guest/disposable-guest.mjs');
  const { file } = workerConfig(t);
  const request = { product: 'toolsenabled', profile: 'windows-x64-standard',
    evidenceRoot: scratch(t), harnessRoot: scratch(t), runnerConfigPath: file,
    guestAgent: { mode: 'attested-disposable-guest', guestId: 'deadbeef-0000-4000-8000-000000000003' } };
  const outcome = async (...extra) => {
    try { await createDisposableGuest(request, ...extra); return 'ADMITTED'; }
    catch (error) { return error?.code ?? `UNCODED(${error?.constructor?.name})`; }
  };
  const plain = await outcome();
  const injected = await outcome({ measureToolchain: () => {} });
  const injectedBare = await outcome(() => {});
  assert.notEqual(plain, 'ADMITTED', 'setup: this request must refuse on its own');
  assert.equal(injected, plain,
    'mutation `let a caller inject the toolchain measurement into admission` survived: an options bag changed the outcome');
  assert.equal(injectedBare, plain,
    'mutation `let a caller inject the toolchain measurement into admission` survived: a bare second argument changed the outcome');
});
