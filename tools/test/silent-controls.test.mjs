import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionBridgeControl } from '../../src/agent-session.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = path => readFileSync(join(ROOT, path), 'utf8')

function rendererJavaScript(directory = join(ROOT, 'src')) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...rendererJavaScript(path))
    else if (extname(entry.name) === '.js') files.push(path)
  }
  return files
}

test('provider controls detect each verb before rendering and every unknown read speaks', () => {
  // The provider controls moved from the guide page into the Settings section (2026-09-10); same rules, new home.
  const source = read('src/this-computer-settings.js')
  for (const verb of ['loginStart', 'installStart', 'loginStop', 'accountAdd', 'accountRemove']) {
    assert.match(source, new RegExp(`typeof bridge\\?\\.${verb} === 'function'`), `${verb} has no render-time capability gate`)
  }
  assert.match(source, /disabled title="\$\{esc\([^)]*\.why\)\}"/, 'disabled provider controls do not carry their reason')
  assert.match(source, /function paintAccountsUnreadable\(root\)/, 'an unreadable account list is hidden instead of named')
  assert.match(source, /installed: 'unknown', signedIn: 'unknown'/, 'a failed presence read is being rounded to absence')
})

test('setup folder controls gate chooser and writer absence with visible reasons', () => {
  const setup = read('src/views/setup.js')
  assert.match(setup, /const chooserMissing = typeof globalThis\.mcSetup\?\.chooseWorkspace !== 'function'/)
  assert.match(setup, /chooserControl\.disabled \? ` disabled title="\$\{esc\(chooserControl\.why\)\}"`/)
  assert.match(setup, /typeof globalThis\.mcSetup\?\.recordWorkspaces !== 'function'[\s\S]*?MC_SETUP_WORKSPACE_UNAVAILABLE[\s\S]*?if \(!destroyed\) paint\(\)/)

  const settings = read('src/setup-profile-settings.js')
  assert.match(settings, /typeof globalThis\.mcSetup\?\.chooseWorkspace === 'function'[\s\S]*?typeof globalThis\.mcSetup\?\.recordWorkspaces === 'function'/)
  assert.match(settings, /workspaceControl\.disabled \? ` disabled title="\$\{esc\(workspaceControl\.why\)\}"`/)
  assert.match(settings, /title: 'The working folder was not changed'[\s\S]*?refresh\(\)/)
})

test('agent-session bridge and close refusals have render or action state', () => {
  const source = read('src/agent-session.js')
  /* THE SIX VERB SPELLINGS THAT USED TO BE PINNED HERE NOW LIVE IN
     tools/test/session-bridge-control.test.mjs, AS BEHAVIOUR.
     They required, literally, `typeof bridge.VERB === 'function'` six times --
     while the test twenty lines above demands the OPTIONAL-CHAINED spelling of
     the identical rule for views/guide.js. Two contradictory pins of one
     invariant, and both break against a correct rewrite. Measured 2026-08-24:
     re-expressing the gate as
       ['availability',…].every(verb => typeof bridge?.[verb] === 'function')
     -- same rule, cleaner -- left the behavioural test GREEN and turned these
     six RED. So they were charging a real price to protect nothing this file
     could not check better by calling the function. sessionBridgeControl is now
     exported and is asked with values: complete bridge, each verb missing in
     turn, each verb present-but-not-callable, no bridge at all, and every
     partial prefix. */
  /* THIS ASSERTION USED TO REQUIRE THE UNESCAPED SPELLING, AND SO FORBADE THE FIX.
   *
   * It pinned `title="${bridgeControl.why}"` byte for byte. Measured 2026-08-24:
   * of the 23 `title="${...}"` sites in src/, that was the ONLY one that did not
   * escape -- because agent-session.js carried no escaper at all, while the other
   * twenty-two use a local `esc` and org-controls.js uses `escapeMarkup`. Adding
   * the escape turned this red, so the test's effect was to hold the one
   * inconsistent site in place.
   *
   * Nothing was exploitable: `why` is BRIDGE_ABSENT, a fixed product constant.
   * But `controlState` is a shared helper, and the day a caller passes a reason
   * carrying a quote, an unescaped attribute closes early.
   *
   * So this now demands the escape rather than forbidding it, and checks the two
   * things that matter -- the control is disabled when the bridge is unusable,
   * and the reason travels with it escaped -- without pinning how the ternary is
   * spelled. */
  assert.match(source, /data-session-enable\$\{bridgeControl\.disabled \?[^}]*disabled title="\$\{esc\(bridgeControl\.why\)\}"/,
    'the disabled Start must carry its reason, and the reason must be escaped')
  assert.doesNotMatch(source, /title="\$\{bridgeControl\.why\}"/,
    'the reason is interpolated raw into an attribute; every other title in src/ escapes')
  const verbs = ['availability', 'start', 'send', 'onEvent', 'close', 'interrupt']
  const complete = Object.fromEntries(verbs.map(verb => [verb, () => {}]))
  const offered = sessionBridgeControl(complete)
  assert.equal(offered.enabled, true, 'a callable session bridge must offer the session control')
  assert.equal(offered.disabled, false, 'a callable session bridge must not disable the session control')
  for (const verb of verbs) {
    for (const unusable of [undefined, null, true, {}]) {
      const bridge = { ...complete, [verb]: unusable }
      const control = sessionBridgeControl(bridge)
      assert.equal(control.disabled, true, `${verb}=${String(unusable)} must disable the session control`)
      assert.ok(control.why, `${verb}=${String(unusable)} must give the disabled control a reason`)
    }
  }
  assert.match(source, /if \(!closed\.ok\) \{[\s\S]*?actionState\(status, 'refused'/)
})

test('role assignment stays visible and is disabled when its write verb is missing', () => {
  const view = read('src/views/computers.js')
  const mount = view.slice(view.indexOf('function mountRoleControl'), view.indexOf('function loadRailRuns'))
  assert.match(mount, /typeof bridgeAtRender\?\.assignRole !== 'function'/)
  assert.match(mount, /availability: roleAvailability/)
  assert.match(mount, /!bridge \|\| typeof bridge\.assignRole !== 'function'/)
  assert.doesNotMatch(mount, /slot\.remove\(\)/, 'bridge absence still silently removes the role control')

  const builder = read('src/org-controls.js')
  assert.match(builder, /data-role="apply"\$\{disabled \? ' disabled' : ''\}/)
  assert.match(builder, /failureSentence\(result, 'The role was not changed\.'\)/)
})

test('renderer IPC bridges contain no object-only optional member calls', () => {
  const unsafe = /(?:globalThis|window)\.mc[A-Za-z_$][\w$]*\?\.[A-Za-z_$][\w$]*\s*\(/g
  const matches = []
  for (const file of rendererJavaScript()) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(unsafe)) {
      const line = source.slice(0, match.index).split('\n').length
      matches.push(`${relative(ROOT, file)}:${line}:${match[0]}`)
    }
  }
  assert.deepEqual(matches, [], `object-only optional bridge calls remain:\n${matches.join('\n')}`)
})
