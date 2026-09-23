import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDisplayGuardDecision } from '../lib/accessibility-ui-display-guard.mjs'

/* R96 review finding 6 (CHANGES_REQUIRED): the display guard in
 * accessibility-ui.test.mjs must apply ONLY where X11 DISPLAY semantics
 * exist (Linux). On Windows/macOS the test must launch Electron directly,
 * unconditionally, exactly as it did before e46b9314 -- never refuse, never
 * skip, regardless of DISPLAY or xvfb-run availability. This exercises the
 * extracted decision helper directly, for every platform this repository
 * still tests (RELEASE_SKIP_REGISTER carries live Windows UI Automation
 * entries in the same file), without requiring a Windows machine. */

test('linux, xvfb-run present: wraps the launch', () => {
  assert.equal(
    computeDisplayGuardDecision({ platform: 'linux', hasXvfbRun: true, hasDisplay: false }),
    'wrap'
  )
  // Ambient DISPLAY presence must not change the outcome when xvfb-run exists.
  assert.equal(
    computeDisplayGuardDecision({ platform: 'linux', hasXvfbRun: true, hasDisplay: true }),
    'wrap'
  )
})

test('linux, no xvfb-run, DISPLAY set: refuses rather than risk the live desktop', () => {
  assert.equal(
    computeDisplayGuardDecision({ platform: 'linux', hasXvfbRun: false, hasDisplay: true }),
    'refuse'
  )
})

test('linux, no xvfb-run, no DISPLAY at all: fails when no display can be created', () => {
  assert.equal(
    computeDisplayGuardDecision({ platform: 'linux', hasXvfbRun: false, hasDisplay: false }),
    'unavailable'
  )
})

test('win32: always a direct launch, regardless of DISPLAY/xvfb-run', () => {
  assert.equal(
    computeDisplayGuardDecision({ platform: 'win32', hasXvfbRun: false, hasDisplay: false }),
    'direct'
  )
  assert.equal(
    computeDisplayGuardDecision({ platform: 'win32', hasXvfbRun: false, hasDisplay: true }),
    'direct'
  )
  assert.equal(
    computeDisplayGuardDecision({ platform: 'win32', hasXvfbRun: true, hasDisplay: true }),
    'direct'
  )
})

test('darwin: always a direct launch, regardless of DISPLAY/xvfb-run', () => {
  assert.equal(
    computeDisplayGuardDecision({ platform: 'darwin', hasXvfbRun: false, hasDisplay: false }),
    'direct'
  )
  assert.equal(
    computeDisplayGuardDecision({ platform: 'darwin', hasXvfbRun: false, hasDisplay: true }),
    'direct'
  )
})
