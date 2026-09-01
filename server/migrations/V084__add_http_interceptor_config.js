/**
 * Migration V084 — Seed the HTTP interceptor configuration
 *
 * Adds `logging.http`, the config block behind the wire-level request/response
 * log (`server/utils/httpInterceptor.js`). Without it the admin page renders
 * the section from client-side defaults and the first save writes a block the
 * operator never reviewed; seeding it makes the settings visible in
 * `platform.json` and in the config editor's schema from the start.
 *
 * Every switch is seeded off, so behaviour on existing installs is unchanged.
 * `setDefault` never overwrites, so an operator who already hand-wrote part of
 * this block keeps their values and only gains the missing keys.
 */
export const version = '084';
export const description = 'add_http_interceptor_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'logging.http.inbound.enabled', false);
  ctx.setDefault(platform, 'logging.http.inbound.includeHeaders', true);
  ctx.setDefault(platform, 'logging.http.inbound.includeRequestBody', false);
  ctx.setDefault(platform, 'logging.http.inbound.includeResponseBody', false);
  ctx.setDefault(platform, 'logging.http.inbound.methods', []);
  ctx.setDefault(platform, 'logging.http.inbound.pathAllowlist', []);
  // Health checks are polled continuously by load balancers and would bury
  // everything else in the log.
  ctx.setDefault(platform, 'logging.http.inbound.pathDenylist', ['/api/health']);

  ctx.setDefault(platform, 'logging.http.outbound.enabled', false);
  ctx.setDefault(platform, 'logging.http.outbound.includeHeaders', true);
  ctx.setDefault(platform, 'logging.http.outbound.includeRequestBody', false);
  ctx.setDefault(platform, 'logging.http.outbound.includeResponseBody', false);
  ctx.setDefault(platform, 'logging.http.outbound.hostAllowlist', []);
  ctx.setDefault(platform, 'logging.http.outbound.hostDenylist', []);

  ctx.setDefault(platform, 'logging.http.maxBodyBytes', 8192);
  ctx.setDefault(platform, 'logging.http.rawBodies', false);
  // The guard against enabling capture in production and walking away.
  ctx.setDefault(platform, 'logging.http.autoDisableAfterMinutes', 60);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added logging.http defaults (HTTP interceptor, all capture off)');
}
