import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as microsoftTeams from '@microsoft/teams-js';

/**
 * Teams Authentication End Page
 * This page handles the redirect from Azure AD after authentication
 */
function TeamsAuthEnd() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(t('teams.auth.processing'));
  const [error, setError] = useState(null);

  useEffect(() => {
    // Initialize Teams SDK
    microsoftTeams.initialize();

    // Process the authentication result
    handleAuthResult();
  }, [handleAuthResult]);

  const handleAuthResult = useCallback(() => {
    // Parse the URL hash to get the access token
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const error = hashParams.get('error');
    const errorDescription = hashParams.get('error_description');

    if (error) {
      // Authentication failed
      setError(errorDescription || error);
      setStatus(t('teams.auth.failed'));

      // Notify Teams of the failure
      setTimeout(() => {
        microsoftTeams.authentication.notifyFailure(errorDescription || error);
      }, 2000);
    } else if (accessToken) {
      // Authentication successful
      setStatus(t('teams.auth.successful'));

      // Pass the token back to Teams
      // In a real implementation, you might want to exchange this for an app-specific token
      setTimeout(() => {
        microsoftTeams.authentication.notifySuccess(accessToken);
      }, 1000);
    } else {
      // No token or error in the response<<<<<<< ISSUE_209_Microsoft_Teams
      setError(t('teams.auth.noResponse'));
      setStatus(t('teams.auth.failed'));

      setTimeout(() => {
        microsoftTeams.authentication.notifyFailure(t('teams.auth.noResponse'));
      }, 2000);
    }
  }, [t]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center max-w-md p-6">
        {error ? (
          <>
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
                  d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2">{status}</h2>
            <p className="text-gray-600">{error}</p>
            <p className="text-sm text-gray-500 mt-4">{t('teams.auth.windowWillClose')}</p>
          </>
        ) : (
          <>
            <div className="text-green-600 mb-4">
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
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2">{status}</h2>
            <p className="text-gray-600">{t('teams.auth.canCloseWindow')}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default TeamsAuthEnd;
