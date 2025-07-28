import { useEffect, useState } from 'react';
import * as microsoftTeams from '@microsoft/teams-js';
import { useAuth } from '../auth';
import TeamsTab from './TeamsTab';

/**
 * Teams Wrapper Component
 * Detects if the app is running inside Teams and handles Teams-specific functionality
 */
function TeamsWrapper({ children }) {
  const [isInTeams, setIsInTeams] = useState(false);
  const [isTeamsReady, setIsTeamsReady] = useState(false);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    // Check if we're running inside Teams
    const checkTeamsContext = () => {
      // Check URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const isTeamsTab =
        urlParams.has('loginHint') || urlParams.has('userObjectId') || urlParams.has('theme');

      // Check if running in Teams desktop/mobile client
      const isTeamsClient =
        window.name === 'embedded' ||
        window.location.hostname === 'teams.microsoft.com' ||
        urlParams.has('isTeams');

      // Check if Teams SDK is available
      const hasTeamsSDK = typeof microsoftTeams !== 'undefined';

      if ((isTeamsTab || isTeamsClient) && hasTeamsSDK) {
        setIsInTeams(true);

        // Initialize Teams SDK
        microsoftTeams.initialize(() => {
          console.log('Teams SDK initialized');
          setIsTeamsReady(true);

          // Set app to full height in Teams
          microsoftTeams.appInitialization.notifyAppLoaded();
          microsoftTeams.appInitialization.notifySuccess();
        });
      } else {
        setIsInTeams(false);
        setIsTeamsReady(true);
      }
    };

    checkTeamsContext();
  }, []);

  // If we're in Teams and not authenticated, show Teams-specific auth flow
  if (isInTeams && isTeamsReady && !isAuthenticated) {
    return <TeamsTab />;
  }

  // If we're in Teams, apply Teams-specific styling
  if (isInTeams) {
    return (
      <div className="teams-container min-h-screen bg-[var(--teams-bg,#f5f5f5)]">{children}</div>
    );
  }

  // Not in Teams, render children normally
  return children;
}

export default TeamsWrapper;
