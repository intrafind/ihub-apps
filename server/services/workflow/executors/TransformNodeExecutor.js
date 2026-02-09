/**
 * Executor for workflow transform nodes.
 *
 * Transform nodes perform direct state manipulation WITHOUT calling an LLM.
 * They are ideal for:
 * - Initializing state variables
 * - Copying values between variables
 * - Incrementing counters
 * - Pushing items to arrays
 * - Any operation that doesn't require AI reasoning
 *
 * Using transform nodes instead of agent nodes for simple operations
 * saves API calls and speeds up workflow execution.
 *
 * @module services/workflow/executors/TransformNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { deepMerge } from '../../../utils/deepMerge.js';

/**
 * Transform node configuration
 * @typedef {Object} TransformNodeConfig
 * @property {Array<TransformOperation>} operations - List of operations to perform
 */

/**
 * Transform operation types
 * @typedef {Object} TransformOperation
 * @property {string} [set] - Variable name to set (with 'value' property)
 * @property {*} [value] - Value to set (for 'set' operation)
 * @property {string} [copy] - Variable path to copy from (with 'to' property)
 * @property {string} [to] - Variable path to copy to
 * @property {string} [increment] - Variable path to increment (with 'by' property)
 * @property {number} [by] - Amount to increment by (default: 1)
 * @property {string} [push] - Variable path containing item to push (with 'to' property)
 * @property {string} [arrayGet] - Array path to get item from (with 'index' and 'to')
 * @property {number|string} [index] - Index for arrayGet (number or variable path)
 * @property {string} [lengthOf] - Array path to get length of (with 'to')
 * @property {string} [condition] - Condition expression for conditional set (with 'then'/'else')
 * @property {*} [then] - Value if condition is true
 * @property {*} [else] - Value if condition is false
 */

/**
 * Executor for transform nodes.
 *
 * Transform nodes are responsible for:
 * - Direct state manipulation without LLM calls
 * - Initializing variables with literal values
 * - Copying values between variables
 * - Incrementing numeric counters
 * - Pushing items to arrays
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Transform node configuration
 * {
 *   id: 'init-state',
 *   type: 'transform',
 *   name: 'Initialize State',
 *   config: {
 *     operations: [
 *       { set: 'findings', value: [] },
 *       { set: 'researchState', value: { iteration: 0, currentFocus: '', isComplete: false } }
 *     ]
 *   }
 * }
 *
 * @example
 * // Copy and increment operations
 * {
 *   id: 'update-state',
 *   type: 'transform',
 *   config: {
 *     operations: [
 *       { copy: 'thinking.nextFocus', to: 'researchState.currentFocus' },
 *       { increment: 'researchState.iteration', by: 1 },
 *       { push: 'currentResearch', to: 'findings' }
 *     ]
 *   }
 * }
 */
export class TransformNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new TransformNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the transform node.
   *
   * Processes all operations in sequence and returns state updates.
   *
   * @param {Object} node - The transform node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with state updates
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const operations = config.operations || [];

    this.logger.info({
      component: 'TransformNodeExecutor',
      message: `Executing transform node '${node.id}'`,
      nodeId: node.id,
      operationCount: operations.length
    });

    try {
      const stateUpdates = {};

      for (const operation of operations) {
        this.processOperation(operation, state, stateUpdates, context);
      }

      this.logger.info({
        component: 'TransformNodeExecutor',
        message: `Transform node '${node.id}' completed`,
        nodeId: node.id,
        updatedVariables: Object.keys(stateUpdates)
      });

      return this.createSuccessResult(
        { transformedVariables: Object.keys(stateUpdates) },
        { stateUpdates }
      );
    } catch (error) {
      this.logger.error({
        component: 'TransformNodeExecutor',
        message: `Transform node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`Transform execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Process a single transform operation.
   *
   * @param {TransformOperation} operation - The operation to process
   * @param {Object} state - Current workflow state
   * @param {Object} stateUpdates - Object to accumulate state updates
   * @param {Object} context - Execution context
   * @private
   */
  processOperation(operation, state, stateUpdates, _context) {
    // SET operation: set a variable to a literal value
    if ('set' in operation) {
      const variableName = operation.set;
      let value = operation.value;

      // Deep clone objects/arrays to prevent mutation
      if (typeof value === 'object' && value !== null) {
        value = JSON.parse(JSON.stringify(value));
      }

      // Resolve any template variables in the value if it's a string
      if (typeof value === 'string') {
        value = this.resolveTemplateString(value, state, stateUpdates);
      }

      this.setNestedValue(variableName, value, stateUpdates);

      this.logger.debug({
        component: 'TransformNodeExecutor',
        message: `SET ${variableName}`,
        value: typeof value === 'object' ? '[object]' : value
      });
    }

    // COPY operation: copy value from one variable to another
    if ('copy' in operation && 'to' in operation) {
      const sourcePath = operation.copy;
      const targetPath = operation.to;

      // Get value from current state, deep merged with pending updates
      // Deep merge ensures nested properties aren't lost when reading
      const mergedData = deepMerge(state.data, stateUpdates);
      const value = this.getNestedValue(sourcePath, mergedData);

      if (value !== undefined) {
        // Deep clone to prevent mutation
        const clonedValue =
          typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;

        this.setNestedValue(targetPath, clonedValue, stateUpdates);

        this.logger.debug({
          component: 'TransformNodeExecutor',
          message: `COPY ${sourcePath} -> ${targetPath}`,
          value: typeof clonedValue === 'object' ? '[object]' : clonedValue
        });
      } else {
        this.logger.warn({
          component: 'TransformNodeExecutor',
          message: `COPY source not found: ${sourcePath}`
        });
      }
    }

    // INCREMENT operation: add to a numeric variable
    if ('increment' in operation) {
      const variablePath = operation.increment;
      const incrementBy = operation.by ?? 1;

      // Get current value from state, deep merged with pending updates
      // Deep merge ensures nested properties aren't lost when reading
      const mergedData = deepMerge(state.data, stateUpdates);
      const currentValue = this.getNestedValue(variablePath, mergedData);
      const numericValue = typeof currentValue === 'number' ? currentValue : 0;
      const newValue = numericValue + incrementBy;

      this.setNestedValue(variablePath, newValue, stateUpdates);

      this.logger.debug({
        component: 'TransformNodeExecutor',
        message: `INCREMENT ${variablePath} by ${incrementBy}`,
        oldValue: numericValue,
        newValue
      });
    }

    // PUSH operation: append an item to an array
    if ('push' in operation && 'to' in operation) {
      const itemPath = operation.push;
      const arrayPath = operation.to;

      // Get the item to push (deep merge to preserve nested properties)
      const mergedData = deepMerge(state.data, stateUpdates);
      const item = this.getNestedValue(itemPath, mergedData);

      if (item === undefined) {
        this.logger.warn({
          component: 'TransformNodeExecutor',
          message: `PUSH item not found: ${itemPath}`
        });
        return;
      }

      // Get the target array
      const currentArray = this.getNestedValue(arrayPath, mergedData);
      const array = Array.isArray(currentArray) ? [...currentArray] : [];

      // Clone and push item
      const clonedItem =
        typeof item === 'object' && item !== null ? JSON.parse(JSON.stringify(item)) : item;

      array.push(clonedItem);

      this.setNestedValue(arrayPath, array, stateUpdates);

      this.logger.debug({
        component: 'TransformNodeExecutor',
        message: `PUSH ${itemPath} -> ${arrayPath}`,
        arrayLength: array.length
      });
    }

    // MERGE operation: merge an object into another object
    if ('merge' in operation && 'into' in operation) {
      const sourcePath = operation.merge;
      const targetPath = operation.into;

      // Deep merge to preserve nested properties when reading
      const mergedData = deepMerge(state.data, stateUpdates);
      const sourceObj = this.getNestedValue(sourcePath, mergedData);
      const targetObj = this.getNestedValue(targetPath, mergedData) || {};

      if (typeof sourceObj === 'object' && sourceObj !== null && !Array.isArray(sourceObj)) {
        const merged = { ...targetObj, ...sourceObj };
        this.setNestedValue(targetPath, merged, stateUpdates);

        this.logger.debug({
          component: 'TransformNodeExecutor',
          message: `MERGE ${sourcePath} -> ${targetPath}`,
          mergedKeys: Object.keys(merged)
        });
      } else {
        this.logger.warn({
          component: 'TransformNodeExecutor',
          message: `MERGE source is not an object: ${sourcePath}`
        });
      }
    }

    // ARRAY_GET operation: get an item from an array by index
    if ('arrayGet' in operation && 'index' in operation && 'to' in operation) {
      const arrayPath = operation.arrayGet;
      const targetPath = operation.to;

      const mergedData = deepMerge(state.data, stateUpdates);
      const array = this.getNestedValue(arrayPath, mergedData);

      // Resolve index - can be a number or a variable path
      let index = operation.index;
      if (typeof index === 'string') {
        index = this.getNestedValue(index, mergedData);
      }
      index = parseInt(index, 10);

      if (Array.isArray(array) && !isNaN(index) && index >= 0 && index < array.length) {
        const value = array[index];
        const clonedValue =
          typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;

        this.setNestedValue(targetPath, clonedValue, stateUpdates);

        this.logger.debug({
          component: 'TransformNodeExecutor',
          message: `ARRAY_GET ${arrayPath}[${index}] -> ${targetPath}`,
          value: typeof clonedValue === 'object' ? '[object]' : clonedValue
        });
      } else {
        // Set empty string if out of bounds
        this.setNestedValue(targetPath, '', stateUpdates);
        this.logger.warn({
          component: 'TransformNodeExecutor',
          message: `ARRAY_GET index out of bounds or not an array: ${arrayPath}[${index}]`
        });
      }
    }

    // LENGTH_OF operation: get the length of an array
    if ('lengthOf' in operation && 'to' in operation) {
      const arrayPath = operation.lengthOf;
      const targetPath = operation.to;

      const mergedData = deepMerge(state.data, stateUpdates);
      const array = this.getNestedValue(arrayPath, mergedData);

      const length = Array.isArray(array) ? array.length : 0;
      this.setNestedValue(targetPath, length, stateUpdates);

      this.logger.debug({
        component: 'TransformNodeExecutor',
        message: `LENGTH_OF ${arrayPath} -> ${targetPath}`,
        length
      });
    }

    // CONDITIONAL operation: set value based on condition
    if ('condition' in operation && 'to' in operation) {
      const conditionExpr = operation.condition;
      const targetPath = operation.to;
      const thenValue = operation.then;
      const elseValue = operation.else;

      const mergedData = deepMerge(state.data, stateUpdates);
      const conditionResult = this.evaluateCondition(conditionExpr, mergedData);

      const value = conditionResult ? thenValue : elseValue;

      // Deep clone objects/arrays
      let finalValue = value;
      if (typeof value === 'object' && value !== null) {
        finalValue = JSON.parse(JSON.stringify(value));
      }

      this.setNestedValue(targetPath, finalValue, stateUpdates);

      this.logger.debug({
        component: 'TransformNodeExecutor',
        message: `CONDITIONAL ${conditionExpr} -> ${targetPath}`,
        conditionResult,
        value: typeof finalValue === 'object' ? '[object]' : finalValue
      });
    }
  }

  /**
   * Evaluate a simple condition expression.
   * Supports: >=, <=, >, <, ==, !=, ===, !==
   *
   * @param {string} expression - Condition like "currentIndex >= total"
   * @param {Object} data - Data context for variable resolution
   * @returns {boolean} Result of condition
   * @private
   */
  evaluateCondition(expression, data) {
    // Match patterns like: variable op value
    const match = expression.match(
      /^\s*([a-zA-Z0-9_.]+)\s*(>=|<=|>|<|===|!==|==|!=)\s*([a-zA-Z0-9_.]+)\s*$/
    );

    if (!match) {
      this.logger.warn({
        component: 'TransformNodeExecutor',
        message: `Invalid condition expression: ${expression}`
      });
      return false;
    }

    const [, leftPath, operator, rightPath] = match;

    // Resolve left value
    let leftValue = this.getNestedValue(leftPath, data);
    if (leftValue === undefined) {
      // Try parsing as literal number
      const num = parseFloat(leftPath);
      leftValue = isNaN(num) ? leftPath : num;
    }

    // Resolve right value
    let rightValue = this.getNestedValue(rightPath, data);
    if (rightValue === undefined) {
      // Try parsing as literal number
      const num = parseFloat(rightPath);
      rightValue = isNaN(num) ? rightPath : num;
    }

    // Evaluate based on operator
    switch (operator) {
      case '>=':
        return leftValue >= rightValue;
      case '<=':
        return leftValue <= rightValue;
      case '>':
        return leftValue > rightValue;
      case '<':
        return leftValue < rightValue;
      case '===':
        return leftValue === rightValue;
      case '!==':
        return leftValue !== rightValue;
      case '==':
        return leftValue == rightValue;
      case '!=':
        return leftValue != rightValue;
      default:
        return false;
    }
  }

  /**
   * Resolve template variables in a string.
   * Supports {{variable}} syntax.
   *
   * @param {string} template - Template string
   * @param {Object} state - Workflow state
   * @param {Object} stateUpdates - Pending state updates
   * @returns {string} Resolved string
   * @private
   */
  resolveTemplateString(template, state, stateUpdates) {
    // Deep merge to preserve nested properties when reading
    const mergedData = deepMerge(state.data, stateUpdates);

    return template.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
      const trimmed = variable.trim();
      const value = this.getNestedValue(trimmed, mergedData);
      if (value !== undefined && value !== null) {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      return '';
    });
  }

  /**
   * Get a nested value from an object using dot notation.
   *
   * @param {string} path - Dot-notation path like "user.name" or "items.0.id"
   * @param {Object} obj - Object to search
   * @returns {*} Value at path or undefined
   * @private
   */
  getNestedValue(path, obj) {
    if (!path || typeof path !== 'string') {
      return undefined;
    }

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Set a nested value in an object using dot notation.
   * Creates intermediate objects as needed.
   *
   * @param {string} path - Dot-notation path
   * @param {*} value - Value to set
   * @param {Object} obj - Object to modify
   * @private
   */
  setNestedValue(path, value, obj) {
    if (!path || typeof path !== 'string') {
      return;
    }

    const parts = path.split('.');

    // For single-level path, just set directly
    if (parts.length === 1) {
      obj[path] = value;
      return;
    }

    // For nested paths, we need to create the full nested structure
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null) {
        current[part] = {};
      } else if (typeof current[part] !== 'object') {
        // If intermediate value exists but isn't an object, replace it
        current[part] = {};
      } else {
        // Clone existing object to avoid mutation
        current[part] = { ...current[part] };
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;
  }
}

export default TransformNodeExecutor;
