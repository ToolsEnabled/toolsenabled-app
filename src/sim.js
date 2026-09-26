// The living fleet — a simulation that drives every view when a real fleet
// host is not the read source. Nothing here touches a real system.
//
// WHICH machines exist is not this file's decision: hosts, addresses and
// account pools are the operator's own, so they arrive from the fleet profile
// (src/fleet-profile.js). What was here before was one particular two-machine
// fleet, described down to its retirement plan, and every stranger's first run
// showed it to them as if it were theirs.

import { TASKS, FEED, pick } from './vocab.js'
import { FLEET } from './fleet-profile.js'

const now = () => Date.now()
const H = 3600e3, M = 60e3, D = 24 * H

const POOL_MAIN = FLEET.pools[0].id
const POOL_LANE = FLEET.pools[1]?.id || POOL_MAIN

let idSeq = 1
const nid = (p) => `${p}-${String(idSeq++).padStart(2, '0')}`

function mkAgent({ name, role, parentId = null, born, model, pool }) {
  return {
    id: name, name, role, parentId,
    bornAt: born,
    state: 'active',            // 'spawning' | 'active'
    model: model || 'gpt-5.6',
    pool: pool || POOL_MAIN,
    context: [pick(FEED), pick(FEED)],
    tasksDone: Math.floor(40 + Math.random() * 400),
    failRate: +(Math.random() * 7 + 0.4).toFixed(1),
  }
}

function mkComputer({ id, name, short, ip, note, epochOffset }) {
  const born = now() - epochOffset
  const agents = []
  const add = (a) => { agents.push(a); return a }

  const coord = add(mkAgent({ name: id === 'c1' ? 'codex' : 'codex-b', role: 'coordinator', born: born + 2 * M, model: 'gpt-5.6 · 1.0x', pool: POOL_MAIN }))
  const helper = add(mkAgent({ name: id === 'c1' ? 'claude' : 'claude-b', role: 'helper', parentId: coord.id, born: born + 31 * M, model: 'fable-5', pool: POOL_MAIN }))
  const shadow = add(mkAgent({ name: id === 'c1' ? 'shadow-mgr' : 'shadow-b', role: 'shadow', parentId: coord.id, born: born + 47 * M, model: 'gpt-5.6 · 0.5x', pool: POOL_MAIN }))
  const m1 = add(mkAgent({ name: id === 'c1' ? 'terra-01' : 'terra-11', role: 'manager', parentId: coord.id, born: born + 1.2 * H, model: 'gpt-5.6 · 0.5x', pool: POOL_MAIN }))
  const m2 = add(mkAgent({ name: id === 'c1' ? 'luna-02' : 'luna-12', role: 'manager', parentId: coord.id, born: born + 2.4 * H, model: 'gpt-5.6 · 0.2x', pool: POOL_MAIN }))

  const defaults = id === 'c1'
    ? [['gem-lane-1', m1], ['gem-lane-2', m1], ['terra-02', m2], ['gem-lane-3', m2]]
    : [['gem-lane-4', m1], ['gem-lane-5', m1], ['sandbox-w1', m2]]
  for (const [n, parent] of defaults) {
    add(mkAgent({
      name: n, role: 'default', parentId: parent.id,
      born: born + (3 + Math.random() * 9) * H,
      model: n.startsWith('gem') ? 'gemini-3.1-pro' : 'local',
      pool: n.startsWith('gem') ? POOL_LANE : POOL_MAIN,
    }))
  }

  return {
    id, name, short, ip, note,
    bornAt: born,
    agents,
    tasks: Array.from({ length: 6 }, () => mkTask()),
    stats: { cpu: 34, gpu: 18, net: 22, disk: 12 },
    spawnedTotal: 52 + Math.floor(Math.random() * 9),
    helper, coord,
  }
}

function mkTask() {
  const roles = ['coordinator', 'helper', 'shadow', 'manager', 'default', 'default', 'manager']
  return { id: nid('t'), text: pick(TASKS), role: pick(roles), done: Math.random() < 0.35 }
}

/* ------------------------------------------------------------------ */

class Sim {
  constructor() {
    this.serverEpoch = now() - (1 * D + 20 * H + 3 * M + 1000 * 47)   // ≈ the sketch: 1:20:03:xx
    // Addresses are RFC 5737 documentation-reserved (192.0.2.0/24) ON PURPOSE: they can
    // never be a real host. Do NOT "improve" these into a realistic-looking private range
    // like 192.168.x — that ships something that reads as a real machine roster and still
    // passes a grep for the owner's own address, which is the bug this replaced. The rule
    // binds the profile's addresses (src/fleet-profile.js) and the one generated below.
    //
    // The two seeded hosts used to be literals here, and the pair of them —
    // "compatibility host" beside "canonical" — was a description of one real
    // fleet's migration, which is why the roster is now profile data.
    this.computers = FLEET.machines.map(m => mkComputer({
      id: m.id, name: m.name, short: m.short, ip: m.ip, note: m.note,
      epochOffset: Math.max(1, Number(m.ageHours) || 12) * H,
    }))
    this.feed = Array.from({ length: 9 }, () => this.mkFeedLine())
    this.pace = 1
    this.listeners = new Map()
    this._timers = []
    this.metrics = this.mkMetrics()
    this.start()
  }

  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set())
    this.listeners.get(ev).add(fn)
    return () => this.listeners.get(ev)?.delete(fn)
  }
  emit(ev, data) { this.listeners.get(ev)?.forEach(fn => fn(data)) }

  mkFeedLine() {
    const comp = pick(this.computers)
    const ag = pick(comp.agents)
    return { agent: ag.name, text: pick(FEED), at: now() }
  }

  agentOf(compId, agentId) {
    const c = this.computers.find(c => c.id === compId)
    return { computer: c, agent: c?.agents.find(a => a.id === agentId) }
  }

  childrenOf(comp, agentId) { return comp.agents.filter(a => a.parentId === agentId) }

  addComputer() {
    const n = this.computers.length + 1
    const c = mkComputer({
      id: `c${n}`, name: `Computer ${n}`, short: String(n),
      ip: `192.0.2.${n}`, note: 'provisioning',
      epochOffset: 3 * M + Math.random() * 20 * M,
    })
    this.computers.push(c)
    this.emit('computers', this.computers)
    return c
  }

  spawnAgent(comp) {
    const managers = comp.agents.filter(a => a.role === 'manager')
    const parent = managers.length ? pick(managers) : comp.coord
    const kind = Math.random() < 0.6 ? 'gem-lane' : 'worker'
    const a = mkAgent({
      name: nid(kind), role: 'default', parentId: parent.id, born: now(),
      model: kind === 'gem-lane' ? 'gemini-3.1-pro' : 'local',
      pool: kind === 'gem-lane' ? POOL_LANE : POOL_MAIN,
    })
    a.state = 'spawning'
    a.tasksDone = 0
    comp.agents.push(a)
    comp.spawnedTotal += 1
    setTimeout(() => { a.state = 'active'; this.emit('agent-state', { comp, agent: a }) }, 2600)
    this.emit('spawn', { comp, agent: a })
    return a
  }

  /** Re-parent an agent in the org tree. Refuses self, cycles, and unknown ids. */
  reparentAgent(comp, agentId, newParentId) {
    const a = comp.agents.find(x => x.id === agentId)
    const p = comp.agents.find(x => x.id === newParentId)
    if (!a || !p || a.id === p.id || a.parentId === p.id) return false
    if (a.role === 'coordinator') return false        // the root stays the root
    let cur = p                                       // no cycles: new parent must
    while (cur) {                                     // not descend from the agent
      if (cur.id === a.id) return false
      cur = comp.agents.find(x => x.id === cur.parentId)
    }
    a.parentId = p.id
    this.emit('reparent', { comp, agent: a, parent: p })
    return true
  }

  reapAgent(comp) {
    const leaves = comp.agents.filter(a => a.role === 'default' && this.childrenOf(comp, a.id).length === 0)
    if (leaves.length > 5) {
      const a = pick(leaves)
      comp.agents = comp.agents.filter(x => x.id !== a.id)
      this.emit('reap', { comp, agent: a })
    }
  }

  mkMetrics() {
    const hours = Array.from({ length: 24 }, (_, i) => i)
    const wave = (i, base, amp, ph) => Math.max(2, Math.round(base + amp * Math.sin((i - ph) / 3.2) + Math.random() * amp * 0.5))
    return {
      tokensByProvider: {
        codex: hours.map(i => wave(i, 62, 30, 2)),
        claude: hours.map(i => wave(i, 40, 22, 5)),
        gemini: hours.map(i => wave(i, 78, 44, 8)),
        local: hours.map(i => wave(i, 14, 8, 11)),
      },
      /* Lane names are JOIN KEYS, not labels: src/views/metrics.js matches
         each one to a model string in its LANE_MATCH table so that clicking a
         failure bar filters the agent table. Renaming a lane here alone leaves
         the bar clickable and the filter silently matching nothing. */
      failureByLane: [
        { lane: 'gemini worktree', rate: 6.8 }, { lane: 'luna 0.2x', rate: 4.1 },
        { lane: 'terra 0.5x', rate: 2.3 }, { lane: 'codex 1.0x', rate: 1.2 },
        { lane: 'claude', rate: 0.8 }, { lane: 'terra-02 local', rate: 3.4 },
      ],
      verdicts: { accept: 231, reject: 38, retry: 21 },
      heat: Array.from({ length: 7 }, (_, d) =>
        Array.from({ length: 24 }, (_, h) => {
          const work = (h > 7 && h < 23 ? 0.75 : 0.2) + (d < 5 ? 0.2 : 0)
          return Math.min(1, Math.max(0, work * Math.random() + (h > 9 && h < 19 ? 0.25 : 0)))
        })),
      gateBlocks: 12, truncations: 7, modelFloorRefusals: 3, checkpoints: 64,
      /* Balances are the operator's, so they come from the profile. The set
         that was here was a real account's real remaining credit to the cent. */
      spend: { ...FLEET.spend },
    }
  }

  start() {
    const loop = (baseMs, fn) => {
      const tick = () => {
        fn()
        this._timers.push(setTimeout(tick, baseMs / this.pace * (0.6 + Math.random() * 0.8)))
      }
      this._timers.push(setTimeout(tick, baseMs / this.pace * Math.random()))
    }

    // stats random walk
    loop(1400, () => {
      for (const c of this.computers) {
        const s = c.stats
        const step = (v, lo, hi) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.48) * 9))
        s.cpu = step(s.cpu, 6, 96); s.gpu = step(s.gpu, 2, 88)
        s.net = step(s.net, 3, 92); s.disk = step(s.disk, 2, 60)
      }
      this.emit('stats', {})
    })

    // context feed
    loop(2600, () => {
      const line = this.mkFeedLine()
      this.feed.unshift(line)
      this.feed.length = Math.min(this.feed.length, 11)
      this.emit('feed', line)
    })

    // agent context rotation
    loop(4200, () => {
      const comp = pick(this.computers)
      const ag = pick(comp.agents)
      ag.context = [ag.context[1] || pick(FEED), pick(FEED)]
      this.emit('context', { comp, agent: ag })
    })

    // tasks
    loop(5200, () => {
      for (const c of this.computers) {
        if (Math.random() < 0.55) {
          const open = c.tasks.filter(t => !t.done)
          if (open.length) pick(open).done = true
        }
        if (Math.random() < 0.7) c.tasks.unshift(mkTask())
        c.tasks.length = Math.min(c.tasks.length, 8)
      }
      this.emit('tasks', {})
    })

    // spawns / reaps
    loop(11000, () => {
      const comp = pick(this.computers)
      if (comp.agents.length < 16 && Math.random() < 0.8) this.spawnAgent(comp)
      else this.reapAgent(comp)
    })

    // metrics drift
    loop(3800, () => {
      const m = this.metrics
      m.verdicts.accept += Math.random() < 0.6 ? 1 : 0
      if (Math.random() < 0.12) m.verdicts.reject += 1
      if (Math.random() < 0.08) m.verdicts.retry += 1
      if (Math.random() < 0.2) m.checkpoints += 1
      m.spend.creditRemaining = Math.max(0, m.spend.creditRemaining - Math.random() * 0.03)
      for (const lane of m.failureByLane) {
        lane.rate = Math.max(0.2, Math.min(9.9, lane.rate + (Math.random() - 0.5) * 0.3))
      }
      this.emit('metrics', {})
    })
  }

  setPace(p) { this.pace = p }
}

export const sim = new Sim()

/* ---------- formatting helpers ---------- */

export function fmtRuntime(bornAt, stoppedAt = now()) {
  let s = Math.max(0, Math.floor((stoppedAt - bornAt) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const pad = (n) => String(n).padStart(2, '0')
  return d > 0 ? `${d}:${pad(h)}:${pad(m)}:${pad(s)}` : `${h}:${pad(m)}:${pad(s)}`
}

export function uptimeParts(epoch) {
  let s = Math.max(0, Math.floor((now() - epoch) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const pad = (n) => String(n).padStart(2, '0')
  return { d: String(d), h: pad(h), m: pad(m), s: pad(s), frac: ((now() - epoch) % 60000) / 60000 }
}
