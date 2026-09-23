import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_JOURNEYS, executeDesktopJourney, executeDesktopJourneyFixture } from '../lib/drivers/desktop-journeys.mjs';
import { INSTALLED_LIFECYCLE_REQUIREMENTS } from '../lib/adapters/installed-lifecycle.mjs';
import { actionRowWords } from '../../src/fleet-tree-copy.js';
import { chatHeaderStatusCopy } from '../../src/chat-copy.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 1)]);
const PROFILE = path.win32.normalize(os.userInfo().homedir);
const HASH = sha('synthetic-toolsenabled-runtime');
const subject = () => ({ artifact: { sha256: HASH, bytes: 32 }, runtimeSha256: HASH, shellSha256: HASH });
const uuid = () => randomUUID();

function parseSpec(expression) {
  const start = String(expression).lastIndexOf('({');
  if (start < 0 || !String(expression).endsWith(')')) return null;
  return JSON.parse(String(expression).slice(start + 1, -1));
}
function node(partial) {
  return {
    text: '', value: '', tag: 'DIV', type: undefined, visible: true, disabled: false, editable: false,
    focused: undefined, classes: '', data: {}, ariaPressed: null, title: null, imageLoaded: undefined,
    point: { x: 10, y: 10 }, ...partial,
  };
}

function fixtureGuest({ tiers = null, proseOnly = false, autoFinish = false, omitEngine = false, mutateAttestation = value => value, mutateProvider = value => value, existingNode = false, delayedTool = false, circles = false, foldedActions = false, orphanDetail = false, synthetic = true, changingOrigin = false, delayedRoute = false } = {}) {
  const records = { launches: 0, stops: 0, quarantines: 0, capabilities: 0, provider: 0, outputs: 0, stages: 0, keys: [], starts: 0, sends: [], opened: [], unfolds: 0, verified: [] };
  const defaultTiers = [
    { value: 'astra', text: 'GPT-6-Astra', disabled: false },
    { value: 'agy-gemini-3-8-flash-high', text: 'Gemini', disabled: true },
  ];
  const tierOptions = tiers || defaultTiers;
  let session = 0, pid = 2000, href = 'http://127.0.0.1:41234/', phase = 'home';
  let filled = '', nodeId = null, chatOpen = false, selectedTier = tierOptions[0]?.value || '';
  let staged = null, turn = 0, actionState = '', halt = false, turnStatus = 'finished', lastSelector = '', toolReads = 0, routeReads = 0, folded = foldedActions;
  const userDataIdentity = 'synthetic-user-data-1';
  const electron = () => ({ pid: ++pid, startedAt: new Date(1700000000000 + pid * 1000).toISOString() });
  function rowsFor(spec) {
    if (spec.locationOnly) return { href, readyState: 'complete' };
    const sel = spec.selector, list = [];
    lastSelector = sel;
    const origin = `http://127.0.0.1:${41234 + (changingOrigin ? session : 0)}`;
    const visibleComputers = href.startsWith(origin + '/') && href.includes('#/computers');
    if (!visibleComputers && href.includes('#/computers')) return [];
    if (visibleComputers && delayedRoute && routeReads++ < 3) return [];
    if (sel === '.tree-chat-add' && visibleComputers && phase !== 'compose') {
      list.push(node({ tag: 'BUTTON', text: '+', name: 'New tree or agent' }));
    }
    if (sel === '.tree-new-tree' && phase === 'tree-picker') list.push(node({ tag: 'BUTTON', text: 'New tree' }));
    if (sel === '[data-compose-action="start"]' && phase === 'compose') list.push(node({ tag: 'BUTTON', text: 'Start' }));
    if (sel === '[data-compose-field="tier"]' && phase === 'compose') {
      list.push(node({ tag: 'SELECT', value: selectedTier, focused: spec.focused || false }));
    }
    if (sel === '[data-compose-field="tier"] option' && phase === 'compose') {
      for (const option of tierOptions) list.push(node({ tag: 'OPTION', text: option.text, value: option.value, disabled: option.disabled === true }));
    }
    if (sel === '[data-compose-field="role"] option' && phase === 'compose') {
      list.push(node({ tag: 'OPTION', text: 'Reviewer', value: 'reviewer' }));
    }
    if (sel === '[data-compose-field="message"]' && phase === 'compose') {
      list.push(node({ tag: 'TEXTAREA', editable: true, focused: spec.focused || false, value: filled }));
    }
    if (existingNode && sel === '.static-tree-node[data-agent-id]') list.push(node({ data: { agentId: 'existing-owner-node' } }));
    if (nodeId && sel === '.static-tree-node[data-agent-id]' ) list.push(node({ tag: 'DIV', classes: 'static-tree-node tree-agent-box', data: { agentId: nodeId } }));
    if (nodeId && sel === `.static-tree-node[data-agent-id="${nodeId}"]`) list.push(node({ tag: 'DIV', classes: 'static-tree-node tree-agent-box', data: { agentId: nodeId } }));
    if (!circles && nodeId && sel === `.static-tree-node[data-agent-id="${nodeId}"] .tree-box-chat`) {
      list.push(node({ tag: 'BUTTON', classes: 'tree-box-chat', text: '+' }));
    }
    if (chatOpen && nodeId && sel === `.tree-chat-tab[data-agent-id="${nodeId}"]`) list.push(node({ tag: 'BUTTON', text: 'Agent', data: { agentId: nodeId } }));
    if (chatOpen && nodeId && sel === `.tree-conversation[data-agent-id="${nodeId}"] .chat-input input`) {
      list.push(node({ tag: 'INPUT', editable: true, focused: spec.focused || false, value: filled }));
    }
    if (chatOpen && nodeId && sel === `.tree-conversation[data-agent-id="${nodeId}"] .chat-send`) list.push(node({ tag: 'BUTTON', text: 'Send' }));
    if (chatOpen && nodeId && sel === `.tree-conversation[data-agent-id="${nodeId}"] [data-chat-header-status]`) {
      list.push(node({ text: chatHeaderStatusCopy({ source: 'session-node-status', key: turnStatus }).text }));
    }
    const inChat = chatOpen && nodeId && (sel.includes(`.tree-conversation[data-agent-id="${nodeId}"]`));
    if (inChat && sel.endsWith('.chat-action-tool') && turn >= 1 && !proseOnly) list.push(node({ tag: 'SPAN', classes: 'chat-action-tool', text: 'Step' }));
    if (inChat && sel.endsWith('.chat-action-detail') && turn >= 1 && !proseOnly && staged && (!delayedTool || ++toolReads > 2)) list.push(node({ tag: 'SPAN', classes: 'chat-action-detail', text: staged.path, visible: !folded, actionTool: orphanDetail ? null : actionRowWords({ tool: 'host.read_file' }).tool }));
    if (inChat && folded && sel.endsWith('.chat-action-run:not([open]) > .chat-action-head')) list.push(node({ tag: 'SUMMARY', text: '2 tool calls' }));
    if (inChat && sel.endsWith('.chat-action-state') && turn >= 1 && !proseOnly) list.push(node({ tag: 'SPAN', classes: 'chat-action-state', text: actionRowWords({ state: actionState }).state }));
    if (inChat && sel.endsWith('[data-chat-chip="halt"]') && halt) list.push(node({ tag: 'BUTTON', text: 'Halt' }));
    if (proseOnly && inChat && sel.includes('.chat-context')) list.push(node({ tag: 'DETAILS', classes: 'chat-context', text: 'Product prompt context' }));
    if (spec.text !== undefined) return list.filter(row => row.text.trim() === spec.text);
    return list;
  }
  const guest = {
    mode: synthetic ? 'fixture' : 'attested-disposable-guest',
    async verifyObservation(value) { records.verified.push(value.kind); return value.kind !== 'provider-execution'; },
    async assertCapabilities() { records.capabilities += 1; return true; },
    async stageInput(binding) {
      records.stages += 1;
      const bytes = Buffer.from(binding.bytes);
      staged = { owned: true, path: `C:\\Users\\fixture\\AppData\\Local\\ToolsEnabled\\${binding.name}`, sha256: sha(bytes), bytes: bytes.length, _raw: bytes,
        runId: binding.runId, guestId: binding.guestId, phaseId: binding.phaseId, epochId: binding.epochId,
        journeyId: binding.journeyId, subjectSha256: binding.subjectSha256, product: binding.product, profile: binding.profile };
      return staged;
    },
    async launch(binding) {
      records.launches += 1; session += 1; href = `http://127.0.0.1:${41234 + (changingOrigin ? session : 0)}/`; phase = nodeId ? 'tree' : 'home'; chatOpen = false; halt = false; filled = ''; folded = foldedActions;
      const attestation = mutateAttestation({
        kind: 'runtime-launch', observationId: `launch-${session}`, runId: binding.runId, guestId: binding.guestId,
        phaseId: binding.phaseId, epochId: binding.epochId, journeyId: binding.journeyId, subjectSha256: binding.subjectSha256,
        product: binding.product, profile: binding.profile, sessionId: `session-${session}`, installed: true, exact: true,
        isolated: true, synthetic, sourceOverlay: false, hostRuntime: false, token: 'standard',
        artifact: binding.subject.artifact, runtimeSha256: binding.subject.runtimeSha256, shellSha256: binding.subject.shellSha256,
        process: electron(), userDataIdentity, origin: href.slice(0, -1),
      });
      return { id: `session-${session}`, attestation, cdp: {
        async send(method, params = {}) {
          if (method === 'Runtime.evaluate') {
            const spec = parseSpec(params.expression); if (!spec) throw new Error('unparsed probe');
            return { result: { value: rowsFor(spec) } };
          }
          if (method === 'Page.navigate') { href = params.url; if (String(params.url).includes('#/computers')) phase = nodeId ? 'tree' : (phase === 'compose' ? 'compose' : 'computers'); return {}; }
          if (method === 'Page.captureScreenshot') return { data: PNG.toString('base64') };
          if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
            records.keys.push(params.key);
            const enabled = tierOptions.filter(option => option.disabled !== true).map(option => option.value);
            if (params.key === 'Home') selectedTier = enabled[0] || selectedTier;
            if (params.key === 'ArrowDown') selectedTier = enabled[Math.min(enabled.length - 1, Math.max(0, enabled.indexOf(selectedTier) + 1))] || selectedTier;
          }
          if (method === 'Input.insertText') filled = params.text || '';
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
            if (lastSelector === '.tree-chat-add') phase = 'tree-picker';
            else if (lastSelector === '.tree-new-tree') phase = 'compose';
            else if (lastSelector === '[data-compose-action="start"]') {
              records.starts += 1; nodeId = 'agent-1'; phase = 'tree'; turn = 1; actionState = 'done'; turnStatus = 'finished'; filled = '';
            } else if (nodeId && (lastSelector.endsWith('.tree-box-chat') || (circles && params.clickCount === 2))) {
              chatOpen = true; records.opened.push(nodeId);
            } else if (lastSelector.endsWith('.chat-action-run:not([open]) > .chat-action-head')) {
              folded = false; records.unfolds += 1;
            } else if (lastSelector.endsWith('[data-chat-chip="halt"]') && halt) {
              actionState = 'undone'; turnStatus = 'interrupted'; halt = false;
            } else if (lastSelector.endsWith('.chat-send')) {
              records.sends.push(filled);
              if (filled.includes('again') && !autoFinish) { turn = 2; actionState = 'working'; turnStatus = 'running'; halt = true; }
              filled = '';
            }
          }
          return {};
        },
        on() { return () => {}; },
      } };
    },
    async stop(owned, binding) {
      records.stops += 1;
      return {
        kind: 'runtime-stop', observationId: `stop-${records.stops}`, runId: binding.runId, guestId: binding.guestId,
        phaseId: binding.phaseId, epochId: binding.epochId, journeyId: binding.journeyId, subjectSha256: binding.subjectSha256,
        product: binding.product, profile: binding.profile, sessionId: owned.id, synthetic,
        process: owned.attestation.process, terminationConfirmed: true, ownedChildrenConfirmed: true,
      };
    },
    async quarantine(binding) {
      records.quarantines += 1;
      return {
        kind: 'guest-quarantine', observationId: `quarantine-${records.quarantines}`, runId: binding.runId, guestId: binding.guestId,
        phaseId: binding.phaseId, epochId: binding.epochId, journeyId: binding.journeyId, subjectSha256: binding.subjectSha256,
        product: binding.product, profile: binding.profile, synthetic, quarantined: true,
      };
    },
    async collectProviderEvidence(current, binding) {
      records.provider += 1;
      return mutateProvider({
        kind: 'provider-execution', observationId: `provider-${records.provider}`, complete: true, synthetic,
        provider: 'codex', nodeId: binding.nodeId, desktopSessionId: binding.desktopSessionId, tool: binding.tool, path: binding.path, requestSha256: binding.requestSha256,
        outputSha256: staged?.sha256, runtimeSha256: HASH, shellSha256: HASH,
        executableSha256: HASH, responseSha256: HASH, reportSha256: HASH,
        engineProcess: omitEngine ? null : electron(),
        runId: binding.runId, guestId: binding.guestId, phaseId: binding.phaseId, epochId: binding.epochId,
        journeyId: binding.journeyId, subjectSha256: binding.subjectSha256, product: binding.product, profile: binding.profile,
      });
    },
    async readProductOutput(current, binding) {
      records.outputs += 1;
      const payload = Buffer.concat([Buffer.from('host.read_file '), Buffer.from(staged.path), Buffer.from('\n'), Buffer.from(staged._raw || '')]);
      return {
        owned: true, nodeId: binding.nodeId, bytes: payload, sha256: sha(payload), kind: binding.kind,
        runId: binding.runId, guestId: binding.guestId, phaseId: binding.phaseId, epochId: binding.epochId,
        journeyId: binding.journeyId, subjectSha256: binding.subjectSha256, product: binding.product, profile: binding.profile,
      };
    },
  };
  return { guest, records };
}

function epochFor(runId, guestId = 'synthetic-guest') {
  const epochId = uuid();
  return {
    kind: 'baseline-reset', observationId: `epoch-${epochId}`, runId, guestId, phaseId: 'fresh-install', epochId,
    journeyId: null, synthetic: true, baselineId: 'synthetic-baseline', restored: true, ownedJobsRemaining: 0,
    cleanUserData: true, accountProfile: PROFILE,
  };
}
function optionsFor(guest, overrides = {}) {
  const runId = uuid(), journeyId = uuid();
  return { product: 'toolsenabled', profile: 'windows-x64-standard', subject: subject(), runId, journeyId, epoch: epochFor(runId), guest,
    timeoutMs: 5000, operationTimeoutMs: 2000, cleanupTimeoutMs: 1000, ...overrides };
}
function passingJourney(runId, subjectSha256, extra = {}) {
  const assertions = DESKTOP_JOURNEYS.toolsenabled.assertions.map(id => ({ id, status: 'passed', evidenceSha256: HASH }));
  return { complete: true, cleanupConfirmed: true, fixture: false, scope: 'exact-installed-desktop-journey',
    product: 'toolsenabled', profile: 'windows-x64-standard', runId, subjectSha256, journeyId: uuid(),
    guestId: 'guest', epochId: uuid(), epoch: { observationId: uuid(), sha256: HASH }, assertions, ...extra };
}

test('DESKTOP_JOURNEYS names the ToolsEnabled assertions used by durable-critical-journey', () => {
  assert.deepEqual([...DESKTOP_JOURNEYS.toolsenabled.assertions], [
    'installed-ui-starts-shipped-engine', 'supported-provider-start-response-stop', 'result-persists-after-full-relaunch',
  ]);
});

test('fixture ToolsEnabled journey uses tier select, node chat tab, host.read_file and Halt on a later turn', async () => {
  const { guest, records } = fixtureGuest();
  const report = await executeDesktopJourneyFixture(optionsFor(guest));
  assert.equal(report.complete, true);
  assert.equal(report.cleanupConfirmed, true);
  assert.deepEqual(report.assertions.map(row => row.id), [...DESKTOP_JOURNEYS.toolsenabled.assertions]);
  assert.equal(records.launches, 2);
  assert.equal(records.provider, 1);
  assert.ok(records.keys.includes('Home'));
  assert.equal(records.stages, 1);
  assert.equal(records.starts, 1);
  assert.equal(records.sends.length, 1, 'only the later interruption turn is sent from chat');
});

test('slow first tool output does not queue the startup request again', async () => {
  const { guest, records } = fixtureGuest({ delayedTool: true });
  await executeDesktopJourneyFixture(optionsFor(guest));
  assert.equal(records.sends.length, 1);
  assert.match(records.sends[0], /again/);
});

test('an existing node cannot substitute for starting a new journey-owned provider', async () => {
  const { guest, records } = fixtureGuest({ existingNode: true });
  const report = await executeDesktopJourneyFixture(optionsFor(guest));
  assert.equal(report.complete, true);
  assert.equal(records.starts, 1);
  assert.deepEqual(records.opened, ['agent-1', 'agent-1']);
});

test('the native circle double-click opens the same durable conversation', async () => {
  const { guest, records } = fixtureGuest({ circles: true });
  await executeDesktopJourneyFixture(optionsFor(guest));
  assert.deepEqual(records.opened, ['agent-1', 'agent-1']);
});

test('host tool evidence must always be a bound raw provider observation', async () => {
  const { guest } = fixtureGuest({ mutateProvider: value => ({ ...value, kind: 'unsigned-summary' }) });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /provider-execution: missing, stale or mismatched/);
});

test('provider evidence from another node or launch cannot satisfy the current journey', async () => {
  for (const change of [{ nodeId: 'other-node' }, { desktopSessionId: 'other-desktop-launch' }]) {
    const { guest } = fixtureGuest({ mutateProvider: value => ({ ...value, ...change }) });
    await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /did not bind host.read_file/);
  }
});

test('completed folded tool runs are opened through their disclosure before accepting visible proof', async () => {
  const { guest, records } = fixtureGuest({ foldedActions: true });
  await executeDesktopJourneyFixture(optionsFor(guest));
  assert.equal(records.unfolds, 2, 'initial and restored runs are each opened');
});

test('a matching path without a tool in the same action row is not tool UI proof', async () => {
  const { guest } = fixtureGuest({ orphanDetail: true });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /host.read_file action/);
});

test('production dispatch rejects raw provider evidence when the trusted verifier refuses it', async () => {
  // This intentionally synthetic dispatch never returns a production success.
  // No guest, native process, provider or network exists in this unit test.
  const { guest, records } = fixtureGuest({ synthetic: false });
  const options = optionsFor(guest);
  options.epoch.synthetic = false;
  await assert.rejects(() => executeDesktopJourney(options), /provider-execution: trusted guest evidence verification failed/);
  assert.ok(records.verified.includes('provider-execution'));
});

test('relaunch follows the newly attested owned origin', async () => {
  const { guest } = fixtureGuest({ changingOrigin: true });
  const report = await executeDesktopJourneyFixture(optionsFor(guest));
  assert.notEqual(report.launches[0].attestation.origin, report.launches[1].attestation.origin);
});

test('the route must finish painting its actual controls before Start is attempted', async () => {
  const { guest } = fixtureGuest({ delayedRoute: true });
  assert.equal((await executeDesktopJourneyFixture(optionsFor(guest))).complete, true);
});

test('production export refuses a fixture guest', async () => {
  const { guest } = fixtureGuest();
  await assert.rejects(() => executeDesktopJourney(optionsFor(guest)), /attested disposable guest/);
});

test('role options are not provider selection; missing enabled tier refuses', async () => {
  const { guest } = fixtureGuest({ tiers: [{ value: 'agy-gemini-3-8-flash-high', text: 'Gemini', disabled: false }] });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /no enabled supported option|Gemini/);
});

test('prompt-context or prose-only rows cannot attest a host tool result', async () => {
  const { guest } = fixtureGuest({ proseOnly: true });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /host\.read_file action/);
});

test('natural completion without an interrupted later turn is not Stop', async () => {
  const { guest } = fixtureGuest({ autoFinish: true });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /later turn is actually running/);
});

test('missing shipped engine worker evidence is refused', async () => {
  const { guest } = fixtureGuest({ omitEngine: true });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /shipped engine worker/);
});

test('mismatched native runtime identity is refused', async () => {
  const { guest } = fixtureGuest({ mutateAttestation: value => ({ ...value, runtimeSha256: sha('other-runtime') }) });
  await assert.rejects(() => executeDesktopJourneyFixture(optionsFor(guest)), /ownership and exact-byte attestation/);
});

test('journeyAssertion binds every candidate journey to its own profile, phase and verified epoch', () => {
  const select = INSTALLED_LIFECYCLE_REQUIREMENTS['durable-critical-journey'].assertions['installed-ui-starts-shipped-engine'];
  const runId = uuid();
  const journeys = ['fresh-install', 'upgrade:baseline-0'].map(phaseId => ({
    id: `durable-critical-journey:${phaseId}`, journey: passingJourney(runId, HASH, { phaseId }),
  }));
  const base = {
    product: 'toolsenabled', profile: 'windows-x64-standard', scope: 'exact-installer-lifecycle', fixture: false, runId, subjectSha256: HASH,
    observations: journeys.map(({ journey }) => ({ kind: 'baseline-reset', phaseId: journey.phaseId, epochId: journey.epochId,
      observationId: journey.epoch.observationId, sha256: journey.epoch.sha256 })),
    scenarios: [{ id: 'fresh-install-and-documented-first-run' }, { id: 'upgrade:baseline-0' }, ...journeys],
  };
  assert.equal(select(base).length, 2);
  assert.throws(() => select({ ...base, product: 'scribe' }), /exact toolsenabled/);
  assert.throws(() => select({ ...base, fixture: true }), /exact toolsenabled/);
  assert.throws(() => select({ ...base, scenarios: base.scenarios.slice(0, -1) }), /executed journey for upgrade:baseline-0/);
  for (const change of [
    { subjectSha256: sha('baseline') }, { profile: 'windows-x64-administrator' }, { phaseId: 'fresh-install' },
    { journeyId: journeys[0].journey.journeyId }, { fixture: undefined },
  ]) {
    const copy = structuredClone(base);
    Object.assign(copy.scenarios.at(-1).journey, change);
    assert.throws(() => select(copy), /exact product, run and subject/);
  }
  for (const key of ['epochId', 'observationId', 'sha256']) {
    const copy = structuredClone(base);
    copy.observations.at(-1)[key] = key === 'sha256' ? sha('other-epoch') : uuid();
    assert.throws(() => select(copy), /verified baseline epoch/);
  }
});

test('advertised-integrations and update-delivery remain named refusals', () => {
  for (const id of ['advertised-integrations', 'update-delivery']) {
    const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
    assert.equal(definition.driver, null);
    assert.equal(Object.values(definition.assertions).every(select => select === null), true);
  }
});
