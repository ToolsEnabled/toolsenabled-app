// BEHAVIOURAL TESTS FOR THE UNINSTALL DATA-RETENTION POLICY.
//
// The defect these exist to catch is not a crash. It is a silence: uninstalling
// kept 92 files and 11.87 MB of the person's data -- the credential vault, the
// signed audit ledger, the action log -- with nobody asked and nothing said.
//
// So the assertions below are weighted towards ABSENCE, deliberately and
// disproportionately. Every way of knowing nothing (no file, empty file,
// whitespace, unknown token, unreadable file, wrong type, no directory) gets its
// own case, and each asserts the SAME thing: the answer is `ask`, and it is not
// `keep`. That is the recurring defect in this codebase -- a missing value read
// as consent -- and here consent would mean keeping a stranger's credentials.
//
// A test that only checked the two happy paths would pass against the defective
// build, because the defective build also keeps data when told to keep data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const retention = require(join(REPO, 'shell', 'uninstall-retention.cjs'));
const adoption = require(join(REPO, 'shell', 'userdata-adoption.cjs'));

const {
  CHOICE_KEEP,
  CHOICE_REMOVE,
  CHOICE_ASK,
  POLICY_FILE,
  DECLARATION_FILE,
  RETENTION_PREF_KEY,
  DEVICE_READ_FAILED,
  IDENTITY_READ_FAILED,
  PARTITION_READ_FAILED,
  mirrorRetentionChoice,
  resolveChoice,
  readRecordedChoice,
  recordChoice,
  syncRecordedChoice,
  inventory,
  describeRetention,
  writeDeclaration,
} = retention;

function withUserData(run) {
  const root = mkdtempSync(join(tmpdir(), 'te-retention-'));
  const userDataDir = join(root, 'ToolsEnabled');
  mkdirSync(userDataDir, { recursive: true });
  try {
    return run({ root, userDataDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ABSENCE. Every one of these must be a question, never a silent keep.
// ---------------------------------------------------------------------------

test('a policy file that was never written resolves to ask, not keep', () => {
  withUserData(({ userDataDir }) => {
    const result = readRecordedChoice({ userDataDir });
    assert.equal(result.choice, CHOICE_ASK);
    assert.equal(result.decided, false);
    assert.notEqual(result.choice, CHOICE_KEEP, 'absence must never resolve to keeping the data');
  });
});

for (const [label, contents] of [
  ['an empty policy file', ''],
  ['a whitespace-only policy file', '   \r\n\t '],
  ['a policy file holding an unknown token', 'maybe-later\n'],
  ['a policy file from a newer build', 'remove-everything-except-credentials\n'],
]) {
  test(`${label} resolves to ask, not keep`, () => {
    withUserData(({ userDataDir }) => {
      writeFileSync(join(userDataDir, POLICY_FILE), contents, 'utf8');
      const result = readRecordedChoice({ userDataDir });
      assert.equal(result.choice, CHOICE_ASK, `${label} must resolve to ask`);
      assert.equal(result.decided, false);
      assert.notEqual(result.choice, CHOICE_KEEP);
      assert.notEqual(result.choice, CHOICE_REMOVE, `${label} must not be treated as a removal instruction`);
    });
  });
}

test('a non-string value resolves to ask rather than throwing or defaulting', () => {
  for (const value of [undefined, null, 0, false, {}, [], NaN]) {
    const result = resolveChoice(value);
    assert.equal(result.choice, CHOICE_ASK, `${String(value)} must resolve to ask`);
    assert.equal(result.decided, false);
  }
});

// AN UNREADABLE CHOICE IS NOT AN ABSENT ONE, and both are questions.
//
// This is the case a real machine produces and a fixture usually does not: the
// file is there, holds a decision, and cannot be opened because something has it
// locked. Reading that as "no choice" is survivable; reading it as "keep" would
// be the defect wearing a different hat, so it is asserted explicitly.
test('a policy file that cannot be read resolves to ask and says so, without claiming none exists', () => {
  const failingFs = {
    readFileSync() {
      const error = new Error('locked');
      error.code = 'EACCES';
      throw error;
    },
  };
  const result = readRecordedChoice({ userDataDir: 'C:\\nowhere', fs: failingFs });
  assert.equal(result.choice, CHOICE_ASK);
  assert.equal(result.decided, false);
  assert.equal(result.readError, 'EACCES');
  assert.match(result.reason, /could not be read/);
  assert.doesNotMatch(
    result.reason,
    /no choice has been recorded/,
    'an unreadable file must not be reported as "you have not chosen yet" -- the person would ' +
      'make a choice that the unread one then overrides'
  );
});

test('an empty or missing user-data directory resolves to ask', () => {
  for (const userDataDir of ['', '   ', undefined, null]) {
    const result = readRecordedChoice({ userDataDir });
    assert.equal(result.choice, CHOICE_ASK);
    assert.equal(result.decided, false);
  }
});

// ---------------------------------------------------------------------------
// RECORDED DECISIONS are honoured exactly.
// ---------------------------------------------------------------------------

test('a recorded decision is honoured, through a CRLF and casing round trip', () => {
  withUserData(({ userDataDir }) => {
    for (const [written, expected] of [
      ['keep-my-data\n', CHOICE_KEEP],
      ['remove-everything\n', CHOICE_REMOVE],
      ['keep-my-data\r\n', CHOICE_KEEP],
      ['  REMOVE-EVERYTHING  \r\n', CHOICE_REMOVE],
    ]) {
      writeFileSync(join(userDataDir, POLICY_FILE), written, 'utf8');
      const result = readRecordedChoice({ userDataDir });
      assert.equal(result.choice, expected, `${JSON.stringify(written)} should resolve to ${expected}`);
      assert.equal(result.decided, true);
    }
  });
});

test('recordChoice writes exactly one token and nothing else', () => {
  withUserData(({ userDataDir }) => {
    const result = recordChoice({ userDataDir, choice: CHOICE_REMOVE });
    assert.equal(result.ok, true);
    const raw = readFileSync(join(userDataDir, POLICY_FILE), 'utf8');
    assert.equal(raw, 'remove-everything\n', 'the uninstaller reads one line; anything else is a parsing risk');
  });
});

test('recordChoice refuses a token the uninstaller would not understand', () => {
  withUserData(({ userDataDir }) => {
    for (const bad of ['delete-some', '', null, 42]) {
      const result = recordChoice({ userDataDir, choice: bad });
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(
      existsSync(join(userDataDir, POLICY_FILE)),
      false,
      'a refused choice must not leave a file the uninstaller will act on'
    );
  });
});

// ---------------------------------------------------------------------------
// THE MIRROR. The destructive direction is the one that must not survive a
// withdrawn decision.
// ---------------------------------------------------------------------------

test('switching away from "remove everything" clears the file rather than leaving it to fire', () => {
  withUserData(({ userDataDir }) => {
    assert.equal(syncRecordedChoice({ userDataDir, value: CHOICE_REMOVE }).ok, true);
    assert.equal(existsSync(join(userDataDir, POLICY_FILE)), true, 'precondition: the decision was recorded');

    // The settings page removes the stored key when the person selects the
    // default, so this is what a switch back to "ask me" actually looks like.
    const result = syncRecordedChoice({ userDataDir, value: undefined });
    assert.equal(result.ok, true);
    assert.equal(
      existsSync(join(userDataDir, POLICY_FILE)),
      false,
      'a withdrawn "remove everything" must not stay on disk -- it would delete the data at ' +
        'uninstall on a decision the person had already reversed'
    );
    assert.equal(readRecordedChoice({ userDataDir }).choice, CHOICE_ASK);
  });
});

test('mirroring "ask" leaves no file, so absence and ask are one state', () => {
  withUserData(({ userDataDir }) => {
    const result = syncRecordedChoice({ userDataDir, value: CHOICE_ASK });
    assert.equal(result.ok, true);
    assert.equal(
      existsSync(join(userDataDir, POLICY_FILE)),
      false,
      'writing a literal "ask" token would create a second representation of "no decision"'
    );
  });
});

test('clearing when nothing was ever recorded is not an error', () => {
  withUserData(({ userDataDir }) => {
    assert.equal(syncRecordedChoice({ userDataDir, value: undefined }).ok, true);
  });
});

test('a busy account partition is reported, and never leaves the destructive token armed', () => {
  withUserData(({ userDataDir }) => {
    const accountId = 'a'.repeat(32);
    const prefs = { snapshot: () => ({ values: {} }) };
    const current = () => ({ signedIn: true, account: { id: accountId } });
    const arm = () => assert.equal(syncRecordedChoice({ userDataDir, value: CHOICE_REMOVE }).ok, true);
    const recorded = () => readRecordedChoice({ userDataDir }).choice;

    /* THIS TEST ASKED FOR THE OPPOSITE UNTIL 2026-08-27, AND THE REVERSAL IS
       WORTH READING BEFORE ANYONE FLIPS IT BACK.
       It required the recorded token to SURVIVE a read failure, on the ground
       that unlinking would latch a momentary EMFILE as `ask`. Meanwhile
       uninstall-retention-account-scope.test.mjs required the SAME INPUT to
       CLEAR it, on the ground that we cannot tell whose answer applies. Two
       lanes, identical input, opposite assertions, neither aware of the other;
       the module could only satisfy one, and the full chain is what finally put
       them in the same run.
       Clearing wins on the single axis that decides -- which mistake can be
       taken back. Leaving it armed can RMDir /r a machine's product data on a
       decision nobody can confirm still applies, and the token is device-scoped
       while accounts are per-person. The cost of clearing is stated rather than
       buried: build/installer.nsh:185 KEEPS the data on a silent uninstall with
       no policy file, so somebody who armed a wipe and hit one transient errno
       keeps data on a machine they meant to clear. That is the reversible
       failure, and it is chosen on purpose.
       The original worry is answered rather than dismissed: nothing latches,
       because the next successful read rewrites the token and the mirror runs on
       every settings write and on sign-in. The `reads` counters below are what
       hold that -- a could-not-tell result must be re-asked, never cached. */

    let reads = 0;
    const busy = {
      current,
      getSetting() {
        reads += 1;
        const error = new Error('too many open files');
        error.code = 'EMFILE';
        throw error;
      },
    };

    arm();
    const failed = mirrorRetentionChoice({ userDataDir, prefs, account: busy });
    assert.equal(failed.code, PARTITION_READ_FAILED);
    assert.equal(failed.cause, 'EMFILE');
    assert.equal(failed.disarmed, true, 'a withdrawal must say so, or the caller cannot tell it happened');
    assert.match(failed.reason, /not claiming that no choice exists/);
    assert.equal(reads, 1, 'the failed read is attempted and not cached');
    assert.equal(recorded(), CHOICE_ASK,
      'ignorance must not leave "remove everything" armed -- deleting a vault on an answer nobody ' +
      'could confirm is the one failure here that cannot be undone');
    mirrorRetentionChoice({ userDataDir, prefs, account: busy });
    assert.equal(reads, 2, 'a could-not-tell result must be retried, not cached for the process');

    /* CONTROL. Clearing must be reached by the destructive token only. A guard
       that unlinked whatever it found would satisfy every assertion above while
       making an ordinary "keep my data" answer evaporate on any busy read. */
    assert.equal(syncRecordedChoice({ userDataDir, value: CHOICE_KEEP }).ok, true);
    const keptThrough = mirrorRetentionChoice({ userDataDir, prefs, account: busy });
    assert.equal(keptThrough.ok, false, 'nothing was withdrawn, so this is a plain read failure');
    assert.equal(recorded(), CHOICE_KEEP,
      'a non-destructive answer is left exactly where it is; writing `ask` over it would latch a ' +
      'transient as a decision and make the person answer again for nothing');

    arm();
    const returnedFailure = { current, getSetting: () => ({ ok: false, code: 'ACCOUNT_DATA_UNREADABLE' }) };
    const refused = mirrorRetentionChoice({ userDataDir, prefs, account: returnedFailure });
    assert.equal(refused.code, PARTITION_READ_FAILED);
    assert.equal(refused.cause, 'ACCOUNT_DATA_UNREADABLE');
    assert.equal(recorded(), CHOICE_ASK,
      'the account API returns read failures as values; those values must not be read as an answer');

    for (const [label, errorCode, brokenPrefs, brokenAccount] of [
      ['device preferences', DEVICE_READ_FAILED, { snapshot() { throw 'busy'; } }, busy],
      ['account identity', IDENTITY_READ_FAILED, prefs, { current() { throw 'busy'; } }],
    ]) {
      arm();
      const result = mirrorRetentionChoice({ userDataDir, prefs: brokenPrefs, account: brokenAccount });
      assert.equal(result.code, errorCode, `${label} failure needs its own could-not-tell code`);
      assert.equal(result.cause, 'unknown', 'a non-Error throw must remain a read failure');
      assert.equal(recorded(), CHOICE_ASK,
        `${label} failure must not leave the destructive decision armed either`);
    }

    arm();
    const absent = { current, getSetting: () => ({ ok: true, value: undefined }) };
    const cleared = mirrorRetentionChoice({ userDataDir, prefs, account: absent });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.disarmed, undefined,
      'control: this cleared because a SUCCESSFUL read proved absence, which is a different fact ' +
      'from a withdrawal and must not be reported as one');
    assert.equal(existsSync(join(userDataDir, POLICY_FILE)), false);
  });
});

// ---------------------------------------------------------------------------
// THE INVENTORY AND THE COPY. What the person is shown must be measured.
// ---------------------------------------------------------------------------

test('the inventory counts what is really there and names the consequences', () => {
  withUserData(({ userDataDir }) => {
    mkdirSync(join(userDataDir, 'capability', 'vault'), { recursive: true });
    mkdirSync(join(userDataDir, 'capability', 'state'), { recursive: true });
    mkdirSync(join(userDataDir, 'Cache'), { recursive: true });
    writeFileSync(join(userDataDir, 'capability', 'vault', 'secrets.json'), 'x'.repeat(2804));
    writeFileSync(join(userDataDir, 'capability', 'state', 'audit.sqlite3'), 'y'.repeat(61440));
    writeFileSync(join(userDataDir, 'Cache', 'data_0'), 'z'.repeat(1000));

    const report = inventory({ userDataDir });
    assert.equal(report.present, true);
    assert.equal(report.files, 3, 'the cache file is real data on the disk and is counted');
    assert.equal(report.bytes, 2804 + 61440 + 1000);

    const named = report.named.map((entry) => entry.rel.replace(/\\/g, '/'));
    assert.ok(named.includes('capability/vault/secrets.json'), 'the vault must be named');
    assert.ok(named.includes('capability/state/audit.sqlite3'), 'the audit ledger must be named');

    const sentence = describeRetention(report);
    assert.match(sentence, /your saved credentials/, sentence);
    assert.match(sentence, /signed record of every action taken/, sentence);
    assert.doesNotMatch(sentence, /Cache|GPUCache/, 'browser cache is counted but is not a thing anyone decides about');
  });
});

test('an unreadable data directory is not reported as containing no saved data', () => {
  const error = new Error('access denied');
  error.code = 'EACCES';
  const report = inventory({
    userDataDir: 'C:\\Users\\person\\AppData\\Roaming\\ToolsEnabled',
    fs: { statSync() { throw error; } },
  });

  assert.equal(report.complete, false);
  assert.match(describeRetention(report), /could be inspected/);
  assert.doesNotMatch(describeRetention(report), /There is no saved data/);
});

test('an inventory of a machine with no saved data says so plainly', () => {
  withUserData(({ root }) => {
    const absent = join(root, 'never-existed');
    const report = inventory({ userDataDir: absent });
    assert.equal(report.present, false);
    assert.equal(report.files, 0);
    assert.match(describeRetention(report), /no saved data/i);
  });
});

// A SYMLINK OUT OF THE TREE MUST NOT BE COUNTED, because the same list drives
// the removal. Counting it would over-report; acting on it would delete files
// the person never put in this directory.
test('the inventory does not follow links out of the data directory', (t) => {
  withUserData(({ root, userDataDir }) => {
    const outside = join(root, 'Documents');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'thesis.txt'), 'q'.repeat(5000));
    try {
      symlinkSync(outside, join(userDataDir, 'linked'), 'junction');
    } catch {
      t.skip('this account cannot create links; the guard is unexercised here rather than assumed');
      return;
    }
    const report = inventory({ userDataDir });
    assert.equal(report.files, 0, 'a link out of the tree must contribute nothing');
    assert.equal(report.bytes, 0);
  });
});

test('the declaration file names the directory and what is in it', () => {
  withUserData(({ userDataDir }) => {
    mkdirSync(join(userDataDir, 'capability', 'vault'), { recursive: true });
    writeFileSync(join(userDataDir, 'capability', 'vault', 'secrets.json'), 'x'.repeat(10));

    const result = writeDeclaration({ userDataDir, reason: 'this was a silent uninstall' });
    assert.equal(result.ok, true);
    const text = readFileSync(join(userDataDir, DECLARATION_FILE), 'utf8');
    assert.match(text, /YOUR DATA IS STILL ON THIS COMPUTER/);
    assert.ok(text.includes(userDataDir), 'the person must be told where the data is');
    assert.match(text, /silent uninstall/, 'the reason must be stated');
    assert.match(text, /your saved credentials/);
  });
});

// ---------------------------------------------------------------------------
// LOCKSTEP. Two implementations of one decision, in two languages that cannot
// import each other. These assertions are the only thing keeping them equal.
// ---------------------------------------------------------------------------

const NSH = readFileSync(join(REPO, 'build', 'installer.nsh'), 'utf8');

test('the uninstaller compares against the exact tokens this module writes', () => {
  assert.ok(
    NSH.includes(`$R2 == "${CHOICE_KEEP}"`),
    `build/installer.nsh must compare against "${CHOICE_KEEP}" exactly; a renamed token on one ` +
      'side stops matching silently and every uninstall takes the ask branch'
  );
  assert.ok(NSH.includes(`$R2 == "${CHOICE_REMOVE}"`), `build/installer.nsh must compare against "${CHOICE_REMOVE}"`);
  assert.ok(NSH.includes(POLICY_FILE), `build/installer.nsh must read ${POLICY_FILE}`);
  assert.ok(NSH.includes(DECLARATION_FILE), `build/installer.nsh must write ${DECLARATION_FILE}`);
});

test('the uninstaller never asks or removes during an upgrade', () => {
  const macro = NSH.slice(NSH.indexOf('!macro customUnInstall'));
  assert.ok(macro.length > 0, 'customUnInstall must exist');
  assert.match(
    macro,
    /\$\{IfNot\}\s+\$\{isUpdated\}/,
    'the whole retention branch must be gated on NOT being an update; a person installing a new ' +
      'version has not asked to be questioned about their data'
  );
});

// THE SILENT GUARD IS THE ONE THAT CANNOT BE GOT WRONG.
//
// This build already has a defect where the uninstaller ignores /S, opens a
// modal and blocks forever while returning success. An unguarded MessageBox here
// would deepen exactly that, and it would do it in the uninstall path, where the
// caller is usually a script that will wait for a window nobody can see.
test('the uninstaller checks for silent mode before it can open a dialog', () => {
  const macro = NSH.slice(NSH.indexOf('!macro customUnInstall'));
  const silentAt = macro.indexOf('${Silent}');
  const dialogAt = macro.indexOf('MessageBox');
  assert.ok(silentAt !== -1, 'the retention branch must test ${Silent}');
  assert.ok(dialogAt !== -1, 'the interactive branch must actually ask');
  assert.ok(
    silentAt < dialogAt,
    'the ${Silent} test must come BEFORE the MessageBox, or a silent uninstall opens a modal ' +
      'and blocks forever'
  );
  assert.match(
    macro,
    /\/SD IDNO/,
    'the dialog must declare a silent default, and it must be the non-destructive answer'
  );
});

test('the settings page offers the choice and defaults to asking', () => {
  const settings = readFileSync(join(REPO, 'src', 'views', 'settings.js'), 'utf8');
  const id = RETENTION_PREF_KEY.replace(/^mc\.set\./, '');
  const entry = settings.slice(settings.indexOf(`id: '${id}'`));
  assert.ok(settings.includes(`id: '${id}'`), `settings.js must declare the ${id} setting`);

  const declaration = entry.slice(0, entry.indexOf('},') + 2);
  assert.match(declaration, /def: 'ask'/, 'the default must be the question, not a silent keep');
  assert.ok(declaration.includes(CHOICE_KEEP), 'the keep option must be offered');
  assert.ok(declaration.includes(CHOICE_REMOVE), 'the remove option must be offered');
  assert.doesNotMatch(
    declaration,
    /Recommended/i,
    'neither answer may be marked Recommended. This product has already shipped a setup screen ' +
      'with both answers labelled Recommended; there is no correct answer here.'
  );
});

// THE CHOICE MUST SURVIVE A RENAME, or a recorded decision quietly becomes an
// unanswered question on the very upgrade that renamed the product.
test('the recorded choice is carried across a userData rename', () => {
  assert.ok(
    adoption.PRODUCT_STATE_ENTRIES.includes(POLICY_FILE),
    `${POLICY_FILE} must be in PRODUCT_STATE_ENTRIES; without it a rename-upgrade silently ` +
      'converts a recorded "remove everything" back into "never asked"'
  );
});
