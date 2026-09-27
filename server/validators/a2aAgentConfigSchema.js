import { z } from 'zod';
import { zSafeId } from './common.js';

/**
 * Schema for `contents/config/a2aAgents.json` — the remote A2A agents iHub
 * connects to as a client. Every skill an agent lists on its Agent Card becomes
 * an iHub tool `a2a__<agentId>__<skillSlug>` (see services/a2a/a2aTools.js).
 *
 * Mirrors `mcpServerConfigSchema.js`: secrets are never stored here, only
 * `*Ref` pointers into the central credential store.
 */

const localizedStringSchema = z.record(
  z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format'),
  z.string().min(1)
);

/**
 * Tool ids are `a2a__<agentId>__<skillSlug>` and must fit the 64 characters a
 * model provider allows for a function name. Capping the agent id keeps room
 * for a meaningful skill slug (at least nine characters).
 */
export const MAX_AGENT_ID_LENGTH = 48;

const idSchema = zSafeId.min(1).max(MAX_AGENT_ID_LENGTH);

/** Header an `apiKey` auth block uses when neither it nor the card names one. */
export const A2A_DEFAULT_API_KEY_HEADER = 'X-API-Key';

// RFC 9110 field-name token.
const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(HTTP_HEADER_NAME, 'header name must be a valid HTTP header name')
  .refine(name => name.toLowerCase() !== 'authorization', {
    message: 'use the bearer or oauth auth type for the Authorization header'
  });

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Agent Card URL. A2A agents are reached over HTTPS; plain HTTP is
 * accepted for a loopback host only (a locally running agent during
 * development). The SSRF policy in `security` still applies at request time.
 */
const cardUrlSchema = z
  .string()
  .url()
  .refine(
    value => {
      let url;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    },
    { message: 'cardUrl must be an https URL (http is allowed for localhost only)' }
  );

/**
 * How iHub authenticates against the agent. Left open for a later `oauthUser`
 * type (per-user sign-in); today every user shares the configured credential.
 */
const authSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      // API key in a request header. When `headerName` is left out, the name
      // comes from the card's `apiKey` security scheme, else `X-API-Key`.
      type: z.literal('apiKey'),
      headerName: headerNameSchema.optional(),
      // credentialRef to the key in the central credential store.
      valueRef: z.string().min(1)
    }),
    z.object({
      type: z.literal('bearer'),
      // credentialRef to the token in the central credential store.
      tokenRef: z.string().min(1)
    }),
    z.object({
      // OAuth 2.0 client credentials; the token is cached until it expires.
      type: z.literal('oauth'),
      tokenUrl: z.string().url(),
      clientId: z.string().min(1),
      // credentialRef to the client secret in the central credential store.
      clientSecretRef: z.string().min(1),
      scope: z.string().optional()
    })
  ])
  .prefault({ type: 'none' });

export const a2aAgentConfigSchema = z.object({
  id: idSchema,
  name: z.union([localizedStringSchema, z.string().min(1)]),
  description: z.union([localizedStringSchema, z.string()]).optional(),
  enabled: z.boolean().prefault(true),
  // Full URL of the Agent Card, usually `<agent>/.well-known/agent-card.json`.
  cardUrl: cardUrlSchema,
  auth: authSchema,
  // Skill ids (as the card names them) offered as tools; "*" means all.
  allowedSkills: z.array(z.string()).prefault(['*']),
  // Whole-call budget (ms): request, streaming and polling included. Past it
  // the task is cancelled (best effort) and the tool call fails.
  timeoutMs: z.number().int().min(1000).max(600000).prefault(60000),
  // `auto` uses `message/stream` when the card declares streaming support,
  // `never` always uses blocking `message/send` plus `tasks/get` polling.
  streaming: z.enum(['auto', 'never']).prefault('auto'),
  // How often `tasks/get` is polled while a task is still running.
  pollIntervalMs: z.number().int().min(250).max(60000).prefault(1500)
});

export const a2aAgentsFileSchema = z.object({
  agents: z.array(a2aAgentConfigSchema).prefault([]),
  security: z
    .object({
      // Block private/internal IPs even if the hostname resolves to one.
      // Operators allow specific hostnames via `allowedHosts` when they
      // intentionally point at an internal agent.
      blockPrivateIps: z.boolean().prefault(true),
      allowedHosts: z.array(z.string()).prefault([])
    })
    .prefault({})
});

export default a2aAgentConfigSchema;
