/* THE SIXTH PRECONDITION: DOES THE CODEX BINARY EXIST ON THIS MACHINE.
 *
 * shell/agent-host.cjs codexCommandIsMissing() decides whether the product
 * tells a person to install Codex. Its header said that duplication "is
 * CHECKED rather than trusted ... by tools/test/agent-codex-cli-precondition
 * .test.mjs" -- this file, which did not exist. Nothing had ever run the rule,
 * and it had drifted: a bare `catch {}` around the stat counted EACCES, EPERM
 * and every other refusal as "codex is not in this directory", so a complete
 * search over a PATH holding an unreadable directory answered MISSING on a
 * machine with Codex installed in it.
 *
 * The rule the probe's own header states, and the one the payload's
 * resolveOnSearchPath() states: ENOENT and ENOTDIR prove a candidate absent,
 * every other errno proves nothing. These drive the real function with values.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { codexCommandIsMissing } from '../../shell/agent-host.cjs'

const WINDOWS = process.platform === 'win32'
const EXT = WINDOWS ? '.EXE' : ''
const SEP = WINDOWS ? '\\' : '/'
const dir = name => (WINDOWS ? `C:${SEP}${name}` : `${SEP}${name}`)
const candidateIn = folder => `${folder}${SEP}codex${EXT}`.toUpperCase()

/* A stat that answers from a description of a machine: a map of candidate
   paths to either 'file' or an errno string to raise. Anything unnamed is
   ENOENT, which is what an ordinary directory without codex in it says. */
function statOver(world) {
  return candidate => {
    const answer = world[candidate.toUpperCase()] || 'ENOENT'
    if (answer === 'file') return { isFile: () => true }
    if (answer === 'not-a-file') return { isFile: () => false }
    const error = new Error(`${answer}: ${candidate}`)
    error.code = answer
    throw error
  }
}

const search = (directories, complete = true) => () => ({ directories, complete })

/* BRANCH ONE IS THE REAL FILESYSTEM AND IT SHORT-CIRCUITS. On win32 the probe
   stats %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js first and answers
   "not missing" when it is there -- which it is on any machine carrying the npm
   global install, this one included. A test about the PATH SEARCH therefore has
   to point APPDATA away from that install, or it measures the developer's
   machine instead of the rule. Restored on the way out. */
function searching(options) {
  const held = process.env.APPDATA
  process.env.APPDATA = ''
  try { return codexCommandIsMissing(options) } finally {
    if (held === undefined) delete process.env.APPDATA
    else process.env.APPDATA = held
  }
}

test('codex found on the machine search path is not missing', () => {
  const folder = dir('program-files-codex')
  const world = {}
  world[candidateIn(folder)] = 'file'
  assert.equal(
    searching({ searchPath: search([folder]), statFile: statOver(world) }),
    false,
    'a codex the search path can see must never be reported missing'
  )
})

test('a complete search that proved every candidate absent reports missing', () => {
  assert.equal(
    searching({ searchPath: search([dir('nothing-here')]), statFile: statOver({}) }),
    true,
    'ENOENT everywhere on a complete search is a real absence and must be reported'
  )
})

/* THE DEFECT. A directory this process may not stat is a place we could not
   look, not a place Codex is not -- and answering true here is what puts
   "install Codex" in front of somebody who already has it. */
for (const errno of ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ELOOP', 'ENAMETOOLONG', 'UNKNOWN']) {
  test(`a PATH directory that refuses to be read with ${errno} is not evidence codex is absent`, () => {
    const refusing = dir('refusing')
    const world = {}
    world[candidateIn(refusing)] = errno
    assert.equal(
      searching({ searchPath: search([dir('readable'), refusing]), statFile: statOver(world) }),
      false,
      `${errno} was counted as absence, so a machine with codex in that directory is told to install it`
    )
  })
}

test('one refusing directory stops the whole search from claiming absence, even beside directories that answered', () => {
  /* The refusing directory is searched FIRST and every later one answers
     cleanly. The verdict still has to be "could not tell": absence is a claim
     about every directory, and one of them never answered. */
  const refusing = dir('refusing')
  const world = {}
  world[candidateIn(refusing)] = 'EACCES'
  assert.equal(
    searching({ searchPath: search([refusing, dir('clean')]), statFile: statOver(world) }),
    false
  )
})

test('an incomplete search never claims absence, however cleanly its directories answered', () => {
  assert.equal(
    searching({ searchPath: search([dir('nothing-here')], false), statFile: statOver({}) }),
    false,
    'a search that could not finish has taught us nothing about whether Codex is installed'
  )
})

test('a search path this shell could not build at all is not evidence either', () => {
  assert.equal(
    searching({
      searchPath: () => { throw new Error('the registry would not answer') },
      statFile: statOver({})
    }),
    false,
    'the probe proves absence or it says nothing'
  )
})

/* A PATH entry that is a FILE, not a directory, is a real "codex is not in
   there": the platform says ENOTDIR and that is an answer, not a refusal.
   Keeping it on the absence side is what stops one junk PATH entry from
   permanently disabling the install hint. */
test('a PATH entry that is a file, not a directory, still counts as proven absent', () => {
  const junk = dir('a-file-on-path')
  const world = {}
  world[candidateIn(junk)] = 'ENOTDIR'
  assert.equal(
    searching({ searchPath: search([junk]), statFile: statOver(world) }),
    true
  )
})

/* THE MIRROR ITSELF. The probe copies two branches out of the payload's
   resolveInvocation(): the npm global entry point it prefers on win32, and a
   PATHEXT search of the machine's own PATH. Reading the engine source is what
   the missing test was described as doing; it is done here against whichever
   copy of the payload this checkout has, and skipped rather than guessed when
   there is none. */
test('the branches this probe copies are still the branches the payload takes', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const engineFile = [
    path.join(here, '..', '..', 'capability', 'src', 'lib', 'agent-engine', 'codex-process.js'),
    path.join(here, '..', '..', '..', 'wt-engine-1.0.41-next', 'src', 'lib', 'agent-engine', 'codex-process.js'),
  ].find(candidate => existsSync(candidate))
  if (!engineFile) {
    t.skip('no copy of the payload engine is present in this checkout to read')
    return
  }
  const engine = readFileSync(engineFile, 'utf8')
  assert.match(engine, /'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex\.js'/,
    'the npm global entry point this probe stats is no longer the one the payload prefers')
  assert.match(engine, /PATHEXT/,
    'the payload no longer resolves codex by the extension list this probe searches')
  assert.match(engine, /error\.code !== 'ENOENT' && error\.code !== 'ENOTDIR'/,
    'the payload no longer draws the absence line at ENOENT/ENOTDIR, so this probe copies a rule that changed')
})
