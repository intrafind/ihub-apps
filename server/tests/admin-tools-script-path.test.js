/**
 * Regression tests for #1806: tool.script must not allow path traversal
 * when the admin tools routes read/write/delete script files, and the
 * create/update endpoints must reject malformed script filenames outright.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

const mockAdminUser = {
  id: 'admin-user',
  username: 'admin',
  groups: ['admin']
};

const mockGroups = {
  admin: {
    id: 'admin',
    permissions: { adminAccess: true }
  }
};

// Mutable holders so each test can point the mocked modules at a fresh temp
// root / tool list without re-registering the mock factories.
const state = { rootDir: null, tools: [] };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir,
  getContentsPath: (...segments) => path.join(state.rootDir, 'contents', ...segments)
}));

jest.unstable_mockModule('../toolsLoader.js', () => ({
  loadAllTools: async () => state.tools
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshToolsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

jest.unstable_mockModule('../utils/authorization.js', () => ({
  loadGroupsConfiguration: () => ({ groups: mockGroups }),
  enhanceUserWithPermissions: user => user,
  isAnonymousAccessAllowed: () => false
}));

// Dynamic import after mocks are registered.
const { default: registerAdminToolsRoutes } = await import('../routes/admin/tools.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = mockAdminUser;
    next();
  });
  registerAdminToolsRoutes(app);
  return app;
}

describe('Admin tools script path traversal protection (#1806)', () => {
  let tmpRoot;
  let sentinelDir;
  let sentinelFile;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-tools-test-'));
    sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-sentinel-'));
    sentinelFile = path.join(sentinelDir, 'sentinel.js');
    await fs.writeFile(sentinelFile, 'module.exports = "sentinel";');

    await fs.mkdir(path.join(tmpRoot, 'server', 'tools'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'contents', 'tools'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'server', 'tools', 'legitTool.js'),
      'export default async function legitTool() { return "ok"; }'
    );

    state.rootDir = tmpRoot;

    const traversal = path.relative(path.join(tmpRoot, 'server', 'tools'), sentinelFile);

    state.tools = [
      {
        id: 'legitTool',
        name: { en: 'Legit Tool' },
        script: 'legitTool.js',
        enabled: true
      },
      {
        id: 'evilTool',
        name: { en: 'Evil Tool' },
        script: traversal,
        enabled: true
      }
    ];
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(sentinelDir, { recursive: true, force: true });
  });

  test('GET script rejects a tool.script that traverses outside server/tools, indistinguishably from a missing file', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/admin/tools/evilTool/script');

    expect(response.status).toBe(404);
    expect(existsSync(sentinelFile)).toBe(true);
  });

  test('GET script still works for a legitimate in-directory script', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/admin/tools/legitTool/script');

    expect(response.status).toBe(200);
    expect(response.body.content).toContain('legitTool');
  });

  test('PUT script rejects a tool.script that traverses outside server/tools, indistinguishably from a missing file', async () => {
    const app = createTestApp();
    const response = await request(app)
      .put('/api/admin/tools/evilTool/script')
      .send({ content: 'pwned' });

    expect(response.status).toBe(404);
    const sentinelContent = await fs.readFile(sentinelFile, 'utf-8');
    expect(sentinelContent).not.toBe('pwned');
  });

  test('DELETE tool skips script cleanup when tool.script traverses outside server/tools', async () => {
    const app = createTestApp();
    const response = await request(app).delete('/api/admin/tools/evilTool');

    expect(response.status).toBe(200);
    expect(existsSync(sentinelFile)).toBe(true);
  });

  test('POST create rejects a script filename containing path separators', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/admin/tools')
      .send({ id: 'newTool', name: { en: 'New Tool' }, script: '../evil.js' });

    expect(response.status).toBe(400);
  });

  test('PUT update rejects a script filename containing path separators', async () => {
    const app = createTestApp();
    const response = await request(app)
      .put('/api/admin/tools/legitTool')
      .send({ id: 'legitTool', name: { en: 'Legit Tool' }, script: '../../evil.js' });

    expect(response.status).toBe(400);
  });
});
