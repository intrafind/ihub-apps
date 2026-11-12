// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The API documents under `/api/docs` are not built at boot (#3624).
 *
 * They are a function of the route files, so the production build writes them
 * once (`scripts/build-api-docs.js`) and the server reads the files on the
 * first `/api/docs` request; without the files the first request builds them.
 * Registering the routes — which every worker does at boot — must do neither.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-api-docs-'));

// Docs reachable without a session, so the routes can be called directly.
const contentsDir = path.join(scratch, 'contents');
await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
await fs.writeFile(
  path.join(contentsDir, 'config', 'platform.json'),
  JSON.stringify({ swagger: { enabled: true, requireAuth: false } })
);
process.env.CONTENTS_DIR = contentsDir;

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: logger } = await import('../utils/logger.js');
const specsModule = await import('../utils/apiDocSpecs.js');
const swagger = await import('../routes/swagger.js');

const messages = [];
const originalInfo = logger.info;
before(() => {
  logger.info = function (message, ...rest) {
    messages.push(typeof message === 'string' ? message : message?.message);
    return originalInfo.call(this, message, ...rest);
  };
});
after(async () => {
  logger.info = originalInfo;
  await fs.rm(scratch, { recursive: true, force: true });
});

test('registering the routes builds and reads no API document', async () => {
  swagger.resetApiDocSpecsForTests();
  messages.length = 0;
  const app = express();
  await swagger.default(app);
  assert.ok(
    !messages.some(m => /API documents/.test(m || '')),
    `no document was loaded at registration: ${messages.join(' | ')}`
  );

  // The first request loads them (here: builds them, there are no prebuilt
  // files in a source checkout), and the result is kept.
  const first = await request(app).get('/api/docs/normal/swagger.json');
  assert.equal(first.status, 200);
  assert.ok(Object.keys(first.body.paths).length > 0);
  assert.deepEqual(first.body.servers, [{ url: '/api', description: 'API Server' }]);
  const loads = messages.filter(m => /API documents/.test(m || '')).length;
  assert.equal(loads, 1);

  for (const name of ['admin', 'openai']) {
    const res = await request(app).get(`/api/docs/${name}/swagger.json`);
    assert.equal(res.status, 200);
    assert.ok(Object.keys(res.body.paths).length > 0, `${name} has paths`);
    assert.equal(res.body.info.title, specsModule.API_DOC_SETS[name].title);
  }
  const page = await request(app).get('/api/docs/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /iHub Apps - Admin APIs/);
  assert.equal(
    messages.filter(m => /API documents/.test(m || '')).length,
    1,
    'loaded once per process'
  );
});

test('the build script writes the documents the server would build', async () => {
  const out = path.join(scratch, 'openapi');
  const run = spawnSync(process.execPath, ['scripts/build-api-docs.js', out], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);

  const prebuilt = await specsModule.readApiDocSpecs(out);
  const built = await specsModule.buildApiDocSpecs();
  assert.deepEqual(prebuilt, JSON.parse(JSON.stringify(built)));
});

test('the server prefers the prebuilt documents', async () => {
  const dir = path.join(scratch, 'prebuilt');
  const built = await specsModule.buildApiDocSpecs();
  built.normal = { ...built.normal, info: { ...built.normal.info, title: 'from the build' } };
  await specsModule.writeApiDocSpecs(built, dir);
  assert.equal((await specsModule.readApiDocSpecs(dir)).normal.info.title, 'from the build');
  assert.equal(await specsModule.readApiDocSpecs(path.join(scratch, 'missing')), null);
});

test('a malformed @swagger block fails the build', async () => {
  const routesDir = path.join(scratch, 'routes');
  await fs.mkdir(routesDir, { recursive: true });
  await fs.writeFile(
    path.join(routesDir, 'generalRoutes.js'),
    [
      '/**',
      ' * @swagger',
      ' * /api/broken:',
      ' *   get:',
      ' *     description: e.g. {"a": true} unquoted',
      ' *       bad: indentation',
      ' */',
      'export default {};',
      ''
    ].join('\n')
  );
  await assert.rejects(specsModule.buildApiDocSpecs({ routesDir, failOnErrors: true }));
});

test('the served document names the installation base path', () => {
  const spec = { openapi: '3.0.0', servers: [{ url: '/api' }], paths: {} };
  assert.deepEqual(specsModule.withServerUrl(spec, '/ihub/api').servers, [
    { url: '/ihub/api', description: 'API Server' }
  ]);
  assert.deepEqual(spec.servers, [{ url: '/api' }], 'the loaded document is not changed');
});
