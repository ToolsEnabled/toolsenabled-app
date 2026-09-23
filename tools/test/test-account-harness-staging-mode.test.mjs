import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  STAGE_EXACT_RELEASE,
  STAGE_SOURCE_OVERLAY,
  QA_STAGE_MODE_ENV,
  appExecutable,
  assertStageDestinationAbsent,
  environmentFor,
  exactCopyOptions,
  exactTreeManifest,
  stage,
  stageModeForArguments,
  releaseDirectory,
} from '../test-account-harness.mjs'

function releaseFixture(root) {
  const release = path.join(root, 'release')
  mkdirSync(path.join(release, 'resources', 'capability'), { recursive: true })
  // Tiny identity/copy fixtures, never launched or labelled native app proof.
  const name = process.platform === 'linux' ? 'toolsenabled' : 'ToolsEnabled.exe'
  const header = process.platform === 'linux' ? Buffer.from([127, 69, 76, 70]) : Buffer.from([0, 1, 2, 3, 255])
  writeFileSync(path.join(release, name), header, { mode: 0o755 })
  writeFileSync(path.join(release, 'resources', 'app.asar'), Buffer.from('exact packaged archive\0bytes'))
  writeFileSync(path.join(release, 'resources', 'capability', 'PAYLOAD.json'), '{"exact":true}\n')
  return release
}

function byteManifest(root, relative = '') {
  const directory = path.join(root, relative)
  const output = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) output.push(...byteManifest(root, child))
    else {
      const bytes = readFileSync(path.join(root, child))
      output.push({
        path: child.split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  return output
}

test('the QA launcher resolves the native binary in the selected tree without modifying its bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-native-launcher-'))
  try {
    const name = process.platform === 'linux' ? 'toolsenabled' : 'ToolsEnabled.exe'
    const executable = path.join(root, name)
    // Use the actual native Node binary solely to prove selection and byte
    // preservation. It is not Electron and is deliberately never launched.
    cpSync(process.execPath, executable)
    const before = createHash('sha256').update(readFileSync(executable)).digest('hex')
    assert.equal(appExecutable(root), executable)
    assert.equal(createHash('sha256').update(readFileSync(executable)).digest('hex'), before)
    if (process.platform === 'linux') {
      writeFileSync(executable, 'not an ELF file')
      assert.throws(() => appExecutable(root), /not an ELF/)
      rmSync(executable)
      writeFileSync(path.join(root, 'ToolsEnabled.exe'), 'not a native Linux candidate')
      assert.throws(() => appExecutable(root), { code: 'ENOENT' }, 'a Windows candidate is never substituted')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an explicit --release selects exact staging in both supported argv shapes', () => {
  assert.equal(stageModeForArguments(['node', 'driver.mjs']), STAGE_SOURCE_OVERLAY)
  assert.equal(stageModeForArguments(['node', 'driver.mjs', '--release', 'candidate']), STAGE_EXACT_RELEASE)
  assert.equal(stageModeForArguments(['node', 'driver.mjs', '--release=candidate']), STAGE_EXACT_RELEASE)
  assert.equal(stageModeForArguments(['node', 'legacy-driver.mjs'], {
    [QA_STAGE_MODE_ENV]: STAGE_EXACT_RELEASE,
  }), STAGE_EXACT_RELEASE, 'the suite must carry exact mode to legacy implicit-default callers')
})

test('malformed standalone --release requests never fall back or select a staging mode', () => {
  for (const argv of [
    ['node', 'driver.mjs', '--release'],
    ['node', 'driver.mjs', '--release', ''],
    ['node', 'driver.mjs', '--release='],
    ['node', 'driver.mjs', '--release', '--visible'],
    ['node', 'driver.mjs', '--release', 'one', '--release=two'],
  ]) {
    assert.throws(() => releaseDirectory(argv), /--release (?:requires|accepts)/,
      `${argv.join(' ')} silently fell back to the checkout release`)
    assert.throws(() => stageModeForArguments(argv), /--release (?:requires|accepts)/,
      `${argv.join(' ')} selected a mode for a malformed release request`)
  }
})

test('the suite-only stage marker never reaches the packaged application environment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-stage-env-'))
  const previous = process.env[QA_STAGE_MODE_ENV]
  try {
    process.env[QA_STAGE_MODE_ENV] = STAGE_EXACT_RELEASE
    assert.equal(QA_STAGE_MODE_ENV in environmentFor(root), false)
  } finally {
    if (previous === undefined) delete process.env[QA_STAGE_MODE_ENV]
    else process.env[QA_STAGE_MODE_ENV] = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact release staging preserves source and scratch file bytes and never invokes the overlay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-exact-stage-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    mkdirSync(scratch)
    const before = byteManifest(release)
    const staged = await stage(scratch, release, {
      mode: STAGE_EXACT_RELEASE,
      overlay: async () => { throw new Error('exact staging invoked the source overlay') },
    })

    assert.equal(staged.stageMode, STAGE_EXACT_RELEASE)
    assert.deepEqual(byteManifest(release), before, 'the named release candidate was mutated')
    assert.deepEqual(byteManifest(staged.appRoot), before,
      'the exact scratch copy differs from the named release candidate')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact release staging refuses a stale destination instead of merging into it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-stale-stage-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    mkdirSync(path.join(scratch, 'app'), { recursive: true })
    writeFileSync(path.join(scratch, 'app', 'stale.txt'), 'must not survive')
    await assert.rejects(
      stage(scratch, release, { mode: STAGE_EXACT_RELEASE }),
      /refusing to stage over an existing destination/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact release staging detects a source mutation during the copy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-mutating-stage-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    mkdirSync(scratch)
    await assert.rejects(
      stage(scratch, release, {
        mode: STAGE_EXACT_RELEASE,
        copy(source, destination, options) {
          cpSync(source, destination, options)
          writeFileSync(path.join(source, 'resources', 'app.asar'), 'changed after the copy')
        },
      }),
      /named release changed while it was copied/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const fakeDirectory = Object.freeze({
  isSymbolicLink: () => false,
  isDirectory: () => true,
  isFile: () => false,
})
const fakeLink = Object.freeze({
  isSymbolicLink: () => true,
  isDirectory: () => false,
  isFile: () => false,
})

function oneLinkFilesystem(root, name, target) {
  const link = path.join(path.resolve(root), name)
  return {
    lstatSync(file) {
      if (path.resolve(file) === path.resolve(root)) return fakeDirectory
      if (path.resolve(file) === path.resolve(link)) return fakeLink
      throw Object.assign(new Error(`unexpected lstat ${file}`), { code: 'ENOENT' })
    },
    readdirSync(file) {
      assert.equal(path.resolve(file), path.resolve(root))
      return [{ name }]
    },
    readlinkSync(file) {
      assert.equal(path.resolve(file), path.resolve(link))
      return target
    },
    hashRegularFile() {
      throw new Error('a topology manifest read through a link target')
    },
  }
}

test('exact release staging preserves relative link topology without privilege or read-through', () => {
  const root = path.resolve('invented-release-root')
  const target = path.join('payload', 'PAYLOAD.json')
  const manifest = exactTreeManifest(root, { filesystem: oneLinkFilesystem(root, 'PAYLOAD.link', target) })
  assert.deepEqual(manifest, [
    { path: '.', type: 'directory' },
    { path: 'PAYLOAD.link', type: 'link', target },
  ])
  assert.deepEqual(exactCopyOptions(STAGE_EXACT_RELEASE), {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
  }, 'the production copy must preserve the exact relative link text')
})

test('exact release staging rejects escaping and source-pointing links without read-through', () => {
  const release = path.resolve('invented-release-root')
  const scratch = path.resolve('invented-scratch-root')
  assert.throws(
    () => exactTreeManifest(release, {
      filesystem: oneLinkFilesystem(release, 'outside.link', path.join('..', 'outside.txt')),
    }),
    /link escapes its tree/,
  )
  assert.throws(
    () => exactTreeManifest(scratch, {
      forbiddenRoot: release,
      filesystem: oneLinkFilesystem(scratch, 'source.link', path.join(release, 'payload', 'PAYLOAD.json')),
    }),
    /scratch link points back into its source/,
  )
})

test('a broken destination link counts as stale and is never followed', () => {
  const calls = []
  assert.throws(() => assertStageDestinationAbsent(path.resolve('scratch', 'app'), {
    lstat(file) {
      calls.push(file)
      return fakeLink
    },
  }), /refusing to stage over an existing destination/)
  assert.equal(calls.length, 1, 'destination proof must consist of one lstat and no target read')
})

test('development overlay mode mutates only the disposable scratch copy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-overlay-stage-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    mkdirSync(scratch)
    const before = byteManifest(release)
    let overlayRoot = null
    const staged = await stage(scratch, release, {
      mode: STAGE_SOURCE_OVERLAY,
      overlay: async appRoot => {
        overlayRoot = appRoot
        writeFileSync(path.join(appRoot, 'resources', 'app.asar'), 'development overlay')
        writeFileSync(path.join(appRoot, 'resources', 'capability', 'overlay-marker.txt'), 'scratch only')
      },
    })

    assert.equal(staged.stageMode, STAGE_SOURCE_OVERLAY)
    assert.equal(path.resolve(overlayRoot), path.resolve(staged.appRoot))
    assert.deepEqual(byteManifest(release), before, 'development staging mutated its source release')
    assert.notDeepEqual(byteManifest(staged.appRoot), before,
      'development staging failed to apply the overlay to its scratch copy')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('development staging refuses a nested directory link before copying or invoking the overlay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-overlay-link-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    const target = path.join(root, 'target')
    mkdirSync(scratch)
    mkdirSync(target)
    writeFileSync(path.join(target, 'sentinel.txt'), 'fixture must stay untouched')
    symlinkSync(target, path.join(release, 'resources', 'linked'), 'junction')
    let copied = false
    let overlaid = false
    await assert.rejects(stage(scratch, release, {
      mode: STAGE_SOURCE_OVERLAY,
      copy() { copied = true; throw new Error('copy reached a linked release') },
      overlay() { overlaid = true },
    }), /source-overlay staging refuses a linked entry/)
    assert.equal(copied, false)
    assert.equal(overlaid, false)
    assert.equal(existsSync(path.join(scratch, 'app')), false)
    assert.equal(readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'fixture must stay untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('development staging refuses a linked resources directory before its archive probe', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-overlay-resources-link-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    mkdirSync(scratch)
    rmSync(path.join(release, 'resources'), { recursive: true })
    // The target deliberately does not exist: an archive existence probe would
    // follow this junction and report a missing build instead of refusing it.
    symlinkSync(path.join(root, 'absent-target'), path.join(release, 'resources'), 'junction')
    await assert.rejects(stage(scratch, release, {
      mode: STAGE_SOURCE_OVERLAY,
      copy() { throw new Error('copy reached linked resources') },
      overlay() { throw new Error('overlay reached linked resources') },
    }), /source-overlay staging refuses a linked entry: resources/)
    assert.equal(existsSync(path.join(scratch, 'app')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('development staging never resolves or reads a rejected link target', () => {
  const release = path.resolve('invented-release-root')
  const filesystem = oneLinkFilesystem(release, 'linked', 'unused-target')
  filesystem.readlinkSync = () => { throw new Error('a rejected link target was inspected') }
  assert.throws(() => exactTreeManifest(release, { rejectLinks: true, filesystem }),
    /source-overlay staging refuses a linked entry: linked/)
})

test('development staging checks the copied tree before the overlay may touch it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'test-account-overlay-copy-link-'))
  try {
    const release = releaseFixture(root)
    const scratch = path.join(root, 'scratch')
    const target = path.join(root, 'target')
    mkdirSync(scratch)
    mkdirSync(target)
    let overlaid = false
    await assert.rejects(stage(scratch, release, {
      mode: STAGE_SOURCE_OVERLAY,
      copy(source, destination, options) {
        assert.equal(options.dereference, false)
        cpSync(source, destination, options)
        symlinkSync(target, path.join(destination, 'resources', 'late-link'), 'junction')
      },
      overlay() { overlaid = true },
    }), /source-overlay staging refuses a linked entry: resources\/late-link/)
    assert.equal(overlaid, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
