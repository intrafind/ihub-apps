// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { linkSourceProjects, linkableItems } from '../../utils/projectItems';
import { projectDisplayName } from '../../utils/projectView';
import ProjectItemStatus from '../ProjectItemStatus';
import CheckableList from './CheckableList';
import { INPUT_CLASS, LABEL_CLASS, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialogStyles';

/**
 * The "From another project" tab of the "Add item" dialog: pick a project
 * the viewer may use, tick its documents, and add each as a link
 * (`kind: 'project-item'`). Nothing is copied: chats read the original, with
 * the reading user's own access to its project.
 *
 * @param {Object} props
 * @param {string} props.projectId - The project the links go into.
 * @param {Object|null} props.project - That project, to mark documents it links already.
 * @param {Object} props.api - See `AddProjectItemDialog`; uses `fetchLinkSources`,
 *   `fetchLinkSource`, `addItem` and `errorMessage`.
 * @param {(item: Object) => void} props.onAdded
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function ProjectLinkTab({ projectId, project, api, onAdded, onClose }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [projects, setProjects] = useState(null);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .fetchLinkSources()
      .then(list => active && setProjects(linkSourceProjects(list, projectId)))
      .catch(err => {
        if (!active) return;
        setProjects([]);
        setError(api.errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api, projectId]);

  useEffect(() => {
    if (!sourceId) return undefined;
    let active = true;
    api
      .fetchLinkSource(sourceId)
      .then(loaded => active && setSource(loaded))
      .catch(err => active && setError(api.errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, sourceId]);

  const items = useMemo(
    () => (source && source.id === sourceId ? linkableItems(source, project) : []),
    [source, sourceId, project]
  );

  const choose = id => {
    setSourceId(id);
    setSource(null);
    setPicked(new Set());
    setError(null);
  };

  const toggle = itemId =>
    setPicked(previous => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const handleAdd = async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    const failures = [];
    let added = 0;
    for (const entry of items.filter(candidate => picked.has(candidate.item.id))) {
      try {
        onAdded(
          await api.addItem(projectId, {
            kind: 'project-item',
            ref: { projectId: sourceId, itemId: entry.item.id },
            pinned
          })
        );
        added += 1;
      } catch (err) {
        failures.push(`${entry.item.name}: ${api.errorMessage(err)}`);
      }
    }
    setBusy(false);
    if (failures.length === 0) {
      onClose();
      return;
    }
    setError(failures.join('\n'));
    if (added > 0) setPicked(new Set());
  };

  if (projects === null) {
    return (
      <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
        {t('common.loading', 'Loading...')}
      </p>
    );
  }

  return (
    <>
      <div className="px-6 py-4 space-y-3 overflow-y-auto">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'projects.addItem.linkHint',
            'Linked documents are not copied: chats read the original, so changes there show here too. Someone who uses this project sees a linked document only if they may use its project as well.'
          )}
        </p>
        {projects.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('projects.addItem.linkNoProjects', 'There is no other project you can use.')}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[14rem]">
              <label htmlFor="project-item-link-source" className={LABEL_CLASS}>
                {t('projects.addItem.linkProject', 'Project')}
              </label>
              <select
                id="project-item-link-source"
                value={sourceId}
                onChange={e => choose(e.target.value)}
                disabled={busy}
                className={INPUT_CLASS}
              >
                <option value="">
                  {t('projects.addItem.linkChooseProject', 'Choose a project…')}
                </option>
                {projects.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.ownership !== 'admin'
                      ? projectDisplayName(candidate, language)
                      : candidate.published === true
                        ? t('projects.addItem.linkPublished', '{{name}} (published)', {
                            name: projectDisplayName(candidate, language)
                          })
                        : t('projects.addItem.linkFromApps', '{{name}} (from apps)', {
                            name: projectDisplayName(candidate, language)
                          })}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2">
              <input
                type="checkbox"
                checked={pinned}
                onChange={e => setPinned(e.target.checked)}
                disabled={busy}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
              />
              {t('projects.addItem.pinned', 'Pinned (always in the prompt)')}
            </label>
          </div>
        )}
        {sourceId && !source && !error && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        )}
        {source && source.id === sourceId && items.length === 0 && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('projects.addItem.linkNoItems', 'This project has no documents.')}
          </p>
        )}
        {items.length > 0 && (
          <fieldset>
            <legend className={LABEL_CLASS}>
              {t('projects.addItem.linkDocuments', 'Documents')}
            </legend>
            <CheckableList
              rows={items.map(({ item, linked, unavailable }) => ({
                key: item.id,
                checked: linked || picked.has(item.id),
                onToggle: () => toggle(item.id),
                // A link whose original this viewer cannot read is refused
                // by the server: no use offering it.
                disabled: linked || unavailable || busy,
                muted: linked || unavailable,
                content: (
                  <span className="block truncate text-gray-900 dark:text-gray-100">
                    {item.name}
                  </span>
                ),
                badge: linked ? (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t('projects.addItem.linkAlready', 'Already linked')}
                  </span>
                ) : (
                  <ProjectItemStatus item={item} />
                )
              }))}
            />
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 whitespace-pre-line">
            {error}
          </p>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={picked.size === 0 || busy}
          className={PRIMARY_BUTTON}
        >
          {picked.size > 0
            ? t('projects.addItem.linkSubmit', 'Link {{count}} documents', { count: picked.size })
            : t('projects.addItem.linkSubmitNone', 'Link documents')}
        </button>
      </div>
    </>
  );
}

export default ProjectLinkTab;
