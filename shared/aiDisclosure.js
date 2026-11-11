// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * First-turn AI notice (EU AI Act Art. 50(1)): which text, if any, the empty
 * chat shows. Pure, so the client uses it and the unit tests pin the order.
 *
 * Order: platform `enabled === false` hides it everywhere (master switch);
 * app `enabled === false` hides it for that app; the text is the app's, then
 * the platform's, each as language -> base language -> `en`, then the built-in
 * (translated) default. Blank entries are ignored, so the result is never empty.
 */

const pick = (map, language) => {
  if (!map || typeof map !== 'object') return null;
  const base = typeof language === 'string' ? language.split('-')[0] : null;
  for (const key of [language, base, 'en']) {
    const value = key ? map[key] : null;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

/**
 * @param {Object} params
 * @param {Object} [params.platform] `platformConfig.aiDisclosure`
 * @param {Object} [params.app] the app config (`app.aiDisclosure`)
 * @param {string} [params.language]
 * @param {(key:string)=>string} [params.t] translator for the built-in default
 * @returns {{visible: boolean, text: string}}
 */
export function resolveFirstTurnNotice({ platform, app, language, t } = {}) {
  const platformNotice = platform?.firstTurnNotice;
  const appNotice = app?.aiDisclosure?.firstTurnNotice;
  if (platformNotice?.enabled === false || appNotice?.enabled === false) {
    return { visible: false, text: '' };
  }
  const text =
    pick(appNotice?.text, language) ||
    pick(platformNotice?.text, language) ||
    (typeof t === 'function' ? t('aiDisclosure.firstTurnNotice') : '') ||
    '';
  return { visible: Boolean(text), text };
}
