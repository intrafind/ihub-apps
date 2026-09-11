import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import serverConfig from '../../config.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  validateIdForPath,
  validateLanguageKeys,
  resolveAndValidatePath
} from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';

/** The UI configuration, which carries the page registry. */
const UI_FILE = 'config/ui.json';

/**
 * Whether a page body path recorded in `ui.json` stays inside `contents/`.
 *
 * The registry is admin-authored, so the stored path is checked before it is
 * used rather than trusted. The store contains a traversing path by folding it
 * onto its base name; a page whose registry entry escapes is skipped instead,
 * which is what this route has always done.
 *
 * The base directory is the configured one, the same directory the store
 * itself resolves against. A literal `contents` here would judge every path
 * against a directory that need not exist on an installation with
 * `CONTENTS_DIR` set, and `resolveAndValidatePath` answers null for a base it
 * cannot canonicalize — so every page body would read as empty and a delete
 * would drop the registry entry while leaving the files behind.
 *
 * @param {string} relPath - Path relative to `contents/`, from `page.filePath`
 * @returns {Promise<boolean>} True when the path is contained
 */
async function isContainedPagePath(relPath) {
  const contentsDir = join(getRootDir(), serverConfig.CONTENTS_DIR);
  return (await resolveAndValidatePath(relPath, contentsDir)) !== null;
}

export default function registerAdminPagesRoutes(app) {
  app.get(buildServerPath('/api/admin/pages'), adminAuth, async (req, res) => {
    try {
      const { data: uiConfig } = configCache.getUI();
      const pages = Object.entries(uiConfig.pages || {}).map(([id, page]) => ({
        id,
        title: page.title,
        authRequired: page.authRequired || false,
        allowedGroups: page.allowedGroups || [],
        contentType: page.contentType || 'markdown'
      }));
      res.json(pages);
    } catch (error) {
      return sendInternalError(res, error, 'fetch pages');
    }
  });

  app.get(buildServerPath('/api/admin/pages/:pageId'), adminAuth, async (req, res) => {
    const { pageId } = req.params;

    // Validate pageId for security
    if (!validateIdForPath(pageId, 'page', res)) {
      return;
    }

    try {
      const { data: uiConfig } = configCache.getUI();
      const page = uiConfig.pages?.[pageId];
      if (!page) {
        return sendNotFound(res, 'Page');
      }
      const content = {};
      for (const [lang, relPath] of Object.entries(page.filePath || {})) {
        if (!(await isContainedPagePath(relPath))) {
          logger.warn('Skipping page file with invalid path', {
            component: 'AdminPages',
            relPath
          });
          content[lang] = '';
          continue;
        }
        content[lang] = (await configStore.readText(relPath)) ?? '';
      }
      res.json({
        id: pageId,
        title: page.title,
        content,
        authRequired: page.authRequired || false,
        allowedGroups: page.allowedGroups || [],
        contentType: page.contentType || 'markdown'
      });
    } catch (error) {
      return sendInternalError(res, error, 'fetch page');
    }
  });

  app.post(buildServerPath('/api/admin/pages'), adminAuth, async (req, res) => {
    try {
      const {
        id,
        title = {},
        content = {},
        authRequired = false,
        allowedGroups = '*',
        contentType = 'markdown'
      } = req.body;
      if (!id) {
        return sendBadRequest(res, 'Missing page ID');
      }

      // Validate id for security
      if (!validateIdForPath(id, 'page', res)) {
        return;
      }

      const uiConfig = await configStore.readJson(UI_FILE);
      if (!uiConfig) throw new Error(`Unable to read ${UI_FILE}`);
      uiConfig.pages = uiConfig.pages || {};
      if (uiConfig.pages[id]) {
        return sendErrorResponse(res, 409, 'Page with this ID already exists');
      }
      // Validate language keys in content and title to prevent path traversal
      if (Object.keys(content).length > 0 && !validateLanguageKeys(content)) {
        return sendBadRequest(res, 'Invalid language code in content keys');
      }
      if (Object.keys(title).length > 0 && !validateLanguageKeys(title)) {
        return sendBadRequest(res, 'Invalid language code in title keys');
      }

      uiConfig.pages[id] = { title, filePath: {}, authRequired, allowedGroups, contentType };
      const fileExtension = contentType === 'react' ? 'jsx' : 'md';
      for (const [lang, contentText] of Object.entries(content)) {
        const rel = `pages/${lang}/${id}.${fileExtension}`;
        await configStore.writeText(rel, contentText);
        uiConfig.pages[id].filePath[lang] = rel;
      }
      // The body files land before the registry that names them: a crash
      // between the two leaves an unreferenced file rather than a page whose
      // content is missing.
      await configStore.writeJson(UI_FILE, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page created successfully', page: { id, title } });
    } catch (error) {
      return sendInternalError(res, error, 'create page');
    }
  });

  app.put(buildServerPath('/api/admin/pages/:pageId'), adminAuth, async (req, res) => {
    try {
      const { pageId } = req.params;

      // Validate pageId for security
      if (!validateIdForPath(pageId, 'page', res)) {
        return;
      }

      const {
        id,
        title = {},
        content = {},
        authRequired = false,
        allowedGroups = '*',
        contentType = 'markdown'
      } = req.body;
      if (!id || id !== pageId) {
        return sendBadRequest(res, 'Invalid page ID');
      }
      const uiConfig = await configStore.readJson(UI_FILE);
      if (!uiConfig) throw new Error(`Unable to read ${UI_FILE}`);
      const pageEntry = uiConfig.pages?.[pageId];
      if (!pageEntry) {
        return sendNotFound(res, 'Page');
      }
      pageEntry.title = title;
      pageEntry.authRequired = authRequired;
      pageEntry.allowedGroups = allowedGroups;
      pageEntry.contentType = contentType;
      // Validate language keys in content and title to prevent path traversal
      if (Object.keys(content).length > 0 && !validateLanguageKeys(content)) {
        return sendBadRequest(res, 'Invalid language code in content keys');
      }
      if (Object.keys(title).length > 0 && !validateLanguageKeys(title)) {
        return sendBadRequest(res, 'Invalid language code in title keys');
      }

      pageEntry.filePath = pageEntry.filePath || {};
      const fileExtension = contentType === 'react' ? 'jsx' : 'md';
      for (const [lang, contentText] of Object.entries(content)) {
        const rel = pageEntry.filePath[lang] || `pages/${lang}/${pageId}.${fileExtension}`;
        await configStore.writeText(rel, contentText);
        pageEntry.filePath[lang] = rel;
      }
      await configStore.writeJson(UI_FILE, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page updated successfully', page: { id, title } });
    } catch (error) {
      return sendInternalError(res, error, 'update page');
    }
  });

  app.delete(buildServerPath('/api/admin/pages/:pageId'), adminAuth, async (req, res) => {
    try {
      const { pageId } = req.params;

      // Validate pageId for security
      if (!validateIdForPath(pageId, 'page', res)) {
        return;
      }

      const uiConfig = await configStore.readJson(UI_FILE);
      if (!uiConfig) throw new Error(`Unable to read ${UI_FILE}`);
      const pageEntry = uiConfig.pages?.[pageId];
      if (!pageEntry) {
        return sendNotFound(res, 'Page');
      }
      for (const rel of Object.values(pageEntry.filePath || {})) {
        if (!(await isContainedPagePath(rel))) {
          logger.warn('Skipping deletion of page file with invalid path', {
            component: 'AdminPages',
            rel
          });
          continue;
        }
        // A body that will not go away must not block removing the registry
        // entry — the page would stay listed and unopenable.
        try {
          await configStore.remove(rel);
        } catch (error) {
          logger.warn('Unable to delete page file', {
            component: 'AdminPages',
            rel,
            error: error.message
          });
        }
      }
      delete uiConfig.pages[pageId];
      await configStore.writeJson(UI_FILE, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete page');
    }
  });
}
