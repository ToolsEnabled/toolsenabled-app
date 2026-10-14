#!/usr/bin/env node

/* THE WEBSITE PREVIEW MAY NOT CLAIM ITS SIMULATION IS REAL — CHECKED IN THE FILES.
 *
 * public/preview/honesty.js enforces this at RUNTIME, in the DOM, on the page a
 * visitor actually loads. That is the enforcement that matters. This guard is
 * the second half, and it exists because a runtime control can only refuse what
 * a browser reaches: an authored liveness claim that only appears on a rare
 * branch would ship, sit there unexercised, and refuse the whole preview the
 * first time a real visitor happened to hit it. Better to fail the build.
 *
 * It also polices three things the runtime guard structurally cannot:
 *
 *   - NO PAID CAPABILITY IN THE PREVIEW. The owner's shape for this surface is
 *     "no need for preview of paid services" (2026-08-11). `hosted-relay` is the
 *     engine's entire gated set today (src/lib/entitlement.js GATED_CAPABILITIES).
 *     If it ever appears in the preview outside the list that names it as
 *     forbidden, that is a shipped promise nobody decided to make.
 *
 *   - NO EGRESS. The preview must have no backend. Any absolute URL, socket
 *     constructor, or loopback address in this directory contradicts that. This
 *     is also the fix for the finding R1260 lane t5a raised: the product page
 *     makes every visitor's browser probe their OWN localhost, which is the one
 *     defect on that list that gets WORSE rather than merely staying broken once
 *     the site is public.
 *
 *   - THE PAYLOAD BOUNDARY. Every preview file must be classified `shipped` in
 *     config/renderer-payload-boundary.json. An unclassified file under public/
 *     is exactly how the operator's private purchase list once reached every
 *     installer.
 *
 * THE LEGAL CLEARANCE IS CONDITIONAL AND LAPSES WITH THE ARCHITECTURE. The
 * legal lane cleared this simulation for publication
 * (legal/reports/R-009-simulation-disclosure.md) on the strength of exactly
 * the properties this guard and honesty.js enforce. Their standing note,
 * recorded here so it is mechanical rather than remembered: if the honesty
 * architecture is ever weakened — a stateChip bypass, an unfrozen
 * vocabulary, a non-terminal refusal, a shortened disclosure — the
 * determination lapses and the page comes down until re-reviewed.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs and tools/check-product-naming.mjs
 * deliberately, because the build chains these together:
 *   0  clean
 *   1  a finding — something in the preview claims or ships what it must not
 *   2  a setup problem — the guard could not do its job, which must never be
 *      silently indistinguishable from a pass. An empty scan is a setup problem,
 *      not a clean sweep.
 *
 * Usage: node tools/check-preview-honesty.mjs [preview-root]
 *   default root: public/preview
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ROOT = path.join(REPO_ROOT, 'public', 'preview')
const MANIFEST = path.join(REPO_ROOT, 'config', 'renderer-payload-boundary.json')

/* The definition site. It is the ONE file allowed to spell the forbidden words,
 * because spelling them is how it recognises them. Every other file in the
 * directory is scanned. */
const DEFINITION_FILE = 'honesty.js'

const LIVENESS_WORDS = [
  /\blive\b/i, /\breal[\s-]?time\b/i, /\brealtime\b/i, /\bconnected\b/i,
  /\bonline\b/i, /\bstreaming now\b/i, /\bactually running\b/i, /\bright now\b/i,
]

const PAID_CAPABILITY_IDS = ['hosted-relay']

const EGRESS_PATTERNS = [
  { pattern: /\bhttps?:\/\/(?!schema\.)/i, why: 'an absolute URL — the preview must be same-origin and static' },
  { pattern: /\bnew\s+WebSocket\b/, why: 'a WebSocket — the preview has no backend' },
  { pattern: /\bXMLHttpRequest\b/, why: 'an XMLHttpRequest — the preview has no backend' },
  { pattern: /\bEventSource\b/, why: 'an EventSource — the preview has no backend' },
  { pattern: /\b127\.0\.0\.1\b/, why: "a loopback address — a public page must never make a visitor's browser probe their own machine" },
  { pattern: /\blocalhost\b/i, why: "a loopback host — a public page must never make a visitor's browser probe their own machine" },
  { pattern: /\bnavigator\.sendBeacon\b/, why: 'a beacon — the preview reports nothing about its visitors' },
  { pattern: /\blocalStorage\b|\bsessionStorage\b|\bdocument\.cookie\b/, why: 'browser storage — the preview leaves no trace on a visitor\'s machine' },
]

function fail(code, lines) {
  for (const line of lines) process.stdout.write(`${line}\n`)
  process.exit(code)
}

function listFiles(root) {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT

if (!existsSync(root)) {
  fail(2, [`SETUP: the preview root ${path.relative(REPO_ROOT, root) || root} does not exist, so this guard checked nothing.`])
}

let files
try {
  files = listFiles(root)
} catch (error) {
  fail(2, [`SETUP: could not read ${root}: ${error.message}`])
}

if (files.length === 0) {
  fail(2, [`SETUP: ${path.relative(REPO_ROOT, root) || root} contains no files. An empty scan is not a clean scan.`])
}

const findings = []
let definitionSeen = false

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(2, [`SETUP: could not read ${rel}: ${error.message}`])
  }

  if (rel === DEFINITION_FILE) {
    definitionSeen = true
    if (!/LIVENESS_CLAIM/.test(text) || !/LIVENESS_MARKERS/.test(text)) {
      findings.push(`${rel}: the runtime guard no longer defines LIVENESS_CLAIM and LIVENESS_MARKERS, so nothing enforces the rule on the page.`)
    }
    if (!/PAID_GATED\s*=\s*Object\.freeze\(\[\s*'hosted-relay'/.test(text)) {
      findings.push(`${rel}: PAID_GATED no longer mirrors the engine's gated set, so the preview could show a paid capability.`)
    }
    if (!/Nothing on this page is live/.test(text)) {
      findings.push(`${rel}: the disclosure sentence no longer says that nothing on the page is live.`)
    }
    // the definition file is exempt from the word scan below, by design
    continue
  }

  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const word of LIVENESS_WORDS) {
      const hit = word.exec(line)
      if (hit) {
        findings.push(`${rel}:${index + 1}: "${hit[0]}" asserts the simulated data is real — ${line.trim().slice(0, 90)}`)
      }
    }
    for (const capability of PAID_CAPABILITY_IDS) {
      if (line.includes(capability)) {
        findings.push(`${rel}:${index + 1}: names the paid capability "${capability}"; this preview shows the product, not the paid services.`)
      }
    }
    for (const { pattern, why } of EGRESS_PATTERNS) {
      if (pattern.test(line)) {
        findings.push(`${rel}:${index + 1}: ${why} — ${line.trim().slice(0, 90)}`)
      }
    }
  })

  if (rel === 'index.html' && !/default-src 'none'/.test(text)) {
    findings.push(`${rel}: the Content-Security-Policy no longer starts from default-src 'none', so the page can reach hosts it does not need.`)
  }
}

if (!definitionSeen) {
  fail(2, [`SETUP: ${DEFINITION_FILE} is not in ${path.relative(REPO_ROOT, root) || root}. Without it nothing enforces honesty at runtime and this guard has no definition site to check.`])
}

/* payload boundary — only meaningful when scanning the authored directory */
if (path.resolve(root) === path.resolve(DEFAULT_ROOT)) {
  if (!existsSync(MANIFEST)) {
    fail(2, ['SETUP: config/renderer-payload-boundary.json is missing, so the preview payload cannot be classified.'])
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  } catch (error) {
    fail(2, [`SETUP: config/renderer-payload-boundary.json is not readable JSON: ${error.message}`])
  }
  const shipped = new Set((manifest.shipped && manifest.shipped.paths) || [])
  for (const file of files) {
    const rel = path.relative(path.join(REPO_ROOT, 'public'), file).split(path.sep).join('/')
    if (!shipped.has(rel)) {
      findings.push(`config/renderer-payload-boundary.json does not classify public/${rel}; an unclassified file under public/ ships because nobody said it should not.`)
    }
  }
}

if (findings.length > 0) {
  process.stdout.write(`Preview honesty: ${findings.length} finding(s) across ${files.length} file(s) in ${path.relative(REPO_ROOT, root) || root}.\n`)
  for (const finding of findings) process.stdout.write(`  - ${finding}\n`)
  process.exit(1)
}

process.stdout.write(
  `Preview honesty: clean. ${files.length} file(s) in ${path.relative(REPO_ROOT, root) || root}; `
  + `0 liveness claims, 0 paid capabilities, 0 egress, all classified.\n`,
)
process.exit(0)
