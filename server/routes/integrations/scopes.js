// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration scopes for the chat input (#3050): where an integration of an
 * app searches (iFinder search profiles) and whom it asks (iAssistants), as
 * the user may pick them.
 *
 *   GET /api/integrations/scopes?appId=&modelId=&lang=
 *     every integration of the app that offers scopes
 *   GET /api/integrations/:integrationId/scopes?appId=&modelId=&lang=
 *     one of them
 *
 * The chat route checks the scope a turn sends against the same lists
 * (`services/integrations/scopes`), so this route only decides what the
 * picker shows.
 */
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import {
  appScopeSettings,
  applicableScopeProviders,
  getScopeProvider
} from '../../services/integrations/scopes/index.js';
import { isValidId, sanitizeLanguageCode } from '../../utils/pathSecurity.js';
import { findByIdCaseInsensitive, hasIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { sendBadRequest, sendInternalError, sendNotFound } from '../../utils/responseHelpers.js';

const router = express.Router();

/** Whether the user's groups grant a resource (`apps`, `models`). */
function isPermitted(user, kind, id) {
  const allowed = user?.permissions?.[kind];
  if (!(allowed instanceof Set)) return false;
  return allowed.has('*') || hasIdCaseInsensitive(allowed, id);
}

/**
 * The app, model and user a scope request is about, or a response already sent.
 * @returns {{ app: Object, model: Object|undefined, user: Object, language: string }|null}
 */
function resolveContext(req, res) {
  const { appId, modelId } = req.query;
  if (!isValidId(appId)) {
    sendBadRequest(res, 'A valid appId is required');
    return null;
  }
  if (modelId !== undefined && !isValidId(modelId)) {
    sendBadRequest(res, 'Invalid modelId');
    return null;
  }

  // An app the user may not use answers like one that does not exist, so the
  // route cannot be used to probe app ids.
  const app = findByIdCaseInsensitive(configCache.getApps()?.data || [], appId);
  if (!app || app.enabled === false || !isPermitted(req.user, 'apps', app.id)) {
    sendNotFound(res, 'App');
    return null;
  }

  const wantedModel = modelId || app.preferredModel;
  const model = findByIdCaseInsensitive(configCache.getModels()?.data || [], wantedModel);
  return {
    app,
    // A model the user may not use contributes nothing.
    model: model && isPermitted(req.user, 'models', model.id) ? model : undefined,
    user: req.user,
    language: sanitizeLanguageCode(
      req.query.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0],
      configCache.getPlatform()?.defaultLanguage || 'en'
    )
  };
}

/** One integration's picker entry. */
async function describe(provider, { req, app, model, language, signal }) {
  const listing = await provider.listScopes({ user: req.user, app, model, language, signal });
  const { scopePicker } = appScopeSettings(app, provider.id);
  return {
    id: provider.id,
    name: provider.name,
    // `search` (where it searches) or `ask` (whom it asks), for the label.
    action: provider.action,
    // A fixed scope has nothing to pick; it is still shown so the user sees
    // where the next question goes.
    scopePicker,
    fixed: listing.fixed,
    defaultScope: listing.defaultScope,
    scopes: listing.scopes,
    source: listing.source,
    ...(listing.hint ? { hint: listing.hint } : {})
  };
}

/** An AbortSignal that fires when the client goes away before the answer. */
function requestSignal(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

/**
 * @swagger
 * /integrations/scopes:
 *   get:
 *     summary: Scopes the user can pick per integration of an app
 *     description: |
 *       Every integration the app uses that offers scopes (iFinder search
 *       profiles, iAssistants), with the scopes this user may pick, the
 *       default one, and where the chat input shows the picker. When an
 *       integration cannot be asked, its configured default is listed and
 *       `hint` says why.
 *     tags:
 *       - Integrations
 *     security:
 *       - bearerAuth: []
 *       - sessionAuth: []
 *     parameters:
 *       - in: query
 *         name: appId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: modelId
 *         schema:
 *           type: string
 *         description: The chat's model; defaults to the app's preferred model
 *       - in: query
 *         name: lang
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The integrations and their scopes
 *       400:
 *         description: Invalid appId or modelId
 *       401:
 *         description: Authentication required
 *       404:
 *         description: App not found or not available to the user
 */
router.get('/scopes', authRequired, async (req, res) => {
  const context = resolveContext(req, res);
  if (!context) return;
  try {
    const signal = requestSignal(res);
    const integrations = await Promise.all(
      applicableScopeProviders(context).map(provider =>
        describe(provider, { req, ...context, signal })
      )
    );
    res.json({ integrations });
  } catch (error) {
    return sendInternalError(res, error, 'list integration scopes');
  }
});

/**
 * @swagger
 * /integrations/{integrationId}/scopes:
 *   get:
 *     summary: Scopes the user can pick for one integration of an app
 *     tags:
 *       - Integrations
 *     security:
 *       - bearerAuth: []
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *           enum: [ifinder, iassistant]
 *       - in: query
 *         name: appId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: modelId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The integration's scopes
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Unknown integration, or one the app does not use
 */
router.get('/:integrationId/scopes', authRequired, async (req, res) => {
  const provider = isValidId(req.params.integrationId)
    ? getScopeProvider(req.params.integrationId)
    : null;
  if (!provider) return sendNotFound(res, 'Integration');
  const context = resolveContext(req, res);
  if (!context) return;
  if (!applicableScopeProviders(context).includes(provider)) {
    return sendNotFound(res, 'Integration');
  }
  try {
    res.json(await describe(provider, { req, ...context, signal: requestSignal(res) }));
  } catch (error) {
    return sendInternalError(res, error, 'list integration scopes');
  }
});

export default router;
