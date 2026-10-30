// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  runOpenApiTool,
  getOpenApiToolParameters,
  invalidateToolsWithPrefix
} from '../../../tools/OpenApiToolRunner.js';
import credentialService from '../../../CredentialService.js';
import logger from '../../../../utils/logger.js';
import { effectiveValues, localized } from '../../definitions/installedValues.js';
import { fillTemplate, valueAtPath } from '../../definitions/valuePaths.js';
import {
  applyActionDefaults,
  applyScope,
  actionRequirementsMet,
  shapeParametersForModel
} from '../enforcement.js';

/**
 * The `openapi` adapter: a definition's actions are operations of an OpenAPI
 * document; each installation contributes the base URL, static headers, an
 * optional shared secret and the enforced defaults. The HTTP work is done by
 * the existing `OpenApiToolRunner` (SSRF guard, throttling, size caps,
 * `hideFields`); this module shapes what goes in (template substitution,
 * enforced values, the chat's scope) and what comes out (the response
 * envelope, source URLs).
 */

const COMPONENT = 'OpenApiAdapter';

/** Tool id of an action: `<instanceId>__<action>`. */
export function toolIdFor(instanceId, actionName) {
  return `${instanceId}__${actionName}`;
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The credential store, the default source of a service account's secret. */
const storedSecret = ref => credentialService.resolveSecret(ref);

/**
 * Resolve the installation's base URL, static headers and the auth header.
 * Secrets are read from the credential store here (or from `resolveSecret`,
 * which the test of an unsaved instance passes for its inline secret) and
 * never stored.
 */
function resolveRequestSettings(definition, instance, values, resolveSecret = storedSecret) {
  const protocol = definition.protocol;
  // "{baseUrl}{apiPath}" with a URL that ends in "/" and a path that starts
  // with one gives an interior "//", which many portals answer with 404.
  const baseUrl = fillTemplate(protocol.baseUrl, values)
    .replace(/(^[a-z][a-z0-9+.-]*:\/\/[^/]+)|\/{2,}/gi, (match, origin) => origin || '/')
    .replace(/\/+$/, '');
  if (!isHttpUrl(baseUrl)) {
    throw new Error(`Integration ${instance.id}: base URL "${baseUrl}" is not an http(s) URL`);
  }

  const headers = {};
  for (const [name, template] of Object.entries(protocol.headers || {})) {
    const value = fillTemplate(template, values);
    if (value) headers[name] = value;
  }

  const mode = instance.auth?.mode || 'none';
  if (mode === 'service-account') {
    const ref = instance.auth?.credentialRef;
    if (!ref) throw new Error(`Integration ${instance.id}: service account without credential`);
    const secret = resolveSecret(ref);
    const account = definition.auth.serviceAccount || {};
    const kind = account.kind || 'header';
    const prefix = account.valuePrefix || '';
    if (kind === 'bearer') {
      headers.Authorization = `Bearer ${secret}`;
    } else if (kind === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(String(secret)).toString('base64')}`;
    } else {
      const headerName = fillTemplate(account.header || 'Authorization', values) || 'Authorization';
      headers[headerName] = `${prefix}${secret}`;
    }
  }

  return { baseUrl, headers };
}

/**
 * The synthetic `type: "openapi"` tool the runner executes for one action.
 */
function buildRunnerTool(definition, instance, document, action, settings, security) {
  const protocol = definition.protocol;
  return {
    id: toolIdFor(instance.id, action.name),
    type: 'openapi',
    name: action.name,
    openapi: {
      source: { type: 'inline', spec: document },
      operationId: action.operationId,
      baseUrl: settings.baseUrl,
      headers: settings.headers,
      xDisplay: { hideFields: action.hideFields || [] },
      maxResponseBytes: action.maxResponseBytes || protocol.maxResponseBytes || 262144,
      timeoutMs: action.timeoutMs || instance.timeoutMs || protocol.timeoutMs || 30000,
      security: {
        blockPrivateIps: security?.blockPrivateIps !== false,
        allowedHosts: security?.allowedHosts || []
      },
      arrayStyle:
        protocol.arrayParameterStyle === 'openapi' ? 'openapi' : protocol.arrayParameterStyle
    }
  };
}

/**
 * Sources declaration for an action as the Answer Sources producer expects
 * it (`services/sources/producers/declared.js`), with the template URL
 * routed through the `portalUrl` field `run()` adds to every hit.
 */
function sourcesDeclarationFor(definition, instance, action) {
  const mapping = definition.sources?.[action.name];
  if (!mapping) return undefined;
  const { urlTemplate, ...declaration } = mapping;
  const fields = { ...(declaration.fields || {}) };
  if (urlTemplate && !fields.url) fields.url = 'portalUrl';
  return {
    provider: declaration.provider || instance.id,
    ...declaration,
    fields
  };
}

function actionEnabled(instance, action) {
  const policy = instance.actions || {};
  if ((policy.disabled || []).includes(action.name)) return false;
  const enabled = policy.enabled || ['*'];
  if (enabled.includes(action.name)) return true;
  return enabled.includes('*') && action.enabledByDefault !== false;
}

/**
 * The actions of an installation as the model will see them.
 *
 * @param {object} params
 * @param {object} params.definition
 * @param {object} params.instance
 * @param {object} params.document - parsed OpenAPI document
 * @param {object} [params.security] - the integrations file's `security` block
 * @param {string} [params.language]
 * @param {boolean} [params.includeUnavailable] - also return actions the installation disables or whose requirements fail
 */
export async function discoverActions({
  definition,
  instance,
  document,
  language = 'en',
  includeUnavailable = false
}) {
  const values = effectiveValues(definition, instance);
  const results = [];
  for (const action of definition.actions || []) {
    const requirementsMet = actionRequirementsMet(action, values);
    const enabled = actionEnabled(instance, action);
    const needsToken = action.connection === 'token' && (instance.auth?.mode || 'none') === 'none';
    const available = requirementsMet && enabled && !needsToken;
    if (!available && !includeUnavailable) continue;

    let parameters = { type: 'object', properties: {}, required: [] };
    let description = localized(action.description, language);
    let parameterError = null;
    try {
      const probe = {
        id: `${toolIdFor(instance.id, action.name)}::schema`,
        openapi: { source: { type: 'inline', spec: document }, operationId: action.operationId }
      };
      const derived = await getOpenApiToolParameters(probe);
      parameters = shapeParametersForModel(derived, action.defaults, values);
      if (!description) {
        const op = findOperation(document, action.operationId);
        description = op?.summary || op?.description || action.name;
      }
    } catch (error) {
      parameterError = error.message;
      logger.warn('Integration action has no usable operation', {
        component: COMPONENT,
        instanceId: instance.id,
        action: action.name,
        operationId: action.operationId,
        error: error.message
      });
    }

    const override = instance.actions?.overrides?.[action.name] || {};
    results.push({
      name: action.name,
      operationId: action.operationId,
      toolId: toolIdFor(instance.id, action.name),
      title: localized(action.title, language, action.name),
      description: localized(override.description, language) || description,
      parameters,
      sideEffect: override.sideEffect || action.sideEffect || 'unknown',
      dataFlow: action.dataFlow || 'external',
      enabledByDefault: action.enabledByDefault !== false,
      enabled,
      requirementsMet,
      needsToken,
      available: available && !parameterError,
      error: parameterError,
      guidance: localized(action.guidance, language),
      examples: (action.examples || []).map(e => localized(e, language)).filter(Boolean),
      sources: sourcesDeclarationFor(definition, instance, action)
    });
  }
  return results;
}

function findOperation(document, operationId) {
  for (const pathItem of Object.values(document?.paths || {})) {
    for (const op of Object.values(pathItem || {})) {
      if (op && typeof op === 'object' && op.operationId === operationId) return op;
    }
  }
  return null;
}

/**
 * Unwrap a response envelope. Returns `{ ok, value }` where `value` is what
 * the model should see.
 */
function unwrapEnvelope(envelope, data) {
  if (!envelope || data === null || typeof data !== 'object') return { ok: true, value: data };
  if (envelope.success) {
    const success = valueAtPath(data, envelope.success);
    if (success === false) {
      return {
        ok: false,
        value: {
          error: true,
          type: envelope.errorType ? valueAtPath(data, envelope.errorType) : undefined,
          message: envelope.error ? valueAtPath(data, envelope.error) : undefined,
          details: envelope.error ? undefined : data
        }
      };
    }
  }
  if (envelope.result) {
    const result = valueAtPath(data, envelope.result);
    if (result !== undefined) return { ok: true, value: result };
  }
  return { ok: true, value: data };
}

/** Add `portalUrl` to every hit the sources mapping lists. */
function addSourceUrls(mapping, value, values) {
  if (!mapping?.urlTemplate || value === null || typeof value !== 'object') return value;
  const listed = valueAtPath(value, mapping.list);
  const hits = Array.isArray(listed)
    ? listed
    : listed && typeof listed === 'object'
      ? [listed]
      : [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object' || hit.portalUrl) continue;
    const url = fillTemplate(mapping.urlTemplate, { ...values, ...hit }, { encode: false });
    if (isHttpUrl(url)) hit.portalUrl = url;
  }
  return value;
}

/**
 * Run one action.
 *
 * @param {object} params
 * @param {object} params.definition
 * @param {object} params.instance
 * @param {object} params.document
 * @param {object} params.action - the definition's action entry
 * @param {Record<string, unknown>} params.args - the model's arguments (context keys removed)
 * @param {object} [params.context] - `{ scope?: { id, name } }`
 * @param {object} [params.security]
 */
export async function run({
  definition,
  instance,
  document,
  action,
  args = {},
  context = {},
  security,
  resolveSecret
}) {
  const values = effectiveValues(definition, instance);
  const callArgs = { ...args };
  applyActionDefaults(callArgs, action.defaults, values);
  applyScope(callArgs, definition.scopes, action.name, context.scope, values);

  const settings = resolveRequestSettings(definition, instance, values, resolveSecret);
  const tool = buildRunnerTool(definition, instance, document, action, settings, security);
  const raw = await runOpenApiTool(tool, callArgs, {});

  if (raw && raw.rateLimited) return raw;
  const envelope = definition.protocol.responseEnvelope;
  if (raw && raw.error === true && 'status' in raw) {
    // HTTP error: still try to read the API's own message from the body.
    const unwrapped = unwrapEnvelope(envelope, raw.body);
    const message =
      (!unwrapped.ok && unwrapped.value.message) ||
      (typeof raw.body === 'string' ? raw.body.slice(0, 500) : undefined);
    return {
      error: true,
      status: raw.status,
      type: !unwrapped.ok ? unwrapped.value.type : undefined,
      message: message || raw.statusText || `HTTP ${raw.status}`
    };
  }

  const unwrapped = unwrapEnvelope(envelope, raw);
  if (!unwrapped.ok) return unwrapped.value;
  return addSourceUrls(definition.sources?.[action.name], unwrapped.value, values);
}

/**
 * Test an installation before it is saved or on demand: run the declared
 * health action (or the first read action without required parameters) and
 * report in the shape `IntegrationTestResults` renders.
 */
export async function test({
  definition,
  instance,
  document,
  security,
  language = 'en',
  resolveSecret
}) {
  const steps = [];
  const started = Date.now();
  const push = (id, label, status, message, extra = {}) =>
    steps.push({ id, label, status, message, ...extra });

  let values;
  try {
    values = effectiveValues(definition, instance);
    const settings = resolveRequestSettings(definition, instance, values, resolveSecret);
    push('settings', 'Request settings', 'ok', settings.baseUrl, {
      details: { baseUrl: settings.baseUrl, headers: Object.keys(settings.headers) }
    });
  } catch (error) {
    push('settings', 'Request settings', 'fail', error.message);
    return finish(steps, started);
  }

  const health = definition.health;
  const action =
    (health && definition.actions.find(a => a.name === health.action)) ||
    definition.actions.find(a => a.sideEffect === 'read' && actionRequirementsMet(a, values));
  if (!action) {
    push('probe', 'Probe action', 'skip', 'No read action to probe');
    return finish(steps, started);
  }

  const probeStarted = Date.now();
  try {
    const result = await run({
      definition,
      instance,
      document,
      action,
      resolveSecret,
      args: { ...(health?.args || {}) },
      security
    });
    const durationMs = Date.now() - probeStarted;
    if (result && result.error) {
      push(
        'probe',
        `Action ${action.name}`,
        'fail',
        result.message || 'The portal returned an error',
        {
          details: result,
          durationMs
        }
      );
    } else {
      const summaryText = describeProbeResult(result);
      push('probe', `Action ${action.name}`, 'ok', summaryText, { durationMs, details: result });
    }
  } catch (error) {
    push('probe', `Action ${action.name}`, 'fail', error.message, {
      durationMs: Date.now() - probeStarted,
      hints:
        error.code === 'SSRF_BLOCKED'
          ? ['The host resolves to a private address. Allow it under security.allowedHosts.']
          : undefined
    });
  }

  const actions = await discoverActions({ definition, instance, document, security, language });
  push(
    'actions',
    'Actions',
    actions.length ? 'ok' : 'warn',
    `${actions.length} action(s) available to the model`,
    {
      details: actions.map(a => ({
        name: a.name,
        sideEffect: a.sideEffect,
        available: a.available
      }))
    }
  );
  return finish(steps, started, actions.length);
}

function describeProbeResult(result) {
  if (result === null || result === undefined) return 'Empty response';
  if (typeof result !== 'object') return String(result).slice(0, 200);
  if (typeof result.count === 'number') return `${result.count} result(s) reported`;
  if (Array.isArray(result)) return `${result.length} item(s)`;
  const keys = Object.keys(result);
  return keys.length ? `Response with ${keys.slice(0, 6).join(', ')}` : 'Empty object';
}

function finish(steps, started, actionCount) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const step of steps) summary[step.status] = (summary[step.status] || 0) + 1;
  const success = summary.fail === 0;
  return {
    success,
    message: success ? 'Integration reachable' : steps.find(s => s.status === 'fail')?.message,
    summary,
    steps,
    actionCount,
    durationMs: Date.now() - started
  };
}

/**
 * The scopes the definition offers (e.g. publishers of a portal).
 * @returns {Promise<Array<{ id: string, name: string, isDefault?: boolean }>>}
 */
export async function listScopes({ definition, instance, document, security }) {
  const scopes = definition.scopes;
  if (!scopes) return [];
  const action = definition.actions.find(a => a.name === scopes.action);
  if (!action) return [];
  const result = await run({ definition, instance, document, action, args: {}, security });
  if (!result || result.error) {
    throw new Error(result?.message || 'Could not list scopes');
  }
  const listed = valueAtPath(result, scopes.items);
  const items = Array.isArray(listed) ? listed : [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = valueAtPath(item, scopes.map.id);
    const name = valueAtPath(item, scopes.map.name);
    if (id === undefined || id === null || id === '') continue;
    out.push({
      id: String(id),
      name: name ? String(name) : String(id),
      isDefault: scopes.map.isDefault ? valueAtPath(item, scopes.map.isDefault) === true : undefined
    });
  }
  return out;
}

/**
 * Drop the cached operation schemas of one installation (after its config or
 * its definition changed), or of every installation when no id is given.
 * Only the `<instanceId>__*` entries go; other OpenAPI tools keep theirs.
 */
export function invalidate(instanceId) {
  invalidateToolsWithPrefix(instanceId ? toolIdFor(instanceId, '') : '');
}
