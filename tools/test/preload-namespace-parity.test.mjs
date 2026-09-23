/* THE PRELOAD THE APP LOADS MUST CARRY EVERY NAMESPACE THE OTHER ONE DOES.
 *
 * There are two preloads. main.cjs loads exactly one of them --
 * shell/fleet-profile-preload.cjs -- because a sandboxed preload cannot
 * require a sibling, so that file is the shell's composed boundary. The other,
 * shell/preload.cjs, is loaded by no window at all.
 *
 * Both expose `mcShell`. That is a trap, and it has now caught three separate
 * pieces of work:
 *
 *   1. The agent bridge. Fixed by commit 1d44d35, whose subject is literally
 *      "Put the agent bridge in the preload the app actually loads".
 *   2. The same file's own header, which since then has warned in prose that
 *      exposing something here instead "would have produced a green test over
 *      a dead feature".
 *   3. deviceClaim, 2026-08-22 -- added to shell/preload.cjs, absent from the
 *      loaded one. The bridge was built, tested 47 ways and mutation-checked
 *      15 ways; window.mcShell.deviceClaim was still undefined on a real
 *      installation, so the screen would have rendered its honest "this needs
 *      the app" state forever, on the app.
 *
 * Prose did not stop it and a comment did not stop it, because the failure is
 * silent by construction: every renderer call site feature-detects, so a
 * missing namespace degrades instead of throwing. Nothing goes red. A person
 * presses a button and nothing happens.
 *
 * So this is mechanical. It reads which preload main.cjs actually loads --
 * rather than assuming, because that is the fact everything else depends on --
 * and requires the loaded one to expose every top-level key the unloaded one
 * does. Anything deliberately absent must be named in ONLY_IN_UNLOADED with a
 * reason, so an omission is a decision somebody wrote down.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN = readFileSync(join(REPO, 'shell', 'main.cjs'), 'utf8')

/* Nothing is deliberately absent today. An entry here is a decision: the key,
   and why the loaded boundary does not carry it. */
const ONLY_IN_UNLOADED = new Map([])

/* Comments come out first. This codebase documents its own boundaries in
   prose, and its prose is full of `word:` -- a parser that reads the comments
   finds namespaces that do not exist. Two sibling tests learned this on the
   words "path:", "here:", "rules:" and "derived:". */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Which preload does main.cjs hand to a BrowserWindow? Read, never assumed. */
function loadedPreloadFile() {
  const code = withoutComments(MAIN)
  const match = /preload:\s*path\.join\([^)]*?['"]([\w.-]+\.cjs)['"]\s*\)/.exec(code)
  assert.ok(match, 'could not find the preload main.cjs loads -- this test, not the shell, is broken')
  return match[1]
}

/** Top-level keys of the object literal passed to exposeInMainWorld(name, {...}). */
function exposedKeys(source, namespace) {
  const code = withoutComments(source)
  const at = code.search(new RegExp(String.raw`exposeInMainWorld\(\s*['"]${namespace}['"]`))
  if (at === -1) return null
  const start = code.indexOf('{', at)
  if (start === -1) return null
  let depth = 0
  let end = -1
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.notEqual(end, -1, `could not find the end of the ${namespace} literal`)
  const body = code.slice(start, end)
  const keys = new Set()
  let d = 0
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{' || ch === '(' || ch === '[') d += 1
    else if (ch === '}' || ch === ')' || ch === ']') d -= 1
    else if (d === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i, i + 48))
      if (m && /[\s,{]/.test(body[i - 1] || '')) { keys.add(m[1]); i += m[0].length - 1 }
    }
  }
  return keys
}

test('main.cjs loads exactly one preload, and this test knows which', () => {
  const file = loadedPreloadFile()
  assert.equal(file, 'fleet-profile-preload.cjs',
    `main.cjs now loads ${file}. That is allowed -- but this test and both preloads' headers name fleet-profile-preload.cjs as the composed boundary, so update all three together rather than letting them drift.`)
  const occurrences = (withoutComments(MAIN).match(/preload:\s*path\.join/g) || []).length
  assert.equal(occurrences, 1,
    `main.cjs hands a preload to ${occurrences} windows. If a second window has its own boundary, this test must check that one too -- a namespace missing from it fails silently exactly the same way.`)
})

test('every mcShell namespace in the unloaded preload exists in the loaded one', () => {
  const loadedFile = loadedPreloadFile()
  const loaded = readFileSync(join(REPO, 'shell', loadedFile), 'utf8')
  const unloaded = readFileSync(join(REPO, 'shell', 'preload.cjs'), 'utf8')

  const inLoaded = exposedKeys(loaded, 'mcShell')
  const inUnloaded = exposedKeys(unloaded, 'mcShell')
  assert.ok(inLoaded && inLoaded.size > 0, `could not parse mcShell in shell/${loadedFile}`)
  assert.ok(inUnloaded && inUnloaded.size > 0, 'could not parse mcShell in shell/preload.cjs')

  const missing = [...inUnloaded].filter(key => !inLoaded.has(key) && !ONLY_IN_UNLOADED.has(key))
  assert.deepEqual(missing, [],
    `shell/preload.cjs exposes mcShell.${missing.join(', mcShell.')} and shell/${loadedFile} does not. `
    + `main.cjs loads ${loadedFile}, so on a real installation those are undefined -- and because every renderer call site feature-detects, nothing throws: the screen quietly renders its "needs the app" state and a person presses a button that does nothing. `
    + 'Add them to the loaded file (the duplication is deliberate; a sandboxed preload cannot require a sibling), or name them in ONLY_IN_UNLOADED with a reason.')
})

test('the loaded preload never hands a page a secret the main process should keep', () => {
  /* deviceClaim.poll() takes no argument BY DESIGN: the poll token identifies
     one machine's in-flight claim and lives in the main process. A preload that
     let a page pass one would let any page name somebody else's claim. */
  const loaded = readFileSync(join(REPO, 'shell', loadedPreloadFile()), 'utf8')
  const code = withoutComments(loaded)
  const poll = /poll:\s*\(([^)]*)\)\s*=>/.exec(code)
  if (poll) {
    assert.equal(poll[1].trim(), '',
      `deviceClaim.poll takes "${poll[1].trim()}". The poll token must never cross into a page; begin() keeps it in the main process and poll() takes no argument.`)
  }
  assert.doesNotMatch(code, /pollToken/,
    'the loaded preload mentions pollToken. That value belongs to the main process alone.')
})
