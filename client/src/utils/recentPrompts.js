import { createRecentItemHelpers } from './recentItems.js';

const { recordUsage: recordPromptUsage, getIds: getRecentPromptIds } =
  createRecentItemHelpers({ prefix: 'aihub_recent_prompts_' });
export { recordPromptUsage, getRecentPromptIds };
