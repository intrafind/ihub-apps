export const version = '110';
export const description = 'add_proxy_defaults';

/**
 * Migration V110 — seed the outbound proxy block in platform.json
 *
 * The `proxy` block (iHub's own egress proxy for LLM providers, web search,
 * Jira, OIDC and MCP servers) is now a first-class admin setting alongside SSL
 * and the SSRF allowlist. Installs that never hand-edited platform.json have no
 * `proxy` key at all, so the admin UI would open on an empty block with nothing
 * to indicate the setting exists. Seeding the defaults makes it discoverable and
 * gives the schema something to validate.
 *
 * `enabled` is seeded as `true`, not `false`: `getProxyConfig()` has always
 * treated an absent flag as enabled, so installs that configure the proxy purely
 * through HTTP_PROXY/HTTPS_PROXY in the environment would silently lose their
 * egress route if this wrote `false`. With no URLs configured, `true` changes
 * nothing.
 */

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'proxy.enabled', true);
  ctx.setDefault(platform, 'proxy.http', '');
  ctx.setDefault(platform, 'proxy.https', '');
  ctx.setDefault(platform, 'proxy.noProxy', '');
  ctx.setDefault(platform, 'proxy.urlPatterns', []);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added proxy defaults to platform.json');
}
