export const version = '082';
export const description = 'add_trust_proxy';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Seed `trustProxy` so the number of proxy hops in front of iHub becomes an
 * explicit, admin-visible setting instead of a hard-coded `1`.
 *
 * `req.ip` is derived from this value, and `req.ip` is the rate-limit key. With
 * `1` and two hops (e.g. ingress + internal load balancer) `req.ip` resolves to
 * the inner proxy for every caller, so all users share a single rate-limit
 * counter — one busy client can then exhaust the auth/OAuth window for the
 * whole deployment.
 *
 * Default stays `1` so behaviour is unchanged; deployments with more hops
 * should raise it to the real count.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'trustProxy', 1);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added trustProxy default (1 proxy hop)');
}
