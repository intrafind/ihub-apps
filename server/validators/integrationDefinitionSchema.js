// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { sourceDeclarationSchema } from '../services/sources/producers/declared.js';

/**
 * Integration definition: the catalog entry of an integration (see
 * `concepts/2026-10-20 Unified Integrations/04-architecture.md` §1.1 and
 * `concepts/2026-10-30 CKAN Open Data Integration/`).
 *
 * A definition is a folder with an `integration.json` and optional companion
 * files (an OpenAPI document, an icon, a README). It is immutable per version
 * and never carries a secret or an installation's values: those live in
 * `contents/config/integrations.json` (see `integrationsConfigSchema.js`).
 */

const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

export const localizedStringSchema = z.union([
  z.record(z.string().regex(LANGUAGE_CODE, 'Invalid language code format'), z.string()),
  z.string()
]);

/** Reverse-DNS id with an optional single `/` segment, e.g. `org.ckan/open-data-portal`. */
export const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)?$/;

export const integrationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    INTEGRATION_ID_PATTERN,
    'Integration id must be lower-case reverse-DNS, optionally with one "/" segment'
  );

/** Folder name for a definition id: the one `/` becomes `__`. */
export function definitionIdToDirName(id) {
  return id.replace('/', '__');
}

/** Inverse of {@link definitionIdToDirName}. */
export function dirNameToDefinitionId(dirName) {
  return dirName.replace('__', '/');
}

const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version must be semantic (MAJOR.MINOR.PATCH)');

/** Key of an install field, an action name, or a parameter name. */
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    'must start with a letter and contain only letters, digits and _'
  );

/** Relative companion path inside the definition folder (no traversal, no absolute path). */
const companionPathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, 'must be a relative path');

const httpOrCompanionSchema = z.union([z.string().url(), companionPathSchema]);

const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ENFORCEMENT_MODES = ['fixed', 'cap', 'append', 'default'];

/**
 * A value an installation contributes to an action call, with the rule that
 * decides what happens when the model sends the same parameter:
 * - `fixed`: the install value is sent, the model's value is dropped
 * - `cap`: numbers only, the smaller of the two is sent
 * - `append`: strings only, install value and model value are joined with a space
 *   (Solr `fq` semantics: both terms must match)
 * - `default`: the install value is used only when the model sent nothing
 *
 * `value` may contain `{installKey}` placeholders that are substituted with the
 * installation's values before the mode is applied.
 */
export const enforcedValueSchema = z
  .union([
    z.object({
      value: primitiveSchema,
      mode: z.enum(ENFORCEMENT_MODES).prefault('default')
    }),
    primitiveSchema
  ])
  .transform(v => (v !== null && typeof v === 'object' ? v : { value: v, mode: 'default' }));

export const CONFIG_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'enum',
  'url',
  'secret',
  'file',
  'directory',
  /** A reference to a credential profile (`credentials.json`), picked, never a value. */
  'credential',
  /** The id of another installed integration (`definition` names its definition). */
  'instance',
  /** A list of strings. */
  'list'
];

export const CONFIG_FIELD_SCOPES = ['admin', 'user'];
export const CONFIG_FIELD_INJECTIONS = [
  'env',
  'arg',
  'header',
  'urlVariable',
  'body',
  'credentialRef'
];

const configFieldChoiceSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: localizedStringSchema,
  /** Values this choice sets on other fields or protocol settings, e.g. an endpoint per region. */
  set: z.record(z.string(), primitiveSchema).optional(),
  /** Fields that become required when this choice is picked. */
  requires: z.array(identifierSchema).optional()
});

/**
 * One typed field of the install wizard (scope `admin`) or of the user's
 * Connect dialog (scope `user`). Shared with MCPB `user_config`, registry input
 * objects and elicitation forms (04-architecture §1.2).
 */
export const configFieldSchema = z
  .object({
    key: identifierSchema,
    type: z.enum(CONFIG_FIELD_TYPES),
    title: localizedStringSchema,
    description: localizedStringSchema.optional(),
    required: z.boolean().prefault(false),
    default: z.union([primitiveSchema, z.array(z.string())]).optional(),
    /** Never stored in a config file; goes to the credential store (admin) or token store (user). */
    sensitive: z.boolean().optional(),
    choices: z.array(configFieldChoiceSchema).optional(),
    /** Free-text fields may offer common values without restricting the input. */
    suggestions: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    multiple: z.boolean().prefault(false),
    pattern: z.string().max(512).optional(),
    scope: z.enum(CONFIG_FIELD_SCOPES).prefault('admin'),
    injectAs: z.enum(CONFIG_FIELD_INJECTIONS).optional(),
    /** Hidden behind "Advanced" in the wizard. */
    advanced: z.boolean().prefault(false),
    /** `credential` fields: the credential types offered (any when empty). */
    credentialTypes: z.array(z.string().min(1).max(64)).optional(),
    /** `instance` fields: the definition the referenced installation must have. */
    definition: integrationIdSchema.optional()
  })
  .transform(field => ({ ...field, sensitive: field.sensitive ?? field.type === 'secret' }))
  .refine(field => field.type !== 'enum' || (field.choices && field.choices.length > 0), {
    message: 'an enum field needs choices'
  })
  .refine(field => !(field.sensitive && field.default !== undefined), {
    message: 'a sensitive field cannot have a default value'
  });

export const AUTH_MODES = [
  'none',
  'service-account',
  'api-key-user',
  'oauth-user',
  'enterprise-managed'
];

const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~{}-]+$/; // `{}` allows a {field} template

/**
 * How a shared secret (one for the whole installation) is sent. `field` names
 * the sensitive install field that holds it; `header` may be a template.
 */
const serviceAccountAuthSchema = z.object({
  // A secret in a query parameter is not supported: it would land in access
  // logs on both ends.
  kind: z.enum(['header', 'bearer', 'basic']).prefault('header'),
  header: z.string().regex(HTTP_HEADER_NAME).optional(),
  valuePrefix: z.string().max(64).optional(),
  field: identifierSchema.optional(),
  fields: z.array(identifierSchema).optional()
});

export const integrationAuthSchema = z
  .object({
    modes: z.array(z.enum(AUTH_MODES)).min(1),
    default: z.enum(AUTH_MODES).optional(),
    serviceAccount: serviceAccountAuthSchema.optional(),
    apiKeyUser: serviceAccountAuthSchema.optional(),
    oauthUser: z.record(z.string(), z.any()).optional()
  })
  .transform(auth => ({ ...auth, default: auth.default ?? auth.modes[0] }))
  .refine(auth => auth.modes.includes(auth.default), {
    message: 'auth.default must be one of auth.modes'
  });

/** A small path into a JSON response: dotted keys, `[]` for every element, `$.` prefix optional. */
const jsonPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^(\$\.?)?[A-Za-z0-9_-]+(\[\])?(\.[A-Za-z0-9_-]+(\[\])?)*$|^\$$/, 'invalid response path');

const responseEnvelopeSchema = z.object({
  /** Path to a boolean that says whether the call succeeded. */
  success: jsonPathSchema.optional(),
  /** Path to the payload the model should see. */
  result: jsonPathSchema.optional(),
  /** Path to the error message when `success` is false. */
  error: jsonPathSchema.optional(),
  /** Path to an error type or code. */
  errorType: jsonPathSchema.optional()
});

export const ARRAY_PARAMETER_STYLES = ['openapi', 'repeat', 'json-list', 'comma'];

const openapiProtocolSchema = z.object({
  type: z.literal('openapi'),
  /** Companion file in the definition folder, or an https URL. */
  document: httpOrCompanionSchema,
  /** Base URL template; `{key}` placeholders are install fields. */
  baseUrl: z.string().min(1).max(2048),
  /** Static non-secret headers sent on every request (values may be templates). */
  headers: z.record(z.string().regex(HTTP_HEADER_NAME), z.string().max(1024)).optional(),
  responseEnvelope: responseEnvelopeSchema.optional(),
  /** How array query parameters are serialized; `openapi` honours style/explode of the document. */
  arrayParameterStyle: z.enum(ARRAY_PARAMETER_STYLES).prefault('openapi'),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(5 * 1024 * 1024)
    .prefault(262144),
  timeoutMs: z.number().int().min(1000).max(120000).prefault(30000)
});

/** Adapters the architecture names; only `openapi` has an adapter in this iteration. */
export const PROTOCOL_TYPES = [
  'openapi',
  'mcp-remote',
  'mcp-stdio',
  'a2a',
  'native',
  'http',
  'script',
  'storage',
  'websearch'
];

/**
 * A built-in whose actions are implemented by a server module
 * (`services/integrations/protocols/native/connectors/<module>.js`).
 */
const nativeProtocolSchema = z.object({
  type: z.literal('native'),
  module: identifierSchema
});

const reservedProtocolSchemaWithoutNative = z
  .object({
    type: z.enum(PROTOCOL_TYPES.filter(t => t !== 'openapi' && t !== 'native'))
  })
  .passthrough();

export const integrationProtocolSchema = z.union([
  openapiProtocolSchema,
  nativeProtocolSchema,
  reservedProtocolSchemaWithoutNative
]);

export const SIDE_EFFECTS = ['read', 'write', 'destructive', 'unknown'];
export const DATA_FLOWS = ['internal', 'external'];
export const ACTION_CONNECTIONS = ['none', 'user', 'service', 'token'];

export const integrationActionSchema = z.object({
  /** Model-facing name; the tool id becomes `<instanceId>__<name>`. */
  name: identifierSchema,
  /**
   * Built-ins only: the tool id the action keeps from before it was an
   * integration (`iFinder_search`), so apps, group grants and the MCP and A2A
   * gateways keep addressing it.
   */
  toolId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/, 'invalid tool id')
    .optional(),
  /** OpenAPI operationId this action calls (openapi protocol). */
  operationId: z.string().min(1).max(200).optional(),
  title: localizedStringSchema.optional(),
  /** Model-facing description; falls back to the operation summary. */
  description: localizedStringSchema.optional(),
  sideEffect: z.enum(SIDE_EFFECTS).prefault('unknown'),
  dataFlow: z.enum(DATA_FLOWS).prefault('external'),
  enabledByDefault: z.boolean().prefault(true),
  /** Which identity the action needs; `token` means it refuses to run without a credential. */
  connection: z.enum(ACTION_CONNECTIONS).optional(),
  /** Install values that must hold for the action to be offered, e.g. `{ "install.datastoreSql": true }`. */
  requires: z.record(z.string(), primitiveSchema).optional(),
  /** Parameters the installation contributes, each with an enforcement mode. */
  defaults: z.record(identifierSchema, enforcedValueSchema).optional(),
  /** Response paths removed before the model sees the result (`items[].field` reaches into arrays). */
  hideFields: z.array(z.string().min(1).max(256)).optional(),
  guidance: localizedStringSchema.optional(),
  examples: z.array(localizedStringSchema).optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(5 * 1024 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional()
});

export const CAPABILITIES = ['tools', 'scopes', 'sources', 'files', 'views', 'search', 'model'];

/**
 * Where to search: the adapter runs `action`, maps each item to `{ id, name }`
 * and the pick is applied to the named parameters of other actions.
 */
export const integrationScopesSchema = z.object({
  /** The action whose result lists the scopes (declarative protocols); a native connector lists them itself. */
  action: identifierSchema.optional(),
  label: localizedStringSchema,
  /** Path to the array of items in the action's (unwrapped) result; absent = the result itself. */
  items: jsonPathSchema.optional(),
  map: z
    .object({
      id: jsonPathSchema,
      name: jsonPathSchema,
      isDefault: jsonPathSchema.optional()
    })
    .optional(),
  /** `"<action>.<param>"` → how the picked id reaches that parameter; `{id}` and `{name}` are substituted. */
  applyAs: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/, 'use "<action>.<param>"'),
      enforcedValueSchema
    )
    .optional(),
  /** Iteration 2: verify ownership on follow-up actions. */
  strict: z.boolean().prefault(false)
});

/**
 * How an action's result becomes Answer Sources: the declared-sources format
 * of `services/sources/producers/declared.js` (`list`, `fields`, `ref`,
 * `query`, `public`, `kind`, `provider`), with paths relative to the result
 * the model sees (after the response envelope is unwrapped), plus
 * `urlTemplate`: a `{field}` template evaluated per hit, with install values
 * available as well, that the adapter stores on each hit as `portalUrl` and
 * uses as the source URL when `fields.url` is not set.
 */
export const integrationSourceMappingSchema = sourceDeclarationSchema.extend({
  urlTemplate: z.string().min(1).max(2048).optional()
});

export const integrationHealthSchema = z.object({
  action: identifierSchema,
  args: z.record(z.string(), primitiveSchema).optional()
});

export const integrationPublisherSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().optional(),
  verification: z.enum(['intrafind', 'partner', 'verified', 'community']).optional()
});

export const integrationDefinitionSchema = z
  .object({
    $schema: z.string().optional(),
    id: integrationIdSchema,
    version: semverSchema,
    name: localizedStringSchema,
    description: localizedStringSchema.optional(),
    publisher: integrationPublisherSchema.optional(),
    icon: httpOrCompanionSchema.optional(),
    categories: z.array(z.string().min(1).max(64)).prefault([]),
    docsUrl: z.string().url().optional(),
    privacyPolicyUrl: z.string().url().optional(),
    license: z.string().max(128).optional(),
    runs: z.enum(['cloud', 'on-prem', 'local']).optional(),
    dataResidency: z.array(z.string().max(16)).optional(),
    trusted: z.boolean().prefault(false),
    /** Ships with iHub: always in the catalog, never uninstalled from a registry. */
    builtIn: z.boolean().prefault(false),
    /** Exactly one installation, with this fixed id (the built-in iFinder is `ifinder`). */
    singleton: z.object({ instanceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).optional(),
    protocol: integrationProtocolSchema,
    auth: integrationAuthSchema,
    install: z.array(configFieldSchema).prefault([]),
    capabilities: z.array(z.enum(CAPABILITIES)).prefault(['tools']),
    scopes: integrationScopesSchema.optional(),
    sources: z.record(identifierSchema, integrationSourceMappingSchema).optional(),
    health: integrationHealthSchema.optional(),
    actions: z.array(integrationActionSchema).prefault([]),
    instructions: localizedStringSchema.optional(),
    _meta: z.record(z.string(), z.any()).optional()
  })
  .superRefine((def, ctx) => {
    const keys = new Set();
    def.install.forEach((field, i) => {
      if (keys.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['install', i, 'key'],
          message: `duplicate install field "${field.key}"`
        });
      }
      keys.add(field.key);
    });

    const actionNames = new Set();
    def.actions.forEach((action, i) => {
      if (actionNames.has(action.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'name'],
          message: `duplicate action "${action.name}"`
        });
      }
      actionNames.add(action.name);
      if (def.protocol.type === 'openapi' && !action.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'operationId'],
          message: 'an openapi action needs an operationId'
        });
      }
      if (action.toolId && !def.builtIn) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'toolId'],
          message: 'only a built-in definition may fix its tool ids'
        });
      }
    });

    if (def.scopes) {
      const declarative = def.protocol.type !== 'native';
      if (declarative && (!def.scopes.action || !def.scopes.map || !def.scopes.applyAs)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scopes'],
          message: 'scopes need action, map and applyAs unless the protocol is native'
        });
      }
      if (def.scopes.action && !actionNames.has(def.scopes.action)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scopes', 'action'],
          message: `scopes.action "${def.scopes.action}" is not a declared action`
        });
      }
      for (const target of Object.keys(def.scopes.applyAs || {})) {
        const [actionName] = target.split('.');
        if (!actionNames.has(actionName)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scopes', 'applyAs', target],
            message: `"${actionName}" is not a declared action`
          });
        }
      }
    }

    for (const actionName of Object.keys(def.sources || {})) {
      if (!actionNames.has(actionName)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', actionName],
          message: `"${actionName}" is not a declared action`
        });
      }
    }

    if (def.health && !actionNames.has(def.health.action)) {
      ctx.addIssue({
        code: 'custom',
        path: ['health', 'action'],
        message: `health.action "${def.health.action}" is not a declared action`
      });
    }

    const serviceField = def.auth.serviceAccount?.field;
    if (serviceField && !keys.has(serviceField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'serviceAccount', 'field'],
        message: `"${serviceField}" is not an install field`
      });
    }
  });

/**
 * Validate a definition.
 * @param {unknown} data
 * @returns {{ success: true, data: object } | { success: false, errors: Array }}
 */
export function validateIntegrationDefinition(data) {
  const result = integrationDefinitionSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.issues };
}

/**
 * Check an installation's non-sensitive values against the definition's
 * install fields: unknown keys, missing required fields, type mismatches,
 * enum membership, patterns, ranges, and sensitive values that must not be
 * stored in a config file.
 *
 * @param {object} definition - a validated definition
 * @param {Record<string, unknown>} values
 * @param {{ authMode?: string }} [options]
 * @returns {Array<{ key: string, message: string }>} empty when valid
 */
export function checkInstallValues(definition, values = {}, options = {}) {
  const errors = [];
  const fields = new Map(definition.install.map(f => [f.key, f]));

  for (const key of Object.keys(values)) {
    if (!fields.has(key)) errors.push({ key, message: 'unknown install field' });
  }

  for (const field of definition.install) {
    if (field.scope !== 'admin') continue;
    const value = values[field.key];
    if (field.sensitive && value !== undefined && value !== null && value !== '') {
      errors.push({ key: field.key, message: 'sensitive values belong in the credential store' });
      continue;
    }
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required && !field.sensitive) {
        errors.push({ key: field.key, message: 'required' });
      }
      continue;
    }
    switch (field.type) {
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push({ key: field.key, message: 'must be a number' });
        } else {
          if (field.min !== undefined && value < field.min)
            errors.push({ key: field.key, message: `must be at least ${field.min}` });
          if (field.max !== undefined && value > field.max)
            errors.push({ key: field.key, message: `must be at most ${field.max}` });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean')
          errors.push({ key: field.key, message: 'must be a boolean' });
        break;
      case 'enum':
        if (!field.choices.some(c => c.value === value)) {
          errors.push({ key: field.key, message: 'not one of the allowed choices' });
        }
        break;
      case 'url': {
        let ok = false;
        try {
          const { protocol } = new URL(String(value));
          ok = protocol === 'http:' || protocol === 'https:';
        } catch {
          ok = false;
        }
        if (!ok) errors.push({ key: field.key, message: 'must be an http(s) URL' });
        break;
      }
      case 'list':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
          errors.push({ key: field.key, message: 'must be a list of strings' });
        }
        break;
      default:
        if (typeof value !== 'string') {
          errors.push({ key: field.key, message: 'must be a string' });
        } else if (field.pattern) {
          let re;
          try {
            re = new RegExp(field.pattern);
          } catch {
            re = null;
          }
          if (re && !re.test(value))
            errors.push({ key: field.key, message: 'does not match the expected format' });
        }
    }
  }

  // Choices may make other fields required (e.g. "Data Center" needs a URL).
  for (const field of definition.install) {
    if (field.type !== 'enum' || !field.choices) continue;
    const choice = field.choices.find(c => c.value === values[field.key]);
    for (const requiredKey of choice?.requires || []) {
      const v = values[requiredKey];
      if (v === undefined || v === null || v === '') {
        errors.push({ key: requiredKey, message: `required when ${field.key} is ${choice.value}` });
      }
    }
  }

  if (options.authMode === 'service-account') {
    const secretField = definition.auth.serviceAccount?.field;
    if (secretField && !options.hasCredential) {
      errors.push({ key: secretField, message: 'a credential is required for a service account' });
    }
  }

  return errors;
}

export default integrationDefinitionSchema;
