#!/usr/bin/env node

/* THE LAST CHECK BEFORE AN INSTALLER IS CUT: does a CLAUDE agent really run
 * when a person presses Start on the tree, and is anything else newly broken.
 *
 * THE ONE CLAIM THAT HAS NEVER BEEN PROVEN. Every artifact in this repository
 * about the Claude engine is evidence about a part -- a unit suite over a fake
 * transport, a tier table, a refusal's wording. What has never been shown is a
 * person pressing an empty slot, choosing Claude, typing a question and reading
 * the model's own answer on the glass. Two lanes reported that they had, and
 * both were reading back the string they had just typed.
 *
 * SO THE QUESTION IS ASKED IN A FORM THAT CANNOT BE SELF-ANSWERED. The agent is
 * asked "What is 17 multiplied by 23?" and the run asserts that "391" is ABSENT
 * from every character this file types and PRESENT in the reply the product
 * saved. assertAnswerNotInQuestion() refuses to measure anything otherwise, so
 * the false pass those two lanes produced cannot be produced here.
 *
 * WHAT IS SEEDED, AND WHY EACH SEED IS NOT A THUMB ON THE SCALE.
 *
 *   the machine record   seedMachineRecord(), the same one every packaged
 *                        driver in this directory uses. It is the permission
 *                        level a first run stops to ask for; without it the
 *                        board has no computer and the compose panel refuses
 *                        every start BY DESIGN, for Codex too. Two lanes read
 *                        that refusal as a Claude defect.
 *   the Codex sign-in    copied, never pointed at. shell/agent-host.cjs plans a
 *                        confined home for EVERY isolated level and links the
 *                        Codex credential into it, so a start of any tier
 *                        refuses without one. See the claude-only profile
 *                        below, which is this run's measurement of exactly that.
 *   the Claude sign-in   copied, never pointed at, and the file is never opened
 *                        by this process. The engine spawns the official binary
 *                        and sets no CLAUDE_CONFIG_DIR, so the child reads the
 *                        home it is given -- and this run gives it a scratch
 *                        one. Without the copy the child answers "Not logged
 *                        in", which is the harness talking, not the product.
 *                        Same mechanism, same flag-gating and same reasoning as
 *                        copyClaudeSignIn() in owner-walkthrough-drive.mjs.
 *   the npm global dir   junctioned into the scratch APPDATA, because
 *                        claude-cli-process.js resolves the native claude.exe
 *                        under %APPDATA%/npm and a redirected APPDATA empties
 *                        it. A real person's APPDATA has it; refusing to
 *                        reproduce that would measure a machine nobody has.
 *
 * IT SPENDS REAL MONEY on the person's own subscriptions, so it is a tool and
 * never a default test target. It USED to say the suite globs for
 * `-qa.(mjs|cjs)` and that this file deliberately does not match; that stopped
 * being a decision and became an accident on 2026-08-23, when the glob was
 * measured to be blind to all twenty-eight `-drive` harnesses rather than
 * holding this one back. The glob reads both suffixes now, and the same
 * decision is written down where it can be read and acted on:
 * tools/packaged-qa-suite.mjs registers this file `costly: true`, so it is
 * discovered, printed in --list with the reason, and never run without
 * --include-costly.
 *
 *   node tools/cut-check-drive.mjs
 *   node tools/cut-check-drive.mjs --visible --keep
 *
 * EXIT  0 everything measured passed · 1 a check failed · 2 the harness could
 *       not run · 3 nothing failed but something could not be exercised.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { scratchDirectory, seedMachineRecord, stage as stageRelease } from './test-account-harness.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { probeOnce, steadinessOf, steadinessSentence } from './machine-steadiness.mjs'

const VISIBLE = process.argv.includes('--visible')
const KEEP = process.argv.includes('--keep')
const STARTED_AT = Date.now()

const PLAYWRIGHT_ROOT = typeof process.env.MC_PLAYWRIGHT_ROOT === 'string'
  ? process.env.MC_PLAYWRIGHT_ROOT.trim()
  : ''
const require_ = PLAYWRIGHT_ROOT
  ? createRequire(path.join(PLAYWRIGHT_ROOT, 'package.json'))
  : null

class HarnessError extends Error {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------- the ledger -- */

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, state: pass === true ? 'pass' : 'fail', detail: String(detail) })
  console.log(`  ${pass === true ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  return pass === true
}
function pending(name, why) {
  checks.push({ name, state: 'pending', detail: String(why) })
  console.log(`  ....  ${name}  -- NOT EXERCISED: ${why}`)
}
function note(text) { console.log(`  --    ${text}`) }

function report() {
  const failed = checks.filter(entry => entry.state === 'fail')
  const notRun = checks.filter(entry => entry.state === 'pending')
  console.log(`\n${checks.length - failed.length - notRun.length}/${checks.length} checks passed in ${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`)
  for (const entry of failed) console.log(`  FAILED:        ${entry.name}  -- ${entry.detail}`)
  for (const entry of notRun) console.log(`  NOT EXERCISED: ${entry.name}  -- ${entry.detail}`)
  if (failed.length > 0) return 1
  if (notRun.length > 0) return 3
  return 0
}

/* ------------------------------------------------------- the environments -- */

const links = []

function baseEnvironment(profile) {
  /* The homes come from the one shared helper (tools/lib/sterile-launch.cjs):
     APPDATA, LOCALAPPDATA, USERPROFILE, CODEX_HOME and TEMP inside the scratch
     profile, HOME/HOMEDRIVE/HOMEPATH/CLAUDE_CONFIG_DIR gone, ELECTRON_RUN_AS_NODE
     deleted. What this harness adds is its own PATH and no engine variable. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  mkdirSync(path.join(profile, 'userdata'), { recursive: true })
  for (const key of Object.keys(environment)) {
    if (/^(path|mission_control_engine)$/i.test(key)) delete environment[key]
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemPath = [
    path.join(systemRoot, 'system32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ]
  /* THE NPM GLOBAL LAYOUT, WHICH IS NOT THE SAME QUESTION AS PATH. Both engine
     transports prefer the NATIVE binary under %APPDATA%/npm/node_modules over a
     bare command name, and a redirected APPDATA empties that directory. A
     junction rather than a copy: no administrator, read-only as far as this run
     is concerned, and removed in the finally block before the scratch tree is.
     APPDATA itself stays scratch, or shell/userdata-adoption.cjs would find the
     machine's own data and adopt it into this profile. */
  const realNpmGlobal = path.join(process.env.APPDATA || '', 'npm')
  const scratchNpmGlobal = path.join(environment.APPDATA, 'npm')
  if (existsSync(realNpmGlobal) && !existsSync(scratchNpmGlobal)) {
    try {
      symlinkSync(realNpmGlobal, scratchNpmGlobal, 'junction')
      links.push(scratchNpmGlobal)
    } catch (error) {
      throw new HarnessError(`could not link the npm global directory into the scratch profile (${error.message})`)
    }
  }
  /* And on PATH, because shell/provider-cli-presence.cjs answers "is claude
     installed" by stat-ing PATH with PATHEXT -- and agent-host.cjs's tier gate
     opens on that answer. Pointed THROUGH the junction so nothing in this run
     names the real directory. */
  environment.PATH = [...systemPath, scratchNpmGlobal].join(';')
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'
  return environment
}

/* The two sign-ins, copied rather than pointed at, so nothing this run does can
   write to the owner's real home. Neither file is opened by this process. */
function copySignIn(profile, { codex, claude }) {
  const realHome = process.env.USERPROFILE || ''
  const scratchHome = path.join(profile, 'home')
  const done = { codex: false, claude: false }
  if (codex) {
    const from = path.join(realHome, '.codex', 'auth.json')
    if (!existsSync(from)) throw new HarnessError(`no Codex sign-in at ${from}; run \`codex login\``)
    mkdirSync(path.join(scratchHome, '.codex'), { recursive: true })
    copyFileSync(from, path.join(scratchHome, '.codex', 'auth.json'))
    done.codex = true
  }
  if (claude) {
    const from = path.join(realHome, '.claude', '.credentials.json')
    if (!existsSync(from)) throw new HarnessError(`no Claude sign-in at ${from}; run \`claude\` and sign in`)
    mkdirSync(path.join(scratchHome, '.claude'), { recursive: true })
    copyFileSync(from, path.join(scratchHome, '.claude', '.credentials.json'))
    /* The onboarding record too, or the CLI treats this as a first run and
       stops to ask questions no harness can answer. */
    const settings = path.join(realHome, '.claude.json')
    if (existsSync(settings)) copyFileSync(settings, path.join(scratchHome, '.claude.json'))
    done.claude = true
  }
  return done
}

/* ------------------------------------------------------------- the window -- */

async function openApp(executable, profile, environment) {
  if (!require_) throw new HarnessError('MC_PLAYWRIGHT_ROOT must name the authorized Playwright test kit')
  const { _electron } = require_('playwright')
  const app = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${path.join(profile, 'userdata')}`],
    env: environment,
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  const thrown = []
  page.on('pageerror', error => { thrown.push(String(error?.message || error)) })
  return { app, page, thrown }
}

async function closeApp(open) {
  if (!open) return
  try { await open.app.close() } catch { /* already gone */ }
}

async function resizeTo(open, width, height) {
  await open.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return null
    if (window.isMaximized()) window.unmaximize()
    if (window.isFullScreen()) window.setFullScreen(false)
    window.setContentSize(size.width, size.height)
    return window.getContentSize()
  }, { width, height })
  await delay(900)
}

async function waitForView(open, budgetMs = 90_000) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    const ready = await open.page.evaluate(`(() => document.readyState === 'complete'
      && Boolean(document.getElementById('stage'))
      && document.getElementById('stage').childElementCount > 0)()`)
    if (ready === true) return true
    await delay(400)
  }
  return false
}

const routeOf = open => open.page.evaluate('document.body.dataset.route || ""')

/* ------------------------------------------- real presses, recorded ------- */

/* The bounding box says the control is laid out; elementFromPoint says a mouse
   would reach it. Only the second one is a fact about a person. */
const AT_POINT = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return { state: 'hidden' }
  }
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
    return { state: 'offscreen', box: { x: box.x, y: box.y, w: box.width, h: box.height }, x, y }
  }
  const hit = document.elementFromPoint(x, y)
  const describe = element => element
    ? element.tagName.toLowerCase()
      + (element.id ? '#' + element.id : '')
      + (element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\\s+/).join('.')
        : '')
    : 'nothing'
  const mine = Boolean(hit) && (hit === node || node.contains(hit))
  return { state: mine ? 'reachable' : 'covered', under: describe(hit), self: describe(node), x, y }
}`

const at = (open, selector) => open.page.evaluate(`(${AT_POINT})(${JSON.stringify(selector)})`)

/* WAITED FOR, NOT SAMPLED ONCE: the topbar's layout is not final for a second
   or so after the first view mounts, and a single sample there reports "the
   arrow could not be pressed" about a harness, not a product. */
async function reachable(open, selector, budgetMs = 6000) {
  const until = Date.now() + budgetMs
  let last = await at(open, selector)
  while (last?.state !== 'reachable' && Date.now() < until) {
    await delay(300)
    last = await at(open, selector)
  }
  return last
}

async function press(open, selector, { settleMs = 500, waitMs = 6000 } = {}) {
  const spot = await reachable(open, selector, waitMs)
  if (spot?.state !== 'reachable') return { pressed: false, spot }
  await open.page.mouse.move(spot.x, spot.y)
  await delay(60)
  await open.page.mouse.down()
  await delay(60)
  await open.page.mouse.up()
  await delay(settleMs)
  return { pressed: true, spot }
}

async function wheelOver(open, selector, deltaY, times = 1) {
  const spot = await at(open, selector)
  if (!spot || spot.state === 'absent' || spot.state === 'hidden' || spot.state === 'zero-size') return spot
  await open.page.mouse.move(spot.x, spot.y)
  for (let step = 0; step < times; step += 1) {
    await open.page.mouse.wheel(0, deltaY)
    await delay(140)
  }
  await delay(320)
  return spot
}

/* A native <select>, worked the way a keyboard user works one.
 *
 * THE ESCAPE IS THE WHOLE TRICK, and a lane lost a day to its absence: pressing
 * the select OPENS an operating-system popup, and while it is open the arrows
 * go to the popup rather than to the element. Dismiss it and they land. */
async function chooseByKeyboard(open, selector, wantedValue) {
  const pressed = await press(open, selector, { settleMs: 300 })
  if (!pressed.pressed) return { ok: false, why: `the menu could not be pressed: ${JSON.stringify(pressed.spot)}` }
  await open.page.keyboard.press('Escape')
  await delay(120)
  await open.page.keyboard.press('Home')
  const seen = []
  for (let step = 0; step < 24; step += 1) {
    const current = await open.page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
    seen.push(current)
    if (current === wantedValue) {
      const label = await open.page.evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        return node ? [...node.options].find(option => option.value === node.value)?.textContent.trim().slice(0, 60) : null
      })()`)
      return { ok: true, presses: step, label }
    }
    await open.page.keyboard.press('ArrowDown')
    await delay(90)
  }
  return { ok: false, why: `never reached ${wantedValue} in 24 presses; saw ${JSON.stringify([...new Set(seen)])}` }
}

const textOf = (open, selector) =>
  open.page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent || '').trim()`)

async function settledRoute(open, from = null, budgetMs = 9000) {
  const until = Date.now() + budgetMs
  let seen = await routeOf(open)
  while (Date.now() < until) {
    await delay(250)
    const now = await routeOf(open)
    if (now === seen && (from === null || now !== from)) return now
    seen = now
  }
  return seen
}

/* The route stamp is written inside document.startViewTransition, so it lags
   the press by most of a second; waiting on the CHANGE rather than a duration
   is what stops a second press sailing past the page being walked to. */
async function walkTo(open, wanted, limit = 12) {
  let here = await settledRoute(open)
  for (let step = 0; step < limit; step += 1) {
    if (here === wanted) return true
    const pressed = await press(open, '#nav-next', { settleMs: 250 })
    if (!pressed.pressed) {
      note(`the forward arrow could not be pressed from ${here}: ${JSON.stringify(pressed.spot)}`)
      return false
    }
    const next = await settledRoute(open, here)
    if (next === here) {
      note(`the forward arrow was pressed on ${here} and the page did not move`)
      return false
    }
    here = next
  }
  return here === wanted
}

/* ------------------------------------------------------------ the panel --- */

const ROLE = '[data-compose-field="role"]'
const TIER = '[data-compose-field="tier"]'
const MESSAGE = '[data-compose-field="message"]'
const SUBMIT = '[data-compose-action="start"]'
const BODY = '[data-compose-body="form"]'
const NEW_TREE = '.tree-new-tree'

/* The slot buttons are rebuilt on every layout pass, so the selector is
   resolved and the point taken in the SAME read and the press is a mouse at
   that point. Stamping an attribute first measured a node that was already gone. */
async function openComposePanel(open) {
  const header = await reachable(open, '.tree-chat-add', 15_000)
  if (header?.state !== 'reachable') return { opened: false, why: `the header + is unavailable: ${JSON.stringify(header)}` }
  await open.page.mouse.move(header.x, header.y)
  await open.page.mouse.down()
  await open.page.mouse.up()
  const spot = await reachable(open, NEW_TREE, 15_000)
  if (spot?.state !== 'reachable') {
    const why = await open.page.evaluate(`(() => {
      const root = document.querySelector('.computers')
      return {
        route: document.body.dataset.route,
        board: Boolean(root),
        slots: document.querySelectorAll('.tree-empty-node').length,
        nodes: document.querySelectorAll('.static-tree-node, .tree-node').length,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
      }
    })()`)
    return { opened: false, why: `${JSON.stringify(spot)}; page: ${JSON.stringify(why)}` }
  }
  await open.page.mouse.move(spot.x, spot.y)
  await delay(80)
  await open.page.mouse.down()
  await delay(80)
  await open.page.mouse.up()
  for (let step = 0; step < 20; step += 1) {
    await delay(300)
    if ((await open.page.evaluate('Boolean(document.querySelector(\'[data-agent-compose="open"]\'))')) === true) {
      return { opened: true, spot }
    }
  }
  return { opened: false, why: `the press landed on ${spot.under} and no panel appeared` }
}

/* WHAT THE PANEL IS REFUSING BEFORE ANYTHING IS PRESSED.
 *
 * THE TRAP THIS EXISTS TO CATCH, and it cost two lanes their conclusions.
 * agent-compose-panel.js's attemptSubmit() returns before ANY ipc when the
 * panel carries an unavailableReason, and paints it as a notice. A profile the
 * board considers example-only sets that reason for EVERY tier, Codex
 * included. Both lanes read the resulting silence as "the Claude press does not
 * reach the bridge". So the reason is read off the panel FIRST, and a run that
 * finds one stops rather than reporting a product defect it did not measure. */
async function panelState(open) {
  return open.page.evaluate(`(() => {
    const panel = document.querySelector('[data-agent-compose="open"]')
    const notice = document.querySelector('[data-compose-notice="panel"]')
    const submit = document.querySelector('[data-compose-action="start"]')
    const tier = document.querySelector('[data-compose-field="tier"]')
    return {
      open: Boolean(panel),
      notice: (notice?.textContent || '').trim().slice(0, 300),
      noticeShown: Boolean(notice) && getComputedStyle(notice).display !== 'none' && (notice.textContent || '').trim().length > 0,
      submitDisabled: submit ? submit.disabled === true : null,
      fieldsDisabled: tier ? tier.disabled === true : null,
      tiers: tier ? [...tier.options].map(option => option.value) : [],
      floatingNotice: (document.querySelector('[data-fleet-profile-notice]')?.textContent || '').trim().slice(0, 200),
    }
  })()`)
}

/* What the PRODUCT saved about this tree, read out of its own store.
   Nodes are a SIBLING of trees in the record, not a child of one -- reading
   them as tree.nodes returns an empty list about a tree with nodes on it. */
async function savedRecord(open) {
  return open.page.evaluate(`(() => {
    const out = { trees: [], nodes: [] }
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !key.startsWith('mc.fleet.trees.v1:')) continue
      let parsed
      try { parsed = JSON.parse(localStorage.getItem(key)) } catch { continue }
      for (const tree of (parsed && parsed.trees) || []) out.trees.push({ id: tree.id, name: tree.name })
      for (const node of (parsed && parsed.nodes) || []) {
        out.nodes.push({
          id: node.id,
          treeId: node.treeId,
          status: node.status,
          tier: node.tier || null,
          sessionId: node.sessionId || null,
          threadId: node.threadId || null,
          reply: String(node.reply || '').slice(0, 400),
          message: String(node.message || '').slice(0, 200),
        })
      }
    }
    return out
  })()`)
}

/* ------------------------------------------------ the question and answer -- */

/* A QUESTION WHOSE ANSWER CANNOT BE IN THE QUESTION, which is the whole
   instrument. Two lanes printed "A REAL CLAUDE AGENT ANSWERED" on runs where no
   session ever started, because each asked the agent to repeat a word it had
   itself typed into the box and then searched the page for that word. */
const ANSWER = '391'
const QUESTION = 'What is 17 multiplied by 23? Reply with only the number.'
const FILLER = 'A second tree, so this computer has more than one.'

function assertAnswerNotInQuestion() {
  for (const typed of [QUESTION, FILLER]) {
    if (typed.includes(ANSWER)) {
      throw new HarnessError(
        `the expected answer "${ANSWER}" appears in text this harness types (${JSON.stringify(typed)}),`
        + ' so a run where nothing started could pass on its own echo. Refusing to measure.',
      )
    }
  }
}

/** Fill the panel by hand and press Start. Every step names itself when it fails. */
async function composeAndStart(open, { tier, message }) {
  const opened = await openComposePanel(open)
  if (!opened.opened) return { ok: false, why: `no compose panel: ${opened.why}` }

  const state = await panelState(open)
  if (state.noticeShown) {
    return { ok: false, refusedBeforeIpc: true, why: `the panel is refusing before any press: ${JSON.stringify(state.notice)}`, state }
  }

  const roleId = await open.page.evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(ROLE)})
    return menu ? [...menu.options].map(option => option.value).filter(Boolean)[0] || null : null
  })()`)
  if (!roleId) return { ok: false, why: 'the role menu offers no role' }
  const role = await chooseByKeyboard(open, ROLE, roleId)
  if (!role.ok) return { ok: false, why: `role: ${role.why}` }

  const typed = await press(open, MESSAGE, { settleMs: 300 })
  if (!typed.pressed) return { ok: false, why: `the brief could not be pressed: ${JSON.stringify(typed.spot)}` }
  await open.page.keyboard.type(message, { delay: 10 })

  /* The tier menu sits below the brief in a scrolling column, so the wheel goes
     over the form the way a person's would before the menu can be pressed. */
  await wheelOver(open, BODY, 240, 4)
  const chosen = await chooseByKeyboard(open, TIER, tier)
  if (!chosen.ok) return { ok: false, why: `tier: ${chosen.why}` }

  const landed = await open.page.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(MESSAGE)})
    return { message: (box?.value || '').slice(0, 120), tier: document.querySelector(${JSON.stringify(TIER)})?.value }
  })()`)
  note(`role=${roleId} tier=${landed.tier} (${JSON.stringify(chosen.label)}) brief=${JSON.stringify(landed.message)}`)

  const submitted = await press(open, SUBMIT, { settleMs: 2500 })
  if (!submitted.pressed) return { ok: false, why: `Start could not be pressed: ${JSON.stringify(submitted.spot)}` }
  return { ok: true, roleId, tier: landed.tier }
}

/** Wait for the product's own record to hold a terminal node that is not an old one. */
async function waitForTerminal(open, before, budgetMs = 240_000) {
  const until = Date.now() + budgetMs
  const started = Date.now()
  let last = null
  while (Date.now() < until) {
    last = await savedRecord(open)
    const mine = last.nodes.find(node => !before.has(node.id))
    if (mine && TERMINAL_STATUSES.has(mine.status)) {
      return { record: last, mine, terminal: true, waitedMs: Date.now() - started, budgetMs }
    }
    await delay(2000)
  }
  return {
    record: last,
    mine: last?.nodes.find(node => !before.has(node.id)) || null,
    terminal: false,
    waitedMs: Date.now() - started,
    budgetMs,
  }
}

/* The two states the product itself calls over. Anything else is a node still
   in flight, whatever the budget ran out thinking. */
const TERMINAL_STATUSES = new Set(['finished', 'failed'])

/* A HUNG PROVIDER CLI IS NOT A FAILING PRODUCT, AND THIS IS WHERE THAT GOT
 * DECIDED WRONG.
 *
 * This drive is the last gate before an installer is cut, and it used to read
 * `status !== 'finished'` as one thing. It is two:
 *
 *   failed      the product ran the turn and the turn came back failed. That is
 *               a product answer and it is a FAILING CHECK.
 *   never ended the official provider binary was spawned and never answered
 *               inside the budget, so the node is still running when the clock
 *               runs out. NOTHING WAS MEASURED. Reporting that as a failed check
 *               blames the product for a CLI that hung -- and blocks a cut on a
 *               reading that was never taken, which is the R1228 shape exactly:
 *               a gate must not invent a verdict it did not measure.
 *
 * The two answers go to different places. `failed` is a check that failed.
 * "never ended" is NOT EXERCISED: it names itself, it is counted as unexercised
 * rather than as a pass, and it leaves this drive at exit 3 (nothing failed,
 * something could not be exercised) rather than exit 1 (a check failed).
 * Could not measure is not the same answer as measured and bad.
 *
 * Exported for tools/test/cut-check-drive-hung-provider.test.mjs, which pins the
 * three-way split without launching Electron or spending provider budget.
 */
/* THREE THINGS LOOK THE SAME FROM OUTSIDE A BUDGET THAT RAN OUT, and only one
 * of them is about the provider:
 *
 *   never admitted   the product's own resource admission queued the start --
 *                    "New starts pause at 97% CPU... This agent is queued" --
 *                    and on a loaded box it never leaves that queue. Nothing
 *                    was asked of any provider. Blaming the provider here is
 *                    blaming it for this computer being busy.
 *   provider silent  the start was admitted and the official binary never
 *                    answered.
 *   our own waiting  a harness that retries with a per-attempt timeout spends
 *                    the budget itself. There is no retry ladder here on
 *                    purpose: waitForTerminal takes ONE overall budget, polls
 *                    within it, holds nothing while it waits, and returns.
 *                    Lane A measured the other shape -- a synchronous retry
 *                    ladder multiplying a per-probe timeout into a 485-second
 *                    freeze where the old code failed in 5s.
 *
 * The machine reading is carried into the refusal, not looked up afterwards, so
 * the sentence a person reads already says whether the box was steady. */
const ADMISSION_STATUSES = new Set(['queued', 'pending', 'admitting', 'awaiting-resources'])

/* This computer's own steadiness, in the module that already owns that question
   (tools/machine-steadiness.mjs: identical fixed CPU work measured 356ms to
   5408ms in one run of twenty). Sampled cheaply and never allowed to become a
   verdict of its own -- it is a sentence attached to a refusal, so the reader
   can tell a hung provider from a box that was flat out. */
function machineReading({ probe = probeOnce, samples = 6 } = {}) {
  try {
    const readings = []
    for (let index = 0; index < samples; index += 1) readings.push(probe())
    return steadinessSentence(steadinessOf(readings))
  } catch { return null }
}

export function terminalVerdict({ mine, terminal, waitedMs = 0, budgetMs = 0, machine = null }) {
  if (!mine) return { verdict: 'no-node' }
  if (!terminal) {
    const waited = `the node is still ${mine.status} after ${(waitedMs / 1000).toFixed(0)}s `
      + `of a ${(budgetMs / 1000).toFixed(0)}s budget (one overall deadline; nothing was retried and nothing held)`
    const reading = machine ? ` This computer, measured while waiting: ${machine}` : ''
    if (ADMISSION_STATUSES.has(String(mine.status))) {
      return {
        verdict: 'could-not-measure',
        cause: 'never-admitted',
        why: `the start was never ADMITTED: ${waited}. That is this computer's own resource-admission queue, `
          + `not the provider and not the product, so nothing was measured here.${reading}`,
      }
    }
    return {
      verdict: 'could-not-measure',
      cause: 'provider-never-answered',
      why: `the agent was started and the provider CLI never answered: ${waited}. `
        + `A hung provider client is not a product failure and is not a pass; nothing was measured here.${reading}`,
    }
  }
  if (mine.status !== 'finished') {
    return { verdict: 'failed', why: `the node ended ${mine.status}, not finished.` }
  }
  return { verdict: 'finished' }
}

/** Whatever the screen is saying about the refusal, in the product's own words. */
async function refusalOnScreen(open) {
  return open.page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-refusal-code], [data-org-status], .org-status, [data-compose-notice], .rail-said, [data-tree-said]')]
    return nodes
      .map(node => ({ code: node.getAttribute('data-refusal-code'), text: (node.textContent || '').trim().slice(0, 300) }))
      .filter(entry => entry.text.length > 0)
      .slice(0, 6)
  })()`)
}

/* ================================ item 1 =================================== */

async function driveClaudeFromTheButton(open, label) {
  const reached = await walkTo(open, 'computers')
  if (!reached) {
    pending(`${label}: a Claude agent starts from the tree`, 'the fleet page was never reached by pressing the arrow')
    return { started: false }
  }
  await resizeTo(open, 1512, 945)

  const availability = await open.page.evaluate(`(async () => {
    try { return await globalThis.mcAgent.availability() } catch (error) { return { threw: String(error && error.message || error) } }
  })()`)
  note(`the app's own readiness probe answers: ${JSON.stringify(availability)}`)

  const startable = await open.page.evaluate(`(async () => {
    try { return await globalThis.mcAgent.startableTiers() } catch (error) { return { threw: String(error && error.message || error) } }
  })()`)
  note(`the shell says these tiers can start: ${JSON.stringify(startable)}`)

  const before = new Set((await savedRecord(open)).nodes.map(node => node.id))
  const started = await composeAndStart(open, { tier: 'claude-sonnet', message: QUESTION })
  if (!started.ok) {
    if (started.refusedBeforeIpc) {
      pending(`${label}: a Claude agent starts from the tree`,
        `HARNESS/PROFILE, not the product: ${started.why}. Nothing below would be a measurement of Claude.`)
    } else {
      check(`${label}: a Claude agent starts from the tree`, false, started.why)
    }
    return { started: false }
  }

  const waited = await waitForTerminal(open, before, 240_000)
  const { record, mine } = waited
  const said = await refusalOnScreen(open)
  if (!mine) {
    check(`${label}: a Claude agent starts from the tree`, false,
      `Start was pressed and the product recorded no node at all. Screen said: ${JSON.stringify(said)}`)
    return { started: false }
  }
  note(`the node the product saved: ${JSON.stringify({ ...mine, reply: mine.reply.slice(0, 120) })}`)
  note(`what the screen says: ${JSON.stringify(said)}`)

  const outcome = terminalVerdict({ ...waited, machine: machineReading() })
  if (outcome.verdict === 'could-not-measure') {
    pending(`${label}: a Claude agent starts from the tree`,
      `${outcome.why} The product's words: ${JSON.stringify(said)}`)
    return { started: true, node: mine, screen: said, measured: false }
  }
  if (outcome.verdict === 'failed') {
    check(`${label}: a Claude agent starts from the tree`, false,
      `${outcome.why} The product's words: ${JSON.stringify(said)}`)
    return { started: true, node: mine, screen: said }
  }
  check(`${label}: a Claude agent starts from the tree`, true,
    `session ${mine.sessionId ? 'yes' : 'NO'} thread ${mine.threadId ? 'yes' : 'NO'} tier ${mine.tier}`)
  check(`${label}: the Claude session carries a real session id`, Boolean(mine.sessionId), `sessionId=${mine.sessionId}`)

  /* THE ANSWER, AND THE PROOF IT IS NOT MY OWN TEXT. Present in the reply the
     product saved, and absent from every character this file typed. */
  const inReply = mine.reply.includes(ANSWER)
  const inTyped = QUESTION.includes(ANSWER) || FILLER.includes(ANSWER)
  check(`${label}: the Claude agent's own answer came back`, inReply && !inTyped,
    `reply=${JSON.stringify(mine.reply.slice(0, 160))}; "${ANSWER}" is ${inTyped ? 'ALSO IN' : 'absent from'} everything typed`)

  /* And on the glass, not only in storage: a record nobody can see is not a
     product that works. Read outside every form control and outside the chip
     that echoes the asked-line back. */
  const onGlass = await open.page.evaluate(`(() => {
    const inForm = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
    const isEcho = node => String(node.textContent || '').toLowerCase().includes('asked:')
      || node.closest('.cl-previous, .cl-chat, [data-tree-chip], .static-tree-chip-overlay') !== null
    return [...document.querySelectorAll('*')]
      .filter(node => node.children.length === 0
        && (node.textContent || '').includes(${JSON.stringify(ANSWER)})
        && !inForm(node) && !isEcho(node))
      .map(node => (node.className || '') + ':' + (node.textContent || '').trim().slice(0, 60))
      .slice(0, 4)
  })()`)
  check(`${label}: the answer is on the screen, outside anything typed`, onGlass.length > 0,
    `spoken in ${JSON.stringify(onGlass)}`)
  return { started: true, node: mine, screen: said }
}

/* ================================ item 3 =================================== */

/* THE OWNER'S ORIGINAL BUG: a profile with two or more trees killed the whole
   computers page. Measured on a RELAUNCH rather than a re-render, because the
   page died on mount while reading the saved record -- which is the moment a
   person who quit yesterday and opened the app today is living in. */
async function driveTwoTrees(open) {
  const reached = await walkTo(open, 'computers')
  if (!reached) {
    pending('the computers page survives a profile with two or more trees', 'the fleet page was never reached')
    return
  }
  await resizeTo(open, 1512, 945)
  const record = await savedRecord(open)
  note(`the saved profile holds ${record.trees.length} tree(s) and ${record.nodes.length} node(s)`)
  if (record.trees.length < 2) {
    pending('the computers page survives a profile with two or more trees',
      `this profile only has ${record.trees.length} tree(s), so the condition was never created`)
    return
  }

  const painted = await open.page.evaluate(`(() => {
    const root = document.querySelector('.computers')
    const text = document.body.innerText || ''
    return {
      board: Boolean(root),
      nodes: document.querySelectorAll('.node.static-tree-node').length,
      slots: document.querySelectorAll('.tree-empty-node').length,
      chips: document.querySelectorAll('[data-tree-chip], .static-tree-chip-overlay, .cl-chat').length,
      zoom: document.querySelectorAll('[data-zoom], .graph-zoom button, [data-graph-zoom]').length,
      switcher: document.querySelectorAll('.graph-tree-switch button').length,
      switcherLabels: [...document.querySelectorAll('.graph-tree-switch button')].map(node => (node.textContent || '').trim()),
      emptyPage: text.trim().length < 40,
      textLength: text.length,
    }
  })()`)
  note(`the page paints: ${JSON.stringify(painted)}`)

  check('the computers page survives a profile with two or more trees',
    painted.board && !painted.emptyPage && painted.nodes > 0,
    `board=${painted.board} nodes=${painted.nodes} slots=${painted.slots} emptyPage=${painted.emptyPage}`)
  check('and it still offers the slots and chips the page is made of',
    painted.slots > 0 && painted.chips > 0,
    `slots=${painted.slots} chips=${painted.chips} zoom controls=${painted.zoom}`)

  /* The switcher is "Every tree" plus one button per tree, so two trees is
     three buttons. Pressed with a mouse, and the ROOT the graph is showing has
     to actually change -- a switcher that renders and does nothing is the same
     defect wearing a nicer coat. */
  check('the tree switcher appears once there is more than one tree',
    painted.switcher >= record.trees.length + 1,
    `${painted.switcher} button(s): ${JSON.stringify(painted.switcherLabels)}`)
  if (painted.switcher >= 2) {
    const rootBefore = await open.page.evaluate('document.querySelector(".graph-tree-switch button.on")?.textContent?.trim() || ""')
    const pressed = await press(open, '.graph-tree-switch button:nth-child(2)', { settleMs: 1400 })
    const rootAfter = await open.page.evaluate('document.querySelector(".graph-tree-switch button.on")?.textContent?.trim() || ""')
    const visible = await open.page.evaluate('document.querySelectorAll(".node.static-tree-node").length')
    check('and pressing a tree in the switcher really switches to it',
      pressed.pressed && rootAfter !== rootBefore,
      `pressed=${pressed.pressed} "${rootBefore}" -> "${rootAfter}", ${visible} node(s) drawn`)
  } else {
    pending('and pressing a tree in the switcher really switches to it', 'the switcher was not on the page')
  }
}

/* ================================ item 4 =================================== */

/* Every route, read the way a person reads it: what is on the glass. */
const ROT = ['home', 'computers', 'metrics', 'research', 'comms', 'ledger', 'approvals', 'checkout', 'settings']
const UGLY = [
  { name: 'raw undefined', re: /\bundefined\b/ },
  { name: 'raw NaN', re: /\bNaN\b/ },
  { name: 'a stringified object', re: /\[object [A-Z]/ },
  { name: 'a raw file-not-found', re: /\bENOENT\b/ },
  { name: 'a stack trace', re: /\n\s+at [\w$.<>]+ \(/ },
]

async function driveEveryRoute(open) {
  const dirty = []
  const empty = []
  let here = await settledRoute(open)
  const visited = new Set()
  for (let step = 0; step < ROT.length * 2 && visited.size < ROT.length; step += 1) {
    const text = await open.page.evaluate('document.body.innerText || ""')
    const stage = await open.page.evaluate('document.getElementById("stage")?.childElementCount || 0')
    visited.add(here)
    for (const pattern of UGLY) {
      if (pattern.re.test(text)) {
        const near = text.match(new RegExp(`.{0,60}${pattern.re.source}.{0,60}`))
        dirty.push({ route: here, what: pattern.name, near: (near?.[0] || '').replace(/\s+/g, ' ') })
      }
    }
    if (stage === 0 || text.trim().length < 40) empty.push({ route: here, stage, length: text.trim().length })
    const pressed = await press(open, '#nav-next', { settleMs: 250 })
    if (!pressed.pressed) break
    const next = await settledRoute(open, here)
    if (next === here) break
    here = next
  }
  note(`visited: ${JSON.stringify([...visited])}`)
  check('every route on the ring paints something',
    empty.length === 0 && visited.size >= ROT.length,
    empty.length ? `blank: ${JSON.stringify(empty)}` : `${visited.size}/${ROT.length} routes`)
  check('no route shows raw undefined, NaN, [object, ENOENT or a stack trace',
    dirty.length === 0, dirty.length ? JSON.stringify(dirty.slice(0, 6)) : 'none of the five patterns on any route')
  return { dirty, empty, visited: [...visited] }
}

/* =================================== run =================================== */

async function main() {
  assertAnswerNotInQuestion()
  const scratch = scratchDirectory('cut-check')
  console.log(`scratch: ${scratch}`)
  let open = null
  try {
    const staged = await stageRelease(scratch)
    console.log(`app:     ${staged.executable}`)

    /* THE PAYLOAD THIS RUN IS ABOUT TO MEASURE, NAMED RATHER THAN ASSUMED. */
    const engineFile = path.join(staged.appRoot, 'resources', 'capability', 'src', 'lib', 'agent-engine', 'claude-cli-process.js')
    check('the staged payload carries the Claude engine', existsSync(engineFile), engineFile)
    if (!existsSync(engineFile)) throw new HarnessError('nothing below would be about a build that ships the Claude engine')

    /* ---------- profile A: the owner's own machine, both sign-ins ---------- */
    console.log('\nITEM 1  pressing Start on a Claude tier, with a real hand')
    const profileA = path.join(scratch, 'profile-a')
    mkdirSync(profileA, { recursive: true })
    const environmentA = baseEnvironment(profileA)
    const copied = copySignIn(profileA, { codex: true, claude: true })
    note(`sign-ins copied into the scratch home: ${JSON.stringify(copied)} (neither file is opened by this process)`)
    seedMachineRecord(profileA, staged.appRoot)

    open = await openApp(staged.executable, profileA, environmentA)
    if (!(await waitForView(open))) throw new HarnessError('the window never mounted a view, so there was nothing to measure')
    const claude = await driveClaudeFromTheButton(open, 'Claude')

    /* A SECOND TREE, so item 3 has its condition. Made with the cheapest start
       that still creates one: pressing a top-level slot begins a new tree
       whatever the start then does. */
    console.log('\n        making a second tree so the two-tree page can be measured')
    const beforeFiller = new Set((await savedRecord(open)).nodes.map(node => node.id))
    const filler = await composeAndStart(open, { tier: 'claude-fable', message: FILLER })
    if (filler.ok) await waitForTerminal(open, beforeFiller, 180_000)
    else note(`the second start did not go in: ${filler.why}`)
    if (open.thrown.length > 0) note(`page errors in this run: ${open.thrown.slice(0, 3).join(' /// ')}`)
    await closeApp(open)
    open = null

    /* ---------- the same profile, opened again ---------- */
    console.log('\nITEM 3  the page that was dead: the same profile, opened again')
    open = await openApp(staged.executable, profileA, environmentA)
    if (!(await waitForView(open))) throw new HarnessError('the second launch never mounted a view')
    await driveTwoTrees(open)

    console.log('\nITEM 4  every route, and what is on the glass')
    const swept = await driveEveryRoute(open)
    void swept
    check('nothing on any route threw into the page',
      open.thrown.length === 0, open.thrown.slice(0, 4).join(' /// ') || 'no pageerror')
    await closeApp(open)
    open = null

    /* ---------- profile B: Claude installed, no Codex sign-in ---------- */
    /* THE MACHINE THE OWNER ASKED ABOUT: "add Claude and Codex and Gemini CLI
       subscriptions". A person may well arrive with only one. Availability was
       repaired for exactly this case; whether the PRESS survives it is a
       different question and it has never been asked. */
    console.log('\nEXTRA   a machine with Claude signed in and no Codex sign-in at all')
    const profileB = path.join(scratch, 'profile-b')
    mkdirSync(profileB, { recursive: true })
    const environmentB = baseEnvironment(profileB)
    copySignIn(profileB, { codex: false, claude: true })
    seedMachineRecord(profileB, staged.appRoot)
    open = await openApp(staged.executable, profileB, environmentB)
    if (!(await waitForView(open))) throw new HarnessError('the claude-only launch never mounted a view')
    const claudeOnly = await driveClaudeFromTheButton(open, 'Claude-only machine')
    if (!claudeOnly.started || claudeOnly.node?.status !== 'finished') {
      note(`a Claude-only machine is refused. The product's exact words: ${JSON.stringify(claudeOnly.screen)}`)
    }
    await closeApp(open)
    open = null

    void claude
    return report()
  } catch (error) {
    if (error instanceof HarnessError) {
      console.error(`\nHARNESS: ${error.message}`)
      return 2
    }
    console.error(`\nHARNESS: ${error?.stack || error}`)
    return 2
  } finally {
    await closeApp(open)
    /* THE LINKS COME OUT FIRST, ALWAYS, and before the scratch tree is removed:
       on the far side of each one is the machine's real global npm install. */
    for (const link of links) {
      try { unlinkSync(link) } catch { try { rmdirSync(link) } catch { /* already gone */ } }
    }
    links.length = 0
    if (!KEEP) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds handles */ }
    } else {
      console.log(`kept: ${scratch}`)
    }
  }
}

/* The verdict split above is pinned by a suite that must not launch Electron or
   spend provider budget, so importing this file for that alone does not start a
   drive. Same guard shape as tools/order-variation-drive.mjs. */
if (process.env.CUT_CHECK_DRIVE_TEST !== '1') {
  main().then(code => { process.exitCode = code }, error => {
    console.error(error)
    process.exitCode = 2
  })
}
