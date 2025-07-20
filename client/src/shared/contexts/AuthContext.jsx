import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { apiClient } from '../../api/client.js';

// Auth action types
const AUTH_ACTIONS = {
  SET_LOADING: 'SET_LOADING',
  SET_USER: 'SET_USER',
  SET_ERROR: 'SET_ERROR',
  LOGOUT: 'LOGOUT',
  SET_AUTH_CONFIG: 'SET_AUTH_CONFIG'
};

// Initial state
const initialState = {
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  authConfig: {
    authMode: 'proxy',
    allowAnonymous: true,
    authMethods: {
      proxy: { enabled: false },
      local: { enabled: false },
      oidc: { enabled: false, providers: [] }
    }
  }
};

// Auth reducer
function authReducer(state, action) {
  switch (action.type) {
    case AUTH_ACTIONS.SET_LOADING:
      return {
        ...state,
        isLoading: action.payload,
        error: null
      };
    
    case AUTH_ACTIONS.SET_USER:
      return {
        ...state,
        user: action.payload,
        isAuthenticated: !!action.payload && action.payload.id !== 'anonymous',
        isLoading: false,
        error: null
      };
    
    case AUTH_ACTIONS.SET_ERROR:
      return {
        ...state,
        error: action.payload,
        isLoading: false
      };
    
    case AUTH_ACTIONS.LOGOUT:
      // Clear token from localStorage
      localStorage.removeItem('authToken');
      return {
        ...state,
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null
      };
    
    case AUTH_ACTIONS.SET_AUTH_CONFIG:
      return {
        ...state,
        authConfig: action.payload
      };
    
    default:
      return state;
  }
}

// Create context
const AuthContext = createContext();

// Auth provider component
export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  // Load authentication status on mount and handle OIDC callback
  useEffect(() => {
    // Check if this is an OIDC callback
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token') && urlParams.get('provider')) {
      handleOidcCallback();
    } else {
      loadAuthStatus();
    }

    // Listen for token expiration events from API client
    const handleTokenExpired = () => {
      console.log('Token expired, logging out user');
      dispatch({ type: AUTH_ACTIONS.LOGOUT });
    };

    window.addEventListener('authTokenExpired', handleTokenExpired);
    
    return () => {
      window.removeEventListener('authTokenExpired', handleTokenExpired);
    };
  }, []);

  // Load authentication status
  const loadAuthStatus = async () => {
    try {
      dispatch({ type: AUTH_ACTIONS.SET_LOADING, payload: true });
      
      const response = await apiClient.get('/auth/status', {
        headers: getAuthHeaders()
      });
      
      const data = response.data;
      
      if (data.success !== false) {
        dispatch({ type: AUTH_ACTIONS.SET_AUTH_CONFIG, payload: {
          authMode: data.authMode,
          allowAnonymous: data.allowAnonymous,
          authMethods: data.authMethods
        }});
        
        if (data.authenticated && data.user) {
          dispatch({ type: AUTH_ACTIONS.SET_USER, payload: data.user });
        } else {
          // If we had a token but auth status says not authenticated,
          // it means the token was invalidated (possibly due to auth mode change)
          const hadToken = !!localStorage.getItem('authToken');
          if (hadToken) {
            console.log('🔐 Token invalidated by server (possibly due to auth mode change)');
            localStorage.removeItem('authToken');
          }
          dispatch({ type: AUTH_ACTIONS.SET_USER, payload: null });
        }
      } else {
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: null });
      }
    } catch (error) {
      console.error('Failed to load auth status:', error);
      dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: error.message });
    }
  };

  // Get auth headers for API requests
  const getAuthHeaders = () => {
    const token = localStorage.getItem('authToken');
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  };

  // Login with username/password (local auth)
  const login = async (username, password) => {
    try {
      dispatch({ type: AUTH_ACTIONS.SET_LOADING, payload: true });
      
      const response = await apiClient.post('/auth/login', {
        username, 
        password
      });
      
      const data = response.data;
      
      if (data.success && data.token) {
        // Store token
        localStorage.setItem('authToken', data.token);
        
        // Clear any existing cached data to prevent permission leakage
        try {
          const { clearApiCache } = require('../../api/utils/cache');
          clearApiCache();
        } catch (error) {
          // Cache clearing is optional, don't fail login
          console.warn('Could not clear API cache on login:', error);
        }
        
        // Set user
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: data.user });
        
        // Refresh auth status to ensure all components are updated
        setTimeout(() => {
          loadAuthStatus();
        }, 100);
        
        return { success: true };
      } else {
        const error = data.error || 'Login failed';
        dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: error });
        return { success: false, error };
      }
    } catch (error) {
      console.error('Login error:', error);
      const errorMessage = error.message || 'Login failed';
      dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: errorMessage });
      return { success: false, error: errorMessage };
    }
  };

  // Login with external token (proxy auth)
  const loginWithToken = async (token) => {
    try {
      dispatch({ type: AUTH_ACTIONS.SET_LOADING, payload: true });
      
      // Store token
      localStorage.setItem('authToken', token);
      
      // Verify token by getting user info
      const response = await apiClient.get('/auth/user', {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = response.data;
      
      if (data.success && data.user) {
        // Clear any existing cached data to prevent permission leakage
        try {
          const { clearApiCache } = require('../../api/utils/cache');
          clearApiCache();
        } catch (error) {
          // Cache clearing is optional, don't fail login
          console.warn('Could not clear API cache on token login:', error);
        }
        
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: data.user });
        return { success: true };
      } else {
        localStorage.removeItem('authToken');
        const error = 'Invalid token';
        dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: error });
        return { success: false, error };
      }
    } catch (error) {
      localStorage.removeItem('authToken');
      console.error('Token login error:', error);
      const errorMessage = error.message || 'Token login failed';
      dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: errorMessage });
      return { success: false, error: errorMessage };
    }
  };

  // OIDC login - redirect to provider
  const loginWithOidc = (providerName, returnUrl = window.location.href) => {
    try {
      // Store return URL for after authentication
      sessionStorage.setItem('oidcReturnUrl', returnUrl);
      
      // Redirect to OIDC provider
      const authUrl = `/api/auth/oidc/${providerName}?returnUrl=${encodeURIComponent(returnUrl)}`;
      window.location.href = authUrl;
    } catch (error) {
      console.error('OIDC login error:', error);
      dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: error.message });
    }
  };

  // Handle OIDC callback (extract token from URL)
  const handleOidcCallback = async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      const provider = urlParams.get('provider');
      
      if (token) {
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        
        // Login with the token
        const result = await loginWithToken(token);
        
        if (result.success) {
          // Get stored return URL
          const returnUrl = sessionStorage.getItem('oidcReturnUrl');
          sessionStorage.removeItem('oidcReturnUrl');
          
          // Only redirect if it's a different page
          if (returnUrl && returnUrl !== window.location.href) {
            window.location.href = returnUrl;
          }
        }
        
        return result;
      }
    } catch (error) {
      console.error('OIDC callback error:', error);
      dispatch({ type: AUTH_ACTIONS.SET_ERROR, payload: error.message });
      return { success: false, error: error.message };
    }
  };

  // Logout with comprehensive cleanup
  const logout = async () => {
    try {
      // Call logout API if authenticated
      if (state.isAuthenticated) {
        await apiClient.post('/auth/logout', {}, {
          headers: getAuthHeaders()
        });
      }
    } catch (error) {
      console.error('Logout API error:', error);
    } finally {
      // Comprehensive cleanup
      performLogoutCleanup();
      dispatch({ type: AUTH_ACTIONS.LOGOUT });
    }
  };

  // Comprehensive logout cleanup function
  const performLogoutCleanup = () => {
    try {
      // Clear authentication token
      localStorage.removeItem('authToken');
      
      // Clear all auth-related localStorage items
      const authKeys = ['authToken', 'userPreferences', 'lastLoginTime'];
      authKeys.forEach(key => localStorage.removeItem(key));
      
      // Clear all sessionStorage (contains temporary session data)
      sessionStorage.clear();
      
      // Clear API cache if available
      try {
        const { clearApiCache } = require('../../api/utils/cache');
        clearApiCache();
      } catch (error) {
        // Cache clearing is optional, don't fail logout
        console.warn('Could not clear API cache:', error);
      }
      
      // Clear any cached user data from various sources
      const cacheKeys = [
        'recentApps', 'recentPrompts', 'recentItems', 'favoriteApps', 
        'favoritePrompts', 'chatHistory', 'uploadHistory', 'appSettings'
      ];
      cacheKeys.forEach(key => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      });
      
      // Clear any IndexedDB or other persistent storage if used
      if ('indexedDB' in window) {
        // Clear common AI Hub Apps databases
        const dbNames = ['aiHubApps', 'chatHistory', 'userFiles'];
        dbNames.forEach(dbName => {
          try {
            indexedDB.deleteDatabase(dbName);
          } catch (error) {
            console.warn(`Could not clear IndexedDB ${dbName}:`, error);
          }
        });
      }
      
      // Clear browser caches if possible (Service Worker)
      if ('serviceWorker' in navigator && 'caches' in window) {
        caches.keys().then(cacheNames => {
          return Promise.all(
            cacheNames.map(cacheName => {
              if (cacheName.includes('aiHubApps') || cacheName.includes('api')) {
                return caches.delete(cacheName);
              }
            })
          );
        }).catch(error => {
          console.warn('Could not clear service worker caches:', error);
        });
      }
      
      // Dispatch custom event for other components to clean up
      window.dispatchEvent(new CustomEvent('userLoggedOut', {
        detail: { timestamp: new Date().toISOString() }
      }));
      
      console.log('🧹 Logout cleanup completed - all user data cleared');
      
    } catch (error) {
      console.error('Error during logout cleanup:', error);
      // Don't prevent logout if cleanup fails
    }
  };

  // Refresh user data
  const refreshUser = async () => {
    if (!state.isAuthenticated) return;
    
    try {
      const response = await apiClient.get('/auth/user', {
        headers: getAuthHeaders()
      });
      
      const data = response.data;
      
      if (data.success && data.user) {
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: data.user });
      } else {
        // Token might be expired, logout
        dispatch({ type: AUTH_ACTIONS.LOGOUT });
      }
    } catch (error) {
      console.error('Failed to refresh user:', error);
      // Token might be expired, logout
      dispatch({ type: AUTH_ACTIONS.LOGOUT });
    }
  };

  // Check if user has permission for a resource
  const hasPermission = (resourceType, resourceId) => {
    if (!state.user?.permissions) return false;
    
    const allowedResources = state.user.permissions[resourceType];
    if (!allowedResources) return false;
    
    return allowedResources.has?.('*') || allowedResources.has?.(resourceId) || 
           allowedResources.includes?.('*') || allowedResources.includes?.(resourceId);
  };

  // Context value
  const value = {
    // State
    ...state,
    
    // Actions
    login,
    loginWithToken,
    loginWithOidc,
    handleOidcCallback,
    logout,
    refreshUser,
    loadAuthStatus,
    hasPermission,
    getAuthHeaders
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// Hook to use auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}