import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import powershell from 'highlight.js/lib/languages/powershell'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import diff from 'highlight.js/lib/languages/diff'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import cpp from 'highlight.js/lib/languages/cpp'
import java from 'highlight.js/lib/languages/java'
import csharp from 'highlight.js/lib/languages/csharp'

for (const [name, grammar] of Object.entries({ javascript, typescript, python, bash, powershell, json, yaml, xml, css, sql, diff, rust, go, cpp, java, csharp })) hljs.registerLanguage(name, grammar)
const names = { javascript: 'JavaScript', js: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', ts: 'TypeScript', tsx: 'TSX', python: 'Python', py: 'Python', bash: 'Shell', sh: 'Shell', shell: 'Shell', powershell: 'PowerShell', ps1: 'PowerShell', json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML', html: 'HTML', css: 'CSS', sql: 'SQL', diff: 'Diff', rust: 'Rust', rs: 'Rust', go: 'Go', cpp: 'C++', c: 'C', java: 'Java', csharp: 'C#', cs: 'C#', text: 'Text', plaintext: 'Text', txt: 'Text' }
const aliases = { tsx: 'typescript', shell: 'bash', ps1: 'powershell' }
export function chatCodeLanguage(info = '') {
  const id = String(info || '').trim().split(/\s+/)[0].toLowerCase()
  return /^[a-z0-9_+#.-]{1,30}$/.test(id) ? { id, label: names[id] || id } : { id: 'text', label: 'Text' }
}
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cache = new Map()
export function highlightChatCode(text, id) {
  const language = aliases[id] || id
  // Large blocks stay complete and copyable without expensive syntax work on
  // every streaming frame. Never guess a language from ordinary prose.
  if (text.length > 24000 || !hljs.getLanguage(language)) return escape(text)
  const key = `${language}\u0000${text}`
  if (cache.has(key)) return cache.get(key)
  let html
  try { html = hljs.highlight(text, { language, ignoreIllegals: true }).value } catch { html = escape(text) }
  cache.set(key, html)
  if (cache.size > 24) cache.delete(cache.keys().next().value)
  return html
}
