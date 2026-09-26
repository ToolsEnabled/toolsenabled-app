import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = file => readFileSync(new URL(`../../shell/${file}`, import.meta.url), 'utf8')

for (const file of ['fleet-profile-preload.cjs', 'preload.cjs']) {
  test(`${file} keeps renderer controls outside the window drag region`, () => {
    const source = read(file)
    const interactiveRule = /button, input, select, textarea, a\[href\], \[role="button"\]\s*\{([^}]*)\}/
    const match = source.match(interactiveRule)

    assert.ok(match, 'the titlebar stylesheet must identify every interactive control kind')
    assert.match(match[1], /-webkit-app-region:\s*no-drag\s*;/,
      'mouse input is swallowed as a window drag unless controls opt out')
  })
}
