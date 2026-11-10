// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useWorkspaceLayout } from '../contexts/WorkspaceLayoutContext';
import { PANE_LIMITS } from '../utils/workspaceState';

/**
 * The layout slot of the workspace pane: a flex row of the chat column and
 * the pane, so the chat reflows next to it. In full screen the chat column is
 * hidden (not unmounted: its scroll position, draft and running answer stay)
 * and the pane, the same element, fills the row.
 *
 * Outside an `ArtifactViewerHost` with `inline`, or while the pane is a sheet
 * or closed, it renders the chat column alone.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.children - The chat column.
 * @param {string} [props.className] - Classes of the row.
 * @param {string} [props.chatClassName] - Classes of the chat column.
 */
export default function WorkspaceLayout({ children, className = '', chatClassName = '' }) {
  const layout = useWorkspaceLayout();
  const rowRef = useRef(null);
  const setContainerWidth = layout?.setContainerWidth;

  // A passive effect, not a layout one: a synchronous update while the chat page
  // mounts would run the page's own effects in another order.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !setContainerWidth) return undefined;
    const report = () => setContainerWidth(row.getBoundingClientRect().width);
    report();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', report);
      return () => window.removeEventListener('resize', report);
    }
    const observer = new ResizeObserver(report);
    observer.observe(row);
    return () => observer.disconnect();
  }, [setContainerWidth]);

  const split = Boolean(layout?.split);
  const hideChat = split && layout.full;
  return (
    <div
      ref={rowRef}
      className={`flex min-h-0 min-w-0 flex-1 ${className}`}
      data-testid="workspace-layout"
    >
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${chatClassName}`}
        style={split && !hideChat ? { minWidth: PANE_LIMITS.chatMin } : undefined}
        hidden={hideChat}
        data-testid="workspace-chat-column"
      >
        {children}
      </div>
      {split && layout.pane}
    </div>
  );
}
