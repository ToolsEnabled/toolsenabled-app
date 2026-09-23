import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/* This is a value-level component test, not a scan of components.js.  The
   small document below supplies only the browser contracts buildChat uses;
   assertions are made against the tree returned by buildChat. */
class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(value) { return this.values().includes(value) }
  add(...values) { this.node.className = [...new Set([...this.values(), ...values])].join(' ') }
  remove(...values) { this.node.className = this.values().filter(value => !values.includes(value)).join(' ') }
  toggle(value, force) { const on = force === undefined ? !this.contains(value) : force; on ? this.add(value) : this.remove(value); return on }
}

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.hidden = false
    this.open = false; this.value = ''; this.textContent = ''; this.style = {}
    this.dataset = new Proxy({}, { set: (target, key, value) => {
      target[key] = String(value)
      this.attributes.set(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value))
      return true
    } })
    this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.classList = new Classes(this)
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? Object.assign(new NodeDouble('span'), { textContent: node }) : node) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) { const index = this.children.indexOf(at); node.parentNode = this; this.children.splice(index < 0 ? this.children.length : index, 0, node); return node }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null }
  replaceWith(node) { if (!this.parentNode) return; const index = this.parentNode.children.indexOf(this); this.parentNode.children[index] = node; node.parentNode = this.parentNode; this.parentNode = null }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value) }
  getAttribute(key) { return key === 'class' ? this.className : this.attributes.get(key) ?? null }
  removeAttribute(key) { this.attributes.delete(key) }
  addEventListener(key, fn) { const listeners = this.listeners.get(key) || []; listeners.push(fn); this.listeners.set(key, listeners) }
  removeEventListener() {}
  focus() { document.activeElement = this }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false }
  closest(selector) { for (let at = this; at; at = at.parentNode) if (at.matches?.(selector)) return at; return null }
  matches(selector) {
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0]
    if (tag && this.tagName !== tag.toUpperCase()) return false
    for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false
    for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (match[1] === 'open') { if (!this.open) return false; continue }
      if (!this.attributes.has(match[1])) return false
      if (match[2] !== undefined && this.attributes.get(match[1]) !== match[2]) return false
    }
    return true
  }
  querySelectorAll(selector) { const wanted = selector.trim().split(/\s+/).at(-1); const found = []; const walk = node => { for (const child of node.children) { if (child.matches(wanted)) found.push(child); walk(child) } }; walk(this); return found }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  scrollIntoView() {}
  set innerHTML(html) { this.children = []; parse(html, this) }
}

function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { const words = token.trim(); if (words) stack.at(-1).textContent += words; continue }
    if (/^<!/.test(token)) continue
    const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue
    const node = new NodeDouble(tag)
    for (const attribute of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (attribute[1] !== tag) node.setAttribute(attribute[1], attribute[2] ?? '')
    if (/\shidden(?:\s|>|\/)/.test(token)) node.hidden = true
    stack.at(-1).appendChild(node)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(tag)) stack.push(node)
  }
}

const documentRoot = new NodeDouble('html')
globalThis.document = {
  documentElement: documentRoot, body: new NodeDouble('body'), activeElement: null, visibilityState: 'hidden',
  fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  createElement(tag) { if (tag !== 'template') return new NodeDouble(tag); const content = { firstElementChild: null }; return { content, set innerHTML(value) { const host = new NodeDouble('host'); parse(value, host); content.firstElementChild = host.children[0] } } },
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = fn => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const componentUrl = process.env.CHAT_FOLD_COMPONENTS
  ? pathToFileURL(process.env.CHAT_FOLD_COMPONENTS).href
  : new URL('../../src/components.js', import.meta.url).href
const { buildChat } = await import(`${componentUrl}?fold-cluster-test=${Date.now()}`)
/* The words module always comes from the real source tree, even when the
   component under test is swapped via CHAT_FOLD_COMPONENTS: it supplies the
   EXPECTED values, so a component whose composed line drifts from the owner
   module reads red here instead of the fixture drifting with it. */
const { actionRowWords, actionRunLine } = await import(new URL('../../src/fleet-tree-copy.js', import.meta.url).href)

/* The row's display words are DERIVED, never re-typed. Real rows reach the
   component through actionRowWords() (src/agent-session.js, src/views/
   computers.js), whose vocabulary is ACTION_STATE_WORDS / ACTION_TOOL_WORDS in
   src/fleet-tree-copy.js -- lowercase 'finished' / 'refused', tool 'Bash' →
   'Command'. A fixture that hand-writes 'Finished' feeds the component a value
   with no real producer. stateKey rides alongside because it is the raw key
   the component stamps into data-action-state, not a display word. */
const action = (index, stateKey = 'done') => ({
  who: 'action', id: `call-${index}`,
  ...actionRowWords({ tool: 'Bash', detail: `step ${index}`, state: stateKey }),
  stateKey, body: `output ${index}`,
})

test('18 consecutive tool calls settle behind one transcript line when prose lands', () => {
  const chat = buildChat({
    title: 'Worker', seed: 0, composerReason: 'Read only.',
    history: [...Array.from({ length: 18 }, (_, index) => action(index)), { who: 'agent', text: 'Work complete.' }],
  })
  const log = chat.querySelector('.chat-log')
  const runs = log.querySelectorAll('.chat-action-run')
  assert.equal(runs.length, 1, 'consecutive calls became multiple transcript clusters')
  assert.equal(runs[0].open, false, 'prose did not settle the live tool run to its one-line summary')
  assert.equal(runs[0].querySelectorAll('.chat-action').length, 18, 'folding discarded calls instead of retaining them behind the line')
  assert.match(runs[0].querySelector('.chat-action-detail').textContent, /18 tool calls/)
})

test('a refused call is never silent in a settled cluster', () => {
  const chat = buildChat({
    title: 'Worker', seed: 0, composerReason: 'Read only.',
    history: [...Array.from({ length: 17 }, (_, index) => action(index)), action(17, 'refused'), { who: 'agent', text: 'I could not finish every step.' }],
  })
  const run = chat.querySelector('.chat-action-run')
  assert.equal(run.open, false, 'the refusal scenario did not exercise the folded state')
  /* The whole sentence is the owner module's, not fragments re-typed here:
     actionRunLine() composes the refused-count-then-press-to-read line and its
     wording is under live revision (it was already rewritten once under the
     plain-language gate). Non-empty and distinct first: a derived sentence
     that collapsed to '', or to the clean-run line, would satisfy an equality
     while hiding exactly the refusal this test exists to keep loud. */
  const foldedLine = actionRunLine(18, { refused: 1 })
  assert.ok(foldedLine && foldedLine !== actionRunLine(18),
    `actionRunLine no longer distinguishes a run holding a refusal: ${JSON.stringify(foldedLine)}`)
  assert.equal(run.querySelector('.chat-action-detail').textContent, foldedLine,
    'the folded line is not actionRunLine(18, { refused: 1 }) — it hid the refusal or dropped the route to its retained row')
  assert.equal(run.querySelectorAll('[data-action-state="refused"]').length, 1, 'the refused row was discarded from the cluster')
})

/* THE LIVE PATH, NOT HISTORY REPLAY. The two tests above seed a restored
   `history` array, which lands every row through addMsg's own settle call
   (see components.js, the 'AN ACTION IS PART OF THE HISTORY TOO' comment) --
   so they prove folding works once a conversation is reopened, never that it
   fires the moment a live reply actually arrives. src/agent-session.js drives
   a real turn through addAction() and openStream()/push()/close() instead,
   in that order -- openStream() opens the reply's bubble BEFORE the turn's
   first tool call can arrive ("Opened here, before the turn's own words can
   arrive, so the panel shows a working bubble the instant a person presses
   Start"). These two tests drive the SAME public sequence. */
test('a completed live tool burst folds before reply text arrives', () => {
  const chat = buildChat({ title: 'Worker', seed: 0, composerReason: 'Read only.' })
  const log = chat.querySelector('.chat-log')
  const stream = chat.openStream()
  for (let index = 0; index < 9; index += 1) chat.addAction(action(index))
  const runWhileWorking = log.querySelector('.chat-action-run')
  assert.equal(runWhileWorking.open, false,
    'nine completed calls stayed expanded until prose arrived instead of folding at the first honest boundary')

  stream.push('Done. Tests are green.')
  stream.close()

  const runs = log.querySelectorAll('.chat-action-run')
  assert.equal(runs.length, 1, 'consecutive calls became multiple transcript clusters')
  assert.equal(runs[0].open, false,
    'the live reply streamed in over openStream() without folding the tool run that finished before it -- ' +
    'the log keeps auto-scrolling to a wall of open rows below the answer that already arrived above them')
  assert.equal(runs[0].querySelectorAll('.chat-action').length, 9, 'folding discarded calls instead of retaining them behind the line')
  assert.match(runs[0].querySelector('.chat-action-detail').textContent, /9 tool calls/)
})

test('a multi-call burst stays open while any tool is still working, then folds on its last result', () => {
  const chat = buildChat({ title: 'Worker', seed: 0, composerReason: 'Read only.' })
  const log = chat.querySelector('.chat-log')
  chat.addAction(action(0, 'working'))
  chat.addAction(action(1, 'working'))
  const run = log.querySelector('.chat-action-run')
  assert.equal(run.open, true, 'live calls were hidden before their results arrived')

  chat.addAction(action(0, 'done'))
  assert.equal(run.open, true, 'one result folded a run whose other call was still working')
  chat.addAction(action(1, 'done'))
  assert.equal(run.open, false, 'the last result did not collapse the completed burst')
})

test('a turn that ends in pure tool calls, with no reply text at all, still folds on close', () => {
  const chat = buildChat({ title: 'Worker', seed: 0, composerReason: 'Read only.' })
  const log = chat.querySelector('.chat-log')
  const stream = chat.openStream()
  for (let index = 0; index < 3; index += 1) chat.addAction(action(index))
  stream.close()

  const run = log.querySelector('.chat-action-run')
  assert.equal(run.open, false,
    'a silent turn (no push(), close() only) left its run open -- the NEXT turn\'s first tool call would be the ' +
    'only thing left to fold it, merging two unrelated turns of work behind one count')
  assert.match(run.querySelector('.chat-action-detail').textContent, /3 tool calls/)
})

/* ---------------------------------------------------------------
   A RUN OF ONE IS NOT A RUN -- owner, 2026-09-03: "Tools need to condense
   more." Every test above proves an 18-, 9- or 3-call burst settles behind
   ONE line; none of them says what happens at the other end of that range,
   where a turn ran exactly one tool. Before this, that solo call still paid
   for the SAME wrapper an 18-call burst pays for: its own "1 tool call"
   line, openable onto a SECOND collapsed line -- the row itself -- openable
   a second time onto the output. Two boxes and two presses for one fact,
   both wearing the identical .chat-action card chrome, is a sprawl on the
   smallest possible run. is-solo (src/components.js refreshRunLine,
   src/styles.css) is the fix: a run holding exactly one call hides its own
   head and box, so the row IS the line -- one press to its output, not two.
   --------------------------------------------------------------- */

test('a lone tool call reads as its own row, not a redundant "1 tool call" wrapper', () => {
  const chat = buildChat({
    title: 'Worker', seed: 0, composerReason: 'Read only.',
    history: [action(0), { who: 'agent', text: 'Done.' }],
  })
  const log = chat.querySelector('.chat-log')
  const runs = log.querySelectorAll('.chat-action-run')
  assert.equal(runs.length, 1, 'a single call did not get the usual run wrapper at all')
  const run = runs[0]
  assert.ok(run.classList.contains('is-solo'),
    'a run holding exactly one call never picked up is-solo, so it still wears the redundant "1 tool call" fold')
  assert.equal(run.open, true,
    'a solo run settled shut -- its own head is hidden by is-solo, so a closed solo run hides the one row ' +
    'describing this turn with no way left to reach it')
  const rows = run.querySelectorAll('.chat-action')
  assert.equal(rows.length, 1, 'folding discarded the call instead of retaining it behind is-solo')
  assert.equal(rows[0].querySelector('.chat-action-tool').textContent, 'Command', 'the row itself no longer says which tool ran')
  assert.match(rows[0].querySelector('.chat-action-detail').textContent, /step 0/, 'the row itself no longer says what it was asked to do')
})

test('a lone tool call in a LIVE turn is not wrapped in a redundant fold either', () => {
  /* THE LIVE PATH, NOT HISTORY REPLAY -- the same reason the two tests further
     up this file exist: seeding a restored `history` array lands every row
     through addMsg's own settle call before a person ever sees the log, which
     proves nothing about the moment a single call actually arrives live, and,
     afterward, the moment the reply that follows it does. */
  const chat = buildChat({ title: 'Worker', seed: 0, composerReason: 'Read only.' })
  const log = chat.querySelector('.chat-log')
  const stream = chat.openStream()
  chat.addAction(action(0))
  const liveRun = log.querySelector('.chat-action-run')
  assert.ok(liveRun.classList.contains('is-solo'), 'a lone live call never picked up is-solo, even before any reply arrives')
  assert.equal(liveRun.open, true, 'a solo run must stay open from the moment it exists -- it has no head left to reopen it with')

  stream.push('Done.')
  stream.close()

  const runs = log.querySelectorAll('.chat-action-run')
  assert.equal(runs.length, 1, 'a single call became more than one transcript cluster')
  assert.ok(runs[0].classList.contains('is-solo'), 'the reply landing knocked is-solo off a run that still holds only one call')
  assert.equal(runs[0].open, true, 'settling on the reply closed a solo run, hiding the only row describing what the turn did')
  assert.equal(runs[0].querySelectorAll('.chat-action').length, 1, 'folding discarded the call')
})

test('a second call arriving before the reply turns a solo run back into an ordinary fold', () => {
  /* THE ONE CASE THE SOLO FIX MUST NOT TOUCH. If is-solo ever stuck once set,
     a burst that happened to start with one call before more arrived would
     wrongly keep hiding its own head forever. */
  const chat = buildChat({ title: 'Worker', seed: 0, composerReason: 'Read only.' })
  const log = chat.querySelector('.chat-log')
  const stream = chat.openStream()
  chat.addAction(action(0))
  chat.addAction(action(1))
  const run = log.querySelector('.chat-action-run')
  assert.equal(run.classList.contains('is-solo'), false,
    'a run holding two calls is still marked is-solo, so its own folded sentence stays hidden')
  assert.match(run.querySelector('.chat-action-detail').textContent, /2 tool calls/, 'a two-call run lost its own folded sentence')

  stream.push('Done.')
  stream.close()
  assert.equal(run.open, false, 'a genuine two-call run no longer folds on reply -- the solo fix must not have disabled folding generally')
})

test("is-solo hides the run's own box and head in styles.css, not only in the DOM", () => {
  /* A class the JS sets with no matching rule is a silent no-op: the DOM
     assertions above would stay green while the transcript kept drawing the
     exact double box this class exists to remove. Pinned the same way
     chat-dense-card-css.test.mjs pins its own six selectors. */
  const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /\.chat-action-run\.is-solo\s*\{[^}]*\bborder:\s*0\b/,
    "is-solo no longer strips the run's own border, so a solo call still draws inside a doubled box")
  assert.match(styles, /\.chat-action-run\.is-solo\s*>\s*\.chat-action-head\s*\{\s*display:\s*none;?\s*\}/,
    'is-solo no longer hides the run\'s own head, so a solo call still shows a redundant "1 tool call" line')
})
