import { getAttachmentPath } from '../../services/imageService.js';

export default function registerAttachmentRoutes(app) {
  app.get('/api/apps/:appId/chat/:chatId/attachments/:attachmentId', async (req, res) => {
    try {
      const { chatId, attachmentId } = req.params;
      const filePath = getAttachmentPath(chatId, attachmentId);
      res.sendFile(filePath, err => {
        if (err) res.status(404).json({ error: 'Attachment not found' });
      });
    } catch (err) {
      console.error('Attachment error', err);
      res.status(500).json({ error: 'Failed to fetch attachment' });
    }
  });
}
