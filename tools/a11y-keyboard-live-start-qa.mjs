#!/usr/bin/env node

/* THE COSTLY HALF OF THE KEYBOARD AUDIT.
 *
 * tools/a11y-keyboard-qa.mjs is the deterministic release lane: it measures
 * the full keyboard surface and its disabled-state explanation without
 * pressing Start. A successful Start and Stop necessarily creates a real Codex
 * session, so it is a separate discovered driver that packaged-qa-suite holds
 * back unless the operator explicitly supplies --include-costly.
 *
 * This wrapper changes no evidence and interprets no verdict. It adds exactly
 * the live opt-in and the current Windows user's Codex-home pointer, forwards
 * --release (and every other suite argument) unchanged, and exits with the
 * underlying audit's status. */

import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const AUDIT = path.join(path.dirname(SELF), 'a11y-keyboard-qa.mjs')
const forwarded = process.argv.slice(2)

if (forwarded.some(value => value === '--press-start' || value === '--codex-home' || value.startsWith('--codex-home='))) {
  console.error('a11y-keyboard-live-start-qa: --press-start and --codex-home are owned by this costly wrapper.')
  process.exit(2)
}

const codexHome = path.join(os.homedir(), '.codex')
const result = spawnSync(process.execPath, [AUDIT, ...forwarded, '--press-start', '--codex-home', codexHome], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) {
  console.error(`a11y-keyboard-live-start-qa: could not run the keyboard audit: ${result.error.message}`)
  process.exit(2)
}
process.exit(Number.isInteger(result.status) ? result.status : 2)
