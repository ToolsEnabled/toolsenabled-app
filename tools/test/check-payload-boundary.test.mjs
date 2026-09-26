import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { symlinkCapability } from "./symlink-capability.mjs";

const GATE = fileURLToPath(new URL("../check-payload-boundary.mjs", import.meta.url));

function runGate(gate, manifest, payload) {
  const result = spawnSync(process.execPath, [gate, "--manifest", manifest, payload], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

async function withFixture(run) {
  const fixture = await mkdtemp(path.join(tmpdir(), "check-payload-boundary-"));
  const payload = path.join(fixture, "payload");
  const manifest = path.join(fixture, "payload-boundary.json");
  try {
    await mkdir(payload);
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        status: "owner-ratified",
        open: { paths: ["open.js"] },
        paid: { paths: ["paid.js"], prefixes: [] },
        excluded: { paths: [], prefixes: [] },
        pending: {},
      }),
    );
    await run({ fixture, manifest, payload });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("check-payload-boundary.mjs executes and FAILS through a differently named copy", async () => {
  await withFixture(async ({ fixture, manifest, payload }) => {
    const copiedGate = path.join(fixture, "CHECK-PAYLOAD-BOUNDARY-COPY.mjs");
    await copyFile(GATE, copiedGate);
    await writeFile(path.join(payload, "paid.js"), "// must not ship\n");

    const result = runGate(copiedGate, manifest, payload);

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /PAYLOAD BOUNDARY VIOLATION/);
    assert.match(result.output, /paid\.js/);
  });
});

test("an empty payload refuses instead of passing without looking", async () => {
  await withFixture(async ({ manifest, payload }) => {
    const result = runGate(GATE, manifest, payload);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /nothing to check: scanned 0 files/);
  });
});

test("a missing payload refuses instead of treating absence as satisfied", async () => {
  await withFixture(async ({ fixture, manifest }) => {
    const missing = path.join(fixture, "previously-present-payload");
    const result = runGate(GATE, manifest, missing);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /nothing to check: directory does not exist/);
  });
});

test("an undeclared extra payload file FAILS and is named", async () => {
  await withFixture(async ({ manifest, payload }) => {
    await writeFile(path.join(payload, "open.js"), "// declared\n");
    await writeFile(path.join(payload, "undeclared-extra.js"), "// not declared\n");
    const result = runGate(GATE, manifest, payload);

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /UNCLASSIFIED/);
    assert.match(result.output, /undeclared-extra\.js/);
  });
});

test("requires symlink creation: a symlinked payload root refuses rather than judging the target directory", async (t) => {
  const capability = symlinkCapability();
  if (!capability.available) {
    return t.skip(`${capability.reason}; the symlinked-payload-root assertion was therefore NOT checked`);
  }
  await withFixture(async ({ fixture, manifest, payload }) => {
    await writeFile(path.join(payload, "open.js"), "// declared\n");
    const linkedPayload = path.join(fixture, "payload-link");
    await symlink(payload, linkedPayload, "dir");
    const result = runGate(GATE, manifest, linkedPayload);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /nothing to check: refusing to follow symlink/);
  });
});

test("a healthy declared payload still passes after blind-condition checks", async () => {
  await withFixture(async ({ manifest, payload }) => {
    await writeFile(path.join(payload, "open.js"), "// declared\n");
    const result = runGate(GATE, manifest, payload);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Payload boundary: clean/);
  });
});
