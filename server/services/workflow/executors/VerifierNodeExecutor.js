/**
 * Executor for workflow verifier nodes.
 *
 * Verifier nodes use an LLM to evaluate the quality of prior node output
 * against a set of criteria. They produce a branching decision: 'pass' or
 * 'retry', enabling feedback loops for quality assurance in agentic workflows.
 *
 * @module services/workflow/executors/VerifierNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import configCache from '../../../configCache.js';

/**
 * Default score threshold for passing verification
 * @constant {number}
 */
const DEFAULT_THRESHOLD = 0.7;

/**
 * Executor for verifier nodes.
 *
 * Verifier nodes are responsible for:
 * - Retrieving the output to evaluate from workflow state
 * - Constructing an LLM prompt with evaluation criteria
 * - Parsing the LLM's structured evaluation result
 * - Returning a branch value ('pass' or 'retry') for edge routing
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Verifier node configuration
 * {
 *   id: 'quality-verifier',
 *   type: 'verifier',
 *   name: { en: 'Quality Verifier' },
 *   config: {
 *     criteria: 'Output must be comprehensive and cite specific facts.',
 *     threshold: 0.7,
 *     inputVariable: 'plannerOutput',
 *     maxRetries: 3
 *   }
 * }
 */
export class VerifierNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new VerifierNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  /**
   * Execute the verifier node.
   *
   * @param {Object} node - The verifier node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with branch ('pass' or 'retry')
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const { criteria, inputVariable, threshold = DEFAULT_THRESHOLD, maxRetries } = config;

    const language = context.language || 'en';

    this.logger.info({
      component: 'VerifierNodeExecutor',
      message: `Executing verifier node '${node.id}'`,
      nodeId: node.id,
      hasInputVariable: !!inputVariable,
      threshold
    });

    if (!criteria) {
      return this.createErrorResult(`Verifier node '${node.id}' requires 'criteria' in config`, {
        nodeId: node.id
      });
    }

    try {
      // Get the content to evaluate
      const contentToEvaluate = this.resolveInputContent(inputVariable, state, node.id);

      if (!contentToEvaluate) {
        this.logger.warn({
          component: 'VerifierNodeExecutor',
          message: `Verifier node '${node.id}': no content found to evaluate`,
          nodeId: node.id,
          inputVariable
        });
        // No content to evaluate - pass through
        return this.createSuccessResult(
          { passed: true, feedback: 'No content to evaluate', score: 1.0, branch: 'pass' },
          { stateUpdates: { verifierResult: { passed: true, branch: 'pass' } } }
        );
      }

      // Get model
      const model = await this.getModel(config.modelId, context, state);
      if (!model) {
        return this.createErrorResult(
          `Verifier node '${node.id}': model not found: ${config.modelId || 'default'}`,
          { nodeId: node.id }
        );
      }

      // Build evaluation messages
      const messages = this.buildEvaluationMessages(contentToEvaluate, criteria, threshold);

      // Define structured output schema
      const evalSchema = {
        type: 'object',
        properties: {
          passed: {
            type: 'boolean',
            description: 'Whether the output meets the quality criteria'
          },
          feedback: {
            type: 'string',
            description: 'Detailed feedback explaining the evaluation decision'
          },
          score: {
            type: 'number',
            description: `Quality score between 0 and 1 (threshold is ${threshold})`
          }
        },
        required: ['passed', 'feedback', 'score']
      };

      // Verify API key
      const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
      if (!apiKeyResult.success) {
        throw new Error(apiKeyResult.error?.message || 'API key verification failed');
      }

      // Call LLM for evaluation
      const response = await this.llmHelper.executeStreamingRequest({
        model,
        messages,
        apiKey: apiKeyResult.apiKey,
        options: {
          temperature: 0.1,
          maxTokens: 1024,
          responseSchema: evalSchema
        },
        language
      });

      // Parse evaluation result
      const evaluation = this.parseEvaluationResponse(response.content, node.id, threshold);

      // Apply threshold override
      const finalPassed = evaluation.score >= threshold;
      const branch = finalPassed ? 'pass' : 'retry';

      // Check retry count if maxRetries configured
      if (!finalPassed && maxRetries !== undefined) {
        const retryCount = state.data?.[`${node.id}_retryCount`] || 0;
        if (retryCount >= maxRetries) {
          this.logger.warn({
            component: 'VerifierNodeExecutor',
            message: `Verifier node '${node.id}': max retries (${maxRetries}) exceeded, forcing pass`,
            nodeId: node.id,
            retryCount
          });
          const forcedResult = {
            passed: true,
            feedback: evaluation.feedback + ` [Max retries (${maxRetries}) exceeded - forced pass]`,
            score: evaluation.score,
            branch: 'pass'
          };
          return this.createSuccessResult(forcedResult, {
            stateUpdates: {
              verifierResult: forcedResult,
              [`${node.id}_retryCount`]: retryCount + 1
            },
            branch: 'pass'
          });
        }
      }

      const result = {
        passed: finalPassed,
        feedback: evaluation.feedback,
        score: evaluation.score,
        branch
      };

      this.logger.info({
        component: 'VerifierNodeExecutor',
        message: `Verifier node '${node.id}' completed: ${branch}`,
        nodeId: node.id,
        score: evaluation.score,
        threshold,
        branch
      });

      const retryCount = state.data?.[`${node.id}_retryCount`] || 0;

      return this.createSuccessResult(result, {
        stateUpdates: {
          verifierResult: result,
          [`${node.id}_retryCount`]: finalPassed ? 0 : retryCount + 1
        },
        branch
      });
    } catch (error) {
      this.logger.error({
        component: 'VerifierNodeExecutor',
        message: `Verifier node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Verifier execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Resolve the content to evaluate from workflow state.
   *
   * Looks up the inputVariable in state.data, falling back to common
   * output variable names if inputVariable is not specified.
   *
   * @param {string} inputVariable - Variable name to read from state.data
   * @param {Object} state - Workflow state
   * @param {string} nodeId - Node ID for logging
   * @returns {string|null} Content to evaluate as a string, or null
   * @private
   */
  resolveInputContent(inputVariable, state, nodeId) {
    const data = state.data || {};

    let content;

    if (inputVariable) {
      content = data[inputVariable];
    } else {
      // Fall back to common output variable names
      const candidates = ['plannerOutput', 'agentOutput', 'output', 'result', 'content'];
      for (const candidate of candidates) {
        if (data[candidate] !== undefined) {
          content = data[candidate];
          break;
        }
      }

      // Try last node output from nodeResults
      if (content === undefined && data.nodeResults) {
        const nodeIds = Object.keys(data.nodeResults);
        if (nodeIds.length > 0) {
          const lastResult = data.nodeResults[nodeIds[nodeIds.length - 1]];
          content = lastResult?.output?.content || lastResult?.output || lastResult;
        }
      }
    }

    if (content === undefined || content === null) {
      return null;
    }

    // Convert to string for LLM evaluation
    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object') {
      return JSON.stringify(content, null, 2);
    }

    return String(content);
  }

  /**
   * Build the LLM evaluation messages.
   *
   * @param {string} content - Content to evaluate
   * @param {string} criteria - Evaluation criteria
   * @param {number} threshold - Score threshold
   * @returns {Array<Object>} Array of message objects
   * @private
   */
  buildEvaluationMessages(content, criteria, threshold) {
    return [
      {
        role: 'system',
        content: `You are a quality evaluation agent. Your job is to evaluate content against specific criteria and provide a structured assessment.

Evaluation criteria: ${criteria}

Score the content from 0.0 to 1.0 where:
- 0.0: Completely fails the criteria
- 0.5: Partially meets the criteria
- 1.0: Fully meets all criteria

The passing threshold is ${threshold}. Return a JSON object with:
- passed: boolean (true if score >= ${threshold})
- feedback: detailed explanation of what works and what doesn't
- score: numeric score between 0 and 1`
      },
      {
        role: 'user',
        content: `Please evaluate the following content:\n\n${content}`
      }
    ];
  }

  /**
   * Parse the LLM evaluation response.
   *
   * @param {string} content - Raw LLM response
   * @param {string} nodeId - Node ID for error context
   * @param {number} threshold - Score threshold for fallback
   * @returns {Object} Parsed evaluation { passed, feedback, score }
   * @private
   */
  parseEvaluationResponse(content, nodeId, threshold) {
    if (!content) {
      this.logger.warn({
        component: 'VerifierNodeExecutor',
        message: `Empty evaluation response for node '${nodeId}', defaulting to fail`,
        nodeId
      });
      return { passed: false, feedback: 'No evaluation response received', score: 0 };
    }

    try {
      let parsed;

      if (content.trim().startsWith('{')) {
        parsed = JSON.parse(content.trim());
      } else {
        const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
          parsed = JSON.parse(jsonBlockMatch[1].trim());
        } else {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        }
      }

      if (!parsed) {
        throw new Error('No JSON found in response');
      }

      // Normalize score to 0-1 range
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0;
      const passed = typeof parsed.passed === 'boolean' ? parsed.passed : score >= threshold;
      const feedback =
        typeof parsed.feedback === 'string' ? parsed.feedback : String(parsed.feedback || '');

      return { passed, feedback, score };
    } catch (error) {
      this.logger.warn({
        component: 'VerifierNodeExecutor',
        message: `Failed to parse evaluation response for node '${nodeId}': ${error.message}`,
        nodeId,
        content: content.slice(0, 500)
      });
      return { passed: false, feedback: content.slice(0, 500), score: 0 };
    }
  }

  /**
   * Get model configuration. Mirrors AgentNodeExecutor pattern.
   *
   * @param {string} modelId - Model ID from config or null
   * @param {Object} context - Execution context
   * @param {Object} state - Current workflow state
   * @returns {Promise<Object|null>} Model configuration or null
   * @private
   */
  async getModel(modelId, context, state) {
    const { data: models } = configCache.getModels();
    if (!models) {
      return null;
    }

    if (modelId) {
      return models.find(m => m.id === modelId);
    }

    const modelOverride = state?.data?._modelOverride;
    if (modelOverride) {
      const overrideModel = models.find(m => m.id === modelOverride);
      if (overrideModel) return overrideModel;
    }

    const workflowDefaultModelId = context.workflow?.config?.defaultModelId;
    if (workflowDefaultModelId) {
      const workflowModel = models.find(m => m.id === workflowDefaultModelId);
      if (workflowModel) return workflowModel;
    }

    if (context.modelId) {
      return models.find(m => m.id === context.modelId);
    }

    return models.find(m => m.default) || models[0];
  }
}

export default VerifierNodeExecutor;
