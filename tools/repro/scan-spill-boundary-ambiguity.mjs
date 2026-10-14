/* READ ONLY over the owner's LIVE node-transcripts. Counts only, no text.
   Before extending the read-time repair, ask whether the doubling boundary is
   even decidable: how many split points n satisfy text[0..n) === text[n..2n)? */
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const candidates = text => {
  const found = []
  for (let n = 1; 2 * n <= text.length; n += 1) if (text.slice(0, n) === text.slice(n, 2 * n)) found.push(n)
  return found
}
let legacy = 0
const byCount = new Map()
let largestIsWhole = 0, remainderCleanAtLargest = 0
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    let entry = null
    try { entry = JSON.parse(fs.readFileSync(path.join(at, name.slice(0, -5)), 'utf8')) } catch { /* orphan */ }
    if (entry?.textWhole === true) continue
    legacy += 1
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    const found = candidates(text)
    byCount.set(found.length, (byCount.get(found.length) || 0) + 1)
    if (!found.length) continue
    const largest = found.at(-1)
    if (2 * largest === text.length) largestIsWhole += 1
    if (!candidates(text.slice(largest)).length) remainderCleanAtLargest += 1
  }
}
console.log(`# legacy spills examined: ${legacy}`)
console.log('# how many split points satisfy the doubling equation:')
for (const [count, n] of [...byCount].sort((a, b) => a[0] - b[0])) console.log(`#   ${count} candidate(s): ${n} file(s)`)
console.log(`# files where the largest candidate is the whole-double case: ${largestIsWhole}`)
console.log(`# files where the remainder after the largest candidate has no doubling left: ${remainderCleanAtLargest}`)
