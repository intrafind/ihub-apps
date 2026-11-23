// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { appGeneratorLimiter, appReviseLimiter } from '../../middleware/rateLimiting.js';
import { requireFeature } from '../../featureRegistry.js';
import { generateAppDraft } from '../../services/appGenerator.js';
import { assertRevisable, reviseApp } from '../../services/appRevision.js';
import { loadAppTemplates } from '../../services/appTemplates.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isLLMError } from '../../services/loop/contracts/errors.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { LANGUAGE_CODE_PATTERN } from '../../../shared/validationPatterns.js';
import { APP_GENERATOR_DESCRIPTION_MAX } from '../../../shared/appGenerator.js';
import { primaryLanguageOf } from '../../../shared/appDefaults.js';
import {
  REVISE_AUTHOR_TEXT_MAX,
  REVISE_BUILDER_KINDS,
  REVISE_BUILDER_TEXT_MAX,
  REVISE_CONVERSATION_MAX,
  REVISE_ROLES,
  appRevisionKeys
} from '../../../shared/appRevision.js';

/** The feature that switches drafting with AI on and off (Admin → Features). */
const FEATURE_ID = 'appGenerator';

/** A refused body: 400 `VALIDATION_FAILED` that names the member. */
function invalid(path, code, message) {
  return new ServiceError('VALIDATION_FAILED', message, { details: [{ path, code, message }] });
}

/**
 * The two members of a draft request. Nothing else of the body is read: the
 * caller cannot send messages, a model, a token limit or a schema.
 *
 * @param {unknown} body
 * @returns {{ description: string, language: string }}
 * @throws {ServiceError} `VALIDATION_FAILED`
 */
export function parseDraftRequest(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof input.description !== 'string') {
    throw invalid('description', 'REQUIRED', 'description must be a text');
  }
  const description = input.description.trim();
  if (!description) throw invalid('description', 'REQUIRED', 'description must not be empty');
  if (description.length > APP_GENERATOR_DESCRIPTION_MAX) {
    throw invalid(
      'description',
      'TOO_LONG',
      `description must have at most ${APP_GENERATOR_DESCRIPTION_MAX} characters`
    );
  }
  const language =
    input.language === undefined || input.language === null
      ? configCache.getPlatform()?.defaultLanguage || 'en'
      : input.language;
  if (typeof language !== 'string' || !LANGUAGE_CODE_PATTERN.test(language)) {
    throw invalid(
      'language',
      'INVALID',
      'language must be a language code such as "en" or "de-DE"'
    );
  }
  return { description, language };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One entry of `conversation`: `role`, `text` and, for a builder entry, the
 * optional `kind`. Author texts are trimmed and must not be empty. A refusal
 * names the member as a path (`['conversation', 2, 'text']`), which the error
 * body turns into the pointer `/conversation/2/text`.
 */
function parseConversationEntry(entry, index) {
  const at = (...rest) => ['conversation', index, ...rest];
  const name = `conversation[${index}]`;
  if (!isPlainObject(entry)) throw invalid(at(), 'INVALID', `${name} must be an object`);
  if (!REVISE_ROLES.includes(entry.role)) {
    throw invalid(at('role'), 'INVALID', `${name}.role must be one of: ${REVISE_ROLES.join(', ')}`);
  }
  if (typeof entry.text !== 'string') {
    throw invalid(at('text'), 'REQUIRED', `${name}.text must be a text`);
  }
  const text = entry.text.trim();
  const max = entry.role === 'author' ? REVISE_AUTHOR_TEXT_MAX : REVISE_BUILDER_TEXT_MAX;
  if (entry.role === 'author' && !text) {
    throw invalid(at('text'), 'REQUIRED', `${name}.text must not be empty`);
  }
  if (text.length > max) {
    throw invalid(at('text'), 'TOO_LONG', `${name}.text must have at most ${max} characters`);
  }
  if (entry.role === 'author') return { role: 'author', text };
  if (entry.kind !== undefined && !REVISE_BUILDER_KINDS.includes(entry.kind)) {
    throw invalid(
      at('kind'),
      'INVALID',
      `${name}.kind must be one of: ${REVISE_BUILDER_KINDS.join(', ')}`
    );
  }
  return { role: 'builder', ...(entry.kind ? { kind: entry.kind } : {}), text };
}

/**
 * The members of a revision request (`POST /api/admin/apps/_revise`,
 * `POST /api/apps/_revise`). Nothing else of the body is read: the caller
 * cannot send messages, a model, a token limit or a schema. Of `draft`, the
 * engine reads only the content keys of the target.
 *
 * Instructions longer than a turn can revise are refused here, before the
 * revise limit counts the request.
 *
 * @param {unknown} body
 * @param {Object} [options]
 * @param {'admin'|'personal'} [options.target='admin'] - Which content keys `fields` may name.
 * @returns {{ draft: Object, conversation: Array<{ role: string, kind?: string, text: string }>,
 *   fields: string[]|undefined, allowQuestions: boolean, language: string }}
 * @throws {ServiceError} `VALIDATION_FAILED` naming the member, `APP_REVISE_TOO_LONG`
 */
export function parseRevisionRequest(body, { target = 'admin' } = {}) {
  const input = isPlainObject(body) ? body : {};
  if (!isPlainObject(input.draft)) throw invalid('draft', 'REQUIRED', 'draft must be an object');
  const draft = input.draft;

  if (!Array.isArray(input.conversation) || input.conversation.length === 0) {
    throw invalid(
      'conversation',
      'REQUIRED',
      'conversation must be a list with at least one entry'
    );
  }
  if (input.conversation.length > REVISE_CONVERSATION_MAX) {
    throw invalid(
      'conversation',
      'TOO_LONG',
      `conversation must have at most ${REVISE_CONVERSATION_MAX} entries`
    );
  }
  const conversation = input.conversation.map(parseConversationEntry);
  if (conversation.at(-1).role !== 'author') {
    throw invalid(
      ['conversation', conversation.length - 1, 'role'],
      'INVALID',
      'The last entry of conversation must be by the author'
    );
  }

  let fields;
  if (input.fields !== undefined && input.fields !== null) {
    const keys = appRevisionKeys(target);
    if (!Array.isArray(input.fields) || input.fields.length === 0) {
      throw invalid('fields', 'INVALID', 'fields must be a list of at least one content key');
    }
    input.fields.forEach((field, index) => {
      if (typeof field !== 'string' || !keys.includes(field)) {
        throw invalid(
          ['fields', index],
          'INVALID',
          `fields[${index}] must be one of: ${keys.join(', ')}`
        );
      }
    });
    fields = [...new Set(input.fields)];
  }

  if (input.allowQuestions !== undefined && typeof input.allowQuestions !== 'boolean') {
    throw invalid('allowQuestions', 'INVALID', 'allowQuestions must be true or false');
  }

  const platformLanguage = configCache.getPlatform()?.defaultLanguage || 'en';
  const language =
    input.language === undefined || input.language === null
      ? primaryLanguageOf(draft, undefined, platformLanguage)
      : input.language;
  if (typeof language !== 'string' || !LANGUAGE_CODE_PATTERN.test(language)) {
    throw invalid(
      'language',
      'INVALID',
      'language must be a language code such as "en" or "de-DE"'
    );
  }
  assertRevisable(draft, language);

  return { draft, conversation, fields, allowQuestions: input.allowQuestions !== false, language };
}

/**
 * The audit details of a revision turn: what it used and what it answered,
 * never a text of the draft, the conversation or the answer.
 *
 * @param {{ request?: Object, record?: Object }} [turn] - `req.appRevision`.
 * @returns {Object}
 */
export function revisionAuditDetails({ request, record = {} } = {}) {
  return {
    purpose: 'app-revise',
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.reply ? { reply: record.reply } : {}),
    ...(record.changed ? { changed: record.changed } : {}),
    ...(request
      ? {
          conversationLength: request.conversation.length,
          lastMessageLength: request.conversation.at(-1).text.length
        }
      : {})
  };
}

/**
 * Run a model call that stops when the client goes away: "Cancel" and the
 * client's timeout close the request, and the paid call stops with it.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(signal: AbortSignal) => Promise<*>} run
 * @returns {Promise<*>}
 */
export async function withClientAbort(req, res, run) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  // 'close' is emitted once. A client that went away while the middleware before the
  // handler ran (the limiter can wait for the cluster primary) is only seen here.
  if (res.destroyed || req.socket?.destroyed) controller.abort();
  try {
    return await run(controller.signal);
  } finally {
    res.off('close', onClose);
  }
}

/** The registry code an error of the draft route is answered with, for the audit entry. */
function codeOf(error) {
  if (error instanceof ServiceError || isLLMError(error)) return error.code || 'INTERNAL_ERROR';
  return 'INTERNAL_ERROR';
}

/**
 * The routes of the app builder (Admin → Apps → New): the AI draft and the
 * template gallery. Both are open to content admins, sit under `/api/admin`
 * (so the admin rate limit applies) and store nothing.
 *
 * @param {import('express').Express} app
 * @param {object} [dependencies]
 * @param {{ complete: Function }} [dependencies.llmClient] - The model client of the draft.
 */
export default function registerAdminAppBuilderRoutes(app, { llmClient } = {}) {
  const draftLimiter = appGeneratorLimiter(configCache.getPlatform() || {});

  /** Validates the body before the draft limit counts, so only real drafts are counted. */
  const readDraftRequest = (req, _res, next) => {
    req.appDraft = { request: parseDraftRequest(req.body), record: {} };
    next();
  };

  /**
   * Every draft request leaves one audit entry, whatever its outcome. It never
   * holds the description or the model's answer.
   */
  const auditDraft = (req, result, extra = {}) => {
    const { request, record = {} } = req.appDraft || {};
    logAudit({
      req,
      action: 'execute',
      resource: 'app',
      resourceId: '',
      summary:
        result === 'success' ? 'Prepared an app draft with AI' : 'An app draft with AI failed',
      result,
      details: {
        purpose: 'app-generator',
        ...(record.modelId ? { modelId: record.modelId } : {}),
        ...(record.usage ? { usage: record.usage } : {}),
        ...(request ? { descriptionLength: request.description.length } : {}),
        ...extra
      }
    });
  };

  /**
   * @swagger
   * /api/admin/apps/_generate:
   *   post:
   *     summary: Prepare the draft of an app from a description
   *     description: |
   *       Has a chat model turn a description into the draft of an app. Nothing
   *       is stored: the answer is the body for `POST /api/admin/apps`, which
   *       the author reviews first.
   *
   *       The server decides everything about the model call. The model is the
   *       one an administrator set in `platform.appGenerator.modelId` when the
   *       caller may use it, otherwise the standard chat model among the models
   *       the caller may use. The brief is
   *       always the server's own, followed by its output rules. The call
   *       counts against the caller's usage limit.
   *
   *       The answer of the model never reaches the caller as it is. The server
   *       builds the app from an allow-list (texts, input fields, conversation
   *       starters, icon, colour, category) and checks it against the app
   *       schema. The app is not published (`enabled: false`) and binds nothing:
   *       web search and connected systems the model proposed come back under
   *       `suggestions`, limited to installations the caller may use.
   *
   *       Limited to 30 drafts per user per hour; failed drafts count.
   *     tags:
   *       - Admin - Apps
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [description]
   *             properties:
   *               description:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 2000
   *                 description: What the app should do, in the author's words (counted after trimming)
   *               language:
   *                 type: string
   *                 pattern: '^[a-z]{2}(-[A-Z]{2})?$'
   *                 description: Language of every text of the draft (default is the platform's default language)
   *           example:
   *             description: "An app that summarizes long emails in three sentences."
   *             language: "en"
   *     responses:
   *       200:
   *         description: The draft
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [app, suggestions, warnings, model]
   *               properties:
   *                 app:
   *                   $ref: '#/components/schemas/AdminApplication'
   *                 suggestions:
   *                   type: object
   *                   description: What the model proposed and the caller may use. Nothing of it is set on `app`.
   *                   required: [websearch, integrations]
   *                   properties:
   *                     websearch:
   *                       type: boolean
   *                     integrations:
   *                       type: array
   *                       items:
   *                         type: object
   *                         required: [id, label, actions]
   *                         properties:
   *                           id:
   *                             type: string
   *                           label:
   *                             type: string
   *                           actions:
   *                             type: array
   *                             description: The actions to bind; empty means all functions of the system
   *                             items:
   *                               type: string
   *                 warnings:
   *                   type: array
   *                   description: What the server dropped, shortened, replaced, added or ignored
   *                   items:
   *                     type: object
   *                     required: [code, field]
   *                     properties:
   *                       code:
   *                         type: string
   *                         enum: [FIELD_DROPPED, FIELD_DEFAULT_DROPPED, PLACEHOLDER_WITHOUT_FIELD, STARTER_DROPPED, TEXT_SHORTENED, CATEGORY_REPLACED, COLOR_REPLACED, ICON_REPLACED, FIELD_TYPE_REPLACED, DESCRIPTION_ADDED, FIELD_ADDED_TO_TEMPLATE, KEY_IGNORED]
   *                       field:
   *                         type: string
   *                 model:
   *                   type: object
   *                   description: The model that prepared the draft
   *                   required: [id, name]
   *                   properties:
   *                     id:
   *                       type: string
   *                     name:
   *                       type: string
   *             example:
   *               app:
   *                 id: "email-summary"
   *                 name: { en: "Email summary" }
   *                 description: { en: "Summarizes long emails in three sentences." }
   *                 system: { en: "You summarize emails. Answer in three sentences." }
   *                 color: "#4F46E5"
   *                 icon: "mail"
   *                 enabled: false
   *               suggestions:
   *                 websearch: false
   *                 integrations: []
   *               warnings: []
   *               model: { id: "gemini-flash", name: "Gemini Flash" }
   *       400:
   *         description: The body is invalid (`VALIDATION_FAILED`), or the model refused the request (`INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not a content admin, or a machine or delegated principal (`FORBIDDEN`); drafting with AI is switched off (`FEATURE_DISABLED`)
   *       404:
   *         description: The provider does not know the model (`MODEL_NOT_FOUND`)
   *       422:
   *         description: The model refused the description (`CONTENT_POLICY`)
   *       429:
   *         description: More than 30 drafts in an hour (`RATE_LIMITED` with `details.limiter` `appGenerator`), above the admin budget or a throttled provider (`RATE_LIMITED`), or the caller's usage limit is reached (`QUOTA_EXCEEDED`)
   *       499:
   *         description: The request was closed before the model answered (`ABORTED`)
   *       502:
   *         description: The answer is not JSON, is cut off or leaves nothing usable (`APP_GENERATOR_INVALID_ANSWER` with `details.reason` `not-json`, `truncated` or `incomplete`); the model call failed (`PROVIDER_ERROR`, `NETWORK`, `EMPTY_RESPONSE`, `AUTH_FAILED`)
   *       503:
   *         description: No chat model the caller may use (`APP_GENERATOR_NO_MODEL`)
   *       504:
   *         description: The model did not answer in time (`TIMEOUT`)
   */
  app.post(
    buildServerPath('/api/admin/apps/_generate'),
    contentAdminAuth,
    requireFeature(FEATURE_ID),
    readDraftRequest,
    draftLimiter,
    async (req, res) => {
      const { request, record } = req.appDraft;

      // "Cancel" and a client timeout close the request; the paid model call stops with it.
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      // 'close' is emitted once. A client that went away while the middleware before this
      // handler ran (the draft limiter can wait for the cluster primary) is only seen here.
      if (res.destroyed || req.socket?.destroyed) controller.abort();

      try {
        const draft = await generateAppDraft({
          description: request.description,
          language: request.language,
          user: req.user,
          signal: controller.signal,
          record,
          ...(llmClient ? { llmClient } : {})
        });
        auditDraft(req, 'success');
        res.json(draft);
      } finally {
        res.off('close', onClose);
      }
    },
    // The failure entry: without it the audit safety net would record the request, and at
    // the `request` verbosity that includes the body, which is the author's description.
    // Like the safety net, it records signed-in callers only: a request without a sign-in
    // must not be able to fill the audit log.
    (error, req, _res, next) => {
      if (req.user?.id && req.user.id !== 'anonymous') {
        auditDraft(req, 'failure', { code: codeOf(error) });
      }
      next(error);
    }
  );

  const reviseLimiter = appReviseLimiter(configCache.getPlatform() || {});

  /** Validates the body before the revise limit counts, so only real turns are counted. */
  const readRevisionRequest = (req, _res, next) => {
    req.appRevision = { request: parseRevisionRequest(req.body), record: {} };
    next();
  };

  /**
   * Every revision turn leaves one audit entry, whatever its outcome. It never
   * holds a text of the draft, the conversation or the answer.
   */
  const auditRevision = (req, result, extra = {}) => {
    logAudit({
      req,
      action: 'execute',
      resource: 'app',
      resourceId: '',
      summary:
        result === 'success'
          ? 'Answered a request to change an app with AI'
          : 'A request to change an app with AI failed',
      result,
      details: { ...revisionAuditDetails(req.appRevision), ...extra }
    });
  };

  /**
   * @swagger
   * components:
   *   schemas:
   *     AppRevisionTurn:
   *       type: object
   *       required: [reply, text, question, patch, changed, suggestions, warnings, model]
   *       properties:
   *         reply:
   *           type: string
   *           enum: [question, change, message]
   *         text:
   *           type: string
   *           maxLength: 300
   *           description: Plain text to the author, in the language of their latest message; never Markdown or HTML. May be empty for a change.
   *         question:
   *           type: object
   *           nullable: true
   *           description: Set when `reply` is `question`
   *           required: [text, choices, allowOther]
   *           properties:
   *             text: { type: string, maxLength: 300 }
   *             choices: { type: array, maxItems: 6, items: { type: string, maxLength: 100 } }
   *             allowOther: { type: boolean, enum: [true] }
   *         patch:
   *           type: object
   *           description: The whole new value of every changed key; `null` removes a key. Empty unless `reply` is `change`.
   *         changed:
   *           type: array
   *           description: The keys of `patch` the model changed (an added template line counts under `prompt`)
   *           items: { type: string }
   *         suggestions:
   *           type: object
   *           required: [websearch, integrations]
   *           description: What the model proposed and the caller may use; never part of `patch`
   *           properties:
   *             websearch: { type: boolean }
   *             integrations:
   *               type: array
   *               items:
   *                 type: object
   *                 required: [id, label, actions]
   *                 properties:
   *                   id: { type: string }
   *                   label: { type: string }
   *                   actions: { type: array, items: { type: string } }
   *         warnings:
   *           type: array
   *           description: What the server dropped, shortened, replaced or added on the changed keys; `NO_CHANGE` when a change changed nothing (`reply` is then `message`); `OTHER_LANGUAGES_UNCHANGED` per changed key of an app with texts in other languages
   *           items:
   *             type: object
   *             required: [code, field]
   *             properties:
   *               code: { type: string }
   *               field: { type: string }
   *         model:
   *           type: object
   *           required: [id, name]
   *           properties:
   *             id: { type: string }
   *             name: { type: string }
   */

  /**
   * @swagger
   * /api/admin/apps/_revise:
   *   post:
   *     summary: Answer one turn of the conversation that changes an app
   *     description: |
   *       Has a chat model answer the author's latest message about an app: with
   *       one question, one change or one message. Nothing is stored: a change is
   *       a `patch` the editor merges into its form and saves with
   *       `PUT /api/admin/apps/{appId}` (with `If-Match`).
   *
   *       The server decides everything about the model call, as for
   *       `POST /api/admin/apps/_generate`: the model (`platform.appGenerator.modelId`
   *       when the caller may use it, else the standard chat model among the
   *       models the caller may use), the brief and its output rules. The call
   *       counts against the caller's usage limit.
   *
   *       Of `draft` only the content keys are read (`name`, `description`,
   *       `system`, `prompt`, `messagePlaceholder`, `variables`, `starterPrompts`,
   *       `category`, `color`, `icon`). A change passes the allow-list and the
   *       sanitiser of a draft; `patch` holds only the keys the model changed,
   *       each as its whole new value, with the other languages of a localized
   *       text kept. It may also hold `allowEmptyContent: true` when a new input
   *       field went into the message template. The patched app passes the app
   *       schema. Web search and connected systems the model proposed come back
   *       under `suggestions`, limited to installations the caller may use, and
   *       never in `patch`.
   *
   *       After three questions since the last change, and always with
   *       `allowQuestions: false`, a question the model asks is answered as a
   *       `message`.
   *
   *       Limited to 60 turns per user per hour, together with `POST /api/apps/_revise`;
   *       failed turns count.
   *     tags:
   *       - Admin - Apps
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [draft, conversation]
   *             properties:
   *               draft:
   *                 type: object
   *                 description: The app as the editor holds it; only its content keys are read
   *               conversation:
   *                 type: array
   *                 minItems: 1
   *                 maxItems: 12
   *                 description: The conversation so far, oldest first; the last entry is the author's latest message
   *                 items:
   *                   type: object
   *                   required: [role, text]
   *                   properties:
   *                     role:
   *                       type: string
   *                       enum: [author, builder]
   *                     kind:
   *                       type: string
   *                       enum: [question, change, message]
   *                       description: Builder entries only; what that turn answered (questions since the last change are counted)
   *                     text:
   *                       type: string
   *                       description: At most 1000 characters for the author (not empty, counted after trimming), 500 for the builder
   *               fields:
   *                 type: array
   *                 minItems: 1
   *                 description: The content keys the change may touch; all of them when absent. With fields, nothing is proposed under `suggestions`.
   *                 items:
   *                   type: string
   *                   enum: [name, description, system, prompt, messagePlaceholder, variables, starterPrompts, category, color, icon]
   *               allowQuestions:
   *                 type: boolean
   *                 default: true
   *                 description: false means the answer is never a question
   *               language:
   *                 type: string
   *                 pattern: '^[a-z]{2}(-[A-Z]{2})?$'
   *                 description: Language of the app's texts in this turn (default is the app's primary language)
   *           example:
   *             language: "de"
   *             draft:
   *               name: { de: "Onboarding-Helfer" }
   *               description: { de: "Beantwortet Fragen neuer Kollegen." }
   *               system: { de: "Du beantwortest Fragen neuer Kollegen.", en: "You answer questions of new colleagues." }
   *             conversation:
   *               - role: author
   *                 text: "Mach es förmlicher"
   *             allowQuestions: true
   *     responses:
   *       200:
   *         description: The answer of this turn
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppRevisionTurn'
   *             example:
   *               reply: change
   *               text: "Der Ton ist jetzt förmlich."
   *               question: null
   *               patch:
   *                 system: { de: "Sie beantworten Fragen neuer Kolleginnen und Kollegen.", en: "You answer questions of new colleagues." }
   *               changed: [system]
   *               suggestions: { websearch: false, integrations: [] }
   *               warnings: [{ code: OTHER_LANGUAGES_UNCHANGED, field: system }]
   *               model: { id: "gemini-flash", name: "Gemini Flash" }
   *       400:
   *         description: The body is invalid (`VALIDATION_FAILED`), the instructions are longer than 8000 characters (`APP_REVISE_TOO_LONG` with `details.max`), or the model refused the request (`INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`)
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not a content admin, or a machine or delegated principal (`FORBIDDEN`); drafting with AI is switched off (`FEATURE_DISABLED`)
   *       429:
   *         description: More than 60 turns in an hour (`RATE_LIMITED` with `details.limiter` `appRevise`), above the admin budget or a throttled provider (`RATE_LIMITED`), or the caller's usage limit is reached (`QUOTA_EXCEEDED`)
   *       499:
   *         description: The request was closed before the model answered (`ABORTED`)
   *       502:
   *         description: The answer is not JSON, is cut off or leaves nothing usable (`APP_GENERATOR_INVALID_ANSWER` with `details.reason` `not-json`, `truncated` or `incomplete`); the model call failed (`PROVIDER_ERROR`, `NETWORK`, `EMPTY_RESPONSE`, `AUTH_FAILED`)
   *       503:
   *         description: No chat model the caller may use (`APP_GENERATOR_NO_MODEL`)
   *       504:
   *         description: The model did not answer in time (`TIMEOUT`)
   */
  app.post(
    buildServerPath('/api/admin/apps/_revise'),
    contentAdminAuth,
    requireFeature(FEATURE_ID),
    readRevisionRequest,
    reviseLimiter,
    async (req, res) => {
      const { request, record } = req.appRevision;
      const turn = await withClientAbort(req, res, signal =>
        reviseApp({
          draft: request.draft,
          conversation: request.conversation,
          language: request.language,
          fields: request.fields,
          allowQuestions: request.allowQuestions,
          user: req.user,
          signal,
          record,
          ...(llmClient ? { llmClient } : {})
        })
      );
      auditRevision(req, 'success');
      res.json(turn);
    },
    // The failure entry: without it the audit safety net would record the request, and at
    // the `request` verbosity that includes the body, which holds the draft and the conversation.
    (error, req, _res, next) => {
      if (req.user?.id && req.user.id !== 'anonymous') {
        auditRevision(req, 'failure', { code: codeOf(error) });
      }
      next(error);
    }
  );

  /**
   * @swagger
   * /api/admin/app-templates:
   *   get:
   *     summary: List the templates of the app builder
   *     description: |
   *       The starting texts of the template gallery (Admin → Apps → New). A
   *       template ships with the server and holds content only: name, short
   *       description, instructions, message template, input fields,
   *       conversation starters, icon, colour and category, in English and
   *       German. It binds nothing and changes no setting.
   *
   *       `GET /api/admin/apps/templates` is a different list: the enabled apps
   *       of the installation, for "Copy an existing app".
   *     tags:
   *       - Admin - Apps
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: The templates, in the order of the gallery
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [items, nextCursor]
   *               properties:
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [id, name, description, icon, color, category, hasInputFields, app]
   *                     properties:
   *                       id:
   *                         type: string
   *                         example: "summarizer"
   *                       name:
   *                         type: object
   *                         description: Localized name
   *                         additionalProperties:
   *                           type: string
   *                       description:
   *                         type: object
   *                         description: Localized short description
   *                         additionalProperties:
   *                           type: string
   *                       icon:
   *                         type: string
   *                       color:
   *                         type: string
   *                       category:
   *                         type: string
   *                       hasInputFields:
   *                         type: boolean
   *                       app:
   *                         type: object
   *                         description: The content a draft is made from (the item's fields plus `system`, `prompt`, `messagePlaceholder`, `variables`, `starterPrompts`, `allowEmptyContent` where the template has them)
   *                 nextCursor:
   *                   type: string
   *                   nullable: true
   *                   description: Always null; the list is complete
   *       401:
   *         description: Not signed in (`AUTH_REQUIRED`)
   *       403:
   *         description: Not a content admin (`FORBIDDEN`)
   *       429:
   *         description: Above the admin budget (`RATE_LIMITED`)
   */
  app.get(buildServerPath('/api/admin/app-templates'), contentAdminAuth, async (req, res) => {
    res.json({ items: await loadAppTemplates(), nextCursor: null });
  });
}
