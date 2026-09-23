/* READ ONLY over the owner's LIVE node-transcripts. Writes nothing there.
 * Prints COUNTS AND LENGTHS ONLY -- never a character of the owner's text.
 *
 * shell/node-transcript-store.cjs `wholeSpill` repairs a spill file that is its
 * own double ("5151" -> "51"). This asks how many spills on disk are doubled in
 * a way that repair does NOT reach: the ones where only a PREFIX repeats,
 * which is what a stray delta aggregate on top of a partial delta run leaves.
 */
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]

// The largest n such that text[0..n) === text[n..2n) and something follows.
function repeatedPrefixLength(text) {
  for (let n = Math.floor(text.length / 2); n >= 1; n -= 1) {
    if (2 * n >= text.length) continue
    if (text.slice(0, n) === text.slice(n, 2 * n)) return n
  }
  return 0
}
const isWholeDouble = text => text.length >= 2 && text.length % 2 === 0
  && text.slice(0, text.length / 2) === text.slice(text.length / 2)

let spills = 0, legacy = 0, fixed = 0, wholeDoubled = 0, prefixDoubled = 0, clean = 0
const prefixLengths = []
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    spills += 1
    let entry = null
    try { entry = JSON.parse(fs.readFileSync(path.join(at, name.slice(0, -5)), 'utf8')) } catch { /* orphan spill */ }
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    if (entry?.textWhole === true) { fixed += 1; continue }
    legacy += 1
    if (isWholeDouble(text)) { wholeDoubled += 1; continue }
    const n = repeatedPrefixLength(text)
    if (n > 0) { prefixDoubled += 1; prefixLengths.push({ repeated: n, total: text.length }) } else clean += 1
  }
}
console.log(`# spill files:               ${spills}`)
console.log(`# written by the fixed path: ${fixed}   (textWhole:true, never examined)`)
console.log(`# legacy (wholeSpill's job): ${legacy}`)
console.log(`#   whole-doubled, REPAIRED on read: ${wholeDoubled}`)
console.log(`#   prefix-doubled, NOT repaired:    ${prefixDoubled}`)
console.log(`#   no doubling detected:            ${clean}`)
if (prefixLengths.length) {
  const sorted = [...prefixLengths].sort((a, b) => b.repeated - a.repeated)
  console.log('# prefix-doubled: repeated chars / total chars (top 10 by repeated length)')
  for (const row of sorted.slice(0, 10)) console.log(`#   ${row.repeated} / ${row.total}`)
  const sum = prefixLengths.reduce((n, row) => n + row.repeated, 0)
  console.log(`# owner-visible duplicated characters across those files: ${sum}`)
}
