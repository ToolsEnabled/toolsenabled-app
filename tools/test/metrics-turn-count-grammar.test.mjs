/* 1.0.48 candidate-2 hand test: Metrics' "Usage by sign-in" rows read "33.4% · 1 turns". Every turn count on the
   Metrics page says "1 turn" and "N turns". This scans the view for a count glued to a plural "turns" with no
   singular branch, the shape that wrote "1 turns". */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../src/views/metrics.js', import.meta.url), 'utf8')

test('no Metrics turn count is written as a bare plural', () => {
  const bare = [...source.matchAll(/`\$\{([A-Za-z_.]+)\} turns[^`]*`/g)]
    .filter(match => !new RegExp(`${match[1].replace(/\./g, '\\.')} === 1`).test(source.slice(Math.max(0, match.index - 200), match.index + match[0].length + 60)))
    .map(match => match[0].slice(0, 80))
  assert.deepEqual(bare, [], 'a turn count that would read "1 turns"')
})
