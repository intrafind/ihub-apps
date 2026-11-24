// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an admin allows personal apps (feature `userApps`, design sections 3.1
 * and 4.5): the feature, the two group permissions and the settings block.
 *
 * Pinned here:
 *
 *  - the feature is registered like `userProjects`: preview, off by default;
 *  - `userApps` and `userAppSharing` merge through group inheritance and are
 *    `false` for OAuth clients and authorization-code tokens;
 *  - `platform.userApps` has the keys and defaults of 4.5, wrong values are
 *    clamped, and the installation `ihub` or an entry without actions never
 *    counts;
 *  - the limit and the sharing audiences have the defaults of their project
 *    counterparts, so the two blocks cannot drift apart unnoticed;
 *  - the start-up warnings name a config app with a personal-shaped ID, and
 *    an app with the ID `new` while the feature is on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { featureRegistry, isFeatureEnabled } from '../featureRegistry.js';
import { RUNTIME_NAMESPACES, CONFIG_NAMESPACES } from '../storage/namespaces.js';
import {
  enhanceUserWithPermissions,
  getPermissionsForUser,
  resolveGroupInheritance
} from '../utils/authorization.js';
import { groupConfigSchema } from '../validators/groupConfigSchema.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { userAppSettingsSchema } from '../validators/userAppSchema.js';
import { DEFAULT_PROJECT_SETTINGS, projectSettings } from '../services/projects/projectSettings.js';
import {
  ADMIN_ENABLES_VALUES,
  DEFAULT_USER_APP_SETTINGS,
  USER_APPS_FEATURE,
  allowedInstallationActions,
  allowedUserAppShareTargets,
  changedUserAppSettingKeys,
  isBlockedOwner,
  isUserAppsEnabled,
  logUserAppWarnings,
  mergeUserAppSettings,
  userAppSettings,
  userAppWarnings,
  userAppsClientSettings
} from '../services/userApps/userAppSettings.js';
import {
  USER_APPS_NAMESPACE,
  USER_APP_REVISIONS_NAMESPACE,
  USER_APP_SHARES_NAMESPACE
} from '../services/userApps/UserAppRepository.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');
const readDefault = file =>
  JSON.parse(fs.readFileSync(path.join(defaultsDir, 'config', file), 'utf8'));

const PERSONAL_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';
const plain = value => JSON.parse(JSON.stringify(value));

describe('the feature', () => {
  const entry = featureRegistry.find(feature => feature.id === USER_APPS_FEATURE);
  const projects = featureRegistry.find(feature => feature.id === 'userProjects');

  it('is registered with the category, the default and the preview mark of userProjects', () => {
    assert.ok(entry, 'the feature userApps must be in the registry');
    assert.deepEqual(
      { category: entry.category, default: entry.default, preview: entry.preview },
      { category: projects.category, default: projects.default, preview: projects.preview }
    );
    assert.deepEqual(
      { category: entry.category, default: entry.default, preview: entry.preview },
      { category: 'preview', default: false, preview: true }
    );
  });

  it('sits right after userProjects and has a name and a description in English and German', () => {
    const ids = featureRegistry.map(feature => feature.id);
    assert.equal(ids.indexOf('userApps'), ids.indexOf('userProjects') + 1);
    assert.deepEqual(entry.name, { en: 'Personal apps', de: 'Persönliche Apps' });
    assert.ok(entry.description.en && entry.description.de);
    assert.match(entry.description.de, /Benutzer/);
  });

  it('is off until an admin switches it on', () => {
    assert.equal(isFeatureEnabled('userApps', {}), false);
    assert.equal(isUserAppsEnabled({}), false);
    assert.equal(isUserAppsEnabled({ userApps: true }), true);
    assert.equal(isUserAppsEnabled({ userProjects: true }), false);
  });
});

describe('the two group permissions', () => {
  it('are booleans of the group schema that default to false', () => {
    const parsed = groupConfigSchema.parse({ id: 'team', name: 'Team' });
    assert.equal(parsed.permissions.userApps, false);
    assert.equal(parsed.permissions.userAppSharing, false);
    const granted = groupConfigSchema.parse({
      id: 'team',
      name: 'Team',
      permissions: { userApps: true, userAppSharing: true }
    });
    assert.equal(granted.permissions.userApps, true);
    assert.equal(granted.permissions.userAppSharing, true);
    assert.equal(
      groupConfigSchema.safeParse({ id: 'team', name: 'Team', permissions: { userApps: 'yes' } })
        .success,
      false
    );
  });

  const config = () =>
    resolveGroupInheritance({
      groups: {
        base: { id: 'base', name: 'Base', permissions: { apps: ['chat'], userApps: true } },
        sharers: {
          id: 'sharers',
          name: 'Sharers',
          permissions: { apps: [], userAppSharing: true }
        },
        child: { id: 'child', name: 'Child', inherits: ['base'], permissions: { apps: [] } },
        grandchild: {
          id: 'grandchild',
          name: 'Grandchild',
          inherits: ['child', 'sharers'],
          permissions: { apps: [] }
        },
        plain: { id: 'plain', name: 'Plain', permissions: { apps: ['chat'] } },
        // A child cannot take away what a parent grants: the same rule as `projects`.
        denying: {
          id: 'denying',
          name: 'Denying',
          inherits: ['base'],
          permissions: { apps: [], userApps: false }
        }
      }
    });

  it('merge through inheritance, each on its own', () => {
    const { groups } = config();
    assert.equal(groups.base.permissions.userApps, true);
    // A group without parents is not rewritten: what it does not set stays unset.
    assert.notEqual(groups.base.permissions.userAppSharing, true);
    assert.equal(groups.child.permissions.userApps, true, 'inherited from the parent');
    assert.equal(groups.child.permissions.userAppSharing, false);
    assert.equal(groups.grandchild.permissions.userApps, true, 'through two levels');
    assert.equal(groups.grandchild.permissions.userAppSharing, true, 'from the second parent');
    assert.notEqual(groups.plain.permissions.userApps, true);
    assert.notEqual(groups.plain.permissions.userAppSharing, true);
    assert.equal(groups.denying.permissions.userApps, true);
  });

  it('reach a user through any of their groups', () => {
    configCache.setCacheEntry('config/groups.json', config());
    const none = getPermissionsForUser(['plain']);
    assert.equal(none.userApps, false);
    assert.equal(none.userAppSharing, false);
    const create = getPermissionsForUser(['plain', 'child']);
    assert.equal(create.userApps, true);
    assert.equal(create.userAppSharing, false);
    const both = getPermissionsForUser(['grandchild']);
    assert.equal(both.userApps, true);
    assert.equal(both.userAppSharing, true);
    const unknown = getPermissionsForUser(['no-such-group']);
    assert.equal(unknown.userApps, false);
    assert.equal(unknown.userAppSharing, false);
  });

  it('are false for an OAuth client, whatever its groups say', () => {
    configCache.setCacheEntry('config/groups.json', config());
    const client = enhanceUserWithPermissions(
      { id: 'client-1', isOAuthClient: true, groups: ['grandchild'], allowedApps: ['chat'] },
      {},
      {}
    );
    assert.equal(client.permissions.userApps, false);
    assert.equal(client.permissions.userAppSharing, false);
  });

  it('are false for an authorization-code token, and kept for a personal API key', () => {
    configCache.setCacheEntry('config/groups.json', config());
    const delegated = enhanceUserWithPermissions(
      { id: 'anna', groups: ['grandchild'], authMode: 'oauth_authorization_code' },
      {},
      {}
    );
    assert.equal(delegated.permissions.userApps, false);
    assert.equal(delegated.permissions.userAppSharing, false);

    const key = enhanceUserWithPermissions(
      { id: 'anna', groups: ['grandchild'], authMode: 'oauth_personal_key' },
      {},
      {}
    );
    assert.equal(key.permissions.userApps, true);
    assert.equal(key.permissions.userAppSharing, true);

    const person = enhanceUserWithPermissions({ id: 'anna', groups: ['grandchild'] }, {}, {});
    assert.equal(person.permissions.userApps, true);
    assert.equal(person.permissions.userAppSharing, true);
  });

  it('survive an admin save of a group: the route keeps both, as it keeps the project ones', () => {
    // The admin routes rebuild `permissions` key by key (`normalizeGroupPermissions`);
    // a permission missing there is dropped the next time an admin saves the group.
    const source = fs.readFileSync(
      path.join(defaultsDir, '..', 'routes', 'admin', 'groups.js'),
      'utf8'
    );
    const start = source.indexOf('function normalizeGroupPermissions');
    const normalizer = source.slice(start, source.indexOf('\n}\n', start));
    for (const key of ['projects', 'projectSharing', 'userApps', 'userAppSharing']) {
      assert.ok(
        normalizer.includes(`${key}: Boolean(incoming.${key} ?? existing.${key})`),
        `normalizeGroupPermissions must keep ${key}`
      );
    }
  });

  it('ship for the built-in groups as the project permissions do', () => {
    const { groups } = readDefault('groups.json');
    for (const [id, group] of Object.entries(groups)) {
      assert.equal(group.permissions.userApps, group.permissions.projects, `${id}.userApps`);
      assert.equal(
        group.permissions.userAppSharing,
        group.permissions.projectSharing,
        `${id}.userAppSharing`
      );
    }
    assert.equal(groups.anonymous.permissions.userApps, false);
    assert.equal(groups.authenticated.permissions.userAppSharing, true);
  });
});

describe('platform.userApps', () => {
  const EXPECTED = {
    limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5, ownerSnapshotMaxAgeDays: 30 },
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: false },
    capabilities: {
      modelChoice: true,
      upload: true,
      webSearch: false,
      skills: false,
      projects: false,
      integrations: [],
      webSearchLimits: { maxPageReads: 10 }
    },
    publishing: { adminEnables: 'withTools' },
    blockedOwners: []
  };

  it('has the keys and defaults of section 4.5', () => {
    assert.deepEqual(plain(DEFAULT_USER_APP_SETTINGS), EXPECTED);
    assert.deepEqual(userAppSettings(undefined), EXPECTED);
    assert.deepEqual(userAppSettings({}), EXPECTED);
    assert.deepEqual(userAppSettings({ userApps: {} }), EXPECTED);
  });

  it('the platform schema fills the same defaults', () => {
    const parsed = platformConfigSchema.parse({});
    assert.deepEqual(parsed.userApps, EXPECTED);
  });

  it('a fresh installation ships the same values', () => {
    const shipped = readDefault('platform.json');
    assert.deepEqual(shipped.userApps, EXPECTED);
    assert.deepEqual(userAppSettings(shipped), EXPECTED);
  });

  it('publishing is off by default, and an unknown value of adminEnables reads as withTools', () => {
    assert.equal(userAppSettings({}).sharing.allowPublish, false);
    assert.deepEqual(ADMIN_ENABLES_VALUES, ['withTools', 'always']);
    for (const value of ['never', 'off', '', null, 7, undefined]) {
      assert.equal(
        userAppSettings({ userApps: { publishing: { adminEnables: value } } }).publishing
          .adminEnables,
        'withTools',
        String(value)
      );
    }
    assert.equal(
      userAppSettings({ userApps: { publishing: { adminEnables: 'always' } } }).publishing
        .adminEnables,
      'always'
    );
  });

  it('clamps the limits: zero means no limit, a wrong value falls back', () => {
    const read = limits => userAppSettings({ userApps: { limits } }).limits;
    assert.equal(read({ maxAppsPerUser: 0 }).maxAppsPerUser, 0);
    assert.equal(read({ maxAppsPerUser: -5 }).maxAppsPerUser, 0);
    assert.equal(read({ maxAppsPerUser: 7.9 }).maxAppsPerUser, 7);
    assert.equal(read({ maxAppsPerUser: 'many' }).maxAppsPerUser, 20);
    assert.equal(read({ maxAppsPerUser: null }).maxAppsPerUser, 20);
    assert.equal(read({ maxOpenOffersPerUser: 0 }).maxOpenOffersPerUser, 5);
    assert.equal(read({ maxOpenOffersPerUser: -1 }).maxOpenOffersPerUser, 5);
    assert.equal(read({ maxOpenOffersPerUser: 3 }).maxOpenOffersPerUser, 3);
    assert.equal(read({ ownerSnapshotMaxAgeDays: 0 }).ownerSnapshotMaxAgeDays, 0);
    assert.equal(read({ ownerSnapshotMaxAgeDays: -3 }).ownerSnapshotMaxAgeDays, 0);
    assert.equal(read({ ownerSnapshotMaxAgeDays: 'x' }).ownerSnapshotMaxAgeDays, 30);
  });

  it('reads a switch only from a boolean', () => {
    const settings = userAppSettings({
      userApps: {
        sharing: { allowUsers: 'no', allowEveryone: 1, allowPublish: 'true' },
        capabilities: { webSearch: 'on', upload: 0, skills: true }
      }
    });
    assert.equal(settings.sharing.allowUsers, true);
    assert.equal(settings.sharing.allowEveryone, false);
    assert.equal(settings.sharing.allowPublish, false);
    assert.equal(settings.capabilities.webSearch, false);
    assert.equal(settings.capabilities.upload, true);
    assert.equal(settings.capabilities.skills, true);
  });

  it('never counts the installation "ihub", an entry without actions or a repeated one', () => {
    const settings = userAppSettings({
      userApps: {
        capabilities: {
          integrations: [
            { id: 'ihub', actions: ['ask_user'] },
            { id: 'jira', actions: ['search_issues', 'search_issues', '*', ''] },
            { id: 'confluence' },
            { id: 'sharepoint', actions: [] },
            { id: 'wildcard', actions: ['*'] },
            { id: 'jira', actions: ['create_issue'] },
            { actions: ['x'] },
            null,
            'jira'
          ]
        },
        blockedOwners: ['mallory', 'mallory', '', 7, null]
      }
    });
    assert.deepEqual(settings.capabilities.integrations, [
      { id: 'jira', actions: ['search_issues'] }
    ]);
    assert.deepEqual(allowedInstallationActions(settings, 'jira'), ['search_issues']);
    assert.equal(allowedInstallationActions(settings, 'ihub'), null);
    assert.equal(allowedInstallationActions(settings, 'confluence'), null);
    assert.deepEqual(settings.blockedOwners, ['mallory']);
    assert.equal(isBlockedOwner(settings, 'mallory'), true);
    assert.equal(isBlockedOwner(settings, 'anna'), false);
    assert.equal(isBlockedOwner(settings, undefined), false);
    assert.equal(isBlockedOwner(undefined, 'mallory'), false);
  });

  it('the platform schema refuses the installation "ihub" and an entry without actions', () => {
    const parse = integrations =>
      platformConfigSchema.safeParse({ userApps: { capabilities: { integrations } } });
    assert.equal(parse([{ id: 'jira', actions: ['search_issues'] }]).success, true);
    assert.equal(parse([{ id: 'ihub', actions: ['ask_user'] }]).success, false);
    assert.equal(parse([{ id: 'jira' }]).success, false);
    assert.equal(parse([{ id: 'jira', actions: [] }]).success, false);
    assert.equal(
      platformConfigSchema.safeParse({ userApps: { publishing: { adminEnables: 'never' } } })
        .success,
      false
    );
  });

  it('tells the share dialog which audiences are allowed', () => {
    assert.deepEqual(allowedUserAppShareTargets(userAppSettings({})), {
      user: true,
      group: true,
      everyone: false
    });
    assert.deepEqual(
      allowedUserAppShareTargets(
        userAppSettings({ userApps: { sharing: { allowUsers: false, allowEveryone: true } } })
      ),
      { user: false, group: true, everyone: true }
    );
    assert.deepEqual(allowedUserAppShareTargets(undefined), {
      user: false,
      group: false,
      everyone: false
    });
  });

  it('tells the client the limit, the audiences and what an app may use', () => {
    const client = userAppsClientSettings(
      userAppSettings({
        userApps: {
          limits: { maxAppsPerUser: 3 },
          capabilities: { integrations: [{ id: 'jira', actions: ['search_issues'] }] },
          blockedOwners: ['mallory']
        }
      })
    );
    assert.equal(client.maxApps, 3);
    assert.equal(client.sharing.allowPublish, false);
    assert.deepEqual(client.capabilities.integrations, [
      { id: 'jira', actions: ['search_issues'] }
    ]);
    assert.equal(JSON.stringify(client).includes('mallory'), false, 'no blocked owner is sent');
  });
});

describe('the block follows platform.projects', () => {
  const PAIRS = [
    ['limits.maxAppsPerUser', 'limits.maxProjectsPerUser'],
    ['sharing.allowUsers', 'sharing.allowUsers'],
    ['sharing.allowGroups', 'sharing.allowGroups'],
    ['sharing.allowEveryone', 'sharing.allowEveryone'],
    // The publishing switch: for projects it is the catalog.
    ['sharing.allowPublish', 'sharing.allowCatalog']
  ];
  const at = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);

  it('the limit and the sharing audiences have the defaults of their project counterparts', () => {
    const apps = userAppSettings({});
    const projects = projectSettings({});
    for (const [appKey, projectKey] of PAIRS) {
      assert.notEqual(at(apps, appKey), undefined, `platform.userApps.${appKey} must exist`);
      assert.equal(
        at(apps, appKey),
        at(projects, projectKey),
        `platform.userApps.${appKey} must have the default of platform.projects.${projectKey}`
      );
      assert.equal(at(DEFAULT_USER_APP_SETTINGS, appKey), at(DEFAULT_PROJECT_SETTINGS, projectKey));
    }
  });

  it('the shipped platform.json agrees for the same pairs', () => {
    const shipped = readDefault('platform.json');
    for (const [appKey, projectKey] of PAIRS) {
      assert.equal(at(shipped.userApps, appKey), at(shipped.projects, projectKey), appKey);
    }
  });

  it('the sharing block has the three project audiences and one publishing switch, no more', () => {
    const projectAudiences = Object.keys(projectSettings({}).sharing).filter(
      key => key !== 'allowCatalog'
    );
    assert.deepEqual(
      Object.keys(userAppSettings({}).sharing).sort(),
      [...projectAudiences, 'allowPublish'].sort()
    );
  });

  it('both limits read zero and a negative number as "no limit"', () => {
    for (const value of [0, -1]) {
      assert.equal(
        userAppSettings({ userApps: { limits: { maxAppsPerUser: value } } }).limits.maxAppsPerUser,
        projectSettings({ projects: { limits: { maxProjectsPerUser: value } } }).limits
          .maxProjectsPerUser
      );
    }
  });
});

describe('a settings change', () => {
  it('writes only the keys sent and keeps the rest of the block', () => {
    const stored = {
      limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5 },
      sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: false },
      capabilities: { upload: true, integrations: [{ id: 'jira', actions: ['a'] }] },
      blockedOwners: ['mallory'],
      somethingLater: { kept: true }
    };
    const next = mergeUserAppSettings(stored, {
      sharing: { allowPublish: true },
      capabilities: { webSearch: true }
    });
    assert.deepEqual(next, {
      limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5 },
      sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: true },
      capabilities: {
        upload: true,
        integrations: [{ id: 'jira', actions: ['a'] }],
        webSearch: true
      },
      blockedOwners: ['mallory'],
      somethingLater: { kept: true }
    });
    assert.equal(stored.sharing.allowPublish, false, 'the stored block is not modified');
  });

  it('replaces the two lists as a whole, and an empty list clears', () => {
    const stored = {
      capabilities: { integrations: [{ id: 'jira', actions: ['a'] }] },
      blockedOwners: ['mallory']
    };
    const next = mergeUserAppSettings(stored, {
      capabilities: { integrations: [{ id: 'confluence', actions: ['search'] }] },
      blockedOwners: []
    });
    assert.deepEqual(next.capabilities.integrations, [{ id: 'confluence', actions: ['search'] }]);
    assert.deepEqual(next.blockedOwners, []);
    assert.deepEqual(mergeUserAppSettings(undefined, { limits: { maxAppsPerUser: 3 } }), {
      limits: { maxAppsPerUser: 3 }
    });
  });

  it('names the changed keys for the audit entry', () => {
    assert.deepEqual(
      changedUserAppSettingKeys({
        sharing: { allowPublish: true },
        limits: { maxAppsPerUser: 3 },
        blockedOwners: ['mallory']
      }),
      ['limits.maxAppsPerUser', 'sharing.allowPublish', 'blockedOwners']
    );
    assert.deepEqual(changedUserAppSettingKeys({}), []);
  });

  it('applies on the next read, without a restart', () => {
    const before = configCache.getPlatform();
    try {
      configCache.setCacheEntry('config/platform.json', { userApps: { blockedOwners: [] } });
      assert.equal(isBlockedOwner(userAppSettings(configCache.getPlatform()), 'mallory'), false);
      configCache.setCacheEntry('config/platform.json', {
        userApps: mergeUserAppSettings(configCache.getPlatform().userApps, {
          blockedOwners: ['mallory']
        })
      });
      assert.equal(isBlockedOwner(userAppSettings(configCache.getPlatform()), 'mallory'), true);
    } finally {
      configCache.setCacheEntry('config/platform.json', before || {});
    }
  });
});

describe('the start-up warnings', () => {
  const apps = [{ id: 'chat' }, { id: 'uap_helper' }, { id: PERSONAL_ID }, { id: 'new' }];

  it('name a config app with a personal-shaped ID, with the feature on or off', () => {
    for (const enabled of [false, true]) {
      const findings = userAppWarnings({ apps, enabled });
      const clash = findings.filter(finding => finding.code === 'PERSONAL_SHAPED_APP_ID');
      assert.deepEqual(
        clash.map(finding => finding.appId),
        [PERSONAL_ID],
        `enabled: ${enabled}`
      );
      assert.match(clash[0].message, /reserved for personal apps/);
    }
  });

  it('name an app with the ID "new" only while the feature is on', () => {
    assert.equal(
      userAppWarnings({ apps, enabled: false }).some(f => f.code === 'APP_ID_NEW_SHADOWED'),
      false
    );
    const shadowed = userAppWarnings({ apps, enabled: true }).filter(
      finding => finding.code === 'APP_ID_NEW_SHADOWED'
    );
    assert.deepEqual(
      shadowed.map(finding => finding.appId),
      ['new']
    );
  });

  it('say nothing about an installation without such apps', () => {
    assert.deepEqual(userAppWarnings({ apps: [{ id: 'chat' }, { id: 'uap_helper' }] }), []);
    assert.deepEqual(userAppWarnings(), []);
  });

  it('are logged from the config cache, disabled apps included, and never throw', () => {
    const lines = [];
    const log = { warn: (message, meta) => lines.push({ message, meta }) };
    const appsBefore = configCache.getApps(true)?.data;
    const featuresBefore = configCache.getFeatures();
    try {
      configCache.setCacheEntry('config/apps.json', [
        { id: 'chat', enabled: true },
        { id: PERSONAL_ID, enabled: false },
        { id: 'new', enabled: true }
      ]);
      configCache.setCacheEntry('config/features.json', { userApps: false });
      assert.deepEqual(
        logUserAppWarnings({ log }).map(finding => finding.code),
        ['PERSONAL_SHAPED_APP_ID']
      );
      assert.equal(lines.length, 1);
      assert.equal(lines[0].meta.appId, PERSONAL_ID);

      configCache.setCacheEntry('config/features.json', { userApps: true });
      assert.deepEqual(
        logUserAppWarnings({ log })
          .map(finding => finding.code)
          .sort(),
        ['APP_ID_NEW_SHADOWED', 'PERSONAL_SHAPED_APP_ID']
      );
    } finally {
      configCache.setCacheEntry('config/apps.json', appsBefore || []);
      configCache.setCacheEntry('config/features.json', featuresBefore || {});
    }
  });
});

describe('the limit of pages a personal app may open (webSearchLimits)', () => {
  const limit = value =>
    userAppSettings({ userApps: { capabilities: { webSearchLimits: value } } });

  it('reads the limit, and falls back to the default for anything that is not a number', () => {
    assert.equal(limit({ maxPageReads: 4 }).capabilities.webSearchLimits.maxPageReads, 4);
    for (const value of [
      {},
      { maxPageReads: 'many' },
      { maxPageReads: 0 },
      { maxPageReads: -3 },
      null
    ]) {
      assert.equal(
        limit(value).capabilities.webSearchLimits.maxPageReads,
        10,
        JSON.stringify(value)
      );
    }
  });

  it('never reads more than the schema of an app allows', () => {
    assert.equal(limit({ maxPageReads: 999 }).capabilities.webSearchLimits.maxPageReads, 50);
  });

  it('is accepted by the body of the settings route within 1 to 50, and nothing else in it', () => {
    const parse = value =>
      userAppSettingsSchema.safeParse({ capabilities: { webSearchLimits: value } });
    assert.equal(parse({ maxPageReads: 4 }).success, true);
    assert.equal(parse({}).success, true);
    for (const value of [
      { maxPageReads: 0 },
      { maxPageReads: 51 },
      { maxPageReads: 1.5 },
      { max: 3 }
    ]) {
      assert.equal(parse(value).success, false, JSON.stringify(value));
    }
  });

  it('changes alone when the body names only it, and is a key of the audit entry', () => {
    const stored = { capabilities: { webSearch: true, skills: true } };
    const body = { capabilities: { webSearchLimits: { maxPageReads: 3 } } };
    assert.deepEqual(mergeUserAppSettings(stored, body).capabilities, {
      webSearch: true,
      skills: true,
      webSearchLimits: { maxPageReads: 3 }
    });
    assert.deepEqual(changedUserAppSettingKeys(body), ['capabilities.webSearchLimits']);
  });
});

describe('the switch for linked projects', () => {
  it('is off by default, and reads only a boolean', () => {
    assert.equal(userAppSettings({}).capabilities.projects, false);
    for (const value of ['yes', 1, null, undefined, {}]) {
      const read = userAppSettings({ userApps: { capabilities: { projects: value } } });
      assert.equal(read.capabilities.projects, false, String(value));
    }
    assert.equal(
      userAppSettings({ userApps: { capabilities: { projects: true } } }).capabilities.projects,
      true
    );
  });

  it('is a boolean of the body of the settings route, and an audit key when it is named', () => {
    assert.equal(
      userAppSettingsSchema.safeParse({ capabilities: { projects: true } }).success,
      true
    );
    assert.equal(
      userAppSettingsSchema.safeParse({ capabilities: { projects: 'on' } }).success,
      false
    );
    assert.deepEqual(changedUserAppSettingKeys({ capabilities: { projects: true } }), [
      'capabilities.projects'
    ]);
  });
});

describe('the namespaces', () => {
  it('are runtime namespaces, and nothing is added to the configuration namespaces', () => {
    assert.equal(RUNTIME_NAMESPACES.userApps, 'user-apps');
    assert.equal(RUNTIME_NAMESPACES.userAppShares, 'user-app-shares');
    assert.equal(RUNTIME_NAMESPACES.userAppRevisions, 'user-app-revisions');
    const declared = new Set(Object.values(RUNTIME_NAMESPACES));
    for (const ns of [
      USER_APPS_NAMESPACE,
      USER_APP_SHARES_NAMESPACE,
      USER_APP_REVISIONS_NAMESPACE
    ]) {
      assert.ok(declared.has(ns), ns);
    }
    const config = JSON.stringify(CONFIG_NAMESPACES);
    assert.equal(config.includes('user-app'), false);
  });
});
