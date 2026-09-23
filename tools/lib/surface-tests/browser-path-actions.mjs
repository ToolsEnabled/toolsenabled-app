// Browser actions for the ordered paths. No direct route changes after initial
// entry, no injected product state, no API response stubs, and no live writes.
export function browserActions({ page, mobile, origin, settle, press, dismissGuide, check, pageErrors }) {
  let rowCount, selectedName
  const proof = (ok, observed, detail = {}) => {
    check(ok, observed)
    return { verified: ok === true, observed, ...detail }
  }
  const type = async (locator, value) => {
    await press(page, locator, 'Focus search input')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    if (value) await page.keyboard.type(value)
  }
  const settingsSearch = () => page.getByRole('searchbox', { name: 'Search all settings' })
  const agentSearch = () => page.getByRole('searchbox', { name: 'Find an agent by name or role' })
  const waitRows = n => page.waitForFunction(count => document.querySelectorAll('.phone-ledger-row').length === count, n)
  const sheetName = () => page.locator('.phone-sheet.is-up .phone-sheet-name').innerText()
  const closeSheet = async () => {
    await press(page, page.locator('.phone-sheet-close'), 'Close details')
    await page.locator('.phone-sheet').waitFor({ state: 'hidden' })
    return proof(await page.locator('header.topbar').getAttribute('inert') === null &&
      await page.locator('.phone-ledger-row').count() === rowCount,
    'Sheet closed; original agent rows and header navigation restored', { rowCount })
  }
  return {
    'open-home': async () => {
      const response = await page.goto(origin + '/?ledger=1#/')
      await settle(page, 'home'); await dismissGuide(page)
      return proof(response?.status() === 200 && (await page.locator('#stage').innerText()).trim().length > 0,
        'Home rendered from the candidate entry document', { route: 'home' })
    },
    'quick-settings': async () => {
      await press(page, page.getByRole('button', { name: 'Quick settings', exact: true }), 'Quick settings')
      await page.locator('#drawer[aria-hidden="false"]').waitFor({ state: 'visible' })
      return proof(await page.locator('header.topbar').getAttribute('inert') !== null,
        'Quick settings opened and background navigation is inert')
    },
    'all-settings': async () => {
      await press(page, page.locator('#drawer .drawer-all'), 'All settings')
      await settle(page, 'settings'); await dismissGuide(page)
      return proof(await settingsSearch().isVisible() && await page.locator('#drawer').getAttribute('aria-hidden') === 'true' &&
        await page.locator('header.topbar').getAttribute('inert') === null,
      'All settings opened and the quick dialog released navigation', { route: 'settings' })
    },
    'find-setting': async () => {
      await type(settingsSearch(), 'text size')
      await page.waitForFunction(() => document.querySelector('.settings-results')?.textContent.toLowerCase().includes('text size'))
      return proof(await page.locator('.settings-results').isVisible(), 'Visible settings search results contain Text size')
    },
    'no-settings': async () => {
      await type(settingsSearch(), 'zz-no-setting-7349')
      await page.locator('.settings-empty').waitFor({ state: 'visible' })
      return proof((await page.locator('.settings-empty').innerText()).includes('No settings match'),
        'Unmatched search shows No settings match this search')
    },
    'clear-settings': async () => {
      await type(settingsSearch(), '')
      await page.waitForFunction(() => !document.querySelector('.settings-results'))
      return proof(await settingsSearch().inputValue() === '' && await page.locator('#stage').innerText().then(t => t.trim().length > 0),
        'Clearing the search restored normal settings sections')
    },
    'back-home': async () => {
      await press(page, page.locator('#nav-back'), 'Back to Home')
      await settle(page, 'home'); await dismissGuide(page)
      return proof(await page.locator('header.topbar').getAttribute('inert') === null, 'App Back returned to Home with usable navigation', { route: 'home' })
    },
    'open-computers': async () => {
      await press(page, page.locator('#stage a.home-workspace-link[href="#/computers"]'), 'Open computers')
      await settle(page, 'computers'); await dismissGuide(page)
      return proof(await page.locator('#stage .computers').isVisible(), 'Home link opened Computers', { route: 'computers' })
    },
    'signed-out': async () => proof(await page.locator('.phone-ledger-row').count() === 0 &&
      await page.getByRole('button', { name: 'Explore the demo', exact: true }).isVisible(), 'Signed-out gate exposes no private agent rows'),
    'explore-demo': async () => {
      await press(page, page.getByRole('button', { name: 'Explore the demo', exact: true }), 'Explore the demo')
      await page.waitForFunction(() => document.querySelectorAll('.phone-ledger-row').length > 1)
      rowCount = await page.locator('.phone-ledger-row').count()
      return proof(rowCount > 1, 'Product demo populated multiple example agent rows', { rowCount })
    },
    'find-agent': async () => {
      await type(agentSearch(), 'Manager')
      await page.waitForFunction(total => {
        const rows = document.querySelectorAll('.phone-ledger-row')
        return rows.length > 0 && rows.length < total && [...rows].some(r => /manager/i.test(r.textContent))
      }, rowCount)
      return proof(true, 'Manager search narrowed the rows and kept the matching agent', { rowCount: await page.locator('.phone-ledger-row').count() })
    },
    'no-agent': async () => {
      await type(agentSearch(), 'zz-no-agent-7349')
      await waitRows(0)
      return proof((await page.locator('.phone-ledger-empty-title').innerText()) === 'No matching agents',
        'Unmatched search shows No matching agents with zero rows', { rowCount: 0 })
    },
    'clear-agent': async () => {
      await type(agentSearch(), ''); await waitRows(rowCount)
      return proof(await agentSearch().inputValue() === '', 'Clearing the query restored every original agent row', { rowCount })
    },
    'collapse': async () => {
      await press(page, page.getByRole('button', { name: 'Collapse all agent branches', exact: true }), 'Collapse all')
      await page.waitForFunction(total => { const n = document.querySelectorAll('.phone-ledger-row').length; return n > 0 && n < total }, rowCount)
      return proof(true, 'Collapse left root rows and hid descendants', { rowCount: await page.locator('.phone-ledger-row').count() })
    },
    'expand': async () => {
      await press(page, page.getByRole('button', { name: 'Expand all agent branches', exact: true }), 'Expand all')
      await waitRows(rowCount)
      return proof(true, 'Expand restored the complete original row count', { rowCount })
    },
    'open-agent': async () => {
      selectedName = (await page.locator('.phone-ledger-name').first().innerText()).trim()
      await press(page, page.locator('.phone-ledger-press').first(), 'Open example agent')
      await page.locator('.phone-sheet.is-up .chat').waitFor({ state: 'visible' })
      return proof(Boolean(selectedName) && (await sheetName()).trim() === selectedName &&
        await page.locator('.phone-sheet-card .chat-input').isVisible(),
      'Sheet identifies the selected agent and shows its chat composer', { selectedName })
    },
    'agent-details': async () => {
      const tab = page.locator('.phone-sheet [data-rail-tab="details"]')
      await press(page, tab, 'Agent Details')
      await page.waitForFunction(() => document.querySelector('.phone-sheet [data-rail-tab="details"]')?.classList.contains('on'))
      return proof((await sheetName()).trim() === selectedName, 'Details selected for the same agent', { selectedName })
    },
    'agent-chat': async () => {
      await press(page, page.locator('.phone-sheet [data-rail-tab="chat"]'), 'Agent Chat')
      await page.waitForFunction(() => document.querySelector('.phone-sheet [data-rail-tab="chat"]')?.classList.contains('on'))
      return proof((await sheetName()).trim() === selectedName && await page.locator('.phone-sheet-card .chat-input').isVisible(),
        'Chat selected for the same agent and composer visible', { selectedName })
    },
    'close-agent': closeSheet,
    'reopen-agent': async () => {
      const name = (await page.locator('.phone-ledger-name').first().innerText()).trim()
      check(name === selectedName, 'Original first agent remains available')
      await press(page, page.locator('.phone-ledger-press').first(), 'Reopen same agent')
      await page.locator('.phone-sheet.is-up .chat').waitFor({ state: 'visible' })
      return proof((await sheetName()).trim() === selectedName, 'Reopening identifies the same agent', { selectedName })
    },
    'close-again': closeSheet,
    'return-home': async () => {
      await press(page, page.locator(mobile ? 'header .phone-home-link' : 'header [data-route="home"]'), 'Home')
      await settle(page, 'home'); await dismissGuide(page)
      return proof(await page.locator('header.topbar').getAttribute('inert') === null &&
        (await page.locator('#stage').innerText()).trim().length > 0, 'Home rendered with navigation released', { route: 'home' })
    },
    'page-health': async () => proof(await page.locator('html').evaluate(e => e.scrollWidth <= innerWidth + 1) &&
      pageErrors.length === 0, 'Completed user path has no page overflow or renderer exceptions'),
  }
}
