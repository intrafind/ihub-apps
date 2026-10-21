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
 *    a text preview) and send a link item's reader to its source.
 *
 * @module services/sources/providers/project
 */
import { callerContext, permissionsFor } from '../../../middleware/projectAccess.js';
import { getItemText } from '../../knowledge/ItemTextService.js';
import { KnowledgeError, docOf } from '../../knowledge/types.js';
import { getProjectRepository } from '../../projects/ProjectRepository.js';
import { sourceProviderError } from '../providers.js';

async function load({ ref, user }) {
  const projectId = ref?.scope;
  const itemId = ref?.id;
  if (!projectId || !itemId)
    throw sourceProviderError(400, 'A project item reference needs id and scope');
  const project = await getProjectRepository().get(projectId);
  const permissions = permissionsFor(project, user, callerContext(user));
  if (!project || !permissions.canUse) throw sourceProviderError(404, 'Document not found');
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
 * @param {{ref: {id: string, scope?: string}, user: Object, format?: 'original'|'pdf'|'text'}} request
 */
async function content({ ref, user, format = 'original' }) {
  const { project, item } = await load({ ref, user });
  if (format !== 'text') {
    if (item.storage === 'link') {
      const url = item.provenance?.source?.url || item.ref?.url;
      if (url && /^https?:\/\//i.test(url)) {
        const error = sourceProviderError(409, 'This document lives at its source');
        error.redirect = url;
        throw error;
      }
    }
    const error = sourceProviderError(410, 'Only the extracted text of this document is kept');
    error.code = 'ORIGINAL_DISCARDED';
    throw error;
  }
  try {
    const { text } = await getItemText(project, item, { user, purpose: 'ui' });
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
