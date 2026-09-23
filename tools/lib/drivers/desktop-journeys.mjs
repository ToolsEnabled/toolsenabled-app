import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import path from 'node:path';
import { readinessDigest } from '../release-readiness.mjs';

// These selectors were inspected in the current shipped renderer sources, not
// verified against an installed candidate. This module is NOT registered as a
// trusted production adapter. The guest owner must attest execution and verify
// its raw report before the qualification registry may accept that scope.
// No HTTP mutation, model injection, source overlay or host browser is used.
export const DESKTOP_JOURNEYS = Object.freeze({
  scribe: Object.freeze({
    entry: '/', source: 'website/software/scribe/public/{index.html,app.js}',
    capabilities: Object.freeze(['docx-import-export', 'provider-egress-denied']),
    assertions: Object.freeze(['create-edit-save-document', 'document-content-reopened-after-full-relaunch', 'supported-export-opens-correctly']),
    missingObligations: Object.freeze(['installed-claude-and-codex-editing-agent-journeys', 'installed-microphone-and-transcription', 'installed-watch-format-and-continuation-consent-journeys']),
  }),
  'web-editor': Object.freeze({
    entry: '/', source: 'website/software/web-editor/public/{index.html,web-app.js}',
    capabilities: Object.freeze(['authorized-real-provider', 'disposable-local-publish']),
    assertions: Object.freeze(['create-edit-preview-project', 'confirmed-publish-output-is-correct', 'project-content-reopened-after-full-relaunch']),
  }),
  'presentation-suite': Object.freeze({
    entry: '/studio', source: 'website/software/presentation-suite/public/{studio.html,studio.js}',
    capabilities: Object.freeze(['authorized-real-provider:claude', 'authorized-real-provider:codex', 'pptx-export-reader', 'pdf-export-reader']),
    assertions: Object.freeze(['create-edit-save-presentation', 'presentation-reopened-after-full-relaunch', 'advertised-export-and-agent-paths-work']),
  }),
  // Inspected in the current shipped ToolsEnabled renderer: computers route,
  // compose tier (not role), tree-box-chat tab, .chat-action rows, Halt chip.
  // Not a substitute for advertised-integrations or update-delivery.
  toolsenabled: Object.freeze({
    entry: '/', source: 'app/{src/views/home.js,src/views/computers.js,src/components.js,src/agent-compose-panel.js,src/tree-graph.js}',
    capabilities: Object.freeze(['authorized-real-provider']),
    assertions: Object.freeze(['installed-ui-starts-shipped-engine', 'supported-provider-start-response-stop', 'result-persists-after-full-relaunch']),
  }),
});

const HASH = /^[a-f0-9]{64}$/i;
const RUN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACCOUNT_PROFILE = path.win32.normalize(userInfo().homedir);
const PROFILES = new Set(['windows-x64-standard', 'windows-x64-administrator']);
const MAX_OUTPUT = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && a.toLowerCase() === b.toLowerCase();
const artifactEquals = (a, b) => sameHash(a?.sha256, b?.sha256) && a.bytes === b.bytes && Number.isSafeInteger(a.bytes) && a.bytes > 0;
const identityValid = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
  typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt));
const sameProcess = (a, b) => identityValid(a) && identityValid(b) && a.pid === b.pid && a.startedAt === b.startedAt;
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

function refuse(message, uncertain = false) {
  const error = new Error(`Desktop journey blocked: ${message}`);
  error.code = 'DESKTOP_JOURNEY_BLOCKED';
  error.cleanupUncertain = uncertain;
  throw error;
}

function bytesOf(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > MAX_OUTPUT) refuse('missing or oversized observed output bytes');
  return Buffer.from(value);
}

// Serialized into the OWNED installed renderer by Runtime.evaluate. Actions
// stay in CDP Input/DOM; this probe only reads, scrolls and checks focus. It does
// not call application functions, replace handlers, fetch APIs or change state.
function domProbe({ selector, frame, text, textSelector, scroll, focused, locationOnly, index }) {
  if (locationOnly) return { href: location.href, readyState: document.readyState };
  const visible = node => {
    if (!node || node.hidden || node.closest('[hidden], [inert]')) return false;
    const view = node.ownerDocument.defaultView;
    for (let cursor = node; cursor; cursor = cursor.parentElement) {
      const style = view.getComputedStyle(cursor);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return node.getClientRects().length > 0;
  };
  let doc = document;
  if (frame) {
    const frames = [...document.querySelectorAll(frame)];
    if (frames.length !== 1 || !frames[0].contentDocument || !visible(frames[0])) return [];
    doc = frames[0].contentDocument;
  }
  return [...doc.querySelectorAll(selector)].filter((node, at) => (index === undefined || index === at) && (text === undefined ||
    (textSelector ? node.querySelector(textSelector)?.textContent : node.textContent)?.trim() === text)).map(node => {
    if (scroll) node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    return {
      text: String(node.innerText ?? node.textContent ?? ''), value: node.value,
      tag: node.tagName, type: node.type, visible: visible(node),
      disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
      editable: !!node.isContentEditable || (['INPUT', 'TEXTAREA'].includes(node.tagName) && !node.readOnly),
      focused: focused ? node === doc.activeElement || node.contains(doc.activeElement) : undefined,
      classes: String(node.className || ''), data: { ...node.dataset },
      ariaPressed: node.getAttribute('aria-pressed'),
      title: node.getAttribute('title'),
      actionTool: node.closest('.chat-action:not(.chat-action-run)')?.querySelector('.chat-action-tool')?.textContent ?? null,
      imageLoaded: node.tagName === 'IMG' ? node.complete && node.naturalWidth > 0 && node.naturalHeight > 0 : undefined,
      point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    };
  });
}

// A tiny standards-shaped, stored ZIP DOCX is test INPUT, not an alternate
// document host. The installed product must import, edit, export and reopen it.
export function scribeInputDocument(text) {
  if (typeof text !== 'string' || !text || text.length > 4096) refuse('invalid seed document text');
  const xml = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${xml}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`],
  ];
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

async function execute(options, fixture) {
  const { product, profile, subject: suppliedSubject, runId, journeyId, guest, signal } = options || {};
  const contract = DESKTOP_JOURNEYS[product];
  if (!contract || !Object.hasOwn(DESKTOP_JOURNEYS, product)) refuse('unknown desktop product');
  if (!PROFILES.has(profile) || !RUN.test(runId || '')) refuse('missing supported profile or qualification run identity');
  if (suppliedSubject && Object.hasOwn(suppliedSubject, 'installer')) refuse('ambiguous or legacy installer identity; the canonical measured subject uses artifact only');
  if (!suppliedSubject || !HASH.test(suppliedSubject.runtimeSha256 || '') || !HASH.test(suppliedSubject.shellSha256 || '') || !artifactEquals(suppliedSubject.artifact, suppliedSubject.artifact)) refuse('missing exact installed subject');
  const subject = freeze(structuredClone(suppliedSubject));
  if (guest?.mode !== (fixture ? 'fixture' : 'attested-disposable-guest')) refuse('an attested disposable guest is required; fixtures are not production execution');
  const requiredMethods = ['assertCapabilities', 'launch', 'stop', 'quarantine'];
  if (!fixture) requiredMethods.push('verifyObservation');
  if (product === 'scribe' || product === 'toolsenabled') requiredMethods.push('stageInput');
  if (product !== 'web-editor' && product !== 'toolsenabled') requiredMethods.push('armDownload', 'collectDownload');
  if (product !== 'scribe') requiredMethods.push('readProductOutput', 'collectProviderEvidence');
  if (product === 'presentation-suite') requiredMethods.push('openExport');
  for (const method of requiredMethods) if (typeof guest[method] !== 'function') refuse(`guest capability method is unavailable: ${method}`);
  const epoch = options.epoch && freeze(structuredClone(options.epoch));
  if (!RUN.test(journeyId || '') || journeyId === runId || !epoch || epoch.kind !== 'baseline-reset' ||
      typeof epoch.observationId !== 'string' || !epoch.observationId || epoch.runId !== runId ||
      typeof epoch.guestId !== 'string' || !epoch.guestId || typeof epoch.phaseId !== 'string' || !epoch.phaseId || !RUN.test(epoch.epochId || '') ||
      epoch.journeyId !== null || epoch.synthetic !== fixture || !epoch.baselineId || epoch.restored !== true ||
      epoch.ownedJobsRemaining !== 0 || epoch.cleanUserData !== true || epoch.accountProfile !== ACCOUNT_PROFILE) refuse('a distinct journey identity and controller-issued baseline epoch observation are required');
  // The real shared shell allows Scribe/Presentation servers 60 seconds to
  // start. A shorter generic RPC deadline would reject that supported startup
  // before the product's own deadline. Callers may set smaller measured budgets.
  const timeoutMs = options.timeoutMs ?? 300000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 65000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10000;
  if (![timeoutMs, operationTimeoutMs, cleanupTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0) || timeoutMs > 600000 || cleanupTimeoutMs > 60000) refuse('invalid bounded execution budget');
  const deadline = Date.now() + timeoutMs;
  const subjectSha256 = readinessDigest(subject);
  const binding = freeze({ product, profile, runId, subjectSha256, journeyId, guestId: epoch.guestId, phaseId: epoch.phaseId, epochId: epoch.epochId });
  const report = {
    schema: 'toolsenabled.desktop-journey-report', schemaVersion: 1, ...binding,
    scope: fixture ? 'synthetic-driver-fixture' : 'exact-installed-desktop-journey',
    // "complete" below means only this named critical journey completed. Never
    // interpret it as the aggregate product/installer/integration matrix.
    fullProductCoverage: false, missingObligations: [...(contract.missingObligations || [])],
    fixture, complete: false, cleanupConfirmed: false, assertions: [], observations: [], outputs: [], launches: [], executionObservations: [],
    epoch: { observationId: epoch.observationId, sha256: readinessDigest(epoch) },
    startedAt: new Date().toISOString(),
  };
  let current = null, uncertain = false, failure = null;
  const guestId = epoch.guestId, pending = new Set(), observationIds = new Set([epoch.observationId]);
  async function bounded(label, action, cleanup = false) {
    const remaining = cleanup ? cleanupTimeoutMs : Math.min(operationTimeoutMs, deadline - Date.now());
    if (remaining <= 0 || (!cleanup && signal?.aborted)) refuse(`${label}: execution budget expired or cancelled`, true);
    let timer, abort;
    const operation = Promise.resolve().then(action);
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        const cancel = reason => {
          const error = new Error(`Desktop journey blocked: ${label}: ${reason}`);
          error.code = 'DESKTOP_JOURNEY_BLOCKED'; error.cleanupUncertain = true; reject(error);
        };
        timer = setTimeout(() => cancel('timed out'), remaining);
        if (!cleanup && signal) { abort = () => cancel('cancelled'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  const scopeMatches = value => value && ['product', 'profile', 'runId', 'guestId', 'phaseId', 'epochId', 'journeyId', 'subjectSha256'].every(key => value[key] === binding[key]);
  async function observation(value, kind, cleanup = false) {
    if (!scopeMatches(value) || value.kind !== kind || value.synthetic !== fixture || typeof value.observationId !== 'string' ||
        !value.observationId || observationIds.has(value.observationId)) refuse(`${kind}: missing, stale or mismatched raw guest observation`, !!current);
    if (!fixture && await bounded(`verify ${kind}`, () => guest.verifyObservation(value, { ...binding, kind, root: false }), cleanup) !== true) refuse(`${kind}: trusted guest evidence verification failed`, !!current);
    observationIds.add(value.observationId);
    report.executionObservations.push({ kind, observationId: value.observationId, sha256: readinessDigest(value) });
    return value;
  }
  const cdp = (method, params = {}) => bounded(method, () => current.cdp.send(method, params, { signal }));
  async function rows(spec) {
    const result = await cdp('Runtime.evaluate', { expression: `(${domProbe.toString()})(${JSON.stringify(spec)})`, returnByValue: true });
    if (result.exceptionDetails || !result.result || !Object.hasOwn(result.result, 'value')) refuse('owned renderer DOM probe failed');
    return result.result.value;
  }
  async function one(spec, action = false) {
    const found = await rows({ ...spec, scroll: action });
    const visible = Array.isArray(found) ? found.filter(row => row.visible) : [];
    if (visible.length !== 1 || (action && visible[0].disabled)) refuse(`missing, ambiguous, hidden or disabled UI: ${spec.selector}`);
    return visible[0];
  }
  async function waitFor(label, probe) {
    for (;;) {
      if (Date.now() >= deadline) refuse(`${label}: expected product output was not observed`);
      const value = await probe();
      if (value) return value;
      // A local polling timer is not a possibly executing guest command. Do not
      // turn ordinary missing output into fictitious process uncertainty.
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(50, deadline - Date.now()))));
    }
  }
  async function click(spec) {
    const { point } = await one(spec, true);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }
  async function key(keyName, code, modifiers = 0) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, windowsVirtualKeyCode: code, modifiers });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, windowsVirtualKeyCode: code, modifiers });
  }
  async function fill(spec, text) {
    await click(spec);
    const target = await one({ ...spec, focused: true });
    if (!target.editable || !target.focused) refuse(`UI did not acquire editable focus: ${spec.selector}`);
    await key('a', 65, 2);
    await cdp('Input.insertText', { text });
  }
  async function chooseEnabled(spec, accept) {
    const options = await rows({ selector: `${spec.selector} option` });
    const enabled = options.filter(row => !row.disabled && accept(row));
    if (!enabled.length) refuse(`no enabled supported option in ${spec.selector}`);
    const wanted = enabled[0].value;
    await click(spec);
    const focused = await one({ ...spec, focused: true });
    if (focused.tag !== 'SELECT' || !focused.focused) refuse(`select did not take focus: ${spec.selector}`);
    await key('Home', 36);
    for (let step = 0; step < 32; step++) {
      const current = await one(spec);
      if (current.value === wanted && !current.disabled) {
        await key('Enter', 13);
        const committed = await one(spec);
        if (committed.value !== wanted || committed.disabled) refuse(`select did not commit option ${wanted}`);
        return committed;
      }
      await key('ArrowDown', 40);
    }
    refuse(`select ${spec.selector} did not keep enabled option ${wanted}`);
  }
  async function screenshot(label) {
    const result = await cdp('Page.captureScreenshot', { format: 'png' });
    const bytes = bytesOf(Buffer.from(result.data || '', 'base64'));
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) refuse('renderer screenshot is not PNG evidence');
    const evidence = { kind: 'installed-renderer-screenshot', label, sha256: hash(bytes), bytes: bytes.length };
    report.outputs.push(evidence);
    return evidence;
  }
  function passed(id, evidence) {
    if (!contract.assertions.includes(id) || report.assertions.some(row => row.id === id)) refuse('wrong or duplicate journey assertion');
    report.assertions.push({ id, status: 'passed', evidenceSha256: readinessDigest(evidence) });
    report.observations.push({ id, evidence });
  }
  function validateOwnedOutput(output) {
    const bytes = bytesOf(output?.bytes);
    if (output.owned !== true || !scopeMatches(output) || !sameHash(output.sha256, hash(bytes))) refuse('guest output identity or measured bytes differ');
    return bytes;
  }
  async function output(kind, relativePath, nodeId) {
    const value = await bounded(`read ${kind}`, () => guest.readProductOutput(current, { ...binding, kind, relativePath, ...(nodeId ? { nodeId } : {}), maxBytes: MAX_OUTPUT }));
    const bytes = validateOwnedOutput(value);
    if (nodeId && value.nodeId !== nodeId) refuse('conversation output belongs to another node');
    const evidence = { kind, relativePath, ...(nodeId ? { nodeId } : {}), sha256: hash(bytes), bytes: bytes.length };
    report.outputs.push(evidence);
    return { bytes, evidence };
  }
  async function launch(previous) {
    try { current = await bounded('launch exact installed desktop', () => guest.launch({ ...binding, subject, signal })); }
    catch (error) { uncertain = true; throw error; }
    const a = current?.attestation;
    if (a && Object.hasOwn(a, 'installer')) refuse('ambiguous or legacy installer identity in runtime observation; artifact only is required');
    if (!current?.id || typeof current.cdp?.send !== 'function' || typeof current.cdp?.on !== 'function' || !a || a.sessionId !== current.id ||
        a.installed !== true || a.exact !== true || a.isolated !== true || a.synthetic !== fixture || a.sourceOverlay !== false || a.hostRuntime !== false ||
        a.token !== (profile.endsWith('administrator') ? 'administrator' : 'standard') ||
        !artifactEquals(a.artifact, subject.artifact) || !sameHash(a.runtimeSha256, subject.runtimeSha256) || !sameHash(a.shellSha256, subject.shellSha256) ||
        !identityValid(a.process) || (product !== 'toolsenabled' && (!identityValid(a.serverProcess) || sameProcess(a.process, a.serverProcess))) || !a.userDataIdentity ||
        Object.hasOwn(a, 'processIdentity') || Object.hasOwn(a, 'serverIdentity') ||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(a.origin || '')) refuse('installed Electron/server ownership and exact-byte attestation are incomplete');
    await observation(a, 'runtime-launch');
    if (previous && (current.id === previous.id || a.userDataIdentity !== previous.attestation.userDataIdentity ||
        sameProcess(a.process, previous.attestation.process) || (product !== 'toolsenabled' && sameProcess(a.serverProcess, previous.attestation.serverProcess)))) refuse(product === 'toolsenabled' ? 'full relaunch did not create a new Electron process over the same durable user data' : 'full relaunch did not create new Electron AND server processes over the same durable user data');
    report.launches.push({ sessionId: current.id, attestation: a });
    const location = await rows({ locationOnly: true });
    if (!location.href?.startsWith(`${a.origin}/`) || new URL(location.href).pathname.startsWith('/setup') || (product === 'toolsenabled' && location.href.includes('#/setup'))) refuse('installed UI did not finish actual onboarding at its owned origin');
    if (contract.entry !== '/') {
      const navigation = await cdp('Page.navigate', { url: `${a.origin}${contract.entry}` });
      if (navigation.errorText) refuse('installed product route failed to navigate');
      await waitFor('installed product route', async () => new URL((await rows({ locationOnly: true })).href).pathname === contract.entry);
    }
    // ToolsEnabled restores its last owned hash route. Do not require `.home`
    // on every launch; the journey navigates `#/computers` explicitly.
    if (product !== 'toolsenabled') {
      const readySelector = product === 'scribe' ? '#doc-name' : product === 'web-editor' ? '#composer input' : '#chatinput';
      await waitFor('installed ready controls', async () => (await rows({ selector: readySelector })).filter(row => row.visible).length === 1);
    }
  }
  async function stop() {
    const owned = current;
    if (!owned) return null;
    const result = await observation(await bounded('stop owned installed desktop and helpers', () => guest.stop(owned, { ...binding, timeoutMs: cleanupTimeoutMs }), true), 'runtime-stop', true);
    if (result?.sessionId !== owned.id || !sameProcess(result.process, owned.attestation.process) ||
        (product !== 'toolsenabled' && !sameProcess(result.serverProcess, owned.attestation.serverProcess)) ||
        result.terminationConfirmed !== true || result.ownedChildrenConfirmed !== true) refuse('owned Electron/server/helper cleanup was not confirmed', true);
    current = null;
    return owned;
  }
  async function relaunch() { const previous = await stop(); await launch(previous); }
  async function upload(path) {
    const inputs = await rows({ selector: '#doc-file' });
    if (inputs.length !== 1 || inputs[0].type !== 'file') refuse('Scribe file input is absent or ambiguous');
    const tree = await cdp('DOM.getDocument');
    const found = await cdp('DOM.querySelector', { nodeId: tree.root.nodeId, selector: '#doc-file' });
    if (!found.nodeId) refuse('Scribe upload input could not be resolved');
    await cdp('Network.enable');
    const requestIds = new Set(), completedIds = new Set(), failedIds = new Set();
    let removeResponse;
    const removeRequest = current.cdp.on('Network.requestWillBeSent', event => {
      if (event.request?.method === 'POST' && event.request.url === `${current.attestation.origin}/api/upload`) requestIds.add(event.requestId);
    });
    const response = new Promise(resolve => {
      removeResponse = current.cdp.on('Network.responseReceived', event => {
        if (requestIds.has(event.requestId) && event.response?.url === `${current.attestation.origin}/api/upload`) resolve(event);
      });
    });
    const removeFinished = current.cdp.on('Network.loadingFinished', event => completedIds.add(event.requestId));
    const removeFailed = current.cdp.on('Network.loadingFailed', event => failedIds.add(event.requestId));
    try {
      if ([removeRequest, removeResponse, removeFinished, removeFailed].some(remove => typeof remove !== 'function')) refuse('owned upload network observation is unavailable');
      await cdp('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path] });
      const completed = await bounded('installed document import response', () => response);
      if (completed.response.status !== 200) refuse('installed document import failed');
      await waitFor('complete import response body', () => {
        if (failedIds.has(completed.requestId)) refuse('installed document import transport failed');
        return completedIds.has(completed.requestId);
      });
      const body = await cdp('Network.getResponseBody', { requestId: completed.requestId });
      let receipt;
      try { receipt = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body); }
      catch { refuse('installed document import response was not readable'); }
      if (receipt?.uploaded !== true || typeof receipt.path !== 'string' || !receipt.path ||
          typeof receipt.document_token !== 'string' || !receipt.document_token) refuse('installed importer did not confirm new document ownership');
      const evidence = { kind: 'installed-document-import', requestId: completed.requestId, responseSha256: readinessDigest(receipt) };
      report.outputs.push(evidence);
      return evidence;
    } finally {
      for (const remove of [removeRequest, removeResponse, removeFinished, removeFailed]) if (typeof remove === 'function') remove();
    }
  }
  async function download(extension, action) {
    const ticket = await bounded('arm owned download', () => guest.armDownload(current, { ...binding, extension }));
    if (!scopeMatches(ticket) || ticket.owned !== true || !ticket.id || ticket.extension !== extension) refuse('owned download ticket belongs to a different execution scope');
    await action();
    const result = await bounded('collect owned download', () => guest.collectDownload(current, ticket, { ...binding, maxBytes: MAX_OUTPUT }));
    const bytes = validateOwnedOutput(result);
    if (typeof result.path !== 'string' || !result.path.toLowerCase().endsWith(extension) ||
        (extension === '.pdf' ? bytes.subarray(0, 5).toString() !== '%PDF-' : bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)) refuse('download is not the expected document format');
    report.outputs.push({ kind: 'download', extension, sha256: hash(bytes), bytes: bytes.length });
    return result;
  }
  async function readRevision(selector) {
    const row = await one({ selector });
    const match = /^(?:rev(?:ision)?)\s+(\d+)$/i.exec(row.text.trim());
    if (!match || !Number.isSafeInteger(Number(match[1]))) refuse('visible revision was not measured');
    return Number(match[1]);
  }
  async function waitText(selector, text, extra = {}) {
    return waitFor(`visible ${selector} content`, async () => {
      const found = await rows({ selector, ...extra });
      return found.length === 1 && found[0].visible && found[0].text.trim() === text ? found[0] : false;
    });
  }
  const token = journeyId.replaceAll('-', '');
  async function providerEvidence(provider, request) {
    const requestSha256 = hash(request);
    const evidence = await bounded('collect real provider execution evidence', () => guest.collectProviderEvidence(current, { ...binding, provider, requestSha256 }));
    if (evidence?.complete !== true || evidence.synthetic !== fixture || !scopeMatches(evidence) ||
        !['claude', 'codex'].includes(evidence.provider) || (provider && evidence.provider !== provider) || !sameHash(evidence.requestSha256, requestSha256) ||
        !HASH.test(evidence.executableSha256 || '') || !HASH.test(evidence.responseSha256 || '') || !HASH.test(evidence.reportSha256 || '')) refuse('the observed edit is not bound to complete real provider execution');
    report.outputs.push({ kind: 'provider-execution', ...evidence });
    return evidence;
  }
  try {
    // Matching UUIDs do not authorize execution. The existing trusted verifier
    // must bind the supplied reset observation to its host-owned epoch ledger.
    if (!fixture && await bounded('verify controller baseline epoch', () => guest.verifyObservation(epoch, {
      runId, guestId, phaseId: epoch.phaseId, epochId: epoch.epochId, journeyId: null, kind: 'baseline-reset', root: false,
    })) !== true) refuse('controller baseline epoch was not verified');
    if (await bounded('authorized capability preflight', () => guest.assertCapabilities({ ...binding, requirements: [...contract.capabilities], fixture })) !== true) refuse('required authorized capabilities were not confirmed');
    await launch();
    if (product === 'scribe') {
      const seed = `Readiness original ${token}`, edited = `Readiness edited ${token}`;
      const input = scribeInputDocument(seed);
      const staged = await bounded('stage owned input document', () => guest.stageInput({ ...binding, name: `readiness-${token}.docx`, bytes: input }));
      if (!staged?.path || staged.owned !== true || !scopeMatches(staged) || !sameHash(staged.sha256, hash(input))) refuse('input document ownership or bytes are unverified');
      await upload(staged.path);
      await waitText('#paper .para', seed);
      const before = await readRevision('#rev');
      await fill({ selector: '#paper .para' }, edited);
      await key('Enter', 13);
      await waitFor('Scribe saved revision and paragraph', async () => {
        const paragraph = await one({ selector: '#paper .para' });
        return paragraph.text === edited && !/\b(?:dirty|saving|save-error)\b/.test(paragraph.classes) && await readRevision('#rev') > before;
      });
      const savedRevision = await readRevision('#rev');
      const exported = await download('.docx', async () => {
        await click({ selector: '#save-original' });
        await one({ selector: '#save-dialog[open]' });
        await click({ selector: '#save-dialog-confirm' });
      });
      passed(contract.assertions[0], { savedRevision, textSha256: hash(edited), exportedSha256: exported.sha256, screenshot: await screenshot('saved-document') });
      await relaunch();
      await waitText('#paper .para', edited);
      if (await readRevision('#rev') !== savedRevision) refuse('Scribe reopened a different saved revision');
      passed(contract.assertions[1], { savedRevision, textSha256: hash(edited), launches: report.launches, screenshot: await screenshot('reopened-document') });
      // Reopen the ACTUAL exported bytes through the product's normal importer,
      // not a fake DOCX header check or the still-open in-memory paragraph.
      const importedExport = await upload(exported.path);
      await waitText('#paper .para', edited);
      passed(contract.assertions[2], { exportedSha256: exported.sha256, importedExport, reopenedTextSha256: hash(edited), screenshot: await screenshot('opened-export') });
    } else if (product === 'web-editor') {
      const relativePath = `qualification-${token}.html`;
      const created = `Created ${token}`, edited = `Edited ${token}`, body = `Durable content ${token}`;
      const frame = 'iframe[title="Live website preview"]';
      const before = await readRevision('#revision');
      async function brief(heading, create) {
        const request = `${create ? 'Create a new page in this project' : 'Edit the existing page'} using exactly this JSON specification: ${JSON.stringify({ path: relativePath, heading, body })}. The heading must be the sole h1 and body the sole paragraph. Save the working copy; do not publish it.`;
        await fill({ selector: '#composer input' }, request);
        await click({ selector: '#composer button[aria-label="Send request"]' });
        await waitFor('real agent completion', async () => (await rows({ selector: '#composer .agent-orb' }))[0]?.data.state === 'complete');
        const receipt = await rows({ selector: '#receipt .keep' });
        if (receipt.length === 1 && receipt[0].visible) await click({ selector: '#receipt .keep' });
        await click({ selector: '#files button.file', textSelector: 'code', text: relativePath });
        await waitText('h1', heading, { frame });
        await waitText('p', body, { frame });
        await providerEvidence(null, request);
      }
      await brief(created, true);
      if (await readRevision('#revision') <= before) refuse('creating the page did not advance the saved revision');
      const createdRevision = await readRevision('#revision');
      await brief(edited, false);
      const savedRevision = await readRevision('#revision');
      if (savedRevision <= createdRevision) refuse('editing the page did not advance the saved revision');
      const working = await output('working-file', relativePath);
      if (!working.bytes.toString('utf8').includes(edited) || !working.bytes.toString('utf8').includes(body)) refuse('working file does not contain the rendered customer content');
      passed(contract.assertions[0], { savedRevision, working: working.evidence, screenshot: await screenshot('edited-project-preview') });
      if (typeof current.cdp.on !== 'function') refuse('owned CDP dialog observation is unavailable');
      await cdp('Page.enable');
      let unsubscribe;
      const dialog = new Promise(resolve => { unsubscribe = current.cdp.on('Page.javascriptDialogOpening', resolve); });
      if (typeof unsubscribe !== 'function') refuse('dialog observer cannot be removed');
      try {
        await click({ selector: '#publish' });
        const opened = await bounded('explicit publish confirmation dialog', () => dialog);
        if (opened.type !== 'confirm' || !opened.message?.startsWith('Publish these changes?')) refuse('publish did not request the expected confirmation');
        await cdp('Page.handleJavaScriptDialog', { accept: true });
        await waitText('#live-state', 'live site up to date');
        const published = await output('published-file', relativePath);
        if (!published.bytes.equals(working.bytes)) refuse('confirmed publish output differs from the edited working copy');
        passed(contract.assertions[1], { dialog: opened, published: published.evidence });
      } finally { unsubscribe(); }
      await relaunch();
      await click({ selector: '#files button.file', textSelector: 'code', text: relativePath });
      await waitText('h1', edited, { frame }); await waitText('p', body, { frame });
      if (await readRevision('#revision') !== savedRevision) refuse('Web Editor reopened a different saved revision');
      const reopened = await output('working-file', relativePath);
      if (!reopened.bytes.equals(working.bytes)) refuse('working project bytes did not survive full relaunch');
      passed(contract.assertions[2], { savedRevision, working: reopened.evidence, launches: report.launches, screenshot: await screenshot('reopened-project') });
    } else if (product === 'toolsenabled') {
      // The file name is public to the model; its challenge bytes are not.
      const challenge = `TE-HOST-${randomBytes(24).toString('hex')}`;
      const challengeBytes = Buffer.from(`qualification-challenge ${challenge}\n`);
      const staged = await bounded('stage owned challenge file', () => guest.stageInput({ ...binding, name: `readiness-${token}.txt`, bytes: challengeBytes }));
      if (!staged?.path || staged.owned !== true || !scopeMatches(staged) || !sameHash(staged.sha256, hash(challengeBytes))) refuse('challenge file ownership or bytes are unverified');
      if (String(staged.path).includes(challenge)) refuse('staged path must not disclose the challenge');
      const request = `Use the ToolsEnabled host.read_file tool to read this exact path and show the file contents: ${staged.path}`;
      if (request.includes(challenge)) refuse('the prompt must not disclose the challenge');
      const launchObservation = report.executionObservations.find(row => row.kind === 'runtime-launch');
      if (!launchObservation) refuse('installed UI launch was not a verified runtime-launch observation');
      const nodeSelector = id => `.static-tree-node[data-agent-id="${id}"]`;
      const chatSelector = id => `.tree-conversation[data-agent-id="${id}"]`;
      async function openComputers() {
        const url = `${current.attestation.origin}/#/computers`;
        const navigation = await cdp('Page.navigate', { url });
        if (navigation.errorText) refuse('installed computers route failed to navigate');
        await waitFor('computers route', async () => (await rows({ locationOnly: true })).href === url);
        await waitFor('computers tree controls', async () => (await rows({ selector: '.tree-chat-add' }))
          .filter(row => row.visible && !row.disabled).length === 1);
      }
      async function agentIds() {
        return (await rows({ selector: '.static-tree-node[data-agent-id]' })).map(row => row.data.agentId).filter(Boolean);
      }
      async function openNodeChat(id) {
        await waitFor('owned node on the canvas', async () => (await rows({ selector: nodeSelector(id) })).filter(row => row.visible).length === 1);
        const button = { selector: `${nodeSelector(id)} .tree-box-chat` };
        if ((await rows(button)).some(row => row.visible)) await click(button);
        else {
          // Circle mode opens chat by a real double-click on the node.
          const { point } = await one({ selector: nodeSelector(id) }, true);
          for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount });
          }
        }
        await waitFor('created node chat tab', async () => {
          const tab = await rows({ selector: `.tree-chat-tab[data-agent-id="${id}"]` });
          const input = await rows({ selector: `${chatSelector(id)} .chat-input input` });
          return tab.some(row => row.visible) && input.some(row => row.visible && row.editable);
        });
      }
      const supportedTier = row => {
        const label = `${row.value || ''} ${row.text || ''}`;
        if (/gemini|^agy-/i.test(label) || row.disabled) return false;
        return /^(astra|luna|terra|sol|claude-)/i.test(String(row.value || '')) || /codex|claude/i.test(label);
      };
      await openComputers();
      // Each phase owns its new node. A restored baseline node may be an
      // unavailable provider, a failed start or somebody else's conversation.
      const before = new Set(await agentIds());
      await click({ selector: '.tree-chat-add' });
      await click({ selector: '.tree-new-tree' });
      await one({ selector: '[data-compose-action="start"]' });
      const tier = await chooseEnabled({ selector: '[data-compose-field="tier"]' }, supportedTier);
      if (/gemini|^agy-/i.test(tier.value)) refuse('Gemini is not a supported provider for this journey');
      await fill({ selector: '[data-compose-field="message"]' }, request);
      await click({ selector: '[data-compose-action="start"]' });
      const nodeId = await waitFor('created tree node', async () => {
        const created = (await agentIds()).filter(id => !before.has(id));
        if (created.length > 1) refuse('Start created more than one journey node');
        return created[0] || false;
      });
      await openNodeChat(nodeId);
      const composer = { selector: `${chatSelector(nodeId)} .chat-input input` };
      const send = { selector: `${chatSelector(nodeId)} .chat-send` };
      async function toolAction(label) {
        return waitFor(label, async () => {
          const details = await rows({ selector: `${chatSelector(nodeId)} .chat-action-detail` });
          const hit = details.find(row => row.visible && row.text.includes(staged.path));
          if (hit && /^(?:read_file|Read|Step|Tool)$/i.test(hit.actionTool?.trim() || '')) return hit;
          // Completed multi-tool runs fold before the reply is shown. Open
          // their real disclosure controls instead of calling hidden rows proof.
          const folds = { selector: `${chatSelector(nodeId)} .chat-action-run:not([open]) > .chat-action-head` };
          const heads = await rows(folds);
          const index = heads.findIndex(row => row.visible && !row.disabled);
          if (index >= 0) await click({ ...folds, index });
          return false;
        });
      }
      // Start already submitted the request. Await its result without
      // queueing a duplicate while the provider is still starting.
      const firstTool = await toolAction('host.read_file action for the staged path');
      const evidence = await bounded('collect real provider host-tool evidence', () => guest.collectProviderEvidence(current, {
        ...binding, nodeId, desktopSessionId: current.id, requestSha256: hash(request), tool: 'host.read_file', path: staged.path,
      }));
      const verified = await observation(evidence, 'provider-execution');
      if (verified?.complete !== true || verified.synthetic !== fixture || !scopeMatches(verified) ||
          !['claude', 'codex'].includes(verified.provider) || /gemini/i.test(String(verified.provider || '')) ||
          verified.nodeId !== nodeId || verified.desktopSessionId !== current.id ||
          verified.tool !== 'host.read_file' || verified.path !== staged.path ||
          !sameHash(verified.requestSha256, hash(request)) || !sameHash(verified.outputSha256, hash(challengeBytes)) ||
          !sameHash(verified.runtimeSha256, subject.runtimeSha256) || !sameHash(verified.shellSha256, subject.shellSha256) ||
          !HASH.test(verified.executableSha256 || '') || !HASH.test(verified.responseSha256 || '') || !HASH.test(verified.reportSha256 || '') ||
          !identityValid(verified.engineProcess) || sameProcess(verified.engineProcess, current.attestation.process)) {
        refuse('collectProviderEvidence did not bind host.read_file, the staged path, the file bytes, and the shipped engine worker');
      }
      report.outputs.push({ kind: 'provider-execution', ...verified });
      passed(contract.assertions[0], {
        launch: launchObservation, runtimeSha256: current.attestation.runtimeSha256,
        shellSha256: current.attestation.shellSha256, process: current.attestation.process, origin: current.attestation.origin,
        engineProcess: verified.engineProcess, providerObservationId: verified.observationId, providerObservationSha256: readinessDigest(verified),
      });
      await waitText(`${chatSelector(nodeId)} [data-chat-header-status]`, 'finished');
      const followUp = `Read the same path again with host.read_file: ${staged.path}`;
      await fill(composer, followUp);
      await click(send);
      await waitFor('later turn is actually running', async () => {
        const running = (await rows({ selector: `${chatSelector(nodeId)} [data-chat-header-status]` })).some(row => row.visible && /^running$/i.test(row.text.trim()));
        const halt = (await rows({ selector: `${chatSelector(nodeId)} [data-chat-chip="halt"]` })).filter(row => row.visible && !row.disabled);
        return running && halt.length === 1;
      });
      await click({ selector: `${chatSelector(nodeId)} [data-chat-chip="halt"]` });
      const stopped = await waitFor('Halt interrupted the later turn', async () => {
        const states = await rows({ selector: `${chatSelector(nodeId)} [data-chat-header-status]` });
        return states.find(row => row.visible && /stopped by you/i.test(row.text)) || false;
      });
      passed(contract.assertions[1], {
        nodeId, provider: verified.provider, tool: verified.tool, path: staged.path,
        outputSha256: verified.outputSha256, executableSha256: verified.executableSha256,
        runtimeSha256: verified.runtimeSha256, shellSha256: verified.shellSha256,
        engineProcess: verified.engineProcess, interrupted: stopped.text, firstTool: firstTool.text,
        launch: launchObservation,
      });
      await relaunch();
      await openComputers();
      await openNodeChat(nodeId);
      const restored = await toolAction('durable host.read_file action after relaunch');
      const conversation = await output('conversation', undefined, nodeId);
      const text = conversation.bytes.toString('utf8');
      if (!text.includes(challenge) || !text.includes(staged.path) || !/host\.read_file|read_file/.test(text)) {
        refuse('durable conversation did not retain the host.read_file result');
      }
      passed(contract.assertions[2], {
        nodeId, path: staged.path, conversation: conversation.evidence,
        restoredDetailSha256: hash(restored.text), launches: report.launches,
      });
    } else if (product === 'presentation-suite') {
      const created = `Created ${token}`, edited = `Edited ${token}`, body = `Durable slide content ${token}`;
      const before = await readRevision('#revLabel');
      async function renderedSlide() {
        return waitFor('real current rendered slide', async () => {
          const images = await rows({ selector: '#deck .card .frame img' });
          const freshness = await rows({ selector: '#staleDot' });
          return images.length === 1 && images[0].visible && images[0].imageLoaded &&
            freshness.length === 1 && freshness[0].visible && !/\b(?:amber|red)\b/.test(freshness[0].classes) &&
            freshness[0].title === 'slide previews match the live deck';
        });
      }
      const providers = (await rows({ selector: '[data-provider]' })).filter(row => row.visible).map(row => row.data.provider);
      if (new Set(providers).size !== 2 || providers.some(name => !['claude', 'codex'].includes(name))) refuse('the advertised provider matrix is missing or has an unknown path');
      async function brief(title, create, provider) {
        await click({ selector: `[data-provider="${provider}"]` });
        await waitFor('provider selected for next owned spawn', async () => /\bactive\b/.test((await one({ selector: `[data-provider="${provider}"]` })).classes));
        const request = `${create ? 'Create a new presentation with one slide' : 'Edit the presentation and its slide'} using exactly this JSON specification: ${JSON.stringify({ title, slideTitle: title, body })}. Save and finish rendering it. Do not use a fixture engine or substitute output.`;
        await fill({ selector: '#chatinput' }, request);
        await click({ selector: '#chatSend' });
        await waitText('#deckTitle', title);
        await renderedSlide();
        await providerEvidence(provider, request);
      }
      await brief(created, true, 'claude');
      const createdRevision = await readRevision('#revLabel');
      if (createdRevision <= before) refuse('creating the presentation did not advance its revision');
      // Provider changes apply to the next spawn only. A real process boundary
      // prevents a previous provider's still-running team from doing this edit.
      await relaunch();
      await waitText('#deckTitle', created);
      await brief(edited, false, 'codex');
      const savedRevision = await readRevision('#revLabel');
      if (savedRevision <= createdRevision) refuse('editing the presentation did not advance its revision');
      function assertModel(bytes) {
        let model;
        try { model = JSON.parse(bytes.toString('utf8')); } catch { refuse('saved presentation model is not readable'); }
        if (model.title !== edited || model.rev !== savedRevision || model.slides?.length !== 1 || !model.slides[0].id ||
            !model.slides[0].elements?.some(row => row.text === edited) || !model.slides[0].elements?.some(row => row.text === body)) refuse('saved presentation content differs from the requested rendered deck');
        return { title: model.title, rev: model.rev, slideId: model.slides[0].id,
          elements: model.slides[0].elements.map(row => ({ id: row.id, type: row.type, text: row.text, items: row.items })) };
      }
      const saved = await output('presentation-model'); const savedContent = assertModel(saved.bytes);
      passed(contract.assertions[0], { savedRevision, model: saved.evidence, screenshot: await screenshot('saved-presentation') });
      await relaunch();
      await waitText('#deckTitle', edited);
      await renderedSlide();
      if (await readRevision('#revLabel') !== savedRevision) refuse('Presentation Studio reopened a different revision');
      const reopened = await output('presentation-model'); const reopenedContent = assertModel(reopened.bytes);
      // Incidental serialization/metadata may change on startup. Compare the
      // durable customer content/identities, while retaining BOTH raw hashes.
      if (readinessDigest(reopenedContent) !== readinessDigest(savedContent)) refuse('presentation content or identities changed across full relaunch');
      passed(contract.assertions[1], { model: reopened.evidence, savedModel: saved.evidence,
        contentSha256: readinessDigest(reopenedContent), launches: report.launches, screenshot: await screenshot('reopened-presentation') });
      const exports = [];
      for (const [extension, selector] of [['.pptx', '#downloadBtn'], ['.pdf', '#exportPdfBtn']]) {
        const exported = await download(extension, () => click({ selector }));
        const opened = await bounded(`open actual ${extension} export`, () => guest.openExport(current, { ...binding, download: exported, format: extension.slice(1) }));
        if (opened?.opened !== true || opened.synthetic !== fixture || !scopeMatches(opened) ||
            opened.cleanupConfirmed !== true || !sameHash(opened.fileSha256, exported.sha256) || !HASH.test(opened.readerSha256 || '') ||
            typeof opened.observedText !== 'string' || !opened.observedText.includes(edited) || !opened.observedText.includes(body) ||
            !HASH.test(opened.reportSha256 || '')) refuse(`actual ${extension} reader did not verify current presentation content and cleanup`, opened?.cleanupConfirmed !== true);
        exports.push({ extension, fileSha256: exported.sha256, readerSha256: opened.readerSha256,
          textSha256: hash(opened.observedText), reportSha256: opened.reportSha256 });
      }
      passed(contract.assertions[2], { exports, providers: ['claude', 'codex'], providerBriefs: 2 });
    }
  } catch (error) {
    failure = error; uncertain ||= error.cleanupUncertain === true || error.cleanupUnconfirmed === true;
  } finally {
    if (current) {
      try { await stop(); } catch (error) { uncertain = true; failure ||= error; }
    }
    if (uncertain || pending.size) {
      uncertain = true;
      try {
        const quarantine = await observation(await bounded('durable guest quarantine', () => guest.quarantine({ ...binding, reason: failure?.message || 'pending owned operation' }), true), 'guest-quarantine', true);
        report.quarantineConfirmed = quarantine.quarantined === true;
        if (!report.quarantineConfirmed) refuse('durable guest quarantine was not confirmed', true);
      }
      catch (error) { report.quarantineError = error.message; failure ||= error; }
    }
    report.cleanupConfirmed = !uncertain && !current && pending.size === 0;
    report.finishedAt = new Date().toISOString();
  }
  report.complete = !failure && report.cleanupConfirmed && report.assertions.length === contract.assertions.length;
  if (!report.complete) {
    failure ||= new Error('Desktop journey blocked: incomplete required observations or cleanup');
    failure.code ||= 'DESKTOP_JOURNEY_BLOCKED';
    failure.cleanupUnconfirmed = failure.cleanupUnconfirmed === true || !report.cleanupConfirmed;
    report.error = failure.message; failure.report = report; throw failure;
  }
  // Deliberately no ready/releaseReady verdict. This is one private raw report,
  // still requiring trusted guest verification and all other contract rows.
  return report;
}

/**
 * Transport contract (all guest operations stay in its pre-armed owned run):
 * - epoch is the controller's baseline-reset observation, not a caller-issued
 *   authority token. verifyObservation verifies it before launch, then verifies
 *   runtime-launch/runtime-stop/quarantine observations against its owned ledger.
 * - All requests/results keep the qualification runId and verified epoch/phase;
 *   journeyId identifies one content journey, never a replacement run.
 *   assertCapabilities authorizes that exact journey/subject under the epoch.
 * - launch returns {id, attestation, cdp:{send,on}}. `on` returns unsubscribe.
 *   Canonical runtime observations use artifact/subjectSha256, process (Electron),
 *   serverProcess for products with a separate server, token, sessionId and
 *   full binding, plus observed origin and
 *   durable user-data identity. Legacy/dual installer fields refuse.
 * - stop confirms the runtime process (and standalone server when present)
 *   and termination/owned-child cleanup;
 *   quarantine is a bound guest-quarantine observation, including late RPCs.
 * - stageInput returns a fenced owned guest path and hash of supplied user input.
 * - armDownload returns an owned {id,extension,...binding} ticket;
 *   collectDownload captures actual UI-triggered bytes under the same scope.
 * - readProductOutput reads only the owned working/published file or model;
 *   output returns {owned,...binding,bytes:Uint8Array,sha256}, never just a hash.
 *   ToolsEnabled conversation reads additionally bind the requested nodeId.
 * - collectProviderEvidence binds the actual UI brief and real executable,
 *   response and raw report. ToolsEnabled requires a provider-execution raw
 *   observation verified against the native trace, binding nodeId, the launch's
 *   desktopSessionId, host.read_file path/request/output hashes, exact installed
 *   runtime/shell hashes and the distinct engineProcess that serviced the tool.
 *   openExport uses a real guest reader, reports its
 *   observed text/file identity and confirms its separately owned cleanup.
 *
 * Missing transport/reader/provider implementations refuse. Production registry
 * integration and real installed execution are still required; this function
 * does not establish those facts by accepting a production-shaped object.
 */
export function executeDesktopJourney(options) { return execute(options, false); }

// Explicitly synthetic mechanics seam; it cannot emit production proof scope.
export function executeDesktopJourneyFixture(options) { return execute(options, true); }
