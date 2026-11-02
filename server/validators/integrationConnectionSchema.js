// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';

/**
 * The `Connection` record of the unified integrations (concept
 * `2026-10-20 Unified Integrations/04-architecture.md` §1.4, issue #2912):
 * who is connected to which installed integration, with which status, and
 * where the secret material lives. One record per (installation, principal),
 * stored in the pluggable storage namespace `integration-connections`.
 *
 * The record never holds a token. `secretRef` points at the place the secret
 * already lives:
 *   - `tokenstore:<service>/<file stem>` — a `TokenStorageService` file under
 *     `contents/integrations/<service>/<file stem>.json` (per-user OAuth);
 *   - `credential:<credentialRef>` — a profile in `config/credentials.json`
 *     (a shared service account the admin configured on the installation).
 *
 * `kind: 'sso'` (iFinder, iAssistant) carries no secret at all: the identity
 * is derived per request from the user's own sign-in.
 *
 * @module validators/integrationConnectionSchema
 */

/** Statuses a connection can be in. */
export const CONNECTION_STATUSES = Object.freeze([
  'active',
  'expired',
  'revoked',
  'failed',
  'needs-reconnect'
]);

/** How a connection authenticates. */
export const CONNECTION_KINDS = Object.freeze(['oauth-user', 'api-key', 'service-account', 'sso']);

/** `secretRef` forms: a token store file or a credential store profile. */
export const SECRET_REF_PATTERN =
  /^(tokenstore:[A-Za-z0-9._@+-]+\/[A-Za-z0-9._@+-]+|credential:[A-Za-z0-9._@+:-]+)$/;

const isoDate = z.string().datetime({ offset: true });

const userPrincipalSchema = z.object({
  type: z.literal('user'),
  id: z.string().min(1).max(512)
});

/**
 * A shared connection is an admin-owned service account offered to groups —
 * never a personal OAuth grant (decided 2026-10-31).
 */
const sharedPrincipalSchema = z.object({
  type: z.literal('shared'),
  groups: z.array(z.string().min(1).max(128)).prefault([])
});

export const connectionPrincipalSchema = z.discriminatedUnion('type', [
  userPrincipalSchema,
  sharedPrincipalSchema
]);

export const integrationConnectionSchema = z
  .object({
    /** `conn_<hash>`; a pure function of (integration, principal), see connectionIdFor. */
    id: z.string().regex(/^conn_[a-f0-9]{16,64}$/),
    /** Installation id (`contents/config/integrations.json`). */
    integration: z.string().min(1).max(64),
    principal: connectionPrincipalSchema,
    kind: z.enum(CONNECTION_KINDS),
    status: z.enum(CONNECTION_STATUSES),
    /** OAuth: the authorization server that issued the credentials. */
    issuer: z.string().max(2048).nullable().prefault(null),
    scopesGranted: z.array(z.string().min(1).max(512)).max(200).prefault([]),
    externalAccount: z
      .object({
        id: z.string().max(512).optional(),
        label: z.string().max(512).optional()
      })
      .nullable()
      .prefault(null),
    expiresAt: isoDate.nullable().prefault(null),
    lastRefreshedAt: isoDate.nullable().prefault(null),
    lastUsedAt: isoDate.nullable().prefault(null),
    /** Stable error code of the last failure (never upstream text). */
    error: z.string().max(128).nullable().prefault(null),
    /** Transient refresh failures in a row (reset by a successful refresh). */
    refreshFailures: z.number().int().min(0).prefault(0),
    /** Until when the token endpoint is left alone after repeated failures. */
    retryAfter: isoDate.nullable().prefault(null),
    /** Where the secret lives; null for `sso`. Never the secret itself. */
    secretRef: z.string().regex(SECRET_REF_PATTERN).max(600).nullable(),
    /**
     * Hash of the installation settings the credentials were issued under
     * (endpoint, tenant, client id). A connection whose installation no longer
     * has this fingerprint is invalidated, so a token issued for one endpoint
     * is never sent to another.
     */
    fingerprint: z.string().max(128).nullable().prefault(null),
    createdAt: isoDate,
    updatedAt: isoDate
  })
  .superRefine((record, ctx) => {
    if (record.kind === 'sso' && record.secretRef) {
      ctx.addIssue({ code: 'custom', path: ['secretRef'], message: 'sso carries no secret' });
    }
    if (record.kind !== 'sso' && !record.secretRef) {
      ctx.addIssue({ code: 'custom', path: ['secretRef'], message: 'secretRef is required' });
    }
    if (record.kind === 'oauth-user' && record.principal.type !== 'user') {
      ctx.addIssue({
        code: 'custom',
        path: ['principal'],
        message: 'a personal OAuth grant can never be a shared connection'
      });
    }
    if (record.secretRef?.startsWith('credential:') && record.principal.type !== 'shared') {
      ctx.addIssue({
        code: 'custom',
        path: ['secretRef'],
        message: 'a credential store secret belongs to a shared connection'
      });
    }
  });

/**
 * Validate a connection record.
 * @param {unknown} record
 * @returns {import('zod').SafeParseReturnType<unknown, Object>}
 */
export function validateIntegrationConnection(record) {
  return integrationConnectionSchema.safeParse(record);
}
