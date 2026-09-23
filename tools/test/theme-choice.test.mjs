import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { THEME_CHOICES, isDarkTheme, normalizeThemeId } from '../../src/theme-choice.js'
import { FONT_CHOICES } from '../../src/font-choice.js'

test('every offered theme and font survives the actual pre-paint script', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
  for (const theme of THEME_CHOICES) for (const font of FONT_CHOICES) {
    const styles = new Map()
    const root = { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } }
    vm.runInNewContext(script, { document: { documentElement: root }, localStorage: { getItem: key => key === 'mc.theme' ? theme.id : font.id } })
    assert.equal(root.dataset.theme, theme.id)
    assert.equal(styles.get('--font-ui'), font.stack)
  }
})

test('dark renderers recognize both glow themes and unknown choices fall back to white', () => {
  for (const theme of ['black', 'ember', 'cobalt']) assert.equal(isDarkTheme(theme), true)
  for (const theme of ['white', 'tan', 'unknown', undefined]) assert.equal(isDarkTheme(theme), false)
  for (const theme of THEME_CHOICES) assert.equal(normalizeThemeId(theme.id), theme.id)
  assert.equal(normalizeThemeId('unknown'), 'white')
})

test('the desktop theme handler accepts glow themes only from its trusted renderer', () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = source.indexOf("ipcMain.on('mc-theme',")
  const handler = source.slice(start, source.indexOf('\n})', start) + 3)
  let listener, trusted = true
  const updates = [], writes = [], nativeTheme = {}
  vm.runInNewContext(handler, {
    ipcMain: { on: (_, callback) => { listener = callback } },
    trustedFleetProfileSender: () => trusted,
    win: { setTitleBarOverlay: value => updates.push(value), setBackgroundColor: value => updates.push(value) },
    nativeTheme, TITLEBAR_H: 32, writeState: value => writes.push(value),
  })
  for (const theme of ['ember', 'cobalt']) {
    listener({}, { theme, bg: '#170d13', ink: '#fff1f3' })
    assert.equal(nativeTheme.themeSource, 'dark')
    assert.equal(writes.at(-1).theme, theme)
  }
  assert.equal(updates.length, 4)
  trusted = false
  listener({}, { theme: 'ember', bg: '#170d13', ink: '#fff1f3' })
  trusted = true
  listener({}, { theme: 'unexpected', bg: '#170d13', ink: '#fff1f3' })
  listener({}, { theme: 'cobalt', bg: 'url(untrusted)', ink: '#fff1f3' })
  assert.equal(updates.length, 4, 'untrusted or malformed reports must never update the window')
})
