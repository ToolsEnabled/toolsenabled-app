import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ICON_SIZES,
  MARK_COLOR,
  PLATE_COLOR,
  PNG_SIGNATURE,
  RECTS,
  SKEW_X_DEGREES,
  TRANSLATE_X,
  VIEWBOX,
  encodeIco,
  encodePng,
  markBounds,
  markCoversPoint,
  renderIcon,
} from '../brand-mark.mjs'
import { platedMonogramSvg } from '../brand-geometry.mjs'
import { readIfPresent } from '../gen-brand-icons.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTWORK = path.join(REPO_ROOT, 'tools', 'brand', 'te-monogram.svg')

/* core.autocrlf is true on Windows and this repo has no .gitattributes, so
 * every text file here arrives from a fresh checkout with CRLF endings while
 * the generator emits LF. Comparing raw bytes would make these assertions pass
 * on the machine that wrote the file and fail on the next clone. The BINARY
 * icons are unaffected: git detects the NUL bytes in .ico/.png and leaves them
 * alone, which is how the placeholder icons survived in this tree already. */
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

test('icon checks distinguish an absent file from an indeterminate read and never latch the latter', () => {
  const absent = Object.assign(new Error('gone'), { code: 'ENOENT' })
  assert.equal(readIfPresent('missing-icon', () => { throw absent }), null, 'ENOENT remains the definite absent result')

  let attempts = 0
  const busyThenReadable = () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return Buffer.from('icon bytes')
  }

  assert.throws(
    () => readIfPresent('busy-icon', busyThenReadable),
    (error) => {
      assert.equal(error.code, 'GEN_BRAND_ICONS_READ_INDETERMINATE')
      assert.match(error.message, /NOT claiming the file is absent/)
      assert.equal(error.cause.code, 'EBUSY')
      return true
    },
  )
  assert.deepEqual(readIfPresent('busy-icon', busyThenReadable), Buffer.from('icon bytes'))
  assert.equal(attempts, 2, 'an indeterminate read must be attempted again, not cached or latched')

  assert.throws(
    () => readIfPresent('unknown-icon', () => { throw 'unknown failure' }),
    { code: 'GEN_BRAND_ICONS_READ_INDETERMINATE' },
    'a non-Error throw without a code is also indeterminate',
  )
})

/* THE POINT OF THIS FILE.
 *
 * tools/brand-mark.mjs restates the owner's artwork as numbers so it can be
 * rasterized without an SVG engine. Restating something is how it drifts. This
 * suite reads the owner's actual file and asserts the numbers still describe
 * it, so the mark on the taskbar cannot quietly stop being the mark he sent. */

test('the rasterizer geometry still matches the owner-supplied SVG', () => {
  const svg = readText(ARTWORK)

  const viewBox = /viewBox="([^"]+)"/.exec(svg)
  assert.ok(viewBox, 'artwork has no viewBox')
  assert.deepEqual(
    viewBox[1].trim().split(/\s+/).map(Number),
    [0, 0, VIEWBOX.width, VIEWBOX.height],
  )

  const transform = /transform="translate\((-?[\d.]+)\s+(-?[\d.]+)\)\s*skewX\((-?[\d.]+)\)"/.exec(svg)
  assert.ok(transform, 'artwork transform is not the translate+skewX shape the rasterizer assumes')
  assert.equal(Number(transform[1]), TRANSLATE_X)
  assert.equal(Number(transform[2]), 0, 'a non-zero Y translate would shift the mark')
  assert.equal(Number(transform[3]), SKEW_X_DEGREES)

  const parsed = [...svg.matchAll(/<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"\s*\/>/g)]
    .map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      rx: Number(match[5]),
    }))

  // Never a silent zero: a regex that stopped matching would otherwise turn
  // this whole suite into a comparison of two empty lists.
  assert.equal(parsed.length, 6, `expected 6 rects in the artwork, parsed ${parsed.length}`)
  assert.deepEqual(parsed, RECTS.map((rect) => ({ ...rect })))

  // The mark is the owner's black. If this ever needs to change for a theme it
  // is done at paint time, not by editing the artwork.
  assert.match(svg, /fill="#000000"/)
})

test('the drawn bounds are the ink, not the viewBox, and sit inside it', () => {
  const bounds = markBounds()
  assert.ok(bounds.width > 0 && bounds.height > 0)
  assert.ok(bounds.minX >= 0 && bounds.maxX <= VIEWBOX.width, 'ink escapes the viewBox horizontally')
  assert.ok(bounds.minY >= 0 && bounds.maxY <= VIEWBOX.height, 'ink escapes the viewBox vertically')

  // The artwork is NOT centred inside its own viewBox — this is exactly why
  // the icon centres on measured ink. If this ever became symmetric the
  // centring code would still be correct, but the asymmetry is load-bearing
  // knowledge, so it is asserted rather than assumed.
  const leftMargin = bounds.minX
  const rightMargin = VIEWBOX.width - bounds.maxX
  assert.ok(Math.abs(leftMargin - rightMargin) > 1, 'artwork margins are now symmetric; re-check the centring')
})

test('coverage answers inside and outside the mark', () => {
  // Deep inside the E's spine (rect 3 spans local x 480..620, y 30..560).
  assert.equal(markCoversPoint(...Object.values(pointFor(550, 300))), true)
  // The counter between the T bar and the E, near the top-left of the viewBox,
  // is empty in the artwork.
  assert.equal(markCoversPoint(5, 585), false)
  assert.equal(markCoversPoint(1020, 5), false)
})

function pointFor(localX, localY) {
  // mirror of transformPoint without importing it, so the coverage test does
  // not depend on the same helper it is exercising
  const k = Math.tan((SKEW_X_DEGREES * Math.PI) / 180)
  return { x: localX + localY * k + TRANSLATE_X, y: localY }
}

test('rendered icons are plated, marked, and opaque in the middle', () => {
  for (const size of [16, 32, 256]) {
    const icon = renderIcon(size)
    assert.equal(icon.width, size)
    assert.equal(icon.data.length, size * size * 4)

    const centre = ((size / 2) * size + size / 2) * 4
    assert.equal(icon.data[centre + 3], 255, `${size}px icon is transparent at its centre`)

    // A corner must be cut away by the plate's radius, otherwise the plate is
    // a plain square and the rounding silently stopped happening. Not asserted
    // as exactly 0: at 16px the radius is 2.9px, so the corner pixel legitimately
    // catches a few percent of coverage from the arc's antialiasing.
    assert.ok(icon.data[3] < 64, `${size}px icon corner is not cut away (alpha ${icon.data[3]})`)

    const colours = new Set()
    for (let pixel = 0; pixel < size * size; pixel += 1) {
      if (icon.data[pixel * 4 + 3] === 255) {
        colours.add(`${icon.data[pixel * 4]},${icon.data[pixel * 4 + 1]},${icon.data[pixel * 4 + 2]}`)
      }
    }
    assert.ok(colours.has(PLATE_COLOR.join(',')), `${size}px icon shows no plate colour`)
    assert.ok(colours.has(MARK_COLOR.join(',')), `${size}px icon shows no mark colour`)
  }
})

test('encodePng emits a structurally valid PNG', () => {
  const image = renderIcon(32)
  const png = encodePng(image, zlib)
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE))
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR')
  assert.equal(png.readUInt32BE(16), 32)
  assert.equal(png.readUInt32BE(20), 32)
  assert.equal(png.readUInt8(24), 8, 'bit depth')
  assert.equal(png.readUInt8(25), 6, 'colour type must be RGBA')
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND')

  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) }, zlib), /expected 16 RGBA bytes/)
})

test('encodeIco lays out a directory every entry of which is in bounds', () => {
  const images = ICON_SIZES.map((size) => renderIcon(size))
  const ico = encodeIco(images, zlib)

  assert.equal(ico.readUInt16LE(0), 0, 'reserved')
  assert.equal(ico.readUInt16LE(2), 1, 'type must be 1 (icon)')
  assert.equal(ico.readUInt16LE(4), ICON_SIZES.length)

  const seen = []
  for (let index = 0; index < ICON_SIZES.length; index += 1) {
    const entry = 6 + index * 16
    const declared = ico.readUInt8(entry)
    const size = declared === 0 ? 256 : declared
    seen.push(size)
    assert.equal(ico.readUInt16LE(entry + 4), 1, 'colour planes')
    assert.equal(ico.readUInt16LE(entry + 6), 32, 'bits per pixel')

    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    assert.ok(length > 0, `entry ${index} declares no data`)
    assert.ok(offset + length <= ico.length, `entry ${index} points past the end of the file`)

    // 256 must be encoded as 0 — the field is a single byte.
    if (size === 256) assert.equal(declared, 0)
  }
  assert.deepEqual(seen, [...ICON_SIZES])

  assert.throws(() => encodeIco([], zlib), /no images/)
})

test('the plated mark keeps the owner black and centres on measured ink', () => {
  const plated = platedMonogramSvg({ size: 100 })
  assert.match(plated, /fill="#f2e5bc"/, 'plate colour')
  assert.match(plated, /fill="#000000"/, 'the plated mark stays the owner black')
  assert.match(plated, /transform="translate\(65 0\) skewX\(-14\)"/)

  const bounds = markBounds()
  // The inner translate must undo the ink origin, not the viewBox origin.
  assert.ok(
    plated.includes(`translate(${-Number(bounds.minX.toFixed(4))} ${-bounds.minY})`),
    `plated mark does not offset by measured ink origin; got: ${plated.slice(0, 260)}`,
  )
})

test('the shipped favicon is the generated mark and the placeholder is gone', () => {
  const favicon = readText(path.join(REPO_ROOT, 'public', 'brand-icon.svg'))
  assert.equal(favicon, `${platedMonogramSvg({ size: 100 })}\n`, 'public/brand-icon.svg is stale — run `node tools/gen-brand-icons.mjs`')

  const html = readText(path.join(REPO_ROOT, 'index.html'))
  assert.match(html, /<link rel="icon" href="\/brand-icon\.svg"/)
  // The old stand-in was a two-circle ring/core drawn inline in the markup.
  assert.ok(!/<circle/.test(html), 'the placeholder ring favicon is still in index.html')
})

/* THE CHROME STAYS OUT OF THIS.
 *
 * A mark was briefly added to <header class="topbar">, and it broke the window
 * frame: shell/main.cjs hides the native title bar (titleBarStyle:'hidden'), so
 * that strip is not a page element, it IS the window chrome, and a new flex
 * child in .tb-left displaced the back chevron. The owner saw it before the
 * lane did. Identity is carried by the app icon, the installer icon and the
 * favicon — none of which touch layout.
 *
 * This test is the tripwire so the mark cannot creep back into the frame by a
 * later well-meaning change. Adding brand to the topbar is a decision that
 * needs the owner, not a refactor. */
test('the window chrome carries no brand mark', () => {
  const html = readText(path.join(REPO_ROOT, 'index.html'))
  const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)
  assert.ok(header, 'the topbar header is gone from index.html')
  assert.ok(!/tb-brand/.test(header[1]), 'a brand mark is back in the window chrome')
  assert.ok(!/<svg[^>]*brand/i.test(header[1]), 'a brand svg is back in the window chrome')

  const styles = readText(path.join(REPO_ROOT, 'src', 'styles.css'))
  assert.ok(!/\.tb-brand/.test(styles), '.tb-brand rules are back in the stylesheet')

  const main = readText(path.join(REPO_ROOT, 'src', 'main.js'))
  assert.ok(!/tb-brand/.test(main), 'src/main.js still writes to the removed chrome slot')
  assert.ok(!/brand-geometry|brand\.js/.test(main), 'the renderer imports the build-time brand module')
})

test('the committed icon files are exactly what the generator produces', () => {
  // Drift guard. Hand-editing shell/icon.ico, or landing a geometry change
  // without regenerating, turns this red instead of shipping a stale mark.
  const bounds = markBounds()
  const images = ICON_SIZES.map((size) => renderIcon(size, { bounds }))
  const expectedIco = encodeIco(images, zlib)
  const expectedPng = encodePng(images.find((image) => image.width === 256), zlib)

  const actualIco = readFileSync(path.join(REPO_ROOT, 'shell', 'icon.ico'))
  const actualPng = readFileSync(path.join(REPO_ROOT, 'shell', 'icon.png'))

  assert.ok(
    actualIco.equals(expectedIco),
    'shell/icon.ico is stale — run `node tools/gen-brand-icons.mjs`',
  )
  assert.ok(
    actualPng.equals(expectedPng),
    'shell/icon.png is stale — run `node tools/gen-brand-icons.mjs`',
  )
})
