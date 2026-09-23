#!/usr/bin/env node
'use strict';
/**
 * Reference-resolver tests.
 *
 * Half of these assert that the resolver does NOT fire. That is the point: a
 * false positive silently edits the paper, so every case where it should stay
 * out of the way is as important as every case where it should act.
 *
 * Run: node test/test_resolve.js
 */

const { resolveAcceptance } = require('../resolve');

const P = { options: [
  { id: 'A', text: 'The benchmark saturates on determinate prompts.' },
  { id: 'B', text: 'On the 3 of 20 prompts that were determinate, every model scored perfectly.' },
  { id: 'C', text: 'Models score perfectly where the prompt pins the answer, which is 3 of 20 tasks.' },
] };

const PASS = [], FAIL = [];
function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
}
function expect(text, kind, optionId) {
  const r = resolveAcceptance(text, P);
  const ok = r.kind === kind && (optionId === undefined || r.optionId === optionId);
  check(`${JSON.stringify(text)} -> ${kind}${optionId ? ' ' + optionId : ''}`, ok,
    ok ? '' : `got ${r.kind}${r.optionId ? ' ' + r.optionId : ''} (${r.why})`);
  return r;
}

console.log('\n[plain acceptance]');
expect('B', 'accept', 'B');
expect('b', 'accept', 'B');
expect('option B', 'accept', 'B');
expect("let's say B", 'accept', 'B');
expect('lets go with C', 'accept', 'C');
expect('use A', 'accept', 'A');
expect('the second one', 'accept', 'B');
expect('the first', 'accept', 'A');
expect('2', 'accept', 'B');
expect('take the third', 'accept', 'C');
expect('the last one', 'accept', 'C');
expect('yes, B', 'accept', 'B');
expect('I like B', 'accept', 'B');
expect('give me the second one', 'accept', 'B');

console.log('\n[acceptance with a change goes to the agent, never applied locally]');
const m1 = expect('B but drop the second clause', 'modify', 'B');
check('  the whole instruction is carried over', /drop the second clause/.test(m1.modification || ''), m1.modification);
expect('B but shorter', 'modify', 'B');
expect("let's say the second one but without the number", 'modify', 'B');
expect('C but combine it with A', 'modify', 'C');
expect('the first one, but make it stronger', 'modify', 'A');
expect('A plus the caveat', 'modify', 'A');
expect('use B and trim it', 'modify', 'B');

console.log('\n[dismissal]');
expect('none of those', 'dismiss');
expect('neither', 'dismiss');
expect('none', 'dismiss');
expect('scrap that', 'dismiss');
expect('try something else', 'dismiss');
expect('no thanks', 'dismiss');

console.log('\n[it must NOT fire: these are ordinary messages]');
// Each of these contains something that naively looks like an option reference.
expect('what does the paper say about determinacy', 'none');
expect('can you read the introduction and tell me if it overstates the claim', 'none');
expect('the benchmark saturates because the prompts are determinate', 'none');
expect('a lot of these numbers came from the audit, can you check them', 'none');
expect('I think we should reword the whole methodology section carefully', 'none');
expect('add a sentence about the judge disagreement to the discussion', 'none');
expect('', 'none');
expect('what did we actually do in the second study', 'none');
expect('go read paragraph 2 and summarize it for me please', 'none');
expect('not B', 'none');
expect("don't use B", 'none');
expect('never the second one', 'none');

console.log('\n[edge cases]');
check('no proposal open -> none', resolveAcceptance('B', null).kind === 'none');
check('empty options -> none', resolveAcceptance('B', { options: [] }).kind === 'none');
check('reference beyond the option count -> none',
  resolveAcceptance('the fourth one', P).kind === 'none',
  resolveAcceptance('the fourth one', P).kind);
const two = { options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }] };
check('"the last one" with 2 options picks B',
  resolveAcceptance('the last one', two).optionId === 'B');
check('punctuation does not break it', resolveAcceptance('B.', P).kind === 'accept');
check('trailing whitespace does not break it', resolveAcceptance('  B  ', P).kind === 'accept');
check('curly quotes are normalized',
  resolveAcceptance('“let’s say B”', P).kind === 'accept',
  resolveAcceptance('“let’s say B”', P).kind);

console.log('\n[the "a" trap, specifically]');
// The article "a" is also an option id. These are the whole difficulty, and the
// first version of the resolver got the last three of them wrong.
expect('A plus the caveat', 'modify', 'A');
expect('A', 'accept', 'A');
expect('a few of these numbers should change', 'none');
expect('a lot of these came from the audit, can you check them', 'none');
expect('add a sentence about the judge disagreement', 'none');

console.log('\n[the asymmetry is respected]');
// Anything the resolver is unsure about must go to the agent, not to the paper.
const risky = [
  'the claim in B is wrong, we never measured that',
  'B is not what the audit found',
  'compare A and C for me',
  'why did you suggest a third option',
];
let leaked = 0;
for (const r of risky) {
  const res = resolveAcceptance(r, P);
  if (res.kind === 'accept') { leaked++; console.log(`    LEAK: ${JSON.stringify(r)} -> accept ${res.optionId}`); }
}
check('no ambiguous message resolves straight to an edit', leaked === 0, `${leaked} leaked`);

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
process.exit(FAIL.length ? 1 : 0);
