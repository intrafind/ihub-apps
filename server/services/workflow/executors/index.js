/**
 * Workflow Node Executors
 *
 * This module exports all node executor classes for the workflow system.
 * Each executor handles a specific type of node in the workflow DAG:
 *
 * - StartNodeExecutor: Entry point that initializes workflow state
 * - EndNodeExecutor: Exit point that collects final output
 * - AgentNodeExecutor: LLM agent with optional tool access
 * - ToolNodeExecutor: Direct tool invocation without LLM
 * - DecisionNodeExecutor: Conditional branching logic
 *
 * The getExecutor() factory function provides a convenient way to get
 * the appropriate executor for a given node type.
 *
 * @module services/workflow/executors
 *
 * @example
 * import { getExecutor, AgentNodeExecutor } from './executors/index.js';
 *
 * // Using factory function
 * const executor = getExecutor('agent');
 * const result = await executor.execute(node, state, context);
 *
 * // Direct instantiation
 * const agentExecutor = new AgentNodeExecutor({ maxIterations: 5 });
 */

export { BaseNodeExecutor } from './BaseNodeExecutor.js';
export { StartNodeExecutor } from './StartNodeExecutor.js';
export { EndNodeExecutor } from './EndNodeExecutor.js';
export { AgentNodeExecutor } from './AgentNodeExecutor.js';
export { ToolNodeExecutor } from './ToolNodeExecutor.js';
export { DecisionNodeExecutor } from './DecisionNodeExecutor.js';
export { HumanNodeExecutor } from './HumanNodeExecutor.js';
export { TransformNodeExecutor } from './TransformNodeExecutor.js';

// Import classes for the factory
import { StartNodeExecutor } from './StartNodeExecutor.js';
import { EndNodeExecutor } from './EndNodeExecutor.js';
import { AgentNodeExecutor } from './AgentNodeExecutor.js';
import { ToolNodeExecutor } from './ToolNodeExecutor.js';
import { DecisionNodeExecutor } from './DecisionNodeExecutor.js';
import { HumanNodeExecutor } from './HumanNodeExecutor.js';
import { TransformNodeExecutor } from './TransformNodeExecutor.js';

/**
 * Registry mapping node types to their executor classes.
 * @type {Object<string, typeof BaseNodeExecutor>}
 */
const executorRegistry = {
  start: StartNodeExecutor,
  end: EndNodeExecutor,
  agent: AgentNodeExecutor,
  tool: ToolNodeExecutor,
  decision: DecisionNodeExecutor,
  human: HumanNodeExecutor,
  transform: TransformNodeExecutor
};

/**
 * Cache for executor instances to avoid repeated instantiation.
 * Executors are stateless, so a single instance can be reused.
 * @type {Map<string, BaseNodeExecutor>}
 */
const executorCache = new Map();

/**
 * Get an executor instance for a given node type.
 *
 * This factory function returns the appropriate executor for the specified
 * node type. Executors are cached for performance since they are stateless.
 *
 * @param {string} nodeType - The type of node ('start', 'end', 'agent', 'tool', 'decision')
 * @param {Object} [options] - Optional configuration for the executor
 * @param {boolean} [options.fresh=false] - If true, create a new instance instead of using cache
 * @returns {BaseNodeExecutor} Executor instance for the node type
 * @throws {Error} If no executor exists for the given node type
 *
 * @example
 * // Get cached executor (default)
 * const executor = getExecutor('agent');
 *
 * @example
 * // Get fresh executor instance with custom options
 * const executor = getExecutor('agent', {
 *   fresh: true,
 *   maxIterations: 20
 * });
 */
export function getExecutor(nodeType, options = {}) {
  const { fresh = false, ...executorOptions } = options;

  const ExecutorClass = executorRegistry[nodeType];

  if (!ExecutorClass) {
    const availableTypes = Object.keys(executorRegistry).join(', ');
    throw new Error(
      `No executor found for node type: '${nodeType}'. ` + `Available types are: ${availableTypes}`
    );
  }

  // Return cached instance if available and not requesting fresh
  if (!fresh && Object.keys(executorOptions).length === 0) {
    if (!executorCache.has(nodeType)) {
      executorCache.set(nodeType, new ExecutorClass());
    }
    return executorCache.get(nodeType);
  }

  // Create new instance with options
  return new ExecutorClass(executorOptions);
}

/**
 * Register a custom executor for a node type.
 *
 * This allows extending the workflow system with custom node types.
 * The executor class must extend BaseNodeExecutor.
 *
 * @param {string} nodeType - The node type identifier
 * @param {typeof BaseNodeExecutor} ExecutorClass - The executor class
 * @throws {Error} If nodeType is invalid or ExecutorClass doesn't extend BaseNodeExecutor
 *
 * @example
 * import { registerExecutor, BaseNodeExecutor } from './executors/index.js';
 *
 * class CustomNodeExecutor extends BaseNodeExecutor {
 *   async execute(node, state, context) {
 *     // Custom execution logic
 *     return { status: 'completed', output: 'Custom result' };
 *   }
 * }
 *
 * registerExecutor('custom', CustomNodeExecutor);
 */
export function registerExecutor(nodeType, ExecutorClass) {
  if (!nodeType || typeof nodeType !== 'string') {
    throw new Error('Node type must be a non-empty string');
  }

  if (typeof ExecutorClass !== 'function') {
    throw new Error('ExecutorClass must be a constructor function');
  }

  // Clear cache if replacing an existing executor
  if (executorCache.has(nodeType)) {
    executorCache.delete(nodeType);
  }

  executorRegistry[nodeType] = ExecutorClass;
}

/**
 * Get list of all registered node types.
 *
 * @returns {Array<string>} Array of registered node type names
 *
 * @example
 * const types = getRegisteredTypes();
 * // ['start', 'end', 'agent', 'tool', 'decision']
 */
export function getRegisteredTypes() {
  return Object.keys(executorRegistry);
}

/**
 * Check if an executor is registered for a node type.
 *
 * @param {string} nodeType - The node type to check
 * @returns {boolean} True if an executor exists for the type
 *
 * @example
 * if (hasExecutor('custom')) {
 *   const executor = getExecutor('custom');
 * }
 */
export function hasExecutor(nodeType) {
  return nodeType in executorRegistry;
}

/**
 * Clear the executor cache.
 *
 * This is primarily useful for testing or when you need to reset
 * executor state completely.
 */
export function clearExecutorCache() {
  executorCache.clear();
}

export default {
  getExecutor,
  registerExecutor,
  getRegisteredTypes,
  hasExecutor,
  clearExecutorCache
};
