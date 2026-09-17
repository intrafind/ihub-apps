#!/usr/bin/env node

/**
 * Tests for token-usage aggregation on the agent run page.
 *
 * Per-step token usage already lives in run.data._stepLogs[id].tokens =
 * { input, output }. This aggregates it into run-level totals + a per-model
 * breakdown for the summary card. Pure (no React) so it runs under node.
 *
 * Run directly: `node client/src/features/admin/utils/tokenStats.test.js`.
 */

import { aggregateTokenUsage, formatTokenCount } from './tokenStats.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 aggregateTokenUsage\n');
{
  const empty = aggregateTokenUsage(null);
  check('null → all zeros', empty.totalInput === 0 && empty.totalOutput === 0 && empty.total === 0);
  check('null → llmStepCount 0', empty.llmStepCount === 0);
  check('null → empty byModel', Object.keys(empty.byModel).length === 0);

  const stepLogs = {
    'inbox-load': { kind: 'inbox-load' }, // no tokens
    planner: { kind: 'planner', tokens: null }, // null tokens
    'rowan-bio': {
      kind: 'agent',
      model: 'gemini-flash-latest',
      tokens: { input: 34336, output: 3047 }
    },
    'rowan-pubs': {
      kind: 'agent',
      model: 'gemini-flash-latest',
      tokens: { input: 61322, output: 4117 }
    },
    verify: { kind: 'verifier', model: 'gemini-3.1-pro', tokens: { input: 10000, output: 500 } },
    'zero-step': { kind: 'agent', model: 'x', tokens: { input: 0, output: 0 } } // recorded but empty
  };
  const agg = aggregateTokenUsage(stepLogs);
  check(
    'sums input across token-bearing steps',
    agg.totalInput === 34336 + 61322 + 10000,
    `got ${agg.totalInput}`
  );
  check('sums output', agg.totalOutput === 3047 + 4117 + 500, `got ${agg.totalOutput}`);
  check('total = input + output', agg.total === agg.totalInput + agg.totalOutput);
  check(
    'llmStepCount counts only steps with non-zero usage',
    agg.llmStepCount === 3,
    `got ${agg.llmStepCount}`
  );
  check(
    'byModel groups gemini-flash-latest',
    agg.byModel['gemini-flash-latest']?.input === 34336 + 61322
  );
  check('byModel groups gemini-3.1-pro', agg.byModel['gemini-3.1-pro']?.output === 500);
  check(
    'skips steps without tokens (no "unknown" from inbox-load/planner)',
    agg.byModel['unknown'] === undefined
  );
}

console.log('\n🧪 aggregateTokenUsage — multi-round history\n');
{
  // _stepLogs holds only the LATEST round of each cyclic node; the per-round
  // history holds all rounds. The card must sum ALL rounds.
  const stepLogs = {
    // 'agent' ran twice; _stepLogs has only round 2.
    agent: { kind: 'agent', model: 'gemini-flash-latest', tokens: { input: 5000, output: 400 } },
    // 'verify' ran twice; _stepLogs has only round 2.
    verify: { kind: 'verifier', model: 'gemini-3.1-pro', tokens: { input: 2000, output: 100 } },
    // A once-only node with no history entry — must fall back to _stepLogs.
    'inbox-finalize': { kind: 'inbox-finalize', model: 'x', tokens: { input: 300, output: 30 } }
  };
  const stepLogHistory = {
    agent: [
      { model: 'gemini-flash-latest', tokens: { input: 3000, output: 250 } },
      { model: 'gemini-flash-latest', tokens: { input: 5000, output: 400 } }
    ],
    verify: [
      { model: 'gemini-3.1-pro', tokens: { input: 1500, output: 80 } },
      { model: 'gemini-3.1-pro', tokens: { input: 2000, output: 100 } }
    ]
  };
  const agg = aggregateTokenUsage(stepLogs, stepLogHistory);
  check(
    'sums BOTH rounds of each cyclic node + falls back to _stepLogs for others',
    agg.totalInput === 3000 + 5000 + 1500 + 2000 + 300,
    `got ${agg.totalInput}`
  );
  check(
    'sums output across rounds',
    agg.totalOutput === 250 + 400 + 80 + 100 + 30,
    `got ${agg.totalOutput}`
  );
  check('llmStepCount counts each round', agg.llmStepCount === 5, `got ${agg.llmStepCount}`);
  check(
    'byModel sums rounds (no double-count of latest)',
    agg.byModel['gemini-flash-latest']?.input === 3000 + 5000,
    `got ${agg.byModel['gemini-flash-latest']?.input}`
  );

  // Backward-compat: no history arg → behaves exactly like before (latest only).
  const aggNoHistory = aggregateTokenUsage(stepLogs);
  check(
    'no history arg → sums only _stepLogs (latest round)',
    aggNoHistory.totalInput === 5000 + 2000 + 300,
    `got ${aggNoHistory.totalInput}`
  );
}

console.log('\n🧪 formatTokenCount\n');
{
  check(
    '3343003 → 3.34M',
    formatTokenCount(3343003) === '3.34M',
    `got ${formatTokenCount(3343003)}`
  );
  check('34336 → 34.3K', formatTokenCount(34336) === '34.3K', `got ${formatTokenCount(34336)}`);
  check('1000 → 1.0K', formatTokenCount(1000) === '1.0K', `got ${formatTokenCount(1000)}`);
  check('999 → 999', formatTokenCount(999) === '999');
  check('0 → 0', formatTokenCount(0) === '0');
  check('non-number → dash', formatTokenCount(undefined) === '—');
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
