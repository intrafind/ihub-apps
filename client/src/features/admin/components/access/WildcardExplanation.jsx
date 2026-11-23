// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS } from '../formStyles';
import { ITEM_KEYS, formatSentence, wildcardSentences } from './accessExplanation';

/**
 * Visible text for every group that gets an item through a wildcard, with the
 * inheritance chain: "Everyone in Users sees this through “all apps”
 * (inherited from Authenticated: Users → Authenticated)."
 *
 * Renders nothing when no group of the view gets the item through `*`.
 *
 * @param {object} props
 * @param {object|null} props.view - An access view whose group rows carry `via`
 *   (`/api/admin/content-access/…` or `/api/admin/access/…`)
 * @param {string} props.type - The item type (`apps`, `models`, …)
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function WildcardExplanation({ view, type, className = '' }) {
  const { t } = useTranslation();
  const sentences = wildcardSentences(view, type);
  if (sentences.length === 0) return null;

  return (
    <div
      className={`${CALLOUT_CLASS.warning} ${className}`.trim()}
      data-testid="wildcard-explanation"
    >
      <p className="flex items-start font-medium">
        <Icon name="information-circle" className="h-4 w-4 mr-1.5 mt-0.5 shrink-0" />
        <span>
          {t('admin.access.explain.heading', { items: t(ITEM_KEYS[type] || ITEM_KEYS.apps) })}
        </span>
      </p>
      <ul className="mt-1 ml-6 list-disc space-y-0.5">
        {sentences.map(sentence => (
          <li key={sentence.groupId}>{formatSentence(sentence, t)}</li>
        ))}
      </ul>
    </div>
  );
}

export default WildcardExplanation;
