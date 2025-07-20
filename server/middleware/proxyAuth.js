import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import jwkToPem from 'jwk-to-pem';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';

const jwksCache = new Map();

async function getJwks(jwkUrl) {
  if (jwksCache.has(jwkUrl)) return jwksCache.get(jwkUrl);
  try {
    const res = await fetch(jwkUrl);
    if (!res.ok) throw new Error(`Failed to load JWKs: ${res.status}`);
    const jwks = await res.json();
    jwksCache.set(jwkUrl, jwks);
    return jwks;
  } catch (err) {
    console.error('Error fetching JWKs', err);
    return null;
  }
}

async function verifyJwt(token, provider) {
  try {
    const jwks = await getJwks(provider.jwkUrl);
    if (!jwks || !jwks.keys?.length) throw new Error('No keys');
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const jwk = kid ? jwks.keys.find(k => k.kid === kid) : jwks.keys[0];
    if (!jwk) throw new Error('Key not found');
    const pem = jwkToPem(jwk);
    return jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: provider.issuer,
      audience: provider.audience
    });
  } catch (err) {
    console.error('JWT verification failed', err.message);
    return null;
  }
}

export async function proxyAuth(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const proxyCfg = {
    enabled:
      (config.PROXY_AUTH_ENABLED ?? '').toLowerCase() === 'true' || platform?.proxyAuth?.enabled,
    userHeader:
      config.PROXY_AUTH_USER_HEADER || platform?.proxyAuth?.userHeader || 'x-forwarded-user',
    groupsHeader: config.PROXY_AUTH_GROUPS_HEADER || platform?.proxyAuth?.groupsHeader,
    jwtProviders: platform?.proxyAuth?.jwtProviders || []
  };

  if (!proxyCfg.enabled) {
    // Even if proxy auth is disabled, check for invalid JWT tokens from other auth modes
    const currentAuthMode = platform.auth?.mode || 'anonymous';
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ') && currentAuthMode === 'anonymous') {
      // If we're in anonymous mode but someone sends a JWT token, it should be rejected
      console.warn(`🔐 Token rejected: JWT token not valid in ${currentAuthMode} mode`);
      // Don't set req.user, let it continue as anonymous
    }
    
    return next();
  }

  let userId = req.headers[proxyCfg.userHeader.toLowerCase()];
  let groups = [];
  if (proxyCfg.groupsHeader) {
    const raw = req.headers[proxyCfg.groupsHeader.toLowerCase()];
    if (raw)
      groups = raw
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);
  }

  let tokenPayload = null;
  for (const provider of proxyCfg.jwtProviders) {
    const hdr = (provider.header || 'authorization').toLowerCase();
    const value = req.headers[hdr];
    if (!value) continue;
    let token = value;
    if (hdr === 'authorization' && token.startsWith('Bearer ')) {
      token = token.slice(7);
    }
    tokenPayload = await verifyJwt(token, provider);
    if (tokenPayload) {
      // Check if token was issued for the current authentication mode
      const currentAuthMode = platform.auth?.mode || 'anonymous';
      if (tokenPayload.authMode && tokenPayload.authMode !== currentAuthMode) {
        console.warn(`🔐 Token rejected: issued for ${tokenPayload.authMode} mode, current mode is ${currentAuthMode}`);
        tokenPayload = null; // Invalidate token from different auth mode
        continue;
      }
      
      // For OIDC tokens, also check if the provider is still enabled and available
      if (tokenPayload.authMode === 'oidc' && tokenPayload.authProvider) {
        const oidcConfig = platform.oidcAuth || {};
        const enabledProviders = oidcConfig.enabled ? (oidcConfig.providers || []).map(p => p.name) : [];
        
        if (!enabledProviders.includes(tokenPayload.authProvider)) {
          console.warn(`🔐 Token rejected: OIDC provider '${tokenPayload.authProvider}' is no longer enabled`);
          tokenPayload = null; // Invalidate token from disabled provider
          continue;
        }
      }
      
      break;
    }
  }

  if (tokenPayload) {
    if (!userId) {
      userId =
        tokenPayload.preferred_username ||
        tokenPayload.upn ||
        tokenPayload.email ||
        tokenPayload.sub;
    }
    if (Array.isArray(tokenPayload.groups)) {
      groups = groups.concat(tokenPayload.groups);
    }
  }

  if (!userId) {
    req.user = null;
    return next();
  }

  const groupMap = configCache.getGroupMap();
  const mapped = new Set();
  for (const g of groups) {
    const m = groupMap[g] || g;
    if (Array.isArray(m)) m.forEach(x => mapped.add(x));
    else mapped.add(m);
  }

  let user = {
    id: userId,
    name: req.headers['x-forwarded-name'],
    email: req.headers['x-forwarded-email'],
    groups: Array.from(mapped),
    authenticated: true,
    authMethod: 'proxy'
  };

  // Enhance user with authenticated group
  const authConfig = platform.auth || {};
  user = enhanceUserGroups(user, authConfig);

  req.user = user;
  next();
}
