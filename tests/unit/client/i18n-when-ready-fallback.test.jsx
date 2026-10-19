/**
 * The UI strings come from GET /api/translations, not the bundle. When that
 * request stalls, the first render must not wait for it and must not show raw
 * keys either: whenReady() installs the built-in translations once its timeout
 * passes. A later API answer still replaces them (it carries admin overrides).
 */

jest.mock('../../../client/src/api', () => ({
  // The translations request never settles, like a stalled server.
  fetchTranslations: jest.fn(() => new Promise(() => {})),
  fetchUIConfig: jest.fn(() => Promise.resolve({}))
}));

describe('i18nService.whenReady with a stalled translations API', () => {
  let i18nService;
  let i18n;

  beforeAll(() => {
    localStorage.setItem('i18nextLng', 'de');
    ({ default: i18nService, i18n } = require('../../../client/src/services/i18nService'));
  });

  it('installs the built-in translations once the timeout passes', async () => {
    expect(i18n.t('common.save')).toBe('common.save');

    await i18nService.whenReady(50);

    expect(i18n.t('common.save')).toBe('Speichern');
  });

  it('lets a later API answer replace the built-in translations', () => {
    i18nService.addTranslationsToI18n('de', { common: { save: 'Sichern' } });
    expect(i18n.t('common.save')).toBe('Sichern');
  });
});
