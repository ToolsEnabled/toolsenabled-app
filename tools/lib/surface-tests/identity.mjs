import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ordinaryPath, gitEnvironment } from '../development-session.mjs'
import subject from '../qa-renderer-dist.cjs'
const require = createRequire(import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['src', 'shell', 'tools', 'tests', 'config', 'schemas', 'adapters', 'package.json', 'package-lock.json', 'index.html', 'vite.config.js']
export function sourceIdentity(root) {
  ordinaryPath(root)
  const git = args => {
    const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', root, ...args],
      { env: gitEnvironment(), encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (r.error || r.status !== 0) throw Error('Source Git identity unavailable')
    return r.stdout
  }
  if (path.resolve(git(['rev-parse', '--show-toplevel']).trim()) !== path.resolve(root)) throw Error('Source must be its Git root')
  const ref = git(['rev-parse', 'HEAD']).trim()
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'])
  const names = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourcePaths]).split('\0').filter(Boolean).sort()
  const untracked = names.map(name => {
    const file = ordinaryPath(path.join(root, name), { directory: false })
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('Untracked source identity exceeds the byte budget')
    return [name, sha(fs.readFileSync(file))]
  })
  // This binds selected working source, not a release qualification certificate.
  return { ref, dirty: Boolean(diff || names.length), digest: sha(JSON.stringify({ ref, diff: sha(diff), untracked })), untrackedFiles: names.length }
}
export function assertBuildInfo(info, expected) {
  const exactSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
  if (!exactSha(expected?.app) || !exactSha(expected?.engine))
    throw Error('Build identity expectation must name exact app and engine commits')
  if (info?.schemaVersion !== 2 || info.dirty !== false || info.overridden !== false ||
      info.app?.dirty !== false || info.payload?.dirty !== false || info.payload?.resolved !== true ||
      info.app.ref !== expected.app || info.ref !== expected.app || info.payload.ref !== expected.engine)
    throw Error('Build identity is dirty, unknown or differs from the requested immutable pair')
  return { app: info.app.ref, engine: info.payload.ref, checkedAt: info.checkedAt }
}
export function artifactIdentity(release, expected) {
  ordinaryPath(release)
  const selected = subject.selectRendererDist({ argv: ['--release', release] })
  const asar = require('@electron/asar')
  const info = asar.statFile(selected.provenance.archive, 'dist/build-info.json', false)
  if (info.unpacked || info.link || !Number.isSafeInteger(info.size) || info.size > 65536) throw Error('Packed build identity is not ordinary bounded data')
  const build = assertBuildInfo(JSON.parse(asar.extractFile(selected.provenance.archive, 'dist/build-info.json')), expected)
  return { ...selected.provenance, ...build, assertUnchanged: selected.assertUnchanged }
}
export async function hostedIdentity(origin, mount, expected) {
  const response = await fetch(new URL(mount + 'build-info.json', origin), {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw Error('Hosted build identity unavailable: HTTP ' + response.status)
  if (Number(response.headers.get('content-length') || 0) > 65536) throw Error('Hosted identity exceeds byte budget')
  const reader = response.body.getReader(); const parts = []; let bytes = 0
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length
    if (bytes > 65536) throw Error('Hosted identity exceeds byte budget'); parts.push(Buffer.from(next.value)) } }
  finally { await reader.cancel() }
  const body = Buffer.concat(parts)
  return { ...assertBuildInfo(JSON.parse(body), expected), sha256: sha(body), origin, mount }
}
