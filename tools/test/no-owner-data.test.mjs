import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const realGuardPath = fileURLToPath(new URL("../check-no-owner-data.mjs", import.meta.url));
const FIXTURE_ACCOUNT = "fixture-builder";
const FIXTURE_ALIAS = "fixture-private-alias";
const FIXTURE_NETWORK = "198.51.100.";
// The shipped direct-cable setup sentence (engine config/settings-registry.json) and the
// LAN prefix a builder would list if their own network used it.
const HELP_TEXT_SENTENCE =
  "192.168.50.1 and 192.168.50.2 with subnet mask 255.255.255.0 work; so does any other pair you prefer.";
const HELP_TEXT_LAN = "192.168.50.";

async function withFixture(run, { network = FIXTURE_NETWORK } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "no-owner-data-"));
  try {
    const tools = path.join(home, "tools");
    const privateDirectory = path.join(home, "private");
    const fixture = path.join(home, "bundle");
    await mkdir(tools, { recursive: true });
    await mkdir(privateDirectory, { recursive: true });
    await mkdir(fixture, { recursive: true });

    const guardPath = path.join(tools, "check-no-owner-data.mjs");
    await copyFile(realGuardPath, guardPath);
    await writeFile(
      path.join(privateDirectory, "owner-data-patterns.owner.json"),
      JSON.stringify({
        patterns: [
          { value: FIXTURE_ACCOUNT },
          { value: FIXTURE_ALIAS },
          { value: network, caseSensitive: true },
        ],
      }),
    );

    await run({ fixture, guardPath });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function runGuard(guardPath, directory) {
  const result = spawnSync(process.execPath, [guardPath, directory], {
    encoding: "utf8",
    env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: FIXTURE_ACCOUNT },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

test("fails for a private-network address in JavaScript", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    const filename = "network.js";
    await writeFile(path.join(fixture, filename), `const host = '${FIXTURE_NETWORK}42';`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, new RegExp(filename));
    assert.match(result.output, /198\.51\.100\./);
  });
});

test("fails for a configured identity value in a path-like string", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(
      path.join(fixture, "path.txt"),
      `C:\\profiles\\${FIXTURE_ALIAS}\\project`,
    );
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /fixture-private-alias/i);
  });
});

test("fails for a Windows users path", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(path.join(fixture, "windows-path.txt"), String.raw`C:\Users\someone`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /windows-path\.txt/);
    assert.match(result.output, /C:\\\\Users/);
  });
});

test("recurses into deeply nested directories", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    const nested = path.join(fixture, "one", "two", "three");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "deep.txt"), FIXTURE_ACCOUNT.toUpperCase());
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /deep\.txt/);
  });
});

test("scans files without an extension", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(path.join(fixture, "artifact"), `${FIXTURE_NETWORK}99`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /artifact/);
  });
});

test("finds a leak in a minified single-line file", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    const filename = "bundle.min.js";
    await writeFile(path.join(fixture, filename), `(()=>{const x="${"a".repeat(200)}C:/Users/person${"z".repeat(200)}"})()`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /bundle\.min\.js/);
    assert.match(result.output, /C:\/Users/);
  });
});

test("passes a clean non-empty fixture", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(path.join(fixture, "clean.json"), JSON.stringify({ status: "clean" }));
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Scanned 1 files/);
    assert.match(result.output, /Total matches: 0/);
  });
});

// THE BUILDER-CHECKOUT RULE, BOTH DIRECTIONS. It had no coverage at all, which
// is how it came to match `s://` inside `https://toolsenabled.com` -- the
// product's own website URL -- and stayed that way. The refusal case is listed
// first and deliberately: a guard that stops refusing real leaks is far worse
// than one that refuses a URL, so the pair is pinned together and neither test
// is meaningful without the other.
test("fails for a drive-rooted builder checkout path", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(path.join(fixture, "checkout.txt"), String.raw`D:\dev\ToolsEnabled\src\index.js`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /checkout\.txt/);
    assert.match(result.output, /builder checkout path/i);
  });
});

test("fails for a builder checkout path preceded by a digit", async () => {
  // `\b` would have let this through; the lookbehind rejects only letters.
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(path.join(fixture, "digit.txt"), String.raw`disk9C:\build\toolsenabled\out`);
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /builder checkout path/i);
  });
});

test("passes the product's own website URL", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(
      path.join(fixture, "footer.html"),
      '<a href="https://toolsenabled.com/support">Support</a> ws://toolsenabled.com/relay',
    );
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Total matches: 0/);
  });
});

test("an explicitly supplied empty directory is not a silent success", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    const result = runGuard(guardPath, fixture);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /nothing to check/i);
    assert.match(result.output, /scanned 0 files/i);
  });
});

test("a builder LAN prefix inside the exact shipped help sentence is excused and counted", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(
      path.join(fixture, "settings-registry.json"),
      JSON.stringify({ do: `Give the two computers different addresses on the same small network. ${HELP_TEXT_SENTENCE}` }),
    );
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Total matches: 0\./);
    assert.match(result.output, /Excused as published documentation example: 2 /);
  }, { network: HELP_TEXT_LAN });
});

test("the same LAN prefix outside the exact help sentence still fails", async () => {
  await withFixture(async ({ fixture, guardPath }) => {
    await writeFile(
      path.join(fixture, "settings-registry.json"),
      JSON.stringify({ do: HELP_TEXT_SENTENCE, gateway: `${HELP_TEXT_LAN}7` }),
    );
    await writeFile(path.join(fixture, "edited.txt"), HELP_TEXT_SENTENCE.replace("192.168.50.1", "192.168.50.9"));
    const result = runGuard(guardPath, fixture);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /edited\.txt \| pattern=profile#3 \| matches=2/);
    assert.match(result.output, /settings-registry\.json \| pattern=profile#3 \| matches=\d+/);
  }, { network: HELP_TEXT_LAN });
});
