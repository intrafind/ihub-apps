// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { paneWidthBounds, widthAfterKey, widthPercent } from '../utils/workspaceState';

/**
 * The resizable edge between the chat and the docked pane: a vertical
 * `role="separator"` that is focusable and holds a value.
 *
 * - Drag with a pointer (mouse, pen, touch).
 * - ArrowLeft/ArrowRight resize by 16px (64px with Shift); Home/End snap to the limits.
 * - Double-click resets the width to the default (the only thing it does).
 *
 * @param {Object} props
 * @param {number} props.width - Current pane width in px.
 * @param {number} props.containerWidth - Width of the row the chat and the pane share.
 * @param {(width: number, how: 'drag'|'key') => void} props.onResize - A new width.
 * @param {() => void} props.onResizeEnd - Dragging ended (save the width).
 * @param {() => void} props.onReset - Double-click: back to the default width.
 * @param {string} props.controls - Id of the pane the divider resizes.
 */
export default function PaneDivider({
  width,
  containerWidth,
  onResize,
  onResizeEnd,
  onReset,
  controls
}) {
  const { t } = useTranslation();
  const dragRef = useRef(null);
  const { min, max } = paneWidthBounds(containerWidth);

  const onPointerDown = event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = event => {
    const drag = dragRef.current;
    if (!drag) return;
    // The divider is on the pane's left edge: moving left makes the pane wider.
    onResize(drag.startWidth + (drag.startX - event.clientX), 'drag');
  };
  const endDrag = event => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onResizeEnd();
  };
  const onKeyDown = event => {
    const next = widthAfterKey(event.key, width, containerWidth, { shiftKey: event.shiftKey });
    if (next === null) return;
    event.preventDefault();
    onResize(next, 'key');
    onResizeEnd();
  };

  const percent = widthPercent(width, containerWidth);
  return (
    // A focusable separator is an interactive widget (WAI-ARIA window splitter).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the window splitter pattern
      tabIndex={0}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={t('workspace.resize', 'Resize workspace')}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={t('workspace.widthPercent', 'Workspace {{percent}} percent', { percent })}
      data-testid="workspace-divider"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className="group relative z-10 -mr-1 w-2 flex-none cursor-col-resize touch-none select-none focus:outline-none"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gray-200 dark:bg-gray-700 group-hover:w-0.5 group-hover:bg-indigo-400 group-focus-visible:w-0.5 group-focus-visible:bg-indigo-500 motion-safe:transition-all"
      />
    </div>
  );
}
