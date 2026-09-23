/* OPENING A FILE AN AGENT LEFT BEHIND -- THE MAIN-PROCESS HALF, DRIVEN.
 *
 * WHAT THIS SUITE ACTUALLY RUNS, because that is the only interesting thing
 * about a fence test:
 *
 *   the REAL src/lib/workspace-boundary.js out of a payload staged on disk,
 *   resolved through the REAL resolveCapabilityRoot() from
 *   shell/capability-layer.cjs, over REAL folders and REAL files in a temp
 *   directory, with only the two Electron calls -- shell.openPath and
 *   shell.showItemInFolder -- replaced by recorders.
 *
 * A STUB FENCE WOULD HAVE MADE THIS SUITE WORTHLESS. The whole risk in this
 * feature is that a path outside the person's folders reaches openPath, and a
 * hand-written stand-in for the boundary would answer whatever the author of
 * the stub believed -- which is exactly the belief the boundary module exists
 * because it was wrong. tools/test/fixtures/workspace-fence/src/lib/
 * workspace-boundary.js is therefore a byte-for-byte copy of the engine module,
 * and the first test below re-proves the module's own documented refusals
 * against whatever is staged, so a weakened copy fails here rather than passing
 * quietly.
 *
 * WHAT IT CANNOT MEASURE, said plainly:
 *
 *   1. A FILE symlink escape. Creating one needs a privilege this account does
 *      not hold (measured: EPERM), so the symlink direction is driven with a
 *      DIRECTORY JUNCTION instead, which needs no privilege and goes through
 *      the same fs.realpathSync.native resolution inside the boundary.
 *   2. Whether Windows really opens the file. openPath is a recorder here; the
 *      Electron call itself is unrun in `node --test`. So section 9 proves
 *      WHICH PATHS REACH THE HAND-OFF and which never do, which is the half
 *      this process can decide; what the operating system then does with the
 *      ones that reach it is Windows' business and is not measured here.
 *   3. Whether main.cjs registers these verbs. That is tools/test/
 *      agent-files-wiring.test.mjs, which reads the shell's own source.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import nodeFs, {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const {
  createAgentFileSurface, BOUNDARY_MODULE, FENCE_CODES, MAX_FILES, MAX_READ_BYTES,
  OPENABLE_EXTENSIONS, canOpen, fileKind, boundedName,
} = require_(path.join(REPO, 'shell', 'agent-files.cjs'))
const { resolveCapabilityRoot } = require_(path.join(REPO, 'shell', 'capability-layer.cjs'))

const FENCE_FIXTURE = path.join(REPO, 'tools', 'test', 'fixtures', 'workspace-fence', BOUNDARY_MODULE)

function temp(prefix) {
  return mkdtempSync(path.join(tmpdir(), `mc-files-${prefix}-`))
}

/* A payload laid out the way an installed one is: <resources>/capability with a
   PAYLOAD.json beside the module tree. Staged rather than faked so the real
   resolver is what finds it. */
function stagePayload({ fence = 'real' } = {}) {
  const resources = temp('payload')
  const root = path.join(resources, 'capability')
  mkdirSync(path.join(root, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(root, 'PAYLOAD.json'),
    JSON.stringify({ bridgeEntrypoint: 'tools/mission-bridge.js', fileCount: 1, hostModules: [BOUNDARY_MODULE] }))
  /* The engine is `type: commonjs` and its modules are require()d by the shell.
     Staging that fact is part of staging the payload: without it a payload
     unpacked under a `type: module` tree would fail to load its own fence. */
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'payload', private: true, type: 'commonjs' }))
  if (fence === 'real') copyFileSync(FENCE_FIXTURE, path.join(root, ...BOUNDARY_MODULE.split('/')))
  if (fence === 'unrecognized') {
    writeFileSync(path.join(root, ...BOUNDARY_MODULE.split('/')), 'module.exports = { somethingElse: true }\n')
  }
  return () => resolveCapabilityRoot({ resourcesPath: resources, repoRoot: resources })
}

function fillFolder(root, files) {
  mkdirSync(root, { recursive: true })
  for (const [name, { text = 'x', at = null }] of Object.entries(files)) {
    const file = path.join(root, name)
    writeFileSync(file, text)
    if (at) utimesSync(file, new Date(at), new Date(at))
  }
  return root
}

function surface(options = {}) {
  const opened = []
  const revealed = []
  const logged = []
  const made = createAgentFileSurface({
    fs: options.fs || nodeFs,
    resolveCapabilityRoot: options.resolveCapabilityRoot || stagePayload(),
    requireModule: require_,
    readWorkspaceState: options.readWorkspaceState || (() => ({ ok: true, available: true, roots: [] })),
    listSessionProfiles: options.listSessionProfiles || (() => []),
    productWorkspaceRoot: options.productWorkspaceRoot ?? null,
    openPath: options.openPath || (async (target) => { opened.push(target); return '' }),
    showItemInFolder: options.showItemInFolder || ((target) => { revealed.push(target) }),
    log: line => logged.push(line),
  })
  return { files: made, opened, revealed, logged }
}

/* ------------------------------------------------------------------ *
 * 0. The staged fence is the real one, proven by its own refusals.
 * ------------------------------------------------------------------ */

test('the staged workspace boundary still refuses everything it documents', () => {
  const boundary = require_(FENCE_FIXTURE)
  const root = temp('fence')
  const outside = temp('outside')

  assert.equal(boundary.isInsideRoots(path.join(root, 'a.txt'), [root]), true)
  assert.equal(boundary.isInsideRoots(path.join(root, 'deep', 'a.txt'), [root]), true)
  assert.equal(boundary.isInsideRoots(path.join(outside, 'a.txt'), [root]), false)
  assert.equal(boundary.isInsideRoots(path.join(root, '..', 'a.txt'), [root]), false)
  /* Prefix collision: `<root>-evil` starts with `<root>` and is not inside it. */
  assert.equal(boundary.isInsideRoots(`${root}-evil`, [root]), false)
  /* Shapes refused outright rather than reasoned about. */
  assert.throws(() => boundary.isInsideRoots('\\\\server\\share\\a.txt', [root]), /UNC or device path/)
  const colonPath = `${path.join(root, 'a.txt')}:hidden`
  if (process.platform === 'win32') {
    assert.throws(() => boundary.isInsideRoots(colonPath, [root]), /alternate data stream/)
  } else {
    writeFileSync(colonPath, 'ordinary POSIX filename')
    assert.equal(boundary.isInsideRoots(colonPath, [root]), true)
    assert.equal(boundary.isInsideRoots(path.join(outside, 'a.txt:hidden'), [root]), false)
  }
  /* An empty root list must never read as "no restriction". */
  assert.throws(() => boundary.isInsideRoots(path.join(root, 'a.txt'), []), /no recorded workspace folder/)
  /* A root that is not there refuses instead of admitting its whole subtree. */
  assert.throws(() => boundary.isInsideRoots(path.join(root, 'a.txt'), [path.join(outside, 'gone')]),
    /the boundary cannot be trusted/)
})

test('the vendored fence is byte-identical to the module the manifest stages', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  assert.ok(manifest.hostModules.includes(BOUNDARY_MODULE),
    `${BOUNDARY_MODULE} must be declared in hostModules or no installed copy carries the fence`)
})

/* ------------------------------------------------------------------ *
 * 1. Construction fails closed.
 * ------------------------------------------------------------------ */

test('a missing dependency refuses the surface at construction, not at a verb', () => {
  for (const missing of ['resolveCapabilityRoot', 'requireModule', 'readWorkspaceState',
    'listSessionProfiles', 'openPath', 'showItemInFolder']) {
    const deps = {
      resolveCapabilityRoot: () => null,
      requireModule: require_,
      readWorkspaceState: () => ({ roots: [] }),
      listSessionProfiles: () => [],
      openPath: async () => '',
      showItemInFolder: () => {},
    }
    delete deps[missing]
    assert.throws(() => createAgentFileSurface(deps), new RegExp(missing))
  }
  /* And the file system it reads the listing through. Handed one without
     `promises`, this used to build a surface whose list() threw a TypeError
     inside a channel, which reaches a person as an error and not as a
     sentence. */
  assert.throws(() => createAgentFileSurface({
    fs: { readdirSync: () => [], statSync: () => ({}), readFileSync: () => '' },
    resolveCapabilityRoot: () => null,
    requireModule: require_,
    readWorkspaceState: () => ({ roots: [] }),
    listSessionProfiles: () => [],
    openPath: async () => '',
    showItemInFolder: () => {},
  }), /fs\.promises/)
})

/* ------------------------------------------------------------------ *
 * 2. Which folders exist, and what crosses about them.
 * ------------------------------------------------------------------ */

test('the folder list is the folders an agent session can run in, and carries no path', () => {
  const chosen = temp('chosen')
  const profile = temp('profile')
  const product = temp('product')
  const { files } = surface({
    readWorkspaceState: () => ({ ok: true, available: true, roots: [chosen] }),
    listSessionProfiles: () => [{ id: 'profile-abc', name: 'Invoices', cwd: profile }],
    productWorkspaceRoot: product,
  })
  const reply = files.folders()
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.folders.map(entry => entry.id), ['chosen-0', 'profile-abc', 'product'])
  assert.deepEqual(reply.folders.map(entry => entry.kind), ['chosen', 'profile', 'product'])
  assert.equal(reply.folders[0].name, path.basename(chosen))
  assert.equal(reply.folders[1].name, 'Invoices')
  /* THE PRODUCT'S OWN WORKSPACE IS AN INSTALLATION PATH. Its name never
     crosses; the screen prints its own label for it. */
  assert.equal(reply.folders[2].name, null)
  for (const entry of reply.folders) {
    for (const value of Object.values(entry)) {
      if (typeof value !== 'string') continue
      assert.doesNotMatch(value, /[\\/]/, 'no folder reply field may carry a path separator')
    }
  }
})

test('one folder recorded twice is offered once', () => {
  const shared = temp('shared')
  const { files } = surface({
    readWorkspaceState: () => ({ roots: [shared, process.platform === 'win32' ? shared.toUpperCase() : shared + path.sep + '.'] }),
    listSessionProfiles: () => [{ id: 'profile-abc', name: 'Same', cwd: shared }],
  })
  assert.deepEqual(files.folders().folders.map(entry => entry.id), ['chosen-0'])
})

test('a record that throws contributes no folders instead of taking the screen down', () => {
  const { files } = surface({
    readWorkspaceState: () => { throw new Error('unreadable') },
    listSessionProfiles: () => { throw new Error('unreadable') },
  })
  assert.deepEqual(files.folders(), { ok: true, folders: [] })
})

/* ------------------------------------------------------------------ *
 * 3. The listing.
 * ------------------------------------------------------------------ */

function folderWithWork() {
  const root = fillFolder(temp('work'), {
    'REPORT-payment-run.md': { text: '# What I did\n', at: '2026-08-26T10:00:00Z' },
    'P1-REPORT.md': { text: 'older report', at: '2026-08-25T10:00:00Z' },
    'notes.txt': { text: 'plain', at: '2026-08-24T10:00:00Z' },
    'invoice.pdf': { text: '%PDF-1.7', at: '2026-08-27T10:00:00Z' },
  })
  mkdirSync(path.join(root, 'a-sub-folder'))
  return root
}

test('the listing is newest first, files only, with each file’s kind', async () => {
  const root = folderWithWork()
  const { files } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const reply = await files.list({ folderId: 'chosen-0' })
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.files.map(file => file.name),
    ['invoice.pdf', 'REPORT-payment-run.md', 'P1-REPORT.md', 'notes.txt'])
  assert.deepEqual(reply.files.map(file => file.kind), ['other', 'report', 'report', 'text'])
  assert.deepEqual(reply.files.map(file => file.readable), [false, true, true, true])
  /* And whether each may be handed to this computer, which is a different
     question from whether this window can show it: a PDF is opened and never
     read here, and a report is both. */
  assert.deepEqual(reply.files.map(file => file.openable), [true, true, true, true])
  assert.equal(reply.truncated, false)
  assert.equal(reply.total, 4)
  for (const file of reply.files) {
    assert.doesNotMatch(file.name, /[\\/]/)
    assert.equal(new Date(file.changedAt).toISOString(), file.changedAt)
  }
})

test('a folder that is not one of ours is refused by name, and nothing is read', async () => {
  const root = folderWithWork()
  const reads = []
  const { files } = surface({
    readWorkspaceState: () => { reads.push('read'); return { roots: [root] } },
  })
  for (const folderId of ['chosen-9', 'product', '../elsewhere', '', null, 'a b']) {
    const reply = await files.list({ folderId })
    assert.equal(reply.ok, false)
    assert.equal(reply.code, 'FILES_FOLDER_UNKNOWN')
  }
  /* THE SHAPE TEST EARNS ITS PLACE BY WHAT IT DOES NOT DO. `chosen-9` is a
     folder id shaped like ours and has to be looked for, so the records are
     read. The four that are not shaped like one -- and a caller can send a
     megabyte of them -- are refused before this process reads anything at all,
     which is the property that stops a page making the shell work by sending
     junk. */
  assert.equal(reads.length, 2, 'only the two well-shaped ids may reach the records')
  reads.length = 0
  assert.equal((await files.list({ folderId: 'x'.repeat(10_000) })).code, 'FILES_FOLDER_UNKNOWN')
  assert.deepEqual(reads, [])
})

/* ------------------------------------------------------------------ *
 * 4. Open, and the error string that must not be thrown away.
 * ------------------------------------------------------------------ */

test('open hands the file to this computer and says it worked', async () => {
  const root = folderWithWork()
  const { files, opened } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const reply = await files.open({ folderId: 'chosen-0', name: 'invoice.pdf' })
  assert.deepEqual(reply, { ok: true, name: 'invoice.pdf' })
  assert.deepEqual(opened, [path.join(root, 'invoice.pdf')])
})

test('openPath resolving with an error string is REPORTED, never discarded', async () => {
  const root = folderWithWork()
  const { files, opened, logged } = surface({
    readWorkspaceState: () => ({ roots: [root] }),
    openPath: async (target) => { opened.push(target); return 'Failed to open path' },
  })
  const reply = await files.open({ folderId: 'chosen-0', name: 'invoice.pdf' })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'FILES_NO_PROGRAM')
  assert.equal(reply.reason, 'Failed to open path',
    'the string openPath resolved with is the only thing that says why nothing happened')
  assert.equal(logged.length, 1)
})

test('an openPath that throws does not become an unhandled failure', async () => {
  const root = folderWithWork()
  const { files } = surface({
    readWorkspaceState: () => ({ roots: [root] }),
    openPath: async () => { throw new Error('electron is gone') },
  })
  const reply = await files.open({ folderId: 'chosen-0', name: 'invoice.pdf' })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'FILES_OPEN_FAILED')
})

/* ------------------------------------------------------------------ *
 * 5. THE FENCE. Every one of these must refuse WITHOUT opening anything.
 * ------------------------------------------------------------------ */

test('a name that is not a name inside the folder is refused, and nothing is opened', async () => {
  const root = folderWithWork()
  const { files, opened, revealed } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const names = [
    '..',
    '.',
    '../invoice.pdf',
    '..\\..\\Windows\\System32\\calc.exe',
    'C:\\Windows\\System32\\calc.exe',
    '/etc/passwd',
    'sub/notes.txt',
    'notes.txt:hidden',
    'note\u0000s.txt',
    '',
    null,
    'x'.repeat(261),
  ]
  for (const name of names) {
    const reply = await files.open({ folderId: 'chosen-0', name })
    assert.equal(reply.ok, false, `${String(name)} was not refused`)
    assert.equal(reply.code, 'FILES_NAME_REFUSED', `${String(name)} was refused for the wrong reason`)
    assert.equal(files.reveal({ folderId: 'chosen-0', name }).code, 'FILES_NAME_REFUSED')
    assert.equal(files.read({ folderId: 'chosen-0', name }).code, 'FILES_NAME_REFUSED')
  }
  assert.deepEqual(opened, [], 'nothing may be handed to the operating system')
  assert.deepEqual(revealed, [])
})

test('a junction inside the folder that leads out of it is refused by the fence', async () => {
  const root = temp('junction-root')
  const elsewhere = temp('junction-elsewhere')
  writeFileSync(path.join(elsewhere, 'secrets.txt'), 'not yours')
  writeFileSync(path.join(root, 'ours.txt'), 'yours')
  try {
    symlinkSync(elsewhere, path.join(root, 'escape'), 'junction')
  } catch (error) {
    assert.fail(`this machine could not create a junction (${error.code}), so the fence was not driven`)
  }
  const { files, opened } = surface({ readWorkspaceState: () => ({ roots: [root] }) })

  const reply = await files.open({ folderId: 'chosen-0', name: 'escape' })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'FILES_OUTSIDE_FOLDER',
    'a junction leading out of the folder must be refused BY THE FENCE, before anything stats it')
  assert.deepEqual(opened, [])
  /* And the ordinary file beside it still opens, so the refusal above is the
     fence working rather than the folder being unusable. */
  assert.equal((await files.open({ folderId: 'chosen-0', name: 'ours.txt' })).ok, true)
})

test('a recorded folder the fence refuses outright takes its whole folder with it', async () => {
  const gone = path.join(temp('gone'), 'never-created')
  const unc = '\\\\server\\share'
  for (const root of [gone, unc]) {
    const { files, opened } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
    const listed = await files.list({ folderId: 'chosen-0' })
    assert.equal(listed.ok, false, `${root} was listed`)
    assert.equal(listed.code, 'FILES_FOLDER_UNREADABLE')
    const reply = await files.open({ folderId: 'chosen-0', name: 'anything.txt' })
    assert.equal(reply.ok, false)
    assert.equal(reply.code, 'FILES_OUTSIDE_FOLDER')
    assert.deepEqual(opened, [])
  }
})

test('no payload means no fence, which means no verb succeeds and nothing opens', async () => {
  const root = folderWithWork()
  const cases = [[null, 'FILES_PAYLOAD_ABSENT'], ['none', 'FILES_FENCE_ABSENT'],
    ['unrecognized', 'FILES_FENCE_UNRECOGNIZED']]
  /* THE SCREEN SWITCHES ITS CONTROLS OFF ON EXACTLY THESE, and it reads the
     list from here rather than holding a hand-typed copy. A fourth cause of
     "there is no fence in this copy" that nobody adds to FENCE_CODES is a
     panel that leaves its controls live over a surface that refuses
     everything. */
  assert.deepEqual(cases.map(entry => entry[1]), [...FENCE_CODES])
  for (const [fence, code] of cases) {
    const { files, opened, revealed } = surface({
      readWorkspaceState: () => ({ roots: [root] }),
      resolveCapabilityRoot: fence === null ? () => null : stagePayload({ fence }),
    })
    /* The folder list still answers -- it reads records, not files -- so the
       screen can name the folder it cannot act in. */
    assert.equal(files.folders().folders.length, 1)
    for (const reply of [
      await files.list({ folderId: 'chosen-0' }),
      await files.open({ folderId: 'chosen-0', name: 'invoice.pdf' }),
      files.reveal({ folderId: 'chosen-0', name: 'invoice.pdf' }),
      files.read({ folderId: 'chosen-0', name: 'P1-REPORT.md' }),
    ]) {
      assert.equal(reply.ok, false)
      assert.equal(reply.code, code)
      assert.equal(typeof reply.reason, 'string')
    }
    assert.deepEqual(opened, [])
    assert.deepEqual(revealed, [])
  }
})

test('a name that resolves to a folder, or to nothing, is refused before the hand-off', async () => {
  const root = folderWithWork()
  const { files, opened } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  assert.equal((await files.open({ folderId: 'chosen-0', name: 'a-sub-folder' })).code, 'FILES_NOT_A_FILE')
  assert.equal((await files.open({ folderId: 'chosen-0', name: 'not-here.txt' })).code, 'FILES_NOT_THERE')
  assert.deepEqual(opened, [])
})

/* ------------------------------------------------------------------ *
 * 6. Show in folder.
 * ------------------------------------------------------------------ */

test('show in folder points the file manager at the file, once it is known to be there', () => {
  const root = folderWithWork()
  const { files, revealed } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  assert.deepEqual(files.reveal({ folderId: 'chosen-0', name: 'invoice.pdf' }),
    { ok: true, name: 'invoice.pdf' })
  assert.deepEqual(revealed, [path.join(root, 'invoice.pdf')])
  assert.equal(files.reveal({ folderId: 'chosen-0', name: 'not-here.txt' }).code, 'FILES_NOT_THERE')
  assert.equal(revealed.length, 1, 'a file that is not there must not be handed to the file manager')
})

/* ------------------------------------------------------------------ *
 * 7. Reading a report in the window.
 * ------------------------------------------------------------------ */

test('a report reads back exactly, and says it is a report', () => {
  const root = fillFolder(temp('report'), {
    'REPORT-what-i-did.md': { text: '# What I did\n\n- opened the ledger\n' },
  })
  const { files } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const reply = files.read({ folderId: 'chosen-0', name: 'REPORT-what-i-did.md' })
  assert.equal(reply.ok, true)
  assert.equal(reply.kind, 'report')
  assert.equal(reply.text, '# What I did\n\n- opened the ledger\n')
})

test('a file this window cannot show is refused by kind or by size, never by guessing', async () => {
  const root = fillFolder(temp('unreadable'), {
    'invoice.pdf': { text: '%PDF-1.7' },
    'huge.log': { text: 'x'.repeat(MAX_READ_BYTES + 1) },
    'binary.md': { text: `head\u0000tail` },
  })
  const { files } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  assert.equal(files.read({ folderId: 'chosen-0', name: 'invoice.pdf' }).code, 'FILES_NOT_TEXT')
  assert.equal(files.read({ folderId: 'chosen-0', name: 'huge.log' }).code, 'FILES_TOO_BIG')
  assert.equal(files.read({ folderId: 'chosen-0', name: 'binary.md' }).code, 'FILES_NOT_TEXT')
  /* And the listing agrees with the reader, so the screen disables exactly the
     controls the reader would refuse. */
  const listed = await files.list({ folderId: 'chosen-0' })
  const readable = Object.fromEntries(listed.files.map(file => [file.name, file.readable]))
  assert.deepEqual(readable, { 'invoice.pdf': false, 'huge.log': false, 'binary.md': true })
})

/* ------------------------------------------------------------------ *
 * 8. The two small rules the screen also depends on.
 * ------------------------------------------------------------------ */

test('what counts as a report, and what counts as a name', () => {
  assert.equal(fileKind('REPORT-anything.md'), 'report')
  assert.equal(fileKind('P5-REPORT.md'), 'report')
  assert.equal(fileKind('report.md'), 'report')
  assert.equal(fileKind('notes.md'), 'text')
  assert.equal(fileKind('report.pdf'), 'other')
  assert.equal(fileKind('cleanup.bat'), 'script')
  /* THE LAST EXTENSION IS THE ONE WINDOWS USES. A name dressed as a report and
     ending in a shortcut is a shortcut. */
  assert.equal(fileKind('Report.md.lnk'), 'other')
  assert.equal(boundedName('a.txt'), 'a.txt')
  assert.equal(boundedName('a/b.txt'), null)
  assert.equal(boundedName('..'), null)
})

/* ------------------------------------------------------------------ *
 * 9. WHAT MAY BE HANDED TO THE OPERATING SYSTEM.
 *
 * The fence above answers where a file is. These answer what starting it would
 * mean, which is a second question the first cut of this surface never asked:
 * driven on the real surface, `open` admitted .lnk, .scr, .url, .hta, .ps1,
 * .exe and .bat, every one of them with the person's full rights, on a list
 * that cannot tell their own files from an agent's.
 * ------------------------------------------------------------------ */

const RUNS = Object.freeze([
  'cleanup.bat', 'task.ps1', 'installer.exe', 'page.hta', 'thing.scr',
  'Report.md.lnk', 'Report.url', 'macro.js', 'settings.reg', 'sheet.docx', 'page.html',
])
const INERT = Object.freeze(['invoice.pdf', 'notes.txt', 'REPORT-the-run.md', 'shot.png', 'rows.csv'])

function folderOfBoth() {
  const files = {}
  for (const name of [...RUNS, ...INERT]) files[name] = { text: 'x' }
  return fillFolder(temp('kinds'), files)
}

test('a kind this computer would RUN is never handed over, however plainly it is inside the folder', async () => {
  const root = folderOfBoth()
  const { files, opened } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  for (const name of RUNS) {
    const reply = await files.open({ folderId: 'chosen-0', name })
    assert.equal(reply.ok, false, `${name} was handed to the operating system`)
    assert.equal(reply.code, 'FILES_NOT_OPENABLE', `${name} was refused for the wrong reason`)
  }
  assert.deepEqual(opened, [], 'nothing that can run may reach openPath')

  /* AND THE ORDINARY FILES STILL OPEN, so the refusals above are a rule about
     kinds rather than a surface that stopped working. */
  for (const name of INERT) {
    assert.equal((await files.open({ folderId: 'chosen-0', name })).ok, true, `${name} was refused`)
  }
  assert.deepEqual(opened, INERT.map(name => path.join(root, name)))
})

test('a shortcut is refused BY KIND, because the fence cannot see through one', async () => {
  const root = folderOfBoth()
  const { files, opened, revealed } = surface({ readWorkspaceState: () => ({ roots: [root] }) })

  /* THE FENCE ADMITS IT, and that is the whole point of this test. A .lnk is
     opaque to fs.realpathSync.native, so a shortcut sitting in the folder is
     contained by every measurement the boundary can take while ShellExecute
     follows it to whatever it points at -- proven on this surface with a real
     WScript.Shell shortcut whose target was notepad.exe and whose argument was
     the hosts file. `reveal` going through is the fence saying yes. */
  assert.equal(files.reveal({ folderId: 'chosen-0', name: 'Report.md.lnk' }).ok, true)
  assert.deepEqual(revealed, [path.join(root, 'Report.md.lnk')])

  const reply = await files.open({ folderId: 'chosen-0', name: 'Report.md.lnk' })
  assert.equal(reply.code, 'FILES_NOT_OPENABLE',
    'a shortcut must be refused by the kind rule, because no containment check can be made to see through it')
  assert.deepEqual(opened, [])
})

test('nothing is hidden: every kind is listed, readable here, and shown in the folder', async () => {
  const root = folderOfBoth()
  const { files, revealed } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const listed = await files.list({ folderId: 'chosen-0' })
  assert.deepEqual(listed.files.map(file => file.name).sort(), [...RUNS, ...INERT].sort(),
    'a refused kind must still be on the list; a file nobody can see is worse than one nobody can open')

  /* The row carries the same answer open() gives, from the same rule, so the
     screen switches that one control off instead of offering a press that
     cannot succeed. */
  for (const file of listed.files) {
    assert.equal(file.openable, canOpen(file.name), `${file.name} was listed with the wrong answer`)
    assert.equal(file.openable, RUNS.includes(file.name) === false)
  }

  /* THE ONE CONTROL THAT IS REFUSED IS OPEN. Show in folder selects a file and
     starts no program, so it stays live for every one of them. */
  for (const name of RUNS) {
    assert.equal(files.reveal({ folderId: 'chosen-0', name }).ok, true, `${name} could not be shown in the folder`)
  }
  assert.equal(revealed.length, RUNS.length)

  /* AND THE TEXT ONES ARE READABLE IN THIS WINDOW, which is the only way to see
     what an agent wrote before deciding whether to run it. */
  const read = files.read({ folderId: 'chosen-0', name: 'cleanup.bat' })
  assert.equal(read.ok, true, 'a script must be readable in the window that will not run it')
  assert.equal(read.kind, 'script')
  assert.equal(read.text, 'x')
  /* A shortcut is not text, so the pane says so rather than showing bytes. */
  assert.equal(files.read({ folderId: 'chosen-0', name: 'Report.md.lnk' }).code, 'FILES_NOT_TEXT')
})

test('the list of kinds that may be handed over holds nothing that runs', () => {
  for (const extension of OPENABLE_EXTENSIONS) {
    assert.match(extension, /^\.[a-z0-9]+$/, 'an extension is a dot and lower case, or the lookup misses it')
    assert.equal(canOpen(`whatever${extension}`), true)
  }
  /* The families this repository has had to think about, named so that adding
     one to the list is a decision somebody took rather than an edit nobody
     noticed. */
  for (const extension of ['.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.js', '.jse', '.wsf',
    '.hta', '.scr', '.pif', '.msi', '.msc', '.cpl', '.lnk', '.url', '.reg', '.jar', '.py',
    '.html', '.htm', '.svg', '.docx', '.xlsx', '.pptx', '.docm', '.doc', '.xls']) {
    assert.equal(canOpen(`file${extension}`), false, `${extension} is on the list of kinds handed to this computer`)
  }
  /* A name with no extension at all, and the trailing-dot and trailing-space
     shapes Windows strips when it opens a file. All three fail closed. */
  assert.equal(canOpen('Makefile'), false)
  assert.equal(canOpen('report.pdf.'), false)
  assert.equal(canOpen('report.pdf '), false)
  assert.equal(canOpen(''), false)
  assert.equal(canOpen(null), false)
})

/* ------------------------------------------------------------------ *
 * 10. The cap, the recorded root, and the two names that never cross.
 * ------------------------------------------------------------------ */

test('a folder with more files than the screen takes keeps the newest and says it was cut', async () => {
  const root = temp('many')
  mkdirSync(root, { recursive: true })
  const extra = 5
  for (let index = 0; index < MAX_FILES + extra; index += 1) {
    /* Padded so the tie-break on name cannot reorder them, and stamped a minute
       apart so "newest first" is a fact about the folder rather than about the
       order the file system happened to return. */
    const name = `note-${String(index).padStart(4, '0')}.txt`
    writeFileSync(path.join(root, name), 'x')
    const at = new Date(Date.UTC(2026, 0, 1, 0, index))
    utimesSync(path.join(root, name), at, at)
  }
  const { files } = surface({ readWorkspaceState: () => ({ roots: [root] }) })
  const reply = await files.list({ folderId: 'chosen-0' })
  assert.equal(reply.total, MAX_FILES + extra, 'the count must be of the folder, not of the slice')
  assert.equal(reply.truncated, true)
  assert.equal(reply.files.length, MAX_FILES, 'the screen is given a slice and told that it is one')
  assert.equal(reply.files[0].name, `note-${String(MAX_FILES + extra - 1).padStart(4, '0')}.txt`)
  assert.equal(reply.files.at(-1).name, `note-${String(extra).padStart(4, '0')}.txt`,
    'the oldest files are the ones dropped')
})

test('a recorded root that is not an absolute path is refused BY THE FENCE, not by readdir', async () => {
  const home = temp('relative-home')
  const work = path.join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(path.join(work, 'note.txt'), 'yours')

  const wasIn = process.cwd()
  process.chdir(home)
  try {
    /* THE CONTROL THAT MAKES THIS A MEASUREMENT. `readdirSync('work')` succeeds
       from here -- against whatever directory this process happens to be
       sitting in, which is exactly the danger -- so a refusal below cannot be
       the folder simply being unreadable. Only resolveRoots refuses a root that
       is not an absolute path. */
    assert.deepEqual(readdirSync('work'), ['note.txt'])

    const { files, opened } = surface({ readWorkspaceState: () => ({ roots: ['work'] }) })
    const listed = await files.list({ folderId: 'chosen-0' })
    assert.equal(listed.ok, false, 'a relative recorded root was listed against this process’s own directory')
    assert.equal(listed.code, 'FILES_FOLDER_UNREADABLE')
    const reply = await files.open({ folderId: 'chosen-0', name: 'note.txt' })
    assert.equal(reply.ok, false)
    assert.equal(reply.code, 'FILES_OUTSIDE_FOLDER')
    assert.deepEqual(opened, [])
  } finally {
    process.chdir(wasIn)
  }
})

test('a workspace folder with no name of its own does not put its path on the screen instead', () => {
  /* A drive root has no last segment. The fallback that used to stand in for
     one was the root itself, which is an absolute path -- the single thing this
     module's own header says no reply carries. */
  const filesystemRoot = path.parse(process.cwd()).root
  for (const [expectedId, options] of [
    ['chosen-0', { readWorkspaceState: () => ({ roots: [filesystemRoot] }) }],
    ['profile-abc', { listSessionProfiles: () => [{ id: 'profile-abc', name: '   ', cwd: filesystemRoot }] }],
  ]) {
  const { files } = surface(options)
  const reply = files.folders()
  assert.deepEqual(reply.folders.map(entry => entry.id), [expectedId])
  assert.deepEqual(reply.folders.map(entry => entry.name), [null],
    'a folder with no name is nameless; the screen prints its own words for it')
  for (const entry of reply.folders) {
    for (const value of Object.values(entry)) {
      if (typeof value !== 'string') continue
      assert.doesNotMatch(value, /[\\/:]/, 'no folder reply field may carry a path')
    }
  }
  }
})

test('case-distinct workspace folders follow the native filesystem identity', async () => {
  const root = temp('case-identity')
  const upper = fillFolder(path.join(root, 'Work'), { 'upper.txt': { text: 'upper' } })
  const lower = fillFolder(path.join(root, 'work'), { 'lower.txt': { text: 'lower' } })
  const { files } = surface({ readWorkspaceState: () => ({ roots: [upper, lower] }) })
  const expected = process.platform === 'win32' ? ['chosen-0'] : ['chosen-0', 'chosen-1']
  assert.deepEqual(files.folders().folders.map(row => row.id), expected)
  for (const id of expected) {
    const result = await files.list({ folderId: id })
    assert.equal(result.ok, true)
    assert.deepEqual(result.files.map(row => row.name).sort(), process.platform === 'win32'
      ? ['lower.txt', 'upper.txt'] : [id === 'chosen-0' ? 'upper.txt' : 'lower.txt'])
  }
})

test('a name the file system hands back that is not a name is dropped from the listing', async () => {
  /* readdir normally returns names. It is filtered anyway -- a long-path name on
     NTFS is not one any verb here will accept later, and a row a person can
     press that every verb then refuses is worse than a row nobody drew. The
     only way to produce one is to hand this surface its file system, which is
     what `deps.fs` is for. */
  const root = fillFolder(temp('odd-names'), { 'notes.txt': { text: 'yours' } })
  const bogus = ['x'.repeat(300), 'sub/notes.txt', '..']
  const fakeFs = {
    ...nodeFs,
    promises: {
      ...nodeFs.promises,
      readdir: async () => [...bogus, 'notes.txt'].map(name => ({ name, isFile: () => true })),
      stat: async () => ({ size: 3, mtimeMs: Date.UTC(2026, 0, 1), isFile: () => true }),
    },
  }
  const { files } = surface({ fs: fakeFs, readWorkspaceState: () => ({ roots: [root] }) })
  const listed = await files.list({ folderId: 'chosen-0' })
  assert.deepEqual(listed.files.map(file => file.name), ['notes.txt'])
  assert.equal(listed.total, 1, 'a name nobody can act on must not even be counted')
})

test('a file whose time this computer will not state keeps its row and loses its date', async () => {
  /* `new Date(NaN).toISOString()` throws, and a throw in the listing is not a
     refusal anybody can read: it crosses the channel as an error. Some network
     shares really do hand back a timestamp out of range. */
  const root = fillFolder(temp('bad-times'), { 'notes.txt': { text: 'yours' } })
  const times = { 'notes.txt': Number.NaN, 'later.txt': Date.UTC(2026, 0, 2) }
  const fakeFs = {
    ...nodeFs,
    promises: {
      ...nodeFs.promises,
      readdir: async () => Object.keys(times).map(name => ({ name, isFile: () => true })),
      stat: async (target) => ({ size: 3, mtimeMs: times[path.basename(target)], isFile: () => true }),
    },
  }
  const { files } = surface({ fs: fakeFs, readWorkspaceState: () => ({ roots: [root] }) })
  const listed = await files.list({ folderId: 'chosen-0' })
  assert.equal(listed.ok, true, 'an unstateable time must not take the whole listing down')
  assert.deepEqual(listed.files.map(file => file.name), ['later.txt', 'notes.txt'],
    'a file with no date sorts under the ones that have one')
  assert.equal(listed.files[1].changedAt, '', 'absent is an empty string, never an invented date')
})
