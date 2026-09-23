/* PROMPT B. THE HOTLOAD STALENESS INDICATOR.
 *
 * WHY IT EXISTS. A window served by the dev server keeps drawing, animating and
 * responding long after its update channel has gone. Nothing on the glass
 * changes, so the page looks current and is not. The owner has reported
 * finished work as missing five separate times from exactly that state --
 * including once when the fix was in the served code and their window could not
 * receive it. The cost is not a stale pixel; it is a person disbelieving work
 * that is done, and the only defence is for the page to say so itself.
 *
 * WHAT IT MEASURES, AND IT IS NOT A TIMER. One thing: the socket that delivers
 * code to THIS page, reported by the client that owns it. Vite fires
 * `vite:ws:disconnect` whenever that socket closes uncleanly and
 * `vite:ws:connect` when it opens. Nothing here counts seconds, watches for a
 * missing heartbeat, or infers anything from how long it has been quiet.
 *
 * IT COVERS A CHANNEL THAT NEVER OPENED, TOO, and by the same signal rather
 * than by a second mechanism. A client that cannot reach the server closes
 * uncleanly and fires the same disconnect, then retries and fires it again on
 * every failure -- so a page that never connected is a page reporting
 * disconnect, and it keeps reporting it until it succeeds.
 *
 * WHAT IT REFUSES TO SAY. It does not claim to know whether this page was ever
 * connected. This module is started by the shell and can miss a connect that
 * happened before it was running, so "it dropped" and "it never opened" are not
 * distinguishable from here -- and they need no distinguishing, because the
 * only thing a reader must do about either is the same. One sentence, true in
 * both, beats two sentences one of which is a guess.
 *
 * A PROBE SOCKET WAS TRIED AND REMOVED. Opening a second websocket to the same
 * endpoint looked like a way to answer "was it ever up". It answered the wrong
 * question -- a probe proves the SERVER is reachable, never that this page's
 * client is connected -- and in Vite 6 it also fails outright, because the HMR
 * endpoint requires the per-server token that only Vite's own client holds
 * (handshake 400). It was showing this banner on healthy pages. Measured, not
 * reasoned about: tools/hotload-status-qa.mjs is what caught it.
 *
 * NEVER IN A PACKAGED BUILD. The caller reaches this module only inside
 * `if (import.meta.hot)`, which Vite replaces with `undefined` when it builds,
 * so the branch is dead code and this file never enters the bundle. It is also
 * why the hot object is passed in rather than read here: this module has no
 * opinion about how the caller proved it is in dev.
 *
 * NOT PRODUCT CHROME. Every rule it needs is set inline on its own element. It
 * imports no stylesheet and defines no class the product could pick up, so
 * there is nothing here for a build to inherit even by accident.
 */

const BANNER_ID = 'dev-hotload-status'

// Blunt on purpose. The whole job of this text is to stop somebody trusting
// what they are looking at, so it says the state first and the remedy second.
export const HOTLOAD_COPY = Object.freeze({
  title: 'This page is stale',
  body: 'This window is not connected to the dev server, so it is not receiving code changes. Reload to see the current code.',
})

const style = (node, rules) => { for (const [key, value] of Object.entries(rules)) node.style.setProperty(key, value, 'important') }

function buildBanner(doc) {
  const el = doc.createElement('div')
  el.id = BANNER_ID
  el.setAttribute('role', 'alert')
  el.setAttribute('data-dev-hotload-status', 'down')
  el.hidden = true
  style(el, {
    position: 'fixed', top: '0', left: '0', right: '0', 'z-index': '2147483647',
    /* NOT `display` -- see setVisible. An inline `display: flex !important`
       here outranks the UA rule behind the `hidden` attribute, so the banner
       was on the glass of a healthy page while `el.hidden` read true. The DOM
       stand-in has no cascade, so the unit tests could not see it and the
       browser driver did: tools/hotload-status-qa.mjs. */
    'align-items': 'center', gap: '12px',
    padding: '10px 14px', margin: '0', border: '0', 'border-bottom': '2px solid #000',
    background: '#ffd400', color: '#111', 'text-align': 'left',
    font: '600 13px/1.4 ui-sans-serif, system-ui, sans-serif', 'pointer-events': 'auto',
  })
  const words = doc.createElement('span')
  words.setAttribute('data-dev-hotload-words', '')
  style(words, { flex: '1 1 auto', 'min-width': '0' })
  const title = doc.createElement('strong')
  title.setAttribute('data-dev-hotload-title', '')
  const body = doc.createElement('span')
  body.setAttribute('data-dev-hotload-body', '')
  style(body, { 'font-weight': '400', 'margin-left': '6px' })
  words.append(title, body)
  const reload = doc.createElement('button')
  reload.type = 'button'
  reload.setAttribute('data-dev-hotload-reload', '')
  reload.textContent = 'Reload now'
  style(reload, {
    flex: '0 0 auto', padding: '6px 12px', border: '1px solid #111', 'border-radius': '4px',
    background: '#111', color: '#ffd400', font: '600 13px/1.4 ui-sans-serif, system-ui, sans-serif', cursor: 'pointer',
  })
  // Named as the dev instrument it is, so nobody reads it as product chrome.
  const mark = doc.createElement('span')
  mark.setAttribute('data-dev-hotload-mark', '')
  mark.textContent = 'hotload'
  style(mark, { flex: '0 0 auto', 'font-weight': '700', 'letter-spacing': '.08em', 'text-transform': 'uppercase', 'font-size': '11px', opacity: '.75' })
  el.append(mark, words, reload)
  return { el, title, body, reload }
}

/**
 * @param hot        Vite's `import.meta.hot`, passed in by the caller that proved it is in dev.
 * @param doc        document seam, for tests.
 * @param connect    opens the probe socket; seam, for tests.
 * @param reload     what "Reload now" does; seam, for tests.
 */
export function startHotloadStatus(hot, {
  doc = document,
  reload = () => location.reload(),
} = {}) {
  if (!hot || typeof hot.on !== 'function') return null
  const parts = buildBanner(doc)
  const mount = () => { if (!parts.el.isConnected && doc.body) doc.body.append(parts.el) }
  /* One switch for both the attribute and the box, so they cannot disagree. */
  const setVisible = on => {
    parts.el.hidden = !on
    parts.el.style.setProperty('display', on ? 'flex' : 'none', 'important')
  }
  setVisible(false)
  mount()
  parts.reload.addEventListener('click', () => reload())

  let state = 'unknown'
  let stopped = false

  const show = () => {
    if (stopped) return
    state = 'down'
    parts.title.textContent = HOTLOAD_COPY.title
    parts.body.textContent = HOTLOAD_COPY.body
    parts.el.setAttribute('data-dev-hotload-status', 'down')
    setVisible(true)
    mount()
  }
  const clear = () => {
    if (stopped) return
    state = 'up'
    parts.el.setAttribute('data-dev-hotload-status', 'up')
    setVisible(false)
  }

  hot.on('vite:ws:connect', () => clear())
  hot.on('vite:ws:disconnect', () => show())

  return {
    el: parts.el,
    state: () => state,
    stop() { stopped = true; parts.el.remove() },
  }
}
