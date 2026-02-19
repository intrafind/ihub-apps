import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Global OAuth callback handler
 * Cleans up OAuth success/error query parameters from URLs on any page
 * This is needed because OAuth callbacks redirect back to the original page
 * and we want to clean up the URL without the user seeing the query parameters
 */
export const useOAuthCallbackCleanup = () => {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let shouldCleanup = false;

    // List of OAuth-related query parameters to remove
    const oauthParams = [
      'office365_connected',
      'office365_error',
      'jira_connected',
      'jira_error',
      'googledrive_connected',
      'googledrive_error',
      'sharepoint_connected',
      'sharepoint_error'
    ];

    // Check if any OAuth parameters are present
    for (const param of oauthParams) {
      if (params.has(param)) {
        shouldCleanup = true;
        params.delete(param);
      }
    }

    // Clean up the URL if OAuth parameters were found
    if (shouldCleanup) {
      const newSearch = params.toString();
      const newUrl = newSearch ? `${location.pathname}?${newSearch}` : location.pathname;

      // Use replace: true to avoid adding to browser history
      navigate(newUrl, { replace: true });
    }
  }, [location, navigate]);
};
