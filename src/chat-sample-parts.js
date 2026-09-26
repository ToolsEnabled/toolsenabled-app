/* ONE EXAMPLE TURN THAT SHOWS EVERY KIND OF PART THE CHAT CAN DRAW.
 *
 * The plain-browser preview is where the chat's formatting is judged, and its
 * seeded lines were all short plain sentences: nothing in it was a table, a
 * code block, a tool call, a file change, a thought or a failure, so none of
 * those could be looked at without a live agent. This turn fills that gap.
 *
 * IT IS EXAMPLE DATA AND SAYS SO. It opens with the product's own note saying
 * nothing here ran, it is drawn only where the chat is already a labelled
 * demonstration (buildChat's `sampleConversation: true`), and only in a plain
 * browser: never in the desktop app, never on the site's own host bridge and
 * never under a node test, so no surface that shows real work can grow it.
 *
 * IT GOES THROUGH THE PUBLIC DOORS -- addNote, addOwnerMessage, addThinking,
 * addAction, addDiff, openStream -- in the order a real turn uses them, so
 * what the preview shows is what a live turn paints, not a second renderer.
 */

import { DIFF_EXAMPLE_COUNTS, DIFF_EXAMPLE_PATCH, DIFF_EXAMPLE_PATH } from './diff-split-example.js'

export function chatSamplePartsWanted(env = globalThis) {
  if (env?.process?.versions?.node) return false
  const win = env?.window
  if (!win || typeof win.document !== 'object') return false
  return !win.mcShell
}

const OUTPUT = Array.from({ length: 34 }, (_, index) => index < 31
  ? `  ok ${index + 1} - page ${Math.floor(index / 4) + 1} row ${(index % 4) + 1} totals match`
  : index === 31 ? '  not ok 32 - page 9 carries the subtotal twice' : index === 32 ? '    expected 1204.50, found 2409.00' : '# 33 checks, 1 did not pass').join('\n')

const CODE = [
  'def page_totals(rows, per_page):',
  '    """Sum each page once; the carried line is display only."""',
  '    pages, current, carried = [], [], 0',
  '    for row in rows:',
  '        if len(current) == per_page:',
  '            total = sum(r.amount for r in current)',
  '            pages.append(Page(rows=current, total=total, carried=carried))',
  '            carried += total',
  '            current = []',
  '        current.append(row)',
  '    if current:',
  '        total = sum(r.amount for r in current)',
  '        pages.append(Page(rows=current, total=total, carried=carried))',
  '    return pages',
  '',
  '',
  'def grand_total(pages):',
  '    # The carried amount is shown on the next page, never added again.',
  '    return sum(page.total for page in pages)',
  '',
  '',
  'def render(pages):',
  '    for number, page in enumerate(pages, start=1):',
  '        yield f"Page {number}"',
  '        if page.carried:',
  '            yield f"  Carried forward  {page.carried:>10.2f}"',
  '        for row in page.rows:',
  '            yield f"  {row.label:<30} {row.amount:>10.2f}"',
  '        yield f"  Page total       {page.total:>10.2f}"',
  '    yield f"Grand total        {grand_total(pages):>10.2f}"',
].join('\n')

const REPLY = `## What was wrong

The subtotal carried from one page to the next was **added again** when the next page was summed, so every page after the first counted it twice. The fix keeps the carried amount as a display line only. See the [reporting notes](https://example.com/notes) for the layout rules.

- Page sums now read only their own rows
  - the carried line is shown, never summed
  - the grand total is the sum of page totals
- The export test covers a nine-page invoice

| Page | Before | After |
|---|---:|---:|
| 1 | 1,204.50 | 1,204.50 |
| 2 | 2,409.00 | 1,188.25 |
| 9 | 9,630.75 | 1,204.50 |

\`\`\`python
${CODE}
\`\`\`

> The totals on screen and in the file now agree on every page.

> [!NOTE]
> This whole turn is example data drawn in the preview. Nothing was read, run or changed.

- [x] Fix the page sums
- [ ] Run the full export on the real invoices`

export function showChatSampleParts(root, { now = Date.now() } = {}) {
  if (!root || typeof root.openStream !== 'function') return
  const at = offset => now - (90 - offset) * 1000
  root.addNote?.('Example turn: it shows each kind of part a reply can have. Nothing in it was read, run or changed.', { at: at(0) })
  root.addOwnerMessage?.('Why do the invoice totals drift after a page break?', { at: at(2) })
  root.addThinking?.('The drift starts on page two, so the carried subtotal is the first suspect. Read the paginator, run the export test, then change the sum.', { at: at(4) })
  const rows = [
    { id: 'sample-parts:read', kind: 'call', tool: 'Read', detail: 'src/invoice/paginate.py', state: 'Done', stateKey: 'done', body: 'src/invoice/paginate.py\n\n' + CODE.split('\n').slice(0, 14).join('\n'), durationMs: 180 },
    { id: 'sample-parts:test', kind: 'call', tool: 'Run', detail: 'python -m pytest tests/test_export.py -q', state: 'Did not pass', stateKey: 'undone', body: 'python -m pytest tests/test_export.py -q\n\n' + OUTPUT, durationMs: 6400 },
    { id: 'sample-parts:edit', kind: 'call', tool: 'Edit', detail: 'src/invoice/paginate.py', state: 'Done', stateKey: 'done', body: '', durationMs: 90 },
    { id: 'sample-parts:check', kind: 'call', tool: 'Run', detail: 'python -m pytest tests/test_export.py -q', state: 'Done', stateKey: 'done', body: 'python -m pytest tests/test_export.py -q\n\n33 checks passed in 6.1s', durationMs: 6100 },
  ]
  for (const row of rows) root.addAction?.({ ...row, at: at(10) })
  /* Tool rows are painted on the chat's next frame (addAction batches), so
     the file change and the answer follow two frames later, as they would. */
  const frame = typeof globalThis.requestAnimationFrame === 'function'
    ? fn => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(fn))
    : fn => setTimeout(fn, 32)
  frame(() => {
    /* The edit carries its patch, so pressing the file in Changes opens the
       side-by-side view on the example file (src/diff-split-example.js). */
    root.addDiff?.({
      source: 'session-file-change', id: 'sample-parts:diff', at: at(40), activeIndex: 0,
      files: [{ path: DIFF_EXAMPLE_PATH, status: 'modified', ...DIFF_EXAMPLE_COUNTS }],
      patches: [{ path: DIFF_EXAMPLE_PATH, diff: DIFF_EXAMPLE_PATCH }],
    })
    const stream = root.openStream({ at: at(60) })
    stream.close(REPLY)
  })
}
