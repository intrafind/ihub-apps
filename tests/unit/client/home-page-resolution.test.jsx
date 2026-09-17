import {
  START_PAGE_PATH,
  APPS_PAGE_PATH,
  DEFAULT_HOME_PAGE,
  HOME_PAGE_CHOICES,
  resolveHomePath,
  pickDefaultChatApp
} from '../../../client/src/utils/homePage';

/**
 * "/" is a pointer, never a page of its own: admins choose which view it opens
 * (`ui.json → startPage.defaultPage`) and every candidate has its own route, so
 * the resolver must always hand back a real one. A half-configured choice must
 * never strand anyone on a broken route.
 */

const ui = startPage => ({ startPage });

describe('resolveHomePath', () => {
  test('points at the start page when nothing is configured', () => {
    expect(DEFAULT_HOME_PAGE).toBe('start');
    expect(START_PAGE_PATH).toBe('/start');
    expect(resolveHomePath(undefined)).toBe(START_PAGE_PATH);
    expect(resolveHomePath({})).toBe(START_PAGE_PATH);
    expect(resolveHomePath(ui({}))).toBe(START_PAGE_PATH);
    expect(resolveHomePath(ui({ defaultPage: 'start' }))).toBe(START_PAGE_PATH);
  });

  test('points at the apps browser', () => {
    expect(resolveHomePath(ui({ defaultPage: 'apps' }))).toBe(APPS_PAGE_PATH);
    expect(APPS_PAGE_PATH).toBe('/apps');
  });

  test('points at content pages and apps', () => {
    expect(resolveHomePath(ui({ defaultPage: 'page', defaultPageId: 'welcome' }))).toBe(
      '/pages/welcome'
    );
    expect(resolveHomePath(ui({ defaultPage: 'app', defaultPageAppId: 'chat' }))).toBe(
      '/apps/chat'
    );
  });

  test('falls back to the start page when the target is missing', () => {
    expect(resolveHomePath(ui({ defaultPage: 'page' }))).toBe(START_PAGE_PATH);
    expect(resolveHomePath(ui({ defaultPage: 'page', defaultPageId: '' }))).toBe(START_PAGE_PATH);
    expect(resolveHomePath(ui({ defaultPage: 'app' }))).toBe(START_PAGE_PATH);
    // An unrecognised value (hand-edited config, older client) is not a dead end.
    expect(resolveHomePath(ui({ defaultPage: 'nonsense' }))).toBe(START_PAGE_PATH);
  });

  test('escapes ids so they cannot break out of their route', () => {
    expect(resolveHomePath(ui({ defaultPage: 'page', defaultPageId: 'a/../b' }))).toBe(
      '/pages/a%2F..%2Fb'
    );
  });

  test('the accepted choices are the four the admin UI offers', () => {
    expect(HOME_PAGE_CHOICES).toEqual(['start', 'apps', 'page', 'app']);
  });

  test('never returns "/" — that would redirect to itself forever', () => {
    const configs = [
      undefined,
      {},
      ui({}),
      ...HOME_PAGE_CHOICES.map(defaultPage => ui({ defaultPage })),
      ui({ defaultPage: 'page', defaultPageId: 'welcome' }),
      ui({ defaultPage: 'app', defaultPageAppId: 'chat' })
    ];
    for (const config of configs) {
      const path = resolveHomePath(config);
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toBe('/');
    }
  });
});

describe('pickDefaultChatApp', () => {
  const chat = { id: 'chat', order: 2 };
  const translate = { id: 'translate', order: 1 };
  const portal = { id: 'portal', order: 0, type: 'iframe' };
  const apps = [chat, translate, portal];

  test('prefers the configured app', () => {
    expect(pickDefaultChatApp(apps, [], ui({ defaultAppId: 'chat' }))).toBe(chat);
  });

  test('falls back to the top-ranked chat app, skipping non-chat apps', () => {
    // `portal` sorts first on order but has no chat to send a message to.
    expect(pickDefaultChatApp(apps, [], ui({}))).toBe(translate);
  });

  test('favorites outrank the admin order', () => {
    expect(pickDefaultChatApp(apps, ['chat'], ui({}))).toBe(chat);
  });

  test('falls back when the configured app is gone or not a chat app', () => {
    expect(pickDefaultChatApp(apps, [], ui({ defaultAppId: 'deleted' }))).toBe(translate);
    expect(pickDefaultChatApp(apps, [], ui({ defaultAppId: 'portal' }))).toBe(translate);
  });

  test('survives an empty or missing app list', () => {
    expect(pickDefaultChatApp([], [], ui({}))).toBeNull();
    expect(pickDefaultChatApp(undefined, undefined, undefined)).toBeNull();
  });
});
