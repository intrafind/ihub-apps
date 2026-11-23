// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { EDITOR_GROUPS, groupDomIds } from './editorGroups';

const HEADER_CLASS =
  'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

const CHANGED_CLASS =
  'rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-200';

const ERROR_COUNT_CLASS =
  'rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-xs font-semibold text-red-800 dark:text-red-200';

/**
 * One group of the app editor: a header that opens and closes it, and its
 * sections below.
 *
 * The sections stay mounted while the group is collapsed and are hidden with
 * the `hidden` attribute, so validation, the unsaved-changes check and what is
 * saved do not depend on what is open. A collapsed group says what it is set
 * to (the summary line) and whether that differs from a new app ("changed").
 * A group with fields that need attention shows their number, open or not.
 *
 * @param {object} props
 * @param {string} props.id - A group ID of `EDITOR_GROUPS`.
 * @param {object} props.groups - The state of `useEditorGroups`.
 * @param {React.ReactNode} props.children - The sections of the group.
 * @returns {JSX.Element}
 *
 * @example
 * <EditorGroup id="access" groups={groups}>
 *   <ContentAccessSection resourceType="apps" resourceId={appId} />
 * </EditorGroup>
 */
function EditorGroup({ id, groups, children }) {
  const { t } = useTranslation();
  const entry = EDITOR_GROUPS.find(group => group.id === id);
  if (!entry) return children ?? null;

  const ids = groupDomIds(id);
  const open = groups.isOpen(id);
  const summary = open ? '' : groups.summary(id, t);
  const changed = !open && groups.changed(id);
  const errorCount = groups.errorCount(id);

  return (
    <section id={ids.group} className="scroll-mt-4">
      <h2>
        <button
          id={ids.header}
          type="button"
          aria-expanded={open}
          aria-controls={ids.panel}
          onClick={() => groups.toggle(id)}
          className={HEADER_CLASS}
        >
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
          />
          <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t(entry.labelKey)}
          </span>
          {summary && (
            <span
              className="min-w-0 text-sm font-normal text-gray-600 dark:text-gray-400"
              data-testid={`${ids.group}-summary`}
            >
              {summary}
            </span>
          )}
          {changed && <span className={CHANGED_CLASS}>{t('admin.apps.edit.groupChanged')}</span>}
          {errorCount > 0 && (
            <span className={ERROR_COUNT_CLASS} data-testid={`${ids.group}-errors`}>
              <span aria-hidden="true">{errorCount}</span>
              <span className="sr-only">
                {t('admin.apps.edit.fieldsNeedAttention', { count: errorCount })}
              </span>
            </span>
          )}
        </button>
      </h2>
      <div id={ids.panel} hidden={!open} className="mt-3 space-y-6">
        {children}
      </div>
    </section>
  );
}

export default EditorGroup;
