// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { projectDisplayName, projectPickerSections } from '../utils/projectView';

/**
 * The project picker's panel: a search field over a list of projects in
 * sections (mine, shared with me, from the administrators). However many
 * projects there are, it stays one height; the search narrows the list. One
 * project is picked (`multiple: false`) or several are ticked
 * (`multiple: true`). Shown inline (in a dialog) or in {@link ProjectPicker}'s
 * popover.
 *
 * The search field is a combobox: the arrow keys move through the list,
 * Enter picks, Escape calls `onEscape`.
 *
 * @param {Object} props
 * @param {Array<Object>} props.projects - The projects to offer.
 * @param {string[]} props.selectedIds - The picked (or ticked) ones.
 * @param {(id: string) => void} props.onPick - A project was picked or its tick flipped.
 * @param {boolean} [props.multiple=false] - Tick several instead of picking one.
 * @param {(project: Object) => boolean} [props.isDisabled] - A project that cannot be picked now.
 * @param {(project: Object) => string} [props.describe] - A second line for a project.
 * @param {string} props.label - What is picked, for the search field and the list.
 * @param {string} [props.hint] - A line above the search field.
 * @param {string} [props.footer] - A line below the list (e.g. a limit reached).
 * @param {() => void} [props.onEscape] - Escape was pressed in the search field.
 * @param {(event: KeyboardEvent) => void} [props.onTab] - Tab was pressed in the search field.
 * @param {boolean} [props.focusOnMount=false] - Focus the search field on mount.
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className] - The panel's frame.
 * @returns {JSX.Element}
 */
export function ProjectPickerPanel({
  projects,
  selectedIds,
  onPick,
  multiple = false,
  isDisabled,
  describe,
  label,
  hint,
  footer,
  onEscape,
  onTab,
  focusOnMount = false,
  disabled = false,
  className = 'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = id => `${baseId}-option-${id}`;
  const [search, setSearch] = useState('');
  // Start on the picked project, so Enter keeps it.
  const [activeId, setActiveId] = useState(() => (multiple ? null : selectedIds[0] || null));
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const sections = useMemo(
    () => projectPickerSections(projects, { search, language }),
    [projects, search, language]
  );
  // The projects in the order shown, for the arrow keys.
  const shown = useMemo(() => sections.flatMap(section => section.projects), [sections]);
  const blocked = project => disabled || (isDisabled ? isDisabled(project) : false);
  const active = shown.find(project => project.id === activeId) || null;

  useEffect(() => {
    if (focusOnMount) searchRef.current?.focus();
  }, [focusOnMount]);

  // Keep the active option in view while the arrow keys move it.
  useEffect(() => {
    if (!activeId) return;
    const node = [...(listRef.current?.querySelectorAll('[data-project-id]') || [])].find(
      option => option.dataset.projectId === activeId
    );
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const pick = project => {
    if (!blocked(project)) onPick(project.id);
  };

  const move = step => {
    if (shown.length === 0) return;
    const index = shown.findIndex(project => project.id === activeId);
    const next =
      index === -1
        ? step > 0
          ? 0
          : shown.length - 1
        : (index + step + shown.length) % shown.length;
    setActiveId(shown[next].id);
  };

  const handleKeyDown = event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      // Never submit the form around the picker.
      event.preventDefault();
      if (active) pick(active);
    } else if (event.key === 'Escape' && onEscape) {
      // Close the picker, not the dialog or the menu it sits in.
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (event.key === 'Tab') {
      onTab?.(event);
    }
  };

  const sectionLabels = {
    mine: t('projects.picker.sections.mine', 'My projects'),
    shared: t('projects.picker.sections.shared', 'Shared with me'),
    admin: t('projects.picker.sections.admin', 'From the administrators')
  };

  return (
    <div className={className} data-testid="project-picker">
      {hint && <p className="px-3 pt-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <Icon name="search" size="sm" className="flex-none text-gray-500 dark:text-gray-400" />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active.id) : undefined}
          aria-label={label}
          value={search}
          onChange={event => {
            setSearch(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('projects.picker.search', 'Search projects')}
          className="w-full bg-transparent border-0 p-1 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-hidden focus:ring-0"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        className="max-h-64 overflow-y-auto py-1"
      >
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
            {search.trim()
              ? t('projects.picker.noMatches', 'No project matches.')
              : t('projects.picker.empty', 'There is no project to choose.')}
          </p>
        ) : (
          sections.map(section => (
            <div key={section.id} role="group" aria-labelledby={`${baseId}-section-${section.id}`}>
              <div
                id={`${baseId}-section-${section.id}`}
                className="px-3 pt-2 pb-1 text-xs font-medium text-gray-500 dark:text-gray-400"
              >
                {sectionLabels[section.id]}
              </div>
              {section.projects.map(project => {
                const selected = selectedIds.includes(project.id);
                const unavailable = blocked(project);
                const detail = describe ? describe(project) : '';
                return (
                  // The options take no focus: the search field keeps it and
                  // points at the active one (`aria-activedescendant`), and
                  // its keys pick.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus
                  <div
                    key={project.id}
                    id={optionId(project.id)}
                    data-project-id={project.id}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={unavailable || undefined}
                    // The search keeps the focus: a click picks without moving it.
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => pick(project)}
                    onMouseEnter={() => setActiveId(project.id)}
                    className={`mx-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                      project.id === activeId ? 'bg-gray-100 dark:bg-gray-700' : ''
                    } ${unavailable ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {multiple ? (
                      <span
                        aria-hidden="true"
                        className={`flex h-4 w-4 flex-none items-center justify-center rounded-sm border ${
                          selected
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-gray-300 dark:border-gray-500'
                        }`}
                      >
                        {selected && <Icon name="check" size="xs" className="text-white" />}
                      </span>
                    ) : (
                      <Icon
                        name="folder"
                        size="sm"
                        className="flex-none text-gray-500 dark:text-gray-400"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gray-900 dark:text-gray-100">
                        {projectDisplayName(project, language)}
                      </span>
                      {detail && (
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {detail}
                        </span>
                      )}
                    </span>
                    {!multiple && selected && (
                      <Icon
                        name="check"
                        size="sm"
                        className="flex-none text-indigo-600 dark:text-indigo-400"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {footer && (
        <p className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
          {footer}
        </p>
      )}
    </div>
  );
}

/**
 * The project picker in a popover: {@link ProjectPickerPanel}, opened from a
 * trigger button. Picking one project closes it (`multiple: false`); ticking
 * several keeps it open. Escape and a click outside close it.
 *
 * @param {Object} props - Those of {@link ProjectPickerPanel}, and:
 * @param {(state: {open: boolean, triggerProps: Object}) => JSX.Element} props.renderTrigger -
 *   The button that opens the panel; spread `triggerProps` on it.
 * @param {'below'|'above'} [props.placement='below'] - Where the panel opens.
 * @param {string} [props.panelClassName] - Width and alignment of the panel.
 * @returns {JSX.Element}
 */
function ProjectPicker({
  renderTrigger,
  placement = 'below',
  panelClassName = 'left-0 w-full min-w-[16rem]',
  onPick,
  multiple = false,
  disabled = false,
  ...panelProps
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  const close = useCallback(({ focusTrigger = true } = {}) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // A click outside closes the panel and leaves the focus where it went.
  useEffect(() => {
    if (!open) return undefined;
    const handle = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        close({ focusTrigger: false });
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open, close]);

  return (
    <div className="relative" ref={rootRef}>
      {renderTrigger({
        open,
        triggerProps: {
          ref: triggerRef,
          type: 'button',
          onClick: () => (open ? close() : !disabled && setOpen(true)),
          disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open
        }
      })}
      {open && (
        <div
          className={`absolute z-50 ${
            placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-1'
          } ${panelClassName}`}
        >
          <ProjectPickerPanel
            {...panelProps}
            multiple={multiple}
            disabled={disabled}
            focusOnMount
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
            onPick={id => {
              onPick(id);
              if (!multiple) close();
            }}
            onEscape={() => close()}
            onTab={() => close({ focusTrigger: false })}
          />
        </div>
      )}
    </div>
  );
}

export default ProjectPicker;
