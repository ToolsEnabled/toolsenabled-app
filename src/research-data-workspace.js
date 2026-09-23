import { el } from './components.js'
import { TABLE_TYPES, PACKAGE_PROFILE, csvRows, textChunks, inspectPackage, inspectSchema, readTablePage, validateTable, schemaForHeaders, relativeDataPath } from './research-data-package.mjs'
import { filesSource, directorySource, connectedSource, tableStream } from './research-data-sources.mjs'
import { chartTableData, chooseChartAxes } from './research-data-chart-model.mjs'
import { loadSourceQuality, sourceQualityFlag, sourceQualityKey } from './research-data-quality.mjs'
import './research-data.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const parent = path => path.split('/').slice(0, -1).join('/')
const join = (directory, path) => relativeDataPath(directory ? directory + '/' + path : path)
const prettyBytes = bytes => bytes == null ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
const download = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' })), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createResearchDataWorkspace({ fetchImpl = (...args) => fetch(...args), downloadFile = download, openDraft } = {}) {
  const root = el(`<section class="research-section rd-workspace" data-mc="data" aria-labelledby="research-data-title">
    <div class="rd-heading"><h2 id="research-data-title">Files & data</h2>
      <div class="rd-actions"><button type="button" class="rd-primary" data-rd-open>Open folder</button><button type="button" data-rd-import>Import files</button></div></div>
    <p>Browse research source files and data sheets here. Experiment drafts open separately in the Benchmark builder; a folder does not supply experiment settings by itself.</p>
    <input type="file" data-rd-folder webkitdirectory multiple hidden><input type="file" data-rd-files multiple accept=".json,.csv,.tsv,.gz,.txt,.md" hidden>
    <details class="rd-help"><summary>How to prepare your data</summary>
      <p>Use a <a href="https://datapackage.org/standard/data-package/" target="_blank" rel="noreferrer">Frictionless Data Package</a>: a <code>datapackage.json</code> file describes your tables and their column schemas. Keep the data files beside it or in subfolders.</p>
      <ol><li>Save each table as UTF-8 CSV or TSV, with one header row, one record per row, and the same number of cells on every row. Gzip files are supported.</li><li>Declare every column as text, integer, number, boolean, date, or timestamp. Use ISO dates and timestamps with a timezone. Keep units and descriptions beside the column you declare.</li><li>Declare missing values explicitly. Empty cells default to missing; a missing value is different from zero. Quote cells containing delimiters, quotes, or line breaks.</li><li>Open the folder and choose <code>datapackage.json</code>. For a plain CSV, choose its file and define its columns here, then export the standard package description.</li></ol>
      <p>The header row must match the columns you declared, in the same order. Use relative local file paths; column definitions may sit inline or in a local file beside the data. Sheet previews show one page at a time. Validate file reads every row of the chosen file; relationships between tables, and uniqueness across files, need a separate check of the whole dataset.</p>
      <p>Optional source-quality notes: add a table with text columns <code>resource</code>, <code>path</code>, <code>verdict</code> and <code>reason</code>. In the package description, set <code>toolsenabled.sourceQuality</code> to that table's resource name. Each path must match a file in its named resource. These source assessments appear separately from format checks; a file without an assessment is not marked as passed.</p>
      <button type="button" data-rd-template>Download format example</button>
    </details>
    <p class="rd-status" data-rd-status role="status">Choose a folder or import a data package to begin. Your files stay on this computer.</p>
    <button type="button" class="rd-browser-toggle" data-rd-browser-toggle aria-expanded="false" aria-controls="research-file-browser">Browse files & sheets</button>
    <div class="rd-body">
      <aside class="rd-sidebar" id="research-file-browser"><div class="rd-folder-title" data-rd-folder-name>No folder open</div><div class="rd-sidebar-tools"><button type="button" data-rd-up disabled>Up</button><input type="search" data-rd-file-filter placeholder="Find a file here" aria-label="Filter files in this folder"></div><p class="rd-path" data-rd-path></p><div data-rd-tree class="rd-files"></div><h3>Data sheets</h3><div data-rd-sheets class="rd-sheets"><p>Imported tables appear here.</p></div></aside>
      <div class="rd-content"><div data-rd-empty class="rd-empty"><span class="rd-empty-icon" aria-hidden="true">▦</span><h3>A place for your research data</h3><p>Browse notes and source files alongside typed data sheets. The same columns power the table and its chart.</p></div>
        <section data-rd-file-view hidden><h3 data-rd-file-title></h3><p data-rd-file-note></p><div data-rd-file-actions></div><pre data-rd-file-text tabindex="0"></pre></section>
        <section data-rd-setup hidden><h3>Define this table</h3><p>These are the CSV headers. Choose the type of each column to tell Research how to read its values.</p><label>Sheet name<input data-rd-sheet-name></label><div data-rd-column-editor></div><button type="button" class="rd-primary" data-rd-apply-schema>Open as a data sheet</button><p>Text is the default. Types are never inferred silently. Export the package description to reuse these definitions.</p></section>
        <section data-rd-sheet hidden>
          <div class="rd-sheet-heading"><div><h3 data-rd-sheet-title></h3><p class="rd-sheet-flag" data-rd-sheet-flag role="status" hidden></p><p data-rd-sheet-description></p></div><button type="button" data-rd-export>Export package description</button></div>
          <div class="rd-sheet-toolbar"><label>Data file<input type="search" data-rd-part-filter placeholder="Find a data file by name" aria-label="Filter data files" hidden><select data-rd-part></select></label><label>Find values<input type="search" data-rd-search placeholder="Text anywhere in this file"></label><button type="button" data-rd-search-go>Apply filter</button><button type="button" data-rd-validate>Validate file</button><button type="button" data-rd-cancel hidden>Cancel read</button></div>
          <div data-rd-quality class="rd-quality" role="status" hidden></div>
          <p data-rd-validation class="rd-validation" role="status"></p>
          <details data-rd-columns><summary>Column definitions</summary><div data-rd-schema></div></details>
          <div class="rd-tabs" role="group" aria-label="Data view"><button type="button" data-rd-tab="sheet" aria-pressed="true">Sheet</button><button type="button" data-rd-tab="chart" aria-pressed="false">Chart</button></div>
          <div data-rd-grid class="rd-grid" tabindex="0" role="region" aria-label="Data sheet"></div>
          <div data-rd-chart-panel hidden><div class="rd-chart-controls"><label>X axis<select data-rd-x></select></label><label>Y axis<select data-rd-y></select></label><label>Series<select data-rd-series></select></label><label>Chart<select data-rd-chart-kind><option value="line">Line</option><option value="scatter">Scatter</option><option value="bar">Bar</option></select></label><label>Values<select data-rd-compare><option value="actual">As measured</option><option value="change">Change from each series’ first point</option></select></label></div><p data-rd-chart-note role="status"></p><div data-rd-chart class="rd-chart"></div></div>
          <div class="rd-pagination"><button type="button" data-rd-prev>Previous</button><span data-rd-page></span><button type="button" data-rd-next>Next</button></div>
          <details data-rd-errors hidden><summary data-rd-errors-title>Validation errors — open this to see which rows</summary><div data-rd-errors-list></div></details>
        </section>
      </div>
    </div>
  </section>`)
  const q = name => root.querySelector(`[data-rd-${name}]`)
  let source = null, directory = '', entries = [], resources = [], descriptor = null, packageBase = '', selected = null, part = 0
  let offset = 0, search = '', page = null, pendingSchema = null, pendingFile = '', epoch = 0, abort = null, chart = null, destroyed = false, activeTab = 'sheet'
  let quality = null, axesMeasured = false
  const note = text => { if (!destroyed) q('status').textContent = text }
  const newOperation = () => { abort?.abort(); abort = new AbortController(); return { ticket: ++epoch, signal: abort.signal } }
  const current = ticket => !destroyed && ticket === epoch
  function show(name) { for (const key of ['empty', 'file-view', 'setup', 'sheet']) q(key).hidden = key !== name }
  function busy(on) { q('cancel').hidden = !on; for (const key of ['part', 'part-filter', 'validate', 'search-go', 'prev', 'next']) q(key).disabled = on; root.setAttribute('aria-busy', String(on)) }
  function handleError(error, ticket) { if (error.name !== 'AbortError' && current(ticket)) note(error.message) }
  let chartRequest = 0
  function destroyChart() { ++chartRequest; chart?.destroy(); chart = null; q('chart').innerHTML = '' }
  function resetTable() { selected = null; page = null; destroyChart(); q('errors').hidden = true; q('validation').textContent = ''; show('empty') }

  async function browse(path = '') {
    if (!source) return
    const held = source
    try {
      const found = await held.list(path)
      if (source !== held || destroyed) return
      directory = path; entries = found; q('path').textContent = path || '/'; q('up').disabled = !path; q('file-filter').value = ''; renderFiles()
    } catch (error) { if (source === held) note(error.message) }
  }
  function renderFiles() {
    const filter = q('file-filter').value.toLowerCase()
    const shown = entries.filter(item => item.name.toLowerCase().includes(filter)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name))
    q('tree').innerHTML = shown.length ? shown.map(item => `<button type="button" data-rd-entry="${esc(item.path)}" data-rd-kind="${item.kind}" title="${esc(item.path)}"><span aria-hidden="true">${item.kind === 'directory' ? '▸' : '·'}</span><span>${esc(item.name)}</span><small>${prettyBytes(item.size)}</small></button>`).join('') : '<p>No matching files.</p>'
  }
  function renderSheets() {
    q('sheets').innerHTML = resources.length ? resources.map((item, index) => `<button type="button" data-rd-resource="${index}" aria-pressed="${selected === item}"><span>${esc(item.title || item.name)}</span><small>${item.schema.fields.length} columns · ${item.paths.length} ${item.paths.length === 1 ? 'file' : 'files'}</small></button>`).join('') : '<p>Choose a data package or CSV file to add sheets.</p>'
  }
  async function setSource(next) {
    newOperation(); busy(false); source = next; resources = []; descriptor = null; packageBase = ''; quality = null; resetTable(); renderSheets(); q('folder-name').textContent = next.name
    note(`Opened ${next.name}. Select a file to inspect it or open a data package.`)
    await browse('')
    const manifest = next.packagePaths?.[0] || entries.find(item => item.name === 'datapackage.json')?.path
    if (manifest && source === next) await loadPackage(manifest)
  }
  async function readJSON(path) {
    const result = await source.text(path, 8 * 1024 * 1024)
    if (result.truncated) throw new Error(`${path} is larger than the supported 8 MiB descriptor size.`)
    try { return JSON.parse(result.text) } catch { throw new Error(`${path} is not valid JSON.`) }
  }
  async function loadPackage(path) {
    const { ticket, signal } = newOperation(), held = source
    try {
      const data = await readJSON(path), base = parent(path), tables = inspectPackage(data)
      for (const table of tables) {
        if (typeof table.schema === 'string') table.schema = inspectSchema(await readJSON(join(base, table.schema)))
        table.resolvedPaths = table.paths.map(file => join(base, file))
        table.schema.fields.forEach(field => { if (field.title == null) field.title = field.name })
      }
      const assessment = await readQuality(data, tables, held, signal)
      if (!current(ticket) || held !== source) return
      descriptor = data; packageBase = base; resources = tables; quality = assessment; resetTable(); renderSheets()
      note(`Opened ${data.title || data.name || 'data package'} · ${tables.length} ${tables.length === 1 ? 'sheet' : 'sheets'}. File contents are checked when opened.`)
      await selectResource(0)
    } catch (error) { handleError(error, ticket) }
  }
  async function readQuality(data, tables, held, signal) {
    try { return await loadSourceQuality(data, tables, (path, signal) => tableStream(held, path, signal), { signal }) }
    catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error
      return { resource: data.toolsenabled?.sourceQuality, error: error.message }
    }
  }
  function renderQuality() {
    const host = q('quality'), flag = q('sheet-flag')
    flag.hidden = true; flag.textContent = ''; flag.removeAttribute('data-severity')
    host.hidden = !quality || !selected || selected.name === quality.resource
    host.innerHTML = ''; host.removeAttribute('data-severity')
    if (host.hidden) return
    if (quality.error) {
      host.dataset.severity = 'warning'
      host.innerHTML = `<strong>Source quality could not be read, so read the notes yourself before trusting this file</strong><p>${esc(quality.error)} No source verdict has been established for any file in this package.</p>`
      return
    }
    const notes = quality.entries.get(sourceQualityKey(selected.name, selected.resolvedPaths[part])) || []
    // The verdict belongs beside the sheet title, where a person choosing a
    // file looks, not only in a panel further down the page.
    const mark = sourceQualityFlag(notes, quality.vocabulary)
    if (mark.severity !== 'none') { host.dataset.severity = 'warning'; flag.hidden = false; flag.textContent = mark.label; flag.dataset.severity = mark.severity }
    host.innerHTML = notes.length ? notes.map(item => {
      const metric = item.measured_metric && item.measured_value != null ? `${item.measured_metric}: ${item.measured_value}` : ''
      const reported = item.reported_date ? `Source report: ${item.reported_date}` : ''
      return `<div><strong>Source quality: ${esc(item.verdict)}</strong><p>${esc(item.reason)}</p>${metric || reported ? `<p>${esc([metric, reported].filter(Boolean).join(' · '))}</p>` : ''}${item.action ? `<p>Recorded source action: ${esc(item.action)}</p>` : ''}</div>`
    }).join('') : '<strong>Source quality: no assessment recorded for this file.</strong>'
    // State what was actually read, so a complete reading is visible as one and
    // a refusal can never be mistaken for a clean file.
    const read = `${quality.count.toLocaleString()} recorded note${quality.count === 1 ? '' : 's'} read in full from ${quality.rows.toLocaleString()} row${quality.rows === 1 ? '' : 's'} of ${esc(quality.resource)}.`
    host.innerHTML += `<p>${read} Source assessments are separate from column and type checks.</p><button type="button" data-rd-quality-notes>View quality notes</button>`
  }
  async function openFile(path) {
    if (/(^|\/)datapackage\.json$/i.test(path)) return loadPackage(path)
    if (/\.(csv|tsv)(\.gz)?$/i.test(path)) return prepareCSV(path)
    const { ticket } = newOperation()
    resetTable(); show('file-view'); q('file-title').textContent = path; q('file-text').textContent = ''; q('file-actions').innerHTML = ''
    if (!/\.(?:md|txt|json|jsonl|py|js|mjs|cjs|yaml|yml|toml|log|html|css|xml|sql)$/i.test(path)) { q('file-note').textContent = 'This file has no text preview. Data sheets support CSV and TSV, optionally gzip-compressed.'; return }
    try {
      const result = await source.text(path)
      if (!current(ticket)) return
      q('file-note').textContent = `${prettyBytes(result.size)}${result.truncated ? ' · first 1 MiB shown' : ''}`
      q('file-text').textContent = result.text
      if (/\.json$/i.test(path) && !result.truncated) {
        let data
        try { data = JSON.parse(result.text) } catch {}
        if (Array.isArray(data?.resources)) {
          q('file-actions').innerHTML = '<button type="button" data-rd-open-package>Open data package</button>'
          q('file-actions').querySelector('[data-rd-open-package]').addEventListener('click', () => loadPackage(path))
        }
        const draft = data?.spec || data
        if (typeof openDraft === 'function' && Array.isArray(draft?.catalog) && Array.isArray(draft?.tasks) && draft?.protocol) {
          const button = document.createElement('button')
          button.type = 'button'; button.textContent = 'Open this experiment'
          button.setAttribute('data-rd-open-draft', '')
          button.addEventListener('click', async () => {
            button.disabled = true
            try {
              const opened = await openDraft(data, path)
              if (current(ticket)) note(opened?.ok ? `Opened ${path} in the Benchmark builder.` : opened?.reason || 'The builder could not open this draft.')
            } catch (error) { handleError(error, ticket) }
            finally { button.disabled = false }
          })
          q('file-actions').append(button)
        }
      }
    } catch (error) { handleError(error, ticket) }
  }
  async function prepareCSV(path) {
    const { ticket, signal } = newOperation()
    try {
      const delimiter = /\.tsv(?:\.gz)?$/i.test(path) ? '\t' : ','
      let header = null
      for await (const row of csvRows(textChunks(await tableStream(source, path, signal), signal), { delimiter, signal })) { header = row; break }
      if (!header) throw new Error('This file has no header row.')
      const schema = schemaForHeaders(header); inspectSchema(schema)
      if (!current(ticket)) return
      pendingFile = path; pendingSchema = schema; show('setup'); q('sheet-name').value = path.split('/').at(-1).replace(/\.(csv|tsv)(\.gz)?$/i, '')
      q('column-editor').innerHTML = `<table><thead><tr><th>Column</th><th>Type</th><th>Required</th></tr></thead><tbody>${schema.fields.map((field, index) => `<tr><td>${esc(field.name)}</td><td><select data-rd-field-type="${index}" aria-label="Type of ${esc(field.name)}">${TABLE_TYPES.map(type => `<option>${type}</option>`).join('')}</select></td><td><input type="checkbox" data-rd-required="${index}" aria-label="Require ${esc(field.name)}"></td></tr>`).join('')}</tbody></table>`
      note('Confirm the column types, then open the sheet. The source file is unchanged.')
    } catch (error) { handleError(error, ticket) }
  }
  async function selectResource(index) {
    newOperation(); busy(false); selected = resources[index]; part = 0; offset = 0; search = ''; q('search').value = ''; page = null
    if (!selected) return
    destroyChart(); show('sheet'); renderSheets(); q('validation').textContent = ''; q('errors').hidden = true
    q('sheet-title').textContent = selected.title || selected.name; q('sheet-description').textContent = selected.description || ''
    q('part-filter').value = ''; q('part-filter').hidden = selected.paths.length < 12; renderParts()
    q('schema').innerHTML = `<table><thead><tr><th>Column</th><th>Type</th><th>Description / rules</th></tr></thead><tbody>${selected.schema.fields.map(field => `<tr><td>${esc(field.name)}</td><td>${esc(field.type)}</td><td>${esc(field.description || '')}${field.constraints?.required ? ' · required' : ''}${field.unit ? ` · ${esc(field.unit)}` : ''}</td></tr>`).join('')}</tbody></table>`
    const fields = selected.schema.fields
    q('x').innerHTML = fields.map((field, i) => `<option value="${i}">${esc(field.title || field.name)}</option>`).join('')
    q('y').innerHTML = fields.flatMap((field, i) => ['integer', 'number'].includes(field.type) ? [`<option value="${i}">${esc(field.title || field.name)}</option>`] : []).join('')
    q('series').innerHTML = '<option value="auto">Select grouping…</option><option value="all">All rows in one series</option>' + fields.map((field, i) => `<option value="${i}">${esc(field.title || field.name)}</option>`).join('')
    axesMeasured = false; q('compare').value = 'actual'; applyAxisDefaults([])
    await loadPage()
  }
  // Declared types choose the axes until rows exist; the first page that loads
  // replaces that guess with a choice measured from those rows. Later pages and
  // filters leave the axes alone rather than moving them under the person.
  function applyAxisDefaults(rows) {
    if (!selected) return
    const axes = chooseChartAxes(selected.schema.fields, rows)
    q('x').value = String(Math.max(0, axes.x))
    if (axes.y >= 0) q('y').value = String(axes.y)
  }
  function renderParts() {
    if (!selected) return
    const query = q('part-filter').value.trim().toLowerCase()
    const matches = selected.paths.map((path, index) => ({ path, index })).filter(item => item.path.toLowerCase().includes(query))
    // Keep the currently displayed file visible while the user narrows the next
    // choice. Filtering the list must not silently switch the sheet's source.
    const currentOption = matches.some(item => item.index === part) ? '' : `<option value="${part}">Open file: ${esc(selected.paths[part])}</option>`
    q('part').innerHTML = currentOption + matches.map(item => `<option value="${item.index}">${esc(item.path)}</option>`).join('') + (matches.length ? '' : '<option disabled>No matching data files</option>')
    q('part').value = String(part)
  }
  function renderErrors(result) {
    q('errors').hidden = !result.errorCount
    q('errors-title').textContent = `${result.errorCount.toLocaleString()} validation errors — open this to see which rows${result.errorCount > result.errors.length ? ` · first ${result.errors.length} shown` : ''}`
    q('errors-list').innerHTML = '<ul>' + result.errors.map(error => `<li>Row ${error.row}${error.column ? ` · ${esc(error.column)}` : ''}: ${esc(error.message)}</li>`).join('') + '</ul>'
  }
  async function loadPage() {
    if (!selected) return
    renderQuality()
    const { ticket, signal } = newOperation(), resource = selected
    busy(true); q('grid').innerHTML = '<p>Reading data…</p>'; q('validation').textContent = 'Checking the rows being read…'
    try {
      const result = await readTablePage(await tableStream(source, resource.resolvedPaths[part], signal), resource, { offset, search, signal, onProgress: rows => { if (current(ticket)) q('validation').textContent = `Searched ${rows.toLocaleString()} rows…` } })
      if (!current(ticket)) return
      page = result; renderErrors(result)
      if (!axesMeasured) { axesMeasured = true; applyAxisDefaults(result.rows) }
      q('validation').textContent = result.errorCount ? `${result.errorCount} errors in the rows scanned. See the error list below.` : `Column and type checks passed for ${result.scanned.toLocaleString()} scanned rows. Use Validate file for a complete file check.`
      renderPage(); if (activeTab === 'chart') await drawChart(ticket)
    } catch (error) { if (current(ticket)) { page = null; q('grid').innerHTML = ''; q('validation').textContent = error.name === 'AbortError' ? 'Read cancelled.' : error.message } }
    finally { if (current(ticket)) { busy(false); q('prev').disabled = offset === 0; q('next').disabled = !page?.hasMore } }
  }
  function renderPage() {
    const fields = selected.schema.fields
    q('grid').innerHTML = `<table><thead><tr><th scope="col">Row</th>${fields.map(field => `<th scope="col" title="${esc(field.description || field.name)}">${esc(field.title || field.name)}<small>${esc(field.type)}</small></th>`).join('')}</tr></thead><tbody>${page.rows.map(row => `<tr><th scope="row">${row.rowNumber}</th>${row.cells.map((cell, i) => `<td class="${row.errors.some(e => e.column === fields[i].name) ? 'rd-cell-error' : ''}" title="${esc(cell)}">${row.values[i] === null && !row.errors.some(e => e.column === fields[i].name) ? '<span class="rd-null">missing</span>' : `<span class="rd-cell-value">${esc(cell)}</span>`}</td>`).join('')}</tr>`).join('')}</tbody></table>${page.rows.length ? '' : '<p>No matching rows.</p>'}`
    q('page').textContent = `${page.rows.length ? (offset + 1).toLocaleString() + '–' + (offset + page.rows.length).toLocaleString() : '0'}${page.complete ? ' of ' + page.matched.toLocaleString() : ''} ${search ? 'matching ' : ''}records · selected file`
  }
  async function drawChart(ticket = epoch) {
    destroyChart()
    const request = chartRequest
    q('chart').hidden = true
    if (!page || !selected) return
    if (!q('y').options.length) { q('chart-note').textContent = 'Define a numeric column to draw a chart.'; return }
    const grouping = q('series').value
    const options = { x: Number(q('x').value), y: Number(q('y').value), kind: q('chart-kind').value, series: ['auto', 'all'].includes(grouping) ? grouping : Number(grouping), compare: q('compare').value }
    const model = chartTableData(page.rows, selected.schema.fields, options)
    if (model.requiresSeries.length) {
      q('chart-note').textContent = `Multiple categories in ${model.requiresSeries.join(', ')}. Choose a Series column or filter to one group. Select “All rows in one series” only if these rows belong together.`
      return
    }
    if (model.requiresScatter) {
      q('chart-note').textContent = `${model.sharedX.toLocaleString()} of these records share an X value with another record, so a line would join records that are simultaneous rather than successive. Choose Scatter to see them without implying an order, or group or filter these rows first.`
      return
    }
    const { createDataChart } = await import('./research-data-chart.js')
    if (!current(ticket) || activeTab !== 'chart' || request !== chartRequest) return
    q('chart').hidden = false
    chart = createDataChart(q('chart'), model, selected.schema.fields, options)
    q('chart').hidden = !chart
    const timeNote = selected.schema.fields[Number(q('x').value)]?.type === 'datetime' ? ' Times are displayed in UTC.' : ''
    const seriesNote = model.seriesField ? ` ${model.groups.length} series grouped by ${model.seriesField.title || model.seriesField.name}.` : ' All plotted rows share one series.'
    // Name the shape the chart cannot show honestly, rather than leaving a
    // vertical jump to be read as movement.
    const comparedNote = model.compare === 'change'
      ? ` Each series is drawn as the change from its own first plotted point, in ${esc(selected.schema.fields[Number(q('y').value)]?.unit || 'the column’s units')}; the axis shows movement, not measured values. Subtracted: ${model.baselines.slice(0, 8).map(item => `${item.name} ${item.base}`).join(', ')}${model.baselines.length > 8 ? ` and ${model.baselines.length - 8} more` : ''}.`
      : ''
    const sharedNote = options.kind === 'line' && model.sharedX ? ` ${model.sharedX} plotted records share an X value with another record in the same series. A line would join simultaneous records as though they were successive. Choose Scatter to show them without implying an order.` : ''
    q('chart-note').textContent = `Current sheet page only · ${chart?.count || 0} plotted records.${seriesNote}${timeNote}${comparedNote}${sharedNote} Missing or invalid axis or series values and integers beyond exact chart precision are omitted. No aggregation is applied.`
  }
  async function validateFile() {
    if (!selected) return
    const { ticket, signal } = newOperation(); busy(true)
    try {
      const result = await validateTable(await tableStream(source, selected.resolvedPaths[part], signal), selected, { signal, onProgress: count => { if (current(ticket)) q('validation').textContent = `Validated ${count.toLocaleString()} rows…` } })
      if (!current(ticket)) return
      renderErrors(result)
      q('validation').textContent = `${result.count.toLocaleString()} rows checked · ${result.errorCount.toLocaleString()} errors.${result.uniquenessComplete ? '' : ' Uniqueness checked for the first 1,000,000 rows only.'}${result.foreignKeysChecked ? '' : ' Cross-table relationships have not been checked.'} Checks apply to this file; other files are separate.`
    } catch (error) { if (current(ticket)) q('validation').textContent = error.name === 'AbortError' ? 'Validation cancelled; no complete result.' : error.message }
    finally { if (current(ticket)) { busy(false); q('prev').disabled = offset === 0; q('next').disabled = !page?.hasMore } }
  }

  q('open').addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') { try { await setSource(await directorySource(await window.showDirectoryPicker({ mode: 'read' }))) } catch (error) { if (error.name !== 'AbortError') note(error.message) } }
    else q('folder').click()
  })
  q('import').addEventListener('click', () => q('files').click())
  for (const key of ['folder', 'files']) q(key).addEventListener('change', async () => {
    const files = [...q(key).files]; if (!files.length) return
    try { await setSource(filesSource(files)); if (key === 'files' && !source.packagePaths.length) { const packageFile = files.find(f => f.name === 'datapackage.json'); if (packageFile) await loadPackage(packageFile.name); else if (files.length === 1) await openFile(files[0].name) } }
    catch (error) { note(error.message) }
    q(key).value = ''
  })
  q('tree').addEventListener('click', event => { const button = event.target.closest('[data-rd-entry]'); if (button) button.dataset.rdKind === 'directory' ? browse(button.dataset.rdEntry) : openFile(button.dataset.rdEntry) })
  q('sheets').addEventListener('click', event => { const button = event.target.closest('[data-rd-resource]'); if (button) selectResource(Number(button.dataset.rdResource)) })
  q('file-filter').addEventListener('input', renderFiles); q('up').addEventListener('click', () => browse(parent(directory)))
  q('browser-toggle').addEventListener('click', () => { const open = root.toggleAttribute('data-browser-open'); q('browser-toggle').setAttribute('aria-expanded', String(open)) })
  q('part').addEventListener('change', () => { part = Number(q('part').value); offset = 0; axesMeasured = false; loadPage() })
  q('part-filter').addEventListener('input', renderParts)
  q('search-go').addEventListener('click', () => { search = q('search').value; offset = 0; loadPage() })
  q('search').addEventListener('keydown', event => { if (event.key === 'Enter') q('search-go').click() })
  q('prev').addEventListener('click', () => { offset = Math.max(0, offset - 100); loadPage() })
  q('next').addEventListener('click', () => { offset += 100; loadPage() })
  q('cancel').addEventListener('click', () => abort?.abort()); q('validate').addEventListener('click', validateFile)
  q('quality').addEventListener('click', event => {
    if (event.target.closest('[data-rd-quality-notes]')) { const index = resources.findIndex(item => item.name === quality?.resource); if (index >= 0) selectResource(index) }
  })
  q('apply-schema').addEventListener('click', async () => {
    if (!pendingSchema) return
    const { ticket, signal } = newOperation(), held = source
    try {
      // Quality rows reference stable resource names and descriptor-relative
      // paths. Keep that package root instead of silently rebasing its notes.
      const base = descriptor?.toolsenabled?.sourceQuality !== undefined ? packageBase : ''
      const relative = path => {
        if (base && !path.startsWith(base + '/')) throw new Error('This file is outside the package folder. Open it separately, or place it inside the package folder to preserve its source-quality references.')
        return base ? path.slice(base.length + 1) : path
      }
      const resourcePath = relative(pendingFile)
      pendingSchema.fields.forEach((field, i) => { field.type = root.querySelector(`[data-rd-field-type="${i}"]`).value; field.constraints = { required: root.querySelector(`[data-rd-required="${i}"]`).checked } })
      const replacing = resources.findIndex(item => item.resolvedPaths.length === 1 && item.resolvedPaths[0] === pendingFile)
      const stem = q('sheet-name').value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'table'
      let name = replacing < 0 ? stem : resources[replacing].name, suffix = 2
      while (resources.some((item, index) => index !== replacing && item.name === name)) name = `${stem}-${suffix++}`
      const resource = { name, title: q('sheet-name').value.trim() || 'Table', path: resourcePath, format: /\.tsv(?:\.gz)?$/i.test(pendingFile) ? 'tsv' : 'csv', schema: structuredClone(pendingSchema) }
      const definitions = resources.map(item => {
        const { paths, resolvedPaths, delimiter, ...description } = item
        const relativePaths = resolvedPaths.map(relative)
        return { ...description, path: relativePaths.length === 1 ? relativePaths[0] : relativePaths, schema: structuredClone(item.schema) }
      })
      if (replacing < 0) definitions.push(resource)
      else definitions[replacing] = resource
      const data = { ...descriptor, $schema: PACKAGE_PROFILE, name: descriptor?.name || 'research-data', resources: definitions }
      const tables = inspectPackage(data)
      for (const table of tables) table.resolvedPaths = table.paths.map(path => join(base, path))
      const assessment = await readQuality(data, tables, held, signal)
      if (!current(ticket) || held !== source) return
      descriptor = data; resources = tables; packageBase = base; quality = assessment
      await selectResource(replacing < 0 ? resources.length - 1 : replacing)
    } catch (error) { handleError(error, ticket) }
  })
  q('export').addEventListener('click', () => { if (descriptor) { downloadFile('datapackage.json', JSON.stringify(descriptor, null, 2) + '\n'); note(`Package description exported. Save it in ${packageBase || 'the selected folder'} beside the referenced data files.`) } })
  q('template').addEventListener('click', () => downloadFile('datapackage.json', JSON.stringify({ $schema: PACKAGE_PROFILE, name: 'my-research', resources: [{ name: 'measurements', path: 'measurements.csv', format: 'csv', schema: { fields: [{ name: 'timestamp', type: 'datetime' }, { name: 'sample_id', type: 'string' }, { name: 'value', type: 'number' }], missingValues: [''] } }] }, null, 2) + '\n'))
  for (const button of root.querySelectorAll('[data-rd-tab]')) button.addEventListener('click', async () => {
    activeTab = button.dataset.rdTab
    for (const item of root.querySelectorAll('[data-rd-tab]')) item.setAttribute('aria-pressed', String(item === button))
    q('grid').hidden = activeTab !== 'sheet'; q('chart-panel').hidden = activeTab !== 'chart'; if (activeTab === 'chart') await drawChart()
  })
  for (const key of ['x', 'y', 'series', 'chart-kind', 'compare']) q(key).addEventListener('change', () => { axesMeasured = true; drawChart() })
  // PROMPT B. Optional local folder connection, supplied by the workspace rather than
  // hardcoded to a researcher, study, domain, absolute path, or privileged desktop bridge.
  //
  // EVERY ARRIVAL SAYS WHAT IT FOUND. Three of the four ways this can end used
  // to `return` without a word: no pointer file, a pointer served as something
  // other than JSON, and a pointer with no url in it. A person arriving on this
  // page then read "A place for your research data" and had no way to tell an
  // empty workspace from a folder that did not answer -- which is exactly the
  // state somebody looking for their data is in when they say they cannot see
  // it. Each ending now names itself and names the way forward.
  const OPEN_OR_IMPORT = 'Open a folder or import files to begin. Your files stay on this computer.'
  ;(async () => {
    const initialEpoch = epoch
    const stale = () => destroyed || source || epoch !== initialEpoch
    note('Looking for the folder this workspace points at…')
    let config = null
    try {
      const response = await fetchImpl('/research-workspace.json', { cache: 'no-store' })
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
        if (!stale()) note(`This workspace has no saved folder. ${OPEN_OR_IMPORT}`)
        return
      }
      config = await response.json()
    } catch (error) {
      if (!stale()) note(`The saved folder could not be read. ${OPEN_OR_IMPORT} Reason: ${error.message}`)
      return
    }
    if (typeof config?.url !== 'string' || !config.url) {
      if (!stale()) note(`This workspace names no folder to open. ${OPEN_OR_IMPORT}`)
      return
    }
    // Somebody who opened their own folder while this was in flight keeps it.
    if (stale()) return
    note(`Opening the saved folder at ${config.url}…`)
    let connected
    try { connected = await connectedSource(config.url, { fetchImpl }) }
    catch (error) {
      if (!stale()) note(`The saved folder at ${config.url} did not answer, so open a folder or import files instead. Reason: ${error.message}`)
      return
    }
    if (stale()) return
    try { await setSource(connected) }
    catch (error) { if (!destroyed) note(`The saved folder at ${config.url} opened but could not be read, so open a folder or import files instead. Reason: ${error.message}`) }
  })()
  return { el: root, setSource, destroy() { destroyed = true; ++epoch; abort?.abort(); destroyChart() } }
}
