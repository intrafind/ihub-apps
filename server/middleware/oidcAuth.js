import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import {
  loadUsers,
  findUserByIdentifier,
  createOrUpdateOidcUser,
  isUserActive,
  mergeUserGroups,
  updateUserActivity
} from '../utils/userManager.js';

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
    if (
      !provider.name ||
      !provider.clientId ||
      !provider.clientSecret ||
      !provider.authorizationURL ||
      !provider.tokenURL ||
      !provider.userInfoURL
    ) {
      console.warn(`OIDC provider ${provider.name || 'unnamed'} missing required configuration`);
      continue;
    }

    try {
      // Create OAuth2 strategy for this provider
      const strategy = new OAuth2Strategy(
        {
          authorizationURL: provider.authorizationURL,
          tokenURL: provider.tokenURL,
          clientID: provider.clientId,
          clientSecret: provider.clientSecret,
          callbackURL: provider.callbackURL || `/api/auth/oidc/${provider.name}/callback`,
          scope: provider.scope || ['openid', 'profile', 'email'],
          state: true,
          pkce: provider.pkce ?? true,
          // Add custom state verification to handle development issues
          customHeaders: {},
          skipUserProfile: true // We'll fetch user info manually
        },
        async (accessToken, _refreshToken, _profile, done) => {
          try {
            // Get user info from OIDC provider
            const userInfo = await fetchUserInfo(provider.userInfoURL, accessToken);

            // Normalize user data from OIDC provider
            const oidcUser = normalizeOidcUser(userInfo, provider);

            // Validate and persist user based on platform configuration
            const validatedUser = await validateAndPersistOidcUser(oidcUser, provider);

            return done(null, validatedUser);
          } catch (error) {
            console.error(`OIDC user validation error for provider ${provider.name}:`, error);
            return done(error, null);
          }
        }
      );

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
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
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
  const name =
    userInfo.name ||
    userInfo.displayName ||
    `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim() ||
    userInfo.preferred_username ||
    email;

  // Extract groups from user info
  let groups = [];
  if (provider.groupsAttribute) {
    const groupsData = userInfo[provider.groupsAttribute];
    if (Array.isArray(groupsData)) {
      groups = groupsData;
    } else if (typeof groupsData === 'string') {
      groups = groupsData
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);
    }
  }

  // Apply group mapping using the new groups.json format
  const mappedGroups = mapExternalGroups(groups);

  // Create user object
  let user = {
    id: userId,
    name: name,
    email: email,
    groups: mappedGroups,
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
 * Validate and persist OIDC user based on platform configuration
 */
async function validateAndPersistOidcUser(oidcUser, provider) {
  const platform = configCache.getPlatform() || {};
  const oidcConfig = platform.oidcAuth || {};
  const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';

  // Check if user exists in users.json
  const usersConfig = loadUsers(usersFilePath);
  const existingUser =
    findUserByIdentifier(usersConfig, oidcUser.email, 'oidc') ||
    findUserByIdentifier(usersConfig, oidcUser.id, 'oidc');

  // If user exists, check if they are active
  if (existingUser) {
    if (!isUserActive(existingUser)) {
      throw new Error(
        `User account is disabled. User ID: ${existingUser.id}, Email: ${existingUser.email}. Please contact your administrator.`
      );
    }

    // Update existing user and merge groups
    const persistedUser = await createOrUpdateOidcUser(oidcUser, usersFilePath);

    // Update activity tracking
    await updateUserActivity(persistedUser.id, usersFilePath);

    // Merge groups: external groups (from OIDC) + additional groups (from users.json)
    const mergedGroups = mergeUserGroups(
      oidcUser.groups || [],
      persistedUser.additionalGroups || []
    );

    return {
      ...oidcUser,
      id: persistedUser.id,
      groups: mergedGroups,
      active: persistedUser.active,
      authMethods: persistedUser.authMethods || ['oidc'],
      lastActiveDate: persistedUser.lastActiveDate,
      persistedUser: true
    };
  }

  // User doesn't exist - check self-signup settings
  if (!oidcConfig.allowSelfSignup) {
    throw new Error(
      `New user registration is not allowed. User ID: ${oidcUser.id}, Email: ${oidcUser.email}. Please contact your administrator.`
    );
  }

  // Create new user (self-signup allowed)
  const persistedUser = await createOrUpdateOidcUser(oidcUser, usersFilePath);

  // Combine external groups from OIDC with additional groups from users.json
  const combinedGroups = mergeUserGroups(
    oidcUser.groups || [],
    persistedUser.additionalGroups || []
  );

  return {
    ...oidcUser,
    id: persistedUser.id,
    groups: combinedGroups,
    active: true,
    authMethods: ['oidc'],
    lastActiveDate: persistedUser.lastActiveDate,
    persistedUser: true
  };
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
    authMode: 'oidc', // Include auth mode in token
    authProvider: user.provider, // Include specific provider for validation
    authMethods: user.authMethods || ['oidc'], // Include supported auth methods
    active: user.active !== false, // Include active status
    persistedUser: user.persistedUser || false, // Indicate if user is persisted
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

    // Debug session state
    console.log(`[OIDC Auth] Starting auth for provider: ${providerName}`);
    console.log(`[OIDC Auth] Session ID: ${req.sessionID}`);
    console.log(`[OIDC Auth] Session exists: ${!!req.session}`);

    // Store return URL in session/state if provided
    const returnUrl = req.query.returnUrl;
    if (returnUrl) {
      // Ensure session exists
      if (!req.session) {
        console.error('[OIDC Auth] No session available to store returnUrl');
      } else {
        req.session.returnUrl = returnUrl;
        console.log(`[OIDC Auth] Stored returnUrl in session: ${returnUrl}`);
      }
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
      // Redirect to app with error instead of returning JSON
      const errorMessage = encodeURIComponent(`OIDC provider '${providerName}' not found`);
      return res.redirect(`/?auth=error&message=${errorMessage}`);
    }

    passport.authenticate(provider.strategyName, (err, user, info) => {
      if (err) {
        console.error(`OIDC authentication error for provider ${providerName}:`, err);
        // Special handling for state verification errors
        if (err.message && err.message.includes('Failed to verify request state')) {
          console.error(
            '[OIDC Callback] OAuth state verification failed. This might be due to session issues.'
          );
          console.error('[OIDC Callback] Error details:', err);
          console.error('[OIDC Callback] Request query:', req.query);
          console.error('[OIDC Callback] Session ID:', req.sessionID);
          console.error('[OIDC Callback] Session data:', req.session);
          console.error('[OIDC Callback] Cookies:', req.headers.cookie);
        }

        // Redirect back to the app with error message instead of returning JSON
        const errorMessage = encodeURIComponent(
          err.message || 'Unable to verify authorization request state.'
        );
        return res.redirect(`/?auth=error&message=${errorMessage}`);
      }

      if (!user) {
        console.warn(`OIDC authentication failed for provider ${providerName}:`, info);

        // Redirect back to the app with error message
        const errorMessage = encodeURIComponent(info?.message || 'Authentication failed');
        return res.redirect(`/?auth=error&message=${errorMessage}`);
      }

      try {
        // Generate JWT token
        const { token, expiresIn } = generateJwtToken(user);

        // Get return URL
        let returnUrl = req.session?.returnUrl || '/';
        if (req.session) {
          delete req.session.returnUrl;
        }

        // In development, redirect to Vite dev server instead of backend
        const isDevelopment =
          process.env.NODE_ENV === 'development' || process.env.NODE_ENV !== 'production';
        if (isDevelopment && returnUrl.startsWith('/')) {
          // Convert relative URLs to Vite dev server URL
          const viteDevServer = process.env.VITE_DEV_SERVER || 'http://localhost:5173';
          returnUrl = `${viteDevServer}${returnUrl}`;
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

        // Redirect back to the app with error message
        const errorMessage = encodeURIComponent('Token generation failed: ' + tokenError.message);
        return res.redirect(`/?auth=error&message=${errorMessage}`);
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
