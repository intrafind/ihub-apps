/**
 * VerifierNodeExecutor
 *
 * Executes 'verifier' type nodes in the workflow DAG. A verifier node uses an
 * LLM to evaluate the quality of a previous node's output against configurable
 * criteria and a numeric threshold.
 *
 * The verifier returns a branch value ('pass' or 'retry') that can be used by
 * conditional edges to route the workflow accordingly, enabling quality-gate
 * patterns like verify-then-retry loops.
 *
 * Flow:
 * 1. Resolve the input to verify (from inputVariable or last node result)
 * 2. Check retry count against maxRetries limit
 * 3. Call LLM to evaluate the input against criteria
 * 4. Parse score (0.0-1.0) and compare against threshold
 * 5. Return 'pass' or 'retry' branch for edge routing
 *
 * @module services/workflow/executors/VerifierNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { actionTracker } from '../../../actionTracker.js';

export class VerifierNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new VerifierNodeExecutor
   * @param {Object} options - Executor options
   * @param {WorkflowLLMHelper} [options.llmHelper] - LLM helper instance for API calls
   */
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
    // Lazily-created PromptNodeExecutor used to run the tool-enabled
    // adversarial verifier (so it can actually run checks/searches before
    // its verdict). Dynamic-imported to avoid an executor-index import cycle.
    this._promptExecutor = options.promptExecutor || null;
  }

  /**
   * Get (or lazily create) a PromptNodeExecutor to run the verifier's tool
   * loop. Dynamic import avoids a circular dependency through executors/index.
   * @returns {Promise<Object>}
   * @private
   */
  async getPromptExecutor() {
    if (!this._promptExecutor) {
      const { PromptNodeExecutor } = await import('./PromptNodeExecutor.js');
      this._promptExecutor = new PromptNodeExecutor({ llmHelper: this.llmHelper });
    }
    return this._promptExecutor;
  }

  /**
   * Execute the verifier node: evaluate output quality and return pass/retry branch.
   *
   * @param {Object} node - The verifier node configuration
   * @param {Object} node.config - Node-specific config
   * @param {string} [node.config.criteria] - Quality criteria for evaluation
   * @param {number} [node.config.threshold=0.7] - Minimum score to pass (0.0-1.0)
   * @param {number} [node.config.maxRetries=3] - Maximum retry attempts before forcing pass
   * @param {string} [node.config.inputVariable] - State key of the input to verify
   * @param {string} [node.config.modelId] - Model ID for the verification LLM call
   * @param {Object} state - Current workflow execution state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with passed, score, feedback, and branch
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const threshold = config.threshold ?? 0.7;
    const maxRetries = config.maxRetries ?? 3;
    const mode = config.mode === 'adversarial' ? 'adversarial' : 'quality';
    const { language = 'en' } = context;
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const chatId = context?.chatId || state?.executionId;

    try {
      // Determine what to verify: explicit inputVariable or last node's output
      let inputToVerify;
      if (config.inputVariable) {
        inputToVerify = this.resolveVariable(`$.data.${config.inputVariable}`, state);
      } else {
        // Fall back to the most recent node result
        const nodeResults = state.data?.nodeResults || {};
        const resultKeys = Object.keys(nodeResults);
        if (resultKeys.length > 0) {
          const lastResult = nodeResults[resultKeys[resultKeys.length - 1]];
          inputToVerify = lastResult?.output?.content || lastResult?.output || lastResult;
        }
      }

      // If there is nothing to verify, pass by default
      if (!inputToVerify) {
        return this.createSuccessResult(
          { passed: true, feedback: 'No input to verify', score: 1.0, branch: 'pass' },
          {
            stateUpdates: { verificationResult: { passed: true, score: 1.0 } },
            branch: 'pass'
          }
        );
      }

      // Revision-budget gate. Two ways to stop revising:
      //   1. Hard ceiling: `maxRetries` rounds (backstop against runaway loops).
      //   2. Stall: the verifier found NO FEWER gaps for `STALL_LIMIT` rounds in
      //      a row — the agent isn't making progress, so more rounds just burn
      //      compute. We keep going as long as each round shrinks the gap count
      //      (real progress) and only bail when it plateaus or hits the ceiling.
      const retryKey = `_verifier_retries_${node.id}`;
      const stallKey = `_verifier_stall_${node.id}`;
      const gapCountKey = `_verifier_prevgaps_${node.id}`;
      const currentRetries = state.data?.[retryKey] || 0;
      const currentStall = state.data?.[stallKey] || 0;
      const STALL_LIMIT = config.stallLimit ?? 2;

      if (currentRetries >= maxRetries || currentStall >= STALL_LIMIT) {
        // The deliverable went through every revision round and the verifier
        // still found genuine gaps (only CONCLUSIVE fails count toward this
        // budget — see the branch logic below). Earlier designs either
        // force-PASSED (green checkmark over flawed work) or hard-FAILED
        // (discarded a usable deliverable + showed "Run failed" with no
        // answer). Neither is right. Instead we END the run cleanly with the
        // draft PRESERVED, flagged `_verificationOutcome:'not_passed'` so the
        // UI surfaces "review not passed" with the gaps — and we DON'T mark the
        // inbox item done (it stays open for another attempt / a human).
        const lastFeedback =
          state?.data?.verificationResult?.feedback ||
          (Array.isArray(state?.data?._lastReviewGaps) && state.data._lastReviewGaps.length
            ? state.data._lastReviewGaps.join('; ')
            : '') ||
          'no passing verdict was reached';
        const lastGaps = Array.isArray(state?.data?._lastReviewGaps)
          ? state.data._lastReviewGaps
          : [];
        const stopReason =
          currentStall >= STALL_LIMIT
            ? `no progress for ${currentStall} round(s) (stalled)`
            : `max retries (${maxRetries}) reached`;
        logger.warn({
          component: 'VerifierNodeExecutor',
          message: `Verification not passed for node '${node.id}' — ${stopReason}; ending run with deliverable preserved, flagged not-passed`,
          nodeId: node.id
        });
        return this.createSuccessResult(
          {
            passed: false,
            feedback: lastFeedback,
            score: 0,
            branch: 'end',
            verdict: 'FAIL',
            notPassed: true
          },
          {
            stateUpdates: {
              _verificationOutcome: 'not_passed',
              verificationResult: {
                ...(state?.data?.verificationResult || {}),
                passed: false,
                verdict: 'FAIL',
                feedback: lastFeedback,
                failures: lastGaps,
                mode,
                notPassed: true,
                retriesExhausted: true
              }
            },
            // Short-circuit to a clean stop (no inbox-finalize, no markDone).
            isTerminal: true
          }
        );
      }

      // Resolve which model to use for verification. Inherits the run's
      // workflow-level default (set from the agent profile's preferredModel) so
      // the verifier runs on the SAME model the operator configured for the run
      // — not the global default. A per-node `config.modelId` still overrides.
      const { data: models } = configCache.getModels();
      const model = this.resolveModel(models, config, context, state, node.id);

      if (!model) {
        return this.createErrorResult('No model available for verification', { nodeId: node.id });
      }

      const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
      if (!apiKeyResult.success) {
        throw new Error(apiKeyResult.error?.message || 'API key verification failed');
      }

      const criteria =
        config.criteria || 'Evaluate the quality, completeness, and accuracy of the output.';
      const inputStr =
        typeof inputToVerify === 'object'
          ? JSON.stringify(inputToVerify, null, 2)
          : String(inputToVerify);

      const messages =
        mode === 'adversarial'
          ? this.buildAdversarialMessages(criteria, inputStr)
          : this.buildQualityMessages(criteria, inputStr, threshold);

      // Tool-enabled adversarial verification: when the node lists `tools`, run
      // the verifier through a real tool loop so it can actually execute
      // checks/searches before its verdict — not just judge from reading. This
      // is the Claude Code verification-agent behavior ("did you actually run
      // the check?"). Other modes (and toolless adversarial) use one LLM call.
      const useToolLoop =
        mode === 'adversarial' && Array.isArray(config.tools) && config.tools.length > 0;

      let responseContent = '';
      if (useToolLoop) {
        const promptExecutor = await this.getPromptExecutor();
        const tools = await promptExecutor.getAgentTools(config.tools, language, context);
        const toolResp = await promptExecutor.executeLLMWithTools({
          model,
          messages,
          tools,
          config: {
            maxIterations: config.maxToolRounds || config.maxIterations || 8,
            temperature: 0.3,
            maxTokens: config.maxTokens
          },
          context,
          nodeId: node.id
        });
        responseContent = toolResp.content || '';
      } else {
        const response = await this.llmHelper.executeStreamingRequest({
          model,
          messages,
          apiKey: apiKeyResult.apiKey,
          options: { temperature: 0.3 },
          language
        });
        responseContent = response.content || '';
      }

      // Parse a JSON object out of the response (both modes return JSON).
      let parsed = {};
      try {
        const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch (e) {
        logger.warn({
          component: 'VerifierNodeExecutor',
          message: `Parse error: ${e.message}`
        });
      }

      // Text fallback: weaker / tool-using models often answer in prose
      // ("Verdict: PASS") instead of clean JSON. Recover the verdict from the
      // raw text rather than letting a JSON miss collapse to INCONCLUSIVE.
      if (mode === 'adversarial' && !parsed.verdict) {
        const m =
          responseContent.match(/\bVERDICT\b["'\s:*-]*\s*(PASS|FAIL|PARTIAL)/i) ||
          responseContent.match(/\b(PASS|FAIL|PARTIAL)\b/);
        if (m) parsed.verdict = m[1].toUpperCase();
      }

      const { passed, score, feedback, verdict, failures, conclusive } = this.interpretResult(
        parsed,
        { mode, threshold }
      );

      // Only a CONCLUSIVE non-pass (a real FAIL/PARTIAL with concrete gaps)
      // sends the work back for revision and spends a retry. An INCONCLUSIVE
      // verdict is accepted-with-warning — it carries no actionable feedback,
      // so blocking on it would punish the agent for the verifier's silence.
      const needsRevision = !passed && conclusive;
      const branch = needsRevision ? 'retry' : 'pass';
      const inconclusive = !conclusive;

      const completedAtIso = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const stepLog = {
        nodeId: node.id,
        kind: 'verifier',
        model: model.id,
        startedAt: startedAt.toISOString(),
        completedAt: completedAtIso,
        durationMs,
        verdict,
        conclusive,
        // The raw model output is the audit trail — without it an operator
        // can't tell WHY a verdict came out the way it did (the missing piece
        // when the verifier silently defaulted to FAIL).
        output: typeof responseContent === 'string' ? responseContent.slice(0, 4000) : '',
        messages: [...messages, { role: 'assistant', content: responseContent }]
      };

      // Reconsideration hook: when the verifier conclusively rejects, surface
      // the concrete defects as planner gaps so a plan-and-review loop re-entry
      // closes them (reuses the `_lastReviewGaps` plumbing in PlannerNodeExecutor).
      const stateUpdates = {
        verificationResult: { passed, score, feedback, verdict, failures, mode, conclusive },
        [retryKey]: needsRevision ? currentRetries + 1 : 0,
        _taskTimings: {
          ...(state?.data?._taskTimings || {}),
          [node.id]: { startedAt: startedAt.toISOString(), completedAt: completedAtIso, durationMs }
        }
      };
      // Preserve every verification round's transcript + verdict (the loop
      // re-runs this node per retry; keying only by node id lost rounds 1..n-1).
      Object.assign(
        stateUpdates,
        this.buildStepLogUpdates(state, node.id, stepLog, context?.iteration ?? null)
      );
      if (needsRevision) {
        const gaps = failures.length ? failures : feedback ? [feedback] : [];
        Object.assign(stateUpdates, this.buildReplanUpdates(state, gaps));
        // Progress tracking: compare this round's gap count to the previous one.
        // Strictly fewer gaps = the agent is fixing things → reset the stall
        // counter and keep revising. No improvement → increment stall; once it
        // hits STALL_LIMIT (checked at the top next round) we stop instead of
        // burning the whole retry budget on a plateau.
        const gapCount = gaps.length;
        const prevGapCount = state.data?.[gapCountKey];
        const improved = typeof prevGapCount !== 'number' || gapCount < prevGapCount;
        stateUpdates[gapCountKey] = gapCount;
        stateUpdates[stallKey] = improved ? 0 : currentStall + 1;
      } else {
        // Passing (or accepted-with-warning) clears stale gaps so the agent
        // prompt's "address these gaps" block doesn't re-fire on a clean pass.
        stateUpdates._lastReviewGaps = [];
        stateUpdates[stallKey] = 0;
        if (inconclusive) stateUpdates._verificationWarning = feedback;
      }

      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.step.completed',
          chatId,
          nodeId: node.id,
          kind: 'verifier',
          startedAt: startedAt.toISOString(),
          completedAt: completedAtIso,
          durationMs
        });
      } catch {
        // best effort
      }

      return this.createSuccessResult(
        { passed, feedback, score, branch, verdict, failures, conclusive, inconclusive },
        { stateUpdates, branch }
      );
    } catch (error) {
      return this.createErrorResult(`Verification failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Interpret a parsed verifier response into a normalized result. Pure (no
   * I/O) so it can be unit-tested directly.
   *
   * - adversarial: maps a PASS/FAIL/PARTIAL verdict to passed/score and keeps
   *   the concrete `failures` list (used as planner gaps on rejection).
   * - quality: clamps the numeric score and compares against the threshold.
   *
   * @param {Object} parsed - JSON object parsed from the LLM response
   * @param {Object} opts - { mode, threshold }
   * @returns {{ passed: boolean, score: number, feedback: string, verdict: string, failures: string[] }}
   */
  /**
   * Resolve the verification model with the same precedence the prompt node
   * uses: explicit per-node `config.modelId` → the run's workflow-level
   * `defaultModelId` (published from the agent profile's preferredModel) →
   * the global default → the first available model. Pure, so it's unit-tested
   * directly without configCache. Returns null when no models are available.
   *
   * @param {Array} models
   * @param {Object} config - node config (may carry modelId)
   * @param {Object} context - execution context (carries workflow.config)
   * @returns {Object|null}
   */
  resolveModel(models, config = {}, context = {}, state = null, nodeId = undefined) {
    if (!Array.isArray(models) || models.length === 0) return null;
    const byId = id => (id ? models.find(m => m.id === id) : null);
    return (
      byId(config.modelId) ||
      byId(context?.workflow?.config?.defaultModelId) ||
      // DURABLE per-run agent model config — survives the config-cache TTL
      // refresh that wipes the runtime-applied workflow defaultModelId.
      byId(this.resolveConfiguredModelId(state, nodeId)) ||
      models.find(m => m.default) ||
      models[0] ||
      null
    );
  }

  /**
   * Build the state updates that advance the review round and carry gaps to the
   * planner on a conclusive retry. Pure (no I/O) so it can be unit-tested directly.
   *
   * @param {Object} state - Current workflow state (reads state.data._reviewRound)
   * @param {string[]} gaps - Concrete defects found by the verifier
   * @returns {{ _reviewRound: number, _lastReviewGaps: string[] }}
   */
  buildReplanUpdates(state, gaps) {
    const round = (typeof state?.data?._reviewRound === 'number' ? state.data._reviewRound : 0) + 1;
    return { _reviewRound: round, _lastReviewGaps: Array.isArray(gaps) ? gaps : [] };
  }

  interpretResult(parsed = {}, { mode = 'quality', threshold = 0.7 } = {}) {
    if (mode === 'adversarial') {
      const rawVerdict = String(parsed.verdict || '').toUpperCase();
      const known = ['PASS', 'FAIL', 'PARTIAL'].includes(rawVerdict);
      const failures = Array.isArray(parsed.failures) ? parsed.failures.filter(Boolean) : [];
      const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
      const hasSubstance = failures.length > 0 || rationale.length > 0;
      // INCONCLUSIVE — the verifier did NOT return a usable judgment: either no
      // recognizable verdict, or a FAIL/PARTIAL with zero concrete gaps AND no
      // rationale (common with weaker local models that don't emit clean JSON).
      // This is "I couldn't verify", NOT "the work is bad". Treating it as a
      // substantive rejection burns retries on un-actionable feedback and fails
      // the run for the verifier's own inability to speak. Callers accept an
      // inconclusive verdict WITH a warning instead of blocking the deliverable.
      let verdict;
      if (!known) verdict = 'INCONCLUSIVE';
      else if ((rawVerdict === 'FAIL' || rawVerdict === 'PARTIAL') && !hasSubstance)
        verdict = 'INCONCLUSIVE';
      else verdict = rawVerdict;

      const conclusive = verdict !== 'INCONCLUSIVE';
      const passed = verdict === 'PASS';
      const score =
        verdict === 'PASS' ? 1 : verdict === 'PARTIAL' ? 0.5 : verdict === 'INCONCLUSIVE' ? 0.5 : 0;
      const feedback =
        rationale ||
        (failures.length ? failures.join('; ') : '') ||
        (verdict === 'INCONCLUSIVE'
          ? 'Verifier returned no parseable verdict or concrete gaps; accepted with a warning.'
          : '');
      return { passed, score, feedback, verdict, failures, conclusive };
    }
    const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
    const passed = score >= threshold;
    return {
      passed,
      score,
      feedback: parsed.feedback || '',
      verdict: passed ? 'PASS' : 'FAIL',
      failures: [],
      conclusive: true
    };
  }

  /**
   * Build messages for the soft quality-scorer mode (legacy behavior).
   * @private
   */
  buildQualityMessages(criteria, inputStr, threshold) {
    return [
      {
        role: 'system',
        content:
          `You are a quality verifier. Evaluate the given output against the criteria.\n` +
          `Return JSON: { "score": <0.0-1.0>, "passed": <boolean>, "feedback": "<specific feedback>" }\n` +
          `Score 1.0 = perfect, 0.0 = completely fails criteria. ` +
          `"passed" should be true if score >= ${threshold}.`
      },
      {
        role: 'user',
        content: `Criteria: ${criteria}\n\nOutput to evaluate:\n${inputStr}`
      }
    ];
  }

  /**
   * Build messages for the adversarial verifier mode. Ported in spirit from
   * Claude Code's verification agent: the verifier's job is to TRY TO BREAK the
   * output, name its own rationalizations, and only PASS when it genuinely
   * cannot find a defect. Returns a structured verdict the loop can route on.
   * @private
   */
  buildAdversarialMessages(criteria, inputStr) {
    return [
      {
        role: 'system',
        content:
          `You are an adversarial verifier. Your job is NOT to confirm the work is good — ` +
          `it is to TRY TO BREAK IT. You have two documented failure modes: (1) verification ` +
          `avoidance — finding reasons not to actually check; and (2) being seduced by the ` +
          `polished first 80% while the last 20% (edge cases, missing requirements, wrong ` +
          `claims, broken assumptions) goes unchecked. Your entire value is finding that last 20%.\n\n` +
          `Scrutinize the output against the criteria. Probe edge cases, boundary values, missing ` +
          `requirements, internal contradictions, and unsupported claims. For each defect, state ` +
          `the specific, actionable problem — not vague praise.\n\n` +
          `Recognize your own rationalizations ("looks correct", "probably fine", "good enough") ` +
          `and do the opposite: assume there is a flaw until you have checked.\n\n` +
          `If tools are available to you, USE them to actually run the checks (search for ` +
          `sources, fetch and read referenced material, re-run a computation) rather than ` +
          `reasoning about what the result would be. A claim you verified with a tool beats a ` +
          `claim you assumed. When you are done checking, return your verdict.\n\n` +
          `Return ONLY JSON: { "verdict": "PASS" | "FAIL" | "PARTIAL", ` +
          `"failures": ["specific defect 1", "specific defect 2", ...], ` +
          `"rationale": "<one or two sentences>" }\n` +
          `PASS only if you genuinely found no real defect. PARTIAL if it is mostly right but has ` +
          `gaps that must be closed. FAIL if it does not meet the criteria. When PASS, "failures" ` +
          `must be an empty array.`
      },
      {
        role: 'user',
        content: `Criteria the output must meet:\n${criteria}\n\nOutput to verify:\n${inputStr}`
      }
    ];
  }
}

export default VerifierNodeExecutor;
