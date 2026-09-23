#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
/*
 * agents.test.js — regression matrix for agentColor()/COLORS, agents.js's
 * pure, deterministic name -> color mapping.
 *
 * This function is small but load-bearing for something outside its own
 * file: pass 39's security review of studio.js's unescaped style="..."
 * interpolation of agentColor()'s output concluded it was safe ONLY because
 * this function's return value is provably constrained to one of 4
 * hardcoded hex pairs, never influenced by the actual TEXT of `name` beyond
 * which of the 4 gets picked. That conclusion was correct at the time, but
 * nothing pins it down: a future change to agentColor() (a wider palette, a
 * name-derived color, a bug) could silently invalidate it with no signal.
 * This test locks the invariant in.
 *
 *     node agents.test.js
 */
const {
  agentColor,
  COLORS,
  Agents,
  AgentsManager,
  HARD_MAX_WORKERS,
  HARD_MAX_MEDIA_WORKERS,
  MAX_WORKERS,
  MAX_MEDIA_WORKERS,
  PROFILES,
  PROVIDER_MODELS,
  PROVIDER_NAMES,
  PROFILE_NAMES,
  LEAD_PROMPT,
  WORKER_PROMPT,
  CODEX_LEAD_PROMPT,
  CODEX_WORKER_PROMPT,
  CLAUDE_FULL_ACCESS_LEAD_PROMPT,
  CLAUDE_FULL_ACCESS_WORKER_PROMPT,
  PROJECT_SCOPE,
  agentIdentityError,
  agentPoolForName,
  classifyTaskPool,
  codexRequestForProfile,
  claudeSpawnArgs,
  claudeRolePrompt,
} = require('./agents.js');
const Codex = require('./codex-agent.js');

// COLORS entries use the field name "chip" (agentColor()'s RETURN value is
// what renames it to "color"), mixing these up here would make this check
// silently vacuous, every real result would fail to match and the test
// would "catch" things that were never actually wrong. Verified this the
// hard way: an earlier draft used c.color here and every case failed,
// including plainly-correct ones like 'worker-1', not agentColor()'s fault.
const KNOWN_SAFE_PAIRS = new Set(COLORS.map((c) => `${c.chip}|${c.ink}|${c.key}`));
function isKnownSafePair(result) {
  if (result === null) return true;
  return KNOWN_SAFE_PAIRS.has(`${result.color}|${result.ink}|${result.key}`);
}

const cases = [
  { desc: 'null name returns null (no chip)', fn: () => agentColor(null) === null },
  { desc: 'undefined name returns null (no chip)', fn: () => agentColor(undefined) === null },
  { desc: "'josh' (a human) returns null", fn: () => agentColor('josh') === null },
  { desc: "'human' returns null", fn: () => agentColor('human') === null },
  { desc: "'studio' (pseudo-editor) returns null", fn: () => agentColor('studio') === null },
  { desc: "'dashboard' (pseudo-editor) returns null", fn: () => agentColor('dashboard') === null },
  { desc: "'' (empty string) returns null", fn: () => agentColor('') === null },
  { desc: "NON_AGENT matching is case-insensitive ('JOSH' also returns null)", fn: () => agentColor('JOSH') === null },
  { desc: "'lead' is pinned to COLORS[0]", fn: () => { const r = agentColor('lead'); return r && r.color === COLORS[0].chip && r.ink === COLORS[0].ink && r.key === COLORS[0].key; } },
  { desc: "'worker-1' is pinned to COLORS[1]", fn: () => { const r = agentColor('worker-1'); return r && r.color === COLORS[1].chip && r.key === COLORS[1].key; } },
  { desc: "'worker-2' is pinned to COLORS[2]", fn: () => { const r = agentColor('worker-2'); return r && r.color === COLORS[2].chip && r.key === COLORS[2].key; } },
  { desc: "'worker-3' is pinned to COLORS[3]", fn: () => { const r = agentColor('worker-3'); return r && r.color === COLORS[3].chip && r.key === COLORS[3].key; } },
  { desc: 'the same name always returns the same color (deterministic, not random)', fn: () => {
    const a = agentColor('some-random-agent-name');
    const b = agentColor('some-random-agent-name');
    return a.color === b.color && a.ink === b.ink && a.key === b.key;
  } },
  { desc: 'an unrecognized name still returns a full {color,ink,key} object, not a partial one', fn: () => {
    const r = agentColor('worker-99');
    return r && typeof r.color === 'string' && typeof r.ink === 'string' && typeof r.key === 'string';
  } },
];

// The security-relevant invariant, fuzzed across many adversarial-looking
// names: no matter what string comes in, the output is ALWAYS one of the 4
// known-safe hardcoded pairs (or null), and it must never THROW. Includes
// the exact style of payload pass 38 proved was exploitable when a
// DIFFERENT field (set-style's color) lacked this kind of constraint, plus
// every Object.prototype-inherited property name: this exact class of name
// (case-insensitively) crashed agentColor() for real before this pass, when
// the internal PINNED lookup was a plain object literal instead of a Map,
// {}['constructor'] resolves to the real Object constructor, not undefined.
// This list is a regression guard for that bug class, not a hypothetical.
const FUZZ_NAMES = [
  'worker-1', 'worker-2', 'worker-99', 'lead', 'a', '',
  'red" onmouseover="alert(1)', "'; DROP TABLE agents; --",
  '<script>alert(1)</script>', 'var(--evil)', '#000000; background: url(evil)',
  'x'.repeat(500), 'emoji-\u{1F525}-name', '\n\t\r', 'worker-1 '.trim() + ' ',
  'josh-but-not-quite', 'undefined', 'null',
  // Object.prototype's own properties: {}[any of these] resolves through
  // the prototype chain instead of returning undefined.
  'constructor', 'CONSTRUCTOR', 'toString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
];
cases.push({
  desc: `agentColor() never throws and always returns one of the 4 known-safe COLORS pairs (or null) across ${FUZZ_NAMES.length} adversarial-looking names, including every Object.prototype-inherited key`,
  fn: () => FUZZ_NAMES.every((n) => isKnownSafePair(agentColor(n))),
});

cases.push({
  desc: 'COLORS itself still has exactly 4 entries, each a plain #RRGGBB pair (the invariant this whole file protects)',
  fn: () => COLORS.length === 4 && COLORS.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c.chip) && /^#[0-9A-Fa-f]{6}$/.test(c.ink) && typeof c.key === 'string'),
});

cases.push({
  desc: 'provider registry preserves both switchable CLIs',
  fn: () => JSON.stringify(PROVIDER_NAMES) === JSON.stringify(['claude', 'codex']),
});
cases.push({
  desc: 'workhorse maps Sonnet to Terra and heavy maps Opus to Sol',
  fn: () => PROVIDER_MODELS.claude.workhorse === 'sonnet'
    && PROVIDER_MODELS.claude.heavy === 'opus'
    && PROVIDER_MODELS.codex.workhorse === 'gpt-5.6-terra'
    && PROVIDER_MODELS.codex.heavy === 'gpt-5.6-sol',
});

cases.push({
  desc: 'lower profiles keep their 1/2/12 general slots under the expanded 30-slot safety ceiling',
  fn: () => HARD_MAX_WORKERS === 30
    && PROFILES.low.maxWorkers === 1
    && PROFILES.low.maxMediaWorkers === 0
    && PROFILES.normal.maxWorkers === 2
    && PROFILES.normal.maxMediaWorkers === 0
    && PROFILES.extra.maxWorkers === 12
    && PROFILES.extra.maxMediaWorkers === 0
    && MAX_WORKERS <= HARD_MAX_WORKERS,
});
cases.push({
  desc: 'independent environment ceilings can lower either pool but cannot exceed 30/10 or become unbounded',
  fn: () => {
    const readCaps = (general, media) => {
      const result = require('child_process').spawnSync(
        process.execPath,
        ['-e', "const a=require('./agents.js');process.stdout.write(JSON.stringify([a.MAX_WORKERS,a.MAX_MEDIA_WORKERS]))"],
        {
          cwd: __dirname,
          encoding: 'utf8',
          env: Object.assign({}, process.env, {
            SUITE_MAX_WORKERS: general,
            SUITE_MAX_MEDIA_WORKERS: media,
          }),
        }
      );
      return result.status === 0 ? JSON.parse(result.stdout) : [NaN, NaN];
    };
    return JSON.stringify(readCaps('7', '4')) === JSON.stringify([7, 4])
      && JSON.stringify(readCaps('99', '99')) === JSON.stringify([30, 10])
      && JSON.stringify(readCaps('invalid', 'invalid')) === JSON.stringify([30, 10])
      && HARD_MAX_MEDIA_WORKERS === 10
      && MAX_MEDIA_WORKERS <= HARD_MAX_MEDIA_WORKERS;
  },
});
cases.push({
  desc: 'extra-profile manager capacity accepts the complete worker-1 through worker-12 identity set',
  fn: () => {
    const script = [
      "const {AgentsManager,agentIdentityError}=require('./agents.js');",
      "const manager=new AgentsManager();",
      "manager.configure({usageProfile:()=> 'extra'});",
      "process.stdout.write(JSON.stringify({cap:manager.maxWorkers,last:agentIdentityError('worker-12','worker',manager.maxWorkers),overflow:agentIdentityError('worker-13','worker',manager.maxWorkers)}));",
    ].join('');
    const result = require('child_process').spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { SUITE_MAX_WORKERS: '12' }),
    });
    if (result.status !== 0) return false;
    const parsed = JSON.parse(result.stdout);
    return parsed.cap === 12 && parsed.last === null && /outside the configured worker set/.test(parsed.overflow);
  },
});
cases.push({
  desc: 'beast keeps its 30+10 ultra full-access contract while the selected provider resolves the heavy model',
  fn: () => {
    const claude = new AgentsManager();
    claude.configure({
      usageProfile: () => 'beast',
      agentProvider: () => 'claude',
    });
    const codex = new AgentsManager();
    codex.configure({
      usageProfile: () => 'beast',
      agentProvider: () => 'codex',
    });
    return PROFILES.beast.maxWorkers === 30
      && PROFILES.beast.maxMediaWorkers === 10
      && PROFILES.beast.lead === 'heavy'
      && PROFILES.beast.worker === 'heavy'
      && PROFILES.beast.forcedProvider === null
      && PROFILES.beast.reasoningEffort === 'ultra'
      && PROFILES.beast.serviceTier === 'standard'
      && PROFILES.beast.fastMode === false
      && PROFILES.beast.fullAccess === true
      && JSON.stringify(claude.poolCaps) === JSON.stringify({ general: 30, media: 10, total: 40 })
      && JSON.stringify(codex.poolCaps) === JSON.stringify({ general: 30, media: 10, total: 40 })
      && claude.providerName === 'claude'
      && claude.modelFor('lead') === 'opus'
      && claude.modelFor('worker') === 'opus'
      && codex.providerName === 'codex'
      && codex.modelFor('lead') === 'gpt-5.6-sol'
      && codex.modelFor('worker') === 'gpt-5.6-sol'
      && [claude, codex].every((manager) => manager.reasoningEffort === 'ultra'
        && manager.serviceTier === 'standard'
        && manager.fastMode === false
        && manager.fullAccess === true);
  },
});
for (const profile of PROFILE_NAMES) {
  cases.push({
    desc: `Codex Fast override changes only the request lane under ${profile}`,
    fn: () => {
      const standard = new AgentsManager();
      standard.configure({
        usageProfile: () => profile,
        agentProvider: () => 'codex',
        fastMode: () => false,
      });
      const fast = new AgentsManager();
      fast.configure({
        usageProfile: () => profile,
        agentProvider: () => 'codex',
        fastMode: () => true,
      });
      return fast.fastModeRequested === true
        && standard.fastMode === false
        && fast.fastMode === true
        && standard.serviceTier === (PROFILES[profile].serviceTier || 'standard')
        && fast.serviceTier === 'fast'
        && standard.modelFor('lead') === fast.modelFor('lead')
        && standard.modelFor('worker') === fast.modelFor('worker')
        && standard.reasoningEffort === fast.reasoningEffort
        && standard.fullAccess === fast.fullAccess
        && JSON.stringify(standard.poolCaps) === JSON.stringify(fast.poolCaps);
    },
  });
}
cases.push({
  desc: 'a saved Fast preference stays unavailable and unapplied on Claude',
  fn: () => {
    const manager = new AgentsManager();
    manager.configure({
      usageProfile: () => 'beast',
      agentProvider: () => 'claude',
      fastMode: () => true,
    });
    return manager.fastModeRequested === true
      && manager.fastMode === false
      && manager.serviceTier === 'standard'
      && manager.modelFor('lead') === 'opus'
      && manager.modelFor('worker') === 'opus'
      && manager.reasoningEffort === 'ultra'
      && manager.fullAccess === true
      && JSON.stringify(manager.poolCaps) === JSON.stringify({ general: 30, media: 10, total: 40 });
  },
});
cases.push({
  desc: 'changing Fast affects the next spawn settings without rewriting a running agent',
  fn: () => {
    let enabled = false;
    const manager = new AgentsManager();
    manager.configure({
      usageProfile: () => 'beast',
      agentProvider: () => 'codex',
      fastMode: () => enabled,
    });
    const running = {
      name: 'worker-1', role: 'worker', provider: 'codex', model: 'gpt-5.6-sol',
      serviceTier: 'standard', fastMode: false, reasoningEffort: 'ultra', fullAccess: true,
      view: () => ({ name: 'worker-1', role: 'worker', provider: 'codex', model: 'gpt-5.6-sol' }),
    };
    manager.procs.set('worker-1', running);
    enabled = true;
    const view = manager.agentsView()[0];
    return manager.fastMode === true
      && manager.serviceTier === 'fast'
      && manager.procs.get('worker-1') === running
      && view.fastMode === false
      && view.serviceTier === 'standard';
  },
});
cases.push({
  desc: 'BEAST Claude spawn removes the guard and denylist while enabling all default tools at provider max effort',
  fn: () => {
    const args = claudeSpawnArgs({
      model: 'opus',
      systemPrompt: 'trusted',
      fullAccess: true,
      reasoningEffort: 'ultra',
    });
    const joined = args.join('\n');
    return /--permission-mode\nbypassPermissions/.test(joined)
      && /--tools\ndefault/.test(joined)
      && /--effort\nmax/.test(joined)
      && !/--settings/.test(joined)
      && !/--allowed-tools/.test(joined)
      && !/--disallowed-tools/.test(joined)
      && !/ppt-guard/.test(joined);
  },
});
cases.push({
  desc: 'lower-profile Claude spawn retains the fail-closed ppt guard, Bash allowlist, and mutation/subagent denylist',
  fn: () => {
    const args = claudeSpawnArgs({
      model: 'sonnet',
      systemPrompt: 'guarded',
      fullAccess: false,
      reasoningEffort: 'medium',
    });
    const joined = args.join('\n');
    return /--permission-mode\ndontAsk/.test(joined)
      && /--settings\n[^\n]*agent-settings\.json/.test(joined)
      && /--allowed-tools\nBash/.test(joined)
      && /--disallowed-tools\nTask\nAgent\nWrite\nEdit\nNotebookEdit\nPowerShell/.test(joined)
      && !/bypassPermissions/.test(joined)
      && !/--tools\ndefault/.test(joined);
  },
});
cases.push({
  desc: 'all five trusted prompt scopes derive portably from the live project root',
  fn: () => {
    const expected = path.resolve(__dirname, '..').replace(/\\/g, '/');
    const prompts = [
      CODEX_LEAD_PROMPT('lead', 2),
      CODEX_WORKER_PROMPT('worker-1', 2),
      CLAUDE_FULL_ACCESS_LEAD_PROMPT('lead', 2),
      CLAUDE_FULL_ACCESS_WORKER_PROMPT('worker-1', 2),
      Codex.FALLBACK_PROMPT('worker-1', 'worker'),
    ];
    const portableSources = ['agents.js', 'codex-agent.js'].every((name) =>
      !/[A-Za-z]:[\\/]Users[\\/]/i.test(fs.readFileSync(path.join(__dirname, name), 'utf8')));
    return PROJECT_SCOPE === expected
      && Codex.PROJECT_SCOPE === expected
      && prompts.every((prompt) => prompt.includes(`rooted at ${expected}`))
      && portableSources;
  },
});

cases.push({
  desc: 'Claude prompt routing changes capability language only for trusted full-access spawns',
  fn: () => {
    const fullLead = claudeRolePrompt({
      role: 'lead', name: 'lead', maxWorkers: 30, maxMediaWorkers: 10, fullAccess: true,
    });
    const fullWorker = claudeRolePrompt({
      role: 'worker', name: 'worker-1', maxWorkers: 30, maxMediaWorkers: 10, fullAccess: true,
    });
    const guarded = claudeRolePrompt({
      role: 'worker', name: 'worker-1', maxWorkers: 2, fullAccess: false,
    });
    return fullLead === CLAUDE_FULL_ACCESS_LEAD_PROMPT('lead', 30, 10)
      && fullWorker === CLAUDE_FULL_ACCESS_WORKER_PROMPT('worker-1', 30, 10)
      && [fullLead, fullWorker].every((prompt) => /fully enabled Claude Code/i.test(prompt)
        && /shell\/filesystem/i.test(prompt)
        && /live web/i.test(prompt)
        && /browser\/visual/i.test(prompt)
        && /image and video asset generation/i.test(prompt)
        && /apps\/plugins\/connectors\/MCP/i.test(prompt)
        && /Task\/Agent subagents/i.test(prompt)
        && /Never access or modify LLMBenchmarking/i.test(prompt)
        && /Scribe is read-only/i.test(prompt)
        && !/cannot edit files|ppt CLI ONLY/i.test(prompt))
      && /ppt CLI ONLY/i.test(guarded)
      && /cannot edit files directly, spawn subagents/i.test(guarded);
  },
});
cases.push({
  desc: 'general and media identity boundaries are enforced independently',
  fn: () => agentPoolForName('worker-30') === 'general'
    && agentPoolForName('media-10') === 'media'
    && agentIdentityError('worker-30', 'worker', 30, 10) === null
    && agentIdentityError('media-10', 'worker', 30, 10) === null
    && /outside the configured worker set/.test(agentIdentityError('worker-31', 'worker', 30, 10))
    && /outside the configured media worker set/.test(agentIdentityError('media-11', 'worker', 30, 10)),
});
cases.push({
  desc: 'media classification is explicit, deterministic, and ignores generic slide visuals and direct prohibitions',
  fn: () => [
    'Generate a PNG image for slide 1',
    'Edit the hero photograph and save it as hero.webp',
    'Create a short H.264 video clip',
    'Use image generation for a new illustration',
    'Prepare a new media asset for the title slide',
  ].every((text) => classifyTaskPool(text) === 'media')
    && [
      'Improve the visual hierarchy of slide 4',
      'Animate the native PowerPoint bars',
      'Do not add images or video, use existing shapes only',
      'Do not add an image or a video',
      'Avoid creating a video',
      'Without using the image, improve the title',
      'Update the social media KPI copy',
      'Keep current images unchanged; edit only title',
      'Render and inspect the slide thumbnail',
    ].every((text) => classifyTaskPool(text) === 'general')
    && classifyTaskPool('Generate a PNG image for slide 1') === classifyTaskPool('Generate a PNG image for slide 1'),
});
cases.push({
  desc: 'media routing fills specialist slots deterministically and falls back to the requested general worker only when all ten are busy',
  fn: () => {
    const manager = new AgentsManager();
    manager.configure({ usageProfile: () => 'beast', agentProvider: () => 'claude' });
    const initial = manager.routeTask('Generate a hero image', 'worker-4');
    for (let i = 1; i <= 10; i++) {
      manager.procs.set(`media-${i}`, {
        name: `media-${i}`, role: 'worker', pool: 'media', depth: 1,
      });
    }
    const fallback = manager.routeTask('Generate a hero image', 'worker-4');
    const general = manager.routeTask('Polish the title hierarchy', 'worker-4');
    const explicitMedia = manager.routeTask('Polish the title hierarchy', 'media-3');
    return initial.pool === 'media'
      && initial.assignee === 'media-1'
      && initial.fallback === false
      && fallback.classifiedPool === 'media'
      && fallback.pool === 'general'
      && fallback.assignee === 'worker-4'
      && fallback.fallback === true
      && /media pool busy/.test(fallback.reason)
      && general.pool === 'general'
      && general.assignee === 'worker-4'
      && explicitMedia.classifiedPool === 'general'
      && explicitMedia.pool === 'media'
      && explicitMedia.assignee === 'media-3'
      && /explicit media assignee/.test(explicitMedia.reason)
      && manager.workerCount('media') === 10
      && manager.workerCount('general') === 0;
  },
});
cases.push({
  desc: 'beast Codex request settings keep ultra/full access while leaving Fast disabled',
  fn: () => {
    const settings = PROFILES.beast;
    const thread = codexRequestForProfile('thread/start', {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        model_reasoning_effort: 'medium',
        features: { multi_agent: true },
        mcp_servers: { ppt: { env: { SUITE_AGENT_WORKER_CAP: '30' } } },
      },
      serviceTier: 'standard',
    }, settings);
    const turn = codexRequestForProfile('turn/start', {
      effort: 'medium',
      serviceTier: 'standard',
      approvalPolicy: 'on-request',
    }, settings);
    return thread.config.model_reasoning_effort === 'ultra'
      && thread.config.service_tier === undefined
      && thread.config.features.fast_mode !== true
      && thread.config.features.multi_agent === true
      && thread.config.web_search === 'live'
      && thread.config.features.shell_tool === true
      && thread.config.features.browser_use === true
      && thread.config.features.computer_use === true
      && thread.config.features.image_generation === true
      && thread.config.features.plugins === true
      && thread.config.mcp_servers.ppt.env.SUITE_AGENT_WORKER_CAP === '30'
      && thread.config.mcp_servers.ppt.env.SUITE_AGENT_MEDIA_WORKER_CAP === '10'
      && thread.serviceTier === 'standard'
      && thread.approvalPolicy === 'never'
      && thread.sandbox === 'danger-full-access'
      && turn.effort === 'ultra'
      && turn.serviceTier === 'standard'
      && turn.approvalPolicy === 'never';
  },
});
cases.push({
  desc: 'agent roster exposes frozen pool and execution settings for frontend/profile drift checks',
  fn: () => {
    const manager = new AgentsManager();
    manager.procs.set('media-1', {
      name: 'media-1',
      role: 'worker',
      pool: 'media',
      provider: 'codex',
      reasoningEffort: 'ultra',
      serviceTier: 'fast',
      fastMode: true,
      fullAccess: true,
      view: () => ({ name: 'media-1', role: 'worker', provider: 'codex', model: 'gpt-5.6-sol' }),
    });
    const view = manager.agentsView()[0];
    return view.pool === 'media'
      && view.reasoningEffort === 'ultra'
      && view.serviceTier === 'fast'
      && view.fastMode === true
      && view.fullAccess === true;
  },
});

for (const [provider, prompt] of [
  ['Claude', LEAD_PROMPT('lead', 12)],
  ['Codex', CODEX_LEAD_PROMPT('lead', 12)],
]) {
  cases.push({
    desc: `${provider} lead prompt scales dispatch guidance across the live 12-worker pool`,
    fn: () => /12 worker slots/i.test(prompt)
      && /worker-1 through worker-12/i.test(prompt)
      && /worker-12/i.test(prompt)
      && /distinct[\s\S]*idle worker/i.test(prompt)
      && /every slot is busy/i.test(prompt)
      && !/worker-13/i.test(prompt),
  });
}

cases.push({
  desc: 'BEAST prompts expose exactly worker-1 through worker-30 and media-1 through media-10',
  fn: () => {
    const leads = [
      CLAUDE_FULL_ACCESS_LEAD_PROMPT('lead', 30, 10),
      CODEX_LEAD_PROMPT('lead', 30, 10),
    ];
    const boundaryWorkers = [
      CLAUDE_FULL_ACCESS_WORKER_PROMPT('worker-30', 30, 10),
      CLAUDE_FULL_ACCESS_WORKER_PROMPT('media-10', 30, 10, 'media'),
      CODEX_WORKER_PROMPT('worker-30', 30, 10),
      CODEX_WORKER_PROMPT('media-10', 30, 10, 'media'),
    ];
    return leads.every((prompt) => /worker-1 through worker-30/i.test(prompt)
        && /media-1 through media-10/i.test(prompt)
        && !/worker-31/i.test(prompt)
        && !/media-11/i.test(prompt))
      && boundaryWorkers.every((prompt) => /worker-30|media-10/i.test(prompt))
      && boundaryWorkers.every((prompt) => /worker-1 through worker-30|media-1 through media-10/i.test(prompt));
  },
});

for (const [provider, prompt] of [
  ['Claude', WORKER_PROMPT('worker-test', 12)],
  ['Codex', CODEX_WORKER_PROMPT('worker-test', 12)],
]) {
  cases.push({
    desc: `${provider} worker prompt reflects the configured pool and makes recovered work idempotent`,
    fn: () => /12 configured worker slots/i.test(prompt)
      && /worker-1 through worker-12/i.test(prompt)
      && /recovered task retry/i.test(prompt)
      && /already present/i.test(prompt)
      && /without applying it again/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker prompt advertises the supported transition control`,
    fn: () => /set.transition/i.test(prompt)
      && /fade/i.test(prompt)
      && /none/i.test(prompt)
      && /click.only/i.test(prompt)
      && /no sound/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker prompt advertises native/imported generated media add/delete controls`,
    fn: () => (provider === 'Codex'
      ? /ppt_add_shape/i.test(prompt) && /ppt_delete_shape/i.test(prompt)
      : /add-shape/i.test(prompt) && /delete-decor/i.test(prompt))
      && /generated native\s+decor/i.test(prompt)
      && /imported.*suite-native|suite-native.*imported/i.test(prompt)
      && /behind native text/i.test(prompt)
      && /refuses imported\/backed decor/i.test(prompt)
      && (provider === 'Codex'
        ? /ppt_add_image/i.test(prompt) && /ppt_add_video/i.test(prompt)
        : /add-image/i.test(prompt) && /add-video/i.test(prompt))
      && /PNG, JPEG,\s+or GIF/i.test(prompt)
      && /H\.264 MP4/i.test(prompt)
      && /external link/i.test(prompt)
      && /rectangles, images, or videos/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker prompt advertises real object entrance builds`,
    fn: () => (provider === 'Codex'
      ? /ppt_set_animation/i.test(prompt)
      : /set-animation/i.test(prompt))
      && /appear, fade, wipe, or rise-up/i.test(prompt)
      && /click, with-previous,[\s\S]*or[\s\S]*after-previous/i.test(prompt)
      && /cannot target video/i.test(prompt)
      && /first build[\s\S]*start on click/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker prompt advertises strict imported box/card corner conversion`,
    fn: () => (provider === 'Codex'
      ? /ppt_set_corners/i.test(prompt)
      : /set-corners/i.test(prompt))
      && /eligible imported box\/card AutoShapes/i.test(prompt)
      && /true sharp corners/i.test(prompt)
      && /refuses (every|all) other object class/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker only closes a task after the requested work was applied and verified`,
    fn: () => /only after all requested work was actually applied and verified/i.test(prompt)
      && /verify every requested change/i.test(prompt),
  });
  cases.push({
    desc: `${provider} worker leaves blocked work open after noting it and unlocking`,
    fn: () => /blocked, unsupported, refused, or failed/i.test(prompt)
      && /note/i.test(prompt)
      && /unlock|release every lock/i.test(prompt)
      && /leave the task open for retry/i.test(prompt)
      && /do not/i.test(prompt),
  });
}
cases.push({
  desc: 'worker prompts contain no unconditional task-completion instruction',
  fn: () => !/ALWAYS finish by calling ppt_task_done/i.test(CODEX_WORKER_PROMPT('worker-test'))
    && !/Always do step 4/i.test(WORKER_PROMPT('worker-test')),
});

for (const [role, prompt] of [
  ['lead', CODEX_LEAD_PROMPT('lead', 2)],
  ['worker', CODEX_WORKER_PROMPT('worker-test')],
]) {
  cases.push({
    desc: `Codex ${role} prompt advertises the fully enabled tool surface`,
    fn: () => /shell/i.test(prompt)
      && /filesystem/i.test(prompt)
      && /live web|web search/i.test(prompt)
      && /browser/i.test(prompt)
      && /computer/i.test(prompt)
      && /image generation/i.test(prompt)
      && /apps/i.test(prompt)
      && /plugins/i.test(prompt)
      && /multi.agent|subagents?/i.test(prompt)
      && /browser\/computer host tools exposed in this thread/i.test(prompt)
      && !/NO shell|NO filesystem access|only capabilities are the ppt/i.test(prompt),
  });
  cases.push({
    desc: `Codex ${role} prompt confines work to the Presentation PDF project`,
    fn: () => /Presentation/i.test(prompt)
      && /PDF/i.test(prompt)
      && /project only|only.*project|scope.*project/i.test(prompt),
  });
  cases.push({
    desc: `Codex ${role} prompt forbids touching LLMBenchmarking`,
    fn: () => /never[^\r\n]*LLMBenchmarking|LLMBenchmarking[^\r\n]*never/i.test(prompt),
  });
  cases.push({
    desc: `Codex ${role} prompt makes scribe read-only`,
    fn: () => /scribe[^\r\n]*(?:read.only|only read|may be read[^\r\n]*never be modified)|(?:read.only|only read)[^\r\n]*scribe/i.test(prompt),
  });
  cases.push({
    desc: `Codex ${role} prompt prefers validated ppt mutations`,
    fn: () => /prefer[^\r\n]*ppt/i.test(prompt)
      && /validated/i.test(prompt)
      && /mutation|edit/i.test(prompt),
  });
}

cases.push({
  desc: 'provider health is cached for snapshots but an explicit refresh rechecks authentication',
  fn: () => {
    const originalResolve = Codex.resolveCodex;
    const originalLogin = Codex.codexLoginStatus;
    let checks = 0;
    try {
      Codex.resolveCodex = () => 'codex-test';
      Codex.codexLoginStatus = () => {
        checks++;
        return { ok: true, method: 'chatgpt', detail: 'test' };
      };
      Agents.invalidateProviderHealth('codex');
      const first = Agents.providerHealth('codex');
      const cached = Agents.providerHealth('codex');
      const refreshed = Agents.providerHealth('codex', { refresh: true });
      return first.ok && cached.ok && refreshed.ok && checks === 2;
    } finally {
      Codex.resolveCodex = originalResolve;
      Codex.codexLoginStatus = originalLogin;
      Agents.invalidateProviderHealth('codex');
    }
  },
});
for (const provider of PROVIDER_NAMES) {
  for (const profile of PROFILE_NAMES) {
    cases.push({
      desc: `${provider}/${profile} resolves concrete lead and worker models`,
      fn: () => {
        Agents.configure({ agentProvider: () => provider, usageProfile: () => profile });
        const definition = PROFILES[profile];
        const effectiveProvider = definition.forcedProvider || provider;
        const expected = {
          lead: PROVIDER_MODELS[effectiveProvider][definition.lead],
          worker: PROVIDER_MODELS[effectiveProvider][definition.worker],
        };
        return Agents.providerName === effectiveProvider
          && Agents.modelFor('lead') === expected.lead
          && Agents.modelFor('worker') === expected.worker;
      },
    });
  }
}

let pass = 0, fail = 0;
for (const c of cases) {
  let ok;
  try { ok = !!c.fn(); } catch (e) { ok = false; console.log(`   (threw: ${e.message})`); }
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${c.desc}`);
}

console.log('');
console.log(`${pass}/${cases.length} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
