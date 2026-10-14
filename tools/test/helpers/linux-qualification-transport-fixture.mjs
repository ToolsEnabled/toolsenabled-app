import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { openLinuxQualificationTransport } from '../../lib/transport/linux-qualification-rpc.mjs';

// No VM/guest execution. Local Python bridge processes use real private Unix
// sockets owned by this test process; the QEMU /proc facts are synthetic.
export async function fixture({ wrongImage = false, linkedInput = false, wrongProcess = false, execResult } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-transport-review-'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const image = path.join(root, 'base.img'), executable = path.join(root, 'qemu-system-x86_64');
  fs.writeFileSync(image, 'synthetic base bytes'); fs.writeFileSync(executable, 'synthetic executable bytes');
  const outside = linkedInput ? fs.mkdtempSync(path.join(os.tmpdir(), 'a1-transport-outside-')) : null;
  if (outside) fs.symlinkSync(outside, path.join(root, 'input'));
  else fs.mkdirSync(path.join(root, 'input'));
  const config = { schema: 'toolsenabled.private-linux-provisioning', schemaVersion: 1,
    qualification: false, networkPolicy: 'offline', qemuPid: wrongProcess ? 987654321 : process.pid, guestId: randomUUID(), root,
    rpcSocket: path.join(root, 'rpc.sock'), qmpSocket: path.join(root, 'qmp.sock'), imageSource: image,
    imageSha256: digest('synthetic base bytes'), qemuExecutableSha256: digest('synthetic executable bytes'), agentSha256: digest('synthetic broker bytes') };
  if (wrongImage) fs.writeFileSync(image, 'changed base bytes');
  const configPath = path.join(root, 'runner-config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  const controller = new AbortController();
  const clients = new Set(), servers = [], requests = [];
  let roleOverride, machineOverride, replyNonce, startTicks = '123';
  async function serve(file, qmp) {
    const server = net.createServer(socket => {
      clients.add(socket);socket.on('error', () => {});socket.on('close', () => clients.delete(socket));
      const send = value => socket.write(JSON.stringify(value) + '\n');
      if (qmp) send({ QMP: { version: 'synthetic' } });
      let buffered = ''; socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffered += chunk;
        while (buffered.includes('\n')) {
          const at = buffered.indexOf('\n'), line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          const r = JSON.parse(line); requests.push(r);
          if (qmp) {
            const value = { qmp_capabilities: {}, 'query-uuid': { UUID: config.guestId },
              'query-status': { running: true, status: 'running' },
              'query-block': [{ inserted: { image: { filename: image } } }] }[r.execute];
            send({ return: value });
          } else {
            const result = r.method === 'attest' ? { platform: 'Linux', kernel: 'synthetic-kernel',
              agentSha256: config.agentSha256, uid: 0, userUid: 1000, user: 'synthetic',
              machineId: machineOverride || 'synthetic-machine', networkDevices: ['lo'] }
              : execResult ? execResult(r) : { exitCode: 0, stdout: (roleOverride || r.role) === 'standard' ? '1000\n' : '0\n', stderr: '', role: roleOverride || r.role };
            Promise.resolve(result).then(result => send({ schema: 'toolsenabled.private-linux-provisioning-rpc', guestId: config.guestId,
            nonce: replyNonce || r.nonce, qualification: false,
            result }), error => send({ error: String(error.message) }));
          }
        }
      });
    });
    servers.push(server);await new Promise((resolve, reject) => { server.once('error', reject);server.listen(file, resolve); });
  }
  await serve(config.qmpSocket, true);await serve(config.rpcSocket, false);
  const args = [executable, '-uuid', config.guestId, '-net', 'none', '-enable-kvm',
    '-qmp', 'unix:' + config.qmpSocket + ',server=on,wait=off', '-chardev', 'socket,id=rpc,path=' + config.rpcSocket + ',server=on,wait=off',
    '-virtfs', 'local,path=' + path.join(root, 'input') + ',mount_tag=qualification-input,security_model=none,readonly=on'];
  const proc = '/proc/' + config.qemuPid;
  const originals = { statSync: fs.statSync, readlinkSync: fs.readlinkSync, readFileSync: fs.readFileSync };
  fs.statSync = function(file, ...rest) { if (file === proc) return { uid: process.getuid() };return originals.statSync.call(fs, file, ...rest); };
  fs.readlinkSync = function(file, ...rest) { if (file === proc + '/exe') return executable;return originals.readlinkSync.call(fs, file, ...rest); };
  fs.readFileSync = function(file, ...rest) {
    if (file === proc + '/cmdline') return Buffer.from(args.join('\0') + '\0');
    if (file === proc + '/stat') { const fields = Array(22).fill('0'); fields[0] = 'S';fields[19] = startTicks;return `${config.qemuPid} (synthetic) ${fields.join(' ')}`; }
    return originals.readFileSync.call(fs, file, ...rest);
  };
  return { config, requests, controller, root, outside, actualSocketProcess: process.pid,
    open: () => openLinuxQualificationTransport({ runnerConfigPath: configPath, signal: controller.signal }),
    changeRole: value => { roleOverride = value; }, changeMachine: value => { machineOverride = value; },
    changeNonce: value => { replyNonce = value; }, changeProcessStart: value => { startTicks = value; },
    async dispose() {
      controller.abort();Object.assign(fs, originals);
      for (const socket of clients) socket.destroy();
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      fs.rmSync(root, { recursive: true, force: true });
      if (outside) fs.rmSync(outside, { recursive: true, force: true });
    }
  };
}
