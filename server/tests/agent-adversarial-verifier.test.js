#!/usr/bin/env node

/**
 * Unit tests for the adversarial verifier mode on VerifierNodeExecutor
 * (Claude Code verification-agent analog) and its reconsideration hook:
 *   - interpretResult maps PASS/FAIL/PARTIAL verdicts correctly
 *   - quality mode still scores numerically
 *   - the adversarial system prompt instructs the model to try to break it
 *   - failures surface as `_lastReviewGaps` for planner re-entry
 *
 * Run directly: `node server/tests/agent-adversarial-verifier.test.js`.
 */

import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  const v = new VerifierNodeExecutor();

  console.log('🧪 interpretResult — adversarial mode\n');
  {
    const pass = v.interpretResult({ verdict: 'PASS', failures: [] }, { mode: 'adversarial' });
    check('PASS → passed/score 1', pass.passed === true && pass.score === 1);

    const partial = v.interpretResult(
      { verdict: 'PARTIAL', failures: ['missing edge case'] },
      { mode: 'adversarial' }
    );
    check('PARTIAL → not passed, score 0.5', partial.passed === false && partial.score === 0.5);
    check('PARTIAL keeps failures', partial.failures.length === 1);

    const fail = v.interpretResult(
      { verdict: 'FAIL', failures: ['wrong output', 'crashes on empty'] },
      { mode: 'adversarial' }
    );
    check('FAIL → not passed, score 0', fail.passed === false && fail.score === 0);
    check('FAIL keeps all failures', fail.failures.length === 2);

    const bogus = v.interpretResult({ verdict: 'maybe?' }, { mode: 'adversarial' });
    check(
      'unknown verdict is INCONCLUSIVE (not a substantive FAIL)',
      bogus.verdict === 'INCONCLUSIVE' && bogus.conclusive === false && bogus.passed === false
    );

    // A FAIL with no concrete gaps and no rationale is not actionable — the
    // verifier couldn't say WHY. Treat it as inconclusive, not a real rejection.
    const emptyFail = v.interpretResult({ verdict: 'FAIL' }, { mode: 'adversarial' });
    check(
      'contentless FAIL → INCONCLUSIVE',
      emptyFail.verdict === 'INCONCLUSIVE' && emptyFail.conclusive === false
    );

    // A FAIL WITH concrete gaps is a genuine, conclusive rejection.
    const realFail = v.interpretResult(
      { verdict: 'FAIL', failures: ['Section 2 unsupported'] },
      { mode: 'adversarial' }
    );
    check(
      'FAIL with gaps is conclusive',
      realFail.verdict === 'FAIL' && realFail.conclusive === true
    );
    check('PASS is conclusive', pass.conclusive === true);
  }

  console.log('\n🧪 resolveModel — verifier inherits the run/profile model\n');
  {
    const models = [
      { id: 'local-vllm', default: true },
      { id: 'gemini-flash-3', default: false },
      { id: 'cheap-verifier', default: false }
    ];
    // No per-node override → inherit the run's workflow default (profile model).
    const inherited = v.resolveModel(
      models,
      {},
      {
        workflow: { config: { defaultModelId: 'gemini-flash-3' } }
      }
    );
    check(
      'inherits workflow defaultModelId (profile preferredModel)',
      inherited?.id === 'gemini-flash-3'
    );

    // Per-node config.modelId still wins (advanced override).
    const overridden = v.resolveModel(
      models,
      { modelId: 'cheap-verifier' },
      {
        workflow: { config: { defaultModelId: 'gemini-flash-3' } }
      }
    );
    check('per-node config.modelId overrides the default', overridden?.id === 'cheap-verifier');

    // Nothing configured → global default.
    const fallback = v.resolveModel(models, {}, {});
    check('falls back to the global default', fallback?.id === 'local-vllm');

    check('no models → null', v.resolveModel([], {}, {}) === null);
  }

  console.log('\n🧪 interpretResult — quality mode (unchanged)\n');
  {
    const hi = v.interpretResult({ score: 0.9 }, { mode: 'quality', threshold: 0.7 });
    check('score >= threshold passes', hi.passed === true && hi.score === 0.9);
    const lo = v.interpretResult({ score: 0.4 }, { mode: 'quality', threshold: 0.7 });
    check('score < threshold fails', lo.passed === false);
    const clamp = v.interpretResult({ score: 5 }, { mode: 'quality', threshold: 0.7 });
    check('score clamped to [0,1]', clamp.score === 1);
  }

  console.log('\n🧪 adversarial system prompt\n');
  {
    const msgs = v.buildAdversarialMessages('Must handle empty input', 'function f(){}');
    const sys = msgs[0].content;
    check('system role is adversarial', /try to break it/i.test(sys));
    check(
      'asks for PASS/FAIL/PARTIAL verdict',
      /PASS/.test(sys) && /FAIL/.test(sys) && /PARTIAL/.test(sys)
    );
    check('names rationalizations', /rationalization/i.test(sys));
    check(
      'user message carries criteria + output',
      /Must handle empty input/.test(msgs[1].content)
    );
  }

  console.log('\n🧪 reconsideration hook — execute() surfaces gaps\n');
  {
    // Stub the LLM helper so execute() returns a FAIL verdict with failures.
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({
        content: JSON.stringify({
          verdict: 'FAIL',
          failures: ['Section 3 is unsupported', 'No handling for empty input'],
          rationale: 'Two material gaps remain.'
        })
      })
    };
    const exec = new VerifierNodeExecutor({ llmHelper });
    const node = { id: 'verify1', config: { mode: 'adversarial', criteria: 'Be complete' } };
    const state = { data: { nodeResults: { synth: { output: { content: 'a partial report' } } } } };

    // execute() resolves a model from configCache; only assert gap-surfacing
    // when a model is available in this environment, otherwise skip gracefully.
    const result = await exec.execute(node, state, { language: 'en' });
    if (result.status === 'completed') {
      check('verdict FAIL routes to retry branch', result.branch === 'retry');
      check(
        'failures surface as _lastReviewGaps for the planner',
        Array.isArray(result.stateUpdates._lastReviewGaps) &&
          result.stateUpdates._lastReviewGaps.length === 2
      );
      check(
        'verificationResult records verdict + mode',
        result.stateUpdates.verificationResult.verdict === 'FAIL' &&
          result.stateUpdates.verificationResult.mode === 'adversarial'
      );
    } else {
      console.log('   ⏭  no model available in this env — skipping execute() integration asserts');
    }
  }

  console.log('\n🧪 retries exhausted — preserve the deliverable, end flagged not-passed\n');
  {
    // When the retry budget is spent on genuine fails, neither force-PASS (green
    // over flawed work) nor hard-FAIL (discard a usable draft) is right. The run
    // ends cleanly (isTerminal) with the draft preserved and flagged not-passed,
    // and the inbox item is NOT marked done. This path returns before any model
    // is resolved, so it runs without an LLM in any environment.
    const exec = new VerifierNodeExecutor();
    const node = {
      id: 'verify',
      config: { mode: 'adversarial', inputVariable: 'draft', maxRetries: 2 }
    };
    const state = {
      data: {
        draft: 'some unverified deliverable',
        _verifier_retries_verify: 2,
        verificationResult: {
          passed: false,
          verdict: 'FAIL',
          feedback: 'Section 3 is unsupported.'
        },
        _lastReviewGaps: ['Section 3 is unsupported.']
      }
    };
    const result = await exec.execute(node, state, { language: 'en' });
    check('does not hard-fail the node', result.status === 'completed');
    check('short-circuits the run (isTerminal)', result.isTerminal === true);
    check('flags the run not-passed', result.stateUpdates?._verificationOutcome === 'not_passed');
    check('does NOT branch to pass (no inbox finalize)', result.branch !== 'pass');
    check(
      'preserves the last review feedback in verificationResult',
      /Section 3 is unsupported/.test(result.stateUpdates?.verificationResult?.feedback || '')
    );
  }

  console.log('\n🧪 stalled progress ends the loop early (before maxRetries)\n');
  {
    // If the verifier finds no fewer gaps for STALL_LIMIT rounds, the agent
    // isn't making progress — stop instead of burning the whole retry budget.
    // This gate is checked before any model call, so it runs without an LLM.
    // Default knobs: acceptPartialAfterStall:true → stall accepts the draft (branch:'pass').
    const exec = new VerifierNodeExecutor();
    const node = {
      id: 'verify',
      config: { mode: 'adversarial', inputVariable: 'draft', maxRetries: 6, stallLimit: 2 }
    };
    const state = {
      data: {
        draft: 'a deliverable that keeps tripping the same gaps',
        _verifier_retries_verify: 2, // well below maxRetries (6)
        _verifier_stall_verify: 2, // at the stall limit
        verificationResult: { feedback: 'same gaps as last round' },
        _lastReviewGaps: ['gap a', 'gap b']
      }
    };
    const result = await exec.execute(node, state, { language: 'en' });
    check(
      'stall ends the run before the retry ceiling (accepted via stall)',
      result.status === 'completed'
    );
    check('default knobs: stall accepts draft (branch pass)', result.branch === 'pass');
    check(
      'stall accept: verificationResult.accepted=stall',
      result.stateUpdates?.verificationResult?.accepted === 'stall'
    );

    // With requirePass:true, stall still ends not-passed (strict mode).
    const strictNode = {
      id: 'verify',
      config: {
        mode: 'adversarial',
        inputVariable: 'draft',
        maxRetries: 6,
        stallLimit: 2,
        requirePass: true
      }
    };
    const strictResult = await exec.execute(strictNode, state, { language: 'en' });
    check('requirePass + stall → not-passed (isTerminal)', strictResult.isTerminal === true);
    check(
      'requirePass + stall → _verificationOutcome not_passed',
      strictResult.stateUpdates?._verificationOutcome === 'not_passed'
    );
  }

  console.log('\n🧪 inconclusive verdict is accepted-with-warning (not a wasted retry)\n');
  {
    // The bug from run wf-exec-969e154f: the local model returned no parseable
    // verdict, interpretResult defaulted to a contentless FAIL, and the run
    // burned retries then hard-failed an okish draft. Now an inconclusive verdict
    // passes through with a warning and does NOT spend a retry.
    const llmHelper = {
      verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
      executeStreamingRequest: async () => ({ content: 'I am not sure how to judge this.' })
    };
    const exec = new VerifierNodeExecutor({ llmHelper });
    const node = {
      id: 'verify',
      config: { mode: 'adversarial', inputVariable: 'draft', maxRetries: 2 }
    };
    const state = { data: { draft: 'an okish deliverable', _verifier_retries_verify: 0 } };
    const result = await exec.execute(node, state, { language: 'en' });
    if (result.status === 'completed' && result.branch) {
      check('inconclusive does not retry (branch pass)', result.branch === 'pass');
      check('retry counter not incremented', result.stateUpdates?._verifier_retries_verify === 0);
      check(
        'records a verification warning',
        typeof result.stateUpdates?._verificationWarning === 'string'
      );
      check('verdict is INCONCLUSIVE', result.output?.verdict === 'INCONCLUSIVE');
    } else {
      console.log(
        '   ⏭  no model available in this env — skipping inconclusive integration assert'
      );
    }
  }

  console.log('\n🧪 acceptance gating (configurable strictness)\n');
  {
    const v = new VerifierNodeExecutor();
    const partial = { verdict: 'PARTIAL', passed: false, conclusive: true };
    // lenient: accept a conclusive PARTIAL immediately
    check(
      'lenient accepts PARTIAL immediately',
      v.resolveAcceptance({
        ...partial,
        stalled: false,
        knobs: { acceptPartial: true, acceptPartialAfterStall: true, requirePass: false }
      }).accept === true
    );
    // balanced: PARTIAL retries until stalled, then accepts
    check(
      'balanced PARTIAL retries before stall',
      v.resolveAcceptance({
        ...partial,
        stalled: false,
        knobs: { acceptPartial: false, acceptPartialAfterStall: true, requirePass: false }
      }).accept === false
    );
    check(
      'balanced PARTIAL accepts on stall',
      v.resolveAcceptance({
        ...partial,
        stalled: true,
        knobs: { acceptPartial: false, acceptPartialAfterStall: true, requirePass: false }
      }).accept === true
    );
    // strict: never accept PARTIAL, even on stall
    check(
      'strict never accepts PARTIAL',
      v.resolveAcceptance({
        ...partial,
        stalled: true,
        knobs: { acceptPartial: false, acceptPartialAfterStall: false, requirePass: true }
      }).accept === false
    );
    // a real PASS always accepts regardless of knobs
    check(
      'PASS always accepts',
      v.resolveAcceptance({
        verdict: 'PASS',
        passed: true,
        conclusive: true,
        stalled: false,
        knobs: { requirePass: true }
      }).accept === true
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
