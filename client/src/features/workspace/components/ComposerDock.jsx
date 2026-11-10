// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { GHOST_BUTTON, ICON_BUTTON } from '../../../shared/utils/buttonTokens';

/**
 * The chat of the full-screen workspace (concept §6.4): a floating composer
 * dock at the bottom centre of the pane.
 *
 * - Collapsed, one line: "Ask to change this document…". Activating it expands
 *   the dock and puts focus in the composer.
 * - Expanded: a snippet of the latest answer and its state, the composer, and
 *   "Open chat", which returns to the docked pane (or, on a sheet, back to the
 *   chat with the item kept for one tap to reopen).
 *
 * The dock is one implementation of the host's `renderFullScreenChat` slot;
 * a collapsible chat column (open decision §12 Q1) can take its place with the
 * same inputs. The pane announces when an answer is ready; the snippet itself
 * is not a live region, so streamed text is never read out token by token.
 *
 * @param {Object} props
 * @param {boolean} props.expanded
 * @param {(expanded: boolean) => void} props.onExpandedChange
 * @param {import('react').ReactNode} props.composer - The chat's composer, bound to its draft.
 * @param {{ text: string, streaming: boolean }|null} [props.latest] - The latest answer.
 * @param {() => void} props.onOpenChat
 * @param {(height: number) => void} [props.onHeightChange] - So the document keeps its last
 *   lines clear of the dock.
 */
export default function ComposerDock({
  expanded,
  onExpandedChange,
  composer,
  latest = null,
  onOpenChat,
  onHeightChange
}) {
  const { t } = useTranslation();
  const ref = useRef(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onHeightChange) return undefined;
    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height) + 24);
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange, expanded]);

  useEffect(() => () => onHeightChange?.(0), [onHeightChange]);

  // Expanding puts the caret in the composer.
  useEffect(() => {
    if (!expanded) return undefined;
    const frame = requestAnimationFrame(() => ref.current?.querySelector('textarea')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  return (
    <div
      ref={ref}
      data-testid="composer-dock"
      data-expanded={expanded ? 'true' : 'false'}
      data-f6-region="dock"
      className="absolute bottom-4 left-1/2 z-20 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
    >
      {/* The dock itself has no background: the document scrolls visibly behind it.
          The parts that have to stay legible (the answer snippet, the composer, the
          collapsed bar) carry their own backing. */}
      {expanded ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white/90 p-2 shadow-md backdrop-blur dark:border-gray-700 dark:bg-gray-800/90">
            <div className="min-w-0 flex-1 text-xs text-gray-700 dark:text-gray-200">
              {latest?.text ? (
                <p className="line-clamp-2" data-testid="composer-dock-latest">
                  <span className="font-medium">
                    {latest.streaming
                      ? t('workspace.dock.answering', 'Answering…')
                      : t('workspace.dock.latest', 'Latest answer:')}
                  </span>{' '}
                  {latest.text}
                </p>
              ) : (
                <p className="text-gray-500 dark:text-gray-400">
                  {t(
                    'workspace.dock.hint',
                    'Ask a question or ask for a change. The chat keeps going.'
                  )}
                </p>
              )}
            </div>
            <button
              type="button"
              className={`${GHOST_BUTTON} h-7 px-2 text-xs`}
              onClick={onOpenChat}
              data-testid="composer-dock-open-chat"
            >
              <Icon name="chat-bubble-left-right" size="xs" />
              {t('workspace.dock.openChat', 'Open chat')}
            </button>
            <button
              type="button"
              className={`${ICON_BUTTON} h-7 w-7`}
              onClick={() => onExpandedChange(false)}
              aria-label={t('workspace.dock.collapse', 'Collapse chat')}
              title={t('workspace.dock.collapse', 'Collapse chat')}
            >
              <Icon name="chevron-down" size="sm" />
            </button>
          </div>
          <div data-workspace-composer>{composer}</div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          className="flex h-12 w-full items-center gap-2 rounded-2xl border border-gray-200 bg-white/90 px-4 text-left text-sm text-gray-600 shadow-xl backdrop-blur hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800/90 dark:text-gray-300 dark:hover:bg-gray-700/60"
          data-testid="composer-dock-expand"
        >
          <Icon name="sparkles" size="sm" className="text-indigo-600 dark:text-indigo-300" />
          <span className="flex-1 truncate">
            {t('workspace.dock.placeholder', 'Ask to change this document…')}
          </span>
          {latest?.streaming && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('workspace.dock.answering', 'Answering…')}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
