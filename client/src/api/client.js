import axios from 'axios';
import { getSessionId, shouldRenewSession, renewSession } from '../utils/sessionManager';

const API_URL = import.meta.env.VITE_API_URL || '/api';
const API_REQUEST_TIMEOUT = 30000; // 30 seconds timeout

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

// Add request interceptor to include session ID header
apiClient.interceptors.request.use(config => {
  // Get session ID (creates a new one if needed)
  const sessionId = getSessionId();

  // Renew session if it's close to expiry
  if (shouldRenewSession()) {
    renewSession();
  }

  // Add session ID to request headers
  config.headers['X-Session-ID'] = sessionId;

  return config;
});

// Enhanced retry mechanism for failed requests and 304 handling
apiClient.interceptors.response.use(
  response => {
    // Handle 304 Not Modified responses properly
    if (response.status === 304) {
      response.isNotModified = true;
    }
    return response;
  },
  async error => {
    const originalRequest = error.config;

    // Only retry GET requests, and only once
    if (originalRequest.method === 'get' && !originalRequest._retry && !error.response) {
      originalRequest._retry = true;
      console.log('Network error, retrying request once:', originalRequest.url);

      // Wait a moment before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
      return apiClient(originalRequest);
    }

    return Promise.reject(error);
  }
);

export { apiClient, API_REQUEST_TIMEOUT };
