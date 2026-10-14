#!/usr/bin/env node

// THE GUIDED-PERMISSIONS DIRECTIVE, WALKED ON THE REAL PACKAGED WINDOW.
//
// Owner, R1529, in his own words: settings must genuinely RESTRICT, and a person
// must be GUIDED through changing one -- told what each step does, told the
// capabilities against the risks, told explicitly that the step is not required,
// and never pushed. And where the step is outside this product (his example: an
// operation that would need UAC elevation) we WALK THEM THROUGH IT and DO NOT DO
// IT FOR THEM; the in-product setting still turns on, and we say honestly that
// it might not work fully.
//
// tools/test/permission-guidance.test.mjs proves the mechanism. This proves the
// PRODUCT: that on a real window, from a fresh machine, the words are actually
// on the glass where a person meets the absence.
//
// WHAT IT ASSERTS, AND WHY EACH ONE IS THE THING RATHER THAN A PROXY.
//
//   1. Taking both Recommended answers now EXPLAINS what it withheld. The
//      product's own recommendation used to end at a list of names and one line
//      about shipped defaults. Every withheld switch is now read off the glass
//      and checked for all three answers: what is off, what turning it on would
//      give, what it would risk -- plus where the switch is and that it is
//      optional.
//   2. A setting whose full function needs something outside this product SAVES
//      AND ENABLES ANYWAY. The toggle is pressed, the stored value is read back
//      as enabled, and the walkthrough and the honest partial-function sentence
//      are both read off the same screen. A product that refused to save until
//      the outside step was done would be the failure the directive names.
//   3. NOTHING WAS PERFORMED ON THE OPERATING SYSTEM. The Windows UAC policy
//      values and the firewall profile state are read BEFORE the app starts and
//      again after the whole walk, and compared. This run never disables UAC and
//      never changes any machine security setting -- it reads them, precisely to
//      prove that the product did not change them either.
//   4. Both surfaces carry it: the settings page and the quick-settings drawer.
//
// ISOLATION is inherited from tools/setup-deadend-recommended-qa.mjs, which
// documents each variable in full: --user-data-dir, LOCALAPPDATA and USERPROFILE
// are redirected into scratch so the real machine record is never touched, and
// ELECTRON_RUN_AS_NODE is stripped because, set, the binary exits 0 headless and
// a crash and a pass look identical.
//
// RUN IT:
//   node tools/guided-permissions-qa.mjs
//   node tools/guided-permissions-qa.mjs --release <dir> --shots <dir>

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1]
}
const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const SHOTS = argument('--shots', null)
const KEEP = process.argv.includes('--keep')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

/* ---------- the machine's own security posture, READ ONLY ----------
 *
 * This is the assertion that the product did not do what the directive forbids.
 * It is a READ. Nothing in this file writes a registry value, creates a firewall
 * rule, or elevates; that is the whole point of measuring it. A failure to read
 * is reported as UNKNOWN and is not silently treated as unchanged. */
function readMachineSecurityPosture() {
  const posture = { uac: null, firewall: null }
  try {
    posture.uac = execFileSync('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
      '/v', 'EnableLUA',
    ], { encoding: 'utf8', windowsHide: true }).replace(/\s+/g, ' ').trim()
  } catch { posture.uac = null }
  try {
    posture.firewall = execFileSync('netsh', ['advfirewall', 'show', 'allprofiles', 'state'], {
      encoding: 'utf8', windowsHide: true,
    }).replace(/\s+/g, ' ').trim()
  } catch { posture.firewall = null }
  return posture
}

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
  await asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npx vite build\` first`)
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
  return path.join(app, 'ToolsEnabled.exe')
}

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function createSession(port, child, startupLog) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered.\n${startupLog.join('')}`)
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`)
          const page = (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true })
              socket.addEventListener('error', reject, { once: true })
            })
            socket.addEventListener('message', event => {
              const packet = JSON.parse(event.data)
              const handler = pending.get(packet.id)
              if (handler) {
                pending.delete(packet.id)
                if (packet.error) {
                  handler.reject(new Error(`debugger command failed (${packet.error.code}): ${packet.error.message}`))
                } else {
                  handler.resolve(packet)
                }
              }
            })
            return
          }
        } catch { /* not listening yet */ }
        await delay(500)
      }
      throw new Error('no debuggable page appeared within 30s')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* WHAT IS ACTUALLY ON THE GLASS in one withheld block. Read as text, because a
   promise a person cannot see is not a promise this product made. */
const READ_WITHHELD = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const blocks = [...document.querySelectorAll('[data-guided-withheld]')]
  return {
    count: blocks.length,
    heading: text([...document.querySelectorAll('.setup-subtitle')].find(node => /Left off/.test(node.textContent))),
    blocks: blocks.map(node => ({
      id: node.dataset.guidedWithheld,
      declared: node.dataset.guidedDeclared,
      shown: shown(node),
      labels: [...node.querySelectorAll('.guided-label')].map(label => text(label)),
      body: text(node),
    })),
  }
})()`

const READ_GUIDED_STEP = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const row = document.querySelector('[data-setting-id="write_cloud-launch"]')
  const note = row ? row.querySelector('[data-guided-for]') : null
  const step = note ? note.querySelector('[data-guided-step]') : null
  return {
    rowPresent: Boolean(row),
    declared: note ? note.dataset.guidedDeclared : null,
    open: note ? note.open : null,
    stepPresent: Boolean(step),
    capabilityId: step ? step.dataset.guidedStep : null,
    state: step ? step.dataset.guidedState : null,
    stepText: text(step),
    noteText: text(note),
    toggle: row ? Boolean(row.querySelector('.settings-toggle input')) : false,
    stored: localStorage.getItem('mc.write.cloud-launch'),
  }
})()`

async function main() {
  const before = readMachineSecurityPosture()
  const scratch = mkdtempSync(path.join(tmpdir(), 'guided-permissions-qa-'))
  console.log(`scratch: ${scratch}`)
  console.log(`machine security posture read before launch: uac=${before.uac === null ? 'UNKNOWN' : 'read'} firewall=${before.firewall === null ? 'UNKNOWN' : 'read'}`)
  try {
    const executable = await stage(scratch)
    console.log(`staged:  ${executable}\n`)

    const port = await freePort()
    const profile = path.join(scratch, 'profile-fresh')
    mkdirSync(path.join(profile, 'userdata'), { recursive: true })

    /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
       home inside the scratch profile, ELECTRON_RUN_AS_NODE deleted. */
    const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))

    const startupLog = []
    const child = spawn(executable, [
      `--user-data-dir=${path.join(profile, 'userdata')}`,
      `--remote-debugging-port=${port}`,
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', chunk => startupLog.push(String(chunk)))
    child.stderr.on('data', chunk => startupLog.push(String(chunk)))

    const session = createSession(port, child, startupLog)
    try {
      await session.open()
      await session.send('Runtime.enable')
      await session.send('Page.enable')

      const evaluate = async expression => {
        const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (packet.result?.exceptionDetails) {
          throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
        }
        return packet.result?.result?.value
      }
      const shot = async name => {
        if (!SHOTS) return
        const packet = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        if (!packet.result?.data) throw new Error(`the debugger returned no image data for screenshot ${name}`)
        mkdirSync(SHOTS, { recursive: true })
        const file = path.join(SHOTS, `${name}.png`)
        writeFileSync(file, Buffer.from(packet.result.data, 'base64'))
        console.log(`  shot  ${file}`)
      }
      const scrollTo = async selector => {
        await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (n) n.scrollIntoView({ block: 'start' }); return true })()`)
        await delay(500)
      }
      /* The same selectors tools/setup-deadend-recommended-qa.mjs presses, and
         for its stated reason: these are the FORWARD buttons and nothing else,
         so what this walks is exactly what the product recommends to somebody
         who takes its advice. Not one answer is chosen. */
      const click = async (selector, what) => {
        const pressed = await evaluate(
          `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (!nodes.length) return false; nodes[nodes.length - 1].click(); return true })()`,
        )
        if (!pressed) throw new Error(`nothing to click for ${what} (${selector})`)
        console.log(`  click: ${what}`)
        await delay(1400)
        return pressed
      }
      const until = async (what, expression, budgetMs = 20000) => {
        const deadline = Date.now() + budgetMs
        while (Date.now() < deadline) {
          if (await evaluate(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)) return true
          await delay(400)
        }
        throw new Error(`timed out waiting for ${what}`)
      }

      await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
      await until('the first-run question', 'location.hash === "#/setup"')

      /* ---- 1. THE RECOMMENDED PATH, EXPLAINED ---- */
      console.log('[the recommended path]')
      await click('[data-setup-continue]', 'Continue on the permission question')
      await click('[data-setup-next]', 'Continue on the folder question')
      await click('[data-setup-next]', 'Continue past the account step')
      await click('[data-setup-next="review"]', 'See what that sets')
      await delay(1500)

      const withheld = await evaluate(READ_WITHHELD)
      check('the review explains every switch the recommended answers left off', withheld.count > 0,
        `${withheld.count} withheld switch(es) explained`)
      check('the block says what was left off, in a heading a person can find', /Left off/.test(withheld.heading || ''),
        withheld.heading || '(no heading)')
      const everyBlockAnswersAllThree = withheld.blocks.every(block =>
        block.declared === 'true' &&
        block.labels.some(label => /WHAT TURNING IT ON WOULD LET YOU DO/i.test(label)) &&
        block.labels.some(label => /WHAT IT WOULD RISK/i.test(label)) &&
        /Where to turn it on/i.test(block.body) &&
        /Turning it on is optional/i.test(block.body))
      check('every withheld switch answers all three questions, and says it is optional', everyBlockAnswersAllThree,
        withheld.blocks.map(block => block.id).join(', '))
      check('every withheld block is actually visible on the glass', withheld.blocks.every(block => block.shown))
      const namesTheReason = withheld.blocks.every(block => /It is off because/.test(block.body))
      check('each one says WHY it is off, per switch rather than per section', namesTheReason)
      await scrollTo('[data-guided-withheld]')
      await shot('A1-recommended-path-withheld-explained')
      await evaluate(`window.scrollBy(0, 700)`)
      await delay(400)
      await shot('A2-recommended-path-withheld-explained-more')

      /* ---- 2. FINISH, THEN A SETTING WITH AN OUTSIDE STEP ---- */
      console.log('\n[a setting whose full function needs something outside this product]')
      await click('[data-setup-next="finish"]', 'Finish setup')
      await delay(3000)
      await evaluate(`location.hash = '#/settings'`)
      await delay(2500)
      // The Write section is behind the page's own progressive disclosure; search
      // reaches it the way a person would.
      await evaluate(`(() => {
        const input = document.querySelector('.settings-search input')
        input.value = 'Codex Cloud'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await delay(1200)

      const beforeToggle = await evaluate(READ_GUIDED_STEP)
      check('the Codex Cloud switch is reachable and carries a statement', beforeToggle.rowPresent && beforeToggle.declared === 'true')
      check('it ships switched off, which this run does not change first', beforeToggle.stored !== 'enabled',
        `stored=${beforeToggle.stored === null ? 'absent' : beforeToggle.stored}`)

      // Open the disclosure the way a person would, then read what it says.
      await evaluate(`(() => {
        const note = document.querySelector('[data-setting-id="write_cloud-launch"] [data-guided-for]')
        note.open = true
        return true
      })()`)
      await delay(600)
      const opened = await evaluate(READ_GUIDED_STEP)
      check('the walkthrough for the outside step is shown', opened.stepPresent, `capability=${opened.capabilityId} state=${opened.state}`)
      check('it states the capabilities it would grant', /WHAT DOING THIS WOULD LET YOU DO/i.test(opened.stepText) || /Work can run somewhere else/i.test(opened.noteText))
      check('it states the risks', /WHAT IT RISKS/i.test(opened.noteText))
      /* The step list is shown when the outside thing was NOT found, or could
         not be checked -- which is the case a person needs it in. When it was
         found, hiding the instructions is correct and the honest-partial
         sentence still stands, so the two cases are asserted separately rather
         than one being allowed to excuse the other. */
      const stepsShown = opened.state !== 'available'
      check('it says in as many words that the step is NOT required',
        !stepsShown || /You do not have to do this for the setting to be on/i.test(opened.stepText),
        stepsShown ? 'the sentence the directive turns on' : 'not applicable: the capability was found')
      check('it says this product will not do it for you',
        !stepsShown || /will not do this for you|does not ask Windows for administrator rights/i.test(opened.stepText))
      check('it says honestly what happens if you skip it, rather than failing silently',
        /stays on/i.test(opened.stepText) && /If you skip it:|If this ever stops being true:/i.test(opened.stepText))
      check('it says how you would know it worked',
        !stepsShown || /How you will know it worked:/i.test(opened.stepText))
      check('an unchecked capability is reported as unchecked, never as satisfied',
        !/this copy could not check/i.test(opened.stepText) || opened.state === 'unknown',
        `state=${opened.state}`)
      check('an unanswerable probe is reported as unknown rather than guessed',
        ['available', 'missing', 'unknown'].includes(opened.state), `state=${opened.state}`)
      await scrollTo('[data-setting-id="write_cloud-launch"]')
      await shot('B1-external-step-walkthrough')

      /* ---- 3. IT SAVES AND ENABLES ANYWAY ---- */
      console.log('\n[the setting still enables without the outside step]')
      await evaluate(`(() => {
        const input = document.querySelector('[data-setting-id="write_cloud-launch"] .settings-toggle input')
        input.click()
        return true
      })()`)
      await delay(1200)
      const afterToggle = await evaluate(READ_GUIDED_STEP)
      check('pressing the switch turns it ON and saves it, with the outside step not done',
        afterToggle.stored === 'enabled', `stored=${afterToggle.stored}`)
      check('the walkthrough is still shown after it is on, rather than disappearing',
        afterToggle.stepPresent || afterToggle.state === 'available', `state=${afterToggle.state}`)
      await scrollTo('[data-setting-id="write_cloud-launch"]')
      await shot('B2-enabled-anyway-with-honest-warning')

      /* ---- 4. EVERY ROW, NOT ONLY THE INTERESTING ONES ---- */
      console.log('\n[every setting states its capabilities and its risks]')
      await evaluate(`(() => {
        const input = document.querySelector('.settings-search input')
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await delay(1500)
      /* WHAT ONE PAGE OF THE SETTINGS SCREEN CARRIES.
         The guarantee is about rows OFFERING A CONTROL: a switch may not sit
         beside an empty disclosure. A row the register does not cover renders
         NO control and says the register says nothing -- that is the designed
         mismatch surface (a registry id newer than this copy's payload), an
         honest absence rather than an undeclared switch, so it is not counted
         against the guarantee. */
      const COVERAGE_OF_ONE_PAGE = `(() => {
        const rows = [...document.querySelectorAll('.settings-row[data-setting-id]')]
        const records = rows.map(row => ({
          id: row.dataset.settingId || '(missing id)',
          note: row.querySelector('[data-guided-for]'),
          hasControl: Boolean(row.querySelector('.settings-control input, .settings-control button, .settings-control select')),
        }))
        return {
          rows: rows.length,
          withNote: records.filter(record => record.note).length,
          missing: records.filter(record => !record.note).map(record => record.id),
          undeclared: records.filter(record => record.note
            && record.note.dataset.guidedDeclared === 'false'
            && record.hasControl
          ).map(record => record.id),
        }
      })()`
      /* EVERY CATEGORY IS ITS OWN PAGE, so the sweep walks them and adds up.
         The guarantee is about every row in the product, and one page holds one
         category's worth of them. The rail's groups ship collapsed, so they are
         opened first -- the same gesture that used to open the group heads in
         the main column. */
      const categories = await evaluate(`(() => {
        for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
        return [...document.querySelectorAll('.settings-rail button[data-category]')].map(node => node.dataset.category)
      })()`)
      check('the rail offers categories to sweep', (categories || []).length > 0, `${categories?.length} categories`)
      const coverage = { rows: 0, withNote: 0, missing: [], undeclared: [] }
      for (const category of categories || []) {
        const selector = `.settings-rail button[data-category=${JSON.stringify(category)}]`
        await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
        await delay(600)
        const page = await evaluate(COVERAGE_OF_ONE_PAGE)
        if (!page || typeof page.rows !== 'number') {
          console.log(`  --    ${category}: nothing could be read back`)
          continue
        }
        coverage.rows += page.rows
        coverage.withNote += page.withNote
        coverage.missing.push(...page.missing.map(id => `${category}/${id}`))
        coverage.undeclared.push(...page.undeclared.map(id => `${category}/${id}`))
      }
      check('every settings row on screen carries a capabilities-and-risks disclosure',
        coverage.rows > 0 && coverage.rows === coverage.withNote,
        `${coverage.withNote}/${coverage.rows} rows${coverage.missing.length ? `; missing: ${coverage.missing.join(', ')}` : ''}`)
      check('no row with a control on screen is undeclared', coverage.undeclared.length === 0, coverage.undeclared.join(', ') || 'none')
      /* The shot is of one row's open disclosure, so the page holding that row
         is the page to be standing on. `theme` is on another one now, and a
         picture of a row that is not there says nothing. */
      await evaluate(`location.hash = '#/settings?category=data-privacy'`)
      await delay(900)
      await evaluate(`(() => {
        for (const note of document.querySelectorAll('.settings-row[data-setting-id="uninstall_data"] [data-guided-for]')) note.open = true
        return true
      })()`)
      await delay(400)
      await scrollTo('.settings-row[data-setting-id="uninstall_data"]')
      await shot('C1-every-row-states-capabilities-and-risks')

      /* ---- 4b. THE PLACE A PERSON ARRIVES AT LATER ---- */
      console.log('\n[settings -> setup, where a person arrives weeks afterwards]')
      const setupNavigation = await evaluate(`(() => {
        const category = [...document.querySelectorAll('.settings-rail button[data-category]')]
          .find(node => node.dataset.category === 'Setup')
        if (!category) return { found: false }
        const wrap = category.closest('[data-rail-group-wrap]')
        const head = wrap?.querySelector('button[data-rail-group]')
        if (head?.getAttribute('aria-expanded') === 'false') head.click()
        category.click()
        return { found: true, group: head?.dataset.railGroup || null }
      })()`)
      if (!setupNavigation?.found) throw new Error('the Settings rail has no Setup category to navigate to')
      await until('the Settings Setup category and its withheld section', `
        document.querySelector('.settings-rail button[data-category="Setup"]')?.getAttribute('aria-current') === 'location'
        && Boolean(document.querySelector('[data-setup-profile-withheld]'))
      `)
      await delay(500)
      const setupSection = await evaluate(`(() => {
        const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
        const host = document.querySelector('[data-setup-profile-withheld]')
        const blocks = host ? [...host.querySelectorAll('[data-guided-withheld]')] : []
        if (host) host.scrollIntoView({ block: 'start' })
        return {
          present: Boolean(host),
          count: blocks.length,
          allDeclared: blocks.every(node => node.dataset.guidedDeclared === 'true'),
          optional: blocks.every(node => /Turning it on is optional/.test(text(node))),
          where: blocks.every(node => /Where to turn it on/.test(text(node))),
        }
      })()`)
      check('the settings Setup section explains the same withheld switches', setupSection.present && setupSection.count > 0,
        `${setupSection.count} explained`)
      check('and each one there is optional and says where the switch is',
        setupSection.allDeclared && setupSection.optional && setupSection.where)
      await delay(500)
      await shot('C2-settings-setup-section-withheld')

      /* ---- 5. THE OTHER SURFACE: THE PER-PAGE DRAWER ---- */
      console.log('\n[the quick-settings drawer]')
      await evaluate(`location.hash = '#/'`)
      await delay(2000)
      await evaluate(`(() => { document.querySelector('#open-settings').click(); return true })()`)
      await delay(1000)
      const drawer = await evaluate(`(() => {
        const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
        const body = document.querySelector('.drawer-body')
        const notes = [...body.querySelectorAll('[data-guided-for]')]
        const insideLabel = notes.filter(note => note.closest('label')).map(note => note.dataset.guidedFor)
        for (const note of notes) note.open = true
        return {
          notes: notes.length,
          ids: notes.map(note => note.dataset.guidedFor),
          disclosures: notes.map(note => ({
            id: note.dataset.guidedFor,
            declared: note.dataset.guidedDeclared,
            labels: [...note.querySelectorAll('.guided-label')].map(label => text(label)),
          })),
          insideLabel,
          text: text(body),
        }
      })()`)
      const expectedDrawerIds = ['example_mode', 'theme', 'text_size', 'glow']
      check('the drawer carries the intentional settings-family statements',
        JSON.stringify(drawer.ids) === JSON.stringify(expectedDrawerIds)
          && drawer.disclosures.every(note => note.declared === 'true'),
        drawer.ids.join(', '))
      check('no disclosure sits inside a label, where reading it would flip the switch',
        drawer.insideLabel.length === 0, drawer.insideLabel.join(', ') || 'none')
      check('the drawer states risks as well as capabilities',
        drawer.disclosures.every(note =>
          note.labels.some(label => /WHAT IT LETS HAPPEN/i.test(label))
          && note.labels.some(label => /WHAT IT RISKS/i.test(label))))
      await delay(500)
      await shot('D1-drawer-capabilities-and-risks')

      /* ---- 6. NOTHING WAS DONE TO THIS MACHINE ---- */
      console.log('\n[the operating system was described, never changed]')
      const after = readMachineSecurityPosture()
      check('the Windows UAC policy value is exactly what it was before the app started',
        before.uac !== null && after.uac !== null && before.uac === after.uac,
        before.uac === null ? 'UNKNOWN: could not read it, so this is not evidence either way' : 'unchanged')
      check('the Windows firewall profile state is exactly what it was before the app started',
        before.firewall !== null && after.firewall !== null && before.firewall === after.firewall,
        before.firewall === null ? 'UNKNOWN: could not read it, so this is not evidence either way' : 'unchanged')
    } finally {
      session.close()
      child.kill()
    }
  } finally {
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds the exe briefly */ } }
  }

  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    for (const result of failed) console.log(`  FAILED: ${result.name}`)
    process.exitCode = 1
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
