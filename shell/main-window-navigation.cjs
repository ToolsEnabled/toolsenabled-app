'use strict'
/* THE APPLICATION WINDOW SHOWS THE APPLICATION AND NOTHING ELSE (1.0.50 M3).
 *
 * Chat, tool and comms text renders every http(s) URL as a target="_blank"
 * link whose label the sender chooses. With no window-open handler, Electron
 * answered a click by opening a chromeless BrowserWindow in the application's
 * own session: no address bar, no menu, the session's permission handlers and
 * its projection header. A deceptively labelled link was therefore a page that
 * looked like part of this product.
 *
 * Now a new window is never opened here. A web address is handed to the
 * person's own browser, where it has an address bar and none of this
 * session's grants; an address on the application's own origin, and anything
 * that is not a web address, is dropped. The main frame may navigate only
 * within the application's own origin; a web address it is sent to goes to
 * the browser the same way (a checkout link, for instance), and is never
 * loaded in place of the application.
 *
 * remote-workspace.cjs applies the same will-navigate rule to its window. */
const MAX_EXTERNAL_URL_LENGTH = 8192

/* The one address shape handed to the operating system: http or https, a
   host, no embedded user name or password, bounded. The parsed href is what
   is handed over, never the raw string. Anything else -- file:, a custom
   protocol, javascript:, data: -- returns null and is not opened at all. */
function externalBrowserUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_EXTERNAL_URL_LENGTH) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  return url.href
}

function sameOrigin(address, origin) {
  try { return typeof origin === 'string' && origin !== '' && new URL(address).origin === new URL(origin).origin } catch { return false }
}

function installMainWindowNavigationGuard(contents, { origin, openExternal }) {
  const ownOrigin = () => { try { return typeof origin === 'function' ? origin() : origin } catch { return null } }
  const handOff = address => {
    const target = externalBrowserUrl(address)
    if (!target) return
    try { Promise.resolve(openExternal(target)).catch(() => {}) } catch { /* the link simply does not open */ }
  }
  contents.setWindowOpenHandler(details => {
    /* A new-window request for one of the application's own pages -- a
       Ctrl-click or middle click on an in-app link, or window.open of one --
       is denied and handed nowhere (1.0.50 review of fixes, 3.4). The system
       browser would get a copy with no session and no preload, which is
       inert, and the page is already in this window. */
    const address = details?.url
    if (!sameOrigin(address, ownOrigin())) handOff(address)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, legacyUrl) => {
    const address = typeof event?.url === 'string' ? event.url : legacyUrl
    if (sameOrigin(address, ownOrigin())) return
    event.preventDefault()
    handOff(address)
  })
}

module.exports = { installMainWindowNavigationGuard, externalBrowserUrl, sameOrigin, MAX_EXTERNAL_URL_LENGTH }
