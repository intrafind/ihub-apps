// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A small HTTP client for the load test: Bearer auth, a cookie jar (so an
 * ingress affinity cookie sticks to the virtual user), latency measurement and
 * one metric per named request.
 *
 * Uses Node's built-in fetch (undici). For a self-signed or private-CA target
 * set NODE_EXTRA_CA_CERTS=/path/ca.pem (preferred) before starting the runner.
 */

import { performance } from 'node:perf_hooks';

export class HttpError extends Error {
  constructor(name, status, body) {
    const detail = body && typeof body === 'object' ? body.detail || body.code || '' : '';
    super(`${name}: HTTP ${status}${detail ? ` ${detail}` : ''}`);
    this.status = status;
    this.body = body;
    this.code = body && typeof body === 'object' ? body.code : undefined;
  }
}

export class Client {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  e.g. http://localhost:3000 or https://host/ihub
   * @param {import('./metrics.mjs').Metrics} [opts.metrics]
   * @param {string} [opts.token]  JWT or API key, sent as Bearer
   */
  constructor({ baseUrl, metrics = null, token = null, timeoutMs = 300_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.metrics = metrics;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
  }

  url(path) {
    return path.startsWith('http') ? path : `${this.baseUrl}${path}`;
  }

  cookieHeader() {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  headers(extra = {}) {
    const h = { 'User-Agent': 'ihub-loadtest/1.0', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /**
   * Low-level request: returns the Response without reading the body (for
   * streams). The caller owns the body.
   */
  async raw(method, path, { headers = {}, body, signal } = {}) {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(headers),
      body,
      signal,
      redirect: 'manual'
    });
    this.storeCookies(res);
    return res;
  }

  /**
   * Request and read the body. Records `http.<name>` latency and
   * `http.<name>.status.<code>` counts when a name is given.
   *
   * @returns {Promise<{status:number, ok:boolean, headers:Headers, body:any, ms:number}>}
   */
  async request(method, path, { json, form, headers = {}, name, expect, timeoutMs } = {}) {
    let body;
    const h = { ...headers };
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
    } else if (form) {
      body = form;
    }
    const t0 = performance.now();
    let res;
    let text = '';
    try {
      res = await this.raw(method, path, {
        headers: h,
        body,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
      });
      text = await res.text();
    } catch (err) {
      const ms = performance.now() - t0;
      if (name && this.metrics) {
        this.metrics.trend(`http.${name}`, ms);
        this.metrics.error(name, err.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      throw err;
    }
    const ms = performance.now() - t0;
    let parsed = text;
    const type = res.headers.get('content-type') || '';
    if (type.includes('json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    const result = { status: res.status, ok: res.ok, headers: res.headers, body: parsed, ms };
    if (name && this.metrics) {
      this.metrics.trend(`http.${name}`, ms);
      this.metrics.count(`http.${name}.status.${res.status}`);
      if (!res.ok) this.metrics.error(name, parsed?.code || `HTTP_${res.status}`);
    }
    if (expect && !expect.includes(res.status)) {
      throw new HttpError(name || `${method} ${path}`, res.status, parsed);
    }
    return result;
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  post(path, json, opts = {}) {
    return this.request('POST', path, { ...opts, json });
  }

  delete(path, opts) {
    return this.request('DELETE', path, opts);
  }
}

/**
 * Log in with local auth and return a client that sends the session JWT as
 * Bearer. The login answer carries the token only in the `authToken` cookie.
 */
export async function login({ baseUrl, username, password, metrics = null }) {
  const client = new Client({ baseUrl, metrics });
  const res = await client.request('POST', '/api/auth/local/login', {
    json: { username, password },
    name: metrics ? 'auth.login' : undefined
  });
  if (res.status !== 200) {
    const err = new HttpError(`login ${username}`, res.status, res.body);
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  const token = client.cookies.get('authToken');
  if (!token) throw new Error(`login ${username}: no authToken cookie in the answer`);
  client.cookies.delete('authToken');
  client.token = token;
  return { client, user: res.body?.user };
}
