import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { promisify } from 'util';
import fetch from 'node-fetch';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import config from '../config.js';

// JWKS client for Microsoft public keys
const createJwksClient = (tenantId) => {
  return jwksClient({
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 60 * 1000 // 10 hours
  });
};

// Cache for JWKS clients per tenant
const jwksClients = new Map();

/**
 * Get or create JWKS client for a tenant
 */
function getJwksClient(tenantId) {
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
      throw new Error('Invalid token format');
    }

    const { header, payload } = decoded;
    
    // Get the tenant ID from the token
    const tenantId = payload.tid || teamsConfig.tenantId;
    if (!tenantId) {
      throw new Error('No tenant ID found in token or configuration');
    }

    // Get JWKS client for this tenant
    const client = getJwksClient(tenantId);
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
    console.error('Teams token verification failed:', error);
    throw error;
  }
}

/**
 * Get user profile from Microsoft Graph
 */
async function getUserProfile(accessToken) {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Graph API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch user profile from Graph:', error);
    return null;
  }
}

/**
 * Get user groups from Microsoft Graph
 */
async function getUserGroups(accessToken) {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/memberOf', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Graph API error: ${response.status}`);
    }

    const data = await response.json();
    return data.value
      .filter(group => group['@odata.type'] === '#microsoft.graph.group')
      .map(group => group.displayName);
  } catch (error) {
    console.error('Failed to fetch user groups from Graph:', error);
    return [];
  }
}

/**
 * Normalize Teams user data
 */
function normalizeTeamsUser(tokenData, profile, groups, teamsConfig) {
  // Extract user information
  const userId = tokenData.oid || tokenData.sub || profile?.id;
  const email = tokenData.email || tokenData.preferred_username || profile?.mail || profile?.userPrincipalName;
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
 * Generate JWT token for authenticated Teams user
 */
function generateJwtToken(user) {
  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.localAuth?.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured for Teams authentication');
  }

  const tokenPayload = {
    sub: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    provider: user.provider,
    authMode: 'teams',
    authProvider: 'teams',
    teamsData: user.teamsData,
    iat: Math.floor(Date.now() / 1000)
  };

  const sessionTimeout = platform.localAuth?.sessionTimeoutMinutes || 480; // 8 hours default
  const expiresIn = sessionTimeout * 60; // Convert to seconds

  const token = jwt.sign(tokenPayload, jwtSecret, {
    expiresIn: `${expiresIn}s`,
    issuer: 'ai-hub-apps',
    audience: 'ai-hub-apps'
  });

  return { token, expiresIn };
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
    if (!decoded || decoded.iss?.includes('microsoftonline.com') === false) {
      // Not a Teams token, continue with normal auth flow
      return next();
    }
  } catch (error) {
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
    const user = normalizeTeamsUser(tokenData, profile, groups, teamsConfig);

    // Generate our JWT token
    const { token } = generateJwtToken(user);

    // Attach user and token to request
    req.user = user;
    req.teamsToken = token;
    req.isTeamsAuth = true;

    next();
  } catch (error) {
    console.error('Teams authentication failed:', error);
    
    // Don't fail the request, just continue without Teams auth
    // This allows fallback to other auth methods
    next();
  }
}

/**
 * Teams token exchange endpoint handler
 */
export async function teamsTokenExchange(req, res) {
  try {
    const { ssoToken } = req.body;
    
    if (!ssoToken) {
      return res.status(400).json({
        success: false,
        error: 'SSO token is required'
      });
    }

    const platform = configCache.getPlatform() || {};
    const teamsConfig = platform.teamsAuth || {};

    if (!teamsConfig.enabled) {
      return res.status(400).json({
        success: false,
        error: 'Teams authentication is not enabled'
      });
    }

    // Verify the Teams SSO token
    const tokenData = await verifyTeamsToken(ssoToken, teamsConfig);

    // Get user groups from token if present
    const groups = tokenData.groups || [];

    // Normalize user data
    const user = normalizeTeamsUser(tokenData, null, groups, teamsConfig);

    // Generate our JWT token
    const { token, expiresIn } = generateJwtToken(user);

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
      token,
      expiresIn
    });
  } catch (error) {
    console.error('Teams token exchange error:', error);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired Teams token'
    });
  }
}

/**
 * Teams tab configuration save handler
 */
export function teamsTabConfigSave(req, res) {
  // This endpoint is called when a Teams tab is configured
  // For now, we just return success as we don't need to save any configuration
  res.json({
    success: true,
    message: 'Tab configuration saved'
  });
}