// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One project document as a file, for a user who may use the project: what
 * "Use in app" hands to a chat of another app (`{ source: { kind:
 * 'project-item', ref: { projectId, itemId } } }` on `POST /api/chats/:chatId/files`).
 *
 * The file is the document's original when the project kept one
 * (`platform.uploads.storageMode` is `original_and_text`), and its stored
 * text as a Markdown file otherwise. A document the project's editors marked
 * "Not for AI" is refused: handing it to an app is exactly what the mark
 * forbids. A link (an iHub page, an iFinder document) has no stored file and
 * is refused too; it stays usable through the project itself.
 *
 * Access is the project route's: the caller must be able to use the project
 * (owner, member, a linked admin project, the catalog); every project is dark
 * while `projects` is off, and user projects while `userProjects` is off.
 * The read is audited like a download of the document
 * (`platform.audit.logReads`): it takes the document out of the project.
 *
 * @module services/projects/projectItemFile
 */
import configCache from '../../configCache.js';
import { callerContext, permissionsFor } from '../../middleware/projectAccess.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { readOriginal, readText } from './ItemTextStore.js';
import { getProjectRepository } from './ProjectRepository.js';
import { loadProjectFor } from './projectLoader.js';
import { isProjectsConfigured, isUserProjectsConfigured } from './projectSettings.js';
import { projectName } from './projectView.js';
import { logAudit } from '../AuditLogService.js';

/** An error with the codes `fileSources.js` translates for the routes. */
function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** `offer.pdf` → `offer.md`; a name without an extension gets one. */
function markdownName(name) {
  const base = String(name || 'document')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .trim();
  return `${base || 'document'}.md`.slice(0, 300);
}

/**
 * Read one project document as a file, as `user`.
 *
 * @param {{projectId: string, itemId: string}} ref
 * @param {Object} user - `req.user`.
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<{bytes: Buffer, contentType: string, name: string, lastModified: string|null,
 *   ref: {projectId: string, itemId: string}, original: boolean}>}
 * @throws {Error} with `code` `SOURCE_GONE` (no such project or document, or no
 *   access: not revealed which), `SOURCE_FORBIDDEN` (user projects off, a
 *   document marked Not for AI) or `INVALID_REF` (a link, or a document still
 *   being processed or failed).
 */
export async function readProjectItemFile(ref, user, { repository = getProjectRepository() } = {}) {
  const { projectId, itemId } = ref || {};
  if (!isValidId(projectId) || !isValidId(itemId)) {
    throw sourceError('INVALID_REF', 'A project document is { projectId, itemId }');
  }
  const features = configCache.getFeatures?.() || {};
  if (!isProjectsConfigured(features)) {
    throw sourceError('SOURCE_FORBIDDEN', 'Projects are switched off');
  }
  const loaded = await loadProjectFor(user, projectId, { repository });
  const project = loaded?.project || null;
  const context = callerContext(user);
  const permissions = permissionsFor(project, user, context);
  if (!project || !permissions.canUse) {
    throw sourceError('SOURCE_GONE', 'The project document does not exist or is not yours to use');
  }
  if (project.ownership === 'user' && !context.isAdmin && !isUserProjectsConfigured(features)) {
    throw sourceError('SOURCE_FORBIDDEN', 'User projects are switched off');
  }
  const item = (project.items || []).find(entry => entry.id === itemId);
  if (!item) {
    throw sourceError('SOURCE_GONE', 'The project document does not exist or is not yours to use');
  }
  if (item.excludedFromAi === true) {
    throw sourceError(
      'SOURCE_FORBIDDEN',
      'This document is marked "Not for AI" in its project and cannot be handed to an app'
    );
  }
  if (item.storage !== 'text' || !item.text?.blobKey) {
    throw sourceError(
      'INVALID_REF',
      item.storage === 'text'
        ? 'The document is still being processed, or its processing failed'
        : 'A linked document has no stored file; use it through its project'
    );
  }
  const platform = configCache.getPlatform?.() || {};
  const auditRead = what => {
    if (platform.audit?.logReads !== true) return;
    logAudit({
      actor: user,
      action: 'read',
      resource: 'projectItem',
      resourceId: projectId,
      summary: `Copied the ${what} of "${item.name}" of project "${projectName(project)}" into a chat`
    });
  };
  if (item.originalFile?.blobKey) {
    const bytes = await readOriginal(project, item, { platform, repository });
    auditRead('original');
    return {
      bytes,
      contentType: item.originalFile.contentType || 'application/octet-stream',
      name: item.originalFile.name || item.name,
      lastModified: item.updatedAt || null,
      ref: { projectId, itemId },
      original: true
    };
  }
  const text = await readText(project, item, { platform, repository });
  auditRead('text');
  return {
    bytes: Buffer.from(text, 'utf8'),
    contentType: 'text/markdown',
    name: markdownName(item.name),
    lastModified: item.text.extractedAt || null,
    ref: { projectId, itemId },
    original: false
  };
}
