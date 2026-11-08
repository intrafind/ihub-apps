// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// JIRA OAuth Integration Routes
// The JIRA connection (OAuth 2.0 with PKCE through the connection service) and the attachment proxy

import express from 'express';
import JiraService from '../../services/integrations/JiraService.js';
import { JIRA_INSTANCE_ID } from '../../services/integrations/jiraConfig.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { registerIntegrationCallbackAlias } from './oauthIntegrationFactory.js';

const router = express.Router();

// Gate all Jira routes behind the integrations feature flag
router.use(requireFeature('integrations'));

// The OAuth callback registered in the vendor app: an alias of the one integration
// callback (see oauthIntegrationFactory.js). Connecting, the status and disconnecting
// are the one connect flow (POST /api/integrations/:id/_connect|_disconnect).
// The redirect URI sent to Atlassian is the configured one or derived from the
// request (resolveJiraRedirectUri).
registerIntegrationCallbackAlias(router, {
  providerKey: 'jira',
  requiresProviderId: false,
  installationId: JIRA_INSTANCE_ID,
  stack: 'jira'
});

/**
 * Proxy endpoint for downloading JIRA attachments
 * GET /api/integrations/jira/attachment/:attachmentId
 */
router.get('/attachment/:attachmentId', authRequired, async (req, res) => {
  const { attachmentId } = req.params;
  const { download } = req.query;

  if (!req.user?.id || req.user.id === 'anonymous') {
    throw new ServiceError('AUTH_REQUIRED', 'Authentication required');
  }

  // Get attachment metadata and content
  const attachment = await JiraService.getAttachmentProxy({
    attachmentId,
    userId: req.user.id
  });

  // Set appropriate headers
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', attachment.size);

  // If download is requested or it's not an image, force download
  if (download === 'true' || !attachment.mimeType?.startsWith('image/')) {
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
  } else {
    // For images, allow inline display
    res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
  }

  // Stream the attachment content directly to the response
  attachment.stream.pipe(res);
});

export default router;
