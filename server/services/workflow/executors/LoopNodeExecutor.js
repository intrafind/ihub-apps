/**
 * Loop Node Executor for workflow DAG processing.
 *
 * Supports three iteration modes:
 * - `for`: Iterate a fixed number of times (count-based)
 * - `forEach`: Iterate over each element in an array resolved from workflow state
 * - `while`: Iterate as long as a JavaScript condition evaluates to true (VM-sandboxed)
 *
 * Each iteration executes a list of body nodes sequentially. Loop variables
 * (_loopIndex, _loopItem, _loopTotal, _loopHuman) are injected into state.data
 * during iteration and cleaned up after the loop completes. `_loopHuman` is
 * the 1-based counterpart of `_loopIndex` for user-facing progress messages
 * (templates can't do arithmetic).
 *
 * A hard cap (default 50, max 500) prevents runaway loops. The 500 ceiling
 * accommodates corpus-completeness workflows that iterate per-document over
 * a search result set; see concepts/2026-06-02 Completeness Analysis Workflows.md.
 *
 * @module services/workflow/executors/LoopNodeExecutor
 */

import vm from 'node:vm';
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import logger from '../../../utils/logger.js';
import { actionTracker } from '../../../actionTracker.js';

function emitSse(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch {
    // Best effort — never fail a node because of an SSE emit.
  }
}

/**
 * Engine-managed state-data keys that must NEVER be propagated back via a
 * node's `stateUpdates` payload. The engine writes these (and re-reads them)
 * via `state.data` directly; including them in stateUpdates causes shared
 * object references and circular JSON when the engine subsequently merges
 * the executor's result into state (e.g. `nodeResults.<id>_iter<N> = result`
 * creates a cycle when `result.stateUpdates.nodeResults` is the same object).
 */
const ENGINE_INTERNAL_STATE_KEYS = new Set([
  'nodeResults',
  'nodeInvocations',
  'executionMetrics',
  '_workflow',
  '_workflowDefinition',
  '_childExecutionIds',
  '_executionDeadline',
  '_pausedAt',
  '_pausedAtMs',
  '_pauseReason',
  '_resumedAt',
  '_resumeCount',
  '_totalElapsedMs',
  '_humanWaitMs',
  '_nodeIterations',
  '_currentNodeIteration',
  '_currentStep',
  '_totalNodes'
]);

/**
 * Executor that runs a list of body nodes repeatedly based on the configured loop mode.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // for-loop node config
 * {
 *   id: 'loop-1',
 *   type: 'loop',
 *   config: {
 *     mode: 'for',
 *     count: 5,
 *     body: [{ id: 'inner-step', type: 'prompt', config: { ... } }],
 *     outputVariable: 'loopResults'
 *   }
 * }
 *
 * @example
 * // forEach-loop node config
 * {
 *   id: 'loop-2',
 *   type: 'loop',
 *   config: {
 *     mode: 'forEach',
 *     array: 'items',          // resolves to state.data.items
 *     body: [{ id: 'process', type: 'transform', config: { ... } }],
 *     outputVariable: 'processedItems'
 *   }
 * }
 *
 * @example
 * // while-loop node config
 * {
 *   id: 'loop-3',
 *   type: 'loop',
 *   config: {
 *     mode: 'while',
 *     condition: 'data.retryCount < 3',
 *     maxIterations: 10,
 *     body: [{ id: 'retry-step', type: 'prompt', config: { ... } }]
 *   }
 * }
 */
export class LoopNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new LoopNodeExecutor.
   * @param {Object} [options] - Executor options passed to BaseNodeExecutor
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the loop node by iterating over body nodes according to the configured mode.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The loop node to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Current workflow state
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<import('./BaseNodeExecutor.js').ExecutionResult>} Result containing
   *   an array of iteration outputs and the total iteration count
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const {
      mode = 'for',
      count = 1,
      array,
      condition,
      maxIterations = 50,
      body: inlineBody = [],
      outputVariable
    } = config;

    // Body resolution order:
    // 1. Inline `config.body` (legacy / serializer-generated workflows)
    // 2. Container children — workflow nodes whose `parentId` is this loop
    //    node, ordered by the edges between them (visual editor containers)
    const body =
      Array.isArray(inlineBody) && inlineBody.length > 0
        ? inlineBody
        : this.resolveContainerBody(node, context);

    // Hard cap prevents runaway loops regardless of user configuration.
    // Raised from 200 → 500 to support per-document analysis over larger
    // corpora; default per-node maxIterations stays 50.
    const hardCap = Math.min(maxIterations, 500);

    const chatId = context?.chatId || state?.executionId;
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const iterationTimings = [];
    const bodyNodeIds = Array.isArray(body) ? body.map(b => b?.id).filter(Boolean) : [];

    emitSse(
      'agent.step.started',
      {
        nodeId: node.id,
        kind: 'loop',
        mode,
        bodyNodeIds,
        startedAt: startedAt.toISOString(),
        hardCap
      },
      chatId
    );

    try {
      const results = [];
      let currentState = { ...state, data: { ...state.data } };

      switch (mode) {
        case 'for': {
          const iterCount = Math.min(count, hardCap);
          for (let i = 0; i < iterCount; i++) {
            if (context.abortSignal?.aborted) break;
            currentState.data._loopIndex = i;
            currentState.data._loopHuman = i + 1;
            currentState.data._loopTotal = iterCount;

            const bodyResult = await this.executeBodyNodes(body, currentState, context, {
              loopNodeId: node.id,
              chatId,
              iteration: results.length,
              total:
                mode === 'for'
                  ? Math.min(count, hardCap)
                  : mode === 'forEach'
                    ? currentState.data._loopTotal
                    : null
            });
            results.push(bodyResult.output);
            iterationTimings.push({
              iteration: results.length - 1,
              startedAt: bodyResult.startedAt || null,
              durationMs: bodyResult.durationMs || null,
              failed: bodyResult.failed,
              ...(bodyResult.failedAtNodeId ? { failedAtNodeId: bodyResult.failedAtNodeId } : {})
            });
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
          }
          break;
        }

        case 'forEach': {
          const resolvedArray = this.resolveVariable(
            array?.startsWith('$.') ? array : `$.data.${array}`,
            state
          );
          if (!Array.isArray(resolvedArray)) {
            return this.createErrorResult(`forEach: '${array}' is not an array`, {
              nodeId: node.id
            });
          }

          const iterArr = resolvedArray.slice(0, hardCap);

          // Optional bounded parallelism for forEach: run up to `concurrency`
          // iterations at once. Each iteration works on a snapshot of the
          // PRE-LOOP state — cross-iteration state writes are intentionally
          // NOT propagated in parallel mode (only the collected results in
          // `outputVariable` and step logs survive), because concurrent
          // last-write-wins merging would be non-deterministic.
          const concurrency = Math.max(1, Math.min(parseInt(config.concurrency, 10) || 1, 10));
          if (concurrency > 1) {
            const parallelOutcome = await this.executeForEachParallel(
              node,
              state,
              context,
              iterArr,
              body,
              concurrency,
              chatId
            );
            results.push(...parallelOutcome.results);
            iterationTimings.push(...parallelOutcome.iterationTimings);
            break;
          }

          for (let i = 0; i < iterArr.length; i++) {
            if (context.abortSignal?.aborted) break;
            currentState.data._loopIndex = i;
            currentState.data._loopHuman = i + 1;
            currentState.data._loopItem = iterArr[i];
            currentState.data._loopTotal = iterArr.length;

            const bodyResult = await this.executeBodyNodes(body, currentState, context, {
              loopNodeId: node.id,
              chatId,
              iteration: results.length,
              total:
                mode === 'for'
                  ? Math.min(count, hardCap)
                  : mode === 'forEach'
                    ? currentState.data._loopTotal
                    : null
            });
            results.push(bodyResult.output);
            iterationTimings.push({
              iteration: results.length - 1,
              startedAt: bodyResult.startedAt || null,
              durationMs: bodyResult.durationMs || null,
              failed: bodyResult.failed,
              ...(bodyResult.failedAtNodeId ? { failedAtNodeId: bodyResult.failedAtNodeId } : {})
            });
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
          }
          break;
        }

        case 'while': {
          if (!condition) {
            return this.createErrorResult('while mode requires a condition', {
              nodeId: node.id
            });
          }

          let i = 0;
          while (i < hardCap) {
            if (context.abortSignal?.aborted) break;

            const condResult = this.evaluateCondition(condition, currentState.data, i);
            if (!condResult) break;

            currentState.data._loopIndex = i;
            currentState.data._loopHuman = i + 1;
            currentState.data._loopTotal = -1; // unknown for while loops

            const bodyResult = await this.executeBodyNodes(body, currentState, context, {
              loopNodeId: node.id,
              chatId,
              iteration: results.length
            });
            results.push(bodyResult.output);
            iterationTimings.push({
              iteration: results.length - 1,
              startedAt: bodyResult.startedAt || null,
              durationMs: bodyResult.durationMs || null,
              failed: bodyResult.failed,
              ...(bodyResult.failedAtNodeId ? { failedAtNodeId: bodyResult.failedAtNodeId } : {})
            });
            // Use returned state so the next condition evaluation sees updated data
            currentState = bodyResult.state;

            if (bodyResult.failed) break;
            i++;
          }
          break;
        }

        case 'drain': {
          // Drain mode: pop the next open task from `state.data[queueKey]` on
          // every iteration, run the body node(s) with `state.data._currentTask`
          // populated, then mark the task done/failed. The body itself may
          // call `create_task` to push more work onto the queue — that's the
          // V1 dynamic-task primitive.
          const queueKey = config.queueKey || '_taskQueue';
          // Resolve the body: prefer inline `body`, else single node id via `child`.
          let resolvedBody = Array.isArray(body) && body.length > 0 ? body : null;
          if (!resolvedBody && config.child && context?.workflow?.nodes) {
            const child = context.workflow.nodes.find(n => n.id === config.child);
            if (child) resolvedBody = [child];
          }
          if (!resolvedBody || resolvedBody.length === 0) {
            return this.createErrorResult(`drain mode requires either body or config.child`, {
              nodeId: node.id
            });
          }

          let i = 0;
          let bounded = false;
          while (i < hardCap) {
            if (context.abortSignal?.aborted) break;
            const queue = Array.isArray(currentState.data[queueKey])
              ? currentState.data[queueKey]
              : [];
            const nextTask = queue.find(t => t?.status === 'open');
            if (!nextTask) break;

            // Mutate task to in_progress directly on currentState.data.
            nextTask.status = 'in_progress';
            nextTask.updatedAt = new Date().toISOString();
            currentState.data._currentTask = nextTask;
            currentState.data._loopIndex = i;
            currentState.data._loopHuman = i + 1;

            const bodyResult = await this.executeBodyNodes(resolvedBody, currentState, context, {
              loopNodeId: node.id,
              chatId,
              iteration: results.length
            });
            results.push(bodyResult.output);
            iterationTimings.push({
              iteration: results.length - 1,
              startedAt: bodyResult.startedAt || null,
              durationMs: bodyResult.durationMs || null,
              failed: bodyResult.failed,
              ...(bodyResult.failedAtNodeId ? { failedAtNodeId: bodyResult.failedAtNodeId } : {})
            });
            currentState = bodyResult.state;

            // Resolve the task object in the new state (executeBodyNodes
            // shallow-copies state.data, so we have to look it up again).
            const queueAfter = Array.isArray(currentState.data[queueKey])
              ? currentState.data[queueKey]
              : [];
            const refreshedTask = queueAfter.find(t => t.id === nextTask.id) || nextTask;

            if (bodyResult.failed) {
              refreshedTask.status = 'failed';
              refreshedTask.updatedAt = new Date().toISOString();
            } else if (refreshedTask.status === 'in_progress') {
              // The body did not explicitly mark it via mark_task_done — auto-complete.
              refreshedTask.status = 'done';
              refreshedTask.updatedAt = new Date().toISOString();
            }

            i++;
          }
          if (i >= hardCap) bounded = true;
          delete currentState.data._currentTask;
          if (bounded) {
            logger.warn('Drain loop hit hard cap', {
              component: 'LoopNodeExecutor',
              nodeId: node.id,
              hardCap
            });
          }
          break;
        }

        default:
          return this.createErrorResult(`Unknown loop mode: ${mode}`, {
            nodeId: node.id
          });
      }

      // Clean up temporary loop variables from state
      delete currentState.data._loopIndex;
      delete currentState.data._loopHuman;
      delete currentState.data._loopItem;
      delete currentState.data._loopTotal;

      // Build stateUpdates from body-produced data ONLY. We must NOT spread
      // engine-internal keys (nodeResults, nodeInvocations, _workflow*, etc.)
      // because they hold references that the engine mutates after this
      // executor returns. Specifically, `markNodeCompleted` writes
      // `nodeResults.<this-nodeId>_iter<N> = result` — and if our
      // `stateUpdates.nodeResults` references the same object, the result
      // ends up containing itself, producing
      //   stateUpdates → nodeResults → drain_iter1 → result → stateUpdates
      // which JSON.stringify chokes on inside _validateStateSize.
      const propagatedData = {};
      for (const [k, v] of Object.entries(currentState.data || {})) {
        if (ENGINE_INTERNAL_STATE_KEYS.has(k)) continue;
        propagatedData[k] = v;
      }
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startMs;
      const anyFailed = iterationTimings.some(t => t.failed);
      const stepLog = {
        nodeId: node.id,
        kind: 'loop',
        mode,
        bodyNodeIds,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        iterations: results.length,
        ...(typeof hardCap === 'number' ? { hardCap } : {}),
        iterationTimings,
        ...(anyFailed ? { failed: true } : {})
      };
      emitSse(
        'agent.step.completed',
        {
          nodeId: node.id,
          kind: 'loop',
          mode,
          iterations: results.length,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs,
          ...(anyFailed ? { failed: true } : {})
        },
        chatId
      );

      const priorStepLogs =
        propagatedData._stepLogs && typeof propagatedData._stepLogs === 'object'
          ? propagatedData._stepLogs
          : {};
      const stateUpdates = {
        ...(outputVariable ? { [outputVariable]: results } : {}),
        ...propagatedData,
        _stepLogs: { ...priorStepLogs, [node.id]: stepLog }
      };

      return this.createSuccessResult({ results, iterations: results.length }, { stateUpdates });
    } catch (error) {
      emitSse(
        'agent.step.completed',
        {
          nodeId: node.id,
          kind: 'loop',
          failed: true,
          error: error.message,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs
        },
        chatId
      );
      return this.createErrorResult(`Loop execution failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Resolve the loop body from container children: workflow nodes whose
   * `parentId` is this loop node, ordered by the edges between siblings
   * (Kahn topological order; entry = child with no incoming sibling edge).
   * Children not reachable through sibling edges are appended in their
   * original array order so a disconnected body node still executes.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The loop node
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Array<import('./BaseNodeExecutor.js').WorkflowNode>} Ordered body nodes
   */
  resolveContainerBody(node, context) {
    const wfNodes = context?.workflow?.nodes;
    if (!Array.isArray(wfNodes)) return [];
    const children = wfNodes.filter(n => n?.parentId === node.id);
    if (children.length <= 1) return children;

    const childIds = new Set(children.map(c => c.id));
    const wfEdges = (context.workflow.edges || []).filter(
      e => childIds.has(e.source) && childIds.has(e.target)
    );

    const inDegree = new Map(children.map(c => [c.id, 0]));
    const adjacency = new Map(children.map(c => [c.id, []]));
    for (const edge of wfEdges) {
      adjacency.get(edge.source).push(edge.target);
      inDegree.set(edge.target, inDegree.get(edge.target) + 1);
    }

    const queue = children.filter(c => inDegree.get(c.id) === 0).map(c => c.id);
    const ordered = [];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
      for (const next of adjacency.get(id) || []) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }
    // Guard against sibling cycles: append anything Kahn couldn't order.
    for (const child of children) {
      if (!seen.has(child.id)) ordered.push(child.id);
    }

    const byId = new Map(children.map(c => [c.id, c]));
    return ordered.map(id => byId.get(id));
  }

  /**
   * Run forEach iterations with bounded parallelism. Each iteration executes
   * the body against a snapshot of the pre-loop state; results are collected
   * in item order. When an iteration fails, no new iterations are scheduled
   * (in-flight ones finish). Cross-iteration state updates are discarded —
   * only the returned results (and step logs) survive, keeping parallel runs
   * deterministic.
   *
   * @param {import('./BaseNodeExecutor.js').WorkflowNode} node - The loop node
   * @param {import('./BaseNodeExecutor.js').WorkflowState} state - Pre-loop workflow state
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @param {Array<*>} items - Array items to iterate over (already capped)
   * @param {Array<import('./BaseNodeExecutor.js').WorkflowNode>} body - Body nodes
   * @param {number} concurrency - Max iterations in flight (2-10)
   * @param {string} chatId - SSE channel id
   * @returns {Promise<{results: Array<*>, iterationTimings: Array<object>}>}
   */
  async executeForEachParallel(node, state, context, items, body, concurrency, chatId) {
    const results = new Array(items.length);
    const iterationTimings = new Array(items.length);
    let nextIndex = 0;
    let stopScheduling = false;

    const runOne = async i => {
      const iterationState = {
        ...state,
        data: {
          ...state.data,
          _loopIndex: i,
          _loopHuman: i + 1,
          _loopItem: items[i],
          _loopTotal: items.length
        }
      };
      const bodyResult = await this.executeBodyNodes(body, iterationState, context, {
        loopNodeId: node.id,
        chatId,
        iteration: i,
        total: items.length
      });
      results[i] = bodyResult.output;
      iterationTimings[i] = {
        iteration: i,
        startedAt: bodyResult.startedAt || null,
        durationMs: bodyResult.durationMs || null,
        failed: bodyResult.failed,
        ...(bodyResult.failedAtNodeId ? { failedAtNodeId: bodyResult.failedAtNodeId } : {})
      };
      if (bodyResult.failed) stopScheduling = true;
    };

    const worker = async () => {
      while (!stopScheduling && !context.abortSignal?.aborted && nextIndex < items.length) {
        const i = nextIndex++;
        await runOne(i);
      }
    };

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      results: results.filter((_, i) => iterationTimings[i] !== undefined),
      iterationTimings: iterationTimings.filter(t => t !== undefined)
    };
  }

  /**
   * Execute a list of body nodes sequentially within a single loop iteration.
   *
   * Uses lazy import of `getExecutor` from `./index.js` to avoid circular
   * dependency issues (index.js imports this file, and this file needs getExecutor).
   *
   * @param {Array<import('./BaseNodeExecutor.js').WorkflowNode>} bodyNodes - Nodes to execute
   * @param {import('./BaseNodeExecutor.js').WorkflowState} iterationState - State for this iteration
   * @param {import('./BaseNodeExecutor.js').ExecutionContext} context - Execution context
   * @returns {Promise<{output: *, state: Object, failed: boolean}>} Iteration result with
   *   the final output, updated state, and whether execution failed
   */
  async executeBodyNodes(bodyNodes, iterationState, context, meta = {}) {
    // Lazy import to avoid circular dependency with index.js
    const { getExecutor } = await import('./index.js');

    let currentState = { ...iterationState, data: { ...iterationState.data } };
    let lastOutput;
    const iterStartMs = Date.now();
    const iterStartedAt = new Date(iterStartMs);
    const { loopNodeId, chatId, iteration, total } = meta;
    if (loopNodeId) {
      emitSse(
        'agent.loop.iteration.started',
        {
          nodeId: loopNodeId,
          iteration,
          ...(total != null ? { total } : {}),
          bodyNodeIds: bodyNodes.map(b => b?.id).filter(Boolean),
          startedAt: iterStartedAt.toISOString()
        },
        chatId
      );
    }

    let failedAtNodeId = null;
    for (const bodyNode of bodyNodes) {
      const executor = getExecutor(bodyNode.type);
      const result = await executor.execute(bodyNode, currentState, context);
      lastOutput = result.output;

      if (result.stateUpdates) {
        currentState.data = { ...currentState.data, ...result.stateUpdates };
      }

      if (result.status === 'failed') {
        failedAtNodeId = bodyNode.id;
        if (loopNodeId) {
          emitSse(
            'agent.loop.iteration.completed',
            {
              nodeId: loopNodeId,
              iteration,
              failed: true,
              failedAtNodeId,
              durationMs: Date.now() - iterStartMs,
              completedAt: new Date().toISOString()
            },
            chatId
          );
        }
        return {
          output: result.output,
          state: currentState,
          failed: true,
          failedAtNodeId,
          startedAt: iterStartedAt.toISOString(),
          durationMs: Date.now() - iterStartMs
        };
      }
    }
    if (loopNodeId) {
      emitSse(
        'agent.loop.iteration.completed',
        {
          nodeId: loopNodeId,
          iteration,
          failed: false,
          durationMs: Date.now() - iterStartMs,
          completedAt: new Date().toISOString()
        },
        chatId
      );
    }

    // CRITICAL: must NOT return currentState.data here. currentState.data
    // contains `nodeResults`, and the loop body's caller pushes this output
    // into `results[]`. When the engine then stores the loop's result under
    // state.data.nodeResults.<loopId>_iter1, we get a cycle:
    //   state.data.nodeResults.<loopId>_iter1.output.results[0] === state.data
    //     → which has .nodeResults → which has the loop result → cycle.
    // JSON.stringify chokes inside _validateStateSize and the whole drain
    // fails. Return only the last body node's output (already filtered to
    // safe content/model/tokens fields by createSuccessResult).
    return {
      output: lastOutput,
      state: currentState,
      failed: false,
      startedAt: iterStartedAt.toISOString(),
      durationMs: Date.now() - iterStartMs
    };
  }

  /**
   * Evaluate a JavaScript condition string in a sandboxed VM context.
   *
   * The condition runs in strict mode with a 1-second timeout. The sandbox
   * receives a JSON-safe copy of `data` and `index` to prevent prototype
   * pollution or access to the host environment.
   *
   * If evaluation throws (syntax error, timeout, etc.), the loop stops
   * by returning false.
   *
   * @param {string} condition - JavaScript expression to evaluate (e.g. "data.count < 10")
   * @param {Object} data - Current loop state data
   * @param {number} index - Current iteration index
   * @returns {boolean} Whether the condition is truthy
   */
  evaluateCondition(condition, data, index) {
    try {
      // VM sandbox hardening: create context with null prototype
      const sandbox = vm.createContext(Object.create(null));
      // Break prototype chain by JSON round-tripping to prevent pollution
      Object.assign(sandbox, JSON.parse(JSON.stringify({ data, index })));

      const result = vm.runInNewContext(`'use strict';\n${condition}`, sandbox, {
        timeout: 1000
      });
      return Boolean(result);
    } catch (error) {
      logger.warn({
        component: 'LoopNodeExecutor',
        message: `Condition evaluation failed: ${error.message}`,
        condition
      });
      return false; // Stop loop on error
    }
  }
}

export default LoopNodeExecutor;
