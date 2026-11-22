// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Publishing personal apps (slice P12 of
 * concepts/app-builder-rework-2026-11/02-personal-apps.md, sections 8.2, 9
 * and 10): the owner's `POST /api/apps/{appId}/_publish`, and the admin
 * routes `_promote`, `_release` and `_waiting`.
 *
 * The routes run on the Express app of the user routes, over the harness of
 * the chat path, so "the member still chats" and "the member gets the
 * pointer" are checked on the real routes. App files are written through the
 * configuration store into a scratch contents directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The contents directory is read when `server/config.js` is first imported.
const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-apps-publish-'));
process.env.CONTENTS_DIR = contentsDir;

const { APPS, FEATURES, SECRET, chatBody, groupsWith, member, setConfig } =
  await import('./helpers/userAppsHarness.js');
const { startUserAppRoutesApi } = await import('./helpers/userAppRoutesApi.js');
const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { appConfigSchema } = await import('../validators/appConfigSchema.js');
const { validateAuditEntry } = await import('../validators/auditEntrySchema.js');
const { isUserAppId } = await import('../../shared/userAppContent.js');
const { effectiveUserApp } = await import('../services/userApps/ceiling.js');
const { userAppCatalog } = await import('../services/userApps/userAppResolution.js');
const { currentUserAppSettings } = await import('../services/userApps/userAppSettings.js');
const { projectCapabilities, startsEnabled, toAdminApp } =
  await import('../services/userApps/publishUserApp.js');
const { default: registerAdminUserAppRoutes } = await import('../routes/admin/userApps.js');
const { default: registerAdminUserAppPublishRoutes } =
  await import('../routes/admin/userAppPublish.js');

const ADMIN = '/api/admin/user-apps';
/** The ID the server makes from the name "Job ad writer". */
const SLUG = 'job-ad-writer';

let api;
let as;

before(async () => {
  api = await startUserAppRoutesApi();
  ({ as } = api);
  // As on the server: the publish routes before the routes of the admin list.
  registerAdminUserAppPublishRoutes(api.api);
  registerAdminUserAppRoutes(api.api);
  api.api.use(errorHandler);
});

after(async () => {
  await api.stop();
  delete process.env.CONTENTS_DIR;
  await fs.rm(contentsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Set the configuration and reload the app files from the store. The harness
 * puts its apps into the cache only; a publish reloads the cache from the
 * store, so the apps live there in this suite.
 */
async function configure(options = {}) {
  setConfig(options);
  await configCache.refreshAppsCache();
}

const appFile = id => configStore.readJson(`apps/${id}.json`);
const appFiles = async () => (await configStore.list('apps')).sort();

beforeEach(async () => {
  await api.reset();
  for (const key of await configStore.list('apps')) await configStore.remove(`apps/${key}.json`);
  for (const app of APPS) await configStore.writeJson(`apps/${app.id}.json`, app);
  await configure();
});

/** An installation personal apps may bind. */
const JIRA = { id: 'jira', definition: 'jira', enabled: true };
const jira = (extra = {}) => ({
  userApps: { capabilities: { integrations: [{ id: 'jira', actions: ['search', 'read'] }] } },
  integrations: { installed: [JIRA], security: { blockPrivateIps: true, allowedHosts: [] } },
  ...extra
});
const withBinding = {
  capabilities: {
    upload: true,
    webSearch: false,
    skills: false,
    integrations: [{ id: 'jira', actions: ['search'] }]
  }
};
const withUpload = {
  capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
};

const etag = record => `"${record.revision}"`;
const publish = (name, record, revision = etag(record)) =>
  as(name).post(`/api/apps/${record.id}/_publish`).set('If-Match', revision).send();
const promote = (name, record, body = {}, revision = etag(record)) =>
  as(name).post(`${ADMIN}/${record.id}/_promote`).set('If-Match', revision).send(body);
const chat = (name, appId) =>
  api.chatAs(name).post(`/api/apps/${appId}/chat/${randomUUID()}`).send(chatBody());
const problem = res => ({ status: res.status, code: res.body?.code, details: res.body?.details });

/** The audit entry of the admin app a publish of `record` wrote. */
const createdEntry = async record =>
  (await api.audit(SLUG, { resource: 'app', action: 'create' })).find(
    entry => entry.details?.userAppId === record.id
  );

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  api.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

describe('who may publish', () => {
  it('with publishing switched off the owner gets 403, and the view offers nothing', async () => {
    await configure({ userApps: { sharing: { allowPublish: false } } });
    const record = await sharedApp();

    const res = await publish('anna', record);
    assert.deepEqual(problem(res), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'publish' }
    });
    const view = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(view.body.permissions.canPublish, false);
    assert.equal('publish' in view.body, false);
    const config = await as('anna').get('/api/apps/_config');
    assert.equal(config.body.userApps.canPublish, false);
    assert.deepEqual(await appFiles(), APPS.map(app => app.id).sort());
  });

  it('with publishing on and without userAppSharing the owner gets the same 403', async () => {
    await configure({ groups: groupsWith({ users: { userAppSharing: false } }) });
    const record = await api.createApp('anna');
    assert.deepEqual(problem(await publish('anna', record)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'publish' }
    });
    assert.equal((await api.repo().get(record.id)).state, 'active');
  });

  it('an editor and a member get 403, a stranger the 404 of an unknown ID', async () => {
    const record = await sharedApp();
    for (const name of ['carol', 'ben']) {
      const res = await publish(name, record);
      assert.deepEqual(
        problem(res),
        { status: 403, code: 'PERMISSION_DENIED', details: { required: 'publish' } },
        name
      );
      const view = await as(name).get(`/api/apps/${record.id}`);
      assert.equal(view.body.permissions.canPublish, false, name);
      assert.equal('publish' in view.body, false, name);
    }
    assert.equal((await publish('dave', record)).status, 404);
    // A full admin who is not the owner takes over instead; the owner route refuses.
    assert.equal((await publish('root', record)).status, 403);
    assert.equal((await api.repo().get(record.id)).state, 'active');
  });

  it('a blocked owner and a switched-off app are refused', async () => {
    const record = await api.createApp('anna');
    await configure({ userApps: { blockedOwners: ['anna'] } });
    const blocked = await publish('anna', record);
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.body.details.required, 'publish');

    await configure();
    const off = await api.createApp('anna', {
      change: r => ({
        ...r,
        disabled: { at: '2026-11-20T10:00:00.000Z', by: { id: 'root', name: 'Ada Admin' } }
      })
    });
    assert.deepEqual(problem(await publish('anna', off)), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'disabled' }
    });
  });

  it('without If-Match 400, with a stale one 409, and nothing is written', async () => {
    const record = await api.createApp('anna');
    const missing = await as('anna').post(`/api/apps/${record.id}/_publish`).send();
    assert.equal(missing.status, 400, missing.text);
    assert.equal(missing.body.code, 'VALIDATION_FAILED');

    const stale = await publish('anna', record, '"99"');
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.code, 'ETAG_MISMATCH');

    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'active');
    assert.equal(await appFile(SLUG), null);
  });

  it('a second publish of a published app answers 409', async () => {
    const record = await api.createApp('anna');
    assert.equal((await publish('anna', record)).status, 200);
    const stored = await api.repo().get(record.id);
    assert.deepEqual(problem(await publish('anna', stored)), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'promoted' }
    });
    assert.deepEqual(await appFiles(), [...APPS.map(app => app.id), SLUG].sort());
  });
});

describe('what a publish writes', () => {
  it('an app without tools: one valid file with a readable ID, switched on', async () => {
    const record = await sharedApp({ content: withUpload });
    await api.repo().setOffer(record.id, {
      receiver: { id: 'dave', name: 'Dave Lund' },
      sender: { id: 'anna', name: 'Anna Schmidt' }
    });
    const current = await api.repo().get(record.id);

    const before = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(before.body.permissions.canPublish, true);
    assert.deepEqual(before.body.publish, {
      startsEnabled: true,
      waitsFor: null,
      tools: [],
      capabilities: [{ id: 'upload' }],
      dropped: [],
      plain: false
    });

    const res = await publish('anna', current);
    assert.equal(res.status, 200, res.text);

    const file = await appFile(SLUG);
    assert.ok(file, 'the app file exists');
    assert.equal(appConfigSchema.safeParse(file).success, true);
    assert.equal(file.id, SLUG);
    assert.equal(isUserAppId(file.id), false);
    assert.equal(file.enabled, true);
    assert.deepEqual(file.toolApproval, { default: 'writes' });
    assert.equal('category' in file, false);
    assert.deepEqual(file.name, { en: 'Job ad writer' });
    assert.equal(file.system.en.includes(SECRET), true);
    assert.equal(file.upload.enabled, true);
    assert.equal('integrations' in file, false);
    assert.equal('skills' in file, false);
    assert.equal('websearch' in file, false);
    // Projects stay off, as in the personal app: an admin switches them on.
    assert.deepEqual(file.features, { projects: false, userProjects: false });
    // No ownership field: an admin app has no owner.
    assert.equal(JSON.stringify(file).includes('anna'), false);

    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'promoted');
    assert.equal(stored.publishedAs.appId, SLUG);
    assert.deepEqual(stored.publishedAs.by, { id: 'anna', name: 'Anna Schmidt' });
    assert.equal(stored.pendingOwner ?? null, null);
    assert.equal('publishing' in stored, false);

    // The owner may use the company app at once: the answer is the pointer
    // there, the same body the next GET answers, with the keys of 9.1.
    const retired = {
      id: record.id,
      ownership: 'user',
      state: 'retired',
      publishedAs: { appId: SLUG, name: { en: 'Job ad writer' }, enabled: true }
    };
    assert.deepEqual(res.body, retired);
    const pointer = await as('anna').get(`/api/apps/${record.id}`);
    assert.deepEqual(pointer.body, retired);
    // The company app is in the list of apps of everyone.
    const list = await as('dave').get('/api/apps');
    assert.equal(JSON.stringify(list.body).includes(`"id":"${SLUG}"`), true);
  });

  it('an app with a connected system: named actions, switched off, the member still chats', async () => {
    await configure(jira());
    const record = await sharedApp({ content: withBinding });

    const before = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(before.body.publish.startsEnabled, false);
    assert.equal(before.body.publish.waitsFor, 'tools');
    assert.deepEqual(before.body.publish.tools, ['integrations']);
    assert.deepEqual(before.body.publish.capabilities, [
      { id: 'upload' },
      { id: 'integration:jira', installationId: 'jira', name: 'jira', actions: ['search'] }
    ]);

    const res = await publish('anna', record);
    assert.equal(res.status, 200, res.text);
    const file = await appFile(SLUG);
    assert.equal(appConfigSchema.safeParse(file).success, true);
    assert.equal(file.enabled, false);
    assert.deepEqual(file.integrations, {
      jira: { actions: ['search'], required: false, enabledByDefault: false }
    });
    assert.deepEqual(file.toolApproval, { default: 'writes' });

    // Not visible yet: the personal app keeps working, read-only.
    assert.equal(res.body.state, 'promoted');
    assert.equal(res.body.permissions.canUse, true);
    assert.equal(res.body.permissions.canEdit, false);
    assert.equal(res.body.permissions.readOnly, true);
    assert.equal(res.body.publishedAs.appId, SLUG);
    assert.equal(res.body.publishedAs.enabled, false);
    assert.deepEqual(res.body.publishedAs.name, { en: 'Job ad writer' });
    assert.ok(res.body.publishedAs.at);
    assert.deepEqual(Object.keys(res.body.publishedAs).sort(), ['appId', 'at', 'enabled', 'name']);
    assert.equal('publish' in res.body, false);

    assert.equal((await chat('ben', record.id)).status, 200);
    const member = await as('ben').get(`/api/apps/${record.id}`);
    assert.equal(member.status, 200);
    assert.equal('publishedAs' in member.body, false);
    const patch = await as('anna').patch(`/api/apps/${record.id}`).send({ icon: 'star' });
    assert.deepEqual(problem(patch), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'promoted' }
    });
  });

  it('a capability that was removed from the settings is absent from the file', async () => {
    await configure(jira());
    const record = await api.createApp('anna', { content: withBinding });
    // The admin takes the installation off the list after the save.
    await configure({
      integrations: { installed: [JIRA], security: { blockPrivateIps: true, allowedHosts: [] } }
    });

    const before = await as('anna').get(`/api/apps/${record.id}`);
    assert.deepEqual(before.body.publish.dropped, [
      { id: 'integration:jira', reason: 'offOnInstallation', name: 'jira' }
    ]);
    assert.equal(before.body.publish.startsEnabled, true);

    const res = await publish('anna', record);
    assert.equal(res.status, 200, res.text);
    const file = await appFile(SLUG);
    assert.equal('integrations' in file, false);
    assert.equal(file.upload.enabled, true);
    assert.equal(file.enabled, true);
  });

  it("with adminEnables 'always' every app starts switched off", async () => {
    await configure({ userApps: { publishing: { adminEnables: 'always' } } });
    const record = await api.createApp('anna');
    const before = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(before.body.publish.startsEnabled, false);
    assert.equal(before.body.publish.waitsFor, 'always');
    assert.equal((await publish('anna', record)).status, 200);
    assert.equal((await appFile(SLUG)).enabled, false);
  });

  it('an existing app file with the slug of the name is not overwritten', async () => {
    const existing = { ...APPS[0], id: SLUG, name: { en: 'An older app' } };
    await configStore.writeJson(`apps/${SLUG}.json`, existing);
    await configure();
    const record = await api.createApp('anna');

    const res = await publish('anna', record);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(await appFile(SLUG), existing);
    const stored = await api.repo().get(record.id);
    assert.equal(stored.publishedAs.appId, `${SLUG}-2`);
    assert.deepEqual((await appFile(`${SLUG}-2`)).name, { en: 'Job ad writer' });
  });

  it('a file that appears between the check and the write is not overwritten either', async () => {
    const record = await api.createApp('anna');
    // In the store, and not in the cache the publish reads its taken IDs from.
    const existing = { ...APPS[0], id: SLUG, name: { en: 'Written a moment ago' } };
    await configStore.writeJson(`apps/${SLUG}.json`, existing);

    const res = await publish('anna', record);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(await appFile(SLUG), existing);
    assert.equal((await api.repo().get(record.id)).publishedAs.appId, `${SLUG}-2`);
  });

  it('the crash window: file written, record not marked, a second publish finishes', async () => {
    const record = await api.createApp('anna');
    const anna = api.user('anna');
    const settings = currentUserAppSettings();
    const effective = effectiveUserApp(record, {
      runner: anna,
      owner: anna,
      settings,
      catalog: await userAppCatalog({ owner: anna, runner: anna })
    });
    // What the first call left behind before the server stopped.
    await api
      .repo()
      .mutate(record.id, r => ({ ...r, publishing: { appId: SLUG } }), { bumpRevision: false });
    await configStore.createJson(
      `apps/${SLUG}.json`,
      toAdminApp(record, { effective, id: SLUG, enabled: true })
    );
    await configCache.refreshAppsCache();

    const res = await publish('anna', record);
    assert.equal(res.status, 200, res.text);
    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'promoted');
    assert.equal(stored.publishedAs.appId, SLUG);
    assert.equal('publishing' in stored, false);
    assert.deepEqual(await appFiles(), [...APPS.map(app => app.id), SLUG].sort());
  });

  it('a publish that loses against a change takes its file away again', async () => {
    const record = await api.createApp('anna');
    const repo = api.repo();
    const original = repo.mutate.bind(repo);
    let calls = 0;
    // Between the mark and the final write, an editor saves.
    repo.mutate = async (...args) => {
      calls += 1;
      if (calls === 2) {
        await repo.update(
          record.id,
          { ...record.content, description: { en: 'Changed meanwhile' } },
          { actor: { id: 'anna', name: 'Anna Schmidt' } }
        );
      }
      return original(...args);
    };
    try {
      const res = await publish('anna', record);
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.code, 'ETAG_MISMATCH');
    } finally {
      delete repo.mutate;
    }
    assert.equal(await appFile(SLUG), null);
    assert.equal((await repo.get(record.id)).state, 'active');
    assert.equal(
      (configCache.getApps(true).data || []).some(app => app.id === SLUG),
      false
    );
  });

  it('a personal app deleted during the publish leaves no company app behind', async () => {
    const record = await api.createApp('anna');
    const repo = api.repo();
    const original = repo.mutate.bind(repo);
    let calls = 0;
    // Between the mark and the final write, the owner deletes the app in another tab.
    repo.mutate = async (...args) => {
      calls += 1;
      if (calls === 2) await repo.delete(record.id);
      return original(...args);
    };
    try {
      const res = await publish('anna', record);
      assert.equal(res.status, 404, res.text);
    } finally {
      delete repo.mutate;
    }
    assert.equal(await appFile(SLUG), null);
    assert.equal(
      (configCache.getApps(true).data || []).some(app => app.id === SLUG),
      false
    );
  });

  it('a refused publish takes its mark off the record', async () => {
    const record = await api.createApp('anna');
    const repo = api.repo();
    const original = repo.mutate.bind(repo);
    let calls = 0;
    repo.mutate = async (...args) => {
      calls += 1;
      if (calls === 2) {
        await repo.update(
          record.id,
          { ...record.content, description: { en: 'Changed meanwhile' } },
          { actor: { id: 'anna', name: 'Anna Schmidt' } }
        );
      }
      return original(...args);
    };
    try {
      assert.equal((await publish('anna', record)).status, 409);
    } finally {
      delete repo.mutate;
    }
    assert.equal((await repo.get(record.id)).publishing ?? null, null);
  });

  it('the crash window: a leftover file with a capability taken away since is not adopted', async () => {
    await configure(jira());
    const record = await api.createApp('anna', { content: withBinding });
    const anna = api.user('anna');
    const settings = currentUserAppSettings();
    const effective = effectiveUserApp(record, {
      runner: anna,
      owner: anna,
      settings,
      catalog: await userAppCatalog({ owner: anna, runner: anna })
    });
    // The first call wrote the file with the binding, then the server stopped.
    await api
      .repo()
      .mutate(record.id, r => ({ ...r, publishing: { appId: SLUG } }), { bumpRevision: false });
    await configStore.createJson(
      `apps/${SLUG}.json`,
      toAdminApp(record, { effective, id: SLUG, enabled: false })
    );
    // Meanwhile the admin takes the installation away from personal apps.
    await configure({ ...jira(), userApps: { capabilities: { integrations: [] } } });

    const res = await publish('anna', await api.repo().get(record.id));
    assert.equal(res.status, 200, res.text);
    const stored = await api.repo().get(record.id);
    assert.notEqual(stored.publishedAs.appId, SLUG);
    assert.equal('integrations' in (await appFile(stored.publishedAs.appId)), false);
  });

  it('a file of the same content that another personal app is publishing is not adopted', async () => {
    const first = await api.createApp('anna');
    const second = await api.createApp('ben');
    // Ben's publish of an app from the same template is under way: marked, file written.
    await api
      .repo()
      .mutate(second.id, r => ({ ...r, publishing: { appId: SLUG } }), { bumpRevision: false });
    const ben = api.user('ben');
    const settings = currentUserAppSettings();
    const effective = effectiveUserApp(second, {
      runner: ben,
      owner: ben,
      settings,
      catalog: await userAppCatalog({ owner: ben, runner: ben })
    });
    await configStore.createJson(
      `apps/${SLUG}.json`,
      toAdminApp(second, { effective, id: SLUG, enabled: true })
    );

    const res = await publish('anna', first);
    assert.equal(res.status, 200, res.text);
    assert.equal((await api.repo().get(first.id)).publishedAs.appId, `${SLUG}-2`);
  });

  it('a published app counts against the limit of its owner', async () => {
    await configure({ userApps: { limits: { maxAppsPerUser: 1 } } });
    const record = await api.createApp('anna');
    assert.equal((await publish('anna', record)).status, 200);
    const config = await as('anna').get('/api/apps/_config');
    assert.equal(config.body.userApps.used, 1);
    const res = await as('anna')
      .post('/api/apps')
      .send({
        language: 'en',
        origin: 'blank',
        name: { en: 'Another' },
        description: { en: 'One more' },
        system: { en: 'You help.' }
      });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.code, 'QUOTA_USER_APPS');
  });

  it('writes two valid audit entries, with the capabilities, actions and skills', async () => {
    await configure(jira());
    const record = await sharedApp({ content: withBinding });
    assert.equal((await publish('anna', record)).status, 200);

    const [share] = await api.audit(record.id, { resource: 'userAppShare', action: 'share' });
    assert.ok(share, 'the share entry');
    assert.equal(validateAuditEntry(share).success, true);
    assert.equal(share.summary, `Published personal app "Job ad writer" as ${SLUG}`);
    assert.deepEqual(share.details, {
      appId: SLUG,
      enabled: false,
      by: 'owner',
      revision: record.revision,
      contentHash: record.contentHash
    });

    const created = await createdEntry(record);
    assert.ok(created, 'the create entry');
    assert.equal(validateAuditEntry(created).success, true);
    assert.equal(
      created.summary,
      `Published personal app "Job ad writer" by Anna Schmidt as ${SLUG}`
    );
    assert.deepEqual(created.details, {
      origin: 'personal',
      userAppId: record.id,
      ownerId: 'anna',
      enabled: false,
      capabilities: ['upload', 'integration:jira'],
      integrations: [{ id: 'jira', actions: ['search'] }],
      skills: [],
      dropped: [],
      revision: record.revision,
      contentHash: record.contentHash
    });
    assert.equal(JSON.stringify([share, created]).includes(SECRET), false);
  });
});

describe('the start state and the projection, for every kind of tool', () => {
  const settings = adminEnables => ({ publishing: { adminEnables } });
  const record = { id: 'uap_0123456789abcdef0123456789abcdef', language: 'de' };
  const effective = (app, capabilities) => ({
    app: {
      name: { de: 'Recherche' },
      description: { de: 'Sucht' },
      system: { de: 'Du suchst.' },
      ...app
    },
    capabilities
  });
  const granted = id => ({ id, requested: true, granted: true });

  it('web search, a skill and a binding each keep the app switched off', () => {
    assert.equal(startsEnabled([], settings('withTools')), true);
    for (const tool of ['webSearch', 'skills', 'integrations']) {
      assert.equal(startsEnabled([tool], settings('withTools')), false, tool);
    }
    assert.equal(startsEnabled([], settings('always')), false);
    // An unknown value was read as `withTools` by the settings reader already.
    assert.equal(startsEnabled(['webSearch'], settings('never')), false);
  });

  it('web search is written as websearch.enabled and makes the app one with tools', () => {
    const result = effective(
      { websearch: { enabled: true, provider: 'auto', useNativeSearch: false } },
      [granted('webSearch')]
    );
    const projected = projectCapabilities(result);
    assert.deepEqual(projected.tools, ['webSearch']);
    const app = toAdminApp(record, { effective: result, id: 'recherche', enabled: false });
    assert.deepEqual(app.websearch, { enabled: true });
    assert.equal(app.enabled, false);
    assert.equal(appConfigSchema.safeParse(app).success, true);
  });

  it('skills are written as the explicit list of granted IDs, never as a wildcard', () => {
    const result = effective(
      { skillSettings: { enabled: true, allowPersonal: true }, skills: ['brand-voice', '*'] },
      [granted('skills')]
    );
    const projected = projectCapabilities(result);
    assert.deepEqual(projected.tools, ['skills']);
    assert.deepEqual(projected.capabilities, [{ id: 'skills', skills: ['brand-voice', '*'] }]);
    const app = toAdminApp(record, { effective: result, id: 'recherche', enabled: false });
    assert.deepEqual(app.skills, ['brand-voice']);
    assert.deepEqual(app.skillSettings, { enabled: true });
    assert.equal(appConfigSchema.safeParse(app).success, true);
  });

  it('what was asked for and is not granted is listed as dropped, with the reason', () => {
    const projected = projectCapabilities(
      effective({}, [
        { id: 'model', requested: false, granted: false, reason: 'notRequested' },
        { id: 'webSearch', requested: true, granted: false, reason: 'ownerInactive' },
        { id: 'integration:jira', requested: true, granted: false, reason: 'ownerInactive' }
      ]),
      { nameOf: () => 'Jira' }
    );
    assert.deepEqual(projected.capabilities, []);
    assert.deepEqual(projected.dropped, [
      { id: 'webSearch', reason: 'ownerInactive' },
      { id: 'integration:jira', reason: 'ownerInactive', name: 'Jira' }
    ]);
    // The owner's rights could not be checked: the app is a plain chat app.
    assert.equal(projected.plain, true);
    assert.deepEqual(projected.tools, []);
  });

  it('the app keeps the language of the personal app and gets no category', () => {
    const app = toAdminApp(record, {
      effective: effective({}, []),
      id: 'recherche',
      enabled: true
    });
    assert.deepEqual(app.name, { de: 'Recherche' });
    assert.equal('category' in app, false);
    assert.equal(app.id, 'recherche');
    assert.equal(appConfigSchema.safeParse(app).success, true);
  });
});

describe('retired is decided per person, on an installation without the wildcard', () => {
  it('a member whose groups grant the company app gets the pointer, another still chats', async () => {
    const groups = groupsWith({ wildcard: false });
    groups.groups.staff.permissions.apps.push(SLUG);
    await configure({ groups });
    const record = await api.createApp('anna', {
      members: [member('ben', 'user'), member('sam', 'user')]
    });
    assert.equal((await publish('anna', record)).status, 200);
    assert.equal((await appFile(SLUG)).enabled, true);

    // Sam is in `staff`, which grants the new ID.
    const sam = await as('sam').get(`/api/apps/${record.id}`);
    assert.deepEqual(sam.body, {
      id: record.id,
      ownership: 'user',
      state: 'retired',
      publishedAs: { appId: SLUG, name: { en: 'Job ad writer' }, enabled: true }
    });
    assert.equal((await chat('sam', record.id)).status, 404);

    // Ben's groups do not grant it: the personal app keeps working for him.
    const ben = await as('ben').get(`/api/apps/${record.id}`);
    assert.equal(ben.status, 200);
    assert.equal(ben.body.state, 'promoted');
    assert.equal(ben.body.permissions.canUse, true);
    assert.equal(ben.body.system.en.includes(SECRET), true);
    assert.equal((await chat('ben', record.id)).status, 200);

    // So does it for the owner, whose groups do not grant the new ID either.
    const anna = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(anna.body.permissions.canUse, true);
    assert.equal(anna.body.permissions.readOnly, true);
  });
});

describe('GET /api/admin/user-apps/_waiting', () => {
  it('lists a published app that is not switched on, and nothing of the personal app', async () => {
    await configure(jira());
    const waiting = await sharedApp({ content: withBinding });
    const visible = await api.createApp('ben', { content: { name: { en: 'Meeting recap' } } });
    assert.equal((await publish('anna', waiting)).status, 200);
    assert.equal((await publish('ben', visible)).status, 200);

    for (const name of ['builder', 'root']) {
      const res = await as(name).get(`${ADMIN}/_waiting`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.nextCursor, null);
      assert.equal(res.body.items.length, 1, name);
      const [item] = res.body.items;
      assert.deepEqual(Object.keys(item).sort(), ['appId', 'name', 'publishedAt', 'publishedBy']);
      assert.equal(item.appId, SLUG);
      assert.deepEqual(item.name, { en: 'Job ad writer' });
      assert.deepEqual(item.publishedBy, { name: 'Anna Schmidt' });
      assert.equal(res.text.includes(waiting.id), false);
      assert.equal(res.text.includes('uap_'), false);
      assert.equal(res.text.includes(SECRET), false);
    }
  });

  it('is for content admins and full admins, with the feature on and off', async () => {
    for (const name of ['ben', 'anna', 'rootKey', 'anonymous']) {
      const res = await as(name).get(`${ADMIN}/_waiting`);
      assert.ok([401, 403].includes(res.status), `${name}: ${res.status}`);
    }
    await configure({ features: { ...FEATURES, userApps: false } });
    for (const name of ['builder', 'root']) {
      const res = await as(name).get(`${ADMIN}/_waiting`);
      assert.deepEqual(res.body, { items: [], nextCursor: null }, name);
    }
  });

  it('an app the admin switched on no longer waits', async () => {
    await configure({ userApps: { publishing: { adminEnables: 'always' } } });
    const record = await api.createApp('anna');
    assert.equal((await publish('anna', record)).status, 200);
    assert.equal((await as('builder').get(`${ADMIN}/_waiting`)).body.items.length, 1);
    await configStore.writeJson(`apps/${SLUG}.json`, { ...(await appFile(SLUG)), enabled: true });
    await configCache.refreshAppsCache();
    assert.deepEqual((await as('builder').get(`${ADMIN}/_waiting`)).body.items, []);
  });
});

describe('POST /api/admin/user-apps/{appId}/_promote', () => {
  it('works with publishing switched off and always creates the app switched off', async () => {
    await configure({ userApps: { sharing: { allowPublish: false } } });
    const record = await sharedApp({ content: withUpload });

    const view = await as('root').get(`${ADMIN}/${record.id}`);
    assert.equal(view.status, 200, view.text);
    assert.deepEqual(view.body.takeOverPreview, {
      suggestedId: SLUG,
      capabilities: [{ id: 'upload' }],
      dropped: [],
      plain: false
    });

    const res = await promote('root', record);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.headers.location, `/api/admin/apps/${SLUG}`);
    assert.equal(res.body.id, SLUG);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(await appFile(SLUG), res.body);
    assert.equal(appConfigSchema.safeParse(res.body).success, true);

    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'promoted');
    assert.deepEqual(stored.publishedAs.by, { id: 'root', name: 'Ada Admin' });
    // The owner can no longer change the personal app; it keeps working.
    const owner = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(owner.body.permissions.canEdit, false);
    assert.equal(owner.body.permissions.canUse, true);
  });

  it('works with the feature off', async () => {
    const record = await api.createApp('anna');
    await configure({ features: { ...FEATURES, userApps: false } });
    const res = await promote('root', record);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.enabled, false);
  });

  it('takes the ID and the category the admin chose', async () => {
    const record = await api.createApp('anna');
    const res = await promote('root', record, { id: 'hr-job-ads', category: 'writing' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.id, 'hr-job-ads');
    assert.equal(res.body.category, 'writing');
    assert.equal((await api.repo().get(record.id)).publishedAs.appId, 'hr-job-ads');
  });

  it('a taken ID answers 409, an impossible one and an unknown key 400', async () => {
    const record = await api.createApp('anna');
    const taken = await promote('root', record, { id: APPS[0].id });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.body.code, 'CONFLICT');
    assert.equal(taken.body.details.reason, 'idTaken');
    for (const body of [{ id: 'Not An Id' }, { id: 'new' }, { id: record.id }, { owner: 'x' }]) {
      const res = await promote('root', record, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await api.repo().get(record.id)).state, 'active');
  });

  it('needs If-Match, refuses a stale one and a published app', async () => {
    const record = await api.createApp('anna');
    const missing = await as('root').post(`${ADMIN}/${record.id}/_promote`).send({});
    assert.equal(missing.status, 400);
    const stale = await promote('root', record, {}, '"42"');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'ETAG_MISMATCH');
    assert.equal(await appFile(SLUG), null);

    assert.equal((await promote('root', record)).status, 201);
    const again = await promote('root', await api.repo().get(record.id), { id: 'second' });
    assert.deepEqual(problem(again), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'promoted', appId: SLUG }
    });
    assert.equal(await appFile('second'), null);
  });

  it('drops a capability the admin may not use, and lists every action in the preview', async () => {
    await configure(jira());
    const record = await api.createApp('anna', { content: withBinding });

    const view = await as('root').get(`${ADMIN}/${record.id}`);
    assert.deepEqual(view.body.takeOverPreview.capabilities, [
      { id: 'upload' },
      { id: 'integration:jira', installationId: 'jira', name: 'jira', actions: ['search'] }
    ]);

    // An admin whose groups do not grant the installation.
    const groups = groupsWith();
    groups.groups.admins.permissions.integrations = [];
    await configure(jira({ groups }));
    const narrow = await as('root').get(`${ADMIN}/${record.id}`);
    assert.deepEqual(narrow.body.takeOverPreview.dropped, [
      { id: 'integration:jira', reason: 'youMayNot', name: 'jira' }
    ]);

    const res = await promote('root', record);
    assert.equal(res.status, 201, res.text);
    assert.equal('integrations' in res.body, false);
    assert.equal(res.body.upload.enabled, true);
    assert.equal(res.body.enabled, false);
  });

  it('is for full admins only', async () => {
    const record = await sharedApp();
    for (const name of ['anna', 'carol', 'builder', 'rootKey']) {
      const res = await promote(name, record);
      assert.equal(res.status, 403, `${name}: ${res.text}`);
    }
    const release = await as('builder').post(`${ADMIN}/${record.id}/_release`).send();
    assert.equal(release.status, 403);
    assert.equal((await api.repo().get(record.id)).state, 'active');
  });

  it('writes the two audit entries, by the admin', async () => {
    const record = await api.createApp('anna');
    assert.equal((await promote('root', record)).status, 201);
    const [share] = await api.audit(record.id, { resource: 'userAppShare', action: 'share' });
    assert.equal(validateAuditEntry(share).success, true);
    assert.equal(share.details.by, 'admin');
    assert.equal(share.details.enabled, false);
    assert.equal(share.details.revision, record.revision);
    const created = await createdEntry(record);
    assert.equal(validateAuditEntry(created).success, true);
    assert.equal(created.details.origin, 'personal');
    assert.equal(created.details.userAppId, record.id);
    assert.equal(created.details.ownerId, 'anna');
    assert.equal(created.details.contentHash, record.contentHash);
  });
});

describe('the way back', () => {
  it('release makes the app editable again, and the company app stays', async () => {
    await configure({ userApps: { publishing: { adminEnables: 'always' } } });
    const record = await sharedApp();
    assert.equal((await publish('anna', record)).status, 200);

    const view = await as('root').get(`${ADMIN}/${record.id}`);
    assert.equal(view.body.state, 'promoted');
    // The company app is not switched on: none of the two named members can use it.
    assert.equal(view.body.membersWithoutCompanyApp, 2);
    assert.equal('takeOverPreview' in view.body, false);

    const res = await as('root').post(`${ADMIN}/${record.id}/_release`).send();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.state, 'active');
    assert.equal(res.body.publishedAs, null);
    assert.ok(res.headers.etag);
    assert.equal('ownerPrincipal' in res.body, false);
    assert.ok(await appFile(SLUG), 'the company app stays');

    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'active');
    assert.equal(stored.publishedAs, null);
    const patch = await as('anna').patch(`/api/apps/${record.id}`).send({ icon: 'star' });
    assert.equal(patch.status, 200, patch.text);

    const [entry] = await api.audit(record.id, { resource: 'userApp', action: 'update' });
    assert.ok(entry, 'the release entry');
    assert.equal(validateAuditEntry(entry).success, true);
    assert.equal(entry.details.released, true);
    assert.equal(entry.details.appId, SLUG);
    assert.equal(entry.details.by, 'root');
    assert.ok(entry.details.contentHash);

    // A second release changes nothing and writes nothing.
    const again = await as('root').post(`${ADMIN}/${record.id}/_release`).send();
    assert.equal(again.status, 200);
    assert.equal(
      (await api.audit(record.id, { resource: 'userApp', action: 'update' })).filter(
        e => e.details?.released
      ).length,
      1
    );
  });

  it('release answers 409 while the company app is switched on', async () => {
    const record = await api.createApp('anna');
    assert.equal((await publish('anna', record)).status, 200);
    assert.equal((await appFile(SLUG)).enabled, true);
    const res = await as('root').post(`${ADMIN}/${record.id}/_release`).send();
    assert.deepEqual(problem(res), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'published', appId: SLUG }
    });
    assert.equal((await api.repo().get(record.id)).state, 'promoted');
  });

  it('a promoted app whose company app was deleted is editable without a release', async () => {
    const record = await sharedApp();
    assert.equal((await publish('anna', record)).status, 200);
    await configStore.remove(`apps/${SLUG}.json`);
    await configCache.refreshAppsCache();

    const view = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(view.body.state, 'active');
    assert.equal(view.body.permissions.canEdit, true);
    assert.equal('publishedAs' in view.body, false);
    const patch = await as('anna').patch(`/api/apps/${record.id}`).send({ icon: 'star' });
    assert.equal(patch.status, 200, patch.text);
    assert.equal((await api.repo().get(record.id)).state, 'active');
    // And it can be published again, under the name that is free again.
    const again = await publish('anna', await api.repo().get(record.id));
    assert.equal(again.status, 200, again.text);
    assert.equal((await api.repo().get(record.id)).publishedAs.appId, SLUG);
  });

  it('the ID of a deleted company app is not handed out while a record still holds it', async () => {
    const first = await sharedApp();
    assert.equal((await publish('anna', first)).status, 200);
    await configStore.remove(`apps/${SLUG}.json`);
    await configCache.refreshAppsCache();

    // Nobody read Anna's app since. Ben publishes his own app of the same name.
    const second = await api.createApp('ben');
    const res = await publish('ben', second);
    assert.equal(res.status, 200, res.text);
    assert.equal((await api.repo().get(second.id)).publishedAs.appId, `${SLUG}-2`);

    // Anna's app is still released, and does not point at Ben's app.
    const view = await as('anna').get(`/api/apps/${first.id}`);
    assert.equal(view.body.state, 'active');
    assert.equal(view.body.permissions.canEdit, true);
  });

  it('the release of a deleted company app is stored when the app is read', async () => {
    const record = await sharedApp();
    assert.equal((await publish('anna', record)).status, 200);
    const promotedRevision = (await api.repo().get(record.id)).revision;
    await configStore.remove(`apps/${SLUG}.json`);
    await configCache.refreshAppsCache();

    assert.equal((await as('ben').get(`/api/apps/${record.id}`)).status, 200);
    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'active');
    assert.equal(stored.publishedAs, null);
    assert.equal(stored.revision, promotedRevision);

    // An app of that ID written later is somebody else's: the record stays active.
    await configStore.writeJson(`apps/${SLUG}.json`, { ...APPS[0], id: SLUG });
    await configCache.refreshAppsCache();
    const view = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(view.body.state, 'active');
    assert.equal(view.body.permissions.canEdit, true);
  });

  it('an offer of an app whose company app was deleted can be accepted', async () => {
    const record = await sharedApp();
    assert.equal((await publish('anna', record)).status, 200);
    await configStore.remove(`apps/${SLUG}.json`);
    await configCache.refreshAppsCache();
    // The release is not stored yet: the offer is made on the stored record.
    await api
      .repo()
      .setOffer(
        record.id,
        { id: 'dave', name: 'Dave Lund' },
        { actor: { id: 'anna', name: 'Anna Schmidt' } }
      );
    const stored = await api.repo().get(record.id);
    assert.equal(stored.state, 'promoted');

    const res = await as('dave')
      .post(`/api/apps/${record.id}/owner-offer/_accept`)
      .set('If-Match', etag(stored))
      .send();
    assert.equal(res.status, 200, res.text);
    const after = await api.repo().get(record.id);
    assert.equal(after.owner.id, 'dave');
    assert.equal(after.state, 'active');
    assert.equal(after.publishedAs, null);
  });
});
