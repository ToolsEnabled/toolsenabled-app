/* The agents on this page, laid out so that they CANNOT collide.
 *
 * ------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY REPLACING IT WAS THE FIX
 * ------------------------------------------------------------------
 * The drill-in used to draw its agents as a force/tree-simulated bubble graph
 * (FleetGraph) with a separate floating "context box" per agent, positioned by a
 * ~400-line band solver in views/agent.js. The owner's screenshot shows what that
 * produced: `16:27:58 RUNTIME` printed over `COORDINATOR'S HELPER`, `11:45:26`
 * over `SHADOW MANAGER`, `0:00:34` over `terra-01 MANAGER` -- names unreadable --
 * and the three activity lines floating above the graph with no visual tie to the
 * bubble they described.
 *
 * That was not a tuning failure. Read the history in agent.css and agent.js: a
 * ring sweep, then an exhaustive grid, then closed-form lane runs, then a
 * whole-strip DFS minimising total leader length, then a density policy that
 * RETIRES boxes it cannot place, then a hairline leader per box to answer the
 * "which box is whose" question the layout itself had created. Every round was
 * competent and every round was solving the same self-inflicted problem: text was
 * being positioned ABSOLUTELY, in a coordinate space where nothing prevents two
 * things occupying one point, so every overlap had to be discovered and repaired
 * at runtime. A solver that has to withhold a box (measured: 3 of 5 shown at 1280
 * and 1440) is a layout admitting it does not fit.
 *
 * So the geometry is gone, not tuned. Every agent is one CARD, and every fact
 * about that agent -- name, role, how long it has run, what it is doing -- is a
 * row INSIDE that card, in normal flow, inside a CSS grid cell. Two pieces of
 * text cannot overlap because no piece of text is positioned; the grid gives each
 * card a box and the card stacks its rows. There is no solver, no leader line, no
 * withheld box and no per-frame placement pass, because there is nothing left to
 * decide. Collision-avoidance stopped being a feature and became a property.
 *
 * THE "WHICH AGENT IS DOING WHAT" QUESTION ANSWERS ITSELF for the same reason.
 * The activity line is not near its agent, it is IN its agent's card, under its
 * name. That was the entire purpose of the leader lines, and containment does it
 * without drawing anything.
 *
 * ------------------------------------------------------------------
 * WHAT IS KEPT
 * ------------------------------------------------------------------
 * The house visual identity is not the physics -- it is the round role dial, the
 * monitor braces, the tan/cream sheet and the mono readouts, and all of it stays.
 * The dial keeps its role colour and its minute sweep. What it no longer does is
 * carry TEXT inside a circle: `16:27:58` was set inside a disc whose width shrinks
 * as the layout tightens, which is why it ended up on top of its neighbour's role
 * label. The duration moved to a full-width row of its own, which is also what
 * makes it readable in one glance -- the metric is obvious through LAYOUT rather
 * than through being centred in the most decorative element on the page.
 *
 * FleetGraph is imported by exactly one view (this page), so retiring it here
 * costs no other screen. The computers page draws its own StaticTreeGraph and is
 * untouched.
 */

import { el } from './components.js'
import { roleAppearance } from './vocab.js'
import { paintRoleColor } from './role-colors.js'
import { durationLabel, durationSpoken, runtimePhrase, NO_RUNTIME } from './runtime-duration.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

/* The activity feed's own convention, copied from graph.js formatFeed() rather
   than re-decided: the LAST row is what the agent is doing now and the one
   before it is what it just finished. Two readings of one array is how the page
   ends up saying an agent is doing something it stopped doing. */
export function activityOf(agent) {
  const rows = Array.isArray(agent?.context) ? agent.context : []
  const clean = value => (value == null ? '' : String(value).replace(/\s+/g, ' ').trim())
  return { current: clean(rows.at(-1)), previous: clean(rows.at(-2)) }
}

/** Elapsed milliseconds and whether the clock is still moving, from the same
 *  fields the view's liveAgentRuntimeSource() validates. Returns null when this
 *  page was given no epoch -- which the card states, rather than showing `0s`. */
export function runtimeOf(agent, observedAt = Date.now()) {
  const bornAt = Number.isFinite(agent?.bornAt) ? agent.bornAt : null
  if (bornAt === null) return null
  const stoppedAt = Number.isFinite(agent?.stoppedAt) ? agent.stoppedAt : null
  return { elapsedMs: Math.max(0, (stoppedAt ?? observedAt) - bornAt), running: stoppedAt === null }
}

/* The dial: a role-coloured ring whose sweep is the fraction of the current
   minute, so a running agent visibly ticks. Decorative and labelled as such --
   the duration beside it is the fact, and this is the texture. A stopped agent's
   sweep is parked rather than frozen mid-arc, so "not moving" reads as a state
   and not as a stalled render. */
function buildDial(role, { running }) {
  const wrap = document.createElement('div')
  wrap.className = 'ar-dial'
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(SVG_NS, 'circle')
  track.setAttribute('class', 'ar-dial-track')
  for (const [k, v] of [['cx', 24], ['cy', 24], ['r', 20], ['fill', 'none']]) track.setAttribute(k, v)
  const sweep = document.createElementNS(SVG_NS, 'circle')
  sweep.setAttribute('class', 'ar-dial-sweep')
  for (const [k, v] of [['cx', 24], ['cy', 24], ['r', 20], ['fill', 'none']]) sweep.setAttribute(k, v)
  sweep.style.stroke = 'var(--rc)' // the card's own accent (paintRoleColor)
  svg.append(track, sweep)
  wrap.appendChild(svg)
  wrap.dataset.running = running ? 'true' : 'false'
  return { el: wrap, sweep }
}

const CIRCUMFERENCE = 2 * Math.PI * 20

/**
 * Build the roster.
 *
 * `onSelect` is given an agent id when a card is activated. The card is a real
 * <button>, not a div with a click handler: this is the page's only way to move
 * between agents, and the previous one -- a DOUBLE-CLICK on a simulated bubble --
 * was reachable by mouse only, announced to no screen reader, and discoverable by
 * nobody. A button is focusable, has a name, and works from the keyboard for free.
 */
/* WHICH OF THE PERSON'S OWN SIGN-INS AN AGENT IS SPENDING.
 *
 * THE DEFECT THIS CLOSES. A card said what its agent was, what role it had, how
 * long it had run and what it was doing, and never whose account was paying for
 * it. On a computer with six sign-ins that is the one fact a person cannot work
 * out from anywhere else on the screen, and six agents all on one spent account
 * drew exactly like six agents spread across six.
 *
 * `accounts` is what the shell answered for the running sessions
 * (mc-agent:session-accounts), keyed here by the declared agent the session was
 * started for. A card with no entry SAYS NOTHING rather than "unknown": most
 * agents on most computers are not running, and a computer with one sign-in has
 * no account question at all -- a row reading "unknown" on every card would
 * turn "there was nothing to choose" into "nobody knows what it chose", which
 * is the confusion between an absence and a failure this codebase refuses
 * everywhere else.
 *
 * THE ONE CASE THAT IS A FAILURE IS SAID ONCE, NOT PER CARD. When the shell
 * could not be asked at all, that is a fact about the computer rather than
 * about any agent on it, and the view says it above the roster. Twenty copies
 * of one caveat is not twenty times as honest. */
/* AND WHETHER THAT SIGN-IN HAS RUN OUT.
 *
 * THE SECOND HALF OF THE SAME DEFECT. The name alone answers "whose allowance
 * is this spending" and not "is there any of it left", which is the question a
 * person opens this page with when work has slowed down. The engine works it
 * out -- handoverReport(), off the last allowance check the person ran -- and
 * until now the answer stopped at the shell: it was built on every read of this
 * page and dropped, so the one screen naming the accounts was the one screen
 * that could not say which of them were spent.
 *
 * IT SAYS SO AND MOVES NOTHING, and on this CLI nothing could: a session keeps
 * the account it started on for the life of its program (measured 2026-09-03,
 * stated at the top of the engine's handover.js). So the card carries a fact
 * and never a control -- there is no button here, and the sentence says where
 * a NEW session would start rather than promising this one will go there.
 *
 * `spent` IS SET ONLY WHERE THE REPORT REACHED A VERDICT. A session on an
 * account nobody read is not marked: "the check has not run" and "this account
 * is fine" are different answers, and marking the first as either is the merge
 * the report exists to prevent. */
function accountEntryFor(accounts, agentId) {
  if (!accounts || typeof agentId !== 'string' || agentId === '') return null
  const entry = accounts instanceof Map ? accounts.get(agentId) : accounts[agentId]
  if (!entry) return null
  const name = typeof entry === 'string' ? entry : entry.account
  if (typeof name !== 'string' || name === '') return null
  const row = typeof entry === 'object' ? entry : null
  return {
    name,
    spent: row?.spent === true,
    to: row && typeof row.to === 'string' && row.to !== '' ? row.to : null,
    why: row && typeof row.why === 'string' && row.why !== '' ? row.why : null,
  }
}

const SPENT_MARK = 'at its limit'
const KEEPS_ITS_ACCOUNT = 'This session keeps the account it started on.'

/* WHY THE SENTENCE IS DIFFERENT IN THE THREE CASES. Somewhere to go, nowhere to
   go because everything else is spent too, and nowhere to go because nothing
   else has been checked are three different next steps for the person: wait for
   this one to reset, raise a limit, or run the check again. One sentence
   covering all three would be true and useless. Every one of them ends by
   saying this session is not going anywhere, because the row it sits in reads
   like a control otherwise. */
function spentSentence(entry) {
  if (entry.to) return `${entry.name} has reached a limit. A new session would start on ${entry.to}. ${KEEPS_ITS_ACCOUNT}`
  if (entry.why === 'HANDOVER_HELD_NOTHING_MEASURED') {
    return `${entry.name} has reached a limit, and no other account has been checked. ${KEEPS_ITS_ACCOUNT}`
  }
  if (entry.why === 'HANDOVER_HELD_NO_TARGET') {
    return `${entry.name} has reached a limit, and no other account is free to take the work. ${KEEPS_ITS_ACCOUNT}`
  }
  return `${entry.name} has reached a limit. ${KEEPS_ITS_ACCOUNT}`
}

export function buildAgentRoster({ agents = [], selectedId = null, onSelect = () => {}, accounts = null, example = false } = {}) {
  const root = el(`<div class="agent-roster" role="list"></div>`)
  const cards = []
  // Sample epochs illustrate a duration, not an actual running session.
  // Keep them still and label them at the card, not only in a page banner.
  const exampleObservedAt = example === true ? Date.now() : null

  for (const agent of agents) {
    const role = roleAppearance(agent.declaredRole || agent.role)
    const runtime = runtimeOf(agent)
    const activity = activityOf(agent)
    const selected = agent.id === selectedId

    const card = el(`<button type="button" class="ar-card" role="listitem"></button>`)
    card.dataset.agentId = agent.id
    card.dataset.role = agent.role
    paintRoleColor(card, agent.declaredRole || agent.role, agent.id)
    card.style.setProperty('--rg', role.glowColor)
    if (selected) card.classList.add('is-selected')
    if (runtime && !runtime.running) card.classList.add('is-stopped')

    const dial = buildDial(role, { running: exampleObservedAt === null && Boolean(runtime?.running) })

    /* THE HEAD ROW: dial, then name and role stacked beside it. `min-width: 0`
       on the text column (agent.css) is what lets a long name ellipsis instead
       of pushing the card wider than its grid track -- the flexbox default is
       `min-width: auto`, which refuses to shrink below the longest word and is
       how a grid layout starts overflowing its own columns. */
    const head = el(`<span class="ar-head"></span>`)
    const text = el(`<span class="ar-text"></span>`)
    const name = el(`<span class="ar-name"></span>`)
    name.textContent = agent.name
    name.title = agent.name
    const roleRow = el(`<span class="ar-role"></span>`)
    roleRow.textContent = role.label
    text.append(name, roleRow)
    head.append(dial.el, text)

    /* THE RUNTIME ROW, and the reason it is a row. It used to be centred inside
       the dial, where its available width is the disc's chord and shrinks with
       every layout tightening. Here it owns the card's full width, so it never
       competes with anything for space, and it carries its own units so it
       cannot be read as a time of day. */
    const runtimeRow = el(`<span class="ar-runtime"></span>`)
    const runtimeValue = el(`<span class="ar-runtime-value"></span>`)
    const runtimeNote = el(`<span class="ar-runtime-note"></span>`)
    runtimeRow.append(runtimeValue, runtimeNote)

    /* THE STATUS ROW -- the thing that used to float unanchored above the graph.
       It is inside its own agent's card, so which agent is doing what needs no
       leader line and no inference. Clamped to two lines in CSS so one long
       sentence cannot make one card taller than its neighbours. */
    const status = el(`<span class="ar-status"></span>`)
    const statusCurrent = el(`<span class="ar-status-current"></span>`)
    status.appendChild(statusCurrent)
    if (activity.previous) {
      const previous = el(`<span class="ar-status-previous"></span>`)
      previous.textContent = activity.previous
      status.appendChild(previous)
    }

    /* THE ACCOUNT ROW, and only when there is one to draw. It is a row of the
       card in normal flow like every other fact here, so it cannot collide with
       anything and needs no space reserved when it is absent. */
    const account = accountEntryFor(accounts, agent.id)
    if (account) {
      const accountRow = el(`<span class="ar-account"></span>`)
      const accountName = el(`<span class="ar-account-name"></span>`)
      accountName.textContent = account.name
      accountName.title = account.name
      accountRow.append(el(`<span class="ar-account-label">account</span>`), accountName)
      if (account.spent) {
        /* The words carry it, not the colour: the mark reads the same to
           somebody who cannot tell this row's red from its neighbour's grey. */
        const spent = el(`<span class="ar-account-spent"></span>`)
        spent.textContent = SPENT_MARK
        spent.title = spentSentence(account)
        accountRow.appendChild(spent)
        accountRow.dataset.spent = 'true'
      }
      card.append(head, runtimeRow, accountRow, status)
    } else {
      card.append(head, runtimeRow, status)
    }
    card.addEventListener('click', () => onSelect(agent.id))
    root.appendChild(card)

    cards.push({ agent, card, dial, runtimeValue, runtimeNote, statusCurrent, name, roleLabel: role.label, account })
  }

  /** Repaint the moving parts. Called on a one-second interval by the view --
   *  a second is the resolution the smallest unit shown actually changes at, so
   *  a faster tick would write identical text. Every write is guarded by a
   *  compare, so a settled roster performs no DOM mutation at all. */
  function update(now = Date.now()) {
    for (const entry of cards) {
      const runtime = runtimeOf(entry.agent, exampleObservedAt ?? now)
      const phrase = runtime ? runtimePhrase({ elapsedMs: runtime.elapsedMs, running: runtime.running }) : null
      const value = runtime ? durationLabel(runtime.elapsedMs) : null

      if (value === null) {
        if (entry.runtimeValue.textContent !== NO_RUNTIME) {
          entry.runtimeValue.textContent = NO_RUNTIME
          entry.runtimeValue.classList.add('is-absent')
          entry.runtimeNote.textContent = ''
        }
      } else {
        if (entry.runtimeValue.textContent !== value) entry.runtimeValue.textContent = value
        entry.runtimeValue.classList.remove('is-absent')
        /* The verb, not a colour, carries whether this is still moving. */
        const note = exampleObservedAt !== null ? 'example time' : runtime.running ? 'running' : 'stopped'
        if (entry.runtimeNote.textContent !== note) entry.runtimeNote.textContent = note
        entry.card.dataset.runtimeState = exampleObservedAt !== null ? 'example' : note
      }

      /* One accessible name per card carrying every fact in it, so a screen
         reader gets the card as a sentence instead of four unlabelled fragments
         in reading order. */
      const spoken = exampleObservedAt !== null
        ? `example agent, no real session${runtime ? `, example duration ${durationSpoken(runtime.elapsedMs)}` : `, ${NO_RUNTIME}`}`
        : runtime ? `${phrase.startsWith('running') ? 'running for' : 'ran for'} ${durationSpoken(runtime.elapsedMs)}` : NO_RUNTIME
      const activity = activityOf(entry.agent)
      /* The account is IN the accessible name, not only in the visible row. A
         fact a sighted reader gets from the card is a fact a screen reader gets
         from the card, or the card says two different things to two people. */
      const onAccount = entry.account
        ? `, on account ${entry.account.name}${entry.account.spent ? ', which has reached a limit' : ''}`
        : ''
      const label = `${entry.agent.name}, ${entry.roleLabel}${onAccount}, ${spoken}${activity.current ? `. ${activity.current}` : ''}`
      if (entry.card.getAttribute('aria-label') !== label) entry.card.setAttribute('aria-label', label)

      if (entry.statusCurrent.textContent !== activity.current) entry.statusCurrent.textContent = activity.current

      const running = exampleObservedAt === null && Boolean(runtime?.running)
      const frac = running ? (now % 60000) / 60000 : 0
      const drawn = CIRCUMFERENCE * frac
      const dash = `${drawn.toFixed(2)} ${(CIRCUMFERENCE - drawn).toFixed(2)}`
      if (entry.dial.sweep.getAttribute('stroke-dasharray') !== dash) {
        entry.dial.sweep.setAttribute('stroke-dasharray', dash)
      }
      entry.dial.el.dataset.running = running ? 'true' : 'false'
    }
  }

  update()
  return { el: root, update, count: cards.length }
}
