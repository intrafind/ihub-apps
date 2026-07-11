import logger from '../../utils/logger.js';
import { evaluateBooleanExpression } from './expressionEvaluator.js';
import { resolveDotPath } from './pathResolver.js';

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
   * A cycle indicates a potential for infinite execution if not properly controlled.
   *
   * @param {Object[]} nodes - Array of workflow nodes
   * @param {string} nodes[].id - Unique node identifier
   * @param {Object[]} edges - Array of workflow edges
   * @param {string} edges[].source - Source node ID
   * @param {string} edges[].target - Target node ID
   * @param {Object} [options={}] - Detection options
   * @param {boolean} [options.allowCycles=true] - If true, skip cycle detection (cycles are allowed)
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
   *
   * // Strict DAG mode - reject cycles
   * const result = scheduler.detectCycles(nodes, edges, { allowCycles: false });
   * // result = { hasCycle: true, cycleNodes: ['a', 'b', 'c'] }
   *
   * // Permissive mode - allow cycles (default)
   * const result2 = scheduler.detectCycles(nodes, edges, { allowCycles: true });
   * // result2 = { hasCycle: false, cycleNodes: [] }
   */
  detectCycles(nodes, edges, options = {}) {
    const { allowCycles = true } = options;

    // If cycles are allowed, skip detection entirely
    // Runtime protection (maxIterations per node) handles infinite loop prevention
    if (allowCycles) {
      return { hasCycle: false, cycleNodes: [] };
    }
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

      logger.warn('Cycle detected in workflow graph', { component: 'DAGScheduler', cycleNodes });

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

    logger.debug('Topological sort completed', {
      component: 'DAGScheduler',
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

    // Two dependency-readiness modes, picked by workflow.config.allowCycles:
    //
    // (A) Cyclic workflows — `allowCycles: true` (default).
    //     Use OR-semantics: a node is ready if ANY incoming edge's source is
    //     completed. This is required for loop bodies, where the back-edge
    //     source completes on every iteration and re-triggers the body.
    //     Requiring ALL incoming edges to be satisfied would deadlock — the
    //     loop's "forward" edge source would have to complete every iteration
    //     too, but it doesn't.
    //
    // (B) DAG workflows — `allowCycles: false` (planner sub-workflows).
    //     Use AND-semantics: a node is ready ONLY when ALL its incoming
    //     edges have completed sources. This is what `dependsOn` and the
    //     sequential safety net in SubWorkflowMaterializer rely on — if we
    //     used OR here, declaring `dependsOn: ['A']` on a task that ALSO
    //     has a sequential predecessor `B` would let the task run as soon
    //     as either A or B completes (whichever fires first), defeating the
    //     dependency ordering. With AND, both must complete first.
    //
    // The legacy comment that "for DAGs, OR is equivalent to AND because
    // each node has only one incoming edge active" is no longer true: the
    // materializer's sequential safety net deliberately adds a second
    // incoming edge alongside `dependsOn` to harden ordering, so DAGs now
    // routinely have multiple incoming edges per node.
    const allowCycles = workflow.config?.allowCycles !== false;

    // MVP: Sequential execution — return the FIRST currentNode that's ready.
    // Previously this only ever checked `currentNodes[0]`, which worked under
    // OR-semantics (almost any current node was "ready"). Under AND-semantics
    // a node can be blocked behind unsatisfied upstreams; iterating lets a
    // later-in-the-list ready node run instead of stalling the whole loop.
    // TODO: Return all ready nodes for true parallel execution.
    const edges = workflow.edges || [];
    const isReady = nodeId => {
      const incomingEdges = edges.filter(edge => edge.target === nodeId);
      if (incomingEdges.length === 0) return { ready: true, incomingEdges };
      const ready = allowCycles
        ? incomingEdges.some(edge => completedSet.has(edge.source))
        : incomingEdges.every(edge => completedSet.has(edge.source));
      return { ready, incomingEdges };
    };

    for (const nodeId of currentNodes) {
      const { ready, incomingEdges } = isReady(nodeId);
      if (ready) {
        logger.debug('Node ready for execution', {
          component: 'DAGScheduler',
          nodeId,
          dependencyMode: allowCycles ? 'any' : 'all',
          satisfiedDependencies: incomingEdges
            .filter(e => completedSet.has(e.source))
            .map(e => e.source),
          totalIncomingEdges: incomingEdges.length
        });
        return [nodeId];
      }
    }

    // No current node is ready. Log a deadlock warning for the first
    // current node so operators see *something*; the per-node loop above
    // already debug-logged each waiter.
    const firstNode = currentNodes[0];
    const { incomingEdges } = isReady(firstNode);
    const unsatisfied = incomingEdges.filter(e => !completedSet.has(e.source));
    if (unsatisfied.length === incomingEdges.length) {
      logger.warn('No current nodes have any satisfied dependencies', {
        component: 'DAGScheduler',
        currentNodes,
        dependencyMode: allowCycles ? 'any' : 'all',
        requiredNodes: incomingEdges.map(e => e.source),
        completedNodes: Array.from(completedSet)
      });
    } else {
      logger.debug('All current nodes still waiting for upstream dependencies', {
        component: 'DAGScheduler',
        currentNodes,
        waitingFor: unsatisfied.map(e => e.source)
      });
    }

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
      logger.debug('No outgoing edges from node', { component: 'DAGScheduler', nodeId });
      return [];
    }

    const nextNodes = [];

    for (const edge of outgoingEdges) {
      const shouldFollow = this.evaluateCondition(edge, result, state);

      if (shouldFollow) {
        nextNodes.push(edge.target);
        logger.debug('Following edge to next node', {
          component: 'DAGScheduler',
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
   * @param {string} [edge.condition.expression] - Boolean expression for type='expression'
   * @param {string} [edge.condition.field] - Path for type='equals'/'contains'/'exists'
   * @param {*} [edge.condition.value] - Comparand for type='equals'/'contains'
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
        return this._evaluateExpression(condition.expression, result, state);

      case 'equals':
        return this._evaluateEquals(condition, result, state);

      case 'contains':
        return this._evaluateContains(condition, result, state);

      case 'exists':
        return this._evaluateExists(condition, result, state);

      case 'llm':
        // Future: LLM-based routing decision
        // For now, log warning and treat as 'always'
        logger.warn('LLM condition type not yet implemented, treating as always', {
          component: 'DAGScheduler',
          edge: { source: edge.source, target: edge.target }
        });
        return true;

      default:
        logger.warn('Unknown condition type, treating as always', {
          component: 'DAGScheduler',
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
    const { value, error } = evaluateBooleanExpression(expression, state);
    if (error && error !== 'empty-expression') {
      logger.warn('Edge expression evaluation failed', {
        component: 'DAGScheduler',
        expression,
        error
      });
    } else if (error === 'empty-expression') {
      logger.warn('Empty expression on edge condition — treating as false', {
        component: 'DAGScheduler'
      });
    }
    return value;
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

    return resolveDotPath(path, context);
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
      logger.warn('No clear start node found, using first node', {
        component: 'DAGScheduler',
        firstNode: nodes[0].id
      });
      return [nodes[0].id];
    }

    logger.debug('Found start nodes', { component: 'DAGScheduler', startNodes });

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
      logger.warn('No clear end node found, using last node', {
        component: 'DAGScheduler',
        lastNode: nodes[nodes.length - 1].id
      });
      return [nodes[nodes.length - 1].id];
    }

    logger.debug('Found end nodes', { component: 'DAGScheduler', endNodes });

    return endNodes;
  }
}

export default DAGScheduler;
