import { createRecentItemHelpers } from './recentItems.js';

const { getMap: getRecentPromptsMap, recordUsage: recordPromptUsage, getIds: getRecentPromptIds } =
  createRecentItemHelpers({ prefix: 'aihub_recent_prompts_' });

export { getRecentPromptsMap, recordPromptUsage, getRecentPromptIds };
