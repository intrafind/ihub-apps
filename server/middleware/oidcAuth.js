import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';

// Store configured providers
const configuredProviders = new Map();

/**
 * Configure Passport with OIDC providers from platform configuration
 */
export function configureOidcProviders() {
  const platform = configCache.getPlatform() || {};
  const oidcConfig = platform.oidcAuth || {};
  
  if (!oidcConfig.enabled || !oidcConfig.providers?.length) {
    return;
  }

  // Clear existing providers
  configuredProviders.clear();

  // Configure each OIDC provider
  for (const provider of oidcConfig.providers) {
    if (!provider.name || !provider.clientId || !provider.clientSecret || 
        !provider.authorizationURL || !provider.tokenURL || !provider.userInfoURL) {
      console.warn(`OIDC provider ${provider.name || 'unnamed'} missing required configuration`);
      continue;
    }

    try {
      // Create OAuth2 strategy for this provider
      const strategy = new OAuth2Strategy({
        authorizationURL: provider.authorizationURL,
        tokenURL: provider.tokenURL,
        clientID: provider.clientId,
        clientSecret: provider.clientSecret,
        callbackURL: provider.callbackURL || `/api/auth/oidc/${provider.name}/callback`,
        scope: provider.scope || ['openid', 'profile', 'email'],
        state: true,
        pkce: provider.pkce ?? true
      }, async (accessToken, _refreshToken, _profile, done) => {
        try {
          // Get user info from OIDC provider
          const userInfo = await fetchUserInfo(provider.userInfoURL, accessToken);
          
          // Normalize user data
          const user = normalizeOidcUser(userInfo, provider);
          
          return done(null, user);
        } catch (error) {
          console.error(`OIDC user info fetch error for provider ${provider.name}:`, error);
          return done(error, null);
        }
      });

      // Register the strategy with a unique name
      const strategyName = `oidc-${provider.name}`;
      passport.use(strategyName, strategy);
      
      configuredProviders.set(provider.name, {
        ...provider,
        strategyName
      });

      console.log(`OIDC provider configured: ${provider.name}`);
    } catch (error) {
      console.error(`Failed to configure OIDC provider ${provider.name}:`, error);
    }
  }
}

/**
 * Fetch user information from OIDC provider
 */
async function fetchUserInfo(userInfoURL, accessToken) {
  const response = await fetch(userInfoURL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Normalize user data from different OIDC providers
 */
function normalizeOidcUser(userInfo, provider) {
  // Handle different provider formats
  const userId = userInfo.sub || userInfo.id || userInfo.preferred_username || userInfo.email;
  const email = userInfo.email || userInfo.mail || userInfo.emailAddress;
  const name = userInfo.name || userInfo.displayName || 
               `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim() ||
               userInfo.preferred_username || email;

  // Extract groups from user info
  let groups = [];
  if (provider.groupsAttribute) {
    const groupsData = userInfo[provider.groupsAttribute];
    if (Array.isArray(groupsData)) {
      groups = groupsData;
    } else if (typeof groupsData === 'string') {
      groups = groupsData.split(',').map(g => g.trim()).filter(Boolean);
    }
  }

  // Apply group mapping
  const groupMap = configCache.getGroupMap();
  const mappedGroups = new Set();
  
  for (const group of groups) {
    const mapped = groupMap[group] || group;
    if (Array.isArray(mapped)) {
      mapped.forEach(g => mappedGroups.add(g));
    } else {
      mappedGroups.add(mapped);
    }
  }

  // Create user object
  let user = {
    id: userId,
    name: name,
    email: email,
    groups: Array.from(mappedGroups),
    provider: provider.name,
    authMethod: 'oidc',
    authenticated: true,
    raw: userInfo // Keep raw data for debugging
  };

  // Enhance user with authenticated group and provider-specific groups
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};
  
  user = enhanceUserGroups(user, authConfig, provider);

  return user;
}

/**
 * Generate JWT token for authenticated user
 */
function generateJwtToken(user) {
  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.localAuth?.jwtSecret;
  
  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured for OIDC authentication');
  }

  const tokenPayload = {
    sub: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    provider: user.provider,
    authMethod: 'oidc',
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
 * Initialize Passport for OIDC authentication
 */
export function initializePassport(app) {
  app.use(passport.initialize());
  
  // Serialize user for session (not used in stateless mode, but required by Passport)
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });
}

/**
 * Get list of configured OIDC providers
 */
export function getConfiguredProviders() {
  return Array.from(configuredProviders.values()).map(provider => ({
    name: provider.name,
    displayName: provider.displayName || provider.name,
    authURL: `/api/auth/oidc/${provider.name}`,
    callbackURL: provider.callbackURL || `/api/auth/oidc/${provider.name}/callback`
  }));
}

/**
 * OIDC authentication route handler
 */
export function createOidcAuthHandler(providerName) {
  return (req, res, next) => {
    const provider = configuredProviders.get(providerName);
    if (!provider) {
      return res.status(404).json({ error: `OIDC provider '${providerName}' not found` });
    }

    // Store return URL in session/state if provided
    const returnUrl = req.query.returnUrl;
    if (returnUrl) {
      // In a stateless setup, we could encode this in the state parameter
      req.session = req.session || {};
      req.session.returnUrl = returnUrl;
    }

    passport.authenticate(provider.strategyName, {
      scope: provider.scope || ['openid', 'profile', 'email']
    })(req, res, next);
  };
}

/**
 * OIDC callback route handler
 */
export function createOidcCallbackHandler(providerName) {
  return (req, res, next) => {
    const provider = configuredProviders.get(providerName);
    if (!provider) {
      return res.status(404).json({ error: `OIDC provider '${providerName}' not found` });
    }

    passport.authenticate(provider.strategyName, { session: false }, (err, user, info) => {
      if (err) {
        console.error(`OIDC authentication error for provider ${providerName}:`, err);
        return res.status(500).json({ 
          error: 'Authentication failed', 
          details: err.message 
        });
      }

      if (!user) {
        console.warn(`OIDC authentication failed for provider ${providerName}:`, info);
        return res.status(401).json({ 
          error: 'Authentication failed', 
          details: info?.message || 'Unknown error' 
        });
      }

      try {
        // Generate JWT token
        const { token, expiresIn } = generateJwtToken(user);
        
        // Get return URL
        const returnUrl = req.session?.returnUrl || '/';
        if (req.session) {
          delete req.session.returnUrl;
        }

        // For web flows, redirect with token in query (or set as cookie)
        if (req.query.redirect !== 'false') {
          const separator = returnUrl.includes('?') ? '&' : '?';
          return res.redirect(`${returnUrl}${separator}token=${token}&provider=${providerName}`);
        }

        // For API flows, return JSON
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

      } catch (tokenError) {
        console.error(`JWT token generation error for provider ${providerName}:`, tokenError);
        return res.status(500).json({ 
          error: 'Token generation failed', 
          details: tokenError.message 
        });
      }
    })(req, res, next);
  };
}

/**
 * Reconfigure providers when platform config changes
 */
export function reconfigureOidcProviders() {
  console.log('Reconfiguring OIDC providers...');
  configureOidcProviders();
}

// Export for testing
export { configuredProviders, normalizeOidcUser, generateJwtToken };