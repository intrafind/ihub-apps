// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-use acknowledgement, user side (#3326).
 *
 * - `GET  /api/eu-ai-act/acknowledgements/me`: the notice the caller has to confirm and
 *   whether they did. Per user and language, so never cached.
 * - `POST /api/eu-ai-act/acknowledgements/me`: confirm the current version.
 *
 * Works for the anonymous principal too: a guest's confirmation is a signed
 * cookie plus an audit entry (there is no users.json record).
 */
import { z } from 'zod';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { buildPublicBaseUrl } from '../utils/publicBaseUrl.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../utils/authorization.js';
import { ServiceError } from '../utils/ServiceError.js';
import { sendCreated } from '../utils/created.js';
import validate from '../validators/validate.js';
import { logAudit } from '../services/AuditLogService.js';
import { attachGuestIdentity, guestIdOf, guestOwnerId } from '../services/chat/chatOwner.js';
import { loadUsers, recordAiAcknowledgement } from '../utils/userManager.js';
import {
  firstPartyClientKind,
  getSettings,
  resolveText,
  textHash,
  usersFilePath
} from '../services/aiAcknowledgement/aiAcknowledgementService.js';
import { evaluateAcknowledgement } from '../middleware/aiAcknowledgementRequired.js';
import {
  hasValidAcknowledgementCookie,
  setAcknowledgementCookie
} from '../services/aiAcknowledgement/guestAcknowledgement.js';
import { LANGUAGE_CODE_PATTERN } from '../../shared/validationPatterns.js';

const ME_PATH = '/api/eu-ai-act/acknowledgements/me';

const acknowledgeSchema = {
  body: z
    .object({
      version: z.number().int().min(1),
      textHash: z.string().min(1).max(100),
      language: z.string().regex(LANGUAGE_CODE_PATTERN).optional()
    })
    .strict()
};

/** The caller's principal, built like `/api/usage/me` does for a missing one. */
function principalOf(req, res) {
  if (req.user) return req.user;
  const platform = configCache.getPlatform() || {};
  if (!isAnonymousAccessAllowed(platform)) return null;
  const user = enhanceUserWithPermissions(null, platform.auth || {}, platform);
  req.user = user;
  attachGuestIdentity(req, res);
  return user;
}

/**
 * The policy link as the client can open it. A site-relative `/path` would
 * resolve against `chrome-extension://...` in the extension, against the Office
 * add-in's host, or drop the base path of a sub-path deployment, so it leaves
 * here absolute. An http(s) link is returned as it is.
 */
function absolutePolicyUrl(policyUrl, req) {
  if (!policyUrl.startsWith('/')) return policyUrl;
  return `${buildPublicBaseUrl(req)}${policyUrl}`;
}

function requestedLanguage(req, platform) {
  return (
    (typeof req.query.language === 'string' && req.query.language) ||
    req.headers['accept-language']?.split(',')[0]?.split('-')[0] ||
    platform.defaultLanguage ||
    'en'
  );
}

export default function registerAiAcknowledgementRoutes(app) {
  /**
   * @swagger
   * /api/eu-ai-act/acknowledgements/me:
   *   get:
   *     summary: The AI-use notice the caller has to confirm
   *     tags: [AI Acknowledgement]
   *     parameters:
   *       - in: query
   *         name: language
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: >-
   *           The notice (enabled, enforce, requiredVersion, acknowledged, text, textHash,
   *           language, policyUrl, history). With the feature off only enabled false,
   *           enforce false, acknowledged true and requiredVersion.
   */
  app.get(buildServerPath(ME_PATH), authRequired, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    const settings = getSettings(platform);
    res.set('Cache-Control', 'no-store');
    const user = principalOf(req, res);
    if (!settings.enabled) {
      return res.json({
        enabled: false,
        enforce: false,
        acknowledged: true,
        requiredVersion: settings.requiredVersion
      });
    }
    const { text, language } = resolveText(
      settings,
      requestedLanguage(req, platform),
      platform.defaultLanguage
    );
    const body = {
      enabled: true,
      enforce: settings.enforce,
      requiredVersion: settings.requiredVersion,
      acknowledged: user ? (await evaluateAcknowledgement(req, settings)).acknowledged : false,
      text,
      textHash: textHash(text),
      language,
      policyUrl: absolutePolicyUrl(settings.policyUrl, req),
      // Where "Open iHub in its own tab" goes (a frame that drops the guest cookie).
      appUrl: buildPublicBaseUrl(req)
    };
    const record =
      user?.id && user.id !== 'anonymous'
        ? loadUsers(usersFilePath(platform)).users?.[user.id]
        : null;
    if (record) {
      body.history = Array.isArray(record.aiAcknowledgements) ? record.aiAcknowledgements : [];
    }
    return res.json(body);
  });

  /**
   * @swagger
   * /api/eu-ai-act/acknowledgements/me:
   *   post:
   *     summary: Confirm the current AI-use notice
   *     tags: [AI Acknowledgement]
   *     responses:
   *       201:
   *         description: Recorded; the body is the new entry
   *       200:
   *         description: Already confirmed at this version
   *       403:
   *         description: The feature is off (FEATURE_DISABLED)
   *       409:
   *         description: The version or the text changed (CONFLICT, details.requiredVersion)
   */
  app.post(
    buildServerPath(ME_PATH),
    authRequired,
    validate(acknowledgeSchema),
    async (req, res) => {
      const platform = configCache.getPlatform() || {};
      const settings = getSettings(platform);
      if (!settings.enabled) {
        throw new ServiceError('FEATURE_DISABLED', 'The AI-use acknowledgement is turned off');
      }
      const user = principalOf(req, res);
      if (!user) throw new ServiceError('AUTH_REQUIRED', 'authentication required');

      const { version, textHash: shownHash, language } = req.body;
      const resolved = resolveText(settings, language, platform.defaultLanguage);
      if (version !== settings.requiredVersion || shownHash !== textHash(resolved.text)) {
        throw new ServiceError('CONFLICT', 'The notice changed. Read it again and confirm.', {
          details: { requiredVersion: settings.requiredVersion }
        });
      }

      const entry = {
        version,
        textHash: shownHash,
        acknowledgedAt: new Date().toISOString(),
        language: resolved.language
      };
      // Which first-party client the confirmation came from, read from the token
      // (never from the body, which a caller could set to anything). Absent for the
      // web app, Teams and embeds: the same cookie session as the web app.
      const client = user.isOAuthAuthCode ? firstPartyClientKind(user.clientId, platform) : null;
      if (client) entry.client = client;
      const isUser = Boolean(user.id && user.id !== 'anonymous');
      const subject = isUser ? 'user' : 'guest';
      const guestId = guestIdOf(user);
      const resourceId = isUser ? user.id : guestId ? guestOwnerId(guestId) : 'anonymous';
      const audit = () =>
        logAudit({
          req,
          action: 'create',
          resource: 'aiAcknowledgement',
          resourceId,
          summary: `AI-use notice v${version} acknowledged`,
          details: {
            version,
            textHash: shownHash,
            language: resolved.language,
            policyUrl: settings.policyUrl,
            subject,
            ...(client ? { client } : {})
          }
        });

      if (isUser) {
        const { recorded, entry: stored } = await recordAiAcknowledgement(
          user.id,
          entry,
          usersFilePath(platform)
        );
        if (stored) {
          if (!recorded) return res.status(200).json(stored);
          audit();
          setAcknowledgementCookie(req, res, version);
          return sendCreated(res, ME_PATH, entry);
        }
        // A principal without a record (its record vanished) falls through to the cookie.
      }

      if (hasValidAcknowledgementCookie(req, settings)) {
        return res.status(200).json(entry);
      }
      if (!setAcknowledgementCookie(req, res, version)) {
        throw new ServiceError(
          'GUEST_COOKIE_MISSING',
          'The guest session was not found. Reload the page and try again.'
        );
      }
      audit();
      return sendCreated(res, ME_PATH, entry);
    }
  );
}
