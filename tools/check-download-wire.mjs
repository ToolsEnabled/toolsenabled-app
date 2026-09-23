#!/usr/bin/env node
/*
 * check-download-wire.mjs — R1260 T5.1
 *
 * Refuses a website build whose download surface is not backed by a complete,
 * verified candidate declaration.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured 2026-08-11 against the built site (dist/): there are ZERO download
 * controls anywhere across all 12 routes, while the home page tells a visitor
 * "Open the installed app to see them." A stranger is instructed to open
 * something they have no way to obtain. The wire from that page to an installer
 * is the missing piece.
 *
 * The dangerous way to close that gap is to paste a link to whatever .exe is
 * lying in a build directory. Machine A's own coordinator wrote a file on
 * 2026-08-11 titled DO-NOT-DECLARE-THESE-README.md establishing that NO binary
 * currently staged is a candidate: two of the four carry no declaration at all,
 * and the build directory reuses one filename per build, so a hash quoted
 * against that path expires silently on the next rebuild.
 *
 * So the rule this guard enforces is: THE DOWNLOAD SURFACE IS DRIVEN BY A
 * DECLARATION, NEVER BY A PATH. No declaration -> no download surface. This is
 * written absence-first on purpose: the recurring defect in this codebase is
 * absence read as consent (a missing field, an empty string, a falsy default
 * that turns "nothing specified" into "allowed"). Every rule below treats a
 * MISSING or EMPTY value as a REFUSAL, never as a pass.
 *
 * Usage:
 *   node tools/check-download-wire.mjs <distDir> [--manifest <path>] [--candidate-root <dir>]
 * Exit:
 *   0 = wire is consistent AND something was actually measured
 *   1 = violation, or vacuous scan (zero files seen)
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  comparePeIdentity,
  peIdentityManifestIsSane,
  readExeVersionInfo,
} = require('../shell/installer-pe-identity.cjs')

const HEX64 = /^[0-9a-f]{64}$/i
const HEX40 = /^[0-9a-f]{40}$/i

/* Every field Machine B's acceptance matrix "Immutable declaration" row names.
 * Keep this list in step with MACHINE-B-REPLACEMENT-BUILD-ACCEPTANCE-MATRIX.md;
 * a field dropped from here is a field B will demand and not receive. */
const REQUIRED = [
  ['filename', v => typeof v === 'string' && v.trim().length > 0 && v.trim().toLowerCase().endsWith('.exe'),
    'non-empty installer filename ending in .exe'],
  ['version', v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v.trim()),
    'semver-shaped version, e.g. 1.0.6'],
  ['bytes', v => Number.isInteger(v) && v > 0,
    'exact byte count as a positive integer (not a string, not 0)'],
  ['sha256', v => typeof v === 'string' && HEX64.test(v.trim()),
    '64 hex characters, taken on a FROZEN copy'],
  ['productName', v => typeof v === 'string' && v.trim().length > 0,
    'non-empty ProductName measured from the installer PE'],
  ['fileVersion', v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:\.0)?$/.test(v.trim()),
    'FileVersion measured from the installer PE'],
  ['productVersion', v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:\.0)?$/.test(v.trim()),
    'ProductVersion measured from the installer PE'],
  ['buildRef', v => typeof v === 'string' && HEX40.test(v.trim()),
    'full 40-character commit ref (an abbreviated ref cannot identify a build)'],
  ['publisher', v => typeof v === 'string' && v.trim().length > 0,
    'publisher string exactly as it appears in Installed Apps'],
  ['appId', v => typeof v === 'string' && v.trim().length > 0,
    'appId, e.g. com.toolsenabled.desktop'],
  ['immutableLocation', v => typeof v === 'string' && v.trim().length > 0,
    'frozen path OUTSIDE any build output directory'],
]

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/* Find things that look like an offer of an installer to a visitor.
 * Deliberately broad: it is better to make a real download declare itself than
 * to miss one. `a.download = name` (the blob-export idiom already in this
 * bundle) is NOT a product download and must not be matched -- matching it
 * would make the guard cry wolf and get switched off. */
function findInstallerOffers(files) {
  const hits = []
  for (const f of files) {
    const ext = extname(f).toLowerCase()
    if (!['.js', '.html', '.css', '.json', '.mjs'].includes(ext)) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    // href/src/url pointing at a .exe, or an explicit download-manifest marker
    const re = /(?:href|src|url|action)\s*[=:]\s*["'`]([^"'`]*\.exe[^"'`]*)["'`]/gi
    let m
    while ((m = re.exec(text))) hits.push({ file: f, kind: 'installer-link', value: m[1] })
    if (/data-download-candidate/.test(text)) hits.push({ file: f, kind: 'download-marker', value: 'data-download-candidate' })
  }
  return hits
}

export function peIdentityViolations({ manifest, measured, candidate = 'candidate' }) {
  const verdict = comparePeIdentity(manifest, measured)
  if (verdict.ok) return []
  if (verdict.mismatches.length === 0) {
    return [`PE IDENTITY UNREADABLE at ${candidate}: ${verdict.reason}`]
  }
  return verdict.mismatches.map(({ field, expected, actual }) => (
    `PE IDENTITY MISMATCH at ${candidate}: ${field} declared ${JSON.stringify(expected)}, measured ${JSON.stringify(actual)}`
  ))
}

async function main() {
  const argv = process.argv.slice(2)
  const positional = argv.filter(a => !a.startsWith('--'))
  const flag = name => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : null
  }
  const distDir = resolve(positional[0] || 'dist')
  const manifestPath = resolve(flag('manifest') || join(distDir, 'download.json'))
  const candidateRoot = flag('candidate-root') ? resolve(flag('candidate-root')) : null

  const violations = []

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.error(`REFUSING: dist directory not found: ${distDir}`)
    process.exit(1)
  }

  const files = walk(distDir)
  // Vacuity guard: a scan that saw nothing must never report success.
  if (files.length === 0) {
    console.error(`REFUSING SUCCESS: scanned ZERO files under ${distDir}`)
    process.exit(1)
  }

  const offers = findInstallerOffers(files)
  const manifestPresent = existsSync(manifestPath)

  // ---- Rule 1: ABSENCE FIRST. A download offer with no declaration refuses.
  if (!manifestPresent && offers.length > 0) {
    for (const o of offers) {
      violations.push(`DOWNLOAD OFFER WITH NO DECLARATION: ${o.kind} "${o.value}" in ${o.file} but no manifest at ${manifestPath}`)
    }
  }

  let manifest = null
  let manifestParsed = false
  if (manifestPresent) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifestParsed = true
    } catch (err) {
      violations.push(`DECLARATION UNREADABLE: ${manifestPath}: ${err.message}`)
    }
  }

  if (manifestParsed && manifest !== null) {
    if (typeof manifest !== 'object' || Array.isArray(manifest)) {
      violations.push(`DECLARATION MALFORMED: ${manifestPath} must be a JSON object`)
    } else {
      // ---- Rule 2: every required field present, correctly shaped, non-empty.
      for (const [key, ok, expectation] of REQUIRED) {
        if (!(key in manifest)) {
          violations.push(`DECLARATION MISSING FIELD "${key}": expected ${expectation}`)
        } else if (!ok(manifest[key])) {
          violations.push(`DECLARATION FIELD "${key}" INVALID (${JSON.stringify(manifest[key])}): expected ${expectation}`)
        }
      }
      if (!peIdentityManifestIsSane(manifest)) {
        violations.push(
          'DECLARATION PE IDENTITY INCONSISTENT: FileVersion and ProductVersion must identify the same release as version',
        )
      }
      // A declaration must not point into a build output directory: those reuse
      // one filename per build, so the hash expires without the name changing.
      const loc = String(manifest.immutableLocation || '')
      if (/[\\/](release|dist|out|build)[\\/]?$/i.test(loc) || /[\\/](release|dist|out|build)[\\/]/i.test(loc)) {
        violations.push(`DECLARATION immutableLocation POINTS INTO A BUILD DIRECTORY (${loc}): freeze the candidate outside it first`)
      }

      // ---- Rule 3: if the bytes are reachable, they must match the declaration.
      if (candidateRoot && typeof manifest.filename === 'string' && manifest.filename.trim()) {
        const candidate = join(candidateRoot, manifest.filename.trim())
        if (!existsSync(candidate)) {
          violations.push(`DECLARED CANDIDATE NOT FOUND at ${candidate} (declaration names it, disk does not have it)`)
        } else {
          const buf = readFileSync(candidate)
          const sha = createHash('sha256').update(buf).digest('hex')
          const bytesMatch = buf.length === manifest.bytes
          const shaMatches = String(manifest.sha256 || '').toLowerCase() === sha
          if (!bytesMatch) {
            violations.push(`BYTE COUNT MISMATCH: declared ${manifest.bytes}, measured ${buf.length} at ${candidate}`)
          }
          if (!shaMatches) {
            violations.push(`SHA-256 MISMATCH: declared ${String(manifest.sha256).toLowerCase()}, measured ${sha} at ${candidate}`)
          }
          if (bytesMatch && shaMatches) {
            try {
              const measuredIdentity = await readExeVersionInfo(candidate)
              violations.push(...peIdentityViolations({ manifest, measured: measuredIdentity, candidate }))
            } catch (error) {
              violations.push(`PE IDENTITY UNREADABLE at ${candidate}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }

        // A candidate directory is an inventory, not a search path. Verifying
        // the one declared file while silently ignoring another installer in
        // the same inventory would turn "this file matched" into approval of
        // bytes the declaration never named.
        const candidateIdentity = resolve(candidate)
        for (const file of walk(candidateRoot)) {
          if (extname(file).toLowerCase() !== '.exe') continue
          const fileIdentity = resolve(file)
          const sameFile = process.platform === 'win32'
            ? fileIdentity.toLowerCase() === candidateIdentity.toLowerCase()
            : fileIdentity === candidateIdentity
          if (!sameFile) {
            violations.push(`UNDECLARED CANDIDATE FOUND at ${file} (candidate inventory contains an installer the declaration does not name)`)
          }
        }
      }

      // ---- Rule 4: THE OFFER MUST BE THE DECLARED FILE.
      // Rules 2 and 3 only prove the declaration is internally sound and that
      // ITS OWN bytes verify. Nothing above ever compared the file the PAGE
      // OFFERS against the file the declaration DESCRIBES, so a page offering
      // any other .exe passed as long as some valid declaration existed
      // elsewhere in the bundle -- the declaration authorised a download it had
      // never seen. That is this codebase's recurring defect exactly: the LINK
      // between offer and declaration was absent, and absence was read as
      // consent. The guard's stated rule is "driven by a DECLARATION, never by
      // a PATH"; without this rule an undeclared PATH is precisely what shipped.
      const declaredName = String(manifest.filename || '').trim().toLowerCase()
      for (const o of offers) {
        if (o.kind !== 'installer-link') continue
        // Compare on the last path segment: the declaration names a file, the
        // page may serve it from any directory or CDN prefix.
        const offered = String(o.value).split(/[?#]/)[0].split(/[\\/]/).pop().toLowerCase()
        if (!declaredName || offered !== declaredName) {
          violations.push(`OFFER DOES NOT MATCH THE DECLARATION: page offers "${o.value}" (file "${offered}") in ${o.file}, but the declaration describes "${manifest.filename}". A declaration authorises exactly one file.`)
        }
      }
    }
  } else if (manifestParsed && manifest === null) {
    violations.push(`DECLARATION MALFORMED: ${manifestPath} must be a JSON object`)
  }

  console.log(`scanned ${files.length} file(s) under ${distDir}`)
  console.log(`installer offers found: ${offers.length}`)
  console.log(`declaration: ${manifestPresent ? manifestPath : 'ABSENT'}`)

  if (violations.length > 0) {
    console.error(`\nDOWNLOAD WIRE VIOLATION -- ${violations.length} problem(s). This site must not publish a download.`)
    for (const v of violations) console.error(`  - ${v}`)
    process.exit(1)
  }

  // Absent manifest + zero offers is the CORRECT state today: no candidate has
  // been declared, so the site correctly offers no download. Say so plainly
  // rather than printing a bare "ok" that reads as "the download works".
  if (!manifestPresent) {
    console.log('\nOK: no declaration and no download offer -- consistent. The site offers no installer, which is correct while no candidate is declared.')
  } else {
    console.log('\nOK: download offer is backed by a complete, verified declaration.')
  }
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`REFUSING: download-wire gate failed while measuring the candidate: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
