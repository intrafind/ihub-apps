import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError,
  createRouteHandler
} from '../../utils/responseHelpers.js';

export default function registerAdminAppsRoutes(app) {
  app.get('/api/admin/apps', adminAuth, async (req, res) => {
    try {
      const { data: apps, etag: appsEtag } = configCache.getApps(true);
      res.setHeader('ETag', appsEtag);
      res.json(apps);
    } catch (error) {
      sendFailedOperationError(res, 'fetch apps', error);
    }
  });

  app.get('/api/admin/apps/templates', adminAuth, async (req, res) => {
    try {
      const { data: apps, etag: appsEtag } = configCache.getApps(true);
      const templates = apps.filter(app => app.allowInheritance !== false && app.enabled);
      res.setHeader('ETag', appsEtag);
      res.json(templates);
    } catch (error) {
      sendFailedOperationError(res, 'fetch template apps', error);
    }
  });

  app.get('/api/admin/apps/:appId/inheritance', adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const { data: apps } = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);

      if (!app) {
        return sendNotFound(res, 'App');
      }

      const inheritance = {
        app: app,
        parent: null,
        children: []
      };

      if (app.parentId) {
        inheritance.parent = apps.find(a => a.id === app.parentId);
      }
      inheritance.children = apps.filter(a => a.parentId === appId);
      res.json(inheritance);
    } catch (error) {
      sendFailedOperationError(res, 'fetch app inheritance', error);
    }
  });

  app.get('/api/admin/apps/:appId', adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const { data: apps } = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);

      if (!app) {
        return sendNotFound(res, 'App');
      }

      res.json(app);
    } catch (error) {
      sendFailedOperationError(res, 'fetch app', error);
    }
  });

  app.put('/api/admin/apps/:appId', adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const updatedApp = req.body;

      if (!updatedApp.id || !updatedApp.name || !updatedApp.description) {
        return sendBadRequest(res, 'Missing required fields');
      }
      if (updatedApp.id !== appId) {
        return sendBadRequest(res, 'App ID cannot be changed');
      }

      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      await atomicWriteJSON(appFilePath, updatedApp);
      await configCache.refreshAppsCache();
      res.json({ message: 'App updated successfully', app: updatedApp });
    } catch (error) {
      sendFailedOperationError(res, 'update app', error);
    }
  });

  app.post('/api/admin/apps', adminAuth, async (req, res) => {
    try {
      const newApp = req.body;
      if (!newApp.id || !newApp.name || !newApp.description) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${newApp.id}.json`);
      try {
        readFileSync(appFilePath, 'utf8');
        return res.status(400).json({ error: 'App with this ID already exists' });
      } catch (err) {
        // file does not exist
      }
      await fs.writeFile(appFilePath, JSON.stringify(newApp, null, 2));
      await configCache.refreshAppsCache();
      res.json({ message: 'App created successfully', app: newApp });
    } catch (error) {
      console.error('Error creating app:', error);
      res.status(500).json({ error: 'Failed to create app' });
    }
  });

  app.post('/api/admin/apps/:appId/toggle', adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const { data: apps } = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);
      if (!app) {
        return sendNotFound(res, 'App');
      }
      const newEnabledState = !app.enabled;
      app.enabled = newEnabledState;
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      await fs.writeFile(appFilePath, JSON.stringify(app, null, 2));
      await configCache.refreshAppsCache();
      res.json({
        message: `App ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        app: app,
        enabled: newEnabledState
      });
    } catch (error) {
      console.error('Error toggling app:', error);
      res.status(500).json({ error: 'Failed to toggle app' });
    }
  });

  app.post('/api/admin/apps/:appIds/_toggle', adminAuth, async (req, res) => {
    try {
      const { appIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Missing enabled flag' });
      }

      const { data: apps } = configCache.getApps(true);
      const ids = appIds === '*' ? apps.map(a => a.id) : appIds.split(',');
      const rootDir = getRootDir();

      for (const id of ids) {
        const app = apps.find(a => a.id === id);
        if (!app) continue;
        if (app.enabled !== enabled) {
          app.enabled = enabled;
          const appFilePath = join(rootDir, 'contents', 'apps', `${id}.json`);
          await fs.writeFile(appFilePath, JSON.stringify(app, null, 2));
        }
      }

      await configCache.refreshAppsCache();
      res.json({
        message: `Apps ${enabled ? 'enabled' : 'disabled'} successfully`,
        enabled,
        ids
      });
    } catch (error) {
      console.error('Error toggling apps:', error);
      res.status(500).json({ error: 'Failed to toggle apps' });
    }
  });

  app.delete('/api/admin/apps/:appId', adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      try {
        readFileSync(appFilePath, 'utf8');
      } catch {
        return res.status(404).json({ error: 'App not found' });
      }
      await fs.unlink(appFilePath);
      await configCache.refreshAppsCache();
      res.json({ message: 'App deleted successfully' });
    } catch (error) {
      console.error('Error deleting app:', error);
      res.status(500).json({ error: 'Failed to delete app' });
    }
  });
}
