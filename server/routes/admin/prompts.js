import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminPromptsRoutes(app) {
  app.get('/api/admin/prompts', adminAuth, async (req, res) => {
    try {
      const { data: prompts, etag } = configCache.getPrompts(true);
      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }
      if (etag) {
        res.setHeader('ETag', etag);
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
          return res.status(304).end();
        }
      }
      res.json(prompts);
    } catch (error) {
      console.error('Error fetching all prompts:', error);
      res.status(500).json({ error: 'Failed to fetch prompts' });
    }
  });

  app.get('/api/admin/prompts/:promptId', adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;
      const { data: prompts } = configCache.getPrompts(true);
      const prompt = prompts.find(p => p.id === promptId);
      if (!prompt) {
        return res.status(404).json({ error: 'Prompt not found' });
      }
      res.json(prompt);
    } catch (error) {
      console.error('Error fetching prompt:', error);
      res.status(500).json({ error: 'Failed to fetch prompt' });
    }
  });

  app.put('/api/admin/prompts/:promptId', adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;
      const updatedPrompt = req.body;
      if (!updatedPrompt.id || !updatedPrompt.name || !updatedPrompt.prompt) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (updatedPrompt.id !== promptId) {
        return res.status(400).json({ error: 'Prompt ID cannot be changed' });
      }
      const rootDir = getRootDir();
      const promptFilePath = join(rootDir, 'contents', 'prompts', `${promptId}.json`);
      await fs.writeFile(promptFilePath, JSON.stringify(updatedPrompt, null, 2));
      await configCache.refreshPromptsCache();
      res.json({ message: 'Prompt updated successfully', prompt: updatedPrompt });
    } catch (error) {
      console.error('Error updating prompt:', error);
      res.status(500).json({ error: 'Failed to update prompt' });
    }
  });

  app.post('/api/admin/prompts', adminAuth, async (req, res) => {
    try {
      const newPrompt = req.body;
      if (!newPrompt.id || !newPrompt.name || !newPrompt.prompt) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const rootDir = getRootDir();
      const promptFilePath = join(rootDir, 'contents', 'prompts', `${newPrompt.id}.json`);
      try {
        readFileSync(promptFilePath, 'utf8');
        return res.status(400).json({ error: 'Prompt with this ID already exists' });
      } catch {
        // file not found
      }
      await fs.writeFile(promptFilePath, JSON.stringify(newPrompt, null, 2));
      await configCache.refreshPromptsCache();
      res.json({ message: 'Prompt created successfully', prompt: newPrompt });
    } catch (error) {
      console.error('Error creating prompt:', error);
      res.status(500).json({ error: 'Failed to create prompt' });
    }
  });

  app.post('/api/admin/prompts/:promptId/toggle', adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;
      const { data: prompts } = configCache.getPrompts(true);
      const prompt = prompts.find(p => p.id === promptId);
      if (!prompt) {
        return res.status(404).json({ error: 'Prompt not found' });
      }
      const newEnabledState = !prompt.enabled;
      prompt.enabled = newEnabledState;
      const rootDir = getRootDir();
      const promptFilePath = join(rootDir, 'contents', 'prompts', `${promptId}.json`);
      await fs.writeFile(promptFilePath, JSON.stringify(prompt, null, 2));
      await configCache.refreshPromptsCache();
      res.json({
        message: `Prompt ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        prompt: prompt,
        enabled: newEnabledState
      });
    } catch (error) {
      console.error('Error toggling prompt:', error);
      res.status(500).json({ error: 'Failed to toggle prompt' });
    }
  });

  app.post('/api/admin/prompts/:promptIds/_toggle', adminAuth, async (req, res) => {
    try {
      const { promptIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Missing enabled flag' });
      }

      const { data: prompts } = configCache.getPrompts(true);
      const ids = promptIds === '*' ? prompts.map(p => p.id) : promptIds.split(',');
      const rootDir = getRootDir();

      for (const id of ids) {
        const prompt = prompts.find(p => p.id === id);
        if (!prompt) continue;
        if (prompt.enabled !== enabled) {
          prompt.enabled = enabled;
          const promptFilePath = join(rootDir, 'contents', 'prompts', `${id}.json`);
          await fs.writeFile(promptFilePath, JSON.stringify(prompt, null, 2));
        }
      }

      await configCache.refreshPromptsCache();
      res.json({
        message: `Prompts ${enabled ? 'enabled' : 'disabled'} successfully`,
        enabled,
        ids
      });
    } catch (error) {
      console.error('Error toggling prompts:', error);
      res.status(500).json({ error: 'Failed to toggle prompts' });
    }
  });

  app.delete('/api/admin/prompts/:promptId', adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;
      const rootDir = getRootDir();
      const promptFilePath = join(rootDir, 'contents', 'prompts', `${promptId}.json`);
      if (!existsSync(promptFilePath)) {
        return res.status(404).json({ error: 'Prompt file not found' });
      }
      await fs.unlink(promptFilePath);
      await configCache.refreshPromptsCache();
      res.json({ message: 'Prompt deleted successfully' });
    } catch (error) {
      console.error('Error deleting prompt:', error);
      res.status(500).json({ error: 'Failed to delete prompt' });
    }
  });

  app.post('/api/completions', adminAuth, async (req, res) => {
    try {
      const {
        model,
        messages,
        temperature = 0.7,
        maxTokens = 8192,
        responseFormat = null,
        responseSchema = null
      } = req.body;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Missing required field: messages' });
      }
      let { data: models = [] } = configCache.getModels();
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const defaultModel = models.find(m => m.default)?.id;
      const modelId = model || defaultModel;
      if (!modelId) {
        return res
          .status(400)
          .json({ error: 'No model specified and no default model configured' });
      }
      const modelConfig = models.find(m => m.id === modelId);
      if (!modelConfig) {
        return res.status(400).json({ error: `Model not found: ${modelId}` });
      }
      const { verifyApiKey } = await import('../../serverHelpers.js');
      const apiKey = await verifyApiKey(modelConfig, res);
      if (!apiKey) {
        return;
      }
      const { simpleCompletion } = await import('../../utils.js');
      const result = await simpleCompletion(messages, {
        modelId: modelId,
        temperature: temperature,
        responseFormat: responseFormat,
        responseSchema: responseSchema,
        maxTokens: maxTokens
      });
      console.log('Completion result:', JSON.stringify(result, null, 2));
      res.json({
        choices: [
          {
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
            index: 0
          }
        ],
        model: modelId,
        usage: result.usage
      });
    } catch (error) {
      console.error('Error in completions endpoint:', error);
      const { getLocalizedError } = await import('../../serverHelpers.js');
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      let errorMessage = 'Failed to generate completion';
      try {
        errorMessage = await getLocalizedError('internalError', {}, defaultLang);
      } catch (localizationError) {
        console.warn('Failed to get localized error message:', localizationError);
      }
      res.status(500).json({ error: errorMessage, details: error.message });
    }
  });

  app.get('/api/admin/prompts/app-generator', adminAuth, async (req, res) => {
    try {
      const platformConfig = configCache.getPlatform();
      const defaultLanguage = platformConfig?.defaultLanguage || 'en';
      const { lang = defaultLanguage } = req.query;
      const { data: prompts } = configCache.getPrompts(true);
      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }
      const appGeneratorPrompt = prompts.find(p => p.id === 'app-generator');
      if (!appGeneratorPrompt) {
        return res.status(404).json({ error: 'App-generator prompt not found' });
      }
      const promptText =
        appGeneratorPrompt.prompt[lang] || appGeneratorPrompt.prompt[defaultLanguage];
      res.json({ id: appGeneratorPrompt.id, prompt: promptText, language: lang });
    } catch (error) {
      console.error('Error fetching app-generator prompt:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
