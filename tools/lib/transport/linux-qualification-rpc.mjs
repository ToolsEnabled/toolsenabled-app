import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { prepareLinuxInstalledMeasurement, verifyLinuxInstalledMeasurement } from './linux-installed-measurement.mjs';

export const LINUX_QUALIFICATION_TRANSPORT_VERSION = 1;
export const LINUX_QUALIFICATION_PROFILES = Object.freeze(['linux-x64-standard', 'linux-x64-install-authorized']);
const RESPONSE_SCHEMA = 'toolsenabled.private-linux-provisioning-rpc';
const MAX_BYTES = 4 * 1024 * 1024;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const refuse = (message, details = {}) => { const error = new Error('Linux guest transport refused: ' + message); error.code = 'LINUX_GUEST_REFUSED'; Object.assign(error, details); throw error; };
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

function ordinary(file, kind, root) {
  const absolute = path.resolve(file);
  if (root && !within(root, absolute)) refuse('path escapes the private machine root');
  if (fs.realpathSync(absolute) !== absolute) refuse('linked machine path');
  const stats = fs.lstatSync(absolute);
  if (stats.uid !== process.getuid()) refuse('machine input belongs to another host user');
  if (kind === 'socket' ? !stats.isSocket() : kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) refuse('wrong machine input type');
  return absolute;
}

export function validateLinuxGuestReply(response, { guestId, nonce, method, agentSha256, role, nativeIdentity }) {
  if (!response || response.schema !== RESPONSE_SCHEMA || response.guestId !== guestId ||
      response.nonce !== nonce || response.qualification !== false || !response.result) refuse('unbound or malformed RPC response');
  if (method === 'attest') {
    const proof = response.result;
    if (proof.platform !== 'Linux' || typeof proof.kernel !== 'string' || !proof.kernel ||
        proof.agentSha256 !== agentSha256 || proof.uid !== 0 || !Number.isSafeInteger(proof.userUid) ||
        proof.userUid <= 0 || typeof proof.user !== 'string' || !proof.user ||
        typeof proof.machineId !== 'string' || !proof.machineId ||
        !Array.isArray(proof.networkDevices) || proof.networkDevices.length !== 1 || proof.networkDevices[0] !== 'lo') refuse('native guest attestation differs');
    if (nativeIdentity && ['machineId', 'user', 'userUid', 'kernel', 'platform', 'agentSha256', 'uid'].some(key => proof[key] !== nativeIdentity[key])) refuse('native guest identity changed');
  } else if (method === 'exec') {
    if (!['standard', 'install-authorized'].includes(role) || response.result.role !== role) refuse('command response role differs');
    if (!Number.isInteger(response.result.exitCode) || typeof response.result.stdout !== 'string' ||
        typeof response.result.stderr !== 'string') refuse('command outcome is incomplete');
  } else refuse('unknown RPC method');
  return response;
}

function channel(socketPath, { timeoutMs = 45000, signal, expectedPid } = {}) {
  let buffer = '', pending, closed = false, timer, peerAccepted = false;
  const queued = [];
  const bridge = spawn('python3', ['-I', '-u', fileURLToPath(new URL('./linux-unix-peer-bridge.py', import.meta.url)),
    socketPath, String(expectedPid), String(process.getuid())], { stdio: ['pipe', 'pipe', 'pipe'] });
  const failure = message => Object.assign(new Error('Linux guest transport refused: ' + message), { code: 'LINUX_GUEST_REFUSED' });
  let lastError, stderr = '';
  const fail = error => {
    if (closed) return;
    closed = true; lastError = error; clearTimeout(timer);
    if (pending) { pending.reject(error); pending = null; }
    bridge.stdin.destroy(); bridge.kill('SIGTERM');
  };
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => fail(failure('Unix peer channel timeout')), timeoutMs); };
  armTimeout();
  bridge.stdout.setEncoding('utf8'); bridge.stderr.setEncoding('utf8');
  bridge.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 4096); });
  bridge.on('error', error => fail(failure('Unix peer bridge unavailable: ' + error.code)));
  bridge.stdin.on('error', error => fail(failure('Unix peer channel write failed: ' + error.code)));
  bridge.on('close', code => fail(failure('Unix peer bridge closed (' + code + '): ' + stderr.trim())));
  bridge.stdout.on('data', chunk => {
    if (closed) return;
    armTimeout(); buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BYTES) return fail(failure('guest response exceeds bound'));
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { return fail(failure('malformed guest JSON')); }
      if (!peerAccepted) {
        if (value.transportPeer?.pid !== expectedPid || value.transportPeer?.uid !== process.getuid()) return fail(failure('Unix peer binding missing'));
        peerAccepted = true; continue;
      }
      if (value.event) continue;
      if (pending) { const resolve = pending.resolve; pending = null; resolve(value); }
      else if (queued.length < 4) queued.push(value);
      else return fail(failure('unexpected guest message flood'));
    }
  });
  const abort = () => fail(failure('request cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    next() {
      if (closed) return Promise.reject(lastError);
      if (queued.length) return Promise.resolve(queued.shift());
      if (pending) return Promise.reject(failure('concurrent receive refused'));
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    send(value) { if (closed) throw lastError; bridge.stdin.write(JSON.stringify(value) + '\n'); },
    close() { signal?.removeEventListener('abort', abort); fail(failure('channel closed')); },
  };
}

async function qmpIdentity(config, signal) {
  const client = channel(config.qmpSocket, { signal, timeoutMs: 10000, expectedPid: config.qemuPid });
  try {
    const greeting = await client.next();
    if (!greeting.QMP) refuse('missing QMP greeting');
    const query = async execute => {
      client.send({ execute });
      const reply = await client.next();
      if (reply.error || !Object.hasOwn(reply, 'return')) refuse('QMP query failed');
      return reply.return;
    };
    await query('qmp_capabilities');
    const uuid = await query('query-uuid'), state = await query('query-status'), blocks = await query('query-block');
    if (uuid.UUID !== config.guestId || state.running !== true) refuse('QMP guest identity/state differs');
    if (!Array.isArray(blocks) || !blocks.length) refuse('QMP has no measured disks');
    const baseImages = [];
    for (const block of blocks) {
      let image = block.inserted?.image;
      if (!image) refuse('unmeasured guest block device');
      while (image) {
        ordinary(image.filename, 'file', config.root);
        if (!image['backing-image']) baseImages.push(image.filename);
        image = image['backing-image'];
      }
    }
    const measuredBaseImages = baseImages.map(file => ({ file, sha256: digest(file) }));
    if (!measuredBaseImages.some(image => image.sha256 === config.imageSha256)) refuse('declared base image bytes differ');
    return { measuredBaseImages, uuid: uuid.UUID, status: state.status, blockFiles: blocks.map(block => block.inserted.image.filename) };
  } finally { client.close(); }
}

function hostIdentity(configPath) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0) refuse('non-elevated Linux x64 host required');
  const configFile = ordinary(configPath, 'file');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.schema !== 'toolsenabled.private-linux-provisioning' || config.schemaVersion !== 1 ||
      config.qualification !== false || config.networkPolicy !== 'offline' ||
      !Number.isSafeInteger(config.qemuPid) || config.qemuPid < 1 ||
      !/^[a-f0-9-]{36}$/.test(config.guestId) ||
      ![config.imageSha256, config.qemuExecutableSha256, config.agentSha256].every(value => /^[a-f0-9]{64}$/.test(value))) refuse('worker description is incomplete');
  config.root = ordinary(config.root, 'directory');
  if (!within(config.root, configFile)) refuse('worker configuration is outside its machine root');
  ordinary(path.join(config.root, 'input'), 'directory', config.root);
  ordinary(config.rpcSocket, 'socket', config.root); ordinary(config.qmpSocket, 'socket', config.root);
  const processRoot = '/proc/' + config.qemuPid;
  if (fs.statSync(processRoot).uid !== process.getuid()) refuse('QEMU is owned by another user');
  const executable = fs.readlinkSync(processRoot + '/exe');
  const args = fs.readFileSync(processRoot + '/cmdline').toString().split('\0').filter(Boolean);
  if (path.basename(executable) !== 'qemu-system-x86_64' || digest(executable) !== config.qemuExecutableSha256) refuse('QEMU executable differs');
  const one = flag => args.filter(value => value === flag).length === 1 && args[args.indexOf(flag) + 1];
  if (one('-uuid') !== config.guestId || one('-net') !== 'none' ||
      args.includes('-netdev') || args.includes('-nic') || !args.includes('-enable-kvm')) refuse('QEMU network/instance/acceleration differs');
  if (one('-qmp') !== 'unix:' + config.qmpSocket + ',server=on,wait=off') refuse('QMP endpoint differs from process');
  if (one('-chardev') !== 'socket,id=rpc,path=' + config.rpcSocket + ',server=on,wait=off' ||
      one('-virtfs') !== 'local,path=' + path.join(config.root, 'input') + ',mount_tag=qualification-input,security_model=none,readonly=on' ||
      args.includes('-fsdev')) refuse('guest channel or read-only artifact share differs');
  const stat = fs.readFileSync(processRoot + '/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return { config, evidence: { configSha256: digest(configFile), qemuPid: config.qemuPid, executableSha256: config.qemuExecutableSha256, processStartTicks: startTicks } };
}

// This is operational transport evidence. It never declares release qualification,
// and is not registered as an installed-lifecycle adapter.
export async function openLinuxQualificationTransport({ runnerConfigPath, signal } = {}) {
  const { config, evidence } = hostIdentity(runnerConfigPath);
  const qmp = await qmpIdentity(config, signal);
  let closed = false, running = false, nativeIdentity, measurementOwner = null;
  const request = async (method, values = {}, timeoutSeconds = 30, { owner, onDispatch } = {}) => {
    if (closed || running || (measurementOwner && measurementOwner !== owner)) refuse('transport closed, reserved or request already in progress');
    running = true;
    const nonce = randomUUID();
    let client;
    try {
      const current = hostIdentity(runnerConfigPath);
      if (JSON.stringify(current.evidence) !== JSON.stringify(evidence)) refuse('worker identity changed during run');
      client = channel(config.rpcSocket, { signal, timeoutMs: (timeoutSeconds + 10) * 1000, expectedPid: config.qemuPid });
      client.send({ ...values, method, nonce });
      onDispatch?.();
      return validateLinuxGuestReply(await client.next(), { guestId: config.guestId, nonce, method, agentSha256: config.agentSha256, role: values.role, nativeIdentity });
    } finally { client?.close(); running = false; }
  };
  const initial = await request('attest');
  nativeIdentity = Object.freeze({ ...initial.result, networkDevices: Object.freeze([...initial.result.networkDevices]) });
  return Object.freeze({
    version: LINUX_QUALIFICATION_TRANSPORT_VERSION,
    identity: Object.freeze({ ...evidence, guestId: config.guestId, machineRoot: config.root, guestInputRoot: '/mnt/qualification-input', qmp, native: nativeIdentity, qualification: false }),
    attest: () => request('attest'),
    execute({ argv, profile, timeoutSeconds = 30 } = {}) {
      if (!LINUX_QUALIFICATION_PROFILES.includes(profile) || !Array.isArray(argv) || !argv.length || argv.length > 128 ||
          argv.some(value => typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) ||
          !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 180) refuse('invalid command/profile/bound');
      return request('exec', { argv, role: profile === 'linux-x64-standard' ? 'standard' : 'install-authorized', timeoutSeconds }, timeoutSeconds);
    },
    async measureInstalledState(options) {
      if (closed || running || measurementOwner || signal?.aborted) refuse('measurement transport closed, busy or cancelled before dispatch', { measurementDispatch: 'not-dispatched' });
      const owner = {}; measurementOwner = owner;
      let dispatched = false;
      try {
        const prepared = prepareLinuxInstalledMeasurement(config.root, options);
        await request('attest', {}, 30, { owner });
        const response = await request('exec', { argv: prepared.argv, role: 'standard', timeoutSeconds: prepared.timeoutSeconds },
          prepared.timeoutSeconds, { owner, onDispatch() { dispatched = true; } });
        await request('attest', {}, 30, { owner });
        return verifyLinuxInstalledMeasurement(response, prepared, { guestId: config.guestId, native: nativeIdentity });
      } catch (error) {
        error.measurementDispatch = dispatched ? 'submitted-to-transport' : 'not-dispatched';
        if (dispatched) error.remoteMeasurementTerminationConfirmed = false;
        throw error;
      } finally { measurementOwner = null; }
    },
    close() { closed = true; },
  });
}
