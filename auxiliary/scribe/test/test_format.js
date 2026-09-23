#!/usr/bin/env node
'use strict';

/**
 * Automatic formatting, end to end without a model process.
 *
 * SCRIBE_FORMAT_TEST shortens the production thresholds and holds each job at
 * the strict-plan boundary. Tests supply the model's tagged JSON through the
 * fixture endpoint, so every scheduler and transaction assertion is
 * deterministic and isolated from the user's live Scribe process.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '_tmp_format');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
let PORT = null;
let BASE = null;

const PASS = [];
const FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(
    `  ${condition ? 'ok  ' : 'FAIL'} ${name}` +
    `${detail === undefined ? '' : `  ${detail}`}`,
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function req(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const request = http.request(BASE + route, {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (response) => {
      let out = '';
      response.on('data', (chunk) => out += chunk);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(out || '{}') });
        } catch (_) {
          resolve({ status: response.statusCode, body: out });
        }
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(30);
  }
  throw new Error('waitFor timed out');
}

async function model() {
  return (await req('GET', '/api/doc')).body;
}

async function formatting() {
  return (await req('GET', '/api/format')).body;
}

async function waitForFormattingJob(timeout = 8000) {
  return waitFor(async () => {
    const status = await formatting();
    return status.active ? status : null;
  }, timeout);
}

function taggedPlan(job, baseRev, changes) {
  return '<format_plan>' + JSON.stringify({
    job_id: job.id,
    base_rev: baseRev,
    changes,
  }) + '</format_plan>';
}

let typingSeq = 0;
async function appendTyping(pid, token, words, label = 'format race') {
  const before = (await model()).paragraphs.find((paragraph) =>
    paragraph.pid === pid);
  if (!before) throw new Error(`paragraph ${pid} is not in the active document`);
  const response = await req('POST', '/api/edit', {
    who: 'human',
    op: {
      type: 'set_text',
      pid,
      text: `${before.text} ${words}`,
      expect_hash: before.hash,
      expect_document_token: token,
      why: 'typed directly',
      utterance: `${label}-${++typingSeq}`,
    },
  });
  const after = response.status === 200
    ? (await model()).paragraphs.find((paragraph) => paragraph.pid === pid)
    : null;
  return { response, before, after, grant: response.body.prediction_grant };
}

async function finishFormatKeep(status = null) {
  const snapshot = status || await formatting();
  if (!snapshot.active) throw new Error('no formatting job to finish');
  const rev = (await req('GET', '/api/health')).body.rev;
  return req('POST', '/api/format/fixture', {
    text: taggedPlan(snapshot.active, rev, []),
  });
}

async function main() {
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  const secondDoc = path.join(TMP, 'data', 'documents', 'paper-two.docx');
  fs.copyFileSync(SRC, doc);
  fs.copyFileSync(SRC, secondDoc);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_PORT: String(PORT),
      SCRIBE_DATA: path.join(TMP, 'data'),
      SCRIBE_RUNTIME_TEST: '1',
      SCRIBE_TRANSACTION_TEST: '1',
      SCRIBE_FORMAT_TEST: '1',
      SCRIBE_FORMAT_MIN_WORDS: '10',
      SCRIBE_FORMAT_SINGLE_PARAGRAPH_WORDS: '6',
      SCRIBE_FORMAT_QUIET_MS: '140',
      SCRIBE_FORMAT_COOLDOWN_MS: '240',
      SCRIBE_FORMAT_TIMEOUT_MS: '3000',
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_PREDICT_TEST: '1',
      SCRIBE_PREDICT_GRANT_MIN_MS: '25',
      SCRIBE_PREDICT_GRANT_TTL_MS: '10000',
      SCRIBE_CLAUDE: path.join(TMP, 'missing-claude.exe'),
    },
  });
  const logs = [];
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), server, {
      attempts: 120,
      interval: 100,
      requireDocHost: true,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(opened.body.error || 'could not open formatting fixture');
    }
    const token = opened.body.document_token;

    console.log('\n[explicit body insertion]');
    await req('POST', '/api/format', {
      enabled: false,
      expect_document_token: token,
    });
    let current = await model();
    const anchor = current.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.style === 'Normal' &&
      paragraph.text.length > 80 && paragraph.text.length < 1200);
    if (!anchor) throw new Error('no Normal paragraph for formatting fixture');
    const bolded = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format',
        pid: anchor.pid,
        find: anchor.text,
        b: true,
        expect_hash: anchor.hash,
        expect_format_hash: anchor.format_hash,
        expect_document_token: token,
        why: 'direct-bold proposal anchor fixture',
        utterance: 'format-proposal-anchor',
      },
    });
    check('fixture anchor becomes direct-bold', bolded.status === 200,
      bolded.body.error);
    const boldAnchor = (await model()).paragraphs
      .find((paragraph) => paragraph.pid === anchor.pid);
    check('fixture remains a Normal paragraph with bold runs',
      boldAnchor.style === 'Normal' &&
      boldAnchor.runs.filter((run) => run.text).every((run) => run.b === true));

    const proposed = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: boldAnchor.pid,
        anchor_hash: boldAnchor.hash,
        mode: 'insert',
        intent: 'Add a body paragraph',
        options: [
          { text: 'This first ordinary body paragraph must not inherit a visual heading.' },
          { text: 'This second ordinary body paragraph must remain ordinary prose.' },
        ],
      },
    });
    check('insert proposal captures an explicit body-safe style',
      proposed.status === 200 && proposed.body.style === 'Normal',
      proposed.body.error || proposed.body.style);
    const accepted = await req('POST', '/api/accept', {
      id: proposed.body.id,
      option: 'A',
      expect_document_token: token,
    });
    const inserted = (await model()).paragraphs
      .find((paragraph) => paragraph.pid === accepted.body.result?.pid);
    check('accepted body prose is Normal and has no inherited direct bold',
      accepted.status === 200 && inserted && inserted.style === 'Normal' &&
      inserted.runs.filter((run) => run.text).every((run) => !run.b) &&
      !(inserted.paragraph_format && inserted.paragraph_format.b),
      accepted.body.error || JSON.stringify(inserted));
    const undoInsertion = await req('POST', '/api/undo', {
      expect_document_token: token,
    });
    check('the body-safe insertion remains one exact Undo unit',
      undoInsertion.status === 200 &&
      !(await model()).paragraphs.some((paragraph) => paragraph.pid === inserted.pid),
      undoInsertion.body.error);
    await req('POST', '/api/format', {
      enabled: true,
      expect_document_token: token,
    });

    console.log('\n[large sparse trigger and quiet reset]');
    current = await model();
    let target = current.paragraphs.find((paragraph) =>
      paragraph.pid !== anchor.pid && !paragraph.table &&
      paragraph.style === 'Normal' && paragraph.text.length > 100 &&
      paragraph.text.length < 1600);
    if (!target) throw new Error('no body paragraph for automatic formatter');
    const targetBold = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format',
        pid: target.pid,
        find: target.text,
        b: true,
        expect_hash: target.hash,
        expect_format_hash: target.format_hash,
        expect_document_token: token,
        why: 'uniform inherited-bold formatter fixture',
        utterance: 'format-target-bold',
      },
    });
    check('formatter target is prepared without counting as typing',
      targetBold.status === 200 && (await formatting()).pending_words === 0,
      targetBold.body.error);
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);

    const firstAddition = ' one two three four';
    const firstSave = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: target.text + firstAddition,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'format-typing-one',
      },
    });
    check('a below-threshold addition only accumulates',
      firstSave.status === 200 &&
      (await formatting()).pending_words === 4 &&
      (await formatting()).active === null,
      firstSave.body.error);
    await sleep(170);
    check('quiet time alone cannot bypass the large-batch threshold',
      (await formatting()).active === null);

    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const secondAddition = ' five six seven';
    const secondSave = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: target.text + secondAddition,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'format-typing-two',
      },
    });
    await sleep(80);
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const thirdAddition = ' eight nine ten eleven';
    const thirdSave = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: target.text + thirdAddition,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'format-typing-three',
      },
    });
    await sleep(90);
    check('more typing resets the formatting quiet window',
      secondSave.status === 200 && thirdSave.status === 200 &&
      (await formatting()).active === null);
    const predictionGrant = thirdSave.body.prediction_grant;
    const predicted = await req('POST', '/api/predict', {
      grant: predictionGrant && predictionGrant.token,
      pid: target.pid,
      before: thirdSave.body.result.before,
      after: thirdSave.body.result.after,
      quietMs: 1000,
    });
    const predictionFixture = await req('POST', '/api/predict/fixture', {
      text: '<continuation>This continuation has enough carefully selected words ' +
        'to remain open while a formatting-only pass changes presentation but ' +
        'does not change its exact text anchor or meaning.</continuation>',
    });
    check('an open continuation can coexist with later formatting review',
      predicted.status === 200 && predictionFixture.status === 200 &&
      predictionFixture.body.continuation &&
      predictionFixture.body.continuation.status === 'open',
      predicted.body.error || predictionFixture.body.error);
    const queued = await waitForFormattingJob();
    check('crossing the large threshold queues exactly one isolated review',
      queued.active.pids.length === 1 &&
      queued.active.pids[0] === target.pid &&
      queued.pending_words === 11 &&
      queued.runner.running === false,
      JSON.stringify(queued));

    console.log('\n[strict plan rejection and cooldown]');
    const beforeBadBytes = fs.readFileSync(doc);
    const beforeBadHealth = (await req('GET', '/api/health')).body;
    const bad = await req('POST', '/api/format/fixture', {
      text: taggedPlan(
        queued.active,
        beforeBadHealth.rev,
        [{
          pid: 'OUT_OF_SCOPE',
          expect_hash: 'bad',
          expect_format_hash: 'bad',
          style: 'Normal',
          reason: 'malicious target',
        }],
      ),
    });
    const afterBadHealth = (await req('GET', '/api/health')).body;
    check('an out-of-scope plan makes no document transaction',
      bad.status === 200 && bad.body.result === null &&
      afterBadHealth.rev === beforeBadHealth.rev &&
      Buffer.compare(beforeBadBytes, fs.readFileSync(doc)) === 0,
      bad.body.error);
    check('a failed attempt preserves the batch but cannot loop immediately',
      (await formatting()).pending_words === 11 &&
      (await formatting()).active === null);
    const retry = await waitForFormattingJob();
    check('the preserved batch retries once after the explicit cooldown',
      retry.active.id !== queued.active.id &&
      retry.active.pids.join() === queued.active.pids.join());

    console.log('\n[atomic validated batch]');
    const beforeApply = await model();
    const beforeApplyParagraph = beforeApply.paragraphs
      .find((paragraph) => paragraph.pid === target.pid);
    const beforeApplyBytes = fs.readFileSync(doc);
    const beforeApplyRev = (await req('GET', '/api/health')).body.rev;
    const anchoredProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: beforeApplyParagraph.pid,
        anchor_hash: beforeApplyParagraph.hash,
        mode: 'replace',
        find: 'eight nine ten',
        intent: 'Formatting must not stale this text-anchored choice',
        options: [
          { text: 'eight nine eleven' },
          { text: 'eight nine twelve' },
        ],
      },
    });
    check('a text-anchored proposal remains open before the pass',
      anchoredProposal.status === 200 && anchoredProposal.body.status === 'open',
      anchoredProposal.body.error);
    const valid = await req('POST', '/api/format/fixture', {
      text: taggedPlan(
        retry.active,
        beforeApplyRev,
        [{
          pid: beforeApplyParagraph.pid,
          expect_hash: beforeApplyParagraph.hash,
          expect_format_hash: beforeApplyParagraph.format_hash,
          clear_uniform_direct: ['b'],
          reason: 'uniform heading bold carried into added body prose',
        }],
      ),
    });
    const afterApply = await model();
    const afterApplyParagraph = afterApply.paragraphs
      .find((paragraph) => paragraph.pid === target.pid);
    const afterApplyRev = (await req('GET', '/api/health')).body.rev;
    check('one valid plan changes formatting only and advances one revision',
      valid.status === 200 && valid.body.result &&
      valid.body.result.changed === 1 &&
      afterApplyRev === beforeApplyRev + 1 &&
      afterApplyParagraph.text === beforeApplyParagraph.text &&
      afterApplyParagraph.hash === beforeApplyParagraph.hash &&
      afterApplyParagraph.format_hash !== beforeApplyParagraph.format_hash &&
      afterApplyParagraph.runs.filter((run) => run.text).every((run) => !run.b),
      valid.body.error || JSON.stringify(valid.body));
    check('a completed pass consumes only its captured batch',
      (await formatting()).pending_words === 0 &&
      (await formatting()).active === null);
    const sidecarsAfterFormat = {
      proposals: (await req('GET', '/api/proposals')).body.proposals,
      prediction: (await req('GET', '/api/predict')).body,
    };
    check('format-only writes preserve text-anchored proposal and continuation cards',
      sidecarsAfterFormat.proposals.some((proposal) =>
        proposal.id === anchoredProposal.body.id && proposal.status === 'open') &&
      sidecarsAfterFormat.prediction.continuation &&
      sidecarsAfterFormat.prediction.continuation.status === 'open',
      JSON.stringify(sidecarsAfterFormat));

    const undone = await req('POST', '/api/undo', {
      expect_document_token: token,
    });
    check('one Undo restores the exact pre-pass package bytes',
      undone.status === 200 &&
      Buffer.compare(beforeApplyBytes, fs.readFileSync(doc)) === 0,
      undone.body.error);
    const undoParagraph = (await model()).paragraphs
      .find((paragraph) => paragraph.pid === target.pid);
    check('Undo restores the prior formatting without changing prose',
      undoParagraph.text === beforeApplyParagraph.text &&
      undoParagraph.format_hash === beforeApplyParagraph.format_hash &&
      undoParagraph.runs.filter((run) => run.text).every((run) => run.b));

    console.log('\n[empty plan and consent]');
    await sleep(260);
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const noChangeText = target.text + ' twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone';
    const armed = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: noChangeText,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'format-noop-typing',
      },
    });
    check('another substantial addition arms a later pass', armed.status === 200,
      armed.body.error);
    const noChangeJob = await waitForFormattingJob();
    const noChangeRev = (await req('GET', '/api/health')).body.rev;
    const noChangeBytes = fs.readFileSync(doc);
    const noChange = await req('POST', '/api/format/fixture', {
      text: taggedPlan(noChangeJob.active, noChangeRev, []),
    });
    check('KEEP/empty plan creates no save, revision, trail edit, or byte change',
      noChange.status === 200 && noChange.body.result &&
      noChange.body.result.noop === true &&
      (await req('GET', '/api/health')).body.rev === noChangeRev &&
      Buffer.compare(noChangeBytes, fs.readFileSync(doc)) === 0);

    const off = await req('POST', '/api/format', {
      enabled: false,
      expect_document_token: token,
    });
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const whileOff = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: target.pid,
        text: target.text + ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda',
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'format-disabled-typing',
      },
    });
    await sleep(220);
    const disabledState = await formatting();
    check('turning the feature off prevents collection and model work',
      off.status === 200 && whileOff.status === 200 &&
      disabledState.enabled === false &&
      disabledState.pending_words === 0 &&
      disabledState.active === null,
      JSON.stringify(disabledState));
    const on = await req('POST', '/api/format', {
      enabled: true,
      expect_document_token: token,
    });
    check('the top-bar consent endpoint explicitly re-arms formatting',
      on.status === 200 && on.body.enabled === true && on.body.status === 'armed',
      on.body.error || JSON.stringify(on.body));

    console.log('\n[server authorization boundaries]');
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const authorizationBytes = fs.readFileSync(doc);
    const authorizationRev = (await req('GET', '/api/health')).body.rev;
    const missingHumanFormatHash = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format',
        pid: target.pid,
        find: target.text,
        b: false,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'missing presentation guard',
      },
    });
    const missingAgentStyle = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'insert',
        after_pid: target.pid,
        text: 'This unauthorized agent paragraph must never be inserted.',
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'missing explicit body style',
      },
    });
    const missingAgentFormatHash = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'format',
        pid: target.pid,
        find: target.text,
        b: false,
        expect_hash: target.hash,
        expect_document_token: token,
        why: 'missing agent presentation guard',
      },
    });
    const directAgentBatch = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'format_batch',
        changes: [],
        expect_document_token: token,
      },
    });
    const directHumanBatch = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format_batch',
        changes: [],
        expect_document_token: token,
      },
    });
    const directPlannerWrite = await req('POST', '/api/edit', {
      who: 'format',
      op: {
        type: 'format',
        pid: target.pid,
        find: target.text,
        b: false,
        expect_hash: target.hash,
        expect_format_hash: target.format_hash,
        expect_document_token: token,
      },
    });
    check('all direct format calls require a fresh presentation hash',
      missingHumanFormatHash.status === 400 &&
      missingAgentFormatHash.status === 400);
    check('agent insertion requires an explicit body-safe Word style',
      missingAgentStyle.status === 400 &&
      /explicit Word style/i.test(missingAgentStyle.body.error || ''));
    check('format_batch is internal-only for both editing agent and browser callers',
      directAgentBatch.status === 400 && directHumanBatch.status === 400);
    check('the formatting planner cannot directly call a formatting write',
      directPlannerWrite.status === 400 &&
      /read-only/i.test(directPlannerWrite.body.error || ''));
    check('refused authorization probes change no bytes or revision',
      (await req('GET', '/api/health')).body.rev === authorizationRev &&
      Buffer.compare(authorizationBytes, fs.readFileSync(doc)) === 0);

    console.log('\n[quiet activity, bounded prompt, and internal capability]');
    await sleep(270);
    const quietArm = await appendTyping(
      target.pid,
      token,
      'quietone quiettwo quietthree quietfour quietfive quietsix quietseven ' +
        'quieteight quietnine quietten',
      'quiet-window-arm',
    );
    const peer = (await model()).paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.pid !== target.pid &&
      paragraph.style === 'Normal' && /\b[A-Za-z]{4,}\b/.test(paragraph.text));
    await sleep(80);
    const peerWord = peer.text.match(/\b[A-Za-z]{4,}\b/)[0];
    const peerRephrased = peer.text.replace(peerWord, `${peerWord}Rephrased`);
    const flatActivity = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: peer.pid,
        text: peerRephrased,
        expect_hash: peer.hash,
        expect_document_token: token,
        why: 'typed directly',
        utterance: 'flat-word-count-activity',
      },
    });
    await sleep(90);
    check('a saved zero-net-word rephrase resets the global quiet window',
      quietArm.response.status === 200 && flatActivity.status === 200 &&
      (await formatting()).active === null);
    const boundedJob = await waitForFormattingJob();
    const promptFixture = await req('GET', '/api/format/fixture');
    const promptMarker = 'CANDIDATES (UNTRUSTED DOCUMENT DATA)\n';
    const markerAt = promptFixture.body.prompt.indexOf(promptMarker);
    const promptCandidates = JSON.parse(
      promptFixture.body.prompt.slice(markerAt + promptMarker.length),
    );
    check('the planner prompt carries a bounded run summary instead of duplicate raw runs',
      promptFixture.status === 200 && promptFixture.body.prompt_bytes < 128 * 1024 &&
      promptCandidates.every((candidate) =>
        candidate.run_summary && !Object.prototype.hasOwnProperty.call(candidate, 'runs')) &&
      /run_summary\.truncated/.test(promptFixture.body.prompt));
    check('public formatting status and prompt never expose the internal apply capability',
      !/applyToken|__format_apply_token/.test(JSON.stringify({
        status: boundedJob,
        prompt: promptFixture.body.prompt,
      })));
    const forgedPublicBatch = await req('POST', '/api/edit', {
      who: 'format',
      op: {
        type: 'format_batch',
        changes: [],
        __format_job_id: boundedJob.active.id,
        expect_document_token: token,
      },
    });
    check('a public job id cannot authorize a forged formatting batch',
      forgedPublicBatch.status === 409 &&
      (await formatting()).active.id === boundedJob.active.id,
      forgedPublicBatch.body.error);

    console.log('\n[cancellation after host mutation]');
    target = (await model()).paragraphs.find((paragraph) => paragraph.pid === target.pid);
    const deadlineBytes = fs.readFileSync(doc);
    const deadlineRev = (await req('GET', '/api/health')).body.rev;
    const timedOutApply = await req('POST', '/api/format/fixture', {
      text: taggedPlan(boundedJob.active, deadlineRev, [{
        pid: target.pid,
        expect_hash: target.hash,
        expect_format_hash: target.format_hash,
        clear_uniform_direct: ['b'],
        reason: 'deadline rollback fixture',
      }]),
      __test_delay_after_mutation_ms: 250,
      __test_timeout_during_apply_ms: 50,
    });
    check('a deadline after host mutation rolls back instead of committing late',
      timedOutApply.status === 200 && timedOutApply.body.result === null &&
      (await req('GET', '/api/health')).body.rev === deadlineRev &&
      Buffer.compare(deadlineBytes, fs.readFileSync(doc)) === 0);
    const deadlineRetry = await waitForFormattingJob();
    check('the one transient retry remains available after a timed-out apply',
      deadlineRetry.active.id !== boundedJob.active.id);
    await finishFormatKeep(deadlineRetry);

    console.log('\n[bounded unchanged-batch retry]');
    await sleep(270);
    const retryArm = await appendTyping(
      target.pid,
      token,
      'retryone retrytwo retrythree retryfour retryfive retrysix retryseven ' +
        'retryeight retrynine retryten',
      'bounded-retry-arm',
    );
    const failedOnce = await waitForFormattingJob();
    const failedOnceRev = (await req('GET', '/api/health')).body.rev;
    await req('POST', '/api/format/fixture', {
      text: taggedPlan(failedOnce.active, failedOnceRev, [{
        pid: 'NOT_CAPTURED',
        expect_hash: 'bad',
        expect_format_hash: 'bad',
        style: 'Normal',
      }]),
    });
    const failedRetry = await waitForFormattingJob();
    const failedRetryRev = (await req('GET', '/api/health')).body.rev;
    await req('POST', '/api/format/fixture', {
      text: taggedPlan(failedRetry.active, failedRetryRev, [{
        pid: 'STILL_NOT_CAPTURED',
        expect_hash: 'bad',
        expect_format_hash: 'bad',
        style: 'Normal',
      }]),
    });
    await sleep(360);
    const exhausted = await formatting();
    check('an unchanged malformed batch gets one retry, never an infinite loop',
      retryArm.response.status === 200 && exhausted.active === null &&
      exhausted.retry_exhausted === true && exhausted.status === 'failed' &&
      exhausted.pending_words >= 10,
      JSON.stringify(exhausted));
    const rearmed = await appendTyping(
      target.pid,
      token,
      'freshaddition',
      'retry-rearm-addition',
    );
    const rearmedJob = await waitForFormattingJob();
    check('new saved additions re-arm an exhausted batch',
      rearmed.response.status === 200 &&
      rearmedJob.retry_exhausted === false && !!rearmedJob.active);
    await finishFormatKeep(rearmedJob);

    console.log('\n[human edit, Pause, Watch, prediction, and prompt preemption]');
    const armAndWait = async (label) => {
      await sleep(270);
      const typed = await appendTyping(
        target.pid,
        token,
        `${label}one ${label}two ${label}three ${label}four ${label}five ` +
          `${label}six ${label}seven ${label}eight ${label}nine ${label}ten`,
        `${label}-arm`,
      );
      return { typed, job: await waitForFormattingJob() };
    };

    let preempt = await armAndWait('humanrace');
    const editedDuringReview = await appendTyping(
      target.pid, token, 'newerhumantext', 'human-review-preempt');
    const lateHumanPlan = await req('POST', '/api/format/fixture', {
      text: taggedPlan(preempt.job.active,
        (await req('GET', '/api/health')).body.rev, []),
    });
    check('a human document edit cancels the captured review before a late plan',
      editedDuringReview.response.status === 200 &&
      lateHumanPlan.status === 409);
    await finishFormatKeep(await waitForFormattingJob());

    preempt = await armAndWait('pauserace');
    const pauseBytes = fs.readFileSync(doc);
    const pauseRev = (await req('GET', '/api/health')).body.rev;
    const paused = await req('POST', '/api/pause', {});
    const latePausedPlan = await req('POST', '/api/format/fixture', {
      text: taggedPlan(preempt.job.active, pauseRev, []),
    });
    check('Pause cancels a review without committing its late output',
      paused.status === 200 && latePausedPlan.status === 409 &&
      Buffer.compare(pauseBytes, fs.readFileSync(doc)) === 0 &&
      (await req('GET', '/api/health')).body.rev === pauseRev);
    await req('POST', '/api/resume', {});
    await finishFormatKeep(await waitForFormattingJob());

    preempt = await armAndWait('watchrace');
    const watchParagraph = (await model()).paragraphs
      .find((paragraph) => paragraph.pid === target.pid);
    await req('POST', '/api/watch/enabled', { enabled: true });
    const watchStarted = await req('POST', '/api/watch/review', {
      changes: [{
        pid: watchParagraph.pid,
        before: watchParagraph.text.slice(0, -1),
        after: watchParagraph.text,
      }],
      manual: true,
      expect_document_token: token,
    });
    check('a valid Watch review preempts the lower-priority formatter',
      watchStarted.status === 200 &&
      (await formatting()).active === null &&
      (await req('GET', '/api/watch')).body.active !== null);
    await req('POST', '/api/watch/enabled', { enabled: false });
    await finishFormatKeep(await waitForFormattingJob());

    await sleep(270);
    const predictionArm = await appendTyping(
      target.pid,
      token,
      'predictone predicttwo predictthree predictfour predictfive predictsix ' +
        'predictseven predicteight predictnine predictten',
      'prediction-priority-arm',
    );
    const formatBeforePrediction = await waitForFormattingJob();
    const predictionStarted = await req('POST', '/api/predict', {
      grant: predictionArm.grant && predictionArm.grant.token,
      pid: predictionArm.after.pid,
      before: predictionArm.before.text,
      after: predictionArm.after.text,
      quietMs: 1000,
      expect_document_token: token,
    });
    check('predictive drafting preempts automatic formatting instead of overlapping',
      predictionStarted.status === 200 &&
      (await formatting()).active === null &&
      (await req('GET', '/api/predict')).body.active !== null,
      predictionStarted.body.error);
    await req('POST', '/api/predict/fixture', {
      text: '<continuation>NO_SUGGESTION</continuation>',
    });
    await finishFormatKeep(await waitForFormattingJob());

    preempt = await armAndWait('promptrace');
    const said = await req('POST', '/api/say', {
      text: 'Review the latest paragraph when you are available.',
      expect_document_token: token,
    });
    check('a real human prompt immediately preempts the background formatter',
      said.status === 200 && (await formatting()).active === null);
    await finishFormatKeep(await waitForFormattingJob());

    console.log('\n[paragraph and word cap progress]');
    await sleep(270);
    const capModel = await model();
    const capParagraphs = capModel.paragraphs.filter((paragraph) =>
      !paragraph.table && paragraph.text && paragraph.pid !== target.pid)
      .slice(0, 30);
    for (let index = 0; index < capParagraphs.length; index++) {
      const paragraph = capParagraphs[index];
      const saved = await req('POST', '/api/edit', {
        who: 'human',
        op: {
          type: 'set_text',
          pid: paragraph.pid,
          text: `${paragraph.text} capword${index}`,
          expect_hash: paragraph.hash,
          expect_document_token: token,
          why: 'typed directly',
          utterance: `paragraph-cap-${index}`,
        },
      });
      if (saved.status !== 200) throw new Error(saved.body.error);
    }
    const firstCapChunk = await waitForFormattingJob();
    check('a qualifying batch over the paragraph cap starts a bounded 24-paragraph chunk',
      firstCapChunk.active.pids.length === 24,
      firstCapChunk.active.pids.length);
    await finishFormatKeep(firstCapChunk);
    const secondCapChunk = await waitForFormattingJob();
    check('the latched batch drains the six-paragraph remainder below the trigger',
      secondCapChunk.active.pids.length === 6,
      secondCapChunk.active.pids.length);
    await finishFormatKeep(secondCapChunk);

    await sleep(270);
    const oversizedBase = await model();
    const smallCandidate = oversizedBase.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.pid !== target.pid && paragraph.text);
    const oversizedCandidate = oversizedBase.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.pid !== target.pid &&
      paragraph.pid !== smallCandidate.pid && paragraph.text);
    await appendTyping(smallCandidate.pid, token, 'smallcapword', 'word-cap-small');
    const hugeWords = Array.from({ length: 1201 }, (_, index) => `huge${index}`).join(' ');
    await appendTyping(oversizedCandidate.pid, token, hugeWords, 'word-cap-huge');
    const smallWordChunk = await waitForFormattingJob();
    check('a later oversized paragraph cannot starve an earlier bounded candidate',
      smallWordChunk.active.pids.length === 1 &&
      smallWordChunk.active.pids[0] === smallCandidate.pid,
      JSON.stringify(smallWordChunk.active));
    await finishFormatKeep(smallWordChunk);
    const oversizedChunk = await waitForFormattingJob();
    check('an oversized paragraph is selected alone on the next bounded chunk',
      oversizedChunk.active.pids.length === 1 &&
      oversizedChunk.active.pids[0] === oversizedCandidate.pid,
      JSON.stringify(oversizedChunk.active));
    await finishFormatKeep(oversizedChunk);

    console.log('\n[Undo and Open retire document-bound output]');
    const undoArm = await armAndWait('undorace');
    const undoRace = await req('POST', '/api/undo', {
      expect_document_token: token,
    });
    const lateUndoPlan = await req('POST', '/api/format/fixture', {
      text: taggedPlan(undoArm.job.active,
        (await req('GET', '/api/health')).body.rev, []),
    });
    await waitFor(async () => {
      const snapshot = await formatting();
      return snapshot.active === null && snapshot.pending_words === 0;
    });
    check('Undo retires the review and stale empty output cannot consume old captures',
      undoRace.status === 200 && lateUndoPlan.status === 409);

    const openArm = await armAndWait('openrace');
    const openedSecond = await req('POST', '/api/open', { path: secondDoc });
    const afterOpenFormat = await formatting();
    const lateOpenPlan = await req('POST', '/api/format/fixture', {
      text: taggedPlan(openArm.job.active, 0, []),
    });
    check('Open rotates ownership and permanently retires late formatter output',
      openedSecond.status === 200 &&
      openedSecond.body.document_token !== token &&
      afterOpenFormat.active === null && afterOpenFormat.pending_words === 0 &&
      lateOpenPlan.status === 409);

    console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
    if (FAIL.length) process.exitCode = 1;
  } catch (error) {
    hardFail = true;
    console.error(error.stack || error);
    console.error(logs.join(''));
    process.exitCode = 1;
  } finally {
    try {
      await req('POST', '/api/__runtime/shutdown');
    } catch (_) {}
    await sleep(250);
    if (server.exitCode === null) server.kill();
    if (!hardFail) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

main();
