import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../first-run-recovery-qa.mjs', import.meta.url), 'utf8')

test('the packaged recovery walk follows the current account and settings doors', () => {
  assert.match(source, /import \{ CONNECT_HREF \} from '\.\.\/src\/device-claim-flow\.js'/)
  assert.match(source, /exit\.href === CONNECT_HREF/)
  assert.match(source, /data-category="What the screens show"/)
  assert.match(source, /data-category="Setup"/)
  assert.match(source, /setupSettings\.guideLinks > 0/)
})

test('the recovery walk no longer requires the retired home and settings copy', () => {
  assert.doesNotMatch(source, /only computer connected/i)
  assert.doesNotMatch(source, /no switch on this page changes that/i)
  assert.doesNotMatch(source, /reaches Data and Sim/)
})
