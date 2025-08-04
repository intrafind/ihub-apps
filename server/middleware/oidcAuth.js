import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import fetch from 'node-fetch';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { generateJwt } from '../utils/tokenService.js';

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
            const platform = configCache.getPlatform() || {};
            const validatedUser = await validateAndPersistExternalUser(oidcUser, platform);

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
  try {
    const response = await fetch(userInfoURL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
    }

    const userInfo = await response.json();

    return userInfo;
  } catch (error) {
    throw error;
  }
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

  // Create user object with external groups
  let user = {
    id: userId,
    name: name,
    email: email,
    groups: [], // Will be populated by merging external and internal groups
    externalGroups: groups, // Store raw external groups for mapping and merging
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
      // Ensure session exists
      if (!req.session) {
      } else {
        req.session.returnUrl = returnUrl;
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
        // Generate JWT token using centralized token service
        const { token, expiresIn } = generateJwt(user, {
          authMode: 'oidc',
          authProvider: user.provider,
          additionalClaims: {
            authMethods: user.authMethods || ['oidc'],
            active: user.active !== false,
            persistedUser: user.persistedUser || false
          }
        });

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
          const finalRedirectUrl = `${returnUrl}${separator}token=${token}&provider=${providerName}`;

          return res.redirect(finalRedirectUrl);
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
export { configuredProviders, normalizeOidcUser };
