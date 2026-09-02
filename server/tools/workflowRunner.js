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

import { getWorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import { recordPendingFinish, buildReplayStepsFromState } from '../services/workflow/chatBridge.js';
import { actionTracker } from '../actionTracker.js';
import {
  RunStreamEmitter,
  streamEmitter,
  bindStreamRun,
  unbindStreamRun,
  checkpointToInteraction
} from '../services/loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { hasChatClient } from '../sse.js';
import { createPresenceMap, hasRemote, publish, subscribe } from '../clusterBus.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { getLocalizedString } from '../utils/localize.js';

/**
 * Maps chatId → { executionId, engine } for active workflow executions in chat.
 *
 * A presence map: the engine object itself cannot leave this process, but its
 * membership is mirrored cluster-wide so a stop request or an SSE reconnect
 * landing on another worker can find out who is running the workflow and ask
 * that worker to act. See `server/clusterBus.js`.
 */
export const activeWorkflowExecutions = createPresenceMap('workflow');

const CANCEL_CHANNEL = 'workflow:cancel';
const REPLAY_CHANNEL = 'workflow:replay-request';

/**
 * Cancel the workflow execution bridged to a chat, wherever it is running.
 *
 * @param {string} chatId
 * @returns {Promise<boolean>} True if the workflow was cancelled here, or the
 *   request was relayed to the worker running it. False when there is nothing
 *   to cancel, and when the engine refused the cancellation — the execution is
 *   then still running, so callers must not report success.
 */
export async function cancelChatWorkflow(chatId) {
  const workflowExec = activeWorkflowExecutions.get(chatId);
  if (workflowExec) {
    try {
      await workflowExec.engine.cancel(workflowExec.executionId, 'user_cancelled');
    } catch (error) {
      logger.error('Error cancelling workflow', {
        component: 'workflowRunner',
        chatId,
        executionId: workflowExec.executionId,
        error: error.message
      });
      // Keep the registration: the execution is presumably still running, and
      // dropping it here would leave nothing for a retry or the stop route to
      // find.
      return false;
    }
    activeWorkflowExecutions.delete(chatId);
    logger.info('Cancelled workflow', {
      component: 'workflowRunner',
      executionId: workflowExec.executionId,
      chatId
    });
    return true;
  }
  if (hasRemote('workflow', chatId)) {
    publish(CANCEL_CHANNEL, { chatId }, { kind: 'workflow', key: chatId });
    return true;
  }
  return false;
}

subscribe(CANCEL_CHANNEL, ({ chatId }) => {
  if (!activeWorkflowExecutions.has(chatId)) return;
  cancelChatWorkflow(chatId).catch(error => {
    logger.error('Error cancelling workflow on behalf of another worker', {
      component: 'workflowRunner',
      chatId,
      error: error.message
    });
  });
});

/**
 * Re-emit step progress for a still-running workflow so a reconnecting chat
 * catches up on what it missed.
 *
 * When the workflow is running on another worker, ask that worker to do it
 * rather than trying to read its engine state from here: it emits through
 * `actionTracker`, and the SSE relay carries the events back to whichever
 * worker now holds the stream. Persisted workflow state is cached in-process,
 * so a remote read could also serve a stale snapshot.
 *
 * @param {string} chatId
 * @returns {Promise<number>} Number of replayed steps (0 when relayed).
 */
export async function replayChatWorkflowProgress(chatId) {
  const active = activeWorkflowExecutions.get(chatId);
  if (!active) {
    if (hasRemote('workflow', chatId))
      publish(REPLAY_CHANNEL, { chatId }, { kind: 'workflow', key: chatId });
    return 0;
  }
  if (!active.engine || !active.executionId) return 0;

  const state = await active.engine.stateManager.get(active.executionId);
  const workflow = state?.data?._workflowDefinition;
  if (!state || !workflow) return 0;

  const replayEvents = buildReplayStepsFromState(state, workflow);
  const replayStream = streamEmitter(chatId);
  replayEvents.forEach((ev, index) => {
    replayStream.emit(SSE_V2_EVENTS.PROGRESS_NODE, {
      executionId: active.executionId,
      nodeId: String(ev.nodeId || `${active.executionId}:replay:${index + 1}`),
      ...(ev.nodeName ? { nodeName: String(ev.nodeName) } : {}),
      ...(ev.nodeType ? { nodeType: String(ev.nodeType) } : {}),
      status: ev.status || 'running',
      progress: { workflowName: workflow.name, chatVisible: ev.chatVisible !== false, replay: true }
    });
  });
  if (replayEvents.length > 0) {
    logger.info('Replayed workflow steps on SSE reconnect', {
      component: 'workflowRunner',
      chatId,
      executionId: active.executionId,
      steps: replayEvents.length
    });
  }
  return replayEvents.length;
}

subscribe(REPLAY_CHANNEL, ({ chatId }) => {
  if (!activeWorkflowExecutions.has(chatId)) return;
  replayChatWorkflowProgress(chatId).catch(error => {
    logger.warn('Workflow replay on behalf of another worker failed', {
      component: 'workflowRunner',
      chatId,
      error: error.message
    });
  });
});

function resolveLocalized(value, lang = 'en') {
  return getLocalizedString(value, lang);
}

/**
 * Extract a human-readable string from workflow output.
 * If the output is already a string, return it.
 * If it's an object, look for common report/content fields.
 */
/**
 * Coerce an error-shaped value into a readable string. Workflow events may
 * carry `error` as a string, a plain {message,code,...} object, or a real
 * Error instance — direct interpolation produces `[object Object]` for the
 * latter two, which is what users see in chat. Walks common shapes to get
 * a useful message.
 */
function coerceErrorMessage(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  // Common shapes: { message }, { error: { message } }, nested details.
  if (typeof value.message === 'string' && value.message) return value.message;
  if (typeof value.error === 'string' && value.error) return value.error;
  if (value.error && typeof value.error.message === 'string') return value.error.message;
  if (value.originalError && typeof value.originalError === 'string') return value.originalError;
  if (typeof value.code === 'string' && value.code) return value.code;
  try {
    return JSON.stringify(value);
  } catch {
    return 'Unknown error';
  }
}

function getNestedField(obj, path) {
  if (!obj || !path || typeof path !== 'string') return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function extractReadableOutput(output, primaryOutput) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (typeof output !== 'object') return String(output);

  // Workflow-declared primary output field. Supports dot-notation paths
  // (e.g. "_report.markdown") so workflows can emit a structured object
  // and still expose a flat string to the chat output.
  const primaryVal = primaryOutput ? getNestedField(output, primaryOutput) : undefined;

  if (primaryVal !== undefined && primaryVal !== null) {
    if (typeof primaryVal === 'string' && primaryVal.length > 0) return primaryVal;
    if (typeof primaryVal === 'object') return JSON.stringify(primaryVal, null, 2);
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
    runId: chatRunId,
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

  // Note: workflows with human-checkpoint nodes are supported in chat. The
  // engine emits `workflow.human.required` when it pauses; the bridge below
  // forwards it as a `workflow.checkpoint` chat event so the chat UI can
  // render the prompt and POST the response to /workflows/executions/:id/respond.

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

  // Map the chat-message `input` to the workflow's first non-file/image
  // input variable. With the current input shape (files + one user text
  // slot), this picks the text slot correctly without needing an explicit
  // marker.
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

  // Build a per-file shape summary so we can diagnose missing-content issues
  // (e.g. chat resend sending file metadata without the extracted content).
  const fileDiagnostic = (() => {
    if (!_fileData) return null;
    const arr = Array.isArray(_fileData) ? _fileData : [_fileData];
    return arr.map((f, i) => ({
      index: i,
      fileName: f?.fileName || f?.name || '(no name)',
      type: f?.type,
      fileType: f?.fileType,
      hasContent: typeof f?.content === 'string' && f.content.length > 0,
      contentLength: typeof f?.content === 'string' ? f.content.length : 0,
      hasPageImages: Array.isArray(f?.pageImages) && f.pageImages.length > 0,
      pageImageCount: Array.isArray(f?.pageImages) ? f.pageImages.length : 0,
      topLevelKeys: f && typeof f === 'object' ? Object.keys(f).join(',') : null
    }));
  })();

  logger.info('Workflow runner invoked', {
    component: 'workflowRunner',
    workflowId,
    hasFileData: !!_fileData,
    fileDataCount: Array.isArray(_fileData) ? _fileData.length : _fileData ? 1 : 0,
    fileDiagnostic,
    hasInput: !!input,
    extraInputVarKeys: Object.keys(extraInputVars).join(', '),
    paramKeys: Object.keys(params).join(', ')
  });

  if (_chatHistory) {
    initialData._chatHistory = _chatHistory;
  }
  if (_fileData) {
    // Map file data to the workflow's declared file/image input variable.
    // Avoid duplicating the (often multi-MB) payload — only fall back to
    // `_fileData` when no input variable matched. With both names set, every
    // state checkpoint serialised the same files twice, contributing to the
    // 50MB state-size limit being hit on bigger uploads.
    let mappedToVar = false;
    if (inputVars?.length > 0) {
      const fileVar = inputVars.find(v => v.type === 'file' || v.type === 'image');
      if (fileVar) {
        initialData[fileVar.name] = _fileData;
        mappedToVar = true;
      }
    }
    if (!mappedToVar) {
      initialData._fileData = _fileData;
    }
  }

  // 4. Start workflow
  const engine = getWorkflowEngine();
  let state;
  try {
    // A chat-launched workflow is the run the chat stream announced: the
    // execution adopts that run id so its ledger, interactions and answer
    // endpoint all key off one id.
    state = await engine.start(workflow, initialData, {
      user,
      checkpointOnNode: true,
      ...(chatRunId ? { executionId: chatRunId } : {})
    });
  } catch (error) {
    logger.error('Failed to start workflow', {
      component: 'workflowRunner',
      workflowId,
      error
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
  } catch (error) {
    logger.warn('Failed to register execution', {
      component: 'workflowRunner',
      error
    });
  }

  // 5. Bridge workflow events to the chat's SSE v2 stream. Inside a chat
  // turn (passthrough tool) the turn's run is bound to the chat stream; for a
  // direct @mention launch the route minted the run and passed its id.
  const stream = chatId
    ? chatRunId
      ? new RunStreamEmitter({ streamId: chatId, runId: chatRunId })
      : streamEmitter(chatId)
    : null;
  let bridgeStep = 0;
  const emitStep = ({ nodeId, nodeName, nodeType, status, chatVisible }) => {
    if (!stream) return;
    bridgeStep += 1;
    stream.emit(SSE_V2_EVENTS.PROGRESS_NODE, {
      executionId,
      nodeId: String(nodeId || `${executionId}:${nodeType || 'step'}:${bridgeStep}`),
      ...(nodeName ? { nodeName: String(nodeName) } : {}),
      ...(nodeType ? { nodeType: String(nodeType) } : {}),
      status,
      progress: { workflowName, chatVisible: chatVisible !== false }
    });
  };
  const emitResult = ({ status, error, outputFormat }) => {
    if (!stream) return;
    stream.emit(SSE_V2_EVENTS.META, {
      executionId,
      extra: {
        workflow: {
          status,
          workflowName,
          outputFormat: outputFormat || 'markdown',
          ...(error ? { error: String(error) } : {})
        }
      }
    });
  };
  // Direct (@mention) launches own the chat run: they stream the answer and
  // end the run themselves. Passthrough launches leave both to the chat turn.
  const emitDirectAnswer = (text, { status, finishReason, error }) => {
    if (!stream || passthrough) return;
    if (text) stream.emit(SSE_V2_EVENTS.STEP_DELTA, { step: 0, kind: 'text', content: text });
    stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
      status,
      finishReason,
      ...(error ? { error: { message: String(error) } } : {})
    });
  };

  if (chatId && chatRunId && stream) bindStreamRun(chatId, chatRunId, stream);

  if (chatId) {
    // Register for cancellation support
    activeWorkflowExecutions.set(chatId, { executionId, engine });

    const inputPreview = input
      ? `Starting: "${input.substring(0, 80)}${input.length > 80 ? '...' : ''}"`
      : 'Starting workflow...';

    emitStep({ nodeName: inputPreview, nodeType: 'start', status: 'running' });
  }

  // 6. Wait for workflow completion by listening to events
  const maxExecutionTime = (workflow.config?.maxExecutionTime || 300000) + 10000;

  const result = await new Promise(resolve => {
    let settled = false;
    let timeoutId;
    let isPaused = false;

    // (Re-)arm the safety-net timeout. While the workflow is paused waiting
    // for human input we suspend the timer so the user can take as long as
    // they want; it re-arms once execution actually resumes.
    const armTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        actionTracker.off('fire-sse', bridgeHandler);
        activeWorkflowExecutions.delete(chatId);
        engine.cancel(executionId, 'timeout').catch(() => {});
        if (chatId) {
          emitResult({ status: 'failed', error: 'Workflow execution timed out' });
          emitDirectAnswer('Workflow failed: Workflow execution timed out', {
            status: 'error',
            finishReason: 'error',
            error: 'Workflow execution timed out'
          });
        }
        resolve({ status: 'failed', executionId, error: 'Workflow execution timed out' });
      }, maxExecutionTime);
    };

    const bridgeHandler = event => {
      // Only handle events from this specific workflow execution
      if (event.chatId !== executionId) return;

      const eventType = event.event;

      // Human checkpoint: forward to chat as a paused step + dedicated event
      // so the chat UI can render an interactive prompt. Suspend the
      // safety-net timeout; the user shouldn't be racing it.
      if (eventType === 'workflow.human.required' && chatId) {
        isPaused = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        const node = (workflow.nodes || []).find(n => n.id === event.checkpoint?.nodeId);
        const nodeName = node ? resolveLocalized(node.name, language) : event.checkpoint?.nodeId;
        emitStep({
          nodeId: event.checkpoint?.nodeId,
          nodeName,
          nodeType: 'human',
          status: 'paused',
          chatVisible: node?.config?.chatVisible !== false
        });
        if (stream) {
          const interaction = checkpointToInteraction(
            { ...event.checkpoint, nodeName },
            // The interaction belongs to the execution's run — that is the
            // run id the answer endpoint expects.
            { runId: executionId, executionId, chatId }
          );
          stream.emit(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction });
          stream.emit(SSE_V2_EVENTS.RUN_PAUSED, {
            reason: 'interaction',
            interactionId: interaction.id
          });
        }
        return;
      }

      // Workflow resumed past the checkpoint — re-arm the timeout.
      if (eventType === 'workflow.human.responded' && chatId) {
        if (isPaused) {
          isPaused = false;
          armTimeout();
        }
        stream?.emit(SSE_V2_EVENTS.RUN_RESUMED, {
          ...(event.checkpointId || event.checkpoint?.id
            ? { interactionId: String(event.checkpointId || event.checkpoint?.id) }
            : {})
        });
        return;
      }

      if (eventType === 'workflow.node.start' && chatId) {
        // Find the node's display name from the workflow definition
        const node = (workflow.nodes || []).find(n => n.id === event.nodeId);
        // Skip chat step indicator for nodes with chatVisible: false
        if (node?.config?.chatVisible === false) return;
        const nodeName = node ? resolveLocalized(node.name, language) : event.nodeId;
        const nodeType = node?.type || 'unknown';

        emitStep({
          nodeId: event.nodeId,
          nodeName,
          nodeType,
          status: 'running',
          chatVisible: node?.config?.chatVisible !== false
        });
      }

      // Bridge for in-node progress events emitted by executors that run
      // INSIDE a loop body. Loop body nodes don't go through
      // WorkflowEngine.executeNode, so no `workflow.node.start` fires for
      // them. Executors (StructuredRecord, QuoteValidator, TemplateRender) fire
      // `workflow.node.progress` with a descriptive `message`; this bridge
      // re-emits it on the chat's real chatId so the client renders it as a
      // normal workflow step. (The executor's `context.chatId` is the
      // executionId — not the chat's chatId — because workflowRunner doesn't
      // pass chatId into engine.start; that's why direct trackWorkflowStep
      // calls from inside the executor never reached the chat.)
      if (eventType === 'workflow.node.progress') {
        if (chatId) {
          // Honor the event's status so executors can emit 'running' for
          // start-of-iteration events. The chat client (useAppChat.js:198)
          // auto-completes the previous 'running' step when a new 'running'
          // step arrives — that gives a clean one-step-per-iteration UX
          // for loop bodies.
          emitStep({
            nodeName: event.message || event.nodeId || 'progress',
            nodeType: 'prompt',
            status: event.status || 'running',
            chatVisible: true
          });
        }
      }

      if (eventType === 'workflow.node.complete' && chatId) {
        const node = (workflow.nodes || []).find(n => n.id === event.nodeId);
        // Skip chat step indicator for nodes with chatVisible: false
        if (node?.config?.chatVisible === false) return;
        const nodeName = node ? resolveLocalized(node.name, language) : event.nodeId;
        const nodeType = node?.type || 'unknown';

        emitStep({
          nodeId: event.nodeId,
          nodeName,
          nodeType,
          status: 'completed',
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
          emitResult({
            status: 'completed',
            outputFormat: workflow.chatIntegration?.outputFormat || 'markdown'
          });

          // In passthrough mode the chat turn streams the answer and ends the
          // run. In @mention / direct mode we own the run.
          emitDirectAnswer(outputText, { status: 'completed', finishReason: 'stop' });

          // If the chat SSE client disconnected, stash the finish so it can be
          // delivered when the user reconnects (final output backfill).
          if (!hasChatClient(chatId)) {
            recordPendingFinish(chatId, {
              workflowName,
              executionId,
              runId: stream?.runId || null,
              status: 'completed',
              outputText,
              outputFormat: workflow.chatIntegration?.outputFormat || 'markdown',
              passthrough
            });
          }
        }

        // Return readable output string for passthrough (the chat passthrough seam streams it),
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

        const isCancelled = eventType === 'workflow.cancelled';
        const finalStatus = isCancelled ? 'cancelled' : 'failed';

        try {
          getExecutionRegistry().updateStatus(executionId, finalStatus);
        } catch (_e) {
          /* non-fatal */
        }

        const errorMsg =
          coerceErrorMessage(event.error) ||
          coerceErrorMessage(event.message) ||
          (isCancelled ? 'Workflow cancelled' : 'Workflow execution failed');
        const errorContent = isCancelled
          ? `Workflow cancelled: ${errorMsg}`
          : `Workflow failed: ${errorMsg}`;

        if (chatId) {
          emitResult({ status: finalStatus, error: errorMsg });
          emitDirectAnswer(errorContent, {
            status: isCancelled ? 'aborted' : 'error',
            finishReason: isCancelled ? 'cancelled' : 'error',
            error: errorMsg
          });

          // Stash for backfill if the chat client is no longer connected.
          if (!hasChatClient(chatId)) {
            recordPendingFinish(chatId, {
              workflowName,
              executionId,
              runId: stream?.runId || null,
              status: finalStatus,
              outputText: errorContent,
              outputFormat: 'markdown',
              errorMsg,
              isCancelled,
              passthrough
            });
          }
        }

        resolve(
          passthrough
            ? errorContent
            : {
                status: finalStatus,
                executionId,
                error: errorMsg
              }
        );
      }
    };

    actionTracker.on('fire-sse', bridgeHandler);

    // Initial arming of the safety-net timeout. armTimeout() (defined above)
    // also re-arms when the workflow resumes after a human checkpoint.
    armTimeout();
  });

  if (chatId && chatRunId) unbindStreamRun(chatId, chatRunId);

  logger.info('Workflow execution finished', {
    component: 'workflowRunner',
    workflowId,
    executionId,
    status: result.status
  });

  return result;
}
