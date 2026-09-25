import { z } from 'zod';
import { zSafeId } from './common.js';

const localizedStringSchema = z.record(
  z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format'),
  z.string().min(1)
);

const idSchema = zSafeId.min(1).max(64);

// RFC 9110 field-name token.
const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// Headers the MCP transport sets itself. Letting an auth block override them
// would break framing or session resumption, so they are refused up front.
const RESERVED_HEADER_NAMES = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'transfer-encoding'
]);

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(HTTP_HEADER_NAME, 'header name must be a valid HTTP header name')
  .refine(name => !RESERVED_HEADER_NAMES.has(name.toLowerCase()), {
    message: 'header name is reserved for the MCP transport'
  });

const headerValueSchema = z
  .string()
  .max(1024)
  .regex(/^[^\r\n]*$/, 'must not contain line breaks');

// Non-secret headers sent on every request, e.g. a scope or account id a
// vendor expects next to the key. Stored in plaintext, so Authorization is
// refused here: secrets belong in the credential store via `auth`.
const staticHeadersSchema = z
  .record(
    headerNameSchema.refine(name => name.toLowerCase() !== 'authorization', {
      message: 'put credentials in the auth block, not in static headers'
    }),
    headerValueSchema
  )
  .optional();

const authSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('bearer'),
      // credentialRef (profile id) pointing at the secret in the central
      // credential store. The actual token is resolved at connect time via
      // CredentialService; no secret material lives in mcpServers.json.
      tokenRef: z.string().min(1)
    }),
    z.object({
      type: z.literal('basic'),
      username: z.string().min(1),
      // credentialRef to the password secret in the central credential store.
      passwordRef: z.string().min(1)
    }),
    z.object({
      // API key sent in a vendor-specific header instead of Authorization
      // (e.g. Google's `X-Goog-Api-Key`).
      type: z.literal('header'),
      headerName: headerNameSchema,
      // Literal text placed before the secret, e.g. `Token token=`.
      valuePrefix: headerValueSchema.max(64).optional(),
      // credentialRef to the key in the central credential store.
      valueRef: z.string().min(1)
    }),
    z.object({
      type: z.literal('oauth'),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1),
      // credentialRef to the client secret in the central credential store.
      clientSecretRef: z.string().min(1),
      scope: z.string().optional()
    })
  ])
  .prefault({ type: 'none' });

const transportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('streamableHttp'),
    url: z.string().url(),
    headers: staticHeadersSchema
  }),
  // Legacy SSE retained for back-compat per the 2025-03-26 spec change.
  // streamableHttp is preferred.
  z.object({
    type: z.literal('sse'),
    url: z.string().url(),
    headers: staticHeadersSchema,
    deprecated: z.literal(true).optional()
  }),
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).prefault([]),
    env: z.record(z.string(), z.string()).prefault({}),
    cwd: z.string().optional()
  }),
  z.object({
    type: z.literal('websocket'),
    url: z.string().url()
  })
]);

export const mcpServerConfigSchema = z.object({
  id: idSchema,
  name: z.union([localizedStringSchema, z.string().min(1)]),
  description: z.union([localizedStringSchema, z.string()]).optional(),
  enabled: z.boolean().prefault(true),
  transport: transportSchema,
  auth: authSchema.optional(),
  // Tools surface with this prefix to keep multi-server names collision-free.
  // Defaults to `<id>__` so a server named "github" with tool "search_repos"
  // appears as "github__search_repos". An empty prefix also means the default.
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_]*$/, 'toolPrefix may only contain alphanumeric or underscore characters')
    .max(32)
    .optional(),
  // Allowlist patterns; "*" means all tools. Otherwise exact match.
  allowedTools: z.array(z.string()).prefault(['*']),
  // Hard timeout (ms) for `tools/call`; the client aborts past this.
  timeoutMs: z.number().int().min(1000).max(600000).prefault(30000),
  // MCP Apps (extension `io.modelcontextprotocol/ui`): when enabled, iHub
  // advertises the extension on connect and renders the interactive views the
  // server's tools declare (`_meta.ui.resourceUri`) inline in the chat. When
  // disabled the extension is not advertised, so a well-behaved server falls
  // back to text-only results.
  apps: z
    .object({
      enabled: z.boolean().prefault(true)
    })
    .prefault({}),
  // Auto-reconnect window. After `maxRetries` failures the connection is
  // marked unhealthy and excluded from `tools/list` aggregation.
  reconnect: z
    .object({
      enabled: z.boolean().prefault(true),
      maxRetries: z.number().int().min(0).max(20).prefault(5),
      initialDelayMs: z.number().int().min(100).max(60000).prefault(1000),
      maxDelayMs: z.number().int().min(1000).max(120000).prefault(30000),
      growthFactor: z.number().min(1).max(5).prefault(1.5)
    })
    .prefault({})
});

export const mcpServersFileSchema = z.object({
  servers: z.array(mcpServerConfigSchema).prefault([]),
  security: z
    .object({
      // Block private/internal IPs even if hostname resolves to one. Default
      // true; operators can allow specific hostnames via `allowedHosts` when
      // they intentionally point at an internal MCP server.
      blockPrivateIps: z.boolean().prefault(true),
      allowedHosts: z.array(z.string()).prefault([])
    })
    .prefault({})
});

export const mcpGatewayConfigSchema = z.object({
  enabled: z.boolean().prefault(false),
  // Public URL announced in well-known metadata. Falls back to request origin
  // when empty.
  publicUrl: z.string().url().optional().or(z.literal('')).prefault(''),
  requireConsent: z.boolean().prefault(true),
  defaultScopes: z.array(z.string()).prefault(['mcp:tools:read', 'mcp:tools:call']),
  transports: z
    .object({
      streamableHttp: z.object({ enabled: z.boolean().prefault(true) }).prefault({}),
      sse: z
        .object({ enabled: z.boolean().prefault(true), deprecated: z.boolean().prefault(true) })
        .prefault({})
    })
    .prefault({}),
  // Resource exposure flags. When false the corresponding adapter is skipped
  // even if the OAuth client has the scope.
  // Resource exposure is opt-in: sources/skills are only surfaced over MCP
  // when an admin explicitly enables it, even though per-caller filtering
  // (apps the caller can access) also applies.
  expose: z
    .object({
      tools: z.boolean().prefault(true),
      apps: z.boolean().prefault(true),
      workflows: z.boolean().prefault(true),
      resources: z.boolean().prefault(false)
    })
    .prefault({}),
  // Optional Agent-to-Agent (A2A) endpoint alongside /mcp. The wire
  // protocol is still moving; iHub mounts an auth-gated stub today.
  a2a: z
    .object({
      enabled: z.boolean().prefault(false)
    })
    .prefault({})
});

export default mcpServerConfigSchema;
