// A MOMENT THE MACHINE COULD NOT READ BECAME A PERMANENT FACT ABOUT THE PAYLOAD.
//
// shell/canonical-audit.cjs answered EVERY require failure with
// AUDIT_MODULE_ABSENT -- "the capability payload does not carry its ledger
// writer" -- and canonicalAudit() caches that answer for the life of the
// process. Driven 2026-08-27 with an injected loader, five distinct causes
// produced that one sentence:
//
//   MODULE_NOT_FOUND  EMFILE  EAGAIN  EIO  EBUSY   ->  AUDIT_MODULE_ABSENT
//
// Four of the five are false statements. The writer is staged and present; the
// machine could not read it at that instant. EMFILE is ordinary on a box already
// running a hundred node processes, and both callers in shell/main.cjs refuse the
// action for any code but AUDIT_PAYLOAD_ABSENT -- so one blip made every audited
// act for the rest of the run answer "This action was not recorded in the signed
// ledger, so it was not carried out", while the payload sat healthy on disk.
//
// This is the sibling of canonical-audit-cache.test.mjs, one branch over. That
// file established the rule for a CALLER's mistake; this one establishes it for
// a MOMENT's failure. Both are the same principle: an answer about this attempt
// must never be cached as an answer about this installation.
//
// NO STUB SITS ON THE CACHE PATH, deliberately -- canonicalAudit() bypasses the
// cache entirely whenever load/root/fresh is supplied, so a test that injected a
// loader would prove nothing about caching, which is the half that matters. The
// capability root is instead resolved the way the packaged shell resolves it,
// through process.resourcesPath, and pointed at a scratch payload whose ledger
// writer throws on demand. What runs is the real require, on the real cache path.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const audit = require('../../shell/canonical-audit.cjs')

// Throws with the code of a machine under load while the marker exists, and is a
// working ledger writer once it is gone. The marker is read at load time, so each
// require re-decides -- node does not cache a module whose load threw.
const WRITER = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "if (fs.existsSync(path.join(__dirname, 'refuse-to-load'))) {",
  "  const error = new Error('EMFILE: too many open files')",
  "  error.code = 'EMFILE'",
  "  throw error",
  "}",
  "module.exports = {",
  "  requireRecord() { return { ok: true } },",
  "  verify() { return { ok: true } },",
  "  resetForTests() {},",
  "}",
].join('\n')

function scratchPayload({ withWriter }) {
  const root = mkdtempSync(path.join(tmpdir(), 'canonical-audit-unreadable-'))
  const capability = path.join(root, 'capability')
  mkdirSync(path.join(capability, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(capability, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'src/bridge.js' }))
  if (withWriter) writeFileSync(path.join(capability, 'src', 'lib', 'audit.js'), WRITER)
  return { root, capability }
}

function usePayload(root, run) {
  const priorResources = process.resourcesPath
  const priorStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  process.resourcesPath = root
  audit.resetForTests()
  try {
    return run()
  } finally {
    audit.closeCanonical()
    audit.resetForTests()
    process.resourcesPath = priorResources
    if (priorStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = priorStateRoot
    rmSync(root, { recursive: true, force: true })
  }
}

test('a writer that could not be READ is not reported as a writer that is MISSING', () => {
  const { root, capability } = scratchPayload({ withWriter: true })
  writeFileSync(path.join(capability, 'src', 'lib', 'refuse-to-load'), '')
  usePayload(root, () => {
    const answer = audit.canonicalAudit({ stateRoot: root })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'AUDIT_MODULE_UNREADABLE',
      'a transient read failure is being reported as an absent ledger writer, which is a false statement '
      + 'about the payload and the thing this file exists to prevent')
    assert.match(answer.reason, /could not be read/,
      'the sentence does not say the read failed, so a person reading it still concludes the writer is gone')
  })
})

test('and it is NOT cached: the next attempt gets a fresh look', () => {
  const { root, capability } = scratchPayload({ withWriter: true })
  const marker = path.join(capability, 'src', 'lib', 'refuse-to-load')
  writeFileSync(marker, '')
  usePayload(root, () => {
    const first = audit.canonicalAudit({ stateRoot: root })
    assert.equal(first.code, 'AUDIT_MODULE_UNREADABLE')

    // The machine recovers -- the file was always there.
    rmSync(marker, { force: true })
    assert.equal(existsSync(marker), false)

    const second = audit.canonicalAudit({ stateRoot: root })
    assert.equal(second.ok, true,
      'one unreadable moment was cached, so every audited action for the rest of the process is refused '
      + 'while the ledger writer sits healthy on disk: ' + (second.code || '') + ' ' + (second.reason || ''))
  })
})

test('a genuinely ABSENT writer is still cached -- the cache keeps doing its job', () => {
  // THE CONTROL. Without it, never caching anything would satisfy both assertions
  // above while reinstating the module-resolution-per-keystroke cost the cache was
  // written for. This is the case the original comment is about.
  const { root } = scratchPayload({ withWriter: false })
  usePayload(root, () => {
    const first = audit.canonicalAudit({ stateRoot: root })
    const second = audit.canonicalAudit({ stateRoot: root })
    assert.equal(first.code, 'AUDIT_MODULE_ABSENT',
      'a writer that is genuinely not in the payload should still say so plainly')
    assert.equal(second, first,
      'the absent answer was not reused, so a copy with no ledger writer pays a module resolution on every '
      + 'keystroke -- the exact cost this cache exists to avoid')
  })
})
