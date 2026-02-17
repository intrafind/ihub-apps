/**
 * Workflow Runner Tool - Chat-Workflow Bridge
 *
 * Executes a workflow from within a chat session, bridging workflow SSE events
 * onto the chat's SSE channel so the client receives live progress updates.
 *
 * The workflow engine emits events with chatId = executionId. This bridge
 * listens for those events and re-emits them on the chat's chatId so the
 * chat SSE stream receives workflow progress in real time.
 *
 * @module tools/workflowRunner
 */

import { WorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { actionTracker } from '../actionTracker.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/** Maps chatId → { executionId, engine } for active workflow executions in chat */
export const activeWorkflowExecutions = new Map();

/**
 * Extract a plain string from a localized object or return as-is
 * @param {string|Object} value - Plain string or { en: "...", de: "..." }
 * @param {string} lang - Preferred language
 * @returns {string}
 */
function resolveLocalized(value, lang = 'en') {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[lang] || value.en || Object.values(value)[0] || '';
}

/**
 * Extract a human-readable string from workflow output.
 * If the output is already a string, return it.
 * If it's an object, look for common report/content fields.
 */
function extractReadableOutput(output, primaryOutput) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (typeof output !== 'object') return String(output);

  logger.info({
    component: 'workflowRunner',
    message: 'extractReadableOutput debug',
    primaryOutput,
    outputKeys: Object.keys(output),
    primaryFieldType: primaryOutput ? typeof output[primaryOutput] : 'N/A',
    primaryFieldLength:
      primaryOutput && typeof output[primaryOutput] === 'string' ? output[primaryOutput].length : -1
  });

  // Use workflow-declared primary output field first
  if (primaryOutput && output[primaryOutput] !== undefined && output[primaryOutput] !== null) {
    const val = output[primaryOutput];
    if (typeof val === 'string' && val.length > 0) return val;
    if (typeof val === 'object') return JSON.stringify(val, null, 2);
  }

  // Fallback: look for common content field names
  const contentFields = [
    'finalReport',
    'report',
    'content',
    'output',
    'result',
    'summary',
    'text',
    'message'
  ];
  for (const field of contentFields) {
    if (typeof output[field] === 'string' && output[field].length > 0) {
      return output[field];
    }
  }

  // Fallback: JSON dump
  return JSON.stringify(output, null, 2);
}

/**
 * Run a workflow as a chat tool.
 *
 * @param {Object} params
 * @param {string} params.workflowId - The workflow definition ID
 * @param {string} params.chatId - The chat session ID (for SSE bridging)
 * @param {Object} params.user - The authenticated user object
 * @param {string} [params.input] - The user's message / primary input
 * @param {Array}  [params._chatHistory] - Prior chat messages for context
 * @param {Array}  [params._fileData] - Uploaded file data to pass to the workflow
 * @param {string} [params.language] - User language for localized names
 * @returns {Promise<Object>} { status, executionId, output }
 */
export default async function workflowRunner(params = {}) {
  const {
    workflowId,
    chatId,
    user,
    input,
    modelId,
    passthrough,
    appConfig: _appConfig,
    _chatHistory,
    _fileData,
    language = 'en',
    ...extraInputVars
  } = params;

  if (!workflowId) {
    throw new Error('workflowId is required');
  }

  // 1. Load workflow definition
  const workflow = configCache.getWorkflowById(workflowId);
  if (!workflow) {
    throw new Error(`Workflow '${workflowId}' not found`);
  }
  if (workflow.enabled === false) {
    throw new Error(`Workflow '${workflowId}' is disabled`);
  }

  const workflowName = resolveLocalized(workflow.name, language);

  // 2. Phase 1 restriction: reject workflows with human nodes
  const humanNodes = (workflow.nodes || []).filter(n => n.type === 'human');
  if (humanNodes.length > 0) {
    return {
      status: 'error',
      error: `Workflow '${workflowName}' contains human checkpoint nodes and cannot be run from chat yet. This will be supported in a future update.`
    };
  }

  // 3. Prepare initial data from input variables
  const initialData = {
    input: input || '',
    ...extraInputVars,
    _workflowDefinition: workflow
  };

  // Pass chat-selected model as override so agent nodes use it
  if (modelId) {
    initialData._modelOverride = modelId;
  }

  // Map generic 'input' to the workflow's primary text input variable name
  // (skip file/image variables — those are mapped from _fileData below)
  const startNode = (workflow.nodes || []).find(n => n.type === 'start');
  const inputVars = startNode?.config?.inputVariables;
  if (inputVars?.length > 0 && input) {
    const textVar = inputVars.find(v => v.type !== 'file' && v.type !== 'image');
    if (textVar && textVar.name !== 'input' && !initialData[textVar.name]) {
      initialData[textVar.name] = input;
    }
    // Store user text as a hint for agent context (e.g., infer analysisType)
    initialData._userHint = input;
  }

  logger.info({
    component: 'workflowRunner',
    message: 'Workflow runner invoked',
    workflowId,
    hasFileData: !!_fileData,
    fileDataFileName: _fileData?.fileName || 'none',
    hasInput: !!input,
    extraInputVarKeys: Object.keys(extraInputVars).join(', '),
    paramKeys: Object.keys(params).join(', ')
  });

  if (_chatHistory) {
    initialData._chatHistory = _chatHistory;
  }
  if (_fileData) {
    // Map file data to the workflow's declared file/image input variable
    if (inputVars?.length > 0) {
      const fileVar = inputVars.find(v => v.type === 'file' || v.type === 'image');
      if (fileVar) {
        initialData[fileVar.name] = _fileData;
      }
    }
    // Also keep under _fileData for backward compatibility
    initialData._fileData = _fileData;
  }

  // 4. Start workflow
  const engine = new WorkflowEngine();
  let state;
  try {
    state = await engine.start(workflow, initialData, { user, checkpointOnNode: true });
  } catch (error) {
    logger.error({
      component: 'workflowRunner',
      message: 'Failed to start workflow',
      workflowId,
      error: error.message
    });
    return {
      status: 'error',
      error: `Failed to start workflow: ${error.message}`
    };
  }

  const executionId = state.executionId;

  // 4b. Register execution in ExecutionRegistry so it appears in "My Executions"
  try {
    const userId = user?.id || user?.sub || user?.username || 'anonymous';
    const registry = getExecutionRegistry();
    registry.register(executionId, {
      userId,
      workflowId,
      workflowName: workflow.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      source: 'chat'
    });
  } catch (err) {
    logger.warn({
      component: 'workflowRunner',
      message: 'Failed to register execution',
      error: err.message
    });
  }

  // 5. Bridge workflow events to chat SSE channel
  if (chatId) {
    // Register for cancellation support
    activeWorkflowExecutions.set(chatId, { executionId, engine });

    const inputPreview = input
      ? `Starting: "${input.substring(0, 80)}${input.length > 80 ? '...' : ''}"`
      : 'Starting workflow...';

    actionTracker.trackWorkflowStep(chatId, {
      workflowName,
      nodeName: inputPreview,
      nodeType: 'start',
      status: 'running',
      executionId
    });
  }

  // 6. Wait for workflow completion by listening to events
  const maxExecutionTime = (workflow.config?.maxExecutionTime || 300000) + 10000;

  const result = await new Promise(resolve => {
    let settled = false;
    let timeoutId;

    const bridgeHandler = event => {
      // Only handle events from this specific workflow execution
      if (event.chatId !== executionId) return;

      const eventType = event.event;

      if (eventType === 'workflow.node.start' && chatId) {
        // Find the node's display name from the workflow definition
        const node = (workflow.nodes || []).find(n => n.id === event.nodeId);
        // Skip chat step indicator for nodes with chatVisible: false
        if (node?.config?.chatVisible === false) return;
        const nodeName = node ? resolveLocalized(node.name, language) : event.nodeId;
        const nodeType = node?.type || 'unknown';

        actionTracker.trackWorkflowStep(chatId, {
          workflowName,
          nodeName,
          nodeType,
          status: 'running',
          executionId,
          chatVisible: node?.config?.chatVisible !== false
        });
      }

      if (eventType === 'workflow.node.complete' && chatId) {
        const node = (workflow.nodes || []).find(n => n.id === event.nodeId);
        // Skip chat step indicator for nodes with chatVisible: false
        if (node?.config?.chatVisible === false) return;
        const nodeName = node ? resolveLocalized(node.name, language) : event.nodeId;
        const nodeType = node?.type || 'unknown';

        actionTracker.trackWorkflowStep(chatId, {
          workflowName,
          nodeName,
          nodeType,
          status: 'completed',
          executionId,
          chatVisible: node?.config?.chatVisible !== false
        });
      }

      if (eventType === 'workflow.complete' && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        actionTracker.off('fire-sse', bridgeHandler);
        activeWorkflowExecutions.delete(chatId);

        try {
          getExecutionRegistry().updateStatus(executionId, 'completed');
        } catch (_e) {
          /* non-fatal */
        }

        const primaryOutput = workflow.chatIntegration?.primaryOutput;
        const outputText = event.output ? extractReadableOutput(event.output, primaryOutput) : null;

        if (chatId) {
          actionTracker.trackWorkflowResult(chatId, {
            workflowName,
            status: 'completed',
            executionId,
            outputFormat: workflow.chatIntegration?.outputFormat || 'markdown'
          });

          // In passthrough mode, executePassthroughTool handles streaming.
          // In @mention / direct mode, stream the content ourselves.
          if (!passthrough && outputText) {
            actionTracker.trackChunk(chatId, { content: outputText });
            actionTracker.trackDone(chatId, { finishReason: 'stop' });
          }
        }

        // Return readable output string for passthrough (ToolExecutor streams it),
        // or full output object for @mention / non-chat callers.
        resolve(
          passthrough
            ? outputText || ''
            : {
                status: 'completed',
                executionId,
                output: event.output
              }
        );
      }

      if ((eventType === 'workflow.failed' || eventType === 'workflow.cancelled') && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        actionTracker.off('fire-sse', bridgeHandler);
        activeWorkflowExecutions.delete(chatId);

        try {
          getExecutionRegistry().updateStatus(
            executionId,
            eventType === 'workflow.cancelled' ? 'cancelled' : 'failed'
          );
        } catch (_e) {
          /* non-fatal */
        }

        const errorMsg = event.error || event.message || 'Workflow execution failed';
        const errorContent = `Workflow failed: ${errorMsg}`;

        if (chatId) {
          actionTracker.trackWorkflowResult(chatId, {
            workflowName,
            status: 'failed',
            error: errorMsg,
            executionId
          });

          // In passthrough mode, executePassthroughTool handles streaming.
          if (!passthrough) {
            actionTracker.trackChunk(chatId, { content: errorContent });
            actionTracker.trackDone(chatId, { finishReason: 'error' });
          }
        }

        resolve(
          passthrough
            ? errorContent
            : {
                status: 'failed',
                executionId,
                error: errorMsg
              }
        );
      }
    };

    actionTracker.on('fire-sse', bridgeHandler);

    // Timeout safety net
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        actionTracker.off('fire-sse', bridgeHandler);
        activeWorkflowExecutions.delete(chatId);

        // Attempt to cancel the workflow
        engine.cancel(executionId).catch(() => {});

        if (chatId) {
          actionTracker.trackWorkflowResult(chatId, {
            workflowName,
            status: 'failed',
            error: 'Workflow execution timed out',
            executionId
          });
        }

        resolve({
          status: 'failed',
          executionId,
          error: 'Workflow execution timed out'
        });
      }
    }, maxExecutionTime);
  });

  logger.info({
    component: 'workflowRunner',
    message: 'Workflow execution finished',
    workflowId,
    executionId,
    status: result.status
  });

  return result;
}
