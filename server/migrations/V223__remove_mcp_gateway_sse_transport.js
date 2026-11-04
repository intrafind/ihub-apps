// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V223 - the MCP gateway's legacy SSE transport is gone
 *
 * `GET /mcp/sse` and `POST /mcp/messages` no longer exist, so the
 * `mcpServer.transports.sse` setting (V050) has nothing to configure. The key
 * is removed from platform.json.
 */

export const version = '223';
export const description = 'remove_mcp_gateway_sse_transport';

const PLATFORM_FILE = 'config/platform.json';

export async function precondition(ctx) {
  return ctx.fileExists(PLATFORM_FILE);
}

export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const transports = platform?.mcpServer?.transports;
  if (!transports || typeof transports !== 'object' || !('sse' in transports)) return;
  delete transports.sse;
  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log('mcpServer.transports.sse removed');
}
