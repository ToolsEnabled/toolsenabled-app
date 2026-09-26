/* Rasterizes the TE monogram into the two container formats Windows asks for.
 * Build-time only (tools/** is excluded from build.files); nothing here ships.
 *
 * WHERE THE MARK COMES FROM. The geometry is NOT restated here — it is
 * imported from tools/brand-geometry.mjs, so every rendering of the mark comes
 * the taskbar and the mark in the window are drawn from one set of numbers.
 * Those numbers describe tools/brand/te-monogram.svg, the owner's artwork
 * vendored byte-for-byte, and tools/test/brand-mark.test.mjs parses that file
 * and asserts they still match it. The artwork is not ours to change.
 *
 * WHY NOT RENDER THROUGH CHROMIUM. Electron is already a devDependency and
 * capturePage() could rasterize the SVG directly. It was rejected: capturePage
 * returns pixels at the host display's scale factor, so a 16x16 window yields
 * 24x24 on a 150% display, and alpha from a transparent BrowserWindow is
 * unreliable on Windows. An icon generator whose output depends on the monitor
 * of whoever ran the build is not reproducible. Supersampling six analytic
 * shapes is deterministic on every machine.
 */

import {
  RECTS,
  SKEW_X_DEGREES,
  TRANSLATE_X,
  VIEWBOX,
  markBounds,
  markCoversPoint,
  roundedRectDistance,
} from './brand-geometry.mjs'

export { RECTS, SKEW_X_DEGREES, TRANSLATE_X, VIEWBOX, markBounds, markCoversPoint }

/* ------------------------------------------------------- THE TREATMENT --
 *
 * The mark the owner supplied is BLACK ON TRANSPARENT. That is correct
 * artwork and wrong as a Windows icon, and the difference was measured rather
 * than assumed: rendered onto a dark backdrop it is a black shape on a
 * near-black ground and at 16px it is simply not there. This machine's own
 * shell is in dark mode (AppsUseLightTheme=0), so shipping the transparent
 * artwork straight through would have put an invisible icon on the taskbar of
 * the person who asked for it.
 *
 * So the icon is the mark ON A PLATE. Candidates were rendered and compared on
 * both a dark and a light backdrop before this was chosen:
 *
 *   transparent + black  invisible on dark. Rejected.
 *   white plate          invisible ON LIGHT — the plate dissolves into
 *                        Explorer's white and the mark floats. Rejected.
 *   dark plate + light   loses its own edge on a dark taskbar, AND inverts
 *     mark               the owner's mark for no reason the icon requires.
 *                        Rejected.
 *   tan plate + black    reads on both. Chosen.
 *     mark
 *
 * The plate is #f2e5bc — not an invented brand colour but this product's own
 * tan theme ground (Gruvbox bg0_s, src/styles.css :root[data-theme="tan"]), so
 * the icon is built out of the palette the app already ships. The MARK itself
 * is untouched: same six rects, same transform, same #000000. Nothing here
 * redraws it.
 *
 * OPTICAL SIZING. A single mark-to-canvas ratio does not survive the whole
 * range. Compared at 9x magnification across 16/24/32/48: at 16px a 0.66 ratio
 * turns to mud and 0.84 crowds the rounded corners; at 48px 0.84 is visibly
 * tight while 0.72 breathes. Small icons need proportionally more mark because
 * they have fewer pixels to spend on it, which is why these are a table and
 * not a constant.
 */
export const PLATE_COLOR = Object.freeze([0xf2, 0xe5, 0xbc])
export const MARK_COLOR = Object.freeze([0x00, 0x00, 0x00])
export const PLATE_RADIUS_RATIO = 0.18
export const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256])

function markWidthRatioFor(size) {
  if (size <= 24) return 0.80
  if (size <= 48) return 0.76
  return 0.72
}

/* Supersampled because the mark is sheared: analytic coverage from a signed
 * distance would need the shear's anisotropic scaling folded back in, and
 * getting that subtly wrong shows up as uneven edge weight on the diagonals.
 * Point sampling is correct under any transform. */
export function renderIcon(size, { samples = size <= 32 ? 16 : 8, bounds = markBounds() } = {}) {
  const data = new Uint8Array(size * size * 4)
  const targetWidth = size * markWidthRatioFor(size)
  const scale = targetWidth / bounds.width
  const offsetX = (size - targetWidth) / 2
  const offsetY = (size - bounds.height * scale) / 2
  const radius = size * PLATE_RADIUS_RATIO
  const step = 1 / samples
  const total = samples * samples

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plateHits = 0
      let markHits = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const deviceX = px + (sx + 0.5) * step
          const deviceY = py + (sy + 0.5) * step
          if (roundedRectDistance(deviceX, deviceY, { x: 0, y: 0, width: size, height: size, rx: radius }) <= 0) {
            plateHits += 1
          }
          if (markCoversPoint(bounds.minX + (deviceX - offsetX) / scale, bounds.minY + (deviceY - offsetY) / scale)) {
            markHits += 1
          }
        }
      }

      const plateAlpha = plateHits / total
      const markAlpha = markHits / total
      // The mark is only ever painted where the plate is, so it composites
      // over the plate and the plate's rounded edge stays the icon's outline.
      const outAlpha = markAlpha + plateAlpha * (1 - markAlpha)
      const offset = (py * size + px) * 4
      if (outAlpha <= 0) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const over = MARK_COLOR[channel] * markAlpha
        const under = PLATE_COLOR[channel] * plateAlpha * (1 - markAlpha)
        data[offset + channel] = Math.round((over + under) / outAlpha)
      }
      data[offset + 3] = Math.round(outAlpha * 255)
    }
  }

  return { width: size, height: size, data }
}

/* ------------------------------------------------------------------ PNG --
 * Minimal but complete RGBA8 encoder. Node ships zlib, which is the only hard
 * part of PNG; the rest is four length-tag-data-crc chunks.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * @param {{width: number, height: number, data: Uint8Array}} image RGBA, row-major, top-down.
 * @param {import('node:zlib')} zlib
 */
export function encodePng(image, zlib) {
  const { width, height, data } = image
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} RGBA bytes, received ${data.length}`)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(6, 9) // colour type 6 = truecolour with alpha
  header.writeUInt8(0, 10) // deflate
  header.writeUInt8(0, 11) // adaptive filtering
  header.writeUInt8(0, 12) // no interlace

  // Filter type 0 (None) on every scanline. The shapes are flat colour, so the
  // deflate stream compresses to almost nothing regardless of the filter, and
  // None keeps the encoder trivially auditable.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ ICO --
 *
 * WHY THE FORMAT IS MIXED. A .ico entry may hold either a PNG or a bottom-up
 * BGRA DIB. Windows 10/11 read PNG at every size, but the legacy DIB path is
 * what the shell has always used for the small sizes, and small-size PNG
 * entries are the ones with a history of being ignored by older shell
 * components (and by third-party tools that read icons out of an exe). So:
 * DIB below 128px, PNG at 128 and above — the same split shell32.dll itself
 * uses, and the split that keeps the file small where PNG actually pays.
 *
 * The 1-bit AND mask is legacy and ignored for 32bpp icons, but it is part of
 * the structure and a missing one makes the entry malformed. It is written to
 * agree with the alpha channel rather than filled with zeros.
 */

function encodeIcoDib(image) {
  const { width, height, data } = image

  const infoHeader = Buffer.alloc(40)
  infoHeader.writeUInt32LE(40, 0) // biSize
  infoHeader.writeInt32LE(width, 4) // biWidth
  infoHeader.writeInt32LE(height * 2, 8) // biHeight — XOR image plus AND mask
  infoHeader.writeUInt16LE(1, 12) // biPlanes
  infoHeader.writeUInt16LE(32, 14) // biBitCount
  infoHeader.writeUInt32LE(0, 16) // biCompression = BI_RGB

  const xor = Buffer.alloc(width * height * 4)
  const maskStride = Math.ceil(width / 32) * 4 // 1bpp rows pad to 4 bytes
  const mask = Buffer.alloc(maskStride * height)

  for (let row = 0; row < height; row += 1) {
    const sourceRow = height - 1 - row // DIBs are stored bottom-up
    for (let column = 0; column < width; column += 1) {
      const source = (sourceRow * width + column) * 4
      const target = (row * width + column) * 4
      xor[target] = data[source + 2] // B
      xor[target + 1] = data[source + 1] // G
      xor[target + 2] = data[source] // R
      xor[target + 3] = data[source + 3] // A
      if (data[source + 3] === 0) {
        mask[row * maskStride + (column >> 3)] |= 0x80 >> (column & 7)
      }
    }
  }

  infoHeader.writeUInt32LE(xor.length + mask.length, 20) // biSizeImage
  return Buffer.concat([infoHeader, xor, mask])
}

/**
 * @param {Array<{width: number, height: number, data: Uint8Array}>} images
 * @param {import('node:zlib')} zlib
 * @param {{pngFrom?: number}} options sizes >= pngFrom are stored as PNG.
 */
export function encodeIco(images, zlib, { pngFrom = 128 } = {}) {
  if (!images.length) throw new Error('encodeIco: an icon with no images is not an icon')

  const payloads = images.map((image) => (
    image.width >= pngFrom ? encodePng(image, zlib) : encodeIcoDib(image)
  ))

  const directory = Buffer.alloc(6)
  directory.writeUInt16LE(0, 0) // reserved
  directory.writeUInt16LE(1, 2) // type 1 = icon
  directory.writeUInt16LE(images.length, 4)

  const ENTRY_SIZE = 16
  let offset = directory.length + ENTRY_SIZE * images.length
  const entries = images.map((image, index) => {
    const entry = Buffer.alloc(ENTRY_SIZE)
    // 256 is written as 0: the field is one byte and 256 does not fit.
    entry.writeUInt8(image.width >= 256 ? 0 : image.width, 0)
    entry.writeUInt8(image.height >= 256 ? 0 : image.height, 1)
    entry.writeUInt8(0, 2) // palette size — 0 for truecolour
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(payloads[index].length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += payloads[index].length
    return entry
  })

  return Buffer.concat([directory, ...entries, ...payloads])
}
