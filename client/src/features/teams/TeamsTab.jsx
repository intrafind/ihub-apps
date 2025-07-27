import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import * as microsoftTeams from '@microsoft/teams-js';
import { apiClient } from '../../api/client';
import { useAuth } from '../auth';
import LoadingSpinner from '../../shared/components/LoadingSpinner';

/**
 * Teams Tab Component
 * Handles Microsoft Teams integration and SSO authentication
 */
function TeamsTab() {
  const { t } = useTranslation();
  const [isInitialized, setIsInitialized] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState(null);
  const [teamsContext, setTeamsContext] = useState(null);
  const { loginWithToken, isAuthenticated, user } = useAuth();

  // Initialize Teams SDK and handle authentication
  useEffect(() => {
    initializeTeams();
  }, []);

  // Initialize Microsoft Teams SDK
  const initializeTeams = async () => {
    try {
      await microsoftTeams.initialize();

      // Get Teams context
      microsoftTeams.getContext(context => {
        setTeamsContext(context);
        console.log('Teams context:', context);

        // Apply Teams theme
        applyTeamsTheme(context.theme);
        
        // Apply Teams language preference
        applyTeamsLanguage(context.locale);
        
        // Register theme change handler
        microsoftTeams.registerOnThemeChangeHandler(applyTeamsTheme);

        setIsInitialized(true);

        // Start authentication if not already authenticated
        if (!isAuthenticated) {
          authenticateWithTeams();
        }
      });
    } catch (error) {
      console.error('Failed to initialize Teams:', error);
      setError(t('teams.errors.initializationFailed'));
      setIsInitialized(true);
    }
  };

  // Apply Teams language preference
  const applyTeamsLanguage = (locale) => {
    if (!locale) return;
    
    // Map Teams locale to supported languages
    const languageMap = {
      'en-US': 'en',
      'en-GB': 'en',
      'en': 'en',
      'de-DE': 'de',
      'de-AT': 'de',
      'de-CH': 'de',
      'de': 'de'
    };
    
    // Extract language code (first part before hyphen)
    const langCode = locale.split('-')[0];
    const targetLanguage = languageMap[locale] || languageMap[langCode] || 'en';
    
    // Change i18next language if different from current
    if (i18next.language !== targetLanguage) {
      i18next.changeLanguage(targetLanguage).catch(err => {
        console.warn('Failed to change language to', targetLanguage, err);
      });
    }
  };

  // Apply Teams theme to the app
  const applyTeamsTheme = theme => {
    const root = document.documentElement;

    switch (theme) {
      case 'dark':
        root.classList.add('dark');
        root.style.setProperty('--teams-bg', '#1e1e1e');
        root.style.setProperty('--teams-text', '#ffffff');
        break;
      case 'contrast':
        root.classList.add('dark');
        root.style.setProperty('--teams-bg', '#000000');
        root.style.setProperty('--teams-text', '#ffffff');
        break;
      default: // default theme
        root.classList.remove('dark');
        root.style.setProperty('--teams-bg', '#ffffff');
        root.style.setProperty('--teams-text', '#323130');
    }
  };

  // Authenticate with Teams SSO
  const authenticateWithTeams = async () => {
    if (isAuthenticating) return;

    setIsAuthenticating(true);
    setError(null);

    try {
      // Request an SSO token from Teams
      const token = await new Promise((resolve, reject) => {
        microsoftTeams.authentication.getAuthToken({
          successCallback: token => resolve(token),
          failureCallback: error => reject(error),
          resources: [] // Add specific resources if needed
        });
      });

      // Exchange Teams SSO token for AI Hub Apps JWT token
      const response = await apiClient.post('/auth/teams/exchange', {
        ssoToken: token
      });

      if (response.data.success && response.data.token) {
        // Login with the received token
        await loginWithToken(response.data.token);

        // Notify Teams that authentication is complete
        microsoftTeams.authentication.notifySuccess();
      } else {
        throw new Error(response.data.error || t('teams.errors.authenticationFailed'));
      }
    } catch (error) {
      console.error('Teams authentication error:', error);
      setError(error.message || t('teams.errors.authenticationFailed'));
      
      // If SSO fails, we might need to trigger interactive authentication
      if (
        error.message?.includes('consent_required') ||
        error.message?.includes('interaction_required')
      ) {
        handleInteractiveAuth();
      }
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Handle interactive authentication if SSO fails
  const handleInteractiveAuth = () => {
    microsoftTeams.authentication.authenticate({
      url: `${window.location.origin}/teams/auth-start`,
      width: 600,
      height: 535,
      successCallback: result => {
        console.log('Interactive auth success:', result);
        // Try authentication again after interactive consent
        authenticateWithTeams();
      },
      failureCallback: error => {
        console.error('Interactive auth failed:', error);
        setError(t('teams.errors.interactiveAuthFailed'));
      }
    });
  };

  // Show loading state
  if (!isInitialized || isAuthenticating) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--teams-bg,#f5f5f5)]">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-[var(--teams-text,#323130)]">
            {isAuthenticating ? t('teams.status.authenticating') : t('teams.status.initializing')}
          </p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--teams-bg,#f5f5f5)]">
        <div className="text-center max-w-md p-6">
          <div className="text-red-600 mb-4">
            <svg
              className="w-16 h-16 mx-auto"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold mb-2 text-[var(--teams-text,#323130)]">
            {t('teams.errors.authenticationError')}
          </h2>
          <p className="text-[var(--teams-text,#323130)] opacity-75 mb-4">{error}</p>
          <button
            onClick={authenticateWithTeams}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  // Successfully authenticated - render the main app
  // The app will be rendered by the parent component once authenticated
  return null;
}

export default TeamsTab;
