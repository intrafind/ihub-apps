// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import registerChatRoutes from '../routes/chat/index.js';
import registerAdminRoutes from '../routes/adminRoutes.js';
import registerStaticRoutes from '../routes/staticRoutes.js';
import registerGeneralRoutes from '../routes/generalRoutes.js';
import registerModelRoutes from '../routes/modelRoutes.js';
import registerMcpAppRoutes from '../routes/mcpAppRoutes.js';
import registerMcpOAuthRoutes from '../routes/mcpOAuth.js';
import registerIntegrationOAuthCallback from '../routes/integrations/oauthCallback.js';
import registerSkillRoutes from '../routes/skillRoutes.js';
import registerUserSkillRoutes from '../routes/userSkillRoutes.js';
import registerExportRoutes from '../routes/exports.js';
import registerPageRoutes from '../routes/pageRoutes.js';
import registerRendererRoutes from '../routes/rendererRoutes.js';
import registerAppSessionStartRoute from '../routes/appSessionRoutes.js';
import registerMagicPromptRoutes from '../routes/magicPromptRoutes.js';
import registerUsageRoutes from '../routes/usageRoutes.js';
import registerAiAcknowledgementRoutes from '../routes/aiAcknowledgementRoutes.js';
import registerProvenanceRoutes from '../routes/provenanceRoutes.js';
import registerShortLinkRoutes from '../routes/shortLinkRoutes.js';
import registerOpenAIProxyRoutes from '../routes/openaiProxy.js';
import registerAuthRoutes from '../routes/auth.js';
import registerOAuthRoutes from '../routes/oauth.js';
import registerOAuthAuthorizeRoutes from '../routes/oauthAuthorize.js';
import registerOAuthRegisterRoutes from '../routes/oauthRegister.js';
import registerWellKnownRoutes from '../routes/wellKnown.js';
import registerMcpServerRoutes from '../routes/mcpServer.js';
import registerSwaggerRoutes from '../routes/swagger.js';
import registerWorkflowRoutes from '../routes/workflow/index.js';
import registerAgentRoutes from '../routes/agents/index.js';
import registerRunRoutes from '../routes/runs.js';
import registerStoredChatRoutes from '../routes/chats.js';
import registerChatShareRoutes from '../routes/chatShares.js';
import registerShareEmbedPageRoutes from '../routes/shareEmbedPage.js';
import registerScheduledTaskRoutes from '../routes/scheduledTasks.js';
import runLog from '../services/loop/RunLog.js';
import { startChatRetentionSweep } from '../services/chat/chatRetention.js';
import { startProjectRetentionSweep } from '../services/projects/projectRetention.js';
import { startProvenanceRetentionSweep } from '../services/provenance/provenanceRetention.js';
import { startWebsiteCorpusRetentionSweep } from '../services/websiteCorpus/corpusRetention.js';
import { startWorkflowStateRetention } from '../services/workflow/workflowRetention.js';
import { registerCheckpointResume } from '../services/workflow/checkpointResume.js';
import { registerChatClarificationLifecycle } from '../services/chat/chatClarificationLifecycle.js';
import interactionService from '../services/loop/InteractionService.js';
import { startActionUsageTracking } from '../services/integrations/actionUsage.js';
import { registerTriggerRoutes } from '../routes/workflow/triggerRoutes.js';
import registerVoiceRoutes from '../routes/voiceRoutes.js';
import registerSetupRoutes from '../routes/setup.js';
import registerPwaRoutes from '../routes/pwaRoutes.js';
import registerThemeRoutes from '../routes/themeRoutes.js';
import registerToolsServiceRoutes from '../routes/toolsService/index.js';
import jiraRoutes from '../routes/integrations/jira.js';
import office365Routes from '../routes/integrations/office365.js';
import googledriveRoutes from '../routes/integrations/googledrive.js';
import nextcloudRoutes from '../routes/integrations/nextcloud.js';
import ifinderRoutes from '../routes/integrations/ifinder.js';
import officeAddinRoutes from '../routes/integrations/officeAddin.js';
import browserExtensionRoutes from '../routes/integrations/browserExtension.js';
import personalApiKeyRoutes from '../routes/integrations/personalApiKeys.js';
import connectionRoutes from '../routes/integrations/connections.js';
import userIntegrationRoutes from '../routes/integrations/userIntegrations.js';
import integrationRequestRoutes from '../routes/integrations/integrationRequests.js';
import integrationScopeRoutes from '../routes/integrations/scopes.js';
import integrationFilesRoutes from '../routes/integrations/files.js';
import nextcloudEmbedRoutes from '../routes/integrations/nextcloudEmbed.js';
import registerOfficeRoutes from '../routes/office.js';
import registerNextcloudEmbedPageRoutes from '../routes/nextcloudEmbedPages.js';
import { getLocalizedError, processMessageTemplates } from '../serverHelpers.js';
import { buildApiPath } from '../utils/basePath.js';

/**
 * Everything the worker registers on the Express app, in the order it is
 * registered. The order is part of the contract: auth first, the integration
 * mounts before the user integrations' `/:id` catch-all, PWA routes before the
 * static files, and the SPA fallback last.
 *
 * A step receives the app and the RouteContext; it may return a promise, which
 * is awaited before the next step runs.
 */
const ROUTE_STEPS = [
  app => registerAuthRoutes(app),
  app => registerOAuthRoutes(app),
  app => registerOAuthAuthorizeRoutes(app),
  app => registerOAuthRegisterRoutes(app),
  app => registerWellKnownRoutes(app),
  app => registerMcpServerRoutes(app),
  app => registerGeneralRoutes(app, { getLocalizedError }),
  app => registerModelRoutes(app, { getLocalizedError }),
  app => registerMcpAppRoutes(app),
  app => registerMcpOAuthRoutes(app),
  app => registerIntegrationOAuthCallback(app),
  app => registerSkillRoutes(app),
  app => registerUserSkillRoutes(app),
  app => registerExportRoutes(app),
  app => registerPageRoutes(app),
  app => registerRendererRoutes(app),
  app => registerAppSessionStartRoute(app),
  app => registerMagicPromptRoutes(app),
  app => registerUsageRoutes(app),
  app => registerAiAcknowledgementRoutes(app),
  app => registerProvenanceRoutes(app),
  (app, { DEFAULT_TIMEOUT }) =>
    registerChatRoutes(app, {
      processMessageTemplates,
      getLocalizedError,
      DEFAULT_TIMEOUT
    }),
  (app, { DEFAULT_TIMEOUT }) =>
    registerOpenAIProxyRoutes(app, { getLocalizedError, DEFAULT_TIMEOUT }),
  app => registerAdminRoutes(app),
  app => registerShortLinkRoutes(app),
  app => registerSwaggerRoutes(app),
  app => registerWorkflowRoutes(app, { getLocalizedError }),
  app => registerTriggerRoutes(app),
  app => registerAgentRoutes(app),
  app => registerRunRoutes(app),
  app => registerStoredChatRoutes(app),
  app => registerChatShareRoutes(app),
  app => registerShareEmbedPageRoutes(app),
  app => registerScheduledTaskRoutes(app),
  // An answered workflow checkpoint resumes its execution (one answer endpoint);
  // overdue interactions expire on a sweep (an expired checkpoint fails its run).
  () => registerCheckpointResume(),
  // A chat clarification that is settled (answered, superseded or expired)
  // ends the run its question paused.
  () => registerChatClarificationLifecycle(),
  // Approvals, rejections and expiries of integration actions, for the
  // action detail's Usage (#2974).
  () => startActionUsageTracking(interactionService),
  // Once per cluster: only the worker that owns the singletons runs the sweeps.
  (_app, { ownsClusterSingletons }) => {
    if (ownsClusterSingletons) {
      interactionService.startExpirySweep();
      runLog.startCleanupScheduler();
      // Durable chats age out on their own daily sweep rather than with the
      // ledger's: deleting stored conversations and deleting the run ledger are
      // separate admin decisions, so `platform.chats.retentionDays` is
      // independent of `runLog.cleanupEnabled`. Same ownership guard, though —
      // two workers sweeping in parallel would only race each other's deletes.
      startChatRetentionSweep();
      // Terminal workflow state accumulated forever before this: a completed
      // run kept its full state document, its run summary and — for a
      // sub-workflow — a state nothing ever deleted. Same daily cadence and the
      // same ownership guard as the sweeps above.
      startWorkflowStateRetention();
      // Abandoned user projects, when `platform.projects.retentionDays` says so.
      startProjectRetentionSweep();
      // Provenance records older than `provenance.retentionDays`.
      startProvenanceRetentionSweep();
      // Crawls of the Website Corpus older than their 14 days, also of people who stopped using it.
      startWebsiteCorpusRetentionSweep();
    }
  },
  app => registerVoiceRoutes(app),
  app => registerSetupRoutes(app),
  // --- Integration Routes ---
  // Note: These must be registered after authentication middleware is set up
  // The user's integrations and the one connect flow (GET /api/integrations,
  // POST /api/integrations/:id/_connect|_reconnect|_disconnect). First, so an
  // installation id that equals a provider slug still reaches /:id/_connect.
  // Requests for catalog integrations (GET/POST /api/integrations/requests), before
  // the user integrations, whose GET /:id hands ids it does not know on.
  app => app.use(buildApiPath('/integrations/requests'), integrationRequestRoutes),
  app => app.use(buildApiPath('/integrations'), userIntegrationRoutes),
  // Documents by reference from an installed integration (the `files` capability).
  app => app.use(buildApiPath('/integrations'), integrationFilesRoutes),
  app => app.use(buildApiPath('/integrations/jira'), jiraRoutes),
  app => app.use(buildApiPath('/integrations/office365'), office365Routes),
  app => app.use(buildApiPath('/integrations/googledrive'), googledriveRoutes),
  app => app.use(buildApiPath('/integrations/nextcloud'), nextcloudRoutes),
  app => app.use(buildApiPath('/integrations/ifinder'), ifinderRoutes),
  // One route for every source provider's actions (preview, download, details).
  app => app.use(buildApiPath('/integrations/office-addin'), officeAddinRoutes),
  app => app.use(buildApiPath('/integrations/browser-extension'), browserExtensionRoutes),
  app => app.use(buildApiPath('/integrations/api-keys'), personalApiKeyRoutes),
  app => app.use(buildApiPath('/integrations/connections'), connectionRoutes),
  app => app.use(buildApiPath('/integrations/nextcloud-embed'), nextcloudEmbedRoutes),
  // Scopes the chat input offers per integration (iFinder profiles, iAssistants).
  app => app.use(buildApiPath('/integrations'), integrationScopeRoutes),
  // PWA routes (manifest + SW) must be registered before static file serving
  // so the extension guard in staticRoutes does not 404 them
  app => registerPwaRoutes(app),
  app => registerOfficeRoutes(app),
  app => registerNextcloudEmbedPageRoutes(app),
  app => registerThemeRoutes(app),
  app => registerToolsServiceRoutes(app),
  // Register static file and SPA routes after API routes
  (app, { isPackaged, rootDir, basePath }) =>
    registerStaticRoutes(app, { isPackaged, rootDir, basePath })
];

/**
 * @typedef {Object} RouteContext
 * @property {boolean} ownsClusterSingletons - this worker runs the once-per-cluster sweeps
 * @property {boolean} isPackaged - running from a packaged binary
 * @property {string} rootDir - the application root
 * @property {string} basePath - the base path the app is served under
 * @property {number} DEFAULT_TIMEOUT - the request timeout in milliseconds
 */

/**
 * Register every route and the lifecycle hooks that sit between them.
 *
 * @param {import('express').Express} app
 * @param {RouteContext} context
 * @returns {Promise<void>}
 */
export async function registerAllRoutes(app, context) {
  for (const step of ROUTE_STEPS) {
    await step(app, context);
  }
}
