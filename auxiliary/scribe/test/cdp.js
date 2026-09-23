'use strict';
/**
 * Minimal Chrome DevTools Protocol client. Zero dependencies: Node 22 ships a
 * global WebSocket, which is all this needs.
 *
 * Written fresh rather than borrowed from the deck suite next door, per the
 * copy-do-not-couple rule.
 *
 * SAFETY: the browser is always killed by its CAPTURED PID. Never by image
 * name. `taskkill /IM chrome.exe` closes every Chrome window on the machine,
 * including the user's own.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function findBrowser() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

function getJSON(url, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
  });
}

class Browser {
  constructor(proc, port, profileDir) {
    this.proc = proc; this.port = port; this.profileDir = profileDir;
    this.ws = null; this.seq = 0; this.pending = new Map();
  }

  static async launch({ port = null, headless = true, extraArgs = [] } = {}) {
    const bin = findBrowser();
    if (!bin) throw new Error('no Chrome or Edge found in the usual locations');
    if (!port) port = await freePort();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-cdp-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-gpu', '--mute-audio',
      'about:blank',
    ];
    args.unshift(...extraArgs);
    if (headless) args.unshift('--headless=new');
    const proc = spawn(bin, args, { stdio: 'ignore', shell: false, detached: false });
    const b = new Browser(proc, port, profileDir);

    for (let i = 0; i < 80; i++) {
      try { await getJSON(`http://127.0.0.1:${port}/json/version`); break; }
      catch (_) { await sleep(250); }
      if (i === 79) { b.kill(); throw new Error('browser never opened its debug port'); }
    }
    return b;
  }

  async attachToPage() {
    let target = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJSON(`http://127.0.0.1:${this.port}/json/list`).catch(() => []);
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
      await sleep(200);
    }
    if (!target) throw new Error('no page target');
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
    return this;
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
                             reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Install an error collector that runs before any page script. Must be called
   * before goto(). Without this, an assertion against window.__errs is vacuous:
   * the array never exists, so the check can never fail.
   */
  async collectErrors() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          if (window.__scribeErrorCollector) return;
          window.__scribeErrorCollector = true;
          window.__errs = [];
          window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e)));
          window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
          const originalConsoleError = console.error;
          console.error = function (...a) {
            window.__errs.push('console.error: ' + a.join(' '));
            originalConsoleError.apply(console, a);
          };
        })();
      `,
    });
    // Uncaught exceptions that never reach window.onerror still show up here.
    this.exceptions = [];
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        this.exceptions.push((d && d.exception && d.exception.description) || (d && d.text) || 'unknown');
      }
    });
    return this;
  }

  async goto(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    // Poll for readiness rather than trusting a lifecycle event, which is
    // flakier than just asking the page.
    for (let i = 0; i < 60; i++) {
      const r = await this.eval('document.readyState').catch(() => null);
      if (r === 'complete') return;
      await sleep(200);
    }
  }

  /** Evaluate an expression and return its JSON value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return (${expr}); } catch (e) { return '__ERR__' + e.message; } })()`,
      returnByValue: true, awaitPromise: true,
    });
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.startsWith('__ERR__')) throw new Error(v.slice(7));
    return v;
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expr, { timeout = 10000, interval = 120 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await this.eval(expr).catch(() => null);
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(`waitFor timed out: ${expr}`);
  }

  kill() {
    // By captured PID only. See the note at the top of this file.
    try { if (this.ws) this.ws.close(); } catch (_) {}
    try { this.proc.kill(); } catch (_) {}
    try { process.kill(this.proc.pid); } catch (_) {}
    setTimeout(() => { try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch (_) {} }, 500);
  }
}

module.exports = { Browser, findBrowser, sleep };

/** Capture a PNG screenshot to `file`. Useful for eyeballing what the DOM
 *  assertions cannot describe: whether it actually looks right. */
Browser.prototype.screenshot = async function (file, { width = 1440, height = 900 } = {}) {
  await this.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: false,
  });
  const r = await this.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};
