import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { authOptional } from '../middleware/authRequired.js';
import { parseResourceUri, generateCSPHeader } from '../validators/mcpAppSchema.js';
import { processMessage, rateLimiter } from '../utils/mcpAppBridge.js';
import { loadTools } from '../toolLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Get MCP App directory path
 */
function getMcpAppDir() {
  // MCP Apps are stored in server/mcp-apps/{toolId}/{resource}
  return path.join(__dirname, '..', 'mcp-apps');
}

/**
 * Find tool by resource URI
 * @param {string} resourceUri - UI resource URI
 * @returns {Promise<object|null>} - Tool configuration or null
 */
async function findToolByResourceUri(resourceUri) {
  try {
    const tools = await loadTools();
    return tools.find(tool => tool._meta?.ui?.resourceUri === resourceUri) || null;
  } catch (error) {
    console.error('Error finding tool by resource URI:', error);
    return null;
  }
}

/**
 * @swagger
 * /api/mcp/resources/{resourceUri}:
 *   get:
 *     tags: [MCP Apps]
 *     summary: Serve MCP App UI resource
 *     description: Serves HTML, JavaScript, and CSS files for MCP Apps
 *     parameters:
 *       - in: path
 *         name: resourceUri
 *         required: true
 *         schema:
 *           type: string
 *         description: Resource URI (e.g., ui://tool-id/app.html)
 *     responses:
 *       200:
 *         description: UI resource content
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Resource not found
 *       500:
 *         description: Server error
 */
router.get('/resources/:resourceUri(*)', authOptional, async (req, res) => {
  try {
    const resourceUri = `ui://${req.params.resourceUri}`;
    
    // Parse resource URI
    let parsedUri;
    try {
      parsedUri = parseResourceUri(resourceUri);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid resource URI format' });
    }

    const { toolId, resourcePath } = parsedUri;

    // Find tool configuration
    const tool = await findToolByResourceUri(resourceUri);
    if (!tool) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    // Build file path
    const mcpAppDir = getMcpAppDir();
    const filePath = path.join(mcpAppDir, toolId, resourcePath);

    // Security: Prevent directory traversal
    const resolvedPath = path.resolve(filePath);
    const resolvedMcpAppDir = path.resolve(mcpAppDir);
    if (!resolvedPath.startsWith(resolvedMcpAppDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Resource file not found' });
    }

    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');

    // Set appropriate content type
    const ext = path.extname(resourcePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    };
    const contentType = contentTypes[ext] || 'text/plain';

    // Apply CSP headers if configured
    if (tool._meta?.ui?.csp) {
      const cspHeader = generateCSPHeader(tool._meta.ui.csp);
      res.setHeader('Content-Security-Policy', cspHeader);
    } else {
      // Default secure CSP
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';"
      );
    }

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    res.setHeader('Content-Type', contentType);
    res.send(content);
  } catch (error) {
    console.error('Error serving MCP App resource:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/mcp/messages:
 *   post:
 *     tags: [MCP Apps]
 *     summary: Process JSON-RPC messages from MCP Apps
 *     description: Handles tool calls and other requests from MCP Apps
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jsonrpc
 *               - method
 *             properties:
 *               jsonrpc:
 *                 type: string
 *                 example: "2.0"
 *               id:
 *                 oneOf:
 *                   - type: string
 *                   - type: number
 *               method:
 *                 type: string
 *                 example: "tools/call"
 *               params:
 *                 type: object
 *     responses:
 *       200:
 *         description: JSON-RPC response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid request
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/messages', authOptional, async (req, res) => {
  try {
    const message = req.body;
    const appId = req.headers['x-app-id'] || 'unknown';

    // Rate limiting
    if (!rateLimiter.isAllowed(appId)) {
      return res.status(429).json({
        jsonrpc: '2.0',
        id: message.id || null,
        error: {
          code: -32000,
          message: 'Rate limit exceeded'
        }
      });
    }

    // Build context from request
    const context = {
      user: req.user,
      chatId: req.headers['x-chat-id'] || null,
      appId
    };

    // Process message
    const response = await processMessage(message, context);

    // If null (notification), return 204 No Content
    if (response === null) {
      return res.status(204).end();
    }

    res.json(response);
  } catch (error) {
    console.error('Error processing MCP App message:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message
      }
    });
  }
});

/**
 * @swagger
 * /api/mcp/health:
 *   get:
 *     tags: [MCP Apps]
 *     summary: Health check for MCP Apps system
 *     responses:
 *       200:
 *         description: System is healthy
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MCP Apps',
    timestamp: new Date().toISOString()
  });
});

export default router;
