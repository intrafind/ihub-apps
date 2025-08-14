import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Generic hook to detect integration authentication errors in chat responses
 * and manage connection state for OAuth-based integrations
 */
export const useIntegrationAuth = () => {
  const { t } = useTranslation();
  const [authRequests, setAuthRequests] = useState(new Map()); // integration -> {required, connecting, error, lastFailedRequest, tokenInfo}

  /**
   * Integration configuration for OAuth flows
   */
  const integrationConfigs = {
    jira: {
      name: 'JIRA',
      icon: 'ticket',
      authUrl: '/api/integrations/jira/auth',
      statusUrl: '/api/integrations/jira/status',
      disconnectUrl: '/api/integrations/jira/disconnect',
      refreshUrl: '/api/integrations/jira/refresh',
      authErrorPatterns: ['JIRA_AUTH_REQUIRED', 'JIRA authentication', 'connect your JIRA account'],
      toolPrefix: 'jira_',
      description: {
        en: 'Link your JIRA account to search, view, and manage tickets directly from the chat.',
        de: 'Verknüpfen Sie Ihr JIRA-Konto, um Tickets direkt im Chat zu suchen, anzuzeigen und zu verwalten.'
      },
      features: {
        en: [
          'Search tickets using natural language or JQL',
          'View detailed ticket information and comments',
          'Add comments and update ticket status',
          'Access only tickets you have permission to see'
        ],
        de: [
          'Tickets mit natürlicher Sprache oder JQL durchsuchen',
          'Detaillierte Ticket-Informationen und Kommentare anzeigen',
          'Kommentare hinzufügen und Ticket-Status aktualisieren',
          'Nur auf Tickets zugreifen, für die Sie Berechtigungen haben'
        ]
      }
    }
    // Future integrations can be added here:
    // microsoftGraph: { ... },
    // googleWorkspace: { ... },
    // slack: { ... }
  };

  /**
   * Check if a message contains integration authentication error
   */
  const checkForAuthError = useCallback((message, integration) => {
    const config = integrationConfigs[integration];
    if (!config || !message || typeof message !== 'object') return false;

    // Check if message has tool calls that failed with auth error
    if (message.toolCalls) {
      const hasAuthError = message.toolCalls.some(toolCall => {
        if (toolCall.name && toolCall.name.startsWith(config.toolPrefix)) {
          try {
            const result =
              typeof toolCall.result === 'string' ? JSON.parse(toolCall.result) : toolCall.result;

            return (
              result &&
              config.authErrorPatterns.some(
                pattern =>
                  result.error === pattern || (result.message && result.message.includes(pattern))
              )
            );
          } catch (e) {
            // Check string content for auth error
            return (
              toolCall.result &&
              config.authErrorPatterns.some(pattern => toolCall.result.includes(pattern))
            );
          }
        }
        return false;
      });

      if (hasAuthError) {
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                required: true,
                connecting: false,
                error: null,
                lastFailedRequest: {
                  timestamp: Date.now(),
                  toolCalls: message.toolCalls.filter(
                    tc => tc.name && tc.name.startsWith(config.toolPrefix)
                  )
                }
              })
            )
        );
        return true;
      }
    }

    // Also check message content for auth error patterns
    if (message.content && typeof message.content === 'string') {
      const hasAuthError = config.authErrorPatterns.some(pattern =>
        message.content.toLowerCase().includes(pattern.toLowerCase())
      );

      if (hasAuthError) {
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                required: true,
                connecting: false,
                error: null,
                lastFailedRequest: { timestamp: Date.now() }
              })
            )
        );
        return true;
      }
    }

    return false;
  }, []);

  /**
   * Monitor chat messages for integration auth errors
   */
  const monitorChatMessages = useCallback(
    (messages, integrations = []) => {
      if (!messages || !Array.isArray(messages)) return;

      // Check the latest assistant message for auth errors
      const latestAssistantMessage = messages.filter(msg => msg.role === 'assistant').pop();

      if (latestAssistantMessage) {
        integrations.forEach(integration => {
          checkForAuthError(latestAssistantMessage, integration);
        });
      }
    },
    [checkForAuthError]
  );

  /**
   * Initiate OAuth connection for an integration
   */
  const connectIntegration = useCallback(
    async integration => {
      const config = integrationConfigs[integration];
      if (!config) {
        console.error(`Unknown integration: ${integration}`);
        return;
      }

      try {
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                ...(prev.get(integration) || {}),
                connecting: true,
                error: null
              })
            )
        );

        // Store current context for post-auth redirect
        const currentPath = window.location.pathname;
        const currentSearch = window.location.search;

        sessionStorage.setItem(
          `${integration}_post_auth_redirect`,
          `${currentPath}${currentSearch}`
        );

        const authRequest = authRequests.get(integration);
        if (authRequest?.lastFailedRequest) {
          sessionStorage.setItem(
            `${integration}_retry_request`,
            JSON.stringify(authRequest.lastFailedRequest)
          );
        }

        // Redirect to OAuth
        window.location.href = config.authUrl;
      } catch (error) {
        console.error(`Error initiating ${integration} connection:`, error);
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                ...(prev.get(integration) || {}),
                connecting: false,
                error: t(
                  `integrations.${integration}.connectionError`,
                  'Failed to initiate connection. Please try again.'
                )
              })
            )
        );
      }
    },
    [authRequests, t]
  );

  /**
   * Check connection status for an integration
   */
  const checkConnectionStatus = useCallback(async integration => {
    const config = integrationConfigs[integration];
    if (!config) return false;

    try {
      const response = await fetch(config.statusUrl);
      const data = await response.json();

      if (data.connected) {
        // Store token info if available
        const tokenInfo = data.tokenInfo || null;

        // If tokens are expiring, show warning but don't require reconnection
        if (tokenInfo && tokenInfo.isExpiring && !tokenInfo.isExpired) {
          setAuthRequests(
            prev =>
              new Map(
                prev.set(integration, {
                  required: false,
                  connecting: false,
                  error: null,
                  lastFailedRequest: null,
                  tokenInfo,
                  warning: `Tokens expire in ${tokenInfo.minutesUntilExpiry} minutes`
                })
              )
          );
        } else {
          setAuthRequests(prev => {
            const newMap = new Map(prev);
            newMap.delete(integration);
            return newMap;
          });
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error checking ${integration} connection status:`, error);
      return false;
    }
  }, []);

  /**
   * Refresh tokens for an integration
   */
  const refreshIntegration = useCallback(
    async integration => {
      const config = integrationConfigs[integration];
      if (!config || !config.refreshUrl) return false;

      try {
        const response = await fetch(config.refreshUrl, {
          method: 'POST'
        });

        if (response.ok) {
          // Check status after refresh to update token info
          await checkConnectionStatus(integration);
          return true;
        } else {
          const data = await response.json();
          throw new Error(data.message || 'Refresh failed');
        }
      } catch (error) {
        console.error(`Error refreshing ${integration}:`, error);

        // If refresh fails with auth error, require reconnection
        if (error.message.includes('authentication required')) {
          setAuthRequests(
            prev =>
              new Map(
                prev.set(integration, {
                  required: true,
                  connecting: false,
                  error: 'Authentication expired. Please reconnect.',
                  lastFailedRequest: null,
                  tokenInfo: null
                })
              )
          );
        } else {
          setAuthRequests(
            prev =>
              new Map(
                prev.set(integration, {
                  ...(prev.get(integration) || {}),
                  error: t(
                    `integrations.${integration}.refreshError`,
                    'Failed to refresh tokens. Please try again.'
                  )
                })
              )
          );
        }
        return false;
      }
    },
    [t, checkConnectionStatus]
  );

  /**
   * Disconnect an integration
   */
  const disconnectIntegration = useCallback(
    async integration => {
      const config = integrationConfigs[integration];
      if (!config) return false;

      try {
        const response = await fetch(config.disconnectUrl, {
          method: 'POST'
        });

        if (response.ok) {
          setAuthRequests(prev => {
            const newMap = new Map(prev);
            newMap.delete(integration);
            return newMap;
          });
          return true;
        } else {
          throw new Error('Disconnect failed');
        }
      } catch (error) {
        console.error(`Error disconnecting ${integration}:`, error);
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                ...(prev.get(integration) || {}),
                error: t(
                  `integrations.${integration}.disconnectError`,
                  'Failed to disconnect. Please try again.'
                )
              })
            )
        );
        return false;
      }
    },
    [t]
  );

  /**
   * Handle post-OAuth callback for any integration
   */
  const handlePostAuthCallback = useCallback(() => {
    const urlParams = new URLSearchParams(window.location.search);

    // Check for integration-specific success/error parameters
    Object.keys(integrationConfigs).forEach(integration => {
      const success = urlParams.get(`${integration}_auth`) === 'success';
      const error = urlParams.get(`${integration}_error`);

      if (success) {
        setAuthRequests(prev => {
          const newMap = new Map(prev);
          newMap.delete(integration);
          return newMap;
        });

        // Check if we need to retry a failed request
        const retryRequest = sessionStorage.getItem(`${integration}_retry_request`);
        if (retryRequest) {
          try {
            const parsedRequest = JSON.parse(retryRequest);
            console.log(`${integration} connection successful, could retry:`, parsedRequest);
            sessionStorage.removeItem(`${integration}_retry_request`);
          } catch (e) {
            console.error(`Error parsing ${integration} retry request:`, e);
          }
        }

        // Clean up URL parameters
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
      } else if (error) {
        setAuthRequests(
          prev =>
            new Map(
              prev.set(integration, {
                ...(prev.get(integration) || {}),
                connecting: false,
                error: t(`integrations.${integration}.authError`, `Authentication failed: ${error}`)
              })
            )
        );
      }
    });
  }, [t]);

  /**
   * Reset authentication state for an integration
   */
  const resetAuthState = useCallback(integration => {
    setAuthRequests(prev => {
      const newMap = new Map(prev);
      newMap.delete(integration);
      return newMap;
    });
  }, []);

  /**
   * Get authentication state for an integration
   */
  const getAuthState = useCallback(
    integration => {
      return (
        authRequests.get(integration) || {
          required: false,
          connecting: false,
          error: null,
          lastFailedRequest: null
        }
      );
    },
    [authRequests]
  );

  /**
   * Get all integrations requiring authentication
   */
  const getRequiredIntegrations = useCallback(() => {
    const required = [];
    authRequests.forEach((state, integration) => {
      if (state.required) {
        required.push({
          id: integration,
          config: integrationConfigs[integration],
          state
        });
      }
    });
    return required;
  }, [authRequests]);

  // Check for post-auth callback on mount
  useEffect(() => {
    handlePostAuthCallback();
  }, [handlePostAuthCallback]);

  return {
    authRequests,
    integrationConfigs,
    monitorChatMessages,
    connectIntegration,
    checkConnectionStatus,
    refreshIntegration,
    disconnectIntegration,
    resetAuthState,
    getAuthState,
    getRequiredIntegrations
  };
};
