/**
 * Regression tests for #1719: tool create/update/toggle writes must be
 * atomic (crash mid-write must not corrupt the existing file) and the
 * create endpoint must not allow two concurrent requests for the same new
 * tool ID to both succeed.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs, { promises as fsPromises } from 'fs';
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

// Mutable holder so each test can point the mocked loader at a fresh temp
// root / tool list without re-registering the mock factories.
const state = { rootDir: null, tools: [] };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
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

describe('Admin tools atomic writes (#1719)', () => {
  let tmpRoot;
  let toolsDir;

  beforeEach(async () => {
    tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ihub-tools-atomic-test-'));
    toolsDir = path.join(tmpRoot, 'contents', 'tools');
    await fsPromises.mkdir(toolsDir, { recursive: true });
    await fsPromises.mkdir(path.join(tmpRoot, 'server', 'tools'), { recursive: true });

    state.rootDir = tmpRoot;
    state.tools = [
      {
        id: 'existingTool',
        name: { en: 'Existing Tool' },
        enabled: true
      }
    ];

    await fsPromises.writeFile(
      path.join(toolsDir, 'existingTool.json'),
      JSON.stringify(state.tools[0], null, 2)
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  });

  test('a simulated rename failure during update leaves the original tool file untouched', async () => {
    const originalContent = await fsPromises.readFile(
      path.join(toolsDir, 'existingTool.json'),
      'utf-8'
    );

    const renameSpy = jest
      .spyOn(fs.promises, 'rename')
      .mockImplementationOnce(async () => {
        throw new Error('Simulated write failure');
      });

    const app = createTestApp();
    const response = await request(app)
      .put('/api/admin/tools/existingTool')
      .send({ id: 'existingTool', name: { en: 'Existing Tool (updated)' }, enabled: false });

    expect(response.status).toBe(500);
    renameSpy.mockRestore();

    const contentAfterFailure = await fsPromises.readFile(
      path.join(toolsDir, 'existingTool.json'),
      'utf-8'
    );
    expect(contentAfterFailure).toBe(originalContent);

    // No leftover temp file from the aborted write.
    const files = await fsPromises.readdir(toolsDir);
    expect(files.filter(f => f.startsWith('.tmp_'))).toHaveLength(0);
  });

  test('two concurrent creates for the same new tool ID result in exactly one success', async () => {
    const app = createTestApp();

    const [first, second] = await Promise.all([
      request(app)
        .post('/api/admin/tools')
        .send({ id: 'raceTool', name: { en: 'Race Tool A' } }),
      request(app)
        .post('/api/admin/tools')
        .send({ id: 'raceTool', name: { en: 'Race Tool B' } })
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);

    const written = await fsPromises.readFile(path.join(toolsDir, 'raceTool.json'), 'utf-8');
    const parsed = JSON.parse(written);
    expect(['Race Tool A', 'Race Tool B']).toContain(parsed.name.en);
  });
});
