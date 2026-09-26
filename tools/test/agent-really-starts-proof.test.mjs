import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const localUrl = new URL('../agent-really-starts-qa.mjs', import.meta.url)
const local = readFileSync(localUrl, 'utf8')
const localJourney = readFileSync(new URL('../lib/local-agent-native-journey.mjs', import.meta.url), 'utf8')
const ui = readFileSync(new URL('../agent-start-flow-qa.mjs', import.meta.url), 'utf8')
const dispatch = readFileSync(new URL('../agent-dispatch-packaged-qa.mjs', import.meta.url), 'utf8')
const suite = readFileSync(new URL('../packaged-qa-suite.mjs', import.meta.url), 'utf8')
const liveSmoke = readFileSync(new URL('../agent-from-ui-smoke.cjs', import.meta.url), 'utf8')
const liveSmokeRunner = readFileSync(new URL('../run-agent-from-ui-smoke.cjs', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')

const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('the real Local journey requires explicit inference inputs and cannot claim a providerless start', () => {
  assert.match(local, /localQaOptions\(argv\)/)
  assert.match(local, /mode: STAGE_EXACT_RELEASE/)
  assert.match(local, /installerQualification: false/)
  assert.match(localJourney, /--run-local-inference/)
  assert.match(localJourney, /--local-model/)
  assert.doesNotMatch(codeOnly(local + localJourney), /startProviderFreeLocalRuntime|Object\.defineProperty\(window,\s*['"]mcAgent/)

  const result = spawnSync(process.execPath, [fileURLToPath(localUrl)], { encoding: 'utf8' })
  assert.equal(result.status, 3, 'default invocation must refuse before runtime metadata or inference')
  assert.match(result.stderr, /^CANNOT MEASURE: LOCAL_QA_PREREQUISITE: Pass --run-local-inference/m)
  assert.doesNotMatch(result.stdout, /PASS/)
})

test('the release registry keeps real Local inference opt-in and preserves the positive API gate', () => {
  assert.match(suite, /\['agent-really-starts-qa\.mjs',\s*\{\s*runner: 'node', timeoutMs: 1_200_000, costly: true,\s*artifactProof: 'exact-candidate',\s*\}\]/)
  assert.match(suite, /THE REQUIRED POSITIVE PROVIDER-FREE START GATE/)
  assert.match(suite, /\['agent-dispatch-packaged-qa\.mjs', \{ runner: 'node', timeoutMs: 300_000, artifactProof: 'instrumented-copy' \}\]/)
})

test('providerless UI QA never fakes the bridge or turns unavailability into a start', () => {
  const code = codeOnly(ui)
  assert.match(code, /waitForProviderlessPanel\(app\)/)
  assert.match(code, /filled\.submitted === false/)
  assert.match(code, /after\.starts === before\.starts/)
  assert.match(code, /launches\.bridge === 0 && launches\.agentHost === 0/)
  assert.doesNotMatch(code, /stubStartScript|__qaRealAgent|Object\.defineProperty\(window,\s*['"]mcAgent/)
  assert.doesNotMatch(code, /submit\.click\(\)/,
    'the providerless UI gate must not press Start and infer success from its refusal')
})

test('the required provider-free positive proof uses the built-in mission-bridge API and completion records', () => {
  assert.match(dispatch, /\/v1\/actions\/dispatch/)
  assert.match(dispatch, /startProviderFreeLocalRuntime\(payload\)/)
  assert.match(dispatch, /waitForProviderFreeCompletion\(localRuntime/)
  assert.match(dispatch, /launchRecords\(stateRoot\)/)
})

test('the provider-real API smoke reviews the exact desktop agent bridge surface', () => {
  const bridgeStart = preload.indexOf("exposeInMainWorld('mcAgent'")
  const bridgeEnd = preload.indexOf('}))', bridgeStart)
  assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, 'the desktop mcAgent exposure could not be isolated')
  const exposed = [...preload.slice(bridgeStart, bridgeEnd).matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)]
    .map(match => match[1])
    .sort()

  const reviewedStart = liveSmoke.indexOf('const RECOGNISED = [')
  const reviewedEnd = liveSmoke.indexOf('\n  ]', reviewedStart)
  assert.ok(reviewedStart >= 0 && reviewedEnd > reviewedStart, 'the smoke bridge allowlist could not be isolated')
  const reviewed = [...liveSmoke.slice(reviewedStart, reviewedEnd).matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)]
    .map(match => match[1])
    .sort()

  assert.deepEqual(reviewed, exposed,
    'the real launch smoke must refuse until every added or removed mcAgent method is reviewed')
})

test('the provider-real runner preserves account identity and isolates app state', () => {
  assert.match(liveSmokeRunner, /profileRootFromWindowsUserPath\(APP_ROOT\)/,
    'the authorized Windows owner must come from the checkout path, not ambient home variables')
  assert.match(liveSmokeRunner, /insideWindowsPath\(userData, ownerTemp\)/,
    'the one-shot application directory must remain under the checkout owner\'s Temp')
  assert.match(liveSmokeRunner, /providerAuthenticatedLaunchEnvironment\s*\(\s*\{/,
    'the real-provider proof must use the reviewed mixed account/isolation environment')
  assert.match(liveSmokeRunner, /accountHome:\s*runtimeOwner/,
    'the provider environment must retain the checkout owner as its account identity')
  assert.match(liveSmokeRunner, /scratchRoot:\s*path\.join\(userData, ['"]launch-environment['"]\)/,
    'APPDATA, LOCALAPPDATA and TEMP must be redirected under the one-shot userData directory')
  assert.match(liveSmokeRunner, /`--user-data-dir=\$\{userData\}`/,
    'application state must be isolated through Electron\'s real userData switch')
  assert.doesNotMatch(liveSmokeRunner, /sterileProfileDirectories\s*\(/,
    'invented account homes make the product account guard refuse before the API call')
})
