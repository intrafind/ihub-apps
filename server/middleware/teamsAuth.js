// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import jwt from 'jsonwebtoken';
import { promisify } from 'node:util';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { isAccountDisabledError } from '../utils/accountDisabledError.js';
import { generateJwt } from '../utils/tokenService.js';
import ErrorHandler from '../utils/ErrorHandler.js';
import logger from '../utils/logger.js';
import { setAuthCookie } from '../utils/cookieSettings.js';
import { clearOidcLogoutHint } from '../utils/oidcLogoutHint.js';

import { ServiceError } from '../utils/ServiceError.js';
// jwks-rsa pulls in jose (pure ESM) internally via a synchronous require(), so
// a static top-level import here would blow up as soon as anything imports
// this file — e.g. for route registration — under Jest's CJS-style module
// loading, even when Teams auth is never exercised. Deferred until a Teams
// token actually needs verifying.
async function createJwksClient(tenantId) {
  const { default: jwksClient } = await import('jwks-rsa');
  return jwksClient({
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 60 * 1000 // 10 hours
  });
}

// Cache for JWKS clients per tenant
const jwksClients = new Map();

/**
 * Get or create JWKS client for a tenant
 */
async function getJwksClient(tenantId) {
  if (!jwksClients.has(tenantId)) {
    jwksClients.set(tenantId, createJwksClient(tenantId));
  }
  return jwksClients.get(tenantId);
}

/**
 * Verify Microsoft Teams SSO token
 */
async function verifyTeamsToken(token, teamsConfig) {
  try {
    // Decode token without verification to get header and claims
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      throw new Error('TEAMS_INVALID_TOKEN_FORMAT');
    }

    const { header, payload } = decoded;

    // Get the tenant ID from the token
    const tenantId = payload.tid || teamsConfig.tenantId;
    if (!tenantId) {
      throw new Error('TEAMS_NO_TENANT_ID');
    }

    // Get JWKS client for this tenant
    const client = await getJwksClient(tenantId);
    const getSigningKey = promisify(client.getSigningKey);

    // Get the signing key
    const key = await getSigningKey(header.kid);
    const signingKey = key.publicKey || key.rsaPublicKey;

    // Verify the token
    const verifyOptions = {
      algorithms: ['RS256'],
      issuer: teamsConfig.validIssuers || [
        `https://login.microsoftonline.com/${tenantId}/v2.0`,
        `https://sts.windows.net/${tenantId}/`
      ],
      audience: [
        teamsConfig.clientId,
        `api://${teamsConfig.domain}/${teamsConfig.clientId}`,
        `spn:${teamsConfig.clientId}`
      ]
    };

    const verified = jwt.verify(token, signingKey, verifyOptions);
    return verified;
  } catch (error) {
    logger.error('Teams token verification failed', { component: 'TeamsAuth', error });
    throw error;
  }
}

/**
 * Normalize Teams user data
 */
function normalizeTeamsUser(tokenData, profile, groups, teamsConfig) {
  // Extract user information
  const userId = tokenData.oid || tokenData.sub || profile?.id;
  const email =
    tokenData.email || tokenData.preferred_username || profile?.mail || profile?.userPrincipalName;
  const name = tokenData.name || profile?.displayName || email;

  // Map external groups to internal groups
  const mappedGroups = mapExternalGroups(groups);

  // Create user object
  let user = {
    id: userId,
    name: name,
    email: email,
    groups: mappedGroups,
    provider: 'teams',
    authMethod: 'teams',
    authenticated: true,
    teamsData: {
      tenantId: tokenData.tid,
      upn: tokenData.upn || profile?.userPrincipalName
    }
  };

  // Enhance user with authenticated group and provider-specific groups
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  user = enhanceUserGroups(user, authConfig, teamsConfig);

  return user;
}

/**
 * Teams authentication middleware
 */
export async function teamsAuthMiddleware(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const teamsConfig = platform.teamsAuth || {};

  // Skip if Teams auth is not enabled
  if (!teamsConfig.enabled) {
    return next();
  }

  // Check for Teams SSO token in Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const ssoToken = authHeader.substring(7);

  // Check if this is a Teams SSO token (not our JWT)
  try {
    const decoded = jwt.decode(ssoToken);
    const isTeamsToken =
      decoded?.iss &&
      (decoded.iss.startsWith('https://login.microsoftonline.com/') ||
        decoded.iss.startsWith('https://sts.windows.net/'));
    if (!decoded || !isTeamsToken) {
      // Not a Teams token, continue with normal auth flow
      return next();
    }
  } catch {
    return next();
  }

  try {
    // Verify the Teams SSO token
    const tokenData = await verifyTeamsToken(ssoToken, teamsConfig);

    // Get user profile and groups if we have an access token
    let profile = null;
    let groups = [];

    // Note: The SSO token is an ID token, not an access token
    // To get user profile and groups, we would need to implement the On-Behalf-Of flow
    // For now, we'll use the information from the ID token

    // Extract groups from token if present
    if (tokenData.groups) {
      groups = tokenData.groups;
    }

    // Normalize user data
    const normalizedUser = normalizeTeamsUser(tokenData, profile, groups, teamsConfig);

    // Validate and persist the user like every other external provider (OIDC/LDAP/NTLM/Proxy),
    // so an administrator can disable a Teams user via users.json
    const user = await validateAndPersistExternalUser(normalizedUser, platform);

    // Generate our JWT token using centralized token service
    const { token } = generateJwt(user, {
      authMode: 'teams',
      authProvider: 'teams',
      additionalClaims: {
        teamsData: user.teamsData
      }
    });

    // Attach user and token to request
    req.user = user;
    req.teamsToken = token;
    req.isTeamsAuth = true;

    next();
  } catch (error) {
    logger.error('Teams authentication failed', { component: 'TeamsAuth', error });

    if (isAccountDisabledError(error)) {
      return res.status(403).json({
        error: 'access_denied',
        error_description: 'User account has been disabled'
      });
    }

    // Don't fail the request, just continue without Teams auth
    // This allows fallback to other auth methods
    next();
  }
}

/**
 * Teams token exchange endpoint handler
 */
export async function teamsTokenExchange(req, res) {
  const errorHandler = new ErrorHandler();
  const language = req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'en';
  const refuse = async code =>
    new ServiceError(code, await errorHandler.getLocalizedError(code, {}, language));

  // Request validation first: these refusals are not sign-in failures.
  const { ssoToken } = req.body;
  if (!ssoToken) throw await refuse('TEAMS_SSO_TOKEN_REQUIRED');

  const platform = configCache.getPlatform() || {};
  const teamsConfig = platform.teamsAuth || {};
  if (!teamsConfig.enabled) throw await refuse('TEAMS_AUTH_NOT_ENABLED');

  try {
    // Verify the Teams SSO token
    const tokenData = await verifyTeamsToken(ssoToken, teamsConfig);

    // Get user groups from token if present
    const groups = tokenData.groups || [];

    // Normalize user data
    const normalizedUser = normalizeTeamsUser(tokenData, null, groups, teamsConfig);

    // Validate and persist the user like every other external provider (OIDC/LDAP/NTLM/Proxy),
    // so an administrator can disable a Teams user via users.json
    const user = await validateAndPersistExternalUser(normalizedUser, platform);

    // Generate our JWT token using centralized token service
    const { token, expiresIn } = generateJwt(user, {
      authMode: 'teams',
      authProvider: 'teams',
      additionalClaims: {
        teamsData: user.teamsData
      }
    });

    // Set HTTP-only cookie for authentication
    setAuthCookie(req, res, token, expiresIn);
    // Drop any oidcLogoutHint left over from an earlier OIDC login on this
    // browser: it would keep an ID token around and send this session's logout
    // through an unrelated provider. See utils/oidcLogoutHint.js.
    clearOidcLogoutHint(res, req);

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        groups: user.groups,
        provider: user.provider,
        authMethod: user.authMethod
      },
      token, // Still return token for backward compatibility
      expiresIn
    });
  } catch (error) {
    logger.error('Teams token exchange error', { component: 'TeamsAuth', error });

    if (isAccountDisabledError(error)) throw await refuse('TEAMS_ACCOUNT_DISABLED');
    throw await refuse('TEAMS_INVALID_OR_EXPIRED_TOKEN');
  }
}

/**
 * Teams client configuration handler
 * Exposes the (non-secret) Azure AD client/tenant IDs so the Teams auth-start
 * popup can build the login URL without relying on build-time env vars.
 */
export async function teamsClientConfig(req, res) {
  const platform = configCache.getPlatform() || {};
  const teamsConfig = platform.teamsAuth || {};

  if (!teamsConfig.enabled) {
    return res.json({ enabled: false });
  }

  res.json({
    enabled: true,
    clientId: teamsConfig.clientId || null,
    tenantId: teamsConfig.tenantId || null
  });
}
