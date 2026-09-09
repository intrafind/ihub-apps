import {
  DEFAULT_HOME_PAGE,
  HOME_PAGE_CHOICES,
  resolveHomeRedirect,
  pickDefaultChatApp,
  resolveNewChatPath
} from '../../../client/src/utils/homePage';

/**
 * Admins choose what the "/" route shows (`ui.json → startPage.defaultPage`).
 * Everything but the start page is a redirect, so these helpers decide what
 * users land on — and where the sidebar's "New chat" button still finds a chat
 * input once home is no longer the start page. A half-configured choice must
 * never strand anyone on a broken route.
 */

const ui = startPage => ({ startPage });

describe('resolveHomeRedirect', () => {
  test('renders the start page when nothing is configured', () => {
    expect(DEFAULT_HOME_PAGE).toBe('start');
    expect(resolveHomeRedirect(undefined)).toBeNull();
    expect(resolveHomeRedirect({})).toBeNull();
    expect(resolveHomeRedirect(ui({}))).toBeNull();
    expect(resolveHomeRedirect(ui({ defaultPage: 'start' }))).toBeNull();
  });

  test('sends the apps browser to its own route', () => {
    expect(resolveHomeRedirect(ui({ defaultPage: 'apps' }))).toBe('/apps');
  });

  test('sends content pages and apps to their routes', () => {
    expect(resolveHomeRedirect(ui({ defaultPage: 'page', defaultPageId: 'welcome' }))).toBe(
      '/pages/welcome'
    );
    expect(resolveHomeRedirect(ui({ defaultPage: 'app', defaultPageAppId: 'chat' }))).toBe(
      '/apps/chat'
    );
  });

  test('falls back to the start page when the target is missing', () => {
    expect(resolveHomeRedirect(ui({ defaultPage: 'page' }))).toBeNull();
    expect(resolveHomeRedirect(ui({ defaultPage: 'page', defaultPageId: '' }))).toBeNull();
    expect(resolveHomeRedirect(ui({ defaultPage: 'app' }))).toBeNull();
    // An unrecognised value (hand-edited config, older client) is not a dead end.
    expect(resolveHomeRedirect(ui({ defaultPage: 'nonsense' }))).toBeNull();
  });

  test('escapes ids so they cannot break out of their route', () => {
    expect(resolveHomeRedirect(ui({ defaultPage: 'page', defaultPageId: 'a/../b' }))).toBe(
      '/pages/a%2F..%2Fb'
    );
  });

  test('the accepted choices are the four the admin UI offers', () => {
    expect(HOME_PAGE_CHOICES).toEqual(['start', 'apps', 'page', 'app']);
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

describe('resolveNewChatPath', () => {
  const apps = [{ id: 'chat', order: 0 }];

  test('stays on "/" while home still has a chat input', () => {
    expect(resolveNewChatPath(ui({}), apps, [])).toBe('/');
    expect(resolveNewChatPath(ui({ defaultPage: 'app', defaultPageAppId: 'x' }), apps, [])).toBe(
      '/'
    );
  });

  test('opens the default app when home has no chat input', () => {
    expect(resolveNewChatPath(ui({ defaultPage: 'apps' }), apps, [])).toBe('/apps/chat');
    expect(
      resolveNewChatPath(ui({ defaultPage: 'page', defaultPageId: 'welcome' }), apps, [])
    ).toBe('/apps/chat');
  });

  test('falls back to the apps browser when there is no chat app', () => {
    expect(resolveNewChatPath(ui({ defaultPage: 'apps' }), [], [])).toBe('/apps');
  });
});
