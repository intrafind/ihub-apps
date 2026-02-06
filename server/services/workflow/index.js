/**
 * Workflow Engine Module
 *
 * This module provides the core workflow execution engine for iHub Apps.
 * It enables the creation and execution of complex, multi-step AI workflows
 * with support for LLM calls, tool execution, conditional branching, and
 * state management.
 *
 * @module server/services/workflow
 *
 * @example
 * import { WorkflowEngine, DAGScheduler, StateManager } from './services/workflow';
 *
 * const engine = new WorkflowEngine();
 *
 * // Register node executors
 * engine.registerExecutor('llm', llmExecutor);
 * engine.registerExecutor('tool', toolExecutor);
 *
 * // Start workflow execution
 * const state = await engine.start(workflowDefinition, initialData);
 */

export { WorkflowEngine, default as workflowEngine } from './WorkflowEngine.js';
export { DAGScheduler } from './DAGScheduler.js';
export { StateManager, WorkflowStatus } from './StateManager.js';
