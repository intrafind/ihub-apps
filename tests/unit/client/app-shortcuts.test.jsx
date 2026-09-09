import {
  APP_SHORTCUT_MODES,
  DEFAULT_APP_SHORTCUT_MODE,
  DEFAULT_SIDEBAR_APPS_COUNT,
  DEFAULT_START_PAGE_APPS_COUNT,
  MAX_APP_SHORTCUTS,
  rankAppShortcuts,
  readAppShortcutConfig
} from '../../../client/src/utils/appShortcuts';

/**
 * The start page grid and the sidebar's Apps section show the same short list
 * of apps, so they share one ranking and one piece of config. Two promises
 * hold everywhere: a user's own favorites are never pushed off the list by
 * configuration, and a hand-edited ui.json can never produce a broken list.
 */

const ui = startPage => ({ startPage });

describe('readAppShortcutConfig', () => {
  test('falls back to the built-in defaults', () => {
    for (const config of [undefined, {}, ui(undefined), ui({})]) {
      expect(readAppShortcutConfig(config)).toEqual({
        mode: DEFAULT_APP_SHORTCUT_MODE,
        featuredAppIds: [],
        startPageCount: DEFAULT_START_PAGE_APPS_COUNT,
        sidebarCount: DEFAULT_SIDEBAR_APPS_COUNT
      });
    }
  });

  test('reads what the admin configured', () => {
    expect(
      readAppShortcutConfig(
        ui({
          appsMode: 'recent',
          appsCount: 6,
          sidebarAppsCount: 3,
          featuredAppIds: ['chat', 'translate']
        })
      )
    ).toEqual({
      mode: 'recent',
      featuredAppIds: ['chat', 'translate'],
      startPageCount: 6,
      sidebarCount: 3
    });
  });

  test('0 hides a list and is not mistaken for "unset"', () => {
    const config = readAppShortcutConfig(ui({ appsCount: 0, sidebarAppsCount: 0 }));
    expect(config.startPageCount).toBe(0);
    expect(config.sidebarCount).toBe(0);
  });

  test('clamps and repairs values a hand-edited config could hold', () => {
    const config = readAppShortcutConfig(
      ui({
        appsMode: 'nonsense',
        appsCount: 999,
        sidebarAppsCount: -4,
        featuredAppIds: ['chat', '', 'chat', null, 'translate', 7]
      })
    );
    expect(config.mode).toBe(DEFAULT_APP_SHORTCUT_MODE);
    expect(config.startPageCount).toBe(MAX_APP_SHORTCUTS);
    expect(config.sidebarCount).toBe(0);
    // Blanks, duplicates and non-strings cannot claim a slot.
    expect(config.featuredAppIds).toEqual(['chat', 'translate']);
  });

  test('a non-numeric or non-array value falls back instead of throwing', () => {
    const config = readAppShortcutConfig(
      ui({ appsCount: 'four', sidebarAppsCount: null, featuredAppIds: 'chat' })
    );
    expect(config.startPageCount).toBe(DEFAULT_START_PAGE_APPS_COUNT);
    expect(config.sidebarCount).toBe(DEFAULT_SIDEBAR_APPS_COUNT);
    expect(config.featuredAppIds).toEqual([]);
  });

  test('the accepted modes are the two the admin UI offers', () => {
    expect(APP_SHORTCUT_MODES).toEqual(['order', 'recent']);
  });
});

describe('rankAppShortcuts', () => {
  const apps = [
    { id: 'alpha', order: 3, name: { en: 'Alpha' } },
    { id: 'beta', order: 1, name: { en: 'Beta' } },
    { id: 'gamma', order: 2, name: { en: 'Gamma' } },
    { id: 'delta', name: { en: 'Delta' } }
  ];
  const ids = list => list.map(app => app.id);

  test('ranks by the configured order, apps without one last', () => {
    expect(ids(rankAppShortcuts(apps))).toEqual(['beta', 'gamma', 'alpha', 'delta']);
  });

  test('leaves the input array alone', () => {
    const input = [...apps];
    rankAppShortcuts(input, { favoriteAppIds: ['delta'] });
    expect(input).toEqual(apps);
  });

  test('favorites come first, in the configured order among themselves', () => {
    expect(ids(rankAppShortcuts(apps, { favoriteAppIds: ['delta', 'alpha'] }))).toEqual([
      'alpha',
      'delta',
      'beta',
      'gamma'
    ]);
  });

  test('the admin default apps follow the favorites, in the admin order', () => {
    expect(ids(rankAppShortcuts(apps, { featuredAppIds: ['delta', 'gamma'] }))).toEqual([
      'delta',
      'gamma',
      'beta',
      'alpha'
    ]);
  });

  test('a favorite outranks the admin default apps', () => {
    // `alpha` sorts last on order and is not a default app — being a favorite
    // still puts it on top, which is the promise the sidebar and start page make.
    expect(
      ids(
        rankAppShortcuts(apps, {
          favoriteAppIds: ['alpha'],
          featuredAppIds: ['delta', 'gamma']
        })
      )
    ).toEqual(['alpha', 'delta', 'gamma', 'beta']);
  });

  test('recent mode ranks the most recently used first', () => {
    expect(
      ids(rankAppShortcuts(apps, { mode: 'recent', recentAppIds: ['delta', 'alpha'] }))
    ).toEqual(['delta', 'alpha', 'beta', 'gamma']);
  });

  test('recent mode still keeps favorites and default apps in front', () => {
    expect(
      ids(
        rankAppShortcuts(apps, {
          mode: 'recent',
          recentAppIds: ['alpha', 'gamma'],
          favoriteAppIds: ['beta'],
          featuredAppIds: ['delta']
        })
      )
    ).toEqual(['beta', 'delta', 'alpha', 'gamma']);
  });

  test('recent ids that are not accessible apps are simply ignored', () => {
    expect(
      ids(rankAppShortcuts(apps, { mode: 'recent', recentAppIds: ['deleted', 'gamma'] }))
    ).toEqual(['gamma', 'beta', 'alpha', 'delta']);
  });

  test('apps that tie on everything fall back to their localized name', () => {
    const untidy = [
      { id: 'b', name: { en: 'Second' } },
      { id: 'a', name: { en: 'First' } }
    ];
    expect(ids(rankAppShortcuts(untidy, { currentLanguage: 'en' }))).toEqual(['a', 'b']);
  });

  test('survives apps without a name and a missing list', () => {
    expect(ids(rankAppShortcuts([{ id: 'b' }, { id: 'a' }]))).toEqual(['a', 'b']);
    expect(rankAppShortcuts(undefined)).toEqual([]);
    expect(rankAppShortcuts(null, { favoriteAppIds: null, featuredAppIds: null })).toEqual([]);
  });
});
