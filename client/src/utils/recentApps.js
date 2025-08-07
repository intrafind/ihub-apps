import { createRecentItemHelpers } from './recentItems.js';

const { recordUsage: recordAppUsage, getIds: getRecentAppIds } = createRecentItemHelpers({
  prefix: 'ihub_recent_apps_'
});
export { recordAppUsage, getRecentAppIds };
