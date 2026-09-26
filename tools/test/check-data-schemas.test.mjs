import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(ROOT, 'tools', 'check-data-schemas.mjs')

function runGate(scriptPath, dataDirectory) {
  return spawnSync(process.execPath, [scriptPath, dataDirectory], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'check-data-schemas-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('check-data-schemas refuses an empty enumeration through a differently named copy', async () => {
  await withFixture(async directory => {
    const copiedGate = join(ROOT, 'tools', `check-data-schemas-copy-${basename(directory)}.mjs`)
    const dataDirectory = join(directory, 'data')
    try {
      await copyFile(GATE, copiedGate)
      await mkdir(dataDirectory)

      const result = runGate(copiedGate, dataDirectory)

      assert.equal(result.status, 1, `gate unexpectedly passed:\n${result.stdout}${result.stderr}`)
      assert.match(result.stdout, /Discovered 0 JSON data files; validated 0\./)
      assert.match(result.stderr, /discovered zero JSON data files .*; refusing to pass/)
    } finally {
      await rm(copiedGate, { force: true })
    }
  })
})

test('check-data-schemas refuses a missing input directory', async () => {
  await withFixture(async directory => {
    const missing = join(directory, 'absent-data')
    const result = runGate(GATE, missing)

    assert.equal(result.status, 1, `gate unexpectedly passed:\n${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /data directory is missing or unreadable .*ENOENT/)
  })
})

test('check-data-schemas refuses an undeclared JSON file with no matching schema', async () => {
  await withFixture(async directory => {
    const dataDirectory = join(directory, 'data')
    await mkdir(dataDirectory)
    await writeFile(join(dataDirectory, 'extra.json'), '{}\n')

    const result = runGate(GATE, dataDirectory)

    assert.equal(result.status, 1, `gate unexpectedly passed:\n${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /Discovered 1 JSON data files; validated 0\./)
    assert.match(result.stderr, /schema for extra\.json is missing or unreadable/)
  })
})

test('check-data-schemas still passes after validating a healthy data file', async () => {
  await withFixture(async directory => {
    const dataDirectory = join(directory, 'data')
    await mkdir(join(dataDirectory, 'schema'), { recursive: true })
    await writeFile(join(dataDirectory, 'example.json'), '{"name":"sound"}\n')
    await writeFile(join(dataDirectory, 'schema', 'example.schema.json'), JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    }))

    const result = runGate(GATE, dataDirectory)

    assert.equal(result.status, 0, `healthy gate failed:\n${result.stdout}${result.stderr}`)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Discovered 1 JSON data files; validated 1\./)
    assert.match(result.stdout, /Data schema check passed for /)
  })
})
