import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PROBE = path.join(REPO_ROOT, 'tools', 'launch-readiness-fence-probe.mjs')

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [...(options.nodeArgs || []), PROBE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return { ...result, output: `${result.stdout}${result.stderr}` }
}

test('payload lookup distinguishes genuine absence from a filesystem that could not answer', () => {
  // Read the command itself so this test cannot accidentally exercise a reimplementation.
  assert.match(readFileSync(PROBE, 'utf8'), /FENCE_PROBE_PAYLOAD_UNREADABLE/)

  const fixture = mkdtempSync(path.join(tmpdir(), 'fence-probe-lookup-'))
  try {
    const preload = path.join(fixture, 'fail-stat.cjs')
    writeFileSync(preload, `
      const fs = require('node:fs')
      const original = fs.statSync
      fs.statSync = function (file, ...args) {
        if (String(file).endsWith('permission-tier-policy.js')) {
          throw Object.assign(new Error('disk is busy'), { code: 'EIO' })
        }
        return original.call(this, file, ...args)
      }
      require('node:module').syncBuiltinESMExports()
    `)

    const unavailable = run(['--payload', fixture], { nodeArgs: ['--require', preload] })
    assert.equal(unavailable.status, 2)
    assert.match(unavailable.output, /FENCE_PROBE_PAYLOAD_UNREADABLE/)
    assert.match(unavailable.output, /EIO/)
    assert.match(unavailable.output, /does NOT claim that the payload file is absent/)
    assert.doesNotMatch(unavailable.output, /FENCE_PROBE_PAYLOAD_ABSENT/)

    // CONTROL: ENOENT is still the one lookup failure that definitely means absent.
    const absent = run(['--payload', fixture])
    assert.equal(absent.status, 2)
    assert.match(absent.output, /FENCE_PROBE_PAYLOAD_ABSENT/)
    assert.match(absent.output, /permission-tier-policy is not in the payload/)
    assert.doesNotMatch(absent.output, /FENCE_PROBE_PAYLOAD_UNREADABLE/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
