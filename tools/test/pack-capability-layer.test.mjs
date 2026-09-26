import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  assertNeutralAgentOrgSemanticParity,
  assertStagedDefaultByteEquality,
  assertPythonHelpersDeclared,
} from '../pack-capability-layer.mjs'

const run = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKER = path.join(REPO, 'tools', 'pack-capability-layer.mjs')

test('a source-only Python helper cannot disappear from the installed payload', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pack-python-closure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'src', 'lib', 'desktop.js')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, [
    "const snapshot = path.join(__dirname, 'linux-desktop.py');",
    "const capture = path.resolve(__dirname, 'linux-capture.py');",
    "const vault = path.resolve(__dirname, '..', 'linux-vault.py');",
    "const credential = path.join(__dirname, 'linux-credential-prompt.py');",
    "const extract = rootPath('research', 'extract.py');",
    "const external = path.join(sdkRoot, 'lib', 'gcloud.py');",
    "// path.join(__dirname, 'not-executable.py')",
  ].join('\n'))
  const helpers = ['src/lib/linux-desktop.py', 'src/lib/linux-capture.py', 'src/linux-vault.py', 'src/lib/linux-credential-prompt.py', 'research/extract.py']
  const closure = [path.relative(root, file)]
  assert.doesNotThrow(() => assertPythonHelpersDeclared(root, closure, helpers))
  for (const helper of helpers) assert.throws(() => assertPythonHelpersDeclared(root, closure, helpers.filter(value => value !== helper)),
    error => error.message.includes(helper), 'removing ' + helper + ' must stop packaging')
})

test('the shipped manifest carries shell diagnostics and Linux snapshot, capture and confirmation programs', async () => {
  const manifest = JSON.parse(await readFile(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  assert.ok(manifest.hostModules.includes('src/lib/diagnostic-retention.js'), 'the shell-loaded diagnostic retention store must reach the installer')
  assert.equal(manifest.dataFiles.filter(file => file === 'tests/helpers/diagnostic-memory-fs.js').length, 1, 'packaged diagnostic qualification must carry its in-memory fixture once')
  assert.ok(manifest.hostModules.includes('src/lib/runtime-policy.js'), 'the shell-loaded runtime policy must reach the installer')
  assert.ok(manifest.hostModules.includes('src/lib/operation-audit.js'), 'the shell optional-audit policy implementation must reach the installer')
  assert.ok(manifest.spawnedPrograms.includes('src/lib/owner-prompt-runner.js'), 'the shared spawned runner must reach the installer')
  assert.ok(manifest.helperPrograms.includes('src/linux-vault.py'), 'native credential Save must ship its maintained custody implementation')
  assert.ok(manifest.helperPrograms.includes('src/lib/providers/web-inspector.py'), 'generic mobile browser inspection must ship its maintained helper')
  for (const name of ['linux-desktop', 'linux-capture', 'linux-desktop-ask', 'linux-credential-prompt']) {
    assert.ok(manifest.helperPrograms.includes(`src/lib/${name}.py`), `${name} must reach the installer`)
  }
})

test('pack-capability-layer refuses a blind pass through a differently spelled copy path', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pack-capability-layer-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const alias = path.join(temporary, 'pack-capability-layer-copy.mjs')
  const helper = path.join(temporary, 'lib', 'capability-source-git.mjs')
  await mkdir(path.dirname(helper), { recursive: true })
  await copyFile(PACKER, alias)
  await copyFile(path.join(REPO, 'tools', 'lib', 'capability-source-git.mjs'), helper)
  await copyFile(path.join(REPO, 'tools', 'lib', 'capability-index-check.mjs'), path.join(temporary, 'lib', 'capability-index-check.mjs'))
  await copyFile(path.join(REPO, 'tools', 'lib', 'provider-runtime-payload.mjs'), path.join(temporary, 'lib', 'provider-runtime-payload.mjs'))
  const invokedAlias = process.platform === 'win32'
    ? path.join(temporary, `${path.basename(alias, '.mjs').toUpperCase()}.mjs`)
    : alias
  const nodeArgs = process.platform === 'win32'
    ? ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(invokedAlias)}`)}`, alias]
    : [alias]

  await assert.rejects(
    run(process.execPath, [...nodeArgs, '--definitely-unknown'], { cwd: REPO }),
    (error) => {
      assert.equal(error.code, 1, 'a real invocation must fail when its arguments are invalid')
      assert.match(error.stderr, /pack-capability-layer: unknown flag --definitely-unknown/)
      return true
    },
    'the copied gate\'s alternate path spelling must not bypass main() and silently exit 0',
  )
})

test('pack-capability-layer remains side-effect free when imported', async () => {
  const expression = `import(${JSON.stringify(pathToFileURL(PACKER).href)})`
  const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '--eval', expression], { cwd: REPO })
  assert.equal(stdout, '')
  assert.equal(stderr, '')
})

test('packing requires cross-repo org semantics and byte-identical staging', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pack-capability-org-parity-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const defaultsDir = path.join(temporary, 'app-defaults')
  const engine = path.join(temporary, 'engine')
  const defaultFile = path.join(defaultsDir, 'config', 'agent-org.json')
  const exampleFile = path.join(engine, 'config', 'agent-org.example.json')
  const stagedFile = path.join(temporary, 'staged', 'config', 'agent-org.json')
  await Promise.all([
    mkdir(path.dirname(defaultFile), { recursive: true }),
    mkdir(path.dirname(exampleFile), { recursive: true }),
    mkdir(path.dirname(stagedFile), { recursive: true }),
  ])

  const contract = {
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'claude-1', displayName: 'Claude seat 1', role: 'builder', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [] },
    ],
    relationships: [{ from: 'controller', to: 'claude-1', type: 'manages' }],
  }
  const appDocument = { $comment: ['app-owned shipping explanation'], ...contract }
  const engineDocument = {
    $comment: ['engine-owned example explanation'],
    relationships: contract.relationships,
    agents: contract.agents.map((agent) => Object.fromEntries(Object.entries(agent).reverse())),
    revision: contract.revision,
    schemaVersion: contract.schemaVersion,
  }
  await writeFile(defaultFile, `${JSON.stringify(appDocument, null, 2)}\n`)
  await writeFile(exampleFile, JSON.stringify(engineDocument))

  assert.doesNotThrow(() => assertNeutralAgentOrgSemanticParity({ source: engine, defaultsDir }),
    'comments, formatting and object-key order are not org semantics')

  const defaultBytes = await readFile(defaultFile)
  await writeFile(stagedFile, defaultBytes)
  assert.doesNotThrow(() => assertStagedDefaultByteEquality({
    sourceFile: defaultFile,
    stagedFile,
    relative: 'config/agent-org.json',
  }))

  await writeFile(stagedFile, JSON.stringify(appDocument))
  assert.throws(() => assertStagedDefaultByteEquality({
    sourceFile: defaultFile,
    stagedFile,
    relative: 'config/agent-org.json',
  }), /changed bytes while copying/,
  'semantic equivalence must not satisfy the staged-byte contract')

  const drifted = structuredClone(engineDocument)
  drifted.agents[1].id = 'claude'
  drifted.relationships[0].to = 'claude'
  await writeFile(exampleFile, JSON.stringify(drifted))
  assert.throws(
    () => assertNeutralAgentOrgSemanticParity({ source: engine, defaultsDir }),
    /not semantically identical/,
    'a static Claude principal must fail the cross-repo pack gate',
  )
})
