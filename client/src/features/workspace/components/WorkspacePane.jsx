// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../../shared/hooks/useFocusTrap';
import PaneDivider from './PaneDivider';

/** Id of the pane element: the target of "Skip to workspace" and of F6. */
export const WORKSPACE_PANE_ID = 'workspace-pane';

/**
 * The box of the workspace pane. What is inside (index, artifact, file,
 * source) is the host's business; this decides only how the box sits:
 *
 * - `split`, docked: a flex sibling of the chat with the resizable divider on
 *   its left edge. Not modal: no focus trap, no `aria-modal`, no scrim.
 * - `split`, full screen: the same element grows to fill the row (the chat
 *   column hides), so the viewer inside is never remounted.
 * - `sheet`: below 1024px and on embedded surfaces, a full-screen
 *   `role="dialog"` with a focus trap.
 *
 * In every shape it is labelled "Workspace: {title}" and carries the one
 * polite live region of the pane, which never receives streamed text.
 *
 * @param {Object} props
 * @param {'split'|'sheet'} props.presentation
 * @param {boolean} props.full
 * @param {boolean} [props.hidden] - A sheet the user left with "Open chat": kept, not shown.
 * @param {string} props.title
 * @param {number} props.width
 * @param {number} props.containerWidth
 * @param {(width: number, how: string) => void} props.onResize
 * @param {() => void} props.onResizeEnd
 * @param {() => void} props.onResetWidth
 * @param {string} props.announcement - Text of the live region.
 * @param {import('react').ReactNode} [props.dock] - The composer dock (full screen).
 * @param {import('react').Ref} [props.paneRef]
 * @param {import('react').ReactNode} props.children
 */
export default function WorkspacePane({
  presentation,
  full,
  hidden = false,
  title,
  width,
  containerWidth,
  onResize,
  onResizeEnd,
  onResetWidth,
  announcement,
  dock = null,
  paneRef = null,
  children
}) {
  const { t } = useTranslation();
  const ownRef = useRef(null);
  const ref = paneRef || ownRef;
  const sheet = presentation === 'sheet';
  const label = t('workspace.regionLabel', 'Workspace: {{title}}', { title });
  useFocusTrap(ref, { isActive: sheet && !hidden, returnFocusOnDeactivate: false });

  const liveRegion = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="workspace-live"
    >
      {announcement}
    </div>
  );

  if (sheet) {
    return (
      <div
        ref={ref}
        id={WORKSPACE_PANE_ID}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        hidden={hidden}
        data-testid="workspace-pane"
        data-state="sheet"
        data-f6-region="pane"
        className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-gray-900"
      >
        {children}
        {dock}
        {liveRegion}
      </div>
    );
  }

  return (
    <>
      {!full && (
        <PaneDivider
          width={width}
          containerWidth={containerWidth}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          onReset={onResetWidth}
          controls={WORKSPACE_PANE_ID}
        />
      )}
      <section
        ref={ref}
        id={WORKSPACE_PANE_ID}
        aria-label={label}
        data-testid="workspace-pane"
        data-state={full ? 'full' : 'docked'}
        data-f6-region="pane"
        style={full ? undefined : { width, flexBasis: width }}
        className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-white dark:bg-gray-900 motion-safe:animate-workspace-in ${
          full ? 'flex-1' : 'flex-none border-l border-gray-200 dark:border-gray-700'
        }`}
      >
        {children}
        {dock}
        {liveRegion}
      </section>
    </>
  );
}
