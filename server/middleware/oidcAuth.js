import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import fetch from 'node-fetch';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { generateJwt } from '../utils/tokenService.js';
import authDebugService from '../utils/authDebugService.js';

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
            authDebugService.log('oidc', 'debug', 'token_exchange_success', {
              provider: provider.name,
              hasAccessToken: !!accessToken,
              hasRefreshToken: !!_refreshToken,
              accessTokenLength: accessToken?.length || 0,
              tokenType: 'Bearer'
            });

            // Get user info from OIDC provider
            const userInfo = await fetchUserInfo(provider.userInfoURL, accessToken, provider.name);

            // Normalize user data from OIDC provider
            const oidcUser = normalizeOidcUser(userInfo, provider);

            authDebugService.log('oidc', 'info', 'user_normalization_complete', {
              provider: provider.name,
              userId: oidcUser.id,
              userEmail: oidcUser.email,
              userName: oidcUser.name,
              externalGroups: oidcUser.externalGroups,
              internalGroups: oidcUser.groups
            });

            // Validate and persist user based on platform configuration
            const platform = configCache.getPlatform() || {};
            const validatedUser = await validateAndPersistExternalUser(oidcUser, platform);

            authDebugService.log('oidc', 'info', 'user_validation_success', {
              provider: provider.name,
              userId: validatedUser.id,
              finalGroups: validatedUser.groups,
              authMethod: validatedUser.authMethod,
              persistent: validatedUser.persistedUser || false
            });

            return done(null, validatedUser);
          } catch (error) {
            authDebugService.log('oidc', 'error', 'user_validation_error', {
              provider: provider.name,
              error: error.message,
              errorCode: error.code,
              errorStack: error.stack
            });

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
async function fetchUserInfo(userInfoURL, accessToken, providerName) {
  authDebugService.log('oidc', 'debug', 'userinfo_request_start', {
    provider: providerName,
    userInfoURL,
    hasAccessToken: !!accessToken
  });

  try {
    const response = await fetch(userInfoURL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    authDebugService.log('oidc', 'debug', 'userinfo_response_received', {
      provider: providerName,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries())
    });

    if (!response.ok) {
      const errorText = await response.text();
      authDebugService.log('oidc', 'error', 'userinfo_request_failed', {
        provider: providerName,
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText
      });

      throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
    }

    const userInfo = await response.json();

    authDebugService.log('oidc', 'info', 'userinfo_parsed_success', {
      provider: providerName,
      userInfoKeys: Object.keys(userInfo),
      hasEmail: !!userInfo.email,
      hasName: !!userInfo.name,
      hasSub: !!userInfo.sub,
      hasGroups: !!(userInfo.groups || userInfo.roles || userInfo.memberOf)
    });

    return userInfo;
  } catch (error) {
    authDebugService.log('oidc', 'error', 'userinfo_request_error', {
      provider: providerName,
      error: error.message,
      errorType: error.constructor.name
    });

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
      authDebugService.log(
        'oidc',
        'error',
        'provider_not_found',
        {
          requestedProvider: providerName,
          configuredProviders: Array.from(configuredProviders.keys())
        },
        {
          sessionId: req.sessionID,
          userAgent: req.headers['user-agent'],
          ip: req.ip
        }
      );

      return res.status(404).json({ error: `OIDC provider '${providerName}' not found` });
    }

    const context = {
      sessionId: req.sessionID,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      requestId: req.id
    };

    authDebugService.log(
      'oidc',
      'info',
      'auth_initiation',
      {
        provider: providerName,
        sessionId: req.sessionID,
        sessionExists: !!req.session,
        returnUrl: req.query.returnUrl,
        scope: provider.scope || ['openid', 'profile', 'email'],
        callbackURL: provider.callbackURL,
        authorizationURL: provider.authorizationURL
      },
      context
    );

    // Store return URL in session/state if provided
    const returnUrl = req.query.returnUrl;
    if (returnUrl) {
      // Ensure session exists
      if (!req.session) {
        authDebugService.log(
          'oidc',
          'error',
          'session_unavailable',
          {
            provider: providerName,
            returnUrl,
            sessionID: req.sessionID
          },
          context
        );
      } else {
        req.session.returnUrl = returnUrl;
        authDebugService.log(
          'oidc',
          'debug',
          'return_url_stored',
          {
            provider: providerName,
            returnUrl,
            sessionID: req.sessionID
          },
          context
        );
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
      const context = {
        sessionId: req.sessionID,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        requestId: req.id
      };

      if (err) {
        authDebugService.log(
          'oidc',
          'error',
          'auth_callback_error',
          {
            provider: providerName,
            error: err.message,
            errorCode: err.code,
            errorStack: err.stack,
            query: req.query,
            sessionData: req.session
              ? {
                  id: req.session.id || req.sessionID,
                  hasReturnUrl: !!req.session.returnUrl
                }
              : null,
            cookies: req.headers.cookie,
            isStateVerificationError: err.message?.includes('Failed to verify request state')
          },
          context
        );

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
        authDebugService.log(
          'oidc',
          'warn',
          'auth_callback_no_user',
          {
            provider: providerName,
            info: info?.message,
            query: req.query,
            sessionId: req.sessionID
          },
          context
        );

        console.warn(`OIDC authentication failed for provider ${providerName}:`, info);

        // Redirect back to the app with error message
        const errorMessage = encodeURIComponent(info?.message || 'Authentication failed');
        return res.redirect(`/?auth=error&message=${errorMessage}`);
      }

      try {
        authDebugService.log(
          'oidc',
          'info',
          'auth_callback_success',
          {
            provider: providerName,
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            userGroups: user.groups,
            authMethod: user.authMethod,
            persistedUser: user.persistedUser || false
          },
          { ...context, userId: user.id }
        );

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

        authDebugService.log(
          'oidc',
          'debug',
          'jwt_token_generated',
          {
            provider: providerName,
            userId: user.id,
            tokenLength: token?.length || 0,
            expiresIn,
            tokenType: 'JWT'
          },
          { ...context, userId: user.id }
        );

        // Get return URL
        let returnUrl = req.session?.returnUrl || '/';
        if (req.session) {
          delete req.session.returnUrl;
        }

        authDebugService.log(
          'oidc',
          'debug',
          'redirect_preparation',
          {
            provider: providerName,
            userId: user.id,
            returnUrl,
            isDevelopment: process.env.NODE_ENV === 'development',
            redirectQuery: req.query.redirect
          },
          { ...context, userId: user.id }
        );

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

          authDebugService.log(
            'oidc',
            'info',
            'auth_redirect_complete',
            {
              provider: providerName,
              userId: user.id,
              finalRedirectUrl: finalRedirectUrl.replace(token, '[TOKEN_MASKED]')
            },
            { ...context, userId: user.id }
          );

          return res.redirect(finalRedirectUrl);
        }

        // For API flows, return JSON
        authDebugService.log(
          'oidc',
          'info',
          'auth_json_response',
          {
            provider: providerName,
            userId: user.id,
            responseType: 'json'
          },
          { ...context, userId: user.id }
        );

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
        authDebugService.log(
          'oidc',
          'error',
          'jwt_token_generation_error',
          {
            provider: providerName,
            userId: user?.id,
            error: tokenError.message,
            errorStack: tokenError.stack
          },
          { ...context, userId: user?.id }
        );

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
