// Render the report's own method and run sections inside the Research page.
//
// `researchPageSections` in benchmark/report.mjs returns the blocks the venue
// report renders for its task-construction, condition, run-walkthrough and
// per-trial sections. This module turns those blocks into page markup. The
// page and the exported report therefore say the same thing about the same
// run, because they are the same words from the same generator: this file
// chooses markup, never content.
//
// Nothing here reads a project, a journal or a setting. It escapes every value
// it is given and emits no script and no remote resource, so it is safe to
// place its output into the page with innerHTML, as the rest of this page does.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

// A report table id also says what the table is about. The page turns that into
// an addressable attribute so a reader, a test or an assistive technology can
// reach one task's layers or one attempt's evidence directly.
function tableAttributes(id) {
  if (id === 'run-walkthrough') return ' data-bench-walkthrough-table'
  if (id === 'condition-collection') return ' data-bench-condition-table'
  if (id.startsWith('composition-')) return ' data-bench-composition-task="' + esc(id.slice('composition-'.length)) + '"'
  if (id.startsWith('source-map-')) return ' data-bench-source-map="' + esc(id.slice('source-map-'.length)) + '"'
  if (id.startsWith('trial-')) return ' data-bench-trial-fields="' + esc(id.slice('trial-'.length)) + '"'
  if (id.startsWith('grade-')) return ' data-bench-trial-grade="' + esc(id.slice('grade-'.length)) + '"'
  return ''
}

function tableMarkup(block) {
  const headers = block.headers.map(header => '<th>' + esc(header) + '</th>').join('')
  const rows = block.rows.map(row => '<tr>' + row.map((cell, column) =>
    column === 0 ? '<th>' + esc(cell) + '</th>' : '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('')
  return '<div class="bench-table-scroll" tabindex="0" role="region" aria-label="' + esc(block.id.replaceAll('-', ' ')) + ' table">'
    + '<table' + tableAttributes(block.id) + '><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
}

// The report caps a verbatim block and points at the retained file. The page
// shows the same capped text, and, because it already holds the full text in
// memory, offers the rest instead of sending the reader to a file it cannot
// open from here.
function verbatimMarkup(block) {
  const shown = block.preview || { text: block.text, truncated: false, length: String(block.text ?? '').length }
  const note = shown.truncated
    ? 'Showing the first ' + shown.text.length + ' of ' + shown.length + ' characters. The complete text is below and in the exported report'
      + (block.note ? ' at ' + block.note : '') + '.'
    : block.note ? 'Full text also retained in the exported report at ' + block.note + '.' : null
  // The retained-file path names exactly which report bytes this block shows,
  // so a reader or a check can compare one block with one retained file
  // instead of searching the page for a string that may appear anywhere.
  const named = block.note ? ' data-bench-verbatim="' + esc(block.note) + '"' : ''
  const full = shown.truncated
    ? '<details><summary>Show the complete ' + esc(shown.length) + ' characters</summary><pre tabindex="0" data-bench-verbatim-full>' + esc(block.text) + '</pre></details>'
    : ''
  return '<h5>' + esc(block.title) + '</h5><pre tabindex="0"' + named + '>' + esc(shown.text) + '</pre>'
    + (note ? '<p class="bench-muted">' + esc(note) + '</p>' : '') + full
}

// A link in the report points into the exported package. On the page that file
// does not exist yet, so the path is named as retained evidence rather than
// offered as a link that would not open.
const blockMarkup = block => {
  if (block.kind === 'heading') { const level = Math.min(6, (block.level || 2) + 1); return '<h' + level + '>' + esc(block.title) + '</h' + level + '>' }
  if (block.kind === 'paragraph') return '<p>' + esc(block.text) + '</p>'
  if (block.kind === 'table') return tableMarkup(block)
  if (block.kind === 'verbatim') return verbatimMarkup(block)
  if (block.kind === 'link') return '<p class="bench-muted">' + esc(block.label) + ' Retained in the exported report at ' + esc(block.href) + '.</p>'
  if (block.kind === 'list') return '<ul>' + block.values.map(value => '<li>' + esc(value) + '</li>').join('') + '</ul>'
  return ''
}

// Blocks arrive flat. A group marker opens a section for one task or one
// attempt and every following block belongs to it until the next marker.
function groupedMarkup(blocks, attribute) {
  const parts = []
  let open = false
  for (const block of blocks) {
    if (block.kind === 'group') {
      if (open) parts.push('</section>')
      parts.push('<section ' + attribute(block) + '>')
      open = true
      continue
    }
    parts.push(blockMarkup(block))
  }
  if (open) parts.push('</section>')
  return parts.join('')
}

// Items 4 and 5: how every prompt was built, layer by layer, and exactly what
// each condition sends. Available as soon as a project is frozen.
export function methodMarkup(blocks) {
  if (!blocks || !blocks.length) return ''
  const split = blocks.findIndex(block => block.kind === 'heading' && block.level === 2 && /conditions and collection/i.test(block.title))
  const construction = split === -1 ? blocks : blocks.slice(0, split)
  const collection = split === -1 ? [] : blocks.slice(split)
  return '<section data-bench-method-composition><h3>How each prompt was built</h3>'
    + '<p>These are the composition layers and the complete compiled prompt for this frozen project, the same content the exported research report carries.</p>'
    + groupedMarkup(construction.slice(1), block => 'data-bench-composition-group="' + esc(block.key) + '"')
    + '</section>'
    + (collection.length ? '<section data-bench-method-conditions>' + collection.map(blockMarkup).join('') + '</section>' : '')
}

// Items 8 and 9: the journal in order, then every attempt with what was sent,
// what came back verbatim, and how it was graded.
export function runMarkup(blocks) {
  if (!blocks || !blocks.length) return ''
  const split = blocks.findIndex(block => block.kind === 'group')
  const walkthrough = split === -1 ? blocks : blocks.slice(0, split)
  const trials = split === -1 ? [] : blocks.slice(split)
  return '<section data-bench-walkthrough>' + walkthrough.map(blockMarkup).join('') + '</section>'
    + (trials.length ? '<section data-bench-trial-evidence><h3>Per-trial evidence</h3>'
      + groupedMarkup(trials, block => 'data-bench-trial="' + esc(block.key) + '"') + '</section>' : '')
}
