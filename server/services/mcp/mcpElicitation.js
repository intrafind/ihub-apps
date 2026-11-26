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
 * Both modes are declared. Form mode asks for values in the card. URL mode
 * shows the page the server names (a sign-in, a payment) with its address;
 * the person opens it in their own browser and answers Done when finished
 * there, which answers `accept`. iHub never fetches the page, and shows only
 * `https` addresses without credentials ({@link elicitationUrl}); any other
 * is refused with `decline`.
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
const MAX_URL_LENGTH = 2048;
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
    const convert = Object.hasOwn(VALUE_CONVERTERS, field.type)
      ? VALUE_CONVERTERS[field.type]
      : VALUE_CONVERTERS.string;
    const typed = convert(value);
    if (typed !== undefined) content[name] = typed;
  }
  return content;
}

function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * A submitted value as the type its field names, one converter per type;
 * `undefined` drops the value.
 */
const VALUE_CONVERTERS = {
  number: toNumber,
  integer: value => {
    const number = toNumber(value);
    return number === undefined ? undefined : Math.trunc(number);
  },
  boolean: value => value === true || value === 'true',
  array: value => (Array.isArray(value) ? value.filter(isString) : undefined),
  string: value => String(value)
};

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
 * Wait for the answer, the turn's stop, or — for a page the person was sent
 * to — the server's notice that the person finished there.
 */
function waitForOutcome(interactionService, id, signal, completion) {
  const answer = waitForAnswerOrAbort(interactionService, id, signal);
  if (!completion) return answer;
  // Settled by the cancel below once the notice wins.
  answer.catch(() => {});
  return Promise.race([answer, completion.then(() => ({ completed: true }))]);
}

/**
 * The page a URL-mode question sends the person to, when iHub will show it:
 * `https`, no credentials in the address, at most 2048 characters. iHub never
 * fetches it; the person's browser opens it when they choose to.
 *
 * @param {*} value - The `url` the server sent
 * @returns {string|null} the normalized address
 */
export function elicitationUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href.length > MAX_URL_LENGTH ? null : url.href;
}

/** What the card shows and how an answer maps back, per mode. */
function questionFor(params, serverName) {
  const message = text(params.message, MAX_MESSAGE_LENGTH);
  const title = serverName ? { title: serverName.slice(0, 200) } : {};
  if (params.mode === 'url') {
    return {
      mode: 'url',
      url: elicitationUrl(params.url),
      prompt: {
        ...title,
        message: message || 'The server asks you to open a page.',
        inputType: 'confirm',
        options: [{ value: 'accept', label: 'Done' }],
        allowSkip: true
      },
      // The person consented and came back: nothing to send but the action.
      accepted: () => ({ action: 'accept' })
    };
  }
  const form = elicitationForm(params.requestedSchema);
  return {
    mode: 'form',
    prompt: {
      ...title,
      message: message || 'The server needs more information.',
      inputType: 'form',
      inputSchema: form,
      options: [{ value: 'accept', label: 'Submit' }],
      // Declining is a skip: it needs none of the required fields.
      allowSkip: true
    },
    accepted: answer => ({ action: 'accept', content: elicitationContent(form, answer.data) })
  };
}

/**
 * The `elicitation/create` handler of one MCP server's connection.
 *
 * Form mode asks for values; URL mode sends the person to a page of the
 * server's (a sign-in, a payment) and answers `accept` once they say they are
 * done there — or once a 2025-era server reports the page finished
 * (`notifications/elicitation/complete`, passed to `handler.complete`).
 *
 * @param {Object} params
 * @param {string} params.serverId - The installation id
 * @param {string} [params.serverName] - Its name, shown on the card
 * @param {Object} [params.interactionService]
 * @param {Object} [params.runLog]
 * @param {(chatId: string) => ({runId: string}|null)} [params.getStreamRun]
 * @param {() => (Object|null)} [params.soleCall] - The scope of the one call
 *   running on the connection, when exactly one is
 * @returns {((request: Object) => Promise<{action: 'accept'|'decline'|'cancel', content?: Object}>) & {complete: (elicitationId: string) => boolean}}
 */
export function createElicitationHandler({
  serverId,
  serverName,
  interactionService = defaultInteractionService,
  runLog = defaultRunLog,
  getStreamRun = defaultGetStreamRun,
  soleCall = () => null
}) {
  /** URL-mode questions waiting, by the server's `elicitationId`. */
  const completions = new Map();

  /**
   * The call a question belongs to: the scope it arrived in, else — for a
   * 2025-era server that sends it outside the call (on the session's own
   * stream, as `server.elicitInput()` does) — the one call running on this
   * connection, if there is exactly one.
   */
  function currentCall() {
    return scope.getStore() || soleCall() || undefined;
  }

  /** The call's chat run, when a person in a chat can answer; else null. */
  function answerableCall() {
    const call = currentCall();
    const parent = call?.chatId ? getStreamRun(call.chatId) : null;
    if (!parent?.runId || !call.user || isAnonymousUser(call.user)) return null;
    return { call, parent };
  }

  async function principalOf(call, parent) {
    // Whoever owns the chat run may answer: its ledger principal, else the
    // user's own (the answer endpoint authorizes by it).
    const runMeta = runLog.getRunMeta?.(parent.runId) || null;
    return runMeta?.principalId
      ? { id: runMeta.principalId, mode: runMeta.identityMode }
      : resolvePrincipal(call.user);
  }

  async function raise({ call, parent, question, id, runId }) {
    const principal = await principalOf(call, parent);
    const toolId = call.toolId ? { toolId: String(call.toolId).slice(0, 400) } : {};
    return interactionService.raise({
      id,
      runId,
      kind: 'question',
      origin: 'tool',
      prompt: question.prompt,
      policy: {
        timeoutMs: ELICITATION_ANSWER_TIMEOUT_MS,
        onTimeout: 'fail',
        fallback: 'deny'
      },
      source: {
        // Answered by its id on the runs endpoint (`source.mcpElicitation`
        // keeps it out of the `ask_user` and workflow-checkpoint paths).
        // No `checkpointId` / `executionId`: no workflow execution waits on it.
        chatId: call.chatId,
        ...toolId,
        mcpElicitation: {
          serverId: String(serverId).slice(0, 200),
          ...(serverName ? { serverName: serverName.slice(0, 200) } : {}),
          ...toolId,
          mode: question.mode,
          ...(question.url ? { url: question.url } : {})
        },
        ...(principal?.id ? { principalId: String(principal.id) } : {}),
        ...(principal?.mode ? { identityMode: principal.mode } : {})
      }
    });
  }

  /** The person's answer (or its absence) as the MCP result. */
  async function outcome({ call, question, id, completion }) {
    try {
      const answered = await waitForOutcome(interactionService, id, call.signal, completion);
      if (answered?.completed) {
        await interactionService.cancel(id, 'completed').catch(() => {});
        return { action: 'accept' };
      }
      const answer = answered?.answer || {};
      if (answer.skipped || answer.value !== 'accept') return { action: 'decline' };
      return question.accepted(answer);
    } catch (error) {
      if (error?.code === 'ABORTED') {
        await interactionService.cancel(id, 'aborted').catch(() => {});
      }
      return { action: 'cancel' };
    }
  }

  async function handleElicitation(request) {
    const params = request?.params || {};
    const context = answerableCall();
    const question = questionFor(params, serverName);
    if (!context || (question.mode === 'url' && !question.url)) {
      logger.info('MCP server asked a question iHub cannot put to anyone here', {
        component: COMPONENT,
        serverId,
        mode: question.mode,
        reason: context ? 'unsafe_url' : 'no_person',
        chatId: currentCall()?.chatId || null
      });
      // A page iHub will not show is a refusal; nobody to ask is a dismissal.
      return { action: context ? 'decline' : 'cancel' };
    }

    const { call, parent } = context;
    const runId = newRunId('chat');
    const id = `elicit-${randomUUID()}`;
    const elicitationId = question.mode === 'url' && text(params.elicitationId, 400);
    const completion = elicitationId
      ? new Promise(resolve => completions.set(elicitationId, resolve))
      : null;
    try {
      const interaction = await raise({ call, parent, question, id, runId });
      const stream = new RunStreamEmitter({ streamId: call.chatId, runId });
      stream.emit(SSE_V2_EVENTS.RUN_STARTED, {
        kind: 'chat',
        parentRunId: parent.runId,
        refs: { chatId: call.chatId }
      });
      stream.emit(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction });
      stream.emit(SSE_V2_EVENTS.RUN_PAUSED, { reason: 'interaction', interactionId: id });
      logger.info('MCP server asked the chat user a question', {
        component: COMPONENT,
        serverId,
        chatId: call.chatId,
        interactionId: id,
        mode: question.mode,
        ...(question.url ? { host: new URL(question.url).host } : {})
      });

      call.onWaitStart?.();
      let result;
      try {
        result = await outcome({ call, question, id, completion });
      } finally {
        call.onWaitEnd?.();
      }
      if (result.action !== 'cancel') stream.emit(SSE_V2_EVENTS.RUN_RESUMED, { interactionId: id });
      stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
        status: result.action === 'cancel' ? 'aborted' : 'completed',
        finishReason: `elicitation_${result.action}`
      });
      logger.info('MCP server question answered', {
        component: COMPONENT,
        serverId,
        chatId: call.chatId,
        interactionId: id,
        action: result.action
      });
      return result;
    } finally {
      if (elicitationId) completions.delete(elicitationId);
    }
  }

  /**
   * The server reports that the person finished on the page of a URL-mode
   * question (`notifications/elicitation/complete`, 2025-era servers).
   *
   * @param {string} elicitationId
   * @returns {boolean} whether a waiting question was finished
   */
  handleElicitation.complete = elicitationId => {
    const done = typeof elicitationId === 'string' && completions.get(elicitationId);
    if (!done) return false;
    completions.delete(elicitationId);
    done();
    return true;
  };

  return handleElicitation;
}
