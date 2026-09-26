/* THE SIDE-BY-SIDE DIFF, AS DATA. No DOM, no clock, no globals: every export
 * here takes text and returns plain values, so a suite can hold each decision
 * with a literal. src/diff-split-view.js draws what this returns.
 *
 * ONE LINE DIFF, COMPUTED ONCE. Patience first (lines that occur once on each
 * side anchor the match, which keeps a moved brace from pairing with the wrong
 * block), Myers inside the gaps between anchors. Myers is capped: a region
 * whose edit distance passes the cap is shown as one replaced block rather
 * than stalling the window, and the result says so (`approximate`).
 *
 * ROWS PAIR ACROSS. A run of removed lines followed by added lines is one
 * change: the first removed line sits beside the first added line, and so on;
 * what is left over sits beside an empty cell. Word highlights are computed
 * only for a paired row, and only when the two lines still share enough to
 * make the highlight readable. */
import { CHANGE_LIMITS, parseUnifiedPatch } from './session-change-patches.js'

export const SPLIT_LIMITS = Object.freeze({
  context: 3,        // unchanged lines kept around each change
  minFold: 4,        // a hidden run shorter than this is simply shown
  maxCost: 1200,     // Myers edit distance per region before it becomes a block
  wordChars: 2000,   // longest line that gets word highlights
  wordTokens: 400,
  foldStep: 500,     // unchanged lines revealed per press
  pageRows: 1500,    // rows drawn before "Show more"
})

const EQUAL = 0, DELETE = 1, INSERT = 2

/** Lines without their endings, and whether the text ended with one. */
export function splitLines(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (source === '') return { lines: [], finalNewline: true }
  const finalNewline = source.endsWith('\n')
  const lines = (finalNewline ? source.slice(0, -1) : source).split('\n')
  return { lines, finalNewline }
}

/* Myers' O(ND) greedy walk over a[a0..a0+n) and b[b0..b0+m), with the trace
   kept for the walk back. Returns ops (EQUAL/DELETE/INSERT per step), or null
   once the distance passes maxCost. */
function myers(a, a0, n, b, b0, m, maxCost) {
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  const limit = Math.min(max, maxCost)
  let found = -1
  for (let d = 0; d <= limit && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return null
  const ops = []
  let x = n, y = m
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1]
    const at = kk => previous[kk + d - 1]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const startX = down ? previousX : previousX + 1
    while (x > startX) { ops.push(EQUAL); x--; y-- }
    ops.push(down ? INSERT : DELETE)
    x = previousX
    y = previousX - previousK
  }
  while (x > 0 && y > 0) { ops.push(EQUAL); x--; y-- }
  return ops.reverse()
}

/* Longest increasing subsequence of `values`, as indices into it. */
function increasingRun(values) {
  const tails = [], links = new Int32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let low = 0, high = tails.length
    while (low < high) { const mid = (low + high) >> 1; if (values[tails[mid]] < values[i]) low = mid + 1; else high = mid }
    links[i] = low > 0 ? tails[low - 1] : -1
    tails[low] = i
  }
  const run = []
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = links[i]) run.push(i)
  return run.reverse()
}

/**
 * The edit script between two line arrays, as runs of { kind, count } where
 * kind is 'equal', 'delete' or 'insert'. `approximate` is true when some region
 * was too different to match line by line and is reported as delete + insert.
 */
export function diffLines(before, after, { maxCost = SPLIT_LIMITS.maxCost } = {}) {
  const ids = new Map()
  const intern = line => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id) } return id }
  const a = Int32Array.from(before, intern)
  const b = Int32Array.from(after, intern)
  const ops = []
  let approximate = false
  const push = (kind, count) => { for (let i = 0; i < count; i++) ops.push(kind) }
  const walk = (a0, a1, b0, b1) => {
    let head = 0
    while (a0 + head < a1 && b0 + head < b1 && a[a0 + head] === b[b0 + head]) head++
    let tail = 0
    while (a1 - tail > a0 + head && b1 - tail > b0 + head && a[a1 - 1 - tail] === b[b1 - 1 - tail]) tail++
    push(EQUAL, head)
    const s0 = a0 + head, s1 = a1 - tail, t0 = b0 + head, t1 = b1 - tail
    if (s0 === s1 || t0 === t1) { push(DELETE, s1 - s0); push(INSERT, t1 - t0); push(EQUAL, tail); return }
    // Patience anchors: lines that occur exactly once on each side.
    const seen = new Map()
    for (let i = s0; i < s1; i++) { const e = seen.get(a[i]); if (e) e.ca++; else seen.set(a[i], { ca: 1, cb: 0, ia: i, ib: -1 }) }
    for (let j = t0; j < t1; j++) { const e = seen.get(b[j]); if (e) { e.cb++; e.ib = j } }
    const unique = []
    for (let i = s0; i < s1; i++) { const e = seen.get(a[i]); if (e.ca === 1 && e.cb === 1) unique.push(e) }
    const anchors = increasingRun(unique.map(e => e.ib)).map(index => unique[index])
    if (!anchors.length) {
      const script = myers(a, s0, s1 - s0, b, t0, t1 - t0, maxCost)
      if (script) ops.push(...script)
      else { approximate = true; push(DELETE, s1 - s0); push(INSERT, t1 - t0) }
    } else {
      let i = s0, j = t0
      for (const anchor of anchors) {
        walk(i, anchor.ia, j, anchor.ib)
        ops.push(EQUAL)
        i = anchor.ia + 1; j = anchor.ib + 1
      }
      walk(i, s1, j, t1)
    }
    push(EQUAL, tail)
  }
  walk(0, a.length, 0, b.length)
  const runs = []
  for (const op of ops) {
    const kind = op === EQUAL ? 'equal' : op === DELETE ? 'delete' : 'insert'
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.count++
    else runs.push({ kind, count: 1 })
  }
  return { runs, approximate }
}

/**
 * Aligned rows from an edit script. Each row is
 *   { kind: 'same' | 'change' | 'removed' | 'added', ln, rn, lt, rt }
 * where ln/rn are 1-based line numbers (null for an empty cell) and lt/rt the
 * line text. Removed and added lines in one change block pair positionally.
 */
export function alignRows(before, after, runs, { beforeStart = 1, afterStart = 1 } = {}) {
  const rows = []
  let i = 0, j = 0
  let removed = [], added = []
  const flush = () => {
    const pairs = Math.max(removed.length, added.length)
    for (let p = 0; p < pairs; p++) {
      const l = p < removed.length ? removed[p] : null
      const r = p < added.length ? added[p] : null
      rows.push({
        kind: l !== null && r !== null ? 'change' : l !== null ? 'removed' : 'added',
        ln: l === null ? null : l + beforeStart, rn: r === null ? null : r + afterStart,
        lt: l === null ? null : before[l], rt: r === null ? null : after[r],
      })
    }
    removed = []; added = []
  }
  for (const run of runs) {
    if (run.kind === 'equal') {
      flush()
      for (let c = 0; c < run.count; c++, i++, j++) rows.push({ kind: 'same', ln: i + beforeStart, rn: j + afterStart, lt: before[i], rt: after[j] })
    } else if (run.kind === 'delete') for (let c = 0; c < run.count; c++) removed.push(i++)
    else for (let c = 0; c < run.count; c++) added.push(j++)
  }
  flush()
  return rows
}

/**
 * Which rows are drawn and which fold. Returns blocks:
 *   { type: 'rows', from, to }  rows[from..to) drawn
 *   { type: 'fold', from, to }  rows[from..to) unchanged and hidden
 * A hidden run shorter than minFold is drawn instead: folding two lines saves
 * nothing and costs a press.
 */
export function foldRows(rows, { context = SPLIT_LIMITS.context, minFold = SPLIT_LIMITS.minFold } = {}) {
  const keep = new Uint8Array(rows.length)
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].kind === 'same') continue
    for (let near = Math.max(0, index - context); near <= Math.min(rows.length - 1, index + context); near++) keep[near] = 1
  }
  const blocks = []
  let index = 0
  while (index < rows.length) {
    const start = index
    const shown = keep[index] === 1
    while (index < rows.length && (keep[index] === 1) === shown) index++
    const type = shown || index - start < minFold ? 'rows' : 'fold'
    const last = blocks[blocks.length - 1]
    if (type === 'rows' && last?.type === 'rows') last.to = index
    else blocks.push({ type, from: start, to: index })
  }
  return blocks
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

/**
 * Changed words within one paired line. Returns { left, right } as arrays of
 * { text, changed } segments, or null when the lines are too long or share
 * too little for a word highlight to read as anything but noise.
 */
export function wordDiff(before, after) {
  const left = String(before ?? ''), right = String(after ?? '')
  if (left.length > SPLIT_LIMITS.wordChars || right.length > SPLIT_LIMITS.wordChars) return null
  const a = left.match(TOKEN) || [], b = right.match(TOKEN) || []
  if (a.length > SPLIT_LIMITS.wordTokens || b.length > SPLIT_LIMITS.wordTokens) return null
  const { runs } = diffLines(a, b, { maxCost: 200 })
  const leftMarks = [], rightMarks = []
  let i = 0, j = 0, shared = 0
  for (const run of runs) {
    for (let c = 0; c < run.count; c++) {
      if (run.kind === 'equal') { shared += a[i].trim() ? a[i].length : 0; leftMarks.push(false); rightMarks.push(false); i++; j++ }
      else if (run.kind === 'delete') { leftMarks.push(true); i++ }
      else { rightMarks.push(true); j++ }
    }
  }
  const longer = Math.max(left.replace(/\s/g, '').length, right.replace(/\s/g, '').length)
  if (!longer || shared / longer < 0.3) return null
  return { left: segments(a, leftMarks), right: segments(b, rightMarks) }
}

/* Adjacent tokens with the same mark merge; a space between two changed
   tokens joins them, so "foo bar" changing to "baz qux" is one highlight. */
function segments(tokens, marks) {
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!marks[i] && marks[i - 1] && marks[i + 1] && !tokens[i].trim()) marks[i] = true
  }
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const last = out[out.length - 1]
    if (last && last.changed === marks[i]) last.text += tokens[i]
    else out.push({ text: tokens[i], changed: marks[i] })
  }
  return out
}

function stats(rows) {
  let added = 0, removed = 0
  for (const row of rows) {
    if (row.lt !== null && row.kind !== 'same') removed++
    if (row.rt !== null && row.kind !== 'same') added++
  }
  return { added, removed }
}

/**
 * The whole-file model: both versions in full, aligned and folded.
 * { source: 'full', rows, blocks, added, removed, approximate, identical,
 *   beforeLines, afterLines, beforeFinalNewline, afterFinalNewline }
 */
export function buildFullSplit(beforeText, afterText, options = {}) {
  const before = splitLines(beforeText), after = splitLines(afterText)
  const { runs, approximate } = diffLines(before.lines, after.lines, options)
  const rows = alignRows(before.lines, after.lines, runs)
  const counts = stats(rows)
  return {
    source: 'full', rows, blocks: foldRows(rows, options), ...counts, approximate,
    identical: counts.added === 0 && counts.removed === 0,
    beforeLines: before.lines.length, afterLines: after.lines.length,
    beforeFinalNewline: before.finalNewline, afterFinalNewline: after.finalNewline,
  }
}

/**
 * The fallback model when the whole earlier version is not available: each
 * recorded hunk's old and new lines, paired the same way, with a header per
 * hunk. Numbers are each recorded edit's own, as the unified preview says.
 * A record that cannot be read line by line becomes a note, never a guess.
 */
export function buildPatchSplit(patches, { maximum = CHANGE_LIMITS.previewLines } = {}) {
  const rows = [], blocks = []
  const records = (Array.isArray(patches) ? patches : []).filter(record => typeof record?.diff === 'string')
  let limited = false
  records.forEach((record, index) => {
    if (limited) return
    if (records.length > 1) blocks.push({ type: 'record', text: `Recorded edit ${index + 1} of ${records.length}` })
    const hunks = parseUnifiedPatch(record.diff)
    if (!hunks) { blocks.push({ type: 'note', text: 'This recorded edit could not be read line by line.' }); return }
    for (const hunk of hunks) {
      if (rows.length >= maximum) { limited = true; return }
      blocks.push({ type: 'hunk', before: hunk.oldStart, beforeCount: hunk.oldCount, after: hunk.newStart, afterCount: hunk.newCount })
      const left = [], right = [], runs = []
      for (const line of hunk.lines) {
        const text = line.text.replace(/\n$/, '')
        const kind = line.kind === ' ' ? 'equal' : line.kind === '-' ? 'delete' : 'insert'
        if (kind !== 'insert') left.push(text)
        if (kind !== 'delete') right.push(text)
        const last = runs[runs.length - 1]
        if (last && last.kind === kind) last.count++
        else runs.push({ kind, count: 1 })
      }
      const from = rows.length
      /* A hunk that starts at line 0 is an insertion at the top of the file:
         its first new line is line 1, and it has no old lines to number. */
      rows.push(...alignRows(left, right, runs, { beforeStart: Math.max(1, hunk.oldStart), afterStart: Math.max(1, hunk.newStart) }))
      blocks.push({ type: 'rows', from, to: rows.length })
    }
  })
  return { source: 'patch', rows, blocks, ...stats(rows), limited, maximum, approximate: false, identical: false }
}

/**
 * The fallback for edits that carried their own before and after text but no
 * line numbers (an assistant's find-and-replace). Each edit's two snippets are
 * aligned like a file; the numbers are left blank because the snippet's place
 * in the file was never recorded.
 */
export function buildEditSplit(edits) {
  const rows = [], blocks = []
  const records = (Array.isArray(edits) ? edits : []).filter(edit => typeof edit?.oldString === 'string' && typeof edit?.newString === 'string')
  records.forEach((edit, index) => {
    blocks.push({ type: 'record', text: records.length > 1 ? `Recorded edit ${index + 1} of ${records.length}` : 'Recorded edit' })
    const before = splitLines(edit.oldString).lines, after = splitLines(edit.newString).lines
    const from = rows.length
    for (const row of alignRows(before, after, diffLines(before, after).runs)) rows.push({ ...row, ln: null, rn: null })
    blocks.push({ type: 'rows', from, to: rows.length })
  })
  return { source: 'edits', rows, blocks, ...stats(rows), limited: false, approximate: false, identical: false }
}

/**
 * Reveal part of a fold. Returns new blocks with fold `index` opened by up to
 * `step` lines from its top; the rest stays folded. Blocks are not mutated.
 */
export function expandFold(blocks, index, step = SPLIT_LIMITS.foldStep) {
  const fold = blocks[index]
  if (!fold || fold.type !== 'fold') return blocks
  const open = Math.min(fold.to - fold.from, step)
  const next = blocks.slice(0, index)
  next.push({ type: 'rows', from: fold.from, to: fold.from + open })
  if (fold.from + open < fold.to) next.push({ type: 'fold', from: fold.from + open, to: fold.to })
  next.push(...blocks.slice(index + 1))
  // Merge touching row blocks so the drawn list stays one run per region.
  const merged = []
  for (const block of next) {
    const last = merged[merged.length - 1]
    if (block.type === 'rows' && last?.type === 'rows' && last.to === block.from) merged[merged.length - 1] = { ...last, to: block.to }
    else merged.push(block)
  }
  return merged
}
