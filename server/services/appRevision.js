// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The engine of the conversation that changes an app (issue #3898,
 * `POST /api/admin/apps/_revise`, `POST /api/apps/_revise`).
 *
 * One turn is one model call. It gets the app's current content, the
 * conversation so far and the author's latest message, and answers with one
 * question, one change or one message. Nothing is stored: the client merges a
 * change into its form and saves it through the editor's normal save.
 *
 * The model influences wording and the content keys of the target, nothing
 * else. A change goes through the same allow-list and sanitiser as a draft
 * ({@link sanitizeGeneratedApp}), only the keys the model returned and the
 * sanitiser changed enter `patch`, and the patched app is checked against the
 * schema of its target. Web search and integrations come back as
 * `suggestions`, filtered to what the caller may use, and never enter `patch`.
 *
 * Design: concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * section 2.3 (the steps below are numbered as there).
 *
 * @module services/appRevision
 */

import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { ServiceError } from '../utils/ServiceError.js';
import { getLocalizedString } from '../utils/localize.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { userAppContentSchema } from '../validators/userAppSchema.js';
import defaultLlmClient from './loop/LLMClient.js';
import {
  GENERATOR_MAX_TOKENS,
  GENERATOR_TIMEOUT_MS,
  appCategoryIds,
  baseLanguage,
  installationsFor,
  integrationsBlock,
  parseGeneratedAnswer,
  pickDraftModel,
  sanitizeGeneratedApp,
  searchFor
} from './appGenerator.js';
import { buildRevisionMessages } from './appGeneratorBrief.js';
import { newAppDefaults } from '../../shared/appDefaults.js';
import {
  REVISE_CHOICES_MAX,
  REVISE_CHOICE_MAX,
  REVISE_LOCALIZED_KEYS,
  REVISE_QUESTION_CAP,
  REVISE_SYSTEM_MAX,
  REVISE_TEXT_MAX,
  REVISE_WARNINGS,
  appRevisionKeys,
  applyRevisionPatch
} from '../../shared/appRevision.js';
import { stripHiddenCharacters } from '../../shared/visibleText.js';

const COMPONENT = 'AppRevision';

/** The keys of a required text: an empty proposal for one is ignored, never applied. */
const REQUIRED_TEXT_KEYS = new Set(['name', 'description', 'system']);

/**
 * What the sanitiser gets for a required text the app does not have yet, so
 * that an app without a name or instructions can still be revised. It is the
 * same in both runs of the sanitiser, so it never shows up as a change.
 */
const MISSING_TEXT = 'revision-placeholder';

/** The ID the schema check gives an admin app: the request carries no ID, and none is read. */
const CHECK_APP_ID = 'app-revision-check';

/** The keys of a model's change read as suggestions, never as content. */
const SUGGESTION_KEYS = ['websearch', 'integrations'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every string of a JSON value without hidden characters. */
function visibleDeep(value) {
  if (typeof value === 'string') return stripHiddenCharacters(value);
  if (Array.isArray(value)) return value.map(visibleDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, visibleDeep(entry)])
    );
  }
  return value;
}

/** Two JSON values are equal. Both come from the sanitiser, so their keys are in one order. */
function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The value as a localized object: itself, or `{}` for a plain string or nothing. */
function localizedObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

/**
 * The text of a stored value in `language`: the language itself, its base,
 * English, then any language with text. A plain string is its own text.
 * Hidden characters are removed; the text is trimmed.
 *
 * @param {unknown} value - A localized object or a string.
 * @param {string} language
 * @returns {string}
 */
export function textIn(value, language) {
  if (typeof value === 'string') return stripHiddenCharacters(value).trim();
  if (!isPlainObject(value)) return '';
  const candidates = [
    value[language],
    value[baseLanguage(language)],
    value.en,
    ...Object.values(value)
  ];
  const text = candidates
    .map(candidate =>
      typeof candidate === 'string' ? stripHiddenCharacters(candidate).trim() : ''
    )
    .find(Boolean);
  return text || '';
}

/**
 * Refuse a revision whose instructions are longer than a turn can revise:
 * the model would have to write them out in full, and a cut-off answer would
 * lose their end.
 *
 * @param {object} draft - The `draft` of the request.
 * @param {string} language - The language of the revision.
 * @throws {ServiceError} `APP_REVISE_TOO_LONG` (400) with `details: { field: 'system', max }`
 */
export function assertRevisable(draft, language) {
  const system = textIn(isPlainObject(draft) ? draft.system : undefined, language);
  if (system.length <= REVISE_SYSTEM_MAX) return;
  throw new ServiceError(
    'APP_REVISE_TOO_LONG',
    `The instructions have ${system.length} characters; a conversation can change at most ${REVISE_SYSTEM_MAX}`,
    { details: { field: 'system', max: REVISE_SYSTEM_MAX } }
  );
}

/**
 * How many questions the builder asked since its last change: builder entries
 * with `kind: 'question'` after the last one with `kind: 'change'`.
 *
 * @param {Array<{ role: string, kind?: string }>} conversation
 * @returns {number}
 */
export function questionsSinceLastChange(conversation) {
  let count = 0;
  for (const entry of conversation) {
    if (entry?.role !== 'builder') continue;
    if (entry.kind === 'change') count = 0;
    else if (entry.kind === 'question') count += 1;
  }
  return count;
}

/**
 * Step 2: the content the model sees. Only the target's keys, each text in
 * `language` (hidden characters removed), input fields and conversation
 * starters with their texts in that language. Keys without a value are left
 * out.
 *
 * @param {object} source - The target's keys of the draft, hidden characters removed.
 * @param {readonly string[]} keys
 * @param {string} language
 * @returns {object}
 */
function contentForModel(source, keys, language) {
  const content = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (REVISE_LOCALIZED_KEYS.includes(key)) {
      const text = textIn(value, language);
      if (text) content[key] = text;
    } else if (key === 'variables') {
      if (!Array.isArray(value)) continue;
      content.variables = value.filter(isPlainObject).map(variable => ({
        name: variable.name,
        label: textIn(variable.label, language) || variable.name,
        type: variable.type,
        ...(variable.required === true ? { required: true } : {}),
        ...(textIn(variable.defaultValue, language)
          ? { defaultValue: textIn(variable.defaultValue, language) }
          : {}),
        ...(Array.isArray(variable.predefinedValues) && variable.predefinedValues.length > 0
          ? {
              predefinedValues: variable.predefinedValues.filter(isPlainObject).map(option => ({
                value: option.value,
                label: textIn(option.label, language) || option.value
              }))
            }
          : {})
      }));
    } else if (key === 'starterPrompts') {
      if (!Array.isArray(value)) continue;
      content.starterPrompts = value.filter(isPlainObject).map(starter => ({
        title: textIn(starter.title, language),
        message: textIn(starter.message, language)
      }));
    } else if (typeof value === 'string' && value) {
      content[key] = value;
    }
  }
  return content;
}

/** The languages the app has text in, read from its name, description and instructions. */
function languagesOf(source) {
  const languages = new Set();
  for (const key of ['name', 'description', 'system']) {
    const value = source[key];
    if (!isPlainObject(value)) continue;
    for (const [language, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.trim()) languages.add(language);
    }
  }
  return languages;
}

/** A plain sentence for the author: hidden characters removed, white space collapsed, cut. */
function plainText(value, max = REVISE_TEXT_MAX) {
  if (typeof value !== 'string') return '';
  return stripHiddenCharacters(value).replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** The error of an answer that cannot become a reply. */
function invalidAnswer(reason, message) {
  return new ServiceError('APP_GENERATOR_INVALID_ANSWER', message, { details: { reason } });
}

/**
 * Step 6: the kind of reply the model gave: its `reply` when that is known,
 * else what the answer holds (a `change` object, a `question`), else a message.
 */
function replyKind(answer) {
  if (['question', 'change', 'message'].includes(answer.reply)) return answer.reply;
  if (isPlainObject(answer.change)) return 'change';
  if (isPlainObject(answer.question) || typeof answer.question === 'string') return 'question';
  return 'message';
}

/** The question of an answer: its text and at most six distinct, short choices. */
function questionOf(answer) {
  const raw = isPlainObject(answer.question) ? answer.question : { text: answer.question };
  const choices = [];
  for (const choice of Array.isArray(raw.choices) ? raw.choices : []) {
    const text = plainText(typeof choice === 'number' ? String(choice) : choice, REVISE_CHOICE_MAX);
    if (text && !choices.includes(text)) choices.push(text);
    if (choices.length >= REVISE_CHOICES_MAX) break;
  }
  return { text: plainText(raw.text), choices, allowOther: true };
}

/**
 * The value the sanitiser reads for a key: the model's proposal for the keys
 * it returned, else the current content. A required text the app lacks gets a
 * placeholder ({@link MISSING_TEXT}).
 */
function sanitiserInput(current, proposal) {
  const input = { ...current, ...proposal };
  for (const key of REQUIRED_TEXT_KEYS) {
    if (!input[key]) input[key] = MISSING_TEXT;
  }
  return input;
}

/** The variable of the draft with this name, or undefined. */
function variableNamed(variables, name) {
  return (Array.isArray(variables) ? variables : []).find(
    variable => isPlainObject(variable) && variable.name === name
  );
}

/**
 * Step 8 for `variables`: the sanitised fields (texts in `lang` only) with the
 * other languages of a field whose `name` stayed: its label, default and the
 * labels of options whose `value` stayed.
 */
function variablesWithLanguages(sanitized, currentVariables, lang) {
  return sanitized.map(variable => {
    const before = variableNamed(currentVariables, variable.name);
    const result = {
      name: variable.name,
      label: { ...localizedObject(before?.label), [lang]: variable.label[lang] },
      type: variable.type,
      required: variable.required
    };
    const otherDefaults = localizedObject(before?.defaultValue);
    delete otherDefaults[lang];
    if (variable.defaultValue) {
      result.defaultValue = { ...otherDefaults, [lang]: variable.defaultValue[lang] };
    } else if (Object.keys(otherDefaults).length > 0 && before?.type === variable.type) {
      result.defaultValue = otherDefaults;
    }
    if (variable.predefinedValues) {
      const beforeOptions = Array.isArray(before?.predefinedValues) ? before.predefinedValues : [];
      result.predefinedValues = variable.predefinedValues.map(option => {
        const known = beforeOptions.find(
          candidate => isPlainObject(candidate) && candidate.value === option.value
        );
        return {
          value: option.value,
          label: { ...localizedObject(known?.label), [lang]: option.label[lang] }
        };
      });
    }
    return result;
  });
}

/**
 * Step 8 for `starterPrompts`: the sanitised starters with the other languages
 * of the starter they replace: the one whose title or message in `lang` is the
 * same, else, when the number of starters stayed, the one at the same place.
 */
function startersWithLanguages(sanitized, currentStarters, lang) {
  const before = (Array.isArray(currentStarters) ? currentStarters : []).filter(isPlainObject);
  return sanitized.map((starter, index) => {
    const match =
      before.find(
        candidate =>
          textIn(candidate.title, lang) === starter.title[lang] ||
          textIn(candidate.message, lang) === starter.message[lang]
      ) || (before.length === sanitized.length ? before[index] : undefined);
    return {
      title: { ...localizedObject(match?.title), [lang]: starter.title[lang] },
      message: { ...localizedObject(match?.message), [lang]: starter.message[lang] }
    };
  });
}

/**
 * Step 8: the whole new value of a changed key. A localized text keeps its
 * other languages; an empty optional text removes the language, and the key
 * (`null`) when no language is left.
 */
function patchValue(key, sanitizedApp, source, lang) {
  if (REVISE_LOCALIZED_KEYS.includes(key)) {
    const value = localizedObject(source[key]);
    const text = sanitizedApp[key]?.[lang];
    if (text) value[lang] = text;
    else delete value[lang];
    return Object.keys(value).length > 0 ? value : null;
  }
  if (key === 'variables')
    return variablesWithLanguages(sanitizedApp.variables, source.variables, lang);
  if (key === 'starterPrompts') {
    return startersWithLanguages(sanitizedApp.starterPrompts, source.starterPrompts, lang);
  }
  return sanitizedApp[key] ?? null;
}

/** The first segment of a warning's `field`: `variables[0].label` → `variables`. */
function fieldRoot(field) {
  return String(field ?? '').split(/[.[]/)[0];
}

/**
 * Step 9: the patched app passes the schema of its target. Only issues on the
 * patched keys count: the request's untouched content is the author's own and
 * is checked by the save.
 *
 * @throws {ServiceError} `APP_GENERATOR_INVALID_ANSWER` (`incomplete`)
 */
function assertPatchFitsSchema({ source, draft, patch, personal, lang, modelId }) {
  const keys = new Set(Object.keys(patch));
  let result;
  if (personal) {
    result = userAppContentSchema.safeParse(applyRevisionPatch(source, patch));
  } else {
    const base = {
      ...newAppDefaults(lang),
      ...source,
      id: CHECK_APP_ID,
      allowEmptyContent: draft.allowEmptyContent === true
    };
    result = appConfigSchema.safeParse(applyRevisionPatch(base, patch));
  }
  if (result.success) return;
  const issues = result.error.issues.filter(issue => keys.has(String(issue.path[0])));
  if (issues.length === 0) return;
  // A bug in the sanitiser, not in the answer. The paths are logged, never a text.
  logger.error('A revised app does not pass the schema of its target', {
    component: COMPONENT,
    modelId,
    target: personal ? 'personal' : 'admin',
    issues: issues.map(issue => `${issue.path.join('.')}: ${issue.code}`)
  });
  throw invalidAnswer('incomplete', 'The change of the model could not be applied to the app');
}

/**
 * Steps 7 to 10: the patch, the changed keys, the warnings and the suggestions
 * of a change.
 */
function changeOf({ answer, source, current, allowed, draft, language, lang, sanitizeOptions }) {
  const proposed = isPlainObject(answer.change) ? answer.change : {};
  const proposal = {};
  const warnings = [];
  for (const [key, value] of Object.entries(proposed)) {
    if (SUGGESTION_KEYS.includes(key)) continue;
    if (!allowed.includes(key)) {
      warnings.push({ code: 'KEY_IGNORED', field: /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : '?' });
      continue;
    }
    // A required text cannot be removed in a conversation: an empty proposal is no proposal.
    if (REQUIRED_TEXT_KEYS.has(key) && !textIn(value, language)) continue;
    proposal[key] = value;
  }
  const suggestionInput = sanitizeOptions.mayPropose
    ? Object.fromEntries(
        SUGGESTION_KEYS.filter(key => key in proposed).map(key => [key, proposed[key]])
      )
    : {};

  // Both runs go through the same sanitiser, so a key differs only where the model changed it.
  const before = sanitizeGeneratedApp(sanitiserInput(current, {}), sanitizeOptions);
  const after = sanitizeGeneratedApp(
    { ...sanitiserInput(current, proposal), ...suggestionInput },
    sanitizeOptions
  );

  const changed = Object.keys(proposal).filter(key => !sameValue(after.app[key], before.app[key]));
  // A field no text used got its line in the message template: the template changes with its
  // fields, also when `fields` does not name it, or the new field would be asked for and ignored.
  if (
    changed.includes('variables') &&
    !changed.includes('prompt') &&
    !sameValue(after.app.prompt, before.app.prompt)
  ) {
    changed.push('prompt');
  }

  const patch = {};
  for (const key of changed) patch[key] = patchValue(key, after.app, source, lang);

  // `allowEmptyContent` is derived, never read: with a field in the message template a user can
  // send the form without typing a message. It is only switched on; an admin's choice stays.
  if (
    !sanitizeOptions.personal &&
    (changed.includes('variables') || changed.includes('prompt')) &&
    after.app.allowEmptyContent === true &&
    draft.allowEmptyContent !== true
  ) {
    patch.allowEmptyContent = true;
  }

  for (const warning of after.warnings) {
    if (warning.code !== 'KEY_IGNORED' && changed.includes(fieldRoot(warning.field))) {
      warnings.push(warning);
    }
  }
  return {
    patch,
    changed,
    warnings,
    suggestions: sanitizeOptions.mayPropose
      ? after.suggestions
      : { websearch: false, integrations: [] }
  };
}

/**
 * Have a chat model answer one turn of the conversation that changes an app.
 * Nothing is stored.
 *
 * The caller decides nothing about the model call: model, messages, token
 * limit and answer format are fixed here, as for a draft
 * ({@link import('./appGenerator.js').generateAppDraft}). The call counts
 * against the caller's usage limit (`telemetry.purpose: 'app-revise'`).
 *
 * @param {object} params
 * @param {object} params.draft - The app as the editor holds it. Only the content
 *   keys of the target are read ({@link appRevisionKeys}); `allowEmptyContent`
 *   is read for an admin app only, to tell whether a patch switches it on.
 * @param {Array<{ role: 'author'|'builder', kind?: string, text: string }>} params.conversation -
 *   1 to 12 entries, the last one by the author (checked by the route).
 * @param {string} params.language - The language of the app's texts in this turn.
 * @param {string[]} [params.fields] - A subset of the content keys the patch may hold.
 * @param {boolean} [params.allowQuestions=true] - `false`: the turn is never a question.
 * @param {object} params.user - The caller; limits the model and the suggestions.
 * @param {{ settings: object }|null} [params.personal] - Set for a personal app, with the
 *   effective `platform.userApps` settings: the content keys of a personal app, the
 *   personal-app schema and the personal ceiling for suggestions.
 * @param {AbortSignal} [params.signal] - Aborts the model call.
 * @param {object} [params.record] - Receives `modelId`, `usage`, `reply` and `changed`
 *   as far as the turn got, for the audit entry.
 * @param {{ complete: Function }} [params.llmClient] - The model client.
 * @returns {Promise<{ reply: 'question'|'change'|'message', text: string,
 *   question: { text: string, choices: string[], allowOther: true }|null, patch: object,
 *   changed: string[], suggestions: { websearch: boolean, integrations: object[] },
 *   warnings: Array<{ code: string, field: string }>, model: { id: string, name: string } }>}
 * @throws {ServiceError} `APP_REVISE_TOO_LONG` (400), `ABORTED` (499),
 *   `APP_GENERATOR_NO_MODEL` (503), `APP_GENERATOR_INVALID_ANSWER` (502). A failed
 *   model call throws the client's `LLMError`.
 * @example
 * const turn = await reviseApp({
 *   draft: { name: { en: 'Helper' }, description: { en: 'Helps.' }, system: { en: 'You help.' } },
 *   conversation: [{ role: 'author', text: 'Make it more formal' }],
 *   language: 'en',
 *   user: req.user
 * });
 * // → { reply: 'change', patch: { system: { en: 'You help. Address the reader formally.' } }, … }
 */
export async function reviseApp({
  draft,
  conversation,
  language,
  fields,
  allowQuestions = true,
  user,
  personal = null,
  signal,
  record = {},
  llmClient = defaultLlmClient
}) {
  const target = personal ? 'personal' : 'admin';
  const lang = baseLanguage(language);

  // 1. Keys: the target's content keys, narrowed by `fields`.
  const keys = appRevisionKeys(target);
  const allowed =
    Array.isArray(fields) && fields.length > 0
      ? keys.filter(key => fields.includes(key))
      : [...keys];
  const mayPropose = !(Array.isArray(fields) && fields.length > 0);

  // 2. Current content: the target's keys, hidden characters removed.
  const input = isPlainObject(draft) ? draft : {};
  const source = {};
  for (const key of keys) if (input[key] !== undefined) source[key] = visibleDeep(input[key]);
  assertRevisable(source, language);
  const current = contentForModel(source, keys, language);

  // 3. Model.
  const model = pickDraftModel(user);
  record.modelId = model.id;

  // 4. Messages.
  const turns = Array.isArray(conversation) ? conversation : [];
  const latest = turns.at(-1)?.text ?? '';
  const mayAsk = allowQuestions !== false && questionsSinceLastChange(turns) < REVISE_QUESTION_CAP;
  const categories = personal ? [] : appCategoryIds();
  const installed = mayPropose
    ? await installationsFor(user, language, personal ? { settings: personal.settings } : null)
    : [];
  const { messages } = buildRevisionMessages({
    content: current,
    earlier: turns.slice(0, -1),
    latest,
    language,
    keys: allowed,
    categories,
    mayAsk,
    mayPropose,
    integrationsBlock: integrationsBlock(installed)
  });

  // A request that was closed before this point must not start a paid call.
  if (signal?.aborted) {
    throw new ServiceError('ABORTED', 'The request was closed before the model was called');
  }

  // 5. Call. The same limits as a draft: one bounded call that a reasoning model cannot cut off.
  const result = await llmClient.complete({
    model,
    messages,
    options: { maxTokens: GENERATOR_MAX_TOKENS, responseFormat: 'json', thinkingEnabled: false },
    retries: 0,
    timeoutMs: GENERATOR_TIMEOUT_MS,
    signal,
    telemetry: { kind: 'utility', purpose: 'app-revise', user }
  });
  // The model was called and paid for, whatever becomes of its answer.
  record.usage = result?.usage || null;

  // 6. Parse.
  const answer = parseGeneratedAnswer(result?.content, result?.finishReason);
  let reply = replyKind(answer);
  let text = plainText(answer.text);
  let question = null;
  let patch = {};
  let changed = [];
  let warnings = [];
  let suggestions = { websearch: false, integrations: [] };

  if (reply === 'question') {
    const asked = questionOf(answer);
    if (mayAsk && asked.text) {
      question = asked;
    } else {
      // Not allowed in this turn, or the cap is reached: what the model wrote is a message.
      reply = 'message';
      text = text || asked.text;
    }
  } else if (reply === 'change') {
    // 7. to 10.
    const sanitizeOptions = {
      language,
      categories,
      installed,
      description: '',
      mayPropose,
      personal: personal
        ? { webSearch: personal.settings?.capabilities?.webSearch === true && searchFor(user) }
        : null
    };
    const outcome = changeOf({
      answer,
      source,
      current,
      allowed,
      draft: input,
      language,
      lang,
      sanitizeOptions
    });
    if (outcome.changed.length === 0) {
      reply = 'message';
      warnings = [
        ...outcome.warnings.filter(warning => warning.code === 'KEY_IGNORED'),
        { code: REVISE_WARNINGS.NO_CHANGE, field: '' }
      ];
    } else {
      assertPatchFitsSchema({
        source,
        draft: input,
        patch: outcome.patch,
        personal,
        lang,
        modelId: model.id
      });
      ({ patch, changed, suggestions } = outcome);
      warnings = outcome.warnings;
      if ([...languagesOf(source)].some(other => other !== lang)) {
        for (const key of changed) {
          if (
            REVISE_LOCALIZED_KEYS.includes(key) ||
            key === 'variables' ||
            key === 'starterPrompts'
          ) {
            warnings.push({ code: REVISE_WARNINGS.OTHER_LANGUAGES_UNCHANGED, field: key });
          }
        }
      }
    }
  }

  if (reply === 'message' && !text && !warnings.some(w => w.code === REVISE_WARNINGS.NO_CHANGE)) {
    throw invalidAnswer('incomplete', 'The answer of the model holds no reply');
  }

  record.reply = reply;
  record.changed = changed;

  logger.debug('Answered a revision turn', {
    component: COMPONENT,
    modelId: model.id,
    target,
    reply,
    changed,
    warnings: warnings.length,
    finishReason: result?.finishReason ?? null
  });

  const defaultLanguage = configCache.getPlatform()?.defaultLanguage || 'en';
  return {
    reply,
    text,
    question,
    patch,
    changed,
    suggestions,
    warnings,
    model: {
      id: model.id,
      name: getLocalizedString(model.name, lang, defaultLanguage, model.id)
    }
  };
}
