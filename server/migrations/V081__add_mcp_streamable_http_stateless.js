export const version = '081';
export const description = 'add_mcp_streamable_http_stateless';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Seed `mcpServer.transports.streamableHttp.stateless` so the option shows up
 * with an explicit value in the admin UI.
 *
 * Default `false` keeps the existing stateful behaviour (MCP sessions held in
 * worker memory, which the sticky cluster router already routes consistently).
 * Operators running iHub as several load-balanced replicas should turn it on:
 * a session opened on one replica is unknown to the next, and the client then
 * has to re-initialize on every request.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'mcpServer.transports.streamableHttp.stateless', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added mcpServer.transports.streamableHttp.stateless default');
}
