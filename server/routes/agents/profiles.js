/**
 * User-facing profile routes:
 *   GET /api/agents/profiles            — list profiles visible to the user
 *   GET /api/agents/profiles/:id        — single profile (sanitized)
 */

import { authRequired } from '../../middleware/authRequired.js';
import { sendNotFound, sendFailedOperationError } from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';

function visibleToUser(profile, user) {
  // Admins see all.
  if (user?.isAdmin) return true;
  // Operators see profiles where they are in profile.groups.
  const allow = profile.groups || [];
  if (allow.length === 0) return true;
  const userGroups = user?.groups || [];
  return allow.some(g => userGroups.includes(g));
}

function sanitize(profile) {
  // Strip internal-only fields so non-admins don't see service account groups etc.
  const { serviceAccount: _sa, ...rest } = profile;
  return rest;
}

export default function registerAgentProfileRoutes(app) {
  app.get(buildServerPath('/api/agents/profiles'), authRequired, async (req, res) => {
    try {
      const { data: profiles = [] } = configCache.getAgentProfiles(false);
      const visible = profiles.filter(p => visibleToUser(p, req.user)).map(sanitize);
      res.json(visible);
    } catch (error) {
      sendFailedOperationError(res, 'list agent profiles', error);
    }
  });

  app.get(buildServerPath('/api/agents/profiles/:profileId'), authRequired, async (req, res) => {
    try {
      const { profileId } = req.params;
      if (!validateIdForPath(profileId, 'profile', res)) return;
      const { data: profiles = [] } = configCache.getAgentProfiles(false);
      const profile = profiles.find(p => p.id === profileId);
      if (!profile) return sendNotFound(res, `Profile ${profileId} not found`);
      if (!visibleToUser(profile, req.user)) {
        return sendNotFound(res, `Profile ${profileId} not found`);
      }
      res.json(sanitize(profile));
    } catch (error) {
      sendFailedOperationError(res, 'load agent profile', error);
    }
  });
}
