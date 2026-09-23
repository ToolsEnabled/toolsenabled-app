/* READ ONLY. Counts only. Is a fenced reply really left unclosed, and by whom? */
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const by = new Map()
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  let provider = 'unrecorded'
  try { provider = JSON.parse(fs.readFileSync(path.join(at, 'node.json'), 'utf8')).provider || 'unrecorded' } catch { /* keep */ }
  if (!by.has(provider)) by.set(provider, { fenced: 0, odd: 0, even: 0, indentedClose: 0, marks: new Map() })
  const seen = by.get(provider)
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    const lines = text.split('\n')
    const atMargin = lines.filter(line => /^ {0,3}(`{3,}|~{3,})/.test(line)).length
    const indented = lines.filter(line => /^ {4,}(`{3,}|~{3,})/.test(line)).length
    if (!atMargin) continue
    seen.fenced += 1
    if (atMargin % 2 === 1) seen.odd += 1; else seen.even += 1
    if (atMargin % 2 === 1 && indented > 0) seen.indentedClose += 1
    for (const line of lines) {
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!mark) continue
      const key = `${mark[1]}${mark[2].trim() ? '<info>' : ''}`
      seen.marks.set(key, (seen.marks.get(key) || 0) + 1)
    }
  }
}
for (const [provider, seen] of by) {
  if (!seen.fenced) continue
  console.log(`\n## ${provider}: ${seen.fenced} replies contain a fence line at the margin`)
  console.log(`   balanced (even count):   ${seen.even}`)
  console.log(`   ODD count (one unclosed): ${seen.odd}`)
  console.log(`   of those odd, also carrying an INDENTED fence line: ${seen.indentedClose}`)
  console.log('   fence spellings seen: ' + [...seen.marks].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${JSON.stringify(k)}:${n}`).join('  '))
}
