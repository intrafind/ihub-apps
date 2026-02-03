/**
 * Get Time Tool - Example MCP App
 * Returns the current server time and demonstrates MCP App integration
 */
export default async function getTime(params) {
  const now = new Date();
  
  return {
    content: [
      {
        type: 'text',
        text: now.toISOString()
      }
    ],
    // Include UI metadata to trigger MCP App rendering
    _meta: {
      ui: {
        resourceUri: 'ui://getTime/app.html'
      }
    }
  };
}
