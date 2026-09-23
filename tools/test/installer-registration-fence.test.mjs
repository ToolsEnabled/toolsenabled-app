// /D= IS NOT A FENCE, AND THIS IS THE THIRD REASON WHY.
//
// Measured on the build machine 2026-08-23, by an agent that walked into it
// while setting up an ordinary lifecycle test: stale `ToolsEnabled Test 1.0.20`
// registry records were sitting in HKCU with their InstallLocation pointing at
// THE OWNER'S REAL RELEASE INSTALL ROOT, left behind by an older test build.
//
// electron-builder's `initMultiUser` resolves $INSTDIR from the existing
// registration for the GUID before the install section runs, and gives it
// precedence over `/D=`. So the next test-identity install would have landed in
// the real product's directory, and that build's uninstaller -- which does
// `RMDir /r $INSTDIR` -- would have deleted it.
//
// WHY THE OTHER TWO FENCES DID NOT CATCH IT, which is the part worth keeping:
// the derived GUID stops a test build COLLIDING with the release identity, and
// the successor guard in build/installer.nsh stops it claiming the release
// product's pre-rename data. Both are properties of the BUILD, and both are
// provable from source. This one is a property of the MACHINE. No test over the
// source can see it, so it has to be asked at the moment of use -- which is why
// the check is a command a lifecycle run must call, not a unit assertion.
//
// Everything here injects its registry reader. These tests must be able to fail
// for a real reason on a machine with no such registration, and must not pass
// merely because this particular computer happens to be clean today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  RELEASE_CHANNEL,
  deriveInstallIdentity,
  pathIsWithin,
  readInstallRegistration,
  registrationVerdict,
} from '../installer-identity.mjs';

const identity = (channel) => deriveInstallIdentity({
  appId: 'com.toolsenabled.desktop', productName: 'ToolsEnabled', version: '1.0.30', channel,
});

/* Real `reg query <key> /v InstallLocation` output, kept verbatim so a change
   in the tool's format shows up here rather than in a silent null. */
const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\bcf2eb9a-404d-5a33-91d2-441f04bcf924',
  '    InstallLocation    REG_SZ    C:\\Users\\someone\\AppData\\Local\\Temp\\scratch\\install',
  '',
  '',
].join('\r\n');

const registered = (location) => () => REG_OUTPUT.replace(
  'C:\\Users\\someone\\AppData\\Local\\Temp\\scratch\\install', location);
const absent = () => null;

const verdict = (channel, expectUnder, runner) => registrationVerdict(identity(channel), {
  expectUnder, runner, platform: 'win32', pathModule: path.win32,
});

// --- containment, where the obvious implementation is wrong -----------------

test('a sibling with a shared prefix is NOT inside', () => {
  /* The trap a string startsWith() falls into, and it fails OPEN: it would
     judge the real install "inside" a scratch root it merely shares letters
     with, and wave the install through. */
  assert.equal(pathIsWithin('C:\\Temp\\foobar', 'C:\\Temp\\foo', path.win32), false);
});

test('a directory is inside itself, and nesting is inside', () => {
  assert.equal(pathIsWithin('C:\\Temp\\foo', 'C:\\Temp\\foo', path.win32), true);
  assert.equal(pathIsWithin('C:\\Temp\\foo\\deep\\er', 'C:\\Temp\\foo', path.win32), true);
});

test('an escape upwards is not inside', () => {
  assert.equal(pathIsWithin('C:\\Temp\\foo\\..\\..\\Windows', 'C:\\Temp\\foo', path.win32), false);
});

test('a different drive is not inside', () => {
  assert.equal(pathIsWithin('D:\\Temp\\foo', 'C:\\Temp\\foo', path.win32), false);
});

// --- the verdict ------------------------------------------------------------

test('THE DEFECT: a registration outside the intended root refuses', () => {
  const v = verdict('test', 'C:\\Temp\\scratch', registered('C:\\Users\\someone\\AppData\\Local\\Programs\\toolsenabled'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'REGISTERED_OUTSIDE_EXPECTED');
  assert.match(v.message, /precedence over \/D=/,
    'the refusal must name the mechanism, or the next person removes the check instead of the registration');
  assert.match(v.message, /Programs\\toolsenabled/, 'it must say WHERE, so they can look before deleting');
});

test('a registration inside the intended root is allowed', () => {
  const v = verdict('test', 'C:\\Temp\\scratch', registered('C:\\Temp\\scratch\\install'));
  assert.equal(v.ok, true);
  assert.equal(v.code, 'REGISTERED_WITHIN_EXPECTED');
});

test('no registration at all is allowed, and says /D= decides', () => {
  const v = verdict('test', 'C:\\Temp\\scratch', absent);
  assert.equal(v.ok, true);
  assert.equal(v.code, 'NOT_REGISTERED');
});

test('an unstated intended root is refused rather than inspected', () => {
  /* Answering "registered somewhere" without a root to compare against would be
     an inspection dressed as a check, and it is exactly the shape that lets a
     person believe they ran a guard. */
  const v = verdict('test', null, registered('C:\\anywhere'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'EXPECTED_ROOT_REQUIRED');
});

test('the release channel is refused, because there the registration is correct', () => {
  const v = verdict(RELEASE_CHANNEL, 'C:\\Temp\\scratch', registered('C:\\anywhere'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'RELEASE_CHANNEL_NOT_CHECKABLE');
});

test('a non-Windows machine says so rather than reporting no registration', () => {
  /* "Could not look" must never read as "nothing there". That distinction is
     the whole value of the check. */
  const v = registrationVerdict(identity('test'), {
    expectUnder: 'C:\\Temp\\scratch', runner: absent, platform: 'linux', pathModule: path.win32,
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PLATFORM_UNSUPPORTED');
});

// --- the parser -------------------------------------------------------------

test('the real reg output shape is parsed, spaces in the path included', () => {
  const { registration } = readInstallRegistration('any-guid', {
    platform: 'win32',
    runner: registered('C:\\Program Files\\Some Product\\bin'),
  });
  assert.equal(registration.installLocation, 'C:\\Program Files\\Some Product\\bin');
});

/* THIS TEST USED TO PIN THE DEFECT, and it is worth saying exactly how, because
 * the mistake is subtle and this file made it while correcting the same mistake
 * elsewhere in the same session.
 *
 * It read: "an unparseable answer is treated as no registration, not as a
 * crash", and asserted `registration === null`. Every word of that was true of
 * the code. It was also the wrong property. `registration: null` is the ALLOW
 * path -- it means "nothing is registered, go ahead and install" -- so an answer
 * the parser did not recognise waved the install through. A localized `reg`
 * output, a truncated read, an access-denied, or any future change to the tool's
 * format would all take that path, and all of them are indistinguishable from
 * the stale registration this fence exists to catch.
 *
 * Found by an adversarial pass whose whole job was to ask "would this ever turn
 * red?". The answer for the real hazard was no.
 *
 * What is asserted now is that not-understood REFUSES. */
test('an answer the parser does not understand REFUSES rather than allowing', () => {
  const reading = readInstallRegistration('any-guid', {
    platform: 'win32', runner: () => 'FEHLER: Der angegebene Registrierungsschlüssel wurde nicht gefunden',
  });
  assert.equal(reading.unreadable, true, 'an unrecognised answer must be marked unreadable');
  assert.equal(reading.registration, null);

  const v = verdict('test', 'C:\\Temp\\scratch',
    () => 'FEHLER: Der angegebene Registrierungsschlüssel wurde nicht gefunden');
  assert.equal(v.ok, false, 'unknown must never be allowed to mean absent');
  assert.equal(v.code, 'REGISTRATION_UNREADABLE');
});

test('a genuine "no such key" is still allowed, and stays distinguishable', () => {
  /* The other half. If everything unrecognised refuses, the fence must still let
     a real absence through, or no isolated install could ever run. The runner
     returns null when the tool itself reported the key is absent. */
  const reading = readInstallRegistration('any-guid', { platform: 'win32', runner: () => null });
  assert.equal(reading.unreadable, false);
  assert.equal(reading.registration, null);
  assert.equal(verdict('test', 'C:\\Temp\\scratch', () => null).code, 'NOT_REGISTERED');
});
