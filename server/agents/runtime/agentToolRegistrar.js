/**
 * Agent Tool Registrar
 *
 * Returns the list of tool IDs that should be auto-registered for an agent
 * run, based on the Profile's capabilities and the current node's role in
 * the lifecycle. The actual tool definitions live in `config/tools.json`
 * (added by migration V042 / V045 / V046) and the implementation lives in
 * `server/tools/agentTools.js`.
 *
 * Lifecycle redesign (V047+): deterministic lifecycle operations are owned
 * by the runtime, not the LLM. The registrar therefore no longer
 * auto-attaches `read_inbox`, `write_inbox`, `write_artifact`, or
 * `mark_task_done`. These tools still exist (and are still defined in
 * tools.json) so profile authors can add them to `profile.tools[]` as an
 * escape hatch — but they are no longer pushed into every agent prompt by
 * default. That alone eliminates the planner-hallucination class of bugs
 * we were defending against with `"DO NOT include orchestration steps"`
 * prose in the planner system prompt.
 *
 * What IS auto-registered now:
 *
 *   - `read_memory` / `write_memory` — memory needs LLM agency by design.
 *   - `create_task` / `set_plan` / `update_task` / `list_tasks` — dynamic
 *     decomposition is the only way the agent can shape its own work queue
 *     during a run. Attached to ANY prompt node whose node config OR profile
 *     has `dynamicTasks.enabled` (not restricted to `_isPlannerTask` nodes).
 *
 * Synthesizer nodes (`_isSynthesizer: true`) get NO tools at all — they are
 * pure text-in/text-out. The runtime persists their output as the final
 * artifact, so the LLM never needs to call write_artifact.
 *
 * The registrar is consulted in `PromptNodeExecutor.getAgentTools()` before
 * resolution against the global tool catalog.
 */

/** Memory tools — always on for agent prompt nodes. */
const MEMORY_TOOLS = ['read_memory', 'write_memory'];

/**
 * Dynamic decomposition tools — attached whenever `dynamicTasks.enabled` is set
 * on the node config or the profile (see getAgentToolIds).
 * `set_plan` lets the agent declare/replace its whole plan up front
 * (TodoWrite analog); `update_task` lets it re-title, reprioritize, or mark a
 * task blocked as it reconsiders. The drain loop still owns the
 * open→in_progress→done transition during execution.
 */
const DYNAMIC_TASK_TOOLS = ['create_task', 'set_plan', 'update_task', 'list_tasks'];

/**
 * Return the list of agent tool IDs to inject for the current run/node.
 *
 * @param {Object} profile - Resolved AgentProfile
 * @param {Object} nodeConfig - Current node config; runtime sets
 *   `_isPlannerTask` on materialized planner task nodes and `_isSynthesizer`
 *   on the synthesizer prompt node.
 * @returns {string[]} array of tool IDs (deduplicated)
 */
export function getAgentToolIds(profile, nodeConfig = {}) {
  // Synthesizer is pure text-in/text-out — runtime persists its output
  // as the primary artifact. No LLM tools attached.
  if (nodeConfig?._isSynthesizer === true) {
    return [];
  }

  const ids = new Set();

  // Memory tools: only attached when the profile has memory enabled.
  // Default is enabled (matches the schema default), so omitting the
  // memory block keeps the previous behavior. Profiles that explicitly
  // set memory.enabled=false get no read_memory / write_memory tools.
  const memoryEnabled = profile?.memory?.enabled !== false;
  if (memoryEnabled) {
    MEMORY_TOOLS.forEach(id => ids.add(id));
  }

  // Dynamic decomposition: any prompt node attached to a dynamicTasks-enabled
  // profile (or node) gets create_task / list_tasks. Whether a *drain loop*
  // is present to process created tasks is a workflow-shape question — an
  // agent should always be ABLE to call create_task when configured for
  // dynamic work; the workflow either drains the queue or leaves it as a
  // record of intent.
  const dynamicEnabled =
    nodeConfig?.dynamicTasks?.enabled === true || profile?.dynamicTasks?.enabled === true;

  if (dynamicEnabled) {
    DYNAMIC_TASK_TOOLS.forEach(id => ids.add(id));
  }

  return Array.from(ids);
}

export default { getAgentToolIds };
