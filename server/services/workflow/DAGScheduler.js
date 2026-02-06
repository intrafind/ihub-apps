import logger from '../../utils/logger.js';

/**
 * DAGScheduler handles dependency resolution and execution ordering for workflow graphs.
 * It implements algorithms for cycle detection, topological sorting, and determining
 * which nodes are ready for execution based on satisfied dependencies.
 *
 * The scheduler treats workflows as Directed Acyclic Graphs (DAGs) where:
 * - Nodes represent execution units (LLM calls, tool calls, decisions, etc.)
 * - Edges represent data/control flow between nodes with optional conditions
 *
 * @example
 * const scheduler = new DAGScheduler();
 *
 * // Check for cycles before execution
 * const cycleResult = scheduler.detectCycles(nodes, edges);
 * if (cycleResult.hasCycle) {
 *   throw new Error(`Workflow has cycles: ${cycleResult.cycleNodes.join(', ')}`);
 * }
 *
 * // Get execution order
 * const executionOrder = scheduler.topologicalSort(nodes, edges);
 */
export class DAGScheduler {
  /**
   * Detects cycles in the workflow graph using Kahn's algorithm.
   * A cycle indicates an invalid workflow that would result in infinite execution.
   *
   * @param {Object[]} nodes - Array of workflow nodes
   * @param {string} nodes[].id - Unique node identifier
   * @param {Object[]} edges - Array of workflow edges
   * @param {string} edges[].source - Source node ID
   * @param {string} edges[].target - Target node ID
   * @returns {Object} Cycle detection result
   * @returns {boolean} result.hasCycle - Whether a cycle was detected
   * @returns {string[]} result.cycleNodes - Node IDs involved in cycles (empty if no cycle)
   *
   * @example
   * const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
   * const edges = [
   *   { source: 'a', target: 'b' },
   *   { source: 'b', target: 'c' },
   *   { source: 'c', target: 'a' } // Creates a cycle
   * ];
   * const result = scheduler.detectCycles(nodes, edges);
   * // result = { hasCycle: true, cycleNodes: ['a', 'b', 'c'] }
   */
  detectCycles(nodes, edges) {
    if (!nodes || nodes.length === 0) {
      return { hasCycle: false, cycleNodes: [] };
    }

    // Build adjacency list and in-degree count
    const inDegree = new Map();
    const adjacency = new Map();

    // Initialize all nodes
    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    // Build graph from edges
    for (const edge of edges || []) {
      if (adjacency.has(edge.source) && inDegree.has(edge.target)) {
        adjacency.get(edge.source).push(edge.target);
        inDegree.set(edge.target, inDegree.get(edge.target) + 1);
      }
    }

    // Kahn's algorithm: start with nodes that have no incoming edges
    const queue = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    let processedCount = 0;
    const processedNodes = new Set();

    while (queue.length > 0) {
      const nodeId = queue.shift();
      processedNodes.add(nodeId);
      processedCount++;

      // Reduce in-degree of all neighbors
      for (const neighbor of adjacency.get(nodeId) || []) {
        const newDegree = inDegree.get(neighbor) - 1;
        inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If we couldn't process all nodes, there's a cycle
    if (processedCount !== nodes.length) {
      // Find nodes involved in cycles (those not processed)
      const cycleNodes = nodes.map(n => n.id).filter(id => !processedNodes.has(id));

      logger.warn({
        component: 'DAGScheduler',
        message: 'Cycle detected in workflow graph',
        cycleNodes
      });

      return { hasCycle: true, cycleNodes };
    }

    return { hasCycle: false, cycleNodes: [] };
  }

  /**
   * Performs topological sort to determine valid execution order.
   * Returns nodes in an order where all dependencies are satisfied before execution.
   *
   * @param {Object[]} nodes - Array of workflow nodes
   * @param {string} nodes[].id - Unique node identifier
   * @param {Object[]} edges - Array of workflow edges
   * @param {string} edges[].source - Source node ID
   * @param {string} edges[].target - Target node ID
   * @returns {string[]} Ordered array of node IDs for execution
   * @throws {Error} If the graph contains cycles
   *
   * @example
   * const nodes = [{ id: 'start' }, { id: 'process' }, { id: 'end' }];
   * const edges = [
   *   { source: 'start', target: 'process' },
   *   { source: 'process', target: 'end' }
   * ];
   * const order = scheduler.topologicalSort(nodes, edges);
   * // order = ['start', 'process', 'end']
   */
  topologicalSort(nodes, edges) {
    if (!nodes || nodes.length === 0) {
      return [];
    }

    // First check for cycles
    const cycleResult = this.detectCycles(nodes, edges);
    if (cycleResult.hasCycle) {
      throw new Error(
        `Cannot perform topological sort: graph contains cycles involving nodes: ${cycleResult.cycleNodes.join(', ')}`
      );
    }

    // Build adjacency list and in-degree count
    const inDegree = new Map();
    const adjacency = new Map();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of edges || []) {
      if (adjacency.has(edge.source) && inDegree.has(edge.target)) {
        adjacency.get(edge.source).push(edge.target);
        inDegree.set(edge.target, inDegree.get(edge.target) + 1);
      }
    }

    // Start with nodes that have no incoming edges
    const queue = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    const sorted = [];

    while (queue.length > 0) {
      const nodeId = queue.shift();
      sorted.push(nodeId);

      for (const neighbor of adjacency.get(nodeId) || []) {
        const newDegree = inDegree.get(neighbor) - 1;
        inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    logger.debug({
      component: 'DAGScheduler',
      message: 'Topological sort completed',
      nodeCount: sorted.length,
      order: sorted
    });

    return sorted;
  }

  /**
   * Gets nodes that can be executed (all dependencies satisfied).
   * For MVP, this returns the current nodes sequentially.
   * For parallel execution (future), this checks incoming edges are satisfied.
   *
   * @param {Object} workflow - The workflow definition
   * @param {Object[]} workflow.nodes - Array of workflow nodes
   * @param {Object[]} workflow.edges - Array of workflow edges
   * @param {string[]} currentNodes - Currently active node IDs
   * @param {string[]} completedNodes - Already completed node IDs
   * @returns {string[]} Array of node IDs ready for execution
   *
   * @example
   * const workflow = {
   *   nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
   *   edges: [
   *     { source: 'a', target: 'b' },
   *     { source: 'a', target: 'c' }
   *   ]
   * };
   * const executable = scheduler.getExecutableNodes(workflow, ['b', 'c'], ['a']);
   * // With parallel support, returns ['b', 'c'] since 'a' is completed
   */
  getExecutableNodes(workflow, currentNodes, completedNodes) {
    if (!currentNodes || currentNodes.length === 0) {
      return [];
    }

    const completedSet = new Set(completedNodes || []);

    // MVP: Sequential execution - return first current node only
    // This ensures deterministic behavior for initial implementation
    // TODO: Enable parallel execution when parallel: true in workflow config

    // For now, just validate that the first node can execute
    const firstNode = currentNodes[0];

    // Check if all incoming edges to this node have completed sources
    const incomingEdges = (workflow.edges || []).filter(edge => edge.target === firstNode);

    const allDependenciesMet = incomingEdges.every(edge => completedSet.has(edge.source));

    if (allDependenciesMet) {
      logger.debug({
        component: 'DAGScheduler',
        message: 'Node ready for execution',
        nodeId: firstNode,
        completedDependencies: incomingEdges.map(e => e.source)
      });
      return [firstNode];
    }

    // This shouldn't happen in a well-formed workflow, but handle gracefully
    logger.warn({
      component: 'DAGScheduler',
      message: 'Node has unmet dependencies',
      nodeId: firstNode,
      requiredNodes: incomingEdges.map(e => e.source),
      completedNodes: Array.from(completedSet)
    });

    return [];
  }

  /**
   * Determines the next nodes to execute after a node completes.
   * Evaluates edge conditions to determine which paths to follow.
   *
   * @param {string} nodeId - The completed node ID
   * @param {*} result - The result from the completed node
   * @param {Object} workflow - The workflow definition
   * @param {Object[]} workflow.edges - Array of workflow edges
   * @param {Object} state - Current execution state
   * @param {Object} state.data - Workflow data/context
   * @returns {string[]} Array of next node IDs to execute
   *
   * @example
   * const workflow = {
   *   edges: [
   *     { source: 'decision', target: 'path-a', condition: { type: 'expression', value: '$.result == "yes"' } },
   *     { source: 'decision', target: 'path-b', condition: { type: 'expression', value: '$.result == "no"' } }
   *   ]
   * };
   * const nextNodes = scheduler.getNextNodes('decision', { result: 'yes' }, workflow, state);
   * // nextNodes = ['path-a']
   */
  getNextNodes(nodeId, result, workflow, state) {
    const edges = workflow.edges || [];

    // Find all outgoing edges from this node
    const outgoingEdges = edges.filter(edge => edge.source === nodeId);

    if (outgoingEdges.length === 0) {
      logger.debug({
        component: 'DAGScheduler',
        message: 'No outgoing edges from node',
        nodeId
      });
      return [];
    }

    const nextNodes = [];

    for (const edge of outgoingEdges) {
      const shouldFollow = this.evaluateCondition(edge, result, state);

      if (shouldFollow) {
        nextNodes.push(edge.target);
        logger.debug({
          component: 'DAGScheduler',
          message: 'Following edge to next node',
          sourceNode: nodeId,
          targetNode: edge.target,
          conditionType: edge.condition?.type || 'always'
        });
      }
    }

    return nextNodes;
  }

  /**
   * Evaluates whether an edge condition is satisfied.
   * Supports multiple condition types:
   * - 'always': Always follow this edge (default)
   * - 'expression': Evaluate a JSONPath/simple expression
   * - 'llm': (Future) Use LLM to make routing decision
   *
   * @param {Object} edge - The edge to evaluate
   * @param {Object} [edge.condition] - Condition configuration
   * @param {string} [edge.condition.type='always'] - Condition type
   * @param {string} [edge.condition.value] - Condition expression or value
   * @param {*} result - The result from the source node
   * @param {Object} state - Current execution state
   * @param {Object} state.data - Workflow data/context
   * @returns {boolean} Whether the condition is satisfied
   *
   * @example
   * // Always true edge
   * const edge1 = { source: 'a', target: 'b' };
   * scheduler.evaluateCondition(edge1, null, state); // true
   *
   * // Expression-based edge
   * const edge2 = {
   *   source: 'a',
   *   target: 'b',
   *   condition: { type: 'expression', value: 'result.success === true' }
   * };
   * scheduler.evaluateCondition(edge2, { success: true }, state); // true
   */
  evaluateCondition(edge, result, state) {
    const condition = edge.condition;

    // No condition means always follow
    if (!condition) {
      return true;
    }

    const conditionType = condition.type || 'always';

    switch (conditionType) {
      case 'always':
        return true;

      case 'never':
        return false;

      case 'expression':
        return this._evaluateExpression(condition.value, result, state);

      case 'equals':
        return this._evaluateEquals(condition, result, state);

      case 'contains':
        return this._evaluateContains(condition, result, state);

      case 'exists':
        return this._evaluateExists(condition, result, state);

      case 'llm':
        // Future: LLM-based routing decision
        // For now, log warning and treat as 'always'
        logger.warn({
          component: 'DAGScheduler',
          message: 'LLM condition type not yet implemented, treating as always',
          edge: { source: edge.source, target: edge.target }
        });
        return true;

      default:
        logger.warn({
          component: 'DAGScheduler',
          message: 'Unknown condition type, treating as always',
          conditionType,
          edge: { source: edge.source, target: edge.target }
        });
        return true;
    }
  }

  /**
   * Evaluates a simple expression condition
   * @param {string} expression - The expression to evaluate
   * @param {*} result - The node result
   * @param {Object} state - Current execution state
   * @returns {boolean} Evaluation result
   * @private
   */
  _evaluateExpression(expression, result, state) {
    if (!expression) {
      return true;
    }

    try {
      // Create a safe evaluation context with result and state data
      const context = {
        result,
        data: state?.data || {},
        nodeResults: state?.data?.nodeResults || {}
      };

      // Simple expression evaluation (safe subset)
      // Supports: result.field, result.field === value, result.field !== value
      // Supports: data.field, nodeResults.nodeId.field

      // Handle direct property access checks
      if (expression.includes('===') || expression.includes('!==')) {
        return this._evaluateComparison(expression, context);
      }

      // Handle boolean property access (e.g., "result.success")
      const value = this._getValueFromPath(expression, context);
      return Boolean(value);
    } catch (error) {
      logger.warn({
        component: 'DAGScheduler',
        message: 'Expression evaluation failed',
        expression,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Evaluates an equals condition
   * @param {Object} condition - The condition object
   * @param {*} result - The node result
   * @param {Object} state - Current execution state
   * @returns {boolean} Whether values are equal
   * @private
   */
  _evaluateEquals(condition, result, state) {
    const context = {
      result,
      data: state?.data || {},
      nodeResults: state?.data?.nodeResults || {}
    };

    const actualValue = this._getValueFromPath(condition.field, context);
    return actualValue === condition.value;
  }

  /**
   * Evaluates a contains condition (for strings or arrays)
   * @param {Object} condition - The condition object
   * @param {*} result - The node result
   * @param {Object} state - Current execution state
   * @returns {boolean} Whether the container includes the value
   * @private
   */
  _evaluateContains(condition, result, state) {
    const context = {
      result,
      data: state?.data || {},
      nodeResults: state?.data?.nodeResults || {}
    };

    const container = this._getValueFromPath(condition.field, context);

    if (typeof container === 'string') {
      return container.includes(condition.value);
    }

    if (Array.isArray(container)) {
      return container.includes(condition.value);
    }

    return false;
  }

  /**
   * Evaluates an exists condition (checks if a field exists and is not null/undefined)
   * @param {Object} condition - The condition object
   * @param {*} result - The node result
   * @param {Object} state - Current execution state
   * @returns {boolean} Whether the field exists
   * @private
   */
  _evaluateExists(condition, result, state) {
    const context = {
      result,
      data: state?.data || {},
      nodeResults: state?.data?.nodeResults || {}
    };

    const value = this._getValueFromPath(condition.field, context);
    return value !== undefined && value !== null;
  }

  /**
   * Evaluates a comparison expression (=== or !==)
   * @param {string} expression - The comparison expression
   * @param {Object} context - The evaluation context
   * @returns {boolean} Comparison result
   * @private
   */
  _evaluateComparison(expression, context) {
    let operator;
    let parts;

    if (expression.includes('!==')) {
      operator = '!==';
      parts = expression.split('!==').map(p => p.trim());
    } else if (expression.includes('===')) {
      operator = '===';
      parts = expression.split('===').map(p => p.trim());
    } else {
      return false;
    }

    if (parts.length !== 2) {
      return false;
    }

    const [leftPath, rightValue] = parts;
    const leftActual = this._getValueFromPath(leftPath, context);

    // Parse the right value (handle strings, numbers, booleans)
    let rightActual;
    if (rightValue === 'true') {
      rightActual = true;
    } else if (rightValue === 'false') {
      rightActual = false;
    } else if (rightValue === 'null') {
      rightActual = null;
    } else if (rightValue === 'undefined') {
      rightActual = undefined;
    } else if (/^['"].*['"]$/.test(rightValue)) {
      // String literal
      rightActual = rightValue.slice(1, -1);
    } else if (!isNaN(Number(rightValue))) {
      rightActual = Number(rightValue);
    } else {
      // Treat as a path reference
      rightActual = this._getValueFromPath(rightValue, context);
    }

    if (operator === '===') {
      return leftActual === rightActual;
    } else {
      return leftActual !== rightActual;
    }
  }

  /**
   * Gets a value from a dot-notation path in the context
   * @param {string} path - The dot-notation path (e.g., "result.data.value")
   * @param {Object} context - The context object to search in
   * @returns {*} The value at the path or undefined
   * @private
   */
  _getValueFromPath(path, context) {
    if (!path || typeof path !== 'string') {
      return undefined;
    }

    const parts = path.split('.');
    let current = context;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Handle array access (e.g., "items[0]")
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        const index = parseInt(indexStr, 10);
        current = current[arrayName];
        if (Array.isArray(current)) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = current[part];
      }
    }

    return current;
  }

  /**
   * Finds the start node(s) of a workflow.
   * Start nodes are nodes with no incoming edges.
   *
   * @param {Object} workflow - The workflow definition
   * @param {Object[]} workflow.nodes - Array of workflow nodes
   * @param {Object[]} workflow.edges - Array of workflow edges
   * @returns {string[]} Array of start node IDs
   *
   * @example
   * const workflow = {
   *   nodes: [{ id: 'start' }, { id: 'middle' }, { id: 'end' }],
   *   edges: [
   *     { source: 'start', target: 'middle' },
   *     { source: 'middle', target: 'end' }
   *   ]
   * };
   * const startNodes = scheduler.findStartNodes(workflow);
   * // startNodes = ['start']
   */
  findStartNodes(workflow) {
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];

    // Find all nodes that are targets of edges
    const targetNodes = new Set(edges.map(e => e.target));

    // Start nodes are those not targeted by any edge
    const startNodes = nodes.filter(node => !targetNodes.has(node.id)).map(node => node.id);

    if (startNodes.length === 0 && nodes.length > 0) {
      // If no clear start node, use the first node (for simple linear workflows)
      logger.warn({
        component: 'DAGScheduler',
        message: 'No clear start node found, using first node',
        firstNode: nodes[0].id
      });
      return [nodes[0].id];
    }

    logger.debug({
      component: 'DAGScheduler',
      message: 'Found start nodes',
      startNodes
    });

    return startNodes;
  }

  /**
   * Finds the end node(s) of a workflow.
   * End nodes are nodes with no outgoing edges.
   *
   * @param {Object} workflow - The workflow definition
   * @param {Object[]} workflow.nodes - Array of workflow nodes
   * @param {Object[]} workflow.edges - Array of workflow edges
   * @returns {string[]} Array of end node IDs
   */
  findEndNodes(workflow) {
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];

    // Find all nodes that are sources of edges
    const sourceNodes = new Set(edges.map(e => e.source));

    // End nodes are those not the source of any edge
    const endNodes = nodes.filter(node => !sourceNodes.has(node.id)).map(node => node.id);

    if (endNodes.length === 0 && nodes.length > 0) {
      // If no clear end node, use the last node
      logger.warn({
        component: 'DAGScheduler',
        message: 'No clear end node found, using last node',
        lastNode: nodes[nodes.length - 1].id
      });
      return [nodes[nodes.length - 1].id];
    }

    logger.debug({
      component: 'DAGScheduler',
      message: 'Found end nodes',
      endNodes
    });

    return endNodes;
  }
}

export default DAGScheduler;
