import axios from 'axios';
import { getSessionId, shouldRenewSession, renewSession } from '../utils/sessionManager';

// Network status utilities
let networkStatusContext = null;

// Function to set the network status context (called from App.jsx)
export const setNetworkStatusContext = context => {
  networkStatusContext = context;
};

const API_URL = import.meta.env.VITE_API_URL || '/api';
const API_REQUEST_TIMEOUT = 30000; // 30 seconds timeout
const STREAMING_REQUEST_TIMEOUT = 120000; // 2 minutes for streaming requests

// Create axios instance with request timeout
const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: API_REQUEST_TIMEOUT,
  // Configure axios to not treat 304 as an error
  validateStatus: function (status) {
    return (status >= 200 && status < 300) || status === 304;
  }
});

// Create axios instance for streaming requests with longer timeout
const streamingApiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: STREAMING_REQUEST_TIMEOUT,
  // Configure axios to not treat 304 as an error
  validateStatus: function (status) {
    return (status >= 200 && status < 300) || status === 304;
  }
});

// Shared request interceptor function
const addRequestInterceptor = client => {
  client.interceptors.request.use(config => {
    // Get session ID (creates a new one if needed)
    const sessionId = getSessionId();

    // Renew session if it's close to expiry
    if (shouldRenewSession()) {
      renewSession();
    }

    // Add session ID to request headers
    config.headers['X-Session-ID'] = sessionId;

    // Add authentication header if token exists
    const authToken = localStorage.getItem('authToken');
    if (authToken) {
      config.headers['Authorization'] = `Bearer ${authToken}`;
    }

    return config;
  });
};

// Add request interceptor to both clients
addRequestInterceptor(apiClient);
addRequestInterceptor(streamingApiClient);

// Shared response interceptor function
const addResponseInterceptor = client => {
  client.interceptors.response.use(
    response => {
      // Handle 304 Not Modified responses properly
      if (response.status === 304) {
        response.isNotModified = true;
      }

      // If we successfully get a response and network status context is available,
      // trigger a connection state update to mark as online
      if (networkStatusContext?.updateConnectionState && response.status < 300) {
        // Only update if we were previously offline/checking
        if (!networkStatusContext.isOnline) {
          networkStatusContext.updateConnectionState();
        }
      }

      return response;
    },
    async error => {
      // Handle authentication errors
      if (error.response?.status === 401) {
        // Token expired or invalid - clear it and potentially redirect to login
        const currentToken = localStorage.getItem('authToken');
        if (currentToken) {
          console.log('Authentication token expired or invalid, clearing token');
          localStorage.removeItem('authToken');

          // Dispatch custom event for auth context to handle
          window.dispatchEvent(new CustomEvent('authTokenExpired'));
        }

        // Don't retry auth requests to avoid infinite loops
        return Promise.reject(error);
      }

      // Enhance error with network context if available
      if (networkStatusContext) {
        error.networkStatus = {
          connectionState: networkStatusContext.connectionState,
          isOnline: networkStatusContext.isOnline,
          errorType: networkStatusContext.classifyError(error)
        };
      }

      return Promise.reject(error);
    }
  );
};

// Add response interceptor to both clients
addResponseInterceptor(apiClient);
addResponseInterceptor(streamingApiClient);

export { apiClient, streamingApiClient, API_REQUEST_TIMEOUT, STREAMING_REQUEST_TIMEOUT };
