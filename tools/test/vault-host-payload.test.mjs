import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from '../lib/sterile-launch.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const worker = 'src/lib/vault-host/worker.js'
const helper = 'tools/vault-host.ps1'
const client = 'src/lib/vault-host-client.js'
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/capability-manifest.json'), 'utf8'))

test('the persistent vault host has explicit worker and helper closure roots', () => {
  assert.ok(manifest.spawnedPrograms.includes(worker), 'a computed Worker path is invisible to a require walk')
  assert.ok(manifest.helperPrograms.includes(helper), 'the worker needs its persistent PowerShell host')
})

test('the rebuilt payload carries the whole persistent vault host', () => {
  const payload = JSON.parse(fs.readFileSync(path.join(root, 'capability/PAYLOAD.json'), 'utf8'))
  for (const relative of [client, worker, helper]) {
    assert.ok(fs.statSync(path.join(root, 'capability', relative)).isFile(), `missing staged vault program: ${relative}`)
  }
  assert.ok(payload.spawnedPrograms.includes(worker), 'the staged record must describe the worker it carries')
  assert.ok(payload.helperPrograms.includes(helper), 'the staged record must describe the helper it carries')
})

test('the actual staged client reads synthetic data through one persistent OS process', { skip: process.platform !== 'win32' }, () => {
  // Fail immediately for an incomplete build; do not wait out a broken
  // worker's synchronous timeout and mistake the per-call fallback for proof.
  for (const relative of [client, worker, helper]) {
    assert.ok(fs.existsSync(path.join(root, 'capability', relative)), `repack before testing: ${relative}`)
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-payload-'))
  try {
    const profile = prepareSterileProfile(sterileProfileDirectories(scratch))
    const env = sterileLaunchEnvironment(profile)
    env.TOOLSENABLED_STATE_ROOT = path.join(scratch, 'state')
    env.TOOLSENABLED_VAULT_PATH = path.join(scratch, 'state/vault/secrets.json')
    const probe = String.raw`
      const assert = require('node:assert/strict');
      const host = require(process.argv[1]);
      const key = 'test_only_vault_payload';
      const value = 'synthetic-vault-value-not-real';
      try {
        const made = host.callVaultHost('get-or-create-stdin', { key, valueBase64: Buffer.from(value).toString('base64') });
        assert.ok(made, 'the persistent host must answer without fallback');
        const pids = [];
        for (let i = 0; i < 3; i++) {
          const answer = host.callVaultHost('get', { key });
          assert.equal(answer.output.trim(), value);
          pids.push(host.diagnosticHostPid());
        }
        assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
        assert.ok(pids.every(pid => pid === pids[0]));
        process.kill(pids[0], 0);
        process.stdout.write(JSON.stringify({ requests: pids.length, persistentPid: pids[0] }));
      } finally { host.terminateVaultHostForTests(); }
    `
    const result = spawnSync(process.execPath, ['-e', probe, path.join(root, 'capability', client)], {
      cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    const measured = JSON.parse(result.stdout)
    assert.equal(measured.requests, 3)
    assert.ok(measured.persistentPid > 0)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
