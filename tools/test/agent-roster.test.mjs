import assert from 'node:assert/strict'
import test from 'node:test'

class FakeClassList {
  constructor(node) { this.node = node }
  add(...names) { this.#set(new Set([...this.#names(), ...names])) }
  remove(...names) { this.#set(new Set(this.#names().filter(name => !names.includes(name)))) }
  contains(name) { return this.#names().includes(name) }
  #names() { return this.node.className.split(/\s+/).filter(Boolean) }
  #set(names) { this.node.className = [...names].join(' ') }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this.classList = new FakeClassList(this)
    this.listeners = new Map()
    this.style = { values: new Map(), setProperty: (name, value) => this.style.values.set(name, value) }
    this._text = ''
  }
  set textContent(value) { this._text = value == null ? '' : String(value); this.children = [] }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text }
  setAttribute(name, value) {
    const stringValue = String(value)
    this.attributes.set(name, stringValue)
    if (name === 'class') this.className = stringValue
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = stringValue
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  append(...children) { for (const child of children) this.appendChild(child) }
  appendChild(child) { this.children.push(child); return child }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  click() { this.listeners.get('click')?.() }
  find(className) {
    if (this.classList.contains(className)) return this
    for (const child of this.children) {
      const found = child.find(className)
      if (found) return found
    }
    return null
  }
}

class FakeDocument {
  createElement(tagName) {
    if (tagName !== 'template') return new FakeElement(tagName)
    const template = { content: { firstElementChild: null } }
    Object.defineProperty(template, 'innerHTML', {
      set(html) {
        const match = html.match(/^\s*<([\w-]+)([^>]*)>/)
        if (!match) throw new Error(`unsupported test markup: ${html}`)
        const node = new FakeElement(match[1])
        for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '')
        template.content.firstElementChild = node
      },
    })
    return template
  }
  createElementNS(_namespace, tagName) { return new FakeElement(tagName) }
}

globalThis.document = new FakeDocument()

const { activityOf, buildAgentRoster, runtimeOf } = await import('../../src/agent-roster.js')

test('activityOf follows the feed order and cleans caller-provided rows', () => {
  assert.deepEqual(
    activityOf({ context: ['older', '  just\nfinished  ', ' now\tworking '] }),
    { current: 'now working', previous: 'just finished' },
    'the last two feed rows should become clean current and previous activity',
  )
  assert.deepEqual(
    activityOf({ context: 'could-not-read' }),
    { current: '', previous: '' },
    'an unreadable activity payload should remain unknown rather than become activity text',
  )
})

test('runtimeOf distinguishes a moving clock, a stopped clock, and an unreadable epoch', () => {
  assert.deepEqual(
    runtimeOf({ bornAt: 1_000 }, 4_500),
    { elapsedMs: 3_500, running: true },
    'a live agent should use the caller observation time and remain running',
  )
  assert.deepEqual(
    runtimeOf({ bornAt: 1_000, stoppedAt: 3_250 }, 9_000),
    { elapsedMs: 2_250, running: false },
    'a stopped agent should use its stop epoch and remain stopped',
  )
  assert.equal(
    runtimeOf({ bornAt: 'could-not-read' }, 9_000),
    null,
    'a could-not-read birth epoch must stay unknown instead of becoming a definite runtime',
  )
  assert.deepEqual(
    runtimeOf({ bornAt: 10_000 }, 9_000),
    { elapsedMs: 0, running: true },
    'a birth epoch later than the observation time must clamp elapsed time to zero',
  )
})

test('example durations are labelled, stationary and never announced as real running sessions', () => {
  const agent = { id: 'sample', name: 'Sample agent', role: 'manager', bornAt: Date.now() - 65_000,
    context: ['Configured to use a sample provider'] }
  const roster = buildAgentRoster({ agents: [agent], example: true })
  const card = roster.el.children[0]
  const duration = card.find('ar-runtime-value').textContent
  const dial = card.find('ar-dial-sweep').getAttribute('stroke-dasharray')
  roster.update(Date.now() + 3_600_000)
  assert.equal(card.find('ar-runtime-value').textContent, duration)
  assert.equal(card.find('ar-runtime-note').textContent, 'example time')
  assert.equal(card.dataset.runtimeState, 'example')
  assert.equal(card.find('ar-dial').dataset.running, 'false')
  assert.equal(card.find('ar-dial-sweep').getAttribute('stroke-dasharray'), dial)
  assert.match(card.getAttribute('aria-label'), /example agent, no real session, example duration/)
  assert.doesNotMatch(card.getAttribute('aria-label'), /running for|ran for/)
})

test('an example with no epoch keeps the unknown duration instead of inventing a runtime', () => {
  const roster = buildAgentRoster({ agents: [{ id: 'sample', name: 'Sample', role: 'manager' }], example: true })
  const card = roster.el.children[0]
  assert.equal(card.find('ar-runtime-value').classList.contains('is-absent'), true)
  assert.match(card.getAttribute('aria-label'), /example agent, no real session/)
  assert.doesNotMatch(card.getAttribute('aria-label'), /example duration|running for|ran for/)
  assert.equal(card.find('ar-dial').dataset.running, 'false')
})

test('real roster durations still advance and report the producer stop epoch', () => {
  const agent = { id: 'real', name: 'Real agent', role: 'manager', bornAt: 1_000 }
  const roster = buildAgentRoster({ agents: [agent], example: false })
  const card = roster.el.children[0]
  roster.update(61_000)
  const first = card.find('ar-runtime-value').textContent
  roster.update(121_000)
  assert.notEqual(card.find('ar-runtime-value').textContent, first)
  assert.equal(card.find('ar-runtime-note').textContent, 'running')
  assert.equal(card.find('ar-dial').dataset.running, 'true')
  assert.match(card.getAttribute('aria-label'), /running for/)
  agent.stoppedAt = 91_000
  roster.update(181_000)
  const stopped = card.find('ar-runtime-value').textContent
  roster.update(241_000)
  assert.equal(card.find('ar-runtime-value').textContent, stopped)
  assert.equal(card.find('ar-runtime-note').textContent, 'stopped')
  assert.equal(card.find('ar-dial').dataset.running, 'false')
  assert.match(card.getAttribute('aria-label'), /ran for/)
})

test('buildAgentRoster exposes useful card state, activation, and resilient user-facing status', () => {
  const selected = []
  const agents = [
    { id: 'active-id', name: 'Active Ada', role: 'manager', bornAt: 1_000, context: ['previous work', 'current work'] },
    { id: 'unknown-id', name: 'Unknown Uma', role: 'not-a-role', context: [] },
  ]
  const roster = buildAgentRoster({ agents, selectedId: 'active-id', onSelect: id => selected.push(id) })
  roster.update(61_000)

  assert.equal(roster.count, 2, 'the roster count should match the caller-provided agents')
  const active = roster.el.children[0]
  const unknown = roster.el.children[1]
  assert.equal(active.tagName, 'BUTTON', 'an agent card should be a keyboard-native button')
  assert.equal(active.classList.contains('is-selected'), true, 'the caller-selected agent should be visibly selected')
  assert.match(active.getAttribute('aria-label'), /Active Ada.*manager.*running for.*current work/i,
    'the accessible card name should identify the agent, role, moving runtime, and current work')
  assert.equal(active.find('ar-status-current').textContent, 'current work',
    'the visible status should use the feed current row')
  assert.equal(active.find('ar-status-previous').textContent, 'previous work',
    'the visible status should retain the immediately previous row')
  active.click()
  assert.deepEqual(selected, ['active-id'], 'activating a card should report that agent id to the caller')

  assert.equal(unknown.find('ar-runtime-value').classList.contains('is-absent'), true,
    'an agent whose runtime could not be read should be marked as lacking runtime data')
  assert.match(unknown.getAttribute('aria-label'), /Unknown Uma.*(?:unknown|unavailable|not available|no runtime)/i,
    'the accessible card name should communicate that an unreadable runtime is unknown')
  assert.doesNotMatch(unknown.getAttribute('aria-label'), /(?:running|ran) for/i,
    'an unreadable runtime must not be announced as a definite running or stopped duration')
})

test('a card names the sign-in its agent is spending, and a card with no running session names none', () => {
  /* THE DEFECT THIS CLOSES. A card said what its agent was, what role it had,
     how long it had run and what it was doing, and never whose account was
     paying for it -- so on a computer with six sign-ins, six agents all on one
     spent account drew exactly like six agents spread across six. */
  const agents = [
    { id: 'running-id', name: 'Running Rita', role: 'manager', bornAt: 1_000, context: ['working'] },
    { id: 'idle-id', name: 'Idle Ivan', role: 'manager', bornAt: 1_000, context: [] },
  ]
  const roster = buildAgentRoster({
    agents,
    accounts: new Map([['running-id', { account: 'work', provider: 'claude' }]]),
  })
  roster.update(61_000)

  const running = roster.el.children[0]
  const idle = roster.el.children[1]
  assert.equal(running.find('ar-account-name').textContent, 'work',
    'the account the running agent is spending is not on its card')
  /* The same fact reaches a screen reader, or the card says two different
     things to two people. */
  assert.match(running.getAttribute('aria-label'), /Running Rita.*on account work/i)

  /* NOTHING, NOT "UNKNOWN". Most agents are not running, and a computer with
     one sign-in has no account question to answer -- a row reading "unknown" on
     every card would turn "there was nothing to choose" into "nobody knows what
     it chose". */
  assert.equal(idle.find('ar-account'), null, 'an agent with no running session drew an account row anyway')
  assert.doesNotMatch(idle.getAttribute('aria-label'), /account/i)
})

test('the account join is by declared agent and nothing else, and rubbish in the table draws nothing', () => {
  const agents = [{ id: 'a1', name: 'Agent One', role: 'manager', bornAt: 1_000, context: [] }]
  const drawn = (accounts) => {
    const roster = buildAgentRoster({ agents, accounts })
    roster.update(61_000)
    const row = roster.el.children[0].find('ar-account-name')
    return row ? row.textContent : null
  }
  /* A plain table is accepted beside a Map: the shape is obvious enough to
     write either way, and a card that silently drew nothing over a container
     type would look exactly like an agent with no session. */
  assert.equal(drawn({ a1: { account: 'work' } }), 'work')
  assert.equal(drawn({ a1: 'work' }), 'work', 'a bare name is a name')
  /* Another agent's account is not this agent's. */
  assert.equal(drawn(new Map([['a2', { account: 'work' }]])), null)
  for (const rubbish of [null, undefined, new Map([['a1', null]]), { a1: {} }, { a1: { account: '' } }, { a1: 42 }]) {
    assert.equal(drawn(rubbish), null, `a malformed entry drew a row: ${JSON.stringify(rubbish)}`)
  }
})

test('a card says when the sign-in behind it has run out, and says nothing when nobody looked', () => {
  /* THE DEFECT THIS CLOSES. The name alone answers "whose allowance is this
     spending" and not "is any of it left", which is the question a person opens
     this page with when the work has slowed down. The shell has worked it out
     on every read of this page since 2026-09-03 -- the engine's handoverReport()
     -- and the answer was dropped before it reached a card, so the one screen
     naming the accounts was the one screen that could not say which were spent. */
  const agents = [
    { id: 'spent-id', name: 'Spent Sam', role: 'manager', bornAt: 1_000, context: ['working'] },
    { id: 'stuck-id', name: 'Stuck Stan', role: 'manager', bornAt: 1_000, context: ['working'] },
    { id: 'fine-id', name: 'Fine Fiona', role: 'manager', bornAt: 1_000, context: ['working'] },
    { id: 'quiet-id', name: 'Quiet Quinn', role: 'manager', bornAt: 1_000, context: ['working'] },
  ]
  const roster = buildAgentRoster({
    agents,
    accounts: new Map([
      /* Judged, and there is somewhere for the next one to start. */
      ['spent-id', { account: 'work', provider: 'claude', spent: true, to: 'spare', why: 'HANDOVER_MOVED' }],
      /* Judged, and there is nowhere: the worst case, and the one a report that
         only marked movable sessions would draw as healthy. */
      ['stuck-id', { account: 'work', provider: 'claude', spent: true, to: null, why: 'HANDOVER_HELD_NO_TARGET' }],
      /* Judged and under its limits. */
      ['fine-id', { account: 'spare', provider: 'claude' }],
      /* Not judged at all -- nobody read this account. */
      ['quiet-id', { account: 'unread', provider: 'claude', spent: false, why: 'HANDOVER_UNKNOWN_ACCOUNT_NOT_READ' }],
    ]),
  })
  roster.update(61_000)
  const [spent, stuck, fine, quiet] = roster.el.children

  assert.equal(spent.find('ar-account-spent').textContent, 'at its limit',
    'a card on an account past a limit did not say so')
  assert.equal(spent.find('ar-account-name').textContent, 'work', 'the account name was lost with the mark')
  /* THE SAME FACT REACHES A SCREEN READER, or the card says two different
     things to two people. */
  assert.match(spent.getAttribute('aria-label'), /on account work, which has reached a limit/i)

  /* IT IS A REPORT, NOT A CONTROL. The sentence says where a NEW session would
     start and that this one is staying, because a session keeps the account it
     started on for the life of its program. */
  const sentence = spent.find('ar-account-spent').title
  assert.match(sentence, /would start on spare/i, 'the report did not say where the work would go next')
  assert.match(sentence, /keeps the account it started on/i,
    'a mark that reads like a control did not say the session is staying put')
  assert.equal(spent.find('ar-account-spent').tagName, 'SPAN', 'the mark is a control somebody can press')

  /* NOWHERE TO GO IS ITS OWN ANSWER, and the next step it implies -- raise a
     limit, or wait for a window to reset -- is not the same one. */
  assert.equal(stuck.find('ar-account-spent').textContent, 'at its limit')
  assert.match(stuck.find('ar-account-spent').title, /no other account is free/i)
  assert.doesNotMatch(stuck.find('ar-account-spent').title, /would start on/i)

  /* MEASURED AND FINE SAYS NOTHING BEYOND THE NAME. */
  assert.equal(fine.find('ar-account-name').textContent, 'spare')
  assert.equal(fine.find('ar-account-spent'), null, 'an account under its limits was marked as spent')
  assert.doesNotMatch(fine.getAttribute('aria-label'), /limit/i)

  /* AND NEITHER DOES ONE NOBODY LOOKED AT. "The check has not run" is not "this
     account is fine" and it is not "this account is spent"; marking it as
     either is the merge the engine keeps a third list to prevent. */
  assert.equal(quiet.find('ar-account-name').textContent, 'unread', 'the account nobody read lost its name too')
  assert.equal(quiet.find('ar-account-spent'), null, 'an account nobody read was reported as spent')
  assert.doesNotMatch(quiet.getAttribute('aria-label'), /limit/i)
})

test('same-role cards wear their own agent accents and each dial follows its card', async () => {
  const { roleColorCss } = await import('../../src/role-colors.js')
  const agents = [
    { id: 'node-9-dbacd1bc', name: 'Worker', role: 'worker', bornAt: 1_000 },
    { id: 'node-10-b9c19a2d', name: 'Worker', role: 'worker', bornAt: 1_000 },
  ]
  const roster = buildAgentRoster({ agents })
  const [first, second] = roster.el.children
  assert.equal(first.style.values.get('--rc'), roleColorCss('worker', 'accent', agents[0].id))
  assert.equal(second.style.values.get('--rc'), roleColorCss('worker', 'accent', agents[1].id))
  assert.notEqual(first.style.values.get('--rc'), second.style.values.get('--rc'), 'two Workers do not share one accent')
  assert.equal(first.find('ar-dial-sweep').style.stroke, 'var(--rc)', 'the dial uses its own card accent, not the shared role color')
})
