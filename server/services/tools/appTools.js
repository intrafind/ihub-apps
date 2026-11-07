// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tools an app offers a chat: the tools of the integrations it binds
 * (`app.integrations`), and the ones its skills, workflows, knowledge projects
 * and web search add.
 */

import configCache from '../../configCache.js';
import { describeSkillCatalog, getUsableSkills, skillsEnabledIn } from '../skillAccess.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isInteractiveTool, isToolSelected } from '../../utils/toolSelection.js';
import { installedIntegrationById } from '../integrations/installedRefs.js';
import { stampToolApproval } from '../../utils/toolApproval.js';
import { filterDirectoryToolsForUser } from '../peopleDirectory/PeopleDirectoryService.js';
import { filterBrowserToolsForUser } from '../peopleDirectory/LdapBrowserService.js';
import { isWebSearchEngineTool } from '../search/webSearchEngines.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';
import { filterSchedulingTools } from '../scheduler/tasks/toolGate.js';
import { hasProjectScope, knowledgeToolsFor } from '../knowledge/knowledgeTools.js';
import { mentionAccess } from '../workflow/workflowAccess.js';
import { systemSkillToolsFor, usesDocumentTemplates } from '../systemSkillTools.js';
import {
  ACTIVATE_SKILL_TOOL_ID,
  FIND_SKILL_TOOL_ID,
  READ_SKILL_RESOURCE_TOOL_ID,
  WORKFLOW_TOOL_ID_PREFIX,
  filterIntegrationToolsForUser,
  loadTools
} from './catalog.js';
import { resolveWebsearchTool } from './webSearchResolver.js';
import { isPlatformTool } from './platformTools.js';

/**
 * Build JSON Schema parameters from a workflow's start node inputVariables
 * @param {Object} workflow - Workflow definition
 * @returns {Object} JSON Schema parameters object
 */
function buildWorkflowToolParams(workflow, language = 'en') {
  const properties = {
    input: {
      type: 'string',
      description: 'The user message or primary input for the workflow'
    }
  };
  const required = ['input'];

  // Extract input variables from the start node config
  const startNode = (workflow.nodes || []).find(n => n.type === 'start');
  const inputVariables = startNode?.config?.inputVariables;

  if (Array.isArray(inputVariables)) {
    for (const varDef of inputVariables) {
      if (typeof varDef === 'string') {
        if (varDef !== 'input') {
          properties[varDef] = { type: 'string', description: varDef };
        }
      } else if (varDef && varDef.name && varDef.name !== 'input') {
        // Skip file/image variables — they are injected via _fileData/inputFiles,
        // not passed as tool parameters by the LLM
        if (varDef.type === 'file' || varDef.type === 'image') {
          continue;
        }

        const VALID_JSON_SCHEMA_TYPES = new Set([
          'string',
          'number',
          'integer',
          'boolean',
          'array',
          'object'
        ]);
        const CUSTOM_TYPE_MAP = {
          file: 'string',
          select: 'string',
          multiselect: 'array',
          date: 'string',
          textarea: 'string'
        };

        const rawType = varDef.type || 'string';
        const schemaType = VALID_JSON_SCHEMA_TYPES.has(rawType)
          ? rawType
          : CUSTOM_TYPE_MAP[rawType] || 'string';

        const descriptionRaw = varDef.description || varDef.name;
        const prop = {
          type: schemaType,
          description:
            typeof descriptionRaw === 'string'
              ? descriptionRaw
              : getLocalizedString(descriptionRaw, language)
        };

        // Enrich select types with enum values so the LLM knows valid choices
        if (varDef.type === 'select' && Array.isArray(varDef.options)) {
          prop.enum = varDef.options
            .map(o => (typeof o === 'string' ? o : o.value))
            .filter(Boolean);
        }

        properties[varDef.name] = prop;
        if (varDef.required) {
          required.push(varDef.name);
        }
      }
    }
  }

  return {
    type: 'object',
    properties,
    required
  };
}

/**
 * Most skill names the skill tools list as allowed values. A longer list costs
 * more tokens in every request than it saves; the call is checked anyway.
 */
export const MAX_SKILL_NAME_ENUM = 100;

/**
 * Get tools applicable to a specific app: the tools of the integrations it
 * binds under `app.integrations` (the group's grant of the installation plus
 * the binding's action list), and the ones its web search, projects, chat,
 * workflows, apps and skills add. An app has no tool list of its own (#3275).
 *
 * @param {Object} app - app configuration object
 * @param {string} language - Optional language for localization
 * @param {Object} context - Context object (user, chatId, etc.) for source tool generation
 */
export async function getToolsForApp(app, language = null, context = {}) {
  return offeredTools(app, language, context, null);
}

/**
 * Get the tools of a workflow node or an agent run: the integrations it binds
 * (`node.integrations`, like an app), the platform tools it names
 * (`node.systemTools`: the agent workspace, the evidence tools, the page
 * reader — plain tools of workflows and agents, not integrations) and the
 * search tool of a web search engine it was resolved to (`engineToolIds`).
 * Everything `getToolsForApp` adds for an app comes along (project knowledge,
 * skills).
 *
 * @param {Object} node - `{ integrations, systemTools, engineToolIds, projects, skills, _skillIds }`
 * @param {string|null} language
 * @param {Object} context - `{ user, chatId }`
 */
export async function getToolsForNode(node = {}, language = null, context = {}) {
  return offeredTools(node, language, context, {
    systemToolIds: Array.isArray(node.systemTools) ? node.systemTools : [],
    engineToolIds: Array.isArray(node.engineToolIds) ? node.engineToolIds : []
  });
}

async function offeredTools(app, language, context, nodeTools) {
  // Get static tools from tool definitions
  const allTools = await loadTools(language);
  let appTools = [];

  if (nodeTools) {
    // The platform tools a node names, by exact id or base id (`evidence`
    // selects `evidence_*`), and the search tool of its web search engine,
    // while the installation's own enabled and group-grant checks pass.
    const systemTools = allTools.filter(
      t => !t._integration && isPlatformTool(t.id) && isToolSelected(t, nodeTools.systemToolIds)
    );
    const engineTools = await filterIntegrationToolsForUser(
      allTools.filter(t => isWebSearchEngineTool(t) && nodeTools.engineToolIds.includes(t.id)),
      context.user
    );
    appTools = [...systemTools, ...engineTools];
  }

  // Tools of the installed integrations the app binds under `app.integrations`
  // (#3061). The chat's narrowing applies to them like to any other tool.
  if (app.integrations && typeof app.integrations === 'object') {
    try {
      const { getIntegrationToolsForApp, isBoundToolEnabled } =
        await import('../integrations/integrationTools.js');
      // An LDAP browser's own rules (signed-in, non-delegated users, its
      // directory enabled) hold on top of the binding and the group grant.
      let bound = filterBrowserToolsForUser(
        filterDirectoryToolsForUser(
          getIntegrationToolsForApp(app, allTools, context),
          context.user
        ),
        context.user
      );
      if (Array.isArray(context.enabledTools)) {
        // By the key the app binds it with, too: a definition id or a type
        // key (`type:storage`) is what the chat's tools menu sends for it.
        // Interactive clarification tools (`ask_user`, anything
        // `requiresUserInput`) are a system channel the loop drives, not a
        // user-selectable capability, so an app that binds one keeps it
        // whatever the chat's narrowing says — otherwise disabling it (or a
        // stale saved selection that predates it) strips the model's only way
        // to ask a question, and the interview loops instead of pausing for
        // the user.
        bound = bound.filter(
          t => isInteractiveTool(t) || isBoundToolEnabled(app, t, context.enabledTools)
        );
      }
      appTools = appTools.concat(bound.filter(t => !appTools.some(a => a.id === t.id)));
    } catch (error) {
      logger.error('Error adding integration tools', { component: 'ToolLoader', error });
    }
  }

  // Inject websearch tool resolved from app.websearch config + model provider
  const websearchTools = resolveWebsearchTool(
    app,
    context.modelProvider,
    allTools,
    context.websearchEnabled,
    context.model,
    context.user
  );
  // A node may also name the page reader in its tool list — offer it only once.
  appTools = appTools.concat(websearchTools.filter(t => !appTools.some(a => a.id === t.id)));

  // Add the project knowledge tools when the projects feature is on and the
  // request reaches a project (#1036): one shipped definition, a scope per
  // request in its description. They belong to projects, so no integration
  // binding adds or removes them.
  if (hasProjectScope(app) && context.user) {
    try {
      const knowledgeTools = await knowledgeToolsFor({
        app,
        user: context.user,
        language
      });
      appTools = appTools.concat(knowledgeTools.filter(t => !appTools.some(a => a.id === t.id)));
    } catch (error) {
      logger.error('Error adding the knowledge tools', { component: 'ToolLoader', error });
    }
  }

  // Add the chat context tools — the sources, files and created files of
  // earlier turns — for the kinds the stored chat has (`context.chatContext`,
  // from `chatContextInventory`). Like the knowledge tools they belong to the
  // chat, not to a tool list. Loaded lazily: the chat repository must not join
  // the config cache's import graph.
  if (context.chatContext) {
    try {
      const { chatContextToolsFor } = await import('../chat/chatContextTools.js');
      const chatTools = chatContextToolsFor({ inventory: context.chatContext, language });
      appTools = appTools.concat(chatTools.filter(t => !appTools.some(a => a.id === t.id)));
    } catch (error) {
      logger.error('Error adding the chat context tools', { component: 'ToolLoader', error });
    }
  }

  // Add workflow tools (from dedicated app.workflows array)
  if (Array.isArray(app.workflows)) {
    for (const wfId of app.workflows) {
      try {
        if (typeof wfId !== 'string' || !wfId) continue;
        const wf = configCache.getWorkflowById(wfId);
        if (!wf || wf.enabled === false || !wf.chatIntegration?.enabled) continue;
        // The model acts for the person who chats, so it is only offered what
        // that person may run: the same rule as an `@mention` of the workflow.
        // The runner holds the line again when the tool is called.
        if (!mentionAccess({ user: context.user, app, workflow: wf }).allowed) continue;

        let toolDescription = getLocalizedString(
          wf.chatIntegration?.toolDescription || wf.description,
          language || 'en'
        );
        const toolName = getLocalizedString(wf.name, language || 'en');

        // If the workflow has file/image input variables, hint that attached files
        // are passed automatically so the LLM knows to call this tool
        const startNode = (wf.nodes || []).find(n => n.type === 'start');
        const hasFileInputs = (startNode?.config?.inputVariables || []).some(
          v => v.type === 'file' || v.type === 'image'
        );
        if (hasFileInputs) {
          toolDescription +=
            ' Any files attached to the user message are passed to this tool automatically.';
        }

        appTools.push({
          id: `${WORKFLOW_TOOL_ID_PREFIX}${wfId}`,
          name: toolName,
          description: toolDescription,
          script: 'workflowRunner.js',
          isWorkflowTool: true,
          workflowId: wfId,
          passthrough: true,
          parameters: buildWorkflowToolParams(wf, language || 'en')
        });
      } catch (error) {
        logger.error('Error generating workflow tool', {
          component: 'ToolLoader',
          workflowId: wfId,
          error
        });
      }
    }
  }

  // App-as-tool: surface other apps as synthetic `app__<id>` tools (the
  // "concierge" pattern — a bot delegating to specialist bots). Skipped for
  // principals that are themselves serving an app-as-tool call, so App→App
  // chains stop at one level of nesting.
  if (
    Array.isArray(app.apps) &&
    app.apps.length > 0 &&
    context.user?.isInvokedViaAppAsTool !== true &&
    isFeatureEnabled('appAsTool', configCache.getFeatures())
  ) {
    try {
      const { getAppAsTools } = await import('../chat/appToolsGateway.js');
      // Never expose an app to itself — a direct self-call can only loop.
      const targetAppIds = app.apps.filter(id => typeof id === 'string' && id && id !== app.id);
      const appAsTools = await getAppAsTools(targetAppIds, language || 'en', {
        user: context.user
      });
      appTools = appTools.concat(appAsTools);
    } catch (error) {
      logger.error('Error generating app-as-tool tools', {
        component: 'ToolLoader',
        appId: app.id,
        error
      });
    }
  }

  // Skill tools, while the skills feature is on and the app turned skills on
  // (`skillSettings.enabled`). `activate_skill` and
  // `read_skill_resource` come when there is a skill to load: one the model is
  // offered (the list in the system prompt) or one active in this turn
  // (`context.activeSkills`); their names are the only values the tools take.
  // `find_skill` comes when that list is shortened to fit its token budget.
  // A system skill (e.g. `pdf`) also brings built-in tools (`create_pdf`):
  // they come with the usable global skills.
  if (isFeatureEnabled('skills', configCache.getFeatures()) && skillsEnabledIn(app)) {
    const lang = language || 'en';
    const catalog = await describeSkillCatalog({ app, user: context.user });
    const active = Array.isArray(context.activeSkills) ? context.activeSkills : [];
    const skillNames = [
      ...new Set([...catalog.entries.map(entry => entry.name), ...active.map(skill => skill.name)])
    ];
    if (skillNames.length > 0) {
      const skillNameParameter = description => ({
        type: 'string',
        description,
        ...(skillNames.length <= MAX_SKILL_NAME_ENUM ? { enum: skillNames } : {})
      });
      const activateDesc = {
        en: 'Load the full instructions for a skill when it is relevant to the current task. Call this when you identify a task that matches an available skill from the <available_skills> list.',
        de: 'Lade die vollständigen Anweisungen für einen Skill, wenn er für die aktuelle Aufgabe relevant ist.'
      };
      const readDesc = {
        en: 'Read a referenced file from an activated skill (scripts, references, assets).',
        de: 'Lese eine referenzierte Datei aus einem aktivierten Skill.'
      };

      appTools.push({
        id: ACTIVATE_SKILL_TOOL_ID,
        name: getLocalizedString({ en: 'Activate Skill', de: 'Skill aktivieren' }, lang),
        description: getLocalizedString(activateDesc, lang),
        isInternalTool: true,
        parameters: {
          type: 'object',
          properties: {
            skill_name: skillNameParameter('The name of the skill to activate')
          },
          required: ['skill_name']
        }
      });

      appTools.push({
        id: READ_SKILL_RESOURCE_TOOL_ID,
        name: getLocalizedString({ en: 'Read Skill Resource', de: 'Skill-Ressource lesen' }, lang),
        description: getLocalizedString(readDesc, lang),
        isInternalTool: true,
        parameters: {
          type: 'object',
          properties: {
            skill_name: skillNameParameter('The name of the skill whose resource to read'),
            file_path: {
              type: 'string',
              description:
                "Relative path from the skill root, e.g. 'references/REFERENCE.md' or 'scripts/extract.py'"
            }
          },
          required: ['skill_name', 'file_path']
          // The server still resolves a missing skill_name from the path.
        }
      });

      if (catalog.compact) {
        appTools.push({
          id: FIND_SKILL_TOOL_ID,
          name: getLocalizedString({ en: 'Find Skill', de: 'Skill suchen' }, lang),
          description: getLocalizedString(
            {
              en: 'Search the available skills by keywords and get the full description of the best matches. Use it when the <available_skills> list is shortened and none of the listed names clearly fits the task.',
              de: 'Durchsuche die verfügbaren Skills nach Stichworten und erhalte die vollständige Beschreibung der besten Treffer.'
            },
            lang
          ),
          isInternalTool: true,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'A few keywords for the task, e.g. "weekly newsletter draft"'
              }
            },
            required: ['query']
          }
        });
      }
    }

    const appSkills = await getUsableSkills({ skillIds: app.skills, user: context.user });
    // The document skills' tools follow the app's document template.
    const templates = usesDocumentTemplates(appSkills)
      ? await (
          await import('../documents/templates/DocumentTemplateService.js')
        ).documentTemplateContext({ app, language: lang })
      : null;
    const skillTools = systemSkillToolsFor(appSkills, {
      language: lang,
      model: context.model,
      templates
    });
    appTools = appTools.concat(skillTools.filter(t => !appTools.some(a => a.id === t.id)));
  }

  // The scheduling tools are listed by the apps that offer them, but only
  // reach a user who may use scheduled tasks — and a scheduled run never gets
  // the ones that would let a task create, delete or start tasks.
  //
  // Every tool leaves stamped with its approval policy (#2945): `approval`,
  // `sideEffect`, `dataFlow` and `approvalSource`, resolved from the platform
  // default, the tool or installation, the action and this app. The approval
  // seam of the chat, workflow nodes and scheduled runs reads the stamp.
  return stampToolApproval(
    filterSchedulingTools(appTools, context.user),
    app,
    configCache.getPlatform?.() || null,
    { getInstallation: installedIntegrationById }
  );
}
