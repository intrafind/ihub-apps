// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in iAssistant integration (`com.intrafind/iassistant`,
 * installation `iassistant`): the conversation settings on the iFinder
 * connection, the "whom to ask" scopes of the chat and the connection test.
 * It has no tool actions yet; the `iassistant-conversation` model is how a
 * chat talks to it.
 */
import iAssistantScopes from '../../../scopes/iAssistantScopes.js';
import iAssistantService from '../../../iAssistantService.js';
import iAssistantProfileResolver from '../../../iAssistantProfileResolver.js';
import conversationApiService from '../../../ConversationApiService.js';
import {
  getIFinderConfig,
  iAssistantConfigFromInstance,
  withIntegrationConfigs
} from '../../../ifinderConfig.js';
import { DiagnosticsReport, STATUS } from '../../../integrationDiagnostics.js';
import {
  IASSISTANT_DIAGNOSTIC_TIMEOUT_MS,
  describeSigningKey,
  runJwtSteps,
  runTransportSteps
} from '../../../builtins/iFinderDiagnostics.js';

async function test({ instance, user }) {
  const ifinder = getIFinderConfig();
  const cfg = iAssistantConfigFromInstance({ ...instance, enabled: true }, ifinder);
  const report = new DiagnosticsReport();
  const signingKey = describeSigningKey(ifinder);
  const configDetails = {
    baseUrl: cfg.baseUrl,
    baseUrlSource: 'inherited from the iFinder installation',
    apiBasePath: '/public-api/rag/api/v0',
    profileId: cfg.defaultProfileId,
    searchProfile: cfg.defaultSearchProfile,
    signingKeyMode: signingKey.mode,
    signingKeySource: signingKey.description
  };
  if (!ifinder.installed || !cfg.baseUrl) {
    report.add({
      id: 'configuration',
      label: 'Configuration',
      status: STATUS.FAIL,
      message: ifinder.installed
        ? 'The iFinder installation has no base URL'
        : 'The iFinder integration is not installed',
      details: configDetails,
      hints: ['iAssistant runs on the iFinder connection. Install and configure iFinder first.']
    });
    return report.steps;
  }
  if (!signingKey.available) {
    report.add({
      id: 'configuration',
      label: 'Configuration',
      status: STATUS.FAIL,
      message: 'No signing key is available for the iAssistant JWT',
      details: configDetails,
      hints: [
        'iAssistant authenticates with the same JWT as iFinder. Configure the iFinder signing key first.'
      ]
    });
    return report.steps;
  }
  report.add({
    id: 'configuration',
    label: 'Configuration',
    status: cfg.defaultProfileId ? STATUS.OK : STATUS.WARN,
    message: cfg.defaultProfileId
      ? `Profile "${cfg.defaultProfileId}" on ${cfg.baseUrl}`
      : 'No default profile id configured',
    details: configDetails,
    hints: cfg.defaultProfileId
      ? []
      : [
          'Apps without an explicit profile fall back to the default profile id. Set it here, or provide IASSISTANT_PROFILE_ID.'
        ]
  });
  const testUser = user && user.id !== 'anonymous' ? user : null;
  await withIntegrationConfigs({ iassistant: cfg }, async () => {
    const urlInfo = await runTransportSteps(report, {
      rawUrl: cfg.baseUrl,
      urlLabel: 'iAssistant base',
      timeout: IASSISTANT_DIAGNOSTIC_TIMEOUT_MS
    });
    if (!testUser) {
      report.skip('jwt', 'JWT generation', 'No signed-in user to mint a token for.');
      return;
    }
    const jwtResult = await runJwtSteps(report, {
      user: testUser,
      adminUser: testUser,
      iFinderConfig: ifinder,
      userOverride: {},
      includeToken: false
    });
    if (!urlInfo.valid || !jwtResult) {
      report.skip(
        'profiles',
        'iAssistant profile list',
        'Skipped because the base URL or the JWT could not be prepared.'
      );
      return;
    }
    await report.run('profiles', 'iAssistant profile list', async () => {
      const raw = await conversationApiService.listProfiles({
        user: testUser,
        baseUrl: cfg.baseUrl
      });
      const profiles = Array.isArray(raw) ? raw : raw?.profiles || raw?.items || [];
      const ids = profiles.map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean);
      const known = !cfg.defaultProfileId || ids.length === 0 || ids.includes(cfg.defaultProfileId);
      return {
        status: known ? STATUS.OK : STATUS.FAIL,
        message: known
          ? cfg.defaultProfileId
            ? `Profile "${cfg.defaultProfileId}" is available`
            : `iAssistant offers ${ids.length} profile(s)`
          : `Profile "${cfg.defaultProfileId}" is not among the profiles iAssistant returns`,
        details: { configuredProfileId: cfg.defaultProfileId, availableProfileIds: ids },
        hints: known
          ? []
          : [`Set the default profile id to one of: ${ids.join(', ') || '(none returned)'}.`]
      };
    });
  });
  return report.steps;
}

const connector = {
  id: 'iassistant',
  actions: {},
  test,
  /** The "ask …" picker of the chat (#3050), unchanged. */
  scopeProvider() {
    return iAssistantScopes;
  },
  invalidate() {
    iAssistantService.resetConfig();
    iAssistantProfileResolver.reset();
  },
  onChanged() {
    iAssistantService.resetConfig();
    iAssistantProfileResolver.reset();
  }
};

export default connector;
