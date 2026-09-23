// The provenance registry and the attributions it writes into generated output.
//
// The failure these guard against is an invented citation: an attribution that
// looks authoritative but traces to nothing. It can fail in two directions --
// claiming reuse that did not happen, and hiding reuse that did -- so the
// schema is tested in both.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { PROVENANCE, validateProvenance, provenanceEntry, attributionHeader, attributionsMarkdown, provenanceDocument } from '../../src/benchmark/lean-codegen.mjs'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'
import { leanCatalog, leanStarter } from '../../src/benchmark/lean.mjs'
import { generateLeanProgram } from '../../src/benchmark/lean-codegen.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const entry = id => structuredClone(provenanceEntry(id))

test('the shipped registry validates and lives in a runtime file every project already pins', () => {
  validateProvenance()
  assert.ok(PROVENANCE.length > 0, 'the registry must not be empty')
  // An export must regenerate its own attributions, so the registry lives in
  // pinned runtime bytes -- inside lean-codegen.mjs, not in a new module. A new
  // runtime module changes the schema-2 inventory, and study.mjs then refuses
  // every version-2 project frozen before it (measured 2026-09-10 on the run of
  // record efaa64a2).
  assert.ok(RUNTIME_FILES.includes('lean-codegen.mjs'))
  assert.ok(!RUNTIME_FILES.includes('provenance.mjs'), 'a separate provenance runtime module would break earlier frozen projects')
})

test('a reuse claim without an upstream hash is refused', () => {
  const bad = entry('quantconnect-lean-python-api')
  bad.id = 'reuse-without-hash'
  bad.codeProvenance = { kind: 'reused', statement: 'copied upstream', upstreamSha256: null, fetchedAt: '2026-09-10' }
  bad.upstream.filePath = 'Algorithm.Python/BasicTemplateAlgorithm.py'
  assert.throws(() => validateProvenance([bad]), /No citation without a hash/)
})

test('a reuse claim without a fetch date or upstream file is refused', () => {
  const missingDate = entry('quantconnect-lean-python-api')
  missingDate.id = 'reuse-without-date'
  missingDate.codeProvenance = { kind: 'reused', statement: 'copied', upstreamSha256: 'b'.repeat(64) }
  missingDate.upstream.filePath = 'Algorithm.Python/BasicTemplateAlgorithm.py'
  assert.throws(() => validateProvenance([missingDate]), /date the upstream bytes were fetched/)

  const missingFile = entry('quantconnect-lean-python-api')
  missingFile.id = 'reuse-without-file'
  missingFile.codeProvenance = { kind: 'reused', statement: 'copied', upstreamSha256: 'b'.repeat(64), fetchedAt: '2026-09-10' }
  assert.throws(() => validateProvenance([missingFile]), /name the exact upstream file/)
})

test('an upstream hash attached to code written here is refused', () => {
  // The opposite failure: dressing our own code as someone else's work.
  const bad = entry('canonical-json')
  bad.codeProvenance.upstreamSha256 = 'a'.repeat(64)
  assert.throws(() => validateProvenance([bad]), /would assert reuse that did not happen/)
})

test('adapted code must list its adaptations', () => {
  const bad = entry('quantconnect-lean-python-api')
  bad.id = 'adapted-without-notes'
  bad.codeProvenance = { kind: 'adapted', statement: 'changed', upstreamSha256: 'c'.repeat(64), fetchedAt: '2026-09-10', adaptations: [] }
  bad.upstream.filePath = 'Algorithm.Python/BasicTemplateAlgorithm.py'
  assert.throws(() => validateProvenance([bad]), /lists every adaptation/)
})

test('a reference must say what it contributes so it cannot be read as reuse', () => {
  const bad = entry('zip-writer')
  bad.references = [{ kind: 'specification', citation: 'Some spec', url: null, note: '' }]
  assert.throws(() => validateProvenance([bad]), /cannot be mistaken for reuse/)
})

test('an attribution can only be printed from a registry entry', () => {
  assert.throws(() => attributionHeader(['no-such-entry']), /Every attribution printed into a generated artifact must come from the registry/)
})

test('every attribution the generated program prints traces to a registry entry', async () => {
  const task = leanStarter().tasks[0]
  const compiled = await compilePrompt(leanCatalog(), task.root)
  const source = generateLeanProgram({ ...task, compiled })
  const header = source.split('\n').filter(line => line.startsWith('#')).join('\n')

  // Every classified line in the header must name a real entry's title, and
  // every upstream/licence/revision fact must match that entry exactly. A
  // string that cannot be traced back is the invented-provenance failure.
  const classified = header.match(/^# \[(reused|adapted|generated)\] (.+)$/gm) || []
  assert.ok(classified.length > 0, 'the generated program must carry its provenance header')
  for (const line of classified) {
    const [, kind, title] = /^# \[(reused|adapted|generated)\] (.+)$/.exec(line)
    const match = PROVENANCE.find(row => row.title === title)
    assert.ok(match, `header cites an unknown artifact: ${title}`)
    assert.equal(match.codeProvenance.kind, kind, `header misclassifies ${title}`)
  }
  for (const row of PROVENANCE) {
    if (!header.includes(row.title)) continue
    assert.ok(header.includes(row.codeProvenance.statement), `header drops the statement for ${row.id}`)
    if (row.upstream) {
      assert.ok(header.includes(row.upstream.repositoryUrl), `header drops the source link for ${row.id}`)
      assert.ok(header.includes(row.upstream.revision.value), `header drops the revision for ${row.id}`)
    }
    // No hash may appear for material we generated ourselves.
    if (row.codeProvenance.kind === 'generated') assert.equal(row.codeProvenance.upstreamSha256, null)
  }
  assert.match(header, /No third-party source is copied into this file/)
})

test('the provenance header cannot change what the generated program does', async () => {
  const task = leanStarter().tasks[0]
  const compiled = await compilePrompt(leanCatalog(), task.root)
  const source = generateLeanProgram({ ...task, compiled })

  // Behaviour check, not a spelling check: the file still parses, still keeps
  // the native order-event hook the grader reads, and everything added is a
  // comment. Strip the comments and the program is byte-identical to one built
  // from the same task without a header.
  const parsed = spawnSync(PYTHON, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
  assert.match(source, /on_order_event/)
  assert.match(source, /class FrozenBenchmark\(QCAlgorithm\)/)
  const headerLines = source.split('\n').findIndex(line => !line.startsWith('#'))
  assert.ok(headerLines > 0, 'the header must precede the program')
  assert.ok(source.split('\n').slice(0, headerLines).every(line => line.startsWith('#')),
    'everything the registry adds must be a comment')
})

test('ATTRIBUTIONS.md and provenance.json state the reuse position without inventing one', () => {
  const markdown = attributionsMarkdown()
  const document = provenanceDocument()
  assert.equal(document.format, 'research-benchmark-provenance')
  assert.deepEqual(document.entries.map(row => row.id), PROVENANCE.map(row => row.id))
  const reused = PROVENANCE.filter(row => row.codeProvenance.kind !== 'generated')
  if (reused.length === 0) {
    assert.match(markdown, /No third-party source code is copied/)
    // A "no reuse" claim must not be accompanied by any upstream byte hash.
    assert.ok(!/SHA-256 of upstream bytes/.test(markdown), 'a no-reuse registry cannot show upstream byte hashes')
  } else {
    for (const row of reused) assert.ok(markdown.includes(row.codeProvenance.upstreamSha256),
      `${row.id} claims reuse, so ATTRIBUTIONS.md must show its upstream hash`)
  }
  for (const row of PROVENANCE) {
    assert.ok(markdown.includes(row.title), `ATTRIBUTIONS.md omits ${row.id}`)
    for (const reference of row.references) assert.ok(markdown.includes(reference.citation) && markdown.includes('contributes no code'),
      `${row.id} references must be marked as contributing no code`)
  }
})

test('the canonical JSON entry does not claim RFC 8785 conformance it has not proven', () => {
  // The owner's rule, made mechanical: an unproven citation is a defect. If
  // someone later proves conformance they must also add the test, not just
  // the sentence.
  const canonicalEntry = provenanceEntry('canonical-json')
  assert.match(canonicalEntry.codeProvenance.statement, /NOT claimed to conform to RFC 8785/)
  assert.deepEqual(canonicalEntry.references, [])
})

test('the reviewed LEAN template is a reference that contributes no code, not a copied-source citation', async () => {
  const lean = provenanceEntry('quantconnect-lean-python-api')
  assert.equal(lean.codeProvenance.kind, 'generated')
  assert.equal(lean.codeProvenance.upstreamSha256, null)
  assert.ok(!lean.upstream.filePath, 'naming an upstream file here would claim it was copied')
  const reviewed = lean.references.filter(reference => reference.kind === 'reviewed-source')
  assert.equal(reviewed.length, 1)
  assert.match(reviewed[0].citation, /BasicTemplateAlgorithm\.py/)
  assert.match(reviewed[0].note, /no code is copied/)

  // The generated program says which skeleton it follows, in the header itself.
  const task = leanStarter().tasks[0]
  const source = generateLeanProgram({ ...task, compiled: await compilePrompt(leanCatalog(), task.root) })
  assert.match(source, /^#\s+reference \(reviewed source, contributes no code\): QuantConnect LEAN, Algorithm\.Python\/BasicTemplateAlgorithm\.py/m)
  assert.match(source, /this program follows its ordinary QCAlgorithm skeleton/)
  assert.match(source, /def initialize\(self\)/)
  assert.match(source, /def on_data\(self, data\)/)
})

test('a reused or adapted entry flips the no-copy sentence in both the header and ATTRIBUTIONS.md', () => {
  // Test-only fixture: no such reuse exists in the shipped registry.
  const adapted = {
    id: 'synthetic-adapted-fixture', title: 'Synthetic adapted fixture (test only)', appliesTo: ['lean/<task>/main.py'],
    codeProvenance: { kind: 'adapted', statement: 'Test-only fixture standing for a genuine adaptation.', upstreamSha256: 'd'.repeat(64),
      fetchedAt: '2026-09-10', adaptations: ['Renamed the algorithm class.', 'Removed the example purchase.'] },
    upstream: { project: 'Example Upstream', authors: 'Example Authors', repositoryUrl: 'https://example.invalid/repository',
      filePath: 'src/example.py', license: 'Apache-2.0', licenseNote: 'Copyright Example Authors. Licensed under the Apache License 2.0.',
      revision: { kind: 'commit', value: 'e'.repeat(40) } },
    references: [],
  }
  const registry = [...PROVENANCE, adapted]
  validateProvenance(registry)

  const control = attributionHeader(['quantconnect-lean-python-api'], { entries: registry })
  assert.match(control, /No third-party source is copied into this file/, 'a file with only generated entries keeps the sentence')

  const header = attributionHeader(['quantconnect-lean-python-api', 'synthetic-adapted-fixture'], { entries: registry })
  assert.doesNotMatch(header, /No third-party source is copied/, 'a file listing adapted material cannot claim nothing is copied')
  for (const fact of [adapted.upstream.authors, adapted.upstream.repositoryUrl, adapted.upstream.filePath, adapted.upstream.revision.value,
    adapted.upstream.licenseNote, adapted.codeProvenance.upstreamSha256, ...adapted.codeProvenance.adaptations])
    assert.ok(header.includes(fact), `the header drops ${fact}`)

  const markdown = attributionsMarkdown(registry)
  assert.doesNotMatch(markdown, /No third-party source code is copied/)
  for (const fact of [adapted.upstream.licenseNote, adapted.codeProvenance.upstreamSha256, ...adapted.codeProvenance.adaptations])
    assert.ok(markdown.includes(fact), `ATTRIBUTIONS.md drops ${fact}`)
})

test('the schema accepts a reviewed reference without reused-only fields and still refuses a reused entry that lacks them', () => {
  // A reference consulted carries no upstream hash, fetch date, copied file or
  // adaptation list, and the schema accepts it that way.
  const lean = entry('quantconnect-lean-python-api')
  const reviewed = lean.references.find(reference => reference.kind === 'reviewed-source')
  assert.ok(reviewed, 'the reviewed LEAN template must be recorded as a reference')
  for (const field of ['upstreamSha256', 'fetchedAt', 'filePath', 'adaptations']) assert.equal(reviewed[field], undefined, field)
  assert.doesNotThrow(() => validateProvenance([lean]))

  // The same upstream claimed as reused, without those fields, is refused.
  const reused = entry('quantconnect-lean-python-api')
  reused.id = 'reused-without-fields'
  reused.codeProvenance = { kind: 'reused', statement: 'copied from the template' }
  assert.throws(() => validateProvenance([reused]), /name the exact upstream file/)
})
