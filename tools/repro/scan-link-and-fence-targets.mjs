/* READ ONLY. Counts and target SCHEMES only -- no owner text, no URLs printed.
   Two questions the shape census raised:
     1. codex writes markdown links in 44% of replies and claude in 0%. Does the
        renderer's URL policy (isSafeChatUrl) admit what codex actually writes?
     2. 745 of 770 claude fence openings carry no language. What does the code
        block's own caption say then? */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { isSafeChatUrl } = await import(pathToFileURL(path.resolve('src/chat-markdown.js')).href)

const LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g
const shape = target => {
  if (/^https?:\/\//i.test(target)) return 'http(s)'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return 'other scheme'
  if (/^#/.test(target)) return 'fragment'
  if (/^\.{0,2}\//.test(target) || /^[\w.@-]+\/[\w./-]+/.test(target)) return 'repo-relative path'
  if (/^[A-Za-z]:[\/]/.test(target)) return 'windows absolute path'
  return 'other'
}
const by = new Map()
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  let provider = 'unrecorded'
  try { provider = JSON.parse(fs.readFileSync(path.join(at, 'node.json'), 'utf8')).provider || 'unrecorded' } catch { /* keep */ }
  if (!by.has(provider)) by.set(provider, { links: 0, admitted: 0, refused: 0, shapes: new Map() })
  const seen = by.get(provider)
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    const text = fs.readFileSync(path.join(at, name), 'utf8')
    for (const match of text.matchAll(LINK)) {
      const target = match[2].trim().replace(/\s+".*"$/, '')
      seen.links += 1
      if (isSafeChatUrl(target)) seen.admitted += 1; else seen.refused += 1
      const key = shape(target)
      seen.shapes.set(key, (seen.shapes.get(key) || 0) + 1)
    }
  }
}
for (const [provider, seen] of by) {
  if (!seen.links) continue
  console.log(`\n## ${provider}: ${seen.links} markdown links written`)
  console.log(`   admitted by the renderer's URL policy: ${seen.admitted}`)
  console.log(`   REFUSED (rendered as literal brackets): ${seen.refused}`)
  for (const [key, n] of [...seen.shapes].sort((a, b) => b[1] - a[1])) console.log(`     ${key.padEnd(24)} ${n}`)
}
