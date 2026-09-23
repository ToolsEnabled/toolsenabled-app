import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { assertVisibleInk } from './home-circle-render-guard.mjs'

const output = path.resolve(process.argv[2] || 'home-circle-motion-qa')
const origin = process.argv[3] || 'http://127.0.0.1:4623'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const context = await browser.newContext({ viewport: { width: 760, height: 760 } })
// Keep this one review mounted while other lanes edit the shared hotload.
// HTTP still serves the real current modules; only Vite's reload socket is
// disconnected in this disposable browser context.
await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())
await context.addInitScript(({ theme, webgl1 }) => {
  localStorage.setItem('mc.theme', theme)
  // Read the actual final WebGL framebuffer only when a sample is requested.
  // Alpha area and centroid-relative spread cannot change under a rigid spin.
  for (const kind of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = window[kind]?.prototype
    if (!proto) continue
    const original = proto.drawArrays
    proto.drawArrays = function (...args) {
      const result = original.apply(this, args)
      if (window.captureCircle && this.canvas.classList.contains('home-circle-fluid') && !this.getParameter(this.FRAMEBUFFER_BINDING)) {
        const width = this.drawingBufferWidth, height = this.drawingBufferHeight
        const pixels = new Uint8Array(width * height * 4)
        this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels)
        let mass = 0, x = 0, y = 0, moment = 0, area = 0
        const cols = Math.ceil(width / 2), rows = Math.ceil(height / 2), mask = new Uint8Array(cols * rows)
        for (let py = 0; py < height; py += 2) for (let px = 0; px < width; px += 2) {
          const a = pixels[(py * width + px) * 4 + 3] / 255
          if (a < .03) continue
          mass += a; x += a * px / width; y += a * py / height
          moment += a * ((px / width) ** 2 + (py / height) ** 2)
          if (a > .12) area++
          if (a > .18) mask[(py / 2) * cols + px / 2] = 1
        }
        const queue = new Int32Array(mask.length), sizes = []
        for (let start = 0; start < mask.length; start++) {
          if (!mask[start]) continue
          let head = 0, tail = 1; queue[0] = start; mask[start] = 0
          while (head < tail) {
            const index = queue[head++], col = index % cols
            for (const next of [col ? index - 1 : -1, col < cols - 1 ? index + 1 : -1, index - cols, index + cols]) {
              if (next < 0 || next >= mask.length || !mask[next]) continue
              mask[next] = 0; queue[tail++] = next
            }
          }
          if (tail >= 8) sizes.push(tail)
        }
        window.circleInk = { mass, area, components: sizes.length, spread: mass ? Math.sqrt(Math.max(0, moment / mass - (x / mass) ** 2 - (y / mass) ** 2)) : 0 }
        window.captureCircle = false
      }
      return result
    }
  }
  if (webgl1) {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl2' ? null : original.call(this, kind, ...args) }
  }
}, { theme: process.env.HOME_MOTION_THEME || 'white', webgl1: process.env.HOME_MOTION_WEBGL1 === '1' })
const page = await context.newPage(), errors = [], report = { cases: [] }
page.on('pageerror', error => errors.push(error.message))
try {
  // A labelled input fixture exercises the production renderer, with no
  // fake GPU or animation implementation and no provider connection.
  await page.goto(`${origin}/#/settings`, { waitUntil: 'load' })
  await page.getByRole('searchbox', { name: 'Search all settings' }).waitFor()
  await page.evaluate(async () => {
    const { homeCircleMarkup } = await import('/src/home-circle.js')
    const { mountHomeCircleFluid } = await import('/src/home-circle-fluid.js')
    const { mountHomeStatusColors } = await import('/src/home-status-colors.js')
    const fixture = document.createElement('section')
    fixture.className = 'home'
    fixture.dataset.ledgerStatus = 'clear'
    mountHomeStatusColors(fixture)
    fixture.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px;background:var(--bg)'
    fixture.innerHTML = `<h1 style="font-size:22px;margin:0">Circle motion review</h1><p style="margin:0">Simulated action input · production fluid renderer</p><div data-motion-controls style="display:flex;gap:8px;flex-wrap:wrap"></div><div class="uring crescent home-circle" style="width:500px;height:500px" data-fluid="on" data-fluid-extras="personality blowup" data-circle-style="standard" data-circle-motion="animate" data-load="busy" data-agent-action="idle" data-agent-name="Motion preview" data-agent-event="0">${homeCircleMarkup()}<div class="uring-center"><div class="uring-inner"><div class="home-agent-line"><b>Motion preview</b><span data-motion-label>idle</span></div></div></div></div>`
    document.body.appendChild(fixture)
    const ring = fixture.querySelector('.home-circle')
    ring.dataset.agentKey = 'preview-a'
    const picker = document.createElement('select')
    picker.dataset.motionAgent = ''
    picker.innerHTML = '<option value="preview-a">Preview agent A</option><option value="preview-b">Preview agent B</option>'
    picker.onchange = () => { ring.dataset.agentKey = picker.value; ring.dataset.agentName = picker.selectedOptions[0].textContent }
    fixture.querySelector('[data-motion-controls]').appendChild(picker)
    let mounted = mountHomeCircleFluid(ring)
    for (const action of ['idle', 'thinking', 'reading', 'writing', 'running', 'waiting']) {
      const button = document.createElement('button')
      button.textContent = action; button.dataset.motionAction = action
      button.style.cssText = 'padding:8px 12px;border:1px solid var(--line-2);border-radius:6px;background:var(--sheet);color:var(--ink);font:inherit'
      button.onclick = () => { ring.dataset.agentAction = action; fixture.querySelector('[data-motion-label]').textContent = action }
      fixture.querySelector('[data-motion-controls]').appendChild(button)
    }
    window.motionReview = { ring, lean() { mounted.destroy(); ring.dataset.fluidExtras = ''; mounted = mountHomeCircleFluid(ring) }, destroy() { mounted.destroy(); fixture.remove() } }
  })
  await page.waitForFunction(() => window.motionReview.ring.homeCircleFluid?.stats().steps > 40)

  /* A CHANGE OF FORM IS A JOURNEY, AND THIS IS THE CHECK THAT IT STILL IS.
   *
   * The owner's report, 2026-09-18: "in transitions and such we dont do a good
   * job of letting it feel like its the blob itself turning into these
   * differnt shapes ... the seam on the transitions needs work". The cause was
   * that the dye pass mixed the two forms sampled AT THE SAME POINT while they
   * describe material in DIFFERENT PLACES, so material never moved -- the old
   * shape stood still and dimmed while the new one brightened beside it.
   *
   * THE ENDPOINTS OF A CHANGE CANNOT SEE THIS. At 0% and 100% a dissolve is
   * exactly correct; only the middle differs. So this compiles the shipped
   * src/home-circle-forms.js against the same two lines the dye pass uses and
   * steps a change, off to one side, with the piece layout and bands that
   * src/home-circle-motion.js would really be holding at each instant.
   *
   * WHAT IT ASSERTS is the plainest form of the question: tool work puts two
   * bands of material out at radius 0.235 and the resting face has none out
   * there at all, so on the way from one to the other that material has to
   * TRAVEL INWARD. `reach` is the mass-weighted mean radius of the ink outside
   * the core. Measured on this probe: with the journey the outer ink has
   * covered 29% of that distance by the time the blend is half done; with it
   * removed -- the dissolve, byte-for-byte -- it has covered 10%, because a
   * dissolve's material does not move at all and the only thing that shifts
   * the mean is the new shape fading up late. The floor is set between them. */
  {
    const travel = await page.evaluate(async () => {
      const { FLUID_FORMS } = await import('/src/home-circle-forms.js')
      const { actionMotion, updateBlobParts, updateBaseCharacter, createBlobParts } = await import('/src/home-circle-motion.js')
      const N = 192
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = N
      const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
      if (!gl) return { refused: 'the probe could not get its own WebGL context' }
      const compile = (kind, src) => {
        const s = gl.createShader(kind)
        gl.shaderSource(s, src); gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
        return s
      }
      const program = gl.createProgram()
      gl.attachShader(program, compile(gl.VERTEX_SHADER, ['attribute vec2 aPos;', 'varying vec2 vUv;',
        'void main () { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'].join('\n')))
      // The dye pass's own two lines, quoted rather than paraphrased.
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, ['precision highp float;', 'varying vec2 vUv;', FLUID_FORMS,
        'void main () {',
        '  vec2 local = bodyLocal(vUv), ink = vec2(1.0, 0.0), dye;',
        '  if (uForm.z >= 1.0) dye = fluidInk(local, uForm.y, uForm.w, ink);',
        '  else dye = mix(fluidInk(local, uForm.x, uForm.w, ink), fluidInk(local, uForm.y, uForm.w, ink), uForm.z);',
        '  gl_FragColor = vec4(clamp(dye.x / 4.0, 0.0, 1.0), 0.0, 0.0, 1.0);',
        '}'].join('\n')))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(program, 'aPos')
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
      /* EVERY UNIFORM THIS PROBE SETS HAS TO HAVE ARRIVED, AND WEBGL WILL NOT
         SAY SO. getUniformLocation returns null for a name the GLSL compiler
         dropped, and gl.uniform*(null, ...) is a silent no-op -- no error, no
         exception, no gl.getError. So a form whose geometry stopped reaching
         the shader would be fed nothing at all and this probe would still
         report a confident number for it. That is a precondition that is
         never true reading exactly like one that passes, so it is collected
         by name and refused below instead of assumed. */
      const missing = []
      const at = name => {
        const location = gl.getUniformLocation(program, name)
        if (!location) missing.push(name)
        return location
      }
      const pixels = new Uint8Array(N * N * 4)
      const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
      // Running is the tool form (4); idle is the resting face (2).
      function reachAt(elapsed) {
        const parts = createBlobParts(), character = new Float32Array(4)
        for (let t = 0; t < 2; t += 1 / 60) updateBlobParts(parts, actionMotion('running', t, ''), t, 1 / 60)
        for (let t = 0; t <= elapsed + 1e-9; t += 1 / 60) updateBlobParts(parts, actionMotion('idle', t, ''), t, 1 / 60)
        updateBaseCharacter(character, 4)
        gl.uniform4f(at('uBody'), 0.5, 0.5, 0, 1); gl.uniform1f(at('uBodyScale'), 1)
        gl.uniform4fv(at('uParts'), parts.pose); gl.uniform1fv(at('uPartAngles'), parts.angles)
        gl.uniform4fv(at('uCharacter'), character)
        gl.uniform4fv(at('uTool'), parts.ring); gl.uniform4fv(at('uToolTurn'), parts.turn)
        gl.uniform4f(at('uForm'), 4, 2, smooth(0, 0.8, elapsed), 0.31)
        gl.viewport(0, 0, N, N); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let outer = 0, moment = 0
        for (let i = 0; i < N * N; i++) {
          const r = Math.hypot((i % N) / N - 0.5, ((i / N) | 0) / N - 0.5)
          if (r <= 0.12) continue
          const v = pixels[i * 4] / 255 * 4
          outer += v; moment += v * r
        }
        return outer ? moment / outer : 0
      }
      const start = reachAt(0), end = reachAt(0.8)
      // After the first draw, so every location has actually been asked for.
      if (missing.length) return { refused: `the shader never received ${[...new Set(missing)].join(', ')}` }
      let furthest = 0, samples = 0
      for (let e = 0; e <= 0.4001; e += 0.04) {
        furthest = Math.max(furthest, (start - reachAt(e)) / (start - end)); samples++
      }
      return { start, end, furthest, samples }
    })
    if (travel.refused) {
      // A skip that names itself. It is never silent and never counts as a pass.
      throw new Error(`the transition-journey check could not run: ${travel.refused}`)
    }
    report.transitionJourney = travel
    // The window this claim is made over really was walked. `furthest` starts
    // at 0, so a loop that never ran would fail the travel assertion rather
    // than pass it -- this says so out loud anyway, because "it never ran" and
    // "it ran and was fine" must not print the same thing.
    assert.equal(travel.samples, 11, `the half of the blend this claim covers was sampled 11 times, got ${travel.samples}`)
    assert.ok(travel.start - travel.end > 0.03,
      `the probe has a journey to measure: tool work reaches ${travel.start.toFixed(3)} and the face ${travel.end.toFixed(3)}`)
    assert.ok(travel.furthest >= 0.2,
      `the body's outer material MOVES while the form changes, rather than standing still and dimming: `
      + `it covered ${(travel.furthest * 100).toFixed(0)}% of the way in by the half-way point, and a dissolve covers 10%`)
    console.log('PASS the transition moves material', `${(travel.furthest * 100).toFixed(0)}% travelled by half way`)
  }

  /* The patterns the shipped motion module actually produces. This list read
     ['reading', 'folding-blob'] and ['running', 'folding-blob'] against a
     src/ in which the string 'folding-blob' does not occur at all, so the
     driver could not reach its first sample -- see REPORT-CIRCLE-HANDOVER.md.
     Reading is the settled character doing nothing else; tool work is the
     chat orbit set (src/home-circle-motion.js, actionMotion). */
  for (const [action, pattern] of [['idle', 'eyes'], ['thinking', 'cloudy-thinking'], ['reading', 'eyes'], ['writing', 'dots'], ['running', 'chat-orbit'], ['waiting', 'eyes']]) {
    if (process.env.HOME_MOTION_ACTIONS && !process.env.HOME_MOTION_ACTIONS.split(',').includes(action)) continue
    await page.locator(`[data-motion-action="${action}"]`).click()
    await page.waitForFunction(action => window.motionReview.ring.homeCircleFluid?.stats().agent.action === action, action)
    /* Before claiming anything about how this action LOOKS: the circle has to
       be on screen. The renderer can report itself perfectly healthy while the
       stylesheet holds the canvas at opacity 0, which is an empty ring and a
       full WebGL buffer -- the state the owner reported twice while every
       driver here was green. */
    await page.waitForTimeout(600)
    await assertVisibleInk(page, `rendered motion ${action}`)
    const frames = []
    const samples = action === 'idle' ? 96 : ['thinking', 'reading', 'running'].includes(action) ? 64 : 24
    for (let i = 0; i < samples; i++) {
      await page.waitForTimeout(250)
      await page.evaluate(() => { window.captureCircle = true })
      await page.waitForFunction(() => !window.captureCircle)
      const { stats, ink } = await page.evaluate(() => ({ stats: window.motionReview.ring.homeCircleFluid.stats(), ink: window.circleInk }))
      if (stats.agent.actionRest) {
        assert.equal(stats.agent.motion.pattern, 'eyes')
        assert.equal(stats.episode, null)
        const restFrames = report.actionRestFrames ||= []
        restFrames.push({ action, elapsed: stats.agent.elapsed, character: stats.agent.character, speed: stats.seat.speed, x: stats.seat.x, y: stats.seat.y, ink })
        if (restFrames.length === 1 || restFrames.length % 12 === 0) await page.screenshot({ path: path.join(output, `action-rest-${restFrames.length}.png`) })
        i--; continue
      }
      assert.equal(stats.agent.motion.pattern, pattern)
      assert.equal(stats.state, 'running')
      frames.push({ elapsed: stats.agent.elapsed, x: stats.seat.x, y: stats.seat.y, size: stats.agent.motion.size,
        character: stats.agent.character, speed: stats.seat.speed, bounceAge: stats.seat.bounceAge, wallRadius: stats.seat.wallRadius,
        phase: stats.agent.motion.phase, parts: stats.agent.parts, angles: stats.agent.angles, partSpin: stats.agent.partSpin,
        ring: stats.agent.ring, ringTurn: stats.agent.ringTurn, ringSpin: stats.agent.ringSpin, mass: stats.material.mass,
        episode: stats.episode, flow: stats.flow, ink, storm: stats.storm, steps: stats.steps, extras: stats.extras.on,
        sim: stats.sim, dye: stats.dye, workMs: stats.workMs, fullMs: stats.fullMs })
      if (i % 4 === 0) await page.screenshot({ path: path.join(output, `${action}-${i}.png`) })
    }
    report.cases.push({ action, pattern, frames })
    const settled = frames.slice(6)
    const range = key => Math.max(...settled.map(frame => frame[key])) - Math.min(...settled.map(frame => frame[key]))
    assert.ok(frames.every(frame => Math.hypot(frame.x - .5, frame.y - .5) <= frame.wallRadius + .001), `${action} respects the round frame with room for its own shape`)
    assert.ok(range('x') + range('y') > .01, `${action} retains its independent natural motion`)
    if (action === 'idle') {
      assert.ok(settled.some(frame => frame.character[0] < .02 && frame.character[1] < .05 && frame.ink.components === 2), 'the resting face has two distinct eyes')
      assert.ok(settled.some(frame => frame.character[0] > .98 && frame.ink.components === 1), 'the same material becomes one rounded body')
      assert.ok(settled.every(frame => frame.speed < .07), 'idle never becomes a sudden dash')
      assert.ok(settled.some(frame => frame.bounceAge < .7), 'the body reaches and rebounds from its stage')
      await page.waitForFunction(() => {
        const pose = window.motionReview.ring.homeCircleFluid.stats().agent.character
        return pose[0] < .02 && pose[1] < .1
      })
      const before = await page.evaluate(() => window.motionReview.ring.homeCircleFluid.stats())
      const bounds = await page.locator('.home-circle').boundingBox()
      await page.mouse.click(bounds.x + bounds.width * before.seat.x, bounds.y + bounds.height * (1 - before.seat.y))
      await page.waitForTimeout(150)
      const after = await page.evaluate(() => window.motionReview.ring.homeCircleFluid.stats())
      assert.ok(after.agent.character[1] > .25, 'a normal pointer click earns a small blink')
      assert.ok(Math.hypot(after.seat.x - before.seat.x, after.seat.y - before.seat.y) < .025, 'a greeting does not drag or launch the character')
      assert.equal(after.episode, null)
      report.idleGreeting = { before, after }
      await page.screenshot({ path: path.join(output, 'idle-greeting.png') })
      await page.mouse.move(8, 8)
    }
    if (action === 'thinking') {
      assert.ok(frames.every(frame => !frame.episode), 'Navier-Stokes is reserved for changing agents')
      assert.ok(frames.some(frame => frame.phase === 'swirl' && frame.flow.original > .8 && frame.flow.torque > .1 && frame.ink.spread > .14), 'thinking visibly plays the original cloudy motion')
    }
    if (pattern === 'chat-orbit') {
      const open = settled.filter(frame => frame.ringTurn[3] > .9)
      assert.ok(open.length > 4, `the bands open and stay open, got ${open.length} of ${settled.length}`)
      assert.ok(open.every(frame => frame.ring[0] > frame.ring[1] * 1.5 && frame.ring[1] > 0), 'an outer and an inner band, not one ring')
      assert.ok(open.some(frame => frame.ringSpin[0] > 0 && frame.ringSpin[1] < 0), 'the two bands turn against each other')
      assert.ok(settled.some(frame => frame.phase === 'pause' && frame.ringSpin.every(spin => Math.abs(spin) < 1e-9)), 'the rotation stops dead in the pause')
      /* No piece is ever placed away from the body's centre. This is the
         owner's five-spinning-dots report as a rendered check: see
         tools/home-circle-form-qa.mjs for the shape measurement that
         separates an arc from a dot on the real framebuffer. */
      assert.ok(settled.every(frame => frame.parts.every((value, i) => i % 4 > 1 || Math.abs(value) < .021)),
        'tool work turns bands of the body, it does not orbit satellites around it')
    }
    if (action === 'writing') assert.ok(settled.some(frame => frame.ink.components === 4), 'writing has four visible droplets')
    if (pattern === 'chat-orbit' || action === 'thinking') {
      const spreads = settled.map(frame => frame.ink.spread)
      assert.ok(Math.max(...spreads) > Math.min(...spreads) * 1.15, 'the rendered fluid changes its spread, not only its rotation')
    }
    console.log('PASS rendered motion', action, pattern)
  }
  /* THE TRANSITION HAS TO BE SAMPLED IN A REST-FREE WINDOW, and this is not a
     flake: the ten-second action rest (updateActionRest in
     src/home-circle-motion.js) changes displayAction, and agentDrive clears an
     agent-change episode whenever `resting` is true. Measured here: a rest
     beginning at clock 120.9 s cancelled a collapse that was 2.3 s in, so the
     relax phase never arrived. Starting the transition while no rest is active
     is not enough, because the next one can begin inside the ten seconds the
     episode needs. Each attempt that is interrupted says so and is retried;
     if every attempt is interrupted, that is reported as itself rather than
     quietly passing on a shorter sample. */
  /* EVERY PHASE THE EPISODE ENTERS, NOT THE ONES A SPARSE SAMPLE HAPPENS TO
     LAND ON. The phases are BLOWUP.collapse 3.4 s then BLOWUP.relax 1.1 s
     (src/home-circle-fluid.js), and the loop below steps about every 500 ms
     with a screenshot every fourth frame, so its spacing is both coarse and
     irregular against a 1.1 s window. Measured here across seven runs: six
     read `collapse x5, relax, relax, none...` and one read `collapse x5,
     none, none...` -- the same healthy episode, stepped straight over. That
     is aliasing, not a short window, so widening a timeout or loosening the
     assertion would have hidden it rather than fixed it.
     This records the phase every 50 ms in the page, so a 1.1 s phase is seen
     about twenty times and cannot be missed. The claim asserted below is
     unchanged -- the episode must really reach `relax` -- only the instrument
     is honest about it now. */
  await page.evaluate(() => {
    window.motionReview.phases = []
    window.motionReview.watch = setInterval(() => {
      const phase = window.motionReview.ring.homeCircleFluid?.stats().episode?.phase
      if (phase) window.motionReview.phases.push(phase)
    }, 50)
  })
  const attempts = []
  let transition = null, playedBefore = 0, transitionPhases = []
  for (let attempt = 1; attempt <= 3 && !transition; attempt++) {
    await page.waitForFunction(() => !window.motionReview.ring.homeCircleFluid.stats().agent.actionRest)
    await page.evaluate(() => { window.motionReview.phases.length = 0 })
    // Episodes are counted for the whole session, so a retry has to be judged
    // against the count it started from, not against 1.
    playedBefore = await page.evaluate(() => window.motionReview.ring.homeCircleFluid.stats().played)
    await page.locator('[data-motion-agent]').selectOption(attempt % 2 ? 'preview-b' : 'preview-a')
    await page.waitForFunction(() => window.motionReview.ring.homeCircleFluid.stats().episode?.reason === 'agent-change')
    const samples = []
    let interrupted = false
    for (let i = 0; i < 20 && !interrupted; i++) {
      await page.waitForTimeout(500)
      if (i === 2) await page.locator('[data-motion-action="writing"]').click()
      await page.evaluate(() => { window.captureCircle = true })
      await page.waitForFunction(() => !window.captureCircle)
      const sample = await page.evaluate(() => ({ stats: window.motionReview.ring.homeCircleFluid.stats(), ink: window.circleInk }))
      samples.push(sample)
      if (sample.stats.agent.actionRest) interrupted = true
      if (i % 4 === 0) await page.screenshot({ path: path.join(output, `agent-transition-${attempt}-${i}.png`) })
    }
    const watched = await page.evaluate(() => window.motionReview.phases.slice())
    attempts.push({ attempt, interrupted, phases: samples.map(s => s.stats.episode?.phase || 'none'),
      watched: [...new Set(watched)], watchedCount: watched.length })
    if (interrupted) console.log(`RETRY agent transition: the ten-second action rest began mid-episode on attempt ${attempt}`)
    else { transition = samples; transitionPhases = watched }
  }
  await page.evaluate(() => clearInterval(window.motionReview.watch))
  report.transitionAttempts = attempts
  assert.ok(transition, 'the ten-second action rest interrupted every attempt to sample an agent transition; nothing about the transition was measured')
  report.transition = transition
  report.transitionPhases = { seen: [...new Set(transitionPhases)], observations: transitionPhases.length }
  assert.ok(transition.some(frame => frame.stats.episode?.phase === 'collapse' && frame.stats.flow.pulses.some(value => value > 0) && frame.ink.mass > 10))
  // The watcher has to have actually watched, or "never saw relax" and "never
  // looked" would print the same thing -- which is the failure this replaced.
  assert.ok(transitionPhases.length > 20,
    `the phase watcher observed the episode ${transitionPhases.length} times; fewer than 20 means it was not running`)
  assert.ok(transitionPhases.includes('relax'),
    `the episode reaches its relax phase: saw ${JSON.stringify([...new Set(transitionPhases)])} over ${transitionPhases.length} observations`)
  assert.equal(transition.at(-1).stats.episode, null)
  assert.equal(transition.at(-1).stats.agent.animation, 'dots')
  assert.equal(transition.at(-1).stats.played - playedBefore, 1, 'changing activity during an agent switch does not restart it')
  console.log('PASS rendered agent transition and incoming action')
  await page.evaluate(() => window.motionReview.lean())
  await page.locator('[data-motion-action="reading"]').click()
  await page.waitForFunction(() => window.motionReview.ring.homeCircleFluid?.stats().steps > 40)
  const lean = await page.evaluate(() => window.motionReview.ring.homeCircleFluid.stats())
  assert.equal(lean.extras.on, false)
  assert.equal(lean.agent.motion.pattern, 'eyes')
  if (process.env.HOME_MOTION_WEBGL1 === '1') assert.equal(lean.webgl, 1)
  report.lean = lean
  await page.screenshot({ path: path.join(output, 'storm-lean.png') })
  /* THE OTHER AGENT, WHICHEVER ONE THAT IS. This selected 'preview-a' by name
     and waited for an agent-change episode, which only fires when the key
     actually CHANGES. The retry loop above alternates b, a, b, so a run that
     needed two attempts was already sitting on 'preview-a' and this was a
     no-op: no key change, no episode, and the driver timed out here after
     everything it measures had already passed. Seen once on the WebGL 1 pass
     and green on a re-run with no code change, which is what a parity flake
     looks like. Picking the option that is not the current one cannot land on
     the same value however many attempts the loop took. */
  const picker = page.locator('[data-motion-agent]')
  await picker.selectOption(await picker.inputValue() === 'preview-a' ? 'preview-b' : 'preview-a')
  await page.waitForFunction(() => window.motionReview.ring.homeCircleFluid.stats().episode?.reason === 'agent-change')
  report.passed = true
  assert.deepEqual(errors, [])
} catch (error) {
  report.passed = false; report.error = error.stack
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  await context.close()
  await browser.close()
}
