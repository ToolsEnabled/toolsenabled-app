// The permission-level question: does it get asked, and does it tell the truth?
//
// The owner named "logging in or creating a secure user account or setting up
// anything" as a failure condition, and the permission level is the one thing
// docs/design/INSTALLER-EXPERIENCE.md 2.1 says has to be decided first. It was
// fully specified, fully catalogued, and had never been built: the question
// existed only in tools/mcsetup.js, an interactive command-line program.
//
// These assertions cover the three ways this screen can be quietly wrong:
//
//   1. It is never shown, or is shown when it must not be. The gate decides
//      what a customer sees on the one launch they form an opinion on, and it
//      has to fail OPEN -- a build that cannot record a level must not trap
//      anyone behind a button guaranteed to fail.
//   2. Its words drift from the command line's. Two setup paths asking the
//      same question differently is two products.
//   3. The enforcement disclosure goes missing, or stops being AT the point of
//      choice. That notice is the whole reason this screen can honestly print
//      "cannot reach anything else on this computer" above it, and the one
//      approved disclosed limitation on this product. A screen that keeps the
//      sentence and drops the caveat is worse than no screen.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { register } from 'node:module'

import { readCapabilitySourceSetting } from '../lib/capability-source-git.mjs'

import {
  DEFAULT_TIER,
  SETUP_RESOLUTION,
  TIER_CHOICES,
  TIER_IDS,
  TIER_LIMIT_NOTICE,
  firstRunPending,
  readSetupState,
  shouldOpenSetup,
} from '../../src/setup-state.js'

/* Node does not know what to do with the view's three CSS side-effect imports.
   Ignore only CSS while loading the real view; all JavaScript still goes
   through Node's normal loader. */
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`)

const { setupView } = await import('../../src/views/setup.js')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

const VIEW = read('src/views/setup.js')
const ROUTER = read('src/main.js')
const MCSETUP = (() => {
  /* The command-line question lives in the configured private engine input.
     Never guess a sibling folder name: release inputs are explicit and the
     same customer-neutral setting drives the packer. */
  const configured = process.env.TOOLSENABLED_SOURCE
    || readCapabilitySourceSetting(REPO_ROOT)?.path
  if (!configured) return null
  try {
    return readFileSync(path.join(configured, 'tools', 'mcsetup.js'), 'utf8')
  } catch {
    return null
  }
})()

/* ---------- 1. the gate ---------- */

test('first launch opens on the question when nothing has been recorded', () => {
  const state = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, configured: false, tier: null } } })
  assert.equal(state.available, true)
  assert.equal(firstRunPending(state), true)
})

test('a recorded level ends the gate', () => {
  const state = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, configured: true, tier: 'standard' } } })
  assert.equal(state.tier, 'standard')
  assert.equal(firstRunPending(state), false)
})

/* FAILS OPEN. Each of these is a copy that CANNOT write a level. Gating on the
   question would leave the person with one button that always fails and no way
   past it -- a missing payload turned into an unusable app. */
test('the gate fails open where no level can be recorded', () => {
  const browser = readSetupState({})
  assert.equal(browser.available, false)
  assert.equal(browser.code, 'MC_SETUP_SHELL_ABSENT')
  assert.equal(firstRunPending(browser), false)

  const noPayload = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: false, code: 'SETUP_PAYLOAD_ABSENT', reason: 'no payload' } } })
  assert.equal(noPayload.available, false)
  assert.equal(firstRunPending(noPayload), false)
})

/* A record that exists and cannot be parsed is NOT "not set up yet". Reading it
   that way invites this screen to overwrite a configuration nobody could read,
   which is precisely what readMachineRecord refuses to do. */
test('an unreadable record is never reported as a fresh machine', () => {
  const state = readSetupState({
    mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, unreadable: true, code: 'SETUP_MACHINE_RECORD_MALFORMED', reason: 'malformed' } },
  })
  assert.equal(state.configured, false)
  assert.equal(state.available, false)
  assert.equal(state.code, 'SETUP_MACHINE_RECORD_MALFORMED')
  assert.equal(firstRunPending(state), false)
})

/* A `configured: true` carrying a tier this build does not know is a record
   from a different version. Trusting the flag alone would send someone into the
   app at a level nothing here can name. */
test('configured is not believed without a tier this build knows', () => {
  const state = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, configured: true, tier: 'omnipotent' } } })
  assert.equal(state.tier, null)
  assert.equal(state.configured, false)
  assert.equal(state.available, false)
  assert.equal(firstRunPending(state), false)
})

/* The gate's DECISION, run for real. src/main.js cannot be imported without a
   DOM, so an inline condition there could only ever be checked by matching
   source text -- and a source match cannot tell `if (pending)` from
   `if (false && pending)`. That exact plant was tried against an earlier
   version of this suite and passed, which is why the decision is a function. */
test('the gate sends a fresh machine to the question and nobody else', () => {
  const fresh = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, configured: false, tier: null } } })
  assert.equal(shouldOpenSetup(fresh, 'home'), true)
  assert.equal(shouldOpenSetup(fresh, 'metrics'), true)
  // already there: redirecting again would be an infinite hashchange loop
  assert.equal(shouldOpenSetup(fresh, 'setup'), false)

  const done = readSetupState({ mcSetup: { chooseTier() {}, bootstrap: { ok: true, available: true, configured: true, tier: 'guided' } } })
  assert.equal(shouldOpenSetup(done, 'home'), false)
  assert.equal(shouldOpenSetup(done, 'setup'), false)

  // fails open: a copy that cannot record a level must not be trapped
  assert.equal(shouldOpenSetup(readSetupState({}), 'home'), false)
})

test('the router mounts the setup route and gates on it', async () => {
  const { parseRoute } = await import('../../src/route-parse.js')
  assert.deepEqual(parseRoute('#/setup'), { name: 'setup' })
  assert.match(ROUTER, /import \{ parseRoute \} from '\.\/route-parse\.js'/)
  assert.match(ROUTER, /case 'setup': return setupView/, 'src/main.js never mounts the setup view')
  /* Deliberately exact. A looser match on the call alone still passes when the
     condition is negated or short-circuited -- measured, not assumed. */
  assert.match(
    ROUTER,
    /\n {2}if \(shouldOpenSetup\(SETUP_RESOLUTION, route\.name\)\) \{/,
    'src/main.js does not gate render() on shouldOpenSetup exactly; a short-circuited or negated guard is not a gate',
  )
  assert.match(ROUTER, /location\.hash = '#\/setup'/, 'src/main.js never redirects a first launch to the question')
})

/* A sendSync handler that returns without assigning event.returnValue does not
   refuse the renderer -- it blocks it forever. On this channel that is a window
   that paints nothing at all on first launch: a hang, no error, no screen. The
   handler is therefore a single assignment of a function that always returns an
   object, and this asserts that shape rather than trusting it, because the
   branch-per-outcome form it replaced was correct and still one careless early
   return away from a deadlock. */
test('the synchronous setup channel cannot fail to answer', () => {
  const SHELL = read('shell/main.cjs')
  const start = SHELL.indexOf("ipcMain.on('mc-setup:bootstrap'")
  assert.notEqual(start, -1, 'shell/main.cjs no longer registers mc-setup:bootstrap')
  const handler = SHELL.slice(start, SHELL.indexOf('\n', start))

  const assignments = handler.match(/event\.returnValue\s*=/g) || []
  assert.equal(assignments.length, 1, `the handler must assign event.returnValue exactly once, unconditionally; found ${assignments.length}`)
  assert.doesNotMatch(
    handler.replace(/returnValue/g, ''),
    /\breturn\b/,
    'the handler must contain no return statement -- an early return is how a sendSync handler deadlocks its renderer',
  )

  /* ...and the function it delegates to must answer on every branch. */
  const replyStart = SHELL.indexOf('function setupBootstrapReply(')
  assert.notEqual(replyStart, -1, 'the reply is no longer computed by a function that always answers')
  const reply = SHELL.slice(replyStart, SHELL.indexOf('\nipcMain.on(', replyStart))
  assert.ok((reply.match(/\breturn\b/g) || []).length >= 4, 'every branch of setupBootstrapReply must return a value')
  assert.match(reply, /catch \(error\)/, 'a throw must become a reply, not an unassigned returnValue')
})

/* The renderer half of the same failure: whatever crosses the wire, including
   nothing at all, must resolve to a state the gate can read. */
test('garbage or silence from the shell fails open rather than crashing the gate', () => {
  for (const bootstrap of [undefined, null, 'not an object', 42, []]) {
    const state = readSetupState({ mcSetup: { chooseTier() {}, bootstrap } })
    assert.equal(state.available, false, `bootstrap ${JSON.stringify(bootstrap)} was not treated as unusable`)
    assert.equal(firstRunPending(state), false)
    assert.equal(shouldOpenSetup(state, 'home'), false)
  }
})

/* ---------- 2. the words ---------- */

test('the three levels are the three the command line offers, in order', () => {
  assert.deepEqual(TIER_IDS, ['guided', 'standard', 'unrestricted'])
  // preselected first, so the least confident reader can proceed by not deciding
  assert.equal(DEFAULT_TIER, 'standard')
  assert.ok(TIER_IDS.includes(DEFAULT_TIER))
})

test('every level says what happens to the computer', { skip: MCSETUP ? false : 'configured engine source is unavailable' }, () => {
  for (const choice of TIER_CHOICES) {
    /* Compared with straight quotes because the command line prints ASCII and
       this screen sets typographic ones; the SENTENCE has to match, not the
       apostrophe. */
    const plain = choice.detail.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    assert.ok(
      MCSETUP.includes(plain),
      `the screen describes "${choice.tier}" in words tools/mcsetup.js does not use; two setup paths asking one question differently is two products`,
    )
  }
})

test('the screen renders the levels through the settings surface, not a new one', () => {
  assert.match(VIEW, /seg settings-seg/, 'the choice does not use the seg control section 2.1 names')
  assert.match(VIEW, /class="settings-row setup-choice"/, 'the options are not settings rows')
  assert.match(VIEW, /class="ctl-btn"/, 'the button is not the house button')
})

/* ---------- 3. the disclosure, AT the point of choice ---------- */

/* The claim moved because the fact moved. T5 landed: a session ToolsEnabled
   starts is confined by the recorded level, measured from a real packaged build
   -- `guided` had its shell command refused ("rejected: blocked by policy", file
   not created) where `unrestricted` performed the same write and exited 0.
   Keeping "that enforcement is not built yet" would now be false, and a product
   understating its own safety is still describing itself wrongly.

   What must NOT come back is the old text. These assertions therefore pin both
   directions: the stale admission is gone, AND the limit that genuinely remains
   is still stated. A future edit that quietly restores "not built yet", or one
   that drops the outside-program caveat to make the screen read better, both
   turn this red. */
test('the disclosure separates requested write policy from broader possible reads', () => {
  const notice = TIER_LIMIT_NOTICE.join(' ')
  assert.match(notice, /available ToolsEnabled tools.*requested write policy/)
  assert.match(notice, /Guided requests read-only.*Standard can request writes.*temporary folders/)
  assert.match(notice, /tools and roles can narrow this further/)
  assert.match(notice, /can still read files elsewhere/)
  assert.doesNotMatch(notice, /cannot reach anything else/)
  assert.doesNotMatch(notice, /not built yet/, 'the enforcement is built; the old admission is now false')
  assert.doesNotMatch(notice, /does not yet confine/, 'the enforcement is built; the old admission is now false')
})

/* The one limit that remains, and the owner's own instruction about it:
   "restrictive tiers absolutely should work ... maybe we have to hand the user a
   warning when adding outside ide sessions". The line is who RUNS the process,
   not where the session came from: a session that keeps running in the other
   program is run by that program, and nothing chosen here reaches into it.
   Saying so at the point of choice is the difference between a limit and a
   surprise. */
test('the disclosure still admits the sessions it cannot confine', () => {
  const notice = TIER_LIMIT_NOTICE.join(' ')
  assert.match(notice, /keeps running in another program/)
  assert.match(notice, /still deciding what it may do/)
  /* Case-insensitive because this clause is now a SENTENCE of its own rather
     than a subordinate clause: the paragraph was two sentences of thirty-odd
     words on the screen where somebody decides how much of their computer to
     hand over, and it was split. The words are the same words; only the comma
     before "where" became a full stop, which capitalised the C. Pinning the
     lower-case C would be pinning the run-on, not the promise. */
  assert.match(notice, /choosing a level here does not reach/i)
})

/* THE OVER-BROAD FAILURE MODE, which the first version of this notice shipped
   with and which the lane building attach caught.

   "It cannot confine an assistant ToolsEnabled did not start" reads as the
   cautious claim and is false for two of the three attach modes. MEASURED: a
   thread created at danger-full-access, which had already written outside its
   own folder, was resumed inside a process started with sandbox 'read-only' and
   the identical write was denied by the OS; resumed at danger-full-access it
   succeeded. Taking a session over confines it.

   Overstating the gap is not the safe direction. It steers people away from the
   path that actually holds, which is the same harm as understating it. So this
   pins that the notice keeps promising confinement for a taken-over session --
   a future edit that flattens the two modes back into one blanket warning turns
   red here rather than quietly shipping. */
test('the disclosure does not overclaim the gap for sessions it does confine', () => {
  const notice = TIER_LIMIT_NOTICE.join(' ')
  /* The comma is the only difference: "...so it continues here, and this level
     applies...". Same clause, same promise; the paragraph around it was split
     into shorter sentences. */
  assert.match(notice, /started or resumed here receives.*requested permissions from that point/)
  assert.doesNotMatch(
    notice,
    /cannot confine an assistant ToolsEnabled did not start/,
    'taking a session over DOES confine it; the blanket claim is measurably false',
  )
  /* The peer's qualification, kept because it is the true half of the old
     sentence: a level chosen now bounds what happens next, not what already
     happened somewhere else. */
  /* "though not to what it already did elsewhere" became its own sentence,
     "It does not reach what that session already did somewhere else." The
     qualification is what is pinned, not the subordinate clause that carried
     it, so the pattern is written against the meaning. */
  assert.match(notice, /already did (elsewhere|somewhere else)/)
})

/* The clause "and setup shows you the set it wrote" is TRUE of the command
   line, which generates the configuration in the same run and prints it, and
   FALSE of this screen, which records the level and generates nothing. A
   disclosure that overclaims in its own reassuring half is not a disclosure. */
test('the disclosure does not claim this screen wrote a configuration', () => {
  const notice = TIER_LIMIT_NOTICE.join(' ')
  assert.doesNotMatch(notice, /shows you the set it wrote/)
  assert.doesNotMatch(VIEW, /shows you the set it wrote/)
})

/* AT the point of selection. The notice being somewhere in the bundle is not
   the requirement -- it has to be on this screen, beside the choice, in the
   pattern this app already uses for correctness data carrying a severity. */
test('the disclosure remains available between the choice and Continue', () => {
  assert.match(VIEW, /fleet-profile-status is-warn/, 'the disclosure does not use the house severity pattern')
  assert.match(VIEW, /TIER_LIMIT_NOTICE\.map/, 'the disclosure text is not rendered on this screen')

  /* Read the TEMPLATE, not the file. Offsets over the whole source measure the
     order the helpers happen to be declared in, which is not the order anything
     appears on screen -- an earlier version of this test passed on exactly that
     coincidence. markup() is the one function whose text is the page. */
  const start = VIEW.indexOf('function markup()')
  assert.notEqual(start, -1, 'src/views/setup.js no longer builds its page in markup()')
  const template = VIEW.slice(start, VIEW.indexOf('function paint()', start))

  const seg = template.indexOf('setup-choices')
  const disclosure = template.indexOf('${disclosureMarkup()}')
  const button = template.indexOf('data-setup-continue')
  assert.ok(seg !== -1, 'the page template renders no permission choices')
  assert.ok(disclosure !== -1, 'the page template renders no disclosure')
  assert.ok(button !== -1, 'the page template renders no continue button')
  assert.ok(
    seg < disclosure && disclosure < button,
    'the disclosure must sit between the choices and the button; buried after the button it is not at the point of selection',
  )
})

/* ---------- the choice actually leaves the screen ---------- */

/* Comparing the three options by clicking between them is reading, not
   deciding. Writing on every click would record levels nobody chose. */
test('clicking a level does not record it; Continue does', () => {
  const previousDocument = globalThis.document
  const previousSetup = globalThis.mcSetup
  const calls = []
  let click
  let html = ''
  const section = {
    set innerHTML(value) { html = value },
    get innerHTML() { return html },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener(type, listener) { if (type === 'click') click = listener },
    removeEventListener() {},
  }
  const root = { querySelector: selector => selector === '[data-setup-section]' ? section : null }
  globalThis.document = {
    createElement() {
      return {
        content: { firstElementChild: root },
        set innerHTML(_value) {},
      }
    },
  }
  globalThis.mcSetup = {
    chooseTier: async (tier, consent) => {
      calls.push({ tier, consent })
      return { ok: true, tier }
    },
    bootstrap: { ok: true, available: true, configured: false, tier: null },
  }
  Object.assign(SETUP_RESOLUTION, { available: true, configured: false, tier: null, code: null, reason: null })

  try {
    const view = setupView()
    const press = selector => click({ target: { closest: query => query === selector ? {
      dataset: selector === '[data-setup-tier]' ? { setupTier: 'standard' } : {},
    } : null } })

    press('[data-setup-tier]')
    assert.deepEqual(calls, [], 'selecting an option writes a configuration before the person has decided')

    press('[data-setup-continue]')
    return Promise.resolve().then(() => {
      assert.deepEqual(
        calls.map(({ tier }) => tier),
        ['standard'],
        'Continue does not record the level the person selected',
      )
      assert.equal(
        SETUP_RESOLUTION.tier,
        'standard',
        'a saved level does not update the gate, so the app would bounce back to the question',
      )
      view.destroy()
    })
  } finally {
    globalThis.document = previousDocument
    globalThis.mcSetup = previousSetup
  }
})


test('actual fresh Continue and Skip submit Standard; saved or uncertain access never becomes the recommendation', async () => {
  const names = ['document', 'mcSetup', 'mcSettings', 'mcProviders', 'localStorage', 'window', 'CustomEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const resolution = { ...SETUP_RESOLUTION };
  const { WRITE_ACTION_FLAGS } = await import('../../src/write-flags.js');
  try {
    const cases = [
      { configured: false, tier: null, control: '[data-setup-continue]', expected: 'standard' },
      { configured: false, tier: null, control: '[data-setup-skip-first]', expected: 'standard' },
      ...TIER_IDS.map(tier => ({ configured: true, tier, control: '[data-setup-continue]', expected: tier })),
      { configured: true, tier: 'future-tier', control: '[data-setup-continue]', expected: null },
      { configured: false, tier: null, unreadable: true, control: '[data-setup-skip-first]', expected: null },
    ];
    for (const [index, item] of cases.entries()) {
      let click, view;
      const calls = [], storage = new Map(), settings = [], navigation = [];
      const section = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [],
        addEventListener(type, listener) { if (type === 'click') click = listener }, removeEventListener() {} };
      const root = { querySelector: selector => selector === '[data-setup-section]' ? section : null };
      globalThis.document = { createElement: () => ({ content: { firstElementChild: root }, set innerHTML(_) {} }) };
      globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
      globalThis.window = { dispatchEvent() {} };
      globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail } };
      globalThis.mcSettings = { set: async (id, value) => { settings.push({ id, value }); return { ok: true } } };
      globalThis.mcProviders = { accountPolicy: async () => ({ ok: true }) };
      globalThis.mcSetup = { chooseTier: async (tier, consent) => { calls.push({ tier, consent }); return { ok: true, tier } },
        setEditorImportPolicy: async () => ({ ok: true }), bootstrap: { ok: true, available: true, ...item } };
      Object.assign(SETUP_RESOLUTION, readSetupState(globalThis));
      const module = await import(`../../src/views/setup.js?fresh-basic-control=${index}`);
      try {
        view = module.setupView({ navigate: target => navigation.push(target) });
        assert.deepEqual(calls, [], 'reading setup never changes access');
        if (!item.configured && item.expected) {
          const rows = [...section.innerHTML.matchAll(/<button\b[^>]*data-setup-tier="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)];
          assert.equal(rows.length, 3, 'the actual choice renderer exposes all three access rows');
          const selected = rows.filter(row => /aria-pressed="true"/.test(row[0])).map(row => row[1]);
          const recommended = rows.filter(row => /class="setup-badge">Recommended<\/span>/.test(row[0])).map(row => row[1]);
          assert.deepEqual(selected, [item.expected], 'fresh and saved selections keep their exact tier');
          assert.deepEqual(recommended, [DEFAULT_TIER], 'Recommended must label the actual Standard row');
          if (!item.configured) assert.deepEqual(recommended, selected, 'fresh selection and recommendation must agree');
        }
        click({ target: { closest: query => query === item.control ? {} : null } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls.map(row => row.tier), item.expected ? [item.expected] : [], JSON.stringify(item));
        if (item.control === '[data-setup-skip-first]' && item.expected) {
          assert.ok(navigation.includes('#/'), 'successful Skip enters the app: ' + section.innerHTML.slice(-1800));
          for (const flag of WRITE_ACTION_FLAGS) assert.equal(storage.get(`mc.write.${flag.id}`), 'enabled', flag.id);
          assert.ok(settings.some(row => row.id === 'agent.blocked_question' && row.value === 'Decide for itself'));
        }
      } finally { view?.destroy() }
    }
  } finally {
    Object.assign(SETUP_RESOLUTION, resolution);
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name);
      else globalThis[name] = previous[name];
    }
  }
});
