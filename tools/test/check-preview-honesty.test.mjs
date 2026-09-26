import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const realGuardPath = fileURLToPath(new URL('../check-preview-honesty.mjs', import.meta.url))

const honestDefinition = `
const LIVENESS_CLAIM = 'Nothing on this page is live'
const LIVENESS_MARKERS = Object.freeze([])
const PAID_GATED = Object.freeze(['hosted-relay'])
`

async function withFixture(run) {
  const repo = await mkdtemp(path.join(tmpdir(), 'check-preview-honesty-'))
  try {
    const tools = path.join(repo, 'tools')
    const preview = path.join(repo, 'public', 'preview')
    const config = path.join(repo, 'config')
    await mkdir(tools, { recursive: true })
    await mkdir(preview, { recursive: true })
    await mkdir(config, { recursive: true })

    const guardPath = path.join(tools, 'check-preview-honesty.mjs')
    await copyFile(realGuardPath, guardPath)
    await run({ config, guardPath, preview, repo })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

function runGuard(guardPath, root) {
  const args = root === undefined ? [guardPath] : [guardPath, root]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

async function writeHealthyPreview({ config, preview }) {
  await writeFile(path.join(preview, 'honesty.js'), honestDefinition)
  await writeFile(
    path.join(preview, 'index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`,
  )
  await writeFile(
    path.join(config, 'renderer-payload-boundary.json'),
    JSON.stringify({ shipped: { paths: ['preview/honesty.js', 'preview/index.html'] } }),
  )
}

test('check-preview-honesty runs and refuses a finding when invoked through a differently named copy', async () => {
  await withFixture(async fixture => {
    await writeFile(path.join(fixture.preview, 'honesty.js'), honestDefinition)
    await writeFile(path.join(fixture.preview, 'claim.txt'), 'Connected to production')
    await writeFile(
      path.join(fixture.config, 'renderer-payload-boundary.json'),
      JSON.stringify({ shipped: { paths: ['preview/honesty.js', 'preview/claim.txt'] } }),
    )
    const copiedGuard = path.join(path.dirname(fixture.guardPath), 'CHECK-PREVIEW-HONESTY-COPY.mjs')
    await copyFile(fixture.guardPath, copiedGuard)

    const result = runGuard(copiedGuard, fixture.preview)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /claim\.txt:1: "Connected" asserts the simulated data is real/)
  })
})

test('refuses an empty enumeration instead of passing a scan of zero files', async () => {
  await withFixture(async ({ guardPath, preview }) => {
    const result = runGuard(guardPath, preview)
    assert.equal(result.status, 2, result.output)
    assert.match(result.output, /contains no files\. An empty scan is not a clean scan\./)
  })
})

test('refuses a nonempty preview when the runtime honesty definition is absent', async () => {
  await withFixture(async ({ guardPath, preview }) => {
    await writeFile(path.join(preview, 'index.html'), '<main>Static preview</main>')

    const result = runGuard(guardPath, preview)
    assert.equal(result.status, 2, result.output)
    /* The guard displays the scan root with path.relative, so the separator is the
     * host's: `public\preview` on Windows, `public/preview` elsewhere. Accept either
     * one, and nothing else — the rest of the sentence is pinned literally so a
     * reworded, truncated, or downgraded refusal still fails. */
    assert.match(
      result.output,
      /SETUP: honesty\.js is not in public[\\/]preview\. Without it nothing enforces honesty at runtime and this guard has no definition site to check\./,
    )
  })
})

test('refuses a missing input instead of treating absence as satisfied', async () => {
  await withFixture(async ({ guardPath, repo }) => {
    const missing = path.join(repo, 'public', 'not-built')
    const result = runGuard(guardPath, missing)
    assert.equal(result.status, 2, result.output)
    assert.match(result.output, /does not exist, so this guard checked nothing\./)
  })
})

test('refuses a disk file that the payload manifest does not declare', async () => {
  await withFixture(async fixture => {
    await writeHealthyPreview(fixture)
    await writeFile(path.join(fixture.preview, 'undeclared.txt'), 'static preview copy')

    const result = runGuard(fixture.guardPath)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /does not classify public\/preview\/undeclared\.txt/)
  })
})

test('refuses a missing payload manifest on the authored-directory path', async () => {
  await withFixture(async fixture => {
    await writeFile(path.join(fixture.preview, 'honesty.js'), honestDefinition)

    const result = runGuard(fixture.guardPath)
    assert.equal(result.status, 2, result.output)
    assert.match(result.output, /renderer-payload-boundary\.json is missing/)
  })
})

test('passes after inspecting a healthy, fully declared preview', async () => {
  await withFixture(async fixture => {
    await writeHealthyPreview(fixture)

    const result = runGuard(fixture.guardPath)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /Preview honesty: clean\. 2 file\(s\)/)
  })
})
