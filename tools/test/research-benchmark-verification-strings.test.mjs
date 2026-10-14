// Every METHOD_REFERENCES entry carries a verification string that travels into each
// export's paper/references.json. A string a reader cannot follow is worse than none,
// because it looks like evidence: one of these named a file that did not contain the
// entry, and only a Manager's grep caught it.
//
// This is a CONTENT pin and never a filesystem check. An exported project must verify
// on a machine that has never seen the evidence tree, so the test asserts what the
// string says, not that a path exists.
import assert from 'node:assert/strict'
import test from 'node:test'
import { METHOD_REFERENCES, methodReference } from '../../src/benchmark/study.mjs'

// The record these two entries rest on, named exactly as the string must name it.
const LOG_PATH = 'research-44/sub/stats/logs/citations-verified.md'
const LOG_DATE = '2026-09-10'
const LOG_METHOD = 'Crossref API'

const SHIPPED = {
  'wilson-1927': 'Crossref API record confirmed by the citation verification log of 2026-09-10 (research-44/sub/stats/logs/citations-verified.md, row 1): title, author, year, journal, volume 22, issue 158, pages 209-212 and the DOI.',
  'brown-cai-dasgupta-2001': 'Crossref API record confirmed by the citation verification log of 2026-09-10 (research-44/sub/stats/logs/citations-verified.md, row 2): title, three authors, year, journal, volume 16, issue 2, pages 101-133 and the DOI; that log records the page range separately confirmed against the Project Euclid article page.',
}

test('the two proportion-interval references carry exactly the shipped verification text', () => {
  for (const [id, text] of Object.entries(SHIPPED)) {
    const entry = METHOD_REFERENCES.find(reference => reference.id === id)
    assert.ok(entry, `${id} is missing from METHOD_REFERENCES`)
    assert.equal(entry.verification, text, `${id}'s verification string drifted from the text that was checked against the log`)
  }
})

test('a string that cites the verification log names its path, date, method and row', () => {
  const citing = METHOD_REFERENCES.filter(reference => /citations-verified/.test(reference.verification || ''))
  assert.ok(citing.length >= 2, 'the two proportion-interval references cite that log')
  for (const reference of citing) {
    const text = reference.verification
    assert.ok(text.includes(LOG_PATH), `${reference.id} cites the log without its full path: ${text}`)
    assert.ok(text.includes(LOG_DATE), `${reference.id} cites the log without its generated date: ${text}`)
    assert.ok(text.includes(LOG_METHOD), `${reference.id} cites the log without naming the method: ${text}`)
    assert.match(text, /\brow \d+\b/, `${reference.id} cites the log without a row number: ${text}`)
  }
})

test('no string claims a verification-log row while naming the bibliography as its location', () => {
  // This is the exact shape of the error this pin exists for: a row number from one file
  // attributed to another that does not contain the entry.
  for (const reference of METHOD_REFERENCES) {
    const text = reference.verification || ''
    const claimsRow = /\brow \d+\b/.test(text)
    const namesBibliography = /references\.bib/.test(text)
    assert.ok(!(claimsRow && namesBibliography),
      `${reference.id} claims a row and names references.bib in one string, which is how a row number gets attributed to a file that does not hold it: ${text}`)
  }
})

test('every verification string is present, dated and finished', () => {
  assert.ok(METHOD_REFERENCES.length > 0, 'there are references to check')
  for (const reference of METHOD_REFERENCES) {
    const text = reference.verification
    assert.equal(typeof text, 'string', `${reference.id} has no verification string`)
    assert.ok(text.trim().length > 0, `${reference.id} has an empty verification string`)
    assert.match(text, /\d{4}-\d{2}-\d{2}/, `${reference.id} gives no date for its verification: ${text}`)
    assert.ok(text.trim().endsWith('.'), `${reference.id}'s verification string is unfinished: ${text}`)
  }
})

test('the verification text is carried by the reference record itself, so an export needs no evidence tree', () => {
  for (const id of Object.keys(SHIPPED)) {
    assert.equal(methodReference(id).verification, SHIPPED[id],
      `${id}'s verification text must travel with the exported reference record`)
  }
})
