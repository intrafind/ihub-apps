// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { HELP_CLASS, LABEL_CLASS, RADIO_CLASS } from '../formStyles';
import { linkUrlOf } from './createErrors';
import FormField from './FormField';

/**
 * What a link app asks for instead of instructions: the website address, and
 * whether the website opens or is shown inside iHub.
 *
 * @param {object} props
 * @param {object} props.draft - A link app (`type: 'redirect'` or `'iframe'`).
 * @param {string|true|null} [props.urlError]
 * @param {string} [props.describedBy] - The element that explains a marked field.
 * @param {(change: { url?: string, mode?: 'redirect'|'iframe' }) => void} props.onChange
 * @param {(field: string) => void} props.onBlur
 * @returns {JSX.Element}
 */
function LinkFields({ draft, urlError = null, describedBy, onChange, onBlur }) {
  const { t } = useTranslation();
  const baseId = useId();
  const modeName = `${baseId}-mode`;
  const iframeHelpId = `${baseId}-iframe-help`;
  return (
    <>
      <FormField
        field="url"
        label={t('admin.apps.create.link.url')}
        required
        help={t('admin.apps.create.link.urlHelp')}
        error={urlError}
        describedBy={describedBy}
      >
        {control => (
          <input
            {...control}
            type="url"
            inputMode="url"
            value={linkUrlOf(draft)}
            autoComplete="off"
            onChange={event => onChange({ url: event.target.value })}
            onBlur={() => onBlur('url')}
          />
        )}
      </FormField>
      <fieldset>
        <legend className={LABEL_CLASS}>{t('admin.apps.create.link.mode')}</legend>
        <div className="mt-1 space-y-2 text-sm text-gray-800 dark:text-gray-200">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              className={`${RADIO_CLASS} mt-0.5`}
              name={modeName}
              checked={draft.type === 'redirect'}
              onChange={() => onChange({ mode: 'redirect' })}
            />
            <span>{t('admin.apps.create.link.redirect')}</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              className={`${RADIO_CLASS} mt-0.5`}
              name={modeName}
              checked={draft.type === 'iframe'}
              aria-describedby={iframeHelpId}
              onChange={() => onChange({ mode: 'iframe' })}
            />
            <span>
              {t('admin.apps.create.link.iframe')}
              <span id={iframeHelpId} className={`block ${HELP_CLASS}`}>
                {t('admin.apps.create.link.iframeHelp')}
              </span>
            </span>
          </label>
        </div>
      </fieldset>
    </>
  );
}

export default LinkFields;
