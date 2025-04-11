/**
 * Client-side session management utility
 * Handles generating, storing, and refreshing the user's session ID
 * Uses sessionStorage to ensure a new session is created when a tab is closed and reopened
 */

// Session timeout in milliseconds (8 hours)
const SESSION_TIMEOUT = 8 * 60 * 60 * 1000;
const SESSION_ID_KEY = 'ai_hub_session_id';
const SESSION_EXPIRY_KEY = 'ai_hub_session_expiry';

/**
 * Generate a random session ID
 * @returns {string} A unique session ID
 */
const generateSessionId = () => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `session-${timestamp}-${random}`;
};

/**
 * Initialize or retrieve a session ID
 * If a valid session exists, returns it, otherwise creates a new one
 * @returns {string} The session ID
 */
export const getSessionId = () => {
  const existingSessionId = sessionStorage.getItem(SESSION_ID_KEY);
  const expiryTime = sessionStorage.getItem(SESSION_EXPIRY_KEY);
  const now = Date.now();

  // Check if we have a valid session
  if (existingSessionId && expiryTime && now < parseInt(expiryTime)) {
    return existingSessionId;
  }

  // Generate a new session ID
  const sessionId = generateSessionId();
  const expiry = now + SESSION_TIMEOUT;
  
  // Store the session ID and its expiry time
  sessionStorage.setItem(SESSION_ID_KEY, sessionId);
  sessionStorage.setItem(SESSION_EXPIRY_KEY, expiry.toString());
  
  console.log('Created new session ID:', sessionId);
  return sessionId;
};

/**
 * Renew the session expiry time
 * @returns {string} The current session ID
 */
export const renewSession = () => {
  const sessionId = getSessionId(); // This will create a new session if needed
  const expiry = Date.now() + SESSION_TIMEOUT;
  
  sessionStorage.setItem(SESSION_EXPIRY_KEY, expiry.toString());
  return sessionId;
};

/**
 * Get the remaining time for the current session in milliseconds
 * @returns {number} Milliseconds until session expiry
 */
export const getSessionRemainingTime = () => {
  const expiryTime = sessionStorage.getItem(SESSION_EXPIRY_KEY);
  if (!expiryTime) {
    return 0;
  }
  
  const now = Date.now();
  const expiry = parseInt(expiryTime);
  return Math.max(0, expiry - now);
};

/**
 * Checks if the session should be renewed (less than 1 hour remaining)
 * @returns {boolean} True if the session should be renewed
 */
export const shouldRenewSession = () => {
  const remainingTime = getSessionRemainingTime();
  const oneHour = 60 * 60 * 1000;
  return remainingTime < oneHour;
};

/**
 * Get session information for logging/tracking
 * @returns {Object} Session information
 */
export const getSessionInfo = () => {
  const sessionId = getSessionId();
  const expiryTime = sessionStorage.getItem(SESSION_EXPIRY_KEY);
  
  return {
    sessionId,
    expiresAt: expiryTime ? parseInt(expiryTime) : null,
    createdAt: sessionId.split('-')[1], // Extract timestamp from session ID
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
};