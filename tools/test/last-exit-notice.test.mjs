/* DOES THE PERSON GET TOLD THAT THE APP DID NOT CLOSE NORMALLY LAST TIME?
 *
 * Observed on a hand-test profile: kill the main process, reopen, and the app
 * lands on Home with everything in place and not one word about it; agents that
 * were mid-turn read idle.
 *
 * NOTHING HERE IS A HAND-WRITTEN LISTING. Every "previous run" below is
 * produced by the producers themselves:
 *   - the Engine's own diagnostic store (src/lib/diagnostic-retention.js) on the
 *     Engine's in-memory test filesystem, one store per process id, so the
 *     metadata, ids, rotation and "is that process alive" answers are its own;
 *   - the shell's own exit-record writer (shell/exit-record.cjs) appending
 *     through that store, exactly as shell/main.cjs wires it;
 *   - the shell's own facade (shell/product-settings.cjs), which is the object
 *     behind mcSettings.diagnosticsInspect;
 *   - the real tree store (src/fleet-trees.js) for the saved agents.
 * A killed run is a store that is simply never closed or disposed. Nothing
 * touches the disk. The Engine is resolved like every other integration
 * fixture here (tools/canonical-root.mjs, MC_CANONICAL_ROOT).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { previousExit, readDiagnosticRows, lastExitNotice, lastExitNoticeSource, midTurnRecords, agentsMidTurn } from '../../src/last-exit-notice.js'
import { mountSettingsRecoveryNotice, settingsRecoveryNotice } from '../../src/settings-recovery-notice.js'
import { createFleetTreeStore, fleetTreesStorageKey } from '../../src/fleet-trees.js'

const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests()
const retention = require(path.join(engineRoot, 'src/lib/diagnostic-retention.js'))
const { memoryFs } = require(path.join(engineRoot, 'tests/helpers/diagnostic-memory-fs.js'))
const { createProductDiagnostics } = require('../../shell/product-settings.cjs')
const { createExitRecordWriter } = require('../../shell/exit-record.cjs')

const COMPUTER = 'this-computer'
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0)

/* One profile's diagnostic folder, and the processes that have used it. */
function profile({ limits } = {}) {
  const disk = memoryFs(), directory = path.resolve('synthetic-last-exit-diagnostics')
  const clock = { at: T0 }
  const alive = new Set()
  let number = 0
  function run(pid) {
    alive.add(pid)
    const store = retention.createDiagnosticStore({ directory, fs: disk, pid, now: () => clock.at,
      uuid: () => '00000000-0000-0000-0000-' + String(++number).padStart(12, '0'),
      readPolicy: () => retention.resolveDiagnosticPolicy(retention.DEFAULT_CHOICE),
      isAlive: other => alive.has(other), limits, schedule: () => ({ unref() {} }), cancel() {} })
    const facade = createProductDiagnostics({ engineRoot, retentionModule: retention, store, chooseExport: async () => ({ canceled: true }) })
    const lag = facade.writer('main-lag'), heap = facade.writer('main-heap'), exit = facade.writer('exit-record')
    /* What shell/main.cjs writes at startup, through the same writer. */
    assert.equal(lag.append(JSON.stringify({ event: 'diagnostic-sink-ready', producer: 'main-lag', pid })).written, true)
    const exitRecord = createExitRecordWriter({ file: path.join(directory, 'unused-exit-record.log'), appendSink: line => exit.append(line), pid, now: () => clock.at })
    const inspects = []
    return { pid, store, facade, lag, heap, exit, exitRecord, inspects,
      bridge: { diagnosticsInspect: request => { inspects.push(request); return facade.inspect(request) } },
      /* The orderly way out: the hooks write their record, then process exit seals the files. */
      async quit() {
        clock.at += 1000
        for (const [trigger, initiator] of [['window-all-closed', 'last-window-closed'], ['before-quit', 'app-quit-gate'], ['will-quit', 'agent-facade-close']]) {
          assert.equal(exitRecord.writeExitRecord(trigger, initiator), true)
        }
        await facade.dispose(); alive.delete(pid)
      },
      /* kill -9: nothing is written, nothing is sealed, the process is gone. */
      kill() { alive.delete(pid) } }
  }
  return { disk, directory, clock, alive, run }
}

function treeStorage() {
  const cells = new Map()
  return { cells, read: key => (cells.has(key) ? JSON.parse(cells.get(key)) : null), write: (key, value) => { cells.set(key, JSON.stringify(value)); return true },
    getItem: key => (cells.has(key) ? cells.get(key) : null) }
}

/* Saved agents, written by the real store with a controllable clock. */
function savedAgents(storage, clock) {
  let count = 0
  const store = createFleetTreeStore({ computerId: COMPUTER, storage, now: () => new Date(clock.at).toISOString(), makeId: kind => `${kind}-${++count}` })
  return { store,
    midTurn(role) { const node = store.addNode({ role }).node; assert.equal(store.attachSession(node.id, `chat-${node.id}`).ok, true); assert.equal(store.setNodeStatus(node.id, 'running').ok, true); return node },
    finished(role) { const node = this.midTurn(role); assert.equal(store.setNodeStatus(node.id, 'finished').ok, true); return node } }
}

class FakeElement {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = '' }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._text }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) { this.children = this.children.filter(entry => entry !== child); child.parentNode = null; return child }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  find(className) { for (const child of this.children) { if (child.className === className) return child; const deeper = child.find(className); if (deeper) return deeper } return null }
}
const fakeDocument = () => ({ body: new FakeElement('body'), createElement: tag => new FakeElement(tag) })

async function open(next, { storage = treeStorage(), prefsNotice = { read: () => ({ damaged: null, file: 'settings.json', preservedAt: null, refused: null }), subscribe: () => () => {} } } = {}) {
  const doc = fakeDocument()
  const source = lastExitNoticeSource({ prefsNotice, bridge: next.bridge, storage, computerIds: [COMPUTER] })
  const handle = mountSettingsRecoveryNotice({ doc, source, container: doc.body })
  const atMount = handle.element()
  const exit = await source.settled
  return { doc, handle, source, exit, atMount, bar: handle.element() }
}

test('GRACEFUL: a run that wrote its exit record and sealed its files is followed by silence', async () => {
  const p = profile()
  const first = p.run(1001); p.clock.at += 60_000; await first.quit()
  p.clock.at += 5000
  const opened = await open(p.run(1002))
  assert.deepEqual({ known: opened.exit.known, ungraceful: opened.exit.ungraceful, pid: opened.exit.pid }, { known: true, ungraceful: false, pid: 1001 })
  assert.equal(opened.bar, null, 'an orderly close must never be called a crash')
})

test('CRASH: a killed run has a main-lag file and no exit record, and the person is told, with the agents that were mid-turn', async () => {
  const p = profile(), storage = treeStorage()
  const agents = savedAgents(storage, p.clock)
  const phantom = agents.midTurn('archivist')   // saved `running` by an OLDER run and never rewritten
  p.clock.at += 3_600_000
  const first = p.run(2001)
  p.clock.at += 60_000
  const working = agents.midTurn('builder')
  agents.finished('reviewer')
  p.clock.at += 60_000
  first.kill()
  p.clock.at += 5000
  const opened = await open(p.run(2002), { storage })
  assert.equal(opened.atMount, null, 'nothing is claimed before the listing has answered')
  assert.deepEqual({ known: opened.exit.known, ungraceful: opened.exit.ungraceful, pid: opened.exit.pid }, { known: true, ungraceful: true, pid: 2001 })
  assert.ok(opened.bar, 'THE DEFECT: the app reopened after a kill and said nothing')
  assert.equal(opened.bar.getAttribute('data-settings-recovery'), 'last-exit')
  assert.equal(opened.bar.getAttribute('role'), 'status')
  const expected = lastExitNotice({ agents: ['builder'] })
  assert.equal(opened.bar.find('settings-recovery-heading').textContent, expected.heading)
  const body = opened.bar.find('settings-recovery-body').textContent
  assert.equal(body, expected.body)
  assert.match(body, /\bbuilder was in the middle of a turn\b/)
  assert.doesNotMatch(body, /archivist|reviewer/, 'an old phantom `running` record and a finished agent are not blamed on this run')
  assert.match(body, /Nothing was deleted/)
  assert.ok(phantom.id && working.id)
  /* Dismissible like every other sentence on this bar. */
  opened.bar.find('settings-recovery-dismiss').listeners.get('click')()
  assert.equal(opened.handle.element(), null)
})

test('CRASH with nobody mid-turn says so instead of naming anyone', async () => {
  const p = profile()
  p.run(2101).kill(); p.clock.at += 5000
  const opened = await open(p.run(2102))
  assert.equal(opened.bar.find('settings-recovery-body').textContent, lastExitNotice({ agents: [] }).body)
  assert.match(opened.bar.find('settings-recovery-body').textContent, /No agent is recorded as mid-turn/)
})

test('FIRST RUN: no folder, and then only this run\'s own files, are both silence', async () => {
  const p = profile()
  const absent = retention.createDiagnosticStore({ directory: p.directory, fs: p.disk, pid: 3001, isAlive: () => true,
    readPolicy: () => retention.resolveDiagnosticPolicy(retention.DEFAULT_CHOICE), schedule: () => ({ unref() {} }), cancel() {} })
  const facade = createProductDiagnostics({ engineRoot, retentionModule: retention, store: absent })
  facade.writer('main-lag')   // opened lazily: nothing is on disk yet
  const listing = await readDiagnosticRows({ diagnosticsInspect: request => facade.inspect(request) })
  assert.deepEqual(listing, { rows: [], ownPid: 3001 })
  assert.deepEqual(previousExit(listing.rows, listing.ownPid), { known: true, firstRun: true, ungraceful: false })
  const opened = await open(profile().run(3002))
  assert.equal(opened.exit.firstRun, true)
  assert.equal(opened.bar, null)
})

test('ROTATED LOG: a long run split across several files is one run, killed or not', async () => {
  const killed = profile()
  const long = killed.run(4001)
  const startedAt = killed.clock.at
  for (let segment = 0; segment < 3; segment += 1) { killed.clock.at += 60_000; long.lag.rotate(); assert.equal(long.lag.append('stall sample').written, true); long.heap.append('heap sample') }
  long.kill(); killed.clock.at += 5000
  const afterKill = await open(killed.run(4002))
  assert.equal(afterKill.exit.ungraceful, true)
  assert.equal(afterKill.exit.startedAt, startedAt, 'the run began at its FIRST file, which is what bounds the agents named')
  assert.ok(afterKill.bar)

  const orderly = profile()
  const calm = orderly.run(4101)
  for (let segment = 0; segment < 3; segment += 1) { orderly.clock.at += 60_000; calm.lag.rotate(); calm.lag.append('stall sample') }
  await calm.quit(); orderly.clock.at += 5000
  assert.equal((await open(orderly.run(4102))).bar, null)

  /* An older killed run followed by an orderly one: only the LAST run counts. */
  const mixed = profile()
  mixed.run(4201).kill(); mixed.clock.at += 60_000
  const second = mixed.run(4202); mixed.clock.at += 60_000; await second.quit(); mixed.clock.at += 5000
  const third = await open(mixed.run(4203))
  assert.deepEqual({ pid: third.exit.pid, ungraceful: third.exit.ungraceful }, { pid: 4202, ungraceful: false })
  assert.equal(third.bar, null)
})

test('A LISTING LONGER THAN ONE PAGE is read to its end through the existing paging, and an unfinished one is silence', async () => {
  const p = profile({ limits: { entriesPerPass: 4 } })
  const long = p.run(5001)
  for (let segment = 0; segment < 5; segment += 1) { p.clock.at += 60_000; long.lag.rotate(); long.lag.append('stall sample') }
  long.kill(); p.clock.at += 5000
  const next = p.run(5002)
  const opened = await open(next)
  assert.ok(next.inspects.length > 1, 'this fixture must actually page')
  assert.deepEqual(next.inspects[0], { next: false })
  assert.ok(next.inspects.slice(1).every(request => request.next === true))
  assert.equal(opened.exit.ungraceful, true)
  assert.equal(await readDiagnosticRows(next.bridge, { maxPages: 1 }), null, 'a scan that did not reach the end of the folder proves nothing')
})

test('CORRUPT TAIL: a torn file pair or unreadable metadata is "cannot tell", never "it crashed"', async () => {
  /* A kill between creating the data file and saving its metadata. */
  const torn = profile()
  await torn.run(6001).quit(); torn.clock.at += 5000
  torn.disk.writeFileSync(path.join(torn.directory, `diag-${torn.clock.at}-00000000-0000-0000-0000-00000000aaaa.jsonl`), '', { flag: 'wx' })
  const afterTorn = await open(torn.run(6002))
  assert.equal(afterTorn.exit, null)
  assert.equal(afterTorn.bar, null)

  /* Metadata that is not JSON any more. */
  const damaged = profile()
  const victim = damaged.run(6101)
  const id = victim.lag.state().id
  victim.kill(); damaged.clock.at += 5000
  damaged.disk.writeFileSync(path.join(damaged.directory, id + '.meta.json'), '{"version":1,"id":"' + id.slice(0, 20))
  const afterDamage = await open(damaged.run(6102))
  assert.equal(afterDamage.exit, null)
  assert.equal(afterDamage.bar, null, 'a record that cannot be read is not evidence of a crash')

  /* A torn LAST LINE inside the exit record itself: the run still quit in order. */
  const tornLine = profile()
  const quitter = tornLine.run(6201)
  quitter.exitRecord.writeExitRecord('before-quit', 'app-quit-gate')
  assert.equal(quitter.exit.append('{"at":"2026-09-20T12:0').written, true)
  await quitter.facade.dispose(); tornLine.alive.delete(6201); tornLine.clock.at += 5000
  assert.equal((await open(tornLine.run(6202))).bar, null)
})

test('a record some OTHER live process still holds, a busy listing and a refusing bridge are all silence', async () => {
  const p = profile()
  p.run(7001)   // still alive: a second instance, or the dead run's process id given to something else
  p.clock.at += 5000
  const opened = await open(p.run(7002))
  assert.deepEqual(opened.exit, { known: false, reason: 'another-process-active' })
  assert.equal(opened.bar, null)

  assert.equal(await readDiagnosticRows({ diagnosticsInspect: async () => ({ ok: false, reason: 'diagnostic-busy', files: [] }) }), null)
  assert.equal(await readDiagnosticRows({ diagnosticsInspect: async () => { throw new Error('bridge closed') } }).catch(() => 'threw'), 'threw')
  const refusing = await open({ bridge: { diagnosticsInspect: async () => { throw new Error('bridge closed') } } })
  assert.equal(refusing.exit, null)
  assert.equal(refusing.bar, null)
  assert.equal(lastExitNoticeSource({ prefsNotice: null, bridge: null, storage: null }), null, 'a plain browser mounts nothing, as before')
})

test('a settings problem keeps the bar; the settings source alone behaves exactly as it did', async () => {
  const p = profile()
  p.run(8001).kill(); p.clock.at += 5000
  const damagedState = { damaged: 'the settings file contains malformed JSON', file: 'settings.json', preservedAt: null, refused: null }
  const listeners = []
  const prefsNotice = { read: () => damagedState, subscribe: listener => { listeners.push(listener); return () => {} } }
  const opened = await open(p.run(8002), { prefsNotice })
  assert.equal(opened.exit.ungraceful, true)
  assert.equal(opened.bar.getAttribute('data-settings-recovery'), 'damaged', 'a settings problem outranks the exit sentence')
  assert.equal(opened.bar.find('settings-recovery-body').textContent, settingsRecoveryNotice(damagedState).body)
  assert.equal(opened.bar.find('settings-recovery-dismiss').getAttribute('aria-label'), 'Dismiss the settings notice for this window')

  /* With no diagnostics bridge the wrapper hands back the settings state itself. */
  const plain = lastExitNoticeSource({ prefsNotice, bridge: null, storage: null })
  assert.equal(plain.read(), damagedState)
  assert.equal(await plain.settled, null)
  const seen = []
  plain.subscribe(state => seen.push(state))
  const refusedState = { ...damagedState, refused: { key: 'mc.set.theme', action: 'save', code: 'MC_PREFS_TOO_LARGE' } }
  for (const listener of listeners) listener(refusedState)
  assert.deepEqual(seen, [refusedState])
})

test('a DISMISSED exit sentence stays dismissed when an unrelated settings refusal appears and then clears', async () => {
  const p = profile()
  p.run(8101).kill(); p.clock.at += 5000
  const calm = { damaged: null, file: 'settings.json', preservedAt: null, refused: null }
  let state = calm
  const listeners = []
  const prefsNotice = { read: () => state, subscribe: listener => { listeners.push(listener); return () => {} } }
  const opened = await open(p.run(8102), { prefsNotice })
  assert.equal(opened.bar.getAttribute('data-settings-recovery'), 'last-exit')
  opened.bar.find('settings-recovery-dismiss').listeners.get('click')()
  assert.equal(opened.handle.element(), null)
  /* public/durable-storage.js announces a refused write, and announces again with
     refused back to null once the same key is saved (:150-152, :379). */
  state = { ...calm, refused: { key: 'mc.set.theme', action: 'save', code: 'MC_PREFS_TOO_LARGE' } }
  for (const listener of listeners) listener(state)
  assert.equal(opened.handle.element().getAttribute('data-settings-recovery'), 'refused', 'a refusal still re-arms the bar, as before')
  state = calm
  for (const listener of listeners) listener(state)
  assert.equal(opened.handle.element(), null, 'the sentence the person dismissed must not come back')

  /* Not dismissed: a refusal that comes and goes hands the bar back to the exit sentence. */
  const again = profile()
  again.run(8201).kill(); again.clock.at += 5000
  let second = calm
  const others = []
  const kept = await open(again.run(8202), { prefsNotice: { read: () => second, subscribe: listener => { others.push(listener); return () => {} } } })
  second = { ...calm, refused: { key: 'mc.set.theme', action: 'save', code: 'MC_PREFS_TOO_LARGE' } }
  for (const listener of others) listener(second)
  assert.equal(kept.handle.element().getAttribute('data-settings-recovery'), 'refused')
  second = calm
  for (const listener of others) listener(second)
  assert.equal(kept.handle.element().getAttribute('data-settings-recovery'), 'last-exit')
})

test('the pure reader: only a run that BEGAN in the dead run is named, and a malformed listing is "cannot tell"', () => {
  const records = [{ name: 'old', runStartedAt: 10 }, { name: 'new', runStartedAt: 30 }]
  assert.deepEqual(agentsMidTurn(records, 20), ['new'])
  assert.deepEqual(agentsMidTurn(records, Number.NaN), [])
  assert.deepEqual(midTurnRecords({ storage: { getItem: () => '{not json' }, computerIds: [COMPUTER] }), [])
  assert.deepEqual(midTurnRecords({ storage: { getItem: key => (key === fleetTreesStorageKey(COMPUTER) ? null : 'x') }, computerIds: [COMPUTER] }), [])
  assert.deepEqual(previousExit([{ kind: 'main-lag', pid: 'x', createdAt: 1, active: false }], 9), { known: false, reason: 'listing-unreadable' })
  assert.deepEqual(previousExit([], null), { known: false, reason: 'own-process-unknown' })
  assert.equal(lastExitNotice(null), null)
  assert.equal(lastExitNotice({ agents: 'builder' }), null)
  assert.match(lastExitNotice({ agents: ['a', 'b', 'c', 'd', 'e'] }).body, /^.*a, b, c and 2 more were in the middle of a turn/)
  assert.match(lastExitNotice({ agents: ['a', 'b'] }).body, /a and b were in the middle of a turn.*send them a message/)
})

/* A SOURCE PIN, AND ONLY THAT. Everything above drives the module; none of it
   can see whether the entry point mounts it, which is this codebase's most
   repeated near miss. tools/test/main.test.mjs proves the entry point still
   mounts the settings sentence through this source; this pins that the source
   is the one that carries the exit sentence. It is text, not behaviour. */
test('the entry point mounts the window notice THROUGH this source, with the machine ids', () => {
  const main = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8')
  assert.match(main, /mountSettingsRecoveryNotice\(\{\s*source:\s*lastExitNoticeSource\(\{\s*computerIds:/)
  assert.doesNotMatch(main, /mountSettingsRecoveryNotice\(\)/, 'a bare mount would leave the exit sentence unreachable')
  assert.match(main, /import \{ lastExitNoticeSource \} from '\.\/last-exit-notice\.js'/)
})

/* THE BAR MUST NOT LAND ON THE RAIL (hand test 2026-09-21, 1440x900, 1280x800
   and 1000x700: the bar's centre-of-viewport placement covered Quick settings,
   Guide and the Back/Forward pair until Dismiss was pressed; clear only from
   ~1750px up). The bar's placement was written when navigation was a strip at
   the top; the product now opens with body[data-navigation="side"], a fixed
   rail whose footer holds those controls at the bottom-left corner.
   This resolves the declared geometry -- the same cascade the browser applies,
   by specificity: base, side rule, open-drawer rule, side open-drawer rule --
   and asserts the painted left edge is never inside the rail and the right edge
   never past the window or under the open drawer. It is arithmetic on the
   style sheets' own expressions, not a layout engine; the rig measurement in
   the kit is the proof that a browser agrees. */
test('the window notice bar keeps clear of the side navigation, drawer open or closed', () => {
  const sheet = name => readFileSync(fileURLToPath(new URL('../../src/' + name, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const base = sheet('styles.css'), side = sheet('app-navigation.css')
  const declarations = (css, selector) => {
    const found = {}
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    for (const match of css.matchAll(new RegExp('(?:^|\\})\\s*' + escaped + '\\s*\\{([^}]*)\\}', 'g'))) {
      for (const line of match[1].split(';')) { const at = line.indexOf(':'); if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim() }
    }
    return found
  }
  const tokens = name => Number((base.match(new RegExp(name + ':\\s*(\\d+)px')) || [])[1])
  const pageMax = tokens('--page-max'), gutter = tokens('--page-gutter')
  assert.ok(pageMax > 0 && gutter > 0, 'the page tokens this bar is sized from are readable')
  const px = (expression, vars, whole) => {
    const js = expression.replace(/var\((--[\w-]+)\)/g, (_, name) => { assert.ok(name in vars, `${name} is a token this test knows`); return String(vars[name]) })
      .replace(/(\d+(?:\.\d+)?)%/g, (_, n) => `(${whole}*${n}/100)`).replace(/(\d+(?:\.\d+)?)px/g, '$1')
      .replace(/\bcalc\(/g, '(').replace(/\bmin\(/g, 'Math.min(')
    assert.match(js, /^[\d\s.+\-*/(),]*(?:Math\.min[\d\s.+\-*/(),]*)*$/, `only arithmetic is evaluated: ${js}`)
    return Function(`"use strict"; return (${js})`)()
  }
  const closedRules = [declarations(base, '.settings-recovery'), declarations(side, 'body[data-navigation="side"] .settings-recovery')]
  const openRules = [...closedRules, declarations(base, '.drawer.open ~ .settings-recovery'), declarations(side, 'body[data-navigation="side"] .drawer.open ~ .settings-recovery')]
  const painted = (rules, viewport, rail) => {
    const style = Object.assign({}, ...rules), vars = { '--navigation-width': rail, '--page-max': pageMax, '--page-gutter': gutter }
    const left = px(style.left, vars, viewport)
    const width = style.width === 'auto' ? viewport - left - px(style.right, vars, viewport) : px(style.width, vars, viewport)
    const shift = /translateX\(-50%\)/.test(style.transform || '') ? width / 2 : 0
    return { left: left - shift, right: left - shift + width, width }
  }
  /* The rail is 232px, 56px collapsed, and 56px by media query at 1100px and under. */
  for (const [viewport, rail] of [[1000, 56], [1100, 56], [1101, 232], [1280, 232], [1440, 232], [1440, 56], [1920, 232], [2560, 232]]) {
    const closed = painted(closedRules, viewport, rail)
    assert.ok(closed.left >= rail, `closed drawer, ${viewport}px window, ${rail}px rail: the bar starts at ${closed.left}px, inside the rail`)
    assert.ok(closed.right <= viewport, `closed drawer, ${viewport}px window: the bar ends at ${closed.right}px, past the window`)
    const open = painted(openRules, viewport, rail)
    assert.ok(open.left >= rail, `open drawer, ${viewport}px window, ${rail}px rail: the bar starts at ${open.left}px, inside the rail`)
    assert.ok(open.right <= viewport - 346, `open drawer, ${viewport}px window: the bar ends at ${open.right}px, under the drawer`)
    assert.ok(open.width >= 300, `open drawer, ${viewport}px window: ${open.width}px is too narrow to read`)
  }
})
