// Ordered user paths shared by the CLI plan, browser driver and evidence gate.
// A descriptor is an expectation; only runJourney can attach execution evidence.
const step = (id, action, expected) => ({ id, action, expected })
export const BROWSER_PATHS = [
  {
    id: 'settings-return', title: 'Find a setting and return to Home',
    surfaces: ['browser', 'mobile'], scope: 'Real candidate renderer; isolated anonymous browser.',
    prerequisites: ['Qualified immutable App/Engine artifact', 'Fresh browser context; no existing account state'],
    steps: [
      step('open-home', 'Open the app once at Home; dismiss visible first-use tips.', 'Home content renders and the route has settled.'),
      step('quick-settings', 'Press Quick settings in the header.', 'The Quick settings dialog is visible; background navigation is inert.'),
      step('all-settings', 'Press all settings in the dialog.', 'Settings opens and the dialog releases the background.'),
      step('find-setting', 'Focus Search all settings and type text size.', 'Visible search results include Text size.'),
      step('no-settings', 'Replace the search with a deliberately unmatched phrase.', 'No settings match this search is shown.'),
      step('clear-settings', 'Clear the search using the keyboard.', 'The input is empty and the normal settings sections return.'),
      step('back-home', 'Press the app Back button.', 'Home returns through navigation history, with no stuck modal.'),
      step('open-computers', 'Press Open computers on Home.', 'Computers opens through its visible Home link.'),
    ],
  },
  {
    id: 'pg2-agent-return', title: 'Find an example agent, inspect it, and return to the list',
    surfaces: ['mobile'], scope: 'Built-in demo on PG2 rows; no live account, provider run or message send.',
    prerequisites: ['settings-return completed in the same page', 'Signed-out Computers gate'],
    steps: [
      step('signed-out', 'Read the signed-out Computers screen before exploring.', 'No private agent rows are exposed; Explore the demo is visible.'),
      step('explore-demo', 'Tap Explore the demo.', 'More than one example agent row appears.'),
      step('find-agent', 'Type Manager in Find an agent by name or role.', 'The list narrows and includes the matching agent.'),
      step('no-agent', 'Replace the query with a deliberately unmatched phrase.', 'No matching agents appears and no agent rows remain.'),
      step('clear-agent', 'Clear the agent search.', 'The full original row count returns.'),
      step('collapse', 'Tap Collapse all agent branches.', 'Descendant rows disappear while root rows remain.'),
      step('expand', 'Tap Expand all agent branches.', 'The original expanded row count returns.'),
      step('open-agent', 'Tap the first example agent row.', 'The sheet identifies that same agent and shows the chat composer.'),
      step('agent-details', 'Tap Details in the agent sheet.', 'Details becomes the selected tab for the same agent.'),
      step('agent-chat', 'Tap Chat in the same sheet.', 'Chat becomes selected and the composer is visible.'),
      step('close-agent', 'Tap Close details.', 'The sheet closes, all rows remain, and header navigation is usable.'),
      step('reopen-agent', 'Tap the same agent row again.', 'The same agent reopens; stale selection or a stuck overlay cannot hide it.'),
      step('close-again', 'Close the sheet again before leaving.', 'The sheet is hidden and background navigation is released.'),
    ],
  },
  {
    id: 'home-return', title: 'Leave Computers and confirm Home is usable',
    surfaces: ['browser', 'mobile'], scope: 'Same page and context as the preceding path.',
    prerequisites: ['Computers open; any agent sheet closed'],
    steps: [
      step('return-home', 'Press the visible Home link in the app header.', 'Home renders and header controls are no longer inert.'),
      step('page-health', 'Check the final page after completing the path.', 'No horizontal page overflow or renderer exceptions occurred.'),
    ],
  },
]
export const browserPaths = surface => {
  if (!['browser', 'mobile'].includes(surface)) throw Error('Expected browser or mobile path surface')
  return BROWSER_PATHS.filter(path => path.surfaces.includes(surface))
}
export function browserCases(surface, profile) {
  browserPaths(surface)
  if (!['smoke', 'full'].includes(profile)) throw Error('Expected smoke or full profile')
  const full = profile === 'full'
  const cells = surface === 'mobile' ? (full ? [[390,844],[844,390],[320,568],[568,320]] : [[390,844],[320,568]])
    : (full ? [[1365,900],[1920,1080]] : [[1365,900]])
  return (full ? ['chromium', 'webkit'] : ['chromium']).flatMap(engine =>
    cells.map(([width,height]) => ({ engine, width, height, label: `${engine}-${width}x${height}` })))
}
export function pendingJourney(descriptor) {
  return { ...descriptor, status: 'NOT_RUN', steps: descriptor.steps.map(s => ({ ...s, status: 'NOT_RUN' })) }
}

// Checkpoint before any action. Failed steps stop the path; successors retain
// NOT_RUN rather than silently disappearing or inheriting a previous PASS.
export async function runJourney(journey, actions, { save = () => {}, now = Date.now, onFailure } = {}) {
  if (journey.status !== 'NOT_RUN' || journey.steps.some(s => s.status !== 'NOT_RUN')) throw Error('Journey cannot be replayed in the same evidence record')
  for (const s of journey.steps) if (typeof actions[s.id] !== 'function') throw Error('Missing user action: ' + s.id)
  const checkpoint = async () => {
    try { await save() }
    catch (error) {
      // Actions may have succeeded, but an unsaved completion is not a pass.
      journey.status = 'FAIL'
      journey.error = 'Evidence checkpoint failed: ' + String(error?.message || error)
      journey.finishedAt = new Date(now()).toISOString()
      throw error
    }
  }
  journey.status = 'RUNNING'; journey.startedAt = new Date(now()).toISOString()
  await checkpoint()
  for (const s of journey.steps) {
    const started = now()
    s.status = 'RUNNING'; s.startedAt = new Date(started).toISOString()
    await checkpoint()
    try {
      const proof = await actions[s.id]()
      if (!proof || proof.verified !== true || typeof proof.observed !== 'string' || !proof.observed.trim())
        throw Error('Step produced no explicit verified observation')
      s.observation = proof; s.status = 'PASS'
    } catch (error) {
      s.status = 'FAIL'; s.error = String(error.message || error)
      journey.status = 'FAIL'
      if (onFailure) try { s.failureCapture = await onFailure(s) } catch (captureError) { s.captureError = String(captureError.message || captureError) }
      throw error
    } finally {
      s.elapsedMs = Math.max(0, now() - started)
      s.finishedAt = new Date(now()).toISOString()
      if (s.status === 'FAIL') journey.finishedAt = s.finishedAt
      await checkpoint()
    }
  }
  journey.status = 'PASS'; journey.finishedAt = new Date(now()).toISOString()
  await checkpoint()
}

export function validateJourneys(expected, actual) {
  if (!Array.isArray(expected) || !expected.length || !Array.isArray(actual) || actual.length !== expected.length)
    return 'Missing or incomplete user journeys'
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i], got = actual[i]
    if (!got || got.id !== want.id || got.status !== 'PASS' || !Array.isArray(got.steps) || got.steps.length !== want.steps.length)
      return 'Incomplete or reordered journey: ' + want.id
    for (let j = 0; j < want.steps.length; j++) {
      const need = want.steps[j], s = got.steps[j]
      if (!s || s.id !== need.id || s.action !== need.action || s.expected !== need.expected || s.status !== 'PASS' ||
          s.observation?.verified !== true || typeof s.observation?.observed !== 'string' || !s.observation.observed.trim() ||
          !s.startedAt || !s.finishedAt || !Number.isFinite(s.elapsedMs) || s.elapsedMs < 0)
        return 'Unverified, missing or reordered step: ' + want.id + '/' + need.id
    }
  }
  return null
}
