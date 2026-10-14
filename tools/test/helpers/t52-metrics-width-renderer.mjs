/* T52(3) fixture: the real sheets, and each page's own shell, measured as the
   browser resolves it. Measurement only -- it builds no product behaviour.

   THE POINT OF COMPARISON IS THE OTHER PAGES, not a number I chose. The owner
   said Metrics has "huge side gaps at times"; "at times" is a comparison across
   widths and across pages, so the fixture mounts four shells under the same
   navigation and reports each one's content box. A rule that made Metrics 1200px
   everywhere would satisfy a fixed-number test and still look wrong beside
   Computers. */
import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/app-navigation.css'
import '../../../src/sidebar-pages.css'
import '../../../src/readability.css'
import '../../../src/tree-graph.css'
import '../../../src/metrics.css'
import '../../../src/metrics-dashboard.css'
import '../../../src/ledger.css'
import '../../../src/settings.css'
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'

const settle = async () => {
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/* Each route's real outermost page element, with enough inside it to have a
   natural width. The inner block is identical everywhere on purpose: if one
   page comes out narrower, that is the page's own rule and not its contents. */
const FILLER = '<div style="height:400px"><p>content</p></div>'
const PAGES = Object.freeze({
  computers: { route: 'computers', html: `<div class="computers">${FILLER}</div>`, selector: '.computers' },
  ledger: { route: 'ledger', html: `<div class="ledger-shell">${FILLER}</div>`, selector: '.ledger-shell' },
  settings: { route: 'settings', html: `<div class="settings-shell">${FILLER}</div>`, selector: '.settings-shell' },
  metrics: { route: 'metrics', html: `<div class="metrics">${FILLER}</div>`, selector: '.metrics' },
})

document.body.style.cssText = 'margin:0;display:block'
document.body.setAttribute('data-navigation', 'side')

window.t52Metrics = {
  async measure(name) {
    const page = PAGES[name]
    if (!page) return { error: `no such page ${name}` }
    document.body.setAttribute('data-route', page.route)
    document.body.innerHTML = page.html
    await settle()
    const node = document.querySelector(page.selector)
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const round = value => Math.round(value * 100) / 100
    return {
      page: name,
      route: page.route,
      viewportWidth: window.innerWidth,
      width: round(box.width),
      left: round(box.left),
      right: round(window.innerWidth - box.right),
      /* The gap the owner sees is the sum of both sides. Reported directly so a
         failure reads in the owner's terms rather than in box coordinates. */
      sideGap: round(box.left + (window.innerWidth - box.right)),
      declaredWidth: style.width,
      maxWidth: style.maxWidth,
      marginInline: `${style.marginLeft} / ${style.marginRight}`,
      pageMax: getComputedStyle(document.body).getPropertyValue('--page-max').trim(),
      pageGutter: getComputedStyle(document.body).getPropertyValue('--page-gutter').trim(),
    }
  },
}
