import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Call a tool with given parameters
 * Used by MCP Apps to execute tools on the server
 * 
 * @param {string} toolName - Name of the tool to call
 * @param {object} parameters - Tool parameters
 * @param {string} chatId - Optional chat session ID
 * @returns {Promise<object>} - Tool execution result
 */
export const callTool = async (toolName, parameters = {}, chatId = null) => {
  const headers = {};
  
  if (chatId) {
    headers['X-Chat-Id'] = chatId;
  }

  return handleApiResponse(
    () =>
      apiClient.post(
        '/mcp/messages',
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: parameters
          }
        },
        { headers }
      ),
    null, // No caching for tool calls
    null,
    false // Don't deduplicate
  );
};

/**
 * Fetch available tools
 * @param {object} options - Fetch options
 * @returns {Promise<array>} - List of tools
 */
export const fetchTools = async (options = {}) => {
  const { language = null, skipCache = false } = options;
  
  return handleApiResponse(
    () => apiClient.get('/tools', { params: { lang: language } }),
    skipCache ? null : `tools_${language || 'default'}`,
    60000 // 60 second cache
  );
};
