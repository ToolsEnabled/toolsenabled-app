/* D1/D2 sharpness fixture: the real sheets, the real top-bar skeleton, and
   the resting compositing state of the three text families that carried a
   permanent will-change. Measurement only -- it builds no product behaviour. */
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

document.body.style.cssText = 'margin:0;display:block'
document.body.innerHTML = `
  <header class="topbar">
    <div class="app-nav-brand"><a class="app-nav-home" href="#/"><span class="app-nav-wordmark">ToolsEnabled</span></a></div>
    <div class="tb-side tb-left"><button class="icon-btn" id="nav-back" type="button">back</button></div>
    <div class="tb-side tb-right"><button class="icon-btn" id="open-settings" type="button"><span class="tb-settings-label">Settings</span></button></div>
  </header>
  <div class="graph-canvas" style="position:relative;height:240px">
    <div class="node role-default" id="probe-node"><div class="node-glass">Node label</div></div>
    <div class="chip" id="probe-chip" style="width:168px">Context chip</div>
  </div>
  <table class="mtable"><tbody><tr id="probe-row"><td>Agent</td><td>12</td></tr></tbody></table>
`

const bar = () => document.querySelector('.topbar')

window.topbarSharpness = {
  async measure(route) {
    if (route === 'sidebar') {
      document.body.dataset.navigation = 'side'
      document.body.dataset.route = 'metrics'
    } else {
      delete document.body.dataset.navigation
      document.body.dataset.route = 'home'
    }
    await settle()
    const rect = bar().getBoundingClientRect()
    const style = getComputedStyle(bar())
    return {
      route,
      viewportWidth: window.innerWidth,
      gutter: getComputedStyle(document.body).getPropertyValue('--page-gutter').trim(),
      left: rect.left,
      width: rect.width,
      transform: style.transform,
      position: style.position,
      leftIsWhole: Number.isInteger(rect.left),
      /* The offset a true centre would land on, reported alongside the painted
         one: where this is fractional, the old `left: 50%` +
         `translateX(-50%)` pair could not have produced a whole left edge. */
      exactCentre: (window.innerWidth - rect.width) / 2,
      /* A dropped declaration would leave the strip at its static position;
         a bar that is not centred is not a pass however whole its left edge.
         Half a pixel is the most a whole-pixel rounding can move it. */
      centred: Math.abs((window.innerWidth - rect.width) / 2 - rect.left) <= 0.5,
    }
  },
  async resting() {
    await settle()
    const node = document.getElementById('probe-node')
    const read = element => getComputedStyle(element).willChange
    const atRest = read(node)
    node.classList.add('dragging')
    await settle()
    const dragging = read(node)
    node.classList.remove('dragging')
    await settle()
    return {
      node: atRest,
      nodeDragging: dragging,
      nodeAfterDrag: read(node),
      chip: read(document.getElementById('probe-chip')),
      metricsRow: read(document.getElementById('probe-row')),
    }
  },
}
