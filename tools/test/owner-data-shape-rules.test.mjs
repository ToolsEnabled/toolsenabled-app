#!/usr/bin/env node
/* THE SHAPE RULES, TESTED AGAINST THE FILE THAT DECLARES THEM.
 *
 * The identity profile takes literal byte strings, which is right for an identity
 * and useless against an encoding. These seven rules are the CLASSES, and each one
 * has to satisfy two things that pull in opposite directions: fire on a real value,
 * and stay silent on the documented placeholder that stands in for it. A rule that
 * fails the second is worse than no rule, because the next reader learns to skim a
 * red output.
 *
 * The regexes are READ OUT OF check-no-owner-data.mjs rather than copied here. A
 * copy would drift, and a test that asserts a stale copy of a rule proves nothing
 * about the rule that runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-no-owner-data.mjs');
const source = fs.readFileSync(GATE, 'utf8');
const SHAPE = /SID|hostname|mailbox|URL|rganisation|launch or session/;
const rules = [...source.matchAll(/\{ label: "([^"]+)",\s*\n?(?:\s*\/\/[^\n]*\n)*\s*regex: (\/(?:[^/\\\n]|\\.)+\/[gim]*) \}/g)]
  .filter(match => SHAPE.test(match[1]))
  .map(match => [match[1], new RegExp(match[2].slice(1, match[2].lastIndexOf('/')), match[2].slice(match[2].lastIndexOf('/') + 1))]);

const MUST_FIRE = new Map([
  ['windows machine SID', '\x53-1-5-21-123456789-234567890-345678901-1001'],
  ['windows setup-random hostname', '\x44ESKTOP-A1B2C3D'],
  ['percent- or entity-encoded institutional mailbox', 'authuser=someone\x2540school.edu'],
  ['institutional mailbox', 'someone\x40school.edu'],
  ['institutional URL', '\x68ttps://auth.school.edu/cas/login'],
  // A .edu/.gov/.mil mailbox is the mailbox rule's, so it is counted once (check-no-owner-data.test.mjs).
  ['organisation name derived from a mailbox', '"person-da1d186c\x40fixture.invalid\'s Organization"'],
  ['account-scoped launch or session id', '\x6caunch_Synthetic94e97ad96391a5e00eade437'],
]);

// Every one of these is a real placeholder from these trees, or a real citation.
const MUST_NOT_FIRE = [
  '\x53-1-5-21-111111111-222222222-333333333-1001', 'S-1-5-18', 'S-1-5-32-544',
  '\x64esktop-session', '\x64esktop-archive', '\x64esktop-capture', '\x6captop-refusal',
  'student\x40example.edu', 'someone\x2540example.edu', 'x\x2540sub.example.edu',
  '\x68ttps://auth.example.edu/cas/login', '\x68ttps://lms.example.edu/courses/1',
  '"student\x40example.edu\'s Organization"',
  '\x6caunch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'launch_short',
  // Chromium's own identifiers, in the Electron executable every build ships.
  'cloned_install.\x73ession_start_last_detection_timestamp', '\x73ession_start_time_unix_epoch_millis',
  'https://nvlpubs.nist.gov/nistpubs/x.pdf',   // a citation, not an affiliation
  'a task-difficulty value', 'sk-difficulty',
];

// A node:test case, not bare top-level asserts: the runner reports a file with no
// test() of its own as one result with the FILE's ordinal, which the strict test
// ratchet then refuses as an out-of-order TAP stream (rehearsal 48-5, B37).
test('each shape rule fires on a real value and stays silent on every placeholder', () => {
  assert.equal(rules.length, MUST_FIRE.size,
    `expected ${MUST_FIRE.size} shape rules in check-no-owner-data.mjs, found ${rules.length}`);

  let assertions = 0;
  for (const [label, regex] of rules) {
    const positive = MUST_FIRE.get(label);
    assert.ok(positive !== undefined, `no positive case declared for the rule "${label}"`);
    regex.lastIndex = 0;
    assert.ok(regex.test(positive), `"${label}" did not fire on a real value: ${positive}`);
    assertions += 1;
    for (const benign of MUST_NOT_FIRE) {
      regex.lastIndex = 0;
      assert.equal(regex.test(benign), false, `"${label}" false-positives on ${benign}`);
      assertions += 1;
    }
  }
  console.log(`owner-data shape rules: ${assertions} assertions passed across ${rules.length} rules`);
});
