import fs from 'node:fs';
import path from 'node:path';
import { blocked, plainPath, relativeName, readBounded, measureTree, assertWindowsX64Pe } from './artifact-files.mjs';

// Static native layout only. These checks never execute a binary and do not
// certify installation, sandbox permissions, fuses, or customer journeys.
const COMMON_FILES = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'LICENSES.chromium.html'];
const WINDOWS_TARGET = Object.freeze({ platform: 'win32', arch: 'x64' });
const TARGETS = Object.freeze({
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64', standaloneExecutable: 'electron.exe',
    requiredFiles: Object.freeze([...COMMON_FILES, 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll']) }),
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64', standaloneExecutable: 'electron', appExecutable: 'toolsenabled',
    requiredFiles: Object.freeze([...COMMON_FILES, 'chrome-sandbox', 'chrome_crashpad_handler',
      'libffmpeg.so', 'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'vk_swiftshader_icd.json']) }),
});

export function nativeRuntimeTarget(target = WINDOWS_TARGET) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 2 ||
      !Object.hasOwn(target, 'platform') || !Object.hasOwn(target, 'arch') ||
      typeof target.platform !== 'string' || typeof target.arch !== 'string') blocked('native layout target must name only platform and architecture');
  const native = TARGETS[`${target.platform}-${target.arch}`];
  if (!native || native.platform !== target.platform || native.arch !== target.arch) blocked('unsupported native runtime layout target');
  return native;
}

export function nativeApplicationExecutable(sourcePackage, target) {
  const native = nativeRuntimeTarget(target);
  if (native.platform === 'linux') {
    if (sourcePackage.build?.linux?.executableName !== native.appExecutable) blocked('Linux application executable differs from the reviewed native layout');
    return native.appExecutable;
  }
  return relativeName(`${sourcePackage.productName}.exe`);
}

function assertLinuxX64Elf(file) {
  file = plainPath(file, { kind: 'file' });
  const before = fs.lstatSync(file, { bigint: true });
  const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
  const matches = stat => stat.isFile() && stat.nlink === 1n && fields.every(key => stat[key] === before[key]);
  if (!matches(before)) blocked('ELF input is not an ordinary file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!matches(fs.fstatSync(fd, { bigint: true }))) blocked('ELF parsing descriptor differs from its file identity');
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 || header[5] !== 1 || header[6] !== 1 ||
        ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 62 ||
        header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) blocked('runtime is not a Linux x64 ELF64 image');
    if (!matches(fs.fstatSync(fd, { bigint: true })) ||
        !matches(fs.lstatSync(plainPath(file, { kind: 'file' }), { bigint: true }))) blocked('ELF changed during native header measurement');
  } finally { fs.closeSync(fd); }
}

export function measureNativeRuntime(root, executable, version, target) {
  const native = nativeRuntimeTarget(target), tree = measureTree(root);
  const file = path.join(root, relativeName(executable));
  if (native.platform === 'win32') assertWindowsX64Pe(file);
  else assertLinuxX64Elf(file);
  for (const name of native.requiredFiles) if (!tree.files[name]?.bytes) blocked(`packaged Electron dependency is absent: ${name}`);
  if (!Object.keys(tree.files).some(name => name.startsWith('locales/') && name.endsWith('.pak'))) blocked('packaged Electron locales are absent');
  const actualVersion = readBounded(path.join(root, 'version'), 128).toString('utf8').trim();
  if (typeof version !== 'string' || actualVersion !== version) blocked('packaged Electron version differs from its declared build input');
  // The shared layout caller brackets this inspection with an exact whole-stage
  // comparison, after source, capability and native checks have all completed.
  return tree;
}
