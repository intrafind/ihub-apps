// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * MCP elicitation on the outbound client: a connected MCP server asks the chat
 * user a question in the middle of a tool call ("Create the paid project for
 * $25/month?", "Type the repository name to delete it"), and the call goes on
 * with the answer.
 *
 * How the question reaches the person:
 *
 * 1. Every `tools/call` runs inside an {@link runWithElicitationScope elicitation
 *    scope} that names the chat, the user and the turn's abort signal. The
 *    connection is shared by many users, so this scope — an AsyncLocalStorage
 *    that the SDK's request handlers inherit, on 2025-era sessions and on
 *    2026-07-28 multi-round calls alike — is how a question finds its chat.
 * 2. The SDK calls the handler {@link createElicitationHandler} builds. It
 *    raises a `question` interaction on a child run of the chat run in flight
 *    and announces it on the chat's stream (`run/started` with the chat run as
 *    parent, `interaction/raised`, `run/paused`), as a chat-launched workflow
 *    does for its checkpoints. The chat shows a form card; the turn keeps
 *    streaming while the tool call waits.
 * 3. The person answers through `POST /api/runs/:runId/interactions/:id/answer`.
 *    Submit answers `{ value: 'accept', data }`, Decline answers
 *    `{ skipped: true }`. The handler maps the answer to the MCP result
 *    (`accept` with the content, `decline`) and closes the child run; a stop
 *    of the turn, an expired or cancelled question answers `cancel`.
 *
 * Without a person to ask — no chat turn streaming (a workflow, a scheduled
 * run, the gateway, the API) or an anonymous user — the answer is `cancel`
 * right away, as the specification has it for a dismissed request.
 *
 * Only form mode is declared: URL mode would send the person to a page the
 * server names, and is refused with `decline` should a server send it anyway.
 *
 * @module services/mcp/mcpElicitation
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import defaultInteractionService from '../loop/InteractionService.js';
import defaultRunLog, { newRunId } from '../loop/RunLog.js';
import { RunStreamEmitter, getStreamRun as defaultGetStreamRun } from '../loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { isAnonymousUser, resolvePrincipal } from '../loop/runIdentity.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpElicitation';

/** How long a person has to answer a server's question. */
export const ELICITATION_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/** Most fields a server's form may have; the rest are left out. */
const MAX_FIELDS = 30;
const MAX_MESSAGE_LENGTH = 4000;
const STRING_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

const scope = new AsyncLocalStorage();

/**
 * Run a tool call with what its server's questions need to reach the person.
 *
 * @param {Object} context
 * @param {string} [context.chatId] - The chat the call belongs to
 * @param {Object} [context.user] - The user the call runs for
 * @param {string} [context.toolId] - The iHub tool id, for the card
 * @param {AbortSignal} [context.signal] - The turn's abort signal
 * @param {() => void} [context.onWaitStart] - The call waits for a person (pause timers)
 * @param {() => void} [context.onWaitEnd] - The person answered (resume timers)
 * @param {Function} fn
 * @returns {*} what `fn` returns
 */
export function runWithElicitationScope(context, fn) {
  return scope.run(context || {}, fn);
}

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The choices of an enum field: `enum` (+ legacy `enumNames`), or `oneOf`/`anyOf` of `{ const, title }`. */
function enumChoices(node) {
  if (Array.isArray(node.enum) && node.enum.every(v => typeof v === 'string')) {
    const names = Array.isArray(node.enumNames) ? node.enumNames : [];
    return node.enum.map((value, i) => ({
      value,
      label: typeof names[i] === 'string' ? names[i] : value
    }));
  }
  const titled = Array.isArray(node.oneOf) ? node.oneOf : node.anyOf;
  if (Array.isArray(titled) && titled.every(o => o && typeof o.const === 'string')) {
    return titled.map(o => ({
      value: o.const,
      label: typeof o.title === 'string' ? o.title : o.const
    }));
  }
  return null;
}

/** The keys of `node` among `keys` that hold a finite number. */
function finiteKeys(node, keys) {
  return Object.fromEntries(
    keys.filter(key => finite(node[key]) !== undefined).map(key => [key, node[key]])
  );
}

/** `{ default }` when `node.default` passes `valid`, else nothing. */
function defaultOf(node, valid) {
  return valid(node.default) ? { default: node.default } : {};
}

const isString = value => typeof value === 'string';

function stringField(node, common) {
  const choices = enumChoices(node);
  if (choices) {
    return {
      type: 'string',
      ...common,
      oneOf: choices.map(c => ({ const: c.value, title: c.label })),
      ...defaultOf(node, isString)
    };
  }
  return {
    type: 'string',
    ...common,
    ...(STRING_FORMATS.has(node.format) ? { format: node.format } : {}),
    ...finiteKeys(node, ['minLength', 'maxLength']),
    ...defaultOf(node, isString)
  };
}

function numberField(node, common) {
  return {
    type: node.type,
    ...common,
    ...finiteKeys(node, ['minimum', 'maximum']),
    ...defaultOf(node, value => finite(value) !== undefined)
  };
}

function booleanField(node, common) {
  return { type: 'boolean', ...common, ...defaultOf(node, value => typeof value === 'boolean') };
}

function arrayField(node, common) {
  const choices = node.items && typeof node.items === 'object' ? enumChoices(node.items) : null;
  if (!choices) return null;
  return {
    type: 'array',
    ...common,
    items: { type: 'string', oneOf: choices.map(c => ({ const: c.value, title: c.label })) },
    ...finiteKeys(node, ['minItems', 'maxItems']),
    ...(Array.isArray(node.default) ? { default: node.default.filter(isString) } : {})
  };
}

const FIELD_BUILDERS = {
  string: stringField,
  number: numberField,
  integer: numberField,
  boolean: booleanField,
  array: arrayField
};

/**
 * One field of the form, reduced to what MCP elicitation allows (a flat
 * object of primitives: text, number, integer, boolean, a single choice, a
 * multiple choice). Anything else is left out.
 *
 * @param {Object} node - The field's schema as the server sent it
 * @returns {Object|null}
 */
function formField(node) {
  if (!node || typeof node !== 'object' || !Object.hasOwn(FIELD_BUILDERS, node.type)) return null;
  const title = text(node.title, 200);
  const description = text(node.description, 1000);
  const common = { ...(title ? { title } : {}), ...(description ? { description } : {}) };
  return FIELD_BUILDERS[node.type](node, common);
}

/**
 * The form the chat shows for a server's `requestedSchema`.
 *
 * @param {Object} requestedSchema
 * @returns {{type: 'object', properties: Object, required: string[]}}
 */
export function elicitationForm(requestedSchema) {
  const properties = {};
  const source =
    requestedSchema && typeof requestedSchema.properties === 'object'
      ? requestedSchema.properties
      : {};
  for (const [name, node] of Object.entries(source).slice(0, MAX_FIELDS)) {
    const field = formField(node);
    if (field) properties[name] = field;
  }
  const required = Array.isArray(requestedSchema?.required)
    ? requestedSchema.required.filter(name => typeof name === 'string' && name in properties)
    : [];
  return { type: 'object', properties, required };
}

/**
 * The content of an `accept` answer: the form's fields only, each as the type
 * its schema names (a number typed into a text box arrives as a string).
 *
 * @param {Object} form - From {@link elicitationForm}
 * @param {Object} data - The submitted values
 * @returns {Object<string, string|number|boolean|string[]>}
 */
export function elicitationContent(form, data) {
  const content = {};
  const values = data && typeof data === 'object' ? data : {};
  for (const [name, field] of Object.entries(form.properties)) {
    const value = values[name];
    if (value === undefined || value === null || value === '') continue;
    const typed = typedValue(field.type, value);
    if (typed !== undefined) content[name] = typed;
  }
  return content;
}

/** A submitted value as the type its field names; `undefined` drops it. */
function typedValue(type, value) {
  if (type === 'number' || type === 'integer') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return undefined;
    return type === 'integer' ? Math.trunc(number) : number;
  }
  if (type === 'boolean') return value === true || value === 'true';
  if (type === 'array') return Array.isArray(value) ? value.filter(isString) : undefined;
  return String(value);
}

/** Wait for the answer, or for the turn to stop. */
function waitForAnswerOrAbort(interactionService, id, signal) {
  const answer = interactionService.waitForAnswer(id, { timeoutMs: ELICITATION_ANSWER_TIMEOUT_MS });
  if (!signal) return answer;
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(Object.assign(new Error('The turn was stopped'), { code: 'ABORTED' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    answer.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * The `elicitation/create` handler of one MCP server's connection.
 *
 * @param {Object} params
 * @param {string} params.serverId - The installation id
 * @param {string} [params.serverName] - Its name, shown on the card
 * @param {Object} [params.interactionService]
 * @param {Object} [params.runLog]
 * @param {(chatId: string) => ({runId: string}|null)} [params.getStreamRun]
 * @returns {(request: Object) => Promise<{action: 'accept'|'decline'|'cancel', content?: Object}>}
 */
export function createElicitationHandler({
  serverId,
  serverName,
  interactionService = defaultInteractionService,
  runLog = defaultRunLog,
  getStreamRun = defaultGetStreamRun
}) {
  return async function handleElicitation(request) {
    const params = request?.params || {};
    if (params.mode === 'url') return { action: 'decline' };

    const call = scope.getStore();
    const chatId = call?.chatId;
    const parent = chatId ? getStreamRun(chatId) : null;
    if (!parent?.runId || !call.user || isAnonymousUser(call.user)) {
      logger.info('MCP server asked a question nobody can answer here; cancelled', {
        component: COMPONENT,
        serverId,
        chatId: chatId || null
      });
      return { action: 'cancel' };
    }

    const form = elicitationForm(params.requestedSchema);
    const runId = newRunId('chat');
    const id = `elicit-${randomUUID()}`;
    // Whoever owns the chat run may answer: its ledger principal, else the
    // user's own (the answer endpoint authorizes by it).
    const runMeta = runLog.getRunMeta?.(parent.runId) || null;
    const principal = runMeta?.principalId
      ? { id: runMeta.principalId, mode: runMeta.identityMode }
      : await resolvePrincipal(call.user);
    const interaction = await interactionService.raise({
      id,
      runId,
      kind: 'question',
      origin: 'tool',
      prompt: {
        ...(serverName ? { title: serverName.slice(0, 200) } : {}),
        message: text(params.message, MAX_MESSAGE_LENGTH) || 'The server needs more information.',
        inputType: 'form',
        inputSchema: form,
        options: [{ value: 'accept', label: 'Submit' }],
        // Declining is a skip: it needs none of the required fields.
        allowSkip: true
      },
      policy: {
        timeoutMs: ELICITATION_ANSWER_TIMEOUT_MS,
        onTimeout: 'fail',
        fallback: 'deny'
      },
      source: {
        chatId,
        // A checkpoint of its own child run: answered by its id on the runs
        // endpoint, not by the next chat message as an `ask_user` question.
        checkpointId: id,
        executionId: runId,
        ...(call.toolId ? { toolId: String(call.toolId).slice(0, 400) } : {}),
        mcpElicitation: {
          serverId: String(serverId).slice(0, 200),
          ...(serverName ? { serverName: serverName.slice(0, 200) } : {}),
          ...(call.toolId ? { toolId: String(call.toolId).slice(0, 400) } : {})
        },
        ...(principal?.id ? { principalId: String(principal.id) } : {}),
        ...(principal?.mode ? { identityMode: principal.mode } : {})
      }
    });

    const stream = new RunStreamEmitter({ streamId: chatId, runId });
    stream.emit(SSE_V2_EVENTS.RUN_STARTED, {
      kind: 'chat',
      parentRunId: parent.runId,
      refs: { chatId }
    });
    stream.emit(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction });
    stream.emit(SSE_V2_EVENTS.RUN_PAUSED, { reason: 'interaction', interactionId: id });
    logger.info('MCP server asked the chat user a question', {
      component: COMPONENT,
      serverId,
      chatId,
      interactionId: id
    });

    call.onWaitStart?.();
    let result;
    let ended;
    try {
      const answered = await waitForAnswerOrAbort(interactionService, id, call.signal);
      const answer = answered?.answer || {};
      stream.emit(SSE_V2_EVENTS.RUN_RESUMED, { interactionId: id });
      if (answer.skipped || answer.value !== 'accept') {
        result = { action: 'decline' };
      } else {
        result = { action: 'accept', content: elicitationContent(form, answer.data) };
      }
      ended = { status: 'completed', finishReason: `elicitation_${result.action}` };
    } catch (error) {
      if (error?.code === 'ABORTED') {
        await interactionService.cancel(id, 'aborted').catch(() => {});
      }
      result = { action: 'cancel' };
      ended = { status: 'aborted', finishReason: 'elicitation_cancel' };
    } finally {
      call.onWaitEnd?.();
    }
    stream.emit(SSE_V2_EVENTS.RUN_ENDED, ended);
    logger.info('MCP server question answered', {
      component: COMPONENT,
      serverId,
      chatId,
      interactionId: id,
      action: result.action
    });
    return result;
  };
}
