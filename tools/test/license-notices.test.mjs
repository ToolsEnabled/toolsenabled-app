// Behavioural tests for the license-notice delivery gate.
//
// These assert what the gate DOES, not what its source says. A source-text
// assertion would pass just as happily against dead code, and the whole point
// of this gate is that it actually fails a build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readCapabilitySourceSetting } from '../lib/capability-source-git.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(REPO, 'tools', 'check-license-notices.mjs');

// THE PLANT BELOW EDITS THE REAL NOTICE, SO IT NEEDS A CROSS-PROCESS LOCK.
//
// Measured 2026-08-11 (R1526), three `npm test` runs started together in one
// checkout: one of them went red on 'the duplicate-paragraph rule does not
// apply to reproduced third-party licence texts' -- a test that touches
// neither NOTICE nor the plant. It failed because it ran the gate during the
// window in which ANOTHER run had the duplicate planted in the real NOTICE.
// Nothing was wrong with the product. The suite simply could not tell "the
// notice is broken" from "a neighbour is mid-test", and a gate that cannot
// tell those apart cannot answer the only question it is asked.
//
// There is a worse version of the same race, and it is why this is a lock
// rather than a retry: two runs inside the window at once BOTH read
// `original` first. Whichever restores second writes back whatever IT read --
// and if that was the planted text, the duplicate stays in NOTICE. A tracked
// legal document, left damaged in the working tree, by a test whose whole
// purpose is to prove damaged notices get caught.
//
// mkdir is atomic on Windows and POSIX alike: exactly one caller creates the
// directory and everyone else gets EEXIST, with no read-then-write gap to
// lose. The lock lives under the OS temp directory, keyed by a hash of this
// checkout's path, for two reasons -- a lock file inside the repo would be an
// untracked file that fails tools/require-clean-tree.mjs and so blocks
// `npm run dist`, and keying by checkout means two DIFFERENT worktrees never
// serialise against each other over a NOTICE they do not share.
//
// A holder that died without cleaning up is taken over after STALE_LOCK_MS
// instead of wedging the suite forever: a lock that can hang a test run is
// its own outage.
const PLANT_LOCK = join(
  tmpdir(),
  `te-notice-plant-${createHash('sha256').update(REPO).digest('hex').slice(0, 16)}`,
);
const STALE_LOCK_MS = 60_000;
const LOCK_WAIT_LIMIT_MS = STALE_LOCK_MS * 2;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Re-entrant within this process: the plant test holds the lock across a body
// that itself calls runGate(), and runGate() takes the lock too so that the
// OTHER tests in this file -- which only read -- cannot observe a planted
// NOTICE. Without the depth counter that nesting would deadlock against
// itself.
let lockDepth = 0;

function withRepoNoticeLock(body) {
  if (lockDepth > 0) {
    lockDepth += 1;
    try { return body(); } finally { lockDepth -= 1; }
  }

  const waitingSince = Date.now();
  for (;;) {
    try {
      mkdirSync(PLANT_LOCK);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let heldForMs = Infinity;
      try { heldForMs = Date.now() - statSync(PLANT_LOCK).mtimeMs; } catch { heldForMs = Infinity; }
      if (heldForMs > STALE_LOCK_MS) {
        try { rmSync(PLANT_LOCK, { recursive: true, force: true }); } catch { /* another waiter won the takeover */ }
        continue;
      }
      if (Date.now() - waitingSince > LOCK_WAIT_LIMIT_MS) {
        throw new Error(
          `could not take the NOTICE plant lock at ${PLANT_LOCK} within ${LOCK_WAIT_LIMIT_MS}ms. ` +
            'Another run of this suite in this same checkout is holding it, or a dead one left it behind. ' +
            'Remove that directory to clear it.',
        );
      }
      sleepSync(25);
    }
  }

  lockDepth = 1;
  try {
    return body();
  } finally {
    lockDepth = 0;
    try { rmSync(PLANT_LOCK, { recursive: true, force: true }); } catch { /* best effort: the stale takeover above covers this */ }
  }
}

function runGate(args = []) {
  // Capture status from the bare process. Never read an exit code through a
  // pipe -- a pipeline reports the LAST command's status, not the gate's.
  const spawn = () => {
    const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  // EVERY invocation is serialised, including the ones that name a packaged
  // root. It is tempting to skip the lock for those on the grounds that they
  // are "checking the package, not the repo" -- that was written here first
  // and it is wrong. check-license-notices.mjs runs its repository checks
  // unconditionally and only ADDS the packaged ones: the required-docs loop,
  // the AGPL hash and the duplicate-paragraph rule over the repo's own
  // NOTICE/LICENSING.md/COMMERCIAL-LICENSE.md/CONTRIBUTORS.md all execute
  // before `if (packagedRoot)` is ever reached, which the gate says in its own
  // words when it prints scope as "repository + <root>". So a packaged-mode
  // run reads a planted NOTICE exactly like a bare one, and an exemption here
  // would leave the race open on the two tests that pass a root.
  return withRepoNoticeLock(spawn);
}

function withGateFixture(packageJson, thirdPartyLicenses, body) {
  const dir = mkdtempSync(join(tmpdir(), 'te-licgate-repo-'));
  try {
    mkdirSync(join(dir, 'tools'));
    copyFileSync(GATE, join(dir, 'tools', 'check-license-notices.mjs'));
    for (const doc of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md']) {
      copyFileSync(join(REPO, doc), join(dir, doc));
    }
    writeFileSync(join(dir, 'THIRD-PARTY-LICENSES.md'), thirdPartyLicenses);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runFixtureGate(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'check-license-notices.mjs')], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('gate passes against the current repository', () => {
  const { status, out } = runGate();
  assert.equal(status, 0, `expected exit 0, got ${status}:\n${out}`);
  assert.match(out, /LICENSE NOTICE GATE: PASS/);
});

test('gate fails when the packaged product is missing the notices', () => {
  // A directory that looks like a packaged root but ships no notices. This
  // exercises the packaged-mode branch for real rather than trusting it.
  const dir = mkdtempSync(join(tmpdir(), 'te-licgate-'));
  try {
    mkdirSync(join(dir, 'resources'), { recursive: true });
    const { status, out } = runGate([dir]);
    assert.equal(status, 1, `expected exit 1, got ${status}:\n${out}`);
    for (const doc of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) {
      assert.ok(
        out.includes(`${doc} did not reach the built product`),
        `failure output should name the missing ${doc}:\n${out}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate fails when the packaged root has no resources directory at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-licgate-empty-'));
  try {
    const { status, out } = runGate([dir]);
    assert.equal(status, 1, `expected exit 1, got ${status}:\n${out}`);
    assert.match(out, /has no resources\/ directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LICENSE is the standard MIT License', () => {
  // Relicensed from AGPL-3.0-or-later to MIT on 2026-08-12 by owner directive.
  //
  // The body is hashed WITHOUT the copyright line, because MIT embeds that line
  // -- and therefore the year -- inside the grant. Pinning the whole file would
  // fail this test every January on a file nobody edited. The copyright line is
  // asserted separately below, so nothing is left unchecked.
  const MIT_BODY = 'c9b7c49cdeb4ccab2f2cb69e67f3405518e4bcf611bd3b01de101b070659d11d';
  // Normalised, matching the gate: core.autocrlf=true with no .gitattributes
  // means a fresh clone has a CRLF LICENSE whose raw digest differs while the
  // licence text is identical.
  const lines = readFileSync(join(REPO, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const body = lines.filter((line) => !/^Copyright \(c\)/.test(line)).join('\n');
  const got = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  assert.equal(got, MIT_BODY, 'the MIT body must be the standard wording; put custom wording in NOTICE');

  const copyright = lines.find((line) => /^Copyright \(c\)/.test(line));
  assert.ok(copyright, 'LICENSE has no copyright line; the MIT grant would name nobody');
  assert.match(copyright, /^Copyright \(c\) \d{4} Joshua Pinckard$/);
});

test('the engine half declares the same licence', () => {
  // One product in two repositories. The engine half pins the same body digest
  // from its own side; this is the check from this side, so a relicence that
  // touches only one repository is caught from whichever half is on the machine.
  const engine = process.env.TOOLSENABLED_SOURCE
    || readCapabilitySourceSetting(REPO)?.path;
  if (!engine) {
    console.log('  (skipped: no configured engine checkout; compared nothing)');
    return;
  }
  if (!existsSync(join(engine, 'package.json'))) {
    // Not a silent pass: say that nothing was compared, because "no counterpart
    // checkout" reported as a tick is how a cross-repository check quietly stops
    // checking.
    console.log(`  (skipped: configured engine checkout is unavailable at ${engine}; compared nothing)`);
    return;
  }
  const pkg = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT', 'the two halves are one product and cannot be under two licences');
});

test('contribution terms exist, so the relicensing option survives a first outside merge', () => {
  // MIT can be relicensed today only because one person holds copyright in every
  // line. CONTRIBUTING.md is what keeps that statable once other people
  // contribute; its absence is a licence defect, not a documentation one.
  const contributing = readFileSync(join(REPO, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /Developer Certificate of Origin/);
  assert.match(contributing, /Signed-off-by/);
});

test('the free product does not claim all rights reserved', () => {
  // The launch blocker this lane existed to close: a reserved-rights notice is
  // incompatible with an open-source release.
  for (const doc of ['README.md', 'NOTICE', 'LICENSING.md', 'COMMERCIAL-LICENSE.md']) {
    const text = readFileSync(join(REPO, doc), 'utf8');
    assert.ok(
      !/all rights reserved/i.test(text),
      `${doc} still reserves all rights, which contradicts the MIT grant`
    );
  }
});

test('third-party notices reproduce the license bodies, not just the names', () => {
  const tpl = readFileSync(join(REPO, 'THIRD-PARTY-LICENSES.md'), 'utf8');
  // Distinctive operative sentences from each license family that actually
  // ships. A heading alone does not discharge a notice obligation.
  assert.ok(
    tpl.includes('SIL OPEN FONT LICENSE Version 1.1'),
    'the bundled fonts are OFL-1.1 and their license text must be reproduced'
  );
  assert.ok(
    tpl.includes('Apache License'),
    'Apache-2.0 components require a copy of the Apache license'
  );
  assert.ok(
    tpl.includes('Redistributions in binary form must reproduce the above copyright notice'),
    'zrender is BSD-3-Clause and requires its binary-form notice to be reproduced'
  );
});

test('every production dependency is covered by the notice file', () => {
  const pkg = { dependencies: { 'unnoticed-production-package': '1.0.0' } };
  withGateFixture(pkg, '# Third-party licences\n', (dir) => {
    const dependency = join(dir, 'node_modules', 'unnoticed-production-package');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({
      name: 'unnoticed-production-package',
      version: '1.0.0',
    }));
    writeFileSync(
      join(dependency, 'LICENSE'),
      'Permission is granted to use this fixture package in behavioural tests.\n',
    );

    const { status, out } = runFixtureGate(dir);
    assert.equal(
      status,
      1,
      `the gate must reject an installed production dependency whose licence notice is absent:\n${out}`,
    );
    assert.match(out, /unnoticed-production-package@1\.0\.0/, out);
  });
});

test('the notices are configured to ship with the installer', () => {
  // The obligation is only discharged if the texts are in the box. This asserts
  // the build config, which is what determines whether they get there.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const targets = (pkg.build?.extraResources || []).map((e) => (typeof e === 'string' ? e : e.to));
  for (const doc of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) {
    assert.ok(
      targets.includes(doc),
      `${doc} is not in build.extraResources, so it will not reach users`
    );
  }
});

// A DUPLICATED PARAGRAPH IN A SHIPPED LEGAL NOTICE, AND THE GATE THAT COULD NOT SEE IT.
//
// Measured 2026-08-11: NOTICE carried the "Mission Control" trademark paragraph
// twice, verbatim and back to back, and this gate reported PASS. Everything it
// checked was still true -- the file existed, it was not empty, and LICENSE still
// hashed to the unmodified AGPL -- so the duplicate was invisible to it and
// shipped to every user as resources/NOTICE.
//
// THIS TEST PLANTS THAT EXACT DEFECT INTO THE REAL FILE rather than into a
// fixture, because the gate resolves REPO from its own location and always reads
// the real NOTICE; a fixture would prove a copy of the rule works on a copy of
// the file. Planting the real thing is also what makes this a mutation proof
// rather than a decoration: the red state asserted below IS the state that
// shipped.
//
// The restore is asserted by sha256, not assumed. A test that damages a legal
// notice and cannot prove it put the bytes back is worse than no test.
// The whole body runs under withRepoNoticeLock, including the FIRST read of
// `original`: reading outside the lock is how the second race above starts.
test('gate fails when a shipped notice repeats a paragraph verbatim', () => withRepoNoticeLock(() => {
  const noticePath = join(REPO, 'NOTICE');
  const original = readFileSync(noticePath);
  const originalSha = createHash('sha256').update(original).digest('hex');

  // Match the file's own line endings. This repository is checked out with
  // core.autocrlf=true, so a hardcoded \n plant silently fails to find its
  // target on a fresh clone -- and a plant that does not land produces a green
  // that looks exactly like a working rule.
  const text = original.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const paragraph = [
    'The interface was previously called "Mission Control". That name was dropped',
    'before launch: a USPTO search returned 17 live marks for it in the relevant',
    'classes, including Apple Inc. (Reg. 4240125, IC 009) and BMC Software.',
    '"ToolsEnabled" returned no hits, live or dead.',
  ].join(eol);

  assert.ok(
    text.includes(paragraph),
    'the paragraph this test plants a duplicate of is no longer in NOTICE, so the plant ' +
      'would not land and the assertions below would pass without testing anything. ' +
      'Update the paragraph text here to a block that NOTICE actually contains.'
  );

  // START FROM A KNOWN-CLEAN FILE, and say so out loud if we do not. If a
  // previous interrupted run left the duplicate behind, `original` already
  // contains it -- the plant would then be a no-op, the gate would fail for a
  // reason this test did not create, and the restore at the end would write
  // the damage back as though it were the good copy.
  assert.ok(
    !text.includes(`${paragraph}${eol}${eol}${paragraph}`),
    'NOTICE already contains the duplicated paragraph before this test planted anything. ' +
      'A previous interrupted run of this test left it behind: restore NOTICE from git before ' +
      'trusting any result here.'
  );

  try {
    writeFileSync(noticePath, text.replace(paragraph, `${paragraph}${eol}${eol}${paragraph}`));

    // Prove the plant changed the file before trusting what the gate says about it.
    const plantedSha = createHash('sha256').update(readFileSync(noticePath)).digest('hex');
    assert.notEqual(plantedSha, originalSha, 'the plant did not change NOTICE, so the gate result below is meaningless');

    const { status, out } = runGate();
    assert.equal(status, 1, `expected exit 1 on a duplicated paragraph, got ${status}:\n${out}`);
    // The failure must NAME the document and the offending text. A red that does
    // not say what is wrong sends the reader to the wrong file.
    assert.match(out, /NOTICE repeats the same paragraph 2 times verbatim/, out);
    assert.match(out, /Mission Control/, out);
  } finally {
    writeFileSync(noticePath, original);
  }

  const restoredSha = createHash('sha256').update(readFileSync(noticePath)).digest('hex');
  assert.equal(restoredSha, originalSha, 'NOTICE was not restored byte-identically after the plant');

  // And the restored file must actually pass, so a failure here cannot be left
  // looking like a pre-existing condition.
  const after = runGate();
  assert.equal(after.status, 0, `NOTICE should pass again after restore:\n${after.out}`);
}));

// THIRD-PARTY-LICENSES.md MUST NOT BE SUBJECT TO THE DUPLICATE RULE.
//
// It reproduces the full licence text of every redistributed dependency, so
// identical MIT and BSD-3-Clause bodies repeat legitimately -- 44 duplicated
// blocks when measured on 2026-08-11. If the rule ever grows to cover it, this
// gate goes permanently red and the only way out is deleting the rule. This test
// fails the moment that happens, while the fix is still cheap.
test('the duplicate-paragraph rule does not apply to reproduced third-party licence texts', () => {
  const repeatedLicence = [
    'Permission is hereby granted to use, copy, modify, and distribute this fixture.',
    'THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND.',
  ].join('\n');
  const notices = `# Third-party licences\n\n### fixture-dep 1.0.0 — MIT\n\n${repeatedLicence}\n\n${repeatedLicence}\n`;
  // One INSTALLED production dependency, not none: the gate now refuses an
  // enumeration that walked zero dependencies, because reporting "every licence
  // is covered" after checking nothing is the vacuous pass this file exists to
  // catch. An empty fixture would be refused before reaching the paragraph rule
  // under test, which would make this test measure the guard instead of the rule.
  withGateFixture({ dependencies: { 'fixture-dep': '1.0.0' } }, notices, (dir) => {
    const installed = join(dir, 'node_modules', 'fixture-dep');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: 'fixture-dep', version: '1.0.0', license: 'MIT' }),
    );
    writeFileSync(join(installed, 'LICENSE'), repeatedLicence);
    const { status, out } = runFixtureGate(dir);
    assert.equal(
      status,
      0,
      `the gate must accept legitimately repeated licence bodies in THIRD-PARTY-LICENSES.md:\n${out}`,
    );
  });
});
