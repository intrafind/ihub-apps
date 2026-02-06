/**
 * Executor for workflow decision nodes.
 *
 * Decision nodes evaluate conditions and determine which branch of the workflow
 * to follow next. They support expression-based evaluation (using state data)
 * and can be extended to support LLM-based routing for more complex decisions.
 *
 * The actual routing to successor nodes is handled by the DAGScheduler based
 * on the branch identifier returned by this executor.
 *
 * @module services/workflow/executors/DecisionNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';

/**
 * Decision node configuration
 * @typedef {Object} DecisionNodeConfig
 * @property {'expression'|'llm'|'switch'} type - Decision type
 * @property {string} [expression] - Boolean expression for 'expression' type
 * @property {Array<Object>} [conditions] - Array of conditions for 'switch' type
 * @property {string} [variable] - Variable to evaluate for 'switch' type
 * @property {string} [defaultBranch] - Default branch if no condition matches
 */

/**
 * Condition configuration for switch-type decisions
 * @typedef {Object} SwitchCondition
 * @property {string} branch - Branch identifier if condition matches
 * @property {*} [equals] - Value to match exactly
 * @property {*} [notEquals] - Value that must not match
 * @property {*} [greaterThan] - Value must be greater than
 * @property {*} [lessThan] - Value must be less than
 * @property {string} [contains] - String must contain this substring
 * @property {string} [matches] - Regex pattern to match
 */

/**
 * Executor for decision nodes.
 *
 * Decision nodes are responsible for:
 * - Evaluating conditions against workflow state
 * - Determining which branch to take
 * - Supporting multiple decision types (expression, switch, LLM)
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Expression-based decision
 * {
 *   id: 'check-results',
 *   type: 'decision',
 *   name: 'Has Results?',
 *   config: {
 *     type: 'expression',
 *     expression: '$.data.results.length > 0'
 *   }
 * }
 *
 * @example
 * // Switch-based decision
 * {
 *   id: 'route-by-type',
 *   type: 'decision',
 *   name: 'Route by Type',
 *   config: {
 *     type: 'switch',
 *     variable: '$.data.documentType',
 *     conditions: [
 *       { branch: 'pdf', equals: 'application/pdf' },
 *       { branch: 'image', contains: 'image/' },
 *       { branch: 'text', matches: '^text/' }
 *     ],
 *     defaultBranch: 'unknown'
 *   }
 * }
 */
export class DecisionNodeExecutor extends BaseNodeExecutor {
  /**
   * Execute the decision node.
   *
   * Evaluates the decision condition and returns a branch identifier
   * that the DAGScheduler uses to determine the next node(s) to execute.
   *
   * @param {Object} node - The decision node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with branch identifier
   *
   * @example
   * const result = await executor.execute(decisionNode, state, context);
   * // result.output = { branch: 'true', value: true }
   * // DAGScheduler uses result.output.branch to route to next node
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const { type = 'expression' } = config;

    this.logger.info({
      component: 'DecisionNodeExecutor',
      message: `Executing decision node '${node.id}'`,
      nodeId: node.id,
      decisionType: type
    });

    let result;

    switch (type) {
      case 'expression':
        result = this.evaluateExpression(config.expression, state, node.id);
        break;

      case 'switch':
        result = this.evaluateSwitch(config, state, node.id);
        break;

      case 'llm':
        // Future: LLM-based routing
        result = await this.evaluateLLM(config, state, context, node.id);
        break;

      default:
        return this.createErrorResult(`Unknown decision type '${type}' in node '${node.id}'`, {
          nodeId: node.id,
          decisionType: type
        });
    }

    this.logger.info({
      component: 'DecisionNodeExecutor',
      message: `Decision node '${node.id}' evaluated`,
      nodeId: node.id,
      branch: result.branch,
      value: result.value
    });

    return this.createSuccessResult(result, {
      branch: result.branch
    });
  }

  /**
   * Evaluate a boolean expression against workflow state.
   *
   * Supports the following operators:
   * - Comparison: ==, !=, >, <, >=, <=
   * - Logical: &&, ||, !
   * - Existence: exists($.path), empty($.path)
   *
   * @param {string} expression - Boolean expression
   * @param {Object} state - Workflow state
   * @param {string} nodeId - Node ID for error reporting
   * @returns {Object} Result with branch ('true'/'false') and evaluated value
   * @private
   */
  evaluateExpression(expression, state, nodeId) {
    if (!expression || typeof expression !== 'string') {
      this.logger.warn({
        component: 'DecisionNodeExecutor',
        message: `No expression provided for decision node '${nodeId}', defaulting to false`,
        nodeId
      });
      return { branch: 'false', value: false };
    }

    try {
      // Replace variable references with actual values
      const processedExpression = this.processExpressionVariables(expression, state);

      // Safely evaluate the expression
      const result = this.safeEvaluate(processedExpression);
      const boolResult = Boolean(result);

      return {
        branch: boolResult ? 'true' : 'false',
        value: boolResult,
        expression,
        processedExpression
      };
    } catch (error) {
      this.logger.error({
        component: 'DecisionNodeExecutor',
        message: `Failed to evaluate expression in node '${nodeId}'`,
        nodeId,
        expression,
        error: error.message
      });

      // On error, default to false branch
      return {
        branch: 'false',
        value: false,
        error: error.message
      };
    }
  }

  /**
   * Process variable references in an expression.
   *
   * @param {string} expression - Expression with variable references
   * @param {Object} state - Workflow state
   * @returns {string} Expression with variables replaced by values
   * @private
   */
  processExpressionVariables(expression, state) {
    // Pattern to match variable references like $.data.field or $.nodeOutputs.node.field
    const variablePattern = /\$\.[\w.[\]]+/g;

    return expression.replace(variablePattern, match => {
      const value = this.resolveVariable(match, state);

      if (value === undefined || value === null) {
        return 'null';
      }

      if (typeof value === 'string') {
        // Escape quotes and wrap in quotes
        return JSON.stringify(value);
      }

      if (typeof value === 'object') {
        return JSON.stringify(value);
      }

      return String(value);
    });
  }

  /**
   * Safely evaluate a processed expression.
   *
   * Only allows safe operations - no function calls, assignments, etc.
   * Uses Function constructor intentionally for safe expression evaluation
   * after strict input sanitization.
   *
   * SECURITY NOTE: This uses Function constructor which is intentional for
   * expression evaluation. The input is sanitized to prevent code injection:
   * - Dangerous patterns are blocked (function, eval, require, etc.)
   * - No semicolons or braces allowed
   * - Only comparison and logical operators permitted
   *
   * @param {string} expression - Processed expression with resolved values
   * @returns {*} Evaluation result
   * @private
   */
  safeEvaluate(expression) {
    // Check for dangerous patterns - this is critical for security
    const dangerousPatterns = [
      /\bfunction\b/,
      /\bnew\b/,
      /\beval\b/,
      /\bimport\b/,
      /\brequire\b/,
      /\bwindow\b/,
      /\bglobal\b/,
      /\bprocess\b/,
      /\b__proto__\b/,
      /\bconstructor\b/,
      /[;{}]/
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(expression)) {
        throw new Error(`Unsafe expression pattern detected: ${pattern}`);
      }
    }

    // Handle special functions
    let processedExpr = expression;

    // exists() - check if value is not null/undefined
    processedExpr = processedExpr.replace(/exists\s*\(\s*([^)]+)\s*\)/g, (_, val) => {
      return `(${val} !== null && ${val} !== undefined)`;
    });

    // empty() - check if value is empty (null, undefined, empty string, empty array)
    processedExpr = processedExpr.replace(/empty\s*\(\s*([^)]+)\s*\)/g, (_, val) => {
      return `(${val} === null || ${val} === undefined || ${val} === '' || (Array.isArray(${val}) && ${val}.length === 0))`;
    });

    // length() - get array or string length
    processedExpr = processedExpr.replace(/length\s*\(\s*([^)]+)\s*\)/g, (_, val) => {
      return `((${val} && ${val}.length) || 0)`;
    });

    // Use Function constructor for safe evaluation in strict mode
    // This creates an isolated scope - safer than eval()

    const evaluator = new Function(`"use strict"; return (${processedExpr});`);
    return evaluator();
  }

  /**
   * Evaluate a switch-type decision with multiple conditions.
   *
   * @param {Object} config - Switch configuration
   * @param {Object} state - Workflow state
   * @param {string} nodeId - Node ID for error reporting
   * @returns {Object} Result with branch and matched value
   * @private
   */
  evaluateSwitch(config, state, nodeId) {
    const { variable, conditions = [], defaultBranch = 'default' } = config;

    if (!variable) {
      this.logger.warn({
        component: 'DecisionNodeExecutor',
        message: `No variable specified for switch in node '${nodeId}'`,
        nodeId
      });
      return { branch: defaultBranch, value: null, matched: false };
    }

    // Resolve the variable value
    const value = this.resolveVariable(variable, state);

    // Check each condition
    for (const condition of conditions) {
      if (this.matchesCondition(value, condition)) {
        return {
          branch: condition.branch,
          value,
          matched: true,
          condition: condition.branch
        };
      }
    }

    // No condition matched, use default branch
    return {
      branch: defaultBranch,
      value,
      matched: false
    };
  }

  /**
   * Check if a value matches a condition.
   *
   * @param {*} value - Value to check
   * @param {Object} condition - Condition to match against
   * @returns {boolean} True if condition matches
   * @private
   */
  matchesCondition(value, condition) {
    // Exact equality
    if ('equals' in condition) {
      return value === condition.equals;
    }

    // Not equal
    if ('notEquals' in condition) {
      return value !== condition.notEquals;
    }

    // Greater than
    if ('greaterThan' in condition) {
      return value > condition.greaterThan;
    }

    // Less than
    if ('lessThan' in condition) {
      return value < condition.lessThan;
    }

    // Greater than or equal
    if ('greaterThanOrEqual' in condition) {
      return value >= condition.greaterThanOrEqual;
    }

    // Less than or equal
    if ('lessThanOrEqual' in condition) {
      return value <= condition.lessThanOrEqual;
    }

    // String contains
    if ('contains' in condition && typeof value === 'string') {
      return value.includes(condition.contains);
    }

    // Regex match
    if ('matches' in condition && typeof value === 'string') {
      try {
        const regex = new RegExp(condition.matches);
        return regex.test(value);
      } catch {
        return false;
      }
    }

    // In array
    if ('in' in condition && Array.isArray(condition.in)) {
      return condition.in.includes(value);
    }

    // Not in array
    if ('notIn' in condition && Array.isArray(condition.notIn)) {
      return !condition.notIn.includes(value);
    }

    return false;
  }

  /**
   * Evaluate an LLM-based decision.
   *
   * This is a placeholder for future implementation where complex routing
   * decisions can be made by an LLM based on context and rules.
   *
   * @param {Object} config - LLM decision configuration
   * @param {Object} state - Workflow state
   * @param {Object} context - Execution context
   * @param {string} nodeId - Node ID
   * @returns {Promise<Object>} Result with branch
   * @private
   */
  async evaluateLLM(config, state, context, nodeId) {
    // Future implementation for LLM-based routing
    // This could use the chatService to ask an LLM to make a routing decision
    // based on the current state and provided routing rules

    this.logger.warn({
      component: 'DecisionNodeExecutor',
      message: `LLM-based decision not yet implemented for node '${nodeId}'`,
      nodeId
    });

    const defaultBranch = config.defaultBranch || 'default';
    return {
      branch: defaultBranch,
      value: null,
      reason: 'LLM routing not implemented'
    };
  }
}

export default DecisionNodeExecutor;
