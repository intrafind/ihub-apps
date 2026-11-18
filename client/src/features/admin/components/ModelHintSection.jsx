// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import ModelHintBanner from '../../chat/components/ModelHintBanner';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';

export const HINT_LEVELS = ['hint', 'info', 'warning', 'alert'];

/** Only `hint` and `info` can be dismissed in the chat (see ModelHintBanner). */
const isDismissibleLevel = level => level === 'hint' || level === 'info';

/**
 * The model's `hint` as it is saved: languages left empty are dropped, and a
 * hint without any message text is no hint at all (`undefined`). The schema
 * rejects empty strings in a localized message.
 */
export function normalizeModelHint(hint) {
  if (!hint || typeof hint !== 'object') return undefined;
  const message = Object.fromEntries(
    Object.entries(hint.message || {}).filter(([, text]) => typeof text === 'string' && text.trim())
  );
  if (Object.keys(message).length === 0) return undefined;
  const level = HINT_LEVELS.includes(hint.level) ? hint.level : 'info';
  const normalized = { message, level };
  if (isDismissibleLevel(level)) normalized.dismissible = hint.dismissible !== false;
  return normalized;
}

/**
 * Admin editor for a model's hint: the message shown above the chat input when
 * the model is selected (#3811). `hint` is the model's `hint` field; `onChange`
 * receives the new value, or `undefined` to remove it.
 */
function ModelHintSection({ hint, onChange, currentLanguage }) {
  const { t } = useTranslation();
  const enabled = Boolean(hint);
  const level = hint?.level || 'info';

  const levelLabels = {
    hint: t('admin.models.hint.levels.hint', 'Hint (blue)'),
    info: t('admin.models.hint.levels.info', 'Info (cyan)'),
    warning: t('admin.models.hint.levels.warning', 'Warning (yellow, cannot be dismissed)'),
    alert: t('admin.models.hint.levels.alert', 'Alert (red, must be acknowledged before sending)')
  };

  const update = patch => onChange({ ...hint, ...patch });

  const previewHint = normalizeModelHint(hint);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.models.hint.title', 'User Hint')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.models.hint.description',
              'A message shown above the chat input when users select this model, for example a recommendation or a warning about an experimental model.'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-6">
          <div className="flex items-start">
            <div className="flex items-center h-5">
              <input
                id="hint.enabled"
                type="checkbox"
                checked={enabled}
                onChange={e =>
                  onChange(
                    e.target.checked
                      ? { message: { [DEFAULT_LANGUAGE]: '' }, level: 'info', dismissible: true }
                      : undefined
                  )
                }
                className={CHECKBOX_CLASS}
              />
            </div>
            <div className="ml-3 text-sm">
              <label
                htmlFor="hint.enabled"
                className="font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.models.hint.enabled', 'Show a hint for this model')}
              </label>
            </div>
          </div>

          {enabled && (
            <>
              <div className="grid grid-cols-6 gap-6">
                <div className="col-span-6 sm:col-span-3">
                  <label
                    htmlFor="hint.level"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.hint.level', 'Level')}
                  </label>
                  <select
                    id="hint.level"
                    value={level}
                    onChange={e => update({ level: e.target.value })}
                    className={`${INPUT_CLASS} mt-1 block`}
                  >
                    {HINT_LEVELS.map(value => (
                      <option key={value} value={value}>
                        {levelLabels[value]}
                      </option>
                    ))}
                  </select>
                </div>

                {isDismissibleLevel(level) && (
                  <div className="col-span-6 sm:col-span-3 flex items-start sm:pt-7">
                    <div className="flex items-center h-5">
                      <input
                        id="hint.dismissible"
                        type="checkbox"
                        checked={hint.dismissible !== false}
                        onChange={e => update({ dismissible: e.target.checked })}
                        className={CHECKBOX_CLASS}
                      />
                    </div>
                    <div className="ml-3 text-sm">
                      <label
                        htmlFor="hint.dismissible"
                        className="font-medium text-gray-700 dark:text-gray-300"
                      >
                        {t('admin.models.hint.dismissible', 'Users can dismiss it')}
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <DynamicLanguageEditor
                label={`${t('admin.models.hint.message', 'Message')} *`}
                name="hint.message"
                value={hint.message || { [DEFAULT_LANGUAGE]: '' }}
                onChange={value => update({ message: value })}
                required={true}
                type="textarea"
              />

              {previewHint && (
                <div>
                  <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.models.hint.preview', 'Preview')}
                  </p>
                  <ModelHintBanner
                    key={JSON.stringify(previewHint)}
                    hint={previewHint}
                    currentLanguage={currentLanguage}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModelHintSection;
