// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integration builder's draft and its rules, as pure functions (no React,
 * no I/O, no i18n): what a new draft looks like, how a source change resets
 * it, how imported operations, tools and skills become actions, what each
 * step still misses, and how the draft is cleaned before it is sent.
 *
 * The draft is the shape `POST /api/admin/integrations/builder` takes
 * (`server/validators/integrationBuilderSchema.js`). Error messages are
 * handed out as `{ key, defaultValue }` pairs; the components translate them.
 *
 * @module features/admin/components/integrations/builder/builderModel
 */

/** The sources an integration's actions can come from, in the order the builder offers them. */
export const BUILDER_SOURCES = Object.freeze(['openapi', 'http', 'script', 'mcp', 'a2a']);

/** The builder's steps, in order. */
export const BUILDER_STEPS = Object.freeze(['basics', 'signIn', 'source', 'actions', 'review']);

export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
export const HTTP_BODY_TYPES = Object.freeze([
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain'
]);
export const MCP_TRANSPORTS = Object.freeze(['streamableHttp', 'sse', 'websocket', 'stdio']);
export const SIDE_EFFECTS = Object.freeze(['read', 'write', 'destructive', 'unknown']);
export const DATA_FLOWS = Object.freeze(['internal', 'external']);

/**
 * Longest description for the model, per language: the same limit the action
 * detail has (server `MAX_ACTION_TEXT_LENGTH`). An MCP tool's or A2A skill's
 * description is stored as an override, which the server refuses above it.
 */
export const MAX_ACTION_DESCRIPTION_LENGTH = 4000;

/** Sources whose actions the definition declares (the others list them live). */
export const DECLARED_ACTION_SOURCES = Object.freeze(['openapi', 'http', 'script']);

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, required: [] });

/** The settings block a source starts with. */
export function sourceDefaults(source) {
  switch (source) {
    case 'openapi':
      return { document: null, baseUrl: '', headers: {} };
    case 'http':
      return { baseUrl: '', headers: {} };
    case 'script':
      return { module: '' };
    case 'mcp':
      return { transport: 'streamableHttp', url: '', headers: {}, command: '', args: [], env: {} };
    case 'a2a':
      return { cardUrl: '' };
    default:
      return {};
  }
}

/** A new, empty draft (the HTTP request source preselected). */
export function emptyDraft() {
  return {
    instanceId: '',
    name: { en: '' },
    description: { en: '' },
    icon: '',
    source: 'http',
    auth: { mode: 'none', kind: 'credential' },
    http: sourceDefaults('http'),
    actions: []
  };
}

/** The sign-in modes a source offers. */
export function authModesFor(source) {
  if (source === 'mcp') return ['none', 'service-account', 'oauth-user'];
  if (source === 'script') return ['none'];
  return ['none', 'service-account'];
}

/** How a service account's credential can be sent for a source. */
export function authKindsFor(source) {
  if (source === 'mcp' || source === 'a2a') return ['bearer', 'header'];
  return ['credential', 'bearer', 'header', 'basic'];
}

/**
 * The draft with another source: its settings block starts fresh, the
 * actions are dropped (they belong to the old source) and a sign-in the new
 * source does not offer falls back to none.
 */
export function withSource(draft, source) {
  const next = { ...draft, source, actions: [] };
  for (const key of BUILDER_SOURCES) delete next[key];
  next[source] = sourceDefaults(source);
  const modes = authModesFor(source);
  const auth = { ...draft.auth };
  if (!modes.includes(auth.mode)) auth.mode = 'none';
  if (!authKindsFor(source).includes(auth.kind)) auth.kind = authKindsFor(source)[0];
  next.auth = auth;
  return next;
}

/**
 * An installation id from a name: lower-case letters, digits and `-`, at
 * most 48 characters, starting with a letter or digit.
 * @example slugify('My ERP: Orders!') // 'my-erp-orders'
 */
export function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00df/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** Whether an installation id is one the builder accepts. */
export function isValidInstanceId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

/** An action name (letters, digits, `_`, starting with a letter) from any text. */
export function actionNameFrom(value) {
  let name = String(value || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(name)) name = `action_${name}`;
  return name.slice(0, 64);
}

/** Whether a name is a valid action name. */
export function isValidActionName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
}

/** The side effect an HTTP method suggests. */
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

/** A new HTTP request action. */
export function emptyHttpAction(existingNames = []) {
  let n = existingNames.length + 1;
  let name = `action_${n}`;
  while (existingNames.includes(name)) name = `action_${++n}`;
  return {
    name,
    description: { en: '' },
    sideEffect: 'read',
    dataFlow: 'external',
    enabled: true,
    parameters: { ...EMPTY_SCHEMA, properties: {}, required: [] },
    request: { method: 'GET', url: '', contentType: 'application/json' },
    response: { result: '', fields: {} }
  };
}

/** A new script action. */
export function emptyScriptAction(existingNames = []) {
  const base = emptyHttpAction(existingNames);
  return {
    name: base.name,
    description: base.description,
    sideEffect: 'unknown',
    dataFlow: 'internal',
    enabled: true,
    parameters: base.parameters
  };
}

/**
 * The actions of picked OpenAPI operations. An operation picked before keeps
 * what the admin set on it (name, description, side effect, data flow,
 * approval); a new one gets its name from the `operationId`, its description
 * from the summary and its side effect from the method.
 *
 * @param {Array<{operationId: string, method: string, summary?: string, sideEffect?: string}>} operations
 * @param {string[]} pickedIds - the picked `operationId`s
 * @param {Array<Object>} existing - the draft's current actions
 * @returns {Array<Object>}
 */
export function actionsFromOperations(operations, pickedIds, existing = []) {
  const byOperation = new Map(existing.map(action => [action.operationId, action]));
  const names = new Set();
  const out = [];
  for (const op of operations || []) {
    if (!op.operationId || !pickedIds.includes(op.operationId)) continue;
    const kept = byOperation.get(op.operationId);
    if (kept) {
      names.add(kept.name);
      out.push(kept);
      continue;
    }
    let name = actionNameFrom(op.operationId);
    for (let n = 2; names.has(name); n += 1) name = `${actionNameFrom(op.operationId)}_${n}`;
    names.add(name);
    out.push({
      name,
      operationId: op.operationId,
      description: op.summary ? { en: op.summary } : { en: '' },
      sideEffect: op.sideEffect || sideEffectOfMethod(op.method),
      dataFlow: 'external',
      enabled: true
    });
  }
  return out;
}

/**
 * The actions of an MCP server's tools or an A2A agent's skills, as the
 * import listed them. A tool listed before keeps what the admin set on it.
 */
export function actionsFromImport(imported, existing = []) {
  const byName = new Map(existing.map(action => [action.name, action]));
  return (imported || []).map(item => {
    const kept = byName.get(item.name);
    return {
      sideEffect: 'unknown',
      dataFlow: 'external',
      enabled: true,
      ...(kept || {}),
      name: item.name,
      title: item.title || item.name,
      remoteDescription: item.description || '',
      parameters: item.parameters
    };
  });
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** The `{name}` placeholders a template uses, each once. */
export function placeholdersOf(template) {
  if (typeof template !== 'string') return [];
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]))];
}

/** Every placeholder an HTTP request template uses (URL, query, headers, body). */
export function requestPlaceholders(request) {
  return [
    ...new Set([
      ...placeholdersOf(request?.url),
      ...Object.values(request?.query || {}).flatMap(placeholdersOf),
      ...Object.values(request?.headers || {}).flatMap(placeholdersOf),
      ...placeholdersOf(request?.body)
    ])
  ];
}

/** The placeholders the request uses that the parameter schema does not declare. */
export function undeclaredPlaceholders(request, parameters) {
  const declared = new Set(Object.keys(parameters?.properties || {}));
  return requestPlaceholders(request).filter(name => !declared.has(name));
}

/**
 * The parameter schema with a string parameter for every placeholder it did
 * not declare yet; the URL's placeholders are required (a path without its
 * value makes no sense).
 */
export function parametersFromPlaceholders(request, parameters) {
  const schema = {
    type: 'object',
    ...(parameters || {}),
    properties: { ...(parameters?.properties || {}) },
    required: [...(parameters?.required || [])]
  };
  for (const name of undeclaredPlaceholders(request, parameters)) {
    schema.properties[name] = { type: 'string', description: name };
  }
  for (const name of placeholdersOf(request?.url)) {
    if (!schema.required.includes(name)) schema.required.push(name);
  }
  return schema;
}

/**
 * A connector module with a stub for every action, for a new script
 * integration: one bundled ES module whose `actions` map names each action.
 * `ctx.values` holds the install values; `ctx.runToolScript(script,
 * { method })` calls one of iHub's tool scripts.
 */
export function scriptSkeleton(actions) {
  const entries = (actions || []).map(
    action =>
      `    ${JSON.stringify(action.name)}: {\n      // args: the model's arguments (see the action's parameters)\n      run: async (args, ctx) => {\n        return { received: args };\n      }\n    }`
  );
  return [
    '// The connector module of this integration: one ES module, no imports',
    '// from its folder. Each key under `actions` is an action name.',
    'export default {',
    '  actions: {',
    entries.join(',\n'),
    '  }',
    '};',
    ''
  ].join('\n');
}

/** The action names a module source mentions under `actions` (a text check). */
export function moduleMentions(source, name) {
  if (typeof source !== 'string' || !name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["']?\\b${escaped}\\b["']?\\s*:`).test(source);
}

/**
 * Parse JSON text that must be an object.
 * @returns {{ value: Object|null, error: string|null }}
 */
export function parseJsonObject(text) {
  if (!String(text || '').trim()) return { value: null, error: null };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, error: 'not an object' };
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

/** `{ name: value }` ↔ `[{ key, value }]` for the header and query editors. */
export function recordToRows(record) {
  return Object.entries(record || {}).map(([key, value]) => ({ key, value: String(value) }));
}

export function rowsToRecord(rows) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row.key || '').trim();
    if (key) out[key] = String(row.value ?? '');
  }
  return out;
}

/**
 * The OpenAPI source the server takes for a text: an http(s) URL, or an
 * inline JSON or YAML document.
 */
export function openApiSourceOf(text) {
  const trimmed = String(text || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return { type: 'url', url: trimmed };
  return { type: 'inline', spec: text };
}

/**
 * A `servers[].url` resolved against the URL the document was read from
 * (OpenAPI allows relative server URLs); null when no absolute URL results.
 */
export function resolveServerUrl(serverUrl, sourceText) {
  if (!serverUrl) return null;
  if (/^https?:\/\//i.test(serverUrl)) return serverUrl;
  const specUrl = String(sourceText || '').trim();
  if (!/^https?:\/\//i.test(specUrl)) return null;
  try {
    return new URL(serverUrl, specUrl).toString();
  } catch {
    return null;
  }
}

function hasText(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value) && Object.values(value).some(v => typeof v === 'string' && v.trim());
}

const isHttpUrl = value => /^https?:\/\/\S+$/i.test(String(value || '').trim());
const err = (key, defaultValue) => ({
  key: `admin.integrationBuilder.errors.${key}`,
  defaultValue
});

/**
 * What a step still misses: field → `{ key, defaultValue }`. Empty when the
 * step is complete.
 *
 * @param {Object} draft
 * @param {string} step - one of {@link BUILDER_STEPS}
 * @returns {Object<string, {key: string, defaultValue: string}>}
 */
export function stepErrors(draft, step) {
  const errors = {};
  if (step === 'basics') {
    if (!hasText(draft.name)) errors.name = err('nameRequired', 'Give the integration a name.');
    if (!isValidInstanceId(draft.instanceId)) {
      errors.instanceId = err(
        'instanceId',
        'Use lower-case letters, digits and "-" (at most 48), starting with a letter or digit.'
      );
    }
    if (draft.icon && !/^https:\/\/\S+$/i.test(draft.icon)) {
      errors.icon = err('icon', 'The icon is an https URL.');
    }
  }
  if (step === 'signIn') {
    const auth = draft.auth || {};
    if (auth.mode === 'service-account' && !auth.credentialRef) {
      errors.credentialRef = err('credentialRequired', 'Pick the credential to send.');
    }
    if (auth.mode === 'service-account' && auth.kind === 'header' && !auth.header) {
      errors.header = err('headerRequired', 'Name the header the key is sent in.');
    }
  }
  if (step === 'source') {
    const block = draft[draft.source] || {};
    if (draft.source === 'openapi') {
      if (!block.document) errors.document = err('documentRequired', 'Read an OpenAPI document.');
      if (block.baseUrl && !isHttpUrl(block.baseUrl)) {
        errors.baseUrl = err('baseUrl', 'The base URL is an http(s) URL.');
      }
    }
    if (draft.source === 'http' && block.baseUrl && !isHttpUrl(block.baseUrl)) {
      errors.baseUrl = err('baseUrl', 'The base URL is an http(s) URL.');
    }
    if (draft.source === 'script' && !String(block.module || '').trim()) {
      errors.module = err('moduleRequired', 'Write the connector module.');
    }
    if (draft.source === 'mcp') {
      if (block.transport === 'stdio' && !String(block.command || '').trim()) {
        errors.command = err('commandRequired', 'Enter the command that starts the server.');
      }
      if (block.transport !== 'stdio' && !isHttpUrl(block.url) && !/^wss?:\/\//i.test(block.url)) {
        errors.url = err('urlRequired', 'Enter the server URL.');
      }
    }
    if (draft.source === 'a2a' && !isHttpUrl(block.cardUrl)) {
      errors.cardUrl = err('cardUrlRequired', 'Enter the agent card URL.');
    }
  }
  if (step === 'actions') {
    const actions = draft.actions || [];
    if (DECLARED_ACTION_SOURCES.includes(draft.source) && actions.length === 0) {
      errors.actions = err('actionsRequired', 'Add at least one action.');
    }
    const seen = new Set();
    actions.forEach((action, i) => {
      if (!isValidActionName(action.name)) {
        errors[`actions.${i}.name`] = err(
          'actionName',
          'An action name starts with a letter and has only letters, digits and _.'
        );
      } else if (seen.has(action.name)) {
        errors[`actions.${i}.name`] = err('actionNameTaken', 'Two actions have this name.');
      }
      seen.add(action.name);
      if (draft.source === 'http') {
        const url = action.request?.url || '';
        if (!url.trim()) {
          errors[`actions.${i}.url`] = err('requestUrl', 'Enter the URL of the request.');
        } else if (!/^https?:\/\//i.test(url) && !draft.http?.baseUrl) {
          errors[`actions.${i}.url`] = err(
            'relativeUrl',
            'A relative URL needs the base URL of the source.'
          );
        }
        if (action.request?.body && ['GET', 'HEAD'].includes(action.request.method)) {
          errors[`actions.${i}.body`] = err('bodyOnGet', 'A GET or HEAD request has no body.');
        }
      }
    });
  }
  return errors;
}

/** Whether every step before `step` is complete. */
export function firstIncompleteStep(draft) {
  return BUILDER_STEPS.find(step => Object.keys(stepErrors(draft, step)).length > 0) || null;
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
  );
}

/**
 * The draft as the server takes it: only the current source's block, no
 * display-only fields (the remote description of an MCP tool), empty
 * strings and empty records left out.
 */
export function draftForSave(draft) {
  const out = compact({
    instanceId: draft.instanceId,
    definitionId: draft.definitionId,
    name: draft.name,
    description: hasText(draft.description) ? draft.description : undefined,
    icon: draft.icon || undefined,
    source: draft.source,
    approvalDefault: draft.approvalDefault || undefined
  });
  const auth = draft.auth || { mode: 'none' };
  out.auth = compact({
    mode: auth.mode,
    kind: auth.mode === 'service-account' ? auth.kind : undefined,
    header: auth.mode === 'service-account' && auth.kind === 'header' ? auth.header : undefined,
    valuePrefix:
      auth.mode === 'service-account' && auth.kind === 'header' ? auth.valuePrefix : undefined,
    credentialRef: auth.mode === 'service-account' ? auth.credentialRef : undefined,
    oauthScopes:
      auth.mode === 'oauth-user' && auth.oauthScopes?.length ? auth.oauthScopes : undefined,
    oauthClientId: auth.mode === 'oauth-user' ? auth.oauthClientId : undefined
  });
  const block = { ...(draft[draft.source] || {}) };
  if (draft.source === 'mcp') {
    if (block.transport === 'stdio') {
      delete block.url;
      delete block.headers;
    } else {
      delete block.command;
      delete block.args;
      delete block.env;
      delete block.cwd;
    }
  }
  out[draft.source] = compact(block);
  out.actions = (draft.actions || []).map(action => {
    const { remoteDescription: _remote, ...rest } = action;
    const clean = compact({
      ...rest,
      title: hasText(rest.title) ? rest.title : undefined,
      description: hasText(rest.description) ? rest.description : undefined,
      approval: rest.approval || undefined
    });
    if (draft.source === 'http' && rest.request) {
      clean.request = compact({
        ...rest.request,
        body: rest.request.body || undefined,
        query: Object.keys(rest.request.query || {}).length ? rest.request.query : undefined,
        headers: Object.keys(rest.request.headers || {}).length ? rest.request.headers : undefined
      });
      const response = compact({
        result: rest.response?.result || undefined,
        fields: Object.keys(rest.response?.fields || {}).length ? rest.response.fields : undefined
      });
      if (Object.keys(response).length) clean.response = response;
      else delete clean.response;
    }
    if (!DECLARED_ACTION_SOURCES.includes(draft.source)) delete clean.parameters;
    return clean;
  });
  return out;
}

/**
 * A server error's details (`[{ path, message }]`) as the builder step it
 * belongs to, so the page can jump there.
 */
export function stepOfServerPath(path) {
  const head = Array.isArray(path) ? path[0] : null;
  if (['name', 'instanceId', 'icon', 'description'].includes(head)) return 'basics';
  if (head === 'auth') return 'signIn';
  if (['openapi', 'http', 'script', 'mcp', 'a2a', 'protocol'].includes(head)) return 'source';
  if (head === 'actions') return 'actions';
  return 'review';
}
