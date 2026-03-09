import configCache from '../../configCache.js';
import { logInteraction } from '../../utils.js';
import { recordFeedback } from '../../usageTracker.js';
import { storeFeedback } from '../../feedbackStorage.js';
import { authRequired } from '../../middleware/authRequired.js';
import validate from '../../validators/validate.js';
import { feedbackSchema } from '../../validators/index.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';

export default function registerFeedbackRoutes(app, { getLocalizedError }) {
  /**
   * @swagger
   * /feedback:
   *   post:
   *     summary: Submit message feedback
   *     description: |
   *       Records user feedback (thumbs up/down or star rating) for a specific AI
   *       response. Feedback is stored and used for usage tracking and analytics.
   *     tags:
   *       - Chat
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
   *               - messageId
   *               - appId
   *               - chatId
   *               - rating
   *             properties:
   *               messageId:
   *                 type: string
   *                 description: ID of the message being rated
   *                 example: "msg-abc123"
   *               appId:
   *                 type: string
   *                 description: ID of the app the message belongs to
   *                 example: "my-assistant"
   *               chatId:
   *                 type: string
   *                 description: ID of the chat session
   *                 example: "550e8400-e29b-41d4-a716-446655440000"
   *               messageContent:
   *                 type: string
   *                 description: Snippet of the rated message content (optional)
   *                 example: "Paris is the capital of France."
   *               rating:
   *                 type: number
   *                 minimum: 0.5
   *                 maximum: 5
   *                 multipleOf: 0.5
   *                 description: Numeric rating in 0.5 increments (0.5–5.0)
   *                 example: 4.5
   *               feedback:
   *                 type: string
   *                 description: Optional free-text comment
   *                 example: "Very helpful and concise!"
   *               modelId:
   *                 type: string
   *                 description: ID of the model that generated the response
   *                 example: "gpt-4o"
   *     responses:
   *       200:
   *         description: Feedback recorded successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *       400:
   *         description: Missing required fields
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/feedback'),
    authRequired,
    validate(feedbackSchema),
    async (req, res) => {
      try {
        const { messageId, appId, chatId, messageContent, rating, feedback, modelId } = req.body;
        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        const language = req.headers['accept-language']?.split(',')[0] || defaultLang;
        if (!messageId || !rating || !appId || !chatId) {
          const errorMessage = await getLocalizedError('missingFeedbackFields', {}, language);
          return sendBadRequest(res, errorMessage);
        }
        const userSessionId = req.headers['x-session-id'];
        await logInteraction('feedback', {
          messageId,
          appId,
          modelId,
          sessionId: chatId,
          userSessionId,
          user: req.user,
          responseType: 'feedback',
          feedback: {
            messageId,
            rating,
            comment: feedback || '',
            contentSnippet: messageContent ? messageContent.substring(0, 300) : ''
          }
        });
        storeFeedback({
          messageId,
          appId,
          chatId,
          modelId,
          rating,
          comment: feedback || '',
          contentSnippet: messageContent ? messageContent.substring(0, 300) : ''
        });
        await recordFeedback({
          userId: userSessionId,
          appId,
          modelId,
          rating,
          user: req.user
        });
        logger.info(`Feedback received for message ${messageId} in chat ${chatId}: ${rating}`);
        return res.status(200).json({ success: true });
      } catch (error) {
        return sendInternalError(res, error, 'processing feedback');
      }
    }
  );
}
