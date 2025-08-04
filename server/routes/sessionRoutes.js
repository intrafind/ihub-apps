import { logNewSession } from '../utils.js';
import { authOptional } from '../middleware/authRequired.js';
import validate from '../validators/validate.js';
import { startSessionSchema } from '../validators/index.js';

export default function registerSessionRoutes(app) {
  /**
   * @swagger
   * /session/start:
   *   post:
   *     summary: Start a new session
   *     description: Initializes a new user session with optional metadata
   *     tags:
   *       - Sessions
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - sessionId
   *             properties:
   *               sessionId:
   *                 type: string
   *                 description: Unique session identifier
   *               type:
   *                 type: string
   *                 default: "app_loaded"
   *                 description: Session type
   *               metadata:
   *                 type: object
   *                 description: Additional session metadata
   *                 properties:
   *                   userAgent:
   *                     type: string
   *                   language:
   *                     type: string
   *                   referrer:
   *                     type: string
   *     responses:
   *       200:
   *         description: Session started successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *       400:
   *         description: Bad request (missing session ID)
   *       500:
   *         description: Internal server error
   */
  app.post('/api/session/start', authOptional, validate(startSessionSchema), async (req, res) => {
    try {
      const { sessionId, type, metadata } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }
      const enrichedMetadata = {
        ...metadata,
        userAgent: req.headers['user-agent'] || metadata?.userAgent || 'unknown',
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        language:
          req.headers['accept-language'] ||
          metadata?.language ||
          configCache.getPlatform()?.defaultLanguage ||
          'en',
        referrer: req.headers['referer'] || metadata?.referrer || 'direct'
      };
      console.log(
        `[APP LOADED] New session started: ${sessionId} | IP: ${enrichedMetadata.ipAddress.split(':').pop()}`
      );
      await logNewSession(sessionId, type || 'app_loaded', enrichedMetadata);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error logging session start:', error);
      res.status(500).json({ error: 'Failed to log session start' });
    }
  });
}
