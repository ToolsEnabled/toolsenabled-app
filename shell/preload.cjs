// Bridge between the page and the window chrome. Two jobs:
// 1. Announce the shell to the renderer (src/main.js adds the titlebar strip
//    and body.in-shell only when this marker exists — the same build keeps
//    serving unchanged in a plain browser).
// 2. Watch the theme attribute and report the REAL composited surface
//    colours to the main process, so the native caption buttons and window
//    background always match the page. Reading getComputedStyle here (after
//    a frame, so the token flip has painted) beats hardcoding theme hexes —
//    the shell can never drift from styles.css.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mcShell', {
  titlebarHeight: 36,
  getBridgeProof: () => ipcRenderer.invoke('mc-bridge-proof'),
  remoteWorkspace: Object.freeze({
    status: () => ipcRenderer.invoke('mc-remote:status'),
    inspect: selection => ipcRenderer.invoke('mc-remote:inspect', selection),
    open: request => ipcRenderer.invoke('mc-remote:open', request),
  }),
  // The shell names the exact bridge it supervises so the renderer pins to it
  // instead of scanning localhost and trusting the first responder -- which is
  // how a squatter is handed this boot's proof. See mc-bridge-endpoint in
  // main.cjs and configuredBaseUrl() in src/mission-bridge.js.
  getBridgeEndpoint: () => ipcRenderer.invoke('mc-bridge-endpoint'),
  runtimeIdentity: (...args) => ipcRenderer.invoke('mc-runtime-identity', ...args),
  /* WHETHER THIS COPY HAS A PURCHASE LIST, asked of the shell that would serve
     it rather than fetched. The probe used to request /data/purchase-catalog.json
     on every start, and a copy with no list got a 404 back: an error-level line
     in the page's own log for a state that is normal (seen the first time the
     app was driven from outside, 2026-09-02). The shell answers from the same
     file check its route makes; a renderer on a shell without this method still
     falls back to the fetch. */
  checkoutSurface: () => ipcRenderer.invoke('mc-checkout:surface'),

  /* CONNECTING THIS COMPUTER TO AN ACCOUNT. Five verbs, matching the handlers
     in main.cjs and shell/device-claim.cjs behind them.

     poll() TAKES NO ARGUMENT, AND THAT IS THE SECURITY PROPERTY, NOT AN
     OMISSION. Opening a claim produces two things: a code for the person to
     type, and a poll token that collects the credential the account mints.
     The token is bearer-shaped, so it stays in the main process; begin()
     returns the code and never the token, and poll() has no parameter for a
     page to hand one back through. A renderer cannot collect a claim it did
     not open because it is never given the thing that collects one.

     Every reply is data, including the refusals: { ok:false, code, reason }
     with a code from device-claim's own closed set. Nothing here rejects, so
     no surface has to render an Error's message.

     WARNING, AND IT IS THE SAME ONE THIS FILE ALREADY MAKES ABOUT THE AGENT
     BRIDGE BELOW: this file is loaded by no window. main.cjs loads
     shell/fleet-profile-preload.cjs, which is the shell's composed boundary
     because a sandboxed preload cannot require a sibling. The exposure above
     is duplicated there for the chrome verbs and this one is NOT, so
     window.mcShell.deviceClaim does not exist on a real installation until
     the same five lines are added to that file. */
  deviceClaim: Object.freeze({
    status: () => ipcRenderer.invoke('mc-device-claim:status'),
    begin: (request) => ipcRenderer.invoke('mc-device-claim:begin', request),
    poll: () => ipcRenderer.invoke('mc-device-claim:poll'),
    cancel: () => ipcRenderer.invoke('mc-device-claim:cancel'),
    disconnect: () => ipcRenderer.invoke('mc-device-claim:disconnect'),
    // Fixed actions only. Main reads its owner-provisioned trusted context;
    // this boundary cannot select accounts, keys, paths or consent values.
    adminIdentity: () => ipcRenderer.invoke('mc-device-admin:run', 'identity'),
    adminPrepare: () => ipcRenderer.invoke('mc-device-admin:run', 'prepare'),
    adminImport: () => ipcRenderer.invoke('mc-device-admin:run', 'import'),
    adminFinalize: () => ipcRenderer.invoke('mc-device-admin:run', 'finalize'),
    adminResume: () => ipcRenderer.invoke('mc-device-admin:run', 'resume'),
    adminPairRequest: () => ipcRenderer.invoke('mc-device-admin:run', 'pair-request'),
    adminCancel: () => ipcRenderer.invoke('mc-device-admin:run', 'cancel'),
  }),
})

/* No agent bridge here, and that is not an oversight.

   THIS FILE IS NOT THE LOADED BOUNDARY. main.cjs loads
   shell/fleet-profile-preload.cjs (sandboxed preloads cannot require a
   sibling, so that file is the shell's composed boundary), and nothing
   outside the test suite references this one at all.

   The renderer's agent bridge is re-established there, with the full
   reasoning for why it is safe to re-establish. Exposing it here instead
   would have produced a green test over a dead feature -- the same defect
   class as BLOCKER 2 itself, which was a control that could only ever fail
   on a real installation. */

function rgbToHex(rgb) {
  const m = rgb.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/)
  if (!m) return '#fdfdfd'
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
}

let settleTimer = null
function report() {
  const send = () => {
    const cs = getComputedStyle(document.body)
    ipcRenderer.send('mc-theme', {
      theme: document.documentElement.dataset.theme || 'white',
      bg: rgbToHex(cs.backgroundColor),
      ink: rgbToHex(cs.color),
    })
  }
  /* Two passes: the page's surface eases between themes, so a single
     next-frame read sampled the OLD colour whenever the transition won the
     race — the owner saw the caption buttons stuck on the previous theme.
     The settle pass re-reads after the ease and always wins. */
  requestAnimationFrame(send)
  clearTimeout(settleTimer)
  settleTimer = setTimeout(send, 600)
}

/* The titlebar strip is injected from here, not built into the app source:
   the same dist/ keeps serving byte-identical in a plain browser, and the
   chrome lives with the shell that needs it. The strip's background is
   transparent — the themed body shows through, so it can never mismatch.
   Native caption buttons (min/max/close) are OS-drawn over the right edge;
   the whole strip is a drag region. Offsets below mirror the app's only
   viewport-sized rules: #stage 100vh, .topbar/.drawer top 14px. */
const TB = 36
function injectTitlebar() {
  document.documentElement.classList.add('in-shell')
  document.body.classList.add('in-shell')
  const style = document.createElement('style')
  style.textContent = `
    #shell-titlebar {
      position: fixed; top: 0; left: 0; right: 0; height: ${TB}px;
      z-index: 200; -webkit-app-region: drag;
      display: flex; align-items: center; justify-content: center;
      border-bottom: 1px solid var(--line, rgba(128,128,128,0.18));
      font-size: 11px; font-weight: 600; letter-spacing: 0.14em;
      color: var(--ink-3, #888); user-select: none;
    }
    /* Chromium inherits app-region through the renderer hit-test tree. Keep
       native and ARIA controls out of a draggable ancestor so a mouse press is
       delivered to the control instead of beginning a window drag. */
    button, input, select, textarea, a[href], [role="button"] {
      -webkit-app-region: no-drag;
    }
    html.in-shell { --shell-titlebar-height: ${TB}px; }
    html.in-shell #stage { height: calc(100vh - ${TB}px); margin-top: ${TB}px; }
    html.in-shell .topbar { top: calc(14px + ${TB}px); }
    html.in-shell .drawer { top: calc(14px + ${TB}px); }
    /* THE ONE FIXED SURFACE THIS LIST FORGOT. home.css's full-page chat
       takeover (.home-takeover) is position: fixed; inset: 0, its own top
       never touched here -- so its first child, .home-takeover-bar (the
       "Show" subject-picker + Close), painted its whole row inside this
       strip's own 0..TB band: submerged under a HIGHER z-index (200 against
       the takeover's 80) and, worse, under this strip's edge-to-edge drag
       region, which only exempts button/input/select/textarea/a[href]/
       [role=button] above -- not the label or the span that names the
       control, so a press on the word "Show" itself started a window drag
       instead of opening the picker. Same fix as #stage and .topbar: push
       the surface's own top down by the strip's height, the one thing this
       rule is already pattern for. inset:0 leaves the top value easy to
       override alone; bottom:0 is untouched, so the surface still shrinks
       to leave the room rather than spilling under the strip. */
    html.in-shell .home-takeover { top: ${TB}px; }
  `
  document.head.appendChild(style)
  const bar = document.createElement('div')
  bar.id = 'shell-titlebar'
  bar.textContent = 'TOOLSENABLED'
  document.body.prepend(bar)
}

window.addEventListener('DOMContentLoaded', () => {
  injectTitlebar()
  report()
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  })
  // a missed update (backgrounded window, throttled frames) heals on return
  window.addEventListener('focus', report)
})
