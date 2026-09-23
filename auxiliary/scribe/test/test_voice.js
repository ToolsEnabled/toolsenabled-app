#!/usr/bin/env node
'use strict';
/**
 * Voice tests, end to end through a real browser and a real speech model.
 *
 * Chrome can be handed a WAV file as its microphone
 * (--use-file-for-fake-audio-capture), so this drives the genuine path:
 * getUserMedia, the AudioWorklet, the 48k-to-16k downsample, energy
 * endpointing, the POST, faster-whisper on the GPU, and the text landing in the
 * bar. Nothing is stubbed.
 *
 * Ground truth comes from Windows SAPI, synthesized at test time, so accuracy
 * is measured against a known sentence rather than eyeballed.
 *
 * Run: node test/test_voice.js
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { Browser, findBrowser, sleep } = require('./cdp');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = null;
let BASE = null;
const TMP = path.join(__dirname, '_tmp_voice');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');

const PASS = [], FAIL = [];
const check = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? '  ' + d : ''}`); };

function req(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = raw || (body ? JSON.stringify(body) : null);
    const headers = {};
    if (data) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
    if (data) headers['content-length'] = Buffer.byteLength(data);
    if (raw) headers['x-sample-rate'] = '16000';
    const r = http.request(`${BASE}${p}`, { method, headers },
      (res) => { let o = ''; res.on('data', (c) => o += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(o || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: o }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0));
  return d[r.length][h.length] / Math.max(1, r.length);
}

/** Synthesize a known sentence with Windows SAPI so accuracy has ground truth. */
function say(text, file) {
  const ps = `Add-Type -AssemblyName System.Speech; ` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.Rate = 0; $s.SetOutputToWaveFile('${file.replace(/\\/g, '\\\\')}'); ` +
    `$s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  return fs.existsSync(file);
}

const SENTENCE = 'Find the paragraph about the determinacy screen and tell me what it says.';

async function voiceRobustnessUnits() {
  console.log('\n[voice robustness units]');
  const workletSource = fs.readFileSync(path.join(ROOT, 'public', 'mic-worklet.js'), 'utf8');
  let Processor = null;
  class TestWorkletProcessor {
    constructor() {
      this.port = {
        messages: [],
        postMessage: (message) => this.port.messages.push(message),
      };
    }
  }
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: TestWorkletProcessor,
    Float32Array,
    Math,
    sampleRate: 44100,
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const processor = new Processor();
  let remaining = 44100;
  while (remaining) {
    const length = Math.min(128, remaining);
    processor.process([[new Float32Array(length).fill(0.25)]]);
    remaining -= length;
  }
  const posted = processor.port.messages
    .filter((message) => message.type === 'pcm')
    .reduce((count, message) => count + message.pcm.byteLength / 4, 0);
  const outputSamples = posted + processor.outN;
  check('44.1 kHz capture is fractionally resampled to exactly 16 kHz',
    outputSamples === 16000, outputSamples);

  const micSource = fs.readFileSync(path.join(ROOT, 'public', 'mic.js'), 'utf8');
  let gumCalls = 0;
  let releaseStream;
  let stopped = 0;
  let closed = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
  const getUserMedia = () => {
    gumCalls++;
    return new Promise((resolve) => { releaseStream = () => resolve(stream); });
  };
  class BrokenAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.audioWorklet = {
        addModule: () => Promise.reject(new Error('worklet module failed')),
      };
    }
    close() {
      closed++;
      return Promise.resolve();
    }
  }
  const windowObject = {
    AudioContext: BrokenAudioContext,
    AudioWorklet: function AudioWorklet() {},
  };
  const sandbox = {
    window: windowObject,
    navigator: { mediaDevices: { getUserMedia } },
    location: { hostname: '127.0.0.1', host: '127.0.0.1:4693' },
    performance: { now: () => 0 },
    fetch: () => Promise.reject(new Error('not used')),
    Float32Array,
    Int16Array,
    Math,
    console,
  };
  vm.runInNewContext(micSource, sandbox);
  const firstStart = windowObject.micStart();
  const secondStart = windowObject.micStart();
  releaseStream();
  const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);
  check('concurrent microphone starts share one acquisition',
    gumCalls === 1 && firstResult.ok === false && secondResult.ok === false,
    JSON.stringify({ gumCalls, firstResult, secondResult }));
  check('failed worklet setup stops tracks and closes its AudioContext',
    stopped === 1 && closed === 1 &&
    windowObject.mic.stream === null && windowObject.mic.ctx === null,
    JSON.stringify({ stopped, closed, stream: windowObject.mic.stream }));

  function transcriptionHarness() {
    const requests = [];
    const windowObject = {
      AudioContext: function TestAudioContext() {},
      AudioWorklet: function AudioWorklet() {},
      __SCRIBE_STT_TIMEOUT_MS: 500,
    };
    const sandbox = {
      window: windowObject,
      navigator: {
        mediaDevices: {
          getUserMedia: () => Promise.reject(new Error('not used by transcription unit')),
        },
      },
      location: { hostname: '127.0.0.1', host: '127.0.0.1:4693' },
      performance: { now: () => Date.now() },
      fetch: (_input, init = {}) => new Promise((resolve, reject) => {
        requests.push({ resolve, reject, signal: init.signal || null });
      }),
      Float32Array,
      Int16Array,
      Math,
      console,
      setTimeout,
      clearTimeout,
      AbortController,
      DOMException,
    };
    vm.runInNewContext(micSource, sandbox);
    windowObject.mic.listening = true;
    windowObject.mic.generation = 7;
    return { sandbox, windowObject, requests };
  }

  const response = (text) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ text }),
  });
  const capture = (harness, sample) => {
    harness.windowObject.mic.chunks = [new Float32Array(320).fill(sample)];
    harness.windowObject.mic.samples = 320;
    return harness.sandbox.endUtterance();
  };

  const emptyFirst = transcriptionHarness();
  const emptyFirstTexts = [];
  emptyFirst.windowObject.mic.onText = (text) => emptyFirstTexts.push(text);
  await emptyFirst.sandbox.endUtterance();
  const afterEmpty = capture(emptyFirst, 0.1);
  emptyFirst.requests[0].resolve(response('first real transcript'));
  await afterEmpty;
  check('an empty capture does not leave a gap that blocks later transcripts',
    emptyFirst.requests.length === 1 &&
      emptyFirstTexts.join('|') === 'first real transcript',
    JSON.stringify({ requests: emptyFirst.requests.length, texts: emptyFirstTexts }));

  const ordered = transcriptionHarness();
  const orderedTexts = [];
  ordered.windowObject.mic.onText = (text) => orderedTexts.push(text);
  const firstUtterance = capture(ordered, 0.2);
  const secondUtterance = capture(ordered, 0.4);
  check('overlapping utterances start independent transcription requests',
    ordered.requests.length === 2, ordered.requests.length);
  ordered.requests[1].resolve(response('second transcript'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('a later STT response waits for the earlier utterance',
    orderedTexts.length === 0, JSON.stringify(orderedTexts));
  ordered.requests[0].resolve(response('first transcript'));
  await Promise.all([firstUtterance, secondUtterance]);
  check('overlapping STT responses are delivered in capture order',
    orderedTexts.join('|') === 'first transcript|second transcript',
    JSON.stringify(orderedTexts));

  const stoppedHarness = transcriptionHarness();
  const stoppedTexts = [];
  stoppedHarness.windowObject.mic.onText = (text) => stoppedTexts.push(text);
  const stoppedUtterance = capture(stoppedHarness, 0.3);
  const stoppedRequest = stoppedHarness.requests[0];
  stoppedHarness.windowObject.micStop();
  check('stopping the microphone aborts an in-flight transcription',
    !!stoppedRequest.signal && stoppedRequest.signal.aborted === true,
    JSON.stringify({ hasSignal: !!stoppedRequest.signal,
      aborted: stoppedRequest.signal && stoppedRequest.signal.aborted }));
  // Deliberately resolve despite the aborted signal. The generation check, not
  // just a cooperative fetch implementation, must reject this stale result.
  stoppedRequest.resolve(response('stale transcript after stop'));
  await stoppedUtterance;
  check('a stopped or stale transcription can never invoke onText',
    stoppedTexts.length === 0, JSON.stringify(stoppedTexts));
}

async function main() {
  await voiceRobustnessUnits();
  if (process.env.SCRIBE_VOICE_UNITS_ONLY === '1') {
    console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
    if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
    process.exitCode = FAIL.length ? 1 : 0;
    return;
  }
  if (!findBrowser()) {
    console.log('No browser found, skipping end-to-end voice checks.');
    process.exit(FAIL.length ? 1 : 0);
  }
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  fs.copyFileSync(SRC, doc);

  console.log('\n[ground truth]');
  const wav = path.join(TMP, 'speech.wav');
  const made = say(SENTENCE, wav);
  check('synthesized a known sentence with SAPI', made && fs.statSync(wav).size > 10000,
    made ? `${Math.round(fs.statSync(wav).size / 1024)} KB` : 'failed');
  if (!made) { console.log('cannot test voice without audio'); process.exit(1); }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data') },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let browser = null, hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), srv, {
      attempts: 120,
      interval: 100,
      requireDocHost: true,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(opened.body && opened.body.error || 'could not open voice fixture');
    }

    // ---------------------------------------------------- the model itself
    console.log('\n[the speech model]');
    const idle = await req('GET', '/api/stt');
    check('not started until needed', idle.body.running === false, JSON.stringify(idle.body));
    const t0 = Date.now();
    const warm = await req('POST', '/api/stt/warm');
    const loadMs = Date.now() - t0;
    check('loads on demand', warm.status === 200 && !!warm.body.device, JSON.stringify(warm.body));
    check('runs on the GPU', warm.body.device === 'cuda', warm.body.device);
    console.log(`  load: ${loadMs} ms, model ${warm.body.model}`);

    // ------------------------------------------- transcribe the raw PCM path
    console.log('\n[transcription accuracy, against the known sentence]');
    const raw = fs.readFileSync(wav);
    // Strip the SAPI header and resample 22050 -> 16000 the same way the
    // worklet does, so this exercises the server path with realistic input.
    const pcmIn = new Int16Array(raw.buffer, raw.byteOffset + 44, (raw.length - 44) / 2);
    const ratio = 22050 / 16000;
    const outN = Math.floor(pcmIn.length / ratio);
    const pcm = new Int16Array(outN);
    for (let i = 0; i < outN; i++) pcm[i] = pcmIn[Math.floor(i * ratio)];
    const body = Buffer.from(pcm.buffer);

    const t1 = Date.now();
    const heard = await req('POST', '/api/stt', null, body);
    const roundTrip = Date.now() - t1;
    check('returns a transcript', !!(heard.body && heard.body.text), JSON.stringify(heard.body).slice(0, 120));
    const rate = wer(SENTENCE, heard.body.text);
    check('transcript matches the spoken sentence (WER under 15%)', rate < 0.15,
      `${(rate * 100).toFixed(1)}%  "${heard.body.text}"`);
    check('reports how long it took', typeof heard.body.ms === 'number', `${heard.body.ms} ms`);
    check('faster than real time', heard.body.rtf > 1, `${heard.body.rtf}x`);
    console.log(`  ${heard.body.audio_s}s of audio, ${heard.body.ms} ms model, ${roundTrip} ms round trip`);

    console.log('\n[silence produces nothing, not a hallucination]');
    const quiet = await req('POST', '/api/stt', null, Buffer.alloc(16000 * 2 * 2));
    check('two seconds of silence transcribes to nothing', !quiet.body.text, JSON.stringify(quiet.body.text));
    const tiny = await req('POST', '/api/stt', null, Buffer.alloc(200));
    check('a too-short clip is rejected rather than decoded',
      tiny.status === 400 && /too short/i.test(tiny.body && tiny.body.error || ''),
      JSON.stringify(tiny.body));

    // ------------------------------------------- the whole browser path
    console.log('\n[the real path: browser mic to chat bar]');
    browser = await Browser.launch({
      headless: true,
      extraArgs: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}%noloop`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    check('the mic button is enabled on 127.0.0.1',
      (await browser.eval(`!document.getElementById('mic-btn').disabled`)) === true);
    check('the secure-origin check passes here',
      (await browser.eval('micOriginOk()')) === true);

    await browser.eval(`(document.getElementById('mic-btn').click(), true)`);
    const listening = await browser.waitFor(
      `['listening','speaking','thinking'].includes(document.getElementById('mic-btn').dataset.state)`,
      { timeout: 15000 }).catch(() => false);
    check('the microphone opens', !!listening,
      await browser.eval(`document.getElementById('mic-btn').dataset.state`));

    const sawSpeech = await browser.waitFor(
      `document.getElementById('mic-btn').dataset.state === 'speaking' || window.__heard`,
      { timeout: 20000 }).catch(() => false);
    check('it detects that someone is speaking', !!sawSpeech);

    // The utterance ends when the fake device runs out of audio and goes quiet.
    const gotText = await browser.waitFor(
      `(window.__voiceEvents||[]).some(e => e.kind === 'heard' && e.text)`,
      { timeout: 45000 }).catch(() => false);
    check('the utterance is endpointed and transcribed', !!gotText);

    if (gotText) {
      const ev = await browser.eval(`JSON.stringify((window.__voiceEvents||[]).find(e=>e.kind==='heard'))`);
      const got = JSON.parse(ev);
      const r2 = wer(SENTENCE, got.text);
      check('what the browser captured matches what was spoken (WER under 25%)', r2 < 0.25,
        `${(r2 * 100).toFixed(1)}%  "${got.text}"`);
      console.log(`  browser path: ${got.audioS}s captured, ${got.ms} ms model, ${got.totalMs} ms total`);
      const sent = await browser.eval(`(window.__scribe && document.getElementById('say').value) || ''`);
      check('the transcript was submitted, not left sitting in the box', sent === '', JSON.stringify(sent));
      // The trail renders from the SSE echo on the next animation frame, so
      // wait for it rather than racing it.
      // Check the SERVER first: it is authoritative about whether the utterance
      // actually became a message. The DOM is a second, weaker question about
      // rendering, and conflating the two makes a timing wobble look like a
      // broken feature.
      let saidOnServer = null;
      for (let i = 0; i < 20 && !saidOnServer; i++) {
        const t = (await req('GET', '/api/trail')).body.trail || [];
        saidOnServer = t.find((x) => x.op === 'said' && /determinacy|paragraph|find/i.test(x.summary || ''));
        if (!saidOnServer) await sleep(400);
      }
      check('the spoken words reached the conversation as if typed', !!saidOnServer,
        saidOnServer ? JSON.stringify(saidOnServer.summary).slice(0, 70) : 'no said entry on the server');

      const inConversation = await browser.waitFor(
        `/determinacy|paragraph|find/i.test(document.getElementById('conversation-turns').textContent)`,
        { timeout: 8000 }).catch(() => false);
      const conversation = await browser.eval(`document.getElementById('conversation-turns').textContent`);
      check('  and it is visible in the activity rail',
        !!inConversation, JSON.stringify(conversation.slice(0, 70)));
    }

    await browser.eval(`(document.getElementById('mic-btn').click(), true)`);
    await sleep(400);
    check('the microphone closes again',
      (await browser.eval(`document.getElementById('mic-btn').dataset.state`)) === 'off');

    console.log('\n[nothing threw]');
    const errs = await browser.eval('JSON.stringify(window.__errs || null)');
    check('no page errors', errs === '[]', errs);
    check('no uncaught exceptions', browser.exceptions.length === 0, browser.exceptions.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    if (browser) browser.kill();
    srv.kill();
    await sleep(900);
    for (let i = 0; i < 6; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (_) { await sleep(400); } }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { console.log('failed: ' + FAIL.join(', ')); console.log('\n--- server log ---\n' + srvLog.join('').slice(-2500)); }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
