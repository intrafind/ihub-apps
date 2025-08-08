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

const authDebugSchema = z.object({
  enabled: z.boolean().default(false),
  maskTokens: z.boolean().default(true),
  redactPasswords: z.boolean().default(true),
  consoleLogging: z.boolean().default(false),
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
});

export const platformConfigSchema = z
  .object({
    auth: z
      .object({
        mode: z.enum(['proxy', 'local', 'oidc', 'anonymous']).default('proxy'),
        authenticatedGroup: z.string().default('authenticated')
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
    authDebug: authDebugSchema.default({})
  })
  .passthrough();

export const knownPlatformKeys = Object.keys(platformConfigSchema.shape);
