/* READ ONLY over the owner's LIVE node-transcripts. Counts and lengths only;
 * no owner text is printed.
 *
 * T404. src/chat-readable-stream.js holds unfinished markup at the streaming
 * tail so it is painted once rather than flickering (T384). The held text is
 * revealed by finish(), which the chat surface calls when the turn COMPLETES.
 * This measures what a person would be left looking at if the turn never
 * completes: for every prefix of a real reply, how much text has arrived and is
 * still not on the glass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const limitFiles = Number(process.argv[3] || 400)
const { createReadableTextBuffer } = await import(
  pathToFileURL(path.resolve('src/chat-readable-stream.js')).href)

// A token stream, as an adapter delivers one: small pieces, not whole lines.
function deltas(text, size) {
  const out = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}

let examined = 0
let everHeld = 0, maxHeld = 0, maxHeldOverall = 0
const heldAtEnd = []
const overFrame = []
for (const dir of fs.readdirSync(root)) {
  if (examined >= limitFiles) break
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  for (const name of fs.readdirSync(at)) {
    if (examined >= limitFiles) break
    if (!name.endsWith('.json.text')) continue
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    if (text.length < 40) continue
    examined += 1
    const buffer = createReadableTextBuffer()
    let source = '', worst = 0
    for (const delta of deltas(text, 8)) {
      source += delta
      const visible = buffer.push(source)
      const held = source.length - visible.length
      if (held > worst) worst = held
    }
    // Where the stream actually stops: the last push, with no finish().
    const visibleAtEnd = buffer.push(source).length
    const stuck = source.length - visibleAtEnd
    if (worst > 0) everHeld += 1
    if (worst > maxHeldOverall) maxHeldOverall = worst
    if (stuck > 0) { heldAtEnd.push(stuck); if (stuck > maxHeld) maxHeld = stuck }
    if (worst > 240) overFrame.push(worst)
  }
}
console.log(`# real replies replayed as 8-character deltas: ${examined}`)
console.log(`# replies where the hold ever withheld arrived text: ${everHeld}`)
console.log(`# largest amount withheld at any point:              ${maxHeldOverall} chars`)
console.log(`# replies withholding MORE than INLINE_HOLD_REACH (240): ${overFrame.length}`)
if (overFrame.length) console.log(`#   largest of those: ${Math.max(...overFrame)} chars`)
console.log(`# replies still withholding text when the stream STOPS: ${heldAtEnd.length}`)
if (heldAtEnd.length) {
  heldAtEnd.sort((a, b) => b - a)
  console.log(`#   largest withheld-at-stop: ${heldAtEnd[0]} chars`)
  console.log(`#   total characters that arrived and were never painted: ${heldAtEnd.reduce((n, v) => n + v, 0)}`)
}
