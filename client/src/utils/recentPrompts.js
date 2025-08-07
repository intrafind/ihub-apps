import { createRecentItemHelpers } from './recentItems.js';

const { recordUsage: recordPromptUsage, getIds: getRecentPromptIds } = createRecentItemHelpers({
  prefix: 'ihub_recent_prompts_'
});
export { recordPromptUsage, getRecentPromptIds };
