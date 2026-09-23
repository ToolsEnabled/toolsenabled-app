#!/usr/bin/env node
/* THE BEHAVIOUR TEST for lane W16e: given a card copy long enough to overflow
 * either clamp, how many lines does the reader actually get, IN A REAL
 * CHROMIUM RENDER -- never "does the stylesheet say 16".
 *
 * Spawns this build's own Electron on tools/w16e-card-lines-main.cjs, which
 * renders tools/w16e-card-lines-fixture.html (the real `.chip-preview` class
 * chain, styled by a `tree-graph.css` loaded unmodified) and measures each
 * labelled box's real clamped height and computed line-height. This script
 * then turns that geometry into a line count and checks it against the room
 * Manager 4 measured on the person's own window
 * (evidence/w16d-cardroom.json), never against the CSS source text.
 *
 *   node tools/w16e-card-lines-check.mjs --out=captures-w16e/pre-fix --rev=9d899d8
 *   node tools/w16e-card-lines-check.mjs --out=captures-w16e/post-fix
 *
 * --rev <gitrev> renders that revision's src/tree-graph.css (via `git show`,
 * read-only -- no checkout, no stash, no reset) instead of this worktree's
 * current one, so the pre-fix RED run never has to edit or revert real
 * source. Omit --rev to render this worktree's own src/tree-graph.css.
 *
 * Exit code: 0 when both `.cl-previous` and `.cl-chat` show at least
 * MIN_LINES lines AND the two boxes' combined growth over their old 2-line
 * baseline still fits inside the measured panel room. 1 otherwise.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const OUT = path.resolve(ROOT, arg('out', path.join('captures-w16e', 'run')))
const REV = arg('rev', null)

// Measured by Manager 4 on the person's own running window, 2026-09-04T19:43Z
// -- see evidence/w16d-cardroom.json (roomBelowCardInPanel), the same file
// the CSS comment in src/tree-graph.css cites for the line budget. The two
// boxes' OLD height (34px each, `.cl-previous`/`.cl-chat`, `clientHeight`)
// is read from the same file rather than retyped, so this check's "old
// baseline" can never silently drift from the measurement it is named after.
const cardroomPath = path.join(ROOT, 'evidence', 'w16d-cardroom.json')
const cardroom = JSON.parse(fs.readFileSync(cardroomPath, 'utf8'))
const ROOM_BUDGET_PX = cardroom.roomBelowCardInPanel
const oldPrevious = cardroom.children.find(c => c.element === 'div.cl.cl-previous')
const oldChat = cardroom.children.find(c => c.element === 'div.cl.cl-chat')
if (typeof ROOM_BUDGET_PX !== 'number' || !oldPrevious || !oldChat) {
  throw new Error(`${cardroomPath} is missing roomBelowCardInPanel or the cl-previous/cl-chat entries this check reads`)
}
const OLD_PREVIOUS_HEIGHT_PX = oldPrevious.clientHeight
const OLD_CHAT_HEIGHT_PX = oldChat.clientHeight

// A behaviour floor, not the exact budget (16): meaningfully above the old
// defect's 2 lines, comfortably below the 16-line ceiling the CSS comment
// derives, so this does not pin an implementation number and still fails
// hard against the defect this lane exists to fix.
const MIN_LINES = 10

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts })
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
}

async function capture() {
  // Captures are evidence. Refuse an occupied destination rather than erase
  // an arbitrary --out directory or overwrite a previous run's measurements.
  if (fs.existsSync(OUT)) throw new Error('Choose a new, empty capture destination with --out.')
  fs.mkdirSync(OUT, { recursive: true })

  let cssOverride = null
  if (REV) {
    cssOverride = path.join(OUT, `tree-graph.${REV}.css`)
    const content = execFileSync('git', ['show', `${REV}:src/tree-graph.css`], { cwd: ROOT, encoding: 'utf8' })
    fs.writeFileSync(cssOverride, content)
  }

  /* NOTHING THIS DRIVER STARTS MAY WRITE INTO THE PERSON'S LIVE RUNTIME.
     Measured 2026-09-04: a process started through host.exec inherits
     TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH pointing at the
     RUNNING product's capability state and its real vault file, so a driver
     that forgets them writes into the state the person's own app is using.
     Electron adds a second one: with no userData set it takes the default
     profile under the inherited APPDATA, which is how an earlier run of this
     driver created a stray `Roaming\\Electron` folder -- outside the product,
     but also outside the Dev temp root AGENTS.md fences probes into.
     All three are pointed at a new scratch directory under that temp root,
     created separately for each run, so a capture can neither read the
     person's state nor leave anything behind in it. */
  const scratchBase = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp'
  const resolvedScratchBase = fs.realpathSync.native(scratchBase)
  if (!resolvedScratchBase.toLowerCase().startsWith('c:\\users\\toolsenabled-dev\\')) {
    throw new Error('The capture scratch directory must resolve inside the ToolsEnabled-Dev profile.')
  }
  const scratch = fs.mkdtempSync(path.join(resolvedScratchBase, 'w16e-card-lines-'))
  const profile = prepareSterileProfile(sterileProfileDirectories(scratch))
  const electronBin = require('electron')
  const code = await run(electronBin, [
    path.join(ROOT, 'tools', 'w16e-card-lines-main.cjs'),
    `--user-data-dir=${path.join(scratch, 'electron')}`,
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...sterileLaunchEnvironment(profile),
      MC_SMOKE_HEADLESS: '1',
      TOOLSENABLED_STATE_ROOT: path.join(scratch, 'state'),
      TOOLSENABLED_VAULT_PATH: path.join(scratch, 'state', 'vault', 'secrets.json'),
      CARD_LINES_OUT: OUT,
      ...(cssOverride ? { CARD_LINES_CSS: cssOverride } : {}),
    },
  })
  console.log(`scratch state root ${path.join(scratch, 'state')} (vault ${path.join(scratch, 'state', 'vault', 'secrets.json')}, electron profile ${path.join(scratch, 'electron')})`)
  const resultsPath = path.join(OUT, 'results.json')
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`electron exited ${code} and wrote no results.json -- see ${path.join(OUT, 'capture-error.log')}`)
  }
  return JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
}

const data = await capture()
console.log(`\ncapture verdict: ${data.verdict.verdict} truthful=${data.verdict.truthful}`)
console.log(`  ${data.verdict.why}`)
console.log(`electron ${data.electron}  chrome ${data.chrome}  css ${REV ? `git show ${REV}:src/tree-graph.css` : 'this worktree\'s src/tree-graph.css'}\n`)

const byName = Object.fromEntries(data.boxes.map(b => [b.name, b]))
const previous = byName['fixture-previous']
const chat = byName['fixture-chat']
if (!previous || !chat) {
  console.log(`FAIL -- fixture did not produce both fixture-previous and fixture-chat boxes (found: ${data.boxes.map(b => b.name).join(', ')})`)
  process.exitCode = 1
  process.exit()
}

let ok = true
for (const [label, box, oldHeight] of [['cl-previous', previous, OLD_PREVIOUS_HEIGHT_PX], ['cl-chat', chat, OLD_CHAT_HEIGHT_PX]]) {
  const pass = box.linesShown >= MIN_LINES
  console.log(`  ${label.padEnd(14)} lineHeight=${box.lineHeight}px clampedHeight=${box.clampedClientHeight}px linesShown=${box.linesShown} (unclamped ${box.unclampedHeight}px, overflowing=${box.overflowing}) old=${oldHeight}px`)
  console.log(`      ${pass ? 'GREEN' : 'RED '} linesShown >= ${MIN_LINES}: ${pass}`)
  if (!pass) ok = false
}

const grownPrevious = Math.max(0, previous.clampedClientHeight - OLD_PREVIOUS_HEIGHT_PX)
const grownChat = Math.max(0, chat.clampedClientHeight - OLD_CHAT_HEIGHT_PX)
const totalGrowth = grownPrevious + grownChat
const fitsPanel = totalGrowth <= ROOM_BUDGET_PX
console.log(`\n  combined growth over old 2-line baseline: ${grownPrevious.toFixed(2)}px (previous) + ${grownChat.toFixed(2)}px (chat) = ${totalGrowth.toFixed(2)}px`)
console.log(`  measured room below the card in its panel (evidence/w16d-cardroom.json): ${ROOM_BUDGET_PX}px`)
console.log(`      ${fitsPanel ? 'GREEN' : 'RED '} totalGrowth <= ${ROOM_BUDGET_PX}: ${fitsPanel}`)
if (!fitsPanel) ok = false

fs.writeFileSync(path.join(OUT, 'evaluation.json'), JSON.stringify({
  minLines: MIN_LINES,
  roomBudgetPx: ROOM_BUDGET_PX,
  oldPreviousHeightPx: OLD_PREVIOUS_HEIGHT_PX,
  oldChatHeightPx: OLD_CHAT_HEIGHT_PX,
  previous, chat,
  grownPrevious, grownChat, totalGrowth, fitsPanel, ok,
}, null, 2))

console.log(`\n${ok ? 'PASS' : 'FAIL'} -- full evidence in ${path.relative(ROOT, OUT)}\n`)
process.exitCode = ok ? 0 : 1
