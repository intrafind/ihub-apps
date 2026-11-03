// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The request templates of the `http` protocol, as pure functions: how an
 * action's `request` (method, URL, query, headers, body) and its arguments
 * become one HTTP request, and how its `response` mapping shapes what the
 * model sees. No I/O here; `HttpAdapter.js` sends the request.
 *
 * Placeholders are `{name}`. A name resolves to the model's argument of that
 * name first, then to the installation's install value of that name. Every
 * substitution is escaped for where it lands, so an argument can never change
 * the shape of the request:
 *
 * | Where                 | Escaping                                            |
 * | --------------------- | --------------------------------------------------- |
 * | URL path and query    | `encodeURIComponent` (no `/`, `?`, `#`, `@` get in; a path value `.` or `..` is refused) |
 * | JSON body             | `JSON.stringify` of the value (strings get quoted)  |
 * | form body             | `encodeURIComponent`                                |
 * | text body             | the value as text                                   |
 * | header value          | the value as text; a line break is refused          |
 *
 * The base URL (`protocol.baseUrl`) is the admin's and takes install values
 * only, unescaped, like the OpenAPI adapter's base URL.
 *
 * @module services/integrations/protocols/http/httpTemplates
 */
import { valueAtPath } from '../../definitions/valuePaths.js';

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** An argument or install value as text (objects as JSON). */
function asText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The value a placeholder names: the model's argument, else the install value.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} values
 * @returns {unknown} undefined when neither has it
 */
export function placeholderValue(name, args = {}, values = {}) {
  if (args && Object.hasOwn(args, name) && args[name] !== undefined) return args[name];
  if (values && Object.hasOwn(values, name) && values[name] !== undefined) return values[name];
  return undefined;
}

/**
 * The placeholder names a template uses, in order, each once.
 * @param {string} template
 * @returns {string[]}
 */
export function placeholdersOf(template) {
  if (typeof template !== 'string') return [];
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]))];
}

/**
 * Fill a template with every substitution passed through `escape`.
 * @param {string} template
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} values
 * @param {(value: unknown, name: string) => string} escape
 * @returns {string}
 */
export function fillEscaped(template, args, values, escape) {
  if (typeof template !== 'string') return '';
  return template.replace(PLACEHOLDER, (match, name) =>
    escape(placeholderValue(name, args, values), name)
  );
}

/** URL path or query value: percent-encoded, a missing value is empty. */
export function encodeUrlValue(value) {
  return encodeURIComponent(asText(value));
}

/**
 * URL path value: percent-encoded like {@link encodeUrlValue}; `.` and `..`
 * are refused, because a URL parser resolves such a segment (even
 * percent-encoded) and the request would reach another path of the host.
 * @throws {Error} code `HTTP_TEMPLATE_URL`
 */
export function encodePathValue(value, name) {
  const text = asText(value);
  if (text === '.' || text === '..') {
    const error = new Error(`The value of "${name}" cannot be a path segment "${text}"`);
    error.code = 'HTTP_TEMPLATE_URL';
    throw error;
  }
  return encodeURIComponent(text);
}

/** JSON body value: the JSON of the value, `null` when missing. */
export function encodeJsonValue(value) {
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * Header value: the text, refused when it would end the header line.
 * @throws {Error} code `HTTP_TEMPLATE_HEADER` when the value holds CR or LF
 */
export function encodeHeaderValue(value, name) {
  const text = asText(value);
  if (/[\r\n]/.test(text)) {
    const error = new Error(
      `The value of "${name}" contains a line break and cannot go in a header`
    );
    error.code = 'HTTP_TEMPLATE_HEADER';
    throw error;
  }
  return text;
}

/** Whether a URL string is absolute http(s). */
export function isAbsoluteHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Join the base URL and an action's path without a doubled or missing slash.
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
export function joinUrl(baseUrl, path) {
  if (!baseUrl) return path;
  if (!path) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * The request an action sends, without auth (the adapter adds it).
 *
 * @param {Object} params
 * @param {Object} params.protocol - the definition's `http` protocol block
 * @param {Object} params.request - the action's `request` template
 * @param {Record<string, unknown>} params.args - the model's arguments
 * @param {Record<string, unknown>} params.values - the installation's install values
 * @param {(template: string, values: Record<string, unknown>) => string} params.fillBase -
 *   fills the base URL with install values
 * @returns {{ method: string, url: string, headers: Object<string,string>, body?: string }}
 * @throws {Error} code `HTTP_TEMPLATE_URL` for a URL that is not http(s),
 *   `HTTP_TEMPLATE_BODY` for a JSON body that is not JSON after substitution,
 *   `HTTP_TEMPLATE_HEADER` for a header value with a line break
 *
 * @example
 * buildHttpRequest({
 *   protocol: { baseUrl: 'https://api.example.com' },
 *   request: { method: 'GET', url: '/orders/{orderId}', query: { expand: '{expand}' } },
 *   args: { orderId: 'A/1' },
 *   values: {},
 *   fillBase: t => t
 * }); // { method: 'GET', url: 'https://api.example.com/orders/A%2F1', headers: {} }
 */
export function buildHttpRequest({ protocol = {}, request, args = {}, values = {}, fillBase }) {
  const method = request.method || 'GET';
  const path = fillEscaped(request.url, args, values, encodePathValue);
  const base = protocol.baseUrl ? fillBase(protocol.baseUrl, values) : '';
  const full = isAbsoluteHttpUrl(request.url) ? path : joinUrl(base, path);
  let url;
  try {
    url = new URL(full);
  } catch {
    url = null;
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    const error = new Error(`The request URL "${full}" is not an http(s) URL`);
    error.code = 'HTTP_TEMPLATE_URL';
    throw error;
  }
  // An absolute template's host is the admin's; an argument cannot move it
  // because every substitution is percent-encoded. The base URL's origin is
  // kept the same way for a relative path.
  for (const [name, template] of Object.entries(request.query || {})) {
    const names = placeholdersOf(template);
    const missing =
      names.length > 0 &&
      names.every(placeholder => placeholderValue(placeholder, args, values) === undefined);
    if (missing) continue;
    url.searchParams.append(
      name,
      fillEscaped(template, args, values, value => asText(value))
    );
  }

  const headers = {};
  for (const [name, template] of Object.entries(protocol.headers || {})) {
    const value = fillEscaped(template, {}, values, encodeHeaderValue);
    if (value) headers[name] = value;
  }
  for (const [name, template] of Object.entries(request.headers || {})) {
    const value = fillEscaped(template, args, values, encodeHeaderValue);
    if (value) headers[name] = value;
  }

  const out = { method, url: url.toString(), headers };
  if (request.body && !['GET', 'HEAD'].includes(method)) {
    const contentType = request.contentType || 'application/json';
    let body;
    if (contentType === 'application/json') {
      body = fillEscaped(request.body, args, values, encodeJsonValue);
      try {
        JSON.parse(body);
      } catch (error) {
        const failure = new Error(`The JSON body template is not valid JSON: ${error.message}`);
        failure.code = 'HTTP_TEMPLATE_BODY';
        throw failure;
      }
    } else if (contentType === 'application/x-www-form-urlencoded') {
      body = fillEscaped(request.body, args, values, encodeUrlValue);
    } else {
      body = fillEscaped(request.body, args, values, value => asText(value));
    }
    out.body = body;
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = contentType;
    }
  }
  return out;
}

/**
 * Apply an action's response mapping: `result` picks the part the model
 * sees, `fields` projects it (every element of a list) onto named paths.
 * Without a mapping the response is returned as it is.
 *
 * @param {unknown} data - the parsed response body
 * @param {{ result?: string, fields?: Object<string,string> }} [mapping]
 * @returns {unknown}
 *
 * @example
 * mapHttpResponse(
 *   { data: { items: [{ id: 1, attributes: { name: 'A' } }] } },
 *   { result: '$.data.items', fields: { id: 'id', name: 'attributes.name' } }
 * ); // [{ id: 1, name: 'A' }]
 */
export function mapHttpResponse(data, mapping) {
  if (!mapping || (data === null && !mapping.result)) return data;
  const picked = mapping.result ? valueAtPath(data, mapping.result) : data;
  const fields = mapping.fields && Object.keys(mapping.fields).length ? mapping.fields : null;
  if (!fields) return picked === undefined ? null : picked;
  const project = item => {
    if (item === null || typeof item !== 'object') return item;
    const out = {};
    for (const [name, path] of Object.entries(fields)) {
      const value = valueAtPath(item, path);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  if (Array.isArray(picked)) return picked.map(project);
  return picked === undefined ? null : project(picked);
}

/**
 * The parameter names an action's request uses that its parameter schema
 * does not declare and no install field provides. The builder shows them, so
 * a placeholder with a typo is found before a call sends an empty value.
 *
 * @param {Object} request
 * @param {Object} [parameters] - JSON schema
 * @param {string[]} [installKeys]
 * @returns {string[]}
 */
export function undeclaredPlaceholders(request, parameters, installKeys = []) {
  const declared = new Set([...Object.keys(parameters?.properties || {}), ...installKeys]);
  const used = [
    ...placeholdersOf(request?.url),
    ...Object.values(request?.query || {}).flatMap(placeholdersOf),
    ...Object.values(request?.headers || {}).flatMap(placeholdersOf),
    ...placeholdersOf(request?.body)
  ];
  return [...new Set(used)].filter(name => !declared.has(name));
}
