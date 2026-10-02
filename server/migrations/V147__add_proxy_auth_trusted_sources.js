// server/migrations/V147__add_proxy_auth_trusted_sources.js
export const version = '147';
export const description = 'add_proxy_auth_trusted_sources';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Proxy auth now uses its identity headers only from trusted proxies
 * (`proxyAuth.trustedProxies`) and/or with a shared secret
 * (utils/proxyAuthTrust.js). Where proxy auth is already on — in platform.json
 * or through PROXY_AUTH_ENABLED / IHUB_PLATFORM__PROXY_AUTH__ENABLED — trust
 * the local host, so a proxy on the same
 * machine keeps working; proxies elsewhere have to be added. Elsewhere the
 * list starts empty. A list an admin already set is kept.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const envOn = name => String(process.env[name] ?? '').toLowerCase() === 'true';
  const proxyAuthOn =
    platform.proxyAuth?.enabled === true ||
    envOn('PROXY_AUTH_ENABLED') ||
    envOn('IHUB_PLATFORM__PROXY_AUTH__ENABLED');
  ctx.setDefault(platform, 'proxyAuth.trustedProxies', proxyAuthOn ? ['loopback'] : []);
  ctx.setDefault(platform, 'proxyAuth.sharedSecretHeader', 'X-Proxy-Secret');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    proxyAuthOn
      ? 'Proxy auth is on: trusting identity headers from the local host only (proxyAuth.trustedProxies)'
      : 'Added proxyAuth.trustedProxies (empty)'
  );
}
