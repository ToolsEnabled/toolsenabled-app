import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// The product seam is intentionally the first production module imported.
const componentsModule = await import('../../src/components.js');
const durationSeamExists = Object.hasOwn(
  componentsModule,
  'CHAT_ACTIVITY_DURATION_SEAM',
);

if (!durationSeamExists) {
  test('chat activity duration and disclosure capability', {
    skip: 'CHAT_ACTIVITY_DURATION_SEAM is not present in the product module',
  }, () => {});
} else {
  await armDurationAndDisclosureTests();
}

async function armDurationAndDisclosureTests() {
  const cssLoader = String.raw`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) {
        return {
          format: 'module',
          source: 'export default {};',
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(cssLoader)}`, import.meta.url);

  const [eventsModule, sessionModule, computersModule, copyModule] =
    await Promise.all([
      import('../../src/agent-session-events.js'),
      import('../../src/agent-session.js'),
      import('../../src/views/computers.js'),
      import('../../src/fleet-tree-copy.js'),
    ]);

  const { buildChat } = componentsModule;
  const { createActionBuffer, sessionActivityEvent } = eventsModule;
  const { sessionActionChatRow } = sessionModule;
  const { actionChatRow } = computersModule;
  const {
    actionRowWords,
    actionRunDisclosureWord,
    actionRunLine,
    actionRunTotalText,
    formatActionDuration,
  } = copyModule;

  test('measures receipt intervals and preserves native same-node action runs', async () => {
    const restoreDom = installMinimalDom();
    try {
      const sessionId = 'session-1';
      const activity = (type, toolCallId, packetSessionId = sessionId) =>
        sessionActivityEvent({
          sessionId: packetSessionId,
          event: {
            type,
            toolCallId,
            tool: 'Read',
            payload: {},
          },
        }, sessionId);

      const callActivity = activity('tool_call', 'call-1');
      const resultActivity = activity('tool_result', 'call-1');
      assert.ok(callActivity, 'the call activity exists before its kind is checked');
      assert.ok(resultActivity, 'the result activity exists before its kind is checked');
      assert.equal(callActivity.kind, 'call');
      assert.equal(resultActivity.kind, 'result');
      assert.equal(activity('tool_call', 'wrong-session', 'session-2'), null);

      const buffer = createActionBuffer();
      const firstAnswer = buffer.add(callActivity, {
        turnId: 'turn-1',
        at: 1000,
      });
      assert.ok(firstAnswer?.row, 'the first buffered answer owns a row');
      assert.equal(firstAnswer.change, 'added');
      const secondAnswer = buffer.add(resultActivity, {
        turnId: 'turn-1',
        at: 1250,
      });
      assert.ok(secondAnswer?.row, 'the joined result owns the updated row');
      assert.equal(secondAnswer.change, 'updated');
      assert.equal(secondAnswer.row, firstAnswer.row);

      const firstList = buffer.list();
      assert.equal(firstList.length, 1);
      const firstMeasured = firstList[0];
      assert.ok(firstMeasured, 'the joined row exists in the public list');
      assert.equal(firstMeasured.at, 1000);
      assert.equal(firstMeasured.startedAt, 1000);
      assert.equal(firstMeasured.endedAt, 1250);
      assert.equal(firstMeasured.durationMs, 250);

      const measuredSpecs = [
        { id: 'measured-9999', start: 2000, duration: 9999 },
        { id: 'measured-zero', start: 20000, duration: 0 },
        { id: 'measured-10000', start: 30000, duration: 10000 },
        { id: 'measured-over-10000', start: 50000, duration: 10001 },
      ];
      const measuredRows = [firstMeasured];
      for (const spec of measuredSpecs) {
        const added = buffer.add(activity('tool_call', spec.id), {
          turnId: 'turn-1',
          at: spec.start,
        });
        assert.ok(added?.row, `${spec.id} call exists before joining`);
        assert.equal(added.change, 'added');
        const joined = buffer.add(activity('tool_result', spec.id), {
          turnId: 'turn-1',
          at: spec.start + spec.duration,
        });
        assert.ok(joined?.row, `${spec.id} result exists after joining`);
        assert.equal(joined.change, 'updated');
        assert.equal(joined.row, added.row);
        assert.equal(joined.row.durationMs, spec.duration);
        measuredRows.push(joined.row);
      }
      const equalReceiptRow = findBufferedRow(
        buffer.list(),
        'measured-zero',
        'turn-1',
      );
      assert.ok(equalReceiptRow, 'the equal-receipt row exists');
      assert.ok(Object.hasOwn(equalReceiptRow, 'durationMs'));
      assert.equal(equalReceiptRow.durationMs, 0);

      const pendingAnswer = buffer.add(activity('tool_call', 'pending'), {
        turnId: 'turn-1',
        at: 70000,
      });
      assert.ok(pendingAnswer?.row, 'the pending call exists');
      const pendingRow = { ...pendingAnswer.row };

      const unmatchedCall = buffer.add(activity('tool_call', 'turn-mismatch'), {
        turnId: 'turn-unmatched-call',
        at: 71000,
      });
      assert.ok(unmatchedCall?.row, 'the call used to prove a turn mismatch exists');
      const unmatchedResultAnswer = buffer.add(
        activity('tool_result', 'turn-mismatch'),
        { turnId: 'turn-unmatched-result', at: 71100 },
      );
      assert.ok(unmatchedResultAnswer?.row, 'the unmatched result row exists');
      assert.equal(unmatchedResultAnswer.change, 'added');
      assert.equal(unmatchedResultAnswer.row.kind, 'result');

      const resultOnlyAnswer = buffer.add(activity('tool_result', 'result-only'), {
        turnId: 'turn-1',
        at: 72000,
      });
      assert.ok(resultOnlyAnswer?.row, 'the result-only row exists');
      assert.equal(resultOnlyAnswer.change, 'added');
      assert.equal(resultOnlyAnswer.row.kind, 'result');

      const omittedAtAnswer = buffer.add(activity('tool_call', 'omitted-at'), {
        turnId: 'turn-1',
      });
      assert.ok(omittedAtAnswer?.row, 'the omitted-at call exists');
      assert.ok(Number.isFinite(omittedAtAnswer.row.at));
      assertNoOwnTiming(omittedAtAnswer.row, [
        'startedAt',
        'endedAt',
        'durationMs',
      ]);

      const nullCall = buffer.add(activity('tool_call', 'null-receipt'), {
        turnId: 'turn-1',
        at: null,
      });
      assert.ok(nullCall?.row, 'the null-receipt call exists');
      const nullResult = buffer.add(activity('tool_result', 'null-receipt'), {
        turnId: 'turn-1',
        at: null,
      });
      assert.ok(nullResult?.row, 'the null-receipt result exists');
      assert.equal(nullResult.change, 'updated');

      const nonFiniteCall = buffer.add(activity('tool_call', 'nonfinite-call'), {
        turnId: 'turn-1',
        at: Number.NaN,
      });
      assert.ok(nonFiniteCall?.row, 'the non-finite call receipt row exists');
      const finiteResultAfterNonFiniteCall = buffer.add(
        activity('tool_result', 'nonfinite-call'),
        { turnId: 'turn-1', at: 73000 },
      );
      assert.ok(
        finiteResultAfterNonFiniteCall?.row,
        'the result after a non-finite call receipt exists',
      );

      const finiteCallBeforeNonFiniteResult = buffer.add(
        activity('tool_call', 'nonfinite-result'),
        { turnId: 'turn-1', at: 74000 },
      );
      assert.ok(
        finiteCallBeforeNonFiniteResult?.row,
        'the call before a non-finite result receipt exists',
      );
      const nonFiniteResult = buffer.add(
        activity('tool_result', 'nonfinite-result'),
        { turnId: 'turn-1', at: Number.POSITIVE_INFINITY },
      );
      assert.ok(nonFiniteResult?.row, 'the non-finite result receipt row exists');

      const earlyCall = buffer.add(activity('tool_call', 'early-result'), {
        turnId: 'turn-1',
        at: 75000,
      });
      assert.ok(earlyCall?.row, 'the call used for an early result exists');
      const earlyResult = buffer.add(activity('tool_result', 'early-result'), {
        turnId: 'turn-1',
        at: 74999,
      });
      assert.ok(earlyResult?.row, 'the earlier-than-call result exists');

      const settleBuffer = createActionBuffer();
      const settlementCall = settleBuffer.add(
        activity('tool_call', 'synthetic-settlement'),
        { turnId: 'turn-settle', at: 76000 },
      );
      assert.ok(settlementCall?.row, 'the call to settle exists');
      const settlementStateBefore = settlementCall.row.state;
      assert.equal(settlementStateBefore, 'working');
      const movedRows = settleBuffer.settleUnfinished();
      assert.ok(Array.isArray(movedRows), 'settlement returns its moved rows');
      assert.equal(movedRows.length, 1);
      const settledRow = movedRows[0];
      assert.ok(settledRow, 'the returned moved row exists');
      assert.equal(settledRow.id, settlementCall.row.id);
      assert.equal(settledRow.state, 'unknown');
      assert.notEqual(settledRow.state, settlementStateBefore);
      assert.equal(settledRow, settleBuffer.list()[0]);

      const unmeasuredRows = [
        pendingRow,
        unmatchedCall.row,
        unmatchedResultAnswer.row,
        resultOnlyAnswer.row,
        omittedAtAnswer.row,
        nullResult.row,
        finiteResultAfterNonFiniteCall.row,
        nonFiniteResult.row,
        earlyResult.row,
        settledRow,
      ];
      for (const row of unmeasuredRows) {
        assert.ok(row, 'each unmeasured case exists before absence is checked');
        assertNoOwnTiming(row, ['endedAt', 'durationMs']);
      }

      const adapterEntries = [
        ['sessionActionChatRow', sessionActionChatRow],
        ['actionChatRow', actionChatRow],
      ];
      const everyBufferedRow = [...measuredRows, ...unmeasuredRows];
      for (const [adapterName, adapter] of adapterEntries) {
        for (const sourceRow of everyBufferedRow) {
          assert.ok(sourceRow, `${adapterName} receives an observed buffered row`);
          const adapted = adapter(sourceRow);
          assert.ok(adapted, `${adapterName} returns a row`);
          assertTimingTransport(sourceRow, adapted, adapterName);

          const liveRoot = buildChat({ title: 'fixture', seed: 0 });
          assert.ok(liveRoot, `${adapterName} live chat root exists`);
          liveRoot.addAction(adapted);
          assertMountedTiming(
            liveRoot,
            sourceRow,
            formatActionDuration,
            actionRunTotalText,
          );

          const historyRoot = buildChat({
            title: 'fixture',
            seed: 0,
            history: [{ who: 'action', ...adapted }],
          });
          assert.ok(historyRoot, `${adapterName} restored chat root exists`);
          assertMountedTiming(
            historyRoot,
            sourceRow,
            formatActionDuration,
            actionRunTotalText,
          );
        }
      }

      const mixedSources = [
        firstMeasured,
        findBufferedRow(buffer.list(), 'measured-zero', 'turn-1'),
        findBufferedRow(buffer.list(), 'measured-9999', 'turn-1'),
        findBufferedRow(buffer.list(), 'measured-10000', 'turn-1'),
        findBufferedRow(buffer.list(), 'measured-over-10000', 'turn-1'),
        pendingRow,
      ];
      for (const row of mixedSources) {
        assert.ok(row, 'each mixed-run source row exists before mounting');
      }
      const mixedRoot = buildChat({ title: 'fixture', seed: 0 });
      mixedRoot.addAction(sessionActionChatRow(mixedSources[0]));
      const firstMixedRun = soleHook(mixedRoot, 'details.chat-action-run');
      const firstMixedNested = soleHook(firstMixedRun, 'details.chat-action');
      for (const sourceRow of mixedSources.slice(1)) {
        mixedRoot.addAction(sessionActionChatRow(sourceRow));
      }
      const initialRuns = mixedRoot.querySelectorAll('details.chat-action-run');
      assert.equal(initialRuns.length, 1);
      const mixedRun = initialRuns[0];
      assert.ok(mixedRun, 'the consecutive action run exists');
      assert.equal(mixedRun, firstMixedRun);
      const initialNestedRows = mixedRun.querySelectorAll('details.chat-action');
      assert.equal(initialNestedRows.length, mixedSources.length);
      assert.equal(initialNestedRows[0], firstMixedNested);
      const mixedStats = measuredStats(mixedSources);
      const mixedTotal = soleHook(mixedRun, '[data-chat-action-run-total]');
      assert.equal(
        mixedTotal.textContent,
        actionRunTotalText(mixedStats.sum, mixedStats.count),
      );

      const pendingJoinCall = buffer.add(activity('tool_call', 'join-later'), {
        turnId: 'turn-1',
        at: 80000,
      });
      assert.ok(pendingJoinCall?.row, 'the later-joined call exists');
      const joinBefore = { ...pendingJoinCall.row };
      for (const [adapterName, adapter] of adapterEntries) {
        assertAdapterRoutes({
          adapter,
          adapterName,
          buildChat,
          formatActionDuration,
          sourceRow: joinBefore,
          actionRunTotalText,
        });
      }
      mixedRoot.addAction(sessionActionChatRow(joinBefore));
      assert.equal(mixedRoot.querySelectorAll('details.chat-action-run').length, 1);
      assert.equal(
        mixedRoot.querySelector('details.chat-action-run'),
        mixedRun,
      );
      const beforeJoinStats = measuredStats([...mixedSources, joinBefore]);
      assert.equal(
        soleHook(mixedRun, '[data-chat-action-run-total]').textContent,
        actionRunTotalText(beforeJoinStats.sum, beforeJoinStats.count),
      );
      const nestedCountBeforeJoin = mixedRun.querySelectorAll(
        'details.chat-action',
      ).length;

      const pendingJoinResult = buffer.add(
        activity('tool_result', 'join-later'),
        { turnId: 'turn-1', at: 80500 },
      );
      assert.ok(pendingJoinResult?.row, 'the later result returns the joined row');
      assert.equal(pendingJoinResult.change, 'updated');
      assert.equal(pendingJoinResult.row.id, joinBefore.id);
      assert.equal(pendingJoinResult.row.durationMs, 500);
      for (const [adapterName, adapter] of adapterEntries) {
        assertAdapterRoutes({
          adapter,
          adapterName,
          buildChat,
          formatActionDuration,
          sourceRow: pendingJoinResult.row,
          actionRunTotalText,
        });
      }
      mixedRoot.addAction(sessionActionChatRow(pendingJoinResult.row));
      assert.equal(mixedRoot.querySelector('details.chat-action-run'), mixedRun);
      assert.equal(mixedRoot.querySelectorAll('details.chat-action-run').length, 1);
      assert.equal(
        mixedRun.querySelectorAll('details.chat-action').length,
        nestedCountBeforeJoin,
      );
      const joinedStats = measuredStats([
        ...mixedSources,
        pendingJoinResult.row,
      ]);
      assert.equal(
        soleHook(mixedRun, '[data-chat-action-run-total]').textContent,
        actionRunTotalText(joinedStats.sum, joinedStats.count),
      );

      const zeroRoot = buildChat({ title: 'fixture', seed: 0 });
      zeroRoot.addAction(sessionActionChatRow(equalReceiptRow));
      const zeroRun = soleHook(zeroRoot, 'details.chat-action-run');
      const zeroStats = measuredStats([equalReceiptRow]);
      assert.equal(zeroStats.sum, 0);
      assert.equal(zeroStats.count, 1);
      assert.equal(
        soleHook(zeroRun, '[data-chat-action-run-total]').textContent,
        actionRunTotalText(zeroStats.sum, zeroStats.count),
      );

      assert.equal(mixedRun.open, true, 'the pending call keeps this live group visible');
      mixedRun.querySelector('summary').click();
      assert.equal(mixedRun.open, false, 'the reader can still fold live work');
      mixedRoot.addAction(sessionActionChatRow(pendingJoinResult.row));
      assert.equal(mixedRun.open, false, 'a result update preserves the reader’s fold');
      const disclosure = soleHook(
        mixedRun,
        '[data-chat-action-run-disclosure]',
      );
      assert.equal(disclosure.textContent, actionRunDisclosureWord(mixedRun.open));
      const runSummary = disclosure.closest('summary');
      assert.ok(runSummary, 'the disclosure is activated through a summary');
      assert.equal(runSummary.parentElement, mixedRun);
      const nestedBeforeToggle = [
        ...mixedRun.querySelectorAll('details.chat-action'),
      ];

      disclosure.click();
      assert.equal(mixedRoot.querySelector('details.chat-action-run'), mixedRun);
      assert.equal(mixedRun.open, true);
      assert.equal(mixedRun.__runUserToggled, true);
      assert.deepEqual(
        [...mixedRun.querySelectorAll('details.chat-action')],
        nestedBeforeToggle,
      );
      assert.equal(disclosure.textContent, actionRunDisclosureWord(mixedRun.open));

      disclosure.click();
      assert.equal(mixedRoot.querySelector('details.chat-action-run'), mixedRun);
      assert.equal(mixedRun.open, false);
      assert.deepEqual(
        [...mixedRun.querySelectorAll('details.chat-action')],
        nestedBeforeToggle,
      );
      assert.equal(disclosure.textContent, actionRunDisclosureWord(mixedRun.open));

      runSummary.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 0,
      }));
      assert.equal(mixedRoot.querySelector('details.chat-action-run'), mixedRun);
      assert.equal(mixedRun.open, true);
      assert.equal(disclosure.textContent, actionRunDisclosureWord(mixedRun.open));

      const autoFoldRoot = buildChat({
        title: 'fixture',
        seed: 0,
        history: [
          { who: 'action', ...sessionActionChatRow(firstMeasured) },
          { who: 'agent', text: 'prose-fixture' },
        ],
      });
      assert.ok(autoFoldRoot.textContent.includes('prose-fixture'));
      const autoFoldRun = soleHook(autoFoldRoot, 'details.chat-action-run');
      const autoFoldDisclosure = soleHook(
        autoFoldRun,
        '[data-chat-action-run-disclosure]',
      );
      assert.notEqual(autoFoldRun.__runUserToggled, true);
      assert.equal(
        autoFoldRoot.querySelector('details.chat-action-run'),
        autoFoldRun,
      );
      // is-solo, not closed: this history is ONE action, and a run holding
      // exactly one call hides its own head/box instead of closing (see
      // src/components.js refreshRunLine and src/styles.css's
      // .chat-action-run.is-solo) -- closing it would take its one row down
      // with it under plain <details> semantics, with no head left to press
      // it back open. A multi-row run (mixedRun above) still folds shut.
      assert.equal(autoFoldRun.classList.contains('is-solo'), true);
      assert.equal(autoFoldRun.open, true);
      assert.equal(
        autoFoldRun.querySelectorAll('details.chat-action').length,
        1,
      );
      assert.equal(
        autoFoldDisclosure.textContent,
        actionRunDisclosureWord(autoFoldRun.open),
      );

      const nestedRoot = buildChat({ title: 'fixture', seed: 0 });
      const expandableNestedRow = {
        ...firstMeasured,
        id: 'nested-expandable',
        detail: 'fixture',
        output: 'nested-prose-fixture',
      };
      nestedRoot.addAction(sessionActionChatRow(expandableNestedRow));
      const nestedRun = soleHook(nestedRoot, 'details.chat-action-run');
      const nestedAction = soleHook(nestedRun, 'details.chat-action');
      const nestedSummary = nestedAction.querySelector('summary');
      assert.ok(nestedSummary, 'the nested action summary exists');
      assert.ok(
        nestedSummary.parentElement === nestedAction,
        'the nested action summary is a direct details child',
      );
      const outerOpenBeforeNestedToggle = nestedRun.open;
      const outerUserStateBeforeNestedToggle = nestedRun.__runUserToggled;
      const nestedStateBefore = nestedDisclosureState(
        nestedAction,
        nestedSummary,
      );
      const nestedClick = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      nestedSummary.dispatchEvent(nestedClick);
      assert.notDeepEqual(
        nestedDisclosureState(nestedAction, nestedSummary),
        nestedStateBefore,
        'nested summary activation changes the nested row disclosure state',
      );
      assert.equal(nestedRun.open, outerOpenBeforeNestedToggle);
      assert.equal(
        nestedRun.__runUserToggled,
        outerUserStateBeforeNestedToggle,
      );

      const legacyRows = [
        {
          id: 'legacy-refused',
          turnId: 'turn-copy',
          at: 90000,
          kind: 'call',
          tool: 'Read',
          detail: 'fixture',
          output: '',
          state: 'refused',
        },
        {
          id: 'legacy-undone',
          turnId: 'turn-copy',
          at: 90001,
          kind: 'call',
          tool: 'Read',
          detail: 'fixture',
          output: '',
          state: 'undone',
        },
      ];
      const legacyRoot = buildChat({ title: 'fixture', seed: 0 });
      for (const row of legacyRows) {
        legacyRoot.addAction(sessionActionChatRow(row));
      }
      const legacyRun = soleHook(legacyRoot, 'details.chat-action-run');
      const legacyNested = legacyRun.querySelectorAll('details.chat-action');
      assert.equal(legacyNested.length, legacyRows.length);
      legacyRows.forEach((row, index) => {
        const words = actionRowWords(row);
        assert.ok(words.state, 'the vocabulary export owns a state word');
        assert.ok(
          legacyNested[index].textContent.includes(words.state),
          `the ${row.state} row retains its exported state word`,
        );
      });
      const exportedCountWords = actionRunLine(legacyRows.length);
      assert.ok(exportedCountWords, 'the vocabulary export owns run count wording');
      const legacySummary = legacyRun.querySelector('summary');
      assert.ok(legacySummary, 'the legacy run summary exists');
      assert.ok(legacySummary.textContent.includes(exportedCountWords));

      // Mutation A1: overwrite the held call's `at` with the result `at`;
      // the 250 interval and preserved start assertions above turn red.
      // Mutation A2: assign `durationMs = 0` to every unknown interval;
      // the omission matrix above turns red while equal-receipt zero stays positive.
      // Mutation A3: drop `durationMs` or stop using the exported adapter in either
      // production chat route; direct transport, live, history, and total checks turn red.
      // Mutation A4: calculate total from every row or elapsed wall time;
      // the independently summed mixed measured/pending run turns red.
      // Mutation A5: make the disclosure label visual-only, add a second toggle
      // listener, or replace the native run; same-node and exactly-once checks turn red.
    } finally {
      restoreDom();
    }
  });

  /* T288. The activity row's IDLE state had no test evidence, though every
     busy phase did. It is the state a person is in almost all the time: the
     agent is not thinking, not using a tool and not answering, and the row
     must say so rather than hold the last thing it said. A stuck 'thinking'
     on a finished conversation is the exact complaint that makes a working
     agent look hung. */
  test('a chat with nothing running reads idle, and says so on the root', () => {
    const restoreDom = installMinimalDom();
    try {
      const root = buildChat({ title: 'fixture', seed: 0 });
      /* Asserted in SELECTOR form, not by reading the attribute, because the
         selector is what every other surface uses to find this state and what
         the coverage gate can see. A getAttribute() check would be true and
         invisible. */
      assert.ok(root.matches('[data-chat-activity="idle"]'),
        'a chat that has run nothing must report idle');
      const working = root.querySelector('[data-chat-working-counters]');
      if (working) {
        assert.equal(working.closest('[hidden]') !== null || working.hidden === true
          || root.querySelector('.chat-working')?.hidden === true, true,
          'the working indicator must not be showing while idle');
      }
    } finally {
      restoreDom();
    }
  });
}

function findBufferedRow(rows, id, turnId) {
  return rows.find((row) => row.id === id && row.turnId === turnId);
}

function assertNoOwnTiming(row, keys) {
  for (const key of keys) {
    assert.equal(
      Object.hasOwn(row, key),
      false,
      `${row.id} must omit ${key}`,
    );
  }
}

function assertTimingTransport(source, adapted, adapterName) {
  for (const key of ['at', 'startedAt', 'endedAt', 'durationMs']) {
    const sourceOwns = Object.hasOwn(source, key);
    if (sourceOwns && Number.isFinite(source[key])) {
      assert.equal(
        Object.hasOwn(adapted, key),
        true,
        `${adapterName} retains finite ${key}`,
      );
      assert.equal(adapted[key], source[key]);
    }
    if (!sourceOwns) {
      assert.equal(
        Object.hasOwn(adapted, key),
        false,
        `${adapterName} does not invent ${key}`,
      );
    }
  }
  if (Object.hasOwn(source, 'durationMs') && source.durationMs === 0) {
    assert.ok(Object.hasOwn(adapted, 'durationMs'));
    assert.equal(adapted.durationMs, 0);
  }
}

function assertMountedTiming(root, source, formatDuration, totalText) {
  const run = soleHook(root, 'details.chat-action-run');
  const nested = soleHook(run, 'details.chat-action');
  assert.ok(nested, 'the nested action row exists before timing hooks are checked');
  const durationHooks = nested.querySelectorAll('[data-chat-action-duration]');
  if (Object.hasOwn(source, 'durationMs')) {
    assert.equal(durationHooks.length, 1);
    assert.equal(durationHooks[0].textContent, formatDuration(source.durationMs));
    const total = soleHook(run, '[data-chat-action-run-total]');
    assert.equal(total.textContent, totalText(source.durationMs, 1));
  } else {
    assert.equal(durationHooks.length, 0);
    assert.equal(run.querySelectorAll('[data-chat-action-run-total]').length, 0);
  }
}

function assertAdapterRoutes({
  adapter,
  adapterName,
  buildChat,
  formatActionDuration,
  sourceRow,
  actionRunTotalText,
}) {
  assert.ok(sourceRow, `${adapterName} receives an observed buffered row`);
  const adapted = adapter(sourceRow);
  assert.ok(adapted, `${adapterName} returns a row`);
  assertTimingTransport(sourceRow, adapted, adapterName);

  const liveRoot = buildChat({ title: 'fixture', seed: 0 });
  assert.ok(liveRoot, `${adapterName} live chat root exists`);
  liveRoot.addAction(adapter(sourceRow));
  assertMountedTiming(
    liveRoot,
    sourceRow,
    formatActionDuration,
    actionRunTotalText,
  );

  const historyRoot = buildChat({
    title: 'fixture',
    seed: 0,
    history: [{ who: 'action', ...adapter(sourceRow) }],
  });
  assert.ok(historyRoot, `${adapterName} restored chat root exists`);
  assertMountedTiming(
    historyRoot,
    sourceRow,
    formatActionDuration,
    actionRunTotalText,
  );
}

function measuredStats(rows) {
  const durations = rows
    .filter((row) => Object.hasOwn(row, 'durationMs'))
    .map((row) => row.durationMs);
  return {
    count: durations.length,
    sum: durations.reduce((sum, duration) => sum + duration, 0),
  };
}

function nestedDisclosureState(details, summary) {
  return {
    open: details.open,
    className: details.className,
    ariaExpanded: summary.getAttribute('aria-expanded'),
  };
}

function soleHook(root, selector) {
  assert.ok(root, `${selector} search root exists`);
  const matches = root.querySelectorAll(selector);
  assert.equal(matches.length, 1, `${selector} occurs exactly once`);
  assert.ok(matches[0], `${selector} exists`);
  return matches[0];
}

function installMinimalDom() {
  const saved = new Map();
  const globals = {
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    DocumentFragment: MiniDocumentFragment,
    Event: MiniEvent,
    MouseEvent: MiniMouseEvent,
    CustomEvent: MiniCustomEvent,
    ResizeObserver: MiniResizeObserver,
    MutationObserver: MiniMutationObserver,
  };
  const document = new MiniDocument();
  globals.document = document;
  globals.window = {
    document,
    Event: MiniEvent,
    MouseEvent: MiniMouseEvent,
    CustomEvent: MiniCustomEvent,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (callback) => callback(0),
    cancelAnimationFrame() {},
  };
  globals.getComputedStyle = globals.window.getComputedStyle;
  globals.requestAnimationFrame = globals.window.requestAnimationFrame;
  globals.cancelAnimationFrame = globals.window.cancelAnimationFrame;

  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, {
      existed: Object.hasOwn(globalThis, name),
      value: globalThis[name],
    });
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    for (const [name, prior] of saved) {
      if (prior.existed) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          writable: true,
          value: prior.value,
        });
      } else {
        delete globalThis[name];
      }
    }
  };
}

class MiniEvent {
  constructor(type, options = {}) {
    this.type = String(type);
    this.bubbles = Boolean(options.bubbles);
    this.cancelable = Boolean(options.cancelable);
    this.detail = options.detail ?? 0;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this._stopped = false;
    this._immediateStopped = false;
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation() {
    this._stopped = true;
  }

  stopImmediatePropagation() {
    this._stopped = true;
    this._immediateStopped = true;
  }

  composedPath() {
    const path = [];
    let node = this.target;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    return path;
  }
}

class MiniMouseEvent extends MiniEvent {}

class MiniCustomEvent extends MiniEvent {
  constructor(type, options = {}) {
    super(type, options);
    this.detail = options.detail;
  }
}

class MiniResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

class MiniMutationObserver extends MiniResizeObserver {
  constructor(callback) {
    super(callback);
    this.records = [];
    this.registrations = [];
    this.scheduled = false;
    activeMutationObservers.add(this);
  }

  observe(target, options = {}) {
    this.registrations.push({ target, options: { ...options } });
  }

  unobserve(target) {
    this.registrations = this.registrations.filter(
      (registration) => registration.target !== target,
    );
  }

  disconnect() {
    this.registrations = [];
    this.records = [];
    activeMutationObservers.delete(this);
  }

  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
}

const activeMutationObservers = new Set();

function queueMutationRecord(record) {
  for (const observer of activeMutationObservers) {
    const interested = observer.registrations.some(({ target, options }) => {
      const withinTarget = record.target === target
        || (options.subtree && target.contains(record.target));
      if (!withinTarget) return false;
      if (record.type === 'childList') return options.childList;
      if (record.type === 'attributes') return options.attributes;
      if (record.type === 'characterData') return options.characterData;
      return false;
    });
    if (!interested) continue;
    observer.records.push(record);
    if (observer.scheduled) continue;
    observer.scheduled = true;
    queueMicrotask(() => {
      observer.scheduled = false;
      const records = observer.takeRecords();
      if (records.length > 0) observer.callback(records, observer);
    });
  }
}

class MiniNode {
  constructor(nodeType, ownerDocument = null) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }

  get parentElement() {
    return this.parentNode instanceof MiniElement ? this.parentNode : null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    if (value !== null && value !== undefined && String(value) !== '') {
      this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }

  appendChild(node) {
    const child = normalizeNode(node, this.ownerDocument);
    if (child instanceof MiniDocumentFragment) {
      for (const fragmentChild of [...child.childNodes]) {
        this.appendChild(fragmentChild);
      }
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (!child.ownerDocument) child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    queueMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: [],
    });
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  prepend(...nodes) {
    const normalized = nodes.map((node) => normalizeNode(node, this.ownerDocument));
    for (const node of normalized.reverse()) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  insertBefore(node, referenceNode) {
    if (referenceNode === null) return this.appendChild(node);
    const index = this.childNodes.indexOf(referenceNode);
    if (index < 0) throw new Error('reference node is not a child');
    const child = normalizeNode(node, this.ownerDocument);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    queueMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: [],
    });
    return child;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('node is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    queueMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [],
      removedNodes: [node],
    });
    return node;
  }

  replaceChild(node, oldNode) {
    const index = this.childNodes.indexOf(oldNode);
    if (index < 0) throw new Error('old node is not a child');
    const child = normalizeNode(node, this.ownerDocument);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    oldNode.parentNode = null;
    this.childNodes[index] = child;
    queueMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: [oldNode],
    });
    return oldNode;
  }

  replaceChildren(...nodes) {
    const removedNodes = [...this.childNodes];
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (removedNodes.length > 0) {
      queueMutationRecord({
        type: 'childList',
        target: this,
        addedNodes: [],
        removedNodes,
      });
    }
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  before(...nodes) {
    if (!this.parentNode) return;
    let index = this.parentNode.childNodes.indexOf(this);
    for (const node of nodes) {
      const child = normalizeNode(node, this.ownerDocument);
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this.parentNode;
      this.parentNode.childNodes.splice(index, 0, child);
      index += 1;
    }
  }

  after(...nodes) {
    if (!this.parentNode) return;
    let index = this.parentNode.childNodes.indexOf(this) + 1;
    for (const node of nodes) {
      const child = normalizeNode(node, this.ownerDocument);
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this.parentNode;
      this.parentNode.childNodes.splice(index, 0, child);
      index += 1;
    }
  }

  replaceWith(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.childNodes.indexOf(this);
    parent.removeChild(this);
    let offset = 0;
    for (const node of nodes) {
      const child = normalizeNode(node, parent.ownerDocument);
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = parent;
      parent.childNodes.splice(index + offset, 0, child);
      offset += 1;
    }
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  addEventListener(type, listener, options = {}) {
    if (!listener) return;
    const entries = this._listeners.get(type) ?? [];
    entries.push({ listener, once: Boolean(options?.once) });
    this._listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this._listeners.get(type) ?? [];
    this._listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  dispatchEvent(event) {
    if (!(event instanceof MiniEvent)) throw new TypeError('event must be an Event');
    if (!event.target) event.target = this;
    const path = [this];
    if (event.bubbles) {
      let parent = this.parentNode;
      while (parent) {
        path.push(parent);
        parent = parent.parentNode;
      }
    }
    for (const current of path) {
      event.currentTarget = current;
      event.eventPhase = current === event.target ? 2 : 3;
      const entries = [...(current._listeners.get(event.type) ?? [])];
      for (const entry of entries) {
        if (entry.once) current.removeEventListener(event.type, entry.listener);
        if (typeof entry.listener === 'function') {
          entry.listener.call(current, event);
        } else {
          entry.listener.handleEvent(event);
        }
        if (event._immediateStopped) break;
      }
      if (event._stopped) break;
    }
    event.currentTarget = null;
    event.eventPhase = 0;
    if (event.type === 'click' && !event.defaultPrevented) {
      activateSummaryDefault(event.target);
    }
    return !event.defaultPrevented;
  }

  cloneNode(deep = false) {
    const clone = new MiniNode(this.nodeType, this.ownerDocument);
    if (deep) {
      for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    }
    return clone;
  }
}

class MiniText extends MiniNode {
  constructor(data, ownerDocument) {
    super(3, ownerDocument);
    this.data = String(data);
  }

  get nodeName() {
    return '#text';
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? '');
    queueMutationRecord({
      type: 'characterData',
      target: this,
      oldValue: null,
    });
  }

  cloneNode() {
    return new MiniText(this.data, this.ownerDocument);
  }
}

class MiniClassList {
  constructor(element) {
    this.element = element;
  }

  _values() {
    return (this.element.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean);
  }

  _write(values) {
    this.element.setAttribute('class', [...new Set(values)].join(' '));
  }

  add(...tokens) {
    this._write([...this._values(), ...tokens.map(String)]);
  }

  remove(...tokens) {
    const removed = new Set(tokens.map(String));
    this._write(this._values().filter((value) => !removed.has(value)));
  }

  contains(token) {
    return this._values().includes(String(token));
  }

  toggle(token, force) {
    const present = this.contains(token);
    const shouldAdd = force === undefined ? !present : Boolean(force);
    if (shouldAdd) this.add(token);
    else this.remove(token);
    return shouldAdd;
  }

  replace(oldToken, newToken) {
    if (!this.contains(oldToken)) return false;
    this.remove(oldToken);
    this.add(newToken);
    return true;
  }

  get value() {
    return this._values().join(' ');
  }

  toString() {
    return this.value;
  }

  [Symbol.iterator]() {
    return this._values()[Symbol.iterator]();
  }
}

class MiniStyle {
  constructor() {
    this._values = new Map();
  }

  setProperty(name, value) {
    this._values.set(String(name), String(value));
  }

  getPropertyValue(name) {
    return this._values.get(String(name)) ?? '';
  }

  removeProperty(name) {
    const value = this.getPropertyValue(name);
    this._values.delete(String(name));
    return value;
  }
}

class MiniElement extends MiniNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.classList = new MiniClassList(this);
    this.style = new MiniStyle();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this._open = false;
    this.dataset = createDatasetProxy(this);
  }

  get nodeName() {
    return this.tagName;
  }

  get children() {
    return this.childNodes.filter((child) => child instanceof MiniElement);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  get childElementCount() {
    return this.children.length;
  }

  get nextElementSibling() {
    let node = this.nextSibling;
    while (node && !(node instanceof MiniElement)) node = node.nextSibling;
    return node;
  }

  get previousElementSibling() {
    let node = this.previousSibling;
    while (node && !(node instanceof MiniElement)) node = node.previousSibling;
    return node;
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get open() {
    return this._open;
  }

  set open(value) {
    const next = Boolean(value);
    const changed = next !== this._open;
    this._open = next;
    if (next) this.attributes.set('open', '');
    else this.attributes.delete('open');
    if (changed && this.localName === 'details') {
      this.dispatchEvent(new MiniEvent('toggle'));
    }
  }

  get innerHTML() {
    return this._innerHTML ?? this.textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    parseHtmlInto(this, this._innerHTML);
  }

  get scrollHeight() {
    return this.childNodes.length;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node instanceof MiniDocument;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const oldValue = this.getAttribute(key);
    this.attributes.set(key, String(value));
    if (key === 'open') this._open = true;
    queueMutationRecord({
      type: 'attributes',
      target: this,
      attributeName: key,
      oldValue,
    });
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    const oldValue = this.getAttribute(key);
    this.attributes.delete(key);
    if (key === 'open') this._open = false;
    if (oldValue !== null) {
      queueMutationRecord({
        type: 'attributes',
        target: this,
        attributeName: key,
        oldValue,
      });
    }
  }

  toggleAttribute(name, force) {
    const present = this.hasAttribute(name);
    const shouldAdd = force === undefined ? !present : Boolean(force);
    if (shouldAdd) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return shouldAdd;
  }

  getAttributeNames() {
    return [...this.attributes.keys()];
  }

  matches(selector) {
    return matchesComplexSelector(this, selector, this);
  }

  closest(selector) {
    let node = this;
    while (node instanceof MiniElement) {
      if (matchesComplexSelector(node, selector, node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    walkElements(this, (element) => {
      if (matchesComplexSelector(element, selector, this)) results.push(element);
    });
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementsByClassName(className) {
    return this.querySelectorAll(`.${className}`);
  }

  click() {
    this.dispatchEvent(new MiniMouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    }));
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatchEvent(new MiniEvent('focus'));
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.dispatchEvent(new MiniEvent('blur'));
  }

  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
  }

  scrollIntoView() {}

  animate() {
    return { cancel() {}, finished: Promise.resolve() };
  }

  cloneNode(deep = false) {
    const clone = new MiniElement(this.localName, this.ownerDocument);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    clone.hidden = this.hidden;
    clone.disabled = this.disabled;
    clone.value = this.value;
    clone.checked = this.checked;
    clone._open = this._open;
    if (deep) {
      for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    }
    return clone;
  }
}

class MiniDocumentFragment extends MiniNode {
  constructor(ownerDocument) {
    super(11, ownerDocument);
  }

  get children() {
    return this.childNodes.filter((child) => child instanceof MiniElement);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  querySelectorAll(selector) {
    const results = [];
    walkElements(this, (element) => {
      if (matchesComplexSelector(element, selector, this)) results.push(element);
    });
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class MiniTemplateElement extends MiniElement {
  constructor(ownerDocument) {
    super('template', ownerDocument);
    this.content = new MiniDocumentFragment(ownerDocument);
  }

  get innerHTML() {
    return this._innerHTML ?? '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    parseHtmlInto(this.content, this._innerHTML);
  }

  cloneNode(deep = false) {
    const clone = new MiniTemplateElement(this.ownerDocument);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    if (deep) {
      for (const child of this.content.childNodes) {
        clone.content.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(9, null);
    this.ownerDocument = this;
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    if (String(tagName).toLowerCase() === 'template') {
      return new MiniTemplateElement(this);
    }
    return new MiniElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  createTextNode(data) {
    return new MiniText(data, this);
  }

  createDocumentFragment() {
    return new MiniDocumentFragment(this);
  }

  querySelectorAll(selector) {
    const results = [];
    if (matchesComplexSelector(this.documentElement, selector, this)) {
      results.push(this.documentElement);
    }
    walkElements(this.documentElement, (element) => {
      if (matchesComplexSelector(element, selector, this)) results.push(element);
    });
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

function normalizeNode(value, ownerDocument) {
  if (value instanceof MiniNode) return value;
  return ownerDocument.createTextNode(String(value));
}

function parseHtmlInto(root, html) {
  root.replaceChildren();
  const document = root.ownerDocument;
  const stack = [root];
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g;
  for (const match of String(html).matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1) {
        const popped = stack.pop();
        if (popped.localName === closingName) break;
      }
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const body = token.slice(1, selfClosing ? -2 : -1).trim();
      const nameMatch = body.match(/^([^\s/>]+)/);
      if (!nameMatch) continue;
      const tagName = nameMatch[1];
      const element = document.createElement(tagName);
      const attributeSource = body.slice(nameMatch[0].length);
      const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      for (const attributeMatch of attributeSource.matchAll(attributePattern)) {
        const name = attributeMatch[1];
        const value = attributeMatch[2]
          ?? attributeMatch[3]
          ?? attributeMatch[4]
          ?? '';
        element.setAttribute(name, decodeHtml(value));
      }
      stack[stack.length - 1].appendChild(element);
      if (!selfClosing && !voidTags.has(element.localName)) stack.push(element);
      continue;
    }
    if (token !== '') {
      stack[stack.length - 1].appendChild(
        document.createTextNode(decodeHtml(token)),
      );
    }
  }
}

function decodeHtml(value) {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', '\u00a0'],
    ['quot', '"'],
  ]);
  return String(value).replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (_entity, code) => {
      if (code[0] !== '#') return named.get(code.toLowerCase()) ?? _entity;
      const numeric = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _entity;
    },
  );
}

function createDatasetProxy(element) {
  const attributeName = (property) => `data-${String(property).replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`,
  )}`;
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined;
      const value = element.getAttribute(attributeName(property));
      return value === null ? undefined : value;
    },
    set(_target, property, value) {
      element.setAttribute(attributeName(property), value);
      return true;
    },
    deleteProperty(_target, property) {
      element.removeAttribute(attributeName(property));
      return true;
    },
    ownKeys() {
      return element.getAttributeNames()
        .filter((name) => name.startsWith('data-'))
        .map((name) => name
          .slice(5)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()));
    },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true };
    },
  });
}

function activateSummaryDefault(target) {
  if (!(target instanceof MiniElement)) return;
  const summary = target.localName === 'summary' ? target : target.closest('summary');
  if (!summary) return;
  const details = summary.parentElement;
  if (!details || details.localName !== 'details') return;
  const firstSummary = details.children.find(
    (child) => child.localName === 'summary',
  );
  if (firstSummary !== summary) return;
  details.open = !details.open;
}

function walkElements(root, visit) {
  for (const child of root.childNodes) {
    if (child instanceof MiniElement) {
      visit(child);
      walkElements(child, visit);
    }
  }
}

function matchesComplexSelector(element, selector, scope) {
  return String(selector)
    .split(',')
    .some((part) => matchesSelectorBranch(element, part.trim(), scope));
}

function matchesSelectorBranch(element, selector, scope) {
  const parts = tokenizeSelector(selector);
  if (parts.length === 0) return false;
  return matchSelectorPart(element, parts, parts.length - 1, scope);
}

function matchSelectorPart(element, parts, index, scope) {
  if (!(element instanceof MiniElement)) return false;
  if (!matchesCompound(element, parts[index].compound, scope)) return false;
  if (index === 0) return true;
  const combinator = parts[index].combinator;
  if (combinator === '>') {
    return matchSelectorPart(element.parentElement, parts, index - 1, scope);
  }
  let ancestor = element.parentElement;
  while (ancestor) {
    if (matchSelectorPart(ancestor, parts, index - 1, scope)) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

function tokenizeSelector(selector) {
  const parts = [];
  let buffer = '';
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let pendingCombinator = null;
  const push = () => {
    const compound = buffer.trim();
    if (!compound) return;
    parts.push({
      compound,
      combinator: parts.length === 0 ? null : (pendingCombinator ?? ' '),
    });
    buffer = '';
    pendingCombinator = null;
  };
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;
    if (char === '(') parenthesisDepth += 1;
    if (char === ')') parenthesisDepth -= 1;
    if (bracketDepth === 0 && parenthesisDepth === 0 && char === '>') {
      push();
      pendingCombinator = '>';
      continue;
    }
    if (bracketDepth === 0 && parenthesisDepth === 0 && /\s/.test(char)) {
      if (buffer.trim()) push();
      if (parts.length > 0 && pendingCombinator === null) pendingCombinator = ' ';
      continue;
    }
    buffer += char;
  }
  push();
  return parts;
}

function matchesCompound(element, compound, scope) {
  let rest = compound;
  if (rest.includes(':scope')) {
    if (element !== scope) return false;
    rest = rest.replaceAll(':scope', '');
  }

  for (const match of [...rest.matchAll(/:not\(([^)]+)\)/g)]) {
    if (matchesComplexSelector(element, match[1], scope)) return false;
  }
  rest = rest.replace(/:not\([^)]+\)/g, '');

  if (rest.includes(':first-child')) {
    if (element.parentElement?.firstElementChild !== element) return false;
    rest = rest.replaceAll(':first-child', '');
  }
  if (rest.includes(':last-child')) {
    if (element.parentElement?.lastElementChild !== element) return false;
    rest = rest.replaceAll(':last-child', '');
  }

  const nthMatch = rest.match(/:nth-child\((\d+)\)/);
  if (nthMatch) {
    const index = element.parentElement?.children.indexOf(element) ?? -1;
    if (index + 1 !== Number(nthMatch[1])) return false;
    rest = rest.replace(nthMatch[0], '');
  }

  const tagMatch = rest.match(/^[a-zA-Z*][\w-]*/);
  if (tagMatch) {
    if (tagMatch[0] !== '*' && element.localName !== tagMatch[0].toLowerCase()) {
      return false;
    }
    rest = rest.slice(tagMatch[0].length);
  }

  for (const idMatch of rest.matchAll(/#([\w-]+)/g)) {
    if (element.id !== idMatch[1]) return false;
  }
  for (const classMatch of rest.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(classMatch[1])) return false;
  }
  for (const attributeMatch of rest.matchAll(
    /\[([^\]\s~|^$*=]+)(?:\s*([~|^$*]?=)\s*["']?([^\]"']*)["']?)?\]/g,
  )) {
    const [, name, operator, expected] = attributeMatch;
    if (!element.hasAttribute(name)) return false;
    if (!operator) continue;
    const actual = element.getAttribute(name);
    if (operator === '=' && actual !== expected) return false;
    if (operator === '^=' && !actual.startsWith(expected)) return false;
    if (operator === '$=' && !actual.endsWith(expected)) return false;
    if (operator === '*=' && !actual.includes(expected)) return false;
    if (operator === '~=' && !actual.split(/\s+/).includes(expected)) return false;
    if (operator === '|=' && actual !== expected && !actual.startsWith(`${expected}-`)) {
      return false;
    }
  }

  const stripped = rest
    .replace(/#[\w-]+/g, '')
    .replace(/\.[\w-]+/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .trim();
  return stripped === '';
}
