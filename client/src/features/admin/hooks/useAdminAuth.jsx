import { useState, useEffect, useContext, createContext } from 'react';

const AdminAuthContext = createContext();

export function AdminAuthProvider({ children }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem('adminToken') || '');

  // Check authentication status
  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/admin/auth/status');
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
    } catch (error) {
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
