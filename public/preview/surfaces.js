/* THE PRODUCT, DRAWN FROM SIMULATED DATA.
 *
 * Six surfaces, chosen because together they are what the product IS rather
 * than what it has: a tree of agents across your computers, an agent you can
 * read, a request you have to answer before anything happens, what it cost, and
 * a record you can check. A stranger who clicks through these six should be
 * able to say what this software does.
 *
 * EVERY DATUM GOES THROUGH simValue(). Every state chip goes through
 * stateChip(), whose vocabulary contains no real state at all. Chrome — the
 * headings, the tab labels, the buttons — is authored text and sits OUTSIDE the
 * data regions, which is precisely the line the audit in honesty.js polices.
 *
 * CONTROLS THAT WOULD ACT ON A REAL FLEET ARE INERT AND SAY WHY. "Stop this
 * agent" cannot stop anything here, so it is disabled and carries its reason.
 * The controls that ARE meaningful in a simulation — choosing an agent,
 * answering a request — really work, and the answer really lands in the record,
 * because a preview where nothing responds teaches a visitor that the product
 * does not respond either.
 */

import { simValue, stateChip, dataRegion, assertUnpaid } from './honesty.js'
import { ROLE_HEX, ROLE_LABEL, PREVIEW_CAPABILITY_IDS } from './sim-data.js'

/* ---------------------------------------------------------------- *
 * small builders
 * ---------------------------------------------------------------- */

export function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

/** label (chrome) + value (simulated, marked). */
function field(label, value) {
  const wrap = el('div', 'pv-field')
  wrap.appendChild(el('span', 'pv-k', label))
  const region = dataRegion({ className: 'pv-v' })
  region.appendChild(simValue(value))
  wrap.appendChild(region)
  return wrap
}

function roleDot(role) {
  const dot = el('span', 'pv-dot')
  dot.style.setProperty('--role', ROLE_HEX[role] || ROLE_HEX.default)
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

/* ---------------------------------------------------------------- *
 * 1. OVERVIEW — what the product is
 * ---------------------------------------------------------------- */

export function overviewSurface(world) {
  const wrap = el('section', 'pv-surface')
  wrap.appendChild(el('h2', 'pv-h', 'What you are looking at'))
  wrap.appendChild(el('p', 'pv-lede',
    'ToolsEnabled is a desktop application that runs AI agents on the computers you already own, '
    + 'and gives you one place to see them, read them, stop them and check what they did. '
    + 'The five tabs beside this one are that application, drawn from invented data.'))

  const grid = el('div', 'pv-cards')
  for (const capability of world.capabilities) {
    const verdict = assertUnpaid(capability.id, PREVIEW_CAPABILITY_IDS)
    const card = el('article', 'pv-card')
    card.dataset.capability = capability.id
    if (!verdict.ok) {
      card.dataset.withheld = 'true'
      card.appendChild(el('h3', 'pv-card-h', 'Withheld from this preview'))
      card.appendChild(el('p', 'pv-card-b', verdict.reason))
    } else {
      card.appendChild(el('h3', 'pv-card-h', capability.title))
      card.appendChild(el('p', 'pv-card-b', capability.body))
    }
    grid.appendChild(card)
  }
  wrap.appendChild(grid)

  const note = el('p', 'pv-note',
    'Paid subscriptions are not open yet. The software itself is complete and free meanwhile, '
    + 'and it does not need a subscription to run.')
  wrap.appendChild(note)
  return wrap
}

/* ---------------------------------------------------------------- *
 * 2. FLEET — the tree
 * ---------------------------------------------------------------- */

export function fleetSurface(world, ui) {
  const wrap = el('section', 'pv-surface')
  wrap.appendChild(el('h2', 'pv-h', 'Your computers, and what is on them'))
  wrap.appendChild(el('p', 'pv-lede',
    'Each computer is a branch. Each agent is a node under the agent that started it. '
    + 'Choose one to open it.'))

  const tree = el('div', 'pv-tree')
  for (const host of world.hosts) {
    const branch = el('div', 'pv-branch')
    const head = dataRegion({ className: 'pv-branch-head' })
    // the host name is itself invented, so it is marked like every other datum
    head.appendChild(simValue(host.name, { className: 'pv-branch-name' }))
    const count = world.agents.filter(a => a.host === host.id).length
    head.appendChild(simValue(`${count} agents`, { className: 'pv-branch-meta' }))
    branch.appendChild(head)

    const roots = world.agents.filter(a => a.host === host.id && a.parent === null)
    const list = el('ul', 'pv-nodes')
    for (const root of roots) list.appendChild(nodeItem(world, root, ui))
    branch.appendChild(list)
    tree.appendChild(branch)
  }
  wrap.appendChild(tree)

  const legend = el('div', 'pv-legend')
  for (const role of Object.keys(ROLE_LABEL)) {
    const chip = el('span', 'pv-legend-chip')
    chip.appendChild(roleDot(role))
    chip.appendChild(el('span', null, ROLE_LABEL[role]))
    legend.appendChild(chip)
  }
  wrap.appendChild(legend)
  return wrap
}

function nodeItem(world, agent, ui) {
  const li = el('li', 'pv-node-item')
  const button = el('button', 'pv-node')
  button.type = 'button'
  button.dataset.agent = agent.id
  if (ui.selected === agent.id) button.dataset.selected = 'true'
  button.appendChild(roleDot(agent.role))

  const body = el('span', 'pv-node-body')
  const region = dataRegion({ className: 'pv-node-line' })
  region.appendChild(simValue(agent.name, { className: 'pv-node-name' }))
  region.appendChild(simValue(ROLE_LABEL[agent.role] || agent.role, { className: 'pv-node-role' }))
  body.appendChild(region)

  const stateRegion = dataRegion({ className: 'pv-node-state' })
  stateRegion.appendChild(stateChip(agent.state))
  stateRegion.appendChild(simValue(`${agent.ageMin} min`, { className: 'pv-node-age' }))
  body.appendChild(stateRegion)
  button.appendChild(body)
  button.addEventListener('click', () => ui.select(agent.id))
  li.appendChild(button)

  const children = world.agents.filter(a => a.parent === agent.id)
  if (children.length) {
    const list = el('ul', 'pv-nodes')
    for (const child of children) list.appendChild(nodeItem(world, child, ui))
    li.appendChild(list)
  }
  return li
}

/* ---------------------------------------------------------------- *
 * 3. AGENT — read one
 * ---------------------------------------------------------------- */

export function agentSurface(world, ui) {
  const wrap = el('section', 'pv-surface')
  const agent = world.agents.find(a => a.id === ui.selected) || world.agents[0]
  wrap.appendChild(el('h2', 'pv-h', 'Reading one agent'))

  const head = el('div', 'pv-agent-head')
  head.appendChild(roleDot(agent.role))
  const nameRegion = dataRegion({ className: 'pv-agent-name' })
  nameRegion.appendChild(simValue(agent.name))
  head.appendChild(nameRegion)
  const stateRegion = dataRegion({ className: 'pv-agent-state' })
  stateRegion.appendChild(stateChip(agent.state))
  head.appendChild(stateRegion)
  wrap.appendChild(head)

  const fields = el('div', 'pv-fields')
  fields.appendChild(field('Job', ROLE_LABEL[agent.role] || agent.role))
  fields.appendChild(field('Model', agent.model))
  fields.appendChild(field('Running for', `${agent.ageMin} min`))
  fields.appendChild(field('Tasks finished', agent.done))
  fields.appendChild(field('Computer', (world.hosts.find(h => h.id === agent.host) || {}).name || '—'))
  fields.appendChild(field('Current task', agent.task))
  wrap.appendChild(fields)

  wrap.appendChild(el('h3', 'pv-sub', 'What it has said'))
  const feed = dataRegion({ tag: 'ol', className: 'pv-feed' })
  for (const line of world.transcript) {
    const item = simValue('', { tag: 'li', className: 'pv-feed-line' })
    item.textContent = ''
    const who = el('span', 'pv-feed-who', line.agent)
    const what = el('span', 'pv-feed-what', line.text)
    const when = el('span', 'pv-feed-when', `${line.minutesAgo} min ago`)
    item.append(who, what, when)
    feed.appendChild(item)
  }
  wrap.appendChild(feed)

  const controls = el('div', 'pv-controls')
  for (const label of ['Stop this agent', 'Send it a message', 'Start another']) {
    const button = el('button', 'pv-ctl', label)
    button.type = 'button'
    button.disabled = true
    controls.appendChild(button)
  }
  wrap.appendChild(controls)
  wrap.appendChild(el('p', 'pv-note',
    'Those three controls are switched off in the preview on purpose: there is no agent behind this '
    + 'page for them to act on. In the installed application they are the same three buttons and they work.'))
  return wrap
}

/* ---------------------------------------------------------------- *
 * 4. APPROVALS — the control that is the product
 * ---------------------------------------------------------------- */

export function approvalsSurface(world, ui) {
  const wrap = el('section', 'pv-surface')
  wrap.appendChild(el('h2', 'pv-h', 'Requests waiting on you'))
  wrap.appendChild(el('p', 'pv-lede',
    'An agent that wants to touch anything outside its own work stops and asks. Until you answer, '
    + 'the answer is no — an unanswered request is refused, never held open and never assumed.'))

  const list = el('div', 'pv-requests')
  for (const request of world.requests) {
    const card = el('article', 'pv-request')
    card.dataset.request = request.id
    const region = dataRegion({ className: 'pv-request-body' })
    region.appendChild(simValue(request.what, { tag: 'p', className: 'pv-request-what' }))
    region.appendChild(simValue(`Why: ${request.why}`, { tag: 'p', className: 'pv-request-why' }))
    region.appendChild(simValue(`Scope: ${request.scope}`, { tag: 'p', className: 'pv-request-scope' }))
    card.appendChild(region)

    if (request.decision) {
      const outcome = dataRegion({ className: 'pv-request-outcome' })
      outcome.appendChild(simValue(
        request.decision === 'approved' ? 'You approved this. It was written to the record.'
          : 'You refused this. It was written to the record.',
      ))
      card.appendChild(outcome)
    } else {
      const row = el('div', 'pv-request-actions')
      const yes = el('button', 'pv-ctl pv-ctl-yes', 'Approve')
      yes.type = 'button'
      yes.dataset.decide = `${request.id}:approved`
      yes.addEventListener('click', () => ui.decide(request.id, 'approved'))
      const no = el('button', 'pv-ctl', 'Refuse')
      no.type = 'button'
      no.dataset.decide = `${request.id}:refused`
      no.addEventListener('click', () => ui.decide(request.id, 'refused'))
      row.append(yes, no)
      card.appendChild(row)
    }
    list.appendChild(card)
  }
  wrap.appendChild(list)
  return wrap
}

/* ---------------------------------------------------------------- *
 * 5. SPEND
 * ---------------------------------------------------------------- */

export function spendSurface(world) {
  const wrap = el('section', 'pv-surface')
  wrap.appendChild(el('h2', 'pv-h', 'What it cost'))
  wrap.appendChild(el('p', 'pv-lede',
    'Tokens and money per day, per agent and per computer, against a cap you set. '
    + 'The cap is enforced where the spending happens.'))

  const max = Math.max(...world.spend.map(d => d.tokensK))
  const chart = dataRegion({ className: 'pv-chart' })
  for (const day of world.spend) {
    const column = el('div', 'pv-bar-col')
    const bar = simValue('', { className: 'pv-bar' })
    bar.textContent = ''
    bar.style.setProperty('--h', `${Math.round((day.tokensK / max) * 100)}%`)
    bar.setAttribute('aria-hidden', 'true')
    const value = simValue(`${day.tokensK}k`, { className: 'pv-bar-v' })
    const label = simValue(day.day, { className: 'pv-bar-l' })
    column.append(value, bar, label)
    chart.appendChild(column)
  }
  wrap.appendChild(chart)

  const table = el('table', 'pv-table')
  const thead = el('thead')
  const hrow = el('tr')
  for (const heading of ['Day', 'Tokens', 'Cost']) hrow.appendChild(el('th', null, heading))
  thead.appendChild(hrow)
  const tbody = document.createElement('tbody')
  tbody.className = 'sim-data-region'
  for (const day of world.spend) {
    const row = el('tr')
    for (const value of [day.day, `${day.tokensK}k`, `$${(day.costCents / 100).toFixed(2)}`]) {
      const cell = el('td')
      cell.appendChild(simValue(value))
      row.appendChild(cell)
    }
    tbody.appendChild(row)
  }
  table.append(thead, tbody)
  wrap.appendChild(table)
  return wrap
}

/* ---------------------------------------------------------------- *
 * 6. RECORD — the ledger
 * ---------------------------------------------------------------- */

export function recordSurface(world) {
  const wrap = el('section', 'pv-surface')
  wrap.appendChild(el('h2', 'pv-h', 'The record'))
  wrap.appendChild(el('p', 'pv-lede',
    'Every decision and every run is appended to a hash-chained record. Each entry carries the '
    + 'fingerprint of the one before it, so an entry cannot be changed after the fact without the '
    + 'chain failing to verify. Answer a request on the previous tab and watch it arrive here.'))

  const list = dataRegion({ tag: 'ol', className: 'pv-ledger' })
  for (const entry of world.ledger) {
    const item = el('li', 'pv-ledger-item')
    item.appendChild(simValue(entry.id, { className: 'pv-ledger-id' }))
    item.appendChild(simValue(entry.text, { className: 'pv-ledger-text' }))
    item.appendChild(simValue(`chain ${entry.chain}`, { className: 'pv-ledger-chain' }))
    list.appendChild(item)
  }
  wrap.appendChild(list)
  return wrap
}

export const SURFACES = Object.freeze([
  Object.freeze({ id: 'overview', label: 'Overview', build: overviewSurface }),
  Object.freeze({ id: 'fleet', label: 'Fleet', build: fleetSurface }),
  Object.freeze({ id: 'agent', label: 'Agent', build: agentSurface }),
  Object.freeze({ id: 'approvals', label: 'Requests', build: approvalsSurface }),
  Object.freeze({ id: 'spend', label: 'Spend', build: spendSurface }),
  Object.freeze({ id: 'record', label: 'Record', build: recordSurface }),
])
