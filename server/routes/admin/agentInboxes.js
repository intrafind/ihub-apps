// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { buildServerPath } from '../../utils/basePath.js';
import inboxStore from '../../agents/inbox/inboxStore.js';
import { INBOX_ID_PATTERN } from '../../validators/agentInboxSchema.js';
import logger from '../../utils/logger.js';

/**
 * Reject an inbox id that is not of the allowed shape.
 *
 * @param {unknown} id - Inbox id from the path
 * @throws {ServiceError} `BAD_REQUEST` when the id is not a string matching `INBOX_ID_PATTERN`
 */
function assertValidInboxId(id) {
  if (typeof id !== 'string' || !INBOX_ID_PATTERN.test(id)) {
    throw new ServiceError('BAD_REQUEST', 'Invalid inbox id');
  }
}

export default function registerAdminAgentInboxesRoutes(app) {
  app.get(buildServerPath('/api/admin/agents/inboxes'), adminAuth, async (req, res) => {
    const inboxes = await inboxStore.listInboxes();
    res.json(inboxes);
  });

  app.get(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    const { inboxId } = req.params;
    assertValidInboxId(inboxId);
    try {
      const inbox = await inboxStore.readInbox(inboxId, { status: 'all' });
      res.json(inbox);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ServiceError('NOT_FOUND', `Inbox ${inboxId} not found`, { cause: err });
      }
      throw err;
    }
  });

  app.put(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    const { inboxId } = req.params;
    assertValidInboxId(inboxId);
    const { body, expectedVersion } = req.body || {};
    if (typeof body !== 'string') throw new ServiceError('BAD_REQUEST', 'body is required');
    // A stale `expectedVersion` surfaces as the store's `VERSION_CONFLICT` (409).
    const result = await inboxStore.writeInbox(inboxId, {
      body,
      expectedVersion,
      updatedBy: req.user?.id || 'admin'
    });
    // api-guidelines-ignore: existing success body, changed in its own API change
    res.json({ ok: true, version: result.version });
  });

  app.post(
    buildServerPath('/api/admin/agents/inboxes/:inboxId/items'),
    adminAuth,
    async (req, res) => {
      const { inboxId } = req.params;
      assertValidInboxId(inboxId);
      const { text, priority } = req.body || {};
      if (!text) throw new ServiceError('BAD_REQUEST', 'text is required');
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
      // api-guidelines-ignore: existing success body, changed in its own API change
      res.json({ ok: true, version: result.version });
    }
  );

  app.post(buildServerPath('/api/admin/agents/inboxes/:inboxId'), adminAuth, async (req, res) => {
    const { inboxId } = req.params;
    assertValidInboxId(inboxId);
    const { body } = req.body || {};
    const result = await inboxStore.writeInbox(inboxId, {
      body: body || `# ${inboxId}\n`,
      updatedBy: req.user?.id || 'admin'
    });
    // api-guidelines-ignore: existing success body, changed in its own API change
    res.status(201).json({ ok: true, version: result.version });
  });
}
