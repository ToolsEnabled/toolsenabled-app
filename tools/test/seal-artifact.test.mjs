import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seal-artifact.mjs')

// T385: the seal binds the commit the binary was built from. A synthetic
// artifact states it under resources/app/dist/.dist-source.json; MC_SEAL_SOURCE_HEAD
// injects the matching source head so the seal binds without a real cut worktree.
const TEST_BUILT_SHA = ''.padEnd(40, 'a')

function run(mode, artifact) {
  const result = spawnSync(process.execPath, [TOOL, mode, artifact],
    { encoding: 'utf8', env: { ...process.env, MC_SEAL_SOURCE_HEAD: TEST_BUILT_SHA, MC_SEAL_SOURCE_CLEAN: '1' } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test('seal-artifact refuses to certify an empty enumeration and still certifies a built artifact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seal-artifact-test-'))
  const empty = path.join(root, 'empty')
  const built = path.join(root, 'built')
  mkdirSync(empty)
  mkdirSync(built)
  writeFileSync(path.join(built, 'application.bin'), 'built artifact\n')
  mkdirSync(path.join(built, 'resources', 'app', 'dist'), { recursive: true })
  writeFileSync(path.join(built, 'resources', 'app', 'dist', '.dist-source.json'),
    JSON.stringify({ schemaVersion: 1, appHead: TEST_BUILT_SHA }) + '\n')

  try {
    const blindRecord = run('--record', empty)
    assert.equal(blindRecord.status, 1, blindRecord.output)
    assert.match(blindRecord.output, /Nothing was sealed\. An empty artifact cannot be certified for release\./)

    writeFileSync(
      path.join(root, '.artifact-seal-empty.json'),
      `${JSON.stringify({ version: 1, artifact: 'empty', recordedAt: '2026-08-26T00:00:00.000Z', files: {} })}\n`,
    )
    const blindVerify = run('--verify', empty)
    assert.equal(blindVerify.status, 1, blindVerify.output)
    assert.match(blindVerify.output, /Nothing was compared\. Re-record after the artifact has been built\./)

    const healthyRecord = run('--record', built)
    assert.equal(healthyRecord.status, 0, healthyRecord.output)
    assert.match(healthyRecord.output, /sealed \d+ file\(s\)/)
    assert.match(healthyRecord.output, new RegExp(`seal binds built commit ${TEST_BUILT_SHA}`))

    const healthyVerify = run('--verify', built)
    assert.equal(healthyVerify.status, 0, healthyVerify.output)
    assert.match(healthyVerify.output, /artifact seal: \d+ file\(s\) byte-identical/)
    assert.match(healthyVerify.output, new RegExp(`artifact built from commit: ${TEST_BUILT_SHA}`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
