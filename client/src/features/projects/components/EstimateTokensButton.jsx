// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The "Estimate tokens" button: loads the sources of a project, estimates
 * their tokens and recommends whether they belong in the prompt.
 *
 * @param {Object} props
 * @param {boolean} props.loading
 * @param {() => void} props.onClick
 * @param {boolean} [props.disabled]
 * @returns {JSX.Element}
 */
function EstimateTokensButton({ loading, onClick, disabled = false }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || disabled}
      title={t(
        'projects.estimate.hint',
        'Loads every document, counts its tokens and recommends what goes into the prompt.'
      )}
      className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
    >
      <Icon
        name={loading ? 'arrow-path' : 'chart-bar'}
        size="sm"
        className={loading ? 'animate-spin' : ''}
      />
      {loading
        ? t('projects.estimate.running', 'Estimating…')
        : t('projects.estimate.button', 'Estimate tokens')}
    </button>
  );
}

export default EstimateTokensButton;
