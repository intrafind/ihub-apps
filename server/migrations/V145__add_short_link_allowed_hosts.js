// server/migrations/V145__add_short_link_allowed_hosts.js
export const version = '145';
export const description = 'add_short_link_allowed_hosts';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Short links redirect only to paths on this server, or to absolute http(s)
 * URLs whose host is listed in platform.shortLinks.allowedHosts. The list
 * starts empty, so only paths on this server are allowed until an admin adds
 * hosts.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'shortLinks.allowedHosts', []);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added shortLinks.allowedHosts (empty: only paths on this server)');
}
