// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `upload` kind: a file the user hands in, or text written by a
 * workflow or pasted by an admin. The content is handed to the ingest
 * pipeline rather than fetched, so the kind has no `fetch`; its `ref`
 * records what the pipeline learned about the original (type and size).
 *
 * @module services/projects/kinds/uploadKind
 */
import { z } from 'zod';
import { registerItemKind } from './registry.js';

export const uploadKind = registerItemKind({
  id: 'upload',
  name: { en: 'Upload', de: 'Upload' },
  icon: 'arrow-up-tray',
  storage: { ihub: 'text' },
  credentials: 'none',
  picker: { type: 'upload' },
  refSchema: z
    .object({
      contentType: z.string().trim().max(200).optional(),
      bytes: z.number().int().nonnegative().optional()
    })
    .strict(),
  describe: () => ({})
});

export default uploadKind;
