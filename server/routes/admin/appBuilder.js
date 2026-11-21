// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { createAppGeneratorLimiter } from '../../middleware/rateLimiting.js';
import { requireFeature } from '../../featureRegistry.js';
import { generateAppDraft } from '../../services/appGenerator.js';
import { loadAppTemplates } from '../../services/appTemplates.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isLLMError } from '../../services/loop/contracts/errors.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { LANGUAGE_CODE_PATTERN } from '../../../shared/validationPatterns.js';
import { APP_GENERATOR_DESCRIPTION_MAX } from '../../../shared/appGenerator.js';

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
  const draftLimiter = createAppGeneratorLimiter(configCache.getPlatform() || {});

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
        ...(record.brief ? { brief: record.brief } : {}),
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
   *       standard chat model among the models the caller may use. The brief is
   *       the server's own (`brief: standard`) unless an admin changed the
   *       library prompt `app-generator` (`brief: customised`); the server
   *       appends its output rules in both cases. The call counts against the
   *       caller's usage limit.
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
   *               required: [app, suggestions, warnings, model, brief]
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
   *                         enum: [FIELD_DROPPED, STARTER_DROPPED, TEXT_SHORTENED, CATEGORY_REPLACED, COLOR_REPLACED, ICON_REPLACED, FIELD_TYPE_REPLACED, DESCRIPTION_ADDED, FIELD_ADDED_TO_TEMPLATE, KEY_IGNORED]
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
   *                 brief:
   *                   type: string
   *                   enum: [standard, customised]
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
   *               brief: "standard"
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
