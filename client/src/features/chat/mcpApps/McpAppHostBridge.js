/**
 * Host side of the MCP Apps JSON-RPC channel (SEP-1865), transport-agnostic.
 *
 * The view runs in a sandboxed iframe and speaks JSON-RPC 2.0 over
 * `postMessage` (relayed by the sandbox proxy). This class parses what the
 * view sends, dispatches requests and notifications to handlers, answers
 * requests, and lets the host send notifications and requests of its own.
 * It knows nothing about React or the DOM — `post` is the only way out — so
 * it can be exercised directly in tests.
 *
 * @module features/chat/mcpApps/McpAppHostBridge
 */

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

/** JSON-RPC error codes used by the host. */
export const RPC_ERRORS = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Implementation-defined: denied, failed, rate-limited. */
  HOST: -32000
});

/** Requests a view may make per second (sustained) and in a burst. */
const RATE_PER_SECOND = 10;
const RATE_BURST = 30;

/** Host → view requests time out after this long. */
const HOST_REQUEST_TIMEOUT_MS = 5000;

/**
 * An error a handler throws to answer a request with a specific code.
 */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function isRequestId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export class McpAppHostBridge {
  /**
   * @param {Object} options
   * @param {(message: Object) => void} options.post - Send a message to the view
   * @param {Object<string, Function>} [options.requests] - `method -> (params) => result`
   * @param {Object<string, Function>} [options.notifications] - `method -> (params) => void`
   * @param {() => number} [options.now] - Clock (tests)
   */
  constructor({ post, requests = {}, notifications = {}, now = () => Date.now() }) {
    this.post = post;
    this.requests = requests;
    this.notifications = notifications;
    this.now = now;
    this.nextId = 1;
    this.pending = new Map(); // host request id -> { resolve, reject, timer }
    this.tokens = RATE_BURST;
    this.lastRefill = now();
    this.closed = false;
  }

  /**
   * Handle one message from the view. Anything that is not JSON-RPC 2.0 is
   * ignored; a malformed request is answered with an error.
   * @param {unknown} data
   */
  handleMessage(data) {
    if (this.closed || !data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    const hasMethod = typeof data.method === 'string';

    // A response to a host → view request.
    if (!hasMethod) {
      if (!isRequestId(data.id)) return;
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new RpcError(data.error.code, data.error.message));
      else entry.resolve(data.result);
      return;
    }

    const params = data.params && typeof data.params === 'object' ? data.params : {};

    // A notification.
    if (data.id === undefined) {
      const handler = this.notifications[data.method];
      if (typeof handler === 'function') {
        try {
          handler(params);
        } catch (error) {
          console.warn('[MCP App] notification handler failed', data.method, error);
        }
      }
      return;
    }

    // A request.
    if (!isRequestId(data.id)) return;
    const id = data.id;
    if (!this._takeToken()) {
      this._respondError(id, RPC_ERRORS.HOST, 'Rate limit exceeded');
      return;
    }
    const handler = this.requests[data.method];
    if (typeof handler !== 'function') {
      this._respondError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${data.method}`);
      return;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        result => this._send({ jsonrpc: '2.0', id, result: result ?? {} }),
        error =>
          this._respondError(
            id,
            Number.isInteger(error?.code) ? error.code : RPC_ERRORS.HOST,
            error?.message || 'Request failed',
            error?.data
          )
      );
  }

  /**
   * Send a notification to the view.
   * @param {string} method
   * @param {Object} [params]
   */
  notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Send a request to the view and wait for its answer.
   * @param {string} method
   * @param {Object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  request(method, params = {}, timeoutMs = HOST_REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('Bridge closed'));
    const id = `host-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Stop answering and reject every open host request. */
  close() {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Bridge closed'));
      this.pending.delete(id);
    }
  }

  _send(message) {
    if (this.closed) return;
    try {
      this.post(message);
    } catch (error) {
      console.warn('[MCP App] failed to post message', error);
    }
  }

  _respondError(id, code, message, data) {
    this._send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) }
    });
  }

  _takeToken() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(RATE_BURST, this.tokens + elapsed * RATE_PER_SECOND);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * The text a view asked to post with `ui/message`. Accepts the content as one
 * block (the specification's example) or an array of blocks (the SDK); only
 * text blocks are used.
 *
 * @param {Object} params - `ui/message` params
 * @returns {string}
 */
export function messageTextFromParams(params) {
  const content = params?.content;
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/**
 * Whether a URL may be opened for a view: absolute http(s) only.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isOpenableUrl(url) {
  if (typeof url !== 'string' || url.length > 8192) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
