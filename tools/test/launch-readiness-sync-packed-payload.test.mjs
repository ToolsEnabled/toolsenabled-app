/* Behavioural coverage for the release-chain gate named in this file.
 *
 * Every fixture lives outside the checkout.  In particular, these tests never
 * hide or rewrite the real gate to manufacture a failure: sibling test workers
 * may be executing that same entry point at the same time.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../launch-readiness-sync-packed-payload.mjs", import.meta.url));

function put(root, relative, contents) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "launch-readiness-sync-"));
  const staged = path.join(root, "capability");
  const packed = path.join(root, "release", "win-unpacked", "resources", "capability");
  put(staged, "PAYLOAD.json", '{"fileCount":2}\n');
  put(staged, "src/entry.js", "export const current = true;\n");
  return { root, staged, packed };
}

function run(staged, packed, ...extra) {
  const result = spawnSync(process.execPath, [GATE, "--staged", staged, "--packed", packed, ...extra], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function inFixture(body) {
  const made = fixture();
  try {
    body(made);
  } finally {
    rmSync(made.root, { recursive: true, force: true });
  }
}

test("launch-readiness-sync-packed-payload.mjs passes a complete staged payload on the first build", () => {
  inFixture(({ staged, packed }) => {
    assert.equal(existsSync(packed), false, "precondition: the packed root is absent, not empty");

    const result = run(staged, packed);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /FIRST BUILD:[\s\S]*staged payload[^\n]*present and non-empty/i,
      "the gate must identify the narrow first-build exemption and its staged-payload precondition");
    assert.equal(existsSync(packed), false, "electron-builder, not this exemption, creates the packed root");
  });
});

test("launch-readiness-sync-packed-payload.mjs refuses an existing-but-empty packed root", () => {
  inFixture(({ staged, packed }) => {
    mkdirSync(packed, { recursive: true });

    const result = run(staged, packed);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /Payload sync refused:[\s\S]*packed payload[\s\S]*holds no files/i,
      "the refusal must say that the existing packed payload is empty");
  });
});

test("launch-readiness-sync-packed-payload.mjs --check refuses an absent packed root", () => {
  inFixture(({ staged, packed }) => {
    const result = run(staged, packed, "--check");

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /Payload sync refused:[\s\S]*packed payload does not exist/i,
      "--check must state that there is no artifact to check");
  });
});

test("launch-readiness-sync-packed-payload.mjs refuses an absent staged payload without touching packed bytes", () => {
  inFixture(({ root, packed }) => {
    const absentStaged = path.join(root, "never-staged");
    put(packed, "customer.js", "do not delete\n");

    const result = run(absentStaged, packed);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /Payload sync refused:[\s\S]*staged payload does not exist/i,
      "the refusal must identify the absent staged input");
    assert.equal(readFileSync(path.join(packed, "customer.js"), "utf8"), "do not delete\n");
  });
});

test("launch-readiness-sync-packed-payload.mjs synchronises a healthy ordinary fixture", () => {
  inFixture(({ staged, packed }) => {
    put(packed, "PAYLOAD.json", '{"stale":true}\n');
    put(packed, "obsolete.js", "remove me\n");

    const result = run(staged, packed);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Synchronised: removed 1, wrote 2[\s\S]*byte-identical/i,
      "success must describe the completed reconciliation, not merely exit zero");
    assert.equal(existsSync(path.join(packed, "obsolete.js")), false);
    assert.equal(readFileSync(path.join(packed, "src", "entry.js"), "utf8"), "export const current = true;\n");
  });
});
