// Synthetic guest namespace only. Executes unchanged production module bytes
// in an isolated Node child; no host product root, VM or installer is touched.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const request = JSON.parse(process.argv[3]);
const share = '/mnt/qualification-input/measurement';
const trace = { fixedRootReads: [], readerEndReached: false, fixture: true };
const map = value => {
  if (typeof value !== 'string') return value;
  if (value === share || value.startsWith(share + '/')) return config.measurementRoot + value.slice(share.length);
  if (value === '/' || ['/var', '/opt', '/usr'].some(root => value === root || value.startsWith(root + '/'))) return config.guestRoot + (value === '/' ? '' : value);
  return value;
};
const installedPath = value => typeof value === 'string' && map(value) !== value && !value.startsWith(share);
let updateReads = 0;
const guestFs = { ...fs,
  realpathSync(value, ...args) { const actual = fs.realpathSync(map(value), ...args); return actual === map(value) ? value : actual; },
  lstatSync(value, ...args) {
    const result = fs.lstatSync(map(value), ...args);
    if (installedPath(value)) {
      result.uid = typeof result.uid === 'bigint' ? 0n : 0;
      result.gid = typeof result.gid === 'bigint' ? 0n : 0;
    }
    return result;
  },
  openSync(value, ...args) {
    if (installedPath(value)) trace.fixedRootReads.push(value);
    return fs.openSync(map(value), ...args);
  },
  readFileSync(value, ...args) { return fs.readFileSync(map(value), ...args); },
  readdirSync(value, ...args) {
    const result = fs.readdirSync(map(value), ...args);
    if (value === '/var/lib/dpkg/updates' && ++updateReads === 2) {
      trace.readerEndReached = true;
      const relative = { reader: 'tools/lib/guest/linux-installed-state.mjs',
        dependency: 'tools/lib/adapters/artifact-files.mjs', runtime: 'node-v22.19.0' }[config.mutateAtReaderEnd];
      if (relative) fs.appendFileSync(path.join(config.measurementRoot, relative), 'changed after actual reader execution');
    }
    return result;
  },
};
class GuestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [Date.now() + (config.clockOffsetMs || 0)])); }
  static now() { return Date.now() + (config.clockOffsetMs || 0); }
}
const context = vm.createContext({ Buffer, URL, Date: GuestDate, structuredClone,
  process: { platform: 'linux', arch: 'x64', version: process.version,
    hrtime: process.hrtime,
    execPath: share + '/node-v22.19.0', getuid: () => config.uid ?? 1000,
    pid: process.pid, argv: [share + '/node-v22.19.0', 'synthetic-harness'] } });
const modules = new Map();
async function load(specifier, parent = pathToFileURL(share + '/').href) {
  const id = specifier.startsWith('node:') ? specifier : new URL(specifier, parent).href;
  if (modules.has(id)) return modules.get(id);
  let module;
  if (id.startsWith('node:')) {
    const imported = id === 'node:fs' ? { default: guestFs } : await import(id);
    module = new vm.SyntheticModule(Object.keys(imported), function () {
      for (const [key, value] of Object.entries(imported)) this.setExport(key, value);
    }, { context, identifier: id });
  } else {
    const virtual = fileURLToPath(id);
    if (!virtual.startsWith(share + '/tools/lib/')) throw Error('fixture module outside fixed closure');
    module = new vm.SourceTextModule(fs.readFileSync(map(virtual), 'utf8'), {
      context, identifier: id, initializeImportMeta(meta) { meta.url = id; },
      async importModuleDynamically(child, parentModule) {
        const value = await load(child, parentModule.identifier);
        if (value.status === 'unlinked') await value.link(link);
        if (value.status === 'linked') await value.evaluate();
        return value;
      },
    });
  }
  modules.set(id, module); return module;
}
const link = (specifier, parent) => load(specifier, parent.identifier);
try {
  const producer = await load(share + '/tools/lib/guest/linux-installed-measurement.mjs');
  await producer.link(link); await producer.evaluate();
  const result = await producer.namespace.produceLinuxInstalledMeasurement(request);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write((error.code || error.name) + ': ' + error.message + '\n');
  process.exitCode = 1;
} finally { fs.writeFileSync(config.tracePath, JSON.stringify(trace)); }
