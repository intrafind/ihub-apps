import configCache from '../../configCache.js';
import { logInteraction } from '../../utils.js';
import { recordFeedback } from '../../usageTracker.js';
import { storeFeedback } from '../../feedbackStorage.js';
import validate from '../../validators/validate.js';
import { feedbackSchema } from '../../validators/index.js';

export default function registerFeedbackRoutes(app, { getLocalizedError }) {
  app.post('/api/feedback', validate(feedbackSchema), async (req, res) => {
    try {
      const { messageId, appId, chatId, messageContent, rating, feedback, modelId } = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;
      if (!messageId || !rating || !appId || !chatId) {
        const errorMessage = await getLocalizedError('missingFeedbackFields', {}, language);
        return res.status(400).json({ error: errorMessage });
      }
      const userSessionId = req.headers['x-session-id'];
      await logInteraction('feedback', {
        messageId,
        appId,
        modelId,
        sessionId: chatId,
        userSessionId,
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
        rating: rating === 'positive' ? 'positive' : 'negative'
      });
      console.log(`Feedback received for message ${messageId} in chat ${chatId}: ${rating}`);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error processing feedback:', error);
      return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });
}
