import { z } from 'zod';
import { cloudStorageConfigSchema } from './cloudStorageSchema.js';

const jwtProviderSchema = z.object({
  name: z.string(),
  header: z.string().default('Authorization'),
  issuer: z.string().url(),
  audience: z.string(),
  jwkUrl: z.string().url()
});

const oidcProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  authorizationURL: z.string().url(),
  tokenURL: z.string().url(),
  userInfoURL: z.string().url(),
  scope: z.array(z.string()).default(['openid', 'profile', 'email']),
  callbackURL: z.string().url().optional(),
  groupsAttribute: z.string().default('groups'),
  defaultGroups: z.array(z.string()).default([]),
  pkce: z.boolean().default(true),
  enabled: z.boolean().default(true),
  autoRedirect: z.boolean().optional()
});

const rateLimitConfigSchema = z.object({
  windowMs: z
    .number()
    .min(1000)
    .default(15 * 60 * 1000), // 15 minutes default
  limit: z.number().min(1).default(100), // 100 requests default
  message: z.string().optional(),
  standardHeaders: z.boolean().default(true),
  legacyHeaders: z.boolean().default(false),
  skipSuccessfulRequests: z.boolean().default(false),
  skipFailedRequests: z.boolean().default(false)
});

const ldapProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  url: z.string(),
  adminDn: z.string().optional(),
  adminPassword: z.string().optional(),
  userSearchBase: z.string(),
  usernameAttribute: z.string().default('uid'),
  userDn: z.string().optional(),
  groupSearchBase: z.string().optional(),
  groupClass: z.string().optional(),
  groupMemberAttribute: z.string().optional(),
  groupMemberUserAttribute: z.string().optional(),
  defaultGroups: z.array(z.string()).default([]),
  sessionTimeoutMinutes: z.number().min(1).default(480),
  tlsOptions: z.record(z.any()).optional()
});

const rateLimitSchema = z.object({
  default: rateLimitConfigSchema.default({}),
  adminApi: rateLimitConfigSchema.partial().default({}),
  publicApi: rateLimitConfigSchema.partial().default({}),
  authApi: rateLimitConfigSchema.partial().default({}),
  oauthApi: rateLimitConfigSchema.partial().default({}),
  inferenceApi: rateLimitConfigSchema.partial().default({})
});

// Accept either a boolean (true => mask) or a string mode ('off' | 'mask' |
// 'drop') so admins can be explicit about whether the IP should be truncated
// or omitted entirely.
const ipAnonymizationSchema = z
  .union([z.boolean(), z.enum(['off', 'mask', 'drop'])])
  .default(false);

const loggingSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  format: z.enum(['json', 'text']).default('json'),
  file: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().default('logs/app.log'),
      maxSize: z.number().default(10485760), // 10MB
      maxFiles: z.number().default(5)
    })
    .default({}),
  anonymizeIp: ipAnonymizationSchema
});

const usageTrackingRetentionSchema = z
  .object({
    eventRetentionDays: z.number().default(90),
    dailyRetentionDays: z.number().default(365),
    monthlyRetentionDays: z.number().default(-1),
    feedbackRetentionDays: z.number().default(-1)
  })
  .passthrough();

export const platformConfigSchema = z
  .object({
    auth: z
      .object({
        mode: z.enum(['proxy', 'local', 'oidc', 'ldap', 'ntlm', 'anonymous']).default('local'),
        authenticatedGroup: z.string().default('authenticated'),
        debug: z
          .object({
            enabled: z.boolean().default(false),
            maskTokens: z.boolean().default(true),
            redactPasswords: z.boolean().default(true),
            includeRawData: z.boolean().default(false),
            providers: z
              .object({
                oidc: z.object({ enabled: z.boolean().default(true) }).default({}),
                local: z.object({ enabled: z.boolean().default(true) }).default({}),
                proxy: z.object({ enabled: z.boolean().default(true) }).default({}),
                ldap: z.object({ enabled: z.boolean().default(true) }).default({}),
                ntlm: z.object({ enabled: z.boolean().default(true) }).default({})
              })
              .default({})
          })
          .default({})
      })
      .default({}),
    anonymousAuth: z
      .object({
        enabled: z.boolean().default(true),
        defaultGroups: z.array(z.string()).default(['anonymous'])
      })
      .default({}),
    proxyAuth: z
      .object({
        enabled: z.boolean().default(false),
        allowSelfSignup: z.boolean().default(false),
        userHeader: z.string().default('X-Forwarded-User'),
        groupsHeader: z.string().default('X-Forwarded-Groups'),
        jwtProviders: z.array(jwtProviderSchema).default([])
      })
      .default({}),
    localAuth: z
      .object({
        enabled: z.boolean().default(false),
        usersFile: z.string().default('contents/config/users.json'),
        sessionTimeoutMinutes: z.number().min(1).default(480),
        showDemoAccounts: z.boolean().default(false)
      })
      .default({}),
    oidcAuth: z
      .object({
        enabled: z.boolean().default(false),
        allowSelfSignup: z.boolean().default(false),
        providers: z.array(oidcProviderSchema).default([])
      })
      .default({}),
    ldapAuth: z
      .object({
        enabled: z.boolean().default(false),
        allowSelfSignup: z.boolean().default(true),
        providers: z.array(ldapProviderSchema).default([])
      })
      .default({}),
    ntlmAuth: z
      .object({
        enabled: z.boolean().default(false),
        domain: z.string().optional(),
        domainController: z.string().optional(),
        type: z.enum(['ntlm', 'negotiate']).default('ntlm'),
        debug: z.boolean().default(false),
        getUserInfo: z.boolean().default(true),
        getGroups: z.boolean().default(true),
        ldapGroupLookupProvider: z.string().optional(),
        defaultGroups: z.array(z.string()).default([]),
        sessionTimeoutMinutes: z.number().min(1).default(480),
        generateJwtToken: z.boolean().default(true),
        tlsOptions: z.record(z.any()).optional(),
        options: z.record(z.any()).optional()
      })
      .default({}),
    rateLimit: rateLimitSchema.default({}),
    logging: loggingSchema.default({}),
    ssl: z
      .object({
        ignoreInvalidCertificates: z.boolean().default(false),
        domainWhitelist: z
          .array(z.string())
          .default([])
          .describe(
            'List of domains/patterns for which SSL certificate validation should be ignored. Supports wildcards (*.example.com) and exact domains (api.example.com)'
          )
      })
      .default({}),
    ssrf: z
      .object({
        allowedHosts: z
          .array(z.string())
          .default([])
          .describe(
            'Hostnames or patterns that bypass the SSRF private-IP guard for outbound HTTP calls (OpenAPI tools, MCP servers, web tools). Use this to reach intentionally internal services. Supports wildcards (*.example.com), exact domains (api.example.com), and subdomain (.example.com) patterns.'
          )
      })
      .default({}),
    cloudStorage: cloudStorageConfigSchema.default({}),
    // Single source of truth for audit logging: retention + behavior + privacy.
    // (The legacy top-level `auditLog` block is migrated into here by V059.)
    audit: z
      .object({
        retentionDays: z.number().default(365),
        cleanupEnabled: z.boolean().default(true),
        includeEmail: z.boolean().default(false),
        verbosity: z.enum(['metadata', 'request', 'full']).default('metadata'),
        winstonMirror: z.boolean().default(false),
        anonymizeIp: ipAnonymizationSchema
      })
      .passthrough()
      .default({}),
    usageTracking: usageTrackingRetentionSchema.default({}),
    // Realtime speech-to-text: the browser streams mic audio to iHub over a
    // WebSocket and iHub proxies it to a vLLM realtime endpoint (e.g. Voxtral
    // on /v1/realtime). The url/apiKey stay server-side. Apps opt in with
    // settings.speechRecognition.service = 'vllm-realtime'.
    speech: z
      .object({
        realtime: z
          .object({
            enabled: z.boolean().default(false),
            url: z.string().default(''),
            model: z.string().default(''),
            // Optional. Supports plaintext, ${ENV_VAR} placeholders, and
            // ENC[...] encrypted values (decrypted by configCache on load).
            apiKey: z.string().default(''),
            // Resource guards for the WS proxy (each session pins a GPU-backed
            // upstream socket). Optional; sane defaults applied in code.
            maxConnections: z.number().int().positive().optional(),
            maxConnectionsPerUser: z.number().int().positive().optional(),
            maxFrameBytes: z.number().int().positive().optional()
          })
          .passthrough()
          .default({}),
        // Azure Speech runs in the browser via the Speech SDK, but the
        // subscription KEY is a server-side secret: the server exchanges it for
        // a short-lived authorization token (see /api/voice/azure/token) so the
        // key never reaches the browser. host/region are the platform-level
        // defaults the client uses when an app sets no host of its own.
        azure: z
          .object({
            enabled: z.boolean().default(false),
            host: z.string().default(''),
            region: z.string().default(''),
            // Server-side secret. Supports plaintext, ${ENV_VAR} placeholders,
            // and ENC[...] encrypted values (decrypted by configCache on load).
            subscriptionKey: z.string().default('')
          })
          .passthrough()
          .default({})
      })
      .passthrough()
      .default({})
  })
  .passthrough();

export const knownPlatformKeys = Object.keys(platformConfigSchema.shape);
