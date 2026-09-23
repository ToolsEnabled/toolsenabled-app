import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

test('the application shell offers a keyboard bypass to a focusable main landmark', () => {
  assert.match(html, /<a class="skip-link" href="#stage">Skip to main content<\/a>/)
  assert.match(html, /<main id="stage" tabindex="-1" aria-label="Current screen"><\/main>/)
  assert.match(css, /\.skip-link:focus-visible\s*{[^}]*transform:\s*none[^}]*outline:/s)
})

/* The skip link paints at z-index 10000 and the drawer at 80, so an open
   drawer does NOT cover it. Unless it is inerted alongside the rest of the
   page, a keyboard user tabs to a visible link drawn over the modal and
   follows it to a #stage that enforcePageGuard has just made inert.
   This asserts on the membership of behindDrawer rather than on a rendered
   DOM, which is the same limitation the two tests around it carry: it pins
   the source text, so a semantically equivalent rewrite would false-fail. It
   still bites the regression that matters -- dropping the skip link from the
   list -- which is the one that already happened once. */
test('an open drawer hides the skip link too, not just the header and stage', () => {
  const list = main.match(/const behindDrawer = \[([\s\S]*?)\]\.filter\(Boolean\)/)
  assert.ok(list, 'behindDrawer must remain a single declared list of what the open drawer hides')
  assert.match(list[1], /\.skip-link/)
  assert.match(list[1], /header\.topbar/)
  assert.match(list[1], /'stage'/)
})

test('the words beside the gear are part of the gear button’s hit area', () => {
  /* Measured on the desktop press-through (2026-08-27): "quick settings" sat
     beside the gear as a sibling span — it read as the control's name and took
     no press, twice, saying nothing. A label that names a control is part of
     the control, so the span lives INSIDE #open-settings now. It stays
     aria-hidden so the accessible name remains the one aria-label. */
  assert.match(html,
    /<button class="icon-btn" id="open-settings"[^>]*aria-label="Quick settings"[^>]*><span class="tb-settings-label" aria-hidden="true">Quick settings<\/span><svg/,
    'the "quick settings" words left the gear button; as a sibling span they are a name that takes no press')
  assert.doesNotMatch(html, /<span class="tb-settings-label"[^>]*><\/span>|<\/span>\s*<button class="icon-btn" id="open-settings"/,
    'a second settings label stands outside the button again')
})

test('single-page route changes are announced without stealing focus', () => {
  assert.match(html, /id="route-status" role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(main, /routeStatus\.textContent = `\$\{routeName\} screen loaded`/)
  assert.doesNotMatch(main, /routeStatus\.focus\s*\(/)
})

/* T1421: the app routes on location.hash, so the skip link's own href
   (#stage) was read as an unknown page and the reader was thrown to Home.
   Pressing it must move focus to the page content and leave the address
   alone: the default navigation is prevented, focus lands on #stage, and the
   entry point wires this on start. */
test('the skip link moves focus to the page content without changing the address', async () => {
  const mod = await import('../../src/skip-link.js').catch(() => null)
  assert.ok(mod?.keepSkipLinkOnPage, 'no skip-link handler: following #stage still changes the address and the router shows Home')
  const { createDocument } = await import('./lib/dom-stand-in.mjs')
  const doc = createDocument()
  const link = doc.createElement('a'); link.setAttribute('class', 'skip-link'); link.setAttribute('href', '#stage')
  const stage = doc.createElement('main'); stage.setAttribute('id', 'stage'); stage.setAttribute('tabindex', '-1')
  const other = doc.createElement('button')
  doc.body.append(link, stage, other)
  doc.querySelector = selector => doc.body.querySelector(selector)
  doc.getElementById = id => (id === 'stage' ? stage : null)
  doc.activeElement = link
  const stop = mod.keepSkipLinkOnPage(doc)
  const press = link.dispatch('click')
  assert.equal(press.defaultPrevented, true, 'the press still follows #stage as an address')
  assert.equal(doc.activeElement, stage, 'focus did not move to the page content')
  stop()
  const later = link.dispatch('click')
  assert.notEqual(later.defaultPrevented, true, 'the handler outlived its stop function')
  assert.match(main, /import \{ keepSkipLinkOnPage \} from '\.\/skip-link\.js'/)
  assert.match(main, /\nkeepSkipLinkOnPage\(document\)\n/)
})

/* T1558: each arrow names its destination as a person reaches for it. The
   caption hangs BELOW the arrow, which suits the top bar; in the side rail the
   arrows sit on the window's bottom edge inside a segment that clipped its
   overflow, so the word was drawn off screen and never seen. In the rail the
   caption must rise above its arrow, unclipped; where the rail is too narrow
   for a word (collapsed, or a window of 1100 px or less) it is not drawn and
   the arrow keeps its accessible name. The rendered check is the rig hand test
   (bughunt-rig scratch-research-nav/p6-arrow-caption.mjs). */
test('in the side rail the arrow caption rises above its arrow instead of below the window', () => {
  const nav = readFileSync(new URL('../../src/app-navigation.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = selector => {
    const at = nav.indexOf(`${selector} {`)
    return at < 0 ? null : nav.slice(nav.indexOf('{', at) + 1, nav.indexOf('}', at))
  }
  const side = 'body[data-navigation="side"]'
  assert.match(nav, new RegExp(`${side.replace(/[[\]"]/g, '\\$&')} \\.app-nav-history \\{ overflow: visible; \\}`), 'the rail segment still clips the caption')
  const caption = rule(`${side} .app-nav-history .icon-btn[data-dest]:not([data-dest=""])::after`)
  assert.ok(caption, 'no side-rail placement for the arrow caption: it hangs below the window edge')
  assert.match(caption, /top:\s*auto/)
  assert.match(caption, /bottom:\s*calc\(100% \+ \d+px\)/)
  assert.ok(rule(`${side}[data-navigation-collapsed="true"] .app-nav-history .icon-btn::after`)?.includes('display: none'), 'the collapsed rail draws a word it has no room for')
  const narrow = nav.slice(nav.indexOf('@media (max-width: 1100px)'))
  assert.match(narrow.slice(0, narrow.indexOf('\n}\n')), /\.app-nav-history \.icon-btn::after \{ display: none; \}/, 'the narrow rail draws a word it has no room for')
})

/* T1573: the shell's <main id="stage"> is the page's one main landmark, and
   eight views put their own <main class="view-pad ..."> inside it, so a screen
   reader listed two main regions, one inside the other, on Ledger, Settings,
   Vault, Tools, Account, Setup, Subscribe and Checkout. A view's root is a
   plain container inside the stage. The Research view is changed only by the
   owner's Research agent, so it is held to this separately (T1573 checkpoint). */
test('no view nests a second main landmark inside the stage', async () => {
  const { readdirSync } = await import('node:fs')
  const views = new URL('../../src/views/', import.meta.url)
  const offenders = []
  for (const name of readdirSync(views)) {
    if (!name.endsWith('.js') || name.startsWith('research')) continue
    const source = readFileSync(new URL(name, views), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    if (/<main\b/.test(source)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `these views put a <main> inside the shell's main landmark: ${offenders.join(', ')}`)
  assert.match(html, /<main id="stage"[^>]*>/, 'the shell lost its own main landmark')
})
