import { el } from './components.js'
import { usageAnalysis, selectUsageRows, usageRowsCsv, TURN_SIZE_BINS, metricShare as percent, quietRecordNote } from './metrics-analysis.js'

const number = value => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—'
const node = (tag, className, text) => {
  const item = document.createElement(tag)
  if (className) item.className = className
  if (text !== undefined) item.textContent = text
  return item
}

export function createMetricsAnalysisPanels({ root, reveal }) {
  let analysis = usageAnalysis(), current = null, filtered = []
  const state = { query: '', size: 'all', result: 'all', order: 'largest', page: 0 }
  const PAGE_SIZE = 10
  const usageAbsence = () => !current?.records ? 'Reading usage records…'
    : !current.records.usage?.readable ? quietRecordNote(current.records.usage, 'Usage records could not be read. Try Refresh data.')
    : 'No individual turns recorded in this period.'
  const tableHost = root.querySelector('#m-usage-details')
  tableHost.appendChild(el(`<div class="m-history-tools m-usage-tools">
    <label class="m-search"><span>Search turns</span><input id="m-usage-search" type="search" placeholder="Agent, model, sign-in…" autocomplete="off"></label>
    <label><span>Token size</span><select id="m-usage-size"><option value="all">All sizes</option>${TURN_SIZE_BINS.map(bin => `<option value="${bin.id}">${bin.label} tokens</option>`).join('')}<option value="unknown">Total not recorded</option></select></label>
    <label><span>Result</span><select id="m-usage-result"><option value="all">All results</option><option value="success">Successful</option><option value="problem">Reported a problem</option><option value="unknown">Not recorded</option></select></label>
    <label><span>Order</span><select id="m-usage-order"><option value="largest">Most tokens</option><option value="newest">Newest first</option></select></label>
    <button type="button" class="m-action" id="m-usage-export">Export usage CSV</button>
  </div>`))
  tableHost.appendChild(el(`<div class="m-table-scroll" tabindex="0" role="region" aria-label="Usage details; scroll horizontally for more columns"><table class="m-usage-table"><thead><tr><th scope="col">Completed</th><th scope="col">Agent / model</th><th scope="col">Tokens</th><th scope="col">Total source</th><th scope="col">Result</th><th scope="col">Record details</th></tr></thead><tbody id="m-usage-body"></tbody></table></div>`))
  tableHost.appendChild(el(`<div class="m-history-footer"><span id="m-usage-status" role="status"></span><div class="m-history-pages"><button type="button" class="m-action" id="m-usage-prev">Previous</button><span id="m-usage-page"></span><button type="button" class="m-action" id="m-usage-next">Next</button></div></div>`))

  function renderTable() {
    filtered = selectUsageRows(analysis.rows, state)
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    state.page = Math.min(state.page, pages - 1)
    const start = state.page * PAGE_SIZE
    const body = root.querySelector('#m-usage-body')
    body.replaceChildren()
    for (const row of filtered.slice(start, start + PAGE_SIZE)) {
      const tr = node('tr')
      const at = node('td')
      const date = Number.isFinite(row.atMs) ? new Date(row.atMs) : null
      at.append(node('span', 'm-usage-date', date?.toLocaleDateString([], { month: 'short', day: 'numeric' }) || 'Not recorded'),
        node('small', '', date?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) || ''))
      if (date) at.title = date.toISOString()
      const who = node('td')
      who.append(node('b', '', row.agent), node('small', '', row.model))
      const tokens = node('td', 'm-usage-number', number(row.totalTokens))
      const source = node('td', 'm-usage-basis', row.totalSource)
      const result = node('td')
      result.dataset.result = row.result.key
      result.append(node('span', 'm-result-badge', row.result.label))
      const more = node('td')
      const details = node('details', 'm-usage-record')
      details.append(node('summary', '', 'Inspect'))
      const list = node('dl')
      for (const [label, value] of [
        ['Sign-in', row.account || 'Not recorded'], ['Input', number(row.input)], ['Cached input', number(row.cachedInput)],
        ['Cache creation', number(row.cacheCreation)], ['Output', number(row.output)], ['Reasoning within output', number(row.reasoning)],
        ['Input includes cache', row.inputBasis === 'includes-cache' ? 'Yes' : row.inputBasis === 'excludes-cache' ? 'No' : 'Not recorded'],
        ['Record', row.sequence], ['Turn', row.turnId || 'Not recorded'],
      ]) list.append(node('dt', '', label), node('dd', '', String(value ?? 'Not recorded')))
      details.append(list)
      if (row.failure) details.append(node('p', '', row.failure))
      more.append(details)
      tr.append(at, who, tokens, source, result, more)
      body.append(tr)
    }
    if (!filtered.length) {
      const row = node('tr'), cell = node('td', 'm-history-empty', current?.records?.usage?.readable
        ? analysis.rows.length ? 'No turns match these filters.' : 'No individual turns recorded in this period.'
        : current?.records ? quietRecordNote(current.records.usage, 'Usage records could not be read. Try Refresh data.') : 'Reading usage records…')
      cell.colSpan = 6
      row.append(cell)
      body.append(row)
    }
    root.querySelector('#m-usage-page').textContent = `Page ${state.page + 1} of ${pages}`
    root.querySelector('#m-usage-prev').disabled = state.page === 0
    root.querySelector('#m-usage-next').disabled = state.page >= pages - 1
    root.querySelector('#m-usage-export').disabled = !filtered.length
    root.querySelector('#m-usage-status').textContent = !current?.records?.usage?.readable ? usageAbsence() : filtered.length
      ? `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} matching turns`
      : 'No matching turns'
    root.querySelector('#usage-details-sub').textContent = current?.records?.usage?.readable
      ? `${analysis.rows.length} recorded turns · exact figures, with their source` : usageAbsence()
  }

  function inspectSize(size) {
    state.size = size
    state.page = 0
    root.querySelector('#m-usage-size').value = size
    reveal('usage-details')
    renderTable()
    root.querySelector('[data-mc="usage-details"]').scrollIntoView({ block: 'start' })
    root.querySelector('#m-usage-size').focus({ preventScroll: true })
  }

  function renderComposition() {
    const host = root.querySelector('#m-composition')
    host.replaceChildren()
    if (!current?.records?.usage?.readable || !analysis.rows.length) { host.append(node('p', 'm-panel-note m-quiet-result', usageAbsence())); return }
    if (!analysis.known) { host.append(node('p', 'm-panel-note m-quiet-result', 'Token composition appears when a turn has a usable total.')); return }
    const hero = node('div', 'm-analysis-hero')
    const ring = node('div', 'm-cache-ring')
    ring.style.setProperty('--share', `${(analysis.cache.share ?? 0) * 100}%`)
    ring.append(node('b', '', percent(analysis.cache.share)))
    const caption = node('div')
    caption.append(node('b', 'm-analysis-label', 'Cached input share'),
      node('p', '', analysis.cache.share == null ? 'No comparable input readings yet.'
        : `${number(analysis.cache.cached)} of ${number(analysis.cache.input)} input tokens`),
      node('small', '', `${analysis.cache.turns} turns with comparable cache readings`))
    hero.append(ring, caption)
    host.append(hero)
    const parts = [['input', 'Other input'], ['read', 'Cache read'], ['write', 'Cache creation'], ['output', 'Output'], ['unclassified', 'Unclassified']]
    const bar = node('div', 'm-composition-bar')
    bar.setAttribute('role', 'img')
    bar.setAttribute('aria-label', parts.map(([key, label]) => `${label}: ${number(analysis.parts[key])} tokens`).join('; '))
    for (const [key] of parts) {
      if (!analysis.parts[key]) continue
      const segment = node('i')
      segment.dataset.part = key
      segment.style.flex = String(analysis.parts[key])
      bar.append(segment)
    }
    host.append(bar)
    const legend = node('dl', 'm-composition-legend')
    for (const [key, label] of parts) {
      if (key === 'unclassified' && !analysis.parts[key]) continue
      const name = node('dt', '', label)
      const swatch = node('i')
      swatch.dataset.part = key
      name.prepend(swatch)
      legend.append(name, node('dd', '', number(analysis.parts[key])))
    }
    host.append(legend, node('p', 'm-panel-note m-analysis-footnote',
      `${number(analysis.total)} known tokens in total. ${analysis.composed} of ${analysis.rows.length} turns reconcile to their parts. Reasoning is included in output. Other input includes any unreported cache split.`))
  }

  function renderDistribution() {
    const host = root.querySelector('#m-distribution')
    host.replaceChildren()
    if (!current?.records?.usage?.readable || !analysis.rows.length) { host.append(node('p', 'm-panel-note m-quiet-result', usageAbsence())); return }
    const summary = node('div', 'm-distribution-summary')
    for (const [label, value] of [['Median', analysis.median], ['90th percentile', analysis.p90], ['Largest turn', analysis.max]]) {
      const item = node('div')
      item.append(node('span', '', label), node('b', '', number(value)))
      summary.append(item)
    }
    host.append(summary)
    const histogram = node('div', 'm-histogram')
    histogram.setAttribute('role', 'group')
    histogram.setAttribute('aria-label', 'Turn sizes in tokens; select a range to inspect its turns')
    const ceiling = Math.max(1, ...analysis.bins.map(bin => bin.count))
    for (const bin of analysis.bins) {
      const button = node('button', 'm-histogram-bin')
      button.type = 'button'
      button.disabled = !bin.count
      button.setAttribute('aria-label', `${number(bin.min)}${bin.max === Infinity ? ' or more' : ` to ${number(bin.max - 1)}`} tokens: ${bin.count} turns. Inspect turns.`)
      button.style.setProperty('--bar-height', `${bin.count / ceiling * 100}%`)
      const track = node('span', 'm-histogram-track')
      track.append(node('i'), node('b', '', number(bin.count)))
      button.append(track, node('span', 'm-histogram-label', bin.label))
      button.addEventListener('click', () => inspectSize(bin.id))
      histogram.append(button)
    }
    host.append(histogram, node('p', 'm-panel-note m-analysis-footnote',
      `${analysis.known} turns with totals · ${analysis.unknown} unknown. Select a bar to inspect turns. P90 is the smallest recorded size covering at least 90% of measured turns.`))
  }

  function renderCoverage() {
    const host = root.querySelector('#m-coverage')
    host.replaceChildren()
    const readable = current?.records?.usage?.readable
    const count = analysis.rows.length
    const hero = node('div', 'm-turn-headline')
    hero.append(node('b', '', readable && count ? percent(analysis.known / count) : '—'), node('span', '', 'of recorded turns have a usable total'))
    host.append(hero)
    const list = node('dl', 'm-coverage-list')
    for (const [label, value] of [
      ['Provider-reported totals', readable ? analysis.reported : null], ['Derived from recorded parts', readable ? analysis.derived : null],
      ['Turns without totals', readable ? analysis.unknown : null], ['Cumulative readings excluded', current?.period?.cumulative ?? null],
    ]) list.append(node('dt', '', label), node('dd', '', number(value)))
    host.append(list)
    const checks = node('div', 'm-record-checks')
    for (const [key, label] of [['sessions', 'Run record'], ['usage', 'Usage record']]) {
      const record = current?.records?.[key]
      const line = node('div')
      const value = !record ? 'Reading…' : !record.readable ? 'Could not read' : current.source === 'mock' ? 'Example data'
        : record.verified === true ? 'Signature verified' : record.verified === false ? 'Record does not verify. Treat these figures as unverified.' : 'Verification not available'
      line.dataset.check = record?.readable && record.verified === true && current.source !== 'mock' ? 'verified' : 'unknown'
      line.append(node('span', '', label), node('b', '', value))
      checks.append(line)
    }
    host.append(checks, node('p', 'm-panel-note m-analysis-footnote',
      'Coverage describes the saved record. Turns without a usage report and unfinished turns may be absent. Tokens are assigned to the time the turn finished; run attempts use their start time.'))
    const method = node('details', 'm-metrics-method')
    method.append(node('summary', '', 'How these figures are calculated'), node('p', '',
      'Provider totals take precedence. Derived totals require recorded input and output, with cache counted once. A missing total stays unknown. Session-wide cumulative readings are excluded because their tokens cannot be placed in a single period. Cache share uses only turns whose input and cache readings reconcile. These figures do not measure cost or subscription limits.'))
    if (current?.records?.principal?.startsWith('account:')) method.append(node('p', '',
      'Only activity tied to this app account is included. Older records without an account label cannot be attributed to you.'))
    host.append(method)
  }

  for (const [id, key, event] of [['search', 'query', 'input'], ['size', 'size', 'change'], ['result', 'result', 'change'], ['order', 'order', 'change']]) {
    root.querySelector(`#m-usage-${id}`).addEventListener(event, e => { state[key] = e.target.value; state.page = 0; renderTable() })
  }
  for (const [id, step] of [['prev', -1], ['next', 1]]) root.querySelector(`#m-usage-${id}`).addEventListener('click', () => { state.page += step; renderTable() })
  root.querySelector('#m-usage-export').addEventListener('click', () => {
    if (!filtered.length) return
    const url = URL.createObjectURL(new Blob([usageRowsCsv(filtered, { example: current.source === 'mock' })], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `metrics-${current.source === 'mock' ? 'example' : 'recorded'}-usage.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  return {
    update(next) {
      if (!next.records) {
        Object.assign(state, { query: '', size: 'all', result: 'all', order: 'largest', page: 0 })
        for (const [id, key] of [['search', 'query'], ['size', 'size'], ['result', 'result'], ['order', 'order']]) root.querySelector(`#m-usage-${id}`).value = state[key]
      }
      if (current?.window?.range !== next.window?.range) state.page = 0
      current = next
      for (const id of ['search', 'size', 'result', 'order']) root.querySelector(`#m-usage-${id}`).disabled = !next.records?.usage?.readable
      analysis = usageAnalysis(next.period?.turns || [], next.records?.conversations)
      renderComposition()
      renderDistribution()
      renderCoverage()
      renderTable()
      for (const id of ['composition', 'distribution', 'coverage']) root.querySelector(`#${id}-sub`).textContent = next.window?.word || 'Reading records…'
    },
  }
}
