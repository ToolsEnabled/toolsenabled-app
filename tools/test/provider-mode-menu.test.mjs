import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderModeMenu } from '../../src/provider-mode-menu.js'
import { unavailableReason } from '../../src/agent-availability-copy.js'
/* The menu says its refusal on its own, so the shared fragment table's entry
   has to arrive as a whole sentence. Derived from the SAME table the product
   reads, so this still pins the copy rather than a literal. */
const saidFor = code => {
  const reason = unavailableReason(code)
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1)
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`
}
const snapshot = (extra = {}) => ({ sessionId: 'session-a', provider: 'advertised-provider', supported: true, currentModeId: 'review-v2', availableModes: [{ id: 'review-v2', name: 'Review changes' }, { id: 'execute-v3', name: 'Execute changes', description: 'Provider description' }], pending: false, ...extra })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(bridge, extra = {}) {
  const messages = []
  const menu = createProviderModeMenu({ sessionId: 'session-a', bridge, ...extra })
  const ctx = { say: message => messages.push(message), show: rows => { assert.equal(typeof rows, 'function') } }
  return { menu, ctx, messages, pick: id => menu.rows().find(row => row.id === 'provider-mode-' + id) }
}
test('runtime names only; requested mode becomes current only after matching applied ACK', async () => {
  const wait = deferred(), calls = []
  const f = fixture({ modes: async () => snapshot(), setMode: request => { calls.push(request); return wait.promise } })
  await f.menu.open(f.ctx)
  assert.equal(f.pick('execute-v3').label, 'Execute changes')
  const pending = f.pick('execute-v3').run(f.ctx)
  assert.equal(f.pick('review-v2').current, true)
  assert.equal(f.pick('execute-v3').enabled, false)
  await f.pick('execute-v3').run(f.ctx)
  assert.deepEqual(calls, [{ sessionId: 'session-a', modeId: 'execute-v3' }])
  wait.resolve(snapshot({ currentModeId: 'execute-v3', applied: true }))
  await pending
  assert.equal(f.pick('execute-v3').current, true)
  assert.match(f.messages.at(-1), /applied/)
})
for (const receipt of [snapshot({ currentModeId: 'execute-v3' }), snapshot({ currentModeId: 'execute-v3', applied: true, sessionId: 'replacement' }), snapshot({ currentModeId: 'execute-v3', applied: true, pending: true })]) {
  test('unconfirmed result retains accepted mode and requires a fresh read: ' + JSON.stringify(receipt), async () => {
    const f = fixture({ modes: async () => snapshot(), setMode: async () => receipt })
    await f.menu.open(f.ctx); await f.pick('execute-v3').run(f.ctx)
    assert.equal(f.pick('review-v2').current, true)
    assert.equal(f.pick('execute-v3').enabled, false)
    assert.match(f.messages.at(-1), /did not confirm/)
  })
}
for (const code of ['AGENT_MODE_UNSUPPORTED', 'AGENT_MODE_UNAVAILABLE', 'AGENT_TURN_ACTIVE', 'AGENT_MODE_SELECTION_UNCONFIRMED']) {
  test('refusal preserves accepted value: ' + code, async () => {
    const f = fixture({ modes: async () => snapshot(), setMode: async () => { throw new Error(code) } })
    await f.menu.open(f.ctx); await f.pick('execute-v3').run(f.ctx)
    assert.equal(f.pick('review-v2').current, true)
    assert.equal(f.messages.at(-1), ['AGENT_MODE_UNAVAILABLE', 'AGENT_MODE_SELECTION_UNCONFIRMED'].includes(code) ? saidFor(code) : code)
  })
}
for (const phase of ['read', 'change']) {
  test('late ' + phase + ' cannot publish into a replaced session', async () => {
    let current = true; const wait = deferred()
    const f = fixture({ modes: () => phase === 'read' ? wait.promise : Promise.resolve(snapshot()), setMode: () => wait.promise }, { isCurrent: () => current })
    const read = f.menu.open(f.ctx)
    let pending = read
    if (phase === 'change') { await read; pending = f.pick('execute-v3').run(f.ctx) }
    current = false; const before = f.messages.slice()
    wait.resolve(snapshot({ currentModeId: 'execute-v3', applied: true })); await pending
    assert.deepEqual(f.messages, before)
    assert.equal(f.pick('execute-v3')?.current || false, false)
  })
}
test('unavailable, unsupported and no-session states remain explicit', async () => {
  for (const [bridge,extra,pattern] of [[{}, {}, /unavailable/], [{ modes: async () => snapshot({ supported: false, availableModes: [], currentModeId: null }) }, {}, /does not support/], [{}, { sessionId: null }, /Start a session/]]) {
    const f = fixture(bridge, extra); await f.menu.open(f.ctx); assert.match(f.messages.at(-1), pattern)
  }
})
test('busy guard rechecked on old row; no composer operation is needed', async () => {
  let busy = false, sends = 0
  const f = fixture({ modes: async () => snapshot(), setMode: async () => { sends++ } }, { blockingReason: () => busy ? 'Recovering' : '' })
  await f.menu.open(f.ctx); const row = f.pick('execute-v3'); busy = true; await row.run(f.ctx)
  assert.equal(sends, 0); assert.equal(f.messages.at(-1), 'Recovering')
})


test('unknown current mode keeps advertised choices; only a matching applied ACK selects one', async () => {
  let response = snapshot({ currentModeId: null, applied: true })
  const f = fixture({ modes: async () => snapshot({ currentModeId: null }), setMode: async () => response })
  await f.menu.open(f.ctx)
  assert.equal(f.pick('execute-v3').enabled, true)
  assert.equal(f.pick('review-v2').current, false)
  await f.pick('execute-v3').run(f.ctx)
  assert.equal(f.pick('execute-v3').current, false, 'null applied receipt cannot confirm requested ID')
  assert.match(f.messages.at(-1), /did not confirm/)
  await f.menu.rows().find(row => row.id === 'provider-mode-refresh').run(f.ctx)
  response = snapshot({ currentModeId: 'execute-v3', applied: true })
  await f.pick('execute-v3').run(f.ctx)
  assert.equal(f.pick('execute-v3').current, true)
})

const flushMode = () => new Promise(resolve => setTimeout(resolve, 0))
test('matching mode event refreshes authority; wrong session and event payload never select a mode', async () => {
  let listener, reads = 0, off = 0
  const f = fixture({ modes: async () => { reads++; return snapshot() }, setMode: async () => {} }, {
    subscribe: callback => { listener = callback; return () => { off++ } },
  })
  await f.menu.open(f.ctx)
  listener({ sessionId: 'other', event: { type: 'session_mode_changed' } })
  listener({ sessionId: 'session-a', event: { type: 'turn_completed' } })
  await flushMode(); assert.equal(reads, 1)
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed', currentModeId: 'execute-v3' } })
  await flushMode()
  assert.equal(reads, 2); assert.equal(f.pick('review-v2').current, true)
  f.menu.dispose(); f.menu.dispose(); assert.equal(off, 1)
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  await flushMode(); assert.equal(reads, 2)
})
test('event during initial read discards obsolete result and reads again', async () => {
  let listener, reads = 0; const wait = deferred()
  const f = fixture({ modes: () => ++reads === 1 ? wait.promise : Promise.resolve(snapshot({ currentModeId: 'execute-v3' })) }, {
    subscribe: callback => { listener = callback; return () => {} },
  })
  const opening = f.menu.open(f.ctx)
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  wait.resolve(snapshot()); await opening; await flushMode()
  assert.equal(reads, 2); assert.equal(f.pick('execute-v3').current, true)
  f.menu.dispose()
})
test('event during selection waits for its ACK before authoritative refresh', async () => {
  let listener, reads = 0; const wait = deferred()
  const f = fixture({ modes: async () => { reads++; return snapshot() }, setMode: () => wait.promise }, {
    subscribe: callback => { listener = callback; return () => {} },
  })
  await f.menu.open(f.ctx)
  const changing = f.pick('execute-v3').run(f.ctx)
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  await flushMode(); assert.equal(reads, 1); assert.equal(f.pick('review-v2').current, true)
  wait.resolve(snapshot({ currentModeId: 'execute-v3', applied: true }))
  await changing; await flushMode()
  assert.equal(reads, 2)
  assert.ok(f.messages.some(message => message === 'Provider mode applied: Execute changes'))
  assert.equal(f.pick('review-v2').current, true, 'authoritative refresh can supersede the earlier ACK')
  f.menu.dispose()
})
for (const phase of ['read', 'change']) test('popup disposal fences pending ' + phase + ' and unsubscribes', async () => {
  let listener, close, off = 0; const wait = deferred()
  const f = fixture({ modes: () => phase === 'read' ? wait.promise : Promise.resolve(snapshot()), setMode: () => wait.promise }, {
    subscribe: callback => { listener = callback; return () => { off++ } },
  })
  f.ctx.onClose = callback => { close = callback }
  let pending = f.menu.open(f.ctx)
  if (phase === 'change') { await pending; pending = f.pick('execute-v3').run(f.ctx) }
  close(); const before = f.messages.slice()
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  wait.resolve(snapshot({ currentModeId: 'execute-v3', applied: true })); await pending
  assert.equal(off, 1); assert.deepEqual(f.messages, before)
  assert.equal(f.pick('execute-v3')?.current || false, false)
})
test('replacement during event read cannot repaint or react to subsequent events', async () => {
  let current = true, listener, reads = 0; const wait = deferred()
  const f = fixture({ modes: () => ++reads === 1 ? Promise.resolve(snapshot()) : wait.promise }, {
    isCurrent: () => current, subscribe: callback => { listener = callback; return () => {} },
  })
  await f.menu.open(f.ctx)
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  current = false; const before = f.messages.slice()
  wait.resolve(snapshot({ currentModeId: 'execute-v3' })); await flushMode()
  listener({ sessionId: 'session-a', event: { type: 'session_mode_changed' } })
  assert.deepEqual(f.messages, before); assert.equal(reads, 2); assert.equal(f.pick('review-v2').current, true)
  f.menu.dispose()
})

for (const [code, pattern] of [
  ['CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE', /resumed session.*settings.*unavailable/i],
  ['CODEX_MODE_SETTINGS_REQUIRED', /session.*settings.*unavailable/i],
  ['PROVIDER_SESSION_LIMIT', /cannot be applied to this session/i],
]) test('advertised unavailable modes remain visible and refuse selection: ' + code, async () => {
  let changes = 0
  const f = fixture({
    modes: async () => snapshot({ supported: false, code }),
    setMode: async () => { changes++; throw new Error('must not dispatch') },
  })
  await f.menu.open(f.ctx)
  assert.deepEqual(f.menu.rows().filter(row => !['provider-mode-state', 'provider-mode-refresh'].includes(row.id)).map(row => row.label),
    ['Review changes', 'Execute changes'])
  assert.match(f.messages.at(-1), pattern)
  assert.doesNotMatch(f.messages.at(-1), /does not support|fresh session|run a turn/i)
  for (const id of ['review-v2', 'execute-v3']) {
    const row = f.pick(id)
    assert.equal(row.enabled, false)
    assert.match(row.disabledHint, pattern)
    await row.run(f.ctx)
  }
  assert.equal(changes, 0)
  assert.equal(f.pick('review-v2').current, true)
  f.menu.dispose()
})

test('fresh confirmed availability restores mode selection without inventing an applied choice', async () => {
  let supported = false, changes = 0
  const f = fixture({
    modes: async () => snapshot({ supported, code: supported ? undefined : 'CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE' }),
    setMode: async () => { changes++; return snapshot({ currentModeId: 'execute-v3', applied: true }) },
  })
  await f.menu.open(f.ctx)
  assert.equal(f.pick('execute-v3')?.enabled, false)
  supported = true
  await f.menu.rows().find(row => row.id === 'provider-mode-refresh').run(f.ctx)
  assert.equal(changes, 0)
  assert.equal(f.pick('review-v2').current, true)
  assert.equal(f.pick('execute-v3').enabled, true)
  await f.pick('execute-v3').run(f.ctx)
  assert.equal(changes, 1)
  assert.equal(f.pick('execute-v3').current, true)
  f.menu.dispose()
})

test('a previously enabled mode row cannot dispatch after an unavailable refresh', async () => {
  let supported = true, changes = 0, current = true
  const f = fixture({
    modes: async () => snapshot({ supported, code: supported ? undefined : 'CODEX_MODE_SETTINGS_REQUIRED' }),
    setMode: async () => { changes++ },
  }, { isCurrent: () => current })
  await f.menu.open(f.ctx)
  const row = f.pick('execute-v3')
  assert.equal(row.enabled, true)
  supported = false
  await f.menu.rows().find(row => row.id === 'provider-mode-refresh').run(f.ctx)
  assert.equal(f.pick('execute-v3')?.enabled, false)
  await row.run(f.ctx)
  assert.equal(changes, 0)
  current = false
  assert.match(f.pick('execute-v3').disabledHint, /session changed/i)
  f.menu.dispose()
})

async function refusalHostSources() {
  const { readFileSync } = await import('node:fs')
  const { parseAst } = await import('rollup/parseAst')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  const nodes = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) nodes.set(node.id.name, node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  const declaration = name => {
    assert.ok(nodes.has(name), 'actual host declaration: ' + name)
    const node = nodes.get(name)
    return source.slice(node.start, node.end)
  }
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const from = main.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS')
  const to = main.indexOf('function agentPayload')
  assert.ok(from > 0 && to > from)
  const wire = vm.runInNewContext(main.slice(from, to) + '; rendererSafeAgentError', { Error, Object })
  const crossed = error => {
    const sent = wire(error)
    const result = new Error('Error invoking remote method: Error: ' + sent.message)
    assert.equal(Object.hasOwn(result, 'code'), false)
    return result
  }
  return { source, nodes, declaration, crossed, compile(names, context) {
    return vm.runInNewContext(names.map(declaration).join('\n') + '\n; ({' + names.filter(name => name !== 'AgentHostError').join(',') + '})', context)
  }, vm }
}

for (const scenario of ['unadvertised', 'unconfirmed', 'changed-session', 'confirmed']) {
  test('actual host mode body through wire and menu retains confirmation boundary: ' + scenario, async () => {
    const h = await refusalHostSources()
    let modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'plan', name: 'Plan' }] }
    const calls = [], events = []
    const session = { sessionId: 'session-a', threadId: 'owned-thread', provider: 'codex' }
    const wait = deferred()
    const adapter = {
      getSessionModes: () => modes,
      selectMode: async (threadId, id) => {
        calls.push({ threadId, id })
        if (scenario === 'changed-session') await wait.promise
        if (scenario !== 'unconfirmed') modes = { ...modes, currentModeId: id }
        return { ...modes, appliesOn: 'next-turn' }
      },
    }
    session.adapter = adapter
    const host = h.compile(['AgentHostError', 'fail', 'boundedString', 'sessionModeSnapshot', 'readSessionModes', 'setSessionMode'], {
      Error, Object, closed: false, assertOpen() {},
      readySession(id, captured) { assert.equal(id, session.sessionId); if (captured) assert.equal(captured, session); return session },
      emit(_session, event) { assert.equal(_session, session); events.push(event) },
    })
    const errors = []
    const f = fixture({
      modes: request => host.readSessionModes(request),
      setMode: async request => {
        try { return await host.setSessionMode(request) }
        catch (error) { errors.push(error.code); throw h.crossed(error) }
      },
    })
    try {
      await f.menu.open(f.ctx)
      if (scenario === 'unadvertised') modes = { ...modes, availableModes: [{ id: 'ask', name: 'Ask' }] }
      const choosing = f.pick('plan').run(f.ctx)
      if (scenario === 'changed-session') {
        assert.equal(calls.length, 1)
        assert.equal(session.modeSelectionPending.cancelled, false)
        session.threadId = 'replacement-thread'
        wait.resolve()
      }
      await choosing
      assert.equal(session.modeSelectionPending, null)
      if (scenario === 'confirmed') {
        assert.deepEqual(calls, [{ threadId: 'owned-thread', id: 'plan' }])
        assert.equal(events.length, 1)
        assert.equal(f.pick('plan').current, true)
        assert.match(f.messages.at(-1), /Plan.*next turn/i)
        assert.doesNotMatch(f.messages.at(-1), /mode applied/i)
        assert.deepEqual(errors, [])
      } else {
        const code = scenario === 'unadvertised' ? 'AGENT_MODE_UNAVAILABLE' : 'AGENT_MODE_SELECTION_UNCONFIRMED'
        assert.deepEqual(errors, [code])
        assert.equal(calls.length, scenario === 'unadvertised' ? 0 : 1)
        assert.equal(events.length, 0)
        assert.equal(f.pick('ask').current, true, 'an uncertain reply must not select the requested row')
        assert.equal(f.pick('plan').enabled, false)
        assert.equal(f.messages.at(-1), saidFor(code))
        assert.match(f.messages.at(-1), /Refresh provider modes/)
        assert.doesNotMatch(f.messages.at(-1), /AGENT_|Error invoking|was not changed|unchanged|nothing happened/)
        const before = calls.length
        await f.pick('plan').run(f.ctx)
        assert.equal(calls.length, before, 'another selection requires an authoritative read')
        await f.menu.rows().find(row => row.id === 'provider-mode-refresh').run(f.ctx)
        assert.equal(calls.length, before, 'refresh must not select a mode')
        assert.equal(f.pick(scenario === 'changed-session' ? 'plan' : 'ask').current, true,
          'refresh reports the actual provider state even if it changed before an uncertain outcome')
      }
    } finally { wait.resolve(); f.menu.dispose() }
  })
}

/* THE SENTENCE THE PERSON READS IS A WHOLE SENTENCE. UNAVAILABLE_TEXT is a
   fragment table -- "the agent has not finished stopping...", "there was
   nothing running to stop..." -- built to be embedded after a lead-in. This
   menu prints its result with nothing in front of it -- through ctx.say() and
   again as the state row's label -- beside "Choose a mode advertised by this
   provider." Observed before this guard: "this session no longer offers that
   provider mode. Refresh provider modes and choose an available mode" --
   lower-case, unfinished, next to two whole sentences, while Home capitalised
   the same code. */
for (const code of ['AGENT_MODE_UNAVAILABLE', 'AGENT_MODE_SELECTION_UNCONFIRMED']) {
  test('a mode refusal is said as a whole sentence, not as the fragment the shared table stores: ' + code, async () => {
    const f = fixture({ modes: async () => snapshot(), setMode: async () => { throw new Error(code) } })
    await f.menu.open(f.ctx); await f.pick('execute-v3').run(f.ctx)
    const said = f.messages.at(-1)
    assert.match(said, /^[A-Z]/, 'the refusal is printed with nothing in front of it, so it must start a sentence')
    assert.match(said, /[.!?…]$/, 'the refusal is printed with nothing after it, so it must finish one')
    assert.ok(said.toLowerCase().includes(unavailableReason(code).toLowerCase()),
      'the words must still be the shared table\'s, not a second copy written here')
    assert.equal(f.pick('review-v2').current, true, 'wording must not move the current row')
  })
}

test('a session that is no longer open gets a sentence, not the IPC wrapper', async () => {
  for (const code of ['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']) {
    // The exact rejection shape ipcRenderer.invoke produces for mc-agent:modes.
    const f = fixture({ modes: async () => { throw new Error(`Error invoking remote method 'mc-agent:modes': Error: ${code}`) } })
    await f.menu.open(f.ctx)
    assert.doesNotMatch(f.messages.at(-1), /invoking remote method|MC_AGENT_/)
    assert.match(f.messages.at(-1), /no longer open/)
    assert.doesNotMatch(f.menu.rows()[0].label, /invoking remote method|MC_AGENT_/)
    assert.equal(f.menu.rows().at(-1).id, 'provider-mode-refresh')
  }
})


/* T1049 mounted provider-mode regressions: canonical block appended at EOF.
   The moved mounted draft is provenance only; this block is the selected-suite
   execution input. */
{
/*
 * This is the existing action-popup DOM double used by
 * chat-queued-model-switch.test.mjs, kept local so this slice exercises
 * buildChat's real popup rather than calling menu rows in isolation.
 */
class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(value) { return this.values().includes(value) }
  add(...values) { this.node.className = [...new Set([...this.values(), ...values])].join(' ') }
  remove(...values) { this.node.className = this.values().filter(value => !values.includes(value)).join(' ') }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force
    enabled ? this.add(value) : this.remove(value)
    return enabled
  }
}

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.value = ''
    this.textContent = ''
    this.style = {}
    this.dataset = {}
    this.scrollTop = 0
    this.scrollHeight = 100
    this.clientHeight = 100
    this.classList = new Classes(this)
  }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === 'string'
        ? Object.assign(new NodeDouble('span'), { textContent: node })
        : node)
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) {
    const index = this.children.indexOf(at)
    node.parentNode = this
    this.children.splice(index < 0 ? this.children.length : index, 0, node)
    return node
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
    this.parentNode = null
  }
  replaceWith(node) {
    if (!this.parentNode) return
    const index = this.parentNode.children.indexOf(this)
    this.parentNode.children[index] = node
    node.parentNode = this.parentNode
    this.parentNode = null
  }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(key, value) {
    this.attributes.set(key, String(value))
    if (key === 'class') this.className = String(value)
    if (key.startsWith('data-')) {
      this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value)
    }
  }
  getAttribute(key) { return key === 'class' ? this.className : this.attributes.get(key) ?? null }
  removeAttribute(key) { this.attributes.delete(key) }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type)
    if (!listeners) return
    const remaining = listeners.filter(entry => entry !== listener)
    if (remaining.length) this.listeners.set(type, remaining)
    else this.listeners.delete(type)
  }
  dispatch(type, init = {}) {
    const event = {
      target: this,
      key: '',
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
      ...init,
    }
    for (const listener of this.listeners.get(type) || []) listener(event)
    return event
  }
  focus() { document.activeElement = this }
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true
    }
    return false
  }
  get isConnected() {
    return Boolean(globalThis.document?.documentElement?.contains(this))
  }
  closest(selector) {
    for (let current = this; current; current = current.parentNode) {
      if (current.matches(selector)) return current
    }
    return null
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
      return Boolean(match && (match[2] === undefined
        ? this.attributes.has(match[1])
        : this.getAttribute(match[1]) === match[2]))
    }
    const [tag, className] = selector.split('.')
    return (!tag || this.tagName === tag.toUpperCase())
      && (!className || this.classList.contains(className))
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/)
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(parts.at(-1))
            && (parts.length === 1 || child.parentNode?.matches(parts[0]))) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  scrollIntoView() {}
  set innerHTML(html) { this.children = []; parse(html, this) }
}

function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) {
      const text = token.trim()
      if (text) stack.at(-1).textContent += text
      continue
    }
    if (/^<!/.test(token)) continue
    const match = token.match(/^<([\w-]+)/)
    if (!match) continue
    const node = new NodeDouble(match[1])
    for (const attribute of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (attribute[1] !== match[1]) node.setAttribute(attribute[1], attribute[2] ?? '')
    }
    if (/\shidden(?:\s|>|\/)/.test(token)) node.hidden = true
    stack.at(-1).appendChild(node)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(match[1])) stack.push(node)
  }
}

const { after: afterMountedModes } = await import('node:test')
const mountedGlobalDescriptors = new Map(['document', 'window', 'ResizeObserver', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
afterMountedModes(() => {
  for (const [key, descriptor] of mountedGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
const docRoot = new NodeDouble('html')
if (!globalThis.document?.createElement) {
  globalThis.document = {
    documentElement: docRoot,
    body: new NodeDouble('body'),
    activeElement: null,
    fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
    createElement(tag) {
      if (tag !== 'template') return new NodeDouble(tag)
      const content = { firstElementChild: null }
      return {
        content,
        set innerHTML(value) {
          const host = new NodeDouble('host')
          parse(value, host)
          content.firstElementChild = host.children[0]
        },
      }
    },
    addEventListener: (...args) => docRoot.addEventListener(...args),
    removeEventListener: (...args) => docRoot.removeEventListener(...args),
  }
}
if (!globalThis.window) globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver ||= class { observe() {} disconnect() {} }
globalThis.MutationObserver ||= class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame ||= fn => { fn(); return 1 }
globalThis.cancelAnimationFrame ||= () => {}

const { buildChat } = await import('../../src/components.js')

const settle = async (turns = 3) => {
  for (let index = 0; index < turns; index++) await new Promise(resolve => setTimeout(resolve, 0))
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const state = (extra = {}) => ({
  sessionId: 'mode-session',
  provider: 'runtime-provider',
  supported: true,
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'plan', name: 'Plan' },
  ],
  pending: false,
  ...extra,
})
const copyState = value => ({
  ...value,
  availableModes: value.availableModes.map(mode => ({ ...mode })),
})
function popupButton(chat, label) {
  const matches = chat.querySelectorAll('.chat-actions-row').filter(row =>
    row.textContent.includes(label)
      || row.querySelector('div')?.textContent.includes(label)
      || row.querySelector('.chat-actions-hint')?.textContent.includes(label))
  return matches.at(-1) || null
}
function popupStatus(chat) {
  return chat.querySelector('.chat-actions-out')?.textContent || ''
}
function assertTiming(text, modeName, timing) {
  assert.match(text, new RegExp(modeName, 'i'))
  assert.match(text, timing === 'next-turn' ? /next[- ]turn/i : /subsequent[- ]turns/i)
}
function mountMenu({ bridge, subscribe = null, isCurrent = () => true }) {
  const menus = []
  const openProviderModes = ctx => {
    const menu = createProviderModeMenu({
      sessionId: 'mode-session',
      bridge,
      isCurrent,
      subscribe,
    })
    menus.push(menu)
    return menu.open(ctx)
  }
  const chat = buildChat({
    seed: 0,
    onSend() { throw new Error('provider mode action must not send the draft') },
    chips: {
      tier: () => ({ label: 'Unrestricted' }),
      onOpenMode: root => root.openActions('provider-mode'),
    },
    actions: () => [{
      id: 'provider-mode',
      label: 'Provider mode',
      enabled: true,
      run: openProviderModes,
    }],
  })
  docRoot.appendChild(chat)
  return { chat, menus, openProviderModes }
}
async function openThroughModeChip(fixture) {
  // buildChat binds the click to [data-chat-chip="mode"]; find the chip the same way. This is also
  // the evidence tools/check-chat-control-coverage.mjs looks for.
  const chip = fixture.chat.querySelector('[data-chat-chip="mode"]')
  assert.ok(chip, 'the mounted chat exposes a provider-mode chip')
  assert.equal(chip, fixture.chat.querySelector('.chat-chip-mode'), 'the bound chip is the styled Provider mode chip')
  chip.dispatch('click')
  await settle()
  assert.ok(fixture.chat.querySelector('.chat-actions-pop'), 'the real action popup opened')
  return fixture.menus.at(-1)
}
function disposeChat(fixture) { fixture.chat.dispose() }

for (const timing of ['next-turn', 'subsequent-turns']) {
  test('mounted provider-mode ACK exposes ' + timing + ' timing and survives reopen', async () => {
    let current = state()
    const calls = []
    const bridge = {
      modes: async () => copyState(current),
      setMode: async request => {
        calls.push(request)
        current = state({ currentModeId: request.modeId, appliesOn: timing })
        return { ...copyState(current), applied: true }
      },
    }
    const fixture = mountMenu({ bridge })
    const menu = await openThroughModeChip(fixture)
    assert.equal(fixture.chat.querySelector('.chat-chip-tier').textContent, 'Unrestricted')
    const target = popupButton(fixture.chat, 'Plan')
    assert.ok(target && !target.disabled, 'the advertised provider mode is actionable')
    target.dispatch('click')
    await settle()
    assert.deepEqual(calls, [{ sessionId: 'mode-session', modeId: 'plan' }])
    assertTiming(popupStatus(fixture.chat), 'Plan', timing)
    assert.equal(menu.rows().find(row => row.id === 'provider-mode-plan').current, true)

    fixture.chat.openActions('provider-mode')
    await settle()
    assertTiming(popupStatus(fixture.chat), 'Plan', timing)
    assert.equal(popupButton(fixture.chat, 'Plan').disabled, false)
    disposeChat(fixture)
  })
}

test('mounted refusal remains disabled after an event reread until explicit Refresh', async () => {
  let current = state()
  let reads = 0
  let listener
  let off = 0
  const calls = []
  const bridge = {
    modes: async () => { reads++; return copyState(current) },
    setMode: async request => {
      calls.push(request)
      throw new Error('AGENT_MODE_SELECTION_UNCONFIRMED')
    },
  }
  const fixture = mountMenu({
    bridge,
    subscribe: callback => { listener = callback; return () => { off++ } },
  })
  await openThroughModeChip(fixture)
  const target = popupButton(fixture.chat, 'Plan')
  target.dispatch('click')
  await settle()
  assert.deepEqual(calls, [{ sessionId: 'mode-session', modeId: 'plan' }])
  const refusal = popupStatus(fixture.chat)
  assert.ok(refusal.length > 0)
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, true)
  assert.match(popupButton(fixture.chat, 'Plan').querySelector('.chat-actions-why')?.textContent || '', /Refresh provider modes/)

  current = state({ currentModeId: 'plan', appliesOn: 'next-turn' })
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  await settle()
  assert.ok(reads >= 2)
  assert.equal(popupStatus(fixture.chat), refusal, 'an event may reread authority but cannot clear a failed change')
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, true)
  assert.equal(fixture.menus.at(-1).rows().find(row => row.id === 'provider-mode-plan').current, true)

  popupButton(fixture.chat, 'Refresh provider modes').dispatch('click')
  await settle()
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, false)
  assertTiming(popupStatus(fixture.chat), 'Plan', 'next-turn')
  assert.equal(off, 0, 'the mounted popup remains subscribed until it closes')
  disposeChat(fixture)
  assert.equal(off, 1)
})

test('event during selection refusal queues an automatic reread without clearing the refusal', async () => {
  let current = state()
  let reads = 0
  let listener
  const selection = deferred()
  const calls = []
  const bridge = {
    modes: async () => { reads++; return copyState(current) },
    setMode: async request => { calls.push(request); return selection.promise },
  }
  const fixture = mountMenu({
    bridge,
    subscribe: callback => { listener = callback; return () => {} },
  })
  await openThroughModeChip(fixture)
  popupButton(fixture.chat, 'Plan').dispatch('click')
  await settle()
  assert.deepEqual(calls, [{ sessionId: 'mode-session', modeId: 'plan' }])
  current = state({ currentModeId: 'plan', appliesOn: 'subsequent-turns' })
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  assert.equal(reads, 1, 'the event is queued behind the pending selection')
  selection.reject(new Error('AGENT_MODE_SELECTION_UNCONFIRMED'))
  await settle(4)
  assert.equal(reads, 2, 'the queued event reread runs after the refusal')
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, true)
  assert.match(popupButton(fixture.chat, 'Plan').querySelector('.chat-actions-why')?.textContent || '', /Refresh provider modes/)
  assert.equal(popupStatus(fixture.chat).length > 0, true)
  assert.equal(fixture.menus.at(-1).rows().find(row => row.id === 'provider-mode-plan').current, true)
  disposeChat(fixture)
})

test('explicit Refresh wins a matching event race and clears an earlier refusal', async () => {
  let current = state()
  let reads = 0
  let listener
  const refresh = deferred()
  const calls = []
  const bridge = {
    modes: async () => {
      reads++
      return reads === 2 ? refresh.promise : copyState(current)
    },
    setMode: async request => {
      calls.push(request)
      throw new Error('AGENT_MODE_SELECTION_UNCONFIRMED')
    },
  }
  const fixture = mountMenu({
    bridge,
    subscribe: callback => { listener = callback; return () => {} },
  })
  await openThroughModeChip(fixture)
  popupButton(fixture.chat, 'Plan').dispatch('click')
  await settle()
  assert.deepEqual(calls, [{ sessionId: 'mode-session', modeId: 'plan' }])
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, true)

  current = state({ currentModeId: 'plan', appliesOn: 'subsequent-turns' })
  popupButton(fixture.chat, 'Refresh provider modes').dispatch('click')
  await settle()
  assert.equal(reads, 2)
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  refresh.resolve(copyState(current))
  await settle(5)
  assert.equal(reads, 3, 'the obsolete refresh response is followed by an explicit-intent reread')
  assert.equal(popupButton(fixture.chat, 'Plan').disabled, false)
  assertTiming(popupStatus(fixture.chat), 'Plan', 'subsequent-turns')
  assert.equal(fixture.menus.at(-1).rows().find(row => row.id === 'provider-mode-plan').current, true)
  disposeChat(fixture)
})


test('obsolete automatic mode-read rejection is discarded after a newer event', async () => {
  let current = state()
  let reads = 0
  let listener
  const obsolete = deferred()
  const bridge = {
    modes: async () => {
      reads++
      if (reads === 2) return obsolete.promise
      return copyState(current)
    },
    setMode: async () => { throw new Error('selection must not run during an event read') },
  }
  const fixture = mountMenu({
    bridge,
    subscribe: callback => { listener = callback; return () => {} },
  })
  await openThroughModeChip(fixture)

  current = state({ currentModeId: 'plan', appliesOn: 'next-turn' })
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  obsolete.reject(new Error('obsolete automatic read failure'))
  await settle(6)

  assert.equal(reads, 3, 'the superseding event schedules one current follow-up read')
  const modeRow = fixture.menus.at(-1).rows().find(row => row.id === 'provider-mode-plan')
  assert.equal(modeRow.current, true)
  assert.equal(modeRow.enabled, true, 'the current mode rows are enabled after the valid follow-up')
  assert.match(popupStatus(fixture.chat), /Plan/i)
  assert.match(popupStatus(fixture.chat), /next[- ]turn/i)
  assert.doesNotMatch(popupStatus(fixture.chat), /obsolete automatic read failure|Retry reading/i)
  fixture.chat.dispose()
})

test('mounted currentness and disposal fence stale and late events', async () => {
  let current = true
  let reads = 0
  let listener
  let off = 0
  let setCalls = 0
  const bridge = {
    modes: async () => { reads++; return copyState(state()) },
    setMode: async () => { setCalls++ },
  }
  const fixture = mountMenu({
    bridge,
    isCurrent: () => current,
    subscribe: callback => { listener = callback; return () => { off++ } },
  })
  await openThroughModeChip(fixture)
  current = false
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  await settle()
  assert.equal(reads, 1, 'a stale popup ignores its event')
  popupButton(fixture.chat, 'Plan').dispatch('click')
  await settle()
  assert.equal(setCalls, 0, 'a stale popup cannot reach the host')
  fixture.chat.dispose()
  assert.equal(off, 1)
  listener({ sessionId: 'mode-session', event: { type: 'session_mode_changed' } })
  await settle()
  assert.equal(reads, 1, 'a disposed popup ignores late events')
  assert.equal(fixture.chat.querySelector('.chat-actions-pop'), null)
})

const { readFileSync: t1030ReadFileSync } = await import('node:fs')
const computersSource = t1030ReadFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function productionOpenProviderModes(bindings) {
  const start = computersSource.indexOf('const openProviderModes = ctx => {')
  const end = computersSource.indexOf('const modelRows = () => {', start)
  assert.ok(start >= 0 && end > start, 'the production openProviderModes slice is available')
  return Function(...Object.keys(bindings),
    computersSource.slice(start, end) + '\nreturn openProviderModes')(...Object.values(bindings))
}
function productionMountedFixture({ dataSource = 'local', mocked = false }) {
  const node = { id: 'mounted-node', sessionId: 'mode-session' }
  const store = { getNode: () => node }
  let reads = 0
  let setCalls = 0
  const bridge = {
    modes: async () => { reads++; return copyState(state()) },
    setMode: async () => { setCalls++ },
  }
  const priorWindow = globalThis.window
  const hadMcAgent = Object.prototype.hasOwnProperty.call(priorWindow, 'mcAgent')
  const previousMcAgent = priorWindow.mcAgent
  priorWindow.mcAgent = bridge
  let restored = false
  const restoreBridge = () => {
    if (restored) return
    restored = true
    if (hadMcAgent) priorWindow.mcAgent = previousMcAgent
    else delete priorWindow.mcAgent
  }
  const providerModeListeners = new Set()
  const openProviderModes = productionOpenProviderModes({
    createProviderModeMenu,
    fresh: () => node,
    treeStore: store,
    node,
    destroyed: false,
    window: globalThis.window,
    mockSource: () => mocked,
    currentDataSource: () => dataSource,
    nodeCleanupPending: () => false,
    startCleanupSentence: () => 'Cleanup pending.',
    nodeBusy: () => false,
    startingNodeIds: new Set(),
    startDraftFlight: { busy: () => false },
    nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => ({ isRecovering: () => false }),
    providerModeListeners,
  })
  const chat = buildChat({
    seed: 0,
    chips: {
      tier: () => ({ label: 'Unrestricted' }),
      onOpenMode: root => root.openActions('provider-mode'),
    },
    actions: () => [{
      id: 'provider-mode',
      label: 'Provider mode',
      enabled: true,
      run: openProviderModes,
    }],
  })
  docRoot.appendChild(chat)
  return {
    chat,
    bridge,
    providerModeListeners,
    get reads() { return reads },
    get setCalls() { return setCalls },
    dispose() {
      try { chat.dispose() } finally { restoreBridge() }
    },
  }
}

for (const scenario of [
  { name: 'example data source', dataSource: 'example', mocked: false },
  { name: 'mock source', dataSource: 'local', mocked: true },
]) {
  test('mounted provider-mode local guard remains visible for ' + scenario.name, async () => {
    const fixture = productionMountedFixture(scenario)
    try {
      fixture.chat.openActions('provider-mode')
      await settle()
      const target = popupButton(fixture.chat, 'Plan')
      assert.ok(target, 'the mounted production action popup shows the advertised mode')
      assert.equal(target.disabled, true)
      assert.match(target.querySelector('.chat-actions-why')?.textContent || '', /Provider modes require a local live session/)
      target.dispatch('click')
      await settle()
      assert.equal(fixture.setCalls, 0, 'example/mock provider mode cannot dispatch a host mutation')
    } finally {
      fixture.dispose()
    }
  })
}

}
