// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `project` source provider: a project item's text and details, for
 * the reader's own membership (#1036, spec 2 §5.1). Serves the sources the
 * knowledge tools report (`ref: { id: itemId, scope: projectId }`).
 *
 *  - `format=text` streams the item's text, which gives Download for free.
 *  - `format=original` and `format=pdf` answer `410 ORIGINAL_DISCARDED` for
 *    text items (the iHub tier keeps no originals; the client falls back to
 *    a text preview); a link item's reader is sent to its source — the web
 *    page, the iHub page, or the iFinder document through the iFinder
 *    provider with the reader's own credentials; a document linked from
 *    another project is served from there, for the reader's membership there.
 *
 * @module services/sources/providers/project
 */
import configCache from '../../../configCache.js';
import { callerContext, permissionsFor } from '../../../middleware/projectAccess.js';
import { logAudit } from '../../AuditLogService.js';
import { projectName } from '../../projects/projectView.js';
import { getItemText } from '../../knowledge/ItemTextService.js';
import { KnowledgeError, docOf } from '../../knowledge/types.js';
import { getProjectRepository } from '../../projects/ProjectRepository.js';
import { loadProjectFor } from '../../projects/projectLoader.js';
import { PROJECT_ITEM_KIND } from '../../projects/projectItemLinks.js';
import { isProjectsConfigured, isUserProjectsConfigured } from '../../projects/projectSettings.js';
import { getSourceProvider, hasSourceProvider, sourceProviderError } from '../providers.js';

async function load({ ref, user }) {
  const projectId = ref?.scope;
  const itemId = ref?.id;
  if (!projectId || !itemId)
    throw sourceProviderError(400, 'A project item reference needs id and scope');
  // A citation of a smart collection (iFinder tier) is resolved from iFinder
  // with the reader's own rights, like any other project of theirs.
  const { project } = await loadProjectFor(user, projectId, {
    repository: getProjectRepository()
  });
  const permissions = permissionsFor(project, user, callerContext(user));
  if (!project || !permissions.canUse) throw sourceProviderError(404, 'Document not found');
  // Every project's documents are dark while the master switch is off, and
  // a user project's while its own feature is off too, here as in the scope
  // of a turn.
  const features = configCache.getFeatures();
  if (
    !isProjectsConfigured(features) ||
    (project.ownership === 'user' && !isUserProjectsConfigured(features))
  ) {
    throw sourceProviderError(404, 'Document not found');
  }
  const item = (project.items || []).find(entry => entry.id === itemId);
  if (!item) throw sourceProviderError(404, 'Document not found');
  return { project, item };
}

function safeName(name, extension) {
  const base = String(name || 'document')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
  return `${base || 'document'}.${extension}`;
}

/**
 * @param {{ref: {id: string, scope?: string}, user: Object, format?: 'original'|'pdf'|'text',
 *   followed?: boolean}} request - `followed`: reached through a linked document.
 */
async function content({ ref, user, format = 'original', followed = false }) {
  const { project, item } = await load({ ref, user });
  if (format !== 'text') {
    if (item.storage === 'link') return linkContent(project, item, { user, format, followed });
    const error = sourceProviderError(410, 'Only the extracted text of this document is kept');
    error.code = 'ORIGINAL_DISCARDED';
    throw error;
  }
  try {
    const { text } = await getItemText(project, item, { user, purpose: 'ui' });
    // The same read event the item-text route writes (`audit.logReads`):
    // a citation's preview or download is a read of the document too.
    if (configCache.getPlatform()?.audit?.logReads === true) {
      logAudit({
        actor: user,
        action: 'read',
        resource: 'projectItem',
        resourceId: project.id,
        source: 'sources',
        summary: `Read ${item.kind} item "${item.name}" (${item.text?.format || 'link'}) of project "${projectName(project)}" through a citation`
      });
    }
    return {
      contentType: 'text/plain; charset=utf-8',
      fileName: safeName(item.name, 'txt'),
      body: text
    };
  } catch (error) {
    if (error instanceof KnowledgeError) {
      const status =
        error.code === 'SOURCE_FORBIDDEN' ? 403 : error.code === 'ITEM_NOT_READY' ? 409 : 404;
      throw sourceProviderError(status, error.message);
    }
    throw error;
  }
}

/**
 * The original of a link item, by its kind: an iFinder document through the
 * iFinder provider (the reader's credentials, the same formats). A web page
 * or an iHub page has no file to hand over: the preview and the download
 * fall back to the extracted text (410, like a discarded upload), and the
 * card's URL opens the page where it lives.
 */
async function linkContent(project, item, { user, format, followed = false }) {
  // A document linked from another project: its original, for this reader.
  // One hop only, as for its text: a link to a link (or to itself) is not
  // followed, so a stored cycle cannot loop.
  if (item.kind === PROJECT_ITEM_KIND) {
    if (followed || !item.ref?.projectId || !item.ref?.itemId) {
      throw sourceProviderError(404, 'Document not found');
    }
    return content({
      ref: { id: item.ref.itemId, scope: item.ref.projectId },
      user,
      format,
      followed: true
    });
  }
  if (item.kind === 'ifinder-document' && item.ref?.documentId && hasSourceProvider('ifinder')) {
    const ifinder = await getSourceProvider('ifinder');
    return ifinder.content({
      ref: {
        id: item.ref.documentId,
        ...(item.ref.searchProfile ? { scope: item.ref.searchProfile } : {})
      },
      user,
      format
    });
  }
  const error = sourceProviderError(410, 'Only the extracted text of this document is kept');
  error.code = 'ORIGINAL_DISCARDED';
  throw error;
}

/**
 * @param {{ref: {id: string, scope?: string}, user: Object}} request
 */
async function metadata({ ref, user }) {
  const { project, item } = await load({ ref, user });
  const doc = docOf(project, item);
  return {
    title: item.name,
    filename: item.name,
    project: {
      id: project.id,
      name: typeof project.name === 'string' ? project.name : project.name?.en || project.id
    },
    kind: item.kind,
    status: item.status,
    pinned: item.pinned === true,
    provenance: item.provenance || null,
    snapshotAt: item.snapshotAt || null,
    chars: doc.chars,
    tokens: doc.tokens,
    originalBytes: item.text?.original?.bytes ?? null,
    contentType: item.text?.original?.contentType || null,
    url: doc.url,
    updatedAt: doc.updatedAt
  };
}

export default { id: 'project', content, metadata };
export { content, metadata };
