import { chatAuthRequired } from '../../middleware/authRequired.js';
import CompactionService from '../../services/compaction/CompactionService.js';
import configCache from '../../configCache.js';
import validate from '../../validators/validate.js';
import { z } from 'zod';

// Validation schemas
const compactionStatusSchema = z.object({
  params: z.object({
    appId: z.string(),
    chatId: z.string()
  }),
  body: z.object({
    messages: z.array(z.object({
      id: z.string().optional(),
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      imageData: z.any().optional(),
      fileData: z.any().optional()
    })),
    modelId: z.string()
  })
});

const manualCompactionSchema = z.object({
  params: z.object({
    appId: z.string(),
    chatId: z.string()
  }),
  body: z.object({
    messages: z.array(z.object({
      id: z.string().optional(),
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      imageData: z.any().optional(),
      fileData: z.any().optional()
    })),
    modelId: z.string(),
    strategy: z.enum(['sliding', 'importance', 'llm']).optional(),
    targetPercentage: z.number().min(10).max(90).optional()
  })
});

const autoCompactionSchema = z.object({
  params: z.object({
    appId: z.string(),
    chatId: z.string()
  }),
  body: z.object({
    messages: z.array(z.object({
      id: z.string().optional(),
      role: z.enum(['user', 'assistant', 'system']), 
      content: z.string(),
      imageData: z.any().optional(),
      fileData: z.any().optional()
    })),
    modelId: z.string(),
    strategy: z.enum(['sliding', 'importance', 'llm']).optional()
  })
});

export default function registerCompactionRoutes(app) {
  const compactionService = new CompactionService();

  // Helper function to get API key for a model
  async function getApiKeyForModel(model) {
    try {
      // Use the same API key verification logic as the main chat routes
      const { verifyApiKey } = app.get('deps') || {};
      if (verifyApiKey) {
        return await verifyApiKey(model, null, null, 'en');
      }
      return null;
    } catch (error) {
      console.error('Error getting API key for compaction:', error);
      return null;
    }
  }

  /**
   * GET /api/apps/:appId/chat/:chatId/compaction/status
   * Get compaction status and recommendations for a conversation
   */
  app.post(
    '/api/apps/:appId/chat/:chatId/compaction/status',
    chatAuthRequired,
    validate(compactionStatusSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, modelId } = req.body;

        // Get app and model configurations
        const { data: apps = [] } = configCache.getApps();
        const app = apps.find(a => a.id === appId);
        if (!app) {
          return res.status(404).json({ error: 'App not found' });
        }

        const { data: models = [] } = configCache.getModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        // Get compaction status
        const status = compactionService.getCompactionStatus(messages, model, app);

        res.json({
          success: true,
          status,
          chatId,
          appId,
          modelId
        });

      } catch (error) {
        console.error('Error getting compaction status:', error);
        res.status(500).json({ 
          error: 'Failed to get compaction status',
          message: error.message 
        });
      }
    }
  );

  /**
   * POST /api/apps/:appId/chat/:chatId/compaction/manual
   * Perform manual compaction with user-specified parameters
   */
  app.post(
    '/api/apps/:appId/chat/:chatId/compaction/manual',
    chatAuthRequired,
    validate(manualCompactionSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, modelId, strategy = 'sliding', targetPercentage = 50 } = req.body;

        // Get app and model configurations
        const { data: apps = [] } = configCache.getApps();
        const app = apps.find(a => a.id === appId);
        if (!app) {
          return res.status(404).json({ error: 'App not found' });
        }

        const { data: models = [] } = configCache.getModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        // Get API key if using LLM strategy
        let apiKey = null;
        if (strategy === 'llm') {
          apiKey = await getApiKeyForModel(model);
          if (!apiKey) {
            return res.status(400).json({ 
              error: 'LLM compaction requires valid API key',
              fallbackAvailable: true 
            });
          }
        }

        // Get initial status
        const initialStatus = compactionService.getCompactionStatus(messages, model, app);

        // Perform compaction
        const result = await compactionService.performManualCompaction(messages, {
          strategy,
          targetPercentage,
          model,
          app,
          apiKey
        });

        if (!result) {
          return res.json({
            success: false,
            message: 'No compaction performed - conversation already within target range',
            initialStatus
          });
        }

        // Get final status
        const finalStatus = compactionService.getCompactionStatus(
          result.compactedMessages, 
          model, 
          app
        );

        res.json({
          success: true,
          result: {
            compactedMessages: result.compactedMessages,
            summary: result.summary,
            removedCount: result.removedCount,
            tokensAfter: result.tokensAfter
          },
          initialStatus,
          finalStatus,
          strategy,
          targetPercentage,
          chatId,
          appId
        });

      } catch (error) {
        console.error('Error performing manual compaction:', error);
        res.status(500).json({ 
          error: 'Failed to perform manual compaction',
          message: error.message 
        });
      }
    }
  );

  /**
   * POST /api/apps/:appId/chat/:chatId/compaction/auto
   * Perform automatic compaction based on thresholds
   */
  app.post(
    '/api/apps/:appId/chat/:chatId/compaction/auto',
    chatAuthRequired,
    validate(autoCompactionSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, modelId, strategy = 'sliding' } = req.body;

        // Get app and model configurations
        const { data: apps = [] } = configCache.getApps();
        const app = apps.find(a => a.id === appId);
        if (!app) {
          return res.status(404).json({ error: 'App not found' });
        }

        const { data: models = [] } = configCache.getModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        // Get API key if using LLM strategy
        let apiKey = null;
        if (strategy === 'llm') {
          apiKey = await getApiKeyForModel(model);
          if (!apiKey) {
            console.log('LLM compaction failed - no API key, falling back to sliding window');
            // Don't return error, just fall back to sliding window
          }
        }

        // Get initial status
        const initialStatus = compactionService.getCompactionStatus(messages, model, app);

        // Perform auto compaction
        const result = await compactionService.performAutoCompaction(
          messages, 
          model, 
          app, 
          strategy, 
          apiKey
        );

        if (!result) {
          return res.json({
            success: false,
            message: 'No auto-compaction needed - conversation within acceptable limits',
            status: initialStatus
          });
        }

        // Get final status
        const finalStatus = compactionService.getCompactionStatus(
          result.compactedMessages, 
          model, 
          app
        );

        res.json({
          success: true,
          result: {
            compactedMessages: result.compactedMessages,
            summary: result.summary,
            removedCount: result.removedCount,
            tokensAfter: result.tokensAfter
          },
          initialStatus,
          finalStatus,
          strategy,
          chatId,
          appId,
          autoTriggered: true
        });

      } catch (error) {
        console.error('Error performing auto compaction:', error);
        res.status(500).json({ 
          error: 'Failed to perform auto compaction',
          message: error.message 
        });
      }
    }
  );

  /**
   * GET /api/apps/:appId/chat/:chatId/compaction/strategies
   * Get available compaction strategies and their descriptions
   */
  app.get(
    '/api/apps/:appId/chat/:chatId/compaction/strategies',
    chatAuthRequired,
    async (req, res) => {
      try {
        const strategies = [
          {
            id: 'sliding',
            name: 'Sliding Window',
            description: 'Keeps the most recent messages and system context',
            speed: 'fast',
            quality: 'good',
            costEffective: true,
            recommended: true
          },
          {
            id: 'importance',
            name: 'Importance-Based',
            description: 'Preserves messages based on content importance and recency',
            speed: 'fast',
            quality: 'better',
            costEffective: true,
            recommended: false
          },
          {
            id: 'llm',
            name: 'AI Summarization',
            description: 'Uses AI to create intelligent summaries of conversation history',
            speed: 'slow',
            quality: 'best',
            costEffective: false,
            recommended: false,
            requiresApiKey: true
          }
        ];

        res.json({
          success: true,
          strategies,
          defaultStrategy: 'sliding'
        });

      } catch (error) {
        console.error('Error getting compaction strategies:', error);
        res.status(500).json({ 
          error: 'Failed to get compaction strategies',
          message: error.message 
        });
      }
    }
  );
}