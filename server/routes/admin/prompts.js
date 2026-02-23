import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, validateIdsForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     PromptTemplate:
 *       type: object
 *       description: AI prompt template configuration with localization support
 *       required:
 *         - id
 *         - name
 *         - prompt
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the prompt template
 *           example: "summarize"
 *         category:
 *           type: string
 *           description: Category for organizing prompts
 *           example: "summarization"
 *         name:
 *           type: object
 *           description: Localized names for the prompt template
 *           additionalProperties:
 *             type: string
 *           example: { "en": "Summarize Text", "de": "Text zusammenfassen" }
 *         description:
 *           type: object
 *           description: Localized descriptions of the prompt's purpose
 *           additionalProperties:
 *             type: string
 *           example: { "en": "Quickly summarize a block of text", "de": "Einen Textabschnitt schnell zusammenfassen" }
 *         icon:
 *           type: string
 *           description: Icon identifier for UI display
 *           example: "sparkles"
 *         prompt:
 *           type: object
 *           description: Localized prompt templates with variable placeholders
 *           additionalProperties:
 *             type: string
 *           example: { "en": "Summarize the following text: [content]", "de": "Fasse den folgenden Text zusammen: [content]" }
 *         enabled:
 *           type: boolean
 *           description: Whether the prompt template is currently enabled
 *           default: true
 *           example: true
 *         outputSchema:
 *           type: object
 *           description: JSON schema for structured output validation
 *           example: { "type": "object", "properties": { "summary": { "type": "string" } } }
 *
 *     PromptOperation:
 *       type: object
 *       description: Result of a prompt template operation
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "Prompt updated successfully"
 *         prompt:
 *           $ref: '#/components/schemas/PromptTemplate'
 *           description: The affected prompt template (for single operations)
 *         enabled:
 *           type: boolean
 *           description: New enabled state (for toggle operations)
 *         ids:
 *           type: array
 *           description: List of affected prompt IDs (for batch operations)
 *           items:
 *             type: string
 *
 *     AppGeneratorPrompt:
 *       type: object
 *       description: App generator specific prompt with language selection
 *       properties:
 *         id:
 *           type: string
 *           description: Prompt template ID
 *           example: "app-generator"
 *         prompt:
 *           type: string
 *           description: Localized prompt text for the specified language
 *         language:
 *           type: string
 *           description: Language code used for localization
 *           example: "en"
 *
 *     CompletionRequest:
 *       type: object
 *       description: Request for AI completion using prompts
 *       required:
 *         - messages
 *       properties:
 *         model:
 *           type: string
 *           description: AI model ID to use (uses default if not specified)
 *           example: "gpt-4"
 *         messages:
 *           type: array
 *           description: Conversation messages for completion
 *           items:
 *             type: object
 *             properties:
 *               role:
 *                 type: string
 *                 enum: ["system", "user", "assistant"]
 *               content:
 *                 type: string
 *           example: [{ "role": "user", "content": "Hello, how are you?" }]
 *         temperature:
 *           type: number
 *           description: Sampling temperature (0.0 to 1.0)
 *           minimum: 0
 *           maximum: 1
 *           default: 0.7
 *           example: 0.7
 *         maxTokens:
 *           type: number
 *           description: Maximum tokens in the response
 *           default: 8192
 *           example: 4000
 *         responseFormat:
 *           type: string
 *           nullable: true
 *           description: Desired response format
 *           example: "json"
 *         responseSchema:
 *           type: object
 *           nullable: true
 *           description: JSON schema for structured responses
 *
 *     CompletionResponse:
 *       type: object
 *       description: AI completion response in OpenAI-compatible format
 *       properties:
 *         choices:
 *           type: array
 *           description: Generated completion choices
 *           items:
 *             type: object
 *             properties:
 *               message:
 *                 type: object
 *                 properties:
 *                   role:
 *                     type: string
 *                     example: "assistant"
 *                   content:
 *                     type: string
 *                     example: "Hello! I'm doing well, thank you for asking."
 *               finish_reason:
 *                 type: string
 *                 example: "stop"
 *               index:
 *                 type: number
 *                 example: 0
 *         model:
 *           type: string
 *           description: Model used for the completion
 *           example: "gpt-4"
 *         usage:
 *           type: object
 *           description: Token usage statistics
 *           properties:
 *             prompt_tokens:
 *               type: number
 *             completion_tokens:
 *               type: number
 *             total_tokens:
 *               type: number
 *
 *     AdminError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: "Failed to update prompt"
 *         details:
 *           type: string
 *           description: Additional error details
 */

export default function registerAdminPromptsRoutes(app) {
  /**
   * @swagger
   * /api/admin/prompts:
   *   get:
   *     summary: Get all prompt templates (admin view)
   *     description: |
   *       Retrieves all prompt templates in the system with complete configuration details.
   *       This admin endpoint provides access to all prompt properties including enabled/disabled status,
   *       output schemas, and internal configuration that regular users cannot see.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **ETag Support**: This endpoint supports HTTP ETag caching for efficient data transfer.
   *       Include 'If-None-Match' header with previously received ETag to get 304 Not Modified
   *       response when data hasn't changed.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: All prompt templates successfully retrieved
   *         headers:
   *           ETag:
   *             description: Cache validation header for prompts list
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/PromptTemplate'
   *             example:
   *               - id: "summarize"
   *                 category: "summarization"
   *                 name:
   *                   en: "Summarize Text"
   *                   de: "Text zusammenfassen"
   *                 description:
   *                   en: "Quickly summarize a block of text"
   *                   de: "Einen Textabschnitt schnell zusammenfassen"
   *                 icon: "sparkles"
   *                 prompt:
   *                   en: "Summarize the following text: [content]"
   *                   de: "Fasse den folgenden Text zusammen: [content]"
   *                 enabled: true
   *               - id: "app-generator"
   *                 category: "system"
   *                 name:
   *                   en: "App Generator"
   *                   de: "App-Generator"
   *                 description:
   *                   en: "Generate app configurations from user descriptions"
   *                 icon: "cog"
   *                 enabled: true
   *                 outputSchema:
   *                   type: "object"
   *                   properties:
   *                     id:
   *                       type: "string"
   *                     name:
   *                       type: "object"
   *       304:
   *         description: Not Modified - content hasn't changed (ETag match)
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to load prompts configuration"
   */
  app.get(buildServerPath('/api/admin/prompts'), adminAuth, async (req, res) => {
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
      logger.error('Error fetching all prompts:', error);
      res.status(500).json({ error: 'Failed to fetch prompts' });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts/{promptId}:
   *   get:
   *     summary: Get a specific prompt template by ID
   *     description: |
   *       Retrieves detailed information about a specific prompt template including all
   *       configuration properties, localized content, and administrative metadata.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: promptId
   *         required: true
   *         description: Unique identifier of the prompt template
   *         schema:
   *           type: string
   *         example: "summarize"
   *     responses:
   *       200:
   *         description: Prompt template successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PromptTemplate'
   *             example:
   *               id: "summarize"
   *               category: "summarization"
   *               name:
   *                 en: "Summarize Text"
   *                 de: "Text zusammenfassen"
   *               description:
   *                 en: "Quickly summarize a block of text"
   *                 de: "Einen Textabschnitt schnell zusammenfassen"
   *               icon: "sparkles"
   *               prompt:
   *                 en: "Summarize the following text: [content]"
   *                 de: "Fasse den folgenden Text zusammen: [content]"
   *               enabled: true
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       404:
   *         description: Prompt template not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Prompt not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to fetch prompt"
   */
  app.get(buildServerPath('/api/admin/prompts/:promptId'), adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;

      // Validate promptId for security
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }

      const { data: prompts } = configCache.getPrompts(true);
      const prompt = prompts.find(p => p.id === promptId);
      if (!prompt) {
        return res.status(404).json({ error: 'Prompt not found' });
      }
      res.json(prompt);
    } catch (error) {
      logger.error('Error fetching prompt:', error);
      res.status(500).json({ error: 'Failed to fetch prompt' });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts/{promptId}:
   *   put:
   *     summary: Update an existing prompt template
   *     description: |
   *       Updates an existing prompt template with new configuration data.
   *       The prompt ID cannot be changed during an update operation.
   *       All required fields must be present in the request body.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the prompt template file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: promptId
   *         required: true
   *         description: Unique identifier of the prompt template to update
   *         schema:
   *           type: string
   *         example: "summarize"
   *     requestBody:
   *       required: true
   *       description: Updated prompt template configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PromptTemplate'
   *           example:
   *             id: "summarize"
   *             category: "summarization"
   *             name:
   *               en: "Summarize Text"
   *               de: "Text zusammenfassen"
   *             description:
   *               en: "Quickly summarize a block of text with enhanced features"
   *               de: "Einen Textabschnitt schnell mit erweiterten Funktionen zusammenfassen"
   *             icon: "sparkles"
   *             prompt:
   *               en: "Provide a comprehensive summary of the following text: [content]"
   *               de: "Erstelle eine umfassende Zusammenfassung des folgenden Textes: [content]"
   *             enabled: true
   *     responses:
   *       200:
   *         description: Prompt template successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PromptOperation'
   *             example:
   *               message: "Prompt updated successfully"
   *               prompt:
   *                 id: "summarize"
   *                 category: "summarization"
   *                 name:
   *                   en: "Summarize Text"
   *                   de: "Text zusammenfassen"
   *                 enabled: true
   *       400:
   *         description: Bad request - missing required fields or invalid data
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             examples:
   *               missingFields:
   *                 summary: Missing required fields
   *                 value:
   *                   error: "Missing required fields"
   *               idMismatch:
   *                 summary: Prompt ID cannot be changed
   *                 value:
   *                   error: "Prompt ID cannot be changed"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to update prompt"
   */
  app.put(buildServerPath('/api/admin/prompts/:promptId'), adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;
      const updatedPrompt = req.body;

      // Validate promptId for security
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }

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
      logger.error('Error updating prompt:', error);
      res.status(500).json({ error: 'Failed to update prompt' });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts:
   *   post:
   *     summary: Create a new prompt template
   *     description: |
   *       Creates a new prompt template with the provided configuration.
   *       The prompt ID must be unique - creation will fail if a prompt with the same ID already exists.
   *       All required fields must be present in the request body.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation creates a new prompt template file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       description: New prompt template configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PromptTemplate'
   *           example:
   *             id: "translate"
   *             category: "translation"
   *             name:
   *               en: "Text Translation"
   *               de: "Text-Übersetzung"
   *             description:
   *               en: "Translate text between different languages"
   *               de: "Text zwischen verschiedenen Sprachen übersetzen"
   *             icon: "globe"
   *             prompt:
   *               en: "Translate the following text from {{source_lang}} to {{target_lang}}: [content]"
   *               de: "Übersetze den folgenden Text von {{source_lang}} zu {{target_lang}}: [content]"
   *             enabled: true
   *     responses:
   *       200:
   *         description: Prompt template successfully created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PromptOperation'
   *             example:
   *               message: "Prompt created successfully"
   *               prompt:
   *                 id: "translate"
   *                 category: "translation"
   *                 name:
   *                   en: "Text Translation"
   *                   de: "Text-Übersetzung"
   *                 enabled: true
   *       400:
   *         description: Bad request - missing required fields
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Missing required fields"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       409:
   *         description: Conflict - prompt with this ID already exists
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Prompt with this ID already exists"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to create prompt"
   */
  app.post(buildServerPath('/api/admin/prompts'), adminAuth, async (req, res) => {
    try {
      const newPrompt = req.body;
      if (!newPrompt.id || !newPrompt.name || !newPrompt.prompt) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate newPrompt.id for security
      if (!validateIdForPath(newPrompt.id, 'prompt', res)) {
        return;
      }

      const rootDir = getRootDir();
      const promptFilePath = join(rootDir, 'contents', 'prompts', `${newPrompt.id}.json`);
      try {
        readFileSync(promptFilePath, 'utf8');
        return res.status(409).json({ error: 'Prompt with this ID already exists' });
      } catch {
        // file not found
      }
      await fs.writeFile(promptFilePath, JSON.stringify(newPrompt, null, 2));
      await configCache.refreshPromptsCache();
      res.json({ message: 'Prompt created successfully', prompt: newPrompt });
    } catch (error) {
      logger.error('Error creating prompt:', error);
      res.status(500).json({ error: 'Failed to create prompt' });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts/{promptId}/toggle:
   *   post:
   *     summary: Toggle the enabled state of a prompt template
   *     description: |
   *       Toggles the enabled/disabled state of a specific prompt template.
   *       This operation flips the current state: enabled becomes disabled, and disabled becomes enabled.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the prompt template file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: promptId
   *         required: true
   *         description: Unique identifier of the prompt template to toggle
   *         schema:
   *           type: string
   *         example: "summarize"
   *     responses:
   *       200:
   *         description: Prompt template enabled state successfully toggled
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PromptOperation'
   *             example:
   *               message: "Prompt enabled successfully"
   *               prompt:
   *                 id: "summarize"
   *                 category: "summarization"
   *                 name:
   *                   en: "Summarize Text"
   *                   de: "Text zusammenfassen"
   *                 enabled: true
   *               enabled: true
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       404:
   *         description: Prompt template not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Prompt not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to toggle prompt"
   */
  app.post(buildServerPath('/api/admin/prompts/:promptId/toggle'), adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;

      // Validate promptId for security
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }

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
      logger.error('Error toggling prompt:', error);
      res.status(500).json({ error: 'Failed to toggle prompt' });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts/{promptIds}/_toggle:
   *   post:
   *     summary: Batch toggle enabled state of multiple prompt templates
   *     description: |
   *       Sets the enabled/disabled state for multiple prompt templates in a single operation.
   *       Unlike the single toggle endpoint, this sets all specified prompts to the same state
   *       rather than flipping their individual states.
   *
   *       **Batch Operations**: Use comma-separated prompt IDs or '*' for all prompts.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies multiple prompt template files on disk
   *       and refreshes the system cache once after all changes.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: promptIds
   *         required: true
   *         description: |
   *           Comma-separated list of prompt template IDs to toggle, or '*' for all prompts.
   *           Examples: 'summarize,translate' or '*'
   *         schema:
   *           type: string
   *         examples:
   *           specific:
   *             summary: Specific prompts
   *             value: "summarize,translate,app-generator"
   *           all:
   *             summary: All prompts
   *             value: "*"
   *     requestBody:
   *       required: true
   *       description: Desired enabled state for the specified prompts
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - enabled
   *             properties:
   *               enabled:
   *                 type: boolean
   *                 description: New enabled state for all specified prompts
   *           example:
   *             enabled: true
   *     responses:
   *       200:
   *         description: Prompt templates enabled state successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PromptOperation'
   *             examples:
   *               enabled:
   *                 summary: Prompts enabled
   *                 value:
   *                   message: "Prompts enabled successfully"
   *                   enabled: true
   *                   ids: ["summarize", "translate", "app-generator"]
   *               disabled:
   *                 summary: Prompts disabled
   *                 value:
   *                   message: "Prompts disabled successfully"
   *                   enabled: false
   *                   ids: ["summarize", "translate"]
   *       400:
   *         description: Bad request - missing enabled flag
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Missing enabled flag"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to toggle prompts"
   */
  app.post(
    buildServerPath('/api/admin/prompts/:promptIds/_toggle'),
    adminAuth,
    async (req, res) => {
      try {
        const { promptIds } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Missing enabled flag' });
        }

        // Validate promptIds for security
        const ids = validateIdsForPath(promptIds, 'prompt', res);
        if (!ids) {
          return;
        }

        const { data: prompts } = configCache.getPrompts(true);
        const resolvedIds = ids.includes('*') ? prompts.map(p => p.id) : ids;
        const rootDir = getRootDir();

        for (const id of resolvedIds) {
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
          ids: resolvedIds
        });
      } catch (error) {
        logger.error('Error toggling prompts:', error);
        res.status(500).json({ error: 'Failed to toggle prompts' });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/prompts/{promptId}:
   *   delete:
   *     summary: Delete a prompt template
   *     description: |
   *       Permanently deletes a prompt template from the system.
   *       This operation removes the prompt template file from disk and cannot be undone.
   *
   *       **Warning**: This is a destructive operation that permanently removes the prompt template.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation permanently deletes the prompt template file from disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: promptId
   *         required: true
   *         description: Unique identifier of the prompt template to delete
   *         schema:
   *           type: string
   *         example: "old-prompt"
   *     responses:
   *       200:
   *         description: Prompt template successfully deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   description: Deletion confirmation message
   *             example:
   *               message: "Prompt deleted successfully"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       404:
   *         description: Prompt template file not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Prompt file not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to delete prompt"
   */
  app.delete(buildServerPath('/api/admin/prompts/:promptId'), adminAuth, async (req, res) => {
    try {
      const { promptId } = req.params;

      // Validate promptId for security
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }

      const rootDir = getRootDir();
      const promptsDir = join(rootDir, 'contents', 'prompts');
      const candidatePath = join(promptsDir, `${promptId}.json`);
      const normalizedPromptsDir = resolve(promptsDir);
      const normalizedPromptFilePath = resolve(candidatePath);

      // Ensure the resolved path is within the prompts directory
      const relativePath = path.relative(normalizedPromptsDir, normalizedPromptFilePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !relativePath) {
        return res.status(400).json({ error: 'Invalid prompt path' });
      }

      if (!existsSync(normalizedPromptFilePath)) {
        return res.status(404).json({ error: 'Prompt file not found' });
      }
      await fs.unlink(normalizedPromptFilePath);
      await configCache.refreshPromptsCache();
      res.json({ message: 'Prompt deleted successfully' });
    } catch (error) {
      logger.error('Error deleting prompt:', error);
      res.status(500).json({ error: 'Failed to delete prompt' });
    }
  });

  /**
   * @swagger
   * /api/completions:
   *   post:
   *     summary: Generate AI completions for prompt testing
   *     description: |
   *       Generates AI completions using the specified model and messages.
   *       This endpoint is primarily used for testing prompt templates and generating
   *       responses in an OpenAI-compatible format.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **Model Selection**: If no model is specified, the default model from configuration is used.
   *       The model must be configured and have valid API credentials.
   *
   *       **Response Format**: Returns OpenAI-compatible completion response with usage statistics.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       description: Completion request parameters
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CompletionRequest'
   *           example:
   *             model: "gpt-4"
   *             messages:
   *               - role: "system"
   *                 content: "You are a helpful assistant."
   *               - role: "user"
   *                 content: "Hello, how are you?"
   *             temperature: 0.7
   *             maxTokens: 4000
   *     responses:
   *       200:
   *         description: Completion successfully generated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CompletionResponse'
   *             example:
   *               choices:
   *                 - message:
   *                     role: "assistant"
   *                     content: "Hello! I'm doing well, thank you for asking. How can I help you today?"
   *                   finish_reason: "stop"
   *                   index: 0
   *               model: "gpt-4"
   *               usage:
   *                 prompt_tokens: 15
   *                 completion_tokens: 20
   *                 total_tokens: 35
   *       400:
   *         description: Bad request - invalid parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             examples:
   *               missingMessages:
   *                 summary: Missing messages
   *                 value:
   *                   error: "Missing required field: messages"
   *               noModel:
   *                 summary: No model specified or configured
   *                 value:
   *                   error: "No model specified and no default model configured"
   *               modelNotFound:
   *                 summary: Model not found
   *                 value:
   *                   error: "Model not found: invalid-model-id"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       500:
   *         description: Internal server error or model API failure
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to generate completion"
   *               details: "API rate limit exceeded"
   */
  app.post(buildServerPath('/api/completions'), adminAuth, async (req, res) => {
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
        maxTokens: maxTokens,
        apiKey: apiKey
      });
      logger.info('Completion result:', JSON.stringify(result, null, 2));
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
      logger.error('Error in completions endpoint:', error);
      const { getLocalizedError } = await import('../../serverHelpers.js');
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      let errorMessage = 'Failed to generate completion';
      try {
        errorMessage = await getLocalizedError('internalError', {}, defaultLang);
      } catch (localizationError) {
        logger.warn('Failed to get localized error message:', localizationError);
      }
      res.status(500).json({ error: errorMessage, details: error.message });
    }
  });

  /**
   * @swagger
   * /api/admin/prompts/app-generator:
   *   get:
   *     summary: Get the app generator prompt template for a specific language
   *     description: |
   *       Retrieves the app generator prompt template localized for the specified language.
   *       This special endpoint provides access to the app generation prompt used by the
   *       iHub Apps platform to create new application configurations.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **Language Fallback**: If the requested language is not available, falls back to the default platform language.
   *
   *       **Special Purpose**: This endpoint is specifically designed for the app generator functionality
   *       and returns the prompt text rather than the full configuration object.
   *     tags:
   *       - Admin - Prompts
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: query
   *         name: lang
   *         required: false
   *         description: Language code for localization (defaults to platform default language)
   *         schema:
   *           type: string
   *         example: "en"
   *     responses:
   *       200:
   *         description: App generator prompt successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppGeneratorPrompt'
   *             example:
   *               id: "app-generator"
   *               prompt: "You are an expert in the iHub Apps platform. Your job is to help users create complete and valid JSON configurations..."
   *               language: "en"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       404:
   *         description: App-generator prompt not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "App-generator prompt not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             examples:
   *               configError:
   *                 summary: Configuration load error
   *                 value:
   *                   error: "Failed to load prompts configuration"
   *               internalError:
   *                 summary: General internal error
   *                 value:
   *                   error: "Internal server error"
   */
  app.get(buildServerPath('/api/admin/prompts/app-generator'), adminAuth, async (req, res) => {
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
      logger.error('Error fetching app-generator prompt:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
