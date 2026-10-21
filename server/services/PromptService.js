// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedContent } from '../../shared/localize.js';
import { renderUserMessage } from '../../shared/promptContext.js';
import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import { describeSkillCatalog, prepareActiveSkills } from './skillAccess.js';
import logger from '../utils/logger.js';
import { resolveProjectScope } from './knowledge/ProjectScope.js';
import {
  planKnowledgeScope,
  renderProjectInstructions,
  renderProjectsBlock,
  scopeSummary
} from './knowledge/KnowledgeScopePlanner.js';
import { projectSettings } from './projects/projectSettings.js';
import { hasProjectScope } from './knowledge/knowledgeTools.js';

/**
 * Module-level knowledge source tracking
 * This allows tracking of prompt-based sources that are injected before tool execution
 * @type {Map<string, Set<string>>}
 */
const promptKnowledgeSources = new Map();
// The knowledge scope (which projects, loaded or searched) of the prompt
// being built for a chat, taken by `ChatService.prepareChatRequest`.
const knowledgeScopes = new Map();

/**
 * The model behind what the request builder hands over as `modelName`: the
 * display name when the model has one, else the id. Matched on both, so a
 * model named differently from its id still brings its context window.
 *
 * @param {Object[]} models
 * @param {string|null} modelName
 * @returns {Object|null}
 */
function findModel(models, modelName) {
  if (!modelName) return null;
  const wanted = String(modelName);
  const nameOf = entry =>
    typeof entry?.name === 'object' && entry.name
      ? Object.values(entry.name)
      : [entry?.name].filter(Boolean);
  return (
    models.find(entry => entry?.id === wanted) ||
    models.find(entry => nameOf(entry).includes(wanted)) ||
    null
  );
}

/**
 * Escape regex metacharacters so arbitrary keys can be used inside `new RegExp(...)`.
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Replace all `{{key}}` occurrences in text with value, treating both as literal
 * text: the key is regex-escaped so metacharacters (e.g. from a client-supplied
 * variable name) can't throw a SyntaxError, and the value is applied via a
 * function replacer so `$&`, `$1`, etc. inside it are never reinterpreted by
 * String.replace's replacement-pattern syntax.
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function replaceTemplateVar(text, key, value) {
  return text.replace(new RegExp(String.raw`\{\{${escapeRegExp(key)}\}\}`, 'g'), () => value);
}

/**
 * Service for handling prompt processing and template resolution
 */
/**
 * ISO-8601 calendar date (YYYY-MM-DD) for `now` in `timeZone`.
 *
 * `toISOString()` would give the UTC day, which is the wrong day for anyone
 * east or west of UTC around midnight. `en-CA` renders exactly YYYY-MM-DD.
 *
 * @param {Date} now
 * @param {string} timeZone - IANA zone
 * @returns {string} e.g. "2026-09-03"
 */
/**
 * Pick a locale Intl accepts for date/time formatting. Falls back to
 * `fallback` when `language` is missing, not a BCP 47 tag (`*`), or unknown.
 */
function resolveFormattingLocale(language, fallback) {
  if (typeof language === 'string' && language.trim()) {
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([language]).length > 0) return language;
    } catch {
      // RangeError: not a structurally valid language tag
    }
  }
  return fallback;
}

function isoDateInTimeZone(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

class PromptService {
  /**
   * Track that prompt-based sources were used for a chat
   * @param {string} chatId - The conversation/chat ID
   */
  trackPromptSources(chatId) {
    if (!chatId) return;
    if (!promptKnowledgeSources.has(chatId)) {
      promptKnowledgeSources.set(chatId, new Set());
    }
    promptKnowledgeSources.get(chatId).add('sources');
    logger.info('Tracked prompt-based sources for chat', {
      component: 'PromptService',
      chatId
    });
  }

  /**
   * Get tracked prompt sources for a chat
   * @param {string} chatId - The conversation/chat ID
   * @returns {Array<string>} Array of source types used in prompts
   */
  getPromptSources(chatId) {
    if (!chatId) return [];
    const sources = promptKnowledgeSources.get(chatId);
    return sources ? Array.from(sources) : [];
  }

  /**
   * Reset tracked prompt sources for a chat
   * @param {string} chatId - The conversation/chat ID
   */
  resetPromptSources(chatId) {
    if (!chatId) return;
    promptKnowledgeSources.delete(chatId);
  }

  /**
   * Note the projects a prompt was built with (#1036), for the turn to
   * report as `knowledge/scope`.
   * @param {string} chatId
   * @param {Object} summary - `scopeSummary(plan)`
   */
  trackKnowledgeScope(chatId, summary) {
    if (!chatId || !summary) return;
    knowledgeScopes.set(chatId, summary);
  }

  /**
   * The knowledge scope noted for a chat, and forget it.
   * @param {string} chatId
   * @returns {Object|null}
   */
  takeKnowledgeScope(chatId) {
    if (!chatId) return null;
    const summary = knowledgeScopes.get(chatId) || null;
    knowledgeScopes.delete(chatId);
    return summary;
  }

  /**
   * The system prompt with the request's projects applied (spec 2 §6).
   *
   * @param {string} systemPrompt
   * @param {Object|null} app - App with its link fields (`projects`, `_projectId`, …)
   * @param {{user: Object|null, chatId: string|null, lang: string, modelName: string|null}} ctx
   * @returns {Promise<string>}
   */
  async _applyProjects(systemPrompt, app, { user, chatId, lang, modelName }) {
    const placeholder = '{{projects}}';
    const hasPlaceholder = systemPrompt.includes(placeholder);
    const scope =
      hasProjectScope(app) && user ? await resolveProjectScope({ appConfig: app, user }) : [];
    if (!scope.length) {
      return hasPlaceholder ? systemPrompt.replace(placeholder, () => '') : systemPrompt;
    }
    const platform = configCache.getPlatform() || {};
    const plan = await planKnowledgeScope(scope, {
      model: findModel(configCache.getModels?.()?.data || [], modelName),
      settings: projectSettings(platform),
      ctx: { user, chatId, language: lang, purpose: 'chat' }
    });
    const instructions = renderProjectInstructions(plan);
    const block = renderProjectsBlock(plan);
    let out = systemPrompt;
    if (instructions) out = out.trim() ? `${out}\n\n${instructions}` : instructions;
    if (hasPlaceholder) out = out.replace(placeholder, () => block);
    else if (block) out += `\n\nProjects:\n${block}`;
    // Any injected text — a whole project or the pinned documents of a
    // searched one — can ground the answer without a tool call.
    if (plan.projects.some(project => project.injected.length)) {
      this.trackPromptSources(chatId);
    }
    this.trackKnowledgeScope(chatId, scopeSummary(plan));
    logger.info('Projects applied to the prompt', {
      component: 'PromptService',
      chatId,
      projects: plan.projects.map(project => `${project.id}:${project.mode}`).join(','),
      tokens: plan.usedTokens
    });
    return out;
  }

  /**
   * Resolve global prompt variables that should be automatically available in prompts
   * @param {object} user - User object from request
   * @param {string} modelName - Name of the model being used
   * @param {string} language - Current language setting
   * @param {string} style - Current style/tone setting
   * @returns {object} Object containing global prompt variables
   */
  resolveGlobalPromptVariables(user = null, modelName = null, language = null, style = null) {
    const now = new Date();
    const platformConfig = configCache.getPlatform() || {};

    // Get timezone from user or default to UTC
    const timezone = user?.timezone || user?.settings?.timezone || 'UTC';

    // Create timezone-aware date formatter.
    // `dateStyle: 'full'` on purpose: the default numeric style renders
    // 2026-09-03 as "9/3/2026" under `en`, which a model reading a German
    // conversation takes for 9 March — six months off, and indistinguishable
    // from a correct answer. The spelled-out form ("Thursday, September 3,
    // 2026" / "Donnerstag, 3. September 2026") cannot be misread whichever
    // locale it is rendered in, and `date_iso` below is the unambiguous
    // machine form for prompts that want to compare dates.
    const tzOptions = { timeZone: timezone };
    const defaultLang = platformConfig.defaultLanguage || 'en';
    // Clients may send a language that is not a BCP 47 tag (Node's fetch sends
    // `Accept-Language: *`); Intl throws on those, which used to fail the whole
    // chat request. Fall back to the platform default instead.
    const locale = resolveFormattingLocale(language, defaultLang);
    const dateFormatter = new Intl.DateTimeFormat(locale, {
      ...tzOptions,
      dateStyle: 'full'
    });
    const timeFormatter = new Intl.DateTimeFormat(locale, {
      ...tzOptions,
      timeStyle: 'medium'
    });

    const globalPromptVars = {
      // Date and time variables
      year: now.getFullYear().toString(),
      month: (now.getMonth() + 1).toString().padStart(2, '0'),
      date: dateFormatter.format(now),
      /** ISO-8601 calendar date in the resolved timezone — never ambiguous. */
      date_iso: isoDateInTimeZone(now, timezone),
      time: timeFormatter.format(now),
      day_of_week: now.toLocaleDateString(language || defaultLang, {
        ...tzOptions,
        weekday: 'long'
      }),

      // Locale and timezone
      timezone: timezone,
      locale: language || platformConfig.defaultLanguage || 'en',

      // User information (only if user is authenticated)
      user_name: user?.name || user?.displayName || '',
      user_email: user?.email || '',

      // Model information
      model_name: modelName || '',

      // Style/tone setting
      tone: style || '',

      // Location (from user profile if available)
      location: user?.location || user?.settings?.location || ''
    };

    // Process platform context to resolve nested variables
    let platformContext = platformConfig.globalPromptVariables?.context || '';
    if (platformContext) {
      // Replace variables in platform_context with their resolved values
      for (const [key, value] of Object.entries(globalPromptVars)) {
        if (value !== null && value !== undefined && value !== '') {
          platformContext = replaceTemplateVar(platformContext, key, String(value));
        }
      }
    }

    // Add processed platform_context to global vars
    globalPromptVars.platform_context = platformContext;

    // Add custom variables from platform config
    const customVariables = platformConfig.globalPromptVariables?.variables || {};
    for (const [key, value] of Object.entries(customVariables)) {
      // Custom variables can override built-in ones if desired, but built-in takes precedence by default
      if (!globalPromptVars.hasOwnProperty(key)) {
        globalPromptVars[key] = value;
      }
    }

    // Filter out empty values to avoid replacing with empty strings unintentionally
    const filteredVars = {};
    for (const [key, value] of Object.entries(globalPromptVars)) {
      if (value !== null && value !== undefined && value !== '') {
        filteredVars[key] = value;
      }
    }

    return filteredVars;
  }

  /**
   * Replace {{variable}} placeholders in a text with the given values.
   * Unknown placeholders are left intact — the same semantics as system
   * prompt processing, so a typo shows up literally instead of vanishing.
   * @param {string} text - Text containing {{variable}} placeholders
   * @param {Object} variables - Variable name/value map (e.g. from resolveGlobalPromptVariables)
   * @returns {string} Text with known placeholders replaced
   */
  substituteVariables(text, variables) {
    if (!text || typeof text !== 'string' || !text.includes('{{')) {
      return text;
    }
    let result = text;
    for (const [key, value] of Object.entries(variables || {})) {
      if (value === null || value === undefined) continue;
      result = replaceTemplateVar(result, key, String(value));
    }
    return result;
  }

  /**
   * Process message templates with variable substitution and source content
   * @param {Array} messages - Array of messages to process
   * @param {Object} app - App configuration object
   * @param {string} style - Style/tone setting
   * @param {string} outputFormat - Output format preference
   * @param {string} language - Language setting
   * @param {Object} outputSchema - Output schema for structured responses
   * @param {Object} user - User object
   * @param {string} chatId - Chat identifier
   * @param {string} modelName - Model name
   * @param {string[]} [requestedSkills] - Skills to pre-activate (slash command)
   * @param {Object} [preparedSkills] - The turn's active skills from
   *   `prepareActiveSkills`, when the caller resolved them already (it needs
   *   them for the tools as well); resolved here otherwise
   * @returns {Array} Processed messages array
   */
  async processMessageTemplates(
    messages,
    app,
    style = null,
    outputFormat = null,
    language,
    outputSchema = null,
    user = null,
    chatId = null,
    modelName = null,
    requestedSkills = null,
    preparedSkills = null
  ) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    const lang = language || defaultLang;
    logger.info('Using language for message templates', { component: 'PromptService', lang });

    // Resolve global prompt variables once for use throughout the function
    const globalPromptVariables = this.resolveGlobalPromptVariables(user, modelName, lang, style);
    logger.info('Resolved global prompt variables', {
      component: 'PromptService',
      count: Object.keys(globalPromptVariables).length
    });

    const applyGlobalVariables = text => {
      let out = text;
      for (const [key, value] of Object.entries(globalPromptVariables || {})) {
        const strValue = typeof value === 'string' ? value : String(value || '');
        out = replaceTemplateVar(out, key, strValue);
      }
      return out;
    };

    let llmMessages = [...messages].map(msg => {
      if (msg.role !== 'user') {
        const processedMsg = {
          role: msg.role,
          content: typeof msg.content === 'string' ? applyGlobalVariables(msg.content) : msg.content
        };
        if (msg.imageData) processedMsg.imageData = msg.imageData;
        if (msg.fileData) processedMsg.fileData = msg.fileData;
        if (msg.audioData) processedMsg.audioData = msg.audioData;
        return processedMsg;
      }

      // The user's message: host context (email, meeting, page) and uploaded
      // files become tagged blocks around the typed text — see
      // shared/promptContext.js. Only the typed text of a message without an
      // app template has global variables applied; the blocks are source
      // material and reach the model as written.
      const templated = Boolean(msg.promptTemplate && msg.variables);
      const typed = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
      const body = renderUserMessage({
        content: templated ? typed : applyGlobalVariables(typed),
        hostContext: msg.hostContext,
        files: msg.fileData
      });

      let processedContent = body;
      if (templated) {
        processedContent =
          typeof msg.promptTemplate === 'object'
            ? getLocalizedContent(msg.promptTemplate, lang)
            : msg.promptTemplate;
        if (typeof processedContent !== 'string') processedContent = String(processedContent || '');
        // Combine user-defined variables with global prompt variables (user
        // variables take precedence). The message goes in last and through a
        // function replacer: "{{...}}" placeholders and dollar patterns inside
        // an email body or a document are literal text — never re-expanded,
        // never interpreted by String.replace.
        const { content: _contentVariable, ...variables } = {
          ...globalPromptVariables,
          ...msg.variables
        };
        for (const [key, value] of Object.entries(variables)) {
          const strValue = typeof value === 'string' ? value : String(value || '');
          processedContent = replaceTemplateVar(processedContent, key, strValue);
        }
        processedContent = processedContent.replaceAll('{{content}}', () => body);
        // A template without {{content}} (in this language) still gets the
        // message, appended, so what the user sent is never lost.
        if (body.trim() && !processedContent.includes(body)) {
          processedContent = processedContent.trim() ? `${processedContent}\n\n${body}` : body;
        }
      }

      const processedMsg = { role: 'user', content: processedContent };
      if (msg.imageData) processedMsg.imageData = msg.imageData;
      if (msg.fileData) processedMsg.fileData = msg.fileData;
      if (msg.audioData) processedMsg.audioData = msg.audioData;
      return processedMsg;
    });

    // The conversation's app variables are the newest set a user message
    // carried: a follow-up that sets none keeps the ones the chat started
    // with. (A stored chat's are attached to the new message by the route.)
    const variablesMessage = messages.findLast(
      msg =>
        msg.role === 'user' &&
        msg.variables &&
        typeof msg.variables === 'object' &&
        Object.keys(msg.variables).length > 0
    );
    const userVariables = variablesMessage ? variablesMessage.variables : {};

    if (app && !llmMessages.some(msg => msg.role === 'system')) {
      let systemPrompt =
        typeof app.system === 'object' ? getLocalizedContent(app.system, lang) : app.system || '';
      if (typeof systemPrompt !== 'string') systemPrompt = String(systemPrompt || '');

      // Does the app place the temporal context itself? Checked on the RAW
      // template, before substitution replaces the placeholders away.
      const placesTemporalContext = /\{\{(platform_context|date|year|day_of_week)\}\}/.test(
        systemPrompt
      );

      // Combine user variables with global prompt variables for system prompt processing
      const allVariables = { ...globalPromptVariables, ...userVariables };
      if (Object.keys(allVariables).length > 0) {
        for (const [key, value] of Object.entries(allVariables)) {
          if (typeof value === 'function' || (typeof value === 'object' && value !== null))
            continue;
          const strValue = String(value || '');
          systemPrompt = replaceTemplateVar(systemPrompt, key, strValue);
        }
      }

      // Temporal grounding. An app that does not position the context itself
      // gets it prepended, so every chat app knows the current date instead of
      // falling back to training-era "today" - the same grounding workflow
      // nodes get from BaseNodeExecutor.buildTemporalContextBlock. Mirrors the
      // {{sources}} pattern below: honour an explicit placeholder, otherwise
      // inject. Admins switch this off by clearing
      // platform.globalPromptVariables.context.
      const temporalContext =
        typeof globalPromptVariables.platform_context === 'string'
          ? globalPromptVariables.platform_context.trim()
          : '';
      if (!placesTemporalContext && temporalContext) {
        systemPrompt = systemPrompt.trim()
          ? `${temporalContext}\n\n${systemPrompt}`
          : temporalContext;
      }

      // Projects (#1036): the projects the request reaches — linked on the
      // app, the chat's container, attached from the picker — loaded in full
      // or left to the knowledge tools (spec 2 §6). Their instructions go
      // before the knowledge block; the block replaces `{{projects}}` or is
      // appended, exactly as sources were.
      try {
        systemPrompt = await this._applyProjects(systemPrompt, app, {
          user,
          chatId,
          lang,
          modelName
        });
      } catch (error) {
        logger.error('Error applying the projects of the request', {
          component: 'PromptService',
          error
        });
        throw new Error(`Failed to process projects: ${error.message}`);
      }

      // Skills: list the skills the model may activate (name + description,
      // within the platform's token budget), then add the skills active in
      // this turn: the ones the request names in `requestedSkills`, the ones
      // the message invokes with `/name`, and the ones earlier turns of the
      // chat activated. Both only ever hold skills this app and this user may
      // use: the app's assigned, granted global skills and the user's own and
      // shared user skills (unless the app opts out of those).
      if (isFeatureEnabled('skills', configCache.getFeatures())) {
        try {
          const catalog = await describeSkillCatalog({ app, user });
          if (catalog.text) {
            systemPrompt += `\n\n${catalog.text}`;
            logger.info('Injected skills into system prompt for app', {
              component: 'PromptService',
              skillCount: catalog.entries.length,
              listed: catalog.listed,
              compact: catalog.compact,
              appId: app.id
            });
          }

          const active =
            preparedSkills ||
            (await prepareActiveSkills({ messages, requested: requestedSkills, app, user }));
          if (active.text) {
            systemPrompt += `\n\n${active.text}`;
            logger.info('Active skills for this turn', {
              component: 'PromptService',
              skills: active.skills.map(skill => skill.name),
              deferred: active.skills.filter(skill => !skill.full).map(skill => skill.name)
            });
          }
        } catch (error) {
          logger.error('Error loading skills for system prompt', {
            component: 'PromptService',
            error
          });
        }
      }

      if (style) {
        try {
          // Try to get styles from cache first
          let styles = configCache.getStyles();

          if (styles && styles[style] && style !== 'keep') {
            systemPrompt += `\n\n${styles[style]}`;
          } else {
            logger.info('No specific style found, nothing added to system prompt', {
              component: 'PromptService',
              style
            });
          }
        } catch (error) {
          logger.error('Error loading styles', { component: 'PromptService', error });
        }
      }

      if (outputFormat === 'markdown') {
        systemPrompt +=
          '\n\nPlease format your response using Markdown syntax for better readability.';
      } else if (outputFormat === 'html') {
        systemPrompt +=
          '\n\nPlease format your response using HTML tags for better readability and structure.';
      } else if (outputFormat === 'json' || outputSchema) {
        systemPrompt += '\n\nRespond only with valid JSON.';
        if (outputSchema) {
          const schemaStr = JSON.stringify(outputSchema);
          systemPrompt += ` The JSON must match this schema: ${schemaStr}`;
        }
      }

      llmMessages.unshift({ role: 'system', content: systemPrompt });
    }

    return llmMessages;
  }
}

// Export a singleton instance
export default new PromptService();
