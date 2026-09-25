export const version = '134';
export const description = 'mcp_empty_tool_prefix';

export async function precondition(ctx) {
  return await ctx.fileExists('config/mcpServers.json');
}

/**
 * Drop `toolPrefix: ""` from every configured MCP server.
 *
 * The admin form saved a blank "Tool prefix" field as an empty string, and
 * iHub then exposed the server's tools with no prefix at all (`create_diagram`
 * instead of `drawio__create_diagram`) — though the field's placeholder
 * promised the `<id>__` default. Tools of two servers could collide. A blank
 * prefix now means the default, so the stored empty string is removed to say
 * the same thing. A prefix an admin actually typed is left alone.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/mcpServers.json');
  if (!Array.isArray(config?.servers)) {
    ctx.log('No MCP servers configured; nothing to change');
    return;
  }

  const changed = [];
  for (const server of config.servers) {
    if (!server || typeof server !== 'object') continue;
    if (typeof server.toolPrefix === 'string' && server.toolPrefix.trim() === '') {
      delete server.toolPrefix;
      changed.push(server.id);
    }
  }

  if (changed.length === 0) {
    ctx.log('No MCP server has an empty tool prefix');
    return;
  }
  await ctx.writeJson('config/mcpServers.json', config);
  ctx.log(`Removed the empty tool prefix from: ${changed.join(', ')}`);
}
