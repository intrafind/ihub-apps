/**
 * SubWorkflowMaterializer
 *
 * Converts a structured task plan from the PlannerNodeExecutor into a
 * valid workflow definition that can be executed by the WorkflowEngine.
 *
 * Each task in the plan becomes an agent node. Dependencies between tasks
 * are translated into edges. A synthesizer node can optionally be added
 * to summarize all task outputs.
 *
 * @module services/workflow/SubWorkflowMaterializer
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

/**
 * Materializes a task plan into an executable workflow definition.
 */
export class SubWorkflowMaterializer {
  /**
   * Convert a task plan into a workflow definition.
   *
   * @param {Object} plan - The task plan from the LLM
   * @param {Array<{id, title, description, tools, dependsOn}>} plan.tasks - Tasks to execute
   * @param {string} plan.reasoning - LLM reasoning for the plan
   * @param {Object} parentConfig - Configuration from the planner node
   * @param {boolean} [parentConfig.synthesize] - Whether to add a synthesizer node
   * @param {Object} [parentConfig.taskTemplate] - Default config for task nodes
   * @param {string} parentExecutionId - The parent execution's ID (for unique child ID)
   * @param {number} [depth=0] - Current sub-workflow depth
   * @returns {Object} A valid workflow definition matching workflowConfigSchema
   */
  materialize(plan, parentConfig, parentExecutionId, depth = 0) {
    const { tasks } = plan;
    const shortId = uuidv4().slice(0, 8);
    const workflowId = `plan-${shortId}`;
    const taskTemplate = parentConfig.taskTemplate || {};
    const synthesize = parentConfig.synthesize === true;

    logger.info({
      component: 'SubWorkflowMaterializer',
      message: 'Materializing sub-workflow from task plan',
      workflowId,
      taskCount: tasks.length,
      synthesize,
      depth
    });

    const nodes = [];
    const edges = [];

    // Add start node
    nodes.push({
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      position: { x: 100, y: 300 },
      config: {}
    });

    // Create agent nodes for each task
    tasks.forEach((task, index) => {
      const nodeId = `task-${task.id}`;
      const xPos = 300 + index * 250;

      nodes.push({
        id: nodeId,
        type: 'agent',
        name: { en: task.title },
        position: { x: xPos, y: 300 },
        config: {
          system: task.description,
          outputVariable: `task_${task.id}_output`,
          tools: task.tools || taskTemplate.tools || [],
          ...taskTemplate
        }
      });
    });

    // Optionally add synthesizer node
    const synthNodeId = 'synthesizer';
    if (synthesize) {
      const synthXPos = 300 + tasks.length * 250;
      nodes.push({
        id: synthNodeId,
        type: 'agent',
        name: { en: 'Synthesizer' },
        position: { x: synthXPos, y: 300 },
        config: {
          system:
            'You are a synthesis agent. Collect all task outputs and produce a comprehensive, well-structured final report.',
          outputVariable: 'synthesizedOutput',
          tools: []
        }
      });
    }

    // Add end node
    const endXPos = synthesize ? 300 + (tasks.length + 1) * 250 : 300 + tasks.length * 250;
    nodes.push({
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      position: { x: endXPos, y: 300 },
      config: {}
    });

    // Build edges based on task dependencies
    const taskNodeMap = {};
    tasks.forEach(task => {
      taskNodeMap[task.id] = `task-${task.id}`;
    });

    // Track which tasks have explicit incoming edges
    const tasksWithIncoming = new Set();

    // Add dependency edges
    tasks.forEach(task => {
      const deps = task.dependsOn || [];
      deps.forEach(depId => {
        if (taskNodeMap[depId]) {
          const edgeId = `e-${depId}-${task.id}`;
          edges.push({
            id: edgeId,
            source: taskNodeMap[depId],
            target: taskNodeMap[task.id]
          });
          tasksWithIncoming.add(task.id);
        }
      });
    });

    // Tasks without dependencies connect from start
    tasks.forEach(task => {
      if (!tasksWithIncoming.has(task.id)) {
        edges.push({
          id: `e-start-${task.id}`,
          source: 'start',
          target: taskNodeMap[task.id]
        });
      }
    });

    // If no deps specified, build a sequential chain
    if (tasks.length > 0 && edges.filter(e => e.source !== 'start').length === 0) {
      // Sequential: start -> task1 -> task2 -> ... -> taskN
      // Clear start edges and rebuild as chain
      edges.length = 0;
      edges.push({
        id: 'e-start-task0',
        source: 'start',
        target: taskNodeMap[tasks[0].id]
      });
      for (let i = 0; i < tasks.length - 1; i++) {
        edges.push({
          id: `e-task${i}-task${i + 1}`,
          source: taskNodeMap[tasks[i].id],
          target: taskNodeMap[tasks[i + 1].id]
        });
      }
    }

    // Connect last task(s) to synthesizer or end
    const lastTaskIds = this._findSinkNodes(tasks, edges);
    const finalTarget = synthesize ? synthNodeId : 'end';

    lastTaskIds.forEach(taskId => {
      const sourceNodeId = taskNodeMap[taskId];
      if (sourceNodeId) {
        edges.push({
          id: `e-${taskId}-final`,
          source: sourceNodeId,
          target: finalTarget
        });
      }
    });

    // If synthesize, connect synthesizer to end
    if (synthesize) {
      edges.push({
        id: 'e-synth-end',
        source: synthNodeId,
        target: 'end'
      });
    }

    const workflowDef = {
      id: workflowId,
      name: { en: 'Dynamic Plan' },
      description: { en: `Auto-generated plan: ${tasks.length} tasks` },
      version: '1.0.0',
      enabled: true,
      config: {
        maxIterations: 50,
        allowCycles: false
      },
      nodes,
      edges
    };

    logger.info({
      component: 'SubWorkflowMaterializer',
      message: 'Sub-workflow materialized',
      workflowId,
      nodeCount: nodes.length,
      edgeCount: edges.length
    });

    return workflowDef;
  }

  /**
   * Find task IDs that have no outgoing edges (sink nodes in the task graph).
   * These are the last tasks that need to connect to the synthesizer/end.
   *
   * @param {Array} tasks - All tasks
   * @param {Array} edges - Current edges (only task-to-task)
   * @returns {Array<string>} Task IDs with no outgoing edges
   * @private
   */
  _findSinkNodes(tasks, edges) {
    if (tasks.length === 0) {
      return [];
    }

    const taskIds = new Set(tasks.map(t => t.id));
    const tasksWithOutgoing = new Set();

    edges.forEach(edge => {
      // Check if source is a task node
      const sourceTaskId = edge.source.startsWith('task-') ? edge.source.slice(5) : null;
      if (sourceTaskId && taskIds.has(sourceTaskId)) {
        const targetTaskId = edge.target.startsWith('task-') ? edge.target.slice(5) : null;
        if (targetTaskId && taskIds.has(targetTaskId)) {
          tasksWithOutgoing.add(sourceTaskId);
        }
      }
    });

    const sinks = tasks.filter(t => !tasksWithOutgoing.has(t.id)).map(t => t.id);
    return sinks.length > 0 ? sinks : [tasks[tasks.length - 1].id];
  }
}

export default SubWorkflowMaterializer;
