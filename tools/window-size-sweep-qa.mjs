#!/usr/bin/env node

// B10 — THE PRIMARY ROUTES AT FIVE WINDOW WIDTHS, MEASURED IN A REAL WINDOW
// THAT IS REALLY RESIZED.
//
// WHY A REAL RESIZE AND NOT Emulation.setDeviceMetricsOverride. Device-metrics
// emulation changes what the renderer thinks the viewport is; it does not
// change the window. That difference is not academic in THIS app: the shell
// paints a Windows title-bar overlay over the top of the web contents and
// `#stage` is sized in `vh`, so the only honest way to ask "what does a person
// with a 1280-wide window see" is to give the window 1280 CSS pixels of web
// contents and look. The window is placed on whichever attached display is
// wide enough to hold it (enumerated at run time, never hard-coded) and the
// bounds are CALIBRATED: the first set is read back, the frame's own width is
// subtracted, and the bounds are set again so `innerWidth` lands exactly on
// the target. The realized innerWidth is printed for every size, so a reader
// never has to take "1920" on trust.
//
// WHAT IS MEASURED AT EVERY ROUTE AT EVERY SIZE, stated before anything runs:
//
//   PAGE SCROLL     does the page scroll sideways? `body` is `overflow:hidden`
//                   in this product, so the interesting number is not only the
//                   scrollbar: it is `scrollWidth > clientWidth` on the
//                   document, on `#stage`, on the mounted `.view` and on
//                   `.view-pad` — the four boxes that can carry the overflow.
//   CLIPPED         an element whose own content is wider (or taller) than its
//                   box AND whose computed overflow on that axis is `hidden`
//                   or `clip`: content that is cut off with NO way to reach it.
//                   Split from `text-overflow: ellipsis`, which is a deliberate
//                   truncation and is reported separately rather than as a bug.
//   PAST THE EDGE   a visible element whose box crosses the right edge of the
//                   window while no ancestor of it can scroll horizontally.
//                   This is the failure `body{overflow:hidden}` hides: there is
//                   no scrollbar to reveal it, the pixels are simply gone.
//   SCROLLERS       elements that ARE wider than their box and CAN be scrolled
//                   on that axis. These are the passing case for "wide content
//                   scrolls inside its own container", so they are counted and
//                   named rather than left implicit.
//   EMPTY REGIONS   a visible box of at least 24000px^2 that renders no text,
//                   no image, canvas, svg or control. Reported outermost-first
//                   with its rectangle, so a reviewer can look at the numbered
//                   screenshot and see the hole.
//   DEAD MARGIN     the gap between the right edge of the rightmost thing with
//                   words in it and the right edge of the stage. A number, not
//                   a verdict: a centred column has a large one by design.
//
// EVERY ROUTE IS REACHED BY PRESSING THE CONTROL A PERSON PRESSES. The chevron
// walks the ring; nothing here assigns `location.hash`, and the file audits
// itself for that on startup (borrowed from tools/offline-routes-qa.mjs, which
// earned the rule).
//
// RUN IT:
//   node tools/window-size-sweep-qa.mjs
//   node tools/window-size-sweep-qa.mjs --shoot artifacts/b10/after --label after
//   --widths 1024,1280,1440,1600,1920
//   --release <dir>      default release/win-unpacked
//   --keep               keep the scratch profile
//   --json <file>        write the full measurement transcript
//
// EXIT CODE HAS THREE VALUES AND ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED — a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured.

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEXT_SIZES as OFFERED_TEXT_SIZES } from '../src/text-size.js'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const SHOOT = argument('--shoot', null) ? path.resolve(argument('--shoot')) : null
const LABEL = argument('--label', 'run')
const JSON_OUT = argument('--json', null) ? path.resolve(argument('--json')) : null
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
/* AN EMPTY PRODUCT CANNOT CLIP. On a sterile profile there is no fleet, no
   chart series, no ledger rows and no messages, so every screen is an empty
   state and "nothing was cut off" is a statement about a page with nothing on
   it. --demonstration turns the six per-view data sources to the built-in
   demonstration by PRESSING THE SIX TOGGLES a person presses (Settings ->
   Data & Sim -> "<page> live data"), and then sweeps the same routes with the
   screens full. Both passes are reported; neither replaces the other. */
const DEMONSTRATION = process.argv.includes('--demonstration')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* The five widths in the task, and a height for each that a person with that
   width plausibly has. Height is not the variable under test but it cannot be
   absent: a route that fits at 1920x1080 and clips its footer at 1024x768 is
   still clipped at 1024. */
const SIZES = (argument('--widths', '1024,1280,1440,1600,1920'))
  .split(',').map(part => Number(part.trim())).filter(Boolean)
  .map(width => ({ width, height: width <= 1024 ? 768 : width <= 1280 ? 800 : width <= 1440 ? 900 : width <= 1600 ? 1000 : 1080 }))

/* ---------- THE TEXT-SCALE AXIS ----------
 *
 * WHY IT EXISTS. Every width above is a CSS width at DEFAULT text scale, and
 * until now that was the only condition this suite -- or any layout gate in
 * this repo -- ever measured. src/main.js says so itself about the text-size
 * control: "the QA suites (which assert px) run at default". So "no route
 * clips" has only ever been a statement about one text scale.
 *
 * The arithmetic is what makes that a hole rather than a gap. OS display
 * scaling DIVIDES the CSS viewport, so a 1366-wide panel at 150% hands the
 * layout 911 CSS px and at 200% hands it 683 -- both below 1024, the smallest
 * width this suite has ever measured. Of the twenty-five combinations of five
 * common panel widths and five common Windows scales, eleven land under 1024.
 *
 * TWO MECHANISMS, AND THEY ARE NOT THE SAME. They are separated here because
 * they fail differently and a fix for one does not fix the other:
 *
 *   --os-scale     The operating system's display scaling. Applied by
 *                  launching the app with --force-device-scale-factor, which
 *                  is the real switch rather than an emulated one -- the same
 *                  reason this file resizes a real window instead of reaching
 *                  for Emulation.setDeviceMetricsOverride. It SHRINKS the CSS
 *                  viewport: everything gets fewer CSS pixels to lay out in.
 *   --text-sizes   The app's own text-size control (Settings -> Text size),
 *                  which is `zoom` on the body. It does NOT shrink the
 *                  viewport; it enlarges every box inside it. Driven through
 *                  the same stored setting the control writes, so this
 *                  measures the control a person actually has.
 */
const APP_TEXT_SIZES = OFFERED_TEXT_SIZES
const OS_SCALE = Number(argument('--os-scale', '1'))
const TEXT_SIZES = (argument('--text-sizes', '1'))
  .split(',').map(part => Number(part.trim())).filter(Number.isFinite)

/* A REQUESTED SCALE THE PRODUCT DOES NOT OFFER MUST REFUSE, NOT RUN.
 * src/main.js applies the stored text size only when it is exactly 0.9 or
 * 1.12; any other number is stored and silently ignored. A sweep asked for
 * `--text-sizes 1.5` would therefore measure DEFAULT text, find nothing, and
 * report a pass for a scale it never applied -- the silent-skip defect this
 * repo keeps re-finding, wearing a green tick. */
export function scaleMatrix({ sizes, osScale = 1, textSizes = [1] }) {
  if (!(Number.isFinite(osScale) && osScale > 0)) {
    throw Object.assign(new Error(`--os-scale must be a positive number; got ${osScale}`), { code: 'OS_SCALE_INVALID' })
  }
  for (const textSize of textSizes) {
    if (!APP_TEXT_SIZES.includes(textSize)) {
      throw Object.assign(
        new Error(`the text-size control offers only ${APP_TEXT_SIZES.join(', ')}; ${textSize} would be stored and silently ignored, so this run would measure default text and report a pass for a scale it never applied`),
        { code: 'TEXT_SIZE_NOT_OFFERED' },
      )
    }
  }
  const cases = []
  for (const size of sizes) {
    for (const textSize of textSizes) {
      /* The window is opened at the panel width; the OS scale decides how many
         CSS pixels that is, and the app's zoom decides how much of it a box
         actually gets. Both are reported so a reader never has to derive it. */
      const cssWidth = Math.round(size.width / osScale)
      cases.push({
        ...size,
        osScale,
        textSize,
        cssWidth,
        effectiveWidth: Math.round(cssWidth / textSize),
        tag: `${size.width}@${Math.round(osScale * 100)}%${textSize === 1 ? '' : ` text${textSize}`}`,
      })
    }
  }
  return cases
}

export { APP_TEXT_SIZES }

const CASES = scaleMatrix({ sizes: SIZES, osScale: OS_SCALE, textSizes: TEXT_SIZES })

/* EVERY WAY THIS PRODUCT OFFERS OF GETTING FROM THE FLEET PAGE TO THE AGENT
   PAGE, in the order they are tried below. Named here so that a run which finds
   none of them can PRINT the list with a count beside each, which is the one
   piece of evidence that tells a renamed class apart from a missing door.
     .graph-empty-action  the empty fleet state's "See an example agent" anchor
                          (src/views/computers.js emptyStateExample), offered
                          only when the simulator has an agent to show
     .static-tree-node    an agent bubble on the canvas (src/tree-graph.js);
                          selecting one is what reveals the named door
     .graph-open-btn      "Open agent detail" in the named-controls strip
                          (src/views/computers.js). Since 18ef5e7 it is aimed
                          at the first DECLARED seat and VISIBLE with no
                          selection on a fresh install; selecting a node aims
                          it at that node instead
     .node                the bubble's other class, kept because the wait
                          predicate has always used it
     .tree-empty-node     NOT a door -- an empty slot opens the compose panel.
                          Listed only so its count appears in the diagnostic: a
                          page showing empty slots and no bubbles is the state
                          this went red in, and seeing that in the line saves
                          the next reader a run. */
const DOOR_SELECTORS = Object.freeze([
  '.graph-empty-action', '.static-tree-node', '.graph-open-btn', '.node', '.tree-empty-node',
])

class HarnessError extends Error {}

export class DisplayEnumerationError extends HarnessError {
  constructor(error) {
    const detail = error instanceof Error
      ? `${error.code ? `${error.code}: ` : ''}${error.message}`
      : `non-Error throw (${String(error)})`
    super(`display enumeration could not be completed (${detail}); this is NOT claiming that no display exists`)
    this.name = 'DisplayEnumerationError'
    this.code = 'DISPLAY_ENUMERATION_UNAVAILABLE'
    this.cause = error
  }
}

function auditSelf() {
  const source = readFileSync(SELF, 'utf8')
  const offences = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(\+?=)(?!=)/.test(line))
  if (offences.length === 0) return
  console.error('\nNO VERDICT: this suite navigates by assigning location.hash, which is the')
  console.error('one thing a customer cannot do. Offending lines:')
  for (const { line, number } of offences) console.error(`  ${number}: ${line.trim()}`)
  process.exit(2)
}

/* ---------- the widest attached display, enumerated rather than assumed ----------
 * A 1920-wide window does not fit on a 1536-wide panel, and a window Windows
 * has clamped reports a viewport that was never asked for. The display list is
 * read from the OS at run time so this file carries no machine's geometry. */
export function widestDisplay(run = execFileSync) {
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ` +
      `'{0},{1},{2},{3}' -f $_.WorkingArea.X, $_.WorkingArea.Y, $_.WorkingArea.Width, $_.WorkingArea.Height }`
    const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true })
    const screens = out.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [x, y, w, h] = line.split(',').map(Number)
      return { x, y, w, h }
    }).filter(screen => Number.isFinite(screen.w) && screen.w > 0)
    if (!screens.length) return null
    return screens.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0]
  } catch (error) {
    /* A successfully read empty list means there is no screen to choose. A
       thrown OS/process error means the machine did not answer the question;
       turning EMFILE/EAGAIN/EIO/EBUSY (or an unclassified throw) into the same
       null would make main() proceed as though enumeration definitely found
       nothing. Do not cache this failure: a later attempt may succeed. */
    throw new DisplayEnumerationError(error)
  }
}

/* ---------- stage a packaged copy (never runs release/win-unpacked itself) ----
 * Identical staging to tools/offline-routes-qa.mjs, for the reason documented
 * there: the GUI writes state/ next to its binary, so running the artifact in
 * place mutates the artifact. dist/ and shell/ come from the working tree so
 * this measures what is actually here. */
async function stage(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const app = path.join(scratch, 'app')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  const unpacked = path.join(app, 'resources', 'app')
  mkdirSync(unpacked, { recursive: true })
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  rmSync(path.join(app, 'resources', 'app.asar'), { force: true })
  rmSync(path.join(app, 'resources', 'app.asar.filelist.txt'), { force: true })
  return app
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

function systemOnlyPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return [
    path.join(root, 'system32'),
    root,
    path.join(root, 'system32', 'Wbem'),
    path.join(root, 'system32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

function createSession(child, userDataDir, say) {
  let socket = null
  let browserSocket = null
  let nextId = 1
  const pending = new Map()
  const browserPending = new Map()
  let devtoolsPort = null
  const session = {
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
      devtoolsPort = port
      say(`debugger published on 127.0.0.1:${port} after ${Date.now() - started}ms`)
      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered`)
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
          const page = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            session.pageTargetId = page.id
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
            say(`attached to the window after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length ? `${targets.length} target(s) and none a debuggable page` : 'an EMPTY target list'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s — ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() {
      try { socket?.close() } catch { /* already gone */ }
      try { browserSocket?.close() } catch { /* already gone */ }
    },
  }
  return session
}

/* ---------------------------------------------------------------------------
 * THE RESIZE. Win32, on the window Windows actually owns.
 *
 * The obvious route is CDP `Browser.setWindowBounds`. Electron does not
 * implement the Browser domain's window methods: the reply is
 * "'Browser.getWindowForTarget' wasn't found", which reads like a missing
 * feature in this build and is in fact a domain Electron never had. Measured,
 * on the staged copy, before this was written.
 *
 * The remaining honest option is the one a person uses: ask the operating
 * system to make the window that size. `SetWindowPos` on the app's own top
 * level HWND is the same call the window manager makes when a window edge is
 * dragged, so what is measured afterwards is a window that really is that big.
 *
 * The alternative that was NOT taken is `Emulation.setDeviceMetricsOverride`:
 * it changes what the renderer believes about the viewport and leaves the
 * window alone, so a defect in how the shell sizes its web contents — the
 * title-bar overlay, `#stage`'s `100vh` — would be invisible to it by
 * construction.
 */
const PS_RESIZE = [
  'param([int]$OwnerPid, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$MatchW = 0, [int]$MatchH = 0, [string]$ExeRoot = "")',
  '$ErrorActionPreference = "Stop"',
  'Add-Type @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class SweepWin32 {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll", SetLastError=true)]',
  '  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
  '  // Every TOP-LEVEL window owned by one of these process ids, largest first.',
  '  // MainWindowHandle is NOT used: it is null for a process started with the',
  '  // hidden-window creation flag every spawn in this repo uses, which reads',
  '  // exactly like "the app has no window" when the app plainly has one.',
  '  public static List<IntPtr> WindowsOf(HashSet<uint> pids) {',
  '    var found = new List<IntPtr>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr unused) {',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      if (!pids.Contains(pid)) return true;',
  '      if (GetWindow(h, 4) != IntPtr.Zero) return true;   // GW_OWNER: a dialog, not the frame',
  '      var name = new StringBuilder(64); GetClassName(h, name, 64);',
  '      if (name.ToString() != "Chrome_WidgetWin_1") return true;',
  '      found.Add(h);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '}',
  '"@',
  '# SPEAK PHYSICAL PIXELS, BEFORE TOUCHING A SINGLE WINDOW.',
  '# PowerShell is DPI-unaware by default, so Windows virtualises every',
  '# coordinate it passes to SetWindowPos through the SYSTEM dpi (125% here)',
  '# while the app window is per-monitor aware at 137.5%. Asking a per-monitor',
  '# aware window for a size in virtualised units is a documented mess and it',
  '# behaved like one: the first call, with cy=768, produced a window 65535',
  '# physical pixels tall. Declaring awareness first removes the translation',
  '# layer entirely -- after this line the numbers below ARE physical pixels.',
  '# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4.',
  'try { [void][SweepWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][SweepWin32]::SetProcessDPIAware() }',
  '# The whole process tree: Electron owns its window in the main process, but',
  '# which process that is depends on how the binary was launched.',
  '#',
  '# FENCED TO THE STAGED COPY. Other lanes run their own staged copies of this',
  '# same application on this machine at the same time, and Windows reuses',
  '# process ids -- so a tree walked by parent id alone can reach a window that',
  '# belongs to somebody else`s run, and resizing THAT is a collision, not a',
  '# measurement. Only processes whose image lives under the directory this',
  '# harness staged are considered.',
  '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath',
  '$byParent = @{}',
  'foreach ($row in $all) {',
  '  $key = [int]$row.ParentProcessId',
  '  if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.ArrayList }',
  '  [void]$byParent[$key].Add($row)',
  '}',
  '$pathOf = @{}',
  'foreach ($row in $all) { $pathOf[[int]$row.ProcessId] = [string]$row.ExecutablePath }',
  '$mine = { param($id) if (-not $ExeRoot) { return $true }',
  '  $p = $pathOf[[int]$id]; if (-not $p) { return $false }',
  '  return $p.StartsWith($ExeRoot, [StringComparison]::OrdinalIgnoreCase) }',
  '$pids = New-Object "System.Collections.Generic.HashSet[uint32]"',
  '$queue = New-Object System.Collections.Generic.Queue[int]',
  '$queue.Enqueue($OwnerPid)',
  '$seen = @{}',
  'while ($queue.Count -gt 0) {',
  '  $id = $queue.Dequeue()',
  '  if ($seen.ContainsKey($id)) { continue }',
  '  $seen[$id] = $true',
  '  if (-not (& $mine $id)) { continue }',
  '  [void]$pids.Add([uint32]$id)',
  '  if ($byParent.ContainsKey($id)) { foreach ($kid in $byParent[$id]) { $queue.Enqueue([int]$kid.ProcessId) } }',
  '}',
  '$handles = [SweepWin32]::WindowsOf($pids)',
  'if ($handles.Count -eq 0) { Write-Output ("NOWINDOW," + ($pids -join " ")); exit 1 }',
  '# WHICH WINDOW. Not "the biggest": a second top-level Chrome_WidgetWin_1',
  '# appears in this process tree part-way through a sweep, and picking by area',
  '# silently switched to it at 1440 -- every size from there on was measured on',
  '# a window that was never resized, and reported the 1024 viewport three more',
  '# times. The caller knows the size the renderer says its window currently is',
  '# (outerWidth x devicePixelRatio), so the match is against THAT.',
  '# THE LOOP VARIABLE IS NOT $h. PowerShell variable names are case-insensitive,',
  '# so `foreach ($h in $handles)` assigns to the SAME variable as the -H',
  '# parameter, and every SetWindowPos below was then called with a window',
  '# handle as its height. That is not a hypothetical: it produced a window',
  '# 65535 physical pixels tall on every attempt, and the calibration loop',
  '# faithfully reported the viewport of it.',
  '$best = [IntPtr]::Zero; $bestScore = [double]::MaxValue',
  'foreach ($candidate in $handles) {',
  '  $rr = New-Object SweepWin32+RECT',
  '  [void][SweepWin32]::GetWindowRect($candidate, [ref]$rr)',
  '  $cw = $rr.R - $rr.L; $ch = $rr.B - $rr.T',
  '  if ($MatchW -gt 0) { $score = [Math]::Abs($cw - $MatchW) + [Math]::Abs($ch - $MatchH) }',
  '  else { $score = -($cw * $ch) }',
  '  if ($score -lt $bestScore) { $bestScore = $score; $best = $candidate }',
  '}',
  '# SHOW IT FIRST. Node spawns every child in this repo with windowsHide (no',
  '# console flash), and on Windows that flag is STARTF_USESHOWWINDOW+SW_HIDE,',
  '# which the app window inherits: it is created, it renders, the debugger and',
  '# screenshots all work -- and it is not on the glass. A hidden window also',
  '# reports a garbage height (65535px was measured here) and ignores the height',
  '# passed to SetWindowPos, so every "at 1280x800" claim made without this line',
  '# would have been made about a window 65535 pixels tall.',
  '# SW_SHOWNOACTIVATE(4): visible, without stealing the focus of whoever is at',
  '# the keyboard while this runs.',
  'if (-not [SweepWin32]::IsWindowVisible($best)) { [void][SweepWin32]::ShowWindow($best, 4); Start-Sleep -Milliseconds 200 }',
  '# SWP_NOMOVE(0x2) | SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10).',
  '# THE WINDOW IS NEVER MOVED, and that is a measurement, not a preference.',
  '# The two panels on this machine run at 137.5% while the system DPI is 125%,',
  '# so a window dragged from one to the other crosses a DPI boundary; doing it',
  '# from a DPI-unaware caller made Chromium answer WM_DPICHANGED with a window',
  '# 65535 physical pixels tall, and every viewport read afterwards was of that.',
  '# Sizing in place keeps one DPI for the whole sweep. NOT SWP_FRAMECHANGED',
  '# either: `titleBarStyle: hidden` means Chromium draws the frame and answers',
  '# WM_NCCALCSIZE itself.',
  '$b0 = New-Object SweepWin32+RECT',
  '[void][SweepWin32]::GetWindowRect($best, [ref]$b0)',
  '$ok1 = [SweepWin32]::SetWindowPos($best, [IntPtr]::Zero, $X, $Y, $W, $H, 0x16)',
  '$err1 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
  'Start-Sleep -Milliseconds 150',
  '$b1 = New-Object SweepWin32+RECT',
  '[void][SweepWin32]::GetWindowRect($best, [ref]$b1)',
  '# A SECOND NUDGE. The first SetWindowPos after the window has been shown is',
  '# answered while Chromium is still settling its own frame, and the height it',
  '# lands on is not the one asked for. Repeating the identical call once the',
  '# frame is settled is what actually takes.',
  '$ok2 = [SweepWin32]::SetWindowPos($best, [IntPtr]::Zero, $X, $Y, $W, $H, 0x16)',
  'Start-Sleep -Milliseconds 150',
  '$r = New-Object SweepWin32+RECT',
  '[void][SweepWin32]::GetWindowRect($best, [ref]$r)',
  '$vis = [SweepWin32]::IsWindowVisible($best)',
  'Write-Output ("OK,{0},{1},{2},{3},{4},{5}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), $vis, $handles.Count)',
  'Write-Output ("TRACE,bound={7}x{8},before={0}x{1},after1={2}x{3},ok1={4},dpi={5},ok2={6}" -f ($b0.R-$b0.L), ($b0.B-$b0.T), ($b1.R-$b1.L), ($b1.B-$b1.T), $ok1, [SweepWin32]::GetDpiForWindow($best), $ok2, $W, $H)',
].join('\n')

async function openApp(appRoot, scratch, say) {
  const executable = appExecutable(appRoot)
  const profile = path.join(scratch, 'profile')
  for (const leaf of ['userdata', 'local', 'home', 'appdata']) mkdirSync(path.join(profile, leaf), { recursive: true })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.MC_SMOKE_HEADLESS
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.APPDATA = path.join(profile, 'appdata')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  environment.PATH = systemOnlyPath()
  environment.Path = environment.PATH

  const userData = path.join(profile, 'userdata')
  /* The OS display scale is a LAUNCH switch, not something set later: Chromium
     fixes the device scale factor when the window is created, so it belongs
     here beside the user-data-dir and not in a per-size step. At 1 the flag is
     omitted entirely, so a default run spawns exactly the argv it always did. */
  const scaleArgs = OS_SCALE === 1 ? [] : [`--force-device-scale-factor=${OS_SCALE}`]
  const child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0', ...scaleArgs],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { noise.push(chunk); while (noise.length > 400) noise.shift() })
  }
  child.on('error', error => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData, say)
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

  const call = async (method, params = {}) => {
    const reply = await session.send(method, params)
    if (reply?.error) throw new Error(`${method}: ${reply.error.message}`)
    return reply?.result
  }
  const evaluate = async expression => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply?.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || 'evaluate failed')
    return reply?.result?.value
  }
  const shoot = async name => {
    if (!SHOOT) return ''
    try {
      const reply = await call('Page.captureScreenshot', { format: 'png' })
      if (!reply?.data) return ''
      mkdirSync(SHOOT, { recursive: true })
      const file = path.join(SHOOT, `${name}.png`)
      writeFileSync(file, Buffer.from(reply.data, 'base64'))
      return file
    } catch (error) { return `screenshot failed: ${error.message}` }
  }
  const until = async (what, expression, tries = 80) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try { if (await evaluate(expression)) return true } catch { /* mid-navigation */ }
      await delay(250)
    }
    say(`gave up waiting for ${what}`)
    return false
  }
  const clickVisible = async selector => evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return 'absent'
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return 'not-visible'
    if (style.visibility === 'hidden' || style.display === 'none') return 'not-visible'
    node.click()
    return 'clicked'
  })()`)
  const clickLastVisible = async selector => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    if (!nodes.length) return 'absent'
    nodes[nodes.length - 1].click()
    return 'clicked'
  })()`)

  return { call, evaluate, until, clickVisible, clickLastVisible, shoot, teardown, noise, child }
}

/* ---------------------------------------------------------------- the probe */

const MEASURE = `(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim()
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const stage = document.getElementById('stage')
  const views = [...document.querySelectorAll('#stage > .view')]
  /* The OUTGOING view lingers on the stage for the length of the crossfade and
     is still laid out while it fades. Measuring it attributes the previous
     route's overflow to this one. */
  const view = views.find(node => !node.classList.contains('exit')) || views[0] || null
  const pad = view ? view.querySelector('.view-pad') : null

  const shown = node => {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number(style.opacity) === 0) return false
    const box = node.getBoundingClientRect()
    return box.width > 0.5 && box.height > 0.5
  }
  const describe = node => {
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (cls ? '.' + cls : '')
  }
  const boxOf = node => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const scrollsX = node => {
    const style = getComputedStyle(node)
    return /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
  }
  /* DELIBERATELY INVISIBLE, AND NOT A DEFECT. The visually-hidden recipe is a
     1x1 box with its content clipped away, which is exactly the shape of
     "content cut off with no way to reach it" — and the content is reaching a
     screen reader perfectly well. Recognised by the recipe rather than by class
     name so a differently named one is still understood. */
  const visuallyHidden = (node, style, box) => {
    if (box.width <= 1.5 && box.height <= 1.5) return true
    if (style.clipPath && style.clipPath !== 'none' && /inset\\(\\s*(50%|100%)/.test(style.clipPath)) return true
    if (style.clip && style.clip !== 'auto' && /rect\\(\\s*0/.test(style.clip)) return true
    return false
  }
  /* PAINTS SOMETHING OF ITS OWN: a background, an image, a border or a shadow.
     An element that paints nothing and contains nothing is a hole; an element
     that paints a rule, a bar or a gradient is a graphic, and calling it an
     empty region is how a decorative divider gets "fixed" into a defect. */
  const paintsSomething = style => {
    if (style.backgroundImage && style.backgroundImage !== 'none') return true
    if (style.boxShadow && style.boxShadow !== 'none') return true
    const bg = style.backgroundColor || ''
    if (bg && bg !== 'transparent' && !/rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\)/.test(bg)) return true
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(style['border' + side + 'Width']) > 0 && style['border' + side + 'Style'] !== 'none') return true
    }
    return false
  }

  /* Only the surfaces a person is looking at. The settings drawer is
     display:block and parked off-screen when closed, so scanning all of body
     reports its entire contents as "past the right edge" on every route. */
  const openDrawer = document.querySelector('#drawer.open')
  const roots = [document.querySelector('header.topbar'), view, openDrawer].filter(Boolean)
  const nodes = []
  for (const root of roots) {
    nodes.push(root)
    for (const node of root.querySelectorAll('*')) nodes.push(node)
  }

  /* WHICH DESCENDANT DEFINES THE OVERFLOW. "This box has 1087px of hidden
     content" is not yet a finding: the answer is different if the culprit is a
     paragraph a person wanted to read or a deliberately parked, invisible
     staging area. So the element whose edge reaches furthest past the box is
     named, along with whether a person could see it at all. */
  const whatOverflows = (node, axis) => {
    if (!node) return null
    const box = node.getBoundingClientRect()
    const edge = axis === 'y' ? box.top + node.clientHeight : box.left + node.clientWidth
    let worst = null
    for (const child of node.querySelectorAll('*')) {
      const r = child.getBoundingClientRect()
      const reach = axis === 'y' ? r.bottom : r.right
      if (reach <= edge + 1) continue
      /* STOP AT THE FIRST BOX THAT ALREADY CLIPS OR SCROLLS. A descendant deep
         inside a scroll container does not make THIS box overflow -- the
         container absorbs it -- and blaming it names the bottom row of a table
         a person can scroll to perfectly well. Without this the metrics page
         reported its own last table cell, 2017px below the fold of a pane that
         scrolls, as the thing being cut off. */
      /* A SCROLL BOX ONLY CLIPS WHAT IT IS THE CONTAINING BLOCK OF.
         An in-flow child is absorbed by the first ancestor that clips or
         scrolls. An ABSOLUTELY positioned child is not: it is laid out against
         its containing block -- the nearest ancestor that is positioned, or
         transformed, or filtered -- and scroll boxes BELOW that point do not
         clip it at all. A fixed child answers to the viewport and nothing
         absorbs it.
         Getting this wrong in the obvious direction reported the agent
         surface's .agentv-panels (absolute, inside a position:relative
         wrap, inside the scrolling .view-pad) as 1019px of unreachable text
         at 1024 -- a severe defect that does not exist, because the wrap IS its
         containing block and the pad scrolls the pair of them together. */
      let absorbed = false
      const childPosition = getComputedStyle(child).position
      let pastContainingBlock = childPosition !== 'absolute'
      for (let parent = child.parentElement; parent && parent !== node; parent = parent.parentElement) {
        if (childPosition === 'fixed') break
        const ps = getComputedStyle(parent)
        if (ps.position !== 'static' || ps.transform !== 'none' || ps.filter !== 'none') pastContainingBlock = true
        const clips = (axis === 'y' ? ps.overflowY : ps.overflowX) !== 'visible'
        if (clips && pastContainingBlock) { absorbed = true; break }
      }
      if (absorbed) continue
      if (!worst || reach > worst.reach) {
        const cs = getComputedStyle(child)
        worst = {
          at: describe(child),
          reach: Math.round(reach),
          past: Math.round(reach - edge),
          position: cs.position,
          visibility: cs.visibility,
          display: cs.display,
          onGlass: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0
            && r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw,
          /* See the DECORATIVE BLEED note below: the author's own declaration
             that this element carries nothing a person is meant to receive. It
             travels on the CULPRIT rather than on the clipping box, because the
             box doing the clipping is an ordinary container -- div.view -- and
             what is spilling out of it is the thing that knows what it is. */
          decorative: child.closest('[aria-hidden="true"]') !== null,
          text: norm(child.textContent).slice(0, 70),
        }
      }
    }
    return worst
  }

  /* IS A GLYPH ACTUALLY LOST? A box is not what a person reads. The fleet
     graph's node labels are a centred sheet with 4px of padding on each side
     and the same background as the panel behind them, so the label BOX reaches
     6px past the panel edge at 1024 while every letter of "gem-lane-2" sits
     comfortably inside. Reporting that as "content is cut off" is a false
     alarm that costs a real layout change to silence.
     Measured with Range rectangles over the text nodes -- the glyph boxes
     themselves -- plus images and canvases, which are also ink. */
  const inkPast = (node, axis) => {
    const box = node.getBoundingClientRect()
    const edge = axis === 'y' ? box.top + node.clientHeight : box.left + node.clientWidth
    let worst = 0
    let where = ''
    const consider = (rect, what) => {
      if (rect.width <= 0 && rect.height <= 0) return
      const reach = axis === 'y' ? rect.bottom : rect.right
      if (reach - edge > worst) { worst = Math.round(reach - edge); where = what }
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!norm(text.nodeValue)) continue
      const owner = text.parentElement
      if (!owner) continue
      const cs = getComputedStyle(owner)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      range.selectNodeContents(text)
      for (const rect of range.getClientRects()) consider(rect, norm(text.nodeValue).slice(0, 40))
    }
    for (const drawn of node.querySelectorAll('img, canvas, svg, video')) {
      const cs = getComputedStyle(drawn)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      consider(drawn.getBoundingClientRect(), describe(drawn))
    }
    return { past: worst, what: where }
  }

  const clipped = []
  const boxOnly = []
  const ellipsised = []
  const pastEdge = []
  const scrollers = []
  const empties = []
  const blankPainted = []
  const seenEmpty = new Set()
  let contentRight = 0
  let contentBottom = 0

  for (const node of nodes) {
    if (!shown(node)) continue
    const style = getComputedStyle(node)
    const box = node.getBoundingClientRect()
    /* SVG elements report a LOWERCASE tagName ('svg', 'path', 'g'); HTML
       elements report uppercase. Comparing the raw value against an uppercase
       list therefore misses every graphic in the product, and the first run of
       this harness duly reported home's uptime ring — a 520x520 SVG — as an
       empty region 520px square. */
    const tag = node.tagName.toUpperCase()
    if (visuallyHidden(node, style, box)) continue

    /* --- DECORATIVE BLEED IS NOT CUT-OFF CONTENT ---
     *
     * MEASURED: canvas.cres-gl, the corona behind the home ring, is about 3.4x
     * the ring's radius by owner-reviewed constants (src/crescent-mount.js), it
     * is aria-hidden="true" with pointer-events: none, and .view's
     * overflow: hidden clips it against a box flush with the window edge. A
     * person sees a clean ring with a faded glow: no scrollbar, nothing
     * reachable lost, nothing to read cut in half. This sweep reported it as
     * content cut off with no way to reach it, at every window size, because its
     * rule is "clipped, and no SCROLLABLE ancestor" and an overflow: hidden
     * ancestor is never an exemption -- correctly, for real content.
     *
     * aria-hidden="true" is the narrow exemption, and it is narrow on purpose:
     * it is the author's own declaration that the element carries nothing a
     * person is meant to receive, and it is the same declaration a screen reader
     * acts on. An element with words in it that somebody is supposed to read
     * cannot carry that attribute without already being a defect of its own. The
     * exemption is not extended to overflow: hidden ancestors in general, which
     * would excuse every genuinely clipped thing on every screen. */
    const decorativeOnly = node.closest('[aria-hidden="true"]') !== null


    /* --- wide content that CAN be scrolled: the passing case --- */
    if (scrollsX(node)) {
      scrollers.push({ at: describe(node), box: boxOf(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })
    }

    /* --- content cut off with no way to reach it --- */
    const hiddenX = /(hidden|clip)/.test(style.overflowX)
    const hiddenY = /(hidden|clip)/.test(style.overflowY)
    const overX = node.scrollWidth - node.clientWidth
    const overY = node.scrollHeight - node.clientHeight
    const classify = (axis, by) => {
      const culprit = whatOverflows(node, axis)
      const ink = inkPast(node, axis)
      const record = { at: describe(node), box: boxOf(node), by, axis, culprit, ink, text: norm(node.textContent).slice(0, 90) }
      if (axis === 'x' && style.textOverflow === 'ellipsis') { ellipsised.push(record); return }
      /* See the note on decorativeOnly above: a glow the author marked as carrying
         nothing to receive, clipped by a box flush with the window, is not
         content a person cannot reach. Reported, never counted. */
      if (decorativeOnly || (culprit && culprit.decorative)) {
        blankPainted.push({ ...record, why: 'decorative bleed the author marked aria-hidden' })
        return
      }
      /* CLIPPED CONTENT NOBODY COULD SEE ANYWAY. A box can overflow because of
         a descendant that is display:none-adjacent -- visibility:hidden, parked
         off-screen, zero-opacity -- and clipping THAT hides nothing from
         anybody. Reported as a note rather than a defect, with the culprit
         named so the reader can check the judgement. */
      if (culprit && !culprit.onGlass) { blankPainted.push({ ...record, why: 'overflow by an element nobody can see' }); return }
      /* The box reaches past the clip but no glyph, image or canvas does:
         padding and background, and nothing a person reads. Also a note. */
      if (ink.past <= 1) { boxOnly.push(record); return }
      clipped.push(record)
    }
    if (hiddenX && overX > 2 && node.clientWidth > 0) classify('x', overX)
    /* A hidden vertical overflow of only a few px is a rounding artefact of a
       fractional line box, not a cut-off line. */
    if (hiddenY && overY > 6 && node.clientHeight > 0) classify('y', overY)

    /* --- past the right edge of the window with nothing able to scroll to it --- */
    if (box.right > vw + 2 || box.left < -2) {
      /* ACTUALLY scrollable, not merely declared overflow-x auto. Every view in
         this product sits inside .view-pad, which declares overflow-y auto and
         therefore COMPUTES overflow-x auto -- so a test for the declaration
         excuses every element on every screen and this check can never fire. A
         container only reaches its content if it really does overflow. */
      let scrollableAncestor = null
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (scrollsX(parent)) { scrollableAncestor = describe(parent); break }
      }
      if (!scrollableAncestor && !decorativeOnly) {
        pastEdge.push({ at: describe(node), box: boxOf(node), right: Math.round(box.right), left: Math.round(box.left), vw, text: norm(node.textContent).slice(0, 90) })
      }
    }

    /* --- the rightmost / lowest thing with words in it --- */
    const own = norm([...node.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' '))
    if (own) {
      contentRight = Math.max(contentRight, Math.min(box.right, vw))
      contentBottom = Math.max(contentBottom, Math.min(box.bottom, vh))
    }

    /* --- a large box with nothing in it --- */
    const area = box.width * box.height
    if (area >= 24000 && tag !== 'BODY' && tag !== 'HTML') {
      const hasText = norm(node.innerText || node.textContent).length > 0
      const hasMedia = node.querySelector('svg, canvas, img, video, input, select, textarea, button, [role="img"]') !== null
      const isMedia = /^(SVG|CANVAS|IMG|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON|PATH|G|CIRCLE|RECT|LINE|POLYLINE|POLYGON|USE|DEFS)$/.test(tag)
      if (!hasText && !hasMedia && !isMedia) {
        /* Outermost only: an empty wrapper five levels deep reports as five
           holes, which is one hole described five times. */
        let nested = false
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (seenEmpty.has(parent)) { nested = true; break }
        }
        if (!nested) {
          seenEmpty.add(node)
          const record = { at: describe(node), box: boxOf(node), area: Math.round(area) }
          if (paintsSomething(style)) blankPainted.push(record)
          else empties.push(record)
        }
      }
    }
  }

  const overflowOf = node => node ? {
    at: describe(node),
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    overflowX: getComputedStyle(node).overflowX,
    overflowY: getComputedStyle(node).overflowY,
    overflowingX: node.scrollWidth > node.clientWidth + 1 ? whatOverflows(node, 'x') : null,
    overflowingY: node.scrollHeight > node.clientHeight + 1 ? whatOverflows(node, 'y') : null,
  } : null

  /* The shell around the pages: everything body lays out, with its box. A 36px
     strip nobody accounted for shows up here and nowhere else. */
  const shell = [...document.body.children].map(node => {
    const cs = getComputedStyle(node)
    return { at: describe(node), box: boxOf(node), position: cs.position, display: cs.display, visibility: cs.visibility }
  })

  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    viewport: { w: vw, h: vh, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio },
    doc: overflowOf(document.documentElement),
    body: overflowOf(document.body),
    stage: overflowOf(stage),
    view: overflowOf(view),
    pad: overflowOf(pad),
    shell,
    clipped, boxOnly, ellipsised, pastEdge, scrollers, empties, blankPainted,
    deadRight: Math.round(vw - contentRight),
    deadBottom: Math.round(vh - contentBottom),
    textLength: norm(stage ? stage.innerText : '').length,
    nodesScanned: nodes.length,
  }
})()`

/* ------------------------------------------------------------------ setup */

async function walkSetup(app, note) {
  const onSetup = await app.until('the permission question', `location.hash === '#/setup'`)
  if (!onSetup) { note('the first-run question did not open; measuring the app as it opened'); return false }
  await app.clickVisible('[data-setup-continue]')
  await app.until('the folder question', `document.querySelector('[data-setup-section]')?.innerText.includes('Which folder')`)
  await app.until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
  await app.clickLastVisible('[data-setup-next]')
  await app.until('the identity question',
    `document.querySelector('[data-setup-section]')?.innerText.includes('Who is using this copy') || document.querySelector('[data-setup-section]')?.innerText.includes('Signed in as')`)
  await app.clickLastVisible('[data-setup-next]')
  await app.until('the autonomy question', `document.querySelector('[data-setup-section]')?.innerText.includes('without asking')`)
  await app.clickVisible('[data-setup-set="autonomy"][data-setup-value="assisted"]')
  await app.clickVisible('[data-setup-next="review"]')
  /* 40s, not 20s. Three lanes run their own copy of this application on this
     machine at once and the review step waits on a Codex probe; at 20s this
     stopped reaching the app about one run in three, and a sweep that measures
     the setup screen five times is not a sweep of the product. */
  await app.until('the review', `document.querySelector('[data-setup-section]')?.innerText.includes('what those answers set')`, 160)
  await app.until('the Codex check to settle',
    `!document.querySelector('[data-setup-section]')?.innerText.includes('Checking whether Codex')`, 160)
  await app.clickVisible('[data-setup-next="finish"]')
  if (await app.until('the app', `location.hash === '#/' || location.hash === ''`, 40)) return true
  /* NUDGE, DON'T GIVE UP. The review step waits on a probe of the machine's
     Codex install, and with three other lanes running their own copy of this
     app the probe is sometimes still out when the step's budget expires --
     measured: roughly one run in two on a loaded machine. Pressing whatever
     forward control is on screen, a few times, with a wait between, gets past
     it; a sweep that silently measured the setup screen five times instead of
     the product is the failure this exists to prevent. */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    note(`still on setup; pressing the forward control again (attempt ${attempt + 1})`)
    await app.clickVisible('[data-setup-next="finish"]')
    await delay(1500)
    if (await app.evaluate(`location.hash === '#/' || location.hash === ''`)) return true
    await app.clickLastVisible('[data-setup-next]')
    await delay(1500)
    if (await app.evaluate(`location.hash === '#/' || location.hash === ''`)) return true
    await app.clickVisible('[data-setup-continue]')
    await delay(2500)
    if (await app.evaluate(`location.hash === '#/' || location.hash === ''`)) return true
  }
  return false
}

/* Fill the screens, by pressing the controls that fill them. */
const DEMONSTRATION_VIEWS = ['home', 'computers', 'agent', 'metrics', 'comms', 'ledger']

async function turnOnTheDemonstration(app, check, note) {
  if (await app.clickVisible('#open-settings') !== 'clicked') { check('the settings gear opens the drawer', false); return false }
  await app.until('the drawer', `document.querySelector('#drawer.open') !== null`, 20)
  if (await app.clickVisible('.drawer-all') !== 'clicked') { check('the drawer offers the settings page', false); return false }
  const onSettings = await app.until('the settings page', `(document.body.dataset.route || '') === 'settings'`, 40)
  check('the settings page opens from the drawer', onSettings)
  if (!onSettings) return false
  await delay(1200)
  const flipped = []
  for (const view of DEMONSTRATION_VIEWS) {
    const result = await app.evaluate(`(() => {
      const row = document.querySelector('[data-setting-id="live_${view}"]')
      if (!row) return 'absent'
      const box = row.querySelector('input[type="checkbox"]')
      if (!box) return 'no-control'
      if (!box.checked) return 'already-demonstration'
      box.click()
      return box.checked ? 'refused' : 'flipped'
    })()`)
    flipped.push(`${view}=${result}`)
    await delay(250)
  }
  note(`demonstration data: ${flipped.join(' ')}`)
  check('every page can be switched to the demonstration from its own control',
    flipped.every(entry => /flipped|already-demonstration/.test(entry)), flipped.join(' '))
  /* Back to home the way a person gets there: the ring closes. */
  for (let step = 0; step < 12; step += 1) {
    if (await app.evaluate(`(document.body.dataset.route || 'home') === 'home'`)) break
    if (await app.clickVisible('#nav-next') !== 'clicked') break
    await delay(600)
  }
  await delay(1500)
  return true
}

/* ------------------------------------------------------- the resize itself */

/**
 * Make the web contents exactly `size` CSS pixels wide and tall, by resizing
 * the real window, and say what was actually achieved.
 *
 * CALIBRATED RATHER THAN ASSUMED, for two reasons that are both real on this
 * machine and neither of which is a constant this file could hard-code:
 *   * the frame. `titleBarStyle: 'hidden'` still leaves a border, so the web
 *     contents is the window minus an amount only the OS knows.
 *   * the scale. `SetWindowPos` speaks the coordinate space of the process
 *     calling it; the app is per-monitor DPI aware and PowerShell is not, so
 *     on a scaled display one unit there is not one CSS pixel here.
 * Both are absorbed by fitting a straight line — measure, correct, measure —
 * and the fit is CARRIED ACROSS SIZES, so only the first size pays for it.
 */
function makeResizer(helper, ownerPid, appRoot, display, note) {
  /* The frame: how many PHYSICAL pixels the window is wider and taller than
     its web contents. Learned on the first size and reused, because it is a
     property of the window, not of the size. */
  const frame = { w: null, h: null }
  const setWindow = (x, y, w, h, match) => {
    let out = ''
    try {
      out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helper, '-OwnerPid', String(ownerPid), '-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h),
        '-MatchW', String(match?.w || 0), '-MatchH', String(match?.h || 0), '-ExeRoot', appRoot],
        { encoding: 'utf8', windowsHide: true }).trim()
    } catch (error) {
      const said = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
      throw new HarnessError(`the window could not be resized: ${said || error.message}`)
    }
    if (!out.startsWith('OK')) throw new HarnessError(`could not find the app window to resize it (${out})`)
    const lines = out.split('\n').map(line => line.trim())
    const trace = lines.find(line => line.startsWith('TRACE'))
    if (trace) note(`    ${trace}`)
    const parts = lines[0].split(',')
    return {
      left: Number(parts[1]), top: Number(parts[2]), width: Number(parts[3]), height: Number(parts[4]),
      visible: parts[5], frames: Number(parts[6]),
    }
  }

  return async function resizeTo(app, size) {
    /* Ignored by the helper (SWP_NOMOVE), kept so the call site reads honestly
       and so a future run on a single-DPI machine can put the move back. */
    const originX = display ? display.x + 4 : 40
    const originY = display ? display.y + 4 : 40
    /* THE SCALE IS NOT ESTIMATED, IT IS READ. One CSS pixel is exactly
       `devicePixelRatio` physical pixels, and after the helper declares DPI
       awareness the numbers it passes to SetWindowPos ARE physical pixels. So
       the only unknown is the frame, and one measurement settles it. */
    const dpr = (await app.evaluate('window.devicePixelRatio')) || 1
    let requestW = Math.round(size.width * dpr) + (frame.w ?? Math.round(14 * dpr))
    let requestH = Math.round(size.height * dpr) + (frame.h ?? Math.round(8 * dpr))
    let previous = null
    let placed = null
    let inner = null
    let best = null
    /* WHICH WINDOW TO RESIZE, told from inside it. */
    const whereItIsNow = async () => {
      const now = await app.evaluate('({ w: outerWidth, h: outerHeight, dpr: devicePixelRatio })')
      return { w: Math.round(now.w * now.dpr), h: Math.round(now.h * now.dpr) }
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      placed = setWindow(originX, originY, requestW, requestH, await whereItIsNow())
      await delay(500)
      inner = await app.evaluate('({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, ow: window.outerWidth, oh: window.outerHeight, sx: window.screenX, sy: window.screenY, availH: screen.availHeight, availW: screen.availWidth })')
      const offW = size.width - inner.w
      const offH = size.height - inner.h
      const error = Math.abs(offW) + Math.abs(offH)
      note(`    resize attempt ${attempt + 1}: asked ${requestW}x${requestH} -> window ${placed.width}x${placed.height}, contents ${inner.w}x${inner.h}, outer ${inner.ow}x${inner.oh} at ${inner.sx},${inner.sy}, avail ${inner.availW}x${inner.availH} (off by ${offW},${offH})`)
      if (!best || error < best.error) best = { requestW, requestH, inner, placed, error }
      /* The frame, learned from whatever the window actually became. */
      frame.w = placed.width - Math.round(inner.w * dpr)
      frame.h = placed.height - Math.round(inner.h * dpr)
      if (Math.abs(offW) <= 1 && Math.abs(offH) <= 1) break
      /* THE WINDOW REFUSED TO MOVE. Windows enforces the app's own minimum
         track size (this one declares 980x640 CSS px), and no number of
         retries will get under it — so say so once and stop, rather than
         spending eight attempts discovering it again. */
      if (previous && previous.placed.width === placed.width && previous.placed.height === placed.height
        && previous.requestW !== requestW) {
        note('    the window would not take that size; the app declares a minimum and Windows is enforcing it')
        break
      }
      previous = { requestW, requestH, inner, placed }
      requestW = Math.max(64, Math.round(requestW + offW * dpr))
      requestH = Math.max(64, Math.round(requestH + offH * dpr))
    }
    /* If no attempt landed on the target, leave the window at the CLOSEST one
       rather than at the last (worst) guess, and say so. */
    const finalOff = Math.abs(size.width - inner.w) + Math.abs(size.height - inner.h)
    if (best && finalOff > best.error) {
      placed = setWindow(originX, originY, best.requestW, best.requestH, await whereItIsNow())
      await delay(500)
      inner = await app.evaluate('({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })')
      note(`    could not hit ${size.width}x${size.height} exactly; settled on the closest reachable ${inner.w}x${inner.h}`)
    }
    note(`asked for ${size.width}x${size.height} of web contents; window rect ${placed.width}x${placed.height} at ${placed.left},${placed.top} (visible=${placed.visible}, ${placed.frames} top-level frame(s)); innerWidth=${inner.w} innerHeight=${inner.h} dpr=${inner.dpr}`)
    /* Layout settles asynchronously: ResizeObserver-driven charts and the fleet
       graph re-lay out a frame or two after the resize event. */
    await delay(1400)
    return { asked: size, inner, windowRect: placed }
  }
}

/* --------------------------------------------------------------- the walk */

async function main() {
  auditSelf()
  const scratch = mkdtempSync(path.join(tmpdir(), 'win-sweep-'))
  const checks = []
  const check = (what, ok, detail = '') => {
    checks.push({ name: what, ok: Boolean(ok), detail })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)
  const transcript = { label: LABEL, at: new Date().toISOString(), sizes: [] }
  let app = null

  try {
    const display = widestDisplay()
    note(display ? `widest working area: ${display.w}x${display.h} at ${display.x},${display.y}` : 'could not enumerate displays; using the window where it opens')
    for (const size of SIZES) {
      if (display && (size.width > display.w || size.height > display.h)) {
        note(`WARNING: ${size.width}x${size.height} is larger than the widest working area; the OS may clamp it and the realized innerWidth is what this run reports`)
      }
    }
    const appRoot = await stage(scratch)
    note(`staged a copy at ${appRoot}`)
    app = await openApp(appRoot, scratch, note)
    const helper = path.join(scratch, 'set-window-size.ps1')
    writeFileSync(helper, PS_RESIZE, 'ascii')
    const resizeTo = makeResizer(helper, app.child.pid, appRoot, display, note)

    const finished = await walkSetup(app, note)
    check('setup completes and lands in the app', finished !== false, `hash=${await app.evaluate('location.hash')}`)
    note(`the window as the app opened it: ${JSON.stringify(await app.evaluate('({ inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], at: [screenX, screenY], dpr: devicePixelRatio })'))}`)
    transcript.demonstration = DEMONSTRATION
    if (DEMONSTRATION) await turnOnTheDemonstration(app, check, note)
    await delay(1500)

    for (const size of CASES) {
      console.log(`\n== ${size.width}x${size.height} @ os ${size.osScale} text ${size.textSize} ==`)
      const geometry = await resizeTo(app, { ...size, width: size.cssWidth, height: Math.round(size.height / size.osScale) })
      const realizedWidth = geometry.inner.w
      /* At a raised OS scale the window is opened at the panel width but the
         layout is handed width/scale CSS pixels, so the expectation is the
         CSS width, not the panel width. Reported either way so the number a
         reader sees is the number the layout actually got. */
      check(`${size.tag}: the window really is ${size.cssWidth} CSS px wide`, Math.abs(realizedWidth - size.cssWidth) <= 2,
        `innerWidth=${realizedWidth} panel=${size.width} osScale=${size.osScale}`)

      /* THE TEXT SIZE IS SET THROUGH THE SETTING THE CONTROL WRITES, and then
         read back. Setting it without confirming it landed is how a run
         measures default text while claiming to measure large. */
      await app.clickVisible('#open-settings')
      await app.clickVisible(`#text-seg button[data-text="${size.textSize}"]`)
      const applied = await app.evaluate(`({ body: parseFloat(document.body.style.zoom) || 1,
        root: parseFloat(document.documentElement.style.getPropertyValue('--zoom')) || 1,
        saved: Number(localStorage.getItem('mc.text')) })`)
      check(`${size.tag}: the requested text size is applied by its real control`,
        applied.body === size.textSize && applied.root === size.textSize && applied.saved === size.textSize,
        JSON.stringify(applied))
      await app.clickVisible('#close-settings')
      await delay(400)

      const sizeRecord = { size, geometry, routes: [] }
      /* CAN A PERSON REACH IT? A box with `overflow: hidden` is scrollable from
         JavaScript and NOT from a wheel, a trackpad or a scrollbar, so
         "scrollHeight exceeds clientHeight" does not by itself settle whether
         the content at the bottom is lost. This turns the question into the
         one a customer would ask: spin the wheel over the middle of the window
         and see whether the furthest text moves up. Real
         Input.dispatchMouseEvent wheels, not element.scrollTop. */
      const wheelReach = async () => {
        const before = await app.evaluate(`(() => {
          const view = document.querySelector('#stage > .view:not(.exit)')
          if (!view) return null
          const box = view.getBoundingClientRect()
          let lowest = -1e9, what = ''
          const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT)
          const range = document.createRange()
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            if (!String(t.nodeValue || '').trim()) continue
            const owner = t.parentElement
            if (!owner) continue
            const cs = getComputedStyle(owner)
            if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
            range.selectNodeContents(t)
            for (const r of range.getClientRects()) {
              if (r.bottom > lowest) { lowest = r.bottom; what = String(t.nodeValue).replace(/\\s+/g, ' ').trim().slice(0, 50) }
            }
          }
          return { lowest: Math.round(lowest), what, viewBottom: Math.round(box.top + view.clientHeight) }
        })()`)
        if (!before) return null
        for (let spin = 0; spin < 12; spin += 1) {
          await app.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: Math.round(size.width / 2), y: Math.round(size.height / 2),
            deltaX: 0, deltaY: 400, pointerType: 'mouse',
          })
          await delay(90)
        }
        await delay(500)
        const after = await app.evaluate(`(() => {
          const view = document.querySelector('#stage > .view:not(.exit)')
          if (!view) return null
          let lowest = -1e9
          const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT)
          const range = document.createRange()
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            if (!String(t.nodeValue || '').trim()) continue
            const owner = t.parentElement
            if (!owner) continue
            const cs = getComputedStyle(owner)
            if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
            range.selectNodeContents(t)
            for (const r of range.getClientRects()) if (r.bottom > lowest) lowest = r.bottom
          }
          return { lowest: Math.round(lowest), viewBottom: Math.round(view.getBoundingClientRect().top + view.clientHeight) }
        })()`)
        return { before, after, moved: after ? before.lowest - after.lowest : 0 }
      }

      const visit = async (name, index) => {
        await app.until('the previous view to leave', `document.querySelectorAll('#stage > .view').length === 1`, 16)
        await delay(900)
        const m = await app.evaluate(MEASURE)
        const shot = await app.shoot(`${LABEL}-${size.tag}-${String(index).padStart(2, '0')}-${name}`)
        const record = { name, shot, ...m }
        sizeRecord.routes.push(record)
        const tag = `${size.width} ${name}`

        const pageScrolls = [
          m.doc && m.doc.scrollWidth > m.doc.clientWidth + 1 ? `document ${m.doc.scrollWidth}>${m.doc.clientWidth}` : '',
          m.body && m.body.scrollWidth > m.body.clientWidth + 1 ? `body ${m.body.scrollWidth}>${m.body.clientWidth}` : '',
          m.stage && m.stage.scrollWidth > m.stage.clientWidth + 1 ? `#stage ${m.stage.scrollWidth}>${m.stage.clientWidth}` : '',
          m.view && m.view.scrollWidth > m.view.clientWidth + 1 ? `.view ${m.view.scrollWidth}>${m.view.clientWidth}` : '',
          m.pad && m.pad.scrollWidth > m.pad.clientWidth + 1 ? `.view-pad ${m.pad.scrollWidth}>${m.pad.clientWidth}` : '',
        ].filter(Boolean)
        check(`[${tag}] the page does not scroll sideways`, pageScrolls.length === 0, pageScrolls.join('; '))
        check(`[${tag}] nothing is cut off with no way to reach it`, m.clipped.length === 0,
          m.clipped.slice(0, 6).map(c => `${c.at} ${c.axis}+${c.by}px @${c.box.x},${c.box.y} ${c.box.w}x${c.box.h} INK ${c.ink.past}px past on "${c.ink.what}"${c.culprit ? ` [box: ${c.culprit.at} ${c.culprit.position}]` : ''}`).join(' | '))
        for (const box of m.boxOnly.slice(0, 4)) {
          note(`    box past its clip but no glyph is: ${box.at} ${box.axis}+${box.by}px [the box is ${box.culprit?.at || '?'}, ink ${box.ink.past}px past]`)
        }
        /* Where something looks cut off, and ALWAYS on the agent surface --
           the one screen this lane repaired, so its reachability is proved
           every run rather than inferred from the absence of a clip. */
        if (m.clipped.some(c => c.axis === 'y') || name === 'agent') {
          const wheel = await wheelReach()
          record.wheel = wheel
          if (wheel) {
            const reached = wheel.after && wheel.after.lowest <= wheel.after.viewBottom + 2
            note(`    wheel test: the lowest text sat ${wheel.before.lowest - wheel.before.viewBottom}px below the fold ("${wheel.before.what}"); after 12 wheel notches it moved ${wheel.moved}px and is now ${wheel.after.lowest - wheel.after.viewBottom}px below it`)
            check(`[${tag}] the content below the fold can be reached with a mouse wheel`, reached || wheel.moved > 20,
              `moved ${wheel.moved}px; still ${wheel.after.lowest - wheel.after.viewBottom}px past the bottom`)
          }
        }
        check(`[${tag}] nothing sits past the edge of the window`, m.pastEdge.length === 0,
          m.pastEdge.slice(0, 6).map(c => `${c.at} left=${c.left} right=${c.right} vw=${c.vw} "${c.text}"`).join(' | '))
        check(`[${tag}] no empty region where content should be`, m.empties.length === 0,
          m.empties.slice(0, 6).map(c => `${c.at} ${c.box.w}x${c.box.h} @${c.box.x},${c.box.y}`).join(' | '))
        check(`[${tag}] the route renders something a person can read`, m.textLength > 40, `${m.textLength} chars`)
        note(`${tag}: ${m.scrollers.length} horizontal scroller(s), ${m.ellipsised.length} ellipsised label(s), ${m.blankPainted.length} painted-but-empty box(es), dead margin right ${m.deadRight}px bottom ${m.deadBottom}px, ${m.nodesScanned} nodes`)
        for (const blank of m.blankPainted.slice(0, 4)) note(`    painted but empty: ${blank.at} ${blank.box.w}x${blank.box.h} @${blank.box.x},${blank.box.y}`)
        for (const scroller of m.scrollers.slice(0, 6)) note(`    scrolls in its own container: ${scroller.at} ${scroller.scrollWidth}>${scroller.clientWidth}`)
        return record
      }

      /* HOME is already mounted; the chevron walks the rest of the ring and
         closes it back on home, which is how a person sees these pages. */
      let index = 0
      await visit(await app.evaluate(`document.body.dataset.route || 'home'`), index += 1)
      for (let step = 0; step < 12; step += 1) {
        const pressed = await app.clickVisible('#nav-next')
        if (pressed !== 'clicked') { check(`[${size.width}] the forward chevron is pressable`, false, String(pressed)); break }
        await delay(700)
        const route = await app.evaluate(`document.body.dataset.route || ''`)
        await visit(route || `step${step}`, index += 1)
        if (route === 'home') break
      }

      /* THE SETTINGS DRAWER, which is a surface in its own right: it covers the
         page, it is the door most people use, and it is the one panel in the
         product with a fixed width. */
      if (await app.clickVisible('#open-settings') === 'clicked') {
        await app.until('the drawer to open', `document.querySelector('#drawer.open') !== null`, 20)
        await delay(700)
        await visit('drawer', index += 1)
        await app.clickVisible('#close-settings')
        await app.until('the drawer to close', `document.querySelector('#drawer.open') === null`, 20)
        await delay(400)
      } else {
        note('the settings gear was not pressable, so the drawer was not measured at this size')
      }

      /* THE AGENT SURFACE. Off the ring (it is a drill-in) and fenced for edits
         this wave, but it is the screen the product exists for, so it is
         MEASURED here and any finding on it is reported rather than repaired.
         Reached the way a stranger with no fleet reaches it: the empty fleet
         graph offers "See an example agent". */
      const toComputers = await app.clickVisible('#nav-next')
      if (toComputers === 'clicked') {
        await delay(900)
        /* The link is rendered only once the fleet projection has resolved and
           the simulator has an agent to show, which is a second or two after
           the view mounts. Clicking on a fixed delay found it at no size at
           all and reported the agent surface as unreachable five times. */
        await app.until('a door into the agent page', `document.querySelector('.graph-empty-action') !== null || document.querySelector('.node') !== null || document.querySelector('.graph-open-btn:not([hidden])') !== null`, 32)
        /* THREE DOORS, because there are three states. With no fleet AND no
           declared organisation the empty graph offers "See an example agent".
           On a fresh install with a declared organisation -- the state every
           packaged copy actually opens in -- the tree is EMPTY BY DESIGN
           (5cc2f09) and the door is `.graph-open-btn`, aimed at the first
           DECLARED seat and visible with NO selection since 18ef5e7 ("The only
           door to the page that starts an agent opened after you had started
           one"). With running agents there are nodes, a node is selected
           first, and the same button opens THAT node. The middle door is the
           one this file did not know: it pressed `.graph-open-btn` only after
           a `.static-tree-node` click succeeded, and on an empty-by-design
           tree that click can never succeed -- so a visible, pressable door
           was reported absent at all five sizes (2026-08-18). */
        const drilled = await app.clickVisible('.graph-empty-action') === 'clicked'
          || await app.clickVisible('.graph-open-btn') === 'clicked'
          || (await app.clickVisible('.static-tree-node') === 'clicked'
            && (await delay(700), await app.clickVisible('.graph-open-btn') === 'clicked'))
        if (drilled) {
          const onAgent = await app.until('the agent surface', `(document.body.dataset.route || '') === 'agent'`, 24)
          check(`[${size.width} agent] pressing the fleet door opens the agent page`, onAgent,
            `route=${await app.evaluate(`document.body.dataset.route || ''`)}`)
          if (onAgent) {
            await delay(1200)
            await visit('agent', index += 1)
          }
        } else {
          /* A NOTE HERE WAS THE WORST THING THIS FILE EVER DID, so it is a check
             now. Measured on 2026-08-13: this printed `..` at all five sizes and
             the run exited 0 with "256/256 checks passed", while the screen the
             product exists for -- the one the owner had independently reported
             as an empty session surface, and the one an earlier revision of this
             sweep measured with ELEVEN checks per size -- was never looked at.
             Fifty-five findings did not go green: they stopped existing, and the
             harness said PASS in their place. A suite that reports a clean sweep
             of a screen it could not open is worse than one that never opened
             it, because the clean sweep is what gets read.

             It is a CHECK rather than a refusal (exit 2) because the fleet page
             offering no way into the agent page is a fact about the PRODUCT and
             not about this instrument: `tools/first-run-contract-qa.mjs` reaches
             the same page down the recommended path and measures the same thing
             from the other side ("the door into the agent page can be pressed --
             zero-size"). The selectors tried are printed so that the next person
             can tell a renamed class from a missing door in one reading, which
             is the distinction this file got wrong twice already. */
          const doors = await app.evaluate(`(() => ${JSON.stringify(DOOR_SELECTORS)}
            .map(selector => selector + '=' + document.querySelectorAll(selector).length)
            .join(' '))()`)
          check(`[${size.width} agent] the fleet page offers a way into the agent page`,
            false, `no door was pressable at this size; in the DOM: ${doors}`)
        }
      } else {
        check(`[${size.width} agent] the fleet page can be opened for the agent drill-in`,
          false, `forward chevron was ${toComputers}`)
      }

      /* BACK TO HOME so the next size starts where this one did. Without this
         the next lap begins wherever the drill-in left off and the first screen
         measured at 1440 is not the first screen measured at 1024. */
      for (let step = 0; step < 12; step += 1) {
        if (await app.evaluate(`(document.body.dataset.route || 'home') === 'home'`)) break
        if (await app.clickVisible('#nav-next') !== 'clicked') break
        await delay(600)
      }
      await delay(600)
      transcript.sizes.push(sizeRecord)
    }
  } catch (error) {
    console.error(`\nNO VERDICT: ${error.message}`)
    if (app) await app.teardown()
    if (JSON_OUT) { mkdirSync(path.dirname(JSON_OUT), { recursive: true }); writeFileSync(JSON_OUT, JSON.stringify(transcript, null, 2)) }
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) } catch { /* held */ } }
    return 2
  } finally {
    if (app) await app.teardown()
  }

  if (JSON_OUT) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true })
    writeFileSync(JSON_OUT, JSON.stringify(transcript, null, 2))
    console.log(`\nwrote the measurement transcript to ${JSON_OUT}`)
  }
  if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) } catch { /* held */ } }
  else console.log(`kept the scratch directory at ${scratch}`)

  const failed = checks.filter(result => !result.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.error(`FAILED (${failed.length}):`)
    for (const result of failed) console.error(`  - ${result.name}${result.detail ? `  — ${result.detail}` : ''}`)
    return 1
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then(code => process.exit(code), error => { console.error(error); process.exit(2) })
}
