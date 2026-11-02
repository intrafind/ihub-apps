// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iAssistant `ask` action (`iassistant__ask`, #2973): one iAssistant
 * conversation turn as a tool. Another model asks the iAssistant a question
 * and gets a grounded answer with the documents it was based on, which become
 * the answer's sources exactly as on the iAssistant chat path
 * (`adapters/iassistant-conversation.js`).
 *
 * One call is one turn of a new, ephemeral conversation: the tool keeps no
 * conversation state per chat, so a second call does not see the first one's
 * question. The iAssistant settings come from where the iAssistant model
 * reads them, minus the model itself: the app's `iassistant` block, then the
 * installation's defaults.
 *
 * Whom it asks (the iAssistant scope, #3050), first match wins:
 *
 *   1. the chat's scope pick (`integrationScopes.iassistant`), which the chat
 *      route already checked against the user's iAssistants;
 *   2. a scope the app pins (`integrations.iassistant.pinnedScope`);
 *   3. the iAssistant the model names in `assistant`, checked like a scope
 *      the user picked (an iAssistant the user cannot see is refused);
 *   4. the app's configured setup (`iassistant.assistantId`, `profileId`,
 *      `searchProfile`, `allSearchProfiles`).
 *
 * So a picked or pinned scope always overrides the model's argument.
 *
 * The answer's citations are renumbered: the iAssistant numbers its result
 * documents (`<cite type="r">N</cite>`) and passages (`<cite type="s">N</cite>`)
 * from 1 in every turn, but the calling model's answer merges the sources of
 * all its tool calls, so every cited document gets a passage number reserved
 * for this call (`allocatePassageMarkers`) and the answer text is rewritten
 * to it. The sources travel beside the result (`reportToolCallSources`); the
 * model reads the answer and a short list of the cited documents.
 *
 * @module services/integrations/iAssistantAsk
 */
import iAssistantConversationAdapter, {
  toFallbackLanguage
} from '../../adapters/iassistant-conversation.js';
import conversationApiService from './ConversationApiService.js';
import iAssistantService from './iAssistantService.js';
import iAssistantProfileResolver from './iAssistantProfileResolver.js';
import { AssistantNotAvailableError } from './iFinderAssistants.js';
import iAssistantScopes, {
  INTEGRATION_ID,
  assistantScopeId,
  conversationScopeOf,
  describeAnswerScope
} from './scopes/iAssistantScopes.js';
import { appScopeSettings } from './scopes/common.js';
import { searchProfileNames } from './scopes/iFinderScopes.js';
import { iAssistantSourceFrame } from '../sources/producers/ifinder.js';
import { allocatePassageMarkers, reportToolCallSources } from '../sources/toolCallScope.js';
import { citeMarker } from '../../../shared/sources/citations.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'IAssistantAsk';

/** Label every conversation the tool creates carries, next to `ihub` and the app id. */
export const ASK_CONVERSATION_LABEL = 'ihub-tool';

/** Most characters of a passage the model reads per cited document. */
const EXCERPT_CHARS = 300;

/** iAssistant's citation tags, as `shared/sources/citations.js` reads them. */
const CITE_TAG = /<cite\s+type="([rs])"\s*>\s*(\d+)\s*<\/cite>/gi;

/** An error the model should read as the tool's answer (not a technical failure). */
export class IAssistantAskError extends Error {
  /**
   * @param {string} message
   * @param {string} code - `INVALID_QUESTION`, `NOT_SIGNED_IN`, `NOT_AVAILABLE`,
   *   `ASSISTANT_NOT_AVAILABLE`, `SCOPE_NOT_ALLOWED`, `ANSWER_FAILED`
   */
  constructor(message, code) {
    super(message);
    this.name = 'IAssistantAskError';
    this.code = code;
  }
}

/** The scope id an `assistant` argument names (`legal` or `assistant:legal`). */
function scopeIdOfArgument(assistant) {
  const id = typeof assistant === 'string' ? assistant.trim() : '';
  if (!id) return null;
  return id.startsWith('assistant:') ? id : assistantScopeId(id);
}

/**
 * Whom one call asks, as an iAssistant scope id, or null for the app's
 * configured setup. See the module comment for the order.
 *
 * @param {Object} params
 * @param {string|null} [params.chatScope] - the chat's checked scope pick
 * @param {string} [params.assistant] - the model's argument
 * @param {Object} params.user
 * @param {Object} [params.appConfig]
 * @param {string} [params.language]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string|null>}
 * @throws {IAssistantAskError} `SCOPE_NOT_ALLOWED` for an iAssistant the user may not ask
 */
export async function resolveAskScope({ chatScope, assistant, user, appConfig, language, signal }) {
  if (typeof chatScope === 'string' && chatScope) return chatScope;
  const pinned = appScopeSettings(appConfig, INTEGRATION_ID).pinnedScope;
  if (pinned) return pinned;
  const requested = scopeIdOfArgument(assistant);
  if (!requested) return null;
  const checked = await iAssistantScopes.validateScope({
    scopeId: requested,
    user,
    app: appConfig,
    language,
    signal
  });
  if (!checked.ok) throw new IAssistantAskError(checked.message, 'SCOPE_NOT_ALLOWED');
  return checked.scopeId || requested;
}

/**
 * Renumber an answer's citations onto passage numbers reserved for this call.
 *
 * Every marker the sources carry (`r:N` on a result document, `s:N` on a
 * passage) gets the next reserved number `s:M`, in the order the sources
 * list them; the answer's `<cite>` tags are rewritten to match, and a tag
 * naming no listed source (a result item iFinder sent without a title) is
 * dropped, so it cannot point at another call's passage.
 *
 * @param {string} answer - the iAssistant's answer text
 * @param {Array<Object>} items - source inputs (`iAssistantSourceFrame(...).items`)
 * @returns {{ answer: string, items: Array<Object> }} new values; the inputs are not changed
 * @example
 * renumberCitations('See <cite type="r">2</cite>.', [{ markers: ['r:2'] }]);
 * // with 4 numbers reserved before → { answer: 'See <cite type="s">5</cite>.', items: [{ markers: ['s:5'] }] }
 */
export function renumberCitations(answer, items) {
  const renamed = new Map();
  for (const item of items) {
    for (const marker of item.markers || []) renamed.set(marker, null);
    for (const passage of item.passages || []) {
      if (passage?.marker) renamed.set(passage.marker, null);
    }
  }
  let next = allocatePassageMarkers(renamed.size);
  for (const marker of renamed.keys()) renamed.set(marker, `s:${next++}`);
  const rename = marker => renamed.get(marker) || marker;

  const renumbered = items.map(item => {
    const passages = (item.passages || []).map(passage =>
      passage?.marker ? { ...passage, marker: rename(passage.marker) } : passage
    );
    // A passage's number is also the source's own marker (as the knowledge
    // tools do): merging keeps the first passage of one text only, while
    // markers merge on their own.
    const markers = [
      ...(item.markers || []).map(rename),
      ...passages.map(passage => passage?.marker).filter(Boolean)
    ];
    return {
      ...item,
      ...(markers.length ? { markers: [...new Set(markers)] } : {}),
      ...(item.passages ? { passages } : {})
    };
  });

  const text = String(answer || '').replace(CITE_TAG, (_match, type, num) => {
    const marker = renamed.get(citeMarker(type, num));
    return marker ? `<cite type="s">${marker.slice(2)}</cite>` : '';
  });
  return { answer: text, items: renumbered };
}

/** The passage numbers a source carries, ascending. */
function numbersOf(item) {
  return [
    ...new Set(
      (item.markers || [])
        .filter(marker => marker.startsWith('s:'))
        .map(marker => Number(marker.slice(2)))
    )
  ].sort((a, b) => a - b);
}

/** The cited documents as the model reads them: number, title, id, profile and an excerpt. */
function documentsForModel(items) {
  return items.map(item => {
    const excerpt = item.passages?.find(passage => passage?.text)?.text;
    return {
      n: numbersOf(item),
      title: item.title,
      documentId: item.ref?.id,
      ...(item.scopeName ? { searchProfile: item.scopeName } : {}),
      ...(excerpt ? { excerpt: excerpt.slice(0, EXCERPT_CHARS) } : {})
    };
  });
}

/** The labels of a tool conversation: `ihub`, the tool's own, the app and the app's own. */
function conversationLabels(appConfig, configured) {
  const labels = ['ihub', ASK_CONVERSATION_LABEL];
  if (appConfig?.id) labels.push(appConfig.id);
  if (Array.isArray(configured)) labels.push(...configured);
  else if (typeof configured === 'string' && configured) labels.push(configured);
  return labels;
}

/**
 * Ask the iAssistant one question.
 *
 * @param {Object} params
 * @param {string} params.question - what to ask, in the user's words
 * @param {string} [params.assistant] - the iAssistant the model would ask; a
 *   chat scope or a pinned one wins over it
 * @param {string|null} [params.chatScope] - the chat's checked iAssistant scope
 * @param {Object} params.user - the signed-in user the turn runs as
 * @param {Object} [params.appConfig] - the app the call comes from
 * @param {string} [params.language] - the UI language (`fallback_language`)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{answer: string, scope: Object, searchProfile?: string,
 *   documents: Array<Object>, note: string}>}
 * @throws {IAssistantAskError} for a call the model or the user can act on
 * @throws {Error} when iFinder fails
 */
export async function askIAssistant({
  question,
  assistant,
  chatScope = null,
  user,
  appConfig = null,
  language,
  signal
}) {
  const content = typeof question === 'string' ? question.trim() : '';
  if (!content) throw new IAssistantAskError('question is required', 'INVALID_QUESTION');
  if (!user || user.id === 'anonymous') {
    throw new IAssistantAskError(
      'Asking the iAssistant requires a signed-in user',
      'NOT_SIGNED_IN'
    );
  }
  const service = iAssistantService.getConfig();
  if (!service.enabled || !service.baseUrl) {
    throw new IAssistantAskError(
      'The iAssistant is not available: its iFinder installation is disabled or has no base URL',
      'NOT_AVAILABLE'
    );
  }

  const scopeId = await resolveAskScope({
    chatScope,
    assistant,
    user,
    appConfig,
    language,
    signal
  });
  // The settings the iAssistant model resolves, without a model of its own.
  const config = iAssistantConversationAdapter.resolveConfig(
    { config: {} },
    {
      appConfig: appConfig || {},
      user,
      integrationScopes: scopeId ? { [INTEGRATION_ID]: scopeId } : {}
    }
  );

  let resolved;
  try {
    resolved = await iAssistantProfileResolver.resolveScope({
      assistantId: config.assistantId,
      allSearchProfiles: config.allSearchProfiles,
      configuredProfileId: config.profileId,
      configuredSearchProfile: config.configuredSearchProfile,
      user,
      baseUrl: config.baseUrl,
      signal
    });
  } catch (error) {
    if (error instanceof AssistantNotAvailableError) {
      throw new IAssistantAskError(
        `The iAssistant "${config.assistantId}" is not available to you in iFinder. ` +
          'Ask your administrator for access to its search profile.',
        'ASSISTANT_NOT_AVAILABLE'
      );
    }
    throw error;
  }

  const fallbackLanguage = toFallbackLanguage(language);
  const responseGeneration = {};
  if (config.extraContext) responseGeneration.extra_context = config.extraContext;
  if (config.systemPromptPreamble) {
    responseGeneration.system_prompt_preamble = config.systemPromptPreamble;
  }
  const documentIds = appConfig?.documentIds;
  const conversation = await conversationApiService.createConversation({
    user,
    baseUrl: config.baseUrl,
    searchProfile: resolved.searchProfile,
    labels: conversationLabels(appConfig, config.labels),
    // One turn, not a conversation the user continues in the iFinder Workspace.
    ephemeral: true,
    ...(Array.isArray(documentIds) && documentIds.length
      ? { retrievalScope: { document_ids: documentIds } }
      : {}),
    ...(Object.keys(responseGeneration).length ? { responseGeneration } : {}),
    fallbackLanguage,
    signal
  });

  // An iAssistant's conversation profile comes with it; else the configured one.
  const profileId = resolved.assistantId ? resolved.profileId : config.profileId;
  const response = await conversationApiService.sendMessage(conversation.id, {
    content,
    profileId,
    tools: config.tools,
    user,
    baseUrl: config.baseUrl,
    fallbackLanguage,
    signal
  });
  const turn = iAssistantConversationAdapter.processResponseBuffer(await response.text());
  if (turn.error) {
    throw new IAssistantAskError(
      turn.errorMessage || 'The iAssistant could not answer',
      'ANSWER_FAILED'
    );
  }

  const state = {
    scopeId: config.scopeId,
    assistantId: resolved.assistantId || null,
    searchScope: resolved.source === 'all-search-profiles' ? 'all' : 'profile'
  };
  const searchProfile = state.searchScope === 'all' ? undefined : resolved.searchProfile;
  const [scopeNames, scope] = await Promise.all([
    searchProfileNames({
      user,
      baseUrl: config.baseUrl,
      application: service.searchProfileApplication,
      ttlMs: service.searchProfileCacheTtlMs,
      signal
    }),
    describeAnswerScope({
      scopeId: conversationScopeOf(state),
      user,
      app: appConfig,
      language,
      signal
    })
  ]);
  const frame = iAssistantSourceFrame(turn.citations, { searchProfile, scopeNames });
  const { answer, items } = renumberCitations(turn.content.join(''), frame?.items || []);
  reportToolCallSources(items);

  logger.info('Asked the iAssistant', {
    component: COMPONENT,
    conversationId: conversation.id,
    scope: scope.id,
    searchProfile: searchProfile || '(all)',
    documents: items.length
  });

  const firstNumber = items.map(item => numbersOf(item)[0]).find(Number.isInteger);
  return {
    answer,
    scope,
    ...(searchProfile ? { searchProfile } : {}),
    documents: documentsForModel(items),
    note: firstNumber
      ? `The answer cites its documents as <cite type="s">n</cite>. Keep these tags when you use a statement, e.g. <cite type="s">${firstNumber}</cite>.`
      : 'The iAssistant cited no documents.'
  };
}
