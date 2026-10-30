// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import configCache from '../../configCache.js';

/**
 * The inbound MCP gateway's settings (`platform.mcpServer`) for Admin → MCP
 * gateway. The gateway itself is configured through the platform config; this
 * route only returns the current block for the page to render alongside the
 * OAuth client list. Outbound MCP servers are installed integrations
 * (`/api/admin/integrations/*`).
 */
export default function registerAdminMcpGatewayRoutes(app) {
  app.get(buildServerPath('/api/admin/mcp/gateway'), adminAuth, (req, res) => {
    const platform = configCache.getPlatform() || {};
    res.json({ success: true, gateway: platform.mcpServer || { enabled: false } });
  });
}
