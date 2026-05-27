export const version = '042';
export const description = 'add_mcp_config';

/**
 * Adds first-class MCP support to iHub:
 *   - `contents/config/mcpServers.json` — outbound (client) connection list
 *   - `platform.mcpServer` block — inbound gateway settings
 *
 * Auto-promotes a pre-existing MCP_SERVER_URL env var into a single legacy
 * server entry so installs that depended on the old one-line stub keep
 * working without manual intervention.
 */

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  // --- 1. Seed mcpServers.json -------------------------------------------------
  const seedPath = 'config/mcpServers.json';
  const exists = await ctx.fileExists(seedPath);

  let file;
  if (exists) {
    file = await ctx.readJson(seedPath);
  } else {
    file = { servers: [], security: { blockPrivateIps: true, allowedHosts: [] } };
  }
  if (!Array.isArray(file.servers)) file.servers = [];
  if (!file.security) file.security = { blockPrivateIps: true, allowedHosts: [] };

  // Auto-promote MCP_SERVER_URL legacy stub. We only do this on first install
  // (when the file didn't exist) — we don't want to re-add it on every restart
  // if the operator deliberately removed it later.
  const legacyUrl = process.env.MCP_SERVER_URL;
  if (!exists && legacyUrl) {
    file.servers.push({
      id: 'legacy-mcp-server',
      name: { en: 'Legacy MCP Server (promoted from MCP_SERVER_URL)' },
      enabled: true,
      transport: { type: 'streamableHttp', url: legacyUrl },
      auth: { type: 'none' },
      allowedTools: ['*'],
      timeoutMs: 30000
    });
    ctx.log(`Promoted legacy MCP_SERVER_URL=${legacyUrl} into mcpServers.json`);
  }

  await ctx.writeJson(seedPath, file);
  ctx.log(exists ? 'Updated existing mcpServers.json' : 'Created mcpServers.json');

  // --- 2. Add platform.mcpServer defaults --------------------------------------
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'mcpServer.enabled', false);
  ctx.setDefault(platform, 'mcpServer.publicUrl', '');
  ctx.setDefault(platform, 'mcpServer.requireConsent', true);
  ctx.setDefault(platform, 'mcpServer.defaultScopes', ['mcp:tools:read', 'mcp:tools:call']);
  ctx.setDefault(platform, 'mcpServer.transports.streamableHttp.enabled', true);
  ctx.setDefault(platform, 'mcpServer.transports.sse.enabled', true);
  ctx.setDefault(platform, 'mcpServer.transports.sse.deprecated', true);
  ctx.setDefault(platform, 'mcpServer.expose.tools', true);
  ctx.setDefault(platform, 'mcpServer.expose.apps', true);
  ctx.setDefault(platform, 'mcpServer.expose.workflows', true);
  // Resources are opt-in (data-exposure surface): admin enables explicitly.
  ctx.setDefault(platform, 'mcpServer.expose.resources', false);
  ctx.setDefault(platform, 'mcpServer.a2a.enabled', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added platform.mcpServer defaults');
}
