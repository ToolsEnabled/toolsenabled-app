/* A FILE WHOSE DETAILS CANNOT BE MEASURED STILL HAS A ROW.
 *
 * shell/agent-files.cjs list() stats every name readdir returned. The stat used
 * to be wrapped in `catch { return null }` and the null was dropped, so a file
 * another process held open -- EBUSY, EACCES -- or one that vanished in the
 * microseconds between readdir and stat left the listing entirely: no row, and
 * a `total` that disagreed with the folder the person can see in Explorer. That
 * is a failure to LOOK reported as a file that is NOT THERE, and the module's
 * own date rule ("A TIME THIS COMPUTER CANNOT STATE IS NOT A ROW THAT
 * DISAPPEARS") already says which way that has to go.
 *
 * These checks drive the real surface over a real folder with only stat made to
 * fail, and assert BEHAVIOUR: the row is present, the count includes it, the
 * unmeasurable facts are absent rather than wrong, and `readable` is false
 * because a size nobody measured cannot pass the size cap.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import nodeFs, { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const { createAgentFileSurface, BOUNDARY_MODULE, MAX_READ_BYTES } =
  require_(path.join(REPO, 'shell', 'agent-files.cjs'))
const { resolveCapabilityRoot } = require_(path.join(REPO, 'shell', 'capability-layer.cjs'))
const FENCE_FIXTURE = path.join(REPO, 'tools', 'test', 'fixtures', 'workspace-fence', BOUNDARY_MODULE)

function temp(prefix) {
  return mkdtempSync(path.join(tmpdir(), `mc-files-unstat-${prefix}-`))
}

/* The same staged payload the sibling suite uses: the REAL boundary module,
   resolved through the REAL resolver, so nothing here is measured against a
   stand-in fence. */
function stagePayload() {
  const resources = temp('payload')
  const root = path.join(resources, 'capability')
  mkdirSync(path.join(root, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(root, 'PAYLOAD.json'),
    JSON.stringify({ bridgeEntrypoint: 'tools/mission-bridge.js', fileCount: 1, hostModules: [BOUNDARY_MODULE] }))
  writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'payload', private: true, type: 'commonjs' }))
  copyFileSync(FENCE_FIXTURE, path.join(root, ...BOUNDARY_MODULE.split('/')))
  return () => resolveCapabilityRoot({ resourcesPath: resources, repoRoot: resources })
}

/* Only stat is made to fail, and only for the one named file. readdir is the
   real one, so the name genuinely came off the disk. */
function fsWithStatFailure(failingName, code) {
  return {
    ...nodeFs,
    promises: {
      ...nodeFs.promises,
      async stat(target, ...rest) {
        if (path.basename(String(target)) === failingName) {
          throw Object.assign(new Error(`${code}: simulated`), { code })
        }
        return nodeFs.promises.stat(target, ...rest)
      },
    },
  }
}

function build({ root, fs }) {
  const logged = []
  const files = createAgentFileSurface({
    fs,
    resolveCapabilityRoot: stagePayload(),
    requireModule: require_,
    readWorkspaceState: () => ({ ok: true, available: true, roots: [root] }),
    listSessionProfiles: () => [],
    openPath: async () => '',
    showItemInFolder: () => {},
    log: line => logged.push(line),
  })
  return { files, logged }
}

async function listOnly(root, fs) {
  const { files, logged } = build({ root, fs })
  /* A folder reply never carries a path -- no field of it may hold a separator
     -- so the one recorded workspace folder is addressed by the id the surface
     itself minted for it. */
  const folders = files.folders()
  assert.equal(folders.ok, true, 'the staged workspace folder was not offered')
  assert.equal(folders.folders.length, 1, JSON.stringify(folders))
  return { reply: await files.list({ folderId: folders.folders[0].id }), logged }
}

function folderWith(names) {
  const root = temp('folder')
  for (const name of names) writeFileSync(path.join(root, name), 'contents')
  return root
}

test('a file whose stat is refused keeps its row and is counted', async () => {
  const root = folderWith(['held-open.txt', 'plain.txt'])
  const { reply } = await listOnly(root, fsWithStatFailure('held-open.txt', 'EBUSY'))

  assert.equal(reply.ok, true, reply.code || 'the listing refused')
  const names = reply.files.map(file => file.name).sort()
  assert.deepEqual(names, ['held-open.txt', 'plain.txt'],
    'a file the stat could not measure was dropped from the listing')
  assert.equal(reply.total, 2, 'the count disagreed with the folder')
})

test('the unmeasurable facts are absent rather than wrong', async () => {
  const root = folderWith(['held-open.txt'])
  const { reply } = await listOnly(root, fsWithStatFailure('held-open.txt', 'EACCES'))

  const row = reply.files.find(file => file.name === 'held-open.txt')
  assert.ok(row, 'the row is missing')
  assert.equal(row.bytes, null, 'an unmeasured size must not be stated as a number')
  assert.equal(row.changedAt, '', 'an unmeasured time must not be stated')
  /* Same value the module already uses for a time it will not state, so the
     screen's existing "drop a date I cannot parse" branch covers it. */
  assert.equal(typeof row.changedAt, 'string')
})

test('a row with no measured size is not offered as readable', async () => {
  const root = folderWith(['held-open.txt'])
  const { reply } = await listOnly(root, fsWithStatFailure('held-open.txt', 'EBUSY'))

  const row = reply.files.find(file => file.name === 'held-open.txt')
  assert.equal(row.readable, false,
    `a size nobody measured cannot be known to be under ${MAX_READ_BYTES} bytes`)
})

test('a stat that succeeds is unchanged: size, time and readable are stated', async () => {
  const root = folderWith(['plain.txt'])
  const { reply } = await listOnly(root, nodeFs)

  const row = reply.files.find(file => file.name === 'plain.txt')
  assert.equal(row.bytes, 'contents'.length)
  assert.match(row.changedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(row.readable, true)
})

test('the reason the details are missing is recorded, not swallowed', async () => {
  const root = folderWith(['held-open.txt'])
  const { logged } = await listOnly(root, fsWithStatFailure('held-open.txt', 'EACCES'))

  assert.ok(logged.some(line => line.includes('held-open.txt') && line.includes('EACCES')),
    `nothing named the file or the reason; log was ${JSON.stringify(logged)}`)
})
