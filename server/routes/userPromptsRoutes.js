import { authenticatedOnly } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { userPromptInputSchema } from '../validators/userPromptInputSchema.js';
import {
  listOwnUserPrompts,
  listSharedUserPrompts,
  getUserPrompt,
  createUserPrompt,
  updateUserPrompt,
  deleteUserPrompt
} from '../utils/userPromptsStore.js';
import { logAudit } from '../services/AuditLogService.js';
import { sendInternalError, sendBadRequest, sendNotFound } from '../utils/responseHelpers.js';

/**
 * User-owned prompts: lets any authenticated (non-anonymous) user save their
 * own prompts into the library, private by default or shared with everyone.
 * Separate from the admin-curated contents/prompts/ library (server/routes/admin/prompts.js) —
 * see #1037/#1038.
 */
export default function registerUserPromptsRoutes(app) {
  const gate = [authenticatedOnly, requireFeature('promptsLibrary')];

  app.get(buildServerPath('/api/user-prompts'), ...gate, async (req, res) => {
    try {
      const userId = req.user.id;
      const [own, shared] = await Promise.all([
        listOwnUserPrompts(userId),
        listSharedUserPrompts(userId)
      ]);
      const prompts = [
        ...own.map(p => ({ ...p, mine: true })),
        ...shared.map(p => ({ ...p, mine: false }))
      ];
      res.json(prompts);
    } catch (error) {
      return sendInternalError(res, error, 'fetch user prompts');
    }
  });

  app.post(buildServerPath('/api/user-prompts'), ...gate, async (req, res) => {
    try {
      const parsed = userPromptInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendBadRequest(res, parsed.error.errors.map(e => e.message).join('; '));
      }
      const record = await createUserPrompt(req.user.id, parsed.data);
      await logAudit({
        req,
        action: 'create',
        resource: 'user-prompt',
        resourceId: record.id,
        summary: `Saved user prompt ${record.id}`
      });
      res.json({ message: 'Prompt saved successfully', prompt: { ...record, mine: true } });
    } catch (error) {
      return sendInternalError(res, error, 'create user prompt');
    }
  });

  app.put(buildServerPath('/api/user-prompts/:promptId'), ...gate, async (req, res) => {
    try {
      const { promptId } = req.params;
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }
      const parsed = userPromptInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendBadRequest(res, parsed.error.errors.map(e => e.message).join('; '));
      }
      const updated = await updateUserPrompt(req.user.id, promptId, parsed.data);
      if (!updated) {
        return sendNotFound(res, 'Prompt');
      }
      await logAudit({
        req,
        action: 'update',
        resource: 'user-prompt',
        resourceId: promptId,
        summary: `Updated user prompt ${promptId}`
      });
      res.json({ message: 'Prompt updated successfully', prompt: { ...updated, mine: true } });
    } catch (error) {
      return sendInternalError(res, error, 'update user prompt');
    }
  });

  app.delete(buildServerPath('/api/user-prompts/:promptId'), ...gate, async (req, res) => {
    try {
      const { promptId } = req.params;
      if (!validateIdForPath(promptId, 'prompt', res)) {
        return;
      }
      const existing = await getUserPrompt(req.user.id, promptId);
      if (!existing) {
        return sendNotFound(res, 'Prompt');
      }
      await deleteUserPrompt(req.user.id, promptId);
      await logAudit({
        req,
        action: 'delete',
        resource: 'user-prompt',
        resourceId: promptId,
        summary: `Deleted user prompt ${promptId}`
      });
      res.json({ message: 'Prompt deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete user prompt');
    }
  });
}
