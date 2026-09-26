/* THE PLAIN-BROWSER EXAMPLE FOR THE SIDE-BY-SIDE DIFF.
 *
 * The preview on a plain browser has no desktop bridge, so a file pressed in
 * Changes has nothing to read and the Compare window could only refuse. The
 * preview's example turn (src/chat-sample-parts.js) already reports one
 * labelled example edit to src/invoice/paginate.py; this module holds that
 * file as it stands after the edit, and the edit's patch, so the window can
 * show the side-by-side view there.
 *
 * IT CANNOT REACH A REAL SESSION. createCompareFilesDoor() in
 * src/diff-editor.js uses it only when there is no bridge at all, the page is
 * a plain browser (not the desktop shell, not a node test), and the file
 * pressed is this exact example path. It answers read-only and refuses every
 * save and every file choice, and it is marked `example` so the window says
 * what it is. */

export const DIFF_EXAMPLE_PATH = 'src/invoice/paginate.py'
export const DIFF_EXAMPLE_COUNTS = Object.freeze({ added: 6, removed: 4 })

/* One literal per line, as src/chat-sample-parts.js holds its code: this is
   file text, not copy, and a single long literal reads as one sentence to
   tools/check-plain-language.mjs. */
const AFTER = [
  "\"\"\"Split invoice rows into printed pages and total them.",
  "",
  "A page holds at most `per_page` rows. Every page after the first opens with",
  "the amount carried forward from the pages before it, so a reader can check",
  "each page on its own.",
  "\"\"\"",
  "from dataclasses import dataclass, field",
  "from decimal import Decimal",
  "from typing import Iterable, Iterator, List",
  "",
  "",
  "@dataclass(frozen=True)",
  "class Row:",
  "    label: str",
  "    amount: Decimal",
  "",
  "",
  "@dataclass",
  "class Page:",
  "    rows: List[Row] = field(default_factory=list)",
  "    total: Decimal = Decimal(\"0\")",
  "    carried: Decimal = Decimal(\"0\")",
  "",
  "    @property",
  "    def is_empty(self) -> bool:",
  "        return not self.rows",
  "",
  "",
  "def chunk(rows: Iterable[Row], per_page: int) -> Iterator[List[Row]]:",
  "    \"\"\"Yield lists of at most per_page rows, in order.\"\"\"",
  "    if per_page < 1:",
  "        raise ValueError(\"per_page must be at least 1\")",
  "    current: List[Row] = []",
  "    for row in rows:",
  "        if len(current) == per_page:",
  "            yield current",
  "            current = []",
  "        current.append(row)",
  "    if current:",
  "        yield current",
  "",
  "",
  "def page_totals(rows: Iterable[Row], per_page: int) -> List[Page]:",
  "    \"\"\"Sum each page once. The carried amount is shown, never added again.\"\"\"",
  "    pages: List[Page] = []",
  "    carried = Decimal(\"0\")",
  "    for group in chunk(rows, per_page):",
  "        total = sum((r.amount for r in group), Decimal(\"0\"))",
  "        pages.append(Page(rows=group, total=total, carried=carried))",
  "        carried += total",
  "    return pages",
  "",
  "",
  "def grand_total(pages: List[Page]) -> Decimal:",
  "    \"\"\"The amount due: the sum of every page's own total.\"\"\"",
  "    return sum((page.total for page in pages), Decimal(\"0\"))",
  "",
  "",
  "def money(value: Decimal) -> str:",
  "    return f\"{value:>12,.2f}\"",
  "",
  "",
  "def render(pages: List[Page]) -> Iterator[str]:",
  "    for number, page in enumerate(pages, start=1):",
  "        yield f\"Page {number}\"",
  "        if page.carried:",
  "            yield f\"  Carried forward {money(page.carried)}\"",
  "        for row in page.rows:",
  "            yield f\"  {row.label:<30} {money(row.amount)}\"",
  "        yield f\"  Page total      {money(page.total)}\"",
  "        if page.carried:",
  "            yield f\"  Running total   {money(page.carried + page.total)}\"",
  "        yield \"\"",
  "    yield f\"Grand total       {money(grand_total(pages))}\"",
  "",
  "",
  "def export(rows: Iterable[Row], per_page: int, path: str) -> None:",
  "    pages = page_totals(rows, per_page)",
  "    with open(path, \"w\", encoding=\"utf-8\") as handle:",
  "        for line in render(pages):",
  "            handle.write(line + \"\\n\")",
  "",
  "",
  "if __name__ == \"__main__\":",
  "    import sys",
  "",
  "    sample = [Row(f\"Item {n}\", Decimal(n) * Decimal(\"12.50\")) for n in range(1, 40)]",
  "    export(sample, per_page=int(sys.argv[1]) if len(sys.argv) > 1 else 10, path=\"invoice.txt\")",
].join('\n') + '\n'

export const DIFF_EXAMPLE_PATCH = [
  "--- a/src/invoice/paginate.py",
  "+++ b/src/invoice/paginate.py",
  "@@ -41,19 +41,19 @@",
  " ",
  " ",
  " def page_totals(rows: Iterable[Row], per_page: int) -> List[Page]:",
  "-    \"\"\"Sum each page, carrying the running total to the next page.\"\"\"",
  "+    \"\"\"Sum each page once. The carried amount is shown, never added again.\"\"\"",
  "     pages: List[Page] = []",
  "     carried = Decimal(\"0\")",
  "     for group in chunk(rows, per_page):",
  "-        total = sum((r.amount for r in group), Decimal(\"0\")) + carried",
  "+        total = sum((r.amount for r in group), Decimal(\"0\"))",
  "         pages.append(Page(rows=group, total=total, carried=carried))",
  "         carried += total",
  "     return pages",
  " ",
  " ",
  " def grand_total(pages: List[Page]) -> Decimal:",
  "-    \"\"\"The amount due: the last page's total already includes the others.\"\"\"",
  "-    return pages[-1].total if pages else Decimal(\"0\")",
  "+    \"\"\"The amount due: the sum of every page's own total.\"\"\"",
  "+    return sum((page.total for page in pages), Decimal(\"0\"))",
  " ",
  " ",
  " def money(value: Decimal) -> str:",
  "@@ -68,6 +68,8 @@",
  "         for row in page.rows:",
  "             yield f\"  {row.label:<30} {money(row.amount)}\"",
  "         yield f\"  Page total      {money(page.total)}\"",
  "+        if page.carried:",
  "+            yield f\"  Running total   {money(page.carried + page.total)}\"",
  "         yield \"\"",
  "     yield f\"Grand total       {money(grand_total(pages))}\"",
  " ",
].join('\n') + '\n'

export function diffExampleWanted(env = globalThis) {
  if (env?.process?.versions?.node) return false
  const win = env?.window
  if (!win || typeof win.document !== 'object') return false
  return !win.mcShell && !win.mcDiff
}

export function isDiffExample(selection, env = globalThis) {
  return selection?.path === DIFF_EXAMPLE_PATH && diffExampleWanted(env)
}

/* A stand-in with the bridge's shape, for the example path only. */
export function exampleCompareFiles() {
  const refuse = async () => ({ ok: false, code: 'MC_DIFF_CHANGE_READ_UNAVAILABLE' })
  return {
    readChange: async path => path === DIFF_EXAMPLE_PATH
      ? { ok: true, example: true, path, text: AFTER, exists: true, readOnly: true, modifiedMs: 0, bytes: AFTER.length }
      : refuse(),
    stamp: refuse,
    save: refuse,
    pick: refuse,
  }
}
