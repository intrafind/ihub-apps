// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { GHOST_BUTTON, PRIMARY_BUTTON } from '../../../shared/utils/buttonTokens';
import { saveBlobAs } from '../../../utils/externalNavigation';
import PaneHeader from '../../workspace/components/PaneHeader';
import { answerIndex, revealMessage } from '../../workspace/utils/workspaceItems';
import { artifactDisplayName, fileLookOf, formatBytes, zipErrorCode } from '../utils/artifactFiles';
import {
  questionOfFiles,
  uploadedFileBadge,
  uploadedFileLook,
  uploadedStorageState
} from '../utils/uploadedFiles';

function formatDate(value, language) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(language || undefined, {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  } catch {
    return '';
  }
}

const ROW =
  'flex h-14 min-w-0 items-center gap-2 border-l-2 px-3 hover:bg-gray-50 dark:hover:bg-gray-800/60';
const rowClass = active =>
  `${ROW} ${active ? 'border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/30' : 'border-transparent'}`;
const ROW_BUTTON =
  'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500';

/** The type tile of a row. */
function Tile({ look }) {
  return (
    <span
      className={`flex h-8 w-8 flex-none items-center justify-center rounded-md ${look.className}`}
      aria-hidden="true"
    >
      <Icon name={look.icon} size="sm" />
    </span>
  );
}

/** "Answer 3": scrolls the chat to that answer and highlights it. */
function AnswerLink({ number, messageId, onReveal }) {
  const { t } = useTranslation();
  if (!number) return null;
  return (
    <button
      type="button"
      onClick={() => (onReveal ? onReveal(messageId) : revealMessage(messageId))}
      disabled={!messageId}
      className="flex-none rounded px-1 text-xs font-medium text-indigo-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:text-gray-500 disabled:no-underline dark:text-indigo-300"
      aria-label={t('workspace.showAnswer', 'Show answer {{number}} in the chat', { number })}
    >
      {t('chatArtifacts.fromAnswer', 'Answer {{number}}', { number })}
    </button>
  );
}

function Empty({ children, testId }) {
  return (
    <div
      className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-gray-600 dark:text-gray-300"
      data-testid={testId}
    >
      <Icon name="archive-box" size="lg" className="text-gray-400" />
      <p className="max-w-xs">{children}</p>
    </div>
  );
}

/**
 * The Files index of the workspace pane (concept §7): the root of the pane's
 * list → detail stack, in place of the old Files drawer. Three tabs —
 * Generated, Uploaded, Sources — of one list each; a click on a row opens its
 * detail in the pane, the checkbox of a generated file selects it without
 * navigating, and the selection (or everything) downloads as one ZIP the
 * server builds.
 *
 * The index does not know whose chat it is: the host hands it the lists it
 * read (the owner's routes, or a share's), so a shared chat gets the same view
 * with exactly the files its snapshot named.
 *
 * @param {Object} props
 * @param {Object} props.chrome - What the pane gives every view (close, expand, heading).
 * @param {'generated'|'uploaded'|'sources'|null} props.tab - Shown tab; null picks the first with items.
 * @param {(tab: string) => void} props.onTab
 * @param {{ status: string, items: Object[] }} props.generated
 * @param {{ status: string, items: Object[] }|null} props.uploaded - Null: no Uploaded tab.
 * @param {Array<{ source: Object, answer: number, messageId: string|null }>} props.sources
 * @param {Object[]} [props.messages]
 * @param {string|null} [props.activeId] - The item last open in the pane.
 * @param {(item: Object) => void} props.onOpenArtifact
 * @param {(item: Object) => void} [props.onOpenFile]
 * @param {(entry: Object) => void} [props.onOpenSource]
 * @param {((ids?: string[]) => Promise<Blob>)|null} [props.zip]
 * @param {string} [props.zipName]
 * @param {'none'|'extracted_text'|'original'|null} [props.uploadedAccess] - Shared chat only.
 */
export default function ArtifactsPanel({
  chrome,
  tab,
  onTab,
  generated,
  uploaded = null,
  sources = [],
  messages,
  activeId = null,
  onOpenArtifact,
  onOpenFile = null,
  onOpenSource = null,
  zip = null,
  zipName = 'artifacts',
  uploadedAccess = null
}) {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  const selectAllRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const answers = useMemo(() => answerIndex(messages), [messages]);
  const questions = useMemo(
    () => questionOfFiles(uploaded?.items || [], messages),
    [uploaded?.items, messages]
  );

  const items = generated.items;
  const tabs = [
    ['generated', t('chatFiles.tabGenerated', 'Generated'), items.length],
    ...(uploaded
      ? [['uploaded', t('chatFiles.tabUploaded', 'Uploaded'), uploaded.items.length]]
      : []),
    ...(onOpenSource ? [['sources', t('workspace.tabSources', 'Sources'), sources.length]] : [])
  ];
  const firstWithItems = tabs.find(([, , count]) => count > 0)?.[0] || 'generated';
  const activeTab = tabs.some(([id]) => id === tab) ? tab : firstWithItems;

  // Selected files that are gone from the list are no longer selected.
  useEffect(() => {
    setSelected(previous => new Set([...previous].filter(id => items.some(i => i.id === id))));
  }, [items]);

  const allSelected = items.length > 0 && selected.size === items.length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && !allSelected;
    }
  }, [selected, allSelected]);

  const toggle = id =>
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map(item => item.id)));

  const say = (tone, text) => {
    setNotice({ tone, text });
    chrome?.announce?.(text);
  };

  const downloadZip = async ids => {
    setBusy(true);
    say('info', t('chatArtifacts.zipPreparing', 'Preparing the ZIP archive…'));
    try {
      const blob = await zip(ids);
      if (!saveBlobAs(blob, `${zipName}.zip`)) throw new Error('save');
      setNotice(null);
    } catch (error) {
      const code = await zipErrorCode(error);
      say(
        'error',
        code === 'too-many-files'
          ? t('chatArtifacts.zipTooMany', 'Too many files for one ZIP archive. Select fewer files.')
          : code === 'too-large'
            ? t(
                'chatArtifacts.zipTooLarge',
                'The files are too large for one ZIP archive. Select fewer files.'
              )
            : t(
                'chatArtifacts.zipFailed',
                'The ZIP archive could not be created. Please try again.'
              )
      );
    } finally {
      setBusy(false);
    }
  };

  const onTabKeyDown = event => {
    const index = tabs.findIndex(([id]) => id === activeTab);
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    onTab(tabs[next][0]);
    requestAnimationFrame(() => document.getElementById(`${baseId}-tab-${tabs[next][0]}`)?.focus());
  };

  const loadingLine = text => (
    <p className="p-4 text-sm text-gray-500 dark:text-gray-400" role="status">
      {text}
    </p>
  );

  let body;
  if (activeTab === 'generated') {
    if (generated.status === 'loading' || generated.status === 'idle') {
      body = loadingLine(t('chatArtifacts.loading', 'Loading the files of this chat…'));
    } else if (generated.status === 'error') {
      body = (
        <p className="p-4 text-sm text-red-700 dark:text-red-400" role="alert">
          {t('chatArtifacts.loadFailed', 'The files of this chat could not be loaded.')}
        </p>
      );
    } else if (items.length === 0) {
      body = (
        <Empty testId="generated-empty">
          {t(
            'workspace.emptyFiles',
            'No files yet. Files the assistant creates or you upload appear here.'
          )}
        </Empty>
      );
    } else {
      body = (
        <>
          <div className="flex h-10 flex-none items-center gap-2 border-b border-gray-200 px-3 dark:border-gray-700">
            <label className="mr-auto inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-gray-400"
              />
              {t('chatArtifacts.selectAll', 'Select all')}
            </label>
            {zip && (
              <button
                type="button"
                className={GHOST_BUTTON}
                disabled={busy}
                onClick={() => downloadZip(undefined)}
                data-testid="files-download-all"
              >
                <Icon name="download" size="sm" />
                {t('chatArtifacts.downloadAll', 'Download all (.zip)')}
              </button>
            )}
          </div>
          <ul
            className="min-h-0 flex-1 overflow-y-auto py-1"
            aria-label={t('chatArtifacts.listLabel', 'Files of this chat')}
          >
            {items.map(item => {
              const name = artifactDisplayName(item);
              const answer =
                (item.runId && answers.byRun.get(item.runId)) || answers.byId.get(item.id);
              const current = item.id === activeId;
              return (
                <li key={item.id} className={rowClass(current)} data-testid="files-row">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={t('chatArtifacts.selectNamed', 'Select {{name}}', { name })}
                    className="h-4 w-4 flex-none rounded border-gray-400"
                  />
                  <button
                    type="button"
                    onClick={() => onOpenArtifact(item)}
                    aria-current={current ? 'true' : undefined}
                    className={ROW_BUTTON}
                    data-testid="files-row-open"
                  >
                    <Tile look={fileLookOf(item)} />
                    <span className="min-w-0">
                      <span
                        className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                        title={name}
                      >
                        {name}
                      </span>
                      <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
                        {[formatBytes(item.bytes), formatDate(item.createdAt, i18n.language)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                  <AnswerLink
                    number={answer}
                    messageId={answers.messageIdOf.get(answer)}
                    onReveal={chrome?.onRevealMessage}
                  />
                </li>
              );
            })}
          </ul>
          {selected.size > 0 && zip && (
            <div
              className="sticky bottom-0 flex flex-none items-center gap-2 border-t border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              data-testid="files-selection-bar"
            >
              <span className="mr-auto text-sm text-gray-700 dark:text-gray-200">
                {t('workspace.selectedCount', '{{count}} selected', { count: selected.size })}
              </span>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => downloadZip(items.filter(i => selected.has(i.id)).map(i => i.id))}
              >
                <Icon name="archive-box" size="sm" />
                {t('workspace.downloadZip', 'Download .zip')}
              </button>
              <button type="button" className={GHOST_BUTTON} onClick={() => setSelected(new Set())}>
                {t('workspace.clearSelection', 'Clear')}
              </button>
            </div>
          )}
        </>
      );
    }
  } else if (activeTab === 'uploaded') {
    if (uploaded.status === 'loading' || uploaded.status === 'idle') {
      body = loadingLine(t('chatFiles.loading', 'Loading the uploaded files…'));
    } else if (uploaded.status === 'error') {
      body = (
        <p className="p-4 text-sm text-red-700 dark:text-red-400" role="alert">
          {t('chatFiles.loadFailed', 'The uploaded files could not be loaded.')}
        </p>
      );
    } else if (uploaded.items.length === 0) {
      body = (
        <Empty testId="uploaded-empty">
          {uploadedAccess === 'none'
            ? t('chatFiles.notShared', 'The owner did not share the files attached to this chat.')
            : t(
                'chatFiles.empty',
                'No files uploaded to this chat yet. Documents, emails and pages you attach appear here.'
              )}
        </Empty>
      );
    } else {
      body = (
        <ul
          className="min-h-0 flex-1 overflow-y-auto py-1"
          aria-label={t('chatFiles.listLabel', 'Files uploaded to this chat')}
          data-testid="uploaded-files-tab"
        >
          {uploaded.items.map(item => {
            const state = uploadedStorageState(item);
            const current = item.id === activeId;
            const question = questions.get(item.id);
            return (
              <li key={item.id} className={rowClass(current)} data-testid="files-row">
                <button
                  type="button"
                  onClick={() => onOpenFile?.(item)}
                  aria-current={current ? 'true' : undefined}
                  className={ROW_BUTTON}
                >
                  <Tile look={uploadedFileLook(item)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      <span
                        className="flex-none rounded bg-gray-200 px-1 text-[10px] font-semibold text-gray-700 dark:bg-gray-600 dark:text-gray-100"
                        data-testid="uploaded-badge"
                      >
                        {uploadedFileBadge(item)}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
                      {[
                        formatBytes(item.bytes),
                        Number.isFinite(item.pages)
                          ? t('chatFiles.pages', '{{count}} pages', { count: item.pages })
                          : null,
                        state === 'original'
                          ? t('chatFiles.stateOriginal', 'Original saved')
                          : state === 'expired'
                            ? t('chatFiles.stateExpired', 'Original removed')
                            : t('chatFiles.stateTextOnly', 'Text only'),
                        question
                          ? t('chatFiles.question', 'Question {{number}}', { number: question })
                          : null
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      );
    }
  } else if (sources.length === 0) {
    body = (
      <Empty testId="sources-empty">
        {t('workspace.emptySources', 'No sources yet. Documents an answer cites appear here.')}
      </Empty>
    );
  } else {
    body = (
      <ul
        className="min-h-0 flex-1 overflow-y-auto py-1"
        aria-label={t('workspace.sourcesListLabel', 'Sources cited in this chat')}
      >
        {sources.map(entry => {
          const { source } = entry;
          const current = source.id === activeId;
          return (
            <li key={source.id} className={rowClass(current)} data-testid="files-row">
              <button
                type="button"
                onClick={() => onOpenSource(entry)}
                aria-current={current ? 'true' : undefined}
                className={ROW_BUTTON}
              >
                <Tile
                  look={{
                    icon: 'book-open',
                    className: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                  }}
                />
                <span className="min-w-0">
                  <span
                    className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                    title={source.title}
                  >
                    {source.title || source.fileName || source.url}
                  </span>
                  <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
                    {[source.site || source.scopeName, source.type].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
              <AnswerLink
                number={entry.answer}
                messageId={entry.messageId}
                onReveal={chrome?.onRevealMessage}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifacts-panel">
      <PaneHeader
        title={t('chatFiles.title', 'Files')}
        headingId={chrome?.headingId}
        headingRef={chrome?.headingRef}
        expand={chrome?.expand}
        close={chrome?.close}
        paneWidth={chrome?.paneWidth}
        full={chrome?.full}
      />
      <div
        role="tablist"
        aria-label={t('chatFiles.tabsLabel', 'Kinds of files in this chat')}
        className="flex flex-none gap-1 border-b border-gray-200 px-3 dark:border-gray-700"
      >
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${id}`}
            aria-selected={activeTab === id}
            aria-controls={`${baseId}-panel`}
            tabIndex={activeTab === id ? 0 : -1}
            data-testid={`files-tab-${id}`}
            onClick={() => onTab(id)}
            onKeyDown={onTabKeyDown}
            className={`-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
              activeTab === id
                ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
                : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
            }`}
          >
            {label}
            <span className="rounded-full bg-gray-100 px-1.5 text-xs tabular-nums text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              {count}
            </span>
          </button>
        ))}
      </div>
      {notice && (
        <p
          className={`flex-none px-3 py-1.5 text-sm ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}`}
          role={notice.tone === 'error' ? 'alert' : undefined}
        >
          {notice.text}
        </p>
      )}
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body}
      </div>
    </div>
  );
}
