import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile, atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminPagesRoutes(app) {
  app.get('/api/admin/pages', adminAuth, async (req, res) => {
    try {
      const { data: uiConfig } = configCache.getUI();
      const pages = Object.entries(uiConfig.pages || {}).map(([id, page]) => ({
        id,
        title: page.title,
        authRequired: page.authRequired || false,
        allowedGroups: page.allowedGroups || []
      }));
      res.json(pages);
    } catch (error) {
      console.error('Error fetching pages:', error);
      res.status(500).json({ error: 'Failed to fetch pages' });
    }
  });

  app.get('/api/admin/pages/:pageId', adminAuth, async (req, res) => {
    const { pageId } = req.params;
    try {
      const { data: uiConfig } = configCache.getUI();
      const page = uiConfig.pages?.[pageId];
      if (!page) {
        return res.status(404).json({ error: 'Page not found' });
      }
      const content = {};
      const rootDir = getRootDir();
      for (const [lang, relPath] of Object.entries(page.filePath || {})) {
        try {
          const abs = join(rootDir, 'contents', relPath);
          content[lang] = await fs.readFile(abs, 'utf8');
        } catch {
          content[lang] = '';
        }
      }
      res.json({
        id: pageId,
        title: page.title,
        content,
        authRequired: page.authRequired || false,
        allowedGroups: page.allowedGroups || []
      });
    } catch (error) {
      console.error('Error fetching page:', error);
      res.status(500).json({ error: 'Failed to fetch page' });
    }
  });

  app.post('/api/admin/pages', adminAuth, async (req, res) => {
    try {
      const { id, title = {}, content = {}, authRequired = false, allowedGroups = '*' } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'Missing page ID' });
      }
      const rootDir = getRootDir();
      const uiPath = join(rootDir, 'contents', 'config', 'ui.json');
      const uiConfig = JSON.parse(readFileSync(uiPath, 'utf8'));
      uiConfig.pages = uiConfig.pages || {};
      if (uiConfig.pages[id]) {
        return res.status(400).json({ error: 'Page with this ID already exists' });
      }
      uiConfig.pages[id] = { title, filePath: {}, authRequired, allowedGroups };
      for (const [lang, md] of Object.entries(content)) {
        const dir = join(rootDir, 'contents', 'pages', lang);
        await fs.mkdir(dir, { recursive: true });
        const rel = `pages/${lang}/${id}.md`;
        await atomicWriteFile(join(rootDir, 'contents', rel), md);
        uiConfig.pages[id].filePath[lang] = rel;
      }
      await atomicWriteJSON(uiPath, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page created successfully', page: { id, title } });
    } catch (error) {
      console.error('Error creating page:', error);
      res.status(500).json({ error: 'Failed to create page' });
    }
  });

  app.put('/api/admin/pages/:pageId', adminAuth, async (req, res) => {
    try {
      const { pageId } = req.params;
      const { id, title = {}, content = {}, authRequired = false, allowedGroups = '*' } = req.body;
      if (!id || id !== pageId) {
        return res.status(400).json({ error: 'Invalid page ID' });
      }
      const rootDir = getRootDir();
      const uiPath = join(rootDir, 'contents', 'config', 'ui.json');
      const uiConfig = JSON.parse(readFileSync(uiPath, 'utf8'));
      const pageEntry = uiConfig.pages?.[pageId];
      if (!pageEntry) {
        return res.status(404).json({ error: 'Page not found' });
      }
      pageEntry.title = title;
      pageEntry.authRequired = authRequired;
      pageEntry.allowedGroups = allowedGroups;
      pageEntry.filePath = pageEntry.filePath || {};
      for (const [lang, md] of Object.entries(content)) {
        const dir = join(rootDir, 'contents', 'pages', lang);
        await fs.mkdir(dir, { recursive: true });
        const rel = pageEntry.filePath[lang] || `pages/${lang}/${pageId}.md`;
        await atomicWriteFile(join(rootDir, 'contents', rel), md);
        pageEntry.filePath[lang] = rel;
      }
      await atomicWriteJSON(uiPath, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page updated successfully', page: { id, title } });
    } catch (error) {
      console.error('Error updating page:', error);
      res.status(500).json({ error: 'Failed to update page' });
    }
  });

  app.delete('/api/admin/pages/:pageId', adminAuth, async (req, res) => {
    try {
      const { pageId } = req.params;
      const rootDir = getRootDir();
      const uiPath = join(rootDir, 'contents', 'config', 'ui.json');
      const uiConfig = JSON.parse(readFileSync(uiPath, 'utf8'));
      const pageEntry = uiConfig.pages?.[pageId];
      if (!pageEntry) {
        return res.status(404).json({ error: 'Page not found' });
      }
      for (const rel of Object.values(pageEntry.filePath || {})) {
        try {
          await fs.unlink(join(rootDir, 'contents', rel));
        } catch {}
      }
      delete uiConfig.pages[pageId];
      await atomicWriteJSON(uiPath, uiConfig);
      await configCache.refreshCacheEntry('config/ui.json');
      res.json({ message: 'Page deleted successfully' });
    } catch (error) {
      console.error('Error deleting page:', error);
      res.status(500).json({ error: 'Failed to delete page' });
    }
  });
}
