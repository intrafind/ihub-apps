// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS } from '../formStyles';

/**
 * FeedbackSection - per-app switch for the response feedback UI.
 *
 * Only ever reads/writes `app.features.feedback`. Absent means enabled, so
 * switching it back on drops the key instead of writing `true` — an app then
 * simply follows the platform-wide `feedback` feature flag, which still has to
 * be on for the rating to appear at all.
 */
function FeedbackSection({ app, onChange }) {
  const { t } = useTranslation();
  const enabled = app.features?.feedback !== false;

  const handleChange = checked => {
    const features = { ...app.features };
    if (checked) {
      delete features.feedback;
    } else {
      features.feedback = false;
    }
    onChange({ ...app, features });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.feedback', 'Response Feedback')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.feedbackDesc',
              'Let users rate this app’s responses with stars and an optional comment'
            )}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                id="app-enable-feedback"
                type="checkbox"
                checked={enabled}
                onChange={e => handleChange(e.target.checked)}
                className={CHECKBOX_CLASS}
              />
              <label
                htmlFor="app-enable-feedback"
                className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.edit.enableFeedback', 'Enable response feedback')}
              </label>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.edit.feedbackNote',
                'When disabled, the star rating is hidden under this app’s responses and the feedback API rejects submissions for it. The platform-level feedback feature must also be enabled for the rating to appear; all of it is also manageable under Admin → Feedback.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FeedbackSection;
