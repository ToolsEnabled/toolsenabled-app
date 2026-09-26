import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8')

test('the per-user installer refuses elevation before touching legacy account state', () => {
  const preInit = /!macro preInit([\s\S]*?)!macroend/.exec(source)?.[1] || ''
  const customInit = /!macro customInit([\s\S]*?)!macroend/.exec(source)?.[1] || ''
  assert.match(preInit, /\$\{If\}\s+\$\{UAC_IsAdmin\}/,
    'preInit has no high-integrity refusal')
  assert.match(preInit, /\$\{IfNot\}\s+\$\{Silent\}[\s\S]*MessageBox/,
    'the explanatory dialog must be interactive-only')
  assert.match(preInit, /SetErrorLevel\s+740[\s\S]*Quit/,
    'the elevated installer must terminate with a nonzero refusal')
  assert.doesNotMatch(preInit, /RescueLegacyInstallDirState/,
    'the early refusal hook must not read or copy legacy account state')
  assert.match(customInit, /!insertmacro RescueLegacyInstallDirState/,
    'ordinary setup still needs the legacy-state rescue')
})
