import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { buildApiUrl } from '../../utils/runtimeBasePath';

const NetworkStatusContext = createContext({ isOnline: true, isChecking: false, retryCount: 0 });

const HEALTH_URL = buildApiUrl('/health');
const HEALTH_TIMEOUT_MS = 5000;
const INITIAL_POLL_INTERVAL = 5000;
const MAX_POLL_INTERVAL = 30000;

async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function NetworkStatusProvider({ children }) {
  const [isOnline, setIsOnline] = useState(true);
  const [isChecking, setIsChecking] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const pollRef = useRef(null);
  const pollIntervalRef = useRef(INITIAL_POLL_INTERVAL);
  const isOnlineRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const markOnline = useCallback(() => {
    stopPolling();
    isOnlineRef.current = true;
    setIsOnline(true);
    setRetryCount(0);
    pollIntervalRef.current = INITIAL_POLL_INTERVAL;
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    const poll = async () => {
      setIsChecking(true);
      const healthy = await checkHealth();
      setIsChecking(false);
      if (healthy) {
        markOnline();
      } else {
        setRetryCount(prev => prev + 1);
        // Exponential backoff capped at MAX_POLL_INTERVAL
        pollIntervalRef.current = Math.min(pollIntervalRef.current * 1.5, MAX_POLL_INTERVAL);
        pollRef.current = setTimeout(poll, pollIntervalRef.current);
      }
    };
    poll();
  }, [stopPolling, markOnline]);

  const markOffline = useCallback(() => {
    if (isOnlineRef.current) {
      isOnlineRef.current = false;
      setIsOnline(false);
      startPolling();
    }
  }, [startPolling]);

  // Verify connectivity on mount and after visibility change (laptop wake)
  const verifyConnectivity = useCallback(async () => {
    const healthy = await checkHealth();
    if (healthy) {
      markOnline();
    } else {
      markOffline();
    }
  }, [markOnline, markOffline]);

  useEffect(() => {
    // Browser online/offline events
    const handleOnline = () => verifyConnectivity();
    const handleOffline = () => markOffline();

    // Visibility change — user reopened laptop, VPN may be gone or back
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        verifyConnectivity();
      }
    };

    // Custom event dispatched by lazyWithRetry when chunk loads fail
    const handleServerUnreachable = () => markOffline();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('serverUnreachable', handleServerUnreachable);

    // Verify on mount — if app starts while server/VPN is already unreachable
    verifyConnectivity();

    return () => {
      stopPolling();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('serverUnreachable', handleServerUnreachable);
    };
  }, [verifyConnectivity, markOffline, stopPolling]);

  const contextValue = useMemo(
    () => ({ isOnline, isChecking, retryCount }),
    [isOnline, isChecking, retryCount]
  );

  return (
    <NetworkStatusContext.Provider value={contextValue}>
      {children}
    </NetworkStatusContext.Provider>
  );
}

export function useNetworkStatus() {
  return useContext(NetworkStatusContext);
}
