// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';

/**
 * The "New" or "Changed" badge of an action whose fingerprint (name, side
 * effect, input schema) is not the one an admin accepted (#2916). Such an
 * action asks for approval at least as the installation's "new or changed"
 * setting says until an admin marks it reviewed. Nothing is rendered for a
 * reviewed action.
 *
 * @param {Object} props
 * @param {'new'|'changed'|null|undefined} props.review - the action's review state
 * @returns {JSX.Element|null}
 *
 * @example
 * <ActionReviewBadge review={action.review} />
 */
function ActionReviewBadge({ review }) {
  const { t } = useTranslation();
  if (review === 'new') {
    return (
      <Badge
        tone="info"
        shape="rounded"
        data-testid="action-review-badge"
        title={t(
          'admin.integrations.actionReview.newHint',
          'Added since the last review. It asks for approval until you mark it reviewed.'
        )}
      >
        {t('admin.integrations.actionReview.new', 'New')}
      </Badge>
    );
  }
  if (review === 'changed') {
    return (
      <Badge
        tone="warning"
        shape="rounded"
        data-testid="action-review-badge"
        title={t(
          'admin.integrations.actionReview.changedHint',
          'Its side effect or input changed since the last review. It asks for approval until you mark it reviewed.'
        )}
      >
        {t('admin.integrations.actionReview.changed', 'Changed')}
      </Badge>
    );
  }
  return null;
}

export default ActionReviewBadge;
