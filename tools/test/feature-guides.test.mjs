import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuidePreferences, FEATURE_GUIDES, GUIDE_STORAGE_KEY } from '../../src/feature-guides.js'

function memory(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = []
  return { values, writes, getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push([key, value]); values.set(key, value) } }
}

test('a new person gets an introduction once per feature, with other settings untouched', () => {
  const storage = memory({ 'mc.set.approvals': 'ask', password: 'untouched' })
  const preferences = createGuidePreferences(storage)
  assert.equal(preferences.shouldOffer('home'), true)
  assert.equal(preferences.seen('home'), true)
  assert.equal(preferences.shouldOffer('home'), false)
  assert.equal(preferences.shouldOffer('research'), true)
  assert.equal(createGuidePreferences(storage).shouldOffer('home'), false)
  assert.deepEqual(storage.writes.map(([key]) => key), [GUIDE_STORAGE_KEY])
  assert.equal(storage.getItem('mc.set.approvals'), 'ask')
  assert.equal(storage.getItem('password'), 'untouched')
})

test('turning off automatic tips persists without losing the page history', () => {
  const storage = memory(), preferences = createGuidePreferences(storage)
  preferences.seen('settings')
  assert.equal(preferences.quiet(true), true)
  const reopened = createGuidePreferences(storage)
  assert.equal(reopened.shouldOffer('home'), false)
  assert.equal(reopened.quiet(false), true)
  assert.equal(reopened.shouldOffer('home'), true)
  assert.equal(reopened.shouldOffer('settings'), false)
})

test('unavailable storage still lets a person dismiss or silence tips for this visit', () => {
  for (const storage of [null, { getItem() { throw Error('read refused') }, setItem() { throw Error('write refused') } }]) {
    const preferences = createGuidePreferences(storage)
    assert.equal(preferences.shouldOffer('home'), true)
    assert.equal(preferences.seen('home'), false)
    assert.equal(preferences.shouldOffer('home'), false)
    assert.equal(preferences.quiet(true), false)
    assert.equal(preferences.shouldOffer('settings'), false)
  }
})

test('a failed re-enable still honors the person’s choice for the current visit', () => {
  const storage = { getItem: () => '{"version":1,"quiet":true,"seen":{}}', setItem() { throw Error('read only') } }
  const preferences = createGuidePreferences(storage)
  assert.equal(preferences.isQuiet(), true)
  assert.equal(preferences.quiet(false), false)
  assert.equal(preferences.isQuiet(), false)
  assert.equal(preferences.shouldOffer('home'), true)
})

test('malformed and unknown-version preferences do not break first use', () => {
  for (const raw of ['bad json', 'null', '[]', '1', '{"version":7,"quiet":true,"seen":{}}', '{"version":1,"seen":[]}']) {
    const storage = memory({ [GUIDE_STORAGE_KEY]: raw })
    const preferences = createGuidePreferences(storage)
    assert.equal(preferences.shouldOffer('research'), true)
    assert.equal(preferences.seen('research'), true)
    assert.equal(createGuidePreferences(storage).shouldOffer('research'), false)
  }
})

test('reading before each write preserves changes made in another open window', () => {
  const storage = memory(), first = createGuidePreferences(storage), second = createGuidePreferences(storage)
  first.seen('home'); second.seen('settings')
  assert.deepEqual(JSON.parse(storage.getItem(GUIDE_STORAGE_KEY)).seen, { home: true, settings: true })
  first.quiet(true)
  assert.equal(second.shouldOffer('research'), false)
  second.quiet(false)
  assert.equal(first.shouldOffer('research'), true, 'a successful local write must not hide a later preference change from another window')
})

test('account rehydration clears the temporary history and reads the new account partition', () => {
  const storage = memory(), preferences = createGuidePreferences(storage)
  preferences.seen('home'); preferences.quiet(true)
  storage.values.clear()
  preferences.resetSession()
  assert.equal(preferences.shouldOffer('home'), true)
})

test('unknown feature keys cannot become a growing preference log or prototype keys', () => {
  const storage = memory({ [GUIDE_STORAGE_KEY]: '{"version":1,"seen":{"__proto__":true,"unknown":true,"home":true}}' })
  const preferences = createGuidePreferences(storage)
  assert.equal(preferences.shouldOffer('__proto__'), false)
  assert.equal(preferences.shouldOffer('constructor'), false)
  assert.equal(preferences.shouldOffer('unknown'), false)
  assert.equal(preferences.seen('__proto__'), false)
  assert.equal(preferences.seen('unknown'), false)
  preferences.seen('research')
  assert.deepEqual(JSON.parse(storage.getItem(GUIDE_STORAGE_KEY)).seen, { home: true, research: true })
})

test('each supported feature has a short guide with explanations and target controls', () => {
  for (const guide of Object.values(FEATURE_GUIDES)) {
    assert.ok(guide.title && guide.intro)
    assert.ok(guide.steps.length >= 8 && guide.steps.length <= 15)
    for (const step of guide.steps) {
      assert.ok(step.title && step.text)
      assert.ok(step.selectors.length > 0)
      assert.ok(step.text.length < 370, `${guide.name} should remain a short, readable step`)
    }
  }
  // Mandatory setup, purchases, and sign-in redirects retain their own flows.
  for (const name of ['setup', 'checkout', 'subscribe', 'guide']) assert.equal(Object.hasOwn(FEATURE_GUIDES, name), false)
})

/* EVERY LEDGER STEP NAMES WHAT THE PAGE HAS (T1339). Rows do not open and link
   nowhere, and the kind tabs are Rules, Tasks, Asks, Purchases and All, not
   "waiting versus decided". */
test('the Ledger guide describes only controls the Ledger has', () => {
  const text = FEATURE_GUIDES.ledger.steps.map(step => step.text).join(' ')
  assert.doesNotMatch(text, /Open the item|links? back to the conversation|Following that link|requests waiting on you from decisions already made/,
    'a step sends the reader to a control the Ledger does not have')
  const kinds = FEATURE_GUIDES.ledger.steps.find(step => step.title === 'Choose a kind of record')
  for (const tab of ['Rules', 'Tasks', 'Asks', 'Purchases', 'All']) assert.match(kinds.text, new RegExp(`\\b${tab}\\b`), `the kinds step does not name ${tab}`)
  assert.match(text, /Show removed/)
})

/* T1574: THE ACCOUNT GUIDE'S SIGN-OUT STEP PROMISES ONLY WHAT SIGN-OUT DOES.
   It said signing out stops the next person seeing your assistants'
   conversations; measured, every agent and its conversation stay on Computers
   after sign-out, because they belong to the computer, not the account. */
test('the account guide does not promise that signing out hides conversations', () => {
  const step = FEATURE_GUIDES.account.steps.find(entry => entry.title === 'Sign out on a shared computer')
  assert.ok(step, 'the account guide lost its sign-out step')
  assert.doesNotMatch(step.text, /cannot see your assistants/, 'the step still promises sign-out hides conversations')
  assert.match(step.text, /Signing out does not hide your agents or their conversations/)
  assert.match(step.text, /anyone using it can open them/)
})

test('the Settings guide describes a hand-changed profile the way the page labels it', () => {
  // T1550: the page reads "<profile> · N changed" after a hand change and Custom
  // only when no profile was applied and none matches (labelFor in
  // src/settings-profile-settings.js). The guide said a hand change "marks it Custom".
  const text = FEATURE_GUIDES.settings.steps.map(step => `${step.title} ${step.text}`).join(' ')
  assert.doesNotMatch(text, /marks it Custom|can make the profile Custom|becomes Custom/)
  const step = FEATURE_GUIDES.settings.steps.find(item => /Custom/.test(item.title))
  assert.ok(step, 'the guide still explains when Custom appears')
  assert.match(step.text, /keeps its name and adds how many settings differ/)
  assert.match(step.text, /1 changed/)
  assert.match(step.text, /Custom appears only when no profile was applied/)
})

/* T1566: Vault was the only page in the navigation with no guide and no
   first-visit tip. It has one now, offered once like the others, and every
   control it points at is one the Vault page draws. */
test('Vault has a guide, offered on the first visit, that points at the Vault page\'s own controls', async () => {
  const guide = FEATURE_GUIDES.vault
  assert.ok(guide, 'Vault is still the one page in the navigation with no guide')
  assert.equal(guide.name, 'Vault')
  const { readFileSync } = await import('node:fs')
  const vault = readFileSync(new URL('../../src/views/vault.js', import.meta.url), 'utf8')
  for (const step of guide.steps) {
    for (const selector of step.selectors) {
      const hook = /^\[([\w-]+)\]$/.exec(selector)?.[1] || /^\.([\w-]+)$/.exec(selector)?.[1]
      assert.ok(hook && vault.includes(hook), `'${step.title}' points at ${selector}, which the Vault page does not draw`)
    }
  }
  const storage = memory()
  assert.equal(createGuidePreferences(storage).shouldOffer('vault'), true, 'a first visit to Vault offers no tip')
})

/* T1547: the Settings guide named a 'Simple' view; the picker it highlights
   offers Basic, Advanced, Expert and Enterprise. The guide must name the view
   the way the picker labels it. */
test('the Settings guide names the views the way the picker labels them', async () => {
  const { SETTINGS_MODES } = await import('../../src/settings-mode.js')
  const labels = SETTINGS_MODES.map(mode => mode.label)
  const steps = FEATURE_GUIDES.settings.steps.filter(step => step.selectors.includes('.settings-mode-picker'))
  assert.ok(steps.length >= 2)
  for (const step of steps) {
    const words = `${step.title} ${step.text}`
    assert.doesNotMatch(words, /\bSimple\b/, `'${step.title}' tells people to choose Simple, which the picker does not offer`)
  }
  assert.ok(labels.includes('Basic'))
  assert.ok(steps.some(step => /\bBasic\b/.test(step.text)), 'no step names the Basic view it recommends')
})

/* T1552: nine of the Computers guide's thirteen steps framed the wrong
   control. The first visible selector wins, so the map steps that listed the
   toolbar (.graph-bar) before the map (.graph-wrap) framed the toolbar; the
   chooser and overview steps fell back to the computer tab row; and the
   'map or summary' step framed the computer tabs, which only choose a
   computer. */
test('the Computers guide frames the map, the chooser and the overview, never a stand-in', () => {
  const steps = FEATURE_GUIDES.computers.steps
  const byTitle = title => steps.find(step => step.title === title)
  for (const title of ['What an assistant is', 'What a tree is', 'Meet your assistants', 'Follow a branch downward', 'Return to one assistant']) {
    const step = byTitle(title)
    assert.ok(step, `missing step ${title}`)
    assert.equal(step.selectors[0], '.graph-wrap', `'${title}' frames ${step.selectors[0]} before the map it describes`)
    assert.ok(!step.selectors.includes('.graph-bar'), `'${title}' can still frame the toolbar`)
  }
  for (const title of ['Choose which tree you are adding to', 'Check what needs you', 'Read a summary before opening a tree']) {
    const step = byTitle(title)
    assert.ok(step, `missing step ${title}`)
    assert.ok(!step.selectors.some(selector => selector.startsWith('.comp-topbar')), `'${title}' falls back to the computer tab row`)
    assert.ok(step.unavailable, `'${title}' has no note for when its control is not on screen`)
  }
  const summary = steps.find(step => /summary/i.test(step.text) && /map/i.test(step.text) && !/^Read a summary/.test(step.title))
  assert.ok(summary, 'no step explains moving between the map and the summary')
  assert.ok(!summary.selectors.includes('.comp-topbar .tabs'), 'the map/summary step frames the computer tabs, which only choose a computer')
  assert.ok(summary.selectors.includes('.graph-open-btn'), 'the map/summary step does not frame Fleet overview')
  assert.doesNotMatch(summary.text, /tabs at the top/i)
})
