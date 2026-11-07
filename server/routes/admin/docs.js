// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import express from 'express';
import { join } from 'node:path';
import { getRootDir } from '../../pathUtils.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import {
  buildDocsIndex,
  loadDocPage,
  loadDocsToc,
  searchDocsIndex
} from '../../utils/docsLibrary.js';

// Next to package.json / version.txt in every layout: the repo root in development, dist/ in a
// production build (build:docs copies the Markdown there), the binary's directory when packaged.
const defaultDocsDir = join(getRootDir(), 'docs');

/**
 * Admin → Documentation: the documentation that ships with this build, as raw Markdown the client
 * renders. Admin-only: most of it describes configuration.
 */
export default function registerAdminDocsRoutes(app, { docsDir = defaultDocsDir } = {}) {
  // The docs ship with the build and do not change while it runs; in development they do, so the
  // index is rebuilt there on every search.
  const cacheIndex = process.env.NODE_ENV === 'production';
  let indexPromise = null;
  const getIndex = () => {
    if (!cacheIndex || !indexPromise) {
      indexPromise = buildDocsIndex(docsDir).catch(error => {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  };

  /**
   * GET /api/admin/docs/toc
   * The navigation tree from SUMMARY.md plus pages that exist but are not in it.
   */
  app.get(buildServerPath('/api/admin/docs/toc'), adminAuth, async (req, res) => {
    res.json(await loadDocsToc(docsDir));
  });

  /**
   * GET /api/admin/docs/page?path=integrations.md
   * One page as Markdown. The path only selects one of the pages the listing found.
   */
  app.get(buildServerPath('/api/admin/docs/page'), adminAuth, async (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    if (!requested) throw new ServiceError('BAD_REQUEST', 'path is required');
    const page = await loadDocPage(docsDir, requested);
    if (!page) throw new ServiceError('NOT_FOUND', 'Documentation page not found');
    res.json(page);
  });

  /**
   * GET /api/admin/docs/search?q=oidc+groups
   * Sections of all pages that contain every term, best match first.
   */
  app.get(buildServerPath('/api/admin/docs/search'), adminAuth, async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    if (!query.trim()) return res.json({ query: '', results: [] });
    const results = searchDocsIndex(await getIndex(), query);
    res.json({ query, results });
  });

  /**
   * GET /api/admin/docs/assets/*
   * Screenshots and other images the pages embed. express.static confines requests to the
   * directory.
   */
  app.use(
    buildServerPath('/api/admin/docs/assets'),
    adminAuth,
    express.static(join(docsDir, 'assets'), { dotfiles: 'deny', index: false, fallthrough: false })
  );
}
