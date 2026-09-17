export const version = '080';
export const description = 'add_mcp_gateway_oauth_defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Seed defaults for the MCP gateway (platform.mcpServer) and OAuth dynamic
 * client registration (platform.oauth.dcr) so both sections exist with
 * explicit values and show up correctly in the admin UI. All values are
 * conservative (gateway off, DCR off) and setDefault never overwrites
 * anything an admin has already configured.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'mcpServer.enabled', false);
  ctx.setDefault(platform, 'mcpServer.requireConsent', true);
  ctx.setDefault(platform, 'mcpServer.publicUrl', '');
  ctx.setDefault(platform, 'mcpServer.transports.streamableHttp.enabled', true);
  ctx.setDefault(platform, 'mcpServer.transports.sse.enabled', true);
  ctx.setDefault(platform, 'mcpServer.a2a.enabled', false);
  ctx.setDefault(platform, 'mcpServer.expose.tools', true);
  ctx.setDefault(platform, 'mcpServer.expose.apps', true);
  ctx.setDefault(platform, 'mcpServer.expose.workflows', true);
  ctx.setDefault(platform, 'mcpServer.expose.resources', false);
  ctx.setDefault(platform, 'mcpServer.defaultScopes', ['mcp:tools:read', 'mcp:tools:call']);

  ctx.setDefault(platform, 'oauth.dcr.enabled', false);
  ctx.setDefault(platform, 'oauth.dcr.maxClients', 100);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added mcpServer gateway defaults and oauth.dcr defaults');
}
