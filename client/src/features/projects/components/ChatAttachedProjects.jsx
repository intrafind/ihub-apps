// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { setChatAttachedProjects } from '../../../api';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { projectErrorMessage } from '../utils/projectErrors';
import { projectDisplayName } from '../utils/projectView';

/** Most projects a chat may have attached (the server's `MAX_ATTACHED`). */
export const MAX_ATTACHED_PROJECTS = 10;

/**
 * The projects a chat draws on besides its own container: a chip per attached
 * project and an "Add project" list of the projects the viewer may use. The
 * model then reads those projects' documents (loaded or searched, as for a
 * project the chat runs in) without the chat having been started in them.
 *
 * Changes to a stored chat are saved at once; for a chat that is not stored
 * yet the list is kept here and rides on the next message (`projects`).
 *
 * @param {Object} props
 * @param {string|null} props.chatId
 * @param {boolean} props.stored - The chat exists server-side, so a change is saved now.
 * @param {string|null} [props.containerProjectId] - The project the chat runs in (not offered again).
 * @param {string[]} props.value - The attached project ids.
 * @param {(ids: string[]) => void} props.onChange
 * @param {boolean} [props.disabled]
 * @returns {JSX.Element|null}
 */
function ChatAttachedProjects({
  chatId,
  stored,
  containerProjectId = null,
  value,
  onChange,
  disabled = false
}) {
  const { t, i18n } = useTranslation();
  const { userProjectsEnabled } = useProjectsAvailability();
  const { projects } = useMyProjects();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const rootRef = useRef(null);
  const addButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = event => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Back to the button that opened the list, where the keyboard user was.
      addButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Only the viewer's own and shared user projects can be attached from here.
  const offered = projects.filter(
    project => project.ownership === 'user' && project.id !== containerProjectId
  );
  if (!userProjectsEnabled || (offered.length === 0 && value.length === 0)) return null;

  const nameOf = id => {
    const project = projects.find(entry => entry.id === id);
    return project
      ? projectDisplayName(project, i18n.language)
      : t('projects.chatBar.unnamed', 'Project');
  };

  const apply = async next => {
    setError(null);
    if (!stored || !chatId) {
      onChange(next);
      return;
    }
    setSaving(true);
    try {
      const result = await setChatAttachedProjects(chatId, next);
      onChange(
        Array.isArray(result?.chat?.attachedProjectIds) ? result.chat.attachedProjectIds : next
      );
    } catch (err) {
      setError(projectErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const toggle = id =>
    apply(value.includes(id) ? value.filter(entry => entry !== id) : [...value, id]);
  const full = value.length >= MAX_ATTACHED_PROJECTS;

  return (
    <div
      ref={rootRef}
      className="relative shrink-0 flex flex-wrap items-center justify-end gap-2 mb-2 text-xs"
      data-testid="chat-attached-projects"
    >
      {value.map(id => (
        <span
          key={id}
          className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 max-w-xs"
        >
          <Link
            to={`/projects/${encodeURIComponent(id)}`}
            className="inline-flex items-center gap-1 truncate hover:underline"
            title={t('projects.chatBar.open', 'Open the project')}
          >
            <Icon name="folder" size="xs" />
            <span className="truncate">{nameOf(id)}</span>
          </Link>
          <button
            type="button"
            onClick={() => toggle(id)}
            disabled={disabled || saving}
            aria-label={t('projects.attach.remove', 'Remove {{name}} from this chat', {
              name: nameOf(id)
            })}
            className="rounded-full p-0.5 hover:bg-purple-100 dark:hover:bg-purple-800/60 disabled:opacity-50"
          >
            <Icon name="x" size="xs" />
          </button>
        </span>
      ))}
      {offered.length > 0 && (
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setOpen(prev => !prev)}
          disabled={disabled}
          aria-expanded={open}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          <Icon name="plus" size="xs" />
          {t('projects.attach.add', 'Add project')}
        </button>
      )}
      {open && (
        <div
          role="group"
          aria-label={t('projects.attach.title', 'Projects for this chat')}
          className="absolute right-0 top-full z-20 mt-1 w-72 max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-2 text-sm"
        >
          <p className="px-2 pb-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'projects.attach.hint',
              'The answers can use the documents of the projects you tick. Their instructions do not apply.'
            )}
          </p>
          {offered.map(project => {
            const checked = value.includes(project.id);
            return (
              <label
                key={project.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || saving || (!checked && full)}
                  onChange={() => toggle(project.id)}
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
                />
                <span className="truncate text-gray-800 dark:text-gray-100">
                  {projectDisplayName(project, i18n.language)}
                </span>
              </label>
            );
          })}
          {full && (
            <p className="px-2 pt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projects.attach.full', 'A chat can use at most {{max}} projects.', {
                max: MAX_ATTACHED_PROJECTS
              })}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="basis-full text-right text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export default ChatAttachedProjects;
