#!/usr/bin/env node
'use strict';

// Deterministic tests for the browser-side file gate. These execute the exact
// helper block shipped by both pages and use in-memory Responses: no live
// server, deck render, download directory, or project state is touched.
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const studioSource = fs.readFileSync(path.join(PUBLIC, 'studio.js'), 'utf8');
const appSource = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const studioHtml = fs.readFileSync(path.join(PUBLIC, 'studio.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const START = '// ---- safe binary downloads -------------------------------------------------';
const END = '// ---- end safe binary downloads ---------------------------------------------';

function helperBlock(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error('safe binary download helper markers are missing');
  return source.slice(start, end + END.length);
}

const studioBlock = helperBlock(studioSource);
const appBlock = helperBlock(appSource);
const client = new Function(`${studioBlock}
  return {
    DOWNLOAD_PPTX_MIME, DOWNLOAD_PDF_MIME, fetchBinaryDownload,
    waitForCurrentPresentation, requestPptxBlob, saveDownloadBlob,
  };
`)();

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function binaryResponse(mime, bytes) {
  return new Response(Uint8Array.from(bytes), { status: 200, headers: { 'Content-Type': mime } });
}
const pptxResponse = () => binaryResponse(client.DOWNLOAD_PPTX_MIME,
  [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const pdfResponse = () => binaryResponse(client.DOWNLOAD_PDF_MIME,
  [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

const checks = [];
function check(description, condition, detail) {
  checks.push({ description, ok: !!condition, detail: condition ? undefined : detail });
}

async function main() {
  check('Studio and dashboard ship the same binary validation contract', studioBlock === appBlock);

  const staleCalls = [];
  let pptxCalls = 0;
  let healthCalls = 0;
  const staleThenReady = async (url) => {
    staleCalls.push(url);
    if (url === '/api/pptx') {
      pptxCalls += 1;
      return pptxCalls === 1
        ? jsonResponse(409, { ok: false, error: 'presentation is not current' })
        : pptxResponse();
    }
    if (url === '/api/health') {
      healthCalls += 1;
      return jsonResponse(200, { ok: true, presentation: { current: healthCalls >= 2 } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const pptxBlob = await client.requestPptxBlob({
    fetch: staleThenReady, timeoutMs: 2000, pollMs: 1, sleep: async () => {},
  });
  check('stale PPTX waits for current health and retries one binary response',
    pptxBlob.type === client.DOWNLOAD_PPTX_MIME
      && JSON.stringify(staleCalls) === JSON.stringify([
        '/api/pptx', '/api/health', '/api/health', '/api/pptx',
      ]), staleCalls);

  const racedCalls = [];
  let racedPptxCalls = 0;
  const racedBlob = await client.requestPptxBlob({
    timeoutMs: 2000, pollMs: 1, sleep: async () => {},
    fetch: async (url) => {
      racedCalls.push(url);
      if (url === '/api/pptx') {
        racedPptxCalls += 1;
        return racedPptxCalls < 3
          ? jsonResponse(409, { ok: false, error: 'presentation changed during download' })
          : pptxResponse();
      }
      return jsonResponse(200, { ok: true, presentation: { current: true } });
    },
  });
  check('a new edit after current health retries the stale PPTX race until binary succeeds',
    racedBlob.type === client.DOWNLOAD_PPTX_MIME
      && JSON.stringify(racedCalls) === JSON.stringify([
        '/api/pptx', '/api/health', '/api/pptx', '/api/health', '/api/pptx',
      ]), racedCalls);

  let raceTimeoutError = null;
  let raceClock = 0;
  let raceTimeoutPptxCalls = 0;
  let raceTimeoutHealthCalls = 0;
  try {
    await client.requestPptxBlob({
      timeoutMs: 10, pollMs: 1, sleep: async () => {}, now: () => raceClock,
      fetch: async (url) => {
        if (url === '/api/pptx') {
          raceTimeoutPptxCalls += 1;
          raceClock += 4;
          return jsonResponse(409, { error: 'presentation changed again' });
        }
        raceTimeoutHealthCalls += 1;
        return jsonResponse(200, { ok: true, presentation: { current: true } });
      },
    });
  } catch (error) { raceTimeoutError = error; }
  check('repeated current-to-stale races share one bounded deadline',
    raceTimeoutError && /still rendering/.test(raceTimeoutError.message)
      && raceTimeoutPptxCalls === 3 && raceTimeoutHealthCalls === 2,
    { message: raceTimeoutError && raceTimeoutError.message,
      raceTimeoutPptxCalls, raceTimeoutHealthCalls, raceClock });

  const permanentCalls = [];
  let permanentError = null;
  try {
    await client.requestPptxBlob({
      fetch: async (url) => {
        permanentCalls.push(url);
        return jsonResponse(500, { ok: false, error: 'render exploded safely' });
      },
    });
  } catch (error) { permanentError = error; }
  check('a permanent JSON error is surfaced without health polling or a file',
    permanentError && /render exploded safely/.test(permanentError.message)
      && JSON.stringify(permanentCalls) === JSON.stringify(['/api/pptx']),
    { message: permanentError && permanentError.message, permanentCalls });

  let okJsonError = null;
  try {
    await client.fetchBinaryDownload('/api/pptx', client.DOWNLOAD_PPTX_MIME,
      async () => jsonResponse(200, { error: 'JSON must never become a PowerPoint download' }));
  } catch (error) { okJsonError = error; }
  check('even HTTP 200 JSON is rejected instead of being saved as a PPTX',
    okJsonError && /JSON must never become/.test(okJsonError.message)
      && okJsonError.mime === 'application/json' && okJsonError.jsonReply === true);

  let timeoutError = null;
  let timeoutHealthCalls = 0;
  let timeoutPptxCalls = 0;
  try {
    await client.requestPptxBlob({
      timeoutMs: 2, pollMs: 1, sleep: async () => {},
      fetch: async (url) => {
        if (url === '/api/pptx') {
          timeoutPptxCalls += 1;
          return jsonResponse(409, { error: 'presentation is not current' });
        }
        timeoutHealthCalls += 1;
        return jsonResponse(200, { ok: true, presentation: { current: false } });
      },
    });
  } catch (error) { timeoutError = error; }
  check('stale polling is bounded and never retries PPTX before health is current',
    timeoutError && /still rendering/.test(timeoutError.message)
      && timeoutPptxCalls === 1 && timeoutHealthCalls >= 1 && timeoutHealthCalls <= 3,
    { message: timeoutError && timeoutError.message, timeoutPptxCalls, timeoutHealthCalls });

  let fakePptxError = null;
  try {
    await client.fetchBinaryDownload('/api/pptx', client.DOWNLOAD_PPTX_MIME,
      async () => binaryResponse(client.DOWNLOAD_PPTX_MIME, [0x7b, 0x22, 0x65, 0x72, 0x72]));
  } catch (error) { fakePptxError = error; }
  check('a spoofed PPTX MIME still needs a ZIP signature',
    fakePptxError && /valid PowerPoint/.test(fakePptxError.message));

  const pdfBlob = await client.fetchBinaryDownload('/api/pdf', client.DOWNLOAD_PDF_MIME,
    async () => pdfResponse());
  let jsonPdfError = null;
  try {
    await client.fetchBinaryDownload('/api/pdf', client.DOWNLOAD_PDF_MIME,
      async () => jsonResponse(404, { error: 'PDF is not exported' }));
  } catch (error) { jsonPdfError = error; }
  check('PDF uses the same MIME/signature gate and exposes JSON errors',
    pdfBlob.type === client.DOWNLOAD_PDF_MIME
      && jsonPdfError && /PDF is not exported/.test(jsonPdfError.message));

  const saved = { appended: false, clicked: false, removed: false, revoked: null };
  const link = {
    hidden: false, href: '', download: '',
    click() { saved.clicked = true; },
    remove() { saved.removed = true; },
  };
  client.saveDownloadBlob(pptxBlob, 'presentation.pptx', {
    document: {
      createElement: (tag) => { if (tag !== 'a') throw new Error('expected anchor'); return link; },
      body: { appendChild: (node) => { saved.appended = node === link; } },
    },
    URL: {
      createObjectURL: () => 'blob:unit-download',
      revokeObjectURL: (url) => { saved.revoked = url; },
    },
    defer: (fn) => fn(),
  });
  check('validated blobs download with the expected name and revoke their object URL',
    saved.appended && saved.clicked && saved.removed
      && link.download === 'presentation.pptx' && saved.revoked === 'blob:unit-download', saved);

  check('every PPTX control is a script-owned button with no navigation fallback',
    /<button[^>]+id="downloadBtn"[^>]+type="button"/.test(indexHtml)
      && /<button[^>]+id="downloadBtn"[^>]+type="button"/.test(studioHtml)
      && /<button[^>]+id="compactDownloadBtn"[^>]+type="button"/.test(studioHtml)
      && !/<a[^>]+(?:downloadBtn|compactDownloadBtn)/.test(indexHtml + studioHtml));
  check('both pages guard duplicate PPTX and PDF actions and never navigate to PDF JSON',
    /if \(pptxDownloadInFlight\) return pptxDownloadInFlight/.test(studioSource)
      && /if \(pptxDownloadInFlight\) return pptxDownloadInFlight/.test(appSource)
      && /if \(pdfExportInFlight\) return pdfExportInFlight/.test(studioSource)
      && /if \(pdfExportInFlight\) return pdfExportInFlight/.test(appSource)
      && !/window\.location\s*=\s*['"]\/api\/pdf/.test(studioSource + appSource)
      && /\['downloadBtn', 'compactDownloadBtn'\]/.test(studioSource));

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
    if (!item.ok && item.detail !== undefined) console.log(`      ${JSON.stringify(item.detail)}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
