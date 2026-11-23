// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { KEEP_DEFAULT } from '../../utils/providerConnect';
import { STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * Step 5, the default model: an explicit choice among the picked chat models,
 * or keeping the current default. Nothing becomes the default silently.
 *
 * @param {Object} props
 * @param {Array<{ id: string, model: Object }>} props.candidates - Picked chat models
 * @param {Object|null} props.currentDefault - The model that is default today
 * @param {string|null} props.choice
 * @param {(value: string) => void} props.onChoose
 */
function DefaultStep({ candidates, currentDefault, choice, onChoose }) {
  const { t, i18n } = useTranslation();
  const currentName = currentDefault
    ? getLocalizedContent(currentDefault.name, i18n.language) || currentDefault.id
    : null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className={STEP_TITLE}>
          {t('admin.providers.connect.default.title', 'Choose the default model')}
        </h2>
        <p className={STEP_INTRO}>
          {t(
            'admin.providers.connect.default.intro',
            'Apps without a model of their own, and new chats, use the default model.'
          )}
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.providers.connect.default.noChatModels',
            'None of the picked models is a chat model, so none can be the default.'
          )}
        </p>
      ) : (
        <fieldset>
          <legend className="sr-only">
            {t('admin.providers.connect.default.title', 'Choose the default model')}
          </legend>
          <div className="space-y-2">
            {currentDefault && (
              <label
                htmlFor="connect-default-keep"
                className="grid grid-cols-[auto_1fr] items-start gap-x-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm"
              >
                <input
                  id="connect-default-keep"
                  type="radio"
                  name="connect-default"
                  value={KEEP_DEFAULT}
                  checked={choice === KEEP_DEFAULT}
                  onChange={() => onChoose(KEEP_DEFAULT)}
                  className="row-span-2 mt-0.5 h-4 w-4 text-indigo-600"
                />
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.providers.connect.default.keep', 'Keep {{model}}', {
                    model: currentName
                  })}
                </span>
                <span className="block text-xs text-gray-600 dark:text-gray-400">
                  {t('admin.providers.connect.default.keepHint', 'The current default model.')}
                </span>
              </label>
            )}
            {candidates.map(candidate => (
              <label
                key={candidate.id}
                htmlFor={`connect-default-${candidate.id}`}
                className="grid grid-cols-[auto_1fr] items-start gap-x-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm"
              >
                <input
                  id={`connect-default-${candidate.id}`}
                  type="radio"
                  name="connect-default"
                  value={candidate.id}
                  checked={choice === candidate.id}
                  onChange={() => onChoose(candidate.id)}
                  className="row-span-2 mt-0.5 h-4 w-4 text-indigo-600"
                />
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {candidate.model.name || candidate.model.id}
                </span>
                <span className="block text-xs text-gray-600 dark:text-gray-400">
                  {candidate.id}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export default DefaultStep;
