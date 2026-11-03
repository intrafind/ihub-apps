// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { randomUUID } from 'node:crypto';
import { safeFetch } from '../mcp/safeFetch.js';
import { A2A_DEFAULT_API_KEY_HEADER } from '../../validators/a2aAgentConfigSchema.js';
import {
  A2A_ACCEPTED_OUTPUT_MODES,
  A2A_CLIENT_ERRORS,
  A2A_RESPONSE_LIMITS,
  RUNNING_TASK_STATES,
  StreamCollector,
  a2aError,
  artifactsFiles,
  artifactsText,
  buildSkillTools,
  cardApiKeyHeader,
  parseSseStream,
  partsFiles,
  partsText,
  resolveRpcEndpoint,
  statusMessageFiles,
  statusMessageText,
  validateAgentCard
} from './a2aTools.js';
import { isAllowedAgentUrl } from '../../validators/a2aAgentConfigSchema.js';
import {
  decodeBase64Capped,
  normalizeMediaType,
  plainFileName,
  storeToolOutputFile
} from '../chat/toolOutputFiles.js';
import logger from '../../utils/logger.js';
import {
  ClientCredentialsTokenCache,
  clientCredentialsBody,
  resolveSecretRefs,
  staticAuthHeaders
} from '../integrations/auth/ServiceAccountAuth.js';

/** How long a fetched Agent Card is reused before it is fetched again. */
export const CARD_TTL_MS = 10 * 60 * 1000;

/** How long a failed card fetch is remembered before the agent is tried again. */
export const CARD_RETRY_MS = 30 * 1000;

/** Consecutive card failures after which the agent is reported unhealthy. */
const UNHEALTHY_AFTER_FAILURES = 3;

/** Budget for the best-effort `tasks/cancel` after a timeout or a user stop. */
const CANCEL_TIMEOUT_MS = 10 * 1000;

/**
 * Longest an Agent Card fetch may take (headers and body), further capped by
 * the agent's `timeoutMs`. Tool discovery for every chat can wait on a card,
 * so it must never hang on an agent that accepts the connection and stalls.
 */
export const CARD_TIMEOUT_MS = 10 * 1000;

/** Longest an OAuth client-credentials token request may take. */
export const TOKEN_TIMEOUT_MS = 10 * 1000;

/** JSON-RPC error code of A2A's `TaskNotFoundError`. */
export const TASK_NOT_FOUND_RPC_CODE = -32001;

/** Output modes iHub can turn into a tool result: text, JSON, files and pictures. */
const ACCEPTED_OUTPUT_MODES = A2A_ACCEPTED_OUTPUT_MODES;

/**
 * One A2aAgentConnection talks to a single remote A2A agent over JSON-RPC 2.0:
 *
 *   - fetches and caches its Agent Card (endpoint, skills, capabilities,
 *     security schemes), through the SSRF-guarded `safeFetch`
 *   - resolves the configured auth (`apiKey` / `bearer` / `oauth` client
 *     credentials) from the credential store per request
 *   - turns the card's skills into iHub tool definitions
 *   - sends a message for a skill and waits for the answer: `message/stream`
 *     (SSE) when the card declares streaming, else `message/send` plus
 *     `tasks/get` polling, both within the agent's `timeoutMs`
 *
 * Every request goes through `safeFetch` with the file's `security` policy,
 * never follows a redirect (a 3xx is refused with `A2A_REDIRECT_REFUSED`, so
 * the SSRF check and the credential never move to an unchecked host), is
 * bounded in time and reads a bounded amount of data (`A2A_RESPONSE_LIMITS`).
 * Connections are coordinated by A2aClientManager.
 */
export class A2aAgentConnection {
  /**
   * @param {Object} agentConfig - Parsed agent config (`a2aAgentConfigSchema`)
   * @param {{allowedHosts?: string[], blockPrivateIps?: boolean}} [security]
   */
  constructor(agentConfig, security = {}) {
    this.config = agentConfig;
    this.security = security;
    this.card = null;
    this.cardFetchedAt = 0;
    this.cardFailedAt = 0;
    this.endpoint = null;
    this.toolsCache = null;
    this.skillsByToolId = new Map();
    this.lastError = null;
    this.consecutiveFailures = 0;
    this._cardPromise = null;
    /** Client-credentials tokens of `auth.type: "oauth"` (ServiceAccountAuth). */
    this._oauthTokens = new ClientCredentialsTokenCache();
  }

  /** Drop the cached card and tools so the next use fetches them again. */
  reset() {
    this.card = null;
    this.cardFetchedAt = 0;
    this.cardFailedAt = 0;
    this.endpoint = null;
    this.toolsCache = null;
    this.skillsByToolId = new Map();
    this._oauthTokens.clear();
  }

  get _fetchOptions() {
    return {
      allowHosts: this.security.allowedHosts,
      blockPrivateIps: this.security.blockPrivateIps !== false
    };
  }

  /**
   * The auth block with its `*Ref` pointers resolved to plaintext from the
   * central credential store (`valueRef` → `value`, `tokenRef` → `token`,
   * `clientSecretRef` → `clientSecret`). Secrets never touch the config file
   * and are never logged.
   */
  _resolveAuth() {
    const auth = this.config.auth;
    if (!auth || auth.type === 'none') return { type: 'none' };
    return resolveSecretRefs(
      auth,
      { valueRef: 'value', tokenRef: 'token', clientSecretRef: 'clientSecret' },
      {
        onError: (refField, err) =>
          logger.error('Failed to resolve A2A agent auth secret from credential store', {
            component: 'A2aAgentConnection',
            agentId: this.config.id,
            field: refField,
            error: err.message
          })
      }
    );
  }

  /**
   * The header name an `apiKey` auth block uses: the configured one, else the
   * one the card's `apiKey` security scheme names, else `X-API-Key`.
   */
  _apiKeyHeaderName(auth) {
    return auth.headerName || cardApiKeyHeader(this.card) || A2A_DEFAULT_API_KEY_HEADER;
  }

  /**
   * The auth headers for one request. An OAuth client-credentials token is
   * fetched through `safeFetch` and cached until shortly before it expires.
   * @returns {Promise<Object<string, string>>}
   */
  async _authHeaders({ signal } = {}) {
    const auth = this._resolveAuth();
    if (auth.type === 'oauth') {
      return { Authorization: `Bearer ${await this._oauthAccessToken(auth, { signal })}` };
    }
    if (auth.type !== 'apiKey' && auth.type !== 'bearer') return {};
    return staticAuthHeaders(auth, { apiKeyHeader: this._apiKeyHeaderName(auth) });
  }

  /**
   * An OAuth client-credentials access token, cached until shortly before it
   * expires. The token request does not follow redirects (the client secret
   * would travel along) and gives up after `TOKEN_TIMEOUT_MS`.
   *
   * @param {Object} auth - Resolved `oauth` auth block
   * @param {{signal?: AbortSignal}} [options] - The calling request's signal
   * @returns {Promise<string>}
   * @throws {Error} `A2A_AUTH_FAILED`, `A2A_REDIRECT_REFUSED`, `A2A_RESPONSE_TOO_LARGE`
   */
  async _oauthAccessToken(auth, { signal } = {}) {
    return this._oauthTokens.getToken('client-credentials', () =>
      this._requestOAuthToken(auth, { signal })
    );
  }

  /**
   * One client-credentials token request, bounded and without redirects.
   * @returns {Promise<{access_token: string, expires_in?: number}>}
   */
  async _requestOAuthToken(auth, { signal } = {}) {
    const body = clientCredentialsBody({
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      scope: auth.scope
    });
    const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
    let data;
    try {
      const resp = await safeFetch(
        auth.tokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        },
        this._fetchOptions
      );
      refuseRedirect(resp, `The OAuth token endpoint ${auth.tokenUrl}`);
      if (!resp.ok) {
        await discardBody(resp);
        throw a2aError(
          A2A_CLIENT_ERRORS.AUTH_FAILED,
          `OAuth token request to ${auth.tokenUrl} failed: HTTP ${resp.status}`
        );
      }
      const text = await readTextLimited(
        resp,
        A2A_RESPONSE_LIMITS.jsonBytes,
        'The OAuth token response'
      );
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) {
        throw a2aError(
          A2A_CLIENT_ERRORS.AUTH_FAILED,
          `OAuth token request to ${auth.tokenUrl} did not finish within ${TOKEN_TIMEOUT_MS} ms`
        );
      }
      throw err;
    }
    if (!data?.access_token) {
      throw a2aError(A2A_CLIENT_ERRORS.AUTH_FAILED, 'OAuth token response missing access_token');
    }
    return data;
  }

  /**
   * One HTTP request to the agent through the SSRF guard, with auth headers.
   * Redirects are never followed: a 3xx is refused (`A2A_REDIRECT_REFUSED`)
   * because following it would skip the SSRF check for the new host (an IP
   * literal is not even resolved) and hand it the credential and the body.
   * A 401/403 is reported as `A2A_AUTH_FAILED`.
   *
   * @param {string} url
   * @param {Object} init - fetch init (method, headers, body)
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Response>}
   */
  async _request(url, init = {}, { signal } = {}) {
    const headers = new Headers(init.headers || {});
    for (const [name, value] of Object.entries(await this._authHeaders({ signal }))) {
      headers.set(name, value);
    }
    const resp = await safeFetch(
      url,
      {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        redirect: 'manual',
        ...(signal ? { signal } : {})
      },
      this._fetchOptions
    );
    refuseRedirect(resp, `Agent ${this.config.id}`);
    if (resp.status === 401 || resp.status === 403) {
      await discardBody(resp);
      throw a2aError(
        A2A_CLIENT_ERRORS.AUTH_FAILED,
        `Agent ${this.config.id} refused the credentials (HTTP ${resp.status})`
      );
    }
    return resp;
  }

  /**
   * The agent's Agent Card, fetched at most every `CARD_TTL_MS` (or on
   * `force`). A failed fetch is not retried for `CARD_RETRY_MS`, so a dead
   * agent does not delay every chat turn. One fetch takes at most
   * `min(timeoutMs, CARD_TIMEOUT_MS)`; concurrent callers share it.
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<Object>}
   */
  async getCard({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.card && now - this.cardFetchedAt < CARD_TTL_MS) return this.card;
    if (!force && !this.card && this.lastError && now - this.cardFailedAt < CARD_RETRY_MS) {
      throw a2aError(
        A2A_CLIENT_ERRORS.HTTP_ERROR,
        `Agent ${this.config.id} is unavailable: ${this.lastError}`
      );
    }
    if (this._cardPromise) return this._cardPromise;

    this._cardPromise = (async () => {
      const budgetMs = Math.min(this.config.timeoutMs ?? CARD_TIMEOUT_MS, CARD_TIMEOUT_MS);
      const signal = AbortSignal.timeout(budgetMs);
      try {
        let raw;
        try {
          const resp = await this._request(
            this.config.cardUrl,
            { method: 'GET', headers: { Accept: 'application/json' } },
            { signal }
          );
          if (!resp.ok) {
            await discardBody(resp);
            throw a2aError(
              A2A_CLIENT_ERRORS.HTTP_ERROR,
              `Agent Card request to ${this.config.cardUrl} failed: HTTP ${resp.status}`
            );
          }
          const text = await readTextLimited(resp, A2A_RESPONSE_LIMITS.cardBytes, 'The Agent Card');
          try {
            raw = JSON.parse(text);
          } catch {
            throw a2aError(A2A_CLIENT_ERRORS.CARD_INVALID, 'Agent Card is not valid JSON');
          }
        } catch (err) {
          if (signal.aborted) {
            throw a2aError(
              A2A_CLIENT_ERRORS.TIMEOUT,
              `Agent Card request to ${this.config.cardUrl} did not finish within ${budgetMs} ms`
            );
          }
          throw err;
        }
        const card = validateAgentCard(raw);
        const endpoint = resolveRpcEndpoint(card);
        this.card = card;
        this.endpoint = endpoint;
        this.cardFetchedAt = Date.now();
        this.cardFailedAt = 0;
        this.toolsCache = null;
        this.consecutiveFailures = 0;
        this.lastError = null;
        if (!/^0\.3(\.|$)/.test(card.protocolVersion)) {
          logger.warn('A2A agent declares a protocol version other than 0.3', {
            component: 'A2aAgentConnection',
            agentId: this.config.id,
            protocolVersion: card.protocolVersion
          });
        }
        logger.info('A2A Agent Card loaded', {
          component: 'A2aAgentConnection',
          agentId: this.config.id,
          agentName: card.name,
          protocolVersion: card.protocolVersion,
          streaming: card.capabilities.streaming,
          skillCount: card.skills.length
        });
        return card;
      } catch (err) {
        this.consecutiveFailures++;
        this.cardFailedAt = Date.now();
        this.lastError = err.message || String(err);
        this.card = null;
        this.endpoint = null;
        this.toolsCache = null;
        throw err;
      } finally {
        this._cardPromise = null;
      }
    })();
    return this._cardPromise;
  }

  /**
   * The tool definitions for the agent's skills within `allowedSkills`.
   * Cached with the card.
   *
   * With `maxWaitMs` (tool discovery for a chat), the network never holds the
   * caller up for long: an expired card keeps serving its tools while a fresh
   * one is fetched in the background, and a first fetch that takes longer
   * than `maxWaitMs` fails this call (`A2A_TIMEOUT`) while it carries on for
   * the next one.
   *
   * @param {{maxWaitMs?: number}} [options]
   * @returns {Promise<Array<Object>>}
   */
  async listTools({ maxWaitMs } = {}) {
    if (this.config.enabled === false) return [];
    const card = maxWaitMs === undefined ? await this.getCard() : await this._cardFor(maxWaitMs);
    if (this.toolsCache) return this.toolsCache;
    const { tools, skillsByToolId } = buildSkillTools(this.config, card);
    this.toolsCache = tools;
    this.skillsByToolId = skillsByToolId;
    return tools;
  }

  /** The card for tool discovery; see `listTools({maxWaitMs})`. */
  async _cardFor(maxWaitMs) {
    if (this.card && Date.now() - this.cardFetchedAt >= CARD_TTL_MS) {
      const stale = this.card;
      this.getCard().catch(() => {
        /* logged through status(); the next discovery retries */
      });
      return stale;
    }
    const fetching = this.getCard();
    fetching.catch(() => {
      /* handled by the race below or by the next caller */
    });
    let timer;
    const waited = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            a2aError(
              A2A_CLIENT_ERRORS.TIMEOUT,
              `Agent ${this.config.id} is still loading its Agent Card; skipped for now`
            )
          ),
        maxWaitMs
      );
    });
    try {
      return await Promise.race([fetching, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One JSON-RPC call to the agent.
   *
   * @param {string} method - e.g. `message/send`, `tasks/get`
   * @param {Object} params
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<*>} The JSON-RPC `result`
   * @throws {Error} `A2A_RPC_ERROR` with `rpcCode` for a JSON-RPC error
   */
  async rpc(method, params, { signal } = {}) {
    await this.getCard();
    const id = randomUUID();
    const resp = await this._request(
      this.endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      },
      { signal }
    );
    const body = parseJsonOrNull(
      await readTextLimited(resp, A2A_RESPONSE_LIMITS.rpcBytes, `The ${method} response`)
    );
    if (body?.error) throw rpcErrorOf(body.error, method);
    if (!resp.ok) {
      throw a2aError(
        A2A_CLIENT_ERRORS.HTTP_ERROR,
        `Agent ${this.config.id} answered ${method} with HTTP ${resp.status}`
      );
    }
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw a2aError(
        A2A_CLIENT_ERRORS.RPC_ERROR,
        `Agent ${this.config.id} answered ${method} without a JSON-RPC result`
      );
    }
    return body.result;
  }

  /**
   * `message/stream`: every SSE event's JSON-RPC result is handed to `onEvent`
   * until the agent closes the stream. An agent that answers with plain JSON
   * instead delivers that one result.
   *
   * @param {Object} params - `MessageSendParams`
   * @param {{signal?: AbortSignal, onEvent: (event: Object) => void}} options
   */
  async stream(params, { signal, onEvent }) {
    await this.getCard();
    const resp = await this._request(
      this.endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'message/stream', params })
      },
      { signal }
    );
    const contentType = String(resp.headers?.get?.('content-type') || '');
    if (!resp.ok || !contentType.startsWith('text/event-stream')) {
      const body = parseJsonOrNull(
        await readTextLimited(resp, A2A_RESPONSE_LIMITS.rpcBytes, 'The message/stream response')
      );
      if (body?.error) throw rpcErrorOf(body.error, 'message/stream');
      if (body && typeof body === 'object' && 'result' in body) {
        onEvent(body.result);
        return;
      }
      throw a2aError(
        A2A_CLIENT_ERRORS.HTTP_ERROR,
        `Agent ${this.config.id} answered message/stream with HTTP ${resp.status} (${contentType || 'no content type'})`
      );
    }
    if (!resp.body) {
      throw a2aError(A2A_CLIENT_ERRORS.RPC_ERROR, 'message/stream response has no body');
    }
    for await (const frame of parseSseStream(resp.body)) {
      if (frame?.error) throw rpcErrorOf(frame.error, 'message/stream');
      if (frame && typeof frame === 'object' && 'result' in frame) onEvent(frame.result);
    }
  }

  /**
   * Send a message for a skill and return the agent's answer.
   *
   * The whole exchange — card, request, streaming, polling — has to finish
   * within the agent's `timeoutMs`; past it the task is cancelled (best
   * effort) and an `A2A_TIMEOUT` error is thrown. When the caller's `signal`
   * aborts (the user stopped the chat turn), the request is aborted, a running
   * task is cancelled the same way and `A2A_CANCELLED` is thrown.
   *
   * A task that ends `failed`, `rejected` or `canceled` throws
   * `A2A_TASK_FAILED`; one that stops at `auth-required` throws
   * `A2A_AUTH_REQUIRED`; `unknown` (or any state iHub does not know) throws
   * `A2A_TASK_FAILED`. One that stops at `input-required` returns the agent's
   * question as the answer so the model can relay it — the caller then sends
   * the user's reply with the returned `taskId` to continue that same task.
   *
   * @param {Object} params
   * @param {string} params.skillId - The card's skill id (sent as `metadata.skillId`)
   * @param {string} params.text - The message text
   * @param {Object} [params.data] - Structured input, sent as a data part
   * @param {Array<{name: string, mimeType?: string, bytes: Buffer}>} [params.files] - Files to send
   *   along, as file parts (`bytes` base64 on the wire)
   * @param {string} [params.contextId] - Conversation to continue
   * @param {string} [params.taskId] - Task waiting for input (`input-required`) to continue
   * @param {(progress: {state?: string, message?: string}) => void} [params.onProgress]
   * @param {AbortSignal} [params.signal] - Aborts the call (user stop)
   * @returns {Promise<{text: string, contextId: string|null, taskId: string|null, state: string,
   *   files?: Array<Object>}>} `files` are the file parts the agent returned (see `receiveFiles`)
   */
  async sendMessage({
    skillId,
    text,
    data,
    files,
    contextId,
    taskId: continueTaskId,
    onProgress,
    signal
  }) {
    if (this.config.enabled === false) {
      throw new Error(`A2A agent ${this.config.id} is disabled`);
    }
    const timeoutMs = this.config.timeoutMs ?? 60000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.('abort', onCallerAbort, { once: true });
    const callSignal = controller.signal;

    const parts = [{ kind: 'text', text }];
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
      parts.push({ kind: 'data', data });
    }
    for (const file of Array.isArray(files) ? files : []) {
      if (!file?.bytes?.length) continue;
      parts.push({
        kind: 'file',
        file: {
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          bytes: Buffer.from(file.bytes).toString('base64')
        }
      });
    }
    const params = {
      message: {
        kind: 'message',
        role: 'user',
        messageId: randomUUID(),
        parts,
        ...(contextId ? { contextId } : {}),
        ...(continueTaskId ? { taskId: continueTaskId } : {}),
        metadata: { skillId }
      },
      configuration: { blocking: true, acceptedOutputModes: ACCEPTED_OUTPUT_MODES }
    };

    let taskId = null;
    const track = id => {
      if (typeof id === 'string' && id) taskId = id;
    };
    try {
      // Inside the budget: a slow card counts against `timeoutMs` too.
      const card = await untilAborted(this.getCard(), callSignal);
      const useStream = this.config.streaming !== 'never' && card.capabilities.streaming === true;
      if (useStream) {
        return await this._sendStreaming(params, { signal: callSignal, onProgress, track });
      }
      const result = await this.rpc('message/send', params, { signal: callSignal });
      return await this._settle(result, { signal: callSignal, onProgress, track });
    } catch (err) {
      if (callSignal.aborted || err?.name === 'AbortError') {
        const reason = timedOut ? 'timeout' : 'stop';
        if (taskId) this._cancelTask(taskId, reason);
        if (!timedOut) {
          throw a2aError(
            A2A_CLIENT_ERRORS.CANCELLED,
            `The call to agent ${this.config.id} was stopped`,
            { taskId }
          );
        }
        throw a2aError(
          A2A_CLIENT_ERRORS.TIMEOUT,
          `Agent ${this.config.id} did not finish within ${timeoutMs} ms`,
          { taskId }
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onCallerAbort);
    }
  }

  /**
   * Best-effort `tasks/cancel` after a timeout or a user stop; never throws.
   * @param {string} taskId
   * @param {'timeout'|'stop'} reason - For the log
   */
  _cancelTask(taskId, reason = 'timeout') {
    const after = reason === 'stop' ? 'after the user stopped the call' : 'after timeout';
    this.rpc('tasks/cancel', { id: taskId }, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) })
      .then(() => {
        logger.info(`A2A task cancelled ${after}`, {
          component: 'A2aAgentConnection',
          agentId: this.config.id,
          taskId
        });
      })
      .catch(err => {
        logger.warn(`A2A tasks/cancel ${after} failed`, {
          component: 'A2aAgentConnection',
          agentId: this.config.id,
          taskId,
          error: err.message
        });
      });
  }

  /**
   * Turn a `message/send` result into the answer: a `Message` directly, a
   * final `Task` from its artifacts, a running `Task` after polling.
   */
  async _settle(result, { signal, onProgress, track }) {
    if (result?.kind === 'message') return messageResult(result);
    if (result?.kind !== 'task' || typeof result.id !== 'string') {
      throw a2aError(
        A2A_CLIENT_ERRORS.RPC_ERROR,
        `Agent ${this.config.id} answered with neither a task nor a message`
      );
    }
    track(result.id);
    let task = result;
    const pollIntervalMs = this.config.pollIntervalMs ?? 1500;
    while (isRunning(task)) {
      report(onProgress, task.status?.state, statusMessageText(task));
      await sleep(pollIntervalMs, signal);
      task = await this.rpc('tasks/get', { id: result.id }, { signal });
      if (task?.kind !== 'task') {
        throw a2aError(A2A_CLIENT_ERRORS.RPC_ERROR, 'tasks/get did not return a task');
      }
      if (task.id !== result.id) {
        throw a2aError(
          A2A_CLIENT_ERRORS.RPC_ERROR,
          `tasks/get for task ${result.id} returned another task (${task.id})`
        );
      }
    }
    return this._taskResult(task);
  }

  /** The answer held by a settled task. */
  _taskResult(task) {
    return this._outcome({
      state: task.status?.state,
      statusText: statusMessageText(task),
      answerText: artifactsText(task.artifacts),
      files: [...artifactsFiles(task.artifacts), ...statusMessageFiles(task)],
      taskId: task.id,
      contextId: task.contextId || null
    });
  }

  /**
   * The answer — or the error — for a task that stopped moving. Shared by the
   * polling and the streaming path so both treat every state alike:
   * `completed` answers with the artifacts (else the status text),
   * `input-required` with the agent's question, `auth-required` and every
   * failed, unknown or unrecognised state throw.
   *
   * @param {Object} outcome
   * @param {string|undefined} outcome.state
   * @param {string} outcome.statusText - Text of the status message
   * @param {string} outcome.answerText - Text of the artifacts
   * @param {Array<Object>} [outcome.files] - File parts of the artifacts and the status message
   * @param {string|null} outcome.taskId
   * @param {string|null} outcome.contextId
   * @returns {{text: string, contextId: string|null, taskId: string|null, state: string, files?: Array<Object>}}
   */
  _outcome({ state, statusText, answerText, files = [], taskId, contextId }) {
    const withFiles = dedupeFiles(files);
    const filesOf = withFiles.length > 0 ? { files: withFiles } : {};
    if (state === 'completed') {
      return { text: answerText || statusText, contextId, taskId, state, ...filesOf };
    }
    if (state === 'input-required') {
      return { text: statusText, contextId, taskId, state, ...filesOf };
    }
    if (state === 'failed' || state === 'rejected' || state === 'canceled') {
      throw a2aError(
        A2A_CLIENT_ERRORS.TASK_FAILED,
        statusText || `Agent ${this.config.id} ${state} the task`,
        { taskId, state }
      );
    }
    if (state === 'auth-required') {
      // The agent wants credentials for a downstream system. iHub signs in
      // with one shared service credential and cannot run that flow, so the
      // task would wait forever.
      throw a2aError(
        A2A_CLIENT_ERRORS.AUTH_REQUIRED,
        `Agent ${this.config.id} needs authentication iHub cannot provide` +
          (statusText ? `: ${statusText}` : ''),
        { taskId, state }
      );
    }
    throw a2aError(
      A2A_CLIENT_ERRORS.TASK_FAILED,
      `Agent ${this.config.id} left the task in state "${state || 'unknown'}"` +
        (statusText ? `: ${statusText}` : ''),
      { taskId, state: state || 'unknown' }
    );
  }

  /**
   * `message/stream` until the final event, collecting artifact chunks and
   * reporting status updates. A stream that ends early (the connection
   * dropped before `final: true`) falls back to `tasks/get` polling.
   */
  async _sendStreaming(params, { signal, onProgress, track }) {
    const collector = new StreamCollector();
    let stop = false;
    await this.stream(params, {
      signal,
      onEvent: event => {
        if (stop) return;
        const change = collector.add(event);
        if (collector.taskId) track(collector.taskId);
        if (change?.kind === 'status' || change?.kind === 'task') {
          report(onProgress, change.state, change.message);
        }
        if (collector.final) stop = true;
      }
    });

    if (collector.message && !collector.task) return messageResult(collector.message);
    const state = collector.status?.state || (collector.message ? 'completed' : undefined);
    // A `final` event with a still-running state is treated like a dropped
    // stream: the task is looked up below.
    if (collector.final && !RUNNING_TASK_STATES.has(state)) {
      return this._outcome({
        state,
        statusText: collector.status ? statusMessageText({ status: collector.status }) : '',
        answerText:
          collector.artifactsText() ||
          (collector.message ? partsText(collector.message.parts, { separator: '\n' }) : ''),
        files: collector.files(),
        taskId: collector.taskId,
        contextId: collector.contextId
      });
    }
    if (collector.taskId) {
      const task = await this.rpc('tasks/get', { id: collector.taskId }, { signal });
      return this._settle(task, { signal, onProgress, track });
    }
    if (collector.message) return messageResult(collector.message);
    throw a2aError(
      A2A_CLIENT_ERRORS.RPC_ERROR,
      `Agent ${this.config.id} closed the stream without an answer`
    );
  }

  /**
   * Take the files an agent returned into the chat: decode `file.bytes`, or
   * fetch `file.uri` (HTTPS; the agent's own origin with its credential, any
   * other host without it, always through the SSRF-guarded fetch and never
   * redirected), then store each (`toolOutputFiles.storeToolOutputFile`, origin
   * `a2a`) so it shows in the chat's Files drawer.
   *
   * Never throws: a file that is too large, cannot be fetched or is of a type
   * that cannot be kept comes back with an `error` in its descriptor.
   *
   * @param {Array<Object>} refs - `file` objects of the agent's file parts (`bytes` or `uri`)
   * @param {Object} params
   * @param {string} params.chatId - The chat the call was made in
   * @param {string|null} [params.ownerId]
   * @param {AbortSignal} [params.signal]
   * @param {Object|null} [params.store] - A `ChatFileRepository` (tests)
   * @returns {Promise<{files: Array<Object>, images: Array<Object>}>} What the model sees:
   *   `{ fileId, name, mimeType, bytes, id? }` — `id` names the held download card
   */
  async receiveFiles(refs, { chatId, ownerId = null, signal, store = null } = {}) {
    const files = [];
    const images = [];
    const list = Array.isArray(refs) ? refs : [];
    for (const [index, ref] of list.entries()) {
      if (index >= A2A_RESPONSE_LIMITS.files) {
        files.push({
          name: plainFileName(ref.name, `file-${index + 1}`),
          error: `More than ${A2A_RESPONSE_LIMITS.files} files in one answer; this one was not stored.`
        });
        continue;
      }
      const name = plainFileName(ref.name, `file-${index + 1}`);
      let bytes = null;
      let mimeType = ref.mimeType;
      let failure = null;
      if (typeof ref.bytes === 'string') {
        const decoded = decodeBase64Capped(ref.bytes, A2A_RESPONSE_LIMITS.fileBytes);
        if (decoded.ok) bytes = decoded.buffer;
        else failure = decoded.reason;
      } else {
        try {
          const fetched = await this._fetchFileUri(ref.uri, { signal });
          bytes = fetched.bytes;
          mimeType = mimeType || fetched.mimeType;
        } catch (error) {
          if (signal?.aborted) throw error;
          failure = error?.message || 'fetch failed';
        }
      }
      if (!bytes) {
        files.push({
          name,
          ...(mimeType ? { mimeType } : {}),
          error:
            failure === 'too-large'
              ? `The file is larger than ${A2A_RESPONSE_LIMITS.fileBytes / 1024 / 1024} MB and was not stored.`
              : `The file could not be read (${String(failure || 'empty').slice(0, 120)}).`
        });
        continue;
      }
      const stored = await storeToolOutputFile({
        chatId,
        ownerId,
        bytes,
        name,
        mimeType: normalizeMediaType(mimeType, name) || mimeType,
        uri: ref.uri,
        index,
        origin: 'a2a',
        meta: { agentId: this.config.id },
        store
      });
      const held = stored.images[0] || stored.files[0];
      const descriptor = { ...stored.descriptor };
      delete descriptor.type;
      if (held) descriptor.id = held.id;
      (stored.images.length > 0 ? images : files).push(descriptor);
    }
    return { files, images };
  }

  /**
   * Fetch the content behind a file part's `uri`, bounded in size.
   * @private
   */
  async _fetchFileUri(uri, { signal } = {}) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new Error('invalid uri');
    }
    if (!isAllowedAgentUrl(url.toString()) || url.username || url.password) {
      throw new Error('uri must be https (http for localhost only) without credentials');
    }
    const sameOrigin = this.endpoint && new URL(this.endpoint).origin === url.origin;
    const resp = sameOrigin
      ? await this._request(url.toString(), { method: 'GET' }, { signal })
      : await safeFetch(
          url,
          { method: 'GET', redirect: 'manual', ...(signal ? { signal } : {}) },
          this._fetchOptions
        );
    refuseRedirect(resp, `File host ${url.host}`);
    if (!resp.ok) {
      await discardBody(resp);
      throw new Error(`HTTP ${resp.status}`);
    }
    const max = A2A_RESPONSE_LIMITS.fileBytes;
    const declared = Number(resp.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await discardBody(resp);
      throw new Error('too-large');
    }
    const chunks = [];
    let size = 0;
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => {});
          throw new Error('too-large');
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > max) throw new Error('too-large');
      chunks.push(buf);
    }
    const bytes = Buffer.concat(chunks);
    return {
      bytes,
      mimeType: resp.headers?.get?.('content-type')?.split(';')[0].trim() || undefined
    };
  }

  /** Snapshot for the admin page. */
  status() {
    return {
      id: this.config.id,
      enabled: this.config.enabled !== false,
      connected: Boolean(this.card),
      unhealthy: this.consecutiveFailures >= UNHEALTHY_AFTER_FAILURES,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      cardUrl: this.config.cardUrl,
      agentName: this.card?.name || null,
      protocolVersion: this.card?.protocolVersion || null,
      streaming: this.card?.capabilities?.streaming === true,
      toolCount: this.toolsCache ? this.toolsCache.length : null
    };
  }
}

/** The answer held by a `Message` reply (how the cookbook agents answer). */
function messageResult(message) {
  const files = dedupeFiles(partsFiles(message.parts));
  return {
    text: partsText(message.parts, { separator: '\n' }),
    contextId: message.contextId || null,
    taskId: message.taskId || null,
    state: 'completed',
    ...(files.length > 0 ? { files } : {})
  };
}

/** The same file listed twice (an artifact and the status message) once. */
function dedupeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const key = `${file.name || ''}|${file.mimeType || ''}|${file.uri || ''}|${
      file.bytes ? `${file.bytes.length}:${file.bytes.slice(0, 64)}:${file.bytes.slice(-64)}` : ''
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/**
 * Whether a task is still working on its own (`submitted`, `working`), so
 * polling it makes sense. Final, interrupted (`input-required`,
 * `auth-required`), `unknown` and unrecognised states all stop the polling —
 * none of them changes without the client acting.
 */
function isRunning(task) {
  return RUNNING_TASK_STATES.has(task?.status?.state);
}

/**
 * Refuse a redirect. Every A2A request is sent with `redirect: 'manual'`, so
 * a 3xx reaches the client as is.
 *
 * @param {Response} resp
 * @param {string} who - Who answered, for the message
 * @throws {Error} `A2A_REDIRECT_REFUSED`
 */
function refuseRedirect(resp, who) {
  const status = resp?.status;
  if (resp?.type !== 'opaqueredirect' && !(status >= 300 && status < 400)) return;
  void discardBody(resp);
  const location = resp.headers?.get?.('location');
  throw a2aError(
    A2A_CLIENT_ERRORS.REDIRECT_REFUSED,
    `${who} answered with a redirect (HTTP ${status}${location ? ` to ${location}` : ''}); ` +
      'A2A requests do not follow redirects, so configure the final URL instead'
  );
}

/** Release a response body that will not be read; never throws. */
async function discardBody(resp) {
  try {
    await resp?.body?.cancel?.();
  } catch {
    /* nothing to release */
  }
}

/**
 * A response body as text, refusing more than `maxBytes` (by the declared
 * `Content-Length` up front, and while reading) with `A2A_RESPONSE_TOO_LARGE`.
 *
 * @param {Response} resp
 * @param {number} maxBytes
 * @param {string} what - The body, for the message (e.g. "The Agent Card")
 * @returns {Promise<string>}
 */
async function readTextLimited(resp, maxBytes, what) {
  const tooLarge = () =>
    a2aError(A2A_CLIENT_ERRORS.RESPONSE_TOO_LARGE, `${what} is larger than ${maxBytes} bytes`);
  const declared = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(resp);
    throw tooLarge();
  }
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const text = typeof resp.text === 'function' ? await resp.text() : '';
    if (text.length > maxBytes) throw tooLarge();
    return text;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `promise`, or an AbortError as soon as `signal` aborts. The promise itself
 * carries on (it may be shared, like a card fetch) and its outcome is still
 * handled, so it never turns into an unhandled rejection.
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function report(onProgress, state, message) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ ...(state ? { state } : {}), ...(message ? { message } : {}) });
  } catch {
    /* progress is best effort */
  }
}

function rpcErrorOf(error, method) {
  return a2aError(
    A2A_CLIENT_ERRORS.RPC_ERROR,
    `${method} failed: ${error?.message || 'unknown error'} (code ${error?.code ?? '?'})`,
    { rpcCode: error?.code, rpcData: error?.data }
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
