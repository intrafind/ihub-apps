import { createRecentItemHelpers } from './recentItems.js';

const { getMap: getRecentAppsMap, recordUsage: recordAppUsage, getIds: getRecentAppIds } =
  createRecentItemHelpers({ prefix: 'aihub_recent_apps_' });

export { getRecentAppsMap, recordAppUsage, getRecentAppIds };
