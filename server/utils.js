/**
 * Helper function to send Server-Sent Events
 * @param {Object} res - Express response object
 * @param {string} event - Event name
 * @param {Object} data - Data to send
 */
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Helper function to get API key for a model
 * @param {string} modelId - The model ID
 * @returns {string|null} The API key or null if not found
 */
export function getApiKeyForModel(modelId) {
  switch (modelId) {
    case 'gpt-3.5-turbo':
      return process.env.GPT_3_5_TURBO_API_KEY;
    case 'gpt-4':
      return process.env.GPT_4_API_KEY;
    case 'claude-3-opus':
      return process.env.CLAUDE_3_OPUS_API_KEY;
    case 'claude-3-sonnet':
      return process.env.CLAUDE_3_SONNET_API_KEY;
    case 'gemini-1.5-flash':
      return process.env.GEMINI_API_KEY;
    default:
      return null;
  }
} 