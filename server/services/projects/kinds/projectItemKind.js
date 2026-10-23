// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `project-item` kind: a document linked from another project, read
 * from there whenever it is used (see `projectItemLinks.js`). Copying it
 * would duplicate the text and let the copy go stale; the link always reads
 * the source as it is now, with the reader's own access to it.
 *
 * @module services/projects/kinds/projectItemKind
 */
import { z } from 'zod';
import { registerItemKind } from './registry.js';
import { isProjectId, isUserProjectId } from '../ProjectRepository.js';
import { PROJECT_ITEM_KIND, resolveProjectItemLink } from '../projectItemLinks.js';
import { isValidId } from '../../../utils/pathSecurity.js';

export const projectItemKind = registerItemKind({
  id: PROJECT_ITEM_KIND,
  name: { en: 'From another project', de: 'Aus anderem Projekt' },
  icon: 'folder',
  storage: { ihub: 'link' },
  credentials: 'reading-user',
  picker: { type: 'project' },
  refSchema: z
    .object({
      projectId: z.string().trim().min(1).max(100).refine(isProjectId, 'Invalid project id'),
      itemId: z.string().trim().min(1).max(100).refine(isValidId, 'Invalid item id')
    })
    .strict(),
  describe: ref => ({
    name: ref.itemId,
    ...(isUserProjectId(ref.projectId) ? { url: `/projects/${ref.projectId}` } : {})
  }),
  prepare: (ref, ctx) => resolveProjectItemLink(ref, ctx)
});
