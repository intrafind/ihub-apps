// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The outcome of a model test (`runModelTest`): the model's answer, or the
 * failure with what to do about it. Shown under a row of the models list and
 * under the header of the model editor. Announced politely when it appears.
 *
 * @param {Object} props
 * @param {import('../utils/modelTestMessages').ModelTestResult} props.result
 * @param {() => void} [props.onDismiss] - Shows a close button when given.
 * @returns {JSX.Element}
 */
function ModelTestResult({ result, onDismiss }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start space-x-3" role="status" data-testid="model-test-result">
      {result.success ? (
        <>
          <Icon
            name="check-circle"
            className="h-5 w-5 text-green-500 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-green-800 dark:text-green-300">
              {t('admin.models.testResults.success', 'Test Successful')}
            </div>
            <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">{result.response}</div>
          </div>
        </>
      ) : (
        <>
          <Icon
            name="exclamation-circle"
            className="h-5 w-5 text-red-500 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-red-800 dark:text-red-300">
              {result.message || t('admin.models.testResults.failed', 'Test Failed')}
            </div>
            {result.error && (
              <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">{result.error}</div>
            )}
          </div>
        </>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-gray-500 hover:text-gray-600"
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="x" className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default ModelTestResult;
