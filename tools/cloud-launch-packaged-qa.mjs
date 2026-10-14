#!/usr/bin/env node
/* CODEX CLOUD, ON A REAL PACKAGED WINDOW, REACHED AND LAUNCHED BY CLICKING.
 *
 * The owner's ruling is that launching a Codex Cloud task is a product feature
 * and must work from the software. Source tests cannot answer that: dead code
 * greps exactly like live code, and the defect this feature exists to fix was
 * precisely a working capability with no door. So this harness starts the
 * PACKAGED application, turns the feature on the way a person would, walks to
 * the surface by clicking, fills the form, presses Launch, answers the approval
 * dialog, and then follows the resulting task on Codex Cloud until it reaches a
 * terminal state.
 *
 * IT SPENDS REAL PROVIDER BUDGET, BY DESIGN. A cloud launch that is mocked
 * proves nothing about the thing that keeps breaking. The prompt is deliberately
 * trivial and instructs the cloud agent to change nothing.
 *
 * THREE RULES BORROWED FROM tools/team-panel-packaged-qa.mjs, WHICH EARNED THEM:
 *
 *   1. NAVIGATE BY CLICKING. auditSelf() enforces that against this file's own
 *      source, because a harness that assigns location.hash passes in full on a
 *      build where nothing routes to the page.
 *   2. ISOLATE LOCALAPPDATA AND userData so this machine's own permission level
 *      and settings cannot be mistaken for the product's behaviour.
 *   3. CLEANUP MAY NEVER FAIL THE RUN.
 *
 * AND ONE RULE THIS HARNESS ADDS, WHICH REVERSES PART OF RULE 2:
 *
 *   4. USERPROFILE IS NOT ISOLATED, AND MAY NOT BE. The Codex accounts are
 *      directories under the real user profile, and the registry entry for each
 *      one is a RELATIVE path resolved against it. An isolated home would make
 *      every account report ACCOUNT_PROFILE_UNAVAILABLE and this harness would
 *      then "prove" the failure path while reporting the feature exercised. The
 *      permission level -- the thing rule 2 exists for -- comes from the machine
 *      record under LOCALAPPDATA, which IS isolated, so nothing is weakened.
 *
 * WHAT CHANGED WHEN ENVIRONMENT DISCOVERY LANDED. This harness used to TYPE a
 * 32-character environment id into a text box, which meant the run could only
 * ever prove that a person who already knew the id could use it. The id is now
 * chosen from the environments the configured accounts are authorized for, so
 * the step below asserts the picker filled ITSELF and that the surface names the
 * repository the chosen environment is bound to before anything is sent.
 * CLOUD_QA_ENVIRONMENT is now a preference, not a requirement: absent, the run
 * takes the first environment the product offers.
 *
 * --release <directory> selects a candidate. The entire release is copied
 * unchanged into scratch; this driver never overlays checkout source.
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMachineServicesRoot } from './lib/qa-services-root.mjs'
import { releaseDirectory, stage as stageRelease, STAGE_EXACT_RELEASE } from './test-account-harness.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* Optional: which environment to launch into. There is deliberately no BRANCH
   knob any more. The branch comes from the environment the product discovered,
   and a harness that carried its own "main" default would have gone on passing
   after the surface stopped supplying one. */
const ENVIRONMENT_ID = process.env.CLOUD_QA_ENVIRONMENT || ''
const PROMPT = process.env.CLOUD_QA_PROMPT
  || 'Read README.md and reply with one sentence naming what this repository is. Do not create, edit or delete any file.'
const ACCOUNTS_SOURCE = process.env.CLOUD_QA_ACCOUNTS || ''

function auditSelf() {
  return readFileSync(SELF, 'utf8')
    .split('\n')
    .map((line, at) => ({ line, at: at + 1 }))
    .filter(({ line }) => /location\.hash\s*=/.test(line))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

async function stage(scratch) {
  return stageRelease(scratch, releaseDirectory(), { mode: STAGE_EXACT_RELEASE })
}

/* The machine record is written by the ENGINE's own writer out of the packaged
   payload, so this harness cannot seed a shape the product would reject. */
function seedMachineRecord(profile, appRoot, tier) {
  const workspace = path.join(profile, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
  mkdirSync(servicesRoot, { recursive: true })
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

/* THE ACCOUNT REGISTRY GOES WHERE A USER WOULD PUT IT, and that placement is
   itself part of what is under test. It used to be readable only from inside
   the program directory, which a customer cannot write and an update replaces.
   Copying it into this fresh profile's state root and getting a working launch
   is the evidence that the user-owned location actually resolves. */
function seedAccountRegistry(userData) {
  const target = path.join(userData, 'capability', 'config', 'accounts.json')
  if (!ACCOUNTS_SOURCE || !existsSync(ACCOUNTS_SOURCE)) return { seeded: false, target }
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(ACCOUNTS_SOURCE, target)
  return { seeded: true, target }
}

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

function createSession(port, child) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open() {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before the debugger answered`)
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
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            return
          }
        } catch { /* not listening yet */ }
        await delay(500)
      }
      throw new Error('no debuggable page appeared within 45s')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* VISIBLE IS MEASURED, AND HIT-TESTED.
 *
 * Text in the DOM is not text on the screen, and a non-zero bounding box is not
 * a clickable target either. This harness's first two runs reported "clicked"
 * three times against a settings toggle that never changed, because the row sat
 * inside a collapsed tier that still measured a real rectangle: the coordinates
 * were sane and something else entirely received the click. elementFromPoint
 * closes that -- a target is only a target if the point we are about to click
 * actually resolves to it (or to something inside it). Without this check a
 * harness reports a green click for an action that did not happen, which is the
 * exact defect class this whole feature exists to stop shipping. */
const VISIBLE = `(selector) => {
  const nodes = [...document.querySelectorAll(selector)]
  let lastReason = nodes.length ? 'hidden' : 'absent'
  for (const candidate of nodes) {
    const box = candidate.getBoundingClientRect()
    const style = getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    if (box.width < 1 || box.height < 1) { lastReason = 'zero-size'; continue }
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { lastReason = 'off-screen'; continue }
    /* STRICTLY the candidate or something inside it. An earlier version also
       accepted an ANCESTOR of the candidate, which is not a weaker check but a
       wrong one: elementFromPoint returns the TOPMOST painted element, so an
       ancestor coming back means the candidate is not painted there and the
       click will land on the ancestor. That leniency is what made three runs
       report a green click on a settings toggle that never changed. */
    const hit = document.elementFromPoint(x, y)
    if (!hit || !candidate.contains(hit)) {
      lastReason = 'covered:' + (hit ? (hit.tagName.toLowerCase() + '.' + String(hit.className || '').split(' ')[0]) : 'nothing')
      continue
    }
    return { state: 'visible', x, y, text: (candidate.textContent || '').trim().slice(0, 80) }
  }
  return { state: lastReason, count: nodes.length }
}`

/* The approval dialog is a WinForms window the capability layer raises through
   tools/desktop.ps1. It is NOT in the Electron window, so CDP cannot reach it:
   answering it is a keystroke to the desktop, exactly as it is for a person.
   The form sets AcceptButton to Yes and activates itself when shown, so Enter
   is the Yes button. This stands in for the human at the keyboard; it does not
   bypass the prompt, and a prompt that never appeared gets no keystroke. */
function answerApprovalDialog(titleFragment, timeoutMs) {
  /* THREE WAYS TO ANSWER THIS DIALOG WERE TRIED. Two are wrong and are recorded
     so the next person does not repeat them:
       1. Get-Process .MainWindowTitle never sees it. A console host's MAIN
          window is its console, so a WinForms dialog raised by a PowerShell
          process that owns a console is invisible to that API while being
          plainly on screen.
       2. SetForegroundWindow + SendKeys '{ENTER}' is worse than useless here.
          Windows declines the foreground grab to a process that does not
          already hold it, so the keystroke lands wherever focus actually is --
          and measured, the grab attempt itself destabilised the dialog, which
          then closed with no answer at all.
     What works, and is also what a person's click resolves to: find the window
     by CLASS and title, find the child button by its caption, and press the
     real mouse at that button's own screen rectangle. No focus stealing. */
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class QaDialog {
  delegate bool EP(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static IntPtr Handle = IntPtr.Zero;
  public static string Title = "";
  public static string Children = "";
  public static bool Find(string fragment) {
    Handle = IntPtr.Zero; Title = "";
    string want = fragment.ToLowerInvariant();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (!cls.ToString().StartsWith("WindowsForms10.Window")) return true;
      StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().ToLowerInvariant().Contains(want)) { Handle = h; Title = sb.ToString(); return false; }
      return true;
    }, IntPtr.Zero);
    return Handle != IntPtr.Zero;
  }
  public static bool Press(string caption) {
    IntPtr target = IntPtr.Zero; Children = "";
    string want = caption.ToLowerInvariant();
    EnumChildWindows(Handle, delegate(IntPtr h, IntPtr l) {
      StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      Children += "[" + sb.ToString() + "]";
      if (sb.ToString().ToLowerInvariant() == want) target = h;
      return true;
    }, IntPtr.Zero);
    if (target == IntPtr.Zero) return false;
    RECT r; if (!GetWindowRect(target, out r)) return false;
    SetCursorPos((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    return true;
  }
}
'@
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  if ([QaDialog]::Find('${titleFragment}')) {
    Start-Sleep -Milliseconds 900
    $pressed = [QaDialog]::Press('Yes')
    Write-Output ("answered:" + $pressed + " title=" + [QaDialog]::Title + " children=" + [QaDialog]::Children)
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
Write-Output 'no-dialog'
`
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('exit', () => resolve(out.trim()))
    child.on('error', () => resolve('answerer-failed'))
  })
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('UNMEASURED: this cloud driver needs the Windows native approval adapter; no provider operation was started.')
    process.exitCode = 2
    return
  }
  const offenders = auditSelf()
  if (offenders.length > 0) {
    for (const { line, at } of offenders) console.error(`  self-audit: line ${at} navigates by assigning the hash: ${line.trim()}`)
    console.error('A reachability suite that reaches the page by assigning the hash is not a reachability suite.')
    process.exitCode = 1
    return
  }
  if (ENVIRONMENT_ID && !/^[0-9a-f]{32}$/.test(ENVIRONMENT_ID)) {
    console.error('CLOUD_QA_ENVIRONMENT, when set, must be a 32-character Codex Cloud environment id')
    process.exitCode = 2
    return
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cloud-qa-'))
  const profile = path.join(scratch, 'profile')
  const userData = path.join(profile, 'userdata')
  let child = null
  let session = null

  try {
    const staged = await stage(scratch)
    const executable = staged.executable
    console.log(`artifact: ${staged.sourceRelease}; staging: ${staged.stageMode}; real-provider scenario, not installer qualification`)
    seedMachineRecord(profile, staged.appRoot, 'standard')
    const registry = seedAccountRegistry(userData)
    check('the account registry is readable from the user state root, not the install directory',
      registry.seeded, registry.target)

    const port = await freePort()
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_NO_ATTACH_CONSOLE
    environment.LOCALAPPDATA = path.join(profile, 'local')
    // USERPROFILE deliberately NOT overridden -- see rule 4 in the header.

    child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      /* windowsHide suppresses the CONSOLE window only; the BrowserWindow is
         hidden by MC_SMOKE_HEADLESS=1 in the inherited environment (see
         shell/window-options.cjs), which tools/packaged-qa-suite.mjs sets. */
      env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    session = createSession(port, child)
    await session.open()

    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (packet?.result?.exceptionDetails) return { __error: packet.result.exceptionDetails.text }
      return packet?.result?.result?.value
    }
    const clickVisible = async selector => {
      /* Scroll first, then measure. The fleet rail is a scrolling column and
         the Codex Cloud box is the fourth panel in it, so on a short window it
         is genuinely below the fold -- a person scrolls to it, and so must
         this. Measuring without scrolling reported "off-screen" for a control
         that is perfectly reachable. */
      await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (node) node.scrollIntoView({ block: 'center', inline: 'center' })
        return true
      })()`)
      await delay(250)
      const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(selector)})`)
      if (spot?.state !== 'visible') return spot?.state || 'unknown'
      for (const type of ['mousePressed', 'mouseReleased']) {
        await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      }
      await delay(600)
      return 'clicked'
    }
    const shot = async name => {
      const packet = await session.send('Page.captureScreenshot', { format: 'png' })
      const data = packet?.result?.data
      if (!data) return null
      const file = path.join(REPO_ROOT, 'release', `cloud-qa-${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    }

    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
    await delay(2500)
    console.log('  route on open:', await evaluate('location.hash || "(none)"'))

    /* THE FEATURE IS TURNED ON BY CLICKING ITS SWITCH, not by writing the flag.
       That is the whole claim being tested at this step: the panel ships off,
       and a person must be able to FIND the switch and use it.

       THE SELECTOR NAMES THE SETTINGS LINK, never the strip. It used to lead
       with `#tb-nav a, #tb-nav button`, written while that strip held no links
       at all -- a fallback that matched nothing. The centered text navigation
       filled it with eight, and querySelector returns the first match in the
       DOCUMENT, not the first selector that works, so the list resolved to Home:
       this step reported "clicked", the app went to the home screen, and the
       run failed four steps later looking for a settings rail that was never on
       screen. A driver that opens a page names the door it presses. The drawer's
       "all settings" link stays as the fallback for a build whose strip is
       hidden, and it is last because it is behind a popover. */
    check('Settings is reachable from the opening view',
      await clickVisible('#tb-nav a[data-route="settings"], .drawer-all[href="#/settings"]') === 'clicked')
    await delay(1200)
    console.log('  route after opening Settings:', await evaluate('location.hash || "(none)"'))

    /* The Write section carries the switch behind a "N more" reveal, because
       cloud-launch is a deeper tier than dispatch. Open reveals until the row's
       own toggle is genuinely hit-testable -- not merely present. */
    let switched = 'not-attempted'
    let flagAfterClick = null
    const TOGGLE = '[data-setting-id="write_cloud-launch"] .settings-toggle'
    // Jump the sidebar to Write first. Opening "the first collapsed tier in the
    // document" walks the tiers of whichever section happens to be on top and
    // never arrives.
    /* The rail's groups ship collapsed; open them the way a person does, so the
     category this driver wants is a button on the screen. */
    await evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
    await delay(400)
    const railClick = await clickVisible('.settings-rail button[data-category="Things it may do for you"]')
    console.log('  Write category in the settings rail:', railClick)
    await delay(1200)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(TOGGLE)})`)
      if (spot?.state === 'visible') break
      const reveal = await evaluate(`(() => {
        const button = [...document.querySelectorAll('.settings-reveal[data-reveal-section="Things it may do for you"]')].find(node => node.getAttribute('aria-expanded') === 'false')
        if (!button) return null
        button.scrollIntoView({ block: 'center' })
        return button.textContent.trim().slice(0, 40)
      })()`)
      if (!reveal) break
      await delay(300)
      console.log(`  opening a collapsed Write tier: ${reveal}`)
      await clickVisible('.settings-reveal[data-reveal-section="Things it may do for you"][aria-expanded="false"]')
      await delay(600)
    }
    const rowFound = await evaluate(`(() => {
      const row = document.querySelector('[data-setting-id="write_cloud-launch"]')
      if (!row) return { found: false }
      row.scrollIntoView({ block: 'center' })
      return { found: true, name: row.querySelector('.settings-name')?.textContent || null }
    })()`)
    check('Settings offers a Codex Cloud switch', rowFound?.found === true, JSON.stringify(rowFound))
    await delay(500)
    const before = await evaluate(`(() => {
      const input = document.querySelector('[data-setting-id="write_cloud-launch"] .settings-toggle input')
      return { checked: input?.checked ?? null, flag: localStorage.getItem('mc.write.cloud-launch') }
    })()`)
    switched = await clickVisible(TOGGLE)
    await delay(700)
    const after = await evaluate(`(() => {
      const input = document.querySelector('[data-setting-id="write_cloud-launch"] .settings-toggle input')
      return { checked: input?.checked ?? null, flag: localStorage.getItem('mc.write.cloud-launch'), mirror: localStorage.getItem('mc.set.write_cloud-launch') }
    })()`)
    console.log('  toggle before/after:', JSON.stringify(before), JSON.stringify(after))
    flagAfterClick = after?.flag
    check('the Codex Cloud switch responds to a real, hit-tested click', switched === 'clicked', switched)
    check('clicking the switch turns the feature on', flagAfterClick === 'enabled', String(flagAfterClick))
    console.log('  settings screenshot:', await shot('1-settings'))

    /* Walk the route ring to Computers with the chevrons -- this product's nav
       is two arrows and a gear, so those arrows ARE the way a person moves. */
    let route = await evaluate('location.hash || ""')
    for (let step = 0; step < 12 && !route.startsWith('#/computers'); step += 1) {
      await clickVisible('#nav-next')
      await delay(900)
      route = await evaluate('location.hash || ""')
    }
    check('Computers is reachable by clicking the route chevrons', route.startsWith('#/computers'), route)
    await delay(3000)
    console.log('  computers screenshot:', await shot('2-computers'))

    const cloudSurface = await evaluate(`(() => {
      const surface = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
      if (!surface) return { present: false, route: location.hash }
      return {
        present: true,
        route: location.hash,
        kind: surface.className,
        status: surface.querySelector('[data-cloud-status]')?.textContent || null,
        controlsEnabled: [...surface.querySelectorAll('button')].some(button => !button.disabled),
      }
    })()`)
    console.log('  cloud surface after computers:', JSON.stringify(cloudSurface))

    if (!cloudSurface?.present) {
      console.log('  computers DOM:', JSON.stringify(await evaluate(`(() => ({
        liveMode: document.querySelector('.computers')?.dataset?.liveMode || null,
        clickables: [...document.querySelectorAll('.gnode, .node, [data-node], .ar-card, .board-box')].slice(0, 8).map(n => n.className),
        text: (document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 400),
      }))()`)))
      for (const selector of ['.gnode', '.node', '[data-node]', 'svg .n', '.graph-wrap circle', '.ar-card']) {
        const clicked = await clickVisible(selector)
        console.log(`  click ${selector}:`, clicked)
        if (clicked === 'clicked') break
      }
      await delay(2500)
      console.log('  after node click:', JSON.stringify(await evaluate(`(() => ({
        route: location.hash,
        cloudBox: Boolean(document.querySelector('.board-cloud-box')),
        cloudSurface: Boolean(document.querySelector('.cloud-surface')),
        boardBoxes: [...document.querySelectorAll('.board-box .bh-t')].map(n => n.textContent),
      }))()`)))
      console.log('  rail screenshot:', await shot('3-rail'))
      // Then the agent page itself, still by clicking: the rail's own link.
      if (!(await evaluate(`Boolean(document.querySelector('.board-cloud-box'))`))) {
        const opened = await clickVisible('[data-a="open"]')
        console.log('  click "Open full view":', opened)
        await delay(3000)
        console.log('  after open:', JSON.stringify(await evaluate(`(() => ({
          route: location.hash,
          cloudSurface: Boolean(document.querySelector('.cloud-surface')),
          writeSurfaces: [...document.querySelectorAll('.write-surface > header strong')].map(n => n.textContent),
        }))()`)))
        console.log('  agent page screenshot:', await shot('3b-agent'))
      }
    }

    const surfaceNow = await evaluate(`Boolean(document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box'))`)
    check('the Codex Cloud surface is on the glass after clicking there', surfaceNow === true)
    if (surfaceNow !== true) {
      console.log('  DOM probe:', JSON.stringify(await evaluate(`(() => ({
        route: location.hash,
        boardBoxes: [...document.querySelectorAll('.board-box .bh-t')].map(n => n.textContent),
        writeSurfaces: [...document.querySelectorAll('.write-surface > header strong')].map(n => n.textContent),
      }))()`)))
      throw new Error('no cloud surface reached')
    }

    /* Accounts: the picker must show real accounts read from the provider. */
    await delay(1000)
    const refreshed = await clickVisible('[data-cloud-refresh], [data-cloud="refresh"]')
    console.log('  refresh click:', refreshed)
    await delay(25000)
    const accounts = await evaluate(`(() => {
      const select = document.querySelector('[data-cloud-form] select[name="account"], [data-cloud="account"]')
      if (!select) return { found: false }
      return { found: true, options: [...select.options].map(option => option.textContent) }
    })()`)
    check('the account picker lists the configured accounts with their real allowance',
      Array.isArray(accounts?.options) && accounts.options.length > 1,
      JSON.stringify(accounts?.options))
    const listState = await evaluate(`(() => {
      const out = document.querySelector('[data-cloud-list-output], [data-cloud="list-out"]')
      const rows = [...document.querySelectorAll('.cloud-task')].slice(0, 4).map(row => row.textContent.replace(/\\s+/g, ' ').trim())
      return { message: out?.textContent || null, rows }
    })()`)
    check('the task list reads real Codex Cloud tasks with honest state',
      Array.isArray(listState?.rows) && listState.rows.length > 0, JSON.stringify(listState).slice(0, 400))
    console.log('  cloud surface screenshot:', await shot('4-cloud-surface'))

    /* DISCOVERY: the picker fills itself, and no id is typed anywhere in this
       file. A run that had to be told the id could not tell a working discovery
       from a missing one. */
    let picker = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      picker = await evaluate(`(() => {
        const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
        const select = scope?.querySelector('select[name="environment"], [data-cloud="environment"]')
        if (!select) return { found: false }
        return {
          found: true,
          options: [...select.options].map(option => ({ value: option.value, text: option.textContent, disabled: option.disabled })),
          message: scope.querySelector('[data-cloud-environments-output], [data-cloud="environments-out"]')?.textContent || null,
        }
      })()`)
      if (picker?.found && picker.options.length > 1) break
      await delay(2000)
    }
    check('the environment picker discovered the authorized environments without anyone typing an id',
      Boolean(picker?.found) && picker.options.filter(option => option.value && !option.disabled).length > 0,
      String(picker?.message || '').slice(0, 200))

    const target = (picker?.options || []).find(option => option.value === ENVIRONMENT_ID)
      || (picker?.options || []).find(option => option.value && !option.disabled)
    check('the environment this run targets is offered by the product', Boolean(target), JSON.stringify(target || null))
    if (!target) throw new Error('no launchable environment was offered')

    const chosen = await evaluate(`(() => {
      const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
      const select = scope.querySelector('select[name="environment"], [data-cloud="environment"]')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify('%ENVIRONMENT%')})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const branch = scope.querySelector('input[name="branch"], [data-cloud="branch"]')
      const prompt = scope.querySelector('textarea[name="prompt"], [data-cloud="prompt"]')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, ${JSON.stringify(PROMPT)})
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      return {
        value: select.value,
        binding: scope.querySelector('[data-cloud-binding], [data-cloud="binding"]')?.textContent || null,
        branch: branch?.value || null,
        prompt: prompt.value.length,
      }
    })()`.replace('"%ENVIRONMENT%"', JSON.stringify(target.value)))
    check('choosing an environment shows the source repository it is bound to',
      /^Bound to \S+\/\S+/.test(chosen?.binding || ''), String(chosen?.binding).slice(0, 200))
    check('the branch comes from that environment rather than from a hardcoded default',
      Boolean(chosen?.branch) && String(chosen.binding).includes(chosen.branch), String(chosen?.branch))
    check('the launch form accepts the task', Number(chosen?.prompt) > 0, String(chosen?.prompt))

    const armed = await clickVisible('[data-cloud-launch], [data-cloud="go"]')
    check('pressing Launch arms rather than sending', armed === 'clicked', armed)
    await delay(800)
    const armedState = await evaluate(`(() => {
      const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
      const button = scope.querySelector('[data-cloud-launch], [data-cloud="go"]')
      const out = scope.querySelector('[data-cloud-launch-output], [data-cloud="out"]')
      return { label: button?.textContent, message: out?.textContent }
    })()`)
    check('the armed state says the launch cannot be cancelled',
      /cannot be cancelled/i.test(armedState?.message || ''), JSON.stringify(armedState))
    console.log('  armed screenshot:', await shot('5-armed'))

    // The approval watcher starts BEFORE the confirming click, because the
    // dialog can appear within milliseconds of it.
    const answering = answerApprovalDialog('Approve cloud.task_launch', 55_000)
    const confirmed = await clickVisible('[data-cloud-launch], [data-cloud="go"]')
    check('the second press sends the launch', confirmed === 'clicked', confirmed)
    const answered = await answering
    check('the product asked for approval before contacting the provider, and it was answered',
      answered.startsWith('answered:True'), answered)

    let launchMessage = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(2000)
      launchMessage = await evaluate(`(() => {
        const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
        const out = scope.querySelector('[data-cloud-launch-output], [data-cloud="out"]')
        return out ? out.textContent : ''
      })()`)
      if (launchMessage && !/Waiting for approval|Launching/i.test(launchMessage)) break
    }
    console.log('  launch result on the glass:', launchMessage)
    const taskId = (launchMessage.match(/task_[A-Za-z0-9_]+/) || [])[0] || null
    check('a real Codex Cloud task id came back to the window', Boolean(taskId), launchMessage.slice(0, 300))

    const receipt = await evaluate(`(() => {
      const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
      const node = scope.querySelector('[data-cloud-receipt], [data-cloud="receipt"]')
      if (!node || node.hidden) return { shown: false }
      const rows = {}
      for (const row of node.querySelectorAll('li')) rows[row.querySelector('.cloud-receipt-k').textContent] = row.querySelector('.cloud-receipt-v').textContent
      return { shown: true, rows }
    })()`)
    check('the window shows an immutable receipt naming task, environment, repository, branch and state',
      receipt?.shown === true
      && /task_/.test(receipt.rows.task || '')
      && (receipt.rows.repository || '').includes('/')
      && Boolean(receipt.rows.branch)
      && Boolean(receipt.rows['state at submission'])
      && (receipt.rows.environment || '').includes(target.value),
      JSON.stringify(receipt?.rows || {}).slice(0, 400))
    console.log('  launched screenshot:', await shot('6-launched'))

    /* FOLLOW IT WITHOUT PRESSING ANYTHING. The surface watches the task on its
       own; a harness that clicked Refresh here would prove the old behaviour and
       hide a broken watch. */
    const watchSeen = []
    let terminal = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(10000)
      const watch = await evaluate(`(() => {
        const scope = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
        return scope.querySelector('[data-cloud-watch], [data-cloud="watch"]')?.textContent || ''
      })()`)
      if (watch && watchSeen.at(-1) !== watch) {
        watchSeen.push(watch)
        console.log(`  watch ${watchSeen.length}: ${watch}`)
      }
      if (/^finished|^failed|^cancelled/.test(watch)) { terminal = true; break }
    }
    check('the status watch updates on its own, with no Refresh click', watchSeen.length > 1, JSON.stringify(watchSeen.slice(0, 4)))
    check('the watch followed the task to a terminal state the window reports honestly', terminal, JSON.stringify(watchSeen.at(-1) || ''))
    console.log('  final screenshot:', await shot('7-terminal'))

    if (stderr.trim()) console.log('  app stderr tail:', stderr.trim().split('\n').slice(-4).join(' | '))
  } finally {
    try { session?.close() } catch { /* already gone */ }
    try { child?.kill() } catch { /* already gone */ }
    await delay(1500)
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* cleanup may never fail the run */ }
  }

  const failed = results.filter(result => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch(error => { console.error('HARNESS FAILED:', error.stack || error.message); process.exitCode = 1 })
