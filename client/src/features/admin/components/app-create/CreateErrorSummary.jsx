// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CALLOUT_CLASS } from '../formStyles';
import { CREATE_ERROR_KEYS } from './createErrors';
import { fieldDomId } from './createKeys';

const ENTRY_LINK_CLASS =
  'rounded-sm font-medium underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500';

/**
 * The summary above the form after a submit that could not go ahead: how many
 * fields need attention, each with a link to the field, and what the server
 * said when the request itself failed. It takes the focus, so the author
 * hears it and can go on from there.
 *
 * @param {object} props
 * @param {string} props.id - The id of the region; marked fields point to it.
 * @param {Array<{ field: string, label: string, message?: string|null }>} props.entries -
 *   The fields that need attention, in the order of the form.
 * @param {string|null} [props.general] - A message that belongs to no field.
 * @param {(field: string) => void} props.onGoTo - Moves the focus to a field.
 * @param {{ current: HTMLDivElement|null }} [props.summaryRef] - The region, for the focus.
 * @returns {JSX.Element}
 */
function CreateErrorSummary({ id, entries, general = null, onGoTo, summaryRef }) {
  const { t } = useTranslation();
  return (
    <div
      ref={summaryRef}
      id={id}
      role="alert"
      tabIndex={-1}
      className={`${CALLOUT_CLASS.danger} focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500`}
    >
      {entries.length > 0 && (
        <p className="font-semibold">{t(CREATE_ERROR_KEYS.summary, { count: entries.length })}</p>
      )}
      {general && <p className={entries.length > 0 ? 'mt-1' : undefined}>{general}</p>}
      {entries.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {entries.map(entry => (
            <li key={entry.field}>
              <a
                href={`#${fieldDomId(entry.field)}`}
                className={ENTRY_LINK_CLASS}
                onClick={event => {
                  event.preventDefault();
                  onGoTo(entry.field);
                }}
              >
                {entry.label}
              </a>
              {entry.message ? `: ${entry.message}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default CreateErrorSummary;
