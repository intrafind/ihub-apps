// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Running a tool: `runTool` dispatches a call to the built-in actions, the
 * skill, knowledge and integration tools, MCP and A2A, or a tool script.
 */

import configCache from '../../configCache.js';
import {
  activeSkillsOf,
  describeSkillCatalog,
  getAssignedSkillIds,
  isModelInvocable,
  loadUsableSkill,
  searchSkillCatalog
} from '../skillAccess.js';
import { actionTracker } from '../../actionTracker.js';
import { emitToolProgress } from '../loop/RunStream.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { runToolScript } from './toolScriptRunner.js';
import mcpClientManager from '../mcp/McpClientManager.js';
import a2aClientManager from '../a2a/A2aClientManager.js';
import logger from '../../utils/logger.js';
import { isKnowledgeTool, runKnowledgeTool } from '../knowledge/knowledgeTools.js';
import { isChatContextTool } from '../chat/chatContextToolIds.js';
import { isSystemSkillTool, runSystemSkillTool } from '../systemSkillTools.js';
import { getToolsForApp } from './appTools.js';
import {
  ACTIVATE_SKILL_TOOL_ID,
  FIND_SKILL_TOOL_ID,
  READ_SKILL_RESOURCE_TOOL_ID,
  WORKFLOW_TOOL_ID_PREFIX,
  loadTools
} from './catalog.js';

/**
 * The skill a `read_skill_resource` call that left out `skill_name` means: the
 * one skill, among the active ones and then the ones the app offers, that
 * bundles `filePath`. With no such skill, the only active skill. `null` when
 * more than one skill fits, or none does.
 *
 * @param {string} filePath - Skill-relative path
 * @param {Object} params - The tool call's parameters (`appConfig`, `user`)
 * @returns {Promise<string|null>}
 */
async function inferSkillForResource(filePath, params) {
  const active = activeSkillsOf(params.appConfig).map(entry => entry.name);
  const offered = (await describeSkillCatalog({ app: params.appConfig, user: params.user })).entries
    .map(entry => entry.name)
    .filter(name => !active.includes(name));
  for (const group of [active, offered]) {
    const bundling = [];
    for (const name of group) {
      const skill = await loadUsableSkill(name, {
        skillIds: getAssignedSkillIds(params.appConfig),
        user: params.user,
        app: params.appConfig
      });
      if (skill?.resources.includes(filePath)) bundling.push(name);
    }
    if (bundling.length === 1) return bundling[0];
    if (bundling.length > 1) return null;
  }
  return active.length === 1 ? active[0] : null;
}

/**
 * Dynamically import and run a tool implementation securely.
 * Tool implementations live in `server/tools` and export a default async function.
 *
 * @param {string} toolId - Tool identifier
 * @param {object} params - Parameters passed to the tool
 * @param {object} [options]
 * @param {Function} [options.onMcpAppResult] - For an MCP tool that renders an
 *   MCP App view: receives the raw CallToolResult (structured content, `_meta`,
 *   `isError`) the view is drawn from. The return value stays the model-facing
 *   result either way.
 * @param {AbortSignal} [options.signal] - The chat turn's abort signal. Remote
 *   A2A agents honour it: a user stop aborts the request and cancels the task.
 */
export async function runTool(toolId, params = {}, options = {}) {
  logger.info('Running tool', { component: 'ToolLoader', toolId });
  if (!isValidId(toolId)) {
    throw new Error('Invalid tool id');
  }

  // Check if this is a skill activation tool
  if (toolId === ACTIVATE_SKILL_TOOL_ID) {
    const skillName = params.skill_name;
    if (!skillName) {
      throw new Error('skill_name parameter is required');
    }
    // A skill whose instructions this turn's system prompt already carries
    // (it is active in the chat) is not loaded a second time.
    const active = activeSkillsOf(params.appConfig).find(entry => entry.name === skillName);
    if (active?.full) {
      return `Skill '${skillName}' is already active: its instructions are in the <active_skill name="${skillName}"> block of the system prompt. Follow them; there is no need to load it again.`;
    }
    // Only a skill this app (or agent node) and this user may use loads; any
    // other name gets the same answer as a missing skill.
    const skill = await loadUsableSkill(skillName, {
      skillIds: getAssignedSkillIds(params.appConfig),
      user: params.user,
      app: params.appConfig
    });
    if (!skill) {
      logger.warn('Refused to activate a skill that is not available here', {
        component: 'ToolLoader',
        skillName
      });
      return `Skill '${skillName}' not found or could not be loaded.`;
    }
    // `disable-model-invocation`: only a user starts the skill, with `/name`.
    // Once they did, it is active and its instructions may be read.
    if (!active && !isModelInvocable(skill)) {
      logger.warn('Refused to activate a skill only users may start', {
        component: 'ToolLoader',
        skillName
      });
      return `Skill '${skillName}' can only be started by the user, by writing /${skill.displayName} in a message.`;
    }
    logger.info('Activating skill', { component: 'ToolLoader', skillName });
    // Emit skill activation SSE event for UI indicators. `skillId` is what
    // the next turns of the chat keep the skill active by; `activatedBy`
    // tells them the model chose it.
    const chatId = params.chatId;
    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'skill.activation',
        message: skill.displayName,
        data: {
          skillName: skill.displayName,
          skillId: skill.name,
          activatedBy: 'model',
          description: skill.description
        }
      });
    }

    // Agent runs: persist the activated skill body to workflow state so
    // subsequent prompt nodes (planner re-iterations, task workers, the
    // synthesizer) automatically see it via the <active_skill> block.
    // Apps that aren't running under an agent workflow keep the existing
    // ephemeral tool-result-only behavior.
    const workflowState = params.appConfig?._workflowState;
    if (workflowState && workflowState.data) {
      workflowState.data._activatedSkills = workflowState.data._activatedSkills || {};
      workflowState.data._activatedSkills[skillName] = {
        body: skill.body,
        description: skill.description,
        // Persist the bundled-file paths so later workflow nodes render the
        // read_skill_resource hint in their <active_skill> block, not just the
        // body — the tool is exposed to them, the guidance must travel with it.
        resources: skill.resources,
        activatedAt: new Date().toISOString(),
        activatedBy: params.user?.isAgent ? `agent:${params.user.profileId || 'unknown'}` : 'llm'
      };
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.skill.activated',
          chatId,
          skillName,
          description: skill.description,
          activatedBy: 'llm'
        });
      } catch {
        // Best effort.
      }
    }

    let result = skill.body;
    // List the files the skill bundles, and name the tool and skill_name to
    // read them with. These are skill-relative paths, not URLs or local files:
    // a web page reader given "references/x.md" fails with "Invalid URL", so
    // steer the model to read_skill_resource explicitly.
    if (skill.resources.length > 0) {
      result += `\n\n---\nThis skill bundles these files. Read one with the read_skill_resource tool (skill_name "${skill.name}", file_path the path below), never with another web, URL or file-reading tool:\n${skill.resources
        .map(r => `- ${r}`)
        .join('\n')}`;
    }
    return result;
  }

  // Check if this is a skill resource read tool
  if (toolId === READ_SKILL_RESOURCE_TOOL_ID) {
    const { file_path: filePath } = params;
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('file_path parameter is required');
    }
    // A model that already has a skill's instructions in front of it often
    // sends only the path. Fill the name in from the skill that bundles that
    // file, rather than failing the read: the active skills first, then any
    // other skill the app offers. An ambiguous path still asks for the name.
    const skillName = params.skill_name || (await inferSkillForResource(filePath, params));
    if (!skillName) {
      throw new Error(
        `skill_name parameter is required: more than one skill could bundle '${filePath}'. Pass the name of the skill the file belongs to.`
      );
    }
    const skill = await loadUsableSkill(skillName, {
      skillIds: getAssignedSkillIds(params.appConfig),
      user: params.user,
      app: params.appConfig
    });
    if (!skill) {
      logger.warn('Refused to read a resource of a skill that is not available here', {
        component: 'ToolLoader',
        skillName
      });
      return `Resource '${filePath}' not found in skill '${skillName}' or access denied.`;
    }
    logger.info('Reading skill resource', { component: 'ToolLoader', skillName, filePath });
    const content = typeof filePath === 'string' ? await skill.readFile(filePath) : null;
    if (content === null) {
      return `Resource '${filePath}' not found in skill '${skillName}' or access denied.`;
    }
    return content;
  }

  // Search the skills the model is offered, when their list in the system
  // prompt is shortened: the same catalog, so the same access rules.
  if (toolId === FIND_SKILL_TOOL_ID) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return 'Give a few keywords that describe the task, e.g. "weekly newsletter draft".';
    }
    const { entries } = await describeSkillCatalog({ app: params.appConfig, user: params.user });
    const matches = searchSkillCatalog(entries, query);
    logger.info('Searching skills', {
      component: 'ToolLoader',
      query,
      matches: matches.length
    });
    if (matches.length === 0) {
      return `No skill matches "${query}". Try other keywords, or go ahead without a skill.`;
    }
    const lines = matches.map(entry => `- ${entry.name}: ${entry.description}`);
    return `Skills matching "${query}":\n${lines.join('\n')}\n\nCall activate_skill with a skill's name to load its instructions.`;
  }

  // Built-in tools of system skills (`create_pdf`, …). They are offered only
  // through a skill the app enables (see getToolsForApp); here a direct call
  // is checked against the user's skill permissions as well.
  if (isSystemSkillTool(toolId)) {
    const { data: userSkills } = await configCache.getSkillsForUser(
      params.user,
      configCache.getPlatform() || {}
    );
    const provided = userSkills.some(
      skill => skill.isSystem && skill.providedTools?.includes(toolId)
    );
    if (!isFeatureEnabled('skills', configCache.getFeatures()) || !provided) {
      throw new Error(`Tool ${toolId} is not available`);
    }
    return await runSystemSkillTool(toolId, params);
  }

  // App-as-tool (`app__<appId>`): invoke another iHub app through the shared
  // gateway. Runs the callee's full chat pipeline in-process (no REST hop);
  // permission, feature-flag, and nesting guards live in the gateway.
  if (toolId.startsWith('app__')) {
    const { invokeAppTool } = await import('../chat/appToolsGateway.js');
    const { chatId, user, appConfig, language, ...args } = params;
    return await invokeAppTool({
      toolId,
      args,
      user,
      chatId,
      language,
      callerAppId: appConfig?.id
    });
  }

  // Check if this is a workflow tool (starts with 'workflow_')
  if (toolId.startsWith(WORKFLOW_TOOL_ID_PREFIX)) {
    const mod = await import('../../tools/workflowRunner.js');
    return await mod.default({
      ...params,
      workflowId: toolId.slice(WORKFLOW_TOOL_ID_PREFIX.length)
    });
  }

  // The project knowledge tools belong to projects and are not in the tool
  // list: the projects feature runs them, and the implementation resolves the
  // request's project scope (`params.appConfig`, `params.user`) on every call.
  if (isKnowledgeTool(toolId)) {
    return await runKnowledgeTool(toolId, params);
  }

  // The chat context tools belong to the chat and are not in the tool list;
  // the implementation authorizes the chat with the call's own context.
  if (isChatContextTool(toolId)) {
    const { runChatContextTool } = await import('../chat/chatContextTools.js');
    return await runChatContextTool(toolId, params);
  }

  // Find tool definition to determine the script file
  const allTools = await loadTools();
  const tool = allTools.find(t => t.id === toolId);
  if (!tool) {
    throw new Error(`Tool ${toolId} not found`);
  }

  // Tools of installed integrations run through their protocol adapter.
  if (tool._integration) {
    logger.info('Dispatching integration tool call', {
      component: 'ToolLoader',
      toolId,
      instanceId: tool._integration.instanceId
    });
    const { runIntegrationTool } = await import('../integrations/integrationTools.js');
    return await runIntegrationTool(tool, params, options);
  }

  // MCP tools are dispatched through McpClientManager.callTool.
  if (tool._mcp) {
    logger.info('Dispatching MCP tool call', {
      component: 'ToolLoader',
      toolId,
      serverId: tool._mcp.serverId
    });
    return await mcpClientManager.callTool(toolId, params, {
      onRawResult: options.onMcpAppResult
    });
  }

  // Skills of remote A2A agents are dispatched through A2aClientManager.callTool.
  if (tool._a2a) {
    logger.info('Dispatching A2A agent tool call', {
      component: 'ToolLoader',
      toolId,
      agentId: tool._a2a.agentId
    });
    // `signal` is the chat turn's abort signal: a user stop ends the remote
    // request and cancels a running task.
    return await a2aClientManager.callTool(toolId, params, { signal: options.signal });
  }

  // Check if this is a special tool (like Google Search) that doesn't have a script
  if (tool.isSpecialTool) {
    // Special tools are handled by the model provider directly, not executed here
    logger.info('Special tool is handled by provider, skipping execution', {
      component: 'ToolLoader',
      toolId
    });
    return { handled_by_provider: true };
  }

  const scriptName = tool.script || `${toolId}.js`;
  if (!isValidId(scriptName.replace(/\.js$/, ''))) {
    throw new Error('Invalid script name');
  }

  try {
    // Default parameter values of the tool's schema fill what the call left out.
    return await runToolScript(scriptName, {
      method: tool.method,
      parameters: tool.parameters,
      params
    });
  } catch (error) {
    logger.error('Failed to execute tool', {
      component: 'ToolLoader',
      toolId,
      errorName: error?.name,
      errorMessage: error?.message,
      errorCode: error?.code,
      errorCause: error?.cause?.message || error?.cause,
      error
    });
    throw error;
  }
}
