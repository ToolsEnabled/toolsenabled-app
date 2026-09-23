import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

const EXPECTED_VERIFY_SCRIPT = /^node\s+tools[\\/]test-ratchet\.mjs\s+--strict$/;

const REQUIRED_STAGES = [
  {
    name: 'verify',
    pattern: /\bnpm\s+run\s+verify:release\b/,
    missing:
      'The dist ship path must invoke scripts.verify:release; otherwise an installer can be produced with known test failures.',
  },
  {
    // Added after the owner read the shipped product and said "the wording is
    // dense and not easy to consume or friendly for users."
    //
    // WHY IT IS A SHIP STAGE AND NOT ONLY A TEST. It is both, deliberately.
    // tools/test/plain-language.test.mjs runs on every `npm test` and is
    // therefore already inside `verify` -- so this stage is not what makes the
    // rule enforced. What it adds is that the rule is VISIBLE in the chain and
    // survives the suite: a lane that baselines the copy suite in
    // tools/test-baseline.json, for whatever good reason, would otherwise ship
    // an installer whose first-run screens had quietly gone back to naming
    // mechanisms and printing machine codes at a stranger, with nothing between
    // that and the download.
    //
    // IT RUNS BEFORE build FOR THE SAME REASON verify DOES: it is a statement
    // about the source that is ABOUT to be compiled into the renderer, so
    // running it after packaging would be checking the wrong artifact and
    // paying for a build first.
    name: 'plain-language',
    pattern: /(?:^|\s)(?:node\s+)?\S*check-plain-language\.mjs(?=\s|$)/,
    missing:
      'The dist ship path must run check-plain-language.mjs; otherwise an installer can be produced whose first-run copy has gone back to internal ids, mechanism names and failures with nothing to do about them.',
  },
  {
    name: 'build',
    pattern: /\bnpm\s+run\s+build\b/,
    missing:
      'The dist ship path must build the renderer; otherwise packaging can reuse stale renderer output.',
  },
  {
    // Added after the SHIPPED INSTALLER was measured missing a fix that was
    // present in the checkout, and nothing could see the gap. This stage writes
    // dist/build-info.json -- the only statement an artifact ever makes about
    // which commit it came from -- and dist/** ships it inside app.asar. Measured
    // 2026-08-11: that record was absent from all three app.asar files on the
    // build machine, because `electron-builder` had been run directly and this
    // stage simply never executed. Every downstream gate passed the result.
    //
    // It is enshrined HERE for the same reason the privacy scan below is: a stage
    // that lives only in a package.json string can be dropped by anyone without a
    // test noticing, which is exactly how a control ends up wired to nothing.
    name: 'provenance',
    pattern: /(?:^|\s)(?:node\s+)?\S*require-clean-tree\.mjs\s+dist(?=\s|$)/,
    missing:
      'The dist ship path must run require-clean-tree.mjs against dist; otherwise the installer carries no record of which commit it was built from, and a build produced off this chain becomes indistinguishable from a gated one.',
  },
  {
    name: 'package',
    pattern: /(?:^|\s)electron-builder(?=\s|$).*?--win\s+nsis(?=\s|$)/,
    missing:
      'The dist ship path must run electron-builder with --win nsis; otherwise it does not produce the Windows installer this gate is meant to prove.',
  },
  {
    name: 'strip',
    pattern:
      /(?:^|\s)(?:node\s+)?\S*strip-build-diagnostics\.mjs\s+release(?=\s|$)/,
    missing:
      'The dist ship path must strip build diagnostics from release; otherwise builder-debug.yml can ship the owner\'s home-directory path.',
  },
  {
    // The gate that READS the provenance stage's record back out of the packaged
    // archive. Without it the record is written and never checked, which is how
    // require-clean-tree's promise that dirty:true "ships inside the package,
    // inspectable by anyone holding only the .exe" went unkept by every artifact
    // ever built here. A record nobody reads is not a control.
    name: 'manifest',
    pattern: /(?:^|\s)(?:node\s+)?\S*check-asar-manifest\.mjs\s+release[\\/]win-unpacked(?=\s|$)/,
    missing:
      'The dist ship path must run check-asar-manifest.mjs against release/win-unpacked; otherwise nothing verifies that the archive contains the files the build declares, or that it can state which commit it came from.',
  },
  {
    // Added after the built app.asar -- the exact payload of the installer -- was
    // measured carrying the owner's real name (x20), a credential env var name (x2),
    // the internal repo name, and internal coordination-board references (x18): 53
    // matches in total. tools/check-no-owner-data.mjs existed, was fully unit-tested,
    // and was invoked by NO npm script, so it caught none of it. A commit message
    // asserted it ran automatically on every data file; that claim was false.
    //
    // It is enshrined HERE, and not merely added to the dist string, because a stage
    // present only in package.json can be dropped by anyone without a test noticing --
    // which is exactly how a privacy control ends up wired to nothing twice.
    name: 'privacy',
    pattern:
      /(?:^|\s)(?:node\s+)?\S*check-no-owner-data\.mjs\s+release[\\/]win-unpacked(?=\s|$)/,
    missing:
      'The dist ship path must scan release/win-unpacked for owner data; otherwise the installer can ship the owner\'s name, credential names, and internal repository details to strangers.',
  },
  {
    name: 'smoke',
    pattern:
      /(?:^|\s)(?:node\s+)?\S*smoke-packaged\.mjs\s+release[\\/]win-unpacked(?=\s|$)/,
    missing:
      'The packaged smoke gate must target release/win-unpacked; targeting dist tests only the renderer and leaves the packaged application unproved.',
  },
  {
    // THE WIN-UNPACKED SCAN ABOVE IS NOT THE WHOLE PUBLISH SURFACE, AND THE GAP
    // WAS MEASURED, NOT IMAGINED.
    //
    // Every owner-data scan in the chain targeted release/win-unpacked. Two
    // things that carry the build machine's absolute paths live in release/
    // ITSELF, one directory up, and were therefore never scanned by any build:
    //
    //   - builder-debug.yml, electron-builder's diagnostic sidecar, which records
    //     NSIS include directories under the builder's home directory. It is
    //     swept by strip-build-diagnostics.mjs -- but nothing verified the sweep
    //     worked, so a sweep that silently stopped removing it would not have
    //     been noticed by any gate.
    //   - .artifact-seal-win-unpacked.json, written by seal-artifact.mjs
    //     --record, which until 2026-08-11 stored path.resolve(artifact) and so
    //     wrote "C:\\Users\\<account>\\..." into release/ on EVERY build. Crucially
    //     --record runs AFTER strip-build-diagnostics, so the existing sweep
    //     could not have caught it even in principle, and a fully green build
    //     ended with the leak sitting in the output folder.
    //
    // The installer .exe -- the file a customer actually downloads -- was also
    // never scanned by the chain, only ever the unpacked tree beside it.
    //
    // So the final stage scans release/ whole. It is a superset of the
    // win-unpacked scan and costs one more pass, which is not a meaningful price
    // next to publishing the builder's home directory. It runs LAST because
    // steps after packaging keep writing into that directory.
    name: 'publish-surface',
    pattern: /(?:^|\s)(?:node\s+)?\S*check-no-owner-data\.mjs\s+release(?=\s|$)/,
    missing:
      'The dist ship path must finish by scanning the whole release/ directory for owner data; scanning only release/win-unpacked leaves the installer .exe, builder-debug.yml and the artifact seal — all of which sit one directory up — checked by nothing.',
  },
];

/**
 * Assert that a dist script preserves the fail-closed ship path.
 *
 * Exported so callers can exercise the contract against hypothetical scripts
 * without modifying package.json.
 */
export function assertShipPath(distScript, verifyScript) {
  assert.equal(
    typeof verifyScript,
    'string',
    'scripts.verify:release must exist; otherwise dist has no strict verification gate to invoke.',
  );
  assert.match(
    verifyScript,
    EXPECTED_VERIFY_SCRIPT,
    'scripts.verify:release must run tools/test-ratchet.mjs --strict; otherwise dist can accept a failure baseline.',
  );
  assert.equal(
    typeof distScript,
    'string',
    'scripts.dist must exist; otherwise there is no guarded path that produces the installer.',
  );
  assert.doesNotMatch(
    distScript,
    /[;|]/,
    'Required ship stages must be joined with &&; ; or | can continue into packaging after a failed safety gate.',
  );

  const commands = distScript.split(/\s*&&\s*/);
  const positions = REQUIRED_STAGES.map((stage) => {
    const position = commands.findIndex((command) => stage.pattern.test(command));
    assert.notEqual(position, -1, stage.missing);
    return position;
  });

  assert.equal(
    positions[0],
    0,
    'The verify gate must be the first dist command; work performed before it can create or mutate an artifact before safety checks pass.',
  );

  for (let index = 1; index < positions.length; index += 1) {
    const previous = REQUIRED_STAGES[index - 1];
    const current = REQUIRED_STAGES[index];
    assert.ok(
      positions[index - 1] < positions[index],
      current.name === 'smoke'
        ? 'Packaging and diagnostic stripping must finish before smoke-packaged; otherwise the smoke gate can validate a previous or privacy-unsafe artifact.'
        : `${previous.name} must run before ${current.name}; reversing them allows a later ship stage to invalidate evidence from an earlier gate.`,
    );
  }
}

export function assertTestInstallerPrivacyPath(distTestScript) {
  assert.equal(
    typeof distTestScript,
    'string',
    'scripts.dist:test must exist; otherwise there is no supported test-installer path to protect.',
  );
  assert.doesNotMatch(
    distTestScript,
    /[;|]/,
    'The test-installer privacy stages must be joined with && so packaging cannot continue after a failed gate.',
  );

  const commands = distTestScript.split(/\s*&&\s*/);
  const packagePosition = commands.findIndex(command =>
    /(?:^|\s)(?:node\s+)?\S*installer-identity\.mjs\s+--channel\s+test\s+--exec\s+--win\s+nsis(?=\s|$)/.test(command));
  const stripPosition = commands.findIndex(command =>
    /(?:^|\s)(?:node\s+)?\S*strip-build-diagnostics\.mjs\s+release(?=\s|$)/.test(command));
  const scanPosition = commands.findIndex(command =>
    /(?:^|\s)(?:node\s+)?\S*check-no-owner-data\.mjs\s+release(?=\s|$)/.test(command));

  assert.notEqual(packagePosition, -1, 'dist:test must produce the test installer through installer-identity.mjs.');
  assert.notEqual(
    stripPosition,
    -1,
    'dist:test must remove builder-debug.yml; it records builder and stale cache profile paths.',
  );
  assert.notEqual(
    scanPosition,
    -1,
    'dist:test must scan the complete release directory after packaging for owner and cross-product metadata.',
  );
  assert.ok(
    packagePosition < stripPosition && stripPosition < scanPosition,
    'dist:test must package, then strip builder diagnostics, then scan the resulting release directory.',
  );
}

const VALID_CHAIN =
  'npm run verify:release && node tools/check-plain-language.mjs && npm run build && node tools/require-clean-tree.mjs dist && electron-builder --win nsis && node tools/strip-build-diagnostics.mjs release && node tools/check-asar-manifest.mjs release/win-unpacked && node tools/check-no-owner-data.mjs release/win-unpacked && node tools/smoke-packaged.mjs release/win-unpacked && node tools/check-no-owner-data.mjs release';
const VALID_VERIFY = 'node tools/test-ratchet.mjs --strict';

test('the real package.json dist chain preserves the ship-path contract', () => {
  assertShipPath(packageJson.scripts?.dist, packageJson.scripts?.['verify:release']);
});

test('the real package.json test-installer chain strips and scans its release output', () => {
  assertTestInstallerPrivacyPath(packageJson.scripts?.['dist:test']);
});

test('rejects a test-installer chain that leaves builder-debug.yml in release', () => {
  const badChain = packageJson.scripts['dist:test'].replace(
    ' && node tools/strip-build-diagnostics.mjs release',
    '',
  );
  assert.throws(
    () => assertTestInstallerPrivacyPath(badChain),
    /must remove builder-debug\.yml/,
  );
});

test('rejects a test-installer chain that never scans the complete release directory', () => {
  const badChain = packageJson.scripts['dist:test'].replace(
    ' && node tools/check-no-owner-data.mjs release',
    '',
  );
  assert.throws(
    () => assertTestInstallerPrivacyPath(badChain),
    /must scan the complete release directory/,
  );
});

test('rejects smoke-packaged before electron-builder', () => {
  // Derived from VALID_CHAIN rather than hand-written. This case previously
  // carried its own copy of the chain, which silently went stale the moment a
  // stage was added: it then threw about the MISSING stage instead of the
  // ordering it exists to prove, and still read as a pass because assert.throws
  // was matching a pattern that no longer described why it threw.
  const SMOKE = ' && node tools/smoke-packaged.mjs release/win-unpacked';
  const badChain = VALID_CHAIN.replace(SMOKE, '').replace(
    ' && electron-builder --win nsis',
    `${SMOKE} && electron-builder --win nsis`,
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /Packaging and diagnostic stripping must finish before smoke-packaged/,
  );
});

test('rejects a chain with strip-build-diagnostics deleted', () => {
  const badChain = VALID_CHAIN.replace(
    ' && node tools/strip-build-diagnostics.mjs release',
    '',
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /builder-debug\.yml can ship the owner's home-directory path/,
  );
});

test('rejects a chain with the owner-data privacy scan deleted', () => {
  // The gate this proves exists because the previous privacy control was fully
  // unit-tested and invoked by nothing, so it caught 53 owner-data matches in the
  // shipped app.asar. A stage that cannot be shown to bite is the same defect again.
  const badChain = VALID_CHAIN.replace(
    ' && node tools/check-no-owner-data.mjs release/win-unpacked',
    '',
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /must scan release[\\/]win-unpacked for owner data/,
  );
});

// The win-unpacked scan staying in place is exactly what made this gap hard to
// see: the chain looked privacy-gated, and was, for the one directory it named.
// Anchored to the END of the chain on purpose -- the removed text is a PREFIX of
// the win-unpacked command, so a plain string replace would delete the wrong
// stage and this test would pass for the wrong reason.
test('rejects a chain that scans only win-unpacked and never the whole release directory', () => {
  const badChain = VALID_CHAIN.replace(/ && node tools\/check-no-owner-data\.mjs release$/, '');

  assert.notEqual(badChain, VALID_CHAIN, 'the publish-surface stage must actually have been removed');
  assert.match(
    badChain,
    /check-no-owner-data\.mjs release\/win-unpacked/,
    'the win-unpacked scan must survive, so this proves the WIDER scan is required rather than any scan at all',
  );
  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /must finish by scanning the whole release[\\/] directory/,
  );
});

test('rejects non-fail-closed separators', () => {
  const badChain = VALID_CHAIN.replaceAll(' && ', ' ; ');

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /can continue into packaging after a failed safety gate/,
  );
});

test('rejects smoke-packaged targeting the renderer dist directory', () => {
  const badChain = VALID_CHAIN.replace(
    'smoke-packaged.mjs release/win-unpacked',
    'smoke-packaged.mjs dist',
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /targeting dist tests only the renderer/,
  );
});

test('rejects a chain with the provenance record deleted', () => {
  // The measured incident: the installed application did not contain that
  // night's fix, and no one could tell, because the artifact could not say
  // which commit it was. This stage is what makes it able to say.
  const badChain = VALID_CHAIN.replace(
    ' && node tools/require-clean-tree.mjs dist',
    '',
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /carries no record of which commit it was built from/,
  );
});

test('rejects a chain with the packaged archive gate deleted', () => {
  const badChain = VALID_CHAIN.replace(
    ' && node tools/check-asar-manifest.mjs release/win-unpacked',
    '',
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /must run check-asar-manifest\.mjs against release[\\/]win-unpacked/,
  );
});

test('rejects recording provenance before the renderer build that erases it', () => {
  // Not a stylistic ordering rule. There is no vite.config in this repo, so
  // `vite build` runs with emptyOutDir defaulted on and WIPES dist/. A
  // build-info.json written before that step is deleted before electron-builder
  // can pack it, and the chain then looks fully gated while shipping an artifact
  // that still cannot state what it is -- the worst of both, since the terminal
  // shows the gate passing.
  // Derived from VALID_CHAIN, not hand-written, for the reason the
  // smoke-ordering case above already records: a private copy of the chain goes
  // stale the moment a stage is added, and then throws about the MISSING stage
  // while still reading as a pass. That is not hypothetical here -- this case
  // was a literal string and did exactly that when the publish-surface stage
  // was added.
  const PROVENANCE = ' && node tools/require-clean-tree.mjs dist';
  const badChain = VALID_CHAIN.replace(PROVENANCE, '').replace(
    ' && npm run build',
    `${PROVENANCE} && npm run build`,
  );

  assert.throws(
    () => assertShipPath(badChain, VALID_VERIFY),
    /build must run before provenance/,
  );
});
