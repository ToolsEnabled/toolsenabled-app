import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { controlState } from '../../src/components.js'
import {
  removeStagedCodexCredential,
  seedCurrentCodexCredential,
  stagedCodexCredentialPath,
} from '../lib/a11y-codex-auth.mjs'

const read = relative => fs.readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

function credentialFixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'a11y-codex-auth-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const scratchCodexHome = path.join(home, 'scratch', '.codex')
  const source = path.join(codexHome, 'auth.json')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(scratchCodexHome, { recursive: true })
  return {
    root,
    home,
    codexHome,
    scratchCodexHome,
    source,
    target: stagedCodexCredentialPath(scratchCodexHome),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

// Windows path policy is tested on every host through an explicit virtual
// drive backed only by this test's temporary directory. No Windows user profile
// (including these synthetic names) is ever passed to the real filesystem.
function windowsCredentialFixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'a11y-win32-policy-'))
  const drive = path.join(root, 'drive')
  const profile = String.raw`C:\Users\StateAuditFixture`
  const alias = String.raw`C:\Users\STATEA~9`
  const home = path.win32.join(profile, 'fixture', 'home')
  const codexHome = path.win32.join(home, '.codex')
  const scratchCodexHome = path.win32.join(home, 'scratch', '.codex')
  const touched = []
  const hostPath = target => {
    let selected = path.win32.normalize(String(target))
    if (selected.toLowerCase() === alias.toLowerCase()
        || selected.toLowerCase().startsWith(`${alias.toLowerCase()}\\`)) {
      selected = profile + selected.slice(alias.length)
    }
    const allowed = selected === 'C:\\' || selected.toLowerCase() === 'c:\\users'
      || selected.toLowerCase() === profile.toLowerCase()
      || selected.toLowerCase().startsWith(`${profile.toLowerCase()}\\`)
    assert.ok(allowed, 'the virtual filesystem refuses every path outside its synthetic profile')
    touched.push(String(target))
    return path.join(drive, ...selected.slice(3).split('\\').filter(Boolean))
  }
  const virtualPath = target => `C:\\${path.relative(drive, target).split(path.sep).join('\\')}`
  fs.mkdirSync(hostPath(codexHome), { recursive: true })
  fs.mkdirSync(hostPath(scratchCodexHome), { recursive: true })
  const realpath = target => virtualPath(fs.realpathSync.native(hostPath(target)))
  realpath.native = realpath
  const virtualFs = {
    constants: fs.constants,
    lstatSync: (target, options) => fs.lstatSync(hostPath(target), options),
    realpathSync: realpath,
    readdirSync: (target, options) => fs.readdirSync(hostPath(target), options),
    copyFileSync: (source, target, flags) => fs.copyFileSync(hostPath(source), hostPath(target), flags),
    rmSync: (target, options) => fs.rmSync(hostPath(target), options),
  }
  return { root, profile, alias, home, codexHome, scratchCodexHome, fs: virtualFs, touched,
    source: hostPath(path.win32.join(codexHome, 'auth.json')),
    target: hostPath(path.win32.join(scratchCodexHome, 'auth.json')),
    close: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const zeroWindowsReparseProbe = paths => paths.map(() => 0)

test('controlState makes the render decision and its reason inseparable', () => {
  assert.throws(() => controlState({ enabled: true }), TypeError,
    'omitting why must reject the incomplete control state')
  assert.throws(() => controlState({ enabled: false, why: '' }), TypeError,
    'a disabled control without a visible reason must be rejected')
  assert.throws(() => controlState({ enabled: 'yes', why: null }), TypeError,
    'a non-boolean enabled value must be rejected')

  assert.deepEqual(controlState({ enabled: true, why: null }), {
    enabled: true,
    disabled: false,
    why: '',
  })
  assert.deepEqual(controlState({ enabled: false, why: '  Not available here.  ' }), {
    enabled: false,
    disabled: true,
    why: 'Not available here.',
  })
})

test('bridge-backed controls are gated before rendering and never optional-call a missing verb', () => {
  const guide = read('src/this-computer-settings.js') // the provider controls' home since 2026-09-10
  assert.doesNotMatch(guide, /installStart\?\.\(/)
  assert.doesNotMatch(guide, /loginStop\?\.\(/)
  assert.doesNotMatch(guide, /mcProviders\?\.account(?:Add|Remove)\(/)
  assert.match(guide, /if \(!answer \|\| answer\.ok !== true\) \{ refuse\(answer\); return \}/)

  const cloud = read('src/cloud-tasks.js')
  assert.doesNotMatch(cloud, /mcProviders\?\.cloudAccountAdd\(/)

  const setup = read('src/views/setup.js')
  assert.match(setup, /typeof globalThis\.mcSetup\?\.recordWorkspaces !== 'function'/)
  assert.match(setup, /MC_SETUP_WORKSPACE_UNAVAILABLE/)

  const setupSettings = read('src/setup-profile-settings.js')
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.chooseTier !== 'function'/)
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.chooseWorkspace === 'function'/)
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.recordWorkspaces === 'function'/)

  const fleetSettings = read('src/fleet-profile-settings.js')
  assert.match(fleetSettings, /typeof globalThis\.mcFleetProfile\?\.chooseDirectory === 'function'/)

  /* The tool switches moved out of the quick-settings drawer and onto their own
     page when they grew a third state; the gate moved with them, which is what
     this now reads. The drawer keeps a plain link, and a link needs no bridge. */
  const toolsPage = read('src/views/tools.js')
  assert.match(toolsPage, /typeof account\.putSetting === 'function'/)
  assert.match(toolsPage, /This copy cannot save answers about tools/)
  assert.match(toolsPage, /typeof agent\?\.tools !== 'function'/,
    'the tools page calls the machine before checking that it can answer')

  const compose = read('src/agent-compose-panel.js')
  assert.match(compose, /typeof onSubmit === 'function' \? '' : START_REFUSAL\.notWired/)
  assert.match(compose, /unavailableReason: submitControl\.why/)
})

/* THE MARKER VOCABULARY WAS DELIBERATELY NARROWED, AND THIS TEST FOLLOWED IT
   RATHER THAN THE REVERSE. It previously required one inline alternation
   carrying four phrases -- "at its limit", "already connected", "switched off"
   and "cannot". The harness now keeps a NAMED marker table instead, holding
   only the first two, and the reason is written beside it:

     - "cannot" also describes legitimate permission boundaries, so it fires on
       copy that is telling the truth about a working control.
     - a "switched off" section DELIBERATELY CONTAINS A WORKING CONTROL -- the
       one that switches the feature on. Flagging its enabled control as a dead
       control is precisely backwards.

   Both dropped phrases would have produced false positives, and a gate that
   cries wolf is disabled by the next person and then guards nothing. So the
   narrowing is the correct call and this test now pins the STRUCTURE and the
   BEHAVIOUR -- a named table, consulted per enabled stop -- instead of pinning
   one regex's literal text. Pinning the spelling of an implementation is what
   made this assertion fail against a better implementation. */
test('the packaged keyboard walk checks enabled stops against AX refusal copy', () => {
  const qa = read('tools/a11y-keyboard-qa.mjs')
  assert.match(qa, /Accessibility\.queryAXTree/)

  const markers = qa.slice(qa.indexOf('const REFUSAL_MARKERS'), qa.indexOf('const delay'))
  assert.ok(markers.length > 0, 'the named refusal-marker table is gone')
  assert.match(markers, /name: 'at its limit'/)
  assert.match(markers, /name: 'already connected'/)
  assert.doesNotMatch(markers, /name: 'cannot'/,
    'a marker this broad fires on copy describing a legitimate permission boundary')
  assert.doesNotMatch(markers, /name: 'switched off'/,
    'a switched-off section deliberately contains the working control that turns it on')

  assert.match(qa, /REFUSAL_MARKERS\.find\(candidate => candidate\.pattern\.test\(text\)\)/,
    'the walk must consult the marker table for each stop, not a hardcoded regex')
  assert.match(qa, /for \(const stop of real\)/)
  assert.match(qa, /!stop\.disabled && stop\.ariaDisabled !== 'true' && stop\.ax\?\.disabled !== true/)
})

test('the default keyboard audit never presses Start while the live roster is explicit and fail-closed', () => {
  const qa = read('tools/a11y-keyboard-qa.mjs')
  const credentialCopy = read('tools/lib/a11y-codex-auth.mjs')

  assert.doesNotMatch(qa, /NOT EXERCISED/,
    'the default roster must not deterministically add an unmeasured paid-session check')
  assert.match(qa, /const PRESS_START = process\.argv\.includes\('--press-start'\)/,
    'a real session may be enabled only by the caller naming --press-start')

  const costlyPrecondition = qa.indexOf("check('the live Start/Stop audit has an enabled Start control'")
  const costlyGuard = qa.indexOf('if (start && !startProbe.disabled && PRESS_START)')
  const safeRefusal = qa.indexOf("check('Start with an empty prompt does not start anything'", costlyGuard)
  const realStart = qa.indexOf("check('Enter on Start starts a session'", costlyGuard)
  const phaseEnd = qa.indexOf('/* TEXT SCALING WHERE THE CONTROL ACTUALLY IS.', costlyGuard)
  assert.ok(costlyPrecondition >= 0 && costlyPrecondition < costlyGuard,
    'the live lane must fail if Start is missing or disabled rather than closing a smaller green roster')
  assert.ok(costlyGuard >= 0 && safeRefusal > costlyGuard && realStart > safeRefusal && phaseEnd > realStart,
    'every Enter on Start, including the empty-form refusal, must remain inside the --press-start-only section')

  const optInSection = qa.slice(costlyGuard, phaseEnd)
  assert.match(optInSection, /typeText\('Reply with the single word OK and stop\.'\)/)
  assert.match(optInSection, /check\('Enter on Stop ends the session'/,
    'the opt-in path must clean up the real session it starts')
  assert.match(optInSection, /stopped\.present && !stopped\.disabled/,
    'a changed status string alone must not masquerade as a started real session')

  assert.match(credentialCopy, /overrides\.currentUserHome \|\| nodeOs\.homedir\(\)/,
    'the live lane may carry only the account that is actually running it')
  assert.match(qa, /stagedCredential = prepareCurrentCodexCredentialStage\(CODEX_HOME, profileDirectories\.codexHome,[\s\S]*copyPreparedCodexCredential\(stagedCredential\)/,
    'the cleanup guard must be assigned before the exclusive copy begins')
  assert.match(credentialCopy, /fs\.copyFileSync\(guard\.source, guard\.target, fs\.constants\.COPYFILE_EXCL\)/,
    'the live lane must carry one auth file through a kernel copy without exposing its contents')
  assert.doesNotMatch(credentialCopy, /linkSync\(source, target\)/,
    'a hard link would let writes through scratch mutate the current account sign-in')
  assert.match(qa, /if \(stagedCredential\)[\s\S]*removeStagedCodexCredential\(stagedCredential\)[\s\S]*if \(!KEEP && !credentialCleanupError && !\(CODEX_HOME && !stagedCredential\)\)[\s\S]*if \(credentialCleanupError\) throw credentialCleanupError/,
    'the copied sign-in must be removed and rechecked even when non-secret evidence is kept')
  assert.doesNotMatch(qa, /environment\.CODEX_HOME\s*=\s*path\.resolve\(CODEX_HOME\)/,
    'an ambient home outside the sterile profile must not be handed to the packaged app')
  assert.doesNotMatch(qa, /delete environment\.MC_SMOKE_HEADLESS/,
    'the unattended free lane must preserve the suite headless marker')
  assert.match(qa, /import \{ createSession \} from '\.\/test-account-harness\.mjs'/,
    'the keyboard audit must share the account harness transport whose CDP deadlines are behaviorally tested')
  assert.match(qa, /session = createSession\(port, child, \{\}\)/,
    'the keyboard audit must launch through the shared bounded CDP session')
  assert.doesNotMatch(qa, /function createSession\(/,
    'an untested local transport can send before registering its reply and wait forever')
})

test('the live keyboard audit copies one regular current-account credential and removes it even when evidence is kept', async () => {
  const fixture = credentialFixture()
  const secret = 'fixture-secret-that-must-never-enter-an-error'
  try {
    fs.writeFileSync(fixture.source, secret)
    const before = fs.lstatSync(fixture.source, { bigint: true })
    const staged = seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
    })
    const target = staged.target
    const after = fs.lstatSync(fixture.source, { bigint: true })
    const copied = fs.lstatSync(target, { bigint: true })
    assert.equal(fs.readFileSync(target, 'utf8'), secret)
    assert.equal(after.dev, before.dev)
    assert.equal(after.ino, before.ino)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeNs, before.mtimeNs)
    assert.equal(copied.isFile(), true)
    assert.equal(copied.isSymbolicLink(), false)
    assert.equal(copied.nlink, 1n)

    const nonSecretEvidence = path.join(path.dirname(target), 'screenshot-marker.txt')
    fs.writeFileSync(nonSecretEvidence, 'keep')
    await removeStagedCodexCredential(staged)
    assert.equal(fs.existsSync(target), false, 'the auth copy is removed before --keep can retain scratch')
    assert.equal(fs.readFileSync(nonSecretEvidence, 'utf8'), 'keep', 'non-secret evidence is not recursively removed')
  } finally {
    fixture.close()
  }
})

test('credential staging rejects a foreign home before any filesystem or reparse probe', () => {
  const fixture = credentialFixture()
  let probes = 0
  let copies = 0
  const instrumentedFs = {
    ...fs,
    lstatSync() { probes += 1; throw new Error('must not probe') },
    copyFileSync() { copies += 1; throw new Error('must not copy') },
  }
  try {
    assert.throws(() => seedCurrentCodexCredential(path.join(fixture.home, 'foreign'), fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      fs: instrumentedFs,
      platform: 'win32',
      reparseProbe() { probes += 1; throw new Error('must not probe') },
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'home_not_current')
    assert.equal(probes, 0)
    assert.equal(copies, 0)
  } finally {
    fixture.close()
  }
})

test('credential staging rejects a foreign Windows scratch profile lexically before probing it on every host', () => {
  const fixture = windowsCredentialFixture()
  const foreignRoot = String.raw`C:\Users\DefinitelyForeignProfile`
  try {
    fs.writeFileSync(fixture.source, 'local-source-only')
    fixture.touched.length = 0
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, `${foreignRoot}\\scratch\\.codex`, {
      currentUserHome: fixture.home,
      platform: 'win32', pathApi: path.win32, fs: fixture.fs,
      reparseProbe(paths) {
        assert.equal(paths.some(candidate => String(candidate).toLowerCase().startsWith(foreignRoot.toLowerCase())), false)
        return paths.map(() => 0)
      },
      profileAliasProbe: () => [fixture.profile],
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'scratch_outside_account')
    assert.equal(fixture.touched.some(candidate => candidate.toLowerCase().startsWith(foreignRoot.toLowerCase())), false)
    assert.equal(fs.existsSync(fixture.target), false)
  } finally { fixture.close() }
})

test('credential staging rejects linked or reparse-tagged auth without copying or leaking path and secret', () => {
  const fixture = credentialFixture()
  const secret = 'symlink-target-secret'
  const outside = path.join(fixture.home, 'outside-auth.json')
  try {
    fs.writeFileSync(outside, secret)
    let injectedReparse = null
    try { fs.symlinkSync(outside, fixture.source, 'file') }
    catch (error) {
      if (error?.code === 'EPERM') {
        /* Standard Windows users may create junctions but not file symlinks.
           Exercise the same final-component refusal through the generic
           reparse probe instead of weakening this test into a skip. */
        fs.writeFileSync(fixture.source, 'ordinary-placeholder')
        injectedReparse = paths => paths.map(candidate => candidate === fixture.source ? 1 : 0)
      } else {
        throw error
      }
    }
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(injectedReparse ? { reparseProbe: injectedReparse } : {}),
    }), error => {
      assert.equal(error?.code, 'A11Y_CODEX_AUTH_STAGE_REFUSED')
      assert.equal(error?.reason, 'source_reparse')
      assert.doesNotMatch(error.message, new RegExp(secret))
      assert.equal(error.message.includes(fixture.root), false)
      return true
    })
    assert.equal(fs.existsSync(fixture.target), false)
  } finally {
    fixture.close()
  }
})

test('credential staging rejects a junctioned Codex home before probing its child', t => {
  const fixture = credentialFixture()
  const realCodexHome = path.join(fixture.home, 'real-codex-home')
  const requested = path.join(fixture.home, '.codex')
  const secret = 'junction-target-secret'
  try {
    fs.rmSync(requested, { recursive: true, force: true })
    fs.mkdirSync(realCodexHome, { recursive: true })
    fs.writeFileSync(path.join(realCodexHome, 'auth.json'), secret)
    try { fs.symlinkSync(realCodexHome, requested, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) {
      if (error?.code === 'EPERM') { t.skip('junction creation is unavailable on this host'); return }
      throw error
    }
    assert.throws(() => seedCurrentCodexCredential(requested, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'source_reparse')
    assert.equal(fs.existsSync(fixture.target), false)
  } finally {
    fixture.close()
  }
})

test('Windows generic reparse probing is complete and fails closed before copy', () => {
  const fixture = credentialFixture()
  try {
    fs.writeFileSync(fixture.source, 'generic-reparse-secret')
    const visited = []
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: 'win32',
      reparseProbe(paths) {
        visited.push([...paths])
        const reparseAt = Math.max(0, paths.length - 2)
        return paths.slice(0, reparseAt + 1).map((_, index) => index === reparseAt ? 1 : 0)
      },
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'source_reparse')
    assert.equal(visited.length, 1)
    assert.equal(fs.existsSync(fixture.target), false)

    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: 'win32',
      reparseProbe: () => [0],
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'reparse_probe_unavailable')
  } finally {
    fixture.close()
  }
})

test('credential staging rejects hard-linked or preexisting auth targets and never overwrites them', () => {
  const fixture = credentialFixture()
  const sourceOrigin = path.join(fixture.home, 'source-origin.json')
  try {
    fs.writeFileSync(sourceOrigin, 'hard-link-secret')
    fs.linkSync(sourceOrigin, fixture.source)
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(process.platform === 'win32' ? { reparseProbe: zeroWindowsReparseProbe } : {}),
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'source_not_regular')

    fs.rmSync(fixture.source)
    fs.writeFileSync(fixture.source, 'ordinary-secret')
    fs.writeFileSync(fixture.target, 'do-not-overwrite')
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(process.platform === 'win32' ? { reparseProbe: zeroWindowsReparseProbe } : {}),
    }), error => error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED' && error?.reason === 'target_exists')
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), 'do-not-overwrite')
  } finally {
    fixture.close()
  }
})

test('credential staging cleans a partial or post-copy failure with secret-safe errors', () => {
  const fixture = credentialFixture()
  const secret = 'partial-copy-secret'
  try {
    fs.writeFileSync(fixture.source, secret)
    assert.throws(() => seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(process.platform === 'win32' ? { reparseProbe: zeroWindowsReparseProbe } : {}),
      afterCopy() { throw new Error(`native failure ${secret} ${fixture.root}`) },
    }), error => {
      assert.equal(error?.code, 'A11Y_CODEX_AUTH_STAGE_REFUSED')
      assert.equal(error?.reason, 'copy_failed')
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes(fixture.root), false)
      return true
    })
    assert.equal(fs.existsSync(fixture.target), false)
  } finally {
    fixture.close()
  }
})

test('credential cleanup recovers a renamed staged secret without probing or removing a replacement-junction child', async () => {
  const fixture = credentialFixture()
  const external = path.join(fixture.home, 'external-codex-home')
  const externalAuth = path.join(external, 'auth.json')
  const externalSecret = 'external-auth-must-survive'
  try {
    fs.writeFileSync(fixture.source, 'staged-copy')
    const staged = seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
    })
    const renamedCodexHome = path.join(path.dirname(fixture.scratchCodexHome), '.codex-old')
    const renamedCredential = path.join(renamedCodexHome, 'auth.json')
    fs.renameSync(fixture.scratchCodexHome, renamedCodexHome)
    fs.mkdirSync(external, { recursive: true })
    fs.writeFileSync(externalAuth, externalSecret)
    fs.symlinkSync(external, fixture.scratchCodexHome, process.platform === 'win32' ? 'junction' : 'dir')

    const probed = []
    const guardedFs = {
      ...fs,
      lstatSync(target, options) {
        probed.push(String(target))
        return fs.lstatSync(target, options)
      },
    }
    await removeStagedCodexCredential(staged, { fs: guardedFs, attempts: 1, pause: async () => {} })
    assert.equal(probed.includes(fixture.target), false, 'cleanup must stop at the replaced parent before lstat of auth.json')
    assert.equal(fs.readFileSync(externalAuth, 'utf8'), externalSecret)
    assert.equal(fs.existsSync(renamedCredential), false, 'the copied credential is removed by its recorded filesystem identity')
  } finally {
    fixture.close()
  }
})

test('canonical Windows profile aliases resolve safely through the injected filesystem on every host', async () => {
  const fixture = windowsCredentialFixture()
  const aliasScratch = fixture.alias + fixture.scratchCodexHome.slice(fixture.profile.length)
  try {
    fs.writeFileSync(fixture.source, 'alias-safe-secret')
    const staged = seedCurrentCodexCredential(fixture.codexHome, aliasScratch, {
      currentUserHome: fixture.home,
      platform: 'win32', pathApi: path.win32, fs: fixture.fs,
      reparseProbe: zeroWindowsReparseProbe,
      profileAliasProbe: () => [fixture.profile, fixture.alias],
    })
    assert.equal(staged.target, path.win32.join(aliasScratch, 'auth.json'))
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), 'alias-safe-secret')
    assert.ok(fixture.touched.some(candidate => candidate.startsWith(fixture.alias)), 'the alias must actually pass through the safety scan')
    await removeStagedCodexCredential(staged)
    assert.equal(fs.existsSync(fixture.target), false)
  } finally { fixture.close() }
})

test('credential cleanup retries transient deletion and fails closed on permanent retention', async () => {
  const fixture = credentialFixture()
  try {
    fs.writeFileSync(fixture.source, 'scratch-secret')
    const staged = seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(process.platform === 'win32' ? { reparseProbe: zeroWindowsReparseProbe } : {}),
    })
    let removes = 0
    const transientFs = {
      ...fs,
      rmSync(target, options) {
        removes += 1
        if (removes < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return fs.rmSync(target, options)
      },
    }
    await removeStagedCodexCredential(staged, { fs: transientFs, pause: async () => {} })
    assert.equal(removes, 3)
    assert.equal(fs.existsSync(fixture.target), false)

    const retained = seedCurrentCodexCredential(fixture.codexHome, fixture.scratchCodexHome, {
      currentUserHome: fixture.home,
      platform: process.platform,
      ...(process.platform === 'win32' ? { reparseProbe: zeroWindowsReparseProbe } : {}),
    })
    const permanentFs = { ...fs, rmSync() { throw Object.assign(new Error('native path detail'), { code: 'EBUSY' }) } }
    await assert.rejects(
      removeStagedCodexCredential(retained, { fs: permanentFs, attempts: 2, pause: async () => {} }),
      error => error?.code === 'A11Y_CODEX_AUTH_CLEANUP_FAILED' && error.message === 'A11Y_CODEX_AUTH_CLEANUP_FAILED')
  } finally {
    fixture.close()
  }
})
