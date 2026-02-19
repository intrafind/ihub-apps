import { useState, useEffect, useContext, createContext, useCallback } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { apiClient } from '../../../api/client';

const AdminAuthContext = createContext();

export function AdminAuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const { user, isAuthenticated: userIsAuthenticated } = useAuth();

  // Check authentication status
  const checkAuthStatus = useCallback(async () => {
    try {
      // Include authentication headers so backend can check current user
      const authToken = localStorage.getItem('authToken');
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};

      const response = await apiClient.get('/admin/auth/status', { headers });
      const data = response.data;

      setAuthRequired(data.authRequired);
      setIsAuthenticated(!data.authRequired);
    } catch (error) {
      console.error('Error checking auth status:', error);
      setIsAuthenticated(false);
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  // Refresh admin auth status when user authentication changes
  useEffect(() => {
    const handleAuthChange = () => {
      // Only refresh if we're not already authenticated to prevent unnecessary re-checks
      if (!isAuthenticated) {
        checkAuthStatus();
      }
    };

    // Listen for auth token changes in localStorage
    window.addEventListener('storage', handleAuthChange);

    // Also refresh on page focus (in case auth changed in another tab)
    // But only if we're not already authenticated
    window.addEventListener('focus', handleAuthChange);

    return () => {
      window.removeEventListener('storage', handleAuthChange);
      window.removeEventListener('focus', handleAuthChange);
    };
  }, [isAuthenticated, checkAuthStatus]);

  // Refresh when user authentication or admin status changes
  // But only if admin is not already authenticated to prevent session resets
  useEffect(() => {
    if (!isAuthenticated) {
      checkAuthStatus();
    }
  }, [user?.id, user?.isAdmin, userIsAuthenticated, isAuthenticated, checkAuthStatus]);

  const value = {
    isAuthenticated,
    authRequired,
    isLoading,
    checkAuthStatus
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return context;
}
