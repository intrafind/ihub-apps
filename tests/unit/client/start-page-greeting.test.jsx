import {
  buildStartPageGreeting,
  renderGreetingTemplate,
  resolveGreetingName,
  timeBasedGreeting
} from '../../../client/src/utils/startPageGreeting';

/**
 * The start-page heading. Installations whose directory has no presentable
 * names must be able to drop the name from it (`startPage.showUserName`) or
 * replace the heading with their own text (`startPage.title`), and neither
 * may ever leave the page with a dangling separator or no heading at all.
 */

// Stand-in for i18next: returns the default string with `{{var}}` filled in,
// which is what the real `t` does for these keys.
const t = (key, defaultValue, vars = {}) =>
  String(defaultValue).replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '');

const at = hour => new Date(2026, 0, 15, hour, 0, 0);
const ada = { id: 'u1', name: 'Ada' };

describe('timeBasedGreeting', () => {
  test('follows the time of day', () => {
    expect(timeBasedGreeting(t, at(8))).toBe('Good morning');
    expect(timeBasedGreeting(t, at(13))).toBe('Good afternoon');
    expect(timeBasedGreeting(t, at(21))).toBe('Good evening');
  });
});

describe('resolveGreetingName', () => {
  test('prefers the name, then the email local part', () => {
    expect(resolveGreetingName(ada)).toBe('Ada');
    expect(resolveGreetingName({ id: 'u2', email: 'grace@example.com' })).toBe('grace');
    expect(resolveGreetingName({ id: 'u3', name: '  Ada  ' })).toBe('Ada');
  });

  test('has no name for anonymous or unresolved viewers', () => {
    expect(resolveGreetingName(null)).toBe('');
    expect(resolveGreetingName({ id: 'anonymous', name: 'Anonymous' })).toBe('');
    expect(resolveGreetingName({ id: 'u4' })).toBe('');
  });

  test('is empty whenever the admin turned names off', () => {
    expect(resolveGreetingName(ada, false)).toBe('');
    expect(resolveGreetingName(ada, true)).toBe('Ada');
  });
});

describe('renderGreetingTemplate', () => {
  test('fills both placeholders', () => {
    expect(
      renderGreetingTemplate('{{greeting}}, {{name}}!', { greeting: 'Good morning', name: 'Ada' })
    ).toBe('Good morning, Ada!');
    expect(renderGreetingTemplate('Hi {{ name }}', { name: 'Ada' })).toBe('Hi Ada');
  });

  test('drops an unfilled name together with the separator before it', () => {
    expect(renderGreetingTemplate('{{greeting}}, {{name}}!', { greeting: 'Good morning' })).toBe(
      'Good morning!'
    );
    expect(renderGreetingTemplate('Welcome {{name}}', {})).toBe('Welcome');
    expect(renderGreetingTemplate('{{greeting}} – {{name}}', { greeting: 'Hello' })).toBe('Hello');
  });

  test('keeps a fixed message untouched', () => {
    expect(renderGreetingTemplate('Welcome to the AI Hub', { name: 'Ada' })).toBe(
      'Welcome to the AI Hub'
    );
  });

  test('treats replacement values as literal text', () => {
    expect(renderGreetingTemplate('Hi {{name}}', { name: 'A$&B' })).toBe('Hi A$&B');
  });

  test('is empty for a blank or missing template', () => {
    expect(renderGreetingTemplate('   ', { name: 'Ada' })).toBe('');
    expect(renderGreetingTemplate(undefined, { name: 'Ada' })).toBe('');
    expect(renderGreetingTemplate('{{name}}', {})).toBe('');
  });
});

describe('buildStartPageGreeting', () => {
  const build = (startPage, user, language = 'en') =>
    buildStartPageGreeting({ startPage, user, language, t, now: at(8) });

  test('greets by name by default', () => {
    expect(build(undefined, ada)).toBe('Good morning, Ada!');
    expect(build({}, ada)).toBe('Good morning, Ada!');
    expect(build({ showUserName: true }, ada)).toBe('Good morning, Ada!');
  });

  test('omits the name for anonymous visitors', () => {
    expect(build({}, { id: 'anonymous', name: 'Anonymous' })).toBe('Good morning!');
    expect(build({}, null)).toBe('Good morning!');
  });

  test('omits the name when the admin turned it off', () => {
    expect(build({ showUserName: false }, ada)).toBe('Good morning!');
  });

  test('uses a configured heading instead of the greeting', () => {
    expect(build({ title: { en: 'Welcome to the AI Hub' } }, ada)).toBe('Welcome to the AI Hub');
    expect(build({ title: { en: '{{greeting}} at ACME, {{name}}!' } }, ada)).toBe(
      'Good morning at ACME, Ada!'
    );
  });

  test('picks the heading for the active language', () => {
    const startPage = { title: { en: 'Welcome', de: 'Willkommen' } };
    expect(build(startPage, ada, 'de')).toBe('Willkommen');
    // An unlocalized language falls back to English rather than to no heading.
    expect(build(startPage, ada, 'fr')).toBe('Welcome');
  });

  test('a name placeholder in the heading obeys the name setting', () => {
    const startPage = { title: { en: 'Hello {{name}}, welcome back' }, showUserName: false };
    expect(build(startPage, ada)).toBe('Hello, welcome back');
  });

  test('falls back to the built-in greeting when the heading renders empty', () => {
    expect(build({ title: { en: '' } }, ada)).toBe('Good morning, Ada!');
    expect(build({ title: {} }, ada)).toBe('Good morning, Ada!');
    // A heading that is only a name nobody has would leave no heading at all;
    // the fallback follows the name setting, so it is the no-name greeting.
    expect(build({ title: { en: '{{name}}' }, showUserName: false }, ada)).toBe('Good morning!');
  });
});
