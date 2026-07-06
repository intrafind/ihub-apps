import { z } from 'zod';
import { zSafeId } from './index.js';

/**
 * Central credential store schema.
 *
 * Named, encrypted auth profiles referenced by `credentialRef` from elsewhere
 * (OpenAPI tools, MCP servers, OIDC/LDAP/NTLM/Jira/cloud-storage integrations).
 * Secret fields are persisted as ENC[...] ciphertext on disk and decrypted by
 * configCache when the store is loaded into memory, so CredentialService
 * consumers always receive plaintext.
 *
 * Secret-bearing fields below accept plaintext, an env-var placeholder
 * (`${VAR}`), or ENC[...] ciphertext — encryption-on-save is handled by the
 * admin route, decryption-on-load by configCache.
 */

const idSchema = zSafeId.min(1).max(64);

const localizedOrPlainString = z.union([
  z.record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), z.string()),
  z.string()
]);

const baseFields = {
  id: idSchema,
  name: localizedOrPlainString.optional(),
  description: localizedOrPlainString.optional()
};

/**
 * Discriminated union on credential `type`.
 *
 * - oauth2:       OAuth2 client_credentials / refresh_token (Jira, OIDC, cloud storage, MCP oauth)
 * - bearer:       static bearer token (MCP bearer)
 * - basic:        username + password (MCP basic, LDAP bind)
 * - apiKeyHeader: API key sent as a request header (OpenAPI tools)
 * - apiKeyQuery:  API key sent as a URL query parameter (OpenAPI tools)
 * - secret:       opaque single secret (NTLM/LDAP passwords, iFinder private key,
 *                 cloud-storage tenant id) that does not map to a request auth scheme
 */
export const credentialSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseFields,
    type: z.literal('oauth2'),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().optional(),
    grantType: z.enum(['client_credentials', 'refresh_token']).default('client_credentials'),
    refreshToken: z.string().optional()
  }),
  z.object({
    ...baseFields,
    type: z.literal('bearer'),
    token: z.string().min(1)
  }),
  z.object({
    ...baseFields,
    type: z.literal('basic'),
    username: z.string().min(1),
    password: z.string().min(1)
  }),
  z.object({
    ...baseFields,
    type: z.literal('apiKeyHeader'),
    headerName: z.string().min(1),
    key: z.string().min(1)
  }),
  z.object({
    ...baseFields,
    type: z.literal('apiKeyQuery'),
    paramName: z.string().min(1),
    key: z.string().min(1)
  }),
  z.object({
    ...baseFields,
    type: z.literal('secret'),
    value: z.string().min(1)
  })
]);

export const credentialsFileSchema = z.object({
  credentials: z.record(idSchema, credentialSchema).default({})
});

/**
 * Secret-bearing field names per credential type. Used by the admin route to
 * know which fields to encrypt-on-save / redact-on-read, and by the migration
 * to map legacy inline secrets onto the right field.
 */
export const SECRET_FIELDS_BY_TYPE = {
  oauth2: ['clientSecret', 'refreshToken'],
  bearer: ['token'],
  basic: ['password'],
  apiKeyHeader: ['key'],
  apiKeyQuery: ['key'],
  secret: ['value']
};

/**
 * Validate a single credential profile.
 * @param {object} data
 * @returns {{ success: boolean, data?: object, errors?: Array }}
 */
export function validateCredential(data) {
  const result = credentialSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.errors };
}

/**
 * Validate the whole credentials file.
 * @param {object} data
 * @returns {{ success: boolean, data?: object, errors?: Array }}
 */
export function validateCredentialsFile(data) {
  const result = credentialsFileSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.errors };
}

export default credentialSchema;
