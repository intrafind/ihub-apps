/**
 * Utility for redacting sensitive information from logs
 * Prevents API keys and other secrets from being exposed in log output
 */

/**
 * Redact API keys from URLs
 * @param {string} url - URL that may contain API keys
 * @returns {string} URL with redacted API keys
 */
export function redactUrl(url) {
  if (!url || typeof url !== 'string') return url;

  // Redact Google API keys in query parameters (?key=xxx or &key=xxx)
  let redacted = url.replace(/([?&]key=)[^&]+/gi, '$1[REDACTED]');

  // Redact other common API key patterns in query strings
  redacted = redacted.replace(/([?&]api[_-]?key=)[^&]+/gi, '$1[REDACTED]');
  redacted = redacted.replace(/([?&]apikey=)[^&]+/gi, '$1[REDACTED]');
  redacted = redacted.replace(/([?&]token=)[^&]+/gi, '$1[REDACTED]');
  redacted = redacted.replace(/([?&]access[_-]?token=)[^&]+/gi, '$1[REDACTED]');

  return redacted;
}

/**
 * Redact sensitive information from headers
 * @param {Object} headers - HTTP headers object
 * @returns {Object} Headers with redacted sensitive values
 */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  const redacted = { ...headers };
  const sensitiveHeaders = [
    'authorization',
    'x-api-key',
    'api-key',
    'apikey',
    'x-auth-token',
    'auth-token'
  ];

  for (const key of Object.keys(redacted)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      // Keep the first few characters to help with debugging
      const value = redacted[key];
      if (typeof value === 'string' && value.length > 10) {
        redacted[key] = value.substring(0, 10) + '...[REDACTED]';
      } else {
        redacted[key] = '[REDACTED]';
      }
    }
  }

  return redacted;
}

/**
 * Redact sensitive information from request body
 * @param {Object} body - Request body object
 * @returns {Object} Body with redacted sensitive values
 */
export function redactRequestBody(body) {
  if (!body || typeof body !== 'object') return body;

  // Deep clone to avoid modifying the original
  const redacted = JSON.parse(JSON.stringify(body));

  // Redact common sensitive fields
  const sensitiveFields = ['api_key', 'apiKey', 'apikey', 'token', 'accessToken', 'password'];

  const redactRecursive = obj => {
    if (!obj || typeof obj !== 'object') return;

    for (const key of Object.keys(obj)) {
      if (sensitiveFields.includes(key)) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        redactRecursive(obj[key]);
      }
    }
  };

  redactRecursive(redacted);
  return redacted;
}

/**
 * Redact sensitive information from any log message
 * @param {string} message - Log message that may contain sensitive data
 * @returns {string} Message with redacted sensitive information
 */
export function redactLogMessage(message) {
  if (!message || typeof message !== 'string') return message;

  let redacted = message;

  // Redact URLs with API keys
  redacted = redactUrl(redacted);

  // Redact bearer tokens
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');

  // Redact API keys that look like: sk-xxx, api-xxx, key-xxx
  redacted = redacted.replace(/\b(sk|api|key)-[A-Za-z0-9_\-]{20,}\b/gi, '$1-[REDACTED]');

  // Redact generic API key patterns (long alphanumeric strings that look like keys)
  redacted = redacted.replace(/\b[A-Za-z0-9]{32,}\b/g, match => {
    // Only redact if it looks like a random key (mixed case and numbers)
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED]';
    }
    return match;
  });

  return redacted;
}

/**
 * Create a safe console.log wrapper that redacts sensitive information
 * @param {...any} args - Arguments to log
 */
export function safeLog(...args) {
  const redactedArgs = args.map(arg => {
    if (typeof arg === 'string') {
      return redactLogMessage(arg);
    } else if (typeof arg === 'object' && arg !== null) {
      // Check if it's a URL-like object
      if (arg.url) {
        return { ...arg, url: redactUrl(arg.url) };
      }
      // Check if it's headers
      if (arg.Authorization || arg.authorization || arg['x-api-key']) {
        return redactHeaders(arg);
      }
      return arg;
    }
    return arg;
  });

  console.log(...redactedArgs);
}

/**
 * Create a safe console.error wrapper that redacts sensitive information
 * @param {...any} args - Arguments to log
 */
export function safeError(...args) {
  const redactedArgs = args.map(arg => {
    if (typeof arg === 'string') {
      return redactLogMessage(arg);
    }
    return arg;
  });

  console.error(...redactedArgs);
}
