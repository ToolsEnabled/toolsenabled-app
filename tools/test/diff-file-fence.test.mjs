/* THE COMPARE WINDOW'S ONE FILE VERB, DRIVEN AGAINST A REAL DISK.
 *
 * Not a source-text suite. Every assertion below runs the shipped module in
 * shell/diff-file.cjs with the real node:fs against a real temporary directory,
 * creates real junctions where a junction is the thing under test, and reads
 * the bytes back off the disk afterwards. A fence asserted from source is a
 * fence nobody has walked.
 *
 * WHAT IT HOLDS SHUT, and each one is a way a renderer-supplied path could
 * reach a file the agent itself could not:
 *
 *   1. a path outside the work folders, absolute or climbed to with ..
 *   2. a path that leaves the work folder through a Windows junction
 *   3. a path on another drive letter
 *   4. a folder rather than a file, and a file that is not text
 *   5. a save when no work folder is recorded at all
 *
 * AND THE THINGS THAT MUST STILL WORK, because a fence that refuses everything
 * passes every refusal test and ships a dead feature: a save inside the folder
 * writes the exact bytes, a save to a new name beside an existing file works,
 * and a folder named `..config` inside the work folder is INSIDE it -- the
 * naive startsWith('..') check gets that one wrong.
 *
 * The absolute claim in the compare window's own risk statement -- "A save
 * replaces the file straight away and nothing here undoes it" -- is pinned in
 * tools/test/permission-guidance.test.mjs against this file. The last test here
 * is the half of that pin this file owes: after a save, the directory holds the
 * saved file and nothing else.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const { MAX_FILE_BYTES, WRITE_ATTEMPTS, createDiffFiles, diffAnswer } = require('../../shell/diff-file.cjs')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readSource = relative => fs.readFileSync(path.join(REPO, ...relative.split('/')), 'utf8')

let sandbox = null
let workRoot = null
let outsideRoot = null

/* A real directory tree under the machine's own temporary folder. `realpathSync`
   because macOS and several Windows configurations hand back a symlinked temp
   path, and the module resolves candidates through realpath -- comparing an
   unresolved root against a resolved candidate would fail every test here for a
   reason that has nothing to do with the fence. */
before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-fence-')))
  workRoot = path.join(sandbox, 'work')
  outsideRoot = path.join(sandbox, 'outside')
  fs.mkdirSync(workRoot, { recursive: true })
  fs.mkdirSync(outsideRoot, { recursive: true })
})

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
})

function files(roots = () => [workRoot]) {
  return createDiffFiles({ fs, path, randomUUID, workspaceRoots: roots })
}

function put(where, name, text) {
  const target = path.join(where, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
  return target
}

// Execute the registered production handlers. Only Electron's dialog and sender
// boundary are substituted; the read verbs and session access are the real ones.
function compareHandlers(surface, { choose, failHandler = false, trusted = true, assertPath = candidate => candidate } = {}) {
  const handlers = new Map()
  const { createSessionDiffAccess } = require('../../shell/session-diff-access.cjs')
  const access = createSessionDiffAccess({
    fs, path, sessions: new Map(), assertPath,
    readDefault: candidate => surface.readChange(candidate),
    stampDefault: candidate => surface.stamp(candidate),
    writeDefault: (candidate, text) => surface.write(candidate, text),
  })
  const main = readSource('shell/main.cjs')
  const start = main.indexOf("ipcMain.handle('mc-diff:pick'")
  const end = main.indexOf('/* ---------- the product account', start)
  assert.ok(start >= 0 && end > start, 'the production Compare registrations must be available')
  const getSurface = () => {
    if (failHandler) throw new Error('fixture-internal-details')
    return surface
  }
  runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    withFleetProfileSender: (_event, action) => trusted ? action() : { ok: false, code: 'TEST_UNTRUSTED_SENDER' },
    diffAnswer, win: {}, dialog: { showOpenDialog: choose },
    chosenWorkspaceCwd: () => workRoot, ensureWorkspaceRoot: () => workRoot,
    getDiffFiles: getSurface,
    getSessionDiffAccess: () => { getSurface(); return access },
  })
  return async (channel, request = {}) => JSON.parse(JSON.stringify(await handlers.get(channel)({ sender: {} }, request)))
}

const readFailures = [
  ['no workspace', 'MC_DIFF_NO_WORKSPACE'],
  ['outside workspace', 'MC_DIFF_OUTSIDE_WORKSPACE'],
  ['stat failure', 'MC_DIFF_STAT_FAILED'],
  ['read failure', 'MC_DIFF_READ_FAILED'],
  ['unexpected handler failure', 'MC_DIFF_HANDLER_FAILED'],
]

for (const [cause, code] of readFailures) {
  test(`T347 real picker handler distinguishes ${cause} without disclosing failure details`, async () => {
    const target = put(cause === 'outside workspace' ? outsideRoot : workRoot, `${code}.txt`, 'fixture contents\n')
    let reads = 0
    const fail = () => { const error = new Error(`fixture-internal-details: ${target}`); error.code = 'EACCES'; throw error }
    const disk = { ...fs,
      statSync: candidate => candidate === target && cause === 'stat failure' ? fail() : fs.statSync(candidate),
      readFileSync: candidate => { reads++; return cause === 'read failure' ? fail() : fs.readFileSync(candidate) },
    }
    const surface = createDiffFiles({ fs: disk, path, randomUUID,
      workspaceRoots: () => cause === 'no workspace' ? [] : [workRoot] })
    const invoke = compareHandlers(surface, {
      choose: async () => {
        if (cause === 'unexpected handler failure') fail()
        return { canceled: false, filePaths: [target] }
      },
    })
    const result = await invoke('mc-diff:pick', { side: 'proposed' })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.deepEqual(Object.keys(result).sort(), cause === 'unexpected handler failure' ? ['code', 'ok'] : ['canceled', 'code', 'ok'])
    assert.doesNotMatch(JSON.stringify(result), /fixture-internal-details|fixture contents/)
    assert.equal(reads, cause === 'read failure' ? 1 : 0, 'a refusal must not read file contents')
  })
}

for (const [cause, code] of readFailures.filter(([cause]) => cause !== 'outside workspace')) {
  test(`T347 real history handler distinguishes ${cause}`, async () => {
    const target = put(workRoot, `history-${code}.txt`, 'fixture contents\n')
    const fail = () => { const error = new Error(`fixture-internal-details: ${target}`); error.code = 'EACCES'; throw error }
    const disk = { ...fs,
      statSync: candidate => candidate === target && cause === 'stat failure' ? fail() : fs.statSync(candidate),
      readFileSync: candidate => cause === 'read failure' ? fail() : fs.readFileSync(candidate),
    }
    const surface = createDiffFiles({ fs: disk, path, randomUUID,
      workspaceRoots: () => cause === 'no workspace' ? [] : [workRoot] })
    const invoke = compareHandlers(surface, { failHandler: cause === 'unexpected handler failure' })
    const result = await invoke('mc-diff:read-change', { path: target })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.doesNotMatch(JSON.stringify(result), /fixture-internal-details|fixture contents/)
    assert.equal(JSON.stringify(result).includes(target), false)
  })
}

test('T347 history scope refusal, cancellation, successful read and sender refusal keep their behavior', async () => {
  const target = put(workRoot, 'handler-success.txt', 'kept\n')
  const outside = put(outsideRoot, 'handler-outside.txt', 'outside\n')
  const surface = files()
  const invoke = compareHandlers(surface, { choose: async () => ({ canceled: true, filePaths: [] }) })
  assert.deepEqual(await invoke('mc-diff:pick'), { ok: true, canceled: true })
  assert.equal((await invoke('mc-diff:read-change', { path: target })).text, 'kept\n')
  assert.deepEqual(await invoke('mc-diff:read-change', { path: outside }), { ok: false, code: 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE' })
  const refused = compareHandlers(surface, { trusted: false, choose: () => { throw Error('dialog must not open') } })
  assert.deepEqual(await refused('mc-diff:pick'), { ok: false, code: 'TEST_UNTRUSTED_SENDER' })
})

test('T347 a thrown stamp handler is distinct from a file read failure', async () => {
  const invoke = compareHandlers(files(), { failHandler: true })
  assert.deepEqual(await invoke('mc-diff:stamp', { path: path.join(workRoot, 'stamp.txt') }),
    { ok: false, code: 'MC_DIFF_HANDLER_FAILED' })
})

test('T347 unexpected reader exceptions survive the actual session adapter as handler failures', async () => {
  const fail = () => { throw new Error('fixture-internal-details') }
  const invoke = compareHandlers({ ...files(), readChange: fail, stamp: fail })
  // The relative path takes the early readDefault path; the absolute path
  // passes the account assertion. Neither failure is an authority refusal.
  for (const candidate of ['relative.txt', path.join(workRoot, 'adapter.txt')]) {
    assert.deepEqual(await invoke('mc-diff:read-change', { path: candidate }),
      { ok: false, code: 'MC_DIFF_HANDLER_FAILED' })
  }
  assert.deepEqual(await invoke('mc-diff:stamp', { path: path.join(workRoot, 'adapter.txt') }),
    { ok: false, code: 'MC_DIFF_HANDLER_FAILED' })
})

test('T347 a refused account assertion still refuses before reader work', async () => {
  let reads = 0
  const invoke = compareHandlers({ ...files(), readChange: () => { reads++; throw Error('must not run') } },
    { assertPath: () => { throw Error('fixture-private-boundary') } })
  assert.deepEqual(await invoke('mc-diff:read-change', { path: path.join(workRoot, 'blocked.txt') }),
    { ok: false, code: 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE' })
  assert.equal(reads, 0)
})

test('T347 real stamp handler distinguishes absent files from inaccessible metadata', async () => {
  const target = path.join(workRoot, 'stamp-fault.txt')
  for (const cause of ['ENOENT', 'EACCES', 'EIO']) {
    const disk = { ...fs, statSync: candidate => {
      if (candidate !== target) return fs.statSync(candidate)
      const error = new Error('fixture-internal-details'); error.code = cause; throw error
    } }
    const surface = createDiffFiles({ fs: disk, path, randomUUID, workspaceRoots: () => [workRoot] })
    const invoke = compareHandlers(surface)
    const result = await invoke('mc-diff:stamp', { path: target })
    if (cause === 'ENOENT') {
      assert.equal(result.ok, true)
      assert.equal(result.exists, false)
    } else assert.deepEqual(result, { ok: false, code: 'MC_DIFF_STAT_FAILED' })
  }
})

test('a file inside the work folder reads back exactly, with its size and its stamp', () => {
  const target = put(workRoot, 'inside.txt', 'first line\nsecond line\n')
  const result = files().read(target)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'first line\nsecond line\n')
  assert.equal(result.bytes, fs.statSync(target).size)
  assert.equal(Number.isInteger(result.modifiedMs), true)
})

test('a save writes the exact bytes, and the file on disk is what the window sent', () => {
  const target = put(workRoot, 'saved.txt', 'before\n')
  const written = files().write(target, 'after\nwith a second line\n')
  assert.equal(written.ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\nwith a second line\n')
})

test('a save may create a file that is not there yet, beside one that is', () => {
  put(workRoot, 'neighbour.txt', 'x\n')
  const target = path.join(workRoot, 'brand-new.txt')
  assert.equal(fs.existsSync(target), false)
  assert.equal(files().write(target, 'made here\n').ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'made here\n')
})

test('a folder whose name begins with two dots is INSIDE the work folder', () => {
  /* The check a naive startsWith('..') gets wrong. It is a real directory name
     -- ..config is an ordinary folder -- and refusing it would be a fence that
     is wrong in the direction nobody notices until a person cannot save. */
  const target = put(workRoot, path.join('..config', 'kept.txt'), 'yes\n')
  const result = files().read(target)
  assert.equal(result.ok, true, `..config was refused: ${result.code}`)
  assert.equal(files().write(target, 'still yes\n').ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'still yes\n')
})

test('a path outside the work folder is refused for reading and for writing', () => {
  const target = put(outsideRoot, 'secret.txt', 'not yours\n')
  assert.equal(files().read(target).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  const attempt = files().write(target, 'overwritten\n')
  assert.equal(attempt.code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(fs.readFileSync(target, 'utf8'), 'not yours\n', 'the refused save changed the file anyway')
})

test('a neighbouring folder whose name merely BEGINS with the work folder is outside it', () => {
  /* THE MUTATION THAT SURVIVED THE FIRST DRAFT OF THIS FILE. Replacing the
     whole fence with `resolved.startsWith(root)` passed every other test here,
     and it is a real escape: with the work folder at <sandbox>\work, every file
     under <sandbox>\work-elsewhere begins with that string and none of them is
     inside it. A person with a `project` and a `project-old` folder hits this
     on their first afternoon. */
  const neighbour = `${workRoot}-elsewhere`
  fs.mkdirSync(neighbour, { recursive: true })
  const target = put(neighbour, 'nearby.txt', 'not in the work folder\n')
  assert.equal(files().read(target).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(files().write(target, 'clobbered\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(fs.readFileSync(target, 'utf8'), 'not in the work folder\n')
  /* And the work folder ITSELF is not a file to be written over. */
  assert.equal(files().write(workRoot, 'over the folder\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
})

test('the same file typed in a different case is still the same file', (t) => {
  if (process.platform !== 'win32') { t.skip('a case-insensitive filesystem is a Windows shape here'); return }
  /* The other direction of the same rule, and the one a fence gets wrong by
     being too strict: Windows paths are case-insensitive, so refusing a path
     because its drive letter arrived in the other case would refuse a file the
     person is looking at. */
  const target = put(workRoot, 'CasedName.txt', 'kept\n')
  const shouted = path.join(workRoot.toUpperCase(), 'CASEDNAME.TXT')
  const result = files().read(shouted)
  assert.equal(result.ok, true, `a differently cased path was refused: ${result.code}`)
  assert.equal(result.text, 'kept\n')
  assert.equal(files().write(shouted, 'written through the other case\n').ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'written through the other case\n')
})

test('a path that climbs out with .. is refused, and the bytes are untouched', () => {
  put(outsideRoot, 'climbed.txt', 'still mine\n')
  const climbing = path.join(workRoot, '..', 'outside', 'climbed.txt')
  assert.equal(files().read(climbing).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(files().write(climbing, 'clobbered\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(fs.readFileSync(path.join(outsideRoot, 'climbed.txt'), 'utf8'), 'still mine\n')
})

test('a junction inside the work folder does not lead out of it', (t) => {
  /* THE ONE A STRING COMPARISON WAVES THROUGH. `<work>\door\out.txt` is inside
     the work folder by every test you can do on the text, and points at another
     part of the disk entirely. Windows only; elsewhere the same shape is a
     symbolic link, which this makes instead. */
  const linkPath = path.join(workRoot, 'door')
  const target = put(outsideRoot, 'out.txt', 'behind the door\n')
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, outsideRoot], { stdio: 'ignore' })
    } else {
      fs.symlinkSync(outsideRoot, linkPath, 'dir')
    }
  } catch (error) {
    /* A machine that will not let this process make a link cannot answer the
       question. Skipping is honest; passing would not be. */
    t.skip(`this machine refused to create a link: ${error && error.code}`)
    return
  }
  const through = path.join(linkPath, 'out.txt')
  assert.equal(fs.existsSync(through), true, 'the link was not made, so nothing was tested')
  assert.equal(files().read(through).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(files().write(through, 'through the door\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(fs.readFileSync(target, 'utf8'), 'behind the door\n')
})

test('a path on another drive is refused rather than treated as relative', (t) => {
  if (process.platform !== 'win32') { t.skip('drive letters are a Windows shape'); return }
  const other = workRoot.toLowerCase().startsWith('c:') ? 'D:\\somewhere\\file.txt' : 'C:\\somewhere\\file.txt'
  assert.equal(files().write(other, 'no\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
})

test('the fence follows the work folder rather than the launch, because it is read per call', () => {
  const moved = path.join(sandbox, 'moved-work')
  fs.mkdirSync(moved, { recursive: true })
  const target = put(moved, 'later.txt', 'one\n')
  let roots = [workRoot]
  const surface = files(() => roots)
  assert.equal(surface.write(target, 'two\n').code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  roots = [moved]
  assert.equal(surface.write(target, 'two\n').ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'two\n')
})

test('with no work folder recorded, nothing can be read or written', () => {
  const target = put(workRoot, 'orphan.txt', 'kept\n')
  const none = files(() => [])
  assert.equal(none.read(target).code, 'MC_DIFF_NO_WORKSPACE')
  assert.equal(none.write(target, 'lost\n').code, 'MC_DIFF_NO_WORKSPACE')
  assert.equal(fs.readFileSync(target, 'utf8'), 'kept\n')
  /* A workspaceRoots function that THROWS is the same answer, not an
     exception that reaches the window as a message with a path in it. */
  const broken = files(() => { throw new Error('the record could not be read') })
  assert.equal(broken.write(target, 'lost\n').code, 'MC_DIFF_NO_WORKSPACE')
})

test('a work folder that is not on the disk fences nothing, and answers by its own name', () => {
  /* THE REFUSAL THAT COULD NOT BE REACHED. `contains()` is a string
     comparison, so a work folder that was never created still "contained"
     every path typed under it: the save passed the fence and failed at the
     disk with "check that it is still there", which is advice about the file
     when the missing thing is the folder. shell/main.cjs's own list cannot be
     empty -- ensureWorkspaceRoot() returns its path whatever mkdirSync did --
     so this is what gives that unconditional answer a way to be wrong. */
  const absent = path.join(sandbox, 'never-made')
  assert.equal(fs.existsSync(absent), false)
  const surface = files(() => [absent])
  const target = path.join(absent, 'file.txt')
  assert.equal(surface.read(target).code, 'MC_DIFF_NO_WORKSPACE')
  assert.equal(surface.write(target, 'x').code, 'MC_DIFF_NO_WORKSPACE')
  assert.equal(fs.existsSync(absent), false, 'the refused save created the folder it refused for')

  /* A file is not a folder to work inside either. */
  const notAFolder = put(sandbox, 'a-file-root.txt', 'x\n')
  assert.equal(files(() => [notAFolder]).write(path.join(notAFolder, 'child.txt'), 'x').code,
    'MC_DIFF_NO_WORKSPACE')

  /* AND THE FENCE THAT IS WRONG IN THE OTHER DIRECTION IS NOT THE FIX. One
     unusable root beside one real one leaves the real one working. */
  const both = files(() => [absent, workRoot])
  const inside = path.join(workRoot, 'still-reachable.txt')
  assert.equal(both.write(inside, 'still fine\n').ok, true,
    'a work folder that is missing took a work folder that is there down with it')
  assert.equal(fs.readFileSync(inside, 'utf8'), 'still fine\n')
})

test('a folder, an absent file and a file that is not text each refuse by their own name', () => {
  fs.mkdirSync(path.join(workRoot, 'a-folder'), { recursive: true })
  assert.equal(files().read(path.join(workRoot, 'a-folder')).code, 'MC_DIFF_NOT_A_FILE')
  assert.equal(files().read(path.join(workRoot, 'never-existed.txt')).code, 'MC_DIFF_STAT_FAILED')
  const binary = path.join(workRoot, 'program.bin')
  fs.writeFileSync(binary, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]))
  assert.equal(files().read(binary).code, 'MC_DIFF_NOT_TEXT')
  /* And the save half: a window that somehow held bytes with a zero in them
     must not be able to write them over a source file. */
  assert.equal(files().write(path.join(workRoot, 'inside.txt'), 'a\u0000b').code, 'MC_DIFF_NOT_TEXT')
})

test('a file larger than the stated limit refuses on both sides of the verb', () => {
  const big = path.join(workRoot, 'big.txt')
  fs.writeFileSync(big, 'x'.repeat(MAX_FILE_BYTES + 1), 'utf8')
  assert.equal(files().read(big).code, 'MC_DIFF_TOO_LARGE')
  /* A DIFFERENT CODE ON THE WRITE SIDE, on purpose. The read's sentence says to
     open the file in a usual editor instead, which is right for a file nobody
     has opened yet; the save happens over a box holding the only copy of an
     hour's hand editing, where that sentence is a dead end. src/diff-editor.js
     carries the two sentences and its own suite holds them apart. */
  assert.equal(files().write(big, 'y'.repeat(MAX_FILE_BYTES + 1)).code, 'MC_DIFF_TOO_LARGE_TO_SAVE')
  /* Exactly at the limit is allowed, so the boundary is the number the window
     states and not one byte either side of it. */
  const edge = path.join(workRoot, 'edge.txt')
  assert.equal(files().write(edge, 'z'.repeat(MAX_FILE_BYTES)).ok, true)
  assert.equal(fs.statSync(edge).size, MAX_FILE_BYTES)
})

test('a missing path, an empty one and one carrying a zero byte are all refused', () => {
  for (const candidate of ['', '   \t ', null, undefined, 42, {}, `${workRoot}\u0000.txt`]) {
    const result = files().write(candidate, 'x')
    assert.equal(result.ok, false, `${String(candidate)} was accepted`)
    assert.equal(result.code, 'MC_DIFF_PATH_MISSING')
  }
  assert.equal(files().write(path.join(workRoot, 'inside.txt'), null).code, 'MC_DIFF_TEXT_MISSING')
})

test('no refusal carries a sentence or a path back to the window', () => {
  /* The rule rendererSafeAgentError() states in shell/main.cjs, asserted rather
     than trusted: an error MESSAGE is the field that names absolute roots, so
     this module answers with a code and a code alone. */
  const answers = [
    files().read(path.join(outsideRoot, 'secret.txt')),
    files().write(path.join(outsideRoot, 'secret.txt'), 'x'),
    files(() => []).write(path.join(workRoot, 'inside.txt'), 'x'),
    files().read(path.join(workRoot, 'never-existed.txt')),
  ]
  for (const answer of answers) {
    assert.deepEqual(Object.keys(answer).sort(), ['code', 'ok'], `a refusal carried more than its code: ${JSON.stringify(answer)}`)
    assert.equal(/[\\/]/.test(answer.code), false, 'a refusal code looks like a path')
  }
})

test('a save leaves the saved file and nothing else behind', () => {
  /* THE HALF OF THE PIN THIS FILE OWES. The compare window's risk statement
     says a save "replaces the file straight away and nothing here undoes it",
     and tools/test/permission-guidance.test.mjs pins that sentence against this
     module. If a copy of the old contents were kept anywhere -- a backup, a
     temporary that survived, an undo record -- the sentence would be wrong in
     the direction that matters. It is not kept, and this is where that is
     measured rather than asserted from the source. */
  const room = path.join(sandbox, 'undo-check')
  fs.mkdirSync(room, { recursive: true })
  const target = path.join(room, 'only.txt')
  fs.writeFileSync(target, 'the original contents\n', 'utf8')
  assert.equal(files(() => [room]).write(target, 'replaced\n').ok, true)
  assert.deepEqual(fs.readdirSync(room), ['only.txt'])
  assert.equal(fs.readFileSync(target, 'utf8'), 'replaced\n')
})

test('every compare-window channel opens with the sender check, and only one of them writes', () => {
  /* THE SAME CENSUS tools/test/account-panel-copy.test.mjs runs over the
     account channels, for the same reason: a channel that reaches the disk on
     behalf of the window has to be one this application's own main frame
     asked for, and a check that is present on two channels out of three is a
     hole rather than a habit.
     `withFleetProfileSender` is this shell's generic "is this our own main
     frame, at our own origin" test despite its name -- see its note in
     shell/main.cjs, and assertTrustedAgentSender, which reuses it rather than
     writing a second one. */
  const main = readSource('shell/main.cjs')
  const declared = [...main.matchAll(/ipcMain\.handle\('(mc-diff:[a-z-]+)'/g)]
  assert.equal(declared.length, 4, `${declared.length} compare-window channels were found, not the four this feature declares`)
  assert.deepEqual(declared.map(match => match[1]).sort(), ['mc-diff:pick', 'mc-diff:read-change', 'mc-diff:save', 'mc-diff:stamp'])
  for (const channel of declared) {
    /* The handler runs to the next `ipcMain.handle(` in the file, which is how
       the whole body is read rather than a first line that happens to look
       right. */
    const from = channel.index
    const next = main.indexOf('ipcMain.handle(', from + 1)
    const body = main.slice(from, next === -1 ? main.length : next)
    assert.match(body, /withFleetProfileSender/, `${channel[1]} skips the sender check`)
  }

  /* ONE WRITE PATH, AND WHAT THIS DOES AND DOES NOT PROVE.
     It walks every use of the fenced surface in the main process and requires
     each to be one of the three verbs, with exactly one of them the write; and
     it requires the three mc-diff handler bodies to reach the disk through that
     surface alone rather than through fs directly. What it CANNOT see is a
     write somewhere else in this 8,000-line file spelled some other way -- the
     earlier version of this test counted one literal string and was described
     as a census, which it was not. This is a gate on the compare window's own
     channels; it is not a gate on the whole main process. */
  const uses = [...main.matchAll(/getDiffFiles\(\)\.([a-zA-Z]+)\(/g)].map(match => match[1])
  assert.deepEqual(uses.filter(name => name === 'write').length, 1,
    `the compare window writes from ${uses.filter(name => name === 'write').length} places in the main process`)
  for (const name of uses) {
    assert.ok(['read', 'readChange', 'stamp', 'write'].includes(name),
      `the compare window's file surface is used for "${name}", which is not one of its four verbs`)
  }
  assert.equal([...main.matchAll(/createDiffFiles\(/g)].length, 1,
    'a second fenced surface is built in the main process, so two fences can drift apart')

  for (const channel of declared) {
    const from = channel.index
    const next = main.indexOf('ipcMain.handle(', from + 1)
    const body = main.slice(from, next === -1 ? main.length : next)
    assert.equal(/\bfs\.[a-zA-Z]*(?:write|rename|unlink|mkdir|rm|copy|append|open)/i.test(body), false,
      `${channel[1]} reaches the disk without going through the fenced surface`)
    /* AND A THROW OUT OF ONE IS A CODE. withFleetProfileSender answers an
       exception with { ok:false, error:{ code, message } }; an fs message names
       an absolute path, and diffAnswer() is the catch that runs first. */
    assert.match(body, /diffAnswer\('MC_DIFF_[A-Z_]+',/,
      `${channel[1]} lets a throw reach the outer wrapper, which sends its message`)
  }

  const preload = readSource('shell/fleet-profile-preload.cjs')
  const bridge = preload.match(/exposeInMainWorld\('mcDiff', Object\.freeze\(\{[\s\S]*?\}\)\)/)
  assert.ok(bridge, 'the window has no bridge to the main process')
  assert.deepEqual([...bridge[0].matchAll(/invoke\('(mc-diff:[a-z-]+)'/g)].map(match => match[1]).sort(),
    ['mc-diff:pick', 'mc-diff:read-change', 'mc-diff:save', 'mc-diff:stamp'],
    'the bridge reaches a channel the main process does not answer, or misses one it does')
})

test('every verb this module offers is fenced, not just the two anybody tested', () => {
  /* THE MUTATION THAT SURVIVED A WHOLE GREEN SUITE. Replacing `fenced()` inside
     stamp() with `{ ok: true, path: path.resolve(candidate) }` passed all 51
     tests: read and write were driven against a path outside the work folder
     and stamp never was. An unfenced stamp is an existence, size and
     modified-time oracle over the whole disk for this window -- less than a
     read and still an answer about a file the agent itself could not see.
     Every verb the module returns is walked here, so a fourth one added later
     with no fence fails this rather than shipping. */
  const surface = files()
  const verbs = Object.keys(surface).filter(name => name !== 'fenced')
  assert.deepEqual(verbs.sort(), ['read', 'readChange', 'stamp', 'write'],
    'this module offers a verb this test does not know about; teach it the verb or fence the verb')

  const outside = put(outsideRoot, 'oracle.txt', 'not yours\n')
  for (const verb of verbs) {
    const answer = surface[verb](outside, 'x')
    assert.equal(answer.ok, false, `${verb}() answered about a file outside the work folder`)
    assert.equal(answer.code, 'MC_DIFF_OUTSIDE_WORKSPACE', `${verb}() refused for the wrong reason: ${answer.code}`)
    assert.deepEqual(Object.keys(answer).sort(), ['code', 'ok'],
      `${verb}() carried something back about a file it must not have looked at: ${JSON.stringify(answer)}`)
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not yours\n')

  /* The same three against a work folder that is not recorded at all. */
  const none = files(() => [])
  for (const verb of verbs) {
    assert.equal(none[verb](path.join(workRoot, 'inside.txt'), 'x').code, 'MC_DIFF_NO_WORKSPACE',
      `${verb}() answered with no work folder recorded`)
  }
})

test('a write that Windows refuses in passing is retried, and one it refuses outright is not', () => {
  /* THE APPARATUS NOTHING DISTINGUISHED FROM A SINGLE ATTEMPT. WRITE_ATTEMPTS
     5 -> 1 was green, and so was emptying the retryable set: about twenty lines
     carrying a measurement ("two EPERM in 512 writes") that no test could tell
     from their own absence. Both directions are driven here, because a retry
     apparatus that retries EVERYTHING is the other way to be wrong -- it turns
     a permanent refusal into five of them and a fivefold wait. */
  const attempts = { count: 0 }
  const flaky = {
    ...fs,
    openSync: (...args) => {
      attempts.count += 1
      if (attempts.count < 3) { const error = new Error('held'); error.code = 'EPERM'; throw error }
      return fs.openSync(...args)
    },
  }
  const target = path.join(workRoot, 'retried.txt')
  const surface = createDiffFiles({ fs: flaky, path, randomUUID, workspaceRoots: () => [workRoot] })
  assert.equal(surface.write(target, 'landed after two refusals\n').ok, true,
    'a transient Windows refusal ended the save instead of being waited out')
  assert.equal(attempts.count, 3, `the write was attempted ${attempts.count} times, not the three this needed`)
  assert.equal(fs.readFileSync(target, 'utf8'), 'landed after two refusals\n')

  /* A refusal that will never clear is answered at once. ENOENT is the shape:
     the folder is not there and waiting four milliseconds will not create it. */
  const gone = { count: 0 }
  const permanent = {
    ...fs,
    openSync: () => { gone.count += 1; const error = new Error('no folder'); error.code = 'ENOENT'; throw error },
  }
  const second = createDiffFiles({ fs: permanent, path, randomUUID, workspaceRoots: () => [workRoot] })
  assert.equal(second.write(path.join(workRoot, 'never.txt'), 'x').code, 'MC_DIFF_WRITE_FAILED')
  assert.equal(gone.count, 1,
    `a refusal that cannot clear was attempted ${gone.count} times; only the retryable ones are worth waiting on`)

  /* And a transient one that never clears gives up rather than spinning, at the
     number the module states. */
  const stubborn = { count: 0 }
  const held = {
    ...fs,
    openSync: () => { stubborn.count += 1; const error = new Error('held'); error.code = 'EBUSY'; throw error },
  }
  const third = createDiffFiles({ fs: held, path, randomUUID, workspaceRoots: () => [workRoot] })
  assert.equal(third.write(path.join(workRoot, 'busy.txt'), 'x').code, 'MC_DIFF_WRITE_FAILED')
  assert.equal(stubborn.count, WRITE_ATTEMPTS,
    `a file held open was attempted ${stubborn.count} times, not the ${WRITE_ATTEMPTS} this module says it makes`)
})

test('a failed write leaves no half-written file and no temporary beside it', () => {
  /* The atomic claim in the module's own header, walked rather than read: the
     original is what a reader still gets, and the scratch file it writes
     through is not left in the person's folder. */
  const room = path.join(sandbox, `partial-${randomUUID()}`)
  fs.mkdirSync(room, { recursive: true })
  const target = path.join(room, 'kept.txt')
  fs.writeFileSync(target, 'the original contents\n', 'utf8')
  const broken = {
    ...fs,
    renameSync: () => { const error = new Error('denied'); error.code = 'ENOTSUP'; throw error },
  }
  const surface = createDiffFiles({ fs: broken, path, randomUUID, workspaceRoots: () => [room] })
  assert.equal(surface.write(target, 'never lands\n').code, 'MC_DIFF_WRITE_FAILED')
  assert.equal(fs.readFileSync(target, 'utf8'), 'the original contents\n',
    'a write that failed took the original with it')
  assert.deepEqual(fs.readdirSync(room), ['kept.txt'],
    `the failed write left something behind: ${fs.readdirSync(room).join(', ')}`)
})

test('a throw out of a channel becomes a code, not a message with a path in it', () => {
  /* THE HALF OF THE "never a sentence and never a path" RULE THIS MODULE DID
     NOT HOLD. shell/main.cjs wraps these channels in withFleetProfileSender,
     which catches a throw and answers { ok:false, error:{ code, message } } --
     and an fs message names an absolute path. The module itself never throws,
     but dialog.showOpenDialog can, and so can anything a future channel calls
     before reaching here. diffAnswer() is the catch that runs INSIDE that one,
     so the message never gets as far as the wrapper. */
  const thrown = new Error(`EACCES: permission denied, open '${path.join(workRoot, 'private.txt')}'`)
  thrown.code = 'EACCES'
  const answer = diffAnswer('MC_DIFF_READ_FAILED', () => { throw thrown })
  assert.deepEqual(answer, { ok: false, code: 'MC_DIFF_READ_FAILED' })
  assert.equal(JSON.stringify(answer).includes(workRoot), false, 'the reply carried the path that threw')

  /* A verb that answers normally is handed straight back, refusals included --
     this is a catch, not a second opinion about what a refusal is. */
  const fine = { ok: true, path: 'kept', text: 'x' }
  assert.equal(diffAnswer('MC_DIFF_READ_FAILED', () => fine), fine)
  assert.deepEqual(diffAnswer('MC_DIFF_WRITE_FAILED', () => ({ ok: false, code: 'MC_DIFF_TOO_LARGE' })),
    { ok: false, code: 'MC_DIFF_TOO_LARGE' })
})

test('a promise that rejects out of a channel is answered the same way', async () => {
  const answer = await diffAnswer('MC_DIFF_WRITE_FAILED', async () => {
    throw new Error(`EPERM: operation not permitted, rename '${path.join(workRoot, 'a')}' -> '${path.join(workRoot, 'b')}'`)
  })
  assert.deepEqual(answer, { ok: false, code: 'MC_DIFF_WRITE_FAILED' })
  assert.deepEqual(await diffAnswer('MC_DIFF_READ_FAILED', async () => ({ ok: true, canceled: true })),
    { ok: true, canceled: true })
})

test('a disk that refuses the write reports it, and does not report success', () => {
  /* A failing disk handed in through the injected fs, because a green result
     from a write that did not happen is the worst answer this module could
     give: the window would draw "Saved" over a file it never touched. */
  const angry = {
    ...fs,
    openSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error },
  }
  const surface = createDiffFiles({ fs: angry, path, randomUUID, workspaceRoots: () => [workRoot] })
  const result = surface.write(path.join(workRoot, 'inside.txt'), 'never lands\n')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_DIFF_WRITE_FAILED')
})
