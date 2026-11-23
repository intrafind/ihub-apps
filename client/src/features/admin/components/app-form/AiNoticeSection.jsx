// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import AppLanguageField from './AppLanguageField';
import EuAiActStateNote from '../euAiAct/EuAiActStateNote';
import { RADIO_CLASS } from '../formStyles';

/**
 * AiNoticeSection - per-app override of the first-turn AI notice (Art. 50(1)).
 * Writes `app.aiDisclosure.firstTurnNotice`: no key = use the platform notice,
 * `enabled: false` = no notice for this app, `text` = custom text.
 */
function AiNoticeSection({ app, onChange }) {
  const { t } = useTranslation();
  const notice = app.aiDisclosure?.firstTurnNotice || {};
  const mode = notice.enabled === false ? 'off' : notice.text ? 'custom' : 'inherit';

  const write = next => {
    const rest = { ...app };
    delete rest.aiDisclosure;
    onChange(next ? { ...rest, aiDisclosure: { firstTurnNotice: next } } : rest);
  };

  const handleMode = value => {
    if (value === 'inherit') write(null);
    else if (value === 'off') write({ enabled: false });
    else write({ text: notice.text || {} });
  };

  const options = [
    ['inherit', t('admin.apps.aiNotice.inherit', 'Use platform notice')],
    ['custom', t('admin.apps.aiNotice.custom', 'Custom notice')],
    ['off', t('admin.apps.aiNotice.off', 'No notice for this app')]
  ];

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.aiNotice.title', 'AI notice')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.aiNotice.help',
              'The notice is shown only in an empty chat. It is not saved and not sent to the AI.'
            )}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0 space-y-4">
          <EuAiActStateNote hideWhenOn />
          <fieldset>
            <legend className="sr-only">{t('admin.apps.aiNotice.title', 'AI notice')}</legend>
            <div className="space-y-2">
              {options.map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100"
                >
                  <input
                    type="radio"
                    name="ai-notice-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => handleMode(value)}
                    className={RADIO_CLASS}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {mode === 'custom' && (
            <AppLanguageField
              label={t('admin.apps.aiNotice.text', 'Notice text')}
              value={notice.text || {}}
              onChange={text => write({ text })}
              type="textarea"
              maxLength={1000}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default AiNoticeSection;
