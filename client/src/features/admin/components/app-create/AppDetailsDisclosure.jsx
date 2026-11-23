// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { APP_ID_MAX_LENGTH } from '../../../../../../shared/validationPatterns.js';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from '../formStyles';
import { fieldDomId } from './createKeys';
import { DISCLOSURE_BUTTON_CLASS, FIELD_ERROR_CLASS, INVALID_INPUT_CLASS } from './createStyles';

/**
 * "More details": the app ID and the category. Collapsed, it shows no value;
 * neither field needs the author's attention for a first app.
 *
 * The app ID follows the name until the author edits it here. It cannot be
 * changed after the app is created, which the help text says.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers. `source.showAppId` and
 *   `source.showCategory` say which of the two fields exist; without a source both do.
 * @param {boolean} props.open
 * @param {() => void} props.onToggle
 * @param {string} props.appId
 * @param {(id: string) => void} props.onIdChange
 * @param {string|true|null} [props.idError] - The message for the ID; `true`
 *   marks the field without a text of its own.
 * @param {boolean} [props.idAvailable=false] - Shows "Available" under the ID.
 * @param {string} [props.describedBy] - The element that explains a marked field.
 * @param {string} [props.category]
 * @param {Array<{ id: string, name: string|object }>} [props.categories]
 * @param {(category: string) => void} props.onCategoryChange
 * @param {string} props.language - The language of the category names.
 * @returns {JSX.Element}
 */
function AppDetailsDisclosure({
  source,
  open,
  onToggle,
  appId,
  onIdChange,
  idError = null,
  idAvailable = false,
  describedBy,
  category,
  categories = [],
  onCategoryChange,
  language
}) {
  const { t } = useTranslation();
  const panelId = useId();
  const idField = fieldDomId('id');
  const categoryField = fieldDomId('category');
  const idMessage = typeof idError === 'string' ? idError : null;
  const describedIds = [
    `${idField}-help`,
    idMessage ? `${idField}-error` : null,
    idError === true ? describedBy : null,
    idAvailable && !idError ? `${idField}-free` : null
  ].filter(Boolean);

  return (
    <div>
      <button
        type="button"
        className={DISCLOSURE_BUTTON_CLASS}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" aria-hidden="true" />
        {t('admin.apps.create.essentials.details')}
      </button>
      <div id={panelId}>
        {open && (
          <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {source?.showAppId !== false && (
              <div>
                <label htmlFor={idField} className={LABEL_CLASS}>
                  {t('admin.apps.create.essentials.id')}
                  <span aria-hidden="true"> *</span>
                </label>
                <input
                  id={idField}
                  type="text"
                  className={`${MONO_INPUT_CLASS} ${idError ? INVALID_INPUT_CLASS : ''}`}
                  value={appId}
                  maxLength={APP_ID_MAX_LENGTH + 20}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-required="true"
                  aria-invalid={idError ? 'true' : undefined}
                  aria-describedby={describedIds.join(' ')}
                  onChange={event => onIdChange(event.target.value)}
                />
                {idMessage && (
                  <p id={`${idField}-error`} className={FIELD_ERROR_CLASS}>
                    {idMessage}
                  </p>
                )}
                {idAvailable && !idError && (
                  <p
                    id={`${idField}-free`}
                    role="status"
                    className="mt-1 text-sm text-green-800 dark:text-green-300"
                  >
                    {t('admin.apps.create.essentials.idFree')}
                  </p>
                )}
                <p id={`${idField}-help`} className={HELP_CLASS}>
                  {t('admin.apps.create.essentials.idHelp')}
                </p>
              </div>
            )}
            {source?.showCategory !== false && categories.length > 0 && (
              <div>
                <label htmlFor={categoryField} className={LABEL_CLASS}>
                  {t('admin.apps.create.essentials.category')}
                </label>
                <select
                  id={categoryField}
                  className={INPUT_CLASS}
                  value={category || ''}
                  aria-describedby={`${categoryField}-help`}
                  onChange={event => onCategoryChange(event.target.value)}
                >
                  {categories.map(option => (
                    <option key={option.id} value={option.id}>
                      {getLocalizedContent(option.name, language) || option.id}
                    </option>
                  ))}
                </select>
                <p id={`${categoryField}-help`} className={HELP_CLASS}>
                  {t('admin.apps.create.essentials.categoryHelp')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default AppDetailsDisclosure;
