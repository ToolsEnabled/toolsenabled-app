import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {validate, pair} from './paste-resume-native-acceptance.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['tools/paste-resume-native-acceptance.mjs', 'tools/paste-resume-native-acceptance-provenance.mjs'];
function bytesAt(root, name) {
 if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(x => x === '..' || x === '.')) throw Error('unsafe relative path');
 const base = fs.realpathSync(root), target = fs.realpathSync(path.resolve(base, name));
 if (!target.startsWith(base + path.sep) || !fs.statSync(target).isFile()) throw Error('evidence outside root or not a file');
 const bytes = fs.readFileSync(target);
 if (!bytes.length) throw Error('empty artifact');
 return bytes;
}
function record(root, name) { const bytes = bytesAt(root, name); return {path:name, bytes:bytes.length, sha256:digest(bytes)}; }
export function sourceBinding(root) {
 const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8'}).trim();
 return {head:git('rev-parse','HEAD'), dirty:git('status','--porcelain').length > 0, files:sourceFiles.map(name => record(root,name))};
}
export function capture(receiptFile, sourceRoot) {
 const root = path.dirname(path.resolve(receiptFile));
 const receiptName = path.basename(receiptFile), receipt = JSON.parse(bytesAt(root,receiptName));
 if (!Array.isArray(receipt.cases)) throw Error('receipt cases required');
 const bindings = receipt.cases.map(row => {
  if (typeof row?.id !== 'string' || !Array.isArray(row.evidence)) throw Error('invalid case');
  return {id:row.id, evidence:row.evidence.map(name => record(root,name))};
 });
 return {schema:1, kind:'offline-provenance-inventory', capturedAt:new Date().toISOString(), accepted:false,
  runtimeAuthenticated:false, expectedRuntimePair:pair, source:sourceBinding(sourceRoot), receipt:record(root,receiptName), cases:bindings};
}
export function verify(manifest, root, sourceRoot) {
 const errors=[];
 try {
  if (manifest?.schema !== 1 || manifest.kind !== 'offline-provenance-inventory' || manifest.accepted !== false || manifest.runtimeAuthenticated !== false) throw Error('invalid inventory identity');
  bytesAt(root,manifest.receipt.path);
  const actual = capture(path.join(root,manifest.receipt.path),sourceRoot);
  for (const key of ['receipt','cases','source','expectedRuntimePair']) {
   if (JSON.stringify(actual[key]) !== JSON.stringify(manifest[key])) errors.push(`${key}: binding changed`);
  }
  // Contract readiness is reported separately from file integrity; neither authenticates a native run.
  const contract = validate(JSON.parse(bytesAt(root,manifest.receipt.path)),root);
  return {status:errors.length?'BINDING_MISMATCH':'INVENTORY_VERIFIED', errors, contract, accepted:false, runtimeAuthenticated:false};
 } catch (error) { return {status:'BINDING_MISMATCH',errors:[...errors,error.message],accepted:false,runtimeAuthenticated:false}; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 try {
  const [command,input,output] = process.argv.slice(2);
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (command === 'capture' && input && output) {
   if (path.dirname(path.resolve(input)) !== path.dirname(path.resolve(output))) throw Error('inventory must be beside receipt');
   const result=capture(input,sourceRoot);
   fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify({status:'INVENTORY_CAPTURED',accepted:false,runtimeAuthenticated:false}));
  } else if (command === 'verify' && input && !output) {
   const file=path.resolve(input), result=verify(JSON.parse(fs.readFileSync(file,'utf8')),path.dirname(file),sourceRoot);
   console.log(JSON.stringify(result,null,2)); process.exitCode=result.errors.length?1:0;
  } else throw Error('Usage: capture <receipt.json> <new inventory beside receipt> | verify <inventory.json>. Offline integrity only; never native acceptance.');
 } catch(error) { console.error(error.message); process.exitCode=2; }
}
