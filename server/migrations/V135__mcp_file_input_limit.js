export const version = '135';
export const description = 'mcp_file_input_limit';

export async function precondition(ctx) {
  return await ctx.fileExists('config/mcpServers.json');
}

/**
 * Seed `fileInputs.maxFileSizeMB` on every configured MCP server so the limit
 * shows up with an explicit value in the admin UI.
 *
 * MCP tools can declare a parameter with `format: "file"`; iHub hands such a
 * parameter a chat attachment of the current message as
 * `{ fileName, mimeType, base64, size }`. This field caps the size of one such
 * file, per server. Default 20 MB. An admin who set the field already keeps
 * their value; nothing else in the file changes.
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
    if (ctx.setDefault(server, 'fileInputs.maxFileSizeMB', 20)) seeded++;
  }

  await ctx.writeJson('config/mcpServers.json', config);
  ctx.log(`Seeded fileInputs.maxFileSizeMB on ${seeded} MCP server(s)`);
}
