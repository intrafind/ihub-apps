// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The steps of the "New app" page that need no screen: which model drafts,
 * what each start hands to the Essentials screen, and what the create request
 * carries.
 *
 * Pure: no React, no browser API, no request, no path.
 *
 * @module features/admin/components/app-create/createFlow
 */

import { primaryLanguageOf } from '../../../../../../shared/appDefaults.js';
import { slugifyAppId, uniqueAppId } from '../../../../../../shared/appId.js';
import { getLocalizedContent } from '../../../../../../shared/localize.js';
import {
  buildCreatePayload,
  draftForLink,
  draftFromBlank,
  draftFromExistingApp,
  draftFromGenerated,
  draftFromTemplate,
  dropOtherLanguages
} from '../../utils/appDraft.js';

/** The texts of the Essentials screen that are stored per language. */
const TEXT_FIELDS = ['name', 'description', 'system'];

const hasText = value => typeof value === 'string' && value.trim() !== '';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The model that would prepare a draft: the standard chat model, else the
 * first chat model, among the models the list holds. This is the server's
 * rule (`selectGuideModel`, `server/utils/appUsageGuide.js`) applied to
 * `GET /api/models`, which lists the models the caller may use. Image models
 * and iAssistant conversations cannot answer a one-off request.
 *
 * It only says that a model is set up. A model with a wrong key passes; the
 * draft request then answers with its own message.
 *
 * @param {object[]|null|undefined} models
 * @returns {object|null} The model, or null when no model can draft.
 */
export function pickDraftModel(models) {
  const usable = (Array.isArray(models) ? models : []).filter(
    model =>
      model &&
      (model.modelType || 'chat') === 'chat' &&
      !model.supportsImageGeneration &&
      String(model.provider || '').toLowerCase() !== 'iassistant-conversation'
  );
  return usable.find(model => model.default) || usable[0] || null;
}

/**
 * A model's name as the author reads it.
 *
 * @param {object|null|undefined} model
 * @param {string} language
 * @returns {string|null}
 */
export function modelDisplayName(model, language) {
  if (!model) return null;
  const name = hasText(model.name) ? model.name : getLocalizedContent(model.name, language);
  return hasText(name) ? name : model.id || null;
}

/**
 * The app ID that follows a name: a free ID made from the name, or nothing
 * while there is no name.
 *
 * @param {string} name
 * @param {(id: string) => boolean} [isTaken]
 * @returns {string}
 */
export function derivedAppId(name, isTaken) {
  return hasText(name) ? uniqueAppId(slugifyAppId(name), isTaken) : '';
}

/**
 * "Start empty": the defaults of a new chat app in one language.
 *
 * @param {{ language: string }} options - The content language.
 * @returns {{ start: 'blank', language: string, draft: object }}
 */
export function beginBlank({ language }) {
  return { start: 'blank', language, draft: draftFromBlank(language) };
}

/**
 * "Create a link app": a link that opens a website. The author can switch it
 * to a website shown inside iHub.
 *
 * @param {{ language: string }} options - The content language.
 * @returns {{ start: 'link', language: string, draft: object }}
 */
export function beginLink({ language }) {
  return { start: 'link', language, draft: draftForLink({ language, mode: 'redirect', url: '' }) };
}

/**
 * A template start: the template's content in the content language only.
 *
 * @param {object} template - An item of the template list.
 * @param {{ language: string, isTaken?: (id: string) => boolean }} options
 * @returns {{ start: 'template', language: string, draft: object, source: { id: string, name: string } }}
 */
export function beginTemplate(template, { language, isTaken }) {
  const draft = draftFromTemplate(template, { language, isTaken });
  return {
    start: 'template',
    language,
    draft,
    source: { id: template?.id ?? '', name: draft.name?.[language] || template?.id || '' }
  };
}

/**
 * A copy of an existing app. Every language of the source is kept. The screen
 * edits the language of the source that fits the author best
 * (`primaryLanguageOf`), so a German-only app is edited in German by an author
 * with an English UI.
 *
 * @param {object} app - The source, as stored.
 * @param {object} options
 * @param {string} [options.uiLanguage] - The language of the UI.
 * @param {string} [options.platformDefault] - The platform's default language.
 * @param {(id: string) => boolean} [options.isTaken]
 * @param {(name: string, language: string) => string} [options.copyLabel] -
 *   Turns a name into the copy's name ("… (copy)").
 * @returns {{ start: 'copy', language: string, draft: object,
 *   source: { id: string, name: string, noInstructions: boolean } }}
 */
export function beginCopy(app, { uiLanguage, platformDefault, isTaken, copyLabel } = {}) {
  const language = primaryLanguageOf(app, uiLanguage, platformDefault);
  const source = { ...app };
  // A text stored as a plain string becomes the text of the language the screen edits.
  for (const field of TEXT_FIELDS) {
    if (typeof source[field] === 'string') source[field] = { [language]: source[field] };
  }
  const draft = draftFromExistingApp(source, { isTaken, copyLabel, language });
  for (const field of ['name', 'description']) {
    if (!isPlainObject(draft[field])) draft[field] = { [language]: '' };
  }
  const instructions = isPlainObject(source.system) ? Object.values(source.system) : [];
  return {
    start: 'copy',
    language,
    draft,
    source: {
      id: typeof app?.id === 'string' ? app.id : '',
      name: source.name?.[language] || app?.id || '',
      noInstructions: !instructions.some(hasText)
    }
  };
}

/**
 * An AI draft: the app the server prepared, as it is. What the model proposed
 * beyond texts and input fields stays in `generated.suggestions` until the
 * author ticks it.
 *
 * @param {{ app: object, suggestions?: object, warnings?: object[], model?: object, brief?: string }} result -
 *   The answer of the draft request.
 * @param {{ description: string, language: string }} options - What the
 *   author wrote, and the language that was asked for.
 * @returns {{ start: 'generated', language: string, draft: object, generated: object, description: string }}
 */
export function beginGenerated(result, { description, language }) {
  return {
    start: 'generated',
    language: primaryLanguageOf(result?.app, language),
    draft: { ...result?.app },
    generated: result,
    description
  };
}

/**
 * The fields of a copy whose other languages are removed on create, because
 * the author changed the text: the runtime picks a text by the user's
 * language first, so an old version would be shown instead of the new one.
 *
 * @param {object} state - The page's state (`useAppDraft`).
 * @returns {string[]} Of `name`, `description`, `system`.
 */
export function fieldsLosingLanguages(state) {
  if (state?.start !== 'copy' || !state.draft) return [];
  return TEXT_FIELDS.filter(field => {
    const text = state.draft[field];
    if (!state.edited.includes(field) || !isPlainObject(text)) return false;
    if (!hasText(text[state.language])) return false;
    return Object.entries(text).some(
      ([language, value]) => language !== state.language && hasText(value)
    );
  });
}

/**
 * The body of the create request for the page's state.
 *
 * - An AI draft gets only the suggestions the author ticked, and loses its
 *   input fields when the author unticked them.
 * - A copy loses the other languages of each text the author changed.
 *
 * @param {object} state - The page's state (`useAppDraft`).
 * @returns {object} The app to send.
 * @throws {Error} With `code: 'APP_ID_INVALID'` when the ID cannot be the ID
 *   of a new app (`buildCreatePayload`).
 */
export function payloadFromState(state) {
  let draft = state.draft;
  if (state.start === 'generated') {
    draft = draftFromGenerated(
      { app: draft, suggestions: state.generated?.suggestions },
      state.extras
    );
  }
  if (state.start === 'copy') {
    draft = dropOtherLanguages(draft, state.edited, state.language);
  }
  return buildCreatePayload(draft);
}
