import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';

export default function registerAdminSearchRoutes(app) {
  /**
   * GET /api/admin/search?q=query
   * Global admin search across apps, prompts, models, groups, users.
   * Returns max 5 results per category.
   */
  app.get(buildServerPath('/api/admin/search'), adminAuth, async (req, res) => {
    try {
      const query = (req.query.q || '').trim().toLowerCase();
      if (query.length < 2) {
        return sendBadRequest(res, 'Query must be at least 2 characters');
      }

      const MAX_PER_CATEGORY = 5;
      const results = {
        apps: [],
        prompts: [],
        models: [],
        groups: [],
        users: [],
        sources: [],
        providers: [],
        tools: []
      };

      // Search apps
      try {
        const { data: apps } = configCache.getApps(true);
        results.apps = apps
          .filter(a => {
            const name =
              typeof a.name === 'object' ? Object.values(a.name).join(' ') : a.name || '';
            return a.id?.toLowerCase().includes(query) || name.toLowerCase().includes(query);
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(a => ({ id: a.id, name: a.name, enabled: a.enabled }));
      } catch {
        // skip
      }

      // Search prompts
      try {
        const { data: prompts } = configCache.getPrompts(true);
        results.prompts = prompts
          .filter(p => {
            const name =
              typeof p.name === 'object' ? Object.values(p.name).join(' ') : p.name || '';
            const title =
              typeof p.title === 'object' ? Object.values(p.title).join(' ') : p.title || '';
            return (
              p.id?.toLowerCase().includes(query) ||
              name.toLowerCase().includes(query) ||
              title.toLowerCase().includes(query)
            );
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(p => ({ id: p.id, name: p.name || p.title }));
      } catch {
        // skip
      }

      // Search models
      try {
        const { data: models } = configCache.getModels(true);
        results.models = models
          .filter(m => {
            const name =
              typeof m.name === 'object' ? Object.values(m.name).join(' ') : m.name || '';
            return m.id?.toLowerCase().includes(query) || name.toLowerCase().includes(query);
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(m => ({ id: m.id, name: m.name }));
      } catch {
        // skip
      }

      // Search groups
      try {
        const { data: groupsData } = configCache.getGroups();
        if (groupsData?.groups) {
          const groupEntries = Object.values(groupsData.groups);
          results.groups = groupEntries
            .filter(g => {
              return g.id?.toLowerCase().includes(query) || g.name?.toLowerCase().includes(query);
            })
            .slice(0, MAX_PER_CATEGORY)
            .map(g => ({ id: g.id, name: g.name }));
        }
      } catch {
        // skip
      }

      // Search users
      try {
        const { data: usersData } = configCache.get('config/users.json');
        if (usersData?.users) {
          const userEntries = Object.values(usersData.users);
          results.users = userEntries
            .filter(u => {
              return (
                u.username?.toLowerCase().includes(query) ||
                u.email?.toLowerCase().includes(query) ||
                u.name?.toLowerCase().includes(query)
              );
            })
            .slice(0, MAX_PER_CATEGORY)
            .map(u => ({ id: u.id, username: u.username, email: u.email }));
        }
      } catch {
        // skip
      }

      // Search sources
      try {
        const { data: sources } = configCache.getSources(true);
        results.sources = sources
          .filter(s => {
            const name =
              typeof s.name === 'object' ? Object.values(s.name).join(' ') : s.name || '';
            return (
              s.id?.toLowerCase().includes(query) ||
              name.toLowerCase().includes(query) ||
              s.type?.toLowerCase().includes(query)
            );
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(s => ({ id: s.id, name: s.name }));
      } catch {
        // skip
      }

      // Search providers
      try {
        const { data: providers } = configCache.getProviders(true);
        results.providers = providers
          .filter(p => {
            const name =
              typeof p.name === 'object' ? Object.values(p.name).join(' ') : p.name || '';
            return p.id?.toLowerCase().includes(query) || name.toLowerCase().includes(query);
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(p => ({ id: p.id, name: p.name }));
      } catch {
        // skip
      }

      // Search tools
      try {
        const { data: tools } = configCache.getTools(true);
        results.tools = tools
          .filter(tl => {
            const name =
              typeof tl.name === 'object' ? Object.values(tl.name).join(' ') : tl.name || '';
            const desc =
              typeof tl.description === 'object'
                ? Object.values(tl.description).join(' ')
                : tl.description || '';
            return (
              tl.id?.toLowerCase().includes(query) ||
              name.toLowerCase().includes(query) ||
              desc.toLowerCase().includes(query)
            );
          })
          .slice(0, MAX_PER_CATEGORY)
          .map(tl => ({ id: tl.id, name: tl.name }));
      } catch {
        // skip
      }

      res.json(results);
    } catch (error) {
      return sendInternalError(res, error, 'admin search');
    }
  });
}
