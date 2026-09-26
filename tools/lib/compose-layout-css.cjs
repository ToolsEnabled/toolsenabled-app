'use strict'

const fs = require('node:fs')
const path = require('node:path')

function argument(argv, name) {
  const args = Array.isArray(argv) ? argv : []
  const inline = args.find(value => typeof value === 'string' && value.startsWith(`${name}=`))
  if (inline) {
    const value = inline.slice(name.length + 1)
    if (!value) throw new Error(`${name} requires a directory`)
    return value
  }
  const at = args.indexOf(name)
  if (at === -1) return null
  const value = args[at + 1]
  if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`${name} requires a directory`)
  return value
}

function selectCssEntry(entries) {
  const css = entries
    .map(value => String(value).replace(/^[/\\]+/, '').replace(/\\/g, '/'))
    .filter(value => /^dist\/assets\/[^/]+\.css$/i.test(value))
    .sort()
  const primary = css.filter(value => /^dist\/assets\/index-[^/]+\.css$/i.test(value))
  const candidates = primary.length > 0 ? primary : css
  if (candidates.length !== 1) {
    throw new Error(`the packaged app carries ${candidates.length} unambiguous compose stylesheet candidates`)
  }
  return candidates[0]
}

function readComposeLayoutCss({ argv = process.argv, repoRoot, fsImpl = fs, asarApi = null } = {}) {
  const requested = argument(argv, '--release')
  if (!requested) {
    const assets = path.join(repoRoot, 'dist', 'assets')
    const entry = selectCssEntry(fsImpl.readdirSync(assets).map(name => `dist/assets/${name}`))
    const file = path.join(repoRoot, ...entry.split('/'))
    return Object.freeze({ css: fsImpl.readFileSync(file, 'utf8'), mode: 'source-overlay', origin: file, entry })
  }

  const release = path.resolve(requested)
  const archive = path.join(release, 'resources', 'app.asar')
  if (!fsImpl.existsSync(archive)) throw new Error(`no packaged app archive at ${archive}`)
  const asar = asarApi || require('@electron/asar')
  const entry = selectCssEntry(asar.listPackage(archive))
  const bytes = asar.extractFile(archive, entry)
  return Object.freeze({ css: Buffer.from(bytes).toString('utf8'), mode: 'exact-release', origin: archive, entry, release })
}

module.exports = Object.freeze({ argument, readComposeLayoutCss, selectCssEntry })
