import { getJsonSchemaByType, getAllJsonSchemas } from '../../utils/schemaExport.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { sendFailedOperationError } from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';

/**
 * @swagger
 * /api/admin/schemas:
 *   get:
 *     summary: Get all available JSON schemas
 *     description: Retrieve all JSON schemas converted from server-side Zod schemas
 *     tags: [Admin - Schemas]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successfully retrieved all schemas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 app:
 *                   type: object
 *                   description: App configuration JSON schema
 *                 model:
 *                   type: object
 *                   description: Model configuration JSON schema
 *                 prompt:
 *                   type: object
 *                   description: Prompt configuration JSON schema
 *                 group:
 *                   type: object
 *                   description: Group configuration JSON schema
 *                 platform:
 *                   type: object
 *                   description: Platform configuration JSON schema
 *                 user:
 *                   type: object
 *                   description: User configuration JSON schema
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions
 *       500:
 *         description: Internal server error
 */
export default function registerAdminSchemasRoutes(app) {
  app.get(buildServerPath('/api/admin/schemas'), adminAuth, async (req, res) => {
    try {
      const schemas = getAllJsonSchemas();
      res.json(schemas);
    } catch (error) {
      sendFailedOperationError(res, 'retrieve schemas', error);
    }
  });

  /**
   * @swagger
   * /api/admin/schemas/{type}:
   *   get:
   *     summary: Get JSON schema by type
   *     description: Retrieve a specific JSON schema converted from server-side Zod schema
   *     tags: [Admin - Schemas]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [app, model, prompt, group, platform, user]
   *         description: Type of schema to retrieve
   *     responses:
   *       200:
   *         description: Successfully retrieved schema
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: JSON Schema object
   *       400:
   *         description: Bad request - Invalid schema type
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *       403:
   *         description: Forbidden - Insufficient permissions
   *       404:
   *         description: Schema type not found
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/schemas/:type'), adminAuth, async (req, res) => {
    try {
      const { type } = req.params;

      const allowedTypes = ['app', 'model', 'prompt', 'group', 'platform', 'user'];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({
          error: 'Invalid schema type',
          message: `Schema type must be one of: ${allowedTypes.join(', ')}`
        });
      }

      const schema = getJsonSchemaByType(type);
      if (!schema) {
        return res.status(404).json({
          error: 'Schema not found',
          message: `No schema found for type: ${type}`
        });
      }

      res.json(schema);
    } catch (error) {
      sendFailedOperationError(res, 'retrieve schema', error);
    }
  });
}
