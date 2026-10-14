import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import {
  createCloudMirrorSetup,
  emptyMirrorSetupState,
  githubRepositoryFromRemote,
  registerBlockedReason,
  setupBodyMarkup,
  setupMarkup,
} from '../../src/cloud-mirror-setup.js'

// The view module imports a stylesheet; node cannot load one. See the hook's
// own header for why this matters beyond convenience.
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { SETTINGS } = await import('../../src/views/settings.js')

/* These drive the module WITH VALUES rather than reading its source. A sweep of
   this repository found twenty-one tests that pinned an implementation's
   SPELLING, and every one of them would fail against a better implementation
   while passing against a reinstated defect. The module was written with
   injected dependencies precisely so this file did not have to be one of them. */

const ENVIRONMENT_ID = '6a8cb9e4d4c481918bab8089e2fe2ca2'
const BINDING_MESSAGE = 'The environment ID was entered by the person. The provider has not confirmed its repository binding.'
const PRIVATE_ENV = Object.freeze({
  environmentId: ENVIRONMENT_ID, repository: 'Example/mirror', visibility: 'private',
})
const VERIFIED_AT = '2026-09-01T12:00:00.000Z'
const SOURCE_COMMIT = 'a'.repeat(40)
const PUBLICATION_COMMIT = 'b'.repeat(40)
const auditReceipt = sequence => ({ sequence, eventHash: sequence.toString(16).padStart(64, '0') })
const REQUIRED_CHECKS = Object.freeze([
  'mirror repository is active',
  'mirror repository is private',
  'mirror repository is reachable',
  'this machine can push to the mirror',
])

function verifiedProject({
  key = 'engine', repository = 'Example/mirror', sourceRoot = '\x43:/checkout', enabled,
} = {}) {
  return {
    key,
    sourceRoot,
    boundaryManifest: 'config/cloud-mirror-boundary.json',
    mirrorRemote: `https://github.com/${repository}.git`,
    mirrorBranch: `cloud-mirror/${key}`,
    cloudRepository: repository,
    githubRepository: repository,
    privacyVerifiedAt: VERIFIED_AT,
    ...(enabled === undefined ? {} : { enabled }),
  }
}

function registrationReceipt({ key = 'engine', repository = 'Example/mirror', sourceRoot = '\x43:/checkout', environment = ENVIRONMENT_ID } = {}) {
  const project = verifiedProject({ key, repository, sourceRoot })
  delete project.key
  return {
    action: 'cloud-mirror-register',
    projectKey: key,
    environment,
    repositoryBinding: {
      source: 'person-entered', confirmation: 'unconfirmed', providerConfirmed: false, message: BINDING_MESSAGE,
    },
    project,
    intentAudit: auditReceipt(40),
    audit: auditReceipt(41),
    checks: REQUIRED_CHECKS.map(name => ({ name, state: 'OK', detail: 'verified by the backend' })),
  }
}

function publicationReceipt({ key = 'engine', repository = 'Example/mirror' } = {}) {
  return {
    action: 'cloud-mirror-publish',
    projectKey: key,
    cloudRepository: repository,
    mirrorBranch: `cloud-mirror/${key}`,
    sourceCommit: SOURCE_COMMIT,
    publicationCommit: PUBLICATION_COMMIT,
    mirroredEntries: 1,
    withheldEntries: 0,
    intentAudit: auditReceipt(42),
    audit: auditReceipt(43),
  }
}

function readyState(overrides = {}) {
  return {
    ...emptyMirrorSetupState(),
    phase: 'ready',
    ...overrides,
    draft: {
      projectKey: 'engine', sourceRoot: '\x43:/checkout', boundaryManifest: 'config/cloud-mirror-boundary.json', mirrorRemote: 'https://github.com/Example/mirror.git',
      environment: ENVIRONMENT_ID, ...(overrides.draft || {}),
    },
  }
}

test('the register control carries its own reason for every state that blocks it', () => {
  assert.equal(registerBlockedReason(readyState()), null, 'a valid manual ID and private mirror declaration can be registered')

  // Each of these must return a SENTENCE, not a boolean. The dead-control
  // census in this repository found forty-nine live controls that could not
  // succeed, and the fix that was ruled on is that the reason travels with the
  // disabled control rather than arriving after the press.
  const blocked = [
    ['projectKey', '', /short name/i],
    ['projectKey', 'Has Capitals', /lowercase/i],
    ['sourceRoot', '', /folder/i],
    ['boundaryManifest', '', /boundary manifest/i],
    ['mirrorRemote', '', /repository/i],
    ['environment', '', /environment/i],
  ]
  for (const [field, value, expected] of blocked) {
    const reason = registerBlockedReason(readyState({ draft: { [field]: value } }))
    assert.match(String(reason), expected, `${field}=${JSON.stringify(value)} must block with a reason naming what to do`)
  }
})

test('the typed GitHub remote must identify the exact HTTPS repository', () => {
  assert.equal(githubRepositoryFromRemote('https://github.com/ExampleOwner/private-mirror.git'), 'ExampleOwner/private-mirror')
  assert.equal(githubRepositoryFromRemote('git@github.com:ExampleOwner/private-mirror.git'), null,
    'SCP-style SSH remotes must not cross the HTTPS-only transport boundary')
  assert.equal(githubRepositoryFromRemote('ssh://git@github.com/ExampleOwner/private-mirror.git'), null,
    'SSH URLs must not cross the HTTPS-only transport boundary')
  assert.equal(githubRepositoryFromRemote('https://person-896cddb0@example.com/ExampleOwner/private-mirror.git'), null,
    'a credential embedded in a remote must not be accepted by the form')
  assert.equal(githubRepositoryFromRemote('https://github.com:444/ExampleOwner/private-mirror.git'), null,
    'a URL with an explicit port is not the exact github.com destination the backend verifies')
  assert.equal(githubRepositoryFromRemote('https://github.com/ExampleOwner/private-mirror.git?redirect=elsewhere'), null)

  const malformed = registerBlockedReason(readyState({
    draft: { mirrorRemote: 'https://example.invalid/not-github.git' },
  }))
  assert.match(String(malformed), /GitHub repository address/i)
})

test('manual environment IDs register without a catalog or a repository inference', () => {
  for (const environments of [
    [],
    [PRIVATE_ENV],
    [{ ...PRIVATE_ENV, repository: 'Elsewhere/mirror' }],
    [{ ...PRIVATE_ENV, repository: null, reason: 'No repository was reported.' }],
  ]) {
    for (const environmentsComplete of [null, false, true]) {
      const state = readyState({ environments, environmentsComplete })
      assert.equal(registerBlockedReason(state), null,
        'a stale or unread catalog cannot block the person-entered declaration')
    }
  }
})

test('the environment field asks for an ID beside the declared repository and discloses uncertainty', () => {
  const markup = setupBodyMarkup(readyState())
  assert.match(markup, /<input[^>]*type="text"[^>]*data-cms-field="environment"/)
  assert.doesNotMatch(markup, /<select[^>]*data-cms-field="environment"/)
  assert.match(markup, /32-character hexadecimal environment ID for Example\/mirror/)
  assert.match(markup, /ToolsEnabled cannot confirm that this environment points at that repository/)
  assert.doesNotMatch(markup, /Choose one|list is incomplete|environments have not been read|environment is bound to the same/i)
})

test('malformed environment IDs refuse before any bridge action', async () => {
  for (const environment of ['', 'env-private', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'a'.repeat(16) + '/' + 'b'.repeat(15)]) {
    const actions = []
    const setup = createCloudMirrorSetup({
      documentRef: null,
      postAction: async action => { actions.push(action); return { ok: false } },
    })
    Object.assign(setup.state, readyState({ draft: { environment } }))
    assert.match(String(registerBlockedReason(setup.state)), /environment ID/i)
    await setup.register()
    assert.deepEqual(actions, [], 'an invalid ID must not contact the bridge')
  }
})

test('registration sends only the entered ID with its manual provenance and repository declaration', async () => {
  const calls = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => { calls.push({ action, body }); return { ok: false, reason: 'Stop after observing the request.' } },
  })
  Object.assign(setup.state, readyState({
    environments: [{ ...PRIVATE_ENV, accountId: 'catalog-account' }],
    draft: { environment: `  ${ENVIRONMENT_ID.toUpperCase()}  ` },
  }))
  await setup.register()
  assert.deepEqual(calls, [{
    action: 'cloud-mirror-register',
    body: {
      projectKey: 'engine', sourceRoot: '\x43:/checkout', boundaryManifest: 'config/cloud-mirror-boundary.json',
      mirrorRemote: 'https://github.com/Example/mirror.git', environment: ENVIRONMENT_ID, environmentSource: 'person-entered',
    },
  }], 'the environment cannot select an account from a catalog')
})

test('settings describes entering an environment ID and the unconfirmed repository binding', () => {
  const row = SETTINGS.find(setting => setting.id === 'cloud_mirror_setup')
  assert.match(row.desc, /enter.*environment ID/i)
  assert.match(row.desc, /cannot confirm.*environment.*repository/i)
})

test('the check list renders UNVERIFIED rows, not only the successes', () => {
  const markup = setupBodyMarkup({
    ...readyState(), phase: 'registered',
    result: {
      projectKey: 'engine', project: { cloudRepository: 'Example/mirror' },
      checks: [
        { name: 'this machine can push to the mirror', state: 'OK', detail: 'dry-run accepted' },
        { name: 'environment reports this repository', state: 'UNVERIFIED', detail: 'no noninteractive discovery' },
      ],
    },
  })
  assert.match(markup, /this machine can push to the mirror/)
  assert.match(markup, /environment reports this repository/)
  assert.match(markup, /not established/, 'an UNVERIFIED row must reach the reader — a registration showing only its successes reads as a clean bill of health for things nobody looked at')
})

test('markup escapes what the provider and the person supply', () => {
  const markup = setupBodyMarkup(readyState({
    draft: { mirrorRemote: '"><img src=x onerror=alert(1)>' },
  }))
  assert.doesNotMatch(markup, /<img src=x/, 'a value carrying markup must not reach the document as markup')
  assert.match(markup, /&quot;&gt;&lt;img/)
})

test('a registration refusal shows the engine sentence and does not report success', async () => {
  const calls = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => {
      calls.push(action)
      if (action === 'cloud-mirror-list') return { ok: true, receipt: { registryPath: 'r.json', projects: [] } }
      if (action === 'cloud-accounts') return { ok: true, receipt: { environments: [PRIVATE_ENV], environmentsComplete: true } }
      return { ok: false, code: 'CLOUD_MIRROR_REMOTE_UNREACHABLE', reason: 'this computer cannot reach that repository: Repository not found.' }
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(setup.state.phase, 'failed')
  assert.equal(setup.state.result, null, 'a refused registration must leave no receipt behind to be read as a success')
  assert.match(setup.state.refusal.message, /Repository not found/, "the engine's own sentence is forwarded rather than replaced")
  assert.equal(setup.state.refusal.code, 'CLOUD_MIRROR_REMOTE_UNREACHABLE')
})

test('a response with no reason still refuses out loud rather than silently', async () => {
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => ({ ok: false }) })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(setup.state.phase, 'failed')
  assert.match(setup.state.refusal.message, /did not say why/, 'a bridge answer with no reason must still produce a visible refusal — a silent control is the defect this codebase keeps re-finding')
})

test('register does nothing at all while the form is blocked', async () => {
  let posted = 0
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => { posted += 1; return { ok: true, receipt: {} } } })
  Object.assign(setup.state, readyState({ draft: { mirrorRemote: '' } }))
  await setup.register()
  assert.equal(posted, 0, 'a blocked form must not reach the network — the three network calls a registration makes are not free')
})

test('blank setup has no default or personal repository and cannot contact registration', async () => {
  let posted = 0
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async () => { posted += 1; return { ok: true, receipt: {} } },
  })
  Object.assign(setup.state, emptyMirrorSetupState(), { phase: 'ready', environmentsComplete: true })
  assert.equal(setup.state.draft.mirrorRemote, '')
  Object.assign(setup.state, readyState({ draft: { mirrorRemote: '' } }))
  assert.match(String(registerBlockedReason(setup.state)), /private repository/i)
  const markup = setupBodyMarkup(setup.state)
  assert.doesNotMatch(markup, /value="https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i,
    'a fresh form must not contain a configured destination')
  await setup.register()
  assert.equal(posted, 0)
})

test('the existing boundary mechanism is visible, canonicalized, and traversal refuses before any request', async () => {
  for (const boundaryManifest of [
    '../outside.json',
    './config/cloud-mirror-boundary.json',
    '/absolute.json',
    '\x43:/outside.json',
    'config//cloud-mirror-boundary.json',
    'config/../cloud-mirror-boundary.json',
  ]) {
    let posted = 0
    const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => { posted += 1; return { ok: false } } })
    Object.assign(setup.state, readyState({ draft: { boundaryManifest } }))
    assert.match(String(registerBlockedReason(setup.state)), /non-traversing relative path/i)
    await setup.register()
    assert.equal(posted, 0, `${boundaryManifest} crossed the client-side boundary gate`)
  }

  const bodies = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (_action, body) => { bodies.push(body); return { ok: false, code: 'STOP', reason: 'observed' } },
  })
  Object.assign(setup.state, readyState({ draft: { boundaryManifest: 'config\\cloud-mirror-boundary.json' } }))
  await setup.register()
  assert.equal(bodies[0].boundaryManifest, 'config/cloud-mirror-boundary.json',
    'the request sends the engine one canonical repository-relative manifest path')
  const markup = setupBodyMarkup(readyState())
  assert.match(markup, /data-cms-field="boundaryManifest"[^>]*value="config\/cloud-mirror-boundary\.json"/)
  assert.match(markup, /will not create it or guess what may leave this computer/i)
})

test('malformed and credential-bearing repository addresses refuse before registration', async () => {
  for (const mirrorRemote of [
    'default',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/owner/repo/',
    'https://github.com/owner//repo.git',
    'https://person-896cddb0@example.com/owner/repo.git',
    'https://github.com/owner/repo.git#stale',
  ]) {
    let posted = 0
    const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => { posted += 1; return { ok: true } } })
    Object.assign(setup.state, readyState({ draft: { mirrorRemote } }))
    assert.match(String(registerBlockedReason(setup.state)), /GitHub repository address/i, mirrorRemote)
    await setup.register()
    assert.equal(posted, 0, mirrorRemote)
  }
})

test('public repository refusal cannot fall through to publication', async () => {
  const actions = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async action => {
      actions.push(action)
      return {
        ok: false,
        code: 'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
        reason: 'github.repo_get reports Example/mirror as visibility=public, not private.',
      }
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.deepEqual(actions, ['cloud-mirror-register'])
  assert.equal(setup.state.result, null)
  assert.equal(setup.state.refusal.code, 'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE')
})

test('an ok registration receipt for a stale or unproved repository never triggers publish', async () => {
  for (const mutate of [
    receipt => { receipt.project.cloudRepository = 'Elsewhere/stale' },
    receipt => { receipt.project.privacyVerifiedAt = '' },
    receipt => { receipt.checks = receipt.checks.filter(check => check.name !== 'mirror repository is private') },
    receipt => { delete receipt.intentAudit },
    receipt => { receipt.audit.eventHash = 'not-an-audit-hash' },
    receipt => { receipt.audit = auditReceipt(receipt.intentAudit.sequence) },
    receipt => { delete receipt.action },
  ]) {
    const actions = []
    const receipt = registrationReceipt()
    mutate(receipt)
    const setup = createCloudMirrorSetup({
      documentRef: null,
      postAction: async action => { actions.push(action); return { ok: true, receipt } },
    })
    Object.assign(setup.state, readyState())
    await setup.register()
    assert.deepEqual(actions, ['cloud-mirror-register'])
    assert.equal(setup.state.phase, 'failed')
    assert.equal(setup.state.result, null)
    assert.equal(setup.state.refusal.code, 'CMS_REGISTRATION_RECEIPT_UNVERIFIED')
  }
})

test('a hostile registration receipt accessor becomes an unverified refusal, not a wedged dialog', async () => {
  const actions = []
  const hostileReceipt = new Proxy({}, { get() { throw new Error('hostile receipt getter') } })
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async action => { actions.push(action); return { ok: true, receipt: hostileReceipt } },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.deepEqual(actions, ['cloud-mirror-register'])
  assert.equal(setup.state.busy, null)
  assert.equal(setup.state.phase, 'failed')
  assert.equal(setup.state.refusal.code, 'CMS_REGISTRATION_RECEIPT_UNVERIFIED')
})

test('a malformed enabled list row is disabled locally and cannot call publish', async () => {
  const actions = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async action => {
      actions.push(action)
      if (action === 'cloud-mirror-list') {
        return { ok: true, receipt: { projects: [{ key: 'engine', enabled: true, cloudRepository: 'Example/mirror' }] } }
      }
      if (action === 'cloud-accounts') {
        return { ok: true, receipt: { environments: [PRIVATE_ENV], environmentsComplete: true } }
      }
      return { ok: true, receipt: publicationReceipt() }
    },
  })
  await setup.load()
  assert.equal(setup.state.projects[0].enabled, false)
  assert.match(setup.state.projects[0].disabledReason, /complete exact private-destination proof/i)
  const beforePublish = actions.length
  await setup.publish('engine')
  assert.equal(actions.length, beforePublish, 'an unproved loaded row reached the publish action')
})

test('a malformed or cross-repository publication success is never reported as confirmed', async () => {
  for (const receipt of [
    {},
    { ...publicationReceipt(), cloudRepository: 'Elsewhere/stale' },
    { ...publicationReceipt(), publicationCommit: '' },
    { ...publicationReceipt(), intentAudit: null },
    { ...publicationReceipt(), audit: { sequence: 43, eventHash: 'bad' } },
    { ...publicationReceipt(), intentAudit: auditReceipt(43), audit: auditReceipt(42) },
  ]) {
    const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => ({ ok: true, receipt }) })
    Object.assign(setup.state, readyState({ projects: [verifiedProject({ enabled: true })] }))
    await setup.publish('engine')
    assert.equal(setup.state.phase, 'publish-failed')
    assert.equal(setup.state.refusal.code, 'CMS_PUBLICATION_RECEIPT_UNVERIFIED')
  }
})

test('a registry that cannot be READ is not reported as a registry that is empty', async () => {
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action) => (action === 'cloud-mirror-list'
      ? { ok: false, code: 'BRIDGE_GUARD_REFUSED', reason: 'The local policy refused the action.' }
      : { ok: true, receipt: { environments: [], environmentsComplete: true } }),
  })
  await setup.load()
  assert.equal(setup.state.projects.length, 0)
  assert.match(String(setup.state.refusal?.message), /policy refused/,
    'an unreadable registry must say so — reporting it as empty would invite registering a duplicate over work that cannot currently be seen')
})

test('setup loads registered mirrors without asking for an environment or account catalog', async () => {
  const calls = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => {
      calls.push({ action, body })
      if (action === 'cloud-mirror-list') return { ok: true, receipt: { registryPath: 'r.json', projects: [] } }
      throw new Error('Catalog discovery is unsupported.')
    },
  })
  await setup.load()
  assert.deepEqual(calls, [{ action: 'cloud-mirror-list', body: {} }])
  assert.equal(setup.state.phase, 'ready')
  assert.equal(setup.state.refusal, null)
  Object.assign(setup.state.draft, readyState().draft)
  assert.equal(registerBlockedReason(setup.state), null)
})

test('choosing a folder without the desktop shell refuses by name instead of doing nothing', async () => {
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => ({ ok: true, receipt: {} }), chooseDirectory: null })
  await setup.pickFolder()
  assert.equal(setup.state.refusal.code, 'CMS_NO_FOLDER_PICKER')
  assert.match(setup.state.refusal.message, /desktop app/i)
})

test('the folder control is disabled with its reason when no folder picker is available', () => {
  const markup = setupBodyMarkup(readyState(), { canChooseDirectory: false })
  assert.match(markup, /data-cms-action="choose-folder" disabled aria-describedby="cms-folder-blocked"/)
  assert.match(markup, /id="cms-folder-blocked"[^>]*>[^<]*unavailable in this browser/i)
})

test('a cancelled folder choice is not an error and leaves the draft alone', async () => {
  const setup = createCloudMirrorSetup({
    documentRef: null, postAction: async () => ({ ok: true, receipt: {} }),
    chooseDirectory: async () => ({ ok: true, canceled: true }),
  })
  setup.state.draft.sourceRoot = '\x43:/already'
  await setup.pickFolder()
  assert.equal(setup.state.refusal, null, 'cancelling is a choice, not a failure')
  assert.equal(setup.state.draft.sourceRoot, '\x43:/already')
})

test('a successful registration records the project so a duplicate name is caught without a round trip', async () => {
  const actions = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action) => {
      actions.push(action)
      if (action === 'cloud-mirror-publish') {
        return { ok: true, receipt: publicationReceipt() }
      }
      return { ok: true, receipt: registrationReceipt() }
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(setup.state.phase, 'registered')
  assert.deepEqual(actions, ['cloud-mirror-register', 'cloud-mirror-publish'],
    'a setup that reports success must create the initial remote workspace through the supported action')
  assert.equal(setup.state.result.publication.mirrorBranch, 'cloud-mirror/engine')
  assert.match(String(registerBlockedReason(setup.state)), /already registered/i)
})

test('a failed initial publication keeps the registration and can be retried', async () => {
  let publishAttempts = 0
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action) => {
      if (action === 'cloud-mirror-register') {
        return { ok: true, receipt: registrationReceipt() }
      }
      publishAttempts += 1
      if (publishAttempts === 1) {
        return { ok: false, code: 'CLOUD_MIRROR_PUSH_FAILED', reason: 'The private mirror could not be reached.' }
      }
      return { ok: true, receipt: publicationReceipt() }
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(setup.state.phase, 'publish-failed')
  assert.equal(setup.state.projects.length, 1, 'a failed push must not pretend the successful registration vanished')
  assert.match(setup.state.refusal.message, /could not be reached/i)

  await setup.publish('engine')
  assert.equal(setup.state.phase, 'registered')
  assert.equal(publishAttempts, 2)
})

test('publishing has a stable announced progress state and legacy mirrors cannot publish', () => {
  const publishing = setupBodyMarkup({
    ...readyState(), phase: 'publishing', busy: 'publish:engine',
    projects: [{ key: 'engine', cloudRepository: 'Example/mirror', enabled: true }],
    result: { projectKey: 'engine', project: { cloudRepository: 'Example/mirror' }, checks: [] },
  })
  assert.match(publishing, /role="status"/)
  assert.match(publishing, /aria-busy="true"/)
  assert.match(publishing, /Publishing engine/)
  assert.doesNotMatch(publishing, /data-cms-action="register"/,
    'the registration form must not replace the operation while its initial publication is running')

  const legacy = setupBodyMarkup(readyState({
    projects: [{ key: 'legacy', cloudRepository: 'Example/old', enabled: false, disabledReason: 'Re-register this legacy entry.' }],
    draft: { projectKey: 'new-project' },
  }))
  assert.match(legacy, /Re-register this legacy entry/)
  assert.match(legacy, /Disabled - re-registration required/)
  assert.match(legacy, /data-cms-action="reregister" data-project-key="legacy"/)
  assert.doesNotMatch(legacy, /data-cms-action="publish" data-project-key="legacy"/,
    'a disabled legacy entry must not offer the publication action')
})

test('only a disabled row can enter replacement mode and it sends replace true after preloading its saved values', async () => {
  const registeredBodies = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => {
      if (action === 'cloud-mirror-register') {
        registeredBodies.push(body)
        return { ok: true, receipt: registrationReceipt({ key: 'legacy', sourceRoot: '\x43:/saved' }) }
      }
      return { ok: true, receipt: publicationReceipt({ key: 'legacy' }) }
    },
  })
  Object.assign(setup.state, readyState({
    projects: [{
      key: 'legacy', sourceRoot: '\x43:/saved', mirrorRemote: 'https://github.com/Example/mirror.git',
      cloudRepository: 'Example/mirror', enabled: false, disabledReason: 'Missing current privacy proof.',
    }],
    draft: { projectKey: '', sourceRoot: '', boundaryManifest: 'config/cloud-mirror-boundary.json', mirrorRemote: '', environment: '' },
  }))

  assert.match(String(registerBlockedReason({
    ...setup.state,
    draft: { projectKey: 'legacy', sourceRoot: '\x43:/saved', boundaryManifest: 'config/cloud-mirror-boundary.json', mirrorRemote: 'https://github.com/Example/mirror.git', environment: ENVIRONMENT_ID },
  })), /Re-register control/i,
  'typing a disabled duplicate key must not silently authorize replacement')

  setup.beginReregister('legacy')
  assert.equal(setup.state.reregisterKey, 'legacy')
  assert.deepEqual(setup.state.draft, {
    projectKey: 'legacy',
    sourceRoot: '\x43:/saved',
    boundaryManifest: 'config/cloud-mirror-boundary.json',
    mirrorRemote: 'https://github.com/Example/mirror.git',
    environment: '',
  })
  assert.match(String(registerBlockedReason(setup.state)), /Enter.*environment ID/i,
    're-registering cannot infer an ID from the saved repository')
  setup.state.draft.environment = ENVIRONMENT_ID
  assert.equal(registerBlockedReason(setup.state), null)
  const reRegisterMarkup = setupBodyMarkup(setup.state)
  assert.match(reRegisterMarkup, /Re-registering legacy/)
  assert.match(reRegisterMarkup, /Re-register and revalidate/)
  assert.match(reRegisterMarkup, /data-cms-field="projectKey"[^>]*readonly/,
    'the selected replacement key is fixed to the disabled entry')

  await setup.register()
  assert.deepEqual(registeredBodies, [{
    projectKey: 'legacy',
    sourceRoot: '\x43:/saved',
    boundaryManifest: 'config/cloud-mirror-boundary.json',
    mirrorRemote: 'https://github.com/Example/mirror.git',
    environment: ENVIRONMENT_ID,
    environmentSource: 'person-entered',
    replace: true,
  }])
  assert.equal(setup.state.phase, 'registered')
  assert.equal(setup.state.projects.length, 1, 'the replacement updates the disabled row instead of appending a duplicate')
  assert.notEqual(setup.state.projects[0].enabled, false)
})

test('normal registration omits replace and enabled entries cannot enter replacement mode', async () => {
  const bodies = []
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => {
      if (action === 'cloud-mirror-register') {
        bodies.push(body)
        return { ok: false, code: 'TEST_STOP', reason: 'stop after observing the request' }
      }
      return { ok: true, receipt: {} }
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(Object.hasOwn(bodies[0], 'replace'), false,
    'an ordinary registration must not send even replace:false; replacement is an explicit disabled-entry capability')

  Object.assign(setup.state, readyState({
    projects: [{ key: 'engine', sourceRoot: '\x43:/checkout', mirrorRemote: 'https://github.com/Example/mirror.git', enabled: true }],
    draft: { projectKey: '', sourceRoot: '', boundaryManifest: 'config/cloud-mirror-boundary.json', mirrorRemote: '', environment: '' },
  }))
  setup.beginReregister('engine')
  assert.equal(setup.state.reregisterKey, null)
  assert.match(setup.state.refusal.message, /enabled mirrors cannot be replaced/i)
})

test('an enabled mirror can be disabled locally without implying any remote cleanup', async () => {
  const calls = []
  const enabled = {
    key: 'engine', sourceRoot: '\x43:/checkout', mirrorRemote: 'https://github.com/Example/mirror.git',
    mirrorBranch: 'cloud-mirror/engine', cloudRepository: 'Example/mirror', enabled: true,
  }
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action, body) => {
      calls.push({ action, body })
      return {
        ok: true,
        receipt: {
          action: 'cloud-mirror-disable', projectKey: 'engine', remoteChanged: false,
          project: { ...enabled, enabled: false, disabledReason: 'Disabled locally. GitHub was not changed.' },
          intentAudit: auditReceipt(44),
          audit: auditReceipt(45),
        },
      }
    },
  })
  Object.assign(setup.state, readyState({ projects: [enabled] }))

  const before = setupBodyMarkup(setup.state)
  assert.match(before, /data-cms-action="publish" data-project-key="engine"/)
  assert.match(before, /data-cms-action="disable" data-project-key="engine"/)

  await setup.disable('engine')
  assert.deepEqual(calls, [{ action: 'cloud-mirror-disable', body: { projectKey: 'engine' } }])
  assert.equal(setup.state.projects[0].enabled, false)
  assert.match(setup.state.notice, /GitHub repository and cloud-mirror\/engine were not changed/i)
  const after = setupBodyMarkup(setup.state)
  assert.match(after, /data-cms-action="reregister" data-project-key="engine"/)
  assert.doesNotMatch(after, /data-cms-action="disable" data-project-key="engine"/)
})

test('disable refuses an outcome audit that does not follow its intent', async () => {
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async () => ({
      ok: true,
      receipt: {
        action: 'cloud-mirror-disable', projectKey: 'engine',
        project: { ...verifiedProject({ enabled: true }), enabled: false },
        intentAudit: auditReceipt(45),
        audit: auditReceipt(44),
      },
    }),
  })
  Object.assign(setup.state, readyState({ projects: [verifiedProject({ enabled: true })] }))
  await setup.disable('engine')
  assert.equal(setup.state.phase, 'failed')
  assert.equal(setup.state.refusal.code, 'CMS_DISABLE_RECEIPT_UNVERIFIED')
})

test('registration always exposes one stable live status and busy state', () => {
  const idle = setupMarkup(readyState())
  assert.match(idle, /id="cms-registration-status" role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(idle, /aria-busy="false"/)

  const busyState = readyState({ busy: 'register' })
  const busy = setupMarkup(busyState)
  assert.match(busy, /aria-busy="true"/)
  assert.match(busy, /Checking and registering engine/)
  assert.match(busy, /data-cms-field="mirrorRemote"[^>]*disabled/)
  assert.match(busy, /data-cms-field="environment"[^>]*disabled/)
})

test('thrown load calls settle to a visible ready refusal instead of leaving loading stuck', async () => {
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action) => { throw new Error(`${action} connection closed`) },
  })
  await setup.load()
  assert.equal(setup.state.phase, 'ready')
  assert.equal(setup.state.busy, null)
  assert.match(setup.state.refusal.message, /cloud-mirror-list connection closed/i)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function modalHost() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    querySelector() { return null },
  }
}

test('closing and reopening invalidates late load responses from the old modal generation', async () => {
  const pending = [deferred(), deferred()]
  let call = 0
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: () => pending[call++].promise })

  const oldLoad = setup.open(modalHost())
  setup.close()
  const newLoad = setup.open(modalHost())
  pending[1].resolve({ ok: true, receipt: { registryPath: 'new.json', projects: [{ key: 'new', enabled: true }] } })
  await newLoad
  assert.equal(setup.state.registryPath, 'new.json')

  pending[0].resolve({ ok: true, receipt: { registryPath: 'stale.json', projects: [{ key: 'stale', enabled: true }] } })
  await oldLoad
  assert.equal(setup.state.registryPath, 'new.json')
  assert.deepEqual(setup.state.projects.map(project => project.key), ['new'])
  setup.close()
})

class ModalNode {
  constructor(documentRef) {
    this.documentRef = documentRef
    this.attributes = new Set()
    this.controls = []
    this.disabled = false
    this.tabIndex = 0
    this.offsetParent = {}
    this.isConnected = true
    this.dataset = {}
  }
  setAttribute(name) { this.attributes.add(name) }
  hasAttribute(name) { return this.attributes.has(name) }
  toggleAttribute(name, force) {
    if (force) this.attributes.add(name)
    else this.attributes.delete(name)
  }
  querySelectorAll() { return this.controls }
  focus() { this.documentRef.activeElement = this }
}

function modalFixture() {
  const listeners = new Map()
  const documentRef = {
    activeElement: null,
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    querySelector(selector) { return selector === 'header.topbar' ? this.header : null },
    getElementById(id) { return id === 'stage' ? this.stage : (id === 'drawer' ? this.drawer : null) },
    dispatch(name, event) { listeners.get(name)?.(event) },
  }
  documentRef.header = new ModalNode(documentRef)
  documentRef.stage = new ModalNode(documentRef)
  documentRef.drawer = new ModalNode(documentRef)
  documentRef.drawerControl = new ModalNode(documentRef)
  documentRef.drawer.controls = [documentRef.drawerControl]
  documentRef.priorFocus = new ModalNode(documentRef)
  documentRef.activeElement = documentRef.priorFocus

  const dialog = new ModalNode(documentRef)
  const close = new ModalNode(documentRef)
  close.dataset.cmsAction = 'close'
  const last = new ModalNode(documentRef)
  last.dataset.cmsAction = 'register'
  dialog.controls = [close, last]
  const hostListeners = new Map()
  const host = {
    innerHTML: '',
    addEventListener(name, listener) { hostListeners.set(name, listener) },
    removeEventListener(name) { hostListeners.delete(name) },
    querySelector(selector) {
      if (selector === '[data-cms-action="close"]') return close
      if (selector === '.cms-dialog') return dialog
      return null
    },
  }
  return { documentRef, host, close, last }
}

test('the modal traps focus, guards the background, and restores the opener on close', async () => {
  const { documentRef, host, close, last } = modalFixture()
  const setup = createCloudMirrorSetup({
    documentRef,
    postAction: async (action) => action === 'cloud-mirror-list'
      ? { ok: true, receipt: { registryPath: 'r.json', projects: [] } }
      : { ok: true, receipt: { environments: [PRIVATE_ENV], environmentsComplete: true } },
  })
  await setup.open(host)
  assert.equal(documentRef.activeElement, close, 'the close control receives deterministic initial focus')
  for (const node of [documentRef.header, documentRef.stage, documentRef.drawer, documentRef.drawerControl]) {
    assert.equal(node.hasAttribute('inert'), true, 'every canonical background surface is inert while the dialog is open')
  }

  last.focus()
  let prevented = false
  documentRef.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(documentRef.activeElement, close, 'Tab from the last stop wraps to the first')
  documentRef.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} })
  assert.equal(documentRef.activeElement, last, 'Shift+Tab from the first stop wraps to the last')

  documentRef.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  for (const node of [documentRef.header, documentRef.stage, documentRef.drawer, documentRef.drawerControl]) {
    assert.equal(node.hasAttribute('inert'), false, 'closing restores each background surface to its prior inert state')
  }
  assert.equal(documentRef.activeElement, documentRef.priorFocus)
  assert.equal(host.innerHTML, '')
})

test('a thrown bridge error clears busy state and leaves publication retryable', async () => {
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async (action) => {
      if (action === 'cloud-mirror-register') {
        return { ok: true, receipt: registrationReceipt() }
      }
      throw new Error('bridge connection closed')
    },
  })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.equal(setup.state.phase, 'publish-failed')
  assert.equal(setup.state.busy, null)
  assert.match(setup.state.refusal.message, /bridge connection closed/i)
})

test('re-registration requires a new person entry even when a saved or catalog environment matches', () => {
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async () => ({ ok: false }) })
  Object.assign(setup.state, readyState({
    environments: [PRIVATE_ENV],
    projects: [{ ...verifiedProject({ key: 'legacy', enabled: false }), environment: ENVIRONMENT_ID }],
  }))
  setup.beginReregister('legacy')
  assert.equal(setup.state.draft.environment, '')
  assert.match(String(registerBlockedReason(setup.state)), /Enter.*environment ID/i)
})

test('manual registration receipts cannot omit or contradict the unconfirmed binding warning', async () => {
  for (const change of [
    receipt => { delete receipt.repositoryBinding },
    receipt => { receipt.repositoryBinding = Object.assign([], receipt.repositoryBinding) },
    receipt => { receipt.repositoryBinding.source = 'catalog' },
    receipt => { receipt.repositoryBinding.confirmation = 'confirmed' },
    receipt => { receipt.repositoryBinding.providerConfirmed = true },
    receipt => { delete receipt.repositoryBinding.message },
    receipt => { receipt.repositoryBinding.message = '  ' },
    receipt => { receipt.repositoryBinding.message = {} },
    receipt => { receipt.repositoryBinding.message = { trim: () => BINDING_MESSAGE } },
  ]) {
    const receipt = registrationReceipt()
    change(receipt)
    const calls = []
    const setup = createCloudMirrorSetup({
      documentRef: null,
      postAction: async action => { calls.push(action); return { ok: true, receipt } },
    })
    Object.assign(setup.state, readyState())
    await setup.register()
    assert.deepEqual(calls, ['cloud-mirror-register'])
    assert.equal(setup.state.phase, 'failed')
    assert.equal(setup.state.refusal.code, 'CMS_REGISTRATION_RECEIPT_UNVERIFIED')
  }
})

test('the receipt binding message stays visible through publication, failure, and retry', async () => {
  const pendingPublish = deferred()
  const setup = createCloudMirrorSetup({
    documentRef: null,
    postAction: async action => action === 'cloud-mirror-register'
      ? { ok: true, receipt: registrationReceipt() }
      : pendingPublish.promise,
  })
  Object.assign(setup.state, readyState())
  const pendingRegister = setup.register()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(setup.state.phase, 'publishing')
  assert.match(setupBodyMarkup(setup.state), /The environment ID was entered by the person/)
  assert.match(setupBodyMarkup(setup.state), /The provider has not confirmed its repository binding/)
  pendingPublish.resolve({ ok: false, code: 'CLOUD_MIRROR_PUSH_FAILED', reason: 'The private mirror could not be reached.' })
  await pendingRegister
  assert.equal(setup.state.phase, 'publish-failed')
  assert.match(setupBodyMarkup(setup.state), /The provider has not confirmed its repository binding/)
  await setup.publish('engine')
  assert.match(setupBodyMarkup(setup.state), /The provider has not confirmed its repository binding/)

  const complete = createCloudMirrorSetup({
    documentRef: null,
    postAction: async action => ({ ok: true, receipt: action === 'cloud-mirror-register' ? registrationReceipt() : publicationReceipt() }),
  })
  Object.assign(complete.state, readyState())
  await complete.register()
  assert.equal(complete.state.phase, 'registered')
  assert.match(setupBodyMarkup(complete.state), /The provider has not confirmed its repository binding/)
})

test('receipt binding messages are shown as text rather than active markup', () => {
  const receipt = registrationReceipt()
  receipt.repositoryBinding.message = '<img src=x onerror=alert(1)>'
  for (const phase of ['publishing', 'publish-failed', 'registered']) {
    const markup = setupBodyMarkup({ ...readyState(), phase, result: receipt })
    assert.doesNotMatch(markup, /<img src=x/)
    assert.match(markup, /&lt;img src=x/)
  }
})

test('every action row on the settings page carries its own action id', () => {
  /* THE DEFECT THIS GUARDS, WHICH WAS REAL UNTIL THE SECOND ROW ARRIVED.
     `controlMarkup` emitted data-setting-action="ledger-archive" and the words
     "Preview cleanup" for EVERY setting of type 'action', because there had
     only ever been one. A second action row would have rendered the first
     one's button and run the first one's handler -- a control that looks like
     itself and does something else, which is worse than a dead one.

     READ AS REAL OBJECTS, not sliced out of the source. Its neighbour
     settings-rows-do-something.test.mjs string-slices the catalogue because
     node cannot load the stylesheet this module imports; the loader hook in
     helpers/css-stub-loader.mjs removes that obstacle, so this asserts the
     data rather than its spelling.

     STATED LIMIT: this is the CATALOGUE, not the renderer. settingsView()
     still needs a document stand-in, so the branch that reads setting.action
     is not covered here -- and a mutation confirmed the existing suites do not
     cover it either. Saying so is the point: an unmeasured branch that looks
     covered is the thing this file exists to avoid. */
  const actionRows = SETTINGS.filter(setting => setting.type === 'action')
  assert.ok(actionRows.length >= 2, 'this guard is only meaningful once a second action row exists')

  // A row with no explicit action falls back to the original id. Two such rows
  // would collide silently, which is exactly the case being guarded.
  const ids = actionRows.map(setting => setting.action || 'ledger-archive')
  assert.equal(new Set(ids).size, ids.length,
    `two settings rows share one action id (${ids.join(', ')}) -- the second would run the first one's handler`)

  for (const setting of actionRows) {
    assert.ok(typeof (setting.actionLabel || 'Preview cleanup') === 'string',
      `${setting.id} must name the words on its own button`)
  }
})

const basicCloudAudit = (action, target = 'engine') => ({ ok: true, disposition: 'not-required', required: false, recorded: false,
  durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action, target })
const basicCloudPair = action => ({ intentAudit: basicCloudAudit(`${action}.intent`), audit: basicCloudAudit(action) })

test('Basic cloud registration and publication preserve repository proof and exact operation receipts', async () => {
  const calls = []
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async (action, body) => {
    calls.push({ action, body })
    return { ok: true, receipt: action === 'cloud-mirror-register'
      ? { ...registrationReceipt(), ...basicCloudPair('cloud.mirror.register') }
      : { ...publicationReceipt(), ...basicCloudPair('cloud.mirror.publish') } }
  } })
  Object.assign(setup.state, readyState())
  await setup.register()
  assert.deepEqual(calls.map(row => row.action), ['cloud-mirror-register', 'cloud-mirror-publish'])
  assert.equal(setup.state.phase, 'registered')
  assert.equal(setup.state.refusal, null)
  for (const change of [row => { row.audit.target = 'wrong' }, row => { row.intentAudit.action = 'wrong' },
    row => { row.project.cloudRepository = 'Other/repo' }, row => { row.checks = [] },
    row => { row.audit = auditReceipt(41) }]) {
    const receipt = { ...registrationReceipt(), ...basicCloudPair('cloud.mirror.register') }
    change(receipt)
    const posted = []
    const refused = createCloudMirrorSetup({ documentRef: null, postAction: async action => { posted.push(action); return { ok: true, receipt } } })
    Object.assign(refused.state, readyState())
    await refused.register()
    assert.equal(refused.state.phase, 'failed')
    assert.deepEqual(posted, ['cloud-mirror-register'], 'unverified registration cannot publish')
  }
})

test('Basic cloud disable confirms only the requested local change and retains no remote-cleanup claim', async () => {
  const enabled = verifiedProject({ enabled: true })
  const calls = []
  const setup = createCloudMirrorSetup({ documentRef: null, postAction: async (action, body) => {
    calls.push({ action, body })
    return { ok: true, receipt: { action: 'cloud-mirror-disable', projectKey: 'engine', remoteChanged: false,
      project: { ...enabled, enabled: false }, ...basicCloudPair('cloud.mirror.disable') } }
  } })
  Object.assign(setup.state, readyState({ projects: [enabled] }))
  await setup.disable('engine')
  assert.equal(setup.state.projects[0].enabled, false)
  assert.match(setup.state.notice, /were not changed/)
  assert.deepEqual(calls, [{ action: 'cloud-mirror-disable', body: { projectKey: 'engine' } }])
  for (const change of [row => { row.action = 'other' }, row => { row.projectKey = 'other' },
    row => { row.project.key = 'other' }, row => { row.project.enabled = true },
    row => { row.remoteChanged = true }, row => { delete row.audit },
    row => { row.audit.target = 'other' }, row => { row.intentAudit = auditReceipt(4) }]) {
    const receipt = { action: 'cloud-mirror-disable', projectKey: 'engine', remoteChanged: false,
      project: { ...enabled, enabled: false }, ...basicCloudPair('cloud.mirror.disable') }
    change(receipt)
    const refused = createCloudMirrorSetup({ documentRef: null, postAction: async () => ({ ok: true, receipt }) })
    Object.assign(refused.state, readyState({ projects: [enabled] }))
    await refused.disable('engine')
    assert.equal(refused.state.projects[0].enabled, true)
    assert.equal(refused.state.notice, null)
    assert.match(refused.state.refusal.message, /did not confirm/)
  }
})
