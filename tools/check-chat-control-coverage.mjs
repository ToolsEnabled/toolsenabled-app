#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMITS = [
  'LIMITATION: Identifier-vs-class-string — a grep for a CSS class name undercounts real coverage that asserts against JS identifiers instead.',
  "LIMITATION: Dynamically-constructed identifiers — a selector or id built from a template literal has no single literal string a static scan can ever find. Assert against the template literal's source text to make a dynamic selector coverage-checkable.",
]
const norm = value => value.split(path.sep).join('/')
const q = String.raw`(['"])((?:\\.|(?!\1).)*)\1`

export function stripComments(source) {
  let out = '', state = 'code', quote = '', regexClass = false, expressionDepth = []
  const canRegex = () => /(?:^|[({[=,:;!?&|+*%~^-]|\b(?:return|case|throw|typeof|void|delete|in|of))\s*$/.test(out)
  const hasRegexEnd = start => { let cls=false; for(let j=start+1;j<source.length && source[j]!=='\n';j++){ if(source[j]==='\\'){j++;continue} if(source[j]==='[')cls=true; else if(source[j]===']')cls=false; else if(source[j]==='/'&&!cls)return true } return false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1]
    if (state === 'line') { if (c === '\n') { out += c; state = 'code' } else out += ' '; continue }
    if (state === 'block') { if (c === '*' && n === '/') { out += '  '; i++; state = 'code' } else out += c === '\n' ? '\n' : ' '; continue }
    if (state === 'string') { out += c; if (c === '\\') { if (++i >= source.length) throw Error('unterminated string'); out += source[i] } else if (c === quote) state = 'code'; continue }
    if (state === 'template') { out += c; if (c === '\\') { if (++i >= source.length) throw Error('unterminated template'); out += source[i] } else if (c === '`') state = 'code'; else if (c === '$' && n === '{') { out += n; i++; expressionDepth.push(1); state = 'code' }; continue }
    if (state === 'regex') { out += c; if (c === '\\') { if (++i >= source.length) throw Error('unterminated regular expression'); out += source[i] } else { if (c === '[') regexClass = true; if (c === ']') regexClass = false; if (c === '/' && !regexClass) state = 'code' }; continue }
    if (c === '/' && n === '/') { out += '  '; i++; state = 'line' }
    else if (c === '/' && n === '*') { out += '  '; i++; state = 'block' }
    else if (c === "'" || c === '"') { out += c; state = 'string'; quote = c }
    else if (c === '`') { out += c; state = 'template' }
    else if (expressionDepth.length && c === '{') { out += c; expressionDepth[expressionDepth.length-1]++ }
    else if (expressionDepth.length && c === '}') { out += c; if (!--expressionDepth[expressionDepth.length-1]) { expressionDepth.pop(); state = 'template' } }
    else if (c === '/' && canRegex() && hasRegexEnd(i)) { out += c; state = 'regex'; regexClass = false }
    else out += c
  }
  if ((state !== 'code' && state !== 'line') || expressionDepth.length) throw Error(`unterminated lexical state: ${state}`)
  return out
}

export function identityOf(control) { return `${norm(control.file)}\t${control.kind}\t${control.value}` }

export function deriveControls(componentsSource, { file = 'src/components.js' } = {}) {
  const source = stripComments(componentsSource), found = []
  const add = (kind, value) => { const c = { file: norm(file), kind, value }; found.push({ ...c, identity: identityOf(c) }) }
  const composer = [...source.matchAll(new RegExp(`export\\s+const\\s+CHAT_COMPOSER_INPUT_SELECTOR\\s*=\\s*${q}`, 'g'))]
  if (composer.length !== 1) throw Error('missing, duplicate, or nonliteral CHAT_COMPOSER_INPUT_SELECTOR export')
  add('composer-selector', composer[0][2].trim().replace(/\s+/g, ' '))
  const approvalOwner = [...source.matchAll(/export\s+const\s+CHAT_APPROVAL_SELECTOR\s*=\s*Object\.freeze\s*\(\s*\{([\s\S]*?)\}\s*\)/g)]
  if (approvalOwner.length !== 1) throw Error('missing or duplicate CHAT_APPROVAL_SELECTOR export')
  const property = /(?:\w+|['"][^'"]+['"])\s*:\s*(['"])(.*?)\1/g
  const body = approvalOwner[0][1], pairs = [...body.matchAll(property)]
  const residue = body.replace(property, '').replace(/,/g, '').trim()
  if (!pairs.length || residue) throw Error('nonliteral or ambiguous CHAT_APPROVAL_SELECTOR value')
  for (const m of pairs) {
    const value = m[2]
    const parsed = /^\[([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?\]$/.exec(value)
    if (!parsed || !parsed[1].startsWith('data-chat-')) throw Error(`unsupported approval selector ${value}`)
    add('data-control', parsed[2] === undefined ? `[${parsed[1]}]` : `[${parsed[1]}="${parsed[2]}"]`)
  }
  for (const tag of source.matchAll(/<(button|input|select|textarea|a)\b([\s\S]*?)>/gi)) {
    if (/data-chat-[\w:-]*\s*=\s*\$\{/.test(tag[2])) throw Error('dynamic data-chat attribute value')
    for (const a of tag[2].matchAll(/\b(data-chat-[\w:-]+)(?:\s*=\s*(["'])(.*?)\2)?/g)) add('data-control', a[3] === undefined ? `[${a[1]}]` : `[${a[1]}="${a[3]}"]`)
  }
  /* AN EMPTY VALUE IS A BARE ATTRIBUTE, and must derive the same identity
     whichever way the source writes it.

     setAttribute('data-chat-diff-card', '') and <div data-chat-diff-card>
     render the SAME thing and are matched by the SAME selector,
     [data-chat-diff-card]. The markup path above already derives the bare
     form; this path derived [data-chat-diff-card=""], which is a selector no
     test will ever write -- and measured, none does: every one of these
     controls is queried bare by an existing suite, and not one is queried in
     the empty-value form. That mismatch reported thirteen controls as having
     no evidence when their behaviour was already driven, which is worse than
     silence: it invites thirteen redundant tests and hides whatever is
     genuinely uncovered among them. */
  for (const m of source.matchAll(/\.setAttribute\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3\s*\)/g)) if (m[2].startsWith('data-chat-')) add('data-control', m[4] === '' ? `[${m[2]}]` : `[${m[2]}="${m[4]}"]`)
  /* THE TWO DYNAMIC OWNERS, DECLARED RATHER THAN REFUSED.
   *
   * This used to throw, so the gate could not derive from the real
   * src/components.js at all -- and because every case in its own suite wrote
   * a synthetic components.js, the suite stayed green while the gate measured
   * nothing. Refusing is the right default for a value a static scan cannot
   * see; refusing with no way to DECLARE one is how a gate ends up unable to
   * run against its own product.
   *
   * data-chat-activity -- a CLOSED set, one literal ternary just above the
   *   call. Every arm is derived, so coverage stays per-value and a new phase
   *   nothing asserts is still uncovered.
   * data-chat-approval -- an OPEN set: the value is the provider's own
   *   decision id from the approval payload, not a literal in this source.
   *   Inventing a value list would be a lie about what the file says, so it is
   *   covered by ATTRIBUTE NAME, the strongest true statement available.
   *
   * An owner NOT on this list still throws, so a third dynamic attribute
   * cannot arrive unnoticed. */
  const DECLARED_DYNAMIC = new Map([
    ['data-chat-activity', 'closed-ternary'],
    ['data-chat-approval', 'open-name-only'],
  ])
  for (const call of source.matchAll(/\.setAttribute\(\s*(['"])(data-chat-[^'"]+)\1\s*,\s*([^\n)]+)/g)) {
    if (/^['"]/.test(call[3])) continue
    const declared = DECLARED_DYNAMIC.get(call[2])
    if (!declared) throw Error(`undeclared dynamic data-chat setAttribute owner: ${call[2]}`)
    if (declared === 'open-name-only') { add('data-control', `[${call[2]}]`); continue }
    const arms = [...call[3].matchAll(/'([a-z][a-z0-9-]*)'/g)].map(match => match[1])
    if (!arms.length) throw Error(`declared closed-set owner ${call[2]} no longer names literal values`)
    for (const value of new Set(arms)) add('data-control', `[${call[2]}="${value}"]`)
  }
  const unique = new Map(found.map(c => [c.identity, c]))
  if (!unique.size) throw Error('zero derived controls')
  return [...unique.values()].sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
}

export async function discoverCandidates(repoRoot) {
  const result = []
  for (const [dir, predicate] of [['tools/test', n => n.endsWith('.test.mjs')], ['tools', n => n.endsWith('-qa.mjs') || n.endsWith('-drive.mjs')]]) {
    const absolute = path.join(repoRoot, dir); let entries
    try { entries = await readdir(absolute, { withFileTypes: true }) } catch (e) { throw Error(`cannot read candidate directory ${dir}: ${e.message}`) }
    for (const entry of entries) if (predicate(entry.name)) {
      const full = path.join(absolute, entry.name); let info
      try { info = await stat(full) } catch (e) { throw Error(`cannot stat candidate ${norm(path.join(dir, entry.name))}: ${e.message}`) }
      if (info.isFile()) { const file = norm(path.join(dir, entry.name)); if (file !== 'tools/test/chat-control-coverage.test.mjs') result.push(file) }
    }
  }
  result.sort(); if (!result.length) throw Error('zero candidate files discovered'); return result
}

const unescapePunctuation = s => s.replace(/\\(?=[\[\](){}.*+?^$|=/"'\-])/g, '')
export function extractEvidence(controls, candidates) {
  const records = []
  for (const candidate of candidates) {
    const clean = stripComments(candidate.source), views = [clean, unescapePunctuation(clean)]
    for (const control of controls) for (const view of views) {
      let re
      if (control.kind === 'composer-selector') re = new RegExp(control.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      else { const p = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(control.value), name = p[1].replace(/-/g, '\\-'); re = p[2] === undefined ? new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'g') : new RegExp(`(?:${name}\\s*=\\s*(['"])${p[2].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\1|\\.setAttribute\\(\\s*(['"])${name}\\2\\s*,\\s*(['"])${p[2].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\3\\s*\\))`, 'g') }
      for (const m of view.matchAll(re)) records.push({ identity: control.identity, file: norm(candidate.file), line: view.slice(0, m.index).split('\n').length, form: m[0] })
    }
  }
  const unique = new Map(records.map(r => [`${r.identity}\t${r.file}\t${r.line}\t${r.form}`, r]))
  return [...unique.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

export function compareCoverage({ controls, evidence, accepted }) {
  if (!Array.isArray(accepted) || accepted.some((x,i) => typeof x !== 'string' || (i && accepted[i-1] >= x))) throw Error('accepted identities must be unique and sorted')
  const covered = new Set(evidence.map(e => e.identity)); const findings = controls.filter(c => !covered.has(c.identity)).map(c => c.identity).sort()
  const fs = new Set(findings), as = new Set(accepted)
  return { findings, unaccepted: findings.filter(x => !as.has(x)), stale: accepted.filter(x => !fs.has(x)) }
}

function validateBaseline(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('baseline is not an object')
  if (typeof value.$comment !== 'string' || typeof value.note !== 'string' || !Array.isArray(value.accepted) || typeof value.updated !== 'string' || Number.isNaN(Date.parse(value.updated))) throw Error('baseline has missing or invalid fields')
  if (Object.keys(value).some(k => !['$comment','note','accepted','updated'].includes(k))) throw Error('baseline has an unexpected field')
  compareCoverage({ controls: [], evidence: [], accepted: value.accepted }); return value
}

export async function run({ repoRoot, argv = [], stdout = process.stdout, stderr = process.stderr, now = () => new Date() }) {
  const say = (s, err=false) => (err ? stderr : stdout).write(`${s}\n`)
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--update')) { say('SETUP ERROR: only one optional --update argument is accepted', true); return 2 }
  const update = argv[0] === '--update', canonical = path.join(repoRoot,'tools/chat-control-coverage-baseline.json'), proposed = path.join(repoRoot,'tools/chat-control-coverage-baseline.proposed.json')
  try {
    const source = await readFile(path.join(repoRoot,'src/components.js'),'utf8'); if (!source.trim()) throw Error('production source is empty')
    const controls = deriveControls(source); const files = await discoverCandidates(repoRoot); const candidates = await Promise.all(files.map(async file => ({ file, source: await readFile(path.join(repoRoot,file),'utf8') })))
    const evidence = extractEvidence(controls,candidates); if (!evidence.length) throw Error('zero evidence records: the extractor may have gone blind')
    let baseline, absent = false
    try { baseline = validateBaseline(JSON.parse(await readFile(canonical,'utf8'))) } catch (e) { if (e.code === 'ENOENT') { absent = true; baseline = { accepted: [] } } else throw Error(`malformed canonical baseline: ${e.message}`) }
    if (absent && !update) throw Error('canonical baseline is absent')
    const result = compareCoverage({ controls,evidence,accepted:baseline.accepted })
    say(`SUMMARY: inventory controls=${controls.length}; scanned candidate files=${files.length}; evidence records=${evidence.length}; findings=${result.findings.length}; canonical baseline accepted entries=${baseline.accepted.length}${absent ? ', canonical absent' : ''}`)
    const labels = { findings:'FINDING', unaccepted:'UNACCEPTED', stale:'STALE' }
    for (const key of Object.keys(labels)) for (const id of result[key]) say(`${labels[key]}: ${id}`)
    for (const line of LIMITS) say(line)
    if (update) { const payload = { $comment:'This file records reviewed uncovered controls by stable source identity and may only shrink.', note:'UNACCEPTED proposal pending independent coordinator review and rename.', accepted:result.findings, updated:now().toISOString() }; await writeFile(proposed,`${JSON.stringify(payload,null,2)}\n`); say('PROPOSAL: unaccepted pending coordinator review/rename; canonical baseline was not changed.'); return 1 }
    if (result.stale.length) say('Lower the canonical baseline: accepted identities are stale.', true)
    return result.unaccepted.length || result.stale.length ? 1 : 0
  } catch (e) { say(`SETUP ERROR: ${e.message}`, true); return 2 }
}

const self = realpathSync.native(fileURLToPath(import.meta.url))
if (process.argv[1] && realpathSync.native(process.argv[1]) === self) process.exitCode = await run({ repoRoot:path.resolve(path.dirname(self),'..'), argv:process.argv.slice(2) })
