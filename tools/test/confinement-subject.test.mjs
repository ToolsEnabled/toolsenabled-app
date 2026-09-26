/* THE ONE PARAGRAPH WHERE THE WRONG COMPUTER IS DANGEROUS.
 *
 * Measured on the live site on 2026-08-22, the first time a browser drove a
 * machine: the compose panel said "This computer is set to Unrestricted.
 * Nothing narrows it: it can read, change and delete any file on this computer
 * and run any program, without asking."
 *
 * Read at a laptop, about a machine at home. Everywhere else on the page a
 * wrong referent is confusing; here it is somebody agreeing to something on a
 * computer they thought they were only looking at.
 *
 * The lead sentence names the subject and the sentences after it inherit that
 * reading, so these tests hold the lead and the default together. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  confinementNote, startControlLine,
  CONFINEMENT_SUBJECT_HERE, CONFINEMENT_SUBJECT_REMOTE,
} = await import(new URL('../../src/agent-confinement-copy.js', import.meta.url).href)

/* A reading the copy recognises, so the lead sentence is actually produced. */
const UNRESTRICTED = { ok: true, tier: 'unrestricted', sandbox: 'danger-full-access' }

test('the default subject is unchanged, so the desktop reads exactly as it did', () => {
  const note = confinementNote(UNRESTRICTED)
  assert.ok(note.level, 'a recognised reading must still produce a lead sentence')
  assert.ok(note.level.startsWith('This computer is set to'), note.level)
})

test('a caller can name the machine instead', () => {
  const note = confinementNote(UNRESTRICTED, { subject: CONFINEMENT_SUBJECT_REMOTE })
  assert.ok(note.level.startsWith('The computer you are driving is set to'), note.level)
  assert.ok(!note.level.startsWith('This computer'), 'the wrong referent must be gone, not merely softened')
})

test('the two subjects are different words', () => {
  assert.notEqual(CONFINEMENT_SUBJECT_HERE, CONFINEMENT_SUBJECT_REMOTE)
})

test('the start-control line carries the subject through', () => {
  const here = startControlLine(UNRESTRICTED)
  const remote = startControlLine(UNRESTRICTED, { subject: CONFINEMENT_SUBJECT_REMOTE })
  assert.ok(here.startsWith('This computer is set to'), here)
  assert.ok(remote.startsWith('The computer you are driving is set to'), remote)
  /* The rest of the paragraph -- what it may actually do -- must be identical.
     Only the referent changes; softening the danger for a remote machine would
     be the opposite of the point. */
  assert.equal(here.slice(here.indexOf('.')), remote.slice(remote.indexOf('.')))
})

test('the compose panel chooses the subject by where the machine is', async () => {
  const view = await readFile(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const at = view.indexOf('composeConfinementLine = startControlLine(')
  assert.ok(at > 0, 'the compose panel must still compose this line')
  const call = view.slice(at, at + 400)
  assert.ok(/CONFINEMENT_SUBJECT_REMOTE/.test(call), 'the relay case must name the remote machine')
  assert.ok(/currentDataSource\(\) === 'relay'/.test(call), 'and it must decide from where the data came')
})

/* EVERY CALLER, NOT THE ONE WE HAPPENED TO FIX.
 *
 * The test above pins the compose panel by name. That is what let the defect
 * come back: on 2026-08-23 a sweep of the whole renderer found a SECOND caller,
 * src/agent-session.js, asking for the note with no subject at all -- so the
 * agent drill-in, the other page carrying a Start button, told a person reading
 * in a browser somewhere else that THEIR laptop could read, change and delete
 * any file on it. The remote twin had existed for a day. It had been applied to
 * one of the two callers, and nothing in this file could tell.
 *
 * So this asks the question the other test cannot: who calls these composers,
 * and does each one say which machine it means? A new caller added tomorrow
 * fails here until it decides. */
test('every caller of the confinement composers names the machine it means', async () => {
  const SRC = path.join(ROOT, 'src')
  const { readdir } = await import('node:fs/promises')

  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  await walk(SRC)
  assert.ok(files.length > 50, `expected to read the renderer, found ${files.length} files`)

  /* The copy module is where the composers are DEFINED and where the default
     lives; it is the one file that may name them without passing a subject. */
  const DEFINER = path.join(SRC, 'agent-confinement-copy.js')

  const callers = []
  for (const file of files) {
    if (file === DEFINER) continue
    const raw = await readFile(file, 'utf8')
    /* COMMENTS MENTION THESE COMPOSERS BY NAME, WITH PARENTHESES, WHEN THEY
       EXPLAIN THEM -- agent-compose-panel.js does exactly that. A mention is
       not a call, so the comments come out first; matching on a name followed
       by "(" is not enough on its own, which this test found out about itself.
       Line comments are only cut when the "//" is not preceded by a colon, so
       a URL inside a string survives. */
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const call = /(?<![\w.])(confinementNote|startControlLine)\s*\(/g
    let hit
    while ((hit = call.exec(source)) !== null) {
      /* Read far enough to cover the options object on the following lines. */
      const window_ = source.slice(hit.index, hit.index + 400)
      callers.push({ file: path.relative(ROOT, file), name: hit[1], window: window_ })
    }
  }

  assert.ok(callers.length >= 2,
    `expected to find the callers of these composers, found ${callers.length}`)

  for (const caller of callers) {
    assert.ok(/subject\s*:/.test(caller.window),
      `${caller.file} calls ${caller.name}() without naming the machine it means. `
      + 'Over the relay that paragraph describes the computer being driven, not the one '
      + 'the person is sitting at, and it is a safety disclosure. Pass '
      + "subject: currentDataSource() === 'relay' ? CONFINEMENT_SUBJECT_REMOTE : CONFINEMENT_SUBJECT_HERE.")
    assert.ok(/CONFINEMENT_SUBJECT_REMOTE/.test(caller.window),
      `${caller.file} passes a subject to ${caller.name}() but never the remote one, `
      + 'so a browser reader still reads about the wrong computer.')
  }
})
