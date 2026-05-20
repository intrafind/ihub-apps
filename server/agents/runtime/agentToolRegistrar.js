/**
 * Agent Tool Registrar
 *
 * Returns the list of tool IDs that should be auto-registered for an agent
 * run, based on the Profile's capabilities. The actual tool definitions live
 * in `config/tools.json` (added by migration V042) and the implementation
 * lives in `server/tools/agentTools.js`.
 *
 * The registrar is consulted in PromptNodeExecutor.getAgentTools() before
 * resolution against the global tool catalog.
 */

/**
 * Tool IDs surfaced for every agent run (memory + artifact).
 */
const ALWAYS_ON = ['read_memory', 'write_memory', 'write_artifact'];

/**
 * Tool IDs surfaced when the Profile has an inboxId.
 */
const INBOX_TOOLS = ['read_inbox', 'write_inbox'];

/**
 * Tool IDs surfaced when dynamicTasks.enabled is true on the node.
 */
const DYNAMIC_TASK_TOOLS = ['create_task', 'list_tasks', 'mark_task_done'];

/**
 * Return the list of agent tool IDs to inject for the current run/node.
 *
 * @param {Object} profile - Resolved AgentProfile
 * @param {Object} nodeConfig - Current node config (may include dynamicTasks)
 * @returns {string[]} array of tool IDs (deduplicated)
 */
export function getAgentToolIds(profile, nodeConfig = {}) {
  const ids = new Set(ALWAYS_ON);
  if (profile?.inboxId) {
    INBOX_TOOLS.forEach(id => ids.add(id));
  }
  if (nodeConfig?.dynamicTasks?.enabled || profile?.dynamicTasks?.enabled) {
    DYNAMIC_TASK_TOOLS.forEach(id => ids.add(id));
  }
  return Array.from(ids);
}

export default { getAgentToolIds };
