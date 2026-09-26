// A REMEDY THAT CANNOT BE FOLLOWED FROM WHERE IT IS READ.
//
// A person can drive this computer from a browser on another device. The
// refusal vocabulary was written for the person at the keyboard, and
// readerRemedy() exists to re-read a stored desk sentence for that remote
// reader. Until 2026-08-23 it knew exactly TWO shapes: one literal and one
// regex.
//
// A desk-reader census measured what that covered by running the wrapper across
// the whole vocabulary rather than reading the call sites. Of 60 entries in
// REFUSAL_REMEDY, **seven** told a browser reader to close and reopen an
// application they are not sitting at, and passed through byte for byte:
// BRIDGE_OWN_LAYER_UNCONFIRMED, BRIDGE_UNAUTHORIZED, BRIDGE_TOKEN_INVALID,
// BRIDGE_REQUEST_FAILED, BRIDGE_REFUSED, DEVICE_CLAIM_BUSY and
// BRIDGE_AUDIT_UNAVAILABLE.
//
// THE PART WORTH REMEMBERING: every one of those call sites was already passing
// viaRelay. They looked repaired. The wrapper simply had nothing to say about
// those sentences, so "routed through readerRemedy" and "rewritten for a remote
// reader" were two different facts that read as one.
//
// This file closes the loop from BOTH ends, because either alone rots:
//   - a remedy that instructs a physical action AT the machine must have a twin;
//   - every declared twin must still match a live remedy, so that editing a desk
//     sentence cannot silently unhook its twin and restore the defect.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REFUSAL_REMEDY, REMOTE_TWIN_KEYS, readerRemedy } from '../../src/refusal-copy.js';
import { START_REFUSAL, startRefusalSentence } from '../../src/fleet-tree-copy.js';
import { UNAVAILABLE_TEXT, codexSetupInstructions } from '../../src/agent-availability-copy.js';
import { ENGINE_REASON, CODEX_SIGNED_OUT_FACT } from '../../src/local-activity.js';
import { EXTERNAL_CAPABILITIES, SUBJECTS } from '../../src/permission-guidance.js';
import { ACCOUNT_PANEL, PROVIDER_SIGN_IN } from '../../src/account-panel-copy.js';
import { LEDGER_UNREADABLE, QUESTIONS_UNREADABLE, KIND_UNREADABLE } from '../../src/ledger-copy.js';

/* SIX SOURCES NOW, AND MISSING ANY ONE OF THEM IS HOW EARLIER COUNTS CAME OUT
 * WRONG. The first pass linted REFUSAL_REMEDY alone and reported seven
 * defects; adding START_REFUSAL found four more, eleven in total. A wider
 * desk-reader census (2026-08-24) then ran every remaining reader-facing
 * source in this codebase through the same two questions -- does a physical
 * instruction reach a wrapped call site untranslated, and is any physical
 * instruction reaching the glass with NO call to readerRemedy at all -- and
 * found four more sources:
 *
 *   UNAVAILABLE_TEXT     src/agent-availability-copy.js, but NOT the table
 *                         itself -- ten of its codes are composed by
 *                         src/fleet-tree-copy.js startRefusalSentence() before
 *                         they ever reach views/computers.js's readerRemedy
 *                         call, so the composed sentence (prefix, capitalised
 *                         diagnosis and all) is what has to match, not the raw
 *                         table value. `unavailableTextViaStartRefusal` below
 *                         builds that composition once so the twins are keyed
 *                         to the string that is actually produced.
 *                         unavailableReason() is ALSO called directly, with no
 *                         prefix and no readerRemedy at all, from
 *                         src/views/agent.js and src/agent-session.js -- that
 *                         gap is real and is NOT closed by this file, because
 *                         no twin can fix a call site that never asks for one.
 *                         See the report for this pass.
 *   ENGINE_REASON         src/local-activity.js, read by the HOME screen --
 *                         the page every install lands on first. It was never
 *                         wrapped in readerRemedy at all, not even the
 *                         `viaRelay: true` decoration that made the first
 *                         seven look repaired; src/views/home.js now reads it.
 *   EXTERNAL_CAPABILITIES src/permission-guidance.js, read by
 *                         src/guided-step.js under every settings row that
 *                         needs Codex. The census ranked this first: it is not
 *                         a refusal, so nothing has to fail before a reader
 *                         meets it -- opening the disclosure is enough, on
 *                         every load.
 *   ACCOUNT_PANEL /       src/account-panel-copy.js, read by
 *   PROVIDER_SIGN_IN      src/views/guide.js -- the page every empty screen in
 *                         this product points at (src/first-run-needs.js
 *                         GUIDE_ACTION). PROVIDER_SIGN_IN's two physical
 *                         instructions are templated by program (Codex, Claude,
 *                         Gemini); `signInInstances` below instantiates all
 *                         three so the pattern in refusal-copy.js is checked
 *                         against what actually renders for each.
 *
 * So this list is the thing to extend when a NEXT source appears, not a
 * closed set. A lint that knows about six sources and stops looking is the
 * same mistake the two-shape whitelist made, one level up -- and that
 * prediction held: a seventh, eighth and ninth source (below) arrived on
 * 2026-08-25, found not by reading call sites again but by
 * tools/lib/desk-phrase-scan.mjs's whole-tree scan, which does not need a
 * name added to a list to catch the TENTH. Both guards run now: this file
 * proves a known source's twins are complete and correctly shaped; that scan
 * proves nothing DESK-SHAPED is hiding in a source nobody has named yet. */

/* The composed string views/computers.js's readerRemedy call actually sees for
   a code that falls through to UNAVAILABLE_TEXT -- built once here so the
   coverage walk below tests the real production, not the raw table. Every key
   of UNAVAILABLE_TEXT is walked: codes that never reach this path in practice
   (agent.js/agent-session.js-only codes) still produce a defined string here,
   and a physical instruction among THEM would be a reason to widen this
   comment, not a false positive -- the same sentence is what unavailableReason()
   would print unwrapped on those two surfaces if it were ever fixed to call
   readerRemedy. */
const unavailableTextViaStartRefusal = Object.fromEntries(
  Object.keys(UNAVAILABLE_TEXT).map(code => [code, startRefusalSentence({ ok: false, code }, {})]));

/* EXTERNAL_CAPABILITIES flattened to `${capabilityId}.step${index}` -> the
   step's `why`, the one field src/guided-step.js prints as prose beside a
   command. `do` fields are deliberately excluded: they are in-app actions
   ("Press Install, and when it finishes press Sign in") that work the same
   whether the app is being read locally or driven over the relay, because the
   press reaches the bridge on whichever computer is actually running -- so
   there is nothing in them for a remote twin to say differently. */
const externalCapabilitySteps = Object.fromEntries(
  Object.values(EXTERNAL_CAPABILITIES).flatMap(capability =>
    (capability.steps || [])
      .map((step, index) => [`${capability.id}.step${index}`, step.why])
      .filter(([, why]) => typeof why === 'string' && why.length > 0)));

/* PROVIDER_SIGN_IN's templated fields, instantiated for all three programs
   this page actually offers a Sign in button for (src/views/guide.js
   SIGN_IN_PROVIDERS), plus its plain string fields as they are. */
const signInInstances = Object.fromEntries(
  ['Codex', 'Claude', 'Gemini'].flatMap(program => [
    [`PROVIDER_SIGN_IN.lead(${program})`, PROVIDER_SIGN_IN.lead(program)],
    [`PROVIDER_SIGN_IN.opened(${program})`, PROVIDER_SIGN_IN.opened(program)],
  ]));

/* THE SEVENTH SOURCE (2026-08-25), and the one the six above do not read
 * UNAVAILABLE_TEXT the same way THIS reaches the glass. unavailableTextViaStartRefusal
 * above tests the COMPOSED form -- "Nothing was started. <Capitalized diagnosis>."
 * -- because that is what src/fleet-tree-copy.js startRefusalSentence() produces
 * before views/computers.js calls readerRemedy() on it. But
 * src/agent-availability-copy.js's own unavailableReason() is ALSO called
 * DIRECTLY, on the RAW lower-case fragment, from src/agent-session.js (five
 * call sites) and src/views/agent.js (the steering controls' result line and
 * the chat's own start-refusal composer) -- and until 2026-08-25 neither call
 * site read readerRemedy() at all, which this file's own note beside
 * unavailableTextViaStartRefusal named as a real, un-closed gap. Both files
 * now wrap the raw fragment (readerSafeReason() in agent-session.js,
 * readerSentence() in views/agent.js) BEFORE folding it into their own
 * `unavailable · `/`refused · ` prefix -- see src/refusal-copy.js's
 * UNAVAILABLE_TEXT-RAW block for the twins keyed to this exact (uncomposed)
 * table. */
const unavailableTextRaw = { ...UNAVAILABLE_TEXT };

/* THE EIGHTH SOURCE. src/ledger-copy.js's "could not be read" notices,
 * rendered by src/views/ledger.js straight into `register.innerHTML` with no
 * call to readerRemedy() at all until 2026-08-25 -- not "wrapped but
 * untranslated" like the tables above, just never wrapped, the exact shape
 * ENGINE_REASON was in before it got its own entry here. The register is fed
 * by the same three-way source (this copy, the relay, or the example fleet)
 * its own header comment names for its rows, so the failure path is exactly
 * as reachable over the relay as the success path is. */
const ledgerNotices = Object.freeze({ LEDGER_UNREADABLE: LEDGER_UNREADABLE.body, QUESTIONS_UNREADABLE: QUESTIONS_UNREADABLE.body, KIND_UNREADABLE: KIND_UNREADABLE.body });

/* THE NINTH SOURCE: two one-off literals composed inline rather than kept in
 * a table, found by tools/lib/desk-phrase-scan.mjs's whole-tree scan rather
 * than by reading call sites -- exactly the seventh-source risk this file's
 * own header warns about, arriving from a direction none of the eight named
 * sources above could have caught. */
const oneOffLiterals = Object.freeze({
  // src/mission-bridge.js createTerminateController(): a `remedy` OVERRIDE
  // passed to refusalSentence() for BRIDGE_IDEMPOTENCY_UNAVAILABLE, reaching
  // the glass through src/views/agent.js's terminate control, which now reads
  // readerRemedy on `state.message` beside the other steering controls there.
  BRIDGE_IDEMPOTENCY_UNAVAILABLE_remedy: 'No request was sent and nothing has been stopped. Close ToolsEnabled and open it again before pressing stop a second time.',
  // src/views/guide.js's provider-accounts lede: the call site already read
  // readerSentence() on it (unlike the two above), so this was the rarer
  // shape -- a wrapped call with no twin -- rather than an unwrapped call.
  // UPDATED for the fourth row (B-pool-3, local models): the desk text
  // gained a clause about a model on the reader's own hardware, which has no
  // sign-in at all. This literal has to be kept byte-for-byte equal to the
  // one src/views/guide.js actually renders and to the REMOTE_TWIN key in
  // src/refusal-copy.js -- an edit to any one of the three without the other
  // two is exactly the drift this "ninth source" entry exists to catch.
  guidePage_providerAccountsLede: 'An agent runs on one of these programs, or on a model already running on your own computer. Codex, Claude and Gemini are each a separate install with its own sign-in, and none of them is your ToolsEnabled account. ToolsEnabled never asks for those sign-ins and never keeps one. Each one below has two buttons: Install puts it on this computer, and Sign in opens a terminal window that signs you in. A model on this computer has no sign-in at all; its own section below explains what it needs instead.',
  // src/views/agent.js's own START_REFUSAL_TEXT, a small third table local to
  // that file's chat start-refusal composer (startRefusal()), kept separate
  // from UNAVAILABLE_TEXT because two of its three entries want different
  // wording for the same code than the shared table gives. Only this entry
  // carries a physical instruction.
  START_REFUSAL_TEXT_AGENT_ENGINE_UNAVAILABLE: 'This copy of the app cannot start agents: the agent engine is not part of this build. Reinstalling from a full download is what fixes it.',
  // src/views/computers.js START_NEEDS_APP_TEXT: the preview page's start
  // refusal, one desk literal translated through readerRemedy at its call
  // site. Was briefly an inline drivenComputerCopy(desk, remote) pair whose
  // remote arm the scan rightly refused (its wording sat outside the remote
  // vocabulary); collapsed onto the twin table 2026-08-25, and this entry is
  // what keeps the key live so the anti-drift half can hold it shut.
  computersPage_startNeedsApp: 'Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. Open ToolsEnabled on your computer to grow a real tree.',
});

const READER_FACING_TABLES = Object.freeze([
  ['Codex setup install instructions', Object.fromEntries(
    ['win32', 'unknown'].flatMap(platform => {
      const setup = codexSetupInstructions({ platform, viaRelay: false });
      return [setup.terminal, ...setup.install].map((text, index) => [`${platform}-${index}`, text]);
    }),
  )],
  ['REFUSAL_REMEDY', REFUSAL_REMEDY],
  ['START_REFUSAL', START_REFUSAL],
  ['UNAVAILABLE_TEXT (via startRefusalSentence)', unavailableTextViaStartRefusal],
  ['ENGINE_REASON', ENGINE_REASON],
  ['ENGINE_REASON (codexSignedOut fact)', { CODEX_SIGNED_OUT_FACT }],
  ['EXTERNAL_CAPABILITIES steps', externalCapabilitySteps],
  ['permission guidance subjects', {
    auditedConnectionWhatItDoes: EXTERNAL_CAPABILITIES['audited-connection'].whatItDoes,
    uninstallRetentionRisk: SUBJECTS.uninstall_data.risks[0],
  }],
  ['ACCOUNT_PANEL', ACCOUNT_PANEL],
  ['PROVIDER_SIGN_IN', signInInstances],
  ['UNAVAILABLE_TEXT (raw, via readerSafeReason/readerSentence)', unavailableTextRaw],
  ['ledger-copy.js notices', ledgerNotices],
  ['one-off literals', oneOffLiterals],
]);

/* Instructions that require hands on the machine. Deliberately NOT the whole
   desk vocabulary: these are unambiguous and carry no false positives, which is
   what lets this fail the build. The softer class is measured separately below
   rather than guessed at.
   EXPORTED so tools/desk-phrase-remote-twin scan, which walks src/ by pattern
   rather than by a hand-picked list of tables, can pin its own copy equal to
   this one instead of drifting from it -- see the drift-check test in
   tools/test/desk-phrase-remote-twin.test.mjs. `open ToolsEnabled(?!\.ai)`,
   not bare `open ToolsEnabled`, because that wider scan found a real false
   positive this file's eight tables never could: src/machine-tabs.js
   genuinely says "Open toolsenabled.ai in a browser", a link to the website,
   which a case-insensitive `open ToolsEnabled` reads as the same physical
   instruction as opening the desktop app. */
export const PHYSICAL_INSTRUCTION = /close the whole app|close ToolsEnabled|close the app|open a new terminal|open a terminal|open windows terminal|open ToolsEnabled(?!\.ai)|open it again|open it a second time|reinstall|terminal window|windows terminal|paste this line/i;

/* "open windows terminal" and "open ToolsEnabled" catch nothing extra TODAY --
   every sentence carrying them also says "open a new terminal" or "reinstall".
   They are here because the census counted FOUR independent phrasings of the
   same terminal instruction across four tables, so the next one will be worded
   differently from all of these, and a pattern that only matches the phrasings
   already fixed is a pattern that can only ever report zero.

   "terminal window", "windows terminal" (bare, no "open" in front) and "paste
   this line" were added in the same pass that added ACCOUNT_PANEL and
   PROVIDER_SIGN_IN below, and the mutation check for that pass is the reason
   they are here rather than assumed covered: a twin was DELIBERATELY reduced
   to a no-op copy of its own desk sentence -- "Sign in opens a terminal
   window ... You finish it there" -- and every test in this file still passed,
   because nothing in the pattern above matched "opens a terminal window" or
   "paste this line into Windows Terminal" at all. The gap was in the lint, not
   the fix; RUN IT caught it before the fix did. */

/* A sentence written for somebody elsewhere has to say whose computer it means
   or where they are acting from. Anything else is the same instruction with the
   subject still missing. */
const ADDRESSES_A_REMOTE_READER = /that computer|from here/i;

/* SENTENCES THAT ALREADY SPEAK TO A READER WHO IS ELSEWHERE, found while
   widening this file to six sources (2026-08-24): MC_AGENT_PRINCIPAL_READ_ONLY
   is raised ONLY when a browser without permission tries to drive a computer
   over the relay -- there is no desk reading of it, because a person standing
   at the keyboard already holds the permission this refusal is about -- so its
   remedy was written "On that computer, open ToolsEnabled..." from the start.
   readerRemedy leaving it unchanged under viaRelay is therefore correct, not a
   gap: a twin would have nothing left to change it TO.
   Named explicitly rather than detected by pattern (matching
   ADDRESSES_A_REMOTE_READER, say), so a sentence that mixes a genuine desk-only
   instruction with an incidental "that computer" elsewhere cannot slip through
   the same door unnoticed. */
const ALREADY_REMOTE_SHAPED = new Set([
  'UNAVAILABLE_TEXT (via startRefusalSentence).MC_AGENT_PRINCIPAL_READ_ONLY',
  // Same code, same text, read RAW rather than composed (the seventh source,
  // 2026-08-25) -- the exemption is about the SENTENCE, which does not
  // change between the two readings, so it needs the same name twice.
  'UNAVAILABLE_TEXT (raw, via readerSafeReason/readerSentence).MC_AGENT_PRINCIPAL_READ_ONLY',
]);

/* Every reader-facing sentence in every table, labelled by table so a failure
   says where to go. */
const remedies = () => READER_FACING_TABLES.flatMap(([table, entries]) =>
  Object.entries(entries)
    .filter(([, s]) => typeof s === 'string')
    .map(([key, s]) => [`${table}.${key}`, s]));

test('every remedy that asks for hands on the machine has a remote twin', () => {
  const missing = [];
  for (const [code, sentence] of remedies()) {
    if (ALREADY_REMOTE_SHAPED.has(code)) continue;
    if (!PHYSICAL_INSTRUCTION.test(sentence)) continue;
    if (readerRemedy(sentence, { viaRelay: true }) !== sentence) continue;
    missing.push(code);
  }
  assert.deepEqual(missing, [],
    'these tell a browser reader to do something at a computer they are not at, and readerRemedy leaves them unchanged');
});

test('a remote twin actually speaks to somebody who is elsewhere', () => {
  /* Guards the fix that is not a fix: pairing a desk sentence with a near-copy
     of itself would satisfy the test above while changing nothing for the
     person reading it. */
  for (const [code, sentence] of remedies()) {
    if (ALREADY_REMOTE_SHAPED.has(code)) continue;
    if (!PHYSICAL_INSTRUCTION.test(sentence)) continue;
    const remote = readerRemedy(sentence, { viaRelay: true });
    assert.match(remote, ADDRESSES_A_REMOTE_READER,
      `${code}: the remote reading must name that computer or say "from here"`);
  }
});

test('every ALREADY_REMOTE_SHAPED entry earns its exemption', () => {
  /* The exemption above is a claim -- "this sentence already addresses a
     remote reader, so leaving it unchanged is correct" -- and a claim in a
     test file rots exactly like one in a comment unless something checks it.
     Two things must both be true of every name in that set: it still exists
     as a live sentence (an edit elsewhere did not orphan it, the same anti-
     drift rule REMOTE_TWIN_KEYS is held to below), and it still reads as
     already addressing somebody elsewhere without readerRemedy's help. */
  const live = new Map(remedies());
  for (const code of ALREADY_REMOTE_SHAPED) {
    assert.ok(live.has(code), `${code}: no longer a live sentence in any reader-facing source`);
    assert.match(live.get(code), ADDRESSES_A_REMOTE_READER,
      `${code}: no longer names "that computer" or "from here" on its own -- the exemption no longer holds`);
  }
});

test('nothing is rewritten for a reader who is at the desk', () => {
  /* The other direction, and the cheaper mistake: a twin that leaked into the
     default path would tell the person at the keyboard to go to "that
     computer", meaning the one they are sitting at. */
  for (const [code, sentence] of remedies()) {
    assert.equal(readerRemedy(sentence, { viaRelay: false }), sentence, code);
    assert.equal(readerRemedy(sentence), sentence, code);
  }
});

test('every declared twin still matches a live remedy', () => {
  /* THE ANTI-DRIFT HALF. The table is keyed by the desk sentence, so editing
     that sentence anywhere unhooks its twin -- silently, and the defect comes
     straight back. This turns that into a failing test instead. RESTART_REMEDY
     is shared by a whole family and is reached through them, so a key is
     satisfied by appearing as ANY remedy value. */
  const live = new Set(remedies().map(([, s]) => s));
  const orphaned = REMOTE_TWIN_KEYS.filter((key) => !live.has(key));
  assert.deepEqual(orphaned, [],
    'a twin is keyed to a sentence no remedy uses any more; the desk text was edited and this was not');
});

test('the softer "this computer" class is not growing', () => {
  /* NOT A FAILURE, AND NOT INVENTED HERE EITHER. Bare "this computer" mentions
     point at the machine without instructing anybody to physically act on
     it -- accurate at the desk, ambiguous in a browser, but followable in a
     way the physical-instruction class above is not. They are left alone ON
     PURPOSE: a mechanical swap to "that computer" is known to be WRONG for
     neighbouring strings that really do describe the browser (the tree store,
     the chatbox settings, both held in this page's own localStorage rather
     than on the machine being driven), so each needs deciding per string
     rather than in a sweep.

     THE NUMBER IS 37 AND NOT 26, and it is pure double-counting, not new
     debt. This test walked two tables and found twelve, then six and found
     twenty-six; it now walks nine -- see READER_FACING_TABLES above -- and
     the +11 is the SAME eleven UNAVAILABLE_TEXT codes the bullets below
     already clear, counted a second time: MC_AGENT_PRINCIPAL_READ_ONLY,
     MC_AGENT_PROFILE_UNKNOWN, AGENT_TIER_NO_LAUNCHER, the four
     AGENT_CONFINEMENT_ codes, and the three SETUP_ codes. "UNAVAILABLE_TEXT
     (raw, via readerSafeReason/readerSentence)" walks the RAW table those
     eleven already had an entry in; "UNAVAILABLE_TEXT (via
     startRefusalSentence)" walks the COMPOSED form of the identical table.
     Nothing about any of them changed with the prefix stripped, so the same
     reasoning in the bullets covers both readings. The three FULLY new
     sources this pass added -- ledger-copy.js's two notices and the
     mission-bridge.js / views/guide.js / views/agent.js one-off literals --
     contributed ZERO entries here, because every physical-instruction-bearing
     string among them got a real REMOTE_TWIN instead of being left in this
     softer class:
       - the UNAVAILABLE_TEXT entries, composed or raw, either name an IN-APP
         destination as their remedy ("Open the fleet overview and choose a
         folder again", "Choose the level again in Settings" -- a navigation
         that works the same whether this page is local or driven over the
         relay) or are MC_AGENT_PRINCIPAL_READ_ONLY, which is already in
         ALREADY_REMOTE_SHAPED above and carries a genuine "this computer"
         only in its diagnosis clause, never in its remedy;
       - EXTERNAL_CAPABILITIES steps.audited-connection.step1 ("Nothing
         outside this computer is involved, so there is nothing to sign in
         to") is reassurance about what the step does NOT reach, not an
         instruction to go anywhere;
       - ACCOUNT_PANEL.none and .activeNote describe which Codex/Claude
         sign-in this INSTALLATION is using -- state that genuinely lives on
         the computer being described, the opposite of the browser-storage
         trap this class exists to catch, so "this computer" is the right
         word already.

     What this pins is that the number does not grow further while nobody is
     looking, on top of the widening this pass already accounted for. */
  const deictic = remedies().filter(([, s]) =>
    /\bthis computer\b/i.test(s) && readerRemedy(s, { viaRelay: true }) === s);
  assert.ok(deictic.length <= 37,
    `bare "this computer" remedies with no remote reading rose to ${deictic.length}: ${deictic.map(([c]) => c).join(', ')}`);
});
