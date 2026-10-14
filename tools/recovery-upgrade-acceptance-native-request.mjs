#!/usr/bin/env node
// Prepare Controller-owned CDP requests from saved witnesses; never launch a browser.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length !== 6 || args[0] !== '--evidence' || args[2] !== '--output' || args[4] !== '--origin') {
  throw new Error('Usage: node tools/recovery-upgrade-acceptance-native-request.mjs --evidence saved-run-directory --output new-directory --origin http://127.0.0.1:4601')
}
const evidence = fs.realpathSync(args[1])
const output = path.resolve(args[3])
const origin = args[5]
if (!/^http:\/\/127\.0\.0\.1:460[1-9]$/.test(origin)) throw new Error('Expected a product loopback origin on 4601-4609')
const root = fileURLToPath(new URL('../', import.meta.url))
const report = JSON.parse(fs.readFileSync(path.join(evidence, 'report.json'), 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
for (const [file, expected] of Object.entries(report.sourceHashes)) {
  const resolved = path.resolve(root, file)
  if (!resolved.startsWith(root) || sha256(fs.readFileSync(resolved)) !== expected) throw new Error(`Saved source mismatch: ${file}`)
}
const evaluate = expression => {
  new vm.Script(expression)
  return { method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }
}
const guard = `if (location.origin !== ${JSON.stringify(origin)}) throw new Error('Wrong acceptance origin');
if (!window.mcPrefs || !/recovery-upgrade-acceptance-/i.test(window.mcPrefs.file || '')) throw new Error('Disposable product profile required');`
const requests = {}
for (const count of [21, 25]) {
  const script = fs.readFileSync(path.join(evidence, `native-seed-${count}.js`), 'utf8')
  requests[`seed-${count}`] = evaluate(`(() => { if (location.origin !== ${JSON.stringify(origin)}) throw new Error('Wrong seed origin'); return ${script.trim()}; })()`)
}
const audit = fs.readFileSync(path.join(evidence, 'native-audit.js'), 'utf8')
requests.audit = evaluate(`(() => { ${guard} return ${audit.trim()}; })()`)
requests['capacity-write'] = evaluate(`(() => {
  ${guard}
  if (!window.mcPrefsNotice) throw new Error('Notice bridge required');
  const before = localStorage.getItem('acceptance.capacity');
  if (before !== null) throw new Error('Capacity key already exists; preserve it');
  let error = null;
  try { localStorage.setItem('acceptance.capacity', 's'.repeat(64 * 1024)); }
  catch (caught) { error = String(caught); }
  return { before, error, savedCharacters: localStorage.getItem('acceptance.capacity')?.length ?? null, notice: window.mcPrefsNotice.read() };
})()`)
requests['native-source'] = { method: 'DOMStorage.getDOMStorageItems', params: { storageId: { securityOrigin: origin, isLocalStorage: true } } }
requests.screenshot = { method: 'Page.captureScreenshot', params: { format: 'png' } }
// No transport endpoint or session id: Controller binds each request to its owned target.
fs.mkdirSync(output, { recursive: false })
for (const [name, request] of Object.entries(requests)) {
  fs.writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' })
}
const manifest = {
  status: 'PREPARED_ONLY: no native requests executed', origin, evidence,
  candidate: report.expectedBase, engine: report.engine, engineExecuted: false,
  sourceHashes: report.sourceHashes,
  files: Object.fromEntries(Object.keys(requests).map(name => [`${name}.json`, sha256(fs.readFileSync(path.join(output, `${name}.json`)))])),
  control: 'Manager 2 reviews; Controller binds disposable profiles, candidate executable, process and CDP target. NO PRUNE.',
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ output, status: manifest.status, requests: Object.keys(requests) }, null, 2))
