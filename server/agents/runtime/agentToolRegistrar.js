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
 * Materialized planner tasks (marked with `_isPlannerTask: true` by
 * SubWorkflowMaterializer) are workers — they do the work the planner
 * decomposed into. The inbox lifecycle (read once, mark done once) is owned
 * by the orchestrator nodes that sandwich the planner, NOT by individual
 * plan tasks. Giving plan tasks `read_inbox` / `write_inbox` causes each
 * stateless task to re-read the inbox and possibly mark different items —
 * exactly the "two items processed" bug the user hit. So we strip those
 * tools from materialized task nodes.
 *
 * @param {Object} profile - Resolved AgentProfile
 * @param {Object} nodeConfig - Current node config (may include dynamicTasks)
 * @returns {string[]} array of tool IDs (deduplicated)
 */
export function getAgentToolIds(profile, nodeConfig = {}) {
  const ids = new Set(ALWAYS_ON);
  const isPlannerTask = nodeConfig?._isPlannerTask === true;
  if (profile?.inboxId && !isPlannerTask) {
    INBOX_TOOLS.forEach(id => ids.add(id));
  }
  if (nodeConfig?.dynamicTasks?.enabled || profile?.dynamicTasks?.enabled) {
    DYNAMIC_TASK_TOOLS.forEach(id => ids.add(id));
  }
  return Array.from(ids);
}

export default { getAgentToolIds };
