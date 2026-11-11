// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin API of the text watermark keys (#3331).
 *
 * A key value leaves this API in exactly two responses: the one that created
 * it and an explicit `_reveal`. Lists never carry it, and no audit entry, log
 * line or error ever does. Reveal is audited *before* the key is returned and
 * fails closed when the audit write fails.
 *
 * @module routes/admin/watermarkKeys
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { sendCreated, segment } from '../../utils/created.js';
import { logAudit } from '../../services/AuditLogService.js';
import {
  buildVllmConfigSnippet,
  getWatermarkKeyStore
} from '../../services/provenance/watermark/WatermarkKeyStore.js';

const RESOURCE = 'watermarkKey';

function actorOf(req) {
  return req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';
}

/** Keys travel as decimal strings so a browser never loses precision. */
function withKey(item, key, extra = {}) {
  const value = String(key);
  return { ...item, key: value, vllmConfigSnippet: buildVllmConfigSnippet(value), ...extra };
}

export default function registerAdminWatermarkKeyRoutes(app) {
  const store = () => getWatermarkKeyStore();
  const base = '/api/admin/eu-ai-act/watermark-keys';

  /**
   * @swagger
   * /api/admin/eu-ai-act/watermark-keys:
   *   get:
   *     summary: List the text watermark keys (never their values)
   *     tags: [Admin - Watermark]
   *     responses:
   *       200:
   *         description: "`{ items: [{ keyId, status: active|retired, source, label?, createdAt, createdBy?, retiredAt? }], nextCursor: null }`"
   *   post:
   *     summary: Generate or enter a key and make it active
   *     description: >-
   *       Without a body key a random one is generated. The previous active key becomes
   *       retired (detection only). The value is returned once, with the vLLM
   *       `--watermark-config` snippet; vLLM must be restarted with it.
   *     tags: [Admin - Watermark]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               key: { type: string, description: Decimal string, 1 to 9007199254740991 }
   *               label: { type: string, maxLength: 100 }
   *     responses:
   *       201: { description: "Item plus `key` (string), `vllmConfigSnippet`, `weakKey?`" }
   *       400: { description: Invalid key }
   *       409: { description: Key value already stored }
   */
  app.get(buildServerPath(base), adminAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: await store().list(), nextCursor: null });
  });

  app.post(buildServerPath(base), adminAuth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const created = await store().create({ key: body.key, label: body.label }, actorOf(req));
      // The audit entry names the id and the previous key, never a value.
      await logAudit({
        req,
        action: 'create',
        resource: RESOURCE,
        resourceId: created.item.keyId,
        summary: `Created watermark key ${created.item.keyId}`,
        details: { source: created.item.source, previousActiveKeyId: created.previousActiveKeyId }
      });
      res.setHeader('Cache-Control', 'no-store');
      sendCreated(
        res,
        `${base}/${segment(created.item.keyId)}`,
        withKey(created.item, created.key, created.weakKey ? { weakKey: true } : {})
      );
    } catch (error) {
      await logAudit({
        req,
        action: 'create',
        resource: RESOURCE,
        result: 'failure',
        summary: 'Creating a watermark key failed',
        details: { code: error?.code }
      });
      throw error;
    }
  });

  /**
   * @swagger
   * /api/admin/eu-ai-act/watermark-keys/{keyId}/_activate:
   *   post:
   *     summary: Make a retired key active again (rollback)
   *     tags: [Admin - Watermark]
   *     responses:
   *       200: { description: "The item. Already active: 200 with the item and no change." }
   *       404: { description: Unknown key }
   */
  app.post(buildServerPath(`${base}/:keyId/_activate`), adminAuth, async (req, res) => {
    const { keyId } = req.params;
    assertValidId(keyId, 'watermark key');
    const { item, previousActiveKeyId } = await store().activate(keyId);
    // Activating the key that is already active changes nothing: no audit entry.
    if (previousActiveKeyId !== keyId) {
      await logAudit({
        req,
        action: 'update',
        resource: RESOURCE,
        resourceId: keyId,
        summary: `Activated watermark key ${keyId}`,
        details: { from: previousActiveKeyId, to: keyId }
      });
    }
    res.json(item);
  });

  /**
   * @swagger
   * /api/admin/eu-ai-act/watermark-keys/{keyId}/_reveal:
   *   post:
   *     summary: Reveal a key value (audited)
   *     description: >-
   *       Writes the audit entry first and answers 503 when that fails. The response is
   *       `Cache-Control: no-store`.
   *     tags: [Admin - Watermark]
   *     responses:
   *       200: { description: "`{ keyId, key (string), vllmConfigSnippet }`" }
   *       404: { description: Unknown key }
   *       503: { description: Audit log unavailable, key not revealed }
   */
  app.post(buildServerPath(`${base}/:keyId/_reveal`), adminAuth, async (req, res) => {
    const { keyId } = req.params;
    assertValidId(keyId, 'watermark key');
    const revealed = await store().reveal(keyId);
    const entry = await logAudit({
      req,
      action: 'read',
      resource: RESOURCE,
      resourceId: keyId,
      summary: `Revealed watermark key ${keyId}`
    });
    if (!entry) {
      throw new ServiceError(
        'WATERMARK_AUDIT_UNAVAILABLE',
        'The audit log is not available; the key was not revealed'
      );
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      keyId,
      key: String(revealed.key),
      vllmConfigSnippet: buildVllmConfigSnippet(revealed.key)
    });
  });

  /**
   * @swagger
   * /api/admin/eu-ai-act/watermark-keys/{keyId}:
   *   delete:
   *     summary: Delete a retired key
   *     description: Output made with it can no longer be recognised. The id is never reused.
   *     tags: [Admin - Watermark]
   *     responses:
   *       204: { description: Deleted }
   *       404: { description: Unknown key }
   *       409: { description: The key is active }
   */
  app.delete(buildServerPath(`${base}/:keyId`), adminAuth, async (req, res) => {
    const { keyId } = req.params;
    assertValidId(keyId, 'watermark key');
    await store().remove(keyId);
    await logAudit({
      req,
      action: 'delete',
      resource: RESOURCE,
      resourceId: keyId,
      summary: `Deleted watermark key ${keyId}`
    });
    res.status(204).end();
  });
}
