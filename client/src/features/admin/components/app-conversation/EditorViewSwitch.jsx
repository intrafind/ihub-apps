// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

const BUTTON_CLASS =
  'min-h-[36px] px-3 py-1.5 text-sm font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent focus-visible:ring-inset dark:focus-visible:ring-admin-accent-fg-dark';
const ON_CLASS = 'bg-admin-accent text-white';
const OFF_CLASS =
  'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';

/**
 * "Form | Conversation": the segmented control in the editor's header. Both
 * views edit the same form state, so switching never loses an edit; the
 * form is always one click away.
 *
 * @param {object} props
 * @param {'form'|'conversation'} props.view
 * @param {(view: 'form'|'conversation') => void} props.onChange
 * @returns {JSX.Element}
 */
function EditorViewSwitch({ view, onChange }) {
  const { t } = useTranslation();
  const options = [
    { id: 'form', label: t('admin.apps.conversation.view.form') },
    { id: 'conversation', label: t('admin.apps.conversation.view.conversation') }
  ];
  return (
    <div
      role="group"
      aria-label={t('admin.apps.conversation.view.label')}
      className="inline-flex overflow-hidden rounded-md border border-gray-300 shadow-xs dark:border-gray-600"
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={view === option.id}
          onClick={() => view !== option.id && onChange(option.id)}
          className={`${BUTTON_CLASS} ${view === option.id ? ON_CLASS : OFF_CLASS} ${
            index > 0 ? 'border-l border-gray-300 dark:border-gray-600' : ''
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default EditorViewSwitch;
