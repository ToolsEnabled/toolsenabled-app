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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-no-owner-data.mjs');
const source = fs.readFileSync(GATE, 'utf8');
const SHAPE = /SID|hostname|mailbox|URL|rganisation|launch or session/;
const rules = [...source.matchAll(/\{ label: "([^"]+)",\s*\n?(?:\s*\/\/[^\n]*\n)*\s*regex: (\/(?:[^/\\\n]|\\.)+\/[gim]*) \}/g)]
  .filter(match => SHAPE.test(match[1]))
  .map(match => [match[1], new RegExp(match[2].slice(1, match[2].lastIndexOf('/')), match[2].slice(match[2].lastIndexOf('/') + 1))]);

// Synthetic positives, assembled at run time: this file ships in the source tree
// the gate scans, and a literal positive would be reported there as a finding.
const SCHOOL = ['school', 'edu'].join('.');
const MUST_FIRE = new Map([
  ['windows machine SID', ['S-1-5-21', '1234567890', '2345678901', '3456789012', '1001'].join('-')],
  ['windows setup-random hostname', ['desktop', 'ab12cd3'].join('-')],
  ['percent- or entity-encoded institutional mailbox', `authuser=someone%40${SCHOOL}`],
  ['institutional mailbox', `someone@${SCHOOL}`],
  ['institutional URL', `https://auth.${SCHOOL}/cas/login`],
  // A .edu/.gov/.mil mailbox is the mailbox rule's, so it is counted once (check-no-owner-data.test.mjs).
  ['organisation name derived from a mailbox', `"someone@${['mail', 'co'].join('.')}'s Organization"`],
  ['account-scoped launch or session id', ['launch', 'Synthetic0Id1For2The3Rule4Only5'].join('_')],
]);

// Every one of these is a real placeholder from these trees, or a real citation.
const MUST_NOT_FIRE = [
  'S-1-5-21-111111111-222222222-333333333-1001', 'S-1-5-18', 'S-1-5-32-544',
  'desktop-session', 'desktop-archive', 'desktop-capture', 'laptop-refusal',
  'student@example.edu', 'someone%40example.edu', 'x%40sub.example.edu',
  'https://auth.example.edu/cas/login', 'https://lms.example.edu/courses/1',
  '"student@example.edu\'s Organization"',
  'launch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'launch_short',
  // Chromium's own identifiers, in the Electron executable every build ships.
  'cloned_install.session_start_last_detection_timestamp', 'session_start_time_unix_epoch_millis',
  'https://nvlpubs.nist.gov/nistpubs/x.pdf',   // a citation, not an affiliation
  'a task-difficulty value', 'sk-difficulty',
];

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
