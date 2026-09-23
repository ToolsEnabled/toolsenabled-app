// BEHAVIOURAL TESTS FOR "REMOVE THIS PROGRAM'S DATA FROM THIS COMPUTER".
//
// TWO DEFECT CLASSES ARE BEING HUNTED HERE, AND THEY PULL IN OPPOSITE DIRECTIONS.
//
// 1. DELETING TOO MUCH. A recursive delete pointed at the wrong string costs
//    somebody their documents, and it is one typo away at all times. So the
//    guard is tested by NAME and by ANCESTRY, against the environment rather
//    than against a hardcoded path, and every refusal is asserted to leave the
//    files on the disk.
//
// 2. SAYING IT DELETED WHAT IT DID NOT. This is the likelier of the two and the
//    more damaging, because the person acts on it: they believe their vault is
//    gone. Windows holds files open; the window this runs in holds its own
//    browser files open. So the module re-checks every entry AFTER removing it,
//    and the tests below simulate exactly that -- an fs whose rmSync succeeds
//    silently while the file stays -- and assert that the report says KEPT.
//
// The copy module is tested by CALLING it, for the reason src/account-markup.js
// exists: a text search over a view cannot see reachability, and two planted
// defects have already survived that on this very screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, sep, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  formatBytes, outcomeLines, planLines, readPlan, readSweep, rootLabel, SURVIVES,
} from '../../src/account-reset-copy.js';
import { screenMarkup } from '../../src/account-markup.js';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Lexical fixtures only: the guard does not read or remove these paths. Use
// the host's path syntax so each native suite exercises its actual guard.
const guardShape = join(REPO, 'reset-guard-shape');
function guardEnvironment() {
  const profile = join(guardShape, 'profile');
  return { USERPROFILE: profile, APPDATA: join(profile, 'roaming'),
    LOCALAPPDATA: join(profile, 'local'), ProgramFiles: join(guardShape, 'programs'),
    SystemRoot: join(guardShape, 'system'), TEMP: join(profile, 'local', 'temp') };
}

const reset = require(join(REPO, 'shell', 'local-data-reset.cjs'));
const {
  REFUSED_NO_PATH, REFUSED_RELATIVE, REFUSED_ROOT, REFUSED_WELL_KNOWN, REFUSED_ANCESTOR,
  guardRoot, measureRoot, planReset, eraseDirectory, eraseLocalData,
} = reset;

/** A real directory tree shaped like the product's own userData. */
function withProfile(run) {
  const root = mkdtempSync(join(tmpdir(), 'te-reset-'));
  const userDataDir = join(root, 'roaming', 'ToolsEnabled');
  const servicesRoot = join(root, 'local', 'ToolsEnabled');
  mkdirSync(join(userDataDir, 'capability', 'vault'), { recursive: true });
  mkdirSync(join(userDataDir, 'capability', 'state'), { recursive: true });
  mkdirSync(join(userDataDir, 'capability', 'logs'), { recursive: true });
  mkdirSync(join(userDataDir, 'capability', 'config'), { recursive: true });
  mkdirSync(join(userDataDir, 'Local Storage'), { recursive: true });
  mkdirSync(servicesRoot, { recursive: true });
  writeFileSync(join(userDataDir, 'capability', 'vault', 'secrets.json'), '{"k":"v"}');
  writeFileSync(join(userDataDir, 'capability', 'state', 'audit.sqlite3'), 'x'.repeat(4096));
  writeFileSync(join(userDataDir, 'capability', 'logs', 'actions.jsonl'), '{}\n');
  writeFileSync(join(userDataDir, 'capability', 'config', 'accounts.json'), '[]');
  writeFileSync(join(userDataDir, 'product-accounts.json'), '{"accounts":[]}');
  writeFileSync(join(userDataDir, 'product-session.enc'), 'sealed');
  writeFileSync(join(userDataDir, 'renderer-prefs.json'), '{}');
  writeFileSync(join(userDataDir, 'Local Storage', 'leveldb.log'), 'l');
  writeFileSync(join(servicesRoot, 'machine.json'), '{"tier":"standard"}');
  writeFileSync(join(servicesRoot, 'settings.json'), '{}');
  writeFileSync(join(servicesRoot, 'multi-account-state.json'), '{"activeAccount":"school"}');
  const env = { APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), USERPROFILE: join(root, 'home') };
  mkdirSync(env.USERPROFILE, { recursive: true });
  try {
    return run({ root, userDataDir, servicesRoot, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// THE GUARD. Everything here is about NOT deleting.
// ---------------------------------------------------------------------------

test('guardRoot refuses an absent, empty or non-string directory', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    const verdict = guardRoot(bad, { env: {}, homedir: () => 'C:\\Users\\somebody' });
    assert.equal(verdict.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(verdict.code, REFUSED_NO_PATH);
  }
});

test('guardRoot refuses a relative path', () => {
  const verdict = guardRoot('ToolsEnabled', { env: {}, homedir: () => 'C:\\Users\\somebody' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REFUSED_RELATIVE);
});

test('guardRoot refuses the native filesystem root', () => {
  const verdict = guardRoot(parse(REPO).root, { env: {}, homedir: () => guardEnvironment().USERPROFILE });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REFUSED_ROOT);
});

test('guardRoot refuses the native protected folders BY NAME, from the environment', () => {
  const env = guardEnvironment();
  for (const folder of Object.values(env)) {
    const verdict = guardRoot(folder, { env, homedir: () => env.USERPROFILE });
    assert.equal(verdict.ok, false, `refused: ${folder}`);
    assert.equal(verdict.code, REFUSED_WELL_KNOWN);
  }
  // and case/trailing-separator variants of the same folder
  assert.equal(guardRoot(env.APPDATA + sep, { env, homedir: () => env.USERPROFILE }).code, REFUSED_WELL_KNOWN);
  if (process.platform === 'win32') assert.equal(guardRoot(env.APPDATA.toUpperCase() + sep, { env, homedir: () => env.USERPROFILE }).code, REFUSED_WELL_KNOWN);
});

test('guardRoot refuses a directory that CONTAINS a well-known folder', () => {
  const env = guardEnvironment();
  const verdict = guardRoot(guardShape, { env, homedir: () => env.USERPROFILE });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, REFUSED_ANCESTOR);
});

test('guardRoot allows the product’s own two directories', () => {
  const env = guardEnvironment();
  for (const good of [join(env.APPDATA, 'ToolsEnabled'), join(env.LOCALAPPDATA, 'ToolsEnabled')]) {
    const verdict = guardRoot(good, { env, homedir: () => env.USERPROFILE });
    assert.equal(verdict.ok, true, `allowed: ${good}`);
  }
});

test('a refused root deletes NOTHING and says so', () => {
  withProfile(({ env, root }) => {
    const verdict = eraseDirectory({ directory: env.APPDATA, env, homedir: () => env.USERPROFILE });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, REFUSED_WELL_KNOWN);
    assert.deepEqual(verdict.entries, []);
    assert.equal(existsSync(join(root, 'roaming', 'ToolsEnabled', 'product-accounts.json')), true);
  });
});

// ---------------------------------------------------------------------------
// THE MEASUREMENT the person is shown before anything happens.
// ---------------------------------------------------------------------------

test('planReset measures both roots separately and names what is at stake', () => {
  withProfile(({ userDataDir, servicesRoot, env }) => {
    const plan = planReset({ userDataDir, servicesRoot, workspaceRoots: [join(env.USERPROFILE, 'ToolsEnabled')], installDir: 'C:\\Program Files\\nope', env, homedir: () => env.USERPROFILE });
    assert.equal(plan.ok, true);

    const user = plan.roots.find(entry => entry.kind === 'user-data');
    assert.equal(user.guarded, true);
    assert.equal(user.present, true);
    assert.ok(user.files >= 8, `counted ${user.files} files`);
    const named = user.named.map(entry => entry.what);
    assert.ok(named.includes('your saved credentials'));
    assert.ok(named.includes('the signed record of every action taken'));
    assert.ok(user.named.some(entry => entry.rel === join('capability', 'config', 'accounts.json')),
      'the canonical account registry must be named under userData');

    const installation = plan.roots.find(entry => entry.kind === 'installation');
    assert.equal(installation.present, true);
    assert.ok(installation.named.some(entry => entry.rel === 'machine.json'));
    assert.ok(installation.named.some(entry => entry.rel === 'multi-account-state.json'),
      'the distinct services-root rotation record must be named');
    assert.notEqual(user.directory, installation.directory, 'current installed roots must remain distinct');

    // What is NOT touched is part of the plan, not a sentence somebody remembered.
    assert.ok(plan.untouched.some(entry => entry.kind === 'workspace'));
    assert.ok(plan.untouched.some(entry => entry.kind === 'program'));
  });
});

test('same-canonical-root compatibility is measured, named and swept only once', () => {
  withProfile(({ userDataDir, env }) => {
    writeFileSync(join(userDataDir, 'machine.json'), '{"tier":"standard"}');
    writeFileSync(join(userDataDir, 'settings.json'), '{}');
    const physical = measureRoot({ directory: userDataDir });

    const plan = planReset({
      userDataDir,
      servicesRoot: userDataDir,
      env,
      homedir: () => env.USERPROFILE,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.roots.length, 1, 'one physical directory must not become two reset roots');
    assert.equal(plan.roots[0].kind, 'user-data');
    assert.equal(plan.totals.files, physical.files, 'the physical files must not be counted twice');
    assert.equal(plan.totals.bytes, physical.bytes, 'the physical bytes must not be counted twice');
    assert.ok(plan.roots[0].named.some(entry => entry.rel === 'machine.json'),
      'installation state still has to be named when it shares userData');
    assert.ok(plan.roots[0].named.some(entry => entry.rel === 'settings.json'));

    const swept = eraseLocalData({
      roots: plan.roots,
      env,
      homedir: () => env.USERPROFILE,
    });
    assert.equal(swept.complete, true);
    assert.equal(swept.results.length, 1, 'one physical directory must be swept once');
    assert.equal(existsSync(userDataDir), false);
  });
});

test('a services root this copy cannot work out is reported UNGUARDED, never omitted', () => {
  withProfile(({ userDataDir, env }) => {
    const plan = planReset({ userDataDir, servicesRoot: null, env, homedir: () => env.USERPROFILE });
    const installation = plan.roots.find(entry => entry.kind === 'installation');
    assert.equal(installation.guarded, false);
    assert.equal(installation.refusal.code, REFUSED_NO_PATH);
    // and the screen says so rather than shortening the list
    const line = planLines(readPlan(plan)).find(entry => entry.title === rootLabel('installation'));
    assert.match(line.detail, /NOT deleted/);
  });
});

test('a chosen work folder INSIDE the swept directory is a conflict, not a survivor', () => {
  withProfile(({ userDataDir, servicesRoot, env }) => {
    const inside = join(userDataDir, 'workspace');
    const outside = join(env.USERPROFILE, 'ToolsEnabled');
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const plan = planReset({ userDataDir, servicesRoot, workspaceRoots: [inside, outside], env, homedir: () => env.USERPROFILE });
    assert.deepEqual(plan.conflicts.map(entry => entry.directory), [inside],
      'a folder that would be deleted must never be listed as one this does not touch');
    assert.ok(plan.untouched.some(entry => entry.directory === outside));
    assert.ok(!plan.untouched.some(entry => entry.directory === inside));
    // and the copy carries the distinction through untouched
    const read_ = readPlan(plan);
    assert.equal(read_.conflicts.length, 1);
  });
});

test('readPlan treats a reply with no conflicts field as none, and never as unknown-therefore-fine', () => {
  const plan = readPlan({ ok: true, roots: [], totals: { files: 0, bytes: 0 } });
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.untouched, []);
});

test('measureRoot counts a symlink as itself and never follows it out of the tree', () => {
  withProfile(({ root, userDataDir }) => {
    const outside = join(root, 'documents');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'thesis.docx'), 'x'.repeat(10_000));
    let linked = false;
    try {
      require('node:fs').symlinkSync(outside, join(userDataDir, 'link-out'), 'junction');
      linked = true;
    } catch { /* an unprivileged Windows account cannot make one; the guard is still asserted below */ }
    const measured = measureRoot({ directory: userDataDir });
    if (linked) {
      assert.ok(measured.bytes < 10_000, `a followed junction would have counted the 10KB file (${measured.bytes})`);
    }
    assert.equal(existsSync(join(outside, 'thesis.docx')), true);
  });
});

// ---------------------------------------------------------------------------
// THE ACT, and the report of what actually happened.
// ---------------------------------------------------------------------------

test('eraseDirectory removes every entry and reports the root gone', () => {
  withProfile(({ userDataDir, env }) => {
    const outcome = eraseDirectory({ directory: userDataDir, env, homedir: () => env.USERPROFILE });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.entries.length >= 4);
    assert.ok(outcome.entries.every(entry => entry.removed === true), JSON.stringify(outcome.entries));
    assert.equal(outcome.removedRoot, true);
    assert.equal(existsSync(userDataDir), false);
  });
});

/* The order is asserted over the TOP-LEVEL GROUP each delete belonged to, not
   over the argument of the first rmSync call. Since the sweep started removing
   leaf by leaf -- so one locked file cannot shelter its siblings -- the first
   call inside `capability` is a file three directories down, and a test that
   read the raw argument would be measuring the walk rather than the priority.
   What the priority promises is unchanged: the person's own data goes before
   the browser's scratch files, so that whatever fails, fails last. */
test('the person’s own data is swept BEFORE the browser’s scratch files', () => {
  withProfile(({ userDataDir, env }) => {
    const groups = [];
    const fs = require('node:fs');
    const noteGroup = (target) => {
      const relative = String(target).slice(userDataDir.length + 1);
      const group = relative.split(sep)[0];
      if (group && groups.at(-1) !== group) groups.push(group);
    };
    const spy = {
      ...fs,
      rmSync: (target, options) => { noteGroup(target); return fs.rmSync(target, options); },
      rmdirSync: (target) => { noteGroup(target); return fs.rmdirSync(target); },
    };
    eraseDirectory({ directory: userDataDir, fs: spy, env, homedir: () => env.USERPROFILE, priority: ['capability', 'product-accounts.json', 'Local Storage'] });
    assert.equal(groups[0], 'capability');
    assert.equal(groups[1], 'product-accounts.json');
    assert.ok(groups.indexOf('Local Storage') > groups.indexOf('product-accounts.json'));
  });
});

/* THE DEFECT THIS FILE EXISTS TO STOP, IN ITS REAL SHAPE.
 *
 * The in-app removal reported the credential vault, its access log and the
 * signed ledger still on the disk after a sweep that had worked. The reason was
 * not policy and not the capability layer: the window's own process holds the
 * ledger's database open, and a single recursive delete of `capability/` STOPS
 * at the first entry it cannot unlink. The vault survived because a database
 * three directories away was busy.
 *
 * The busy file is simulated the way the file above already simulates Windows --
 * an fs whose delete leaves this one path in place -- because what is under test
 * is what the sweep does about it, not whether Node can be made to fail. The
 * assertion is the one that matters: everything that was NOT locked is gone, and
 * the survivor is the locked file alone. */
test('a file that cannot be deleted does not shelter its siblings', () => {
  withProfile(({ userDataDir, env }) => {
    const fs = require('node:fs');
    const locked = join(userDataDir, 'capability', 'state', 'audit.sqlite3');
    /* WINDOWS' OWN BEHAVIOUR, MODELLED FROM A MEASUREMENT RATHER THAN IMAGINED.
       Reproduced 2026-08-18 with a real open database handle: rmSync of the
       grandparent raised EBUSY and left the whole `vault/` directory in place --
       a recursive delete stops at the entry it cannot unlink and abandons what
       it had not reached. So the fake refuses the locked leaf AND refuses any
       recursive call aimed at a folder containing it, removing nothing in that
       case, which is that worst case exactly. Nothing here reimplements a
       delete; it only declines one. */
    const holdsTheLock = (target) => locked === String(target) || locked.startsWith(`${String(target)}${sep}`);
    const busy = {
      ...fs,
      rmSync: (target, options) => {
        if (holdsTheLock(target)) { const error = new Error('EBUSY'); error.code = 'EBUSY'; throw error; }
        return fs.rmSync(target, options);
      },
    };
    const outcome = eraseDirectory({
      directory: userDataDir, fs: busy, env, homedir: () => env.USERPROFILE,
      priority: ['capability', 'product-accounts.json'],
    });
    assert.equal(existsSync(join(userDataDir, 'capability', 'vault', 'secrets.json')), false);
    assert.equal(existsSync(join(userDataDir, 'capability', 'logs', 'actions.jsonl')), false);
    assert.equal(existsSync(join(userDataDir, 'capability', 'config', 'accounts.json')), false);
    assert.equal(existsSync(join(userDataDir, 'product-accounts.json')), false);
    assert.equal(existsSync(locked), true);
    assert.equal(outcome.remaining.files, 1);
    const kept = outcome.entries.filter(entry => entry.removed !== true);
    assert.deepEqual(kept.map(entry => entry.name), ['capability']);
    assert.equal(kept[0].reason, 'EBUSY');
  });
});

test('AN ENTRY THAT SURVIVES IS REPORTED KEPT, even when the delete call did not complain', () => {
  withProfile(({ userDataDir, env }) => {
    const fs = require('node:fs');
    // Windows' real behaviour, simulated: the call returns, the file stays.
    /* The leaf, not the folder: the sweep removes leaf by leaf now, so a
       stub that no-ops on the DIRECTORY would be stubbing a call the module no
       longer makes and would assert nothing. The survivor is the file, and the
       folder it is in survives with it. */
    const stubborn = {
      ...fs,
      rmSync: (target, options) => {
        if (String(target).endsWith('leveldb.log')) return undefined;
        return fs.rmSync(target, options);
      },
    };
    const outcome = eraseDirectory({ directory: userDataDir, fs: stubborn, env, homedir: () => env.USERPROFILE });
    const kept = outcome.entries.filter(entry => entry.removed !== true);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].name, 'Local Storage');
    assert.ok(typeof kept[0].reason === 'string' && kept[0].reason.length > 0);
    assert.equal(outcome.removedRoot, false);
    assert.equal(outcome.remaining.files, 1);
  });
});

test('eraseLocalData reports complete=false while anything at all remains', () => {
  withProfile(({ userDataDir, servicesRoot, env }) => {
    const fs = require('node:fs');
    const stubborn = { ...fs, rmSync: (target, options) => (String(target).endsWith('leveldb.log') ? undefined : fs.rmSync(target, options)) };
    const swept = eraseLocalData({
      roots: [{ kind: 'user-data', directory: userDataDir }, { kind: 'installation', directory: servicesRoot }],
      fs: stubborn,
      env,
      homedir: () => env.USERPROFILE,
    });
    assert.equal(swept.ok, true);
    assert.equal(swept.complete, false, 'a survivor must never read as complete');
    assert.equal(swept.remainingFiles, 1);
    // the half that DID work is still reported as done
    assert.equal(existsSync(join(userDataDir, 'product-accounts.json')), false);
    assert.equal(existsSync(servicesRoot), false);
  });
});

test('eraseLocalData over both real roots leaves nothing and reads complete', () => {
  withProfile(({ userDataDir, servicesRoot, env }) => {
    const registry = join(userDataDir, 'capability', 'config', 'accounts.json');
    const rotation = join(servicesRoot, 'multi-account-state.json');
    assert.equal(existsSync(registry), true);
    assert.equal(existsSync(rotation), true);
    const swept = eraseLocalData({
      roots: [{ kind: 'user-data', directory: userDataDir }, { kind: 'installation', directory: servicesRoot }],
      env,
      homedir: () => env.USERPROFILE,
    });
    assert.equal(swept.complete, true);
    assert.equal(swept.remainingFiles, 0);
    assert.equal(existsSync(registry), false, 'canonical registry survived reset');
    assert.equal(existsSync(rotation), false, 'separate rotation state survived reset');
    assert.equal(existsSync(userDataDir), false);
    assert.equal(existsSync(servicesRoot), false);
  });
});

test('an absent root is not an error and is not counted as a deletion', () => {
  withProfile(({ root, env }) => {
    const outcome = eraseDirectory({ directory: join(root, 'roaming', 'NothingHere'), env, homedir: () => env.USERPROFILE });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.absent, true);
    assert.deepEqual(outcome.entries, []);
  });
});

test('a root whose existence cannot be checked is never reported absent', () => {
  withProfile(({ userDataDir, env }) => {
    const fs = require('node:fs');
    const unreadable = {
      ...fs,
      lstatSync: (target) => {
        if (target === userDataDir) { const error = new Error('access denied'); error.code = 'EACCES'; throw error; }
        return fs.lstatSync(target);
      },
    };
    const outcome = eraseDirectory({ directory: userDataDir, fs: unreadable, env, homedir: () => env.USERPROFILE });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'RESET_DIRECTORY_UNREADABLE');
    assert.equal(outcome.reason, 'EACCES');
    assert.equal(existsSync(userDataDir), true);
  });
});

// ---------------------------------------------------------------------------
// THE COPY. Called, not searched for.
// ---------------------------------------------------------------------------

test('readPlan turns every unrecognised reply into "not available", never an empty plan', () => {
  for (const reply of [null, undefined, 'yes', 42, {}, { ok: false }, { ok: true }, { ok: true, roots: 'lots' }]) {
    const plan = readPlan(reply);
    assert.equal(plan.available, false, `refused: ${JSON.stringify(reply)}`);
    assert.ok(plan.reason.length > 0);
    assert.deepEqual(plan.roots, []);
  }
});

test('readSweep never reports complete from a reply it did not understand', () => {
  for (const reply of [null, {}, { ok: true }, { ok: true, swept: {} }, { ok: true, swept: { ok: true } }, { ok: false, swept: { ok: true, complete: true } }]) {
    const sweep = readSweep(reply);
    assert.equal(sweep.complete, false, `not complete: ${JSON.stringify(reply)}`);
  }
});

test('outcomeLines has three outcomes and only ONE of them says it is gone', () => {
  const failed = outcomeLines(readSweep(null));
  assert.equal(failed.tone, 'bad');
  assert.match(failed.title, /could not be confirmed/);

  const partial = outcomeLines({ ran: true, complete: false, remainingFiles: 3, roots: [] });
  assert.equal(partial.tone, 'warn');
  assert.doesNotMatch(partial.title, /It is gone/);
  assert.match(partial.detail, /3 files/);
  assert.match(partial.detail, /Closing ToolsEnabled/);

  const done = outcomeLines({ ran: true, complete: true, revoked: true, remainingFiles: 0, roots: [] });
  assert.equal(done.tone, 'good');
  assert.match(done.title, /It is gone/);
  // even the success sentence refuses to claim the program was uninstalled
  assert.match(done.detail, /still installed/);
});

test('the survivor list names the program, the person’s own files and what already left', () => {
  const titles = SURVIVES.map(entry => entry.title);
  assert.ok(titles.includes('The program itself'));
  assert.ok(titles.includes('Your own files'));
  assert.ok(titles.includes('Anything that already left this computer'));
  const program = SURVIVES.find(entry => entry.title === 'The program itself');
  assert.match(program.detail, /does not uninstall/i);
});

// ---------------------------------------------------------------------------
// WHERE THE CONTROL APPEARS, proved by rendering the screen rather than by
// searching the file for it. An early `return ''` in a builder is invisible to
// a text search, and this screen has already shipped that defect twice.
// ---------------------------------------------------------------------------

test('the removal control is on every screen somebody could need it from', () => {
  const signedOut = screenMarkup({ state: { available: true, signedIn: false, accountCount: 1 } });
  assert.match(signedOut, /data-reset-phase="idle"/,
    'somebody who cannot sign in -- there is no password reset -- must still be able to remove their data');

  const signedIn = screenMarkup({
    state: { available: true, signedIn: true, username: 'someone', displayName: 'Someone', signInMethod: 'local' },
  });
  assert.match(signedIn, /data-reset-phase="idle"/);

  /* The account store being unreadable is exactly when somebody wants out. */
  const unavailable = screenMarkup({ state: { available: false, reason: 'the store could not be opened' } });
  assert.match(unavailable, /data-reset-phase="idle"/);

  /* And NOT under a form somebody is typing a password into. */
  const changing = screenMarkup({
    state: { available: true, signedIn: true, username: 'someone', displayName: 'Someone', signInMethod: 'local' },
    mode: 'change-password',
  });
  assert.doesNotMatch(changing, /data-reset/);
});

test('the confirm screen renders the measurement, the survivors and both buttons', () => {
  const plan = readPlan({
    ok: true,
    roots: [{ kind: 'user-data', directory: 'C:\\p\\ToolsEnabled', guarded: true, present: true, files: 92, bytes: 12_444_000, named: [{ rel: 'x', what: 'your saved credentials' }] }],
    totals: { files: 92, bytes: 12_444_000 },
    untouched: [{ kind: 'workspace', directory: 'C:\\Users\\somebody\\ToolsEnabled' }],
    conflicts: [],
  });
  const html = screenMarkup({ state: { available: true, signedIn: false, accountCount: 1 }, reset: { phase: 'confirm', plan } });
  assert.match(html, /data-reset-phase="confirm"/);
  assert.match(html, /your saved credentials/);
  assert.match(html, /C:\\p\\ToolsEnabled/);
  assert.match(html, /C:\\Users\\somebody\\ToolsEnabled/);
  assert.match(html, /data-reset-confirm/);
  assert.match(html, /data-reset-cancel/);
  assert.match(html, /There is no undo and no copy anywhere else/);
});

test('a work folder inside the swept directory is SHOWN, not just recorded', () => {
  const plan = readPlan({
    ok: true,
    roots: [{ kind: 'user-data', directory: 'C:\\p\\ToolsEnabled', guarded: true, present: true, files: 3, bytes: 10, named: [] }],
    totals: { files: 3, bytes: 10 },
    untouched: [],
    conflicts: [{ kind: 'workspace', directory: 'C:\\p\\ToolsEnabled\\workspace' }],
  });
  const html = screenMarkup({ state: { available: true, signedIn: false, accountCount: 1 }, reset: { phase: 'confirm', plan } });
  assert.match(html, /data-reset-conflict/);
  assert.match(html, /C:\\p\\ToolsEnabled\\workspace/);
});

test('the result screen never says "It is gone" while it is naming survivors', () => {
  const sweep = readSweep({
    ok: true,
    revoked: { ok: true, revokedSessions: true },
    swept: {
      ok: true,
      complete: false,
      remainingFiles: 2,
      results: [{ kind: 'user-data', directory: 'C:\\p\\ToolsEnabled', removedRoot: false, remaining: { files: 2 }, entries: [{ name: 'Cache', removed: false, reason: 'EBUSY' }, { name: 'capability', removed: true }] }],
    },
  });
  const html = screenMarkup({ state: { available: true, signedIn: false, accountCount: 0 }, reset: { phase: 'done', sweep } });
  assert.match(html, /data-reset-outcome="warn"/);
  assert.doesNotMatch(html, /It is gone/);
  assert.match(html, /Cache/, 'the survivor must be named on the screen');
  assert.match(html, /data-reset-close/);
});

test('formatBytes reads as a size a person recognises', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(-5), '0 bytes');
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(4096), '4.0 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12.00 MB');
});

/* THE ROOT'S REMOVAL IS ASSERTED BY RE-STAT, NOT BY rmdirSync NOT THROWING.
   This is defect class 2 from the header at the top of this file, applied to
   the root itself — the one place the class was not already covered. A
   directory removal can return without throwing and leave the directory in
   place: an open handle, a scanner mid-scan, a mapped drive, a lock another
   process holds. Deriving the report from the CALL rather than from the DISK
   tells a person their data is gone while it is still there, which the header
   calls the more damaging of the two classes precisely because they act on it.

   MEASURED BEFORE THIS WAS WRITTEN: replacing the re-stat with
   `removedRoot = true` left all 123 checks across the four files naming this
   module green, so nothing anywhere was watching this line. */
test('a root that survives its own removal is never reported as removed', () => {
  withProfile(({ userDataDir, env }) => {
    const fs = require('node:fs');
    /* Everything delegates to the real module except rmdirSync, which SUCCEEDS
       without removing. So the only thing under test is whether the report
       comes from the call or from the disk. */
    const silentlyKeepsTheRoot = { ...fs, rmdirSync: () => {} };
    const outcome = eraseDirectory({
      directory: userDataDir, fs: silentlyKeepsTheRoot, env, homedir: () => env.USERPROFILE,
    });
    assert.equal(existsSync(userDataDir), true,
      'the fixture root must still exist here, or this test proves nothing');
    assert.notEqual(outcome.removedRoot, true,
      'rmdirSync returned without removing the directory and the reset reported the root gone');
  });
});

/* THE GUARD MUST REFUSE WHEN IT CANNOT BUILD ITS OWN REFUSAL LIST.
 *
 * guardRoot is a list of places that must never be swept. Every source of that
 * list is an environment variable except one, os.homedir(), whose failure was
 * swallowed under a note saying "a machine with no home is still guarded by the
 * rest". That is true only while the rest exists.
 *
 * DRIVEN 2026-08-27, not reasoned: with the environment stripped AND homedir()
 * throwing, guardRoot APPROVED the home directory, and approved C:\Users -- the
 * parent of every account on the machine. An empty refusal list was being read
 * as "there is nothing here to protect".
 *
 * It is reachable rather than theoretical. The environment is every source but
 * one, and this product deliberately strips environments before spawning
 * children -- safeLaunchEnvironment in shell/agent-host.cjs, and the sterile
 * launcher in the engine, whose whole job is to put every home variable into a
 * per-run profile.
 *
 * The control at the end is what makes the rest evidence: an ordinary folder
 * must still be APPROVED, or a guard that refuses everything would pass all of
 * this while making the feature unusable. */
test('the sweep refuses when this computer\u2019s own folders could not be identified', () => {
  const throwing = () => { throw new Error('this machine reports no home directory'); };
  const guardHome = guardEnvironment().USERPROFILE;
  const guardParent = dirname(guardHome);

  const blindHome = guardRoot(guardHome, { env: {}, homedir: throwing });
  assert.equal(blindHome.ok, false,
    'with no environment and no home, the sweep approved a home directory');
  assert.equal(blindHome.code, 'RESET_PROTECTED_FOLDERS_UNKNOWN',
    'the refusal must say the folders could not be identified, not pick a reason it did not establish');

  const blindUsers = guardRoot(guardParent, { env: {}, homedir: throwing });
  assert.equal(blindUsers.ok, false,
    'with no environment and no home, the sweep approved the parent of every account on the machine');

  /* ONE SOURCE IS ENOUGH, and this is the half that stops the fix becoming a
     blanket refusal. A machine that genuinely has no home directory but does
     have an environment is still fully guarded, which is what the original note
     claimed and what remains true. */
  const envOnly = guardRoot(guardHome, { env: { APPDATA: join(guardHome, 'AppData', 'Roaming') }, homedir: throwing });
  assert.equal(envOnly.ok, false, 'a home directory with an intact environment must still be refused');
  assert.notEqual(envOnly.code, 'RESET_PROTECTED_FOLDERS_UNKNOWN',
    'the guard reported it could not identify the folders while an environment variable was naming one');

  const homedirOnly = guardRoot(guardHome, { env: {}, homedir: () => guardHome });
  assert.equal(homedirOnly.ok, false, 'a home directory named only by homedir() must still be refused');
  assert.notEqual(homedirOnly.code, 'RESET_PROTECTED_FOLDERS_UNKNOWN',
    'the guard reported it could not identify the folders while homedir() was naming one');

  /* THE CONTROL. Without it, refusing everything would pass every assertion above. */
  const ordinary = guardRoot(join(guardHome, 'a-folder-of-mine'), {
    env: { APPDATA: join(guardHome, 'AppData', 'Roaming') }, homedir: () => guardHome,
  });
  assert.equal(ordinary.ok, true,
    `an ordinary folder was refused (${ordinary.code}), so the guard now refuses everything and the checks above prove nothing`);
});
