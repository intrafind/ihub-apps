import { useState, useEffect, useContext, createContext } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext';

const AdminAuthContext = createContext();

export function AdminAuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem('adminToken') || '');
  const { user, isAuthenticated: userIsAuthenticated } = useAuth();

  // Check authentication status
  const checkAuthStatus = async () => {
    try {
      // Include authentication headers so backend can check current user
      const authToken = localStorage.getItem('authToken');
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};

      const response = await fetch('/api/admin/auth/status', { headers });
      const data = await response.json();

      setAuthRequired(data.authRequired);

      if (!data.authRequired) {
        setIsAuthenticated(true);
        setIsLoading(false);
        return;
      }

      // If auth is required, test the current token
      if (token) {
        const testResponse = await fetch('/api/admin/auth/test', {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (testResponse.ok) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          localStorage.removeItem('adminToken');
          setToken('');
        }
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Error checking auth status:', error);
      setIsAuthenticated(false);
    }

    setIsLoading(false);
  };

  useEffect(() => {
    checkAuthStatus();
  }, [token]);

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
  }, [isAuthenticated]);

  // Refresh when user authentication or admin status changes
  // But only if admin is not already authenticated to prevent session resets
  useEffect(() => {
    if (!isAuthenticated) {
      checkAuthStatus();
    }
  }, [user?.id, user?.isAdmin, userIsAuthenticated, isAuthenticated]);

  const login = async adminSecret => {
    try {
      const response = await fetch('/api/admin/auth/test', {
        headers: {
          Authorization: `Bearer ${adminSecret}`
        }
      });

      if (response.ok) {
        setToken(adminSecret);
        setIsAuthenticated(true);
        localStorage.setItem('adminToken', adminSecret);
        return { success: true };
      } else {
        const data = await response.json();
        return { success: false, error: data.message || 'Authentication failed' };
      }
    } catch {
      return { success: false, error: 'Network error during authentication' };
    }
  };

  const logout = () => {
    setToken('');
    setIsAuthenticated(false);
    localStorage.removeItem('adminToken');
  };

  const value = {
    isAuthenticated,
    authRequired,
    isLoading,
    token,
    login,
    logout,
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
