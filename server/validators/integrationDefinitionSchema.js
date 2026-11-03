// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import semver from 'semver';
import { sourceDeclarationSchema } from '../services/sources/producers/declared.js';
import { INTEGRATION_TYPES } from '../services/integrations/integrationTypes.js';

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

/** The namespace of custom integrations: built in iHub (the builder, migration V211). */
export const CUSTOM_DEFINITION_PREFIX = 'custom/';

/**
 * Whether a definition id names a custom integration (`custom/<id>`): one an
 * admin built in iHub, or that migration V211 made from a tool file.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isCustomDefinitionId(id) {
  return typeof id === 'string' && id.startsWith(CUSTOM_DEFINITION_PREFIX) && id.length > 7;
}

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

/** A version as definitions and installations write it: `MAJOR.MINOR.PATCH`, optionally `-prerelease`. */
const STRICT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Whether a value is a version in the exact form a definition writes it
 * (`1.4.0`, `2.0.0-rc.1`): no `v` prefix, no build metadata, nothing
 * `semver` would only accept after coercing it. Installations record their
 * `definitionVersion` in this form, and backup folder names embed it.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStrictSemver(value) {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    STRICT_SEMVER_PATTERN.test(value) &&
    semver.valid(value) === value
  );
}

const semverSchema = z
  .string()
  .regex(STRICT_SEMVER_PATTERN, 'version must be semantic (MAJOR.MINOR.PATCH)');

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

/**
 * Revisions of the definition format this server knows (`compatibility.schema`).
 * A definition that names a later revision is refused instead of loaded with
 * its unknown fields ignored.
 */
export const KNOWN_SCHEMA_REVISIONS = [1];

/**
 * What a definition needs to run: `ihub` is a semver range the server version
 * must satisfy (`">=5.7.0 <7"`); `schema` is the revision of the definition
 * format the file is written in. Both optional: a definition without them runs
 * on every version and uses revision 1.
 */
export const compatibilitySchema = z
  .object({
    ihub: z
      .string()
      .min(1)
      .max(128)
      .refine(range => semver.validRange(range) !== null, {
        message: 'compatibility.ihub must be a semver range (e.g. ">=5.7.0 <7")'
      })
      .optional(),
    schema: z.number().int().min(1).prefault(1)
  })
  .superRefine((compat, ctx) => {
    // Callers check the raw document first (`definitionSchemaRevision`); this
    // keeps a direct `validateIntegrationDefinition` from accepting one.
    if (!KNOWN_SCHEMA_REVISIONS.includes(compat.schema)) {
      ctx.addIssue({
        code: 'custom',
        path: ['schema'],
        message: unsupportedSchemaMessage(compat.schema)
      });
    }
  });

/**
 * The definition-format revision a raw `integration.json` declares
 * (`compatibility.schema`, default 1). Read from the raw document, before the
 * Zod parse: the parse strips fields it does not know, so a definition
 * written for a later revision would otherwise be accepted with those fields
 * silently dropped.
 *
 * @param {unknown} raw - parsed integration.json, not yet validated
 * @returns {{ revision: number, supported: boolean }}
 */
export function definitionSchemaRevision(raw) {
  const value = raw?.compatibility?.schema;
  const revision = value === undefined || value === null ? 1 : Number(value);
  const supported = Number.isInteger(revision) && KNOWN_SCHEMA_REVISIONS.includes(revision);
  return { revision: Number.isNaN(revision) ? value : revision, supported };
}

/** The message for a definition whose format revision this server does not know. */
export function unsupportedSchemaMessage(revision) {
  return `definition schema revision ${revision} is not supported by this server (known: ${KNOWN_SCHEMA_REVISIONS.join(', ')})`;
}

/** Release-note categories, named like iHub's own `docs/releases/<version>/` files. */
export const RELEASE_NOTE_CATEGORIES = ['features', 'fixes', 'breaking'];

/** A release-note file: a Markdown companion file inside the definition folder. */
const releaseNotePathSchema = companionPathSchema.refine(p => /\.md$/i.test(p), {
  message: 'release notes are Markdown files (.md)'
});

/**
 * One entry of a definition's release history: the version, when it was
 * published, a one-line localized summary for lists and the update dialog,
 * and the Markdown companion files with the full notes per category. A
 * release that changes what an installation stores names its `migration`
 * (phase 2 of the versioning concept).
 */
export const releaseSchema = z.object({
  version: semverSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  summary: localizedStringSchema,
  notes: z
    .object({
      features: releaseNotePathSchema.optional(),
      fixes: releaseNotePathSchema.optional(),
      breaking: releaseNotePathSchema.optional()
    })
    .strict()
    .optional(),
  /** Id of the definition migration this release needs: its own version (see `migrations`). */
  migration: semverSchema.optional()
});

/**
 * A value a declarative migration step writes into an installation: what an
 * install value can hold (a primitive, or a list of strings for a `list`
 * field). Whether it fits the field is checked after the last step, against
 * the definition's install fields.
 */
const migrationValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string())
]);

/** A scope id as an app binding stores it (`defaultScope`, `pinnedScope`). */
const migrationScopeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'must not contain control characters');

/** A rename whose source and destination differ. */
function renameOf(nameSchema) {
  return z
    .object({ from: nameSchema, to: nameSchema })
    .strict()
    .refine(rename => rename.from !== rename.to, { message: 'from and to must differ' });
}

/**
 * The path of a migration module inside the definition folder:
 * `migrations/<name>.js` (or `.mjs`), one level below `migrations/`, no
 * dot segments. Like a `script` connector it is one bundled file that
 * imports nothing from the folder (`definitions/migrationModules.js`).
 */
export const MIGRATION_MODULE_PATTERN =
  /^migrations\/[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.m?js$/;

/**
 * The migration steps (versioning concept §1), each an object with exactly
 * one of these keys. The seven declarative steps reach an installation's
 * `values`, its action policy (`actions.enabled`, `actions.disabled`,
 * `actions.overrides`) and the app bindings of the installation (`actions`,
 * `defaultScope`, `pinnedScope`); nothing else, and never `auth` or a
 * credential. A `module` step (versioning phase 3) names a JavaScript module
 * of the definition folder whose `up()` rewrites the same parts in code; it
 * runs only for a built-in definition or one from a registry trusted for code
 * whose catalog hashed the file (`definitions/migrationModules.js`).
 */
export const MIGRATION_STEP_SCHEMAS = Object.freeze({
  /** Move an install value to another key; a destination that holds a value is a collision. */
  renameValue: renameOf(identifierSchema),
  /** Write an install value; `when: missing` (default) only where the key holds none. */
  setValue: z
    .object({
      key: identifierSchema,
      value: migrationValueSchema,
      when: z.enum(['missing', 'always']).prefault('missing')
    })
    .strict(),
  /** Drop an install value. */
  removeValue: z.object({ key: identifierSchema }).strict(),
  /** Rewrite an install value (or each entry of a list value) through `map` (old → new). */
  mapValue: z
    .object({
      key: identifierSchema,
      map: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    })
    .strict()
    .refine(step => Object.keys(step.map).length > 0, { message: 'map lists at least one value' }),
  /** Rename an action in the policy and in the app bindings; an existing destination is a collision. */
  renameAction: renameOf(identifierSchema),
  /** Drop an action from the policy and from the app bindings (apps that named it get a warning). */
  removeAction: z.object({ name: identifierSchema }).strict(),
  /** Rewrite the default and pinned scope of the app bindings. */
  renameScope: renameOf(migrationScopeSchema),
  /** Run the `up()` of a migration module of the definition folder (`migrations/<name>.js`). */
  module: z
    .string()
    .max(256)
    .regex(
      MIGRATION_MODULE_PATTERN,
      'a migration module is a file migrations/<name>.js (or .mjs) of the definition folder'
    )
});

/** The step types, in the order the concept lists them. */
export const MIGRATION_STEP_TYPES = Object.freeze(Object.keys(MIGRATION_STEP_SCHEMAS));

/**
 * One step: an object with exactly one key out of
 * {@link MIGRATION_STEP_TYPES}; an unknown key is refused with the list of
 * known ones.
 */
export const migrationStepSchema = z
  .record(z.string(), z.unknown())
  .superRefine((step, ctx) => {
    const keys = Object.keys(step);
    const unknown = keys.filter(key => !MIGRATION_STEP_TYPES.includes(key));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: [unknown[0]],
        message: `unknown migration step "${unknown[0]}" (known: ${MIGRATION_STEP_TYPES.join(', ')})`
      });
      return;
    }
    if (keys.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `a migration step has exactly one of ${MIGRATION_STEP_TYPES.join(', ')}`
      });
      return;
    }
    const [type] = keys;
    const parsed = MIGRATION_STEP_SCHEMAS[type].safeParse(step[type]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: [type, ...issue.path], message: issue.message });
      }
    }
  })
  .transform(step => {
    const [type] = Object.keys(step);
    return { [type]: MIGRATION_STEP_SCHEMAS[type].parse(step[type]) };
  });

/**
 * The migration module files a list of migrations names
 * (`{ module: 'migrations/1.4.0.js' }` steps), each once, in order.
 *
 * @param {Array<{ steps?: Array<object> }>|undefined} migrations
 * @returns {string[]}
 */
export function migrationModuleFiles(migrations) {
  const files = [];
  for (const migration of Array.isArray(migrations) ? migrations : []) {
    for (const step of Array.isArray(migration?.steps) ? migration.steps : []) {
      const file = step && typeof step === 'object' ? step.module : undefined;
      if (typeof file === 'string' && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

/**
 * A definition migration: `id` is the version it brings an installation up
 * to (the release that names it), `steps` run in order.
 */
export const definitionMigrationSchema = z
  .object({
    id: semverSchema,
    steps: z.array(migrationStepSchema).min(1, 'a migration has at least one step').max(200)
  })
  .strict();

/**
 * Cross-checks between `releases` and `migrations`: a release names its own
 * version as its migration, that migration exists, and every migration is
 * named by the release of its version. Shared by the definition schema and
 * the marketplace preview, which receives a catalog item's copies of both.
 *
 * @param {Array<{ version: string, migration?: string }>|undefined} releases
 * @param {Array<{ id: string }>|undefined} migrations
 * @returns {Array<{ path: Array<string|number>, message: string }>} empty when consistent
 */
export function checkReleaseMigrations(releases, migrations) {
  const issues = [];
  const migrationIds = new Set();
  (migrations || []).forEach((migration, i) => {
    if (migrationIds.has(migration.id)) {
      issues.push({
        path: ['migrations', i, 'id'],
        message: `duplicate migration "${migration.id}"`
      });
    }
    migrationIds.add(migration.id);
  });
  (releases || []).forEach((release, i) => {
    if (!release.migration) return;
    if (release.migration !== release.version) {
      issues.push({
        path: ['releases', i, 'migration'],
        message: `a release names its own version as its migration ("${release.version}")`
      });
    }
    if (!migrationIds.has(release.migration)) {
      issues.push({
        path: ['releases', i, 'migration'],
        message: `migration "${release.migration}" is not listed in migrations`
      });
    }
  });
  (migrations || []).forEach((migration, i) => {
    const release = (releases || []).find(r => r.version === migration.id);
    if (release?.migration !== migration.id) {
      issues.push({
        path: ['migrations', i, 'id'],
        message: `migration "${migration.id}" needs the release ${migration.id} to name it ("migration": "${migration.id}")`
      });
    }
  });
  return issues;
}

/**
 * Validate a list of migrations on its own (a marketplace catalog item
 * carries a copy of the definition's `releases` and `migrations`).
 *
 * @param {unknown} migrations
 * @param {unknown} [releases]
 * @returns {{ success: true, data: Array<object> } | { success: false, errors: Array<{ path: Array, message: string }> }}
 */
export function validateDefinitionMigrations(migrations, releases) {
  const parsed = z.array(definitionMigrationSchema).safeParse(migrations ?? []);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map(issue => ({
        path: ['migrations', ...issue.path],
        message: issue.message
      }))
    };
  }
  if (releases !== undefined) {
    const releaseList = z.array(releaseSchema).safeParse(releases);
    if (!releaseList.success) {
      return {
        success: false,
        errors: releaseList.error.issues.map(issue => ({
          path: ['releases', ...issue.path],
          message: issue.message
        }))
      };
    }
    const issues = checkReleaseMigrations(releaseList.data, parsed.data);
    if (issues.length > 0) return { success: false, errors: issues };
  }
  return { success: true, data: parsed.data };
}

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

export const AUTH_MODES = [
  'none',
  'service-account',
  /** iHub holds one OAuth client (client credentials); every call runs as it. */
  'oauth-client',
  'api-key-user',
  'oauth-user',
  'enterprise-managed'
];

/**
 * When a field applies at all: only while another field has one of the
 * listed values, or while the installation uses one of the listed sign-in
 * modes. A field that does not apply is hidden in the wizard, never required,
 * and its stored value is ignored.
 */
const configFieldWhenSchema = z
  .object({
    field: identifierSchema.optional(),
    in: z.array(primitiveSchema).optional(),
    equals: primitiveSchema.optional(),
    authMode: z.array(z.enum(AUTH_MODES)).optional()
  })
  .refine(when => when.field || when.authMode, {
    message: 'a when clause names a field or sign-in modes'
  })
  .refine(when => !when.field || when.in !== undefined || when.equals !== undefined, {
    message: 'a when clause on a field needs "in" or "equals"'
  });

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
    /**
     * `url` fields: keep a trailing slash instead of stripping it. For an
     * endpoint that is used verbatim (an MCP server URL, an OAuth issuer),
     * where the slash is part of the identity other state is bound to.
     */
    keepTrailingSlash: z.boolean().optional(),
    /** `credential` fields: the credential types offered (any when empty). */
    credentialTypes: z.array(z.string().min(1).max(64)).optional(),
    /** `instance` fields: the definition the referenced installation must have. */
    definition: integrationIdSchema.optional(),
    /** Shown and required only while this holds (another field's value, the sign-in mode). */
    when: configFieldWhenSchema.optional()
  })
  .transform(field => ({ ...field, sensitive: field.sensitive ?? field.type === 'secret' }))
  .refine(field => field.type !== 'enum' || (field.choices && field.choices.length > 0), {
    message: 'an enum field needs choices'
  })
  .refine(field => field.keepTrailingSlash === undefined || field.type === 'url', {
    message: 'keepTrailingSlash applies to url fields only'
  })
  .refine(field => !(field.sensitive && field.default !== undefined), {
    message: 'a sensitive field cannot have a default value'
  });

const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~{}-]+$/; // `{}` allows a {field} template

/**
 * How a shared secret (one for the whole installation) is sent. `field` names
 * the sensitive install field that holds it; `header` may be a template.
 *
 * `credential` (the `openapi` and `http` protocols only) sends the credential
 * profile the installation references the way the profile's own type says:
 * a bearer token, basic user and password, an API key header, an OAuth2
 * client-credentials token, or an API key query parameter. The other kinds
 * never put a secret into a query parameter, where it would land in access
 * logs on both ends; `credential` does so only for an `apiKeyQuery` profile an
 * admin created for an API that wants it.
 */
export const SERVICE_ACCOUNT_KINDS = ['header', 'bearer', 'basic', 'credential'];

const serviceAccountAuthSchema = z.object({
  kind: z.enum(SERVICE_ACCOUNT_KINDS).prefault('header'),
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
    /** Client credentials: `field` names the sensitive install field holding the client secret. */
    oauthClient: z.object({ field: identifierSchema.optional() }).optional(),
    /**
     * Per-user OAuth: `field` names the sensitive install field holding the
     * secret of a pre-registered confidential client, when there is one.
     */
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
  /**
   * Base URL template; `{key}` placeholders are install fields. Absent: the
   * document's first `servers[]` entry (an OpenAPI tool file without a base
   * URL became such a definition in migration V211).
   */
  baseUrl: z.string().min(1).max(2048).optional(),
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

/**
 * The `http` protocol: every action is one request template (see
 * {@link httpRequestSchema}); the protocol holds what all of them share. The
 * base URL and the header values may name install fields as `{key}`.
 */
const httpProtocolSchema = z.object({
  type: z.literal('http'),
  /** Base URL template the actions' relative URLs are appended to; `{key}` placeholders are install fields. */
  baseUrl: z.string().min(1).max(2048).optional(),
  /** Static non-secret headers sent on every request (values may be install-field templates). */
  headers: z.record(z.string().regex(HTTP_HEADER_NAME), z.string().max(1024)).optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(5 * 1024 * 1024)
    .prefault(262144),
  timeoutMs: z.number().int().min(1000).max(120000).prefault(30000)
});

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** Content types an `http` action's body template is written in. */
export const HTTP_BODY_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain'
];

/**
 * One `http` action's request template. `{param}` placeholders name the
 * action's parameters (the model's arguments) and, failing that, install
 * fields. Every substitution is escaped for where it lands: URL-encoded in the
 * URL and the query, JSON-encoded in a JSON body, form-encoded in a form body;
 * a header value with a line break is refused.
 */
export const httpRequestSchema = z
  .object({
    method: z.enum(HTTP_METHODS).prefault('GET'),
    /** Path relative to `protocol.baseUrl` (`/orders/{orderId}`), or an absolute http(s) URL template. */
    url: z.string().min(1).max(2048),
    /** Query parameters; one whose value resolves to nothing is left out. */
    query: z.record(z.string().min(1).max(128), z.string().max(1024)).optional(),
    headers: z.record(z.string().regex(HTTP_HEADER_NAME), z.string().max(1024)).optional(),
    body: z
      .string()
      .max(64 * 1024)
      .optional(),
    contentType: z.enum(HTTP_BODY_TYPES).prefault('application/json')
  })
  .refine(request => !request.body || !['GET', 'HEAD'].includes(request.method), {
    message: 'a GET or HEAD request has no body'
  });

/**
 * How an `http` action's response becomes what the model sees: `result` is
 * the path to the part that matters (`$.data.items`), `fields` projects it
 * (each element, when it is a list) onto named paths.
 */
export const httpResponseMappingSchema = z.object({
  result: jsonPathSchema.optional(),
  fields: z.record(z.string().min(1).max(128), jsonPathSchema).optional()
});

/** Adapters the architecture names; `openapi`, `native` and `mcp` have one. */
export const PROTOCOL_TYPES = [
  'openapi',
  'mcp',
  'a2a',
  'native',
  'http',
  'script',
  'storage',
  'websearch'
];

export const MCP_TRANSPORT_TYPES = ['streamableHttp', 'sse', 'stdio', 'websocket'];

/**
 * An MCP server. Every transport setting may be fixed here or left to the
 * install fields of the same name (`transport`, `url`, `headers`, `command`,
 * `args`, `env`, `cwd`); a fixed value wins. The actions are whatever the
 * server lists (`tools/list`), so `actions` stays empty.
 */
const mcpProtocolSchema = z.object({
  type: z.literal('mcp'),
  transport: z
    .object({
      type: z.enum(MCP_TRANSPORT_TYPES).optional(),
      /** URL template of the http transports; `{key}` placeholders are install fields. */
      url: z.string().min(1).max(2048).optional(),
      /** Non-secret headers sent on every request (values may be templates). */
      headers: z.record(z.string().regex(HTTP_HEADER_NAME), z.string().max(1024)).optional(),
      command: z.string().min(1).max(1024).optional(),
      args: z.array(z.string().max(1024)).optional(),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional(),
      cwd: z.string().max(1024).optional()
    })
    .prefault({}),
  /** Tool id prefix; the default is `<instanceId>__`. */
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_]*$/)
    .max(32)
    .optional(),
  /** MCP Apps (`io.modelcontextprotocol/ui`): render the views the server's tools declare. */
  apps: z.object({ enabled: z.boolean().prefault(true) }).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  reconnect: z
    .object({
      enabled: z.boolean().optional(),
      maxRetries: z.number().int().min(0).max(20).optional(),
      initialDelayMs: z.number().int().min(100).max(60000).optional(),
      maxDelayMs: z.number().int().min(1000).max(120000).optional(),
      growthFactor: z.number().min(1).max(5).optional()
    })
    .optional()
});

/**
 * A built-in whose actions are implemented by a server module
 * (`services/integrations/protocols/native/connectors/<module>.js`).
 */
const nativeProtocolSchema = z.object({
  type: z.literal('native'),
  module: identifierSchema
});

/**
 * A remote A2A agent. The card URL may be fixed here or left to the install
 * field `cardUrl`; the skills of the card are the actions (`actions` stays
 * empty).
 */
const a2aProtocolSchema = z.object({
  type: z.literal('a2a'),
  /** Agent Card URL template; `{key}` placeholders are install fields. */
  cardUrl: z.string().min(1).max(2048).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  streaming: z.enum(['auto', 'never']).optional(),
  pollIntervalMs: z.number().int().min(250).max(60000).optional()
});

/**
 * A connector module shipped inside the definition folder (a companion file)
 * with the same contract as a built-in native connector. It runs in the
 * server process, so a registry may deliver one only when the admin marked
 * the registry as trusted for code, and every code file must carry a hash.
 */
export const SCRIPT_MODULE_PATTERN = /^(?!\.)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]+\.(m?js|cjs)$/;

const scriptProtocolSchema = z.object({
  type: z.literal('script'),
  /** Relative path of the connector module inside the folder, e.g. `connector.js`. */
  module: z.string().min(1).max(256).regex(SCRIPT_MODULE_PATTERN, 'invalid module path')
});

const ADAPTED_PROTOCOLS = new Set(['openapi', 'native', 'mcp', 'a2a', 'script', 'http']);

const reservedProtocolSchema = z
  .object({
    type: z.enum(PROTOCOL_TYPES.filter(t => !ADAPTED_PROTOCOLS.has(t)))
  })
  .passthrough();

export const integrationProtocolSchema = z.union([
  openapiProtocolSchema,
  nativeProtocolSchema,
  mcpProtocolSchema,
  a2aProtocolSchema,
  scriptProtocolSchema,
  httpProtocolSchema,
  reservedProtocolSchema
]);

export const SIDE_EFFECTS = ['read', 'write', 'destructive', 'unknown'];
export const DATA_FLOWS = ['internal', 'external'];
export const ACTION_CONNECTIONS = ['none', 'user', 'service', 'token'];

export const integrationActionSchema = z.object({
  /** Model-facing name; the tool id becomes `<instanceId>__<name>`. */
  name: identifierSchema,
  /**
   * The tool id the action keeps from before it was an integration
   * (`iFinder_search`), so apps, group grants and the MCP and A2A gateways
   * keep addressing it. Built-ins, and custom integrations (`custom/<id>`,
   * which migration V211 made from admin-created tool files); a definition
   * from a registry may not fix one (`ContentInstaller`).
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
  /**
   * The JSON schema of the action's arguments, for protocols whose actions
   * the definition describes itself: required for `http`; for `script` the
   * module's own `parameters` win and this is the fallback.
   */
  parameters: z
    .object({ type: z.literal('object') })
    .passthrough()
    .optional(),
  /** `http` only: the request the action sends. */
  request: httpRequestSchema.optional(),
  /** `http` only: what of the response the model sees. */
  response: httpResponseMappingSchema.optional(),
  sideEffect: z.enum(SIDE_EFFECTS).prefault('unknown'),
  dataFlow: z.enum(DATA_FLOWS).prefault('external'),
  enabledByDefault: z.boolean().prefault(true),
  /**
   * An app binds this action only by naming it in the binding's `actions`; a
   * binding without `actions` ("every action") leaves it out. For an action
   * whose reach goes beyond the integration's purpose (e.g. raw access next
   * to a curated search), or one an app binding the installation for
   * something else should not get unasked (iAssistant's `ask`, next to its
   * model).
   */
  bindExplicitly: z.boolean().prefault(false),
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
  /**
   * The action lists at most `size` items per call (a portal's own cap): the
   * adapter pages with these offset and limit parameters until a short page.
   */
  paging: z
    .object({
      offset: identifierSchema,
      limit: identifierSchema,
      size: z.number().int().min(1).max(1000)
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

/**
 * What the installation test may ask the admin for besides the settings: one
 * free-text input (a sample search of a directory) the wizard shows next to
 * **Test connection** and passes to the connector as `testInput[key]`.
 */
export const integrationTestSchema = z.object({
  input: z
    .object({
      key: identifierSchema,
      title: localizedStringSchema,
      description: localizedStringSchema.optional()
    })
    .optional()
});

/** Companion JSON files a definition may name as example apps (`apps/<name>.json`). */
export const EXAMPLE_APP_FILE_PATTERN =
  /^(?!\.)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.json$/;

/** The most example apps one definition ships. */
export const MAX_EXAMPLE_APPS = 5;

/**
 * An example app a definition ships: a companion JSON file holding an app
 * configuration (`appConfigSchema`) that binds the integration by its
 * definition id or type. The admin creates it for one installation from the
 * installation page (`services/integrations/exampleApps.js`).
 */
export const integrationExampleAppSchema = z
  .object({
    file: companionPathSchema.regex(EXAMPLE_APP_FILE_PATTERN, 'must be a .json companion file')
  })
  .strict();

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
    /** What the definition needs to run (iHub version range, format revision). */
    compatibility: compatibilitySchema.prefault({}),
    /** Release history, newest first; `releases[0].version` is `version`. */
    releases: z.array(releaseSchema).optional(),
    /**
     * Declarative migrations that bring an installation (its values, action
     * policy and app bindings) up to a release; each `id` is the version of
     * the release that names it.
     */
    migrations: z.array(definitionMigrationSchema).optional(),
    name: localizedStringSchema,
    description: localizedStringSchema.optional(),
    publisher: integrationPublisherSchema.optional(),
    icon: httpOrCompanionSchema.optional(),
    categories: z.array(z.string().min(1).max(64)).prefault([]),
    /** The contract the integration fulfils (`services/integrations/integrationTypes.js`). */
    type: z.enum(INTEGRATION_TYPES).optional(),
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
    /**
     * Built-in singletons only: the installation exists and is enabled at all
     * times (iHub's own tools). It is created when missing and can neither be
     * removed nor disabled; only its actions and groups are edited.
     */
    alwaysInstalled: z.boolean().prefault(false),
    protocol: integrationProtocolSchema,
    auth: integrationAuthSchema,
    install: z.array(configFieldSchema).prefault([]),
    capabilities: z.array(z.enum(CAPABILITIES)).prefault(['tools']),
    scopes: integrationScopesSchema.optional(),
    sources: z.record(identifierSchema, integrationSourceMappingSchema).optional(),
    health: integrationHealthSchema.optional(),
    test: integrationTestSchema.optional(),
    actions: z.array(integrationActionSchema).prefault([]),
    instructions: localizedStringSchema.optional(),
    /** Example apps shipped as companion files, offered on the installation page. */
    exampleApps: z
      .array(integrationExampleAppSchema)
      .max(MAX_EXAMPLE_APPS)
      .refine(list => new Set(list.map(e => e.file)).size === list.length, {
        message: 'each example app file is listed once'
      })
      .optional(),
    _meta: z.record(z.string(), z.any()).optional()
  })
  .superRefine((def, ctx) => {
    const addIssue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    const keys = checkInstallFieldKeys(def, addIssue);
    const actionNames = checkActions(def, addIssue);
    checkWebSearchContract(def, actionNames, addIssue);
    checkBuiltInFlags(def, addIssue);
    checkScopes(def, actionNames, addIssue);
    checkActionReferences(def, actionNames, addIssue);
    const serviceField = def.auth.serviceAccount?.field;
    if (serviceField && !keys.has(serviceField)) {
      addIssue(['auth', 'serviceAccount', 'field'], `"${serviceField}" is not an install field`);
    }
    checkReleaseOrder(def, addIssue);
    for (const issue of checkReleaseMigrations(def.releases, def.migrations)) {
      addIssue(issue.path, issue.message);
    }
  });

/**
 * The cross-field checks of {@link integrationDefinitionSchema}'s
 * `superRefine`, one per concern, called in a fixed order so the issues come
 * out in the order they always did. Each reports through `addIssue(path,
 * message)`, which adds a `custom` Zod issue.
 *
 * @callback AddIssue
 * @param {Array<string|number>} path
 * @param {string} message
 */

/**
 * Install field keys are unique.
 * @param {object} def - the parsed definition
 * @param {AddIssue} addIssue
 * @returns {Set<string>} every install field key
 */
function checkInstallFieldKeys(def, addIssue) {
  const keys = new Set();
  def.install.forEach((field, i) => {
    if (keys.has(field.key))
      addIssue(['install', i, 'key'], `duplicate install field "${field.key}"`);
    keys.add(field.key);
  });
  return keys;
}

/**
 * Action names are unique, an openapi action names its operation, only a
 * built-in or a custom (`custom/<id>`) definition fixes tool ids, and
 * `request` / `response` are an http action's (see {@link checkHttpAction}).
 * @param {object} def - the parsed definition
 * @param {AddIssue} addIssue
 * @returns {Set<string>} every declared action name
 */
function checkActions(def, addIssue) {
  const actionNames = new Set();
  def.actions.forEach((action, i) => {
    if (actionNames.has(action.name)) {
      addIssue(['actions', i, 'name'], `duplicate action "${action.name}"`);
    }
    actionNames.add(action.name);
    if (def.protocol.type === 'openapi' && !action.operationId) {
      addIssue(['actions', i, 'operationId'], 'an openapi action needs an operationId');
    }
    if (action.toolId && !def.builtIn && !isCustomDefinitionId(def.id)) {
      addIssue(
        ['actions', i, 'toolId'],
        'only a built-in or a custom (custom/<id>) definition may fix its tool ids'
      );
    }
    checkHttpAction(def, action, i, addIssue);
  });
  return actionNames;
}

/**
 * An http action has a request, and a relative request URL needs
 * `protocol.baseUrl`; no other protocol's action has a request or response.
 * @param {object} def - the parsed definition
 * @param {object} action - one of `def.actions`
 * @param {number} i - the action's index
 * @param {AddIssue} addIssue
 */
function checkHttpAction(def, action, i, addIssue) {
  if (def.protocol.type !== 'http') {
    if (action.request || action.response) {
      addIssue(
        ['actions', i, action.request ? 'request' : 'response'],
        'request and response belong to http actions'
      );
    }
    return;
  }
  if (!action.request) {
    addIssue(['actions', i, 'request'], 'an http action needs a request');
  } else if (!/^https?:\/\//i.test(action.request.url) && !def.protocol.baseUrl) {
    addIssue(['actions', i, 'request', 'url'], 'a relative URL needs protocol.baseUrl');
  }
}

/**
 * The web search engine contract: the web search feature calls the engine's
 * action `search` (docs/integration-development.md). Protocols whose actions
 * are listed at run time (MCP, A2A) cannot declare it.
 * @param {object} def - the parsed definition
 * @param {Set<string>} actionNames
 * @param {AddIssue} addIssue
 */
function checkWebSearchContract(def, actionNames, addIssue) {
  if (
    def.type === 'web-search' &&
    !['mcp', 'a2a'].includes(def.protocol.type) &&
    !actionNames.has('search')
  ) {
    addIssue(['actions'], 'a web-search definition needs an action named "search"');
  }
}

/**
 * Only a built-in singleton is always installed, and a built-in runs on the
 * native protocol, not a script module.
 * @param {object} def - the parsed definition
 * @param {AddIssue} addIssue
 */
function checkBuiltInFlags(def, addIssue) {
  if (def.alwaysInstalled && !(def.builtIn && def.singleton)) {
    addIssue(['alwaysInstalled'], 'only a built-in singleton can be always installed');
  }
  if (def.protocol.type === 'script' && def.builtIn) {
    addIssue(
      ['protocol', 'type'],
      'a built-in integration uses the native protocol, not a script module'
    );
  }
}

/**
 * Declarative scopes (any protocol but native and script) name their action,
 * map and applyAs; the actions they name are declared.
 * @param {object} def - the parsed definition
 * @param {Set<string>} actionNames
 * @param {AddIssue} addIssue
 */
function checkScopes(def, actionNames, addIssue) {
  if (!def.scopes) return;
  const declarative = def.protocol.type !== 'native' && def.protocol.type !== 'script';
  if (declarative && (!def.scopes.action || !def.scopes.map || !def.scopes.applyAs)) {
    addIssue(['scopes'], 'scopes need action, map and applyAs unless the protocol is native');
  }
  if (def.scopes.action && !actionNames.has(def.scopes.action)) {
    addIssue(['scopes', 'action'], `scopes.action "${def.scopes.action}" is not a declared action`);
  }
  for (const target of Object.keys(def.scopes.applyAs || {})) {
    const [actionName] = target.split('.');
    if (!actionNames.has(actionName)) {
      addIssue(['scopes', 'applyAs', target], `"${actionName}" is not a declared action`);
    }
  }
}

/**
 * The source mappings and the health check name declared actions.
 * @param {object} def - the parsed definition
 * @param {Set<string>} actionNames
 * @param {AddIssue} addIssue
 */
function checkActionReferences(def, actionNames, addIssue) {
  for (const actionName of Object.keys(def.sources || {})) {
    if (!actionNames.has(actionName)) {
      addIssue(['sources', actionName], `"${actionName}" is not a declared action`);
    }
  }
  if (def.health && !actionNames.has(def.health.action)) {
    addIssue(['health', 'action'], `health.action "${def.health.action}" is not a declared action`);
  }
}

/**
 * The release history, when given, starts with the definition's version and
 * lists each version once, newest first.
 * @param {object} def - the parsed definition
 * @param {AddIssue} addIssue
 */
function checkReleaseOrder(def, addIssue) {
  if (!def.releases) return;
  if (def.releases.length === 0) {
    addIssue(['releases'], 'releases lists at least the current version, or is left out');
  } else if (def.releases[0].version !== def.version) {
    addIssue(
      ['releases', 0, 'version'],
      `the newest release must be the definition version ${def.version}`
    );
  }
  for (let i = 1; i < def.releases.length; i += 1) {
    if (!semver.gt(def.releases[i - 1].version, def.releases[i].version)) {
      addIssue(['releases', i, 'version'], 'releases are listed newest first, each version once');
    }
  }
}

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
 * Whether a field applies, given the other values and the sign-in mode
 * (`when` clause); a field without one always applies.
 *
 * @param {object} field - ConfigField
 * @param {Record<string, unknown>} [values]
 * @param {string} [authMode]
 * @returns {boolean}
 */
export function fieldApplies(field, values = {}, authMode) {
  const when = field?.when;
  if (!when) return true;
  if (when.authMode && !when.authMode.includes(authMode || 'none')) return false;
  if (when.field) {
    const actual = values[when.field];
    if (when.equals !== undefined && actual !== when.equals) return false;
    if (when.in && !when.in.includes(actual)) return false;
  }
  return true;
}

/**
 * The sensitive install field a sign-in mode stores in the credential store:
 * the service account's secret, the OAuth client's secret, or the secret of a
 * pre-registered client for per-user OAuth (optional there).
 *
 * @param {object} definition
 * @param {string} mode - auth mode
 * @returns {{ key: string, required: boolean } | null}
 */
export function secretFieldForMode(definition, mode) {
  const auth = definition?.auth || {};
  if (mode === 'service-account') {
    return auth.serviceAccount?.field ? { key: auth.serviceAccount.field, required: true } : null;
  }
  if (mode === 'oauth-client') {
    const key =
      auth.oauthClient?.field ||
      (definition.install || []).find(f => f.key === 'clientSecret' && f.sensitive)?.key;
    return key ? { key, required: true } : null;
  }
  if (mode === 'oauth-user') {
    const key = auth.oauthUser?.field;
    return key ? { key, required: false } : null;
  }
  return null;
}

/**
 * Check an installation's non-sensitive values against the definition's
 * install fields: unknown keys, missing required fields, type mismatches,
 * enum membership, patterns, ranges, and sensitive values that must not be
 * stored in a config file. A field whose `when` clause does not hold is
 * neither required nor checked.
 *
 * @param {object} definition - a validated definition
 * @param {Record<string, unknown>} values
 * @param {{ authMode?: string, hasCredential?: boolean }} [options]
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
    if (!fieldApplies(field, values, options.authMode)) continue;
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
    if (!fieldApplies(field, values, options.authMode)) continue;
    const choice = field.choices.find(c => c.value === values[field.key]);
    for (const requiredKey of choice?.requires || []) {
      const v = values[requiredKey];
      if (v === undefined || v === null || v === '') {
        errors.push({ key: requiredKey, message: `required when ${field.key} is ${choice.value}` });
      }
    }
  }

  const secret = secretFieldForMode(definition, options.authMode);
  if (secret?.required && !options.hasCredential) {
    errors.push({ key: secret.key, message: 'a credential is required for this sign-in mode' });
  }

  return errors;
}

export default integrationDefinitionSchema;
