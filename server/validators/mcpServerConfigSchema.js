import { z } from 'zod';

const localizedStringSchema = z.record(
  z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format'),
  z.string().min(1)
);

const idSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'Server ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  )
  .min(1)
  .max(64);

const authSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('bearer'),
      // Plaintext value (`secret`), env-var placeholder (`${VAR}`), or
      // ENC[...] ciphertext. configCache decrypts encrypted values at load
      // time so consumers always see plaintext.
      token: z.string().min(1)
    }),
    z.object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: z.string().min(1)
    }),
    z.object({
      type: z.literal('oauth'),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      scope: z.string().optional()
    })
  ])
  .default({ type: 'none' });

const transportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('streamableHttp'),
    url: z.string().url()
  }),
  // Legacy SSE retained for back-compat per the 2025-03-26 spec change.
  // streamableHttp is preferred.
  z.object({
    type: z.literal('sse'),
    url: z.string().url(),
    deprecated: z.literal(true).optional()
  }),
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
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
  enabled: z.boolean().default(true),
  transport: transportSchema,
  auth: authSchema.optional(),
  // Tools surface with this prefix to keep multi-server names collision-free.
  // Defaults to `<id>__` so a server named "github" with tool "search_repos"
  // appears as "github__search_repos".
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_]*$/, 'toolPrefix may only contain alphanumeric or underscore characters')
    .max(32)
    .optional(),
  // Allowlist patterns; "*" means all tools. Otherwise exact match.
  allowedTools: z.array(z.string()).default(['*']),
  // Hard timeout (ms) for `tools/call`; the client aborts past this.
  timeoutMs: z.number().int().min(1000).max(600000).default(30000),
  // Auto-reconnect window. After `maxRetries` failures the connection is
  // marked unhealthy and excluded from `tools/list` aggregation.
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      maxRetries: z.number().int().min(0).max(20).default(5),
      initialDelayMs: z.number().int().min(100).max(60000).default(1000),
      maxDelayMs: z.number().int().min(1000).max(120000).default(30000),
      growthFactor: z.number().min(1).max(5).default(1.5)
    })
    .default({})
});

export const mcpServersFileSchema = z.object({
  servers: z.array(mcpServerConfigSchema).default([]),
  security: z
    .object({
      // Block private/internal IPs even if hostname resolves to one. Default
      // true; operators can allow specific hostnames via `allowedHosts` when
      // they intentionally point at an internal MCP server.
      blockPrivateIps: z.boolean().default(true),
      allowedHosts: z.array(z.string()).default([])
    })
    .default({})
});

export const mcpGatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Public URL announced in well-known metadata. Falls back to request origin
  // when empty.
  publicUrl: z.string().url().optional().or(z.literal('')).default(''),
  requireConsent: z.boolean().default(true),
  defaultScopes: z.array(z.string()).default(['mcp:tools:read', 'mcp:tools:call']),
  transports: z
    .object({
      streamableHttp: z.object({ enabled: z.boolean().default(true) }).default({}),
      sse: z
        .object({ enabled: z.boolean().default(true), deprecated: z.boolean().default(true) })
        .default({})
    })
    .default({}),
  // Resource exposure flags. When false the corresponding adapter is skipped
  // even if the OAuth client has the scope.
  expose: z
    .object({
      tools: z.boolean().default(true),
      apps: z.boolean().default(true),
      workflows: z.boolean().default(true),
      resources: z.boolean().default(true)
    })
    .default({}),
  // Optional Agent-to-Agent (A2A) endpoint alongside /mcp. The wire
  // protocol is still moving; iHub mounts an auth-gated stub today.
  a2a: z
    .object({
      enabled: z.boolean().default(false)
    })
    .default({})
});

export default mcpServerConfigSchema;
