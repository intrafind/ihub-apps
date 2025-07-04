import registerSessionRoutes from './sessionRoutes.js';
import registerFeedbackRoutes from './feedbackRoutes.js';
import registerDataRoutes from './dataRoutes.js';
import registerAttachmentRoutes from './attachmentRoutes.js';

export default function registerChatRoutes(app, deps) {
  registerSessionRoutes(app, deps);
  registerFeedbackRoutes(app, deps);
  registerDataRoutes(app);
  registerAttachmentRoutes(app);
}
