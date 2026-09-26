'use strict'

// Electron presents an ASAR as a virtual directory through node:fs. Identity
// measurements must use the physical file API; consumers still use Electron's
// virtual fs to read the selected dist bytes.
const fs = process.versions.electron ? require('original-fs') : require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function releaseArgument(argv) {
  const positions = argv.flatMap((value, index) => value === '--release' || value.startsWith('--release=') ? [index] : [])
  if (!positions.length) return null
  if (positions.length !== 1) throw new Error('--release accepts exactly one directory')
  const index = positions[0]
  const value = argv[index] === '--release' ? argv[index + 1] : argv[index].slice('--release='.length)
  if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('--release requires one directory')
  return path.resolve(value)
}

function ordinary(file, directory = false) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`renderer subject requires an ordinary ${directory ? 'directory' : 'file'}: ${file}`)
  }
  return stat
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

function measureArchive(release) {
  ordinary(release, true)
  ordinary(path.join(release, 'resources'), true)
  const archive = path.join(release, 'resources', 'app.asar')
  const before = ordinary(archive)
  if (before.size < 1 || before.size > 256 * 1024 * 1024) throw new Error('renderer archive exceeds its nonempty 256 MiB budget')
  const fd = fs.openSync(archive, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) throw new Error('renderer archive changed before reading')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (total < before.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - total), total)
      if (!count) throw new Error('renderer archive was truncated during reading')
      hash.update(buffer.subarray(0, count))
      total += count
    }
    if (identity(fs.fstatSync(fd)) !== identity(before) || identity(ordinary(archive)) !== identity(before)) {
      throw new Error('renderer archive changed during reading')
    }
    return { archive, bytes: total, sha256: hash.digest('hex'), identity: identity(before) }
  } finally { fs.closeSync(fd) }
}

// Electron's fs reads app.asar/dist directly. A host Electron window consuming
// these bytes is renderer QA, NOT execution of the candidate's native shell.
function selectRendererDist({ argv = process.argv, repoRoot, asarApi = null } = {}) {
  const release = releaseArgument(argv)
  if (release === null) {
    const dist = path.join(repoRoot, 'dist')
    return Object.freeze({ dist, release: null,
      provenance: Object.freeze({ mode: 'source-renderer', dist, proofScope: 'renderer-in-host-electron' }),
      assertUnchanged() {},
    })
  }
  const measured = measureArchive(release)
  const asar = asarApi || require('@electron/asar')
  asar.uncache(measured.archive)
  const directory = asar.statFile(measured.archive, 'dist', false)
  const entry = asar.statFile(measured.archive, 'dist/index.html', false)
  if (!directory?.files || directory.link || directory.unpacked || entry?.link || entry?.unpacked || !(entry?.size > 0)) {
    throw new Error('candidate archive must contain ordinary packed dist/index.html')
  }
  const pending = [directory]
  while (pending.length) {
    const item = pending.pop()
    if (item.link || item.unpacked) throw new Error('candidate renderer must not resolve linked or unpacked assets')
    if (item.files) pending.push(...Object.values(item.files))
  }
  const assertUnchanged = () => {
    const after = measureArchive(release)
    if (after.identity !== measured.identity || after.sha256 !== measured.sha256) {
      throw new Error('selected renderer archive changed during QA')
    }
  }
  assertUnchanged()
  return Object.freeze({ dist: path.join(measured.archive, 'dist'), release,
    provenance: Object.freeze({ mode: 'candidate-renderer', release, archive: measured.archive,
      bytes: measured.bytes, sha256: measured.sha256, proofScope: 'renderer-in-host-electron' }),
    assertUnchanged,
  })
}

function rendererRequestPath(dist, requestUrl) {
  let pathname
  try { pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname) }
  catch { return null }
  if (pathname.includes('\0') || pathname.includes('\\')) return null
  const requested = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
  const relative = path.relative(dist, requested)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : requested
}

module.exports = Object.freeze({ releaseArgument, selectRendererDist, rendererRequestPath })
