// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Request helpers of the cross-user authorization suite: one API request context
 * per principal (signed in through `POST /api/auth/local/login`, the session in the
 * `authToken` cookie) and one function that sends a matrix entry and reports what
 * came back.
 */

import { request as playwrightRequest } from '@playwright/test';
import { AUTHZ_USERS } from './principals.js';

export const SERVER_PORT = Number(process.env.AUTHZ_SERVER_PORT) || 3301;
export const BASE_URL = `http://localhost:${SERVER_PORT}`;

/** Statuses that refuse a request without revealing or touching the resource. */
export const DENY = [401, 403, 404];

/**
 * A request context signed in as `name` (`alice`, `bob`, `carol`, `admin`), or
 * an anonymous one for `anonymous`.
 *
 * @param {string} name
 * @returns {Promise<import('@playwright/test').APIRequestContext>}
 */
export async function contextFor(name) {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL });
  if (name === 'anonymous') return context;
  const user = AUTHZ_USERS[name];
  const response = await context.post('/api/auth/local/login', {
    data: { username: user.username, password: user.password }
  });
  if (response.status() !== 200) {
    throw new Error(`Sign-in as ${name} failed: ${response.status()} ${await response.text()}`);
  }
  return context;
}

/** A context that sends a bearer token (a personal API key) and no cookie. */
export async function bearerContext(token) {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` }
  });
}

/**
 * Fill `:name` and `*name` segments of an Express path with values.
 *
 * @param {string} template - e.g. `/api/chats/:chatId/files/:fileId`
 * @param {Record<string, string | number | null | undefined>} values - a missing value throws
 * @returns {string}
 */
export function fillPath(template, values) {
  return template.replace(/[:*]([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
    const value = values[name];
    if (value === undefined || value === null) {
      throw new Error(`No value for ${match} in ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Send one request and return `{ status, text, json, timedOut }`. A request that
 * gets no complete answer within `timeout` (an event stream that opened) comes
 * back with `timedOut: true` and `status: null`.
 */
export async function send(context, { method, url, data, multipart, headers, timeout = 15_000 }) {
  try {
    const response = await context.fetch(url, {
      method,
      ...(data !== undefined && { data }),
      ...(multipart && { multipart }),
      headers,
      timeout,
      maxRedirects: 0,
      failOnStatusCode: false
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON (an HTML page, a stream, a file): `text` carries it.
    }
    return { status: response.status(), text, json, headers: response.headers(), timedOut: false };
  } catch (error) {
    if (/Timeout|timed out/i.test(error.message)) {
      return { status: null, text: '', json: null, headers: {}, timedOut: true };
    }
    throw error;
  }
}

/** A text file for a multipart upload. */
export function textFile(name, content) {
  return { name, mimeType: 'text/plain', buffer: Buffer.from(content, 'utf8') };
}

/** A 1×1 PNG, for the OCR job. */
export function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
    'base64'
  );
}

/** Poll `fn` until it returns a truthy value (or throw after `timeoutMs`). */
export async function waitFor(
  fn,
  { timeoutMs = 20_000, intervalMs = 250, what = 'condition' } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
