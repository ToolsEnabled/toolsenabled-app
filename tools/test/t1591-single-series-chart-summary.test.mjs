import assert from 'node:assert/strict'
import test from 'node:test'

import { chartSummary, labelChart } from '../../src/metrics-chart-summary.js'
import { liveWindow, tokenBandOption, tokenBands } from '../../src/metrics-live-charts.js'

const NOW = Date.UTC(2026, 7, 18, 12, 30)
const THEME = {
  ink3: '#64727f', grid: '#eeeeee', cross: '#cccccc', bg: '#ffffff',
  font: 'sans-serif', mono: 'monospace', dark: false,
  prov: { codex: '#0f62fe', claude: '#8a3ffc', unrecorded: '#6f6f6f' },
}

const turn = (tier, totalTokens, sequence) => ({
  sequence, atMs: NOW - 60 * 60 * 1000, sessionId: `session-${sequence}`,
  tier, account: 'test@example.com', basis: 'turn', totalTokens, derivedTotal: false,
})

test('real token bands retain one assistant identity and preserve multi/unnamed wording', () => {
  const window = liveWindow('24h', NOW)
  const singleOption = tokenBandOption({
    bands: tokenBands([turn('luna', 1234, 1)], window), window, theme: THEME,
  })
  assert.equal(singleOption.series.length, 1)
  assert.equal(singleOption.series[0].name, 'Codex')
  const singleWords = chartSummary('Token flow', singleOption)
  assert.match(singleWords, /Codex: 1,234 in all/, `single-assistant identity is missing: ${singleWords}`)

  const attributes = new Map([['data-chart-title', 'Token flow']])
  const host = {
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    closest: () => null,
  }
  assert.equal(labelChart(host, singleOption), singleWords)
  assert.equal(attributes.get('role'), 'img')
  assert.equal(attributes.get('aria-label'), singleWords)

  const multiOption = tokenBandOption({
    bands: tokenBands([turn('luna', 1234, 1), turn('claude-sonnet', 567, 2)], window),
    window, theme: THEME,
  })
  const multiWords = chartSummary('Token flow', multiOption)
  assert.match(multiWords, /Codex: 1,234 in all/)
  assert.match(multiWords, /Claude: 567 in all/)

  const unnamedWords = chartSummary('Unnamed series', { series: [{ type: 'line', data: [7] }] })
  assert.equal(unnamedWords, 'Unnamed series. 7.')
})
