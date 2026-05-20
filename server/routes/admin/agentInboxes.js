import { adminAuth } from '../../middleware/adminAuth.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import inboxStore from '../../agents/inbox/inboxStore.js';
import { INBOX_ID_PATTERN } from '../../validators/agentInboxSchema.js';
import logger from '../../utils/logger.js';

function validInboxId(id) {
  return typeof id === 'string' && INBOX_ID_PATTERN.test(id);
}

export default function registerAdminAgentInboxesRoutes(app) {
  app.get(buildServerPath('/api/admin/agents/inboxes'), adminAuth, async (req, res) => {
    try {
      const inboxes = await inboxStore.listInboxes();
      res.json(inboxes);
    } catch (error) {
      sendFailedOperationError(res, 'list inboxes', error);
    }
  });

  app.get(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    try {
      const { inboxId } = req.params;
      if (!validInboxId(inboxId)) return sendBadRequest(res, 'Invalid inbox id');
      try {
        const inbox = await inboxStore.readInbox(inboxId, { status: 'all' });
        res.json(inbox);
      } catch (err) {
        if (err.code === 'ENOENT') return sendNotFound(res, `Inbox ${inboxId} not found`);
        throw err;
      }
    } catch (error) {
      sendFailedOperationError(res, 'read inbox', error);
    }
  });

  app.put(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    try {
      const { inboxId } = req.params;
      if (!validInboxId(inboxId)) return sendBadRequest(res, 'Invalid inbox id');
      const { body, expectedVersion } = req.body || {};
      if (typeof body !== 'string') return sendBadRequest(res, 'body is required');
      const result = await inboxStore.writeInbox(inboxId, {
        body,
        expectedVersion,
        updatedBy: req.user?.id || 'admin'
      });
      res.json({ ok: true, version: result.version });
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') {
        return res
          .status(409)
          .json({
            error: 'VERSION_CONFLICT',
            message: error.message,
            currentVersion: error.currentVersion
          });
      }
      sendFailedOperationError(res, 'write inbox', error);
    }
  });

  app.post(
    buildServerPath('/api/admin/agents/inboxes/:inboxId/items'),
    adminAuth,
    async (req, res) => {
      try {
        const { inboxId } = req.params;
        if (!validInboxId(inboxId)) return sendBadRequest(res, 'Invalid inbox id');
        const { text, priority } = req.body || {};
        if (!text) return sendBadRequest(res, 'text is required');
        const result = await inboxStore.addInboxItem(inboxId, {
          text,
          priority,
          updatedBy: req.user?.id || 'admin'
        });
        logger.info('Added inbox item', {
          component: 'AdminAgentInboxes',
          inboxId,
          actor: req.user?.id
        });
        res.json({ ok: true, version: result.version });
      } catch (error) {
        sendFailedOperationError(res, 'add inbox item', error);
      }
    }
  );

  app.post(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    try {
      const { inboxId } = req.params;
      if (!validInboxId(inboxId)) return sendBadRequest(res, 'Invalid inbox id');
      const { body } = req.body || {};
      const result = await inboxStore.writeInbox(inboxId, {
        body: body || `# ${inboxId}\n`,
        updatedBy: req.user?.id || 'admin'
      });
      res.status(201).json({ ok: true, version: result.version });
    } catch (error) {
      sendFailedOperationError(res, 'create inbox', error);
    }
  });
}
