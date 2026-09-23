#!/usr/bin/env node

// DOES THE ONBOARDING PAGE STILL DESCRIBE THIS PRODUCT?
//
// public/help/getting-started.html is the only document written for a stranger.
// A document is not a test, so the ordinary failure of one is not that it is
// wrong on the day it is written -- it is that the product moves and the page
// does not, and nobody notices because nobody re-reads a doc they already wrote.
// This suite re-follows the page's instructions inside the packaged build, on a
// profile that has never been set up, and fails when the page and the product
// disagree.
//
// THE ONE DESIGN DECISION THAT MAKES IT WORTH RUNNING. Every check below is a
// PAIR: a phrase that must literally be in the document, and a measurement in
// the running application. Both halves must hold.
//
//   * the app stops saying it   -> FAIL, the page is now lying to a stranger
//   * the page stops saying it  -> FAIL, this suite is guarding a claim that is
//                                  no longer made, which is the quiet way a
//                                  green suite comes to mean nothing
//
// Without the first half a doc test is a spell-checker. Without the SECOND half
// the suite silently degrades: someone rewrites a section, the phrase leaves the
// page, and the app-side assertion keeps passing while the sentence it existed
// to protect is gone. That failure mode has a name in this codebase --
// absence-read-as-consent -- and a missing doc phrase is exactly it.
//
// WHAT IT DELIBERATELY DOES NOT CHECK. The page's claims about downloading,
// SmartScreen, install locations and uninstalling are about Windows and about a
// file transfer, not about the running renderer. They were each measured by hand
// (see reports/lanes/team4-d10.md) and they are not re-measurable from inside a
// window, so this suite does not pretend to cover them. It says so in its own
// output rather than leaving the reader to infer the scope from a count.
//
// IT NEVER ASSIGNS location.hash, for the reason the sibling suite gives: a
// person cannot type a route, so a harness that types one is not measuring
// reachability. The self-audit at the bottom of this file enforces that against
// this file's own source.
//
// EXIT CODES, same contract as tools/stranger-onboarding-qa.mjs:
//   0  every check passed
//   1  a check FAILED -- the page and the product disagree
//   2  NO VERDICT: nothing was measured. About the harness, never the product.
//
// RUN IT:
//   node tools/onboarding-doc-qa.mjs
//   node tools/onboarding-doc-qa.mjs --dump      (print each screen's text)
//   node tools/onboarding-doc-qa.mjs --keep      (keep the scratch directory)
//   --release <dir>        default release/win-unpacked
//   --open-timeout-ms <n>  how long to wait for the window (default 120000)

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* The one address of the place that used to be the page called "What this copy
   needs". Read, never spelled: it is a Settings row now and this driver has to
   press what the product actually offers. */
import { GUIDE_HREF } from '../src/first-run-needs.js'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const DUMP = process.argv.includes('--dump')
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* THE DOCUMENT UNDER TEST. Read from public/ and not from dist/: public/ is the
   tracked source and dist/ is a build output, so checking dist would let an
   edit that never reached the shipped source pass. The served copy is checked
   SEPARATELY, over the application's own HTTP origin, which is the only
   assertion that can tell "written" from "shipped". */
const DOC_SOURCE = path.join(REPO_ROOT, 'public', 'help', 'getting-started.html')
const DOC_URL_PATH = '/help/getting-started.html'

class HarnessError extends Error {}

/* ONE NORMALISER FOR BOTH SIDES, and it is not a nicety.
 *
 * Every one of these substitutions was earned by a check that failed while both
 * halves were in fact saying the same thing:
 *
 *   curly quotes   the product writes "I\u2019m new to this" with U+2019 and a doc
 *                  author types an apostrophe;
 *   em dashes      "Nothing yet \u2014 let me look around first" is U+2014 in the
 *                  product and in the page, and comparing one against a
 *                  hand-typed "--" is a false red;
 *   CASE           innerText returns text AFTER CSS text-transform, so the
 *                  product's `Question 2 of 3` arrives from the DOM as
 *                  `QUESTION 2 OF 3`. A case-sensitive compare here reported a
 *                  missing label that was on the screen in front of it. This is
 *                  the one substitution that loses information, so it is the one
 *                  worth naming: this suite checks that the WORDS a page
 *                  promises are the words a screen shows, and deliberately does
 *                  not police their capitalisation, because a stylesheet owns
 *                  that and a document cannot see it.
 */
const normalise = value => String(value ?? '')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

/* Text as a reader sees it: entities resolved, markup gone, then normalised by
   exactly the function above, so the two sides of a check cannot drift apart
   through one of them growing a rule the other never got. The HTML comment at
   the head of the page is stripped first \u2014 it is written for whoever maintains
   the page and a stranger never sees it, so a phrase that appears only there
   must not satisfy a check. */
function documentText(html) {
  return normalise(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'))
}

/* A COPY of the shipped binary is run, never release/win-unpacked itself: the
 * GUI starts a supervised capability layer that writes bearer tokens and an
 * audit database next to the binary, so running the artifact in place mutates
 * the artifact.
 *
 * WHY THE PAYLOAD IS A DIRECTORY AND NOT A REPACKED ARCHIVE. The sibling suite
 * extracts resources/app.asar, swaps dist/ and shell/ for the working tree's,
 * and repacks -- which needs @electron/asar, and that package is ABSENT from
 * this worktree's node_modules today (so is node_modules/.bin, and so is
 * @rollup's native binding, which is why `npm run build` cannot run here
 * either; see reports/lanes/team4-d10.md). Electron loads resources/app.asar if
 * it is there and resources/app/ otherwise, so removing the archive FROM THE
 * COPY and writing the payload as a plain directory gets the same renderer in
 * front of the same shell with no packing step at all.
 *
 * WHAT THAT COSTS, stated rather than glossed: this measures the working tree's
 * renderer inside the shipped binary, which is what a pre-commit check wants,
 * but it is NOT a measurement of the archive electron-builder would produce.
 * The archive claim is checked separately and by a different means -- see the
 * `packs into the build` check in main(). */
function staged(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const app = path.join(scratch, 'app')
  const archive = path.join(app, 'resources', 'app.asar')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new HarnessError(`no packaged build at ${RELEASE}. Run \`npm run dist\`, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  const payload = path.join(app, 'resources', 'app')
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) {
      throw new HarnessError(`${directory}/ is missing; run \`npm run build\` first`)
    }
    cpSync(from, path.join(payload, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(payload, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(payload, 'package.json'))
  /* Only ever inside the copy. Removing this from the real release directory
     would destroy the artifact the rest of the pipeline is measuring. */
  rmSync(archive, { force: true })
  return { payload, app }
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad|uninstall)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new HarnessError(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

/* A PATH with nothing on it but Windows itself -- the state a stranger's
   machine is in before opening the assistant-program section. Built from a fixed list rather
   than filtered out of the real one, so an unfamiliar directory carrying a
   codex shim cannot silently turn "not installed" into "installed" and pass. */
function systemOnlyPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return [
    path.join(root, 'system32'),
    root,
    path.join(root, 'system32', 'Wbem'),
    path.join(root, 'system32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

async function openApp(executable, scratch) {
  const profile = path.join(scratch, 'profile')
  for (const leaf of ['userdata', 'local', 'home', 'appdata']) mkdirSync(path.join(profile, leaf), { recursive: true })

  const environment = { ...process.env }
  /* Set, the binary runs headless as Node, exits 0, and is indistinguishable
     from a crash. */
  delete environment.ELECTRON_RUN_AS_NODE
  /* The BrowserWindow is created with show:false (shell/window-options.cjs), so
     this never flashes a window onto whatever the owner is looking at. Set
     explicitly rather than inherited: a harness that depends on the parent
     shell's environment for that is one launch away from being a surprise. */
  environment.MC_SMOKE_HEADLESS = '1'
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.APPDATA = path.join(profile, 'appdata')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  environment.PATH = systemOnlyPath()
  environment.Path = environment.PATH

  const userData = path.join(profile, 'userdata')
  const child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { noise.push(chunk); while (noise.length > 300) noise.shift() })
  }
  child.on('error', error => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData, message => console.log(`  ..    ${message}`))
  const teardown = async () => {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    if (child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* nothing left */ }
    }
    await delay(400)
  }
  try {
    await session.open(OPEN_BUDGET_MS)
  } catch (error) {
    if (error instanceof HarnessError) {
      const said = noise.join('').trim()
      error.message += said ? `\n  the app said:\n${said.split('\n').map(l => `    | ${l}`).join('\n')}` : '\n  the app said nothing'
    }
    await teardown()
    throw error
  }

  const evaluate = async expression => {
    const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.result?.value
  }
  const until = async (what, expression, tries = 80) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await evaluate(expression)) return true
      await delay(250)
    }
    console.log(`  ..    gave up waiting for ${what}`)
    return false
  }
  /* A control counts only if it is a real box on the screen with a name a
     person could read. Returns a word, so a failure says which way it failed. */
  const clickText = async (selector, label) => evaluate(`(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase()
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    const named = nodes.filter(node => node.textContent.replace(/\\s+/g, ' ').trim().toLowerCase() === wanted)
    if (!named.length) {
      return nodes.length
        ? 'wrong-label:' + JSON.stringify(nodes.map(n => n.textContent.replace(/\\s+/g, ' ').trim()))
        : 'absent'
    }
    if (named[named.length - 1].disabled) return 'disabled'
    named[named.length - 1].click()
    return 'clicked'
  })()`)
  const clickVisible = async selector => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && !node.disabled
    })
    if (!nodes.length) return 'absent'
    nodes[nodes.length - 1].click()
    return 'clicked'
  })()`)
  const screen = async () => evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').trim()`)
  const stepText = async () => evaluate(`(document.querySelector('[data-setup-section]')?.innerText || '').replace(/\\s+/g, ' ').trim()`)

  return { evaluate, until, clickText, clickVisible, screen, stepText, teardown, debuggerPort: session.port }
}

function createSession(child, userDataDir, say) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open(budgetMs) {
      const started = Date.now()
      const file = path.join(userDataDir, 'DevToolsActivePort')
      let port = null
      while (Date.now() - started < budgetMs && port === null) {
        if (child.exitCode !== null) throw new HarnessError(`the app exited with code ${child.exitCode} before publishing a debugger port`)
        try {
          const candidate = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
          if (Number.isInteger(candidate) && candidate > 0) port = candidate
        } catch { /* not written yet */ }
        if (port === null) await delay(200)
      }
      if (port === null) throw new HarnessError(`the app never published a debugger port within ${Math.round(budgetMs / 1000)}s`)
      this.port = port
      say(`debugger on 127.0.0.1:${port} after ${Date.now() - started}ms`)
      let lastSeen = 'the debugger endpoint never answered'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered`)
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
          const page = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true })
              socket.addEventListener('error', reject, { once: true })
            })
            socket.addEventListener('message', event => {
              const packet = JSON.parse(event.data)
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            say(`attached after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length ? `${targets.length} target(s), none a debuggable page` : 'an EMPTY target list -- no window opened'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s -- ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

async function main() {
  auditSelf()
  if (!existsSync(DOC_SOURCE)) {
    throw new HarnessError(`the document under test is missing: ${DOC_SOURCE}`)
  }
  const doc = documentText(readFileSync(DOC_SOURCE, 'utf8'))

  const results = []
  /* Both halves, always. `says` is what the page claims; `ok` is what the
     product did. A claim that has left the page fails here rather than being
     quietly dropped -- see the note at the head of this file. */
  /* Every screen-vs-page comparison goes through here, so neither side can be
     compared raw by accident. `has(screenText, phrase)` and the doc half of
     check() are the same operation on the same normaliser. */
  const has = (haystack, needle) => normalise(haystack).includes(normalise(needle))

  const check = (what, says, ok, detail = '') => {
    const onPage = says === null || doc.includes(normalise(says))
    const passed = onPage && Boolean(ok)
    results.push({ what, ok: passed })
    const why = !onPage ? `THE PAGE NO LONGER SAYS ${JSON.stringify(says)}` : detail
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${what}${why ? `  -- ${why}` : ''}`)
    return passed
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'onboarding-doc-'))
  try {
    console.log(`document: ${DOC_SOURCE} (${doc.length} chars of reader-visible text)`)
    const stage = staged(scratch)
    const executable = appExecutable(stage.app)
    console.log(`staged a copy at ${executable}\n`)

    console.log('== the page is shipped where the product can serve it ==')
    /* THREE SEPARATE FACTS, because "shipped" is three claims and a single
       existsSync would be one of them wearing the others' clothes:
         1. the tracked source exists (public/), which is what a build reads;
         2. the built copy exists (dist/) and is byte-identical to it, which is
            what vite's publicDir copy is supposed to guarantee;
         3. dist/** is in the list electron-builder packs, so the built copy
            reaches an installer rather than only this machine.
       A page that satisfies 1 and 2 but not 3 is written and not shipped, and
       that is precisely the confusion this suite exists to refuse. */
    const built = path.join(REPO_ROOT, 'dist', 'help', 'getting-started.html')
    const sameBytes = existsSync(built)
      && readFileSync(built, 'utf8') === readFileSync(DOC_SOURCE, 'utf8')
    check('the built copy of the page matches the tracked source', null, sameBytes,
      existsSync(built) ? 'dist/help/getting-started.html' : 'NOT built -- vite copies public/ into dist/ on `npm run build`')
    const packs = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
      ?.build?.files?.includes('dist/**')
    check('dist/** is in what electron-builder packs into the build', null, packs === true,
      `package.json build.files ${packs === true ? 'includes' : 'DOES NOT include'} dist/**`)

    const app = await openApp(executable, scratch)
    const { evaluate, until, clickText, clickVisible, screen, stepText, teardown } = app
    try {
      /* WAIT FOR THE WINDOW TO BE THE APPLICATION BEFORE ASKING IT ANYTHING.
         The debugger attaches to the window's FIRST document, which is
         about:blank -- its origin is the string "null", so both a relative
         fetch and `new URL(path, location.origin)` throw. Twice that read as
         "the product does not serve the page" when the product had not been
         asked yet. A harness fault must never be reportable as a product fault,
         so the origin is established first and then quoted in the note. */
      const loaded = await until('the application origin', `location.protocol === 'http:'`)
      if (!loaded) throw new HarnessError('the window never left about:blank, so nothing could be asked of it')
      console.log(`  ..    the window is at ${await evaluate('location.origin')}`)
      const served = await evaluate(`(async () => {
        try {
          const reply = await fetch(new URL(${JSON.stringify(DOC_URL_PATH)}, location.origin).href)
          const body = await reply.text()
          return { status: reply.status, type: reply.headers.get('content-type'), bytes: body.length,
                   isPage: body.includes('Getting started'), isFallback: body.includes('<div id="app"') }
        } catch (error) { return { threw: String(error) } }
      })()`)
      console.log(`  ..    GET ${DOC_URL_PATH} -> ${JSON.stringify(served)}`)
      check('the running product serves the page at its own origin', null,
        served && served.status === 200 && /text\/html/.test(served.type || '') && served.isPage && !served.isFallback,
        JSON.stringify(served))

      /* CAN THE PRODUCT ACTUALLY LINK TO IT? A different question from "is it
       * served", and the one that decides whether the anchor handed over in
       * reports/lanes/team4-d10.md is an instruction or a guess.
       *
       * `target="_blank"` is what the proposed anchor uses, and the shell sets
       * no setWindowOpenHandler, so whether a second window appears at all is
       * Electron's default and not something this repository has decided. That
       * is worth measuring rather than assuming: if it were blocked, the
       * handover would be wrong in the one line that matters.
       *
       * OPENED OFF-SCREEN AND ONE PIXEL WIDE, then closed immediately. The main
       * window is hidden by MC_SMOKE_HEADLESS, but a child window is not
       * covered by that flag, and a suite that flashes a window onto whatever
       * the owner is looking at is a suite people stop running. */
      const linkable = await evaluate(`(() => {
        try {
          const opened = window.open(
            new URL(${JSON.stringify(DOC_URL_PATH)}, location.origin).href,
            '_blank',
            'width=1,height=1,left=-4000,top=-4000',
          )
          if (!opened) return { opened: false, why: 'window.open returned null' }
          setTimeout(() => { try { opened.close() } catch (error) { /* already gone */ } }, 1500)
          return { opened: true }
        } catch (error) { return { opened: false, why: String(error) } }
      })()`)
      await delay(900)
      const targets = await (async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${app.debuggerPort}/json/list`)).json()
          return list.filter(entry => entry.type === 'page').map(entry => entry.url)
        } catch (error) { return [`could not list targets: ${error?.message || error}`] }
      })()
      console.log(`  ..    page targets after the open: ${JSON.stringify(targets)}`)
      check('a link to the page opens it, leaving the application window intact', null,
        linkable?.opened === true && targets.some(url => url.endsWith(DOC_URL_PATH))
          && targets.some(url => !url.endsWith(DOC_URL_PATH)),
        JSON.stringify({ linkable, targets: targets.length }))
      await delay(900)

      console.log('\n== first launch: the four screens, in the order the page gives them ==')
      const onSetup = await until('the permission question', `location.hash === '#/setup'`)
      check('a brand-new profile opens on the permission question',
        'The first time it opens you are asked four things', onSetup)
      if (!onSetup) return 1

      let clicks = 0
      const q1 = normalise(await stepText())
      if (DUMP) console.log(`\n----- QUESTION 1 -----\n${q1}\n`)
      check('question 1 is the permission question, worded as the page quotes it',
        'How much should the assistant be allowed to do?',
        has(q1, 'How much should the assistant be allowed to do?'), q1.slice(0, 90))
      for (const label of ['I\u2019m new to this', 'I\u2019ve used AI coding tools before', 'I run agents with permissions bypassed']) {
        check(`the level "${label}" is offered by that name`, label,
          has(q1, label))
      }
      check('the limit of what a level binds is stated where the choice is made',
        'not to what it already did before you took it over',
        has(q1, 'does not reach') || has(q1, 'already did'), has(q1, 'Before you choose') ? 'the notice is present' : 'no notice found')
      /* The page tells a reader who does not want to decide to press Continue
         and take what is already selected. Both halves are checked: that the
         control is named Continue, and that pressing it moves on. */
      const c1 = await clickText('[data-setup-continue]', 'Continue')
      clicks += 1
      check('question 1 continues on the pre-selected answer, from a control named Continue',
        'press Continue and you get the most cautious of the three', c1 === 'clicked', String(c1))

      const atFolder = await until('the folder question', `(document.querySelector('[data-setup-section]')?.innerText || '').toLowerCase().includes('which folder')`)
      const q2 = normalise(await stepText())
      if (DUMP) console.log(`\n----- QUESTION 2 -----\n${q2}\n`)
      check('question 2 asks which folder, worded as the page quotes it',
        'Which folder should your assistant work in?',
        atFolder && has(q2, 'Which folder should your assistant work in?'), q2.slice(0, 90))
      check('question 2 is labelled as question 2 of 3', 'Question 2 of 3', has(q2, 'Question 2 of 3'))
      await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
      const c2 = await clickText('[data-setup-next]', 'Continue')
      clicks += 1
      check('question 2 accepts the folder it filled in, from a control named Continue',
        'A folder is already filled in for you', c2 === 'clicked', String(c2))

      const atAccount = await until('the sign-in step', `(document.querySelector('[data-setup-progress]')?.innerText || '').toLowerCase().includes('not a question')`)
      const q3 = normalise(await stepText())
      if (DUMP) console.log(`\n----- SIGN-IN STEP -----\n${q3}\n`)
      check('the sign-in step exists and is not counted as a question',
        'An optional step that asks who is using this copy', atAccount, q3.slice(0, 90))
      const c3 = await clickText('[data-setup-next]', 'Not now')
      clicks += 1
      check('the sign-in step can be passed with a control named Not now',
        'You can press Not now', c3 === 'clicked', String(c3))

      const atAutonomy = await until('the autonomy question', `(document.querySelector('[data-setup-section]')?.innerText || '').toLowerCase().includes('without asking')`)
      const q4 = normalise(await stepText())
      if (DUMP) console.log(`\n----- QUESTION 3 -----\n${q4}\n`)
      check('question 3 asks how much it may do without asking',
        'How much should it do without asking you?', atAutonomy, q4.slice(0, 90))
      check('question 3 is labelled as question 3 of 3', 'Question 3 of 3', has(q4, 'Question 3 of 3'))
      for (const label of ['Nothing yet \u2014 let me look around first', 'Act when I start it', 'Act on its own and tell me after']) {
        check(`the answer "${label}" is offered by that name`, label, has(q4, label))
      }
      /* The page sends a reader to this answer on the strength of the product
         marking it Recommended. If the product ever moves that mark, the page
         is recommending it on its own authority and must say so instead. */
      check('the recommended answer is the one the page tells a reader to take',
        'Marked Recommended', has(q4, 'Act when I start it — Recommended'),
        q4.match(/act when i start it[^.]{0,20}/)?.[0] || 'no Recommended note beside it')
      check('choosing to look around first says, there, that nothing will be startable',
        'there is no control anywhere that starts an assistant',
        has(q4, 'will be able to start an assistant') || has(q4, 'no Start control'), 'consequence line')
      /* The page assumes this answer for everything after it. */
      const chose = await evaluate(`(() => {
        const node = document.querySelector('[data-setup-set="autonomy"][data-setup-value="assisted"]')
        if (!node) return 'absent'
        node.click(); return 'clicked'
      })()`)
      check('the recommended answer can be chosen', null, chose === 'clicked', String(chose))
      const c4 = await clickText('[data-setup-next]', 'See what that sets')
      clicks += 1
      check('question 3 goes forward from a control named "See what that sets"',
        'See what that sets', c4 === 'clicked', String(c4))

      const atReview = await until('the review', `(document.querySelector('[data-setup-section]')?.innerText || '').toLowerCase().includes('what those answers set')`)
      await until('the readiness answer', `!(document.querySelector('[data-setup-section]')?.innerText || '').toLowerCase().includes('checking whether codex')`)
      const review = normalise(await stepText())
      if (DUMP) console.log(`\n----- REVIEW -----\n${review}\n`)
      check('the last screen shows what the answers set, worded as the page quotes it',
        'Here is what those answers set.', atReview && has(review, 'Here is what those answers set'), review.slice(0, 90))
      /* THE PREREQUISITE, SAID BEFORE SETUP ENDS. This profile has no assistant
         program on PATH. The review reports what it can prove; the provider-neutral
         install and sign-in actions are measured on the This computer section below. */
      check('setup reports assistant readiness before it finishes',
        'It also reports what it can prove about assistant readiness',
        has(review, 'codex') && (has(review, 'installed') || has(review, 'could not find')),
        `${review.length} chars of review copy`)
      const c5 = await clickText('[data-setup-next="finish"]', 'Finish setup')
      clicks += 1
      check('the review finishes from a control named Finish setup', 'Finish setup', c5 === 'clicked', String(c5))

      const intoApp = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 120)
      check('finishing setup lands in the product and stays there',
        'takes five clicks from the first question to a working first page', intoApp,
        `hash=${await evaluate('location.hash')}`)
      check('the click count the page promises is the click count it took',
        'five clicks', clicks === 5, `counted ${clicks}`)
      await delay(1500)

      console.log('\n== the account door and the in-app assistant setup path ==')
      const home = normalise(await screen())
      if (DUMP) console.log(`\n----- HOME -----\n${home}\n`)
      const accountDoor = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('a[href="#/settings?setting=connect_computer"]')].filter(node => {
          const box = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        })
        return { count: nodes.length, labels: nodes.map(node => node.textContent.replace(/\\s+/g, ' ').trim()) }
      })()`)
      check('the account row on Home opens the connect-computer screen',
        'The account row on Home opens Connect this computer in Settings',
        accountDoor?.count > 0 && accountDoor.labels.some(label => /account/i.test(label)),
        JSON.stringify(accountDoor))

      const gear = await clickVisible('#open-settings')
      check('the quick-settings gear can be pressed',
        'Open quick settings with the gear at the top of the window', gear === 'clicked', String(gear))
      await delay(350)
      const allSettings = await clickText('.drawer-all', 'all settings →')
      check('quick settings opens all settings by the name on the page',
        'Press all settings →', allSettings === 'clicked', String(allSettings))
      const atSettings = await until('the settings page', `document.body.dataset.route === 'settings'`)
      check('the settings route is reached by those controls', null, atSettings, `hash=${await evaluate('location.hash')}`)
      await delay(900)
      await evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
      await delay(350)
      const setupCategory = await clickVisible('.settings-rail button[data-category="Setup"]')
      check('the Setup category can be chosen', 'choose Setup', setupCategory === 'clicked', String(setupCategory))
      /* Local-model readiness is loaded asynchronously when Setup opens. Its
         four loopback probes run in parallel, but each has a real timeout; a
         fixed 500 ms delay raced that read and reported the door absent while
         the row was still honestly reading. Wait for the named, visible door
         itself, then keep the same physical/name check below. */
      const guideDoorReady = await until('the Open This computer control', `(() => {
        const node = [...document.querySelectorAll('a[href="${GUIDE_HREF}"]')]
          .find(entry => entry.textContent.replace(/\\s+/g, ' ').trim().toLowerCase() === 'open this computer')
        const box = node?.getBoundingClientRect()
        return Boolean(box && box.width > 0 && box.height > 0)
      })()`)
      const guideDoor = guideDoorReady
        ? await clickText(`a[href="${GUIDE_HREF}"]`, 'Open This computer')
        : 'absent'
      check('Setup offers This computer under the name in the page',
        'press Open This computer', guideDoor === 'clicked', String(guideDoor))
      /* THE ROW, NOT MERELY SETTINGS. This used to be a stop of its own, so the
         route name was the whole question; the answer is one section of a page
         with hundreds of rows now, and "settings is on screen" would pass while
         the reader was six screens above it. */
      const atGuide = await until('the This computer row', `document.body.dataset.route === 'settings' && location.hash.includes('setting=this_computer_programs')`, 60)
      check('the section opens at the row the door names', null, atGuide, `hash=${await evaluate('location.hash')}`)
      const controlsReady = await until('all three provider control pairs', `(() => {
        const shown = node => { const box = node?.getBoundingClientRect(); return Boolean(box && box.width > 0 && box.height > 0) }
        return ['codex', 'claude', 'gemini'].every(id => {
          const panel = document.querySelector('.guide-signin[data-signin-provider="' + id + '"]')
          return shown(panel?.querySelector('[data-signin-install]')) && shown(panel?.querySelector('[data-signin-start]'))
        })
      })()`, 80)
      const guide = normalise(await screen())
      check('the section has the heading and provider-neutral wording the page names',
        'Your assistant programs and local models',
        atGuide && has(guide, 'This computer') && has(guide, 'Your assistant programs and local models'),
        guide.slice(0, 180))
      check('Codex, Claude and Gemini each expose Install and Sign in controls',
        'Codex, Claude and Gemini each have their own Install and Sign in buttons',
        controlsReady && ['codex', 'claude', 'gemini'].every(id => has(guide, `Install ${id}`) && has(guide, `Sign in to ${id}`)),
        controlsReady ? 'all provider controls visible' : 'one or more provider controls absent')
      check('This computer says Gemini cannot start an agent in this copy',
        'Nothing in this copy starts Gemini yet',
        has(guide, 'Nothing in this copy starts Gemini yet'), 'guide text inspected')
      check('This computer limits a local model to Launch controls and Team panels, not tree Start',
        'it works in Launch controls and Team panels, and it does not start from a tree yet',
        has(guide, 'The Launch controls and Team panels') && has(guide, 'it does not start from a tree yet'),
        'guide text inspected')
      check('This computer uses controls rather than raw assistant setup commands',
        'there are no assistant install or sign-in commands in this section to copy',
        !/winget install OpenAI\.Codex|npm install -g @openai\/codex|codex login/i.test(guide),
        'guide text inspected')
      const backHome = await clickVisible('a[href="#/"]')
      check('This computer returns to the first page through a visible link', null, backHome === 'clicked', String(backHome))
      await until('home after This computer', `document.body.dataset.route === 'home'`)

      console.log('\n== opening it again ==')
      /* The page tells a reader that a second launch does not give them a
       * second copy. Measured rather than read off shell/single-instance.cjs:
       * the guard is `app.requestSingleInstanceLock()`, which is resolved by the
       * OS against the user-data directory, so whether it holds is a property of
       * how the binary was launched and not of the source. Started with the SAME
       * profile, the second process must go away on its own and the first must
       * still be there. */
      const second = spawn(executable, [`--user-data-dir=${path.join(scratch, 'profile', 'userdata')}`], {
        env: { ...process.env, MC_SMOKE_HEADLESS: '1' }, stdio: 'ignore', windowsHide: true,
      })
      const quit = await (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (second.exitCode !== null) return true
          await delay(250)
        }
        try { second.kill() } catch { /* already gone */ }
        return false
      })()
      const firstAlive = await evaluate('typeof document !== "undefined"')
      check('a second launch does not open a second copy',
        'starting it a second time brings the window you already have to the front',
        quit && firstAlive === true, `second process exit=${second.exitCode}, first window still answering=${firstAlive}`)

      console.log('\n== the click path to an assistant ==')
      const forward = await evaluate(`(() => {
        const node = document.getElementById('nav-next')
        if (!node) return 'absent'
        const box = node.getBoundingClientRect()
        if (!(box.width > 0 && box.height > 0)) return 'not-visible'
        node.click(); return 'clicked'
      })()`)
      check('the forward arrow at the top right exists and can be pressed',
        'press the > arrow at the top right', forward === 'clicked', String(forward))
      const onComputers = await until('the computers page', `document.body.dataset.route === 'computers'`)
      check('the forward arrow lands on the computers page',
        'You land on the computers page', onComputers)
      await delay(1600)
      /* `Open agent detail` is hidden until the graph has a selection, which is
         exactly what the page tells a reader to do first. So the check is that
         it EXISTS with that name -- shown or not -- and the page says to click
         an agent before pressing it. */
      const opener = await evaluate(`(() => {
        const node = document.querySelector('.computers .graph-open-btn')
        if (!node) return { present: false }
        const box = node.getBoundingClientRect()
        return { present: true, label: node.textContent.replace(/\\s+/g, ' ').trim(), visible: box.width > 0 && box.height > 0 }
      })()`)
      check('the control the page names to open an agent exists, by that name',
        'Open agent detail', opener && opener.present && opener.label === 'Open agent detail', JSON.stringify(opener))
      /* ALL THE WAY TO THE CONTROL THE PAGE SENDS A READER TO. Stopping at the
       * computers page would leave the last and most consequential instruction
       * on the page unverified -- and it is the one a stranger is following when
       * they have already spent an afternoon on this. What is checked is that
       * the panel, the prompt box and the named button are THERE; whether a
       * press then succeeds depends on Codex, which this profile deliberately
       * does not have, and tools/stranger-onboarding-qa.mjs owns that half. */
      const openIt = await clickText('.computers .graph-open-btn', 'Open agent detail')
      check('the agent page opens from that control', null, openIt === 'clicked', String(openIt))
      const arrived = await until('the agent page', `Boolean(document.querySelector('.agentv'))`)
      check('pressing it reaches an agent page', 'press Open agent detail', arrived)
      await delay(1200)
      const panel = await evaluate(`(() => {
        const form = document.querySelector('[data-session-form]')
        if (!form) return { form: false }
        const start = form.querySelector('[data-session-start]')
        return {
          form: true,
          title: (form.querySelector('.write-form-title')?.textContent || '').trim(),
          prompt: Boolean(form.querySelector('textarea[name="text"]')),
          start: start ? (start.textContent || '').trim() : null,
        }
      })()`)
      check('the panel the page names is on the agent page, with the box and the button it names',
        'Start an agent', panel?.form === true && panel.title === 'Start an agent'
          && panel.prompt === true && panel.start === 'Start', JSON.stringify(panel))

      const backOut = await evaluate(`(() => {
        const node = document.getElementById('nav-back')
        if (!node) return 'absent'
        node.click(); return 'clicked'
      })()`)
      check('the back arrow at the top left exists and can be pressed',
        'arrow at the top left takes you back out', backOut === 'clicked', String(backOut))
    } finally {
      await teardown()
    }
  } finally {
    if (KEEP) console.log(`\nkept the scratch directory at ${scratch}`)
    else {
      /* Cleanup cannot fail the run: Windows holds DLLs in the staged copy for
         a while after the process goes, and a throw out of a finally would
         report a red run that measured a green product. */
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) }
      catch (error) { console.log(`\ncould not remove ${scratch} (${error.code || error.message})`) }
    }
  }

  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log('NOT COVERED HERE (measured by hand, see reports/lanes/team4-d10.md):')
  console.log('  the download, the SmartScreen prompt, the install locations, the uninstall entry,')
  console.log('  none of which is observable from inside the window.')
  if (failed.length) {
    console.error(`FAILED: ${failed.map(result => result.what).join('; ')}`)
    return 1
  }
  return 0
}

/* The instrument audits itself: a suite that reaches a screen by assigning the
   hash is not measuring whether a person can reach it, and it goes green while
   the door is missing. Assignment is navigation; comparison is observation. */
function auditSelf() {
  const source = readFileSync(SELF, 'utf8')
  const offences = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(\+?=)(?!=)/.test(line))
    .filter(({ line }) => !line.includes('SELF-AUDIT-PATTERN'))
  if (offences.length === 0) return
  console.error('\nNO VERDICT: this suite navigates by assigning location.hash, which is the one')
  console.error('thing a customer cannot do. Every reachability claim it makes would be worthless.')
  for (const { line, number } of offences) console.error(`  ${number}: ${line.trim()}`)
  process.exit(2)
}

main().then(
  code => { process.exitCode = code },
  error => {
    if (error instanceof HarnessError) {
      console.error('\nNO VERDICT -- nothing about the product was measured.')
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error('\nNO VERDICT -- the harness failed before it could measure anything.')
    console.error(error?.stack || String(error))
    process.exitCode = 2
  },
)
