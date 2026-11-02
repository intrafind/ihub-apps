// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { APPROVAL_MODES } from '../../shared/toolApproval.js';
import {
  DATA_FLOWS,
  HTTP_BODY_TYPES,
  HTTP_METHODS,
  MCP_TRANSPORT_TYPES,
  SIDE_EFFECTS,
  localizedStringSchema
} from './integrationDefinitionSchema.js';

/**
 * The draft the integration builder (**Admin → Integrations → Add manually**)
 * sends: one custom integration as the admin sees it. The server turns it
 * into a definition folder under `contents/integration-definitions/` plus an
 * installation (`services/integrations/builder/builderPackage.js`); nothing
 * else is stored.
 *
 * Sources (`source`): `openapi`, `mcp`, `a2a`, `http`, `script`.
 *
 * @module validators/integrationBuilderSchema
 */

export const BUILDER_SOURCES = ['openapi', 'mcp', 'a2a', 'http', 'script'];

/** Sign-in modes the builder offers; `oauth-user` only for an MCP server. */
export const BUILDER_AUTH_MODES = ['none', 'service-account', 'oauth-user'];

/** How a service account's credential is sent (see `SERVICE_ACCOUNT_KINDS`). */
export const BUILDER_AUTH_KINDS = ['credential', 'bearer', 'header', 'basic'];

/** An installation id: what tool ids (`<id>__<action>`) and bindings use. */
const instanceIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'id: lower-case letters, digits and "-", starting with a letter or digit'
  );

/** An action name: what the model calls (`identifierSchema` of the definition). */
const actionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    'must start with a letter and contain only letters, digits and _'
  );

const headerRecordSchema = z.record(z.string().min(1).max(128), z.string().max(1024));

const jsonSchemaObject = z.object({ type: z.literal('object') }).passthrough();

const builderActionSchema = z.object({
  name: actionNameSchema,
  title: localizedStringSchema.optional(),
  description: localizedStringSchema.optional(),
  /** `http` and `script`: the argument schema. Read-only for the other sources. */
  parameters: jsonSchemaObject.optional(),
  sideEffect: z.enum(SIDE_EFFECTS).prefault('unknown'),
  dataFlow: z.enum(DATA_FLOWS).prefault('external'),
  /** Approval mode of this action (#2945); absent = inherit. */
  approval: z.enum(APPROVAL_MODES).optional(),
  enabled: z.boolean().prefault(true),
  /** `openapi`: the operation. */
  operationId: z.string().min(1).max(200).optional(),
  /** `http`: the request template. */
  request: z
    .object({
      method: z.enum(HTTP_METHODS).prefault('GET'),
      url: z.string().min(1).max(2048),
      query: z.record(z.string().min(1).max(128), z.string().max(1024)).optional(),
      headers: headerRecordSchema.optional(),
      body: z
        .string()
        .max(64 * 1024)
        .optional(),
      contentType: z.enum(HTTP_BODY_TYPES).prefault('application/json')
    })
    .optional(),
  /** `http`: the JSONPath response mapping. */
  response: z
    .object({
      result: z.string().max(256).optional(),
      fields: z.record(z.string().min(1).max(128), z.string().max(256)).optional()
    })
    .optional(),
  /**
   * The tool id the action kept from a tool file (migration V211). Read-only:
   * the builder carries it through unchanged so apps keep addressing it.
   */
  toolId: z.string().max(128).optional()
});

export const builderDraftSchema = z
  .object({
    /** The installation id; fixed once created. */
    instanceId: instanceIdSchema,
    /** `custom/<id>`; derived from `instanceId` when created. */
    definitionId: z.string().max(128).optional(),
    name: localizedStringSchema,
    description: localizedStringSchema.optional(),
    /** An https URL of the icon (shown by registries and the Marketplace), or empty. */
    icon: z
      .string()
      .max(2048)
      .refine(value => value === '' || /^https:\/\//i.test(value), 'icon: an https URL')
      .optional(),
    source: z.enum(BUILDER_SOURCES),
    auth: z
      .object({
        mode: z.enum(BUILDER_AUTH_MODES).prefault('none'),
        kind: z.enum(BUILDER_AUTH_KINDS).prefault('credential'),
        header: z.string().max(128).optional(),
        valuePrefix: z.string().max(64).optional(),
        credentialRef: z.string().max(128).optional(),
        oauthScopes: z.array(z.string().max(256)).max(50).optional(),
        oauthClientId: z.string().max(256).optional()
      })
      .prefault({ mode: 'none' }),
    openapi: z
      .object({
        /** The parsed OpenAPI document (stored as `openapi.json`), or an https URL of it. */
        document: z.union([z.record(z.string(), z.any()), z.string().max(2048)]),
        /** Absent: the document's first `servers[]` entry. */
        baseUrl: z.string().min(1).max(2048).optional(),
        headers: headerRecordSchema.optional()
      })
      .optional(),
    mcp: z
      .object({
        transport: z.enum(MCP_TRANSPORT_TYPES).prefault('streamableHttp'),
        url: z.string().max(2048).optional(),
        headers: headerRecordSchema.optional(),
        command: z.string().max(1024).optional(),
        args: z.array(z.string().max(1024)).max(64).optional(),
        env: z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096))
          .optional(),
        cwd: z.string().max(1024).optional()
      })
      .optional(),
    a2a: z.object({ cardUrl: z.string().min(1).max(2048) }).optional(),
    http: z
      .object({
        baseUrl: z.string().max(2048).optional(),
        headers: headerRecordSchema.optional()
      })
      .optional(),
    script: z
      .object({
        /** The connector module's source (one bundled ES module). */
        module: z
          .string()
          .min(1)
          .max(512 * 1024)
      })
      .optional(),
    actions: z.array(builderActionSchema).max(200).prefault([]),
    /** Approval default of the installation (#2945); absent = inherit. */
    approvalDefault: z.enum(APPROVAL_MODES).optional()
  })
  .superRefine((draft, ctx) => {
    if (!draft[draft.source]) {
      ctx.addIssue({
        code: 'custom',
        path: [draft.source],
        message: `the ${draft.source} settings are missing`
      });
    }
    if (draft.auth.mode === 'oauth-user' && draft.source !== 'mcp') {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'mode'],
        message: 'per-user OAuth is available for MCP servers only'
      });
    }
    if (draft.auth.mode === 'service-account' && !draft.auth.credentialRef) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'credentialRef'],
        message: 'pick the credential the service account uses'
      });
    }
    if (
      draft.auth.mode === 'service-account' &&
      draft.auth.kind === 'header' &&
      !draft.auth.header
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'header'],
        message: 'name the header the key is sent in'
      });
    }
    const names = new Set();
    draft.actions.forEach((action, i) => {
      if (names.has(action.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'name'],
          message: `duplicate action "${action.name}"`
        });
      }
      names.add(action.name);
      if (draft.source === 'openapi' && !action.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'operationId'],
          message: 'pick the operation'
        });
      }
      if (draft.source === 'http' && !action.request) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'request'],
          message: 'an HTTP action needs a request'
        });
      }
    });
    if (['openapi', 'http', 'script'].includes(draft.source) && draft.actions.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'add at least one action' });
    }
  });

/**
 * Validate a builder draft.
 * @param {unknown} data
 * @returns {{ success: true, data: object } | { success: false, errors: Array }}
 */
export function validateBuilderDraft(data) {
  const result = builderDraftSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.issues };
}

/** What `POST /api/admin/integrations/builder/_import` takes. */
export const builderImportSchema = z.object({
  kind: z.enum(['openapi', 'mcp', 'a2a']),
  /** openapi: `{ type: 'url', url }` or `{ type: 'inline', spec }`; mcp / a2a: the draft's source block. */
  source: z.record(z.string(), z.any()),
  /** mcp / a2a: the sign-in the probe uses (a saved credential only). */
  auth: z.record(z.string(), z.any()).optional()
});
