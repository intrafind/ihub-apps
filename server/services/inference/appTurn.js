/**
 * An app turn of the inference API — `model: "app:<appId>[/<modelId>]"`.
 *
 * The app runs exactly as it does in the chat UI: the same
 * `ChatService.prepareChatRequest` (system prompt, sources, skills, tools,
 * model resolution) and the same `ChatService.runTurn` on the shared agent
 * loop, with its tools executed on the server. What the API adds:
 *
 *   - the prompt template comes from the app config, never from the caller,
 *     and is applied only to the turn that should carry it (see
 *     {@link turnPrompt});
 *   - the turn is headless (nobody can answer a clarification) and its frames
 *     go to the caller's own emitter instead of a browser's SSE stream;
 *   - the app's `outputSchema` is validated server-side, with one corrected
 *     attempt inside the run.
 *
 * @module services/inference/appTurn
 */
import crypto from 'node:crypto';
import { withAppPrompt } from '../chat/ChatService.js';
import { recordStructuredOutputValidation } from '../../telemetry/metrics.js';
import { isLLMError } from '../loop/contracts/errors.js';
import { InferenceApiError, fromLLMError } from './errors.js';
import { appModelLabel } from './modelIdentifier.js';
import {
  appOutputFormat,
  assertStructuredOutputSupported,
  createOutputValidator,
  outputValidationError
} from './structuredOutput.js';

/**
 * Where the template and variables of this turn go.
 *
 * The user-message template wraps the turn that carries it: the first turn of
 * a conversation (and every stateless call) always; a follow-up only when it
 * sends `prompt.variables` — otherwise the earlier rendered turns in the
 * history already carry them, and the new input goes to the model as it is.
 *
 * The system prompt is rebuilt on every call from the app config, and apps
 * reference variables there too (`ifinder-document-actions` needs its
 * `{{document-id}}` on every follow-up), so it gets the variables of the most
 * recent turn that set them.
 *
 * @param {Object} options
 * @param {boolean} options.firstTurn - No earlier turn in this conversation.
 * @param {{provided: boolean, variables: Object}} options.resolved - This turn's
 *   `prompt.variables` (with defaults).
 * @param {Object|null} [options.stored] - The variable set a conversation last used.
 * @param {boolean} [options.historyReplayed=true] - Whether earlier turns are sent to the
 *   model. An app with `sendChatHistory: false` answers every turn on its own, so nothing
 *   carries the earlier rendering and the template wraps every turn.
 * @returns {{applyTemplate: boolean, variables: Object, storeVariables: boolean}}
 *   `storeVariables`: this turn's variables become the conversation's set.
 */
export function turnPrompt({ firstTurn, resolved, stored = null, historyReplayed = true }) {
  if (firstTurn || resolved.provided) {
    return { applyTemplate: true, variables: resolved.variables, storeVariables: true };
  }
  return {
    applyTemplate: !historyReplayed,
    // Stored set first, then the defaults for anything it lacks (a variable
    // the app gained since).
    variables: { ...resolved.variables, ...(stored || {}) },
    storeVariables: false
  };
}

/** HTTP status for a `prepareChatRequest` failure code. */
function prepStatus(code) {
  if (code === 'APP_NOT_FOUND' || code === 'MODEL_NOT_FOUND') return 404;
  if (code === 'modelAccessDeniedForUser') return 403;
  if (
    code === 'noModelsAvailable' ||
    code === 'noCompatibleModels' ||
    code === 'noModelIdProvided' ||
    code === 'noModelsForUser'
  ) {
    return 400;
  }
  return 500;
}

/**
 * Prepare an app turn: messages, template, model, tools — everything up to
 * the model call. Nothing is stored or emitted, so every refusal here can
 * still be a plain HTTP error.
 *
 * @param {Object} options
 * @param {import('../chat/ChatService.js').default} options.chatService
 * @param {{app: Object, modelId: string|null}} options.target - Resolved app target.
 * @param {Object} options.user
 * @param {string} options.language
 * @param {Array} options.messages - Chat messages, the current user turn last.
 * @param {boolean} options.applyTemplate - Wrap the current turn in the app template.
 * @param {Object} options.variables - Variables for the template and the system prompt.
 * @param {string} options.chatId
 * @param {number} [options.temperature]
 * @param {number} [options.maxOutputTokens] - Caller's cap; the model's own cap still applies.
 * @returns {Promise<{prep: Object, app: Object, model: Object, label: string,
 *   format: Object|null, renderedContent: string}>}
 * @throws {InferenceApiError}
 */
export async function prepareAppTurn({
  chatService,
  target,
  user,
  language,
  messages,
  applyTemplate,
  variables,
  chatId,
  temperature,
  maxOutputTokens
}) {
  const { app } = target;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    throw new InferenceApiError(400, 'invalid_input', 'The last message must be a user message', {
      param: 'input'
    });
  }
  const promptMessages = withAppPrompt(
    messages,
    variables,
    applyTemplate ? app.prompt || null : null
  );
  let result;
  try {
    result = await chatService.prepareChatRequest({
      appId: app.id,
      modelId: target.modelId || undefined,
      messages: promptMessages,
      temperature,
      language,
      user,
      chatId
    });
  } catch (error) {
    throw fromLLMError(error);
  }
  if (!result.success) {
    const code = String(result.error?.code || 'REQUEST_PREPARATION_FAILED');
    if (isLLMError(result.error)) throw fromLLMError(result.error);
    throw new InferenceApiError(
      prepStatus(code),
      code,
      result.error?.message || 'The app request could not be prepared',
      { param: 'model' }
    );
  }
  const prep = result.data;
  const format = appOutputFormat(app);
  const label = appModelLabel(app.id, prep.model.id);
  // An explicit model was checked by the resolver; the default one only now.
  if (!target.modelId) assertStructuredOutputSupported(prep.model, format, label);
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    prep.maxTokens = Math.min(maxOutputTokens, prep.maxTokens || maxOutputTokens);
  }
  const renderedUser = [...prep.llmMessages].reverse().find(message => message.role === 'user');
  return {
    prep,
    app,
    model: prep.model,
    label,
    format,
    renderedContent: typeof renderedUser?.content === 'string' ? renderedUser.content : ''
  };
}

/**
 * Run a prepared app turn.
 *
 * @param {Object} options
 * @param {import('../chat/ChatService.js').default} options.chatService
 * @param {Object} options.prepared - {@link prepareAppTurn}'s result.
 * @param {string} options.chatId
 * @param {string} options.runId
 * @param {Object} options.user
 * @param {string} options.language
 * @param {boolean} options.validate - Check the app's output schema.
 * @param {number} [options.maxRetries=1] - Corrected attempts after an invalid answer.
 * @param {import('../loop/RunStream.js').RunStreamEmitter} options.emitter - Receives the frames.
 * @param {Function} [options.onAttemptRejected]
 * @param {Object|null} [options.persistence] - `runTurn`'s persistence context.
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.getLocalizedError]
 * @returns {Promise<Object>} `runTurn`'s summary.
 */
export async function executeAppTurn({
  chatService,
  prepared,
  chatId,
  runId,
  user,
  language,
  validate,
  maxRetries = 1,
  emitter,
  onAttemptRejected = null,
  persistence = null,
  timeoutMs,
  getLocalizedError
}) {
  const { prep, app, model, format } = prepared;
  const checked = validate && format;
  const structuredOutput = checked
    ? { validate: createOutputValidator(format), maxRetries, onAttemptRejected }
    : null;
  const messageId = crypto.randomUUID();
  const buildLogData = (streaming, extra = {}) => ({
    messageId,
    appId: app.id,
    modelId: model?.id,
    sessionId: chatId,
    user,
    messages: prep.llmMessages,
    options: { temperature: prep.temperature, language, streaming, source: 'inference-api' },
    ...extra
  });
  await chatService.logInteraction('chat_request', buildLogData(true));
  const outcome = await chatService.runTurn({
    prep,
    chatId,
    messageId,
    streaming: true,
    emitter,
    headless: true,
    buildLogData,
    timeoutMs,
    getLocalizedError,
    language,
    user,
    runId,
    persistence,
    structuredOutput
  });
  if (format) {
    const verdict = outcome.structuredOutput;
    recordStructuredOutputValidation(
      !checked
        ? 'skipped'
        : verdict?.valid
          ? verdict.attempts > 1
            ? 'valid_after_retry'
            : 'valid'
          : verdict
            ? 'invalid'
            : 'not_reached',
      {
        'structured_output.source': format.source,
        'app.id': app.id,
        'gen_ai.request.model': model?.id
      }
    );
  }
  return outcome;
}

/**
 * The error of an app turn that did not complete.
 *
 * @param {Object} outcome - `runTurn`'s summary.
 * @returns {InferenceApiError}
 */
export function appTurnError(outcome) {
  if (outcome.errorInfo?.code === 'OUTPUT_VALIDATION_FAILED') {
    return outputValidationError({
      errors: outcome.structuredOutput?.errors || outcome.errorInfo.details || [],
      attempts: outcome.structuredOutput?.attempts
    });
  }
  if (outcome.status === 'aborted') {
    return new InferenceApiError(409, 'turn_aborted', 'The turn was stopped before it finished');
  }
  if (isLLMError(outcome.error)) return fromLLMError(outcome.error);
  const info = outcome.errorInfo || {};
  return new InferenceApiError(
    502,
    String(info.code || 'ERROR'),
    info.message || outcome.error?.message || 'The app did not answer'
  );
}
