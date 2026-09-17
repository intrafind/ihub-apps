import { z } from 'zod';
import { cloudStorageConfigSchema } from './cloudStorageSchema.js';

const jwtProviderSchema = z.object({
  name: z.string(),
  header: z.string().prefault('Authorization'),
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
  // RP-Initiated Logout (https://openid.net/specs/openid-connect-rpinitiated-1_0.html).
  // Optional: when set, /api/auth/logout also ends the session at the provider
  // instead of only clearing iHub's own auth cookie. This is the provider's
  // `end_session_endpoint`; the field name matches the one already documented
  // in docs/ADFS-AUTHENTICATION-GUIDE.md.
  logoutURL: z.string().url().optional(),
  // Optional override for the `post_logout_redirect_uri` sent with the logout
  // request. Defaults to `<public base URL>/?logout=true`. Set this when the
  // provider matches post-logout URIs exactly and rejects the default (query
  // string, a hostname other than the request's, ...); it must be a URL the
  // client will accept, and iHub needs `?logout=true` on it to suppress
  // autoRedirect - see routes/auth.js.
  postLogoutRedirectURL: z.string().url().optional(),
  scope: z.array(z.string()).prefault(['openid', 'profile', 'email']),
  callbackURL: z.string().url().optional(),
  groupsAttribute: z.string().prefault('groups'),
  defaultGroups: z.array(z.string()).prefault([]),
  pkce: z.boolean().prefault(true),
  enabled: z.boolean().prefault(true),
  autoRedirect: z.boolean().optional()
});

const rateLimitConfigSchema = z.object({
  windowMs: z
    .number()
    .min(1000)
    .prefault(15 * 60 * 1000), // 15 minutes default
  limit: z.number().min(1).prefault(100), // 100 requests default
  message: z.string().optional(),
  standardHeaders: z.boolean().prefault(true),
  legacyHeaders: z.boolean().prefault(false),
  skipSuccessfulRequests: z.boolean().prefault(false),
  skipFailedRequests: z.boolean().prefault(false)
});

const ldapProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  url: z.string(),
  adminDn: z.string().optional(),
  adminPassword: z.string().optional(),
  userSearchBase: z.string(),
  usernameAttribute: z.string().prefault('uid'),
  userDn: z.string().optional(),
  groupSearchBase: z.string().optional(),
  groupClass: z.string().optional(),
  groupMemberAttribute: z.string().optional(),
  groupMemberUserAttribute: z.string().optional(),
  defaultGroups: z.array(z.string()).prefault([]),
  sessionTimeoutMinutes: z.number().min(1).prefault(480),
  tlsOptions: z.record(z.any()).optional()
});

const rateLimitSchema = z.object({
  default: rateLimitConfigSchema.prefault({}),
  adminApi: rateLimitConfigSchema.partial().prefault({}),
  publicApi: rateLimitConfigSchema.partial().prefault({}),
  authApi: rateLimitConfigSchema.partial().prefault({}),
  oauthApi: rateLimitConfigSchema.partial().prefault({}),
  inferenceApi: rateLimitConfigSchema.partial().prefault({})
});

// Accept either a boolean (true => mask) or a string mode ('off' | 'mask' |
// 'drop') so admins can be explicit about whether the IP should be truncated
// or omitted entirely.
const ipAnonymizationSchema = z
  .union([z.boolean(), z.enum(['off', 'mask', 'drop'])])
  .prefault(false);

const loggingSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).prefault('info'),
  format: z.enum(['json', 'text']).prefault('json'),
  file: z
    .object({
      enabled: z.boolean().prefault(false),
      path: z.string().prefault('logs/app.log'),
      maxSize: z.number().prefault(10485760), // 10MB
      maxFiles: z.number().prefault(5)
    })
    .prefault({}),
  // Optional per-component filtering (read by utils/logger.js). When enabled
  // with a non-empty filter list, only logs from the listed components are
  // emitted — except authentication components, which are always allowed
  // through while auth.debug is enabled so the auth-debug toggle keeps working.
  components: z
    .object({
      enabled: z.boolean().prefault(false),
      filter: z.array(z.string()).prefault([])
    })
    .prefault({}),
  anonymizeIp: ipAnonymizationSchema
});

const usageTrackingRetentionSchema = z
  .object({
    eventRetentionDays: z.number().prefault(90),
    dailyRetentionDays: z.number().prefault(365),
    monthlyRetentionDays: z.number().prefault(-1),
    feedbackRetentionDays: z.number().prefault(-1)
  })
  .passthrough();

/**
 * A proxy URL field. Accepts:
 *  - an absolute http(s) URL, optionally with basic-auth credentials
 *  - an `${ENV_VAR}` placeholder (resolved by configCache at load time)
 *  - an `ENC[...]` value (encrypted at rest, decrypted by getProxyConfig())
 *  - the empty string, meaning "not set"
 *
 * Anything else is rejected by name so an admin save fails loudly instead of
 * silently producing an unusable agent on every outbound request.
 */
const proxyUrlSchema = z
  .string()
  .prefault('')
  .refine(
    value => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      if (/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(trimmed)) return true;
      if (trimmed.startsWith('ENC[') && trimmed.endsWith(']')) return true;
      try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    {
      message:
        'must be an absolute http(s) URL (e.g. http://proxy.example.com:8080), an ${ENV_VAR} placeholder, or empty'
    }
  );

/**
 * Outbound HTTP(S) proxy for everything iHub calls out to: LLM providers, web
 * search, Jira, OIDC and MCP servers. Unrelated to `proxyAuth` (inbound
 * header-based login) and `trustProxy` (inbound hop count).
 */
export const proxyConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .prefault(true)
      .describe(
        'Master switch. When false no request is proxied, whatever http/https hold. Absent means enabled, so HTTP_PROXY/HTTPS_PROXY from the environment still apply.'
      ),
    http: proxyUrlSchema.describe('Proxy URL used for http:// targets'),
    https: proxyUrlSchema.describe('Proxy URL used for https:// targets'),
    noProxy: z
      .union([z.string(), z.array(z.string())])
      .prefault('')
      .describe(
        'Hosts that bypass the proxy. Comma-separated string ("localhost,.local") or array (["localhost", ".local"]). Entries: exact hostname, .example.com or *.example.com for subdomains. CIDR ranges, host:port and the catch-all "*" are not supported.'
      ),
    urlPatterns: z
      .array(z.string())
      .prefault([])
      .superRefine((patterns, ctx) => {
        patterns.forEach((pattern, index) => {
          try {
            new RegExp(pattern);
          } catch (error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index],
              message: `"${pattern}" is not a valid regular expression: ${error.message}`
            });
          }
        });
      })
      .describe(
        'Optional regex allowlist. When non-empty only URLs matching at least one pattern are proxied; everything else goes direct.'
      )
  })
  .passthrough();

export const platformConfigSchema = z
  .object({
    auth: z
      .object({
        mode: z.enum(['proxy', 'local', 'oidc', 'ldap', 'ntlm', 'anonymous']).prefault('local'),
        authenticatedGroup: z.string().prefault('authenticated'),
        debug: z
          .object({
            enabled: z.boolean().prefault(false),
            maskTokens: z.boolean().prefault(true),
            redactPasswords: z.boolean().prefault(true),
            includeRawData: z.boolean().prefault(false),
            providers: z
              .object({
                oidc: z.object({ enabled: z.boolean().prefault(true) }).prefault({}),
                local: z.object({ enabled: z.boolean().prefault(true) }).prefault({}),
                proxy: z.object({ enabled: z.boolean().prefault(true) }).prefault({}),
                ldap: z.object({ enabled: z.boolean().prefault(true) }).prefault({}),
                ntlm: z.object({ enabled: z.boolean().prefault(true) }).prefault({})
              })
              .prefault({})
          })
          .prefault({})
      })
      .prefault({}),
    anonymousAuth: z
      .object({
        enabled: z.boolean().prefault(true),
        defaultGroups: z.array(z.string()).prefault(['anonymous'])
      })
      .prefault({}),
    proxyAuth: z
      .object({
        enabled: z.boolean().prefault(false),
        allowSelfSignup: z.boolean().prefault(false),
        userHeader: z.string().prefault('X-Forwarded-User'),
        groupsHeader: z.string().prefault('X-Forwarded-Groups'),
        jwtProviders: z.array(jwtProviderSchema).prefault([])
      })
      .prefault({}),
    localAuth: z
      .object({
        enabled: z.boolean().prefault(false),
        usersFile: z.string().prefault('contents/config/users.json'),
        sessionTimeoutMinutes: z.number().min(1).prefault(480),
        showDemoAccounts: z.boolean().prefault(true)
      })
      .prefault({}),
    oidcAuth: z
      .object({
        enabled: z.boolean().prefault(false),
        allowSelfSignup: z.boolean().prefault(false),
        providers: z.array(oidcProviderSchema).prefault([])
      })
      .prefault({}),
    ldapAuth: z
      .object({
        enabled: z.boolean().prefault(false),
        allowSelfSignup: z.boolean().prefault(true),
        providers: z.array(ldapProviderSchema).prefault([])
      })
      .prefault({}),
    ntlmAuth: z
      .object({
        enabled: z.boolean().prefault(false),
        domain: z.string().optional(),
        domainController: z.string().optional(),
        type: z.enum(['ntlm', 'negotiate']).prefault('ntlm'),
        debug: z.boolean().prefault(false),
        getUserInfo: z.boolean().prefault(true),
        getGroups: z.boolean().prefault(true),
        ldapGroupLookupProvider: z.string().optional(),
        defaultGroups: z.array(z.string()).prefault([]),
        sessionTimeoutMinutes: z.number().min(1).prefault(480),
        generateJwtToken: z.boolean().prefault(true),
        tlsOptions: z.record(z.any()).optional(),
        options: z.record(z.any()).optional()
      })
      .prefault({}),
    rateLimit: rateLimitSchema.prefault({}),
    trustProxy: z
      .union([z.number().int().min(0), z.boolean(), z.string()])
      .prefault(1)
      .describe(
        'Express "trust proxy" setting: the number of proxy hops in front of iHub, true/false, or a comma-separated list of trusted addresses/subnets. Decides what req.ip resolves to, which is the rate-limit key and the audited client address. Set it to the real hop count — too low and every caller behind the inner proxy shares one identity (and therefore one rate-limit counter).'
      ),
    logging: loggingSchema.prefault({}),
    ssl: z
      .object({
        ignoreInvalidCertificates: z.boolean().prefault(false),
        domainWhitelist: z
          .array(z.string())
          .prefault([])
          .describe(
            'List of domains/patterns for which SSL certificate validation should be ignored. Supports wildcards (*.example.com) and exact domains (api.example.com)'
          )
      })
      .prefault({}),
    ssrf: z
      .object({
        allowedHosts: z
          .array(z.string())
          .prefault([])
          .describe(
            'Hostnames or patterns that bypass the SSRF private-IP guard for outbound HTTP calls (OpenAPI tools, MCP servers, web tools). Use this to reach intentionally internal services. Supports wildcards (*.example.com), exact domains (api.example.com), and subdomain (.example.com) patterns.'
          )
      })
      .prefault({}),
    proxy: proxyConfigSchema.prefault({}),
    cloudStorage: cloudStorageConfigSchema.prefault({}),
    // Single source of truth for audit logging: retention + behavior + privacy.
    // (The legacy top-level `auditLog` block is migrated into here by V059.)
    audit: z
      .object({
        retentionDays: z.number().prefault(365),
        cleanupEnabled: z.boolean().prefault(true),
        includeEmail: z.boolean().prefault(false),
        verbosity: z.enum(['metadata', 'request', 'full']).prefault('metadata'),
        winstonMirror: z.boolean().prefault(false),
        anonymizeIp: ipAnonymizationSchema
      })
      .passthrough()
      .prefault({}),
    usageTracking: usageTrackingRetentionSchema.prefault({}),
    // Transport ceilings for provider calls, in milliseconds (see
    // services/loop/LLMClient.js). Both fall back to the env vars
    // LLM_CONNECT_TIMEOUT_MS / LLM_STREAM_IDLE_TIMEOUT_MS when unset, and a
    // single model can override either one in its own config. 0 disables a
    // ceiling and leaves the call to the whole-call deadline
    // (REQUEST_TIMEOUT, 5 minutes by default).
    llm: z
      .object({
        // Ceiling for the phase before the provider's first response byte,
        // per attempt. Every provider call streams, so those headers arrive
        // as soon as the request is accepted and the phase measures reach
        // rather than generation.
        connectTimeoutMs: z.number().int().min(0).optional(),
        // Ceiling for the gap between two chunks of a stream that has already
        // produced one.
        streamIdleTimeoutMs: z.number().int().min(0).optional()
      })
      .passthrough()
      .prefault({}),
    // Unified runtime ledger (RunLog): one append-only JSONL per run. The
    // feature itself is gated by features.runLog; these are its settings.
    runLog: z
      .object({
        enabled: z.boolean().prefault(true),
        identityMode: z.enum(['full', 'default', 'pseudonymized']).prefault('default'),
        retentionDays: z.number().prefault(90),
        cleanupEnabled: z.boolean().prefault(true),
        flushIntervalMs: z.number().int().positive().prefault(2000),
        spillThresholdBytes: z.number().int().positive().prefault(65536)
      })
      .passthrough()
      .prefault({}),
    // Durable chats: server-side chat history written through the storage
    // abstraction. The feature itself is gated by features.chatPersistence;
    // these are its settings. Both retention rules are switched off by a value
    // of zero or less — chats are then kept until an owner deletes them.
    chats: z
      .object({
        enabled: z.boolean().prefault(true),
        retentionDays: z.number().prefault(90),
        maxChatsPerUser: z.number().prefault(200),
        maxMessagesPerChat: z.number().prefault(2000)
      })
      .passthrough()
      .prefault({}),
    // Artifacts: what a run produced that is worth keeping in its own right —
    // a chat turn's generated image today, a workflow's report or an agent's
    // output next. One store for every producer, so this block is not under
    // `chats`. Artifacts are the one thing a run produces that is measured in
    // megabytes, so an admin can switch them off without giving up stored
    // transcripts, and the two caps (bytes per artifact, artifacts one
    // producer records in one go) bound what a single step can write. Zero or
    // less removes a cap, like the retention rules above.
    artifacts: z
      .object({
        enabled: z.boolean().prefault(true),
        maxBytes: z.number().prefault(10485760),
        maxPerBatch: z.number().prefault(8)
      })
      .passthrough()
      .prefault({}),
    // Workflow execution state: the checkpoint a paused run resumes from and
    // the record a finished one leaves behind. Nothing deleted these on a
    // timer before, so a busy installation accumulated every state it ever
    // wrote. Only terminal executions are swept; `retentionDays` of zero or
    // less keeps them forever, and `cleanupEnabled: false` stops the sweep
    // without changing the window.
    workflowState: z
      .object({
        retentionDays: z.number().prefault(30),
        cleanupEnabled: z.boolean().prefault(true)
      })
      .passthrough()
      .prefault({}),
    // Storage abstraction: which provider backs runtime data (documents,
    // append-logs, locks, change events). Durable chats are its first consumer
    // — `server/storage/bootstrap.js` brings this provider up at boot and the
    // chat repository writes through it. `provider` is a free string rather than an
    // enum so an install can be pre-configured for a provider a later release
    // registers, without failing platform validation on the older one.
    storage: z
      .object({
        provider: z
          .string()
          .prefault('filesystem')
          .describe(
            'Storage provider backing runtime data. Only "filesystem" ships today; override per environment with IHUB_STORAGE_PROVIDER. Changing it requires a restart.'
          ),
        filesystem: z
          .object({
            dataDir: z
              .string()
              .prefault('data')
              .describe('Directory under contents/ holding storage data.'),
            flushIntervalMs: z
              .number()
              .int()
              .positive()
              .prefault(2000)
              .describe('Debounce for buffered append-log writes.')
          })
          .passthrough()
          .prefault({})
      })
      .passthrough()
      .prefault({}),
    // Realtime speech-to-text: the browser streams mic audio to iHub over a
    // WebSocket and iHub proxies it to a vLLM realtime endpoint (e.g. Voxtral
    // on /v1/realtime). The url/apiKey stay server-side. Apps opt in with
    // settings.speechRecognition.service = 'vllm-realtime'.
    speech: z
      .object({
        realtime: z
          .object({
            enabled: z.boolean().prefault(false),
            url: z.string().prefault(''),
            model: z.string().prefault(''),
            // Optional. Supports plaintext, ${ENV_VAR} placeholders, and
            // ENC[...] encrypted values (decrypted by configCache on load).
            apiKey: z.string().prefault(''),
            // Resource guards for the WS proxy (each session pins a GPU-backed
            // upstream socket). Optional; sane defaults applied in code.
            maxConnections: z.number().int().positive().optional(),
            maxConnectionsPerUser: z.number().int().positive().optional(),
            maxFrameBytes: z.number().int().positive().optional()
          })
          .passthrough()
          .prefault({}),
        // Azure Speech runs in the browser via the Speech SDK, but the
        // subscription KEY is a server-side secret: the server exchanges it for
        // a short-lived authorization token (see /api/voice/azure/token) so the
        // key never reaches the browser. host/region are the platform-level
        // defaults the client uses when an app sets no host of its own.
        azure: z
          .object({
            enabled: z.boolean().prefault(false),
            host: z.string().prefault(''),
            region: z.string().prefault(''),
            // Server-side secret. Supports plaintext, ${ENV_VAR} placeholders,
            // and ENC[...] encrypted values (decrypted by configCache on load).
            subscriptionKey: z.string().prefault('')
          })
          .passthrough()
          .prefault({})
      })
      .passthrough()
      .prefault({})
  })
  .passthrough();

export const knownPlatformKeys = Object.keys(platformConfigSchema.shape);
