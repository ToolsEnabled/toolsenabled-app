#!/usr/bin/env node

// THE PRIMARY FLOW, DRIVEN WITH A KEYBOARD AND NOTHING ELSE.
//
// first run -> setup -> home -> the agent surface, using only Tab,
// Shift+Tab, Enter and Space dispatched as real key events into a real packaged
// window. No element is ever `.click()`ed and no coordinate is ever pressed: if
// a control cannot be reached and fired from the keyboard, this harness cannot
// get past it, which is the only honest way to measure the claim.
//
// WHAT IT MEASURES AT EVERY STOP, and why each one is here rather than asserted
// in a unit test:
//
//   TAB ORDER      the sequence of stops, with each stop's on-screen rectangle,
//                  so "reading order" is a measurement (top-to-bottom,
//                  left-to-right within a row) rather than a claim about the
//                  source. A stop whose rectangle is off-screen or zero-sized is
//                  focus you cannot see -- WCAG 2.2 SC 2.4.11.
//   VISIBLE FOCUS  the computed indicator ON the focused element: outline width
//                  and style, plus box-shadow. Measured after a REAL Tab press,
//                  so :focus-visible has genuinely matched.
//   THE NAME       the accessible name and role read out of Chromium's own
//                  accessibility tree (CDP Accessibility.getPartialAXTree) --
//                  the same tree that is projected to UI Automation, which is
//                  what Narrator reads. This harness does not launch Narrator;
//                  it reads the tree Narrator is given. An empty name there is
//                  a control Narrator announces as "button" and nothing else.
//   HIGH CONTRAST  the same walk with `forced-colors: active` emulated. In
//                  forced-colors mode the UA drops box-shadow entirely (CSS
//                  Color Adjust 1, "forced color adjustment"), so an indicator
//                  built out of box-shadow with `outline: none` beside it is not
//                  dimmed there -- it is gone. The check is therefore specific:
//                  under forced colors, is there an OUTLINE?
//   TEXT SCALING   the product's own text-size control at its largest (1.12) and
//                  a 200%-equivalent viewport (the viewport halved in CSS px is
//                  what 200% browser zoom does to reflow). The check is that the
//                  page does not scroll sideways and that the primary action of
//                  the step is still on screen and still fully rendered.
//
// RUN IT:
//   node tools/a11y-keyboard-qa.mjs                 (the whole flow)
//   node tools/a11y-keyboard-qa.mjs --keep          (leave the scratch profile)
//
// It borrows the Electron binary and the capability payload from an existing
// release/win-unpacked and never writes there; dist/ and shell/ are swapped in
// from this worktree, so it measures the CURRENT source. Build with `npm run
// build` first.
//
// ISOLATION is copied from tools/setup-walkthrough-qa.mjs for the reasons
// documented there: --user-data-dir (Electron resolves userData through the
// Windows known-folder API, not the environment), LOCALAPPDATA (our own
// services root), USERPROFILE (the default workspace Finish creates).
// ELECTRON_RUN_AS_NODE is stripped or the binary runs headless as Node and
// exits 0, which is indistinguishable from a crash.

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import {
  copyPreparedCodexCredential,
  prepareCurrentCodexCredentialStage,
  removeStagedCodexCredential,
} from './lib/a11y-codex-auth.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { createSession } from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory, packagedLauncherName } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* The launcher THIS platform's build writes: `ToolsEnabled.exe` on Windows,
   the `toolsenabled` ELF on Linux. Declared, never typed. */
const APP_EXE = packagedLauncherName()
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
/* THE ENABLED START CONTROL, WITH A SHORT-LIVED COPY IN THE LIVE LANE ONLY.
 *
 * The isolation above redirects USERPROFILE, so os.homedir()/.codex is empty in
 * the scratch profile and shell/agent-host.cjs correctly reports the machine as
 * signed out -- which DISABLES Start, and a disabled button is not in the tab
 * order, so its enabled interaction cannot be measured there. The
 * provider-free run leaves that home empty and never presses Start. A live
 * opt-in may point at the CURRENT user's Codex home; the harness carries only
 * its auth.json into the scratch profile with a kernel copy, never
 * reads its contents, and never places a credential value in this process.
 *
 *   --codex-home <dir>   measure the enabled control
 *   --press-start        also press Enter on it, which starts a REAL session
 *                        (off by default: a keyboard audit must not spawn a
 *                        child process on somebody's machine as a side effect) */
const CODEX_HOME = argument('--codex-home', null)
const PRESS_START = process.argv.includes('--press-start')
/* Product phrases that unambiguously say the door represented by the section
   is shut. Keep this list deliberately small. Broad words such as "cannot"
   also describe legitimate permission boundaries, and "switched off" sections
   deliberately contain a working control that turns the feature on. */
const REFUSAL_MARKERS = Object.freeze([
  Object.freeze({ name: 'at its limit', pattern: /\bat its limit\b/i }),
  Object.freeze({ name: 'already connected', pattern: /\balready connected\b/i }),
])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const checks = []
let failures = 0
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

/* ---------- stage a real packaged copy (never writes under release/) ---------- */
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
  /* The launcher was NAMED rather than found, so this staged copy was
     unopenable on Linux: the ELF is `toolsenabled`. appExecutable in
     tools/lib/packaged-platform.mjs answers for both shapes and opens the file
     it names, so a staged copy missing its launcher fails here with that
     sentence rather than at spawn time with ENOENT.

     APP_EXE IS NOT DECORATION, AND IT IS NOT A MARKER EITHER. Two things
     depend on it. First it is a real check, the same one home-screen-qa.cjs
     makes: a staged copy whose launcher is not the one this platform declares
     is a staging defect, and finding that out here beats finding it out as a
     window that never appears. Second, measured with its own classifySource():
     deleting the `'ToolsEnabled.exe'` literal from this file made
     tools/test/electron-run-as-node-harness-guard stop seeing it as a launcher
     at all -- `executable` became a helper's return value the detector cannot
     follow, and with no name for the application left in the source its
     fail-closed co-occurrence fallback did not fire either. This file really
     does spawn the packaged application (:258), and a guard that has silently
     stopped watching it costs nothing today and everything the day somebody
     drops the strip. APP_EXE is one of the four names that guard knows. */
  const staged = appExecutable(app)
  if (path.basename(staged) !== APP_EXE) {
    throw new Error(`the staged copy's launcher is ${path.basename(staged)}, not the declared ${APP_EXE}`)
  }
  return staged
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

/* ---------- the page under the keyboard ---------- */

const STOP_PROBE = index => `(() => {
  const a = document.activeElement
  if (!a || a === document.body || a === document.documentElement) return { none: true }
  /* Already tagged = this exact element has been visited in this walk. Element
     identity, not a description of it: a live log or a running clock rewrites
     its own text and resizes its own box between laps, so any identity built
     out of what a stop LOOKS like reports the ring's wrap as new stops. */
  const already = a.dataset.a11yStop !== undefined
  a.dataset.a11yStop = already ? a.dataset.a11yStop : ${JSON.stringify(String(index))}
  const cs = getComputedStyle(a)
  const r = a.getBoundingClientRect()
  const path = []
  for (let n = a; n && n.nodeType === 1 && path.length < 4; n = n.parentElement) {
    path.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''))
  }
  const outlineWidth = parseFloat(cs.outlineWidth) || 0
  return {
    already,
    tag: a.tagName,
    type: a.getAttribute('type') || '',
    text: (a.innerText || a.value || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
    data: JSON.stringify(a.dataset || {}).slice(0, 160),
    disabled: !!a.disabled,
    ariaDisabled: a.getAttribute('aria-disabled'),
    ariaPressed: a.getAttribute('aria-pressed'),
    path: path.join(' > '),
    focusVisible: (() => { try { return a.matches(':focus-visible') } catch { return null } })(),
    outlineStyle: cs.outlineStyle,
    outlineWidth,
    outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 120),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    /* Layout coordinates, because Tab SCROLLS the stop into view: viewport
       rectangles taken across a scrolling walk cannot be compared to each
       other at all, and comparing them is how a correct tab order reads as
       three violations. window.scrollY alone is not enough either — this app
       scrolls #stage, not the document, so the window offset is 0 on every
       screen and the correction has to walk the ancestor chain. */
    doc: (() => {
      let x = r.x + scrollX, y = r.y + scrollY
      for (let n = a.parentElement; n; n = n.parentElement) { x += n.scrollLeft; y += n.scrollTop }
      return { x: Math.round(x), y: Math.round(y) }
    })(),
    style: {
      borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join('|'),
      borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join('|'),
      background: cs.backgroundColor,
      color: cs.color,
      decoration: cs.textDecorationLine + ' ' + cs.textDecorationColor,
      filter: cs.filter,
      transform: cs.transform,
    },
    onScreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    fullyOnScreen: r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
  }
})()`

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'a11y-kbd-'))
  let child = null
  let session = null
  let stagedCredential = null
  const started = Date.now()
  try {
    const executable = await stage(scratch)
    const port = await freePort()
    const profile = path.join(scratch, 'profile')
    mkdirSync(path.join(profile, 'userdata'), { recursive: true })
    /* Every home the launched copy could read this machine's state through is
       inside the scratch profile (tools/lib/sterile-launch.cjs). The explicit
       live lane carries only the current account's sign-in into that profile;
       the provider-free default leaves it empty. */
    const profileDirectories = prepareSterileProfile(qaProfileDirectories(profile))
    if (CODEX_HOME) {
      /* Assign the opaque guard before the exclusive copy. Even a copy failure
         therefore reaches guarded exact/identity-recovery cleanup in finally. */
      stagedCredential = prepareCurrentCodexCredentialStage(CODEX_HOME, profileDirectories.codexHome, {
        recoveryRoot: profileDirectories.userProfile,
      })
      copyPreparedCodexCredential(stagedCredential)
    }
    const environment = sterileLaunchEnvironment(profileDirectories)

    child = spawn(executable, [
      `--user-data-dir=${path.join(profile, 'userdata')}`,
      `--remote-debugging-port=${port}`,
    ], { env: environment, stdio: 'ignore', windowsHide: true })

    /* Use the same bounded CDP transport as the account drivers. It registers a
       pending reply before sending, rejects dead sockets and times every call;
       the former local copy could drop an immediate reply and await forever. */
    session = createSession(port, child, {})
    await session.open()

    const call = async (method, params = {}) => {
      const packet = await session.send(method, params)
      if (packet.error) throw new Error(`${method}: ${packet.error.message}`)
      return packet.result
    }
    await call('Runtime.enable')
    await call('DOM.enable')
    await call('CSS.enable')
    await call('Page.enable')
    await call('Accessibility.enable')

    const evaluate = async (expression, options = {}) => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...options })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed')
      return result.result?.value
    }
    const until = async (label, expression, attempts = 60) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try { if (await evaluate(expression)) return true } catch { /* mid-navigation */ }
        await delay(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    /* The accessible name and role Chromium hands to the platform.
       backendNodeId via DOM.describeNode, NOT DOM.requestNode: requestNode
       resolves against the node-id map, which is empty until DOM.getDocument
       has walked the tree — and an empty map answers nodeId 0, which reads
       exactly like "this control has no accessible name". Measured: the first
       run of this harness reported every stop on every screen as unnamed,
       including <button aria-label="Settings">. */
    const axOfActive = async () => {
      const handle = await call('Runtime.evaluate', { expression: 'document.activeElement' })
      const objectId = handle.result?.objectId
      if (!objectId) return { name: '', role: '' }
      try {
        const described = await call('DOM.describeNode', { objectId })
        const backendNodeId = described?.node?.backendNodeId
        if (!backendNodeId) return { name: '', role: '' }
        const tree = await call('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })
        const node = (tree.nodes || [])[0] || {}
        const property = id => (node.properties || []).find(p => p.name === id)?.value?.value
        return {
          name: node.name?.value ?? '',
          role: node.role?.value ?? '',
          disabled: property('disabled') === true,
          pressed: property('pressed'),
          ignored: node.ignored === true,
        }
      } catch { return { name: '', role: '', unread: true } }
      finally { try { await call('Runtime.releaseObject', { objectId }) } catch { /* gone */ } }
    }

    /* The words Chromium exposes for the nearest containing control section.
       This deliberately reads the AX tree, not innerText: the guard is about
       the refusal a keyboard or screen-reader user can actually encounter. */
    const axSectionTextOfActive = async () => {
      let objectId = ''
      try {
        const handle = await call('Runtime.evaluate', {
          expression: `(() => {
            const active = document.activeElement
            return active?.closest('article, section, [role="region"], .settings-row, .board-box, .chat') || active?.parentElement || null
          })()`,
        })
        objectId = handle.result?.objectId
        if (!objectId) return { ok: false, reason: 'the focused control has no readable containing section object' }
        const described = await call('DOM.describeNode', { objectId })
        const backendNodeId = described?.node?.backendNodeId
        if (!backendNodeId) return { ok: false, reason: 'Chromium did not identify the containing section in the DOM backend' }
        const tree = await call('Accessibility.queryAXTree', { backendNodeId })
        const text = (tree.nodes || [])
          .filter(node => node.ignored !== true)
          .map(node => String(node.name?.value ?? '').trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
        return { ok: true, text }
      } catch (error) {
        return { ok: false, reason: `Chromium could not read the containing section accessibility tree: ${error.message}` }
      } finally {
        if (objectId) { try { await call('Runtime.releaseObject', { objectId }) } catch { /* gone */ } }
      }
    }

    /* ---------- real keys, never a click ---------- */
    const KEYS = {
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r' },
      Space: { windowsVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ', unmodifiedText: ' ' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    }
    let keystrokes = 0
    const press = async (name, { shift = false } = {}) => {
      const base = KEYS[name]
      if (!base) throw new Error(`no key ${name}`)
      const modifiers = shift ? 8 : 0
      const common = { ...base, modifiers, nativeVirtualKeyCode: base.windowsVirtualKeyCode }
      await call('Input.dispatchKeyEvent', { type: base.text ? 'keyDown' : 'rawKeyDown', ...common })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      keystrokes += 1
      await delay(60)
    }
    const typeText = async text => {
      for (const character of text) {
        await call('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character })
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
        keystrokes += 1
      }
      await delay(60)
    }

    const stopAt = async index => {
      const probe = await evaluate(STOP_PROBE(index))
      if (!probe || probe.none) return { none: true }
      const ax = await axOfActive()
      const section = await axSectionTextOfActive()
      return { ...probe, ax, section }
    }

    /* Which CSS rules the browser matched on the focused element, reduced to the
       ones that say anything about a focus indicator. */
    const matchedFocusRules = async () => {
      try {
        const handle = await call('Runtime.evaluate', { expression: 'document.activeElement' })
        const objectId = handle.result?.objectId
        if (!objectId) return []
        await call('DOM.getDocument', { depth: 0 })
        const { nodeId } = await call('DOM.requestNode', { objectId })
        if (!nodeId) return []
        const styles = await call('CSS.getMatchedStylesForNode', { nodeId })
        return (styles.matchedCSSRules || [])
          .map(entry => ({
            selector: entry.rule?.selectorList?.text || '',
            declarations: (entry.rule?.style?.cssProperties || [])
              .filter(property => /outline|box-shadow/.test(property.name) && property.value)
              .map(property => `${property.name}: ${property.value}`),
          }))
          .filter(rule => rule.declarations.length)
          .map(rule => `${rule.selector} { ${rule.declarations.join('; ')} }`)
      } catch (error) { return [`rule lookup failed: ${error.message}`] }
    }

    /* Put the sequential-focus starting point back at the top of the document.
       `blur()` alone does NOT: Chromium keeps the blurred element as the
       starting point, so the next Tab resumes from the middle of the page and
       the walk reports an order nobody could ever experience. Focusing a
       throwaway element prepended to the body and removing it leaves the
       starting point where that element was — the beginning. */
    const rewindFocus = () => evaluate(`(() => {
      document.activeElement && document.activeElement.blur && document.activeElement.blur()
      const mark = document.createElement('span')
      mark.tabIndex = 0
      document.body.prepend(mark)
      mark.focus()
      mark.remove()
    })()`)

    /**
     * Tab forward until `done(stop)` is true or the ring repeats.
     * Returns every stop, in order, with its measurement — and, for stops whose
     * focus indicator is neither an outline nor a box-shadow, the SAME
     * element's resting style, so "no visible focus" is a measured difference
     * rather than an assumption about which properties count.
     */
    const tabWalk = async ({ limit = 60, done = () => false, shift = false, fromTop = true } = {}) => {
      if (fromTop) await rewindFocus()
      const stops = []
      const seen = new Set()
      for (let i = 0; i < limit; i += 1) {
        await press('Tab', { shift })
        const stop = await stopAt(i)
        if (stop.none) { stops.push(stop); continue }
        /* Identity WITHOUT the text. The home log and the agent transcript
           re-render their own contents on a clock, so text-based identity made
           the second lap of the ring look like fresh stops and the walk
           "discovered" the wrap from the last control back to the first as a
           reading-order violation, six times over. Where a control sits and
           what it is are stable; what it says is not. */
        const identity = `${stop.path}|${stop.data}|${stop.tag}|${stop.doc.x},${stop.doc.y}|${stop.rect.w}x${stop.rect.h}`
        if (stop.already || seen.has(identity)) { stop.repeat = true; stops.push(stop); break }
        seen.add(identity)
        /* A stop that looks unlit gets a second look after the transitions have
           settled. `.tab` transitions `all`, so a style read 60ms after the key
           press can catch the indicator mid-flight and report a control as
           having none at all. Re-reading the SAME still-focused element costs
           350ms only on the stops that would otherwise be reported as
           failures. */
        if (!(stop.outlineWidth > 0 && stop.outlineStyle !== 'none') && !stop.boxShadow) {
          await delay(350)
          const settled = await evaluate(`(() => {
            const a = document.activeElement
            if (!a || a === document.body) return null
            const cs = getComputedStyle(a)
            return {
              outlineStyle: cs.outlineStyle,
              outlineWidth: parseFloat(cs.outlineWidth) || 0,
              boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 120),
              borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join('|'),
              background: cs.backgroundColor,
              /* The recipe's ring is built out of two custom properties. If
                 either fails to resolve at THIS element the whole declaration
                 is invalid at computed-value time and the indicator is not
                 dimmed, it is absent — so the values are reported rather than
                 assumed. */
              wa: cs.getPropertyValue('--wa').trim(),
              ring: cs.getPropertyValue('--focus-ring').trim(),
            }
          })()`)
          if (settled) {
            stop.outlineStyle = settled.outlineStyle
            stop.outlineWidth = settled.outlineWidth
            stop.boxShadow = settled.boxShadow
            stop.style = { ...stop.style, borderColor: settled.borderColor, background: settled.background }
            stop.tokens = { wa: settled.wa, ring: settled.ring }
            stop.settled = true
          }
          /* Still nothing? Then say WHICH rules the browser actually applied,
             rather than leaving a reader to guess from the stylesheet source
             which of several same-specificity rules won. */
          if (!(stop.outlineWidth > 0 && stop.outlineStyle !== 'none') && !stop.boxShadow) {
            stop.matched = await matchedFocusRules()
          }
        }
        stops.push(stop)
        if (done(stop)) break
      }
      /* Resting styles, read with nothing focused, then the markers are removed
         so the page is left exactly as it was found. */
      const resting = await evaluate(`(() => {
        /* The walk ends ON a control the caller is about to press Enter on, so
           the element focus is handed back at the bottom of this function.
           Without that, the resting measurement silently un-focused the target
           and every subsequent keypress went nowhere. */
        const active = document.activeElement
        active && active.blur && active.blur()
        const out = {}
        for (const node of document.querySelectorAll('[data-a11y-stop]')) {
          const cs = getComputedStyle(node)
          out[node.dataset.a11yStop] = {
            outlineWidth: parseFloat(cs.outlineWidth) || 0,
            outlineStyle: cs.outlineStyle,
            boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 120),
            borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join('|'),
            borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join('|'),
            background: cs.backgroundColor,
            color: cs.color,
            decoration: cs.textDecorationLine + ' ' + cs.textDecorationColor,
            filter: cs.filter,
            transform: cs.transform,
          }
          delete node.dataset.a11yStop
        }
        if (active && active.isConnected && active.focus) active.focus()
        return out
      })()`)
      for (const [index, stop] of stops.entries()) {
        if (stop.none) continue
        stop.resting = resting?.[String(index)] || null
      }
      return stops
    }

    /* A PICTURE OF THE FOCUSED CONTROL, because a computed outline width is
       evidence and a look at the screen is proof. Written next to this report so
       a reviewer can see the ring rather than take the number for it. */
    const shotDir = path.join(REPO_ROOT, 'reports', 'a11y')
    mkdirSync(shotDir, { recursive: true })
    const shoot = async name => {
      try {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        if (!shot?.data) return ''
        const file = path.join(shotDir, `${name}.png`)
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        console.log(`    shot: ${file}`)
        return file
      } catch (error) { return `screenshot failed: ${error.message}` }
    }

    /* WHAT ACTUALLY CHANGES WHEN THIS STOP IS FOCUSED. An outline or a
       box-shadow is the site recipe; anything else that moved (a border colour,
       a background, an underline) is still a visible change and is named rather
       than ignored, so a thin indicator is reported as thin instead of as
       absent. */
    const indicatorOf = stop => {
      if (stop.none) return ''
      const parts = []
      if (stop.outlineWidth > 0 && stop.outlineStyle !== 'none') parts.push(`outline ${stop.outlineWidth.toFixed(1)}px ${stop.outlineStyle}`)
      if (stop.boxShadow && stop.boxShadow !== stop.resting?.boxShadow) parts.push('box-shadow')
      if (stop.resting) {
        for (const key of ['borderColor', 'borderWidth', 'background', 'color', 'decoration', 'filter', 'transform']) {
          if (stop.style?.[key] !== stop.resting[key]) parts.push(key)
        }
      }
      return parts.join('+')
    }

    const describe = stop => `${stop.tag}${stop.disabled ? '(disabled)' : ''} "${stop.text || stop.ax?.name || ''}"`
    const actionable = stop => !stop.none && stop.tag !== 'BODY'

    const reportStops = (label, stops) => {
      console.log(`\n  [${label}] ${stops.length} keyboard stops`)
      for (const [index, stop] of stops.entries()) {
        if (stop.none) { console.log(`    ${index + 1}. (focus left the document)`); continue }
        console.log(`    ${index + 1}. ${describe(stop)}  ax="${stop.ax?.name || ''}" role=${stop.ax?.role || '?'} ind=[${indicatorOf(stop) || 'NONE'}] rect=${stop.rect.x},${stop.rect.y} ${stop.rect.w}x${stop.rect.h}${stop.onScreen ? '' : ' OFFSCREEN'}${stop.repeat ? ' (cycle)' : ''}`)
      }
    }

    /* Every named control on this step, and what a screen reader would say. */
    const auditStops = (label, stops) => {
      const real = stops.filter(actionable).filter(stop => !stop.repeat)
      const unnamed = real.filter(stop => !(stop.ax?.name || '').trim())
      const unlit = real.filter(stop => !indicatorOf(stop))
      const offscreen = real.filter(stop => !stop.onScreen)
      /* Vacuous truth is not keyboard access. Previously, an all-{ none: true }
         walk made every collection below empty, so all four aggregate checks
         passed and reported "0 stops". Refuse that result by screen name before
         examining the properties of the stops that exist. */
      check(`${label}: has at least one keyboard stop`, real.length > 0, `${real.length} stops`)
      check(`${label}: every keyboard stop has a name a screen reader can read`, unnamed.length === 0,
        unnamed.length ? unnamed.map(describe).join(' | ') : `${real.length} stops`)
      check(`${label}: every keyboard stop shows a focus indicator`, unlit.length === 0,
        unlit.length ? unlit.map(stop => `${describe(stop)} <${stop.path}> :focus-visible=${stop.focusVisible} focused[outline ${stop.outlineWidth} ${stop.outlineStyle}; shadow ${stop.boxShadow || 'none'}] tokens[${JSON.stringify(stop.tokens || {})}] matched[${(stop.matched || []).join(' ;; ')}]`).join(' | ') : `${real.length} stops`)
      check(`${label}: no stop is focus you cannot see`, offscreen.length === 0,
        offscreen.length ? offscreen.map(describe).join(' | ') : `${real.length} stops`)
      for (const stop of real) {
        const enabled = !stop.disabled && stop.ariaDisabled !== 'true' && stop.ax?.disabled !== true
        if (!enabled) continue
        const unknown = stop.section?.ok !== true ? (stop.section?.reason || 'the section-text probe returned no result or reason') : ''
        const text = String(stop.section?.text || '')
        const marker = unknown ? null : REFUSAL_MARKERS.find(candidate => candidate.pattern.test(text))
        check(`${label}: enabled ${describe(stop)} has no refusal marker in its accessible section`, !unknown && !marker,
          unknown
            ? `UNKNOWN -- ${unknown}`
            : marker
              ? `matched "${marker.name}" in AX section text: ${text.slice(0, 260)}`
              : `checked ${REFUSAL_MARKERS.map(candidate => JSON.stringify(candidate.name)).join(', ')}; no marker`)
      }
      /* Reading order, in DOCUMENT coordinates and row-aware. A control that is
         on the same visual row as the previous one (their boxes overlap
         vertically) is not "above" it whatever its top edge says — a 15px link
         centred beside a 40px button starts lower and ends higher. Only a stop
         that is wholly above the previous one AND does not start further right
         is a backwards jump, which is WCAG 2.4.3. */
      const outOfOrder = []
      for (let i = 1; i < real.length; i += 1) {
        const previous = real[i - 1], current = real[i]
        const overlaps = current.doc.y < previous.doc.y + previous.rect.h && current.doc.y + current.rect.h > previous.doc.y
        const whollyAbove = current.doc.y + current.rect.h <= previous.doc.y - 4
        if (!overlaps && whollyAbove && current.doc.x <= previous.doc.x) {
          outOfOrder.push(`${describe(previous)} @${previous.doc.x},${previous.doc.y} -> ${describe(current)} @${current.doc.x},${current.doc.y}`)
        }
      }
      check(`${label}: tab order follows the reading order`, outOfOrder.length === 0, outOfOrder.join(' | '))
      return real
    }

    const routeNow = () => evaluate('location.hash')
    const screenText = () => evaluate('document.querySelector("[data-setup-section]")?.innerText || document.body.innerText.slice(0, 400)')

    /* ================= PHASE 1: the first-run question ================= */
    console.log('\n== phase 1: first run opens on the permission question ==')
    await until('the setup route', 'location.hash === "#/setup"')
    check('a sterile profile opens on the setup walkthrough', (await routeNow()) === '#/setup')
    check('the first-run screen hides the navigation chrome', await evaluate('document.body.classList.contains("first-run")'))

    let stops = await tabWalk({ limit: 12, done: stop => /Continue/i.test(stop.text) })
    reportStops('setup / permission level', stops)
    auditStops('setup / permission level', stops)
    const tierStops = stops.filter(stop => (stop.data || '').includes('setupTier'))
    check('every permission-level answer is a keyboard stop', tierStops.length === 3, `${tierStops.length} of 3`)
    check('each answer says whether it is the chosen one', tierStops.every(stop => stop.ax?.pressed === 'true' || stop.ax?.pressed === 'false'),
      tierStops.map(stop => `${stop.text}=${stop.ax?.pressed}`).join(' '))
    await shoot('01-setup-focus-normal')
    const continueStop = stops.find(stop => /Continue/i.test(stop.text))
    check('Continue is reachable by Tab alone', !!continueStop, continueStop ? `after ${stops.indexOf(continueStop) + 1} presses` : 'never reached')

    /* Space, not Enter, on the answer: both must work on a <button>. Three Tabs
       from the top is the third answer, so the press lands somewhere the
       selection is not already. */
    if (tierStops.length === 3) {
      /* The SECOND answer, not the third: this walk finishes setup for real and
         the level it lands on is the level the agent surface later runs at.
         Two Tabs is "standard", which is a change from the preselected
         "guided" (so the press proves something) without leaving a machine
         configured with permissions bypassed. */
      await rewindFocus()
      await press('Tab'); await press('Tab')
      const focusedTier = await evaluate('document.activeElement?.dataset?.setupTier || ""')
      const before = await evaluate('document.querySelector("[data-setup-tier][aria-pressed=\\"true\\"]")?.dataset.setupTier || ""')
      await press('Space')
      await delay(200)
      const after = await evaluate('document.querySelector("[data-setup-tier][aria-pressed=\\"true\\"]")?.dataset.setupTier || ""')
      check('Space chooses the focused answer', !!focusedTier && after === focusedTier, `focused ${focusedTier}: ${before} -> ${after}`)
      /* ...and the seg's own keyboard contract: a group of buttons is walked by
         Tab in this product (no roving tabindex), so every answer must be a
         stop rather than only the selected one. Asserted above; this records
         that arrow keys are NOT the mechanism, so nobody "fixes" it later by
         adding arrows that then trap the Tab order. */
      const beforeArrow = after
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' })
      await delay(150)
      const afterArrow = await evaluate('document.querySelector("[data-setup-tier][aria-pressed=\\"true\\"]")?.dataset.setupTier || ""')
      console.log(`    arrow keys on the answer group: ${beforeArrow} -> ${afterArrow} (Tab is the mechanism here)`)
    }

    /* ================= high contrast, on the same screen ================= */
    console.log('\n== phase 2: the same screen with high contrast on ==')
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
    await delay(200)
    await evaluate('document.activeElement.blur()')
    const hcStops = await tabWalk({ limit: 12, done: stop => /Continue/i.test(stop.text) })
    reportStops('high contrast / permission level', hcStops)
    /* box-shadow is dropped by the UA in forced-colors mode, so only an outline
       is a focus indicator there. */
    const hcReal = hcStops.filter(actionable).filter(stop => !stop.repeat)
    const hcUnlit = hcReal.filter(stop => !(stop.outlineWidth > 0 && stop.outlineStyle !== 'none'))
    check('high contrast: every stop still shows a focus outline', hcUnlit.length === 0,
      hcUnlit.length ? hcUnlit.map(stop => `${describe(stop)} [${stop.boxShadow ? 'box-shadow only' : 'nothing'}]`).join(' | ') : `${hcReal.length} stops`)
    const hcSelected = await evaluate(`(() => {
      const on = document.querySelector('[data-setup-tier][aria-pressed="true"]')
      if (!on) return { missing: true }
      const cs = getComputedStyle(on)
      /* And the DESCRIPTION rows: the chosen option's row is marked with a left
         rule that is transparent on the others -- which is only a distinction
         if forced colors leaves transparent alone. Measured here rather than
         assumed, by comparing the current row with a row that is not. */
      const rows = [...document.querySelectorAll('.setup-choice[aria-current]')]
      const current = rows.find(row => row.getAttribute('aria-current') === 'true')
      const other = rows.find(row => row.getAttribute('aria-current') !== 'true')
      const rowStyle = row => {
        if (!row) return null
        const style = getComputedStyle(row)
        return [style.borderLeftColor, style.borderLeftWidth, style.outlineStyle, style.outlineWidth, style.textDecorationLine].join(' / ')
      }
      return {
        outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
        decoration: cs.textDecorationLine,
        weight: cs.fontWeight,
        currentRow: rowStyle(current),
        otherRow: rowStyle(other),
        rowsDiffer: Boolean(current && other && rowStyle(current) !== rowStyle(other)),
      }
    })()`)
    check('high contrast: the chosen answer is still visibly the chosen one',
      !!hcSelected && !hcSelected.missing && (hcSelected.outline || (hcSelected.decoration && hcSelected.decoration !== 'none')),
      JSON.stringify(hcSelected))
    check('high contrast: the chosen option’s description row is still marked',
      !!hcSelected && hcSelected.rowsDiffer === true, JSON.stringify({ current: hcSelected?.currentRow, other: hcSelected?.otherRow }))
    await shoot('02-setup-focus-high-contrast')
    await call('Emulation.setEmulatedMedia', { features: [] })
    await delay(150)

    /* ================= text scaling on the first screen ================= */
    console.log('\n== phase 3: text scaling on the first screen ==')
    const layoutProbe = `(() => ({
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      actionsVisible: (() => {
        const bar = document.querySelector('.setup-actions')
        if (!bar) return null
        const r = bar.getBoundingClientRect()
        return { w: Math.round(r.width), right: Math.round(r.right), inner: innerWidth, clipped: r.right > innerWidth + 1 || r.left < -1 }
      })(),
      clipped: [...document.querySelectorAll('.setup-actions button, .setup-title, .settings-name')]
        .filter(n => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflow !== 'visible')
        .map(n => n.textContent.trim().slice(0, 40)),
    }))()`
    const atText = async (scale, label) => {
      await evaluate(`(() => { try { localStorage.setItem('mc.text', ${JSON.stringify(String(scale))}) } catch {} ; document.body.style.zoom = ${JSON.stringify(String(scale))} })()`)
      await delay(250)
      const probe = await evaluate(layoutProbe)
      check(`${label}: the page does not scroll sideways`, probe.sideways <= 1, `overflow ${probe.sideways}px`)
      check(`${label}: the step's buttons are not clipped`, !probe.actionsVisible?.clipped && probe.clipped.length === 0,
        JSON.stringify(probe))
      return probe
    }
    await atText(1.12, 'text size largest (1.12)')
    /* 200%-equivalent: halve the viewport in CSS px, which is what browser zoom
       does to reflow. WCAG 1.4.4 asks for 200% without loss of content. */
    const metrics = await evaluate('({ w: innerWidth, h: innerHeight })')
    await call('Emulation.setDeviceMetricsOverride', { width: Math.round(metrics.w / 2), height: Math.round(metrics.h / 2), deviceScaleFactor: 0, mobile: false })
    await delay(300)
    const zoomProbe = await evaluate(layoutProbe)
    check('200% zoom: the page does not scroll sideways', zoomProbe.sideways <= 1, `overflow ${zoomProbe.sideways}px`)
    const zoomReach = await tabWalk({ limit: 14, done: stop => /Continue/i.test(stop.text) })
    const zoomContinue = zoomReach.find(stop => /Continue/i.test(stop.text))
    check('200% zoom: Continue is still reachable and on screen', !!zoomContinue && zoomContinue.onScreen,
      zoomContinue ? JSON.stringify(zoomContinue.rect) : 'never reached')
    await call('Emulation.clearDeviceMetricsOverride')
    await evaluate(`(() => { try { localStorage.removeItem('mc.text') } catch {}; document.body.style.zoom = '' })()`)
    await delay(250)

    /* ================= PHASE 4: walk the rest of setup by keyboard ================= */
    console.log('\n== phase 4: the rest of the walkthrough, keyboard only ==')
    const pressByName = async (matcher, label, limit = 40) => {
      await evaluate('document.activeElement && document.activeElement.blur()')
      const walk = await tabWalk({ limit, done: matcher })
      const target = walk.find(matcher)
      if (!target) { reportStops(`could not reach ${label}`, walk); throw new Error(`no keyboard stop matched ${label}`) }
      await press('Enter')
      await delay(400)
      return walk
    }

    const tierWalk = await pressByName(stop => /^Continue$/i.test(stop.text), 'Continue on the permission question')
    void tierWalk
    await until('the folder question', 'document.querySelector("[data-setup-section]").innerText.includes("Which folder")')
    check('Enter on Continue advanced the walkthrough', true, 'reached the folder question')

    await until('the folder to resolve', 'document.querySelector(".setup-root-path") !== null')
    stops = await tabWalk({ limit: 20, done: stop => /^Continue$/i.test(stop.text) })
    reportStops('setup / folder', stops)
    auditStops('setup / folder', stops)
    await press('Enter')
    await delay(500)

    await until('the sign-in step',
      'document.querySelector("[data-setup-section]").innerText.includes("Who is using this copy") || document.querySelector("[data-setup-section]").innerText.includes("Signed in as")')
    stops = await tabWalk({ limit: 26, done: stop => /^Not now$/i.test(stop.text) })
    reportStops('setup / sign in', stops)
    auditStops('setup / sign in', stops)
    const labelled = await evaluate(`(() => [...document.querySelectorAll('[data-setup-account-field]')].map(field => {
      const by = field.getAttribute('aria-labelledby')
      return {
        field: field.dataset.setupAccountField,
        labelled: !!(field.closest('label') || field.getAttribute('aria-label')
          || (by && by.split(/\\s+/).every(id => document.getElementById(id)))
          || (field.id && document.querySelector('label[for="' + field.id + '"]'))),
      }
    }))()`)
    check('every sign-in field carries a label', Array.isArray(labelled) && labelled.every(entry => entry.labelled), JSON.stringify(labelled))
    await press('Enter')
    await delay(500)

    await until('the autonomy question', 'document.querySelector("[data-setup-section]").innerText.includes("How much should it do without asking")')
    stops = await tabWalk({ limit: 22, done: stop => /See what that sets/i.test(stop.text) })
    reportStops('setup / acting on its own', stops)
    auditStops('setup / acting on its own', stops)
    const autonomyStops = stops.filter(stop => (stop.data || '').includes('"setupSet":"autonomy"'))
    check('every "acting on its own" answer is a keyboard stop with a name',
      autonomyStops.length === 3 && autonomyStops.every(stop => (stop.ax?.name || '').trim()),
      autonomyStops.map(stop => `${stop.ax?.name}=${stop.ax?.pressed}`).join(' | '))
    await press('Enter')
    await delay(600)

    await until('the review', 'document.querySelector("[data-setup-section]").innerText.includes("Here is what those answers set")')
    stops = await tabWalk({ limit: 40, done: stop => /Finish setup/i.test(stop.text) })
    reportStops('setup / review', stops)
    auditStops('setup / review', stops)
    const finish = stops.find(stop => /Finish setup/i.test(stop.text))
    check('Finish setup is reachable by Tab alone', !!finish, finish ? `after ${stops.indexOf(finish) + 1} presses` : 'never reached')
    await press('Enter')
    await delay(1200)
    await until('the app', 'location.hash === "#/" || location.hash === ""')
    check('Enter on Finish setup finished setup and landed on the app', true, await routeNow())

    /* ================= PHASE 5: home, by keyboard ================= */
    console.log('\n== phase 5: home ==')
    await delay(1500)
    await evaluate('document.activeElement && document.activeElement.blur()')
    stops = await tabWalk({ limit: 40 })
    reportStops('home', stops)
    auditStops('home', stops)

    /* Home carries the two densest blocks on the flow (the ring and the log
       panel), so it is scaled here as well rather than only at the ends. */
    const homeScale = async (scale, label) => {
      await evaluate(`(() => { document.body.style.zoom = ${JSON.stringify(String(scale))} })()`)
      await delay(350)
      const probe = await evaluate(`(() => ({
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped: [...document.querySelectorAll('.home-fact span, .session-head span, .home-next')]
          .filter(n => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflow !== 'visible')
          .map(n => n.textContent.trim().slice(0, 40)),
      }))()`)
      check(`home at ${label}: no sideways scroll, nothing clipped`, probe.sideways <= 1 && probe.clipped.length === 0, JSON.stringify(probe))
    }
    await homeScale(1.12, 'text size largest')
    await evaluate(`(() => { document.body.style.zoom = '' })()`)
    const homeMetrics = await evaluate('({ w: innerWidth, h: innerHeight })')
    await call('Emulation.setDeviceMetricsOverride', { width: Math.round(homeMetrics.w / 2), height: Math.round(homeMetrics.h / 2), deviceScaleFactor: 0, mobile: false })
    await delay(400)
    const homeZoom = await evaluate('({ sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth })')
    check('home at 200% zoom: no sideways scroll', homeZoom.sideways <= 1, JSON.stringify(homeZoom))
    await call('Emulation.clearDeviceMetricsOverride')
    await delay(300)

    /* ================= PHASE 6: the agent surface and Start ================= */
    console.log('\n== phase 6: reaching an agent surface and its Start control ==')
    /* WHAT A STRANGER'S COPY ACTUALLY HAS TO OPEN. The build-time fleet
       projection ships empty on every install (dist/data/fleet.json,
       ok:false) -- the declared organisation the shell keeps is the thing an
       agent page can be built from, so that is what is asked. */
    const declared = await evaluate(`(async () => {
      try {
        const reply = await globalThis.mcOrg?.read?.()
        if (!reply) return 'no mcOrg bridge in this window'
        return JSON.stringify(reply).slice(0, 400)
      } catch (error) { return 'org read failed: ' + error.message }
    })()`)
    console.log(`    declared organisation: ${declared}`)

    /* Keyboard-only route: the chevrons are the only navigation, so walk the
       ring to the computers page and Tab into it. */
    const ringWalk = await tabWalk({ limit: 8, done: stop => /Forward to/i.test(stop.ax?.name || '') })
    const forward = ringWalk.find(stop => /Forward to/i.test(stop.ax?.name || ''))
    check('the forward chevron is a keyboard stop with a destination in its name', !!forward, forward?.ax?.name || 'not reached')
    if (forward) {
      await press('Enter')
      await delay(900)
      check('Enter on the chevron navigated', (await routeNow()) !== '#/', await routeNow())
      await delay(900)
      stops = await tabWalk({ limit: 45, done: stop => /^open/i.test(stop.text) && stop.tag === 'BUTTON' })
      reportStops('computers', stops)
      auditStops('computers', stops)
      /* The computer tab, focused, in the ordinary palette: this is the control
         whose ring the flattening sheet had removed. */
      await rewindFocus()
      await press('Tab'); await press('Tab'); await press('Tab'); await press('Tab')
      await shoot('04-computers-tab-focus-normal')
      const open = stops.find(stop => /^open/i.test(stop.text) || /^Open the detail page/i.test(stop.ax?.name || ''))
      check('an agent can be opened from the keyboard on the computers page', !!open, open ? describe(open) : 'no Open control was reachable by Tab')
      if (open) {
        await press('Enter')
        await delay(1200)
      }
    }

    let route = await routeNow()
    if (!route.startsWith('#/agent/')) {
      /* The address is a keyboard-reachable route in its own right; reaching the
         page this way keeps the Start measurements honest while the reachability
         result above is reported separately rather than hidden. */
      const first = await evaluate(`(async () => {
        try {
          const reply = await globalThis.mcOrg?.read?.()
          const org = reply?.org || reply?.data || reply
          const agents = org?.agents || []
          const seat = agents[0]
          if (!seat) return ''
          return '#/agent/' + (org.computerId || 'this-computer') + '/' + (seat.id || seat.agentId)
        } catch { return '' }
      })()`)
      if (first) { await evaluate(`location.hash = ${JSON.stringify(first)}`); await delay(1500) }
      route = await routeNow()
    }
    check('an agent surface is on screen', route.startsWith('#/agent/'), route)

    if (route.startsWith('#/agent/')) {
      await delay(1200)
      const startProbe = await evaluate(`(() => {
        const start = document.querySelector('[data-session-start]')
        if (!start) return { missing: true, surface: !!document.querySelector('.agent-session-surface'), body: document.body.innerText.slice(0, 300) }
        const form = start.closest('form')
        const prompt = form?.elements?.text
        return {
          missing: false,
          disabled: start.disabled,
          text: start.textContent.trim(),
          promptLabelled: !!(prompt && (prompt.closest('label') || prompt.getAttribute('aria-label'))),
          status: document.querySelector('[data-session-status]')?.textContent.trim().slice(0, 120) || '',
        }
      })()`)
      console.log(`    start probe: ${JSON.stringify(startProbe)}`)
      check('the agent surface has a Start control', startProbe && !startProbe.missing, JSON.stringify(startProbe).slice(0, 300))
      if (PRESS_START) {
        check('the live Start/Stop audit has an enabled Start control',
          Boolean(startProbe && !startProbe.missing && !startProbe.disabled), JSON.stringify(startProbe).slice(0, 300))
      }

      if (startProbe && !startProbe.missing) {
        await evaluate('document.activeElement && document.activeElement.blur()')
        stops = await tabWalk({ limit: 60, done: stop => (stop.data || '').includes('sessionStart') })
        reportStops('agent surface', stops)
        auditStops('agent surface', stops)
        const start = stops.find(stop => (stop.data || '').includes('sessionStart'))
        /* A DISABLED button is deliberately not in the tab order, so "never
           reached" is only a defect when the control is live. The two cases are
           reported as two different sentences rather than one that would be
           false half the time. */
        if (startProbe.disabled) {
          check('Start is disabled on this machine, and the reason is on the page', true, startProbe.status)
          const tied = await evaluate(`(() => {
            const start = document.querySelector('[data-session-start]')
            const by = start?.getAttribute('aria-describedby') || ''
            const targets = by ? by.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean) : []
            return { describedby: by, resolves: targets.length > 0, says: targets.map(node => node.textContent.trim().slice(0, 80)) }
          })()`)
          check('a disabled Start says WHY through its own accessible description', tied.resolves, JSON.stringify(tied))
        } else {
          check('Start is reachable by Tab alone', !!start, start ? `after ${stops.indexOf(start) + 1} presses` : 'never reached by Tab')
        }
        const startAx = await evaluate(`(() => {
          const start = document.querySelector('[data-session-start]')
          return start ? { text: start.textContent.trim(), aria: start.getAttribute('aria-label') || '', described: start.getAttribute('aria-describedby') || '' } : null
        })()`)
        console.log(`    Start element: ${JSON.stringify(startAx)}`)
        if (start) {
          check('Start announces more than the bare word "Start"',
            (start.ax?.name || '').trim().length > 5, `ax name = "${start.ax?.name}"`)
        }
        /* Its status row is what tells a screen-reader user why it is disabled. */
        const live = await evaluate(`(() => {
          const status = document.querySelector('[data-session-status]')
          const output = document.querySelector('[data-action-output]')
          return { statusRole: status?.getAttribute('role') || '', statusText: status?.textContent.trim().slice(0, 140) || '', outputRole: output?.getAttribute('role') || '' }
        })()`)
        check('the session status is announced as it changes', live.statusRole === 'status', JSON.stringify(live))

        /* THE LIVE OPT-IN PRESSES IT, from the keyboard, on a real machine.
         *
         * The provider-free default never presses Start: trusting validation to
         * prevent a launch would make a regression capable of spending provider
         * budget before the check turned red. --press-start first proves the
         * empty form refusal, then starts and closes the explicitly costly real
         * session. Its precondition check above makes a disabled or missing
         * Start a measured failure rather than a smaller green roster. */
        if (start && !startProbe.disabled && PRESS_START) {
          await rewindFocus()
          const promptWalk = await tabWalk({ limit: 60, done: stop => stop.tag === 'TEXTAREA' })
          const field = promptWalk.find(stop => stop.tag === 'TEXTAREA')
          check('the prompt field is reachable by Tab and named', !!field && !!(field.ax?.name || '').trim(),
            field ? `"${field.ax?.name}"` : 'never reached')
          if (field) {
            await press('Tab')                       // Start sits after the field
            await press('Enter')
            await delay(600)
            const refused = await evaluate(`(() => {
              const form = document.querySelector('[data-session-form]')
              return { started: (document.querySelector('[data-session-status]')?.textContent || ''), valid: form?.checkValidity?.() }
            })()`)
            check('Start with an empty prompt does not start anything', refused.valid === false, JSON.stringify(refused))

            await rewindFocus()
            await tabWalk({ limit: 60, done: stop => stop.tag === 'TEXTAREA' })
            await typeText('Reply with the single word OK and stop.')
            await press('Tab')
            const beforeStart = await evaluate('document.querySelector("[data-session-status]")?.textContent.trim() || ""')
            await press('Enter')
            let moved = ''
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await delay(500)
              moved = await evaluate('document.querySelector("[data-session-status]")?.textContent.trim() || ""')
              if (moved && moved !== beforeStart) break
            }
            const stopped = await evaluate(`(() => {
              const stop = document.querySelector('[data-session-stop]')
              return { present: !!stop, disabled: stop?.disabled, focusable: stop ? !stop.disabled : false }
            })()`)
            check('Enter on Start starts a session',
              !!moved && moved !== beforeStart && stopped.present && !stopped.disabled,
              `"${beforeStart}" -> "${moved}"; stop=${JSON.stringify(stopped)}`)
            console.log(`    Stop control after starting: ${JSON.stringify(stopped)}`)
            if (stopped.present && !stopped.disabled) {
              await rewindFocus()
              const stopWalk = await tabWalk({ limit: 60, done: s => (s.data || '').includes('sessionStop') })
              const stopStop = stopWalk.find(s => (s.data || '').includes('sessionStop'))
              check('Stop is reachable by Tab and named', !!stopStop && !!(stopStop.ax?.name || '').trim(), stopStop ? `"${stopStop.ax?.name}"` : 'never reached')
              if (stopStop) {
                await press('Enter')
                await delay(2500)
                const after = await evaluate('document.querySelector("[data-session-status]")?.textContent.trim() || ""')
                check('Enter on Stop ends the session', /ready|closed|stopped|no session/i.test(after), `status "${after}"`)
              }
            }
          }
        }
      }

      /* TEXT SCALING WHERE THE CONTROL ACTUALLY IS. The setup screen was
         measured at the top of this run; the agent surface is the other end of
         the flow and is far denser, so it is measured too. */
      const agentScale = async (scale, label) => {
        await evaluate(`(() => { document.body.style.zoom = ${JSON.stringify(String(scale))} })()`)
        await delay(350)
        const probe = await evaluate(`(() => {
          const start = document.querySelector('[data-session-start]')
          const r = start ? start.getBoundingClientRect() : null
          return {
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            start: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
            clipped: [...document.querySelectorAll('.write-form button, .write-form-title, .agent-head .an')]
              .filter(n => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflow !== 'visible')
              .map(n => n.textContent.trim().slice(0, 40)),
          }
        })()`)
        check(`agent surface at ${label}: no sideways scroll, nothing clipped`,
          probe.sideways <= 1 && probe.clipped.length === 0, JSON.stringify(probe))
      }
      await agentScale(1.12, 'text size largest')
      await evaluate(`(() => { document.body.style.zoom = '' })()`)
      const agentMetrics = await evaluate('({ w: innerWidth, h: innerHeight })')
      await call('Emulation.setDeviceMetricsOverride', { width: Math.round(agentMetrics.w / 2), height: Math.round(agentMetrics.h / 2), deviceScaleFactor: 0, mobile: false })
      await delay(400)
      const zoomedAgent = await evaluate(`({
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        startPresent: !!document.querySelector('[data-session-start]'),
      })`)
      check('agent surface at 200% zoom: no sideways scroll and the control is still there',
        zoomedAgent.sideways <= 1 && zoomedAgent.startPresent, JSON.stringify(zoomedAgent))
      await call('Emulation.clearDeviceMetricsOverride')
      await delay(300)

      /* high contrast on the agent surface too */
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
      await delay(250)
      await evaluate('document.activeElement && document.activeElement.blur()')
      const hcAgent = await tabWalk({ limit: 40, done: stop => (stop.data || '').includes('sessionStart') })
      const hcAgentReal = hcAgent.filter(actionable).filter(stop => !stop.repeat)
      const hcAgentUnlit = hcAgentReal.filter(stop => !(stop.outlineWidth > 0 && stop.outlineStyle !== 'none'))
      reportStops('high contrast / agent surface', hcAgent)
      await shoot('03-agent-focus-high-contrast')
      check('high contrast: every agent-surface stop still shows a focus outline', hcAgentUnlit.length === 0,
        hcAgentUnlit.length ? hcAgentUnlit.map(describe).join(' | ') : `${hcAgentReal.length} stops`)
      await call('Emulation.setEmulatedMedia', { features: [] })
    }

    console.log(`\n  ${keystrokes} key events dispatched; no click(), no pointer event, no coordinate.`)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const passed = checks.filter(entry => entry.ok).length
    console.log(`\n${passed}/${checks.length} checks passed in ${elapsed}s`)
    writeFileSync(path.join(REPO_ROOT, 'reports', 'a11y-keyboard-last-run.json'),
      JSON.stringify({ at: new Date().toISOString(), seconds: Number(elapsed), keystrokes, checks }, null, 2))
    return failures === 0 ? 0 : 1
  } finally {
    session?.close()
    if (child?.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
    }
    await delay(500)
    /* A costly run may keep screenshots and non-secret scratch evidence, but
       never the copied sign-in. Guarded exact cleanup and bounded identity
       recovery run before honoring --keep. Recursive non-secret scratch
       cleanup runs only after that secret cleanup is proved safe. */
    let credentialCleanupError = null
    if (stagedCredential) {
      try { await removeStagedCodexCredential(stagedCredential) }
      catch (error) { credentialCleanupError = error }
    }
    if (!KEEP && !credentialCleanupError && !(CODEX_HOME && !stagedCredential)) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds a handle briefly */ }
    }
    else console.log(`  scratch kept at ${scratch}`)
    if (credentialCleanupError) throw credentialCleanupError
  }
}

main().then(code => process.exit(code)).catch(error => {
  console.error(`\nHARNESS FAILURE: ${error.message}`)
  process.exit(2)
})
