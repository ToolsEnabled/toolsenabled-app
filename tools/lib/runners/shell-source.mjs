import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unlinkedPath } from '../transport/owned-job.mjs';

// Real shell source, evaluated with inert OS/Electron dependencies. These are
// source behavior tests; they never assert that an installed window launched.
export function registerShellSourceChecks(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) {
    throw Object.assign(new Error('Shell source checks require an explicit QUALIFICATION_SHELL_ROOT'), { code: 'QUALIFICATION_SHELL_ROOT_REQUIRED' });
  }
  const root = unlinkedPath(sourceRoot, { directory: true });
  const filename = unlinkedPath(path.join(root, 'main.js'));
  const source = fs.readFileSync(filename, 'utf8');
  function harness({ electronMode = true, lock = true } = {}) {
    const spawned = [], windows = [], calls = { quit: 0, ready: 0 };
    const app = new EventEmitter();
    app.requestSingleInstanceLock = () => lock;
    app.quit = () => { calls.quit++; };
    app.whenReady = () => { calls.ready++; return { then() {} }; };
    class Window {
      constructor(options) { this.options = options; windows.push(this); }
      loadURL(url) { this.url = url; }
    }
    const childProcess = {
      spawn(command, args, options) {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.pid = 731; child.exitCode = null; child.unref = () => { child.unreferenced = true; };
        spawned.push({ command, args, options, child }); return child;
      },
      spawnSync(command) { return { stdout: command === 'wmic' ? 'ParentProcessId ProcessId\n731 732\n' : ' TCP 127.0.0.1:31991 0.0.0.0:0 LISTENING 990\n' }; },
    };
    const fakeProcess = new EventEmitter();
    Object.assign(fakeProcess, { execPath: 'C:\\required-runtime\\Product.exe', platform: 'win32', argv: ['Product.exe', root, '--keep-switch'],
      env: { ELECTRON_RUN_AS_NODE: '1', TEST_INPUT: 'preserved' }, exit(code) { throw Object.assign(new Error('inert exit'), { inertExit: code }); } });
    const context = vm.createContext({ __dirname: root, process: fakeProcess, console,
      setTimeout() { throw new Error('source fixture may not schedule actual product work'); },
      require(name) {
        if (name === 'electron') return electronMode ? { app, BrowserWindow: Window, shell: { openExternal() {} } } : 'electron-binary';
        if (name === 'node:child_process') return childProcess;
        if (name === 'node:path') return path;
        if (name === 'node:fs') return { readFileSync(file) { assert.equal(file, path.join(root, 'product.json')); return JSON.stringify({ name: 'Fixture Product', server: 'server.js', portEnv: 'PRODUCT_PORT' }); } };
        if (name === 'node:http' || name === 'node:net') return {};
        throw new Error(`unexpected actual shell dependency ${name}`);
      },
    });
    try { vm.runInContext(source, context, { filename, timeout: 2000 }); }
    catch (error) { if (error.inertExit !== 0) throw error; }
    return { context, spawned, windows, calls, fakeProcess };
  }

  test('shell behavior clears Node mode and preserves requested launch switches on relaunch', () => {
    const h = harness({ electronMode: false });
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].command, h.fakeProcess.execPath);
    assert.deepEqual(Array.from(h.spawned[0].args), [root, '--keep-switch']);
    assert.equal(h.spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(h.spawned[0].options.env.TEST_INPUT, 'preserved');
    assert.equal(h.fakeProcess.env.ELECTRON_RUN_AS_NODE, '1');
  });

  test('shell behavior refuses a second instance without starting another product server', () => {
    const h = harness({ lock: false });
    assert.equal(h.calls.quit, 1);
    assert.equal(h.calls.ready, 0);
    assert.equal(h.spawned.length, 0);
  });

  test('shell behavior starts the shipped runtime with product port and renders escaped startup diagnostics', () => {
    const h = harness();
    vm.runInContext('startServer(31991)', h.context, { timeout: 2000 });
    const launched = h.spawned[0];
    assert.equal(launched.command, h.fakeProcess.execPath);
    assert.deepEqual(Array.from(launched.args), ['server.js']);
    assert.equal(launched.options.cwd, path.join(path.dirname(root), 'app'));
    assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(launched.options.env.PORT, '31991');
    assert.equal(launched.options.env.PRODUCT_PORT, '31991');
    assert.equal(launched.options.windowsHide, true);
    launched.child.stderr.emit('data', Buffer.from('<failure>& details'));
    vm.runInContext('failureWindow("Failed to start")', h.context, { timeout: 2000 });
    const html = decodeURIComponent(h.windows[0].url.split(',').slice(1).join(','));
    assert.ok(html.includes('&lt;failure&gt;&amp; details'));
    assert.ok(!html.includes('<failure>'));
    assert.equal(h.windows[0].options.webPreferences.sandbox, true);
    assert.equal(vm.runInContext('listenerIsOurs(31991)', h.context), false);
  });
}

// Imports expose registration only. The fixed source adapter supplies this
// explicit source path; a relocated consumer must never guess a sibling website.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerShellSourceChecks(process.env.QUALIFICATION_SHELL_ROOT);
}
