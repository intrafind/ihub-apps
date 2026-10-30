// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in iFinder integration (`com.intrafind/ifinder`, installation
 * `ifinder`): the seven document actions, the search profile scopes and the
 * connection test. The actions keep their tool ids (`iFinder_search`, …).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as iFinderTool from '../../../../../../tools/iFinder.js';
import iFinderScopes from '../../../../scopes/iFinderScopes.js';
import iFinderService from '../../../../iFinderService.js';
import { iFinderConfigFromInstance, withIntegrationConfigs } from '../../../../ifinderConfig.js';
import { enableAssistantModelOnIFinderSetup } from '../../../../iAssistantModelActivation.js';
import { DiagnosticsReport, STATUS } from '../../../../integrationDiagnostics.js';
import {
  TEST_SEARCH_QUERY,
  buildIntegrationUrl,
  describeSigningKey,
  runApiRequestStep,
  runJwtSteps,
  runTransportSteps
} from '../../../../builtins/iFinderDiagnostics.js';
import logger from '../../../../../../utils/logger.js';

const parameters = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'parameters.json'), 'utf8')
);

/**
 * A tool call as `tools/iFinder.js` expects it: the model's arguments plus
 * the chat context (`user`, `chatId`, `appConfig`, `integrationScopes`, …)
 * that `runTool` received.
 */
function toolParams(args, ctx) {
  const { params = {} } = ctx;
  return {
    ...args,
    user: ctx.user ?? params.user,
    chatId: ctx.chatId ?? params.chatId,
    appConfig: params.appConfig,
    integrationScopes: params.integrationScopes,
    language: params.language,
    signal: params.signal
  };
}

function action(name) {
  return {
    parameters: parameters[name],
    run: (args, ctx) => iFinderTool[name](toolParams(args, ctx))
  };
}

/** The connection test: configuration, transport, JWT, one search. */
async function test({ instance, user }) {
  const cfg = iFinderConfigFromInstance({ ...instance, enabled: true });
  const report = new DiagnosticsReport();
  const signingKey = describeSigningKey(cfg);
  const configDetails = {
    baseUrl: cfg.baseUrl,
    searchEndpoint: cfg.endpoints.search,
    searchProfile: cfg.defaultSearchProfile,
    timeoutMs: cfg.timeout,
    authMode: cfg.authMode,
    jwtSubjectField: cfg.jwtSubjectField,
    jwtAlgorithm: cfg.useOidcKeyPair ? 'RS256' : cfg.algorithm,
    jwtAudience: cfg.audience,
    jwtIssuer: cfg.issuer,
    signingKeyMode: signingKey.mode,
    signingKeySource: signingKey.description
  };
  if (!cfg.baseUrl) {
    report.add({
      id: 'configuration',
      label: 'Configuration',
      status: STATUS.FAIL,
      message: 'No iFinder base URL is configured',
      details: configDetails,
      hints: ['Set the iFinder base URL, or provide the IFINDER_API_URL environment variable.']
    });
    return report.steps;
  }
  if (!signingKey.available) {
    report.add({
      id: 'configuration',
      label: 'Configuration',
      status: STATUS.FAIL,
      message: cfg.useOidcKeyPair
        ? 'The iHub OIDC RSA key pair is not initialized, so no iFinder JWT can be signed'
        : 'No iFinder private key is configured',
      details: configDetails,
      hints: cfg.useOidcKeyPair
        ? [
            'Set "jwt.algorithm" to RS256 under Admin > Authentication so iHub generates an RSA key pair, then restart the server.'
          ]
        : [
            'Pick or create the private key credential, or set the IFINDER_PRIVATE_KEY environment variable on the server (PEM format).',
            'Alternatively sign with the OIDC key pair iHub already publishes via JWKS.'
          ]
    });
    return report.steps;
  }
  report.add({
    id: 'configuration',
    label: 'Configuration',
    status: STATUS.OK,
    message:
      cfg.authMode === 'oidcTokenExchange'
        ? `Using a ${signingKey.description}`
        : `Signing with ${signingKey.description}, subject from "${cfg.jwtSubjectField}"`,
    details: configDetails
  });

  const testUser = user && user.id !== 'anonymous' ? user : null;
  await withIntegrationConfigs({ ifinder: cfg }, async () => {
    const urlInfo = await runTransportSteps(report, {
      rawUrl: cfg.baseUrl,
      urlLabel: 'iFinder base',
      timeout: cfg.timeout
    });
    if (!testUser) {
      report.skip('jwt', 'JWT generation', 'No signed-in user to mint a token for.');
      report.skip('search', 'iFinder search API request', 'Skipped without a token.');
      return;
    }
    const jwtResult = await runJwtSteps(report, {
      user: testUser,
      adminUser: testUser,
      iFinderConfig: cfg,
      userOverride: {},
      includeToken: false
    });
    if (!urlInfo.valid || !jwtResult) {
      report.skip(
        'search',
        'iFinder search API request',
        'Skipped because the base URL or the JWT could not be prepared.'
      );
      return;
    }
    const searchEndpoint = cfg.endpoints.search.replace(
      '{profileId}',
      encodeURIComponent(cfg.defaultSearchProfile)
    );
    const result = await runApiRequestStep(report, {
      id: 'search',
      label: 'iFinder search API request',
      url: buildIntegrationUrl(cfg.baseUrl, searchEndpoint, { query: TEST_SEARCH_QUERY, size: 1 }),
      method: 'GET',
      headers: { Authorization: jwtResult.authHeader, Accept: 'application/json' },
      token: jwtResult.token,
      includeToken: false,
      timeout: cfg.timeout,
      jwtInfo: jwtResult.info,
      context: { searchProfile: cfg.defaultSearchProfile }
    });
    if (result.ok) {
      const hits = result.parsed?.metadata?.total_hits ?? 0;
      report.add({
        id: 'searchResult',
        label: 'Search result',
        status: STATUS.OK,
        message: `iFinder answered the query "${TEST_SEARCH_QUERY}" with ${hits} hit(s)`,
        details: {
          query: TEST_SEARCH_QUERY,
          searchProfile: cfg.defaultSearchProfile,
          totalHits: hits
        },
        hints:
          hits === 0
            ? [
                `The connection works but the query matched nothing. Confirm the search profile "${cfg.defaultSearchProfile}" contains documents the user "${jwtResult.info.subject}" may see.`
              ]
            : []
      });
    }
  });
  return report.steps;
}

const connector = {
  id: 'ifinder',
  actions: {
    search: action('search'),
    getContent: action('getContent'),
    getMetadata: action('getMetadata'),
    discover: action('discover'),
    getFields: action('getFields'),
    getFacetValues: action('getFacetValues'),
    listProfiles: action('listProfiles')
  },
  test,
  /** The search profile picker of the chat (#3050), unchanged. */
  scopeProvider() {
    return iFinderScopes;
  },
  invalidate() {
    iFinderService.resetConfig();
  },
  /**
   * When the admin finishes setting iFinder up, the iAssistant conversation
   * model is switched on once, so the iAssistant app works without a second
   * trip to Admin → Models.
   */
  async onChanged({ before, after }) {
    iFinderService.resetConfig();
    const was = before ? iFinderConfigFromInstance(before) : null;
    const now = after ? iFinderConfigFromInstance(after) : null;
    try {
      await enableAssistantModelOnIFinderSetup(was, now);
    } catch (error) {
      logger.warn('Could not enable the iAssistant conversation model', {
        component: 'IFinderIntegration',
        error: error.message
      });
    }
  }
};

export default connector;
