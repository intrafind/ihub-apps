// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `http` protocol: a custom integration whose actions are request
 * templates (method, URL with `{param}` placeholders, query, headers, body
 * template, JSONPath response mapping). The simplest way to wrap an internal
 * REST endpoint without code; built in **Admin → Integrations → Add
 * manually** (04-architecture §1.1).
 *
 * Outbound calls (CLAUDE.md "Outbound Connections"):
 *
 * - every request goes through the SSRF guard with the integrations file's
 *   `security` (`blockPrivateIps`, `allowedHosts`) and the platform-wide
 *   `ssrf.allowedHosts`;
 * - a direct request is sent by `safeFetch`, which resolves the host once,
 *   refuses a private address and pins the connection to the checked
 *   address; certificate checks follow `ssl.domainWhitelist`
 *   (`getTlsBypassOptions`);
 * - a request the proxy settings route through the proxy is checked with
 *   `assertSafeHost` and sent by `httpFetch`, which applies the proxy and the
 *   same certificate whitelist (the proxy resolves the name, so there is no
 *   address to pin);
 * - redirects are never followed: a 3xx answer is reported as an error, so a
 *   checked host cannot hand the call on to an internal one.
 *
 * Template escaping and the response mapping live in `httpTemplates.js`.
 */
import credentialService from '../../../CredentialService.js';
import { serviceAccountHeaders } from '../../auth/ServiceAccountAuth.js';
import { safeFetch, assertSafeHost } from '../../../mcp/safeFetch.js';
import { httpFetch, describeProxyRouting } from '../../../../utils/httpConfig.js';
import logger from '../../../../utils/logger.js';
import { effectiveValues, localized } from '../../definitions/installedValues.js';
import { fillTemplate } from '../../definitions/valuePaths.js';
import { actionRequirementsMet, applyActionDefaults } from '../enforcement.js';
import { toolIdFor, actionEnabled, testResult } from '../common.js';
import { buildHttpRequest, mapHttpResponse } from './httpTemplates.js';

const COMPONENT = 'HttpAdapter';

/** Sign-in modes the adapter can send: none, or one shared credential. */
export const supportedAuthModes = ['none', 'service-account'];

/** The credential store, the default source of a service account's secret. */
const storedSecret = ref => credentialService.resolveSecret(ref);

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, required: [] });

/** Side effect of an HTTP method, as the builder proposes it. */
export function sideEffectOfMethod(method) {
  switch (String(method || '').toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'DELETE':
      return 'destructive';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write';
    default:
      return 'unknown';
  }
}

/**
 * The auth headers and query parameter of an installation's shared credential.
 * @returns {Promise<{ headers: Object<string,string>, queryParam: {name: string, value: string}|null }>}
 */
async function authFor(definition, instance, values, resolveSecret, ssrfOpts) {
  const mode = instance.auth?.mode || 'none';
  if (mode !== 'service-account') return { headers: {}, queryParam: null };
  const ref = instance.auth?.credentialRef;
  if (!ref) throw new Error(`Integration ${instance.id}: service account without credential`);
  const account = definition.auth.serviceAccount || {};
  const kind = account.kind || 'header';
  if (kind === 'credential' && resolveSecret === storedSecret) {
    // Lazy: the runner pulls in the OpenAPI parser, which an http-only call never needs.
    const { resolveCredentialAuth } = await import('../../../tools/OpenApiToolRunner.js');
    return resolveCredentialAuth(ref, ssrfOpts);
  }
  const secret = resolveSecret(ref);
  if (secret === undefined || secret === null || secret === '') {
    throw new Error(`Integration ${instance.id}: the credential "${ref}" holds no secret`);
  }
  return {
    headers: serviceAccountHeaders({
      secret,
      serviceAccount: account,
      fillTemplate: template => fillTemplate(template, values)
    }),
    queryParam: null
  };
}

/** SSRF options from the integrations file's `security` block. */
function ssrfOptionsOf(security) {
  return {
    blockPrivateIps: security?.blockPrivateIps !== false,
    allowHosts: Array.isArray(security?.allowedHosts) ? security.allowedHosts : []
  };
}

/**
 * Send one request through the SSRF guard (see the module docs). Exported for
 * the tests, which check the guard, the proxy routing and the certificate
 * whitelist on this exact path.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ blockPrivateIps: boolean, allowHosts: string[] }} ssrfOpts
 * @returns {Promise<Response>}
 */
export async function sendGuarded(url, init, ssrfOpts) {
  const request = { ...init, redirect: 'manual' };
  if (describeProxyRouting(url).decision === 'proxied') {
    await assertSafeHost(new URL(url).hostname, ssrfOpts.allowHosts, ssrfOpts.blockPrivateIps);
    return httpFetch(url, request);
  }
  // SSRF is mitigated by safeFetch: DNS is resolved once, private addresses
  // are refused (unless allow-listed) and the socket is pinned to the
  // checked address. The URL is the admin's template; the model's arguments
  // only fill percent-encoded placeholders in it.
  return safeFetch(url, request, ssrfOpts); // codeql[js/request-forgery]
}

/** Read a response body as text, at most `maxBytes` (the rest is cut, flagged). */
async function readCapped(response, maxBytes) {
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true
  };
}

function headerOf(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/** The body as JSON when it is JSON, else the text. */
function parseBody(text, contentType) {
  const looksJson = /json/i.test(contentType || '') || /^\s*[[{]/.test(text);
  if (!looksJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The actions of an installation as the model sees them.
 */
export async function discoverActions({
  definition,
  instance,
  language = 'en',
  includeUnavailable = true
}) {
  const values = effectiveValues(definition, instance);
  const out = [];
  for (const action of definition.actions || []) {
    const requirementsMet = actionRequirementsMet(action, values);
    const enabled = actionEnabled(instance, action);
    const available = requirementsMet && enabled;
    if (!available && !includeUnavailable) continue;
    const override = instance.actions?.overrides?.[action.name] || {};
    out.push({
      name: action.name,
      toolId: toolIdFor(instance.id, action.name, action),
      title: localized(action.title, language, action.name),
      description:
        localized(override.description, language) ||
        localized(action.description, language, action.name),
      parameters: action.parameters || EMPTY_SCHEMA,
      sideEffect: override.sideEffect || action.sideEffect || 'unknown',
      dataFlow: override.dataFlow || action.dataFlow || 'external',
      enabledByDefault: action.enabledByDefault !== false,
      bindExplicitly: action.bindExplicitly === true,
      enabled,
      requirementsMet,
      needsToken: false,
      available,
      guidance: localized(action.guidance, language, ''),
      examples: (action.examples || []).map(e => localized(e, language, '')).filter(Boolean)
    });
  }
  return out;
}

/**
 * Run one action: fill the template, add the shared credential, send it
 * through the guard and map the response.
 *
 * @returns {Promise<unknown>} the mapped response, or `{ error: true, status?, message }`
 */
export async function run({
  definition,
  instance,
  action,
  args = {},
  security,
  resolveSecret = storedSecret
}) {
  const values = effectiveValues(definition, instance);
  const protocol = definition.protocol;
  const callArgs = { ...args };
  applyActionDefaults(callArgs, action.defaults, values);
  for (const [key, prop] of Object.entries(action.parameters?.properties || {})) {
    if (callArgs[key] === undefined && prop && prop.default !== undefined) {
      callArgs[key] = prop.default;
    }
  }

  const built = buildHttpRequest({
    protocol,
    request: action.request,
    args: callArgs,
    values,
    fillBase: (template, vals) => fillTemplate(template, vals)
  });
  const ssrfOpts = ssrfOptionsOf(security);
  const auth = await authFor(definition, instance, values, resolveSecret, ssrfOpts);
  const url = new URL(built.url);
  if (auth.queryParam) url.searchParams.append(auth.queryParam.name, auth.queryParam.value);

  const timeoutMs = action.timeoutMs || instance.timeoutMs || protocol.timeoutMs || 30000;
  const maxBytes = action.maxResponseBytes || protocol.maxResponseBytes || 262144;
  logger.info('HTTP integration request', {
    component: COMPONENT,
    instanceId: instance.id,
    action: action.name,
    method: built.method,
    // Never the query: it may carry an API key.
    url: `${url.origin}${url.pathname}`
  });

  const response = await sendGuarded(
    url.toString(),
    {
      method: built.method,
      headers: { Accept: 'application/json', ...built.headers, ...auth.headers },
      ...(built.body !== undefined ? { body: built.body } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    },
    ssrfOpts
  );

  const status = response.status;
  if (status >= 300 && status < 400) {
    return {
      error: true,
      status,
      message: `The endpoint answered with a redirect (${status}); redirects are not followed`
    };
  }
  const { text, truncated } = await readCapped(response, maxBytes);
  const body = parseBody(text, headerOf(response, 'content-type'));
  if (status < 200 || status >= 300) {
    return {
      error: true,
      status,
      message:
        (body && typeof body === 'object' && (body.message || body.error)) ||
        (typeof body === 'string' && body.slice(0, 500)) ||
        response.statusText ||
        `HTTP ${status}`
    };
  }
  if (truncated) {
    return { truncated: true, note: `Response truncated at ${maxBytes} bytes`, data: text };
  }
  return mapHttpResponse(body, action.response);
}

/**
 * Test an installation (saved or a draft): the settings, then the declared
 * health action or the first read action that needs no argument.
 */
export async function test({ definition, instance, security, language = 'en', resolveSecret }) {
  const started = Date.now();
  const steps = [];
  const push = (id, label, status, message, extra = {}) =>
    steps.push({ id, label, status, message, ...extra });
  const values = effectiveValues(definition, instance);
  if (definition.protocol.baseUrl) {
    const base = fillTemplate(definition.protocol.baseUrl, values);
    if (!/^https?:\/\//i.test(base)) {
      push('settings', 'Request settings', 'fail', `Base URL "${base}" is not an http(s) URL`);
      return testResult(steps, started);
    }
    push('settings', 'Request settings', 'ok', base);
  } else {
    push('settings', 'Request settings', 'ok', 'Each action names its own URL');
  }

  const health = definition.health;
  const probe =
    (health && definition.actions.find(a => a.name === health.action)) ||
    definition.actions.find(
      a =>
        a.sideEffect === 'read' &&
        actionRequirementsMet(a, values) &&
        (a.parameters?.required || []).length === 0
    );
  if (!probe) {
    push('probe', 'Probe action', 'skip', 'No read action without required arguments to probe');
  } else {
    const probeStarted = Date.now();
    try {
      const result = await run({
        definition,
        instance,
        action: probe,
        args: { ...(health?.args || {}) },
        security,
        ...(resolveSecret ? { resolveSecret } : {})
      });
      const durationMs = Date.now() - probeStarted;
      if (result && result.error) {
        push('probe', `Action ${probe.name}`, 'fail', result.message, {
          durationMs,
          details: result
        });
      } else {
        push('probe', `Action ${probe.name}`, 'ok', 'Answered', { durationMs });
      }
    } catch (error) {
      push('probe', `Action ${probe.name}`, 'fail', error.message, {
        durationMs: Date.now() - probeStarted,
        hints:
          error.code === 'SSRF_BLOCKED'
            ? ['The host resolves to a private address. Allow it under security.allowedHosts.']
            : undefined
      });
    }
  }
  const actions = await discoverActions({ definition, instance, language });
  return testResult(steps, started, {
    actionCount: actions.filter(a => a.available).length,
    successMessage: 'Integration reachable'
  });
}

/** The `http` protocol declares no scopes. */
export async function listScopes() {
  return [];
}
