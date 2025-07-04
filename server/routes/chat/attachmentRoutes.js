import path from 'path';
import fs from 'fs/promises';
import { getRootDir } from '../../pathUtils.js';

export default function registerAttachmentRoutes(app) {
  app.get('/api/chat/:chatId/tools/:toolId/attachments/:attachmentId', async (req, res) => {
    const { chatId, toolId, attachmentId } = req.params;
    if (!/^[A-Za-z0-9_-]+$/.test(chatId) || !/^[A-Za-z0-9_-]+$/.test(toolId) || !/^[A-Za-z0-9._-]+$/.test(attachmentId)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
    const dataDir = process.env.DATA_DIR || 'data';
    const filePath = path.join(getRootDir(), dataDir, 'chats', chatId, 'tools', toolId, attachmentId);
    try {
      await fs.access(filePath);
      return res.sendFile(filePath);
    } catch {
      return res.status(404).json({ error: 'Attachment not found' });
    }
  });
}
