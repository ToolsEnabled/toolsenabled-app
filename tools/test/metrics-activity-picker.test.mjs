import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {activityCount, activityHourChoices} from '../../src/metrics-activity-picker.js'

test('activity picker distinguishes a recorded zero from missing or stale selection',()=>{
  const reading={ok:true,rows:[{startMs:100},{startMs:200}],counts:[Array(24).fill(0),Array(24).fill(7)]}
  assert.equal(activityCount(reading,'100',5),0)
  assert.equal(activityCount(reading,'200',5),7)
  assert.equal(activityCount(reading,'300',5),null)
  assert.equal(activityCount({...reading,ok:false},'200',5),null)
  assert.equal(activityCount(reading,'200',24),null)
})

test('activity picker restricts hours to the partially covered selected window',()=>{
  const start=new Date(2026,8,6).getTime()
  const at=hour=>new Date(2026,8,6,hour).getTime()
  assert.deepEqual(activityHourChoices({startMs:start},{startMs:at(8)+1000,endMs:at(11)}),[8,9,10])
  assert.deepEqual(activityHourChoices({startMs:start},{startMs:at(24),endMs:at(25)}),[])
})

test('activity picker omits a nonexistent daylight-saving hour',()=>{
  const module=new URL('../../src/metrics-activity-picker.js',import.meta.url).href
  const r=spawnSync(process.execPath,['--input-type=module','-e',`import {activityHourChoices} from ${JSON.stringify(module)};const start=new Date(2026,2,8).getTime();console.log(JSON.stringify(activityHourChoices({startMs:start},{startMs:start,endMs:new Date(2026,2,9).getTime()})));`],{env:{...process.env,TZ:'America/New_York'},encoding:'utf8'})
  assert.equal(r.status,0,r.stderr)
  const hours=JSON.parse(r.stdout);assert.equal(hours.length,23);assert.ok(!hours.includes(2));assert.ok(hours.includes(3))
})
