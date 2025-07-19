import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { apiRequest } from '../../api/api.js';

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
  }, []);

  // Load authentication status
  const loadAuthStatus = async () => {
    try {
      dispatch({ type: AUTH_ACTIONS.SET_LOADING, payload: true });
      
      const response = await apiRequest('/api/auth/status', {
        method: 'GET',
        headers: getAuthHeaders()
      });
      
      if (response.success !== false) {
        dispatch({ type: AUTH_ACTIONS.SET_AUTH_CONFIG, payload: {
          authMode: response.authMode,
          allowAnonymous: response.allowAnonymous,
          authMethods: response.authMethods
        }});
        
        if (response.authenticated && response.user) {
          dispatch({ type: AUTH_ACTIONS.SET_USER, payload: response.user });
        } else {
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
      
      const response = await apiRequest('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      if (response.success && response.token) {
        // Store token
        localStorage.setItem('authToken', response.token);
        
        // Set user
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: response.user });
        
        return { success: true };
      } else {
        const error = response.error || 'Login failed';
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
      const response = await apiRequest('/api/auth/user', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.success && response.user) {
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: response.user });
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

  // Logout
  const logout = async () => {
    try {
      // Call logout API if authenticated
      if (state.isAuthenticated) {
        await apiRequest('/api/auth/logout', {
          method: 'POST',
          headers: getAuthHeaders()
        });
      }
    } catch (error) {
      console.error('Logout API error:', error);
    } finally {
      dispatch({ type: AUTH_ACTIONS.LOGOUT });
    }
  };

  // Refresh user data
  const refreshUser = async () => {
    if (!state.isAuthenticated) return;
    
    try {
      const response = await apiRequest('/api/auth/user', {
        method: 'GET',
        headers: getAuthHeaders()
      });
      
      if (response.success && response.user) {
        dispatch({ type: AUTH_ACTIONS.SET_USER, payload: response.user });
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