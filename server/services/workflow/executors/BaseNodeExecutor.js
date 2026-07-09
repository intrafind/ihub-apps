/**
 * Base class for workflow node executors.
 *
 * Node executors are responsible for executing specific types of nodes in a workflow DAG.
 * Each node type (start, end, agent, tool, decision) has its own executor that extends this base class.
 *
 * The execute() method is the main entry point and must be overridden by subclasses.
 * It receives the node configuration, current workflow state, and execution context,
 * and returns an execution result with status, output, and optional state updates.
 *
 * @module services/workflow/executors/BaseNodeExecutor
 */

import logger from '../../../utils/logger.js';
import promptService from '../../PromptService.js';

/**
 * Execution result returned by node executors
 * @typedef {Object} ExecutionResult
 * @property {'completed'|'failed'|'pending'} status - Execution status
 * @property {*} output - Node output data
 * @property {Object} [stateUpdates] - Key-value pairs to merge into workflow state
 * @property {boolean} [isTerminal] - If true, this node ends the workflow
 * @property {string} [error] - Error message if status is 'failed'
 * @property {string} [branch] - Branch identifier for decision nodes
 */

/**
 * Workflow execution context
 * @typedef {Object} ExecutionContext
 * @property {Object} chatService - Chat service instance for LLM calls
 * @property {Object} user - Current user object
 * @property {string} chatId - Chat/conversation identifier
 * @property {Object} appConfig - Application configuration
 * @property {Object} initialData - Initial input data for the workflow
 * @property {string} language - User language for localization
 */

/**
 * Workflow node configuration
 * @typedef {Object} WorkflowNode
 * @property {string} id - Unique node identifier
 * @property {string} type - Node type (start, end, agent, tool, decision)
 * @property {string} name - Human-readable node name
 * @property {Object} config - Node-specific configuration
 * @property {Array<string>} [next] - IDs of successor nodes
 */

/**
 * Workflow state object
 * @typedef {Object} WorkflowState
 * @property {Object} data - Current workflow data/variables
 * @property {Object} nodeOutputs - Map of node ID to output
 * @property {Array<string>} executedNodes - List of executed node IDs
 * @property {Object} metadata - Workflow metadata
 */

/**
 * Base class for all node executors.
 * Provides common functionality for variable resolution, validation, and error handling.
 */
export class BaseNodeExecutor {
  /**
   * Create a new BaseNodeExecutor
   * @param {Object} options - Executor options
   * @param {Object} [options.logger] - Custom logger instance
   */
  constructor(options = {}) {
    this.options = options;
    this.logger = options.logger || logger;
  }

  /**
   * Execute the node logic. Must be overridden by subclasses.
   *
   * @param {WorkflowNode} node - The node to execute
   * @param {WorkflowState} state - Current workflow state
   * @param {ExecutionContext} context - Execution context
   * @returns {Promise<ExecutionResult>} Execution result
   * @throws {Error} If not implemented by subclass
   *
   * @example
   * // Subclass implementation
   * async execute(node, state, context) {
   *   const result = await this.doSomething(node.config, state);
   *   return {
   *     status: 'completed',
   *     output: result,
   *     stateUpdates: { myVariable: result.value }
   *   };
   * }
   */
  async execute(node, _state, _context) {
    throw new Error(
      `execute() must be implemented by subclass. ` +
        `Node type '${node?.type}' executor is missing implementation.`
    );
  }

  /**
   * Resolve a variable path from workflow state using JSONPath-like syntax.
   *
   * Supports the following path formats:
   * - $.data.someKey - Access state.data.someKey
   * - $.nodeOutputs.nodeId.field - Access output from a specific node
   * - $.metadata.field - Access workflow metadata
   * - Plain string without $ - Returns the string as-is (literal value)
   *
   * @param {string} path - Variable path (e.g., '$.data.userInput')
   * @param {WorkflowState} state - Current workflow state
   * @returns {*} Resolved value or undefined if path not found
   *
   * @example
   * // Access nested data
   * const value = this.resolveVariable('$.data.user.name', state);
   *
   * @example
   * // Access node output
   * const output = this.resolveVariable('$.nodeOutputs.agent1.response', state);
   */
  resolveVariable(path, state) {
    // If not a variable reference, return as-is
    if (typeof path !== 'string' || !path.startsWith('$')) {
      return path;
    }

    // Remove the leading '$.' and split into parts
    const normalizedPath = path.startsWith('$.') ? path.slice(2) : path.slice(1);
    const parts = normalizedPath.split('.');

    // Navigate through the state object
    let current = state;
    for (const part of parts) {
      if (current === null || current === undefined) {
        this.logger.debug('Variable path resolved to undefined', {
          component: 'BaseNodeExecutor',
          path,
          part
        });
        return undefined;
      }

      // Handle array index notation (e.g., items[0])
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        const index = parseInt(indexStr, 10);
        current = current[arrayName];
        if (Array.isArray(current)) {
          current = current[index];
        } else {
          this.logger.debug('Expected array at path but found non-array', {
            component: 'BaseNodeExecutor',
            arrayName,
            foundType: typeof current
          });
          return undefined;
        }
      } else {
        current = current[part];
      }
    }

    return current;
  }

  /**
   * Resolve all variable references in a value recursively.
   * Handles strings, arrays, and objects.
   *
   * @param {*} value - Value that may contain variable references
   * @param {WorkflowState} state - Current workflow state
   * @returns {*} Value with all variables resolved
   *
   * @example
   * // Resolve template string
   * const message = this.resolveVariables('Hello, $.data.userName!', state);
   *
   * @example
   * // Resolve object with variable references
   * const config = this.resolveVariables({
   *   query: '$.data.searchQuery',
   *   limit: 10
   * }, state);
   */
  resolveVariables(value, state) {
    if (typeof value === 'string') {
      // Check if the entire value is a variable reference
      if (value.startsWith('$.')) {
        return this.resolveVariable(value, state);
      }

      // Check for embedded variable references like "Hello, ${$.data.name}!"
      const variablePattern = /\$\{(\$\.[^}]+)\}/g;
      if (variablePattern.test(value)) {
        return value.replace(/\$\{(\$\.[^}]+)\}/g, (match, varPath) => {
          const resolved = this.resolveVariable(varPath, state);
          return resolved !== undefined ? String(resolved) : match;
        });
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveVariables(item, state));
    }

    if (value !== null && typeof value === 'object') {
      const resolved = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.resolveVariables(val, state);
      }
      return resolved;
    }

    return value;
  }

  /**
   * Validate node configuration against required fields.
   *
   * @param {WorkflowNode} node - Node to validate
   * @param {Array<string>} requiredFields - List of required config field names
   * @throws {Error} If required fields are missing
   *
   * @example
   * // Validate tool node has required fields
   * this.validateConfig(node, ['toolId', 'parameters']);
   */
  validateConfig(node, requiredFields = []) {
    if (!node) {
      throw new Error('Node configuration is required');
    }

    if (!node.id) {
      throw new Error('Node must have an id');
    }

    if (!node.type) {
      throw new Error(`Node '${node.id}' must have a type`);
    }

    const config = node.config || {};
    const missingFields = requiredFields.filter(field => {
      const value = config[field];
      return value === undefined || value === null || value === '';
    });

    if (missingFields.length > 0) {
      throw new Error(
        `Node '${node.id}' (type: ${node.type}) is missing required config fields: ` +
          `${missingFields.join(', ')}`
      );
    }
  }

  /**
   * Create a standardized error result.
   *
   * @param {string} message - Error message
   * @param {Object} [details] - Additional error details
   * @returns {ExecutionResult} Failed execution result
   *
   * @example
   * if (!toolId) {
   *   return this.createErrorResult('Tool ID is required');
   * }
   */
  createErrorResult(message, details = {}) {
    this.logger.error(message, { component: this.constructor.name, ...details });

    const result = {
      status: 'failed',
      output: null,
      error: message,
      details
    };

    // Hoist resolvedInputs out of details so the UI/StateManager can find
    // it at a stable, top-level path on both success and error results.
    if (details && details.resolvedInputs && typeof details.resolvedInputs === 'object') {
      result.resolvedInputs = details.resolvedInputs;
    }

    return result;
  }

  /**
   * Create a standardized success result.
   *
   * @param {*} output - Node output data
   * @param {Object} [options] - Additional result options
   * @param {Object} [options.stateUpdates] - State updates to apply
   * @param {boolean} [options.isTerminal] - Whether this ends the workflow
   * @param {string} [options.branch] - Branch identifier for decision nodes
   * @returns {ExecutionResult} Completed execution result
   *
   * @example
   * return this.createSuccessResult(response, {
   *   stateUpdates: { agentOutput: response },
   *   branch: 'success'
   * });
   */
  createSuccessResult(output, options = {}) {
    const result = {
      status: 'completed',
      output
    };

    if (options.stateUpdates) {
      result.stateUpdates = options.stateUpdates;
    }

    if (options.isTerminal) {
      result.isTerminal = true;
    }

    if (options.branch) {
      result.branch = options.branch;
    }

    // Persisted alongside the result so the execution UI can show what
    // parameters/inputs the node was actually run with. Optional — only
    // executors that explicitly populate this surface it.
    if (options.resolvedInputs && typeof options.resolvedInputs === 'object') {
      result.resolvedInputs = options.resolvedInputs;
    }

    return result;
  }

  /**
   * Resolve the model id configured for this run from DURABLE run state.
   *
   * Agent runs publish their model config into `state.data._agentModelConfig`
   * (`{ defaultModelId, nodeModels }`) at start. This lives in run state, so —
   * unlike `workflow.config.defaultModelId` / per-node `config.modelId`, which
   * are applied at runtime by mutating the shared cached workflow object — it
   * SURVIVES the config cache's periodic TTL refresh (which reloads
   * config/workflows.json from disk and discards runtime mutations). Resolvers
   * use this as the fallback so a node always lands on the agent's configured
   * model instead of silently dropping to the global default (e.g. local-vllm).
   *
   * Precedence: the node's own override (`nodeModels[nodeId]`) wins, else the
   * run-wide default (`defaultModelId` = profile.preferredModel).
   *
   * @param {Object} state - Execution state (reads `state.data._agentModelConfig`)
   * @param {string} [nodeId] - Node id, for a per-node override lookup
   * @returns {string|null} The configured model id, or null if none is set
   */
  resolveConfiguredModelId(state, nodeId) {
    const cfg = state?.data?._agentModelConfig;
    if (!cfg) return null;
    if (nodeId && cfg.nodeModels && cfg.nodeModels[nodeId]) return cfg.nodeModels[nodeId];
    return cfg.defaultModelId || null;
  }

  /**
   * Resolve which model an LLM node should run on, using the SAME precedence as
   * `prompt` nodes (`PromptNodeExecutor`). This is the shared default for every
   * executor that calls an LLM; it is what makes `query-plan`, `quote-validator`
   * and `prompt` nodes agree on model selection instead of each rolling its own
   * (which previously left `query-plan`/`quote-validator` ignoring both the
   * chat-selected model and the workflow-level default).
   *
   * Precedence (first match wins):
   *   1. Node-level model — explicit `config.modelId`, else the DURABLE per-node
   *      agent model (`_agentModelConfig.nodeModels[nodeId]`). A non-empty
   *      `config.modelId` short-circuits before the durable lookup, matching the
   *      prompt node exactly.
   *   2. `_modelOverride` — the chat/app-selected model, injected into initial
   *      data by `workflowRunner`. This is why the app's model overrides the
   *      workflow's `defaultModelId` on chat-triggered runs.
   *   3. Workflow-level `config.defaultModelId`, else the durable RUN-WIDE agent
   *      default (`_agentModelConfig.defaultModelId`).
   *   4. Execution-context model (`context.modelId`).
   *   5. Global default (`models.find(m => m.default)`), else the first model.
   *
   * Pure w.r.t. config I/O — `models` is passed in, so this is unit-testable
   * without mocking `configCache`. Returns null only when no models exist.
   *
   * NOTE: `VerifierNodeExecutor` intentionally overrides this with a different
   * order (workflow default ahead of the durable per-node override); do not
   * assume every node shares this exact precedence.
   *
   * @param {Array<Object>} models - Enabled model list (from configCache.getModels())
   * @param {Object} [config] - Node config (may carry `modelId`)
   * @param {Object} [context] - Execution context (carries `workflow.config`, `modelId`)
   * @param {Object} [state] - Workflow state (reads `_modelOverride`, `_agentModelConfig`)
   * @param {string} [nodeId] - Node id, for the per-node durable override lookup
   * @returns {Object|null} Resolved model object, or null if no models are available
   */
  resolveModel(models, config = {}, context = {}, state = null, nodeId = undefined) {
    if (!Array.isArray(models) || models.length === 0) return null;
    const byId = id => (id ? models.find(m => m.id === id) : undefined);

    // 1. Node-level model: explicit config.modelId, else the durable per-node
    //    agent model. `config.modelId || …` matches the prompt node — a set-but-
    //    invalid config.modelId falls through to _modelOverride, NOT to durable.
    const nodeModel = byId(config?.modelId || this.resolveConfiguredModelId(state, nodeId));
    if (nodeModel) return nodeModel;

    // 2. Chat/app-selected model, injected as _modelOverride by workflowRunner.
    const overrideModel = byId(state?.data?._modelOverride);
    if (overrideModel) return overrideModel;

    // 3. Workflow-level default, else the durable run-wide agent default.
    const workflowModel = byId(
      context?.workflow?.config?.defaultModelId || this.resolveConfiguredModelId(state)
    );
    if (workflowModel) return workflowModel;

    // 4. Execution-context model.
    const contextModel = byId(context?.modelId);
    if (contextModel) return contextModel;

    // 5. Global default.
    return models.find(m => m.default) || models[0] || null;
  }

  /**
   * Build the state updates that record a node's step transcript for auditing,
   * preserving EVERY iteration instead of overwriting.
   *
   * `_stepLogs[logKey]` keeps the latest transcript (back-compat with existing
   * UI), while `_stepLogHistory[logKey]` accumulates one entry per execution.
   * In a cyclic workflow (the agent → verify → retry loop) the same node id
   * runs many times; keying only by node id silently discarded rounds 1..n-1,
   * which defeated the whole point of an auditable run. Each history entry is
   * stamped with its `iteration` so the UI can label "Round k".
   *
   * @param {Object} state - current execution state (reads prior logs/history)
   * @param {string} logKey - usually the node id (or per-task key in drain mode)
   * @param {Object} stepLog - the transcript for this execution
   * @param {number|null} [iteration] - this node's iteration index
   * @returns {{_stepLogs: Object, _stepLogHistory: Object}} merge into stateUpdates
   */
  buildStepLogUpdates(state, logKey, stepLog, iteration = null) {
    const prevLogs = state?.data?._stepLogs || {};
    const prevHistory = state?.data?._stepLogHistory || {};
    const prior = Array.isArray(prevHistory[logKey]) ? prevHistory[logKey] : [];
    // History entries are LIGHT summaries — never the full transcript. The
    // full `messages` array and full `output` would multiply state size by the
    // number of cyclic rounds and bloat every on-disk checkpoint (a known
    // past failure mode). Keep exactly one full transcript (the latest) under
    // `_stepLogs[logKey]`; the per-round history holds only audit metadata.
    // Hard-cap the history length as a runaway-loop backstop.
    const HISTORY_CAP = 25;
    const summary = { ...this._summarizeStepLogForHistory(stepLog), iteration };
    return {
      _stepLogs: { ...prevLogs, [logKey]: stepLog },
      _stepLogHistory: {
        ...prevHistory,
        [logKey]: [...prior, summary].slice(-HISTORY_CAP)
      }
    };
  }

  /**
   * Reduce a full step log to a bounded, audit-only summary for the per-round
   * history. Drops the heavy fields: the `messages` transcript entirely, the
   * full tool-call arg/result previews (keeps just names), and the full
   * `output` (keeps a short excerpt). Everything kept here is small and
   * bounded so N rounds stay cheap to persist.
   * @param {Object} stepLog
   * @returns {Object}
   */
  _summarizeStepLogForHistory(stepLog) {
    if (!stepLog || typeof stepLog !== 'object') return {};
    const toolCalls = Array.isArray(stepLog.toolCalls) ? stepLog.toolCalls : [];
    return {
      nodeId: stepLog.nodeId,
      kind: stepLog.kind,
      model: stepLog.model,
      startedAt: stepLog.startedAt,
      completedAt: stepLog.completedAt,
      durationMs: stepLog.durationMs,
      // Per-round token usage — small { input, output } object, kept so the
      // token-usage card can sum EVERY round of a cyclic node instead of only
      // the latest (`_stepLogs[logKey]` is overwritten each round).
      tokens: stepLog.tokens,
      verdict: stepLog.verdict,
      conclusive: stepLog.conclusive,
      toolNames: toolCalls.map(c => c?.name).filter(Boolean),
      toolCount: toolCalls.length,
      responseLength:
        typeof stepLog.responseLength === 'number'
          ? stepLog.responseLength
          : typeof stepLog.output === 'string'
            ? stepLog.output.length
            : undefined,
      citationsAdded: stepLog.citationsAdded,
      planSnapshot: stepLog.planSnapshot,
      // Verifier defects, bounded for the per-round history so the
      // adversarial-review panel can render a readable failure list per round
      // (instead of a truncated raw-JSON blob) without bloating state: cap the
      // count and clip each item. Omitted entirely when there are no failures.
      failures: Array.isArray(stepLog.failures)
        ? stepLog.failures
            .filter(f => typeof f === 'string')
            .slice(0, 12)
            .map(f => (f.length > 600 ? `${f.slice(0, 600)}…` : f))
        : undefined,
      outputExcerpt: typeof stepLog.output === 'string' ? stepLog.output.slice(0, 500) : undefined
    };
  }

  /**
   * Resolve the platform's global prompt variables (date, time, timezone,
   * platform_context, user_name, …) for the current run.
   *
   * Workflow node prompts historically BYPASSED this — unlike the chat path —
   * leaving the planner, task workers, synthesizer, and verifier with no notion
   * of "today". That let agents emit training-era dates which a tool-using
   * verifier then flagged as "future"/unverifiable, burning entire retry loops
   * (run wf-exec-4d5952a6). Resolving the same vars the chat path uses gives
   * every workflow node a reliable temporal anchor.
   *
   * @param {ExecutionContext} context - execution context (reads user + language)
   * @returns {Object} resolved global prompt variables (empty object on failure)
   */
  resolveGlobalPromptVars(context) {
    try {
      return (
        promptService.resolveGlobalPromptVariables(
          context?.user || null,
          null,
          context?.language || null,
          null
        ) || {}
      );
    } catch (err) {
      this.logger.warn('Failed to resolve global prompt variables', {
        component: this.constructor.name,
        error: err.message
      });
      return {};
    }
  }

  /**
   * Substitute `{{key}}` placeholders for every resolved global variable in a
   * string, giving workflow node prompts the same `{{date}}`/`{{timezone}}`/…
   * substitution the chat path has. Empty/undefined vars are skipped so a
   * missing value never blanks out a literal placeholder.
   *
   * @param {string} text - template text
   * @param {Object} vars - resolved global vars (from resolveGlobalPromptVars)
   * @returns {string} text with global placeholders replaced
   */
  applyGlobalPromptVars(text, vars) {
    if (typeof text !== 'string' || !vars) return text;
    let out = text;
    for (const [key, value] of Object.entries(vars)) {
      if (value === null || value === undefined || value === '') continue;
      out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return out;
  }

  /**
   * Build a ready-to-inject system-prompt preamble carrying the current date /
   * timezone so every workflow node is temporally grounded. Prefers the
   * admin-configured `platform_context` block (already resolved with the live
   * date); falls back to a deterministic one-liner if that block was cleared.
   * Returns '' when nothing resolves (e.g. PromptService unavailable).
   *
   * @param {ExecutionContext} context - execution context
   * @returns {string} preamble text, or '' if unavailable
   */
  buildTemporalContextBlock(context) {
    const vars = this.resolveGlobalPromptVars(context);
    const platformContext =
      typeof vars.platform_context === 'string' ? vars.platform_context.trim() : '';
    if (platformContext) return platformContext;
    if (vars.date) {
      const tz = vars.timezone ? ` (timezone ${vars.timezone})` : '';
      return (
        `Current date: ${vars.date}${tz}. Treat any date after this as the future; ` +
        `do not assume your training-time knowledge of "today" or the "latest" is current.`
      );
    }
    return '';
  }

  /**
   * Get the executor type name for logging purposes.
   * @returns {string} Executor type name
   */
  getTypeName() {
    return this.constructor.name.replace('NodeExecutor', '').toLowerCase() || 'base';
  }
}

export default BaseNodeExecutor;
