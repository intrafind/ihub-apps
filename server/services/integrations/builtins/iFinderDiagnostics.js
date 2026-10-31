// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildServerPath } from '../../../utils/basePath.js';
import config from '../../../config.js';
import { validateIFinderJWT } from '../../../utils/iFinderJwt.js';
import iFinderTokenProvider, {
  IFINDER_AUTH_MODES,
  getAuthMode
} from '../../../services/integrations/iFinderTokenProvider.js';
import smartCollections, {
  SMART_COLLECTIONS_ERRORS,
  SMART_COLLECTIONS_SCOPE,
  SmartCollectionsError
} from '../SmartCollectionsService.js';
import { policyOffersIFinder, projectSettings } from '../../projects/projectSettings.js';
import { throttledFetch } from '../../../requestThrottler.js';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import tokenStorageService from '../../../services/TokenStorageService.js';
import {
  DiagnosticsReport,
  STATUS,
  buildCurlCommand,
  decodeJwt,
  describeHttpFailure,
  findExpectedClaims,
  describeNetworkError,
  describeTransport,
  inspectUrl,
  pickResponseHeaders,
  previewToken,
  probeTcpTls,
  redactHeaders,
  resolveHostname,
  truncateBody
} from '../../../services/integrations/integrationDiagnostics.js';

/**
 * Diagnostic steps for the built-in iFinder and iAssistant integrations,
 * run by their connectors' tests (Admin → Integrations → Installed → Test).
 *
 * They run a sequence of diagnostic steps instead of a single pass/fail probe, because the failures admins actually hit while connecting
 * iHub to iFinder are indistinguishable from the outside: a 500 raised inside
 * iFinder while it tries to resolve the JWKS hostname of iHub, and a 401 with an
 * empty body, both used to surface as "test failed". Each step therefore reports
 * the URLs used, the resolved addresses, the TLS peer, the decoded JWT claims,
 * and hints naming what to check.
 */

/** Fields of a user object that may be overridden to test as somebody else. */
const OVERRIDABLE_USER_FIELDS = ['id', 'email', 'username', 'name', 'domain'];
const MAX_OVERRIDE_LENGTH = 320;

/** Search term used for the iFinder test request. Constant on purpose — see buildIntegrationUrl. */
export const TEST_SEARCH_QUERY = 'test';

/**
 * Ceiling for the iAssistant diagnostic probes. An admin waits on these in the
 * browser, so they stay short; a real conversation turn is bounded by the
 * model's `streamIdleTimeoutMs` and the whole-call `REQUEST_TIMEOUT` instead.
 * This used to read `iAssistant.timeout`, a platform setting that looked like
 * it governed chat turns and never did.
 */
export const IASSISTANT_DIAGNOSTIC_TIMEOUT_MS = 60000;

/**
 * Build the URL for an integration request.
 *
 * Every component comes from the trusted platform configuration — nothing from
 * the request body, the query string or a header ever reaches an outbound URL in
 * this module. The origin is additionally re-asserted against the configured base
 * URL, so even a future change to an endpoint template cannot redirect a
 * diagnostics request at a different host.
 *
 * @param {string} baseUrl - Configured base URL
 * @param {string} path - Endpoint path from configuration
 * @param {Object} [query] - Query parameters built from configuration/constants
 * @returns {string} Absolute URL
 * @throws {Error} If the result would leave the configured origin
 */
export function buildIntegrationUrl(baseUrl, path, query = {}) {
  const base = new URL(baseUrl.replace(/\/+$/, ''));
  const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`);

  if (url.origin !== base.origin) {
    throw new Error(
      `Refusing to send a diagnostics request to ${url.origin}, which is not the configured ${base.origin}`
    );
  }

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Accept only known string fields from the request body, so the override cannot
 * be used to smuggle arbitrary structures into JWT generation.
 * @param {Object} raw - `user` object from the request body
 * @returns {Object} Sanitized override (may be empty)
 */
export function sanitizeUserOverride(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const override = {};
  for (const field of OVERRIDABLE_USER_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim() !== '') {
      override[field] = value.trim().slice(0, MAX_OVERRIDE_LENGTH);
    }
  }

  if (Array.isArray(raw.groups)) {
    const groups = raw.groups
      .filter(group => typeof group === 'string' && group.trim() !== '')
      .map(group => group.trim().slice(0, MAX_OVERRIDE_LENGTH))
      .slice(0, 50);
    if (groups.length > 0) override.groups = groups;
  }

  return override;
}

/**
 * Build the user the test JWT is minted for: the calling admin by default, with
 * any explicitly supplied fields layered on top.
 * @param {import('express').Request} req
 * @param {Object} override - Result of sanitizeUserOverride
 * @returns {Object} User object
 */
export function buildTestUser(req, override) {
  const base = {
    id: req.user?.id || 'test-admin',
    email: req.user?.email || 'admin@test.com',
    username: req.user?.username || 'admin',
    name: req.user?.name || 'Test Admin',
    groups: req.user?.groups || ['admin']
  };
  if (req.user?.domain) base.domain = req.user.domain;
  return { ...base, ...override };
}

/**
 * The issuer URL iHub advertises for its own OIDC metadata.
 *
 * Returns two separate values on purpose:
 *
 * - `fetchableIssuer` is non-null only when `platform.oauth.issuer` is configured.
 *   It is the only value this module ever requests, so no header can influence
 *   which host iHub contacts.
 * - `issuer` is what the admin is *shown*. When nothing is configured the
 *   well-known routes derive the issuer from the request, so the diagnostics
 *   report the same derivation to reveal the URL iFinder would be pointed at.
 *   It is display-only and must never reach an HTTP request.
 *
 * @param {import('express').Request} req
 * @returns {Object} `{ issuer, fetchableIssuer, source, fromTrustedConfig }`
 */
function resolveIssuerUrl(req) {
  const platform = configCache.getPlatform() || {};
  const configured = platform.oauth?.issuer;
  if (configured && configured.startsWith('http')) {
    const issuer = configured.replace(/\/+$/, '');
    return {
      issuer,
      fetchableIssuer: issuer,
      source: 'platform.oauth.issuer',
      fromTrustedConfig: true
    };
  }

  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  const basePath = buildServerPath('').replace(/\/$/, '');
  return {
    issuer: `${protocol}://${host}${basePath}`,
    fetchableIssuer: null,
    source: 'auto-detected from the Host header of this request',
    fromTrustedConfig: false
  };
}

/**
 * Describe which key signs the iFinder JWT, without ever revealing it.
 * @param {Object} iFinderConfig
 * @returns {Object} `{ mode, available, description }`
 */
export function describeSigningKey(iFinderConfig) {
  if (getAuthMode(iFinderConfig) === IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE) {
    const provider = iFinderConfig.tokenExchange?.oidcProvider;
    return {
      mode: IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE,
      // Whether the exchange works is what the exchange step finds out.
      available: true,
      description: `token exchange at the OIDC provider "${provider || '(none selected)'}"`
    };
  }
  if (iFinderConfig.useOidcKeyPair) {
    const keyPair = tokenStorageService.getRSAKeyPair();
    return {
      mode: 'oidcKeyPair',
      available: Boolean(keyPair?.privateKey),
      description: 'iHub OIDC RSA key pair (published via /.well-known/jwks.json)'
    };
  }
  // Checks the same source generateIFinderJWT() actually signs with
  // (config.IFINDER_PRIVATE_KEY, not process.env directly) so this can never
  // report "available" for a key the real signing path won't see.
  if (config.IFINDER_PRIVATE_KEY) {
    return {
      mode: 'privateKey',
      available: true,
      description: 'IFINDER_PRIVATE_KEY environment variable'
    };
  }
  if (iFinderConfig.privateKeyRef) {
    return {
      mode: 'privateKey',
      available: true,
      description: `credential store reference "${iFinderConfig.privateKeyRef}"`
    };
  }
  return { mode: 'privateKey', available: false, description: 'not configured' };
}

/**
 * Inspect a configured URL, resolve its hostname and probe the port.
 *
 * Steps are appended to `report`; the inspection is returned so the caller can
 * stop early when the URL itself is unusable.
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {string} params.rawUrl
 * @param {string} params.urlLabel - Human name of the setting ("iFinder base")
 * @param {number} params.timeout
 * @returns {Promise<Object>} URL inspection result
 */
export async function runTransportSteps(report, { rawUrl, urlLabel, timeout }) {
  const urlInfo = inspectUrl(rawUrl);
  const hints = [...urlInfo.errors, ...urlInfo.warnings];

  report.add({
    id: 'url',
    label: `${urlLabel} URL`,
    status: !urlInfo.valid ? STATUS.FAIL : urlInfo.warnings.length > 0 ? STATUS.WARN : STATUS.OK,
    message: urlInfo.valid
      ? `${urlInfo.protocol}://${urlInfo.hostname}:${urlInfo.port}${urlInfo.pathname}`
      : `Configured URL cannot be used: ${urlInfo.errors.join(' ')}`,
    details: {
      configured: urlInfo.raw,
      protocol: urlInfo.protocol,
      hostname: urlInfo.hostname,
      port: urlInfo.port,
      portSource: urlInfo.defaultPort ? 'scheme default' : 'explicit in URL',
      path: urlInfo.pathname,
      fullyQualifiedHostname: urlInfo.isFqdn || urlInfo.isIpLiteral,
      ipLiteral: urlInfo.isIpLiteral
    },
    hints
  });

  if (!urlInfo.valid) return urlInfo;

  const dnsStep = await report.run('dns', 'DNS resolution', async () => {
    const result = await resolveHostname(urlInfo.hostname);
    if (!result.resolved) {
      return {
        status: STATUS.FAIL,
        message: `Cannot resolve "${urlInfo.hostname}" from the iHub server (${result.code || 'lookup failed'})`,
        details: { hostname: urlInfo.hostname, error: result.error, code: result.code },
        hints: describeNetworkError(
          { code: result.code, message: result.error },
          {
            hostname: urlInfo.hostname
          }
        )
      };
    }
    const addresses = result.addresses.map(entry => entry.address);
    return {
      status: STATUS.OK,
      message: result.literal
        ? `${urlInfo.hostname} is a literal IP address, no lookup needed`
        : `${urlInfo.hostname} resolves to ${addresses.join(', ')}`,
      details: { hostname: urlInfo.hostname, addresses, literal: result.literal }
    };
  });

  const transport = describeTransport(urlInfo.url);

  if (dnsStep.status === STATUS.FAIL) {
    report.skip(
      'tcp',
      'TCP / TLS connection',
      'Skipped because the hostname could not be resolved.'
    );
    return urlInfo;
  }

  await report.run('tcp', 'TCP / TLS connection', async () => {
    // The probe always verifies certificates. Where the admin has whitelisted the
    // domain under Admin > Platform > SSL, a rejection here is not a broken
    // integration — real requests still go through — so the whitelist changes how
    // the result is *interpreted*, never how strictly it was measured.
    const probe = await probeTcpTls({
      hostname: urlInfo.hostname,
      port: urlInfo.port,
      protocol: urlInfo.protocol,
      timeout: Math.min(timeout, 15000)
    });

    const details = {
      target: `${urlInfo.hostname}:${urlInfo.port}`,
      connected: probe.connected,
      remoteAddress: probe.remoteAddress,
      durationMs: probe.durationMs,
      certificateValidation: 'always enforced by this probe against the iHub trust store',
      sslWhitelisted: transport.ignoreInvalidCertificates,
      note: transport.viaProxy
        ? `This probe connects directly. Real requests go through the proxy ${transport.proxyUrl}, so a failure here does not necessarily break the integration.`
        : 'Direct connection from the iHub server (no proxy configured for this URL).',
      ...(probe.tls ? { tls: probe.tls } : {})
    };

    const opensslHint = `Inspect what the host presents: openssl s_client -connect ${urlInfo.hostname}:${urlInfo.port}${
      urlInfo.isIpLiteral ? '' : ` -servername ${urlInfo.hostname}`
    }`;

    // A certificate rejection is not an unreachable host: the handshake got far
    // enough to receive a certificate, so only trust is missing.
    if (!probe.connected && probe.certificateRejected) {
      if (transport.ignoreInvalidCertificates) {
        return {
          status: STATUS.WARN,
          message: `Reached ${urlInfo.hostname}:${urlInfo.port}; its TLS certificate is not trusted by the iHub trust store (${probe.error}), but this domain is whitelisted so requests still succeed`,
          details,
          hints: [
            'The integration works because the domain is whitelisted under Admin > Platform > SSL. That bypass applies to iHub only — browsers and other clients still reject this certificate.',
            'Add the issuing CA to the trust store of the iHub server to fix it properly and drop the whitelist entry.',
            opensslHint
          ]
        };
      }
      return {
        status: STATUS.FAIL,
        message: `Reached ${urlInfo.hostname}:${urlInfo.port}, but its TLS certificate was rejected: ${probe.error}`,
        details,
        hints: [
          'Add the CA that issued the certificate to the trust store of the iHub server, so both iHub and the browser trust it.',
          'As a temporary workaround the domain can be whitelisted under Admin > Platform > SSL. That only relaxes iHub, not other clients.',
          opensslHint
        ]
      };
    }

    if (!probe.connected) {
      return {
        status: transport.viaProxy ? STATUS.WARN : STATUS.FAIL,
        message: probe.error,
        details,
        hints: describeNetworkError(
          { code: probe.code, message: probe.error },
          {
            hostname: urlInfo.hostname,
            port: urlInfo.port,
            timeout
          }
        )
      };
    }

    // Reaching here with TLS means the certificate passed verification, so there
    // is no untrusted or expired case left to report.
    let message = `Connected to ${urlInfo.hostname}:${urlInfo.port} in ${probe.durationMs}ms`;
    if (probe.tls) {
      message += ` (${probe.tls.protocol}, certificate for ${probe.tls.subject || 'unknown subject'} issued by ${probe.tls.issuer || 'unknown issuer'}, valid to ${probe.tls.validTo || 'unknown'})`;
    }

    return { status: STATUS.OK, message, details };
  });

  return urlInfo;
}

/**
 * Mint the test JWT, decode it, and verify it locally.
 *
 * The decoded claims are what an admin needs in order to compare the token
 * against the trust configuration on the iFinder side — the "how does the JWT
 * look like / which user is sent" part of the puzzle.
 *
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {Object} params.user - Test user
 * @param {Object} params.adminUser - The admin running the test (`req.user`)
 * @param {Object} params.iFinderConfig - the iFinder connection (`getIFinderConfig()`)
 * @param {Object} params.userOverride - Explicitly overridden user fields
 * @param {boolean} params.includeToken - Whether the raw JWT may be returned
 * @returns {Promise<Object|null>} `{ authHeader, token, info }` or null on failure
 */
export async function runJwtSteps(
  report,
  { user, adminUser, iFinderConfig, userOverride, includeToken }
) {
  if (getAuthMode(iFinderConfig) === IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE) {
    // Never the test user: its id can be overridden, and the exchange would
    // then run with somebody else's stored sign-in.
    return runExchangeSteps(report, { user: adminUser, userOverride, includeToken });
  }

  let authHeader;
  let token;
  let info;

  const generation = await report.run('jwt', 'JWT generation', async () => {
    authHeader = await iFinderTokenProvider.getAuthorizationHeader(user);
    token = authHeader.replace(/^Bearer\s+/i, '');
    info = decodeJwt(token);

    const subjectField = iFinderConfig.jwtSubjectField || 'email';
    const hints = [];

    // Subject resolution is strict: the configured field is the only one read,
    // and a missing value throws rather than silently substituting another
    // identifier. So reaching this point means the subject really is the field
    // the admin configured — there is no fallback left to warn about. What is
    // still worth saying is that iFinder has to know the subject in this exact
    // form, because that is what the user mapping is keyed on.
    hints.push(
      `iFinder must know this user as "${info.subject}" exactly — the subject is what the user mapping is keyed on, and it is compared verbatim.`
    );

    // The scope claim is read back from the signed token, so it is the value
    // iFinder will really see. Flag the implicit fallback, which does not match
    // the scope the shipped platform default configures.
    if (!iFinderConfig.defaultScope) {
      hints.push(
        `No Default Scope is configured, so the token was signed with the built-in fallback scope "${info.scope}". Set the scope explicitly on this page — the shipped default is "fa_index_read".`
      );
    }

    return {
      status: hints.length > 0 ? STATUS.WARN : STATUS.OK,
      message: `Signed ${info.algorithm} token for sub="${info.subject}"`,
      details: {
        subject: info.subject,
        subjectField,
        subjectResolvedFrom:
          subjectField === 'custom' || /\$\{/.test(subjectField)
            ? `template "${subjectField}"`
            : `user.${subjectField}`,
        testUser: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          domain: user.domain,
          groups: user.groups
        },
        overriddenFields: Object.keys(userOverride),
        header: info.header,
        payload: info.payload,
        issuedAt: info.issuedAt,
        expiresAt: info.expiresAt,
        lifetimeSeconds: info.lifetimeSeconds,
        tokenPreview: previewToken(token),
        ...(includeToken ? { token } : {})
      },
      hints
    };
  });

  if (generation.status === STATUS.FAIL) {
    // report.run converted the exception into a failed step; attach the two
    // things that can break signing so the message is actionable.
    generation.hints = [
      'Check the signing key: OIDC key pair mode needs an initialized iHub RSA key pair, private key mode needs IFINDER_PRIVATE_KEY or iFinder.privateKeyRef in PEM format.',
      'A subject that cannot be resolved also fails here — see the JWT Subject Field setting. Resolution is strict: the configured field is the only one read, so a user without that field fails instead of being sent under a different identifier.',
      String.raw`For "domain\username" the user needs a NetBIOS domain. NTLM takes it from the handshake; LDAP takes it from the "Domain" field on the provider, or detects it from the Active Directory msDS-PrincipalName attribute.`
    ];
    return null;
  }

  await report.run('jwtVerify', 'JWT signature (verified locally)', () => {
    const decoded = validateIFinderJWT(token);
    return {
      status: STATUS.OK,
      message: 'iHub can verify its own token with the matching public key',
      details: { verifiedClaims: decoded }
    };
  });

  return { authHeader, token, info };
}

/**
 * Run the token exchange for the admin running the test, then decode (not
 * verify) the result and compare it against what iFinder reads.
 *
 * The exchange always runs for the calling admin: it needs their stored login
 * token, so the user overrides of the signed mode cannot apply.
 *
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {Object} params.user - The admin running the test (`req.user`)
 * @param {Object} params.userOverride - Overrides the admin asked for (ignored, reported)
 * @param {boolean} params.includeToken - Whether the raw token may be returned
 * @returns {Promise<Object|null>} `{ authHeader, token, info }` or null on failure
 */
export async function runExchangeSteps(report, { user, userOverride, includeToken }) {
  let exchanged;
  const step = await report.run('jwt', 'Token exchange', async () => {
    exchanged = await iFinderTokenProvider.exchangeForDiagnostics(user);
    const { settings } = exchanged;
    const info = decodeJwt(exchanged.token);
    const payload = info.decoded ? info.payload : {};
    const expected = exchanged.requestedScope.split(/\s+/).filter(scope => scope.startsWith('fa_'));
    const claims = findExpectedClaims(payload, expected);
    const hints = [];

    if (!info.decoded) {
      hints.push(
        'The provider returned an opaque (non-JWT) access token. iFinder validates JWTs, so configure the provider to issue JWT access tokens for the iFinder audience.'
      );
    }
    if (claims.missing.length > 0) {
      hints.push(
        `The token does not carry ${claims.missing.join(', ')}. iFinder reads these claims; request them through the scope map, or add them with a claim mapper on the provider (Zitadel Action, Keycloak protocol mapper, Entra app roles).`
      );
    }
    if (Object.keys(userOverride).length > 0) {
      hints.push(
        'The test user fields were ignored: the exchange always runs for your own account, because it needs your stored sign-in token.'
      );
    }

    exchanged.info = info;
    return {
      status: hints.length > 0 ? STATUS.WARN : STATUS.OK,
      message: info.decoded
        ? `${settings.displayName} issued a token for sub="${info.subject}", aud=${JSON.stringify(info.audience)}`
        : `${settings.displayName} issued an opaque token`,
      details: {
        provider: settings.providerName,
        tokenURL: settings.tokenURL,
        grantType: settings.grantType,
        clientId: settings.clientId,
        audience: settings.audience || '(none)',
        requestedScope: exchanged.requestedScope,
        sentScope: exchanged.scope || '(none)',
        issuer: info.issuer,
        tokenAudience: info.audience,
        subject: info.subject,
        scopeClaim: payload.scope ?? payload.scp,
        expectedClaims: expected,
        presentClaims: claims.present,
        missingClaims: claims.missing,
        issuedAt: info.issuedAt,
        expiresAt: info.expiresAt,
        providerResponse: exchanged.response,
        header: info.header,
        payload: info.payload,
        tokenPreview: previewToken(exchanged.token),
        ...(includeToken ? { token: exchanged.token } : {})
      },
      hints
    };
  });

  if (step.status === STATUS.FAIL) {
    step.hints = [
      'The exchange runs for your own account with the token stored when you signed in. Sign out and sign in again via the selected provider (with "offline_access" in its scopes) if no token is stored.',
      'Check that the provider allows this client to exchange tokens for the iFinder audience: Zitadel needs the token exchange feature enabled, Keycloak the "Standard token exchange" switch on the client, Entra an API permission with admin consent.',
      'For Entra ID choose the On-Behalf-Of grant, and make sure the login scope asks for a token for the iHub API (api://<ihub-client-id>/...), not for Microsoft Graph.'
    ];
    return null;
  }

  report.skip(
    'jwtVerify',
    'JWT signature (verified locally)',
    'Not applicable: the token is signed by the OIDC provider and only decoded here; iFinder verifies it against the JWKS of that provider.'
  );

  return {
    authHeader: `Bearer ${exchanged.token}`,
    token: exchanged.token,
    info: exchanged.info
  };
}

/** What an admin can do about each way the Smart Collections call can fail. */
function smartCollectionsFailureHints(code, { exchange }) {
  const scopeHint = exchange
    ? `Make sure the OIDC provider issues "${SMART_COLLECTIONS_SCOPE}": check the scope map of the iFinder installation (token exchange) under Admin > Integrations > Installed and the roles the provider grants the user.`
    : `The token asks for the scope "${SMART_COLLECTIONS_SCOPE}" and iFinder grants it from the user's roles.`;
  switch (code) {
    case SMART_COLLECTIONS_ERRORS.UNSUPPORTED:
      return [
        'iFinder answered, but has no Smart Collections v1 API (public-api/smart-collections/api/v1). The tier needs iFinder 6.8 or later.',
        'If iFinder is 6.8 or later, check that the reverse proxy in front of it forwards /public-api/smart-collections.'
      ];
    case SMART_COLLECTIONS_ERRORS.FORBIDDEN:
      return [
        `iFinder refused the token: the user lacks the "${SMART_COLLECTIONS_SCOPE}" role. Give it to this user in iFinder.`,
        scopeHint
      ];
    case SMART_COLLECTIONS_ERRORS.UNAUTHORIZED:
      return [
        'iFinder does not accept the token (signature, issuer or audience), or no token could be created for this user. The search step above shows the same cause when it fails too.',
        scopeHint
      ];
    case SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE:
      return ['iFinder answered with something that is not a list of smart collections.'];
    default:
      return [
        'iFinder could not be reached or answered with an error. Check the transport steps above and the iFinder log.'
      ];
  }
}

/**
 * Ask the Smart Collections API for the test user's collections, the call the
 * iFinder tier of the projects makes, and say why the tier would stay hidden.
 *
 * The step reports four independent causes: the tier policy, the Smart
 * Collections API of this iFinder, the `fi_smartcollections` role of the
 * user, and a subject that differs from the iFinder login only in case (the
 * list matches the owner case-sensitively, so such a collection is missing
 * from it). Nothing is written to iFinder.
 *
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {Object} params.user - The user the token is minted for. In token
 *   exchange mode the calling admin, never an overridden test user.
 * @param {boolean} params.exchange - Token exchange mode.
 * @param {string|undefined} params.subject - The `sub` of the test token.
 * @param {number} params.timeout - Request timeout of the iFinder connection, ms.
 * @param {Object} params.platformConfig
 */
export async function runSmartCollectionsStep(
  report,
  { user, exchange, subject, timeout, platformConfig }
) {
  const settings = projectSettings(platformConfig);
  const policyOffers = policyOffersIFinder(settings);
  await report.run('smartCollections', 'iFinder smart collections', async () => {
    const hints = [];
    const details = {
      tierPolicy: settings.tierPolicy,
      scope: SMART_COLLECTIONS_SCOPE,
      subject
    };
    if (!policyOffers) {
      hints.push(
        `The tier policy is "${settings.tierPolicy}", so users see no iFinder smart collections. Set it to "both" or "ifinder" under Admin > Projects > Project settings.`
      );
    }
    let collections;
    try {
      ({ collections } = await smartCollections.list({ user, timeoutMs: timeout || 30000 }));
    } catch (error) {
      const code =
        error instanceof SmartCollectionsError ? error.code : SMART_COLLECTIONS_ERRORS.UNAVAILABLE;
      return {
        // A warning while no user is meant to see the tier: an older iFinder
        // must not turn the whole iFinder test red.
        status: policyOffers ? STATUS.FAIL : STATUS.WARN,
        message: `The Smart Collections API is not usable: ${code}${error?.status ? ` (HTTP ${error.status})` : ''}`,
        details: { ...details, error: code, httpStatus: error?.status ?? undefined },
        hints: [...smartCollectionsFailureHints(code, { exchange }), ...hints]
      };
    }
    details.collectionCount = collections.length;
    details.collections = collections.slice(0, 10).map(({ id, name, documentCount }) => ({
      id,
      name,
      documentCount
    }));
    if (subject && subject !== subject.toLowerCase()) {
      hints.push(
        `The subject "${subject}" has capital letters. iFinder's list matches the collection owner case-sensitively: a collection created in iFinder under a differently cased login is missing from the list, but still opens by its id. Set the JWT Subject Field so it yields the iFinder login exactly.`
      );
    }
    if (collections.length === 0) {
      hints.push(
        `The API works, but "${subject || 'this user'}" owns no smart collection. Collections are listed by owner; ones shared with the user are not. Check the owner of the collection in iFinder against this subject.`
      );
    }
    return {
      status: !policyOffers || collections.length === 0 ? STATUS.WARN : STATUS.OK,
      message: `The Smart Collections API answered: ${collections.length} collection(s) owned by "${subject || 'the test user'}"`,
      details,
      hints
    };
  });
}

/**
 * Check the OIDC metadata iFinder has to fetch in order to validate the token.
 *
 * This is the step that explains the "iFinder returned 500 because it could not
 * resolve the name" class of failure: iFinder calls back to the issuer URL that
 * iHub advertises, and a short hostname or a localhost URL only resolves on the
 * iHub host itself.
 *
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {import('express').Request} params.req
 * @param {Object} params.iFinderConfig
 * @param {Object|undefined} params.jwtInfo - decodeJwt result of the test token
 * @param {number} params.timeout
 * @returns {Promise<Object>} `{ jwksUrl, issuer }`
 */
export async function runOidcCallbackSteps(report, { req, iFinderConfig, jwtInfo, timeout }) {
  const { issuer, fetchableIssuer, source, fromTrustedConfig } = resolveIssuerUrl(req);
  // Display value: may be derived from the request, so it is only ever printed.
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  // Request value: null unless the issuer came from platform config, so nothing
  // taken from the request can decide which host the JWKS probe contacts.
  const fetchableJwksUrl = fetchableIssuer ? `${fetchableIssuer}/.well-known/jwks.json` : null;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  if (getAuthMode(iFinderConfig) === IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE) {
    report.skip(
      'oidcIssuer',
      'Issuer reachable for iFinder',
      'Not applicable: the token is issued by the OIDC provider, so iFinder verifies it against the JWKS of that provider, not of iHub.'
    );
    return { issuer, jwksUrl, applicable: false };
  }

  if (!iFinderConfig.useOidcKeyPair) {
    report.skip(
      'oidcIssuer',
      'Issuer reachable for iFinder',
      'Not applicable: JWT is signed with a dedicated private key, so iFinder verifies with the public key deployed in iFinder instead of fetching JWKS.'
    );
    return { issuer, jwksUrl, applicable: false };
  }

  const issuerInfo = inspectUrl(issuer, { remoteCallback: true });
  report.add({
    id: 'oidcIssuer',
    label: 'Issuer reachable for iFinder',
    status: issuerInfo.valid
      ? issuerInfo.warnings.length > 0
        ? STATUS.WARN
        : STATUS.OK
      : STATUS.FAIL,
    message: issuerInfo.valid
      ? `iFinder will fetch the signing keys from ${jwksUrl}`
      : `iFinder cannot use the advertised issuer ${issuer}: ${issuerInfo.errors.join(' ')}`,
    details: {
      issuer,
      issuerSource: source,
      jwksUrl,
      discoveryUrl,
      tokenIssuerClaim: jwtInfo?.issuer,
      fullyQualifiedHostname: issuerInfo.isFqdn || issuerInfo.isIpLiteral
    },
    hints: [
      ...issuerInfo.errors,
      ...issuerInfo.warnings,
      `Verify from the iFinder host that the URL is reachable: curl -sv ${jwksUrl}`,
      'Set the URL explicitly under Admin > Authentication > OAuth Server when auto-detection picks the wrong host.'
    ]
  });

  // iFinder derives the JWKS location from the "iss" claim. A claim that is not
  // an absolute URL makes discovery structurally impossible, which is a harder
  // failure than a claim that merely points somewhere else.
  const tokenIssuer = jwtInfo?.issuer;
  if (tokenIssuer && !/^https?:\/\//.test(tokenIssuer)) {
    report.add({
      id: 'oidcIssuerMatch',
      label: 'Issuer claim is a discoverable URL',
      status: STATUS.FAIL,
      message: `The token carries iss="${tokenIssuer}", which is not a URL — iFinder has no JWKS endpoint to discover`,
      details: { tokenIssuerClaim: tokenIssuer, metadataIssuer: issuer, jwksUrl },
      hints: [
        `Set the OAuth Issuer URL under Admin > Authentication > OAuth Server to the externally reachable URL of iHub (for example ${issuer}). OIDC key pair mode uses it as the "iss" claim.`,
        'Without it iHub falls back to the plain "ihub-apps" issuer, which iFinder cannot resolve — that is what surfaces as a 500 or a 401 during token validation.'
      ]
    });
  } else if (tokenIssuer && issuer && tokenIssuer.replace(/\/+$/, '') !== issuer) {
    report.add({
      id: 'oidcIssuerMatch',
      label: 'Issuer claim matches metadata URL',
      status: STATUS.WARN,
      message: `The token says iss="${tokenIssuer}" but the metadata is served from ${issuer}`,
      details: { tokenIssuerClaim: tokenIssuer, metadataIssuer: issuer },
      hints: [
        'iFinder resolves the JWKS location from the "iss" claim. If the two differ, validation fails with a 401 or a 500.',
        'Align Admin > Authentication > OAuth Server with the externally reachable URL of iHub.'
      ]
    });
  }

  // The issuer is only fetched when it comes from platform config. Auto-detection
  // derives it from the Host header, which the caller controls, so fetching it
  // would turn this endpoint into a server-side request forgery primitive: the
  // header alone would decide which host iHub contacts. The computed URL is still
  // reported, since seeing it is what tells the admin to pin it explicitly.
  if (!fromTrustedConfig) {
    report.add({
      id: 'jwks',
      label: 'JWKS endpoint serves the signing key',
      status: STATUS.WARN,
      message: `Not checked: the issuer URL is auto-detected, so ${jwksUrl} was not requested`,
      details: { url: jwksUrl, issuerSource: source },
      hints: [
        'Configure the OAuth Issuer URL under Admin > Authentication > OAuth Server. iHub then knows its own externally reachable URL, this check runs against it, and the "iss" claim stops depending on which host name a client happens to use.',
        `Until then, verify it by hand from the iFinder host: curl -sv ${jwksUrl}`
      ]
    });
    return { issuer, jwksUrl, applicable: true };
  }

  await report.run('jwks', 'JWKS endpoint serves the signing key', async () => {
    // This probe runs from the iHub server against iHub's own external URL. It
    // can fail for reasons that do not affect iFinder at all — split-horizon DNS
    // or a load balancer without hairpin NAT — so an unreachable endpoint is a
    // warning to re-check from the iFinder host. Only the *content* of a
    // successful response is conclusive.
    const unreachableHint = `Re-run the check from the iFinder host: curl -sv ${fetchableJwksUrl}. If it answers there, the integration is fine and only iHub cannot reach its own external URL.`;

    let response;
    try {
      response = await throttledFetch('iFinderTest', fetchableJwksUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout
      });
    } catch (error) {
      return {
        status: STATUS.WARN,
        message: `${jwksUrl} is not reachable from the iHub server: ${error.message}`,
        details: { url: jwksUrl, error: error.message, code: error.code },
        hints: [
          unreachableHint,
          ...describeNetworkError(error, { hostname: inspectUrl(jwksUrl).hostname })
        ]
      };
    }

    const bodyText = await response.text();
    if (!response.ok) {
      return {
        status: STATUS.WARN,
        message: `${jwksUrl} returned ${response.status} when called from the iHub server`,
        details: { url: jwksUrl, status: response.status, body: truncateBody(bodyText, 500) },
        hints: [
          unreachableHint,
          'If it fails from the iFinder host too, iFinder cannot validate any token. Check whether a reverse proxy in front of iHub blocks /.well-known/ paths.'
        ]
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return {
        status: STATUS.WARN,
        message: `${jwksUrl} did not return JSON`,
        details: { url: jwksUrl, body: truncateBody(bodyText, 500) },
        hints: [
          'A reverse proxy or an SSO login page is answering instead of iHub.',
          unreachableHint
        ]
      };
    }

    const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
    const keyIds = keys.map(key => key.kid).filter(Boolean);

    if (keys.length === 0) {
      return {
        status: STATUS.FAIL,
        message: 'The JWKS endpoint publishes no keys',
        details: { url: jwksUrl, note: parsed.note, keyIds },
        hints: [
          'Set "jwt.algorithm" to RS256 under Admin > Authentication: with the symmetric HS256 algorithm iHub cannot publish a public key, and iFinder has no way to verify the signature.'
        ]
      };
    }

    if (jwtInfo?.keyId && !keyIds.includes(jwtInfo.keyId)) {
      return {
        status: STATUS.FAIL,
        message: `The token is signed with kid="${jwtInfo.keyId}", which the JWKS endpoint does not publish`,
        details: { url: jwksUrl, tokenKeyId: jwtInfo.keyId, publishedKeyIds: keyIds },
        hints: [
          'iFinder will reject the token because it cannot find a matching key.',
          'This happens when the RSA key pair was rotated but a cached JWKS is still served, or when a reverse proxy caches /.well-known/jwks.json. Clear the cache and retry.'
        ]
      };
    }

    return {
      status: STATUS.OK,
      message: `Signing key kid="${jwtInfo?.keyId ?? keyIds[0]}" is published at ${jwksUrl}`,
      details: { url: jwksUrl, publishedKeyIds: keyIds, tokenKeyId: jwtInfo?.keyId },
      hints: [
        'Reachable from the iHub server. iFinder must be able to reach the very same URL — verify it from the iFinder host as well.'
      ]
    };
  });

  return { issuer, jwksUrl, applicable: true };
}

/**
 * Execute the request an integration really performs at runtime and report it in
 * full: URL, method, redacted headers, a reproducible curl command, the response
 * status, the interesting response headers and a body excerpt.
 *
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @returns {Promise<Object>} `{ ok, request, response }`
 */
export async function runApiRequestStep(
  report,
  { id, label, url, method = 'GET', headers, body, token, includeToken, timeout, jwtInfo, context }
) {
  const requestInfo = {
    method,
    url,
    headers: redactHeaders(headers),
    ...(body ? { body } : {}),
    curl: buildCurlCommand({
      url,
      method,
      headers,
      body,
      token: includeToken ? token : undefined
    })
  };

  // `report.run` only keeps the reportable fields, so the parsed payload is
  // captured here for the caller's follow-up assertions.
  let parsedBody;

  const step = await report.run(id, label, async () => {
    const startedAt = Date.now();
    let response;
    try {
      response = await throttledFetch('iFinderTest', url, { method, headers, body, timeout });
    } catch (error) {
      const parsed = inspectUrl(url);
      return {
        status: STATUS.FAIL,
        message: `Request failed before a response arrived: ${error.message}`,
        details: { request: requestInfo, error: error.message, code: error.code },
        hints: describeNetworkError(error, {
          hostname: parsed.hostname,
          port: parsed.port,
          timeout
        })
      };
    }

    const durationMs = Date.now() - startedAt;
    const responseHeaders = pickResponseHeaders(response.headers);
    const bodyText = await response.text();

    if (!response.ok) {
      return {
        status: STATUS.FAIL,
        message: `${method} ${url} returned ${response.status} ${response.statusText || ''}`.trim(),
        details: {
          request: requestInfo,
          status: response.status,
          statusText: response.statusText,
          durationMs,
          responseHeaders,
          responseBody: truncateBody(bodyText)
        },
        hints: describeHttpFailure({
          status: response.status,
          body: bodyText,
          headers: responseHeaders,
          jwt: jwtInfo || {},
          context
        })
      };
    }

    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      parsedBody = undefined;
    }

    return {
      status: STATUS.OK,
      message: `${method} ${url} returned ${response.status} in ${durationMs}ms`,
      details: {
        request: requestInfo,
        status: response.status,
        durationMs,
        responseHeaders,
        responsePreview: truncateBody(bodyText, 800)
      }
    };
  });

  return {
    ok: step.status === STATUS.OK,
    request: requestInfo,
    parsed: parsedBody,
    status: step.status
  };
}

/**
 * Send a diagnostics report as the endpoint response.
 * @param {import('express').Response} res
 * @param {DiagnosticsReport} report
 * @param {Object} params
 * @param {string} params.integration - 'iFinder' | 'iAssistant'
 * @param {string} [params.successMessage]
 * @param {Object} [params.jwt] - JWT block for the response
 * @param {Object} [params.request] - Primary request that was executed
 * @param {Object} [params.details] - Flat summary retained for existing consumers
 */
