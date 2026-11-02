// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XMarkIcon } from '@heroicons/react/24/outline';
import useFocusTrap, { getFocusableElements } from '../hooks/useFocusTrap';

/** Panel width from the `sm` breakpoint up; below it the panel is full width. */
const WIDTHS = {
  sm: 'sm:w-96',
  md: 'sm:w-[480px]',
  lg: 'sm:w-[42rem]'
};

/**
 * Locks page scrolling while `isActive` is true and restores the previous
 * `overflow` of `<body>` afterwards.
 *
 * @param {boolean} isActive - Whether the lock is on.
 */
function useBodyScrollLock(isActive) {
  useEffect(() => {
    if (!isActive) return undefined;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isActive]);
}

/**
 * Drawer — a modal panel that slides in from the right edge: details of a
 * catalog entry, the change history of a resource, an action's settings.
 *
 * Behaviour (WAI-ARIA dialog pattern):
 *   - `role="dialog"` with `aria-modal="true"`, named by its `title` heading
 *     and described by `description` when given;
 *   - focus moves into the panel on open (`initialFocusRef`, else the first
 *     focusable element, else the panel itself), Tab and Shift+Tab cycle
 *     inside it, and focus returns to the element that opened it on close;
 *     when the focused element disappears (a list replaced by a detail
 *     view), the next Tab brings focus back into the panel;
 *   - Escape and a click on the backdrop call `onClose` (each can be turned
 *     off). A dialog stacked on top of the drawer, such as a confirmation
 *     with its own `aria-modal`, keeps Escape and Tab to itself;
 *   - the page behind does not scroll while the drawer is open;
 *   - full width on phones, `size` from the `sm` breakpoint up.
 *
 * The drawer is rendered into `document.body` and stays mounted while closed
 * so it can slide out; closed, it is `inert`, hidden and off-screen. A parent
 * that mounts it only while open (`{item && <Drawer isOpen …>}`) still gets
 * the slide-in, through `@starting-style`.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the drawer is shown.
 * @param {() => void} props.onClose - Called on Escape, the close button and a backdrop click.
 * @param {React.ReactNode} props.title - Heading of the drawer; also its accessible name.
 * @param {React.ReactNode} [props.icon] - Decorative icon before the title.
 * @param {React.ReactNode} [props.description] - Short text under the title (`aria-describedby`).
 * @param {React.ReactNode} [props.subheader] - Fixed strip between the header and the
 *   scrolling body (context line, action bar).
 * @param {React.ReactNode} [props.footer] - Fixed strip under the body (actions).
 * @param {React.ReactNode} props.children - The scrolling body.
 * @param {'sm'|'md'|'lg'} [props.size='md'] - 384px, 480px or 672px wide from `sm` up.
 * @param {string} [props.closeLabel] - Accessible name of the close button
 *   (default: `common.close`).
 * @param {React.RefObject<HTMLElement>} [props.initialFocusRef] - Element to focus on open.
 * @param {boolean} [props.closeOnBackdropClick=true]
 * @param {boolean} [props.closeOnEscape=true]
 * @param {string} [props.bodyClassName] - Extra classes for the scrolling body.
 * @param {string} [props.data-testid] - Test id for the panel.
 * @returns {React.ReactPortal}
 *
 * @example
 * <Drawer
 *   isOpen={open}
 *   onClose={() => setOpen(false)}
 *   title={t('admin.changeHistory.title', 'Change History')}
 *   icon={<ClockIcon className="h-5 w-5 text-indigo-500" />}
 * >
 *   <SnapshotList />
 * </Drawer>
 */
function Drawer({
  isOpen,
  onClose,
  title,
  icon,
  description,
  subheader,
  footer,
  children,
  size = 'md',
  closeLabel,
  initialFocusRef,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  bodyClassName = '',
  'data-testid': testId
}) {
  const { t } = useTranslation();
  const panelRef = useRef(null);
  const baseId = useId();
  const titleId = `drawer-${baseId}-title`;
  const descriptionId = `drawer-${baseId}-description`;
  const open = Boolean(isOpen);

  useFocusTrap(panelRef, {
    isActive: open,
    initialFocusRef,
    returnFocusOnDeactivate: true
  });
  useBodyScrollLock(open);

  // Runs after the focus trap's activation: when it found nothing to focus,
  // focus the panel itself so the keyboard is inside the dialog.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = event => {
      const panel = panelRef.current;
      if (!panel || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // A dialog stacked on top of the drawer owns the keyboard.
      const modalOwner = target?.closest('[aria-modal="true"]');
      if (modalOwner && modalOwner !== panel) return;

      if (event.key === 'Escape') {
        if (!closeOnEscape) return;
        event.preventDefault();
        onClose?.();
        return;
      }

      // The trap inside useFocusTrap only sees Tab on its descendants. Focus on
      // the panel itself, or lost to <body> when its element was removed, is
      // brought back to the first (Tab) or last (Shift+Tab) element here.
      if (event.key === 'Tab' && (target === panel || !panel.contains(target))) {
        event.preventDefault();
        const focusable = getFocusableElements(panel);
        if (focusable.length === 0) {
          panel.focus();
        } else {
          focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, closeOnEscape]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      inert={!open}
      className={`fixed inset-0 z-50 ${
        open
          ? 'visible'
          : 'pointer-events-none invisible transition-[visibility] delay-300 duration-0 motion-reduce:delay-0'
      }`}
    >
      <div
        aria-hidden="true"
        className={`fixed inset-0 bg-black/30 transition-opacity duration-300 motion-reduce:transition-none ${
          open ? 'opacity-100 starting:opacity-0' : 'opacity-0'
        }`}
        onClick={closeOnBackdropClick ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-testid={testId}
        className={`fixed inset-y-0 right-0 flex w-full max-w-full ${WIDTHS[size] || WIDTHS.md} transform flex-col border-l border-gray-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out focus:outline-hidden motion-reduce:transition-none dark:border-gray-700 dark:bg-gray-900 ${
          open ? 'translate-x-0 starting:translate-x-full' : 'translate-x-full'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex min-w-0 items-center gap-2">
            {icon && (
              <span aria-hidden="true" className="flex shrink-0">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2
                id={titleId}
                className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="text-sm text-gray-500 dark:text-gray-400">
                  {description}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            aria-label={closeLabel || t('common.close', 'Close')}
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {subheader && <div className="shrink-0">{subheader}</div>}

        <div className={`flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>

        {footer && (
          <div className="shrink-0 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export default Drawer;
