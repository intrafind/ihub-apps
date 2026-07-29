import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import iFinderService from '../../services/integrations/iFinderService.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import conversationApiService from '../../services/integrations/ConversationApiService.js';
import { getIFinderAuthorizationHeader, validateIFinderJWT } from '../../utils/iFinderJwt.js';
import { throttledFetch } from '../../requestThrottler.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import {
  DiagnosticsReport,
  STATUS,
  buildCurlCommand,
  decodeJwt,
  describeHttpFailure,
  describeNetworkError,
  describeTransport,
  inspectUrl,
  pickResponseHeaders,
  previewToken,
  probeTcpTls,
  redactHeaders,
  resolveHostname,
  truncateBody
} from '../../services/integrations/integrationDiagnostics.js';

/**
 * Admin routes for testing integrations (iFinder, iAssistant).
 *
 * Both endpoints run a sequence of diagnostic steps instead of a single
 * pass/fail probe, because the failures admins actually hit while connecting
 * iHub to iFinder are indistinguishable from the outside: a 500 raised inside
 * iFinder while it tries to resolve the JWKS hostname of iHub, and a 401 with an
 * empty body, both used to surface as "test failed". Each step therefore reports
 * the URLs used, the resolved addresses, the TLS peer, the decoded JWT claims,
 * and hints naming what to check.
 */

/** Fields of a user object that may be overridden to test as somebody else. */
const OVERRIDABLE_USER_FIELDS = ['id', 'email', 'username', 'name', 'domain'];
const MAX_OVERRIDE_LENGTH = 320;

/**
 * Accept only known string fields from the request body, so the override cannot
 * be used to smuggle arbitrary structures into JWT generation.
 * @param {Object} raw - `user` object from the request body
 * @returns {Object} Sanitized override (may be empty)
 */
function sanitizeUserOverride(raw) {
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
function buildTestUser(req, override) {
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
 * When `platform.oauth.issuer` is unset the well-known routes derive it from the
 * incoming request, so the diagnostics do the same to report the URL iFinder
 * will really be pointed at.
 * @param {import('express').Request} req
 * @returns {Object} `{ issuer, source }`
 */
function resolveIssuerUrl(req) {
  const platform = configCache.getPlatform() || {};
  const configured = platform.oauth?.issuer;
  if (configured && configured.startsWith('http')) {
    return { issuer: configured.replace(/\/+$/, ''), source: 'platform.oauth.issuer' };
  }

  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  const basePath = buildServerPath('').replace(/\/$/, '');
  return {
    issuer: `${protocol}://${host}${basePath}`,
    source: 'auto-detected from this request'
  };
}

/**
 * Describe which key signs the iFinder JWT, without ever revealing it.
 * @param {Object} iFinderConfig
 * @returns {Object} `{ mode, available, description }`
 */
function describeSigningKey(iFinderConfig) {
  if (iFinderConfig.useOidcKeyPair) {
    const keyPair = tokenStorageService.getRSAKeyPair();
    return {
      mode: 'oidcKeyPair',
      available: Boolean(keyPair?.privateKey),
      description: 'iHub OIDC RSA key pair (published via /.well-known/jwks.json)'
    };
  }
  if (process.env.IFINDER_PRIVATE_KEY) {
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
async function runTransportSteps(report, { rawUrl, urlLabel, timeout }) {
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
      note: transport.viaProxy
        ? `This probe connects directly. Real requests go through the proxy ${transport.proxyUrl}, so a failure here does not necessarily break the integration.`
        : 'Direct connection from the iHub server (no proxy configured for this URL).',
      ...(probe.tls ? { tls: probe.tls } : {})
    };

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

    const tlsHints = [];
    let status = STATUS.OK;
    let message = `Connected to ${urlInfo.hostname}:${urlInfo.port} in ${probe.durationMs}ms`;

    if (probe.tls) {
      message += ` (${probe.tls.protocol}, certificate for ${probe.tls.subject || 'unknown subject'})`;
      if (!probe.tls.authorized) {
        status = transport.ignoreInvalidCertificates ? STATUS.WARN : STATUS.FAIL;
        message = `TLS certificate of ${urlInfo.hostname} is not trusted: ${probe.tls.authorizationError}`;
        tlsHints.push(
          `Add the CA that issued "${probe.tls.issuer || 'the certificate'}" to the trust store of the iHub server.`
        );
        if (probe.tls.selfSigned) {
          tlsHints.push('The certificate is self-signed.');
        }
        if (transport.ignoreInvalidCertificates) {
          tlsHints.push(
            'This domain is whitelisted under Admin > Platform > SSL, so requests still go through — but only from iHub. Other clients will keep rejecting it.'
          );
        } else {
          tlsHints.push(
            'As a temporary workaround the domain can be whitelisted under Admin > Platform > SSL.'
          );
        }
      } else if (probe.tls.expired) {
        status = STATUS.WARN;
        tlsHints.push(`The certificate expired on ${probe.tls.validTo}.`);
      }
    }

    return { status, message, details, hints: tlsHints };
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
 * @param {Object} params.iFinderConfig - platform.iFinder
 * @param {Object} params.userOverride - Explicitly overridden user fields
 * @param {boolean} params.includeToken - Whether the raw JWT may be returned
 * @returns {Promise<Object|null>} `{ authHeader, token, info }` or null on failure
 */
async function runJwtSteps(report, { user, iFinderConfig, userOverride, includeToken }) {
  let authHeader;
  let token;
  let info;

  const generation = await report.run('jwt', 'JWT generation', () => {
    authHeader = getIFinderAuthorizationHeader(user);
    token = authHeader.replace(/^Bearer\s+/i, '');
    info = decodeJwt(token);

    const subjectField = iFinderConfig.jwtSubjectField || 'email';
    const hints = [];

    // The subject resolution falls back through email → username → id. When the
    // configured field was empty the token still gets signed, and iFinder then
    // rejects a subject the admin never intended to send.
    if (subjectField === 'email' && !String(info.subject).includes('@')) {
      hints.push(
        `JWT Subject Field is "email" but the subject "${info.subject}" is not an email address — the user has no email, so iHub fell back to the username or id. iFinder has to know the subject in exactly this form.`
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
      'A subject that cannot be resolved also fails here — see the JWT Subject Field setting.'
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
async function runOidcCallbackSteps(report, { req, iFinderConfig, jwtInfo, timeout }) {
  const { issuer, source } = resolveIssuerUrl(req);
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

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

  await report.run('jwks', 'JWKS endpoint serves the signing key', async () => {
    // This probe runs from the iHub server against iHub's own external URL. It
    // can fail for reasons that do not affect iFinder at all — split-horizon DNS
    // or a load balancer without hairpin NAT — so an unreachable endpoint is a
    // warning to re-check from the iFinder host. Only the *content* of a
    // successful response is conclusive.
    const unreachableHint = `Re-run the check from the iFinder host: curl -sv ${jwksUrl}. If it answers there, the integration is fine and only iHub cannot reach its own external URL.`;

    let response;
    try {
      response = await throttledFetch('iFinderTest', jwksUrl, {
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
async function runApiRequestStep(
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
function respond(res, report, { integration, successMessage, jwt, request, details }) {
  const summary = report.summary();
  const success = !report.hasFailure();
  const firstFailure = report.steps.find(step => step.status === STATUS.FAIL);

  const message = success
    ? summary.warn > 0
      ? `${successMessage} (${summary.warn} warning${summary.warn === 1 ? '' : 's'})`
      : successMessage
    : `${firstFailure.label}: ${firstFailure.message}`;

  logger.info(`${integration} integration test finished`, {
    component: 'IntegrationTest',
    success,
    summary,
    failedStep: firstFailure?.id
  });

  return res.json({
    success,
    message,
    integration,
    summary,
    steps: report.steps,
    ...(jwt ? { jwt } : {}),
    ...(request ? { request } : {}),
    details: {
      ...details,
      failedStep: firstFailure?.id,
      steps: summary
    }
  });
}

export default function registerIntegrationTestRoutes(app) {
  /**
   * @swagger
   * /admin/integrations/ifinder/_test:
   *   post:
   *     summary: Run iFinder connection diagnostics
   *     description: >
   *       Runs a sequence of diagnostic steps against the configured iFinder instance
   *       (URL validation, DNS resolution, TCP/TLS probe, JWT generation and local
   *       verification, OIDC/JWKS callback reachability, search API request) and returns
   *       every observed detail plus remediation hints (admin access required).
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               includeToken:
   *                 type: boolean
   *                 description: Include the signed JWT and an executable curl command in the result
   *               query:
   *                 type: string
   *                 description: Search term used for the test request (default "test")
   *               searchProfile:
   *                 type: string
   *                 description: Override the search profile for this test
   *               user:
   *                 type: object
   *                 description: Mint the test JWT for these user fields instead of the calling admin
   *                 properties:
   *                   id: { type: string }
   *                   email: { type: string }
   *                   username: { type: string }
   *                   name: { type: string }
   *                   domain: { type: string }
   *                   groups:
   *                     type: array
   *                     items: { type: string }
   *     responses:
   *       200:
   *         description: Diagnostics result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: True when no step failed
   *                 message:
   *                   type: string
   *                   description: Summary, or the first failing step
   *                 summary:
   *                   type: object
   *                   description: Step counts per status plus total duration
   *                 steps:
   *                   type: array
   *                   description: Ordered diagnostic steps
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       label: { type: string }
   *                       status:
   *                         type: string
   *                         enum: [ok, warn, fail, skip]
   *                       message: { type: string }
   *                       durationMs: { type: number }
   *                       details: { type: object }
   *                       hints:
   *                         type: array
   *                         items: { type: string }
   *                 jwt:
   *                   type: object
   *                   description: Decoded header, payload and claims of the test token
   *                 request:
   *                   type: object
   *                   description: The API request that was executed, including a curl command
   *                 details:
   *                   type: object
   *                   description: Flat result summary
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Test failed unexpectedly
   */
  app.post(
    buildServerPath('/api/admin/integrations/ifinder/_test'),
    adminAuth,
    async (req, res) => {
      const report = new DiagnosticsReport();

      try {
        const includeToken = req.body?.includeToken === true;
        const userOverride = sanitizeUserOverride(req.body?.user);
        const testUser = buildTestUser(req, userOverride);
        const testQuery =
          typeof req.body?.query === 'string' && req.body.query.trim() !== ''
            ? req.body.query.trim().slice(0, 200)
            : 'test';

        const platformConfig = configCache.getPlatform() || {};
        const iFinderConfig = platformConfig.iFinder || {};
        const config = iFinderService.getConfig();
        const searchProfile =
          (typeof req.body?.searchProfile === 'string' && req.body.searchProfile.trim()) ||
          config.defaultSearchProfile;
        const signingKey = describeSigningKey(iFinderConfig);
        const timeout = config.timeout || 30000;

        logger.info('Running iFinder integration diagnostics', {
          component: 'IntegrationTest',
          baseUrl: config.baseUrl,
          searchProfile,
          useOidcKeyPair: Boolean(iFinderConfig.useOidcKeyPair),
          includeToken,
          overriddenUserFields: Object.keys(userOverride),
          requestedBy: req.user?.id
        });

        const configDetails = {
          enabled: Boolean(iFinderConfig.enabled),
          baseUrl: config.baseUrl,
          searchEndpoint: config.endpoints.search,
          documentEndpoint: config.endpoints.document,
          searchProfile,
          timeoutMs: timeout,
          jwtSubjectField: iFinderConfig.jwtSubjectField || 'email',
          jwtAlgorithm: iFinderConfig.useOidcKeyPair ? 'RS256' : iFinderConfig.algorithm || 'RS256',
          jwtAudience: iFinderConfig.audience || 'ifinder-api',
          jwtIssuer: iFinderConfig.issuer || 'ihub-apps',
          tokenExpirationSeconds: iFinderConfig.tokenExpirationSeconds || 3600,
          defaultScope: iFinderConfig.defaultScope || 'fi_index_read',
          signingKeyMode: signingKey.mode,
          signingKeySource: signingKey.description
        };

        if (!iFinderConfig.enabled) {
          report.add({
            id: 'configuration',
            label: 'Configuration',
            status: STATUS.FAIL,
            message: 'The iFinder integration is disabled',
            details: configDetails,
            hints: ['Enable the integration at the top of this page and save.']
          });
          return respond(res, report, {
            integration: 'iFinder',
            details: { enabled: false, ...configDetails }
          });
        }

        if (!iFinderConfig.baseUrl && !config.baseUrl) {
          report.add({
            id: 'configuration',
            label: 'Configuration',
            status: STATUS.FAIL,
            message: 'No iFinder base URL is configured',
            details: configDetails,
            hints: [
              'Set the iFinder Base URL on this page, or provide the IFINDER_API_URL environment variable.'
            ]
          });
          return respond(res, report, {
            integration: 'iFinder',
            details: { missingConfig: 'baseUrl', ...configDetails }
          });
        }

        if (!signingKey.available) {
          report.add({
            id: 'configuration',
            label: 'Configuration',
            status: STATUS.FAIL,
            message: iFinderConfig.useOidcKeyPair
              ? 'The iHub OIDC RSA key pair is not initialized, so no iFinder JWT can be signed'
              : 'No iFinder private key is configured',
            details: configDetails,
            hints: iFinderConfig.useOidcKeyPair
              ? [
                  'Set "jwt.algorithm" to RS256 under Admin > Authentication so iHub generates an RSA key pair, then restart the server.'
                ]
              : [
                  'Store the private key as the iFinder credential (iFinder.privateKeyRef) or provide the IFINDER_PRIVATE_KEY environment variable in PEM format.',
                  'Alternatively enable "Use OIDC key pair" to sign with the key pair iHub already publishes via JWKS.'
                ]
          });
          return respond(res, report, {
            integration: 'iFinder',
            details: {
              missingConfig: iFinderConfig.useOidcKeyPair ? 'oidcKeyPair' : 'privateKey',
              ...configDetails
            }
          });
        }

        report.add({
          id: 'configuration',
          label: 'Configuration',
          status: STATUS.OK,
          message: `Signing with ${signingKey.description}, subject from "${configDetails.jwtSubjectField}"`,
          details: configDetails
        });

        const urlInfo = await runTransportSteps(report, {
          rawUrl: config.baseUrl,
          urlLabel: 'iFinder base',
          timeout
        });

        const jwtResult = await runJwtSteps(report, {
          user: testUser,
          iFinderConfig,
          userOverride,
          includeToken
        });

        const oidc = await runOidcCallbackSteps(report, {
          req,
          iFinderConfig,
          jwtInfo: jwtResult?.info,
          timeout
        });

        let request;
        if (!urlInfo.valid || !jwtResult) {
          report.skip(
            'search',
            'iFinder search API request',
            'Skipped because the base URL or the JWT could not be prepared.'
          );
        } else {
          const searchEndpoint = config.endpoints.search.replace(
            '{profileId}',
            encodeURIComponent(searchProfile)
          );
          const searchUrl = `${config.baseUrl.replace(/\/+$/, '')}${searchEndpoint}?query=${encodeURIComponent(testQuery)}&size=1`;

          const result = await runApiRequestStep(report, {
            id: 'search',
            label: 'iFinder search API request',
            url: searchUrl,
            method: 'GET',
            headers: { Authorization: jwtResult.authHeader, Accept: 'application/json' },
            token: jwtResult.token,
            includeToken,
            timeout,
            jwtInfo: jwtResult.info,
            context: {
              useOidcKeyPair: Boolean(iFinderConfig.useOidcKeyPair),
              jwksUrl: oidc.applicable ? oidc.jwksUrl : undefined,
              searchProfile
            }
          });
          request = result.request;

          if (result.ok) {
            report.add({
              id: 'searchResult',
              label: 'Search result',
              status: STATUS.OK,
              message: `iFinder answered the query "${testQuery}" with ${result.parsed?.metadata?.total_hits ?? 0} hit(s)`,
              details: {
                query: testQuery,
                searchProfile,
                totalHits: result.parsed?.metadata?.total_hits ?? 0,
                tookMs: result.parsed?.metadata?.took
              },
              hints:
                (result.parsed?.metadata?.total_hits ?? 0) === 0
                  ? [
                      `The connection works but the query "${testQuery}" matched nothing. Confirm the search profile "${searchProfile}" contains documents the user "${jwtResult.info.subject}" is allowed to see.`
                    ]
                  : []
            });
          }
        }

        return respond(res, report, {
          integration: 'iFinder',
          successMessage: 'iFinder integration is working correctly',
          jwt: jwtResult
            ? {
                subject: jwtResult.info.subject,
                header: jwtResult.info.header,
                payload: jwtResult.info.payload,
                preview: previewToken(jwtResult.token),
                ...(includeToken ? { token: jwtResult.token } : {})
              }
            : undefined,
          request,
          details: {
            ...configDetails,
            jwtGeneration: jwtResult ? 'success' : 'failed',
            jwksUrl: oidc.applicable ? oidc.jwksUrl : undefined
          }
        });
      } catch (error) {
        logger.error('iFinder integration test error', { component: 'IntegrationTest', error });
        report.add({
          id: 'unexpected',
          label: 'Unexpected error',
          status: STATUS.FAIL,
          message: error.message || 'iFinder integration test failed',
          details: { error: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') },
          hints: [
            'Check the iHub server log (component "IntegrationTest") for the full stack trace.'
          ]
        });
        return respond(res, report, {
          integration: 'iFinder',
          details: { error: error.message }
        });
      }
    }
  );

  /**
   * @swagger
   * /admin/integrations/iassistant/_test:
   *   post:
   *     summary: Run iAssistant connection diagnostics
   *     description: >
   *       Runs a sequence of diagnostic steps against the iAssistant Conversation API
   *       (URL validation, DNS resolution, TCP/TLS probe, JWT generation and local
   *       verification, OIDC/JWKS callback reachability, profile listing, and optionally a
   *       full conversation round-trip) and returns every observed detail plus remediation
   *       hints (admin access required).
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               includeToken:
   *                 type: boolean
   *                 description: Include the signed JWT and an executable curl command in the result
   *               conversationRoundTrip:
   *                 type: boolean
   *                 description: Additionally create and delete an ephemeral conversation
   *               user:
   *                 type: object
   *                 description: Mint the test JWT for these user fields instead of the calling admin
   *                 properties:
   *                   id: { type: string }
   *                   email: { type: string }
   *                   username: { type: string }
   *                   name: { type: string }
   *                   domain: { type: string }
   *                   groups:
   *                     type: array
   *                     items: { type: string }
   *     responses:
   *       200:
   *         description: Diagnostics result, same shape as the iFinder diagnostics
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Test failed unexpectedly
   */
  app.post(
    buildServerPath('/api/admin/integrations/iassistant/_test'),
    adminAuth,
    async (req, res) => {
      const report = new DiagnosticsReport();

      try {
        const includeToken = req.body?.includeToken === true;
        const conversationRoundTrip = req.body?.conversationRoundTrip === true;
        const userOverride = sanitizeUserOverride(req.body?.user);
        const testUser = buildTestUser(req, userOverride);

        const platformConfig = configCache.getPlatform() || {};
        const iFinderConfig = platformConfig.iFinder || {};
        const config = iAssistantService.getConfig();
        const signingKey = describeSigningKey(iFinderConfig);
        const timeout = config.timeout || 60000;

        logger.info('Running iAssistant integration diagnostics', {
          component: 'IntegrationTest',
          baseUrl: config.baseUrl,
          profileId: config.defaultProfileId,
          conversationRoundTrip,
          includeToken,
          requestedBy: req.user?.id
        });

        const configDetails = {
          baseUrl: config.baseUrl,
          baseUrlSource: 'inherited from the iFinder base URL',
          apiBasePath: '/public-api/rag/api/v0',
          profileId: config.defaultProfileId,
          searchProfile: config.defaultSearchProfile,
          timeoutMs: timeout,
          jwtSubjectField: iFinderConfig.jwtSubjectField || 'email',
          signingKeyMode: signingKey.mode,
          signingKeySource: signingKey.description
        };

        if (!config.baseUrl) {
          report.add({
            id: 'configuration',
            label: 'Configuration',
            status: STATUS.FAIL,
            message: 'No base URL is configured',
            details: configDetails,
            hints: [
              'iAssistant reuses the iFinder Base URL. Configure it in the iFinder Connection section above.'
            ]
          });
          return respond(res, report, {
            integration: 'iAssistant',
            details: { missingConfig: 'baseUrl', ...configDetails }
          });
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
          return respond(res, report, {
            integration: 'iAssistant',
            details: { missingConfig: 'signingKey', ...configDetails }
          });
        }

        report.add({
          id: 'configuration',
          label: 'Configuration',
          status: config.defaultProfileId ? STATUS.OK : STATUS.WARN,
          message: config.defaultProfileId
            ? `Profile "${config.defaultProfileId}" on ${config.baseUrl}`
            : 'No default profile id configured',
          details: configDetails,
          hints: config.defaultProfileId
            ? []
            : [
                'Apps without an explicit profile fall back to the default profile id. Set it in the iAssistant Settings section, or provide IASSISTANT_PROFILE_ID.'
              ]
        });

        const urlInfo = await runTransportSteps(report, {
          rawUrl: config.baseUrl,
          urlLabel: 'iAssistant base',
          timeout
        });

        const jwtResult = await runJwtSteps(report, {
          user: testUser,
          iFinderConfig,
          userOverride,
          includeToken
        });

        const oidc = await runOidcCallbackSteps(report, {
          req,
          iFinderConfig,
          jwtInfo: jwtResult?.info,
          timeout
        });

        let request;
        if (!urlInfo.valid || !jwtResult) {
          report.skip(
            'profiles',
            'iAssistant profile list',
            'Skipped because the base URL or the JWT could not be prepared.'
          );
        } else {
          const profilesUrl = `${config.baseUrl.replace(/\/+$/, '')}/public-api/rag/api/v0/profiles`;
          const requestContext = {
            useOidcKeyPair: Boolean(iFinderConfig.useOidcKeyPair),
            jwksUrl: oidc.applicable ? oidc.jwksUrl : undefined,
            profileId: config.defaultProfileId
          };

          const result = await runApiRequestStep(report, {
            id: 'profiles',
            label: 'iAssistant profile list',
            url: profilesUrl,
            method: 'GET',
            headers: { Authorization: jwtResult.authHeader, Accept: 'application/json' },
            token: jwtResult.token,
            includeToken,
            timeout,
            jwtInfo: jwtResult.info,
            context: requestContext
          });
          request = result.request;

          if (result.ok) {
            // The payload shape differs between iAssistant versions, so accept
            // either a bare array or a wrapper object.
            const rawProfiles = Array.isArray(result.parsed)
              ? result.parsed
              : result.parsed?.profiles || result.parsed?.items || [];
            const profileIds = rawProfiles
              .map(profile => (typeof profile === 'string' ? profile : profile?.id))
              .filter(Boolean);
            const configured = config.defaultProfileId;
            const known = !configured || profileIds.length === 0 || profileIds.includes(configured);

            report.add({
              id: 'profileExists',
              label: 'Configured profile exists',
              status: known ? STATUS.OK : STATUS.FAIL,
              message: known
                ? configured
                  ? `Profile "${configured}" is available`
                  : `iAssistant offers ${profileIds.length} profile(s)`
                : `Profile "${configured}" is not among the profiles iAssistant returns`,
              details: { configuredProfileId: configured, availableProfileIds: profileIds },
              hints: known
                ? []
                : [
                    `Set the Default Profile ID to one of: ${profileIds.join(', ') || '(none returned)'}.`,
                    `Profile ids are case sensitive, and the user "${jwtResult.info.subject}" only sees the profiles they are permitted to use.`
                  ]
            });
          }

          if (!conversationRoundTrip) {
            report.skip(
              'conversation',
              'Conversation round-trip',
              'Not requested. Enable "Run conversation round-trip" to additionally create and delete an ephemeral conversation.'
            );
          } else if (!result.ok) {
            report.skip(
              'conversation',
              'Conversation round-trip',
              'Skipped because the profile list request already failed.'
            );
          } else {
            await report.run('conversation', 'Conversation round-trip', async () => {
              const conversation = await conversationApiService.createConversation({
                user: testUser,
                baseUrl: config.baseUrl,
                searchProfile: config.defaultSearchProfile,
                labels: ['ihub-connection-test'],
                ephemeral: true
              });

              const conversationId = conversation?.id || conversation?.conversation?.id;
              let deleted = false;
              if (conversationId) {
                try {
                  await conversationApiService.deleteConversation(conversationId, {
                    user: testUser,
                    baseUrl: config.baseUrl
                  });
                  deleted = true;
                } catch (error) {
                  logger.warn('Could not delete the test conversation', {
                    component: 'IntegrationTest',
                    conversationId,
                    error: error.message
                  });
                }
              }

              return {
                status: STATUS.OK,
                message: `Created an ephemeral conversation${deleted ? ' and deleted it again' : ''}`,
                details: {
                  conversationId,
                  searchProfile: config.defaultSearchProfile,
                  cleanedUp: deleted
                },
                hints: deleted
                  ? []
                  : [
                      `The test conversation ${conversationId || '(unknown id)'} could not be deleted. It is marked ephemeral, so iAssistant should clean it up on its own.`
                    ]
              };
            });
          }
        }

        return respond(res, report, {
          integration: 'iAssistant',
          successMessage: 'iAssistant integration is working correctly',
          jwt: jwtResult
            ? {
                subject: jwtResult.info.subject,
                header: jwtResult.info.header,
                payload: jwtResult.info.payload,
                preview: previewToken(jwtResult.token),
                ...(includeToken ? { token: jwtResult.token } : {})
              }
            : undefined,
          request,
          details: {
            ...configDetails,
            jwtGeneration: jwtResult ? 'success' : 'failed',
            jwksUrl: oidc.applicable ? oidc.jwksUrl : undefined
          }
        });
      } catch (error) {
        logger.error('iAssistant integration test error', { component: 'IntegrationTest', error });
        report.add({
          id: 'unexpected',
          label: 'Unexpected error',
          status: STATUS.FAIL,
          message: error.message || 'iAssistant integration test failed',
          details: { error: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') },
          hints: [
            'Check the iHub server log (component "IntegrationTest") for the full stack trace.'
          ]
        });
        return respond(res, report, {
          integration: 'iAssistant',
          details: { error: error.message }
        });
      }
    }
  );
}
