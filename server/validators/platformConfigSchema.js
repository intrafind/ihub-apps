import { z } from 'zod';

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
  defaultGroups: z.array(z.string()).default([]),
  sessionTimeoutMinutes: z.number().min(1).default(480),
  tlsOptions: z.record(z.any()).optional()
});

const rateLimitSchema = z.object({
  default: rateLimitConfigSchema.default({}),
  adminApi: rateLimitConfigSchema.partial().default({}),
  publicApi: rateLimitConfigSchema.partial().default({}),
  authApi: rateLimitConfigSchema.partial().default({}),
  inferenceApi: rateLimitConfigSchema.partial().default({})
});

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
    .default({})
});

export const platformConfigSchema = z
  .object({
    auth: z
      .object({
        mode: z.enum(['proxy', 'local', 'oidc', 'ldap', 'ntlm', 'anonymous']).default('proxy'),
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
        jwtSecret: z.string().default('${JWT_SECRET}'),
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
        defaultGroups: z.array(z.string()).default([]),
        sessionTimeoutMinutes: z.number().min(1).default(480),
        generateJwtToken: z.boolean().default(true),
        options: z.record(z.any()).optional()
      })
      .default({}),
    rateLimit: rateLimitSchema.default({}),
    logging: loggingSchema.default({})
  })
  .passthrough();

export const knownPlatformKeys = Object.keys(platformConfigSchema.shape);
