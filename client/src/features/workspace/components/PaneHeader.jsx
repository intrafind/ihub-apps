// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  GHOST_BUTTON,
  ICON_BUTTON,
  SEGMENTED,
  segmentClass
} from '../../../shared/utils/buttonTokens';
import PaneMenu, { PaneMenuGroup, PaneMenuItem } from './PaneMenu';

/** Below this pane width Share moves into ⋯ and Download into the Copy dropdown. */
export const WIDE_HEADER_MIN = 480;

/**
 * @typedef {Object} MenuAction
 * @property {string} key
 * @property {string} [icon]
 * @property {string} label
 * @property {() => void} onClick
 * @property {boolean} [danger]
 * @property {string} [testId]
 */

/**
 * The one header of the workspace pane, shared by artifacts, uploaded files
 * and sources (concept §5):
 *
 * `[‹ back] [title ▾ BADGE] [center slot] … [Preview|Code] [Copy|▾] [⤓] [Share] [extra] [⤢] [✕] [⋯]`
 *
 * Narrow panes (< 480px) fold Share into ⋯ and Download into the Copy dropdown.
 * Every menu closes on Esc before anything else does.
 *
 * @param {Object} props
 * @param {string} props.title - Name of what is shown.
 * @param {string} [props.badge] - Type badge (`MD`, `PDF`, `Source`).
 * @param {string} [props.headingId] - Id of the heading (focused when the pane opens).
 * @param {import('react').Ref} [props.headingRef]
 * @param {{ label: string, onBack: () => void }|null} [props.back] - The back link of a detail.
 * @param {{ groups: Array<{ label: string, items: Array<{ key: string, name: string,
 *   hint?: string, current?: boolean, onSelect: () => void }> }> }|null} [props.switcher] - The
 *   "switch file" menu behind the title.
 * @param {import('react').ReactNode} [props.center] - Version / passage slot.
 * @param {{ mode: 'preview'|'code', onChange: (mode: string) => void }|null} [props.viewToggle]
 * @param {{ onCopy: () => void, menu: MenuAction[] }|null} [props.copy] - Copy split button.
 * @param {MenuAction|null} [props.download]
 * @param {MenuAction|null} [props.share] - Share, or "Open in source system" for a source.
 * @param {import('react').ReactNode} [props.extra] - A surface-specific visible button.
 * @param {{ full: boolean, onToggle: () => void }|null} [props.expand]
 * @param {{ label: string, onClose: () => void, icon?: string }|null} [props.close]
 * @param {MenuAction[]} [props.more] - The ⋯ menu.
 * @param {number} [props.paneWidth] - For the narrow fold.
 * @param {boolean} [props.full] - Taller header in full screen.
 * @param {import('react').ReactNode} [props.notice] - A short status line (copied, failed).
 * @param {import('react').ReactNode} [props.leading] - Content before the title (page mode).
 */
export default function PaneHeader({
  title,
  badge = null,
  headingId,
  headingRef = null,
  back = null,
  switcher = null,
  center = null,
  viewToggle = null,
  copy = null,
  download = null,
  share = null,
  extra = null,
  expand = null,
  close = null,
  more = [],
  paneWidth = Infinity,
  full = false,
  notice = null,
  leading = null
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const [openMenu, setOpenMenu] = useState(null);
  const toggle = useCallback(name => open => setOpenMenu(open ? name : null), []);
  const wide = paneWidth >= WIDE_HEADER_MIN;
  const run = action => () => {
    setOpenMenu(null);
    action.onClick();
  };

  const copyMenu = [...(copy?.menu || []), ...(!wide && copy && download ? [download] : [])];
  // Narrow: the view toggle becomes one ⋯ item, Share moves into ⋯ too.
  const viewItem =
    !wide && viewToggle
      ? [
          {
            key: 'view',
            icon: viewToggle.mode === 'code' ? 'eye' : 'code',
            label:
              viewToggle.mode === 'code'
                ? t('chatArtifacts.showPreview', 'Show preview')
                : t('chatArtifacts.showCode', 'Show code'),
            onClick: () => viewToggle.onChange(viewToggle.mode === 'code' ? 'preview' : 'code'),
            testId: 'artifact-viewer-code-toggle'
          }
        ]
      : [];
  const moreMenu = [...viewItem, ...(!wide && share ? [share] : []), ...more];
  const showDownloadButton = download && (wide || !copy);
  const switcherItems = switcher?.groups?.reduce((n, group) => n + group.items.length, 0) || 0;

  const titleContent = (
    <>
      <span className="truncate">{title}</span>
      {badge && wide && (
        <span
          className="flex-none rounded bg-gray-200 dark:bg-gray-600 px-1 text-[10px] font-semibold uppercase text-gray-700 dark:text-gray-100"
          data-testid="pane-badge"
        >
          {badge}
        </span>
      )}
    </>
  );

  return (
    <header
      className={`flex ${full ? 'h-14' : 'h-12'} flex-none items-center gap-1 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2`}
      data-testid="artifact-viewer-toolbar"
    >
      {back && (
        <button
          type="button"
          onClick={back.onBack}
          className={`${GHOST_BUTTON} max-w-[9rem] px-1.5`}
          data-testid="pane-back"
          aria-label={t('workspace.backTo', 'Back to {{name}}', { name: back.label })}
        >
          <Icon name="chevron-left" size="sm" className="flex-none" />
          <span className={wide ? 'truncate' : 'sr-only'}>{back.label}</span>
        </button>
      )}
      {leading}
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="m-0 flex min-w-0 items-center text-sm font-semibold text-gray-900 dark:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-md"
      >
        {switcher && switcherItems > 1 ? (
          <PaneMenu
            id={`${baseId}-switch`}
            open={openMenu === 'switch'}
            onToggle={toggle('switch')}
            label={t('workspace.switchFile', 'Switch file')}
            className="min-w-0"
            trigger={props => (
              <button
                type="button"
                {...props}
                data-testid="artifact-viewer-name"
                title={title}
                aria-label={t('workspace.switchFileNamed', '{{name}}, switch file', {
                  name: title
                })}
                className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {titleContent}
                <Icon name="chevron-down" size="xs" className="flex-none" />
              </button>
            )}
          >
            {switcher.groups
              .filter(group => group.items.length > 0)
              .map(group => (
                <div key={group.label} role="group" aria-label={group.label}>
                  <PaneMenuGroup label={group.label} />
                  {group.items.map(item => (
                    <PaneMenuItem
                      key={item.key}
                      label={item.name}
                      hint={item.hint}
                      current={item.current}
                      onClick={() => {
                        setOpenMenu(null);
                        item.onSelect();
                      }}
                    />
                  ))}
                </div>
              ))}
          </PaneMenu>
        ) : (
          <span
            className="inline-flex min-w-0 items-center gap-1.5 px-2"
            title={title}
            data-testid="artifact-viewer-name"
          >
            {titleContent}
          </span>
        )}
      </h2>
      {center}

      <div className="ml-auto flex min-w-0 flex-none items-center gap-1">
        <span
          aria-hidden="true"
          className="hidden min-w-0 max-w-[12rem] truncate px-1 text-xs text-gray-600 dark:text-gray-300 lg:block empty:hidden"
        >
          {notice}
        </span>
        {viewToggle && wide && (
          <div role="group" aria-label={t('workspace.viewMode', 'View')} className={SEGMENTED}>
            <button
              type="button"
              aria-pressed={viewToggle.mode === 'preview'}
              className={segmentClass(viewToggle.mode === 'preview')}
              onClick={() => viewToggle.onChange('preview')}
              data-testid="pane-view-preview"
            >
              <Icon name="eye" size="xs" />
              {t('workspace.preview', 'Preview')}
            </button>
            <button
              type="button"
              aria-pressed={viewToggle.mode === 'code'}
              className={segmentClass(viewToggle.mode === 'code')}
              onClick={() => viewToggle.onChange('code')}
              data-testid="artifact-viewer-code-toggle"
            >
              <Icon name="code" size="xs" />
              {t('workspace.code', 'Code')}
            </button>
          </div>
        )}
        {copy && (
          <div className="inline-flex flex-none items-center">
            <button
              type="button"
              className={`${GHOST_BUTTON} rounded-r-none pr-2`}
              onClick={copy.onCopy}
              data-testid="artifact-viewer-copy"
            >
              <Icon name="copy" size="sm" />
              <span className={wide ? '' : 'sr-only'}>{t('chatArtifacts.copy', 'Copy')}</span>
            </button>
            {copyMenu.length > 0 && (
              <PaneMenu
                id={`${baseId}-copy`}
                open={openMenu === 'copy'}
                onToggle={toggle('copy')}
                label={t('workspace.copyMenu', 'More copy and download options')}
                align="right"
                trigger={props => (
                  <button
                    type="button"
                    {...props}
                    className={`${ICON_BUTTON} w-6 rounded-l-none border-l border-gray-200 dark:border-gray-600`}
                    aria-label={t('workspace.copyMenu', 'More copy and download options')}
                    title={t('workspace.copyMenu', 'More copy and download options')}
                    data-testid="artifact-viewer-export"
                  >
                    <Icon name="chevron-down" size="xs" />
                  </button>
                )}
              >
                {copyMenu.map(action => (
                  <PaneMenuItem
                    key={action.key}
                    icon={action.icon}
                    label={action.label}
                    onClick={run(action)}
                    data-testid={action.testId}
                  />
                ))}
              </PaneMenu>
            )}
          </div>
        )}
        {showDownloadButton && (
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={download.onClick}
            aria-label={download.ariaLabel || download.label}
            title={download.label}
            data-testid={download.testId || 'artifact-viewer-download'}
          >
            <Icon name="download" size="sm" />
          </button>
        )}
        {share && wide && (
          <button
            type="button"
            className={GHOST_BUTTON}
            onClick={share.onClick}
            data-testid={share.testId || 'artifact-viewer-share'}
          >
            <Icon name={share.icon || 'share'} size="sm" />
            {share.label}
          </button>
        )}
        {extra}
        {expand && (
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={expand.onToggle}
            aria-pressed={expand.full}
            aria-label={
              expand.full
                ? t('workspace.exitFullScreen', 'Exit full screen')
                : t('workspace.fullScreen', 'Full screen')
            }
            title={`${
              expand.full
                ? t('workspace.exitFullScreen', 'Exit full screen')
                : t('workspace.fullScreen', 'Full screen')
            } (Ctrl+Shift+E)`}
            data-testid="pane-expand"
          >
            <Icon name={expand.full ? 'arrows-pointing-in' : 'arrows-pointing-out'} size="sm" />
          </button>
        )}
        {close && (
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={close.onClose}
            aria-label={close.label}
            title={close.label}
            data-testid="artifact-viewer-close"
          >
            <Icon name={close.icon || 'x'} size="md" />
          </button>
        )}
        {moreMenu.length > 0 && (
          <PaneMenu
            id={`${baseId}-more`}
            open={openMenu === 'more'}
            onToggle={toggle('more')}
            label={t('workspace.moreActions', 'More actions')}
            align="right"
            trigger={props => (
              <button
                type="button"
                {...props}
                className={ICON_BUTTON}
                aria-label={t('workspace.moreActions', 'More actions')}
                title={t('workspace.moreActions', 'More actions')}
                data-testid="pane-more"
              >
                <Icon name="ellipsis-vertical" size="sm" />
              </button>
            )}
          >
            {moreMenu.map(action => (
              <PaneMenuItem
                key={action.key}
                icon={action.icon}
                label={action.label}
                danger={action.danger}
                onClick={run(action)}
                data-testid={action.testId}
              />
            ))}
          </PaneMenu>
        )}
      </div>
    </header>
  );
}
