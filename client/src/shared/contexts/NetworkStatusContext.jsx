import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../../api/client';

const NetworkStatusContext = createContext();

// Connection states
export const CONNECTION_STATES = {
  ONLINE: 'online', // User online, backend reachable
  OFFLINE: 'offline', // User offline (no internet)
  BACKEND_OFFLINE: 'backend_offline', // User online, backend unreachable
  CHECKING: 'checking' // Checking connection status
};

// Error types for better categorization
export const ERROR_TYPES = {
  NETWORK: 'network', // User connectivity issues
  BACKEND: 'backend', // Backend server issues
  TIMEOUT: 'timeout', // Request timeout
  UNKNOWN: 'unknown' // Other errors
};

export function NetworkStatusProvider({ children }) {
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.CHECKING);
  const [lastBackendCheck, setLastBackendCheck] = useState(null);
  const [retryAttempts, setRetryAttempts] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);

  const checkInterval = useRef(null);
  const retryTimeout = useRef(null);

  // Check if user is online
  const checkUserOnline = useCallback(() => {
    return navigator.onLine;
  }, []);

  // Check if backend is reachable
  const checkBackendStatus = useCallback(async () => {
    if (!checkUserOnline()) {
      return false;
    }

    try {
      // Use a lightweight health check endpoint
      const response = await apiClient.get('/health', {
        timeout: 5000,
        // Don't retry health checks
        _skipRetry: true
      });
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.debug('Backend health check failed:', error.message);
      return false;
    }
  }, [checkUserOnline]);

  // Determine connection state based on user online status and backend reachability
  const updateConnectionState = useCallback(async () => {
    const userOnline = checkUserOnline();

    if (!userOnline) {
      setConnectionState(CONNECTION_STATES.OFFLINE);
      setLastBackendCheck(null);
      return CONNECTION_STATES.OFFLINE;
    }

    setConnectionState(CONNECTION_STATES.CHECKING);
    const backendReachable = await checkBackendStatus();
    const now = Date.now();
    setLastBackendCheck(now);

    const newState = backendReachable
      ? CONNECTION_STATES.ONLINE
      : CONNECTION_STATES.BACKEND_OFFLINE;

    setConnectionState(newState);
    return newState;
  }, [checkUserOnline, checkBackendStatus]);

  // Retry connection with exponential backoff
  const retryConnection = useCallback(async () => {
    if (isRetrying) return;

    setIsRetrying(true);
    const newState = await updateConnectionState();

    if (newState === CONNECTION_STATES.ONLINE) {
      setRetryAttempts(0);
      setIsRetrying(false);
      return true;
    }

    // Only retry if user is online but backend is unreachable
    if (newState === CONNECTION_STATES.BACKEND_OFFLINE) {
      const nextAttempt = retryAttempts + 1;
      setRetryAttempts(nextAttempt);

      // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(Math.pow(2, nextAttempt) * 1000, 30000);

      retryTimeout.current = setTimeout(() => {
        setIsRetrying(false);
        retryConnection();
      }, delay);
    } else {
      setIsRetrying(false);
    }

    return false;
  }, [isRetrying, retryAttempts, updateConnectionState]);

  // Classify error types for better handling
  const classifyError = useCallback(
    error => {
      if (!checkUserOnline()) {
        return ERROR_TYPES.NETWORK;
      }

      if (error?.code === 'ERR_NETWORK' || error?.message?.includes('Network Error')) {
        return ERROR_TYPES.BACKEND;
      }

      if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) {
        return ERROR_TYPES.TIMEOUT;
      }

      if (error?.code === 'ERR_CONNECTION_REFUSED') {
        return ERROR_TYPES.BACKEND;
      }

      return ERROR_TYPES.UNKNOWN;
    },
    [checkUserOnline]
  );

  // Get user-friendly error message
  const getErrorMessage = useCallback(
    (error, t) => {
      const errorType = classifyError(error);

      switch (errorType) {
        case ERROR_TYPES.NETWORK:
          return t(
            'network.errors.offline',
            'You appear to be offline. Please check your internet connection.'
          );
        case ERROR_TYPES.BACKEND:
          return t(
            'network.errors.backend',
            'Unable to connect to the server. Please try again in a moment.'
          );
        case ERROR_TYPES.TIMEOUT:
          return t('network.errors.timeout', 'Request timed out. Please try again.');
        default:
          return t('network.errors.unknown', 'An unexpected error occurred. Please try again.');
      }
    },
    [classifyError]
  );

  // Check if we should retry a request based on error type
  const shouldRetryRequest = useCallback(
    error => {
      const errorType = classifyError(error);

      // Don't retry if user is offline
      if (errorType === ERROR_TYPES.NETWORK) {
        return false;
      }

      // Retry backend and timeout errors
      return errorType === ERROR_TYPES.BACKEND || errorType === ERROR_TYPES.TIMEOUT;
    },
    [classifyError]
  );

  // Setup event listeners and periodic checks
  useEffect(() => {
    // Initial connection check
    updateConnectionState();

    // Listen for online/offline events
    const handleOnline = () => {
      setRetryAttempts(0);
      updateConnectionState();
    };

    const handleOffline = () => {
      setConnectionState(CONNECTION_STATES.OFFLINE);
      setLastBackendCheck(null);
      setRetryAttempts(0);
    };

    // Listen for focus events to re-check connection
    const handleFocus = () => {
      // Only check if we've been offline or checking for a while
      const timeSinceLastCheck = lastBackendCheck ? Date.now() - lastBackendCheck : Infinity;
      if (timeSinceLastCheck > 30000 || connectionState !== CONNECTION_STATES.ONLINE) {
        updateConnectionState();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);

    // Periodic health checks when online
    checkInterval.current = setInterval(() => {
      if (connectionState === CONNECTION_STATES.ONLINE) {
        // Less frequent checks when everything is working
        const timeSinceLastCheck = lastBackendCheck ? Date.now() - lastBackendCheck : Infinity;
        if (timeSinceLastCheck > 60000) {
          // Check every minute when online
          updateConnectionState();
        }
      }
    }, 60000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);

      if (checkInterval.current) {
        clearInterval(checkInterval.current);
      }
      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
      }
    };
  }, [connectionState, lastBackendCheck, updateConnectionState]);

  const value = {
    connectionState,
    isOnline: connectionState === CONNECTION_STATES.ONLINE,
    isOffline: connectionState === CONNECTION_STATES.OFFLINE,
    isBackendOffline: connectionState === CONNECTION_STATES.BACKEND_OFFLINE,
    isChecking: connectionState === CONNECTION_STATES.CHECKING,
    isRetrying,
    retryAttempts,
    lastBackendCheck,

    // Actions
    retryConnection,
    updateConnectionState,

    // Utilities
    classifyError,
    getErrorMessage,
    shouldRetryRequest
  };

  return <NetworkStatusContext.Provider value={value}>{children}</NetworkStatusContext.Provider>;
}

export function useNetworkStatus() {
  const context = useContext(NetworkStatusContext);
  if (!context) {
    throw new Error('useNetworkStatus must be used within a NetworkStatusProvider');
  }
  return context;
}
