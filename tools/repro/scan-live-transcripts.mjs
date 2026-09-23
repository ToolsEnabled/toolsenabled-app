/* READ ONLY over the owner's LIVE node-transcripts. It writes nothing there and
   prints SHAPE COUNTS only -- never a line of the owner's text, never a value.
   Its job is to say what the renderer is actually asked to draw per provider. */
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const MARKS = {
  fence: /^ {0,3}(`{3,}|~{3,})/m,
  table: /^ {0,3}\|.*\|\s*$/m,
  tableDelimiter: /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/m,
  heading: /^ {0,3}#{1,6}\s/m,
  bullet: /^ {0,3}[-*+]\s/m,
  ordered: /^ {0,3}\d{1,9}[.)]\s/m,
  inlineCode: /`[^`\n]+`/,
  strong: /\*\*[^*\n]+\*\*/,
  strike: /~~[^~\n]+~~/,
  link: /\[[^\]\n]+\]\([^)\n]+\)/,
  bareUrl: /https?:\/\/\S+/,
  blockquote: /^ {0,3}>\s/m,
  hardBreak: /\S {2,}\n\S/,
  htmlish: /<[a-zA-Z][^>\n]*>/,
  crlf: /\r\n/,
  tabIndent: /^\t/m,
  nbsp: /\u00a0/,
  loneAsterisk: /(^|[^*\w])\*([^*\n]{1,80})\*($|[^*\w])/,
  underscoreWord: /\w_\w/,
  unclosedFence: /^ {0,3}```[^\n]*\n(?![\s\S]*^ {0,3}```)/m,
}

const byWho = new Map()
let files = 0, records = 0
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json')) continue
    files += 1
    let record
    try { record = JSON.parse(fs.readFileSync(path.join(at, name), 'utf8')) } catch { continue }
    const text = typeof record?.text === 'string' ? record.text : ''
    const who = String(record?.who ?? 'undefined')
    records += 1
    if (!byWho.has(who)) byWho.set(who, { lines: 0, chars: 0, marks: {} })
    const seen = byWho.get(who)
    seen.lines += 1
    seen.chars += text.length
    for (const [mark, re] of Object.entries(MARKS)) if (re.test(text)) seen.marks[mark] = (seen.marks[mark] || 0) + 1
  }
}
console.log(`# scanned ${files} record files, ${records} records, ${byWho.size} distinct who values`)
for (const [who, seen] of [...byWho].sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`\n## who=${JSON.stringify(who)}  lines=${seen.lines}  meanChars=${Math.round(seen.chars / seen.lines)}`)
  const marks = Object.entries(seen.marks).sort((a, b) => b[1] - a[1])
  console.log(marks.length ? marks.map(([m, n]) => `${m}:${n}`).join('  ') : '  (no markdown constructs)')
}
