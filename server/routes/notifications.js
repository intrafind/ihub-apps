/**
 * Per-user real-time notification center (v1).
 *
 * GET  /api/notifications/stream    — SSE push channel, multi-tab per user
 * GET  /api/notifications           — list persisted notifications
 * POST /api/notifications/:id/read  — mark one notification read
 * POST /api/notifications/read-all  — mark all notifications read
 *
 * Gated behind the 'notifications' preview feature flag (default off).
 */
import express from 'express';
import { authRequired } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { buildApiPath } from '../utils/basePath.js';
import notificationService from '../services/notifications/NotificationService.js';
import {
  listNotifications,
  countUnread,
  markRead,
  markAllRead
} from '../services/notifications/NotificationStore.js';
import { sendNotFound } from '../utils/responseHelpers.js';
import logger from '../utils/logger.js';

const router = express.Router();

// userId -> Set<res>. A user can have multiple open tabs, unlike the
// single-pinned-entry shape createSseChannel (utils/sseChannel.js) assumes.
const clientsByUser = new Map();

// One shared listener fans out to whichever user's client set matches,
// rather than attaching a new NotificationService listener per connection.
notificationService.on('notification', notification => {
  const clients = clientsByUser.get(notification.userId);
  if (!clients || clients.size === 0) return;
  const message = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
  for (const res of clients) {
    try {
      res.write(message);
    } catch (error) {
      logger.warn('Failed to write notification to SSE client', {
        component: 'notificationsRoutes',
        error: error.message
      });
    }
  }
});

router.get('/stream', authRequired, requireFeature('notifications'), (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  let clients = clientsByUser.get(userId);
  if (!clients) {
    clients = new Set();
    clientsByUser.set(userId, clients);
  }
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = clientsByUser.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clientsByUser.delete(userId);
    }
  });
});

router.get('/', authRequired, requireFeature('notifications'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const unreadOnly = req.query.unreadOnly === 'true';

  const [notifications, unreadCount] = await Promise.all([
    listNotifications(userId, { limit, unreadOnly }),
    countUnread(userId)
  ]);
  res.json({ notifications, unreadCount });
});

router.post('/:id/read', authRequired, requireFeature('notifications'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const changed = await markRead(userId, req.params.id);
  if (!changed) return sendNotFound(res, 'Notification');
  res.json({ success: true });
});

router.post('/read-all', authRequired, requireFeature('notifications'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const changed = await markAllRead(userId);
  res.json({ success: true, changed });
});

export default function registerNotificationRoutes(app) {
  app.use(buildApiPath('/notifications'), router);
}
