import { z } from 'zod';
import { zSafeId } from './index.js';

/**
 * Schema for `type: "openapi"` tool entries (issue #1462).
 *
 * An OpenAPI tool references an OpenAPI document (url | inline | file), a single
 * operationId, and a credential profile (by `credentialRef`). At call time the
 * OpenApiToolRunner parses the spec, validates the LLM-supplied params against
 * the operation schema, performs an SSRF-guarded HTTP call, and post-processes
 * the response (x-display stripping, size cap, pagination).
 *
 * Auth is credentialRef-only — there is no inline auth block. Credentials live
 * in the central store (contents/config/credentials.json) and are resolved via
 * CredentialService.
 */

const localizedOrPlainString = z.union([
  z.record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), z.string()),
  z.string()
]);

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: z.string().url() }),
  z.object({ type: z.literal('file'), path: z.string().min(1) }),
  z.object({ type: z.literal('inline'), spec: z.union([z.string().min(1), z.record(z.any())]) })
]);

export const openApiBlockSchema = z.object({
  source: sourceSchema,
  operationId: z.string().min(1),
  // Override the spec's servers[0].url when set.
  baseUrl: z.string().url().optional(),
  // Authentication is optional — public OpenAPI endpoints are valid.
  // When set, `credentialRef` must point at an entry in the central credential
  // store; the runner resolves the profile and applies the matching auth scheme.
  auth: z.object({ credentialRef: z.string().min(1) }).optional(),
  // Static extra request headers merged into every call.
  headers: z.record(z.string()).default({}),
  // Mirror astron's x-display: dot-paths (supporting `items[].field` wildcards)
  // stripped from the response before it is returned to the LLM.
  xDisplay: z
    .object({
      hideFields: z.array(z.string()).default([])
    })
    .default({ hideFields: [] }),
  // Hard response-size cap (bytes); oversized payloads are truncated.
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(5 * 1024 * 1024)
    .default(262144),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  // SSRF policy for outbound calls. Defaults to blocking private/internal IPs;
  // operators can allow specific hostnames when intentionally targeting an
  // internal API.
  security: z
    .object({
      blockPrivateIps: z.boolean().default(true),
      allowedHosts: z.array(z.string()).default([])
    })
    .default({ blockPrivateIps: true, allowedHosts: [] })
});

export const openApiToolDefSchema = z.object({
  id: zSafeId.min(1).max(64),
  name: localizedOrPlainString,
  description: localizedOrPlainString.optional(),
  type: z.literal('openapi'),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(100).optional(),
  requestDelayMs: z.number().int().min(0).optional(),
  openapi: openApiBlockSchema
});

/**
 * Validate an OpenAPI tool definition.
 * @param {object} data
 * @returns {{ success: boolean, data?: object, errors?: Array }}
 */
export function validateOpenApiToolDef(data) {
  const result = openApiToolDefSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.errors };
}

export default openApiToolDefSchema;
