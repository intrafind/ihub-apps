/**
 * `requiredFeatures` on an app: while a feature it lists is off, users do not
 * get the app (as if it were disabled), admins still do, and the apps ETag
 * changes when the feature flips so no client keeps a stale list behind a 304.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import configCache from '../configCache.js';
import { areAppFeaturesEnabled } from '../featureRegistry.js';
import { getAppAsTools } from '../services/chat/appToolsGateway.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';

const SHIPPED_APP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../defaults/apps/skill-builder.json'
);

const APPS = [
  { id: 'chat', enabled: true },
  { id: 'skill-builder', enabled: true, requiredFeatures: ['skills'] },
  { id: 'old', enabled: false }
];

/**
 * Serve `apps` and `features` from the cache.
 *
 * @param {Object} features - features.json content
 */
function serve(features) {
  mock.method(configCache, 'get', key =>
    key === 'config/apps.json' ? { data: APPS, etag: '"apps-etag"' } : null
  );
  mock.method(configCache, 'getFeatures', () => features);
}

describe('areAppFeaturesEnabled', () => {
  it('is true for an app that requires nothing', () => {
    assert.equal(areAppFeaturesEnabled({ id: 'chat' }, {}), true);
    assert.equal(areAppFeaturesEnabled({ id: 'chat', requiredFeatures: [] }, {}), true);
  });

  it('follows the feature flags, with the registry default when unset', () => {
    const app = { id: 'skill-builder', requiredFeatures: ['skills'] };
    assert.equal(areAppFeaturesEnabled(app, { skills: true }), true);
    assert.equal(areAppFeaturesEnabled(app, { skills: false }), false);
    // `skills` is off by default
    assert.equal(areAppFeaturesEnabled(app, {}), false);
  });

  it('needs every listed feature on', () => {
    const app = { id: 'x', requiredFeatures: ['skills', 'workflows'] };
    assert.equal(areAppFeaturesEnabled(app, { skills: true, workflows: false }), false);
    assert.equal(areAppFeaturesEnabled(app, { skills: true, workflows: true }), true);
  });

  it('counts a feature id the registry does not know as off', () => {
    const app = { id: 'x', requiredFeatures: ['skils'] };
    assert.equal(areAppFeaturesEnabled(app, { skils: true }), false);
  });

  it('is validated against the registry in the app schema', async () => {
    const base = JSON.parse(await fs.readFile(SHIPPED_APP, 'utf8'));
    const ok = appConfigSchema.safeParse({ ...base, requiredFeatures: ['skills'] });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
    const typo = appConfigSchema.safeParse({ ...base, requiredFeatures: ['skils'] });
    assert.equal(typo.success, false);
    assert.deepEqual(typo.error.issues[0].path, ['requiredFeatures', 0]);
  });
});

describe('configCache.getApps with requiredFeatures', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('leaves out an app whose required feature is off', () => {
    serve({ skills: false });
    const { data, etag } = configCache.getApps();
    assert.deepEqual(
      data.map(app => app.id),
      ['chat']
    );
    assert.notEqual(etag, '"apps-etag"', 'the ETag tells the filtered list apart');
    // Still one quoted entity tag
    assert.match(etag, /^"apps-etag-f[0-9a-f]{8}"$/);
  });

  it('serves the app, under the plain ETag, once the feature is on', () => {
    serve({ skills: true });
    const { data, etag } = configCache.getApps();
    assert.deepEqual(
      data.map(app => app.id),
      ['chat', 'skill-builder']
    );
    assert.equal(etag, '"apps-etag"');
  });

  it('still hands admins every app', () => {
    serve({ skills: false });
    const { data } = configCache.getApps(true);
    assert.deepEqual(
      data.map(app => app.id),
      ['chat', 'skill-builder', 'old']
    );
  });

  it('keeps the app away from users, also from their app list', async () => {
    serve({ skills: false });
    const user = { id: 'u1', permissions: { apps: new Set(['*']) } };
    const { data, etag } = await configCache.getAppsForUser(user, {});
    assert.deepEqual(
      data.map(app => app.id),
      ['chat']
    );
    assert.notEqual(etag, '"apps-etag"');
  });
});

describe('app-as-tool with requiredFeatures', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('offers no tool for an app whose required feature is off', async () => {
    serve({ skills: false, appAsTool: true });
    const tools = await getAppAsTools(['skill-builder']);
    assert.deepEqual(tools, []);
  });
});

describe('the shipped Skill Builder app', () => {
  it('runs the skill-builder skill and needs the skills feature', async () => {
    const app = JSON.parse(await fs.readFile(SHIPPED_APP, 'utf8'));
    assert.equal(app.id, 'skill-builder');
    assert.deepEqual(app.skills, ['skill-builder']);
    assert.equal(app.skillSettings.autoActivate, true);
    assert.deepEqual(app.requiredFeatures, ['skills']);
    assert.equal(areAppFeaturesEnabled(app, { skills: false }), false);
    assert.equal(areAppFeaturesEnabled(app, { skills: true }), true);
  });
});
