// THE LOCAL OWNER PROFILE.
//
// private/owner-data-patterns.owner.json is deliberately local and ignored: the owner's
// working configuration remains available on this machine without becoming repository
// data. A profile can still arrive from an unsafe cache, shared build host, or manual
// copy. Before the check these tests pin, a build with somebody else's profile could run
// the privacy guard, scan every byte of the bundle, and print "Total matches: 0" -- while
// looking for the wrong name, username and aliases. Exit 0. A green gate aimed at the
// wrong person.
//
// That is the same failure this repo has now met repeatedly: a control that passes
// because of what it was NOT given. The empty-profile case was already closed; the
// wrong-profile case was not, and it is worse, because a filled-in file looks correct.
//
// These tests exist so the ownership check cannot be quietly removed. The important one
// is the first: the guard must exit 2 (setup error), never 0 (false clean), when the
// profile describes somebody else.

import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const realGuardPath = fileURLToPath(new URL("../check-no-owner-data.mjs", import.meta.url));

// The real profile, read once, so these tests assert against what actually ships rather
// than a restatement of it.
const REAL_PROFILE_PATH = fileURLToPath(
  new URL("../../private/owner-data-patterns.owner.json", import.meta.url),
);

// A name no plausible identity profile mentions, used to play the stranger.
const STRANGER_ACCOUNT = "ada-lovelace-9f2c";
const STRANGER_PROFILE = {
  patterns: [
    { value: STRANGER_ACCOUNT },
    { value: "Ada Lovelace" },
    { value: "10.0.0.", caseSensitive: true },
  ],
};

function run(guardPath, directory, environment = {}) {
  const result = spawnSync(process.execPath, [guardPath, directory], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// A setup failure must read as one sentence to a new user, not as a traceback. Node
// prints "    at <frame>" lines for an uncaught throw; main().catch is what keeps them
// away, and a regression that moves the load back to module scope shows up here.
function assertNoStackTrace(output) {
  assert.doesNotMatch(output, /^\s+at\s/m, `expected no Node stack trace, got:\n${output}`);
  assert.doesNotMatch(output, /\bthrow\b\s+(?:er|error);/, output);
}

/**
 * Build a throwaway copy of the guard with a profile of our choosing.
 *
 * The guard resolves its profile relative to its OWN location, so copying the single
 * self-contained script into <tmp>/tools/ makes <tmp> the repo root it reads. That is
 * how the missing / empty / malformed / stranger-owned profile cases get exercised
 * without touching the real private profile, which other agents and the live ship path use.
 */
async function withGuardCopy(profile, run_) {
  const home = await mkdtemp(path.join(os.tmpdir(), "identity-profile-"));
  try {
    await mkdir(path.join(home, "tools"), { recursive: true });
    await mkdir(path.join(home, "private"), { recursive: true });
    const bundle = path.join(home, "bundle");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "clean.json"), JSON.stringify({ status: "clean" }));

    const guardPath = path.join(home, "tools", "check-no-owner-data.mjs");
    await copyFile(realGuardPath, guardPath);

    if (profile !== undefined) {
      const profilePath = path.join(home, "private", "owner-data-patterns.owner.json");
      await writeFile(
        profilePath,
        typeof profile === "string" ? profile : JSON.stringify(profile, null, 2),
      );
    }

    await run_({ guardPath, bundle, home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a profile describing somebody else is a setup error, not a clean scan", async () => {
  await withGuardCopy(STRANGER_PROFILE, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /somebody else's identity profile/);
    assert.match(result.output, /does not mention the account building this/);
    assert.match(result.output, new RegExp(os.userInfo().username, "i"));
    assert.match(result.output, /owner-data-patterns\.example\.json/);
    assertNoStackTrace(result.output);
    // The defect in one assertion: it must never look like a passing scan.
    assert.doesNotMatch(result.output, /Total matches: 0/);
  });
});

test("a stranger's profile is rejected before scanning unrelated owner data", async () => {
  // Ordering proof. If ownership were checked after the walk -- or not at all -- this
  // bundle would be reported clean because its synthetic owner value is not in the
  // stranger's profile. Exit 2 means the build stopped before it could believe that.
  await withGuardCopy({ patterns: [{ value: STRANGER_ACCOUNT }] }, async ({ guardPath, bundle }) => {
    await writeFile(path.join(bundle, "leak.js"), 'const owner = "synthetic-owner-value-6";');
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /somebody else's identity profile/);
    assert.doesNotMatch(result.output, /Scanned \d+ files/);
  });
});

test("a profile mentioning the building account passes", async () => {
  await withGuardCopy(
    { patterns: [{ value: os.userInfo().username }, { value: "Some Owner" }] },
    async ({ guardPath, bundle }) => {
      const result = run(guardPath, bundle);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Total matches: 0/);
    },
  );
});

test("a longer alias containing the account name counts as the same person", async () => {
  await withGuardCopy(
    { patterns: [{ value: `${os.userInfo().username}-workstation-01` }] },
    async ({ guardPath, bundle }) => {
      const result = run(guardPath, bundle);
      assert.equal(result.status, 0, result.output);
    },
  );
});

test("an account name containing a shorter profile entry counts as the same person", async () => {
  await withGuardCopy({ patterns: [{ value: "buildbot" }] }, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle, { MC_IDENTITY_PROFILE_ACCOUNT: "buildbot-runner-7" });
    assert.equal(result.status, 0, result.output);
  });
});

test("the account match is case-insensitive", async () => {
  await withGuardCopy({ patterns: [{ value: "BuildBot" }] }, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle, { MC_IDENTITY_PROFILE_ACCOUNT: "buildbot" });
    assert.equal(result.status, 0, result.output);
  });
});

test("MC_IDENTITY_PROFILE_ACCOUNT renames the account checked, it does not switch the check off", async () => {
  await withGuardCopy(STRANGER_PROFILE, async ({ guardPath, bundle }) => {
    // The escape hatch is for a CI or shared build machine whose account name is
    // legitimately not the profile owner's. Naming an account the profile does not
    // mention must fail exactly as the unset case does -- otherwise the variable is a
    // one-line bypass of the whole control.
    const result = run(guardPath, bundle, { MC_IDENTITY_PROFILE_ACCOUNT: "someone-unrelated" });
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /somebody else's identity profile/);
    assert.match(result.output, /someone-unrelated/);
    assertNoStackTrace(result.output);
  });
});

test("an empty MC_IDENTITY_PROFILE_ACCOUNT is refused rather than treated as a match", async () => {
  // The empty string is a substring of every pattern. Accepting a blank override would
  // make every profile match every builder -- the disabled-check hole with extra steps.
  await withGuardCopy(STRANGER_PROFILE, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle, { MC_IDENTITY_PROFILE_ACCOUNT: "   " });
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /cannot switch the check off/);
    assertNoStackTrace(result.output);
  });
});

test("built-in product patterns cannot vouch for an account", async () => {
  // "C:\\Users" contains "user". Built-ins describe the product, not a person; if they
  // counted, an account named "user" would be endorsed by a profile belonging to anyone.
  await withGuardCopy(STRANGER_PROFILE, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle, { MC_IDENTITY_PROFILE_ACCOUNT: "user" });
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /somebody else's identity profile/);
  });
});

test("the shipped example template does not pass as anyone's profile", async () => {
  // Copying the template and forgetting to fill it in must not produce a green gate.
  const example = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../config/owner-data-patterns.example.json", import.meta.url)),
      "utf8",
    ),
  );
  await withGuardCopy(example, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /somebody else's identity profile/);
  });
});

test("the local owner profile belongs to the account building here", async () => {
  // Guards the live configuration itself, on the real guard, against the real bundle
  // path being irrelevant: an empty fixture would exit 2 for a different reason, so this
  // uses a clean file and asserts a real scan happened.
  const fixture = await mkdtemp(path.join(os.tmpdir(), "identity-profile-real-"));
  try {
    await writeFile(path.join(fixture, "clean.json"), JSON.stringify({ status: "clean" }));
    const result = run(realGuardPath, fixture);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Total matches: 0/);
    assert.doesNotMatch(result.output, /somebody else's identity profile/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  // And the profile that made that true is the ignored local one, not an accident of the
  // current directory.
  assert.ok(
    REAL_PROFILE_PATH.endsWith(path.join("private", "owner-data-patterns.owner.json")),
  );
});

test("a missing profile is still a hard error", async () => {
  await withGuardCopy(undefined, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /is missing/);
    assertNoStackTrace(result.output);
  });
});

test("an empty patterns array is still a hard error", async () => {
  await withGuardCopy({ patterns: [] }, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /declares no patterns/);
    assertNoStackTrace(result.output);
  });
});

test("a malformed profile is still a hard error", async () => {
  await withGuardCopy("{ not json", async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /unreadable/);
    assertNoStackTrace(result.output);
  });
});

test("a profile with no patterns array is still a hard error", async () => {
  await withGuardCopy({ comment: "no patterns key" }, async ({ guardPath, bundle }) => {
    const result = run(guardPath, bundle);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /must contain a "patterns" array/);
    assertNoStackTrace(result.output);
  });
});
