/* Electron-owned Page 2 verification. Run after `npm run build`:
   node shell/launch.cjs is the human shell; this harness keeps its own
   hidden window, drives real pointer input, and writes screenshots to a
   temporary directory for visual inspection. */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { selectRendererDist, rendererRequestPath } = require('./lib/qa-renderer-dist.cjs')

const ROOT = path.join(__dirname, '..')
// --release binds this renderer exercise to the candidate's archive, not ROOT/dist.
const RENDERER = selectRendererDist({ argv: process.argv, repoRoot: ROOT })
const DIST = RENDERER.dist
/* THE EXAMPLE BOARD HAS TWELVE TREE NODES, AND THIS CONSTANT HAS NOW BEEN STALE
   TWICE FOR THE SAME REASON.

   It was nine (the retired declared-fleet seats), then five when 485addf2
   removed them: src/sample-trees.js seeded three frozen trees with 2 + 2 + 1
   nodes. On 2026-09-11 f2f65558 ("Play the example fleet's working tree through
   the states the product shows") made the page's own store ask for the
   simulation -- src/views/computers.js:4950 passes `simulation: true` -- and
   createSampleTreeStore then keeps only 'can you open chrome' and seeds
   seedSampleSimTree beside it (src/sample-trees.js:116-127). That commit
   changed no harness.

   MEASURED ON THE GLASS, 2026-09-11, in this exact harness's own window, rather
   than counted in the store -- and the difference is the whole point. The store
   holds TWELVE nodes: createSampleTreeStore({ simulation: true }) seeds
   seedSampleSimTree's eleven (= SAMPLE_SIM_AGENTS.length, pinned by
   tools/test/sample-simulation.test.mjs:68) and keeps the single-node
   'can you open chrome' tree beside it. The CANVAS draws FOUR, and it draws them
   stably from the first second to the forty-fifth:

     Controller  CONTROLLER  running        11 agents >
     Manager     MANAGER     running         5 agents >
     Manager 2   MANAGER     running         5 agents >
     Default     DEFAULT     did not start

   The children are not hidden records, they are not in the document at all
   (`[hidden]` count zero, `window.__mcGraph.nodes.size === 4`,
   `__mcGraph.rootId === null`): the drawn level carries a drill-in and the
   agents beneath it are counted on their parent's chip. So twelve would have
   been just as wrong as five, for the opposite reason, and a source-side count
   of the seed data would have produced it.

   The exact equality stays, for the reason it was first written: `> 0` would let
   a partially seeded example pass and `>= 4` would let a retired shape leak back
   onto the canvas. What was missing is a harness that says what it SAW when the
   number disagrees, instead of timing out with a sentence that reads as "the
   product never rendered its tree" -- which is how this defect reached a lane
   brief as a suspected product failure. waitFor now reports the observed value. */
const EXPECTED_EXAMPLE_TREE_NODES = 4
const results = []
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const check = (name, pass, detail = '') => {
  results.push({ name, pass: Boolean(pass), detail })
  if (!pass) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
}

function serveDist() {
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requested = rendererRequestPath(DIST, request.url)
      if (!requested) {
        response.writeHead(403)
        response.end()
        return
      }
      fs.readFile(requested, (error, data) => {
        if (error) {
          response.writeHead(404)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': mime[path.extname(requested)] || 'application/octet-stream' })
        response.end(data)
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/* A TIMEOUT MUST SAY WHAT IT SAW, or it is an accusation rather than a
   measurement. `Timed out waiting for .static-tree-node.length === 5` reads as
   "the page never drew its tree"; the page had drawn twelve, and establishing
   which of the two it was cost a lane a day (see EXPECTED_EXAMPLE_TREE_NODES).
   `observe` is evaluated only on the failure path, and its own failure is
   reported rather than allowed to replace the timeout. */
async function waitFor(webContents, expression, timeout = 6000, observe = null) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return
    await delay(50)
  }
  let seen = ''
  if (observe) {
    try { seen = `; observed ${JSON.stringify(await webContents.executeJavaScript(observe))}` }
    catch (error) { seen = `; the page could not be asked what it held: ${error.message}` }
  }
  throw new Error(`Timed out waiting for ${expression}${seen}`)
}

async function pressVisibleControl(webContents, selector, clickCount = 1) {
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return null;
    const box = element.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, width: box.width, height: box.height, hit: hit?.className || hit?.tagName || null,
      pointerEvents: getComputedStyle(element).pointerEvents,
      reachable: box.width > 0 && box.height > 0 && x >= 0 && y >= 0
        && x < innerWidth && y < innerHeight && (hit === element || element.contains(hit)) };
  })()`
  let target
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    target = await webContents.executeJavaScript(expression)
    if (target?.reachable) break
    await delay(50)
  }
  check(`visible pointer reaches ${selector}`, target?.reachable, JSON.stringify(target))
  webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
  webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount })
  webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount })
}

async function chooseShape(webContents, shape) {
  if (!['circles', 'boxes'].includes(shape)) throw new Error('Unknown QA shape')
  await pressVisibleControl(webContents, '.tree-shape-select')
  for (const keyCode of [shape === 'circles' ? 'Home' : 'End', 'Return']) {
    webContents.sendInputEvent({ type: 'keyDown', keyCode })
    webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  await waitFor(webContents, `document.querySelector('.static-tree-graph')?.dataset.nodeStyle === ${JSON.stringify(shape)}`)
}

/* WHAT IS STILL MOVING, NAMED.
   This used to be an inline `.map(a => ({ target: a.effect.target.className }))`,
   and on an SVG element `className` is an SVGAnimatedString, which
   JSON.stringify renders as `{}`. The intermittent red this harness was known
   for therefore reported
     [{"target":{},"animationName":"none","type":"CSSTransition"}]
   -- a failure message that names nothing, on a check whose whole job is to say
   what has not settled. A check that cannot name its own defect is not a check.
   `getAttribute('class')` reads the same string on HTML and SVG alike. */
/* ONE ROUND TRIP, THREE WAYS FOR THE PAGE TO STILL BE MOVING.
   Animations and frame callbacks are not the only ones. A ResizeObserver on the
   graph container calls resize() -> _layoutNow() -> _placeChips(), and in a
   window that has never been shown the container's measured size arrives late,
   so the chip placement can run AFTER a settle window that only watched
   animations. That is what made "flat context labels do not collide" red on an
   unchanged tree: the chips were measured mid-placement, not overlapping.
   The geometry fingerprint below closes that: a layout that is still moving is
   not settled, whatever mechanism is moving it. */
const SETTLE_SAMPLE = `(() => {
  const describe = (element) => {
    if (!(element instanceof Element)) return String(element);
    const classes = (element.getAttribute('class') || '').trim();
    return element.tagName.toLowerCase() + (classes ? '.' + classes.split(/\\s+/).join('.') : '');
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(',');
  };
  const layout = [
    ...document.querySelectorAll('.static-tree-node'),
    ...document.querySelectorAll('.static-tree-chip'),
    ...document.querySelectorAll('.static-tree-links .tree-link'),
  ].map(element => describe(element) + '@' + box(element)).join('|');
  const animations = document.getAnimations()
    .filter(animation => {
      const target = animation.effect && animation.effect.target;
      return target instanceof Element
        && typeof target.closest === 'function'
        && Boolean(target.closest('.computers'))
        && !target.closest('.tree-node-adding, .tree-node-removing');
    })
    /* PENDING COUNTS AS UNSETTLED. A transition that has been created but has
       not been given a start time yet reports playState 'running' with
       currentTime 0, and this window is deliberately hidden, so it can sit
       there for seconds. Treating it as settled would be reading "no frame has
       been produced" as "nothing is moving". */
    .filter(animation => animation.playState === 'running' || animation.pending === true)
    .map(animation => {
      const timing = (animation.effect.getComputedTiming && animation.effect.getComputedTiming()) || {};
      return {
        type: animation.constructor.name,
        property: animation.transitionProperty || animation.animationName || null,
        target: describe(animation.effect.target),
        playState: animation.playState,
        pending: animation.pending === true,
        currentTime: Math.round(Number(animation.currentTime) || 0),
        duration: timing.duration,
        iterations: timing.iterations,
        perpetual: timing.iterations === Infinity || timing.duration === Infinity,
      };
    });
  /* DIAGNOSTIC ONLY, asserted on by nothing: when the page will not settle, the
     first question is always "what is moving", and the answer is unhelpful if
     the only list shown has already been narrowed to the subtree under test. */
  const everything = document.getAnimations()
    .filter(animation => animation.playState === 'running' || animation.pending === true)
    .slice(0, 12)
    .map(animation => {
      const target = animation.effect && animation.effect.target;
      const timing = (animation.effect && animation.effect.getComputedTiming && animation.effect.getComputedTiming()) || {};
      return describe(target) + ' ' + animation.constructor.name
        + ' ' + (animation.transitionProperty || animation.animationName || '')
        + (timing.iterations === Infinity ? ' [perpetual]' : '');
    });
  return { raf: window.__qaRafCount, animations, layout, everything };
})()`

/* SETTLE, DO NOT SAMPLE AT A FIXED OFFSET.
   The two checks below ("no idle requestAnimationFrame callbacks", "no settled
   Page 2 CSS animation") used to read `await delay(900)` and then take ONE
   reading. That measures "was the page quiet at t=900ms", which is a property
   of the machine's load, not of the software: a 120ms transition that starts at
   t=850 is indistinguishable at a single instant from a transition that never
   ends. Measured on an unchanged tree, five concurrent runs at a time: 14/15
   green, and the one red was a real 120ms CSSTransition on an SVG chip-leader
   dot that had merely started late.

   So the invariant is stated as what it always meant: the page REACHES an idle
   state, and once idle it STAYS idle. A perpetual animation or a self-renewing
   requestAnimationFrame loop -- the defects these checks exist to catch -- never
   reaches the idle state at all and still fails, on any machine, at any load.
   Nothing is loosened: the settled reading must still be exactly zero on both
   counts, and the frame counter is reset before the final quiet window so a
   loop that starts late cannot hide behind frames that were legitimate during
   mount. */
async function settlePage2(webContents, { deadlineMs = 12000, quietMs = 400 } = {}) {
  const started = Date.now()
  let quietSince = Date.now()
  let previous = { raf: -1, layout: null }
  let sample = { raf: 0, animations: [], layout: '' }
  while (Date.now() - started < deadlineMs) {
    sample = await webContents.executeJavaScript(SETTLE_SAMPLE)
    const quiet = sample.animations.length === 0
      && sample.raf === previous.raf
      && sample.layout === previous.layout
    previous = sample
    if (!quiet) {
      quietSince = Date.now()
      await delay(80)
      continue
    }
    if (Date.now() - quietSince >= quietMs) {
      await webContents.executeJavaScript('window.__qaRafCount = 0')
      await delay(quietMs)
      const after = await webContents.executeJavaScript(SETTLE_SAMPLE)
      return {
        settled: true,
        settleMs: Date.now() - started,
        idleRafCallbacks: after.raf,
        runningAnimations: after.animations,
        layoutMovedWhileIdle: after.layout !== sample.layout,
        anythingStillRunning: after.everything,
      }
    }
    await delay(80)
  }
  return {
    settled: false,
    settleMs: Date.now() - started,
    idleRafCallbacks: sample.raf,
    runningAnimations: sample.animations,
    layoutMovedWhileIdle: true,
    anythingStillRunning: sample.everything,
  }
}

async function run() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-page2-qa-'))
  app.setPath('userData', path.join(outputDir, 'profile'))
  app.commandLine.appendSwitch('disable-gpu')
  const server = await serveDist()
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: '#f2e5bc',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const webContents = window.webContents
  const rendererErrors = []
  webContents.on('console-message', (event) => {
    const level = typeof event.level === 'number' ? event.level : 0
    const message = event.message || 'unknown renderer error'
    const expectedDiscoveryMiss = /blocked by CORS policy|ERR_FAILED.*461[0-9]/.test(message)
    /* NOT A RENDERER ERROR: Chromium's own note that ResizeObserver delivery
       was deferred one frame because observed layout changed inside the
       callback. It is emitted at error level, but the spec defines it as the
       loop-breaker working as designed, and on this page it appears under
       machine load alone: on 2026-08-19, with the packaged suite churning the
       machine, the PREVIOUS confirming tree a3e9f85 -- green on its own
       confirming run -- went red on exactly this message 7 runs out of 7
       (3 sequential + 4 concurrent), same driver bytes, same dist recipe.
       A check that reds on an unchanged, previously-green product is
       measuring the weather, not the renderer. Whether the graph's
       resize->layout->placeChips chain ever fails to TERMINATE is what the
       settle checks below measure, and they still demand exactly zero
       residual motion. Every other error-level message still fails here. */
    const expectedLoadDeferral = message.includes('ResizeObserver loop completed with undelivered notifications')
    if (!expectedDiscoveryMiss && !expectedLoadDeferral && (level >= 3 || event.level === 'error')) {
      rendererErrors.push(message)
      results.push({ name: 'renderer console', pass: false, detail: message })
    }
  })

  await window.loadURL(`${origin}/`)
  await webContents.executeJavaScript(`document.fonts.ready.then(() => true)`)
  await webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
  // A fresh profile deliberately offers a guide. Use its actual preference
  // and close controls; do not remove its DOM or write private guide keys.
  await waitFor(webContents, `document.querySelector('.first-use-layer:not([hidden]) .first-use-quiet')`)
  await pressVisibleControl(webContents, '.first-use-layer:not([hidden]) .first-use-quiet')
  await waitFor(webContents, `document.querySelector('.first-use-quiet')?.textContent === 'Turn on new-page tips'`)
  await pressVisibleControl(webContents, '.first-use-layer:not([hidden]) .first-use-close')
  await waitFor(webContents, `document.querySelector('.first-use-layer')?.hidden === true`)
  /* One key stands where the two per-view flags stood: mc.example 'on' shows
     the example fleet on every screen (src/data-source.js). */
  await webContents.executeJavaScript(`
    localStorage.setItem('mc.example', 'on');
    localStorage.setItem('mc.theme', 'tan');
    location.hash = '#/computers/c1';
    location.reload();
  `)
  await waitFor(webContents, `document.querySelectorAll('.static-tree-node').length === ${EXPECTED_EXAMPLE_TREE_NODES} && window.__mcGraph`,
    6000, `({ staticTreeNodes: document.querySelectorAll('.static-tree-node').length, graph: Boolean(window.__mcGraph), hash: location.hash })`)
  /* WAIT FOR THE FONTS BEFORE STARTING THE SETTLE WINDOW.
     Web fonts land after first paint and change text metrics with NO DOM
     mutation and NO resize event, so nothing in the page announces them. Any
     relayout they trigger — and a label's box is exactly what a font swap
     moves — landed inside the 900ms settle window below and was counted as
     unsettled activity. That is the most likely cause of this harness's
     intermittent reds on "no idle requestAnimationFrame callbacks" and on "no
     settled Page 2 CSS animation" with target `node-labels`, both of which
     fire here, before any node has been clicked.
     Diagnosed by the agent-subpage lane, which hit the same class of bug in
     its own harness: its roster measured 149px against a settled 251px, and
     `await document.fonts.ready` removed it.
     This is a fix to the INSTRUMENT's timing, not a loosening of what it
     asserts — every check below still demands exactly what it demanded. */
  await webContents.executeJavaScript(`document.fonts.ready.then(() => true)`)
  await webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
  await waitFor(webContents, `document.querySelector('.tree-shape-select') && document.querySelector('.tree-card-size-select')`)
  const boxes = await webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('.static-tree-node')];
    return { shape: document.querySelector('.tree-shape-select').value,
      choices: [...document.querySelector('.tree-shape-select').options].map(option => option.value),
      size: document.querySelector('.tree-card-size-select').value,
      nodes: nodes.map(node => { const style = getComputedStyle(node.querySelector('.node-glass'));
        return { boxed: node.classList.contains('tree-agent-box'), top: style.borderTopWidth,
          side: style.borderLeftWidth, fill: style.backgroundImage, shadow: style.boxShadow }; }) };
  })()`)
  check('fresh tree offers both shapes and starts with medium Boxes', boxes.shape === 'boxes'
    && boxes.size === 'medium' && JSON.stringify(boxes.choices) === JSON.stringify(['circles', 'boxes']), JSON.stringify(boxes))
  check('Box cards retain the current 4px header rim, 2px side rim, shaded header and depth',
    boxes.nodes.length === EXPECTED_EXAMPLE_TREE_NODES && boxes.nodes.every(node => node.boxed
      && node.top === '4px' && node.side === '2px' && node.fill.startsWith('linear-gradient(') && node.shadow !== 'none'), JSON.stringify(boxes.nodes))
  // First paint can precede the router's entry fade. Capture the actual
  // finished view, without disabling animation or changing its styles.
  // A hidden Electron window can report final computed opacity while its
  // captured compositor surface still contains an earlier frame.
  window.setPosition(-2400, -1400)
  window.showInactive()
  await waitFor(webContents, `(() => {
    const views = [...document.querySelectorAll('.view')];
    return views.length > 0 && views.every(view => !view.classList.contains('enter')
      && !view.classList.contains('exit') && getComputedStyle(view).opacity === '1')
      && !document.getAnimations().some(animation => animation.effect?.target?.classList?.contains('view')
        && (animation.playState === 'running' || animation.pending === true));
  })()`, 10000)
  await webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
  await delay(120)
  fs.writeFileSync(path.join(outputDir, 'boxes-tan-1600x900.png'), (await webContents.capturePage()).toPNG())
  window.hide()
  // The original flat-material and context-chip checks describe Circles.
  // Select it through the shipped control, retaining those strict checks.
  await chooseShape(webContents, 'circles')
  check(`native shape control switches the same ${EXPECTED_EXAMPLE_TREE_NODES} nodes to Circles`, await webContents.executeJavaScript(`
    document.querySelector('.tree-shape-select').value === 'circles'
      && document.querySelectorAll('.static-tree-node').length === ${EXPECTED_EXAMPLE_TREE_NODES}`))
  await webContents.executeJavaScript(`(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => query === '(prefers-reduced-motion: reduce)'
      ? { matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
      : nativeMatchMedia(query);
    document.body.classList.remove('reduce-motion');
    window.__qaNativeRaf = window.requestAnimationFrame.bind(window);
    window.__qaNativeCancelRaf = window.cancelAnimationFrame.bind(window);
    window.__qaRafCount = 0;
    window.requestAnimationFrame = callback => setTimeout(() => { window.__qaRafCount += 1; callback(performance.now()) }, 16);
    window.cancelAnimationFrame = handle => clearTimeout(handle);
  })()`)
  /* STATED LIMIT OF THIS COUNTER, so nobody quotes it for more than it measures.
     It is installed AFTER the page has mounted, and this window is hidden, so a
     frame loop that was started during mount and is still parked on the NATIVE
     requestAnimationFrame never fires and is never counted -- a hidden window
     produces almost no native frames. Mutation-checked: a native rAF loop
     planted in the graph constructor SURVIVES this harness, and survived it
     before this change too, so it is a pre-existing property of the
     instrument rather than a regression. What it does catch, and what was
     proven by planting it, is any loop that keeps scheduling frames through the
     page's own window.requestAnimationFrame once the harness is watching --
     including one that starts AFTER the page has settled, which the previous
     fixed 900ms window could not see at all. Closing the remaining gap needs
     the counter installed at document-start, which needs a preload, which needs
     contextIsolation off -- i.e. it would change the environment under test. */
  /* WAIT OUT THE PAGE'S OWN ENTRY MOTION BEFORE OPENING THE SETTLE WINDOW.
     The router mounts every view as `.view.enter` and lifts the class in a
     double requestAnimationFrame (src/main.js swapView). That rAF is the
     NATIVE one -- it was scheduled at mount, before the shim above existed --
     and this window is hidden, so the frame that runs it arrives whenever the
     compositor deigns to produce one. When it arrives LATE, the lift starts
     the wrapper's one-shot opacity/transform transition (.view's stylesheet
     transition), and if that lands inside the confirm window below, the
     transform moves every sampled rect and the idle check reads
       layoutMovedWhileIdle=true
       anywhereOnThePage=["div.view CSSTransition opacity","div.view CSSTransition transform"]
     -- which is exactly the red the 2026-08-19 confirming run produced at
     0485034, and exactly what this harness reproduced ON THE PREVIOUS GREEN
     TREE a3e9f85 by making the lift-frame arrive at mount+2150ms in a
     worktree build (layoutMovedWhileIdle=true, same two transitions named).
     The entry motion is a ONE-SHOT: the page still reaches idle and stays
     there, which is the invariant the check states. So the instrument waits
     for the entry to have actually run -- class lifted, wrapper transitions
     finished -- before it starts judging idleness, the same way it already
     waits for document.fonts.ready. A perpetual animation or a self-renewing
     frame loop fails the checks below exactly as before; and if this window
     truly gets no frame at all, that is named here as harness state rather
     than left to surface as a settle red blamed on the page. */
  const entry = await webContents.executeJavaScript(`new Promise(resolve => {
    const startedAt = Date.now();
    const deadline = startedAt + 10000;
    const entryStillPending = () => {
      const wrappers = [...document.querySelectorAll('.view')];
      const classed = wrappers.some(v => v.classList.contains('enter') || v.classList.contains('exit'));
      const moving = document.getAnimations().some(animation => {
        const target = animation.effect && animation.effect.target;
        return target instanceof Element
          && target.classList.contains('view')
          && (animation.playState === 'running' || animation.pending === true);
      });
      return classed || moving;
    };
    const poll = () => {
      if (!entryStillPending()) return resolve({ done: true, waitedMs: Date.now() - startedAt });
      if (Date.now() > deadline) return resolve({ done: false, waitedMs: Date.now() - startedAt });
      setTimeout(poll, 60);
    };
    poll();
  })`)
  check('HARNESS STATE: the entry motion ran before the settle window opened', entry.done,
    `waited ${entry.waitedMs}ms and .view never finished entering -- this hidden window got no frame; nothing about the page was measured`)
  const settle = await settlePage2(webContents)

  const initial = await webContents.executeJavaScript(`(() => {
    const graph = window.__mcGraph;
    const node = document.querySelector('.static-tree-node');
    const glass = node.querySelector('.node-glass');
    const style = getComputedStyle(glass);
    /* CSSOM RETURNS A DEVICE-PIXEL-QUANTIZED USED BORDER WIDTH. At DPR 1,
       Chromium reports the ring as 1px: one physical pixel. So the authored rule
       is read as well, and the computed half separately proves the ring paints
       at no less than one physical pixel on the display running the gate.

       THE AUTHORED HALF USED TO BE THE LITERAL 1.5px, AND THAT WAS STALE.
       b9074f5e ("Refine agent circle colors across themes and tree sizes") made
       the rim scale with the tree: the rule now declares --circle-stroke as
       clamp(0.85px, calc(1.75px * ...), 3px) and sets border to
       var(--circle-stroke) solid var(--rc), so no px literal survives in the
       shorthand and the regex below answered null. The check that read it
       therefore reported "flat node material" FAILED against a rim the product
       draws deliberately -- exactly the shape of staleness this file's
       EXPECTED_EXAMPLE_TREE_NODES note records, reached one check later.
       Measured 2026-09-11 in this harness's own window:
       borderWidth 1px, authoredBorderWidth null, physicalBorderWidth 1.

       So the contract is pinned where it now lives, and not loosened: the
       shorthand must be exactly the scaling property (a hardcoded px, a missing
       border or a different property all fail), and the clamp's FLOOR is pinned
       too, because that floor is what stops the ring disappearing on a large
       tree -- src/tree-graph.css:717 states the rim is the only mark that says
       "this is an agent". */
    const authoredNodeRule = [...document.styleSheets]
      .flatMap(sheet => {
        try { return [...sheet.cssRules] } catch { return [] }
      })
      .find(rule => (rule.selectorText || '').split(',').map(part => part.trim())
        .includes('.computers .static-tree-graph .node-glass'));
    const authoredNodeBorder = (authoredNodeRule?.style?.border || '').trim();
    const authoredBorderWidth = /^([0-9]*\\.?[0-9]+px)\\b/.exec(authoredNodeBorder)?.[1] || null;
    const authoredStroke = (authoredNodeRule?.style?.getPropertyValue('--circle-stroke') || '').trim();
    const authoredStrokeFloor = /^clamp\\(\\s*([0-9]*\\.?[0-9]+)px/.exec(authoredStroke)?.[1] || null;
    const edge = document.querySelector('.static-tree-links .tree-link');
    const edgeStyle = getComputedStyle(edge);
    const chips = [...document.querySelectorAll('.static-tree-chip.screen-chip-visible')];
    const chipRects = chips.map(chip => chip.getBoundingClientRect());
    const nodeRects = [...document.querySelectorAll('.static-tree-node:not([hidden])')].map(node => node.getBoundingClientRect());
    const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left)
      && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    const chip = chips[0];
    const chipAccent = chip ? getComputedStyle(chip, '::before') : null;
    const resolveColor = value => {
      const probe = document.createElement('i');
      probe.style.color = value;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const roleTokenMatch = [...document.querySelectorAll('.static-tree-node')].every(item => {
      const roleClass = [...item.classList].find(name => name.startsWith('role-'));
      const roleKey = roleClass?.slice(5);
      return roleKey && getComputedStyle(item.querySelector('.node-glass')).borderTopColor
        === resolveColor(getComputedStyle(document.documentElement).getPropertyValue('--c-' + roleKey).trim());
    });
    const sections = [...document.querySelectorAll('.stats-page .rail-sec')].map(item => item.textContent.trim());
    return {
      staticApi: typeof graph.hasPositionOverrides === 'function' && typeof graph._animateRecord === 'function',
      dataLayout: graph.container.dataset.layout,
      nodes: graph.nodes.size,
      frameMs: window.__graphFrameMs,
      nodeCount: window.__graphNodeCount,
      physicsControl: Boolean(document.querySelector('.graph-layout-seg')),
      resetVisible: !document.querySelector('.graph-reset-btn').hidden
        && getComputedStyle(document.querySelector('.graph-reset-btn')).display !== 'none',
      material: {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        authoredBorderWidth,
        authoredNodeBorder,
        authoredStrokeFloor,
        physicalBorderWidth: parseFloat(style.borderTopWidth) * window.devicePixelRatio,
        devicePixelRatio: window.devicePixelRatio,
        boxShadow: style.boxShadow,
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
      },
      edge: { width: edgeStyle.strokeWidth, dash: edgeStyle.strokeDasharray, opacity: edgeStyle.opacity },
      chipMaterial: chip ? {
        backgroundImage: getComputedStyle(chip).backgroundImage,
        accentBackgroundImage: chipAccent.backgroundImage,
        accentWidth: chipAccent.width,
      } : null,
      visibleChips: chips.length,
      chipOverlaps: chipRects.reduce((count, rect, index) => count
        + chipRects.slice(index + 1).filter(other => intersects(rect, other)).length, 0),
      chipNodeOverlaps: chipRects.reduce((count, rect) => count
        + nodeRects.filter(other => intersects(rect, other)).length, 0),
      roleTokenMatch,
      sections,
      disclosures: [...document.querySelectorAll('.stats-page [data-fleet-details]')].map(item => ({
        id: item.dataset.fleetDetails, title: item.querySelector('summary')?.textContent.trim() })),
      researchSlot: Boolean(document.querySelector('.stats-page [data-research-scope-slot]')),
    };
  })()`)
  check('StaticTreeGraph mounted', initial.staticApi, JSON.stringify(initial))
  check('tree DOM contract', initial.dataLayout === 'tree'
    && initial.nodes === initial.nodeCount
    && initial.nodes === EXPECTED_EXAMPLE_TREE_NODES, JSON.stringify(initial))
  check('Page 2 physics control retired', initial.physicsControl === false)
  check('Reset positions is absent without overrides', initial.resetVisible === false)
  check('flat node material', initial.material.backgroundImage === 'none'
    && initial.material.authoredNodeBorder === 'var(--circle-stroke) solid var(--rc)'
    && initial.material.authoredBorderWidth === null
    && Number(initial.material.authoredStrokeFloor) >= 0.85
    && initial.material.physicalBorderWidth >= 1
    && initial.material.boxShadow === 'none'
    && initial.material.backdrop === 'none', JSON.stringify(initial.material))
  check('node rings resolve to exact role tokens', initial.roleTokenMatch)
  check('neutral single-stroke edge', initial.edge.width === '1.25px' && initial.edge.opacity === '1', JSON.stringify(initial.edge))
  check('flat context labels do not collide', initial.visibleChips > 0 && initial.chipOverlaps === 0
    && initial.chipNodeOverlaps === 0 && initial.chipMaterial.backgroundImage === 'none'
    && initial.chipMaterial.accentBackgroundImage === 'none'
    && Math.abs(parseFloat(initial.chipMaterial.accentWidth) - 2) < 0.1, JSON.stringify(initial))
  // renderLiveStats now leads with folders/trees and retains the remaining
  // features in named disclosures. Example mode intentionally does not load
  // the owner's role library; the account door and Research slot must remain.
  check('current example overview section order', JSON.stringify(initial.sections) === JSON.stringify([
    'Folders your agents work in', 'Your trees', 'Organisation', 'This computer', 'Services', 'Your ToolsEnabled account',
  ]), initial.sections.join(','))
  check('overview retains Research, organisation, record and account disclosures', initial.researchSlot
    && JSON.stringify(initial.disclosures) === JSON.stringify([
      { id: 'research', title: 'Research filing' }, { id: 'configuration', title: 'Organisation & roles' },
      { id: 'record', title: 'Computer record & services' }, { id: 'account', title: 'Account connection' },
    ]), JSON.stringify(initial.disclosures))

  /* LABEL LAYOUT, MEASURED ON GLASS.
     tools/test/phase2-label-layout.test.mjs pins the same contract as source
     text, and used to pin it against FleetGraph's stylesheet — a sheet no
     browser loads — where it passed for months while asserting nothing about
     this page. Source text cannot see whether a rule is loaded, applied, or
     overridden, which is exactly how that survived. This is the half that can.
     Every visible node's name and role row must sit inside the label stack
     that bounds them, and the stack must not exceed the per-node budget. */
  const labels = await webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('.static-tree-node:not([hidden])')];
    const overflowing = [];
    const unlabelled = [];
    let stacksMeasured = 0;
    for (const node of nodes) {
      const stack = node.querySelector('.node-labels');
      const aria = node.getAttribute('aria-label') || '';
      const role = node.querySelector('.node-role')?.textContent?.trim() || '';
      if (!role || !aria.includes(role)) unlabelled.push({ id: node.dataset.agentId, aria, role });
      if (!stack) continue;
      stacksMeasured += 1;
      const stackRect = stack.getBoundingClientRect();
      for (const row of stack.querySelectorAll('.node-name, .node-role')) {
        const rect = row.getBoundingClientRect();
        /* 0.5px tolerance: sub-pixel layout rounding, not slack. */
        if (rect.width > stackRect.width + 0.5) {
          overflowing.push({ id: node.dataset.agentId, row: row.className, rowWidth: rect.width, stack: stackRect.width });
        }
      }
    }
    return { nodeCount: nodes.length, stacksMeasured, overflowing, unlabelled };
  })()`)
  check('role sublabels stay inside the node label budget',
    labels.stacksMeasured > 0 && labels.overflowing.length === 0,
    JSON.stringify(labels))
  check('every node carries an accessible identity naming its role',
    labels.nodeCount > 0 && labels.unlabelled.length === 0,
    JSON.stringify(labels.unlabelled))
  /* 6c75763 made this probe honest: nothing measures a whole graph frame, so
     null means unmeasured. Zero would claim an instantaneous frame that no
     instrument observed. Actual idleness remains measured independently by
     the settle, rAF and animation checks immediately below. */
  check('settled graph probe does not invent a frame time', initial.frameMs === null, String(initial.frameMs))
  check('Page 2 reaches an idle state at all', settle.settled && !settle.layoutMovedWhileIdle,
    `still moving after ${settle.settleMs}ms: animations=${JSON.stringify(settle.runningAnimations)}`
    + ` rAF=${settle.idleRafCallbacks} layoutMovedWhileIdle=${settle.layoutMovedWhileIdle}`
    + ` anywhereOnThePage=${JSON.stringify(settle.anythingStillRunning)}`)
  check('no idle requestAnimationFrame callbacks', settle.idleRafCallbacks === 0, String(settle.idleRafCallbacks))
  check('no settled Page 2 CSS animation', settle.runningAnimations.length === 0, JSON.stringify(settle.runningAnimations))

  /* THE REDUCED-MOTION CONTROL MUST REMOVE MOTION, NOT MANUFACTURE IT.
     A control that exists to prevent a thing and instead causes it is a
     software failure, not a cosmetic one, and this one was live: both
     reduced-motion blocks in src/styles.css clamped `transition-duration` on
     `*` without touching `transition-property`, whose initial value is `all`.
     An element that declared no transition therefore resolved to
     `all / 0.12s`, so every reposition of the SVG chip-leader dot's `cx`/`cy`
     -- and of `.tree-link` -- started a real 120ms CSSTransition. A reader who
     asked Windows for less motion got MORE of it on this page than a reader who
     did not, and it is also what made this harness intermittently red.

     Asserted BEHAVIOURALLY and on the in-app toggle rather than on the OS
     preference, so it measures the same CSS on any machine instead of passing
     silently wherever the OS preference is off: turn `reduce-motion` on, move a
     property nothing declared a transition for, and require that no transition
     was created at all. */
  const reduceMotion = await webContents.executeJavaScript(`(() => {
    const dot = document.querySelector('.graph-chip-leader-dot');
    if (!dot) return { probed: false };
    const wasOn = document.body.classList.contains('reduce-motion');
    document.body.classList.add('reduce-motion');
    const style = getComputedStyle(dot);
    const resolved = { property: style.transitionProperty, duration: style.transitionDuration };
    const cx = dot.getAttribute('cx');
    dot.setAttribute('cx', String(Number(cx || 0) + 40));
    const manufactured = document.getAnimations()
      .filter(animation => animation.effect && animation.effect.target === dot)
      .map(animation => animation.transitionProperty || animation.animationName || 'unknown');
    dot.setAttribute('cx', cx === null ? '0' : cx);
    for (const animation of document.getAnimations()) {
      if (animation.effect && animation.effect.target === dot) animation.cancel();
    }
    if (!wasOn) document.body.classList.remove('reduce-motion');
    return { probed: true, resolved, manufactured };
  })()`)
  check('reduced motion removes motion rather than manufacturing it',
    reduceMotion.probed === true
    && reduceMotion.resolved.property === 'none'
    && reduceMotion.manufactured.length === 0,
    JSON.stringify(reduceMotion))

  // Theme screenshots: the requested tan-first order is load-bearing.
  window.setPosition(80, 80)
  window.showInactive()
  await delay(500)
  /* MEASURED LIMIT OF THIS HARNESS, recorded because it changes what any
     motion check here can mean, and because the alternative was shipping a
     check that has never gone red.

     1. This Chromium reports prefers-reduced-motion: reduce, so the app's own
        clamp caps EVERY CSS animation at 0.001ms with one iteration and every
        transition at 120ms. A page-2 CSS motion defect is therefore short-lived
        by construction here: `no settled Page 2 CSS animation` can catch a
        transition that is genuinely still running, which is what the settle
        loop above now waits out, but a long or perpetual CSS animation cannot
        be planted in this environment at all.
     2. In a window that has never been composited, an animation created by
        element.animate() parks at `playState: 'running', pending: true,
        currentTime: 0` and document.getAnimations() DOES NOT RETURN IT --
        measured directly: element.getAnimations() gave 0 and the document gave
        6, none of them it. A perpetual WAAPI animation is invisible to this
        harness, and was equally invisible to the check that preceded this one.

     A second settle reading taken with the window shown was tried and removed:
     it could not be made to fail for any defect the readings above do not
     already catch, and a check that cannot go red is decoration. What guards
     Page 2's motion here is the pair that IS mutation-proven -- the idle-frame
     checks above, and `reduced motion removes motion rather than manufacturing
     it`. */
  for (const theme of ['tan', 'white', 'black']) {
    await webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.setItem('mc.theme', ${JSON.stringify(theme)});`)
    await delay(760)
    const themeAudit = await webContents.executeJavaScript(`(() => {
      const parse = color => (color.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = color => {
        const values = parse(color).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const ratio = (left, right) => {
        const a = luminance(left), b = luminance(right);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const node = document.querySelector('.static-tree-node');
      const glass = node.querySelector('.node-glass');
      /* EVERY RUNTIME FACE, AGAINST ITS OWN CIRCLE. The example now begins
         with a finished node whose honest face is '.rt-state' ("no runtime"),
         not a running '.rt' clock. Sampling only the first '.rt' both threw on
         that intended shape and would have left the other four circles unaudited. */
      const runtimeAudit = [...document.querySelectorAll('.static-tree-node:not([hidden])')]
        .map(item => {
          const ownGlass = item.querySelector('.node-glass');
          const background = ownGlass ? getComputedStyle(ownGlass).backgroundColor : null;
          const values = [...item.querySelectorAll('.rt, .rt-state')]
            .filter(value => {
              const valueStyle = getComputedStyle(value);
              return valueStyle.display !== 'none' && valueStyle.visibility !== 'hidden'
                && Number(valueStyle.opacity) > 0;
            })
            .map(value => ({
              className: value.className,
              text: value.textContent.trim(),
              contrast: ratio(getComputedStyle(value).color, background),
            }));
          return { id: item.dataset.agentId, values };
        });
      const panel = document.querySelector('.graph-wrap');
      const nodeStyle = getComputedStyle(glass);
      const panelStyle = getComputedStyle(panel);
      return {
        theme: document.documentElement.dataset.theme,
        runtimeAudit,
        nodeGradient: nodeStyle.backgroundImage,
        panelGradient: panelStyle.backgroundImage,
        nodeBackdrop: nodeStyle.backdropFilter || nodeStyle.webkitBackdropFilter,
        panelBackdrop: panelStyle.backdropFilter || panelStyle.webkitBackdropFilter,
        nodeShadow: nodeStyle.boxShadow,
        panelShadow: panelStyle.boxShadow,
      };
    })()`)
    check(`${theme} theme flat-token and runtime-contrast audit`, themeAudit.theme === theme
      && themeAudit.runtimeAudit.length === EXPECTED_EXAMPLE_TREE_NODES
      && themeAudit.runtimeAudit.every(node => node.values.length > 0
        && node.values.every(value => value.contrast >= 4.5))
      && themeAudit.nodeGradient === 'none' && themeAudit.panelGradient === 'none'
      && themeAudit.nodeBackdrop === 'none' && themeAudit.panelBackdrop === 'none'
      && themeAudit.nodeShadow === 'none' && themeAudit.panelShadow === 'none', JSON.stringify(themeAudit))
    const screenshot = await webContents.capturePage()
    fs.writeFileSync(path.join(outputDir, `page2-${theme}-1600x900.png`), screenshot.toPNG())
  }
  await webContents.executeJavaScript(`document.documentElement.dataset.theme = 'tan'; localStorage.setItem('mc.theme', 'tan');`)
  await delay(760)

  window.hide()

  // A context card opens the side rail; double-clicking its circle opens the
  // conversation (owner, 2026-09-10). The conversation is the only
  // context-label size motion.
  const chipAgent = await webContents.executeJavaScript(`document.querySelector('.static-tree-chip.screen-chip-visible')?.dataset.agentId || null`)
  await pressVisibleControl(webContents, `.static-tree-chip.screen-chip-visible[data-agent-id=${JSON.stringify(chipAgent)}]`)
  await waitFor(webContents, `document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat')`, 3000)
  check('a context card opens the side rail for its agent, not a conversation', await webContents.executeJavaScript(`(() => {
    const name = window.__mcGraph?.nodes.get(${JSON.stringify(chipAgent)})?.agent.name
    return Boolean(name) && document.querySelector('.tree-workspace-chat')?.hidden !== false
      && document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat .chat-head .t')?.textContent?.trim() === name
  })()`))
  await webContents.executeJavaScript(`document.querySelector('.ctl-page .rail-back').click()`)
  await waitFor(webContents, `document.querySelector('.stats-page.is-active')`)
  const chipNode = `.static-tree-node[data-agent-id=${JSON.stringify(chipAgent)}]`
  await pressVisibleControl(webContents, chipNode)
  await delay(40)
  await pressVisibleControl(webContents, chipNode, 2)
  await waitFor(webContents, `document.querySelector('.tree-conversation .chat')`)
  // The shelf uses normal flow. Wait for real panel/composer geometry, then
  // check it against the graph pane below; no transition or target-size guess.
  await waitFor(webContents, `(() => {
    const panel = document.querySelector('.tree-conversation');
    const input = panel?.querySelector('.chat-input input');
    return panel?.getBoundingClientRect().height > 200 && input?.getBoundingClientRect().height > 0;
  })()`, 3000)
  /* This check used to be `check('context chip opens chat', true)` — a literal
     that cannot fail. It waited for the chat ELEMENT and then asserted nothing
     about whether a person could see it, and underneath it the product shipped
     a chat that opened and was then hidden at every window size on every node:
     the placer found no seat for a 360x368 panel under the "immediately beside
     the circle" rule and set the whole block to opacity 0. So the assertion is
     now what the name always claimed — the chat is ON SCREEN, inside the
     canvas, and reachable by a pointer.

     6ddd6cd made the braces the COLLAPSED monitor's costume only, at the
     owner's request. The two elements remain in the card's DOM because the
     same chip can collapse again, but an open chat must show zero of them. */
  const chatOpened = await webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.tree-conversation')
    if (!chip) return { present: false }
    const box = chip.getBoundingClientRect()
    const host = document.querySelector('.graph-wrap').getBoundingClientRect()
    const style = getComputedStyle(chip)
    const braces = [...chip.querySelectorAll('.monitor-brace')]
    return {
      present: true,
      opacity: Number(style.opacity),
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      width: Math.round(box.width), height: Math.round(box.height),
      insideCanvas: box.x >= host.x - 1 && box.y >= host.y - 1
        && box.right <= host.right + 1 && box.bottom <= host.bottom + 1,
      braceElements: braces.length,
      visibleBraces: braces.filter(brace => {
        const braceStyle = getComputedStyle(brace)
        const braceBox = brace.getBoundingClientRect()
        return braceStyle.display !== 'none' && braceStyle.visibility !== 'hidden'
          && Number(braceStyle.opacity) > 0 && braceBox.width > 0 && braceBox.height > 0
      }).length,
    }
  })()`)
  check('double-clicking the circle opens a conversation a person can actually see',
    chatOpened.present && chatOpened.opacity > 0.9 && chatOpened.visibility === 'visible'
    && chatOpened.pointerEvents !== 'none' && chatOpened.width > 200 && chatOpened.height > 200
    && chatOpened.insideCanvas && chatOpened.visibleBraces === 0, JSON.stringify(chatOpened))
  // Conversations are now persistent workspace tabs. Back to trees hides the
  // conversation view; requiring its DOM to disappear would demand data loss.
  await pressVisibleControl(webContents, '.tree-preview-close')
  await waitFor(webContents, `document.querySelector('.tree-workspace-chat')?.hidden === true`)
  check('Back to trees restores the canvas through its visible control', await webContents.executeJavaScript(`
    document.querySelector('.tree-home-tab')?.getAttribute('aria-selected') === 'true'
      && document.querySelectorAll('.static-tree-node').length === ${EXPECTED_EXAMPLE_TREE_NODES}`))

  // Current workspace gestures (owner, 2026-09-10): a single circle click only
  // selects; a single box click opens the side rail (a box is its own card);
  // double-clicking a circle opens its conversation tab; Shift+Enter opens the
  // rail. The delayed single click and the native double-click race are both
  // exercised.
  await settlePage2(webContents)
  const singleClickTarget = await webContents.executeJavaScript(`(() => {
    const record = [...window.__mcGraph.nodes.values()].find(item => !item.el.hidden && !item.el.classList.contains('focusable'));
    const rect = record.el.getBoundingClientRect();
    return { id: record.id, name: record.agent.name, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  const nodeSelector = `.static-tree-node[data-agent-id=${JSON.stringify(singleClickTarget.id)}]`
  await pressVisibleControl(webContents, nodeSelector)
  await waitFor(webContents, `document.querySelector(${JSON.stringify(nodeSelector)})?.classList.contains('selected')`)
  await delay(350)
  check('a single Circle click selects without opening a conversation', await webContents.executeJavaScript(`
    document.querySelector('.tree-workspace-chat')?.hidden === true
      && !document.querySelector('.ctl-page.is-active')`))
  await chooseShape(webContents, 'boxes')
  await settlePage2(webContents)
  await pressVisibleControl(webContents, nodeSelector)
  await waitFor(webContents, `document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat')`, 3000)
  check('a single Box click opens the side rail, not a conversation', await webContents.executeJavaScript(`
    document.querySelector('.tree-workspace-chat')?.hidden !== false
      && document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat .chat-head .t')?.textContent?.trim() === ${JSON.stringify(singleClickTarget.name)}`))
  await webContents.executeJavaScript(`document.querySelector('.ctl-page .rail-back').click()`)
  await waitFor(webContents, `document.querySelector('.stats-page.is-active')`)
  await chooseShape(webContents, 'circles')
  await settlePage2(webContents)
  await pressVisibleControl(webContents, nodeSelector)
  await delay(40)
  await pressVisibleControl(webContents, nodeSelector, 2)
  await waitFor(webContents, `document.querySelector('.tree-workspace-chat')?.hidden === false`, 3000)
  check('a native Circle double-click opens the selected agent conversation', await webContents.executeJavaScript(`
    document.querySelector('.tree-chat-heading')?.textContent === ${JSON.stringify(singleClickTarget.name)}
      && document.querySelector('.tree-workspace-chat:not([hidden]) .tree-conversation:not([hidden]) .chat') !== null
      && !document.querySelector('.ctl-page.is-active')`))
  await pressVisibleControl(webContents, '.tree-preview-close')
  await waitFor(webContents, `document.querySelector('.tree-workspace-chat')?.hidden === true`)
  await webContents.executeJavaScript(`document.querySelector(${JSON.stringify(nodeSelector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))`)
  await waitFor(webContents, `document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat')`, 3000)
  const singleClick = await webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.ctl-page.is-active');
    const chat = page?.querySelector('[data-rail-chat-host] .chat');
    return {
      railOpen: Boolean(page),
      chatPresent: Boolean(chat),
      chatVisible: chat ? getComputedStyle(chat).display !== 'none' && chat.getBoundingClientRect().height > 20 : false,
      chatTitle: chat?.querySelector('.chat-head .t')?.textContent?.trim() || null,
      chatSubtitle: chat?.querySelector('.chat-head .s')?.textContent?.trim() || null,
      railTitle: page?.querySelector('.rail-title-slot-title')?.textContent?.trim() || null,
    };
  })()`)
  check('Shift+Enter opens the side rail', singleClick.railOpen, JSON.stringify(singleClick))
  check('the side rail contains a visible chatbox', singleClick.chatPresent && singleClick.chatVisible, JSON.stringify(singleClick))
  check('the tree rail labels the example channel honestly', singleClick.railTitle === 'Example agent', JSON.stringify(singleClick))
  check('the chat names the clicked agent', singleClick.chatTitle === singleClickTarget.name, JSON.stringify({ singleClickTarget, singleClick }))
  check('the deterministic sample node is honestly not running', singleClick.chatSubtitle === 'Example agent · not running', JSON.stringify(singleClick))

  /* THE CONTROLS MUST NOT LIE. The three sliders that used to sit here —
     "Context budget", "Wake interval", "Autonomy" — moved, reported a value,
     and changed nothing. Their absence is asserted, and so is the presence of
     the replacement: a tier whose REAL argv fragment is printed, and a list of
     the knobs that do not exist with a reason for each. */
  const controls = await webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.ctl-page.is-active');
    /* The stated absence lives inside the Start-work group now, behind the
       what-is-on-record box -- ask for it by its own class, not for the first
       .board-ctl-box on the rail. */
    const box = page?.querySelector('.board-ctl-absent');
    return {
      inertSliders: page ? page.querySelectorAll('.ctl-row[data-t]').length : -1,
      sliderLabels: [...(page?.querySelectorAll('.cl') || [])].map(node => node.textContent.trim()),
      /* The demonstration board must carry NO control that reaches a real
         session: launch, team and loop are ABSENT here by design and replaced
         by a stated-absence box. */
      steeringControls: page ? page.querySelectorAll('[data-launch], [data-team], [data-loop]').length : -1,
      absent: Boolean(box),
      absentCopy: box?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    };
  })()`)
  check('no inert tuning slider survives on page 2', controls.inertSliders === 0
    && !controls.sliderLabels.includes('Context budget')
    && !controls.sliderLabels.includes('Wake interval')
    && !controls.sliderLabels.includes('Autonomy'), JSON.stringify(controls))
  /* RECONCILED 2026-08-11. These three checks used to demand a LIVE launch box
     on the simulated board -- the tier dropdown offering the engine tiers, the
     printed argv, the run-cap control, the unsupported-control citations. That
     is exactly the control dd01899 removed and tools/example-page-write-fence-qa.mjs
     (green) forbids on the example copy of page 2, whose own banner says nothing
     on it is real: a Dispatch/tier control here reaches the audited bridge from a
     demonstration screen. The launch box's real content is proven on the LIVE
     board -- present there by example-page-write-fence-qa's live half, exercised
     by tools/team-panel-packaged-qa.mjs and tools/loop-packaged-qa.mjs -- and the
     engine tiers, argv fragments and caps are pinned by
     tools/test/orchestration-controls.test.mjs, tools/test/agent-teams.test.mjs
     and tools/test/agent-loops.test.mjs. So the invariant asserted here is the
     safe one: on the demonstration board those controls are absent, and the
     absence is stated rather than left as a hole. */
  check('the demonstration board mounts no launch, team or loop control',
    controls.steeringControls === 0, JSON.stringify(controls))
  check('and it states that absence rather than leaving a hole',
    controls.absent && /nothing here starts anything/i.test(controls.absentCopy), JSON.stringify(controls))

  /* Pause/Resume/Respawn used to be dead buttons in a separate Actions box.
     Actions now live in the chat composer's action menu, so the retired box
     and its inert control vocabulary must be absent rather than disabled. */
  const retiredActions = await webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.ctl-page.is-active');
    return {
      actionBoxes: page ? page.querySelectorAll('.board-actions').length : -1,
      ctlActionButtons: page ? page.querySelectorAll('.ctl-btn[data-a]').length : -1,
    };
  })()`)
  check('retired rail actions are absent rather than disabled',
    retiredActions.actionBoxes === 0 && retiredActions.ctlActionButtons === 0,
    JSON.stringify(retiredActions))

  await webContents.executeJavaScript(`document.querySelector('.ctl-page .rail-back').click()`)
  await waitFor(webContents, `document.querySelector('.stats-page.is-active')`)

  // Side-rail contract and board order (a double click now opens the conversation).
  await webContents.executeJavaScript(`document.querySelector('.static-tree-node').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))`)
  await waitFor(webContents, `document.querySelector('.ctl-page.is-active [data-rail-chat-host] .chat')`)
  const board = await webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.ctl-page.is-active');
    /* The tree-node rail is one tab strip over two persistent bodies. Their DOM
       order keeps the mounted chat alive while the selected tab changes. */
    const order = ['[data-rail-tabs]', '[data-rail-body="chat"]', '[data-rail-body="details"]']
      .map(selector => page.querySelector(selector));
    const chatBody = order[1];
    const detailsBody = order[2];
    return {
      order: order.every(Boolean) && order.every((item, index) => index === 0
        || Boolean(order[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING)),
      chatVisible: Boolean(chatBody) && !chatBody.hidden && getComputedStyle(chatBody).display !== 'none',
      detailsHidden: Boolean(detailsBody) && detailsBody.hidden && getComputedStyle(detailsBody).display === 'none',
      chartPresent: Boolean(page.querySelector('.board-chart-box')),
      ringPresent: Boolean(page.querySelector('.agent-ring-wrap, .uring')),
    };
  })()`)
  check('the side rail opens the agent tabs in required order', board.order, JSON.stringify(board))
  check('the side rail opens Chat and keeps Details hidden', board.chatVisible && board.detailsHidden, JSON.stringify(board))
  check('the sim rail furniture stays gone: no synthesised chart, no uptime ring',
    board.chartPresent === false && board.ringPresent === false, JSON.stringify(board))
  await webContents.executeJavaScript(`document.querySelector('.ctl-page .rail-back').click()`)
  await waitFor(webContents, `document.querySelector('.stats-page.is-active')`)

  /* The example fleet is read-only. Edit stays pressable only so the page can
     explain the refusal; it must never enter edit mode or mutate sample data.
     Live drag/reparent behavior is exercised by the packaged live-source QA. */
  const mockEditBefore = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.graph-edit-btn');
    return {
      ariaDisabled: button?.getAttribute('aria-disabled') || null,
      title: button?.title || '',
      editMode: Boolean(window.__mcGraph.editMode),
      datasetEditMode: window.__mcGraph.container.dataset.editMode || null,
    };
  })()`)
  check('the example fleet Edit door is explicitly unavailable',
    mockEditBefore.ariaDisabled === 'true' && !mockEditBefore.editMode && mockEditBefore.datasetEditMode !== 'true',
    JSON.stringify(mockEditBefore))
  await webContents.executeJavaScript(`document.querySelector('.graph-edit-btn').click()`)
  await waitFor(webContents, `(() => {
    const status = document.querySelector('.org-status');
    return status && !status.hidden && status.textContent.includes('This is the example fleet — nothing in it is yours to rearrange.');
  })()`)
  const mockEditAfter = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.graph-edit-btn');
    const status = document.querySelector('.org-status');
    return {
      title: button?.title || '',
      editMode: Boolean(window.__mcGraph.editMode),
      datasetEditMode: window.__mcGraph.container.dataset.editMode || null,
      status: status?.textContent?.trim() || '',
      statusHidden: status?.hidden ?? true,
      statusState: status?.dataset?.state || null,
    };
  })()`)
  check('pressing unavailable Edit leaves the example fleet read-only',
    !mockEditAfter.editMode && mockEditAfter.datasetEditMode !== 'true', JSON.stringify(mockEditAfter))
  check('pressing unavailable Edit gives the exact visible refusal',
    !mockEditAfter.statusHidden && mockEditAfter.statusState === 'refuse'
      && mockEditAfter.status === mockEditAfter.title
      && mockEditAfter.status.includes('This is the example fleet — nothing in it is yours to rearrange.'),
    JSON.stringify(mockEditAfter))

  // Raise the simulated fleet to the dense threshold, then exercise drill and return.
  await chooseShape(webContents, 'boxes')
  await webContents.executeJavaScript(`(() => {
    const graph = window.__mcGraph;
    // Publish a fresh projection input, as the actual store does. Mutating
    // the old array in place leaves the scope cache on its previous forest.
    const agents = [...graph.computer.agents];
    let index = 0;
    while (agents.length < 32) {
      const parent = agents.find(agent => agent.role === 'manager');
      const agent = {
        id: 'qa-drill-' + index, name: 'qa drill ' + index, role: 'default', parentId: parent.id,
        bornAt: Date.now(), state: 'active', model: 'qa', pool: 'qa', context: [], tasksDone: 0, failRate: 0,
      };
      index += 1;
      agents.push(agent);
    }
    graph.computer = { ...graph.computer, agents };
    graph.refresh();
  })()`)
  await waitFor(webContents, `document.querySelector('.tree-box-branch:not([hidden])')`)
  window.setPosition(-2400, -1400)
  window.showInactive()
  await delay(120)
  await settlePage2(webContents)
  // Current cards have an explicit branch button. Exercise that control,
  // rather than treating the retired single-click gesture as a drill action.
  const drill = await webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.tree-box-branch:not([hidden])')]
      .find(item => item.getBoundingClientRect().width > 0);
    const node = button?.closest('.static-tree-node');
    const graph = window.__mcGraph;
    const state = {
      nodes: graph.nodes.size,
      agents: graph.computer.agents.length,
      folded: graph._projection?.folded === true,
      branchLabel: button?.getAttribute('aria-label'),
      rootId: graph.rootId,
    };
    if (!node) return { id: null, state };
    return { id: node.dataset.agentId, state };
  })()`)
  const drillId = drill.id
  check('the dense 32-agent forest keeps an explicit labelled branch control', Boolean(drillId)
    && drill.state.agents === 32 && drill.state.folded && drill.state.branchLabel?.startsWith('Explore '), JSON.stringify(drill.state))
  await pressVisibleControl(webContents, `.static-tree-node[data-agent-id=${JSON.stringify(drillId)}] .tree-box-branch`)
  await waitFor(webContents, `window.__mcGraph.rootId === ${JSON.stringify(drillId)}`)
  await delay(760)
  const drillState = await webContents.executeJavaScript(`({
    root: window.__mcGraph.rootId,
    returnVisible: Boolean(document.querySelector('.tree-window-back:not([hidden])')),
    frameMs: window.__graphFrameMs,
    rerooting: Boolean(document.querySelector('.node.rerooting')),
  })`)
  /* R1198: the 680ms re-root glide is gone. The owner asked for no required
     motion, and that glide re-ran the chip placement search on every frame to
     decorate a click. The drill now lands immediately, so the assertion is
     that it settles at once. frameMs stays null because 6c75763 stopped
     reporting an unmeasured whole-frame cost as zero; null is part of the
     honesty contract, not a failed timing. */
  check('drill-down lands immediately and settles', drillState.root === drillId && drillState.returnVisible && drillState.frameMs === null && !drillState.rerooting, JSON.stringify(drillState))
  await pressVisibleControl(webContents, '.tree-window-back:not([hidden])')
  await waitFor(webContents, `window.__mcGraph.rootId === null`)
  await delay(760)
  const reducedMotion = await webContents.executeJavaScript(`(() => {
    const graph = window.__mcGraph;
    document.body.classList.add('reduce-motion');
    const target = ${JSON.stringify(drillId)};
    graph.setRoot(target);
    const instant = graph.rootId === target && graph._animationRaf === 0 && !document.querySelector('.node.rerooting');
    graph.clearRoot();
    document.body.classList.remove('reduce-motion');
    return { target, instant, returned: graph.rootId === null && graph._animationRaf === 0 };
  })()`)
  check('reduce-motion makes drill and return instant', Boolean(reducedMotion.target) && reducedMotion.instant && reducedMotion.returned, JSON.stringify(reducedMotion))
  window.hide()

  /* THE AGENT ROUTE SEAM ONLY: this block navigates directly, not through
     a Page 2 button. The current example rail has no "Open full view" action.
     The retained #/agent/<compId>/<agentId> route must still mount. It used to
     assert FleetGraph and a .graph-canvas node; the drill-in was rewritten and
     no longer mounts FleetGraph at all, so that contract was checking for a
     thing that is deliberately gone. Measured RED on an unchanged tree before
     this lane changed anything — an instrument asserting a retired contract
     manufactures a kill, so it is corrected rather than carried.

     What is asserted is only what the drill-in promises: the route resolves and
     the roster mounts with at least one card. `selected` is captured as
     DIAGNOSTIC DETAIL and deliberately not asserted — which card the drill-in
     selects is that page's decision, not this seam's, and asserting it from
     here would plant a red in someone else's territory. */
  await webContents.executeJavaScript(`location.hash = '#/agent/c1/codex'`)
  await waitFor(webContents, `document.querySelector('.agentv .ar-card')`)
  await delay(500)
  const agentView = await webContents.executeJavaScript(`({
    rosterMounted: Boolean(document.querySelector('.agentv .agent-roster')),
    cardCount: document.querySelectorAll('.agentv .ar-card').length,
    selected: document.querySelector('.agentv .ar-card.is-selected')?.dataset?.agentId || null,
  })`)
  check('direct agent route seam lands on a mounted agent detail (not a Page 2 button proof)',
    agentView.rosterMounted && agentView.cardCount >= 1, JSON.stringify(agentView))
  const exampleRoster = await webContents.executeJavaScript(`(() => ({
    cards: [...document.querySelectorAll('.agentv .ar-card')].map(card => ({
      state: card.dataset.runtimeState,
      note: card.querySelector('.ar-runtime-note')?.textContent,
      duration: card.querySelector('.ar-runtime-value')?.textContent,
      dialRunning: card.querySelector('.ar-dial')?.dataset.running,
      label: card.getAttribute('aria-label'),
      status: card.querySelector('.ar-status-current')?.textContent,
    })),
  }))()`)
  check('example roster durations are labelled as examples, never as real running sessions',
    exampleRoster.cards.length === EXPECTED_EXAMPLE_TREE_NODES && exampleRoster.cards.every(card =>
      card.state === 'example' && card.note === 'example time' && card.dialRunning === 'false'
      && card.label.includes('example agent, no real session') && !/running on/.test(card.status)), JSON.stringify(exampleRoster))
  await delay(1200)
  const laterExampleDurations = await webContents.executeJavaScript(`
    [...document.querySelectorAll('.agentv .ar-runtime-value')].map(node => node.textContent)`)
  check('example roster durations stay still across the normal runtime repaint',
    JSON.stringify(laterExampleDurations) === JSON.stringify(exampleRoster.cards.map(card => card.duration)), JSON.stringify(laterExampleDurations))
  window.showInactive()
  await webContents.executeJavaScript(`document.fonts.ready.then(() => true)`)
  await delay(200)
  fs.writeFileSync(path.join(outputDir, 'agent-detail-tan-1600x900.png'), (await webContents.capturePage()).toPNG())

  check('renderer emitted no errors', rendererErrors.length === 0, rendererErrors.join(' | '))
  RENDERER.assertUnchanged()
  window.destroy()
  server.close()
  server.closeAllConnections?.()
  return { outputDir, renderer: RENDERER.provenance, results }
}

app.whenReady().then(async () => {
  try {
    const report = await run()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${report.results.filter(result => result.pass).length}/${report.results.length} checks passed\n`)
    app.quit()
  } catch (error) {
    // Preserve the actual failed surface, before app.exit tears its window
    // down. A screenshot is diagnostic evidence, never a passing assertion.
    let failureScreenshot = null
    try {
      RENDERER.assertUnchanged()
      const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
      if (window) {
        const target = path.join(path.dirname(app.getPath('userData')), 'page2-failure.png')
        fs.writeFileSync(target, (await window.webContents.capturePage()).toPNG())
        failureScreenshot = target
      }
    } catch (captureError) {
      process.stderr.write(`failure evidence unavailable: ${captureError.stack || captureError}\n`)
    }
    process.stderr.write(`${JSON.stringify({ renderer: RENDERER.provenance, failureScreenshot })}\n`)
    process.stderr.write(`${error.stack || error}\n${JSON.stringify(results, null, 2)}\n`)
    app.exit(1)
  }
})
