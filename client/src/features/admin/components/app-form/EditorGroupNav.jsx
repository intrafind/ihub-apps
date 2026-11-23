// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';

/**
 * Where the index turns from a select above the form into a list beside it:
 * at `lg`, or at `2xl` while the test chat takes part of the window.
 */
const LAYOUT = {
  wide: {
    nav: 'mb-6 flex flex-wrap items-center gap-3 lg:sticky lg:top-4 lg:mb-0 lg:block',
    select: 'flex min-w-0 flex-1 items-center gap-2 lg:hidden',
    list: 'hidden lg:mt-3 lg:block'
  },
  compact: {
    nav: 'mb-6 flex flex-wrap items-center gap-3 2xl:sticky 2xl:top-4 2xl:mb-0 2xl:block',
    select: 'flex min-w-0 flex-1 items-center gap-2 2xl:hidden',
    list: 'hidden 2xl:mt-3 2xl:block'
  }
};

const ENTRY_CLASS =
  'flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

const CHANGED_CLASS = 'text-xs text-amber-800 dark:text-amber-300';

const ERROR_COUNT_CLASS =
  'rounded-full bg-red-100 dark:bg-red-900/40 px-1.5 text-xs font-semibold text-red-800 dark:text-red-200';

/**
 * The index of the app editor's groups: one entry per group, each with the
 * "changed" marker and the number of fields that need attention, and a button
 * that expands or collapses all groups. An entry opens its group and moves the
 * focus to its header.
 *
 * On a narrow window the entries are a "Jump to section" select above the
 * form, with a "Go" button. Choosing an option moves nothing: on Windows and
 * Linux every arrow key on a closed select changes its value, and a focus
 * that left with the first key press would make the later sections
 * unreachable. "Go", or Enter in the select, opens the chosen group.
 *
 * @param {object} props
 * @param {object} props.groups - The state of `useEditorGroups`.
 * @param {boolean} [props.compact=false] - True while something beside the
 *   form (the test chat) takes part of the window; the list then appears only
 *   on a very wide window.
 * @returns {JSX.Element}
 */
function EditorGroupNav({ groups, compact = false }) {
  const { t } = useTranslation();
  const selectId = useId();
  const layout = compact ? LAYOUT.compact : LAYOUT.wide;
  const jumpLabel = t('admin.apps.edit.jump');
  const openGroup = id => groups.open(id, { focus: true });
  // The section chosen in the select, until "Go".
  const [target, setTarget] = useState('');
  const goToTarget = () => {
    if (!target) return;
    openGroup(target);
    // The select is a menu: it shows its label again.
    setTarget('');
  };

  const entries = groups.groups.map(group => ({
    id: group.id,
    label: t(group.labelKey),
    changed: groups.changed(group.id),
    errorCount: groups.errorCount(group.id)
  }));

  /** The text of an entry in the select, which cannot hold markup. */
  const optionText = entry =>
    [
      entry.label,
      entry.changed && `(${t('admin.apps.edit.groupChanged')})`,
      entry.errorCount > 0 &&
        `– ${t('admin.apps.edit.fieldsNeedAttention', { count: entry.errorCount })}`
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <nav aria-label={jumpLabel} className={layout.nav}>
      <div className={layout.select}>
        <label htmlFor={selectId} className="sr-only">
          {jumpLabel}
        </label>
        <select
          id={selectId}
          value={target}
          onChange={event => setTarget(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || !target) return;
            event.preventDefault();
            goToTarget();
          }}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        >
          <option value="">{jumpLabel}</option>
          {entries.map(entry => (
            <option key={entry.id} value={entry.id}>
              {optionText(entry)}
            </option>
          ))}
        </select>
        <button type="button" onClick={goToTarget} className={SECONDARY_BUTTON_CLASS}>
          {t('admin.apps.edit.jumpGo')}
        </button>
      </div>

      <button
        type="button"
        onClick={groups.allOpen ? groups.collapseAll : groups.expandAll}
        className={SECONDARY_BUTTON_CLASS}
      >
        {groups.allOpen ? t('admin.apps.edit.collapseAll') : t('admin.apps.edit.expandAll')}
      </button>

      <ul className={layout.list}>
        {entries.map(entry => (
          <li key={entry.id}>
            <button type="button" onClick={() => openGroup(entry.id)} className={ENTRY_CLASS}>
              <span>{entry.label}</span>
              {entry.changed && (
                <span className={CHANGED_CLASS}>{t('admin.apps.edit.groupChanged')}</span>
              )}
              {entry.errorCount > 0 && (
                <span className={ERROR_COUNT_CLASS}>
                  <span aria-hidden="true">{entry.errorCount}</span>
                  <span className="sr-only">
                    {t('admin.apps.edit.fieldsNeedAttention', { count: entry.errorCount })}
                  </span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default EditorGroupNav;
