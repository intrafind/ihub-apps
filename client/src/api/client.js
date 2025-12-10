import axios from 'axios';
import { getSessionId, shouldRenewSession, renewSession } from '../utils/sessionManager';
import { buildApiUrl } from '../utils/runtimeBasePath';

// Use dynamic API URL based on runtime base path detection
const API_URL = import.meta.env.VITE_API_URL || buildApiUrl('');
const API_REQUEST_TIMEOUT = 30000; // 30 seconds timeout
const STREAMING_REQUEST_TIMEOUT = 300000; // 5 minutes for streaming requests

// Create axios instance with request timeout
const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: API_REQUEST_TIMEOUT,
  withCredentials: true, // Include cookies in requests
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
  withCredentials: true, // Include cookies in requests
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

    // Add authentication header as fallback if token exists in localStorage
    // (for backward compatibility - cookies are preferred)
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
      return response;
    },
    async error => {
      const originalRequest = error.config;

      // Handle authentication errors
      if (error.response?.status === 401) {
        // Token expired or invalid - clear localStorage token for backward compatibility
        const currentToken = localStorage.getItem('authToken');
        if (currentToken) {
          console.log('Authentication token expired or invalid, clearing localStorage token');
          localStorage.removeItem('authToken');
        }

        // Dispatch custom event for auth context to handle (will handle cookie clearing via logout API)
        window.dispatchEvent(new CustomEvent('authTokenExpired'));

        // Don't retry auth requests to avoid infinite loops
        return Promise.reject(error);
      }

      // Only retry GET requests, and only once
      if (originalRequest.method === 'get' && !originalRequest._retry && !error.response) {
        originalRequest._retry = true;
        console.log('Network error, retrying request once:', originalRequest.url);

        // Wait a moment before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
        return client(originalRequest);
      }

      return Promise.reject(error);
    }
  );
};

// Add response interceptor to both clients
addResponseInterceptor(apiClient);
addResponseInterceptor(streamingApiClient);

export { apiClient, streamingApiClient, API_REQUEST_TIMEOUT, STREAMING_REQUEST_TIMEOUT };
