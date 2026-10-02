// server/migrations/V147__add_proxy_auth_trusted_sources.js
export const version = '147';
export const description = 'add_proxy_auth_trusted_sources';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Proxy auth now uses its identity headers only from trusted proxies
 * (`proxyAuth.trustedProxies`) and/or with a shared secret
 * (utils/proxyAuthTrust.js). Every installation starts by trusting the local
 * host, like a new one, so a proxy on the same host or in the same pod works
 * whenever proxy auth is on; proxies elsewhere have to be added. A list an
 * admin already set is kept.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'proxyAuth.trustedProxies', ['loopback']);
  ctx.setDefault(platform, 'proxyAuth.sharedSecretHeader', 'X-Proxy-Secret');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Proxy auth trusts identity headers from the local host (proxyAuth.trustedProxies); add proxies elsewhere there'
  );
}
