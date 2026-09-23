import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { LAUNCH_TIERS, DISPATCH_TIERS } from '../../src/orchestration-controls.js'
import { tierChoicesFor, sessionModelChoices } from '../../src/fleet-tree-copy.js'

const require = createRequire(import.meta.url)
for (const provider of ['gemini', 'grok']) {
  test(`${provider} Research start reaches its loaded engine and its own confinement plan`, async t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-acp-host-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const root = path.join(directory, 'engine')
    cpSync(new URL('./fixtures/confined-engine/', import.meta.url), root, { recursive: true })
    const cwd = path.join(directory, 'work')
    mkdirSync(cwd)
    const modulePath = path.join(root, 'src/lib/agent-engine/acp-process.js')
    writeFileSync(modulePath, `const calls=[];
      async function startAcpSession(options) { calls.push(options); return {threadId:'acp-thread',adapter:{sendTurn:async()=>({turnId:'one'}),interrupt:async()=>{},answerApproval:()=>{},forkThread:async()=>({threadId:'fork'})},close(){}}; }
      module.exports={ROOT_ADMISSION_CONTRACT_VERSION:1,MODEL_SELECTION_CONTRACT_VERSION:1,calls,startAcpSession,resumeAcpSession:startAcpSession};`)
    const planner = require(path.join(root, 'src/lib/agent-session-confinement.js'))
    const plans = []
    planner.acpSessionPlan = options => {
      plans.push(options)
      return {ok:true,tier:'guided',isolated:true,agentApiMode:'Only',roleFunctionsOnly:true,
        threadOptions:{sandbox:'read-only',approvalPolicy:'never'},env:{},configDir:path.join(directory,provider),
        servers:['research'],acp:{provider},account:null}
    }
    const host = createAgentHost({enginePath:path.join(root,'src/lib/agent-engine/codex-process.js'),defaultCwd:cwd,
      providerCommandResolver:id=>path.join(directory,id), startProviderProbe:()=>provider, freeMemory:()=>64*1024**3})
    try {
      assert(host.startableTiers().tiers.includes(provider))
      assert(LAUNCH_TIERS.some(tier=>tier.id===provider))
      assert(!DISPATCH_TIERS.some(tier=>tier.id===provider), 'Research-only engines must not appear as detached launchers')
      const started = await host.startSession({sessionId:`${provider}-test`,tier:provider,acknowledgeLowMemory:true})
      assert.equal(started.threadId,'acp-thread')
      const [call] = require(modulePath).calls
      assert.equal(call.provider,provider)
      assert.equal(call.plan.acp.provider,provider)
      assert.equal(call.command,path.join(directory,provider))
      assert.equal(call.args,undefined,'no Codex app-server arguments')
      assert(plans.length>0&&plans.every(plan=>plan.provider===provider))
      const advertised = host.startableTiers().tiers
      const choices = tierChoicesFor(advertised)
      const tiers = LAUNCH_TIERS.filter(row => row.provider === provider && !row.client && row.cliModel)
      assert(tiers.length >= 2, 'the provider needs named model choices, not only Automatic')
      for (const tier of tiers) {
        assert(advertised.includes(tier.id))
        assert(!DISPATCH_TIERS.some(row => row.id === tier.id))
        assert.equal(choices.find(row => row.id === tier.id)?.enabled, true)
        assert(choices.find(row => row.id === tier.id)?.label.includes(tier.label))
        assert.equal(sessionModelChoices(tier.id).find(row => row.id === tier.id)?.enabled, false,
          'a model selected at startup must not be presented as a working mid-turn switch')
        await host.startSession({ sessionId: tier.id, tier: tier.id, effort: 'high' })
        const selected = require(modulePath).calls.at(-1)
        assert.equal(selected.provider, provider)
        assert.equal(selected.threadOptions.model, provider + '/' + tier.cliModel)
        assert.equal(selected.threadOptions.effort, 'high', 'explicit effort must reach its enforcing ACP engine')
        assert.equal(selected.threadOptions.sandbox, 'read-only')
        assert.equal(selected.threadOptions.approvalPolicy, 'never')
        assert.equal(selected.command, path.join(directory, provider))
        assert.equal(selected.args, undefined)
      }
      // Loading an ACP launcher that predates selection must never silently
      // interpret a named model as Automatic.
      require(modulePath).MODEL_SELECTION_CONTRACT_VERSION = undefined
      assert(host.startableTiers().tiers.includes(provider))
      for (const tier of tiers) {
        assert(!host.startableTiers().tiers.includes(tier.id))
        assert.throws(() => host.startSession({ sessionId: 'old-' + tier.id, tier: tier.id }),
          { code: 'AGENT_TIER_NO_LAUNCHER' })
      }
    } finally { await host.closeAll() }
  })
}

test('older payloads do not advertise Gemini or Grok launchers', async () => {
  const enginePath=fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js',import.meta.url))
  const host=createAgentHost({enginePath,defaultCwd:os.tmpdir(),freeMemory:()=>64*1024**3})
  try {
    const tiers=host.startableTiers().tiers
    assert(!tiers.includes('gemini'))
    assert(!tiers.includes('grok'))
    for(const tier of ['gemini','grok']) assert.throws(()=>host.startSession({sessionId:tier,tier}),{code:'AGENT_TIER_NO_LAUNCHER'})
  } finally {await host.closeAll()}
})


test('Research launch menus retain automatic aliases and name each explicit provider model', () => {
  assert.deepEqual(LAUNCH_TIERS.filter(row => ['gemini', 'grok'].includes(row.provider) && !row.client).map(row => [row.id, row.model, row.label]), [
    ['gemini', 'gemini/auto', 'Automatic'],
    ['gemini-3-1-pro', 'gemini/gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
    ['gemini-3-flash', 'gemini/gemini-3-flash-preview', 'Gemini 3 Flash Preview'],
    ['gemini-2-5-pro', 'gemini/gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-2-5-flash', 'gemini/gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['grok', 'grok/auto', 'Automatic'],
    ['grok-4-6', 'grok/grok-4.6', 'Grok 4.6'],
    ['grok-4-5', 'grok/grok-4.5', 'Grok 4.5'],
  ])
})


test('Antigravity named model routes to its own client/account and refuses a legacy Gemini account', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-agy-host-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'engine')
  cpSync(new URL('./fixtures/confined-engine/', import.meta.url), root, { recursive: true })
  const modulePath = path.join(root, 'src/lib/agent-engine/antigravity-cli-process.js')
  writeFileSync(modulePath, `const calls=[]; async function startAntigravitySession(options){calls.push(options);return{threadId:'agy-native-id',adapter:{sendTurn:async()=>({turnId:'one'}),interrupt:async()=>{},answerApproval(){}},close(){}}} module.exports={ROOT_ADMISSION_CONTRACT_VERSION:1,MODEL_SELECTION_CONTRACT_VERSION:1,calls,startAntigravitySession,resumeAntigravitySession:startAntigravitySession}`)
  const planner = require(path.join(root, 'src/lib/agent-session-confinement.js'))
  const plans = [], selections = [], commands = []
  planner.antigravitySessionPlan = options => {
    plans.push(options)
    return { ok:true, tier:'guided', isolated:true, agentApiMode:'Only', roleFunctionsOnly:true,
      threadOptions:{sandbox:'read-only',approvalPolicy:'never'},env:{},configDir:directory,servers:['toolsenabled-research'],antigravity:{contractVersion:1} }
  }
  let client = 'antigravity', blocked = null
  const host = createAgentHost({enginePath:path.join(root,'src/lib/agent-engine/codex-process.js'),defaultCwd:directory,
    accountResolver: request => { selections.push(request); return blocked || {rotated:true,account:{name:'native',provider:'gemini',client,resolvedHome:directory}} },
    providerCommandResolver:(provider, options)=>{commands.push({provider,...options});return path.join(directory,'agy')},
    startProviderProbe:()=> 'gemini',freeMemory:()=>64*1024**3})
  try {
    const tier='agy-gemini-3-8-flash-high'
    assert(host.startableTiers().tiers.includes(tier))
    const session=await host.startSession({sessionId:'native-agy',tier,
      requestKeys:{threadId:'agy-node',treeAnchors:['agy-node']},treeIdentity:{selfName:'Gemini clerk',managerName:null},
      accountRetry:{excludeAccounts:[],recheckAttempt:2}})
    assert.equal(session.threadId,'agy-native-id')
    assert(plans.every(plan=>plan.provider==='gemini'&&plan.client==='antigravity'))
    assert.equal(selections[0].client,'antigravity')
    assert.equal(selections[0].keepTryingAccounts,true)
    assert.equal(selections[0].recheckAttempt,2)
    assert.deepEqual(commands,[{provider:'gemini',client:'antigravity'}])
    assert.equal(require(modulePath).calls[0].threadOptions.model,'gemini/antigravity/gemini-3.8-flash-high')
    assert.equal(require(modulePath).calls[0].threadOptions.effort,'high')
    assert(require(modulePath).calls[0].plan.antigravity)
    assert.equal(require(modulePath).calls[0].args,undefined)
    client = null
    await assert.rejects(host.startSession({sessionId:'wrong-client',tier}),{code:'ACCOUNT_CLIENT_UNAVAILABLE'})
    assert.equal(require(modulePath).calls.length,1)
    blocked = { rotated: false, account: null, blocked: true, code: 'ACCOUNT_NONE_USABLE', reason: 'Registered account is temporarily unavailable.' }
    await assert.rejects(host.startSession({ sessionId: 'blocked-account', tier }),
      { code: 'ACCOUNT_NONE_USABLE', message: 'Registered account is temporarily unavailable.' })
    assert.equal(require(modulePath).calls.length, 1, 'a blocked account must not spawn a client or be misreported as a missing registration')
    const rows=LAUNCH_TIERS.filter(row=>row.client==='antigravity')
    assert.equal(rows.length,11)
    assert.equal(rows[0].label,'Gemini 3.8 Flash (High)')
    assert(rows.every(row=>row.treeOnly&&!DISPATCH_TIERS.includes(row)))
  } finally { await host.closeAll() }
})
