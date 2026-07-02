#!/usr/bin/env node

/**
 * Auditability fixes:
 *   A) buildStepLogUpdates() preserves EVERY iteration's transcript in
 *      `_stepLogHistory[nodeId]` (cyclic agent↔verify rounds no longer
 *      overwrite each other), while `_stepLogs[nodeId]` keeps the latest.
 *   B) _isCitationProducingTool() recognizes braveSearch (and any *search*
 *      tool), so search-result URLs actually become citations.
 *
 * Run directly: `node server/tests/agent-audit-trail.test.js`.
 */

import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  console.log('🧪 A — step-log history accumulates across iterations (LIGHT entries)\n');
  {
    const ex = new VerifierNodeExecutor(); // inherits BaseNodeExecutor
    // A realistic, HEAVY step log: full messages transcript + big output +
    // tool-call arg/result previews. None of the heavy parts may end up in
    // the per-round history (that's the state-explosion guard).
    const heavyLog = iteration => ({
      kind: 'agent',
      model: 'gemini-flash-latest',
      durationMs: 1234,
      output: 'X'.repeat(5000), // big draft
      messages: [
        { role: 'system', content: 'S'.repeat(4000) },
        { role: 'user', content: 'U'.repeat(8000) }
      ],
      toolCalls: [
        { name: 'braveSearch', args: 'a'.repeat(1000), result: 'r'.repeat(1000), durationMs: 50 },
        {
          name: 'webContentExtractor',
          args: 'a'.repeat(1000),
          result: 'r'.repeat(1000),
          durationMs: 90
        }
      ],
      responseLength: 5000,
      planSnapshot: [{ id: 't1', title: `Task round ${iteration}`, status: 'done' }]
    });

    let state = { data: {} };
    state = { data: { ...state.data, ...ex.buildStepLogUpdates(state, 'agent', heavyLog(1), 1) } };
    state = { data: { ...state.data, ...ex.buildStepLogUpdates(state, 'agent', heavyLog(2), 2) } };

    const hist = state.data._stepLogHistory?.agent;
    check('history has one entry per iteration', Array.isArray(hist) && hist.length === 2);
    check(
      'entries are stamped with their iteration',
      hist?.[0]?.iteration === 1 && hist?.[1]?.iteration === 2
    );

    // The explosion guard: NO heavy fields in history entries.
    const e0 = hist?.[0] || {};
    check('history entry drops the full messages transcript', e0.messages === undefined);
    check('history entry drops the full output', e0.output === undefined);
    check(
      'history entry keeps only a bounded output excerpt',
      typeof e0.outputExcerpt === 'string' && e0.outputExcerpt.length <= 500
    );
    check(
      'history entry keeps tool NAMES, not arg/result previews',
      Array.isArray(e0.toolNames) && e0.toolNames[0] === 'braveSearch' && e0.toolNames.length === 2
    );
    check('history entry has no toolCalls with previews', e0.toolCalls === undefined);
    check(
      'history entry keeps the small plan snapshot',
      e0.planSnapshot?.[0]?.title === 'Task round 1'
    );

    // Sanity: a single history entry stays small (a few hundred bytes, not ~20KB).
    const entryBytes = JSON.stringify(e0).length;
    check('history entry is small (< 2KB)', entryBytes < 2048, `entry was ${entryBytes} bytes`);

    // The ONE full transcript (latest) is still available under _stepLogs.
    check(
      '_stepLogs keeps the FULL latest transcript',
      Array.isArray(state.data._stepLogs?.agent?.messages)
    );

    // A second node id is independent.
    state = {
      data: {
        ...state.data,
        ...ex.buildStepLogUpdates(state, 'verify', { kind: 'verifier', verdict: 'FAIL' }, 1)
      }
    };
    check('other node history is independent', state.data._stepLogHistory?.verify?.length === 1);
    check(
      'agent history untouched by verify update',
      state.data._stepLogHistory?.agent?.length === 2
    );
  }

  console.log('\n🧪 A — history length is capped (runaway-loop backstop)\n');
  {
    const ex = new VerifierNodeExecutor();
    let state = { data: {} };
    for (let i = 1; i <= 40; i++) {
      state = {
        data: {
          ...state.data,
          ...ex.buildStepLogUpdates(state, 'agent', { kind: 'agent', output: 'x' }, i)
        }
      };
    }
    check('history is capped at 25 entries', state.data._stepLogHistory?.agent?.length === 25);
    check(
      'cap keeps the most recent entries',
      state.data._stepLogHistory?.agent?.slice(-1)[0]?.iteration === 40
    );
  }

  console.log('\n🧪 B — braveSearch is recognized as citation-producing\n');
  {
    const p = new PromptNodeExecutor({ llmHelper: {}, chatService: {} });
    check('braveSearch → citation-producing', p._isCitationProducingTool('braveSearch') === true);
    check('webSearch → citation-producing', p._isCitationProducingTool('webSearch') === true);
    check(
      'webContentExtractor → citation-producing',
      p._isCitationProducingTool('webContentExtractor') === true
    );
    check(
      'source_ lookups → citation-producing',
      p._isCitationProducingTool('source_kb1') === true
    );
    check(
      'non-search tool (createTask) → NOT citation-producing',
      p._isCitationProducingTool('createTask') === false
    );
    check('set_plan → NOT citation-producing', p._isCitationProducingTool('set_plan') === false);
  }

  console.log('\n🧪 C — verifier failures carried into per-round history (bounded)\n');
  {
    const ex = new VerifierNodeExecutor();
    const verifierLog = {
      kind: 'verifier',
      verdict: 'FAIL',
      conclusive: true,
      durationMs: 4300,
      output: 'O'.repeat(4000),
      messages: [{ role: 'system', content: 'S'.repeat(2000) }],
      // 14 concrete defects; the FIRST is very long. History must bound BOTH
      // the count (cap 12) and each item's length (clip ~600) so the per-round
      // summary stays light.
      failures: [
        'L'.repeat(2000),
        ...Array.from({ length: 13 }, (_, i) => `Failure ${i + 1}: unsupported claim`)
      ]
    };
    const updates = ex.buildStepLogUpdates({ data: {} }, 'verify', verifierLog, 1);
    const entry = updates._stepLogHistory?.verify?.[0];
    check('history entry carries a failures array', Array.isArray(entry?.failures));
    check(
      'failures count capped at 12',
      entry?.failures?.length === 12,
      `got ${entry?.failures?.length}`
    );
    check(
      'short failures preserved verbatim',
      entry?.failures?.[1] === 'Failure 1: unsupported claim'
    );
    check(
      'long failure clipped to ~600 chars with ellipsis',
      entry?.failures?.[0]?.length <= 601 && entry?.failures?.[0]?.endsWith('…'),
      `len=${entry?.failures?.[0]?.length}`
    );
    check('verdict still summarized', entry?.verdict === 'FAIL');
    // The heavy output transcript must NOT bloat the history entry.
    check('history entry does not carry full output', entry?.output === undefined);

    // A passing verifier with no failures → no failures array.
    const passUpdates = ex.buildStepLogUpdates(
      { data: {} },
      'verify',
      { kind: 'verifier', verdict: 'PASS' },
      1
    );
    const passEntry = passUpdates._stepLogHistory?.verify?.[0];
    check('no failures → undefined (not an empty array)', passEntry?.failures === undefined);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
