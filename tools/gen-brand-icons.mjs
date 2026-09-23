#!/usr/bin/env node

/* Generate the application icon from the owner's TE monogram.
 *
 *   node tools/gen-brand-icons.mjs [--check]
 *
 * Writes shell/icon.ico (the packaged exe and the NSIS installer, via
 * package.json build.win.icon) and shell/icon.png (the BrowserWindow icon set
 * in shell/main.cjs). Both were a teal placeholder brace before this existed.
 *
 * --check regenerates in memory and compares against what is on disk without
 * writing, so a drifted or hand-edited icon is a failure rather than a
 * surprise. The output is deterministic: same geometry in, same bytes out, on
 * any machine.
 */

import zlib from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ICON_SIZES, encodeIco, encodePng, markBounds, renderIcon } from './brand-mark.mjs'
import { platedMonogramSvg } from './brand-geometry.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICO_PATH = path.join(REPO_ROOT, 'shell', 'icon.ico')
const PNG_PATH = path.join(REPO_ROOT, 'shell', 'icon.png')
// public/ is copied verbatim into dist/ by vite, and dist/** ships in the asar,
// so this is the favicon the shipped index.html points at.
const FAVICON_PATH = path.join(REPO_ROOT, 'public', 'brand-icon.svg')
const WINDOW_ICON_SIZE = 256

function build() {
  // One bounds computation shared by every size, so the mark cannot land at a
  // different optical position at one size than another.
  const bounds = markBounds()
  const images = ICON_SIZES.map((size) => renderIcon(size, { bounds }))
  const png = images.find((image) => image.width === WINDOW_ICON_SIZE)
  if (!png) throw new Error(`gen-brand-icons: ICON_SIZES must include ${WINDOW_ICON_SIZE} for the window icon`)
  return {
    ico: encodeIco(images, zlib),
    png: encodePng(png, zlib),
    favicon: Buffer.from(`${platedMonogramSvg({ size: 100 })}\n`, 'utf8'),
    images,
  }
}

export function readIfPresent(file, read = readFileSync) {
  try {
    return read(file)
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null

    const error = new Error(
      `gen-brand-icons: could not read ${file}; this is NOT claiming the file is absent`,
      { cause },
    )
    error.code = 'GEN_BRAND_ICONS_READ_INDETERMINATE'
    throw error
  }
}

function main() {
  const check = process.argv.includes('--check')
  const { ico, png, favicon, images } = build()

  const targets = [
    { label: 'shell/icon.ico', file: ICO_PATH, bytes: ico },
    { label: 'shell/icon.png', file: PNG_PATH, bytes: png },
    { label: 'public/brand-icon.svg', file: FAVICON_PATH, bytes: favicon },
  ]

  if (check) {
    const drifted = targets.filter(({ file, bytes }) => {
      const current = readIfPresent(file)
      return current === null || !current.equals(bytes)
    })
    if (drifted.length) {
      console.error('gen-brand-icons --check FAILED: these do not match the generator output:')
      for (const { label } of drifted) console.error(`  - ${label}`)
      console.error('Run `node tools/gen-brand-icons.mjs` to regenerate them.')
      process.exitCode = 1
      return
    }
    console.log(`gen-brand-icons --check: OK (${targets.map((target) => target.label).join(', ')} match)`)
    return
  }

  for (const { label, file, bytes } of targets) {
    writeFileSync(file, bytes)
    console.log(`gen-brand-icons: wrote ${label} (${bytes.length} bytes)`)
  }
  console.log(`gen-brand-icons: embedded sizes ${images.map((image) => image.width).join(', ')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
