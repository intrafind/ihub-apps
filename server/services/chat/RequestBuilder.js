import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { getToolsForApp, resolveAppNativeWebSearch } from '../../toolLoader.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import { filterResourcesByPermissions } from '../../utils/authorization.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { normalizeFiles } from '../../../shared/promptContext.js';
import { describeAttachments, normalizeAttachments } from '../mcp/mcpFileInputs.js';

/**
 * Attach the page images of image-based PDFs to their message.
 *
 * The text of every upload is already in the message: `processMessageTemplates`
 * renders each file as a <content type="document"> block (shared/promptContext.js). A document
 * without extractable text contributes its rendered pages, which travel as
 * `imageData` so each adapter can format them for its provider — next to any
 * image the user uploaded directly.
 */
function attachDocumentPageImages(messages) {
  return messages.map(msg => {
    const pageImages = normalizeFiles(msg.fileData)
      .filter(file => !file.content && Array.isArray(file.pageImages))
      .flatMap(file => file.pageImages.map(img => ({ base64: img, fileType: 'image/jpeg' })));
    if (pageImages.length === 0) return msg;
    const existing = Array.isArray(msg.imageData)
      ? msg.imageData
      : msg.imageData
        ? [msg.imageData]
        : [];
    return { ...msg, imageData: [...existing, ...pageImages] };
  });
}

/**
 * Tell the model which attachments it can hand to a tool with file inputs.
 *
 * The model learns document names only from the `<content type="document">`
 * blocks and never sees an image's name, so a tool with a `format: "file"`
 * parameter could not be called reliably. When the turn offers such a tool and
 * the message carries attachments, the last user message gets one line per
 * attachment, numbered the way `attachment:<n>` references count them. Turns
 * without a file-input tool are left untouched.
 *
 * @param {Array} llmMessages - Prepared messages (mutated in place)
 * @param {Array} tools - The turn's tool definitions
 * @param {Array<Object>} userAttachments - The last user message's attachments
 * @returns {boolean} true when a note was appended
 */
export function appendAttachmentNote(llmMessages, tools, userAttachments) {
  if (!Array.isArray(userAttachments) || userAttachments.length === 0) return false;
  if (!(tools || []).some(tool => tool?._mcp?.fileInputs?.length)) return false;
  const lastUserMsg = [...llmMessages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg || typeof lastUserMsg.content !== 'string') return false;

  const note = [
    'Attachments of this message. A tool parameter that takes a file accepts the file ' +
      'name or the attachment:<n> reference:',
    ...describeAttachments(userAttachments)
  ].join('\n');
  lastUserMsg.content = lastUserMsg.content ? `${lastUserMsg.content}\n\n${note}` : note;
  return true;
}

/**
 * When an app supports web search but it is disabled for this turn, append a
 * short directive to the system prompt clarifying that web search is
 * unavailable. Apps that advertise web search generally instruct the model to
 * "use the web search tool"; without this note the model is told to call a tool
 * that isn't in the request, which can produce empty/malformed responses (e.g.
 * Gemini's MALFORMED_FUNCTION_CALL). No-op when web search is on for the turn,
 * when the app has no web search configured, or when there is no system message
 * to amend.
 *
 * @param {Array} llmMessages - Prepared messages (mutated in place)
 * @param {Object} app - App configuration
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use app default
 * @returns {boolean} true when a notice was appended
 */
export function appendWebSearchDisabledNotice(llmMessages, app, websearchEnabled) {
  if (!app?.websearch?.enabled) return false;

  const enabledByDefault = app.websearch.enabledByDefault ?? false;
  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (effectiveEnabled) return false;

  const systemMessage = llmMessages.find(m => m.role === 'system');
  if (!systemMessage || typeof systemMessage.content !== 'string') return false;

  const notice =
    'Note: Web search is currently turned off for this conversation, so you cannot ' +
    'search the web or browse external websites right now. Answer using your existing ' +
    'knowledge and do not attempt to call a web search tool or claim that you are ' +
    'searching the web.';

  if (systemMessage.content.includes(notice)) return false;

  systemMessage.content = systemMessage.content ? `${systemMessage.content}\n\n${notice}` : notice;
  logger.info('Appended web-search-disabled notice to system prompt', {
    component: 'RequestBuilder',
    appId: app.id
  });
  return true;
}

/**
 * Default research guidance appended to the system prompt when web search is
 * on for the turn. The loop allows several tool rounds per turn, but models do
 * the minimum they are asked for: without this, a web search chat typically
 * runs one search and answers. Admins can replace or turn it off per app via
 * `websearch.researchGuidance`.
 */
export const DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE =
  'Web search research: web search is available for this conversation, and you can search ' +
  'several times before answering. When a question needs current or external information:\n' +
  '- Break the question into its sub-questions.\n' +
  '- Run several searches with different wording (and in another language where that ' +
  'helps), not just one.\n' +
  '- When results are thin or disagree, search again with more precise terms before ' +
  'answering.\n' +
  '- When the search excerpts are not enough, open the most relevant pages and read them ' +
  'in full.\n' +
  '- Check key claims against more than one source.\n' +
  '- Combine the findings into one answer and cite the sources with their URLs.\n' +
  '- Stop searching once the question is answered, and do not search for things you ' +
  'already know reliably.';

/**
 * Resolve the research guidance text configured for an app.
 * `websearch.researchGuidance` is `true`/unset (default text), `false` (off) or a
 * custom string (replaces the default; blank falls back to the default).
 *
 * @param {Object} app - App configuration
 * @returns {string|null} guidance text, or null when turned off
 */
export function resolveWebSearchResearchGuidance(app) {
  const setting = app?.websearch?.researchGuidance;
  if (setting === false) return null;
  if (typeof setting === 'string' && setting.trim()) return setting.trim();
  return DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE;
}

/**
 * Positive counterpart of {@link appendWebSearchDisabledNotice}: when web search
 * is on for this turn, append guidance telling the model to research in several
 * steps (several searches, then combine) instead of answering after one search.
 * No-op when web search is off for the turn, when the app has no web search
 * configured, when the app turned the guidance off, when there is no system
 * message to amend, or when the guidance is already there.
 *
 * With Google native search the adapter drops all function tools, so the
 * guidance only steers Gemini's own grounding there.
 *
 * @param {Array} llmMessages - Prepared messages (mutated in place)
 * @param {Object} app - App configuration
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use app default
 * @returns {boolean} true when guidance was appended
 */
export function appendWebSearchResearchGuidance(llmMessages, app, websearchEnabled) {
  if (!app?.websearch?.enabled) return false;

  const enabledByDefault = app.websearch.enabledByDefault ?? false;
  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (!effectiveEnabled) return false;

  const guidance = resolveWebSearchResearchGuidance(app);
  if (!guidance) return false;

  const systemMessage = llmMessages.find(m => m.role === 'system');
  if (!systemMessage || typeof systemMessage.content !== 'string') return false;

  if (systemMessage.content.includes(guidance)) return false;

  systemMessage.content = systemMessage.content
    ? `${systemMessage.content}\n\n${guidance}`
    : guidance;
  logger.info('Appended web search research guidance to system prompt', {
    component: 'RequestBuilder',
    appId: app.id
  });
  return true;
}

/**
 * Filter models based on app requirements
 * @param {Array} models - All available models
 * @param {Object} app - App configuration
 * @returns {Array} Filtered models that match app requirements
 */
function filterModelsForApp(models, app) {
  let availableModels = models;

  // Filter by allowedModels if specified
  if (app?.allowedModels && app.allowedModels.length > 0) {
    availableModels = availableModels.filter(model => app.allowedModels.includes(model.id));
  }

  // Filter by tools requirement (app.tools, app.apps — apps invoked as tools —
  // or websearch config all require tool support). app.apps only counts while
  // the appAsTool feature is enabled: with the flag off no app__* tools are
  // generated, so a configured-but-inactive delegation must not shrink the
  // model list.
  const appToolsActive =
    app?.apps && app.apps.length > 0 && isFeatureEnabled('appAsTool', configCache.getFeatures());
  if ((app?.tools && app.tools.length > 0) || appToolsActive || app?.websearch?.enabled) {
    availableModels = availableModels.filter(model => model.supportsTools);
  }

  // Apply model settings filter if specified (e.g., supportsImageGeneration)
  if (app?.settings?.model?.filter) {
    const filter = app.settings.model.filter;
    availableModels = availableModels.filter(model => {
      // Check each filter property
      for (const [key, value] of Object.entries(filter)) {
        if (model[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  return availableModels;
}

/**
 * Narrow a model list down to what the requesting user's group permissions
 * allow. Apps only express what they support; user.permissions.models is the
 * separate, group-driven allowlist enforced everywhere else (/api/models,
 * the OpenAI-compatible proxy) and must also bound chat model resolution.
 * @param {Array} models - Models already filtered for app requirements
 * @param {Object} user - Authenticated/anonymous principal, may be undefined
 * @returns {Array} Models the user is permitted to use
 */
function filterModelsForUser(models, user) {
  if (!user?.permissions) return models;
  const allowedModels = user.permissions.models || new Set();
  return filterResourcesByPermissions(models, allowedModels);
}

/**
 * Whether the user is permitted to use a specific model id, per the same
 * group-permission rules as filterModelsForUser (honors the `*` wildcard,
 * matches ids case-insensitively). Returns true when no model-permission info
 * is present so callers without an enhanced user object (e.g. internal/system
 * flows) are not blocked.
 */
function isModelPermittedForUser(user, modelId) {
  if (!user?.permissions) return true;
  return filterModelsForUser([{ id: modelId }], user).length > 0;
}

class RequestBuilder {
  constructor() {
    this.errorHandler = new ErrorHandler();
    this.apiKeyVerifier = new ApiKeyVerifier();
  }

  async prepareChatRequest({
    appId,
    modelId,
    messages,
    temperature,
    style,
    outputFormat,
    language,
    bypassAppPrompts = false,
    thinkingEnabled,
    thinkingLevel,
    thinkingThoughts,
    enabledTools,
    websearchEnabled,
    imageAspectRatio,
    imageQuality,
    requestedSkill,
    documentIds,
    processMessageTemplates,
    user,
    chatId
  }) {
    try {
      const { data: apps } = configCache.getApps();
      if (!apps) {
        const error = new Error('Failed to load apps configuration');
        error.code = 'CONFIG_ERROR';
        return { success: false, error };
      }

      const app = findByIdCaseInsensitive(apps, appId);
      if (!app) {
        const error = await this.errorHandler.createModelError(appId, 'unknown', language);
        error.code = 'APP_NOT_FOUND';
        return { success: false, error };
      }

      const { data: models } = configCache.getModels();
      if (!models) {
        const error = new Error('Failed to load models configuration');
        error.code = 'CONFIG_ERROR';
        return { success: false, error };
      }

      // A caller may request a specific model, but only one they're permitted
      // to use. This runs before any app-level filtering so it also covers
      // models the app would otherwise allow. An explicit request for a model
      // that exists but sits outside `user.permissions.models` is a hard
      // error — not a silent substitution — mirroring the enforcement already
      // applied to /api/models and the OpenAI-compatible proxy
      // (server/routes/openaiProxy.js). A model id that doesn't exist at all
      // falls through to normal fallback resolution below, unchanged.
      let requestedModelId = modelId;
      if (requestedModelId) {
        // Normalize to the configured casing up front so the permission
        // check and every downstream `id === requestedModelId` comparison
        // line up regardless of how the caller cased the model id.
        const matchedModel = findByIdCaseInsensitive(models, requestedModelId);
        if (matchedModel) {
          requestedModelId = matchedModel.id;
          if (!isModelPermittedForUser(user, requestedModelId)) {
            const error = new Error(
              `You don't have permission to use the model '${requestedModelId}'. Please contact your administrator to request access.`
            );
            error.code = 'modelAccessDeniedForUser';
            return { success: false, error };
          }
        }
      }

      // Filter models based on app requirements (allowedModels, tools, settings.model.filter)
      const filteredModels = filterModelsForApp(models, app);
      // Then narrow to what the requesting user's group permissions allow —
      // the app only expresses what it supports, user.permissions.models is
      // the separate, group-driven allowlist that must also bound which
      // model chat resolution can land on.
      const permittedModels = filterModelsForUser(filteredModels, user);
      logger.info('Filtered compatible models for app', {
        component: 'RequestBuilder',
        appId: app.id,
        filteredCount: filteredModels.length,
        permittedCount: permittedModels.length,
        totalCount: models.length
      });

      // Check if no models are available at all
      if (permittedModels.length === 0) {
        // Determine the most appropriate error message
        let errorCode;

        // If there are no models in the system at all
        if (models.length === 0) {
          errorCode = 'noModelsAvailable';
        }
        // If models exist but none passed the app-specific filters
        else if (
          filteredModels.length === 0 &&
          (app.allowedModels || app.tools || app.settings?.model?.filter)
        ) {
          errorCode = 'noCompatibleModels';
        }
        // Otherwise, the app permits models this user's group does not
        else {
          errorCode = 'noModelsForUser';
        }

        const error = new Error(
          errorCode === 'noModelsAvailable'
            ? `No AI models are available for this app. Please contact your administrator to configure models and permissions.`
            : errorCode === 'noCompatibleModels'
              ? `No compatible AI models found for app '${app.id}'. The app requires specific model features that are not available.`
              : `You don't have permission to access any AI models for this app.`
        );
        error.code = errorCode;
        return { success: false, error };
      }

      // Find the default model from the permitted list, or fall back to global default
      const defaultModelFromFiltered = permittedModels.find(m => m.default)?.id;
      const globalDefaultModel = models.find(m => m.default)?.id;
      const defaultModel = defaultModelFromFiltered || globalDefaultModel;

      // Determine which model to use
      let resolvedModelId = requestedModelId || app.preferredModel || defaultModel;

      // Check if we still don't have a model ID (all sources were null/undefined)
      if (!resolvedModelId) {
        logger.info('No model ID could be determined for app', {
          component: 'RequestBuilder',
          appId: app.id
        });
        // Use the first available model from the permitted list as last resort
        if (permittedModels.length > 0) {
          resolvedModelId = permittedModels[0].id;
          logger.info('Using first available model as fallback', {
            component: 'RequestBuilder',
            resolvedModelId
          });
        } else {
          // This shouldn't happen since we checked permittedModels.length above, but handle it anyway
          const error = new Error('No model ID provided and no default model available.');
          error.code = 'noModelIdProvided';
          return { success: false, error };
        }
      }

      // Check if the resolved model is in the permitted list
      const isModelInFilteredList = permittedModels.some(m => m.id === resolvedModelId);

      if (!isModelInFilteredList) {
        logger.info('Model not compatible with app requirements, searching for fallback', {
          component: 'RequestBuilder',
          resolvedModelId,
          appId: app.id
        });

        // Try to find a compatible fallback model
        let fallbackModel = null;

        // 1. Try app's preferred model if it's in the permitted list
        if (app.preferredModel && permittedModels.some(m => m.id === app.preferredModel)) {
          fallbackModel = app.preferredModel;
          logger.info("Using app's preferred model as fallback", {
            component: 'RequestBuilder',
            fallbackModel
          });
        }
        // 2. Try default model from the permitted list
        else if (defaultModelFromFiltered) {
          fallbackModel = defaultModelFromFiltered;
          logger.info('Using default model from filtered list as fallback', {
            component: 'RequestBuilder',
            fallbackModel
          });
        }
        // 3. Try first available model from the permitted list
        else if (permittedModels.length > 0) {
          fallbackModel = permittedModels[0].id;
          logger.info('Using first available compatible model as fallback', {
            component: 'RequestBuilder',
            fallbackModel
          });
        }

        if (fallbackModel) {
          resolvedModelId = fallbackModel;
        } else {
          // No compatible models found - this should be caught by the earlier check, but handle it
          const error = new Error(
            `No compatible AI models found for app '${app.id}'. The app requires specific model features that are not available.`
          );
          error.code = 'noCompatibleModels';
          return { success: false, error };
        }
      }

      const model = models.find(m => m.id === resolvedModelId);

      if (!model) {
        const error = await this.errorHandler.createModelError(
          resolvedModelId,
          'unknown',
          language
        );
        return { success: false, error };
      }

      // Get model name for global prompt variables
      const modelName = model?.name || model?.id || resolvedModelId;

      let llmMessages = await processMessageTemplates(
        messages,
        bypassAppPrompts ? null : app,
        style,
        outputFormat,
        language,
        app.outputSchema,
        user,
        chatId,
        modelName,
        requestedSkill
      );
      // The raw file/image data of the last user message, next to its rendered
      // content: workflow tools receive the structured file object for their
      // inputFiles mechanism.
      const lastUserMsg = [...llmMessages].reverse().find(m => m.role === 'user');
      const userFileData = lastUserMsg?.fileData || lastUserMsg?.imageData || null;
      // Every attachment of that message, files and images alike, as one list:
      // tools with file inputs resolve their references against it, and the
      // model is told about it in the same order. Taken before the page images
      // of image-only PDFs join `imageData`; those carry no file name.
      const userAttachments = normalizeAttachments(
        lastUserMsg?.fileData,
        lastUserMsg?.imageData,
        lastUserMsg?.audioData
      );

      logger.info('File data extraction from messages', {
        component: 'RequestBuilder',
        hasLastUserMsg: !!lastUserMsg,
        hasFileData: !!lastUserMsg?.fileData,
        hasImageData: !!lastUserMsg?.imageData,
        userFileDataFileName: userFileData?.fileName || 'none',
        messageKeys: lastUserMsg ? Object.keys(lastUserMsg).join(', ') : 'none'
      });

      llmMessages = attachDocumentPageImages(llmMessages);

      logger.info('Preparing chat request', {
        component: 'RequestBuilder',
        appId: app.id,
        modelId: model.id
      });

      // Output cap sent to the provider (max_tokens / maxOutputTokens). This is
      // the model's response limit — NOT the context window. Apps no longer
      // configure token limits; they inherit the output cap from the model.
      const DEFAULT_MAX_OUTPUT = 4096;
      const finalTokens = model.maxOutputTokens || DEFAULT_MAX_OUTPUT;
      logger.info('Max output tokens for request', {
        component: 'RequestBuilder',
        finalTokens,
        contextWindow: model.contextWindow || null
      });

      // Fail fast on a missing provider key so the route can answer with a
      // clean HTTP error before any stream is opened. The verifier never
      // writes to a response here — the caller owns the reply.
      const apiKeyResult = await this.apiKeyVerifier.verifyApiKey(model, language);
      if (!apiKeyResult.success) {
        return { success: false, error: apiKeyResult.error };
      }

      const context = {
        user,
        chatId,
        language,
        enabledTools,
        modelProvider: model.provider,
        model,
        websearchEnabled
      };
      const tools = await getToolsForApp(app, language, context);
      const nativeWebSearch = resolveAppNativeWebSearch(
        app,
        model.provider,
        websearchEnabled,
        model
      );

      // A web-search-enabled app's system prompt typically instructs the model
      // to "use the web search tool". When web search is toggled OFF for the
      // turn, no such tool is sent — leaving the prompt telling the model to
      // call a tool that isn't there. Some models (notably Gemini with thinking
      // enabled) react by emitting a function call that can't be validated
      // against any declaration, which Google returns as
      // finishReason: MALFORMED_FUNCTION_CALL — i.e. an empty answer, seen
      // intermittently and especially on a resend. Appending a short directive
      // that web search is unavailable removes the contradiction so the model
      // answers directly instead of attempting a phantom tool call.
      appendWebSearchDisabledNotice(llmMessages, app, websearchEnabled);
      // The positive counterpart: with web search on, tell the model to research
      // in several steps so the loop's room for several tool rounds is used.
      appendWebSearchResearchGuidance(llmMessages, app, websearchEnabled);
      // A tool that takes a file needs the model to know what is attached.
      appendAttachmentNote(llmMessages, tools, userAttachments);

      // Build imageConfig if image generation is supported and parameters are provided
      // Pass raw user parameters to adapter for provider-specific translation
      let imageConfig = null;
      if (model.supportsImageGeneration) {
        // Use provided parameters or fall back to model/app defaults
        const aspectRatio =
          imageAspectRatio ||
          model.imageGeneration?.aspectRatio ||
          app.imageGeneration?.aspectRatio;
        const quality =
          imageQuality || model.imageGeneration?.quality || app.imageGeneration?.quality;

        if (aspectRatio || quality) {
          // Pass raw parameters to adapter - adapter will handle provider-specific translation
          imageConfig = {
            aspectRatio,
            quality
          };
          logger.info('Image generation config passed to adapter', {
            component: 'RequestBuilder',
            aspectRatio,
            quality
          });
        }
      }

      const resolvedTemperature = parseFloat(temperature) || app.preferredTemperature || 0.7;

      // Provider-facing options for every model call of this turn. The loop
      // hands them to LLMClient unchanged, so follow-up calls after tool
      // results keep native web search, thinking and image settings.
      const llmOptions = {
        nativeWebSearch,
        thinkingEnabled,
        thinkingLevel,
        thinkingThoughts,
        imageConfig,
        user,
        chatId,
        appConfig: documentIds ? { ...app, documentIds } : app
      };

      return {
        success: true,
        data: {
          app,
          model,
          llmMessages,
          tools,
          apiKey: apiKeyResult.apiKey,
          temperature: resolvedTemperature,
          maxTokens: finalTokens,
          responseFormat: outputFormat,
          responseSchema: app.outputSchema,
          llmOptions,
          userFileData,
          userAttachments
        }
      };
    } catch (error) {
      logger.error('Error in prepareChatRequest', { component: 'RequestBuilder', error });
      const chatError = new Error(error.message || 'Internal server error');
      // Detect auth failures from provider APIs (e.g., "Failed to create conversation (401): ")
      if (error.message?.includes('(401)') || error.message?.includes('authentication failed')) {
        chatError.code = 'AUTH_FAILED';
      } else {
        chatError.code = 'INTERNAL_ERROR';
      }
      return { success: false, error: chatError };
    }
  }
}

export default RequestBuilder;
