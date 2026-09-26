import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dockerSetupMarkup } from '../../src/setup-docker.js'

test('optional sandbox guidance does not make Docker a normal-agent prerequisite', () => {
  const markup = dockerSetupMarkup()
  assert.match(markup, /Docker is not required for normal Claude or Codex agents, tree delegation, or editing work/)
  assert.match(markup, /required for ToolsEnabled sandbox execution/)
  assert.match(markup, /finish setup now and return later/)
  assert.match(markup, /<details class="setup-docker-guidance">/)
  assert.match(markup, /<summary>Set up Docker \(optional\)<\/summary>/)
  assert.doesNotMatch(markup, /<details[^>]*\bopen\b/)
  assert.doesNotMatch(markup, /\brequired=|data-setup-next|data-setup-back/)
})
test('unsupported platforms expose disabled prepare but retain usable readiness check', () => {
  const markup = dockerSetupMarkup({ preparationSupported: false })
  assert.match(markup, /data-sandbox-action="prepare" disabled/)
  assert.match(markup, /data-sandbox-action="check">/)
  assert.match(markup, /Automatic image preparation is unavailable/)
  assert.doesNotMatch(dockerSetupMarkup({ preparationSupported: true }), /data-sandbox-action="prepare" disabled/)
})

test('guidance honestly leaves installation and sandbox readiness unverified', () => {
  const markup = dockerSetupMarkup()
  assert.match(markup, /Docker status is unverified/)
  assert.match(markup, /Installing Docker alone does not establish sandbox readiness/)
  assert.match(markup, /pinned ToolsEnabled image and a successful sandbox readiness check/)
  assert.match(markup, /failures do not fall back/)
})

test('Linux and Windows instructions are official selectable text, not automatic execution or navigation', () => {
  const markup = dockerSetupMarkup()
  assert.match(markup, /https:\/\/docs\.docker\.com\/engine\/security\/rootless\//)
  assert.match(markup, /https:\/\/docs\.docker\.com\/desktop\/setup\/install\/windows-install\//)
  assert.match(markup, /Windows, use Docker Desktop with Linux containers/)
  assert.match(markup, /normal user/)
  assert.match(markup, /Python 3 and the ACL utilities \(setfacl and getfacl\)/)
  assert.doesNotMatch(markup, /<a\b|<script\b|<iframe\b|\bon\w+=|\bhref=|\bsrc=|sudo |apt-get|curl |wget /)
})

test('the actual setup review renders the optional guidance without changing finish controls', () => {
  const view = readFileSync(new URL('../../src/views/setup.js', import.meta.url), 'utf8')
  const review = view.slice(view.indexOf('function reviewMarkup()'), view.indexOf('/* ---------- moving between steps'))
  assert.match(view, /import \{ dockerSetupMarkup \} from '\.\.\/setup-docker\.js'/)
  assert.ok(review.includes('${dockerSetupMarkup()}'))
  assert.match(review, /nextDisabled: workspaceWriteMissing/)
})
