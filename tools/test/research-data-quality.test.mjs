import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSourceQuality, sourceQualityKey, sourceQualityFlag, sourceQualitySeverity, noteSeverity, SOURCE_QUALITY_LIMITS } from '../../src/research-data-quality.mjs'

const fields = ['resource', 'path', 'verdict', 'reason', 'measured_metric'].map(name => ({ name, type: 'string' })).concat({ name: 'measured_value', type: 'number' })
const resources = [
  { name: 'observations', paths: ['data.csv', 'next.csv'], resolvedPaths: ['study/data.csv', 'study/next.csv'] },
  { name: 'notes', paths: ['quality.csv'], resolvedPaths: ['study/quality.csv'], schema: { fields }, delimiter: ',' },
]
const descriptor = { toolsenabled: { sourceQuality: 'notes' } }
const header = fields.map(field => field.name).join(',') + '\n'
const open = text => async path => { assert.equal(path, 'study/quality.csv'); return new Blob([text]).stream() }

test('source-quality loading is explicit and preserves zero metrics and literal source text', async () => {
  assert.equal(await loadSourceQuality({}, resources, () => assert.fail('Unconfigured quality must not read files')), null)
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,excluded,<b>sensor unavailable</b>,completeness,0\n'))
  assert.equal(quality.count, 1)
  const notes = quality.entries.get(sourceQualityKey('observations', 'study/data.csv'))
  assert.equal(notes[0].measured_value, 0)
  assert.equal(notes[0].reason, '<b>sensor unavailable</b>')
  assert.equal(quality.entries.has(sourceQualityKey('observations', 'study/next.csv')), false, 'No record is not a quality pass')
})

test('all assessments for a file are retained rather than letting a later pass overwrite an exclusion', async () => {
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,excluded,gap,coverage,0\nobservations,data.csv,pass,clock valid,clock,1\n'))
  assert.deepEqual(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')).map(item => item.verdict), ['excluded', 'pass'])
})

test('bad references, invalid values and missing required source notes fail explicitly', async () => {
  for (const row of ['unknown,data.csv,excluded,gap,coverage,0', 'observations,../data.csv,excluded,gap,coverage,0', 'observations,missing.csv,excluded,gap,coverage,0', 'observations,data.csv,excluded,,coverage,0', 'observations,data.csv,excluded,gap,coverage,nan']) {
    await assert.rejects(loadSourceQuality(descriptor, resources, open(header + row + '\n')))
  }
  await assert.rejects(loadSourceQuality({ toolsenabled: { sourceQuality: 'absent' } }, resources, open('')), /missing/)
  await assert.rejects(loadSourceQuality(descriptor, resources, async () => { throw new Error('File unavailable') }), /unavailable/)
})

// A dataset is as large as it is. These two sizes were previously refused
// outright; the assessment of a real study must survive both.
test('a quality resource of far more than ten thousand rows is read to its end', async () => {
  const many = 25000
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,warning,note,metric,0\n'.repeat(many)))
  assert.equal(quality.rows, many, 'every row is read')
  assert.equal(quality.count, many, 'every recorded note is kept')
  assert.equal(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')).length, many)
})

test('a quality resource of more than eight mebibytes is read to its end', async () => {
  const reason = 'r'.repeat(1000)
  const rows = Math.ceil((8 * 1024 * 1024) / (`observations,data.csv,warning,${reason},metric,0\n`.length)) + 50
  const text = header + `observations,data.csv,warning,${reason},metric,0\n`.repeat(rows)
  assert.ok(text.length > 8 * 1024 * 1024, 'the fixture is past the size that used to be refused')
  const quality = await loadSourceQuality(descriptor, resources, open(text))
  assert.equal(quality.count, rows)
  assert.ok(quality.bytes > 8 * 1024 * 1024, 'the reported byte count is the whole file')
  assert.equal(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')).at(-1).reason, reason, 'the last note in the file survives')
})

test('the one remaining bound refuses the whole load, names itself, and never truncates', async () => {
  const row = 'observations,data.csv,warning,note,metric,0\n'
  const atBound = await loadSourceQuality(descriptor, resources, open(header + row.repeat(3)), { maxNotes: 3 })
  assert.equal(atBound.count, 3, 'a load that fits is complete, not partial')
  await assert.rejects(loadSourceQuality(descriptor, resources, open(header + row.repeat(4)), { maxNotes: 3 }), error => {
    assert.ok(error.message.includes('3'), 'the refusal states the bound it hit')
    assert.match(error.message, /truncated/, 'the refusal says nothing was silently dropped')
    assert.match(error.message, /notes/, 'the refusal names what is being held')
    return true
  })
  assert.equal(SOURCE_QUALITY_LIMITS.notes >= 1000000, true, 'the shipped bound is far above any real assessment')
})

// A verdict the package itself records as an exclusion must reach the sheet
// heading, where a person choosing a file looks, and not only a panel further
// down the page.
test('a file the quality notes mark excluded carries an exclusion flag; an unassessed or passing file does not', async () => {
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,excluded,no two-sided quotes in this session,two_sided_share,0\nobservations,next.csv,pass,within tolerance,two_sided_share,1\n'))
  const excluded = sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')))
  assert.equal(excluded.excluded, true)
  assert.equal(excluded.verdict, 'excluded')
  assert.match(excluded.label, /excluded/i)
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/next.csv'))).excluded, false)
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/absent.csv'))).excluded, false, 'no record is not a verdict')
  assert.equal(sourceQualityFlag(undefined).label, '', 'an unassessed file is not labelled either way')
})

test('an exclusion is not hidden by a later passing assessment of the same file', async () => {
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,pass,clock valid,clock,1\nobservations,data.csv,EXCLUDED,vendor gap,coverage,0\n'))
  const flag = sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')))
  assert.equal(flag.excluded, true, 'the strongest recorded verdict decides, in any spelling or order')
  assert.equal(sourceQualitySeverity('warning'), 'concern')
  assert.equal(sourceQualitySeverity('pass'), 'none')
  assert.equal(sourceQualitySeverity('excluded'), 'excluded')
})

// The original reading ranked eight English spellings and left every other
// verdict unmarked, so a package recording "provisional" or "superseded" lost
// its flag between the file and the sheet heading. A recorded verdict is a
// recorded verdict.
test('a verdict spelling nobody listed still carries severity rather than passing silently', () => {
  for (const verdict of ['provisional', 'superseded', 'needs re-run', 'vorlaufig', 'unverifiziert', 'quarantined']) {
    assert.equal(sourceQualitySeverity(verdict), 'concern', `${verdict} is a recorded verdict, not an absence of one`)
  }
  assert.equal(sourceQualitySeverity('pass'), 'none', 'a clearance is still a clearance')
  assert.equal(sourceQualitySeverity('  EXCLUDED  '), 'excluded', 'spacing and case do not change a verdict')
  assert.equal(sourceQualitySeverity(''), 'none', 'no verdict is not a verdict')
  assert.equal(sourceQualitySeverity(undefined), 'none')
})

test('an unlisted spelling reaches the sheet heading with its own wording', async () => {
  const quality = await loadSourceQuality(descriptor, resources, open(header + 'observations,data.csv,superseded,replaced by the 2026 revision,coverage,0\n'))
  const flag = sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')), quality.vocabulary)
  assert.equal(flag.severity, 'concern')
  assert.equal(flag.excluded, false, 'a concern is not an exclusion')
  assert.match(flag.label, /superseded/, 'the heading shows the spelling the package used')
})

test('a package states what its own verdict spellings mean, in its own language', async () => {
  const ranked = { toolsenabled: { sourceQuality: 'notes', sourceQualityVerdicts: { vorlaufig: 'concern', uberholt: 'excluded', geprueft: 'none' } } }
  const quality = await loadSourceQuality(ranked, resources, open(header
    + 'observations,data.csv,uberholt,ersetzt durch die Revision 2026,coverage,0\n'
    + 'observations,next.csv,geprueft,in Ordnung,coverage,1\n'))
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/data.csv')), quality.vocabulary).excluded, true)
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/next.csv')), quality.vocabulary).severity, 'none',
    'a package may also clear a spelling the default reading would have flagged')
  await assert.rejects(loadSourceQuality({ toolsenabled: { sourceQuality: 'notes', sourceQualityVerdicts: { vorlaufig: 'maybe' } } }, resources, open(header)),
    /excluded, concern, none/, 'an unusable ranking is refused by name rather than ignored')
})

test('a quality file ranks a single row through its own severity column', async () => {
  const ranking = ['resource', 'path', 'verdict', 'reason', 'severity'].map(name => ({ name, type: 'string' }))
  const ranked = [resources[0], { name: 'notes', paths: ['quality.csv'], resolvedPaths: ['study/quality.csv'], schema: { fields: ranking }, delimiter: ',' }]
  const head = ranking.map(field => field.name).join(',') + '\n'
  const quality = await loadSourceQuality(descriptor, ranked, open(head
    + 'observations,data.csv,provisional,awaiting the second reader,excluded\n'
    + 'observations,next.csv,provisional,awaiting the second reader,none\n'))
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/data.csv'))).excluded, true,
    'the same spelling means different things in the same file when the file says so')
  assert.equal(sourceQualityFlag(quality.entries.get(sourceQualityKey('observations', 'study/next.csv'))).severity, 'none')
  assert.equal(noteSeverity({ verdict: 'provisional', severity: 'excluded' }), 'excluded')
  assert.equal(noteSeverity({ verdict: 'provisional' }), 'concern')
  await assert.rejects(loadSourceQuality(descriptor, ranked, open(head + 'observations,data.csv,provisional,reason,serious\n')),
    /severity serious is not/, 'an unusable severity in the file is refused by name, not read as a clearance')
})
