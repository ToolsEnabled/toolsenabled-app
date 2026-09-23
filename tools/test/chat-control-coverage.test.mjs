import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { deriveControls, extractEvidence, compareCoverage, run, stripComments } from '../check-chat-control-coverage.mjs'

const checker = path.resolve('tools/check-chat-control-coverage.mjs')
const limits = [
  'LIMITATION: Identifier-vs-class-string — a grep for a CSS class name undercounts real coverage that asserts against JS identifiers instead.',
  "LIMITATION: Dynamically-constructed identifiers — a selector or id built from a template literal has no single literal string a static scan can ever find. Assert against the template literal's source text to make a dynamic selector coverage-checkable.",
]
const production = (extra='') => `
export const CHAT_COMPOSER_INPUT_SELECTOR = '.chat-input input'
export const CHAT_APPROVAL_SELECTOR = Object.freeze({ accept: '[data-chat-approval="accept"]' })
export function markup(){ return \`<button data-chat-attach></button><button data-chat-chip="coverage-probe"></button>${extra}\` }
const b={setAttribute(){}}; b.setAttribute('data-chat-approval','accept')
`
const identities = Object.freeze({
  composer: 'src/components.js\tcomposer-selector\t.chat-input input',
  approval: 'src/components.js\tdata-control\t[data-chat-approval="accept"]',
  attach: 'src/components.js\tdata-control\t[data-chat-attach]',
  chip: 'src/components.js\tdata-control\t[data-chat-chip="coverage-probe"]',
})
const redFindings = Object.freeze([identities.composer, identities.approval, identities.chip])
const baseline = accepted => ({ $comment:'This file records reviewed uncovered controls by stable source identity and may only shrink.', note:'reviewed', accepted, updated:'2026-08-29T00:00:00.000Z' })
async function fixture({ source=production(), candidate=`assert.match(source, /data-chat-attach/); assert.match(source, /data-chat-chip="coverage-probe"/); assert.match(source, /.chat-input input/); assert.match(source, /data-chat-approval="accept"/)`, accepted=[] , canonical=true }={}) {
  const root=await mkdtemp(path.join(tmpdir(),'chat-coverage-')); await mkdir(path.join(root,'src'),{recursive:true}); await mkdir(path.join(root,'tools/test'),{recursive:true})
  await writeFile(path.join(root,'src/components.js'),source); await writeFile(path.join(root,'tools/test/product.test.mjs'),candidate)
  if(canonical) await writeFile(path.join(root,'tools/chat-control-coverage-baseline.json'),JSON.stringify(baseline(accepted)))
  return root
}
async function invoke(root, argv=[]) { let out='',err=''; const code=await run({repoRoot:root,argv,stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},now:()=>new Date('2026-08-29T01:02:03Z')}); return {code,out,err} }

test('inventory is source-derived, comment-safe, generic, and identity is line-stable',()=>{
  const commented=`// export const CHAT_COMPOSER_INPUT_SELECTOR='fake'\n/* <button data-chat-chip="comment-only"></button> */\n`
  const a=deriveControls(commented+production()), b=deriveControls(`\n\nconst unrelated=1\n`+commented+production())
  assert(a.some(c=>c.value==='[data-chat-chip="coverage-probe"]'),'hard-coded inventory would omit the production coverage-probe value')
  assert(!a.some(c=>c.value.includes('comment-only')),'raw-source derivation would include the comment-only owner')
  assert.deepEqual(a.map(c=>c.identity),b.map(c=>c.identity),'line-number identity would change after unrelated lines')
})

test('evidence excludes comments and requires a recognized valued form',()=>{
  const controls=deriveControls(production()), chip=controls.find(c=>c.value.includes('coverage-probe'))
  assert.equal(extractEvidence([chip],[{file:'tools/test/x.test.mjs',source:'// data-chat-chip="coverage-probe"\nconst x="data-chat-chip"'}]).length,0,'raw comments or a bare sibling name must not cover a valued control')
  assert.equal(extractEvidence([chip],[{file:'tools/test/x.test.mjs',source:'assert.match(source, /data-chat-chip=\\"coverage-probe\\"/)'}]).length,1,'an executable regex-escaped source assertion must provide evidence')
  assert.throws(()=>stripComments('/* never closes'),/unterminated/,'unterminated lexical state must not silently scan')
})

test('ratchet distinguishes unaccepted, accepted, and stale',()=>{
  const controls=deriveControls(production()), evidence=extractEvidence(controls,[{file:'x',source:'data-chat-attach'}]), finding=controls.find(c=>c.value.includes('coverage-probe')).identity
  assert(compareCoverage({controls,evidence,accepted:[]}).unaccepted.includes(finding),'implicitly accepting every finding would hide coverage-probe')
  const all=compareCoverage({controls,evidence,accepted:controls.filter(c=>!evidence.some(e=>e.identity===c.identity)).map(c=>c.identity).sort()}); assert.equal(all.unaccepted.length,0,'reviewed findings should be accepted')
  assert(compareCoverage({controls,evidence:[...evidence,{identity:finding}],accepted:all.findings}).stale.includes(finding),'silently discarding newly covered accepted entries would defeat the ratchet')
  assert.throws(()=>compareCoverage({controls,evidence,accepted:['z','a']}),/sorted/,'unsorted reviewed input must fail')
})

test('normal setup failures include absent/malformed/empty/zero candidates/blind extraction',async()=>{
  const absent=await fixture({canonical:false}); assert.equal((await invoke(absent)).code,2,'an absent canonical baseline must not green normally')
  const malformed=await fixture(); await writeFile(path.join(malformed,'tools/chat-control-coverage-baseline.json'),'{}'); assert.equal((await invoke(malformed)).code,2,'malformed canonical JSON must be setup failure')
  const empty=await fixture({source:' '}); assert.equal((await invoke(empty)).code,2,'empty production source must not be a clean inventory')
  const blind=await fixture({candidate:'const unrelated = true'}), blindResult=await invoke(blind); assert.equal(blindResult.code,2,'blind extraction must be a setup failure'); assert.match(blindResult.err,/extractor may have gone blind/,'an all-gap baseline must report why extraction failed')
  const zero=await fixture(); await import('node:fs/promises').then(fs=>fs.unlink(path.join(zero,'tools/test/product.test.mjs'))); assert.equal((await invoke(zero)).code,2,'zero candidates must not pass')
})

test('normal 0 and 1 print honest counts, identities, and both limitations',async()=>{
  const red=await fixture({candidate:'assert.match(source, /data-chat-attach/)'}); const rr=await invoke(red); assert.equal(rr.code,1,'unaccepted findings must return 1'); assert.deepEqual(rr.out.split(/\r?\n/).filter(line=>line.startsWith('UNACCEPTED: ')),redFindings.map(identity=>`UNACCEPTED: ${identity}`),'output must name every full unaccepted identity and no substitute')
  await writeFile(path.join(red,'tools/chat-control-coverage-baseline.json'),JSON.stringify(baseline(redFindings)))
  const green=await invoke(red); assert.equal(green.code,0,'fully reviewed current findings should return 0')
  for(const result of [rr,green]) for(const line of limits) assert(result.out.includes(line),'removing either mandatory limitation must fail every normal result')
})

test('--update writes only replaceable proposal, preserves canonical, and remains pending/1',async()=>{
  const root=await fixture({candidate:'assert.match(source, /data-chat-attach/)'}), canonicalPath=path.join(root,'tools/chat-control-coverage-baseline.json'), before=await readFile(canonicalPath)
  const first=await invoke(root,['--update']); assert.equal(first.code,1,'proposal writing must never return 0'); assert.deepEqual(await readFile(canonicalPath),before,'update must preserve canonical bytes')
  const proposal=JSON.parse(await readFile(path.join(root,'tools/chat-control-coverage-baseline.proposed.json'))); assert.deepEqual(Object.keys(proposal),['$comment','note','accepted','updated'],'proposal must have exactly the reviewed four-field shape'); assert.deepEqual(proposal.accepted,redFindings,'proposal must contain the exact nonempty, sorted findings')
  for(const line of limits) assert(first.out.includes(line),'update must retain both limitation lines')
  const absent=await fixture({canonical:false}); assert.equal((await invoke(absent,['--update'])).code,1,'absent canonical is permitted only for pending proposal'); await assert.rejects(access(path.join(absent,'tools/chat-control-coverage-baseline.json')),'update must leave absent canonical absent')
  const bad=await fixture(); await writeFile(path.join(bad,'tools/chat-control-coverage-baseline.json'),'{}'); assert.equal((await invoke(bad,['--update'])).code,2,'malformed canonical must not be updateable'); await assert.rejects(access(path.join(bad,'tools/chat-control-coverage-baseline.proposed.json')),'setup failure must write no proposal')
})

test('copied CLI preserves 0, 1, 2, and update/1 across shell-free process boundary',async()=>{
  for(const [name,setup,args,want] of [['green',{},[],0],['red',{candidate:'data-chat-attach'},[],1],['setup',{canonical:false},[],2],['update',{canonical:false},['--update'],1]]) {
    const root=await fixture(setup)
    await copyFile(checker,path.join(root,'tools/check-chat-control-coverage.mjs')); const child=spawnSync(process.execPath,[path.join(root,'tools/check-chat-control-coverage.mjs'),...args],{cwd:root,encoding:'utf8',shell:false})
    assert.equal(child.status,want,`${name} copied checker must preserve exit ${want}, not a helper-only result`)
  }
})

/* T288. THIS GATE HAS NEVER MEASURED THE PRODUCT.
 *
 * Every case above writes a synthetic src/components.js into a scratch root and
 * derives from that, so the suite has been green while deriveControls() threw
 * on the real file: "SETUP ERROR: dynamic data-chat setAttribute owner".
 * Measured at assembly base 234a2e8f and at every tip since. The gate was also
 * wired into no chain, so nothing ran it. A check that cannot run is not a
 * check that passed, and a suite that only ever sees its own fixture cannot
 * tell you that.
 *
 * This case derives from the REAL file. It is deliberately not parameterised
 * and not given a fixture: if it is ever made to pass against a stand-in
 * again, the thing it exists to catch is back. */

test('the gate derives from the real src/components.js, not only from fixtures', async () => {
  const source = await readFile(new URL('../../src/components.js', import.meta.url), 'utf8')
  const controls = deriveControls(source)
  assert.ok(controls.length > 20, `the real file should yield a real control set, got ${controls.length}`)
  const values = controls.map(control => control.value)
  /* Both dynamic owners must be represented, because they are the two that
     used to stop the derivation dead. */
  assert.ok(values.some(value => value.startsWith('[data-chat-activity')),
    'the activity owner must be derived, not refused')
  assert.ok(values.some(value => value.startsWith('[data-chat-approval')),
    'the approval owner must be derived, not refused')
})

/* THE TWO SURFACES MUST AGREE BY CONSTRUCTION, not by two lists kept in step.
   T286 gave the + agent the tree conversation's chat by handing computersView's
   own builder down to the standalone mount. This holds that seam: if the
   standalone surface ever grows a buildChat of its own, or computersView stops
   handing its builder down, the two surfaces can diverge again and a person
   gets a different chat depending on where the agent came from -- which is the
   whole of what the owner objected to. */

test('the + surface and the tree conversation take their chat from one builder', async () => {
  const mount = await readFile(new URL('../../src/tree-standalone-agent.js', import.meta.url), 'utf8')
  const view = await readFile(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

  assert.doesNotMatch(mount, /\bbuildChat\s*\(/,
    'the standalone surface must not build a chat of its own; it is served one')
  assert.match(mount, /chatConfigFor\s*\(\s*seat\s*\)/,
    'the standalone surface must call the builder its host handed down')
  assert.match(view, /chatConfigFor:\s*seat\s*=>\s*treeChatConfigFor\(seat\)/,
    'computersView must hand down the same builder the tree conversation uses')
})
