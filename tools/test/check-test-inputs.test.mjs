import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = path.join(REPO_ROOT, "tools", "check-test-inputs.mjs");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "check-test-inputs-"));
  mkdirSync(path.join(root, "tools", "test"), { recursive: true });
  mkdirSync(path.join(root, "capability"), { recursive: true });
  mkdirSync(path.join(root, "private"), { recursive: true });
  copyFileSync(GATE, path.join(root, "tools", "check-test-inputs.mjs"));
  writeFileSync(path.join(root, "capability", "payload.js"), "export {};\n");
  writeFileSync(path.join(root, "private", "capability-source.owner.json"), "{}\n");
  writeFileSync(path.join(root, "private", "owner-data-patterns.owner.json"), "{}\n");
  return root;
}

function runGate(root) {
  return spawnSync(process.execPath, [path.join(root, "tools", "check-test-inputs.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}

test("check-test-inputs refuses an empty suite enumeration and still passes after looking", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const blind = runGate(root);
  assert.equal(blind.status, 2, `empty enumeration exited ${blind.status}:\n${blind.stdout}${blind.stderr}`);
  assert.match(blind.stderr, /contains no \.test\.mjs files, so this gate checked no test consumers\./);
  assert.equal(blind.stdout, "");

  writeFileSync(
    path.join(root, "tools", "test", "consumer.test.mjs"),
    "// capability capability-source.owner.json owner-data-patterns.owner.json\n",
  );
  const healthy = runGate(root);
  assert.equal(healthy.status, 0, `populated enumeration exited ${healthy.status}:\n${healthy.stdout}${healthy.stderr}`);
  assert.match(healthy.stdout, /Test inputs: all 3 required derived input\(s\) present/);
  assert.equal(healthy.stderr, "");
});
