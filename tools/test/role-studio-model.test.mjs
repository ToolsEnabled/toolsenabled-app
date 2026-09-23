import test from 'node:test'
import assert from 'node:assert/strict'
import { roleDraft, roleDocument, parseRoleDocument, roleConnections, directionsPreview, functionExample } from '../../src/role-studio-model.js'

test('export and import preserve multiline directions and exact function policy', () => {
  const draft = roleDraft({ id: 'review-helper', baseDefaultRole: 'reviewer', owns: 'Read the assigned file.\n\nCheck the evidence.', mustNot: 'Change the source.', handoff: 'Report to the manager.', functions: ['app.context'], requiresDirectUserAuthorization: true })
  assert.deepEqual(parseRoleDocument(roleDocument(draft)), draft)
  for (const functions of [null, []]) assert.deepEqual(parseRoleDocument(roleDocument({ ...draft, functions })).functions, functions)
  const longer = { ...draft, rules: { ...draft.rules, owns: 'Context: ' + 'x'.repeat(3000) } }
  assert.throws(() => parseRoleDocument(roleDocument(longer)), /1500/)
  assert.deepEqual(parseRoleDocument(roleDocument(longer), 6000), longer)
  for (const change of [{ functions: ['app.*'] }, { functions: ['app.context','app.context'] }, { capabilities: { orgRoot:true } }, { rules:{owns:'Missing two fields'} }, { requiresDirectUserAuthorization:'true' }, { version:2 }]) {
    assert.throws(() => parseRoleDocument(JSON.stringify({ ...JSON.parse(roleDocument(draft)), ...change })))
  }
})

test('canvas draws only real manager relationships and counts repeated role connections', () => {
  const roles = [{id:'lead'}, {id:'maker'}, {id:'reader'}]
  const org = { agents:[{id:'a',role:'lead'}, {id:'b',role:'maker'}, {id:'c',role:'maker'}, {id:'d',role:'reader'}], relationships:[
    {from:'a',to:'b',type:'manages'}, {from:'a',to:'c',type:'manages'}, {from:'b',to:'c',type:'manages'},
    {from:'a',to:'d',type:'advises'}, {from:'missing',to:'a',type:'manages'},
  ] }
  assert.deepEqual(roleConnections(org, roles), [{from:'lead',to:'maker',count:2}, {from:'maker',to:'maker',count:1}])
  assert.deepEqual(roleConnections(undefined, roles), [])
})

test('preview includes inherited guidance and call template uses only declared required inputs', () => {
  const preview = directionsPreview({ name:'Task helper', rules:['Return evidence to your dispatcher.'] }, roleDraft({id:'helper',owns:'Inspect.',mustNot:'Dispatch.',handoff:'Report.'}))
  assert.match(preview, /Return evidence to your dispatcher/)
  const example = JSON.parse(functionExample({ id:'task.read', inputSchema:{ type:'object', required:['id','limit'], properties:{id:{type:'string'},limit:{type:'integer',minimum:1},optional:{type:'boolean'}} } }))
  assert.deepEqual(example, {name:'task.read',arguments:{id:'<value>',limit:1}})
})

test('empty directions are portable saved content while text types, limits and policy stay validated', () => {
  const draft = roleDraft({ id: 'empty-helper', owns: '', mustNot: '', handoff: '', functions: ['app.context'], requiresDirectUserAuthorization: true })
  assert.deepEqual(parseRoleDocument(roleDocument(draft), 6000), draft)
  const preview = directionsPreview(null, draft)
  assert.doesNotMatch(preview, /Not written yet|Worker|must add/i)
  for (const field of ['owns', 'mustNot', 'handoff']) for (const value of [undefined, null, false, {}, [], '\u0000', 'x'.repeat(6001)]) {
    assert.throws(() => parseRoleDocument(roleDocument({ ...draft, rules: { ...draft.rules, [field]: value } }), 6000))
  }
})
