// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The four fixed facts of a marketplace integration item, as label/value
 * rows, and the badge tone of an action's side effect. Pure, so the card
 * and the detail render the same text and tests can check it without a DOM.
 *
 * The server derives `facts` from the item's definition when the catalog is
 * loaded (`RegistryService`): `authModes`, `effect` (`read` | `read-write` |
 * `unknown`), `runs` (`cloud` | `on-prem` | `local` | null), `actionCount`
 * (null when the system lists its own actions) and, in the detail only,
 * `actions` (`{ name, title, sideEffect }`).
 *
 * @module features/admin/components/marketplace/integrationItemFacts
 */

const K = 'admin.marketplace.integrationFacts';

/** i18n key and English default of the overall effect. */
const EFFECT_LABELS = {
  read: [`${K}.effectValues.read`, 'read'],
  'read-write': [`${K}.effectValues.readWrite`, 'read · write'],
  unknown: [`${K}.effectValues.unknown`, 'not declared']
};

/** i18n key and English default of where the integration runs. */
const RUNS_LABELS = {
  cloud: [`${K}.runsValues.cloud`, 'cloud'],
  'on-prem': [`${K}.runsValues.onPrem`, 'on-premises'],
  local: [`${K}.runsValues.local`, 'local']
};

/** Badge tones (shared `Badge`) of an action's side effect. */
const SIDE_EFFECT_TONES = {
  read: 'info',
  write: 'warning',
  destructive: 'danger',
  unknown: 'neutral'
};

/**
 * The badge tone of an action's side effect: read → info, write → warning,
 * destructive → danger, anything else → neutral.
 *
 * @param {string} [sideEffect]
 * @returns {'info'|'warning'|'danger'|'neutral'}
 */
export function sideEffectTone(sideEffect) {
  return SIDE_EFFECT_TONES[sideEffect] || SIDE_EFFECT_TONES.unknown;
}

/**
 * The four fact rows of an integration item: sign-in, effect, where it
 * runs, actions. The sign-in modes use the short labels of Admin →
 * Integrations (`admin.integrationCatalog.authModes.short.*`).
 *
 * @param {Object|null|undefined} facts - The item's `facts`
 * @param {Function} t - The translation function
 * @returns {Array<{ id: string, label: string, value: string }>} Empty when there are no facts
 *
 * @example
 * integrationFactRows({ authModes: ['none'], effect: 'read', runs: 'cloud', actionCount: 3 }, t);
 * // → [{ id: 'signIn', label: 'Sign-in', value: 'none' }, { id: 'effect', … }, …]
 */
export function integrationFactRows(facts, t) {
  if (!facts || typeof facts !== 'object') return [];
  const authModes = Array.isArray(facts.authModes) ? facts.authModes : [];
  const [effectKey, effectDefault] = EFFECT_LABELS[facts.effect] || EFFECT_LABELS.unknown;
  const runsLabel = RUNS_LABELS[facts.runs];
  return [
    {
      id: 'signIn',
      label: t('admin.integrationCatalog.facts.signIn', 'Sign-in'),
      value: authModes.length
        ? authModes.map(m => t(`admin.integrationCatalog.authModes.short.${m}`, m)).join(', ')
        : '—'
    },
    {
      id: 'effect',
      label: t(`${K}.effect`, 'Effect'),
      value: t(effectKey, effectDefault)
    },
    {
      id: 'runs',
      label: t(`${K}.runs`, 'Where it runs'),
      value: runsLabel ? t(...runsLabel) : t(`${K}.runsValues.unknown`, 'not stated')
    },
    {
      id: 'actions',
      label: t('admin.integrationCatalog.facts.actions', 'Actions'),
      value:
        typeof facts.actionCount === 'number'
          ? String(facts.actionCount)
          : t(`${K}.actionsDynamic`, 'listed by the server')
    }
  ];
}

/**
 * The display title of an action: its localized `title`, else its name.
 *
 * @param {{ name: string, title?: (Object|string|null) }} action
 * @param {string} lang - The UI language (`en`, `de`, …)
 * @returns {string}
 */
export function actionTitle(action, lang) {
  const title = action?.title;
  if (typeof title === 'string' && title) return title;
  if (title && typeof title === 'object') return title[lang] || title.en || action.name;
  return action?.name || '';
}
