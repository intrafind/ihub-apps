// filepath: /Users/danielmanzke/Workspaces/github.ai/ai-hub-apps/client/src/utils/useSessionManagement.js
import { useEffect } from 'react';
import { getSessionId, renewSession, getSessionInfo } from './sessionManager';
import apiService from '../api/api';

/**
 * Custom hook to handle session initialization and renewal
 * Separates session management logic from component rendering
 */
const useSessionManagement = () => {
  useEffect(() => {
    // Get or create a session ID
    const sessionId = getSessionId();
    
    // Log application load with session ID
    const logSessionStart = async () => {
      try {
        // Get session information for logging
        const sessionInfo = getSessionInfo();
        console.log('Application loaded with session ID:', sessionId);
        
        // Send session start to server using our centralized API service
        await apiService.logSessionStart({
          type: 'app_loaded',
          sessionId,
          metadata: sessionInfo
        });
      } catch (error) {
        console.error('Failed to log session start:', error);
      }
    };
    
    logSessionStart();
    
    // Set up session renewal timer
    const renewalTimer = setInterval(() => {
      renewSession();
    }, 60 * 60 * 1000); // Check once per hour
    
    return () => {
      clearInterval(renewalTimer);
    };
  }, []);
};

export default useSessionManagement;