#!/usr/bin/env node

// THE AGENT DRILL-IN, DRIVEN IN A REAL PACKAGED WINDOW.
//
// WHY THIS CANNOT BE A `node --test` SUITE. src/views/agent.js imports a
// stylesheet and builds DOM, and reaches it through components.js, whose module
// graph starts the demonstration simulator's timers on import and never lets a
// plain node process exit. So everything a unit suite could say about this page
// is a statement about its SOURCE TEXT -- and source text cannot see
// reachability. Measured on this very tree, not argued: planting `return ''` at
// the top of the roster builder, with the real builder still below it, renders
// the page with NO AGENTS while every source assertion stays true. The import is
// still there, the view still calls buildAgentRoster(), the module still exports
// it. Dead code matches a text search exactly as well as live code does.
//
// So this renders the window and reads the pixels and the words on it.
//
// WHAT IT ASSERTS, and each item is one of the defects this lane was given:
//   1. NOTHING OVERLAPS. Measured as real intersecting boxes between every pair
//      of text-bearing elements in the roster, not as "the layout looks right".
//   2. Every agent's status line is INSIDE its own agent's card.
//   3. The runtime readout cannot be read as a time of day.
//   4. The example-data notice is on the glass, and overlaps nothing.
//   5. Chat and Controls are both fully within the viewport.
//   6. The retired confinement claim appears nowhere on the page.
//
// ISOLATION, each mechanism for a measured reason (borrowed wholesale from
// tools/setup-walkthrough-qa.mjs, which learned each of them the hard way):
//   --user-data-dir   Electron resolves userData through the Windows
//                     known-folder API, not the environment. This switch is the
//                     supported override AND it changes the single-instance lock
//                     key, so this runs alongside a copy someone else is using.
//   LOCALAPPDATA      resolveServicesRoot() is our own code reading the
//                     environment, so the machine record lands in scratch. This
//                     one is load-bearing here specifically: without it this
//                     harness would read the OWNER'S recorded permission level,
//                     and a lane that skipped it this same night measured
//                     "unrestricted" and concluded the tier was not enforced.
//   USERPROFILE       so the Codex-home probe reads scratch, not a real profile.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node, exits
// 0, and is indistinguishable from a crash.
//
// IT KILLS ONLY WHAT IT STARTED, matched by executable PATH under its own
// scratch copy, and it writes nothing under release/.
//
// RUN IT:
//   node tools/agent-subpage-qa.mjs                    (1600x900, all themes)
//   node tools/agent-subpage-qa.mjs --shots <dir>      (keep the screenshots)

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { createSession, machineRecordProductDirectory, userDataFor } from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const SHOTS = argument('--shots', null)
const KEEP = process.argv.includes('--keep')

// The three window sizes the product is checked at, and all three themes.
const SIZES = [[1280, 800], [1600, 900], [1920, 1080]]
const THEMES = ['white', 'tan', 'black']
/* The recorded level no longer changes what THIS page renders. The session
   surface that read the level is gone from the demonstration copy on purpose
   (see the reconciliation note where the per-level session checks used to be),
   so the roster/layout this harness measures is identical at every level. One
   representative level -- the fail-closed default a fresh install shows --
   exercises the layout; a specific level can still be forced with --tier, and
   the confinement copy per level is proven on the LIVE agent page by
   tools/first-run-contract-qa.mjs and in unit form by
   tools/test/agent-confinement-read.test.mjs. */
const TIERS = argument('--tier') ? [argument('--tier')] : ['guided']
// Screenshots come from the fail-closed default, which is what a fresh install
// shows and therefore what a new customer actually sees.
const SHOT_TIER = 'guided'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* Two consecutive identical readings of the geometry this suite asserts on,
   with a ceiling so a genuinely oscillating layout still reports rather than
   hanging. Reads the same boxes the checks read, so "settled" means settled for
   the purpose it is being waited on for. */
const SETTLE_PROBE = `(() => {
  const box = sel => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().height) : -1 }
  return [box('.agentv-roster'), box('.agentv-panels-wrap'), box('.agent-session-surface'), box('.ar-card'), window.innerHeight].join(',')
})()`

async function settle(evaluate, { attempts = 40, gap = 120 } = {}) {
  /* FONTS FIRST, and this is the actual cause rather than a precaution.
     Web fonts land AFTER first paint and change text metrics with no DOM
     mutation and no resize event -- src/views/agent.js carried a comment about
     exactly this hazard for its old placement cache. Measured here: a card is
     164px tall with the real face loaded and 159px with the fallback, and on the
     run where the fallback was still in force the whole column reflowed and the
     roster read 149px instead of 251px. That produced a failure with IDENTICAL
     numbers twice, which is what made it look deterministic rather than like the
     race it is. Awaiting the font set removes the variable instead of sampling
     around it. */
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
  let previous = null
  let stable = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reading = await evaluate(SETTLE_PROBE)
    stable = reading === previous ? stable + 1 : 0
    previous = reading
    /* Two agreements, not one: a single repeat can be two reads inside the same
       frame, which agrees without anything having settled. */
    if (stable >= 2) return
    await delay(gap)
  }
  console.warn(`    (layout still moving after ${attempts * gap}ms; measuring anyway: ${previous})`)
}

/* ---------- stage a real packaged copy ----------
 * Deliberately NOT electron-builder: three lanes had node_modules damaged by it
 * writing through this worktree's junction in one day. This borrows the built
 * binary and the capability payload, swaps in the CURRENT dist/ and shell/, and
 * writes nothing under release/. */
async function stage(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')

  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  return appExecutable(app)
}

/* FIND THE BINARY, DO NOT NAME IT.
 *
 * The product is being renamed from "Mission Control" to "ToolsEnabled" by
 * another lane as this is written, so `release/win-unpacked` and the source tree
 * disagree about the executable's name for as long as that is in flight. A
 * hardcoded name is therefore guaranteed to be wrong for somebody: it was, and
 * the symptom was `spawn ...\ToolsEnabled.exe ENOENT` against a release folder
 * that still held `Mission Control.exe` -- which reads exactly like a broken
 * build and is really a stale string.
 *
 * The top-level .exe of an electron-builder output is unambiguous without being
 * named: the launcher is the only executable directly in the app root (the
 * others live under resources/ and locales/). Picking it by shape rather than by
 * spelling means this harness keeps working across the rename in both
 * directions, and reports something actionable if the layout genuinely changes. */
function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  if (executables.length === 0) throw new Error(`no .exe in the staged app at ${appRoot}`)
  /* More than one is not a coin toss: electron-builder emits helper binaries
     with recognisable names, so prefer the one that is not obviously a helper
     and say what was found if that is still ambiguous. */
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

/* A PORT NOBODY ELSE HOLDS, asked for rather than guessed. A fixed debugger port
 * measured one failure in four here: the previous run's Electron had not released
 * it, and "the app exited before it painted" is indistinguishable from a real
 * startup crash. An instrument that is flaky one run in four does not report a
 * defect, it reports a coin toss. */
async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/* ---------- what is actually on the glass ----------
 *
 * `visible` is MEASURED, never assumed. Text in the DOM is not text on the
 * screen: a stylesheet that hides a row leaves every string exactly where a
 * textContent read finds it, and leaves the page blank. */
const READ_PAGE = `(() => {
  const view = document.querySelector('.agentv')
  if (!view) return { present: false }
  const norm = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  /* VISIBLE MEANS VISIBLE, INCLUDING NOT CLIPPED AWAY.
     A getBoundingClientRect is happily returned for an element scrolled out of
     a scroll container -- the roster is one -- so a card two rows down still
     reports a box sitting over whatever is further down the page. Comparing
     those boxes produces overlaps that no person can see, which is how a
     collision check starts reporting the scenery. Anything outside its own
     scrollport is therefore not on the glass for this suite's purposes. */
  const clippedAway = node => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue
      const clip = parent.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      const w = Math.min(box.right, clip.right) - Math.max(box.left, clip.left)
      const h = Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top)
      if (w <= 1 || h <= 1) return true
    }
    return false
  }
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    return !clippedAway(node)
  }
  const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }

  const cards = [...document.querySelectorAll('.ar-card')]
  const readCard = card => ({
    id: card.dataset.agentId,
    box: box(card),
    name: norm(card.querySelector('.ar-name')),
    role: norm(card.querySelector('.ar-role')),
    runtime: norm(card.querySelector('.ar-runtime-value')),
    runtimeNote: norm(card.querySelector('.ar-runtime-note')),
    status: norm(card.querySelector('.ar-status-current')),
    statusInsideCard: (() => {
      const s = card.querySelector('.ar-status-current')
      if (!s) return null
      const c = card.getBoundingClientRect(), r = s.getBoundingClientRect()
      return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1
    })(),
    nameVisible: shown(card.querySelector('.ar-name')),
    roleVisible: shown(card.querySelector('.ar-role')),
    statusVisible: shown(card.querySelector('.ar-status-current')),
  })

  /* EVERY PAIR OF TEXT-BEARING ELEMENTS IN THE ROSTER, tested as real boxes.
     This is the defect the owner reported -- names printed over other names --
     so it is measured as geometry rather than inferred from the markup. */
  /* EVERY text-bearing element on the page, not just the roster's.
     The first version of this list stopped at the roster classes, and an overlap
     it could not see shipped straight past it: .graph-crumb is position absolute
     in the shared stylesheet, so once it became a flex child of the header row
     it left the flow and printed through the example-data banner beside it.
     Found by eye on the black theme at 1280x800. A collision check that only
     knows about the elements you were thinking of is a check for the bugs you
     already expected. */
  const texts = [...document.querySelectorAll(
    '.ar-name, .ar-role, .ar-runtime-value, .ar-runtime-note, .ar-status-current, .ar-status-previous,'
    + '.agent-provenance, .graph-crumb, .ar-title, .ar-count, .agent-strip,'
    + '.agent-session-surface [data-action-output], .agent-session-surface [data-session-status],'
    + '.agentv .apanel-title')]
    .filter(shown)
  /* The part of an element a person can actually SEE: its own box intersected
     with every scroll container above it. A card half-scrolled out of the roster
     has a full-height rect but only its visible strip is on the glass, and it is
     the visible strip that can collide with something. */
  const visibleRect = node => {
    let r = node.getBoundingClientRect()
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue
      const c = parent.getBoundingClientRect()
      box = {
        left: Math.max(box.left, c.left), top: Math.max(box.top, c.top),
        right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom),
      }
    }
    return box
  }
  const overlaps = []
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      /* Skip an ancestor/descendant pair: a row legitimately contains its own
         text, and "the strip overlaps the word inside the strip" is not a
         defect, it is containment. */
      if (texts[i].contains(texts[j]) || texts[j].contains(texts[i])) continue
      const a = visibleRect(texts[i]), b = visibleRect(texts[j])
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (w > 1 && h > 1) {
        overlaps.push({
          a: norm(texts[i]).slice(0, 40), b: norm(texts[j]).slice(0, 40),
          overlapPx: Math.round(w * h),
        })
      }
    }
  }

  const provenance = document.querySelector('.agent-provenance')
  const floatingNotice = document.querySelector('.fleet-profile-notice')
  const chat = document.querySelector('.agentv .chat-panel')
  const controls = document.querySelector('.agentv .ctl-panel')
  const within = node => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
  }
  /* The four primary controls must be WHOLE, not straddling the panel edge. */
  const actionsWhole = [...document.querySelectorAll('.agentv .ctl-actions .ctl-btn')].map(b => {
    const r = b.getBoundingClientRect(), p = controls.getBoundingClientRect()
    return { label: norm(b.querySelector('.ctl-label')), height: Math.round(r.height), inPanel: r.bottom <= p.bottom + 1 && r.top >= p.top - 1 }
  })

  return {
    present: true,
    mode: view.dataset.liveMode,
    cardCount: cards.length,
    cards: cards.map(readCard),
    overlaps,
    provenance: norm(provenance),
    provenanceKind: provenance?.dataset?.kind || null,
    provenanceVisible: shown(provenance),
    provenanceBox: provenance ? box(provenance) : null,
    floatingNoticeVisible: Boolean(floatingNotice) && shown(floatingNotice),
    chatVisible: shown(chat),
    controlsVisible: shown(controls),
    chatWithinViewport: within(chat),
    controlsWithinViewport: within(controls),
    chatTopOnScreen: chat ? chat.getBoundingClientRect().top >= -1 && chat.getBoundingClientRect().top < window.innerHeight : null,
    controlsTopOnScreen: controls ? controls.getBoundingClientRect().top >= -1 && controls.getBoundingClientRect().top < window.innerHeight : null,
    chatHeight: chat ? Math.round(chat.getBoundingClientRect().height) : 0,
    controlsHeight: controls ? Math.round(controls.getBoundingClientRect().height) : 0,
    /* A card is only really shown if it is inside its scrollport, not merely if
       it has a box. A clipped card reports a perfectly good rect. */
    cardsFullyInsideRoster: (() => {
      const scroller = document.querySelector('.agentv-roster')
      if (!scroller) return 0
      const s = scroller.getBoundingClientRect()
      return [...document.querySelectorAll('.ar-card')].filter(card => {
        const r = card.getBoundingClientRect()
        return r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.height > 40
      }).length
    })(),
    /* Any status line that is not inside a card. Counted from the document
       rather than from the cards, so a status that was moved somewhere else
       entirely is still SEEN -- a per-card walk can only ever report that its
       own card has none, which reads as innocent. */
    strayStatusLines: [...document.querySelectorAll('.ar-status-current')].filter(s => !s.closest('.ar-card')).length,
    cardHeight: (() => { const c = document.querySelector('.ar-card'); return c ? Math.round(c.getBoundingClientRect().height) : 0 })(),
    rosterHeadHeight: (() => { const h = document.querySelector('.ar-head-row'); return h ? Math.round(h.getBoundingClientRect().height) : 0 })(),
    /* WHICH CARD THE PAGE OPENED ON. This assertion lives HERE and deliberately
       not in tools/page2-qa.cjs, which drives the "Open full view" seam into this
       page. That harness's author offered to assert it and then argued it should
       not -- correctly: which card the drill-in selects is this page's decision,
       so a check on it in their file would plant a red in this territory the
       first time selection behaviour changes. Their seam asserts that the drill
       lands on a mounted roster; this one asserts what it landed ON. */
    selectedId: document.querySelector('.ar-card.is-selected')?.dataset?.agentId || null,
    selectedCount: document.querySelectorAll('.ar-card.is-selected').length,
    routeAgentId: (location.hash.match(/#\\/agent\\/[^/]+\\/([^/?]+)/) || [])[1] || null,
    firstCardId: document.querySelector('.ar-card')?.dataset?.agentId || null,
    rosterScrollable: (() => {
      const r = document.querySelector('.agentv-roster')
      return r ? r.scrollHeight > r.clientHeight + 1 : null
    })(),
    columnScroll: (() => {
      const col = document.querySelector('.agentv')
      return col ? { scrollHeight: col.scrollHeight, clientHeight: col.clientHeight } : null
    })(),
    columnScrollable: (() => {
      const col = document.querySelector('.agentv')
      return col ? col.scrollHeight > col.clientHeight : null
    })(),
    actionsWhole,
    sessionOutput: norm(document.querySelector('.agent-session-surface [data-action-output]')),
    sessionStatus: norm(document.querySelector('.agent-session-surface [data-session-status]')),
    startDisabled: (() => { const b = document.querySelector('[data-session-start]'); return b ? b.disabled : null })(),
    /* The column's real budget, reported whether or not anything failed. When a
       panel does not fit, "chat=false" says only that it did not -- these say
       WHAT ate the room, which is the difference between a fix and a guess. */
    columnHeights: (() => {
      const rows = {}
      for (const sel of ['.agentv', '.agentv-top', '.agentv-roster', '.agent-strip', '.agent-session-surface', '.agentv-panels-wrap']) {
        const node = document.querySelector(sel)
        rows[sel] = node ? Math.round(node.getBoundingClientRect().height) : null
      }
      rows.viewport = window.innerHeight
      const panels = document.querySelector('.agentv-panels-wrap')
      rows.panelsBottom = panels ? Math.round(panels.getBoundingClientRect().bottom) : null
      return rows
    })(),
    pageText: norm(view),
    overflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth + 1,
  }
})()`

/* RECORD A REAL PERMISSION LEVEL IN SCRATCH, before the window opens.
 *
 * Two reasons, and the second is the more important one.
 *
 * 1. A machine with no record is a FIRST RUN, and the router sends every route
 *    to `#/setup` until a level is recorded (shouldOpenSetup). Without this the
 *    harness never reaches the page it exists to check -- measured: it timed out
 *    waiting for the agent page while the app sat on the permission question.
 *
 * 2. It makes the TIER an input. The confinement copy is per-level, so a harness
 *    that could only ever see whatever this machine happens to be set to would
 *    check one third of the claim -- and would check the third that looks most
 *    like the old sentence, since this machine is recorded `unrestricted`. That
 *    is exactly how the false sentence survived: on an unrestricted install it
 *    reads true. Seeding the record lets each level be driven and read on real
 *    glass.
 *
 * Written with the ENGINE'S OWN writer, not by hand, so a record this harness
 * creates is one the product would accept -- and a schema change breaks the
 * harness rather than letting it seed something the app quietly ignores. */
function seedMachineRecord(profile, appRoot, tier) {
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(REPO_ROOT, 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
  return servicesRoot
}

async function drive(executable, scratch, tier) {
  const port = await freePort()
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }

  const profile = path.join(scratch, `profile-${tier}`)
  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  prepareSterileProfile(qaProfileDirectories(profile))
  seedMachineRecord(profile, path.join(scratch, 'app'), tier)

  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home -- including the Codex home, so the sign-in prerequisite is measured
     against a known EMPTY state rather than whoever is signed in on this
     machine, which is the FRESH-CUSTOMER case -- inside the scratch profile,
     and ELECTRON_RUN_AS_NODE deleted. */
  const environment = sterileLaunchEnvironment(qaProfileDirectories(profile))

  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`,
    /* windowsHide suppresses the CONSOLE window this spawn would otherwise
       flash on the owner's desktop. It has no effect on the BrowserWindow --
       that is what MC_SMOKE_HEADLESS=1 in the inherited environment does (see
       shell/window-options.cjs), which tools/packaged-qa-suite.mjs sets. */
  ], { env: environment, stdio: 'ignore', windowsHide: true })

  const session = createSession(port, child, {})
  const shots = []
  try {
    await session.open()
    await session.send('Runtime.enable')
    const evaluatorFor = activeSession => async expression => {
      let packet
      try {
        packet = await activeSession.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      } catch (error) {
        const operation = expression.replace(/\s+/g, ' ').trim().slice(0, 160)
        throw new Error(`Runtime.evaluate failed for ${operation}: ${error.message}`, { cause: error })
      }
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const evaluate = evaluatorFor(session)
    const until = async (label, expression, attempts = 60) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return
        await delay(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    /* Wait for the APP ORIGIN, not merely for a document. The first target the
       debugger offers can still be on about:blank, where localStorage throws a
       SecurityError -- which reads exactly like a broken renderer and is really
       just "too early". The shell serves dist/ over loopback HTTP, so an http
       origin with the router's stage in it is the real first paint. */
    await until('the application origin',
      `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
    /* The example drill-in, which is the state the owner screenshotted and the
       one where every card carries an activity line. mc.example is the one
       source switch now (src/data-source.js): absent, every screen reads this
       computer, and on a machine with no fleet host that renders an honest
       "unavailable" panel with no agents at all -- a real state, but not the
       one with the layout defects in it. */
    const setup = await evaluate(`(() => {
      localStorage.setItem('mc.example', 'on');
      localStorage.setItem('mc.theme', 'tan');
      /* The session surface's write flag is turned ON even though this is the
         example page: the no-live-session-control check below must hold
         because of the page's provenance (mountAgentSessionSurface's live
         fence), not because the capability happened to be switched off -- a
         run that left it off would pass without measuring anything. Same
         posture as tools/example-page-write-fence-qa.mjs. */
      localStorage.setItem('mc.write.agent-session', 'enabled');
      location.hash = '#/agent/c1/codex';
      return {
        hash: location.hash,
        example: localStorage.getItem('mc.example'),
        theme: localStorage.getItem('mc.theme'),
        write: localStorage.getItem('mc.write.agent-session'),
      };
    })()`)
    console.log(`    routed without document reload: ${JSON.stringify(setup)}`)
    /* Hash navigation remounts the route and the agent view resolves mc.example
       on mount. A full Page/location reload is deliberately forbidden here:
       three measured runs in agent-start-flow-qa left its CDP target open but
       permanently mute after reload, hiding a harness defect behind a timeout. */
    await delay(1200)
    /* Wait for the VIEW, not for a card.
       Waiting on `.ar-card` seemed obvious and was wrong: a plant that made the
       roster render empty -- the exact defect this suite exists to catch --
       timed the harness out here and aborted the run, so the suite died instead
       of reporting "the page rendered its agents" as a failure. A kill only
       counts if the failure NAMES the defect, and "timed out waiting for the
       agent page" names the instrument. Waiting on the view means an empty
       roster reaches the checks and fails the one written for it. */
    await until('the agent view', `Boolean(document.querySelector('.agentv'))`)
    await delay(600)

    for (const [width, height] of SIZES) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      })
      /* WAIT FOR THE LAYOUT TO STOP MOVING, rather than for a fixed delay.
         A flat `delay(700)` measured 3 passes in isolation and one failure on the
         third app launch of a back-to-back run -- roster 149px instead of 251px,
         read mid-relayout after the resize. That is an instrument reporting a
         coin toss, and a plant scored against it would have been credited to a
         defect that was not there. Polling until two consecutive reads agree
         makes the wait as long as the machine actually needs and no longer. */
      await settle(evaluate)
      const page = await evaluate(READ_PAGE)
      const at = `${width}x${height}`

      check(`${at}: the page rendered its agents`, page.present && page.cardCount >= 1,
        `present=${page.present} cards=${page.cardCount}`)

      /* THE PRIMARY COMPLAINT, measured as geometry. */
      check(`${at}: NO text overlaps any other text`, page.overlaps.length === 0,
        page.overlaps.length ? JSON.stringify(page.overlaps.slice(0, 4)) : '')

      /* EVERY CARD ON THE GLASS IS LEGIBLE, and enough of them are on the glass.
         Stated as two claims because they are two claims, and because the first
         version conflated them: it required all nine cards visible at once, which
         only passed while the visibility test was blind to clipping. The roster
         scrolls by design, so "all nine visible" was never the property worth
         holding -- the property is that nothing shown is unreadable (the owner's
         actual complaint) and that the list does not degenerate into a peephole. */
      const visibleCards = page.cards.filter(c => c.nameVisible && c.roleVisible)
      check(`${at}: every agent card on screen has a legible name and role`,
        visibleCards.length > 0 && visibleCards.every(c => c.name && c.role),
        JSON.stringify(visibleCards.filter(c => !(c.name && c.role)).map(c => c.id)))
      check(`${at}: enough agents are on screen to be a roster, and the rest scroll`,
        visibleCards.length >= 3
          && (visibleCards.length === page.cardCount || page.rosterScrollable === true),
        `visible=${visibleCards.length}/${page.cardCount} rosterScrollable=${page.rosterScrollable}`)

      /* THE SECOND COMPLAINT: a status block with no tie to its node. */
      /* `=== true`, not `!== false`, and a plant is why.
         The first version accepted `statusInsideCard !== false`, and
         `card.querySelector('.ar-status-current')` returns NULL when the status
         is not in the card at all -- so moving every status line out of its card
         and appending it to the page produced `null`, which `!== false` happily
         accepted. The mutation that reintroduces the exact defect this page was
         sent to fix passed the check written to catch it. Absence has to be a
         failure here, because absence IS the defect. */
      check(`${at}: every status line sits INSIDE its own agent's card`,
        page.cards.length > 0
          && page.cards.every(c => c.statusInsideCard === true && c.status.length > 0)
          && page.strayStatusLines === 0,
        `outside=${JSON.stringify(page.cards.filter(c => c.statusInsideCard !== true).map(c => c.id))} stray=${page.strayStatusLines}`)

      /* THE THIRD: is that a duration or a clock time? */
      const clockShaped = page.cards.filter(c => /^\d+:\d\d/.test(c.runtime)).map(c => c.runtime)
      check(`${at}: the runtime cannot be read as a time of day`, clockShaped.length === 0,
        JSON.stringify(clockShaped))
      check(`${at}: every runtime carries its units`,
        page.cards.every(c => /[dhms]/.test(c.runtime) || /no runtime/.test(c.runtime)),
        JSON.stringify(page.cards.map(c => c.runtime)))

      /* THE FIFTH: example data unmistakable, and not covering anything. */
      /* THE SELECTION CONTRACT. The page is reached by naming an agent, so it
         has to open on that agent and say which one -- exactly one card marked,
         it is the one in the route, and it leads the list so the reader does not
         have to hunt for their own agent among its peers. */
      check(`${at}: the page opens on the agent named in the route, and marks exactly one`,
        page.selectedCount === 1 && page.selectedId === page.routeAgentId,
        `selected=${page.selectedId} route=${page.routeAgentId} count=${page.selectedCount}`)
      check(`${at}: the selected agent leads the roster`,
        page.firstCardId === page.routeAgentId,
        `first=${page.firstCardId} route=${page.routeAgentId}`)

      check(`${at}: the page states its data is an example`,
        page.provenanceVisible && page.provenanceKind === 'example' && /example data/i.test(page.provenance),
        `${page.provenanceKind} ${JSON.stringify(page.provenance).slice(0, 90)}`)
      check(`${at}: the floating example-data toast is not also on this page`,
        page.floatingNoticeVisible === false,
        `floating notice visible=${page.floatingNoticeVisible}`)

      /* THE SIXTH: Chat and Controls cut off. */
      check(`${at}: Chat and Controls are both on the glass`,
        page.chatVisible && page.controlsVisible, `chat=${page.chatVisible} controls=${page.controlsVisible}`)
      /* NO REGION IS ALLOWED TO COLLAPSE TO NOTHING.
         This is here because the first attempt at the short-window rule let the
         roster shrink to 27px -- its header and zero cards -- and every other
         check on this page still passed, including the ones about names being
         legible: the card elements still had boxes, they were simply clipped by
         a container with no height. A page that silently drops one of its four
         regions is a worse failure than the overlap this lane was sent to fix,
         so it is measured directly rather than inferred. */
      check(`${at}: the roster shows a real row of cards, not a collapsed strip`,
        page.columnHeights['.agentv-roster'] >= 120 && page.cardsFullyInsideRoster >= 1,
        `roster=${page.columnHeights['.agentv-roster']}px cardsInside=${page.cardsFullyInsideRoster} cardHeight=${page.cardHeight} headRow=${page.rosterHeadHeight} ${JSON.stringify(page.columnHeights)}`)

      /* Fully on screen where the window can afford it. At 800px of height the
         column measures 780px of genuinely-wanted content against 698 available,
         so the page scrolls -- and the honest bar there is that both panels are
         REACHED and usable, not that they are entirely above the fold. Stating
         the two bars separately, with the arithmetic, beats quietly weakening one
         assertion until it passes everywhere. */
      if (height >= 1000) {
        check(`${at}: neither panel is cut off by the window`,
          page.chatWithinViewport && page.controlsWithinViewport,
          `chat=${page.chatWithinViewport} controls=${page.controlsWithinViewport} ${JSON.stringify(page.columnHeights)}`)
      } else {
        check(`${at}: both panels start on screen and are a usable size`,
          page.chatTopOnScreen && page.controlsTopOnScreen
            && page.chatHeight >= 200 && page.controlsHeight >= 200,
          `chatTop=${page.chatTopOnScreen}/${page.chatHeight} controlsTop=${page.controlsTopOnScreen}/${page.controlsHeight} ${JSON.stringify(page.columnHeights)}`)
        /* REACHABLE MEANS REACHABLE: either the whole column fits within the
           window, or `.agentv` (overflow-y:auto) scrolls to what is below the
           fold. This used to demand the column ALWAYS scroll, which held only
           while a session surface sat between the roster and the panels and made
           the column overflow at these heights. That surface is correctly gone
           from the demonstration page (dd01899 / tools/example-page-write-fence-qa.mjs),
           so the column now fits -- panelsBottom lands above the fold -- and
           requiring a scrollbar demanded a defect. Measured here: at 1280x800 the
           panels' bottom is 627px against an 800px window, fully on screen. */
        check(`${at}: the panels are reachable -- the column fits, or scrolls to them`,
          page.columnScrollable === true
            || (page.columnHeights.panelsBottom !== null
              && page.columnHeights.panelsBottom <= page.columnHeights.viewport + 1),
          `scrollable=${page.columnScrollable} panelsBottom=${page.columnHeights.panelsBottom} viewport=${page.columnHeights.viewport} ${JSON.stringify(page.columnScroll)}`)
      }
      check(`${at}: all four controls are whole, not straddling the panel edge`,
        page.actionsWhole.length === 4 && page.actionsWhole.every(a => a.inPanel && a.height >= 40),
        JSON.stringify(page.actionsWhole))

      check(`${at}: the page does not scroll sideways`, page.overflowsHorizontally === false)

      /* THE DEMONSTRATION PAGE CARRIES NO LIVE SESSION CONTROL.
       *
       * RECONCILED 2026-08-11. This block used to DEMAND a mounted
       * `.agent-session-surface` on this page and read the level name, the
       * confining-refusal copy, the tools sentence and a DISABLED Start with a
       * sign-in reason off it -- per recorded level. That is the exact control
       * dd01899 removed and tools/example-page-write-fence-qa.mjs (green) forbids
       * on the demonstration copy: this page's own banner says nothing on it is
       * real, and no control that reaches a real session belongs on it. The old
       * demand also disagreed with tools/first-run-contract-qa.mjs, which proves
       * the Start control on the LIVE agent page -- the page that IS real. Worse,
       * at `unrestricted` the old block did not require Start to be disabled, so
       * satisfying it would have put an ENABLED Start -- a real spawn -- on the
       * page that says nothing here runs, which is the precise defect the fence
       * exists to stop. Measured on this tree: `.agent-session-surface` is
       * correctly absent, so every one of those reads was the empty string.
       *
       * So the assertion is INVERTED to the safe invariant this surface must
       * hold, and the coverage it used to duplicate now lives where it is real:
       *   - the LIVE Start control, present and reason-bearing ... first-run-contract-qa.mjs
       *   - present+enabled on live, absent on the example ...... example-page-write-fence-qa.mjs (both halves)
       *   - the confinement copy's exact wording per level ...... tools/test/agent-confinement-read.test.mjs
       */
      check(`${at}: the retired confinement claim is nowhere on the page`,
        !/No permission tier limits a running session/i.test(page.pageText),
        page.pageText.slice(0, 120))
      check(`${at}: no live session control is mounted on the demonstration page`,
        page.startDisabled === null && page.sessionOutput === '' && page.sessionStatus === '',
        `startDisabled=${page.startDisabled} output=${JSON.stringify(page.sessionOutput).slice(0, 80)} status=${JSON.stringify(page.sessionStatus).slice(0, 80)}`)

      if (width === 1600) {
        console.log(`\n    runtimes: ${JSON.stringify(page.cards.map(c => `${c.name} ${c.runtime} ${c.runtimeNote}`))}\n`)
      }

      for (const theme of THEMES) {
        await evaluate(`(() => { localStorage.setItem('mc.theme', ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)} })()`)
        await delay(450)
        const themed = await evaluate(READ_PAGE)
        check(`${at} ${theme}: nothing overlaps in this theme`, themed.overlaps.length === 0,
          themed.overlaps.length ? JSON.stringify(themed.overlaps.slice(0, 3)) : '')
        if (SHOTS && tier === SHOT_TIER) {
          const shot = await session.send('Page.captureScreenshot', { format: 'png' })
          const file = path.join(SHOTS, `agent-${theme}-${width}x${height}.png`)
          writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
          shots.push(file)
        }
      }
      await evaluate(`(() => { localStorage.setItem('mc.theme', 'tan'); document.documentElement.dataset.theme = 'tan' })()`)
    }
  } finally {
    session.close()
    await delay(300)
    /* By PATH, under this run's own scratch copy. Never by process name: another
       lane's ToolsEnabled, or the owner's, must not be touched. */
    try {
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='ToolsEnabled.exe'" | Where-Object { $_.ExecutablePath -like '${path.join(scratch, 'app').replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', windowsHide: true })
    } catch { /* nothing of ours left to stop */ }
    try { child.kill() } catch { /* already gone */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (child.exitCode !== null) break
      await delay(250)
    }
  }

  if (shots.length) console.log(`\nscreenshots: ${shots.length} in ${SHOTS}`)
  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.error(`\n${failed.length} problem(s):`)
    for (const entry of failed) console.error(`  - ${entry.name}`)
  }
  return failed.length === 0
}

if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'mc-agent-subpage-qa-'))
let ok = true
try {
  const executable = await stage(scratch)
  /* Every level, because the copy is per-level and the level this machine
     happens to be set to is the one that most resembles the sentence being
     retired. Screenshots come from `guided`: it is the fail-closed default, so
     it is what a fresh install actually shows. */
  for (const tier of TIERS) {
    console.log(`\n=== recorded level: ${tier} ===`)
    ok = (await drive(executable, scratch, tier)) && ok
  }
} finally {
  if (!KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
console.log(ok ? '\nagent subpage: PASS' : '\nagent subpage: FAIL')
process.exit(ok ? 0 : 1)
