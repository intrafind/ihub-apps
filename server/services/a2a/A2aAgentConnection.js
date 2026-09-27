import { randomUUID } from 'crypto';
import credentialService from '../CredentialService.js';
import { safeFetch } from '../mcp/safeFetch.js';
import { A2A_DEFAULT_API_KEY_HEADER } from '../../validators/a2aAgentConfigSchema.js';
import {
  A2A_CLIENT_ERRORS,
  FINAL_TASK_STATES,
  StreamCollector,
  a2aError,
  artifactsText,
  buildSkillTools,
  cardApiKeyHeader,
  parseSseStream,
  partsText,
  resolveRpcEndpoint,
  statusMessageText,
  validateAgentCard
} from './a2aTools.js';
import logger from '../../utils/logger.js';

/** How long a fetched Agent Card is reused before it is fetched again. */
export const CARD_TTL_MS = 10 * 60 * 1000;

/** How long a failed card fetch is remembered before the agent is tried again. */
export const CARD_RETRY_MS = 30 * 1000;

/** Consecutive card failures after which the agent is reported unhealthy. */
const UNHEALTHY_AFTER_FAILURES = 3;

/** Budget for the best-effort `tasks/cancel` after a timeout. */
const CANCEL_TIMEOUT_MS = 10 * 1000;

/** Output modes iHub can turn into a tool result. */
const ACCEPTED_OUTPUT_MODES = ['text/plain', 'application/json'];

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
 * Every request goes through `safeFetch` with the file's `security` policy.
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
    this._oauthToken = null;
    this._oauthTokenExpiry = 0;
  }

  /** Drop the cached card and tools so the next use fetches them again. */
  reset() {
    this.card = null;
    this.cardFetchedAt = 0;
    this.cardFailedAt = 0;
    this.endpoint = null;
    this.toolsCache = null;
    this.skillsByToolId = new Map();
    this._oauthToken = null;
    this._oauthTokenExpiry = 0;
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
    const out = { ...auth };
    const refFields = { valueRef: 'value', tokenRef: 'token', clientSecretRef: 'clientSecret' };
    for (const [refField, plainField] of Object.entries(refFields)) {
      if (typeof out[refField] === 'string' && out[refField]) {
        try {
          out[plainField] = credentialService.resolveSecret(out[refField]);
        } catch (err) {
          logger.error('Failed to resolve A2A agent auth secret from credential store', {
            component: 'A2aAgentConnection',
            agentId: this.config.id,
            field: refField,
            error: err.message
          });
          throw err;
        }
      }
    }
    return out;
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
  async _authHeaders() {
    const auth = this._resolveAuth();
    if (auth.type === 'apiKey') return { [this._apiKeyHeaderName(auth)]: auth.value };
    if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
    if (auth.type === 'oauth')
      return { Authorization: `Bearer ${await this._oauthAccessToken(auth)}` };
    return {};
  }

  async _oauthAccessToken(auth) {
    const now = Date.now();
    if (this._oauthToken && this._oauthTokenExpiry > now + 5000) return this._oauthToken;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret
    });
    if (auth.scope) body.set('scope', auth.scope);
    const resp = await safeFetch(
      auth.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      },
      this._fetchOptions
    );
    if (!resp.ok) {
      throw a2aError(
        A2A_CLIENT_ERRORS.AUTH_FAILED,
        `OAuth token request to ${auth.tokenUrl} failed: HTTP ${resp.status}`
      );
    }
    const data = await resp.json();
    if (!data?.access_token) {
      throw a2aError(A2A_CLIENT_ERRORS.AUTH_FAILED, 'OAuth token response missing access_token');
    }
    this._oauthToken = data.access_token;
    this._oauthTokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
    return this._oauthToken;
  }

  /**
   * One HTTP request to the agent through the SSRF guard, with auth headers.
   * A 401/403 is reported as `A2A_AUTH_FAILED`.
   *
   * @param {string} url
   * @param {Object} init - fetch init (method, headers, body)
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Response>}
   */
  async _request(url, init = {}, { signal } = {}) {
    const headers = new Headers(init.headers || {});
    for (const [name, value] of Object.entries(await this._authHeaders())) {
      headers.set(name, value);
    }
    const resp = await safeFetch(
      url,
      { ...init, headers: Object.fromEntries(headers.entries()), ...(signal ? { signal } : {}) },
      this._fetchOptions
    );
    if (resp.status === 401 || resp.status === 403) {
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
   * agent does not delay every chat turn.
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
      try {
        const resp = await this._request(this.config.cardUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' }
        });
        if (!resp.ok) {
          throw a2aError(
            A2A_CLIENT_ERRORS.HTTP_ERROR,
            `Agent Card request to ${this.config.cardUrl} failed: HTTP ${resp.status}`
          );
        }
        let raw;
        try {
          raw = await resp.json();
        } catch {
          throw a2aError(A2A_CLIENT_ERRORS.CARD_INVALID, 'Agent Card is not valid JSON');
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
   * @returns {Promise<Array<Object>>}
   */
  async listTools() {
    if (this.config.enabled === false) return [];
    const card = await this.getCard();
    if (this.toolsCache) return this.toolsCache;
    const { tools, skillsByToolId } = buildSkillTools(this.config, card);
    this.toolsCache = tools;
    this.skillsByToolId = skillsByToolId;
    return tools;
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
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
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
      let body = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
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
   * The whole exchange — request, streaming, polling — has to finish within
   * the agent's `timeoutMs`; past it the task is cancelled (best effort) and
   * an `A2A_TIMEOUT` error is thrown. A task that ends `failed`, `rejected` or
   * `canceled` throws `A2A_TASK_FAILED`; one that stops at `input-required`
   * returns the agent's question as the answer so the model can relay it.
   *
   * @param {Object} params
   * @param {string} params.skillId - The card's skill id (sent as `metadata.skillId`)
   * @param {string} params.text - The message text
   * @param {Object} [params.data] - Structured input, sent as a data part
   * @param {string} [params.contextId] - Conversation to continue
   * @param {(progress: {state?: string, message?: string}) => void} [params.onProgress]
   * @returns {Promise<{text: string, contextId: string|null, taskId: string|null, state: string}>}
   */
  async sendMessage({ skillId, text, data, contextId, onProgress }) {
    if (this.config.enabled === false) {
      throw new Error(`A2A agent ${this.config.id} is disabled`);
    }
    const card = await this.getCard();
    const timeoutMs = this.config.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;

    const parts = [{ kind: 'text', text }];
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
      parts.push({ kind: 'data', data });
    }
    const params = {
      message: {
        kind: 'message',
        role: 'user',
        messageId: randomUUID(),
        parts,
        ...(contextId ? { contextId } : {}),
        metadata: { skillId }
      },
      configuration: { blocking: true, acceptedOutputModes: ACCEPTED_OUTPUT_MODES }
    };
    const useStream = this.config.streaming !== 'never' && card.capabilities.streaming === true;

    let taskId = null;
    const track = id => {
      if (typeof id === 'string' && id) taskId = id;
    };
    try {
      if (useStream) {
        return await this._sendStreaming(params, { signal, onProgress, track });
      }
      const result = await this.rpc('message/send', params, { signal });
      return await this._settle(result, { signal, onProgress, track });
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') {
        if (taskId) this._cancelTask(taskId);
        throw a2aError(
          A2A_CLIENT_ERRORS.TIMEOUT,
          `Agent ${this.config.id} did not finish within ${timeoutMs} ms`,
          { taskId }
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort `tasks/cancel` after a timeout; never throws. */
  _cancelTask(taskId) {
    this.rpc('tasks/cancel', { id: taskId }, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) })
      .then(() => {
        logger.info('A2A task cancelled after timeout', {
          component: 'A2aAgentConnection',
          agentId: this.config.id,
          taskId
        });
      })
      .catch(err => {
        logger.warn('A2A tasks/cancel after timeout failed', {
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
    while (!isSettled(task)) {
      report(onProgress, task.status?.state, statusMessageText(task));
      await sleep(pollIntervalMs, signal);
      task = await this.rpc('tasks/get', { id: result.id }, { signal });
      if (task?.kind !== 'task') {
        throw a2aError(A2A_CLIENT_ERRORS.RPC_ERROR, 'tasks/get did not return a task');
      }
    }
    return this._taskResult(task);
  }

  /** The answer held by a settled task. */
  _taskResult(task) {
    const state = task.status?.state;
    const statusText = statusMessageText(task);
    if (state === 'failed' || state === 'rejected' || state === 'canceled') {
      throw a2aError(
        A2A_CLIENT_ERRORS.TASK_FAILED,
        statusText || `Agent ${this.config.id} ${state} the task`,
        { taskId: task.id, state }
      );
    }
    const text =
      state === 'input-required' ? statusText : artifactsText(task.artifacts) || statusText;
    return { text, contextId: task.contextId || null, taskId: task.id, state };
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
    if (collector.final) {
      const state = collector.status?.state || (collector.message ? 'completed' : 'unknown');
      const statusText = collector.status ? statusMessageText({ status: collector.status }) : '';
      if (state === 'failed' || state === 'rejected' || state === 'canceled') {
        throw a2aError(
          A2A_CLIENT_ERRORS.TASK_FAILED,
          statusText || `Agent ${this.config.id} ${state} the task`,
          { taskId: collector.taskId, state }
        );
      }
      const text =
        state === 'input-required'
          ? statusText
          : collector.artifactsText() ||
            statusText ||
            (collector.message ? partsText(collector.message.parts, { separator: '\n' }) : '');
      return { text, contextId: collector.contextId, taskId: collector.taskId, state };
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
  return {
    text: partsText(message.parts, { separator: '\n' }),
    contextId: message.contextId || null,
    taskId: message.taskId || null,
    state: 'completed'
  };
}

/** Whether a task will not change any more without a new message. */
function isSettled(task) {
  const state = task?.status?.state;
  return FINAL_TASK_STATES.has(state) || state === 'input-required';
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
