import { useEffect } from 'react';
import { getSessionId, renewSession, getSessionInfo } from '../../utils/sessionManager.js';
import { sendSessionStart } from '../../api/api';

/**
 * Custom hook to handle session initialization and renewal
 * Separates session management logic from component rendering
 */
const useSessionManagement = () => {
  useEffect(() => {
    // Get or create a session ID
    const sessionId = getSessionId();

    // Log application load with session ID
    const logSession = async() => {
      try {
        // Get session information for logging
        const sessionInfo = getSessionInfo();
        console.log('Application loaded with session ID:', sessionId);

        // Send session start to server using our centralized API service
        await sendSessionStart({
          type: 'app_loaded',
          sessionId,
          metadata: sessionInfo
        });
      } catch (error) {
        console.error('Failed to log session start:', error);
      }
    };

    logSession();

    // Set up session renewal timer
    const renewalTimer = setInterval(
      () => {
        renewSession();
      },
      60 * 60 * 1000
    ); // Check once per hour

    return () => {
      clearInterval(renewalTimer);
    };
  }, []);
};

export default useSessionManagement;
