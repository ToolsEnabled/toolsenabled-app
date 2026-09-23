/*
 * The ledger's user-visible ages are calculated in two stages: profile hours
 * become milliseconds when the module loads, then the time spent looking at
 * the running application is added before the value is formatted.  These tests
 * exercise that public pipeline with the same profile records the application
 * supplies; they do not duplicate the profile or pin its wording.
 *
 * Run: node --test tools/test/ledger-data.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { FLEET } from '../../src/fleet-profile.js'
import {
  LEDGER_STARTED_AT,
  Q_ITEMS,
  R_ITEMS,
  formatLedgerAge,
  liveAgeMs,
} from '../../src/ledger-data.js'

const HOUR = 60 * 60 * 1000

test('profile ledger records keep their meaning and receive hour-based ages', () => {
  for (const [source, prepared, kind] of [
    [FLEET.ledger.requests, R_ITEMS, 'request'],
    [FLEET.ledger.questions, Q_ITEMS, 'question'],
  ]) {
    assert.equal(prepared.length, source.length,
      `every ${kind} in the selected fleet profile reaches the ledger`)

    source.forEach((record, index) => {
      assert.deepEqual(prepared[index], { ...record, ageMs: record.ageHours * HOUR },
        `${kind} ${index} keeps its profile fields and converts ageHours to milliseconds`)
      assert.notEqual(prepared[index], record,
        `${kind} ${index} is copied instead of modifying the selected fleet profile`)
    })
  }
})

test('a live age advances with elapsed time but never runs backward', () => {
  const item = { ageMs: 17 * HOUR }

  assert.equal(liveAgeMs(item, LEDGER_STARTED_AT + 75_000), item.ageMs + 75_000,
    'live ledger age includes time elapsed since this ledger loaded')
  assert.equal(liveAgeMs(item, LEDGER_STARTED_AT - 75_000), item.ageMs,
    'a clock adjustment before ledger startup does not make an item younger')
})

test('display ages use useful units at minute, hour, and day boundaries', () => {
  assert.equal(formatLedgerAge(0), '1m',
    'an age too new to fill a minute is still presented as one minute')
  assert.equal(formatLedgerAge(61 * 60_000), '1h 1m',
    'an age over an hour retains its remaining minutes')
  assert.equal(formatLedgerAge(49 * HOUR), '2d 1h',
    'an age beyond the two-day boundary is presented in days and remaining hours')
})
