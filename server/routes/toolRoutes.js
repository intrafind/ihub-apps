import { loadTools, runTool } from '../toolLoader.js';
import { logInteraction } from '../utils.js';

export default function registerToolRoutes(app) {
  app.get('/api/tools', async (req, res) => {
    try {
      const tools = await loadTools();
      res.json(tools);
    } catch (error) {
      console.error('Error fetching tools:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.all('/api/tools/:toolId', async (req, res) => {
    const { toolId } = req.params;
    const params = req.method === 'GET' ? req.query : req.body;
    if (req.headers['x-chat-id']) {
      params.chatId = req.headers['x-chat-id'];
    }
    try {
      const result = await runTool(toolId, params);
      await logInteraction('tool_usage', {
        toolId,
        toolInput: params,
        toolOutput: result,
        sessionId: req.headers['x-chat-id'] || 'direct',
        userSessionId: req.headers['x-session-id'] || 'unknown'
      });
      res.json(result);
    } catch (error) {
      console.error(`Tool ${toolId} error:`, error);
      res.status(500).json({ error: 'Tool execution failed' });
    }
  });
}
