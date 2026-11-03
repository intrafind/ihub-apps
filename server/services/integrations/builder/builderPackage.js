// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integration builder's conversions, as pure functions (no I/O):
 *
 * - {@link draftToPackage}: a builder draft → the definition folder
 *   (`integration.json` plus companions: the connector module or the OpenAPI
 *   document) and the installation payload;
 * - {@link packageToDraft}: the stored definition and installation → the
 *   draft the builder edits (a migrated tool opens the same way);
 * - {@link exportPackage}: a definition folder → the package a marketplace
 *   registry serves (catalog item plus files, `docs/marketplace.md`).
 *
 * The service (`IntegrationBuilderService.js`) does the reading and writing,
 * through the existing `IntegrationRegistry` and `InstalledIntegrationService`.
 *
 * @module services/integrations/builder/builderPackage
 */
import { createHash } from 'node:crypto';
import {
  CUSTOM_DEFINITION_PREFIX,
  definitionIdToDirName,
  isCustomDefinitionId
} from '../../../validators/integrationDefinitionSchema.js';

/** Where a `script` integration's connector module lives in its folder. */
export const SCRIPT_MODULE_FILE = 'actions/connector.js';
/** The companion an OpenAPI integration's document is stored as. */
export const OPENAPI_DOCUMENT_FILE = 'openapi.json';
/** The install field holding a service account's secret (a credential reference). */
export const SECRET_FIELD = 'secret';
/** Marks the package `POST …/builder/_export/:id` answers with. */
export const PACKAGE_FORMAT = 'ihub-integration-package';
export const PACKAGE_FORMAT_VERSION = 1;

const CODE_FILE = /\.(m?js|cjs)$/i;

/** A builder error the routes answer with 400 (`code`, `details`). */
export class BuilderError extends Error {
  constructor(message, { status = 400, code = 'INVALID_DRAFT', details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The definition id of a custom integration installed as `instanceId`. */
export function customDefinitionIdFor(instanceId) {
  return `${CUSTOM_DEFINITION_PREFIX}${instanceId}`;
}

/** `1.0.4` → `1.0.5`; anything else → `1.0.0`. */
export function nextVersion(previous) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(previous || '');
  if (!match) return '1.0.0';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** A localized value as a `{ lang: text }` record (the catalog wants records). */
export function asLocalizedRecord(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return { en: value };
  return value;
}

function hasText(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value) && Object.values(value).some(v => typeof v === 'string' && v.trim());
}

function nonEmptyRecord(record) {
  return record && Object.keys(record).length ? record : undefined;
}

/** Drop the keys whose value is undefined (definitions are written as JSON). */
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * The definition's `auth` and the install fields it needs, from the draft.
 * MCP servers and A2A agents send a bearer token or a header; the HTTP and
 * OpenAPI protocols also send a credential profile as its type says.
 */
function authOf(draft) {
  const { mode, kind, header, valuePrefix } = draft.auth;
  if (mode === 'none') return { auth: { modes: ['none'] }, install: [] };
  if (mode === 'oauth-user') {
    return {
      auth: { modes: ['oauth-user'], oauthUser: {} },
      install: [
        {
          key: 'oauthScopes',
          type: 'list',
          title: { en: 'Scopes', de: 'Scopes' },
          advanced: true
        },
        {
          key: 'oauthClientId',
          type: 'string',
          title: { en: 'Client ID (optional)', de: 'Client-ID (optional)' },
          advanced: true
        }
      ]
    };
  }
  const remote = draft.source === 'mcp' || draft.source === 'a2a';
  if (remote && kind === 'basic') {
    throw new BuilderError('MCP servers and A2A agents take a bearer token or a header', {
      code: 'UNSUPPORTED_AUTH_KIND',
      details: [{ path: ['auth', 'kind'], message: 'basic is not available for this source' }]
    });
  }
  const effectiveKind = remote && kind === 'credential' ? 'bearer' : kind;
  return {
    auth: {
      modes: ['service-account'],
      serviceAccount: compact({
        kind: effectiveKind,
        header: effectiveKind === 'header' ? header : undefined,
        valuePrefix: effectiveKind === 'header' && valuePrefix ? valuePrefix : undefined,
        field: SECRET_FIELD
      })
    },
    install: [
      {
        key: SECRET_FIELD,
        type: 'secret',
        title: { en: 'Credential', de: 'Zugangsdaten' },
        required: true
      }
    ]
  };
}

function protocolOf(draft) {
  switch (draft.source) {
    case 'openapi': {
      const document =
        typeof draft.openapi.document === 'string' ? draft.openapi.document : OPENAPI_DOCUMENT_FILE;
      return compact({
        type: 'openapi',
        document,
        baseUrl: draft.openapi.baseUrl,
        headers: nonEmptyRecord(draft.openapi.headers)
      });
    }
    case 'http':
      return compact({
        type: 'http',
        baseUrl: draft.http.baseUrl || undefined,
        headers: nonEmptyRecord(draft.http.headers)
      });
    case 'script':
      return { type: 'script', module: SCRIPT_MODULE_FILE };
    case 'a2a':
      return { type: 'a2a', cardUrl: draft.a2a.cardUrl };
    case 'mcp': {
      const { transport, url, headers, command, args, env, cwd } = draft.mcp;
      const fixed =
        transport === 'stdio'
          ? compact({
              type: 'stdio',
              command,
              args: args && args.length ? args : undefined,
              env: nonEmptyRecord(env),
              cwd: cwd || undefined
            })
          : compact({
              type: transport,
              url,
              headers: transport === 'websocket' ? undefined : nonEmptyRecord(headers)
            });
      return { type: 'mcp', transport: fixed };
    }
    default:
      throw new BuilderError(`Unknown source "${draft.source}"`);
  }
}

/**
 * The definition's action entry of a builder action (openapi, http, script).
 * `toolId` is kept only where the previous definition had it for the same
 * action name: the builder never mints a fixed tool id, it only keeps the one
 * a migrated tool file brought.
 */
function definitionActionOf(draft, action, keptToolIds) {
  const base = compact({
    name: action.name,
    toolId: keptToolIds.get(action.name),
    title: hasText(action.title) ? action.title : undefined,
    description: hasText(action.description) ? action.description : undefined,
    sideEffect: action.sideEffect,
    dataFlow: action.dataFlow
  });
  if (draft.source === 'openapi') return { ...base, operationId: action.operationId };
  if (draft.source === 'http') {
    const request = compact({
      method: action.request.method,
      url: action.request.url,
      query: nonEmptyRecord(action.request.query),
      headers: nonEmptyRecord(action.request.headers),
      body: action.request.body ? action.request.body : undefined,
      contentType: action.request.body ? action.request.contentType : undefined
    });
    const response = action.response
      ? compact({
          result: action.response.result || undefined,
          fields: nonEmptyRecord(action.response.fields)
        })
      : undefined;
    return compact({
      ...base,
      parameters: action.parameters || { type: 'object', properties: {}, required: [] },
      request,
      response: response && Object.keys(response).length ? response : undefined
    });
  }
  return compact({ ...base, parameters: action.parameters });
}

/**
 * The installation's per-action overrides of an MCP tool or A2A skill, whose
 * own description and side effect come from the remote system: only what the
 * admin decided is stored.
 */
function remoteOverridesOf(actions) {
  const overrides = {};
  for (const action of actions) {
    const override = compact({
      description: hasText(action.description) ? action.description : undefined,
      sideEffect: action.sideEffect !== 'unknown' ? action.sideEffect : undefined,
      dataFlow: action.dataFlow !== 'external' ? action.dataFlow : undefined
    });
    if (Object.keys(override).length) overrides[action.name] = override;
  }
  return overrides;
}

/**
 * What the builder decides about an action's description, side effect and data
 * flow: for an MCP tool or A2A skill in the installation's override
 * (`remoteOverridesOf`), for an action the definition declares in the
 * definition itself (the draft carries the effective value, see `packageToDraft`).
 */
const BUILDER_OVERRIDE_FIELDS = ['description', 'sideEffect', 'dataFlow'];

/**
 * The installation's per-action overrides after a builder save. The action
 * detail (#2974) writes overrides too (guidance, examples, and for an action
 * the definition declares also its description, side effect and data flow):
 * the builder keeps what it does not edit itself, for every action the draft
 * still has. The description, side effect and data flow are the builder's:
 * for an MCP tool or A2A skill it stores them as an override
 * (`remoteOverridesOf`), for a declared action it writes them into the
 * definition, where they replace an override the action detail had set (the
 * builder showed that value, so the action behaves as before).
 *
 * @param {Array<Object>} actions - the draft's actions
 * @param {boolean} declaresActions - whether the definition lists its actions
 * @param {Object|null} existingInstance - the stored installation, if any
 * @returns {Object<string,Object>}
 */
function overridesOf(actions, declaresActions, existingInstance) {
  const stored = existingInstance?.actions?.overrides || {};
  const decided = declaresActions ? {} : remoteOverridesOf(actions);
  const overrides = {};
  for (const { name } of actions) {
    const kept = Object.hasOwn(stored, name) ? { ...stored[name] } : {};
    for (const field of BUILDER_OVERRIDE_FIELDS) delete kept[field];
    const override = { ...kept, ...(Object.hasOwn(decided, name) ? decided[name] : {}) };
    if (Object.keys(override).length) overrides[name] = override;
  }
  return overrides;
}

/**
 * The installation's `approval` after a builder save. Nothing left to set
 * removes the stored setting (`null`): `undefined` would keep it, because a
 * save that does not name the approval keeps the stored one.
 *
 * @param {Object} approval - what the draft sets (default, actions, newOrChanged)
 * @param {Object|null} existingInstance - the stored installation, if any
 * @returns {Object|null|undefined}
 */
function approvalOf(approval, existingInstance) {
  if (Object.keys(approval).length > 0) return approval;
  return existingInstance?.approval ? null : undefined;
}

/**
 * A builder draft as a definition folder and an installation payload.
 *
 * @param {Object} draft - a validated draft (`validateBuilderDraft`)
 * @param {Object} [options]
 * @param {Object} [options.previous] - the stored definition when the integration exists
 * @param {Object} [options.existingInstance] - the stored installation when it exists
 * @returns {{ definitionId: string, definition: Object, files: Record<string, string|Object>, installation: Object }}
 * @throws {BuilderError}
 *
 * @example
 * const { definition, files, installation } = draftToPackage({
 *   instanceId: 'orders', name: { en: 'Orders' }, source: 'http',
 *   auth: { mode: 'none' }, http: { baseUrl: 'https://erp.example.com/api' },
 *   actions: [{ name: 'get_order', sideEffect: 'read', dataFlow: 'internal', enabled: true,
 *     parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
 *     request: { method: 'GET', url: '/orders/{id}' } }]
 * });
 * // definition.id === 'custom/orders', installation.id === 'orders'
 */
export function draftToPackage(draft, { previous = null, existingInstance = null } = {}) {
  const definitionId =
    previous?.id || draft.definitionId || customDefinitionIdFor(draft.instanceId);
  if (!isCustomDefinitionId(definitionId)) {
    throw new BuilderError(`"${definitionId}" is not a custom integration`, {
      code: 'NOT_CUSTOM'
    });
  }
  const { auth, install } = authOf(draft);
  const protocol = protocolOf(draft);
  const declaresActions = ['openapi', 'http', 'script'].includes(draft.source);
  const keptToolIds = new Map(
    (previous?.actions || []).filter(a => a.toolId).map(a => [a.name, a.toolId])
  );

  const files = {};
  const icon = draft.icon && /^https:\/\//i.test(draft.icon) ? draft.icon : undefined;

  const definition = compact({
    id: definitionId,
    version: previous ? nextVersion(previous.version) : '1.0.0',
    name: draft.name,
    description: hasText(draft.description) ? draft.description : undefined,
    icon,
    categories: ['custom'],
    protocol,
    auth,
    install,
    capabilities: ['tools'],
    actions: declaresActions
      ? draft.actions.map(action => definitionActionOf(draft, action, keptToolIds))
      : []
  });
  files['integration.json'] = definition;
  if (draft.source === 'script') files[SCRIPT_MODULE_FILE] = draft.script.module;
  if (draft.source === 'openapi' && typeof draft.openapi.document !== 'string') {
    files[OPENAPI_DOCUMENT_FILE] = JSON.stringify(draft.openapi.document, null, 2);
  }

  const approvalActions = {};
  for (const action of draft.actions) {
    if (action.approval) approvalActions[action.name] = action.approval;
  }
  const approval = compact({
    default: draft.approvalDefault,
    actions: nonEmptyRecord(approvalActions),
    // Set on the installation page (#2916); the builder does not edit it.
    newOrChanged: existingInstance?.approval?.newOrChanged
  });

  const values = {};
  if (draft.auth.mode === 'oauth-user') {
    if (draft.auth.oauthScopes?.length) values.oauthScopes = draft.auth.oauthScopes;
    if (draft.auth.oauthClientId) values.oauthClientId = draft.auth.oauthClientId;
  }

  const installation = compact({
    id: draft.instanceId,
    definition: definitionId,
    enabled: existingInstance ? existingInstance.enabled !== false : true,
    values,
    auth: compact({
      mode: draft.auth.mode,
      credentialRef: draft.auth.mode === 'service-account' ? draft.auth.credentialRef : undefined
    }),
    actions: {
      enabled: ['*'],
      disabled: draft.actions.filter(a => a.enabled === false).map(a => a.name),
      overrides: overridesOf(draft.actions, declaresActions, existingInstance)
    },
    approval: approvalOf(approval, existingInstance),
    timeoutMs: existingInstance?.timeoutMs
  });
  return { definitionId, definition, files, installation };
}

function sourceOfProtocol(type) {
  return type === 'native' ? null : type;
}

/**
 * The draft of a stored custom integration.
 *
 * @param {Object} params
 * @param {Object} params.definition - the raw `integration.json`
 * @param {Object} params.instance - the installation
 * @param {string} [params.moduleSource] - `script`: the connector module's source
 * @param {Object} [params.document] - `openapi`: the parsed companion document
 * @param {Array<Object>} [params.liveActions] - `mcp` / `a2a`: the actions the
 *   adapter lists (name, description, sideEffect), so every remote tool shows
 * @returns {Object} a builder draft
 */
export function packageToDraft({ definition, instance, moduleSource, document, liveActions = [] }) {
  const source = sourceOfProtocol(definition.protocol?.type);
  if (!source) {
    throw new BuilderError(`${definition.id} cannot be edited in the builder`, {
      code: 'NOT_BUILDABLE'
    });
  }
  const protocol = definition.protocol;
  const account = definition.auth?.serviceAccount || {};
  const mode = instance.auth?.mode || 'none';
  const approvals = instance.approval?.actions || {};
  const disabled = new Set(instance.actions?.disabled || []);

  const draft = {
    instanceId: instance.id,
    definitionId: definition.id,
    name: definition.name,
    description: definition.description,
    icon:
      typeof definition.icon === 'string' && /^https:/i.test(definition.icon)
        ? definition.icon
        : '',
    source,
    auth: compact({
      mode: mode === 'service-account' || mode === 'oauth-user' ? mode : 'none',
      kind: account.kind || 'credential',
      header: account.header,
      valuePrefix: account.valuePrefix,
      credentialRef: instance.auth?.credentialRef,
      oauthScopes: Array.isArray(instance.values?.oauthScopes)
        ? instance.values.oauthScopes
        : undefined,
      oauthClientId: instance.values?.oauthClientId
    }),
    approvalDefault: instance.approval?.default,
    actions: []
  };

  if (source === 'openapi') {
    draft.openapi = compact({
      document: /^https?:\/\//i.test(protocol.document || '') ? protocol.document : document || {},
      baseUrl: protocol.baseUrl,
      headers: protocol.headers
    });
  } else if (source === 'http') {
    draft.http = compact({ baseUrl: protocol.baseUrl, headers: protocol.headers });
  } else if (source === 'script') {
    draft.script = { module: moduleSource || '' };
  } else if (source === 'a2a') {
    draft.a2a = { cardUrl: protocol.cardUrl || instance.values?.cardUrl || '' };
  } else if (source === 'mcp') {
    const transport = protocol.transport || {};
    draft.mcp = compact({
      transport: transport.type || 'streamableHttp',
      url: transport.url,
      headers: transport.headers,
      command: transport.command,
      args: transport.args,
      env: transport.env,
      cwd: transport.cwd
    });
  }

  const overrides = instance.actions?.overrides || {};
  if (['openapi', 'http', 'script'].includes(source)) {
    // The effective value: what the action detail (#2974) set wins over the
    // definition, as it does when the action runs. A save writes it into the
    // definition and drops the override (`overridesOf`), so nothing the admin
    // sees here changes and an edit made here takes effect.
    draft.actions = (definition.actions || []).map(action => {
      const own = overrides[action.name] || {};
      return compact({
        name: action.name,
        title: action.title,
        description: own.description ?? action.description,
        parameters: action.parameters,
        sideEffect: own.sideEffect || action.sideEffect || 'unknown',
        dataFlow: own.dataFlow || action.dataFlow || 'external',
        approval: approvals[action.name],
        enabled: !disabled.has(action.name),
        operationId: action.operationId,
        request: action.request,
        response: action.response,
        toolId: action.toolId
      });
    });
  } else {
    const names = [
      ...liveActions.map(a => a.name),
      ...Object.keys(overrides),
      ...Object.keys(approvals),
      ...disabled
    ];
    const live = new Map(liveActions.map(a => [a.name, a]));
    draft.actions = [...new Set(names)].map(name =>
      compact({
        name,
        title: live.get(name)?.title,
        description: overrides[name]?.description,
        remoteDescription: live.get(name)?.description || undefined,
        parameters: live.get(name)?.parameters,
        sideEffect: overrides[name]?.sideEffect || 'unknown',
        dataFlow: overrides[name]?.dataFlow || 'external',
        approval: approvals[name],
        enabled: !disabled.has(name)
      })
    );
  }
  return draft;
}

function sha256Integrity(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * The package a registry serves for a custom integration: the catalog item
 * (`catalog.json` → `items[]`) and the files of the definition folder. The
 * tool ids a migrated tool file kept (`toolId`) belong to this server and
 * are left out; every code file gets the hash a registry must list
 * (`source.integrity`), so a registry trusted for code can deliver it.
 *
 * @param {Object} params
 * @param {Object} params.definition - the raw `integration.json`
 * @param {Record<string, string>} params.companions - relative path → text of the other files
 * @returns {{ format: string, formatVersion: number, catalogItem: Object, files: Record<string, string|Object> }}
 */
export function exportPackage({ definition, companions = {} }) {
  const def = structuredClone(definition);
  for (const action of def.actions || []) delete action.toolId;
  const dirName = definitionIdToDirName(def.id);
  const companionPaths = Object.keys(companions).sort((a, b) => a.localeCompare(b));
  const integrity = {};
  for (const relPath of companionPaths) {
    if (CODE_FILE.test(relPath)) integrity[relPath] = sha256Integrity(companions[relPath]);
  }
  const source = compact({
    type: 'relative',
    path: `integration-definitions/${dirName}/integration.json`,
    companions: companionPaths.length ? companionPaths : undefined,
    integrity: Object.keys(integrity).length ? integrity : undefined
  });
  const catalogItem = compact({
    type: 'integration',
    name: dirName,
    displayName: asLocalizedRecord(def.name),
    description: asLocalizedRecord(def.description),
    version: def.version,
    category: 'custom',
    icon: typeof def.icon === 'string' && /^https:/i.test(def.icon) ? def.icon : undefined,
    tags: ['custom', def.protocol?.type].filter(Boolean),
    compatibility: def.compatibility,
    releases: def.releases,
    source
  });
  return {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    catalogItem,
    files: { 'integration.json': def, ...companions }
  };
}
