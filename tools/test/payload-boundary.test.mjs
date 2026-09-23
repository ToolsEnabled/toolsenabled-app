import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// THE POINT OF THIS SUITE.
//
// tools/check-payload-boundary.mjs is the only mechanical thing standing between the
// owner's open/paid decision and a public release of the paid part. A guard nobody
// proved can fail is a guard that has never been shown to do anything. So every test
// below drives the REAL guard as a subprocess and asserts on its REAL exit code:
//
//   0  clean      1  violation (build must stop)      2  manifest/setup error
//
// and, where a file must be caught, asserts that the guard NAMED it. Never that a
// count changed -- this project has already been bitten once by concluding from a
// "216 -> 221 files" coincidence that something had shipped when it had not.

const GUARD = fileURLToPath(new URL("../check-payload-boundary.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REAL_MANIFEST = path.join(REPO_ROOT, "config", "payload-boundary.json");

function runGuard(manifestPath, payloadDirectory, { ship = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [GUARD, "--manifest", manifestPath, payloadDirectory, ...(ship ? ["--ship"] : [])],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A minimal, self-contained world: a manifest and a payload directory, both written
// from scratch so no test depends on the state of a real build.
async function withFixture(run) {
  const home = await mkdtemp(path.join(tmpdir(), "payload-boundary-"));
  try {
    const payload = path.join(home, "payload");
    await mkdir(payload, { recursive: true });

    const writeManifest = async (manifest) => {
      const file = path.join(home, "boundary.json");
      await writeFile(file, typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
      return file;
    };
    const writePayloadFile = async (relative, contents = "// fixture\n") => {
      const absolute = path.join(payload, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
      return absolute;
    };

    await run({ home, payload, writeManifest, writePayloadFile });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const OPEN_FILE = "src/lib/open-thing.js";
const PAID_FILE = "src/lib/paid-thing.js";
const PENDING_FILE = "src/lib/undecided-thing.js";

function baseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "proposed",
    open: { paths: [OPEN_FILE] },
    paid: { paths: [PAID_FILE], prefixes: [] },
    excluded: { paths: [], prefixes: ["state/"] },
    pending: { [PENDING_FILE]: "proposed paid; owner has not ruled" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The green path. If this ever fails, every red-path test below is meaningless.
// ---------------------------------------------------------------------------

test("clean payload exits 0", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Payload boundary: clean/);
  });
});

// ---------------------------------------------------------------------------
// FAILS, does not warn. Each of the three violation classes stops the build.
// ---------------------------------------------------------------------------

test("a paid file in the payload FAILS the build and is named", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile(PAID_FILE);
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /PAYLOAD BOUNDARY VIOLATION/);
    assert.match(result.output, new RegExp(PAID_FILE.replace(/[/.]/g, "\\$&")));
  });
});

test("a paid PREFIX catches a file that was never listed individually", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile("src/lib/paid/anything-at-all.js");
    const manifest = baseManifest();
    manifest.paid.prefixes = ["src/lib/paid/"];
    const result = runGuard(await writeManifest(manifest), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /anything-at-all\.js/);
  });
});

test("an excluded file FAILS the build", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile("state/mission-bridge-token.json", '{"token":"fixture"}');
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /MUST NOT SHIP AT ALL/);
    assert.match(result.output, /mission-bridge-token\.json/);
  });
});

// THE RULE THAT MAKES THIS GATE HOLD OVER TIME. A file nobody classified is a
// failure, not an open file. Without this, every module added after today ships
// publicly by silence.
test("an UNCLASSIFIED file FAILS the build rather than defaulting to open", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile("src/lib/added-next-month.js");
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /UNCLASSIFIED/);
    assert.match(result.output, /added-next-month\.js/);
  });
});

// TYPO SAFETY. A misspelled paid rule matches nothing -- but so does the real file,
// which then lands in unclassified and still fails. A mistyped boundary cannot
// silently ship the thing it was written to hold back.
test("a MISSPELLED paid rule still fails, via the unclassified rule", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile(PAID_FILE);
    const manifest = baseManifest();
    manifest.paid.paths = ["src/lib/paid-thnig.js"]; // deliberate typo
    const result = runGuard(await writeManifest(manifest), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, new RegExp(PAID_FILE.replace(/[/.]/g, "\\$&")));
  });
});

// ---------------------------------------------------------------------------
// Named paths, never counts.
// ---------------------------------------------------------------------------

test("two payloads with the SAME file count get opposite verdicts", async () => {
  // The 216->221 near-miss in one sentence: size tells you nothing about content.
  // Same number of files, one clean and one carrying the paid module.
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    const manifestFile = await writeManifest(baseManifest());
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile(PENDING_FILE);
    const clean = runGuard(manifestFile, payload);
    assert.equal(clean.status, 0, clean.output);

    await rm(path.join(payload, PENDING_FILE));
    await writePayloadFile(PAID_FILE);
    const dirty = runGuard(manifestFile, payload);
    assert.equal(dirty.status, 1, dirty.output);
    assert.match(dirty.output, /Files seen: 2\b/);
    assert.match(clean.output, /Files seen: 2\b/);
  });
});

// ---------------------------------------------------------------------------
// Precedence. A mistake in the open list must never unblock something held back.
// ---------------------------------------------------------------------------

test("an excluded prefix wins over an exact open path inside it", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile("state/kept-by-mistake.json", "{}");
    const manifest = baseManifest();
    manifest.open.paths = ["state/kept-by-mistake.json"];
    const result = runGuard(await writeManifest(manifest), payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /MUST NOT SHIP AT ALL/);
  });
});

// ---------------------------------------------------------------------------
// Pending: reported loudly, never fatal. This is what keeps a proposal from
// being expressed as a red build over a decision nobody has made yet.
// ---------------------------------------------------------------------------

test("a pending file is reported with its reason and does NOT fail the build", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    await writePayloadFile(PENDING_FILE);
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /PROPOSED for removal/);
    assert.match(result.output, /owner has not ruled/);
  });
});

// THE PROPOSED NOTICE MUST NOT SEND THE READER LOOKING FOR A DECISION.
//
// This test used to pin the literal phrase "has not been ratified by the owner".
// That phrase was false -- the owner ruled on every entry, and twenty-three of
// those decisions are executed -- and pinning it made the falsehood load-bearing:
// correcting the tool turned this suite red, which is pressure to restore the
// wrong sentence rather than fix it.
//
// So the assertions below are about MEANING, not wording. The notice must say the
// pending paths still ship and that ratification follows from emptying pending;
// it must not claim a decision is outstanding. The negative assertion is the point
// of the test -- a phrase that was wrong once is exactly the one worth forbidding.
test("status 'proposed' explains the mechanism, not a missing decision", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 0, result.output);

    assert.match(result.output, /still shipping/, 'the notice must say pending paths still ship');
    assert.match(result.output, /owner-ratified/, 'the notice must name the status it becomes');

    assert.doesNotMatch(
      result.output,
      /has not been ratified by the owner|once the owner has ruled/,
      'the notice claims a decision is outstanding. The owner has ruled on every entry; the status ' +
        'is held by pending files, not by a missing signature, and a reader told otherwise goes ' +
        'hunting for a decision instead of removing the files.',
    );
  });
});

// RATIFICATION FORCES A DECISION. "The owner decided" and "these are undecided"
// cannot both be true, so flipping the status is impossible until pending is empty.
test("ratifying while items are still pending is a manifest error", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const result = runGuard(await writeManifest(baseManifest({ status: "owner-ratified" })), payload);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /cannot contain\s+undecided items/);
  });
});

test("ratifying with an empty pending list is accepted", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const manifest = baseManifest({ status: "owner-ratified" });
    manifest.pending = {};
    const result = runGuard(await writeManifest(manifest), payload);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /has not been ratified/);
  });
});

// ---------------------------------------------------------------------------
// Setup problems exit 2, never 0 and never 1. A broken boundary must not read as
// a clean payload, and must not read as a leak either -- different fixes.
// ---------------------------------------------------------------------------

for (const [name, manifest, expected] of [
  ["missing schemaVersion", { status: "proposed", open: { paths: [] } }, /schemaVersion must be 1/],
  ["unknown status", baseManifest({ status: "approved-ish" }), /status must be/],
  ["open using prefixes", baseManifest({ open: { paths: [], prefixes: ["src/"] } }), /"open" may not use prefixes/],
  [
    "a path in two classes",
    baseManifest({ open: { paths: [OPEN_FILE, PAID_FILE] } }),
    /declared in both/,
  ],
  [
    "a pending entry with no reason",
    baseManifest({ pending: { [PENDING_FILE]: "   " } }),
    /has no reason/,
  ],
  ["a backslash path", baseManifest({ open: { paths: ["src\\lib\\thing.js"] } }), /uses a backslash/],
  ["an absolute path", baseManifest({ open: { paths: ["C:/x/thing.js"] } }), /is absolute/],
  ["a dot-slash path", baseManifest({ open: { paths: ["./thing.js"] } }), /not in normal form/],
  [
    "a prefix without a trailing slash",
    baseManifest({ excluded: { paths: [], prefixes: ["state"] } }),
    /must end with "\/"/,
  ],
  ["a JSON array instead of an object", [], /must be a JSON object/],
]) {
  test(`manifest error: ${name} exits 2`, async () => {
    await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
      await writePayloadFile(OPEN_FILE);
      const result = runGuard(await writeManifest(manifest), payload);
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /Payload boundary guard error/);
      assert.match(result.output, expected);
    });
  });
}

test("a missing manifest exits 2, not 0", async () => {
  await withFixture(async ({ home, payload, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const result = runGuard(path.join(home, "no-such-manifest.json"), payload);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /is missing/);
  });
});

test("unreadable JSON exits 2, not 0", async () => {
  await withFixture(async ({ payload, writeManifest, writePayloadFile }) => {
    await writePayloadFile(OPEN_FILE);
    const result = runGuard(await writeManifest("{ not json"), payload);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /unreadable/);
  });
});

// Scanning nothing must never report success -- the same rule the owner-data guard
// and the suite-discovery guard already apply to themselves.
test("an empty payload directory exits 2 rather than reporting clean", async () => {
  await withFixture(async ({ payload, writeManifest }) => {
    const result = runGuard(await writeManifest(baseManifest()), payload);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /scanned 0 files/);
  });
});

test("a payload directory that does not exist exits 2", async () => {
  await withFixture(async ({ home, writeManifest }) => {
    const result = runGuard(await writeManifest(baseManifest()), path.join(home, "no-such-payload"));
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /does not exist/);
  });
});

// ---------------------------------------------------------------------------
// The real repository, not a fixture. A guard that only works on fixtures, or is
// never invoked by the build, protects nothing.
// ---------------------------------------------------------------------------

test("the repository's own boundary manifest is valid", async () => {
  const manifest = JSON.parse(await readFile(REAL_MANIFEST, "utf8"));
  assert.ok(Array.isArray(manifest.open?.paths) && manifest.open.paths.length > 0, "open.paths must be non-empty");
  await withFixture(async ({ payload, writePayloadFile }) => {
    // One real open path is enough to prove the real manifest loads, validates and
    // classifies -- a manifest error would exit 2 before any file is looked at.
    await writePayloadFile(manifest.open.paths[0]);
    const result = runGuard(REAL_MANIFEST, payload);
    assert.equal(result.status, 0, result.output);
  });
});

// These customer-side runtime modules were already reached by the packer's
// graph, but absent from the installer's classification. Keep the reviewed
// names independent of open.paths so another omission cannot erase its test.
// The fixtures exercise filename classification, not runtime correctness or
// installer qualification; the full packed graph has its own boundary check.
const REVIEWED_DESKTOP_RUNTIME_PATHS = [
  "src/lib/agent-engine/codex-startup-cleanup.js",
  "src/lib/agent-engine/startup-control.js",
  "src/lib/agent-resource-admission.js",
  "src/lib/agent-resource-channel.js",
  "src/lib/agent-resource-control.js",
  "src/lib/agent-resource-host.js",
  "src/lib/agent-resource-monitor.js",
  "src/lib/byte-tool-refusal.js",
  "src/lib/file-tool-context.js",
  "src/lib/installed-role-memory.js",
  "src/lib/region-holds/byte-authority.js",
  "src/lib/research/provenance.js",
  "src/lib/research/study-protocol.js",
];

test("the real manifest classifies reviewed desktop runtime paths under build and ship verdicts", async () => {
  await withFixture(async ({ payload, writePayloadFile }) => {
    for (const relative of REVIEWED_DESKTOP_RUNTIME_PATHS) await writePayloadFile(relative);
    for (const ship of [false, true]) {
      const result = runGuard(REAL_MANIFEST, payload, { ship });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Payload boundary: clean/);
    }
  });
});

test("reviewed runtime paths do not permit an unreviewed sibling in any affected directory", async () => {
  await withFixture(async ({ payload, writePayloadFile }) => {
    for (const relative of REVIEWED_DESKTOP_RUNTIME_PATHS) await writePayloadFile(relative);
    const directories = [...new Set(REVIEWED_DESKTOP_RUNTIME_PATHS.map(relative => path.posix.dirname(relative)))];
    for (const directory of directories) {
      const unknown = `${directory}/unreviewed-runtime.js`;
      const file = await writePayloadFile(unknown);
      for (const ship of [false, true]) {
        const result = runGuard(REAL_MANIFEST, payload, { ship });
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /UNCLASSIFIED/);
        assert.ok(result.output.includes(`  ${unknown}`), `The unknown path must be named:\n${result.output}`);
      }
      await rm(file);
    }
  });
});

test("the real manifest's paid paths are still refused when planted", async () => {
  const manifest = JSON.parse(await readFile(REAL_MANIFEST, "utf8"));
  const paidPath = manifest.paid?.paths?.[0];
  assert.ok(paidPath, "the real manifest must declare at least one paid path to prove enforcement");
  await withFixture(async ({ payload, writePayloadFile }) => {
    await writePayloadFile(manifest.open.paths[0]);
    await writePayloadFile(paidPath);
    const result = runGuard(REAL_MANIFEST, payload);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, new RegExp(paidPath.replace(/[/.]/g, "\\$&")));
  });
});

test("the real manifest refuses excluded private provider surfaces if an engine snapshot reintroduces them", async () => {
  const manifest = JSON.parse(await readFile(REAL_MANIFEST, "utf8"));
  const forbiddenPaths = [
    "src/lib/providers/owner-identity-profile.js",
    "src/lib/providers/vertex-gemini.js",
  ];
  for (const forbiddenPath of forbiddenPaths) {
    assert.ok(manifest.excluded?.paths?.includes(forbiddenPath), `${forbiddenPath} must remain excluded`);
    assert.ok(!manifest.open?.paths?.includes(forbiddenPath), `${forbiddenPath} must never be classified open`);
    await withFixture(async ({ payload, writePayloadFile }) => {
      await writePayloadFile(manifest.open.paths[0]);
      await writePayloadFile(forbiddenPath);
      const result = runGuard(REAL_MANIFEST, payload);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /MUST NOT SHIP AT ALL/);
      assert.match(result.output, new RegExp(forbiddenPath.replace(/[/.]/g, "\\$&")));
    });
  }
});

// A GATE THAT IS NOT WIRED INTO THE BUILD IS A FILE, NOT A GATE. This project has
// already had a standing order retired in one tree change nothing because the live
// hook ran from another. Assert the wiring, not the intention.
test("npm run dist actually invokes this guard, on both payload copies", async () => {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const dist = manifest.scripts?.dist ?? "";
  assert.match(dist, /check-payload-boundary\.mjs/, "dist must run the payload-boundary guard");
  assert.match(
    dist,
    /check-payload-boundary\.mjs capability\b/,
    "dist must check the staged payload, so a bad stage fails before a 100 MB installer is built",
  );
  assert.match(
    dist,
    /check-payload-boundary\.mjs release\/win-unpacked\/resources\/capability/,
    "dist must also check the payload as electron-builder actually copied it -- that is the thing that ships",
  );
});
