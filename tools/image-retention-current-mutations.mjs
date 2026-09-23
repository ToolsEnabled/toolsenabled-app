import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
if (!process.env.IMAGE_TEST_TEMP) throw new Error('Explicit fenced IMAGE_TEST_TEMP required')
const temp = fs.realpathSync(process.env.IMAGE_TEST_TEMP)
const scratch = fs.mkdtempSync(path.join(temp, 'image-retention-mutations-'))
const excluded = new Set(['IMAGE_CUSTODY_RELEASE_REFUSED','IMAGE_OUTBOX_COMPACTION_REFUSED',
  'IMAGE_OUTBOX_CLEANUP_REQUIRED','IMAGE_OUTBOX_CLEANUP_REFUSED','IMAGE_OUTBOX_ADMISSION_REQUIRED'])
const jobs = []
const sourceHashes = {}
for (const [name, suite, variable] of [
  ['durable-image-custody.cjs','durable-image-custody.test.mjs','IMAGE_CUSTODY_MODULE'],
  ['image-outbox.cjs','image-outbox.test.mjs','IMAGE_OUTBOX_MODULE'],
]) {
  const source = fs.readFileSync(path.join(root, 'shell', name), 'utf8')
  sourceHashes[name] = createHash('sha256').update(source).digest('hex')
  const codes = [...new Set([...source.matchAll(/(?:refuse|fail)\('(IMAGE_[A-Z_]+)'\)/g)].map(m => m[1]))]
  for (const code of codes.filter(code => !excluded.has(code))) {
    const changed = source.replaceAll(new RegExp("(?:refuse|fail)\\('" + code + "'\\)", 'g'), 'void 0')
    if (changed === source) throw new Error('Mutation did not change ' + code)
    jobs.push({ name, suite, variable, code, changed })
  }
  if (name === 'durable-image-custody.cjs') jobs.push({ name, suite, variable, code: 'STALE_PATH_REUSE',
    changed: source.replaceAll("record.id + '-' + index", 'index') })
  if (name === 'image-outbox.cjs') jobs.push({ name, suite, variable, code: 'DISPATCH_RETRY_REPLAY',
    changed: source.replace('dispatchAllowed: false', 'dispatchAllowed: true') })
  if (name === 'image-outbox.cjs') jobs.push({ name, suite, variable, code: 'SELECTION_IDENTITY_DRIFT',
    changed: source.replace('selection: entry.selection ?? null', 'selection: null') })
}
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}
const results = []
let cursor = 0
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]
    const directory = fs.mkdtempSync(path.join(scratch, 'mutant-'))
    for (const dependency of ['durable-image-custody.cjs','provider-image-support.cjs'])
      fs.copyFileSync(path.join(root,'shell',dependency),path.join(directory,dependency))
    fs.writeFileSync(path.join(directory,job.name),job.changed)
    const result = await run(['--test',path.join('tools','test',job.suite)], {
      ...process.env, [job.variable]:path.join(directory,job.name),
    })
    fs.writeFileSync(path.join(directory,'result.tap'),result.stdout + result.stderr)
    const failedTests = Number(result.stdout.match(/^# fail (\d+)$/m)?.[1] || 0)
    const killed = result.status !== 0 && failedTests > 0 && !result.stderr.includes('SyntaxError')
    const row = { gate:job.code, status:result.status, failedTests, killed, artifact:path.join(directory,'result.tap') }
    results.push(row)
    console.log(JSON.stringify(row))
  }
}
await Promise.all(Array.from({length:4},worker))
const green = await run(['--test','tools/test/durable-image-custody.test.mjs','tools/test/image-outbox.test.mjs'],process.env)
fs.writeFileSync(path.join(scratch,'restored-green.tap'),green.stdout + green.stderr)
const afterHashes = Object.fromEntries(Object.keys(sourceHashes).map(name => [name,createHash('sha256').update(fs.readFileSync(path.join(root,'shell',name))).digest('hex')]))
const summary = { sourceHashes, afterHashes, unchanged:JSON.stringify(sourceHashes)===JSON.stringify(afterHashes),
  mutants:results.length, killed:results.filter(r=>r.killed).length, excluded:[...excluded],
  restoredGreen:{status:green.status,pass:Number(green.stdout.match(/^# pass (\d+)$/m)?.[1]||0),fail:Number(green.stdout.match(/^# fail (\d+)$/m)?.[1]||0)},
  scratch, results }
fs.writeFileSync(path.join(scratch,'summary.json'),JSON.stringify(summary,null,2))
console.log('MUTATION_SUMMARY '+JSON.stringify(summary))
if (summary.mutants !== summary.killed || green.status !== 0 || !summary.unchanged) process.exitCode=1
