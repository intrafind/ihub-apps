import { promises as fs } from 'fs';
import { join, normalize, sep } from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
// js-yaml v5 is ESM-only with named exports — a default import throws
// "does not provide an export named 'default'" at module load time.
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml';
import { getRootDir } from '../../pathUtils.js';
import { safeFetch } from '../mcp/safeFetch.js';
import { throttledRun } from '../../requestThrottler.js';
import credentialService from '../CredentialService.js';
import logger from '../../utils/logger.js';

/**
 * Parse an OpenAPI document body that may be JSON or YAML. Probes for the
 * leading `{`/`[` to choose JSON, otherwise falls back to YAML. Uses
 * `JSON_SCHEMA` so only JSON-compatible types (strings, numbers, booleans,
 * null, arrays, objects) are constructed — no custom YAML tags can produce
 * unexpected types from operator-supplied input. `json: true` makes duplicate
 * keys take the last value (matches JSON semantics).
 */
export function parseOpenApiText(text) {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(text);
  }
  return parseYaml(text, { schema: JSON_SCHEMA, json: true });
}

/**
 * Generic OpenAPI HTTP tool runner (issue #1462).
 *
 * Parses an OpenAPI document, derives the LLM-facing parameter schema for a
 * single operation, and at call time builds + performs an SSRF-guarded HTTP
 * request (auth resolved from the central credential store), then sanitises
 * the response (x-display stripping, size cap, pagination, 429 retry).
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const URL_SPEC_TTL_MS = 60 * 60 * 1000; // re-fetch URL specs at most hourly
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 50;

// source-key -> { spec, parsedAt }
const specCache = new Map();
// tool.id -> { parameters, paramMap }
const paramCache = new Map();
// credentialRef -> { token, expiry }
const oauthCache = new Map();

function sourceKey(source) {
  if (source.type === 'url') return `url:${source.url}`;
  if (source.type === 'file') return `file:${source.path}`;
  // Key inline specs by their content directly. (No crypto hash: the spec is
  // not a secret and a content-addressed Map key needs no digest.)
  const raw = typeof source.spec === 'string' ? source.spec : JSON.stringify(source.spec);
  return `inline:${raw}`;
}

/**
 * Load the raw OpenAPI document for a source without dereferencing.
 * URL sources go through safeFetch (SSRF guard); file sources are confined to
 * the contents/ directory; inline sources are parsed directly.
 */
async function _parseSource(source, ssrfOpts) {
  if (source.type === 'url') {
    const res = await safeFetch(source.url, { method: 'GET' }, ssrfOpts);
    if (!res.ok) throw new Error(`Failed to fetch OpenAPI doc: ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_SPEC_BYTES) {
      throw new Error('OpenAPI document exceeds the 2MB size limit');
    }
    return parseOpenApiText(text);
  }
  if (source.type === 'file') {
    const root = getRootDir();
    const contentsDir = normalize(join(root, 'contents'));
    const resolved = normalize(join(contentsDir, source.path));
    // Confine to contentsDir. The trailing-separator check prevents a sibling
    // like `/.../contents2` from passing a naive startsWith(`/.../contents`).
    if (resolved !== contentsDir && !resolved.startsWith(contentsDir + sep)) {
      throw new Error('OpenAPI file path escapes the contents directory');
    }
    const text = await fs.readFile(resolved, 'utf8');
    return parseOpenApiText(text);
  }
  // inline
  return typeof source.spec === 'string' ? parseOpenApiText(source.spec) : source.spec;
}

/**
 * Parse + dereference an OpenAPI document into a fully-resolved spec object.
 */
async function _parseSpec(source, ssrfOpts) {
  const raw = await _parseSource(source, ssrfOpts);
  // Dereference the in-memory object. external:false disables resolution of
  // external $refs (remote URLs / local files), so dereferencing cannot trigger
  // unguarded outbound fetches or file reads — only internal $refs are resolved.
  return await SwaggerParser.dereference(raw, { resolve: { external: false } });
}

/**
 * Flatten a spec's paths into a list of operation descriptors.
 */
function _parseOperations(spec) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const parameters = [...sharedParams, ...(op.parameters || [])];
      operations.push({
        operationId: op.operationId,
        method,
        path,
        summary: op.summary || op.description || '',
        parameters,
        hasRequestBody: Boolean(op.requestBody),
        operation: op
      });
    }
  }
  return operations;
}

/**
 * Resolve a single operation by operationId.
 */
function _parseOperationById(spec, operationId) {
  const op = _parseOperations(spec).find(o => o.operationId === operationId);
  if (!op) throw new Error(`operationId "${operationId}" not found in OpenAPI document`);
  return op;
}

function ssrfOptsFor(tool) {
  const security = tool.openapi?.security || {};
  return {
    allowHosts: security.allowedHosts || [],
    blockPrivateIps: security.blockPrivateIps !== false
  };
}

/**
 * Load + cache the dereferenced spec for a tool.
 */
async function loadSpec(tool) {
  const source = tool.openapi.source;
  const key = sourceKey(source);
  const cached = specCache.get(key);
  if (cached) {
    if (source.type !== 'url' || Date.now() - cached.parsedAt < URL_SPEC_TTL_MS) {
      return cached.spec;
    }
  }
  const spec = await _parseSpec(source, ssrfOptsFor(tool));
  specCache.set(key, { spec, parsedAt: Date.now() });
  return spec;
}

function jsonSchemaForParam(param) {
  const schema = param.schema ? { ...param.schema } : { type: 'string' };
  if (param.description && !schema.description) schema.description = param.description;
  return schema;
}

/**
 * Derive the LLM-facing JSON schema for a tool's operation and remember where
 * each argument belongs (path/query/header/body). Memoised per tool id.
 */
export async function getOpenApiToolParameters(tool) {
  if (paramCache.has(tool.id)) return paramCache.get(tool.id).parameters;

  const spec = await loadSpec(tool);
  const { operation, parameters } = _parseOperationById(spec, tool.openapi.operationId);

  const properties = {};
  const required = [];
  const paramMap = {};

  for (const param of parameters) {
    if (!param || !param.name) continue;
    properties[param.name] = jsonSchemaForParam(param);
    paramMap[param.name] = { in: param.in };
    if (param.required) required.push(param.name);
  }

  // Request body (application/json)
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    const bodyRequired = operation.requestBody.required;
    if (bodySchema.type === 'object' && bodySchema.properties) {
      // Flatten a simple object body into top-level args.
      for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
        if (properties[propName]) continue; // a path/query param wins the name
        properties[propName] = propSchema;
        paramMap[propName] = { in: 'body', bodyProp: propName };
      }
      for (const r of bodySchema.required || []) {
        if (!required.includes(r)) required.push(r);
      }
    } else {
      // Complex/array body nested under `body`.
      properties.body = bodySchema;
      paramMap.body = { in: 'body', whole: true };
      if (bodyRequired) required.push('body');
    }
  }

  const parametersSchema = { type: 'object', properties, required };
  paramCache.set(tool.id, { parameters: parametersSchema, paramMap });
  return parametersSchema;
}

async function getParamMap(tool) {
  if (!paramCache.has(tool.id)) await getOpenApiToolParameters(tool);
  return paramCache.get(tool.id).paramMap;
}

/**
 * Resolve the auth headers (and optional query param) for a tool's credential.
 */
async function resolveAuth(tool) {
  const ref = tool.openapi.auth?.credentialRef;
  // Public APIs have no credentialRef; skip auth resolution entirely.
  if (!ref) return { headers: {}, queryParam: null };
  const profile = credentialService.resolve(ref);
  const headers = {};
  let queryParam = null;

  switch (profile.type) {
    case 'bearer':
      headers.Authorization = `Bearer ${profile.token}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString('base64')}`;
      break;
    case 'apiKeyHeader':
      headers[profile.headerName] = profile.key;
      break;
    case 'apiKeyQuery':
      queryParam = { name: profile.paramName, value: profile.key };
      break;
    case 'oauth2':
      headers.Authorization = `Bearer ${await getOAuthToken(ref, profile, ssrfOptsFor(tool))}`;
      break;
    case 'secret':
      // Opaque secret with no request-auth mapping; treat as a bearer token.
      headers.Authorization = `Bearer ${profile.value}`;
      break;
    default:
      break;
  }
  return { headers, queryParam };
}

async function getOAuthToken(ref, profile, ssrfOpts) {
  const cached = oauthCache.get(ref);
  if (cached && cached.expiry > Date.now() + 5000) return cached.token;

  const body = new URLSearchParams({ grant_type: profile.grantType || 'client_credentials' });
  body.set('client_id', profile.clientId);
  body.set('client_secret', profile.clientSecret);
  if (profile.scope) body.set('scope', profile.scope);
  if (profile.grantType === 'refresh_token' && profile.refreshToken) {
    body.set('refresh_token', profile.refreshToken);
  }

  const res = await safeFetch(
    profile.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    ssrfOpts
  );
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status}`);
  const data = await res.json();
  const expiresInMs = data.expires_in ? data.expires_in * 1000 : 3600000;
  oauthCache.set(ref, { token: data.access_token, expiry: Date.now() + expiresInMs });
  return data.access_token;
}

/**
 * Strip dot-path fields (supporting `items[].field` array wildcards) from an
 * object before it is returned to the LLM.
 */
function stripPaths(obj, paths) {
  for (const path of paths || []) {
    stripPath(obj, path.split('.'));
  }
  return obj;
}

function stripPath(node, segments) {
  if (node == null || segments.length === 0) return;
  const [seg, ...rest] = segments;
  const arrayMatch = seg.endsWith('[]');
  const key = arrayMatch ? seg.slice(0, -2) : seg;

  const target = key === '' ? node : node[key];
  if (target === undefined) return;

  if (arrayMatch) {
    if (!Array.isArray(target)) return;
    if (rest.length === 0) {
      node[key] = [];
    } else {
      for (const item of target) stripPath(item, rest);
    }
    return;
  }

  if (rest.length === 0) {
    delete node[key];
  } else {
    stripPath(target, rest);
  }
}

function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (!Number.isNaN(secs)) return Math.min(secs, 30) * 1000;
  const date = Date.parse(headerVal);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 30000);
  return null;
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

/**
 * Build the request URL + init for a tool call.
 */
async function buildRequest(tool, params) {
  const spec = await loadSpec(tool);
  const { method, path, operation } = _parseOperationById(spec, tool.openapi.operationId);
  const paramMap = await getParamMap(tool);

  // Apply OpenAPI defaults + validate required.
  const properties = paramCache.get(tool.id).parameters.properties;
  const required = paramCache.get(tool.id).parameters.required || [];
  const args = { ...params };
  for (const [name, schema] of Object.entries(properties)) {
    if (args[name] === undefined && schema && schema.default !== undefined) {
      args[name] = schema.default;
    }
  }
  const missing = required.filter(r => args[r] === undefined || args[r] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required parameter(s): ${missing.join(', ')}`);
  }

  // Resolve base URL.
  const baseUrl = tool.openapi.baseUrl || spec.servers?.[0]?.url;
  if (!baseUrl)
    throw new Error('No base URL: set openapi.baseUrl or a servers[] entry in the spec');

  // Substitute path params.
  let resolvedPath = path;
  const query = new URLSearchParams();
  const headers = { ...(tool.openapi.headers || {}) };
  let body;
  const bodyObj = {};

  for (const [name, value] of Object.entries(args)) {
    const placement = paramMap[name];
    if (!placement || value === undefined) continue;
    if (placement.in === 'path') {
      resolvedPath = resolvedPath.replace(`{${name}}`, encodeURIComponent(value));
    } else if (placement.in === 'query') {
      query.append(name, value);
    } else if (placement.in === 'header') {
      headers[name] = String(value);
    } else if (placement.in === 'body') {
      if (placement.whole) body = value;
      else bodyObj[placement.bodyProp] = value;
    }
  }
  if (body === undefined && Object.keys(bodyObj).length > 0) body = bodyObj;

  // Auth (headers and/or query param).
  const auth = await resolveAuth(tool);
  Object.assign(headers, auth.headers);
  if (auth.queryParam) query.append(auth.queryParam.name, auth.queryParam.value);

  const base = baseUrl.replace(/\/$/, '');
  const qs = query.toString();
  const url = `${base}${resolvedPath}${qs ? `?${qs}` : ''}`;

  const init = { method: method.toUpperCase(), headers };
  if (body !== undefined && method !== 'get' && method !== 'head') {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = JSON.stringify(body);
  }

  return { url, init, hasApiKeyQuery: Boolean(auth.queryParam), operation };
}

/**
 * Post-process a parsed response: strip hidden fields, paginate oversized
 * arrays, enforce the size cap.
 */
function postProcess(tool, data, params) {
  const { hideFields } = tool.openapi.xDisplay || {};
  if (hideFields && hideFields.length && data && typeof data === 'object') {
    stripPaths(data, hideFields);
  }

  const cap = tool.openapi.maxResponseBytes || 262144;

  // Oversized-array pagination.
  if (Array.isArray(data)) {
    const offset = Number(params.offset) || 0;
    const wantsPage = params.limit !== undefined || Buffer.byteLength(JSON.stringify(data)) > cap;
    if (wantsPage) {
      const limit = Number(params.limit) || DEFAULT_PAGE_LIMIT;
      const page = data.slice(offset, offset + limit);
      const nextOffset = offset + limit < data.length ? offset + limit : null;
      return {
        items: page,
        pagination: { returned: page.length, total: data.length, nextOffset }
      };
    }
  }

  // Size cap with truncation. Truncate by BYTES (cap is a byte budget): slice
  // the UTF-8 buffer so the result is guaranteed ≤ cap bytes even for
  // multi-byte content.
  const serialized = JSON.stringify(data);
  if (serialized && Buffer.byteLength(serialized) > cap) {
    return {
      truncated: true,
      note: `Response truncated at ${cap} bytes`,
      data: Buffer.from(serialized, 'utf8').subarray(0, cap).toString('utf8')
    };
  }
  return data;
}

async function performFetch(tool, url, init) {
  const ssrfOpts = ssrfOptsFor(tool);
  const timeoutMs = tool.openapi.timeoutMs || 30000;
  const run = () =>
    throttledRun(tool.id, () =>
      safeFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }, ssrfOpts)
    );

  let res = await run();
  if (res.status === 429) {
    const wait = parseRetryAfter(getHeader(res.headers, 'retry-after'));
    if (wait != null) {
      await new Promise(r => setTimeout(r, wait));
      res = await run();
    }
    if (res.status === 429) {
      return {
        rateLimited: true,
        error: 'rate_limited',
        retryAfter: getHeader(res.headers, 'retry-after') || null
      };
    }
  }
  return res;
}

/**
 * Execute one OpenAPI tool call.
 * @param {object} tool - Full tool definition (type: 'openapi')
 * @param {object} params - LLM-supplied arguments
 * @param {object} context - { chatId, user, appConfig }
 */
export async function runOpenApiTool(tool, params = {}, context = {}) {
  const built = await buildRequest(tool, params);
  // Never log the full URL when the API key rides in the query string.
  logger.info('OpenAPI tool request', {
    component: 'OpenApiToolRunner',
    toolId: tool.id,
    method: built.init.method,
    operationId: tool.openapi.operationId,
    url: built.hasApiKeyQuery ? '[redacted: apiKeyQuery]' : built.url.split('?')[0]
  });

  const result = await performFetch(tool, built.url, built.init);
  if (result && result.rateLimited) return result;

  const res = result;
  const contentType = getHeader(res.headers, 'content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    const body = typeof data === 'string' ? data.slice(0, 2048) : data;
    return { error: true, status: res.status, statusText: res.statusText, body };
  }

  return postProcess(tool, data, params);
}

/**
 * Drop cached specs/params/tokens (call after a tool definition changes).
 */
export function invalidateSpecCache(toolId) {
  if (toolId) {
    paramCache.delete(toolId);
    return;
  }
  specCache.clear();
  paramCache.clear();
  oauthCache.clear();
}

export default { runOpenApiTool, getOpenApiToolParameters, invalidateSpecCache };
