export const version = '134';
export const description = 'mcp_server_tool_refs';

export async function precondition(ctx) {
  return await ctx.fileExists('config/mcpServers.json');
}

/** The prefix a server's tool ids carried before this migration. */
function previousPrefix(server) {
  return typeof server.toolPrefix === 'string' ? server.toolPrefix : `${server.id}__`;
}

/** Ids of the script-backed tools configured in contents/tools and config/tools.json. */
async function configuredToolIds(ctx) {
  const ids = new Set();
  const files = (await ctx.fileExists('tools')) ? await ctx.listFiles('tools', '*.json') : [];
  for (const file of files || []) {
    const tool = await ctx.readJson(`tools/${file}`).catch(() => null);
    if (typeof tool?.id === 'string') ids.add(tool.id);
  }
  if (await ctx.fileExists('config/tools.json')) {
    const legacy = await ctx.readJson('config/tools.json').catch(() => null);
    for (const tool of Array.isArray(legacy) ? legacy : []) {
      if (typeof tool?.id === 'string') ids.add(tool.id);
    }
  }
  return ids;
}

/**
 * MCP servers become one unit per app, and their tool ids a stable `<id>__`.
 *
 * 1. mcpServers.json — drop `toolPrefix: ""`. The admin form saved a blank
 *    "Tool prefix" field as an empty string, and iHub then exposed the tools
 *    with no prefix at all (`create_diagram`), though the field promised the
 *    `<id>__` default; tools of two servers could collide. A blank prefix now
 *    means the default. A prefix an admin typed is left alone.
 *
 * 2. apps/*.json — an app now enables an MCP server by listing the server's id
 *    (`"drawio"`), and users see the server as one entry in the chat, never its
 *    tools. App references to single tools of a server are replaced by the
 *    server's id, so the app keeps its tools under their new ids:
 *    `drawio__create_diagram` by its prefix, and a bare `create_diagram` of a
 *    server that had no prefix when that server's allowlist names it. A
 *    reference to a configured tool, a workflow or a source is never touched.
 *    A bare reference no allowlist names is left as it is and reported: it may
 *    be anything, and guessing could hand an app a whole server.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/mcpServers.json');
  const servers = Array.isArray(config?.servers)
    ? config.servers.filter(s => s && typeof s === 'object' && typeof s.id === 'string')
    : [];
  if (servers.length === 0) {
    ctx.log('No MCP servers configured; nothing to change');
    return;
  }

  const prefixed = [];
  const unprefixed = [];
  for (const server of servers) {
    const prefix = previousPrefix(server);
    if (prefix.trim() === '') {
      // Only an explicit allowlist says which bare names are this server's tools.
      const allowed = Array.isArray(server.allowedTools) ? server.allowedTools : [];
      unprefixed.push({ id: server.id, names: allowed.filter(n => n !== '*') });
    } else {
      prefixed.push({ id: server.id, prefix });
    }
  }
  const unprefixedIds = unprefixed.map(s => s.id);

  // 1. A blank prefix means the default from now on.
  if (unprefixed.length > 0) {
    for (const server of servers) {
      if (unprefixedIds.includes(server.id)) delete server.toolPrefix;
    }
    await ctx.writeJson('config/mcpServers.json', config);
    ctx.log(`Removed the empty tool prefix from: ${unprefixedIds.join(', ')}`);
  }

  // 2. Apps reference MCP servers, not their single tools.
  const appFiles = (await ctx.fileExists('apps')) ? await ctx.listFiles('apps', '*.json') : [];
  if (!Array.isArray(appFiles) || appFiles.length === 0) return;

  const toolIds = await configuredToolIds(ctx);
  const serverIds = new Set(servers.map(s => s.id));
  const isOtherKind = ref =>
    serverIds.has(ref) ||
    toolIds.has(ref) ||
    toolIds.has(ref.split('_')[0]) ||
    ref.startsWith('workflow_') ||
    ref.startsWith('source_');

  let migrated = 0;
  for (const file of appFiles) {
    const app = await ctx.readJson(`apps/${file}`).catch(() => null);
    if (!Array.isArray(app?.tools) || app.tools.length === 0) continue;

    const next = [];
    const unresolved = [];
    for (const ref of app.tools) {
      let target = ref;
      if (typeof ref === 'string' && !isOtherKind(ref)) {
        const owner =
          prefixed.find(s => ref.startsWith(s.prefix) && ref.length > s.prefix.length) ||
          unprefixed.find(s => s.names.includes(ref));
        if (owner) target = owner.id;
        else if (unprefixed.length > 0) unresolved.push(ref);
      }
      if (!next.includes(target)) next.push(target);
    }

    if (unresolved.length > 0) {
      ctx.warn(
        `App "${app.id || file}" lists ${unresolved.join(', ')}, which may be tools of the ` +
          `MCP server(s) ${unprefixedIds.join(', ')} under their old unprefixed names. ` +
          'Enable the server in the app editor and remove these entries.'
      );
    }
    if (next.length === app.tools.length && next.every((ref, i) => ref === app.tools[i])) continue;

    app.tools = next;
    await ctx.writeJson(`apps/${file}`, app);
    migrated++;
  }
  if (migrated > 0) {
    ctx.log(`Replaced single MCP tool references with their server in ${migrated} app(s)`);
  }
}
