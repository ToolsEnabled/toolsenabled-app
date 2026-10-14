/* READ ONLY. Prints SCHEME TOKENS and counts only -- never a path, never a URL,
   never an owner value. Which link targets does the renderer refuse, and why? */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { isSafeChatUrl } = await import(pathToFileURL(path.resolve('src/chat-markdown.js')).href)
const LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g
const classify = target => {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)
  if (!scheme) return /^\.{0,2}\//.test(target) ? 'relative path (no scheme)' : 'bare text (no scheme)'
  if (scheme[1].length === 1) return 'single-letter scheme (a Windows drive, not a URL)'
  return `scheme:${scheme[1].toLowerCase()}`
}
const by = new Map()
for (const dir of fs.readdirSync(root)) {
  const at = path.join(root, dir)
  if (!fs.statSync(at).isDirectory()) continue
  let provider = 'unrecorded'
  try { provider = JSON.parse(fs.readFileSync(path.join(at, 'node.json'), 'utf8')).provider || 'unrecorded' } catch { /* keep */ }
  for (const name of fs.readdirSync(at)) {
    if (!name.endsWith('.json.text')) continue
    for (const match of fs.readFileSync(path.join(at, name), 'utf8').matchAll(LINK)) {
      const target = match[2].trim()
      const key = `${provider} | ${classify(target)} | ${isSafeChatUrl(target) ? 'admitted' : 'REFUSED'}`
      by.set(key, (by.get(key) || 0) + 1)
    }
  }
}
for (const [key, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${key}`)
