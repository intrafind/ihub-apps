export const version = '132';
export const description = 'mcp_apps_example_servers';

/** The MCP App servers the "draw.io Diagrams" and "Excalidraw Sketches" apps use. */
export const EXAMPLE_SERVER_IDS = Object.freeze(['drawio', 'excalidraw']);

export async function precondition(ctx) {
  return await ctx.fileExists('config/mcpServers.json');
}

/**
 * Add the draw.io and Excalidraw MCP App servers to mcpServers.json, disabled,
 * so the two example apps (also shipped disabled) can be tried by enabling
 * the server and the app — without every installation contacting these
 * public endpoints on startup.
 *
 * The entries come from the shipped defaults, so there is one definition. A
 * server id an admin already uses is left exactly as it is.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/mcpServers.json');
  const defaults = await ctx.readDefaultJson('config/mcpServers.json');
  if (!Array.isArray(config.servers)) config.servers = [];

  const added = [];
  for (const id of EXAMPLE_SERVER_IDS) {
    const entry = (defaults?.servers || []).find(server => server?.id === id);
    if (!entry) continue;
    if (ctx.addIfMissing(config.servers, { ...entry, enabled: false }, 'id')) added.push(id);
  }

  if (added.length === 0) {
    ctx.log('Example MCP App servers already present; nothing to add');
    return;
  }
  await ctx.writeJson('config/mcpServers.json', config);
  ctx.log(`Added disabled example MCP App servers: ${added.join(', ')}`);
}
