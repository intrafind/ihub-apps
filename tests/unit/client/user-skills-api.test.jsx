/**
 * The personal skills API module (client/src/api/endpoints/userSkills.js)
 * against the user skills contract: every call hits the agreed URL with the
 * agreed method and body, and every write drops the cached `/api/skills`
 * picker list so a new, changed or revoked skill shows up in the `/` picker
 * the next time it opens.
 *
 * The axios client is mocked (client.js reads `import.meta`, which the Jest
 * transform cannot evaluate); requestHandler and the cache are real.
 */

jest.mock('../../../client/src/api/client', () => ({
  API_REQUEST_TIMEOUT: 30000,
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn()
  }
}));

import { apiClient } from '../../../client/src/api/client';
import cache from '../../../client/src/utils/cache';
import {
  createUserSkill,
  deleteUserSkill,
  duplicateGlobalSkill,
  duplicateUserSkill,
  fetchAdminUserSkills,
  fetchUserSkill,
  fetchUserSkills,
  fetchUserSkillSettings,
  fetchUserSkillShareTargets,
  fetchUserSkillVersion,
  fetchUserSkillVersions,
  invalidateSkillsPickerCache,
  promoteUserSkill,
  restoreUserSkillVersion,
  saveUserSkillSettings,
  transferUserSkill,
  updateUserSkill,
  updateUserSkillShares
} from '../../../client/src/api/endpoints/userSkills';

const ok = data => Promise.resolve({ status: 200, data, headers: {} });

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
  for (const method of ['get', 'post', 'put', 'delete']) {
    apiClient[method].mockImplementation(() => ok({ ok: true }));
  }
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

/** Seed the cache with the picker list the way `fetchSkills` stores it. */
const seedPickerCache = () => {
  cache.set('skills', { data: ['plain'] });
  cache.set('skills?language=de', { data: ['de'] });
  cache.set('skill_content?name=x', { data: 'content' });
};

describe('reads', () => {
  test('fetchUserSkills lists a scope (all by default)', async () => {
    await fetchUserSkills();
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills', { params: { scope: 'all' } });
    await fetchUserSkills('shared');
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills', {
      params: { scope: 'shared' }
    });
  });

  test('fetchUserSkill loads one skill, id encoded', async () => {
    await fetchUserSkill('usk_a/b');
    expect(apiClient.get).toHaveBeenCalledWith('/user-skills/usk_a%2Fb');
  });

  test('versions: the list and one revision', async () => {
    await fetchUserSkillVersions('usk_1');
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills/usk_1/versions');
    await fetchUserSkillVersion('usk_1', 3);
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills/usk_1/versions/3');
  });

  test('share targets send the query (empty when missing)', async () => {
    await fetchUserSkillShareTargets('ja');
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills/share-targets', {
      params: { q: 'ja' }
    });
    await fetchUserSkillShareTargets();
    expect(apiClient.get).toHaveBeenLastCalledWith('/user-skills/share-targets', {
      params: { q: '' }
    });
  });

  test('admin list and settings', async () => {
    apiClient.get.mockImplementationOnce(() =>
      ok({ skills: [{ id: 'usk_1' }], truncated: false, available: true })
    );
    await expect(fetchAdminUserSkills()).resolves.toEqual({
      skills: [{ id: 'usk_1' }],
      truncated: false,
      available: true
    });
    expect(apiClient.get).toHaveBeenLastCalledWith('/admin/user-skills');

    await fetchUserSkillSettings();
    expect(apiClient.get).toHaveBeenLastCalledWith('/admin/user-skills/settings');
  });

  test('reads leave the picker cache alone', async () => {
    seedPickerCache();
    await fetchUserSkills();
    await fetchUserSkill('usk_1');
    expect(cache.get('skills')).not.toBeNull();
  });
});

describe('writes', () => {
  const body = {
    name: 'weekly-report',
    description: 'Drafts the weekly report. Use when asked for one.',
    body: '# Weekly report',
    files: [{ path: 'references/template.md', content: '…' }]
  };

  test.each([
    ['createUserSkill', () => createUserSkill(body), 'post', ['/user-skills', body]],
    [
      'updateUserSkill',
      () => updateUserSkill('usk_1', { ...body, expectedRevision: 3 }),
      'put',
      ['/user-skills/usk_1', { ...body, expectedRevision: 3 }]
    ],
    ['deleteUserSkill', () => deleteUserSkill('usk_1'), 'delete', ['/user-skills/usk_1']],
    [
      'updateUserSkillShares',
      () => updateUserSkillShares('usk_1', [{ type: 'group', id: 'users', permission: 'use' }]),
      'put',
      ['/user-skills/usk_1/shares', { shares: [{ type: 'group', id: 'users', permission: 'use' }] }]
    ],
    [
      'transferUserSkill',
      () => transferUserSkill('usk_1', 'u2'),
      'put',
      ['/user-skills/usk_1/owner', { ownerId: 'u2' }]
    ],
    [
      'duplicateUserSkill',
      () => duplicateUserSkill('usk_1'),
      'post',
      ['/user-skills/usk_1/duplicate', {}]
    ],
    [
      'duplicateUserSkill with a name',
      () => duplicateUserSkill('usk_1', { name: 'copy' }),
      'post',
      ['/user-skills/usk_1/duplicate', { name: 'copy' }]
    ],
    [
      'duplicateGlobalSkill',
      () => duplicateGlobalSkill('brand-voice'),
      'post',
      ['/skills/brand-voice/duplicate', {}]
    ],
    [
      'restoreUserSkillVersion',
      () => restoreUserSkillVersion('usk_1', 2),
      'post',
      ['/user-skills/usk_1/versions/2/restore']
    ],
    [
      'promoteUserSkill',
      () => promoteUserSkill('usk_1', { name: 'weekly-report' }),
      'post',
      ['/admin/user-skills/usk_1/promote', { name: 'weekly-report' }]
    ],
    [
      'saveUserSkillSettings',
      () => saveUserSkillSettings({ enabled: false }),
      'put',
      ['/admin/user-skills/settings', { enabled: false }]
    ]
  ])('%s calls the contract endpoint and drops the picker cache', async (_, call, method, args) => {
    seedPickerCache();
    await call();
    expect(apiClient[method]).toHaveBeenCalledTimes(1);
    expect(apiClient[method]).toHaveBeenCalledWith(...args);
    expect(cache.get('skills')).toBeNull();
    expect(cache.get('skills?language=de')).toBeNull();
    // Only the picker list: other skill entries stay.
    expect(cache.get('skill_content?name=x')).not.toBeNull();
  });

  test('a failed write still drops the picker cache and keeps the error code', async () => {
    seedPickerCache();
    apiClient.put.mockImplementationOnce(() =>
      Promise.reject({
        response: {
          status: 409,
          data: { error: 'Conflict', details: { code: 'REVISION_CONFLICT' } }
        },
        config: {}
      })
    );
    const error = await updateUserSkill('usk_1', body).catch(err => err);
    expect(error.status).toBe(409);
    expect(error.originalError.response.data.details.code).toBe('REVISION_CONFLICT');
    expect(cache.get('skills')).toBeNull();
  });

  test('the write returns the server view', async () => {
    apiClient.post.mockImplementationOnce(() => ok({ id: 'usk_new', name: 'weekly-report' }));
    await expect(createUserSkill(body)).resolves.toEqual({ id: 'usk_new', name: 'weekly-report' });
  });
});

test('invalidateSkillsPickerCache drops only the picker list', () => {
  seedPickerCache();
  cache.set('skillsets', { data: 'other' });
  expect(invalidateSkillsPickerCache()).toBe(2);
  expect(cache.get('skillsets')).not.toBeNull();
});
