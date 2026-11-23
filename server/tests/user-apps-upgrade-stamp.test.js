// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one-time upgrade pass that stamps the company apps of 5.7.4
 * (`services/userApps/companyAppStamps.js`, design
 * concepts/app-builder-rework-2026-11/02-personal-apps.md, section 8.2).
 *
 * 5.7.4 published personal apps without writing `sourceUserAppId` into the
 * company app. A record now counts as promoted only while its company app
 * carries its ID, so without the pass every record published with 5.7.4
 * would be released on its first read after the update.
 *
 * App files are written through the configuration store into a scratch
 * contents directory, as in `user-apps-publish.test.js`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The contents directory is read when `server/config.js` is first imported.
const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-apps-stamp-'));
process.env.CONTENTS_DIR = contentsDir;

const { APPS, setConfig } = await import('./helpers/userAppsHarness.js');
const { startUserAppRoutesApi } = await import('./helpers/userAppRoutesApi.js');
const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { appConfigSchema } = await import('../validators/appConfigSchema.js');
const { areCompanyAppStampsChecked } = await import('../services/userApps/userAppAccess.js');
const {
  COMPANY_APP_STAMPS_MARKER,
  COMPANY_APP_STAMPS_MARKER_NAMESPACE,
  ensureCompanyAppStamps,
  resetCompanyAppStampsForTests,
  runCompanyAppStamps
} = await import('../services/userApps/companyAppStamps.js');

/** The ID of the company app a 5.7.4 publish wrote. */
const LEGACY_APP = 'job-ad-writer';
/** The stamp of a personal app that is not the one under test. */
const OTHER_USER_APP = 'uap_00000000000000000000000000000001';

let api;
let as;

before(async () => {
  api = await startUserAppRoutesApi();
  ({ as } = api);
  api.api.use(errorHandler);
});

after(async () => {
  resetCompanyAppStampsForTests();
  await api.stop();
  delete process.env.CONTENTS_DIR;
  await fs.rm(contentsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const appFile = id => configStore.readJson(`apps/${id}.json`);
const marker = () =>
  api.repo().documents.get(COMPANY_APP_STAMPS_MARKER_NAMESPACE, COMPANY_APP_STAMPS_MARKER);

/** A company app as 5.7.4 wrote it: valid, and without `sourceUserAppId`. */
const legacyApp = (extra = {}) => ({
  id: LEGACY_APP,
  name: { en: 'Job ad writer' },
  description: { en: 'Drafts a job ad from notes' },
  system: { en: 'You write job ads.' },
  color: '#4F46E5',
  icon: 'document-text',
  preferredModel: 'oa',
  enabled: false,
  ...extra
});

async function writeAppFile(app) {
  await configStore.writeJson(`apps/${app.id}.json`, app);
  await configCache.refreshAppsCache();
}

/** A record of Anna that a 5.7.4 publish left promoted under `appId`. */
const promotedRecord = (appId = LEGACY_APP) =>
  api.createApp('anna', {
    change: current => ({
      ...current,
      state: 'promoted',
      publishedAs: { appId, at: new Date().toISOString(), by: { id: 'anna', name: 'Anna' } }
    })
  });

/** What Anna's view of the app says, and what is stored. */
async function stateOf(record) {
  const view = await as('anna').get(`/api/apps/${record.id}`);
  assert.equal(view.status, 200);
  const stored = await api.repo().get(record.id);
  return { view: view.body.state, stored: stored.state, publishedAs: stored.publishedAs };
}

/** A logger that keeps what it was told. */
function recordingLog() {
  const lines = [];
  const at = level => (message, meta) => lines.push({ level, message, meta });
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

beforeEach(async () => {
  await api.reset();
  // A fresh installation that has not run the pass yet.
  resetCompanyAppStampsForTests();
  await api
    .repo()
    .documents.delete(COMPANY_APP_STAMPS_MARKER_NAMESPACE, COMPANY_APP_STAMPS_MARKER)
    .catch(() => {});
  for (const key of await configStore.list('apps')) await configStore.remove(`apps/${key}.json`);
  for (const app of APPS) await configStore.writeJson(`apps/${app.id}.json`, app);
  setConfig();
  await configCache.refreshAppsCache();
});

describe('the upgrade pass of the company app stamps', () => {
  it('stamps the company app of a 5.7.4 record, which stays promoted', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp());

    const result = await runCompanyAppStamps();
    assert.equal(result.status, 'done');
    assert.equal(result.stamped, 1);
    assert.equal(areCompanyAppStampsChecked(), true);

    const file = await appFile(LEGACY_APP);
    assert.equal(file.sourceUserAppId, record.id);
    assert.equal(appConfigSchema.safeParse(legacyApp()).success, true, 'the 5.7.4 file is valid');
    assert.equal(appConfigSchema.safeParse(file).success, true, 'the stamped file stays valid');
    // The rest of the file is as 5.7.4 wrote it.
    const { sourceUserAppId: _stamp, ...rest } = file;
    assert.deepEqual(rest, legacyApp());

    const state = await stateOf(record);
    assert.equal(state.view, 'promoted');
    assert.equal(state.stored, 'promoted');
    assert.equal(state.publishedAs.appId, LEGACY_APP);
    assert.ok((await marker())?.data?.completedAt, 'the pass records itself as done');
  });

  it('runs once per installation: a second start only reads the marker', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp());
    assert.equal((await runCompanyAppStamps()).status, 'done');

    // An admin later replaces the file by hand, without the stamp.
    await writeAppFile(legacyApp());
    // The next start of the server.
    resetCompanyAppStampsForTests();
    const again = await runCompanyAppStamps();
    assert.equal(again.status, 'alreadyDone');
    assert.equal(areCompanyAppStampsChecked(), true);
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, undefined, 'not stamped again');

    // The hand-made file is not the record's company app (finding 14).
    const state = await stateOf(record);
    assert.equal(state.view, 'active');
    assert.equal(state.stored, 'active');
    assert.equal(state.publishedAs, null);
  });

  it('leaves a file that carries another stamp', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp({ sourceUserAppId: OTHER_USER_APP }));

    const result = await runCompanyAppStamps();
    assert.equal(result.status, 'done');
    assert.equal(result.stamped, 0);
    assert.equal(result.otherStamp, 1);
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, OTHER_USER_APP);
    // Somebody else's app: the record is released, as before the pass.
    assert.equal((await stateOf(record)).stored, 'active');
  });

  it('stamps nothing when two records claim the same app ID, and warns', async () => {
    const first = await promotedRecord(LEGACY_APP);
    const second = await promotedRecord(LEGACY_APP.toUpperCase());
    await writeAppFile(legacyApp());
    const log = recordingLog();

    const result = await runCompanyAppStamps({ log });
    assert.equal(result.status, 'done');
    assert.equal(result.stamped, 0);
    assert.equal(result.conflicts, 1);
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, undefined);
    const warning = log.lines.find(line => line.level === 'warn');
    assert.ok(warning, 'a warning names the conflict');
    assert.deepEqual(new Set(warning.meta.userAppIds), new Set([first.id, second.id]));
  });

  it('skips a record whose company app file is gone', async () => {
    await promotedRecord('deleted-app');
    const result = await runCompanyAppStamps();
    assert.equal(result.status, 'done');
    assert.equal(result.missing, 1);
    assert.deepEqual(await configStore.list('apps'), APPS.map(app => app.id).sort());
  });

  it('runs while the feature is switched off', async () => {
    setConfig({ features: { userApps: false } });
    const record = await promotedRecord();
    await writeAppFile(legacyApp());
    assert.equal((await runCompanyAppStamps()).status, 'done');
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, record.id);
  });
});

describe('before the pass has completed', () => {
  it('an unstamped file keeps its record promoted (5.7.4 behaviour)', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp());

    assert.equal(areCompanyAppStampsChecked(), false);
    const state = await stateOf(record);
    assert.equal(state.view, 'promoted');
    assert.equal(state.stored, 'promoted');
    assert.equal(state.publishedAs.appId, LEGACY_APP);
  });

  it('a read waits for a pass in flight before it decides', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp());

    // A pass whose listing waits until the test opens the gate.
    let open;
    const gate = new Promise(resolve => {
      open = resolve;
    });
    const real = api.repo();
    const gated = Object.create(real);
    gated.listPromoted = async () => {
      await gate;
      return real.listPromoted();
    };
    const pass = ensureCompanyAppStamps({ repository: gated });

    let answered = false;
    const read = as('anna')
      .get(`/api/apps/${record.id}`)
      .then(res => {
        answered = true;
        return res;
      });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(answered, false, 'the read waits for the pass');

    open();
    assert.equal((await pass).status, 'done');
    const view = await read;
    assert.equal(view.body.state, 'promoted');
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, record.id);
    assert.equal((await api.repo().get(record.id)).state, 'promoted');
  });

  it('a failed pass writes no marker and releases nothing; the next start tries again', async () => {
    const record = await promotedRecord();
    await writeAppFile(legacyApp());
    const broken = Object.create(configStore);
    broken.updateJson = async () => {
      throw new Error('disk full');
    };
    const log = recordingLog();

    const failed = await runCompanyAppStamps({ store: broken, log });
    assert.equal(failed.status, 'failed');
    assert.equal(areCompanyAppStampsChecked(), false);
    assert.equal(await marker(), null);
    assert.ok(log.lines.some(line => line.level === 'error'));
    assert.equal((await stateOf(record)).stored, 'promoted');

    // The next start.
    const retried = await runCompanyAppStamps();
    assert.equal(retried.status, 'done');
    assert.equal((await appFile(LEGACY_APP)).sourceUserAppId, record.id);
    assert.equal((await stateOf(record)).stored, 'promoted');
  });
});

describe('after the pass', () => {
  it('a hand-made unstamped file under a held ID releases the record', async () => {
    const record = await promotedRecord();
    // Nothing to stamp yet: the company app was deleted.
    assert.equal((await runCompanyAppStamps()).status, 'done');
    // An admin then places a file by hand under the ID the record still holds.
    await writeAppFile(legacyApp());

    const state = await stateOf(record);
    assert.equal(state.view, 'active');
    assert.equal(state.stored, 'active');
    assert.equal(state.publishedAs, null);
    assert.ok(await appFile(LEGACY_APP), 'the hand-made file stays');
  });
});
