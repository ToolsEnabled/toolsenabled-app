/* The Diagnostic retention row describes the engine's actual maintenance
 * rule (engine diagnostic-retention.js runMaintenance): a closed file is
 * acted on when its age reaches the window OR the folder is above the
 * storage target, oldest first and a few files per pass; nothing is acted on
 * while any managed file is unreadable; files being written, kept files and
 * unreadable files are never removed; Keep acts on nothing and Archive moves
 * instead of removing. An earlier draft said files were removed only once
 * older than the window, which is not what happens under storage pressure. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { productSettingPresentation } from '../../src/product-settings-layout.js'

const row = productSettingPresentation('diagnostics.retention')

test('the row names both triggers: expiry after the window, and earlier removal of the oldest closed files above the storage target', () => {
  assert.equal(row.title, 'Diagnostic retention')
  assert.match(row.summary, /7 days \/ 64 MiB is the default/)
  assert.match(row.summary, /a closed file expires once it is older than the window/)
  assert.match(row.summary, /while the folder is above the storage target the oldest closed files are removed sooner, a few at a time, until it is back under/)
  assert.doesNotMatch(row.summary, /older than the window are removed until/, 'the age-only wording is gone')
})

test('the target is qualified as eventual, with the protected and unreadable stops kept', () => {
  assert.match(row.summary, /That target is eventual, not a hard limit/)
  assert.match(row.summary, /files still being written, files you keep and files that cannot be read are never removed/)
  assert.match(row.summary, /one unreadable file pauses cleanup for all of them, so the folder can sit above the target/)
  assert.match(row.summary, /An unreadable choice stops cleanup instead of deleting\.$/)
})

test('Keep retains everything with no limit; Archive keeps everything by moving closed files under the default rule', () => {
  assert.match(row.summary, /Keep retains every file, with no storage limit\./)
  assert.match(row.summary, /Archive keeps every file too: closed files that reach the default age or storage target are moved to the archive folder instead of removed\./)
  assert.doesNotMatch(row.summary, /Keep or Archive retains every file/, 'Archive is not described as a no-limit keep')
})

test('the row lists every managed diagnostic kind and keeps its exclusions', () => {
  assert.match(row.summary, /app stall, memory, exit, native-decision, native agent log and startup failure records/)
  assert.match(row.summary, /Your saved work, active recovery state and signed audit segments are never part of this cleanup\./)
  assert.match(row.summary, /A diagnostic that reaches its own output budget stops writing and says so; the work itself continues\./)
})
