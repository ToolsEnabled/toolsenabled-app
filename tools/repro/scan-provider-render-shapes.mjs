/* READ ONLY over the owner's LIVE node-transcripts. Writes nothing there.
 * Prints PROVIDER NAMES AND COUNTS ONLY -- never a line of the owner's text and
 * never an account name, which node.json also carries.
 *
 * ITEM 5: what does the renderer actually get handed, per provider? The answer
 * decides which fixtures are worth pinning and which are invented worry. */
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]

const SHAPES = {
  fence: /^ {0,3}(`{3,}|~{3,})/m,
  fenceWithLanguage: /^ {0,3}`{3,}[A-Za-z][\w+-]*\s*$/m,
  fenceUnclosed: /^ {0,3}```[^\n]*\n(?![\s\S]*^ {0,3}```)/m,
  tildeFence: /^ {0,3}~{3,}/m,
  table: /^ {0,3}\|.*\|[ \t]*$/m,
  tableNoOuterPipes: /^ {0,3}[^|\n]+\|[^|\n]+$/m,
  heading: /^ {0,3}#{1,6}\s/m,
  headingNoSpace: /^ {0,3}#{1,6}[^\s#]/m,
  setextHeading: /^[^\n]+\n {0,3}(=+|-{2,})[ \t]*$/m,
  bullet: /^ {0,3}[-*+]\s/m,
  ordered: /^ {0,3}\d{1,9}[.)]\s/m,
  orderedFromN: /^ {0,3}(?!1[.)])\d{1,9}[.)]\s/m,
  nestedList: /^(?: {2,}|\t)[-*+\d]/m,
  taskList: /^ {0,3}[-*+] \[[ xX]\]\s/m,
  blockquote: /^ {0,3}>\s?/m,
  inlineCode: /`[^`\n]+`/,
  doubleBacktickCode: /``[^`]+``/,
  strong: /\*\*[^*\n]+\*\*/,
  emphasisUnderscore: /(^|\W)_[^_\n]+_(\W|$)/,
  strike: /~~[^~\n]+~~/,
  link: /\[[^\]\n]*\]\([^)\n]*\)/,
  linkWithTitle: /\[[^\]\n]*\]\([^)\n]+ "[^"]*"\)/,
  image: /!\[[^\]\n]*\]\([^)\n]*\)/,
  autolink: /<https?:\/\/[^>\s]+>/,
  bareUrl: /(^|\s)https?:\/\/\S+/,
  htmlTag: /<\/?[a-zA-Z][^>\n]*>/,
  htmlEntity: /&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d{1,6});/,
  hardBreakSpaces: /\S {2,}\n\S/,
  hardBreakBackslash: /\S\\n\S/,
  horizontalRule: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m,
  crlf: /\r\n/,
  tabIndent: /^\t/m,
  footnote: /\[\^[^\]\n]+\]/,
  mathDollar: /\$\$[\s\S]{1,200}\$\$/,
  angleBracketPath: /<[A-Za-z]:[\/]/,
  loneAsteriskSpan: /(^|[^*\w])\*[^*\n]{1,80}\*($|[^*\w])/,
  underscoreInWord: /\w_\w/,
}

const byProvider = new Map()
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  let provider = 'unrecorded'
  try { provider = JSON.parse(fs.readFileSync(path.join(at, 'node.json'), 'utf8')).provider || 'unrecorded' } catch { /* keep unrecorded */ }
  if (!byProvider.has(provider)) byProvider.set(provider, { nodes: 0, replies: 0, chars: 0, shapes: {} })
  const seen = byProvider.get(provider)
  seen.nodes += 1
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    if (!text.trim()) continue
    seen.replies += 1
    seen.chars += text.length
    for (const [shape, re] of Object.entries(SHAPES)) if (re.test(text)) seen.shapes[shape] = (seen.shapes[shape] || 0) + 1
  }
}
for (const [provider, seen] of [...byProvider].sort((a, b) => b[1].replies - a[1].replies)) {
  console.log(`\n## provider=${provider}  nodes=${seen.nodes}  agent replies=${seen.replies}  mean chars=${seen.replies ? Math.round(seen.chars / seen.replies) : 0}`)
  const rows = Object.entries(seen.shapes).sort((a, b) => b[1] - a[1])
  if (!rows.length) { console.log('   (no replies with text)'); continue }
  for (const [shape, n] of rows) console.log(`   ${shape.padEnd(22)} ${n}  (${(n / seen.replies * 100).toFixed(0)}%)`)
}
