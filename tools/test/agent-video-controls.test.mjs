/* 1.0.49 VIDEO BOX, the Video section (SPEC-49 delivery C; DESIGN section 4
 * item 6). It sits directly under the Computer control card, in the same
 * right-hand column, inside "Voice, screen & video". Off by default; a person
 * picks a window from a grid of thumbnails; Turn off / Turn off all; after a
 * restart the saved choice asks for one press to reopen the list with the best
 * title match first, and nothing streams until the person picks.
 *
 * The page is the shared DOM stand-in with a stand-in for the preload's
 * mcVideoBox and a getDisplayMedia that hands back fake tracks. Every assertion
 * compares booleans, strings or numbers: a failing assert must never print a
 * stand-in element.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn()
const { createVideoBoxBroker, VIDEO_BOX_CHANGE_EVENT, VIDEO_BOX_PICK_EVENT, VIDEO_BOX_LIMIT } = await import('../../src/video-box-broker.js')
const { createAgentVideoControls, bestTitleMatch, VIDEO_SECTION_WORDS } = await import('../../src/agent-video-controls.js')
const { mountAgentScreenVoiceControls } = await import('../../src/agent-screen-voice-controls.js')
const { createScreenControlSettings } = await import('../../src/screen-control-settings.js')
const { resetPersistentVoice } = await import('../../src/voice-coordinator.js')
const { mountBoxVideo, unmountBoxVideo } = await import('../../src/tree-box-video.js')
const { TREE_VIEW_CHANGE_EVENT } = await import('../../src/tree-box-layout.js')

const settle = async (turns = 12) => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
const token = index => (index.toString(16).padStart(2, '0')).repeat(16)
const PRIVACY = 'ToolsEnabled does not record this video or send it to the agent. An agent you allow to take screenshots, for example with Computer control, can see the video like anything else on your screen. The window’s title is kept on this computer until you turn video off.'

function fakeTrack() {
  const listeners = new Map()
  return {
    stopped: 0, applied: [],
    stop() { this.stopped++ },
    applyConstraints(constraints) { this.applied.push(constraints); return Promise.resolve() },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener) },
    fire(type) { for (const listener of listeners.get(type) || []) listener({ type }) },
  }
}

/* The page: window.mcVideoBox shaped like shell/fleet-profile-preload.cjs, a
   getDisplayMedia that records its calls, and a broker bound to this page with
   timers that never fire on their own. */
function world(t, { bridge = true, media = true, windows = null, saved = [], supported = true } = {}) {
  const calls = [], tracks = []
  const answers = {
    sources: { ok: true, sources: windows || [
      { token: token(1), name: 'ROS · agent', thumbnail: 'data:image/png;base64,AAAA' },
      { token: token(2), name: 'notes.txt - Mousepad', thumbnail: '' },
    ] },
    saved: { ok: true, supported, records: [...saved] },
    arm: { ok: true }, remember: { ok: true, saved: {} }, forget: { ok: true }, clear: { ok: true },
  }
  const previous = { mcVideoBox: window.mcVideoBox, navigator: window.navigator, mcVoice: window.mcVoice, mcScreenControl: window.mcScreenControl }
  delete window.mcVideoBox
  delete window.mcScreenControl
  delete window.mcVoice
  window.navigator = {}
  if (media) {
    window.navigator.mediaDevices = {
      async getDisplayMedia(constraints) {
        calls.push(['getDisplayMedia', JSON.stringify(constraints)])
        const track = fakeTrack()
        tracks.push(track)
        return { getVideoTracks: () => [track], getTracks: () => [track] }
      },
    }
  }
  /* Main's store, as far as this page can tell: remember saves the title of
     the window that was armed, forget and clear remove choices. */
  const store = answers.saved.records
  const armed = new Map()
  const drop = nodeId => { for (let at = store.length - 1; at >= 0; at -= 1) if (nodeId === null || store[at].nodeId === nodeId) store.splice(at, 1) }
  if (bridge) {
    window.mcVideoBox = Object.freeze({
      sources: async () => { calls.push(['sources']); return answers.sources },
      arm: async request => {
        calls.push(['arm', request.nodeId, request.token])
        armed.set(request.nodeId, answers.sources.sources?.find(source => source.token === request.token)?.name || '')
        return answers.arm
      },
      forget: async request => { calls.push(['forget', request.nodeId, request.pickOnly === true]); if (!request.pickOnly) drop(request.nodeId); return answers.forget },
      saved: async () => { calls.push(['saved']); return answers.saved },
      remember: async request => {
        calls.push(['remember', request.nodeId])
        if (answers.remember.ok) { drop(request.nodeId); store.push({ nodeId: request.nodeId, title: armed.get(request.nodeId) || '', app: '', savedAt: Date.now() }) }
        return answers.remember
      },
      clear: async () => { calls.push(['clear']); drop(null); return answers.clear },
    })
  }
  // The broker's 10-minute timers wait for the test to run them.
  const timers = new Map()
  let nextTimer = 0
  const broker = createVideoBoxBroker({ host: window, setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer },
    clearTimer: id => { timers.delete(id) } })
  const runTimers = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback() } }
  const made = []
  t.after(() => {
    for (const item of made) item.destroy()
    broker.dispose()
    resetPersistentVoice()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete window[key]
      else window[key] = value
    }
  })
  function section(options = {}) {
    const controls = createAgentVideoControls({ broker, host: window, getTreeView: () => ({ style: 'boxes', editMode: false }), ...options })
    made.push(controls)
    document.body.append(controls.el)
    return controls
  }
  function panel(options = {}) {
    const marks = []
    const controls = mountAgentScreenVoiceControls({ onMarks: value => marks.push(value), videoBroker: broker,
      getTreeView: () => ({ style: 'boxes', editMode: false }), ...options })
    made.push(controls)
    document.body.append(controls.el)
    return { controls, marks }
  }
  const count = name => calls.filter(call => call[0] === name).length
  return { calls, tracks, answers, broker, section, panel, count, runTimers }
}

const part = (controls, name) => controls.el.querySelector(`[data-video-${name}]`)
const says = (controls, name) => part(controls, name)?.textContent || ''
const shown = (controls, name) => Boolean(part(controls, name)) && !part(controls, name).hidden
const windowButtons = controls => part(controls, 'windows')?.querySelectorAll('button') || []
const windowNames = controls => windowButtons(controls).map(button => button.querySelector('.agent-video-window-name')?.textContent || '')
const summaryText = el => (el.querySelector('summary')?.textContent || '').replace(/&amp;/g, '&')

test('video is off by default: nothing is listed, armed, captured or marked until the person asks', async t => {
  const { calls, section, panel, count } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  await settle()
  assert.equal(controls.el.dataset.state, 'off')
  assert.equal(says(controls, 'badge'), 'Off')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.off)
  assert.equal(says(controls, 'on'), 'Turn on video…')
  assert.equal(part(controls, 'on').disabled, false)
  assert.equal(shown(controls, 'picker'), false, 'the list of windows stays closed')
  assert.equal(shown(controls, 'off'), false, 'there is no video of this agent to turn off')
  assert.equal(count('sources') + count('arm') + count('getDisplayMedia') + count('remember'), 0)
  assert.deepEqual(controls.getNodeIds(), [])
  assert.equal(says(controls, 'privacy'), PRIVACY)
  assert.equal(calls.every(call => call[0] === 'saved'), true, 'only the saved choices are read')
  // The whole panel: its marks carry no video either.
  const { marks } = panel()
  await settle()
  assert.equal(marks.length > 0, true)
  assert.deepEqual(marks.at(-1).videoNodeIds, [])
})

test('the Video section is the next sibling of the Computer control card, in one right-hand column', async t => {
  const { panel } = world(t)
  const { controls } = panel()
  await settle()
  const body = controls.el.querySelector('.agent-control-body')
  const column = body.querySelector('.agent-control-column')
  assert.equal(Boolean(column), true, 'there is a right-hand column')
  assert.equal(column.parentNode === body, true)
  assert.equal(body.children.length, 2, 'voice on the left, the column on the right')
  assert.equal(body.children[1] === column, true)
  assert.deepEqual(column.children.map(child => child.className), ['screen-access-controls', 'agent-video-controls'])
  const videoSection = column.children[1]
  assert.equal(videoSection.hasAttribute('data-video-box-controls'), true, 'agent app control refuses to press anything in it')
  assert.equal(videoSection.getAttribute('aria-label'), 'Video')
  assert.equal(videoSection.querySelector('h3')?.textContent, 'Video')
  assert.equal(videoSection.contains(videoSection.querySelector('[data-video-picker]')), true, 'the window list is inside the refused section')
  assert.equal(summaryText(controls.el).startsWith('Voice, screen & video'), true)
})

test('Settings > App permissions shows computer control and no video, while the agent panel has both', async t => {
  const { panel } = world(t)
  window.mcScreenControl = { status: async () => ({ supported: true, permissionLevel: 'unrestricted', grants: [], agents: [] }), onEvent: () => () => {} }
  const settings = createScreenControlSettings()
  const host = document.createElement('div')
  host.innerHTML = settings.markup()
  document.body.append(host)
  settings.afterRender(host)
  t.after(() => { settings.destroy(); host.remove() })
  await settle()
  const slot = host.querySelector('[data-screen-control-settings]')
  assert.equal(Boolean(slot.querySelector('.screen-access-controls')), true, 'Settings still shows the Computer control card')
  assert.equal(Boolean(slot.querySelector('[data-video-box-controls]')), false, 'Settings shows no video controls')
  assert.equal(Boolean(slot.querySelector('.agent-video-controls')), false)
  assert.equal(slot.textContent.includes('Turn on video'), false)
  const { controls } = panel()
  await settle()
  assert.equal(Boolean(controls.el.querySelector('.agent-video-controls')), true, 'the agent panel has the Video section')
})

test('an agent that is not running can have video: the section is set before the running-agent lookup', async t => {
  const { panel, count } = world(t)
  const { controls } = panel()
  await settle()
  const chosen = await controls.selectAgent({ id: 'node-quiet', name: 'Quiet builder' })
  assert.equal(chosen, false, 'voice and computer control still need a running agent')
  assert.equal(controls.el.open, true)
  assert.equal(says(controls, 'agent'), 'For Quiet builder')
  assert.equal(part(controls, 'on').disabled, false, 'video does not need the agent to be running')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.off)
  assert.equal(count('arm') + count('getDisplayMedia'), 0)
})

test('the person picks a window from thumbnails; cancelling leaves video off', async t => {
  const { calls, tracks, section, count, broker } = world(t, { windows: [
    { token: token(1), name: '<img src=x onerror=alert(1)> ROS', thumbnail: 'data:image/png;base64,AAAA' },
    { token: token(2), name: 'notes.txt - Mousepad', thumbnail: 'javascript:alert(1)' },
  ] })
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  await settle()
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), 1)
  assert.equal(shown(controls, 'picker'), true)
  const buttons = windowButtons(controls)
  assert.equal(buttons.length, 2)
  assert.equal(buttons.every(button => button.tagName === 'BUTTON' && button.type === 'button'), true, 'each window is a button')
  assert.deepEqual(windowNames(controls), ['<img src=x onerror=alert(1)> ROS', 'notes.txt - Mousepad'])
  assert.equal(buttons[0].querySelector('.agent-video-window-name').children.length, 0, 'a window title is text, never markup')
  assert.equal(buttons[0].querySelector('img')?.src, 'data:image/png;base64,AAAA', 'the thumbnail is shown')
  assert.equal(buttons[1].querySelector('img')?.src || '', '', 'anything but a picture is never loaded')
  assert.equal(count('arm') + count('getDisplayMedia'), 0, 'opening the list starts nothing')
  // Cancel.
  part(controls, 'cancel').click()
  await settle()
  assert.equal(shown(controls, 'picker'), false)
  assert.equal(windowButtons(controls).length, 0, 'the tokens are dropped with the list')
  assert.equal(controls.el.dataset.state, 'off')
  assert.equal(broker.get('node-1'), null)
  assert.equal(count('arm') + count('getDisplayMedia'), 0)
  assert.equal(tracks.length, 0)
  assert.equal(document.activeElement === part(controls, 'on'), true, 'focus goes back to Turn on video')
  // Pick for real this time: arm, capture and remember, in that order.
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[1].click()
  await settle()
  assert.deepEqual(calls.filter(call => call[0] !== 'saved' && call[0] !== 'sources').map(call => call.slice(0, 2)),
    [['arm', 'node-1'], ['getDisplayMedia', '{"video":{"width":{"max":854},"height":{"max":480},"frameRate":{"max":10}},"audio":false}'], ['remember', 'node-1']])
  assert.equal(calls.find(call => call[0] === 'arm')[2], token(2), 'the token of the window the person pressed')
  assert.equal(shown(controls, 'picker'), false)
  assert.equal(broker.get('node-1')?.state, 'live')
  assert.equal(controls.el.dataset.state, 'live')
  assert.equal(says(controls, 'badge'), 'On')
  assert.equal(says(controls, 'status').includes('notes.txt - Mousepad'), true)
  assert.equal(says(controls, 'on'), 'Change window…')
  assert.equal(shown(controls, 'off'), true)
  assert.deepEqual(controls.getNodeIds(), ['node-1'])
})

test('Turn off video forgets that agent; a closed window says so until video is turned off', async t => {
  const { calls, tracks, section, broker } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[0].click()
  await settle()
  tracks[0].fire('ended')
  await settle()
  assert.equal(controls.el.dataset.state, 'ended')
  assert.equal(says(controls, 'badge'), 'Closed')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.ended)
  assert.deepEqual(controls.getNodeIds(), ['node-1'], 'the panel keeps its place and says Window closed')
  part(controls, 'off').click()
  await settle()
  assert.equal(broker.get('node-1'), null)
  assert.deepEqual(calls.filter(call => call[0] === 'forget').map(call => call.slice(1)), [['node-1', false]], 'turning video off forgets the choice')
  assert.deepEqual(controls.getNodeIds(), [])
  assert.equal(controls.el.dataset.state, 'off')
})

test('turning video off while it starts says it is off, never that it did not start', async t => {
  const { section, broker } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  let reject
  window.navigator.mediaDevices.getDisplayMedia = () => new Promise((_, no) => { reject = no })
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(controls.el.dataset.state, 'starting')
  part(controls, 'off').click()
  await settle()
  reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
  await settle()
  assert.equal(broker.get('node-1'), null)
  assert.equal(controls.el.dataset.state, 'off')
  assert.equal(says(controls, 'badge'), 'Off')
  assert.equal(says(controls, 'status') === VIDEO_SECTION_WORDS.startFailed, false, 'the person turned it off; nothing failed')
})

test('the cap message appears when a seventh video is asked for, and no list opens', async t => {
  const { section, count, broker } = world(t)
  const controls = section()
  for (let index = 1; index <= VIDEO_BOX_LIMIT; index += 1) {
    controls.setAgent({ id: `node-${index}`, name: `Agent ${index}` })
    part(controls, 'on').click()
    await settle()
    windowButtons(controls)[0].click()
    await settle()
  }
  assert.equal(broker.list().filter(view => view.state === 'live').length, VIDEO_BOX_LIMIT)
  const listed = count('sources')
  controls.setAgent({ id: 'node-7', name: 'Agent 7' })
  part(controls, 'on').click()
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.limit)
  assert.equal(VIDEO_SECTION_WORDS.limit.includes(String(VIDEO_BOX_LIMIT)), true)
  assert.equal(shown(controls, 'picker'), false)
  assert.equal(count('sources'), listed, 'the list of windows was not read')
  assert.equal(broker.get('node-7'), null)
  // An agent that already has one can still change its window.
  controls.setAgent({ id: 'node-3', name: 'Agent 3' })
  part(controls, 'on').click()
  await settle()
  assert.equal(shown(controls, 'picker'), true)
})

test('each case where video cannot run says why in plain words', async t => {
  await t.test('the browser, the phone and the paired window have no desktop bridge', async t => {
    const { section, count } = world(t, { bridge: false })
    const controls = section()
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.desktopOnly)
    assert.equal(part(controls, 'on').disabled, true)
    assert.equal(part(controls, 'off-all').disabled, true)
    assert.deepEqual(controls.getNodeIds(), [])
    assert.equal(count('saved'), 0)
  })
  await t.test('Linux Wayland: main says the desktop cannot capture a window', async t => {
    const { section } = world(t, { supported: false, saved: [{ nodeId: 'node-1', title: 'ROS · agent', app: '', savedAt: 1 }] })
    const controls = section()
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.unsupported)
    assert.equal(part(controls, 'on').disabled, true)
    assert.deepEqual(controls.getNodeIds(), [], 'no panel asks to pick a window that cannot be shown')
  })
  await t.test('a refused list of windows is read out and turns the section off', async t => {
    const { section, answers } = world(t)
    answers.sources = { ok: false, code: 'VIDEO_UNAVAILABLE', reason: 'Video is not available on this desktop. It needs Windows or a Linux desktop that uses X11.' }
    const controls = section()
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    part(controls, 'on').click()
    await settle()
    assert.equal(shown(controls, 'picker'), false)
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.unsupported)
    assert.equal(part(controls, 'on').disabled, true)
  })
  await t.test('saved choices that cannot be read are reported, with what to do', async t => {
    const { section, answers } = world(t)
    answers.saved = { ok: false, code: 'VIDEO_SAVED_UNREADABLE', reason: 'The saved video choices could not be read. Turn off all video to clear them.' }
    const controls = section()
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(says(controls, 'status'), answers.saved.reason)
    assert.equal(part(controls, 'on').disabled, false)
  })
  await t.test('an agent on another computer', async t => {
    const { section } = world(t)
    const controls = section({ getComputerId: () => 'desk-2' })
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.otherComputer)
    assert.equal(part(controls, 'on').disabled, true)
  })
  await t.test('a group box and a New agent tab', async t => {
    const { section } = world(t)
    const controls = section()
    controls.setAgent({ id: '@tree-group:3', name: 'Builders', treeScope: { group: true } })
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.group)
    assert.equal(part(controls, 'on').disabled, true)
    controls.setAgent({ id: 'standalone-3f9f14df-89d3-4144-8136-f23fc616367f', name: 'Agent 1' })
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.standalone)
    assert.equal(part(controls, 'on').disabled, true)
  })
  await t.test('the example tree', async t => {
    const { section, count } = world(t)
    const controls = section({ sample: true })
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.sample)
    assert.equal(part(controls, 'on').disabled, true)
    assert.equal(count('saved'), 0)
  })
  await t.test('no agent chosen yet', async t => {
    const { section } = world(t)
    const controls = section()
    await settle()
    assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.noAgent)
    assert.equal(part(controls, 'on').disabled, true)
  })
  await t.test('Circles or edit mode: the reason is shown and the control stays usable', async t => {
    const { section } = world(t, { saved: [{ nodeId: 'node-1', title: 'ROS · agent', app: '', savedAt: 1 }] })
    let view = { style: 'circles', editMode: false }
    const controls = section({ getTreeView: () => view })
    controls.setAgent({ id: 'node-1', name: 'Builder' })
    await settle()
    assert.equal(shown(controls, 'view'), true)
    assert.equal(says(controls, 'view'), VIDEO_SECTION_WORDS.boxesOnly)
    assert.equal(VIDEO_SECTION_WORDS.boxesOnly, 'Switch the tree to Boxes to see this video.')
    assert.equal(part(controls, 'on').disabled, false)
    view = { style: 'boxes', editMode: true }
    await controls.refresh()
    assert.equal(says(controls, 'view'), VIDEO_SECTION_WORDS.editMode, 'Boxes is already chosen: the way out is Done')
    view = { style: 'boxes', editMode: false }
    await controls.refresh()
    assert.equal(shown(controls, 'view'), false)
  })
  // Every message is one plain sentence or two, with no internal id or code.
  for (const [name, words] of Object.entries(VIDEO_SECTION_WORDS)) {
    assert.equal(typeof words, 'string', name)
    assert.equal(/[A-Z]{2,}_[A-Z_]+/.test(words), false, `${name} shows a code`)
    for (const sentence of words.split(/(?<=[.!?])\s+/)) assert.equal(sentence.split(/\s+/).length <= 25, true, `${name}: "${sentence}"`)
  }
})

/* STAGE D, D2, and REVIEW 2, item 3. An open section kept "Showing … under
   this agent's box." after the tree went to Circles or edit mode, and its note
   said "Switch the tree to Boxes" in edit mode with Boxes chosen (only Done is
   shown there) and with no video at all. */
test('an open section follows the tree: Circles and edit mode say why the video is not shown, and how to see it', async t => {
  const { section } = world(t)
  let view = { style: 'boxes', editMode: false }
  const controls = section({ getTreeView: () => view })
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  const tell = next => { view = next; window.dispatchEvent(new CustomEvent(TREE_VIEW_CHANGE_EVENT)) }
  await settle()
  tell({ style: 'circles', editMode: false })
  assert.equal(shown(controls, 'view'), false, 'no video, so nothing to switch for')
  tell({ style: 'boxes', editMode: false })
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(says(controls, 'status'), 'Showing “ROS · agent” under this agent’s box.')
  assert.equal(shown(controls, 'view'), false)
  tell({ style: 'circles', editMode: false })
  assert.equal(says(controls, 'status'), 'Video of “ROS · agent” is on for this agent.', 'no box shows it now')
  assert.equal(shown(controls, 'view'), true)
  assert.equal(says(controls, 'view'), VIDEO_SECTION_WORDS.boxesOnly)
  tell({ style: 'boxes', editMode: true })
  assert.equal(says(controls, 'status'), 'Video of “ROS · agent” is on for this agent.')
  assert.equal(says(controls, 'view'), 'Press Done to leave edit mode and see this video.')
  tell({ style: 'circles', editMode: true })
  assert.equal(says(controls, 'view'), 'Press Done to leave edit mode, then switch the tree to Boxes to see this video.')
  tell({ style: 'boxes', editMode: false })
  assert.equal(shown(controls, 'view'), false)
  assert.equal(says(controls, 'status'), 'Showing “ROS · agent” under this agent’s box.')
  const listening = () => window.listeners.get(TREE_VIEW_CHANGE_EVENT)?.length || 0
  const before = listening()
  controls.destroy()
  assert.equal(listening(), before - 1, 'a destroyed section stops listening')
})

test('a video out of sight for 10 minutes stops, and Resume in the section starts the same window again', async t => {
  const { calls, section, broker, runTimers } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[0].click()
  await settle()
  runTimers()
  await settle()
  assert.equal(broker.get('node-1')?.state, 'paused')
  assert.equal(says(controls, 'badge'), 'Paused')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.paused)
  assert.equal(says(controls, 'on'), 'Resume')
  const armed = calls.filter(call => call[0] === 'arm').length
  part(controls, 'on').click()
  await settle()
  assert.equal(shown(controls, 'picker'), false, 'resume finds the window by its name, without the list')
  assert.equal(calls.filter(call => call[0] === 'arm').length, armed + 1)
  assert.equal(calls.filter(call => call[0] === 'arm').at(-1)[2], token(1))
  assert.equal(broker.get('node-1')?.state, 'live')
  assert.equal(says(controls, 'badge'), 'On')
})

test('Turn off all video stops every track and forgets every saved choice', async t => {
  const { calls, tracks, section, broker } = world(t, { saved: [{ nodeId: 'node-9', title: 'Old', app: '', savedAt: 1 }] })
  const controls = section()
  for (const id of ['node-1', 'node-2']) {
    controls.setAgent({ id, name: id })
    part(controls, 'on').click()
    await settle()
    windowButtons(controls)[0].click()
    await settle()
  }
  assert.deepEqual(controls.getNodeIds(), ['node-1', 'node-2', 'node-9'])
  part(controls, 'off-all').click()
  await settle()
  assert.equal(tracks.length, 2)
  assert.equal(tracks.every(track => track.stopped === 1), true, 'every track is stopped')
  assert.equal(broker.list().length, 0)
  assert.equal(calls.some(call => call[0] === 'clear'), true, 'main forgets every choice')
  assert.deepEqual(controls.getNodeIds(), [])
  assert.equal(controls.el.dataset.state, 'off')
})

test('after a restart, one press reopens the list with the best title match first, and nothing streams until the person picks', async t => {
  const saved = [
    { nodeId: 'node-1', title: 'ROS · agent - Xephyr', app: 'Xephyr', savedAt: 1 },
    { nodeId: 'node-2', title: 'Gazebo', app: '', savedAt: 2 },
  ]
  const { calls, tracks, panel, count, broker } = world(t, { saved, windows: [
    { token: token(1), name: 'notes.txt - Mousepad', thumbnail: '' },
    { token: token(2), name: 'ROS · agent - Xephyr', thumbnail: 'data:image/png;base64,AAAA' },
    { token: token(3), name: 'Terminal', thumbnail: '' },
  ] })
  const { controls, marks } = panel()
  await settle()
  // The tree marks both agents, so each box shows "Video was on for this agent. Pick the window again."
  assert.deepEqual(marks.at(-1).videoNodeIds, ['node-1', 'node-2'])
  // Review 2, item 4: nothing streams yet, so the summary does not claim any video is on.
  assert.equal(summaryText(controls.el).includes('with video'), false)
  assert.deepEqual(marks.at(-1).videoStartedNodeIds, [], 'the voice buttons say "video saved", not "video on"')
  assert.equal(count('arm') + count('getDisplayMedia') + count('sources'), 0, 'nothing streams from a saved choice')
  await controls.selectAgent({ id: 'node-1', name: 'Builder' })
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.saved)
  assert.equal(VIDEO_SECTION_WORDS.saved, 'Video was on for this agent. Pick the window again.')
  assert.equal(says(controls, 'on'), 'Pick the window again')
  assert.equal(says(controls, 'badge'), 'Saved')
  assert.equal(shown(controls, 'off'), true, 'the saved choice can be turned off without picking')
  // One press: the list opens with the best match first, focused and marked.
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), 1)
  assert.deepEqual(windowNames(controls), ['ROS · agent - Xephyr', 'notes.txt - Mousepad', 'Terminal'])
  const first = windowButtons(controls)[0]
  assert.equal(first.dataset.videoSuggested, 'true')
  assert.equal(windowButtons(controls).filter(button => button.dataset.videoSuggested === 'true').length, 1)
  assert.equal(document.activeElement === first, true, 'Enter picks it; nothing picks it for the person')
  assert.equal(says(controls, 'last').includes('ROS · agent - Xephyr'), true, 'the list says what was shown last time')
  assert.equal(count('arm') + count('getDisplayMedia') + tracks.length, 0, 'still nothing streams')
  assert.equal(broker.get('node-1'), null)
  // The person picks.
  first.click()
  await settle()
  assert.equal(calls.find(call => call[0] === 'arm')?.[2], token(2))
  assert.equal(broker.get('node-1')?.state, 'live')
  assert.equal(tracks.length, 1)
  assert.equal(summaryText(controls.el).includes('1 with video'), true, 'the one that streams now')
  assert.deepEqual(marks.at(-1).videoStartedNodeIds, ['node-1'])
  assert.deepEqual(marks.at(-1).videoNodeIds, ['node-1', 'node-2'], 'node-2 still shows its Pick the window again panel')
})

test('a panel\'s Pick the window again opens this section\'s list for that agent', async t => {
  const { panel, count, broker } = world(t, { saved: [{ nodeId: 'node-2', title: 'Gazebo', app: '', savedAt: 2 }], windows: [
    { token: token(1), name: 'Terminal', thumbnail: '' },
    { token: token(2), name: 'Gazebo', thumbnail: '' },
  ] })
  const { controls } = panel()
  await settle()
  controls.el.open = false
  // The panel under the box, as the tree draws it for a saved choice after a restart.
  const record = { id: 'node-2', agent: { name: 'Simulator' }, el: document.createElement('div') }
  document.body.append(record.el)
  const box = mountBoxVideo(record, { broker })
  t.after(() => { unmountBoxVideo(record); record.el.remove() })
  assert.equal(box.dataset.videoState, 'saved')
  box.querySelector('.tree-box-video-action').click()
  await settle()
  assert.equal(controls.el.open, true, 'the panel opens')
  assert.equal(says(controls, 'agent'), 'For Simulator')
  assert.equal(count('sources'), 1)
  assert.deepEqual(windowNames(controls), ['Gazebo', 'Terminal'])
  assert.equal(windowButtons(controls)[0].dataset.videoSuggested, 'true')
  assert.equal(count('arm') + count('getDisplayMedia'), 0)
  // A request with no usable node id does nothing.
  window.dispatchEvent(new CustomEvent(VIDEO_BOX_PICK_EVENT, { detail: { nodeId: '' } }))
  await settle()
  assert.equal(says(controls, 'agent'), 'For Simulator')
})

/* REVIEW 0, item 3: with 6 videos on, a panel's "Pick the window again" still
   read every window with thumbnails and showed the list; the refusal came
   only after a window was pressed. */
test('a panel\'s Pick the window again with 6 videos on says so and reads no list', async t => {
  const { section, count } = world(t, { saved: [{ nodeId: 'node-7', title: 'Gazebo', app: '', savedAt: 1 }] })
  const controls = section()
  for (let index = 1; index <= VIDEO_BOX_LIMIT; index += 1) {
    controls.setAgent({ id: `node-${index}`, name: `Agent ${index}` })
    part(controls, 'on').click()
    await settle()
    windowButtons(controls)[0].click()
    await settle()
  }
  const listed = count('sources')
  window.dispatchEvent(new CustomEvent(VIDEO_BOX_PICK_EVENT, { detail: { nodeId: 'node-7', name: 'Agent 7' } }))
  await settle()
  assert.equal(says(controls, 'agent'), 'For Agent 7')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.limit)
  assert.equal(shown(controls, 'picker'), false)
  assert.equal(count('sources'), listed, 'no window was listed')
})

/* REVIEW 2, item 1: a paused video whose window was renamed (or has a twin)
   could only be resumed, which failed again and again; the only way out was
   Turn off video, which also forgot the saved choice. */
test('a paused video whose window was renamed is picked again from the section or its panel, and nothing streams until then', async t => {
  const { section, answers, count, broker, runTimers } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[0].click()
  await settle()
  runTimers()
  await settle()
  assert.equal(says(controls, 'on'), 'Resume')
  answers.sources = { ok: true, sources: [
    { token: token(2), name: 'notes.txt - Mousepad', thumbnail: '' },
    { token: token(3), name: 'ROS · agent (renamed)', thumbnail: '' },
  ] }
  const armed = count('arm')
  part(controls, 'on').click()
  await settle()
  assert.equal(broker.get('node-1')?.state, 'paused')
  assert.equal(says(controls, 'status'), 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.')
  assert.equal(says(controls, 'on'), 'Pick the window again', 'the button does what the words say')
  // The section's button opens the list, closest title first, and picks nothing.
  const listed = count('sources')
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), listed + 1)
  assert.equal(shown(controls, 'picker'), true)
  assert.deepEqual(windowNames(controls), ['ROS · agent (renamed)', 'notes.txt - Mousepad'])
  assert.equal(windowButtons(controls)[0].dataset.videoSuggested, 'true')
  assert.equal(count('arm'), armed, 'nothing streams until the person presses a window')
  part(controls, 'cancel').click()
  await settle()
  // The panel under the box does the same: its button asks the section for the list.
  const record = { id: 'node-1', agent: { name: 'Builder' }, el: document.createElement('div') }
  document.body.append(record.el)
  const panel = mountBoxVideo(record, { broker })
  t.after(() => { unmountBoxVideo(record); record.el.remove() })
  const action = panel.querySelector('.tree-box-video-action')
  assert.equal(action.textContent, 'Pick the window again')
  action.click()
  await settle()
  assert.equal(shown(controls, 'picker'), true)
  assert.equal(count('sources'), listed + 2)
  assert.equal(count('arm'), armed)
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(broker.get('node-1')?.state, 'live')
  assert.equal(broker.get('node-1')?.label, 'ROS · agent (renamed)')
})

/* 1.0.50 REVIEW video F4: main's tokens last 60 s, and any new list ends the
   open one's. A press on an out-of-date list read the list again, inside the
   same click, and kept it open with the same window focused; it did not close
   the list and send the person back to the start. */
test('a press on an out-of-date list reads the list again and keeps it open on the same window (1.0.50 review video F4)', async t => {
  const { calls, section, answers, count, broker } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), 1)
  answers.arm = { ok: false, code: 'VIDEO_PICK_EXPIRED', reason: 'This list of windows is out of date. Open the list again and pick the window.' }
  windowButtons(controls)[1].click()
  await settle()
  assert.equal(count('arm'), 1)
  assert.equal(count('sources'), 2, 'the list was read again')
  assert.equal(count('getDisplayMedia'), 0, 'nothing streams from an out-of-date list')
  assert.equal(shown(controls, 'picker'), true, 'the list stays open')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.listRenewed)
  assert.equal(document.activeElement?.querySelector?.('.agent-video-window-name')?.textContent || '', 'notes.txt - Mousepad', 'the same window is focused')
  assert.equal(broker.get('node-1'), null)
  // The next press starts that window.
  answers.arm = { ok: true }
  document.activeElement.click()
  await settle()
  assert.equal(broker.get('node-1')?.state, 'live')
  assert.equal(broker.get('node-1')?.label, 'notes.txt - Mousepad')
  assert.equal(calls.filter(call => call[0] === 'arm').at(-1)[2], token(2))
  // A window that is gone is not read again: the list closes and says why.
  part(controls, 'off').click()
  await settle()
  part(controls, 'on').click()
  await settle()
  const listed = count('sources')
  answers.arm = { ok: false, code: 'VIDEO_WINDOW_GONE', reason: 'gone' }
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(count('sources'), listed)
  assert.equal(shown(controls, 'picker'), false)
  assert.equal(says(controls, 'status'), 'gone')
})

/* 1.0.50 REVIEW-1050 #16: when the list read again after an out-of-date
   press no longer had the pressed window, the section still said "Press your
   window again" and focused the first window in the new list, so Enter
   started video of a different window. */
test('an out-of-date press whose window is not in the new list says so and focuses Refresh list (1.0.50 review #16)', async t => {
  const { section, answers, count, broker } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  answers.arm = { ok: false, code: 'VIDEO_PICK_EXPIRED', reason: 'This list of windows is out of date. Open the list again and pick the window.' }
  answers.sources = { ok: true, sources: [
    { token: token(3), name: 'Bank statement - Firefox', thumbnail: '' },
    { token: token(4), name: 'ROS · agent', thumbnail: '' },
  ] }
  windowButtons(controls)[1].click()
  await settle()
  assert.equal(count('sources'), 2, 'the list was read again')
  assert.equal(shown(controls, 'picker'), true, 'the list stays open')
  assert.notEqual(says(controls, 'status'), VIDEO_SECTION_WORDS.listRenewed, 'the pressed window is not there to press again')
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.windowGone)
  assert.equal(document.activeElement === part(controls, 'refresh'), true, 'focus is on Refresh list, not on another window')
  // Enter on the focused control reads the list again; it starts nothing.
  answers.arm = { ok: true }
  document.activeElement.click()
  await settle()
  assert.equal(count('sources'), 3)
  assert.equal(count('getDisplayMedia'), 0)
  assert.equal(broker.get('node-1'), null)
})

/* 1.0.50 REVIEW video F7: main lists at most 40 windows. When it cut the
   list, the section says how many there are and what to do. */
test('a list cut at 40 windows says so; a normal list does not (1.0.50 review video F7)', async t => {
  const many = Array.from({ length: 40 }, (_, index) => ({ token: token(index + 1), name: 'Window ' + index, thumbnail: '' }))
  const { section, answers } = world(t)
  answers.sources = { ok: true, sources: many, total: 57 }
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  assert.equal(windowButtons(controls).length, 40)
  assert.equal(shown(controls, 'more'), true)
  assert.equal(says(controls, 'more'), 'This list shows 40 of 57 windows. If yours is missing, close windows you do not need, then press Refresh list.')
  // More windows than main would ever send: the section counts what it was given.
  answers.sources = { ok: true, sources: [...many, { token: token(99), name: 'Window 40', thumbnail: '' }] }
  part(controls, 'refresh').click()
  await settle()
  assert.equal(windowButtons(controls).length, 40)
  assert.equal(says(controls, 'more'), 'This list shows 40 of 41 windows. If yours is missing, close windows you do not need, then press Refresh list.')
  // Every window fits: no note.
  answers.sources = { ok: true, sources: many.slice(0, 2), total: 2 }
  part(controls, 'refresh').click()
  await settle()
  assert.equal(windowButtons(controls).length, 2)
  assert.equal(shown(controls, 'more'), false)
  assert.equal(says(controls, 'more'), '')
  part(controls, 'cancel').click()
  await settle()
  assert.equal(shown(controls, 'more'), false)
})

/* 1.0.50 REVIEW video F8: a fleet agent that matches no saved node keeps a
   box and a mic button, but main refuses its video at arm ("no longer on
   this computer's tree") after every window's thumbnail was shown. The
   section now says so before any list is read. */
test('a box that is not a saved tree node gets no window list and says why (1.0.50 review video F8)', async t => {
  const { section, panel, count, broker } = world(t)
  const isSavedTreeAgent = agent => Boolean(agent?.treeNode)
  const controls = section({ isSavedTreeAgent })
  controls.setAgent({ id: 'fleet-7', name: 'Fleet agent' })
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.notSaved)
  assert.equal(part(controls, 'on').disabled, true)
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), 0, 'no window is listed for it')
  assert.equal(shown(controls, 'picker'), false)
  // A saved node is allowed, and so is an agent with a saved choice or a video.
  controls.setAgent({ id: 'node-1', name: 'Builder', treeNode: { id: 'node-1' } })
  await settle()
  assert.equal(part(controls, 'on').disabled, false)
  part(controls, 'on').click()
  await settle()
  assert.equal(count('sources'), 1)
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(broker.get('node-1')?.state, 'live')
  // A panel's "Pick the window again" names only the id: its video keeps it eligible.
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  await settle()
  assert.equal(part(controls, 'on').disabled, false)
  // A predicate that throws leaves the decision to main.
  const lenient = section({ isSavedTreeAgent: () => { throw new Error('no tree') } })
  lenient.setAgent({ id: 'node-2', name: 'Other' })
  await settle()
  assert.equal(part(lenient, 'on').disabled, false)
  // The agent pop-over passes the rule through to its Video section.
  const { controls: popover } = panel({ isSavedTreeAgent })
  await popover.selectAgent({ id: 'fleet-8', name: 'Fleet agent' })
  await settle()
  assert.equal(popover.el.querySelector('[data-video-status]')?.textContent || '', VIDEO_SECTION_WORDS.notSaved)
  assert.equal(VIDEO_SECTION_WORDS.notSaved, 'Only agents saved on this computer’s tree can have video. Pick an agent from a saved tree.')
  // Computers mounts the pop-over with the rule: a saved node's record carries its treeNode.
  const computers = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.equal(/mountAgentScreenVoiceControls\(\{[^}]*isSavedTreeAgent: agent => Boolean\(agent\?\.treeNode\)/.test(computers), true)
})

/* 1.0.50 REVIEW-1050 #6: "Pick the window again" on a box names only the id,
   so the section lost the saved node's treeNode. Once Turn off video or Turn
   off all video cleared the saved choice and the video, the section said the
   saved agent was "not saved" and disabled Turn on video. */
test('a saved agent opened from its box panel stays eligible after Turn off video or Turn off all video (1.0.50 review #6)', async t => {
  const { section, broker } = world(t, { saved: [
    { nodeId: 'node-2', title: 'Gazebo', app: '', savedAt: 2 },
    { nodeId: 'node-3', title: 'Gazebo', app: '', savedAt: 3 },
    { nodeId: 'node-4', title: 'Gazebo', app: '', savedAt: 4 },
  ], windows: [
    { token: token(1), name: 'Terminal', thumbnail: '' },
    { token: token(2), name: 'Gazebo', thumbnail: '' },
  ] })
  const controls = section({ isSavedTreeAgent: agent => Boolean(agent?.treeNode) })
  await settle()
  const pressPanel = nodeId => {
    const record = { id: nodeId, agent: { name: 'Simulator' }, el: document.createElement('div') }
    document.body.append(record.el)
    const box = mountBoxVideo(record, { broker })
    t.after(() => { unmountBoxVideo(record); record.el.remove() })
    box.querySelector('.tree-box-video-action').click()
  }
  // Cancel, then Turn off video.
  pressPanel('node-2')
  await settle()
  assert.equal(shown(controls, 'picker'), true)
  part(controls, 'cancel').click()
  part(controls, 'off').click()
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.off)
  assert.equal(part(controls, 'on').disabled, false, 'Cancel, then Turn off video')
  // Pick from the panel, go live, then Turn off video.
  pressPanel('node-3')
  await settle()
  windowButtons(controls)[0].click()
  await settle()
  assert.equal(broker.get('node-3')?.state, 'live')
  part(controls, 'off').click()
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.off)
  assert.equal(part(controls, 'on').disabled, false, 'go live, then Turn off video')
  // Pick from the panel, then Turn off all video: the confirmation stays.
  pressPanel('node-4')
  await settle()
  part(controls, 'off-all').click()
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.allOff)
  assert.equal(part(controls, 'on').disabled, false, 'Turn off all video')
  // A fleet agent picked directly is still refused before any list is read.
  controls.setAgent({ id: 'fleet-9', name: 'Fleet agent' })
  await settle()
  assert.equal(says(controls, 'status'), VIDEO_SECTION_WORDS.notSaved)
  assert.equal(part(controls, 'on').disabled, true)
})

/* REVIEW 2, item 5: picking a window removed the focused button and left
   focus nowhere, and the main button is disabled while the video starts. */
test('after a window is picked, keyboard focus moves to Turn off video', async t => {
  const { section } = world(t)
  const controls = section()
  controls.setAgent({ id: 'node-1', name: 'Builder' })
  part(controls, 'on').click()
  await settle()
  windowButtons(controls)[0].click()
  assert.equal(shown(controls, 'off'), true)
  assert.equal(document.activeElement === part(controls, 'off'), true)
  await settle()
  assert.equal(document.activeElement === part(controls, 'off'), true)
})

test('the best title match: the same title, else the closest title from the same program, else none', () => {
  const list = names => names.map((name, index) => ({ token: token(index + 1), name }))
  assert.equal(bestTitleMatch(list(['a', 'ROS · agent', 'ROS · agent']), { title: 'ROS · agent' }), 1, 'the first exact title')
  assert.equal(bestTitleMatch(list(['Terminal', 'ros · AGENT']), { title: 'ROS · agent' }), 1, 'case does not matter')
  assert.equal(bestTitleMatch(list(['report.pdf - Viewer', 'plan v2.txt - Mousepad', 'plan.txt - Gedit']), { title: 'plan.txt - Mousepad', app: 'Mousepad' }), 1,
    'a renamed file in the same program')
  assert.equal(bestTitleMatch(list(['Terminal', 'Files']), { title: 'Gazebo', app: '' }), -1, 'nothing close: no suggestion')
  assert.equal(bestTitleMatch(list(['Gazebo']), { title: '', app: '' }), -1)
  assert.equal(bestTitleMatch([], { title: 'Gazebo' }), -1)
})

test('the panel counts and marks follow the broker, and destroy lets go of every listener', async t => {
  const { panel, broker, answers } = world(t)
  const { controls, marks } = panel()
  await settle()
  // Started outside this section, and never saved: only the broker's change event can tell the panel.
  answers.remember = { ok: false, code: 'VIDEO_SAVED_WRITE_FAILED', reason: 'This video choice could not be saved, so it will not come back after a restart.' }
  const started = await broker.start('node-1', { token: token(1), label: 'ROS · agent' })
  assert.equal(started.ok, true)
  await settle()
  assert.deepEqual(marks.at(-1).videoNodeIds, ['node-1'])
  assert.equal(summaryText(controls.el).includes('1 with video'), true)
  await broker.stop('node-1')
  await settle()
  assert.deepEqual(marks.at(-1).videoNodeIds, [], 'a change event from the broker re-marks the tree')
  assert.equal(summaryText(controls.el).includes('with video'), false)
  const count = type => window.listeners.get(type)?.length || 0
  const before = [count(VIDEO_BOX_CHANGE_EVENT), count(VIDEO_BOX_PICK_EVENT)]
  const marked = marks.length
  controls.destroy()
  assert.deepEqual([count(VIDEO_BOX_CHANGE_EVENT), count(VIDEO_BOX_PICK_EVENT)], [before[0] - 2, before[1] - 1],
    'the panel\'s and the section\'s listeners are gone')
  window.dispatchEvent(new CustomEvent(VIDEO_BOX_CHANGE_EVENT, { detail: { nodeIds: ['node-1'] } }))
  assert.equal(marks.length, marked, 'a destroyed panel marks nothing')
})

/* STAGE D, D5, and REVIEW 2, items 6 and 7, plus tools/test/ledger-words-wrap.
   The pop-over's summary is a flex row, which drops the space before the count
   ("Voice, screen & video· 1 with video"); the window list, about 299 px wide
   in the pop-over, showed one thumbnail a row; and the clamped window title
   broke words at the first character. */
test('the summary count keeps its space, the window list fits two thumbnails a row, and a clamped title breaks by words', () => {
  const panelCss = readFileSync(new URL('../../src/agent-screen-voice-controls.css', import.meta.url), 'utf8')
  assert.match(panelCss, /\.agent-screen-voice-controls > summary \[data-control-count\]:not\(:empty\) \{ margin-left: \.35em; \}/)
  const videoCss = readFileSync(new URL('../../src/agent-video-controls.css', import.meta.url), 'utf8')
  const grid = videoCss.match(/\.agent-video-windows \{([^}]*)\}/)?.[1] || ''
  const narrowest = Number(grid.match(/minmax\((\d+)px, 1fr\)/)?.[1]), gap = Number(grid.match(/gap: (\d+)px/)?.[1])
  assert.equal(Number.isFinite(narrowest) && Number.isFinite(gap), true)
  assert.equal(2 * narrowest + gap <= 299 - 4, true, `two ${narrowest} px thumbnails and the gap fit the list (measured in stage D)`)
  const title = videoCss.match(/\.agent-video-window-name \{([^}]*)\}/)?.[1] || ''
  assert.equal(/-webkit-line-clamp: 2/.test(title), true)
  assert.equal(/overflow-wrap: anywhere/.test(title), false)
  assert.equal(/overflow-wrap: break-word/.test(title), true)
})

test('the guide describes the Video section, its privacy words and the small Xephyr window', () => {
  const guide = readFileSync(new URL('../../docs/agent-voice-and-screen-controls.md', import.meta.url), 'utf8')
  assert.equal(guide.includes('## Video under an agent’s box'), true)
  assert.equal(guide.includes(PRIVACY), true, 'the guide repeats the words the section shows')
  assert.equal(/Xephyr[^\n]*1280x720/.test(guide), false, 'a 1280x720 source costs about 7% of a core per panel')
  assert.equal(guide.includes('Never mount the host'), true)
  assert.equal(guide.includes('Voice, screen & video'), true)
  /* Stage D, D1, and review 2, item 2: Xephyr stores its title as bytes that
     came out as "ROS Â· agent" in the list, the caption and the saved title,
     and one title for every agent made the re-pick after a restart offer the
     wrong window. Plain titles, one display number and title per agent. */
  const recipe = guide.slice(guide.indexOf('### A small display for a container'))
  const displays = [...recipe.matchAll(/Xephyr :(\d+) -screen 854x480 -title "([^"]+)"/g)]
  assert.equal(displays.length >= 2, true, 'the recipe shows a second agent')
  assert.equal(new Set(displays.map(match => match[1])).size, displays.length, 'each agent its own display number')
  assert.equal(new Set(displays.map(match => match[2])).size, displays.length, 'each agent its own title')
  assert.equal(displays.every(match => /^[A-Za-z0-9 -]+$/.test(match[2])), true, 'titles in plain letters, numbers, spaces and dashes')
  assert.equal(recipe.includes('Give each agent its own display number and title.'), true)
  assert.equal(recipe.includes('·'), false, 'no title the list would garble')
  // Review 2, item 9: how to open it for an agent that is not running.
  assert.equal(guide.includes('Press the mic button on the agent’s box, running or not.'), true)
})

test('the privacy line names screenshots and the kept title (1.0.50 review video F1)', () => {
  /* Computer control's screenshot captures the whole screen and hands the
     image to the agent (shell/screen-control-adapter.cjs), so a visible panel
     is in it; and the window's title is saved until video is turned off. The
     line must not promise more than that. */
  const source = readFileSync(new URL('../../src/agent-video-controls.js', import.meta.url), 'utf8')
  const line = source.match(/<p data-video-privacy[^>]*>([^<]*)<\/p>/)?.[1] || ''
  assert.equal(line, PRIVACY)
  assert.equal(line.includes('Only you see'), false)
  assert.equal(line.includes('Nothing is recorded'), false)
  assert.equal(line.includes('take screenshots'), true)
  assert.equal(line.includes('Computer control'), true)
  assert.equal(line.includes('title is kept on this computer until you turn video off'), true)
  const sentences = line.split(/(?<=\.)\s+/)
  assert.equal(sentences.length, 3)
  assert.equal(sentences.every(sentence => sentence.split(/\s+/).length <= 25), true, 'each sentence at most 25 words')
  const adapter = readFileSync(new URL('../../shell/screen-control-adapter.cjs', import.meta.url), 'utf8')
  assert.equal(/getSources\(\{ types: \['screen'\]/.test(adapter), true, 'a screenshot is still the whole screen')
})

test('the agent pop-over that holds the Video section is named for voice, screen and video (review 2, item 8)', () => {
  /* The pop-over opened from a box's mic button carries the Video section, so
     a screen reader must hear its whole name. Its label is set once, where
     Computers mounts it (src/views/computers.js). */
  const computers = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const labels = [...computers.matchAll(/agentScreenVoice\.el\.setAttribute\('aria-label', '([^']*)'\)/g)].map(match => match[1])
  assert.equal(labels.length, 1, 'the pop-over is labelled in one place')
  assert.equal(labels[0], 'Agent voice, screen and video controls')
})
