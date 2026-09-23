/* AGENTS AT A GLANCE — the pure half, called with values. Owner, 2026-09-19:
 * "the contents inside need to have more useful, easy, on demand info."
 *
 * For the panel's scope: what each agent is doing right now and since when,
 * what is waiting on the owner, the last result per agent, grouped by tree.
 * src/home-activity.js agentBoardLines takes the rows the panel already holds
 * (read off the painted run rows, nothing new is fetched) and the picker's
 * groups, and hands back plain lines the view draws.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentBoardLines, treePickGroups, agentMonogram, AGENT_BOARD } from '../../src/home-activity.js'

const NOW = 1_700_000_000_000
const min = n => n * 60_000
const CONTROL = { id: 't-ctl', name: 'Control lane', active: true, tipKey: 'ctl', memberKeys: ['ctl', 'w1'] }
const DELIVERY = { id: 't-del', name: 'Delivery lane', active: false, tipKey: 'del', memberKeys: ['del'] }
const TREES = [CONTROL, DELIVERY]
/* Newest first, as the panel holds them. */
const ROWS = [
  { agentKey: 'w1', agentName: 'worker one', working: true, status: 'working', statusLabel: 'Working', doing: 'running Bash', when: 'just now', atMs: NOW - min(2), brief: 'write the status to durable storage', asked: 'Asked: write the status to durable storage', answer: '', why: '', gap: '' },
  { agentKey: 'ctl', agentName: 'controller', working: false, status: 'attention', statusLabel: 'Did not start', doing: '', when: '4 minutes ago', atMs: NOW - min(4), brief: 'claim the next phase', asked: 'Asked: claim the next phase', answer: '', why: 'No account was free.', gap: '' },
  { agentKey: 'ctl', agentName: 'controller', working: false, status: 'finished', statusLabel: 'Finished', doing: '', when: '14 minutes ago', atMs: NOW - min(14), brief: 'claim the next phase', asked: 'Asked: claim the next phase', answer: 'Phase claimed; evidence posted.', why: '', gap: '' },
  { agentKey: 'del', agentName: 'deliverer', working: false, status: 'finished', statusLabel: 'Finished', doing: '', when: '52 minutes ago', atMs: NOW - min(52), brief: 're-review the evidence tree', asked: 'Asked: re-review the evidence tree', answer: 'Verdict posted.', why: '', gap: '' },
  { agentKey: 'orphan', agentName: 'orphan run', working: false, status: 'other', statusLabel: 'Started', doing: '', when: '2 hours ago', atMs: NOW - min(120), brief: '', asked: '', answer: '', why: '', gap: 'No answer was saved for it.' },
]
/* foldAbove 0: this fixture is four agents, which the board now shows whole (a
   small fleet is not folded); the fold pins below are about the fold itself. */
const board = (rows = ROWS, trees = TREES, options = {}) => agentBoardLines(rows, treePickGroups(rows, trees), { nowMs: NOW, foldAbove: 0, ...options })

test('one line per agent, grouped the way the picker groups them, tip first', () => {
  const b = board()
  assert.deepEqual(b.groups.map(group => group.heading), ['Control lane · 2 agents, 1 working', 'Delivery lane · 1 agent', 'Not in a tree'])
  assert.deepEqual(b.groups[0].lines.map(line => line.key), ['ctl', 'w1'])
  assert.deepEqual(b.groups.flatMap(group => [...group.lines, ...group.rest]).map(line => line.key), ['ctl', 'w1', 'del', 'orphan'])
  assert.equal(b.working, 1)
  assert.equal(b.attention, 1)
})

test('working and attention stay on the glass; finished and idle fold into one line per group', () => {
  const b = board()
  assert.deepEqual(b.groups[0].lines.map(line => line.key), ['ctl', 'w1'], 'attention and working are lines')
  assert.deepEqual(b.groups[0].rest, [])
  assert.deepEqual(b.groups[1].lines, [], 'a finished agent is not a line')
  assert.deepEqual(b.groups[1].rest.map(line => line.key), ['del'])
  assert.equal(b.groups[1].restLabel, '1 finished')
  assert.equal(b.groups[1].restNames, 'deliverer')
  assert.equal(b.groups[2].restLabel, '1 finished or idle', 'an idle run never recorded an outcome, so the fold does not call it finished')
  const all = board(ROWS, TREES, { showAll: true })
  assert.deepEqual(all.groups[1].lines.map(line => line.key), ['del'], 'showAll puts every agent on the glass')
  assert.deepEqual(all.groups[1].rest, [])
})

test('a working agent says what it is doing and since when', () => {
  const [ctl, w1] = board().groups[0].lines
  assert.equal(w1.state, 'working')
  assert.equal(w1.now, 'Working · running Bash')
  assert.equal(w1.since, '2 minutes ago')
  assert.equal(ctl.state, 'attention', 'the newest run wants somebody, so the agent does')
})

test('an agent that is not working shows its last result and when', () => {
  const [del] = board().groups[1].rest
  assert.equal(del.state, 'finished')
  assert.equal(del.now, 'Finished · re-review the evidence tree')
  assert.equal(del.since, '52 minutes ago')
  assert.equal(del.result, 'Verdict posted.')
  assert.equal(del.asked, '', 'the ask is the head line already, so the fold does not repeat it')
  assert.equal(del.runs, 1)
})

test('what is waiting on the owner is said on the line, with the reason', () => {
  const [ctl] = board().groups[0].lines
  assert.equal(ctl.waiting, 'Did not start', 'the reason is the last result already, so the waiting row does not repeat it')
  assert.equal(ctl.result, 'No account was free.', 'the last result is the refusal, not the older success')
  assert.equal(ctl.runs, 2)
  const [w1] = board().groups[0].lines.slice(1)
  assert.equal(w1.waiting, '')
})

test('a run that saved nothing says so as its result rather than going blank', () => {
  const [orphan] = board().groups[2].rest
  assert.equal(orphan.now, 'Started')
  assert.equal(orphan.result, 'No answer was saved for it.')
})

test('the scope predicate keeps only the agents the panel is showing', () => {
  const b = board(ROWS, TREES, { keep: row => row.agentKey === 'ctl' || row.agentKey === 'w1' })
  assert.deepEqual(b.groups.map(group => group.heading), ['Control lane · 2 agents, 1 working'])
  assert.deepEqual(b.groups[0].lines.map(line => line.key), ['ctl', 'w1'])
})

test('an agent with no run in this view is not a line, but a live one the store reports is', () => {
  const b = board(ROWS, [{ ...CONTROL, memberKeys: ['ctl', 'w1', 'ghost'] }, DELIVERY])
  assert.deepEqual(b.groups[0].lines.map(line => line.key), ['ctl', 'w1'], 'ghost has nothing to show')
  const live = board(ROWS, [{ ...CONTROL, memberKeys: ['ctl', 'w1', 'ghost'], liveKeys: ['ghost'] }, DELIVERY])
  const ghost = live.groups[0].lines.find(line => line.key === 'ghost')
  assert.ok(ghost, 'a node the store says is running is on the board before its row lands')
  assert.equal(ghost.now, AGENT_BOARD.working(''))
  assert.equal(ghost.since, '')
})

test('the summary reads in the words the page already uses', () => {
  assert.equal(AGENT_BOARD.summary(1, 1), '1 working · 1 needs attention')
  assert.equal(AGENT_BOARD.summary(2, 3), '2 working · 3 need attention')
  assert.equal(AGENT_BOARD.summary(0, 0), 'nothing working')
})

test('nothing in scope means no groups and nothing counted', () => {
  const b = board([], [])
  assert.deepEqual(b.groups, [])
  assert.equal(b.working + b.attention, 0)
})

/* T1375. With activity auditing off (the default) there are no run records, and
   Home listed every saved agent as "Idle" while Computers drew the same circles
   as finished, stopped by you and not started yet. The seed is the hunter's
   saved tree (Manager finished, Builder stopped by the person, Builder 2 never
   started) plus a circle whose last turn failed. */
const SAVED_TREE = {
  id: 'c:tree-seed-1', name: 'Seed tree', active: false, tipKey: 'n1', memberKeys: ['n1', 'n2', 'n3', 'n4'],
  memberNames: { n1: 'Manager', n2: 'Builder', n3: 'Builder 2', n4: 'Fixer' },
  memberSaved: {
    n1: { status: 'finished', message: 'Plan the export fix.', reply: 'Plan done. The builder has the layout.', note: '' },
    n2: { status: 'interrupted', message: 'Wrap long account names.', reply: 'Halfway: the table wraps.', note: 'Stopped by you.' },
    n3: { status: 'draft', message: '', reply: '', note: '' },
    n4: { status: 'turn-failed', message: 'Fix the totals row.', reply: '', note: 'The last turn failed: This Codex account has reached its usage limit.' },
  },
}

test('with no run record, each saved agent reads the status, ask and answer its tree saved, in the words Computers uses', () => {
  const b = agentBoardLines([], treePickGroups([], [SAVED_TREE]), { nowMs: NOW, showAll: true })
  const lines = Object.fromEntries(b.groups[0].lines.map(line => [line.name, line]))
  assert.deepEqual(Object.values(lines).map(line => [line.name, line.word]),
    [['Manager', 'Finished'], ['Builder', 'Stopped by you'], ['Builder 2', 'Not started yet'], ['Fixer', 'Needs you']])
  assert.equal(lines.Manager.state, 'finished')
  assert.equal(lines.Manager.task, 'Plan the export fix.')
  assert.equal(lines.Manager.result, 'Plan done. The builder has the layout.')
  assert.equal(lines.Builder.state, 'idle')
  assert.equal(lines.Builder.result, 'Halfway: the table wraps.')
  assert.equal(lines['Builder 2'].state, 'idle')
  assert.equal(lines.Fixer.state, 'attention')
  assert.match(lines.Fixer.now, /^The last turn failed/)
  assert.match(lines.Fixer.result, /usage limit/)
  assert.equal(b.working, 0)
  assert.equal(b.attention, 1, 'a failed turn needs the person, as a failed run does')
})

test('the status filter sorts saved agents by the status their tree saved', async () => {
  const { filterRosterGroups } = await import('../../src/home-roster-filter.js')
  const b = agentBoardLines([], treePickGroups([], [SAVED_TREE]), { nowMs: NOW, showAll: true })
  const names = status => filterRosterGroups(b.groups, { status }).groups.flatMap(group => [...group.lines, ...group.rest]).map(line => line.name)
  assert.deepEqual(names('finished'), ['Manager'])
  assert.deepEqual(names('idle'), ['Builder', 'Builder 2'])
  assert.deepEqual(names('attention'), ['Fixer'])
  assert.deepEqual(names('working'), [])
})

test('a run record and a live session still outrank the saved status', () => {
  const rows = [{ agentKey: 'n2', agentName: 'Builder', working: false, status: 'finished', statusLabel: 'Finished', doing: '', when: '1 minute ago', atMs: NOW - min(1), brief: 'Wrap long account names.', asked: '', answer: 'Done.', why: '', gap: '' }]
  const b = agentBoardLines(rows, treePickGroups(rows, [{ ...SAVED_TREE, liveKeys: ['n3'] }]), { nowMs: NOW, showAll: true })
  const lines = Object.fromEntries(b.groups[0].lines.map(line => [line.name, line]))
  assert.equal(lines.Builder.word, 'Finished', 'the run record wins')
  assert.equal(lines.Builder.result, 'Done.')
  assert.equal(lines['Builder 2'].word, 'Working', 'a live member is working')
  assert.equal(lines.Manager.word, 'Finished')
})

test("the view's tree records carry what the tree saved for each member", async () => {
  /* The REAL treeFilterRecords out of src/views/home.js, over a real fleet tree
     store holding the saved tree, so the board gets these facts from the app's
     own reading rather than from a fixture. */
  const vm = await import('node:vm')
  const { readFileSync } = await import('node:fs')
  const { declaredFunctionSource } = await import('./lib/declared-function-source.mjs')
  const trees = await import('../../src/fleet-trees.js')
  const { ROLES } = await import('../../src/vocab.js')
  const source = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
  const memory = new Map()
  const storage = { getItem: key => memory.has(key) ? memory.get(key) : null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key), get length() { return memory.size }, key: i => [...memory.keys()][i] ?? null }
  const iso = ms => new Date(ms).toISOString()
  memory.set(trees.fleetTreesStorageKey('this-computer'), JSON.stringify({ version: 1, computerId: 'this-computer',
    trees: [{ id: 'tree-seed-1', name: null, createdAt: iso(NOW), updatedAt: iso(NOW) }],
    nodes: [
      { id: 'n1', treeId: 'tree-seed-1', parentId: null, role: 'manager', nameOrdinal: 1, message: 'Plan the export fix.', status: 'finished', statusNote: '', reply: 'Plan done.', sessionId: 's1', tier: '', effort: '', createdAt: iso(NOW), updatedAt: iso(NOW) },
      { id: 'n2', treeId: 'tree-seed-1', parentId: 'n1', role: 'builder', nameOrdinal: 1, message: 'Wrap long account names.', status: 'interrupted', statusNote: 'Stopped by you.', reply: 'Halfway', sessionId: 's2', tier: '', effort: '', createdAt: iso(NOW), updatedAt: iso(NOW) },
      { id: 'n3', treeId: 'tree-seed-1', parentId: 'n1', role: 'builder', nameOrdinal: 2, message: '', status: 'draft', statusNote: '', reply: '', sessionId: null, tier: '', effort: '', createdAt: iso(NOW), updatedAt: iso(NOW) },
    ] }))
  const context = vm.createContext({
    sample: false, window: { localStorage: storage }, FLEET: { machines: [{ id: 'this-computer' }] }, conversations: new Map(),
    createFleetTreeStore: trees.createFleetTreeStore, safeTreeStorage: trees.safeTreeStorage, nodeDisplayName: trees.nodeDisplayName,
    treeStatus: trees.treeStatus, treeDisplayName: trees.displayName, ROLES, Object, Map, Set, Array,
  })
  const records = vm.runInContext(`${declaredFunctionSource(source, 'treeFilterRecords')}; treeFilterRecords()`, context)
  assert.equal(records.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(records[0].memberSaved)), {
    n1: { status: 'finished', message: 'Plan the export fix.', reply: 'Plan done.', note: '' },
    n2: { status: 'interrupted', message: 'Wrap long account names.', reply: 'Halfway', note: 'Stopped by you.' },
    n3: { status: 'draft', message: '', reply: '', note: '' },
  })
  const b = agentBoardLines([], treePickGroups([], records), { nowMs: NOW, showAll: true })
  assert.deepEqual(b.groups[0].lines.map(line => line.word), ['Finished', 'Stopped by you', 'Not started yet'])
})

// T1514: two agents set with the default role are named 'Agent (f885ad47)'
// and 'Agent (250d6913)'; their monograms read 'A(' because only spaces,
// underscores and hyphens split the name.
test('a monogram is letters and digits only, also for names with a bracketed suffix', () => {
  assert.equal(agentMonogram('Agent (f885ad47)'), 'AF')
  assert.equal(agentMonogram('Agent (250d6913)'), 'A2')
  assert.equal(agentMonogram('worker one'), 'WO')
  assert.equal(agentMonogram('gem-lane-2'), 'GL')
  assert.equal(agentMonogram('terra_01'), 'T0')
  assert.equal(agentMonogram('codex'), 'CO')
  assert.equal(agentMonogram('(draft)'), 'DR')
  assert.equal(agentMonogram('Écrivain «deux»'), 'ÉD')
  assert.equal(agentMonogram(''), '?')
  assert.equal(agentMonogram('()'), '?')
  for (const name of ['Agent (f885ad47)', 'a.b', '#1 builder', 'x — y']) assert.match(agentMonogram(name), /^[\p{L}\p{N}]{1,2}$/u, name)
})
