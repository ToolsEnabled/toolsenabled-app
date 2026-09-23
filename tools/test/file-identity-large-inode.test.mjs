import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileIdentity } from '../lib/transport/owned-job.mjs';
import { measureFile } from '../lib/adapters/artifact-files.mjs';

// Real disposable file reads, with only the OS file identifier substituted.
// Adjacent NTFS identifiers beyond Number's precision must remain distinct.
for (const [name, measure] of [['owned process', fileIdentity], ['artifact', measureFile]]) {
  for (const changed of [false, true]) {
    test(`${name}: large file identifiers ${changed ? 'detect replacement' : 'retain stable files'}`, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-file-identity-'));
      const file = path.join(root, 'input.txt');
      fs.writeFileSync(file, 'measured bytes');
      const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
      const inode = 2n ** 54n;
      assert.equal(Number(inode), Number(inode + 1n), 'the fixture must expose integer rounding');
      let reads = 0;
      function identify(stat, value, options) {
        Object.defineProperty(stat, 'ino', { value: options?.bigint ? value : Number(value) });
        return stat;
      }
      t.after(() => {
        fs.lstatSync = originalLstat; fs.fstatSync = originalFstat;
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.lstatSync = (target, options) => {
        const stat = originalLstat(target, options);
        return String(target) === file ? identify(stat, inode, options) : stat;
      };
      fs.fstatSync = (fd, options) => identify(originalFstat(fd, options),
        inode + (changed && reads++ > 0 ? 1n : 0n), options);
      if (changed) assert.throws(() => measure(file), /changed/);
      else assert.equal(measure(file).bytes, Buffer.byteLength('measured bytes'));
    });
  }
}
