import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError } from '../../utils/responseHelpers.js';

export default function registerAdminOverviewRoutes(app) {
  /**
   * GET /api/admin/overview/stats
   * Aggregated overview stats from configCache (in-memory, fast).
   * Returns counts for apps, models, providers, sources, tools, users, groups,
   * plus auth mode and integration status.
   */
  app.get(buildServerPath('/api/admin/overview/stats'), adminAuth, async (req, res) => {
    try {
      // Apps
      const { data: allApps } = configCache.getApps(true) || { data: [] };
      const apps = Array.isArray(allApps) ? allApps : [];
      const enabledApps = apps.filter(a => a.enabled !== false);

      // Models
      const modelsResult = configCache.getModels(true);
      const allModels = modelsResult?.data || (Array.isArray(modelsResult) ? modelsResult : []);
      const enabledModels = allModels.filter(m => m.enabled !== false);

      // Providers
      const providersResult = configCache.getProviders(true);
      const allProviders =
        providersResult?.data || (Array.isArray(providersResult) ? providersResult : []);
      const enabledProviders = allProviders.filter(p => p.enabled !== false);

      // Sources
      const sourcesResult = configCache.getSources(true);
      const allSources = sourcesResult?.data || (Array.isArray(sourcesResult) ? sourcesResult : []);
      const enabledSources = allSources.filter(s => s.enabled !== false);

      // Tools
      const toolsResult = configCache.getTools(true);
      const allTools = toolsResult?.data || (Array.isArray(toolsResult) ? toolsResult : []);
      const enabledTools = allTools.filter(tl => tl.enabled !== false);

      // Groups
      const { data: groupsData } = configCache.getGroups() || { data: null };
      const groupCount = groupsData?.groups ? Object.keys(groupsData.groups).length : 0;

      // Users (actual registered users, not sessions)
      let userCount = 0;
      try {
        const { data: usersData } = configCache.get('config/users.json') || { data: null };
        if (usersData?.users) {
          userCount = Object.keys(usersData.users).length;
        }
      } catch {
        // skip
      }

      // Platform config for auth info
      const platformResult = configCache.getPlatform();
      const platform = platformResult?.data || platformResult || {};

      const authMode = platform.auth?.mode || 'anonymous';
      const anonymousEnabled = platform.anonymousAuth?.enabled ?? false;
      const localAuthEnabled = platform.localAuth?.enabled ?? false;
      const proxyAuthEnabled = platform.proxyAuth?.enabled ?? false;
      const oidcProviderCount = Array.isArray(platform.oidcAuth?.providers)
        ? platform.oidcAuth.providers.length
        : 0;
      const ldapProviderCount = Array.isArray(platform.ldapAuth?.providers)
        ? platform.ldapAuth.providers.length
        : 0;
      const oauthAuthzEnabled = platform.oauth?.enabled?.authz ?? false;
      const oauthClientsEnabled = platform.oauth?.enabled?.clients ?? false;

      res.json({
        apps: { total: apps.length, enabled: enabledApps.length },
        models: { total: allModels.length, enabled: enabledModels.length },
        providers: { total: allProviders.length, enabled: enabledProviders.length },
        sources: { total: allSources.length, enabled: enabledSources.length },
        tools: { total: allTools.length, enabled: enabledTools.length },
        groups: groupCount,
        users: userCount,
        auth: {
          mode: authMode,
          anonymous: anonymousEnabled,
          local: localAuthEnabled,
          proxy: proxyAuthEnabled,
          oidcProviders: oidcProviderCount,
          ldapProviders: ldapProviderCount,
          oauth: {
            authz: oauthAuthzEnabled,
            clients: oauthClientsEnabled
          }
        }
      });
    } catch (error) {
      return sendInternalError(res, error, 'overview stats');
    }
  });
}
