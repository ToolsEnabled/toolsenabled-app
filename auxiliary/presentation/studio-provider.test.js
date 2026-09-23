#!/usr/bin/env node
'use strict';
/*
 * Runs the real provider/profile/spend render functions from studio.js against
 * representative payloads. This avoids a browser and never touches the deck.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(__dirname, 'ppt.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`render marker missing: ${start}`);
  return source.slice(a, b);
}

const renderSource = [
  take('function esc(s) {', '\nasync function post'),
  take('function fmtUsd(n) {', '\n// ---- the usage profile control'),
  take('function modelsForProfile(info, name) {', '\n// Access is resolved'),
  take('const FULL_PROVIDER_ACCESS =', '\n// ---- one line, never a panel'),
  take('function spendHtml() {', '\n// Spend is the human'),
].join('\n');

function render(profileInfo, spendInfo) {
  return new Function(
    'profileInfo',
    'spendInfo',
    'fastModePosting',
    renderSource + '\nreturn { profile: profileHtml(), provider: providerHtml(), fast: fastModeHtml(), spend: spendHtml() };'
  )(profileInfo, spendInfo, false);
}

const base = {
  profile: 'normal',
  known: ['low', 'normal', 'extra', 'beast'],
  profiles: {
    low: { lead: 'workhorse', worker: 'workhorse', maxWorkers: 1, maxMediaWorkers: 0, boardNotes: 0, pct: 60 },
    normal: { lead: 'workhorse', worker: 'workhorse', maxWorkers: 2, maxMediaWorkers: 0, boardNotes: 5, pct: 100 },
    extra: { lead: 'workhorse', worker: 'heavy', maxWorkers: 12, maxMediaWorkers: 0, boardNotes: 5, pct: 150 },
    beast: {
      lead: 'heavy', worker: 'heavy', maxWorkers: 30, maxMediaWorkers: 10,
      boardNotes: 5, pct: 250, reasoningEffort: 'ultra',
      serviceTier: 'standard', fastMode: false, fullAccess: true,
      forcedProvider: null,
    },
  },
  provider: 'codex',
  providers: ['claude', 'codex'],
  providerModels: {
    claude: { workhorse: 'sonnet', heavy: 'opus' },
    codex: { workhorse: 'gpt-5.6-terra', heavy: 'gpt-5.6-sol' },
  },
  nextModels: { lead: 'gpt-5.6-terra', worker: 'gpt-5.6-terra' },
  providerHealth: {
    claude: { ok: true, detail: 'C:\\claude.exe' },
    codex: { ok: true, detail: 'C:\\codex.exe', auth: 'chatgpt' },
  },
  costMeasured: false,
  fastMode: {
    enabled: false, available: true, appliedToNextSpawn: false, pending: false,
    provider: 'codex', appliesTo: 'next spawn',
    reason: 'Fast is OFF for the next Codex spawn. Running agents keep the service they started with.',
  },
  running: [
    { name: 'lead', role: 'lead', model: 'gpt-5.6-terra', provider: 'codex' },
    { name: 'worker-1', role: 'worker', model: 'gpt-5.6-terra', provider: 'codex' },
  ],
};

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }
check('agent chips expose the general/media pool and optional Fast runtime details',
  source.includes('class="chip-pool')
    && source.includes('reasoning: ${a.reasoningEffort}')
    && source.includes('service: Fast')
    && source.includes('full trusted tools/files/web'));

const live = render(base, null);
check('live Terra agents do not make the profile look pending',
  !live.profile.includes(' pending') && !live.profile.includes('·next'));
check('profile choices render concrete Codex models, not tier names',
  live.profile.includes('gpt-5.6-terra') && live.profile.includes('gpt-5.6-sol')
    && !live.profile.includes('workhorse'));
check('extra profile tooltip renders the dynamic 12-worker capacity',
  live.profile.includes('12 general-agent slots plus 0 image/video slots'));
check('BEAST is a visible one-click profile with explicit two-pool capacity',
  live.profile.includes('data-profile="beast"')
    && live.profile.includes('>BEAST</button>')
    && live.profile.includes('30 general-agent slots plus 10 image/video slots'));
check('BEAST tooltip preserves Ultra and full trusted access while keeping Fast separate',
  live.profile.includes('gpt-5.6-sol')
    && live.profile.includes('Ultra reasoning, with full trusted tool/file/web access. Fast speed is controlled separately.')
    && !live.profile.includes('Forces the codex provider'));
check('Studio renders a one-line Fast OFF control with explicit next-spawn scope',
  live.fast.includes('data-fast-mode="true"')
    && live.fast.includes('>OFF</button>')
    && live.fast.includes('next spawn')
    && !live.fast.includes('not applied on Claude'));

const fastCodexInfo = JSON.parse(JSON.stringify(base));
fastCodexInfo.fastMode = {
  enabled: true, available: true, appliedToNextSpawn: true, pending: true,
  provider: 'codex', appliesTo: 'next spawn',
  reason: 'Fast is ON for the next Codex spawn. Running agents keep the service they started with.',
};
fastCodexInfo.running.forEach((agent) => { agent.fastMode = false; agent.serviceTier = 'standard'; });
const fastCodex = render(fastCodexInfo, null);
check('Studio Fast ON is visibly pending for already-running standard agents',
  fastCodex.fast.includes('fast-ctl pending')
    && fastCodex.fast.includes('data-fast-mode="false"')
    && fastCodex.fast.includes('class="active"')
    && fastCodex.fast.includes('·next')
    && fastCodex.fast.includes('pending · next spawn'));
check('an independent Fast change does not falsely mark the usage profile pending',
  !fastCodex.profile.includes('profile-ctl pending') && !fastCodex.profile.includes('·next'));

const fastClaudeInfo = JSON.parse(JSON.stringify(base));
fastClaudeInfo.provider = 'claude';
fastClaudeInfo.fastMode = {
  enabled: true, available: false, appliedToNextSpawn: false, pending: false,
  provider: 'claude', appliesTo: 'next spawn',
  reason: 'Fast is saved ON but is unavailable and not applied on Claude.',
};
const fastClaude = render(fastClaudeInfo, null);
check('Studio preserves the saved ON state under Claude without claiming acceleration',
  fastClaude.fast.includes('fast-ctl unavailable')
    && fastClaude.fast.includes('>ON</button>')
    && fastClaude.fast.includes('not applied on Claude · next Codex spawn')
    && !fastClaude.fast.includes('class="active"'));

const beastInfo = JSON.parse(JSON.stringify(base));
beastInfo.profile = 'beast';
beastInfo.nextModels = { lead: 'gpt-5.6-sol', worker: 'gpt-5.6-sol' };
beastInfo.nextExecution = {
  provider: 'codex',
  models: beastInfo.nextModels,
  reasoningEffort: 'ultra',
  serviceTier: 'standard',
  fastMode: false,
  fullAccess: true,
};
beastInfo.running = [];
const beast = render(beastInfo, null);
check('BEAST keeps both healthy providers selectable and resolves Codex to Sol',
  beast.provider.includes('data-provider="claude" title=')
    && beast.provider.includes('data-provider="codex" class="active"')
    && !beast.provider.includes('forces codex')
    && beast.provider.includes('gpt-5.6-sol'));

const beastClaudeInfo = JSON.parse(JSON.stringify(beastInfo));
beastClaudeInfo.provider = 'claude';
beastClaudeInfo.costMeasured = true;
beastClaudeInfo.nextModels = { lead: 'opus', worker: 'opus' };
beastClaudeInfo.nextExecution.provider = 'claude';
beastClaudeInfo.nextExecution.models = beastClaudeInfo.nextModels;
const beastClaude = render(beastClaudeInfo, null);
check('BEAST resolves Claude to Opus without downgrading the execution contract',
  beastClaude.provider.includes('data-provider="claude" class="active"')
    && beastClaude.provider.includes('data-provider="codex" title=')
    && beastClaude.provider.includes('opus')
    && beastClaude.provider.includes('Ultra reasoning at standard speed with full trusted access')
    && beastClaude.provider.includes('trusted full access: shell/filesystem, live web, browser/visual tools')
    && beastClaude.provider.includes('configured apps/plugins/connectors/MCP')
    && beastClaude.provider.includes('Task/Agent subagents')
    && !beastClaude.provider.includes('restricted to the ppt CLI'));

const normalClaudeInfo = JSON.parse(JSON.stringify(base));
normalClaudeInfo.provider = 'claude';
normalClaudeInfo.costMeasured = true;
normalClaudeInfo.nextModels = { lead: 'sonnet', worker: 'sonnet' };
normalClaudeInfo.running = [];
const normalClaude = render(normalClaudeInfo, null);
check('lower-profile Claude tooltip remains honest about the ppt-only guard',
  normalClaude.provider.includes('restricted to the ppt CLI by a tool hook')
    && !normalClaude.provider.includes('claude: trusted full access'));
check('the ppt provider CLI resolves Claude access from the active profile instead of repeating a provider-wide restriction',
  cliSource.includes("providerContainment(b.provider, b.provider === 'codex' || !!activeProfile.fullAccess)")
    && cliSource.includes("providerContainment(n, n === 'codex' || !!activeProfile.fullAccess)")
    && cliSource.includes('configured apps/plugins/connectors/MCP')
    && cliSource.includes('Task/Agent subagents'));
const cliProfileFormatter = cliSource.slice(
  cliSource.indexOf('function fmtProfile(p, models) {'),
  cliSource.indexOf('// Access is provider + profile dependent.')
);
check('profile CLI choices keep Fast independent and leave effective speed to the next-spawn line',
  cliProfileFormatter.includes('Fast controlled separately')
    && !cliProfileFormatter.includes('p.fastMode')
    && cliSource.includes("const mode = execution.fastMode")
    && cliSource.includes('Fast mode'));

const pendingInfo = JSON.parse(JSON.stringify(base));
pendingInfo.running = [
  { name: 'lead', role: 'lead', model: 'sonnet', provider: 'claude' },
  { name: 'worker-1', role: 'worker', model: 'sonnet', provider: 'claude' },
];
const pending = render(pendingInfo, null);
check('provider switch with old Claude agents is visibly pending',
  pending.provider.includes('provider-ctl pending') && pending.provider.includes('·next'));
check('pending tooltip names the actual old provider and model',
  pending.provider.includes('lead on claude sonnet'));

const pureSpend = {
  sinceTs: Date.now(),
  totalUsd: 0,
  turns: 6,
  tokens: { input: 84000, output: 12000, cacheRead: 300000, cacheWrite: 9000 },
  byModel: { 'gpt-5.6-terra': { usd: 0, turns: 6 } },
  rateLimit: null,
};
const pure = render(base, pureSpend).spend;
check('pure Codex spend renders measured tokens and no dollar amount',
  pure.includes('96.0k tok') && pure.includes('no $ figure') && !pure.includes('$0.00'));

const mixedSpend = {
  sinceTs: Date.now(),
  totalUsd: 0.8123,
  turns: 9,
  tokens: { input: 120400, output: 18300, cacheRead: 900200, cacheWrite: 44100 },
  byModel: {
    sonnet: { usd: 0.8123, turns: 5 },
    'gpt-5.6-terra': { usd: 0, turns: 4 },
  },
  rateLimit: null,
};
const mixed = render(pendingInfo, mixedSpend).spend;
check('mixed spend labels the unpriced Codex turns beside the priced total',
  mixed.includes('$0.81') && mixed.includes('4 unpriced'));

const unavailableInfo = JSON.parse(JSON.stringify(base));
unavailableInfo.provider = 'claude';
unavailableInfo.costMeasured = true;
unavailableInfo.nextModels = { lead: 'sonnet', worker: 'sonnet' };
unavailableInfo.running = [];
unavailableInfo.providerHealth.codex = { ok: false, detail: 'ChatGPT login required.' };
const unavailable = render(unavailableInfo, null).provider;
check('unavailable Codex remains explainable but non-live-looking',
  unavailable.includes('class="off"')
    && unavailable.includes('aria-disabled="true"')
    && unavailable.includes('ChatGPT login required.'));

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? '✓' : '✗ FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
