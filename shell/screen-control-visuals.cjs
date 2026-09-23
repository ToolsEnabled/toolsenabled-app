'use strict'
const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
const pointer = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 14 9-7 1-3 7Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/></svg>'
const barHtml = `<!doctype html>${policy}<style>
  :root{--accent:#7dd3fc;color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:6px;font:13px system-ui;color:#f5f8fc}
  main{height:60px;padding:10px;display:flex;align-items:center;gap:10px;background:#131d2bf5;border:1px solid #ffffff28;border-radius:15px;box-shadow:0 3px 12px #0004}
  .avatar{width:32px;height:32px;flex:none;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:10px;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}svg{width:18px;height:18px}
  .copy{flex:1;min-width:0}#label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650;letter-spacing:.01em}
  #detail{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#c1ccd9;margin-top:3px}
  button{flex:none;min-height:36px;border:1px solid #fda4af66;border-radius:9px;background:#562936;color:#ffe6e9;padding:7px 11px;font:600 11px system-ui;cursor:pointer}button:hover{background:#793244}button:focus-visible{outline:2px solid white;outline-offset:2px}
</style><main><span class="avatar">${pointer}</span><div class="copy"><span id="label">Computer control ready</span><small id="detail">Ctrl+Alt+Escape · stop all agents</small></div><button onclick="window.stopScreenControl()" aria-label="Stop all computer control">Stop all</button></main>`
const haloHtml = `<!doctype html>${policy}<style>
  :root{--accent:#7dd3fc}body{margin:0}.ring{position:absolute;inset:14px;border:1.5px solid var(--accent);border-radius:50%;box-shadow:0 0 0 3px #111d2bd9,0 3px 12px #0004;background:#142235e8;display:grid;place-items:center;color:var(--accent)}svg{width:21px;height:21px;filter:drop-shadow(0 1px 2px #0005)}
  .ripple{position:absolute;inset:14px;border:2px solid var(--accent);border-radius:50%;opacity:0}
  [data-action="click"] .ripple{animation:click 460ms ease-out}[data-action="drag"] .ring{box-shadow:0 0 0 5px color-mix(in srgb,var(--accent) 30%,transparent),0 3px 12px #0004}
  [data-action="type"] svg,[data-action="key"] svg{animation:working 900ms ease-in-out infinite alternate}
  @keyframes click{from{transform:scale(.9);opacity:.85}to{transform:scale(1.55);opacity:0}}@keyframes working{to{opacity:.5}}
  @media(prefers-reduced-motion:reduce){*{animation:none!important}.ring{border-width:3px}[data-action="click"] .ring{background:#304c63}}
</style><div class="ripple"></div><div class="ring">${pointer}</div>`
function agentAccent(agentId = '') {
  const palette = ['#7dd3fc', '#c4b5fd', '#6ee7b7', '#fcd34d', '#f9a8d4']
  let hash = 0
  for (const char of String(agentId)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}
const actionLabels = Object.freeze({ screenshot: 'Reading the screen', move: 'Moving the pointer', click: 'Clicking', drag: 'Dragging', scroll: 'Scrolling', type: 'Typing', key: 'Using the keyboard' })
// The stop chord is chosen at arming time, not written down here, because the
// platform decides which one this process is allowed to hold. Render whatever
// was armed in the short form people read on a key cap.
const shortcutWords = Object.freeze({ Control: 'Ctrl', CommandOrControl: 'Ctrl', Escape: 'Esc', Delete: 'Del' })
function shortcutLabel(accelerator) {
  if (!accelerator) return 'the Stop all button'
  return String(accelerator).split('+').map(part => shortcutWords[part] || part).join('+')
}
// THE ONE PLACE THE STOP CHORD IS DECIDED. It used to live in
// screen-control-indicator.cjs while src/screen-access-controls.js hard-coded
// "Ctrl + Alt + Esc" in its hint on every platform, so the grant screen taught
// a chord this build does not arm on Windows -- and which Windows reserves, so
// the documented way to stop an agent holding the mouse, keyboard and screen
// did nothing. It read correctly on Linux, which is why it survived review.
//
// Everything that shows the chord now derives from this constant. Do not add a
// second per-platform conditional anywhere else: a second copy of the rule is
// how that defect was born.
const STOP_SHORTCUT = process.platform === 'win32' ? 'Control+Alt+Shift+Escape' : 'Control+Alt+Escape'
module.exports = { barHtml, haloHtml, agentAccent, actionLabels, shortcutLabel, STOP_SHORTCUT }
