/* T52(2) fixture: the real sheets, the real top-bar skeleton, and a page long
   enough to scroll underneath it. Measurement only -- it builds no product
   behaviour and asserts nothing; the electron half reads pixels. */
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
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'

const settle = async () => {
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/* THE TEXT IS DELIBERATELY DARK AND DENSE. The band above the bar is proved
   empty by reading pixels, so the page scrolling under it has to be something a
   pixel test can actually see: pale or sparse text could pass this gate while
   the owner still saw words. */
const paragraphs = Array.from({ length: 80 }, (_, i) =>
  `<p style="margin:0 0 10px;color:#000;font-size:15px;line-height:18px">Row ${i} — the quick brown fox jumps over the lazy dog, and keeps going so this line reaches the top of the window when the page is scrolled.</p>`).join('')

document.body.style.cssText = 'margin:0;display:block'
document.body.innerHTML = `
  <header class="topbar">
    <div class="app-nav-brand"><a class="app-nav-home" href="#/"><span class="app-nav-wordmark">ToolsEnabled</span></a></div>
    <div class="tb-side tb-left"><button class="icon-btn" id="nav-back" type="button">back</button></div>
    <div class="tb-side tb-right"><button class="icon-btn" id="open-settings" type="button"><span class="tb-settings-label">Settings</span></button></div>
  </header>
  <main id="t52-scroller" style="position:fixed;inset:0;overflow-y:auto;padding:0">
    <div id="t52-content">${paragraphs}</div>
  </main>`

const scroller = () => document.getElementById('t52-scroller')

window.t52Header = {
  async ready() { await settle(); return true },
  async scrollTo(y) {
    scroller().scrollTop = y
    await settle()
    return scroller().scrollTop
  },
  /* Geometry as the browser resolves it, so a failure says WHICH part moved:
     the bar's own inset, or the cover that hides the band above it. */
  async measure() {
    await settle()
    const bar = document.querySelector('.topbar')
    const barBox = bar.getBoundingClientRect()
    const barStyle = getComputedStyle(bar)
    const coverStyle = getComputedStyle(bar, '::before')
    const body = getComputedStyle(document.body)
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollTop: scroller().scrollTop,
      barTop: Math.round(barBox.top * 100) / 100,
      barBottom: Math.round(barBox.bottom * 100) / 100,
      barPosition: barStyle.position,
      background: body.backgroundColor,
      cover: {
        content: coverStyle.content,
        position: coverStyle.position,
        top: coverStyle.top,
        left: coverStyle.left,
        right: coverStyle.right,
        height: coverStyle.height,
        background: coverStyle.backgroundColor,
      },
    }
  },
}
