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

export class VerifierNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new VerifierNodeExecutor
   * @param {Object} options - Executor options
   * @param {WorkflowLLMHelper} [options.llmHelper] - LLM helper instance for API calls
   */
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
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
    const { language = 'en' } = context;

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

      // Check retry count - force pass if max retries reached
      const retryKey = `_verifier_retries_${node.id}`;
      const currentRetries = state.data?.[retryKey] || 0;

      if (currentRetries >= maxRetries) {
        logger.warn({
          component: 'VerifierNodeExecutor',
          message: `Max retries (${maxRetries}) reached for node '${node.id}', forcing pass`,
          nodeId: node.id
        });
        return this.createSuccessResult(
          {
            passed: true,
            feedback: 'Max retries reached, forcing pass',
            score: threshold,
            branch: 'pass'
          },
          {
            stateUpdates: {
              verificationResult: { passed: true, score: threshold, forced: true }
            },
            branch: 'pass'
          }
        );
      }

      // Resolve which model to use for verification
      const { data: models } = configCache.getModels();
      const model =
        models?.find(m => m.id === config.modelId) || models?.find(m => m.default) || models?.[0];

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

      const messages = [
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

      const response = await this.llmHelper.executeStreamingRequest({
        model,
        messages,
        apiKey: apiKeyResult.apiKey,
        options: { temperature: 0.3 },
        language
      });

      // Parse the verification result from LLM response
      let verResult = {
        score: 0,
        passed: false,
        feedback: 'Could not parse verification result'
      };
      try {
        const jsonMatch = (response.content || '').match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          verResult = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        logger.warn({
          component: 'VerifierNodeExecutor',
          message: `Parse error: ${e.message}`
        });
      }

      // Clamp score to [0, 1] range
      const score = Math.max(0, Math.min(1, Number(verResult.score) || 0));
      const passed = score >= threshold;
      const branch = passed ? 'pass' : 'retry';

      return this.createSuccessResult(
        { passed, feedback: verResult.feedback || '', score, branch },
        {
          stateUpdates: {
            verificationResult: { passed, score, feedback: verResult.feedback },
            [retryKey]: passed ? 0 : currentRetries + 1
          },
          branch
        }
      );
    } catch (error) {
      return this.createErrorResult(`Verification failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }
}

export default VerifierNodeExecutor;
