// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin reads of evidence records (#3687, `docs/chat-evidence.md`).
 *
 * The owner reads a chat's evidence through `/api/chats/...` and a run's
 * through `/api/runs/...`; an admin reads anybody's here. Every read is
 * written to the audit log.
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { logAudit } from '../../services/AuditLogService.js';
import {
  readEvidenceContent,
  readEvidenceRecord,
  sendEvidence
} from '../../services/chat/evidenceRecord.js';

/**
 * Audit one admin read.
 *
 * @param {import('express').Request} req
 * @param {'chatEvidence'|'runEvidence'} resource
 * @param {string} resourceId
 * @param {string} summary
 */
function audit(req, resource, resourceId, summary) {
  logAudit({ req, action: 'read', resource, resourceId, summary });
}

export default function registerAdminEvidenceRoutes(app) {
  /**
   * @swagger
   * /api/admin/chats/{chatId}/evidence/{messageId}:
   *   get:
   *     summary: The evidence record of any answer (admin)
   *     description: Same body as the owner's endpoint. The read is written to the audit log.
   *     tags: [Admin]
   *     parameters:
   *       - { in: path, name: chatId, required: true, schema: { type: string } }
   *       - { in: path, name: messageId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: The evidence record }
   *       404: { description: No record, or switched off (EVIDENCE_NOT_RECORDED) }
   */
  app.get(
    buildServerPath('/api/admin/chats/:chatId/evidence/:messageId'),
    adminAuth,
    async (req, res) => {
      const { chatId, messageId } = req.params;
      assertValidId(chatId, 'chat');
      assertValidId(messageId, 'message');
      const doc = await readEvidenceRecord({ kind: 'chat', id: chatId, messageId });
      audit(
        req,
        'chatEvidence',
        `${chatId}/${messageId}`,
        `Read the evidence of an answer in chat ${chatId}`
      );
      sendEvidence(res, doc);
    }
  );

  /**
   * @swagger
   * /api/admin/chats/{chatId}/evidence/{messageId}/content/{sha256}:
   *   get:
   *     summary: One piece of content an answer's evidence record names (admin)
   *     tags: [Admin]
   *     parameters:
   *       - { in: path, name: chatId, required: true, schema: { type: string } }
   *       - { in: path, name: messageId, required: true, schema: { type: string } }
   *       - { in: path, name: sha256, required: true, schema: { type: string, pattern: '^[a-f0-9]{64}$' } }
   *     responses:
   *       200: { description: The content, application/json }
   *       400: { description: Not a lower-case hex SHA-256 (BAD_REQUEST) }
   *       404: { description: No such content, or switched off (EVIDENCE_NOT_RECORDED) }
   */
  app.get(
    buildServerPath('/api/admin/chats/:chatId/evidence/:messageId/content/:sha256'),
    adminAuth,
    async (req, res) => {
      const { chatId, messageId, sha256 } = req.params;
      assertValidId(chatId, 'chat');
      assertValidId(messageId, 'message');
      const content = await readEvidenceContent({ kind: 'chat', id: chatId, messageId, sha256 });
      audit(
        req,
        'chatEvidence',
        `${chatId}/${messageId}/${sha256}`,
        `Read evidence content of an answer in chat ${chatId}`
      );
      sendEvidence(res, content);
    }
  );

  /**
   * @swagger
   * /api/admin/runs/{runId}/evidence:
   *   get:
   *     summary: The evidence record of any run without a chat (admin)
   *     tags: [Admin]
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: The evidence record }
   *       404: { description: No record, or switched off (EVIDENCE_NOT_RECORDED) }
   */
  app.get(buildServerPath('/api/admin/runs/:runId/evidence'), adminAuth, async (req, res) => {
    const { runId } = req.params;
    assertValidId(runId, 'run');
    const doc = await readEvidenceRecord({ kind: 'run', id: runId });
    audit(req, 'runEvidence', runId, `Read the evidence of run ${runId}`);
    sendEvidence(res, doc);
  });

  /**
   * @swagger
   * /api/admin/runs/{runId}/evidence/content/{sha256}:
   *   get:
   *     summary: One piece of a run's evidence content (admin)
   *     tags: [Admin]
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *       - { in: path, name: sha256, required: true, schema: { type: string, pattern: '^[a-f0-9]{64}$' } }
   *     responses:
   *       200: { description: The content, application/json }
   *       400: { description: Not a lower-case hex SHA-256 (BAD_REQUEST) }
   *       404: { description: No such content, or switched off (EVIDENCE_NOT_RECORDED) }
   */
  app.get(
    buildServerPath('/api/admin/runs/:runId/evidence/content/:sha256'),
    adminAuth,
    async (req, res) => {
      const { runId, sha256 } = req.params;
      assertValidId(runId, 'run');
      const content = await readEvidenceContent({ kind: 'run', id: runId, sha256 });
      audit(req, 'runEvidence', `${runId}/${sha256}`, `Read evidence content of run ${runId}`);
      sendEvidence(res, content);
    }
  );
}
