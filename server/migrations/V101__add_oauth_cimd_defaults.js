/**
 * Migration V101 — Add Client ID Metadata Document (CIMD) defaults
 *
 * A CIMD client identifies itself with an HTTPS URL that points at a metadata
 * document it hosts, instead of registering a client record here. It is what
 * stops Claude calling `/api/oauth/register` on every fresh connection — but
 * it also means an arbitrary, caller-supplied URL reaches the authorize
 * endpoint, so the feature ships **off** and with a host allowlist.
 *
 * `enabled: false` keeps upgrade behaviour identical; the MCP gateway page
 * recommends turning it on. `allowedClientHosts: ["claude.ai"]` means that
 * switching it on later trusts Claude and nothing else, rather than silently
 * trusting every HTTPS host on the internet.
 *
 * Installations that already define `oauth.cimd` are left alone, and each key
 * is filled in individually so an operator who set only `enabled` keeps it.
 */

export const version = '101';
export const description = 'Add OAuth Client ID Metadata Document (CIMD) defaults';

const CIMD_DEFAULTS = {
  enabled: false,
  allowedClientHosts: ['claude.ai'],
  allowedGroups: [],
  allowedScopes: [],
  allowedApps: [],
  allowedModels: [],
  allowedPrompts: [],
  cacheMaxSeconds: 86400,
  fetchTimeoutMs: 5000
};

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');

  if (!config.oauth || typeof config.oauth !== 'object') {
    ctx.warn('platform.json has no oauth section — skipping');
    return;
  }

  if (!config.oauth.cimd || typeof config.oauth.cimd !== 'object') {
    config.oauth.cimd = {};
  }

  const added = [];
  for (const [key, value] of Object.entries(CIMD_DEFAULTS)) {
    if (config.oauth.cimd[key] === undefined) {
      config.oauth.cimd[key] = Array.isArray(value) ? [...value] : value;
      added.push(key);
    }
  }

  // `tokenExpirationMinutes` is intentionally absent: unset means "fall back to
  // oauth.defaultTokenExpirationMinutes", and writing a literal here would
  // freeze CIMD tokens at today's value if that default ever changes.

  if (added.length === 0) {
    ctx.log('oauth.cimd already fully configured — no changes needed');
    return;
  }

  await ctx.writeJson('config/platform.json', config);
  ctx.log(`Added oauth.cimd defaults: ${added.join(', ')}`);
}
