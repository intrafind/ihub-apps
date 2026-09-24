export const version = '130';
export const description = 'mcp_apps_server_toggle';

export async function precondition(ctx) {
  return await ctx.fileExists('config/mcpServers.json');
}

/**
 * Seed `apps.enabled` on every configured MCP server so the MCP Apps toggle
 * shows up with an explicit value in the admin UI.
 *
 * Default `true`: iHub now advertises the `io.modelcontextprotocol/ui`
 * extension and renders the interactive views a server's tools declare. A
 * server that declares none behaves exactly as before. An admin who set the
 * field already keeps their value.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/mcpServers.json');
  if (!Array.isArray(config?.servers)) {
    ctx.log('No MCP servers configured; nothing to seed');
    return;
  }

  let seeded = 0;
  for (const server of config.servers) {
    if (!server || typeof server !== 'object') continue;
    if (ctx.setDefault(server, 'apps.enabled', true)) seeded++;
  }

  await ctx.writeJson('config/mcpServers.json', config);
  ctx.log(`Seeded apps.enabled on ${seeded} MCP server(s)`);
}
