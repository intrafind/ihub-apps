// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Platform tools: the tools of iHub's workflows and agents, owned by those
 * features and not by an integration (Unified Integrations concept §6.9).
 *
 * - the agent workspace: `write_artifact`, `read_memory`, `write_memory`,
 *   `read_inbox`, `write_inbox`, `create_task`, `list_tasks`,
 *   `mark_task_done` (`server/tools/agentTools.js`);
 * - the evidence tools: `evidence_collect`, `evidence_validateQuotesFastPath`,
 *   `evidence_composeReport` (`server/tools/evidence.js`).
 *
 * They are plain tools — no `_integration` marker, not listed on the
 * Integrations page — loaded by `loadTools()` next to the configured tools,
 * so they behave as their tool files in `contents/tools/` did before
 * migration V199: agent runs attach them (`agents/runtime/agentToolRegistrar.js`),
 * workflow nodes, agent profiles and apps name them in `tools` (exact id or
 * base id, `evidence`), group grants (`permissions.tools`) select them, a
 * scheduled run with memory gets `read_memory` / `write_memory`, and
 * `runTool` runs them through their script like any tool file.
 *
 * The definitions are the shipped files in `server/defaults/tools/`, read
 * once: they are part of iHub, not of the admin's configuration. A file with
 * the same id in `contents/tools/` (one an admin edited, which V199 kept)
 * takes the place of the shipped definition, as a configured tool always did.
 *
 * @module services/tools/platformTools
 */
import { readShippedToolDefinitions } from './shippedToolDefinitions.js';

/** The file-level ids (`evidence`, not `evidence_collect`) of the platform tools. */
export const PLATFORM_TOOL_FILE_IDS = Object.freeze([
  'create_task',
  'evidence',
  'list_tasks',
  'mark_task_done',
  'read_inbox',
  'read_memory',
  'write_artifact',
  'write_inbox',
  'write_memory'
]);

const DEFINITIONS = readShippedToolDefinitions(PLATFORM_TOOL_FILE_IDS);

/** The tool ids of the platform tools, one per function of a function-style file. */
export const PLATFORM_TOOL_IDS = Object.freeze([...DEFINITIONS.keys()]);

/**
 * Whether a tool id is one of the platform tools.
 * @param {string} toolId
 * @returns {boolean}
 */
export function isPlatformTool(toolId) {
  return DEFINITIONS.has(toolId);
}

/**
 * The platform tool definitions, multilingual as shipped. Each call returns
 * fresh copies, so a caller may change what it gets.
 *
 * @returns {Object[]}
 */
export function platformToolDefinitions() {
  return [...DEFINITIONS.values()].map(tool => structuredClone(tool));
}
